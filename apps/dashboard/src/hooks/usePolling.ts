/**
 * The dashboard's single timer.
 *
 * Rules from §4.4, all of them load-bearing during a demo:
 *  - one timer only — two stacked intervals double the request rate and make
 *    "last updated" meaningless
 *  - abort the in-flight request before each new tick and on unmount
 *  - pause while `document.hidden`, refetch immediately on becoming visible
 *  - back off 5s → 10s → 20s → 30s on failure, reset on the first success
 *
 * Everything funnels through one `schedule()`/`runAndReschedule()` pair, and
 * every entry point clears the pending timer first. Rescheduling logic lives in
 * exactly one place so a visibility change and a manual retry cannot each leave
 * a timer chain running.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 30_000;

/** Poll cadence from `VITE_POLL_INTERVAL_MS`, falling back to 5s. */
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
  /** Fetch now, resetting backoff and the timer. Wired to the banner's retry. */
  pollNow: () => void;
}

export function usePolling({ onTick, intervalMs }: UsePollingOptions): UsePollingResult {
  const [failureCount, setFailureCount] = useState(0);
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

    if (stoppedRef.current || document.hidden) return;
    scheduleRef.current();
  }, []);

  scheduleRef.current = (): void => {
    clearTimer();
    const failures = failuresRef.current;
    // 5s → 10s → 20s → 30s (capped), per §4.4.
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

  return { currentDelayMs, failureCount, pollNow };
}
