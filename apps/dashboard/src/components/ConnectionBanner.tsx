/**
 * Live / demo / stale / offline state.
 *
 * Degrade, never blank (§4.2): when the API is unreachable the grid keeps
 * showing the last-good payload and this banner explains why it is dimmed and
 * how old it is. After repeated failures it offers a one-click escape to demo
 * mode, which is the on-stage recovery path.
 */

import { formatClock } from '../lib/format';
import { IconAlert, IconCheck, IconRestart, IconStalled } from './icons';

/** Consecutive failures before demo mode is offered as the way out. */
const OFFER_DEMO_AFTER = 3;

export type ConnectionState = 'ok' | 'stale' | 'error';

export interface ConnectionBannerProps {
  state: ConnectionState;
  /** Message from the most recent failure, rendered as-is. */
  error: string | null;
  /** Epoch ms of the last successful fetch; null if there has never been one. */
  lastSuccessAt: number | null;
  failureCount: number;
  onRetry: () => void;
  onSwitchToDemo: () => void;
}

export function ConnectionBanner({
  state,
  error,
  lastSuccessAt,
  failureCount,
  onRetry,
  onSwitchToDemo,
}: ConnectionBannerProps): JSX.Element | null {
  // Nothing to say while the data is current.
  if (state === 'ok') return null;

  const isError = state === 'error';
  const Icon = isError ? IconAlert : IconStalled;

  return (
    <div className={`pg-banner pg-banner--${state}`} role="status" aria-live="polite">
      <span className="pg-banner__icon">
        <Icon size={17} />
      </span>

      <div className="pg-banner__body">
        <p className="pg-banner__title">
          {isError ? 'Cannot reach the Health Scan API' : 'Data may be out of date'}
        </p>
        <p className="pg-banner__detail">
          {lastSuccessAt === null
            ? 'No successful response yet.'
            : `Showing data as of ${formatClock(lastSuccessAt)} UTC.`}
          {error !== null && ` ${error}.`}
          {failureCount > 1 && ` ${failureCount} consecutive failures.`}
        </p>
      </div>

      <div className="pg-banner__actions">
        <button type="button" className="pg-button" onClick={onRetry}>
          <IconRestart size={14} />
          Retry now
        </button>
        {failureCount >= OFFER_DEMO_AFTER && (
          <button type="button" className="pg-button pg-button--primary" onClick={onSwitchToDemo}>
            <IconCheck size={14} />
            Switch to demo mode
          </button>
        )}
      </div>
    </div>
  );
}
