'use strict';

/**
 * cache.test.js — the alerts buffer.
 *
 * These exist because /api/monitor/alerts is consume-on-read (verified 2026-08-11:
 * first GET returned two alerts, every GET after returned []). The proxy's own poll is
 * what clears an alert from IRIS, so a snapshot that gets overwritten each cycle loses
 * data permanently. Everything here is about that.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  setAlertsSnapshot, getAlertsSnapshot, setMetricsSnapshot, getMetricsSnapshot,
  ALERTS_BUFFER_MAX, _resetForTests,
} = require('./cache');

/** A normalized poll result, as src/alerts.js produces. */
function poll(alerts, polledAt, shape = 'array') {
  return { alerts, _meta: { polledAt, shape, count: alerts.length } };
}

describe('alerts buffer — accumulation', () => {
  beforeEach(() => _resetForTests());

  it('returns null before the first poll so /proxy/alerts can answer warming', () => {
    assert.equal(getAlertsSnapshot(), null);
  });

  it('accumulates across polls instead of overwriting', () => {
    // THE REGRESSION. IRIS returned these two alerts on one poll and [] forever after.
    // With a replace-on-write cache they would have been visible for one 30 s window
    // and then gone — unrecoverable, because reading them is what deleted them.
    setAlertsSnapshot(poll([{ message: 'large pages' }], '2026-08-11T12:00:00.000Z'));
    setAlertsSnapshot(poll([], '2026-08-11T12:00:30.000Z'));
    setAlertsSnapshot(poll([], '2026-08-11T12:01:00.000Z'));

    const out = getAlertsSnapshot();
    assert.equal(out.alerts.length, 1, 'the alert must survive later empty polls');
    assert.equal(out.alerts[0].message, 'large pages');
  });

  it('keeps the last poll count separate from the buffer total', () => {
    setAlertsSnapshot(poll([{ message: 'a' }, { message: 'b' }], '2026-08-11T12:00:00.000Z'));
    assert.equal(getAlertsSnapshot()._meta.newInLastPoll, 2);
    assert.equal(getAlertsSnapshot()._meta.count, 2);

    // A quiet cycle: nothing new, but the two earlier alerts are still published.
    setAlertsSnapshot(poll([], '2026-08-11T12:00:30.000Z'));
    const out = getAlertsSnapshot();
    assert.equal(out._meta.newInLastPoll, 0, 'nothing new this cycle');
    assert.equal(out._meta.count, 2, 'but the buffer still holds both');
  });

  it('advances polledAt on an empty poll so a stalled poller is detectable', () => {
    // An empty poll is still a successful poll. If polledAt froze at the last
    // alert-bearing cycle, a dead poller would look identical to a quiet instance.
    setAlertsSnapshot(poll([{ message: 'a' }], '2026-08-11T12:00:00.000Z'));
    setAlertsSnapshot(poll([], '2026-08-11T12:05:00.000Z'));
    assert.equal(getAlertsSnapshot()._meta.polledAt, '2026-08-11T12:05:00.000Z');
  });

  it('stamps each alert with the poll that observed it', () => {
    // IRIS alert bodies carry `time` but nothing unique, so two identical repeated
    // messages are otherwise indistinguishable.
    setAlertsSnapshot(poll([{ message: 'repeated' }], '2026-08-11T12:00:00.000Z'));
    setAlertsSnapshot(poll([{ message: 'repeated' }], '2026-08-11T12:30:00.000Z'));
    const out = getAlertsSnapshot();
    assert.equal(out.alerts.length, 2);
    assert.equal(out.alerts[0].observedAt, '2026-08-11T12:00:00.000Z');
    assert.equal(out.alerts[1].observedAt, '2026-08-11T12:30:00.000Z');
  });

  it('records when accumulation started and flags consume-on-read', () => {
    setAlertsSnapshot(poll([], '2026-08-11T12:00:00.000Z'));
    setAlertsSnapshot(poll([], '2026-08-11T12:00:30.000Z'));
    const out = getAlertsSnapshot();
    // Consumers need this to know the list is "since the proxy started", not "ever".
    assert.equal(out._meta.accumulatedSince, '2026-08-11T12:00:00.000Z');
    assert.equal(out._meta.consumeOnRead, true);
  });

  it('preserves upstream field names rather than mapping them', () => {
    // The real shape is time/severity/message, with severity a numeric string. The
    // mapping onto the contract's timestamp/severity/text is an open contract question
    // (fixtures/README.md), so the proxy must not invent one here.
    const real = { time: '2026-08-10T06:40:33.420Z', severity: '2', message: 'large pages' };
    setAlertsSnapshot(poll([real], '2026-08-11T12:00:00.000Z'));
    const got = getAlertsSnapshot().alerts[0];
    assert.equal(got.time, real.time);
    assert.equal(got.severity, '2');
    assert.equal(got.message, real.message);
    assert.equal(got.text, undefined, 'must not fabricate a `text` field');
  });

  it('does not let a caller mutate the buffer through the returned array', () => {
    setAlertsSnapshot(poll([{ message: 'a' }], '2026-08-11T12:00:00.000Z'));
    getAlertsSnapshot().alerts.push({ message: 'injected' });
    assert.equal(getAlertsSnapshot().alerts.length, 1);
  });
});

describe('alerts buffer — two concurrent readers (#69)', () => {
  beforeEach(() => _resetForTests());

  // #69 added a second caller of pollAlerts() -- the iris_system_alerts_new flag path --
  // alongside the 30s interval. So two reads of a CONSUME-ON-READ endpoint can now overlap,
  // and exactly one of them gets the alert while the other gets []. A change motivated by
  // reducing races on that endpoint must not introduce one.
  //
  // WHAT ACTUALLY MAKES IT SAFE, having tested it: the buffer is APPEND-ONLY. `_alerts` is
  // never reassigned by a read -- only pushed to, trimmed when over the cap, and cleared by
  // _resetForTests(). So an empty read has nothing to clobber with.
  //
  // @tanifgit and I both identified `if (!snapshot.alerts.length) return;` as the
  // load-bearing line. It is not: removing it leaves all 103 tests passing, because
  // iterating an empty array is a no-op. It is an early-out, not a guard. Recording that
  // because a comment naming the wrong protective mechanism is worse than none -- someone
  // hardening this would preserve the return and feel safe, when the property to preserve is
  // append-only.
  it('keeps the alert whichever concurrent read lands second', () => {
    setAlertsSnapshot(poll([{ message: 'Cloud API failed' }], '2026-08-13T10:00:00.000Z'));
    setAlertsSnapshot(poll([], '2026-08-13T10:00:01.000Z'));
    assert.equal(getAlertsSnapshot().alerts.length, 1, 'the empty read must not clobber it');

    _resetForTests();

    // And the other order, because "whichever lands second" is the whole claim.
    setAlertsSnapshot(poll([], '2026-08-13T10:00:00.000Z'));
    setAlertsSnapshot(poll([{ message: 'Cloud API failed' }], '2026-08-13T10:00:01.000Z'));
    assert.equal(getAlertsSnapshot().alerts.length, 1, 'order must not matter');
  });

  it('newInLastPoll can briefly understate, while count does not', () => {
    // The one cosmetic consequence: `_alertsSnapshot = snapshot` runs before the early
    // return, so a racing empty read leaves newInLastPoll at 0 for one cycle even though
    // the alert WAS collected. Pinned rather than fixed -- count comes from the buffer per
    // the contract, so nothing user-visible is wrong, and #67's argument was partly about
    // diagnostics being trustworthy, so the one field that can understate should be known.
    setAlertsSnapshot(poll([{ message: 'Cloud API failed' }], '2026-08-13T10:00:00.000Z'));
    setAlertsSnapshot(poll([], '2026-08-13T10:00:01.000Z'));

    const out = getAlertsSnapshot();
    assert.equal(out._meta.newInLastPoll, 0, 'understates for one cycle, by design');
    assert.equal(out.alerts.length, 1, 'but the alert is there');
  });
});

describe('alerts buffer — bounded growth', () => {
  beforeEach(() => _resetForTests());

  it('caps the buffer and reports what it dropped', () => {
    // A noisy instance over days must not grow the buffer without limit, but a silent
    // cap would make the list look complete when it is not.
    for (let i = 0; i < ALERTS_BUFFER_MAX + 10; i++) {
      setAlertsSnapshot(poll([{ message: `alert-${i}` }], '2026-08-11T12:00:00.000Z'));
    }
    const out = getAlertsSnapshot();
    assert.equal(out.alerts.length, ALERTS_BUFFER_MAX);
    assert.equal(out._meta.droppedCount, 10);
    // Oldest dropped, newest kept.
    assert.equal(out.alerts.at(-1).message, `alert-${ALERTS_BUFFER_MAX + 9}`);
    assert.equal(out.alerts[0].message, 'alert-10');
  });

  it('reports droppedCount 0 while under the cap', () => {
    setAlertsSnapshot(poll([{ message: 'a' }], '2026-08-11T12:00:00.000Z'));
    assert.equal(getAlertsSnapshot()._meta.droppedCount, 0);
  });
});

describe('metrics snapshot', () => {
  beforeEach(() => _resetForTests());

  it('replaces on write — the latest gauge reading is the only one that matters', () => {
    setMetricsSnapshot({ hosts: [{ host: 'a' }], _meta: { polledAt: 't1' } });
    setMetricsSnapshot({ hosts: [{ host: 'b' }], _meta: { polledAt: 't2' } });
    assert.equal(getMetricsSnapshot().hosts[0].host, 'b');
  });
});
