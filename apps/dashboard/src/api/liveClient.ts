/**
 * Fetches Dev B's findings API.
 *
 * Base URL comes from `VITE_HEALTHSCAN_BASE_URL`, defaulting to the relative
 * `/api/healthscan` that the Vite dev proxy forwards to `:3002`. Going through
 * the proxy means CORS is never the dashboard's problem and Dev B can be Node or
 * Python without a change here (CONTRACT-Q9).
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
 * CONTRACT-Q7: unresolved whether an empty result is `[]` or `404`, and what the
 * API returns while the engine is still starting. Both are treated as "nothing
 * to report" so a healthy-but-empty production cannot read as an outage; only a
 * genuine transport or server failure raises.
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
