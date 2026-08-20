/**
 * Early Warning — the projection strip on a host card.
 *
 * A PROJECTION IS NOT A MEASUREMENT, and this component's whole job is keeping that visible. Every
 * forecast number is prefixed with `~` and the copy says "projected", because `earlywarning-api.md`
 * §1.4 makes it a boundary condition: a forecast presented as a reading is the same defect class as
 * the coerced `lastActivity` in #58, and it is worse here because the number is about the future.
 *
 * IT RENDERS NOTHING WHEN THERE IS NOTHING TO SAY, and that is deliberate rather than lazy. Of the
 * seven decline reasons only three are worth a host card's vertical space:
 *
 *  - `already_crossed` — the threshold is behind us. That is the state a FINDING covers, and the
 *    card already shows the finding count, so repeating it would be noise.
 *  - `not_rising` / `warming` / `insufficient_samples` / `disabled` / `metric_unmeasurable` —
 *    nothing is projected and nothing is wrong. A row saying "no projection available" on every
 *    healthy host would make the grid unreadable for information the operator does not need.
 *
 * So the strip appears only when a projection exists, or when the reason is one an operator would
 * otherwise mistake for silence: `warming` and `insufficient_samples`, which mean "ask again
 * shortly" rather than "there is nothing coming".
 */

import type { HostProjectionView } from '../types/mvp2';

export interface EarlyWarningProps {
  projection: HostProjectionView | null;
}

/** The two reasons worth surfacing: both mean "not yet", not "nothing". */
const PENDING_REASONS: Record<string, string> = {
  warming: 'Baseline still warming — no projection yet',
  insufficient_samples: 'Not enough samples yet for a projection',
};

/**
 * Seconds to a human span, rounded coarsely on purpose.
 *
 * A least-squares fit over a five-minute window does not support "crosses in 7 minutes 12 seconds",
 * and printing that precision would imply a confidence the arithmetic does not have. Minutes below
 * an hour, hours above it.
 */
function horizon(seconds: number): string {
  if (seconds < 90) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.round(minutes / 6) / 10;
  return `~${hours} h`;
}

export function EarlyWarning({ projection }: EarlyWarningProps): JSX.Element | null {
  if (projection === null) return null;

  const { projection: forecast, projectionUnavailable: reason } = projection;

  if (forecast === null) {
    const pending = reason === null ? null : PENDING_REASONS[reason];
    if (pending === undefined || pending === null) return null;
    return (
      <div className="pg-forecast pg-forecast--pending">
        <span className="pg-forecast__label">Early warning</span>
        <span className="pg-forecast__body">{pending}</span>
      </div>
    );
  }

  /* `secondsToThreshold` is null when the crossing is beyond the projection horizon -- the slope is
     positive but the threshold is far enough out that naming a time would be false precision. The
     rate is still worth showing, so the two are rendered independently rather than as one string. */
  const eta = forecast.secondsToThreshold;
  const threshold = projection.threshold?.value ?? null;

  return (
    <div className="pg-forecast">
      <span className="pg-forecast__label">Early warning</span>
      <span className="pg-forecast__body">
        {/* Rising rate first, because it is the measured trend; the crossing time is derived from it
            and is the softer of the two claims. */}
        {projection.metric} rising ~{forecast.slope.toFixed(1)}/min
        {eta !== null && threshold !== null && (
          <>
            {' · projected to cross '}
            <span className="pg-facts__mono">{threshold}</span>
            {` in ${horizon(eta)}`}
          </>
        )}
        {eta === null && ' · crossing is beyond the projection horizon'}
      </span>
    </div>
  );
}
