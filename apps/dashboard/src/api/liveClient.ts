/**
 * Fetches Dev B's findings API.
 *
 * Base URL comes from `VITE_HEALTHSCAN_BASE_URL`, defaulting to the relative
 * `/api/healthscan` that the Vite dev proxy forwards to `:3002`. Dev B sends
 * `Access-Control-Allow-Origin: *` (§4 Q9), so the proxy is optional — kept as the
 * default anyway, since it also means Dev B's language never matters here.
 */

import type { HealthScanApi } from './HealthScanApi';
import type {
  ChatAnswerView,
  ChatTurnView,
  HostProjectionView,
  InvestigationView,
  ResolveActionView,
  ResolveMode,
  ResolveView,
} from '../types/mvp2';
import { parseChatAnswer, parseInvestigation, parseProjections, parseResolve } from './mvp2Guards';
import { parseHostSeries } from './seriesGuards';
import { parseThresholdSettings } from './settingsGuards';
import { parseFindings, parseHosts } from './guards';
import type { FindingView, HostView } from '../types/healthscan';
import type { HostSeriesView } from '../types/hostseries';
import type { ThresholdSettingsView } from '../types/settings';

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

/**
 * POST for the two MVP 2 endpoints.
 *
 * SEPARATE FROM getJson BECAUSE THE 404 MAPPING WOULD BE WRONG HERE. getJson turns 404 into `[]`,
 * which is a deliberate belt-and-braces for the list endpoints. On a write endpoint a 404 means the
 * route or the IRIS dispatcher is missing -- exactly the failure that took the whole MVP 2 write
 * path down until `/labdemo/agent` was registered at boot -- and swallowing it would hide that.
 *
 * `baseUrl()` points at `/api/healthscan`, so these strip back one level: the MVP 2 endpoints are
 * siblings of it (`/api/investigate`, `/api/resolve`), not children.
 */
async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const root = baseUrl().replace(/\/healthscan\/?$/, '');
  let response: Response;
  try {
    response = await fetch(`${root}${path}`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new HealthScanRequestError('Cannot reach the Health Scan API', null);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    /* The engine answers 503 for an endpoint that exists in this build but is not configured on
       this deployment -- "no agent wired here" -- and that is a different fact from a fault. Named
       explicitly so the panel can say which, rather than showing a generic failure for a stack
       that is working as configured. */
    if (response.status === 503) {
      throw new HealthScanRequestError(
        'This deployment has no AI agent configured (the engine answered 503)',
        503,
      );
    }
    /* A 400 carries a reason worth surfacing verbatim: the engine returns
       `{"error":"bad request: ..."}` for a malformed action, and that message names the field. */
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      detail = '';
    }
    throw new HealthScanRequestError(
      detail.length > 0 ? detail : `Health Scan API returned ${response.status}`.trim(),
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new HealthScanRequestError('Health Scan API returned malformed JSON', response.status);
  }
}

/** getJson, but for a path that is NOT under the healthscan base. Same error mapping. */
async function getJsonAbsolute(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new HealthScanRequestError('Cannot reach the Health Scan API', null);
  }
  // 404 -> empty, matching getJson: an engine build without this endpoint should degrade to "no
  // projections" rather than break the host grid it is decorating.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new HealthScanRequestError(`Health Scan API returned ${response.status}`.trim(), response.status);
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

    async getProjections(signal?: AbortSignal): Promise<HostProjectionView[]> {
      /* Sibling of /api/healthscan, not a child -- same one-level strip as the POSTs. Uses getJson
         so an engine that has not warmed up yet yields [] rather than an error banner. */
      const root = baseUrl().replace(/\/healthscan\/?$/, '');
      return parseProjections(await getJsonAbsolute(`${root}/earlywarning`, signal));
    },

    async getHostSeries(host: string, signal?: AbortSignal): Promise<HostSeriesView | null> {
      /* Sibling of /api/healthscan, like /api/earlywarning -- same one-level strip.
         `encodeURIComponent`, not a template literal: every LABDEMO host name contains a space
         ("Cloud API", "Lab Router"), and an unencoded one would either 400 at the engine or, worse,
         arrive truncated and answer 200 for a host nobody asked about. */
      const root = baseUrl().replace(/\/healthscan\/?$/, '');
      const url = `${root}/hostseries?host=${encodeURIComponent(host)}`;
      /* getJsonAbsolute maps 404 to `[]`, which is meant for the list endpoints and is the wrong
         shape here -- so the parser sees a non-record and returns null, which is exactly the
         "engine predates this endpoint" answer this method promises. Checked rather than assumed,
         because relying on a coincidence between two files is how the #129 class of bug starts. */
      return parseHostSeries(await getJsonAbsolute(url, signal));
    },

    async investigate(findingId: string, signal?: AbortSignal): Promise<InvestigationView> {
      const parsed = parseInvestigation(await postJson('/investigate', { findingId }, signal));
      if (parsed === null) {
        throw new HealthScanRequestError('The investigation response could not be read', null);
      }
      return parsed;
    },

    async resolve(
      mode: ResolveMode,
      action: ResolveActionView,
      origin: { findingId: string },
      signal?: AbortSignal,
    ): Promise<ResolveView> {
      /* `requestedBy` is an advisory label recorded NEXT TO the server-resolved actor, never in
         place of it (resolve-api.md §8) -- a caller cannot name itself. Sent so the audit row shows
         which surface asked, which is the only thing the browser can honestly contribute. */
      const parsed = parseResolve(
        await postJson('/resolve', { mode, action, origin, requestedBy: 'dashboard' }, signal),
      );
      if (parsed === null) {
        throw new HealthScanRequestError('The resolve response could not be read', null);
      }
      return parsed;
    },

    async ask(
      question: string,
      history: ChatTurnView[],
      signal?: AbortSignal,
    ): Promise<ChatAnswerView> {
      /* Sibling of /api/healthscan, like the other two POSTs -- `postJson` strips the one level. It
         also does NOT map 404 to an empty result, which matters here for the same reason it does for
         `/resolve`: a 404 means the route or the IRIS dispatcher is missing, which is exactly the
         failure that took the MVP 2 write path down until `/labdemo/agent` was registered at boot,
         and swallowing it would hide it again. */
      const parsed = parseChatAnswer(await postJson('/chat', { question, history }, signal));
      if (parsed === null) {
        throw new HealthScanRequestError('The chat response could not be read', null);
      }
      return parsed;
    },

    async getThresholdSettings(signal?: AbortSignal): Promise<ThresholdSettingsView | null> {
      /* Sibling of /api/healthscan, like /api/earlywarning -- same one-level strip. `getJsonAbsolute`
         maps 404 to `[]`, which is the wrong shape here and is exactly what makes an engine
         predating this endpoint parse to null: the guard sees a non-record and says so. Relied on
         deliberately rather than by coincidence -- see `getHostSeries` for the same note. */
      const root = baseUrl().replace(/\/healthscan\/?$/, '');
      return parseThresholdSettings(await getJsonAbsolute(`${root}/settings/thresholds`, signal));
    },

    async applyThresholdSettings(
      values: Record<string, number>,
      signal?: AbortSignal,
    ): Promise<ThresholdSettingsView> {
      /* `postJson` is the right helper here and `getJsonAbsolute` would not be: it does NOT map 404
         to an empty result, and it lifts the engine's `{"error": "..."}` body into the thrown
         message. That body carries `validateConfig`'s own problem string, which is the reason the
         panel can show why a value was refused without inventing wording for it. */
      const parsed = parseThresholdSettings(await postJson('/settings/thresholds', { values }, signal));
      if (parsed === null) {
        throw new HealthScanRequestError('The settings response could not be read', null);
      }
      return parsed;
    },

    async resetThresholdSettings(signal?: AbortSignal): Promise<ThresholdSettingsView> {
      // An empty object rather than no body: `readJsonBody` rejects an empty body as
      // `bad request`, and reset must not be refusable on a technicality.
      const parsed = parseThresholdSettings(
        await postJson('/settings/thresholds/reset', {}, signal),
      );
      if (parsed === null) {
        throw new HealthScanRequestError('The settings response could not be read', null);
      }
      return parsed;
    },
  };
}
