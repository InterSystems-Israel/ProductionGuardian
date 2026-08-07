/**
 * One finding. The whole row is the click target (§7.2), so it is a real
 * `<button>` — keyboard reachable and focusable for free (§7.3).
 *
 * `message` is Dev B's string, rendered as-is. The UI never reconstructs its own
 * sentence from currentValue/baselineValue: it would eventually disagree with
 * the engine, and the engine is right (§2.4).
 */

import { formatRelative } from '../lib/format';
import { findingMeta } from '../lib/findingMeta';
import { SeverityBadge } from './SeverityBadge';
import type { FindingView } from '../types/healthscan';

export interface FindingRowProps {
  finding: FindingView;
  selected: boolean;
  /** First seen on the latest poll — gets one soft pulse. */
  isNew: boolean;
  now: number;
  onSelect: (id: string) => void;
}

export function FindingRow({
  finding,
  selected,
  isNew,
  now,
  onSelect,
}: FindingRowProps): JSX.Element {
  const meta = findingMeta(finding.type);

  const classes = [
    'pg-finding',
    selected ? 'pg-finding--selected' : '',
    isNew ? 'pg-finding--new' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(finding.id)}
      aria-expanded={selected}
      /* How `App` finds this row again to return focus when the drawer closes
         (§7.3). An id rather than a ref per row: the row that opened the drawer
         may have re-rendered, or moved, on any poll since. */
      data-finding-id={finding.id}
    >
      <span className="pg-finding__severity">
        <SeverityBadge severity={finding.severity} />
      </span>

      <span className="pg-finding__body">
        <span className="pg-finding__head">
          <span className="pg-finding__type">
            <meta.Icon size={14} />
            {meta.label}
          </span>
          <span className="pg-finding__host">{finding.host}</span>
        </span>
        <span className="pg-finding__message">{finding.message}</span>
      </span>

      <span className="pg-finding__time">{formatRelative(finding.detectedAt, now)}</span>
    </button>
  );
}
