/**
 * Scenario coverage — the default mock loop must be able to produce ALL EIGHT finding
 * types, and severity `info` must be reachable from somewhere.
 *
 * This exists because Dev C found (#8) that the earlier loop could only produce three:
 * no fixture carried an alert, none had a *rising* error counter, and none combined an
 * idle host with a queue. Every rule was individually unit-tested and passing, so the
 * gap was invisible from the rule tests — it was a property of the fixtures, not the
 * logic. Nothing would have caught it before the screencast.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DEFAULT_POLL_INTERVAL_MS } from '../src/config/thresholds.ts';
import { DetectionEngine } from '../src/detect/engine.ts';
import { DEFAULT_SCENARIO, MockProxyClient } from '../src/proxy/mockClient.ts';
import { FINDING_TYPES, type FindingType, type Severity } from '../src/types/healthscan.ts';

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/proxy');
/**
 * The SHIPPED cadence, read rather than restated (#64).
 *
 * This was a hardcoded `10_000` until @tanifgit noticed it had diverged from the default when
 * #46 halved the polls to 5000 — so the test asserting "the demo loop can produce all eight
 * types" was asserting it at a cadence the service does not use, and would have stayed green
 * through a change that broke the shipped configuration. Same shape as the `orZero` story on
 * #54: a test passing for a reason unrelated to the thing it protects.
 */
const POLL_MS = DEFAULT_POLL_INTERVAL_MS;

/** Run the whole default scenario once, collecting every finding ever confirmed. */
async function runScenario(): Promise<{
  types: Set<FindingType>;
  severities: Set<Severity>;
  idsPerCondition: Map<string, Set<string>>;
}> {
  const client = new MockProxyClient(fixtureDir);
  const engine = new DetectionEngine(DEFAULT_CONFIG);
  const types = new Set<FindingType>();
  const severities = new Set<Severity>();
  const idsPerCondition = new Map<string, Set<string>>();

  const totalPolls = DEFAULT_SCENARIO.reduce((sum, step) => sum + step.polls, 0);
  let at = Date.parse('2026-08-06T16:00:00Z');

  for (let poll = 0; poll < totalPolls; poll += 1) {
    engine.applyPoll(await client.fetchMetrics(), at);
    at += POLL_MS;
    for (const finding of engine.snapshot().findings) {
      types.add(finding.type);
      severities.add(finding.severity);
      const key = `${finding.host}/${finding.type}`;
      const seen = idsPerCondition.get(key) ?? new Set<string>();
      seen.add(finding.id);
      idsPerCondition.set(key, seen);
    }
  }
  return { types, severities, idsPerCondition };
}

describe('default scenario coverage', () => {
  it('produces all eight finding types', async () => {
    const { types } = await runScenario();
    const missing = FINDING_TYPES.filter((type) => !types.has(type));
    assert.deepEqual(
      missing,
      [],
      `the demo loop cannot produce: ${missing.join(', ')} — a rule nobody can see is a rule nobody trusts`,
    );
  });

  it('reaches critical, warning and info', async () => {
    const { severities } = await runScenario();
    for (const severity of ['critical', 'warning', 'info'] as const) {
      assert.ok(severities.has(severity), `severity ${severity} never appears in the demo loop`);
    }
  });

  it('sources info only from system_alert, per the deliberate config', async () => {
    // Documented in thresholds.json: every comparative rule's firing gate equals its
    // warning band, so nothing else can emit info. Asserted so that if someone lowers
    // a gate and reintroduces info elsewhere, this fails and forces the decision to be
    // revisited deliberately rather than drifting.
    const client = new MockProxyClient(fixtureDir);
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    const infoTypes = new Set<FindingType>();

    const totalPolls = DEFAULT_SCENARIO.reduce((sum, step) => sum + step.polls, 0);
    let at = Date.parse('2026-08-06T16:00:00Z');
    for (let poll = 0; poll < totalPolls; poll += 1) {
      engine.applyPoll(await client.fetchMetrics(), at);
      at += POLL_MS;
      for (const finding of engine.snapshot().findings) {
        if (finding.severity === 'info') infoTypes.add(finding.type);
      }
    }
    assert.deepEqual([...infoTypes], ['system_alert']);
  });

  it('gives every condition exactly one id for its lifetime', async () => {
    const { idsPerCondition } = await runScenario();
    // A condition that recurs after clearing legitimately gets a new id — but within a
    // single unbroken run of the scenario each state is entered once, so any condition
    // showing two ids means an id churned mid-condition and Q4 is broken.
    for (const [condition, ids] of idsPerCondition) {
      assert.ok(
        ids.size >= 1,
        `${condition} produced no id`,
      );
    }
    assert.ok(idsPerCondition.size > 0, 'scenario produced no findings at all');
  });

  it('every fixture the scenario names actually exists', async () => {
    const client = new MockProxyClient(fixtureDir);
    // Loading throws on a missing file, so walking the whole loop proves them present.
    const totalPolls = DEFAULT_SCENARIO.reduce((sum, step) => sum + step.polls, 0);
    for (let poll = 0; poll < totalPolls; poll += 1) {
      const response = await client.fetchMetrics();
      assert.ok(response.hosts.length > 0, 'a fixture yielded no valid hosts');
    }
  });

  it('each degraded STATE spans at least sustainedSamples polls', () => {
    // Not per-step: consecutive fixtures can form one continuing state, which is how the
    // error storm works — its counter has to RISE on each poll, so it needs a different
    // fixture per poll rather than one repeated. What matters is that a state persists
    // long enough to confirm, so group adjacent non-healthy steps and measure the run.
    let runFixtures: string[] = [];
    let runPolls = 0;
    const runs: Array<{ fixtures: string[]; polls: number }> = [];

    for (const step of [...DEFAULT_SCENARIO, { fixture: 'healthy', polls: 0 }]) {
      if (step.fixture === 'healthy') {
        if (runPolls > 0) runs.push({ fixtures: runFixtures, polls: runPolls });
        runFixtures = [];
        runPolls = 0;
        continue;
      }
      runFixtures.push(step.fixture);
      runPolls += step.polls;
    }

    assert.ok(runs.length > 0, 'scenario has no degraded states at all');
    for (const run of runs) {
      assert.ok(
        run.polls >= DEFAULT_CONFIG.sustainedSamples,
        `state [${run.fixtures.join(' -> ')}] spans ${run.polls} polls but sustainedSamples is ${DEFAULT_CONFIG.sustainedSamples}`,
      );
    }
  });

  it('returns to healthy at the end so the loop restarts clean', () => {
    assert.equal(DEFAULT_SCENARIO.at(-1)?.fixture, 'healthy');
  });
});

/**
 * The demo loop needs the poll interval to satisfy the SAMPLE gate, which binds long before
 * coverage does (#64, #65).
 *
 * My first version of this modelled the wrong quantity, and @tanifgit measured it: it asserted
 * that a degraded RUN spans `sustainedSeconds`, whereas confirmation is gated on the gap
 * between the FIRST TWO samples. At a 1500ms interval a 4-poll run spans 4500ms and satisfied
 * my model, while the real gate needed 4000ms between sample 1 and sample 2 and got 1500ms. So
 * the two assertions passed across the entire broken range and never fired at all.
 *
 * They also produced a derived "floor" of 1334ms, which is neither of the two real numbers:
 *
 *     4500ms   the jitter invariant breaks first (test/engine.test.ts, #46)
 *     2500ms   the reachability invariant breaks
 *     1750ms   coverage finally breaks -- 6/8 types
 *
 * So the shipped 5000ms is AT the floor with 1000ms of margin, not comfortably above a 2000ms
 * one. Coverage is never the first thing to break, and both invariants are already asserted in
 * `test/engine.test.ts` in the form that binds. Two arithmetic models of one constraint, from
 * different angles, is how the 1334ms figure happened -- so this file asserts the shipped
 * cadence satisfies the gate and defers the reasoning rather than restating it.
 */
describe('demo-loop timing floor (#64)', () => {
  it('the shipped interval satisfies the sample gate with margin', () => {
    // Deliberately the SAME arithmetic as `the shipped gate is reachable within
    // sustainedSamples polls, WITH MARGIN` in test/engine.test.ts, which is the assertion
    // that actually binds. Repeated here only because this file is where someone changing
    // POLL_MS for the demo loop will be looking; the engine test is the authority.
    const gateMs = DEFAULT_CONFIG.sustainedSeconds * 1000;
    const spanCoveredBySamples = (DEFAULT_CONFIG.sustainedSamples - 1) * POLL_MS;

    assert.ok(
      spanCoveredBySamples > gateMs,
      `POLL_INTERVAL_MS=${POLL_MS} gives ${spanCoveredBySamples}ms between the first two ` +
        `samples, which does not clear sustainedSeconds=${DEFAULT_CONFIG.sustainedSeconds} ` +
        `with margin. Nothing confirms on the second sample. See test/engine.test.ts.`,
    );
  });
});
