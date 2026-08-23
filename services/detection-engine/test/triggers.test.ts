/**
 * Trigger status parsing — the three-state model as it crosses the process boundary.
 *
 * WHY THIS FILE EXISTS AT ALL. The engine holds no trigger logic (`detect/triggers.ts` header), so
 * for MVP 3 there was nothing here worth a test. `activating` changes that: this parser is the only
 * place a *state model* crosses from IRIS to the browser, and the case most likely to break it —
 * a dispatcher that predates the field — is the one the live stack cannot produce once IRIS is
 * updated. So it is exactly the class `CLAUDE.md` §8 means by "prove rejection too": the negative
 * and legacy shapes are checked, not just the happy one.
 *
 * `parseStatus` is exported for this, the same as `parseResolveRequest` and `parseChatRequest`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseStatus, TRIGGERS_DISABLED } from '../src/detect/triggers.ts';

/** The live payload's shape, trimmed to the fields this parser reads. */
function payload(armed: unknown, activating: unknown): unknown {
  return {
    enabled: true,
    scenarios: [
      { id: 'pool_bottleneck', label: 'Pool bottleneck', detail: 'd', findings: 'queue_buildup' },
    ],
    armed,
    activating,
  };
}

describe('parseStatus — the three states', () => {
  it('carries activating through as its own map, distinct from armed', () => {
    // The pool_bottleneck warm-up window, as the dispatcher reports it: the request landed
    // (`PoolWas` set) and the scenario is not in effect yet (`DispatcherMs` absent).
    const s = parseStatus(payload({ pool_bottleneck: false }, { pool_bottleneck: true }));
    assert.equal(s.armed['pool_bottleneck'], false);
    assert.equal(s.activating['pool_bottleneck'], true);
  });

  it('reports activated as armed and NOT activating', () => {
    // After the warm-up. The two maps must not both read true, or the UI has no way to pick a
    // phase -- and the dispatcher derives `activating` as `requested && !inEffect` for that reason.
    const s = parseStatus(payload({ pool_bottleneck: true }, { pool_bottleneck: false }));
    assert.equal(s.armed['pool_bottleneck'], true);
    assert.equal(s.activating['pool_bottleneck'], false);
  });

  it('reports a scenario that arms atomically as never activating', () => {
    // missing_folder and closed_port witness both states with the same global, so the middle state
    // is false by construction. No special case in the dispatcher, and none needed here.
    const s = parseStatus(payload({ missing_folder: true }, { missing_folder: false }));
    assert.equal(s.armed['missing_folder'], true);
    assert.equal(s.activating['missing_folder'], false);
  });

  it('an absent activating map parses to {}, not to a crash or a disabled rail', () => {
    // A dispatcher predating this change. Every scenario then reads not-activating, which is the
    // pre-#135 two-state behaviour -- degrading to the old UI is correct; hiding the buttons is not.
    const raw = { enabled: true, scenarios: [], armed: { closed_port: true } };
    const s = parseStatus(raw);
    assert.equal(s.enabled, true);
    assert.deepEqual(s.activating, {});
    assert.equal(s.armed['closed_port'], true);
  });

  it('a non-boolean in either map is dropped, never coerced to true', () => {
    // Both maps make claims about a live production and one of them refuses a click, so a garbled
    // value must not read as "in that state". Dropping the key means "no", which is the safe answer
    // to a witness we could not read.
    const s = parseStatus(
      payload(
        { pool_bottleneck: 'true', closed_port: 1, missing_folder: true },
        { pool_bottleneck: null, closed_port: 'yes' },
      ),
    );
    assert.equal('pool_bottleneck' in s.armed, false);
    assert.equal('closed_port' in s.armed, false);
    assert.equal(s.armed['missing_folder'], true);
    assert.deepEqual(s.activating, {});
  });

  it('a garbled activating map cannot make a button behave differently from a garbled armed map', () => {
    // The two maps share one parser precisely so this holds. Asserted rather than left to code
    // reading, because the previous version had the `armed` loop written out inline and a second
    // copy for `activating` would have been the obvious way to add it.
    const bad = { nope: 'x', also: [], nested: {} };
    const s = parseStatus(payload(bad, bad));
    assert.deepEqual(s.armed, s.activating);
    assert.deepEqual(s.armed, {});
  });

  it('enabled must be explicitly true, and the off payload carries both maps', () => {
    // A garbled reply cannot switch the buttons on. And TRIGGERS_DISABLED is what api/server.ts
    // now serves for its two off-state branches, so it has to satisfy the full interface -- it was
    // two inline literals that would have been silently short the new field.
    assert.deepEqual(parseStatus({ enabled: 'true', scenarios: [] }), TRIGGERS_DISABLED);
    assert.deepEqual(parseStatus(null), TRIGGERS_DISABLED);
    assert.deepEqual(TRIGGERS_DISABLED.activating, {});
  });

  it('a malformed scenario is skipped rather than rejecting the payload', () => {
    // Pre-existing behaviour, pinned here because this file is now the parser's test: one bad
    // scenario must not remove the reset button, which is the one that recovers from everything.
    const s = parseStatus({
      enabled: true,
      scenarios: [{ id: '', label: 'nameless' }, { id: 'closed_port', label: 'Downstream' }],
      armed: {},
      activating: {},
    });
    assert.equal(s.scenarios.length, 1);
    assert.equal(s.scenarios[0]?.id, 'closed_port');
  });
});
