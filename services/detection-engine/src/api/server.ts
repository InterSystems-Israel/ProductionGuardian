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
}

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
        default:
          sendJson(res, 404, { error: `no such endpoint: ${path}` }, snapshot.state);
          return;
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
