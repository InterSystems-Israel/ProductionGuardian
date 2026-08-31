/**
 * Fixture-backed client for demo mode.
 *
 * Two behaviours, chosen by construction:
 *  - **pinned** (`?scenario=dead-host`) — always returns that one fixture, for
 *    screenshots and for the presenter cue sheet.
 *  - **progression** (default) — advances one step per poll pair through
 *    `PROGRESSION` and loops, so the dashboard comes alive unattended.
 *
 * `getHosts` and `getFindings` are polled on the same tick and must agree, so
 * the step only advances once both have been read.
 */

import type { HealthScanApi } from './HealthScanApi';
import { parseFindings, parseHosts } from './guards';
import type {
  ChatAnswerView,
  ChatTurnView,
  HostProjectionView,
  ManualRemediationView,
  InvestigationView,
  ResolveActionView,
  ResolveMode,
  ResolveView,
} from '../types/mvp2';
import { PROGRESSION, resolveScenario, scenarioById, SCENARIOS, toContractIso } from './scenarios';
import type { FindingView, HostView, Scenario } from '../types/healthscan';
import type { HostSeriesView } from '../types/hostseries';
import type { ThresholdSettingsView } from '../types/settings';

/** Mirrors the latency of a local backend so loading states are real, not theoretical. */
const SIMULATED_LATENCY_MS = 120;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface MockClient extends HealthScanApi {
  /** Fixture currently being served — drives the demo caption in the header. */
  currentScenario(): Scenario;
  /** Step index within the progression; 0-based. */
  step(): number;
  stepCount(): number;
  /** True when pinned via `?scenario=`, i.e. not advancing. */
  isPinned(): boolean;
  /** Back to the first step. Wired to the header's restart button. */
  restart(): void;
}

export function createMockClient(pinnedScenarioId?: string): MockClient {
  const pinned = pinnedScenarioId === undefined ? undefined : scenarioById(pinnedScenarioId);

  if (pinnedScenarioId !== undefined && pinned === undefined) {
    console.warn(
      `[healthscan] unknown ?scenario=${pinnedScenarioId}; known: ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }

  /* `cursor` is the fixture to serve next; it advances only once both endpoints
     have read it, so a hosts/findings pair always comes from one fixture.
     `served` is the fixture the UI is actually displaying — the two differ the
     moment a pair completes, and the header must report `served`, otherwise the
     caption names the next scenario while showing the previous one's data. */
  let cursor = 0;
  let served = 0;
  let hostsRead = false;
  let findingsRead = false;

  function scenarioAt(index: number): Scenario {
    const id = PROGRESSION[index % PROGRESSION.length];
    // PROGRESSION is a non-empty literal; the fallback satisfies
    // noUncheckedIndexedAccess without pretending the miss is meaningful.
    return (id === undefined ? undefined : scenarioById(id)) ?? SCENARIOS[0]!;
  }

  /** The fixture to hand out on this call. */
  function serving(): Scenario {
    return pinned ?? scenarioAt(cursor);
  }

  /**
   * The canned manual remediation for demo mode's missing-folder finding.
   *
   * The path is a plausible LABDEMO one rather than a real read: in the live path it comes from the
   * host's configured adapter settings, never from a log message (`mcp-tools.md` §3.4a). Written to
   * look like a setting value so the demo does not teach that the agent quotes log text.
   */
  function manualFor(host: string): ManualRemediationView {
    const path = '/tmp/labdemo/hl7-in-missing/';
    return {
      summary: `${host} polls a directory that does not exist`,
      steps: [
        `Create ${path} on the IRIS host, or`,
        `point ${host}'s FilePath setting at an existing directory`,
      ],
      target: { host, setting: 'FilePath', currentValue: path },
      appliedBy: 'operator',
    };
  }

  /* Mock write state. Module-scoped per client instance so `restart()` does not reset it -- a
     presenter stepping the scenario back should not silently un-apply a fix they demonstrated. */
  let mockPoolSize = 1;
  let mockAuditSeq = 0;

  /*
   * Mock threshold settings.
   *
   * THE VALUES AND THE PROSE ARE COPIED FROM THE ENGINE'S OWN DESCRIPTORS, which is a stale-copy
   * risk this file cannot avoid and should therefore name. A mock exists to make the panel's paths
   * -- edit, refuse, reset -- reachable with no engine running (§4), and there is no way to do that
   * without stating a shape. The mitigation is that these are DEMO values behind the demo pill, and
   * that `test/settings.test.ts` pins the live descriptors: if the engine's set changes, live mode
   * follows it immediately and only the demo copy lags.
   *
   * NOT FED INTO DETECTION. Demo mode serves fixtures, so nothing here changes which findings
   * appear -- unlike live mode, where these numbers decide what fires. The panel says which mode it
   * is in for exactly that reason: a knob that visibly does nothing is better than one an audience
   * believes is driving the fixtures.
   */
  const MOCK_SHIPPED: Record<string, number> = {
    'rules.queue_buildup.absoluteFloor': 50,
    'rules.queue_buildup.severityBands.warning': 5,
    'rules.queue_buildup.severityBands.critical': 20,
  };
  let mockSettings: Record<string, number> = { ...MOCK_SHIPPED };

  function settingsView(): ThresholdSettingsView {
    return {
      fields: [
        {
          key: 'rules.queue_buildup.absoluteFloor',
          label: 'Minimum queue depth',
          help:
            'A queue shallower than this never reports, however far above baseline it is.',
          blastRadius:
            'Lowering this widens what fires on the live production — shallow queues that are ' +
            'currently ignored will start reporting.',
          min: 1,
          max: 10_000,
          step: 1,
          shipped: MOCK_SHIPPED['rules.queue_buildup.absoluteFloor'] as number,
        },
        {
          key: 'rules.queue_buildup.severityBands.warning',
          label: 'Warning level (× baseline)',
          help:
            'A queue this many times its baseline reports as a warning. This is also the level ' +
            'at which the rule fires at all — the two are equal by design.',
          blastRadius:
            'This is the firing gate. Lowering it widens what fires on the live production; ' +
            'raising it silences queues that report today.',
          min: 1.1,
          max: 1000,
          step: 0.5,
          shipped: MOCK_SHIPPED['rules.queue_buildup.severityBands.warning'] as number,
        },
        {
          key: 'rules.queue_buildup.severityBands.critical',
          label: 'Critical level (× baseline)',
          help:
            'A queue this many times its baseline reports as critical instead of a warning.',
          blastRadius:
            'Severity only — nothing new starts or stops firing.',
          min: 1.1,
          max: 10_000,
          step: 1,
          shipped: MOCK_SHIPPED['rules.queue_buildup.severityBands.critical'] as number,
        },
      ],
      effective: { ...mockSettings },
      file: { ...MOCK_SHIPPED },
      overridden: Object.keys(MOCK_SHIPPED).some((k) => mockSettings[k] !== MOCK_SHIPPED[k]),
      persistence:
        'Demo mode — these values are not sent anywhere and do not change which findings appear. ' +
        'In Live mode they apply to the running engine and are not written to thresholds.json.',
    };
  }

  /*
   * Demo-mode series history: what this client has ACTUALLY SERVED, per host and metric.
   *
   * NOTHING HERE IS INVENTED, which is the only way a mock may hold a time series at all (§9). A
   * fixture carries one snapshot per scenario and no history, so there were two options: fabricate a
   * plausible past, or record the real one. Fabricating is out — a demo graph showing a slope nobody
   * measured teaches the audience to trust a shape the live product would not draw. So this appends
   * each value as the progression serves it, and the graph fills in over the following polls.
   *
   * THE COST IS STATED RATHER THAN HIDDEN: it starts empty, so the panel opens on "collecting" for
   * the first poll or two and then shows a short series. That is genuinely what demo mode knows, and
   * it has the side effect of exercising the empty and single-point branches on stage rather than
   * meeting them for the first time in front of an audience.
   *
   * `restart()` clears it, unlike `mockPoolSize`: restarting replays the progression from step 1, so
   * keeping the old series would show a history that disagrees with the numbers on the cards.
   */
  const mockSeries = new Map<string, { at: string; value: number }[]>();
  /* Bounded so a demo left running for an hour does not grow without limit. 180 points at the 2s
     poll is six minutes, which is longer than any scenario loop. */
  const MOCK_SERIES_MAX = 180;

  /** Metrics the panel graphs, with the units the engine publishes for them. */
  const MOCK_SERIES_METRICS: readonly { metric: string; unit: string; of: (host: HostView) => number | null }[] = [
    { metric: 'queued', unit: 'count', of: (h) => h.queued },
    { metric: 'avgProcessingTime', unit: 'seconds', of: (h) => h.avgProcessingTime },
    { metric: 'messagesPerSec', unit: 'per_second', of: (h) => h.messagesPerSec },
  ];

  /* ONE KEY BUILDER, because the writer and the reader had drifted apart and nothing caught it:
     `recordSeries` composed the key with a `\u0000` separator while `getHostSeries` used a space, so
     every lookup missed and demo mode served an empty series for every host and metric. Same argument
     the engine's shared helpers make -- a rule held in two places goes stale in one of them.

     THE SEPARATOR IS AN ESCAPE, NOT A LITERAL CONTROL CHARACTER. A raw NUL byte here made git classify
     this file as binary, which suppressed its diff in #140 and #144 -- which is why the mismatch above
     shipped unreviewed. It stays U+0000 rather than a space because no host name or metric can contain
     one, so two different pairs can never compose the same key. */
  const seriesKey = (host: string, metric: string): string => `${host}\u0000${metric}`;

  /**
   * Append this poll's values to the demo history.
   *
   * A NULL IS SKIPPED, NOT RECORDED AS 0 -- the same rule the engine's `#recordIfMeasured` follows,
   * and for the same reason (contract Q13, #49). If it were coerced, demo mode would draw a queue
   * dropping to empty on a host whose queue is not measurable, which is the one thing this feature
   * must never do. Skipping leaves the gap the chart draws as a break.
   */
  function recordSeries(hosts: readonly HostView[], at: string): void {
    for (const host of hosts) {
      for (const { metric, of } of MOCK_SERIES_METRICS) {
        const value = of(host);
        if (value === null || !Number.isFinite(value)) continue;
        const key = seriesKey(host.host, metric);
        const points = mockSeries.get(key) ?? [];
        // Same second as the previous point means two reads inside one tick; replace rather than
        // append, so the graph does not gain a vertical pair at one x position.
        if (points.at(-1)?.at === at) points[points.length - 1] = { at, value };
        else points.push({ at, value });
        if (points.length > MOCK_SERIES_MAX) points.splice(0, points.length - MOCK_SERIES_MAX);
        mockSeries.set(key, points);
      }
    }
  }

  function noteRead(which: 'hosts' | 'findings'): void {
    if (pinned !== undefined) return;
    served = cursor;
    if (which === 'hosts') hostsRead = true;
    else findingsRead = true;

    if (hostsRead && findingsRead) {
      cursor += 1;
      hostsRead = false;
      findingsRead = false;
    }
  }

  return {
    async getHosts(signal?: AbortSignal): Promise<HostView[]> {
      await delay(SIMULATED_LATENCY_MS, signal);
      const { hosts } = resolveScenario(serving(), Date.now());
      noteRead('hosts');
      const parsed = parseHosts(hosts);
      /* Recorded HERE rather than in getHostSeries, so the history is what the cards actually
         displayed. Sampling it when the panel asks would give a series that only exists while the
         panel is open, and would miss every poll the operator spent looking at the grid. */
      recordSeries(parsed, toContractIso(Date.now()));
      return parsed;
    },

    async getFindings(signal?: AbortSignal): Promise<FindingView[]> {
      await delay(SIMULATED_LATENCY_MS, signal);
      const { findings } = resolveScenario(serving(), Date.now());
      noteRead('findings');
      return parseFindings(findings);
    },

    /**
     * Demo-mode projections, derived from the scenario's own queue depths.
     *
     * A RISING QUEUE GETS A PROJECTION; ANYTHING ELSE GETS A REASON. The slope is not invented --
     * it is the current depth over the fit span, which is the same arithmetic the engine does. A
     * fixed slope would show "crosses in 4 minutes" for a host whose queue is empty.
     */
    async getProjections(signal?: AbortSignal): Promise<HostProjectionView[]> {
      await delay(SIMULATED_LATENCY_MS, signal);
      const { hosts } = resolveScenario(serving(), Date.now());
      const at = new Date().toISOString().slice(0, 19) + 'Z';

      return parseHosts(hosts).map((host) => {
        const queued = host.queued;
        const threshold = 50;
        const rising = queued !== null && queued > 0 && queued < threshold;
        /*
         * `recentDirection` (§1.5), from THIS CLIENT'S OWN RECORDED HISTORY rather than invented.
         *
         * An approximation of the engine's computation and openly so: there is no 300 s window here,
         * so the sign comes from the last two recorded `queued` points instead of a least-squares fit
         * over the tail. The engine's value is the authority; this only has to be *consistent* — the
         * demo must show a draining queue as `falling`, which is the whole point of #174.
         *
         * `null` with fewer than two points, matching the engine: one sample has no direction. And
         * `rising` is forced whenever a projection exists, because §1.5 makes that an invariant of the
         * shape rather than a coincidence of the data — a mock that violated it would teach the UI to
         * handle a state the engine cannot produce.
         */
        const points = mockSeries.get(seriesKey(host.host, 'queued')) ?? [];
        const previous = points.at(-2)?.value;
        const latest = points.at(-1)?.value;
        const measuredDirection =
          previous === undefined || latest === undefined
            ? null
            : latest > previous
              ? ('rising' as const)
              : latest < previous
                ? ('falling' as const)
                : ('steady' as const);
        return {
          host: host.host,
          metric: 'queued',
          currentValue: queued,
          measuredAt: at,
          fitSampleCount: 60,
          fitSpanSeconds: 295,
          recentDirection: rising ? ('rising' as const) : measuredDirection,
          threshold: { value: threshold, basis: 'absoluteFloor', baselineValue: 0, findingType: 'queue_buildup' },
          projection: rising
            ? {
                kind: 'projection' as const,
                slope: Number(((queued ?? 0) / 5).toFixed(1)),
                slopeUnit: 'items/minute',
                secondsToThreshold: Math.round(((threshold - (queued ?? 0)) / ((queued ?? 1) / 300)) || 0),
                crossesAt: null,
              }
            : null,
          projectionUnavailable: rising
            ? null
            : queued === null
              ? ('metric_unmeasurable' as const)
              : queued >= threshold
                ? ('already_crossed' as const)
                : ('not_rising' as const),
        };
      });
    },

    /**
     * Demo-mode series: the values this client has already served, and nothing else.
     *
     * `pollIntervalSeconds` is 2 because demo history is recorded on the DASHBOARD's poll, not the
     * engine's 5s one — this is the honest cadence for these points, and reporting the engine's
     * would make the chart see a gap between every pair.
     *
     * `known` is true for any host the current scenario reports, false otherwise, which mirrors the
     * engine's roster check. `polledAt` is non-null once anything has been recorded, so the panel can
     * tell "collecting" from "not measurable here" exactly as it does live.
     */
    async getHostSeries(host: string, signal?: AbortSignal): Promise<HostSeriesView | null> {
      await delay(SIMULATED_LATENCY_MS, signal);
      const { hosts } = resolveScenario(serving(), Date.now());
      const known = parseHosts(hosts).some((h) => h.host === host);
      const series = MOCK_SERIES_METRICS.map(({ metric, unit }) => ({
        metric,
        unit,
        /* A COPY, so a later poll appending to the stored array cannot mutate a series React is
           already rendering. The engine's `recent()` copies for the same reason. */
        points: [...(mockSeries.get(seriesKey(host, metric)) ?? [])],
      }));
      const recorded = series.some((s) => s.points.length > 0);
      return {
        host,
        known,
        polledAt: recorded ? (series.flatMap((s) => s.points).at(-1)?.at ?? null) : null,
        // What demo mode can actually cover, at the poll rate below: MOCK_SERIES_MAX x 2s.
        spanSeconds: MOCK_SERIES_MAX * 2,
        pollIntervalSeconds: 2,
        series,
      };
    },

    /**
     * Demo-mode investigation. `source: "canned"`, and that is the load-bearing field.
     *
     * The narrative is fixed; the NUMBERS are not -- host and queue depth come from the finding
     * being explained, so the panel never shows `Cloud API` while the drawer shows another host.
     * A mock that returned a wholly fixed string would drift the moment the scenario changed.
     *
     * It must never be mistaken for a live agent, so `model` and `toolCalls` are null: those are
     * the two fields the UI uses to say "a real model answered, and it looked things up".
     */
    async investigate(findingId: string, signal?: AbortSignal): Promise<InvestigationView> {
      await delay(SIMULATED_LATENCY_MS * 4, signal);
      const { findings } = resolveScenario(serving(), Date.now());
      const parsed = parseFindings(findings);
      const finding = parsed.find((f) => f.id === findingId) ?? parsed[0];
      const host = finding?.host ?? 'Cloud API';
      const queued = finding?.currentValue ?? null;
      /* `dead_host` is the MVP 3 scenario's finding (§2.3 -- Error is in DEAD_STATUSES, so no new
         rule was needed). Everything else in the demo scenarios is a throughput condition with a
         governed fix. Keyed on the finding type rather than the host name, because the host list is
         Production.cls's to own (#84). */
      const actionable = finding?.type !== 'dead_host';

      return {
        requestId: `inv-mock-${findingId}`,
        findingId,
        state: 'complete',
        source: 'canned',
        investigatedAt: new Date().toISOString().slice(0, 19) + 'Z',
        rootCause:
          `${host} is throughput-bound. It runs at PoolSize 1 against a downstream that takes ` +
          `about a second per message, so it clears roughly 1 message/sec while inbound volume ` +
          `exceeds that. The host itself is healthy — it is outnumbered, not broken.`,
        evidence: [
          { label: 'Configured pool size', detail: `${host} PoolSize = 1`, source: 'mcp_tool', tool: 'get_pool_size' },
          {
            label: 'Queue depth',
            detail: queued === null ? 'queue depth not measurable' : `${queued} message(s) queued`,
            source: 'snapshot',
            tool: null,
          },
          { label: 'Downstream latency', detail: 'average processing time ~1s per message', source: 'mcp_tool', tool: 'get_processing_time' },
        ],
        confidence: 0.9,
        recommendedAction: actionable
          ? {
              action: { type: 'set_pool_size', host, size: 4 },
              currentValue: 1,
              bounds: { min: 2, max: 8 },
              reversible: true,
              requiresApproval: true,
              summary: `increase ${host} pool 1 -> 4`,
            }
          : null,
        /* EXACTLY ONE OF THE TWO, never both. A finding whose fix is a bounded configuration change
           gets a `recommendedAction`; one whose fix is an operator's job gets a `manualRemediation`.
           Demo mode has to be able to show the second, or the state whose acceptance criterion is
           "no approve button" is never exercised before a live run. */
        manualRemediation: actionable ? null : manualFor(host),
        diagnostics: { model: null, toolCalls: null, durationMs: 240, note: 'demo mode: canned investigation' },
      };
    },

    /**
     * Demo-mode resolve, against an in-memory pool size.
     *
     * `audit.source: "mock"` and a `mock-audit-*` handle, so nothing here can be mistaken for a
     * record of a real production change. It tracks state so apply-then-apply gives
     * `applied` then `no_change`, matching the real tool -- a mock that returned `applied` twice
     * would leave the double-click path untested, and a demo will hit it.
     */
    async resolve(
      mode: ResolveMode,
      action: ResolveActionView,
      origin: { findingId: string },
      signal?: AbortSignal,
    ): Promise<ResolveView> {
      await delay(SIMULATED_LATENCY_MS * 2, signal);
      const at = new Date().toISOString().slice(0, 19) + 'Z';
      mockAuditSeq += 1;
      const audit = {
        auditId: `mock-audit-${mockAuditSeq}`,
        actor: 'demo',
        role: 'Guardian_Resolve',
        requestedBy: 'dashboard',
        tool: mode === 'apply' ? 'set_pool_size' : 'get_pool_size',
        recordedAt: at,
        source: 'mock',
      };
      const base = {
        resolveId: `res-mock-${mockAuditSeq}`,
        requestId: null,
        mode,
        action,
        reversal: { host: action.host, size: mockPoolSize, capturedFrom: 'mock' },
        failure: null,
        audit,
        requestedAt: at,
        completedAt: at,
      };

      // Bounds refused with the contract's field names, so the UI's refusal path is exercised in
      // demo mode rather than only against a live production.
      if (action.size < 2 || action.size > 8) {
        return {
          ...base,
          outcome: 'refused',
          before: { poolSize: mockPoolSize },
          after: null,
          reversal: null,
          refusal: {
            reason: 'out_of_bounds',
            message: 'size must be an integer between 2 and 8',
            checkedBy: 'iris',
            bounds: { min: 2, max: 8 },
          },
          confirmation: null,
        };
      }

      if (mockPoolSize === action.size) {
        return {
          ...base,
          outcome: 'no_change',
          before: { poolSize: mockPoolSize },
          after: { poolSize: mockPoolSize },
          refusal: null,
          confirmation: null,
        };
      }

      if (mode === 'dry_run') {
        return {
          ...base,
          outcome: 'previewed',
          before: { poolSize: mockPoolSize },
          after: { poolSize: action.size },
          refusal: null,
          confirmation: null,
        };
      }

      const before = mockPoolSize;
      mockPoolSize = action.size;
      return {
        ...base,
        outcome: 'applied',
        before: { poolSize: before },
        after: { poolSize: mockPoolSize },
        refusal: null,
        confirmation: {
          status: 'pending',
          findingId: origin.findingId,
          observeVia: 'GET /api/healthscan/findings',
          expectedWithinSeconds: 120,
          directEvidence: false,
        },
      };
    },

    /**
     * Demo-mode chat, and it DECLINES rather than answering.
     *
     * EVERY OTHER MOCK IN THIS FILE ANSWERS, so declining here is a deliberate exception and needs
     * its reason stated. `investigate` can be canned honestly because the engine has already measured
     * the numbers the narrative describes -- the facts are live and only the wording is fixed, which
     * is why `source: "canned"` is a sufficient label. A chat answer has no such anchor: the question
     * is arbitrary, so a canned reply would have to invent either the numbers or the question it was
     * answering. Both are the thing this project forbids outright, and a badge cannot make either
     * honest -- `investigation-api.md` §4.3's labelling rule cannot save a mock that has to guess what
     * was asked.
     *
     * So demo mode reports the truthful state: this feature needs the live agent. `state:
     * "unavailable"` with `source: "none"` is the same shape the engine serves when no agent is wired,
     * so the panel's declined branch is exercised in demo mode rather than first met on stage -- which
     * is the point of mock-first even for a feature the mock cannot fake.
     */
    async ask(question: string, _history: ChatTurnView[], signal?: AbortSignal): Promise<ChatAnswerView> {
      await delay(SIMULATED_LATENCY_MS, signal);
      return {
        requestId: `chat-mock-${Date.now()}`,
        state: 'unavailable',
        source: 'none',
        answeredAt: new Date().toISOString().slice(0, 19) + 'Z',
        // Echoed so the panel still pairs the declined answer with the question that was asked.
        question,
        answer: null,
        evidence: [],
        confidence: null,
        diagnostics: {
          model: null,
          toolCalls: null,
          durationMs: SIMULATED_LATENCY_MS,
          note:
            'Demo mode cannot answer questions about activity — the answer would have to be ' +
            'invented. Switch to Live mode, where a governed agent reads the real activity tables.',
        },
      };
    },

    async getThresholdSettings(signal?: AbortSignal): Promise<ThresholdSettingsView | null> {
      await delay(SIMULATED_LATENCY_MS, signal);
      return settingsView();
    },

    /**
     * REFUSES THE SAME VALUES THE ENGINE DOES, with the engine's own wording, so the panel's error
     * path is exercised in demo mode rather than first met against a live production. The bounds
     * mirror `validateConfig`: every numeric threshold must be positive and finite, and the two
     * bands must be positive.
     *
     * The message shape matters as much as the refusal — `bad request: rules.<rule>.<field> must
     * be a positive finite number` is what the engine sends, and the panel renders it verbatim.
     */
    async applyThresholdSettings(
      values: Record<string, number>,
      signal?: AbortSignal,
    ): Promise<ThresholdSettingsView> {
      await delay(SIMULATED_LATENCY_MS, signal);
      for (const [key, value] of Object.entries(values)) {
        if (!(key in MOCK_SHIPPED)) {
          throw new Error(
            `bad request: unknown setting "${key}" — editable settings are ` +
              `${Object.keys(MOCK_SHIPPED).join(', ')}`,
          );
        }
        if (!Number.isFinite(value) || value <= 0) {
          const field = key.includes('severityBands')
            ? `${key} must be positive`
            : `${key} must be a positive finite number, got ${JSON.stringify(value)}`;
          throw new Error(`bad request: ${field}`);
        }
      }
      mockSettings = { ...mockSettings, ...values };
      return settingsView();
    },

    async resetThresholdSettings(signal?: AbortSignal): Promise<ThresholdSettingsView> {
      await delay(SIMULATED_LATENCY_MS, signal);
      mockSettings = { ...MOCK_SHIPPED };
      return settingsView();
    },

    currentScenario: () => pinned ?? scenarioAt(served),
    step: () => (pinned !== undefined ? 0 : served % PROGRESSION.length),
    stepCount: () => (pinned !== undefined ? 1 : PROGRESSION.length),
    isPinned: () => pinned !== undefined,
    restart: () => {
      cursor = 0;
      served = 0;
      hostsRead = false;
      findingsRead = false;
      /* CLEARED, unlike `mockPoolSize` above. Restart replays the progression from step 1, so the
         retained series would be a history that disagrees with the numbers back on the cards. */
      mockSeries.clear();
    },
  };
}
