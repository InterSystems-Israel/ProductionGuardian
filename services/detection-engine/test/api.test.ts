/**
 * API tests — §3 of contracts/healthscan-api.md, asserted against a real listening server.
 *
 * The load-bearing one is "zero findings returns 200 + [], never 404". Dev C's error
 * handling depends on it, and it is the kind of thing a framework default would get wrong.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createFindingsServer } from '../src/api/server.ts';
import type { EngineSnapshot } from '../src/detect/engine.ts';
import type { HostProjection } from '../src/detect/earlywarning.ts';
import type { Finding, Host } from '../src/types/healthscan.ts';

const HOST: Host = {
  host: 'Lab Router',
  type: 'process',
  status: 'OK',
  queued: 0,
  messagesPerSec: 1.2,
  errored: 0,
  avgProcessingTime: 0.08,
  avgQueueingTime: 0,
  lastActivity: '2026-08-06T15:47:52Z',
};

const FINDING: Finding = {
  id: 'f-1042',
  host: 'Lab Router',
  type: 'queue_buildup',
  severity: 'warning',
  currentValue: 486,
  baselineValue: 15,
  detectedAt: '2026-08-06T15:44:08Z',
  message: 'Queue depth 486 is 32x baseline',
};

let snapshot: EngineSnapshot = { hosts: [], findings: [], projections: [], state: 'ok', lastPollAt: null };
const server = createFindingsServer({ port: 0, snapshot: () => snapshot, log: () => {} });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('empty states (contract §3)', () => {
  it('returns 200 and [] for zero findings, NOT 404', async () => {
    snapshot = { hosts: [], findings: [], projections: [], state: 'ok', lastPollAt: Date.now() };
    const res = await fetch(`${base}/api/healthscan/findings`);
    assert.equal(res.status, 200, 'a 404 here would break Dev C error handling');
    assert.deepEqual(await res.json(), []);
  });

  it('returns 200 and [] for zero hosts', async () => {
    snapshot = { hosts: [], findings: [], projections: [], state: 'warming', lastPollAt: null };
    const res = await fetch(`${base}/api/healthscan/hosts`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

describe('payloads', () => {
  it('serves hosts verbatim', async () => {
    snapshot = { hosts: [HOST], findings: [], projections: [], state: 'ok', lastPollAt: Date.now() };
    const res = await fetch(`${base}/api/healthscan/hosts`);
    assert.deepEqual(await res.json(), [HOST]);
  });

  it('serves findings verbatim', async () => {
    snapshot = { hosts: [HOST], findings: [FINDING], projections: [], state: 'ok', lastPollAt: Date.now() };
    const res = await fetch(`${base}/api/healthscan/findings`);
    assert.deepEqual(await res.json(), [FINDING]);
  });

  it('preserves baselineValue null through serialization', async () => {
    const warming: Finding = { ...FINDING, baselineValue: null };
    snapshot = { hosts: [], findings: [warming], projections: [], state: 'warming', lastPollAt: Date.now() };
    const body = (await (await fetch(`${base}/api/healthscan/findings`)).json()) as Finding[];
    assert.equal(body[0]?.baselineValue, null, 'must stay null, not become 0 or undefined');
  });
});

describe('headers', () => {
  it('sends CORS unconditionally (contract Q9)', async () => {
    snapshot = { hosts: [], findings: [], projections: [], state: 'ok', lastPollAt: Date.now() };
    const res = await fetch(`${base}/api/healthscan/hosts`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('reports the engine state', async () => {
    for (const state of ['ok', 'warming', 'stale'] as const) {
      snapshot = { hosts: [], findings: [], projections: [], state, lastPollAt: Date.now() };
      const res = await fetch(`${base}/api/healthscan/findings`);
      assert.equal(res.headers.get('x-healthscan-state'), state);
    }
  });

  it('forbids caching, so polling always sees fresh data', async () => {
    const res = await fetch(`${base}/api/healthscan/findings`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('answers preflight', async () => {
    const res = await fetch(`${base}/api/healthscan/findings`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('preflight permits a cross-origin JSON POST (MVP 2)', async () => {
    // The MVP 2 endpoints are POSTs with `Content-Type: application/json`, which is NOT a
    // CORS-simple request -- so a browser preflights it, and a reply missing either POST or
    // Allow-Headers fails the preflight. Every existing GET keeps working regardless, because
    // those ARE simple and are never preflighted.
    //
    // That asymmetry is why this test exists: the symptom of getting it wrong is a dashboard
    // that renders live data perfectly and silently cannot submit an approval, with nothing in
    // the engine log because the request never arrives. Not observable from any GET, so no
    // existing test would have caught it.
    const res = await fetch(`${base}/api/healthscan/findings`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);

    const methods = res.headers.get('access-control-allow-methods') ?? '';
    assert.ok(methods.includes('POST'), `Allow-Methods must advertise POST, got "${methods}"`);

    const headers = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    assert.ok(
      headers.includes('content-type'),
      `Allow-Headers must permit content-type or a JSON POST cannot be sent, got "${headers}"`,
    );
  });

  it('a real POST route with no handler answers 503, not 404 or 405', async () => {
    // SUPERSEDES an earlier version of this test that asserted 405, from when POST was advertised
    // in Allow-Methods before any POST route existed. /api/resolve is now a real route, so 405
    // would be wrong -- and this suite caught the change rather than passing through it.
    //
    // 503 rather than 404 is the deliberate part: "this deployment has no agent wired" and "no
    // such endpoint" are different facts. A dashboard seeing 404 concludes the feature does not
    // exist and stops asking; 503 says try a deployment that has it.
    const res = await fetch(`${base}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dry_run' }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('POST /api/chat with no handler answers 503, which is the demo-mode state', async () => {
    // NOT AN EDGE CASE FOR THIS ENDPOINT -- it is the shipped behaviour with AGENT_MODE=mock, because
    // there is deliberately no canned chat agent (see detect/chat.ts). So 503 here is what the
    // dashboard meets on every deployment without a live LLM, and the panel renders it as
    // "not configured" rather than as a fault. A 404 would tell it the feature does not exist.
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'which host is busiest?' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not configured on this deployment/);
  });

  it('an unknown POST path still answers 404', async () => {
    // The distinction above is only meaningful if a genuinely unknown path behaves differently.
    const res = await fetch(`${base}/api/nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });
});

describe('routing', () => {
  it('tolerates a trailing slash', async () => {
    snapshot = { hosts: [HOST], findings: [], projections: [], state: 'ok', lastPollAt: Date.now() };
    const res = await fetch(`${base}/api/healthscan/hosts/`);
    assert.equal(res.status, 200);
  });

  it('ignores query strings', async () => {
    const res = await fetch(`${base}/api/healthscan/hosts?mode=live`);
    assert.equal(res.status, 200);
  });

  it('404s an unknown endpoint', async () => {
    const res = await fetch(`${base}/api/healthscan/nope`);
    assert.equal(res.status, 404);
  });

  it('405s a non-GET method', async () => {
    const res = await fetch(`${base}/api/healthscan/findings`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('405s a GET to a POST-only route, in BOTH directions', async () => {
    // The mirror of the test above, and it was missing -- which is how `GET /api/resolve` answered
    // 404 for a real endpoint. Same defect as the POST-to-a-GET-route regression, in the other
    // direction, and no test covered it because the suite only ever asked one way round.
    //
    // Asserted for both POST routes, not just one: the two are wired through different branches
    // (investigate builds a handler, resolve passes one through), so covering one proves nothing
    // about the other.
    // `/api/chat` is in the list because it is wired through a THIRD branch (a passed-through
    // handler that this test server leaves undefined), and the comment above is explicit that
    // covering one branch proves nothing about another.
    for (const path of ['/api/resolve', '/api/investigate', '/api/chat']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 405, `GET ${path} should be 405`);
      const body = (await res.json()) as { error: string };
      // The message must name the METHOD as the problem. "no such endpoint" would send a reader
      // looking for a missing route that is in fact present.
      assert.match(body.error, /method GET not allowed/);
    }
  });

  it('still 404s a GET to a path that is neither', async () => {
    // The 405 above is only meaningful if a genuinely absent path is distinguishable.
    const res = await fetch(`${base}/api/investigation`);
    assert.equal(res.status, 404);
  });
});

describe('faults', () => {
  it('500s with a JSON error when the snapshot throws', async () => {
    const failing = createFindingsServer({
      port: 0,
      snapshot: () => {
        throw new Error('baseline exploded');
      },
      log: () => {},
    });
    await new Promise<void>((resolve) => failing.listen(0, resolve));
    const { port } = failing.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/healthscan/findings`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'baseline exploded' });

    await new Promise<void>((resolve) => failing.close(() => resolve()));
  });
});

describe('write-origin allow-list (resolve-api.md §13.2)', () => {
  it('a foreign origin cannot POST, and is told so with 403', async () => {
    // The confused deputy, closed. Verified against the running stack before the fix that
    // `Origin: https://evil.example.com` got HTTP 200 and a real preview -- because the engine
    // holds a credential with the write role while the browser does not, and `*` let any page ask
    // it to act. §13.2 names this and ranks the options.
    const res = await fetch(`${base}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ mode: 'dry_run', action: { type: 'set_pool_size', host: 'Cloud API', size: 8 } }),
    });
    // 403 is correct HERE and wrong for a policy refusal (§5.1). The difference is who is asking:
    // a refused operator needs an informative 200 they can render; a page that should not have
    // asked has no UI to show it, and there is nothing legitimate to render.
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not permitted to POST/);
  });

  it('the preflight AGREES with the POST branch rather than promising and refusing', async () => {
    // If the preflight advertised POST to an origin the POST branch then rejects, the browser
    // would pass the preflight and fail the real request -- surfacing as a bare 403 with no clue
    // which check refused it.
    const denied = await fetch(`${base}/api/resolve`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    const deniedMethods = denied.headers.get('access-control-allow-methods') ?? '';
    assert.ok(!deniedMethods.includes('POST'), `must not advertise POST, got "${deniedMethods}"`);
    assert.ok(deniedMethods.includes('GET'), 'reads stay available');

    const allowed = await fetch(`${base}/api/resolve`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    assert.ok((allowed.headers.get('access-control-allow-methods') ?? '').includes('POST'));
  });

  it('the dashboard origin still works, both loopback forms', async () => {
    // Dev C runs Vite directly on localhost:5173 and the compose stack serves the built bundle
    // from nginx on the same port. Breaking either would be worse than the hole this closes.
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const res = await fetch(`${base}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ mode: 'dry_run', action: { type: 'set_pool_size', host: 'Cloud API', size: 4 } }),
      });
      // 503 because this test server wires no resolve handler -- the point is that it got PAST the
      // origin check, which a 403 would not have.
      assert.notEqual(res.status, 403, `${origin} must be allowed to POST`);
    }
  });

  it('a request with NO Origin is allowed — it is not a browser', async () => {
    // Deliberate, and the distinction that makes this fix meaningful rather than theatre. Browsers
    // always send Origin on a cross-origin POST, so a request without one is curl, the dev proxy,
    // or a health check. Rejecting those breaks every scripted verification while stopping nothing:
    // anything that can omit the header can forge it. This closes the drive-by, not the network
    // path -- the real fix is §13.1's pass-through credential.
    const res = await fetch(`${base}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dry_run', action: { type: 'set_pool_size', host: 'Cloud API', size: 4 } }),
    });
    assert.notEqual(res.status, 403);
  });

  it('GETs are unaffected — Q9 keeps its unconditional CORS', async () => {
    // Q9's reasoning (the dev proxy stays optional) applies to reads. Narrowing them would break
    // the dashboard for no security gain, since a read is not the confused-deputy risk.
    const res = await fetch(`${base}/api/healthscan/findings`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

/*
 * §1.4 IS ENFORCED BY THE ROUTE, NOT ONLY BY THE MAPPER (#187).
 *
 * `publishedProjection()` is unit-tested in `earlywarning.test.ts`; this asserts the endpoint actually
 * calls it. The two are different claims — the route served `snapshot.projections` raw for the whole of
 * MVP 2, so a mapper that works and a mapper that is reached would have looked identical from there.
 *
 * The projection below is a literal on purpose: it carries `windowSlopePerMinute` set, so a route that
 * forgot the whitelist publishes a bare slope beside a withheld forecast and this fails.
 */
describe('/api/earlywarning publishes no bare slope (earlywarning-api.md §1.4)', () => {
  const PROJECTION: HostProjection = {
    host: 'Cloud API',
    metric: 'queued',
    currentValue: 90,
    measuredAt: '2026-08-31T10:00:00Z',
    fitSampleCount: 50,
    fitSpanSeconds: 245,
    recentDirection: 'falling',
    threshold: { value: 50, basis: 'absoluteFloor', baselineValue: 0, findingType: 'queue_buildup' },
    projection: null,
    projectionUnavailable: 'already_crossed',
    windowSlopePerMinute: 26.6,
  };

  it('strips windowSlopePerMinute from the wire payload', async () => {
    snapshot = { hosts: [], findings: [], projections: [PROJECTION], state: 'ok', lastPollAt: Date.now() };
    const res = await fetch(`${base}/api/earlywarning`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row !== undefined);
    assert.ok(!('windowSlopePerMinute' in row), 'a slope must not reach the panel');
    // Nothing else may go missing with it: §1 makes an absent KEY a violation even where the value
    // would be null, so the count is asserted rather than a sampling of fields.
    assert.equal(Object.keys(row).length, 10);
    assert.equal(row.projectionUnavailable, 'already_crossed');
    assert.equal(row.recentDirection, 'falling');
  });
});
