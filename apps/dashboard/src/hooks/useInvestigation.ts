/**
 * The WHY → FIX request lifecycle for one finding.
 *
 * Owns four things the drawer should not: the in-flight flags, the abort on unmount or finding
 * change, the transport-error message, and the last resolve outcome. The panel below it renders
 * state and never calls the API — same split as `useHealthScan` and `FindingsList`.
 *
 * ONE INVESTIGATION PER FINDING, DISCARDED WHEN THE SELECTION CHANGES. An investigation is about a
 * specific finding, and showing a previous finding's root cause under a new heading is the kind of
 * mistake nobody notices on stage. So the state is keyed by finding id and cleared when it moves.
 *
 * WHY THE ABORT MATTERS HERE MORE THAN FOR POLLING. An investigation is an LLM round trip —
 * measured at 8.5s against `gpt-4o-mini` through the nginx proxy. That is long enough for an
 * operator to close the drawer, and a late response landing in a closed drawer would either throw
 * on a dead setState or, worse, repopulate a panel the operator had dismissed.
 *
 * A REFUSAL IS NOT AN ERROR. `outcome: "refused"` resolves normally and is kept in `resolve`, not in
 * `error`. `error` is only for a transport or shape failure — the difference between "the system
 * declined, here is why" and "we could not ask".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthScanApi } from '../api/HealthScanApi';
import type { InvestigationView, ResolveActionView, ResolveMode, ResolveView } from '../types/mvp2';

export interface InvestigationState {
  investigation: InvestigationView | null;
  investigating: boolean;
  /** Transport or shape failure only. A refused resolve is in `resolve`. */
  error: string | null;
  resolve: ResolveView | null;
  /** Which mode is in flight, so the two buttons can show progress independently. */
  resolving: ResolveMode | null;
  resolveError: string | null;
}

export interface InvestigationActions {
  investigate: () => void;
  applyAction: (mode: ResolveMode, action: ResolveActionView) => void;
  reset: () => void;
}

const EMPTY: InvestigationState = {
  investigation: null,
  investigating: false,
  error: null,
  resolve: null,
  resolving: null,
  resolveError: null,
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request failed';
}

export function useInvestigation(
  api: HealthScanApi,
  findingId: string | null,
): InvestigationState & InvestigationActions {
  const [state, setState] = useState<InvestigationState>(EMPTY);

  /* One controller for both calls: closing the drawer or changing finding should abandon whatever
     is in flight, and the two are never usefully concurrent (you approve what you investigated). */
  const inFlight = useRef<AbortController | null>(null);
  const currentId = useRef<string | null>(findingId);

  const abort = useCallback((): void => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);

  /* Clear on selection change, and on unmount. Without the id guard in the callbacks below this
     would still race: an in-flight investigation for finding A can resolve after the operator has
     selected B, and `setState` would attach A's narrative to B. */
  useEffect(() => {
    currentId.current = findingId;
    abort();
    setState(EMPTY);
    return abort;
  }, [findingId, abort]);

  const investigate = useCallback((): void => {
    if (findingId === null) return;
    abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const requestedFor = findingId;

    setState((prev) => ({ ...prev, investigating: true, error: null }));

    void api
      .investigate(requestedFor, controller.signal)
      .then((investigation) => {
        if (controller.signal.aborted || currentId.current !== requestedFor) return;
        setState((prev) => ({ ...prev, investigation, investigating: false, error: null }));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || currentId.current !== requestedFor) return;
        setState((prev) => ({ ...prev, investigating: false, error: message(cause) }));
      });
  }, [api, findingId, abort]);

  const applyAction = useCallback(
    (mode: ResolveMode, action: ResolveActionView): void => {
      if (findingId === null) return;
      const controller = new AbortController();
      inFlight.current = controller;
      const requestedFor = findingId;

      setState((prev) => ({ ...prev, resolving: mode, resolveError: null }));

      void api
        .resolve(mode, action, { findingId: requestedFor }, controller.signal)
        .then((resolve) => {
          if (controller.signal.aborted || currentId.current !== requestedFor) return;
          setState((prev) => ({ ...prev, resolve, resolving: null, resolveError: null }));
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || currentId.current !== requestedFor) return;
          /* A failed APPLY is the one case where the operator must be told to check by hand: the
             request may have landed. The panel says so from `resolve.failure.liveStateVerified`
             when the engine answered; this path is for when it did not answer at all. */
          setState((prev) => ({ ...prev, resolving: null, resolveError: message(cause) }));
        });
    },
    [api, findingId],
  );

  const reset = useCallback((): void => {
    abort();
    setState(EMPTY);
  }, [abort]);

  return { ...state, investigate, applyAction, reset };
}
