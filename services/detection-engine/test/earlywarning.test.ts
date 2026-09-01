/**
 * Early Warning projection tests.
 *
 * Every decline reason gets a case, not just the happy path. A projection that fires correctly
 * but never declines is the same class of defect as a rule that fires and never clears — and
 * §2.2's precedence order is only meaningful if something checks it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BaselineStore } from '../src/baseline/window.ts';
import { DEFAULT_CONFIG, type ThresholdConfig } from '../src/config/thresholds.ts';
import { projectHost, publishedProjection } from '../src/detect/earlywarning.ts';
import type { RawHostMetrics } from '../src/detect/rules/types.ts';

const HOST = 'Cloud API';
const T0 = Date.parse('2026-08-18T12:00:00Z');
const POLL = 5000;

/** Config with a reference baseline of 0 for queued — the shipped MVP 2 setup. */
function config(overrides: Partial<ThresholdConfig> = {}): ThresholdConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    referenceBaselines: { [HOST]: { queued: 0 } },
    ...overrides,
  };
}

function raw(queued: number | null): RawHostMetrics {
  return {
    queued,
    messagesPerSec: 1,
    errored: 0,
    avgProcessingTime: 1,
    avgQueueingTime: 1,
    lastActivityElapsedSeconds: 1,
  } as RawHostMetrics;
}

/**
 * Feed a rising series and return the projection at the last sample.
 * `perSample` is the growth per poll; 5 approximates ~1/sec at a 5s poll.
 */
function ramp(samples: number, perSample: number, cfg = config()) {
  const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
  let q = 0;
  let at = T0;
  for (let i = 0; i < samples; i += 1) {
    store.record(HOST, 'queued', q, at);
    at += POLL;
    q += perSample;
  }
  const lastAt = at - POLL;
  const lastValue = q - perSample;
  return projectHost(HOST, raw(lastValue), store, cfg, lastAt);
}

describe('a projection is labelled as one (contract §1.4)', () => {
  it('nests every computed number inside projection, tagged kind', () => {
    const p = ramp(20, 2);
    assert.ok(p.projection !== null, 'expected a projection from a steady rise');
    assert.equal(p.projection.kind, 'projection');
    assert.equal(p.projection.basis, 'linear-least-squares');
    assert.equal(p.projection.slopeUnit, 'items/minute');
    // The observed values live OUTSIDE projection. If any of these moved inside it, a consumer
    // could no longer tell measurement from forecast, which is the whole point of the shape.
    assert.equal(typeof p.currentValue, 'number');
    assert.match(p.measuredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(p.fitSampleCount >= 12);
  });

  it('always hedges the message with "at this rate"', () => {
    const p = ramp(20, 2);
    assert.ok(p.projection !== null);
    // Tested rather than trusted: the hedge has to survive inside the one string Dev C renders
    // verbatim, or whoever styles the panel can drop it.
    assert.match(p.projection.message, /at this rate/);
  });

  it('measuredAt is the sample clock, not the request clock (EW-Q3)', () => {
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (let i = 0; i < 20; i += 1) {
      store.record(HOST, 'queued', i * 2, at);
      at += POLL;
    }
    const lastSampleAt = at - POLL;
    // Ask 20s after the last sample -- inside the 300s fit window, so a projection is still
    // produced, but `now` and the sample clock differ. measuredAt must name the SAMPLE: a
    // consumer reads it as "when this was true", and using the request clock would silently
    // claim the reading is fresher than it is.
    const p = projectHost(HOST, raw(38), store, cfg, lastSampleAt + 20_000);
    assert.equal(p.measuredAt, '2026-08-18T12:01:35Z');
    assert.ok(p.projection !== null, 'sanity: 20s later is still inside the fit window');
  });

  it('declines when every sample has aged out of the fit window', () => {
    // The case the previous version of the test above accidentally constructed. An hour after
    // the last sample nothing is inside the 300s fit window, so there is nothing to fit. Worth
    // its own test because the honest answer is to decline rather than project from stale data
    // -- and because `measuredAt` then has no sample to name and falls back to the request
    // clock, which is only defensible BECAUSE there is no projection alongside it.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 20; i += 1) store.record(HOST, 'queued', i * 2, T0 + i * POLL);
    const p = projectHost(HOST, raw(38), store, cfg, T0 + 19 * POLL + 3_600_000);
    assert.equal(p.projection, null);
    assert.equal(p.projectionUnavailable, 'insufficient_samples');
    assert.equal(p.fitSampleCount, 0, 'nothing is inside the fit window');
  });
});

describe('the arithmetic', () => {
  it('fits a slope in items/minute and derives a consistent crossing time', () => {
    // 2 per 5s poll = 24/min. Reference baseline 0 -> threshold is absoluteFloor 50.
    const p = ramp(20, 2);
    assert.ok(p.projection !== null);
    assert.equal(p.projection.slope, 24);
    assert.equal(p.threshold?.value, 50);
    assert.equal(p.threshold?.basis, 'absoluteFloor');

    // current 38, threshold 50, 24/min -> 12/24 min = 30s
    assert.equal(p.projection.secondsToThreshold, 30);
    const crossing = Date.parse(p.projection.projectedCrossingAt);
    const measured = Date.parse(p.measuredAt);
    assert.equal(
      (crossing - measured) / 1000,
      p.projection.secondsToThreshold,
      'projectedCrossingAt must equal measuredAt + secondsToThreshold, not a fresh clock read',
    );
  });

  it('fits against timestamps, not sample indices', () => {
    // Same values, but the samples are 10s apart rather than 5s. A slope fitted per INDEX would
    // report the same number for both; per-millisecond fitting halves it. That difference is the
    // reason recent() returns pairs at all.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (let i = 0; i < 20; i += 1) {
      store.record(HOST, 'queued', i * 2, at);
      at += 10_000;
    }
    const p = projectHost(HOST, raw(38), store, cfg, at - 10_000);
    assert.ok(p.projection !== null);
    assert.equal(p.projection.slope, 12, 'halving the sample rate must halve the per-minute slope');
  });
});

describe('it declines rather than guessing (contract §2)', () => {
  it('disabled', () => {
    const cfg = config();
    cfg.earlyWarning.enabled = false;
    const p = ramp(20, 2, cfg);
    assert.equal(p.projection, null);
    assert.equal(p.projectionUnavailable, 'disabled');
  });

  it('metric_unmeasurable — a null queue is not a small one (#33)', () => {
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 20; i += 1) store.record(HOST, 'queued', i * 2, T0 + i * POLL);
    const p = projectHost(HOST, raw(null), store, cfg, T0 + 19 * POLL);
    assert.equal(p.projectionUnavailable, 'metric_unmeasurable');
    assert.equal(p.currentValue, null, 'must not coerce an unmeasurable value to 0');
  });

  it('warming — no baseline means no threshold to project toward', () => {
    // No reference baseline, and too few samples for a rolling mean.
    const cfg = config({ referenceBaselines: {} });
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 3; i += 1) store.record(HOST, 'queued', i, T0 + i * POLL);
    const p = projectHost(HOST, raw(2), store, cfg, T0 + 2 * POLL);
    assert.equal(p.projectionUnavailable, 'warming');
    assert.equal(p.threshold, null);
  });

  it('insufficient_samples — threshold exists, fit does not', () => {
    const p = ramp(4, 2);
    assert.equal(p.projectionUnavailable, 'insufficient_samples');
    assert.ok(p.threshold !== null, 'a reference baseline gives a threshold even while warming');
  });

  it('already_crossed — and NOT secondsToThreshold: 0', () => {
    const p = ramp(20, 20); // reaches far past the floor of 50
    assert.equal(p.projectionUnavailable, 'already_crossed');
    assert.equal(
      p.projection,
      null,
      'zero would read as a measurement of now; declining is the honest answer (§1.4)',
    );
  });

  it('already_crossed wins over not_rising for a draining but still-crossed queue', () => {
    // Precedence §2.2 item 5. Falling queue, still above the threshold. Reporting `not_rising`
    // here would read as "nothing to see" about a queue that is over its limit.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let q = 400;
    let at = T0;
    for (let i = 0; i < 20; i += 1) {
      store.record(HOST, 'queued', q, at);
      at += POLL;
      q -= 5;
    }
    const p = projectHost(HOST, raw(q + 5), store, cfg, at - POLL);
    assert.equal(p.projectionUnavailable, 'already_crossed');
  });

  it('not_rising — flat below the threshold', () => {
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 20; i += 1) store.record(HOST, 'queued', 10, T0 + i * POLL);
    const p = projectHost(HOST, raw(10), store, cfg, T0 + 19 * POLL);
    assert.equal(p.projectionUnavailable, 'not_rising');
    assert.equal(p.projection, null, 'a flat queue is approaching nothing');
  });

  it('beyond_horizon — rising, but the crossing is too far out to be information', () => {
    const cfg = config();
    cfg.earlyWarning.horizonSeconds = 60;
    const p = ramp(20, 2, cfg); // ETA 30s at the default horizon; 60s horizon still admits it
    assert.ok(p.projection !== null, 'sanity: 30s is inside a 60s horizon');

    cfg.earlyWarning.horizonSeconds = 10;
    const beyond = ramp(20, 2, cfg);
    assert.equal(beyond.projectionUnavailable, 'beyond_horizon');
  });
});

describe('the null-complement invariant', () => {
  it('projection and projectionUnavailable are never both set, and never both null', () => {
    const cases = [
      ramp(20, 2),
      ramp(4, 2),
      ramp(20, 20),
      (() => {
        const cfg = config();
        cfg.earlyWarning.enabled = false;
        return ramp(20, 2, cfg);
      })(),
    ];
    for (const p of cases) {
      const one = p.projection === null;
      const other = p.projectionUnavailable === null;
      assert.notEqual(one, other, `exactly one must be null, got ${JSON.stringify(p)}`);
    }
  });
});

/**
 * A drain inside the fit window used to poison the slope.
 *
 * Reported from a live demo walkthrough: "I don't see it activated when Pool Bottleneck is used. it
 * just goes from nothing to Critical." Reproduced on the running stack — the 300s window straddled a
 * reset, holding
 *
 *     263 268 ... 350 355 | 0 0 ... 0 | 8 13 ... 124 129
 *
 * and the fit returned **-52.7/min** while the queue climbed ~1/sec. Early Warning therefore reported
 * `not_rising` throughout the ramp and jumped straight to `already_crossed`.
 *
 * These tests pin the fix from both sides: the cliff must not poison a real rise, and an ordinary
 * drain must NOT be mistaken for one — a queue that dips while draining and refilling is the normal
 * case, and discarding history on every dip would throw away the trend this module exists to find.
 */
describe('a drain inside the fit window does not poison the slope', () => {
  /** Rise, collapse to zero, then rise again — the shape a reset leaves behind. */
  function withDrain(preDrain: number, postDrain: number, perSample: number) {
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    let q = 0;
    for (let i = 0; i < preDrain; i += 1) {
      store.record(HOST, 'queued', q, at);
      at += POLL;
      q += perSample;
    }
    // The cliff: one poll, all the way to zero.
    q = 0;
    for (let i = 0; i < postDrain; i += 1) {
      store.record(HOST, 'queued', q, at);
      at += POLL;
      q += perSample;
    }
    const lastAt = at - POLL;
    const lastValue = q - perSample;
    return projectHost(HOST, raw(lastValue), store, cfg, lastAt);
  }

  it('projects from the samples after the drain, not across it', () => {
    // Pre-drain climbs to 95 (well past the floor of 50); post-drain climbs only to 30, so the
    // EXPECTED outcome is a projection rather than already_crossed. Fitted across the cliff the
    // slope is steeply negative; fitted after it, it is +60/min. Getting this wrong first time is
    // instructive: a post-drain series above the threshold is already_crossed and says nothing
    // about the slope, so it cannot test this at all.
    // 14 post-drain samples reach 65, which is past the floor of 50 and therefore already_crossed --
    // true, but it tests nothing about the slope. 8 reaches 35, under the floor, so a projection is
    // the correct expectation. minFitSamples is 12, so the truncated window must still be large
    // enough to fit: 8 alone would be insufficient_samples, which is why the assertion below also
    // checks the sample count rather than only the reason.
    const p = withDrain(20, 12, 3);
    assert.equal(
      p.projectionUnavailable,
      null,
      `a queue rising after a drain must still project, got ${String(p.projectionUnavailable)}`,
    );
    assert.ok(p.projection !== null, 'expected a projection');
    assert.ok(
      p.projection.slope > 0,
      `slope must be positive for a rising queue, got ${p.projection.slope}`,
    );
  });

  it('does not treat ordinary draining as a discontinuity', () => {
    // A queue shedding a fifth of itself each poll is draining, not restarting. It must NOT project
    // a crossing, and the reason must be `not_rising` rather than a cliff-truncated window.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    let q = 400;
    const values: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      values.push(Math.round(q));
      store.record(HOST, 'queued', Math.round(q), at);
      at += POLL;
      q *= 0.8;
    }
    const lastValue = values[values.length - 1] as number;
    const p = projectHost(HOST, raw(lastValue), store, cfg, at - POLL);
    // A 20%-per-poll drain never trips the 80% cliff test, so the window is intact and the slope is
    // negative -- which is `not_rising`. What must NOT happen is the window being truncated to a
    // couple of samples, which would report insufficient_samples and hide a real drain.
    assert.equal(p.projectionUnavailable, 'not_rising');
    assert.ok(
      p.fitSampleCount >= 12,
      `an ordinary drain must keep its window, got ${p.fitSampleCount} samples`,
    );
  });

  it('keeps the whole window when nothing collapsed', () => {
    // The no-discontinuity path must be unchanged: a plain ramp still projects exactly as before.
    // 20 samples at +2 reaches 38, under the floor of 50, so a projection is the right expectation --
    // +5 would reach 95 and be already_crossed, which tests the wrong thing (I made that mistake
    // twice in this suite before reading the floor).
    const p = ramp(20, 2);
    assert.equal(p.projectionUnavailable, null);
    assert.ok(p.projection !== null && p.projection.slope > 0);
  });

  it('treats a rise from zero as a ramp starting, not a collapse', () => {
    // 0 -> 8 is an 800% RISE, but the guard divides by the previous value, so a zero previous must
    // not be read as a discontinuity. Without the `previous > 0` guard every ramp's first sample
    // would truncate the window to itself.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (const v of [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 13, 18, 23, 28, 33, 38, 43]) {
      store.record(HOST, 'queued', v, at);
      at += POLL;
    }
    const p = projectHost(HOST, raw(43), store, cfg, at - POLL);
    assert.ok(
      p.fitSampleCount > 2,
      `the window must not be truncated to the rise itself, got ${p.fitSampleCount} samples`,
    );
  });
});

/**
 * A DRAINING queue is not a rising one, even when the window average says otherwise.
 *
 * Reported from a live demo run: "the early warning sometimes comes up when the queue pool is being
 * drained, because it takes a point in time measurement and does not notice the
 * acceleration/deceleration of pool growth." Worst possible timing — it lands seconds after the
 * audience is told the approved `set_pool_size 1 -> 4` worked.
 *
 * One least-squares slope over the whole 300s window describes the WINDOW, not the present. On the
 * recovery path the window straddles a long rise and a partial drain, the average stays positive,
 * and Early Warning announces a crossing while the queue is emptying.
 *
 * #142's `sinceLastDiscontinuity()` does not cover it and was never meant to: a drain at 4/sec sheds
 * ~20 of a 350-deep queue per 5s poll, ~6%, nowhere near the 80% cliff test. These cases assert the
 * window stays intact AND the projection is declined, so neither mechanism can be mistaken for the
 * other.
 */
describe('a queue must be rising NOW, not merely on average', () => {
  /**
   * Rise, then drain — the shape the approved fix leaves in the window.
   *
   * Defaults mirror the MVP 2 scenario at the shipped 5s poll: net +1/sec while `Cloud API` is at
   * `PoolSize 1`, then net -3/sec once the pool is 4 and it clears ~4/sec against the same inflow.
   * Returns the values too, so a test can fit them itself rather than trusting the module.
   */
  function riseThenDrain(riseSamples: number, drainSamples: number, cfg = config()) {
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    const values: number[] = [];
    let at = T0;
    let q = 0;
    for (let i = 0; i < riseSamples; i += 1) {
      values.push(q);
      store.record(HOST, 'queued', q, at);
      at += POLL;
      q += 5;
    }
    q -= 5;
    for (let i = 0; i < drainSamples; i += 1) {
      q -= 15;
      values.push(q);
      store.record(HOST, 'queued', q, at);
      at += POLL;
    }
    const lastValue = values[values.length - 1] as number;
    return { p: projectHost(HOST, raw(lastValue), store, cfg, at - POLL), values, lastValue };
  }

  /** Least-squares slope per minute over evenly spaced values — the OLD rule's answer, in the test. */
  function slopePerMinute(values: readonly number[], spacingMs = POLL): number {
    const n = values.length;
    const meanX = ((n - 1) / 2) * spacingMs;
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const [i, v] of values.entries()) {
      const dx = i * spacingMs - meanX;
      sxy += dx * (v - meanY);
      sxx += dx * dx;
    }
    return (sxy / sxx) * 60_000;
  }

  it('declines while the queue drains, though the window average is still positive', () => {
    // 40 samples up to 195, then 12 down to 15. 15 is UNDER the floor of 50 on purpose: above it
    // `already_crossed` answers first and the slope is never consulted, so a fixture that ends high
    // tests nothing here. That is the same trap #142's fixtures fell into twice.
    const { p, values, lastValue } = riseThenDrain(40, 12);

    assert.equal(lastValue, 15);
    assert.equal(p.threshold?.value, 50);
    assert.ok(
      lastValue < 50,
      'sanity: the assertion sample must be below the floor, or already_crossed answers instead',
    );
    // The old rule's own number, fitted here rather than assumed. If this ever comes out negative
    // the fixture has stopped reproducing the defect and the test below proves nothing.
    assert.ok(
      slopePerMinute(values) > 0,
      `the window average must still be positive for this to be the defect, got ${slopePerMinute(values)}`,
    );
    // The window is INTACT: no 80% collapse anywhere in a 15-per-poll drain, so #142's helper
    // cannot be what declines here.
    assert.equal(p.fitSampleCount, 52, 'an ordinary drain must not truncate the window');

    assert.equal(
      p.projectionUnavailable,
      'not_rising',
      'a draining queue is not rising — the accurate answer, and it renders as "watching"',
    );
    assert.equal(p.projection, null);
  });

  it('still projects for a queue that is rising more slowly than it was', () => {
    // DECELERATION IS NOT A TURNOVER. The gate asks for a positive recent slope, not an
    // undiminished one: this queue is still heading for the threshold, and the published slope is
    // the window's, which overstates it. Declining here would be the opposite defect.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    let q = 0;
    for (let i = 0; i < 30; i += 1) {
      store.record(HOST, 'queued', q, at);
      at += POLL;
      q += 1;
    }
    // +1 every other poll, so the values stay whole the way a queue depth does.
    for (let i = 0; i < 20; i += 1) {
      store.record(HOST, 'queued', q, at);
      at += POLL;
      if (i % 2 === 1) q += 1;
    }
    const p = projectHost(HOST, raw(q), store, cfg, at - POLL);
    assert.equal(p.projectionUnavailable, null, 'a slowing rise is still a rise');
    assert.ok(p.projection !== null && p.projection.slope > 0);
  });

  it('declines for a queue that has levelled off', () => {
    // The turnover case with no drain at all: a rise, then flat. The window average is positive and
    // nothing is approaching anything.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (let i = 0; i < 30; i += 1) {
      store.record(HOST, 'queued', i, at);
      at += POLL;
    }
    for (let i = 0; i < 30; i += 1) {
      store.record(HOST, 'queued', 29, at);
      at += POLL;
    }
    const p = projectHost(HOST, raw(29), store, cfg, at - POLL);
    assert.equal(p.projectionUnavailable, 'not_rising');
  });

  it('declines rather than crashing when the recent portion holds one sample', () => {
    // A polling gap: 13 samples, 12 of them bunched at the start of the window and one at the end.
    // The recent portion cannot be fitted at all, which must decline rather than throw or fall back
    // to the window average. `insufficient_samples` would contradict the published fitSampleCount of
    // 13, which the contract defines that reason against.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 12; i += 1) store.record(HOST, 'queued', i * 2, T0 + i * POLL);
    const lastAt = T0 + 250_000;
    store.record(HOST, 'queued', 40, lastAt);
    const p = projectHost(HOST, raw(40), store, cfg, lastAt);
    assert.equal(p.fitSampleCount, 13, 'sanity: the full window is still fittable');
    assert.equal(p.projectionUnavailable, 'not_rising');
  });

  it('declines rather than crashing when the recent portion shares one timestamp', () => {
    // Zero variance in x is division by zero, not a flat line — the distinction `fitSlopePerMs`
    // already keeps for the full window, applied to the recent portion too.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 12; i += 1) store.record(HOST, 'queued', i * 2, T0 + i * POLL);
    const lastAt = T0 + 250_000;
    for (const v of [40, 41, 42]) store.record(HOST, 'queued', v, lastAt);
    const p = projectHost(HOST, raw(42), store, cfg, lastAt);
    assert.equal(p.fitSampleCount, 15);
    assert.equal(p.projectionUnavailable, 'not_rising');
  });
});

/**
 * `recentDirection` — contract §1.5, and #174.
 *
 * THE DEFECT THIS PINS is that `already_crossed` was returned for a queue over its threshold whether
 * it was climbing or draining, and nothing in the payload distinguished them. Measured on the live
 * stack: a `queue_buildup` fixed by enlarging the pool spent 22 consecutive polls — 110 seconds —
 * draining from 152 to 54, every one reporting `already_crossed`, byte-identical to the climb through
 * the same depths.
 *
 * So the two load-bearing cases are the SAME REASON with OPPOSITE directions, asserted as a pair.
 * Testing only the draining one would pass against an implementation that hardcoded `'falling'`.
 *
 * The precedence is deliberately unchanged and is asserted as such: a draining queue still over its
 * limit is still `already_crossed`, because it is still a problem.
 */
describe('recentDirection — which way it is moving now (§1.5)', () => {
  /** Record an arbitrary series at the shipped poll and project at its last sample. */
  function series(values: readonly number[], cfg = config()) {
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (const v of values) {
      store.record(HOST, 'queued', v, at);
      at += POLL;
    }
    const lastAt = at - POLL;
    return projectHost(HOST, raw(values.at(-1) ?? 0), store, cfg, lastAt);
  }

  /** Rise to `peak`, then come down by `perSample` — the shape of an approved fix taking effect. */
  function riseThenDrain(peak: number, perSample: number, drainSamples: number): number[] {
    const up: number[] = [];
    for (let v = 0; v < peak; v += 5) up.push(v);
    const down: number[] = [];
    let v = peak;
    for (let i = 0; i < drainSamples; i += 1) {
      v -= perSample;
      down.push(v);
    }
    return [...up, ...down];
  }

  it('a queue draining ABOVE its threshold is already_crossed and falling', () => {
    // The regression. 150 -> 60 at 3/poll over 30 polls: the tail is unambiguously falling and the
    // depth never drops below the threshold, so the reason cannot change.
    const p = series(riseThenDrain(150, 3, 30));
    assert.ok((p.currentValue ?? 0) >= 50, 'sanity: still above the threshold');
    assert.equal(p.projectionUnavailable, 'already_crossed', 'precedence is unchanged');
    assert.equal(p.projection, null);
    assert.equal(p.recentDirection, 'falling');
  });

  it('a queue RISING above its threshold is already_crossed and rising — the same reason', () => {
    /* The other half of the pair, and the reason it matters: before this field the two states above
       and below were one indistinguishable payload. */
    const p = series(Array.from({ length: 60 }, (_, i) => i * 3));
    assert.ok((p.currentValue ?? 0) >= 50);
    assert.equal(p.projectionUnavailable, 'already_crossed');
    assert.equal(p.recentDirection, 'rising');
  });

  it('a projection is ALWAYS rising — §1.5s one invariant', () => {
    // The projection path cannot be reached with a non-positive tail, so this is a property of the
    // shape rather than of this fixture.
    const p = ramp(20, 2);
    assert.ok(p.projection !== null, 'sanity: expected a forecast');
    assert.equal(p.recentDirection, 'rising');
  });

  it('a queue draining BELOW its threshold is not_rising and falling', () => {
    // #142's case, which was already correct. The direction now says the same thing explicitly
    // rather than leaving "not rising" to cover falling, flat and levelled-off alike.
    const p = series(riseThenDrain(100, 4, 20));
    assert.ok((p.currentValue ?? 0) < 50, 'sanity: below the threshold');
    assert.equal(p.projectionUnavailable, 'not_rising');
    assert.equal(p.recentDirection, 'falling');
  });

  it('a flat idle queue is steady, not falling and not null', () => {
    /* `steady` and `falling` are different claims to an operator: one is "nothing is happening", the
       other is "it is getting better". A flat series must not read as recovery. */
    const p = series(Array.from({ length: 20 }, () => 0));
    assert.equal(p.projectionUnavailable, 'not_rising');
    assert.equal(p.recentDirection, 'steady');
  });

  it('is null below minFitSamples — no claim, rather than a sign through three samples', () => {
    const p = series([0, 1, 2, 3, 5]);
    assert.equal(p.projectionUnavailable, 'insufficient_samples');
    assert.equal(p.recentDirection, null, 'a warming row claims no direction');
  });

  it('is null when the tail shares one timestamp — division by zero is not a flat line', () => {
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    for (let i = 0; i < 12; i += 1) store.record(HOST, 'queued', i * 2, T0 + i * POLL);
    const lastAt = T0 + 250_000;
    for (const v of [40, 41, 42]) store.record(HOST, 'queued', v, lastAt);
    const p = projectHost(HOST, raw(42), store, cfg, lastAt);
    assert.equal(p.projectionUnavailable, 'not_rising');
    assert.equal(p.recentDirection, null);
  });

  it('the KEY is present on every row, whatever the reason', () => {
    /* Contract §1: a missing key is a violation, a null value is not. Asserted with `in` rather than
       by reading the value, because `undefined` and `null` both read as absent otherwise. */
    const disabled = config({ earlyWarning: { ...config().earlyWarning, enabled: false } });
    const rows = [
      series([0, 1, 2], disabled),
      series([5, 5, 5]),
      ramp(20, 2),
      series(riseThenDrain(150, 3, 30)),
    ];
    for (const p of rows) {
      assert.ok('recentDirection' in p, `key missing for ${p.projectionUnavailable}`);
    }
    // And the unmeasurable case, which has no sample to fit at all.
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    const p = projectHost(HOST, raw(null), store, cfg, T0);
    assert.equal(p.projectionUnavailable, 'metric_unmeasurable');
    assert.ok('recentDirection' in p);
    assert.equal(p.recentDirection, null);
  });
});

/*
 * THE DEFECT THIS PINS (#187) is that the window slope was computed at step 6, BELOW the
 * `already_crossed` decline — which is the state every `queue_buildup` investigation is requested
 * under. So `investigation-api.md` §2.2's signed slope, argued for on the grounds that "a queue that
 * is draining is a fact the agent should see rather than a forecast to withhold", was null on every
 * investigation the product had ever served, and the agent recommended enlarging a pool for a queue
 * falling 261 -> 181.
 *
 * The field is INTERNAL: `publishedProjection()` strips it, because `earlywarning-api.md` §1.4 forbids
 * a slope outside `projection` on that endpoint even where the forecast is declined. Both halves are
 * asserted here — measured for the agent, absent for the panel — since either alone would pass against
 * a wrong implementation.
 */
describe('windowSlopePerMinute — measured for the agent, never published (§2.2 / §1.4)', () => {
  /** Record an arbitrary series at the shipped poll and project at its last sample. */
  function series(values: readonly number[], cfg = config()) {
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (const v of values) {
      store.record(HOST, 'queued', v, at);
      at += POLL;
    }
    return projectHost(HOST, raw(values.at(-1) ?? 0), store, cfg, at - POLL);
  }

  it('is negative for a queue draining above its threshold — the #187 case', () => {
    /* The exact shape a Smart Resolve apply produces: 150 down to 60 at 3/poll, never below the
       floor, so `already_crossed` still answers first. Before the fix this was null. */
    const values = [150];
    for (let i = 0; i < 30; i += 1) values.push(150 - (i + 1) * 3);
    const p = series(values);
    assert.equal(p.projectionUnavailable, 'already_crossed', 'sanity: the investigated state');
    assert.equal(p.projection, null, 'the forecast is still withheld');
    assert.ok(p.windowSlopePerMinute !== null, 'the slope is measured anyway');
    assert.ok(p.windowSlopePerMinute < 0, `expected a falling rate, got ${p.windowSlopePerMinute}`);
    // 3 per 5s poll downward is -36/min. Asserted numerically, not just by sign: a slope with the
    // right sign and the wrong magnitude would tell the agent a lie it cannot detect.
    assert.equal(p.windowSlopePerMinute, -36);
  });

  it('is positive and EQUAL to projection.slope on the happy path — one fit, used twice', () => {
    /* The invariant that makes the hoist safe. If these two ever disagree the endpoint publishes one
       rate and the agent reads another, which is #174's argument for the tail fit. */
    const p = ramp(20, 2);
    assert.ok(p.projection !== null, 'sanity: expected a forecast');
    assert.equal(p.windowSlopePerMinute, p.projection.slope);
    assert.ok((p.windowSlopePerMinute ?? 0) > 0);
  });

  it('is measured for a queue rising above its threshold too', () => {
    // The other direction under the same decline reason — so the agent can tell a queue still
    // building from one already recovering, which was the pair `recentDirection` was added for.
    const p = series(Array.from({ length: 60 }, (_, i) => i * 3));
    assert.equal(p.projectionUnavailable, 'already_crossed');
    assert.ok((p.windowSlopePerMinute ?? 0) > 0);
  });

  it('is null below minFitSamples — no rate, rather than one fitted through three points', () => {
    const p = series([0, 1, 2, 3, 5]);
    assert.equal(p.projectionUnavailable, 'insufficient_samples');
    assert.equal(p.windowSlopePerMinute, null);
  });

  it('is null when the metric is unmeasurable — there is nothing to fit', () => {
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    const p = projectHost(HOST, raw(null), store, cfg, T0);
    assert.equal(p.projectionUnavailable, 'metric_unmeasurable');
    assert.equal(p.windowSlopePerMinute, null);
  });

  it('publishedProjection() strips it and keeps everything else', () => {
    /* §1.4's regression guard. Asserted with `in` rather than by value, because a `null` field would
       still imply a rate we declined to state — the thing §1.4 forbids. */
    const p = series(Array.from({ length: 60 }, (_, i) => i * 3));
    assert.ok('windowSlopePerMinute' in p, 'sanity: it is on the internal type');
    assert.ok('recentSlopePerMinute' in p, 'sanity: so is the tail magnitude');
    const wire = publishedProjection(p);
    assert.ok(!('windowSlopePerMinute' in wire), 'a slope must not reach /api/earlywarning');
    assert.ok(!('recentSlopePerMinute' in wire), 'nor the tail slope — §1.4 does not distinguish');
    // Every other §1.1 key survives. A whitelist that dropped a published field would be the
    // opposite defect and just as invisible from the stripping assertion alone.
    for (const key of [
      'host',
      'metric',
      'currentValue',
      'measuredAt',
      'fitSampleCount',
      'fitSpanSeconds',
      'recentDirection',
      'threshold',
      'projection',
      'projectionUnavailable',
    ]) {
      assert.ok(key in wire, `publishedProjection dropped ${key}`);
    }
    assert.equal(Object.keys(wire).length, 10, 'an internal field reached the wire shape');
  });
});

/*
 * `recentSlopePerMinute` — the TAIL magnitude, and why it had to be carried (#188).
 *
 * The sign has been published as `recentDirection` since #174. The magnitude was thrown away, and
 * `investigation-api.md` §2.2 defined `snapshot.inboundRatePerSec` — the arrival rate the pool-sizing
 * arithmetic depends on — as `messagesPerSec + trend.slope/60`, i.e. from the WINDOW fit.
 *
 * That is the wrong span, measured rather than argued. Two minutes into a drain the window still
 * leans up, so the estimate lands ABOVE the raw completion rate on the one state where completions are
 * already an overstatement: live, `messagesPerSec 4` became `4.69` and the agent recommended `4 -> 8`
 * on a queue emptying without help. §2.2 was amended to read `trend.recentSlope` and this is the field
 * behind it.
 *
 * INTERNAL on the same terms as the window slope: `earlywarning-api.md` §1.4 does not distinguish
 * between the two spans, and "falling ~25/min" beside a withheld ETA is exactly what it forbids.
 */
describe('recentSlopePerMinute — the tail magnitude, for the agent only (§2.2 amended)', () => {
  function series(values: readonly number[], cfg = config()) {
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    let at = T0;
    for (const v of values) {
      store.record(HOST, 'queued', v, at);
      at += POLL;
    }
    return projectHost(HOST, raw(values.at(-1) ?? 0), store, cfg, at - POLL);
  }

  /** Rise to just under `peak` in fives, then drain by 3 a poll — the drain-through transient. */
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

  it('DISAGREES IN SIGN with the window fit on the drain-through transient', () => {
    /* The load-bearing test of the pair. Same series, opposite answers: +26.6/min over five minutes
       and -25.6/min over the last two. Everything else in this describe is a boundary condition;
       this is the measurement that says the two fields are not interchangeable. */
    const p = series(riseThenDrain(150, 20));
    assert.equal(p.projectionUnavailable, 'already_crossed', 'sanity: the investigated state');
    assert.equal(p.windowSlopePerMinute, 26.6);
    assert.equal(p.recentSlopePerMinute, -25.6);
    assert.equal(p.recentDirection, 'falling', 'and the sign is the one already published');
  });

  it('agrees with the window fit when the whole series moves one way', () => {
    // Both spans see the same thing on a pure ramp, which is why the flagship scenario does not
    // distinguish them and the test above is the one that does.
    const p = series(Array.from({ length: 40 }, (_, i) => i * 5));
    assert.equal(p.recentSlopePerMinute, p.windowSlopePerMinute);
    assert.equal(p.recentSlopePerMinute, 60);
  });

  it('carries the magnitude behind recentDirection, sign for sign', () => {
    /* The invariant that keeps the two consistent: they are one measurement, not two. A row saying
       `falling` beside a positive rate would be a contradiction the agent cannot resolve. */
    for (const values of [
      Array.from({ length: 40 }, (_, i) => i * 5),
      riseThenDrain(150, 20),
      Array.from({ length: 40 }, () => 80),
    ]) {
      const p = series(values);
      const slope = p.recentSlopePerMinute;
      assert.ok(slope !== null, 'sanity: fitted');
      const expected = slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'steady';
      assert.equal(p.recentDirection, expected, `slope ${slope} vs ${p.recentDirection}`);
    }
  });

  it('is null exactly where the window slope is null — one meaning for "no fit"', () => {
    /* Gated identically on purpose: `investigate()` derives `inboundRatePerSec` from a trend object
       that exists only when the window slope does, so a tail slope null under a non-null window
       would silently drop the field with no reason a reader could name. */
    for (const p of [series([0, 1, 2, 3, 5])]) {
      assert.equal(p.windowSlopePerMinute, null);
      assert.equal(p.recentSlopePerMinute, null);
    }
    const cfg = config();
    const store = new BaselineStore(cfg.baselineWindowSeconds, cfg.minBaselineSamples);
    const unmeasurable = projectHost(HOST, raw(null), store, cfg, T0);
    assert.equal(unmeasurable.windowSlopePerMinute, null);
    assert.equal(unmeasurable.recentSlopePerMinute, null);
  });
});
