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

// Alerts from IRIS, forwarded as JSON (acceptance criterion 4).
// Same warming contract as /proxy/metrics: 200 + empty list before the first poll.
//
// This returns every alert observed SINCE THE PROXY STARTED, not just the last poll's,
// because /api/monitor/alerts is consume-on-read — our own poll is what clears an alert
// from IRIS, so a per-poll snapshot would expose it for one 30 s window and then lose it
// permanently. `_meta.newInLastPoll` is the per-cycle count; `_meta.count` is the buffer
// total. See the note at the top of src/cache.js for the evidence.
//
// `_meta.shape` names how the upstream payload was interpreted, so a consumer seeing
// `shape: "unrecognized-object"` knows a zero is a mapping gap rather than a healthy
// production. `_meta.raw` carries the payload in that case. See src/alerts.js.
app.get('/proxy/alerts', (req, res) => {
  const alerts = getAlertsSnapshot();
  if (!alerts) {
    return res.json({ alerts: [], warming: true, _meta: { polledAt: null, shape: null, count: 0 } });
  }

  // Cross-check against the metrics side, which counts alerts independently.
  //
  // `iris_system_alerts_new` is NOT a useful cross-check for the buffer total: it is the
  // same consume-on-read counter, so our own poll drives it back to 0 and it reads 0
  // almost always. It is only meaningful against the LAST POLL's count, and even then
  // the two families are polled 30 s and 10 s apart, so a transient disagreement is
  // normal. Reported for diagnosis, not asserted on.
  //
  // `iris_system_alerts_log` is the durable count from alerts.log and does not reset.
  // A log count above the buffer total means alerts existed before this proxy started,
  // or were consumed by another reader — both are "you are not seeing everything",
  // which is worth surfacing since it cannot be recovered from this endpoint.
  const metrics = getMetricsSnapshot();
  const alertsNew = metrics ? metrics.systemAlertsNew : null;
  const alertsLog = metrics ? metrics.systemAlertsLog : null;
  const suspectMismatch =
    alertsNew !== null && alertsNew > 0 && alerts._meta.newInLastPoll === 0;

  res.json({
    ...alerts,
    _meta: {
      ...alerts._meta,
      systemAlertsNew: alertsNew,
      systemAlertsLog: alertsLog,
      // True when metrics saw unread alerts that the last alerts poll did not return —
      // a hint toward a shape mapping problem, not a verdict.
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
