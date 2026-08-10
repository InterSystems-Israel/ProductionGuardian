/**
 * Rule tests.
 *
 * Every rule gets a fires case AND a does-not-fire case. A rule that fires correctly
 * but never stops is broken, and a positive-only suite would not notice.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BaselineStore } from '../src/baseline/window.ts';
import { DEFAULT_CONFIG, type ThresholdConfig } from '../src/config/thresholds.ts';
import { HOST_RULES } from '../src/detect/rules/index.ts';
import type { Rule, RuleVerdict } from '../src/detect/rules/types.ts';
import type { Host } from '../src/types/healthscan.ts';

const NOW = Date.parse('2026-08-06T16:00:00Z');

function ruleFor(type: string): Rule {
  const rule = HOST_RULES.find((candidate) => candidate.type === type);
  assert.ok(rule !== undefined, `rule ${type} not registered`);
  return rule;
}

function host(overrides: Partial<Host> = {}): Host {
  return {
    host: 'Lab Router',
    type: 'process',
    status: 'OK',
    queued: 0,
    messagesPerSec: 1.2,
    errored: 0,
    avgProcessingTime: 0.08,
    avgQueueingTime: 0,
    lastActivity: new Date(NOW - 4000).toISOString(),
    ...overrides,
  };
}

/** A baseline store already warm at `value` for one metric. */
function warmBaseline(
  metric: Parameters<BaselineStore['record']>[1],
  value: number,
  hostName = 'Lab Router',
): BaselineStore {
  const store = new BaselineStore(1800, DEFAULT_CONFIG.minBaselineSamples);
  for (let i = 0; i < DEFAULT_CONFIG.minBaselineSamples; i += 1) {
    store.record(hostName, metric, value, NOW - (DEFAULT_CONFIG.minBaselineSamples - i) * 10_000);
  }
  return store;
}

function evaluate(
  type: string,
  h: Host,
  baselines: BaselineStore,
  extra: { errorsPerMinute?: number | null; config?: ThresholdConfig; now?: number } = {},
): RuleVerdict | null {
  return ruleFor(type).evaluate({
    host: h,
    errorsPerMinute: extra.errorsPerMinute ?? null,
    baselines,
    config: extra.config ?? DEFAULT_CONFIG,
    now: extra.now ?? NOW,
  });
}

describe('dead_host', () => {
  it('fires for each status that means not working', () => {
    for (const status of ['Error', 'Inactive', 'Stopped', 'Disabled']) {
      const verdict = evaluate('dead_host', host({ status }), new BaselineStore(1800, 12));
      assert.ok(verdict !== null, `expected ${status} to fire`);
      assert.equal(verdict.severity, 'critical');
      assert.equal(verdict.baselineValue, null, 'absolute rule reports no baseline');
      assert.match(verdict.message, new RegExp(status));
    }
  });

  it('does NOT fire for OK', () => {
    assert.equal(evaluate('dead_host', host({ status: 'OK' }), new BaselineStore(1800, 12)), null);
  });

  it('does NOT fire for Retry — degraded but alive', () => {
    assert.equal(
      evaluate('dead_host', host({ status: 'Retry' }), new BaselineStore(1800, 12)),
      null,
    );
  });

  it('fires with no baseline at all, being absolute', () => {
    const verdict = evaluate('dead_host', host({ status: 'Disabled' }), new BaselineStore(1800, 12));
    assert.ok(verdict !== null);
  });

  it('mentions the queue when messages are stuck', () => {
    const verdict = evaluate(
      'dead_host',
      host({ status: 'Disabled', queued: 48 }),
      new BaselineStore(1800, 12),
    );
    assert.ok(verdict !== null);
    assert.match(verdict.message, /48 message/);
  });
});

describe('stalled_host', () => {
  const idle = () => host({ queued: 12, lastActivity: new Date(NOW - 400_000).toISOString() });

  it('fires when idle beyond the threshold with messages queued', () => {
    const verdict = evaluate('stalled_host', idle(), new BaselineStore(1800, 12));
    assert.ok(verdict !== null);
    assert.equal(verdict.severity, 'warning');
    assert.match(verdict.message, /12 message/);
  });

  it('does NOT fire when idle but the queue is empty', () => {
    const verdict = evaluate(
      'stalled_host',
      host({ queued: 0, lastActivity: new Date(NOW - 400_000).toISOString() }),
      new BaselineStore(1800, 12),
    );
    assert.equal(verdict, null, 'an idle host with nothing to do is healthy');
  });

  it('does NOT fire when recently active despite a queue', () => {
    const verdict = evaluate(
      'stalled_host',
      host({ queued: 12, lastActivity: new Date(NOW - 5000).toISOString() }),
      new BaselineStore(1800, 12),
    );
    assert.equal(verdict, null);
  });

  it('defers to dead_host rather than double-reporting', () => {
    const verdict = evaluate(
      'stalled_host',
      host({ status: 'Disabled', queued: 12, lastActivity: new Date(NOW - 400_000).toISOString() }),
      new BaselineStore(1800, 12),
    );
    assert.equal(verdict, null, 'one condition should produce one finding');
  });
});

describe('queue_buildup', () => {
  it('fires when over both the multiplier and the floor', () => {
    const verdict = evaluate('queue_buildup', host({ queued: 486 }), warmBaseline('queued', 15));
    assert.ok(verdict !== null);
    assert.equal(verdict.baselineValue, 15);
    assert.equal(verdict.currentValue, 486);
    assert.match(verdict.message, /Queue depth 486 is 32x baseline/);
  });

  it('does NOT fire on a big ratio below the absolute floor', () => {
    // 5 is 5x a baseline of 1 -- exactly the noise the floor exists to suppress.
    assert.equal(evaluate('queue_buildup', host({ queued: 5 }), warmBaseline('queued', 1)), null);
  });

  it('does NOT fire on a big depth that is normal for the host', () => {
    const verdict = evaluate('queue_buildup', host({ queued: 60 }), warmBaseline('queued', 55));
    assert.equal(verdict, null, '60 vs a baseline of 55 is not a buildup');
  });

  it('does NOT fire while the baseline is warming up', () => {
    const cold = new BaselineStore(1800, 12);
    cold.record('Lab Router', 'queued', 15, NOW - 10_000);
    assert.equal(evaluate('queue_buildup', host({ queued: 486 }), cold), null);
  });

  it('treats a zero baseline as critical once past the floor', () => {
    const verdict = evaluate('queue_buildup', host({ queued: 48 }), warmBaseline('queued', 0), {
      config: {
        ...DEFAULT_CONFIG,
        rules: {
          ...DEFAULT_CONFIG.rules,
          queue_buildup: { ...DEFAULT_CONFIG.rules.queue_buildup, absoluteFloor: 40 },
        },
      },
    });
    assert.ok(verdict !== null);
    assert.equal(verdict.severity, 'critical');
    assert.match(verdict.message, /no baseline queue/);
  });

  it('escalates to critical past the critical band', () => {
    const verdict = evaluate('queue_buildup', host({ queued: 500 }), warmBaseline('queued', 20));
    assert.ok(verdict !== null);
    assert.equal(verdict.severity, 'critical', '25x is past the 20x critical band');
  });
});

describe('elevated_error_rate', () => {
  it('fires when the rate exceeds baseline and the floor', () => {
    const verdict = evaluate('elevated_error_rate', host(), warmBaseline('errorsPerMinute', 0.5), {
      errorsPerMinute: 6,
    });
    assert.ok(verdict !== null);
    assert.match(verdict.message, /errors\/min/);
  });

  it('does NOT fire below the per-minute floor', () => {
    const verdict = evaluate('elevated_error_rate', host(), warmBaseline('errorsPerMinute', 0.01), {
      errorsPerMinute: 0.5,
    });
    assert.equal(verdict, null, 'half an error a minute is not a storm');
  });

  it('does NOT fire on the first sample, when rate is unknowable', () => {
    const verdict = evaluate('elevated_error_rate', host(), warmBaseline('errorsPerMinute', 0.5), {
      errorsPerMinute: null,
    });
    assert.equal(verdict, null);
  });
});

describe('slow_processing', () => {
  it('fires when over the multiplier and the floor', () => {
    const verdict = evaluate(
      'slow_processing',
      host({ avgProcessingTime: 2.4 }),
      warmBaseline('avgProcessingTime', 0.08),
    );
    assert.ok(verdict !== null);
    assert.match(verdict.message, /Average processing time 2\.40s is 30x baseline/);
  });

  it('does NOT fire on a large ratio still under the floor', () => {
    // 0.4s is 5x a 0.08s baseline, but well under a second -- nobody cares.
    const verdict = evaluate(
      'slow_processing',
      host({ avgProcessingTime: 0.4 }),
      warmBaseline('avgProcessingTime', 0.08),
    );
    assert.equal(verdict, null);
  });

  it('honours a per-host override', () => {
    const config: ThresholdConfig = {
      ...DEFAULT_CONFIG,
      hostOverrides: { 'Cloud API': { slow_processing: { absoluteFloorSeconds: 5.0 } } },
    };
    const cloudBaseline = warmBaseline('avgProcessingTime', 0.05, 'Cloud API');
    const verdict = evaluate(
      'slow_processing',
      host({ host: 'Cloud API', avgProcessingTime: 2.0 }),
      cloudBaseline,
      { config },
    );
    assert.equal(verdict, null, '2s is under the overridden 5s floor');
  });
});

describe('growing_queue_wait', () => {
  it('fires when queue wait balloons', () => {
    const verdict = evaluate(
      'growing_queue_wait',
      host({ avgQueueingTime: 1.84 }),
      warmBaseline('avgQueueingTime', 0.02),
    );
    assert.ok(verdict !== null);
    assert.match(verdict.message, /Average queue wait 1\.84s/);
  });

  it('does NOT fire on a healthy sub-second wait', () => {
    const verdict = evaluate(
      'growing_queue_wait',
      host({ avgQueueingTime: 0.03 }),
      warmBaseline('avgQueueingTime', 0.02),
    );
    assert.equal(verdict, null);
  });
});

describe('throughput_drop', () => {
  it('fires when throughput collapses', () => {
    const verdict = evaluate(
      'throughput_drop',
      host({ messagesPerSec: 0.2 }),
      warmBaseline('messagesPerSec', 1.2),
    );
    assert.ok(verdict !== null);
    assert.match(verdict.message, /83% below baseline/);
  });

  it('does NOT fire on a mild dip', () => {
    const verdict = evaluate(
      'throughput_drop',
      host({ messagesPerSec: 1.0 }),
      warmBaseline('messagesPerSec', 1.2),
    );
    assert.equal(verdict, null);
  });

  it('does NOT fire when the baseline is too quiet to judge', () => {
    const verdict = evaluate(
      'throughput_drop',
      host({ messagesPerSec: 0 }),
      warmBaseline('messagesPerSec', 0.05),
    );
    assert.equal(verdict, null, 'a near-idle host cannot meaningfully drop');
  });

  it('escalates to critical on a total stop', () => {
    const verdict = evaluate(
      'throughput_drop',
      host({ messagesPerSec: 0 }),
      warmBaseline('messagesPerSec', 1.2),
    );
    assert.ok(verdict !== null);
    assert.equal(verdict.severity, 'critical');
  });
});

describe('rule registration', () => {
  it('registers seven per-host rules; system_alert is engine-level', () => {
    assert.equal(HOST_RULES.length, 7);
    const types = HOST_RULES.map((rule) => rule.type).sort();
    assert.deepEqual(types, [
      'dead_host',
      'elevated_error_rate',
      'growing_queue_wait',
      'queue_buildup',
      'slow_processing',
      'stalled_host',
      'throughput_drop',
    ]);
  });

  it('respects enabled: false', () => {
    const config: ThresholdConfig = {
      ...DEFAULT_CONFIG,
      rules: {
        ...DEFAULT_CONFIG.rules,
        dead_host: { ...DEFAULT_CONFIG.rules.dead_host, enabled: false },
      },
    };
    const verdict = evaluate('dead_host', host({ status: 'Disabled' }), new BaselineStore(1800, 12), {
      config,
    });
    assert.equal(verdict, null);
  });
});
