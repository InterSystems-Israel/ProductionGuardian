/**
 * Mode and scenario selection from the URL.
 *
 * Demo is the default: a URL with no query string must always render something
 * presentable, which is the demo-reliability mitigation (§4.2). The current mode
 * is reflected back into the URL via `replaceState` so it is shareable without
 * adding history entries the presenter would have to click back through.
 */

import type { Mode } from '../api/HealthScanApi';

export function readMode(): Mode {
  return new URLSearchParams(window.location.search).get('mode') === 'live' ? 'live' : 'demo';
}

export function readScenario(): string | undefined {
  const value = new URLSearchParams(window.location.search).get('scenario');
  return value === null || value.length === 0 ? undefined : value;
}

/** Writes `mode` into the URL, dropping `scenario` when leaving demo mode. */
export function writeMode(mode: Mode): void {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  if (mode === 'live') url.searchParams.delete('scenario');
  window.history.replaceState(null, '', url);
}
