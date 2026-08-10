/**
 * Production Guardian — Health Scan API types.
 *
 * Owner: Dev B. Consumer: Dev C. Contract: ./healthscan-api.md
 *
 * Hand-maintained to match healthscan.schema.json. Do not edit as part of an
 * implementation task — a change here is a contract-change PR.
 */

/** Finding severity. Unknown values from the wire must be treated as 'info'. */
export type Severity = 'info' | 'warning' | 'critical';

/**
 * Host status as reported by IRIS.
 *
 * Note there is no 'Warning' — that was an early assumption and it does not exist.
 * `Disabled` is synthesized when a config item is disabled; the others come
 * straight from the IRIS host monitor.
 *
 * Deliberately a union of literals *plus* string, because the set can grow with
 * an IRIS version and the UI must degrade to neutral rather than break.
 */
export type HostStatus =
  | 'OK'
  | 'Error'
  | 'Inactive'
  | 'Retry'
  | 'Stopped'
  | 'Unconfigured'
  | 'Disabled'
  | (string & {});

/** The eight finding types Health Scan detects. */
export type FindingType =
  | 'dead_host'            // host status Error / Inactive / Stopped / Disabled
  | 'stalled_host'         // iris_interop_last_activity stale while queued
  | 'queue_buildup'        // queue depth vs baseline
  | 'elevated_error_rate'  // iris_interop_messages_errored
  | 'slow_processing'      // iris_interop_avg_processing_time
  | 'growing_queue_wait'   // iris_interop_avg_queueing_time
  | 'throughput_drop'      // iris_interop_messages_per_sec
  | 'system_alert';        // /api/monitor/alerts

/** Advisory engine state, sent as the X-Healthscan-State response header. */
export type HealthScanState = 'ok' | 'warming' | 'stale';

/** One interoperability host. `GET /api/healthscan/hosts` returns Host[]. */
export interface Host {
  /** Config item name exactly as in IRIS. Join key for Finding.host. */
  host: string;
  /** 'service' | 'process' | 'operation'. Open string — IRIS 'actor' is normalized to 'process'. */
  type: string;
  status: HostStatus;
  /** Current queue depth. */
  queued: number;
  messagesPerSec: number;
  /** Cumulative errored count since production start. */
  errored: number;
  /** Seconds. Aggregated across message types, weighted by sample count. */
  avgProcessingTime: number;
  /** Seconds. Aggregated across message types, weighted by sample count. */
  avgQueueingTime: number;
  /** ISO 8601 UTC. Derived from elapsed seconds, so accurate to about the poll interval. */
  lastActivity: string;
}

/** One active finding. `GET /api/healthscan/findings` returns Finding[]. */
export interface Finding {
  /** Stable for the lifetime of the condition — safe as a React key. */
  id: string;
  /** Always exactly equal to some Host.host value. */
  host: string;
  type: FindingType;
  severity: Severity;
  currentValue: number;
  /** null while the rolling baseline is warming up. Render as '—', never 0 or NaN. */
  baselineValue: number | null;
  /** ISO 8601 UTC. When first confirmed after sustained breach, not when last seen. */
  detectedAt: string;
  /** Authoritative human-readable text. Render as-is. */
  message: string;
}

/** `GET /api/healthscan/hosts` — empty array when no hosts, never 404. */
export type HostsResponse = Host[];

/** `GET /api/healthscan/findings` — empty array when none, sorted detectedAt desc. */
export type FindingsResponse = Finding[];
