/**
 * Fetches Dev B's findings API.
 *
 * Base URL comes from `VITE_HEALTHSCAN_BASE_URL`, defaulting to the relative
 * `/api/healthscan` that the Vite dev proxy forwards to `:3002`. Dev B sends
 * `Access-Control-Allow-Origin: *` (§4 Q9), so the proxy is optional — kept as the
 * default anyway, since it also means Dev B's language never matters here.
 */

import type { HealthScanApi } from './HealthScanApi';
import { parseFindings, parseHosts } from './guards';
import type { FindingView, HostView } from '../types/healthscan';

const DEFAULT_BASE_URL = '/api/healthscan';

function baseUrl(): string {
  const configured = import.meta.env.VITE_HEALTHSCAN_BASE_URL;
  const value = configured === undefined || configured.length === 0 ? DEFAULT_BASE_URL : configured;
  // Trailing slashes would produce `//findings`, which some routers 404.
  return value.replace(/\/+$/, '');
}

/** Raised for anything the operator should see in the connection banner. */
export class HealthScanRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'HealthScanRequestError';
    this.status = status;
  }
}

/**
 * Empty is `200` + `[]`, never `404`, including during engine startup (§3, §4 Q7).
 * The 404-to-empty mapping below is therefore dead against a conforming engine —
 * kept because it costs one line and a wrong 404 reading as an outage mid-demo
 * costs more. Only a genuine transport or server failure raises.
 *
 * `X-Healthscan-State: warming | stale` is advisory and deliberately ignored: the
 * dashboard already derives warm-up from `baselineValue: null` and staleness from
 * its own `lastSuccessAt` clock, and a header would give it a second, disagreeing
 * source of truth for the same banner.
 */
async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    // Propagate aborts untouched — the caller owns them.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new HealthScanRequestError('Cannot reach the Health Scan API', null);
  }

  if (response.status === 404) return [];

  if (!response.ok) {
    /* When the target is down the Vite dev proxy answers 500 with an empty body
       (verified), and a real gateway would answer 502/504. Reporting either as
       an API error would send whoever is debugging to Dev B's logs when the
       service is simply not running, so an empty error body is treated as
       "unreachable" rather than "the API failed". */
    const body = await response.text().catch(() => '');
    const gateway = response.status === 502 || response.status === 503 || response.status === 504;
    const unreachable = gateway || (response.status === 500 && body.trim().length === 0);

    throw new HealthScanRequestError(
      unreachable
        ? 'The Health Scan API is not responding'
        : `Health Scan API returned ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new HealthScanRequestError('Health Scan API returned malformed JSON', response.status);
  }
}

export function createLiveClient(): HealthScanApi {
  return {
    async getHosts(signal?: AbortSignal): Promise<HostView[]> {
      return parseHosts(await getJson('/hosts', signal));
    },

    async getFindings(signal?: AbortSignal): Promise<FindingView[]> {
      return parseFindings(await getJson('/findings', signal));
    },
  };
}
