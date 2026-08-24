/**
 * Runtime shape validation for `/api/settings/thresholds` (§2.4).
 *
 * Field-by-field, log-and-skip, same discipline as `guards.ts` and `mvp2Guards.ts`: a malformed
 * entry is dropped rather than rejecting the whole payload, so one bad descriptor cannot blank the
 * panel. The endpoint is ours, but a shape check here is what keeps a bad payload from rendering a
 * broken form rather than no form.
 *
 * A FIELD WITH NO EFFECTIVE VALUE IS DROPPED. The panel's whole promise is that it shows what is
 * actually in force, so a descriptor whose value is missing has nothing honest to render — an input
 * defaulted to `shipped` would silently claim the shipped value is live when it may not be. Dropping
 * it is the same choice `settings.ts` makes server-side by omitting the key.
 */

import type { SettingFieldView, ThresholdSettingsView } from '../types/settings';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number, or null. Rejects NaN and Infinity, which JSON.parse can produce from `1e999`. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseField(raw: unknown): SettingFieldView | null {
  if (!isRecord(raw)) return null;
  const key = str(raw['key']);
  const label = str(raw['label']);
  if (key === '' || label === '') return null;

  const min = num(raw['min']);
  const max = num(raw['max']);
  const step = num(raw['step']);
  const shipped = num(raw['shipped']);
  // Bounds are advisory but an input needs them to be numbers. A descriptor missing one is
  // unrenderable rather than partly renderable, so it is skipped.
  if (min === null || max === null || step === null || shipped === null) return null;
  if (min >= max) return null;

  return {
    key,
    label,
    help: str(raw['help']),
    blastRadius: str(raw['blastRadius']),
    min,
    max,
    step,
    shipped,
  };
}

/** One `Record<string, number>` from the wire, keeping only finite numeric entries. */
function parseNumberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const parsed = num(value);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

/**
 * Returns null when the payload is unreadable, which the hook renders as "settings unavailable"
 * rather than raising the connection banner — a missing optional panel must not look like an
 * outage, the same reasoning `getHostSeries` uses.
 */
export function parseThresholdSettings(raw: unknown): ThresholdSettingsView | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw['fields'])) return null;

  const effective = parseNumberMap(raw['effective']);
  const file = parseNumberMap(raw['file']);

  const fields: SettingFieldView[] = [];
  for (const entry of raw['fields']) {
    const field = parseField(entry);
    if (field === null) continue;
    // See the file comment: no live value means nothing honest to show.
    if (!(field.key in effective)) continue;
    fields.push(field);
  }

  return {
    fields,
    effective,
    file,
    overridden: raw['overridden'] === true,
    persistence: str(raw['persistence']),
  };
}
