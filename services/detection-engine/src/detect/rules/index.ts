/**
 * The eight detection rules — MVP §1.3.
 *
 * Two are absolute (dead_host, system_alert): they fire without a baseline.
 * Six are comparative: they stay silent until the baseline is warm (ADR 0002).
 *
 * Every rule is a pure function. Thresholds come from config, never from literals
 * here (ADR 0003).
 */

import { configFor } from '../../config/thresholds.ts';
import { DEAD_STATUSES } from '../../types/healthscan.ts';
import type { Rule, RuleInput, RuleVerdict } from './types.ts';
import {
  formatDuration,
  formatRatio,
  severityFromFraction,
  severityFromRatio,
} from './types.ts';

/**
 * dead_host — absolute. The host is not doing work.
 *
 * 'Retry' is excluded from DEAD_STATUSES on purpose: a retrying host is degraded but
 * alive, and calling it dead would be wrong.
 */
const deadHost: Rule = {
  type: 'dead_host',
  absolute: true,
  evaluate({ host, config }: RuleInput): RuleVerdict | null {
    const rule = configFor(config, 'dead_host', host.host);
    if (!rule.enabled) return null;
    if (!DEAD_STATUSES.includes(host.status)) return null;

    const queueNote = host.queued > 0 ? ` with ${host.queued} message(s) queued` : '';
    return {
      type: 'dead_host',
      severity: rule.severity,
      currentValue: 0,
      baselineValue: null,
      message: `${host.host} is ${host.status}${queueNote}`,
    };
  },
};

/**
 * stalled_host — the host is nominally OK but has stopped moving messages.
 *
 * Absolute in the sense that it needs no baseline, but it is NOT in the absolute set:
 * it requires a queue, so it cannot fire on a legitimately idle host.
 */
const stalledHost: Rule = {
  type: 'stalled_host',
  absolute: true,
  evaluate({ host, raw, config, now }: RuleInput): RuleVerdict | null {
    const rule = configFor(config, 'stalled_host', host.host);
    if (!rule.enabled) return null;

    // A dead host is reported as dead, not stalled — one condition, one finding.
    if (DEAD_STATUSES.includes(host.status)) return null;

    // `requiresQueued` exists to stop an idle-but-empty host reading as stalled. Read the
    // RAW depth: previously this read the normalized Host, where an unmeasurable depth had
    // already become 0, so the gate was never satisfied and the rule was SILENTLY off
    // against live IRIS -- a sixth live break, found by Dev C on #33.
    //
    // Deliberate choice, not an accident: when the depth is unknown we still decline to
    // fire. An idle host with an unknown queue is more likely quiet than hung, and firing
    // on absent data is the false positive MVP §6 names as the top risk. The distinction
    // is now visible in the code rather than an emergent property of a coerced zero.
    if (rule.requiresQueued) {
      if (raw.queued === null) return null;
      if (raw.queued <= 0) return null;
    }

    const idleSeconds = (now - Date.parse(host.lastActivity)) / 1000;
    if (!Number.isFinite(idleSeconds) || idleSeconds < rule.inactiveSeconds) return null;

    return {
      type: 'stalled_host',
      severity: rule.severity,
      currentValue: Math.round(idleSeconds),
      baselineValue: null,
      message:
        `No activity for ${Math.round(idleSeconds)}s while ${host.queued} message(s) are queued`,
    };
  },
};

/**
 * queue_buildup — comparative. Needs BOTH the multiplier and the absolute floor,
 * because 1 -> 5 is 5x baseline and not a problem (ADR 0003).
 */
const queueBuildup: Rule = {
  type: 'queue_buildup',
  absolute: false,
  evaluate({ host, baselines, config }: RuleInput): RuleVerdict | null {
    const rule = configFor(config, 'queue_buildup', host.host);
    if (!rule.enabled) return null;

    const baseline = baselines.baseline(host.host, 'queued');
    if (baseline === null) return null;
    if (host.queued < rule.absoluteFloor) return null;

    // A zero baseline makes any ratio infinite, so treat the floor as the whole test.
    const ratio = baseline > 0 ? host.queued / baseline : Number.POSITIVE_INFINITY;
    if (ratio < rule.baselineMultiplier) return null;

    const severity = Number.isFinite(ratio)
      ? severityFromRatio(ratio, rule.severityBands)
      : 'critical';
    const comparison = Number.isFinite(ratio)
      ? `is ${formatRatio(ratio)} baseline`
      : 'with no baseline queue';

    return {
      type: 'queue_buildup',
      severity,
      currentValue: host.queued,
      baselineValue: baseline,
      message: `Queue depth ${host.queued} ${comparison}`,
    };
  },
};

/**
 * elevated_error_rate — comparative on errors-per-minute rather than the cumulative
 * counter, because the counter only ever rises and would flag forever once it moved.
 */
const elevatedErrorRate: Rule = {
  type: 'elevated_error_rate',
  absolute: false,
  evaluate({ host, errorsPerMinute, baselines, config }: RuleInput): RuleVerdict | null {
    const rule = configFor(config, 'elevated_error_rate', host.host);
    if (!rule.enabled) return null;
    if (errorsPerMinute === null) return null;
    if (errorsPerMinute < rule.errorsPerMinuteFloor) return null;

    const baseline = baselines.baseline(host.host, 'errorsPerMinute');
    if (baseline === null) return null;

    const ratio = baseline > 0 ? errorsPerMinute / baseline : Number.POSITIVE_INFINITY;
    if (ratio < rule.baselineMultiplier) return null;

    const severity = Number.isFinite(ratio)
      ? severityFromRatio(ratio, rule.severityBands)
      : 'critical';
    const rate = errorsPerMinute.toFixed(1);
    const comparison = Number.isFinite(ratio)
      ? `, ${formatRatio(ratio)} baseline`
      : ' against a clean baseline';

    return {
      type: 'elevated_error_rate',
      severity,
      currentValue: Number(rate),
      baselineValue: baseline,
      message: `${rate} errors/min${comparison}`,
    };
  },
};

/** slow_processing and growing_queue_wait share shape — one factory, two metrics. */
function durationRule(
  type: 'slow_processing' | 'growing_queue_wait',
  metric: 'avgProcessingTime' | 'avgQueueingTime',
  label: string,
): Rule {
  return {
    type,
    absolute: false,
    evaluate({ host, baselines, config }: RuleInput): RuleVerdict | null {
      const rule = configFor(config, type, host.host);
      if (!rule.enabled) return null;

      const current = host[metric];
      const baseline = baselines.baseline(host.host, metric);
      if (baseline === null) return null;
      if (current < rule.absoluteFloorSeconds) return null;

      const ratio = baseline > 0 ? current / baseline : Number.POSITIVE_INFINITY;
      if (ratio < rule.baselineMultiplier) return null;

      // A zero baseline makes every ratio infinite, so the multiplier cannot bind and
      // the floor is the entire gate. This branch previously hardcoded `critical`,
      // which meant a host whose normal queue wait is 0 went from silent to critical
      // at the floor with no warning tier -- and lowering the floor to 0.15s made that
      // trigger 150ms of queue wait. MVP §6 names false positives as the top risk.
      //
      // Instead, judge an infinite ratio on absolute magnitude against the floor:
      // `criticalFloorMultiple` x the floor earns `critical`, anything above the floor
      // is a `warning`. That restores a two-tier response for zero-baseline hosts
      // without making the floor itself a critical trigger. Found by Dev C on #20.
      const severity = Number.isFinite(ratio)
        ? severityFromRatio(ratio, rule.severityBands)
        : current >= rule.absoluteFloorSeconds * rule.criticalFloorMultiple
          ? 'critical'
          : 'warning';
      const comparison = Number.isFinite(ratio) ? ` is ${formatRatio(ratio)} baseline` : '';

      return {
        type,
        severity,
        currentValue: current,
        baselineValue: baseline,
        message: `${label} ${formatDuration(current)}${comparison}`,
      };
    },
  };
}

/**
 * throughput_drop — inverted: LOWER is worse.
 *
 * `minBaselineRate` guards the degenerate case. A host whose normal rate is 0.05/sec
 * is too quiet to judge a "drop" against, and would otherwise flag constantly.
 */
const throughputDrop: Rule = {
  type: 'throughput_drop',
  absolute: false,
  evaluate({ host, raw, baselines, config }: RuleInput): RuleVerdict | null {
    const rule = configFor(config, 'throughput_drop', host.host);
    if (!rule.enabled) return null;

    // An UNMEASURABLE rate is not a collapsed one. This rule is the only comparative
    // rule where LOWER is worse, so it is the only one for which a coerced 0 reads as a
    // symptom rather than as "nothing to see" -- every other rule falls under its floor
    // and stays quiet. Without this guard, a null messagesPerSec became 0 and produced
    // "Throughput 0.0 msg/sec is 100% below baseline" against a perfectly healthy
    // production, two polls after the metric went absent (Dev C, #33).
    //
    // Both routes to null are real, not hypothetical. Dev A's parser maps Prometheus
    // NaN/+Inf to null -- and a rate over a zero-length window is NaN, which happens
    // right after a production restart. IRIS also omits whole metric families rather
    // than emitting zeros, which would have made EVERY host report a collapse in the
    // same poll.
    if (raw.messagesPerSec === null) return null;

    const baseline = baselines.baseline(host.host, 'messagesPerSec');
    if (baseline === null) return null;
    if (baseline < rule.minBaselineRate) return null;

    const fraction = host.messagesPerSec / baseline;
    if (fraction > rule.baselineFraction) return null;

    const percentBelow = Math.round((1 - fraction) * 100);
    return {
      type: 'throughput_drop',
      severity: severityFromFraction(fraction, rule.severityBands),
      currentValue: host.messagesPerSec,
      baselineValue: baseline,
      message:
        `Throughput ${host.messagesPerSec.toFixed(1)} msg/sec is ${percentBelow}% below baseline`,
    };
  },
};

/** The seven per-host rules, in the order MVP §1.3 lists them. */
export const HOST_RULES: readonly Rule[] = [
  deadHost,
  stalledHost,
  queueBuildup,
  elevatedErrorRate,
  durationRule('slow_processing', 'avgProcessingTime', 'Average processing time'),
  durationRule('growing_queue_wait', 'avgQueueingTime', 'Average queue wait'),
  throughputDrop,
] as const;
