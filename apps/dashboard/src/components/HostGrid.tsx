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
import { IconProductions } from './icons';

export interface HostGridProps {
  hosts: readonly HostView[];
  findings: readonly FindingView[];
  now: number;
  loading: boolean;
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

export function HostGrid({ hosts, findings, now, loading }: HostGridProps): JSX.Element {
  // Skeletons, not spinners (§7.3) — three, matching the LABDEMO host count, so
  // the layout does not jump when real data lands.
  if (loading && hosts.length === 0) {
    return (
      <div className="pg-grid">
        {[0, 1, 2].map((index) => (
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

  return (
    <div className="pg-grid">
      {hosts.map((host) => {
        const summary = bySeverity.get(host.host);
        return (
          <HostCard
            key={host.host}
            host={host}
            worst={summary?.worst ?? null}
            findingCount={summary?.count ?? 0}
            now={now}
          />
        );
      })}
    </div>
  );
}
