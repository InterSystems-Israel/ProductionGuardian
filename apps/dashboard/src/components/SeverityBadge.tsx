/**
 * Severity pill: icon + text, never color alone (§7.3).
 *
 * The icon silhouette differs per severity so the badge still reads on a
 * projector that flattens red against amber.
 */

import { toSeverity } from '../lib/severity';
import { IconCritical, IconInfo, IconWarning, type IconProps } from './icons';
import type { Severity } from '../types/healthscan';

const ICONS: Record<Severity, (props: IconProps) => JSX.Element> = {
  critical: IconCritical,
  warning: IconWarning,
  info: IconInfo,
};

const LABELS: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export interface SeverityBadgeProps {
  /** Raw contract value; coerced to `info` when unrecognized. */
  severity: string;
  size?: 'sm' | 'md';
}

export function SeverityBadge({ severity, size = 'sm' }: SeverityBadgeProps): JSX.Element {
  const level = toSeverity(severity);
  const Icon = ICONS[level];

  return (
    <span className={`pg-badge pg-badge--${level} pg-badge--${size}`}>
      <Icon size={size === 'md' ? 15 : 13} />
      <span>{LABELS[level]}</span>
    </span>
  );
}
