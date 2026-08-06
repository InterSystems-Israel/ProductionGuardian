/**
 * Direct transcription of the Health Scan API contract.
 *
 * Source of record: `apps/dashboard/CLAUDE.md` §2.3, which matches §5 of
 * `docs/production-guardian-healthscan-mvp1.docx`. Dev B has not yet merged
 * `contracts/healthscan.d.ts`; when they do, reconcile every `CONTRACT-Q` site
 * in this directory against it.
 *
 * Never add a field here to make a component compile — that is a contract
 * change request to Dev B.
 */

export type Severity = 'info' | 'warning' | 'critical';

/** CONTRACT-Q1: exact set unconfirmed. Assumed OK | Warning | Error | Inactive. */
export type HostStatus = 'OK' | 'Warning' | 'Error' | 'Inactive';

/** CONTRACT-Q2: the eight snake_case names, unconfirmed with Dev B. */
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
  type: string; // 'service' | 'process' | 'operation' — treat as an open string
  status: HostStatus;
  queued: number;
  messagesPerSec: number;
  errored: number;
  avgProcessingTime: number; // CONTRACT-Q6: seconds (schema shows 0.08)
  avgQueueingTime: number; // CONTRACT-Q6: seconds
  lastActivity: string; // ISO 8601 UTC
}

export interface Finding {
  id: string;
  host: string;
  type: FindingType;
  severity: Severity;
  currentValue: number;
  /** CONTRACT-Q3: assumed null while the rolling baseline is still warming up. */
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
