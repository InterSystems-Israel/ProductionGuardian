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
import type { HostSeriesView } from '../types/hostseries';
import type {
  ChatAnswerView,
  ChatTurnView,
  HostProjectionView,
  InvestigationView,
  ResolveActionView,
  ResolveMode,
  ResolveView,
} from '../types/mvp2';

export interface HealthScanApi {
  getHosts(signal?: AbortSignal): Promise<HostView[]>;
  getFindings(signal?: AbortSignal): Promise<FindingView[]>;

  /**
   * Early Warning — GET /api/earlywarning. One entry per reported host.
   *
   * Empty is a legitimate answer (no host has a projectable metric yet), so this resolves with `[]`
   * rather than raising, same as the two list endpoints.
   */
  getProjections(signal?: AbortSignal): Promise<HostProjectionView[]>;

  /**
   * One host's recent metric series — GET /api/hostseries?host=…
   *
   * The history behind the host panel's three graphs. Read from the engine's rolling baseline, which
   * already holds a timestamped sample per (host, metric) — nothing is measured or stored for this.
   *
   * TAKES A HOST, unlike every other method here, because it is the only one scoped to a selection.
   * The full-roster alternative would serve three series for every host on every 2s tick to draw a
   * panel that is usually closed.
   *
   * Resolves with `null` when the payload cannot be read, rather than rejecting: a graph is
   * decoration over metric rows that are real, and it must not be able to raise the connection
   * banner. Same reasoning as `getProjections` returning `[]`.
   */
  getHostSeries(host: string, signal?: AbortSignal): Promise<HostSeriesView | null>;

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

  /**
   * Activity insights chat — POST /api/chat.
   *
   * Resolves for every outcome including failure, like `investigate`: the endpoint serves 200 with a
   * labelled state, so a rejected promise here means the TRANSPORT failed and not that the question
   * went unanswered.
   *
   * `history` IS PASSED IN BY THE CALLER, not held by the client. The transcript cannot live in IRIS
   * — `%AI.Agent.Session`'s agent handle is transient and a CSP dispatcher runs in a pooled process,
   * so a held session throws when the next request lands elsewhere. So the component owns the
   * conversation and this method is stateless, which is also what makes a reload honestly start a new
   * one rather than appear to continue an old one. `types/mvp2.ts` `ChatTurnView` carries the note.
   */
  ask(
    question: string,
    history: ChatTurnView[],
    signal?: AbortSignal,
  ): Promise<ChatAnswerView>;
}

export type Mode = 'demo' | 'live';
