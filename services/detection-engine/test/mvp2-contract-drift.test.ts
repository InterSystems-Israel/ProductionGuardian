/**
 * MVP 2 contract drift guard — read against the MARKDOWN, because there is no `.d.ts` yet.
 *
 * WHY THIS FILE EXISTS. `contract-drift.test.ts` compares our types to `contracts/healthscan.d.ts`
 * and validates output against `healthscan.schema.json`, and it has held. The four MVP 2 contracts
 * have **neither** — each one says so at the top, and `validate.mjs` does not know these endpoints
 * exist. So the shape they specify was guarded by nothing at all, and a field-name drift in the one
 * object Dev C renders when Approve is refused reached review rather than a test (#92):
 *
 *     ours:      { code: 'out_of_bounds', detail: '...' }
 *     contract:  { reason, message, checkedBy }
 *
 * §5 tells consumers to "render `refusal.message` verbatim" for an unrecognised reason, so the
 * denied banner would have read `undefined`. It type-checked cleanly because the parser CAST the
 * tool's object to a typed shape, and a cast asserts rather than checks.
 *
 * WHAT THIS CAN AND CANNOT DO. Grepping prose for field names is weaker than validating against a
 * schema, and it is deliberately narrow: it pins the field NAMES of the two objects a UI renders,
 * and the closed `reason` set. It does not pin types, nesting, or optionality. When
 * `resolve-api.md` gains a `.schema.json`, this file should be replaced by schema validation
 * rather than extended — a prose grep is a stopgap, and pretending otherwise is how a weak check
 * gets trusted like a strong one.
 *
 * Skipped when `contracts/` is absent, matching ADR 0004: the engine stays buildable standalone.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mockResolveTool } from '../src/detect/agents.ts';
import { resolve as runResolve } from '../src/detect/resolve.ts';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = resolve(serviceRoot, '../../contracts');
const resolveApiPath = resolve(contractsDir, 'resolve-api.md');
const haveContract = existsSync(resolveApiPath);

const ACTION = { type: 'set_pool_size', host: 'Cloud API', size: 4 } as const;

describe('MVP 2 contract drift', { skip: haveContract ? false : 'contracts/ not present' }, () => {
  it('the refusal object uses the contract field names, not ours', async () => {
    const contract = readFileSync(resolveApiPath, 'utf8');

    // Pulled from the contract text rather than hardcoded here -- a copy in this file would be the
    // #84 stale-value pattern, in the very test meant to catch drift.
    for (const field of ['reason', 'message', 'checkedBy']) {
      assert.match(
        contract,
        new RegExp(`"${field}"\\s*:`),
        `resolve-api.md should specify refusal.${field}`,
      );
    }

    // WHAT THIS ASSERTION DOES AND DOES NOT CATCH -- measured, by reintroducing the drift and
    // watching which tests failed. Only ONE of the four did, and it was not this one.
    //
    // `parseRefusal` NORMALISES: it reads each field and substitutes a default when one is absent,
    // so the engine's output carries `reason`/`message`/`checkedBy` no matter what the tool sent.
    // That is right for the engine -- Dev C should never receive a half-shaped refusal -- and it
    // means this assertion pins OUR output contract and cannot see upstream drift at all.
    //
    // Upstream drift surfaces as `reason: "unknown"`, which the next test catches because `unknown`
    // is not a row in §5's table. Recording the division here because a guard whose reach you have
    // not measured is a guard you will over-trust: this one proves the engine never emits `code`,
    // and the next one proves the tool never sends something unrecognised.
    const deps = { callTool: mockResolveTool(1), now: () => 1_760_000_000_000 };
    const refused = await runResolve({ mode: 'apply', action: { ...ACTION, size: 99 } }, deps);
    assert.equal(refused.outcome, 'refused');
    const refusal = refused.refusal as unknown as Record<string, unknown>;
    assert.ok('reason' in refusal, 'refusal must carry reason');
    assert.ok('message' in refusal, 'refusal must carry message');
    assert.ok('checkedBy' in refusal, 'refusal must carry checkedBy');
    assert.ok(!('code' in refusal), 'refusal must NOT carry the retired `code` field');
    assert.ok(!('detail' in refusal), 'refusal must NOT carry the retired `detail` field');
  });

  it('every reason we emit is in the contract table', async () => {
    const contract = readFileSync(resolveApiPath, 'utf8');
    // §5's table treats the reason set as CLOSED. Emitting one that is absent from it is a contract
    // change, not an implementation detail -- so it should fail here rather than reach Dev C as a
    // string they were told to expect from a fixed list.
    const deps = { callTool: mockResolveTool(1), now: () => 1_760_000_000_000 };
    const refused = await runResolve({ mode: 'apply', action: { ...ACTION, size: 99 } }, deps);
    const reason = refused.refusal?.reason ?? '';
    assert.notEqual(reason, '');
    // `unknown` is what parseRefusal substitutes when the tool sends a shape it cannot read, so
    // this doubles as the upstream-drift detector -- and `unknown` is deliberately NOT a row in
    // §5's table, which is what makes the assertion below fail instead of passing vacuously.
    assert.notEqual(reason, 'unknown', 'the tool sent a refusal this engine could not read');
    assert.match(
      contract,
      new RegExp(`\\|\\s*\`${reason}\``),
      `\`${reason}\` is not a row in resolve-api.md §5's reason table`,
    );
  });

  it('a refusal never carries a confirmation, and an apply always does', async () => {
    // §3 + §7. Not a field-name check but the same class of defect: a confirmation on a refusal
    // tells the UI to poll for a clearance that is never coming, and its absence on an applied
    // write loses the only pointer to where the outcome becomes visible.
    const deps = { callTool: mockResolveTool(1), now: () => 1_760_000_000_000 };
    const refused = await runResolve({ mode: 'apply', action: { ...ACTION, size: 99 } }, deps);
    assert.equal(refused.confirmation, null);

    const applied = await runResolve(
      { mode: 'apply', action: ACTION, origin: { findingId: 'f-1' } },
      deps,
    );
    assert.equal(applied.outcome, 'applied');
    assert.equal(applied.confirmation?.status, 'pending');
    // §7: this response is evidence the write landed, not that the condition cleared.
    assert.equal(applied.confirmation?.directEvidence, false);
  });

  it('the contract forbids 403 for not_authorized, and says why', () => {
    const contract = readFileSync(resolveApiPath, 'utf8');
    // Pinned because I broke it: the dispatcher answered 403 for a policy denial, on the reasoning
    // that a refusal is not a server fault. The reasoning is fine; the consequence is that Dev C's
    // client branches on `res.ok`, so a non-2xx becomes a thrown error and a generic banner --
    // and MVP 2 §5.4's acceptance criterion is that the RBAC-denied state is VISIBLE.
    //
    // Asserting the PROSE, not our behaviour, because the behaviour lives in ObjectScript that
    // this suite cannot reach. What this catches is the contract being weakened to permit 403 --
    // at which point the reasoning above needs revisiting rather than silently losing.
    assert.match(contract, /is not `403`/, 'resolve-api.md §5.1 must keep forbidding 403');
    assert.match(
      contract,
      /branches on `res\.ok`/,
      'the reason 403 is forbidden must stay in the contract, not just the rule',
    );
  });
});
