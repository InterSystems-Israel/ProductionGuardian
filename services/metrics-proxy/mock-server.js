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

const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const FIXTURES = path.join(__dirname, 'fixtures');

const app = express();

app.get('/proxy/metrics', (req, res) => {
  const metricsText = fs.readFileSync(path.join(FIXTURES, 'metrics.txt'), 'utf8');
  const raw = parsePrometheusText(metricsText);
  const snapshot = buildSnapshot(raw, new Date().toISOString());
  res.json(snapshot);
});

app.get('/proxy/alerts', (req, res) => {
  const alertsJson = fs.readFileSync(path.join(FIXTURES, 'alerts.json'), 'utf8');
  const alerts = JSON.parse(alertsJson);
  res.json({ alerts, _meta: { polledAt: new Date().toISOString() } });
});

app.get('/proxy/health', (req, res) => {
  res.json({ status: 'ok (mock)', uptime: process.uptime(), lastPoll: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[mock-server] listening on port ${PORT}`);
  console.log(`[mock-server] serving fixture data from ${FIXTURES}`);
  console.log(`[mock-server] endpoints: GET /proxy/metrics  GET /proxy/alerts  GET /proxy/health`);
});
