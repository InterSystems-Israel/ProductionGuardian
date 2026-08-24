/**
 * Threshold configuration — ADR 0003.
 *
 * Loads thresholds.json, validates it, and hot-reloads on change. On a malformed
 * file it keeps the last-good values and logs loudly. It never falls back to zeros,
 * which would make every rule fire at once.
 */

import { readFileSync, watch } from 'node:fs';
import type { Severity } from '../types/healthscan.ts';

export interface DeadHostConfig {
  enabled: boolean;
  severity: Severity;
}

export interface StalledHostConfig {
  enabled: boolean;
  inactiveSeconds: number;
  /** Idle alone is not stalled — a quiet host with an empty queue is healthy. */
  requiresQueued: boolean;
  severity: Severity;
}

export interface QueueBuildupConfig {
  enabled: boolean;
  baselineMultiplier: number;
  /** Must exceed the multiplier AND this floor. 1 -> 5 is 5x but not a problem. */
  absoluteFloor: number;
  severityBands: { warning: number; critical: number };
}

export interface ErrorRateConfig {
  enabled: boolean;
  errorsPerMinuteFloor: number;
  baselineMultiplier: number;
  severityBands: { warning: number; critical: number };
}

/** Shared by slow_processing and growing_queue_wait — same shape, different metric. */
export interface DurationRuleConfig {
  enabled: boolean;
  baselineMultiplier: number;
  absoluteFloorSeconds: number;
  /**
   * Zero-baseline hosts only. An infinite ratio cannot be graded by the bands, so
   * severity comes from absolute magnitude: this many times the floor earns `critical`,
   * anything above the floor alone is a `warning`. Without it the floor becomes a
   * critical trigger and there is no warning tier at all.
   */
  criticalFloorMultiple: number;
  severityBands: { warning: number; critical: number };
}

export interface ThroughputDropConfig {
  enabled: boolean;
  /** Fires below baseline * this. 0.4 means "less than 40% of normal". */
  baselineFraction: number;
  /** Below this absolute rate the baseline is too quiet to judge a drop against. */
  minBaselineRate: number;
  severityBands: { warning: number; critical: number };
}

export interface SystemAlertConfig {
  enabled: boolean;
  severity: Severity;
  /** IRIS alert severity is numeric and inverted — lower means worse. */
  criticalSeverityAtOrBelow: number;
}

export interface RuleConfigs {
  dead_host: DeadHostConfig;
  stalled_host: StalledHostConfig;
  queue_buildup: QueueBuildupConfig;
  elevated_error_rate: ErrorRateConfig;
  slow_processing: DurationRuleConfig;
  growing_queue_wait: DurationRuleConfig;
  throughput_drop: ThroughputDropConfig;
  system_alert: SystemAlertConfig;
}

/**
 * Default engine poll interval, in ms — the one `src/index.ts` uses absent
 * POLL_INTERVAL_MS.
 *
 * Lives here rather than in index.ts because `sustainedSeconds` must be reachable within
 * `sustainedSamples` polls of it (see DEFAULT_CONFIG below): the three numbers are ONE
 * constraint, and a test has to be able to read all of them. Importing index.ts to get
 * this would start a server and a poll loop as a side effect, so the test previously held
 * a hardcoded copy — which left it passing while the relationship it asserts became false
 * (#19's "copies of a fact", inside the test written to protect that fact).
 */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface ThresholdConfig {
  /** MVP §6: consecutive breaching samples required before emitting. */
  sustainedSamples: number;
  /**
   * Minimum wall-clock duration a breach must persist before emitting, in seconds.
   *
   * A condition confirms only when BOTH gates are met. Why two: `sustainedSamples`
   * alone couples false-positive protection to the poll rate, so halving the poll
   * interval silently halves the debounce *duration* (#44). Adding a time gate means
   * we can poll faster for latency without weakening what MVP §6 actually asks for.
   *
   * Set to 0 to disable the time gate and get the old sample-only behaviour.
   */
  sustainedSeconds: number;
  /** ADR 0002: samples needed before a baseline is usable. */
  minBaselineSamples: number;
  baselineWindowSeconds: number;
  /**
   * Per-host, per-metric REFERENCE baselines — a stated "normal" that does not move.
   *
   * WHY THIS EXISTS. The rolling mean includes the samples being judged against it, so a
   * gradually rising metric drags its own baseline up and the ratio saturates. For a linear
   * ramp the closed form is `2n/(n+1)`: it approaches 2.0 and never crosses a 5.0 gate, at
   * any depth, any duration, and — because the slope cancels out of the algebra — at any
   * inflow rate. Measured on the live stack: the ratio pins at exactly 2.00 while the queue
   * climbs past 1200. `queue_buildup` is structurally unable to fire on a ramp.
   *
   * That is §5.1's documented self-inflation, but the ramp case is worse than the step case
   * it describes: a step fires for ~12 minutes and then clears while the problem persists,
   * whereas a ramp never fires at all. MVP 1 shipped that knowingly because its scenarios
   * were all steps (disable a host, break its target) and `dead_host` is absolute anyway.
   * MVP 2's scenario is a ramp on a *healthy* host — throughput-bound, status OK — so no
   * absolute rule backs it up.
   *
   * WHY NOT JUST A LONGER WINDOW. A multi-day window fixes the arithmetic (a 10-minute
   * bombardment cannot move a mean with days behind it) but not the demo: a fresh
   * `compose up` has no days of history. `minBaselineSamples` is satisfied after 12 samples,
   * so the window goes "warm" holding only the last minute, and a 3-day *configured* window
   * on a 5-minute-old instance would claim evidence it does not have. A stated reference is
   * the more honest artifact of the two — it says "this is an assumed normal" rather than
   * implying a measurement.
   *
   * PRECEDENCE: a reference here WINS over the rolling mean when present. Absent, behaviour
   * is exactly as before. So this is opt-in per host+metric and changes nothing it is not
   * configured for.
   *
   * Shape: `{ "<host>": { "<metric>": <number> } }`.
   */
  referenceBaselines: Record<string, Record<string, number>>;
  /**
   * Early Warning projection settings — `contracts/earlywarning-api.md`.
   *
   * `fitWindowSeconds` is deliberately shorter than `baselineWindowSeconds`: a least-squares fit
   * over the full 30 minutes systematically UNDERSTATES a rise that started two minutes ago,
   * because the older, flatter half of the window drags the slope toward zero — and that is
   * precisely the case Early Warning exists to catch.
   *
   * `horizonSeconds` equals `baselineWindowSeconds` on purpose: do not project further forward
   * than the span of history the fit is grounded in. A 90-minute ETA off a 5-minute fit is
   * arithmetic, not information.
   *
   * REACHABILITY, the same invariant `sustainedSeconds` carries:
   * `fitWindowSeconds / (POLL_INTERVAL_MS / 1000)` must exceed `minFitSamples` with margin. At
   * the shipped 5000ms engine poll that is 60 samples available against 12 required. Shortening
   * the window below 60s at that rate makes a projection structurally impossible and the module
   * goes silent with no error — #64's failure mode in a new place.
   */
  earlyWarning: {
    enabled: boolean;
    fitWindowSeconds: number;
    horizonSeconds: number;
    minFitSamples: number;
  };
  rules: RuleConfigs;
  /** Per-host partial overrides, merged over the rule defaults. */
  hostOverrides: Record<string, Partial<Record<keyof RuleConfigs, unknown>>>;
}

export const DEFAULT_CONFIG: ThresholdConfig = {
  sustainedSamples: 2,
  // Must be REACHABLE within sustainedSamples polls WITH MARGIN, or it silently costs an
  // extra one. Two ways that has already gone wrong here:
  //
  //   8 at a 5s poll  — unreachable in 2 samples, confirms on the 3rd. Measured 12.8s.
  //   5 at a 5s poll  — reachable only by EXACT equality (5000 >= 5000). The stamp is
  //                     taken after a variable-duration fetch (index.ts), so the observed
  //                     gap is POLL_INTERVAL + (fetch_n − fetch_{n−1}). Any poll quicker
  //                     than its predecessor makes the gap < 5000 and slips confirmation
  //                     to the third sample — intermittently 10.2s instead of 5.3s, on
  //                     roughly half of all detections. 100ms of jitter is enough.
  //
  // 4 leaves 1000ms of slack at the shipping rate and still decouples the debounce from
  // the poll rate at every shorter interval (4s of protection at a 1s poll, where the old
  // sample-only behaviour gave 1s). That decoupling is the whole point of the gate (#44).
  //
  // The general form, learned twice: a timing number needs the rate it runs at AND the
  // jitter on that rate. `>=` on exact equality is the least robust point on the curve.
  sustainedSeconds: 4,
  minBaselineSamples: 12,
  baselineWindowSeconds: 1800,
  // Empty by default: no host gets a reference baseline unless thresholds.json states one, so
  // the shipped behaviour is unchanged and this cannot surprise anyone who has not opted in.
  referenceBaselines: {},
  // Defaults duplicated from thresholds.json deliberately: DEFAULT_CONFIG is the last-good
  // fallback when that file is missing or invalid (ADR 0003), so it has to stand alone.
  earlyWarning: {
    enabled: true,
    fitWindowSeconds: 300,
    horizonSeconds: 1800,
    minFitSamples: 12,
  },
  rules: {
    dead_host: { enabled: true, severity: 'critical' },
    stalled_host: {
      enabled: true,
      inactiveSeconds: 300,
      requiresQueued: true,
      severity: 'warning',
    },
    queue_buildup: {
      enabled: true,
      baselineMultiplier: 5.0,
      absoluteFloor: 50,
      severityBands: { warning: 5.0, critical: 20.0 },
    },
    elevated_error_rate: {
      enabled: true,
      errorsPerMinuteFloor: 1.0,
      baselineMultiplier: 3.0,
      severityBands: { warning: 3.0, critical: 10.0 },
    },
    slow_processing: {
      enabled: true,
      baselineMultiplier: 3.0,
      absoluteFloorSeconds: 1.0,
      criticalFloorMultiple: 4.0,
      severityBands: { warning: 3.0, critical: 10.0 },
    },
    growing_queue_wait: {
      enabled: true,
      baselineMultiplier: 3.0,
      absoluteFloorSeconds: 1.0,
      criticalFloorMultiple: 4.0,
      severityBands: { warning: 3.0, critical: 10.0 },
    },
    throughput_drop: {
      enabled: true,
      baselineFraction: 0.4,
      minBaselineRate: 0.1,
      severityBands: { warning: 0.4, critical: 0.1 },
    },
    system_alert: { enabled: true, severity: 'info', criticalSeverityAtOrBelow: 1 },
  },
  hostOverrides: {},
};

/** Thrown when a candidate config is unusable. The caller keeps the last-good values. */
export class ConfigValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid threshold config: ${problems.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

/**
 * Validate a parsed config and merge it over the defaults.
 *
 * Every numeric bound must be positive and finite. A zero multiplier would make a
 * rule fire on every sample, which is the specific failure this guards against.
 */
export function validateConfig(raw: unknown): ThresholdConfig {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigValidationError(['not an object']);
  }
  const input = raw as Record<string, unknown>;

  const merged: ThresholdConfig = structuredClone(DEFAULT_CONFIG);

  for (const key of ['sustainedSamples', 'minBaselineSamples', 'baselineWindowSeconds'] as const) {
    if (key in input) {
      const value = input[key];
      if (!isPositiveNumber(value)) {
        problems.push(`${key} must be a positive number, got ${JSON.stringify(value)}`);
      } else {
        merged[key] = value;
      }
    }
  }

  // Separate from the loop above because 0 is legal here and means "no time gate",
  // whereas a zero window or sample count would disable detection entirely.
  if ('sustainedSeconds' in input) {
    const value = input['sustainedSeconds'];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`sustainedSeconds must be zero or a positive number, got ${JSON.stringify(value)}`);
    } else {
      merged.sustainedSeconds = value;
    }
  }

  const rawRules = input['rules'];
  if (rawRules !== undefined) {
    if (typeof rawRules !== 'object' || rawRules === null) {
      problems.push('rules must be an object');
    } else {
      for (const [name, value] of Object.entries(rawRules as Record<string, unknown>)) {
        if (name.startsWith('_')) continue;
        if (!(name in merged.rules)) {
          problems.push(`unknown rule "${name}"`);
          continue;
        }
        if (typeof value !== 'object' || value === null) {
          problems.push(`rules.${name} must be an object`);
          continue;
        }
        const ruleKey = name as keyof RuleConfigs;
        const ruleProblems = validateRuleNumbers(name, value as Record<string, unknown>);
        problems.push(...ruleProblems);
        if (ruleProblems.length === 0) {
          // Shape is checked field-by-field above; the cast is the merge boundary.
          Object.assign(merged.rules[ruleKey] as object, value);
        }
      }
    }
  }

  const rawOverrides = input['hostOverrides'];
  if (rawOverrides !== undefined) {
    if (typeof rawOverrides !== 'object' || rawOverrides === null) {
      problems.push('hostOverrides must be an object');
    } else {
      for (const [host, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
        if (host.startsWith('_')) continue;
        if (typeof value !== 'object' || value === null) {
          problems.push(`hostOverrides.${host} must be an object`);
          continue;
        }
        merged.hostOverrides[host] = value as Partial<Record<keyof RuleConfigs, unknown>>;
      }
    }
  }

  const rawEarlyWarning = input['earlyWarning'];
  if (rawEarlyWarning !== undefined) {
    if (typeof rawEarlyWarning !== 'object' || rawEarlyWarning === null) {
      problems.push('earlyWarning must be an object');
    } else {
      const ew = rawEarlyWarning as Record<string, unknown>;
      if (ew['enabled'] !== undefined) {
        if (typeof ew['enabled'] !== 'boolean') {
          problems.push('earlyWarning.enabled must be a boolean');
        } else {
          merged.earlyWarning.enabled = ew['enabled'];
        }
      }
      for (const field of ['fitWindowSeconds', 'horizonSeconds', 'minFitSamples'] as const) {
        const value = ew[field];
        if (value === undefined) continue;
        if (!isPositiveNumber(value)) {
          problems.push(`earlyWarning.${field} must be a positive number`);
          continue;
        }
        merged.earlyWarning[field] = value;
      }
      // REACHABILITY, checked rather than trusted. A fit window too short to hold minFitSamples
      // at the shipped poll rate makes every projection structurally impossible, and the module
      // would go silent with no error — the #64 failure mode, which cost a measurement cycle to
      // find the first time. Checked against DEFAULT_POLL_INTERVAL_MS because the poll rate lives
      // in this module too; a deployment overriding POLL_INTERVAL_MS has to re-check this.
      const capacity = merged.earlyWarning.fitWindowSeconds / (DEFAULT_POLL_INTERVAL_MS / 1000);
      if (capacity <= merged.earlyWarning.minFitSamples) {
        problems.push(
          `earlyWarning.fitWindowSeconds ${merged.earlyWarning.fitWindowSeconds}s holds only ` +
            `${Math.floor(capacity)} samples at a ${DEFAULT_POLL_INTERVAL_MS}ms poll, but ` +
            `minFitSamples is ${merged.earlyWarning.minFitSamples} — no projection could ever ` +
            `be produced`,
        );
      }
    }
  }

  const rawReferences = input['referenceBaselines'];
  if (rawReferences !== undefined) {
    if (typeof rawReferences !== 'object' || rawReferences === null) {
      problems.push('referenceBaselines must be an object');
    } else {
      for (const [host, metrics] of Object.entries(rawReferences as Record<string, unknown>)) {
        if (host.startsWith('_')) continue;
        if (typeof metrics !== 'object' || metrics === null) {
          problems.push(`referenceBaselines.${host} must be an object of metric: number`);
          continue;
        }
        const perHost: Record<string, number> = {};
        for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
          if (metric.startsWith('_')) continue;
          // ZERO IS LEGAL HERE, unlike everywhere else in this file. A reference of 0 states
          // "this metric is normally zero", which is true of `queued` on a healthy host and is
          // the most useful reference we have. The rule's own
          // `baseline > 0 ? depth/baseline : INFINITY` branch then reduces the test to the
          // absolute floor, which is the correct reading: any queue at all is abnormal, and the
          // floor decides whether it is worth reporting. Rejecting 0 as "not positive" would
          // reject the only value most hosts want.
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            problems.push(
              `referenceBaselines.${host}.${metric} must be a finite number >= 0, got ${JSON.stringify(value)}`,
            );
            continue;
          }
          perHost[metric] = value;
        }
        merged.referenceBaselines[host] = perHost;
      }
    }
  }

  if (problems.length > 0) throw new ConfigValidationError(problems);
  return merged;
}

/**
 * The baseline a comparative rule should compare against: a configured reference if one
 * exists for this host+metric, otherwise the rolling mean.
 *
 * Single function rather than four inline checks, because the four comparative rules must
 * agree on precedence — one rule honouring a reference while another ignores it would produce
 * findings that contradict each other about what normal is.
 *
 * Returns null exactly when the rolling mean would have: no reference AND not enough samples.
 * A reference therefore also removes the warm-up wait for the metric it covers, which is a
 * side effect worth knowing rather than a separate feature.
 */
export function effectiveBaseline(
  config: ThresholdConfig,
  host: string,
  metric: string,
  rollingMean: number | null,
): number | null {
  const reference = config.referenceBaselines[host]?.[metric];
  return reference === undefined ? rollingMean : reference;
}

/** Every numeric field in a rule must be positive; booleans and severities pass through. */
function validateRuleNumbers(ruleName: string, rule: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [field, value] of Object.entries(rule)) {
    if (field.startsWith('_')) continue;
    if (field === 'severityBands') {
      if (typeof value !== 'object' || value === null) {
        problems.push(`rules.${ruleName}.severityBands must be an object`);
        continue;
      }
      for (const [band, bandValue] of Object.entries(value as Record<string, unknown>)) {
        if (!isPositiveNumber(bandValue)) {
          problems.push(`rules.${ruleName}.severityBands.${band} must be positive`);
        }
      }
      continue;
    }
    if (typeof value === 'number' && !isPositiveNumber(value)) {
      problems.push(
        `rules.${ruleName}.${field} must be a positive finite number, got ${JSON.stringify(value)}`,
      );
    }
  }
  return problems;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the effective config for one rule on one host, applying any override.
 * Overrides are partial, so a host may adjust one bound and inherit the rest.
 */
export function configFor<K extends keyof RuleConfigs>(
  config: ThresholdConfig,
  rule: K,
  host: string,
): RuleConfigs[K] {
  const override = config.hostOverrides[host]?.[rule];
  if (override === undefined || typeof override !== 'object' || override === null) {
    return config.rules[rule];
  }
  return { ...config.rules[rule], ...(override as object) } as RuleConfigs[K];
}

/** Override keys, excluding the `_comment` documentation entries. */
export function declaredOverrideHosts(config: ThresholdConfig): string[] {
  return Object.keys(config.hostOverrides).filter((key) => !key.startsWith('_'));
}

/**
 * Override keys that match no host the engine has actually seen.
 *
 * `hostOverrides` is keyed by a literal host name, so pointing the engine at a different
 * production makes every override inert — silently. The tuning simply stops applying and
 * nothing says so. Raised by Dev C in #25, and it is the same shape as three failures
 * this project has already fixed: `npm test --if-present` reporting green on nothing,
 * `-c ajv-formats` quietly ignoring `format`, and the `@devA` CODEOWNERS placeholder
 * requesting review from nobody. A config that weakens without complaining.
 *
 * Returns the inert keys so the caller can log them. Deliberately not an error: an
 * override for a host that is temporarily absent from a running production is
 * legitimate, and refusing to start would be worse than saying so.
 */
export function inertOverrideHosts(
  config: ThresholdConfig,
  observedHosts: Iterable<string>,
): string[] {
  const seen = new Set(observedHosts);
  return declaredOverrideHosts(config).filter((host) => !seen.has(host));
}

/**
 * Deep-merge a patch over a base, for plain objects only.
 *
 * Used to lay a runtime override on top of the file's raw JSON before validation, so an
 * override of `rules.queue_buildup.severityBands.warning` does not erase the sibling
 * `critical` band — which a shallow spread at any level would.
 *
 * Arrays and non-objects REPLACE rather than merge. Nothing in a threshold config is an
 * array, so this is a guard against a future field rather than a behaviour anyone relies on,
 * and replacing is the less surprising of the two for a value a caller stated explicitly.
 */
function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? mergePatch(base[key], value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Live config holder. Reads once at construction, then re-reads on file change.
 * A bad file is logged and ignored — `current` keeps the last good value.
 *
 * SINCE THE SETTINGS PANEL (`api/settings.ts`) IT ALSO HOLDS AN IN-MEMORY OVERRIDE, and the
 * two compose rather than one winning outright: `current` is always
 * `validateConfig(file JSON + override patch)`. Three properties follow, and the middle one is
 * the reason the override is kept as a RAW PATCH rather than as a finished config.
 *
 *   1. An override is validated by exactly the code a file is, so it cannot introduce a value
 *      the file could not have held, and it produces the same problem strings.
 *   2. A FILE RELOAD RE-APPLIES THE OVERRIDE rather than clobbering it. Holding a finished
 *      config would mean the next `fs.watch` event silently reverted whatever the operator had
 *      just set — a knob that undoes itself is worse than one that does not exist. Holding the
 *      patch means the file's other edits land AND the override survives.
 *   3. `clearOverride()` returns to whatever the file says now, which is what makes "reset to
 *      shipped defaults" mean the committed values rather than a snapshot from process start.
 *
 * THE OVERRIDE IS NOT PERSISTED, deliberately. The mount is read-only (`docker-compose.yml`)
 * and writing to a tracked repo file from a browser during a demo is the trap ADR 0003's
 * "tunable without redeploying" was never asking for. So a restart reverts to the file, and
 * the panel says so rather than leaving it to be discovered.
 */
export class ThresholdStore {
  /** Last-good raw JSON from the file. The base every override composes over. */
  #fileRaw: unknown;
  /** The file alone, validated — what `clearOverride()` returns to. */
  #fileConfig: ThresholdConfig;
  /** The raw override patch, or null when none is in force. Never persisted. */
  #override: Record<string, unknown> | null = null;
  #current: ThresholdConfig;
  #watcher: ReturnType<typeof watch> | undefined;

  readonly #path: string;
  readonly #log: (msg: string) => void;

  constructor(path: string, log: (msg: string) => void = console.error) {
    this.#path = path;
    this.#log = log;
    const read = this.#read();
    // DEFAULT_CONFIG as the base when the file is missing or invalid, matching the previous
    // behaviour exactly — an override then composes over the defaults instead of the file.
    this.#fileRaw = read?.raw ?? structuredClone(DEFAULT_CONFIG);
    this.#fileConfig = read?.config ?? structuredClone(DEFAULT_CONFIG);
    this.#current = this.#fileConfig;
  }

  get current(): ThresholdConfig {
    return this.#current;
  }

  /** The file's own values, ignoring any override. What a reset restores. */
  get fileConfig(): ThresholdConfig {
    return this.#fileConfig;
  }

  /** True while an in-memory override is in force. */
  get overridden(): boolean {
    return this.#override !== null;
  }

  /**
   * Compose a raw patch over the file and make it live, or throw.
   *
   * VALIDATES BEFORE APPLYING and leaves `current` untouched on failure, which is the same
   * last-good discipline `#read` uses for the file: a rejected override must not partly land,
   * because a half-applied threshold set is a detection policy nobody chose. The
   * `ConfigValidationError` propagates so the caller can surface its `problems` verbatim.
   */
  applyOverride(patch: Record<string, unknown>): ThresholdConfig {
    const next = validateConfig(mergePatch(this.#fileRaw, patch));
    this.#override = patch;
    this.#current = next;
    return next;
  }

  /** Drop the override and return to the file's own values. Cannot fail — see `api/settings.ts`. */
  clearOverride(): ThresholdConfig {
    this.#override = null;
    this.#current = this.#fileConfig;
    return this.#current;
  }

  /** Begin hot-reloading. Safe to skip in tests. */
  watch(): void {
    if (this.#watcher !== undefined) return;
    try {
      this.#watcher = watch(this.#path, () => {
        const next = this.#read();
        if (next !== undefined) {
          this.#fileRaw = next.raw;
          this.#fileConfig = next.config;
          this.#current = next.config;
          this.#log(
            `thresholds reloaded: sustainedSamples=${next.config.sustainedSamples} ` +
              `sustainedSeconds=${next.config.sustainedSeconds}`,
          );
          // RE-APPLIED, NOT DROPPED, per the class comment: a file event must not silently
          // revert a live override. A patch that the NEW file makes invalid is dropped rather
          // than kept — the file is the authority, and refusing to reload would leave the
          // engine running values that are in neither the file nor a request.
          if (this.#override !== null) {
            try {
              this.#current = validateConfig(mergePatch(this.#fileRaw, this.#override));
              this.#log('threshold override re-applied over the reloaded file');
            } catch (err) {
              this.#override = null;
              this.#log(
                `threshold override dropped — the reloaded file makes it invalid: ${errorMessage(err)}`,
              );
            }
          }
        }
      });
    } catch (err) {
      this.#log(`threshold hot-reload unavailable: ${errorMessage(err)}`);
    }
  }

  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /**
   * Returns undefined on any failure, so the caller keeps the previous config.
   *
   * Hands back the RAW JSON alongside the validated config, because an override composes over
   * the raw form. Composing over the validated form would work today but would bake every
   * default into the base, so a later `DEFAULT_CONFIG` change would stop reaching a deployment
   * that had ever set an override.
   */
  #read(): { raw: unknown; config: ThresholdConfig } | undefined {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      return { raw, config: validateConfig(raw) };
    } catch (err) {
      this.#log(`threshold config rejected, keeping previous values: ${errorMessage(err)}`);
      return undefined;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
