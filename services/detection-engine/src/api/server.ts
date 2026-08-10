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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'X-Healthscan-State': state,
    // Findings change every poll; a cached response would defeat the 10s bar.
    'Cache-Control': 'no-store',
    ...(length === undefined ? {} : { 'Content-Length': String(length) }),
  });
}
