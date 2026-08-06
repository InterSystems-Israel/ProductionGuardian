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

export function clearLastGood(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do if even removal fails.
  }
}
