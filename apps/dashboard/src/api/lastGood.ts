/**
 * localStorage cache of the last successful payload.
 *
 * This is the demo-reliability mitigation from the MVP risk table: when the live
 * API goes away mid-demo the dashboard shows the last real data, dimmed and
 * timestamped, rather than blanking (§4.2).
 *
 * Every access is wrapped — localStorage throws in private-mode Safari and can
 * be unavailable under `file://`, and losing the cache must never take the
 * dashboard down with it.
 */

import type { FindingView, HostView } from '../types/healthscan';

const KEY = 'pg.healthscan.lastGood.v1';

/*
 * How many hosts the monitored production last reported.
 *
 * Its own key, not part of `LastGood`, because the two have different rules: the
 * payload is live-mode-only (caching demo fixtures would let a stale scenario
 * resurface as real data), whereas this is a layout hint worth keeping in both
 * modes. An integer cannot resurface as anything.
 *
 * Exists so the loading skeletons match whatever production this is pointed at
 * rather than a number compiled in. See issue #25.
 */
const HOST_COUNT_KEY = 'pg.healthscan.hostCount.v1';

export interface LastGood {
  hosts: HostView[];
  findings: FindingView[];
  /** Epoch ms of the fetch that produced this payload. */
  at: number;
}

export function readLastGood(): LastGood | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const candidate = parsed as Partial<LastGood>;
    if (!Array.isArray(candidate.hosts) || !Array.isArray(candidate.findings)) return null;
    if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null;

    return { hosts: candidate.hosts, findings: candidate.findings, at: candidate.at };
  } catch (cause) {
    console.warn('[healthscan] could not read the last-good cache', cause);
    return null;
  }
}

export function writeLastGood(value: LastGood): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch (cause) {
    // Quota or a disabled store — not worth surfacing to the operator.
    console.warn('[healthscan] could not write the last-good cache', cause);
  }
}

/** Last observed host count, or null if this browser has never seen a payload. */
export function readHostCountHint(): number | null {
  try {
    const raw = window.localStorage.getItem(HOST_COUNT_KEY);
    if (raw === null) return null;
    const count = Number(raw);
    // A non-integer or a zero tells us nothing useful, so treat it as unknown
    // rather than rendering no skeletons at all.
    return Number.isInteger(count) && count > 0 ? count : null;
  } catch (cause) {
    console.warn('[healthscan] could not read the host-count hint', cause);
    return null;
  }
}

export function writeHostCountHint(count: number): void {
  if (!Number.isInteger(count) || count <= 0) return;
  try {
    window.localStorage.setItem(HOST_COUNT_KEY, String(count));
  } catch {
    // A missing layout hint costs one frame of a mismatched skeleton row. Not
    // worth a console line on every poll.
  }
}

export function clearLastGood(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do if even removal fails.
  }
}
