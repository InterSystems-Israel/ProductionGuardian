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
import type { ProxyHost, ProxyResponse } from '../src/types/proxy.ts';

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

describe('a reference baseline defeats self-inflation for the metric it covers', () => {
  it('queue_buildup does NOT clear while the queue is still 486', async () => {
    // THIS TEST WAS INVERTED, and the previous version is why. It pinned the opposite
    // assertion — "queue_buildup clears while the queue is still 486" — with the note:
    //
    //   "if this now fails, self-inflation has been addressed and CLAUDE.md §5.1 needs
    //    updating"
    //
    // It failed. `thresholds.json` now states `referenceBaselines: { "Cloud API": { queued: 0 } }`,
    // so the ratio for that host+metric no longer rises as the mean absorbs the breach, and the
    // finding persists for as long as the queue does. The old test did exactly what it was
    // written to do: it noticed a deliberate behaviour change and told the next reader what to
    // update. Inverting it rather than deleting it keeps that property.
    //
    // Self-inflation is NOT fixed in general — it still applies to every host+metric without a
    // reference, which is all of them by default. CLAUDE.md §5.1 is updated to say which case is
    // which rather than removed.
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
    assert.equal(
      clearedWhileStillBad,
      false,
      'with a reference baseline of 0 the finding must persist while the queue does — ' +
        'if this fails, the reference is not being honoured and a rising queue can go silent',
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

/**
 * Resetting a scenario must not itself produce findings.
 *
 * MEASURED on the live stack, 2026-08-27. `pool_bottleneck` arms `pRateSecs=0.5`, which
 * quadruples inbound load: LABDEMO idles at 0.5 msg/sec and the scenario drives 2.0. The
 * rail's `Reset all` restores the generator instantly, but the baseline is a 30-MINUTE
 * trailing mean, so for half an hour afterwards it still averages in the elevated block:
 *
 *     09:09..09:18   2.0 msg/sec      <- pool_bottleneck armed
 *     09:18:46       reset            <- generator restored to 0.5/sec
 *     09:19..09:39   0.5 msg/sec      <- true idle, nothing armed, production healthy
 *
 * rolling mean at the reset = 1.19, current sample = 0.4, fraction = 0.34, and
 * `throughput_drop.baselineFraction` is 0.40 -- so all three hosts reported
 * `warning  Throughput 0.4 msg/sec is 66% below baseline` with nothing armed. The
 * finding's own `detectedAt` was 09:18:46: the reset caused it.
 *
 * `throughput_drop` is the ONLY rule this can hit, and that is not luck -- it is the only
 * comparative rule where LOWER is worse (see its comment in `rules/index.ts`). Every other
 * rule sees a reset as a value falling back under its floor and goes quiet.
 */
describe('a reset does not manufacture a throughput_drop', () => {
  /** Idle throughput as the proxy actually reports it -- see quantization note below. */
  const IDLE = [0.4, 0.6];
  /** What `pool_bottleneck` drives: `pRateSecs=0.5` -> 2/sec. */
  const ARMED = 2.0;

  /**
   * One poll at a given inbound rate, with the other measured idle values held constant.
   *
   * `Lab Router` runs at DOUBLE the rate of the other two because it both receives and
   * sends each message, so its message counter advances twice per HL7 message. Measured,
   * not assumed: 0.8/sec against 0.4/sec on the same poll.
   */
  function pollAt(rate: number, at: number): ProxyResponse {
    const host = (
      name: string,
      type: string,
      messagesPerSec: number,
      avgProcessingTime: number,
    ): ProxyHost => ({
      host: name,
      type,
      status: 'OK',
      isFramework: false,
      queued: 0,
      messages: 1000,
      messagesPerSec,
      errored: 0,
      avgProcessingTime,
      avgQueueingTime: 0,
      lastActivity: new Date(at).toISOString(),
      lastActivityElapsedSeconds: 0.1,
    });
    return {
      sampledAt: new Date(at).toISOString(),
      production: 'ProductionGuardian.LabDemo.Production',
      hosts: [
        host('EMR Source', 'service', rate, 0),
        host('Lab Router', 'process', rate * 2, 0.01),
        host('Cloud API', 'operation', rate, 0.01),
      ],
      alerts: [],
      warming: false,
      productionQueued: 0,
    };
  }

  /**
   * The drain burst, MEASURED from `Ens.MessageHeader` on the live stack rather than modelled.
   *
   * `pool_bottleneck` throttles `Cloud API`'s downstream to ~1s per call, so while it is armed
   * the host clears 1 msg/sec against a 2/sec inflow and a backlog accumulates. `Reset all`
   * removes the throttle, and the whole backlog then flushes at once:
   *
   *     09:52:30..47   1 message each second      <- throttled, 1s per call
   *     09:52:48       102 messages               <- reset; throttle gone
   *     09:52:49       169 messages
   *     09:52:50..     1 message every 2 seconds  <- true idle, 0.5/sec
   *
   * 271 messages in two seconds, ~135/sec, and the proxy reported `messagesPerSec: 54.8` for
   * the poll containing them. That number is not an artifact and the arithmetic proves it:
   * IRIS computes the rate as messages-in-interval / interval, and 274 / 5s = 54.8 exactly.
   * The burst is REAL WORK, so it is recorded, not rejected -- see `ROBUST_METRICS`.
   */
  const DRAIN_BURST = 54.8;

  /**
   * Drive the armed rate, then the idle rate, and report what was on the board after the
   * load stepped back down.
   *
   * `tellEngine` decides whether the engine is told the regime changed; `burst` inserts the
   * measured drain flush as the first post-reset sample, where it actually landed. The two
   * options are separate because they are separate mechanisms -- a sustained step down, and a
   * transient inside the new regime -- and each on its own produced a false positive.
   */
  function afterReset(options: { tellEngine: boolean; burst?: boolean }): Finding[] {
    const engine = new DetectionEngine(CONFIG);
    const POLL = 5_000; // the shipped engine poll, and what the measurement above used
    let at = Date.parse('2026-08-27T09:09:00Z');

    // 10 minutes armed -- long enough to fill the baseline with the elevated rate.
    for (let poll = 0; poll < 120; poll += 1) {
      engine.applyPoll(pollAt(ARMED, at), at);
      at += POLL;
    }

    if (options.tellEngine) engine.beginRegime(at);

    // The backlog flushes on the first poll after the reset, before load is idle.
    if (options.burst === true) {
      engine.applyPoll(pollAt(DRAIN_BURST, at), at);
      at += POLL;
    }

    // 5 minutes of true idle. Well past minBaselineSamples, nowhere near the 30-minute
    // window, which is exactly the gap that produced the incident.
    for (let poll = 0; poll < 60; poll += 1) {
      engine.applyPoll(pollAt(IDLE[poll % 2]!, at), at);
      at += POLL;
    }
    return engine.snapshot().findings;
  }

  it('stays silent once the load steps back down to idle', () => {
    const findings = afterReset({ tellEngine: true });
    assert.deepEqual(
      findings.map((f) => `${f.severity} ${f.type} on ${f.host}`),
      [],
      'a healthy idle production after a reset must report nothing',
    );
  });

  it('stays silent even though the backlog flushed at 54.8 msg/sec on the way down', () => {
    // THE SECOND MECHANISM, and the one that made the regime boundary alone insufficient.
    // Measured after `beginRegime` shipped: `EMR Source` and `Lab Router` re-warmed clean, but
    // `Cloud API` -- the only host with a backlog to flush -- came back with
    //
    //     baselineValue: 1.528301886792453   == 81 / 53
    //
    // against a current 0.4, and fired `warning throughput_drop`. One sample of 54.8 out of 53
    // supplied 68% of the mean; excluding it gives (81 - 54.8) / 52 = 0.504, the true idle rate.
    // A 270x transient is not something a mean can absorb, at any window length.
    const findings = afterReset({ tellEngine: true, burst: true });
    assert.deepEqual(
      findings.map((f) => `${f.severity} ${f.type} on ${f.host}`),
      [],
      'the drain burst must not become the new normal',
    );
  });

  it('and WITHOUT being told, the false positive is reproducible', () => {
    // Pinned deliberately, the way baseline.test.ts pins self-inflation: this is the
    // mechanism, not a hypothesis. If this test ever goes green on its own, the rolling
    // mean stopped spanning the reset and `beginRegime` may no longer be needed -- which
    // is a real change worth noticing rather than silently inheriting.
    const findings = afterReset({ tellEngine: false });
    assert.deepEqual(
      findings.map((f) => `${f.type} on ${f.host}`).sort(),
      [
        'throughput_drop on Cloud API',
        'throughput_drop on EMR Source',
        'throughput_drop on Lab Router',
      ],
      'the un-reset baseline must still reproduce the incident on all three hosts',
    );
  });
});
