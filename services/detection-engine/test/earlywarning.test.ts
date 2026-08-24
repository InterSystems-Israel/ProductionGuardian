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
import { projectHost } from '../src/detect/earlywarning.ts';
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
