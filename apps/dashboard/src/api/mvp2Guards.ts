/**
 * Parsers for the MVP 2 responses — field by field, never a cast.
 *
 * Same discipline as `guards.ts`, and for a sharper reason here. `contracts/investigation-api.md`
 * and `resolve-api.md` have no schema and no `.d.ts`, so nothing generated or tested enforces their
 * shape on either side. Dev B's engine hit exactly this: a `refusal` object typed by a cast passed
 * type-checking as `{code, detail}` while the contract said `{reason, message, checkedBy}`, and the
 * mismatch would have rendered `undefined` in a banner. A cast asserts; reading each field checks.
 *
 * TWO RULES SPECIFIC TO THESE SHAPES:
 *
 * 1. A MISSING NARRATIVE IS NOT A PARSE FAILURE. `rootCause: null` is a legitimate, meaningful
 *    response (§4.4) — the engine declining to invent an explanation. So the parser returns an
 *    investigation with `rootCause: null` rather than rejecting the payload.
 * 2. AN UNRECOGNISED `reason` IS FORWARDED, NOT DROPPED. §5 tells consumers to render
 *    `refusal.message` verbatim for any reason they do not know. A narrow union here would swallow a
 *    new refusal code and show nothing, which is worse than showing an unfamiliar label.
 */

import type {
  EvidenceItemView,
  EvidenceSource,
  InvestigationSource,
  InvestigationState,
  InvestigationView,
  RecommendedActionView,
  ResolveActionView,
  ResolveMode,
  ResolveOutcome,
  ResolveView,
} from '../types/mvp2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function poolShape(value: unknown): { poolSize: number } | null {
  if (!isRecord(value)) return null;
  const size = nullableNum(value['poolSize']);
  return size === null ? null : { poolSize: size };
}

function parseAction(value: unknown): ResolveActionView | null {
  if (!isRecord(value)) return null;
  const host = nullableStr(value['host']);
  const size = nullableNum(value['size']);
  // `type` is checked rather than assumed: a future second action type must not render as a pool
  // change, because the approve button's label and bounds are derived from it.
  if (value['type'] !== 'set_pool_size' || host === null || size === null) return null;
  return { type: 'set_pool_size', host, size };
}

function parseEvidence(value: unknown): EvidenceItemView[] {
  if (!Array.isArray(value)) return [];
  const items: EvidenceItemView[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const label = nullableStr(entry['label']);
    const detail = nullableStr(entry['detail']);
    if (label === null || detail === null) continue;
    /* Defaults to `llm`, the least trusted source, when the field is absent or unknown. An
       unlabelled bullet is an assertion rather than a citation, and showing it as `mcp_tool` would
       give a model's guess the same standing as a tool reading — in front of an approve button. */
    const raw = entry['source'];
    const source: EvidenceSource =
      raw === 'mcp_tool' || raw === 'snapshot' || raw === 'llm' ? raw : 'llm';
    items.push({ label, detail, source, tool: nullableStr(entry['tool']) });
  }
  return items;
}

function parseRecommendedAction(value: unknown): RecommendedActionView | null {
  if (!isRecord(value)) return null;
  const action = parseAction(value['action']);
  if (action === null) return null;
  const rawBounds = value['bounds'];
  /* Bounds come from the response, never from a constant here. A hardcoded 2..8 in the UI is the
     stale-copy defect the engine has already been bitten by — and the approve control uses these to
     decide what it may offer. */
  const bounds = isRecord(rawBounds)
    ? { min: nullableNum(rawBounds['min']) ?? action.size, max: nullableNum(rawBounds['max']) ?? action.size }
    : { min: action.size, max: action.size };
  return {
    action,
    currentValue: nullableNum(value['currentValue']),
    bounds,
    reversible: value['reversible'] === true,
    // DEFAULTS TO TRUE. An action whose approval requirement cannot be read must not render as
    // auto-appliable; the safe default is "a human must approve this".
    requiresApproval: value['requiresApproval'] !== false,
    summary: str(value['summary'], `set pool size to ${action.size}`),
  };
}

export function parseInvestigation(payload: unknown): InvestigationView | null {
  if (!isRecord(payload)) return null;

  const rawState = payload['state'];
  const state: InvestigationState =
    rawState === 'complete' || rawState === 'degraded' || rawState === 'unavailable'
      ? rawState
      : 'unavailable';

  const rawSource = payload['source'];
  const source: InvestigationSource =
    rawSource === 'agent' || rawSource === 'cache' || rawSource === 'canned' || rawSource === 'none'
      ? rawSource
      : 'none';

  const diagnostics = isRecord(payload['diagnostics']) ? payload['diagnostics'] : {};

  return {
    requestId: str(payload['requestId']),
    findingId: str(payload['findingId']),
    state,
    source,
    investigatedAt: str(payload['investigatedAt']),
    rootCause: nullableStr(payload['rootCause']),
    evidence: parseEvidence(payload['evidence']),
    confidence: nullableNum(payload['confidence']),
    recommendedAction: parseRecommendedAction(payload['recommendedAction']),
    diagnostics: {
      model: nullableStr(diagnostics['model']),
      toolCalls: nullableNum(diagnostics['toolCalls']),
      durationMs: nullableNum(diagnostics['durationMs']),
      note: nullableStr(diagnostics['note']),
    },
  };
}

export function parseResolve(payload: unknown): ResolveView | null {
  if (!isRecord(payload)) return null;

  const rawOutcome = payload['outcome'];
  const outcomes: readonly string[] = ['previewed', 'applied', 'no_change', 'refused', 'failed'];
  /* An unrecognised outcome becomes `failed`, never a success. This is the one response in the app
     that reports whether a live production changed, and guessing in the optimistic direction is the
     failure mode that matters. */
  const outcome: ResolveOutcome =
    typeof rawOutcome === 'string' && outcomes.includes(rawOutcome)
      ? (rawOutcome as ResolveOutcome)
      : 'failed';

  const rawMode = payload['mode'];
  const mode: ResolveMode = rawMode === 'apply' ? 'apply' : 'dry_run';

  const rawRefusal = payload['refusal'];
  const refusal = isRecord(rawRefusal)
    ? {
        reason: str(rawRefusal['reason'], 'unknown'),
        message: str(rawRefusal['message'], 'The request was refused.'),
        checkedBy: str(rawRefusal['checkedBy'], 'iris'),
        ...(isRecord(rawRefusal['bounds']) &&
        nullableNum((rawRefusal['bounds'] as Record<string, unknown>)['min']) !== null
          ? {
              bounds: {
                min: nullableNum((rawRefusal['bounds'] as Record<string, unknown>)['min']) ?? 0,
                max: nullableNum((rawRefusal['bounds'] as Record<string, unknown>)['max']) ?? 0,
              },
            }
          : {}),
      }
    : null;

  const rawReversal = payload['reversal'];
  const reversal =
    isRecord(rawReversal) && nullableNum(rawReversal['size']) !== null
      ? {
          host: str(rawReversal['host']),
          size: nullableNum(rawReversal['size']) ?? 0,
          capturedFrom: str(rawReversal['capturedFrom'], 'unknown'),
        }
      : null;

  const rawFailure = payload['failure'];
  const failure = isRecord(rawFailure)
    ? {
        stage: str(rawFailure['stage'], 'unknown'),
        message: str(rawFailure['message']),
        // FALSE unless explicitly true: "we could not confirm the live state" is the safe reading,
        // and it drives whether the UI tells the operator to verify by hand.
        liveStateVerified: rawFailure['liveStateVerified'] === true,
      }
    : null;

  const rawConfirmation = payload['confirmation'];
  const confirmation = isRecord(rawConfirmation)
    ? {
        status: str(rawConfirmation['status'], 'unknown'),
        findingId: nullableStr(rawConfirmation['findingId']),
        observeVia: str(rawConfirmation['observeVia']),
        expectedWithinSeconds: nullableNum(rawConfirmation['expectedWithinSeconds']) ?? 0,
        directEvidence: rawConfirmation['directEvidence'] === true,
      }
    : null;

  const rawAudit = payload['audit'];
  const audit =
    isRecord(rawAudit) && nullableStr(rawAudit['auditId']) !== null
      ? {
          auditId: nullableStr(rawAudit['auditId']),
          actor: nullableStr(rawAudit['actor']),
          role: nullableStr(rawAudit['role']),
          requestedBy: nullableStr(rawAudit['requestedBy']),
          tool: nullableStr(rawAudit['tool']),
          recordedAt: nullableStr(rawAudit['recordedAt']),
          source: nullableStr(rawAudit['source']),
        }
      : null;

  return {
    resolveId: str(payload['resolveId']),
    requestId: nullableStr(payload['requestId']),
    mode,
    outcome,
    action: parseAction(payload['action']),
    before: poolShape(payload['before']),
    after: poolShape(payload['after']),
    reversal,
    refusal,
    failure,
    confirmation,
    audit,
    requestedAt: str(payload['requestedAt']),
    completedAt: str(payload['completedAt']),
  };
}
