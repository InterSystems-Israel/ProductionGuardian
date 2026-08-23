/**
 * Demo scenario triggers in the nav rail.
 *
 * ONLY RENDERS WHEN THE DEPLOYMENT SAYS SO. `GET /api/demo/triggers` reports `enabled` and the
 * scenario list; when it is off this component returns `null` and the rail looks exactly as it did
 * before. That is why the endpoint answers 200-with-`enabled: false` rather than 404 — the UI needs
 * a truthful "no" it can distinguish from a network failure.
 *
 * THE SCENARIO LIST COMES FROM THE SERVER, not from a constant here. IRIS owns the `$case` that
 * decides which names are real, so a list in this file would be a second copy that goes stale into
 * buttons that 400 — the same failure as every host list this project has duplicated (root
 * `CLAUDE.md` §6). The consequence is that this component renders whatever it is given, including a
 * scenario added later with no dashboard change.
 *
 * ARMED STATE IS ALSO THE SERVER'S. It is read from the trigger globals in IRIS on every poll, not
 * tracked locally from button presses, because driving the terminal during a rehearsal is normal and
 * a button showing state from its own last click would be confidently wrong.
 *
 * DELIBERATELY STYLED AS SOMETHING THAT BREAKS THINGS. These sit under their own heading, in a
 * warning tone, separate from the two navigation buttons above. The rail already distinguishes inert
 * context from real controls; this adds a third category — real controls that make the production
 * worse on purpose — and conflating it with "Brochure" would be the wrong affordance entirely.
 */

import { useCallback, useEffect, useState } from 'react';
import { IconAlert } from './icons';

/** One scenario, exactly as the server describes it. */
export interface TriggerScenario {
  id: string;
  label: string;
  detail: string;
  findings: string;
}

export interface TriggerState {
  enabled: boolean;
  scenarios: TriggerScenario[];
  armed: Record<string, boolean>;
}

/** Field-by-field. The endpoint is ours, but a shape check here is what keeps a bad payload from
    rendering a broken rail rather than no rail. */
function parseState(raw: unknown): TriggerState {
  const off: TriggerState = { enabled: false, scenarios: [], armed: {} };
  if (typeof raw !== 'object' || raw === null) return off;
  const r = raw as Record<string, unknown>;
  if (r['enabled'] !== true) return off;

  const scenarios: TriggerScenario[] = [];
  if (Array.isArray(r['scenarios'])) {
    for (const entry of r['scenarios']) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e['id'] !== 'string' || e['id'] === '') continue;
      if (typeof e['label'] !== 'string' || e['label'] === '') continue;
      scenarios.push({
        id: e['id'],
        label: e['label'],
        detail: typeof e['detail'] === 'string' ? e['detail'] : '',
        findings: typeof e['findings'] === 'string' ? e['findings'] : '',
      });
    }
  }

  const armed: Record<string, boolean> = {};
  if (typeof r['armed'] === 'object' && r['armed'] !== null) {
    for (const [k, v] of Object.entries(r['armed'] as Record<string, unknown>)) {
      if (typeof v === 'boolean') armed[k] = v;
    }
  }
  return { enabled: true, scenarios, armed };
}

const BASE = '/api/demo';

/**
 * Poll cadence for the armed state.
 *
 * Slower than the findings poll on purpose: arming is a human action taken seconds apart, not a
 * metric stream, and this endpoint reaches into IRIS on every call. 5s is responsive enough that a
 * terminal-driven arm shows up before the presenter has finished explaining it.
 */
const STATUS_POLL_MS = 5000;

export function TriggerRail(): JSX.Element | null {
  const [state, setState] = useState<TriggerState | null>(null);
  /** The scenario currently being armed, so its own button can show pending without freezing others
      that are still legitimately clickable. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/triggers`);
      // Same text-then-parse as the writes below. Here the catch already swallows it, so this is
      // about the FAILURE MODE rather than the message: a thrown SyntaxError and a truthful
      // "triggers are off" both hide the rail, and the second is what an HTML error page means.
      const raw = await res.text();
      setState(parseState(JSON.parse(raw)));
    } catch {
      // Silent. A failed status poll must not render an error over the whole rail: the endpoint is
      // optional by construction, and the connection banner already owns "the engine is unreachable".
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const post = useCallback(
    async (path: string, body: unknown, pending: string) => {
      setBusy(pending);
      setError(null);
      setNote(null);
      try {
        const res = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        /*
         * READ AS TEXT, THEN PARSE, so a non-JSON response becomes a sentence rather than a
         * `SyntaxError` shown to the operator. `res.json()` threw
         *
         *     Unexpected token '<', "<html> <h"... is not valid JSON
         *
         * when nginx timed out and returned its own HTML error page (@Ari-Glikman). The nginx read
         * timeout is fixed separately -- but a proxy, a load balancer or an auth gateway returning
         * HTML is a permanent possibility, not a bug to be fixed once, and a parse error names the
         * wrong layer entirely: it reads as "the dashboard is broken" when the request never
         * reached the engine.
         *
         * The status code carries the meaning here, so it is reported instead of the body.
         */
        const raw = await res.text();
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // 504/502 specifically, because for a long arm that is the likely one and "still running"
          // is materially different advice from "it failed".
          setError(
            res.status === 504 || res.status === 502
              ? `The request timed out at the proxy after ${res.status}. Arming may still be ` +
                `running in IRIS — check the armed state before retrying.`
              : `The server returned a non-JSON response (HTTP ${res.status}).`,
          );
          return;
        }
        if (typeof payload['error'] === 'string' && payload['error'] !== '') {
          setError(payload['error']);
        } else if (typeof payload['note'] === 'string' && payload['note'] !== '') {
          // A reset reports what it CANNOT undo. Surfaced rather than dropped: "the alert is still
          // there" is the question a presenter asks ten seconds later.
          setNote(payload['note']);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'request failed');
      } finally {
        setBusy(null);
        // Refresh regardless of outcome. A trigger that errored partway may still have armed
        // something, so the armed state must be re-read rather than assumed unchanged.
        void refresh();
      }
    },
    [refresh],
  );

  if (state === null || !state.enabled) return null;

  return (
    <div className="pg-triggers">
      <span className="pg-rail__brand pg-rail__brand--triggers">
        <IconAlert size={14} />
        Demo triggers
      </span>
      <p className="pg-triggers__caption">These break the production on purpose.</p>

      <ul className="pg-rail__list">
        {state.scenarios.map((s) => {
          const isArmed = state.armed[s.id] === true;
          const pending = busy === s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`pg-rail__item pg-rail__item--trigger${
                  isArmed ? ' pg-rail__item--armed' : ''
                }`}
                /* Every button disabled while ANY is pending. Arming two scenarios concurrently
                   would interleave two sets of setting writes on the same production, and the
                   trigger class stashes previous values in one global per setting — a concurrent
                   pair could stash the other's value and make Reset() restore the wrong thing. */
                disabled={busy !== null}
                onClick={() => void post('/trigger', { scenario: s.id }, s.id)}
                title={`${s.detail}\n\nFires: ${s.findings}`}
              >
                <span className="pg-rail__trigger-label">
                  {s.label}
                  {isArmed && <span className="pg-rail__armed-dot" aria-hidden="true" />}
                </span>
                {/* The pending state is words, not a spinner: PoolBottleneck warms a baseline for
                    75 seconds and a spinner that long reads as a hang. */}
                {pending && <span className="pg-rail__trigger-state">arming… up to 90s</span>}
                {isArmed && !pending && <span className="pg-rail__trigger-state">armed</span>}
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            className="pg-rail__item pg-rail__item--trigger pg-rail__item--reset"
            disabled={busy !== null}
            onClick={() => void post('/reset', {}, '__reset__')}
            title="Restore every setting the triggers changed"
          >
            <span className="pg-rail__trigger-label">Reset all</span>
            {busy === '__reset__' && <span className="pg-rail__trigger-state">resetting…</span>}
          </button>
        </li>
      </ul>

      {error !== null && (
        <p className="pg-triggers__error" role="alert">
          {error}
        </p>
      )}
      {note !== null && (
        <p className="pg-triggers__note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
