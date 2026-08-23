/**
 * Per-host metric series — the history behind the dashboard's three host graphs.
 *
 * WHERE THE HISTORY COMES FROM, AND WHY IT IS NOT IRIS
 *
 * `GET /api/healthscan/hosts` carries only the current sample, so "live plus some time back"
 * needed a source. There were two real candidates and this is the cheaper one by a wide margin:
 * the rolling baseline ALREADY holds a timestamped sample per (host, metric) over
 * `baselineWindowSeconds`, because ADR 0002 built it out of `{at, value}` pairs rather than a
 * running mean. Nothing new is measured, stored or scheduled here — this reads what the poll loop
 * has been writing since the engine started.
 *
 * Verified before choosing rather than assumed: `/api/earlywarning` on the live stack reported
 * `fitSampleCount: 35, fitSpanSeconds: 170` per host, which is only expressible if the window
 * retains 35 individually-stamped `queued` samples. `MetricWindow.recent()` already returns them
 * and Early Warning already fits a least-squares slope over them, so the series is load-bearing
 * for a shipped module and not a new claim about the store.
 *
 * REJECTED: `Ens_Activity_Data.Seconds` in IRIS, which holds 10-second buckets over days (22,220
 * rows on this instance). Longer history, but the wrong shape for this panel three ways. It is
 * bucketed at 10s where the engine samples at 5s, so it cannot show "live"; its columns are
 * `TotalCount`/`TotalDuration`, i.e. sums an operator would have to divide rather than the
 * per-host gauges the cards already display; and reaching it means an IRIS round trip on a surface
 * that repolls every 2 seconds. It is the right source for the activity CHAT, which asks about
 * days, and the wrong one for a graph of the last few minutes.
 *
 * REJECTED: accumulating the series in the browser from the 2s poll. It starts empty on load and
 * loses everything on refresh, so it cannot answer "some time back" at the only moment anyone
 * looks — the first ten seconds after opening the page.
 *
 * A NULL IS NEVER A POINT, AND THAT IS STRUCTURAL RATHER THAN CHECKED
 *
 * This is the correctness property the whole feature turns on (contract Q13; #33/#49/#58 are the
 * same defect three times). `queued` is `number | null` where null means "not measurable for this
 * host", never zero — and a graph that plots it at zero states a measurement nobody took.
 *
 * The guarantee is inherited, not re-implemented: `DetectionEngine.#recordIfMeasured` SKIPS a null
 * instead of recording it, so an unmeasurable poll leaves no sample in the window at all. There is
 * therefore no null to serialize and no coercion site to get wrong. What reaches a consumer is an
 * absence, in one of two shapes:
 *
 *   - some samples, with a TIME GAP where the nulls were  -> the client breaks the line
 *   - no samples at all                                   -> the client draws no line
 *
 * `pollIntervalSeconds` is published so the client can tell the first case from an unbroken run
 * without hardcoding the engine's cadence. How much absence is worth drawing as a break is a
 * display decision and stays in the dashboard; the fact that the absence exists is ours.
 *
 * The remaining question a consumer must not have to guess at is whether an empty series means
 * "this metric is not measurable here" or "the engine has not polled yet". `polledAt` settles it:
 * non-null with an empty series means this host HAS been polled and this metric produced nothing.
 * Derived from state the engine already keeps rather than tracked separately, so it cannot drift.
 */

import type { BaselineStore, MetricName } from '../baseline/window.ts';

/**
 * What a value measures. Published rather than left for the client to derive from the metric name:
 * the engine knows, and `avgProcessingTime` being seconds is exactly the fact contract Q6 had to
 * be confirmed empirically to settle. A consumer guessing it would eventually guess milliseconds.
 */
export type SeriesUnit = 'count' | 'seconds' | 'per_second';

export interface SeriesPoint {
  /** ISO 8601 UTC, second precision, Z-suffixed — the same shape every other timestamp we serve. */
  at: string;
  value: number;
}

export interface MetricSeries {
  metric: MetricName;
  unit: SeriesUnit;
  /** Oldest first. Empty is a legitimate answer; see the header on what it means. */
  points: SeriesPoint[];
}

export interface HostSeries {
  host: string;
  /**
   * Is this host in the current roster?
   *
   * False for a name we do not report — misspelled, or a host that left the production between
   * the poll the client rendered and the click it made. Reported rather than 404'd for the second
   * reason: that race is normal, and an error banner over it would blame the dashboard for a
   * production change. §7's "zero findings is 200 + [], never 404" is the same instinct.
   */
  known: boolean;
  /** Engine's last successful poll, or null before the first. Disambiguates an empty series. */
  polledAt: string | null;
  /** The span actually served, after clamping. May be less than asked for. */
  spanSeconds: number;
  /** Nominal seconds between samples, so a client can recognise a gap without hardcoding it. */
  pollIntervalSeconds: number;
  series: MetricSeries[];
}

/**
 * The three metrics the host panel graphs, with their units.
 *
 * DELIBERATELY NOT ALL FIVE BASELINED METRICS. The store also holds `avgQueueingTime` and
 * `errorsPerMinute`, and serving them would be a one-line addition — but this endpoint is polled
 * every 2 seconds while a host is selected, and each metric is up to `span / pollInterval` points.
 * Three is what the panel draws, so three is what crosses the wire. Widening it is a deliberate
 * act with a payload cost, not a default.
 */
const PUBLISHED: readonly { metric: MetricName; unit: SeriesUnit }[] = [
  { metric: 'queued', unit: 'count' },
  { metric: 'avgProcessingTime', unit: 'seconds' },
  { metric: 'messagesPerSec', unit: 'per_second' },
];

/**
 * Shortest span worth serving.
 *
 * Not zero: a span below a few poll intervals yields one or two points, and a two-point line is
 * a graph in shape only. A caller asking for less gets this and can see it did from `spanSeconds`.
 */
const MIN_SPAN_SECONDS = 60;

/**
 * Span served when a caller names none.
 *
 * Ten minutes, which at the shipped 5s poll is ~120 points per metric — enough to read a slope
 * over the `pool_bottleneck` scenario's whole life (it arms in 75s and crosses in another ~100s)
 * without serving the full 1800s window on every 2-second dashboard tick. A caller that wants more
 * asks for it and is clamped at the window; nobody gets 360 points by accident.
 */
export const DEFAULT_SPAN_SECONDS = 600;

/** The contract's timestamps are second-precision and Z-suffixed. */
function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface BuildSeriesOptions {
  host: string;
  /** Whether the host is in the current roster. The caller knows; this module does not. */
  known: boolean;
  baselines: BaselineStore;
  /** Requested span. Clamped to `[MIN_SPAN_SECONDS, windowSeconds]`. */
  spanSeconds: number;
  /**
   * The window's own length, which is the hard ceiling: the store prunes past it, so a longer
   * span cannot return more data and would advertise history that does not exist.
   */
  windowSeconds: number;
  pollIntervalMs: number;
  /** Epoch ms. Passed in, never read from the clock here — same rule as every rule in this service. */
  now: number;
  /** Engine's `lastPollAt`, epoch ms, or null before the first poll. */
  lastPollAt: number | null;
}

/**
 * Read one host's recent series out of the rolling baseline.
 *
 * Reads only. Nothing here records, prunes or otherwise touches the store — the poll loop owns
 * it, and a read endpoint that mutated detection state would be able to change what fires.
 */
export function buildHostSeries(options: BuildSeriesOptions): HostSeries {
  const { host, known, baselines, windowSeconds, pollIntervalMs, now, lastPollAt } = options;

  const spanSeconds = Math.min(
    Math.max(Math.round(options.spanSeconds), MIN_SPAN_SECONDS),
    windowSeconds,
  );

  const series: MetricSeries[] = PUBLISHED.map(({ metric, unit }) => ({
    metric,
    unit,
    // `recent()` hands back a copy, oldest first, of whatever is inside the span. An unknown
    // host+metric yields `[]` rather than throwing, which is the same answer as a known host that
    // never measured this metric — correctly, since neither has points to draw.
    points: baselines.recent(host, metric, now, spanSeconds * 1000).map((sample) => ({
      at: isoSeconds(sample.at),
      value: sample.value,
    })),
  }));

  return {
    host,
    known,
    polledAt: lastPollAt === null ? null : isoSeconds(lastPollAt),
    spanSeconds,
    // Rounded to seconds because that is the resolution a client needs to spot a gap, and a
    // fractional interval would invite the client to do arithmetic on it.
    pollIntervalSeconds: Math.round(pollIntervalMs / 1000),
    series,
  };
}
