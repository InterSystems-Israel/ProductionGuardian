/**
 * Validates every demo fixture against Dev B's published schema.
 *
 * `fixtures/README.md` promises fixture shape matches the contract exactly. That
 * promise was previously only checked by the runtime guards, which are
 * deliberately lenient — they coerce and log-and-skip so a bad payload cannot
 * blank the grid mid-demo. Leniency there means a fixture can drift from the
 * contract and still render, so the claim needs a strict check of its own.
 *
 * Fixtures store relative ages, so timestamps are resolved here the same way
 * `src/api/scenarios.ts` does — the fixture as written is not contract-shaped, the
 * fixture as *served* is, and the latter is what Dev B's engine has to match.
 *
 * Skips (exit 0) when the contract is not present, since `contracts/` lands via a
 * separate PR and this must not fail a branch that simply predates it.
 *
 *   node tools/validate-fixtures.mjs
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const SCHEMA = join(HERE, '..', '..', '..', 'contracts', 'healthscan.schema.json');

if (!existsSync(SCHEMA)) {
  console.log(`skipped — no contract at ${SCHEMA}`);
  process.exit(0);
}

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema);

const base = schema.$id ?? '';
const validateHosts = ajv.getSchema(`${base}#/definitions/HostsResponse`);
const validateFindings = ajv.getSchema(`${base}#/definitions/FindingsResponse`);

if (validateHosts === undefined || validateFindings === undefined) {
  console.error('error — schema has no HostsResponse/FindingsResponse definitions');
  process.exit(1);
}

/** Mirrors `toContractIso` in `src/api/scenarios.ts`: seconds, no milliseconds. */
const toContractIso = (epochMs) => `${new Date(epochMs).toISOString().slice(0, 19)}Z`;

const describe = (errors) =>
  (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');

const now = Date.now();
let failed = 0;

for (const file of readdirSync(FIXTURES).filter((f) => f.startsWith('scenario-'))) {
  const scenario = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));

  const hosts = scenario.hosts.map(({ lastActivitySecondsAgo, ...host }) => ({
    ...host,
    lastActivity: toContractIso(now - lastActivitySecondsAgo * 1000),
  }));
  const findings = scenario.findings.map(({ detectedSecondsAgo, ...finding }) => ({
    ...finding,
    detectedAt: toContractIso(now - detectedSecondsAgo * 1000),
  }));

  const problems = [];
  if (!validateHosts(hosts)) problems.push(`hosts: ${describe(validateHosts.errors)}`);
  if (!validateFindings(findings)) {
    problems.push(`findings: ${describe(validateFindings.errors)}`);
  }

  if (problems.length === 0) {
    console.log(`ok    ${file}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${file}`);
    for (const problem of problems) console.error(`        ${problem}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} fixture(s) do not match the contract.`);
  process.exit(1);
}
console.log('\nAll fixtures match the published contract.');
