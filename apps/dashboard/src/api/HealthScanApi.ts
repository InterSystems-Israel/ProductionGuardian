/**
 * The seam between the UI and Dev B's findings API.
 *
 * Two implementations satisfy it — `mockClient` (fixtures, demo mode) and
 * `liveClient` (fetch, live mode). `App.tsx` picks one and passes it down; no
 * component imports a client directly and no component calls `fetch` (§4.1).
 *
 * Deliberately not MSW or a service worker: the demo fallback has to run as a
 * plain file:// document, where service-worker registration is unreliable. A
 * swappable module behaves identically in dev, in the live build, and in the
 * single-file fallback.
 */

import type { FindingView, HostView } from '../types/healthscan';

export interface HealthScanApi {
  getHosts(signal?: AbortSignal): Promise<HostView[]>;
  getFindings(signal?: AbortSignal): Promise<FindingView[]>;
}

export type Mode = 'demo' | 'live';
