/**
 * Per-host status grid — `repeat(auto-fill, minmax(260px, 1fr))` (§7.2).
 *
 * Findings are joined to hosts here rather than in the hook so the grid stays a
 * pure function of (hosts, findings).
 */

import type { FindingView, HostView, Severity } from '../types/healthscan';
import { toSeverity, worstSeverity } from '../lib/severity';
import { EmptyState } from './EmptyState';
import { HostCard } from './HostCard';
import type { HostProjectionView } from '../types/mvp2';
import { IconProductions } from './icons';

export interface HostGridProps {
  /**
   * Early Warning projections, keyed by host inside the grid rather than by the caller.
   *
   * Optional and defaulted to empty: the grid renders exactly as it did in MVP 1 without them, so a
   * deployment whose engine predates /api/earlywarning loses nothing.
   */
  projections?: readonly HostProjectionView[];

  hosts: readonly HostView[];
  findings: readonly FindingView[];
  now: number;
  loading: boolean;
  /**
   * How many loading skeletons to draw — the host count this browser last saw.
   * `null` on a first-ever visit, when nothing legitimately knows the answer.
   */
  skeletonCount?: number | null;
}

/*
 * Used only until the first response of a browser's first-ever session, after which
 * the observed count takes over.
 *
 * Deliberately not "the LABDEMO host count": this file used to hardcode 4, then 3
 * when a component was removed from the production, which is a UI component
 * tracking someone else's config (issue #25). Any value here is a guess, so it is
 * named as one and it self-corrects after one poll.
 */
const FIRST_VISIT_SKELETONS = 3;

/* A production with 200 hosts should not paint 200 placeholder cards. Two rows'
   worth is enough to show the shape of what is coming. */
const MAX_SKELETONS = 12;

/*
 * Pipeline position of a host type, for grid ordering.
 *
 * `type` is an OPEN STRING in the contract (§2.3: "treat as open string"), so an unrecognised value
 * must sort somewhere defined rather than throw or vanish. Unknown types go last, after the three we
 * know, and then alphabetically among themselves — visible rather than hidden, which is §2.4's
 * defensive-rendering rule.
 *
 * `actor` is included because IRIS reports business processes that way (contract Q10 — the engine
 * normalises it to `process`, but this must not depend on that normalisation continuing).
 */
const HOST_TYPE_ORDER: Record<string, number> = {
  service: 0,
  process: 1,
  actor: 1,
  operation: 2,
};

function hostTypeRank(type: string): number {
  return HOST_TYPE_ORDER[type] ?? 99;
}

/** `finding.host` is always exactly a `host.host` value — same string, same case (§4 Q8). */
function severityByHost(
  findings: readonly FindingView[],
): Map<string, { worst: Severity | null; count: number }> {
  const grouped = new Map<string, Severity[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.host);
    const severity = toSeverity(finding.severity);
    if (existing === undefined) grouped.set(finding.host, [severity]);
    else existing.push(severity);
  }

  const result = new Map<string, { worst: Severity | null; count: number }>();
  for (const [host, severities] of grouped) {
    result.set(host, { worst: worstSeverity(severities), count: severities.length });
  }
  return result;
}

function HostSkeleton(): JSX.Element {
  return (
    <div className="pg-host pg-host--skeleton" aria-hidden="true">
      <div className="pg-skeleton pg-skeleton--title" />
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="pg-skeleton pg-skeleton--row" />
      ))}
    </div>
  );
}

export function HostGrid({
  hosts,
  findings,
  now,
  loading,
  skeletonCount = null,
  projections = [],
}: HostGridProps): JSX.Element {
  // Skeletons, not spinners (§7.3), as many as this production last reported, so the
  // layout does not jump when real data lands — whatever production that is.
  if (loading && hosts.length === 0) {
    const count = Math.min(skeletonCount ?? FIRST_VISIT_SKELETONS, MAX_SKELETONS);
    return (
      <div className="pg-grid">
        {Array.from({ length: count }, (_, index) => (
          <HostSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (hosts.length === 0) {
    return (
      <EmptyState
        title="No hosts reported"
        detail="The Health Scan API returned an empty host list. Check that the production is running and interop metrics are enabled."
        Icon={IconProductions}
        tone="neutral"
      />
    );
  }

  const bySeverity = severityByHost(findings);
  /* Built once per render rather than a find() per card: three hosts today, but the grid is the one
     component that scales with the production's size. */
  const byHost = new Map(projections.map((p) => [p.host, p]));

  /* PIPELINE ORDER, not alphabetical: service -> process -> operation is the direction a message
     actually travels, so the grid reads left-to-right as the flow an operator is diagnosing.
     Alphabetical put the operation first and the service last, i.e. backwards.

     SORTED HERE RATHER THAN IN THE ENGINE, because `contracts/healthscan-api.md` §2 ratifies
     "stable alphabetical order by `host`" and Q5 explicitly blesses a client sort on top. Changing
     the server order would be a contract change for something that is purely presentational — and
     §2.4's rule holds either way: the engine's order is stable, so this sort is deterministic.

     A copy of the array, not an in-place sort: `hosts` is a `readonly` prop and mutating it would
     reorder the caller's state. */
  const ordered = [...hosts].sort(
    (a, b) => hostTypeRank(a.type) - hostTypeRank(b.type) || a.host.localeCompare(b.host),
  );

  return (
    <div className="pg-grid">
      {ordered.map((host) => {
        const summary = bySeverity.get(host.host);
        return (
          <HostCard
            key={host.host}
            host={host}
            worst={summary?.worst ?? null}
            findingCount={summary?.count ?? 0}
            now={now}
            projection={byHost.get(host.host) ?? null}
          />
        );
      })}
    </div>
  );
}
