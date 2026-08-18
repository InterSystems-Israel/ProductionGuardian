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
