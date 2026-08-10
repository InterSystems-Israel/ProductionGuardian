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

const fs = require('fs');
const path = require('path');
const express = require('express');

/**
 * Minimal .env reader: KEY=value per line, # comments and blanks skipped.
 * Existing environment variables always win, so an exported var overrides the file.
 *
 * dotenv is deliberately NOT a dependency — the proxy must start with nothing
 * installed but express. Node 20.6+ can do this natively via
 * `node --env-file=.env index.js`; this covers Node 18 without adding a dep.
 */
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip surrounding quotes; a password containing '#' must survive intact.
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Must run before ./src/poller is required — that module reads process.env at load time,
// so requiring it any earlier would freeze in the defaults instead of the .env values.
loadDotEnv();

const { startPoller } = require('./src/poller');
const { getMetricsSnapshot, getAlertsSnapshot } = require('./src/cache');

const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const app = express();

// ── Routes ────────────────────────────────────────────────────────────────────

// Latest per-host metrics snapshot.
// Returns the array described in contracts/proxy-schema.json.
//
// Before the first poll completes, this answers 200 with an empty host list and
// `warming: true` rather than 503. A 503 during the ~10 s startup window read to the
// detection engine as "the proxy is down" and produced a spurious system-level
// finding on every restart (issue #10); an empty snapshot is the honest answer —
// there are no hosts to report *yet*, which is different from a failure.
app.get('/proxy/metrics', (req, res) => {
  const snapshot = getMetricsSnapshot();
  if (!snapshot) {
    return res.json({ hosts: [], systemAlertsNew: null, warming: true, _meta: { polledAt: null } });
  }
  res.json(snapshot);
});

// Latest alerts from IRIS. Same warming contract as /proxy/metrics.
app.get('/proxy/alerts', (req, res) => {
  const alerts = getAlertsSnapshot();
  if (!alerts) {
    return res.json({ alerts: [], warming: true });
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
