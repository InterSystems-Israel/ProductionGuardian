/**
 * Findings, newest first. Sorting happens in `useHealthScan` (CONTRACT-Q5).
 *
 * Rows are keyed by `finding.id` so React keeps identity across polls — that is
 * what lets the detail drawer stay open and the scroll position hold while data
 * refreshes (§7.3).
 */

import { FindingRow } from './FindingRow';
import { EmptyState } from './EmptyState';
import type { FindingView } from '../types/healthscan';

export interface FindingsListProps {
  findings: readonly FindingView[];
  selectedId: string | null;
  newFindingIds: ReadonlySet<string>;
  now: number;
  loading: boolean;
  onSelect: (id: string) => void;
}

function FindingSkeleton(): JSX.Element {
  return (
    <div className="pg-finding pg-finding--skeleton" aria-hidden="true">
      <div className="pg-skeleton pg-skeleton--badge" />
      <div className="pg-finding__body">
        <div className="pg-skeleton pg-skeleton--row pg-skeleton--short" />
        <div className="pg-skeleton pg-skeleton--row" />
      </div>
    </div>
  );
}

export function FindingsList({
  findings,
  selectedId,
  newFindingIds,
  now,
  loading,
  onSelect,
}: FindingsListProps): JSX.Element {
  if (loading && findings.length === 0) {
    return (
      <div className="pg-findings">
        {[0, 1, 2].map((index) => (
          <FindingSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <EmptyState
        title="No findings — production is within baseline"
        detail="Health Scan is polling and comparing against the rolling baseline. Findings appear here as soon as a rule breaches."
      />
    );
  }

  return (
    <div className="pg-findings">
      {findings.map((finding) => (
        <FindingRow
          key={finding.id}
          finding={finding}
          selected={finding.id === selectedId}
          isNew={newFindingIds.has(finding.id)}
          now={now}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
