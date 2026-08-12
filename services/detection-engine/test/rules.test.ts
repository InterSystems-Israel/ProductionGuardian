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
import type { RawHostMetrics, Rule, RuleVerdict } from '../src/detect/rules/types.ts';
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
  extra: {
    errorsPerMinute?: number | null;
    config?: ThresholdConfig;
    now?: number;
    /** Override a raw value to test the "not measurable" path rather than "measured zero". */
    raw?: Partial<RawHostMetrics>;
  } = {},
): RuleVerdict | null {
  return ruleFor(type).evaluate({
    host: h,
    errorsPerMinute: extra.errorsPerMinute ?? null,
    // Default the raw values to mirror the normalized host, so existing cases are
    // unaffected; a test opts in to nullability explicitly via `extra.raw`.
    raw: {
      queued: h.queued,
      messagesPerSec: h.messagesPerSec,
      errored: h.errored,
      avgProcessingTime: h.avgProcessingTime,
      avgQueueingTime: h.avgQueueingTime,
      ...extra.raw,
    },
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

  describe('zero baseline — the infinite-ratio path', () => {
    // A zero baseline makes every ratio infinite, so the bands cannot grade it and the
    // floor is the whole gate. This used to hardcode `critical`, meaning a host whose
    // normal wait is 0 went silent -> critical at the floor with no warning tier. Found
    // by Dev C on #20. LABDEMO measures 0 here on two of three hosts, so this is the
    // common case rather than an edge one.
    const floor = DEFAULT_CONFIG.rules.growing_queue_wait.absoluteFloorSeconds;
    const criticalAt = floor * DEFAULT_CONFIG.rules.growing_queue_wait.criticalFloorMultiple;

    it('does NOT fire below the floor', () => {
      const verdict = evaluate(
        'growing_queue_wait',
        host({ avgQueueingTime: floor * 0.5 }),
        warmBaseline('avgQueueingTime', 0),
      );
      assert.equal(verdict, null);
    });

    it('warns at the floor rather than going straight to critical', () => {
      const verdict = evaluate(
        'growing_queue_wait',
        host({ avgQueueingTime: floor }),
        warmBaseline('avgQueueingTime', 0),
      );
      assert.ok(verdict !== null);
      assert.equal(verdict.severity, 'warning', 'the floor must not be a critical trigger');
    });

    it('still warns just below the critical multiple', () => {
      const verdict = evaluate(
        'growing_queue_wait',
        host({ avgQueueingTime: criticalAt * 0.99 }),
        warmBaseline('avgQueueingTime', 0),
      );
      assert.equal(verdict?.severity, 'warning');
    });

    it('escalates to critical at the critical multiple', () => {
      const verdict = evaluate(
        'growing_queue_wait',
        host({ avgQueueingTime: criticalAt }),
        warmBaseline('avgQueueingTime', 0),
      );
      assert.equal(verdict?.severity, 'critical');
    });

    it('omits the ratio from the message, since there is no honest one to state', () => {
      const verdict = evaluate(
        'growing_queue_wait',
        host({ avgQueueingTime: 1.0 }),
        warmBaseline('avgQueueingTime', 0),
      );
      assert.ok(verdict !== null);
      assert.doesNotMatch(verdict.message, /baseline/, 'must not claim an Infinity ratio');
    });

    it('applies the same two tiers to slow_processing', () => {
      const procFloor = DEFAULT_CONFIG.rules.slow_processing.absoluteFloorSeconds;
      const procCritical = procFloor * DEFAULT_CONFIG.rules.slow_processing.criticalFloorMultiple;
      const atFloor = evaluate(
        'slow_processing',
        host({ avgProcessingTime: procFloor }),
        warmBaseline('avgProcessingTime', 0),
      );
      const atCritical = evaluate(
        'slow_processing',
        host({ avgProcessingTime: procCritical }),
        warmBaseline('avgProcessingTime', 0),
      );
      assert.equal(atFloor?.severity, 'warning');
      assert.equal(atCritical?.severity, 'critical');
    });
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

describe('unmeasurable metrics are not symptoms (#33)', () => {
  // normalizeHost() collapses a null count to 0 for the published Host shape, because the
  // contract declares queued/errored as required integers. Rules must therefore read the
  // RAW values -- Dev C found two defects caused by reading the normalized ones.

  it('throughput_drop stays silent when the rate is not measurable', () => {
    // The one rule where LOWER is worse, so the only one where a coerced 0 reads as a
    // symptom. A null rate became 0 and reported a 100% collapse of a healthy production.
    const verdict = evaluate(
      'throughput_drop',
      host({ messagesPerSec: 0 }),
      warmBaseline('messagesPerSec', 1.2),
      { raw: { messagesPerSec: null } },
    );
    assert.equal(verdict, null, 'an absent rate is not a collapsed one');
  });

  it('throughput_drop still fires on a REAL zero', () => {
    // The guard must suppress absence, not detection.
    const verdict = evaluate(
      'throughput_drop',
      host({ messagesPerSec: 0 }),
      warmBaseline('messagesPerSec', 1.2),
      { raw: { messagesPerSec: 0 } },
    );
    assert.equal(verdict?.severity, 'critical');
    assert.match(verdict?.message ?? '', /100% below baseline/);
  });

  it('stalled_host declines when the queue depth is unknown', () => {
    // Deliberate: an idle host with an unknown queue is more likely quiet than hung, and
    // firing on absent data is the false positive MVP §6 names as the top risk. What was
    // wrong before was that this happened by accident, via a coerced zero.
    const verdict = evaluate(
      'stalled_host',
      host({ queued: 0, lastActivity: new Date(NOW - 400_000).toISOString() }),
      new BaselineStore(1800, 12),
      { raw: { queued: null } },
    );
    assert.equal(verdict, null);
  });

  it('stalled_host fires when the depth is measurable and non-zero', () => {
    const verdict = evaluate(
      'stalled_host',
      host({ queued: 5, lastActivity: new Date(NOW - 400_000).toISOString() }),
      new BaselineStore(1800, 12),
      { raw: { queued: 5 } },
    );
    assert.ok(verdict !== null, 'a real backed-up idle host must still be reported');
    assert.equal(verdict.severity, 'warning');
  });

  it('stalled_host still declines on a measured empty queue', () => {
    const verdict = evaluate(
      'stalled_host',
      host({ queued: 0, lastActivity: new Date(NOW - 400_000).toISOString() }),
      new BaselineStore(1800, 12),
      { raw: { queued: 0 } },
    );
    assert.equal(verdict, null, 'idle with nothing to do is healthy');
  });

  it('the duration rules are unaffected, since higher is worse for them', () => {
    // Recorded because it is the cleanest way to see why only throughput_drop broke: a
    // coerced 0 falls under these floors and correctly produces nothing.
    for (const type of ['slow_processing', 'growing_queue_wait'] as const) {
      const metric = type === 'slow_processing' ? 'avgProcessingTime' : 'avgQueueingTime';
      const verdict = evaluate(type, host({ [metric]: 0 } as never), warmBaseline(metric, 0.08), {
        raw: { [metric]: null } as never,
      });
      assert.equal(verdict, null, `${type} should be silent on an absent value`);
    }
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
