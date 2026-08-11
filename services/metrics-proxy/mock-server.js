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

app.get('/proxy/metrics', (req, res) => {
  const metricsText = fs.readFileSync(path.join(FIXTURES, METRICS_FIXTURE), 'utf8');
  const raw = parsePrometheusText(metricsText);
  const snapshot = buildSnapshot(raw, new Date().toISOString());
  res.json(snapshot);
});

app.get('/proxy/alerts', (req, res) => {
  const alertsJson = fs.readFileSync(path.join(FIXTURES, 'alerts.json'), 'utf8');
  // Through the same normalizer as the live path, so the mock cannot accidentally
  // publish a shape the real proxy would reject (ADR 0004).
  res.json(normalizeAlerts(alertsJson, new Date().toISOString()));
});

app.get('/proxy/health', (req, res) => {
  res.json({ status: 'ok (mock)', uptime: process.uptime(), lastPoll: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[mock-server] listening on port ${PORT}`);
  console.log(`[mock-server] serving fixture data from ${FIXTURES}`);
  console.log(`[mock-server] metrics fixture: ${METRICS_FIXTURE} (override with MOCK_FIXTURE=)`);
  console.log(`[mock-server] endpoints: GET /proxy/metrics  GET /proxy/alerts  GET /proxy/health`);
});
