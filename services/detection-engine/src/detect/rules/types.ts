/**
 * Rule contract.
 *
 * A rule is a PURE function of (sample, baseline, config). No I/O, no clock reads —
 * time is passed in. That is what makes all eight testable against fixtures with
 * neither IRIS nor a proxy running.
 */

import type { BaselineStore } from '../../baseline/window.ts';
import type { ThresholdConfig } from '../../config/thresholds.ts';
import type { FindingType, Host, Severity } from '../../types/healthscan.ts';
import type { ProxyAlert } from '../../types/proxy.ts';

/** What a rule sees for one host on one poll. */
export interface RuleInput {
  /** The host as it will appear in the API, already normalized. */
  host: Host;
  /** Errors observed per minute, derived from the cumulative counter across samples. */
  errorsPerMinute: number | null;
  /**
   * The RAW nullable values, before normalization collapsed them for the wire.
   *
   * A rule must be able to tell "measured zero" from "not measurable on this host", and
   * `Host` cannot express the difference: `contracts/healthscan.schema.json` declares
   * `queued` and `errored` as required integers, so `normalizeHost()` turns null into 0.
   *
   * Reading `Host` instead produced two real defects, both found by Dev C on #33:
   *   - a null `messagesPerSec` became 0 and fired `throughput_drop` reporting a 100%
   *     collapse of a healthy production
   *   - a null `queued` became 0, so `stalled_host`'s `requiresQueued` gate was never
   *     satisfied and the rule was silently switched off live
   *
   * Rules that care about absence read these; rules that only care about magnitude may
   * keep using `host`.
   */
  raw: RawHostMetrics;
  baselines: BaselineStore;
  config: ThresholdConfig;
  /** Poll time, epoch ms. Passed in so rules stay pure. */
  now: number;
}

/** The proxy's values as sent, where null means "IRIS does not expose this per host". */
export interface RawHostMetrics {
  queued: number | null;
  messagesPerSec: number | null;
  errored: number | null;
  avgProcessingTime: number | null;
  avgQueueingTime: number | null;
  /**
   * Seconds since this host last did work, as IRIS reports it. `null` when no
   * `iris_interop_last_activity` line was emitted for the host — i.e. it has not run
   * since production start, which is NOT the same as "active now" (#58).
   *
   * `Host.lastActivity` on the wire cannot carry that distinction: the published field is
   * a required non-nullable date-time, so normalizeHost() has to put something there. A
   * rule that reasons about idleness must read THIS instead.
   */
  lastActivityElapsedSeconds: number | null;
}

/**
 * A rule's verdict for one host. `null` means "not breaching" — which is as
 * important as breaching, because it is what clears an existing finding.
 */
export interface RuleVerdict {
  type: FindingType;
  severity: Severity;
  currentValue: number;
  /** null while the baseline is warming up. Absolute rules report null too. */
  baselineValue: number | null;
  /** Authoritative text. Must state the actual numbers — Dev C renders it verbatim. */
  message: string;
}

/** An input a rule reads: a raw proxy metric, or the rate derived across polls. */
export type RuleInputKey = keyof RawHostMetrics | 'errorsPerMinute';

export interface Rule {
  readonly type: FindingType;
  /** True when this rule needs no baseline. Only dead_host and system_alert. */
  readonly absolute: boolean;
  /**
   * The inputs this rule declines to evaluate without — the ones whose `=== null` guard
   * returns null from `evaluate`.
   *
   * `evaluate` returns ONE undifferentiated null for two different answers: "not
   * breaching" and "cannot tell". The comment on RuleVerdict below is only true of the
   * first. The registry reads an absent verdict as a clear, so an unmeasurable poll
   * silently retracted a finding that was still true — the same conflation #33 and #49
   * fixed INSIDE the rules, still present in what the rules' silence means.
   *
   * Declared rather than inferred because the difference is not visible from the outside.
   * Keep this in step with the `=== null` guards in evaluate(); a rule that guards on an
   * input it does not list will still flap.
   */
  readonly requires: readonly RuleInputKey[];
  evaluate(input: RuleInput): RuleVerdict | null;
}

/** Alert-driven rules see the production's alerts rather than a single host. */
export interface AlertRuleInput {
  alerts: readonly ProxyAlert[];
  /** Alert timestamps already reported, so only new ones fire. */
  seen: ReadonlySet<string>;
  config: ThresholdConfig;
  now: number;
}

/** Pick a severity from ratio bands. Higher ratio is worse. */
export function severityFromRatio(
  ratio: number,
  bands: { warning: number; critical: number },
): Severity {
  if (ratio >= bands.critical) return 'critical';
  if (ratio >= bands.warning) return 'warning';
  return 'info';
}

/** Pick a severity where a LOWER value is worse, e.g. throughput as a fraction. */
export function severityFromFraction(
  fraction: number,
  bands: { warning: number; critical: number },
): Severity {
  if (fraction <= bands.critical) return 'critical';
  if (fraction <= bands.warning) return 'warning';
  return 'info';
}

/** Format a ratio the way the contract's sample messages do: "32x", "5.1x". */
export function formatRatio(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}x` : `${ratio.toFixed(1)}x`;
}

/** Sub-second durations read better as milliseconds, matching the dashboard. */
export function formatDuration(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(2)}s`;
}
