# Metrics proxy API contract

**Owner:** Dev A (moved on; maintained by Dev B) · **Consumer:** Dev B · **Port:** `3001` ·
**Status:** published

Three read-only endpoints. The proxy polls the IRIS built-in `/api/monitor/` API, parses the
Prometheus text format, and republishes it as per-host JSON. **It forwards and reshapes; it does
not detect, threshold, or judge.** Baseline comparison and findings are the detection engine's job
(`healthscan-api.md`).

It also polls **one endpoint outside `/api/monitor/`** — a small read-only REST wrapper in the
LABDEMO namespace supplying per-host queue depth and error counts, which the Prometheus text does
not carry at all. See §1.3; that is the only non-built-in dependency.

Machine-readable: `proxy.schema.json`.
Shared fixture: `samples/metrics-dump.txt` — the raw IRIS `/api/monitor/metrics` body every
snapshot in this document was derived from. Feed it to `src/parser.js` and you get the values
quoted here.

> **The sample's HOST ROSTER is not the part it is authoritative for.** `metrics-dump.txt` is a
> real capture, and every label *shape* and metric *family* in it is canonical — that is what
> this document is derived from and what your parser must handle. But its four application
> hosts come from a **different production**, whose class tree does not exist in this repo.
>
> Two facts settle that from the repo alone, no instance access needed (#34):
>
> ```
> $ grep -o 'production="[^"]*"' contracts/samples/metrics-dump.txt | sort -u
> production="LABDEMO.Production"
> ```
>
> `iris/labdemo/Production.cls` has been `Class ProductionGuardian.LabDemo.Production` in
> **every commit of its history**, first commit included. And the sample's host names are a
> combination this repo never produced: when a FHIR Transform item existed here the names were
> **unspaced** (`EMRSource`, `LabRouter`, `FHIRTransform`), and the spaced names arrived only
> *after* that item had been removed. The sample carries spaced names **and** `FHIR Transform`
> together.
>
> So `_meta.applicationHostCount: 4` is a true reading of a production we do not ship, and it
> disagrees with `samples/hosts-response.json`'s 3 for that reason and no other. **Neither is
> wrong.**
>
> **What is NOT claimed:** that a FHIR Transform host was never ours. It was — as
> `<Item Name="FHIRTransform">` from the first commit until `1801a50`, when the pipeline became
> HL7→PID. The narrow, provable claim is that **this capture** did not come from this repo's
> production.
>
> `iris/labdemo/Production.cls` is authoritative for the roster, and
> `services/metrics-proxy/fixtures/metrics-live-capture-3host.txt` is the first capture taken
> from it. Do not derive a host count, or a claim about what LABDEMO has ever contained, from
> this sample.

**Published by Dev B on Dev A's behalf.** Dev A has moved to other work; this contract is derived
from their merged code (`services/metrics-proxy/`) rather than authored alongside it, so it
documents what the proxy *does* today, not an intent. Where the code and Dev B's engine disagree,
§6 names it rather than resolving it silently.

---

## 1. `GET /proxy/metrics`

The latest metric snapshot. One entry per interoperability host IRIS reported, plus per-production
scalars and diagnostics.

```json validate=proxy.schema.json#/definitions/MetricsResponse
{
  "hosts": [
    {
      "host": "Lab Router",
      "type": "process",
      "status": "OK",
      "isFramework": false,
      "queued": 0,
      "messages": 54360,
      "messagesPerSec": 1.2,
      "errored": 0,
      "avgProcessingTime": 0.08,
      "avgQueueingTime": 0,
      "lastActivity": "2026-08-12T11:07:12.944Z",
      "lastActivityElapsedSeconds": 1.149
    }
  ],
  "systemAlertsNew": 0,
  "systemAlertsLog": 1,
  "_meta": {
    "polledAt": "2026-08-12T11:07:14.093Z",
    "production": "LABDEMO.Production",
    "productionQueued": 0,
    "absentFamilies": [],
    "hostCount": 15,
    "applicationHostCount": 4,
    "hostStatus": {
      "polledAt": "2026-08-12T11:07:14.094Z",
      "shape": "hosts",
      "hostCount": 13,
      "skippedEntries": 0,
      "sampledAt": "2026-08-12T11:07:14.108Z",
      "production": "LABDEMO.Production",
      "productionState": "Running",
      "erroredAvailable": true,
      "merged": 13,
      "unmatchedHosts": []
    }
  }
}
```

Those are measured values, not illustrative ones — captured from `GET /proxy/metrics` running
against live LABDEMO on 2026-08-12. The label shapes behind them are pinned by
`samples/metrics-dump.txt`; `queued`, `errored` and `_meta.hostStatus` come from the host-status
endpoint described in §1.3, which that capture predates.

**`queued: 0` and `errored: 0` here are measurements, not placeholders** — this is a healthy
production that drains immediately. Before §1.3's endpoint existed they were `null`.

### 1.1 Host fields

| Field | Type | Notes |
|---|---|---|
| `host` | string | Config item name, exactly as the IRIS `host` label carries it. **The join key** — see Q1. |
| `type` | string | `service` \| `process` \| `operation` \| `unknown`. Normalized, from **two** sources in precedence order — see Q6. |
| `status` | string | The IRIS `status` label, passed through. `Unknown` when IRIS sent no `iris_interop_hosts` line. Enum in Q7. |
| `isFramework` | boolean | `true` for IRIS's own plumbing. Flag, not a filter — see Q5. |
| `queued` | number \| null | Per-host queue depth. **A measured number when the host-status endpoint answered**, `null` when it did not — see Q2 and §6.1. |
| `messages` | number \| null | Cumulative messages since production start. |
| `messagesPerSec` | number \| null | Throughput over the IRIS sampling window. |
| `errored` | number \| null | Cumulative errored count. **A measured number when the host-status endpoint answered**, `null` when it did not — see Q8. |
| `avgProcessingTime` | number \| null | **Seconds.** Aggregated across message types — see Q3. |
| `avgQueueingTime` | number \| null | **Seconds.** Aggregated across message types — see Q3. |
| `lastActivity` | string \| null | ISO 8601 UTC, `Z`-suffixed. Derived — see Q4. |
| `lastActivityElapsedSeconds` | number \| null | Seconds since last activity, as IRIS gives it — see Q4. |
| `statusFromMetrics` | string | **Optional, present only when the two status sources disagree** — see §1.3. |
| `typeFromConfig` | string | **Optional, present only when the two type sources disagree** — see Q6 and §1.3. Diagnostic; `type` stays the value to read. |

Hosts are in stable alphabetical order by `host` (`localeCompare`), matching the findings API so
the dashboard never reorders rows between polls.

**`null` means IRIS reported no series. `0` means IRIS measured zero.** This distinction is the
single most important thing in this contract and it is not cosmetic: on the instance behind
`fixtures/metrics-live-capture.txt`, IRIS emitted **no `iris_interop_messages_errored` and no
`iris_interop_last_activity` lines at all** — the families were absent, not zero-valued. Publishing
`0` there would make `elevated_error_rate` structurally unable to fire while looking like a
measurement, and nothing would say why. `_meta.absentFamilies` names what IRIS did not send.

Consumers must therefore treat every numeric host field as nullable and **skip a rule rather than
substitute a value.** A rule fed a fabricated zero reports on data that does not exist.

### 1.2 Top-level and `_meta` fields

| Field | Type | Notes |
|---|---|---|
| `hosts` | array | Possibly empty. Never absent. |
| `systemAlertsNew` | number \| null | `iris_system_alerts_new`. **Consume-on-read** — reads `0` almost always, see §2. |
| `systemAlertsLog` | number \| null | `iris_system_alerts_log`. Durable count from `alerts.log`; does not reset on read. |
| `warming` | boolean | **Present and `true` only before the first poll completes.** Absent otherwise — see §4. |
| `_meta.polledAt` | string \| null | ISO 8601 UTC. When the proxy sampled IRIS. `null` while warming. |
| `_meta.production` | string \| null | Production name, e.g. `LABDEMO.Production`. `null` if IRIS sent no `production` label. |
| `_meta.productionQueued` | number \| null | `iris_interop_queued` — the **per-production** total. The only real queue number available today, see Q2. |
| `_meta.absentFamilies` | string[] | Tracked metric families IRIS did not emit. Diagnostics, not data. |
| `_meta.hostCount` | number | `hosts.length`, framework included. |
| `_meta.applicationHostCount` | number | Hosts with `isFramework: false`. |
| `_meta.hostStatus` | object | How the per-host `queued`/`errored` merge went this poll — see §1.3. Absent while warming. |

**`_meta` is diagnostics, not payload.** `absentFamilies` exists so a consumer can distinguish
"unmeasurable on this instance" from "measured zero"; it is not something to build a finding on.

### 1.3 Where `queued`, `errored` and most of `type` come from — a third source

**Neither value is in `/api/monitor/metrics`.** `iris_interop_queued` and
`iris_interop_messages_errored` are each emitted **once per production**, labelled `id` and
`production` only, with no `host` label — asserted against the capture by two of the checks in
`validate.mjs`. So for as long as the proxy read only the Prometheus text, `queued` and `errored`
were `null` on every host and `queue_buildup` (#12) and `elevated_error_rate` (#31) could not fire.

They now come from a small **read-only** REST endpoint in the LABDEMO namespace,
`GET /labdemo/monitor/hoststatus` (`iris/labdemo/REST/HostStatusDispatcher.cls`), which wraps
`Ens.Util.Statistics:EnumerateHostStatus` and adds per-host error counts from `Ens.MessageHeader`.
The proxy polls it **on the metrics interval, concurrently**, and merges by host name before
caching the snapshot.

The same endpoint also supplies **`hostType`**, which fills `type` for hosts the `avg_*` families
never mention — see §5.1.1. That column was in the query's result set from the start and thrown away
until #127; the payload example above predates the field, so it shows neither `hostType` nor the
three `typesFilled`/`typeDisagreements`/`untypedHosts` keys.

**The join key is exact and deliberately unnormalized.** `EnumerateHostStatus`'s `Name` column and
the metrics `host` label are the same string, spaces intact (`Cloud API`, `Lab Router`) — verified
against both sources on the same instance. The proxy does no trimming, case folding or space
stripping: a name that stops matching is a real change (a rename), and silently mapping `CloudAPI`
onto `Cloud API` would attribute one host's queue depth to another. Divergence is **reported** as
`unmatchedHosts` rather than guessed at.

`_meta.hostStatus`:

| Field | Notes |
|---|---|
| `shape` | `hosts` on success; `unparseable`, `unrecognized-object`, `unrecognized-array` otherwise; `null` when not polled. Anything but `hosts` means every `queued`/`errored` is `null` for a **configuration** reason. |
| `merged` | How many hosts received values. |
| `hostCount` | How many hosts the endpoint described, before matching. |
| `unmatchedHosts` | Hosts the endpoint named that the metrics text did not. Empty is normal. |
| `undescribedHosts` | **Application** hosts the metrics text named that the endpoint did **not** describe — the direction a consumer feels, since those keep `queued`/`errored` `null` while others get numbers. Empty is normal. |
| `skippedEntries` | Entries with no usable host name. |
| `sampledAt` | When IRIS sampled host state, per the endpoint. Distinct from `polledAt`. |
| `production`, `productionState` | `productionState` is `Running` \| `Stopped` \| `Suspended` \| `Troubled` \| `Unknown`. |
| `erroredAvailable` | `false` when IRIS could not count errors — `errored` then stays `null`. |
| `available` | Present and `false` only when the source was not polled or the request failed. |
| `typesFilled` | How many hosts got their `type` from this source because the `hosttype` label did not supply one. Fill-only, so this is also the exact size of the change this source can make to `type` — see Q6. |
| `typeDisagreements` | `{host, fromMetrics, fromConfig}` for hosts BOTH sources typed differently. Empty on every live sample so far; non-empty means one source is reading a stale or misattributed host. |
| `untypedHosts` | Hosts still `type: "unknown"` after the fill — neither source typed them. **Framework hosts are included here**, unlike `undescribedHosts`, because the one such host live (`Ens.Alarm`) is framework and this list is about type coverage rather than about lost numbers. |

**`merged === hostCount` is NOT a sufficient health check.** It looks correct in a failure that
matters: if one host drops out of the endpoint — a rename, or a query that missed it — both counts
shrink together and the comparison still passes, while that host alone keeps `queued: null`. Read
**`undescribedHosts`** for that case; it names the affected hosts.

Framework hosts are deliberately excluded from `undescribedHosts`, because the endpoint legitimately
omits some of them — on the live instance `Ens.Alarm` and `Ens.MonitorService` are absent by design,
and counting them would make a healthy state look broken. That is also why
`snapshot.hosts.length - merged` is not a usable check: it reads `15 - 13 = 2` while everything is
fine.

**`merged: 0` while `shape` is `"hosts"` is the failure worth watching.** The endpoint answered
correctly and *no host name matched*, so every `queued` is `null` and nothing looks broken. That is
the one case where a `null` means "the join key diverged" rather than "not measured", and it is why
these diagnostics exist rather than just the values.

**`productionState` is what separates a stopped production from an empty one.** `EnumerateHostStatus`
returns **zero rows** when the production is stopped, which in the payload alone is
indistinguishable from a production that has no hosts.

Two measured facts behind the numbers, both easy to get backwards:

- **The underlying query returns the EMPTY STRING for an idle host, not `0`.** Its shipped source
  does `If tQueueCount=0 Set tQueueCount=""`. So empty means "the counter was read and it was 0" —
  a real measured zero — and the endpoint publishes `0`. A truthiness test on that column would
  invert the meaning and report an idle host as unmeasured.
- **`errored` is `COUNT(*)` over `Ens.MessageHeader` where `Status = 8`.** `8` is `Error`, read from
  the compiled property's VALUELIST/DISPLAYLIST rather than assumed. The SQL is keyed on
  `%EXACT(TargetConfigName)` because a plain `GROUP BY TargetConfigName` returns the name
  **uppercased** (`CLOUD API`) — a `%SQLUPPER` collation artifact of the grouping key — which
  cannot be joined against the `host` label.

**Degradation is explicit.** A failed or disabled third poll leaves `queued`/`errored` as `null` and
publishes the metrics snapshot unchanged — exactly the previous behaviour, never a dropped snapshot
and never a substituted `0`. Setting `IRIS_HOSTSTATUS_PATH=` empty disables it, which is the honest
configuration for an instance where the endpoint is not deployed.

**This endpoint is Health Scan's only non-`/api/monitor/` dependency**, and it is read-only: it
reads host state and counts rows. It performs no remediation and changes no production setting —
`iris/CLAUDE.md` and the MVP scope boundary both put that in Smart Resolve.

## 2. `GET /proxy/alerts`

`/api/monitor/alerts`, forwarded.

```json validate=proxy.schema.json#/definitions/AlertsResponse
{
  "alerts": [
    {
      "time": "2026-08-10T06:40:33.420Z",
      "severity": "2",
      "message": "Failed to allocate 18402MB shared memory using large pages.  Switching to small pages.",
      "observedAt": "2026-08-12T08:45:30.264Z"
    }
  ],
  "_meta": {
    "polledAt": "2026-08-12T08:45:30.264Z",
    "shape": "array",
    "count": 2,
    "newInLastPoll": 2,
    "accumulatedSince": "2026-08-12T08:45:30.264Z",
    "droppedCount": 0,
    "consumeOnRead": true,
    "systemAlertsNew": 1,
    "systemAlertsLog": 1,
    "suspectShapeMismatch": false
  }
}
```

**Alert objects are forwarded upstream-shaped and unmodified, plus one added field.** IRIS's keys
are `time`, `severity`, `message`; `severity` is a **numeric string** (`"2"`), matching the level
column in `alerts.log`, not a word. `observedAt` is the proxy's addition — the poll that saw the
alert. IRIS alert bodies carry no unique id, so `observedAt` is what tells two identical repeated
messages apart.

The proxy does not map these onto `timestamp`/`text`/`source`. Inventing a `source` IRIS does not
supply, or deciding what `"2"` means as a word, are consumer decisions — see §6.2.

| `_meta` field | Notes |
|---|---|
| `shape` | How the upstream payload was read: `array`, `empty`, `wrapped:<key>`, `single-object`, `unparseable`, `unrecognized-object`, `unrecognized-<type>`. |
| `count` | Alerts in the buffer (total accumulated). |
| `newInLastPoll` | Alerts the last poll returned. `0` is the normal steady state. |
| `accumulatedSince` | First alerts poll of this proxy process. |
| `droppedCount` | Alerts evicted from the 500-entry buffer. Non-zero means the list is no longer complete. |
| `consumeOnRead` | Always `true`. A reminder, not a setting. |
| `suspectShapeMismatch` | `true` when metrics saw unread alerts the last alerts poll did not return. A hint toward a mapping gap, not a verdict. |
| `raw`, `keys`, `error` | Present only on an unrecognized or unparseable payload, carrying the evidence needed to fix the mapping. |

**`/api/monitor/alerts` is consume-on-read, and this shapes the endpoint.** Verified against IRIS
2024.1 on 2026-08-11: the first `GET` returned two alerts, every `GET` after it returned `[]`,
while `iris_system_alerts_log` stayed at `2` and `iris_system_alerts_new` dropped `1 → 0`. The
proxy's own poll is what clears an alert from IRIS, so nothing can re-fetch it.

Three consequences a consumer must plan around:

- **`alerts` is cumulative since proxy start, not per-poll.** A per-poll snapshot would expose an
  alert for one interval and then lose it permanently. Use `newInLastPoll` for "what is new".
- **Do not `curl` `/api/monitor/alerts` yourself.** A second reader — another proxy instance, the
  SMP, a manual curl — steals alerts from the proxy irrecoverably.
- **`systemAlertsNew` is not a useful cross-check for the buffer total.** It is the same
  consume-on-read counter, driven to `0` by our own poll. It is meaningful only against
  `newInLastPoll`, and even then the two families are polled 30 s and 10 s apart, so a transient
  disagreement is normal. Reported for diagnosis, not to assert on.

**`shape` is the field to watch.** The metrics text format is pinned by three captures; the alerts
payload is pinned by one, obtained by accident on a first-ever read. A consumer seeing
`shape: "unrecognized-object"` should read a `0` as a mapping gap, **not** as a healthy production.

## 3. `GET /proxy/health`

```json validate=proxy.schema.json#/definitions/HealthResponse
{
  "status": "ok",
  "uptime": 3.7539876,
  "lastPoll": "2026-08-12T08:45:30.237Z",
  "production": "LABDEMO.Production",
  "hostCount": 15,
  "applicationHostCount": 4
}
```

| `status` | Meaning |
|---|---|
| `starting` | No poll has completed yet. `lastPoll` is `null` and the other fields are absent. |
| `ok` | A poll completed **and** it described a production. |
| `reachable, but no interop metrics` | A poll completed and contained no `iris_interop_*` family at all. A `hint` field names the likely cause. |

**This is the endpoint a smoke test should assert on, and the third status is why.** Measured
2026-08-11: pointing the proxy at port 80 with no `IRIS_BASE_PATH` reaches the `/api/monitor/` web
app of the **`%SYS`** namespace rather than the instance's own. That answers HTTP 200 with 906
lines of perfectly real metrics and not one `iris_interop_*` family. The poll succeeds, so a
health check that only meant "a poll succeeded" said `ok` while `/proxy/metrics` reported zero
hosts — indistinguishable from a stopped production unless you already suspected the URL.

---

## 4. Errors and empty states

| Situation | Response |
|---|---|
| Proxy starting, no poll yet | `200` + empty list + **`warming: true`** on `/proxy/metrics` and `/proxy/alerts`; `status: "starting"` on `/proxy/health` |
| IRIS unreachable, no poll has ever succeeded | Same as above — `warming: true` persists |
| IRIS unreachable after a successful poll | `200` + the **last good snapshot**, unchanged. `_meta.polledAt` stops advancing |
| Production stopped / namespace not interop-enabled | `200` + `hosts: []`, and `/proxy/health` reports `reachable, but no interop metrics` |
| No alerts | `200` + `alerts: []` |
| Unknown route | `404` (Express default HTML) |

**`warming` is `200`, not `503`.** A 503 during the ~10 s startup window read to the detection
engine as "the proxy is down" and produced a spurious system-level finding on every restart
(issue #10). An empty snapshot is the honest answer: there are no hosts to report *yet*, which is
different from a failure.

**A stale snapshot is served silently.** There is no `X-Proxy-State` header and no staleness flag —
`_meta.polledAt` is the only signal, and a consumer that cares must compare it to its own clock.
This is a deliberate asymmetry with the findings API, which does label staleness
(`X-Healthscan-State: stale`): the proxy is one hop from IRIS and the engine already polls on a
known interval, so the engine is the layer that can tell "stale" from "quiet".

**No CORS headers are sent.** The proxy's only consumer is the detection engine, server-side. If a
browser ever needs to reach `:3001` directly this becomes a contract change.

---

## 5. The five PROXY-Q questions, answered

Dev B's engine holds assumptions about this output, tagged `// PROXY-Q<n>` in
`services/detection-engine/src/types/proxy.ts`. All five, plus three that surfaced while deriving
this contract from the merged code.

| # | Question | Answer |
|---|---|---|
| **Q1** | Array or object keyed by host? `status` passed through or normalized? | **Array**, under a `hosts` key, alphabetical by host. Your assumption holds. `status` is **passed through** unchanged — also as assumed. **But the field is `host`, not `name`** (Q9), and the array is nested in an object alongside `_meta`, not returned bare. |
| **Q2** | Is `queued` present per host? | **Yes, as a measured number** — as of #12's fix. `iris_interop_queued` carries no `host` label (labels are exactly `id` and `production`, verified in all three captures), so the value does **not** come from the metrics text: the proxy polls `Ens.Util.Statistics:EnumerateHostStatus` through a REST endpoint and merges by exact host name — see §1.3. `null` now means "that source was unavailable or did not describe this host", never a placeholder. `_meta.productionQueued` remains the per-production total. **`queue_buildup` can now fire per host**; note that is not the same as *having fired* — see §6.1. |
| **Q3** | Are `avg*` already aggregated, or raw per-`messagetype` series? | **Already aggregated by the proxy, weighted by `iris_interop_sample_count`.** Your assumption holds and aggregation does *not* move to the engine. IRIS emits one series per `(host, messagetype)`; `sample_count` is its own family keyed the same way, not a label, so the proxy indexes it in a pre-pass. A host with no sample-count line falls back to an unweighted mean rather than dropping out. **`sampleCount` is not published per host** (Q10) — you no longer need it, since you are not doing the weighting. |
| **Q4** | Elapsed seconds, or a pre-computed timestamp? | **Both.** `lastActivityElapsedSeconds` is IRIS's own value (elapsed seconds, e.g. `4.838` — *not* an epoch timestamp), and `lastActivity` is `polledAt − elapsed` as ISO 8601 UTC. Prefer `lastActivityElapsedSeconds` for `stalled_host`: it is the measurement, and the timestamp inherits poll-timing error (±10 s). Both are `null` when IRIS emitted no line, rather than reading as "active just now". |
| **Q5** | Are framework hosts filtered by the proxy? | **They reach you, flagged.** Your assumption holds and your own filter stays necessary. Every host carries `isFramework` (`Ens.`/`EnsLib.` prefix, plus the bare `ActivityReporter` spelling). **Filtering is not optional:** in `samples/metrics-dump.txt`, 11 of 15 hosts are framework, and `Ens.MonitorService` is one of the few with `avg_*` series — an unfiltered snapshot reports framework timings as application latency. Filter on `isFramework` rather than re-deriving the prefix rule; the metric label carries the *item* name, which has been both `ActivityReporter` and `Ens.Activity.Operation.Local`, so a prefix rule alone was never enough. |

### 5.1 Three more, found while writing this

| # | Question | Answer |
|---|---|---|
| **Q6** | `type` vocabulary | IRIS says **`actor`** (metrics label) and **`Actor`** (config); the proxy normalizes both to `process`, so no IRIS word reaches you. **`type` now comes from two sources** — see §5.1.1, which supersedes the original answer. `unknown` remains a real value, but a rare one rather than the majority case. |
| **Q7** | Exact `status` enum | `OK`, `Error`, `Inactive`, `Retry`, `Stopped`, `Unconfigured`, `Disabled`, plus **`Unknown`** when IRIS sent no `iris_interop_hosts` line for a host. **There is no `Active` and no `Warning`.** Same enum as `healthscan-api.md` Q1 with `Unknown` added, so your `dead_host` mapping needs no change. |
| **Q8** | Is `errored` per host? | **Not from the metrics text — but it is published per host now.** `iris_interop_messages_errored` carries **no `host` label** in `samples/metrics-dump.txt`: `iris_interop_messages_errored{id="LABDEMO",production="LABDEMO.Production"} 0`. It is per-production, exactly like `queued`, so that line is skipped. The value instead comes from the same host-status endpoint as `queued` (§1.3), as `COUNT(*)` over `Ens.MessageHeader` where `Status = 8` — `8` being `Error`, read from the compiled property rather than assumed. `null` when `_meta.hostStatus.erroredAvailable` is `false`. **`elevated_error_rate` can now fire per host.** See §6.3. |

#### 5.1.1 Q6 amended — `type` has a second source, and `unknown` is now rare (#127)

**What Q6 said until 2026-08-26, and what was wrong with it:** *"A host with no `avg_*` series
therefore reports `type: "unknown"`: 8 of 15 hosts in the sample, all framework. Treat `unknown` as
a real value, not a bug."*

The diagnosis was right and the conclusion did not follow. `hosttype` really does ride only on the
`avg_*` families, so a host nothing has flowed through carries no type in the Prometheus text —
**but the production knows its own item types regardless of activity**, and the proxy was already
reading the place that holds them. `Ens.Util.Statistics:EnumerateHostStatus` returns a `Type` column
for every host it enumerates; the host-status endpoint of §1.3 has run that query since #12 and
**discarded that column**. So `unknown` was a real value about the *metrics text*, and Q6 promoted it
to a fact about the *host*. Those are different claims, and only the first was measured.

`iris/labdemo/REST/HostStatusDispatcher.cls` now publishes it as **`hostType`**, carrying the raw
IRIS word unchanged — `BusinessService` | `BusinessOperation` | `BusinessProcess` | `Actor`.
Deliberately not normalized in IRIS: the instance publishes fact, the proxy owns the published
vocabulary, and one mapping in one place cannot drift out of step with itself.

**Precedence, and why it is the direction it is:**

| | Source | Wins when |
|---|---|---|
| 1 | `hosttype` label on `avg_*` | always, wherever it exists |
| 2 | `hostType` from `EnumerateHostStatus` | **only where 1 left the type `unknown`** |

The second source **fills, never overwrites.** That is what makes the change structurally incapable
of regressing a type that was already correct: the only hosts it can touch are the ones that read
`unknown`, so the worst case is that it does nothing. Where both sources have a type and they
disagree, the metrics value stays in `type` and the config value is recorded as `typeFromConfig` on
the host and in `_meta.hostStatus.typeDisagreements` — the same treatment `status` gives
`statusFromMetrics`, so a disagreement stays visible instead of being silently resolved. Empty on
every live sample taken so far.

**Measured on the running stack, 2026-08-26**, `ProductionGuardian.LabDemo.Production`, 12 hosts:

| | `type: "unknown"` |
|---|---|
| before | **8 of 12** (`Ens.Activity.Operation.Local`, `Ens.Actor`, `Ens.Alarm`, `Ens.ScheduleHandler`, `Ens.ScheduleService`, `EnsLib.Background.Process.ExportMessageSearch`, `EnsLib.Background.Service`, `EnsLib.Background.Workflow.Operation`) |
| after | **1 of 12** (`Ens.Alarm`) |

**`Ens.Alarm` stays `unknown`, and that is the honest answer rather than a gap to paper over.**
`EnumerateHostStatus` does not enumerate it — it is in the metrics text and not in the status
payload — so neither source has a type for it and nothing available would supply one without
guessing. Hosts in that position are named in **`_meta.hostStatus.untypedHosts`**, which is the
list to read rather than re-deriving it by scanning for `unknown`.

**Nothing changes for a consumer that already handled `unknown`,** and the enum is unchanged.
`unknown` is still a value the contract permits and still means what Q6 said it meant — the proxy
could not determine the type. It is now much rarer, and it no longer implies "framework host":
every framework host except `Ens.Alarm` is typed.

### 5.2 What changes for Dev B

**As first published, every one of the 15 hosts in `samples/metrics-dump.txt` was rejected by
`isProxyHost()`.** Measured, not predicted — the probe output is in that PR's body. Three
field-level mismatches, each independently sufficient to reject a host:

| # | Engine expected | Proxy publishes | Effect | Status |
|---|---|---|---|---|
| **Q9** | `name: string` | `host: string` | `name` is `undefined` → every host rejected | **fixed** in PR #33 |
| **Q8** | `messagesErrored: number` | `errored: number \| null` | `messagesErrored` is `undefined` → every host rejected | **fixed** in PR #33 |
| **Q2** | `queued: number` (finite) | `queued: number \| null` | `null` failed `isFiniteNumber` → every host rejected | **fixed both sides**: engine accepts `null` (#33), and the proxy now usually sends a number (§1.3) |

The engine side is verified on `devB/live-mode-reconcile`, not assumed: `ProxyHost` types both
fields as `NullableCount`, and `isProxyHost` gates them with `isNullableCount`, which accepts
`null` and any finite number. So **no engine change is needed for this contract amendment** — a
host with a measured `queued` satisfies the same guard that a `null` one does.

The guard log-and-skips per host, which is the right design — but when the mismatch is in a field
*every* host shares, "skip the bad entry" becomes "report zero hosts", and the dashboard shows an
empty grid with no error anywhere. **A per-entry guard cannot degrade gracefully against a
whole-payload mismatch.** Worth noting for the class of bug, not just this instance.

Two more that degrade quietly rather than rejecting:

| # | Engine expects | Proxy publishes | Effect |
|---|---|---|---|
| **Q10** | `avgProcessingTime`/`avgQueueingTime` finite | `null` for a host with no `avg_*` series | that host alone is rejected — correct, but silent. `sampleCount` is absent; unneeded per Q3 |
| **Q11** | `ProxyResponse.sampledAt`, `.production`, `.alerts` | `_meta.polledAt`, `_meta.production`; alerts on a **separate endpoint** | `HttpProxyClient` falls back to `new Date()` and `'unknown'`, and reads `body.alerts` from the metrics payload — always empty, so **`system_alert` can never fire in live mode.** Passes typecheck and every unit test; only live integration would show it |
| **Q12** | `GET {base}/api/metrics` | `GET /proxy/metrics` | `404` — no snapshot at all in live mode |

Q12 is the cheapest and the most total: one string in `src/proxy/client.ts`. Q11 needs the client
to read `_meta` and to fetch `/proxy/alerts` as a second request. **None of this is visible from
the mock**, because `mockClient.ts` reads fixtures written to the engine's own assumed shape — the
exact cost ADR 0004 names, coming due a second time. Reconciling against
`samples/metrics-dump.txt` rather than a hand-written fixture is what closes it.

**All of it is Dev B's side to change.** The proxy is the producer, its shape is verified against
live IRIS, and `contracts/` is not edited to make a consumer compile.

---

## 6. Open items — decisions, not defects

Three things this contract deliberately does not settle. Each needs a one-line change on one side
or the other, and picking a side unilaterally is how a silent contract change happens.

### 6.1 `queued` — resolved, with one thing still unverified

**Closed.** The discrepancy this section used to describe — proxy publishing `null`, engine
demanding a finite number — is settled from both ends:

- The proxy publishes a **measured number** whenever the host-status endpoint answers (§1.3), so the
  common case is no longer `null` at all.
- The engine accepts `number | null` (`isNullableCount`) and skips a rule rather than rejecting the
  host, which is what PR #33 did. Verified in
  `services/detection-engine/src/types/proxy.ts` on that branch, not assumed.

`null` is still legal and still means what it says: *this was not measured*. It is no longer a
standing state of the world, so `absent is not zero` costs nothing here now.

**What is NOT verified: that `queue_buildup` actually fires.** Two separate milestones, and only the
first is done:

1. ✅ **Wired up and returning real numbers per host.** Verified end to end against live IRIS.
2. ❓ **The finding firing.** Every `queued` observed on the live instance is `0` — the production is
   healthy and drains immediately. A non-zero depth could not be induced without disabling a host,
   which is a production change and out of bounds on a shared instance. The `70` quoted in §1.3 was
   measured earlier, on this instance, with `Cloud API` disabled.

And note Dev C's number from #16 before reading milestone 1 as milestone 2: `queue_buildup` has
`absoluteFloor: 50`, so a depth of `48` **would not trip the rule** even though it is real. Wired up
is not the same as firing.

### 6.2 `errored` vs `messagesErrored`

Raised on #16. The two names are not otherwise distinguishable, so this is a coin toss with a tie-break:

- **`errored`** matches `healthscan-api.md` §1, which is **already ratified and already rendered by
  Dev C's dashboard**. Renaming it would be a change to a published contract with a live consumer.
- **`messagesErrored`** matches the IRIS family name `iris_interop_messages_errored` and is
  arguably clearer about what is counted.

**Recommendation: `errored`, and the tie-break is blast radius, not aesthetics.** `errored` costs
one line in `services/detection-engine/src/types/proxy.ts` and its guard. `messagesErrored` costs
that plus a change to a ratified contract, its schema, its `.d.ts`, two samples and Dev C's
components — for a naming preference. See `README.md`'s "estimating what a change costs": the
question is not how many lines reference a value but whether anything *means* something in terms
of it, and `errored` already means something downstream.

This contract publishes `errored` because that is what the code emits. **It is a request for a
decision, not a decision.**

### 6.3 `errored` is per-production upstream — closed the same way as #12

**Closed**, and by the same change, as this section predicted: `EnumerateHostStatus` gave the host
list and `Ens.MessageHeader` the counts, so one endpoint closed both #12 and #31. The naming
question in §6.2 is untouched by it — the field is still `errored`, and that is still a request for
a decision rather than a decision.

The value is `COUNT(*) … WHERE Status = 8`, per host. Two details worth keeping, because both were
measured and both would have produced a plausible wrong answer:

- **`Status = 8` is `Error`.** From the compiled property: VALUELIST `,1,2,3,4,5,6,7,8,9` against
  DISPLAYLIST `,Created,Queued,Delivered,Discarded,Suspended,Deferred,Aborted,Error,Completed`.
  Filtering on `Status = 'Error'` compares against the stored code and matches nothing, silently.
- **The join key needs `%EXACT`.** A plain `GROUP BY TargetConfigName` returns the name
  **uppercased** (`CLOUD API`, `LAB ROUTER`) because the property collates with `%SQLUPPER` and the
  grouping key is what comes back. Case-folding the metrics label to compensate was tried and
  matched only 4 of 13 hosts; `%EXACT(TargetConfigName)` returns the stored spelling and joins
  directly.

Still true, and still not done: **the proxy publishes no per-production error total.**
`messages_errored` is not in `SCALAR_FAMILIES`, so that line is parsed and dropped. It matters less
now that per-host counts exist, but `_meta.productionErrored` would still be a one-line change and
would make the number visible. Left out deliberately — nothing consumes it, and this change is
already touching two contracts.

**`elevated_error_rate` can now fire per host. Whether it *has* fired is unverified**, for the same
reason as `queue_buildup` in §6.1: every host on the live instance reports `errored: 0`, because
`Ens.MessageHeader` holds 163,392 rows and **every one is `Status = 9` (Completed)**. There are no
errored messages to count. Inducing one means misconfiguring a host — a production change, out of
bounds here.

---

## 7. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by all
three developers. See `README.md` in this directory.

**With Dev A gone, this contract has no author to arbitrate it.** That makes the changelog entry
matter more, not less: it is the only record of why a field is shaped the way it is once nobody
present remembers writing the code.
