'use strict';

/**
 * hoststatus.test.js — parsing the host-status payload and merging it by host name.
 *
 * The payload shape here is a REAL CAPTURE: `fixtures/hoststatus-live-capture.json` is
 * the body the endpoint served over HTTP from the live LABDEMO production, not a
 * hand-written approximation. See fixtures/README.md.
 *
 * What these tests are protecting, in order of how quietly each would fail:
 *
 *   1. `queued`/`errored` actually stop being null. That is the whole point of #12/#31.
 *   2. A host the endpoint did not describe keeps `null`, not 0 — "absent is not zero".
 *   3. The join is EXACT. Host names contain spaces, and a normalizing merge that
 *      silently matched "Cloud API" to "CloudAPI" would hide a real rename.
 *   4. A broken third source degrades to the old behaviour instead of dropping the
 *      metrics snapshot.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseHostStatus, mergeHostStatus } = require('./hoststatus');
const { parsePrometheusText, buildSnapshot } = require('./parser');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const LIVE_CAPTURE = fs.readFileSync(
  path.join(FIXTURES, 'hoststatus-live-capture.json'), 'utf8');

/** A minimal metrics snapshot with the given host names, as buildSnapshot shapes it. */
function snapshotWithHosts(...names) {
  const text = names
    .map(n => `iris_interop_hosts{id="LABDEMO",status="OK",host="${n}",`
      + `production="LABDEMO.Production"} 1`)
    .join('\n');
  return buildSnapshot(parsePrometheusText(text), '2026-08-12T10:00:00.000Z');
}

describe('parseHostStatus — the real capture', () => {
  it('reads every host the endpoint described', () => {
    const { byHost, _meta } = parseHostStatus(LIVE_CAPTURE);
    assert.equal(byHost.size, 13);
    assert.equal(_meta.hostCount, 13);
    assert.equal(_meta.shape, 'hosts');
    assert.equal(_meta.skippedEntries, 0);
  });

  it('keeps host names exactly as IRIS spells them, spaces intact', () => {
    const { byHost } = parseHostStatus(LIVE_CAPTURE);
    // The join key. If this ever collapses to "CloudAPI" the merge stops working.
    assert.ok(byHost.has('Cloud API'));
    assert.ok(byHost.has('EMR Source'));
    assert.ok(byHost.has('FHIR Transform'));
    assert.ok(byHost.has('Lab Router'));
  });

  it('carries the per-production _meta through, including productionState', () => {
    const { _meta } = parseHostStatus(LIVE_CAPTURE);
    assert.equal(_meta.production, 'LABDEMO.Production');
    // Distinguishes a stopped production (the query returns zero rows) from a
    // production with no hosts.
    assert.equal(_meta.productionState, 'Running');
    assert.equal(_meta.erroredAvailable, true);
  });

  it('reads a measured zero as 0, not as null', () => {
    // The endpoint coerces EnumerateHostStatus's empty-string Queue to 0 because empty
    // IS a measured zero there. That must survive the parse as a number.
    const { byHost } = parseHostStatus(LIVE_CAPTURE);
    assert.equal(byHost.get('Cloud API').queued, 0);
    assert.equal(byHost.get('Cloud API').errored, 0);
  });

  it('reads a non-zero queue depth', () => {
    // Synthetic, and deliberately so: the live production is healthy and drains
    // immediately, so a real backlog could not be captured without changing a
    // production setting on a shared instance. The 70 mirrors the depth measured
    // earlier on this instance with Cloud API disabled (#12).
    const { byHost } = parseHostStatus(JSON.stringify({
      hosts: [{ host: 'Cloud API', status: 'Disabled', queued: 70, errored: 3, messageCount: 17488 }],
      _meta: { production: 'LABDEMO.Production', productionState: 'Running', erroredAvailable: true },
    }));
    assert.equal(byHost.get('Cloud API').queued, 70);
    assert.equal(byHost.get('Cloud API').errored, 3);
    assert.equal(byHost.get('Cloud API').status, 'Disabled');
  });
});

describe('parseHostStatus — malformed payloads', () => {
  it('reports an unparseable body rather than throwing', () => {
    // What a 404 HTML page from the wrong path looks like.
    const { byHost, _meta } = parseHostStatus('<html><h1>404 Not Found</h1></html>');
    assert.equal(byHost.size, 0);
    assert.equal(_meta.shape, 'unparseable');
    assert.ok(_meta.raw.includes('404'));
  });

  it('reports valid JSON of the wrong shape, with its keys as evidence', () => {
    const { byHost, _meta } = parseHostStatus('{"count":4}');
    assert.equal(byHost.size, 0);
    assert.equal(_meta.shape, 'unrecognized-object');
    assert.deepEqual(_meta.keys, ['count']);
  });

  it('reports a bare array', () => {
    assert.equal(parseHostStatus('[]')._meta.shape, 'unrecognized-array');
  });

  it('skips an unusable entry without losing the rest', () => {
    const { byHost, _meta } = parseHostStatus(JSON.stringify({
      hosts: [
        { host: 'Lab Router', queued: 1, errored: 0, status: 'OK', messageCount: 5 },
        { host: '', queued: 9 },      // no name — nothing to join on
        null,
        { queued: 4 },                 // no host key at all
      ],
    }));
    assert.equal(byHost.size, 1);
    assert.equal(_meta.skippedEntries, 3);
  });

  it('turns a non-numeric queued into null rather than NaN', () => {
    const { byHost } = parseHostStatus(JSON.stringify({
      hosts: [{ host: 'Lab Router', status: 'OK', queued: '12', errored: null, messageCount: 1 }],
    }));
    // A string is not a measurement. null says "unmeasurable"; NaN would poison a rule.
    assert.equal(byHost.get('Lab Router').queued, null);
    assert.equal(byHost.get('Lab Router').errored, null);
  });

  it('treats a missing erroredAvailable as false', () => {
    // Absent must not read as "the counts are good".
    assert.equal(parseHostStatus('{"hosts":[]}')._meta.erroredAvailable, false);
  });
});

describe('mergeHostStatus — this is what closes #12 and #31', () => {
  it('populates queued and errored, which are null without the merge', () => {
    const before = snapshotWithHosts('Cloud API', 'Lab Router');
    // The bug being fixed: the metrics text alone cannot supply these.
    assert.equal(before.hosts[0].queued, null);
    assert.equal(before.hosts[0].errored, null);

    const after = mergeHostStatus(before, parseHostStatus(JSON.stringify({
      hosts: [
        { host: 'Cloud API', status: 'OK', queued: 70, errored: 3, messageCount: 17488 },
        { host: 'Lab Router', status: 'OK', queued: 0, errored: 0, messageCount: 52464 },
      ],
      _meta: { erroredAvailable: true, productionState: 'Running' },
    })));

    const cloud = after.hosts.find(h => h.host === 'Cloud API');
    const router = after.hosts.find(h => h.host === 'Lab Router');
    assert.equal(cloud.queued, 70);
    assert.equal(cloud.errored, 3);
    assert.equal(router.queued, 0);      // a measured zero, not a null
    assert.equal(after._meta.hostStatus.merged, 2);
  });

  it('merges the real capture into a real host list', () => {
    const snapshot = snapshotWithHosts('Cloud API', 'EMR Source', 'FHIR Transform', 'Lab Router');
    const after = mergeHostStatus(snapshot, parseHostStatus(LIVE_CAPTURE));
    assert.equal(after._meta.hostStatus.merged, 4);
    for (const host of after.hosts) {
      assert.equal(typeof host.queued, 'number', `${host.host} queued should be measured`);
      assert.equal(typeof host.errored, 'number', `${host.host} errored should be measured`);
    }
  });

  it('leaves a host the endpoint did not describe as null, NOT 0', () => {
    // The invariant the whole payload depends on. A host nobody measured must not read
    // as a drained one.
    const after = mergeHostStatus(
      snapshotWithHosts('Cloud API', 'Ghost Host'),
      parseHostStatus(JSON.stringify({
        hosts: [{ host: 'Cloud API', status: 'OK', queued: 5, errored: 0, messageCount: 1 }],
        _meta: { erroredAvailable: true },
      })));
    const ghost = after.hosts.find(h => h.host === 'Ghost Host');
    assert.equal(ghost.queued, null);
    assert.equal(ghost.errored, null);
  });

  it('does not normalize host names when joining', () => {
    // "CloudAPI" is a different host from "Cloud API". Matching them would hide a
    // rename and attribute one host's queue depth to another.
    const after = mergeHostStatus(
      snapshotWithHosts('Cloud API'),
      parseHostStatus(JSON.stringify({
        hosts: [{ host: 'CloudAPI', status: 'OK', queued: 99, errored: 0, messageCount: 1 }],
        _meta: { erroredAvailable: true },
      })));
    assert.equal(after.hosts[0].queued, null);
    assert.equal(after._meta.hostStatus.merged, 0);
    assert.deepEqual(after._meta.hostStatus.unmatchedHosts, ['CloudAPI']);
  });

  it('keeps errored null when the endpoint could not count errors', () => {
    // erroredAvailable false means the count query failed. Publishing its 0 would be a
    // fabricated measurement.
    const after = mergeHostStatus(
      snapshotWithHosts('Cloud API'),
      parseHostStatus(JSON.stringify({
        hosts: [{ host: 'Cloud API', status: 'OK', queued: 7, errored: 0, messageCount: 1 }],
        _meta: { erroredAvailable: false },
      })));
    assert.equal(after.hosts[0].queued, 7);      // queue depth is still good
    assert.equal(after.hosts[0].errored, null);  // the error count is not
  });

  it('prefers the authoritative status and keeps the metrics one visible', () => {
    // Measured on this instance: metrics said status="OK" for a host that was Disabled
    // with 70 queued. EnumerateHostStatus reports Disabled; iris_interop_hosts does not.
    const after = mergeHostStatus(
      snapshotWithHosts('Cloud API'),
      parseHostStatus(JSON.stringify({
        hosts: [{ host: 'Cloud API', status: 'Disabled', queued: 70, errored: 0, messageCount: 1 }],
        _meta: { erroredAvailable: true },
      })));
    assert.equal(after.hosts[0].status, 'Disabled');
    assert.equal(after.hosts[0].statusFromMetrics, 'OK');
  });

  it('publishes the snapshot unchanged when the third source is unavailable', () => {
    // A failed host-status poll must degrade to the old behaviour, not lose metrics.
    const before = snapshotWithHosts('Cloud API', 'Lab Router');
    const after = mergeHostStatus(before, null);
    assert.equal(after.hosts.length, 2);
    assert.equal(after.hosts[0].queued, null);
    assert.equal(after._meta.hostStatus.available, false);
    assert.equal(after._meta.hostStatus.merged, 0);
  });

  it('reports merged 0 for a parsed-but-empty payload', () => {
    const after = mergeHostStatus(
      snapshotWithHosts('Cloud API'), parseHostStatus('{"hosts":[]}'));
    assert.equal(after._meta.hostStatus.shape, 'hosts');
    assert.equal(after._meta.hostStatus.merged, 0);
    assert.equal(after.hosts[0].queued, null);
  });

  it('preserves the metrics _meta it did not touch', () => {
    const before = snapshotWithHosts('Cloud API');
    const after = mergeHostStatus(before, parseHostStatus(LIVE_CAPTURE));
    assert.equal(after._meta.production, before._meta.production);
    assert.equal(after._meta.hostCount, before._meta.hostCount);
    assert.deepEqual(after._meta.absentFamilies, before._meta.absentFamilies);
  });

  it('does not mutate the snapshot it was given', () => {
    const before = snapshotWithHosts('Cloud API');
    mergeHostStatus(before, parseHostStatus(JSON.stringify({
      hosts: [{ host: 'Cloud API', status: 'OK', queued: 42, errored: 1, messageCount: 1 }],
      _meta: { erroredAvailable: true },
    })));
    assert.equal(before.hosts[0].queued, null, 'the input snapshot must be untouched');
  });
});

describe('undescribedHosts — the direction a consumer feels (#36)', () => {
  const appHost = (host, isFramework = false) => ({
    host, type: 'process', status: 'OK', isFramework,
    queued: null, messages: 100, messagesPerSec: 1.2, errored: null,
    avgProcessingTime: 0.08, avgQueueingTime: 0,
    lastActivity: null, lastActivityElapsedSeconds: 4,
  });
  const APP = ['Cloud API', 'EMR Source', 'FHIR Transform', 'Lab Router'];
  const snapshot = () => ({
    hosts: [...APP.map((h) => appHost(h)), appHost('Ens.Alarm', true), appHost('Ens.MonitorService', true)],
    _meta: { polledAt: '2026-08-12T12:00:00Z' },
  });
  const status = (list) => ({
    byHost: new Map(list.map((h) => [h, { host: h, status: 'OK', queued: 0, errored: 0, messageCount: 1 }])),
    _meta: { sampledAt: 'x', hostCount: list.length, shape: 'hosts', available: true, erroredAvailable: true },
  });

  it('is empty when every application host is described', () => {
    const meta = mergeHostStatus(snapshot(), status(APP))._meta.hostStatus;
    assert.deepEqual(meta.undescribedHosts, []);
  });

  it('names an application host the endpoint did not describe', () => {
    // The failure that `merged === hostCount` cannot see: both counts shrink together,
    // so the previously-recommended check reports success while one host keeps null.
    const merged = mergeHostStatus(snapshot(), status(APP.slice(0, 3)));
    const meta = merged._meta.hostStatus;
    assert.equal(meta.merged, meta.hostCount, 'precondition: the old check looks healthy');
    assert.deepEqual(meta.undescribedHosts, ['Lab Router']);
    // And the consumer-visible symptom it explains.
    const labRouter = merged.hosts.find((h) => h.host === 'Lab Router');
    assert.equal(labRouter.queued, null);
  });

  it('ignores framework hosts, which the endpoint legitimately omits', () => {
    // On the live instance Ens.Alarm and Ens.MonitorService are absent from the endpoint
    // by design. Counting them would make the healthy state look broken.
    const meta = mergeHostStatus(snapshot(), status(APP))._meta.hostStatus;
    assert.ok(!meta.undescribedHosts.includes('Ens.Alarm'));
    assert.ok(!meta.undescribedHosts.includes('Ens.MonitorService'));
  });
});

/**
 * `type` from the production's own configuration (#127).
 *
 * The `hosttype` label rides only on the avg_* families, so a host nothing has flowed
 * through had no type and read `'unknown'` — 8 of 12 on the live instance. The status
 * endpoint's `Type` column covers every host it enumerates, so it fills the gap.
 *
 * The two properties worth protecting, in order of how quietly each would fail:
 *
 *   1. **Fill only, never overwrite.** The metrics label stays authoritative, so this
 *      cannot regress a type that was already resolved. That is what makes the change
 *      structurally incapable of the regression `parser.test.js`'s
 *      'leaves type unknown rather than guessing it from the host name' guards against.
 *   2. **A host neither source types stays `'unknown'`.** `Ens.Alarm` is one live —
 *      `EnumerateHostStatus` does not enumerate it. Naming it in `untypedHosts` is the
 *      alternative to guessing.
 */
describe('type filled from EnumerateHostStatus (#127)', () => {
  // The raw IRIS words, exactly as the live endpoint served them — see
  // fixtures/hoststatus-live-capture-hosttype.json.
  const body = (hosts) => JSON.stringify({
    hosts, _meta: { erroredAvailable: true, productionState: 'Running' },
  });
  const entry = (host, hostType) => ({ host, hostType, status: 'OK', queued: 0, errored: 0, messageCount: 1 });

  it('normalizes each raw IRIS word to the published vocabulary', () => {
    const { byHost } = parseHostStatus(body([
      entry('a', 'BusinessService'),
      entry('b', 'BusinessOperation'),
      entry('c', 'BusinessProcess'),
      // `Actor` is a business process in IRIS, not a fourth kind of host.
      entry('d', 'Actor'),
    ]));
    assert.equal(byHost.get('a').hostType, 'service');
    assert.equal(byHost.get('b').hostType, 'operation');
    assert.equal(byHost.get('c').hostType, 'process');
    assert.equal(byHost.get('d').hostType, 'process');
  });

  it('reads an absent, empty or unrecognized hostType as null, never as "unknown"', () => {
    // null is "this source has no opinion"; 'unknown' is a claim about the host. An older
    // dispatcher predating this field must leave the metrics value standing.
    const { byHost } = parseHostStatus(body([
      { host: 'legacy', status: 'OK', queued: 0, errored: 0, messageCount: 1 },
      entry('empty', ''),
      entry('nonsense', 'BusinessSomethingElse'),
      entry('notastring', 7),
    ]));
    for (const name of ['legacy', 'empty', 'nonsense', 'notastring']) {
      assert.equal(byHost.get(name).hostType, null, `${name} must be null`);
    }
  });

  it('fills a type the metrics text could not supply', () => {
    // The bug: no avg_* line for these hosts, so no `hosttype` label at all.
    const before = snapshotWithHosts('Ens.Actor', 'Ens.ScheduleService');
    assert.equal(before.hosts[0].type, 'unknown');
    assert.equal(before.hosts[1].type, 'unknown');

    const after = mergeHostStatus(before, parseHostStatus(body([
      entry('Ens.Actor', 'Actor'),
      entry('Ens.ScheduleService', 'BusinessService'),
    ])));
    assert.equal(after.hosts.find(h => h.host === 'Ens.Actor').type, 'process');
    assert.equal(after.hosts.find(h => h.host === 'Ens.ScheduleService').type, 'service');
    assert.equal(after._meta.hostStatus.typesFilled, 2);
    assert.deepEqual(after._meta.hostStatus.untypedHosts, []);
  });

  it('NEVER overwrites a type the metrics text already resolved', () => {
    // The zero-regression guarantee. Even when the two sources disagree outright, the
    // metrics label wins — so no host that was typed correctly can become typed wrongly.
    const text = 'iris_interop_hosts{id="LABDEMO",status="OK",host="Cloud API",'
      + 'production="P"} 1\n'
      + 'iris_interop_avg_processing_time{id="LABDEMO",host="Cloud API",'
      + 'hosttype="bo",production="P"} 0.9';
    const before = buildSnapshot(parsePrometheusText(text), '2026-08-26T13:00:00.000Z');
    assert.equal(before.hosts[0].type, 'operation');

    const after = mergeHostStatus(before,
      parseHostStatus(body([entry('Cloud API', 'BusinessService')])));
    assert.equal(after.hosts[0].type, 'operation');
    assert.equal(after._meta.hostStatus.typesFilled, 0);
  });

  it('keeps a disagreement visible instead of resolving it silently', () => {
    // Same shape as `statusFromMetrics`: the loser of the disagreement is recorded on the
    // host rather than dropped, and named in _meta so it is countable.
    const text = 'iris_interop_hosts{id="LABDEMO",status="OK",host="Cloud API",'
      + 'production="P"} 1\n'
      + 'iris_interop_avg_processing_time{id="LABDEMO",host="Cloud API",'
      + 'hosttype="bo",production="P"} 0.9';
    const after = mergeHostStatus(
      buildSnapshot(parsePrometheusText(text), '2026-08-26T13:00:00.000Z'),
      parseHostStatus(body([entry('Cloud API', 'BusinessService')])));
    assert.equal(after.hosts[0].typeFromConfig, 'service');
    assert.deepEqual(after._meta.hostStatus.typeDisagreements, [
      { host: 'Cloud API', fromMetrics: 'operation', fromConfig: 'service' },
    ]);
  });

  it('adds no typeFromConfig when the two sources agree', () => {
    const text = 'iris_interop_hosts{id="LABDEMO",status="OK",host="Cloud API",'
      + 'production="P"} 1\n'
      + 'iris_interop_avg_processing_time{id="LABDEMO",host="Cloud API",'
      + 'hosttype="bo",production="P"} 0.9';
    const after = mergeHostStatus(
      buildSnapshot(parsePrometheusText(text), '2026-08-26T13:00:00.000Z'),
      parseHostStatus(body([entry('Cloud API', 'BusinessOperation')])));
    assert.ok(!('typeFromConfig' in after.hosts[0]));
    assert.deepEqual(after._meta.hostStatus.typeDisagreements, []);
  });

  it('names a host neither source can type rather than guessing one', () => {
    // Ens.Alarm live: in the metrics text with no avg_* line, and not enumerated by
    // EnumerateHostStatus. It stays unknown, and says so.
    const after = mergeHostStatus(
      snapshotWithHosts('Ens.Actor', 'Ens.Alarm'),
      parseHostStatus(body([entry('Ens.Actor', 'Actor')])));
    assert.equal(after.hosts.find(h => h.host === 'Ens.Alarm').type, 'unknown');
    assert.deepEqual(after._meta.hostStatus.untypedHosts, ['Ens.Alarm']);
  });

  it('publishes no type at all rather than undefined for a hand-built byHost', () => {
    // The internal contract between parseHostStatus and mergeHostStatus: byHost entries
    // built by anything else (a caller, a fixture) must not be able to set type undefined.
    const after = mergeHostStatus(snapshotWithHosts('Cloud API'), {
      byHost: new Map([['Cloud API', { status: 'OK', queued: 0, errored: 0, messageCount: 1 }]]),
      _meta: { erroredAvailable: true },
    });
    assert.equal(after.hosts[0].type, 'unknown');
    assert.equal(after._meta.hostStatus.typesFilled, 0);
  });
});

/**
 * The same thing against the real capture, so the coverage above is not only synthetic.
 * `hoststatus-live-capture-hosttype.json` is the body the endpoint served over HTTP after
 * #127 added the field — see fixtures/README.md.
 */
describe('type from the real post-#127 capture', () => {
  const capture = fs.readFileSync(
    path.join(FIXTURES, 'hoststatus-live-capture-hosttype.json'), 'utf8');

  it('types every host the endpoint described', () => {
    const { byHost } = parseHostStatus(capture);
    assert.equal(byHost.size, 10);
    for (const [name, state] of byHost) {
      assert.ok(['service', 'operation', 'process'].includes(state.hostType),
        `${name} resolved to ${state.hostType}`);
    }
  });

  it('drops the unknown count on the hosts the metrics capture leaves untyped', () => {
    const metricsText = fs.readFileSync(
      path.join(FIXTURES, 'metrics-live-capture-3host.txt'), 'utf8');
    const before = buildSnapshot(parsePrometheusText(metricsText), '2026-08-26T13:00:00.000Z');
    const unknownBefore = before.hosts.filter(h => h.type === 'unknown').map(h => h.host);
    // Precondition: the capture really does leave most of the roster untyped.
    assert.ok(unknownBefore.length > 1, `expected several untyped, got ${unknownBefore.length}`);

    const after = mergeHostStatus(before, parseHostStatus(capture));
    const unknownAfter = after.hosts.filter(h => h.type === 'unknown').map(h => h.host);
    assert.ok(unknownAfter.length < unknownBefore.length,
      `${unknownBefore.length} -> ${unknownAfter.length}`);
    assert.deepEqual(unknownAfter, after._meta.hostStatus.untypedHosts);
    // Nothing that was typed lost or changed its type.
    for (const host of before.hosts.filter(h => h.type !== 'unknown')) {
      assert.equal(after.hosts.find(h => h.host === host.host).type, host.type);
    }
  });
});
