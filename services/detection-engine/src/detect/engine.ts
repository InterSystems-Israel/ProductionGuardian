/**
 * The detection engine: turns proxy polls into hosts + findings.
 *
 * Responsibilities, in order:
 *   1. Normalize the proxy's host shape into the published contract shape
 *   2. Feed the rolling baseline
 *   3. Run the rules, and hand verdicts to the registry
 *   4. Expose current hosts and confirmed findings
 */

import type { MetricName } from '../baseline/window.ts';
import { BaselineStore } from '../baseline/window.ts';
import type { ThresholdConfig } from '../config/thresholds.ts';
import { configFor, inertOverrideHosts } from '../config/thresholds.ts';
import type {
  Finding,
  FindingType,
  HealthScanState,
  Host,
  HostStatus,
  Severity,
} from '../types/healthscan.ts';
import type { ProxyAlert, ProxyHost, ProxyResponse } from '../types/proxy.ts';
import { isFrameworkHost } from '../types/proxy.ts';
import { FindingRegistry } from './registry.ts';
import { HOST_RULES } from './rules/index.ts';
import { projectHost, type HostProjection } from './earlywarning.ts';
import { buildHostSeries, type HostSeries } from './series.ts';
import type { RawHostMetrics, RuleInputKey, RuleVerdict } from './rules/types.ts';

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
  /**
   * Early Warning projections, one per reported host — `contracts/earlywarning-api.md`.
   *
   * Computed DURING the poll, not on request. Two reasons: the raw nullable metrics are in
   * hand there and are not retained afterwards (so computing at request time would have to
   * read the normalized host, where an unmeasurable value has already become 0 — the #49
   * defect), and `measuredAt` must be the sample's clock rather than the request clock
   * (contract EW-Q3). A projection recomputed per request would also drift between two
   * requests in the same poll interval, which reads as instability in the product.
   */
  projections: HostProjection[];
  state: HealthScanState;
  /** When the engine last successfully applied a poll. null before the first. */
  lastPollAt: number | null;
}

export class DetectionEngine {
  #baselines: BaselineStore;
  #registry: FindingRegistry;
  #hosts = new Map<string, Host>();
  /** Latest projection per host, computed at poll time. Cleared with the host. */
  #projections = new Map<string, HostProjection>();
  /** Cumulative errored counts from the previous poll, for the per-minute rate. */
  #priorErrored = new Map<string, { errored: number; at: number }>();
  /** Hosts missing from recent payloads, awaiting the absence bar in applyPoll(). */
  #absent = new Map<string, { firstAbsentAt: number; polls: number }>();
  /** Alert timestamps already reported, so system_alert only fires on new ones. */
  #seenAlerts = new Set<string>();
  #lastPollAt: number | null = null;
  #stale = false;
  /** Inert-override warnings already emitted, so the log is not repeated per poll. */
  #warnedOverrides = new Set<string>();
  /** Unattributed alerts already logged, so a persistent one is reported once (#61). */
  #loggedUnattributedAlerts = new Set<string>();
  readonly #log: (msg: string) => void;

  #config: ThresholdConfig;

  constructor(config: ThresholdConfig, log: (msg: string) => void = console.error) {
    this.#log = log;
    this.#config = config;
    this.#baselines = new BaselineStore(config.baselineWindowSeconds, config.minBaselineSamples);
    this.#registry = new FindingRegistry(config.sustainedSamples, config.sustainedSeconds);
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
      next.sustainedSamples !== this.#config.sustainedSamples ||
      next.sustainedSeconds !== this.#config.sustainedSeconds;

    this.#config = next;
    this.#warnedOverrides.clear();
    if (structural) {
      this.#baselines = new BaselineStore(next.baselineWindowSeconds, next.minBaselineSamples);
      this.#registry = new FindingRegistry(next.sustainedSamples, next.sustainedSeconds);
      this.#priorErrored.clear();
      // The absence bar reads the same two knobs, so a partly-counted absence measured
      // against the old ones is not comparable to the new ones.
      this.#absent.clear();
    }
  }

  /** Mark the last poll as failed. Serves last-known data labelled stale. */
  markPollFailed(): void {
    this.#stale = true;
  }

  /**
   * Declare a load-regime change at `at`: baselines re-warm instead of averaging across it.
   *
   * Called after a demo reset succeeds, because a reset restores inbound load in one step
   * while the rolling mean keeps the pre-reset rate for a further 30 minutes — which
   * measurably produced `throughput_drop` on all three hosts of a healthy, idle production
   * (2026-08-27). `BaselineStore.beginRegime()` has the numbers.
   *
   * The engine goes back to `warming` for `minBaselineSamples` polls (60s at the shipped
   * 5s interval) and reports NO comparative findings in that time. That is the intended
   * trade and it is the honest one: for a minute after the load changes we genuinely do not
   * know what normal is, and MVP §6 is explicit that a guessed baseline is worse than none.
   *
   * Does NOT touch the finding registry. A false positive already on the board clears on the
   * next poll because the rule stops returning a verdict, which is the same route every
   * finding takes when its condition ends — no special-case teardown.
   */
  beginRegime(at: number): void {
    this.#baselines.beginRegime(at);
  }

  /**
   * Record a baseline sample only if it was actually measured (#49).
   *
   * `null` means "IRIS does not expose this per host", not zero. Recording it as zero
   * fabricates history, and history is what every comparative rule divides by.
   */
  #recordIfMeasured(
    host: string,
    metric: MetricName,
    value: number | null,
    now: number,
  ): void {
    if (value === null) return;
    this.#baselines.record(host, metric, value, now);
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

      // Record from the RAW proxy values, never the normalized host: normalizeHost()
      // collapses null to 0 for the wire, and an unmeasurable count recorded as a measured
      // zero DEFLATES the baseline it feeds. Five minutes of absent data was enough to turn
      // an unchanged queue of 60 into "6.5x baseline" (#49) — a warning whose arithmetic is
      // internally consistent and factually meaningless.
      //
      // Skipping leaves a GAP in the window rather than a false sample. That is the honest
      // representation and it fails safe: fewer samples can only take a host back below
      // minBaselineSamples, i.e. to `warming`, where comparative rules stay silent (ADR
      // 0002). It can never invent a comparison.
      //
      // The `errorsPerMinute` guard below was already doing this. The current value was
      // protected in every rule; the historical values were protected nowhere.
      this.#recordIfMeasured(host.host, 'queued', proxyHost.queued, now);
      this.#recordIfMeasured(host.host, 'messagesPerSec', proxyHost.messagesPerSec, now);
      this.#recordIfMeasured(host.host, 'avgProcessingTime', proxyHost.avgProcessingTime, now);
      this.#recordIfMeasured(host.host, 'avgQueueingTime', proxyHost.avgQueueingTime, now);
      if (errorsPerMinute !== null) {
        this.#baselines.record(host.host, 'errorsPerMinute', errorsPerMinute, now);
      }

      // Raw nullable values, so a rule can tell "measured zero" from "unknown".
      // normalizeHost() collapses these for the wire; rules must not see that.
      const raw = {
        queued: proxyHost.queued,
        messagesPerSec: proxyHost.messagesPerSec,
        errored: proxyHost.errored,
        avgProcessingTime: proxyHost.avgProcessingTime,
        avgQueueingTime: proxyHost.avgQueueingTime,
        lastActivityElapsedSeconds: proxyHost.lastActivityElapsedSeconds,
      };

      const verdicts: RuleVerdict[] = [];
      // Rules whose silence this poll means "cannot tell", not "not breaching" — one of
      // their declared inputs was absent. The registry must not read these as a clear.
      const unmeasurable = new Set<FindingType>();
      for (const rule of HOST_RULES) {
        if (rule.requires.some((key) => inputValue(raw, errorsPerMinute, key) === null)) {
          unmeasurable.add(rule.type);
        }
        const verdict = rule.evaluate({
          host,
          errorsPerMinute,
          raw,
          baselines: this.#baselines,
          config: this.#config,
          now,
        });
        if (verdict !== null) verdicts.push(verdict);
      }

      const alertVerdict = this.#evaluateAlerts(host.host, response.alerts, now);
      if (alertVerdict !== null) verdicts.push(alertVerdict);

      this.#registry.update(host.host, verdicts, now, unmeasurable);

      // AFTER recordIfMeasured above, so the fit window includes this poll's sample. Before
      // it, every projection would be one poll stale and `measuredAt` would disagree with
      // `currentValue`.
      this.#projections.set(
        host.host,
        projectHost(host.host, raw, this.#baselines, this.#config, now),
      );
    }

    // A host that left the production should not linger with stale findings — but ONE poll
    // that omits it is not proof it left, and forgetting on that poll is the other half of
    // "findings appear and disappear with no clear cause".
    //
    // It is the worse half, because it does not just retract the finding — it takes the
    // BASELINE with it. At the shipped minBaselineSamples of 12 and a 5s poll, a host that
    // dropped out of one payload came back with an empty window, so every comparative rule
    // was `warming` and SILENT for a further minute. The finding does not flicker; it goes
    // away and cannot return, for a reason invisible from the outside.
    //
    // So absence gets the same two gates as a breach, from the same two knobs — see the
    // symmetry note in registry.ts. sustainedSamples 1 / sustainedSeconds 0 forgets on the
    // first absent poll, i.e. the old behaviour exactly.
    for (const known of [...this.#hosts.keys()]) {
      if (seenHosts.has(known)) {
        this.#absent.delete(known);
        continue;
      }

      const absent = this.#absent.get(known) ?? { firstAbsentAt: now, polls: 0 };
      absent.polls += 1;
      this.#absent.set(known, absent);
      const gone =
        absent.polls >= this.#config.sustainedSamples &&
        now - absent.firstAbsentAt >= this.#config.sustainedSeconds * 1000;
      if (!gone) continue;

      this.#hosts.delete(known);
      this.#projections.delete(known);
      this.#registry.forget(known);
      this.#baselines.forget(known);
      this.#priorErrored.delete(known);
      this.#absent.delete(known);
    }

    this.#warnInertOverrides(seenHosts);
    this.#logUnattributedAlerts(response.alerts, seenHosts);

    this.#lastPollAt = now;
    this.#stale = false;
  }

  /**
   * Log each alert that matches no configured host, once (#61).
   *
   * `system_alert` matches an alert to a host by the host name appearing in the message
   * text, and only REPORTED hosts are candidates -- framework items are skipped before
   * `seenHosts` is built, so they are configured but not reported. So an instance-level alert
   * (disk, license, journal) AND an alert naming a framework host both produce NO finding. That is deliberate for MVP 1 (see CLAUDE.md §5.2b: the alternatives
   * are a pseudo-host that breaks the "only config items appear" guarantee, or a
   * production-level channel that belongs to Health Summary).
   *
   * But silently discarding it is worse than declining it: a consumer cannot tell "no such
   * alert" from "alert dropped" by reading either endpoint. This makes the gap visible in
   * operation for the cost of a log line, with no contract change.
   *
   * Keyed by alert time + message so a persistent alert logs once rather than every poll --
   * the same reasoning as `#warnedOverrides`.
   */
  #logUnattributedAlerts(
    alerts: readonly ProxyAlert[],
    seenHosts: ReadonlySet<string>,
  ): void {
    for (const alert of alerts) {
      if ([...seenHosts].some((host) => alert.message.includes(host))) continue;
      const key = `${alert.time}|${alert.message}`;
      if (this.#loggedUnattributedAlerts.has(key)) continue;
      this.#loggedUnattributedAlerts.add(key);
      this.#log(
        `alert matches no reported host, so no finding is emitted for it ` +
          `(severity ${alert.severity}): ${alert.message}`,
      );
    }
  }

  snapshot(): EngineSnapshot {
    const hosts = [...this.#hosts.values()].sort((a, b) => a.host.localeCompare(b.host));
    return {
      hosts,
      findings: this.#registry.findings(),
      // Sorted by host, matching `hosts`, so a consumer can zip the two without a lookup.
      projections: [...this.#projections.values()].sort((a, b) => a.host.localeCompare(b.host)),
      state: this.#state(hosts),
      lastPollAt: this.#lastPollAt,
    };
  }

  /**
   * One host's recent metric series, read out of the rolling baseline.
   *
   * NOT PART OF `snapshot()`, deliberately, and that is the whole reason this is a separate
   * method. `snapshot()` is called on EVERY request to five endpoints, and folding three series
   * into it would build up to a few hundred points per poll for a panel that is usually closed.
   * This is called only when a host is selected, and only for that host.
   *
   * `known` is computed HERE rather than by the caller, because `#hosts` is this class's state:
   * the roster is what `applyPoll` last saw, and a name absent from it is either a typo or a host
   * that left the production between a render and a click. Both answer honestly rather than
   * erroring -- see `series.ts` on why that is not a 404.
   *
   * A read, not a computation: `buildHostSeries` only walks the window. `now` is passed in for the
   * same testability reason every rule takes it.
   */
  hostSeries(host: string, spanSeconds: number, pollIntervalMs: number, now: number): HostSeries {
    return buildHostSeries({
      host,
      known: this.#hosts.has(host),
      baselines: this.#baselines,
      spanSeconds,
      // Read from the live config rather than captured at construction, so a hot-reloaded window
      // length (ADR 0003) moves the ceiling with it instead of advertising the old one.
      windowSeconds: this.#config.baselineWindowSeconds,
      pollIntervalMs,
      now,
      lastPollAt: this.#lastPollAt,
    });
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
    queued: proxyHost.queued,
    messagesPerSec: orZero(proxyHost.messagesPerSec),
    errored: proxyHost.errored,
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
 * SCOPE, after #49: this now applies ONLY to the three fields the schema still declares as
 * plain numbers -- messagesPerSec, avgProcessingTime, avgQueueingTime. `queued` and
 * `errored` pass through as `number | null`, because #35 made them `["integer","null"]` and
 * Dev C's dashboard needs the distinction (guards.ts asNullableNumber, formatCount renders
 * an em dash). Every premise of the original justification below had expired:
 *
 *   "declares them as REQUIRED integers"          -> integer|null since #35, still required
 *   "Dev C's guard would reject the host"         -> their guard now REQUIRES nullable
 *   "queue_buildup is blocked upstream (#12)"     -> #12/#36 landed; depth is measured
 *
 * Making the remaining three nullable is a contract change request to `contracts/`, not
 * something to do here -- which is what the note at the end of this comment said, and it
 * was right both times.
 *
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

/**
 * One of a rule's declared inputs, by name. `errorsPerMinute` is derived across polls
 * rather than carried on the sample, so it is not in `raw` and is passed alongside.
 */
function inputValue(
  raw: RawHostMetrics,
  errorsPerMinute: number | null,
  key: RuleInputKey,
): number | null {
  return key === 'errorsPerMinute' ? errorsPerMinute : raw[key];
}

/** Contract Q10: IRIS 'actor' means a business process. */
export function normalizeHostType(irisType: string): string {
  return irisType === 'actor' ? 'process' : irisType;
}

/** The contract's timestamps are second-precision and Z-suffixed. */
function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
