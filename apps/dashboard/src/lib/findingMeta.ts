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

export function findingMeta(type: string): FindingMeta {
  const known = KNOWN[type as FindingType];
  if (known !== undefined) {
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
