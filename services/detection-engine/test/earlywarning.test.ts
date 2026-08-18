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
