/**
 * Dev A's metrics-proxy output (:3001).
 *
 * RATIFIED. Transcribed from `contracts/proxy-api.md` and `contracts/proxy.schema.json`.
 * The five `PROXY-Q` markers this file used to carry are resolved and gone — the answers
 * live in §5 of `proxy-api.md`, and three of the five contradicted what we had assumed.
 * Do not drift from the contract: a change here without a matching PR to `contracts/` is
 * the failure mode that breaks integration.
 *
 * What the assumptions got wrong, because it explains the shape of this file:
 *
 *   Q1  the host field is `host`, not `name`, and the error count is `errored`, not
 *       `messagesErrored`. Our guard rejected every real host on those two names alone.
 *   Q2  `queued` is `null` on every host. `iris_interop_queued` has no `host` label — it
 *       is emitted once per production, with the real total in `_meta.productionQueued`.
 *   Q5  framework hosts DO reach us, flagged `isFramework`. We filter anyway (below),
 *       because trusting an upstream flag for a correctness-critical filter is worse than
 *       one redundant check.
 *
 * And one the questions did not think to ask: `errored` is null for the same reason as
 * `queued` — `iris_interop_messages_errored` is also per-production (#31). Unlike
 * `queued` there is no per-production total published at all, so the figure is simply
 * absent rather than relocated.
 */

/**
 * A count that may be unmeasurable. `null` means "IRIS does not expose this per host",
 * NOT "zero" — the distinction matters because a rule must stay silent rather than
 * compare against a fabricated 0.
 */
export type NullableCount = number | null;

/** One host as the proxy reports it. */
export interface ProxyHost {
  /** Config item name, e.g. "Lab Router". A display name, so it contains spaces. */
  host: string;
  /** Normalized by the proxy: 'service' | 'process' | 'operation' | 'unknown'. */
  type: string;
  /** Raw IRIS status, passed through. `Unknown` when no status line was emitted. */
  status: string;
  /** The proxy's own view of whether this is framework infrastructure. Advisory. */
  isFramework: boolean;
  /** null — not exposed per host by IRIS. See #12 and `_meta.productionQueued`. */
  queued: NullableCount;
  messages: NullableCount;
  messagesPerSec: NullableCount;
  /** null — not exposed per host by IRIS. See #31; no production total is published. */
  errored: NullableCount;
  /** Seconds, aggregated across message types weighted by sample count (Q3). */
  avgProcessingTime: NullableCount;
  /** Seconds, aggregated the same way. */
  avgQueueingTime: NullableCount;
  /** ISO 8601, computed by the proxy as `polledAt - elapsed`. null if no activity line. */
  lastActivity: string | null;
  /** Raw elapsed seconds as IRIS emits it. We prefer this and derive our own timestamp. */
  lastActivityElapsedSeconds: NullableCount;
}

/** One entry from `/api/monitor/alerts`, forwarded on `GET /proxy/alerts`. */
export interface ProxyAlert {
  /** As IRIS emits it. Deliberately not pattern-constrained — upstream's format. */
  time: string;
  /** A NUMERIC STRING ('2'), not a word. Mapping it to a severity is our decision. */
  severity: string;
  message: string;
  /** When the proxy first saw it. Present on newer proxy builds. */
  observedAt?: string;
}

/** What the engine consumes each poll, assembled from BOTH proxy endpoints. */
export interface ProxyResponse {
  /** When the proxy sampled IRIS, from `_meta.polledAt`. */
  sampledAt: string;
  production: string;
  hosts: ProxyHost[];
  alerts: ProxyAlert[];
  /** True while the proxy has polled nothing yet — serve empty, do not treat as an error. */
  warming: boolean;
  /** Production-wide queue depth, since it is not available per host. */
  productionQueued: NullableCount;
}

/** What the engine reads metrics from. Both real and mock clients satisfy it. */
export interface ProxyClient {
  fetchMetrics(signal?: AbortSignal): Promise<ProxyResponse>;
}

/**
 * Framework hosts that must never reach the findings API.
 *
 * The proxy now flags these itself as `isFramework`, and we still check independently.
 * Two reasons: a prefix test is cheap, and the upstream flag is derived from the item
 * name rather than the class name — which is exactly how `Ens.ActivityReporter` leaked
 * once before (#10). Believing a single upstream flag for a correctness-critical filter
 * is worse than running a redundant test.
 */
const FRAMEWORK_HOST_PREFIXES: readonly string[] = ['Ens.', 'EnsLib.'] as const;

/** True when a host is IRIS framework infrastructure rather than an application host. */
export function isFrameworkHost(name: string): boolean {
  return FRAMEWORK_HOST_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A metric value we can use, or null.
 *
 * NaN and Infinity are rejected rather than passed through: the proxy maps Prometheus
 * `NaN`/`+Inf` to null already, so this is the belt to that braces — a number that
 * breaks arithmetic silently is worse than an absent one.
 */
export function isNullableCount(value: unknown): value is NullableCount {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Runtime shape validation at the process boundary.
 *
 * Log-and-skip a malformed host rather than rejecting the whole payload: one bad entry
 * should not blind us to the others. The previous version demanded a finite `queued` and
 * a `messagesErrored` field, so it rejected **every** real host and the engine reported
 * zero — a blank dashboard rather than a degraded one (#32). Nullable counts are now
 * accepted as unknown, which is what they are.
 *
 * `isFramework` is deliberately NOT required: it is advisory, we filter by prefix
 * ourselves, and an older proxy build that omits it should still be consumable.
 */
export function isProxyHost(value: unknown): value is ProxyHost {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h['host'] === 'string' &&
    h['host'].length > 0 &&
    typeof h['type'] === 'string' &&
    typeof h['status'] === 'string' &&
    isNullableCount(h['queued']) &&
    isNullableCount(h['messages']) &&
    isNullableCount(h['messagesPerSec']) &&
    isNullableCount(h['errored']) &&
    isNullableCount(h['avgProcessingTime']) &&
    isNullableCount(h['avgQueueingTime']) &&
    isNullableCount(h['lastActivityElapsedSeconds'])
  );
}

export function isProxyAlert(value: unknown): value is ProxyAlert {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a['time'] === 'string' &&
    typeof a['severity'] === 'string' &&
    typeof a['message'] === 'string'
  );
}
