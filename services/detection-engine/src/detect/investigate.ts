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
import type { HostProjection } from './earlywarning.ts';

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
function buildSnapshot(host: Host, projection: HostProjection | undefined): Record<string, unknown> {
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
  };
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
 */
function buildTrend(projection: HostProjection | undefined): Record<string, unknown> | null {
  if (projection === undefined) return null;
  const slope = projection.projection?.slope ?? null;
  const threshold = projection.threshold?.value ?? null;
  if (slope === null && threshold === null) return null;
  return {
    metric: projection.metric,
    slope,
    slopeUnit: projection.projection?.slopeUnit ?? 'items/minute',
    /*
     * WHICH WAY THE QUEUE IS MOVING, and it is here because `slope` cannot answer it (#177).
     *
     * §2.2 says `slope` "may be zero or negative here ... because a queue that is draining is a fact
     * the agent should see", and the §4 example carries a non-null slope beside
     * `thresholdCrossed: true`. The implementation does not deliver that: `slope` is read from
     * `projection.projection`, which Early Warning sets to null for `already_crossed` — i.e. for
     * every condition this endpoint is ever called about. So the draining fact the contract promises
     * has never actually reached the agent, and it recommended enlarging a pool on a queue falling
     * 261 -> 181 because nothing in its input said "falling".
     *
     * `recentDirection` is the honest fix available without reopening `earlywarning-api.md` §1.4,
     * which forbids publishing a bare slope beside a withheld forecast — a direction is not a rate,
     * so it carries no forecast to mislabel. Sourced from the field #174 added, measured from the
     * tail of the same fit.
     *
     * The `slope`-is-always-null deviation is real and is NOT fixed here: honouring it needs the
     * window slope published or refitted, which is that contract's decision rather than this
     * function's. Filed separately.
     */
    recentDirection: projection.recentDirection,
    thresholdValue: threshold,
    thresholdCrossed:
      projection.currentValue !== null && threshold !== null
        ? projection.currentValue >= threshold
        : null,
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

  const request: InvestigationRequest = {
    requestId,
    requestedAt: isoSeconds(started),
    finding,
    snapshot: buildSnapshot(host, projection),
    trend: buildTrend(projection),
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
