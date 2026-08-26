/**
 * Engine tests — the behaviours the contract promises Dev C, verified end to end.
 *
 * The important ones here are not "a finding appears" but:
 *   - a single-sample spike produces NOTHING (sustained breach, MVP §6)
 *   - an id stays STABLE across polls (contract Q4)
 *   - a finding DISAPPEARS when the condition clears (contract Q4)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  DEFAULT_POLL_INTERVAL_MS,
  type ThresholdConfig,
} from '../src/config/thresholds.ts';
import { DetectionEngine, normalizeHostType } from '../src/detect/engine.ts';
import type { ProxyHost, ProxyResponse } from '../src/types/proxy.ts';

const T0 = Date.parse('2026-08-06T16:00:00Z');
const POLL_MS = 10_000;

function proxyHost(overrides: Partial<ProxyHost> = {}): ProxyHost {
  return {
    host: 'Lab Router',
    type: 'actor',
    status: 'OK',
    isFramework: false,
    queued: 0,
    messages: 100,
    messagesPerSec: 1.2,
    errored: 0,
    avgProcessingTime: 0.08,
    avgQueueingTime: 0,
    lastActivity: null,
    lastActivityElapsedSeconds: 4,
    ...overrides,
  };
}

function response(hosts: ProxyHost[]): ProxyResponse {
  return {
    sampledAt: new Date(T0).toISOString(),
    production: 'LABDEMO.Production',
    hosts,
    alerts: [],
    warming: false,
    productionQueued: null,
  };
}

/** Run `polls` healthy polls to warm the baseline, returning the next poll time. */
function warmUp(engine: DetectionEngine, polls = DEFAULT_CONFIG.minBaselineSamples): number {
  let at = T0;
  for (let i = 0; i < polls; i += 1) {
    engine.applyPoll(response([proxyHost()]), at);
    at += POLL_MS;
  }
  return at;
}

describe('normalization', () => {
  it('maps IRIS actor to the contract process (Q10)', () => {
    assert.equal(normalizeHostType('actor'), 'process');
    assert.equal(normalizeHostType('service'), 'service');
    assert.equal(normalizeHostType('operation'), 'operation');
  });

  it('converts elapsed seconds to an ISO timestamp (Q11)', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    engine.applyPoll(response([proxyHost({ lastActivityElapsedSeconds: 60 })]), T0);
    const [host] = engine.snapshot().hosts;
    assert.ok(host !== undefined);
    assert.equal(host.lastActivity, '2026-08-06T15:59:00Z');
  });

  it('emits second-precision Z timestamps, matching the schema pattern', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    engine.applyPoll(response([proxyHost()]), T0 + 456);
    const [host] = engine.snapshot().hosts;
    assert.ok(host !== undefined);
    assert.match(host.lastActivity, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('filters framework hosts (PROXY-Q5)', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    engine.applyPoll(
      response([
        proxyHost({ host: 'Lab Router' }),
        proxyHost({ host: 'Ens.MonitorService' }),
        proxyHost({ host: 'EnsLib.Testing.Process' }),
        proxyHost({ host: 'Ens.Activity.Operation.Local' }),
      ]),
      T0,
    );
    const names = engine.snapshot().hosts.map((h) => h.host);
    assert.deepEqual(names, ['Lab Router']);
  });

  it('sorts hosts by name', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    engine.applyPoll(
      response([
        proxyHost({ host: 'Lab Router' }),
        proxyHost({ host: 'Cloud API' }),
        proxyHost({ host: 'EMR Source' }),
      ]),
      T0,
    );
    assert.deepEqual(engine.snapshot().hosts.map((h) => h.host), [
      'Cloud API',
      'EMR Source',
      'Lab Router',
    ]);
  });
});

describe('sustained breach (MVP §6)', () => {
  it('emits NOTHING for a single-sample spike', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    const at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    assert.equal(engine.snapshot().findings.length, 0, 'one breaching sample must not confirm');
  });

  it('confirms on the second consecutive breaching sample', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);

    const findings = engine.snapshot().findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.type, 'dead_host');
  });

  it('resets the counter when a breach is interrupted', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    // Breach, recover, breach again: never two in a row, so never confirmed.
    for (const status of ['Disabled', 'OK', 'Disabled', 'OK', 'Disabled']) {
      engine.applyPoll(response([proxyHost({ status })]), at);
      at += POLL_MS;
    }
    assert.equal(engine.snapshot().findings.length, 0, 'consecutive means consecutive');
  });
});

describe('finding lifecycle (contract Q4)', () => {
  it('keeps the id STABLE across polls while the condition persists', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
      at += POLL_MS;
      const [finding] = engine.snapshot().findings;
      if (finding !== undefined) ids.add(finding.id);
    }
    assert.equal(ids.size, 1, `id churned across polls: ${[...ids].join(', ')}`);
  });

  it('keeps detectedAt at first confirmation, not last seen', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    const confirmedAt = engine.snapshot().findings[0]?.detectedAt;

    for (let i = 0; i < 3; i += 1) {
      at += POLL_MS;
      engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    }
    assert.equal(engine.snapshot().findings[0]?.detectedAt, confirmedAt);
  });

  it('refreshes current values while keeping the same finding', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    const first = engine.snapshot().findings[0];
    assert.ok(first !== undefined, 'expected queue_buildup to confirm');

    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 250 })]), at);
    const second = engine.snapshot().findings[0];
    assert.ok(second !== undefined);
    assert.equal(second.id, first.id, 'same condition, same id');
    assert.equal(second.currentValue, 250, 'but current value moves');
  });

  it('makes the finding DISAPPEAR when the condition clears', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    assert.equal(engine.snapshot().findings.length, 1, 'precondition: finding exists');

    // Clearing takes the same two gates as confirming, so it takes the same two polls.
    for (let i = 0; i < DEFAULT_CONFIG.sustainedSamples; i += 1) {
      at += POLL_MS;
      engine.applyPoll(response([proxyHost({ status: 'OK' })]), at);
    }
    assert.equal(engine.snapshot().findings.length, 0, 'no tombstones, no resolvedAt');
  });

  it('holds a confirmed finding through ONE non-breaching poll, id intact', () => {
    // The flap: appearing cost two samples and disappearing cost one, so a condition
    // oscillating around a threshold produced a finding, dropped it, and produced the
    // SAME condition again under a new id. Contract Q4 promises the id is stable for the
    // lifetime of the condition, and the condition outlives the blip.
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    const first = engine.snapshot().findings[0];
    assert.ok(first !== undefined, 'precondition: queue_buildup confirmed');

    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 0 })]), at);
    assert.equal(engine.snapshot().findings.length, 1, 'one blip must not retract it');

    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    const back = engine.snapshot().findings[0];
    assert.ok(back !== undefined);
    assert.equal(back.id, first.id, 'same condition, same id — not a new finding');
    assert.equal(back.detectedAt, first.detectedAt, 'and the blip did not re-clock it');
  });

  it('holds a confirmed finding when its input becomes UNMEASURABLE', () => {
    // A null queue depth is "cannot tell", not "not breaching". queue_buildup declines to
    // evaluate on it (#49), and that silence must not read as a clear — an instance that
    // stops publishing a metric would otherwise retract a finding that is still true.
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    const first = engine.snapshot().findings[0];
    assert.ok(first !== undefined, 'precondition: queue_buildup confirmed');

    // Well past the clear bar in both polls and seconds.
    for (let i = 0; i < DEFAULT_CONFIG.sustainedSamples + 3; i += 1) {
      at += POLL_MS;
      engine.applyPoll(response([proxyHost({ queued: null })]), at);
    }
    const held = engine.snapshot().findings[0];
    assert.ok(held !== undefined, 'unmeasurable must never clear a finding');
    assert.equal(held.id, first.id);
  });

  it('still clears dead_host on the bar, since its inputs are never unmeasurable', () => {
    // dead_host declares `requires: []` — it judges `status`, which is always present. So
    // its silence really does mean "not breaching" and the hold above must not apply to it.
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled', queued: null })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled', queued: null })]), at);
    assert.equal(engine.snapshot().findings.length, 1, 'precondition: dead_host confirmed');

    for (let i = 0; i < DEFAULT_CONFIG.sustainedSamples; i += 1) {
      at += POLL_MS;
      engine.applyPoll(response([proxyHost({ status: 'OK', queued: null })]), at);
    }
    assert.equal(engine.snapshot().findings.length, 0);
  });

  it('sustainedSamples 1 / sustainedSeconds 0 clears on the first poll, as it always did', () => {
    // The clear bar reuses the two existing knobs rather than adding a third, so the
    // degenerate config still means "believe every poll" in both directions. Anyone who
    // wants the old asymmetric behaviour back has it here.
    const eager = { ...DEFAULT_CONFIG, sustainedSamples: 1, sustainedSeconds: 0 };
    const engine = new DetectionEngine(eager);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    assert.equal(engine.snapshot().findings.length, 1, 'confirms on one sample');

    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'OK' })]), at);
    assert.equal(engine.snapshot().findings.length, 0, 'and clears on one');
  });

  it('forgets a host that leaves the production', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    assert.equal(engine.snapshot().findings.length, 1);

    // Absence is held to the same bar, so it takes the same two polls to believe.
    for (let i = 0; i < DEFAULT_CONFIG.sustainedSamples; i += 1) {
      at += POLL_MS;
      engine.applyPoll(response([]), at);
    }
    const snapshot = engine.snapshot();
    assert.equal(snapshot.hosts.length, 0);
    assert.equal(snapshot.findings.length, 0);
  });

  it('keeps a host and its warm baseline through ONE absent poll', () => {
    // Forgetting on the first absent poll discarded the BASELINE too, so a host that
    // dropped out of one payload came back `warming` — every comparative rule silent for
    // minBaselineSamples more polls. That is a finding that goes away and cannot return.
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    at += POLL_MS;
    engine.applyPoll(response([]), at);
    assert.equal(engine.snapshot().hosts.length, 1, 'last-known host, not blanked');

    // Back on the next poll, and still warm: a breach confirms on the usual two samples
    // rather than waiting out a fresh baseline window.
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ queued: 100 })]), at);
    assert.equal(
      engine.snapshot().findings.filter((f) => f.type === 'queue_buildup').length,
      1,
      'baseline survived the gap, so the comparative rule could still fire',
    );
  });
});

describe('warm-up (ADR 0002)', () => {
  it('reports warming before any poll', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    assert.equal(engine.snapshot().state, 'warming');
  });

  it('stays warming until the baseline has enough samples', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = T0;
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(response([proxyHost()]), at);
      at += POLL_MS;
    }
    assert.equal(engine.snapshot().state, 'warming');
  });

  it('suppresses comparative findings during warm-up but still reports hosts', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = T0;
    // A huge queue from the very first poll: no baseline, so no comparative finding.
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(response([proxyHost({ queued: 5000 })]), at);
      at += POLL_MS;
    }
    const snapshot = engine.snapshot();
    assert.equal(snapshot.findings.length, 0, 'no baseline means no comparative finding');
    assert.equal(snapshot.hosts.length, 1, 'hosts are still reported while warming');
  });

  it('still fires absolute rules during warm-up', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = T0;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);

    const findings = engine.snapshot().findings;
    assert.equal(findings.length, 1, 'dead_host needs no baseline');
    assert.equal(findings[0]?.baselineValue, null);
  });

  it('reports ok once every metric is warm', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    // errorsPerMinute needs two readings before it records at all, so warm one extra.
    warmUp(engine, DEFAULT_CONFIG.minBaselineSamples + 2);
    assert.equal(engine.snapshot().state, 'ok');
  });
});

describe('stale handling', () => {
  it('reports stale after a failed poll but keeps serving last-known data', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    warmUp(engine);
    assert.equal(engine.snapshot().hosts.length, 1);

    engine.markPollFailed();
    const snapshot = engine.snapshot();
    assert.equal(snapshot.state, 'stale');
    assert.equal(snapshot.hosts.length, 1, 'degrade, never blank');
  });

  it('clears stale on the next successful poll', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    const at = warmUp(engine, DEFAULT_CONFIG.minBaselineSamples + 2);
    engine.markPollFailed();
    engine.applyPoll(response([proxyHost()]), at);
    assert.equal(engine.snapshot().state, 'ok');
  });
});

describe('error rate derivation', () => {
  it('does not fire on the first poll, when rate is unknowable', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    engine.applyPoll(response([proxyHost({ errored: 500 })]), T0);
    assert.equal(engine.snapshot().findings.length, 0);
  });

  it('ignores a counter that goes backwards, meaning a production restart', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ errored: 100 })]), at);
    at += POLL_MS;
    // Counter resets to 0: a negative delta must not become a negative rate.
    engine.applyPoll(response([proxyHost({ errored: 0 })]), at);

    const errorFindings = engine
      .snapshot()
      .findings.filter((f) => f.type === 'elevated_error_rate');
    assert.equal(errorFindings.length, 0);
  });
});

describe('hot reload (ADR 0003)', () => {
  it('preserves warm baselines when only a threshold changes', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine, DEFAULT_CONFIG.minBaselineSamples + 2);
    assert.equal(engine.snapshot().state, 'ok');

    const tweaked: ThresholdConfig = {
      ...DEFAULT_CONFIG,
      rules: {
        ...DEFAULT_CONFIG.rules,
        queue_buildup: { ...DEFAULT_CONFIG.rules.queue_buildup, absoluteFloor: 10 },
      },
    };
    engine.reconfigure(tweaked);
    engine.applyPoll(response([proxyHost()]), (at += POLL_MS));
    assert.equal(engine.snapshot().state, 'ok', 'a threshold tweak must not wipe the baseline');
  });

  it('rebuilds state when a structural parameter changes', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    warmUp(engine, DEFAULT_CONFIG.minBaselineSamples + 2);
    assert.equal(engine.snapshot().state, 'ok');

    engine.reconfigure({ ...DEFAULT_CONFIG, minBaselineSamples: 50 });
    assert.equal(engine.snapshot().state, 'warming', 'a bigger window means warming again');
  });
});

describe('system_alert', () => {
  it('keeps reporting while the alert stays in the payload, and clears when it ages out', () => {
    // This test previously asserted the opposite — "fires once, then not again" — which
    // was the bug: suppressing the second poll meant the registry never saw the two
    // consecutive verdicts it needs, so with the default sustainedSamples of 2 the rule
    // could never confirm at all. An alert reports for as long as the proxy carries it.
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    const alert = {
      time: '2026-08-06T15:58:00.000Z',
      severity: '2',
      message: 'Lab Router reported a problem',
    };
    const alertCount = () =>
      engine.snapshot().findings.filter((f) => f.type === 'system_alert').length;

    engine.applyPoll({ ...response([proxyHost()]), alerts: [alert] }, T0);
    assert.equal(alertCount(), 0, 'one sample must not confirm — sustained breach applies');

    engine.applyPoll({ ...response([proxyHost()]), alerts: [alert] }, T0 + POLL_MS);
    assert.equal(alertCount(), 1, 'confirms on the second consecutive poll');

    engine.applyPoll({ ...response([proxyHost()]), alerts: [alert] }, T0 + 2 * POLL_MS);
    assert.equal(alertCount(), 1, 'still reported while present, not duplicated');

    // The alert ages out of the proxy payload — the finding clears, per contract Q4, on
    // the same two-gate bar it confirmed on.
    engine.applyPoll(response([proxyHost()]), T0 + 3 * POLL_MS);
    engine.applyPoll(response([proxyHost()]), T0 + 4 * POLL_MS);
    assert.equal(alertCount(), 0, 'no tombstone once the alert is gone');
  });

  it('keeps a stable id across polls for the same alert', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    const alert = {
      time: '2026-08-06T15:58:00.000Z',
      severity: '2',
      message: 'Lab Router reported a problem',
    };
    const ids = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      engine.applyPoll({ ...response([proxyHost()]), alerts: [alert] }, T0 + i * POLL_MS);
      const finding = engine.snapshot().findings.find((f) => f.type === 'system_alert');
      if (finding !== undefined) ids.add(finding.id);
    }
    assert.equal(ids.size, 1, `id churned across polls: ${[...ids].join(', ')}`);
  });

  it('ignores an alert that names no known host', () => {
    // sustainedSeconds: 0 alongside sustainedSamples: 1 is how "confirm on the first
    // poll" is expressed now that the sustained bar has a time gate too (#44).
    const engine = new DetectionEngine({
      ...DEFAULT_CONFIG,
      sustainedSamples: 1,
      sustainedSeconds: 0,
    });
    engine.applyPoll(
      {
        ...response([proxyHost()]),
        alerts: [{ time: '2026-08-06T15:58:00.000Z', severity: '2', message: 'disk is full' }],
      },
      T0,
    );
    assert.equal(engine.snapshot().findings.filter((f) => f.type === 'system_alert').length, 0);
  });

  it('escalates a low numeric IRIS severity to critical', () => {
    // sustainedSeconds: 0 alongside sustainedSamples: 1 is how "confirm on the first
    // poll" is expressed now that the sustained bar has a time gate too (#44).
    const engine = new DetectionEngine({
      ...DEFAULT_CONFIG,
      sustainedSamples: 1,
      sustainedSeconds: 0,
    });
    engine.applyPoll(
      {
        ...response([proxyHost()]),
        alerts: [
          { time: '2026-08-06T15:58:00.000Z', severity: '1', message: 'Lab Router is on fire' },
        ],
      },
      T0,
    );
    const alertFinding = engine.snapshot().findings.find((f) => f.type === 'system_alert');
    assert.equal(alertFinding?.severity, 'critical', 'IRIS severity is inverted: lower is worse');
  });
});

describe('findings ordering (contract §2)', () => {
  it('sorts detectedAt desc with severity as tiebreak', () => {
    // sustainedSeconds: 0 alongside sustainedSamples: 1 is how "confirm on the first
    // poll" is expressed now that the sustained bar has a time gate too (#44).
    const engine = new DetectionEngine({
      ...DEFAULT_CONFIG,
      sustainedSamples: 1,
      sustainedSeconds: 0,
    });
    let at = warmUp(engine);

    // Two conditions on one host confirmed at the same instant: severity breaks the tie.
    engine.applyPoll(
      response([proxyHost({ status: 'Disabled', queued: 100, lastActivityElapsedSeconds: 400 })]),
      at,
    );
    const findings = engine.snapshot().findings;
    assert.ok(findings.length >= 2, `expected multiple findings, got ${findings.length}`);

    for (let i = 1; i < findings.length; i += 1) {
      const prev = findings[i - 1];
      const curr = findings[i];
      assert.ok(prev !== undefined && curr !== undefined);
      assert.ok(prev.detectedAt >= curr.detectedAt, 'detectedAt must be descending');
    }
    assert.equal(findings[0]?.severity, 'critical', 'critical sorts first within a timestamp');
  });
});

describe('inert override warning reaches the log (#25)', () => {
  const withOverride: ThresholdConfig = {
    ...DEFAULT_CONFIG,
    hostOverrides: { 'Cloud API': { slow_processing: { absoluteFloorSeconds: 0.3 } } },
  };

  it('warns once, not once per poll', () => {
    const logs: string[] = [];
    const engine = new DetectionEngine(withOverride, (msg) => logs.push(msg));
    let at = T0;
    for (let i = 0; i < 5; i += 1) {
      engine.applyPoll(response([proxyHost({ host: 'Tick Feed' })]), at);
      at += POLL_MS;
    }
    assert.equal(logs.length, 1, `expected one warning, got ${logs.length}`);
    assert.match(logs[0] ?? '', /hostOverrides\["Cloud API"\] matches no observed host/);
    assert.match(logs[0] ?? '', /Observed: Tick Feed/);
  });

  it('stays silent when the override applies', () => {
    const logs: string[] = [];
    const engine = new DetectionEngine(withOverride, (msg) => logs.push(msg));
    engine.applyPoll(response([proxyHost({ host: 'Cloud API' })]), T0);
    assert.deepEqual(logs, []);
  });

  it('warns again after reconfigure, so a corrected file is re-checked', () => {
    const logs: string[] = [];
    const engine = new DetectionEngine(withOverride, (msg) => logs.push(msg));
    engine.applyPoll(response([proxyHost({ host: 'Tick Feed' })]), T0);
    engine.reconfigure(withOverride);
    engine.applyPoll(response([proxyHost({ host: 'Tick Feed' })]), T0 + POLL_MS);
    assert.equal(logs.length, 2);
  });
});

describe('unmeasurable metrics through the full poll path (#33)', () => {
  // These belong at engine level, not rule level: the defects were in what
  // normalizeHost() hands the rules, so a rule test that supplies both the normalized and
  // raw values itself cannot see them. I found that out by injecting the original defect
  // into the rule and watching the rule tests still pass.

  it('a metric going absent on a healthy production produces NOTHING', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 20; i += 1) {
      engine.applyPoll(response([proxyHost()]), at);
      at += POLL_MS;
    }
    assert.deepEqual(engine.snapshot().findings, [], 'precondition: healthy is silent');

    // IRIS omits whole metric families rather than emitting zeros, and a rate over a
    // zero-length window parses as NaN -> null. Either route previously became 0 and reported
    // a 100% collapse.
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(response([proxyHost({ messagesPerSec: null })]), at);
      at += POLL_MS;
    }
    assert.deepEqual(
      engine.snapshot().findings.map((f) => `${f.severity} ${f.type}`),
      [],
      'an absent rate must not be reported as a collapse',
    );
  });

  it('but a REAL collapse still fires', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 20; i += 1) {
      engine.applyPoll(response([proxyHost()]), at);
      at += POLL_MS;
    }
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(response([proxyHost({ messagesPerSec: 0 })]), at);
      at += POLL_MS;
    }
    const types = engine.snapshot().findings.map((f) => f.type);
    assert.ok(types.includes('throughput_drop'), `expected throughput_drop, got ${types.join(', ')}`);
  });

  it('stalled_host fires on a measurable queue, through normalization', () => {
    // The live case has queued: null, which normalizes to 0 and silently disabled this
    // rule. With a real depth it must still fire.
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 16; i += 1) {
      engine.applyPoll(
        response([proxyHost({ queued: 5, lastActivityElapsedSeconds: 400 })]),
        at,
      );
      at += POLL_MS;
    }
    const types = engine.snapshot().findings.map((f) => f.type);
    assert.ok(types.includes('stalled_host'), `expected stalled_host, got ${types.join(', ')}`);
  });

  it('stalled_host declines when the depth is unknown, as it does live', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});
    let at = T0;
    for (let i = 0; i < 16; i += 1) {
      engine.applyPoll(
        response([proxyHost({ queued: null, lastActivityElapsedSeconds: 400 })]),
        at,
      );
      at += POLL_MS;
    }
    const types = engine.snapshot().findings.map((f) => f.type);
    assert.ok(
      !types.includes('stalled_host'),
      'firing on an unknown depth would be the false positive §6 warns about',
    );
  });
});

/**
 * The sustained bar is two gates, samples AND wall-clock seconds (#44).
 *
 * These exist because the fix for #44 was to poll twice as fast, and a sample-only
 * bar would have silently halved the debounce *duration* at the same time — trading
 * false-positive protection for latency without anyone choosing to. The tests below
 * are the check that the trade did not happen.
 */
describe('sustained breach is time-gated as well as sample-gated (#44)', () => {
  /** DEFAULT_CONFIG with the sustained gates overridden. */
  function config(sustainedSamples: number, sustainedSeconds: number): ThresholdConfig {
    return { ...structuredClone(DEFAULT_CONFIG), sustainedSamples, sustainedSeconds };
  }

  /** A host that breaches dead_host — absolute, so no baseline warm-up is needed. */
  function deadHost(): ProxyHost {
    return proxyHost({ status: 'Disabled', queued: 6 });
  }

  it('withholds a finding while the sample gate is met but the time gate is not', () => {
    // Two breaching samples 1s apart: samples satisfied, 8s of wall clock not.
    const engine = new DetectionEngine(config(2, 8), () => {});
    engine.applyPoll(response([deadHost()]), T0);
    engine.applyPoll(response([deadHost()]), T0 + 1_000);

    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'two fast samples must not confirm — this is the protection a faster poll would have lost',
    );
  });

  it('emits once the time gate is also satisfied', () => {
    const engine = new DetectionEngine(config(2, 8), () => {});
    engine.applyPoll(response([deadHost()]), T0);
    engine.applyPoll(response([deadHost()]), T0 + 1_000);
    engine.applyPoll(response([deadHost()]), T0 + 8_000);

    const types = engine.snapshot().findings.map((f) => f.type);
    assert.ok(types.includes('dead_host'), `expected dead_host, got ${types.join(', ') || 'none'}`);
  });

  it('withholds when the time gate is met but the sample gate is not', () => {
    // One sample, long after the condition began: time alone must not confirm.
    const engine = new DetectionEngine(config(3, 1), () => {});
    engine.applyPoll(response([deadHost()]), T0);
    engine.applyPoll(response([deadHost()]), T0 + 60_000);

    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'two samples cannot satisfy a three-sample gate however much time has passed',
    );
  });

  it('restarts the clock when a breach clears and returns', () => {
    const engine = new DetectionEngine(config(2, 8), () => {});
    engine.applyPoll(response([deadHost()]), T0);
    engine.applyPoll(response([proxyHost()]), T0 + 5_000); // recovered: condition dropped
    engine.applyPoll(response([deadHost()]), T0 + 6_000);
    engine.applyPoll(response([deadHost()]), T0 + 7_000);

    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'a flapping host must not inherit elapsed time from a cleared condition',
    );
  });

  it('at the 5s poll rate we now ship, detection lands inside the 10s bar', () => {
    // The whole point of #44: prove the configured defaults meet the acceptance
    // criterion, rather than asserting the mechanism in the abstract.
    const engine = new DetectionEngine(
      { ...structuredClone(DEFAULT_CONFIG) },
      () => {},
    );
    const POLL = 5_000;
    let at = T0;
    let detectedAt: number | undefined;
    for (let i = 0; i < 6 && detectedAt === undefined; i += 1) {
      engine.applyPoll(response([deadHost()]), at);
      if (engine.snapshot().findings.length > 0) detectedAt = at;
      at += POLL;
    }

    assert.ok(detectedAt !== undefined, 'must detect at all');
    const elapsed = (detectedAt - T0) / 1000;
    assert.ok(
      elapsed <= 10,
      `engine-side detection must fit the 10s bar, took ${elapsed}s`,
    );
  });

  it('the shipped gate is reachable within sustainedSamples polls, WITH MARGIN', () => {
    // Two traps this has caught, both "a timing number without the rate it runs at":
    //   8 at a 5s poll -> unreachable in 2 samples, confirms on the 3rd (12.8s measured)
    //   5 at a 5s poll -> reachable only by EXACT equality, so fetch jitter slips it to
    //                     the 3rd sample on ~half of detections (10.2s vs 5.3s)
    //
    // Hence STRICT `<`, not `<=`: "reachable in N polls" has to mean reachable when the
    // observed gap is a little under nominal, because `applyPoll` is stamped after a
    // variable-duration fetch. `<=` admitted the zero-margin case and passed on 5.
    //
    // Reads DEFAULT_POLL_INTERVAL_MS rather than a local copy — a hardcoded 5_000 here
    // left this test green while the relationship it asserts became false.
    const { sustainedSamples, sustainedSeconds } = DEFAULT_CONFIG;
    const spanCoveredBySamples = (sustainedSamples - 1) * DEFAULT_POLL_INTERVAL_MS;

    assert.ok(
      sustainedSeconds * 1000 < spanCoveredBySamples,
      `sustainedSeconds=${sustainedSeconds} needs to be reachable in ${sustainedSamples} ` +
        `polls of ${DEFAULT_POLL_INTERVAL_MS}ms with room to spare, but covers ` +
        `${spanCoveredBySamples}ms exactly or more — it would force an extra poll`,
    );

    // End to end at the nominal rate: two polls must confirm.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    engine.applyPoll(response([deadHost()]), T0);
    engine.applyPoll(response([deadHost()]), T0 + DEFAULT_POLL_INTERVAL_MS);
    assert.ok(
      engine.snapshot().findings.some((f) => f.type === 'dead_host'),
      'two polls at the shipped interval must be enough to confirm',
    );
  });

  /**
   * The jitter case, which the nominal-rate test above cannot see.
   *
   * `src/index.ts` stamps `applyPoll(response, Date.now())` AFTER awaiting the fetch, so
   * the gap between consecutive stamps is `POLL_INTERVAL + (fetch_n − fetch_{n−1})`, not
   * the interval. A poll quicker than its predecessor produces a short gap.
   *
   * Reproduced from @tanifgit's review on #46 — at `sustainedSeconds: 5` these four cases
   * gave 5.3 / 10.2 / 10.05 / 10.12 seconds, i.e. an intermittent doubling. At 4 they all
   * land near 5.
   */
  it('confirms on the second poll even when a fetch is quicker than the last (#46)', () => {
    const POLL = DEFAULT_POLL_INTERVAL_MS;

    /** Detection latency in seconds, simulating stamp = pollStart + fetchDuration. */
    const detectAfter = (fetchMs: readonly number[]): number => {
      const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
      for (let i = 0; i < 8; i += 1) {
        const stamp = T0 + i * POLL + (fetchMs[i] ?? fetchMs[fetchMs.length - 1] ?? 0);
        engine.applyPoll(response([deadHost()]), stamp);
        if (engine.snapshot().findings.length > 0) return (stamp - T0) / 1000;
      }
      return Number.POSITIVE_INFINITY;
    };

    const cases: ReadonlyArray<readonly [string, readonly number[]]> = [
      ['constant latency', [300, 300]],
      ['2nd poll 100ms quicker', [300, 200]],
      ['2nd poll 250ms quicker', [300, 50]],
      ['cold connect, then warm', [800, 120]],
    ];

    for (const [label, fetchMs] of cases) {
      const seconds = detectAfter(fetchMs);
      assert.ok(
        seconds < POLL * 2 / 1000,
        `${label}: confirmed after ${seconds}s, which means jitter cost an extra poll`,
      );
    }
  });

  it('sustainedSeconds: 0 preserves the old sample-only behaviour', () => {
    const engine = new DetectionEngine(config(2, 0), () => {});
    engine.applyPoll(response([deadHost()]), T0);
    engine.applyPoll(response([deadHost()]), T0 + 1);

    const types = engine.snapshot().findings.map((f) => f.type);
    assert.ok(types.includes('dead_host'), 'the escape hatch must actually disable the gate');
  });
});
/**
 * Unmeasurable counts must never enter the baseline (#49).
 *
 * Found by @tanifgit. Every RULE was hardened to tell "unknown" from "zero"; the BASELINE
 * was not, because the four record() calls took the normalized host, where orZero() has
 * already collapsed null to 0. So a metric going absent deflated the baseline it feeds and
 * the next genuine reading was judged against fabricated history.
 *
 * The measured failure, against shipped thresholds: a steady queue of 40 drops out of the
 * host-status endpoint for five minutes, returns at an ordinary 60, and the engine reported
 * "Queue depth 60 is 6.5x baseline" with baseline=9.21 — the mean of twelve real 40s and
 * sixty fabricated zeros. Internally consistent arithmetic about nothing.
 *
 * This is the near-mirror of the self-inflation property in baseline.test.ts: there the
 * window includes samples it should exclude and a real problem goes silent; here it
 * includes samples that were never measured and a normal value raises a warning.
 */
describe('unmeasurable counts never enter the baseline (#49)', () => {
  /** A host with every nullable count measurable, so a test can null one field. */
  function measured(overrides: Partial<ProxyHost> = {}): ProxyHost {
    return proxyHost({ queued: 40, messagesPerSec: 1.2, avgProcessingTime: 0.08, ...overrides });
  }

  it('does not deflate the baseline across an outage in the host-status endpoint', () => {
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;

    // Warm on a real, steady queue of 40.
    for (let i = 0; i < 13; i += 1) {
      engine.applyPoll(response([measured()]), at);
      at += POLL_MS;
    }
    // The endpoint goes away for 60 polls. Nothing about the production changed.
    for (let i = 0; i < 60; i += 1) {
      engine.applyPoll(response([measured({ queued: null })]), at);
      at += POLL_MS;
    }
    // It returns at an ordinary depth for this host.
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(response([measured({ queued: 60 })]), at);
      at += POLL_MS;
    }

    const buildup = engine.snapshot().findings.filter((f) => f.type === 'queue_buildup');
    assert.deepEqual(
      buildup.map((f) => f.message),
      [],
      'a queue that never changed must not produce a finding',
    );
  });

  it('leaves a gap rather than a false sample, for every nullable metric', () => {
    // Asserted through sampleCount rather than through a finding: the point is that the
    // window is SHORTER, not merely that no finding appeared. A rule staying silent for an
    // unrelated reason would hide this.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;
    for (let i = 0; i < 6; i += 1) {
      engine.applyPoll(response([measured()]), at);
      at += POLL_MS;
    }
    for (let i = 0; i < 6; i += 1) {
      engine.applyPoll(
        response([measured({ queued: null, messagesPerSec: null, avgProcessingTime: null })]),
        at,
      );
      at += POLL_MS;
    }

    // 12 polls, 6 of them unmeasurable -> still warming, because there are only 6 samples.
    assert.equal(
      engine.snapshot().state,
      'warming',
      'skipped samples must leave the host short of minBaselineSamples, not silently full',
    );
  });

  it('still records a genuine measured zero', () => {
    // The distinction that matters: 0 is a reading, null is not. If this regressed to
    // skipping zeros, an idle host would never baseline at all.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;
    for (let i = 0; i < 14; i += 1) {
      engine.applyPoll(response([measured({ queued: 0, avgQueueingTime: 0 })]), at);
      at += POLL_MS;
    }
    assert.equal(
      engine.snapshot().state,
      'ok',
      'a genuinely idle host must reach a warm baseline of zero',
    );
  });
});

/**
 * No finding message may ever contain the literal string "null" (#51).
 *
 * Found by @tanifgit reviewing #49's fix. Widening `Host.queued` to `number | null` made
 * tsc audit every ARITHMETIC site for free and every STRINGIFICATION site not at all —
 * template literals stringify null happily. `stalled_host` interpolates the depth directly,
 * and its null guard was nested inside `if (rule.requiresQueued)`, so whether an
 * unmeasurable depth was handled depended on a hot-reloadable config flag (ADR 0003):
 *
 *     requiresQueued=false -> "No activity for 900s while null message(s) are queued"
 *
 * One config edit from a projector, and `CLAUDE.md` §2.4 has Dev C render `message`
 * verbatim and authoritative.
 */
describe('no message ever stringifies a null (#51)', () => {
  /** Every nullable proxy count absent at once — the worst case for message building. */
  function unmeasurable(overrides: Partial<ProxyHost> = {}): ProxyHost {
    return proxyHost({
      queued: null,
      errored: null,
      messagesPerSec: null,
      avgProcessingTime: null,
      avgQueueingTime: null,
      lastActivityElapsedSeconds: 900,
      ...overrides,
    });
  }

  /** Sweep the config flags that change which guards run, not just the default config. */
  const flagSets: ReadonlyArray<readonly [string, (c: ThresholdConfig) => void]> = [
    ['defaults', () => {}],
    ['requiresQueued=false', (c) => { c.rules.stalled_host.requiresQueued = false; }],
    ['absoluteFloor=0', (c) => { c.rules.queue_buildup.absoluteFloor = 0; }],
    [
      'both relaxed',
      (c) => {
        c.rules.stalled_host.requiresQueued = false;
        c.rules.queue_buildup.absoluteFloor = 0;
      },
    ],
  ];

  for (const [label, mutate] of flagSets) {
    it(`emits no "null" in any message with ${label}`, () => {
      const config = structuredClone(DEFAULT_CONFIG);
      mutate(config);
      const engine = new DetectionEngine(config, () => {});

      let at = T0;
      // Warm on measurable traffic, then take every count away.
      for (let i = 0; i < 14; i += 1) {
        engine.applyPoll(response([proxyHost()]), at);
        at += POLL_MS;
      }
      for (let i = 0; i < 20; i += 1) {
        engine.applyPoll(response([unmeasurable()]), at);
        at += POLL_MS;
      }

      for (const finding of engine.snapshot().findings) {
        assert.ok(
          !finding.message.includes('null'),
          `${finding.type} rendered a null: "${finding.message}"`,
        );
        assert.ok(
          !finding.message.includes('undefined') && !finding.message.includes('NaN'),
          `${finding.type} rendered a non-value: "${finding.message}"`,
        );
      }
    });
  }

  /**
   * The case that actually builds a message from an unknown count.
   *
   * The four sweeps above null EVERY count, so every rule correctly declines and the
   * assertion loop inspects zero findings — which is the fix working, but it means only
   * the two cases that relax a gate can ever fail. @tanifgit spotted that on #51 and
   * pointed out the gap it leaves: `dead_host` is the one rule that fires DESPITE a null
   * count, because it is absolute, so it is the only rule whose message string can contain
   * an unknown depth. Nothing in the suite asserted a dead_host message at all.
   *
   * Worth pinning rather than hand-checking: dead_host is one of only two findings that
   * fire reliably against live IRIS, so its message is the one most likely to be on screen.
   */
  /*
   * NOTE ON WHAT THIS PINS, having tried to break it three ways: it does NOT distinguish
   * raw from coerced. A coerced 0 fails the `> 0` test, so the note is omitted either way
   * and this passes even with orZero() restored and the rule reading `host.queued`. I
   * claimed otherwise before checking; it isn't true.
   *
   * What it does pin is the OUTPUT — the exact string on screen for the demo's headline
   * finding, which nothing asserted before. Combined with the test below, it pins that the
   * note appears when there is a depth and not when there isn't. That is worth having; it
   * is just a weaker claim than "guards the raw read".
   */
  it('dead_host omits the queue note when the depth is unknown, rather than faking 0', () => {
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(
        response([unmeasurable({ host: 'Cloud API', status: 'Disabled' })]),
        at,
      );
      at += POLL_MS;
    }

    const dead = engine.snapshot().findings.filter((f) => f.type === 'dead_host');
    assert.equal(dead.length, 1, 'dead_host is absolute and must fire without a depth');
    const [finding] = dead;
    assert.ok(finding !== undefined);
    assert.equal(
      finding.message,
      'Cloud API is Disabled',
      'an unknown depth must be omitted, not rendered as "0 message(s) queued"',
    );
  });

  it('dead_host DOES report a measured depth', () => {
    // The other half: 0 is a reading and a positive depth must appear. Without this, the
    // test above would pass on a rule that had simply lost the note entirely.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;
    for (let i = 0; i < 3; i += 1) {
      engine.applyPoll(
        response([proxyHost({ host: 'Cloud API', status: 'Disabled', queued: 6 })]),
        at,
      );
      at += POLL_MS;
    }
    const [finding] = engine.snapshot().findings.filter((f) => f.type === 'dead_host');
    assert.ok(finding !== undefined);
    assert.equal(finding.message, 'Cloud API is Disabled with 6 message(s) queued');
  });
});

/**
 * The wire must carry `null` through for the two fields the schema declares nullable.
 *
 * This closes a hole @tanifgit found on #52: with the coercion RESTORED on `main`, all
 * 167 tests still passed. Nothing defended the un-coerced wire, so `orZero()` could come
 * back for `queued`/`errored` and no check would object — which is exactly how it survived
 * past its justification in the first place (a test asserting "no nullable numerics"
 * actively kept it alive until #51).
 *
 * A permitted-but-unexercised path decays. Their side now REQUIRES a fixture to render the
 * em dash; this is the same requirement one layer up, on the producer.
 *
 * Scope is deliberate: only `queued` and `errored`. The schema still declares
 * messagesPerSec, avgProcessingTime and avgQueueingTime as plain numbers, so coercing
 * those is REQUIRED and asserted below — widening them is a contract PR, not a fix.
 */
describe('the published wire preserves null where the schema allows it (#52)', () => {
  /** Every nullable proxy count absent — what an undescribed host looks like (#36). */
  function unmeasured(overrides: Partial<ProxyHost> = {}): ProxyHost {
    return proxyHost({
      queued: null,
      errored: null,
      messagesPerSec: null,
      avgProcessingTime: null,
      avgQueueingTime: null,
      ...overrides,
    });
  }

  it('serves queued and errored as null, not 0', () => {
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    engine.applyPoll(response([unmeasured()]), T0);

    const [host] = engine.snapshot().hosts;
    assert.ok(host !== undefined);
    assert.equal(host.queued, null, 'a coerced 0 here is a confident lie about a real host');
    assert.equal(host.errored, null, 'same for errored — absent is not "no errors"');
  });

  it('still coerces the three fields the schema declares as plain numbers', () => {
    // The other half of the contract. If this fails, we are emitting null against a
    // non-nullable field and Dev C's guard is entitled to reject the whole host (#32).
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    engine.applyPoll(response([unmeasured()]), T0);

    const [host] = engine.snapshot().hosts;
    assert.ok(host !== undefined);
    for (const field of ['messagesPerSec', 'avgProcessingTime', 'avgQueueingTime'] as const) {
      assert.equal(
        typeof host[field],
        'number',
        `Host.${field} is not nullable in the schema — widening it is a contracts/ PR`,
      );
    }
  });

  it('keeps a measured zero distinguishable from an absent count', () => {
    // The distinction the whole of #49 turns on. If both render as 0 the dashboard cannot
    // tell "nothing queued" from "depth unknown", which is what the em dash exists for.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    engine.applyPoll(
      response([
        proxyHost({ host: 'Measured', queued: 0, errored: 0 }),
        unmeasured({ host: 'Unknown' }),
      ]),
      T0,
    );

    const byHost = new Map(engine.snapshot().hosts.map((h) => [h.host, h]));
    assert.equal(byHost.get('Measured')?.queued, 0, 'a measured zero is a reading');
    assert.equal(byHost.get('Unknown')?.queued, null, 'an absent count is not');
  });
});

/**
 * stalled_host must not read a fabricated activity timestamp (#58).
 *
 * Found by @tanifgit reviewing #54 — its argument that a permitted-but-unexercised path
 * decays is what sent them to the field #54's scope excluded.
 *
 * `Host.lastActivity` is a REQUIRED non-nullable date-time in the published schema, so
 * `normalizeHost()` has to publish something when IRIS emits no `iris_interop_last_activity`
 * line — and it publishes the poll's own clock. Reading that back gave `idleSeconds = 0` on
 * every poll, so the rule was silently unable to fire for such a host: measured 30 minutes of
 * idle-with-queue producing nothing, ever, because the fabricated timestamp advances with the
 * poll.
 *
 * WHAT THESE THREE TESTS DO AND DO NOT PIN: they do **not** catch the old code. Reverting the
 * fix leaves all three passing, because `normalizeHost()` sets `lastActivity = now - elapsed`,
 * so any test entering through `applyPoll` is measuring an identity — the two readings cannot
 * disagree there. Verified the old path could not fire even at `inactiveSeconds: 1`.
 *
 * The regression IS pinnable, at the rule boundary, where the input can be a combination
 * normalizeHost never emits: see "declines when the idle time is unknown, even if the
 * published stamp is stale" in `rules.test.ts` (@tanifgit, #60 review). I had concluded no
 * test could distinguish the two paths; that was wrong, and it was wrong because I only
 * checked the entry point I had already been using.
 *
 * These three still earn their place: they pin the behaviour end to end, which the
 * rule-boundary test does not.
 *
 * The part of #58 that IS a live defect is the published `Host.lastActivity`, which still
 * carries the poll clock for a host that has never run. That needs a nullable field, i.e. a
 * `contracts/` change, and is deliberately not in this PR.
 *
 * Both real captures on `main` before #53 had ZERO activity lines, so this was the live state,
 * not a hypothetical.
 */
describe('stalled_host declines on an unmeasured activity time (#58)', () => {
  /** Idle with a queue — everything stalled_host needs except a real activity reading. */
  function idleWithQueue(overrides: Partial<ProxyHost> = {}): ProxyHost {
    return proxyHost({ status: 'OK', queued: 6, lastActivityElapsedSeconds: null, ...overrides });
  }

  it('stays silent through 30 minutes of idle-with-queue when the line is absent', () => {
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;
    for (let i = 0; i < 400; i += 1) {
      engine.applyPoll(response([idleWithQueue()]), at);
      at += POLL_MS;
    }
    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'an absent activity reading is not evidence of a stall',
    );
  });

  it('fires as soon as a REAL elapsed value arrives, so the path is not dead', () => {
    // Without this, the test above would pass on a rule that could never fire at all.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    let at = T0;
    for (let i = 0; i < 390; i += 1) {
      engine.applyPoll(response([idleWithQueue()]), at);
      at += POLL_MS;
    }
    for (let i = 0; i < 10; i += 1) {
      engine.applyPoll(response([idleWithQueue({ lastActivityElapsedSeconds: 1800 })]), at);
      at += POLL_MS;
    }
    assert.ok(
      engine.snapshot().findings.some((f) => f.type === 'stalled_host'),
      'a measured 1800s idle with a queue must fire',
    );
  });

  it('does not let the published lastActivity drive the verdict', () => {
    // The mechanism, asserted directly: lastActivity tracks the poll clock when the reading
    // is absent, and the rule must not be reading it. If it were, idleSeconds would be ~0.
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), () => {});
    const at = T0 + 60 * POLL_MS;
    engine.applyPoll(response([idleWithQueue()]), at);

    const [host] = engine.snapshot().hosts;
    assert.ok(host !== undefined);
    assert.equal(
      host.lastActivity,
      new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'the published field still carries the poll clock — that is the contract constraint',
    );
    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'but no rule may treat that as a measurement',
    );
  });
});

/**
 * An alert matching no host is logged, not silently dropped (#61).
 *
 * `system_alert` matches by host name appearing in the message text, so instance-level
 * alerts — disk space, license limit, journal full, write daemon — produce no finding at all.
 * That limitation is deliberate for MVP 1 (CLAUDE.md §5.2b), but it must be visible: a
 * consumer cannot tell "no such alert" from "alert discarded" by reading either endpoint.
 *
 * Raised by @tanifgit on #61, who noted they would have guessed such alerts appeared
 * unattributed rather than not at all — which is the reason the gap has to be stated rather
 * than merely accepted.
 */
describe('unattributed alerts are logged (#61)', () => {
  function withAlert(message: string): ProxyResponse {
    return {
      ...response([proxyHost({ host: 'Cloud API' })]),
      alerts: [{ time: '2026-08-06T15:59:00Z', severity: '1', message }],
    };
  }

  it('logs an instance-level alert and emits no finding for it', () => {
    const lines: string[] = [];
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), (m) => lines.push(m));
    engine.applyPoll(withAlert('Journal file system is full'), T0);

    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'an alert naming no host must not produce a finding',
    );
    assert.equal(lines.length, 1, `expected one log line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0] ?? '', /matches no reported host/);
    assert.match(lines[0] ?? '', /Journal file system is full/, 'the text must be quoted');
  });

  it('logs it ONCE, not every poll', () => {
    // Same reasoning as #warnedOverrides: a persistent alert would otherwise fill the log.
    const lines: string[] = [];
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), (m) => lines.push(m));
    let at = T0;
    for (let i = 0; i < 20; i += 1) {
      engine.applyPoll(withAlert('License limit exceeded'), at);
      at += POLL_MS;
    }
    assert.equal(lines.length, 1, `logged ${lines.length} times across 20 polls`);
  });

  it('logs an alert naming a FRAMEWORK host, which is configured but not reported', () => {
    // @tanifgit's fourth case on #62, and the one most likely to be hit: /api/monitor/alerts
    // is largely about IRIS's own subsystems. A framework item IS a config item, but
    // applyPoll skips isFrameworkHost() before building seenHosts, so it is not a candidate
    // for attribution and the alert produces no finding.
    //
    // Pins against a plausible tidy-up: build seenHosts BEFORE the framework guard and a
    // framework-named alert stops being logged while still producing no finding — straight
    // back to invisible, with the other three tests green.
    const lines: string[] = [];
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), (m) => lines.push(m));
    engine.applyPoll(
      {
        ...response([
          proxyHost({ host: 'Cloud API' }),
          proxyHost({ host: 'Ens.MonitorService', isFramework: true }),
        ]),
        alerts: [
          { time: '2026-08-06T15:59:00Z', severity: '1', message: 'Ens.MonitorService failed to start' },
        ],
      },
      T0,
    );

    assert.deepEqual(
      engine.snapshot().findings.map((f) => f.type),
      [],
      'a framework host is not an attribution candidate',
    );
    assert.equal(lines.length, 1, `expected the gap to be logged, got ${JSON.stringify(lines)}`);
    assert.match(lines[0] ?? '', /no reported host/, 'and "reported" is the accurate word');
  });

  it('does NOT log an alert that does name a host', () => {
    // Otherwise the log would fire on exactly the alerts that work correctly.
    const lines: string[] = [];
    const engine = new DetectionEngine(structuredClone(DEFAULT_CONFIG), (m) => lines.push(m));
    engine.applyPoll(withAlert('Cloud API failed to send message'), T0);
    engine.applyPoll(withAlert('Cloud API failed to send message'), T0 + POLL_MS);

    assert.deepEqual(lines, [], 'a host-attributable alert is handled, not reported as a gap');
    assert.ok(
      engine.snapshot().findings.some((f) => f.type === 'system_alert'),
      'and it must still fire',
    );
  });
});
