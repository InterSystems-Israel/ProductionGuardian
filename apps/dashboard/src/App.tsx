/**
 * Layout, client selection, and the refresh orchestration.
 *
 * Phase 1 scope: the mock client only, refreshed on mount and on demand. The
 * live client, the demo/live toggle and interval polling arrive in Phase 2 —
 * the seam they plug into is `api` below, which is already the only thing the
 * rest of the tree knows about.
 */

import { useEffect, useMemo, useState } from 'react';
import { createMockClient } from './api/mockClient';
import { useHealthScan } from './hooks/useHealthScan';
import { AppShell } from './components/AppShell';
import { SeveritySummary } from './components/SeveritySummary';
import { HostGrid } from './components/HostGrid';
import { FindingsList } from './components/FindingsList';
import { IconRestart } from './components/icons';
import { formatAge } from './lib/format';

/** Relative timestamps re-render on this cadence; independent of data polling. */
const CLOCK_TICK_MS = 1000;

function readScenarioParam(): string | undefined {
  const value = new URLSearchParams(window.location.search).get('scenario');
  return value === null || value.length === 0 ? undefined : value;
}

export function App(): JSX.Element {
  // Created once: the mock holds the progression step, so re-creating it would
  // reset the demo story on every render.
  const api = useMemo(() => createMockClient(readScenarioParam()), []);

  const { hosts, findings, loading, lastSuccessAt, newFindingIds, refresh, resetSeen } =
    useHealthScan(api);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One shared clock for every relative timestamp on the page.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const scenario = api.currentScenario();

  function handleRestart(): void {
    api.restart();
    resetSeen();
    setSelectedId(null);
    void refresh();
  }

  const headerActions = (
    <>
      <span className="pg-pill pg-pill--demo">Demo</span>
      <span className="pg-header__meta">
        {api.isPinned()
          ? scenario.label
          : `${scenario.label} · step ${api.step() + 1}/${api.stepCount()}`}
      </span>
      <span className="pg-header__meta pg-header__meta--mono">
        updated {formatAge(lastSuccessAt, now)}
      </span>
      <button type="button" className="pg-button" onClick={() => void refresh()}>
        Advance
      </button>
      <button
        type="button"
        className="pg-button pg-button--icon"
        onClick={handleRestart}
        title="Restart the demo progression"
        aria-label="Restart the demo progression"
      >
        <IconRestart size={15} />
      </button>
    </>
  );

  return (
    <AppShell headerActions={headerActions}>
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
    </AppShell>
  );
}
