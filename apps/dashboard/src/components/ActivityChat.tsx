/**
 * Production insights chat — ask a question about this production in natural language.
 *
 * The answer comes from an AI Hub agent inside IRIS reading four families of evidence through
 * governed, audited MCP tools: recorded activity (`Ens_Activity_Data.{Seconds,Hours,Days}`), the
 * event log, configuration changes from `%SYS.Audit`, and the findings Guardian is currently
 * reporting. `Tools/Governance.cls`'s `chat` row is the authoritative membership. This component
 * renders what it is given and composes nothing.
 *
 * THE NAME IS ACTIVITY-ONLY AND THE PANEL IS NOT, any more. Kept as `ActivityChat` because renaming
 * the file would touch every importer for no behavioural gain, but the copy it renders must describe
 * all four families — it described only activity for two families' worth of releases (#175).
 *
 * THE FOUR THINGS IT MUST NOT GET WRONG, which are `InvestigationPanel`'s three plus one:
 *
 * 1. A DECLINED ANSWER MUST NOT LOOK LIKE A FAILED ONE. `answer: null` is the engine refusing to
 *    invent a reply, and in demo mode it is the honest "this needs the live agent". Rendered as an
 *    explicit statement with its `note`, never as an empty bubble that reads as still-loading.
 * 2. PROVENANCE IS PART OF THE ANSWER. Every evidence bullet names the tool that read it, and a
 *    bullet with NO tool is labelled as the model's own assertion. A reader deciding whether to
 *    believe a number is entitled to know which kind it is — the same rule
 *    `InvestigationPanel` applies to `evidence[].source`.
 * 3. ZERO TOOL CALLS IS A WARNING, NOT A DETAIL. An answer produced without reading anything is a
 *    model reasoning from its priors about a production it has never seen. `iris/CLAUDE.md`'s
 *    pre-demo check turns on this number, so it is on screen and it is called out when it is zero
 *    rather than being one grey tag among several.
 * 4. THE DATA BOUNDARY IS STATED WHERE THE QUESTION IS TYPED. This is the first place in the product
 *    where a human writes free text that reaches an external model, so the input says what will and
 *    will not be answered. Not as reassurance — as an explanation of why "which patient was in
 *    message 4821" comes back declined. The guarantee itself is in the tools, not in this sentence.
 *
 * A RELOAD STARTS A NEW CONVERSATION, and the panel says so. Session state cannot be held in IRIS —
 * `%AI.Agent.Session`'s agent handle is transient and a CSP dispatcher runs in a pooled process — so
 * the transcript lives in `useChat` and dies with the page. Stating it is better than a
 * `localStorage` restore that would give the operator a history the agent has no memory of.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatExchange } from '../hooks/useChat';
import { toolLabel } from '../lib/format';
import { IconMessages } from './icons';

export interface ActivityChatProps {
  exchanges: ChatExchange[];
  asking: boolean;
  onAsk: (question: string) => void;
  onClear: () => void;
  /** Mirrors `ChatDispatcher.#MAXQUESTION`, which is the authority and refuses over it. */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 600;

/**
 * Starter questions, and they are about SHAPE rather than about this production.
 *
 * NOT A HOST NAME AMONG THEM, deliberately. Root `CLAUDE.md` §6 and `apps/dashboard/CLAUDE.md` §9
 * both forbid a hardcoded host name in `src/` — the UI renders whatever the API returns, and a
 * suggestion naming `Cloud API` would be this directory tracking someone else's config, which is
 * exactly what went stale when `FHIR Transform` was removed. These read as questions an operator
 * would ask of any production, and the agent's own `get_activity_coverage` call is what discovers
 * the host names.
 *
 * "WHAT CAN YOU DO?" IS FIRST, AND IT IS THE ONE THAT COSTS NOTHING. IRIS classifies it as a
 * capability question and answers it from a fixed catalogue — no model call, no tool call — so it is
 * the cheapest chip here as well as the one that teaches an operator what the rest are examples of.
 * It leads for that reason: the reported defect was that the assistant did not behave like one, and
 * the first thing an assistant should be able to say is what it is for.
 *
 * ONE CHIP PER CAPABILITY, which is what #175 was about. The agent reads four families of evidence
 * (`Tools/Governance.cls`'s `chat` row: activity, event log, configuration changes, active findings)
 * and every chip here used to be an activity question, so two of the four were undiscoverable — a
 * capability nobody asks about is indistinguishable from one that does not exist. The findings chip
 * is second because "is anything wrong" is the commonest question this panel is asked and the one it
 * could not answer before MVP 3; `ChatDispatcher.SystemPrompt` puts the same tool first for the same
 * reason. Two activity chips were dropped to make room rather than growing the list past six.
 */
const SUGGESTIONS: readonly string[] = [
  'What can you do?',
  'Is anything wrong with the production right now?',
  'Are there errors in the event log, and when did they start?',
  'Have any settings been changed recently?',
  'Which host is handling the most messages right now?',
  'How has throughput changed over the last few hours?',
];

function confidenceText(confidence: number | null): string | null {
  if (confidence === null) return null;
  /* A percentage, but never described as a probability: it is the model's own self-report and is not
     calibrated. The label says "self-reported", matching InvestigationPanel. */
  return `${Math.round(confidence * 100)}%`;
}

export function ActivityChat({
  exchanges,
  asking,
  onAsk,
  onClear,
  maxLength = DEFAULT_MAX_LENGTH,
}: ActivityChatProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const listEnd = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /* Scroll the newest exchange into view as it arrives, so a long answer does not appear off-screen.
     `block: 'nearest'` rather than a full scroll so the page does not jump when the panel is already
     visible. Honours reduced motion by using `auto` behaviour -- an animated scroll on every answer
     is the kind of motion the accessibility bar (§7.3) asks to be avoidable, and there is nothing
     gained by animating it. */
  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [exchanges]);

  const submit = useCallback((): void => {
    const question = draft.trim();
    if (question === '' || asking) return;
    onAsk(question);
    setDraft('');
    // Focus stays in the input so a follow-up can be typed immediately, which is what makes this
    // usable as a conversation rather than as a form.
    inputRef.current?.focus();
  }, [asking, draft, onAsk]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      /* Enter sends; Shift+Enter makes a newline. A textarea rather than an input because a question
         can be two sentences, and a plain input would silently discard the shape of one. */
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const empty = exchanges.length === 0;

  return (
    <section className="pg-chat" aria-labelledby="pg-chat-heading">
      <div className="pg-chat__head">
        <h2 id="pg-chat-heading" className="pg-section__title">
          <IconMessages size={16} />
          Ask about this production
        </h2>
        {!empty && (
          <button type="button" className="pg-button pg-button--subtle" onClick={onClear}>
            New conversation
          </button>
        )}
      </div>

      <p className="pg-chat__intro">
        Ask what Guardian is reporting right now, about message volume, throughput and latency over
        time, about what the production logged, or about recent configuration changes. An AI agent
        inside IRIS answers by reading those tables through governed, audited tools — it sees
        counts, durations, severities and configuration only, never message content or patient data.
      </p>

      {empty && (
        <ul className="pg-chat__suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                className="pg-chat__suggestion"
                disabled={asking}
                onClick={() => onAsk(suggestion)}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!empty && (
        /* `aria-live="polite"` so an answer arriving is announced rather than silently appearing --
           the same treatment §7.3 requires for the findings count, and more important here because
           the operator is waiting on this specific response. */
        <ol className="pg-chat__log" aria-live="polite">
          {exchanges.map((exchange) => (
            <li key={exchange.id} className="pg-chat__exchange">
              <p className="pg-chat__question">{exchange.question}</p>

              {exchange.error !== null && (
                <div className="pg-chat__error" role="alert">
                  <p>{exchange.error}</p>
                  {/* Retryable by asking again -- the common causes (a cold agent, a rate limit, a
                      missing provider) are transient or configuration, and none is helped by
                      clearing the conversation. */}
                  <button
                    type="button"
                    className="pg-button"
                    disabled={asking}
                    onClick={() => onAsk(exchange.question)}
                  >
                    Ask again
                  </button>
                </div>
              )}

              {exchange.answer === null && exchange.error === null && (
                <p className="pg-chat__pending" role="status">
                  Reading the activity tables…
                </p>
              )}

              {exchange.answer !== null && <ChatAnswer answer={exchange.answer} onRetry={() => onAsk(exchange.question)} asking={asking} />}
            </li>
          ))}
          <div ref={listEnd} />
        </ol>
      )}

      <div className="pg-chat__composer">
        <label className="pg-visually-hidden" htmlFor="pg-chat-input">
          Your question about interoperability activity
        </label>
        <textarea
          id="pg-chat-input"
          ref={inputRef}
          className="pg-chat__input"
          value={draft}
          rows={2}
          maxLength={maxLength}
          disabled={asking}
          placeholder="e.g. how has message volume changed today?"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="pg-chat__composer-actions">
          {/* The remaining count appears only near the limit, so it is information rather than
              decoration -- and it appears before the limit bites, since IRIS refuses over it. */}
          {draft.length > maxLength - 100 && (
            <span className="pg-chat__count">{maxLength - draft.length} left</span>
          )}
          <button
            type="button"
            className="pg-button pg-button--primary"
            disabled={asking || draft.trim() === ''}
            onClick={submit}
          >
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>
    </section>
  );
}

interface ChatAnswerProps {
  answer: NonNullable<ChatExchange['answer']>;
  onRetry: () => void;
  asking: boolean;
}

/**
 * One answer, with its provenance.
 *
 * SPLIT OUT because the parent was past the ~150-line guidance in `CLAUDE.md` §3 and because the
 * declined branch and the answered branch share nothing but a container -- keeping them in one
 * function invited an `if` that renders half of each.
 */
function ChatAnswer({ answer, onRetry, asking }: ChatAnswerProps): JSX.Element {
  const declined = answer.answer === null;
  const confidence = confidenceText(answer.confidence);
  const toolCalls = answer.diagnostics.toolCalls;
  /* A greeting, a thanks, a farewell or a "what can you do", classified in IRIS and answered from a
     fixed catalogue with no model call and no tool call. It changes what the provenance row may claim:
     see the two branches below, and `types/mvp2.ts` `ChatSource` for why it is a third value rather
     than a degraded `agent`. */
  const isStatic = answer.source === 'static';

  if (declined) {
    return (
      <div className="pg-chat__declined">
        <p>
          <strong>No answer is available.</strong> Nothing was invented to fill the gap.
        </p>
        {/* The note is where the REASON lives -- "demo mode cannot answer this", "no agent is
            configured", "the agent reply could not be read" are materially different and the
            operator's next action differs for each. */}
        {answer.diagnostics.note !== null && (
          <p className="pg-chat__note">{answer.diagnostics.note}</p>
        )}
        <button type="button" className="pg-button" disabled={asking} onClick={onRetry}>
          Ask again
        </button>
      </div>
    );
  }

  return (
    <div className="pg-chat__answer">
      <div className="pg-chat__provenance">
        {/* NOT "Live agent" FOR A STATIC REPLY. That tag is the panel's claim that a governed agent
            ran, and wearing it over catalogue text would assert a metered call that never happened --
            the same class of over-claim as labelling a mock's output as measured. */}
        {isStatic ? (
          <span className="pg-tag">No data needed</span>
        ) : (
          <span className="pg-tag pg-tag--ok">Live agent</span>
        )}
        {answer.diagnostics.model !== null && (
          <span className="pg-tag">{answer.diagnostics.model}</span>
        )}
        {toolCalls !== null &&
          (toolCalls === 0 ? (
            /* ZERO MEANS TWO DIFFERENT THINGS AND THE SOURCE IS WHAT SEPARATES THEM. From the agent it
               is the warning it has always been: a model answered from its priors about a production
               it has never seen, and that is the one diagnostic a reader must not skim past. From a
               static reply it is the honest signal that nothing needed reading -- so it is stated
               plainly rather than flagged, because a warning on a greeting trains a reader to ignore
               the warning that matters. */
            isStatic ? (
              <span className="pg-tag">0 tool calls — nothing was read</span>
            ) : (
              <span className="pg-tag pg-tag--warn">
                0 tool calls — not read from this production
              </span>
            )
          ) : (
            <span className="pg-tag">
              {toolCalls} tool call{toolCalls === 1 ? '' : 's'}
            </span>
          ))}
        {confidence !== null && (
          <span className="pg-tag">{confidence} confidence (self-reported)</span>
        )}
      </div>

      <p className="pg-chat__text">{answer.answer}</p>

      {answer.evidence.length > 0 && (
        <ul className="pg-evidence">
          {answer.evidence.map((item, index) => (
            <li key={`${item.label}-${index}`} className="pg-evidence__item">
              <div className="pg-evidence__head">
                <span className="pg-evidence__label">{item.label}</span>
                {/* A bullet with a tool name was READ by a governed tool; one without was asserted
                    by the model. Distinguished by class as well as by text, so the difference is
                    visible without reading -- and never signalled by colour alone (§7.3). */}
                <span
                  className={`pg-evidence__source pg-evidence__source--${
                    item.tool === null ? 'llm' : 'mcp_tool'
                  }`}
                >
                  {item.tool === null ? (
                    'asserted by the model'
                  ) : (
                    <>
                      read from IRIS
                      <span className="pg-facts__mono"> · {toolLabel(item.tool)}</span>
                    </>
                  )}
                </span>
              </div>
              <div className="pg-evidence__detail">{item.detail}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
