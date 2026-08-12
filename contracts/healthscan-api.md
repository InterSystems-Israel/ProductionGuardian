# Health Scan API contract

**Owner:** Dev B · **Consumer:** Dev C · **Port:** `3002` · **Status:** published

Two read-only endpoints. Health Scan performs detection and surfacing only — nothing here
fixes, forecasts, scores, or explains. See root `CLAUDE.md` §2.

Machine-readable: `healthscan.schema.json`, `healthscan.d.ts`.
Shared fixtures: `samples/hosts-response.json`, `samples/findings-response.json` — the *same
bytes* Dev C mocks against.

---

## 1. `GET /api/healthscan/hosts`

Current state of every interoperability host in the monitored production.

```json
[
  {
    "host": "Lab Router",
    "type": "process",
    "status": "OK",
    "queued": 12,
    "messagesPerSec": 20.4,
    "errored": 0,
    "avgProcessingTime": 0.08,
    "avgQueueingTime": 0.02,
    "lastActivity": "2026-08-06T14:02:11Z"
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `host` | string | Config item name, exactly as it appears in IRIS. The join key — see Q8. |
| `type` | string | `service` \| `process` \| `operation`. Normalized — see Q10. |
| `status` | string | See the enum in Q1. Treat as open: render unknown values neutrally. |
| `queued` | number \| null | Current queue depth. Integer ≥ 0, or `null` when not measurable — see Q13. |
| `messagesPerSec` | number | Throughput over the last sampling interval. |
| `errored` | number \| null | Cumulative errored count since production start. Integer ≥ 0, or `null` — see Q13. |
| `avgProcessingTime` | number | **Seconds** — see Q6. |
| `avgQueueingTime` | number | **Seconds** — see Q6. |
| `lastActivity` | string | ISO 8601 UTC, `Z`-suffixed. Derived — see Q11. |

Every field is always **present**. `queued` and `errored` may be `null`; the others are always
numbers or strings. A missing key is a contract violation, a `null` value is not.

Hosts are returned in stable alphabetical order by `host`.

**Only application hosts appear.** The framework's own items (`Ens.MonitorService`,
`Ens.Alarm`, `Ens.ScheduleHandler`, `EnsLib.Testing.*`, `Ens.Activity.Operation.Local`, …) are
filtered out. For LABDEMO that means exactly three: EMR Source, Lab Router, Cloud API.

## 2. `GET /api/healthscan/findings`

Currently-active findings. One entry per ongoing condition, not per occurrence.

```json
[
  {
    "id": "f-1042",
    "host": "Lab Router",
    "type": "queue_buildup",
    "severity": "warning",
    "currentValue": 486,
    "baselineValue": 15,
    "detectedAt": "2026-08-06T14:06:33Z",
    "message": "Queue depth 486 is 32x baseline"
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable for the lifetime of the condition — see Q4. |
| `host` | string | Always exactly equal to some `host.host` — see Q8. |
| `type` | string | One of the eight in Q2. |
| `severity` | string | `info` \| `warning` \| `critical`. |
| `currentValue` | number | The metric value that breached. |
| `baselineValue` | number \| **null** | `null` while the baseline is warming up — see Q3. |
| `detectedAt` | string | ISO 8601 UTC. When the condition was *first* confirmed, not last seen. |
| `message` | string | Human-readable and **authoritative** — render as-is, do not reconstruct. |

Sorted `detectedAt` descending, severity as tiebreak (critical → warning → info).

### 2.1 The eight finding types

| `type` | Metric | Fires when |
|---|---|---|
| `dead_host` | host status | Status is `Error`, `Inactive`, `Stopped`, or `Disabled` |
| `stalled_host` | `iris_interop_last_activity` | No activity > threshold while messages are queued |
| `queue_buildup` | queue depth | Depth exceeds baseline by > X% or an absolute floor |
| `elevated_error_rate` | `iris_interop_messages_errored` | Error count rising faster than baseline |
| `slow_processing` | `iris_interop_avg_processing_time` | Avg processing time exceeds baseline by > X% |
| `growing_queue_wait` | `iris_interop_avg_queueing_time` | Queue wait trending upward |
| `throughput_drop` | `iris_interop_messages_per_sec` | Messages/sec falls below baseline |
| `system_alert` | `/api/monitor/alerts` | New alert posted to alerts.log |

**Sustained breach.** Per MVP §6, a rule must breach on **2+ consecutive samples** before a
finding is emitted. A single-sample spike produces nothing. This is why findings are stateful
and why `id` can be stable (Q4).

---

## 3. Errors and empty states

| Situation | Response |
|---|---|
| No findings | `200` + `[]` — **never** `404` |
| No hosts yet / production stopped | `200` + `[]` |
| Engine starting, no sample yet | `200` + `[]`, plus `X-Healthscan-State: warming` |
| Upstream proxy unreachable | `200` + last-known payload, plus `X-Healthscan-State: stale` |
| Genuine server fault | `500` + `{"error":"..."}` |

The engine prefers returning stale-but-labelled data over an error, because a blanked dashboard
is worse on stage than a slightly old one. `X-Healthscan-State` is advisory: `ok`, `warming`, or
`stale`. Dev C may ignore it and rely on `baselineValue: null` alone.

**CORS:** `Access-Control-Allow-Origin: *` is sent on both endpoints, so the dashboard works
with or without the Vite dev proxy (Q9).

---

## 4. The Day-1 questions, answered

Dev C raised nine (issue #1); three more surfaced from live IRIS metrics while building LABDEMO.

| # | Question | Answer |
|---|---|---|
| **Q1** | Exact `status` enum | **Not** the assumed set. IRIS emits `OK`, `Error`, `Inactive`, `Retry`, `Stopped`, `Unconfigured`; `EnumerateHostStatus` adds `Disabled`. **There is no `Warning`.** Keep rendering unknowns neutrally. |
| **Q2** | Exact `type` strings | Confirmed — the eight snake_case names as listed, unchanged. |
| **Q3** | Baseline warm-up | `baselineValue: number \| null`. Your assumption was right. Also surfaced via `X-Healthscan-State: warming`. |
| **Q4** | Finding lifecycle | **ids are stable** while the condition persists; findings **disappear** when cleared. Both your assumptions hold — keep the highlight animation and the poll-surviving drawer. Sustained-breach state (§2.1) is what makes this cheap for us. |
| **Q5** | Ordering | Sorted **server-side**, `detectedAt` desc, severity tiebreak. Your client sort is harmless — keep it. |
| **Q6** | Units | **Seconds** — confirmed empirically, not assumed. Cloud API configured at 0.05s latency reports `avgProcessingTime: 0.05`; Lab Router reports `0.08`. Your `0.08 → "80 ms"` is correct. |
| **Q7** | Zero findings / startup | `200` + `[]`, never `404`. See §3 for the full table. |
| **Q8** | Host↔finding join key | Yes — `finding.host` is always exactly a `host.host` value. Same string, same case. |
| **Q9** | CORS | Yes, we send `Access-Control-Allow-Origin: *`. Dev proxy remains fine. |
| **Q10** | *(new)* `type` vocabulary | IRIS reports business processes as **`actor`**, not `process`. We normalize: `actor → process`, `service → service`, `operation → operation`. The contract keeps the MVP doc's vocabulary; the IRIS word never reaches you. |
| **Q11** | *(new)* `lastActivity` precision | IRIS gives *elapsed seconds since last activity*, not a timestamp. We compute `now − elapsed`, so accuracy is bounded by proxy poll timing — treat it as ±10 s, correct for "2 minutes ago", not for sub-second ordering. |
| **Q12** | *(new)* `avgProcessingTime` is aggregated | IRIS emits these per `(host, messagetype)`, so a host has *several* series. We aggregate into one number, weighted by `iris_interop_sample_count`. A host handling two message types reports their weighted mean, not either one. |
| **Q13** | *(new)* `queued` / `errored` nullability | **`null` means "not measurable for this host", never "zero".** `iris_interop_queued` and `iris_interop_messages_errored` carry no `host` label, so per-host counts come from a separate host-status endpoint the proxy merges on host name. When that merge does not cover a host — endpoint unreachable, host absent from its response, merge disabled — the count stays `null` rather than becoming a `0` nobody measured. Consumers render `—`; **rules must skip rather than compare.** |

### 4.1 What changes for Dev C

Only **Q1** contradicts an assumption. Of the 13 `CONTRACT-Q` sites, the `HostStatus` union is
the one that needs editing:

```ts
export type HostStatus =
  | 'OK' | 'Error' | 'Inactive' | 'Retry' | 'Stopped' | 'Unconfigured' | 'Disabled';
```

`Warning` should come out. Nothing else in the transcription needs to change — and because
unknown statuses already render neutral (§2.4 of `apps/dashboard/CLAUDE.md`), the existing code
degrades correctly even before that edit.

**Q13 is the second contradiction, added 2026-08-12.** `queued` and `errored` widen to
`number | null` in the `Host` transcription. The dashboard already renders `—` for a null count
(`formatCount`), so the visible behaviour was correct before the type was; what changed is that
the guards stop coercing an unmeasured count to `0`, and any consumer comparing these values
must skip on `null` rather than compare against it. See the `CHANGELOG.md` entry for the
reproduction that motivated it.

---

## 5. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by
all three developers. See `README.md` in this directory.
