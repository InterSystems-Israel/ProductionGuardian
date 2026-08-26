'use strict';

/**
 * parser.js — Prometheus text format → structured per-host JS objects.
 *
 * Handles the 8 IRIS interop metric families Health Scan requires. Names, labels and
 * units below are verified against a real capture from a live LABDEMO production
 * (issue #10) — an earlier version of this file encoded what IRIS was expected to
 * emit, and disagreed with it in six places:
 *
 *   iris_interop_hosts               — status via a `status` LABEL (OK/Error/Inactive/
 *                                      Retry/Stopped/Unconfigured/Disabled). No `type`.
 *   iris_interop_queued              — PER PRODUCTION ONLY; carries no host label
 *   iris_interop_messages            — cumulative message count per host
 *   iris_interop_messages_per_sec    — throughput per host
 *   iris_interop_messages_errored    — cumulative error count per host
 *   iris_interop_avg_processing_time — SECONDS; one series per (host, messagetype)
 *   iris_interop_avg_queueing_time   — SECONDS; one series per (host, messagetype)
 *   iris_interop_last_activity       — ELAPSED SECONDS since last activity
 *   iris_system_alerts_new           — count of new system alerts (scalar)
 *
 * The host label is `host` and holds a display name with spaces ("EMR Source").
 * `id` is the namespace, NOT a host — treating it as one invented a phantom host.
 *
 * ── ABSENT IS NOT ZERO ───────────────────────────────────────────────────────
 * A second live capture (Dev A's own instance, 2026-08-11, fixtures/metrics-live-capture.txt)
 * showed that IRIS emits FAR less than the family list above implies. On an idle
 * production it emitted no `iris_interop_messages_errored` and no
 * `iris_interop_last_activity` AT ALL — not zero-valued lines, no lines.
 *
 * The `avg_*` families are sparser still: they appeared for exactly ONE of thirteen
 * hosts, because IRIS only emits them for a host that has actually processed
 * something since stats were enabled.
 *
 * So every numeric per-host field starts as `null`, meaning "IRIS reported no series".
 * `0` means IRIS measured zero. Defaulting to `0` (the previous behaviour) made an
 * absent metric indistinguishable from a real zero, which is fabricated data: it let
 * `errored: 0` look like a measurement on a build where the metric does not exist,
 * so `elevated_error_rate` could never fire and nothing would say why.
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
 * on the per-host output object.
 *
 * Names and labels verified against a real 1249-line /api/monitor/metrics capture
 * from a live LABDEMO production (issue #10). Two families were wrong before that:
 * `iris_last_activity` does not exist (it is `iris_interop_last_activity`, and it
 * holds ELAPSED SECONDS, not a Unix timestamp), and `iris_interop_queued` carries
 * no per-host label at all.
 *
 * Units are SECONDS throughout — confirmed empirically, not assumed: a host
 * configured with 0.05s latency reports `.05`.
 */
const METRIC_MAP = {
  iris_interop_hosts:               'status',               // status carried as a label; the value is not the status
  iris_interop_messages:            'messages',            // integer, cumulative; present when messages_per_sec is
  iris_interop_messages_per_sec:    'messagesPerSec',       // float
  iris_interop_messages_errored:    'errored',              // integer, cumulative; ABSENT on an idle production
  iris_interop_avg_processing_time: 'avgProcessingTime',    // seconds; multi-series per messagetype
  iris_interop_avg_queueing_time:   'avgQueueingTime',      // seconds; multi-series per messagetype
  iris_interop_last_activity:       'lastActivityElapsedSeconds',  // SECONDS SINCE last activity; ABSENT on 2024.1
};

/**
 * The two `avg_*` families are emitted once per (host, messagetype), so a host
 * handling two message types produces two series. They must be averaged weighted
 * by `iris_interop_sample_count` — a plain mean is wrong when one message type
 * dominates, and last-write-wins (the previous behaviour) is wrong always.
 */
const WEIGHTED_FAMILIES = new Set([
  'iris_interop_avg_processing_time',
  'iris_interop_avg_queueing_time',
]);

/** Per-production scalars: real, but not per-host. Never let these invent a host. */
const SCALAR_FAMILIES = new Set([
  'iris_interop_queued',    // per-production only; per-host depth needs EnumerateHostStatus
  'iris_system_alerts_new',
  'iris_system_alerts_log',
]);

/**
 * Framework hosts IRIS runs inside every production. They are real hosts and their
 * metrics are real, but they are not application components and must not reach the
 * dashboard as findings.
 *
 * Live captures are why this lives here rather than only downstream: on both the
 * 2026-08-11 morning capture (13 hosts) and the afternoon one after the production was
 * renamed (12 hosts), NINE hosts were framework — Ens.Actor, Ens.Alarm,
 * Ens.MonitorService, Ens.ScheduleHandler, Ens.ScheduleService, three
 * EnsLib.Background.* hosts, and the activity reporter. Three quarters of what IRIS
 * reports is plumbing.
 *
 * Matching is on the `Ens.`/`EnsLib.` prefix of the host label. Two traps:
 *
 *   1. `Ens.MonitorService` is the ONLY host with avg_* series in either capture, so an
 *      unfiltered snapshot reports framework timings as though they were application
 *      latency — the one host with data is the one host nobody asked about.
 *   2. The activity reporter's item name has been BOTH `ActivityReporter` (no prefix,
 *      caught by nothing) and `Ens.Activity.Operation.Local` (caught by the prefix
 *      rule). The metric label carries the ITEM name, not the class name, so the
 *      prefix rule alone was never enough. The bare spelling stays listed explicitly:
 *      it costs one Set entry, and any instance still running the older production
 *      definition would otherwise show a framework host as an application component.
 *
 * Kept as a proxy-side flag (`isFramework`) rather than a deletion — dropping hosts
 * here would hide them from Dev B with no way to ask why. Dev B filters on the flag.
 */
const FRAMEWORK_PREFIXES = ['Ens.', 'EnsLib.'];
const FRAMEWORK_ITEM_NAMES = new Set(['ActivityReporter']);

/**
 * True when a host is an IRIS framework item rather than an application component.
 * @param {string} hostName — the `host` label value (an item name, not a class name)
 * @returns {boolean}
 */
function isFrameworkHost(hostName) {
  if (FRAMEWORK_ITEM_NAMES.has(hostName)) return true;
  return FRAMEWORK_PREFIXES.some(p => hostName.startsWith(p));
}

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
  const polledAtMs = Date.parse(ts);
  const hostMap = {};   // key: host name → accumulated fields
  // host name -> field -> { sum, weight }. Nested rather than a joined string
  // key: real host names contain spaces ("EMR Source"), so any delimiter is unsafe.
  const weighted = {};

  let systemAlertsNew = null;
  let systemAlertsLog = null;
  let productionQueued = null;
  let production = null;

  // Pre-pass: iris_interop_sample_count is its own metric family, emitted once per
  // (host, messagetype) alongside the avg_* series rather than as a label on them.
  // It has to be indexed before the main loop, because the avg_* line for a given
  // messagetype may arrive before its matching sample_count line.
  const sampleCounts = new Map();
  for (const { name, labels, value } of rawMetrics) {
    if (name !== 'iris_interop_sample_count' || value === null) continue;
    const h = labels['host'] || labels['name'];
    if (!h) continue;
    // JSON key rather than a joined string: both parts can contain spaces and dots.
    sampleCounts.set(JSON.stringify([h, labels['messagetype'] || '']), value);
  }

  for (const { name, labels, value } of rawMetrics) {
    // Track the production name where IRIS offers it; it is the same on every line.
    if (production === null && labels['production']) production = labels['production'];

    if (SCALAR_FAMILIES.has(name)) {
      if (value === null) continue;
      if (name === 'iris_system_alerts_new') systemAlertsNew = value;
      else if (name === 'iris_system_alerts_log') systemAlertsLog = value;
      else productionQueued = value;
      continue;
    }

    if (!(name in METRIC_MAP)) continue;  // not a metric we track

    // Real IRIS labels the host `host`; there is no `name` label. `id` is the
    // namespace ("LABDEMO"), so falling back to it invented a phantom host from
    // every per-production line — which then tripped dead_host downstream (#10).
    // No host label means the series is not per-host. Skip it.
    const hostName = labels['host'] || labels['name'];
    if (!hostName) continue;

    if (!hostMap[hostName]) {
      // Every numeric field starts null, not 0. IRIS omits whole families rather than
      // emitting zeros (see the header note), and `0` has to keep meaning "measured
      // zero" or every comparative rule downstream reasons about invented data.
      hostMap[hostName] = {
        host: hostName,
        type: 'unknown',
        status: 'Unknown',
        isFramework: isFrameworkHost(hostName),
        queued: null,
        messages: null,
        messagesPerSec: null,
        errored: null,
        avgProcessingTime: null,
        avgQueueingTime: null,
        lastActivity: null,
        lastActivityElapsedSeconds: null,
      };
    }
    const host = hostMap[hostName];

    // `hosttype` rides on the avg_* families rather than iris_interop_hosts, so
    // take it wherever it appears and never downgrade a known type to unknown.
    const derivedType = _hostType(labels);
    if (derivedType !== 'unknown') host.type = derivedType;

    if (value === null) continue;
    const field = METRIC_MAP[name];

    if (name === 'iris_interop_hosts') {
      // Status is a label. The old `value === 1 ? 'Active' : 'Inactive'` fallback
      // invented a value outside the real enum (OK | Error | Inactive | Retry |
      // Stopped | Unconfigured | Disabled) — pass through, or leave Unknown.
      if (labels['status']) host.status = labels['status'];
    } else if (name === 'iris_interop_last_activity') {
      // Elapsed seconds since last activity — NOT an epoch timestamp.
      host.lastActivityElapsedSeconds = value;
      host.lastActivity = new Date(polledAtMs - value * 1000).toISOString();
    } else if (WEIGHTED_FAMILIES.has(name)) {
      // Defer: needs every series for this host before it can be averaged.
      // A missing sample count means weight 1, so a host IRIS reports no counts for
      // still yields a plain mean rather than dropping out of the snapshot.
      const w = sampleCounts.get(JSON.stringify([hostName, labels['messagetype'] || ''])) ?? 1;
      if (!weighted[hostName]) weighted[hostName] = {};
      if (!weighted[hostName][field]) weighted[hostName][field] = { sum: 0, weight: 0 };
      weighted[hostName][field].sum += value * w;
      weighted[hostName][field].weight += w;
    } else {
      host[field] = value;
    }
  }

  // Resolve the weighted averages now that every series has been seen.
  for (const [hostName, fields] of Object.entries(weighted)) {
    for (const [field, { sum, weight }] of Object.entries(fields)) {
      if (hostMap[hostName] && weight > 0) hostMap[hostName][field] = sum / weight;
    }
  }

  // Stable alphabetical order by host, matching the findings API convention so
  // the dashboard never reorders rows between polls.
  const hosts = Object.values(hostMap).sort((a, b) => a.host.localeCompare(b.host));

  // Which per-host families this IRIS actually emitted. Without this, a build that
  // omits `messages_errored` entirely is indistinguishable from a production with no
  // errors, and `elevated_error_rate` silently never fires with nothing to point at.
  // Reported rather than worked around: the proxy cannot conjure a family IRIS lacks.
  const seenFamilies = new Set(rawMetrics.map(m => m.name));
  const absentFamilies = Object.keys(METRIC_MAP).filter(f => !seenFamilies.has(f));

  return {
    hosts,
    // Unread alerts. Consume-on-read: reading /api/monitor/alerts drives this to 0,
    // so on a proxy that polls alerts it reads 0 nearly always. See src/cache.js.
    systemAlertsNew,
    // Durable count from alerts.log; does not reset on read.
    systemAlertsLog,
    _meta: {
      polledAt: ts,
      production,
      // Per-production total. Per-host depth is NOT in the Prometheus text — it
      // requires Ens.Util.Statistics:EnumerateHostStatus (issue #12, ADR 0001).
      productionQueued,
      // Diagnostics, not data. Dev B should treat a family listed here as
      // "unmeasurable on this instance", not as a zero.
      absentFamilies,
      hostCount: hosts.length,
      applicationHostCount: hosts.filter(h => !h.isFramework).length,
    },
  };
}

/**
 * Derive the host type ('service'|'process'|'operation'|'unknown') from labels.
 *
 * The label is `hosttype` and it rides on the avg_* families — `iris_interop_hosts`
 * carries no type label at all (its labels are exactly id, status, host, production).
 * IRIS says `actor` where the MVP doc says `process`; we normalize so the published
 * vocabulary is the doc's and the IRIS word never reaches a consumer.
 *
 * `type` and the BS/BP/BO forms are kept only so the hand-written fixture shape and
 * any older capture still resolve rather than silently degrading to 'unknown'.
 *
 * The `business*` forms are the words `Ens.Util.Statistics:EnumerateHostStatus` puts in
 * its `Type` column — `BusinessService`, `BusinessOperation`, `BusinessProcess`, `Actor`
 * — which `hoststatus.js` uses to fill the type for a host the avg_* families never
 * mention (#127). They live HERE, in the one mapping, rather than in a second copy over
 * there: two vocabularies folded in two places is two things to keep in step. This
 * function is exported for that caller and takes a labels-shaped object either way.
 */
function _hostType(labels) {
  const raw = (labels['hosttype'] || labels['type'] || '').toLowerCase();
  if (raw === 'bs' || raw === 'service' || raw === 'businessservice') return 'service';
  // `Actor` is a business process in IRIS — a pooled BP host, not a fourth kind of host.
  if (raw === 'bp' || raw === 'process' || raw === 'actor' || raw === 'businessprocess') return 'process';
  if (raw === 'bo' || raw === 'operation' || raw === 'businessoperation') return 'operation';
  return 'unknown';
}

module.exports = {
  parsePrometheusText,
  buildSnapshot,
  parseLabels,
  parseValue,
  isFrameworkHost,
  _hostType,
};
