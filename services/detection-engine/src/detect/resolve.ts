/**
 * Smart Resolve orchestration — the FIX stage.
 *
 * Implements `contracts/resolve-api.md`. That contract is authoritative; where this file and it
 * disagree, the contract is right and this is a bug.
 *
 * THIS SERVICE DOES NOT MUTATE THE PRODUCTION. It validates a request, forwards it to the governed
 * MCP write tool in IRIS, and returns what came back. The write happens behind RBAC, inside a
 * runtime that authorises and audits every tool call — `services/detection-engine/CLAUDE.md` §1.1
 * draws that line, and it is why this module holds no `Ens.*` call and no credential.
 *
 * SO THE VALIDATION HERE IS A CONVENIENCE, NOT THE SAFETY BOUNDARY. Everything checked below is
 * checked again in `Tools.Resolve`, which is the only place that can actually refuse. Validating
 * early gives a caller a fast, specific answer; it does not make this service trusted. If these two
 * ever disagree, the tool wins — it is the one holding the production.
 */

import type { ResolveAction } from './investigate.ts';

/** Contract §1.4. Closed set. */
export type ResolveOutcome = 'previewed' | 'applied' | 'no_change' | 'refused' | 'failed';

export type ResolveMode = 'dry_run' | 'apply';

export interface ResolveRequest {
  requestId?: string;
  mode: ResolveMode;
  action: ResolveAction;
  origin?: { findingId?: string; investigationId?: string };
  precondition?: { poolSize?: number };
  requestedBy?: string;
}

export interface ResolveResponse {
  resolveId: string;
  requestId: string | null;
  mode: ResolveMode;
  outcome: ResolveOutcome;
  action: ResolveAction | null;
  before: { poolSize: number } | null;
  after: { poolSize: number } | null;
  reversal: { host: string; size: number; capturedFrom: string } | null;
  /**
   * Contract §5: `reason`, `message`, `checkedBy` -- NOT `code`/`detail`.
   *
   * This said `{code, detail}` until 2026-08-19, which is a field-name drift from a ratified
   * contract in the one object Dev C renders when Approve is refused: §5 instructs consumers to
   * "render `refusal.message` verbatim" for an unrecognised reason, so the banner would have read
   * `undefined`. Caught in review on #92 (@kskubach) rather than by a test, because nothing here
   * validated the shape -- the type was a cast, and a cast asserts rather than checks.
   *
   * `reason` is a CLOSED set in §5's table. Typed as a string anyway: an unrecognised reason must
   * reach the UI to be rendered rather than be dropped by a narrow union, which is exactly what §5
   * asks for. The closed set is documented in the contract; enforcing it here would turn a new
   * refusal code into a swallowed one.
   */
  refusal: { reason: string; message: string; checkedBy: string; bounds?: { min: number; max: number } } | null;
  failure: { stage: string; message: string; liveStateVerified: boolean } | null;
  confirmation: {
    status: string;
    findingId: string | null;
    observeVia: string;
    expectedWithinSeconds: number;
    directEvidence: boolean;
  } | null;
  /**
   * Contract §8. PRESENT ON EVERY RESPONSE -- applies, refusals and dry-runs alike.
   *
   * Was missing entirely until 2026-08-19: the dispatcher returned it and this module dropped it,
   * so every response claimed §8 compliance while carrying no attribution at all. §8's opening line
   * is "the contract does not permit an unattributed write", and MVP 2 §2.2's whole reason for
   * putting the write tool in IRIS is that "the AI changed a production setting" be a reviewable,
   * attributable event. Dropping this field defeated that while looking correct.
   *
   * `null` is legal and MEANINGFUL rather than a blank: it means the record could not be written,
   * and §8 makes that `failed` / verify on an apply rather than a silent success.
   */
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

export interface ResolveDeps {
  /** Invokes the governed MCP write tool in IRIS. Injected so the endpoint is testable. */
  callTool(action: ResolveAction, dryRun: boolean, timeoutMs: number): Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
}

const TIMEOUT_MS = 30_000;

/**
 * Confirmation is ASYNCHRONOUS and the contract says so (§7).
 *
 * The write returns as soon as the production is updated, but the condition clearing is observed
 * through the existing findings path on the next poll — the queue has to actually drain. Claiming
 * "resolved" in this response would be claiming an outcome we have not seen. So the response says
 * where to look and roughly when, and `directEvidence: false` states plainly that this is not it.
 */
const EXPECTED_CLEAR_SECONDS = 120;

function isoSeconds(ms: number): string {
  return `${new Date(Math.round(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * Validate the request into a typed shape, or throw with a `bad request:` prefix.
 *
 * REJECTS UNKNOWN KEYS INSIDE `action`, matching §1.1. That strictness is the point rather than
 * pedantry: `action` is transcribed into a production write, so a tolerated extra key is a field
 * somebody believes is being honoured when it is being dropped.
 */
export function parseResolveRequest(body: unknown): ResolveRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('bad request: body must be an object');
  }
  const b = body as Record<string, unknown>;

  // REQUIRED, with no default. A missing mode must not become `apply` -- that would turn a caller's
  // omission into a live production write. It must not silently become `dry_run` either, because
  // then an approval would preview and the operator would wonder why nothing happened.
  const mode = b['mode'];
  if (mode !== 'dry_run' && mode !== 'apply') {
    throw new Error(`bad request: mode must be "dry_run" or "apply", got ${JSON.stringify(mode)}`);
  }

  const rawAction = b['action'];
  if (typeof rawAction !== 'object' || rawAction === null) {
    throw new Error('bad request: action must be an object');
  }
  const a = rawAction as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => k !== 'type' && k !== 'host' && k !== 'size');
  if (extra.length > 0) {
    throw new Error(`bad request: action carries unknown key(s) [${extra.join(', ')}]`);
  }
  if (a['type'] !== 'set_pool_size') {
    throw new Error(`bad request: action.type must be "set_pool_size", got ${JSON.stringify(a['type'])}`);
  }
  if (typeof a['host'] !== 'string' || a['host'] === '') {
    throw new Error('bad request: action.host must be a non-empty string');
  }
  if (typeof a['size'] !== 'number' || !Number.isInteger(a['size'])) {
    throw new Error('bad request: action.size must be an integer');
  }

  const out: ResolveRequest = {
    mode,
    action: { type: 'set_pool_size', host: a['host'], size: a['size'] },
  };
  if (typeof b['requestId'] === 'string') out.requestId = b['requestId'];
  if (typeof b['requestedBy'] === 'string') out.requestedBy = b['requestedBy'];
  if (typeof b['origin'] === 'object' && b['origin'] !== null) {
    const o = b['origin'] as Record<string, unknown>;
    out.origin = {};
    if (typeof o['findingId'] === 'string') out.origin.findingId = o['findingId'];
    if (typeof o['investigationId'] === 'string') out.origin.investigationId = o['investigationId'];
  }
  if (typeof b['precondition'] === 'object' && b['precondition'] !== null) {
    const p = b['precondition'] as Record<string, unknown>;
    if (typeof p['poolSize'] === 'number') out.precondition = { poolSize: p['poolSize'] };
  }
  return out;
}

/**
 * Read the contract's refusal object out of the tool's reply.
 *
 * Contract §5 field names, and `message` is the load-bearing one: Dev C renders it verbatim for
 * any reason they do not recognise, so losing it turns an informative refusal into a blank banner.
 * A refusal with no readable message still returns an object rather than null -- `outcome:
 * "refused"` with `refusal: null` would tell the UI something was refused for no stated reason,
 * which is worse than a generic sentence.
 */
function parseRefusal(value: unknown): ResolveResponse['refusal'] {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const reason = typeof r['reason'] === 'string' && r['reason'] !== '' ? r['reason'] : 'unknown';
  const message =
    typeof r['message'] === 'string' && r['message'] !== ''
      ? r['message']
      : `refused (${reason})`;
  // `checkedBy` says WHICH component refused, which matters when the answer is "not the one you
  // are looking at": a refusal from `iris` is the production's policy, not this service's
  // validation. Defaults to `iris` because that is the only thing that can refuse a real write.
  const checkedBy = typeof r['checkedBy'] === 'string' && r['checkedBy'] !== '' ? r['checkedBy'] : 'iris';
  const out: NonNullable<ResolveResponse['refusal']> = { reason, message, checkedBy };
  // §5 carries `bounds` on an `out_of_bounds` refusal so the UI can state the range without
  // hardcoding it. Forwarded when present, never synthesised: a guessed range that disagreed with
  // the tool's would be worse than none.
  const bounds = r['bounds'];
  if (typeof bounds === 'object' && bounds !== null) {
    const b = bounds as Record<string, unknown>;
    if (typeof b['min'] === 'number' && typeof b['max'] === 'number') {
      out.bounds = { min: b['min'], max: b['max'] };
    }
  }
  return out;
}

/**
 * Read the §8 audit block out of the tool's reply.
 *
 * FIELD BY FIELD, and every field defaults to `null` rather than to a placeholder. An audit record
 * is the one object in this response where a plausible-looking value is worse than an absent one:
 * a fabricated `actor` would make the log a record of what we assumed rather than of who acted,
 * which §8 calls "worse than no audit log because it is trusted".
 *
 * `requestedBy` comes from the REQUEST, not from the tool -- §8 is explicit that it is "a string a
 * browser typed" and is recorded next to `actor`, never in place of it. So it is threaded in here
 * rather than read from the reply, which is also why a caller cannot name itself as the actor.
 */
function parseAudit(value: unknown, requestedBy: string | null): ResolveResponse['audit'] {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  const str = (key: string): string | null => (typeof a[key] === 'string' && a[key] !== '' ? (a[key] as string) : null);
  const auditId = str('auditId');
  // No handle at all means nothing was written, which is a null audit rather than an object full of
  // nulls -- the distinction the engine's caller acts on.
  if (auditId === null) return null;
  return {
    auditId,
    actor: str('actor'),
    role: str('role'),
    requestedBy,
    tool: str('tool'),
    recordedAt: str('recordedAt'),
    source: str('source'),
  };
}

/** Read a `{poolSize: n}` shape out of the tool's reply, tolerating absence. */
function poolShape(value: unknown): { poolSize: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = (value as Record<string, unknown>)['poolSize'];
  return typeof p === 'number' ? { poolSize: p } : null;
}

/**
 * Apply or preview a resolve action by calling the governed tool.
 *
 * Returns a valid response for every outcome including refusal and failure. A refusal is a NORMAL
 * response, not an error (§5.2): the caller asked something the policy forbids, which is
 * information, and a 500 would make it indistinguishable from the production being broken.
 */
export async function resolve(
  request: ResolveRequest,
  deps: ResolveDeps,
): Promise<ResolveResponse> {
  const now = deps.now ?? Date.now;
  const started = now();
  const dryRun = request.mode === 'dry_run';

  const base = {
    resolveId: `res-${request.action.host.replace(/\s+/g, '-')}-${started}`,
    requestId: request.requestId ?? null,
    mode: request.mode,
    requestedAt: isoSeconds(started),
  };

  let raw: unknown;
  try {
    raw = await deps.callTool(request.action, dryRun, TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.(`resolve ${base.resolveId} failed: ${message}`);
    return {
      ...base,
      outcome: 'failed',
      action: request.action,
      before: null,
      after: null,
      reversal: null,
      refusal: null,
      // liveStateVerified FALSE, and this is the honest and important part: the call did not come
      // back, so we do not know whether the production changed. Claiming it did not would be a
      // guess, and a reader deciding whether to retry needs to know we cannot tell.
      failure: { stage: 'tool_call', message, liveStateVerified: false },
      confirmation: null,
      // NULL, and this is the honest reading: the call did not come back, so we do not know whether
      // an audit row exists. Claiming one we cannot name would be the fabrication §8 warns about.
      audit: null,
      completedAt: isoSeconds(now()),
    };
  }

  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const outcome = r['outcome'];
  const validOutcomes = ['previewed', 'applied', 'no_change', 'refused', 'failed'];
  if (typeof outcome !== 'string' || !validOutcomes.includes(outcome)) {
    // The tool answered with something we cannot classify. Reported as `failed` with
    // liveStateVerified false rather than guessed at: an unrecognised outcome from the one
    // component that can mutate a production is exactly when not to assume.
    deps.log?.(`resolve ${base.resolveId}: tool returned unrecognised outcome ${String(outcome)}`);
    return {
      ...base,
      outcome: 'failed',
      action: request.action,
      before: poolShape(r['before']),
      after: poolShape(r['after']),
      reversal: null,
      refusal: null,
      failure: {
        stage: 'tool_reply',
        message: `unrecognised outcome from the write tool: ${JSON.stringify(outcome)}`,
        liveStateVerified: false,
      },
      confirmation: null,
      // Forwarded even here. The reply was unreadable as an OUTCOME, but if it named an audit
      // handle that handle is still the pointer to what actually happened -- which is exactly what
      // someone investigating an unrecognised outcome needs.
      audit: parseAudit(r['audit'], request.requestedBy ?? null),
      completedAt: isoSeconds(now()),
    };
  }

  // READ FIELD BY FIELD, not cast. The previous version cast the tool's object straight to a
  // typed shape, which is why a field-name mismatch was invisible: a cast asserts the shape and
  // checks nothing, so `{code, detail}` type-checked cleanly as `{reason, message}` and produced
  // `undefined` at the UI. Reading each field is what makes a drift surface here instead of there.
  const refusal = parseRefusal(r['refusal']);
  const reversal =
    typeof r['reversal'] === 'object' && r['reversal'] !== null
      ? (r['reversal'] as { host: string; size: number; capturedFrom: string })
      : null;

  return {
    ...base,
    outcome: outcome as ResolveOutcome,
    action: request.action,
    before: poolShape(r['before']),
    after: poolShape(r['after']),
    reversal,
    refusal,
    failure:
      outcome === 'failed' && typeof r['failure'] === 'object' && r['failure'] !== null
        ? {
            stage: String((r['failure'] as Record<string, unknown>)['stage'] ?? 'unknown'),
            message: String((r['failure'] as Record<string, unknown>)['message'] ?? ''),
            liveStateVerified: false,
          }
        : null,
    // Only an APPLIED change has something to confirm. A preview changed nothing, a refusal was
    // rejected, and a no_change was already true -- attaching a confirmation to any of those would
    // tell a UI to watch for a clearance that is never coming.
    confirmation:
      outcome === 'applied'
        ? {
            status: 'pending',
            findingId: request.origin?.findingId ?? null,
            observeVia: 'GET /api/healthscan/findings',
            expectedWithinSeconds: EXPECTED_CLEAR_SECONDS,
            // FALSE: this response is evidence the write landed, not evidence the problem cleared.
            // The queue has to drain, which is observed on a later poll (§7).
            directEvidence: false,
          }
        : null,
    audit: parseAudit(r['audit'], request.requestedBy ?? null),
    completedAt: isoSeconds(now()),
  };
}
