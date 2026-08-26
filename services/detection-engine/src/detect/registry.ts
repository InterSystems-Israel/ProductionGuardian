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
 * **The bar is SYMMETRIC.** A confirmed finding leaves on the same two gates it arrived
 * on, rather than on the first non-breaching poll. Promise 1 is why: an id that survives a
 * poll but not a blip is not stable for the lifetime of the condition, it is stable for the
 * lifetime of an uninterrupted breach — and the condition outlives the interruption. See
 * the long note in `update()` for the flap this produced.
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
  /** Consecutive NON-breaching samples. Clears once this reaches the same bar. */
  consecutiveClears: number;
  /** When the breach was first OBSERVED. Drives the sustainedSeconds gate. */
  firstSeenAt: number;
  /** The most recent breaching poll. Drives the clear-side sustainedSeconds gate. */
  lastBreachAt: number;
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
   * The same two gates, applied to going away. See the header note on symmetry.
   *
   * Note it reads `lastBreachAt`, not `firstSeenAt` — the clock the clear side runs on is
   * "how long since this was last true", which is what a viewer is judging.
   */
  #isCleared(condition: TrackedCondition, now: number): boolean {
    return (
      condition.consecutiveClears >= this.#sustainedSamples &&
      now - condition.lastBreachAt >= this.#sustainedMs
    );
  }

  /**
   * Apply one poll's verdicts for one host.
   *
   * `verdicts` must contain an entry for every rule that breached, and omit those that
   * did not — omission is what clears a condition.
   *
   * `unmeasurable` names the rules whose inputs were absent this poll (`Rule.requires`),
   * whose omission therefore means "cannot tell" rather than "not breaching". Those
   * conditions HOLD: they neither advance toward clearing nor toward confirming. Default
   * empty, so a caller that does not distinguish gets the old reading.
   */
  update(
    host: string,
    verdicts: readonly RuleVerdict[],
    now: number,
    unmeasurable: ReadonlySet<FindingType> = EMPTY_TYPES,
  ): void {
    const breaching = new Set(verdicts.map((v) => v.type));

    for (const verdict of verdicts) {
      const key = conditionKey(host, verdict.type);
      const existing = this.#conditions.get(key);

      if (existing === undefined) {
        const fresh: TrackedCondition = {
          id: `f-${this.#nextId++}`,
          consecutiveBreaches: 1,
          consecutiveClears: 0,
          firstSeenAt: now,
          lastBreachAt: now,
          confirmedAt: undefined,
          verdict,
        };
        // A one-sample, zero-second config confirms immediately; both gates still apply.
        if (this.#isConfirmed(fresh, now)) fresh.confirmedAt = now;
        this.#conditions.set(key, fresh);
        continue;
      }

      existing.consecutiveBreaches += 1;
      existing.lastBreachAt = now;
      // A breach ends any clear streak, so a blip costs the condition nothing. It does NOT
      // reset firstSeenAt or confirmedAt: an already-confirmed condition that blipped is the
      // same condition, and re-serving its confirmation clock would make one absent poll
      // restart the sustained bar and delay the finding all over again.
      existing.consecutiveClears = 0;
      // Refresh values so the finding shows current numbers, but never touch the id.
      existing.verdict = verdict;
      if (existing.confirmedAt === undefined && this.#isConfirmed(existing, now)) {
        existing.confirmedAt = now;
      }
    }

    // ---- What did NOT breach this poll -------------------------------------------------
    //
    // This is deliberately NOT the mirror image of appearing, in one respect and one only:
    // an UNCONFIRMED condition still resets outright, because MVP §6 says *consecutive*
    // samples and that rule governs appearance. A confirmed FINDING is different. It has
    // been published, Dev B's UI has animated it in, and the contract (healthscan-api.md
    // Q4) promises its id is stable for the lifetime of the condition. Retracting it on a
    // single non-breaching poll made appearing cost two samples and disappearing cost one,
    // and that asymmetry is the flap: a queue oscillating around the floor produced a
    // finding, dropped it, and produced it again under a NEW id (`f-1000` -> gone -> the
    // same condition back as `f-1001`), which reads to a viewer as findings appearing and
    // vanishing with no cause. Reproduced against these defaults, not theorised.
    //
    // So clearing gets the same bar as confirming, from the same two knobs — no third
    // tunable, because "how many samples before I believe this changed" is one question
    // asked in both directions. sustainedSamples 1 / sustainedSeconds 0 still clears on the
    // first non-breaching poll, i.e. the old behaviour exactly.
    for (const [key, condition] of [...this.#conditions]) {
      if (!key.startsWith(`${host}${SEP}`)) continue;
      if (breaching.has(condition.verdict.type)) continue;

      // "Cannot tell" is neither a breach nor a clear. Hold, and do not count the poll
      // toward either gate — an instance that stops publishing a metric must not thereby
      // retract a finding about it. See Rule.requires.
      if (unmeasurable.has(condition.verdict.type)) continue;

      if (condition.confirmedAt === undefined) {
        this.#conditions.delete(key);
        continue;
      }

      condition.consecutiveBreaches = 0;
      condition.consecutiveClears += 1;
      // While it holds, the finding keeps serving its last breaching numbers — there is no
      // newer verdict to refresh from. One poll of slightly stale values is the price of
      // not retracting a true finding, and it is bounded by the gates above.
      if (this.#isCleared(condition, now)) this.#conditions.delete(key);
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

/** Shared empty default for `update`'s `unmeasurable`, so it allocates nothing per poll. */
const EMPTY_TYPES: ReadonlySet<FindingType> = new Set();

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
