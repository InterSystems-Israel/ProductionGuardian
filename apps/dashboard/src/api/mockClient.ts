/**
 * Fixture-backed client for demo mode.
 *
 * Two behaviours, chosen by construction:
 *  - **pinned** (`?scenario=dead-host`) — always returns that one fixture, for
 *    screenshots and for the presenter cue sheet.
 *  - **progression** (default) — advances one step per poll pair through
 *    `PROGRESSION` and loops, so the dashboard comes alive unattended.
 *
 * `getHosts` and `getFindings` are polled on the same tick and must agree, so
 * the step only advances once both have been read.
 */

import type { HealthScanApi } from './HealthScanApi';
import { parseFindings, parseHosts } from './guards';
import { PROGRESSION, resolveScenario, scenarioById, SCENARIOS } from './scenarios';
import type { FindingView, HostView, Scenario } from '../types/healthscan';

/** Mirrors the latency of a local backend so loading states are real, not theoretical. */
const SIMULATED_LATENCY_MS = 120;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface MockClient extends HealthScanApi {
  /** Fixture currently being served — drives the demo caption in the header. */
  currentScenario(): Scenario;
  /** Step index within the progression; 0-based. */
  step(): number;
  stepCount(): number;
  /** True when pinned via `?scenario=`, i.e. not advancing. */
  isPinned(): boolean;
  /** Back to the first step. Wired to the header's restart button. */
  restart(): void;
}

export function createMockClient(pinnedScenarioId?: string): MockClient {
  const pinned = pinnedScenarioId === undefined ? undefined : scenarioById(pinnedScenarioId);

  if (pinnedScenarioId !== undefined && pinned === undefined) {
    console.warn(
      `[healthscan] unknown ?scenario=${pinnedScenarioId}; known: ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }

  /* `cursor` is the fixture to serve next; it advances only once both endpoints
     have read it, so a hosts/findings pair always comes from one fixture.
     `served` is the fixture the UI is actually displaying — the two differ the
     moment a pair completes, and the header must report `served`, otherwise the
     caption names the next scenario while showing the previous one's data. */
  let cursor = 0;
  let served = 0;
  let hostsRead = false;
  let findingsRead = false;

  function scenarioAt(index: number): Scenario {
    const id = PROGRESSION[index % PROGRESSION.length];
    // PROGRESSION is a non-empty literal; the fallback satisfies
    // noUncheckedIndexedAccess without pretending the miss is meaningful.
    return (id === undefined ? undefined : scenarioById(id)) ?? SCENARIOS[0]!;
  }

  /** The fixture to hand out on this call. */
  function serving(): Scenario {
    return pinned ?? scenarioAt(cursor);
  }

  function noteRead(which: 'hosts' | 'findings'): void {
    if (pinned !== undefined) return;
    served = cursor;
    if (which === 'hosts') hostsRead = true;
    else findingsRead = true;

    if (hostsRead && findingsRead) {
      cursor += 1;
      hostsRead = false;
      findingsRead = false;
    }
  }

  return {
    async getHosts(signal?: AbortSignal): Promise<HostView[]> {
      await delay(SIMULATED_LATENCY_MS, signal);
      const { hosts } = resolveScenario(serving(), Date.now());
      noteRead('hosts');
      return parseHosts(hosts);
    },

    async getFindings(signal?: AbortSignal): Promise<FindingView[]> {
      await delay(SIMULATED_LATENCY_MS, signal);
      const { findings } = resolveScenario(serving(), Date.now());
      noteRead('findings');
      return parseFindings(findings);
    },

    currentScenario: () => pinned ?? scenarioAt(served),
    step: () => (pinned !== undefined ? 0 : served % PROGRESSION.length),
    stepCount: () => (pinned !== undefined ? 1 : PROGRESSION.length),
    isPinned: () => pinned !== undefined,
    restart: () => {
      cursor = 0;
      served = 0;
      hostsRead = false;
      findingsRead = false;
    },
  };
}
