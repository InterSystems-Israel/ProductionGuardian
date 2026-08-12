# Metrics proxy API contract

**Owner:** Dev A · **Consumer:** Dev B · **Port:** `3001` · **Status:** published

Three read-only endpoints. The proxy polls the IRIS built-in `/api/monitor/` API, parses the
Prometheus text format, and republishes it as per-host JSON. **It forwards and reshapes; it does
not detect, threshold, or judge.** Baseline comparison and findings are the detection engine's job
(`healthscan-api.md`).

Machine-readable: `proxy.schema.json`.
Shared fixture: `samples/metrics-dump.txt` — the raw IRIS `/api/monitor/metrics` body every
snapshot in this document was derived from. Feed it to `src/parser.js` and you get the values
quoted here.

**Published by Dev B on Dev A's behalf.** Dev A has moved to other work; this contract is derived
from their merged code (`services/metrics-proxy/`) rather than authored alongside it, so it
documents what the proxy *does* today, not an intent. Where the code and Dev B's engine disagree,
§6 names it rather than resolving it silently.

---

## 1. `GET /proxy/metrics`

The latest metric snapshot. One entry per interoperability host IRIS reported, plus per-production
scalars and diagnostics.

```json
{
  "hosts": [
    {
      "host": "Lab Router",
      "type": "process",
      "status": "OK",
      "isFramework": false,
      "queued": null,
      "messages": 126,
      "messagesPerSec": 1.2,
      "errored": null,
      "avgProcessingTime": 0.08,
      "avgQueueingTime": 0,
      "lastActivity": "2026-08-11T23:59:55.162Z",
      "lastActivityElapsedSeconds": 4.838
    }
  ],
  "systemAlertsNew": 1,
  "systemAlertsLog": 1,
  "_meta": {
    "polledAt": "2026-08-12T00:00:00Z",
    "production": "LABDEMO.Production",
    "productionQueued": 0,
    "absentFamilies": [],
    "hostCount": 15,
    "applicationHostCount": 4
  }
}
```

Those are measured values from `samples/metrics-dump.txt`, not illustrative ones.

### 1.1 Host fields

| Field | Type | Notes |
|---|---|---|
| `host` | string | Config item name, exactly as the IRIS `host` label carries it. **The join key** — see Q1. |
| `type` | string | `service` \| `process` \| `operation` \| `unknown`. Normalized — see Q6. |
| `status` | string | The IRIS `status` label, passed through. `Unknown` when IRIS sent no `iris_interop_hosts` line. Enum in Q7. |
| `isFramework` | boolean | `true` for IRIS's own plumbing. Flag, not a filter — see Q5. |
| `queued` | number \| **null** | Per-host queue depth. **`null` on every host today** — see Q2 and §6.1. |
| `messages` | number \| null | Cumulative messages since production start. |
| `messagesPerSec` | number \| null | Throughput over the IRIS sampling window. |
| `errored` | number \| **null** | Cumulative errored count. **`null` on every host today** — see Q8. |
| `avgProcessingTime` | number \| null | **Seconds.** Aggregated across message types — see Q3. |
| `avgQueueingTime` | number \| null | **Seconds.** Aggregated across message types — see Q3. |
| `lastActivity` | string \| null | ISO 8601 UTC, `Z`-suffixed. Derived — see Q4. |
| `lastActivityElapsedSeconds` | number \| null | Seconds since last activity, as IRIS gives it — see Q4. |

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

**`_meta` is diagnostics, not payload.** `absentFamilies` exists so a consumer can distinguish
"unmeasurable on this instance" from "measured zero"; it is not something to build a finding on.

## 2. `GET /proxy/alerts`

`/api/monitor/alerts`, forwarded.

```json
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

```json
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
| **Q2** | Is `queued` present per host? | **The field is present; the value is not.** `iris_interop_queued` carries no `host` label — labels are exactly `id` and `production`, verified in all three captures. The proxy publishes **`queued: null`** on every host and the real per-production total as `_meta.productionQueued` (`0` in the sample). Per-host depth needs `Ens.Util.Statistics:EnumerateHostStatus`, which the poller does not read. **`queue_buildup` cannot fire per host today** — issue #12, ADR 0001. See §6.1: `null` vs `0` is an open discrepancy. |
| **Q3** | Are `avg*` already aggregated, or raw per-`messagetype` series? | **Already aggregated by the proxy, weighted by `iris_interop_sample_count`.** Your assumption holds and aggregation does *not* move to the engine. IRIS emits one series per `(host, messagetype)`; `sample_count` is its own family keyed the same way, not a label, so the proxy indexes it in a pre-pass. A host with no sample-count line falls back to an unweighted mean rather than dropping out. **`sampleCount` is not published per host** (Q10) — you no longer need it, since you are not doing the weighting. |
| **Q4** | Elapsed seconds, or a pre-computed timestamp? | **Both.** `lastActivityElapsedSeconds` is IRIS's own value (elapsed seconds, e.g. `4.838` — *not* an epoch timestamp), and `lastActivity` is `polledAt − elapsed` as ISO 8601 UTC. Prefer `lastActivityElapsedSeconds` for `stalled_host`: it is the measurement, and the timestamp inherits poll-timing error (±10 s). Both are `null` when IRIS emitted no line, rather than reading as "active just now". |
| **Q5** | Are framework hosts filtered by the proxy? | **They reach you, flagged.** Your assumption holds and your own filter stays necessary. Every host carries `isFramework` (`Ens.`/`EnsLib.` prefix, plus the bare `ActivityReporter` spelling). **Filtering is not optional:** in `samples/metrics-dump.txt`, 11 of 15 hosts are framework, and `Ens.MonitorService` is one of the few with `avg_*` series — an unfiltered snapshot reports framework timings as application latency. Filter on `isFramework` rather than re-deriving the prefix rule; the metric label carries the *item* name, which has been both `ActivityReporter` and `Ens.Activity.Operation.Local`, so a prefix rule alone was never enough. |

### 5.1 Three more, found while writing this

| # | Question | Answer |
|---|---|---|
| **Q6** | `type` vocabulary | IRIS says **`actor`** where the MVP doc says `process`; the proxy normalizes `actor → process`, so the IRIS word never reaches you. `hosttype` rides on the `avg_*` families only — `iris_interop_hosts` carries no type label at all. A host with no `avg_*` series therefore reports **`type: "unknown"`**: 8 of 15 hosts in the sample, all framework. Treat `unknown` as a real value, not a bug. |
| **Q7** | Exact `status` enum | `OK`, `Error`, `Inactive`, `Retry`, `Stopped`, `Unconfigured`, `Disabled`, plus **`Unknown`** when IRIS sent no `iris_interop_hosts` line for a host. **There is no `Active` and no `Warning`.** Same enum as `healthscan-api.md` Q1 with `Unknown` added, so your `dead_host` mapping needs no change. |
| **Q8** | Is `errored` per host? | **No — and this was not previously known.** `iris_interop_messages_errored` carries **no `host` label** in `samples/metrics-dump.txt`: `iris_interop_messages_errored{id="LABDEMO",production="LABDEMO.Production"} 0`. It is per-production, exactly like `queued`. The proxy's `METRIC_MAP` treats it as per-host, so with no `host` label the line is skipped and **`errored` is `null` on every host** — and unlike `queued`, the per-production total is *not* published anywhere. `elevated_error_rate` cannot fire today, for the same structural reason as `queue_buildup`. See §6.3. |

### 5.2 What changes for Dev B

**Every one of the 15 hosts in `samples/metrics-dump.txt` is currently rejected by
`isProxyHost()`.** Measured, not predicted — the probe output is in the PR body. Three field-level
mismatches, each independently sufficient to reject a host:

| # | Engine expects | Proxy publishes | Effect |
|---|---|---|---|
| **Q9** | `name: string` | `host: string` | `name` is `undefined` → every host rejected |
| **Q8** | `messagesErrored: number` | `errored: number \| null` | `messagesErrored` is `undefined` → every host rejected |
| **Q2** | `queued: number` (finite) | `queued: null` | fails `isFiniteNumber` → every host rejected |

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

### 6.1 `queued: null` vs `queued: 0`

**The contract position is `0`.** `proxy.schema.json` permits `null` because that is what the
proxy emits today, and a schema that rejected the running code would be a fiction.

The two sides both have a real argument, which is why this is not obvious:

- **The proxy's `null`** is honest. `services/metrics-proxy/src/parser.test.js` pins it explicitly:
  *"`queued: 0` per host would assert every host is drained while 14 sit somewhere."* Publishing
  `0` while `_meta.productionQueued` is `486` is a false statement about each host.
- **The engine's finite-number guard** is also right: a rule cannot compare `null` to a baseline,
  and `0` at least keeps the host visible so its other seven metrics can be evaluated.

Rejecting the whole host is the worst of both — it loses `status`, `messagesPerSec` and everything
else over one unmeasurable field. **Recommended fix, one line, engine side:** relax the guard to
accept `null` for `queued` and have `queue_buildup` skip a host whose depth is unmeasurable, the
same way comparative rules already skip a warming baseline. That keeps the "absent is not zero"
invariant that the rest of the payload depends on, rather than carving out an exception for the one
field where it is inconvenient.

Closing it properly is issue #12 — a small `%CSP.REST` wrapper over
`Ens.Util.Statistics:EnumerateHostStatus`, which returns per-host depth keyed by config item name,
so the `host` join key survives. Until then, note Dev C's number from #16: `queue_buildup` has
`absoluteFloor: 50`, and the captured depth of `48` **will not trip the rule**. "Wired up and
returning real numbers" and "the finding fires" are two separate milestones.

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

### 6.3 `errored` is per-production upstream, so no rename fixes it

Q8's discovery outlives the naming question. `iris_interop_messages_errored` has no `host` label,
so **`elevated_error_rate` cannot fire per host regardless of what the field is called** — the same
structural gap as `queue_buildup`, and it has not been filed.

Worth deciding alongside #12, because the fix is the same shape: `EnumerateHostStatus` returns
per-host error counts as well as queue depth, so one REST wrapper closes both rules. Two of eight
finding types depend on it. Filed against `iris/**`, which is now unowned — flagging it here so
it is at least written down.

Note the proxy publishes **no** per-production error total: unlike `queued`, `messages_errored` is
not in `SCALAR_FAMILIES`, so the value is parsed and then dropped. Adding it to `_meta` as
`productionErrored` would be a one-line proxy change and would at least make the number visible.
Not done here — this is a contract PR, not an implementation one.

---

## 7. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by all
three developers. See `README.md` in this directory.

**With Dev A gone, this contract has no author to arbitrate it.** That makes the changelog entry
matter more, not less: it is the only record of why a field is shaped the way it is once nobody
present remembers writing the code.
