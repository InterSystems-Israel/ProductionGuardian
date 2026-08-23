/**
 * The SHIPPED reference baselines, not the mechanism.
 *
 * `earlywarning.test.ts` and `silence.test.ts` already cover what a reference baseline *does*, using
 * synthetic configs. That coverage was green while the reported defect was live, because the
 * mechanism was correct and the committed file only used it for one host+metric pair out of nine.
 *
 * So this suite reads `thresholds.json` itself and asserts the two properties a demo depends on:
 *
 *   1. Every comparative metric on every LABDEMO host has a stated normal, so none of them can
 *      self-inflate. That is the defect @Ari-Glikman reported: `growing_queue_wait` went CRITICAL
 *      and then fell back to WARNING while the wait was still growing, because the rolling mean
 *      climbed with it.
 *   2. A severely broken value reaches CRITICAL and STAYS there. The severity an operator sees must
 *      not decay while the condition worsens.
 *
 * HOST NAMES ARE READ FROM THE FILE, not listed here. Root `CLAUDE.md` §6 makes
 * `iris/labdemo/Production.cls` the authority for the host list, and a copy in a test is exactly what
 * went stale when `FHIR Transform` was removed (#84). These assertions are therefore about
 * *completeness relative to what the file declares*, which is the invariant that actually matters.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { effectiveBaseline, validateConfig, type ThresholdConfig } from '../src/config/thresholds.ts';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG: ThresholdConfig = validateConfig(
  JSON.parse(readFileSync(resolve(serviceRoot, 'thresholds.json'), 'utf8')),
);

/**
 * The metrics whose rules divide by a baseline, so the ones self-inflation can silence.
 *
 * `queued` drives `queue_buildup`, `avgQueueingTime` drives `growing_queue_wait`, and
 * `avgProcessingTime` drives `slow_processing`. `messagesPerSec` (`throughput_drop`) is deliberately
 * absent: it compares DOWNWARD against a fraction of baseline, so a falling value drags its baseline
 * down and makes the rule fire *more* readily rather than less. The asymmetry is the reason, not an
 * oversight — a reference there would pin the healthy rate and is a separate decision.
 */
const SELF_INFLATING_METRICS = ['queued', 'avgQueueingTime', 'avgProcessingTime'] as const;

describe('the committed reference baselines', () => {
  it('cover every self-inflating metric for every host the file declares', () => {
    const hosts = Object.keys(CONFIG.referenceBaselines);
    assert.ok(hosts.length > 0, 'thresholds.json declares no reference baselines at all');

    for (const host of hosts) {
      for (const metric of SELF_INFLATING_METRICS) {
        const value = CONFIG.referenceBaselines[host]?.[metric];
        assert.equal(
          typeof value,
          'number',
          `${host}.${metric} has no stated normal, so its rolling mean will inflate with the ` +
            `metric it is judged against. Add it to referenceBaselines in thresholds.json.`,
        );
      }
    }
  });

  it('override the rolling mean rather than being averaged with it', () => {
    // The whole point: a rolling mean that has climbed to 300s must not be what a 940s wait is
    // compared against. Passing an absurd mean proves the reference wins outright.
    const host = Object.keys(CONFIG.referenceBaselines)[0] as string;
    assert.equal(
      effectiveBaseline(CONFIG, host, 'avgQueueingTime', 300),
      CONFIG.referenceBaselines[host]?.['avgQueueingTime'],
      'a stated normal must beat the rolling mean, not blend with it',
    );
  });

  it('leave a host with no reference on the rolling mean', () => {
    // The mechanism must stay opt-in. A production this config was not tuned for keeps ADR 0002's
    // behaviour rather than silently inheriting LABDEMO's numbers.
    assert.equal(
      effectiveBaseline(CONFIG, 'Some Other Production Host', 'queued', 42),
      42,
      'an undeclared host+metric must fall through to the rolling mean',
    );
  });

  it('reach CRITICAL for a severely degraded queue wait, and not decay to WARNING', () => {
    // The reported symptom, as arithmetic. With the shipped reference for Cloud API's queueing time,
    // a 940-second wait must land in the critical band -- and must still be there at 993s, which is
    // where the rolling mean previously pulled it back down to a 3.1x warning.
    const host = 'Cloud API';
    const reference = CONFIG.referenceBaselines[host]?.['avgQueueingTime'];
    assert.equal(typeof reference, 'number', 'Cloud API needs a stated queueing-time normal');

    const criticalBand = CONFIG.rules.growing_queue_wait.severityBands.critical;
    for (const observed of [940.02, 993.77]) {
      const baseline = effectiveBaseline(CONFIG, host, 'avgQueueingTime', 300) as number;
      const ratio = observed / baseline;
      assert.ok(
        ratio >= criticalBand,
        `${observed}s against a stated normal of ${baseline}s is ${ratio.toFixed(0)}x, which must ` +
          `reach the critical band (${criticalBand}x). Measured live before the fix: 3.1-3.2x ` +
          `against a climbing rolling mean, so critical was structurally unreachable.`,
      );
    }
  });

  it('states a normal of zero only where zero is genuinely normal', () => {
    // 0 is otherwise illegal in this file (every threshold must be positive), so each 0 here is a
    // claim: "a healthy host holds none of this". True for queue depth and queue wait on hosts that
    // keep up; NOT true of a processing time, since a host that processes work takes time to do it.
    for (const [host, metrics] of Object.entries(CONFIG.referenceBaselines)) {
      const proc = metrics['avgProcessingTime'];
      if (proc !== undefined) {
        assert.ok(
          proc > 0,
          `${host}.avgProcessingTime is ${proc}. A host that processes messages cannot take zero ` +
            `time to do it, so this is a placeholder rather than a measured normal.`,
        );
      }
    }
  });
});
