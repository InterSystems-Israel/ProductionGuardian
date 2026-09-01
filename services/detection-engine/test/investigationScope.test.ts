/**
 * The §2.4 scope gate, and the §2.3 data boundary it was supposed to enforce (#206).
 *
 * THE ASSERTION THAT MATTERS IS THE ABSENCE OF THE OUTBOUND CALL, not the shape of the response. The
 * defect was not a wrong payload — it was that `investigate()` had no type check at all, so a
 * `system_alert` finding, whose `message` is text IRIS wrote into `alerts.log` rather than metric
 * prose this engine composed, was forwarded verbatim to an external LLM. Root `CLAUDE.md` §2.1 states
 * that as non-negotiable: metrics and configuration leave the instance, never message content.
 *
 * So every test here spies on `callAgent` and asserts it was never invoked. A test that only checked
 * `state === 'unavailable'` would pass against a version that refused the response *after* making
 * the call, which is exactly the failure being fixed.
 *
 * WHY THE TWO LISTS ARE TESTED FOR DISJOINTNESS. The boundary refusal is deliberately not derived
 * from the scope allowlist, so that widening scope for a third scenario cannot silently reopen the
 * alert-text path. That property is invisible in normal use — nothing fails if the two overlap until
 * a real alert is forwarded — so it is asserted rather than left to the comment that argues for it.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  INVESTIGABLE_TYPES,
  NEVER_FORWARDED,
  investigate,
  type InvestigateDeps,
} from '../src/detect/investigate.ts';
import type { Finding, Host } from '../src/types/healthscan.ts';

const HOST: Host = {
  host: 'Cloud API',
  type: 'operation',
  status: 'OK',
  queued: 90,
  messagesPerSec: 4,
  errored: 0,
  avgProcessingTime: 1.01,
  avgQueueingTime: 12,
  lastActivity: '2026-08-31T10:00:00Z',
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f-3001',
    host: 'Cloud API',
    type: 'queue_buildup',
    severity: 'critical',
    currentValue: 90,
    baselineValue: 0,
    detectedAt: '2026-08-31T10:00:00Z',
    message: 'Queue depth 90 is over the floor of 50',
    ...over,
  };
}

/** An agent that records whether it was reached, and fails the test's premise if it is. */
function spyAgent(): { calls: unknown[]; deps: InvestigateDeps } {
  const calls: unknown[] = [];
  return {
    calls,
    deps: {
      callAgent: async (request) => {
        calls.push(request);
        return {
          rootCause: 'this reply should never be reachable in these tests',
          evidence: [],
          confidence: 0.9,
        };
      },
      source: 'agent',
      now: () => Date.parse('2026-08-31T10:00:00Z'),
    },
  };
}

test('a system_alert finding never reaches the agent, and says why', async () => {
  const { calls, deps } = spyAgent();
  const res = await investigate(
    finding({
      type: 'system_alert',
      severity: 'info',
      // The shape of the real hazard: an alert about a failed send, naming what was being sent. This
      // string is what must not travel, and it is why the note below quotes the TYPE and not it.
      message: 'Cloud API failed to send message 4417 for patient MRN 90210',
    }),
    HOST,
    undefined,
    null,
    deps,
  );

  // THE POINT OF THE TEST.
  assert.equal(calls.length, 0, 'the finding was forwarded to the agent');

  assert.equal(res.state, 'unavailable');
  assert.equal(res.source, 'none');
  assert.equal(res.rootCause, null);
  assert.deepEqual(res.evidence, []);
  assert.equal(res.recommendedAction, null);
  assert.equal(res.manualRemediation, null);
  assert.match(res.diagnostics.note ?? '', /not investigated/);
  // The note is rendered in a browser, so it must not carry the message it refused to send.
  assert.ok(
    !(res.diagnostics.note ?? '').includes('MRN'),
    'the refusal note quoted the finding message',
  );
});

test('the five types with no scenario are refused without an agent call', async () => {
  for (const type of [
    'stalled_host',
    'elevated_error_rate',
    'slow_processing',
    'growing_queue_wait',
    'throughput_drop',
  ] as const) {
    const { calls, deps } = spyAgent();
    const res = await investigate(finding({ type }), HOST, undefined, null, deps);
    assert.equal(calls.length, 0, `${type} was forwarded to the agent`);
    assert.equal(res.state, 'unavailable', type);
    // Distinguishable from the boundary refusal, because they are different reasons: no scenario
    // exists, versus this may not be sent. An operator reading the panel should be able to tell.
    assert.match(res.diagnostics.note ?? '', /no investigation exists/, type);
  }
});

test('the two shipped scenarios are NOT refused', async () => {
  // The complement, and the half that would catch a gate that refuses everything. Both scenarios are
  // real: `queue_buildup` on a throughput-bound operation (MVP 2) and `dead_host` on a service
  // polling a directory that does not exist (MVP 3 §2.3).
  for (const type of ['queue_buildup', 'dead_host'] as const) {
    const { calls, deps } = spyAgent();
    const res = await investigate(finding({ type }), HOST, undefined, null, deps);
    assert.equal(calls.length, 1, `${type} did not reach the agent`);
    assert.equal(res.state, 'complete', type);
  }
});

test('a refusal is still stamped and correlatable, like any other response', async () => {
  const { deps } = spyAgent();
  const res = await investigate(finding({ type: 'system_alert' }), HOST, undefined, null, deps);
  // `requestId` and `findingId` are what tie a panel state back to a log line, and a refusal is a
  // response rather than an error — §5 serves 200 with a labelled state.
  assert.match(res.requestId, /^inv-f-3001-/);
  assert.equal(res.findingId, 'f-3001');
  assert.match(res.investigatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(res.diagnostics.model, null);
  // Null rather than 0: nothing was measured. Same rule as every other `unavailable` (§8.3).
  assert.equal(res.diagnostics.toolCalls, null);
  assert.equal(res.diagnostics.durationMs, null);
});

test('the refusal is logged, so the gate is visible in operation and not only in a test', async () => {
  const lines: string[] = [];
  const { deps } = spyAgent();
  await investigate(finding({ type: 'system_alert' }), HOST, undefined, null, {
    ...deps,
    log: (m) => lines.push(m),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /outside the data boundary/);
});

test('no finding type is both investigable and never-forwarded', () => {
  // The structural half of the fix: the boundary refusal is checked first and is not derived from the
  // allowlist, so adding a third scenario cannot reopen the alert path. If a future change puts a
  // type in both lists, that intent has been lost and this fails rather than the boundary quietly
  // depending on statement order.
  for (const type of NEVER_FORWARDED) {
    assert.ok(!INVESTIGABLE_TYPES.has(type), `${type} is in both lists`);
  }
});
