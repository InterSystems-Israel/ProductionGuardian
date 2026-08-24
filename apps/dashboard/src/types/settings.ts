/**
 * Threshold settings — the shape of `/api/settings/thresholds`.
 *
 * NOT A TRANSCRIPTION OF `contracts/`, and that is deliberate rather than an omission. The two
 * ratified Health Scan endpoints live in `contracts/` and `types/healthscan.ts` mirrors them
 * exactly (§2.3). This is an operational endpoint on the engine, a sibling of `/api/earlywarning`
 * and `/api/hostseries` — root `CLAUDE.md` §4 governs edits to that directory, not the existence
 * of endpoints outside it, and `contracts/` is read-only for this work.
 *
 * The engine SENDS THE FIELD DESCRIPTORS rather than this file declaring them. That is the same
 * argument `TriggerRail` makes for the scenario list: the engine owns which thresholds are
 * editable and what each one does to detection, so a list here would be a second copy that goes
 * stale into inputs that 400. The consequence is that this panel renders whatever it is given,
 * including a field added later with no dashboard change.
 */

/** One editable threshold, exactly as the engine describes it. */
export interface SettingFieldView {
  key: string;
  label: string;
  /** What moving it does, in the operator's terms. */
  help: string;
  /** Stated because lowering a gate widens what fires on a live production. */
  blastRadius: string;
  /** Advisory input bounds. The engine's `validateConfig` is the authority. */
  min: number;
  max: number;
  step: number;
  /** The committed value, for the "shipped" column. */
  shipped: number;
}

export interface ThresholdSettingsView {
  fields: SettingFieldView[];
  /** Current effective value per key — what is actually in force in the engine. */
  effective: Record<string, number>;
  /** The file's own value per key, i.e. what a reset restores. */
  file: Record<string, number>;
  /** True while an in-memory override is in force. Drives the "not persisted" notice. */
  overridden: boolean;
  /** The engine's own sentence about persistence. Rendered as-is, never reworded here. */
  persistence: string;
}
