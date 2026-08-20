/**
 * Validate contracts/samples/ against the schemas. This is the `contracts` CI job.
 *
 *   node contracts/validate.mjs
 *
 * Covers both contracts: healthscan (Dev B -> Dev C) and proxy (Dev A -> Dev B).
 *
 * Exits non-zero on the first failure, so it works unchanged as a CI step.
 *
 * Why a script rather than an ajv-cli one-liner:
 *
 *   1. Per-definition validation is the only way to catch a hosts array served in the
 *      findings position. A root `oneOf` accepts either and cannot tell them apart —
 *      that check silently does not happen.
 *   2. `ajv validate -r '#/definitions/HostsResponse'` is not portable: Git Bash on
 *      Windows rewrites the `#/...` argument into a filesystem path and the command
 *      fails with "Cannot find schema".
 *   3. `-c ajv-formats` resolves relative to the invocation directory, so the CLI form
 *      degrades to ignoring `format` when run from the wrong place — weakening the
 *      check without failing. Both defects Dev C found on PR #3 were structural, which
 *      is exactly the class a silently-weakened validator misses.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_ID = 'https://production-guardian/contracts/healthscan.schema.json';
const PROXY_SCHEMA_ID = 'https://production-guardian/contracts/proxy.schema.json';
const INVESTIGATION_SCHEMA_ID = 'https://production-guardian/contracts/investigation.schema.json';

/** Each sample is validated against ONE named definition, never "either". */
const CASES = [
  { file: 'samples/hosts-response.json', definition: 'HostsResponse' },
  { file: 'samples/findings-response.json', definition: 'FindingsResponse' },
];

/**
 * The MVP 2/3 investigation shape, validated against its own schema.
 *
 * `samples/investigation-response.json` is CAPTURED from a live run against a real LLM
 * (`source: "agent"`, gpt-4o-mini, 5 tool calls) with only the ids and timestamp pinned so the
 * fixture does not move. Same rule as the MVP 1 samples: a hand-written sample proves the schema
 * accepts what its author imagined, and a captured one proves it accepts what the system emits.
 */
const INVESTIGATION_CASES = [
  { file: 'samples/investigation-response.json', definition: 'InvestigationResponse' },
];

/**
 * Investigation cases that must FAIL, and each one is a defect that actually reached `main` or a
 * safety property the schema exists to hold.
 *
 * The first two are the reason `manualRemediation` is a separate shape rather than a flag: a
 * consumer must not be able to receive something that looks approvable when it is not.
 */
const INVESTIGATION_MUST_REJECT = [
  {
    name: 'manualRemediation carrying an action object — a UI could render Approve for it',
    definition: 'ManualRemediation',
    data: {
      summary: 'EMR Source polls a directory that does not exist',
      steps: ['create the directory'],
      target: null,
      appliedBy: 'operator',
      action: { type: 'set_pool_size', host: 'EMR Source', size: 4 },
    },
  },
  {
    name: "appliedBy 'system' — autonomous remediation, which root CLAUDE.md §2.1 forbids",
    definition: 'ManualRemediation',
    data: { summary: 'x', steps: ['y'], target: null, appliedBy: 'system' },
  },
  {
    name: 'target carrying a message-content key — the data boundary in schema form',
    definition: 'ManualRemediation',
    data: {
      summary: 'x',
      steps: ['y'],
      appliedBy: 'operator',
      target: { host: 'EMR Source', setting: 'FilePath', currentValue: '/x', messageBody: 'PID|...' },
    },
  },
  {
    name: 'steps: [] — a manual remediation with no steps says nothing',
    definition: 'ManualRemediation',
    data: { summary: 'x', steps: [], target: null, appliedBy: 'operator' },
  },
  {
    name: "evidence source 'tool' instead of 'mcp_tool' — the enum that keeps provenance honest",
    definition: 'EvidenceItem',
    data: { label: 'a', detail: 'b', source: 'tool', tool: null },
  },
  {
    name: 'action with a fourth key — resolve-api.md §1.1 refuses unknown keys inside action',
    definition: 'ResolveAction',
    data: { type: 'set_pool_size', host: 'Cloud API', size: 4, force: true },
  },
  {
    name: "action.type 'restart_host' — one action type in MVP 2, enumerated so a second is a decision",
    definition: 'ResolveAction',
    data: { type: 'restart_host', host: 'Cloud API', size: 4 },
  },
];

/**
 * Cases that must FAIL. A validator that accepts everything would pass the positive
 * cases too, so these are what make the positive results mean something.
 */
const MUST_REJECT = [
  {
    name: 'retired "Warning" host status',
    definition: 'HostsResponse',
    data: [
      {
        host: 'X',
        type: 'process',
        status: 'Warning',
        queued: 0,
        messagesPerSec: 0,
        errored: 0,
        avgProcessingTime: 0,
        avgQueueingTime: 0,
        lastActivity: '2026-08-06T15:00:00Z',
      },
    ],
  },
  {
    name: 'hosts array served in the findings position',
    definition: 'FindingsResponse',
    data: [
      {
        host: 'X',
        type: 'process',
        status: 'OK',
        queued: 0,
        messagesPerSec: 0,
        errored: 0,
        avgProcessingTime: 0,
        avgQueueingTime: 0,
        lastActivity: '2026-08-06T15:00:00Z',
      },
    ],
  },
  {
    name: 'timestamp with no timezone',
    definition: 'FindingsResponse',
    data: [
      {
        id: 'f-1',
        host: 'X',
        type: 'queue_buildup',
        severity: 'warning',
        currentValue: 1,
        baselineValue: 1,
        detectedAt: '2026-08-06 15:00:00',
        message: 'm',
      },
    ],
  },
  {
    name: 'unknown finding type',
    definition: 'FindingsResponse',
    data: [
      {
        id: 'f-1',
        host: 'X',
        type: 'made_up_type',
        severity: 'warning',
        currentValue: 1,
        baselineValue: 1,
        detectedAt: '2026-08-06T15:00:00Z',
        message: 'm',
      },
    ],
  },
  {
    name: 'baselineValue as a string',
    definition: 'FindingsResponse',
    data: [
      {
        id: 'f-1',
        host: 'X',
        type: 'queue_buildup',
        severity: 'warning',
        currentValue: 1,
        baselineValue: 'nope',
        detectedAt: '2026-08-06T15:00:00Z',
        message: 'm',
      },
    ],
  },
  {
    // Q13 widened `queued` to accept null. It must not have widened to accept
    // anything else — a string count is what an unvalidated proxy would leak.
    name: 'queued as a string',
    definition: 'HostsResponse',
    data: [
      {
        host: 'X',
        type: 'process',
        status: 'OK',
        queued: '0',
        messagesPerSec: 0,
        errored: 0,
        avgProcessingTime: 0,
        avgQueueingTime: 0,
        lastActivity: '2026-08-06T15:00:00Z',
      },
    ],
  },
  {
    // `null` is a value, not an excuse to omit the key (§1).
    name: 'queued key omitted entirely',
    definition: 'HostsResponse',
    data: [
      {
        host: 'X',
        type: 'process',
        status: 'OK',
        messagesPerSec: 0,
        errored: 0,
        avgProcessingTime: 0,
        avgQueueingTime: 0,
        lastActivity: '2026-08-06T15:00:00Z',
      },
    ],
  },
];

/**
 * Structural cases that must PASS. `[]` is the single most common healthy response
 * (§3), and every language's native ISO formatter emits sub-second digits — JS gives
 * milliseconds, Python microseconds.
 */
const MUST_ACCEPT = [
  { name: 'empty hosts array', definition: 'HostsResponse', data: [] },
  { name: 'empty findings array', definition: 'FindingsResponse', data: [] },
  {
    name: 'JS toISOString() milliseconds',
    definition: 'FindingsResponse',
    data: [
      {
        id: 'f-1',
        host: 'X',
        type: 'queue_buildup',
        severity: 'warning',
        currentValue: 1,
        baselineValue: null,
        detectedAt: '2026-08-06T15:00:00.000Z',
        message: 'm',
      },
    ],
  },
  {
    name: 'Python isoformat() microseconds',
    definition: 'FindingsResponse',
    data: [
      {
        id: 'f-1',
        host: 'X',
        type: 'queue_buildup',
        severity: 'warning',
        currentValue: 1,
        baselineValue: null,
        detectedAt: '2026-08-06T15:00:00.123456Z',
        message: 'm',
      },
    ],
  },
  {
    /*
     * Q13. The samples carry measured counts, so this is the shape they do NOT
     * cover: a host the proxy's host-status merge did not reach. Without this case
     * the nullability is declared and never exercised.
     */
    name: 'host with unmeasurable queued and errored counts',
    definition: 'HostsResponse',
    data: [
      {
        host: 'Lab Router',
        type: 'process',
        status: 'OK',
        queued: null,
        messagesPerSec: 1.2,
        errored: null,
        avgProcessingTime: 0.08,
        avgQueueingTime: 0.02,
        lastActivity: '2026-08-12T10:00:00Z',
      },
    ],
  },
];

/**
 * The proxy contract's own cases. Separate arrays rather than a `schema` field on the
 * existing ones, so nothing above changes shape.
 *
 * `samples/metrics-dump.txt` is raw Prometheus text, not JSON, so it cannot be validated
 * against a schema the way the healthscan samples are — the structural check below is
 * what covers it. The snapshot here carries the real Lab Router values that
 * `services/metrics-proxy/src/parser.js` produces from that capture, so a schema that
 * stopped accepting the proxy's actual output fails here.
 */
const REAL_LAB_ROUTER = {
  host: 'Lab Router',
  type: 'process',
  status: 'OK',
  isFramework: false,
  queued: null,
  messages: 126,
  messagesPerSec: 1.2,
  errored: null,
  avgProcessingTime: 0.08,
  avgQueueingTime: 0,
  lastActivity: '2026-08-11T23:59:55.162Z',
  lastActivityElapsedSeconds: 4.838,
};

/**
 * The same host as the proxy publishes it once the host-status endpoint is merged in
 * (issues #12, #31). Measured live 2026-08-12 from `GET /proxy/metrics` against LABDEMO:
 * `queued` and `errored` are numbers here, not nulls, and both were 0 — a real drained
 * queue and a real zero error count, not placeholders.
 *
 * Both spellings must validate: `queued: null` stays legal because the endpoint can be
 * absent, and a schema that only accepted one of the two would reject a real payload.
 */
const REAL_LAB_ROUTER_MERGED = {
  ...REAL_LAB_ROUTER,
  queued: 0,
  errored: 0,
};

const PROXY_MUST_ACCEPT = [
  {
    name: 'real Lab Router host, nulls included',
    definition: 'ProxyHost',
    data: REAL_LAB_ROUTER,
  },
  {
    name: 'real Lab Router host with queued/errored merged in (#12, #31)',
    definition: 'ProxyHost',
    data: REAL_LAB_ROUTER_MERGED,
  },
  {
    name: 'a genuinely backed-up host: queued 70, status Disabled',
    definition: 'ProxyHost',
    // The state measured on this instance behind #12 — a disabled operation holding 70
    // messages. `queue_buildup` is the finding that needs this to validate.
    data: {
      ...REAL_LAB_ROUTER_MERGED,
      host: 'Cloud API',
      type: 'operation',
      status: 'Disabled',
      queued: 70,
      errored: 3,
      statusFromMetrics: 'OK',
    },
  },
  {
    name: 'metrics response carrying hostStatus merge diagnostics',
    definition: 'MetricsResponse',
    data: {
      hosts: [REAL_LAB_ROUTER_MERGED],
      systemAlertsNew: 0,
      systemAlertsLog: 1,
      _meta: {
        polledAt: '2026-08-12T11:07:14.093Z',
        production: 'LABDEMO.Production',
        productionQueued: 0,
        absentFamilies: [],
        hostCount: 15,
        applicationHostCount: 4,
        hostStatus: {
          polledAt: '2026-08-12T11:07:14.094Z',
          shape: 'hosts',
          hostCount: 13,
          skippedEntries: 0,
          sampledAt: '2026-08-12T11:07:14.108Z',
          production: 'LABDEMO.Production',
          productionState: 'Running',
          erroredAvailable: true,
          merged: 13,
          unmatchedHosts: [],
        },
      },
    },
  },
  {
    name: 'hostStatus reporting the endpoint was unavailable',
    definition: 'MetricsMeta',
    // The degraded case: queued/errored are null for a configuration reason, and this is
    // what says so. Without it a consumer cannot tell it from a genuinely idle production.
    data: {
      polledAt: '2026-08-12T11:07:14.093Z',
      production: 'LABDEMO.Production',
      productionQueued: 0,
      absentFamilies: [],
      hostCount: 15,
      applicationHostCount: 4,
      hostStatus: { shape: null, merged: 0, available: false },
    },
  },
  {
    name: 'hostStatus reporting a join-key divergence (answered, matched nothing)',
    definition: 'HostStatusMeta',
    data: {
      shape: 'hosts',
      hostCount: 13,
      merged: 0,
      unmatchedHosts: ['CloudAPI', 'LabRouter'],
      productionState: 'Running',
      erroredAvailable: true,
    },
  },
  {
    name: 'warming metrics response (200, not 503)',
    definition: 'MetricsResponse',
    data: { hosts: [], systemAlertsNew: null, warming: true, _meta: { polledAt: null } },
  },
  {
    name: 'real metrics response',
    definition: 'MetricsResponse',
    data: {
      hosts: [REAL_LAB_ROUTER],
      systemAlertsNew: 1,
      systemAlertsLog: 1,
      _meta: {
        polledAt: '2026-08-12T00:00:00Z',
        production: 'LABDEMO.Production',
        productionQueued: 0,
        absentFamilies: [],
        hostCount: 15,
        applicationHostCount: 4,
      },
    },
  },
  {
    name: 'real alert, severity as the numeric string IRIS emits',
    definition: 'ProxyAlert',
    data: {
      time: '2026-08-11T04:12:07.382Z',
      severity: '2',
      message: '^ISCSOAP in Namespace MAIN has been active for 452 day(s).',
      observedAt: '2026-08-12T08:45:30.264Z',
    },
  },
  {
    name: 'health reporting a reachable instance with no interop metrics',
    definition: 'HealthResponse',
    data: {
      status: 'reachable, but no interop metrics',
      uptime: 2.58,
      lastPoll: '2026-08-12T08:50:16.079Z',
      production: null,
      hostCount: 0,
      applicationHostCount: 0,
      hint: 'IRIS answered but sent no iris_interop_* families.',
    },
  },
];

/**
 * The proxy cases that must FAIL. The last two are the engine's current shape
 * (`name`, `messagesErrored`) — see `proxy-api.md` §5.2. They are here so that if the
 * naming question in §6.2 is settled the other way, this check says so.
 */
const PROXY_MUST_REJECT = [
  {
    name: 'status "Active" — not in the IRIS enum',
    definition: 'ProxyHost',
    data: { ...REAL_LAB_ROUTER, status: 'Active' },
  },
  {
    name: 'type "actor" — must be normalized to process',
    definition: 'ProxyHost',
    data: { ...REAL_LAB_ROUTER, type: 'actor' },
  },
  {
    name: 'lastActivity with an offset instead of Z',
    definition: 'ProxyHost',
    data: { ...REAL_LAB_ROUTER, lastActivity: '2026-08-11T23:59:55+00:00' },
  },
  {
    name: 'null host name',
    definition: 'ProxyHost',
    data: { ...REAL_LAB_ROUTER, host: null },
  },
  {
    name: 'metrics response with no _meta',
    definition: 'MetricsResponse',
    data: { hosts: [] },
  },
  {
    name: 'alerts response served in the metrics position',
    definition: 'MetricsResponse',
    data: { alerts: [], _meta: { polledAt: null, shape: 'empty', count: 0 } },
  },
  {
    name: 'engine-shaped host: `name` instead of `host`',
    definition: 'ProxyHost',
    data: (() => {
      const { host, ...rest } = REAL_LAB_ROUTER;
      return { ...rest, name: host };
    })(),
  },
  {
    name: 'engine-shaped host: `messagesErrored` instead of `errored`',
    definition: 'ProxyHost',
    data: (() => {
      const { errored, ...rest } = REAL_LAB_ROUTER;
      return { ...rest, messagesErrored: 0 };
    })(),
  },
  {
    name: 'negative queue depth',
    definition: 'ProxyHost',
    // A queue cannot be -1. NullableCount has minimum 0, and this asserts the merge
    // cannot introduce a value the schema would have caught on the metrics path.
    data: { ...REAL_LAB_ROUTER_MERGED, queued: -1 },
  },
  {
    name: 'queued as a string, as EnumerateHostStatus hands it over',
    definition: 'ProxyHost',
    // The underlying query returns Queue as a STRING (and '' for idle). The proxy must
    // coerce it to a number; publishing '70' would typecheck nowhere downstream.
    data: { ...REAL_LAB_ROUTER_MERGED, queued: '70' },
  },
  {
    name: 'hostStatus.shape outside the known set',
    definition: 'HostStatusMeta',
    // An unrecognised shape means a consumer cannot reason about why a merge produced
    // nothing, which is the whole purpose of the field.
    data: { shape: 'probably-fine', merged: 0 },
  },
  {
    name: 'hostStatus.merged as a negative number',
    definition: 'HostStatusMeta',
    data: { shape: 'hosts', merged: -1 },
  },
];

/**
 * Structural claims about the raw capture. Not a schema check — it is a text body — but
 * the contract quotes label shapes out of it, so a capture that lost them would make
 * `proxy-api.md` describe something no longer in the repo.
 *
 * Both `_absent` lines are the point: they are what §6.1 and §6.3 are about, and an
 * assertion that a label is *missing* is the only way a future capture silently gaining
 * it gets noticed.
 */
const CAPTURE_CLAIMS = [
  { name: 'host label is `host`, with spaces', re: /^iris_interop_hosts\{[^}]*host="Lab Router"/m },
  { name: 'status is a label, and reads OK', re: /^iris_interop_hosts\{[^}]*status="OK"/m },
  { name: 'last_activity is elapsed seconds', re: /^iris_interop_last_activity\{[^}]*host="Lab Router"[^}]*\} 4\.838$/m },
  { name: 'hosttype rides on avg_processing_time as `actor`', re: /^iris_interop_avg_processing_time\{[^}]*hosttype="actor"/m },
  { name: 'sample_count is its own family, per (host, messagetype)', re: /^iris_interop_sample_count\{[^}]*host="Lab Router"[^}]*messagetype="ORM_O01"/m },
  { name: 'queued carries NO host label (§6.1)', re: /^iris_interop_queued\{id="LABDEMO",production="LABDEMO\.Production"\} 0$/m },
  { name: 'messages_errored carries NO host label (§6.3)', re: /^iris_interop_messages_errored\{id="LABDEMO",production="LABDEMO\.Production"\} 0$/m },
];

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(join(here, 'healthscan.schema.json'), 'utf8')));
ajv.addSchema(JSON.parse(readFileSync(join(here, 'proxy.schema.json'), 'utf8')));
ajv.addSchema(JSON.parse(readFileSync(join(here, 'investigation.schema.json'), 'utf8')));

const validatorFor = (definition) => {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`no such definition: ${definition}`);
  return validate;
};

const proxyValidatorFor = (definition) => {
  const validate = ajv.getSchema(`${PROXY_SCHEMA_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`no such proxy definition: ${definition}`);
  return validate;
};

const investigationValidatorFor = (definition) => {
  const validate = ajv.getSchema(`${INVESTIGATION_SCHEMA_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`no such investigation definition: ${definition}`);
  return validate;
};

let failures = 0;
const report = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

for (const { file, definition } of CASES) {
  const validate = validatorFor(definition);
  const data = JSON.parse(readFileSync(join(here, file), 'utf8'));
  const ok = validate(data);
  report(ok, `${file} against ${definition}`);
  if (!ok) console.log(`      ${ajv.errorsText(validate.errors)}`);
}

for (const { name, definition, data } of MUST_ACCEPT) {
  const validate = validatorFor(definition);
  const ok = validate(data);
  report(ok, `accepts: ${name}`);
  if (!ok) console.log(`      ${ajv.errorsText(validate.errors)}`);
}

for (const { file, definition } of INVESTIGATION_CASES) {
  const validate = investigationValidatorFor(definition);
  const data = JSON.parse(readFileSync(join(here, file), 'utf8'));
  report(validate(data), `${file} validates as ${definition}`);
  if (validate.errors) console.log(JSON.stringify(validate.errors, null, 2));
}

for (const { name, definition, data } of INVESTIGATION_MUST_REJECT) {
  const validate = investigationValidatorFor(definition);
  report(!validate(data), `rejects: ${name}`);
}

for (const { name, definition, data } of MUST_REJECT) {
  const validate = validatorFor(definition);
  report(!validate(data), `rejects: ${name}`);
}

for (const { name, definition, data } of PROXY_MUST_ACCEPT) {
  const validate = proxyValidatorFor(definition);
  const ok = validate(data);
  report(ok, `proxy accepts: ${name}`);
  if (!ok) console.log(`      ${ajv.errorsText(validate.errors)}`);
}

for (const { name, definition, data } of PROXY_MUST_REJECT) {
  const validate = proxyValidatorFor(definition);
  report(!validate(data), `proxy rejects: ${name}`);
}

const capture = readFileSync(join(here, 'samples/metrics-dump.txt'), 'utf8');
for (const { name, re } of CAPTURE_CLAIMS) {
  report(re.test(capture), `metrics-dump.txt: ${name}`);
}

console.log(
  failures === 0
    ? `\nall checks passed (${CASES.length + INVESTIGATION_CASES.length} samples, ${MUST_ACCEPT.length + PROXY_MUST_ACCEPT.length} accept, `
      + `${MUST_REJECT.length + PROXY_MUST_REJECT.length + INVESTIGATION_MUST_REJECT.length} reject, ${CAPTURE_CLAIMS.length} capture claims)`
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
