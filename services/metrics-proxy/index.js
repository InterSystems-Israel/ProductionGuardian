'use strict';

/**
 * metrics-proxy — entry point
 *
 * Starts the polling loop and the HTTP server.
 * The proxy exposes two endpoints for the detection engine:
 *
 *   GET /proxy/metrics   — latest per-host metric snapshot (JSON)
 *   GET /proxy/alerts    — latest alerts from /api/monitor/alerts (JSON)
 *   GET /proxy/health    — liveness check
 *
 * Environment variables: see .env.example
 */

require('dotenv').config();  // load .env if present; silently skips if missing

const express = require('express');
const { startPoller } = require('./src/poller');
const { getMetricsSnapshot, getAlertsSnapshot } = require('./src/cache');

const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const app = express();

// ── Routes ────────────────────────────────────────────────────────────────────

// Latest per-host metrics snapshot.
// Returns the array described in contracts/proxy-schema.json.
app.get('/proxy/metrics', (req, res) => {
  const snapshot = getMetricsSnapshot();
  if (!snapshot) {
    // Poller has not completed its first poll yet.
    return res.status(503).json({ error: 'metrics not yet available — poll in progress' });
  }
  res.json(snapshot);
});

// Latest alerts from IRIS.
app.get('/proxy/alerts', (req, res) => {
  const alerts = getAlertsSnapshot();
  if (!alerts) {
    return res.status(503).json({ error: 'alerts not yet available — poll in progress' });
  }
  res.json(alerts);
});

// Simple liveness / readiness check.
app.get('/proxy/health', (req, res) => {
  const snapshot = getMetricsSnapshot();
  res.json({
    status: snapshot ? 'ok' : 'starting',
    uptime: process.uptime(),
    lastPoll: snapshot ? snapshot._meta.polledAt : null,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

startPoller();

app.listen(PORT, () => {
  console.log(`[metrics-proxy] listening on port ${PORT}`);
  console.log(`[metrics-proxy] IRIS target: ${process.env.IRIS_HOST}:${process.env.IRIS_PORT}`);
});
