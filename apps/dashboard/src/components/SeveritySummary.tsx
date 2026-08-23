/**
 * The at-a-glance row from the brochure — four count tiles, minus the score
 * ring, which belongs to the later Health Score module (§1.1 of the area rules).
 *
 * `aria-live="polite"` on the tile group so an operator using a screen reader
 * hears severity changes without polling the page themselves (§7.3).
 */

import type { FindingView, HostView } from '../types/healthscan';
import { countBySeverity, hostsWithFindings } from '../lib/severity';
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

  /*
   * "HEALTHY" IS A STATUS **AND** NO FINDINGS. Reported as "there are critical errors but there is
   * a nice 3 OK on the UI": with three critical findings all on Cloud API, every host still reported
   * `status: "OK"`, so this tile counted 3 of 3 healthy while the tile beside it counted 3 critical.
   * Two tiles in the same row, contradicting each other, and the reassuring one was bigger.
   *
   * THE PAYLOAD WAS NOT WRONG AND `status` IS NOT WHAT CHANGED. Contract §4 Q1 is explicit that the
   * IRIS enum has **no `Warning`** — a struggling host genuinely reports `OK` and the *finding*
   * carries the alarm. So `OK` + a critical finding is a real, correct state, not drift, and the
   * fix must not invent a `HostStatus` value or rewrite what IRIS said. What was wrong is this
   * component's arithmetic: it asked `status === 'OK'` and *labelled the answer* "Hosts OK", which
   * silently promotes "the host process is running" into "the host is fine". Q1 is exactly the
   * reason those are different claims.
   *
   * So the predicate gains the second half of the question. `status === 'OK'` is kept — of the seven
   * statuses Q1 enumerates it is the only affirmatively-good one, and an unrecognized status stays
   * excluded rather than assumed fine (§2.4) — and a host named by any finding is now excluded too,
   * at any severity. Not critical-only: an `info` finding still means Health Scan has something to
   * say about that host, and "OK" should mean the tile has nothing to say about it. The stricter
   * reading is the safe direction to be wrong in, because the failure mode being fixed is
   * over-reassurance.
   */
  const flagged = hostsWithFindings(findings);
  const hostsOk = hosts.filter(
    (host) => host.status === 'OK' && !flagged.has(host.host),
  ).length;

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
