'use strict';

/**
 * cache.js — in-memory store for the latest poll snapshots.
 *
 * The poller writes here; the HTTP router reads from here.
 * Metrics: one latest snapshot, overwritten every cycle — the current gauge reading
 * is all that matters and the next poll supersedes it.
 *
 * ALERTS ARE DIFFERENT: /api/monitor/alerts is CONSUME-ON-READ.
 * Verified against IRIS 2024.1 on 2026-08-11: the first GET returned two alerts,
 * every GET after it returned `[]`, while `iris_system_alerts_log` stayed at 2 and
 * `iris_system_alerts_new` dropped 1 → 0. The endpoint reports alerts *new since the
 * last read* and clears them; alerts.log keeps the durable copy.
 *
 * So overwriting the alerts snapshot each cycle would publish an alert for exactly one
 * poll interval and then lose it for good — the proxy's own read is what removed it
 * from IRIS, so nothing can fetch it again. A consumer polling on any interval that
 * does not align with ours would silently miss alerts.
 *
 * Alerts therefore ACCUMULATE here. The buffer is the only remaining copy of the data
 * in JSON form, so it is retained rather than replaced.
 */

let _metricsSnapshot = null;  // null until first successful poll
let _alertsSnapshot = null;

// Bounded so a long-running proxy on a noisy instance cannot grow without limit.
// Oldest entries are dropped first; `droppedCount` keeps the loss visible rather than
// letting the list quietly stop being complete.
const ALERTS_BUFFER_MAX = 500;
let _alerts = [];
let _alertsDropped = 0;
let _alertsFirstPollAt = null;

/**
 * Store a fresh metrics snapshot.
 * @param {Object} snapshot — parsed per-host metrics object from poller
 */
function setMetricsSnapshot(snapshot) {
  _metricsSnapshot = snapshot;
}

/**
 * Record an alerts poll result, appending any alerts it carried to the buffer.
 *
 * Called on every alerts poll including empty ones — an empty result still updates
 * `polledAt` and `shape`, which is how a consumer distinguishes "no new alerts" from
 * "the poller stopped running".
 *
 * @param {Object} snapshot — normalized result from src/alerts.js: {alerts, _meta}
 */
function setAlertsSnapshot(snapshot) {
  _alertsSnapshot = snapshot;
  if (_alertsFirstPollAt === null) _alertsFirstPollAt = snapshot._meta.polledAt;

  if (!snapshot.alerts.length) return;

  // Stamp each alert with the poll that observed it. IRIS alert bodies carry their own
  // `time`, but nothing guaranteeing uniqueness, so this is what lets a consumer tell
  // two identical repeated messages apart.
  for (const alert of snapshot.alerts) {
    _alerts.push({ ...alert, observedAt: snapshot._meta.polledAt });
  }

  if (_alerts.length > ALERTS_BUFFER_MAX) {
    _alertsDropped += _alerts.length - ALERTS_BUFFER_MAX;
    _alerts = _alerts.slice(-ALERTS_BUFFER_MAX);
  }
}

/**
 * Retrieve the latest metrics snapshot (null if not yet available).
 */
function getMetricsSnapshot() {
  return _metricsSnapshot;
}

/**
 * Retrieve the accumulated alerts (null before the first poll completes).
 *
 * Returns every alert observed since the proxy started — NOT just the last poll's.
 * See the consume-on-read note at the top of this file for why.
 */
function getAlertsSnapshot() {
  if (!_alertsSnapshot) return null;
  return {
    alerts: _alerts.slice(),
    _meta: {
      ..._alertsSnapshot._meta,
      // The last poll's own count, kept separate from the buffer total so "nothing new
      // this cycle" stays readable.
      count: _alerts.length,
      newInLastPoll: _alertsSnapshot.alerts.length,
      accumulatedSince: _alertsFirstPollAt,
      droppedCount: _alertsDropped,
      consumeOnRead: true,
    },
  };
}

/** Test-only: drop all accumulated state so cases cannot leak into each other. */
function _resetForTests() {
  _metricsSnapshot = null;
  _alertsSnapshot = null;
  _alerts = [];
  _alertsDropped = 0;
  _alertsFirstPollAt = null;
}

module.exports = {
  setMetricsSnapshot, setAlertsSnapshot, getMetricsSnapshot, getAlertsSnapshot,
  ALERTS_BUFFER_MAX, _resetForTests,
};
