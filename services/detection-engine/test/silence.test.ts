/**
 * The reverse direction: what the engine must NOT say, and what it must not stop saying.
 *
 * `scenario.test.ts` asserts every finding type *can* appear. Every assertion in it points
 * the same way, which is the blind spot Dev C named on #20 — a check that only looks for
 * presence cannot see an omission. Their `validate-fixture-claims.mjs` had the mirror-image
 * gap and they closed it in #22; this closes ours.
 *
 * Two questions neither suite was asking:
 *
 *   1. Does a HEALTHY fixture stay silent, held indefinitely? A false finding on a healthy
 *      production is the most damaging thing this product can do on stage, and MVP §6 names
 *      false positives as the top risk.
 *   2. Does a fixture that depicts a problem KEEP reporting it? Baseline self-inflation
 *      (ADR 0002, CLAUDE.md §5.1) means a comparative finding can clear while the bad value
 *      persists — so a demo state can go quiet mid-demonstration.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateConfig, type ThresholdConfig } from '../src/config/thresholds.ts';
import { DetectionEngine } from '../src/detect/engine.ts';
import { MockProxyClient, type ScenarioStep } from '../src/proxy/mockClient.ts';
import type { Finding } from '../src/types/healthscan.ts';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = resolve(serviceRoot, 'fixtures/proxy');
const POLL_MS = 10_000;

/** The real committed config, not DEFAULT_CONFIG — the tuned floors are the point. */
const CONFIG: ThresholdConfig = validateConfig(
  JSON.parse(readFileSync(resolve(serviceRoot, 'thresholds.json'), 'utf8')),
);

/** Run a step list and return the findings visible after each poll. */
async function pollSeries(steps: ScenarioStep[]): Promise<Finding[][]> {
  const client = new MockProxyClient(fixtureDir, steps);
  const engine = new DetectionEngine(CONFIG);
  const total = steps.reduce((sum, step) => sum + step.polls, 0);
  let at = Date.parse('2026-08-06T16:00:00Z');
  const series: Finding[][] = [];
  for (let poll = 0; poll < total; poll += 1) {
    engine.applyPoll(await client.fetchMetrics(), at);
    at += POLL_MS;
    series.push(engine.snapshot().findings);
  }
  return series;
}

describe('a healthy production stays silent', () => {
  /**
   * A limit worth stating rather than discovering later: `healthy.json` has `queued: 0`
   * on every host, and zero error counts, so no `queue_buildup` or `elevated_error_rate`
   * threshold above zero can trip it. This test therefore CANNOT detect over-firing in
   * those two rules — only in the duration and throughput rules, where Cloud API's
   * non-zero `0.05`/`0.02` readings give it something to bite on.
   *
   * Verified by injection rather than assumed: dropping `slow_processing`'s floor to
   * `0.01` with a `1.0` multiplier does fail this test, while dropping
   * `queue_buildup.absoluteFloor` to `1` does not. Closing that second gap needs a
   * fixture with a small non-zero steady-state queue, which LABDEMO does not actually
   * have — so the honest move is to name the gap here rather than let a passing test
   * imply coverage it lacks.
   */
  it('emits nothing across 60 polls of healthy.json', async () => {
    // Ten minutes of steady state, well past minBaselineSamples. Anything at all here
    // is a false positive against measured LABDEMO values.
    const series = await pollSeries([{ fixture: 'healthy', polls: 60 }]);
    const emitted = series.flat();
    assert.deepEqual(
      emitted.map((f) => `${f.severity} ${f.type} on ${f.host}`),
      [],
      'healthy.json must never produce a finding',
    );
  });

  it('emits nothing while the baseline is still warming either', async () => {
    // The first samples are the riskiest: no baseline, so a rule that forgot to check
    // for one would fire on the very first reading.
    const series = await pollSeries([{ fixture: 'healthy', polls: 6 }]);
    assert.deepEqual(series.flat(), []);
  });

  it('goes quiet again after a problem clears', async () => {
    // Recovery is as important as detection: a finding that outlives its condition is a
    // lie the operator cannot dismiss. Contract Q4 promises findings disappear.
    const series = await pollSeries([
      { fixture: 'healthy', polls: 14 },
      { fixture: 'cloud-api-dead', polls: 4 },
      { fixture: 'healthy', polls: 8 },
    ]);
    const duringFault = series[16];
    const afterRecovery = series.at(-1);
    assert.ok(duringFault !== undefined && duringFault.length > 0, 'precondition: fault detected');
    assert.deepEqual(afterRecovery, [], 'every finding must clear once healthy returns');
  });
});

describe('a depicted problem is actually reported', () => {
  /** Peak simultaneous findings while a fixture is held, and which types appeared. */
  async function heldFault(fixture: string, polls = 6) {
    const series = await pollSeries([
      { fixture: 'healthy', polls: 14 },
      { fixture, polls },
    ]);
    const faultWindow = series.slice(14);
    const types = new Set(faultWindow.flat().map((f) => f.type));
    return { types, faultWindow };
  }

  it('cloud-api-dead reports the dead host', async () => {
    const { types } = await heldFault('cloud-api-dead');
    assert.ok(types.has('dead_host'), `expected dead_host, got: ${[...types].join(', ')}`);
  });

  it('stalled-host reports the stall', async () => {
    const { types } = await heldFault('stalled-host');
    assert.ok(types.has('stalled_host'), `expected stalled_host, got: ${[...types].join(', ')}`);
  });

  it('queue-buildup reports the queue', async () => {
    // 486 queued against a floor of 50. This one is genuinely fragile — see the
    // self-inflation test below for why a longer hold makes it disappear.
    const { types } = await heldFault('queue-buildup');
    assert.ok(types.has('queue_buildup'), `expected queue_buildup, got: ${[...types].join(', ')}`);
  });

  it('the error storm reports a rising error rate', async () => {
    const series = await pollSeries([
      { fixture: 'healthy', polls: 14 },
      { fixture: 'error-storm', polls: 1 },
      { fixture: 'error-storm-2', polls: 1 },
      { fixture: 'error-storm-3', polls: 1 },
      { fixture: 'error-storm-4', polls: 1 },
    ]);
    const types = new Set(series.slice(14).flat().map((f) => f.type));
    assert.ok(
      types.has('elevated_error_rate'),
      `expected elevated_error_rate, got: ${[...types].join(', ')}`,
    );
  });
});

describe('baseline self-inflation is visible, not silent (ADR 0002)', () => {
  it('queue_buildup clears while the queue is still 486', async () => {
    // Pinned deliberately. A rolling mean absorbs the breaching samples, so the ratio
    // falls below the multiplier and the finding clears WHILE THE PROBLEM PERSISTS.
    // CLAUDE.md §5.1 documents this; here it is measured, so nobody reads the demo going
    // quiet as a bug — and so that if we ever fix it, this test says so.
    const series = await pollSeries([
      { fixture: 'healthy', polls: 14 },
      { fixture: 'queue-buildup', polls: 12 },
    ]);
    const fired = series.findIndex((findings) => findings.some((f) => f.type === 'queue_buildup'));
    assert.ok(fired >= 0, 'queue_buildup should fire at least once');

    const laterPolls = series.slice(fired + 1);
    const clearedWhileStillBad = laterPolls.some(
      (findings) => !findings.some((f) => f.type === 'queue_buildup'),
    );
    assert.ok(
      clearedWhileStillBad,
      'expected queue_buildup to clear as the mean absorbs 486 — if this now fails, ' +
        'self-inflation has been addressed and CLAUDE.md §5.1 needs updating',
    );
  });

  it('dead_host does NOT self-inflate, which is why the demo headline holds', async () => {
    // Absolute rules read a status, not a ratio, so they cannot be absorbed by their own
    // baseline. This is the reason the demo's headline finding is a reliable one.
    const series = await pollSeries([
      { fixture: 'healthy', polls: 14 },
      { fixture: 'cloud-api-dead', polls: 20 },
    ]);
    const afterConfirmation = series.slice(17);
    for (const [index, findings] of afterConfirmation.entries()) {
      assert.ok(
        findings.some((f) => f.type === 'dead_host'),
        `dead_host vanished at poll ${17 + index} while the host was still Disabled`,
      );
    }
  });
});
