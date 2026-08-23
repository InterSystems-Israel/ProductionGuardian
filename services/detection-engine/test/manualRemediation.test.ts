/**
 * `manualRemediation` parsing — contract §3.3a, MVP 3.
 *
 * THE NEGATIVE CASES ARE THE POINT. This field reaches a human who then changes a live production
 * **by hand**, outside anything the product can audit or reverse. A half-parsed remediation is worse
 * than none: "create the directory" with no path, or a step list the model returned as a single
 * string, is something an operator follows and gets wrong. So the parser drops anything that is not
 * whole, and 11 of the 15 cases below assert exactly that.
 *
 * The other thing being tested is a **shape invariant rather than a value**: `manualRemediation`
 * carries no `action`, so nothing downstream can send it to `POST /api/resolve`. That is what makes
 * an approve control unrepresentable rather than merely discouraged, and it is worth an assertion
 * because it is the property the two-shape design was chosen for.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { investigate } from '../src/detect/investigate.ts';
import { mockAgent, mockMissingFolderAgent } from '../src/detect/agents.ts';
import type { Finding, Host } from '../src/types/healthscan.ts';

const HOST: Host = {
  host: 'EMR Source',
  type: 'service',
  status: 'Error',
  queued: 0,
  messagesPerSec: 0,
  errored: 8,
  // Both non-nullable on `Host` (unlike `queued`/`errored`), so a stopped service reports 0 rather
  // than "not measurable". Checked the type rather than widening it to fit this fixture.
  avgProcessingTime: 0,
  avgQueueingTime: 0,
  lastActivity: '2026-08-20T10:00:00Z',
};

const FINDING: Finding = {
  id: 'f-2001',
  host: 'EMR Source',
  type: 'dead_host',
  severity: 'critical',
  // `Finding.currentValue` is `number`, not nullable -- `dead_host` is an absolute rule, so 0 is the
  // measured value rather than an absent one.
  currentValue: 0,
  baselineValue: null,
  detectedAt: '2026-08-20T10:00:00Z',
  message: 'EMR Source is in Error',
};

/** An agent that returns exactly the reply given, so the parser is what is under test. */
function replyWith(reply: unknown) {
  return {
    callAgent: async () => reply,
    source: 'canned' as const,
    now: () => 1_760_000_000_000,
  };
}

const WHOLE = {
  rootCause: 'EMR Source polls a directory that does not exist.',
  evidence: [],
  confidence: 0.9,
  recommendedAction: null,
  manualRemediation: {
    summary: 'EMR Source polls a directory that does not exist',
    steps: ['Create /tmp/labdemo/hl7-in/ on the IRIS host', 'or repoint FilePath'],
    target: { host: 'EMR Source', setting: 'FilePath', currentValue: '/tmp/labdemo/hl7-in-missing/' },
    appliedBy: 'operator',
  },
};

// ---------------------------------------------------------------------------
// Accepted
// ---------------------------------------------------------------------------

test('a whole manualRemediation is served, with no recommendedAction beside it', async () => {
  const res = await investigate(FINDING, HOST, undefined, null, replyWith(WHOLE));
  assert.equal(res.state, 'complete');
  assert.equal(res.recommendedAction, null);
  assert.equal(res.manualRemediation?.summary, WHOLE.manualRemediation.summary);
  assert.deepEqual(res.manualRemediation?.steps, WHOLE.manualRemediation.steps);
  assert.equal(res.manualRemediation?.target?.setting, 'FilePath');
});

test('THE SHAPE INVARIANT: manualRemediation carries no action, so it cannot be POSTed to resolve', async () => {
  /* The whole reason §3.3a is a separate field rather than a flag. A consumer cannot bind an approve
     control to this, because there is nothing to send -- so the wrong UI is unrepresentable rather
     than forbidden by a comment. Asserted because it is the property the design was chosen for, and
     a future "convenience" that added an `action` here would pass every other test in this file. */
  const res = await investigate(FINDING, HOST, undefined, null, replyWith(WHOLE));
  const manual = res.manualRemediation as unknown as Record<string, unknown>;
  assert.ok(!('action' in manual), 'manualRemediation must never carry an action object');
  assert.deepEqual(Object.keys(manual).sort(), ['appliedBy', 'steps', 'summary', 'target']);
});

test('appliedBy is SET, not read — a model cannot assert "system"', async () => {
  /* Autonomous remediation is the one thing root CLAUDE.md §2.1 forbids outright. If `appliedBy` were
     read from the reply, a model could claim the system will do it, and a UI trusting the field would
     say so. It is fixed here, so the reply's value is irrelevant. */
  const res = await investigate(
    FINDING,
    HOST,
    undefined,
    null,
    replyWith({ ...WHOLE, manualRemediation: { ...WHOLE.manualRemediation, appliedBy: 'system' } }),
  );
  assert.equal(res.manualRemediation?.appliedBy, 'operator');
});

test('a null target is kept — the agent may not identify what to change', async () => {
  const res = await investigate(
    FINDING,
    HOST,
    undefined,
    null,
    replyWith({ ...WHOLE, manualRemediation: { ...WHOLE.manualRemediation, target: null } }),
  );
  assert.equal(res.manualRemediation?.target, null);
  // Still served: the steps are useful without a machine-readable target.
  assert.ok((res.manualRemediation?.steps.length ?? 0) > 0);
});

test('both null is a valid complete investigation, not an error', async () => {
  // §3.1: the agent explained the condition and recommended nothing. Must render as "no recommended
  // action", never as a failure.
  const res = await investigate(
    FINDING,
    HOST,
    undefined,
    null,
    replyWith({ ...WHOLE, recommendedAction: null, manualRemediation: null }),
  );
  assert.equal(res.state, 'complete');
  assert.equal(res.recommendedAction, null);
  assert.equal(res.manualRemediation, null);
  assert.ok((res.rootCause?.length ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// Dropped — a partial remediation is worse than none
// ---------------------------------------------------------------------------

test('a remediation with no steps is dropped', async () => {
  for (const steps of [[], undefined, null, 'create the directory', [''], [123]] as unknown[]) {
    const res = await investigate(
      FINDING,
      HOST,
      undefined,
      null,
      replyWith({ ...WHOLE, manualRemediation: { ...WHOLE.manualRemediation, steps } }),
    );
    assert.equal(
      res.manualRemediation,
      null,
      `steps ${JSON.stringify(steps)} should drop the whole object`,
    );
  }
});

test('a remediation with no summary is dropped — the steps would have no heading', async () => {
  for (const summary of ['', '   ', undefined, null, 42] as unknown[]) {
    const res = await investigate(
      FINDING,
      HOST,
      undefined,
      null,
      replyWith({ ...WHOLE, manualRemediation: { ...WHOLE.manualRemediation, summary } }),
    );
    assert.equal(res.manualRemediation, null);
  }
});

test('non-string steps are filtered, and the rest is kept', async () => {
  // A model returning a mixed array is a partial reply, not a corrupt one: the string steps are
  // still verbatim instructions. Dropping only the unusable entries beats discarding all of them.
  const res = await investigate(
    FINDING,
    HOST,
    undefined,
    null,
    replyWith({
      ...WHOLE,
      manualRemediation: { ...WHOLE.manualRemediation, steps: ['create it', 42, null, 'or repoint'] },
    }),
  );
  assert.deepEqual(res.manualRemediation?.steps, ['create it', 'or repoint']);
});

test('a target missing host or setting becomes null rather than a half-target', async () => {
  for (const target of [
    { setting: 'FilePath', currentValue: '/x' },
    { host: 'EMR Source', currentValue: '/x' },
    { host: '', setting: 'FilePath', currentValue: '/x' },
    'FilePath',
    42,
  ] as unknown[]) {
    const res = await investigate(
      FINDING,
      HOST,
      undefined,
      null,
      replyWith({ ...WHOLE, manualRemediation: { ...WHOLE.manualRemediation, target } }),
    );
    // The remediation survives -- the steps are the actionable part -- but the target does not.
    assert.ok(res.manualRemediation !== null, 'the remediation itself should survive');
    assert.equal(res.manualRemediation?.target, null);
  }
});

test('THE DATA BOUNDARY: an extra key on target is discarded, not forwarded', async () => {
  /* `target` is built from an allowlist of three keys rather than a spread. A model that returned
     `messageBody` alongside `setting` would otherwise put payload content into a response that leaves
     the instance -- root CLAUDE.md §2.1's rule, enforced here rather than trusted. */
  const res = await investigate(
    FINDING,
    HOST,
    undefined,
    null,
    replyWith({
      ...WHOLE,
      manualRemediation: {
        ...WHOLE.manualRemediation,
        target: {
          host: 'EMR Source',
          setting: 'FilePath',
          currentValue: '/x',
          messageBody: 'PID|1||12345||DOE^JOHN',
        },
      },
    }),
  );
  const target = res.manualRemediation?.target as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(target).sort(), ['currentValue', 'host', 'setting']);
  assert.ok(!('messageBody' in target));
});

test('a non-object manualRemediation is dropped', async () => {
  for (const manualRemediation of ['create the directory', 42, [], true] as unknown[]) {
    const res = await investigate(
      FINDING,
      HOST,
      undefined,
      null,
      replyWith({ ...WHOLE, manualRemediation }),
    );
    assert.equal(res.manualRemediation, null);
  }
});

test('an absent manualRemediation is null, not undefined', async () => {
  // MVP 2 replies have no such field. `null` rather than `undefined` so the response shape is the
  // same either way and JSON.stringify does not silently omit the key.
  const { manualRemediation: _omit, ...withoutField } = WHOLE;
  const res = await investigate(FINDING, HOST, undefined, null, replyWith(withoutField));
  assert.equal(res.manualRemediation, null);
  assert.ok('manualRemediation' in res);
});

// ---------------------------------------------------------------------------
// The two canned agents
// ---------------------------------------------------------------------------

test('mockMissingFolderAgent yields a manual remediation and NO recommendedAction', async () => {
  const res = await investigate(FINDING, HOST, undefined, null, {
    callAgent: mockMissingFolderAgent(),
    source: 'canned',
    now: () => 1_760_000_000_000,
  });
  assert.equal(res.state, 'complete');
  assert.equal(res.source, 'canned');
  assert.equal(res.recommendedAction, null, 'this scenario has no governed action');
  assert.ok(res.manualRemediation !== null);
  assert.equal(res.manualRemediation?.target?.setting, 'FilePath');
  // Every evidence bullet is tool-sourced: the path comes from configuration, never from a log row.
  assert.ok(res.evidence.every((e) => e.source === 'mcp_tool'));
});

test('mockAgent (pool bottleneck) yields the reverse — an action and no manual remediation', async () => {
  /* The two mocks are separate functions so "emits both" is unreachable. Asserted from both sides,
     because the invariant is about the pair rather than either one. */
  const poolFinding: Finding = { ...FINDING, host: 'Cloud API', type: 'queue_buildup', currentValue: 486 };
  const poolHost: Host = { ...HOST, host: 'Cloud API', status: 'OK', queued: 486 };
  const res = await investigate(poolFinding, poolHost, undefined, 1, {
    callAgent: mockAgent(),
    source: 'canned',
    now: () => 1_760_000_000_000,
  });
  assert.ok(res.recommendedAction !== null, 'the pool scenario has a governed action');
  assert.equal(res.manualRemediation, null);
});
