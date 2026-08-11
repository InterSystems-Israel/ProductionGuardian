/** Severity ordering, coercion and counting. Unknown severity is `info` (§2.4). */

import type { Severity } from '../types/healthscan';

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

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(items: readonly { severity: string }[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0 };
  for (const item of items) {
    counts[toSeverity(item.severity)] += 1;
  }
  return counts;
}
