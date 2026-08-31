/**
 * MVP 2 view types — AI Detective and Smart Resolve.
 *
 * Transcribed from `contracts/investigation-api.md` and `contracts/resolve-api.md`. Those contracts
 * are authoritative; where this file and they disagree, this file is wrong.
 *
 * NEITHER CONTRACT HAS A `.d.ts` OR A SCHEMA YET — both say so at the top, and `validate.mjs` does
 * not know these endpoints exist. So unlike `healthscan.ts`, there is no generated source to
 * transcribe from and no drift test that would catch a divergence here. Every field name below was
 * read off the contract prose and checked against a live response. That is weaker, and it is why the
 * parsers in `api/mvp2Guards.ts` read field by field rather than casting.
 *
 * WHAT THE UI IS ALLOWED TO ASSUME, and it is very little:
 *
 *  - `rootCause` may be null. That is not a loading state and not an error — it is the engine
 *    refusing to invent an explanation, and it must render as such (§4.4).
 *  - `source` distinguishes a real agent from a canned fallback. A canned investigation that
 *    presented itself as live would be the same defect class as a projection shown as a
 *    measurement, so the UI labels it.
 *  - `outcome: "refused"` arrives with HTTP 200 (`resolve-api.md` §5.1). It is a normal response
 *    carrying information, not an error, and rendering it as a failure loses the reason.
 */

/** `investigation-api.md` §4.1. */
export type InvestigationState = 'complete' | 'degraded' | 'unavailable';

/** §3.1. `canned` is the mock agent; `none` accompanies an unavailable investigation. */
export type InvestigationSource = 'agent' | 'cache' | 'canned' | 'none';

/**
 * §3.2. How a bullet was obtained, and the reason it is shown next to the text.
 *
 * `mcp_tool` means a governed tool read it from the live production. `snapshot` means it came from
 * the finding the investigation explains. `llm` means the model asserted it and nothing measured it
 * — which a human approving a production write is entitled to see distinguished.
 */
export type EvidenceSource = 'mcp_tool' | 'snapshot' | 'llm';

export interface EvidenceItemView {
  label: string;
  detail: string;
  source: EvidenceSource;
  tool: string | null;
}

/** §3.3. Exactly three keys — `resolve-api.md` §1.1 refuses unknown ones inside `action`. */
export interface ResolveActionView {
  type: 'set_pool_size';
  host: string;
  size: number;
}

export interface RecommendedActionView {
  action: ResolveActionView;
  currentValue: number | null;
  bounds: { min: number; max: number };
  reversible: boolean;
  requiresApproval: boolean;
  summary: string;
}

/**
 * A fix the system may NOT apply. Contract §3.3a, MVP 3.
 *
 * NO `action` FIELD, and that absence is the design. `RecommendedActionView` carries an `action` the
 * UI sends to `POST /api/resolve`; this carries none, so the approve control has nothing to bind to
 * and cannot be rendered by mistake. A single object with an `applyable: false` flag would make the
 * wrong UI a forgotten `if` instead of an impossibility.
 */
export interface ManualRemediationView {
  summary: string;
  /** Rendered verbatim as an ordered list. The UI does not reword or merge them. */
  steps: string[];
  /** Configuration only, never message content. Null when the agent could not identify it. */
  target: { host: string; setting: string; currentValue: string | null } | null;
  /** Closed set, one member. Rendered as "you", not as a system capability. */
  appliedBy: string;
}

export interface InvestigationView {
  requestId: string;
  findingId: string;
  state: InvestigationState;
  source: InvestigationSource;
  investigatedAt: string;
  /** Null when the engine could not produce one. Never a placeholder narrative. */
  rootCause: string | null;
  evidence: EvidenceItemView[];
  confidence: number | null;
  recommendedAction: RecommendedActionView | null;
  /** MVP 3. Null when there is nothing manual to do. Both null is legal (§3.1). */
  manualRemediation: ManualRemediationView | null;
  diagnostics: {
    model: string | null;
    toolCalls: number | null;
    durationMs: number | null;
    note: string | null;
  };
}

/**
 * Activity insights chat — the ask-a-question panel.
 *
 * NO CONTRACT FILE AND NO SCHEMA, like the two above, so every field here was read off a live
 * response and the parser in `api/mvp2Guards.ts` reads field by field rather than casting.
 *
 * TWO STATES, NOT THREE. There is no `degraded` and no `canned` source: the answer either came from
 * the live agent in IRIS or it could not be produced. `detect/chat.ts` argues why a canned chat
 * agent is not buildable honestly — a mock that has to guess the question would have to invent
 * either the numbers or the question — so the offline state is `unavailable` and the panel says so
 * rather than showing a plausible answer with a badge on it.
 */
export type ChatState = 'complete' | 'unavailable';

/**
 * `static` IS NOT A CANNED ANSWER ABOUT THE PRODUCTION, which is what the paragraph above rules out.
 *
 * It is a greeting, a thanks, a farewell or a "what can you do" — classified in
 * `ChatDispatcher.SmallTalkKind` and answered from a fixed catalogue in IRIS, with no model call and
 * no tool call. It describes the ASSISTANT, never the data, so it invents nothing: the thing
 * `unavailable` exists to prevent is a plausible answer to a question about this production, and no
 * such question can reach this source. The panel labels it, because an answer nothing measured must
 * not present itself with the same "Live agent" tag as one three tools were read for.
 */
export type ChatSource = 'agent' | 'static' | 'none';

/**
 * One value the agent read, and the tool it used.
 *
 * `tool: null` MEANS THE MODEL DID NOT CITE ONE, and the panel labels it differently for that
 * reason. It is the same distinction `EvidenceSource` draws for an investigation: a value a governed
 * tool read from the live production and a value the model asserted must not appear with equal
 * standing. Here the tool NAME is the citation, so its absence is the `llm` case.
 */
export interface ChatEvidenceItemView {
  label: string;
  detail: string;
  tool: string | null;
}

export interface ChatAnswerView {
  requestId: string;
  state: ChatState;
  source: ChatSource;
  answeredAt: string;
  /** Echoed by IRIS from what it received, so the panel never pairs an answer with a question the
      agent was not asked. */
  question: string;
  /** Null when no answer could be produced. Never a placeholder sentence. */
  answer: string | null;
  evidence: ChatEvidenceItemView[];
  confidence: number | null;
  diagnostics: {
    model: string | null;
    /** Zero means the model answered from its priors rather than from the production. */
    toolCalls: number | null;
    durationMs: number | null;
    note: string | null;
  };
}

/**
 * One turn as the CLIENT holds it, for replay on the next question.
 *
 * THE TRANSCRIPT LIVES HERE BECAUSE IT CANNOT LIVE IN IRIS. `%AI.Agent.Session` persists as a row but
 * its agent handle is `transient`, so a session reopened in another process throws — and a CSP
 * dispatcher runs in a pooled process, so consecutive requests are usually not the same one.
 * `iris/labdemo/REST/ChatDispatcher.cls` carries the measurement. The consequence for the UI is that
 * it owns the conversation and sends it, which also means a reload legitimately starts a new one.
 */
export interface ChatTurnView {
  role: 'user' | 'assistant';
  text: string;
}

/** `resolve-api.md` §1.4. Closed set. */
export type ResolveOutcome = 'previewed' | 'applied' | 'no_change' | 'refused' | 'failed';

export type ResolveMode = 'dry_run' | 'apply';

export interface ResolveView {
  resolveId: string;
  requestId: string | null;
  mode: ResolveMode;
  outcome: ResolveOutcome;
  action: ResolveActionView | null;
  before: { poolSize: number } | null;
  after: { poolSize: number } | null;
  /** The prior value, captured live. What an operator restores to undo. */
  reversal: { host: string; size: number; capturedFrom: string } | null;
  /** §5. `reason` from a closed set, `message` rendered verbatim, `checkedBy` naming the decider. */
  refusal: {
    reason: string;
    message: string;
    checkedBy: string;
    bounds?: { min: number; max: number };
  } | null;
  failure: { stage: string; message: string; liveStateVerified: boolean } | null;
  /** Present only on `applied`. `directEvidence: false` — the write landed, the fix is not yet seen. */
  confirmation: {
    status: string;
    findingId: string | null;
    observeVia: string;
    expectedWithinSeconds: number;
    directEvidence: boolean;
  } | null;
  /** §8. Null means no record was written, which on an apply is a reason to verify by hand. */
  audit: {
    auditId: string | null;
    actor: string | null;
    role: string | null;
    requestedBy: string | null;
    tool: string | null;
    recordedAt: string | null;
    source: string | null;
  } | null;
  requestedAt: string;
  completedAt: string;
}

/**
 * Early Warning — `contracts/earlywarning-api.md`.
 *
 * A PROJECTION IS NOT A MEASUREMENT, and the shape enforces it: every forecast number is nested
 * inside `projection`, which is **null** whenever one cannot honestly be made. The measured values
 * (`currentValue`, `threshold`) sit outside it and are always present. So a consumer cannot read a
 * forecast by accident — it has to reach into an object that may not be there.
 *
 * `projectionUnavailable` then says WHY, from a closed set. Rendering the reason rather than hiding
 * the row is the point: "not rising" and "still warming up" are different facts, and a blank space
 * means neither.
 */
export type ProjectionDeclineReason =
  | 'disabled'
  | 'metric_unmeasurable'
  | 'warming'
  | 'insufficient_samples'
  | 'already_crossed'
  | 'not_rising'
  | 'beyond_horizon';

/**
 * Which way the metric is moving now — `earlywarning-api.md` §1.5.
 *
 * A SEPARATE AXIS FROM THE DECLINE REASON, not another member of it: the reason says which state,
 * this says which way, and `already_crossed` occurs in both directions. `null` means the engine
 * claims no direction and must never be rendered as `steady`.
 */
export type RecentDirection = 'rising' | 'falling' | 'steady';

export interface HostProjectionView {
  host: string;
  metric: string;
  currentValue: number | null;
  measuredAt: string;
  fitSampleCount: number;
  fitSpanSeconds: number;
  /** Measured, so present alongside `currentValue` rather than inside `projection`. §1.5. */
  recentDirection: RecentDirection | null;
  threshold: {
    value: number | null;
    basis: string;
    baselineValue: number | null;
    findingType: string;
  } | null;
  /** Null when no honest projection exists. Never partially populated. */
  projection: {
    kind: 'projection';
    slope: number;
    slopeUnit: string;
    secondsToThreshold: number | null;
    crossesAt: string | null;
  } | null;
  projectionUnavailable: ProjectionDeclineReason | null;
}
