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
  baselines: BaselineStore;
  config: ThresholdConfig;
  /** Poll time, epoch ms. Passed in so rules stay pure. */
  now: number;
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

export interface Rule {
  readonly type: FindingType;
  /** True when this rule needs no baseline. Only dead_host and system_alert. */
  readonly absolute: boolean;
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
