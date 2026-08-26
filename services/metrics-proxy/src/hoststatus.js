'use strict';

// The one host-type vocabulary mapping, shared rather than copied — the raw IRIS words
// this endpoint reports (`BusinessOperation`, `Actor`, …) are folded there alongside the
// `hosttype` label values, so the two sources cannot drift into two vocabularies.
const { _hostType } = require('./parser');

/** The published `type` vocabulary. `unknown` is deliberately not in it — see typeOrNull. */
const PUBLISHED_TYPES = new Set(['service', 'operation', 'process']);

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
 *
 * IT ALSO SUPPLIES `type`, FOR THE SAME REASON
 *
 * The `hosttype` label rides only on the avg_* metric families, so a host that nothing
 * has flowed through carries no type at all and `type` stayed `'unknown'` — 8 of 12 hosts
 * on the live instance (#127). `EnumerateHostStatus` has a `Type` column for every host it
 * enumerates, activity or not, so the endpoint publishes it as `hostType` and it is folded
 * in here.
 *
 * Reading the production's own configuration is not the same as guessing from the host
 * name (`parser.test.js`'s 'leaves type unknown rather than guessing it'), so the fill is
 * strictly additive: it lands ONLY where the metrics-derived type is still `'unknown'`,
 * and never overwrites a known one. That makes the change incapable of regressing a type
 * that was already right, and it keeps the metrics text authoritative for `type` in the
 * same way `EnumerateHostStatus` is authoritative for `status`.
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
      // Normalized to the published vocabulary here, at the boundary, so the raw IRIS
      // word never reaches a consumer. `null` — not `'unknown'` — when the endpoint sent
      // no type (an older dispatcher predating #127, or an empty `Type` column): the
      // merge must be able to tell "this source has no opinion" from "this source says
      // it is untyped", and only the first should leave the metrics value standing.
      hostType: typeOrNull(entry.hostType),
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
 * A raw IRIS host-type word → the published vocabulary, or null.
 *
 * Null covers both "the field was absent" and "the word was one this build does not
 * recognize". Both mean the same thing to the merge — no opinion — and neither may become
 * `'unknown'`, because `'unknown'` is a value a consumer reads as a fact about the host.
 */
function typeOrNull(value) {
  if (typeof value !== 'string' || value === '') return null;
  const mapped = _hostType({ hosttype: value });
  return mapped === 'unknown' ? null : mapped;
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
  let typesFilled = 0;
  const typeDisagreements = [];

  const hosts = snapshot.hosts.map((host) => {
    const state = byHost.get(host.host);
    if (!state) return host;   // leave queued/errored null — absent is not zero
    merged += 1;

    // FILL ONLY, NEVER OVERWRITE (#127).
    //
    // The metrics `hosttype` label stays authoritative wherever it exists, so this cannot
    // regress a type that was already resolved — the only hosts it can change are the ones
    // reading `'unknown'`. Where the two sources have a type and disagree, the metrics one
    // is kept and the config one is recorded, exactly as `statusFromMetrics` below records
    // the loser of the `status` disagreement instead of dropping it. A disagreement means
    // one of the two is reading a stale or misattributed host, which is worth seeing.
    // Re-checked against the published vocabulary rather than trusted: `parseHostStatus`
    // already normalized it, but a caller can hand-build `byHost` (the tests do), and an
    // `undefined` slipping through a `!== null` test would publish `type: undefined`.
    const configType = PUBLISHED_TYPES.has(state.hostType) ? state.hostType : null;

    const fillType = configType !== null && host.type === 'unknown';
    if (fillType) typesFilled += 1;
    const typeDisagrees = configType !== null
      && host.type !== 'unknown'
      && configType !== host.type;
    if (typeDisagrees) {
      typeDisagreements.push({
        host: host.host, fromMetrics: host.type, fromConfig: configType,
      });
    }

    return {
      ...host,
      type: fillType ? configType : host.type,
      ...(typeDisagrees ? { typeFromConfig: configType } : {}),
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

  // Hosts still typed `unknown` after the fill — i.e. in the metrics text with no
  // `hosttype` label AND not described by the status endpoint (or described without a
  // `Type`). Named rather than guessed at: `Ens.Alarm` is one on the live instance, since
  // `EnumerateHostStatus` does not enumerate it. Framework hosts are included here, unlike
  // `undescribedHosts` above, because this list is about type coverage rather than about a
  // host losing its numbers.
  const untypedHosts = hosts.filter((host) => host.type === 'unknown').map((h) => h.host);

  return {
    ...snapshot,
    hosts,
    _meta: {
      ...snapshot._meta,
      hostStatus: {
        ...statusMeta,
        merged,
        unmatchedHosts,
        undescribedHosts,
        typesFilled,
        typeDisagreements,
        untypedHosts,
      },
    },
  };
}

module.exports = { parseHostStatus, mergeHostStatus };
