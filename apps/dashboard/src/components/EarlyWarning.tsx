/**
 * Early Warning — the projection strip on a host card.
 *
 * A PROJECTION IS NOT A MEASUREMENT, and this component's whole job is keeping that visible. Every
 * forecast number is prefixed with `~` and the copy says "projected", because `earlywarning-api.md`
 * §1.4 makes it a boundary condition: a forecast presented as a reading is the same defect class as
 * the coerced `lastActivity` in #58, and it is worse here because the number is about the future.
 *
 * WHAT IT RENDERS, AND THE ONE CASE THAT CHANGED. Measured on the live stack: a projection exists
 * for roughly 100 seconds of a queue_buildup run — from the queue starting to rise until it crosses
 * the threshold. Before that the slope is too flat to fit; after it, `already_crossed`.
 *
 *     q=9    (not_rising)
 *     q=19   slope=1.5/min  eta=1240s     <- strip appears
 *     q=49   slope=8.6/min  eta=7s
 *     q=58   (already_crossed)            <- strip used to vanish here
 *
 * The first version hid `already_crossed` entirely, reasoning that the state is covered by a
 * FINDING and repeating it would be noise. That reasoning is sound and the consequence was not:
 * **an operator looking at the grid a minute later saw nothing at all**, and reasonably concluded
 * Early Warning was not implemented. Reported by the user, who could not find it on screen.
 *
 * So `already_crossed` now renders as a spent forecast — "threshold reached, see the finding" —
 * which is honest about there being no forecast left to make while leaving evidence that the module
 * exists and was watching. A feature nobody can find is indistinguishable from a missing one.
 *
 * Still silent for `not_rising`, `disabled` and `metric_unmeasurable`: those are steady states on a
 * healthy host, and a row saying "no projection available" on every card would make the grid
 * unreadable for information nobody needs. `warming` and `insufficient_samples` render because they
 * mean "ask again shortly" rather than "nothing is coming".
 */

import type { HostProjectionView } from '../types/mvp2';

export interface EarlyWarningProps {
  projection: HostProjectionView | null;
}

/**
 * The reasons worth a row, and what each says.
 *
 * `already_crossed` is the one that earns its place by NOT being a forecast: it marks the module as
 * present and watching after the window has closed. The other two mean "ask again shortly".
 */
const SHOWN_REASONS: Record<string, string> = {
  warming: 'Baseline still warming — no projection yet',
  insufficient_samples: 'Not enough samples yet for a projection',
  already_crossed: 'Threshold reached — see the finding below',
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
    const shown = reason === null ? undefined : SHOWN_REASONS[reason];
    if (shown === undefined) return null;
    /* `already_crossed` reads as spent rather than pending -- it is not waiting for anything, it is
       reporting that the thing it was watching for has happened. The other two are genuinely
       "not yet", so they keep the muted pending styling. */
    const spent = reason === 'already_crossed';
    return (
      <div className={`pg-forecast ${spent ? 'pg-forecast--spent' : 'pg-forecast--pending'}`}>
        <span className="pg-forecast__label">Early warning</span>
        <span className="pg-forecast__body">{shown}</span>
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
