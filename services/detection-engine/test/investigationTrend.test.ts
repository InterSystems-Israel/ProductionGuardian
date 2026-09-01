/**
 * `trend` on the agent request — contract §2.2, and specifically the slope (#187).
 *
 * WHAT MAKES THIS WORTH ITS OWN FILE. §2.2 argues for carrying a *signed* slope to the agent on the
 * grounds that "a queue that is draining is a fact the agent should see rather than a forecast to
 * withhold" — the one place in either MVP 2 contract where a bare rate is deliberately allowed,
 * because the consumer is a model rather than a panel. It was never delivered: `slope` was read from
 * `projection.projection`, which Early Warning sets to null for `already_crossed`, which is the state
 * every `queue_buildup` investigation is requested in. So the field was null on every investigation
 * the product has ever served, and the agent recommended enlarging a pool for a queue falling
 * 261 -> 181 because nothing in its input said "falling".
 *
 * THE TESTS ASSERT THE REQUEST, NOT THE RESPONSE. Nothing in the served payload changes, so a test
 * that exercised `investigate()` end to end would pass against the defect. The spy captures what
 * `callAgent` was handed, which is the only place the fix is visible from here.
 *
 * Projections come from `projectHost` on a recorded series rather than being hand-written, so these
 * are the numbers the engine really passes — a literal would test the mapper against itself.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BaselineStore } from '../src/baseline/window.ts';
import { DEFAULT_CONFIG, type ThresholdConfig } from '../src/config/thresholds.ts';
import { projectHost, type HostProjection } from '../src/detect/earlywarning.ts';
import { investigate } from '../src/detect/investigate.ts';
import type { RawHostMetrics } from '../src/detect/rules/types.ts';
import type { Finding, Host } from '../src/types/healthscan.ts';

const HOST_NAME = 'Cloud API';
const T0 = Date.parse('2026-08-31T10:00:00Z');
const POLL = 5000;

const HOST: Host = {
  host: HOST_NAME,
  type: 'operation',
  status: 'OK',
  queued: 90,
  messagesPerSec: 4,
  errored: 0,
  avgProcessingTime: 1.01,
  avgQueueingTime: 12,
  lastActivity: '2026-08-31T10:00:00Z',
};

const FINDING: Finding = {
  id: 'f-3001',
  host: HOST_NAME,
  type: 'queue_buildup',
  severity: 'critical',
  currentValue: 90,
  baselineValue: 0,
  detectedAt: '2026-08-31T10:00:00Z',
  message: 'Queue depth 90 is over the floor of 50',
};

/** The shipped MVP 2 setup: a stated reference baseline of 0 for `queued`. */
function config(overrides: Partial<ThresholdConfig> = {}): ThresholdConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    referenceBaselines: { [HOST_NAME]: { queued: 0 } },
    ...overrides,
  };
}

function raw(queued: number | null): RawHostMetrics {
  return {
    queued,
    messagesPerSec: 4,
    errored: 0,
    avgProcessingTime: 1.01,
    avgQueueingTime: 12,
    lastActivityElapsedSeconds: 1,
  } as RawHostMetrics;
}

/** Record a series at the shipped poll and project at its last sample. */
function project(values: readonly number[], cfg = config()): HostProjection {
  const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
  let at = T0;
  for (const v of values) {
    store.record(HOST_NAME, 'queued', v, at);
    at += POLL;
  }
  return projectHost(HOST_NAME, raw(values.at(-1) ?? 0), store, cfg, at - POLL);
}

/** Rise to just under `peak` in steps of 5, then drain by 3 a poll — an approved fix taking effect. */
function riseThenDrain(peak: number, drainSamples: number): number[] {
  const values: number[] = [];
  for (let v = 0; v < peak; v += 5) values.push(v);
  let v = peak;
  for (let i = 0; i < drainSamples; i += 1) {
    v -= 3;
    values.push(v);
  }
  return values;
}

/** Run one investigation and return the request the agent was handed. */
async function requestFor(projection: HostProjection | undefined) {
  let captured: { trend: Record<string, unknown> | null; snapshot: Record<string, unknown> } | undefined;
  await investigate(FINDING, HOST, projection, null, {
    callAgent: async (request) => {
      captured = request;
      return {
        rootCause: 'Cloud API cannot keep up with inbound volume.',
        evidence: [],
        confidence: 0.8,
        recommendedAction: null,
        manualRemediation: null,
      };
    },
    source: 'canned' as const,
    now: () => 1_760_000_000_000,
  });
  assert.ok(captured !== undefined, 'the agent was never called');
  return captured;
}

test('the slope reaches the agent for a crossed queue — the state every investigation runs in', async () => {
  const p = project(riseThenDrain(150, 20));
  assert.equal(p.projectionUnavailable, 'already_crossed', 'sanity: the investigated state');
  assert.equal(p.projection, null, 'sanity: Early Warning withholds the forecast here');

  const { trend } = await requestFor(p);
  assert.ok(trend !== null, 'trend was null — the #187 defect');
  assert.equal(trend.slope, p.windowSlopePerMinute);
  assert.ok(typeof trend.slope === 'number' && trend.slope !== 0);
  assert.equal(trend.slopeUnit, 'items/minute');
  assert.equal(trend.thresholdCrossed, true);
  // §2.2 drops the forecast framing rather than the fields: crossed with no ETA is the normal case.
  assert.equal(trend.secondsToThreshold, null);
});

test('a negative slope reaches it too — §2.2s draining fact', async () => {
  /* The measurement that produced #187: a pool enlargement drains the queue while it stays over the
     floor, so the reason is still `already_crossed` and the model saw nothing that said "falling". */
  const values = [150];
  for (let i = 0; i < 30; i += 1) values.push(150 - (i + 1) * 3);
  const p = project(values);
  assert.equal(p.projectionUnavailable, 'already_crossed');

  const { trend } = await requestFor(p);
  assert.ok(trend !== null);
  assert.equal(trend.slope, -36, 'a drain of 3 per 5s poll is -36/min');
  assert.equal(trend.recentDirection, 'falling');
});

test('slope and recentDirection are allowed to disagree, and that is why both are sent', async () => {
  /* Measured, not supposed: an eight-minute climb followed by 100 seconds of draining fits a window
     slope of +26.6/min with a falling tail. One number cannot carry both, and "it built up but is
     recovering" is the distinction that decides whether a second pool increase is warranted. */
  const p = project(riseThenDrain(150, 20));
  const { trend } = await requestFor(p);
  assert.ok(trend !== null);
  assert.equal(trend.slope, 26.6);
  assert.equal(trend.recentDirection, 'falling');
});

test('trend is null when the fit has too few samples — §2.2s stated null case', async () => {
  /* "No usable fit at all — a warming baseline, or fewer than 12 samples in the fit window." The gate
     was `&&`, which only ever passed because `slope` was unconditionally null; it served a trend
     object whose only real content was a threshold the snapshot already carries. */
  const p = project([0, 1, 2, 3, 5]);
  assert.equal(p.projectionUnavailable, 'insufficient_samples');
  assert.equal(p.windowSlopePerMinute, null);

  const { trend } = await requestFor(p);
  assert.equal(trend, null);
});

test('trend is null while the baseline is warming — the other half of the disjunction', async () => {
  /* A fit exists and a threshold does not. Reachable only with a baseline requirement above
     `minFitSamples`, which is why it is configured here rather than left to the shipped numbers where
     the two are both 12 and the cases coincide. */
  const cfg = config({ referenceBaselines: {}, minBaselineSamples: 40 });
  const p = project(
    Array.from({ length: 20 }, (_, i) => i * 3),
    cfg,
  );
  assert.equal(p.projectionUnavailable, 'warming');
  assert.equal(p.threshold, null);
  assert.ok(p.windowSlopePerMinute !== null, 'sanity: the fit itself succeeded');

  const { trend } = await requestFor(p);
  assert.equal(trend, null, 'a slope with no threshold to compare it to is not a trend');
});

test('trend is null when Early Warning produced no projection for the host at all', async () => {
  const { trend } = await requestFor(undefined);
  assert.equal(trend, null);
});

/*
 * `snapshot.inboundRatePerSec` and `trend.recentSlope` — §2.2, as amended 2026-09-01 (#188).
 *
 * `inboundRatePerSec` was ratified and never implemented, which left pool sizing computed from
 * `messagesPerSec`. That field counts COMPLETIONS, so on the one finding MVP 2 exists to fix it
 * measures the throttle rather than the load: a host clearing ~1/sec under ~2.9/sec of arrivals
 * reports ~1, and `workersToKeepUp = rate x perMsg` then returns the break-even pool that holds the
 * queue steady instead of draining it.
 *
 * THE AMENDMENT IS WHICH SLOPE. §2.2 said `messagesPerSec + trend.slope/60`, and measuring both live
 * scenarios — which #188 required — showed the window slope is the wrong span. Two minutes into a
 * drain it still leans up, so it pushed the estimate ABOVE the raw completion rate on the one state
 * where completions are already an overstatement. The tail fit is the "now" the definition needs, and
 * its magnitude is published as `trend.recentSlope` so the model can show the arithmetic it is asked
 * for.
 *
 * The fixture below is that transient: window +26.6/min, tail -25.6/min. Opposite signs from the same
 * series, which is why one number cannot serve both this field and the ETA.
 */

test('inboundRatePerSec is completions plus the CURRENT growth rate, not the window fit', async () => {
  const p = project(riseThenDrain(150, 20));
  const { snapshot, trend } = await requestFor(p);
  assert.equal(trend?.slope, 26.6, 'sanity: the window fit still leans up');
  assert.equal(trend?.recentSlope, -25.6, 'sanity: the tail is falling');

  // 4/sec cleared with the backlog shrinking 25.6/min = 3.57/sec arriving. Via `slope` this would be
  // 4.44 -- above the completion rate, on a queue that is emptying. That was measured recommending
  // `4 -> 8` live, so it is the case the amendment exists for.
  assert.equal(snapshot.inboundRatePerSec, 3.57);
  assert.ok(
    (snapshot.inboundRatePerSec as number) < (snapshot.messagesPerSec as number),
    'a draining queue must put arrivals BELOW throughput',
  );
  assert.equal(snapshot.messagesPerSec, 4, 'the measured field is unchanged beside it');
});

test('on a queue that is still rising it is ABOVE throughput', async () => {
  /* The flagship direction, and the reason the field exists at all: the host is behind, so what is
     arriving exceeds what it clears. Both spans agree here, which is why the case does not
     distinguish the two slopes and the test above is the one that does. */
  const p = project(Array.from({ length: 40 }, (_, i) => i * 5));
  const { snapshot, trend } = await requestFor(p);
  assert.equal(trend?.recentSlope, 60);
  assert.equal(snapshot.inboundRatePerSec, 5);
  assert.ok((snapshot.inboundRatePerSec as number) > (snapshot.messagesPerSec as number));
});

test('a steady drain agrees with the window, and both put inbound below throughput', async () => {
  const values = [150];
  for (let i = 0; i < 30; i += 1) values.push(150 - (i + 1) * 3);
  const p = project(values);
  const { snapshot, trend } = await requestFor(p);
  assert.equal(trend?.slope, -36);
  assert.equal(trend?.recentSlope, -36, 'no rise left in the window, so the two coincide');
  assert.equal(snapshot.inboundRatePerSec, 3.4);
});

test('it is clamped at zero rather than reporting a negative arrival rate', async () => {
  /* The two terms are measured over different spans, so a drain steeper than the counted completions
     can put the sum below zero. "Negative messages arriving" is not a reading a model should be given
     -- and null would claim there was no fit, which is false. A queue collapsing 60 per poll is well
     past anything the live scenario produces; the guard is for the arithmetic, not the scenario. */
  const values = [900];
  for (let i = 0; i < 14; i += 1) values.push(900 - (i + 1) * 60);
  const p = project(values);
  const { snapshot, trend } = await requestFor(p);
  assert.ok((trend?.recentSlope as number) < -240, 'sanity: steeper than 4/sec of completions');
  assert.equal(snapshot.inboundRatePerSec, 0);
});

test('inboundRatePerSec is null whenever trend is null — never a messagesPerSec fallback', async () => {
  /* §2.2 is explicit that it is null when either term is unavailable, "including whenever `trend` is
     null", and that it must NOT fall back to `messagesPerSec`. A fallback would not read as missing:
     it would assert inflow equals throughput, which is the one thing a `queue_buildup` finding says
     is false, and the consumer is a model that cannot tell a default from a measurement. */
  for (const projection of [undefined, project([0, 1, 2, 3, 5])]) {
    const { snapshot, trend } = await requestFor(projection);
    assert.equal(trend, null, 'sanity: the null-trend case');
    assert.equal(snapshot.inboundRatePerSec, null);
    assert.notEqual(snapshot.inboundRatePerSec, snapshot.messagesPerSec);
  }
});

test('the key is present even when the value is null — an absent field is a contract violation', async () => {
  const { snapshot } = await requestFor(undefined);
  assert.ok('inboundRatePerSec' in snapshot);
});

test('a poll gap that empties the tail declines the whole trend, not three of its four fields', async () => {
  /* THE TWO FITS SHARE A SAMPLE-COUNT GATE BUT NOT AN OUTCOME, which is the third arm of buildTrend's
     gate (#188). Twelve samples inside the 300s window and a 200s gap before the last one leaves ONE
     sample inside the 120s tail, so the tail fit declines and `recentDirection` — its sign — declines
     with it. Reachable in operation rather than only on paper: the engine records nothing while the
     proxy is unreachable, and one sample arrives on recovery.

     Serving `trend` here would hand the agent a window slope beside two nulls and a null
     `inboundRatePerSec`, which is the two-meanings object the `||` in that gate exists to refuse, and
     would break §2.2's promise that `recentSlope` is non-null whenever `trend` is. */
  const cfg = config();
  const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
  let at = T0;
  for (let i = 0; i < cfg.earlyWarning.minFitSamples; i += 1) {
    store.record(HOST_NAME, 'queued', i * 5, at);
    at += POLL;
  }
  at += 200_000; // the gap: no polls landed, so no samples were recorded
  store.record(HOST_NAME, 'queued', 100, at);
  const p = projectHost(HOST_NAME, raw(100), store, cfg, at);

  assert.equal(p.fitSampleCount, cfg.earlyWarning.minFitSamples + 1, 'sanity: the window still fits');
  assert.ok(p.windowSlopePerMinute !== null, 'sanity: the window fit survives the gap');
  assert.equal(p.recentSlopePerMinute, null, 'one sample in the tail is not a fit');
  assert.equal(p.recentDirection, null, 'the sign goes with the magnitude');

  const { snapshot, trend } = await requestFor(p);
  assert.equal(trend, null);
  assert.equal(snapshot.inboundRatePerSec, null);
});
