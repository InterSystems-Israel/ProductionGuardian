/**
 * Finding detail — a right-hand drawer, deliberately not a modal, so the operator
 * keeps seeing the grid behind it (§7.2).
 *
 * **Current vs. baseline side by side is the whole point of this view**, so it is
 * the visual focus: two large monospaced numerals with the comparison between
 * them. Everything else here is supporting context.
 *
 * MVP 2 ADDED BOTH THINGS THIS COMMENT USED TO FORBID. It read: "no remediation
 * control (Smart Resolve), and no root-cause narrative or confidence score (AI
 * Detective)" — correct under MVP 1's boundary, and root `CLAUDE.md` §2.1 moved
 * all three modules in scope. The comparison below is still the visual focus and
 * still renders without an investigation; the panel is opt-in, behind a button, so
 * a drawer opened to read a number does not fire an LLM call.
 *
 * What has NOT changed is who draws the conclusion on a write: the panel proposes,
 * an operator approves, and nothing is applied unattended.
 *
 * Accessibility (§7.3): closes on `Esc` and returns focus to the row that opened
 * it, which is why `onClose` is called rather than the row being re-focused here —
 * the list owns row identity, this component does not.
 */

import { useEffect } from 'react';
import type { FindingView } from '../types/healthscan';
import { comparesToBaseline, findingMeta, valueKind } from '../lib/findingMeta';
import { toSeverity } from '../lib/severity';
import {
  ABSENT,
  formatAbsoluteUtc,
  formatComparison,
  formatCount,
  formatDuration,
  formatRate,
  formatRelative,
} from '../lib/format';
import { SeverityBadge } from './SeverityBadge';
import { IconClose } from './icons';

export interface FindingDetailProps {
  /** The selected finding, or null when the drawer is closed. */
  finding: FindingView | null;
  now: number;
  onClose: () => void;
  /**
   * The MVP 2 panel, passed in rather than built here.
   *
   * This component takes no `api` and owns no request state -- §4.1 keeps `fetch` out of
   * components, and threading a client through the drawer would put the LLM call one prop away from
   * a purely presentational view. The owner wires `useInvestigation` and hands the rendered panel
   * down, so the drawer stays renderable in a test with no client at all.
   *
   * Absent, the drawer is exactly the MVP 1 view.
   */
  investigation?: JSX.Element | null;
}

/**
 * Formats a value according to what the metric measures — a queue depth is a
 * count, a processing time is a duration, throughput is a rate. The contract
 * carries no unit, so this is derived from the finding type (`valueKind`).
 */
function formatValue(value: number | null, kind: ReturnType<typeof valueKind>): string {
  if (value === null) return ABSENT;
  if (kind === 'duration') return formatDuration(value);
  if (kind === 'rate') return `${formatRate(value)}/s`;
  return formatCount(value);
}

/** The same unit, for the signed delta `formatComparison` falls back to. */
function deltaFormatter(kind: ReturnType<typeof valueKind>): (value: number) => string {
  if (kind === 'duration') return formatDuration;
  if (kind === 'rate') return (value) => `${formatRate(value)}/s`;
  return formatCount;
}

export function FindingDetail({
  finding,
  now,
  onClose,
  investigation = null,
}: FindingDetailProps): JSX.Element | null {
  /* Esc closes from anywhere, not only from inside the drawer: the operator's
     focus is often still on the row that opened it, since that row deliberately
     keeps focus for the return trip. Bound to the document for that reason. */
  useEffect(() => {
    if (finding === null) return undefined;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [finding, onClose]);

  if (finding === null) return null;

  const meta = findingMeta(finding.type);
  const kind = valueKind(finding.type);
  const severity = toSeverity(finding.severity);

  /* A null baseline has two unrelated causes and they must not be described the same
     way: the baseline is still warming up, or this rule never had one. Only the first
     is temporary, and calling an absolute finding "still warming up" understates a
     `dead_host` as provisional when it is the most certain thing on screen. */
  const absent = finding.baselineValue === null;
  const comparative = comparesToBaseline(finding.type);
  const warming = absent && comparative;
  const noBaselineApplies = absent && !comparative;

  return (
    /* `aria-labelledby` points at the heading rather than duplicating the label as
       an `aria-label`, so the accessible name cannot drift from the visible one. */
    <aside
      className="pg-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="pg-drawer-title"
    >
      <header className="pg-drawer__header">
        <div className="pg-drawer__heading">
          <SeverityBadge severity={finding.severity} />
          <h2 id="pg-drawer-title" className="pg-drawer__title">
            <meta.Icon size={16} />
            {meta.label}
          </h2>
        </div>

        <button
          type="button"
          className="pg-button pg-button--icon"
          onClick={onClose}
          aria-label="Close finding detail"
        >
          <IconClose size={15} />
        </button>
      </header>

      <div className="pg-drawer__body">
        {/* The comparison — the reason this view exists. */}
        <section className={`pg-compare pg-compare--${severity}`} aria-label="Current value versus baseline">
          <div className="pg-compare__pair">
            <div className="pg-compare__side">
              <span className="pg-compare__label">Current</span>
              <span className="pg-compare__value">{formatValue(finding.currentValue, kind)}</span>
            </div>

            <div className="pg-compare__side pg-compare__side--baseline">
              {/* Labelled "Baseline" only when there is one to speak of. For an
                  absolute rule the em dash is the honest value, but under a
                  "Baseline" heading it reads as missing data rather than as
                  inapplicable. */}
              <span className="pg-compare__label">
                {noBaselineApplies ? 'Baseline (n/a)' : 'Baseline'}
              </span>
              <span className="pg-compare__value">{formatValue(finding.baselineValue, kind)}</span>
            </div>
          </div>

          {/* A ratio only informs against a meaningful non-zero baseline;
              `formatComparison` falls back to a delta and to '—' while warming. */}
          <p className="pg-compare__delta">
            {noBaselineApplies
              ? 'Detected outright — no baseline comparison applies'
              : warming
                ? 'No baseline yet — still warming up'
                : formatComparison(
                    finding.currentValue,
                    finding.baselineValue,
                    deltaFormatter(kind),
                  )}
          </p>
        </section>

        {/* Dev B's string, rendered as-is and never reconstructed (§2.4). It is
            the authoritative description of what happened. */}
        <p className="pg-drawer__message">{finding.message}</p>

        <dl className="pg-facts">
          <div className="pg-facts__row">
            <dt>Host</dt>
            <dd>{finding.host}</dd>
          </div>

          <div className="pg-facts__row">
            <dt>Metric</dt>
            <dd className="pg-facts__mono">
              {meta.metric ?? <span className="pg-facts__absent">{ABSENT}</span>}
            </dd>
          </div>

          <div className="pg-facts__row">
            <dt>Detected</dt>
            {/* Relative for "how long has this been going", absolute UTC because
                that is what correlates against a log (§7.2). */}
            <dd>
              {formatRelative(finding.detectedAt, now)}
              <span className="pg-facts__sub pg-facts__mono">
                {formatAbsoluteUtc(finding.detectedAt)}
              </span>
            </dd>
          </div>

          <div className="pg-facts__row">
            <dt>Severity</dt>
            <dd>{severity.charAt(0).toUpperCase() + severity.slice(1)}</dd>
          </div>
        </dl>

        {meta.unknown && (
          /* An unrecognized type still renders (§2.4). Saying so is honest about
             why the metric row is empty, rather than looking like a bug. */
          <p className="pg-drawer__note">
            This finding type is not one the dashboard recognizes, so no IRIS metric is
            shown. The message above is still the engine's own description.
          </p>
        )}

        {warming && (
          <p className="pg-drawer__note">
            The rolling baseline needs a few minutes of samples after the engine starts.
            Until then this finding comes from an absolute threshold rather than a
            comparison.
          </p>
        )}

        {noBaselineApplies && (
          /* Says why the baseline is empty for a rule that never has one, so the
             em dash reads as "not applicable" rather than "not loaded yet". */
          <p className="pg-drawer__note">
            {meta.label} is detected directly from {meta.metric ?? 'the reported state'},
            so there is no baseline to compare against. This finding does not depend on
            the engine having warmed up.
          </p>
        )}

        {/* LAST in the body, deliberately: the comparison is what the operator came for, and an
            investigation is what they do next. Reversing them would put a paragraph of narrative
            above the two numbers this view exists to show. */}
        {investigation}
      </div>
    </aside>
  );
}
