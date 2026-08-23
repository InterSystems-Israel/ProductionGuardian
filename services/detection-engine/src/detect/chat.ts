/**
 * Activity insights chat — orchestration for the ask-a-question panel.
 *
 * WE ORCHESTRATE, WE DO NOT REASON. The answer comes from an AI Hub agent running inside IRIS, which
 * reads the three `Ens_Activity_Data` tables through governed, audited MCP tools. This module
 * validates a question, forwards it, validates what comes back, and serves it. It composes no
 * narrative, computes no metric, and fills no gap — `services/detection-engine/CLAUDE.md` §1.1 draws
 * that line, and it is the reason no LLM key and no SQL reaches this service.
 *
 * NEVER INVENT AN ANSWER. Same rule as `investigate.ts`, and it matters more here: an operator asked
 * a question, so an empty or garbled reply must come back as an explicit "could not answer" rather
 * than as something plausible. A fabricated number in a chat answer is worse than a fabricated root
 * cause, because there is no finding beside it to contradict it.
 *
 * STATELESS ACROSS TURNS, and the reason is measured in IRIS rather than chosen here.
 * `%AI.Agent.Session` is `%Persistent` but its `%agent` handle is `transient = 1`, so a session
 * reopened in another process reports `IsAttached() = 0` and throws on use — and a `%CSP.REST`
 * dispatcher runs in a pooled, job-ed process, so consecutive requests are usually not the same one.
 * `REST.ChatDispatcher`'s class comment carries the full measurement. The consequence for this
 * module: the CLIENT owns the transcript and sends it, this service passes it through, and no
 * conversation state is held anywhere in the engine. A held map keyed by conversation id would be
 * state that survives a restart in one direction only — the UI would think it had context that IRIS
 * had lost, which is the disagree-about-what-happened shape this project keeps paying for.
 */

/** One prior turn, as the client replays it. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** One bullet naming a value the agent read, and the tool it read it with. */
export interface ChatEvidenceItem {
  label: string;
  detail: string;
  /**
   * The MCP tool the value came from, or null when the agent did not cite one.
   *
   * NOT DEFAULTED TO A TOOL NAME. `investigate.ts` defaults an unlabelled evidence source to `llm`
   * — the least-trusted value — for the same reason: a bullet the model asserted must not be
   * displayed as one a governed tool read. Null here is that value, and the panel labels it.
   */
  tool: string | null;
}

/** Contract-shaped state, mirroring `investigation-api.md` §4.1's three values. */
export type ChatState = 'complete' | 'unavailable';

/**
 * Where the answer came from.
 *
 * `agent` cannot be produced unless the compose variable, the provider config, the wallet entry, the
 * web application and the agent are all correct at once — which is why `iris/CLAUDE.md`'s pre-demo
 * check turns on this field rather than on the answer looking right. There is deliberately no
 * `canned` chat agent: see `chatUnavailable`.
 *
 * `static` IS A THIRD THING AND IT IS NOT A DEGRADED `agent`. A greeting, a thanks, a farewell or a
 * "what can you do" is classified in `ChatDispatcher.SmallTalkKind` and answered from a fixed
 * catalogue — no provider, no metered call, no tool, `toolCalls: 0`. Distinguished from `agent`
 * because otherwise a zero tool count would be ambiguous between "nothing needed reading" and "a
 * model answered from its priors about a production it has never seen", and the second is the one
 * `toolCalls` exists to surface. Distinguished from `none` because a `static` answer IS an answer:
 * `answer` is non-null and `state` is `complete`.
 *
 * NOT A NEW WAY TO INVENT DATA. The catalogue describes the assistant, never the production — see
 * `ChatDispatcher.SmallTalkText`, which is grounded in the three tools `Tools.Activity` publishes and
 * names no host. `iris/CLAUDE.md`'s pre-demo check is unaffected: it asserts `source: agent` for a
 * real question, and a real question can never reach this path.
 */
export type ChatSource = 'agent' | 'static' | 'none';

export interface ChatResponse {
  requestId: string;
  state: ChatState;
  source: ChatSource;
  answeredAt: string;
  /** Echoed from what IRIS received, so a UI cannot pair an answer with a different question. */
  question: string;
  /** Null when no answer could be produced. Never a placeholder sentence. */
  answer: string | null;
  evidence: ChatEvidenceItem[];
  confidence: number | null;
  diagnostics: {
    model: string | null;
    /** Zero tool calls means the model answered from its priors — the panel says so. */
    toolCalls: number | null;
    durationMs: number | null;
    note: string | null;
  };
}

/** What this service sends the dispatcher. */
interface ChatRequest {
  question: string;
  history: ChatTurn[];
}

export interface ChatDeps {
  /** Calls the chat dispatcher in IRIS. Injected so the endpoint is testable without an LLM. */
  callAgent(request: ChatRequest, timeoutMs: number): Promise<unknown>;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Hard timeout, and it is BELOW the 60-second limit IRIS's embedded Apache enforces.
 *
 * That limit is the platform's own and cannot be raised from outside — measured at 60.2s on this
 * image and written up in `iris/labdemo/REST/TriggerDispatcher.cls`. So a timeout above it would
 * never fire: IRIS would answer 504 first and the failure would be reported by the component that
 * did not know what failed. 45s leaves the engine as the component that gives up, while still
 * covering a turn with several tool calls in it (a live investigation measures ~6s).
 */
const TIMEOUT_MS = 45_000;

/** Longest question forwarded. Mirrors `ChatDispatcher.#MAXQUESTION`, which is the authority. */
const MAX_QUESTION = 600;

/** Prior turns forwarded. Mirrors `ChatDispatcher.#MAXHISTORY`. */
const MAX_HISTORY = 6;

function isoSeconds(ms: number): string {
  return `${new Date(Math.round(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * Read a request body into a question and a transcript, or throw `bad request: ...`.
 *
 * VALIDATED AT THE API BOUNDARY, like `parseResolveRequest` and unlike the trigger scenario: the
 * shape is this service's to check, and a malformed body must answer 400 without reaching IRIS or
 * costing a metered call.
 *
 * THE LENGTH CAP IS ENFORCED IN BOTH PLACES ON PURPOSE. IRIS refuses over 600 characters too, and
 * that is the real guard — this one exists so the refusal is a 400 from the boundary the caller is
 * talking to rather than a 400 relayed from two hops away. Neither is decorative: if they ever
 * disagree, IRIS wins and the caller sees its message.
 */
export function parseChatRequest(body: unknown): ChatRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('bad request: body must be an object');
  }
  const b = body as Record<string, unknown>;

  const question = b['question'];
  if (typeof question !== 'string' || question.trim() === '') {
    throw new Error('bad request: question must be a non-empty string');
  }
  if (question.length > MAX_QUESTION) {
    throw new Error(`bad request: question must be ${MAX_QUESTION} characters or fewer`);
  }

  /* An absent history is a first turn, which is normal — not an error. An array containing
     unreadable entries drops those entries rather than rejecting the request: a garbled prior turn
     should cost context, not the answer to the question being asked now. */
  const history: ChatTurn[] = [];
  const rawHistory = b['history'];
  if (Array.isArray(rawHistory)) {
    for (const entry of rawHistory) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const role = e['role'];
      const text = e['text'];
      /* Role is checked against the two literals rather than passed through. IRIS maps it through a
         fixed $case and drops anything else, so an arbitrary role could never become a prompt line
         — but refusing it here means a caller sending `role: "system"` learns that from the
         boundary instead of having it silently ignored. */
      if (role !== 'user' && role !== 'assistant') continue;
      if (typeof text !== 'string' || text.trim() === '') continue;
      history.push({ role, text: text.slice(0, MAX_QUESTION) });
    }
  }

  return { question, history: history.slice(-MAX_HISTORY) };
}

/**
 * A response for every failure, with the reason named. §4.4's discipline, applied to a chat turn.
 *
 * THERE IS NO CANNED CHAT AGENT, and that is a decision rather than an omission. `mockAgent` exists
 * for AI Detective because that panel explains ONE finding whose numbers the engine has already
 * measured — so a canned narrative over live values is honest, labelled, and useful offline.
 * A chat assistant answers an arbitrary question, and there is no way to fake that without either
 * inventing numbers or answering something the operator did not ask. `investigation-api.md` §4.3's
 * rule that a mock must be labelled cannot save a mock that has to guess the question, so the
 * offline state here is an explicit "not configured" and the panel renders it as one.
 */
function chatUnavailable(
  requestId: string,
  question: string,
  at: number,
  note: string,
): ChatResponse {
  return {
    requestId,
    state: 'unavailable',
    source: 'none',
    answeredAt: isoSeconds(at),
    question,
    // NULL, not a placeholder. The whole point of the state.
    answer: null,
    evidence: [],
    confidence: null,
    diagnostics: { model: null, toolCalls: null, durationMs: null, note },
  };
}

/**
 * Validate the agent's reply, or return null to signal failure.
 *
 * FIELD BY FIELD, NEVER A CAST. The reply crossed a process boundary and originated from a language
 * model, so every value is checked for its own type — the same discipline as `parseAgentReply`, and
 * the reason `investigate.ts` carries a comment about it: a cast would compile and then put
 * unvalidated model output on screen.
 */
function parseChatReply(raw: unknown): {
  answer: string;
  evidence: ChatEvidenceItem[];
  confidence: number | null;
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const answer = obj['answer'];
  if (typeof answer !== 'string' || answer.trim() === '') return null;

  const evidence: ChatEvidenceItem[] = [];
  if (Array.isArray(obj['evidence'])) {
    for (const item of obj['evidence']) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const label = typeof e['label'] === 'string' ? e['label'] : null;
      const detail = typeof e['detail'] === 'string' ? e['detail'] : null;
      // Both required. A bullet with no label has no heading and one with no detail has no content;
      // either alone is a partial parse, so neither is kept.
      if (label === null || detail === null) continue;
      evidence.push({
        label,
        detail,
        tool: typeof e['tool'] === 'string' && e['tool'] !== '' ? e['tool'] : null,
      });
    }
  }

  let confidence: number | null = null;
  const rawConfidence = obj['confidence'];
  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    // Clamped, not rejected — a model returning 1.2 meant "very confident", and discarding a good
    // answer over it would be worse than bounding it. Same call as `parseAgentReply`.
    confidence = Math.min(1, Math.max(0, rawConfidence));
  }

  return { answer, evidence, confidence };
}

/**
 * Answer one question.
 *
 * Returns a valid response in every case including failure, so the endpoint serves 200 with a
 * labelled state rather than an error — a blanked panel is worse than one saying it could not answer.
 */
export async function chat(request: ChatRequest, deps: ChatDeps): Promise<ChatResponse> {
  const now = deps.now ?? Date.now;
  const started = now();
  /* Deterministic and correlatable. The tool calls this turn makes write `Audit.Entry` rows in
     IRIS, and this id is what a reviewer uses to tie an answer to the reads behind it — the same
     role `inv-` ids play for an investigation. */
  const requestId = `chat-${started}`;

  let raw: unknown;
  try {
    raw = await deps.callAgent(request, TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.(`chat ${requestId} failed: ${message}`);
    return chatUnavailable(requestId, request.question, now(), `agent call failed: ${message}`);
  }

  const parsed = parseChatReply(raw);
  if (parsed === null) {
    deps.log?.(`chat ${requestId}: agent reply did not validate`);
    return chatUnavailable(
      requestId,
      request.question,
      now(),
      'the agent reply could not be read',
    );
  }

  const finished = now();
  const obj = raw as Record<string, unknown>;
  /* READ FROM WHAT IRIS SAID, and only the one literal is accepted — anything else, including an
     absent field, is `agent`. That direction is deliberate: `agent` is the claim `iris/CLAUDE.md`'s
     pre-demo check treats as load-bearing, and defaulting an unrecognised value to `static` would let
     a garbled reply present a real agent answer as canned text, which is the reverse of the error
     worth guarding. An older IRIS that does not send the field at all still reports `agent`, which is
     what it means. */
  const source: ChatSource = obj['source'] === 'static' ? 'static' : 'agent';
  return {
    requestId,
    state: 'complete',
    source,
    answeredAt: isoSeconds(finished),
    /* IRIS's echo is preferred over our own copy, because it is what the agent actually answered.
       Falling back to the request only when the echo is missing — a UI pairing an answer with a
       question the agent never saw is the failure this field exists to prevent. */
    question: typeof obj['question'] === 'string' ? obj['question'] : request.question,
    answer: parsed.answer,
    evidence: parsed.evidence,
    confidence: parsed.confidence,
    diagnostics: {
      model: typeof obj['model'] === 'string' ? obj['model'] : null,
      toolCalls: typeof obj['toolCalls'] === 'number' ? obj['toolCalls'] : null,
      durationMs: finished - started,
      note: null,
    },
  };
}

/**
 * Live chat caller, over HTTP to the dispatcher in IRIS.
 *
 * `/labdemo/chat/ask` — the web application is `/labdemo/chat` and the ROUTE is `/ask`. Written out
 * because `agents.ts` records getting the equivalent wrong once: `/labdemo/investigate` is the
 * dispatcher's route without its application prefix, and it would have 404'd against a different
 * dispatcher rather than failing to resolve, so the error would have named the wrong component.
 */
export function liveChatAgent(
  baseUrl: string,
  user: string,
  pass: string,
  log?: (m: string) => void,
): ChatDeps['callAgent'] {
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  return async (request, timeoutMs) => {
    // AbortSignal rather than Promise.race: a race leaves the fetch running and its socket open, so
    // a slow agent would accumulate connections.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/labdemo/chat/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        /* The dispatcher's own error message is surfaced rather than replaced by the status code.
           A 503 means "this deployment has no LLM provider" and a 400 names the field that was
           wrong; both are more useful than "HTTP 503", and the panel renders the message. */
        let detail = '';
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === 'string') detail = parsed.error;
        } catch {
          detail = '';
        }
        throw new Error(
          detail !== '' ? detail : `chat agent returned HTTP ${res.status}`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        /* A NON-JSON 200 IS ITS OWN FAILURE MODE HERE, not a theoretical one. nginx proxying only
           `/api/healthscan/` served the SPA's index.html with a 200 for every other endpoint, and
           `TriggerDispatcher`'s `write` output landed ahead of its JSON body — both produced a valid
           200 carrying something that is not JSON. Naming the layer rather than letting
           `JSON.parse` throw `Unexpected token '<'` is what stops that reading as "the AI is
           broken". */
        throw new Error(`chat agent returned non-JSON (HTTP ${res.status})`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log?.(`chat agent timed out after ${timeoutMs}ms`);
        throw new Error(`chat agent timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
