/**
 * Host status indicator.
 *
 * An unrecognized status renders neutral grey, never as OK (§2.4) — showing an
 * unknown host as healthy is the one failure mode that actively misleads an
 * operator.
 */

import type { HostStatus } from '../types/healthscan';

type Tone = 'ok' | 'warning' | 'critical' | 'neutral';

/*
 * The full IRIS enum (contract §4 Q1). Only `OK` earns the healthy tone and only
 * `Error` earns critical: the dot reports *status*, while severity comes from the
 * findings joined to the host in `HostGrid`. The four statuses `dead_host` fires
 * on (Error, Inactive, Stopped, Disabled) therefore do not all read critical here
 * — a deliberately stopped host is not the same claim as a failing one, and the
 * finding beside it carries the alarm.
 */
const TONES: Record<HostStatus, Tone> = {
  OK: 'ok',
  Error: 'critical',
  Retry: 'warning', // retrying: degraded but still working
  Inactive: 'neutral',
  Stopped: 'neutral',
  Unconfigured: 'neutral',
  Disabled: 'neutral',
};

function toneFor(status: string): Tone {
  return TONES[status as HostStatus] ?? 'neutral';
}

/** A status the contract enumerates, so it is safe to show the raw IRIS word. */
function isKnown(status: string): status is HostStatus {
  return Object.prototype.hasOwnProperty.call(TONES, status);
}

export interface StatusDotProps {
  status: string;
  /** Rendered as visible text next to the dot — color is never the only signal. */
  withLabel?: boolean;
}

export function StatusDot({ status, withLabel = false }: StatusDotProps): JSX.Element {
  const tone = toneFor(status);
  // Four statuses now render neutral, so "is it neutral" no longer answers "do we
  // recognize it" — the membership check does.
  const known = isKnown(status);

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
