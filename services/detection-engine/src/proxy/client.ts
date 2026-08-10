/**
 * HTTP client for Dev A's metrics proxy (:3001).
 *
 * Validates at the process boundary and log-and-skips malformed hosts rather than
 * rejecting a whole payload — one bad entry should not blind us to the other three.
 */

import type { ProxyClient, ProxyResponse } from '../types/proxy.ts';
import { isProxyAlert, isProxyHost } from '../types/proxy.ts';

export class HttpProxyClient implements ProxyClient {
  readonly #baseUrl: string;
  readonly #log: (msg: string) => void;

  constructor(baseUrl: string, log: (msg: string) => void = console.error) {
    this.#baseUrl = baseUrl;
    this.#log = log;
  }

  async fetchMetrics(signal?: AbortSignal): Promise<ProxyResponse> {
    const url = `${this.#baseUrl.replace(/\/$/, '')}/api/metrics`;
    const response = await fetch(url, signal === undefined ? {} : { signal });
    if (!response.ok) {
      throw new Error(`proxy returned HTTP ${response.status} for ${url}`);
    }
    return this.#parse(await response.json());
  }

  #parse(payload: unknown): ProxyResponse {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('proxy payload is not an object');
    }
    const body = payload as Record<string, unknown>;

    const rawHosts = Array.isArray(body['hosts']) ? body['hosts'] : [];
    const hosts = [];
    for (const candidate of rawHosts) {
      if (isProxyHost(candidate)) {
        hosts.push(candidate);
      } else {
        this.#log(`skipping malformed proxy host entry: ${JSON.stringify(candidate)}`);
      }
    }

    const rawAlerts = Array.isArray(body['alerts']) ? body['alerts'] : [];
    const alerts = rawAlerts.filter(isProxyAlert);

    return {
      sampledAt: typeof body['sampledAt'] === 'string' ? body['sampledAt'] : new Date().toISOString(),
      production: typeof body['production'] === 'string' ? body['production'] : 'unknown',
      hosts,
      alerts,
    };
  }
}
