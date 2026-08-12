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
const {
  parsePrometheusText, buildSnapshot, parseLabels, parseValue, isFrameworkHost,
} = require('./parser');

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
    const result = parseLabels('host="Lab Router",production="LABDEMO.Production"');
    assert.equal(result.host, 'Lab Router');
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

  it('reports queued per production, and per-host queued as null not 0', () => {
    // iris_interop_queued carries no host label. Per-host depth needs
    // Ens.Util.Statistics:EnumerateHostStatus, which the poller does not read (#12).
    // `null` rather than `0` matters: the production total here is 14, so publishing
    // `queued: 0` per host would assert every host is drained while 14 sit somewhere.
    const snapshot = buildSnapshot(parsePrometheusText(metricsText));
    assert.equal(snapshot._meta.productionQueued, 14);
    for (const h of snapshot.hosts) assert.equal(h.queued, null);
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

    // The three LABDEMO hosts, under their real spaced display names.
    const hostNames = snapshot.hosts.map(h => h.host);
    assert.deepEqual(hostNames, ['Cloud API', 'EMR Source', 'Lab Router']);
    assert.equal(snapshot.hosts.length, 3, 'no extra host may appear');

    // hosttype rides on the avg_* families only, so type must survive from there.
    const types = {};
    for (const h of snapshot.hosts) types[h.host] = h.type;
    assert.deepEqual(types, {
      'Cloud API': 'operation',
      'EMR Source': 'service',
      'Lab Router': 'process',   // IRIS says `actor`; we normalize to the doc's word
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

/**
 * The full capture from Dev A's own IRIS 2024.1, taken 2026-08-11 AFTER the production
 * items were renamed to the spaced contract names (`EMR Source`, `Lab Router`,
 * `Cloud API`) and PIDExtractProcess was removed. This is what `npm run mock` serves.
 *
 * The pre-rename capture is kept as metrics-live-capture-preRename.txt and covered
 * separately below — the host label is the join key, so a parser that only works on one
 * spelling of it is a parser that breaks at integration.
 */
describe('buildSnapshot — against the full live capture', () => {
  const fs = require('fs');
  const path = require('path');
  const captureText = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'metrics-live-capture.txt'), 'utf8');
  const snapshot = buildSnapshot(parsePrometheusText(captureText), '2026-08-11T12:00:00.000Z');
  const appHosts = snapshot.hosts.filter(h => !h.isFramework);

  it('parses every non-comment line in the capture', () => {
    // Includes Windows paths with escaped backslashes and bare-dot floats like
    // `.051929`. A single unparsed line would silently drop a metric family.
    const lineCount = captureText.split(/\r?\n/)
      .filter(l => l.trim() && !l.trim().startsWith('#')).length;
    assert.equal(parsePrometheusText(captureText).length, lineCount);
    assert.equal(lineCount, 310);
  });

  it('keeps Windows directory paths intact through label parsing', () => {
    // dir="c:\\intersystems\\..." — the escape handling must not corrupt these, or the
    // label regex silently stops matching the rest of the line.
    const raw = parsePrometheusText(captureText);
    const dbSize = raw.find(m => m.name === 'iris_db_size_mb' && m.labels.id === 'LABDEMO');
    assert.ok(dbSize, 'iris_db_size_mb for LABDEMO should parse');
    assert.equal(dbSize.labels.dir, 'c:\\intersystems\\iris4health_2024_1\\mgr\\labdemo\\');
  });

  it('flags framework hosts and leaves exactly the three application items', () => {
    // IRIS reported 12 hosts; 9 are framework. Without the flag the dashboard shows
    // Ens.Alarm and EnsLib.Background.* as application components.
    assert.equal(snapshot.hosts.length, 12);
    assert.deepEqual(appHosts.map(h => h.host).sort(), [
      'Cloud API', 'EMR Source', 'Lab Router',
    ]);
    assert.equal(snapshot._meta.applicationHostCount, 3);
  });

  it('resolves the spaced host names the contract joins on', () => {
    // `host` is the documented join key and these values contain spaces. A label parser
    // that stopped at whitespace would produce 'EMR' and silently fail to join.
    for (const name of ['EMR Source', 'Lab Router', 'Cloud API']) {
      assert.ok(snapshot.hosts.some(h => h.host === name), `${name} should be present`);
    }
  });

  it('flags the activity reporter, whose item name has changed spelling', () => {
    // Now `Ens.Activity.Operation.Local`, caught by the prefix rule. It was
    // `ActivityReporter` in the pre-rename capture, caught by nothing — the metric label
    // carries the ITEM name, so the prefix rule alone was never sufficient.
    const ar = snapshot.hosts.find(h => h.host === 'Ens.Activity.Operation.Local');
    assert.ok(ar, 'the activity reporter should be present');
    assert.equal(ar.isFramework, true);
  });

  it('does not let the one host with avg_* data masquerade as application latency', () => {
    // Ens.MonitorService is the ONLY host with avg_processing_time in the capture
    // (.051929). It is framework, so an unfiltered mean would report framework timing
    // as the production's processing time.
    const monitor = snapshot.hosts.find(h => h.host === 'Ens.MonitorService');
    assert.equal(monitor.isFramework, true);
    assert.ok(Math.abs(monitor.avgProcessingTime - 0.051929) < 1e-9);
    // No application host had any avg_* series, so none may claim a number.
    for (const h of appHosts) {
      assert.equal(h.avgProcessingTime, null, `${h.host} must not invent a processing time`);
      assert.equal(h.avgQueueingTime, null, `${h.host} must not invent a queueing time`);
    }
  });

  it('reports absent metric families instead of publishing them as zero', () => {
    // This IRIS emits NO iris_interop_messages_errored and NO
    // iris_interop_last_activity — not zero-valued lines, no lines at all. Reporting
    // `errored: 0` would make elevated_error_rate structurally unable to fire while
    // looking like a measurement.
    assert.deepEqual(snapshot._meta.absentFamilies.sort(), [
      'iris_interop_last_activity',
      'iris_interop_messages_errored',
    ]);
    for (const h of snapshot.hosts) {
      assert.equal(h.errored, null, `${h.host}.errored must be null, not 0`);
      assert.equal(h.lastActivity, null, `${h.host}.lastActivity must be null`);
      assert.equal(h.lastActivityElapsedSeconds, null);
    }
  });

  it('keeps a measured zero distinguishable from an absent metric', () => {
    // messages_per_sec IS emitted, with value 0. That is a real measurement and must
    // stay 0 — the null-default must not swallow legitimate zeros.
    const emr = snapshot.hosts.find(h => h.host === 'EMR Source');
    assert.equal(emr.messagesPerSec, 0);
    assert.equal(emr.messages, 0);
    assert.notEqual(emr.messagesPerSec, null);
    // And a nonzero count survives.
    const sched = snapshot.hosts.find(h => h.host === 'Ens.ScheduleHandler');
    assert.equal(sched.messages, 94);
  });

  it('never invents a host from the many non-interop id labels', () => {
    // The capture has ~200 lines carrying id="LABDEMO", id="IRISSYS", id="all",
    // id="Lock_Table" etc. on db/sql/smh families. None is a host.
    const names = snapshot.hosts.map(h => h.host);
    for (const bogus of ['LABDEMO', 'IRISSYS', 'all', 'Lock_Table', 'primary', 'SYS', 'Default']) {
      assert.ok(!names.includes(bogus), `invented a host from id="${bogus}"`);
    }
  });

  it('reads the production name and both alert counters from the capture', () => {
    assert.equal(snapshot._meta.production, 'ProductionGuardian.LabDemo.Production');
    // alerts_new is 0 and alerts_log is 2: two alerts exist in alerts.log but have
    // already been consumed by a read. Publishing only `new` would say "no alerts".
    assert.equal(snapshot.systemAlertsNew, 0);
    assert.equal(snapshot.systemAlertsLog, 2);
    assert.equal(snapshot._meta.productionQueued, 0);
  });

  it('leaves type unknown rather than guessing it from the host name', () => {
    // `hosttype` rides only on avg_*, which the capture has for one host. Inferring
    // "Lab Router is a process" from the name would be fabricated data — the item name
    // is arbitrary and says nothing about the item's class.
    for (const h of appHosts) {
      assert.equal(h.type, 'unknown', `${h.host} type must stay unknown`);
    }
    assert.equal(snapshot.hosts.find(h => h.host === 'Ens.MonitorService').type, 'service');
  });
});

/**
 * The pre-rename capture (2026-08-11 morning): unspaced item names, PIDExtractProcess
 * present, the activity reporter called `ActivityReporter` with no prefix.
 *
 * Kept and tested because `host` is the join key. Dev B and Dev C may still be running
 * an instance with the older production definition, and a parser that only handles the
 * current spelling would break on theirs while passing here.
 */
describe('buildSnapshot — against the pre-rename capture', () => {
  const fs = require('fs');
  const path = require('path');
  const captureText = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'metrics-live-capture-preRename.txt'), 'utf8');
  const snapshot = buildSnapshot(parsePrometheusText(captureText), '2026-08-11T06:00:00.000Z');
  const appHosts = snapshot.hosts.filter(h => !h.isFramework);

  it('resolves the unspaced item names and the four application hosts', () => {
    assert.equal(snapshot.hosts.length, 13);
    assert.deepEqual(appHosts.map(h => h.host).sort(), [
      'EMRSource', 'LabRouter', 'PIDExtractProcess', 'PatientDemographicsOperation',
    ]);
  });

  it('still flags the prefixless ActivityReporter', () => {
    // The case the prefix rule cannot reach. If the explicit entry is ever dropped as
    // dead weight, this fails rather than silently promoting it to an app component.
    const ar = snapshot.hosts.find(h => h.host === 'ActivityReporter');
    assert.ok(ar, 'ActivityReporter should be present');
    assert.equal(ar.isFramework, true);
  });

  it('reports the same absent families on both captures', () => {
    // The absence is a property of this IRIS build, not of the production definition.
    assert.deepEqual(snapshot._meta.absentFamilies.sort(), [
      'iris_interop_last_activity',
      'iris_interop_messages_errored',
    ]);
  });

  it('had an unread alert, unlike the later capture', () => {
    // alerts_new 1 here vs 0 after — the read in between consumed it. This fixture is
    // the only one that exercises systemAlertsNew > 0.
    assert.equal(snapshot.systemAlertsNew, 1);
  });
});

describe('isFrameworkHost', () => {
  it('matches Ens. and EnsLib. prefixes', () => {
    for (const h of ['Ens.Actor', 'Ens.Alarm', 'Ens.MonitorService', 'Ens.ScheduleHandler',
                     'EnsLib.Background.Service', 'EnsLib.Background.Workflow.Operation']) {
      assert.equal(isFrameworkHost(h), true, `${h} should be framework`);
    }
  });

  it('matches ActivityReporter under both spellings', () => {
    // Pre-#14 item name has no prefix and needs the explicit entry; post-#14 the
    // rename makes the prefix rule work. Both instances exist right now.
    assert.equal(isFrameworkHost('ActivityReporter'), true);
    assert.equal(isFrameworkHost('Ens.ActivityReporter'), true);
  });

  it('does not match application hosts', () => {
    for (const h of ['EMRSource', 'LabRouter', 'PIDExtractProcess',
                     'PatientDemographicsOperation', 'EMR Source', 'Lab Router', 'Cloud API']) {
      assert.equal(isFrameworkHost(h), false, `${h} should NOT be framework`);
    }
  });

  it('does not match a name that merely contains Ens', () => {
    // Prefix, not substring: a host legitimately called "SensorFeed" or "Ensemble
    // Bridge" is an application host.
    assert.equal(isFrameworkHost('SensorFeed'), false);
    assert.equal(isFrameworkHost('Ensemble Bridge'), false);
  });
});
