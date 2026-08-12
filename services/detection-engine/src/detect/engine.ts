/**
 * The detection engine: turns proxy polls into hosts + findings.
 *
 * Responsibilities, in order:
 *   1. Normalize the proxy's host shape into the published contract shape
 *   2. Feed the rolling baseline
 *   3. Run the rules, and hand verdicts to the registry
 *   4. Expose current hosts and confirmed findings
 */

import { BaselineStore } from '../baseline/window.ts';
import type { ThresholdConfig } from '../config/thresholds.ts';
import { configFor, inertOverrideHosts } from '../config/thresholds.ts';
import type {
  Finding,
  HealthScanState,
  Host,
  HostStatus,
  Severity,
} from '../types/healthscan.ts';
import type { ProxyAlert, ProxyHost, ProxyResponse } from '../types/proxy.ts';
import { isFrameworkHost } from '../types/proxy.ts';
import { FindingRegistry } from './registry.ts';
import { HOST_RULES } from './rules/index.ts';
import type { RuleVerdict } from './rules/types.ts';

/** Metrics that must be warm before a host counts as fully baselined. */
const BASELINED_METRICS = [
  'queued',
  'messagesPerSec',
  'errorsPerMinute',
  'avgProcessingTime',
  'avgQueueingTime',
] as const;

export interface EngineSnapshot {
  hosts: Host[];
  findings: Finding[];
  state: HealthScanState;
  /** When the engine last successfully applied a poll. null before the first. */
  lastPollAt: number | null;
}

export class DetectionEngine {
  #baselines: BaselineStore;
  #registry: FindingRegistry;
  #hosts = new Map<string, Host>();
  /** Cumulative errored counts from the previous poll, for the per-minute rate. */
  #priorErrored = new Map<string, { errored: number; at: number }>();
  /** Alert timestamps already reported, so system_alert only fires on new ones. */
  #seenAlerts = new Set<string>();
  #lastPollAt: number | null = null;
  #stale = false;
  /** Inert-override warnings already emitted, so the log is not repeated per poll. */
  #warnedOverrides = new Set<string>();
  readonly #log: (msg: string) => void;

  #config: ThresholdConfig;

  constructor(config: ThresholdConfig, log: (msg: string) => void = console.error) {
    this.#log = log;
    this.#config = config;
    this.#baselines = new BaselineStore(config.baselineWindowSeconds, config.minBaselineSamples);
    this.#registry = new FindingRegistry(config.sustainedSamples);
  }

  /**
   * Replace the active config. Rebuilds baseline and registry state only when the
   * structural parameters change, so a threshold tweak does not wipe warm baselines
   * mid-demo — which is the whole point of hot-reload (ADR 0003).
   */
  reconfigure(next: ThresholdConfig): void {
    const structural =
      next.baselineWindowSeconds !== this.#config.baselineWindowSeconds ||
      next.minBaselineSamples !== this.#config.minBaselineSamples ||
      next.sustainedSamples !== this.#config.sustainedSamples;

    this.#config = next;
    this.#warnedOverrides.clear();
    if (structural) {
      this.#baselines = new BaselineStore(next.baselineWindowSeconds, next.minBaselineSamples);
      this.#registry = new FindingRegistry(next.sustainedSamples);
      this.#priorErrored.clear();
    }
  }

  /** Mark the last poll as failed. Serves last-known data labelled stale. */
  markPollFailed(): void {
    this.#stale = true;
  }

  /** Apply one proxy poll. `now` is epoch ms, passed in to keep this testable. */
  applyPoll(response: ProxyResponse, now: number): void {
    const seenHosts = new Set<string>();

    for (const proxyHost of response.hosts) {
      if (isFrameworkHost(proxyHost.host)) continue;

      const host = normalizeHost(proxyHost, now);
      seenHosts.add(host.host);
      this.#hosts.set(host.host, host);

      const errorsPerMinute = this.#errorsPerMinute(proxyHost, now);

      this.#baselines.record(host.host, 'queued', host.queued, now);
      this.#baselines.record(host.host, 'messagesPerSec', host.messagesPerSec, now);
      this.#baselines.record(host.host, 'avgProcessingTime', host.avgProcessingTime, now);
      this.#baselines.record(host.host, 'avgQueueingTime', host.avgQueueingTime, now);
      if (errorsPerMinute !== null) {
        this.#baselines.record(host.host, 'errorsPerMinute', errorsPerMinute, now);
      }

      const verdicts: RuleVerdict[] = [];
      for (const rule of HOST_RULES) {
        const verdict = rule.evaluate({
          host,
          errorsPerMinute,
          // Raw nullable values, so a rule can tell "measured zero" from "unknown".
          // normalizeHost() collapses these for the wire; rules must not see that.
          raw: {
            queued: proxyHost.queued,
            messagesPerSec: proxyHost.messagesPerSec,
            errored: proxyHost.errored,
            avgProcessingTime: proxyHost.avgProcessingTime,
            avgQueueingTime: proxyHost.avgQueueingTime,
          },
          baselines: this.#baselines,
          config: this.#config,
          now,
        });
        if (verdict !== null) verdicts.push(verdict);
      }

      const alertVerdict = this.#evaluateAlerts(host.host, response.alerts, now);
      if (alertVerdict !== null) verdicts.push(alertVerdict);

      this.#registry.update(host.host, verdicts, now);
    }

    // A host that left the production should not linger with stale findings.
    for (const known of [...this.#hosts.keys()]) {
      if (seenHosts.has(known)) continue;
      this.#hosts.delete(known);
      this.#registry.forget(known);
      this.#baselines.forget(known);
      this.#priorErrored.delete(known);
    }

    this.#warnInertOverrides(seenHosts);

    this.#lastPollAt = now;
    this.#stale = false;
  }

  snapshot(): EngineSnapshot {
    const hosts = [...this.#hosts.values()].sort((a, b) => a.host.localeCompare(b.host));
    return {
      hosts,
      findings: this.#registry.findings(),
      state: this.#state(hosts),
      lastPollAt: this.#lastPollAt,
    };
  }

  /**
   * Warn once per (config, host-set) when a hostOverrides key matches nothing we have
   * seen. The override is simply inert -- the tuning stops applying and nothing says so
   * -- which is exactly the silent-weakening failure #25 raised.
   *
   * Not an error: a host can be legitimately absent from a running production, and
   * refusing to start would be worse than reporting it.
   */
  #warnInertOverrides(seenHosts: ReadonlySet<string>): void {
    for (const host of inertOverrideHosts(this.#config, seenHosts)) {
      const key = `${host}|${[...seenHosts].sort().join(',')}`;
      if (this.#warnedOverrides.has(key)) continue;
      this.#warnedOverrides.add(key);
      this.#log(
        `thresholds: hostOverrides["${host}"] matches no observed host, so its tuning is ` +
          `inert. Observed: ${[...seenHosts].sort().join(', ') || '(none)'}`,
      );
    }
  }

  #state(hosts: readonly Host[]): HealthScanState {
    if (this.#stale) return 'stale';
    if (this.#lastPollAt === null) return 'warming';
    const allWarm = hosts.every((host) => this.#baselines.isWarm(host.host, BASELINED_METRICS));
    return allWarm ? 'ok' : 'warming';
  }

  /**
   * Convert the cumulative errored counter into a per-minute rate.
   *
   * Returns null on the first sample for a host — a cumulative counter tells you
   * nothing about rate until you have two readings. A counter that goes backwards
   * means the production restarted, so we reset rather than report a negative rate.
   */
  #errorsPerMinute(proxyHost: ProxyHost, now: number): number | null {
    // `errored` is null on every host today: iris_interop_messages_errored has no `host`
    // label (#31). Without a count there is no rate, so return null and let
    // elevated_error_rate stay silent rather than compare against a fabricated 0.
    if (proxyHost.errored === null) return null;

    const prior = this.#priorErrored.get(proxyHost.host);
    this.#priorErrored.set(proxyHost.host, { errored: proxyHost.errored, at: now });

    if (prior === undefined) return null;
    const elapsedMs = now - prior.at;
    if (elapsedMs <= 0) return null;

    const delta = proxyHost.errored - prior.errored;
    if (delta < 0) return null;

    return (delta / elapsedMs) * 60_000;
  }

  /**
   * system_alert — attributed to a host only when the alert text names it.
   *
   * An alert is a discrete EVENT, not a sustained condition, so it is deliberately
   * exempt from the sustained-breach gate. It reports for as long as the alert stays in
   * the proxy's payload, and clears when the alert ages out.
   *
   * The earlier version marked an alert seen on its first poll and returned null
   * afterwards, which made the rule structurally unable to fire at all: the registry
   * needs `sustainedSamples` (2) consecutive verdicts to confirm, and this only ever
   * produced one. Found via Dev C observing 46 live findings with no `system_alert`
   * and no `info` severity among them (#8) — every rule unit test passed, because the
   * conflict was between the rule and the registry rather than inside either.
   *
   * `#seenAlerts` still exists, but now only to keep `detectedAt` anchored to the first
   * time we saw the alert rather than resetting each poll.
   */
  #evaluateAlerts(
    hostName: string,
    alerts: readonly ProxyAlert[],
    now: number,
  ): RuleVerdict | null {
    const rule = configFor(this.#config, 'system_alert', hostName);
    if (!rule.enabled) return null;

    for (const alert of alerts) {
      if (!alert.message.includes(hostName)) continue;

      // Record first sighting, but do NOT suppress subsequent polls — see above.
      this.#seenAlerts.add(`${alert.time}|${hostName}`);

      // IRIS alert severity is numeric and inverted: lower means worse.
      const numeric = Number(alert.severity);
      const severity: Severity = Number.isFinite(numeric)
        ? numeric <= rule.criticalSeverityAtOrBelow
          ? 'critical'
          : rule.severity
        : rule.severity;

      return {
        type: 'system_alert',
        severity,
        currentValue: Number.isFinite(numeric) ? numeric : 0,
        baselineValue: null,
        message: `New system alert: ${alert.message}`,
      };
    }
    return null;
  }
}

/**
 * Map the proxy's shape to the published contract shape.
 *
 * Two conversions the contract documents (Q10, Q11):
 *   - IRIS calls business processes 'actor'; the contract says 'process'
 *   - IRIS gives elapsed seconds; the contract wants an ISO timestamp
 */
export function normalizeHost(proxyHost: ProxyHost, now: number): Host {
  return {
    host: proxyHost.host,
    type: normalizeHostType(proxyHost.type),
    status: proxyHost.status as HostStatus,
    queued: orZero(proxyHost.queued),
    messagesPerSec: orZero(proxyHost.messagesPerSec),
    errored: orZero(proxyHost.errored),
    avgProcessingTime: orZero(proxyHost.avgProcessingTime),
    avgQueueingTime: orZero(proxyHost.avgQueueingTime),
    // A host with no activity line has never run, so "now" is the only defensible
    // reading — and lastActivity is +-10s anyway (contract Q11).
    lastActivity: isoSeconds(now - (proxyHost.lastActivityElapsedSeconds ?? 0) * 1000),
  };
}

/**
 * Collapse an unmeasurable count to 0 for the published `Host` shape.
 *
 * This is a lie we tell deliberately and narrowly, and it is worth being explicit about
 * why. `contracts/healthscan.schema.json` declares `Host.queued` and `Host.errored` as
 * REQUIRED integers, and Dev C's grid renders them unconditionally. Emitting `null`
 * against a required-integer field would do to Dev C exactly what the proxy's `null`
 * did to us -- their guard would reject the host and the grid would blank (#32). So the
 * wire stays contract-conformant.
 *
 * The 0 is not load-bearing for detection: `#errorsPerMinute` reads the raw nullable
 * value BEFORE this conversion and returns null when it is absent, so no rule compares
 * against the fabricated zero. `queue_buildup` is blocked upstream regardless (#12).
 *
 * The real fix is a contract change making these two fields `number | null`, which is a
 * PR to `contracts/` with all three reviewers -- not something to slip in here.
 */
function orZero(value: number | null): number {
  return value ?? 0;
}

/** Contract Q10: IRIS 'actor' means a business process. */
export function normalizeHostType(irisType: string): string {
  return irisType === 'actor' ? 'process' : irisType;
}

/** The contract's timestamps are second-precision and Z-suffixed. */
function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
