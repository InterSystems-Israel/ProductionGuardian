'use strict';

/**
 * alerts.js — normalize /api/monitor/alerts into the shape /proxy/alerts publishes.
 *
 * Split out of poller.js because this is parsing, not I/O, and it needs tests: it is
 * the sole input to the `system_alert` finding type, and the previous inline version
 * could drop a real alert without saying so.
 *
 * ── WHY THIS IS DEFENSIVE ────────────────────────────────────────────────────
 * The metrics text format is pinned by two live captures. The ALERTS payload is not:
 * no capture of `/api/monitor/alerts` exists yet in this repo, so its exact JSON shape
 * is genuinely unverified. IRIS is documented to expose alerts.log contents there, but
 * "documented" is what ADR 0004 warns about — the metrics format was documented too,
 * and disagreed with reality in six places.
 *
 * The old code did `JSON.parse`, then `if (!Array.isArray(alerts)) alerts = []`. If
 * IRIS wraps the list in an object — `{"alerts": [...]}` — that silently published
 * zero alerts on an instance that had some, and `system_alert` could never fire with
 * nothing anywhere saying why. A wrong guess about the shape must degrade loudly.
 *
 * So: accept every plausible shape, and when the shape is unrecognized, say so in
 * `_meta.shape` and keep the payload under `_meta.raw` instead of discarding it. The
 * proxy's job is to forward faithfully, not to decide an unfamiliar payload is empty.
 * The 2026-08-11 capture reports `iris_system_alerts_new 1`, so a live cross-check is
 * available: metrics claiming alerts while this returns none means the shape is wrong.
 */

/** Keys IRIS might plausibly wrap the alert list under. Checked in order. */
const WRAPPER_KEYS = ['alerts', 'Alerts', 'result', 'results', 'content', 'data'];

/**
 * Normalize a parsed /api/monitor/alerts body into { alerts, _meta }.
 *
 * Never throws and never invents an alert. An unrecognized payload yields an empty
 * `alerts` array plus the evidence needed to fix the mapping — not a silent zero.
 *
 * @param {*} body — the raw response body string, or an already-parsed value
 * @param {string} polledAt — ISO timestamp of the poll
 * @returns {{alerts: Array, _meta: Object}}
 */
function normalizeAlerts(body, polledAt) {
  let parsed = body;

  // Accept a string body so callers can hand us the raw response.
  if (typeof body === 'string') {
    const trimmed = body.trim();
    // An empty body is a legitimate "no alerts" answer, not a parse failure.
    if (!trimmed) {
      return { alerts: [], _meta: { polledAt, shape: 'empty', count: 0 } };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      // Unparseable is a real failure and must be visible. Truncate the sample:
      // this ends up in a log line and an alerts.log dump can be very large.
      return {
        alerts: [],
        _meta: {
          polledAt,
          shape: 'unparseable',
          count: 0,
          error: err.message,
          raw: trimmed.slice(0, 500),
        },
      };
    }
  }

  if (parsed === null || parsed === undefined) {
    return { alerts: [], _meta: { polledAt, shape: 'null', count: 0 } };
  }

  // Shape 1: a bare array — what the old code assumed, still supported.
  if (Array.isArray(parsed)) {
    return { alerts: parsed, _meta: { polledAt, shape: 'array', count: parsed.length } };
  }

  if (typeof parsed === 'object') {
    // Shape 2: an object wrapping the array under a known key. This is the case the
    // old code turned into a silent empty list.
    for (const key of WRAPPER_KEYS) {
      if (Array.isArray(parsed[key])) {
        return {
          alerts: parsed[key],
          _meta: { polledAt, shape: `wrapped:${key}`, count: parsed[key].length },
        };
      }
    }

    // Shape 3: an object that IS a single alert. Wrap it rather than lose it.
    // Guarded on recognizable alert-ish keys so an arbitrary object is not promoted
    // into a fabricated alert.
    const ALERT_KEYS = ['text', 'alert', 'message', 'msg', 'severity', 'timestamp', 'time'];
    if (ALERT_KEYS.some(k => k in parsed)) {
      return { alerts: [parsed], _meta: { polledAt, shape: 'single-object', count: 1 } };
    }

    // Unrecognized object: report it, keep it, invent nothing.
    return {
      alerts: [],
      _meta: {
        polledAt,
        shape: 'unrecognized-object',
        count: 0,
        keys: Object.keys(parsed).slice(0, 20),
        raw: parsed,
      },
    };
  }

  // A scalar (number/boolean) is not an alert list under any reading.
  return {
    alerts: [],
    _meta: { polledAt, shape: `unrecognized-${typeof parsed}`, count: 0, raw: parsed },
  };
}

module.exports = { normalizeAlerts, WRAPPER_KEYS };
