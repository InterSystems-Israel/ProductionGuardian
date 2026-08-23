/**
 * One host's metric series, refetched on the same cadence as the findings poll.
 *
 * WHY IT PIGGYBACKS ON `failureCount` RATHER THAN OWNING A TIMER — the same reasoning as
 * `useProjections`, which this deliberately mirrors rather than reinventing. `usePolling` already
 * pauses while the tab is hidden, backs off on failure and refetches on becoming visible; a second
 * interval here would drift out of step, so the panel's graphs could show a moment the cards do not.
 *
 * KEYED ON THE SELECTED HOST, and `null` means no request at all. The panel is closed most of the
 * time and a series is the largest payload the dashboard fetches, so nothing is asked for until a
 * host is selected.
 *
 * THE SERIES MUST SURVIVE A POLL, WHICH IS THE DEFECT THIS HOOK EXISTS TO AVOID. The dashboard
 * repolls every 2s, and a panel that flickers or empties on each tick is worse than no panel. Two
 * things guarantee it:
 *
 *  1. **The previous series is KEPT while the next request is in flight.** `setSeries` runs only on
 *     a successful parse, so a tick never passes through an empty state on its way to fresh data.
 *     Clearing first and refilling is what makes a chart blink twice a second.
 *  2. **A failed or unparseable fetch changes nothing.** A graph is decoration over metric rows
 *     that are real; losing it must not blank the panel or raise the connection banner. Identical to
 *     `useProjections`, and for the identical reason.
 *
 * The series is cleared in exactly two places, both of which are a change of subject rather than a
 * refresh: selecting a different host, and switching client (demo/live). Carrying points across
 * either would draw one host's history under another's name, or demo fixtures under a live heading —
 * the #74 class of bug.
 */

import { useEffect, useRef, useState } from 'react';
import type { HealthScanApi } from '../api/HealthScanApi';
import type { HostSeriesView } from '../types/hostseries';

export interface UseHostSeriesResult {
  series: HostSeriesView | null;
  /**
   * True until the first response for the CURRENT host lands.
   *
   * Distinguishes "we have not asked yet" from "we asked and there is no history", which the panel
   * renders differently — the first is transient and the second is a statement about the host. False
   * on every subsequent tick, so the panel never re-enters a loading state it has already left.
   */
  loading: boolean;
}

export function useHostSeries(
  api: HealthScanApi,
  host: string | null,
  tick: number,
): UseHostSeriesResult {
  const [series, setSeries] = useState<HostSeriesView | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  /* Cleared when the SUBJECT changes -- a different host, or a different client. Deliberately not in
     the fetch effect below, which also runs on `tick`: clearing there would empty the panel twice a
     second and refill it, which is exactly the flicker this hook is written to prevent.

     Runs before the fetch effect for the same render (effects fire in declaration order), so a
     selection change blanks the old host's data and immediately requests the new host's rather than
     briefly showing the wrong series under the right name. */
  useEffect(() => {
    setSeries(null);
    setLoading(host !== null);
  }, [api, host]);

  useEffect(() => {
    if (host === null) return undefined;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    void api
      .getHostSeries(host, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        /* A null parse leaves the previous series in place rather than clearing it: an unreadable
           payload is not evidence that the history went away. */
        if (next !== null) setSeries(next);
      })
      .catch(() => {
        /* Intentionally empty, and `loading` is deliberately NOT cleared here. A transport failure
           means we still do not know whether this host has history, and reporting "no data" would
           state something we have not learned. The connection banner already owns the fact that
           requests are failing. */
      });

    return () => controller.abort();
    // `tick` is the poll signal; `api` changes on a mode switch; `host` is the selection.
  }, [api, host, tick]);

  return { series, loading };
}
