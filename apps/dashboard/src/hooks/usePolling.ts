/**
 * The dashboard's single timer.
 *
 * Rules from §4.4, all of them load-bearing during a demo:
 *  - one timer only — two stacked intervals double the request rate and make
 *    "last updated" meaningless
 *  - abort the in-flight request before each new tick and on unmount
 *  - pause while `document.hidden`, refetch immediately on becoming visible
 *  - back off by doubling the interval on each failure, capped at 30s, reset on
 *    the first success — the sequence is derived from the interval, not fixed, so
 *    it moves with `VITE_POLL_INTERVAL_MS` rather than being restated here
 *
 * Everything funnels through one `schedule()`/`runAndReschedule()` pair, and
 * every entry point clears the pending timer first. Rescheduling logic lives in
 * exactly one place so a visibility change and a manual retry cannot each leave
 * a timer chain running.
 *
 * OTHER HOOKS RIDE THIS TIMER RATHER THAN OWNING ONE, which is what makes the
 * "one timer only" rule above true of the whole page rather than only of this
 * file. `useProjections` and `useHostSeries` each key an effect on `tickCount`
 * and get the pausing, the backoff and the visibility catch-up for free. That
 * makes `tickCount` part of this hook's contract, not an incidental return —
 * see its doc comment for what using `failureCount` for it cost.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 2s, not 5s (#44).
 *
 * This poll is the last stage between a change in IRIS and a change on screen, and once
 * Dev B measured the engine-visible latency at 6.0-7.2s it became the largest single
 * remaining term: a 5s poll put the worst case at 11-12s against a 10s bar. Every upstream
 * stage is gated by an invariant that makes shortening it a trade -- the proxy's scrape rate
 * against a customer instance, and the engine's `sustainedSeconds` debounce, which is the
 * false-positive protection MVP §6 asks for and which puts a hard floor at its shipped 5000ms
 * (#64). This stage is gated by nothing: the engine serves from memory and no correctness
 * property depends on how often we ask.
 *
 * So it is the one term to spend. Halving it again would buy a second and cost nothing
 * either, but 2s already brings the worst case under the bar and the returns stop there.
 */
const DEFAULT_INTERVAL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

/** Poll cadence from `VITE_POLL_INTERVAL_MS`, falling back to 2s. */
export function pollIntervalMs(): number {
  const raw = import.meta.env.VITE_POLL_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  // A zero or negative interval would spin; ignore nonsense and use the default.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

export interface UsePollingOptions {
  /** Called on each tick. Must reject to trigger backoff. */
  onTick: (signal: AbortSignal) => Promise<void>;
  intervalMs: number;
}

export interface UsePollingResult {
  /** Current delay, which grows while ticks keep failing. */
  currentDelayMs: number;
  /** Consecutive failures; 0 after any success. Drives the banner's escalation. */
  failureCount: number;
  /**
   * Completed ticks, counting from 0 and incrementing on EVERY tick regardless of outcome.
   *
   * THE POLL SIGNAL FOR HOOKS THAT RIDE THIS TIMER, and it exists because `failureCount` was being
   * used as one and is not one. `useProjections` and `useHostSeries` both keyed an effect on
   * `failureCount`, documenting it as "changes on every tick (success resets it to 0, failure
   * increments)" — but a success after a success resets 0 to 0, which is not a change, so React
   * re-ran neither effect. On a healthy stack both fetched exactly ONCE and never again. Measured in
   * the served bundle over 14s at a 2s cadence: 1 request to `/api/hostseries` and 0 to
   * `/api/earlywarning` against 6 to `/hosts`.
   *
   * So the signal only worked while the API was failing, which is the inverse of when anyone is
   * watching. A monotonic counter cannot have that failure mode: it changes on every tick by
   * construction, and no reader has to reason about whether the previous tick's outcome differed
   * from this one's.
   *
   * INCREMENTED AFTER the tick's own work settles, so a hook keyed on it fetches alongside the next
   * poll rather than racing this one — and incremented on failure too, because a rider that swallows
   * its own errors (both do) should still get its chance to retry on the backed-off cadence.
   */
  tickCount: number;
  /** Fetch now, resetting backoff and the timer. Wired to the banner's retry. */
  pollNow: () => void;
}

export function usePolling({ onTick, intervalMs }: UsePollingOptions): UsePollingResult {
  const [failureCount, setFailureCount] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [currentDelayMs, setCurrentDelayMs] = useState(intervalMs);

  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const failuresRef = useRef(0);
  /* True once the effect has torn down, so an in-flight promise resolving late
     cannot schedule a timer on an unmounted component. */
  const stoppedRef = useRef(false);

  /* `onTick` is recreated on most renders; a ref keeps the effect below from
     tearing down and rebuilding the timer on every one of them. */
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** The only place a timer is ever created. */
  const scheduleRef = useRef<() => void>(() => undefined);

  const runAndReschedule = useCallback(async (): Promise<void> => {
    // Abort whatever is still in flight so a slow response cannot land after a
    // newer one and present stale data as current.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await onTickRef.current(controller.signal);
      if (!controller.signal.aborted) {
        failuresRef.current = 0;
        setFailureCount(0);
      }
    } catch {
      if (!controller.signal.aborted) {
        failuresRef.current += 1;
        setFailureCount(failuresRef.current);
      }
    }

    /* THE TICK HAPPENED, whatever came of it — announced after the outcome above is recorded so a
       rider reading both sees one consistent moment. Skipped for an ABORTED tick, because an abort
       means this tick was superseded by a newer one (or by unmount) and never produced a reading;
       announcing it would ask every rider to fetch for a moment that does not exist.

       Guarded on `stoppedRef` for the same reason the reschedule below is: a promise resolving after
       teardown must not set state on an unmounted component. */
    if (!controller.signal.aborted && !stoppedRef.current) {
      setTickCount((previous) => previous + 1);
    }

    if (stoppedRef.current || document.hidden) return;
    scheduleRef.current();
  }, []);

  scheduleRef.current = (): void => {
    clearTimer();
    const failures = failuresRef.current;
    // Doubling from the interval, capped — §4.4. Not a written-out sequence, because it
    // moves with the interval and a copied one goes stale the moment that changes.
    const delay =
      failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    setCurrentDelayMs(delay);
    timerRef.current = window.setTimeout(() => void runAndReschedule(), delay);
  };

  // Start the loop; a self-rescheduling timeout rather than setInterval, since
  // the delay changes with backoff and this cannot overlap itself.
  useEffect(() => {
    stoppedRef.current = false;
    void runAndReschedule();

    return () => {
      stoppedRef.current = true;
      clearTimer();
      abortRef.current?.abort();
    };
  }, [runAndReschedule, clearTimer]);

  // Polling while hidden burns requests nobody will look at; catch up the moment
  // the tab returns so the operator never reads a stale screen.
  useEffect(() => {
    function onVisibilityChange(): void {
      if (document.hidden) {
        clearTimer();
        abortRef.current?.abort();
        return;
      }
      clearTimer();
      void runAndReschedule();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [runAndReschedule, clearTimer]);

  const pollNow = useCallback((): void => {
    clearTimer();
    failuresRef.current = 0;
    setFailureCount(0);
    void runAndReschedule();
  }, [runAndReschedule, clearTimer]);

  return { currentDelayMs, failureCount, tickCount, pollNow };
}
