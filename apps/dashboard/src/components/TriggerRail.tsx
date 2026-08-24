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
 * TRIGGER STATE IS ALSO THE SERVER'S. It is read from the trigger globals in IRIS on every poll, not
 * tracked locally from button presses, because driving the terminal during a rehearsal is normal and
 * a button showing state from its own last click would be confidently wrong.
 *
 * THERE ARE THREE STATES, NOT TWO, and the middle one is real rather than cosmetic (#135).
 *
 *     not activated     nothing armed
 *     activating        the request was accepted; the scenario is not in effect yet
 *     activated         the scenario is live
 *
 * `pool_bottleneck` is why. It warms a baseline at zero for ~75 seconds *before* arming anything —
 * that wait is load-bearing, see `Triggers.PoolBottleneck` and #43 — and it runs as a background
 * job, so the arm POST returns in ~0.26s. For over a minute the scenario is in neither of the other
 * two states. Collapsing that into "not activated" invites a second click; collapsing it into
 * "activated" is a claim a presenter notices is false when no queue appears. The dispatcher reports
 * both maps and this component renders three phases from them. `missing_folder` and `closed_port`
 * arm atomically and pass through the middle phase in under a second, with no branch for that case.
 *
 * A CLICK ON AN ALREADY-ACTIVATED TRIGGER IS ANSWERED LOCALLY, WITHOUT A REQUEST. See `onArm`.
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
  /** In effect — the scenario is live. Not "a request was accepted"; see the file comment. */
  armed: Record<string, boolean>;
  /** Accepted, not in effect yet. Always false for a scenario that arms atomically. */
  activating: Record<string, boolean>;
}

/** Field-by-field. The endpoint is ours, but a shape check here is what keeps a bad payload from
    rendering a broken rail rather than no rail. */
function parseState(raw: unknown): TriggerState {
  const off: TriggerState = { enabled: false, scenarios: [], armed: {}, activating: {} };
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

  return {
    enabled: true,
    scenarios,
    armed: parseFlags(r['armed']),
    // One parser for both maps, so a garbled `activating` cannot make a button behave differently
    // from a garbled `armed`. An engine or dispatcher predating #135 sends no `activating` field at
    // all, which parses to `{}` — every scenario then reads not-activating, i.e. the old two-state
    // behaviour, rather than a crash or an empty rail.
    activating: parseFlags(r['activating']),
  };
}

/** One boolean map from the wire. Only a real boolean: an unparseable value must not read as `true`,
    because both maps make claims about a live production and one of them refuses a click. */
function parseFlags(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const BASE = '/api/demo';

/** The `busy` and message key for Reset, which has no scenario id of its own. */
const RESET_KEY = '__reset__';

/**
 * Poll cadence for the trigger state.
 *
 * Slower than the findings poll on purpose: arming is a human action taken seconds apart, not a
 * metric stream, and this endpoint reaches into IRIS on every call. 5s is responsive enough that a
 * terminal-driven arm shows up before the presenter has finished explaining it.
 */
const STATUS_POLL_MS = 5000;

/** Which of the three states a scenario is in, as this component renders it. */
type Phase = 'idle' | 'activating' | 'activated';

/**
 * One message belonging to one trigger.
 *
 * `refused` is the local answer to a click that made no request — a different fact from `error`,
 * which is something the server said, and rendered differently for that reason.
 *
 * THERE IS NO `log` KIND ANY MORE. The dispatcher still captures and returns the trigger's own
 * multi-line narration and the engine still carries it — see the `log` comment in `post` — it is
 * simply not rendered. A kind nothing can construct would be the dead branch that invites someone
 * to reach for it again.
 */
interface TriggerMessage {
  kind: 'note' | 'error' | 'refused';
  text: string;
}

export function TriggerRail(): JSX.Element | null {
  const [state, setState] = useState<TriggerState | null>(null);
  /** The trigger whose request is in flight, or null. One at a time — see `onArm`. */
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Messages keyed by the trigger they belong to.
   *
   * PER TRIGGER, NOT ONE SHARED SLOT. A single `error`/`note` pair at the bottom of the panel meant
   * the output of arming `missing_folder` appeared under `closed_port`'s button as far as an operator
   * reading top-to-bottom could tell — and the text names a host and a setting, so the
   * mis-attribution is plausible enough to be believed (@Ari-Glikman, from driving the live UI).
   */
  const [messages, setMessages] = useState<Record<string, TriggerMessage>>({});

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

  /** Replace one trigger's message, leaving every other trigger's alone. */
  const say = useCallback((key: string, message: TriggerMessage) => {
    setMessages((prev) => ({ ...prev, [key]: message }));
  }, []);

  const post = useCallback(
    async (path: string, body: unknown, key: string) => {
      setBusy(key);
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
          say(key, {
            kind: 'error',
            text:
              res.status === 504 || res.status === 502
                ? `The request timed out at the proxy after ${res.status}. Arming may still be ` +
                  `running in IRIS — check the state above before retrying.`
                : `The server returned a non-JSON response (HTTP ${res.status}).`,
          });
          return;
        }
        if (typeof payload['error'] === 'string' && payload['error'] !== '') {
          say(key, { kind: 'error', text: payload['error'] });
          return;
        }

        /*
         * ── `log` IS NOT RENDERED. THIS IS A DISPLAY DECISION, MADE HERE. ──
         *
         * The field is still returned by `TriggerDispatcher.Arm` and still parsed by the engine's
         * `triggers.ts`, and both keep their tests and their reasons. It remains genuinely useful to
         * a `curl` caller: it is each trigger's own account of what it armed, which findings to
         * expect and which deliberately will NOT fire, and it is the best written explanation of
         * these scenarios anywhere. Nothing about capturing it was wrong — @Ari-Glikman asked for it
         * on screen, saw it there, and asked for it to go: "the demo triggers output too much info
         * when I click on them. I don't need that message. trigger activating/activated is enough."
         *
         * ELEVEN LINES OF MONOSPACED NARRATION IN A NAV RAIL was the measured reality, not a
         * paraphrase: `missing_folder` rendered 11 lines / 726 characters and `closed_port` 4 lines,
         * under a button whose own state word is two. So it is cut at the point where it becomes
         * pixels rather than at the point where it is produced — deleting the capture would remove
         * the text from the API too, and one presenter not wanting it on a projector is not a reason
         * to stop a terminal from being able to read it.
         *
         * ── `note` SURVIVES, AND IT IS THE ONE JUDGEMENT CALL HERE ──
         *
         * Both notes this system produces are ONE LINE and each answers a question the state word
         * immediately provokes, rather than restating it:
         *
         *   pool_bottleneck   "Warming the baseline at zero for ~75s before arming, so
         *                      queue_buildup can fire..."
         *   reset             "Findings clear within ~10s. A system_alert finding persists until it
         *                      ages out of the proxy's buffer."
         *
         * The first is close to load-bearing. `pool_bottleneck` reads "trigger activating…" for
         * about 75 seconds — the longest wait in the demo, and the whole reason the middle state
         * exists (#135) — and a word that sits unchanged that long reads as a hang to everyone
         * except the person who wrote it. The note is what makes the wait legible. Cutting it would
         * re-create the defect the three-state rail was built to fix, one layer up.
         *
         * The second answers the question a presenter asks ten seconds after pressing Reset: the
         * finding is still on screen, and the note is the difference between "the reset failed" and
         * "that one finding lives in the proxy, not in IRIS". Cheaper on screen than being asked.
         *
         * So the line kept is the one that explains a state the operator can see and cannot
         * otherwise account for; the text cut is the one that explains a scenario they chose
         * deliberately and already know. Both notes are prose, so the `log` kind and its monospaced
         * styling have no remaining caller.
         */
        const note = typeof payload['note'] === 'string' ? payload['note'].trim() : '';
        if (note !== '') {
          say(key, { kind: 'note', text: note });
        }
      } catch (err) {
        say(key, { kind: 'error', text: err instanceof Error ? err.message : 'request failed' });
      } finally {
        setBusy(null);
        // Refresh regardless of outcome. A trigger that errored partway may still have armed
        // something, so the state must be re-read rather than assumed unchanged.
        void refresh();
      }
    },
    [refresh, say],
  );

  if (state === null || !state.enabled) return null;

  /**
   * The three states, resolved per scenario.
   *
   * `armed` WINS over everything, including a local in-flight request, because it is the one fact
   * read from the production itself. The local `busy` folds into `activating` rather than becoming a
   * fourth state: "this browser's request is in flight" is precisely "accepted, not in effect yet",
   * and it covers the gap between the POST returning and the next status poll — which for a
   * fast-arming scenario is the only window the middle phase is ever visible in.
   */
  const phaseOf = (id: string): Phase => {
    if (state.armed[id] === true) return 'activated';
    if (state.activating[id] === true) return 'activating';
    if (busy === id) return 'activating';
    return 'idle';
  };

  /**
   * A trigger click, answered locally where it can be.
   *
   * NO REQUEST IS MADE FOR A TRIGGER THAT IS ALREADY ACTIVATED OR STILL ACTIVATING. Deliberately not
   * "POST and let IRIS refuse": arming is idempotent in the trigger class but not free — the
   * dispatcher's `$case` runs the method again, `PoolBottleneck` re-enters its 75-second warm-up and
   * rewrites `RateSecs`/`MaxQueued`, and a second `Arm` on a jobbed scenario starts a second
   * background job against the same production definition. The information needed to refuse is
   * already in state this component polls, so spending a round trip to be told what it knows would
   * also mean the answer arrives late and after a side effect.
   *
   * TWO REFUSALS, TWO DIFFERENT SENTENCES, because they are different facts. "This one is already
   * activated" is about this trigger and is cleared only by Reset. "Another trigger is still
   * activating" is about the panel and clears itself — conflating them would tell an operator to wait
   * for something that will never finish, or to reset something that needs a moment.
   */
  const onArm = (s: TriggerScenario) => {
    if (phaseOf(s.id) !== 'idle') {
      // The owner's wording covers both halves — "while the trigger is activating" AND "until it is
      // reset" — so one sentence serves both, and Reset is named as the way out of it.
      say(s.id, {
        kind: 'refused',
        text: 'Trigger already activated. Press Reset all to clear it before activating it again.',
      });
      return;
    }
    if (busy !== null) {
      /*
       * ONE ARM AT A TIME, and the protection is real rather than tidiness. The trigger class stashes
       * each replaced value in one global per setting and every arming method calls
       * `UpdateProduction()`; two interleaved arms can therefore stash a value the other already
       * wrote and make `Reset()` restore the wrong one. That is why the original panel disabled every
       * button while any was pending.
       *
       * REFUSED RATHER THAN DISABLED, though, so the reason is legible. A `disabled` button fires no
       * click, so it can say nothing about why it did nothing — which is how "busy" and "already
       * activated" ended up looking like one state. The mutual exclusion is unchanged: no second
       * request is issued either way.
       */
      say(s.id, {
        kind: 'refused',
        text: 'Another trigger is still activating. Wait for it to finish, then try again.',
      });
      return;
    }
    void post('/trigger', { scenario: s.id }, s.id);
  };

  /**
   * Reset, which must stay reachable at all times — it is the operation that recovers from every
   * other one, so it is never disabled and never refused for the state of anything else. It will not
   * stack on itself: two concurrent `Reset()` calls both write the production definition, which is
   * the same hazard `onArm` guards against.
   */
  const onReset = () => {
    if (busy === RESET_KEY) {
      say(RESET_KEY, { kind: 'refused', text: 'Reset is already running.' });
      return;
    }
    // Every scenario's message describes a state this reset is about to clear, so they go with it.
    // Leaving them would put "Trigger already activated" under a button that no longer is.
    setMessages({});
    void post('/reset', {}, RESET_KEY);
  };

  return (
    <div className="pg-triggers">
      <span className="pg-rail__brand pg-rail__brand--triggers">
        <IconAlert size={14} />
        Demo triggers
      </span>
      <p className="pg-triggers__caption">These break the production on purpose.</p>

      <ul className="pg-rail__list">
        {state.scenarios.map((s) => {
          const phase = phaseOf(s.id);
          return (
            <li key={s.id} className="pg-triggers__row">
              <button
                type="button"
                className={`pg-rail__item pg-rail__item--trigger pg-rail__item--${phase}`}
                /* NOT `disabled`. A trigger that will refuse stays focusable and clickable so the
                   refusal can explain itself in the slot below — see `onArm`. `aria-disabled` is what
                   tells assistive technology the control will not act, which `disabled` would say at
                   the cost of making the explanation unreachable by keyboard. */
                aria-disabled={phase !== 'idle' || busy !== null}
                onClick={() => onArm(s)}
                title={`${s.detail}\n\nFires: ${s.findings}`}
              >
                <span className="pg-rail__trigger-label">
                  {s.label}
                  {/* Shape as well as words: a filled disc for activated, a hollow ring for
                      activating. State is never carried by colour alone (§7.3), and these two are
                      told apart by silhouette at the back of a room where amber and teal may not
                      be. */}
                  {phase !== 'idle' && (
                    <span
                      className={`pg-rail__trigger-dot pg-rail__trigger-dot--${phase}`}
                      aria-hidden="true"
                    />
                  )}
                </span>
                {/* Words, not a spinner: pool_bottleneck warms a baseline for 75 seconds and a
                    spinner that long reads as a hang. The word the operator now sees is "activated"
                    rather than "armed" — same state, plainer language. */}
                {phase === 'activating' && (
                  <span className="pg-rail__trigger-state">trigger activating…</span>
                )}
                {phase === 'activated' && (
                  <span className="pg-rail__trigger-state">trigger activated</span>
                )}
              </button>
              <TriggerNote message={messages[s.id]} />
            </li>
          );
        })}
        <li className="pg-triggers__row">
          <button
            type="button"
            className="pg-rail__item pg-rail__item--trigger pg-rail__item--reset"
            onClick={onReset}
            title="Restore every setting the triggers changed"
          >
            <span className="pg-rail__trigger-label">Reset all</span>
            {busy === RESET_KEY && <span className="pg-rail__trigger-state">resetting…</span>}
          </button>
          <TriggerNote message={messages[RESET_KEY]} />
        </li>
      </ul>
    </div>
  );
}

/**
 * One trigger's message slot.
 *
 * ALWAYS MOUNTED, even with nothing to say, and hidden by `:empty` when it is. A live region has to
 * be in the document before its content changes or the change is not announced, and these messages
 * are answers to a button press — the one case where that matters. `role="status"` for every kind,
 * including errors: swapping a node's role between `status` and `alert` is unreliable, and a failed
 * demo trigger is not an emergency. The error tone is carried by a class and a leading word.
 *
 * WHAT REACHES HERE IS NOW ONE LINE AT MOST — a one-sentence `note`, a server `error`, or a local
 * `refused` — since the dispatcher's multi-line captured log is no longer rendered (see `post`). All
 * three are prose rather than preformatted output, so nothing here depends on the log's alignment
 * surviving. Every kind is still rendered as TEXT and never as markup: these strings quote settings
 * and filesystem paths, so `dangerouslySetInnerHTML` would be both wrong and unsafe.
 */
function TriggerNote({ message }: { message: TriggerMessage | undefined }): JSX.Element {
  return (
    <p className={`pg-triggers__msg pg-triggers__msg--${message?.kind ?? 'none'}`} role="status">
      {message === undefined ? null : (
        <>
          {/* A word, so "this failed" is not signalled by the colour of the text alone (§7.3). */}
          {message.kind === 'error' && <span className="pg-triggers__msg-tag">Failed: </span>}
          {message.text}
        </>
      )}
    </p>
  );
}
