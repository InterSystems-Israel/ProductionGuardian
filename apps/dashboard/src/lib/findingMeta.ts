/**
 * Finding type → label, icon and the underlying IRIS metric.
 *
 * The metric names are the ones from §1.3 of the MVP spec; the drawer shows
 * them so an operator can go look at `/api/monitor/metrics` themselves.
 *
 * An unrecognized type must still render — neutral icon plus a humanized label
 * derived from the string (§2.4). Never filter it out, never throw.
 */

import type { FindingType } from '../types/healthscan';
import { humanize } from './format';
import {
  IconAlert,
  IconDead,
  IconDrop,
  IconError,
  IconQueue,
  IconSlow,
  IconStalled,
  IconUnknown,
  IconWait,
  type IconProps,
} from '../components/icons';

export interface FindingMeta {
  label: string;
  /** The IRIS metric the rule reads; null when the type is unknown to the UI. */
  metric: string | null;
  Icon: (props: IconProps) => JSX.Element;
  /** True when the type is not one of the eight in the contract. */
  unknown: boolean;
}

const KNOWN: Record<FindingType, Omit<FindingMeta, 'unknown'>> = {
  dead_host: {
    label: 'Dead host',
    metric: 'iris_interop_hosts',
    Icon: IconDead,
  },
  stalled_host: {
    label: 'Stalled host',
    metric: 'iris_last_activity',
    Icon: IconStalled,
  },
  queue_buildup: {
    label: 'Queue buildup',
    metric: 'iris_interop_queued',
    Icon: IconQueue,
  },
  elevated_error_rate: {
    label: 'Elevated error rate',
    metric: 'iris_interop_messages_errored',
    Icon: IconError,
  },
  slow_processing: {
    label: 'Slow processing',
    metric: 'iris_interop_avg_processing_time',
    Icon: IconSlow,
  },
  growing_queue_wait: {
    label: 'Growing queue wait',
    metric: 'iris_interop_avg_queueing_time',
    Icon: IconWait,
  },
  throughput_drop: {
    label: 'Throughput drop',
    metric: 'iris_interop_messages_per_sec',
    Icon: IconDrop,
  },
  system_alert: {
    label: 'System alert',
    metric: 'iris_system_alerts_new',
    Icon: IconAlert,
  },
};

/** The eight contract types, in the order §1.3 of the spec lists them. */
export const FINDING_TYPES = Object.keys(KNOWN) as FindingType[];

/**
 * `dead_host` covers four IRIS statuses and "Dead host" is only right for two of them.
 *
 * `Stopped` and `Disabled` mean the host is not running — dead is accurate. `Error` and `Inactive`
 * mean it IS running and failing, which is a different thing to an operator: a host in `Error`
 * because its configured directory does not exist is very much alive, and labelling it dead sends
 * someone to look for a stopped job. Reported as wrong by @Ari-Glikman on the MVP 3 scenario.
 *
 * THE STATUS COMES FROM THE MESSAGE, not from a new contract field. The engine's `message` is
 * authoritative and already states it verbatim — "Cloud API is Error with 439 message(s) queued" —
 * so the status is there to be read. Adding a `status` field to `Finding` for a label would be a
 * contract change (§2.3) for something the payload already carries.
 *
 * Deliberately narrow: it matches only the exact phrase the rule emits, and falls back to the
 * generic label for anything else. A loose match would relabel findings whose message merely
 * mentions a status word.
 */
function deadHostLabel(message: string | undefined): string {
  if (message === undefined) return 'Host not processing';
  if (/\bis Error\b/.test(message)) return 'Host in error';
  if (/\bis Inactive\b/.test(message)) return 'Host inactive';
  if (/\bis Stopped\b/.test(message)) return 'Host stopped';
  if (/\bis Disabled\b/.test(message)) return 'Host disabled';
  // Covers a status the rule gains later without this going stale into a wrong claim: "not
  // processing" is true of every member of DEAD_STATUSES, present and future.
  return 'Host not processing';
}

export function findingMeta(type: string, message?: string): FindingMeta {
  const known = KNOWN[type as FindingType];
  if (known !== undefined) {
    if (type === 'dead_host') {
      return { ...known, label: deadHostLabel(message), unknown: false };
    }
    return { ...known, unknown: false };
  }
  return { label: humanize(type), metric: null, Icon: IconUnknown, unknown: true };
}

/**
 * How to render the finding's current/baseline numbers. The contract carries no
 * unit, so it is derived from the metric the rule reads — a queue depth is a
 * count, a processing time is a duration, throughput is a rate.
 */
export type ValueKind = 'count' | 'duration' | 'rate';

const VALUE_KIND: Record<FindingType, ValueKind> = {
  /* `rate`, not `count`: a dead host's values are throughput, not a tally. Dev B's
     captured sample carries `current: 0, baseline: 0.4` — 0.4 being Cloud API's
     actual messagesPerSec — so formatting as a count rounds the baseline to "0"
     and the comparison reads "no change" for a host that has stopped dead. */
  dead_host: 'rate',
  stalled_host: 'duration',
  queue_buildup: 'count',
  elevated_error_rate: 'count',
  slow_processing: 'duration',
  growing_queue_wait: 'duration',
  throughput_drop: 'rate',
  system_alert: 'count',
};

export function valueKind(type: string): ValueKind {
  return VALUE_KIND[type as FindingType] ?? 'count';
}

/**
 * Whether the rule behind a finding compares against a baseline at all.
 *
 * The contract gives `baselineValue: null` one documented meaning — "the rolling
 * baseline is still warming up" (§2, Q3) — but the engine also sends `null` for the
 * rules that are **absolute by design** and have no baseline to warm. Both readings
 * arrive as the same `number | null`, so the type cannot separate them and the drawer
 * would otherwise say "still warming up" about a fully warm baseline. Raised on PR #8;
 * this table is the local resolution and stays correct whichever way that lands.
 *
 * Derived from the contract's own §2.1 table rather than from Dev B's rule taxonomy:
 * `dead_host` reads a status and `stalled_host` reads an idle time, so neither has a
 * "normal" to compare against, while `system_alert` reports a discrete event. The
 * other five compare a metric to its rolling mean.
 *
 * Unknown types default to comparative, which is the safer wrong answer: it says a
 * baseline is expected and absent, rather than asserting none applies to a rule the
 * UI knows nothing about.
 */
const ABSOLUTE_TYPES: ReadonlySet<string> = new Set<FindingType>([
  'dead_host',
  'stalled_host',
  'system_alert',
]);

export function comparesToBaseline(type: string): boolean {
  return !ABSOLUTE_TYPES.has(type);
}

/**
 * Whether an investigation exists for a finding type, and if not, which of the two reasons applies.
 *
 * `investigation-api.md` §2.4 tells the consumer not to offer Investigate outside this set, and says
 * in the same breath that the engine's own check "is the backstop, not the UI's contract" — so this
 * list is a deliberate duplicate of `INVESTIGABLE_TYPES` in the engine rather than a single source of
 * truth. Both exist because a hidden button is not a boundary and a served refusal is not a UI.
 *
 * THE TWO REASONS ARE KEPT APART because they are different facts about the product, and an operator
 * acting on them would do different things. `never_forwarded` is a data rule: a `system_alert`'s
 * message is text IRIS wrote and can name the message an alert was about, so it does not leave the
 * instance (root `CLAUDE.md` §2.1). `no_scenario` is a coverage gap: nothing is unsafe, there is
 * simply no investigation built for it yet. Collapsing them into "cannot investigate" would let a
 * privacy boundary read as an unfinished feature.
 *
 * KEYED ON TYPE, NOT ON `(type, host)` as §2.4 words it. Two scenarios ship — queue buildup on a
 * throughput-bound operation, and a host that has stopped processing — and a host name here would be
 * this directory tracking `Production.cls`'s config, which §9 forbids outright (#25).
 *
 * An unrecognized type gets `no_scenario`, which matches what the engine would answer: its check is
 * an allowlist, so a type neither side knows is refused by both.
 */
export type InvestigationScope = 'investigable' | 'never_forwarded' | 'no_scenario';

const INVESTIGABLE_TYPES: ReadonlySet<string> = new Set<FindingType>([
  'queue_buildup',
  'dead_host',
]);

export function investigationScope(type: string): InvestigationScope {
  if (type === 'system_alert') return 'never_forwarded';
  return INVESTIGABLE_TYPES.has(type) ? 'investigable' : 'no_scenario';
}
