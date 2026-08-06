/**
 * The at-a-glance row from the brochure — four count tiles, minus the score
 * ring, which belongs to the later Health Score module (§1.1 of the area rules).
 *
 * `aria-live="polite"` on the tile group so an operator using a screen reader
 * hears severity changes without polling the page themselves (§7.3).
 */

import type { FindingView, HostView } from '../types/healthscan';
import { countBySeverity } from '../lib/severity';
import { IconCheck, IconCritical, IconInfo, IconWarning, type IconProps } from './icons';

interface TileProps {
  label: string;
  count: number;
  tone: 'critical' | 'warning' | 'info' | 'ok';
  Icon: (props: IconProps) => JSX.Element;
  loading: boolean;
}

function Tile({ label, count, tone, Icon, loading }: TileProps): JSX.Element {
  return (
    <div className={`pg-tile pg-tile--${tone}`}>
      <span className="pg-tile__icon">
        <Icon size={18} />
      </span>
      {loading ? (
        <span className="pg-skeleton pg-skeleton--numeral" aria-hidden="true" />
      ) : (
        <span className="pg-tile__count">{count}</span>
      )}
      <span className="pg-tile__label">{label}</span>
    </div>
  );
}

export interface SeveritySummaryProps {
  findings: readonly FindingView[];
  hosts: readonly HostView[];
  loading: boolean;
}

export function SeveritySummary({
  findings,
  hosts,
  loading,
}: SeveritySummaryProps): JSX.Element {
  const counts = countBySeverity(findings);
  /* Only an exact 'OK' counts as healthy. Of the seven statuses the contract
     enumerates (§4 Q1) that is the only affirmatively-good one, and an
     unrecognized status stays excluded rather than assumed fine. */
  const hostsOk = hosts.filter((host) => host.status === 'OK').length;

  return (
    <section className="pg-summary" aria-label="Severity summary">
      <div className="pg-summary__tiles" aria-live="polite">
        <Tile label="Critical" count={counts.critical} tone="critical" Icon={IconCritical} loading={loading} />
        <Tile label="Warning" count={counts.warning} tone="warning" Icon={IconWarning} loading={loading} />
        <Tile label="Info" count={counts.info} tone="info" Icon={IconInfo} loading={loading} />
        <Tile
          label={hosts.length > 0 ? `Hosts OK (of ${hosts.length})` : 'Hosts OK'}
          count={hostsOk}
          tone="ok"
          Icon={IconCheck}
          loading={loading}
        />
      </div>
    </section>
  );
}
