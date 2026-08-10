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

interface Sample {
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

  /** Mean over the window, or null while warming up. */
  mean(): number | null {
    if (this.#samples.length < this.#minSamples) return null;
    let total = 0;
    for (const sample of this.#samples) total += sample.value;
    return total / this.#samples.length;
  }

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

  /** Rolling mean for a host+metric, or null while warming up. */
  baseline(host: string, metric: MetricName): number | null {
    return this.#windows.get(key(host, metric))?.mean() ?? null;
  }

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
