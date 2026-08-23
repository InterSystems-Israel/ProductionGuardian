/**
 * One metric's recent history, as a hand-drawn inline SVG line chart.
 *
 * NO CHARTING LIBRARY, and that is not a compromise here. §3 keeps dependencies near-zero, and what
 * this draws is a polyline, two axis labels and a gap rule — `ArchitectureView.tsx` already draws
 * more complex SVG by hand in the same house style (a `viewBox`, tokens for colour, no magic
 * numbers). A charting library would arrive with its own colour system to fight the brand tokens
 * with, and its own opinion about how to render a missing value, which is the one decision this
 * component may not delegate.
 *
 * ── A NULL IS A GAP, NEVER A ZERO. THIS IS THE FILE THAT HAS TO GET IT RIGHT. ──
 *
 * `queued` and `errored` are `number | null` upstream, where null means "not measurable for this
 * host" and never zero (contract Q13). #33, #49 and #58 are the same defect three times, and a chart
 * is where it would be most convincing: a line dropping to the axis reads as a queue that drained,
 * which is a specific and wrong claim about a host nobody measured.
 *
 * The defence is structural rather than a check, and it runs the whole length of the pipeline:
 *
 *   engine     `#recordIfMeasured` SKIPS a null, so no sample exists for that poll
 *   endpoint   an absence is therefore a HOLE IN THE TIMESTAMPS, never a `null` in `points`
 *   guard      a point without a finite value is DROPPED, not coerced (`seriesGuards.ts`)
 *   here       consecutive points more than `GAP_FACTOR` intervals apart start a NEW polyline
 *
 * So there is no place where a missing reading could become a zero, and the visible result is a
 * broken line with clear air where the data is not. The break is also stated in words beneath the
 * chart when it happens (`gaps` below) — a discontinuity in a 40px-tall sparkline is easy to miss on
 * a projector, and §7.3 forbids letting the rendering carry a fact by itself.
 *
 * `GAP_FACTOR` is 1.75 rather than 1.0: the poll interval is nominal, so a slow fetch legitimately
 * stretches one step (the engine's own `window.ts` says so, which is why Early Warning fits against
 * real timestamps instead of sample indices). At 1.0 every jittered poll would draw a false break;
 * at 2.0 a single missed sample would be drawn as continuous. 1.75 sits between one late poll and one
 * missing one.
 *
 * ── THE THREE DEGENERATE CASES, each drawn deliberately ──
 *
 *   no points     no line at all, and a sentence saying which of the two reasons applies
 *   one point     a DOT, not a line. One reading is not a trend, and a flat line through a single
 *                 point would imply a duration nothing was observed over
 *   flat run      a line at mid-height. `range === 0` would divide by zero, so a zero range is
 *                 given a nominal one and the value is centred — the honest picture of "it did not
 *                 move", where scaling to the top or bottom edge would imply a limit
 */

import type { MetricSeriesView } from '../types/hostseries';
import { ABSENT, formatCount, formatDuration, formatRate } from '../lib/format';

/**
 * The drawing surface, in viewBox units.
 *
 * A viewBox rather than pixel sizes, so the chart scales with the panel and stays crisp — the same
 * choice `ArchitectureView` makes. The aspect ratio is wide and short on purpose: these are read as
 * "which way is it going", not measured off the axis, and three tall charts would not fit beside the
 * host's metric rows.
 */
const VIEW_W = 300;
const VIEW_H = 64;
/** Room for the stroke and the dot radius, so neither is clipped at an extreme value. */
const PAD_Y = 5;

/** How much more than one nominal interval counts as a gap. See the header. */
const GAP_FACTOR = 1.75;

/** Stroke width in viewBox units, matched to the icon set's 1.6 so the two read as one system. */
const STROKE = 1.8;

export interface MetricChartProps {
  series: MetricSeriesView;
  /** Human label with its unit implied by `series.unit`, e.g. "Queue depth". */
  label: string;
  /**
   * Nominal seconds between samples, from the payload. 0 means the engine did not report it, in
   * which case gap detection is DISABLED rather than guessed at — a wrong interval would either
   * fabricate breaks everywhere or hide a real one, and the first is worse than not detecting.
   */
  pollIntervalSeconds: number;
  /**
   * True when the engine has never polled, so an empty series means "warming" rather than "this
   * metric is not measurable on this host". The two need different sentences: one is temporary.
   */
  neverPolled: boolean;
}

/** Contiguous runs of points, split wherever the series has a hole. */
interface Segment {
  points: { x: number; y: number }[];
}

/**
 * Format a value in the unit the SERVER declared.
 *
 * `formatDuration` is reused rather than reformatted, per the brief and §7.3: it already renders
 * sub-second seconds as ms (`0.08` -> `80 ms`), which is the whole reason contract Q6 was settled
 * empirically. An unrecognised unit falls through to a plain count, which renders the number without
 * claiming a unit for it — §2.4's rule for an unknown enum value.
 */
function formatValue(value: number, unit: string): string {
  if (unit === 'seconds') return formatDuration(value);
  if (unit === 'per_second') return `${formatRate(value)}/s`;
  return formatCount(value);
}

/**
 * Scale the points into viewBox space, split into gap-free segments.
 *
 * x is scaled against the series' own time span rather than against `spanSeconds`: the engine clamps
 * the span it serves, and a chart drawn against the REQUESTED span would leave dead space on the left
 * for history the engine never had — which reads as a gap, i.e. as the one thing that has to mean
 * something specific here.
 */
function layout(
  points: readonly { at: string; value: number }[],
  pollIntervalSeconds: number,
): { segments: Segment[]; gaps: number; min: number; max: number } {
  const times = points.map((p) => Date.parse(p.at));
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? 0;

  /* A zero time span (one point, or several inside one second) would divide by zero. Falling back to
     1 puts everything at x=0, which is right for a single point and harmless for a coincident pair —
     both are drawn as dots below rather than as a line. */
  const spanMs = last - first || 1;
  /* A zero VALUE range is the flat-line case, and dividing by it is the bug this guard exists for.
     With a nominal range of 1 and the value equal to `min`, the expression below lands at exactly
     mid-height, which is the honest rendering of "it did not move". */
  const range = max - min || 1;
  const flat = max === min;

  const segments: Segment[] = [];
  let current: Segment = { points: [] };
  let gaps = 0;
  const gapMs = pollIntervalSeconds > 0 ? pollIntervalSeconds * 1000 * GAP_FACTOR : Number.POSITIVE_INFINITY;

  points.forEach((point, index) => {
    const at = times[index] ?? first;
    const previous = index === 0 ? null : (times[index - 1] ?? null);
    if (previous !== null && at - previous > gapMs) {
      // THE GAP. Close the run and start a new one, so the polyline is never drawn across the hole.
      if (current.points.length > 0) segments.push(current);
      current = { points: [] };
      gaps += 1;
    }
    current.points.push({
      x: ((at - first) / spanMs) * VIEW_W,
      // SVG y grows downward, so a high value must map to a LOW y.
      y: flat
        ? VIEW_H / 2
        : VIEW_H - PAD_Y - ((point.value - min) / range) * (VIEW_H - PAD_Y * 2),
    });
  });
  if (current.points.length > 0) segments.push(current);

  return { segments, gaps, min, max };
}

export function MetricChart({
  series,
  label,
  pollIntervalSeconds,
  neverPolled,
}: MetricChartProps): JSX.Element {
  const { points, unit } = series;

  /* NO DATA. Two unrelated causes, and they get different sentences because only one is temporary:
     the engine has not polled yet, or it has and this metric is not measurable on this host (Q13).
     Saying "no data" for both would describe a permanent state as a wait. */
  if (points.length === 0) {
    return (
      <figure className="pg-chart">
        <figcaption className="pg-chart__caption">
          <span className="pg-chart__label">{label}</span>
          <span className="pg-chart__latest">{ABSENT}</span>
        </figcaption>
        <p className="pg-chart__note">
          {neverPolled
            ? 'Collecting samples — the first appear within a few seconds.'
            : 'Not measurable for this host, so there is nothing to plot.'}
        </p>
      </figure>
    );
  }

  const { segments, gaps, min, max } = layout(points, pollIntervalSeconds);
  const latest = points.at(-1);
  const single = points.length === 1;

  /* The accessible description carries the same facts the line does, because a line is not readable
     by assistive technology and §7.3 does not allow the rendering to be the only statement. Range
     plus latest plus the gap count is what an operator takes from glancing at it. */
  const summary =
    `${label}: ${points.length} sample${points.length === 1 ? '' : 's'}, ` +
    `latest ${formatValue(latest?.value ?? 0, unit)}` +
    (min === max
      ? ', unchanged over the window'
      : `, ranging ${formatValue(min, unit)} to ${formatValue(max, unit)}`) +
    (gaps > 0 ? `, with ${gaps} break${gaps === 1 ? '' : 's'} where the metric was not measurable` : '');

  return (
    <figure className="pg-chart">
      <figcaption className="pg-chart__caption">
        <span className="pg-chart__label">{label}</span>
        {/* The current value, beside the shape rather than inside it: the number is what an operator
            reads and the line is context for it. Monospaced so it does not jitter as polls land
            (§7.3), the same rule the metric rows follow. */}
        <span className="pg-chart__latest">{formatValue(latest?.value ?? 0, unit)}</span>
      </figcaption>

      <svg
        className="pg-chart__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        /* `none`, so the line stretches to the panel width instead of being letterboxed. The x axis
           is time and the y axis is scaled to the data, so neither has a meaningful aspect ratio to
           preserve. */
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        {/* Baseline rule, purely for orientation. `aria-hidden` because the label above already
            states the range, and a decorative line has nothing to announce. */}
        <line
          className="pg-chart__axis"
          x1="0"
          y1={VIEW_H - 0.5}
          x2={VIEW_W}
          y2={VIEW_H - 0.5}
          aria-hidden="true"
        />

        {segments.map((segment, index) =>
          /* A ONE-POINT SEGMENT IS A DOT, not a line — and this covers both the single-sample series
             and each side of a gap that isolated a reading. An SVG polyline with one point renders
             nothing at all, so without this branch a lone sample would silently disappear and read
             as "no data" when we have exactly one. */
          segment.points.length === 1 ? (
            <circle
              key={index}
              className="pg-chart__dot"
              cx={segment.points[0]?.x ?? 0}
              cy={segment.points[0]?.y ?? 0}
              r={STROKE * 1.6}
            />
          ) : (
            <polyline
              key={index}
              className="pg-chart__line"
              strokeWidth={STROKE}
              points={segment.points.map((p) => `${p.x},${p.y}`).join(' ')}
            />
          ),
        )}

        {/* The newest reading, marked so "where are we now" does not need the caption. Skipped when
            the whole series is one point, which is already drawn as a dot above. */}
        {!single && segments.at(-1)?.points.length !== 1 && (
          <circle
            className="pg-chart__head"
            cx={segments.at(-1)?.points.at(-1)?.x ?? 0}
            cy={segments.at(-1)?.points.at(-1)?.y ?? 0}
            r={STROKE * 1.3}
            aria-hidden="true"
          />
        )}
      </svg>

      {/* Both notes below exist because the SVG alone would carry the fact. A break in a 64-unit-tall
          line is easy to miss on a projector, and "one sample" is indistinguishable from a stray dot. */}
      {gaps > 0 && (
        <p className="pg-chart__note">
          {gaps === 1 ? '1 break' : `${gaps} breaks`} in the line — the metric was not measurable
          then, which is not the same as zero.
        </p>
      )}
      {single && (
        <p className="pg-chart__note">One sample so far — not yet a trend.</p>
      )}
      {!single && gaps === 0 && min === max && (
        <p className="pg-chart__note">Unchanged across the window.</p>
      )}
    </figure>
  );
}
