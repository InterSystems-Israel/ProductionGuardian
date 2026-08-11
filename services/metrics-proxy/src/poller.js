'use strict';

/**
 * poller.js — HTTP polling loop for IRIS /api/monitor/ endpoints.
 *
 * Polls /api/monitor/metrics every METRICS_POLL_INTERVAL_MS milliseconds
 * and /api/monitor/alerts every ALERTS_POLL_INTERVAL_MS milliseconds.
 * Writes results to the cache module.
 */

const http = require('http');
const https = require('https');
const { parsePrometheusText, buildSnapshot } = require('./parser');
const { normalizeAlerts } = require('./alerts');
const { setMetricsSnapshot, setAlertsSnapshot } = require('./cache');

const IRIS_HOST      = process.env.IRIS_HOST      || 'localhost';
const IRIS_PORT      = parseInt(process.env.IRIS_PORT || '52773', 10);
const IRIS_USER      = process.env.IRIS_USER      || '_SYSTEM';
const IRIS_PASS      = process.env.IRIS_PASS      || 'SYS';
const IRIS_NAMESPACE = process.env.IRIS_NAMESPACE || 'LABDEMO';
const USE_HTTPS      = process.env.IRIS_HTTPS === 'true';

/**
 * Path prefix in front of /api/monitor/. Empty on an instance served by its own
 * private web server on 52773; on an instance served through an external web server
 * the instance name is a path segment, e.g.
 *   http://localhost/iris4health_2024_1/api/monitor/metrics
 * Without this the poller requests /api/monitor/metrics at the web server root and
 * gets the server's 404 page, which parses as zero metric lines — an empty snapshot
 * that looks like an idle production rather than a misconfiguration.
 */
const IRIS_BASE_PATH = normalizeBasePath(process.env.IRIS_BASE_PATH || '');

/** Trim to a leading-slash, no-trailing-slash form so path joining stays predictable. */
function normalizeBasePath(raw) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const METRICS_INTERVAL = parseInt(process.env.METRICS_POLL_INTERVAL_MS || '10000', 10);
const ALERTS_INTERVAL  = parseInt(process.env.ALERTS_POLL_INTERVAL_MS  || '30000', 10);

const AUTH_HEADER = 'Basic ' + Buffer.from(`${IRIS_USER}:${IRIS_PASS}`).toString('base64');

/**
 * Make an authenticated HTTP(S) GET request to the IRIS instance.
 * Returns a promise resolving to the response body string.
 *
 * @param {string} path — endpoint path, e.g. '/api/monitor/metrics'.
 *   IRIS_BASE_PATH is prepended.
 * @returns {Promise<string>}
 */
function irisGet(path) {
  return new Promise((resolve, reject) => {
    const client = USE_HTTPS ? https : http;
    const options = {
      hostname: IRIS_HOST,
      port: IRIS_PORT,
      path: IRIS_BASE_PATH + path,
      method: 'GET',
      headers: {
        'Authorization': AUTH_HEADER,
        'Accept': '*/*',
      },
      // For HTTPS with self-signed certs in a dev environment:
      rejectUnauthorized: false,
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`IRIS ${path} returned HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error(`IRIS ${path} request timed out after 8s`));
    });
    req.end();
  });
}

/**
 * Poll /api/monitor/metrics, parse the Prometheus text, and store the snapshot.
 */
async function pollMetrics() {
  const polledAt = new Date().toISOString();
  try {
    const body = await irisGet('/api/monitor/metrics');
    const raw = parsePrometheusText(body);
    const snapshot = buildSnapshot(raw, polledAt);
    setMetricsSnapshot(snapshot);
    console.log(`[poller] metrics: ${snapshot.hosts.length} hosts polled at ${polledAt}`);
  } catch (err) {
    console.error(`[poller] metrics poll failed: ${err.message}`);
  }
}

/**
 * Poll /api/monitor/alerts and store the normalized JSON.
 *
 * Shape handling lives in ./alerts — the payload shape is unverified (no capture of
 * this endpoint exists yet), so an unfamiliar body is reported rather than silently
 * flattened to an empty list. `system_alert` is the only finding fed from here.
 */
async function pollAlerts() {
  const polledAt = new Date().toISOString();
  try {
    const body = await irisGet('/api/monitor/alerts');
    const snapshot = normalizeAlerts(body, polledAt);
    setAlertsSnapshot(snapshot);

    const { shape, count } = snapshot._meta;
    // Warn on any shape that produced no alerts for a reason other than "there are
    // none". Silence here was how a shape mismatch could look like a healthy zero.
    if (shape === 'array' || shape === 'empty' || shape.startsWith('wrapped:')) {
      console.log(`[poller] alerts: ${count} alerts (shape: ${shape}) at ${polledAt}`);
    } else {
      console.warn(
        `[poller] alerts: UNEXPECTED payload shape "${shape}" — published 0 alerts. ` +
        `system_alert findings cannot fire until the mapping is corrected. ` +
        `See _meta on /proxy/alerts for the raw payload.`
      );
    }
  } catch (err) {
    console.error(`[poller] alerts poll failed: ${err.message}`);
  }
}

/**
 * Start the polling loops. Call once at startup.
 */
function startPoller() {
  console.log(`[poller] starting — metrics every ${METRICS_INTERVAL}ms, alerts every ${ALERTS_INTERVAL}ms`);
  // Include IRIS_BASE_PATH — it is part of the URL actually requested, and omitting it
  // from the banner made a wrong prefix invisible at the one moment you would look.
  console.log(`[poller] IRIS: ${USE_HTTPS ? 'https' : 'http'}://${IRIS_HOST}:${IRIS_PORT}`
    + `${IRIS_BASE_PATH} (namespace: ${IRIS_NAMESPACE})`);

  // Run immediately on startup, then on interval.
  pollMetrics();
  pollAlerts();

  setInterval(pollMetrics, METRICS_INTERVAL);
  setInterval(pollAlerts, ALERTS_INTERVAL);
}

module.exports = { startPoller, irisGet, pollMetrics, pollAlerts };
