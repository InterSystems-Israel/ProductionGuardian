'use strict';

/**
 * smoke-test.js — assert a RUNNING proxy over HTTP.
 *
 * `npm test` covers the parser in isolation. This covers the part unit tests cannot:
 * that the process starts, reaches IRIS, and publishes something a consumer can use.
 *
 *   npm run smoke                 # against localhost:3001
 *   PROXY_PORT=3005 npm run smoke # against a mock on another port
 *
 * Exits non-zero on failure so it can gate a demo. Prints what it saw either way —
 * a green tick with no numbers is not evidence.
 *
 * Deliberately makes no assertion about WHICH hosts exist. The production changes; the
 * proxy is correct as long as it reports what IRIS said. The one structural claim is
 * that an interop-enabled instance yields at least one host.
 */

const http = require('http');

const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timed out after 5s')));
  });
}

async function main() {
  console.log(`\nmetrics-proxy smoke test → http://${HOST}:${PORT}\n`);

  // ── /proxy/health ───────────────────────────────────────────────────────────
  console.log('/proxy/health');
  let health;
  try {
    const res = await get('/proxy/health');
    check('responds 200', res.status === 200, `HTTP ${res.status}`);
    health = JSON.parse(res.body);
  } catch (err) {
    console.log(`  FAIL  cannot reach the proxy — ${err.message}`);
    console.log('\n        Is it running? `npm start` (real IRIS) or `npm run mock`.');
    process.exit(1);
  }

  // 'starting' means no poll has completed yet — a real failure for a smoke test, since
  // the first poll fires immediately at startup.
  check('a poll has completed', health.status !== 'starting', `status: ${health.status}`);

  // The check that catches a wrong IRIS_BASE_PATH, which has two distinct symptoms:
  //   - no prefix on port 80 → HTTP 200 from the %SYS web app, real system metrics, zero
  //     interop families. A poll "succeeds", so health carries a `hint`.
  //   - a wrong prefix → 404s, no poll ever completes, so health stays 'starting' and
  //     there is no hint to read. Requiring a completed poll is what catches this one;
  //     without it this check passed vacuously on an unreachable IRIS.
  const interopOk = health.status !== 'starting' && !health.hint;
  check('IRIS returned interop metrics', interopOk,
    health.hint ? 'health reported a hint — see below'
      : health.status === 'starting' ? 'no poll has completed — nothing was read yet'
      : `production: ${health.production}`);
  if (health.hint) console.log(`\n        ${health.hint}\n`);

  // ── /proxy/metrics ──────────────────────────────────────────────────────────
  console.log('\n/proxy/metrics');
  const mRes = await get('/proxy/metrics');
  check('responds 200', mRes.status === 200, `HTTP ${mRes.status}`);
  const metrics = JSON.parse(mRes.body);

  check('reports at least one host', metrics.hosts.length > 0,
    `${metrics.hosts.length} hosts`);
  check('names the production', !!metrics._meta.production,
    metrics._meta.production || 'null');

  const app = metrics.hosts.filter(h => !h.isFramework);
  const framework = metrics.hosts.filter(h => h.isFramework);
  check('distinguishes application hosts from framework hosts', framework.length > 0,
    `${app.length} application, ${framework.length} framework`);
  if (app.length) console.log(`        application: ${app.map(h => h.host).join(', ')}`);

  // Every host must carry the full field set, present-or-null. A consumer reading
  // `h.errored` must get null rather than undefined, or `undefined > threshold` silently
  // evaluates false and the rule never fires.
  const FIELDS = ['host', 'type', 'status', 'isFramework', 'queued', 'messages',
    'messagesPerSec', 'errored', 'avgProcessingTime', 'avgQueueingTime',
    'lastActivity', 'lastActivityElapsedSeconds'];
  const missing = [];
  for (const h of metrics.hosts) {
    for (const f of FIELDS) if (!(f in h)) missing.push(`${h.host}.${f}`);
  }
  check('every host carries the full field set', missing.length === 0,
    missing.length ? missing.slice(0, 5).join(', ') : `${FIELDS.length} fields × ${metrics.hosts.length} hosts`);

  // No numeric field may be `undefined` — see above. null is correct and expected.
  const undef = [];
  for (const h of metrics.hosts) {
    for (const f of FIELDS) if (h[f] === undefined) undef.push(`${h.host}.${f}`);
  }
  check('no field is undefined (null is the correct "not measured")', undef.length === 0,
    undef.length ? undef.slice(0, 5).join(', ') : 'ok');

  // A phantom host manufactured from the `id` (namespace) label was a real bug (#10).
  const phantom = metrics.hosts.filter(h =>
    ['LABDEMO', 'IRISSYS', '%SYS', 'all', 'Lock_Table'].includes(h.host) ||
    h.host === metrics._meta.production);
  check('no host invented from a namespace label', phantom.length === 0,
    phantom.length ? phantom.map(h => h.host).join(', ') : 'ok');

  // Read defensively: before the first poll completes the route answers with the warming
  // payload, whose `_meta` carries only `polledAt`. Indexing into it unguarded crashed the
  // run with a TypeError and skipped every /proxy/alerts check below.
  const absent = metrics._meta.absentFamilies;
  check('reports which metric families IRIS omitted', Array.isArray(absent),
    Array.isArray(absent)
      ? (absent.length ? absent.join(', ') : 'none absent')
      : `absentFamilies missing${metrics.warming ? ' (warming — no poll yet)' : ''}`);

  // ── /proxy/alerts ───────────────────────────────────────────────────────────
  console.log('\n/proxy/alerts');
  const aRes = await get('/proxy/alerts');
  check('responds 200', aRes.status === 200, `HTTP ${aRes.status}`);
  const alerts = JSON.parse(aRes.body);

  check('returns an alerts array', Array.isArray(alerts.alerts),
    `${alerts.alerts.length} accumulated`);

  // The shape names how the upstream payload was read. Anything outside this set means
  // the mapping did not recognise the body, and a zero there is not a healthy zero.
  const OK_SHAPES = ['array', 'empty'];
  const shapeOk = OK_SHAPES.includes(alerts._meta.shape)
    || String(alerts._meta.shape).startsWith('wrapped:');
  check('upstream payload shape was recognised', shapeOk,
    `shape: ${alerts._meta.shape}`);
  if (!shapeOk && alerts._meta.raw) {
    console.log(`        raw payload: ${String(alerts._meta.raw).slice(0, 200)}`);
  }

  // Metrics counts alerts independently. Disagreement hints at a shape mismatch.
  check('no suspected shape mismatch against the metrics side',
    alerts._meta.suspectShapeMismatch !== true,
    `systemAlertsNew: ${alerts._meta.systemAlertsNew}, newInLastPoll: ${alerts._meta.newInLastPoll}`);

  if (alerts._meta.systemAlertsLog > 0 && alerts.alerts.length === 0) {
    console.log(`        note: alerts.log holds ${alerts._meta.systemAlertsLog} alert(s) but this`);
    console.log('        buffer is empty. /api/monitor/alerts is consume-on-read, so they were');
    console.log('        cleared before this proxy started — expected, not a failure.');
  }

  // ── Result ──────────────────────────────────────────────────────────────────
  console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.log(`\nsmoke test crashed: ${err.stack}\n`);
  process.exit(1);
});
