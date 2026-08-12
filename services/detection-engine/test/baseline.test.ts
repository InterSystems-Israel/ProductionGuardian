/**
 * Baseline window tests — ADR 0002.
 *
 * Includes the self-inflation property: a sustained breach raises its own baseline,
 * so a comparative finding can clear while the bad value persists. That is inherent
 * to a rolling mean, not a bug — pinned here so nobody "fixes" it by accident, and
 * so the tradeoff is visible if we later decide it needs addressing.
 *
 * And its sharper sibling, found in the first live end-to-end run (#43): against a
 * *growing* value the finding never appears at all. The two are the same mechanism at
 * different stages — a step change fires then clears, a ramp is silent throughout —
 * which is why they are pinned together.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BaselineStore } from '../src/baseline/window.ts';

const T0 = Date.parse('2026-08-06T16:00:00Z');
const STEP = 10_000;

describe('warm-up gate', () => {
  it('returns null below the minimum sample count', () => {
    const store = new BaselineStore(1800, 12);
    for (let i = 0; i < 11; i += 1) store.record('Lab Router', 'queued', 10, T0 + i * STEP);
    assert.equal(store.baseline('Lab Router', 'queued'), null, '11 of 12 is still warming');
  });

  it('returns a mean exactly at the minimum', () => {
    const store = new BaselineStore(1800, 12);
    for (let i = 0; i < 12; i += 1) store.record('Lab Router', 'queued', 10, T0 + i * STEP);
    assert.equal(store.baseline('Lab Router', 'queued'), 10);
  });

  it('returns null for a metric never recorded', () => {
    const store = new BaselineStore(1800, 1);
    store.record('Lab Router', 'queued', 5, T0);
    assert.equal(store.baseline('Lab Router', 'messagesPerSec'), null);
  });

  it('tracks hosts independently', () => {
    const store = new BaselineStore(1800, 2);
    store.record('Lab Router', 'queued', 10, T0);
    store.record('Lab Router', 'queued', 10, T0 + STEP);
    store.record('Cloud API', 'queued', 100, T0);
    store.record('Cloud API', 'queued', 100, T0 + STEP);
    assert.equal(store.baseline('Lab Router', 'queued'), 10);
    assert.equal(store.baseline('Cloud API', 'queued'), 100);
  });
});

describe('window pruning', () => {
  it('drops samples older than the window', () => {
    const store = new BaselineStore(60, 1);
    store.record('Lab Router', 'queued', 1000, T0);
    // 120s later the first sample is outside a 60s window.
    store.record('Lab Router', 'queued', 10, T0 + 120_000);
    assert.equal(store.baseline('Lab Router', 'queued'), 10, 'stale sample must be gone');
    assert.equal(store.sampleCount('Lab Router', 'queued'), 1);
  });

  it('falls back to warming when pruning drops below the minimum', () => {
    const store = new BaselineStore(60, 3);
    for (let i = 0; i < 3; i += 1) store.record('Lab Router', 'queued', 10, T0 + i * 1000);
    assert.equal(store.baseline('Lab Router', 'queued'), 10);

    store.record('Lab Router', 'queued', 10, T0 + 300_000);
    assert.equal(
      store.baseline('Lab Router', 'queued'),
      null,
      'a long proxy outage legitimately returns us to warming',
    );
  });
});

describe('bad input', () => {
  it('ignores NaN and Infinity rather than poisoning the mean', () => {
    const store = new BaselineStore(1800, 2);
    store.record('Lab Router', 'queued', 10, T0);
    store.record('Lab Router', 'queued', Number.NaN, T0 + STEP);
    store.record('Lab Router', 'queued', Number.POSITIVE_INFINITY, T0 + 2 * STEP);
    store.record('Lab Router', 'queued', 20, T0 + 3 * STEP);
    assert.equal(store.baseline('Lab Router', 'queued'), 15, 'mean of 10 and 20 only');
  });
});

describe('forget', () => {
  it('drops only the named host, despite spaces in host names', () => {
    const store = new BaselineStore(1800, 1);
    store.record('Lab Router', 'queued', 10, T0);
    store.record('Lab Router 2', 'queued', 20, T0);
    store.forget('Lab Router');
    assert.equal(store.baseline('Lab Router', 'queued'), null);
    assert.equal(
      store.baseline('Lab Router 2', 'queued'),
      20,
      'a host whose name is a prefix of another must survive',
    );
  });
});

describe('self-inflation (inherent to a rolling mean)', () => {
  it('lets a sustained breach raise its own baseline until the ratio collapses', () => {
    const store = new BaselineStore(1800, 12);
    let at = T0;
    for (let i = 0; i < 12; i += 1) {
      store.record('Cloud API', 'queued', 0, at);
      at += STEP;
    }

    // First breaching sample: baseline is still near zero, so the ratio is enormous.
    store.record('Cloud API', 'queued', 486, at);
    at += STEP;
    const early = store.baseline('Cloud API', 'queued');
    assert.ok(early !== null);
    assert.ok(486 / early > 5, `expected a large ratio, got ${486 / early}`);

    // Keep the bad value in place: the mean climbs toward it and the ratio falls.
    for (let i = 0; i < 20; i += 1) {
      store.record('Cloud API', 'queued', 486, at);
      at += STEP;
    }
    const late = store.baseline('Cloud API', 'queued');
    assert.ok(late !== null);
    assert.ok(
      486 / late < 5,
      `a persistently bad value becomes the new normal (ratio ${486 / late})`,
    );
  });

  /**
   * The live case (#43), and the more dangerous one: a linear ramp NEVER reaches 5x.
   *
   * Measured against real LABDEMO — a disabled Cloud API queued 6 -> 122 messages and
   * `queue_buildup` stayed silent the whole way, well past its absoluteFloor of 50.
   *
   * The ceiling is RATE-invariant, not scale-invariant, and it has a closed form:
   *
   *     ceiling = 2·i* / (i* − 1)
   *
   * where i* is the first sample clearing BOTH `minBaselineSamples` and the absolute
   * floor. At N=12 that is 24/11 = 2.1818…, so the figure comes from the WARM-UP COUNT,
   * not from the ramp. Verified by probing BaselineStore directly (@tanifgit, #45):
   *
   *     step=8/30/500  N=12  -> 2.1818  (rate cannot change it, confirmed to 500/poll)
   *     step=8         N=24  -> 2.0870  (but minBaselineSamples CAN)
   *     step=8  N=12  floor=500 -> 2.0323  (a higher floor LOWERS it: i* is later,
   *                                         where the ratio is smaller)
   *
   * Hence the assertion below is `< 5`, not `≈ 2.18`: the closed form is ≤ 4 for any
   * N ≥ 2, so "never 5x" is robust in a way the specific number is not. Do not rewrite
   * `2.18` as a constant here — re-derive it from N.
   *
   * WHAT THIS DOES NOT SHOW: that no multiplier can work. The ratio asymptotes to 2 from
   * ABOVE and stays there for the life of the window, so a gate at 2.0 does fire, on
   * ~185 consecutive samples. The tuning family is ruled out by COST, not arithmetic — a
   * 2.0 ratio gate on queue depth would fire on ordinary traffic variation. That is a
   * better argument for #43's "change what the comparison is against" than impossibility,
   * and it is a question #25's ADR has to answer rather than assume.
   *
   * `fixtures/proxy/queue-buildup.json` jumps 0 -> 486 in one poll, which is why the
   * fixture suite is green and the live run was not: the fixture is honest about the
   * value and wrong about the shape, and this rule is sensitive to shape.
   */
  it('never reaches 5x against a linear ramp, at any rate (#43)', () => {
    // Copies of windowSeconds / minBaselineSamples / queue_buildup.absoluteFloor from
    // thresholds.json. Deliberately hardcoded so this pinning test does not move with
    // config — the `< 5` result holds for any of them. Named rather than inlined so the
    // ceiling stays re-derivable: change MIN_SAMPLES and the ceiling becomes
    // 2·N/(N−1), NOT 2.18.
    const WINDOW_SECONDS = 1800;
    const MIN_SAMPLES = 12;
    const ABSOLUTE_FLOOR = 50;

    const ceiling = (step: number): number => {
      const store = new BaselineStore(WINDOW_SECONDS, MIN_SAMPLES);
      let at = T0;
      let best = 0;
      for (let i = 0; i < 120; i += 1) {
        const depth = i * step;
        const mean = store.baseline('Cloud API', 'queued');
        // Only count samples that clear the rule's own absolute floor, since below it
        // the rule is gated off regardless of ratio.
        if (mean !== null && mean > 0 && depth >= ABSOLUTE_FLOOR) {
          best = Math.max(best, depth / mean);
        }
        store.record('Cloud API', 'queued', depth, at);
        at += STEP;
      }
      return best;
    };

    const slow = ceiling(8);
    const fast = ceiling(30);

    assert.ok(slow < 5, `a slow ramp must not fire (peak ratio ${slow.toFixed(2)}x)`);
    assert.ok(fast < 5, `a fast ramp must not fire either (peak ratio ${fast.toFixed(2)}x)`);
    assert.ok(
      Math.abs(slow - fast) < 0.01,
      `the ceiling is RATE-invariant, so a faster generator cannot help ` +
        `(${slow.toFixed(2)}x vs ${fast.toFixed(2)}x)`,
    );
  });
});
