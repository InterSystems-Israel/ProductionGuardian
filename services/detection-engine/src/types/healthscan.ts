/**
 * Direct transcription of contracts/healthscan.d.ts — the contract we own and publish.
 *
 * Do not drift from it. A change here without a corresponding PR to contracts/ breaks
 * Dev C, who builds against those exact bytes.
 */

export type Severity = 'info' | 'warning' | 'critical';

/**
 * Host status as reported by IRIS. There is no 'Warning' — verified against IRIS
 * source (Ens.MonitorService, Ens.Job, Ens.Director, Ens.BusinessOperation).
 * 'Disabled' comes from Ens.Util.Statistics:EnumerateHostStatus rather than the metric.
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

export type FindingType =
  | 'dead_host'
  | 'stalled_host'
  | 'queue_buildup'
  | 'elevated_error_rate'
  | 'slow_processing'
  | 'growing_queue_wait'
  | 'throughput_drop'
  | 'system_alert';

/** Advisory engine state, sent as the X-Healthscan-State response header. */
export type HealthScanState = 'ok' | 'warming' | 'stale';

export interface Host {
  host: string;
  /** 'service' | 'process' | 'operation'. IRIS 'actor' is normalized to 'process'. */
  type: string;
  status: HostStatus;
  queued: number;
  messagesPerSec: number;
  errored: number;
  /** Seconds. Aggregated across message types, weighted by sample count. */
  avgProcessingTime: number;
  /** Seconds. Aggregated across message types, weighted by sample count. */
  avgQueueingTime: number;
  /** ISO 8601 UTC, Z-suffixed. */
  lastActivity: string;
}

export interface Finding {
  id: string;
  host: string;
  type: FindingType;
  severity: Severity;
  currentValue: number;
  /** null while the rolling baseline is warming up. */
  baselineValue: number | null;
  detectedAt: string;
  /** Authoritative human-readable text. Dev C renders it verbatim. */
  message: string;
}

export type HostsResponse = Host[];
export type FindingsResponse = Finding[];

/** The eight finding types, for iteration and validation. */
export const FINDING_TYPES: readonly FindingType[] = [
  'dead_host',
  'stalled_host',
  'queue_buildup',
  'elevated_error_rate',
  'slow_processing',
  'growing_queue_wait',
  'throughput_drop',
  'system_alert',
] as const;

/**
 * Host statuses that mean the host is not doing work. Drives dead_host.
 * 'Retry' is deliberately excluded — a retrying host is degraded but alive, and
 * flagging it as dead would be wrong.
 */
export const DEAD_STATUSES: readonly string[] = [
  'Error',
  'Inactive',
  'Stopped',
  'Disabled',
] as const;

/** Severity ordering, most severe first. Used for the findings sort tiebreak. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
