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
  ChatAnswerView,
  ChatEvidenceItemView,
  ChatSource,
  ChatState,
  EvidenceItemView,
  ManualRemediationView,
  HostProjectionView,
  ProjectionDeclineReason,
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

/**
 * Read a manual remediation, or return null.
 *
 * SAME STRICTNESS AS THE ENGINE'S PARSER, AND FOR THE SAME REASON: this text is followed by a human
 * changing a live production by hand. A summary with no steps, or steps with no summary, is a partial
 * instruction — and a partial instruction is followed rather than questioned. Dropped whole.
 *
 * `target` is built from three named keys, never a spread. The schema refuses extra keys server-side
 * (§3.3a) and this refuses them again here, because a `messageBody` arriving alongside `setting`
 * would be payload content rendered in a browser.
 */
function parseManualRemediation(value: unknown): ManualRemediationView | null {
  if (!isRecord(value)) return null;
  const summary = nullableStr(value['summary']);
  const rawSteps = value['steps'];
  const steps = Array.isArray(rawSteps)
    ? rawSteps.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];
  if (summary === null || steps.length === 0) return null;

  let target: ManualRemediationView['target'] = null;
  if (isRecord(value['target'])) {
    const t = value['target'];
    const host = nullableStr(t['host']);
    const setting = nullableStr(t['setting']);
    if (host !== null && setting !== null) {
      target = { host, setting, currentValue: nullableStr(t['currentValue']) };
    }
  }

  /* Defaults to `operator` rather than trusting the payload. The field's only legal value is
     `operator`, and rendering anything else would tell an operator the system will act -- the one
     capability this product does not have. */
  const appliedBy = value['appliedBy'] === 'operator' ? 'operator' : 'operator';
  return { summary, steps, target, appliedBy };
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
    manualRemediation: parseManualRemediation(payload['manualRemediation']),
    diagnostics: {
      model: nullableStr(diagnostics['model']),
      toolCalls: nullableNum(diagnostics['toolCalls']),
      durationMs: nullableNum(diagnostics['durationMs']),
      note: nullableStr(diagnostics['note']),
    },
  };
}

/**
 * Chat evidence, dropping any bullet that is not whole.
 *
 * A bullet with no label has no heading and one with no detail has no content, so neither half alone
 * is kept. Same rule as `parseEvidence` above, minus the `source` field: for a chat answer the tool
 * NAME is the citation, and its absence is what marks a value the model asserted.
 */
function parseChatEvidence(value: unknown): ChatEvidenceItemView[] {
  if (!Array.isArray(value)) return [];
  const out: ChatEvidenceItemView[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const label = nullableStr(entry['label']);
    const detail = nullableStr(entry['detail']);
    if (label === null || detail === null) continue;
    out.push({ label, detail, tool: nullableStr(entry['tool']) });
  }
  return out;
}

/**
 * Parse one chat answer.
 *
 * `answer: null` IS NOT A PARSE FAILURE, by the same rule as `rootCause: null` above: it is the
 * engine declining to invent an answer, and the panel renders it as an explicit statement rather than
 * as an empty bubble that reads as still-loading.
 *
 * `state` and `source` both DEFAULT TO THE PESSIMISTIC VALUE. An unrecognised state reads as
 * `unavailable` and an unrecognised source as `none`, so a garbled payload cannot present itself as a
 * complete answer from a live agent — which is the one direction of error that matters, since
 * `source` is the field `iris/CLAUDE.md`'s pre-demo check relies on.
 *
 * `static` IS MATCHED EXPLICITLY, alongside `agent`, and it is still pessimistic: an unrecognised
 * value is `none` as before. Matched rather than folded into `agent` because the panel shows a
 * different provenance tag for each, and a small-talk reply wearing "Live agent" would claim a
 * metered call that never happened.
 */
export function parseChatAnswer(payload: unknown): ChatAnswerView | null {
  if (!isRecord(payload)) return null;

  const rawState = payload['state'];
  const state: ChatState = rawState === 'complete' ? 'complete' : 'unavailable';

  const rawSource = payload['source'];
  const source: ChatSource =
    rawSource === 'agent' ? 'agent' : rawSource === 'static' ? 'static' : 'none';

  const diagnostics = isRecord(payload['diagnostics']) ? payload['diagnostics'] : {};

  return {
    requestId: str(payload['requestId']),
    state,
    source,
    answeredAt: str(payload['answeredAt']),
    question: str(payload['question']),
    answer: nullableStr(payload['answer']),
    evidence: parseChatEvidence(payload['evidence']),
    confidence: nullableNum(payload['confidence']),
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

const DECLINE_REASONS: readonly string[] = [
  'disabled',
  'metric_unmeasurable',
  'warming',
  'insufficient_samples',
  'already_crossed',
  'not_rising',
  'beyond_horizon',
];

/**
 * Early Warning projections.
 *
 * `projection` IS ONLY BUILT WHEN IT IS WHOLE. A partially-read projection is the defect this
 * contract's shape exists to prevent -- a slope with no threshold, or a `secondsToThreshold` the
 * engine never sent, would render as a forecast nobody made. So a missing or non-numeric `slope`
 * drops the whole object to null rather than filling in a default.
 */
export function parseProjections(payload: unknown): HostProjectionView[] {
  if (!Array.isArray(payload)) return [];
  const out: HostProjectionView[] = [];

  for (const entry of payload) {
    if (!isRecord(entry)) continue;
    const host = nullableStr(entry['host']);
    if (host === null) continue;

    const rawThreshold = entry['threshold'];
    const threshold = isRecord(rawThreshold)
      ? {
          value: nullableNum(rawThreshold['value']),
          basis: str(rawThreshold['basis'], 'unknown'),
          baselineValue: nullableNum(rawThreshold['baselineValue']),
          findingType: str(rawThreshold['findingType']),
        }
      : null;

    const rawProjection = entry['projection'];
    let projection: HostProjectionView['projection'] = null;
    if (isRecord(rawProjection)) {
      const slope = nullableNum(rawProjection['slope']);
      if (slope !== null) {
        projection = {
          kind: 'projection',
          slope,
          slopeUnit: str(rawProjection['slopeUnit'], 'items/minute'),
          secondsToThreshold: nullableNum(rawProjection['secondsToThreshold']),
          crossesAt: nullableStr(rawProjection['crossesAt']),
        };
      }
    }

    const rawReason = entry['projectionUnavailable'];
    const reason =
      typeof rawReason === 'string' && DECLINE_REASONS.includes(rawReason)
        ? (rawReason as ProjectionDeclineReason)
        : null;

    out.push({
      host,
      metric: str(entry['metric'], 'queued'),
      currentValue: nullableNum(entry['currentValue']),
      measuredAt: str(entry['measuredAt']),
      fitSampleCount: nullableNum(entry['fitSampleCount']) ?? 0,
      fitSpanSeconds: nullableNum(entry['fitSpanSeconds']) ?? 0,
      threshold,
      projection,
      projectionUnavailable: reason,
    });
  }
  return out;
}
