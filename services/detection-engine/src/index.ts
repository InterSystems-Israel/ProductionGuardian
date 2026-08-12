/**
 * Entry point: wires the poll loop to the HTTP server.
 *
 * Defaults to the MOCK proxy client (ADR 0004) — the engine must start and serve with
 * Dev A's proxy absent. Point it at the real proxy with PROXY_MODE=live.
 *
 *   PROXY_MODE=mock|live   default mock
 *   PROXY_BASE_URL         default http://localhost:3001
 *   PORT                   default 3002
 *   POLL_INTERVAL_MS       default 5000 (matches the proxy's IRIS poll)
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFindingsServer } from './api/server.ts';
import { DEFAULT_POLL_INTERVAL_MS, ThresholdStore } from './config/thresholds.ts';
import { DetectionEngine } from './detect/engine.ts';
import { HttpProxyClient } from './proxy/client.ts';
import { MockProxyClient } from './proxy/mockClient.ts';
import type { ProxyClient } from './types/proxy.ts';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env['PORT'] ?? 3002);
// 5s, halved from 10s for #44's latency budget. Safe to shorten only because the sustained
// bar is now time-gated as well as sample-gated — otherwise this would quietly halve the
// debounce duration along with the latency.
//
// The DEFAULT lives in config/thresholds.ts, not here: `sustainedSeconds` has to be
// reachable within `sustainedSamples` polls of it, so the two numbers are one constraint
// and a test must be able to read both. Importing this module to get it would start a
// server and a poll loop as a side effect.
const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? DEFAULT_POLL_INTERVAL_MS);
const PROXY_MODE = process.env['PROXY_MODE'] ?? 'mock';
const PROXY_BASE_URL = process.env['PROXY_BASE_URL'] ?? 'http://localhost:3001';

const thresholds = new ThresholdStore(resolve(serviceRoot, 'thresholds.json'));
thresholds.watch();

const engine = new DetectionEngine(thresholds.current);

const proxy: ProxyClient =
  PROXY_MODE === 'live'
    ? new HttpProxyClient(PROXY_BASE_URL)
    : new MockProxyClient(resolve(serviceRoot, 'fixtures/proxy'));

let inFlight: AbortController | undefined;

async function poll(): Promise<void> {
  // Never let two polls overlap; abort the previous rather than queue behind it.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  try {
    engine.reconfigure(thresholds.current);
    const response = await proxy.fetchMetrics(controller.signal);
    engine.applyPoll(response, Date.now());
  } catch (err) {
    if (controller.signal.aborted) return;
    // Degrade, never blank: keep serving last-known data labelled stale.
    engine.markPollFailed();
    console.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const server = createFindingsServer({ port: PORT, snapshot: () => engine.snapshot() });

server.listen(PORT, () => {
  console.error(
    `detection-engine listening on :${PORT} (proxy=${PROXY_MODE}` +
      `${PROXY_MODE === 'live' ? ` ${PROXY_BASE_URL}` : ''}, poll=${POLL_INTERVAL_MS}ms)`,
  );
});

void poll();
const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    inFlight?.abort();
    thresholds.close();
    server.close(() => process.exit(0));
  });
}
