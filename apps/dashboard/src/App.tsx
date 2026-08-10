/**
 * Layout, client selection, and polling orchestration.
 *
 * The only place that knows which `HealthScanApi` implementation is running.
 * Everything below receives data through `useHealthScan` and is unaware of the
 * difference between demo and live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { FindingDetail } from './components/FindingDetail';
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

  /* Looked up from the live array rather than held in state, so the open drawer
     shows the *current* values of its finding as polls land — a queue that keeps
     climbing updates in place. Because ids are stable while a condition persists
     (contract §4 Q4), the lookup survives every poll that the condition does.
     When the condition clears the finding disappears and this goes null, which
     closes the drawer on its own: no tombstone, no stale numbers left on screen. */
  const selected = useMemo(
    () => findings.find((finding) => finding.id === selectedId) ?? null,
    [findings, selectedId],
  );

  /* Returning focus to the row that opened the drawer is required (§7.3), and it
     is also what makes the drawer keyboard-usable at all: Esc has to land
     somewhere sensible. The row keeps DOM identity across polls thanks to the
     `finding.id` key, so this ref stays valid through a refresh. */
  const returnFocusTo = useRef<string | null>(null);

  /* Drop the selection once its finding is gone, rather than leaving `selectedId`
     pointing at nothing. Without this the drawer would *reopen by itself* if the
     same condition recurred later under the same id — Dev B's registry is keyed
     by (host, type), so a recurrence reusing an id is plausible. A drawer opening
     with no click is a ghost on stage.

     Guarded on `loading` so the transient empty first paint does not count as
     "disappeared". A failed poll keeps the last-good array, so it cannot fire. */
  useEffect(() => {
    if (!loading && selectedId !== null && selected === null) {
      setSelectedId(null);
      returnFocusTo.current = null;
    }
  }, [loading, selected, selectedId]);

  const closeDetail = useCallback((): void => {
    setSelectedId(null);
    const id = returnFocusTo.current;
    returnFocusTo.current = null;
    if (id === null) return;
    // Deferred a frame: the drawer is still mounted this tick, and focusing
    // before it unmounts loses the focus ring to the drawer's own teardown.
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-finding-id="${CSS.escape(id)}"]`)?.focus();
    });
  }, []);

  const selectFinding = useCallback((id: string): void => {
    setSelectedId((current) => {
      const next = current === id ? null : id;
      returnFocusTo.current = next === null ? null : id;
      return next;
    });
  }, []);

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
            onSelect={selectFinding}
          />
        </section>
      </div>

      {/* Outside the dimming wrapper: stale data dims the grid, but the drawer the
          operator deliberately opened should stay fully legible. Its numbers carry
          the same "as of" caveat the banner states once. */}
      <FindingDetail finding={selected} now={now} onClose={closeDetail} />
    </AppShell>
  );
}
