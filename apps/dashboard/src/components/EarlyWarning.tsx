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
 * AND IT NOW SAYS WHICH WAY THE QUEUE IS MOVING (#174). "Threshold reached" was the whole sentence for
 * a queue climbing and for a queue draining after an approved fix — measured at 110 seconds of
 * indistinguishable output on the live scenario, against ~20 seconds in which a real forecast exists
 * at all. `recentDirection` (§1.5) is measured and published on every row, so the three states get
 * three sentences. See `CROSSED_BY_DIRECTION`, including why none of them earns the tick.
 *
 * Still silent for `disabled` and `metric_unmeasurable`: those are steady states on a
 * healthy host, and a row saying "no projection available" on every card would make the grid
 * unreadable for information nobody needs. `warming` and `insufficient_samples` render because they
 * mean "ask again shortly" rather than "nothing is coming". `not_rising` renders too — see
 * `SHOWN_REASONS` for why that changed, and why it is the only one that earns an icon.
 *
 * ONE REASON CARRIES AN ICON, AND ONLY ONE. `not_rising` is the sole state whose whole content is
 * reassurance, so a tick makes it readable at a glance instead of as a line of grey text among five
 * metric rows — asked for after the text-only version shipped, because grey prose next to a queue
 * depth does not read as "this is fine". The other three states are deliberately left plain:
 * `already_crossed` is a *spent* forecast reporting that the bad thing happened, and `warming` /
 * `insufficient_samples` mean "not yet". A tick on any of them would assert something none of them
 * claims, which is the same class of over-reassurance as the summary tile counting a host with three
 * critical findings as OK. The icon is decorative only, `aria-hidden` through `icons.tsx`'s shared
 * `svg()` wrapper; the sentence beside it stays the authoritative statement (§7.3).
 */

import type { HostProjectionView, RecentDirection } from '../types/mvp2';
import { IconWatching } from './icons';

export interface EarlyWarningProps {
  projection: HostProjectionView | null;
}

/**
 * The reasons worth a row, and what each says.
 *
 * `already_crossed` is the one that earns its place by NOT being a forecast: it marks the module as
 * present and watching after the window has closed. The other two mean "ask again shortly".
 */
/**
 * `already_crossed`, by which way the queue is actually moving (§1.5, #174).
 *
 * THE SAME REASON MEANT TWO OPPOSITE THINGS and read as one sentence. Measured on the live stack: an
 * armed `queue_buildup` fixed by enlarging the pool drained from 152 to 54 over 22 consecutive polls —
 * 110 seconds — every one `already_crossed`, rendering identically to the climb through the same
 * depths. An operator watching a fix work was told only that the threshold had been reached.
 *
 * STILL NO TICK, in any of the three. The icon is reserved for `not_rising`, whose whole content is
 * reassurance; a crossed threshold is a live problem however it is moving, and a tick beside "coming
 * down" would be the over-reassurance this file's header argues against — the same class as the
 * summary tile counting a host with three criticals as OK. The tone stays `--spent` for the same
 * reason: recovering is not resolved.
 *
 * A null direction falls back to the unqualified sentence, which is exactly the pre-#174 string. No
 * claim is made when the engine makes none.
 */
const CROSSED_BY_DIRECTION: Record<RecentDirection, string> = {
  rising: 'Threshold reached and still rising — see the finding below',
  falling: 'Threshold reached — coming down now; see the finding below',
  steady: 'Threshold reached — holding steady; see the finding below',
};

const SHOWN_REASONS: Record<string, string> = {
  warming: 'Baseline still warming — no projection yet',
  insufficient_samples: 'Not enough samples yet for a projection',
  already_crossed: 'Threshold reached — see the finding below',
  /*
   * `not_rising` was silent, and that made the module INVISIBLE on a healthy production — which is
   * every demo before a trigger is armed, and is what "I don't see the early warning" meant
   * (@Ari-Glikman). The projection only appears in the narrow window where a metric is rising but
   * has not yet crossed, roughly 100 seconds on the queue scenario, so anyone looking outside that
   * window saw nothing at all and reasonably concluded the feature was missing.
   *
   * This is the SAME defect the comment above records for `already_crossed`, in the opposite
   * direction: hiding a steady state hides the fact that anything is watching. The earlier reasoning
   * -- "those are steady states on a healthy host and a row per host saying nothing is noise" -- is
   * right about the noise and wrong about the cost. A module that is silent when there is nothing to
   * report is indistinguishable from a module that does not exist, and an operator cannot tell which
   * they have.
   *
   * So it renders as a WATCHING state rather than a forecast, and reads as reassurance rather than
   * as a pending result. `pg-forecast--quiet` styles it below the pending tone so three calm rows do
   * not compete with a real projection when one appears.
   */
  not_rising: 'Watching — not trending toward a threshold',
};

/**
 * Reasons that mean "nothing is happening", styled quieter than a pending forecast.
 *
 * This set is also what earns the checkmark, deliberately as one condition rather than two: quiet
 * and reassuring are the same property here, and a second set listing the same member would let the
 * tone and the icon disagree the next time either changes.
 */
const QUIET_REASONS = new Set(['not_rising']);

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
    /* `already_crossed` is the one reason whose sentence depends on a second field, so it is resolved
       here rather than by widening SHOWN_REASONS into a nested map that three other reasons would
       carry a null key for. */
    const direction = projection.recentDirection;
    const shown =
      reason === 'already_crossed' && direction !== null
        ? CROSSED_BY_DIRECTION[direction]
        : reason === null
          ? undefined
          : SHOWN_REASONS[reason];
    if (shown === undefined) return null;
    /* `already_crossed` reads as spent rather than pending -- it is not waiting for anything, it is
       reporting that the thing it was watching for has happened. The other two are genuinely
       "not yet", so they keep the muted pending styling. */
    const spent = reason === 'already_crossed';
    const quiet = reason !== null && QUIET_REASONS.has(reason);
    const tone = spent
      ? 'pg-forecast--spent'
      : quiet
        ? 'pg-forecast--quiet'
        : 'pg-forecast--pending';
    return (
      <div className={`pg-forecast ${tone}`}>
        <span className="pg-forecast__label">Early warning</span>
        <span className="pg-forecast__body">
          {/* Inside the body rather than beside the label, so the tick sits against the sentence it
              reinforces and wraps with it. Decorative reinforcement only — the text is the claim. */}
          {quiet && <IconWatching size={13} className="pg-forecast__icon" />}
          {shown}
        </span>
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
