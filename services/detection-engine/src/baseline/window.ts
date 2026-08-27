/**
 * Rolling baseline — ADR 0002.
 *
 * A trailing time window of samples per (host, metric), held in memory. Nothing is
 * persisted, so an engine restart means a fresh warm-up.
 *
 * Warm-up is explicit: below minSamples a metric has NO baseline and `mean()` returns
 * null. Callers must not substitute a guess — a seeded baseline manufactures false
 * findings in the first seconds, which is exactly what MVP §6 warns against.
 */

/** The metrics we baseline. Absolute rules (dead_host, system_alert) need none. */
export type MetricName =
  | 'queued'
  | 'messagesPerSec'
  | 'errorsPerMinute'
  | 'avgProcessingTime'
  | 'avgQueueingTime';

/**
 * One observation. Exported because `recent()` returns these and Early Warning fits a slope
 * over them — a public method returning an unexported type compiles, but leaves a consumer
 * unable to name what it received.
 */
export interface Sample {
  /** Epoch milliseconds. Passed in, never read from the clock here. */
  at: number;
  value: number;
}

/**
 * Samples for one host+metric pair, pruned to the trailing window.
 *
 * Implemented as a plain array rather than a fixed ring buffer because the window is
 * defined by *time*, not sample count — a proxy that misses polls would otherwise
 * leave stale entries in fixed slots.
 */
class MetricWindow {
  #samples: Sample[] = [];

  /**
   * Samples before this instant describe a different load regime and are excluded from
   * `mean()`. See `BaselineStore.beginRegime()` for why this exists.
   *
   * -Infinity, not 0: a real epoch-ms comparison against 0 would also work today, but the
   * intent is "no boundary has been declared", and that is what -Infinity says.
   */
  #regimeStart = Number.NEGATIVE_INFINITY;

  readonly #windowMs: number;
  readonly #minSamples: number;

  constructor(windowMs: number, minSamples: number) {
    this.#windowMs = windowMs;
    this.#minSamples = minSamples;
  }

  add(at: number, value: number): void {
    if (!Number.isFinite(value)) return;
    this.#samples.push({ at, value });
    this.#prune(at);
  }

  /**
   * Mean over the window, or null while warming up.
   *
   * Counts only samples at or after the regime boundary, so a declared regime change
   * re-warms this metric rather than averaging across the discontinuity.
   */
  mean(): number | null {
    const values = this.#inRegime();
    if (values.length < this.#minSamples) return null;
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
  }

  /**
   * Median over the window, or null while warming up — the robust alternative to `mean()`.
   *
   * Same warm-up gate and same regime filter, so a caller can swap one for the other without
   * changing when a baseline becomes available. See `ROBUST_METRICS` for which metrics use it
   * and why only those.
   */
  median(): number | null {
    const values = this.#inRegime();
    if (values.length < this.#minSamples) return null;
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    // Even count: average the two middle values, so the estimate moves smoothly as samples
    // arrive rather than stepping between two neighbours on every poll.
    return values.length % 2 === 1
      ? values[mid]!
      : (values[mid - 1]! + values[mid]!) / 2;
  }

  /** Values at or after the regime boundary, in sample order. A fresh array — `median()` sorts it. */
  #inRegime(): number[] {
    const values: number[] = [];
    for (const sample of this.#samples) {
      if (sample.at < this.#regimeStart) continue;
      values.push(sample.value);
    }
    return values;
  }

  /**
   * Declare that samples before `at` belong to a previous regime.
   *
   * Only `mean()` honours it. `recent()` deliberately still returns pre-boundary samples:
   * it feeds the dashboard graphs and Early Warning's slope fit, and blanking a graph on
   * reset would be a visible regression for a statistics problem. The graph showing the
   * step down is the truthful picture anyway.
   */
  beginRegime(at: number): void {
    this.#regimeStart = at;
  }

  /**
   * How many samples are held, RAW — deliberately ignoring `#regimeStart`, unlike `mean()` and
   * `median()`, which both go through `#inRegime()`.
   *
   * That inconsistency is the intended answer to the question this actually gets asked: both
   * callers use it to assert a sample WAS RECORDED, which is a fact about storage and stays true
   * across a regime boundary. Filtering it would make "did this arrive" unanswerable.
   *
   * So do NOT reach for it to mean "how warm is this baseline" — for ~30 minutes after a
   * `beginRegime()` it over-reports, counting samples no estimator will use. `baseline() !== null`
   * is the warmth question, and `isWarm()` is the per-host form of it.
   */
  get sampleCount(): number {
    return this.#samples.length;
  }

  /** Most recent value, or null if empty. Used for rate-of-change comparisons. */
  latest(): number | null {
    const last = this.#samples.at(-1);
    return last === undefined ? null : last.value;
  }

  /** Value immediately before the latest, or null. */
  previous(): number | null {
    const prior = this.#samples.at(-2);
    return prior === undefined ? null : prior.value;
  }

  /**
   * Samples within `spanMs` of `now`, oldest first — for fitting a slope.
   *
   * Returns pairs rather than values because a least-squares fit needs the TIMESTAMPS: the
   * poll interval is nominal, not guaranteed (a slow fetch stretches it, a missed poll leaves
   * a gap), so treating samples as evenly spaced would compute a slope per *sample* and
   * report it as a slope per *minute*. At the shipped 2500ms proxy poll against a 5000ms
   * engine poll that error is not small.
   *
   * A COPY, deliberately. Handing out the internal array would let a caller mutate the
   * baseline while iterating it, and the only consumer is Early Warning, which reads at most
   * a few dozen samples once per poll — the copy is not worth avoiding.
   *
   * Independent of `minSamples`: this returns what exists, and the caller decides whether
   * that is enough to fit. Early Warning has its own `minFitSamples`, which is a different
   * question from "is there a usable baseline".
   */
  recent(now: number, spanMs: number): readonly Sample[] {
    const cutoff = now - spanMs;
    const out: Sample[] = [];
    // Walk backwards and stop at the first sample outside the span: samples are time-ordered,
    // so there is nothing older worth checking.
    for (let i = this.#samples.length - 1; i >= 0; i -= 1) {
      const sample = this.#samples[i];
      if (sample === undefined || sample.at < cutoff) break;
      out.push(sample);
    }
    return out.reverse();
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    // Samples arrive in time order, so drop from the front until inside the window.
    let firstKept = 0;
    while (firstKept < this.#samples.length) {
      const sample = this.#samples[firstKept];
      if (sample === undefined || sample.at >= cutoff) break;
      firstKept += 1;
    }
    if (firstKept > 0) this.#samples = this.#samples.slice(firstKept);
  }
}

/**
 * Key separator. Host names legitimately contain spaces ("Lab Router"), so the
 * separator must be a character they cannot contain — otherwise forget()'s prefix
 * match could delete another host's windows.
 */
const SEP = '\u0000';

/**
 * Metrics whose baseline is a MEDIAN rather than a mean.
 *
 * Not a tuning preference — it follows from the direction of harm, which is why it covers
 * exactly one metric today and would cover any future metric with the same direction:
 *
 *   - For `queued`, `avgProcessingTime`, `avgQueueingTime` and `errorsPerMinute`, HIGHER is
 *     worse. An inflated baseline makes those rules QUIETER. That is ADR 0002's documented
 *     self-inflation (CLAUDE.md §5.1), it is deliberately pinned by tests, and it fails safe.
 *   - For `messagesPerSec`, LOWER is worse — `throughput_drop` is the only comparative rule in
 *     that direction. An inflated baseline makes it NOISIER: it manufactures findings on a
 *     healthy production, which MVP §6 names as the top risk.
 *
 * MEASURED, 2026-08-27, and the reason this exists. `Reset all` after `pool_bottleneck` removes
 * the ~1s-per-call throttle on `Cloud API`, and the accumulated backlog then flushes at once —
 * from `Ens.MessageHeader`, 102 messages in one second and 169 in the next, ~135/sec against an
 * idle 0.5/sec. The proxy reported `messagesPerSec: 54.8` for the poll containing them, and that
 * value is a TRUE measurement: IRIS computes the rate as messages-in-interval / interval, and
 * 274 / 5s = 54.8 exactly.
 *
 * So the burst is real work and is recorded, not rejected. What a mean cannot do is survive it —
 * that single sample supplied 68% of a 53-sample mean, giving a baseline of 1.5283 (= 81/53)
 * against a true idle rate of 0.504, and all three hosts reported `throughput_drop` with nothing
 * armed. No window length helps: a 270x transient dominates any mean it is in, and a longer
 * window only holds it for longer. A median is unmoved by 1-2 samples in 12 or more.
 *
 * It also makes `throughput_drop` HOLD a real drop for longer, which is the opposite of a
 * regression: a host that stops moving messages has to fill more than half the window with
 * zeroes before its own median decays, where a mean began absorbing the first one.
 *
 * `beginRegime()` does NOT make this redundant, and vice versa. They fix two different
 * mechanisms — a sustained step DOWN in load spanning the window, and a transient spike INSIDE
 * the new regime — and each on its own was measured firing this rule.
 */
const ROBUST_METRICS: ReadonlySet<MetricName> = new Set<MetricName>(['messagesPerSec']);

/** Baseline state for every host and metric the engine has seen. */
export class BaselineStore {
  readonly #windows = new Map<string, MetricWindow>();

  readonly #windowSeconds: number;
  readonly #minSamples: number;

  constructor(windowSeconds: number, minSamples: number) {
    this.#windowSeconds = windowSeconds;
    this.#minSamples = minSamples;
  }

  /** Record one metric observation. `at` is epoch ms, passed in for testability. */
  record(host: string, metric: MetricName, value: number, at: number): void {
    this.#windowFor(host, metric).add(at, value);
  }

  /**
   * Rolling baseline for a host+metric, or null while warming up.
   *
   * The ONE accessor every rule goes through, so the choice of estimator is made here rather
   * than at each call site — a rule that reached for `mean()` directly would silently opt out
   * of `ROBUST_METRICS`. Warm-up timing is identical either way.
   */
  baseline(host: string, metric: MetricName): number | null {
    const window = this.#windows.get(key(host, metric));
    if (window === undefined) return null;
    return ROBUST_METRICS.has(metric) ? window.median() : window.mean();
  }

  /**
   * Timestamped samples for a host+metric within `spanMs` of `now`, oldest first.
   *
   * Empty when the host+metric has never been seen — an empty array, not null, because "no
   * samples" and "not enough samples to fit" are the same answer to the caller and one of them
   * being null would just move the check.
   */
  recent(host: string, metric: MetricName, now: number, spanMs: number): readonly Sample[] {
    return this.#windows.get(key(host, metric))?.recent(now, spanMs) ?? [];
  }

  /** Raw sample count — see `MetricWindow.sampleCount` for why this one ignores the regime. */
  sampleCount(host: string, metric: MetricName): number {
    return this.#windows.get(key(host, metric))?.sampleCount ?? 0;
  }

  latest(host: string, metric: MetricName): number | null {
    return this.#windows.get(key(host, metric))?.latest() ?? null;
  }

  previous(host: string, metric: MetricName): number | null {
    return this.#windows.get(key(host, metric))?.previous() ?? null;
  }

  /**
   * True once every baselined metric for this host has enough samples.
   * Drives the `warming` engine state.
   */
  isWarm(host: string, metrics: readonly MetricName[]): boolean {
    return metrics.every((metric) => this.baseline(host, metric) !== null);
  }

  /**
   * Declare that everything sampled before `at` describes a DIFFERENT load regime, for every
   * host and metric, so the baselines re-warm instead of averaging across the change.
   *
   * Exists because of a measured false positive (2026-08-27). A demo scenario deliberately
   * quadruples inbound load — `pool_bottleneck` drives 2 msg/sec against LABDEMO's 0.5 — and
   * `Reset all` restores it in one step. The rolling mean is a 30-minute trailing window, so
   * for half an hour after the reset it still averaged in the elevated block: baseline 1.19
   * against a current 0.4, a fraction of 0.34 under a `baselineFraction` of 0.40, and all
   * three hosts reported `throughput_drop` on a production with nothing armed and nothing
   * wrong. The finding's `detectedAt` was the exact second of the reset.
   *
   * A LOAD STEP-DOWN IS NOT A FAULT, and no threshold can tell the two apart from the mean
   * alone — which is why this is a boundary rather than a tuned number. `throughput_drop` is
   * the only rule that could be hit, because it is the only comparative rule where lower is
   * worse; the others see a reset as a value dropping back under a floor and go quiet.
   *
   * Deliberately NOT called when a scenario is ARMED. Arming is the fault we want measured
   * against the healthy baseline, and discarding history there would blind the very detection
   * the demo exists to show.
   */
  beginRegime(at: number): void {
    for (const window of this.#windows.values()) window.beginRegime(at);
  }

  /** Drop a host's state, e.g. when it disappears from the production. */
  forget(host: string): void {
    const prefix = `${host}${SEP}`;
    for (const existing of [...this.#windows.keys()]) {
      if (existing.startsWith(prefix)) this.#windows.delete(existing);
    }
  }

  #windowFor(host: string, metric: MetricName): MetricWindow {
    const id = key(host, metric);
    let window = this.#windows.get(id);
    if (window === undefined) {
      window = new MetricWindow(this.#windowSeconds * 1000, this.#minSamples);
      this.#windows.set(id, window);
    }
    return window;
  }
}

function key(host: string, metric: MetricName): string {
  return `${host}${SEP}${metric}`;
}
