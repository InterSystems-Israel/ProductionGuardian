/**
 * Baseline window tests — ADR 0002.
 *
 * Includes the self-inflation property: a sustained breach raises its own baseline,
 * so a comparative finding can clear while the bad value persists. That is inherent
 * to a rolling mean, not a bug — pinned here so nobody "fixes" it by accident, and
 * so the tradeoff is visible if we later decide it needs addressing.
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
});
