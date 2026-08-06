/**
 * Designed empty state, not a defaulted blank region (§7.3).
 *
 * `scenario-healthy.json` has zero findings specifically so this path gets
 * exercised — it is the state most likely to be on screen when the demo opens.
 */

import { IconCheck, type IconProps } from './icons';

export interface EmptyStateProps {
  title: string;
  detail?: string;
  Icon?: (props: IconProps) => JSX.Element;
  tone?: 'ok' | 'neutral';
}

export function EmptyState({
  title,
  detail,
  Icon = IconCheck,
  tone = 'ok',
}: EmptyStateProps): JSX.Element {
  return (
    <div className={`pg-empty pg-empty--${tone}`}>
      <span className="pg-empty__mark">
        <Icon size={22} />
      </span>
      <p className="pg-empty__title">{title}</p>
      {detail !== undefined && <p className="pg-empty__detail">{detail}</p>}
    </div>
  );
}
