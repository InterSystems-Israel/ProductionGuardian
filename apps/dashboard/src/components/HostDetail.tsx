/**
 * Host detail — the right-hand panel that opens when a host card is clicked.
 *
 * Three graphs of the host's recent history (queue depth, processing time, throughput) beside the
 * current status. The findings list filters to this host at the same time, which happens in `App`
 * rather than here — this component draws the panel and nothing else.
 *
 * ── A SECOND SURFACE, NOT THE FINDING DRAWER EXTENDED, AND THE REASON MATTERS ──
 *
 * `FindingDetail` was the obvious thing to extend: it is already a fixed right-hand drawer with Esc
 * handling and focus return, and reusing it would have been less code. It is the wrong home, on the
 * strength of its own class comment: *"current vs. baseline side by side is the whole point of this
 * view"*, and it is keyed to ONE FINDING (`App` looks the finding up by id every poll, and the drawer
 * closes by itself when that finding clears). A host has no finding, may have several, and may have
 * none at all — so a host panel inside it would have to blank the section the drawer exists for.
 *
 * The two therefore share a SHAPE and not a component: this reuses `pg-drawer`'s geometry, its Esc
 * behaviour and its focus-return contract, so an operator sees one kind of panel, while the contents
 * and the lifecycle are separate. The alternative — one component branching on which of two
 * unrelated subjects it was given — is the seam every expensive MVP 2 defect sat on.
 *
 * ── TWO FIXED PANELS AT ONCE WOULD BE A DEFECT, SO THEY ARE MUTUALLY EXCLUSIVE ──
 *
 * Both are `position: fixed` at the same edge, so if both could open they would sit on top of each
 * other. `App` enforces one selection at a time: opening a host clears the selected finding and vice
 * versa. Enforced there rather than by a z-index or an offset, because the underlying question is
 * "what is the operator looking at", and there is one answer to it. A stacking rule would make the
 * hidden panel keep polling behind the visible one.
 *
 * Accessibility (§7.3), matching the drawer it sits beside: closes on `Esc`, focus returns to the
 * card that opened it, the close control is a real `<button>`, and the status is stated in words and
 * a badge beside the coloured dot rather than by the dot alone.
 */

import { useEffect } from 'react';
import type { FindingView, HostView, Severity } from '../types/healthscan';
import type { HostSeriesView } from '../types/hostseries';
import { formatCount, formatDuration, formatRate, formatRelative } from '../lib/format';
import { MetricChart } from './MetricChart';
import { SeverityBadge } from './SeverityBadge';
import { StatusDot } from './StatusDot';
import { IconClose } from './icons';

/**
 * The three graphs, in the order they are drawn, with the label each carries.
 *
 * ORDERED CAUSALLY rather than alphabetically: throughput and processing time are what a queue is
 * made of, so the queue leads and the two quantities that explain it follow. That is the order an
 * operator diagnosing a buildup reads them in, and it matches the pipeline ordering the host grid
 * already uses for the same reason.
 *
 * Units are NOT stated in these labels — `MetricChart` formats each value in the unit the SERVER
 * declared, so a label saying "seconds" here could disagree with a value rendered as ms. The label
 * names the quantity; the value carries its own unit.
 */
const GRAPHS: readonly { metric: string; label: string }[] = [
  { metric: 'queued', label: 'Queue depth' },
  { metric: 'avgProcessingTime', label: 'Avg processing time' },
  { metric: 'messagesPerSec', label: 'Throughput' },
];

export interface HostDetailProps {
  /** The selected host, or null when the panel is closed. */
  host: HostView | null;
  /** This host's findings, already filtered by the caller. */
  findings: readonly FindingView[];
  /** Worst severity among them; null when the host has none. */
  worst: Severity | null;
  series: HostSeriesView | null;
  /** True until the first series response for this host lands. */
  seriesLoading: boolean;
  now: number;
  onClose: () => void;
}

export function HostDetail({
  host,
  findings,
  worst,
  series,
  seriesLoading,
  now,
  onClose,
}: HostDetailProps): JSX.Element | null {
  /* Esc closes from anywhere, bound to the document for the same reason `FindingDetail` does it: the
     operator's focus is usually still on the card that opened this, since that card keeps focus for
     the return trip. */
  useEffect(() => {
    if (host === null) return undefined;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [host, onClose]);

  if (host === null) return null;

  /* `neverPolled` distinguishes the two reasons a series can be empty, and it is derived from the
     PAYLOAD rather than from `seriesLoading`: the request having returned tells us nothing about
     whether the engine has polled. `polledAt: null` with `known: false` is a warming engine;
     `polledAt` set with no points is a metric this host does not report (contract Q13).

     While the first response is still in flight, `neverPolled` is true so the charts say "collecting"
     rather than "not measurable" -- claiming the stronger of the two before we know is the wrong
     direction to be wrong in. */
  const neverPolled = series === null ? true : series.polledAt === null;
  const byMetric = new Map((series?.series ?? []).map((s) => [s.metric, s]));

  return (
    /* Same role and `aria-modal="false"` as the finding drawer: the operator should keep seeing the
       grid behind it, so it is not a modal and does not trap focus. `aria-labelledby` points at the
       heading so the accessible name cannot drift from the visible one. */
    <aside
      className="pg-drawer pg-drawer--host"
      role="dialog"
      aria-modal="false"
      aria-labelledby="pg-host-drawer-title"
    >
      <header className="pg-drawer__header">
        <div className="pg-drawer__heading">
          <h2 id="pg-host-drawer-title" className="pg-drawer__title">
            {host.host}
          </h2>
          {/* STATUS IS STATED TWICE ON PURPOSE, in a dot and in a word. The dot alone would signal
              state by colour, which §7.3 forbids -- and #130 is the case where it mattered: a green
              dot beside "OK" sat unqualified next to three critical findings, because contract Q1 has
              no `Warning` status and a struggling host genuinely reports `OK`. So the badge sits
              BESIDE the status rather than replacing it, exactly as `HostCard` does: the host is
              running, AND Health Scan has something to say about it. */}
          <div className="pg-host-detail__status">
            <StatusDot status={host.status} />
            <span className="pg-host-detail__status-text">{host.status}</span>
            {worst !== null && <SeverityBadge severity={worst} />}
            <span className="pg-host__type">{host.type}</span>
          </div>
        </div>

        <button
          type="button"
          className="pg-button pg-button--icon"
          onClick={onClose}
          aria-label={`Close ${host.host} detail`}
        >
          <IconClose size={15} />
        </button>
      </header>

      <div className="pg-drawer__body">
        <section aria-labelledby="pg-host-graphs-heading">
          <h3 id="pg-host-graphs-heading" className="pg-host-detail__section-title">
            Recent history
          </h3>

          {/* WHAT THE WINDOW ACTUALLY IS, stated rather than implied. The series comes from the
              engine's rolling in-memory baseline (ADR 0002), so it starts at engine start and is
              bounded by the window -- not days of history, and an operator reading a five-minute
              slope should know which. `spanSeconds` is the engine's own clamped answer, so this
              cannot drift from what was served. */}
          {series !== null && series.spanSeconds > 0 && (
            <p className="pg-host-detail__window">
              Up to the last {Math.round(series.spanSeconds / 60)} minutes, sampled every{' '}
              {series.pollIntervalSeconds > 0 ? `${series.pollIntervalSeconds}s` : 'poll'}.
            </p>
          )}

          {GRAPHS.map(({ metric, label }) => {
            const found = byMetric.get(metric);
            return (
              <MetricChart
                key={metric}
                label={label}
                /* An engine that does not serve this metric still gets a chart, drawn in its empty
                   state -- rather than the row silently vanishing, which would look like a layout
                   bug. §2.4's rule: render defensively, never disappear. */
                series={found ?? { metric, unit: 'count', points: [] }}
                pollIntervalSeconds={series?.pollIntervalSeconds ?? 0}
                neverPolled={neverPolled || (seriesLoading && found === undefined)}
              />
            );
          })}

          {/* A host the engine does not report. Normal rather than exceptional: a host can leave the
              production between the poll that drew the card and the click on it. Said plainly instead
              of leaving three empty charts to explain themselves. */}
          {series !== null && !series.known && !neverPolled && (
            <p className="pg-chart__note">
              {host.host} is not in the engine's current host list, so it has no recorded history.
            </p>
          )}
        </section>

        {/* CURRENT VALUES BELOW THE GRAPHS, not above. The graphs are why this panel was opened; the
            numbers are already on the card that opened it, and repeating them first would put a
            second copy of the card above the thing that is new. */}
        <dl className="pg-facts">
          <div className="pg-facts__row">
            <dt>Queued</dt>
            <dd className="pg-facts__mono">{formatCount(host.queued)}</dd>
          </div>
          <div className="pg-facts__row">
            <dt>Msg/sec</dt>
            <dd className="pg-facts__mono">{formatRate(host.messagesPerSec)}</dd>
          </div>
          <div className="pg-facts__row">
            <dt>Errors</dt>
            <dd className="pg-facts__mono">{formatCount(host.errored)}</dd>
          </div>
          <div className="pg-facts__row">
            <dt>Avg processing</dt>
            <dd className="pg-facts__mono">{formatDuration(host.avgProcessingTime)}</dd>
          </div>
          <div className="pg-facts__row">
            <dt>Avg queueing</dt>
            <dd className="pg-facts__mono">{formatDuration(host.avgQueueingTime)}</dd>
          </div>
          <div className="pg-facts__row">
            <dt>Last activity</dt>
            <dd>{formatRelative(host.lastActivity, now)}</dd>
          </div>
        </dl>

        {/* Says what the filtered list below the panel is showing, so the filter is never a silent
            state. `findings` is already this host's; the count is the only claim made here, and the
            rows themselves stay in the list where they are clickable. */}
        <p className="pg-host-detail__filtered">
          {findings.length === 0
            ? 'No findings on this host — the list below is filtered to it and is empty.'
            : `The findings list is filtered to ${host.host}: ` +
              `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}.`}
        </p>
      </div>
    </aside>
  );
}
