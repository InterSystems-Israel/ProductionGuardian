'use strict';

/**
 * parser.js — Prometheus text format → structured per-host JS objects.
 *
 * Handles the 8 IRIS interop metric families Health Scan requires:
 *
 *   iris_interop_hosts              — host status (Inactive/Error/Active)
 *   iris_interop_queued             — queue depth per host
 *   iris_interop_messages_per_sec   — throughput per host
 *   iris_interop_messages_errored   — error count per host
 *   iris_interop_avg_processing_time — avg processing time (ms) per host
 *   iris_interop_avg_queueing_time  — avg queue wait time (ms) per host
 *   iris_last_activity              — Unix timestamp of last activity per host
 *   iris_system_alerts_new          — count of new system alerts
 *
 * Prometheus text format reference:
 *   https://prometheus.io/docs/instrumenting/exposition_formats/#text-format-details
 *
 * Key rules this parser handles:
 *   - Lines starting with # are comments or TYPE/HELP declarations → skip
 *   - Each metric line is:  metric_name{label="value",...} numeric_value [timestamp]
 *   - Label values are double-quoted; labels are comma-separated
 *   - NaN and +Inf/-Inf are valid values → converted to null
 */

/**
 * Regex to parse a single Prometheus metric line.
 * Groups: (1) metric name, (2) labels block (may be empty), (3) value, (4) optional timestamp
 */
const LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([\S]+)(?:\s+(\d+))?$/;
const LINE_NO_LABELS_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+([\S]+)(?:\s+(\d+))?$/;

/**
 * Parse a single label string "key1="val1",key2="val2"" into {key1: 'val1', key2: 'val2'}.
 * @param {string} labelsStr
 * @returns {Object}
 */
function parseLabels(labelsStr) {
  const labels = {};
  if (!labelsStr || !labelsStr.trim()) return labels;
  // Match key="value" pairs; values may contain escaped quotes.
  const labelRe = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = labelRe.exec(labelsStr)) !== null) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return labels;
}

/**
 * Parse a Prometheus float string to a JS number (or null for NaN/Inf).
 * @param {string} str
 * @returns {number|null}
 */
function parseValue(str) {
  if (str === 'NaN' || str === '+Inf' || str === '-Inf') return null;
  const v = parseFloat(str);
  return isNaN(v) ? null : v;
}

/**
 * Parse Prometheus text format body into a raw array of metric objects.
 * @param {string} body — raw text from /api/monitor/metrics
 * @returns {Array<{name: string, labels: Object, value: number|null}>}
 */
function parsePrometheusText(body) {
  const results = [];
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Try with-labels form first.
    let m = LINE_RE.exec(trimmed);
    if (m) {
      results.push({ name: m[1], labels: parseLabels(m[2]), value: parseValue(m[3]) });
      continue;
    }
    // Try no-labels form.
    m = LINE_NO_LABELS_RE.exec(trimmed);
    if (m) {
      results.push({ name: m[1], labels: {}, value: parseValue(m[2]) });
    }
  }
  return results;
}

/**
 * The metric families we care about, mapped to the field name they populate
 * on the per-host output object.  The value at polledAt is ISO 8601 UTC.
 */
const METRIC_MAP = {
  iris_interop_hosts:               'status',               // value: 1 for active; label: status="Active"|"Inactive"|"Error"
  iris_interop_queued:              'queued',               // integer queue depth
  iris_interop_messages_per_sec:    'messagesPerSec',       // float
  iris_interop_messages_errored:    'errored',              // integer
  iris_interop_avg_processing_time: 'avgProcessingTime',    // float, seconds or ms depending on IRIS version
  iris_interop_avg_queueing_time:   'avgQueueingTime',      // float
  iris_last_activity:               'lastActivityTs',       // Unix timestamp (seconds)
  iris_system_alerts_new:           null,                   // scalar, not per-host; stored separately
};

/**
 * Convert raw parsed metrics into the per-host object array required by
 * the proxy JSON contract (contracts/proxy-schema.json).
 *
 * Output shape per host:
 * {
 *   host: string,
 *   type: string,          // "service" | "process" | "operation" (from iris_interop_hosts label)
 *   status: string,        // "Active" | "Inactive" | "Error" | "Unknown"
 *   queued: number,
 *   messagesPerSec: number,
 *   errored: number,
 *   avgProcessingTime: number,
 *   avgQueueingTime: number,
 *   lastActivity: string,  // ISO 8601 UTC, or null
 *   _meta: { polledAt: string }  // ISO timestamp of this snapshot
 * }
 *
 * @param {Array} rawMetrics — output of parsePrometheusText()
 * @param {string} [polledAt] — ISO timestamp; defaults to now
 * @returns {{ hosts: Array, systemAlertsNew: number|null, _meta: Object }}
 */
function buildSnapshot(rawMetrics, polledAt) {
  const ts = polledAt || new Date().toISOString();
  const hostMap = {};  // key: host name → accumulated fields

  let systemAlertsNew = null;

  for (const { name, labels, value } of rawMetrics) {
    if (!(name in METRIC_MAP)) continue;  // not a metric we track

    if (name === 'iris_system_alerts_new') {
      if (value !== null) systemAlertsNew = value;
      continue;
    }

    // All remaining metrics are per-host; the host label is 'name' in IRIS SAM.
    const hostName = labels['name'] || labels['host'] || labels['id'] || '(unknown)';
    if (!hostMap[hostName]) {
      hostMap[hostName] = {
        host: hostName,
        type: _hostType(labels),
        status: 'Unknown',
        queued: 0,
        messagesPerSec: 0,
        errored: 0,
        avgProcessingTime: 0,
        avgQueueingTime: 0,
        lastActivity: null,
      };
    }

    const field = METRIC_MAP[name];
    if (name === 'iris_interop_hosts') {
      // Status is carried as a label, not the numeric value.
      hostMap[hostName].status = labels['status'] || (value === 1 ? 'Active' : 'Inactive');
    } else if (name === 'iris_last_activity') {
      // Convert Unix epoch seconds to ISO 8601 string.
      if (value !== null) {
        hostMap[hostName].lastActivity = new Date(value * 1000).toISOString();
        hostMap[hostName].lastActivityTs = value;
      }
    } else {
      if (value !== null) hostMap[hostName][field] = value;
    }
  }

  const hosts = Object.values(hostMap).map(h => {
    delete h.lastActivityTs;  // internal; not in contract
    return h;
  });

  return {
    hosts,
    systemAlertsNew,
    _meta: { polledAt: ts },
  };
}

/**
 * Derive the host type ('service'|'process'|'operation'|'unknown') from labels.
 * IRIS SAM uses a 'type' label on iris_interop_hosts.
 */
function _hostType(labels) {
  const raw = (labels['type'] || '').toLowerCase();
  if (raw === 'bs' || raw === 'service') return 'service';
  if (raw === 'bp' || raw === 'process') return 'process';
  if (raw === 'bo' || raw === 'operation') return 'operation';
  return 'unknown';
}

module.exports = { parsePrometheusText, buildSnapshot, parseLabels, parseValue };
