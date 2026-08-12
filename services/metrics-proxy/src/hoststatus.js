'use strict';

/**
 * hoststatus.js — the /labdemo/monitor/hoststatus payload → per-host state to merge.
 *
 * WHY THIS MODULE EXISTS
 *
 * Two of the eight metric fields the contract names cannot come from
 * /api/monitor/metrics at all. `iris_interop_queued` and
 * `iris_interop_messages_errored` are each emitted ONCE PER PRODUCTION, labelled
 * `id` and `production` only — neither carries a `host` label:
 *
 *   iris_interop_queued{id="LABDEMO",production="LABDEMO.Production"} 0
 *   iris_interop_messages_errored{id="LABDEMO",production="LABDEMO.Production"} 0
 *
 * So `queued` and `errored` were `null` on every host, and `queue_buildup` (#12) and
 * `elevated_error_rate` (#31) could not fire per host. The values exist in IRIS in a
 * different place — `Ens.Util.Statistics:EnumerateHostStatus` — which is what the
 * ObjectScript endpoint in `iris/labdemo/REST/HostStatusDispatcher.cls` publishes.
 *
 * THE JOIN KEY IS EXACT, BY DESIGN
 *
 * `EnumerateHostStatus`'s `Name` column and the metrics `host` label are the same
 * string, spaces intact ("Cloud API", "Lab Router"). Verified live against both
 * sources. So the merge is a plain map lookup and there is deliberately NO
 * normalization here: no trimming, no case folding, no space stripping. If a name ever
 * stops matching, that is a real change worth surfacing, not something to paper over —
 * `unmatchedHosts` reports it rather than guessing at a correspondence.
 *
 * ABSENT IS STILL NOT ZERO
 *
 * The same invariant the parser holds applies here. A host this endpoint did not
 * describe keeps `queued: null` / `errored: null` rather than becoming 0 — an
 * unmeasured host must never read as a drained one. See parser.js's header note.
 */

/**
 * Parse the host-status JSON body into a lookup keyed by host name.
 *
 * Returns a `_meta` alongside, carrying what the endpoint reported about itself and
 * what this parse made of it. A malformed body yields an empty map and a `shape` that
 * names the problem, rather than throwing — the metrics poll must not be lost because
 * this third source is broken.
 *
 * @param {string} body — raw response body from the host-status endpoint
 * @param {string} [polledAt] — ISO timestamp; defaults to now
 * @returns {{ byHost: Map<string, Object>, _meta: Object }}
 */
function parseHostStatus(body, polledAt) {
  const ts = polledAt || new Date().toISOString();
  const empty = (shape, extra) => ({
    byHost: new Map(),
    _meta: { polledAt: ts, shape, hostCount: 0, ...extra },
  });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    // Truncated: a 404 HTML page here would otherwise put a whole document in _meta.
    return empty('unparseable', { error: err.message, raw: String(body).slice(0, 200) });
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return empty(`unrecognized-${Array.isArray(payload) ? 'array' : typeof payload}`);
  }
  if (!Array.isArray(payload.hosts)) {
    // The likeliest cause is reaching a different web app that answers 200 with JSON.
    return empty('unrecognized-object', { keys: Object.keys(payload).slice(0, 20) });
  }

  const byHost = new Map();
  let skipped = 0;
  for (const entry of payload.hosts) {
    if (!entry || typeof entry !== 'object') { skipped += 1; continue; }
    if (typeof entry.host !== 'string' || entry.host === '') { skipped += 1; continue; }
    byHost.set(entry.host, {
      status: typeof entry.status === 'string' ? entry.status : null,
      queued: numberOrNull(entry.queued),
      errored: numberOrNull(entry.errored),
      messageCount: numberOrNull(entry.messageCount),
    });
  }

  const meta = payload._meta && typeof payload._meta === 'object' ? payload._meta : {};
  return {
    byHost,
    _meta: {
      polledAt: ts,
      shape: 'hosts',
      hostCount: byHost.size,
      skippedEntries: skipped,
      // Passed through from the endpoint. `productionState` is the field that separates
      // "the production is stopped" from "this production has no hosts": the underlying
      // query returns zero rows in the first case, which is otherwise indistinguishable.
      sampledAt: typeof meta.sampledAt === 'string' ? meta.sampledAt : null,
      production: typeof meta.production === 'string' ? meta.production : null,
      productionState: typeof meta.productionState === 'string' ? meta.productionState : null,
      // False when IRIS could not count errors, so `errored` must stay null rather than
      // being published as a measured 0.
      erroredAvailable: meta.erroredAvailable === true,
    },
  };
}

/** Finite numbers only; anything else (null, "", a string) becomes null. */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Merge host-status values into a metrics snapshot, by exact host name.
 *
 * Mutates nothing: returns a new snapshot with the merged hosts and merge diagnostics
 * folded into `_meta`. Called with a null/absent status so the metrics snapshot is
 * published unchanged when this source is unavailable — a failed third poll must
 * degrade to the old behaviour (`queued`/`errored` null), never drop the snapshot.
 *
 * @param {Object} snapshot — output of parser.buildSnapshot()
 * @param {{byHost: Map, _meta: Object}|null} hostStatus — output of parseHostStatus()
 * @returns {Object} a new snapshot
 */
function mergeHostStatus(snapshot, hostStatus) {
  if (!snapshot) return snapshot;

  if (!hostStatus || !hostStatus.byHost || hostStatus.byHost.size === 0) {
    return {
      ...snapshot,
      _meta: {
        ...snapshot._meta,
        hostStatus: hostStatus
          ? { ...hostStatus._meta, merged: 0, unmatchedHosts: [] }
          : { shape: null, merged: 0, available: false },
      },
    };
  }

  const { byHost, _meta: statusMeta } = hostStatus;
  let merged = 0;

  const hosts = snapshot.hosts.map((host) => {
    const state = byHost.get(host.host);
    if (!state) return host;   // leave queued/errored null — absent is not zero
    merged += 1;
    return {
      ...host,
      queued: state.queued,
      // Only overwrite when the endpoint actually had counts. Otherwise the metrics
      // side's null stands, rather than being replaced by a fabricated 0.
      errored: statusMeta.erroredAvailable ? state.errored : host.errored,
      // `status` from EnumerateHostStatus is authoritative where the two disagree: it
      // reports `Disabled`, which iris_interop_hosts does not. Measured on this
      // instance: the metrics text said status="OK" for a host that was Disabled with
      // 70 messages queued. The metrics value is kept alongside rather than discarded,
      // so a disagreement stays visible instead of being silently resolved.
      status: state.status || host.status,
      ...(state.status && state.status !== host.status
        ? { statusFromMetrics: host.status }
        : {}),
    };
  });

  // Hosts the status endpoint described that the metrics text did not mention. Reported
  // rather than added: inventing a host from the second source would give it no metrics
  // at all, and `dead_host` would fire on the gap. An empty list is the normal state;
  // a non-empty one means the two sources disagree about what exists, which is worth
  // seeing rather than resolving here.
  const metricsHosts = new Set(snapshot.hosts.map((h) => h.host));
  const unmatchedHosts = [...byHost.keys()].filter((name) => !metricsHosts.has(name));

  // And the OTHER direction, which is the one a consumer feels: application hosts the
  // metrics text listed that the status endpoint did NOT describe. Those keep
  // `queued`/`errored` null while every other host gets real numbers.
  //
  // `merged === hostCount` cannot detect this — both counts simply shrink together, so
  // the check this meta used to recommend reports success while a host silently loses its
  // data (Dev C, #36). Framework hosts are excluded because the endpoint legitimately
  // does not enumerate all of them: on the live instance `Ens.Alarm` and
  // `Ens.MonitorService` are absent by design, so counting them would make the healthy
  // state look broken.
  const undescribedHosts = snapshot.hosts
    .filter((host) => !host.isFramework && !byHost.has(host.host))
    .map((host) => host.host);

  return {
    ...snapshot,
    hosts,
    _meta: {
      ...snapshot._meta,
      hostStatus: { ...statusMeta, merged, unmatchedHosts, undescribedHosts },
    },
  };
}

module.exports = { parseHostStatus, mergeHostStatus };
