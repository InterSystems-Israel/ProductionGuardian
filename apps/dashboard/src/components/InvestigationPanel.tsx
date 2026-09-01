/**
 * AI Detective and Smart Resolve, inside the finding drawer.
 *
 * WHY IT LIVES IN THE DRAWER rather than in its own view: an investigation explains one finding, and
 * the numbers it reasons about are the ones already on screen above it. A separate view would make
 * the operator hold "queue 486, baseline 15" in their head while reading the explanation.
 *
 * THE THREE THINGS THIS COMPONENT MUST NOT GET WRONG:
 *
 * 1. A CANNED INVESTIGATION MUST NOT LOOK LIVE. `source` is rendered as a visible badge, not hidden
 *    in diagnostics. Presenting a mock narrative as a real one is the same defect class as showing a
 *    projection as a measurement, and it is worse here because a human approves a production write
 *    on the strength of it.
 * 2. `rootCause: null` IS AN ANSWER, NOT A BLANK. It means the engine declined to invent an
 *    explanation (investigation-api.md §4.4). Rendered as an explicit statement with the
 *    diagnostic note, never as an empty panel that reads as still-loading.
 * 3. EVIDENCE PROVENANCE IS PART OF THE EVIDENCE. `mcp_tool` was read from the live production by a
 *    governed tool; `snapshot` came from the finding; `llm` is the model asserting something nothing
 *    measured. Each bullet carries its source, because a reader deciding whether to approve needs
 *    to know which is which.
 *
 * 4. A RECOMMENDATION THE SYSTEM CANNOT APPLY MUST NOT LOOK APPLIABLE. MVP 3's `manualRemediation`
 *    renders as instructions with NO Preview and NO Approve, because there is no `action` to send.
 *    The acceptance criterion is the ABSENCE of a control (§3.3a), which is the kind of thing every
 *    check passes while the defect is present -- so it is rendered from a separate branch that has
 *    no access to `onResolve` rather than from the same branch with a disabled button.
 *
 * APPROVE IS DELIBERATELY THE SECOND STEP. Preview first, then approve, and the preview's own
 * response is what populates the before/after the approve button is labelled with — so the operator
 * approves a change they have already seen the shape of. `resolve-api.md` §1.1 requires the mode to
 * be explicit for the same reason: nothing about a write should be inferred.
 */

import type { InvestigationView, ResolveActionView, ResolveMode, ResolveView } from '../types/mvp2';
import { ABSENT, toolLabel } from '../lib/format';
import { findingMeta, investigationScope } from '../lib/findingMeta';

export interface InvestigationPanelProps {
  /** The finding's type, for the §2.4 scope check. Only the type is needed, so only it is passed. */
  findingType: string;
  investigation: InvestigationView | null;
  investigating: boolean;
  error: string | null;
  resolve: ResolveView | null;
  resolving: ResolveMode | null;
  resolveError: string | null;
  onInvestigate: () => void;
  onResolve: (mode: ResolveMode, action: ResolveActionView) => void;
}

/** §3.2's three sources, as short operator-facing labels. */
const SOURCE_LABEL: Record<string, string> = {
  mcp_tool: 'read from IRIS',
  snapshot: 'from the finding',
  llm: 'asserted by the model',
};

/**
 * The outcome, phrased for an operator rather than echoed as an enum.
 *
 * `refused` says the safety model worked -- §5.2 is explicit that `refused` and `failed` must not be
 * merged in the UI, because one means nothing was written and the other means something was tried.
 */
const OUTCOME_LABEL: Record<string, string> = {
  previewed: 'Preview only — nothing was changed',
  applied: 'Applied to the live production',
  no_change: 'Already at this value — nothing to do',
  refused: 'Refused',
  failed: 'Failed',
};

function confidenceText(confidence: number | null): string {
  if (confidence === null) return ABSENT;
  /* Shown as a percentage but NOT described as a probability. §3.4 says it is the model's own
     self-report and is not calibrated, so the label says "self-reported". */
  return `${Math.round(confidence * 100)}%`;
}

export function InvestigationPanel({
  findingType,
  investigation,
  investigating,
  error,
  resolve,
  resolving,
  resolveError,
  onInvestigate,
  onResolve,
}: InvestigationPanelProps): JSX.Element {
  const recommended = investigation?.recommendedAction ?? null;
  const manual = investigation?.manualRemediation ?? null;
  const canned = investigation?.source === 'canned';
  const unavailable = investigation !== null && investigation.rootCause === null;
  const scope = investigationScope(findingType);

  /*
   * OUT OF SCOPE RETURNS EARLY rather than wrapping the button in a condition, so `onInvestigate` is
   * unreachable from this branch at all. Same argument as `manualRemediation` renders from its own
   * branch below: a control that must not exist should be absent by construction, not disabled by an
   * `if` somebody can invert later. §2.4 asks the UI not to offer the button; the engine refuses
   * independently, which is what makes this a UI concern rather than the boundary itself.
   */
  if (scope !== 'investigable') {
    return (
      <section className="pg-investigate" aria-label="AI Detective and Smart Resolve">
        <h3 className="pg-investigate__heading">Why is this happening?</h3>
        <p className="pg-investigate__intro">
          {scope === 'never_forwarded' ? (
            <>
              <strong>System alerts are not investigated.</strong> The text of an alert is written by
              IRIS and can name the message it was about, so it never leaves the instance — only
              metrics and configuration do. The alert itself is above, verbatim.
            </>
          ) : (
            <>
              <strong>
                No investigation exists for {findingMeta(findingType).label.toLowerCase()} findings
              </strong>{' '}
              yet. The AI Detective covers queue buildup on a throughput-bound host and a host that
              has stopped processing. Nothing is being withheld — this one has not been built.
            </>
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="pg-investigate" aria-label="AI Detective and Smart Resolve">
      <h3 className="pg-investigate__heading">Why is this happening?</h3>

      {investigation === null && !investigating && error === null && (
        <>
          <p className="pg-investigate__intro">
            Ask the AI Detective to look at this finding. It reads live configuration and metrics
            through governed, audited tools — never message content.
          </p>
          <button type="button" className="pg-button pg-button--primary" onClick={onInvestigate}>
            Investigate
          </button>
        </>
      )}

      {investigating && (
        <p className="pg-investigate__status" role="status">
          Investigating… the agent is reading live values from IRIS. This usually takes a few
          seconds.
        </p>
      )}

      {error !== null && (
        <div className="pg-investigate__error" role="alert">
          <p>{error}</p>
          {/* Retry rather than a dead end: the common causes -- a cold agent, a rate limit, a
              missing provider -- are all transient or configuration, and none is helped by making
              the operator reopen the drawer. */}
          <button type="button" className="pg-button" onClick={onInvestigate}>
            Try again
          </button>
        </div>
      )}

      {investigation !== null && (
        <>
          <div className="pg-investigate__provenance">
            {canned ? (
              /* THE MOST IMPORTANT LABEL IN THIS COMPONENT. Demo mode and a live agent must be
                 distinguishable at a glance, or a rehearsal teaches the wrong thing. */
              <span className="pg-tag pg-tag--warn">Canned — demo mode, not a live agent</span>
            ) : (
              <span className="pg-tag pg-tag--ok">Live agent</span>
            )}
            {investigation.diagnostics.model !== null && (
              <span className="pg-tag">{investigation.diagnostics.model}</span>
            )}
            {investigation.diagnostics.toolCalls !== null && (
              /* Tool calls are the honest check that evidence was gathered rather than recalled: a
                 plausible narrative with zero tool calls is a model reasoning from its priors. */
              <span className="pg-tag">
                {investigation.diagnostics.toolCalls} tool call
                {investigation.diagnostics.toolCalls === 1 ? '' : 's'}
              </span>
            )}
            {investigation.confidence !== null && (
              <span className="pg-tag">
                {confidenceText(investigation.confidence)} confidence (self-reported)
              </span>
            )}
          </div>

          {unavailable ? (
            <div className="pg-investigate__unavailable">
              <p>
                <strong>No root cause is available.</strong> The engine could not produce an
                explanation, and it will not invent one.
              </p>
              {investigation.diagnostics.note !== null && (
                <p className="pg-investigate__note">{investigation.diagnostics.note}</p>
              )}
              <button type="button" className="pg-button" onClick={onInvestigate}>
                Try again
              </button>
            </div>
          ) : (
            <p className="pg-investigate__rootcause">{investigation.rootCause}</p>
          )}

          {investigation.evidence.length > 0 && (
            <ul className="pg-evidence">
              {investigation.evidence.map((item, index) => (
                <li key={`${item.label}-${index}`} className="pg-evidence__item">
                  <div className="pg-evidence__head">
                    <span className="pg-evidence__label">{item.label}</span>
                    <span className={`pg-evidence__source pg-evidence__source--${item.source}`}>
                      {SOURCE_LABEL[item.source] ?? item.source}
                      {item.tool !== null && (
                        <span className="pg-facts__mono"> · {toolLabel(item.tool)}</span>
                      )}
                    </span>
                  </div>
                  <div className="pg-evidence__detail">{item.detail}</div>
                </li>
              ))}
            </ul>
          )}

          {manual !== null && (
            /* SEPARATE BRANCH, NOT A VARIANT OF THE RESOLVE PANEL. This JSX never references
               `onResolve`, `resolving` or `resolve`, so an approve control cannot appear here by
               editing a condition -- the handler is not in scope. That is the structural version of
               §3.3a's argument: the wrong UI is unrepresentable rather than forbidden. */
            <div className="pg-manual">
              <h3 className="pg-investigate__heading">What to do</h3>
              <p className="pg-manual__summary">{manual.summary}</p>

              <ol className="pg-manual__steps">
                {manual.steps.map((step, index) => (
                  /* Verbatim, in order. The panel does not reword, merge or renumber -- these are
                     instructions someone will follow against a live production. */
                  <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
                ))}
              </ol>

              {manual.target !== null && (
                <dl className="pg-facts">
                  <div className="pg-facts__row">
                    <dt>Setting</dt>
                    <dd className="pg-facts__mono">
                      {manual.target.host} · {manual.target.setting}
                    </dd>
                  </div>
                  {manual.target.currentValue !== null && (
                    <div className="pg-facts__row">
                      <dt>Current value</dt>
                      <dd className="pg-facts__mono">{manual.target.currentValue}</dd>
                    </div>
                  )}
                </dl>
              )}

              {/* Says plainly that the product will not do this. Without it, an operator who has
                  just used Approve on the other scenario may wait for a button that never comes. */}
              <p className="pg-manual__gate">
                Production Guardian cannot make this change for you — it is outside the one action
                the system is permitted to apply. Do it on the IRIS host, then the finding clears on
                its own once the host recovers.
              </p>
            </div>
          )}

          {recommended !== null && (
            <div className="pg-resolve">
              <h3 className="pg-investigate__heading">Recommended action</h3>
              <p className="pg-resolve__summary">{recommended.summary}</p>

              <dl className="pg-facts">
                <div className="pg-facts__row">
                  <dt>Action</dt>
                  <dd className="pg-facts__mono">
                    {recommended.action.type} · {recommended.action.host} ·{' '}
                    {recommended.action.size}
                  </dd>
                </div>
                <div className="pg-facts__row">
                  <dt>Allowed range</dt>
                  <dd className="pg-facts__mono">
                    {recommended.bounds.min}–{recommended.bounds.max}
                  </dd>
                </div>
                <div className="pg-facts__row">
                  <dt>Reversible</dt>
                  <dd>{recommended.reversible ? 'Yes' : 'No'}</dd>
                </div>
              </dl>

              <div className="pg-resolve__actions">
                <button
                  type="button"
                  className="pg-button"
                  disabled={resolving !== null}
                  onClick={() => onResolve('dry_run', recommended.action)}
                >
                  {resolving === 'dry_run' ? 'Previewing…' : 'Preview'}
                </button>
                <button
                  type="button"
                  className="pg-button pg-button--primary"
                  disabled={resolving !== null}
                  onClick={() => onResolve('apply', recommended.action)}
                >
                  {resolving === 'apply' ? 'Applying…' : 'Approve and apply'}
                </button>
              </div>

              {recommended.requiresApproval && (
                <p className="pg-resolve__gate">
                  This writes to the live production. It is applied only when you approve it, it is
                  bounded to {recommended.bounds.min}–{recommended.bounds.max}, and every call is
                  audited.
                </p>
              )}

              {resolveError !== null && (
                <div className="pg-investigate__error" role="alert">
                  <p>{resolveError}</p>
                  {/* The request may have landed. Saying so is the honest reading of a transport
                      failure on a write, and it is what resolve-api.md's liveStateVerified: false
                      says when the engine does answer. */}
                  <p className="pg-investigate__note">
                    If this was an approval, check the pool size before retrying — the request may
                    have reached the production.
                  </p>
                </div>
              )}

              {resolve !== null && (
                <div
                  className={`pg-resolve__outcome pg-resolve__outcome--${resolve.outcome}`}
                  role="status"
                >
                  <p className="pg-resolve__outcome-label">
                    {OUTCOME_LABEL[resolve.outcome] ?? resolve.outcome}
                  </p>

                  {resolve.before !== null && resolve.after !== null && (
                    <p className="pg-facts__mono">
                      pool {resolve.before.poolSize} → {resolve.after.poolSize}
                      {resolve.mode === 'dry_run' && ' (would be)'}
                    </p>
                  )}

                  {resolve.refusal !== null && (
                    <>
                      {/* Rendered VERBATIM. §5 tells consumers to do that for any reason they do
                          not recognise, and the message is the only part guaranteed to explain a
                          refusal code the UI has never seen. */}
                      <p className="pg-resolve__refusal">{resolve.refusal.message}</p>
                      <p className="pg-investigate__note">
                        Reason <span className="pg-facts__mono">{resolve.refusal.reason}</span>,
                        checked by{' '}
                        <span className="pg-facts__mono">{resolve.refusal.checkedBy}</span>. Nothing
                        was written.
                      </p>
                    </>
                  )}

                  {resolve.failure !== null && (
                    <p className="pg-resolve__refusal">
                      {resolve.failure.message}
                      {!resolve.failure.liveStateVerified && (
                        <>
                          {' '}
                          The live state could not be confirmed — check the pool size before
                          retrying.
                        </>
                      )}
                    </p>
                  )}

                  {resolve.reversal !== null && (
                    <p className="pg-investigate__note">
                      To undo: set {resolve.reversal.host} back to{' '}
                      <span className="pg-facts__mono">{resolve.reversal.size}</span> (captured{' '}
                      {resolve.reversal.capturedFrom}).
                    </p>
                  )}

                  {resolve.confirmation !== null && !resolve.confirmation.directEvidence && (
                    /* The write landed; the CONDITION clearing is a separate observation (§7).
                       Saying so prevents "applied" being read as "fixed" while the queue drains. */
                    <p className="pg-investigate__note">
                      The change is in place. The finding clears on its own once the queue drains —
                      usually within {resolve.confirmation.expectedWithinSeconds} seconds.
                    </p>
                  )}

                  {resolve.audit !== null ? (
                    <p className="pg-investigate__note">
                      Audited as{' '}
                      <span className="pg-facts__mono">{resolve.audit.auditId}</span>
                      {resolve.audit.actor !== null && <> by {resolve.audit.actor}</>}
                      {resolve.audit.source === 'mock' && ' (demo mode)'}
                    </p>
                  ) : (
                    resolve.outcome === 'applied' && (
                      /* No audit row for a write is a reviewability gap, not a cosmetic one --
                         resolve-api.md §8 makes it a reason to verify rather than a silent pass. */
                      <p className="pg-resolve__refusal">
                        No audit record was returned for this change. Verify it by hand.
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          )}
          {recommended === null && manual === null && !unavailable && (
            /* §3.1: an investigation with no recommendation of either kind is COMPLETE, not broken.
               Said explicitly, because an empty space below a root cause reads as a panel that
               failed to load -- which is the same defect as Early Warning rendering nothing for
               `already_crossed` and looking unbuilt. */
            <p className="pg-investigate__note">
              The agent explained the condition and recommended no action. Nothing here is applied
              automatically, and no fix is being withheld — there is simply none it could name.
            </p>
          )}
        </>
      )}
    </section>
  );
}
