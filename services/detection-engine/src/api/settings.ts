/**
 * Threshold settings — the read and write behind the dashboard's Settings panel.
 *
 * ADR 0003 makes `thresholds.json` the single place detection numbers live, hot-reloaded, with
 * no threshold hard-coded in rule logic. This module does not change that: it is a governed
 * IN-MEMORY OVERLAY over the same file, validated by the same `validateConfig`, so the file
 * stays the source of the shipped values and the panel is a way to try a different one.
 *
 * WHY IN-MEMORY AND NOT A FILE WRITE. The mount is `:ro` in `docker-compose.yml` and the file
 * is tracked in git. Making it writable would mean a browser button mutating repo source
 * mid-demo, with the change surviving into whatever anyone committed next. ADR 0003 asked for
 * "tunable without redeploying", which this is; it did not ask for tunable-and-persisted, and
 * the honest cost is that a restart reverts. The panel states that rather than leaving it to be
 * found — see `ThresholdSettingsView.tsx`.
 *
 * WHY NOT A UI-SIDE OVERLAY, which is the cheaper-looking option. The engine decides what a
 * finding IS and its `message` states the numbers ("Queue depth 486 is 32x baseline").
 * `apps/dashboard/CLAUDE.md` §2.4 makes that string authoritative and forbids the UI
 * reconstructing it. A dashboard applying its own bands would therefore render the engine's own
 * sentence next to a severity the engine did not assign, and the two would disagree on screen.
 * The threshold has to move where the decision is made.
 *
 * WHAT IS EXPOSED — `queue_buildup` only, three numbers. The owner asked for "critical/warning
 * queue levels for example", and one rule wired end to end demonstrates the idea better than
 * eight rules' worth of inputs: every rule's bands is ~20 fields, most of which need the
 * §5.1 self-inflation argument and the `referenceBaselines` table to interpret. The
 * cross-rule keys are deliberately NOT here — `sustainedSamples`, `sustainedSeconds` and the
 * poll interval are one reachability invariant (`thresholds.json` `_comment_sustained`), and a
 * panel that let one move without the others would silently cost a sample or break the
 * debounce. Widening the set is a config change in this file plus a row in the panel.
 */

import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  type ThresholdConfig,
  type ThresholdStore,
} from '../config/thresholds.ts';

/**
 * One editable number, as the panel renders it.
 *
 * `min`/`max` are ADVISORY BOUNDS FOR THE INPUT, not a second validation layer — the authority
 * is `validateConfig`, and the endpoint runs it regardless of what these say. They exist so the
 * panel can render a sane `<input type="number">` and refuse an obvious typo before a round
 * trip. Keeping them advisory is deliberate: a bound enforced in two places is a bound that
 * will eventually disagree with itself, which is the stale-copy shape this repo has been bitten
 * by repeatedly.
 */
export interface SettingField {
  /** Dotted path within the config, e.g. `rules.queue_buildup.absoluteFloor`. */
  key: string;
  label: string;
  /** What moving it does, in the operator's terms. Rendered under the input. */
  help: string;
  /** Stated in the panel, because lowering a gate widens what fires. */
  blastRadius: string;
  min: number;
  max: number;
  /** `1` for a count, a fraction for a multiplier. Drives the input's `step`. */
  step: number;
  /** The committed value, for the "shipped default" column and the reset control. */
  shipped: number;
}

/**
 * The editable set.
 *
 * THE FIRING GATE AND THE WARNING BAND ARE ONE CONTROL, not two, and that is the load-bearing
 * decision in this file. `queue_buildup` fires at `baselineMultiplier` and warns at
 * `severityBands.warning`, and the two are EQUAL by design — documented in `thresholds.json`
 * `_comment_info_severity`, `services/detection-engine/CLAUDE.md` §5.2, and pinned by
 * `test/scenario.test.ts` asserting `info` comes only from `system_alert`. Exposing them as two
 * inputs would invite exactly the edit those three places forbid: lowering the warning band
 * alone, which reaches `info` only by also lowering the gate, widening what fires and
 * reintroducing the false positives MVP §6 names as the top risk.
 *
 * So the panel offers "warning level", one number, written to BOTH paths. An operator can make
 * the rule quieter or noisier; they cannot open the gap that produces an unreachable severity.
 * `WARNING_KEYS` below is what makes that a single field rather than a convention.
 */
export const WARNING_KEYS = [
  'rules.queue_buildup.baselineMultiplier',
  'rules.queue_buildup.severityBands.warning',
] as const;

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'rules.queue_buildup.absoluteFloor',
    label: 'Minimum queue depth',
    help:
      'A queue shallower than this never reports, however far above baseline it is. ADR 0003 ' +
      'calls this the single biggest false-positive lever: 1 → 5 is 5× baseline and not a problem.',
    blastRadius:
      'Lowering this widens what fires on the live production — shallow queues that are ' +
      'currently ignored will start reporting.',
    min: 1,
    max: 10_000,
    step: 1,
    shipped: DEFAULT_CONFIG.rules.queue_buildup.absoluteFloor,
  },
  {
    key: WARNING_KEYS[1],
    label: 'Warning level (× baseline)',
    help:
      'A queue this many times its baseline reports as a warning. This is also the level at ' +
      'which the rule fires at all — the two are equal by design, so this one number is ' +
      'written to both.',
    blastRadius:
      'This is the firing gate. Lowering it widens what fires on the live production; raising ' +
      'it silences queues that report today.',
    min: 1.1,
    max: 1000,
    step: 0.5,
    shipped: DEFAULT_CONFIG.rules.queue_buildup.severityBands.warning,
  },
  {
    key: 'rules.queue_buildup.severityBands.critical',
    label: 'Critical level (× baseline)',
    help:
      'A queue this many times its baseline reports as critical instead of a warning. Does not ' +
      'change what fires, only how loudly.',
    blastRadius:
      'Severity only — nothing new starts or stops firing. Below the warning level every ' +
      'firing queue reads critical.',
    min: 1.1,
    max: 10_000,
    step: 1,
    shipped: DEFAULT_CONFIG.rules.queue_buildup.severityBands.critical,
  },
] as const;

/** `GET /api/settings/thresholds`. */
export interface SettingsPayload {
  fields: readonly SettingField[];
  /** The CURRENT EFFECTIVE value per key, read from the live config — never a default. */
  effective: Record<string, number>;
  /** The file's own value per key, so the panel can show what a reset would restore. */
  file: Record<string, number>;
  /** True while an in-memory override is in force. Drives the panel's "not persisted" notice. */
  overridden: boolean;
  /**
   * Said in the payload rather than only in the UI, so `curl` sees it too. The engine is the
   * only component that knows whether its own values came from the file or a request.
   */
  persistence: string;
}

const PERSISTENCE_NOTE =
  'Changes apply immediately to the running engine and are NOT written to thresholds.json. ' +
  'A restart of the detection engine reverts to the committed values.';

/** Read one dotted path out of a config. Returns null when the path does not resolve. */
function readPath(config: ThresholdConfig, key: string): number | null {
  let node: unknown = config;
  for (const part of key.split('.')) {
    if (!isRecord(node)) return null;
    node = node[part];
  }
  return typeof node === 'number' && Number.isFinite(node) ? node : null;
}

/** Build the nested patch object one dotted path implies. */
function patchFor(key: string, value: number): Record<string, unknown> {
  const parts = key.split('.');
  const root: Record<string, unknown> = {};
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    node[part] = next;
    node = next;
  }
  node[parts[parts.length - 1] as string] = value;
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Merge nested patches, so three fields become one object rather than three requests. */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key];
    if (isRecord(existing) && isRecord(value)) {
      mergeInto(existing as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

export function settingsPayload(store: ThresholdStore): SettingsPayload {
  const effective: Record<string, number> = {};
  const file: Record<string, number> = {};
  for (const field of SETTING_FIELDS) {
    const live = readPath(store.current, field.key);
    const onDisk = readPath(store.fileConfig, field.key);
    // Only present keys are published. A field whose path stopped resolving is a bug in this
    // file rather than a value to invent, and omitting it makes the panel render "—" instead of
    // a number that is not in force anywhere.
    if (live !== null) effective[field.key] = live;
    if (onDisk !== null) file[field.key] = onDisk;
  }
  return {
    fields: SETTING_FIELDS,
    effective,
    file,
    overridden: store.overridden,
    persistence: PERSISTENCE_NOTE,
  };
}

/**
 * Parse a `PUT /api/settings/thresholds` body into a patch.
 *
 * Throws `bad request: ...`, which `server.ts` maps to 400. Rejects an unknown key rather than
 * ignoring it: a silently dropped setting is the failure mode where an operator moves a slider,
 * sees no change, and concludes detection is broken. Same reasoning as `validateConfig`
 * rejecting an unknown rule name.
 */
export function parseSettingsRequest(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new Error('bad request: body must be an object');
  const values = body['values'];
  if (!isRecord(values)) throw new Error('bad request: values must be an object');

  const entries = Object.entries(values);
  if (entries.length === 0) throw new Error('bad request: values must name at least one setting');

  const known = new Map(SETTING_FIELDS.map((f) => [f.key, f]));
  const patch: Record<string, unknown> = {};

  for (const [key, raw] of entries) {
    const field = known.get(key);
    if (field === undefined) {
      throw new Error(
        `bad request: unknown setting "${key}" — editable settings are ` +
          `${[...known.keys()].join(', ')}`,
      );
    }
    // NUMBER, not a numeric string. The panel sends JSON numbers, and coercing "abc" to NaN
    // here would hand `validateConfig` a value it reports as "must be a positive finite
    // number" — true, but it would name the threshold rather than the request, which sends a
    // reader to the wrong file.
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`bad request: ${key} must be a finite number, got ${JSON.stringify(raw)}`);
    }
    mergeInto(patch, patchFor(key, raw));
    // THE PAIRED WRITE. See WARNING_KEYS: the firing gate and the warning band must move
    // together, and doing it here rather than in the UI means curl cannot separate them either.
    if (key === WARNING_KEYS[1]) {
      mergeInto(patch, patchFor(WARNING_KEYS[0], raw));
    }
  }

  return patch;
}

export interface SettingsResult extends SettingsPayload {
  /** `applied` or `reset`, so a caller can tell which operation answered. */
  outcome: 'applied' | 'reset';
}

/**
 * Apply a patch, or report why not.
 *
 * A `ConfigValidationError` is re-thrown as `bad request: <problems>` so the endpoint answers
 * 400 with `validateConfig`'s OWN problem strings. Deliberately not reworded: those strings
 * already name the field and the constraint, and a second wording would be a second thing to
 * keep in step with the validator.
 */
export function applySettings(store: ThresholdStore, patch: Record<string, unknown>): SettingsResult {
  try {
    store.applyOverride(patch);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new Error(`bad request: ${err.problems.join('; ')}`);
    }
    throw err;
  }
  return { ...settingsPayload(store), outcome: 'applied' };
}

/**
 * Drop the override.
 *
 * CANNOT FAIL AND TAKES NO BODY, for the reason `server.ts` gives for `/api/demo/reset`: this
 * is the operation that recovers from every other one, so it must not be refusable on a
 * malformed request. It returns to the FILE's values rather than to `DEFAULT_CONFIG`, which is
 * what "shipped defaults" means for a deployment whose `thresholds.json` was tuned — the panel
 * shows both columns so there is no ambiguity about which is being restored.
 */
export function resetSettings(store: ThresholdStore): SettingsResult {
  store.clearOverride();
  return { ...settingsPayload(store), outcome: 'reset' };
}
