/**
 * The test that was missing, and would have caught #32 on the day the proxy landed.
 *
 * Every other suite here runs against fixtures WE wrote. They prove the engine is
 * self-consistent and say nothing about whether the two services agree — which is exactly
 * how our guard came to reject every real host while 133 tests stayed green. ADR 0004
 * called it: "integration risk is deferred, not removed."
 *
 * So this runs Dev A's ACTUAL parser over the ACTUAL captured IRIS output and feeds the
 * result through our own boundary guard. No fixture of ours is involved on the input side.
 * If the two components disagree about a field name, a type, or nullability, this fails.
 *
 * Skipped gracefully when either input is absent, so the engine stays buildable standalone
 * (ADR 0004) — but CI has both on `main`, so a skip there would be a signal in itself.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config/thresholds.ts';
import { DetectionEngine, normalizeHost } from '../src/detect/engine.ts';
import { isFrameworkHost, isProxyHost, type ProxyHost } from '../src/types/proxy.ts';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serviceRoot, '../..');
const parserPath = resolve(repoRoot, 'services/metrics-proxy/src/parser.js');
const capturePath = resolve(repoRoot, 'contracts/samples/metrics-dump.txt');

const inputsPresent = existsSync(parserPath) && existsSync(capturePath);
const skip = inputsPresent ? false : 'metrics-proxy parser or metrics-dump.txt not present';

/** Dev A's parser is CommonJS, so reach it through createRequire rather than import. */
function buildRealSnapshot(): { hosts: unknown[]; _meta: Record<string, unknown> } {
  const require = createRequire(import.meta.url);
  const { parsePrometheusText, buildSnapshot } = require(parserPath) as {
    parsePrometheusText: (body: string) => unknown[];
    buildSnapshot: (raw: unknown[], polledAt: string) => { hosts: unknown[]; _meta: Record<string, unknown> };
  };
  const body = readFileSync(capturePath, 'utf8');
  return buildSnapshot(parsePrometheusText(body), '2026-08-12T00:00:00Z');
}

describe('our guard against the real proxy output', { skip }, () => {
  it('accepts EVERY host the real proxy produces', () => {
    const snapshot = buildRealSnapshot();
    assert.ok(snapshot.hosts.length > 0, 'the capture yielded no hosts at all');

    const rejected = snapshot.hosts.filter((host) => !isProxyHost(host));
    assert.deepEqual(
      rejected.map((h) => JSON.stringify(h)),
      [],
      `our guard rejected ${rejected.length} of ${snapshot.hosts.length} real hosts — ` +
        'the engine would report zero and the dashboard would blank (#32)',
    );
  });

  it('finds the four LABDEMO application hosts after framework filtering', () => {
    const snapshot = buildRealSnapshot();
    const application = snapshot.hosts
      .filter(isProxyHost)
      .filter((host) => !isFrameworkHost(host.host))
      .map((host) => host.host)
      .sort();

    // The capture predates the FHIR Transform removal, so it has four. Assert the set
    // rather than a count: a count would go stale the way the CI assertion did (#19).
    assert.deepEqual(application, ['Cloud API', 'EMR Source', 'FHIR Transform', 'Lab Router']);
  });

  it('never lets a framework host or the namespace through', () => {
    const snapshot = buildRealSnapshot();
    const leaked = snapshot.hosts
      .filter(isProxyHost)
      .map((host) => host.host)
      .filter((name) => !isFrameworkHost(name))
      .filter((name) => name === 'LABDEMO' || name === 'LABDEMO.Production');
    assert.deepEqual(leaked, [], 'the namespace leaked through as a host');
  });

  it('normalizes a real host into a contract-shaped Host with no nulls', () => {
    const snapshot = buildRealSnapshot();
    const labRouter = snapshot.hosts
      .filter(isProxyHost)
      .find((host) => host.host === 'Lab Router');
    assert.ok(labRouter !== undefined, 'Lab Router missing from the capture');

    const host = normalizeHost(labRouter, Date.parse('2026-08-12T00:00:00Z'));

    // The published Host contract has no nullable numerics. Emitting null here would do
    // to Dev C precisely what the proxy's null did to us.
    for (const field of ['queued', 'messagesPerSec', 'errored', 'avgProcessingTime', 'avgQueueingTime'] as const) {
      assert.equal(typeof host[field], 'number', `Host.${field} must be a number, not null`);
    }
    assert.match(host.lastActivity, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(host.type, 'process', "IRIS 'actor' must normalize to 'process'");
  });

  it('records the real values, so a proxy change that alters them is visible', () => {
    const snapshot = buildRealSnapshot();
    const byHost = new Map(
      snapshot.hosts.filter(isProxyHost).map((host) => [host.host, host]),
    );

    // Measured against live LABDEMO. These are the numbers every threshold was tuned
    // against, so if the proxy's aggregation changes, this fails and says so.
    assert.equal(byHost.get('Lab Router')?.avgProcessingTime, 0.08);
    assert.equal(byHost.get('EMR Source')?.messagesPerSec, 0.2);
    assert.equal(byHost.get('Lab Router')?.messagesPerSec, 1.2);

    // And the two fields IRIS does not expose per host (#12, #31).
    assert.equal(byHost.get('Lab Router')?.queued, null, 'queued should still be null — see #12');
    assert.equal(byHost.get('Lab Router')?.errored, null, 'errored should still be null — see #31');
  });

  it('drives a full poll through the engine without losing a host', () => {
    const snapshot = buildRealSnapshot();
    const hosts = snapshot.hosts.filter(isProxyHost) as ProxyHost[];
    const engine = new DetectionEngine(DEFAULT_CONFIG, () => {});

    let at = Date.parse('2026-08-12T00:00:00Z');
    for (let poll = 0; poll < 3; poll += 1) {
      engine.applyPoll(
        {
          sampledAt: new Date(at).toISOString(),
          production: 'LABDEMO.Production',
          hosts,
          alerts: [],
          warming: false,
          productionQueued: null,
        },
        at,
      );
      at += 10_000;
    }

    const reported = engine.snapshot().hosts.map((host) => host.host).sort();
    assert.deepEqual(reported, ['Cloud API', 'EMR Source', 'FHIR Transform', 'Lab Router']);
  });
});
