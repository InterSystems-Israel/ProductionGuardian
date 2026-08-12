/**
 * Finding registry — stable ids and sustained-breach state.
 *
 * This is the mechanism behind two contract promises to Dev C (Q4):
 *
 *   1. `id` is STABLE for the lifetime of a condition, so their highlight animation
 *      and detail drawer survive a poll.
 *   2. Findings DISAPPEAR when the condition clears. No resolvedAt, no tombstones.
 *
 * And behind MVP §6's requirement that a rule breach on 2+ consecutive samples before
 * emitting, so a single-sample spike produces nothing.
 *
 * The sustained bar is TWO gates, samples and wall-clock seconds, both of which must
 * pass. A sample count alone couples false-positive protection to the poll rate, so
 * polling faster to meet the 10s acceptance bar would silently shorten the debounce
 * (#44). Keeping the time gate separate lets the two be tuned independently.
 *
 * State is keyed by (host, type) — one ongoing condition per rule per host.
 */

import type { Finding, FindingType } from '../types/healthscan.ts';
import { SEVERITY_RANK } from '../types/healthscan.ts';
import type { RuleVerdict } from './rules/types.ts';

interface TrackedCondition {
  id: string;
  /** Consecutive breaching samples. Emits once this reaches sustainedSamples. */
  consecutiveBreaches: number;
  /** When the breach was first OBSERVED. Drives the sustainedSeconds gate. */
  firstSeenAt: number;
  /** When the condition was first CONFIRMED (i.e. became a finding), not first seen. */
  confirmedAt: number | undefined;
  /** Latest verdict, refreshed each poll so values stay current. */
  verdict: RuleVerdict;
}

export class FindingRegistry {
  readonly #conditions = new Map<string, TrackedCondition>();
  #nextId = 1000;

  readonly #sustainedSamples: number;
  readonly #sustainedMs: number;

  constructor(sustainedSamples: number, sustainedSeconds = 0) {
    this.#sustainedSamples = sustainedSamples;
    this.#sustainedMs = sustainedSeconds * 1000;
  }

  /**
   * Both gates must pass. `sustainedSamples` guards against a lone bad scrape;
   * `sustainedSeconds` guards against a fast poll rate turning that into a shorter
   * debounce than MVP §6 intends (#44). Either alone is insufficient — samples
   * scale with poll rate, and time alone would confirm on a single sample.
   */
  #isConfirmed(condition: TrackedCondition, now: number): boolean {
    return (
      condition.consecutiveBreaches >= this.#sustainedSamples &&
      now - condition.firstSeenAt >= this.#sustainedMs
    );
  }

  /**
   * Apply one poll's verdicts for one host.
   *
   * `verdicts` must contain an entry for every rule that breached, and omit those that
   * did not — omission is what clears a condition. Rules that returned null are
   * absent, so we reset their counters.
   */
  update(host: string, verdicts: readonly RuleVerdict[], now: number): void {
    const breaching = new Set(verdicts.map((v) => v.type));

    for (const verdict of verdicts) {
      const key = conditionKey(host, verdict.type);
      const existing = this.#conditions.get(key);

      if (existing === undefined) {
        const fresh: TrackedCondition = {
          id: `f-${this.#nextId++}`,
          consecutiveBreaches: 1,
          firstSeenAt: now,
          confirmedAt: undefined,
          verdict,
        };
        // A one-sample, zero-second config confirms immediately; both gates still apply.
        if (this.#isConfirmed(fresh, now)) fresh.confirmedAt = now;
        this.#conditions.set(key, fresh);
        continue;
      }

      existing.consecutiveBreaches += 1;
      // Refresh values so the finding shows current numbers, but never touch the id.
      existing.verdict = verdict;
      if (existing.confirmedAt === undefined && this.#isConfirmed(existing, now)) {
        existing.confirmedAt = now;
      }
    }

    // Anything tracked for this host that did NOT breach this poll is cleared outright.
    // Resetting rather than decaying is deliberate: MVP §6 says *consecutive* samples.
    for (const [key, condition] of [...this.#conditions]) {
      if (!key.startsWith(`${host}${SEP}`)) continue;
      if (breaching.has(condition.verdict.type)) continue;
      this.#conditions.delete(key);
    }
  }

  /** Drop all conditions for a host, e.g. when it leaves the production. */
  forget(host: string): void {
    const prefix = `${host}${SEP}`;
    for (const key of [...this.#conditions.keys()]) {
      if (key.startsWith(prefix)) this.#conditions.delete(key);
    }
  }

  /**
   * Confirmed findings only — conditions that have met the sustained-breach bar.
   * Sorted detectedAt desc with severity as tiebreak, per contract §2.
   */
  findings(): Finding[] {
    const confirmed: Finding[] = [];
    for (const [key, condition] of this.#conditions) {
      if (condition.confirmedAt === undefined) continue;
      confirmed.push({
        id: condition.id,
        host: hostFromKey(key),
        type: condition.verdict.type,
        severity: condition.verdict.severity,
        currentValue: condition.verdict.currentValue,
        baselineValue: condition.verdict.baselineValue,
        detectedAt: new Date(condition.confirmedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        message: condition.verdict.message,
      });
    }
    return confirmed.sort(compareFindings);
  }

  /** Conditions being tracked but not yet confirmed. Diagnostics only. */
  get pendingCount(): number {
    let pending = 0;
    for (const condition of this.#conditions.values()) {
      if (condition.confirmedAt === undefined) pending += 1;
    }
    return pending;
  }
}

const SEP = '\u0000';

function conditionKey(host: string, type: FindingType): string {
  return `${host}${SEP}${type}`;
}

function hostFromKey(key: string): string {
  const [host = ''] = key.split(SEP);
  return host;
}

/** detectedAt desc, then severity (critical first). Matches contract §2. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.detectedAt !== b.detectedAt) return a.detectedAt < b.detectedAt ? 1 : -1;
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}
