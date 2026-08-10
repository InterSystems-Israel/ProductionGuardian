/**
 * Dev A's metrics-proxy output (:3001).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ UNRATIFIED. contracts/proxy-api.md does not exist yet, so this file is    │
 * │ OUR ASSUMPTION of Dev A's shape, not an agreed contract.                  │
 * │                                                                          │
 * │ Every assumption is tagged // PROXY-Q<n>. Reconciling when Dev A lands    │
 * │ their contract must be a grep, not an audit:                             │
 * │     grep -rn "PROXY-Q" src/                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Open questions for Dev A:
 *
 * PROXY-Q1  Are per-host entries an array (assumed) or an object keyed by host name?
 *           And is `status` passed through exactly as IRIS reports it (assumed), or
 *           already normalized?
 *
 * PROXY-Q2  Is `queued` present per host? It is NOT in the Prometheus text —
 *           iris_interop_queued carries no `host` label, only `production`. Per-host
 *           depth requires reading Ens.Util.Statistics:EnumerateHostStatus.
 *           Verified on live LABDEMO: Cloud API = 48 while disabled.
 *           Raised in ADR 0001 and PR #4. THIS ONE BLOCKS queue_buildup.
 *
 * PROXY-Q3  Are avgProcessingTime / avgQueueingTime already aggregated across
 *           messagetype (assumed), or passed through as raw per-messagetype series?
 *           IRIS emits one series per (host, messagetype). If raw, aggregation moves
 *           here and must be weighted by sampleCount — a plain mean is wrong.
 *
 * PROXY-Q4  Is last-activity given as elapsed seconds (assumed — that is what
 *           iris_interop_last_activity holds) or already converted to a timestamp?
 *
 * PROXY-Q5  Are framework hosts (Ens.MonitorService, Ens.Alarm, EnsLib.Testing.*,
 *           Ens.Activity.Operation.Local, …) filtered by the proxy, or do they reach
 *           us? We assume they reach us and filter here — filtering our own side is
 *           safe either way.
 */

/** One host as the proxy reports it. */
export interface ProxyHost {
  /** Config item name, e.g. "Lab Router". */
  name: string;
  /** PROXY-Q1: IRIS vocabulary — 'service' | 'process' | 'actor' | 'operation'. */
  type: string;
  /** PROXY-Q1: raw IRIS status, e.g. 'OK' | 'Error' | 'Inactive' | 'Disabled'. */
  status: string;
  /** PROXY-Q2: per-host queue depth. Requires host-status read, not /metrics. */
  queued: number;
  /** Cumulative messages processed since production start. */
  messages: number;
  messagesPerSec: number;
  messagesErrored: number;
  /** PROXY-Q3: seconds, assumed already aggregated across message types. */
  avgProcessingTime: number;
  /** PROXY-Q3: seconds, assumed already aggregated across message types. */
  avgQueueingTime: number;
  /** PROXY-Q4: seconds since last activity, as iris_interop_last_activity gives it. */
  lastActivityElapsedSeconds: number;
  /** PROXY-Q3: total samples behind the avg* figures. Needed to weight aggregation. */
  sampleCount?: number;
}

/** One entry from /api/monitor/alerts, forwarded by the proxy. */
export interface ProxyAlert {
  /** ISO 8601 timestamp as IRIS emits it. */
  time: string;
  /** IRIS severity is a numeric string ("1", "2", …), not a word. */
  severity: string;
  message: string;
}

/** A complete proxy poll response. */
export interface ProxyResponse {
  /** When the proxy sampled IRIS. ISO 8601. */
  sampledAt: string;
  /** Production name, e.g. "LABDEMO.Production". */
  production: string;
  hosts: ProxyHost[];
  alerts: ProxyAlert[];
}

/** What the engine reads metrics from. Both real and mock clients satisfy it. */
export interface ProxyClient {
  fetchMetrics(signal?: AbortSignal): Promise<ProxyResponse>;
}

/**
 * Framework hosts that must never reach the findings API (PROXY-Q5).
 * Exact names plus prefixes — the Ens.* and EnsLib.* namespaces are IRIS's own.
 */
const FRAMEWORK_HOST_PREFIXES: readonly string[] = ['Ens.', 'EnsLib.'] as const;

/** True when a host is IRIS framework infrastructure rather than an application host. */
export function isFrameworkHost(name: string): boolean {
  return FRAMEWORK_HOST_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Runtime shape validation at the process boundary.
 *
 * Log-and-skip a malformed host rather than rejecting the whole payload: one bad
 * entry should not blind us to the other three hosts.
 */
export function isProxyHost(value: unknown): value is ProxyHost {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h['name'] === 'string' &&
    h['name'].length > 0 &&
    typeof h['type'] === 'string' &&
    typeof h['status'] === 'string' &&
    isFiniteNumber(h['queued']) &&
    isFiniteNumber(h['messages']) &&
    isFiniteNumber(h['messagesPerSec']) &&
    isFiniteNumber(h['messagesErrored']) &&
    isFiniteNumber(h['avgProcessingTime']) &&
    isFiniteNumber(h['avgQueueingTime']) &&
    isFiniteNumber(h['lastActivityElapsedSeconds'])
  );
}

export function isProxyAlert(value: unknown): value is ProxyAlert {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a['time'] === 'string' &&
    typeof a['severity'] === 'string' &&
    typeof a['message'] === 'string'
  );
}

/** NaN and Infinity are not usable metric values, so reject them explicitly. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
