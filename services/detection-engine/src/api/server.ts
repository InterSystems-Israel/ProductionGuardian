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
]);

const POST_PATHS = new Set(['/api/investigate', '/api/resolve']);

export function createFindingsServer(options: ServerOptions): Server {
  const log = options.log ?? console.error;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only the two documented GETs exist. No trailing-slash variants, no HEAD games.
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      // Preflight, in case Dev C points at us without the Vite proxy.
      writeHead(res, 204, 'ok');
      res.end();
      return;
    }

    if (req.method === 'POST') {
      // The two MVP 2 write-ish endpoints. Handled before the GET guard because they are the only
      // non-GET routes and they are async, which the GET path deliberately is not.
      const handler = !POST_PATHS.has(path)
        ? null
        : path === '/api/investigate'
          ? options.investigate === undefined
            ? undefined
            : async (body: unknown) => options.investigate!(readFindingId(body))
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
          sendJson(res, 200, snapshot.projections, snapshot.state);
          return;
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

function writeHead(res: ServerResponse, status: number, state: string, length?: number): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Contract Q9: sent unconditionally, so the dev proxy is optional not required.
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Healthscan-State': state,
    // Findings change every poll; a cached response would defeat the 10s bar.
    'Cache-Control': 'no-store',
    ...(length === undefined ? {} : { 'Content-Length': String(length) }),
  });
}
