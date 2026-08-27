/**
 * Proxy to the demo scenario triggers in IRIS, for the dashboard's trigger buttons.
 *
 * THE ENGINE HOLDS NO TRIGGER LOGIC. It forwards to `TriggerDispatcher` and returns what came back.
 * That is the same division as `/api/resolve` (CLAUDE.md §1.1): this service gained orchestration
 * responsibilities, not authority, and it cannot mutate a production even if a bug here tried to.
 * Every guard — the demo flag, the fixed scenario list, the absence of parameters — lives in IRIS.
 *
 * OFF BY DEFAULT, checked HERE as well as in IRIS. `DEMO_TRIGGERS` gates this module and
 * `PG_DEMO_TRIGGERS` gates the dispatcher; compose passes one variable to both. The duplication is
 * deliberate: without it, a disabled instance would be discovered only by forwarding a request and
 * receiving a 404, which is indistinguishable from IRIS being unreachable or the web application
 * being unregistered — and that last one has cost this project two defects already (#106 and the
 * nginx 405s). Declining locally makes "triggers are off" a different observable state from
 * "something is broken".
 *
 * NOT AUDITED, and that is a deliberate asymmetry worth stating rather than leaving to be noticed.
 * `set_pool_size` writes an `Audit.Entry` row per call because the question "did the AI change a
 * production setting" must be answerable. A demo trigger is a human deliberately breaking a
 * throwaway instance, so there is no attribution question to answer — and routing it through the
 * governed path would make the two look like the same class of act. `Triggers.Status()` reports what
 * is armed, which is the state that actually matters here.
 */

/** One scenario the dispatcher will accept, as it describes itself. */
export interface TriggerScenario {
  id: string;
  label: string;
  detail: string;
  findings: string;
}

export interface TriggerStatus {
  enabled: boolean;
  scenarios: TriggerScenario[];
  /**
   * Per-scenario **in effect** state, read from the trigger globals in IRIS.
   *
   * Means "the scenario is live", not "a request was accepted" — the dispatcher keys it on a global
   * the scenario sets when it actually takes effect. For `pool_bottleneck` those are ~75s apart.
   */
  armed: Record<string, boolean>;
  /**
   * Per-scenario **accepted but not yet in effect** state.
   *
   * A THIRD STATE, not a flag on the second. `pool_bottleneck` warms a baseline at zero for 75s
   * before it arms anything and runs as a background job, so the arm POST returns in ~0.26s and the
   * scenario is in neither of the other two states for over a minute. Carried through this service
   * rather than re-derived in the dashboard: IRIS owns the witnesses, and a browser inferring
   * "probably still arming" from a timer it started would be wrong the moment someone drives the
   * terminal — the same reason `armed` is not tracked from button presses.
   *
   * Absent for a scenario that arms atomically. An older dispatcher omits the map entirely, which
   * parses to `{}` — every scenario then reads not-activating, i.e. the previous two-state
   * behaviour, rather than an empty rail.
   */
  activating: Record<string, boolean>;
}

export interface TriggerResult {
  ok: boolean;
  /** The scenario armed, or null for a reset. */
  armed: string | null;
  /**
   * The trigger's own captured narration — what it armed, which findings to expect, and which
   * deliberately will NOT fire. Empty for a jobbed arm, which has produced no output yet.
   *
   * FORWARDED RATHER THAN DROPPED, which it was until #133. The dispatcher goes to real trouble to
   * capture this — a temp file becomes the current device for the call, because the trigger methods
   * write to `$io` and would otherwise corrupt the JSON body (see `TriggerDispatcher.Arm`) — and
   * this service then parsed the reply field-by-field and left `log` out, so the text crossed one
   * process boundary and died at the next. It is the clearest explanation of each scenario anyone
   * has written, and the UI now renders it under the button that produced it.
   *
   * Multi-line plain text, never markup. The dashboard renders it as text.
   */
  log: string;
  /** Present when the dispatcher qualified the outcome — e.g. what a reset cannot undo. */
  note: string | null;
  error: string | null;
}

export interface TriggerDeps {
  status: () => Promise<TriggerStatus>;
  arm: (scenario: string) => Promise<TriggerResult>;
  reset: () => Promise<TriggerResult>;
}

/**
 * What the API serves when triggers are off.
 *
 * `enabled: false` with an EMPTY scenario list, not a populated one. A UI given the list would be
 * able to render disabled buttons, which advertises a capability the deployment declined — the same
 * reasoning as the dispatcher answering 404 rather than 403.
 */
export const TRIGGERS_DISABLED: TriggerStatus = {
  enabled: false,
  scenarios: [],
  armed: {},
  activating: {},
};

/** Field-by-field, never a cast — the dispatcher's reply crosses a process boundary. */
function parseScenario(raw: unknown): TriggerScenario | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  const label = r['label'];
  if (typeof id !== 'string' || id === '') return null;
  if (typeof label !== 'string' || label === '') return null;
  return {
    id,
    label,
    detail: typeof r['detail'] === 'string' ? r['detail'] : '',
    findings: typeof r['findings'] === 'string' ? r['findings'] : '',
  };
}

/**
 * Exported for the tests, the same as `parseResolveRequest` and `parseChatRequest`.
 *
 * Worth testing directly rather than through `liveTriggers`: this is the only place the three-state
 * model crosses a process boundary, and the case most likely to break it — a dispatcher that predates
 * the `activating` field — cannot be produced by the live stack once IRIS is updated.
 */
export function parseStatus(raw: unknown): TriggerStatus {
  if (typeof raw !== 'object' || raw === null) return TRIGGERS_DISABLED;
  const r = raw as Record<string, unknown>;
  // `enabled` must be explicitly true. An absent or non-boolean field reads as off, so a garbled
  // reply cannot switch the buttons on.
  if (r['enabled'] !== true) return TRIGGERS_DISABLED;

  const scenarios: TriggerScenario[] = [];
  if (Array.isArray(r['scenarios'])) {
    for (const entry of r['scenarios']) {
      const parsed = parseScenario(entry);
      // Skip a malformed entry rather than rejecting the whole payload: one bad scenario should
      // not remove the reset button, which is the one that recovers from everything else.
      if (parsed !== null) scenarios.push(parsed);
    }
  }

  return {
    enabled: true,
    scenarios,
    armed: parseBooleanMap(r['armed']),
    // Same parser, and that is the point: the two maps have identical shape and identical failure
    // behaviour, so a garbled `activating` cannot make a button read differently from a garbled
    // `armed`. An older dispatcher sends no `activating` at all -> `{}` -> nothing activating.
    activating: parseBooleanMap(r['activating']),
  };
}

/**
 * One `Record<string, boolean>` from the wire, field-by-field.
 *
 * ONLY A REAL BOOLEAN. An unparseable value must not read as `true`, because both maps drive what a
 * button says about a live production: `armed: true` claims the scenario is running, and
 * `activating: true` is what makes a second click refuse. Dropping the key is the safe direction —
 * it reads as "not in that state", which is the answer a witness we could not read deserves.
 */
function parseBooleanMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function parseResult(raw: unknown, scenario: string | null): TriggerResult {
  const base: TriggerResult = { ok: false, armed: null, log: '', note: null, error: null };
  if (typeof raw !== 'object' || raw === null) {
    return { ...base, error: 'trigger dispatcher returned a non-object' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['error'] === 'string' && r['error'] !== '') {
    return { ...base, error: r['error'] };
  }
  return {
    ok: r['ok'] === true,
    // From the REQUEST, not the reply. The dispatcher echoes it, but the caller's own value is the
    // one the UI needs to correlate a response with the button that was pressed — the same reason
    // `requestedBy` is threaded through resolve.ts rather than read back.
    armed: scenario,
    // The trigger's own narration, forwarded verbatim. Empty string rather than null when absent:
    // "the trigger printed nothing" and "there was no field" are the same fact to a caller, and one
    // type means the UI needs no null check before trimming it.
    log: typeof r['log'] === 'string' ? r['log'] : '',
    note: typeof r['note'] === 'string' && r['note'] !== '' ? r['note'] : null,
    error: null,
  };
}

/**
 * Live trigger caller, over HTTP to the dispatcher in IRIS.
 *
 * ARM'S TIMEOUT IS LARGE ON PURPOSE. `PoolBottleneck()` warms a baseline at zero for 75 seconds
 * before it returns, so a conventional 30s timeout would abort a call that was working and leave
 * the production half-armed with nothing reporting why. Measured: the trigger blocks for ~80s.
 *
 * RESET'S IS LARGE FOR A DIFFERENT REASON — it is the only one whose duration depends on how long
 * the stack has been up. `Triggers.Reset()` purges the message store when an error scenario left
 * errored headers behind, because the per-host error count is a `COUNT(*)` over those rows and
 * nothing else clears it. Measured: 31.5s to delete 153,144 headers, i.e. ~4,900/s, and the store
 * grows for as long as the generator runs. At 60s a long rehearsal day would abort a purge that was
 * working, and the retry a presenter then makes starts it again from the beginning.
 *
 * 120s, staying under nginx's 180s `proxy_read_timeout` on `/api/demo/` so the engine is still the
 * component that reports a genuine hang rather than nginx serving its own HTML error page — the
 * failure shape that produced `Unexpected token '<'` when arming outran the shared 35s limit.
 */
export function liveTriggers(
  baseUrl: string,
  user: string,
  pass: string,
  log?: (m: string) => void,
): TriggerDeps {
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  async function call(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/labdemo/trigger${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      // A 404 here means the dispatcher's own flag is off while ours is on — a MISCONFIGURED PAIR,
      // which is worth naming rather than reporting as a generic failure. It is the one state the
      // local check cannot rule out.
      if (res.status === 404) {
        throw new Error(
          'IRIS reports the trigger routes do not exist. DEMO_TRIGGERS is set on the engine but ' +
            'PG_DEMO_TRIGGERS is not set on the iris service, or /labdemo/trigger is unregistered.',
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`trigger dispatcher returned non-JSON (HTTP ${res.status})`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log?.(`trigger call ${path} timed out after ${timeoutMs}ms`);
        throw new Error(`trigger call timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status: async () => parseStatus(await call('/status', undefined, 10_000)),
    arm: async (scenario) => parseResult(await call('/arm', { scenario }, 150_000), scenario),
    reset: async () => parseResult(await call('/reset', {}, 120_000), null),
  };
}

/**
 * Disabled triggers, for every deployment that has not opted in.
 *
 * A SEPARATE IMPLEMENTATION rather than a flag inside `liveTriggers`, so "the engine declined
 * locally" and "IRIS declined" cannot be confused, and so there is no code path in which a disabled
 * engine makes an outbound request. The same reasoning as `mockMissingFolderAgent` being its own
 * function: a shape that must never occur is best made unreachable.
 */
export function disabledTriggers(): TriggerDeps {
  const declined: TriggerResult = {
    ok: false,
    armed: null,
    log: '',
    note: null,
    error: 'demo triggers are not enabled on this deployment',
  };
  return {
    status: async () => TRIGGERS_DISABLED,
    arm: async () => declined,
    reset: async () => declined,
  };
}
