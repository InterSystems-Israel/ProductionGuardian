'use strict';

/**
 * alerts.test.js — unit tests for the /api/monitor/alerts normalizer.
 * Run with: node --test src/alerts.test.js
 *
 * The point of these is the NEGATIVE cases. `system_alert` is the only finding type
 * fed from this endpoint, and the shape of the upstream payload is not yet pinned by
 * a capture — so the failure mode that matters is publishing an empty list for a
 * reason other than "there are no alerts", silently.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAlerts } = require('./alerts');

const TS = '2026-08-11T12:00:00.000Z';

describe('normalizeAlerts — shapes that carry alerts', () => {
  it('passes a bare array through', () => {
    const out = normalizeAlerts('[{"text":"disk full"}]', TS);
    assert.equal(out.alerts.length, 1);
    assert.equal(out.alerts[0].text, 'disk full');
    assert.equal(out._meta.shape, 'array');
    assert.equal(out._meta.count, 1);
    assert.equal(out._meta.polledAt, TS);
  });

  it('accepts an already-parsed array, not only a string', () => {
    const out = normalizeAlerts([{ text: 'a' }, { text: 'b' }], TS);
    assert.equal(out.alerts.length, 2);
    assert.equal(out._meta.shape, 'array');
  });

  it('unwraps an object that wraps the list under "alerts"', () => {
    // THE REGRESSION: the previous poller did `if (!Array.isArray(x)) x = []`, so this
    // exact payload published zero alerts on an instance that had two, and
    // system_alert could never fire with nothing indicating why.
    const out = normalizeAlerts('{"alerts":[{"text":"one"},{"text":"two"}]}', TS);
    assert.equal(out.alerts.length, 2);
    assert.equal(out._meta.shape, 'wrapped:alerts');
    assert.equal(out._meta.count, 2);
  });

  it('unwraps the other plausible wrapper keys IRIS might use', () => {
    for (const key of ['Alerts', 'result', 'results', 'content', 'data']) {
      const out = normalizeAlerts(JSON.stringify({ [key]: [{ text: 'x' }] }), TS);
      assert.equal(out.alerts.length, 1, `${key} should unwrap`);
      assert.equal(out._meta.shape, `wrapped:${key}`);
    }
  });

  it('wraps a single alert object rather than losing it', () => {
    const out = normalizeAlerts('{"text":"abnormal shutdown","severity":"warning"}', TS);
    assert.equal(out.alerts.length, 1);
    assert.equal(out.alerts[0].text, 'abnormal shutdown');
    assert.equal(out._meta.shape, 'single-object');
  });
});

describe('normalizeAlerts — empty is distinguishable from broken', () => {
  it('treats an empty body as a legitimate zero, not a failure', () => {
    const out = normalizeAlerts('', TS);
    assert.deepEqual(out.alerts, []);
    assert.equal(out._meta.shape, 'empty');
    // No error key: this is a healthy answer and must not read as a mapping gap.
    assert.equal(out._meta.error, undefined);
  });

  it('treats an empty array as a legitimate zero', () => {
    const out = normalizeAlerts('[]', TS);
    assert.deepEqual(out.alerts, []);
    assert.equal(out._meta.shape, 'array');
    assert.equal(out._meta.count, 0);
  });

  it('reports unparseable JSON instead of pretending there are no alerts', () => {
    const out = normalizeAlerts('<html>401 Unauthorized</html>', TS);
    assert.deepEqual(out.alerts, []);
    assert.equal(out._meta.shape, 'unparseable');
    assert.ok(out._meta.error, 'must carry the parse error');
    // The body is kept so the cause is diagnosable from the endpoint alone — an HTML
    // error page here means auth or routing, not an alert-free production.
    assert.match(out._meta.raw, /401/);
  });

  it('truncates a huge unparseable body rather than logging all of it', () => {
    const out = normalizeAlerts('x'.repeat(10000), TS);
    assert.equal(out._meta.shape, 'unparseable');
    assert.ok(out._meta.raw.length <= 500, `raw was ${out._meta.raw.length} chars`);
  });

  it('reports an unrecognized object and keeps the payload', () => {
    const out = normalizeAlerts('{"totallyUnexpected":{"nested":1}}', TS);
    assert.deepEqual(out.alerts, []);
    assert.equal(out._meta.shape, 'unrecognized-object');
    assert.deepEqual(out._meta.keys, ['totallyUnexpected']);
    assert.ok(out._meta.raw, 'payload must be preserved for diagnosis');
  });

  it('does not promote an arbitrary object into a fabricated alert', () => {
    // No alert-ish key, so it must NOT become `alerts: [thatObject]` — that would
    // invent an alert out of a config blob or an error envelope.
    const out = normalizeAlerts('{"namespace":"LABDEMO","count":0}', TS);
    assert.deepEqual(out.alerts, []);
    assert.equal(out._meta.shape, 'unrecognized-object');
  });

  it('handles null and scalars without throwing', () => {
    assert.deepEqual(normalizeAlerts('null', TS).alerts, []);
    assert.equal(normalizeAlerts('null', TS)._meta.shape, 'null');
    assert.deepEqual(normalizeAlerts(undefined, TS).alerts, []);
    assert.equal(normalizeAlerts('42', TS)._meta.shape, 'unrecognized-number');
    assert.equal(normalizeAlerts('true', TS)._meta.shape, 'unrecognized-boolean');
  });

  it('never throws on any input', () => {
    const inputs = ['', '   ', '{', '[', 'null', 'undefined', '{"a":', [], {}, 0, false, null];
    for (const input of inputs) {
      assert.doesNotThrow(() => normalizeAlerts(input, TS), `threw on ${JSON.stringify(input)}`);
    }
  });
});

describe('normalizeAlerts — the committed fixture', () => {
  it('parses fixtures/alerts.json into one alert', () => {
    const fs = require('fs');
    const path = require('path');
    const body = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'alerts.json'), 'utf8');
    const out = normalizeAlerts(body, TS);
    assert.equal(out._meta.shape, 'array');
    assert.equal(out.alerts.length, 1);
    assert.equal(out.alerts[0].source, 'CloudAPI');
  });
});
