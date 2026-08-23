/**
 * Fixture loading and timestamp resolution.
 *
 * Fixtures are imported statically rather than fetched so the single-file
 * fallback build inlines them — a `fetch('./fixtures/...')` would fail from
 * file:// and take the demo down with it (§6).
 */

import type {
  Finding,
  Host,
  Scenario,
  ScenarioFinding,
  ScenarioHost,
} from '../types/healthscan';

import baselineWarming from '../../fixtures/scenario-baseline-warming.json';
import deadHost from '../../fixtures/scenario-dead-host.json';
import errorStorm from '../../fixtures/scenario-error-storm.json';
import healthy from '../../fixtures/scenario-healthy.json';
import queueBuildup from '../../fixtures/scenario-queue-buildup.json';
import slowProcessing from '../../fixtures/scenario-slow-processing.json';
import systemAlert from '../../fixtures/scenario-system-alert.json';
import throughputDrop from '../../fixtures/scenario-throughput-drop.json';

/* `resolveJsonModule` infers literal types that are narrower than the contract
   (e.g. `baselineValue: null` for a fixture where every value happens to be
   null). The fixtures are contract-shaped by construction — the guards prove it
   at runtime — so a single widening assertion per import site is the honest
   place to absorb that, rather than loosening the contract types. */
const ALL = [
  healthy,
  queueBuildup,
  deadHost,
  errorStorm,
  slowProcessing,
  throughputDrop,
  systemAlert,
  baselineWarming,
] as unknown as Scenario[];

export const SCENARIOS: readonly Scenario[] = ALL;

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/**
 * The demo progression: healthy → warning → critical → back to healthy.
 *
 * It tells a story rather than cycling all eight fixtures — the dashboard should
 * visibly come alive on stage, then recover, so the loop can run unattended
 * behind a presenter who is talking (§5).
 */
export const PROGRESSION: readonly string[] = [
  'healthy',
  'queue-buildup',
  'slow-processing',
  'error-storm',
  'dead-host',
  'healthy',
];

/**
 * Second-precision ISO 8601, `Z`-suffixed — exactly what
 * `contracts/healthscan.schema.json` permits for `lastActivity` / `detectedAt`.
 *
 * `toISOString()` alone is *not* conforming: it always emits milliseconds
 * (`…52.000Z`) and the contract's pattern forbids the fractional part. Dropping it
 * keeps the mock's bytes valid under both the pattern and a plain `date-time`
 * format check, so demo data cannot be looser than what the live engine may send.
 *
 * EXPORTED because `mockClient` stamps its demo series with it. Duplicating the one-liner there
 * would give the app two definitions of "the contract's timestamp shape", and the whole point of
 * this function is that `toISOString()` is the wrong one — a second copy is a second chance to get
 * that wrong. `apps/dashboard/CLAUDE.md` §2.3 already names this as the function to use.
 */
export function toContractIso(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/** Fixture host → contract host: relative age becomes an ISO timestamp. */
function resolveHost(host: ScenarioHost, now: number): Host {
  const { lastActivitySecondsAgo, ...rest } = host;
  return {
    ...rest,
    lastActivity: toContractIso(now - lastActivitySecondsAgo * 1000),
  };
}

function resolveFinding(finding: ScenarioFinding, now: number): Finding {
  const { detectedSecondsAgo, ...rest } = finding;
  return {
    ...rest,
    detectedAt: toContractIso(now - detectedSecondsAgo * 1000),
  };
}

/**
 * Produces exactly what the live endpoints would return, so the guards do real
 * work over fixture data and a bad transcription shows up in demo mode first.
 */
export function resolveScenario(
  scenario: Scenario,
  now: number,
): { hosts: Host[]; findings: Finding[] } {
  return {
    hosts: scenario.hosts.map((host) => resolveHost(host, now)),
    findings: scenario.findings.map((finding) => resolveFinding(finding, now)),
  };
}
