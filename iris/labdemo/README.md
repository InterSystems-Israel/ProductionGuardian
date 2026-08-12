# iris/labdemo — LABDEMO Production

The LABDEMO production models a realistic HL7 lab message pipeline that Health Scan monitors.

```
EMR Source  →  Lab Router  →  Cloud API
(HL7 file)     (routing +      (HTTP POST → PatientDispatcher)
                HL7ToPID DTL             ↓
                applied inline)  PatientRecord table (upsert by PatientID)
```

There are three application hosts. `EMR Source`, `Lab Router` and `Cloud API` are the
config item names — those are the strings that appear in `/api/monitor/metrics`, in the
proxy JSON, and in the dashboard, so use them verbatim when reasoning about findings.
Class names (`PatientDemographicsOperation`) differ from config item names (`Cloud API`);
the `<Item Name="...">` set in `Production.cls` is authoritative.

---

## File inventory

| File | Purpose |
|---|---|
| `Production.cls` | Production definition — 3 application items + ActivityReporter |
| `RoutingRule.cls` | Routes ADT^A01 to Cloud API, applying HL7ToPID inline |
| `Transform/HL7ToPID.cls` | DTL: HL7 PID segment → PatientDemographics message |
| `Message/PatientDemographics.cls` | Ens.Request carrying extracted PID fields |
| `Operation/PatientDemographicsOperation.cls` | BO: HTTP POST to REST dispatcher |
| `REST/PatientDispatcher.cls` | %CSP.REST dispatcher — POST/GET /labdemo/patients |
| `REST/HostStatusDispatcher.cls` | %CSP.REST dispatcher — GET /labdemo/monitor/hoststatus, per-host queue depth + error counts for the metrics proxy (read-only) |
| `Data/PatientRecord.cls` | %Persistent table — upsert keyed on PatientID |
| `HL7Generator.cls` | Writes synthetic ADT/ORU .hl7 files to drop dir |

---

## One-time setup

### 1 — Register the REST web application

Management Portal → System Administration → Security → Applications → Web Applications → Create New Web Application

| Field | Value |
|---|---|
| Name / Path | `/labdemo` |
| Namespace | `LABDEMO` |
| Enable | REST |
| Dispatch class | `ProductionGuardian.LabDemo.REST.PatientDispatcher` |
| Allowed authentication | Password (or Unauthenticated for local demo) |

Click **Save**. The API is now live at `http://localhost:<web-port>/labdemo/patients` — see the port note below.

### 1b — Register the host-status web application

A **second** web application, for the endpoint the metrics proxy polls to get per-host queue depth
and error counts. It needs its own entry because a CSP application maps one path to one dispatch
class.

| Field | Value |
|---|---|
| Name / Path | `/labdemo/monitor` |
| Namespace | `LABDEMO` |
| Enable | REST |
| Dispatch class | `ProductionGuardian.LabDemo.REST.HostStatusDispatcher` |
| Allowed authentication | Password (or Unauthenticated for local demo) |

**The port is whichever web server fronts your instance — do not assume 52773.** That is the
private web server, and it is not always published. On the instance this was verified against
(`irishealth` behind a `webgateway` container) the only HTTP port is **80**, and 52773 refuses the
connection outright. Use the same host and port that serve `/api/monitor/metrics` in your browser —
it is the same web server, and the proxy reaches both through one `IRIS_HOST`/`IRIS_PORT` pair.

Verified on that instance, port 80:

```bash
$ curl -s -u user:pass http://localhost/labdemo/monitor/hoststatus
# HTTP/1.1 200 OK   Content-Type: application/json
# {"hosts":[{"host":"Cloud API","status":"OK","queued":0,"errored":0,"messageCount":17860}, ...],
#  "_meta":{"production":"LABDEMO.Production","productionState":"Running","hostCount":13, ...}}
```

The equivalent on an instance whose private web server *is* published would be
`http://localhost:<web-port>/labdemo/monitor/hoststatus`. Getting this wrong is quiet in exactly the way
`IRIS_BASE_PATH` is: the proxy logs one failed poll and then reports `queued`/`errored` as `null`,
which reads as an idle production rather than a bad URL.

**Why this exists:** `iris_interop_queued` and `iris_interop_messages_errored` are emitted once per
production with no `host` label, so per-host queue depth and error counts are not in
`/api/monitor/metrics` at all — which blocked `queue_buildup` (#12) and `elevated_error_rate` (#31).
This wraps `Ens.Util.Statistics:EnumerateHostStatus` and `Ens.MessageHeader` to supply them. It is
**read-only**: it reads host state and counts rows, and changes no production setting.

Set `IRIS_HOSTSTATUS_PATH` in the proxy's `.env` to match this path (default
`/labdemo/monitor/hoststatus`), or empty to disable the poll — the proxy then publishes
`queued`/`errored` as `null`, as it did before.

### 2 — Load all classes

```
// From a Terminal in the LABDEMO namespace:
do $system.OBJ.LoadDir("/path/to/iris/labdemo/", "ckr")
```

The `r` flag recurses into subdirectories (Message/, Process/, Transform/, etc.).

### 3 — Enable interop metrics (if not already done)

```
do ##class(ProductionGuardian.Setup.EnableMetrics).Run()
```

See `../setup/README.md` for the full walkthrough.

### 4 — Start the production

```
do ##class(Ens.Director).StartProduction("ProductionGuardian.LabDemo.Production")
```

Or via Management Portal: Interoperability → Configure → Production → Start.

---

## Start message flow

```
// 20 messages, 2-second gaps (ADT and ORU alternating):
do ##class(ProductionGuardian.LabDemo.HL7Generator).Run()

// Continuous until Ctrl-C:
do ##class(ProductionGuardian.LabDemo.HL7Generator).RunContinuous(2)
```

Each message flows:
1. Written to `/tmp/labdemo/hl7-in/` as a `.hl7` file
2. `EMR Source` picks it up and sends to `Lab Router`
3. `Lab Router` matches ADT^A01 and sends to `Cloud API`, applying the HL7ToPID DTL on the
   way — the transform extracts PatientID, name, DOB, sex, address and phone
4. `Cloud API` HTTP-POSTs the JSON to `/labdemo/patients`
5. PatientDispatcher upserts the record in `PatientRecord` (insert first time, update thereafter)

---

## REST API reference

Base URL: `http://<host>:<web-port>/labdemo`

**`<web-port>` is whatever web server fronts your instance — see the note above; it is 80,
not 52773, on the verified instance.** The examples below use `$PORT` so they are not wrong
on a copy-paste; set it once (`PORT=80`) and reuse.

| Method | Path | Description |
|---|---|---|
| `POST` | `/patients` | Upsert patient by PatientID |
| `GET` | `/patients/:id` | Get one patient by PatientID |
| `GET` | `/patients` | List patients (`?offset=0&limit=50`) |
| `GET` | `/patients/count` | Total record count |

Example — query a patient directly:
```bash
curl "http://localhost:$PORT/labdemo/patients/123456"
```

Example — check total count:
```bash
curl "http://localhost:$PORT/labdemo/patients/count"
```

---

## Verify the pipeline is working

```
// Check record count grows as messages flow:
write ##class(ProductionGuardian.LabDemo.Data.PatientRecord).Count()

// Inspect a record:
set rec = ##class(ProductionGuardian.LabDemo.Data.PatientRecord).GetByID("123456")
write rec.LastName, " ", rec.FirstName, " (", rec.UpdateCount, " updates)"

// SQL:
// SELECT * FROM ProductionGuardian_LabDemo_Data.PatientRecord ORDER BY LastUpdated DESC
```

---

## Inducing findings (for Health Scan testing)

Only `EMR Source`, `Lab Router` and `Cloud API` exist **in `Production.cls`**, so every trigger targets one of
those three. Use the config item names exactly.

**Three things to know before you start, or nothing will fire and it will look broken.**

*The class names below are this repo's, and the running instance may not be using them.*
Every trigger that edits a class assumes the production defined in `Production.cls`
(`ProductionGuardian.LabDemo.*`). The LABDEMO instance verified on 2026-08-12 was running a
**different production class tree** (`LABDEMO.Production`, with `LABDEMO.Operation.CloudAPI`
and friends), and only one class from this repo was compiled there at all. Editing
`PatientDemographicsOperation` on that instance changes nothing that is running. Check
which production is live before editing anything — `Ens.Director.GetProductionStatus()` —
and see #34, which tracks converging the two.

*Warm-up.* Six of the eight rules are comparative — they need a baseline first.
`minBaselineSamples` is 12 **samples**, not a duration — the wall-clock warm-up is
`12 × POLL_INTERVAL_MS`. Read the interval from `services/detection-engine/src/index.ts`
and multiply: **~2 minutes at a 10 s poll, ~1 minute at 5 s.** Let the generator run that
long before inducing anything. `dead_host` and `system_alert` are absolute and fire
immediately.

*The numbers have floors.* A breach must clear both the baseline multiplier **and** an
absolute floor, so a small nudge produces nothing. The current floors are in
`services/detection-engine/thresholds.json` — that file is authoritative, and the
arithmetic below is quoted from it rather than restated as fact. Check it if a trigger
stops working.

| Finding type | How to induce | Why it clears the threshold |
|---|---|---|
| `dead_host` | Disable `EMR Source` in the Management Portal | Absolute rule: fires on status `Disabled`. No baseline needed |
| `throughput_drop` | Stop the HL7Generator and let traffic drain | Rate falls to 0, under the 0.4 baseline fraction. Needs baseline ≥ 0.1 msg/s — generating every 2 s gives 0.5 msg/s |
| `slow_processing` | Add `hang 1` to the top of `PatientDemographicsOperation.OnMessage` (that class is `Cloud API`), recompile | Gate is the greater of the 0.3 s `Cloud API` floor and 3× its ~0.05 s baseline, so 0.3 s. A 1 s hang clears it. `hang 5` also works but backs the queue up behind it |
| `growing_queue_wait` | Same `hang 1` — watch `Cloud API` while the generator keeps running | Messages wait behind the hung one. Floor is 0.15 s and 3× the ~0.03 s baseline, so a 1 s hang clears it once traffic overlaps |
| `elevated_error_rate` | Set `Cloud API`'s `HTTPPort` to a closed port (e.g. 59999) **and make failure fast** — `FailureTimeout`, `RetryInterval`, `ConnectTimeout`, `ResponseTimeout` all to `1` | Floor is 1.0 errors/min and 3× baseline. **The timeouts are the point:** at the default 15 s `FailureTimeout` each message burns 15 s before erroring, so the rate stays *under* the floor and nothing fires. With them at 1 s, measured live: `12.0 errors/min, 14x baseline` |
| `stalled_host` | Disable `Cloud API` so its queue holds messages, then wait | Needs no activity for `inactiveSeconds` (300) **while messages are queued** — so it takes **5 minutes**, and `requiresQueued` means an idle-but-empty host will not do |
| `queue_buildup` | Use the `elevated_error_rate` trigger below — a closed port makes `Cloud API` retry, and the queue runs away past a baseline it already learned. **Disabling the host does NOT work**; see the caveat | Depth must exceed the floor of **50** *and* 5× baseline. Measured live: `Queue depth 110 is 14x baseline` against a baseline of 7.97 |
| `system_alert` | Write an alert-severity entry that **names a host**: `do ##class(%SYS.System).WriteToConsoleLog("ERROR <Ens>ErrGeneral: Cloud API failed to send message",0,2)` from `%SYS`. **`Alert on Error` does NOT work — see #57** | `/api/monitor/alerts` serves the instance's alert log, and the rule matches an alert to a host by the host name appearing in the message text. Measured live at `info` severity — the only rule that produces an `info` finding |

Disabling a host induces `dead_host` too, so the `stalled_host` trigger surfaces two
findings. That is correct behaviour, not a duplicate — and the closed-port trigger is the
most productive single action in this table, surfacing four at once with the fast timeouts
(`dead_host`, `elevated_error_rate`, `throughput_drop`, `growing_queue_wait`) or reaching
`queue_buildup` if you leave the default 15 s timeouts in place instead.

**All eight types have been observed against real IRIS** on the deployed
`ProductionGuardian.LabDemo.Production` (2026-08-12). Where a row below says "measured
live", the quoted numbers are from that run rather than from a fixture.

> **`queue_buildup` caveat — it fires, but only when a baseline existed first (#43).**
>
> The old caveat here said per-host depth was missing from the Prometheus text and the
> engine therefore could not see the queue. **That half is solved:** #12 landed, the proxy
> reads per-host depth from `Ens.Util.Statistics:EnumerateHostStatus`, and the engine now
> receives real numbers — `dead_host` reports them in its message (*"Cloud API is Disabled
> with 6 message(s) queued"*).
>
> **Which trigger you use decides whether it fires**, and the deciding factor is whether a
> non-zero baseline existed *before* the depth ran away — not how fast the queue grows.
>
> | | **Disable** the host | **Break its target** (closed port) |
> |---|---|---|
> | host behaviour | stops consuming at once | stays up and keeps retrying |
> | queue while the baseline warms | 0, then ramps | small but real |
> | baseline when depth runs away | rises *with* the ramp | already learned (7.97 measured) |
> | ratio | ceiling **2.18×**, under the 5× gate | **13.8×** — fires |
>
> So disabling `Cloud API` grew the queue 6 → 122 in silence, and the old `Run(80, 0.2)`
> instruction never worked. The closed-port trigger produced `Queue depth 110 is 14x
> baseline` live. A queue that builds **from idle** is still invisible, which is the open
> half of #43 — and it is the `dead_host`-adjacent case, where the queue is most obviously a
> problem. The ramp arithmetic is pinned in
> `services/detection-engine/test/baseline.test.ts`; the closed form is on #45 and the fix
> belongs with #25's thresholds ADR.
>
> The lesson worth keeping: the fixture at
> `services/detection-engine/fixtures/proxy/queue-buildup.json` jumps 0 → 486 in a single
> poll, so the first breaching sample sees a near-zero mean and a huge ratio. Real IRIS
> ramps. **The fixture is honest about the value and wrong about the shape**, and this rule
> is sensitive to shape — which is why the whole test suite was green while the live path
> was broken.

> **`system_alert` caveat — `Alert on Error` is inert here (#57).** `AlertOnError` routes an
> alert to an **`Ens.Alert` business host**, and `Production.cls` defines none. So the setting
> is silently ineffective: measured with 92 real errors on `Cloud API`,
> `Ens_Alerting.Alert` had **0 rows** and `/api/monitor/alerts` stayed `[]`. Nothing warns you
> — IRIS simply has nowhere to send the alert.
>
> The rule consumes the **instance alert log**, which is a different source, and it matches an
> alert to a host by the **host name appearing in the message text** (`detect/engine.ts`). An
> alert that names no host produces no finding — verified, my first test alert was correctly
> ignored for exactly that reason.
>
> **Do not curl `/api/monitor/alerts` to check.** It is consume-on-read: reading it clears
> what it returns. Observed directly — the proxy captured an alert and the very next read of
> the IRIS endpoint returned `[]`. The proxy accumulates them in memory
> (`services/metrics-proxy/src/cache.js`), so read `/proxy/alerts` on :3001 instead. Restarting
> the proxy is how you clear a test alert, since they are not persisted.

After the `slow_processing` / `growing_queue_wait` test, **remove the `hang`** and
recompile — a hang left in place poisons every later baseline.

---

## Verify metrics

```
do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()
```

All 7 metric families should show FOUND after the production is running with messages flowing.

`Verify()` prints the URL it requests. If it reports a 404, or a 200 with no
`iris_interop_*` families, the URL is wrong rather than the metrics being off — point it at
whatever works in your browser:

```
set ^ProductionGuardian.Setup("WebAppPrefix") = "/iris4health_2024_1"   // default ""
set ^ProductionGuardian.Setup("WebPort")      = 80                      // default 52773
set ^ProductionGuardian.Setup("WebHost")      = "127.0.0.1"
```

These mirror the metrics proxy's `IRIS_BASE_PATH` / `IRIS_PORT` / `IRIS_HOST`.

Run `Verify()` **before** starting the metrics proxy, not alongside it:
`/api/monitor/alerts` is consume-on-read, so this call takes any pending alerts that the
proxy would otherwise publish.
