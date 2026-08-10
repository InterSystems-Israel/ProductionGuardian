/**
 * Contract drift guard.
 *
 * `src/types/healthscan.ts` is a transcription of `contracts/healthscan.d.ts`. We own
 * that contract, which means we may not quietly drift from it — Dev C's UI is built
 * against those exact bytes, and a silent divergence here is the failure mode that
 * breaks the Day-5 integration.
 *
 * These tests compare our types against the published contract as it exists on disk,
 * and validate our real API output against the published JSON Schema. Both run in CI,
 * so drift fails loudly rather than being caught by someone remembering to look.
 *
 * Skipped gracefully when `contracts/` is absent — the engine must remain buildable
 * standalone (ADR 0004), and the branch predates the contract merge.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config/thresholds.ts';
import { DetectionEngine } from '../src/detect/engine.ts';
import { DEFAULT_SCENARIO, MockProxyClient } from '../src/proxy/mockClient.ts';
import { FINDING_TYPES } from '../src/types/healthscan.ts';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = resolve(serviceRoot, '../../contracts');
const schemaPath = resolve(contractsDir, 'healthscan.schema.json');
const dtsPath = resolve(contractsDir, 'healthscan.d.ts');

const haveContracts = existsSync(schemaPath) && existsSync(dtsPath);

/** Extract a string-literal union's members from a .d.ts by type name. */
function unionMembers(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`).exec(source);
  if (declaration === null) return [];
  return [...(declaration[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('contract drift', { skip: haveContracts ? false : 'contracts/ not present' }, () => {
  it('our FindingType matches the published union exactly', () => {
    const published = unionMembers(readFileSync(dtsPath, 'utf8'), 'FindingType');
    assert.deepEqual([...FINDING_TYPES].sort(), published.sort());
  });

  it('our HostStatus matches the published union, and still excludes Warning', () => {
    const source = readFileSync(dtsPath, 'utf8');
    const published = unionMembers(source, 'HostStatus');
    const ours = unionMembers(readFileSync(resolve(serviceRoot, 'src/types/healthscan.ts'), 'utf8'), 'HostStatus');
    assert.deepEqual(ours.sort(), published.sort());
    // Q1: the correction that cost Dev C 83 insertions. Never reintroduce it.
    assert.ok(!published.includes('Warning'), 'Warning must not return to HostStatus');
  });

  it('our Severity matches the published union', () => {
    const source = readFileSync(dtsPath, 'utf8');
    const published = unionMembers(source, 'Severity');
    const ours = unionMembers(readFileSync(resolve(serviceRoot, 'src/types/healthscan.ts'), 'utf8'), 'Severity');
    assert.deepEqual(ours.sort(), published.sort());
  });

  it('the published schema enumerates exactly our eight finding types', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      definitions: { Finding: { properties: { type: { enum: string[] } } } };
    };
    assert.deepEqual(
      [...schema.definitions.Finding.properties.type.enum].sort(),
      [...FINDING_TYPES].sort(),
    );
  });

  it('every required field in the published Host schema is one we emit', async () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      definitions: { Host: { required: string[] }; Finding: { required: string[] } };
    };

    const client = new MockProxyClient(resolve(serviceRoot, 'fixtures/proxy'));
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = Date.parse('2026-08-06T16:00:00Z');
    const totalPolls = DEFAULT_SCENARIO.reduce((sum, step) => sum + step.polls, 0);

    const hostKeys = new Set<string>();
    const findingKeys = new Set<string>();
    for (let poll = 0; poll < totalPolls; poll += 1) {
      engine.applyPoll(await client.fetchMetrics(), at);
      at += 10_000;
      const snapshot = engine.snapshot();
      for (const host of snapshot.hosts) for (const key of Object.keys(host)) hostKeys.add(key);
      for (const finding of snapshot.findings) {
        for (const key of Object.keys(finding)) findingKeys.add(key);
      }
    }

    for (const required of schema.definitions.Host.required) {
      assert.ok(hostKeys.has(required), `we never emit required Host field "${required}"`);
    }
    for (const required of schema.definitions.Finding.required) {
      assert.ok(findingKeys.has(required), `we never emit required Finding field "${required}"`);
    }
  });

  it('we emit no field the published schema forbids', async () => {
    // Both objects are additionalProperties: false, so an extra field is a contract
    // violation even though it would look harmless in our own tests.
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      definitions: {
        Host: { properties: Record<string, unknown> };
        Finding: { properties: Record<string, unknown> };
      };
    };
    const allowedHost = new Set(Object.keys(schema.definitions.Host.properties));
    const allowedFinding = new Set(Object.keys(schema.definitions.Finding.properties));

    const client = new MockProxyClient(resolve(serviceRoot, 'fixtures/proxy'));
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = Date.parse('2026-08-06T16:00:00Z');
    const totalPolls = DEFAULT_SCENARIO.reduce((sum, step) => sum + step.polls, 0);

    for (let poll = 0; poll < totalPolls; poll += 1) {
      engine.applyPoll(await client.fetchMetrics(), at);
      at += 10_000;
      const snapshot = engine.snapshot();
      for (const host of snapshot.hosts) {
        for (const key of Object.keys(host)) {
          assert.ok(allowedHost.has(key), `Host field "${key}" is not in the contract`);
        }
      }
      for (const finding of snapshot.findings) {
        for (const key of Object.keys(finding)) {
          assert.ok(allowedFinding.has(key), `Finding field "${key}" is not in the contract`);
        }
      }
    }
  });

  it('our timestamps satisfy the published pattern', async () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      definitions: {
        Host: { properties: { lastActivity: { pattern: string } } };
        Finding: { properties: { detectedAt: { pattern: string } } };
      };
    };
    const hostPattern = new RegExp(schema.definitions.Host.properties.lastActivity.pattern);
    const findingPattern = new RegExp(schema.definitions.Finding.properties.detectedAt.pattern);

    const client = new MockProxyClient(resolve(serviceRoot, 'fixtures/proxy'));
    const engine = new DetectionEngine(DEFAULT_CONFIG);
    let at = Date.parse('2026-08-06T16:00:00Z');
    const totalPolls = DEFAULT_SCENARIO.reduce((sum, step) => sum + step.polls, 0);

    let checked = 0;
    for (let poll = 0; poll < totalPolls; poll += 1) {
      engine.applyPoll(await client.fetchMetrics(), at);
      at += 10_000;
      const snapshot = engine.snapshot();
      for (const host of snapshot.hosts) {
        assert.match(host.lastActivity, hostPattern);
        checked += 1;
      }
      for (const finding of snapshot.findings) {
        assert.match(finding.detectedAt, findingPattern);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'no timestamps were checked');
  });
});
