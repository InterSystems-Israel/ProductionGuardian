/**
 * Fixture-backed proxy client — ADR 0004.
 *
 * The engine must run and serve with Dev A's proxy absent. This is the mechanism, and
 * it is the default in dev: mock-first is the plan, not a fallback.
 *
 * Fixtures hold real captured LABDEMO values. `lastActivityElapsedSeconds` is relative
 * by construction, so a fixture stays truthful however long after capture it is
 * replayed — the same reason Dev C computes fixture timestamps at load time.
 */

import { readFileSync } from 'node:fs';
import type { ProxyClient, ProxyHost, ProxyResponse } from '../types/proxy.ts';
import { isProxyAlert, isProxyHost } from '../types/proxy.ts';

/** A scripted step: which fixture to serve, and for how many polls. */
export interface ScenarioStep {
  fixture: string;
  polls: number;
}

/**
 * Serves fixtures on a loop so the engine visibly comes alive without IRIS.
 *
 * Default progression: healthy for long enough to warm the baseline, then the
 * degraded capture, then back. Sustained-breach needs 2+ consecutive breaching polls,
 * so any degraded step must last at least that long or nothing is ever confirmed.
 */
export class MockProxyClient implements ProxyClient {
  #pollCount = 0;
  readonly #cache = new Map<string, ProxyResponse>();

  readonly #fixtureDir: string;
  readonly #steps: readonly ScenarioStep[];

  constructor(fixtureDir: string, steps: readonly ScenarioStep[] = DEFAULT_SCENARIO) {
    if (steps.length === 0) throw new Error('MockProxyClient needs at least one step');
    this.#fixtureDir = fixtureDir;
    this.#steps = steps;
  }

  /** Not async in substance, but matches ProxyClient so the engine cannot tell. */
  async fetchMetrics(): Promise<ProxyResponse> {
    const fixture = this.#fixtureForPoll(this.#pollCount);
    this.#pollCount += 1;
    return this.#load(fixture);
  }

  /** Restart the progression — the "restartable from the UI" affordance. */
  reset(): void {
    this.#pollCount = 0;
  }

  #fixtureForPoll(poll: number): string {
    const total = this.#steps.reduce((sum, step) => sum + step.polls, 0);
    let offset = poll % total;
    for (const step of this.#steps) {
      if (offset < step.polls) return step.fixture;
      offset -= step.polls;
    }
    // Unreachable while total > 0, but the compiler cannot know that.
    return this.#steps[0]?.fixture ?? 'healthy';
  }

  #load(name: string): ProxyResponse {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached;

    const path = `${this.#fixtureDir}/${name}.json`;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`fixture ${path} is not an object`);
    }
    const body = parsed as Record<string, unknown>;

    // Fixtures carry _comment keys for documentation; drop anything not a valid host.
    const rawHosts = Array.isArray(body['hosts']) ? body['hosts'] : [];
    const hosts: ProxyHost[] = rawHosts.filter(isProxyHost);
    const rawAlerts = Array.isArray(body['alerts']) ? body['alerts'] : [];

    const response: ProxyResponse = {
      sampledAt: typeof body['sampledAt'] === 'string' ? body['sampledAt'] : new Date().toISOString(),
      production: typeof body['production'] === 'string' ? body['production'] : 'LABDEMO.Production',
      hosts,
      alerts: rawAlerts.filter(isProxyAlert),
    };
    this.#cache.set(name, response);
    return response;
  }
}

/**
 * Healthy long enough to warm the baseline (minBaselineSamples defaults to 12), then
 * through each degraded state, then recovery — which is what proves findings actually
 * clear rather than merely appear.
 *
 * Every step lasts at least `sustainedSamples` (2) polls or nothing it depicts is ever
 * confirmed. Recovery between degraded states is deliberate: it clears the registry so
 * the next state's findings are new conditions rather than continuations, and it means
 * an operator watching sees findings resolve, not just accumulate.
 *
 * This sequence reaches **all eight finding types**. Dev C found the earlier version
 * could only produce three (#8), because no fixture carried an alert, none had a
 * *rising* error counter, and none combined an idle host with a queue:
 *
 *   dead_host            cloud-api-dead   (status Disabled)
 *   stalled_host         stalled-host     (idle 384s while 27 queued, status still OK)
 *   queue_buildup        queue-buildup    (depth 486, clears the floor of 50)
 *   elevated_error_rate  error-storm(-2)  (errored 60 -> 210 across two polls)
 *   slow_processing      queue-buildup    (2.4s, over the 1.0s floor)
 *   growing_queue_wait   queue-buildup    (1.84s, over the 1.0s floor)
 *   throughput_drop      cloud-api-dead   (0 against a warm baseline)
 *   system_alert         error-storm-2    (alert naming Cloud API, severity 2 -> info)
 */
export const DEFAULT_SCENARIO: readonly ScenarioStep[] = [
  { fixture: 'healthy', polls: 14 },
  // Queue climbing, slow, waiting — three comparative rules at once.
  { fixture: 'queue-buildup', polls: 5 },
  { fixture: 'healthy', polls: 4 },
  // The error counter must RISE on CONSECUTIVE polls for a rate to exist, and then keep
  // rising for sustainedSamples of them before a finding confirms. A step held for
  // several polls has a flat counter and yields a rate of zero, so the storm alternates
  // between three fixtures with an increasing count rather than repeating one.
  // error-storm-2 and -3 carry the system alert.
  { fixture: 'error-storm', polls: 1 },
  { fixture: 'error-storm-2', polls: 1 },
  { fixture: 'error-storm-3', polls: 1 },
  { fixture: 'error-storm-4', polls: 1 },
  { fixture: 'healthy', polls: 4 },
  // Hung but nominally healthy: the case dead_host cannot catch.
  { fixture: 'stalled-host', polls: 4 },
  { fixture: 'healthy', polls: 4 },
  // The host goes away entirely.
  { fixture: 'cloud-api-dead', polls: 5 },
  { fixture: 'healthy', polls: 5 },
] as const;
