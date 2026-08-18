/**
 * Smart Resolve orchestration tests.
 *
 * THE NEGATIVE CASES ARE THE POINT HERE, more than for any other module in this service. Every
 * other endpoint answers a question wrongly at worst; this one forwards a request that changes a
 * running production. So the tests that matter are the ones proving a malformed request is REFUSED
 * before the tool is reached, and that an unclear outcome is reported as unclear rather than
 * guessed.
 *
 * `CLAUDE.md` §8: "A schema test that only checks valid input proves nothing — prove rejection
 * too." Counted: 14 of the 21 cases below are rejections or failure paths.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseResolveRequest, resolve } from '../src/detect/resolve.ts';
import { mockResolveTool } from '../src/detect/agents.ts';
import type { ResolveDeps } from '../src/detect/resolve.ts';

const ACTION = { type: 'set_pool_size', host: 'Cloud API', size: 4 } as const;

/** A tool stub that records what it was asked and returns a fixed reply. */
function stub(reply: unknown): { deps: ResolveDeps; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    deps: {
      callTool: async (action, dryRun) => {
        calls.push({ action, dryRun });
        return reply;
      },
      now: () => 1_760_000_000_000,
    },
  };
}

// ---------------------------------------------------------------------------
// parseResolveRequest — rejection
// ---------------------------------------------------------------------------

test('parseResolveRequest rejects a non-object body', () => {
  for (const body of [null, undefined, 'apply', 42, []] as unknown[]) {
    // An array IS an object in JS, so it passes the typeof guard and fails on `mode` instead --
    // still rejected, which is what matters, but the message differs. Asserted as "throws" rather
    // than on the message so the test does not pin which guard catches it.
    assert.throws(() => parseResolveRequest(body), /bad request/);
  }
});

test('parseResolveRequest requires mode with NO default', () => {
  // The single most important rejection in this file. A missing mode must not become `apply` (a
  // caller's omission would become a live production write) and must not become `dry_run` (an
  // approval would silently preview and the operator would wonder why nothing happened).
  assert.throws(() => parseResolveRequest({ action: ACTION }), /mode must be/);
  assert.throws(() => parseResolveRequest({ mode: 'APPLY', action: ACTION }), /mode must be/);
  assert.throws(() => parseResolveRequest({ mode: '', action: ACTION }), /mode must be/);
  assert.throws(() => parseResolveRequest({ mode: true, action: ACTION }), /mode must be/);
});

test('parseResolveRequest rejects unknown keys inside action', () => {
  // §1.1. A tolerated extra key is a field somebody believes is being honoured while it is being
  // dropped -- and this object is transcribed into a production write.
  assert.throws(
    () => parseResolveRequest({ mode: 'apply', action: { ...ACTION, force: true } }),
    /unknown key\(s\) \[force\]/,
  );
  assert.throws(
    () => parseResolveRequest({ mode: 'apply', action: { ...ACTION, size2: 9, why: 'x' } }),
    /unknown key\(s\) \[size2, why\]/,
  );
});

test('parseResolveRequest rejects a wrong or missing action type', () => {
  assert.throws(
    () => parseResolveRequest({ mode: 'apply', action: { type: 'restart_host', host: 'Cloud API', size: 4 } }),
    /action\.type must be/,
  );
  assert.throws(
    () => parseResolveRequest({ mode: 'apply', action: { host: 'Cloud API', size: 4 } }),
    /action\.type must be/,
  );
});

test('parseResolveRequest rejects a bad host or size', () => {
  const bad: unknown[] = [
    { type: 'set_pool_size', host: '', size: 4 },
    { type: 'set_pool_size', host: 42, size: 4 },
    { type: 'set_pool_size', size: 4 },
    { type: 'set_pool_size', host: 'Cloud API', size: '4' },
    { type: 'set_pool_size', host: 'Cloud API', size: 4.5 },
    { type: 'set_pool_size', host: 'Cloud API' },
  ];
  for (const action of bad) {
    assert.throws(() => parseResolveRequest({ mode: 'apply', action }), /bad request/);
  }
});

test('parseResolveRequest does NOT bound-check size — the tool does', () => {
  // Deliberate: an out-of-range size parses and is forwarded, and `Tools.Resolve` refuses it with a
  // named code. Rejecting it here too would be harmless, but this test pins WHERE the boundary is,
  // so nobody later reads the parser's acceptance as permission. resolve.ts's header says the same:
  // the validation here is a convenience, not the safety boundary.
  const parsed = parseResolveRequest({ mode: 'apply', action: { ...ACTION, size: 64 } });
  assert.equal(parsed.action.size, 64);
});

// ---------------------------------------------------------------------------
// parseResolveRequest — acceptance
// ---------------------------------------------------------------------------

test('parseResolveRequest keeps only the three action keys', () => {
  const parsed = parseResolveRequest({ mode: 'dry_run', action: ACTION });
  assert.deepEqual(Object.keys(parsed.action).sort(), ['host', 'size', 'type']);
});

test('parseResolveRequest carries optional fields through and drops malformed ones', () => {
  const parsed = parseResolveRequest({
    mode: 'apply',
    action: ACTION,
    requestId: 'req-1',
    requestedBy: 'dev-c',
    origin: { findingId: 'f-1', investigationId: 7 },
    precondition: { poolSize: 1 },
  });
  assert.equal(parsed.requestId, 'req-1');
  assert.equal(parsed.requestedBy, 'dev-c');
  assert.equal(parsed.origin?.findingId, 'f-1');
  // A non-string investigationId is DROPPED rather than coerced to "7". Coercion here is how #58's
  // lastActivity defect happened: a value that looks right and is not what was sent.
  assert.equal(parsed.origin?.investigationId, undefined);
  assert.equal(parsed.precondition?.poolSize, 1);
});

// ---------------------------------------------------------------------------
// resolve() — outcomes
// ---------------------------------------------------------------------------

test('dry_run forwards dryRun=true and returns previewed with no confirmation', async () => {
  const { deps, calls } = stub({
    outcome: 'previewed',
    before: { poolSize: 1 },
    after: { poolSize: 4 },
    reversal: { host: 'Cloud API', size: 1, capturedFrom: 'live production' },
  });
  const res = await resolve({ mode: 'dry_run', action: ACTION }, deps);
  assert.equal((calls[0] as { dryRun: boolean }).dryRun, true);
  assert.equal(res.outcome, 'previewed');
  assert.deepEqual(res.after, { poolSize: 4 });
  // A preview changed nothing, so there is nothing to confirm. A confirmation here would tell the
  // UI to watch for a clearance that is never coming.
  assert.equal(res.confirmation, null);
  assert.equal(res.reversal?.size, 1);
});

test('apply forwards dryRun=false and attaches a PENDING confirmation, not a resolved one', async () => {
  const { deps, calls } = stub({
    outcome: 'applied',
    before: { poolSize: 1 },
    after: { poolSize: 4 },
    reversal: { host: 'Cloud API', size: 1, capturedFrom: 'live production' },
  });
  const res = await resolve(
    { mode: 'apply', action: ACTION, origin: { findingId: 'queue_buildup:Cloud API' } },
    deps,
  );
  assert.equal((calls[0] as { dryRun: boolean }).dryRun, false);
  assert.equal(res.outcome, 'applied');
  assert.equal(res.confirmation?.status, 'pending');
  assert.equal(res.confirmation?.findingId, 'queue_buildup:Cloud API');
  // FALSE, and this is the honest bit: the response is evidence the WRITE landed, not evidence the
  // problem cleared. The queue still has to drain, observed on a later poll (§7).
  assert.equal(res.confirmation?.directEvidence, false);
  assert.equal(res.confirmation?.observeVia, 'GET /api/healthscan/findings');
});

test('a refusal is a NORMAL response carrying the code, not an error', async () => {
  const { deps } = stub({
    outcome: 'refused',
    before: { poolSize: 1 },
    after: null,
    refusal: { code: 'host_not_permitted', detail: 'only Cloud API may be adjusted' },
  });
  // §5.2. A 500 would make "the policy forbids this" indistinguishable from "the production is
  // broken", and the operator's next action differs completely between those two.
  const res = await resolve({ mode: 'apply', action: { ...ACTION, host: 'EMR Source' } }, deps);
  assert.equal(res.outcome, 'refused');
  assert.equal(res.refusal?.code, 'host_not_permitted');
  assert.equal(res.after, null);
  assert.equal(res.confirmation, null);
  assert.equal(res.failure, null);
});

test('no_change gets no confirmation either', async () => {
  const { deps } = stub({
    outcome: 'no_change',
    before: { poolSize: 4 },
    after: { poolSize: 4 },
    reversal: { host: 'Cloud API', size: 4, capturedFrom: 'live production' },
  });
  const res = await resolve({ mode: 'apply', action: ACTION }, deps);
  assert.equal(res.outcome, 'no_change');
  // It was already true; there is no state change to observe clearing.
  assert.equal(res.confirmation, null);
});

// ---------------------------------------------------------------------------
// resolve() — failure honesty
// ---------------------------------------------------------------------------

test('a thrown tool call reports liveStateVerified FALSE', async () => {
  const deps: ResolveDeps = {
    callTool: async () => {
      throw new Error('write tool timed out after 30000ms');
    },
    now: () => 1_760_000_000_000,
  };
  const res = await resolve({ mode: 'apply', action: ACTION }, deps);
  assert.equal(res.outcome, 'failed');
  assert.equal(res.failure?.stage, 'tool_call');
  // THE ASSERTION THIS FILE EXISTS FOR. The call did not come back, so we do not know whether the
  // production changed. Claiming it did not would be a guess, and someone deciding whether to
  // retry an apply needs to know we cannot tell.
  assert.equal(res.failure?.liveStateVerified, false);
  assert.equal(res.before, null);
  assert.equal(res.after, null);
  assert.equal(res.confirmation, null);
});

test('an unrecognised outcome is failed-and-unverified, never assumed', async () => {
  for (const bogus of [undefined, null, 'ok', 'success', 42, {}] as unknown[]) {
    const { deps } = stub({ outcome: bogus, before: { poolSize: 1 } });
    const res = await resolve({ mode: 'apply', action: ACTION }, deps);
    assert.equal(res.outcome, 'failed');
    assert.equal(res.failure?.stage, 'tool_reply');
    assert.equal(res.failure?.liveStateVerified, false);
  }
});

test('a garbage tool reply does not throw', async () => {
  // The endpoint must answer. A reply we cannot read is a `failed` response, not a 500 from an
  // unhandled property access.
  for (const junk of [null, 'nope', 42, []] as unknown[]) {
    const { deps } = stub(junk);
    const res = await resolve({ mode: 'dry_run', action: ACTION }, deps);
    assert.equal(res.outcome, 'failed');
  }
});

test('a non-numeric poolSize in the reply becomes null rather than NaN', async () => {
  const { deps } = stub({
    outcome: 'applied',
    before: { poolSize: '1' },
    after: { poolSize: null },
  });
  const res = await resolve({ mode: 'apply', action: ACTION }, deps);
  // Not `Number('1')`. A coerced number is indistinguishable from a measured one, and `before`
  // feeds the reversal a human would use to undo the change.
  assert.equal(res.before, null);
  assert.equal(res.after, null);
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

test('every response carries the full contract shape', async () => {
  const { deps } = stub({ outcome: 'previewed', before: { poolSize: 1 }, after: { poolSize: 4 } });
  const res = await resolve({ mode: 'dry_run', action: ACTION, requestId: 'r-9' }, deps);
  for (const key of [
    'resolveId',
    'requestId',
    'mode',
    'outcome',
    'action',
    'before',
    'after',
    'reversal',
    'refusal',
    'failure',
    'confirmation',
    'requestedAt',
    'completedAt',
  ]) {
    assert.ok(key in res, `missing ${key}`);
  }
  assert.equal(res.requestId, 'r-9');
  assert.equal(res.mode, 'dry_run');
  // Second-precision ISO with a Z, matching every other timestamp this service publishes.
  assert.match(res.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(res.completedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('requestId is null when the caller omitted one, not invented', async () => {
  const { deps } = stub({ outcome: 'previewed', before: { poolSize: 1 }, after: { poolSize: 4 } });
  const res = await resolve({ mode: 'dry_run', action: ACTION }, deps);
  assert.equal(res.requestId, null);
  // resolveId is ours and always present -- it is what ties this call to the AI Hub audit record.
  assert.match(res.resolveId, /^res-Cloud-API-\d+$/);
});

// ---------------------------------------------------------------------------
// mockResolveTool — the mock must not be easier than the real thing
// ---------------------------------------------------------------------------

test('mockResolveTool: apply then apply gives applied then no_change', async () => {
  const tool = mockResolveTool(1);
  const deps: ResolveDeps = { callTool: tool, now: () => 1_760_000_000_000 };

  const first = await resolve({ mode: 'apply', action: ACTION }, deps);
  assert.equal(first.outcome, 'applied');
  assert.deepEqual(first.after, { poolSize: 4 });

  // Idempotency, matching the real tool. A mock that returned `applied` twice would let Dev C ship
  // an approve button whose double-click path is never exercised -- which a live demo WILL hit.
  const second = await resolve({ mode: 'apply', action: ACTION }, deps);
  assert.equal(second.outcome, 'no_change');
  assert.equal(second.confirmation, null);
});

test('mockResolveTool: a dry run does not move the pool', async () => {
  const tool = mockResolveTool(1);
  const deps: ResolveDeps = { callTool: tool, now: () => 1_760_000_000_000 };
  await resolve({ mode: 'dry_run', action: ACTION }, deps);
  const applied = await resolve({ mode: 'apply', action: ACTION }, deps);
  // before is still 1 -- the preview left it alone.
  assert.deepEqual(applied.before, { poolSize: 1 });
  assert.equal(applied.outcome, 'applied');
});

test('mockResolveTool refuses out-of-bounds like the real tool does', async () => {
  const tool = mockResolveTool(1);
  const deps: ResolveDeps = { callTool: tool, now: () => 1_760_000_000_000 };
  for (const size of [1, 0, -4, 9, 64]) {
    const res = await resolve({ mode: 'apply', action: { ...ACTION, size } }, deps);
    assert.equal(res.outcome, 'refused', `size ${size} should be refused`);
    assert.equal(res.refusal?.code, 'out_of_bounds');
  }
  // 1 is refused specifically because it is the SHIPPED value -- "setting it to 1" is a no-op
  // dressed as a fix, and the real tool's MINSIZE=2 exists for that reason.
});

test('mockResolveTool accepts the whole legal range', async () => {
  for (const size of [2, 3, 4, 5, 6, 7, 8]) {
    const deps: ResolveDeps = { callTool: mockResolveTool(1), now: () => 1_760_000_000_000 };
    const res = await resolve({ mode: 'apply', action: { ...ACTION, size } }, deps);
    assert.equal(res.outcome, 'applied', `size ${size} should apply`);
    assert.deepEqual(res.after, { poolSize: size });
  }
});
