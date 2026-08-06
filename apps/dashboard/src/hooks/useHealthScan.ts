/**
 * Hosts + findings + connection status, from whichever client it is handed.
 *
 * The only place components get data. It is client-agnostic on purpose: the
 * demo/live swap happens above it in `App.tsx`, so nothing below this hook knows
 * or cares which implementation is running (§4.1).
 *
 * Polling itself lives in `usePolling` (Phase 2); this hook owns the fetch pair,
 * the derived state, and the newly-appeared tracking the findings list animates.
 */

import { useCallback, useRef, useState } from 'react';
import type { HealthScanApi } from '../api/HealthScanApi';
import { readLastGood, writeLastGood } from '../api/lastGood';
import type { FindingView, HostView } from '../types/healthscan';
import { compareSeverity, toSeverity } from '../lib/severity';
import { parseTimestamp } from '../lib/format';

export interface HealthScanState {
  hosts: HostView[];
  findings: FindingView[];
  /** True until the first response of any kind lands. Drives the skeletons. */
  loading: boolean;
  /** Message from the most recent failed fetch; null while healthy. */
  error: string | null;
  /** Epoch ms of the last successful fetch pair; null before the first. */
  lastSuccessAt: number | null;
  /** Finding ids first seen on the most recent poll — briefly highlighted. */
  newFindingIds: ReadonlySet<string>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Newest first, with severity breaking ties.
 *
 * CONTRACT-Q5: server-side ordering is unconfirmed, so the UI sorts. Sorting an
 * already-sorted array is cheap and makes the display independent of Dev B's
 * choice either way.
 */
function sortFindings(findings: readonly FindingView[]): FindingView[] {
  return [...findings].sort((a, b) => {
    const aTime = parseTimestamp(a.detectedAt)?.getTime() ?? 0;
    const bTime = parseTimestamp(b.detectedAt)?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return compareSeverity(toSeverity(a.severity), toSeverity(b.severity));
  });
}

export interface UseHealthScanResult extends HealthScanState {
  /**
   * Fetches both endpoints on one tick. Re-throws on failure so `usePolling`
   * can back off — the state update and the signal to the poller are separate
   * concerns, and swallowing the error here would peg polling at 5s during an
   * outage.
   */
  refresh: (signal?: AbortSignal) => Promise<void>;
  /** Drops cached ids so the next refresh treats everything as pre-existing. */
  resetSeen: () => void;
}

export interface UseHealthScanOptions {
  /**
   * Seed from and persist to the last-good cache. Live mode only: caching demo
   * fixtures would let a stale scenario resurface as though it were real data.
   */
  cacheLastGood?: boolean;
}

export function useHealthScan(
  api: HealthScanApi,
  { cacheLastGood = false }: UseHealthScanOptions = {},
): UseHealthScanResult {
  const [state, setState] = useState<HealthScanState>(() => {
    // Paint the last-good payload immediately in live mode, so a demo that opens
    // while the API is down still shows real data rather than empty skeletons.
    const cached = cacheLastGood ? readLastGood() : null;
    if (cached !== null) {
      return {
        hosts: cached.hosts,
        findings: cached.findings,
        loading: true,
        error: null,
        lastSuccessAt: cached.at,
        newFindingIds: EMPTY_IDS,
      };
    }
    return {
      hosts: [],
      findings: [],
      loading: true,
      error: null,
      lastSuccessAt: null,
      newFindingIds: EMPTY_IDS,
    };
  });

  /* Ids seen on previous polls. A ref rather than state: it must not itself
     trigger a render, and it has to survive the client swap. */
  const seenIds = useRef<Set<string>>(new Set());
  /* CONTRACT-Q4 depends on `finding.id` being stable while a condition persists.
     If Dev B says ids churn per poll, every finding would look new on every
     poll and this highlight has to go — the assumption is load-bearing here. */

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const [hosts, findings] = await Promise.all([
          api.getHosts(signal),
          api.getFindings(signal),
        ]);
        if (signal?.aborted === true) return;

        const sorted = sortFindings(findings);
        const isFirstLoad = seenIds.current.size === 0;
        const fresh = new Set<string>();
        for (const finding of sorted) {
          if (!seenIds.current.has(finding.id)) fresh.add(finding.id);
        }
        seenIds.current = new Set(sorted.map((finding) => finding.id));

        const at = Date.now();
        setState({
          hosts,
          findings: sorted,
          loading: false,
          error: null,
          lastSuccessAt: at,
          // Nothing is "new" on first paint — the whole list would pulse at once.
          newFindingIds: isFirstLoad ? EMPTY_IDS : fresh,
        });

        if (cacheLastGood) {
          writeLastGood({ hosts, findings: sorted, at });
        }
      } catch (cause) {
        // An abort is the caller's own doing (unmount, next tick) — not an error.
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // Keep the last-good hosts/findings in place; the banner explains why
        // they are dimmed. Blanking the grid on a transient failure is worse
        // than showing stale data with a timestamp (§4.2).
        setState((previous) => ({ ...previous, loading: false, error: message }));
        // Re-thrown so the poller backs off rather than hammering a dead API.
        throw cause;
      }
    },
    [api, cacheLastGood],
  );

  const resetSeen = useCallback((): void => {
    seenIds.current = new Set();
  }, []);

  return { ...state, refresh, resetSeen };
}
