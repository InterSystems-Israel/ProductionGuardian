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

### 3b — Create the drop directories, and point Cloud API at a reachable web server

Three things that are **not** optional and were each discovered by the production failing
on first deploy (#34). All three are environment-dependent, which is why they are not
baked into `Production.cls` beyond a default.

**The two file directories must exist.** `EMR Source` is an `EnsLib.HL7.Service.FileService`
and goes straight to `Error` without them:

```
ERROR #5021: Directory '/tmp/labdemo/hl7-archive/' does not exist.
```

Create both (inside the container, if IRIS is containerised) and make them writable by the
IRIS owner:

```bash
mkdir -p /tmp/labdemo/hl7-in /tmp/labdemo/hl7-archive
chown -R irisowner:irisowner /tmp/labdemo
```

**`Cloud API` must target the web server that fronts the instance, as reached from inside
it.** `Production.cls` ships `webgateway-webinar:80`, which is specific to the verified
setup. The old default of `127.0.0.1:52773` assumed a private web server in the same
container; where there is none, every message fails and the operation sits in `Retry`:

```
ERROR #6059: Unable to open TCP/IP socket to server 127.0.0.1:52773
```

Confirm what actually listens before trusting a port — on the verified instance the IRIS
container publishes only the superserver on `1972`, and the web gateway is a *separate*
container.

**And it needs credentials.** Through an external web gateway the REST app answers `403` to
an unauthenticated request even when `/labdemo` permits unauthenticated access locally.
Create an Ensemble credential and name it in the `Credentials` adapter setting:

```
do ##class(Ens.Config.Credentials).SetCredential("LabDemoREST","user","pass",1)
```

Verified from inside the container: `403` without credentials, `200 {"count":0}` with.

**Register BOTH web applications.** §1 and §1b are both required — `/labdemo/monitor` alone
is not enough. Without `/labdemo`, `Cloud API` POSTs into a 404 and no `PatientRecord` is
ever written, while `EMR Source` and `Lab Router` look perfectly healthy.

### 4 — Start the production

```
do ##class(Ens.Director).StartProduction("ProductionGuardian.LabDemo.Production")
```

Or via Management Portal: Interoperability → Configure → Production → Start.

**After changing a class, `update` is not always enough.** A running job keeps executing the
code it started with, so a fix to a business-host class can appear not to apply — the same
error kept being logged after the source was corrected and reloaded. Stop and start the
production when a class changes, rather than only updating it.

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

*Check which production is running before editing a class.* Every trigger below assumes
`ProductionGuardian.LabDemo.Production` from `Production.cls`. That **is** what runs on the
verified instance as of 2026-08-12 (#34) — but it was not before that date, and the failure
mode is silent: the instance was running an unrelated `LABDEMO.Production` with its own
class tree, so editing `PatientDemographicsOperation` changed nothing that was executing and
the trigger appeared not to work. One command, worth running first:

```
do ##class(Ens.Director).GetProductionStatus(.p,.state)  write p," state=",state,!
```

Expect `ProductionGuardian.LabDemo.Production state=1`. Anything else and the triggers here
do not apply to what is running.

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
| `elevated_error_rate` | Set `Cloud API`'s `HTTPPort` to a closed port (e.g. 59999) | Every message errors. Floor is 1.0 errors/min and 3× baseline; at one message per 2 s that is ~30/min |
| `stalled_host` | Disable `Cloud API` so its queue holds messages, then wait | Needs no activity for `inactiveSeconds` (300) **while messages are queued** — so it takes **5 minutes**, and `requiresQueued` means an idle-but-empty host will not do |
| `queue_buildup` | **Does not currently fire — see the caveat below.** The queue builds; no finding appears | Depth must exceed the absolute floor of **50** *and* 5× baseline. Clearing the floor is easy; the 5× is unreachable against a growing queue |
| `system_alert` | Enable `Alert on Error` on `Cloud API`, then induce the error-rate trigger above | An errored message with alerting on writes an alert that `/api/monitor/alerts` serves. This is the only rule that can produce an `info` finding |

Disabling a host induces `dead_host` too, so the `stalled_host` and `queue_buildup`
triggers each surface two findings. That is correct behaviour, not a duplicate.

> **`queue_buildup` caveat — the plumbing is fixed, the rule still cannot fire (#43).**
>
> The old caveat here said per-host depth was missing from the Prometheus text and the
> engine therefore could not see the queue. **That half is solved:** #12 landed, the proxy
> reads per-host depth from `Ens.Util.Statistics:EnumerateHostStatus`, and the engine now
> receives real numbers — `dead_host` reports them in its message (*"Cloud API is Disabled
> with 6 message(s) queued"*).
>
> **But the rule still does not fire, for a different reason.** Measured on live LABDEMO:
> disabling `Cloud API` grew the queue 6 → 122 and `queue_buildup` stayed silent the whole
> way, well past its floor of 50. The rolling baseline rises *with* the queue, so the ratio
> never reaches the 5× gate — and **no generator rate changes that**, because scaling a ramp
> scales its mean identically (pinned in `services/detection-engine/test/baseline.test.ts`).
> The closed form and the multiplier values that *would* fire are worked out on #45; that
> argument belongs there and in #25, not in a README.
>
> So there is currently **no way to induce this finding on a live instance**, and the old
> `Run(80, 0.2)` instruction did not work. Demo mode still shows all eight types. Tracked
> in #43; the fix changes what the baseline is compared against and belongs with #25's
> thresholds ADR rather than a tuning change.
>
> The lesson worth keeping: the fixture at
> `services/detection-engine/fixtures/proxy/queue-buildup.json` jumps 0 → 486 in a single
> poll, so the first breaching sample sees a near-zero mean and a huge ratio. Real IRIS
> ramps. **The fixture is honest about the value and wrong about the shape**, and this rule
> is sensitive to shape — which is why the whole test suite was green while the live path
> was broken.

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
