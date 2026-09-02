/**
 * AI Detective orchestration — the WHY stage.
 *
 * Implements `contracts/investigation-api.md`. That contract is authoritative; where this file and
 * it disagree, the contract is right and this is a bug.
 *
 * WE ORCHESTRATE, WE DO NOT REASON. The narrative comes from an AI Hub agent running inside IRIS.
 * This module builds a request from measured values, calls the agent, validates what comes back,
 * and serves it. It does not generate root causes, does not summarise them, and does not fill gaps
 * — `services/detection-engine/CLAUDE.md` §1.1 draws that line, and it is the reason no LLM key
 * reaches this service.
 *
 * NEVER INVENT AN EXPLANATION. That is the single rule this file exists to enforce. An investigation
 * that cannot be produced returns `state: "unavailable"` with `rootCause: null` — not a plausible
 * guess, not a generic "the host may be slow". A fabricated root cause is worse than no root cause,
 * because a human approves a production write on the strength of it.
 */

import type { Finding, Host } from '../types/healthscan.ts';
import { SLOPE_UNIT, type HostProjection } from './earlywarning.ts';

/** Where the served content came from. Contract §3.1. */
export type InvestigationSource = 'agent' | 'cache' | 'canned' | 'none';

/** Contract §4.1. */
export type InvestigationState = 'complete' | 'degraded' | 'unavailable';

export interface EvidenceItem {
  label: string;
  detail: string;
  /** How this bullet was obtained. `llm` means the model asserted it — see §3.2. */
  source: 'mcp_tool' | 'snapshot' | 'llm';
  tool: string | null;
}

/**
 * The action, and it is EXACTLY three keys.
 *
 * `resolve-api.md` §1.1 refuses unknown keys inside `action`, so anything advisory has to be a
 * sibling rather than a member. Getting this wrong would make every recommendation
 * `malformed_request` at the resolve endpoint and force a translation layer that contract
 * explicitly warns against.
 */
export interface ResolveAction {
  type: 'set_pool_size';
  host: string;
  size: number;
}

export interface RecommendedAction {
  action: ResolveAction;
  currentValue: number | null;
  bounds: { min: number; max: number };
  reversible: boolean;
  requiresApproval: boolean;
  summary: string;
}

/**
 * A fix the system may NOT apply. Contract §3.3a, MVP 3.
 *
 * SEPARATE FROM `RecommendedAction` BY DESIGN, and the reason is authority rather than convenience:
 * `RecommendedAction` means "the system may apply this, with approval"; this means "the system may
 * not apply this at all". Because there is no `action` object here, a consumer physically cannot
 * send it to `POST /api/resolve` and cannot bind an approve control to it — the wrong UI is
 * unrepresentable rather than merely discouraged. A single object with an `applyable: false` flag
 * would make the wrong UI a forgotten `if`.
 *
 * The failure being designed out is an approve button next to a recommendation the system cannot
 * carry out, because a human would click it.
 */
export interface ManualRemediation {
  summary: string;
  /** Ordered and imperative. Rendered verbatim — this service does not compose or reword them. */
  steps: string[];
  /** Configuration only, never message content (`mcp-tools.md` §6). Null when unidentified. */
  target: { host: string; setting: string; currentValue: string | null } | null;
  /** Closed set, one member. A second value is a contract change, not a code change. */
  appliedBy: 'operator';
}

export interface InvestigationResponse {
  requestId: string;
  findingId: string;
  state: InvestigationState;
  source: InvestigationSource;
  investigatedAt: string;
  rootCause: string | null;
  evidence: EvidenceItem[];
  confidence: number | null;
  recommendedAction: RecommendedAction | null;
  /**
   * MVP 3. Null when the agent recommended nothing manual — which is legal alongside
   * `recommendedAction: null` and must render as *no recommended action*, not as an error.
   */
  manualRemediation: ManualRemediation | null;
  diagnostics: {
    model: string | null;
    toolCalls: number | null;
    durationMs: number | null;
    note: string | null;
  };
}

/** What the engine sends the agent. Contract §2.2. */
interface InvestigationRequest {
  requestId: string;
  requestedAt: string;
  finding: Finding;
  snapshot: Record<string, unknown>;
  trend: Record<string, unknown> | null;
}

export interface InvestigateDeps {
  /**
   * Calls the AI Hub agent. Injected so the endpoint is testable without an LLM, and so the
   * mock and the live path are the same code path rather than two branches that drift.
   */
  callAgent(request: InvestigationRequest, timeoutMs: number): Promise<unknown>;
  /**
   * Which source `callAgent` represents. REQUIRED, and not inferable here: the orchestrator cannot
   * tell a canned response from a real one, and defaulting to 'agent' would publish a mocked
   * investigation as a real one -- the same defect class as a projection published as a
   * measurement. The caller knows which it wired, so the caller states it.
   */
  source: Extract<InvestigationSource, 'agent' | 'canned'>;
  now?: () => number;
  log?: (message: string) => void;
}

/** §4.2. Hard timeout; the soft one is the agent's own iteration budget. */
const TIMEOUT_MS = 30_000;

/** §3.3. Must match resolve-api.md §3 exactly — an out-of-bounds recommendation is unusable. */
const BOUNDS = { min: 2, max: 8 } as const;

/**
 * §2.3's data boundary, as a refusal rather than as a comment about one.
 *
 * A `system_alert` finding's `message` is the ONLY finding message this engine does not author: it is
 * copied out of `alerts.log`, which IRIS wrote, and an alert about a failed send can name the message
 * it failed to send. There is no reliable way to sanitise arbitrary alert prose, so it is not sent.
 * Root `CLAUDE.md` §2.1 is the rule this enforces — metrics and configuration leave the instance,
 * never message content.
 *
 * SEPARATE FROM `INVESTIGABLE_TYPES` AND CHECKED FIRST, deliberately. Until now the boundary was
 * *implied* by §2.4's one accepted shape, so widening the accepted set would have reopened it
 * silently — which is how the gate came to be asserted in three places in prose and none in code
 * (#206). A refusal that is not derived from the scope list cannot be widened by widening scope.
 * `test/investigationScope.test.ts` pins the two lists as disjoint.
 */
export const NEVER_FORWARDED: ReadonlySet<Finding['type']> = new Set(['system_alert']);

/**
 * §2.4. The finding types an investigation exists for.
 *
 * TWO SCENARIOS, NOT ONE, because two shipped: `queue_buildup` on a throughput-bound operation is
 * MVP 2's, and `dead_host` is MVP 3's missing-folder service (spec §2.3 — `Error` is already in
 * `DEAD_STATUSES`, so that scenario needed no new rule). §2.4 still named only the first, which is
 * the second thing #206 found: enforcing the contract as literally written would have refused a
 * shipped, specified scenario.
 *
 * KEYED ON TYPE, NOT ON `(type, host)` AS §2.4 SPECIFIES. The host half was in that section because
 * MVP 2 had exactly one host, and it buys nothing now: the boundary concern is the provenance of
 * `finding.message`, which is a property of the *type*, and the agent's read tools are host-agnostic.
 * A host name here would also be this service tracking `Production.cls`'s config — the same argument
 * `mockClient.investigate` already makes for keying its own branch on type (#84).
 *
 * The five remaining types are refused because no investigation exists for them, not because they are
 * unsafe. An endpoint that accepts all eight implies eight investigations exist.
 */
export const INVESTIGABLE_TYPES: ReadonlySet<Finding['type']> = new Set([
  'queue_buildup',
  'dead_host',
]);

function isoSeconds(ms: number): string {
  return `${new Date(Math.round(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * The metric and configuration fields the agent may see — an ALLOWLIST, built field by field.
 *
 * THIS IS THE DATA BOUNDARY IN CODE, not a comment about one. Root `CLAUDE.md` §2.1 makes it a rule
 * that metrics and configuration only ever leave the instance: never message content, never PHI.
 * Passing the host object through with a spread would satisfy today's shape and silently forward
 * whatever a future field carries — so every value is named. Adding a field here is a decision, and
 * a decision is the point.
 */
function buildSnapshot(
  host: Host,
  projection: HostProjection | undefined,
  trend: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    host: host.host,
    type: host.type,
    status: host.status,
    queued: host.queued,
    messagesPerSec: host.messagesPerSec,
    errored: host.errored,
    avgProcessingTime: host.avgProcessingTime,
    avgQueueingTime: host.avgQueueingTime,
    lastActivity: host.lastActivity,
    // From Early Warning, and measured rather than forecast: the threshold and current depth are
    // observations. The projection itself is deliberately NOT sent -- see buildTrend.
    thresholdValue: projection?.threshold?.value ?? null,
    thresholdBasis: projection?.threshold?.basis ?? null,
    inboundRatePerSec: inboundRatePerSec(host, trend),
  };
}

/**
 * Arrival rate at the queue — §2.2's one DERIVED field in an otherwise measured object.
 *
 * `messagesPerSec` is COMPLETIONS, and on the host this product exists to fix that is the wrong
 * number: `Cloud API` at `PoolSize 1` against a ~1s downstream reads ~1/sec because ~1/sec is all it
 * can clear, while ~2.9/sec is arriving. Little's law fed with throughput then says "one worker is
 * enough" about a host that is 1.9/sec behind — so the sizing arithmetic the agent shows its working
 * with was systematically undersized on exactly the bound host it was written for (#188).
 *
 * Completions plus the rate the queue is growing is the arrival rate. Nothing measures it — no metric
 * exists — so it is derived, and §2.2 requires it be labelled that way wherever it is shown.
 * `AgentDispatcher`'s prompt carries that label; this is the only consumer.
 *
 * FROM `trend.recentSlope`, NOT `trend.slope`, and §2.2 was amended to say so (CHANGELOG 2026-09-01).
 * The contract originally specified the window slope, and measuring both scenarios — which #188 was
 * explicit about requiring — is what found that wrong. Measured on the drain-through transient:
 * `set_pool_size 1 -> 4` applied, `recentDirection` reporting `falling`, `messagesPerSec` reading 4
 * because four workers are clearing a backlog.
 *
 *     messagesPerSec alone           4      -> the model recommended 4 -> 8
 *     via `slope`, queue 94          4.57   -> the model recommended 4 -> 6
 *     via `recentSlope`, queue 108   3.82   -> the model recommended nothing
 *
 * "Is growing" has to mean now. A five-minute fit still leaning up two minutes into a drain is the
 * right answer to the ETA question and the wrong one to this: it pushed the estimate ABOVE the raw
 * completion rate on an emptying queue — the one state where completions already overstate the load.
 * (The two derived rows are separate runs a few polls apart; the transient is short. What decides the
 * outcome is which side of `messagesPerSec` each estimate lands on.)
 *
 * NULL RATHER THAN A FALLBACK TO `messagesPerSec`, which the contract states outright and is the
 * whole point: throughput standing in for inflow reads as "inflow equals throughput", which is
 * precisely the conclusion a `queue_buildup` finding contradicts. #58's defect class again — a
 * computed value presented as a measurement.
 *
 * DERIVED FROM THE TREND OBJECT, not from the projection a second time, so a present
 * `inboundRatePerSec` always has a visible `trend.recentSlope` behind it — which is why that
 * magnitude was added to the contract rather than left internal. §2.2 ties them together in as many
 * words — null "including whenever `trend` is `null`" — and the alternative is a snapshot implying a
 * slope the trend declines to show.
 */
function inboundRatePerSec(host: Host, trend: Record<string, unknown> | null): number | null {
  const slope = trend?.['recentSlope'];
  if (typeof slope !== 'number') return null;
  // 2dp, in the units the field is named for. The terms are a 1dp rate and a 1dp-per-minute slope, so
  // an unrounded sum is float noise (`2.9000000000000004`) presented to an LLM as precision.
  const rate = Math.round((host.messagesPerSec + slope / 60) * 100) / 100;
  // A NEGATIVE ARRIVAL RATE IS NOT A RATE. The two terms are measured over different spans, so a queue
  // draining faster than the tail's completions were counted can put the sum below zero -- arithmetic
  // noise, not a host receiving negative messages. Clamped to 0 rather than nulled: "nothing is
  // arriving" is the honest reading of it, and null would say "no fit", which is false here.
  return rate < 0 ? 0 : rate;
}

/**
 * Trend context, and the reason it is not called `projection`.
 *
 * Early Warning publishes `projection: null` with reason `already_crossed` exactly when a queue has
 * crossed its threshold — which is the state that made `queue_buildup` fire, i.e. the only condition
 * an investigation is ever requested for. So reusing that object would hand the agent `null` every
 * single time and the "queue slope positive" evidence bullet would be unobtainable.
 *
 * Same field names and units as `earlywarning-api.md`, with the forecast framing dropped:
 * `thresholdCrossed: true` and `secondsToThreshold: null` is the normal case here, not an error.
 *
 * `slope` is the measured window fit rather than the projection's copy of it, which is what makes
 * §2.2's "may be zero or negative here" reachable at all (#187). See below.
 */
function buildTrend(projection: HostProjection | undefined): Record<string, unknown> | null {
  if (projection === undefined) return null;
  /*
   * THE MEASURED WINDOW SLOPE, not `projection.slope` (#187).
   *
   * Read from `projection.projection`, this was null on every investigation this endpoint has ever
   * served: Early Warning sets that object to null for `already_crossed`, which is the state that
   * made `queue_buildup` fire in the first place. §2.2's argued reason for carrying a signed slope
   * here -- "a queue that is draining is a fact the agent should see rather than a forecast to
   * withhold" -- therefore never once reached the agent, and it recommended enlarging a pool on a
   * queue falling 261 -> 181 because nothing in its input said so.
   *
   * `windowSlopePerMinute` is the same fit and the same units, measured before the decline. It stays
   * off `/api/earlywarning`, where §1.4 forbids it; this is the consumer §2.2 published it for.
   */
  const slope = projection.windowSlopePerMinute;
  const recentSlope = projection.recentSlopePerMinute;
  const threshold = projection.threshold?.value ?? null;
  /*
   * NULL WHEN ANY PART IS MISSING, which §2.2 states as "no usable fit at all — a warming
   * baseline, or fewer than 12 samples in the fit window": a null threshold is the warming case and
   * a null slope is the sample-count case, so the contract's sentence is exactly this disjunction.
   *
   * It was `&&` before, which could only ever be reached because `slope` was unconditionally null --
   * so `insufficient_samples` served a trend object whose only real content was a threshold. That
   * threshold is in `snapshot.thresholdValue` too, so nothing is lost by declining here, and the
   * agent gets one meaning for a present `trend` rather than two.
   *
   * `recentSlope` IS A THIRD ARM RATHER THAN AN IMPLIED ONE (#188), because the two fits share a
   * sample-count gate but not their outcome: the tail refits over the trailing 45 s, so a poll gap
   * -- the engine records nothing while the proxy is unreachable -- can leave one sample inside it
   * while the 300 s window still holds twelve. The tail fit is then null, and so is `recentDirection`,
   * which is derived from its sign. Without this arm `trend` would carry a window slope beside two
   * nulls and a `snapshot.inboundRatePerSec` of null, which is the two-meanings object the `||` above
   * exists to refuse; §2.2's `recentSlope` row promises "non-null whenever `trend` is non-null", and
   * this is what makes that true rather than nearly true.
   */
  if (slope === null || recentSlope === null || threshold === null) return null;
  return {
    metric: projection.metric,
    slope,
    slopeUnit: SLOPE_UNIT,
    /*
     * WHICH WAY THE QUEUE IS MOVING, and it stays here now that `slope` can also answer it (#177).
     *
     * It was added when `slope` was structurally null on every investigation, as the one honest
     * signal of direction available without reopening `earlywarning-api.md` §1.4. #187 fixed the
     * slope, so this is no longer the only source — and it is kept because the two are measured over
     * DIFFERENT spans and disagree usefully: `slope` fits the whole window, `recentDirection` its short
     * tail (#174). A queue that rose for eight minutes and has been draining for two has a positive
     * `slope` and a `falling` direction, which is exactly the state the agent most needs to
     * distinguish and the one a single number flattens.
     */
    recentDirection: projection.recentDirection,
    /*
     * THE TAIL SLOPE'S MAGNITUDE, beside the sign that was already here (#188).
     *
     * Added to the contract rather than kept internal because `snapshot.inboundRatePerSec` is derived
     * from it, and the prompt asks the model to state its arithmetic. A term it cannot see is a term
     * it either omits or invents — and the field it would reach for instead is `slope`, which is the
     * wrong span for "what is arriving now" and was measured producing `4 -> 6` on a draining queue.
     *
     * Gated with `slope`, so both are non-null whenever this object exists.
     */
    recentSlope,
    thresholdValue: threshold,
    // The `threshold !== null` half of this test went with the gate above, which now guarantees it.
    // Leaving it would say a null threshold is reachable here, and a reader would believe it.
    thresholdCrossed: projection.currentValue !== null ? projection.currentValue >= threshold : null,
    secondsToThreshold: projection.projection?.secondsToThreshold ?? null,
  };
}

/** §4.1 + §4.4. A response we cannot validate is a failure, not a partial success. */
function unavailable(
  requestId: string,
  findingId: string,
  at: number,
  note: string,
): InvestigationResponse {
  return {
    requestId,
    findingId,
    state: 'unavailable',
    source: 'none',
    investigatedAt: isoSeconds(at),
    // NULL, not a placeholder narrative. The whole point of the state.
    rootCause: null,
    evidence: [],
    confidence: null,
    recommendedAction: null,
    manualRemediation: null,
    diagnostics: { model: null, toolCalls: null, durationMs: null, note },
  };
}

/**
 * Validate the agent's reply into the published shape, or return null to signal failure.
 *
 * STRICT ON THE ACTION, LENIENT ON THE PROSE. `rootCause` is free text by design and we render it
 * verbatim, so there is nothing to validate beyond "is it a non-empty string". `recommendedAction`
 * is the input to a live production write that a human approves, so every field is checked: a wrong
 * `size`, a wrong `host`, or an unknown `type` must be dropped rather than forwarded.
 *
 * A dropped action does NOT invalidate the investigation. The narrative can be useful while the
 * recommendation is unusable, and `recommendedAction: null` on a `complete` investigation is legal
 * (§3.1). Silently forwarding a malformed action would be the worse failure.
 */
function parseAgentReply(
  raw: unknown,
  finding: Finding,
  currentPoolSize: number | null,
): {
  rootCause: string;
  evidence: EvidenceItem[];
  confidence: number | null;
  action: RecommendedAction | null;
  manual: ManualRemediation | null;
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const rootCause = obj['rootCause'];
  if (typeof rootCause !== 'string' || rootCause.trim() === '') return null;

  const evidence: EvidenceItem[] = [];
  if (Array.isArray(obj['evidence'])) {
    for (const item of obj['evidence']) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const label = typeof e['label'] === 'string' ? e['label'] : null;
      const detail = typeof e['detail'] === 'string' ? e['detail'] : null;
      if (label === null || detail === null) continue;
      // DEFAULTS TO 'llm', the least trusted source. An agent that omits the field is asserting
      // rather than citing, and treating an unlabelled bullet as measured would let a model's
      // guess appear next to a tool reading with equal standing -- which is what a human approving
      // a write is looking at.
      const source =
        e['source'] === 'mcp_tool' || e['source'] === 'snapshot' ? e['source'] : 'llm';
      evidence.push({
        label,
        detail,
        source,
        tool: typeof e['tool'] === 'string' ? e['tool'] : null,
      });
    }
  }

  let confidence: number | null = null;
  const rawConfidence = obj['confidence'];
  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    // Clamped, not rejected: a model returning 1.2 meant "very confident", and discarding the
    // whole investigation over it would be worse than bounding it. Out-of-range is a model quirk,
    // not a corrupt response.
    confidence = Math.min(1, Math.max(0, rawConfidence));
  }

  let action: RecommendedAction | null = null;
  const rawAction = obj['recommendedAction'];
  if (typeof rawAction === 'object' && rawAction !== null) {
    const ra = rawAction as Record<string, unknown>;
    const inner = (ra['action'] ?? ra) as Record<string, unknown>;
    const type = inner['type'];
    const host = inner['host'];
    const size = inner['size'];
    const sizeOk =
      typeof size === 'number' && Number.isInteger(size) && size >= BOUNDS.min && size <= BOUNDS.max;
    // host must match the FINDING's host. An agent recommending a change to a different host than
    // the one under investigation is a reasoning failure, and forwarding it would hand a human an
    // approve button for something they did not ask about.
    if (type === 'set_pool_size' && host === finding.host && sizeOk) {
      /*
       * THE POOL SIZE NOW, and the agent is the only party in this exchange that read it (#178).
       *
       * `currentPoolSize` is the authoritative slot and wins when a caller supplies one, but no
       * caller does: `index.ts` passes null on purpose, because this service holds no production
       * config and `Host` carries no pool size. So before this the field was null on EVERY
       * investigation and the summary rendered `pool ? -> 8` on the one string a human reads before
       * approving a write to a live production.
       *
       * Taken from the reply because the agent HAS the value: `get_pool_size` and
       * `get_host_settings` are both mandatory calls in `BuildGoal`, and a live run attributed
       * `Current Pool Size | mcp_tool | GetHostSettings | 4 workers`. It is a transcription by a
       * model rather than a read by this service, which is why it is validated and why the
       * authoritative slot keeps precedence rather than being replaced.
       *
       * NOT VALIDATED AGAINST `BOUNDS`, deliberately. Those bound the TARGET of a write (2..8); the
       * value here describes what the production is already set to, and LABDEMO ships `Cloud API` at
       * PoolSize 1 -- below `BOUNDS.min`. Rejecting it would discard the true value in the shipped
       * configuration, so the test is only that it is a positive integer.
       */
      const claimed = inner['currentValue'] ?? ra['currentValue'];
      const claimedOk =
        typeof claimed === 'number' && Number.isInteger(claimed) && claimed >= 1;
      const current = currentPoolSize ?? (claimedOk ? (claimed as number) : null);
      action = {
        action: { type: 'set_pool_size', host: finding.host, size: size as number },
        currentValue: current,
        bounds: { ...BOUNDS },
        // TRUE EVEN WHEN `currentValue` IS NULL, and that is not an oversight. Reversibility does
        // not depend on this field: `resolve()` captures `before` from the write tool's own reply
        // and builds `reversal` from it, so the undo target comes from the instance at apply time
        // rather than from this number. `investigation-api.md` §3.3 defines the flag against
        // `currentValue`, which is narrower than how the reversal is actually obtained.
        reversible: true,
        requiresApproval: true,
        // NO `?` PLACEHOLDER. An unknown before-value is omitted rather than printed: §3.3 makes
        // this string authoritative and tells the consumer to render it as-is, so a placeholder here
        // becomes a question mark on an approve button. "to 8" states exactly what is known.
        summary:
          current === null
            ? `increase ${finding.host} pool to ${size as number}`
            : `increase ${finding.host} pool ${current} -> ${size as number}`,
      };
    }
  }

  /**
   * `manualRemediation` — STRICT, and dropped rather than repaired when it is not whole.
   *
   * The strictness is the same argument as for `action`: this reaches a human who acts on a live
   * production by hand. A half-parsed remediation ("create the directory" with no path, or a step
   * list the model returned as one string) is worse than none, because the operator follows it.
   *
   * `appliedBy` is not read from the reply at all — it is SET. The contract enumerates one member,
   * and letting a model choose the value would let it assert `"system"`, which is the one thing
   * root CLAUDE.md §2.1 forbids. A field whose only legal value is fixed should not be an input.
   */
  let manual: ManualRemediation | null = null;
  const rawManual = obj['manualRemediation'];
  if (typeof rawManual === 'object' && rawManual !== null) {
    const m = rawManual as Record<string, unknown>;
    const summary = typeof m['summary'] === 'string' ? m['summary'].trim() : '';
    const rawSteps = m['steps'];
    const steps = Array.isArray(rawSteps)
      ? rawSteps.filter((step): step is string => typeof step === 'string' && step.trim() !== '')
      : [];

    // Both required. A summary with no steps is a restatement of the root cause; steps with no
    // summary have no heading. Either alone is a partial parse, so neither is kept.
    if (summary !== '' && steps.length > 0) {
      let target: ManualRemediation['target'] = null;
      const rawTarget = m['target'];
      if (typeof rawTarget === 'object' && rawTarget !== null) {
        const t = rawTarget as Record<string, unknown>;
        const host = typeof t['host'] === 'string' ? t['host'] : '';
        const setting = typeof t['setting'] === 'string' ? t['setting'] : '';
        /* Built field by field from an ALLOWLIST of three keys -- never a spread. `target` describes
           configuration and the schema refuses extra keys for exactly one reason: a model that
           returned `messageBody` alongside `setting` would put payload content into a response that
           leaves the instance. Naming the three keys makes that unrepresentable here too. */
        if (host !== '' && setting !== '') {
          target = {
            host,
            setting,
            currentValue: typeof t['currentValue'] === 'string' ? t['currentValue'] : null,
          };
        }
      }
      manual = { summary, steps, target, appliedBy: 'operator' };
    }
  }

  return { rootCause, evidence, confidence, action, manual };
}

/**
 * Investigate one finding.
 *
 * Returns a valid response in every case, including failure — the contract serves 200 with a
 * labelled state rather than an error, because a blanked panel is worse on stage than a panel
 * saying "could not investigate" (§5).
 */
export async function investigate(
  finding: Finding,
  host: Host,
  projection: HostProjection | undefined,
  currentPoolSize: number | null,
  deps: InvestigateDeps,
): Promise<InvestigationResponse> {
  const now = deps.now ?? Date.now;
  const started = now();
  // Deterministic and correlatable: this id appears in the AI Hub audit entries for the tool calls
  // this investigation makes, which is how a reviewer ties an action back to the reasoning.
  const requestId = `inv-${finding.id}-${started}`;

  /*
   * THE §2.4 GATE, before anything is built and long before anything leaves the process.
   *
   * Placed here rather than in `index.ts` so it holds for every caller: the endpoint, a test, and any
   * future wiring. The panel hides its Investigate button for these types too, but a hidden button is
   * not a boundary — §2.4 says as much ("the check here is the backstop, not the UI's contract").
   *
   * `200` + `unavailable` rather than `400`, per §5's own line: a state is a state, and only a
   * malformed request is an error. The caller asked a legitimate question and the answer is no.
   */
  if (NEVER_FORWARDED.has(finding.type)) {
    deps.log?.(`investigation ${requestId} refused: ${finding.type} is outside the data boundary`);
    return unavailable(
      requestId,
      finding.id,
      started,
      // Names the reason without quoting the finding: the message is the thing that must not travel,
      // and a note is rendered in a browser.
      `${finding.type} findings are not investigated: the alert text is IRIS's, not ours to forward`,
    );
  }
  if (!INVESTIGABLE_TYPES.has(finding.type)) {
    deps.log?.(`investigation ${requestId} refused: no investigation exists for ${finding.type}`);
    return unavailable(
      requestId,
      finding.id,
      started,
      `no investigation exists for ${finding.type} findings`,
    );
  }

  // Built first and passed in: `snapshot.inboundRatePerSec` is derived from `trend.recentSlope`, and reading
  // it off the trend the agent actually receives is what keeps the two from ever disagreeing (#188).
  const trend = buildTrend(projection);
  const request: InvestigationRequest = {
    requestId,
    requestedAt: isoSeconds(started),
    finding,
    snapshot: buildSnapshot(host, projection, trend),
    trend,
  };

  let raw: unknown;
  try {
    raw = await deps.callAgent(request, TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.(`investigation ${requestId} failed: ${message}`);
    return unavailable(requestId, finding.id, now(), `agent call failed: ${message}`);
  }

  const parsed = parseAgentReply(raw, finding, currentPoolSize);
  if (parsed === null) {
    // §4.4: a malformed reply is a FAILURE, not a partial success. Serving half a parsed
    // investigation would put unvalidated model output in front of an approve button.
    deps.log?.(`investigation ${requestId}: agent reply did not validate`);
    return unavailable(requestId, finding.id, now(), 'agent reply did not match the contract');
  }

  const finished = now();
  return {
    requestId,
    findingId: finding.id,
    state: 'complete',
    source: deps.source,
    investigatedAt: isoSeconds(finished),
    rootCause: parsed.rootCause,
    evidence: parsed.evidence,
    confidence: parsed.confidence,
    recommendedAction: parsed.action,
    manualRemediation: parsed.manual,
    diagnostics: {
      model: typeof (raw as Record<string, unknown>)['model'] === 'string'
        ? ((raw as Record<string, unknown>)['model'] as string)
        : null,
      toolCalls: typeof (raw as Record<string, unknown>)['toolCalls'] === 'number'
        ? ((raw as Record<string, unknown>)['toolCalls'] as number)
        : null,
      durationMs: finished - started,
      note: null,
    },
  };
}
