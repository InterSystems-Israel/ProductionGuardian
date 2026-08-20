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
import type { InvestigationView, ResolveActionView, ResolveMode, ResolveView } from '../types/mvp2';

export interface HealthScanApi {
  getHosts(signal?: AbortSignal): Promise<HostView[]>;
  getFindings(signal?: AbortSignal): Promise<FindingView[]>;

  /**
   * AI Detective — POST /api/investigate. Resolves for every outcome including failure: the
   * contract serves 200 with a labelled state rather than an error, because a blanked panel is
   * worse on stage than one saying "could not investigate" (investigation-api.md §5).
   *
   * So a rejected promise here means the TRANSPORT failed, not that the investigation did.
   */
  investigate(findingId: string, signal?: AbortSignal): Promise<InvestigationView>;

  /**
   * Smart Resolve — POST /api/resolve.
   *
   * `mode` is required and has no default on purpose (resolve-api.md §1.1): a missing mode must
   * not become `apply`, because that turns a caller's omission into a live production write.
   *
   * A refusal RESOLVES with `outcome: "refused"` rather than rejecting. It arrives as HTTP 200 and
   * carries the reason, and treating it as an error would lose that (§5.1).
   */
  resolve(
    mode: ResolveMode,
    action: ResolveActionView,
    origin: { findingId: string },
    signal?: AbortSignal,
  ): Promise<ResolveView>;
}

export type Mode = 'demo' | 'live';
