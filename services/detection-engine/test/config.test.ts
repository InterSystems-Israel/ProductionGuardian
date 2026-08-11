/**
 * Threshold config tests — ADR 0003.
 *
 * The critical property is that a BAD config is REJECTED rather than partly applied.
 * A zero multiplier that slipped through would make every rule fire on every sample,
 * which is the exact failure mode conservative defaults exist to prevent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  configFor,
  declaredOverrideHosts,
  inertOverrideHosts,
  validateConfig,
} from '../src/config/thresholds.ts';

describe('validation accepts', () => {
  it('the committed thresholds.json shape', () => {
    const config = validateConfig({
      sustainedSamples: 2,
      minBaselineSamples: 12,
      rules: { queue_buildup: { absoluteFloor: 100 } },
    });
    assert.equal(config.sustainedSamples, 2);
    assert.equal(config.rules.queue_buildup.absoluteFloor, 100);
  });

  it('a partial file, inheriting the rest from defaults', () => {
    const config = validateConfig({ rules: { queue_buildup: { absoluteFloor: 99 } } });
    assert.equal(config.rules.queue_buildup.absoluteFloor, 99);
    assert.equal(
      config.rules.queue_buildup.baselineMultiplier,
      DEFAULT_CONFIG.rules.queue_buildup.baselineMultiplier,
      'unspecified fields keep their default',
    );
    assert.equal(config.rules.dead_host.enabled, true);
  });

  it('_comment keys, which the committed file uses for documentation', () => {
    const config = validateConfig({
      _comment: 'explanatory text',
      rules: { _comment: 'more text', queue_buildup: { _comment: 'note', absoluteFloor: 60 } },
      hostOverrides: { _comment: 'note' },
    });
    assert.equal(config.rules.queue_buildup.absoluteFloor, 60);
  });

  it('enabled: false, which is a boolean not a bound', () => {
    const config = validateConfig({ rules: { dead_host: { enabled: false } } });
    assert.equal(config.rules.dead_host.enabled, false);
  });
});

describe('validation rejects', () => {
  it('a zero multiplier, which would make a rule fire always', () => {
    assert.throws(
      () => validateConfig({ rules: { queue_buildup: { baselineMultiplier: 0 } } }),
      ConfigValidationError,
    );
  });

  it('a negative bound', () => {
    assert.throws(
      () => validateConfig({ rules: { stalled_host: { inactiveSeconds: -5 } } }),
      ConfigValidationError,
    );
  });

  it('a non-finite bound', () => {
    assert.throws(
      () => validateConfig({ sustainedSamples: Number.POSITIVE_INFINITY }),
      ConfigValidationError,
    );
  });

  it('an unknown rule name, which is usually a typo', () => {
    assert.throws(
      () => validateConfig({ rules: { queue_buldup: { absoluteFloor: 50 } } }),
      ConfigValidationError,
    );
  });

  it('a zero severity band', () => {
    assert.throws(
      () => validateConfig({ rules: { queue_buildup: { severityBands: { warning: 0 } } } }),
      ConfigValidationError,
    );
  });

  it('a non-object payload', () => {
    assert.throws(() => validateConfig('not a config'), ConfigValidationError);
    assert.throws(() => validateConfig(null), ConfigValidationError);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      validateConfig({ sustainedSamples: 0, minBaselineSamples: -1 });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ConfigValidationError);
      assert.equal(err.problems.length, 2);
    }
  });

  it('does not partly apply a rejected file', () => {
    // The valid sibling field must not survive the rejection.
    assert.throws(
      () =>
        validateConfig({
          rules: { queue_buildup: { absoluteFloor: 999, baselineMultiplier: -1 } },
        }),
      ConfigValidationError,
    );
    assert.equal(
      DEFAULT_CONFIG.rules.queue_buildup.absoluteFloor,
      50,
      'DEFAULT_CONFIG must not have been mutated',
    );
  });
});

describe('per-host overrides', () => {
  it('merges over the rule default, keeping unspecified fields', () => {
    const config = validateConfig({
      hostOverrides: { 'Cloud API': { slow_processing: { absoluteFloorSeconds: 2.0 } } },
    });
    const cloud = configFor(config, 'slow_processing', 'Cloud API');
    assert.equal(cloud.absoluteFloorSeconds, 2.0);
    assert.equal(
      cloud.baselineMultiplier,
      DEFAULT_CONFIG.rules.slow_processing.baselineMultiplier,
      'an override is partial',
    );
  });

  it('leaves other hosts untouched', () => {
    const config = validateConfig({
      hostOverrides: { 'Cloud API': { slow_processing: { absoluteFloorSeconds: 9.0 } } },
    });
    const router = configFor(config, 'slow_processing', 'Lab Router');
    assert.equal(router.absoluteFloorSeconds, DEFAULT_CONFIG.rules.slow_processing.absoluteFloorSeconds);
  });

  it('returns the rule default for a host with no override', () => {
    const config = validateConfig({});
    assert.deepEqual(
      configFor(config, 'queue_buildup', 'Lab Router'),
      DEFAULT_CONFIG.rules.queue_buildup,
    );
  });
});

describe('inert host overrides (#25)', () => {
  // hostOverrides is keyed by a literal host name, so pointing the engine at another
  // production makes every override inert -- silently. The tuning stops applying and
  // nothing says so, which is the same silent-weakening shape as `npm test --if-present`
  // reporting green on nothing.
  const config = validateConfig({
    hostOverrides: { 'Cloud API': { slow_processing: { absoluteFloorSeconds: 0.3 } } },
  });

  it('ignores _comment keys when listing declared overrides', () => {
    const documented = validateConfig({
      hostOverrides: {
        _comment: 'rare and always commented',
        'Cloud API': { slow_processing: { absoluteFloorSeconds: 0.3 } },
      },
    });
    assert.deepEqual(declaredOverrideHosts(documented), ['Cloud API']);
  });

  it('reports an override that matches no observed host', () => {
    assert.deepEqual(inertOverrideHosts(config, ['Tick Feed', 'Risk Filter']), ['Cloud API']);
  });

  it('reports nothing when the override does apply', () => {
    assert.deepEqual(inertOverrideHosts(config, ['Cloud API', 'Lab Router']), []);
  });

  it('reports every declared override when no hosts have been seen at all', () => {
    assert.deepEqual(inertOverrideHosts(config, []), ['Cloud API']);
  });

  it('does not report anything when no overrides are declared', () => {
    assert.deepEqual(inertOverrideHosts(validateConfig({}), ['Tick Feed']), []);
  });
});
