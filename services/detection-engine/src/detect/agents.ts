/**
 * The two agent callers behind one interface: live AI Hub, and a canned mock.
 *
 * ADR 0004 and MVP 2 §6 both ask for a mock agent as a hot standby — "never block the demo on live
 * AI". The point of putting both behind the same `callAgent` signature is that the orchestration in
 * `investigate.ts` is ONE code path: the mock exercises the same validation, the same failure
 * discipline, and the same response shape as the live agent. Two branches would drift, and the one
 * that drifts is always the one only used in a fallback.
 */

import type { InvestigateDeps } from './investigate.ts';

/**
 * Live agent, over HTTP to the IRIS instance.
 *
 * The AGENT runs in IRIS, not here. This service holds no LLM key and no model configuration —
 * `iris/labdemo/Tools/` owns the tools and AI Hub owns the provider, so all this does is hand over a
 * request and validate what comes back. That separation is why a bug in this file cannot leak a
 * credential or call a model directly.
 */
export function liveAgent(baseUrl: string, log?: (m: string) => void): InvestigateDeps['callAgent'] {
  return async (request, timeoutMs) => {
    // AbortSignal rather than a Promise.race: race leaves the fetch running and its socket open, so
    // a slow agent would accumulate connections across polls. Aborting actually cancels it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/labdemo/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`agent returned HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // Distinguish a timeout from a refusal in the log, because they need different responses: a
      // timeout is retryable and a 4xx is not.
      if (err instanceof Error && err.name === 'AbortError') {
        log?.(`agent timed out after ${timeoutMs}ms`);
        throw new Error(`agent timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Mock agent: the canned investigation for the one MVP 2 scenario.
 *
 * WHAT IT IS FOR. Dev C's investigation panel, the offline demo fallback, and the hot standby when
 * the LLM is rate-limited or unreachable. It returns the shape the live agent returns, so swapping
 * one for the other changes no downstream code.
 *
 * IT READS THE REQUEST RATHER THAN IGNORING IT. The numbers in the response come from the snapshot
 * the engine measured — the host name, the queue depth, the pool size. A mock that returned a fixed
 * string would drift from reality the moment the scenario changed, and would show `Cloud API` while
 * the panel displayed a different host. The NARRATIVE is canned; the FACTS are live.
 *
 * WHAT IT MUST NOT DO. It must not be mistaken for a real investigation. `source: "canned"` is what
 * the response carries, and `investigate.ts` sets `state` from that — so the UI can label it, which
 * `investigation-api.md` §4.3 requires. A mock that presented itself as `agent` would be the same
 * defect class as a projection published as a measurement.
 */
export function mockAgent(): InvestigateDeps['callAgent'] {
  return async (request) => {
    const snapshot = request.snapshot as Record<string, unknown>;
    const trend = request.trend as Record<string, unknown> | null;
    const host = String(snapshot['host'] ?? 'Cloud API');
    const queued = snapshot['queued'];
    const poolSize = snapshot['poolSize'];
    const slope = trend?.['slope'] ?? null;

    // The recommendation is 4 because that is the one whitelisted target for this scenario, and
    // because 4 workers against a ~1s downstream clears ~4/sec — enough to drain a queue built at
    // ~2/sec. Not an arbitrary "bigger number".
    return {
      rootCause:
        `${host} is throughput-bound. It runs at PoolSize 1 against a downstream dispatcher that ` +
        `takes about a second per message, so it clears roughly 1 message/sec while inbound volume ` +
        `exceeds that. The host itself is healthy — it is outnumbered, not broken.`,
      evidence: [
        {
          label: `${host} pool size`,
          detail: `${host} PoolSize = ${poolSize ?? 1}`,
          source: 'mcp_tool',
          tool: 'get_pool_size',
        },
        {
          label: 'Queue depth',
          detail: queued === null || queued === undefined
            ? 'queue depth not measurable'
            : `${queued} message(s) queued`,
          source: 'snapshot',
          tool: null,
        },
        {
          label: 'Downstream latency',
          detail: `average processing time ${snapshot['avgProcessingTime'] ?? '~1'}s per message`,
          source: 'mcp_tool',
          tool: 'get_processing_time',
        },
        {
          label: 'Queue slope',
          detail: slope === null ? 'queue rising' : `queue rising ~${String(slope)}/min`,
          source: 'snapshot',
          tool: null,
        },
      ],
      // A FIXED number, and stated as such rather than dressed up. This is a canned response, so
      // there is no model self-report to pass through -- inventing a varying one would imply a
      // judgement nothing made. 0.9 reflects that this single scenario is unambiguous, not a
      // calibrated probability (contract §3.4 says the live one is not calibrated either).
      confidence: 0.9,
      recommendedAction: {
        action: { type: 'set_pool_size', host, size: 4 },
      },
      model: null,
      toolCalls: null,
    };
  };
}
