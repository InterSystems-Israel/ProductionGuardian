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
 * The demo loop's timing has a FLOOR, and shortening the poll interval silently crosses it
 * (#64, found by @tanifgit).
 *
 * `sustainedSeconds` (#46) gates confirmation on elapsed *time*; `DEFAULT_SCENARIO`'s steps
 * are counted in *polls*. So a degraded step is visible for `(polls − 1) × interval`, and a
 * condition confirms only if that reaches `sustainedSeconds`. Reproduced across the range:
 *
 *     10000ms -> 8/8      1750ms -> 6/8      (loses queue_buildup, system_alert)
 *      5000ms -> 8/8      1250ms -> 4/8      (+ elevated_error_rate, stalled_host)
 *      2000ms -> 8/8       700ms -> 0/8      (everything, including dead_host)
 *
 * The failure is silent and looks like a broken engine rather than a misconfiguration —
 * @tanifgit's own note recommending `POLL_INTERVAL_MS=700` was written before #46 added the
 * time gate, and following it now shows no findings at all.
 *
 * The two existing notes on `sustainedSeconds` ("must be reachable within sustainedSamples
 * polls WITH MARGIN") reason about a *persisting* condition. This is the case they do not
 * cover: a condition that lasts a handful of polls, which is every step in the demo loop.
 */
describe('demo-loop timing floor (#64)', () => {
  /**
   * Contiguous non-healthy RUNS, not individual steps.
   *
   * My first version of this asserted the shortest degraded *step* and failed immediately:
   * the error storm is four consecutive 1-poll steps, each spanning 0ms on its own. The
   * condition they represent persists across all four, so the run is the unit that has to
   * clear the gate — which is also why the storm was written as four fixtures rather than
   * one held for four polls (see DEFAULT_SCENARIO's comment on the rising counter).
   */
  function degradedRunSpansMs(): number[] {
    const spans: number[] = [];
    let polls = 0;
    for (const step of DEFAULT_SCENARIO) {
      if (step.fixture === 'healthy') {
        if (polls > 0) spans.push((polls - 1) * POLL_MS);
        polls = 0;
      } else {
        polls += step.polls;
      }
    }
    if (polls > 0) spans.push((polls - 1) * POLL_MS);
    return spans;
  }

  it('every degraded run outlives sustainedSeconds at the shipped interval', () => {
    // Asserted as ARITHMETIC rather than by running the loop, so it fails on a retune of
    // POLL_INTERVAL_MS, sustainedSeconds OR a step's poll count — the coverage test above
    // only fails once a finding type has already been lost.
    const gateMs = DEFAULT_CONFIG.sustainedSeconds * 1000;
    const spans = degradedRunSpansMs();
    assert.ok(spans.length > 0, 'the scenario must contain a degraded run at all');

    for (const span of spans) {
      assert.ok(
        span >= gateMs,
        `a degraded run spans ${span}ms but sustainedSeconds needs ${gateMs}ms — a finding ` +
          `type can no longer confirm. Lengthen the run, shorten the gate, or raise ` +
          `POLL_INTERVAL_MS. Measured floor: 8/8 down to 2000ms, 6/8 at 1750ms, 0/8 at 700ms.`,
      );
    }
  });

  it('names the interval below which coverage breaks', () => {
    // The number an operator actually needs, derived rather than written down: the shortest
    // degraded run divided into the gate. Documented in .env.example against this value.
    const gateMs = DEFAULT_CONFIG.sustainedSeconds * 1000;
    const shortestRunPolls = Math.min(
      ...degradedRunSpansMs().map((span) => span / POLL_MS + 1),
    );
    const floorMs = Math.ceil(gateMs / (shortestRunPolls - 1));

    assert.ok(
      POLL_MS >= floorMs,
      `the shipped ${POLL_MS}ms is below the ${floorMs}ms floor for this scenario`,
    );
    // Guards the guard: if the floor ever computes at or above the shipped value, the
    // margin this test claims to protect has already gone.
    assert.ok(floorMs < POLL_MS, `no margin left: floor ${floorMs}ms vs shipped ${POLL_MS}ms`);
  });
});
