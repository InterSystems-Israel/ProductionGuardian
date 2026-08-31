/**
 * `recommendedAction` parsing — contract §3.3, and specifically the before-value (#178).
 *
 * WHAT MAKES THIS WORTH ITS OWN FILE. `summary` is the label on the control that authorises a write
 * to a live production, and §3.3 says it is authoritative and must be rendered as-is. So a defect in
 * this one string is a defect an operator reads and acts on, and it shipped: `currentValue` was null
 * on every investigation and the summary rendered
 *
 *     increase Cloud API pool ? -> 8
 *
 * A question mark, on the before-value, next to an approve button. Not an edge case — `index.ts`
 * passes the authoritative slot as a literal `null` on purpose (this service holds no production
 * config), so it was every investigation that recommended anything.
 *
 * THE ASSERTION THAT MATTERS MOST IS A NEGATIVE ONE: no summary may contain `?`, whatever the reply
 * looked like. Asserting the happy path only would have passed before the fix too, because the happy
 * path was never the one that ran.
 *
 * The second theme is that a model-supplied number is TRANSCRIBED, not trusted: it is validated, the
 * authoritative slot outranks it, and a claim that is not a positive integer is dropped rather than
 * coerced. `0` from a model means "I did not read it" far more often than it means an empty pool.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { investigate } from '../src/detect/investigate.ts';
import type { Finding, Host } from '../src/types/healthscan.ts';

const HOST: Host = {
  host: 'Cloud API',
  type: 'operation',
  status: 'OK',
  queued: 486,
  messagesPerSec: 4,
  errored: 0,
  avgProcessingTime: 1.01,
  avgQueueingTime: 12,
  lastActivity: '2026-08-31T10:00:00Z',
};

const FINDING: Finding = {
  id: 'f-3001',
  host: 'Cloud API',
  type: 'queue_buildup',
  severity: 'critical',
  currentValue: 486,
  baselineValue: 0,
  detectedAt: '2026-08-31T10:00:00Z',
  message: 'Queue depth 486 is over the floor of 50',
};

/** An agent that returns exactly the reply given, so the parser is what is under test. */
function replyWith(reply: unknown) {
  return {
    callAgent: async () => reply,
    source: 'canned' as const,
    now: () => 1_760_000_000_000,
  };
}

/** A whole reply whose `recommendedAction` carries whatever is passed in. */
function reply(recommendedAction: unknown) {
  return {
    rootCause: 'Cloud API cannot keep up with inbound volume.',
    evidence: [],
    confidence: 0.8,
    recommendedAction,
    manualRemediation: null,
  };
}

const ACTION = { type: 'set_pool_size', host: 'Cloud API', size: 8 };

/** `investigate` with no authoritative pool size, which is what `index.ts` actually passes. */
async function withoutAuthoritative(recommendedAction: unknown) {
  return investigate(FINDING, HOST, undefined, null, replyWith(reply(recommendedAction)));
}

test('the agent-reported before-value reaches the summary', async () => {
  const res = await withoutAuthoritative({ action: ACTION, currentValue: 4 });
  assert.equal(res.recommendedAction?.currentValue, 4);
  assert.equal(res.recommendedAction?.summary, 'increase Cloud API pool 4 -> 8');
});

test('inside `action` is accepted too — the model may put it either place', async () => {
  /* The prompt asks for it beside the action, because `action` travels verbatim to the write tool.
     A model that nests it anyway has still read the value, and discarding it over placement would
     reintroduce the defect for a reason the operator cannot see. */
  const res = await withoutAuthoritative({ action: { ...ACTION, currentValue: 4 } });
  assert.equal(res.recommendedAction?.currentValue, 4);
});

test('an absent before-value is OMITTED, never rendered as a placeholder', async () => {
  const res = await withoutAuthoritative({ action: ACTION });
  assert.equal(res.recommendedAction?.currentValue, null, 'unknown stays null, not 0');
  assert.equal(res.recommendedAction?.summary, 'increase Cloud API pool to 8');
});

test('NO summary contains a question mark, whatever the reply carried', async () => {
  // The regression itself. Every shape that reaches the summary builder, in one assertion.
  for (const ra of [
    { action: ACTION },
    { action: ACTION, currentValue: null },
    { action: ACTION, currentValue: 'four' },
    { action: ACTION, currentValue: 0 },
    { action: ACTION, currentValue: -2 },
    { action: ACTION, currentValue: 2.5 },
    { action: ACTION, currentValue: 4 },
  ]) {
    const res = await withoutAuthoritative(ra);
    const summary = res.recommendedAction?.summary ?? '';
    assert.ok(summary !== '', `expected an action for ${JSON.stringify(ra)}`);
    assert.ok(
      !summary.includes('?'),
      `summary must never show a placeholder, got: ${summary}`,
    );
  }
});

test('a claim that is not a positive integer is dropped rather than coerced', async () => {
  for (const bad of ['four', 0, -2, 2.5, null, {}, []]) {
    const res = await withoutAuthoritative({ action: ACTION, currentValue: bad });
    assert.equal(
      res.recommendedAction?.currentValue,
      null,
      `${JSON.stringify(bad)} must not become a before-value`,
    );
  }
});

test('the authoritative slot outranks the model, because one is read and one is transcribed', async () => {
  const res = await investigate(
    FINDING,
    HOST,
    undefined,
    3,
    replyWith(reply({ action: ACTION, currentValue: 4 })),
  );
  assert.equal(res.recommendedAction?.currentValue, 3, 'the caller-supplied value must win');
  assert.equal(res.recommendedAction?.summary, 'increase Cloud API pool 3 -> 8');
});

test('a before-value BELOW the action bounds is kept — LABDEMO ships pool 1', async () => {
  /* `BOUNDS` (2..8) constrain the TARGET of a write. `Cloud API` ships at PoolSize 1, so validating
     the current value against them would discard the true value in the shipped configuration and
     put the placeholder back on the flagship scenario. */
  const res = await withoutAuthoritative({ action: ACTION, currentValue: 1 });
  assert.equal(res.recommendedAction?.currentValue, 1);
  assert.equal(res.recommendedAction?.summary, 'increase Cloud API pool 1 -> 8');
});

test('the forwarded action carries only what the write tool takes', async () => {
  /* A shape invariant, not a value: `action` travels verbatim to `POST /api/resolve`, whose tool
     argument list is `{host, size}`. If the before-value leaked in here it would be forwarded to a
     tool that does not accept it. */
  const res = await withoutAuthoritative({ action: { ...ACTION, currentValue: 4 } });
  assert.deepEqual(Object.keys(res.recommendedAction?.action ?? {}).sort(), [
    'host',
    'size',
    'type',
  ]);
});

test('reversible stays true with no before-value, because the reversal is captured at apply time', async () => {
  /* `resolve()` builds `reversal` from the write tool's own `before`, so reversibility does not
     depend on this field. Pinned because §3.3 defines the flag against `currentValue`, and the
     tempting "fix" is to flip it to false — which would tell an operator a reversible change is
     not. */
  const res = await withoutAuthoritative({ action: ACTION });
  assert.equal(res.recommendedAction?.currentValue, null);
  assert.equal(res.recommendedAction?.reversible, true);
  assert.equal(res.recommendedAction?.requiresApproval, true);
});
