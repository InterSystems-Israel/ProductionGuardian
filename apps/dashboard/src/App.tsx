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
import { useChat } from './hooks/useChat';
import { useHealthScan } from './hooks/useHealthScan';
import { useHostSeries } from './hooks/useHostSeries';
import { useInvestigation } from './hooks/useInvestigation';
import { useProjections } from './hooks/useProjections';
import { useThresholdSettings } from './hooks/useThresholdSettings';
import { pollIntervalMs, usePolling } from './hooks/usePolling';
import { ActivityChat } from './components/ActivityChat';
import { AppShell, type View } from './components/AppShell';
import { ArchitectureView } from './components/ArchitectureView';
import { BrochureView } from './components/BrochureView';
import { ConnectionBanner, type ConnectionState } from './components/ConnectionBanner';
import { SeveritySummary } from './components/SeveritySummary';
import { HostGrid } from './components/HostGrid';
import { HostDetail } from './components/HostDetail';
import { FindingsList } from './components/FindingsList';
import { FindingDetail } from './components/FindingDetail';
import { InvestigationPanel } from './components/InvestigationPanel';
import { ThresholdSettings } from './components/ThresholdSettings';
import { IconRestart } from './components/icons';
import { formatAge } from './lib/format';
import { readMode, readScenario, writeMode } from './lib/mode';
import { toSeverity, worstSeverity } from './lib/severity';

/** Relative timestamps re-render on this cadence, independent of data polling. */
const CLOCK_TICK_MS = 1000;

/** Data older than this multiple of the poll interval is called stale (§4.4). */
const STALE_AFTER_INTERVALS = 3;

export function App(): JSX.Element {
  const [mode, setMode] = useState<Mode>(() => readMode());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* The selected HOST, which filters the findings list and opens the graphs panel.
     Held here rather than in `HostGrid` because both the grid and the findings list read it, and
     state owned by one of two consumers is state that gets lifted later anyway.

     A NAME, not an index or a Host object. Names are the join key everywhere else in this app
     (`finding.host` is exactly a `host.host` value, contract Q8), and holding the object would pin a
     stale copy of the host's metrics across every poll -- the same reason `selectedId` holds an id and
     `selected` is looked up from the live array below. */
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* Which top-level view is on screen (MVP 3).
     NOT in the URL, unlike `mode`. `mode` is shareable because it changes what the
     data means; which slide a presenter is looking at is transient, and putting it in
     the URL would make the back button walk through the deck. Polling is left running
     across views on purpose -- pausing it would have the dashboard show a stale
     "updated 4m ago" the moment the presenter came back from the brochure. */
  const [view, setView] = useState<View>('dashboard');

  /* The threshold settings drawer. NOT part of `view` -- it opens OVER the dashboard rather than
     replacing it, because an operator changing what fires wants to watch the findings list respond.
     Not in the URL either, for the same reason `view` is not: which panel is open is transient. */
  const [settingsOpen, setSettingsOpen] = useState(false);

  const intervalMs = useMemo(() => pollIntervalMs(), []);

  /* Both clients are created once and kept, so switching modes mid-demo does not
     reset the mock's progression — the presenter can flip to live, find it dead,
     and flip back to exactly where the story was. */
  const mockClient = useMemo<MockClient>(() => createMockClient(readScenario()), []);
  const liveClient = useMemo(() => createLiveClient(), []);
  const api = mode === 'live' ? liveClient : mockClient;

  const {
    hosts,
    findings,
    loading,
    error,
    lastSuccessAt,
    newFindingIds,
    refresh,
    resetSeen,
    hostCountHint,
  } = useHealthScan(api, { cacheLastGood: mode === 'live' });

  const onTick = useCallback(
    (signal: AbortSignal) => refresh(signal),
    [refresh],
  );

  const { failureCount, pollNow } = usePolling({ onTick, intervalMs });

  /* Early Warning rides the SAME tick as the findings poll rather than its own timer: a projection
     shown next to a queue depth from a different moment would be two readings pretending to be one,
     and two independent intervals would drift apart within minutes. Failures are swallowed inside
     the hook -- a missing forecast must never blank a host card that has real metrics on it. */
  const projections = useProjections(api, failureCount);

  /* The selected host's three series, on the SAME tick as everything else -- so the graphs and the
     numbers beside them describe one moment. Requests nothing while `selectedHost` is null, which is
     most of the time. `failureCount` is the poll signal, exactly as for `useProjections`. */
  const hostSeries = useHostSeries(api, selectedHost, failureCount);

  /* The activity conversation, NOT keyed to a finding -- unlike `useInvestigation` below, which
     clears itself when the selection changes because an investigation explains one finding. A chat
     is about the production as a whole, so it survives opening and closing the drawer and is cleared
     only when the operator asks or the mode changes.

     Declared HERE, above `switchMode`, because that callback clears it. Below it, `chat` would be
     used before its `const` initialiser runs -- a TDZ error at runtime rather than a compile
     failure, since the reference sits inside a callback body. */
  const chat = useChat(api);
  const chatClear = chat.clear;

  /* Threshold settings. Gated on the drawer being open, so a closed panel makes no request at all --
     and deliberately NOT on `failureCount` like the two hooks above: a threshold changes only
     because somebody changed it, so there is nothing for a poll to discover. See the hook. */
  const thresholds = useThresholdSettings(api, settingsOpen);

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
      /* And the host panel, for the same reason the drawer closes: the two clients describe different
         worlds, so a panel left open would show one world's history under the other's heading -- and
         a findings list left filtered to a host the new mode may not report would render empty. */
      setSelectedHost(null);
      returnFocusToHost.current = null;
      /* The transcript goes too. Demo mode declines to answer at all, so a live conversation left on
         screen after switching would sit above a composer that now refuses -- and answers about the
         real production must not stay visible while the pill reads Demo. */
      chatClear();
    },
    [chatClear, resetSeen],
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

  /* THE SELECTED HOST, LOOKED UP EVERY POLL, for exactly the reason above: the panel shows the
     host's CURRENT metrics beside its history, so holding the object would freeze them at click
     time. Null when the host leaves the production, which closes the panel by itself. */
  const selectedHostView = useMemo(
    () => hosts.find((host) => host.host === selectedHost) ?? null,
    [hosts, selectedHost],
  );

  /* The findings list is filtered when a host is selected, and is the full list otherwise.
     ONE DERIVATION, so the list and the panel's own count cannot disagree -- filtering in two places
     is how a "3 findings" heading ends up over four rows. */
  const visibleFindings = useMemo(
    () =>
      selectedHost === null ? findings : findings.filter((finding) => finding.host === selectedHost),
    [findings, selectedHost],
  );

  /* Worst severity on the selected host, for the panel's badge. `worstSeverity` over the filtered
     list rather than a second grouping pass: `HostGrid` computes the same thing per card, and two
     independent loops over findings are how a card and a panel come to disagree (#130's severityByHost
     note makes the same argument). */
  const selectedHostWorst = useMemo(
    () =>
      visibleFindings.length === 0 || selectedHost === null
        ? null
        : worstSeverity(visibleFindings.map((finding) => toSeverity(finding.severity))),
    [selectedHost, visibleFindings],
  );

  /* Focus returns to the card that opened the panel, the same contract the finding drawer honours.
     A separate ref from `returnFocusTo` because the two panels are mutually exclusive but their
     return targets are different elements -- sharing one would send focus to a finding row after
     closing a host panel. */
  const returnFocusToHost = useRef<string | null>(null);

  /* Returning focus to the row that opened the drawer is required (§7.3), and it
     is also what makes the drawer keyboard-usable at all: Esc has to land
     somewhere sensible. The row keeps DOM identity across polls thanks to the
     `finding.id` key, so this ref stays valid through a refresh. */
  const returnFocusTo = useRef<string | null>(null);

  /* The MVP 2 request lifecycle, keyed by the selected finding.
     Keyed rather than global so an investigation cannot outlive the finding it explains: the hook
     clears itself when `selectedId` changes, which is what stops a previous finding's root cause
     appearing under a new heading. */
  const detective = useInvestigation(api, selectedId);

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

  /* The same rule for a host that leaves the production: drop the selection rather than leaving the
     panel open over a host nothing reports, and rather than leaving the findings list filtered to a
     name that can no longer match anything -- which would render as an empty list with no explanation.

     Guarded on `loading` for the same reason as above: the transient empty first paint must not count
     as "disappeared", or the panel would close itself on a reload. A failed poll keeps the last-good
     hosts array, so it cannot fire either. */
  useEffect(() => {
    if (!loading && selectedHost !== null && selectedHostView === null) {
      setSelectedHost(null);
      returnFocusToHost.current = null;
    }
  }, [loading, selectedHost, selectedHostView]);

  /* Toggling from the rail, and the rail button is its own focus-return target -- unlike the two
     panels below, which return focus to a card or a row looked up by data attribute. The button is
     a stable element that never unmounts, so the browser keeps focus on it through the open and the
     close and nothing needs restoring. That is why there is no `returnFocusTo` ref here. */
  const toggleSettings = useCallback((): void => {
    setSettingsOpen((current) => {
      /* Opening this closes the other two fixed panels -- all three are `position: fixed` at the
         same edge, so the exclusion is what keeps them from stacking. Same pattern as
         `selectFinding` and `selectHost`, which already clear each other. */
      if (!current) {
        setSelectedId(null);
        returnFocusTo.current = null;
        setSelectedHost(null);
        returnFocusToHost.current = null;
      }
      return !current;
    });
  }, []);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    /* Focus back to the rail control that opened it, matching the contract the other two panels
       honour. Deferred a frame for the same reason as `closeDetail`: the drawer is still mounted
       this tick and focusing before it unmounts loses the ring to its own teardown.

       Selected by an explicit `data-rail-settings` attribute rather than by `[aria-expanded]`,
       which would match any expandable control added later and send focus to whichever came first
       in the document. */
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('[data-rail-settings]')?.focus();
    });
  }, []);

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
    /* CLEARS THE HOST SELECTION. Both panels are `position: fixed` at the same edge, so two open at
       once would sit on top of each other -- and the operator is looking at one thing. Enforced here
       rather than with a z-index, because stacking would leave the hidden panel mounted and polling.

       Note this also restores the UNFILTERED findings list, which is right: opening a finding is a
       deliberate move to a different subject, and a list still filtered to a host the operator has
       navigated away from would hide the rest of them. */
    setSelectedHost(null);
    returnFocusToHost.current = null;
    // And the thresholds drawer, the third panel at the same edge.
    setSettingsOpen(false);
  }, []);

  const closeHostDetail = useCallback((): void => {
    setSelectedHost(null);
    const name = returnFocusToHost.current;
    returnFocusToHost.current = null;
    if (name === null) return;
    // Deferred a frame, like `closeDetail`: the panel is still mounted this tick and focusing before
    // it unmounts loses the focus ring to its own teardown.
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-host="${CSS.escape(name)}"]`)?.focus();
    });
  }, []);

  /* Clicking the open host again closes it -- the "click away restores the full list" half of the
     requirement, and the same toggle `selectFinding` implements for a row. */
  const selectHost = useCallback((name: string): void => {
    setSelectedHost((current) => {
      const next = current === name ? null : name;
      returnFocusToHost.current = next === null ? null : name;
      return next;
    });
    /* And the mirror of the clear above: opening a host closes any finding drawer. This is the state
       the brief names explicitly -- clicking a host while a finding drawer is open -- and the answer
       is that the host wins, because it is the click that was just made. */
    setSelectedId(null);
    returnFocusTo.current = null;
    // And the thresholds drawer, the third panel at the same edge.
    setSettingsOpen(false);
  }, []);

  const isStale =
    lastSuccessAt !== null && now - lastSuccessAt > intervalMs * STALE_AFTER_INTERVALS;

  const connectionState: ConnectionState =
    error !== null ? 'error' : isStale ? 'stale' : 'ok';

  function handleRestartDemo(): void {
    mockClient.restart();
    resetSeen();
    setSelectedId(null);
    // Restart clears the mock's recorded series, so a panel left open would show an empty one.
    setSelectedHost(null);
    returnFocusToHost.current = null;
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

  /* The two MVP 3 views are static documents about the product, not readings from it,
     so the connection banner, the severity row and the drawer are all irrelevant to
     them -- and a "cannot reach the API" banner over a brochure would be actively
     confusing. They return early rather than being wrapped in the dashboard's chrome. */
  if (view !== 'dashboard') {
    return (
      <AppShell
        headerActions={headerActions}
        view={view}
        onNavigate={setView}
        onOpenSettings={toggleSettings}
        settingsOpen={settingsOpen}
      >
        {view === 'brochure' ? <BrochureView /> : <ArchitectureView />}
        {/* Reachable from these views too, unlike the connection banner and the drawer above. The
            rail control is on screen here, so hiding the panel it opens would make it a button that
            does nothing on two of the three views. */}
        <ThresholdSettings
          open={settingsOpen}
          settings={thresholds.settings}
          loading={thresholds.loading}
          saving={thresholds.saving}
          error={thresholds.error}
          demo={mode === 'demo'}
          onApply={thresholds.apply}
          onReset={thresholds.reset}
          onClearError={thresholds.clearError}
          onClose={closeSettings}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      headerActions={headerActions}
      view={view}
      onNavigate={setView}
      onOpenSettings={toggleSettings}
      settingsOpen={settingsOpen}
    >
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
          <HostGrid
            projections={projections}
            hosts={hosts}
            findings={findings}
            now={now}
            loading={loading}
            skeletonCount={hostCountHint}
            onSelectHost={selectHost}
            selectedHost={selectedHost}
          />
        </section>

        <section className="pg-section" aria-labelledby="pg-findings-heading">
          <h2 id="pg-findings-heading" className="pg-section__title">
            Findings
            {/* The count follows the FILTER, so the heading can never describe more rows than are
                below it. `visibleFindings`, not `findings`, for that reason. */}
            {visibleFindings.length > 0 && (
              <span className="pg-section__count">{visibleFindings.length}</span>
            )}
            {/* THE FILTER IS SAID IN WORDS, and it has to be: an operator who has scrolled past the
                grid sees a shorter list with no indication that anything is hidden, and would read
                "1 finding" as the production's total. The button clears it from here as well, so the
                filter is escapable without scrolling back up to the card. */}
            {selectedHost !== null && (
              <span className="pg-section__filter">
                <span>
                  filtered to <strong>{selectedHost}</strong>
                </span>
                <button
                  type="button"
                  className="pg-button pg-button--link"
                  onClick={closeHostDetail}
                >
                  Show all
                </button>
              </span>
            )}
          </h2>
          <FindingsList
            findings={visibleFindings}
            selectedId={selectedId}
            newFindingIds={newFindingIds}
            now={now}
            loading={loading}
            onSelect={selectFinding}
          />
        </section>
      </div>

      {/* OUTSIDE the dimming wrapper, like the drawer. Staleness dims readings that may have moved;
          a conversation is a record of what was asked and answered at the time and does not become
          less true because the metrics poll is behind. Placed last so an operator reads the current
          state of the production before asking about its history. */}
      <ActivityChat
        exchanges={chat.exchanges}
        asking={chat.asking}
        onAsk={chat.ask}
        onClear={chat.clear}
      />

      {/* The host panel, outside the dimming wrapper for the same reason as the drawer below.
          MUTUALLY EXCLUSIVE WITH IT by construction, not by stacking: `selectHost` clears
          `selectedId` and `selectFinding` clears `selectedHost`, so at most one of these two is
          non-null and at most one fixed panel is ever mounted. */}
      <HostDetail
        host={selectedHostView}
        findings={visibleFindings}
        worst={selectedHostWorst}
        series={hostSeries.series}
        seriesLoading={hostSeries.loading}
        now={now}
        onClose={closeHostDetail}
      />

      {/* The thresholds drawer, outside the dimming wrapper like the two panels below: staleness
          dims READINGS that may have moved, and a configuration value is not a reading.

          MUTUALLY EXCLUSIVE WITH BOTH by construction, not by stacking -- `toggleSettings` clears
          the two selections, and opening either of those closes this. All three are
          `position: fixed` at the same edge, so two mounted at once would sit on top of each other
          and the hidden one would keep polling. */}
      <ThresholdSettings
        open={settingsOpen}
        settings={thresholds.settings}
        loading={thresholds.loading}
        saving={thresholds.saving}
        error={thresholds.error}
        demo={mode === 'demo'}
        onApply={thresholds.apply}
        onReset={thresholds.reset}
        onClearError={thresholds.clearError}
        onClose={closeSettings}
      />

      {/* Outside the dimming wrapper: stale data dims the grid, but the drawer the
          operator deliberately opened should stay fully legible. Its numbers carry
          the same "as of" caveat the banner states once. */}
      <FindingDetail
        finding={selected}
        now={now}
        onClose={closeDetail}
        investigation={
          selected === null ? null : (
            <InvestigationPanel
              investigation={detective.investigation}
              investigating={detective.investigating}
              error={detective.error}
              resolve={detective.resolve}
              resolving={detective.resolving}
              resolveError={detective.resolveError}
              onInvestigate={detective.investigate}
              onResolve={detective.applyAction}
            />
          )
        }
      />
    </AppShell>
  );
}
