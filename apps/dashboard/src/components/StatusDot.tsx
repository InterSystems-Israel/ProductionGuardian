/**
 * Host status indicator.
 *
 * An unrecognized status renders neutral grey, never as OK (§2.4) — showing an
 * unknown host as healthy is the one failure mode that actively misleads an
 * operator.
 */

import type { HostStatus } from '../types/healthscan';

type Tone = 'ok' | 'warning' | 'critical' | 'neutral';

const TONES: Record<HostStatus, Tone> = {
  OK: 'ok',
  Warning: 'warning',
  Error: 'critical',
  Inactive: 'neutral',
};

/** CONTRACT-Q1: keyed off the assumed enum; unknown values fall through to neutral. */
function toneFor(status: string): Tone {
  return TONES[status as HostStatus] ?? 'neutral';
}

export interface StatusDotProps {
  status: string;
  /** Rendered as visible text next to the dot — color is never the only signal. */
  withLabel?: boolean;
}

export function StatusDot({ status, withLabel = false }: StatusDotProps): JSX.Element {
  const tone = toneFor(status);
  const known = tone !== 'neutral' || status === 'Inactive';

  return (
    <span className="pg-status">
      <span className={`pg-status__dot pg-status__dot--${tone}`} aria-hidden="true" />
      {withLabel ? (
        <span className="pg-status__label">{known ? status : 'Unknown'}</span>
      ) : (
        <span className="pg-visually-hidden">{known ? status : 'Unknown status'}</span>
      )}
    </span>
  );
}
