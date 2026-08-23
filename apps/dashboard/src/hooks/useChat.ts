/**
 * The activity chat conversation, held here because it cannot be held in IRIS.
 *
 * WHY THE CLIENT OWNS THE TRANSCRIPT. `%AI.Agent.Session` persists as a row but its agent handle is
 * declared `transient`, so a session reopened in another process reports `IsAttached() = 0` and throws
 * on use — and a `%CSP.REST` dispatcher runs in a pooled, job-ed process, so consecutive requests are
 * usually not the same one. Measured; `iris/labdemo/REST/ChatDispatcher.cls` carries the numbers. So
 * server-side continuity is not available at any layer, and this hook is where the conversation lives.
 *
 * The honest consequence, and it is not hidden from the operator: a reload starts a new conversation.
 * That is stated in the panel rather than papered over with `localStorage`, because a transcript
 * restored into a UI whose agent never saw it would be a conversation only one side remembers.
 *
 * ONE REQUEST AT A TIME. A second question while the first is in flight aborts nothing and is simply
 * refused by the panel's disabled input — rather than aborting, because a chat turn costs a metered
 * call that has already been made and its answer is still worth having. Contrast `usePolling`, which
 * aborts every tick: a poll's result is worthless once superseded and an answer is not.
 */

import { useCallback, useRef, useState } from 'react';
import type { HealthScanApi } from '../api/HealthScanApi';
import type { ChatAnswerView, ChatTurnView } from '../types/mvp2';

/** One exchange on screen: what was asked, and what came back. */
export interface ChatExchange {
  /** Stable for the life of the exchange, so React keys survive the answer landing. */
  id: string;
  question: string;
  /** Null while in flight. */
  answer: ChatAnswerView | null;
  /** Transport failure only — an unanswerable question comes back as an `unavailable` answer. */
  error: string | null;
}

/**
 * Turns of context sent with each question.
 *
 * SIX, matching `ChatDispatcher.#MAXHISTORY` and `chat.ts`'s `MAX_HISTORY`. IRIS is the authority and
 * truncates anyway; sending more would be bytes over the wire for a prompt that discards them.
 */
const HISTORY_TURNS = 6;

export interface UseChat {
  exchanges: ChatExchange[];
  asking: boolean;
  ask: (question: string) => void;
  clear: () => void;
}

export function useChat(api: HealthScanApi): UseChat {
  const [exchanges, setExchanges] = useState<ChatExchange[]>([]);
  const [asking, setAsking] = useState(false);
  /* Aborts the in-flight question on clear, so a discarded conversation does not later append an
     answer to a transcript the operator has emptied. */
  const inFlight = useRef<AbortController | null>(null);

  const ask = useCallback(
    (question: string): void => {
      const trimmed = question.trim();
      if (trimmed === '' || asking) return;

      const id = `ex-${Date.now()}`;
      /* The history is built from the exchanges ALREADY ANSWERED, not including this one, and only
         from complete pairs. A question whose answer failed contributes nothing: replaying it would
         tell the agent it had said something it never said. */
      const history: ChatTurnView[] = [];
      for (const ex of exchanges) {
        if (ex.answer === null || ex.answer.answer === null) continue;
        history.push({ role: 'user', text: ex.question });
        history.push({ role: 'assistant', text: ex.answer.answer });
      }

      setExchanges((prev) => [...prev, { id, question: trimmed, answer: null, error: null }]);
      setAsking(true);

      const controller = new AbortController();
      inFlight.current = controller;

      void api
        .ask(trimmed, history.slice(-HISTORY_TURNS), controller.signal)
        .then((answer) => {
          setExchanges((prev) =>
            prev.map((ex) => (ex.id === id ? { ...ex, answer } : ex)),
          );
        })
        .catch((err: unknown) => {
          // An abort is a deliberate discard, not a failure to report.
          if (err instanceof DOMException && err.name === 'AbortError') return;
          const message = err instanceof Error ? err.message : 'The question could not be sent';
          setExchanges((prev) =>
            prev.map((ex) => (ex.id === id ? { ...ex, error: message } : ex)),
          );
        })
        .finally(() => {
          if (inFlight.current === controller) inFlight.current = null;
          setAsking(false);
        });
    },
    [api, asking, exchanges],
  );

  const clear = useCallback((): void => {
    inFlight.current?.abort();
    inFlight.current = null;
    setExchanges([]);
    setAsking(false);
  }, []);

  return { exchanges, asking, ask, clear };
}
