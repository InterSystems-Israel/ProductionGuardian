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

// Latest alerts from IRIS, forwarded as JSON (acceptance criterion 4).
// Same warming contract as /proxy/metrics: 200 + empty list before the first poll.
//
// `_meta.shape` names how the upstream payload was interpreted — the shape of
// /api/monitor/alerts is not yet pinned by a capture, so a consumer seeing
// `shape: "unrecognized-object"` knows the zero is a mapping gap, not a healthy
// production. `_meta.raw` carries the payload in that case. See src/alerts.js.
app.get('/proxy/alerts', (req, res) => {
  const alerts = getAlertsSnapshot();
  if (!alerts) {
    return res.json({ alerts: [], warming: true, _meta: { polledAt: null, shape: null, count: 0 } });
  }

  // Cross-check against the metrics side, which counts alerts independently via
  // `iris_system_alerts_new`. The two are polled on different intervals (30 s vs
  // 10 s), so a mismatch is only meaningful as a hint — but "metrics says there are
  // alerts and this list is empty" is exactly the symptom of a wrong shape mapping,
  // and it is far cheaper to surface here than to debug from a blank dashboard.
  const metrics = getMetricsSnapshot();
  const alertsNew = metrics ? metrics.systemAlertsNew : null;
  const suspectMismatch = alertsNew !== null && alertsNew > 0 && alerts.alerts.length === 0;

  res.json({
    ...alerts,
    _meta: {
      ...alerts._meta,
      systemAlertsNew: alertsNew,
      // True when metrics report new alerts but this endpoint published none.
      suspectShapeMismatch: suspectMismatch,
    },
  });
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
