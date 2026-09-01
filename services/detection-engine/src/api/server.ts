/**
 * Findings API — the two endpoints Dev C consumes, on :3002.
 *
 * Behaviour is fixed by §3 of contracts/healthscan-api.md:
 *   - zero findings -> 200 + [], NEVER 404
 *   - X-Healthscan-State: ok | warming | stale (advisory)
 *   - Access-Control-Allow-Origin: * always (contract Q9)
 *   - findings sorted detectedAt desc; hosts sorted by name
 *
 * Prefer stale-but-labelled over an error: a blanked dashboard is worse on stage than
 * slightly old data.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EngineSnapshot } from '../detect/engine.ts';
import { publishedProjection } from '../detect/earlywarning.ts';
// The off-state payload, imported rather than written out here. It was inlined twice below and
// gained a third field in #135; two literals that must match a type in another file is the
// stale-copy shape, and both copies would have been silently short an `activating: {}`.
import { TRIGGERS_DISABLED } from '../detect/triggers.ts';

export interface ServerOptions {
  port: number;
  /** Reads the engine's current state. Called per request, never cached. */
  snapshot: () => EngineSnapshot;
  log?: (msg: string) => void;
  /**
   * Handles `POST /api/investigate`. Absent means the endpoint answers 503 rather than 404 --
   * "not configured here" and "no such endpoint" are different facts, and a dashboard that gets
   * 404 will conclude the feature does not exist rather than that this deployment lacks an agent.
   */
  investigate?: (findingId: string) => Promise<unknown>;
  /** Handles `POST /api/resolve`. Same 503-not-404 reasoning. */
  resolve?: (body: unknown) => Promise<unknown>;
  /**
   * Demo trigger routes, present even when triggers are DISABLED.
   *
   * Unlike `investigate`/`resolve`, these are always wired: `disabledTriggers()` answers
   * `{enabled: false, scenarios: []}` for the status GET and an error for the writes. So the GET is
   * a 200 with a truthful "off" rather than a 503, because the UI polls it to decide whether to
   * render the buttons at all -- and a 503 there would be indistinguishable from the engine being
   * unhealthy, which is what the connection banner is for.
   */
  triggerStatus?: () => Promise<unknown>;
  /** Handles `POST /api/demo/trigger`. Declines when triggers are off; never 404s. */
  armTrigger?: (body: unknown) => Promise<unknown>;
  /** Handles `POST /api/demo/reset`. */
  resetTriggers?: () => Promise<unknown>;
  /**
   * Handles `POST /api/chat` — the activity insights question.
   *
   * Absent means 503, same reasoning as `investigate`: this deployment has no agent wired is a
   * different fact from no such endpoint, and a 404 would tell the dashboard the feature does not
   * exist in this build. There is no canned chat fallback to degrade to — see `detect/chat.ts` for
   * why a mock that has to guess the question cannot be made honest.
   */
  chat?: (body: unknown) => Promise<unknown>;
  /**
   * Handles `GET /api/hostseries?host=...&span=...` -- one host's recent metric series.
   *
   * WIRED RATHER THAN OPTIONAL-WITH-A-503, unlike `investigate` and `chat`. Those need an external
   * agent this deployment may not have; this reads the rolling baseline, which every engine has by
   * construction. So absence here would mean "an engine built before this endpoint", and an empty
   * series is served rather than an error, for the reason the GETs below all share: a missing graph
   * must not raise the connection banner.
   *
   * SYNCHRONOUS, like every GET but `/api/demo/triggers`. It walks in-memory arrays and touches
   * nothing outside the process.
   */
  hostSeries?: (host: string, spanSeconds: number | null) => unknown;
  /**
   * `GET /api/settings/thresholds` -- the current effective threshold settings.
   *
   * WIRED RATHER THAN OPTIONAL-WITH-A-503, like `hostSeries` and for the same reason: it reads
   * the config every engine has by construction, with no external dependency that a deployment
   * might lack. Absent means an engine built before this endpoint, and the GET then answers an
   * empty field list -- which the panel renders as "this engine has no editable settings",
   * rather than raising the connection banner over an optional control.
   */
  settings?: () => unknown;
  /** Handles `PUT /api/settings/thresholds`. Absent means 503, naming the deployment. */
  applySettings?: (body: unknown) => unknown;
  /** Handles `POST /api/settings/thresholds/reset`. Takes no body; see `resetSettings`. */
  resetSettings?: () => unknown;
}

/**
 * The routes, split by method, so each branch can tell "wrong method on a real endpoint" from "no
 * such endpoint". Kept adjacent to the switch below -- a second list is a thing that goes stale,
 * and either one going stale would turn a 405 back into a misleading 404.
 *
 * BOTH sets are needed, not just the GET one. With only GET_PATHS, `GET /api/resolve` answered 404
 * -- the same defect as the `POST /api/healthscan/findings` regression, mirrored: the endpoint is
 * real and only the method is wrong, and 404 tells a caller it does not exist. Found by asking for
 * the symmetric case rather than by a failing test, because no test covered a GET to a POST route.
 */
const GET_PATHS = new Set([
  '/api/healthscan/hosts',
  '/api/healthscan/findings',
  '/api/healthscan/health',
  '/api/earlywarning',
  // NOT under /api/healthscan/, for the same reason /api/earlywarning is not: that prefix is the
  // RATIFIED two-endpoint contract, and a third path under it would read as part of it. This is an
  // operational read over state the engine already holds, so it is a sibling -- same precedent, and
  // `contracts/` needs no change to add one (root CLAUDE.md §4 governs edits to that directory, not
  // the existence of endpoints outside it).
  '/api/hostseries',
  // Under /api/demo/ so the demo surface is one prefix, greppable and removable as a unit.
  '/api/demo/triggers',
  // Sibling of the ratified prefix, same precedent as /api/earlywarning and /api/hostseries: an
  // operational read over state the engine already holds, so `contracts/` needs no change to add
  // one. NOT under /api/demo/ either -- threshold tuning is ADR 0003 product configuration that
  // ships enabled, not demo scaffolding to be removed as a unit.
  '/api/settings/thresholds',
]);

const POST_PATHS = new Set([
  '/api/investigate',
  '/api/resolve',
  '/api/demo/trigger',
  '/api/demo/reset',
  // NOT under /api/demo/: the chat assistant is a product capability, not demo scaffolding, and it
  // is read-only. Putting it under that prefix would also give it the 180s nginx timeout meant for
  // arming a slow scenario, which is longer than IRIS will hold a request open anyway.
  '/api/chat',
  // POST, not PUT, for the write. The path is also a GET route, so `/api/settings/thresholds`
  // appears in BOTH sets -- which the 405/404 logic below already handles correctly, and is what
  // makes a wrong method on it a 405 naming the method rather than a 404 denying the endpoint.
  // PUT would have needed a third method branch in this file for one route; POST reuses the
  // origin check, the body cap and the error mapping the two MVP 2 writes already go through.
  // These ARE writes -- they change what fires on a live production -- so they belong behind
  // WRITE_ORIGINS with the others rather than looking like a read.
  '/api/settings/thresholds',
  '/api/settings/thresholds/reset',
]);

/**
 * Origins permitted to POST — the fix for `resolve-api.md` §13.2's confused deputy.
 *
 * THE PROBLEM, MEASURED rather than reasoned about. `Access-Control-Allow-Origin: *` on a write
 * endpoint means any page open in the browser can POST to `:3002`. Verified against the running
 * stack before changing anything:
 *
 *     POST /api/resolve   Origin: https://evil.example.com
 *     -> HTTP 200  {"outcome":"previewed","after":{"poolSize":8}}
 *     OPTIONS      -> Access-Control-Allow-Origin: *, Allow-Methods: GET, POST, OPTIONS
 *
 * §13.2 calls that "tolerable — not fine" partly because "the engine holds no authority of its
 * own". Under §13.1's service-account model that is no longer true: the engine authenticates to
 * IRIS with a credential that HOLDS the write role. So the browser cannot write, the engine can,
 * and `*` lets any page ask it to. That is the confused deputy exactly.
 *
 * WHY AN ALLOW-LIST AND NOT THE OTHER TWO OPTIONS. §13.2 lists three. Binding `:3002` to localhost
 * would break the compose network, where the dashboard reaches the engine by service name. The
 * pass-through credential closes this properly and is the right long-term answer -- it removes the
 * standing privilege rather than guarding it -- but it needs a login the dashboard does not have,
 * so it is a decision (§13.1) rather than a patch. An origin allow-list is what can be done inside
 * this service today without deciding that.
 *
 * WHAT IT DOES NOT DO, stated plainly so nobody reads it as more than it is. CORS is enforced by
 * the BROWSER, so this stops a malicious PAGE and stops nothing else: curl, a script, or anything
 * that does not honour CORS reaches the endpoint unchanged. It closes the drive-by, not the
 * network path. The real fix is still §13.1.
 *
 * GETs keep `*`. They are reads, they are CORS-simple, and Q9's reason for `*` -- the dev proxy
 * stays optional -- applies to them and not to a write.
 */
const DEFAULT_WRITE_ORIGINS = [
  // The dashboard's dev server and its containerised form. Both, because Dev C runs Vite directly
  // and the compose stack serves the built bundle from nginx on 5173.
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

/**
 * Resolve the permitted write origins. `PG_WRITE_ORIGINS` overrides, comma-separated.
 *
 * `*` is accepted as an explicit opt-out, and it is deliberately something you have to TYPE. A
 * deployment that needs it can have it; nobody gets it by default, and it appears in the startup
 * log so an operator can see the endpoint is open.
 */
function writeOrigins(): { list: string[]; open: boolean } {
  const raw = process.env['PG_WRITE_ORIGINS'];
  if (raw === undefined || raw.trim() === '') return { list: DEFAULT_WRITE_ORIGINS, open: false };
  const list = raw.split(',').map((o) => o.trim()).filter((o) => o !== '');
  return { list, open: list.includes('*') };
}

const WRITE_ORIGINS = writeOrigins();

/**
 * Is this origin allowed to POST?
 *
 * A MISSING Origin header is ALLOWED, and that is not a loophole being left open -- it is the
 * distinction between the two threats. Browsers always send `Origin` on a cross-origin POST, so a
 * request without one is not a page: it is curl, the dashboard's own server-side proxy, or a
 * health check. Rejecting those would break the dev proxy and every scripted verification while
 * stopping nothing, because anything that can omit the header can also forge it.
 */
function mayWrite(origin: string | undefined): boolean {
  if (WRITE_ORIGINS.open) return true;
  if (origin === undefined || origin === '') return true;
  return WRITE_ORIGINS.list.includes(origin);
}


export function createFindingsServer(options: ServerOptions): Server {
  const log = options.log ?? console.error;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only the two documented GETs exist. No trailing-slash variants, no HEAD games.
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      // Preflight, in case Dev C points at us without the Vite proxy.
      //
      // The preflight must AGREE with the POST branch. If it advertised POST to an origin the POST
      // branch then rejects, the browser would pass the preflight and fail the real request -- and
      // the visible symptom would be a 403 with no explanation of which check refused it. So a
      // disallowed origin is told POST is unavailable here, which is the truth for it.
      writeHead(res, 204, 'ok', undefined, mayWrite(req.headers.origin));
      res.end();
      return;
    }

    if (req.method === 'POST') {
      // ORIGIN CHECK FIRST, before routing and before any handler. A rejected origin must not
      // reach the write tool, and it must not even learn which routes exist -- so this precedes
      // the 404/405 distinction below.
      const origin = req.headers.origin;
      if (!mayWrite(origin)) {
        log(`refused POST ${path} from origin ${String(origin)}`);
        // 403, and here it IS the right code -- unlike a policy refusal (resolve-api.md §5.1),
        // which is a 200 because the CALLER is legitimate and the answer is informative. This is
        // not a legitimate caller: no operator sees this response, only a page that should not
        // have asked. There is nothing for a UI to render.
        sendJson(
          res,
          403,
          { error: `origin ${String(origin)} is not permitted to POST to this engine` },
          'ok',
        );
        return;
      }
      // The two MVP 2 write-ish endpoints. Handled before the GET guard because they are the only
      // non-GET routes and they are async, which the GET path deliberately is not.
      const handler = !POST_PATHS.has(path)
        ? null
        : path === '/api/investigate'
          ? options.investigate === undefined
            ? undefined
            : async (body: unknown) => options.investigate!(readFindingId(body))
          : path === '/api/chat'
            ? options.chat
            : path === '/api/settings/thresholds'
              ? options.applySettings === undefined
                ? undefined
                : async (body: unknown) => options.applySettings!(body)
              : path === '/api/settings/thresholds/reset'
                ? // Takes no body, ignored rather than validated -- the same reasoning as
                  // /api/demo/reset below: reset recovers from every other operation and must not
                  // be refusable on a malformed request.
                  options.resetSettings === undefined
                  ? undefined
                  : async () => options.resetSettings!()
                : path === '/api/demo/trigger'
            ? options.armTrigger
            : path === '/api/demo/reset'
              ? // Takes no body. Ignoring it rather than validating an empty object: reset is the
                // operation that recovers from every other one, and it must not be refusable on a
                // malformed request.
                options.resetTriggers === undefined
                ? undefined
                : async () => options.resetTriggers!()
              : options.resolve;

      if (handler === null) {
        // A POST to a path that exists as a GET route is 405, not 404 -- the endpoint is real, the
        // method is not allowed on it. Returning 404 here was a regression I introduced by putting
        // the POST branch ahead of the method guard, and the existing "405s a non-GET method" test
        // caught it. Worth the extra branch: 404 tells a caller the endpoint does not exist, which
        // for /api/healthscan/findings is simply false.
        const isKnownGetPath = GET_PATHS.has(path);
        sendJson(
          res,
          isKnownGetPath ? 405 : 404,
          isKnownGetPath
            ? { error: `method POST not allowed on ${path}` }
            : { error: `no such endpoint: ${path}` },
          'ok',
        );
        return;
      }
      if (handler === undefined) {
        // 503, not 404: the route exists in this build but this deployment has no agent wired.
        sendJson(
          res,
          503,
          { error: `${path} is not configured on this deployment` },
          options.snapshot().state,
        );
        return;
      }

      readJsonBody(req)
        .then(async (body) => {
          const result = await handler(body);
          sendJson(res, 200, result, options.snapshot().state);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log(`POST ${path} failed: ${message}`);
          // 400 for a body we could not read, 500 for a genuine fault. Distinguished because one is
          // the caller's problem and the other is ours.
          const status = message.startsWith('bad request') ? 400 : 500;
          sendJson(res, status, { error: message }, 'stale');
        });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `method ${req.method} not allowed` }, 'ok');
      return;
    }

    try {
      const snapshot = options.snapshot();

      switch (path) {
        case '/api/healthscan/hosts':
          sendJson(res, 200, snapshot.hosts, snapshot.state);
          return;
        case '/api/healthscan/findings':
          sendJson(res, 200, snapshot.findings, snapshot.state);
          return;
        case '/api/earlywarning':
          // NOT under /api/healthscan/: Early Warning is a separate MVP 2 module, and nesting it
          // there would imply it is part of the ratified Health Scan contract. Flagged as EW-Q1
          // in contracts/earlywarning-api.md rather than renamed silently.
          //
          // Reuses the same X-Healthscan-State value rather than adding its own header. A second
          // state header could disagree with the first, and a consumer would have no rule for
          // which to believe -- the projections come from the same poll as the findings, so they
          // share its freshness by construction.
          //
          // MAPPED, not served raw: `HostProjection` carries one internal field the contract does not
          // publish -- the measured window slope, which §1.4 keeps off this endpoint and
          // `investigation-api.md` §2.2 requires for the agent (#187). `publishedProjection` is a
          // whitelist, so the endpoint's shape is decided there rather than by whatever the type
          // happens to hold.
          sendJson(res, 200, snapshot.projections.map(publishedProjection), snapshot.state);
          return;
        case '/api/hostseries': {
          // `host` IS REQUIRED AND IS A 400, not an empty series. Every other read here answers
          // "what is true now" and has a correct empty answer; this one answers "about which host",
          // and there is no host it could mean. Serving [] for a missing parameter would make a
          // dashboard bug -- a click that lost the host name -- look like a host with no history.
          const host = url.searchParams.get('host');
          if (host === null || host.trim() === '') {
            sendJson(res, 400, { error: 'bad request: host is required' }, snapshot.state);
            return;
          }
          if (options.hostSeries === undefined) {
            // An engine wired without it. Empty rather than an error, and `known: false` says why
            // there is nothing -- the client's own "no data" branch then renders, which is a state
            // it has to handle anyway for a warming engine.
            sendJson(
              res,
              200,
              { host, known: false, polledAt: null, spanSeconds: 0, pollIntervalSeconds: 0, series: [] },
              snapshot.state,
            );
            return;
          }
          // `span` is optional; null means "your default". Parsed rather than trusted -- a
          // non-numeric or negative value is treated as absent rather than refused, because the
          // parameter is a display convenience and clamping already bounds what it can ask for.
          const rawSpan = url.searchParams.get('span');
          const parsedSpan = rawSpan === null ? Number.NaN : Number(rawSpan);
          const span = Number.isFinite(parsedSpan) && parsedSpan > 0 ? parsedSpan : null;
          sendJson(res, 200, options.hostSeries(host, span), snapshot.state);
          return;
        }
        case '/api/settings/thresholds':
          // Empty field list rather than an error when unwired, per the `settings` option's
          // comment: the panel renders "no editable settings" and the connection banner stays out
          // of it. SYNCHRONOUS, like every GET but /api/demo/triggers -- it reads in-memory config.
          sendJson(
            res,
            200,
            options.settings === undefined
              ? { fields: [], effective: {}, file: {}, overridden: false, persistence: '' }
              : options.settings(),
            snapshot.state,
          );
          return;
        case '/api/demo/triggers': {
          // THE ONE ASYNC GET, because the armed state lives in IRIS and this must report what is
          // actually armed rather than what the UI last asked for -- someone driving the terminal
          // during a rehearsal is normal, and a button showing stale state is worse than no button.
          //
          // A failure is a 200 with `enabled: false`, not a 5xx: this endpoint answers "should the
          // trigger buttons exist", and if IRIS cannot be reached the honest answer is "no". A 5xx
          // would put the connection banner into an error state over an optional demo affordance.
          if (options.triggerStatus === undefined) {
            sendJson(res, 200, TRIGGERS_DISABLED, snapshot.state);
            return;
          }
          options.triggerStatus()
            .then((payload) => sendJson(res, 200, payload, snapshot.state))
            .catch((err: unknown) => {
              log(`trigger status unavailable: ${String(err)}`);
              sendJson(res, 200, TRIGGERS_DISABLED, snapshot.state);
            });
          return;
        }
        case '/api/healthscan/health':
          // Not in the contract — operational only, for "is the engine up".
          sendJson(
            res,
            200,
            {
              state: snapshot.state,
              hosts: snapshot.hosts.length,
              findings: snapshot.findings.length,
              lastPollAt:
                snapshot.lastPollAt === null ? null : new Date(snapshot.lastPollAt).toISOString(),
            },
            snapshot.state,
          );
          return;
        default: {
          // Symmetric with the POST branch: a GET to a POST-only route is 405, not 404.
          const isKnownPostPath = POST_PATHS.has(path);
          sendJson(
            res,
            isKnownPostPath ? 405 : 404,
            isKnownPostPath
              ? { error: `method GET not allowed on ${path}` }
              : { error: `no such endpoint: ${path}` },
            snapshot.state,
          );
          return;
        }
      }
    } catch (err) {
      // A genuine fault is the one case that gets a 5xx (contract §3).
      const message = err instanceof Error ? err.message : String(err);
      log(`request failed for ${path}: ${message}`);
      sendJson(res, 500, { error: message }, 'stale');
    }
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  state: string,
): void {
  const payload = JSON.stringify(body);
  writeHead(res, status, state, Buffer.byteLength(payload));
  res.end(payload);
}

/**
 * Read and parse a JSON request body, with a size cap.
 *
 * CAPPED at 64 KB. Every legitimate body here is a findingId or a small action object, so anything
 * larger is a mistake or an attack, and an uncapped read is an unbounded allocation on a public
 * port. Rejecting is the honest response rather than buffering whatever arrives.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX = 64 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX) throw new Error('bad request: body exceeds 64 KB');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') throw new Error('bad request: empty body');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('bad request: body is not valid JSON');
  }
}

/**
 * Extract `findingId` from an investigate body.
 *
 * The contract makes the body EXACTLY `{"findingId": "..."}` with `additionalProperties: false`, and
 * that is the structural half of the data boundary: because the body is one id, every value the
 * model sees was engine-measured or tool-read. Extra keys are rejected rather than ignored -- a
 * tolerated `prompt` field would be a text-injection path into an LLM prompt.
 */
function readFindingId(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw new Error('bad request: body must be an object');
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'findingId') {
    throw new Error(
      `bad request: body must contain exactly findingId, got [${keys.join(', ')}]`,
    );
  }
  const id = (body as Record<string, unknown>)['findingId'];
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('bad request: findingId must be a non-empty string');
  }
  return id;
}

function writeHead(
  res: ServerResponse,
  status: number,
  state: string,
  length?: number,
  allowWrite = true,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Contract Q9: sent unconditionally, so the dev proxy is optional not required. Still `*`:
    // the GETs are reads and CORS-simple, and Q9's reasoning applies to them. Only the METHODS
    // advertised below narrow for a disallowed origin -- which is what actually gates the write.
    'Access-Control-Allow-Origin': '*',
    // POST is advertised for the MVP 2 endpoints (`/api/investigate`, `/api/resolve`), and
    // Allow-Headers is what a JSON POST actually needs: a cross-origin request carrying
    // `Content-Type: application/json` is NOT a CORS-simple request, so the browser sends a
    // preflight, and a preflight with no `Access-Control-Allow-Headers` in the reply fails --
    // while every existing GET keeps working, because those ARE simple requests and are never
    // preflighted. That asymmetry is the whole problem: the symptom is a dashboard that renders
    // live data perfectly and silently cannot submit an approval, with nothing in the engine log
    // (the request never arrives). Named in contracts/resolve-api.md before either endpoint
    // existed, so it would not be diagnosed from the UI.
    //
    // Advertised BEFORE the routes exist on purpose. A method in Allow-Methods with no route
    // behind it answers 405, which is a clear, correct answer to "can I POST here yet". The
    // reverse -- a route with the header missing -- is the invisible failure.
    //
    // POST is advertised only to an origin permitted to use it (§13.2 -- see WRITE_ORIGINS). A
    // browser that is not on the list is told GET and OPTIONS, which is accurate for it rather
    // than a refusal it has to discover by trying.
    'Access-Control-Allow-Methods': allowWrite ? 'GET, POST, OPTIONS' : 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Healthscan-State': state,
    // Findings change every poll; a cached response would defeat the 10s bar.
    'Cache-Control': 'no-store',
    ...(length === undefined ? {} : { 'Content-Length': String(length) }),
  });
}
