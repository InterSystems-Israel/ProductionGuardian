/**
 * Early Warning — the projection strip on a host card.
 *
 * A PROJECTION IS NOT A MEASUREMENT, and this component's whole job is keeping that visible. Every
 * forecast number is prefixed with `~` and the copy says "projected", because `earlywarning-api.md`
 * §1.4 makes it a boundary condition: a forecast presented as a reading is the same defect class as
 * the coerced `lastActivity` in #58, and it is worse here because the number is about the future.
 *
 * WHAT IT RENDERS, AND THE ONE CASE THAT CHANGED. A projection exists from the first rising poll
 * until the queue crosses the threshold, then `already_crossed`. Measured on the captured
 * `pool_bottleneck` series (floor 50, crossed 50s after the ramp starts), replayed through the
 * engine — these are the numbers the strip shows since #237 moved the fit to the 45s tail:
 *
 *     q=0    (not_rising)
 *     q=4    slope=0.2/min  eta=1062s     <- strip appears, on the FIRST rising poll
 *     q=17   slope=21.5/min eta=92s
 *     q=34   slope=48.0/min eta=20s       <- exact: the true crossing is 20s out
 *     q=47   slope=48.0/min eta=4s
 *     q=54   (already_crossed)            <- strip used to vanish here
 *
 * The eta was ~20x too long and the first four polls declined `beyond_horizon` until #237. Both were
 * the same divisor: a 300s window fit is ~85% flat-at-zero prefix on a 50s ramp, so least squares
 * averaged two regimes. Neither the horizon nor this component was wrong.
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
 * `REASON_SENTENCES` for why that changed, and why it is the only one that earns an icon.
 *
 * AND `beyond_horizon` RENDERS, WHICH IS THE THIRD TIME THIS FILE HAS LEARNED THE SAME THING. It had
 * no entry in the sentence map, so the row vanished for the 20 seconds it is returned — measured on
 * the live stack, `pool_bottleneck`, engine polls at `q=4,7,14,17`: the queue is *visibly climbing*
 * and the panel is blank, between "Watching" and the forecast. Reported as "the early warning is not
 * shown and then after a while it shows warning/rising. why is there a time that nothing is
 * displayed?" (@Ari-Glikman). The blank is 20s against a forecast that lasts 25s, so the module is
 * absent for nearly half the window it exists for.
 *
 * #237 then removed the *cause* — those four polls now carry a projection — but the sentence stays,
 * and the ordering is the point: this fix was right on its own terms and would still be right if the
 * engine change were reverted. A reason with no sentence is a blank row whenever it is returned, and
 * `beyond_horizon` is still returned by a genuinely slow rise. Fixing the display of a state is not
 * the same as making the state rarer, and a fix that only holds because a state stopped occurring is
 * not a fix.
 *
 * The reason it was missed three times is that the map was a `Record<string, string>`, which accepts
 * any subset of the reasons in silence. It is now `Record<ProjectionDeclineReason, string | null>`, so
 * a reason with no sentence is a **compile error** and choosing silence has to be written down as an
 * explicit `null`. Same move as `validate-architecture.mjs`'s header describes for coordinates: a
 * missing one was made impossible rather than documented.
 *
 * Note the engine does NOT publish the slope on this row — `earlywarning-api.md` §1.4 forbids a slope
 * outside `projection`, and a decline has no `projection` — so the sentence is qualitative. The rate
 * is withheld by the contract, not lost.
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

import type { HostProjectionView, ProjectionDeclineReason, RecentDirection } from '../types/mvp2';
import { IconWatching } from './icons';

export interface EarlyWarningProps {
  projection: HostProjectionView | null;
}

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

/**
 * Every decline reason's sentence, or `null` for the two that stay silent.
 *
 * TOTAL OVER THE UNION, which is the whole point. This was `Record<string, string>` holding only the
 * reasons that speak, and a partial map of a closed union is a blank row waiting to happen — it
 * happened three times (see the file header). Now `tsc` fails when `ProjectionDeclineReason` gains a
 * member, and choosing silence means writing `null` next to it rather than leaving it out.
 *
 * `disabled` and `metric_unmeasurable` are the two nulls, and they are steady states on a host nothing
 * is happening to: Early Warning is off, or the host reports no `queued` at all (contract Q13 — null
 * is "not measurable", never zero). A row per card saying so is noise on every poll forever.
 */
const REASON_SENTENCES: Record<ProjectionDeclineReason, string | null> = {
  disabled: null,
  metric_unmeasurable: null,
  warming: 'Baseline still warming — no projection yet',
  insufficient_samples: 'Not enough samples yet for a projection',
  already_crossed: 'Threshold reached — see the finding below',
  /*
   * Rising, but the crossing is further out than the engine's horizon (30 min on the shipped
   * config), so it declines to name a time. The rate is not available to say (§1.4, see the header),
   * so this says the direction and the reason there is no ETA, and nothing it cannot support.
   *
   * NO LONGER THE FIRST FOUR POLLS OF A QUEUE BUILD, which is what this comment said until #237.
   * That reading was an artefact of the 300s window fit understating a 50s ramp by ~20x; the tail fit
   * projects from the first rising poll. What reaches here now is a rise that really is slower than
   * 30 minutes to threshold — a real state, no longer a transient one on the demo path.
   */
  beyond_horizon: 'Rising — a crossing is beyond the projection horizon',
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
 * A least-squares fit over a 45-second tail (§1.1, as amended by #237) does not support "crosses in
 * 7 minutes 12 seconds", and printing that precision would imply a confidence the arithmetic does not
 * have. Minutes below an hour, hours above it.
 *
 * The span in that first sentence read "five-minute window" until #237, and the shorter span makes the
 * argument stronger rather than weaker: a ~9-sample fit is jumpier than a 60-sample one, which is the
 * cost #237 accepted in exchange for the eta being right. So the coarse rounding is now doing more
 * work, not less — it absorbs the jitter that would otherwise show as an eta flicking between
 * neighbouring seconds every poll.
 *
 * ONE CONSEQUENCE WORTH KNOWING BEFORE MAKING THIS FINER. Everything under 90s reads "under a minute",
 * and on the shipped `pool_bottleneck` ramp the last ~30s of the build sits in that bucket, so the
 * strip stops visibly tightening near the end. That is deliberate: the tightening is carried by the
 * RATE and by the queue depth beside it, both of which are measurements, and buying a countdown here
 * would mean printing seconds off a nine-sample fit.
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
       here rather than by widening REASON_SENTENCES into a nested map that the other reasons would
       carry a null key for. */
    const direction = projection.recentDirection;
    const shown =
      reason === 'already_crossed' && direction !== null
        ? CROSSED_BY_DIRECTION[direction]
        : reason === null
          ? null
          : REASON_SENTENCES[reason];
    /* Null covers both "the engine declined for no stated reason" and the two reasons that are
       deliberately silent. Neither renders, and REASON_SENTENCES is where the second is argued. */
    if (shown === null) return null;
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
