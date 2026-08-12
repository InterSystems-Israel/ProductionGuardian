'use strict';

/**
 * poller.js — HTTP polling loop for IRIS monitoring endpoints.
 *
 * Polls /api/monitor/metrics every METRICS_POLL_INTERVAL_MS milliseconds
 * and /api/monitor/alerts every ALERTS_POLL_INTERVAL_MS milliseconds.
 * Writes results to the cache module.
 *
 * A THIRD SOURCE, on the metrics interval
 *
 * Per-host queue depth and per-host error counts are not in the Prometheus text —
 * both families are per-production (#12, #31). They come from a small read-only REST
 * endpoint in the LABDEMO namespace instead, polled alongside metrics and merged by
 * host name before the snapshot is cached. See ./hoststatus.js for the why and the
 * join-key argument, and IRIS_HOSTSTATUS_PATH below for the URL.
 */

const http = require('http');
const https = require('https');
const { parsePrometheusText, buildSnapshot } = require('./parser');
const { normalizeAlerts } = require('./alerts');
const { parseHostStatus, mergeHostStatus } = require('./hoststatus');
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

/**
 * Path to the per-host status endpoint (iris/labdemo/REST/HostStatusDispatcher.cls).
 *
 * NOT under IRIS_BASE_PATH: that prefix locates the instance's built-in /api/monitor/
 * web app, while this is a separate CSP web application registered at its own path in
 * the LABDEMO namespace. On the verified instance the two are
 *   /api/monitor/metrics            (IRIS_BASE_PATH + /api/monitor/metrics)
 *   /labdemo/monitor/hoststatus     (this, absolute)
 * so it is configured as a whole path rather than a suffix.
 *
 * Set it empty to disable the third poll entirely — the proxy then behaves exactly as
 * it did before, publishing `queued`/`errored` as null. That is the honest degradation
 * for an instance where this endpoint is not deployed.
 */
const IRIS_HOSTSTATUS_PATH = (process.env.IRIS_HOSTSTATUS_PATH === undefined
  ? '/labdemo/monitor/hoststatus'
  : process.env.IRIS_HOSTSTATUS_PATH).trim();

const AUTH_HEADER = 'Basic ' + Buffer.from(`${IRIS_USER}:${IRIS_PASS}`).toString('base64');

/**
 * Make an authenticated HTTP(S) GET request to the IRIS instance.
 * Returns a promise resolving to the response body string.
 *
 * @param {string} path — endpoint path, e.g. '/api/monitor/metrics'.
 *   IRIS_BASE_PATH is prepended.
 * @param {Object} [opts]
 * @param {boolean} [opts.absolute] — skip IRIS_BASE_PATH and request `path` as given.
 *   Used for the host-status endpoint, which is its own web application rather than
 *   something under the instance's /api/monitor/ prefix.
 * @returns {Promise<string>}
 */
function irisGet(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const client = USE_HTTPS ? https : http;
    const options = {
      hostname: IRIS_HOST,
      port: IRIS_PORT,
      path: opts.absolute ? path : IRIS_BASE_PATH + path,
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
 * Poll the host-status endpoint. Returns parsed per-host state, or null when the
 * endpoint is disabled or unreachable.
 *
 * Failure is logged and swallowed on purpose: this is a supplementary source, and a
 * metrics snapshot without it is exactly what the proxy published before — degraded,
 * not wrong. Throwing here would lose the metrics poll too.
 */
async function pollHostStatus() {
  if (!IRIS_HOSTSTATUS_PATH) return null;
  const polledAt = new Date().toISOString();
  try {
    const body = await irisGet(IRIS_HOSTSTATUS_PATH, { absolute: true });
    return parseHostStatus(body, polledAt);
  } catch (err) {
    console.error(`[poller] host-status poll failed: ${err.message}`);
    return null;
  }
}

/**
 * Poll /api/monitor/metrics, parse the Prometheus text, merge per-host state from the
 * host-status endpoint, and store the snapshot.
 *
 * The two requests run concurrently — they are independent reads and the host-status
 * one must not add its latency to the metrics interval.
 */
async function pollMetrics() {
  const polledAt = new Date().toISOString();
  try {
    // Only the metrics body is awaited for correctness; host status settles alongside
    // and contributes whatever it has. allSettled, not all: a rejected host-status
    // promise must not reject the metrics poll.
    const [metricsResult, hostStatusResult] = await Promise.allSettled([
      irisGet('/api/monitor/metrics'),
      pollHostStatus(),
    ]);

    if (metricsResult.status === 'rejected') throw metricsResult.reason;

    const raw = parsePrometheusText(metricsResult.value);
    const base = buildSnapshot(raw, polledAt);
    const hostStatus = hostStatusResult.status === 'fulfilled' ? hostStatusResult.value : null;
    const snapshot = mergeHostStatus(base, hostStatus);

    setMetricsSnapshot(snapshot);

    const hs = snapshot._meta.hostStatus;
    let suffix = '';
    if (!IRIS_HOSTSTATUS_PATH) {
      suffix = ' (host-status disabled: queued/errored stay null)';
    } else if (hs && hs.shape === 'hosts') {
      suffix = `, ${hs.merged} merged from host-status`;
      // A shape the parser understood but that matched nothing is the interesting
      // failure: it looks healthy and leaves every queued/errored null.
      if (hs.merged === 0) suffix += ' — NO HOST NAMES MATCHED';
      if (hs.unmatchedHosts.length) {
        suffix += `; not in metrics: ${hs.unmatchedHosts.join(', ')}`;
      }
    } else if (hs && hs.shape) {
      suffix = ` — host-status shape "${hs.shape}", queued/errored stay null`;
    } else {
      suffix = ' — host-status unavailable, queued/errored stay null';
    }
    console.log(`[poller] metrics: ${snapshot.hosts.length} hosts polled at ${polledAt}${suffix}`);
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
  // Echoed for the same reason as IRIS_BASE_PATH: it is a URL that can be silently
  // wrong, and its failure mode is queued/errored staying null rather than an error.
  console.log(`[poller] host-status: ${IRIS_HOSTSTATUS_PATH
    ? IRIS_HOSTSTATUS_PATH + ' (per-host queued/errored)'
    : 'DISABLED — queued/errored will be null on every host'}`);

  // Run immediately on startup, then on interval.
  pollMetrics();
  pollAlerts();

  setInterval(pollMetrics, METRICS_INTERVAL);
  setInterval(pollAlerts, ALERTS_INTERVAL);
}

module.exports = { startPoller, irisGet, pollMetrics, pollAlerts, pollHostStatus };
