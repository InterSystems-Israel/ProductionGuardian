/**
 * HTTP client for Dev A's metrics proxy (:3001).
 *
 * Reads BOTH proxy endpoints per poll and assembles one `ProxyResponse`:
 *
 *   GET /proxy/metrics  ->  { hosts[], warming?, _meta }
 *   GET /proxy/alerts   ->  { alerts[], warming?, _meta }
 *
 * The previous version requested `/api/metrics` — which does not exist, so live mode
 * 404'd — and looked for `alerts` inside the metrics body, where they never appear.
 * That alone made `system_alert` unable to fire live, independently of #31 (#32).
 *
 * Validates at the process boundary and log-and-skips malformed entries rather than
 * rejecting a whole payload: one bad host should not blind us to the others.
 *
 * Alerts are fetched best-effort. A metrics poll that succeeds while the alerts endpoint
 * fails still yields usable host data, and losing `system_alert` for one cycle is a much
 * smaller loss than reporting the whole production as unreachable.
 */

import type {
  NullableCount,
  ProxyAlert,
  ProxyClient,
  ProxyHost,
  ProxyResponse,
} from '../types/proxy.ts';
import { isNullableCount, isProxyAlert, isProxyHost } from '../types/proxy.ts';

export class HttpProxyClient implements ProxyClient {
  readonly #baseUrl: string;
  readonly #log: (msg: string) => void;

  constructor(baseUrl: string, log: (msg: string) => void = console.error) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#log = log;
  }

  async fetchMetrics(signal?: AbortSignal): Promise<ProxyResponse> {
    const metrics = await this.#getJson('/proxy/metrics', signal);
    const alerts = await this.#getAlerts(signal);
    return this.#assemble(metrics, alerts);
  }

  /** Throws on failure — a metrics poll we cannot read is a failed poll. */
  async #getJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = `${this.#baseUrl}${path}`;
    const response = await fetch(url, signal === undefined ? {} : { signal });
    if (!response.ok) {
      throw new Error(`proxy returned HTTP ${response.status} for ${url}`);
    }
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null) {
      throw new Error(`proxy payload from ${path} is not an object`);
    }
    return payload as Record<string, unknown>;
  }

  /** Best-effort: returns an empty body rather than throwing. See the header note. */
  async #getAlerts(signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return await this.#getJson('/proxy/alerts', signal);
    } catch (err) {
      if (signal?.aborted === true) throw err;
      this.#log(`alerts unavailable this poll, continuing without them: ${message(err)}`);
      return {};
    }
  }

  #assemble(
    metrics: Record<string, unknown>,
    alertsBody: Record<string, unknown>,
  ): ProxyResponse {
    const meta = asRecord(metrics['_meta']);

    const hosts: ProxyHost[] = [];
    for (const candidate of asArray(metrics['hosts'])) {
      if (isProxyHost(candidate)) {
        hosts.push(candidate);
      } else {
        this.#log(`skipping malformed proxy host entry: ${JSON.stringify(candidate)}`);
      }
    }

    const alerts: ProxyAlert[] = [];
    for (const candidate of asArray(alertsBody['alerts'])) {
      if (isProxyAlert(candidate)) {
        alerts.push(candidate);
      } else {
        this.#log(`skipping malformed proxy alert entry: ${JSON.stringify(candidate)}`);
      }
    }

    // `warming` on either endpoint means the proxy has nothing yet. Distinct from
    // unreachable: we serve empty and report `warming`, not `stale`.
    const warming = metrics['warming'] === true || alertsBody['warming'] === true;

    return {
      sampledAt: asString(meta['polledAt']) ?? new Date().toISOString(),
      production: asString(meta['production']) ?? 'unknown',
      hosts,
      alerts,
      warming,
      productionQueued: asNullableCount(meta['productionQueued']),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Absent and unmeasurable both collapse to null — neither is a usable number. */
function asNullableCount(value: unknown): NullableCount {
  return isNullableCount(value) ? value : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
