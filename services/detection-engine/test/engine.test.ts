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
import { DEFAULT_CONFIG, type ThresholdConfig } from '../src/config/thresholds.ts';
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

    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'OK' })]), at);
    assert.equal(engine.snapshot().findings.length, 0, 'no tombstones, no resolvedAt');
  });

  it('forgets a host that leaves the production', () => {
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = warmUp(engine);

    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    at += POLL_MS;
    engine.applyPoll(response([proxyHost({ status: 'Disabled' })]), at);
    assert.equal(engine.snapshot().findings.length, 1);

    at += POLL_MS;
    engine.applyPoll(response([]), at);
    const snapshot = engine.snapshot();
    assert.equal(snapshot.hosts.length, 0);
    assert.equal(snapshot.findings.length, 0);
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

    // The alert ages out of the proxy payload — the finding clears, per contract Q4.
    engine.applyPoll(response([proxyHost()]), T0 + 3 * POLL_MS);
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
    const engine = new DetectionEngine({ ...DEFAULT_CONFIG, sustainedSamples: 1 });
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
    const engine = new DetectionEngine({ ...DEFAULT_CONFIG, sustainedSamples: 1 });
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
    const engine = new DetectionEngine({ ...DEFAULT_CONFIG, sustainedSamples: 1 });
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
