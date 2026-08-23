/**
 * One interoperability host.
 *
 * Metric values are monospaced and right-aligned so they do not jitter as the
 * numbers change across polls (§7.3). A host with active findings takes a
 * severity-colored left border at its *worst* severity, **and** a severity badge
 * in the header — the border alone signalled severity by colour only, which §7.3
 * forbids and which let a green `OK` dot sit unqualified beside three critical
 * findings.
 */

import type { HostView } from '../types/healthscan';
import type { Severity } from '../types/healthscan';
import { formatCount, formatDuration, formatRate, formatRelative } from '../lib/format';
import { StatusDot } from './StatusDot';
import { SeverityBadge } from './SeverityBadge';
import { EarlyWarning } from './EarlyWarning';
import type { HostProjectionView } from '../types/mvp2';

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
  /**
   * This host's Early Warning projection, or null when there is none.
   *
   * Optional so the card renders unchanged without it -- the MVP 1 grid, and any test that does not
   * care about forecasting, need no new prop.
   */
  projection?: HostProjectionView | null;
}

export function HostCard({
  host,
  worst,
  findingCount,
  now,
  projection = null,
}: HostCardProps): JSX.Element {
  const severityClass = worst === null ? '' : ` pg-host--${worst}`;

  return (
    <article className={`pg-host${severityClass}`}>
      {/* THE BADGE IS HERE BECAUSE THE BORDER IS A COLOUR, and §7.3 forbids severity signalled by
          colour alone. The `pg-host--<severity>` left border already made this card honest before
          the badge existed — verified on the live stack, Cloud API carrying three critical findings
          rendered `pg-host pg-host--critical` — but an operator reading the header saw a green
          status dot and the word "OK" beside it, with the only contradiction being 3px of red at
          the card's edge and a finding count at its foot.

          That is the same over-reassurance the summary tile was fixed for, at card scale, and it is
          NOT fixed by touching `host.status`: contract §4 Q1 has no `Warning`, so `OK` is what IRIS
          said and what must be rendered (§2.4). The badge sits BESIDE the status rather than
          replacing it, so the card states both facts — the host is running, and Health Scan has a
          critical finding on it — which is precisely the state Q1 describes. */}
      <header className="pg-host__header">
        <StatusDot status={host.status} />
        <h3 className="pg-host__name">{host.host}</h3>
        {worst !== null && <SeverityBadge severity={worst} />}
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

      {/* Between the metrics and the finding count: it is derived FROM the metrics above and is
          about what has not happened yet, so it reads after the readings and before the count of
          things already wrong. */}
      <EarlyWarning projection={projection} />

      {findingCount > 0 && (
        <footer className="pg-host__footer">
          {findingCount === 1 ? '1 active finding' : `${findingCount} active findings`}
        </footer>
      )}
    </article>
  );
}
