/** Severity ordering, coercion and counting. Unknown severity is `info` (§2.4). */

import type { FindingView, Severity } from '../types/healthscan';

const KNOWN: readonly Severity[] = ['critical', 'warning', 'info'];

/** Descending by urgency — the order the summary row and findings list use. */
export const SEVERITY_ORDER: readonly Severity[] = KNOWN;

const RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export function toSeverity(value: string): Severity {
  return (KNOWN as readonly string[]).includes(value) ? (value as Severity) : 'info';
}

export function isKnownSeverity(value: string): value is Severity {
  return (KNOWN as readonly string[]).includes(value);
}

/** Positive when `a` is more urgent than `b`; sorts a list critical-first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return RANK[b] - RANK[a];
}

export function worstSeverity(severities: readonly Severity[]): Severity | null {
  return severities.reduce<Severity | null>(
    (worst, current) =>
      worst === null || RANK[current] > RANK[worst] ? current : worst,
    null,
  );
}

/**
 * The names of every host carrying at least one finding.
 *
 * `finding.host` is always exactly a `host.host` value — same string, same case (§4 Q8) — so
 * membership in this set is the entire host↔finding join. Lives here rather than in a component
 * because the summary and the grid both need the same answer, and a second `for` loop over
 * `findings` in a second file is how the two would drift apart.
 *
 * Deliberately *not* the worst severity per host: the summary only asks "is anything wrong here",
 * and `HostGrid.severityByHost` already answers the harder question for the cards.
 */
export function hostsWithFindings(findings: readonly FindingView[]): ReadonlySet<string> {
  const named = new Set<string>();
  for (const finding of findings) named.add(finding.host);
  return named;
}

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(items: readonly { severity: string }[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0 };
  for (const item of items) {
    counts[toSeverity(item.severity)] += 1;
  }
  return counts;
}
