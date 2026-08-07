/**
 * Display formatting. `Intl` only — no date library (§3).
 *
 * Every function here has to survive absent data: the contract allows a null
 * baseline during warm-up, and the guards substitute `''` for a missing
 * timestamp. Absent renders as an em dash, never `NaN`, `null` or `0` (§2.4).
 */

export const ABSENT = '—';

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const decimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/** Counts and other whole numbers: `486`, `1,204`. */
export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? integer.format(value) : ABSENT;
}

/** Rates: `20.4`. One decimal — more jitters on screen without informing. */
export function formatRate(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? decimal.format(value) : ABSENT;
}

/**
 * Durations arrive in seconds — confirmed empirically by Dev B against LABDEMO,
 * not assumed (§4 Q6). Sub-second reads as ms because `0.08 s` is harder to
 * compare at a glance than `80 ms`.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return ABSENT;
  if (seconds === 0) return '0 ms';
  if (seconds < 1) return `${integer.format(seconds * 1000)} ms`;
  if (seconds < 60) return `${decimal.format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} s`;
}

/** Parses an ISO 8601 timestamp; null for absent or unparseable input. */
export function parseTimestamp(iso: string | null | undefined): Date | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2 minutes ago`, `just now`. `now` is injected so callers re-render on tick. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parseTimestamp(iso);
  if (date === null) return ABSENT;

  const deltaSeconds = Math.round((date.getTime() - now) / 1000);
  const magnitude = Math.abs(deltaSeconds);
  if (magnitude < 10) return 'just now';
  if (magnitude < 60) return relativeTime.format(deltaSeconds, 'second');
  if (magnitude < 3600) return relativeTime.format(Math.round(deltaSeconds / 60), 'minute');
  if (magnitude < 86400) return relativeTime.format(Math.round(deltaSeconds / 3600), 'hour');
  return relativeTime.format(Math.round(deltaSeconds / 86400), 'day');
}

/** Absolute UTC, shown alongside the relative time in the detail drawer. */
export function formatAbsoluteUtc(iso: string | null | undefined): string {
  const date = parseTimestamp(iso);
  if (date === null) return ABSENT;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `14:02:11` — the "last updated" / "data as of" clock. */
export function formatClock(timestamp: number | null): string {
  if (timestamp === null) return ABSENT;
  return new Date(timestamp).toISOString().slice(11, 19);
}

/** `12s ago` — deliberately terser than formatRelative for the header. */
export function formatAge(sinceMs: number | null, now: number = Date.now()): string {
  if (sinceMs === null) return ABSENT;
  const seconds = Math.max(0, Math.round((now - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The current-vs-baseline comparison, which is the whole point of the detail
 * view (§7.2). A ratio only informs when the baseline is a meaningful non-zero
 * quantity — a queue that went 0 → 12 is a delta, not "12× baseline", and
 * "Infinity×" on a projector reads as a bug. Falls back to a signed delta.
 *
 * A ratio is dimensionless, but a *delta* is not: `0.68s` vs `0.36s` is
 * "+320 ms", not the unitless "+0.3" that reads as a bare number next to two
 * millisecond values. `formatDelta` supplies the unit, which is why the caller
 * passes what the metric measures.
 */
export function formatComparison(
  current: number,
  baseline: number | null,
  formatDelta: (value: number) => string = formatRate,
): string {
  if (baseline === null) return ABSENT;
  if (baseline === 0) {
    return current === 0 ? 'no change' : `+${formatDelta(current)} from 0`;
  }
  const ratio = current / baseline;
  // Below 2× a multiplier is noise; a delta is more honest at that scale.
  if (ratio >= 2) return `${decimal.format(ratio)}×`;
  if (ratio > 0 && ratio <= 0.5) return `${decimal.format(ratio * 100)}% of baseline`;
  // Sign applied to the magnitude, because the unit formatters describe sizes,
  // not signed quantities — `formatDuration(-0.32)` has no sensible reading.
  const delta = current - baseline;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return `${sign}${formatDelta(Math.abs(delta))}`;
}

/** `queue_buildup` → `Queue buildup`. Used for finding types the UI doesn't know. */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return ABSENT;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
