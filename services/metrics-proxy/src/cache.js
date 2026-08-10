'use strict';

/**
 * cache.js — in-memory store for the latest poll snapshots.
 *
 * The poller writes here; the HTTP router reads from here.
 * Intentionally simple: one latest snapshot per endpoint type.
 * No history, no TTL eviction — the poller overwrites on every cycle.
 */

let _metricsSnapshot = null;  // null until first successful poll
let _alertsSnapshot = null;

/**
 * Store a fresh metrics snapshot.
 * @param {Object} snapshot — parsed per-host metrics object from poller
 */
function setMetricsSnapshot(snapshot) {
  _metricsSnapshot = snapshot;
}

/**
 * Store a fresh alerts snapshot.
 * @param {Array} alerts — parsed alerts array from poller
 */
function setAlertsSnapshot(alerts) {
  _alertsSnapshot = alerts;
}

/**
 * Retrieve the latest metrics snapshot (null if not yet available).
 */
function getMetricsSnapshot() {
  return _metricsSnapshot;
}

/**
 * Retrieve the latest alerts snapshot (null if not yet available).
 */
function getAlertsSnapshot() {
  return _alertsSnapshot;
}

module.exports = { setMetricsSnapshot, setAlertsSnapshot, getMetricsSnapshot, getAlertsSnapshot };
