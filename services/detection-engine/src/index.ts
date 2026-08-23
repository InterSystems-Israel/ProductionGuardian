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
 *
 * DO NOT SHORTEN POLL_INTERVAL_MS. 5000 is AT the floor, not above it -- 4500 already breaks
 * an invariant. `sustainedSeconds: 4` (#46) gates confirmation on the elapsed time between the
 * first two samples, so `(sustainedSamples - 1) x interval` must exceed it with margin:
 * 1 x 5000 > 4000 leaves 1000ms. Measured by sweeping the default (#65):
 *
 *   4500ms   the jitter invariant fails -- a fetch quicker than the last slips confirmation
 *   2500ms   the reachability invariant fails -- nothing confirms on the second sample
 *   1750ms   coverage finally drops, 6/8 finding types
 *    700ms   0/8, including `dead_host`
 *
 * Coverage is NOT the first thing to break, which is what makes shortening this dangerous:
 * by the time findings go missing, the debounce has been broken for 3000ms of interval.
 * `test/engine.test.ts` asserts both invariants, so a change fails loudly rather than
 * silently. Shortening it therefore means retuning `sustainedSeconds` in the same change.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFindingsServer } from './api/server.ts';
import { investigate } from './detect/investigate.ts';
import { liveAgent, mockAgent, liveResolveTool, mockResolveTool } from './detect/agents.ts';
// Aliased: `resolve` is already node:path's, used for every path in this file. Importing ours
// under the same name compiles as a duplicate-identifier error rather than shadowing -- but had it
// shadowed, `resolve(serviceRoot, 'thresholds.json')` would have called the write orchestrator.
import { parseResolveRequest, resolve as runResolve } from './detect/resolve.ts';
import { disabledTriggers, liveTriggers } from './detect/triggers.ts';
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

/**
 * AGENT_MODE selects the AI Detective backend, separately from PROXY_MODE.
 *
 * Two independent switches on purpose: the proxy and the agent fail independently, and the useful
 * combination during development is live metrics with a canned investigation. Folding them into one
 * flag would force a choice nobody wants -- either mock the metrics you have, or block on an LLM you
 * do not.
 *
 * Defaults to `mock`, matching PROXY_MODE and ADR 0004: the engine must stand up and serve with
 * nothing else running.
 */
const AGENT_MODE = process.env['AGENT_MODE'] ?? 'mock';
const IRIS_BASE_URL = process.env['IRIS_BASE_URL'] ?? 'http://localhost:52773';

// The engine's own IRIS credentials, for the dispatcher's web application. The engine holds these
// because the tool is RBAC-gated; it holds NO LLM key, which stays in the AI Hub wallet.
const IRIS_USER = process.env['IRIS_USER'] ?? 'superuser';
const IRIS_PASS = process.env['IRIS_PASS'] ?? 'SYS';

/**
 * Demo scenario triggers for the dashboard's buttons — OFF unless explicitly enabled.
 *
 * Gated separately from AGENT_MODE, because they answer a different question. AGENT_MODE selects
 * where investigations come from; this decides whether a browser may break the production. A demo
 * with a live agent is normal; a deployment where a button can disable a host is not, so it does not
 * ride along on `live`.
 *
 * `liveTriggers` also requires a live IRIS. With AGENT_MODE=mock there is no reachable dispatcher,
 * so the flag alone is not enough and both conditions are named here rather than one implying the
 * other.
 */
const DEMO_TRIGGERS = (process.env['DEMO_TRIGGERS'] ?? '').trim();
const triggersEnabled =
  DEMO_TRIGGERS !== '' && DEMO_TRIGGERS !== '0' && DEMO_TRIGGERS.toLowerCase() !== 'false';
const triggers =
  triggersEnabled && AGENT_MODE === 'live'
    ? liveTriggers(IRIS_BASE_URL, IRIS_USER, IRIS_PASS, (m: string) => console.error(m))
    : disabledTriggers();

const agentSource = AGENT_MODE === 'live' ? 'agent' : 'canned';
const callAgent =
  AGENT_MODE === 'live'
    ? liveAgent(IRIS_BASE_URL, IRIS_USER, IRIS_PASS, (m: string) => console.error(m))
    : mockAgent();
// Same switch, separate caller: with AGENT_MODE=mock the resolve endpoint previews and applies
// against an in-memory pool size, so Dev C can build the approve flow with no IRIS at all.
const callTool =
  AGENT_MODE === 'live'
    ? liveResolveTool(IRIS_BASE_URL, IRIS_USER, IRIS_PASS, (m: string) => console.error(m))
    : mockResolveTool();

const server = createFindingsServer({
  port: PORT,
  snapshot: () => engine.snapshot(),
  log: (m) => console.error(m),
  investigate: async (findingId) => {
    const snap = engine.snapshot();
    const finding = snap.findings.find((f) => f.id === findingId);
    if (finding === undefined) {
      // Deliberately an error rather than an `unavailable` investigation: an unknown id is the
      // CALLER being wrong, and dressing it as "we could not investigate" would hide a bug in
      // whatever built the request.
      throw new Error(`bad request: no current finding with id ${findingId}`);
    }
    const host = snap.hosts.find((h) => h.host === finding.host);
    if (host === undefined) {
      throw new Error(`no host state for ${finding.host}`);
    }
    const projection = snap.projections.find((p) => p.host === finding.host);
    // Pool size comes from the projection's own threshold basis where available; the authoritative
    // read is get_pool_size, which the AGENT calls. Passing null rather than guessing keeps this
    // service out of the business of reading production config.
    return investigate(finding, host, projection, null, {
      callAgent,
      source: agentSource,
      log: (m) => console.error(m),
    });
  },
  resolve: async (body) =>
    // parseResolveRequest throws `bad request: ...` for anything malformed, which the server maps
    // to 400. Validated here rather than inside resolve() so the endpoint answers a bad body
    // without ever reaching the write tool.
    runResolve(parseResolveRequest(body), { callTool, log: (m) => console.error(m) }),
  triggerStatus: () => triggers.status(),
  armTrigger: async (body) => {
    // Read here rather than in triggers.ts so a malformed body is a 400 from the API boundary,
    // the same division as parseResolveRequest above. The scenario is NOT validated against the
    // list -- IRIS owns that list and its $case is the authority; duplicating it here is the
    // stale-copy pattern, and an unknown name comes back as a named 400 from the dispatcher.
    const scenario =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['scenario']
        : undefined;
    if (typeof scenario !== 'string' || scenario === '') {
      throw new Error('bad request: scenario must be a non-empty string');
    }
    return triggers.arm(scenario);
  },
  resetTriggers: () => triggers.reset(),
});

server.listen(PORT, () => {
  console.error(
    // agent=<mode> is in the startup line because a canned investigation is indistinguishable
    // from a real one at a glance, and the operator most likely to be misled is the one reading
    // logs during a demo. The response carries `source` for the same reason.
    `detection-engine listening on :${PORT} (proxy=${PROXY_MODE}` +
      `${PROXY_MODE === 'live' ? ` ${PROXY_BASE_URL}` : ''}` +
      `, agent=${AGENT_MODE}${AGENT_MODE === 'live' ? ` ${IRIS_BASE_URL}` : ''}` +
      `, poll=${POLL_INTERVAL_MS}ms` +
      // Printed because a trigger surface that is silently ON is the thing worth noticing in a log.
      `${triggersEnabled ? ', demo-triggers=ON' : ''})`,
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
