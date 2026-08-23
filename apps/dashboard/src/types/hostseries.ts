/**
 * Host metric series — the shape behind the three graphs in the host panel.
 *
 * Transcribed from the engine's `GET /api/hostseries`. That endpoint is NOT in `contracts/`, and
 * that is deliberate rather than an omission: `contracts/healthscan-api.md` ratifies exactly two
 * endpoints, and an operational read that sits alongside them is a sibling — the same standing
 * `/api/earlywarning` and `/api/investigate` have. So there is no schema and no drift test here,
 * which is why `api/seriesGuards.ts` reads field by field rather than casting (the same discipline,
 * and for the same stated reason, as `types/mvp2.ts`).
 *
 * WHAT THE UI MAY ASSUME, and it is deliberately almost nothing:
 *
 *  - **A missing sample is a GAP, never a zero.** `queued` is `number | null` upstream, where null
 *    means "not measurable for this host" (contract Q13). The engine SKIPS an unmeasurable poll
 *    rather than recording it, so an absence arrives as a hole in the timestamps and never as a
 *    `null` inside `points`. The chart must break its line across that hole; plotting it at zero
 *    would state a measurement nobody took, which is #33/#49/#58 for the fourth time.
 *  - **`points` may be empty, and that is not an error.** Either the engine has not polled yet, or
 *    this metric is not measurable on this host. `polledAt` is what tells them apart.
 *  - **`unit` comes from the server.** Deriving it from the metric name here is one guess away from
 *    rendering `avgProcessingTime: 0.05` as fifty seconds — contract Q6 had to be settled
 *    empirically, so the UI does not re-guess it.
 */

/** What a value measures. Widened to `string` in the view type below, per §2.4. */
export type SeriesUnit = 'count' | 'seconds' | 'per_second';

export interface SeriesPoint {
  /** ISO 8601 UTC, second precision, Z-suffixed. */
  at: string;
  value: number;
}

export interface MetricSeriesView {
  /** `queued` | `avgProcessingTime` | `messagesPerSec` today. Open string, per §2.4. */
  metric: string;
  /** Open string for the same reason: an unrecognised unit renders unlabelled, never wrongly. */
  unit: SeriesUnit | string;
  /** Oldest first. Empty is legitimate — see the header. */
  points: SeriesPoint[];
}

export interface HostSeriesView {
  host: string;
  /** False when the engine does not report this host: a typo, or a host that just left. */
  known: boolean;
  /** Engine's last successful poll, or null before the first. Disambiguates an empty series. */
  polledAt: string | null;
  /** The span the engine actually served, after its own clamping. */
  spanSeconds: number;
  /**
   * Nominal seconds between samples.
   *
   * The chart uses this to decide how much silence counts as a gap. Read from the payload rather
   * than from `VITE_POLL_INTERVAL_MS`, because those are different cadences — the dashboard polls
   * every 2s and the engine samples every 5s, so using ours would see a gap between every pair of
   * points. 0 when the engine did not report it, which the chart treats as "cannot detect gaps"
   * rather than "every step is a gap".
   */
  pollIntervalSeconds: number;
  series: MetricSeriesView[];
}
