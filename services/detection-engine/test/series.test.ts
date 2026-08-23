/**
 * Host series tests — the history behind the dashboard's three host graphs.
 *
 * THE LOAD-BEARING ONE IS THE NULL GAP, and it is the reason most of this file exists. `queued`
 * and `errored` are `number | null` where null means "not measurable for this host" (contract Q13),
 * and a graph that plots an unmeasurable poll at zero states a measurement nobody took. #33, #49
 * and #58 are the same defect three times, so it is asserted three ways here: the sample is absent
 * from the series, the surrounding samples survive, and the TIME GAP the client needs to break the
 * line on is actually visible in the timestamps.
 *
 * Per CLAUDE.md §8 the negative cases carry equal weight: an unknown host, a known host with no
 * samples for a metric, a single point, an all-flat run, and a span asked for beyond the window.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createFindingsServer } from '../src/api/server.ts';
import { DEFAULT_CONFIG, DEFAULT_POLL_INTERVAL_MS } from '../src/config/thresholds.ts';
import { DetectionEngine } from '../src/detect/engine.ts';
import { buildHostSeries, DEFAULT_SPAN_SECONDS, type HostSeries } from '../src/detect/series.ts';
import { BaselineStore } from '../src/baseline/window.ts';
import type { EngineSnapshot } from '../src/detect/engine.ts';
import type { ProxyHost, ProxyResponse } from '../src/types/proxy.ts';

const T0 = Date.parse('2026-08-23T12:00:00Z');
const POLL_MS = 5_000;

function proxyHost(overrides: Partial<ProxyHost> = {}): ProxyHost {
  return {
    host: 'Cloud API',
    type: 'operation',
    status: 'OK',
    isFramework: false,
    queued: 0,
    messages: 100,
    messagesPerSec: 0.6,
    errored: 0,
    avgProcessingTime: 0.05,
    avgQueueingTime: 0.02,
    lastActivity: null,
    lastActivityElapsedSeconds: 4,
    ...overrides,
  };
}

function response(hosts: ProxyHost[]): ProxyResponse {
  return {
    sampledAt: new Date(T0).toISOString(),
    production: 'LABDEMO.Production',
    hosts,
    alerts: [],
    warming: false,
    productionQueued: null,
  };
}

/** The engine's own accessor, at the shipped poll interval. */
function seriesFor(engine: DetectionEngine, host: string, now: number, span = DEFAULT_SPAN_SECONDS): HostSeries {
  return engine.hostSeries(host, span, DEFAULT_POLL_INTERVAL_MS, now);
}

function points(series: HostSeries, metric: string): { at: string; value: number }[] {
  return series.series.find((s) => s.metric === metric)?.points ?? [];
}

describe('the series is read from the rolling baseline, not measured again', () => {
  it('returns one point per poll, oldest first, for each of the three metrics', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 10; i += 1) {
      engine.applyPoll(response([proxyHost({ queued: i * 3 })]), at);
      at += POLL_MS;
    }

    const series = seriesFor(engine, 'Cloud API', at);
    assert.equal(series.known, true);
    assert.deepEqual(
      series.series.map((s) => s.metric),
      ['queued', 'avgProcessingTime', 'messagesPerSec'],
      'the three the panel graphs, in the order it draws them',
    );

    const queued = points(series, 'queued');
    assert.equal(queued.length, 10);
    assert.deepEqual(
      queued.map((p) => p.value),
      [0, 3, 6, 9, 12, 15, 18, 21, 24, 27],
      'values are the samples the poll recorded, in poll order',
    );
    // Oldest first is what a chart draws left to right; reversed would render time backwards.
    assert.ok(
      Date.parse(queued[0]!.at) < Date.parse(queued.at(-1)!.at),
      'oldest first',
    );
  });

  it('publishes units, so a consumer never has to guess seconds vs milliseconds', () => {
    // Contract Q6 had to be settled EMPIRICALLY for avgProcessingTime. A client deriving the unit
    // from the metric name is one guess away from rendering 0.05s as 50 seconds.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    engine.applyPoll(response([proxyHost()]), T0);
    const series = seriesFor(engine, 'Cloud API', T0 + POLL_MS);
    assert.deepEqual(
      series.series.map((s) => [s.metric, s.unit]),
      [['queued', 'count'], ['avgProcessingTime', 'seconds'], ['messagesPerSec', 'per_second']],
    );
  });

  it('publishes the poll interval, so a client can recognise a gap without hardcoding it', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    engine.applyPoll(response([proxyHost()]), T0);
    assert.equal(
      engine.hostSeries('Cloud API', DEFAULT_SPAN_SECONDS, 5000, T0).pollIntervalSeconds,
      5,
    );
  });

  it('tracks hosts independently — one host\'s series never carries another\'s samples', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 4; i += 1) {
      engine.applyPoll(
        response([
          proxyHost({ host: 'Cloud API', queued: 100 }),
          proxyHost({ host: 'Lab Router', queued: 1 }),
        ]),
        at,
      );
      at += POLL_MS;
    }
    assert.deepEqual(points(seriesFor(engine, 'Cloud API', at), 'queued').map((p) => p.value), [100, 100, 100, 100]);
    assert.deepEqual(points(seriesFor(engine, 'Lab Router', at), 'queued').map((p) => p.value), [1, 1, 1, 1]);
  });
});

describe('a null is a GAP, never a zero (contract Q13 — #33/#49/#58)', () => {
  /*
   * The whole point of the feature's correctness, so it is asserted from three angles.
   *
   * The mechanism is INHERITED rather than re-implemented: DetectionEngine.#recordIfMeasured skips
   * a null instead of recording it, so an unmeasurable poll leaves no sample at all. These tests
   * pin that the skip survives all the way to what a client reads — if someone later "fixes" the
   * skip by coercing to 0, the graph would silently start drawing a drained queue.
   */
  it('omits an unmeasurable sample entirely rather than recording 0', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    // measured, measured, UNMEASURABLE, measured, measured
    for (const queued of [40, 41, null, 43, 44]) {
      engine.applyPoll(response([proxyHost({ queued })]), at);
      at += POLL_MS;
    }

    const queued = points(seriesFor(engine, 'Cloud API', at), 'queued');
    assert.equal(queued.length, 4, 'four measured polls, not five');
    assert.deepEqual(
      queued.map((p) => p.value),
      [40, 41, 43, 44],
      'no 0 anywhere — a fabricated zero here is the #49 defect',
    );
    assert.ok(!queued.some((p) => p.value === 0), 'explicitly: no zero was invented');
  });

  it('leaves a TIME GAP a client can see, wider than one poll interval', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (const queued of [40, 41, null, null, 44]) {
      engine.applyPoll(response([proxyHost({ queued })]), at);
      at += POLL_MS;
    }

    const queued = points(seriesFor(engine, 'Cloud API', at), 'queued');
    assert.equal(queued.length, 3);
    // The gap is what the client breaks the line on: 41 at T0+5s, then 44 at T0+20s, i.e. 15s
    // across a 5s nominal interval. Asserting the DURATION rather than just the count, because the
    // count alone would still pass if timestamps were renumbered contiguously.
    const before = Date.parse(queued[1]!.at);
    const afterGap = Date.parse(queued[2]!.at);
    assert.equal((afterGap - before) / 1000, 15, 'two missed polls show as a 15s hole');
    assert.ok(
      (afterGap - before) / 1000 > seriesFor(engine, 'Cloud API', at).pollIntervalSeconds,
      'and it exceeds the published interval, which is how a client detects it',
    );
  });

  it('keeps a measured 0 as a real point — absent and zero are different facts', () => {
    // The mirror of the test above, and the one that stops an over-eager "drop the zeros" fix. A
    // drained queue IS zero and must plot at zero; only an unmeasured one may vanish.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (const queued of [5, 0, 0, 5]) {
      engine.applyPoll(response([proxyHost({ queued })]), at);
      at += POLL_MS;
    }
    assert.deepEqual(
      points(seriesFor(engine, 'Cloud API', at), 'queued').map((p) => p.value),
      [5, 0, 0, 5],
      'measured zeros are data',
    );
  });

  it('serves the other two metrics normally while one is unmeasurable', () => {
    // A per-METRIC gap, not a per-host one: the proxy can lose `queued` (it has, for the whole of
    // #12's life) while processing time keeps arriving. A panel that blanked all three graphs on
    // one absent metric would hide two working ones.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 4; i += 1) {
      engine.applyPoll(response([proxyHost({ queued: null, avgProcessingTime: 0.1 })]), at);
      at += POLL_MS;
    }
    const series = seriesFor(engine, 'Cloud API', at);
    assert.deepEqual(points(series, 'queued'), [], 'never measurable -> no points at all');
    assert.equal(points(series, 'avgProcessingTime').length, 4);
    assert.equal(points(series, 'messagesPerSec').length, 4);
  });
});

describe('negative cases (CLAUDE.md §8)', () => {
  it('an unknown host answers known: false with empty series, not an error', () => {
    // A misspelling, or a host that left the production between the render and the click. The
    // second is normal, so it must not raise -- the same instinct as "zero findings is 200 + []".
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    engine.applyPoll(response([proxyHost()]), T0);

    const series = seriesFor(engine, 'No Such Host', T0 + POLL_MS);
    assert.equal(series.known, false);
    assert.deepEqual(series.series.map((s) => s.points), [[], [], []]);
    // polledAt is non-null, which is what distinguishes "we have polled and this host is not in
    // the roster" from "the engine has not polled at all".
    assert.notEqual(series.polledAt, null);
  });

  it('a known host with no samples yet answers known: true and empty points', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    // Every metric unmeasurable: the host is in the roster, and nothing has been recorded for it.
    engine.applyPoll(
      response([
        proxyHost({ queued: null, messagesPerSec: null, avgProcessingTime: null, avgQueueingTime: null }),
      ]),
      T0,
    );
    const series = seriesFor(engine, 'Cloud API', T0 + POLL_MS);
    assert.equal(series.known, true, 'the host exists');
    assert.deepEqual(series.series.map((s) => s.points.length), [0, 0, 0], 'and has no history');
  });

  it('before the first poll, polledAt is null — "warming", not "nothing to measure"', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    const series = seriesFor(engine, 'Cloud API', T0);
    assert.equal(series.polledAt, null);
    assert.equal(series.known, false);
  });

  it('a single sample is served as one point, not refused and not padded', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    engine.applyPoll(response([proxyHost({ queued: 7 })]), T0);
    assert.deepEqual(
      points(seriesFor(engine, 'Cloud API', T0 + POLL_MS), 'queued').map((p) => p.value),
      [7],
      'one point is honest; inventing a second to make a line is not',
    );
  });

  it('an all-identical run is served flat, with no synthetic variation', () => {
    // The client must not divide by a zero range when it scales this. Pinned here because the
    // engine's half of that contract is simply "serve the real values".
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 6; i += 1) {
      engine.applyPoll(response([proxyHost({ queued: 12 })]), at);
      at += POLL_MS;
    }
    const values = points(seriesFor(engine, 'Cloud API', at), 'queued').map((p) => p.value);
    assert.deepEqual(values, [12, 12, 12, 12, 12, 12]);
  });

  it('a host that leaves the production loses its series, like its findings', () => {
    // #forget is already called on departure so stale findings cannot linger. The series must go
    // with it, or a departed host would keep serving history under a name nothing reports.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 4; i += 1) {
      engine.applyPoll(response([proxyHost({ host: 'Cloud API' }), proxyHost({ host: 'Lab Router' })]), at);
      at += POLL_MS;
    }
    assert.equal(points(seriesFor(engine, 'Lab Router', at), 'queued').length, 4);

    engine.applyPoll(response([proxyHost({ host: 'Cloud API' })]), at);
    const gone = seriesFor(engine, 'Lab Router', at + POLL_MS);
    assert.equal(gone.known, false);
    assert.deepEqual(gone.series.map((s) => s.points), [[], [], []]);
  });
});

describe('span clamping', () => {
  it('clamps a span above the baseline window to the window', () => {
    // Asking for more than the store retains would advertise history that does not exist.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    engine.applyPoll(response([proxyHost()]), T0);
    const series = engine.hostSeries('Cloud API', 999_999, DEFAULT_POLL_INTERVAL_MS, T0);
    assert.equal(series.spanSeconds, DEFAULT_CONFIG.baselineWindowSeconds);
  });

  it('clamps a tiny span up to the minimum, and reports what it served', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    engine.applyPoll(response([proxyHost()]), T0);
    const series = engine.hostSeries('Cloud API', 1, DEFAULT_POLL_INTERVAL_MS, T0);
    assert.equal(series.spanSeconds, 60, 'a two-point line is a graph in shape only');
  });

  it('excludes samples older than the span', () => {
    // The span is a filter over the window, not the window itself -- so a 60s span over 10 minutes
    // of history returns only the last 60s.
    const store = new BaselineStore(1800, 12);
    for (let i = 0; i < 100; i += 1) store.record('Cloud API', 'queued', i, T0 + i * POLL_MS);
    const now = T0 + 99 * POLL_MS;
    const series = buildHostSeries({
      host: 'Cloud API',
      known: true,
      baselines: store,
      spanSeconds: 60,
      windowSeconds: 1800,
      pollIntervalMs: POLL_MS,
      now,
      lastPollAt: now,
    });
    const queued = series.series.find((s) => s.metric === 'queued')?.points ?? [];
    // 60s at a 5s poll is 13 samples inclusive of both ends.
    assert.equal(queued.length, 13);
    assert.equal(queued.at(-1)?.value, 99, 'the newest sample is always included');
  });
});

describe('the series is a READ — it cannot change what detection sees', () => {
  it('leaves the baseline sample count untouched', () => {
    // A read endpoint that mutated the store could change which rules fire. Asserted rather than
    // reasoned about, because `recent()` returning a copy is the only thing preventing it.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 15; i += 1) {
      engine.applyPoll(response([proxyHost({ queued: 3 })]), at);
      at += POLL_MS;
    }
    const before = engine.snapshot();
    for (let i = 0; i < 5; i += 1) seriesFor(engine, 'Cloud API', at);
    const after = engine.snapshot();
    assert.deepEqual(after.hosts, before.hosts);
    assert.deepEqual(after.findings, before.findings);
    assert.equal(after.state, before.state);
  });
});

describe('GET /api/hostseries', () => {
  let snapshot: EngineSnapshot = {
    hosts: [],
    findings: [],
    projections: [],
    state: 'ok',
    lastPollAt: null,
  };
  const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
  const server = createFindingsServer({
    port: 0,
    snapshot: () => snapshot,
    log: () => {},
    hostSeries: (host, span) =>
      engine.hostSeries(host, span ?? DEFAULT_SPAN_SECONDS, DEFAULT_POLL_INTERVAL_MS, T0 + 20 * POLL_MS),
  });
  let base = '';

  before(async () => {
    let at = T0;
    for (let i = 0; i < 8; i += 1) {
      engine.applyPoll(response([proxyHost({ queued: i })]), at);
      at += POLL_MS;
    }
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves a known host at 200 with three series', async () => {
    const res = await fetch(`${base}/api/hostseries?host=${encodeURIComponent('Cloud API')}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as HostSeries;
    assert.equal(body.host, 'Cloud API');
    assert.equal(body.known, true);
    assert.equal(body.series.length, 3);
    assert.equal(body.series[0]?.points.length, 8);
  });

  it('a host name with a space survives the query string', async () => {
    // Host names legitimately contain spaces ("Cloud API", "Lab Router"), and a `+`-vs-`%20`
    // mistake here would 200 with an empty series -- a wrong answer that looks like no history.
    const res = await fetch(`${base}/api/hostseries?host=Cloud+API`);
    const body = (await res.json()) as HostSeries;
    assert.equal(body.known, true, '+ must decode to a space, like %20');
  });

  it('an unknown host is 200 + known:false, NEVER 404', async () => {
    const res = await fetch(`${base}/api/hostseries?host=Nope`);
    assert.equal(res.status, 200, 'a 404 would read as "this endpoint does not exist"');
    const body = (await res.json()) as HostSeries;
    assert.equal(body.known, false);
  });

  it('a missing host parameter is 400 — there is no host it could mean', async () => {
    const res = await fetch(`${base}/api/hostseries`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /host is required/);
  });

  it('an empty host parameter is also 400', async () => {
    const res = await fetch(`${base}/api/hostseries?host=%20`);
    assert.equal(res.status, 400);
  });

  it('honours an explicit span', async () => {
    const res = await fetch(`${base}/api/hostseries?host=Cloud+API&span=120`);
    const body = (await res.json()) as HostSeries;
    assert.equal(body.spanSeconds, 120);
  });

  it('treats a nonsense span as absent rather than refusing', async () => {
    // The parameter is a display convenience and clamping bounds it anyway, so a bad value falls
    // back to the default. Refusing would turn a URL typo into a broken panel.
    for (const span of ['abc', '-5', '0']) {
      const res = await fetch(`${base}/api/hostseries?host=Cloud+API&span=${span}`);
      assert.equal(res.status, 200, `span=${span}`);
      assert.equal((await res.json() as HostSeries).spanSeconds, DEFAULT_SPAN_SECONDS);
    }
  });

  it('sends CORS and the state header, like every other GET', async () => {
    const res = await fetch(`${base}/api/hostseries?host=Cloud+API`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-healthscan-state'), 'ok');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('405s a POST to it, rather than 404 — the endpoint is real, the method is not', async () => {
    // The symmetric 405/404 handling the server comment argues for. A 404 here would tell a caller
    // the endpoint does not exist, which is false.
    const res = await fetch(`${base}/api/hostseries?host=Cloud+API`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 405);
    assert.match(((await res.json()) as { error: string }).error, /not allowed/);
  });

  it('serves an empty series rather than erroring when the engine is wired without it', async () => {
    // An engine build predating this endpoint. The client's "no data" branch renders, which it must
    // handle anyway for a warming engine -- not a banner over a missing graph.
    const bare = createFindingsServer({ port: 0, snapshot: () => snapshot, log: () => {} });
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    const bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const res = await fetch(`${bareBase}/api/hostseries?host=Cloud+API`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as HostSeries;
    assert.equal(body.known, false);
    assert.deepEqual(body.series, []);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it('serialises a gap as missing points, end to end through HTTP', async () => {
    // The null-gap property surviving JSON, not just the in-process call. A `null` leaking into the
    // array would be the shape a client plots at zero.
    const gapEngine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (const queued of [10, 11, null, null, 14]) {
      gapEngine.applyPoll(response([proxyHost({ queued })]), at);
      at += POLL_MS;
    }
    const gapServer = createFindingsServer({
      port: 0,
      snapshot: () => snapshot,
      log: () => {},
      hostSeries: (host, span) =>
        gapEngine.hostSeries(host, span ?? DEFAULT_SPAN_SECONDS, DEFAULT_POLL_INTERVAL_MS, at),
    });
    await new Promise<void>((resolve) => gapServer.listen(0, resolve));
    const gapBase = `http://127.0.0.1:${(gapServer.address() as AddressInfo).port}`;
    const raw = await (await fetch(`${gapBase}/api/hostseries?host=Cloud+API`)).text();
    assert.ok(!raw.includes('null,'), `no null slipped into the points array: ${raw}`);
    const body = JSON.parse(raw) as HostSeries;
    const queued = body.series.find((s) => s.metric === 'queued')?.points ?? [];
    assert.deepEqual(queued.map((p) => p.value), [10, 11, 14]);
    await new Promise<void>((resolve) => gapServer.close(() => resolve()));
  });
});
