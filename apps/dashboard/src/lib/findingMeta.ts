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
  dead_host: 'count',
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
