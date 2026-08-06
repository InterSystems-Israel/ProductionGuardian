/**
 * Direct transcription of the Health Scan API contract.
 *
 * Source of record: `contracts/healthscan.d.ts` and `contracts/healthscan-api.md`,
 * published by Dev B. §4 of that document answers all twelve of the Day-1
 * questions, so the `CONTRACT-Q` markers that used to sit here are resolved.
 *
 * Never add a field here to make a component compile — that is a contract
 * change request to Dev B.
 */

export type Severity = 'info' | 'warning' | 'critical';

/**
 * The IRIS host statuses, read from IRIS source rather than inferred (contract §4 Q1).
 *
 * There is no `Warning` — an early assumption that turned out not to exist. A
 * host with a problem still reports `OK`; the *finding* is what signals trouble,
 * which is why the host card takes its severity border from findings, not status.
 * `Disabled` comes from `EnumerateHostStatus` rather than the metric.
 */
export type HostStatus =
  | 'OK'
  | 'Error'
  | 'Inactive'
  | 'Retry'
  | 'Stopped'
  | 'Unconfigured'
  | 'Disabled';

/** The eight snake_case names, confirmed unchanged (contract §2.1, §4 Q2). */
export type FindingType =
  | 'dead_host' // iris_interop_hosts status Inactive/Error
  | 'stalled_host' // iris_last_activity stale while queued
  | 'queue_buildup' // iris_interop_queued
  | 'elevated_error_rate' // iris_interop_messages_errored
  | 'slow_processing' // iris_interop_avg_processing_time
  | 'growing_queue_wait' // iris_interop_avg_queueing_time
  | 'throughput_drop' // iris_interop_messages_per_sec
  | 'system_alert'; // /api/monitor/alerts

export interface Host {
  host: string;
  // 'service' | 'process' | 'operation' — an open string. IRIS says `actor` for
  // business processes; Dev B normalizes it to `process` before it reaches us (Q10).
  type: string;
  status: HostStatus;
  queued: number;
  messagesPerSec: number;
  errored: number;
  // Seconds, confirmed empirically (Q6). Aggregated across message types,
  // weighted by sample count, so a host handling two types reports the weighted
  // mean rather than either one (Q12).
  avgProcessingTime: number;
  avgQueueingTime: number;
  /** ISO 8601 UTC. Derived from elapsed seconds, so accurate to ±10s (Q11). */
  lastActivity: string;
}

export interface Finding {
  id: string;
  host: string;
  type: FindingType;
  severity: Severity;
  currentValue: number;
  /** null while the rolling baseline is still warming up (Q3). Render as `—`. */
  baselineValue: number | null;
  detectedAt: string; // ISO 8601 UTC
  message: string; // human-readable; render as-is, never reconstructed
}

/**
 * What the guards actually hand to the UI. `status` and `type` widen to string
 * because the contract will drift mid-sprint and an unrecognized value must
 * render neutrally rather than crash (§2.4). Components narrow via the helpers
 * in `lib/`, never by casting.
 */
export interface HostView extends Omit<Host, 'status'> {
  status: HostStatus | string;
}

export interface FindingView extends Omit<Finding, 'type' | 'severity'> {
  type: FindingType | string;
  severity: Severity | string;
}

/** One scenario fixture for demo mode. See `fixtures/README.md`. */
export interface Scenario {
  /** Slug matching the filename, e.g. `queue-buildup` for `?scenario=`. */
  id: string;
  label: string;
  /** Presenter-facing note; also feeds the cue sheet. */
  note: string;
  hosts: ScenarioHost[];
  findings: ScenarioFinding[];
}

/*
 * Fixtures store an age in seconds rather than an absolute timestamp: hard-coded
 * dates make the demo read "3 weeks ago" the day after rehearsal (§5).
 * `mockClient` resolves these against load time into contract-shaped ISO
 * strings, so the guards see exactly what the live API would produce.
 */

export interface ScenarioHost extends Omit<Host, 'lastActivity'> {
  lastActivitySecondsAgo: number;
}

export interface ScenarioFinding extends Omit<Finding, 'detectedAt'> {
  detectedSecondsAgo: number;
}
