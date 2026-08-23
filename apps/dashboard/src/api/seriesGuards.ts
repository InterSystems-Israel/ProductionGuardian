/**
 * Parser for `GET /api/hostseries` — field by field, never a cast.
 *
 * Same discipline and the same reason as `mvp2Guards.ts`: this endpoint has no schema in
 * `contracts/`, so nothing generated enforces its shape on either side. A cast asserts; reading
 * each field checks.
 *
 * ONE RULE DOMINATES THIS FILE, and it is the feature's whole correctness property.
 *
 * **A point whose value is not a finite number is DROPPED, never coerced to 0.** The engine already
 * omits an unmeasurable poll (contract Q13: `null` means "not measurable for this host", never
 * zero), so a `null` should never arrive inside `points` at all. This drops it anyway, because the
 * alternative failure is the expensive one: `asNullableNumber`-style coercion to 0 is exactly the
 * defect #33, #49 and #58 each were, and here it would draw a queue plunging to empty on a host
 * whose queue was never read. Dropping leaves a hole in the timestamps, which is what the chart
 * breaks its line on — so a malformed payload degrades to "we have no reading for that moment",
 * which is true, rather than to "the reading was zero", which is not.
 *
 * Note the asymmetry with `guards.ts`, which defaults `messagesPerSec` to 0 for a whole host. That
 * is right there and wrong here: a host missing a metric still belongs on the grid, so a 0 keeps it
 * visible. A *point* missing its value contributes nothing but a false datum, so it goes.
 */

import type { HostSeriesView, MetricSeriesView, SeriesPoint } from '../types/hostseries';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Points, oldest first, with anything unusable dropped rather than defaulted.
 *
 * SORTED HERE as cheap insurance. The engine serves them in poll order and the window is
 * append-only, so this is redundant against a conforming engine — but a chart fed points out of
 * order draws a line that doubles back on itself, which reads as corrupted data rather than as a
 * sort bug. The same reasoning as `useHealthScan`'s redundant findings sort.
 */
function parsePoints(value: unknown): SeriesPoint[] {
  if (!Array.isArray(value)) return [];
  const out: SeriesPoint[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    // BOTH must be present. A point with no timestamp cannot be placed on the x axis, and a point
    // with no value must not become one — see the header.
    if (!isNonEmptyString(entry.at) || !isFiniteNumber(entry.value)) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    out.push({ at: entry.at, value: entry.value });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function parseSeries(value: unknown): MetricSeriesView[] {
  if (!Array.isArray(value)) return [];
  const out: MetricSeriesView[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    // A series with no metric name has nothing to label its graph with, so it is unrenderable.
    if (!isNonEmptyString(entry.metric)) continue;
    out.push({
      metric: entry.metric,
      // Passed through as an open string. An unrecognised unit renders the value unlabelled rather
      // than under a wrong label, which is §2.4's rule for an unknown enum value.
      unit: isNonEmptyString(entry.unit) ? entry.unit : 'count',
      points: parsePoints(entry.points),
    });
  }
  return out;
}

/**
 * Parse one host's series response, or null when the payload is unusable.
 *
 * Null rather than a throw or an empty object: the caller swallows it and keeps the previous
 * series, the same way `useProjections` does — a graph that cannot parse must not blank a panel
 * whose metric rows are real.
 */
export function parseHostSeries(payload: unknown): HostSeriesView | null {
  if (!isRecord(payload)) return null;
  if (!isNonEmptyString(payload.host)) return null;

  return {
    host: payload.host,
    // FALSE UNLESS EXPLICITLY TRUE. An unreadable `known` must not present an unrecognised host as
    // one the engine reports, because that is the difference between "no history yet" and "we are
    // asking about a host that does not exist".
    known: payload.known === true,
    polledAt: isNonEmptyString(payload.polledAt) ? payload.polledAt : null,
    spanSeconds: isFiniteNumber(payload.spanSeconds) ? payload.spanSeconds : 0,
    // 0 means "cannot detect gaps", which is the safe direction: a bogus interval would either mark
    // every step as a gap or hide a real one.
    pollIntervalSeconds: isFiniteNumber(payload.pollIntervalSeconds) ? payload.pollIntervalSeconds : 0,
    series: parseSeries(payload.series),
  };
}
