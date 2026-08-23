/**
 * Activity insights chat — ask a question about interoperability activity in natural language.
 *
 * The answer comes from an AI Hub agent inside IRIS that reads `Ens_Activity_Data.{Seconds,Hours,
 * Days}` through governed, audited MCP tools. This component renders what it is given and composes
 * nothing.
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
 */
const SUGGESTIONS: readonly string[] = [
  'Which host is handling the most messages right now?',
  'Is anything falling behind? Compare queueing time across hosts.',
  'How has throughput changed over the last few hours?',
  'What activity history is available, and how far back does it go?',
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
          Ask about activity
        </h2>
        {!empty && (
          <button type="button" className="pg-button pg-button--subtle" onClick={onClear}>
            New conversation
          </button>
        )}
      </div>

      <p className="pg-chat__intro">
        Ask about message volume, throughput and latency over time. An AI agent inside IRIS answers
        by reading the interoperability activity tables through governed, audited tools — it sees
        counts, durations and configuration only, never message content or patient data.
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
        <span className="pg-tag pg-tag--ok">Live agent</span>
        {answer.diagnostics.model !== null && (
          <span className="pg-tag">{answer.diagnostics.model}</span>
        )}
        {toolCalls !== null &&
          (toolCalls === 0 ? (
            /* ZERO IS CALLED OUT, not shown as another grey tag. An answer with no tool calls was
               produced from the model's priors rather than from this production, and that is the one
               diagnostic a reader must not skim past. */
            <span className="pg-tag pg-tag--warn">
              0 tool calls — not read from this production
            </span>
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
                      <span className="pg-facts__mono"> · {item.tool}</span>
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
