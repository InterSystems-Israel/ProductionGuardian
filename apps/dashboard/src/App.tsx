/**
 * Layout, client selection, and polling orchestration.
 *
 * The only place that knows which `HealthScanApi` implementation is running.
 * Everything below receives data through `useHealthScan` and is unaware of the
 * difference between demo and live.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Mode } from './api/HealthScanApi';
import { createLiveClient } from './api/liveClient';
import { createMockClient, type MockClient } from './api/mockClient';
import { useHealthScan } from './hooks/useHealthScan';
import { pollIntervalMs, usePolling } from './hooks/usePolling';
import { AppShell } from './components/AppShell';
import { ConnectionBanner, type ConnectionState } from './components/ConnectionBanner';
import { SeveritySummary } from './components/SeveritySummary';
import { HostGrid } from './components/HostGrid';
import { FindingsList } from './components/FindingsList';
import { IconRestart } from './components/icons';
import { formatAge } from './lib/format';
import { readMode, readScenario, writeMode } from './lib/mode';

/** Relative timestamps re-render on this cadence, independent of data polling. */
const CLOCK_TICK_MS = 1000;

/** Data older than this multiple of the poll interval is called stale (§4.4). */
const STALE_AFTER_INTERVALS = 3;

export function App(): JSX.Element {
  const [mode, setMode] = useState<Mode>(() => readMode());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const intervalMs = useMemo(() => pollIntervalMs(), []);

  /* Both clients are created once and kept, so switching modes mid-demo does not
     reset the mock's progression — the presenter can flip to live, find it dead,
     and flip back to exactly where the story was. */
  const mockClient = useMemo<MockClient>(() => createMockClient(readScenario()), []);
  const liveClient = useMemo(() => createLiveClient(), []);
  const api = mode === 'live' ? liveClient : mockClient;

  const { hosts, findings, loading, error, lastSuccessAt, newFindingIds, refresh, resetSeen } =
    useHealthScan(api, { cacheLastGood: mode === 'live' });

  const onTick = useCallback(
    (signal: AbortSignal) => refresh(signal),
    [refresh],
  );

  const { failureCount, pollNow } = usePolling({ onTick, intervalMs });

  // One shared clock for every relative timestamp on the page.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const switchMode = useCallback(
    (next: Mode): void => {
      setMode(next);
      writeMode(next);
      // The two clients report different worlds; carrying "seen" ids across
      // would make the new mode's findings all look pre-existing.
      resetSeen();
      setSelectedId(null);
    },
    [resetSeen],
  );

  const isStale =
    lastSuccessAt !== null && now - lastSuccessAt > intervalMs * STALE_AFTER_INTERVALS;

  const connectionState: ConnectionState =
    error !== null ? 'error' : isStale ? 'stale' : 'ok';

  function handleRestartDemo(): void {
    mockClient.restart();
    resetSeen();
    setSelectedId(null);
    pollNow();
  }

  const scenario = mockClient.currentScenario();

  const headerActions = (
    <>
      <span className={`pg-pill pg-pill--${mode}`}>{mode === 'live' ? 'Live' : 'Demo'}</span>

      {mode === 'demo' && (
        <span className="pg-header__meta">
          {mockClient.isPinned()
            ? scenario.label
            : `${scenario.label} · step ${mockClient.step() + 1}/${mockClient.stepCount()}`}
        </span>
      )}

      <span className="pg-header__meta pg-header__meta--mono">
        updated {formatAge(lastSuccessAt, now)}
      </span>

      {mode === 'demo' && (
        <button
          type="button"
          className="pg-button pg-button--icon"
          onClick={handleRestartDemo}
          title="Restart the demo progression"
          aria-label="Restart the demo progression"
        >
          <IconRestart size={15} />
        </button>
      )}

      {/* A visible toggle so the presenter never has to edit the URL (§4.2). */}
      <div className="pg-toggle" role="group" aria-label="Data source">
        <button
          type="button"
          className={`pg-toggle__option${mode === 'demo' ? ' pg-toggle__option--active' : ''}`}
          onClick={() => switchMode('demo')}
          aria-pressed={mode === 'demo'}
        >
          Demo
        </button>
        <button
          type="button"
          className={`pg-toggle__option${mode === 'live' ? ' pg-toggle__option--active' : ''}`}
          onClick={() => switchMode('live')}
          aria-pressed={mode === 'live'}
        >
          Live
        </button>
      </div>
    </>
  );

  // Dim the content while showing data known to be out of date, so nobody reads
  // a stale number as current.
  const contentClass = connectionState === 'ok' ? '' : 'pg-stale';

  return (
    <AppShell headerActions={headerActions}>
      <ConnectionBanner
        state={connectionState}
        error={error}
        lastSuccessAt={lastSuccessAt}
        failureCount={failureCount}
        onRetry={pollNow}
        onSwitchToDemo={() => switchMode('demo')}
      />

      <div className={contentClass}>
        <SeveritySummary findings={findings} hosts={hosts} loading={loading} />

        <section className="pg-section" aria-labelledby="pg-hosts-heading">
          <h2 id="pg-hosts-heading" className="pg-section__title">
            Hosts
          </h2>
          <HostGrid hosts={hosts} findings={findings} now={now} loading={loading} />
        </section>

        <section className="pg-section" aria-labelledby="pg-findings-heading">
          <h2 id="pg-findings-heading" className="pg-section__title">
            Findings
            {findings.length > 0 && <span className="pg-section__count">{findings.length}</span>}
          </h2>
          <FindingsList
            findings={findings}
            selectedId={selectedId}
            newFindingIds={newFindingIds}
            now={now}
            loading={loading}
            onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
          />
        </section>
      </div>
    </AppShell>
  );
}
