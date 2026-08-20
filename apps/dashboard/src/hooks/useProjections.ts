/**
 * Early Warning projections, on the same cadence as the findings poll.
 *
 * WHY IT PIGGYBACKS ON `failureCount` RATHER THAN OWNING A TIMER. `usePolling` already decides when
 * to fetch — it pauses while the tab is hidden, backs off on failure, and refetches on becoming
 * visible. A second interval here would drift out of step within minutes, so a card could show a
 * queue depth from one moment beside a projection from another. Two readings pretending to be one
 * is the defect `earlywarning-api.md` §1.4 is written against, one level up.
 *
 * `failureCount` changes on every tick (success resets it to 0, failure increments), which makes it
 * a usable "the poll just happened" signal without threading a new callback through `usePolling`.
 * That is a little indirect and it is the reason this comment exists.
 *
 * FAILURES ARE SWALLOWED, DELIBERATELY. A projection is decoration on a card whose metrics are real;
 * losing the forecast must not blank the card or raise the connection banner. So the previous value
 * is kept on error rather than cleared — a stale projection is labelled `~` and projected either
 * way, and an empty strip says less than an old one.
 */

import { useEffect, useRef, useState } from 'react';
import type { HealthScanApi } from '../api/HealthScanApi';
import type { HostProjectionView } from '../types/mvp2';

export function useProjections(api: HealthScanApi, tick: number): HostProjectionView[] {
  const [projections, setProjections] = useState<HostProjectionView[]>([]);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    void api
      .getProjections(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setProjections(next);
      })
      .catch(() => {
        /* Intentionally empty. See the header: the forecast is the least important thing on a host
           card, and it must not be able to disturb the two things that are not. */
      });

    return () => controller.abort();
    // `api` changes when the mode switches, which should refetch; `tick` is the poll signal.
  }, [api, tick]);

  /* Cleared when the client changes, so a demo-mode projection cannot linger over live metrics --
     the two clients describe different worlds and mixing them is how #74's "seen ids" bug happened. */
  useEffect(() => {
    setProjections([]);
  }, [api]);

  return projections;
}
