/**
 * Validate contracts/samples/ against the schemas. This is the `contracts` CI job.
 *
 *   node contracts/validate.mjs
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

/** Each sample is validated against ONE named definition, never "either". */
const CASES = [
  { file: 'samples/hosts-response.json', definition: 'HostsResponse' },
  { file: 'samples/findings-response.json', definition: 'FindingsResponse' },
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
];

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(join(here, 'healthscan.schema.json'), 'utf8')));

const validatorFor = (definition) => {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`no such definition: ${definition}`);
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

for (const { name, definition, data } of MUST_REJECT) {
  const validate = validatorFor(definition);
  report(!validate(data), `rejects: ${name}`);
}

console.log(
  failures === 0
    ? `\nall checks passed (${CASES.length} samples, ${MUST_ACCEPT.length} accept, ${MUST_REJECT.length} reject)`
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
