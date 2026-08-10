'use strict';

/**
 * parser.test.js — unit tests for the Prometheus text parser.
 * Run with: node --test src/parser.test.js  (requires Node >= 18)
 *
 * The inline metric text below uses the REAL label shape captured from a live
 * LABDEMO production (issue #10): the host label is `host` and holds a display
 * name with spaces, `id` is the namespace, status is an enum label, avg_* is one
 * series per (host, messagetype), and last_activity is elapsed seconds.
 * Tests written against a guessed shape are the failure ADR 0004 warns about.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePrometheusText, buildSnapshot, parseLabels, parseValue } = require('./parser');

describe('parseLabels', () => {
  it('parses a simple label set', () => {
    const result = parseLabels('id="LABDEMO",status="OK",host="EMR Source"');
    assert.deepEqual(result, { id: 'LABDEMO', status: 'OK', host: 'EMR Source' });
  });
  it('returns empty object for empty string', () => {
    assert.deepEqual(parseLabels(''), {});
  });
  it('handles escaped quotes in values', () => {
    const result = parseLabels('text="say \\"hello\\""');
    assert.equal(result.text, 'say "hello"');
  });
  it('keeps spaces and dots inside label values', () => {
    const result = parseLabels('host="FHIR Transform",production="LABDEMO.Production"');
    assert.equal(result.host, 'FHIR Transform');
    assert.equal(result.production, 'LABDEMO.Production');
  });
});

describe('parseValue', () => {
  it('parses a float', () => { assert.equal(parseValue('3.14'), 3.14); });
  it('parses an integer', () => { assert.equal(parseValue('42'), 42); });
  // IRIS emits leading-dot floats: `.05`, not `0.05`.
  it('parses a leading-dot float', () => { assert.equal(parseValue('.05'), 0.05); });
  it('returns null for NaN', () => { assert.equal(parseValue('NaN'), null); });
  it('returns null for +Inf', () => { assert.equal(parseValue('+Inf'), null); });
  it('returns null for -Inf', () => { assert.equal(parseValue('-Inf'), null); });
});

describe('parsePrometheusText', () => {
  const sample = `
# HELP iris_interop_messages_per_sec Messages processed per second
# TYPE iris_interop_messages_per_sec gauge
iris_interop_messages_per_sec{id="LABDEMO",host="Lab Router",production="LABDEMO.Production"} 0.5
iris_interop_messages_per_sec{id="LABDEMO",host="Cloud API",production="LABDEMO.Production"} 0.48
iris_system_alerts_new 0
  `.trim();

  it('parses metric lines with labels', () => {
    const result = parsePrometheusText(sample);
    const mps = result.filter(r => r.name === 'iris_interop_messages_per_sec');
    assert.equal(mps.length, 2);
    assert.equal(mps[0].labels.host, 'Lab Router');
    assert.equal(mps[0].value, 0.5);
    assert.equal(mps[1].labels.host, 'Cloud API');
    assert.equal(mps[1].value, 0.48);
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
iris_interop_hosts{id="LABDEMO",status="OK",host="EMR Source",production="LABDEMO.Production"} 1
iris_interop_hosts{id="LABDEMO",status="Error",host="Cloud API",production="LABDEMO.Production"} 0
iris_interop_queued{id="LABDEMO",production="LABDEMO.Production"} 14
iris_interop_messages_per_sec{id="LABDEMO",host="EMR Source",production="LABDEMO.Production"} 2.5
iris_interop_messages_errored{id="LABDEMO",host="Cloud API",production="LABDEMO.Production"} 7
iris_interop_avg_processing_time{hosttype="service",host="EMR Source",messagetype="ADT_A01",id="LABDEMO"} .010
iris_interop_avg_queueing_time{hosttype="operation",host="Cloud API",messagetype="Ens.StringRequest",id="LABDEMO"} 1.5
iris_interop_last_activity{id="LABDEMO",host="EMR Source",production="LABDEMO.Production"} 30
iris_system_alerts_new 2
  `.trim();

  it('builds a snapshot with correct host entries', () => {
    const raw = parsePrometheusText(metricsText);
    const snapshot = buildSnapshot(raw, '2026-08-09T10:00:00.000Z');

    assert.equal(snapshot.hosts.length, 2);
    assert.equal(snapshot._meta.polledAt, '2026-08-09T10:00:00.000Z');
    assert.equal(snapshot._meta.production, 'LABDEMO.Production');
    assert.equal(snapshot.systemAlertsNew, 2);

    const emr = snapshot.hosts.find(h => h.host === 'EMR Source');
    assert.ok(emr, 'EMR Source should be in hosts');
    assert.equal(emr.status, 'OK');
    assert.equal(emr.type, 'service');
    assert.equal(emr.messagesPerSec, 2.5);
    assert.equal(emr.avgProcessingTime, 0.010);

    const cloud = snapshot.hosts.find(h => h.host === 'Cloud API');
    assert.ok(cloud, 'Cloud API should be in hosts');
    assert.equal(cloud.status, 'Error');
    assert.equal(cloud.type, 'operation');
    assert.equal(cloud.errored, 7);
    assert.equal(cloud.avgQueueingTime, 1.5);
  });

  it('passes the status label through instead of inventing Active/Inactive', () => {
    // The value of iris_interop_hosts is not the status — Cloud API reports 0 with
    // status="Error", and a value-based mapping would have called it "Inactive".
    const snapshot = buildSnapshot(parsePrometheusText(metricsText));
    const statuses = snapshot.hosts.map(h => h.status);
    assert.deepEqual(statuses.sort(), ['Error', 'OK']);
  });

  it('reports queued per production, not per host', () => {
    // iris_interop_queued carries no host label. Per-host depth needs
    // Ens.Util.Statistics:EnumerateHostStatus, which the poller does not read (#12).
    const snapshot = buildSnapshot(parsePrometheusText(metricsText));
    assert.equal(snapshot._meta.productionQueued, 14);
    for (const h of snapshot.hosts) assert.equal(h.queued, 0);
  });

  it('never invents a host from the id (namespace) label', () => {
    // Regression: `id` was used as a host-name fallback, so every per-production
    // line manufactured a phantom "LABDEMO" host that read as a dead job (#10).
    const snapshot = buildSnapshot(parsePrometheusText(metricsText));
    const hostNames = snapshot.hosts.map(h => h.host);
    assert.ok(!hostNames.includes('LABDEMO'), 'phantom LABDEMO host was created');
    assert.ok(!hostNames.includes('LABDEMO.Production'), 'phantom production host was created');
  });

  it('converts last_activity elapsed seconds to an absolute timestamp', () => {
    const snapshot = buildSnapshot(parsePrometheusText(metricsText), '2026-08-09T10:00:00.000Z');
    const emr = snapshot.hosts.find(h => h.host === 'EMR Source');
    // 30 s elapsed at a 10:00:00 poll → last activity at 09:59:30.
    assert.equal(emr.lastActivityElapsedSeconds, 30);
    assert.equal(emr.lastActivity, '2026-08-09T09:59:30.000Z');
    // A host IRIS reported no activity line for stays null rather than reading as now.
    const cloud = snapshot.hosts.find(h => h.host === 'Cloud API');
    assert.equal(cloud.lastActivity, null);
    assert.equal(cloud.lastActivityElapsedSeconds, null);
  });

  it('sorts hosts alphabetically so rows never reorder between polls', () => {
    const snapshot = buildSnapshot(parsePrometheusText(metricsText));
    const hostNames = snapshot.hosts.map(h => h.host);
    assert.deepEqual(hostNames, [...hostNames].sort((a, b) => a.localeCompare(b)));
  });

  it('handles all 8 metric families present in fixture file', () => {
    const fs = require('fs');
    const path = require('path');
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'metrics.txt');
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');
    const raw = parsePrometheusText(fixtureText);
    const snapshot = buildSnapshot(raw);

    // The four LABDEMO hosts, under their real spaced display names.
    const hostNames = snapshot.hosts.map(h => h.host);
    assert.deepEqual(hostNames, ['Cloud API', 'EMR Source', 'FHIR Transform', 'Lab Router']);
    assert.equal(snapshot.hosts.length, 4, 'no extra host may appear');

    // hosttype rides on the avg_* families only, so type must survive from there.
    const types = {};
    for (const h of snapshot.hosts) types[h.host] = h.type;
    assert.deepEqual(types, {
      'Cloud API': 'operation',
      'EMR Source': 'service',
      'FHIR Transform': 'process',   // IRIS says `actor`; we normalize to the doc's word
      'Lab Router': 'process',
    });
  });

  it('averages multi-series avg_* weighted by iris_interop_sample_count', () => {
    // Lab Router in the fixture handles two message types: .08 s over 15 samples and
    // .04 s over 5. The weighted mean is .07; a plain mean would say .06 and
    // last-write-wins would say .04.
    const fs = require('fs');
    const path = require('path');
    const fixtureText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'metrics.txt'), 'utf8');
    const snapshot = buildSnapshot(parsePrometheusText(fixtureText));
    const router = snapshot.hosts.find(h => h.host === 'Lab Router');
    assert.ok(Math.abs(router.avgProcessingTime - 0.07) < 1e-9,
      `expected 0.07, got ${router.avgProcessingTime}`);
  });

  it('falls back to an unweighted mean when sample counts are absent', () => {
    // metricsText has no iris_interop_sample_count lines at all; the host must still
    // report its avg rather than dropping to 0.
    const snapshot = buildSnapshot(parsePrometheusText(metricsText));
    const emr = snapshot.hosts.find(h => h.host === 'EMR Source');
    assert.equal(emr.avgProcessingTime, 0.010);
  });
});
