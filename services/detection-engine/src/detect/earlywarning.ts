/**
 * Early Warning — project a rising metric forward to its threshold.
 *
 * Implements `contracts/earlywarning-api.md`. That contract is authoritative; where this file
 * and the contract disagree, the contract is right and this is a bug.
 *
 * THE CENTRAL RULE, and the reason for the response shape: a projection is not a measurement.
 * Every computed number lives inside `projection`, tagged `kind: 'projection'`; every observed
 * number (`currentValue`, `measuredAt`, `fitSampleCount`, `fitSpanSeconds`, `threshold`) sits
 * outside it. A consumer cannot hold a forecast without also holding the label saying it is one.
 * §1.4 explains why in terms of #58: a derived value published in a slot promising an observed
 * one. "Queue crosses threshold in 4 minutes" is a much more attractive version of that mistake,
 * because it is a sentence an operator will act on.
 *
 * WE DECLINE RATHER THAN GUESS. Seven distinct reasons, in a fixed precedence order, so a mock
 * and the engine agree on which one wins when several apply. There is deliberately no
 * `secondsToThreshold: 0` for an already-crossed queue: zero reads as a measurement of now.
 */

import type { BaselineStore, MetricName, Sample } from '../baseline/window.ts';
import { effectiveBaseline, type ThresholdConfig } from '../config/thresholds.ts';
import type { RawHostMetrics } from './rules/types.ts';

/** Reasons we decline to forecast. Contract §2.1. */
export type ProjectionUnavailableReason =
  | 'disabled'
  | 'metric_unmeasurable'
  | 'warming'
  | 'insufficient_samples'
  | 'already_crossed'
  | 'not_rising'
  | 'beyond_horizon';

export interface Threshold {
  value: number;
  basis: 'absoluteFloor' | 'baselineMultiplier';
  baselineValue: number;
  findingType: string;
}

export interface Projection {
  kind: 'projection';
  basis: string;
  slope: number;
  slopeUnit: string;
  secondsToThreshold: number;
  projectedCrossingAt: string;
  message: string;
}

export interface HostProjection {
  host: string;
  metric: string;
  currentValue: number | null;
  measuredAt: string;
  fitSampleCount: number;
  fitSpanSeconds: number;
  threshold: Threshold | null;
  projection: Projection | null;
  projectionUnavailable: ProjectionUnavailableReason | null;
}

/**
 * MVP 2 projects one metric toward one finding type. Named here rather than inlined so the
 * single-scenario boundary is visible: adding a second is a contract change, not a config edit.
 */
const METRIC: MetricName = 'queued';
const FINDING_TYPE = 'queue_buildup';
const SLOPE_UNIT = 'items/minute';

/**
 * Least-squares slope in units per MILLISECOND, or null when it cannot be fitted.
 *
 * Fitted against real timestamps rather than sample indices. The poll interval is nominal: a
 * slow fetch stretches it and a missed poll leaves a gap, so index-based fitting would produce
 * a slope per sample and then label it per minute.
 *
 * Returns null when every sample shares one timestamp (zero variance in x), which is division
 * by zero rather than a flat line — a distinction worth keeping, since a flat line is
 * `not_rising` and this is "cannot fit".
 */
function fitSlopePerMs(samples: readonly Sample[]): number | null {
  const n = samples.length;
  if (n < 2) return null;

  // Centre x on the first timestamp. Epoch milliseconds squared overflows the precision that
  // matters here, and the slope is translation-invariant, so centring costs nothing.
  const x0 = samples[0]?.at ?? 0;
  let sumX = 0;
  let sumY = 0;
  for (const s of samples) {
    sumX += s.at - x0;
    sumY += s.value;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    const dx = s.at - x0 - meanX;
    sxy += dx * (s.value - meanY);
    sxx += dx * dx;
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

/**
 * The threshold `queue_buildup` would fire at, or null when there is none.
 *
 * Mirrors the rule's own gate: BOTH the absolute floor and the baseline multiplier must be
 * cleared, so the effective threshold is whichever is higher. Computed here rather than read
 * from the rule because the rule answers "is it breaching now" and this needs "what value would
 * breach" — the same numbers, a different question.
 *
 * Resolves the baseline through `effectiveBaseline`, so a configured reference is honoured. That
 * matters: with `referenceBaselines: { "Cloud API": { queued: 0 } }` the multiplier arm is
 * `0 * 5 = 0`, the floor wins, and the threshold is a stable 50 rather than a number that climbs
 * as the queue does. Projecting toward a moving target would be projecting toward the same
 * self-inflation that made the finding unable to fire.
 */
function thresholdFor(
  config: ThresholdConfig,
  host: string,
  baselines: BaselineStore,
): Threshold | null {
  const rule = config.rules.queue_buildup;
  if (rule === undefined) return null;

  const baseline = effectiveBaseline(config, host, METRIC, baselines.baseline(host, METRIC));
  if (baseline === null) return null;

  const fromMultiplier = baseline * rule.baselineMultiplier;
  const value = Math.max(rule.absoluteFloor, fromMultiplier);
  return {
    value,
    basis: fromMultiplier > rule.absoluteFloor ? 'baselineMultiplier' : 'absoluteFloor',
    baselineValue: baseline,
    findingType: FINDING_TYPE,
  };
}

function isoSeconds(ms: number): string {
  return `${new Date(Math.round(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** `4 min`, `45 s` — for the message only. Whole units: a projected ETA to the second is false precision. */
function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Project one host's metric. `raw` supplies the measured value, so an unmeasurable metric is
 * distinguishable from a measured zero — the #33/#58 rule applied here rather than re-derived.
 */
export function projectHost(
  host: string,
  raw: RawHostMetrics,
  baselines: BaselineStore,
  config: ThresholdConfig,
  now: number,
): HostProjection {
  const ew = config.earlyWarning;
  const samples = baselines.recent(host, METRIC, now, ew.fitWindowSeconds * 1000);
  const first = samples[0];
  const last = samples.at(-1);

  const currentValue = raw.queued;
  // measuredAt is the SAMPLE's clock, not the request clock (contract EW-Q3). Falling back to
  // `now` only when there is no sample at all, in which case there is nothing to project and the
  // timestamp is not load-bearing.
  const measuredAt = isoSeconds(last?.at ?? now);
  const fitSampleCount = samples.length;
  const fitSpanSeconds =
    first !== undefined && last !== undefined && fitSampleCount >= 2
      ? Math.round((last.at - first.at) / 1000)
      : 0;

  const base = {
    host,
    metric: METRIC as string,
    currentValue,
    measuredAt,
    fitSampleCount,
    fitSpanSeconds,
  };

  const decline = (
    reason: ProjectionUnavailableReason,
    threshold: Threshold | null,
  ): HostProjection => ({ ...base, threshold, projection: null, projectionUnavailable: reason });

  // PRECEDENCE, contract §2.2. The order is part of the contract, not an implementation detail:
  // a mock that checks these in a different order disagrees with the engine in ways that look
  // like bugs.
  if (!ew.enabled) return decline('disabled', null);
  if (currentValue === null) return decline('metric_unmeasurable', null);

  const threshold = thresholdFor(config, host, baselines);
  // No baseline means no threshold to project toward — not merely an imprecise projection.
  if (threshold === null) return decline('warming', null);

  if (fitSampleCount < ew.minFitSamples) return decline('insufficient_samples', threshold);

  // BEFORE the slope, deliberately. A crossed threshold makes the slope irrelevant, and a
  // draining-but-still-crossed queue would otherwise report `not_rising`, which reads as
  // "nothing to see" about a queue that is over its limit.
  if (currentValue >= threshold.value) return decline('already_crossed', threshold);

  const slopePerMs = fitSlopePerMs(samples);
  if (slopePerMs === null) return decline('not_rising', threshold);

  // Round to 1dp in the units we publish, and test the ROUNDED value: publishing slope 0.0
  // alongside a finite ETA would be a projection the numbers do not support.
  const slopePerMinute = Math.round(slopePerMs * 60_000 * 10) / 10;
  if (slopePerMinute <= 0) return decline('not_rising', threshold);

  const secondsToThreshold = Math.ceil(
    ((threshold.value - currentValue) / slopePerMinute) * 60,
  );
  // Guard rather than trust: a positive rounded slope with a non-positive ETA would mean the
  // arithmetic disagrees with the already_crossed check above, and publishing 0 is exactly the
  // "zero reads as a measurement of now" case §1.4 forbids.
  if (!Number.isFinite(secondsToThreshold) || secondsToThreshold <= 0) {
    return decline('not_rising', threshold);
  }
  if (secondsToThreshold > ew.horizonSeconds) return decline('beyond_horizon', threshold);

  const crossingMs = (last?.at ?? now) + secondsToThreshold * 1000;
  return {
    ...base,
    threshold,
    projectionUnavailable: null,
    projection: {
      kind: 'projection',
      basis: 'linear-least-squares',
      slope: slopePerMinute,
      slopeUnit: SLOPE_UNIT,
      secondsToThreshold,
      projectedCrossingAt: isoSeconds(crossingMs),
      // "at this rate" is a contract-tested invariant (§1.4): the hedge has to be inside the one
      // string Dev C renders verbatim, or it can be dropped by whoever styles the panel.
      message:
        `Queue depth ${currentValue} rising ~${slopePerMinute}/min; ` +
        `at this rate it crosses ${threshold.value} in ~${humanDuration(secondsToThreshold)}.`,
    },
  };
}
