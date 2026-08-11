'use strict';

/**
 * mock-server.js — standalone mock proxy for development without a live IRIS instance.
 *
 * Serves the fixture data from fixtures/ on the same endpoints as the real proxy:
 *   GET /proxy/metrics
 *   GET /proxy/alerts
 *   GET /proxy/health
 *
 * Start with: npm run mock
 *
 * The mock re-parses the fixture files on each request so you can edit them
 * without restarting the server.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { parsePrometheusText, buildSnapshot } = require('./src/parser');
const { normalizeAlerts } = require('./src/alerts');

const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const FIXTURES = path.join(__dirname, 'fixtures');

// Which metrics fixture to serve. Defaults to the full 313-line live capture, so the
// mock reproduces what real IRIS emits — including the framework hosts and the absent
// metric families. `metrics.txt` is the smaller hand-trimmed excerpt.
//   MOCK_FIXTURE=metrics.txt npm run mock
const METRICS_FIXTURE = process.env.MOCK_FIXTURE || 'metrics-live-capture.txt';

const app = express();

/** Re-read and re-parse the metrics fixture, so an edit lands without a restart. */
function readMetricsSnapshot() {
  const metricsText = fs.readFileSync(path.join(FIXTURES, METRICS_FIXTURE), 'utf8');
  return buildSnapshot(parsePrometheusText(metricsText), new Date().toISOString());
}

app.get('/proxy/metrics', (req, res) => {
  res.json(readMetricsSnapshot());
});

app.get('/proxy/alerts', (req, res) => {
  const alertsJson = fs.readFileSync(path.join(FIXTURES, 'alerts.json'), 'utf8');
  // Through the same normalizer as the live path, so the mock cannot accidentally
  // publish a shape the real proxy would reject (ADR 0004).
  const normalized = normalizeAlerts(alertsJson, new Date().toISOString());

  // The live route adds these in index.js. Omitting them here let the mock publish a
  // narrower object than the real proxy, which is the divergence ADR 0004 exists to
  // prevent: a consumer reading `_meta.newInLastPoll` got a number live and `undefined`
  // against the mock. Values are derived from the metrics fixture, not invented.
  const snapshot = readMetricsSnapshot();
  const newInLastPoll = normalized.alerts.length;
  res.json({
    ...normalized,
    _meta: {
      ...normalized._meta,
      count: newInLastPoll,
      newInLastPoll,
      // The mock has no history: it re-reads the fixture per request, so every alert is
      // always "new". accumulatedSince therefore equals this poll and nothing is dropped.
      accumulatedSince: normalized._meta.polledAt,
      droppedCount: 0,
      consumeOnRead: true,
      systemAlertsNew: snapshot.systemAlertsNew,
      systemAlertsLog: snapshot.systemAlertsLog,
      // Derived exactly as in index.js, not hardcoded false — otherwise the mock could
      // serve a fixture pair that the real proxy would flag and the mock would not.
      suspectShapeMismatch:
        snapshot.systemAlertsNew !== null && snapshot.systemAlertsNew > 0 && newInLastPoll === 0,
    },
  });
});

// Mirrors the live /proxy/health field-for-field, including the no-interop-data warning,
// so a smoke test asserting on health passes or fails for the same reasons in both modes.
app.get('/proxy/health', (req, res) => {
  const snapshot = readMetricsSnapshot();
  const noInteropData = snapshot._meta.absentFamilies.includes('iris_interop_hosts');
  res.json({
    status: noInteropData ? 'reachable, but no interop metrics (mock)' : 'ok (mock)',
    uptime: process.uptime(),
    lastPoll: snapshot._meta.polledAt,
    production: snapshot._meta.production,
    hostCount: snapshot._meta.hostCount,
    applicationHostCount: snapshot._meta.applicationHostCount,
    ...(noInteropData && {
      hint: `the fixture ${METRICS_FIXTURE} contains no iris_interop_* families`,
    }),
  });
});

app.listen(PORT, () => {
  console.log(`[mock-server] listening on port ${PORT}`);
  console.log(`[mock-server] serving fixture data from ${FIXTURES}`);
  console.log(`[mock-server] metrics fixture: ${METRICS_FIXTURE} (override with MOCK_FIXTURE=)`);
  console.log(`[mock-server] endpoints: GET /proxy/metrics  GET /proxy/alerts  GET /proxy/health`);
});
