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
  refusal: { code: string; detail: string } | null;
  failure: { stage: string; message: string; liveStateVerified: boolean } | null;
  confirmation: {
    status: string;
    findingId: string | null;
    observeVia: string;
    expectedWithinSeconds: number;
    directEvidence: boolean;
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
      completedAt: isoSeconds(now()),
    };
  }

  const refusal =
    typeof r['refusal'] === 'object' && r['refusal'] !== null
      ? (r['refusal'] as { code: string; detail: string })
      : null;
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
    completedAt: isoSeconds(now()),
  };
}
