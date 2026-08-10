'use strict';

/**
 * parser.test.js — unit tests for the Prometheus text parser.
 * Run with: node --test src/parser.test.js  (requires Node >= 18)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePrometheusText, buildSnapshot, parseLabels, parseValue } = require('./parser');

describe('parseLabels', () => {
  it('parses a simple label set', () => {
    const result = parseLabels('name="EMRSource",type="BS",status="Active"');
    assert.deepEqual(result, { name: 'EMRSource', type: 'BS', status: 'Active' });
  });
  it('returns empty object for empty string', () => {
    assert.deepEqual(parseLabels(''), {});
  });
  it('handles escaped quotes in values', () => {
    const result = parseLabels('text="say \\"hello\\""');
    assert.equal(result.text, 'say "hello"');
  });
});

describe('parseValue', () => {
  it('parses a float', () => { assert.equal(parseValue('3.14'), 3.14); });
  it('parses an integer', () => { assert.equal(parseValue('42'), 42); });
  it('returns null for NaN', () => { assert.equal(parseValue('NaN'), null); });
  it('returns null for +Inf', () => { assert.equal(parseValue('+Inf'), null); });
  it('returns null for -Inf', () => { assert.equal(parseValue('-Inf'), null); });
});

describe('parsePrometheusText', () => {
  const sample = `
# HELP iris_interop_queued Queue depth
# TYPE iris_interop_queued gauge
iris_interop_queued{name="LabRouter"} 3
iris_interop_queued{name="CloudAPI"} 14
iris_system_alerts_new 0
  `.trim();

  it('parses metric lines with labels', () => {
    const result = parsePrometheusText(sample);
    const queued = result.filter(r => r.name === 'iris_interop_queued');
    assert.equal(queued.length, 2);
    assert.equal(queued[0].labels.name, 'LabRouter');
    assert.equal(queued[0].value, 3);
    assert.equal(queued[1].labels.name, 'CloudAPI');
    assert.equal(queued[1].value, 14);
  });

  it('parses metric lines without labels', () => {
    const result = parsePrometheusText(sample);
    const alerts = result.find(r => r.name === 'iris_system_alerts_new');
    assert.ok(alerts);
    assert.equal(alerts.value, 0);
    assert.deepEqual(alerts.labels, {});
  });

  it('skips comment lines', () => {
    const result = parsePrometheusText(sample);
    const comments = result.filter(r => r.name.startsWith('#'));
    assert.equal(comments.length, 0);
  });
});

describe('buildSnapshot', () => {
  const metricsText = `
iris_interop_hosts{name="EMRSource",type="BS",status="Active"} 1
iris_interop_hosts{name="CloudAPI",type="BO",status="Error"} 0
iris_interop_queued{name="EMRSource"} 0
iris_interop_queued{name="CloudAPI"} 14
iris_interop_messages_per_sec{name="EMRSource"} 2.5
iris_interop_messages_errored{name="CloudAPI"} 7
iris_interop_avg_processing_time{name="EMRSource"} 0.010
iris_interop_avg_queueing_time{name="CloudAPI"} 1.5
iris_last_activity{name="EMRSource"} 1754700000
iris_system_alerts_new 2
  `.trim();

  it('builds a snapshot with correct host entries', () => {
    const raw = parsePrometheusText(metricsText);
    const snapshot = buildSnapshot(raw, '2026-08-09T10:00:00.000Z');

    assert.equal(snapshot.hosts.length, 2);
    assert.equal(snapshot._meta.polledAt, '2026-08-09T10:00:00.000Z');
    assert.equal(snapshot.systemAlertsNew, 2);

    const emr = snapshot.hosts.find(h => h.host === 'EMRSource');
    assert.ok(emr, 'EMRSource should be in hosts');
    assert.equal(emr.status, 'Active');
    assert.equal(emr.type, 'service');
    assert.equal(emr.queued, 0);
    assert.equal(emr.messagesPerSec, 2.5);
    assert.equal(emr.avgProcessingTime, 0.010);
    assert.ok(emr.lastActivity, 'lastActivity should be set');

    const cloud = snapshot.hosts.find(h => h.host === 'CloudAPI');
    assert.ok(cloud, 'CloudAPI should be in hosts');
    assert.equal(cloud.status, 'Error');
    assert.equal(cloud.type, 'operation');
    assert.equal(cloud.queued, 14);
    assert.equal(cloud.errored, 7);
    assert.equal(cloud.avgQueueingTime, 1.5);
  });

  it('handles all 8 metric families present in fixture file', () => {
    const fs = require('fs');
    const path = require('path');
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'metrics.txt');
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');
    const raw = parsePrometheusText(fixtureText);
    const snapshot = buildSnapshot(raw);

    // All 5 LABDEMO hosts should be present.
    const hostNames = snapshot.hosts.map(h => h.host);
    assert.ok(hostNames.includes('EMRSource'), 'EMRSource missing');
    assert.ok(hostNames.includes('LabRouter'), 'LabRouter missing');
    assert.ok(hostNames.includes('FHIRTransform'), 'FHIRTransform missing');
    assert.ok(hostNames.includes('CloudAPI'), 'CloudAPI missing');
  });
});
