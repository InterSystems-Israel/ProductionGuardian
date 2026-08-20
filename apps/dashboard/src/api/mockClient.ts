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
  HostProjectionView,
  InvestigationView,
  ResolveActionView,
  ResolveMode,
  ResolveView,
} from '../types/mvp2';
import { PROGRESSION, resolveScenario, scenarioById, SCENARIOS } from './scenarios';
import type { FindingView, HostView, Scenario } from '../types/healthscan';

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

  /* Mock write state. Module-scoped per client instance so `restart()` does not reset it -- a
     presenter stepping the scenario back should not silently un-apply a fix they demonstrated. */
  let mockPoolSize = 1;
  let mockAuditSeq = 0;

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
      return parseHosts(hosts);
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
        return {
          host: host.host,
          metric: 'queued',
          currentValue: queued,
          measuredAt: at,
          fitSampleCount: 60,
          fitSpanSeconds: 295,
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
        recommendedAction: {
          action: { type: 'set_pool_size', host, size: 4 },
          currentValue: 1,
          bounds: { min: 2, max: 8 },
          reversible: true,
          requiresApproval: true,
          summary: `increase ${host} pool 1 -> 4`,
        },
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

    currentScenario: () => pinned ?? scenarioAt(served),
    step: () => (pinned !== undefined ? 0 : served % PROGRESSION.length),
    stepCount: () => (pinned !== undefined ? 1 : PROGRESSION.length),
    isPinned: () => pinned !== undefined,
    restart: () => {
      cursor = 0;
      served = 0;
      hostsRead = false;
      findingsRead = false;
    },
  };
}
