/**
 * One interoperability host.
 *
 * Metric values are monospaced and right-aligned so they do not jitter as the
 * numbers change across polls (§7.3). A host with active findings takes a
 * severity-colored left border at its *worst* severity.
 */

import type { HostView } from '../types/healthscan';
import type { Severity } from '../types/healthscan';
import { formatCount, formatDuration, formatRate, formatRelative } from '../lib/format';
import { StatusDot } from './StatusDot';

interface MetricRowProps {
  label: string;
  value: string;
  /** Draws attention without inventing a threshold — set by the caller. */
  emphasis?: boolean;
}

function MetricRow({ label, value, emphasis = false }: MetricRowProps): JSX.Element {
  return (
    <div className="pg-metric">
      <span className="pg-metric__label">{label}</span>
      <span className={`pg-metric__value${emphasis ? ' pg-metric__value--emphasis' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * A nullable count is *unknown*, not zero (Q13), so it earns no emphasis — the
 * `—` in the value column already says everything we know. Written out rather
 * than `(count ?? 0) > 0` because the two readings differ and the coalescing
 * form hides which one is meant.
 */
function isPositiveCount(count: number | null): boolean {
  return count !== null && count > 0;
}

export interface HostCardProps {
  host: HostView;
  /** Worst severity among this host's findings; null when it has none. */
  worst: Severity | null;
  findingCount: number;
  /** Injected so every card's relative time re-renders on the same tick. */
  now: number;
}

export function HostCard({ host, worst, findingCount, now }: HostCardProps): JSX.Element {
  const severityClass = worst === null ? '' : ` pg-host--${worst}`;

  return (
    <article className={`pg-host${severityClass}`}>
      <header className="pg-host__header">
        <StatusDot status={host.status} />
        <h3 className="pg-host__name">{host.host}</h3>
        <span className="pg-host__type">{host.type}</span>
      </header>

      <div className="pg-host__metrics">
        <MetricRow
          label="Queued"
          value={formatCount(host.queued)}
          emphasis={isPositiveCount(host.queued)}
        />
        <MetricRow label="Msg/sec" value={formatRate(host.messagesPerSec)} />
        <MetricRow
          label="Errors"
          value={formatCount(host.errored)}
          emphasis={isPositiveCount(host.errored)}
        />
        <MetricRow label="Avg processing" value={formatDuration(host.avgProcessingTime)} />
        <MetricRow label="Avg queueing" value={formatDuration(host.avgQueueingTime)} />
        <MetricRow label="Last activity" value={formatRelative(host.lastActivity, now)} />
      </div>

      {findingCount > 0 && (
        <footer className="pg-host__footer">
          {findingCount === 1 ? '1 active finding' : `${findingCount} active findings`}
        </footer>
      )}
    </article>
  );
}
