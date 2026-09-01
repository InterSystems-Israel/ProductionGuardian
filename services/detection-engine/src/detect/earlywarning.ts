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

/**
 * Which way the metric is moving now — contract §1.5. The SIGN of the tail fit, not its magnitude.
 *
 * A separate concept from `ProjectionUnavailableReason` and deliberately not folded into it: the
 * reason answers *which state*, this answers *which way*, and a queue can be over its threshold in
 * either direction. Publishing it as an eighth reason would have moved the precedence every consumer
 * enumerating reasons depends on.
 */
export type RecentDirection = 'rising' | 'falling' | 'steady';

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
  /** Contract §1.5. Measured, so present on every row; null means no direction is claimed. */
  recentDirection: RecentDirection | null;
  threshold: Threshold | null;
  projection: Projection | null;
  projectionUnavailable: ProjectionUnavailableReason | null;
  /**
   * The window fit's slope in `SLOPE_UNIT`, or null when there is no usable fit.
   *
   * **INTERNAL. Not part of `earlywarning-api.md`, and `publishedProjection()` strips it** — §1.4
   * forbids a slope outside `projection` on that endpoint even where we decline to forecast, because
   * "rising ~0.5/min" next to no ETA implies the forecast we withheld. That rule is not being bent
   * here: the panel still cannot see this.
   *
   * It exists because `investigation-api.md` §2.2 ratifies the opposite decision for the *agent*:
   * `trend.slope` "may be zero or negative here ... because a queue that is draining is a fact the
   * agent should see rather than a forecast to withhold". Two contracts, two consumers, and the
   * difference is deliberate on both sides — a panel renders to an operator who acts on a rate, and
   * the model has already been measured recommending a bigger pool for a queue falling 261 -> 181
   * because nothing in its input carried one (#187).
   *
   * Sourced from the SAME fit the ETA uses, computed once below. A second derivation of it is how
   * the published rate and the agent's rate would come to disagree — #174's argument for the tail.
   */
  windowSlopePerMinute: number | null;
  /**
   * The TAIL fit's slope in `SLOPE_UNIT` — the magnitude whose sign is `recentDirection`.
   *
   * **INTERNAL, on the same terms as `windowSlopePerMinute`**, and stripped by the same whitelist for
   * the same §1.4 reason. Only the sign has ever left this module.
   *
   * It is carried because `snapshot.inboundRatePerSec` is derived from it (#188): arrival rate is
   * completions plus the rate the backlog is growing, and "is growing" has to mean *now*. The window
   * fit cannot answer that. Measured on the live drain-through transient — `set_pool_size 1 -> 4`
   * applied, `recentDirection` reporting `falling`, `messagesPerSec` reading 4 because four workers
   * are clearing a backlog:
   *
   *     messagesPerSec alone                 4      -> the model recommended 4 -> 8
   *     via windowSlopePerMinute (queue 94)  4.57   -> the model recommended 4 -> 6
   *     via recentSlopePerMinute (queue 108) 3.82   -> the model recommended nothing
   *
   * A queue that is emptying must not report arrivals ABOVE its throughput, and the window fit does.
   * It is right for an ETA, which asks how the whole rise behaves; it is wrong for "what is arriving",
   * which is a question about the last two minutes. Same distinction #174 drew, applied to a magnitude.
   * (The two derived rows are separate runs a few polls apart — the transient is short. What decides
   * the outcome is which side of `messagesPerSec` each lands on.)
   *
   * Gated on `minFitSamples` identically to the window fit, but NOT null under identical conditions:
   * the tail refits over the trailing 120 s, so a poll gap can leave fewer than two samples in it
   * while the window still holds twelve. This is then null and so is `recentDirection`, which is its
   * sign. `buildTrend` declines the whole trend object in that case rather than serving a window slope
   * beside two nulls — see the third arm of its gate.
   */
  recentSlopePerMinute: number | null;
}

/**
 * One projection as `earlywarning-api.md` §1.1 defines it, for the endpoint to serve.
 *
 * A WHITELIST rather than a delete, so the wire shape is decided here and an internal field added to
 * `HostProjection` cannot reach the endpoint by forgetting about it. Publishing a new field becomes a
 * deliberate edit to this function, which is the right amount of friction for a ratified contract.
 * Typed as an `Omit` so a renamed field fails to compile rather than silently vanishing from the
 * payload.
 */
export function publishedProjection(
  p: HostProjection,
): Omit<HostProjection, 'windowSlopePerMinute' | 'recentSlopePerMinute'> {
  return {
    host: p.host,
    metric: p.metric,
    currentValue: p.currentValue,
    measuredAt: p.measuredAt,
    fitSampleCount: p.fitSampleCount,
    fitSpanSeconds: p.fitSpanSeconds,
    recentDirection: p.recentDirection,
    threshold: p.threshold,
    projection: p.projection,
    projectionUnavailable: p.projectionUnavailable,
  };
}

/**
 * MVP 2 projects one metric toward one finding type. Named here rather than inlined so the
 * single-scenario boundary is visible: adding a second is a contract change, not a config edit.
 */
const METRIC: MetricName = 'queued';

/**
 * How much of a fall counts as a DISCONTINUITY rather than ordinary draining, as a fraction of the
 * previous value.
 *
 * Deliberately not in `thresholds.json`: ADR 0003 governs the numbers that decide what FIRES, and an
 * operator would never tune this. It is the definition of "the series restarted", i.e. a sanity check
 * on the arithmetic rather than a detection threshold.
 *
 * 80% is far above ordinary draining. At the shipped 5s poll, a host clearing 4/sec sheds 20 messages
 * a tick — 6% of a 350-deep queue, nowhere near this. A drain to zero, which is what an operator's
 * reset or an approved fix produces, is 100%.
 */
const DISCONTINUITY_FRACTION = 0.8;

/**
 * How much of the fit window counts as NOW, as a fraction of it.
 *
 * A single slope over the whole window describes the WINDOW, not the present, and publishing it as
 * "rising ~N/min" is a claim about the present. So the projection asks the question twice — once of
 * the window, once of its tail — and declines unless both say rising. Reported from a live demo run:
 * "the early warning sometimes comes up when the queue pool is being drained, because it takes a
 * point in time measurement and does not notice the acceleration/deceleration of pool growth."
 *
 * A FRACTION RATHER THAN A SECOND WINDOW LENGTH, and deliberately not in `thresholds.json`. ADR 0003
 * governs the numbers that decide what FIRES, and the earlyWarning numbers there
 * (`fitWindowSeconds`, `horizonSeconds`, `minFitSamples`) each set a level or a span an operator
 * might defensibly move. This one sets neither: it says how much of the series the word "now" covers,
 * which is the definition of "rising" rather than a threshold for it — the same argument
 * DISCONTINUITY_FRACTION carries above for "the series restarted".
 *
 * Two consequences make the fraction the safer shape than a configurable duration:
 *
 *   - it cannot contradict `fitWindowSeconds`. Two independent numbers can be set so the tail is
 *     LONGER than the window it is a tail of, which is a nonsense state with no sensible behaviour;
 *     a fraction moves with the window and can never invert.
 *   - it inherits the reachability invariant instead of needing its own. `thresholds.json` already
 *     requires `fitWindowSeconds / poll > minFitSamples` so a projection is structurally possible
 *     (#64's failure mode); at the shipped 300s/5s that is 60 samples, of which the tail is 24. A
 *     separate configurable duration would need that check duplicated, and an unreachable value
 *     would silence the module with no error — which is exactly what the existing check exists to
 *     prevent.
 *
 * 0.4 rather than something shorter: at the shipped poll the tail is 24 samples, enough that one
 * bursty poll cannot flip its sign, where the last 30s (6 samples) of a queue that drains and refills
 * would flap between projecting and not. Rather than something longer: at 0.8 the tail is nearly the
 * window and would just re-answer the same question. Note the drain only reaches this code once the
 * queue is UNDER the threshold — above it, `already_crossed` answers first — so the tail does not
 * need to react within a poll or two of the fix landing.
 */
const RECENT_FIT_FRACTION = 0.4;

const FINDING_TYPE = 'queue_buildup';

/**
 * The unit of every slope this module produces, published and internal alike.
 *
 * Exported because `investigate.ts` labels `windowSlopePerMinute` with it and used to read
 * `projection.slopeUnit` for that — a field that is null in the one state an investigation happens in
 * (#187), so it fell back to a second copy of this literal. One constant, so the label cannot say
 * something the arithmetic does not.
 */
export const SLOPE_UNIT = 'items/minute';

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
/**
 * Drop everything before the most recent DISCONTINUITY in the series.
 *
 * WHY, and this is the defect that made Early Warning useless on the demo scenario: a queue that is
 * drained — by an operator, by `Triggers.Reset()`, or by the approved fix itself — falls to zero in a
 * single poll. The trailing window then straddles that cliff, and a least-squares fit over both sides
 * reports the CLIFF rather than the trend. Measured on a live ramp, the 300s window held:
 *
 *     263 268 273 ... 350 355 | 0 0 0 ... 0 | 8 13 18 ... 124 129
 *
 * a fall of 355 followed by a genuine climb to 129 — and the fitted slope came out at **-52.7/min**
 * while the queue was visibly rising about 1/sec. So Early Warning reported `not_rising` right through
 * the ramp and then jumped straight to `already_crossed`. That is exactly what was reported: "I don't
 * see it activated when Pool Bottleneck is used. it just goes from nothing to Critical."
 *
 * THE SAME RULE THE ERROR RATE ALREADY USES. `engine.ts`'s `#errorsPerMinute` treats a counter going
 * backwards as "the production restarted, so reset rather than report a negative rate". The difference
 * is that a queue is NOT a monotonic counter: it drains and refills constantly, and the trend across
 * that is the real signal. So a small dip must not reset anything, and the test is proportional rather
 * than "any decrease".
 *
 * Returns the samples AFTER the cliff, which means a freshly drained host reports
 * `insufficient_samples` — an honest "ask again shortly" — rather than a projection fitted across a
 * discontinuity. That is the right trade: a wrong forecast is worse than a withheld one.
 */
function sinceLastDiscontinuity(samples: readonly Sample[]): readonly Sample[] {
  // Backwards, because only the NEWEST cliff matters: anything older is already excluded by it.
  // Stopping at the first hit keeps this O(n) and allocation-free when there is no discontinuity,
  // which is the common case.
  for (let i = samples.length - 1; i >= 1; i -= 1) {
    const previous = samples[i - 1]?.value ?? 0;
    const current = samples[i]?.value ?? 0;
    // `previous > 0` guards two things: a division that would be meaningless at zero, and the far
    // more important case of a ramp STARTING from zero — 0 -> 8 is the signal, not a collapse.
    if (previous > 0 && current < previous * (1 - DISCONTINUITY_FRACTION)) {
      return samples.slice(i);
    }
  }
  return samples;
}

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
 * The tail of the series: samples within `spanMs` of the LAST SAMPLE, oldest first.
 *
 * Anchored on the last sample rather than on `now` because the question is about the shape of the
 * series, not about the wall clock. Anchoring on `now` would let a slow poll silently shorten the
 * tail — and at the extreme, a stale series would report a tail of one sample for a reason that has
 * nothing to do with whether the queue is rising. `measuredAt` and `projectedCrossingAt` are already
 * on the sample clock for the same reason (contract EW-Q3).
 *
 * Takes the ALREADY TRUNCATED series, so a rise after a discontinuity is fitted against itself on
 * both passes rather than the tail reaching back across a cliff the window pass excluded.
 */
function recentPortion(samples: readonly Sample[], spanMs: number): readonly Sample[] {
  const last = samples.at(-1);
  if (last === undefined) return samples;
  const cutoff = last.at - spanMs;
  // Backwards from the end and stop at the first sample outside the span: samples are time-ordered,
  // so this touches only the tail rather than the whole window.
  let firstKept = samples.length - 1;
  while (firstKept > 0 && (samples[firstKept - 1]?.at ?? 0) >= cutoff) firstKept -= 1;
  return firstKept === 0 ? samples : samples.slice(firstKept);
}

/** A slope in units per ms, rounded to the 1dp we publish. Null stays null. */
function perMinute(slopePerMs: number | null): number | null {
  return slopePerMs === null ? null : Math.round(slopePerMs * 60_000 * 10) / 10;
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
  const samples = sinceLastDiscontinuity(
    baselines.recent(host, METRIC, now, ew.fitWindowSeconds * 1000),
  );
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

  /*
   * THE TAIL FIT, COMPUTED ONCE AND USED TWICE (#174, contract §1.5).
   *
   * It was already computed at step 6 as a sign test and then thrown away on every other path — so a
   * queue draining above its threshold declined as `already_crossed` while this value sat unread.
   * Now it is measured here, published on every row, and step 6 reads it instead of re-fitting.
   *
   * GATED ON `minFitSamples`, and that is §1.5's load-bearing rule rather than caution. The tail is
   * allowed to decide on as few as two samples BECAUSE the window behind it has already cleared
   * twelve — it confirms a grounded answer rather than producing one. Published standalone on a
   * warming host, a sign fitted through three samples would be a claim with nothing behind it, so
   * `warming` and `insufficient_samples` rows carry null.
   */
  const recentSlopePerMinute =
    fitSampleCount >= ew.minFitSamples
      ? perMinute(
          fitSlopePerMs(recentPortion(samples, ew.fitWindowSeconds * 1000 * RECENT_FIT_FRACTION)),
        )
      : null;
  // `-0 > 0` and `-0 < 0` are both false, so a small negative that rounds to zero lands on 'steady'
  // rather than 'falling' — which is what "rounded to the 1dp we publish" has to mean to be honest.
  const recentDirection: RecentDirection | null =
    recentSlopePerMinute === null
      ? null
      : recentSlopePerMinute > 0
        ? 'rising'
        : recentSlopePerMinute < 0
          ? 'falling'
          : 'steady';

  /*
   * THE WINDOW FIT, COMPUTED ONCE AND USED TWICE (#187) — the same arrangement the tail fit above
   * already has, and for the same reason.
   *
   * It used to be computed at step 6, below `already_crossed`, which is exactly the decline a
   * `queue_buildup` investigation is always requested under. So `trend.slope` was null on every
   * investigation the product has ever served, and `investigation-api.md` §2.2's stated reason for
   * carrying a signed slope — a draining queue is a fact the agent should see — was never delivered.
   *
   * Hoisting it changes no projection: the ETA path reads this value instead of refitting, and by the
   * time it does, `fitSampleCount >= minFitSamples` has already been checked, so it is the same
   * number the same call produced before. Gated identically to the tail so "there is no usable fit"
   * has one meaning across both.
   */
  const windowSlopePerMinute =
    fitSampleCount >= ew.minFitSamples ? perMinute(fitSlopePerMs(samples)) : null;

  const base = {
    host,
    metric: METRIC as string,
    currentValue,
    measuredAt,
    fitSampleCount,
    fitSpanSeconds,
    recentDirection,
    windowSlopePerMinute,
    recentSlopePerMinute,
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

  // Round to 1dp in the units we publish, and test the ROUNDED value: publishing slope 0.0
  // alongside a finite ETA would be a projection the numbers do not support. Reads the fit measured
  // above rather than repeating it (#187) — one computation, so the rate this endpoint publishes and
  // the rate the investigation carries cannot drift apart.
  const slopePerMinute = windowSlopePerMinute;
  if (slopePerMinute === null || slopePerMinute <= 0) return decline('not_rising', threshold);

  // RISING NOW, not merely on average across the window. The window slope above describes the
  // window; this asks the same question of its tail, and both must say rising. That one gate covers
  // three shapes a single fit reports as a rise: a queue draining after the approved fix, a rise that
  // has levelled off, and a rise that has turned over. See RECENT_FIT_FRACTION.
  //
  // `not_rising` rather than an eighth reason, and it is the accurate answer rather than the
  // available one: a draining queue is not rising. `contracts/earlywarning-api.md` fixes the seven
  // reasons and their precedence, and this stays inside both — it sits at step 6, after
  // `already_crossed`, so a queue that is draining but still ABOVE its threshold keeps reporting
  // `already_crossed`. Draining-but-over-limit is still a problem.
  //
  // An unfittable tail declines too — both cases arrive as `fitSlopePerMs` returning null: fewer than
  // two samples has no slope, and a tail sharing one timestamp is division by zero rather than a flat
  // line. Two is all the tail needs, not `minFitSamples`, because its slope is never published: it is
  // a sign test confirming an answer the window already grounded in 12+ samples. At the shipped
  // cadence the tail holds ~24, so reaching two at all means a polling gap, where declining is the
  // posture the rest of this module takes. `insufficient_samples` would be the wrong reason for
  // either — the contract defines it against the published `fitSampleCount`, which is the FULL
  // window's count and has already cleared `minFitSamples` by this point.
  // Reads the value measured above rather than re-fitting: `recentDirection !== 'rising'` is exactly
  // the old `recentSlopePerMinute === null || <= 0`, since null maps to null and a non-positive
  // rounded slope maps to 'falling' or 'steady'. One computation, so the published direction and the
  // gate can never disagree — two fits of the same samples is a way for them to.
  if (recentDirection !== 'rising') {
    return decline('not_rising', threshold);
  }

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
