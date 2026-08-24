/**
 * Threshold settings: load, apply, reset.
 *
 * Owns what the panel should not — the in-flight flags, the abort on unmount, and the error
 * message — the same split as `useInvestigation` and `useHealthScan`. The panel renders state and
 * never calls the API (§4.1).
 *
 * NOT POLLED, unlike every other hook here. Findings and metrics change on their own and must be
 * re-read; a threshold changes only because somebody changed it, and this hook is the only surface
 * that can. Polling it would also fight the operator's own typing: a tick landing mid-edit would
 * replace the number in the input with the server's. So it loads once when the panel opens and
 * re-reads only as the RESULT of a write, which is the one moment the server's copy is known to
 * have moved.
 *
 * `settings` IS THE SERVER'S ANSWER, never a local accumulation. Every write returns the full
 * effective state and that reply replaces what is held, so the panel cannot drift from what is
 * actually in force — which is the whole promise of the panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthScanApi } from '../api/HealthScanApi';
import type { ThresholdSettingsView } from '../types/settings';

export interface ThresholdSettingsState {
  settings: ThresholdSettingsView | null;
  loading: boolean;
  /** A write is in flight. Distinct from `loading`, which is the initial read. */
  saving: boolean;
  /**
   * Why the last write was refused, verbatim from the engine.
   *
   * `validateConfig` already produces readable problems naming the field and the constraint, so
   * this is rendered as-is and never reworded — a second wording is a second thing to keep in step
   * with the validator.
   */
  error: string | null;
}

export interface ThresholdSettingsActions {
  /** Apply one or more values. Keys must be ones the engine published. */
  apply: (values: Record<string, number>) => void;
  reset: () => void;
  /** Drop the error without changing anything, so the panel can clear it on edit. */
  clearError: () => void;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request failed';
}

/**
 * `enabled` gates the initial read, so a closed panel makes no request at all.
 *
 * Passed in rather than the hook being conditionally called — hooks cannot be, and mounting the
 * panel only when open would lose the loaded state every time it closed.
 */
export function useThresholdSettings(
  api: HealthScanApi,
  enabled: boolean,
): ThresholdSettingsState & ThresholdSettingsActions {
  const [settings, setSettings] = useState<ThresholdSettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef<AbortController | null>(null);
  /* Whether this hook is still mounted and enabled, read inside async continuations. A write
     resolving after the panel closed must not setState -- the same guard `useInvestigation` uses,
     and it matters here because a reset is a round trip an operator may navigate away from. */
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, []);

  /* The initial read. Runs when the panel first opens and not again -- see the file comment on why
     this is not polled. A failure leaves `settings` null, which the panel renders as "settings
     unavailable" rather than as an error banner. */
  useEffect(() => {
    if (!enabled || settings !== null) return undefined;
    const controller = new AbortController();
    setLoading(true);
    void api
      .getThresholdSettings(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || !live.current) return;
        setSettings(next);
      })
      .catch(() => {
        // Swallowed deliberately: an unreachable settings endpoint is an absent optional panel, not
        // an outage. `settings` stays null and the panel says so.
        if (controller.signal.aborted || !live.current) return;
      })
      .finally(() => {
        if (controller.signal.aborted || !live.current) return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, enabled, settings]);

  /** One write path for both apply and reset — they differ only in which method is called. */
  const write = useCallback(
    (call: (signal: AbortSignal) => Promise<ThresholdSettingsView>): void => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setSaving(true);
      setError(null);

      void call(controller.signal)
        .then((next) => {
          if (controller.signal.aborted || !live.current) return;
          // The server's full effective state replaces what is held. See the file comment.
          setSettings(next);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || !live.current) return;
          setError(message(cause));
        })
        .finally(() => {
          if (controller.signal.aborted || !live.current) return;
          setSaving(false);
        });
    },
    [],
  );

  const apply = useCallback(
    (values: Record<string, number>): void => {
      write((signal) => api.applyThresholdSettings(values, signal));
    },
    [api, write],
  );

  const reset = useCallback((): void => {
    write((signal) => api.resetThresholdSettings(signal));
  }, [api, write]);

  const clearError = useCallback((): void => setError(null), []);

  return { settings, loading, saving, error, apply, reset, clearError };
}
