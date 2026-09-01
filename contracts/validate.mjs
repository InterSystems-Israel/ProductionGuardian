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
const RESOLVE_SCHEMA_ID = 'https://production-guardian/contracts/resolve.schema.json';

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
 * The Smart Resolve response, which had no schema and no sample until #202 — the one MVP 2 contract
 * nothing machine-checked, and the reason five things in it drifted unnoticed.
 *
 * THREE samples rather than one, because the shape is outcome-dependent and one capture cannot
 * exercise it: `confirmation` is an object only on `applied`, `refusal` only on `refused`, and
 * `before`/`after`/`reversal` are null on a refusal. A single sample would leave the two branches a
 * consumer actually has to handle uncovered.
 *
 * ALL THREE ARE CAPTURED from `POST http://localhost:3002/api/resolve` against the live stack, with
 * only `resolveId`, `auditId` and the timestamps pinned — same rule as `investigation-response.json`.
 * `requestedBy` is left as the capture's own label rather than rewritten to `dashboard`, which is
 * §8's point about the field made visible: it is advisory, caller-supplied, and recorded NEXT TO the
 * server-resolved `actor` rather than in place of it.
 *
 * The preview and the refusal mutate nothing. The `applied` capture did move `Cloud API` from
 * PoolSize 1 to 4 on the demo instance, and it was restored afterwards — `role: "%All"` in all three
 * is not a placeholder, it is #104.
 */
const RESOLVE_CASES = [
  { file: 'samples/resolve-response.json', definition: 'ResolveResponse' },
  { file: 'samples/resolve-preview.json', definition: 'ResolveResponse' },
  { file: 'samples/resolve-refusal.json', definition: 'ResolveResponse' },
  // The request that produced `resolve-refusal.json`, captured as a matched pair. Sent as a
  // §1.1-COMPLIANT apply -- `requestId` and `origin.findingId` present -- which the original capture
  // was not: all three responses carried `requestId: null`, two of them on an `apply`, so the samples
  // collectively taught the opposite of what §1.1 requires. `size: 9` is refused by the governed tool
  // before any write, so this pair costs one audit row and moves nothing.
  { file: 'samples/resolve-request.json', definition: 'ResolveRequest' },
];

/** A valid `applied` response, mutated per case below so each rejection isolates one field. */
const RESOLVE_BASE = {
  resolveId: 'res-Cloud-API-1788278400000',
  requestId: null,
  mode: 'apply',
  requestedAt: '2026-09-01T16:00:00Z',
  outcome: 'applied',
  action: { type: 'set_pool_size', host: 'Cloud API', size: 4 },
  before: { poolSize: 1 },
  after: { poolSize: 4 },
  reversal: { host: 'Cloud API', size: 1, capturedFrom: 'live' },
  refusal: null,
  failure: null,
  confirmation: {
    status: 'pending',
    findingId: 'f-3001',
    observeVia: 'GET /api/healthscan/findings',
    expectedWithinSeconds: 120,
    directEvidence: false,
  },
  audit: {
    auditId: 'pg-audit-596',
    actor: 'SuperUser',
    role: '%All',
    requestedBy: 'dashboard',
    tool: 'SetPoolSize',
    recordedAt: '2026-09-01T16:00:00Z',
    source: 'live',
  },
  completedAt: '2026-09-01T16:00:00Z',
};

/**
 * A §1.1-complete `apply` request, mutated per case below. Deliberately not the captured sample:
 * `RESOLVE_BASE` is not the captured response either, and a base that doubles as a fixture makes a
 * failing rejection ambiguous between "the schema changed" and "the capture changed".
 */
const RESOLVE_REQUEST_BASE = {
  requestId: 'rq-6f2c1e',
  mode: 'apply',
  action: { type: 'set_pool_size', host: 'Cloud API', size: 4 },
  origin: { findingId: 'f-1042', investigationId: 'inv-8801' },
  precondition: { poolSize: 1 },
  requestedBy: 'presenter@laptop',
};

/**
 * `RESOLVE_BASE` itself, asserted valid. Every rejection below is `RESOLVE_BASE` with one field
 * changed, so a base the schema already refuses would make all six pass while testing nothing.
 * `RESOLVE_REQUEST_BASE` is here for the same reason, and the two extra accepts after it are
 * asserting that the request's conditional requireds and its open root are both deliberate.
 */
const RESOLVE_MUST_ACCEPT = [
  { name: 'the unmutated applied base the rejections are derived from', definition: 'ResolveResponse', data: RESOLVE_BASE },
  { name: 'the unmutated apply request the request rejections are derived from', definition: 'ResolveRequest', data: RESOLVE_REQUEST_BASE },
  {
    // The `if/then` must NOT fire here. §1.1 makes `requestId` and `origin` required for `apply`
    // only: a dry run has nothing to replay and nothing to confirm.
    name: 'a dry_run request with no requestId and no origin',
    definition: 'ResolveRequest',
    data: { mode: 'dry_run', action: { type: 'set_pool_size', host: 'Cloud API', size: 4 } },
  },
  {
    // §1.1's asymmetry, asserted rather than assumed: unknown keys at the top level are IGNORED,
    // unknown keys inside `action` are REFUSED. Without this case, `additionalProperties: true` on
    // the request root reads as an oversight, and someone tightens it and breaks a caller.
    name: 'an unknown TOP-LEVEL request field — §1.1 ignores these, and only `action` is closed',
    definition: 'ResolveRequest',
    data: { ...RESOLVE_REQUEST_BASE, approvedInTabId: 'tab-7' },
  },
];

/**
 * Resolve responses that must FAIL. Every one is a defect that reached `main`, or a safety property
 * that only exists because the shape forbids the alternative.
 */
const RESOLVE_MUST_REJECT = [
  {
    name: 'confirmation on a preview, as `status: "not_applicable"` — a dry run promising a clearance',
    definition: 'ResolveResponse',
    data: {
      ...RESOLVE_BASE,
      mode: 'dry_run',
      outcome: 'previewed',
      confirmation: { ...RESOLVE_BASE.confirmation, status: 'not_applicable' },
    },
  },
  {
    name: 'confirmation on `no_change` — nothing moved, so there is nothing to observe clearing',
    definition: 'ResolveResponse',
    data: { ...RESOLVE_BASE, outcome: 'no_change' },
  },
  {
    name: 'a dry_run reporting outcome `applied` — the preview wrote',
    definition: 'ResolveResponse',
    data: { ...RESOLVE_BASE, mode: 'dry_run' },
  },
  {
    name: 'audit absent — every response claimed §8 compliance while carrying no attribution (2026-08-19)',
    definition: 'ResolveResponse',
    data: (() => {
      const { audit, ...rest } = RESOLVE_BASE;
      return rest;
    })(),
  },
  {
    name: 'refusal as {code, detail} — the field-name drift caught in review on #92, not by a test',
    definition: 'ResolveResponse',
    data: {
      ...RESOLVE_BASE,
      outcome: 'refused',
      before: null,
      after: null,
      reversal: null,
      confirmation: null,
      refusal: { code: 'out_of_bounds', detail: 'size must be an integer between 2 and 8' },
    },
  },
  {
    name: 'an undocumented top-level field — the whole reason this file has additionalProperties: false',
    definition: 'ResolveResponse',
    data: { ...RESOLVE_BASE, resizedAction: { requested: 2, applied: 4 } },
  },

  // --- requests (§1.1). The first three are the requirement the shipped parser does not enforce
  // (#222): these cases hold the contract while the server is lenient, which is the point of having
  // a request schema at all.
  {
    name: 'an apply with no requestId — §1.1 requires the replay key for apply, and §6 is built on it',
    definition: 'ResolveRequest',
    data: (() => {
      const { requestId, ...rest } = RESOLVE_REQUEST_BASE;
      return rest;
    })(),
  },
  {
    name: 'an apply with no origin — the confirmation would name no finding to watch clear (§7)',
    definition: 'ResolveRequest',
    data: (() => {
      const { origin, ...rest } = RESOLVE_REQUEST_BASE;
      return rest;
    })(),
  },
  {
    name: 'an apply whose origin omits findingId — origin present is not the requirement, the id is',
    definition: 'ResolveRequest',
    data: { ...RESOLVE_REQUEST_BASE, origin: { investigationId: 'inv-8801' } },
  },
  {
    name: 'an unknown key INSIDE action — §1.1 refuses these, and the shipped parser agrees',
    definition: 'ResolveRequest',
    data: { ...RESOLVE_REQUEST_BASE, action: { ...RESOLVE_REQUEST_BASE.action, clamp: true } },
  },
  {
    name: 'no mode — no default exists, because either default is the wrong one to guess',
    definition: 'ResolveRequest',
    data: (() => {
      const { mode, ...rest } = RESOLVE_REQUEST_BASE;
      return rest;
    })(),
  },
  {
    // `previewed` is the OUTCOME and `X-Resolve-Outcome: previewed` is the header, so "preview" is
    // the plausible wrong guess for the mode rather than an arbitrary bad string.
    name: 'mode "preview" — the outcome is `previewed`, the mode is `dry_run`, and they are not the same word',
    definition: 'ResolveRequest',
    data: { ...RESOLVE_REQUEST_BASE, mode: 'preview' },
  },
  {
    name: 'a fractional action.size — §1.1 says integer, and PoolSize 4.5 is not a thing IRIS has',
    definition: 'ResolveRequest',
    data: { ...RESOLVE_REQUEST_BASE, action: { ...RESOLVE_REQUEST_BASE.action, size: 4.5 } },
  },
  {
    name: 'a requestId over §1.1\'s 64 characters — it keys an in-memory replay store (§6)',
    definition: 'ResolveRequest',
    data: { ...RESOLVE_REQUEST_BASE, requestId: 'rq-'.padEnd(66, 'x') },
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

/**
 * The `*-api.md` files whose fenced payloads are checked (#205).
 *
 * `samples/` was the only thing validated here, and the divergences kept living somewhere else: all
 * three §8 payloads in `investigation-api.md` were schema-invalid for twelve days (#201), and five
 * more shipped in `resolve-api.md` (#202). A fenced block in a ratified contract is a published
 * artefact — a consumer mocks against it exactly as they mock against `samples/` — and until now
 * nothing could disagree with it.
 *
 * This is **all five HTTP API contracts**, including `earlywarning-api.md`, which has no schema at
 * all — it is listed precisely so its `0 annotated, 3 unannotated` prints on every run instead of
 * being invisible by omission. `GET /api/earlywarning` is the one MVP 2 endpoint with no
 * machine-readable shape (#219).
 *
 * `mcp-tools.md` is deliberately absent, and not because it lacks a schema — so does earlywarning.
 * It documents MCP tool returns, a different protocol reached through a different boundary, and its
 * thirteen sections of unannotated fences would bury the single conspicuous zero this table exists
 * to show. Its divergences are real and measured (#218 found three in one section); the fix there is
 * a schema for the tool returns, not a line in this array.
 */
const CONTRACT_MD = [
  'healthscan-api.md',
  'proxy-api.md',
  'investigation-api.md',
  'earlywarning-api.md',
  'resolve-api.md',
];

/** Schema filename as written in a fence annotation -> the `$id` ajv knows it by. */
const SCHEMA_IDS_BY_FILE = {
  'healthscan.schema.json': SCHEMA_ID,
  'proxy.schema.json': PROXY_SCHEMA_ID,
  'investigation.schema.json': INVESTIGATION_SCHEMA_ID,
  'resolve.schema.json': RESOLVE_SCHEMA_ID,
};

/**
 * Pull every ```json fence out of a markdown file, annotated or not.
 *
 * The annotation rides in the CommonMark info string, after the language:
 *
 *     ```json validate=resolve.schema.json#/definitions/ResolveResponse
 *
 * GitHub renders the block as `json` regardless, so nothing about how these files read changes.
 *
 * OPT-IN, and the counts below are the price of that. Most fences in these files are deliberately
 * not whole documents — a bare `"reversal": {...}` fragment, a request body for an endpoint whose
 * request has no schema, an `{"error": "..."}` shape — and requiring `validate=none` on each would
 * add noise to five files to catch a mistake in one. The risk is the opposite one: an unannotated
 * fence is invisible, which is the hole this exists to close. So every file reports its annotated
 * and unannotated counts, and a file that drops to `0 annotated` says so on every CI run.
 */
function jsonFences(file) {
  const lines = readFileSync(join(here, file), 'utf8').split(/\r?\n/);
  const fences = [];
  let i = 0;
  while (i < lines.length) {
    const opener = /^```json(?:\s+(.*))?$/.exec(lines[i].trimEnd());
    if (opener === null) {
      i += 1;
      continue;
    }
    const bodyStart = i + 1;
    let j = bodyStart;
    while (j < lines.length && lines[j].trimEnd() !== '```') j += 1;
    fences.push({
      // 1-indexed, and pointing at the opener rather than the body: that is the line a reader
      // clicks, and the line a `file:line` in CI output has to match.
      line: i + 1,
      info: (opener[1] ?? '').trim(),
      body: lines.slice(bodyStart, j).join('\n'),
    });
    i = j + 1;
  }
  return fences;
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(join(here, 'healthscan.schema.json'), 'utf8')));
ajv.addSchema(JSON.parse(readFileSync(join(here, 'proxy.schema.json'), 'utf8')));
ajv.addSchema(JSON.parse(readFileSync(join(here, 'investigation.schema.json'), 'utf8')));
// AFTER investigation.schema.json, which it $refs for `action` rather than transcribing ResolveAction
// a second time. ajv resolves the cross-schema $ref out of this same instance, so the order matters.
ajv.addSchema(JSON.parse(readFileSync(join(here, 'resolve.schema.json'), 'utf8')));

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

const resolveValidatorFor = (definition) => {
  const validate = ajv.getSchema(`${RESOLVE_SCHEMA_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`no such resolve definition: ${definition}`);
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

for (const { file, definition } of RESOLVE_CASES) {
  const validate = resolveValidatorFor(definition);
  const data = JSON.parse(readFileSync(join(here, file), 'utf8'));
  report(validate(data), `${file} validates as ${definition}`);
  if (validate.errors) console.log(JSON.stringify(validate.errors, null, 2));
}

for (const { name, definition, data } of RESOLVE_MUST_ACCEPT) {
  const validate = resolveValidatorFor(definition);
  const ok = validate(data);
  report(ok, `accepts: ${name}`);
  if (!ok) console.log(`      ${ajv.errorsText(validate.errors)}`);
}

for (const { name, definition, data } of RESOLVE_MUST_REJECT) {
  const validate = resolveValidatorFor(definition);
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

// The fenced payloads in the contract prose (#205). Annotated fences are validated; unannotated
// ones are counted and reported, never silently dropped.
let fencesChecked = 0;
const fenceCounts = [];
for (const file of CONTRACT_MD) {
  const fences = jsonFences(file);
  let annotated = 0;
  for (const { line, info, body } of fences) {
    const at = `${file}:${line}`;
    const spec = /(?:^|\s)validate=(\S+)/.exec(info);
    if (spec === null) continue;
    annotated += 1;
    fencesChecked += 1;

    // A malformed annotation FAILS rather than skipping. The whole point is that an unchecked
    // payload must not be able to look checked, and a typo in the definition name is the cheapest
    // way for one to.
    const ref = /^([^#]+)#\/definitions\/(.+)$/.exec(spec[1]);
    if (ref === null) {
      report(false, `${at}: annotation is not <schema.json>#/definitions/<Definition>`);
      continue;
    }
    const [, schemaFile, definition] = ref;
    const schemaId = SCHEMA_IDS_BY_FILE[schemaFile];
    if (schemaId === undefined) {
      report(false, `${at}: no such schema file: ${schemaFile}`);
      continue;
    }
    const validate = ajv.getSchema(`${schemaId}#/definitions/${definition}`);
    if (validate === undefined) {
      report(false, `${at}: no such definition: ${schemaFile}#/definitions/${definition}`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      report(false, `${at}: not parseable JSON — ${err.message}`);
      continue;
    }
    const ok = validate(data);
    report(ok, `${at} validates as ${definition}`);
    if (!ok) console.log(`      ${ajv.errorsText(validate.errors)}`);
  }
  fenceCounts.push({ file, annotated, unannotated: fences.length - annotated });
}
console.log('\njson fences in the contract prose (unannotated are NOT validated):');
for (const { file, annotated, unannotated } of fenceCounts) {
  console.log(`      ${annotated} annotated, ${unannotated} unannotated  ${file}`);
}
console.log('');

const capture = readFileSync(join(here, 'samples/metrics-dump.txt'), 'utf8');
for (const { name, re } of CAPTURE_CLAIMS) {
  report(re.test(capture), `metrics-dump.txt: ${name}`);
}

console.log(
  failures === 0
    ? `\nall checks passed (${CASES.length + INVESTIGATION_CASES.length + RESOLVE_CASES.length} samples, `
      + `${MUST_ACCEPT.length + PROXY_MUST_ACCEPT.length + RESOLVE_MUST_ACCEPT.length} accept, `
      + `${MUST_REJECT.length + PROXY_MUST_REJECT.length + INVESTIGATION_MUST_REJECT.length + RESOLVE_MUST_REJECT.length} reject, `
      + `${CAPTURE_CLAIMS.length} capture claims, ${fencesChecked} prose fences)`
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
