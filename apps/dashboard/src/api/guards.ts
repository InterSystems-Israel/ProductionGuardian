/**
 * Runtime shape validation at the API boundary (§2.4).
 *
 * The rule is log-and-skip, not reject: one malformed host must not blank the
 * whole grid mid-demo. Anything the contract calls required must be present and
 * of the right primitive type; anything the contract leaves loose (`status`,
 * finding `type`, `severity`) passes through as a string for the UI to render
 * neutrally.
 */

import type { FindingView, HostView } from '../types/healthscan';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * For the fields the contract declares nullable: `baselineValue` during baseline
 * warm-up, and `queued` / `errored` when the count is not measurable (Q13).
 *
 * Anything non-numeric collapses to `null` rather than to `0`, because `0` has to
 * keep meaning *measured* zero. A count we never measured, rendered as a count,
 * is the one failure mode the em dash exists to prevent.
 */
function asNullableNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function warn(endpoint: string, index: number, reason: string, entry: unknown): void {
  // Console is the right channel here: a contract drift should be visible to
  // whoever is debugging without interrupting the operator's view.
  console.warn(`[healthscan] ${endpoint}[${index}] skipped — ${reason}`, entry);
}

function parseHost(entry: unknown, index: number): HostView | null {
  if (!isRecord(entry)) {
    warn('hosts', index, 'not an object', entry);
    return null;
  }
  if (!isNonEmptyString(entry.host)) {
    warn('hosts', index, 'missing `host`', entry);
    return null;
  }
  // An absent metric never drops the host: a host present in the production still
  // belongs on the grid. The two *nullable* counts keep their absence (Q13); the
  // rest still default to 0, since the contract declares them always numeric and
  // a missing one is drift rather than a documented state.
  return {
    host: entry.host,
    type: isNonEmptyString(entry.type) ? entry.type : 'unknown',
    status: isNonEmptyString(entry.status) ? entry.status : 'unknown',
    queued: asNullableNumber(entry.queued),
    messagesPerSec: isFiniteNumber(entry.messagesPerSec) ? entry.messagesPerSec : 0,
    errored: asNullableNumber(entry.errored),
    avgProcessingTime: isFiniteNumber(entry.avgProcessingTime) ? entry.avgProcessingTime : 0,
    avgQueueingTime: isFiniteNumber(entry.avgQueueingTime) ? entry.avgQueueingTime : 0,
    lastActivity: isNonEmptyString(entry.lastActivity) ? entry.lastActivity : '',
  };
}

function parseFinding(entry: unknown, index: number): FindingView | null {
  if (!isRecord(entry)) {
    warn('findings', index, 'not an object', entry);
    return null;
  }
  // `id` is the list's stable identity and `message` is the primary text — a
  // finding without either cannot be rendered or kept across polls.
  if (!isNonEmptyString(entry.id)) {
    warn('findings', index, 'missing `id`', entry);
    return null;
  }
  if (!isNonEmptyString(entry.message)) {
    warn('findings', index, 'missing `message`', entry);
    return null;
  }
  return {
    id: entry.id,
    host: isNonEmptyString(entry.host) ? entry.host : 'unknown',
    type: isNonEmptyString(entry.type) ? entry.type : 'unknown',
    severity: isNonEmptyString(entry.severity) ? entry.severity : 'info',
    currentValue: isFiniteNumber(entry.currentValue) ? entry.currentValue : 0,
    baselineValue: asNullableNumber(entry.baselineValue),
    detectedAt: isNonEmptyString(entry.detectedAt) ? entry.detectedAt : '',
    message: entry.message,
  };
}

/** Throws only if the payload is not an array at all — that is unusable. */
export function parseHosts(payload: unknown): HostView[] {
  if (!Array.isArray(payload)) {
    throw new Error('GET /hosts did not return an array');
  }
  return payload.map(parseHost).filter((host): host is HostView => host !== null);
}

export function parseFindings(payload: unknown): FindingView[] {
  if (!Array.isArray(payload)) {
    throw new Error('GET /findings did not return an array');
  }
  return payload
    .map(parseFinding)
    .filter((finding): finding is FindingView => finding !== null);
}
