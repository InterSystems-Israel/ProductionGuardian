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

**On Windows:** the ObjectScript in this file is shell-independent — it runs in an IRIS Terminal
either way, and `Triggers` calls need no translation. The `curl` lines do: in the PowerShell that
ships with Windows, `curl` is an alias for `Invoke-WebRequest`, so **`curl.exe`** is needed for
every one of them. `-u user:pass` is the flag that makes this obvious rather than silent: the alias
answers *"Parameter cannot be processed because the parameter name 'u' is ambiguous"* and lists four
of its own parameters, which names PowerShell as the culprit. `-s` does not — it binds to
`-SessionVariable` and the call goes on to prompt for a `Uri`, which reads as a hang. Git Bash has
the real `curl` and needs nothing. Root `README.md` → *On Windows* is the one place the full
translation table lives; it is not repeated here.

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
| `Triggers.cls` | **Trigger toggles** — one idempotent call per finding type, plus `Reset()` and `Status()` |

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
private web server, and it is not always published. **On this repo's compose stack it *is* 52773**:
the AI Hub image serves HTTP itself and there is no gateway service, which is why `Production.cls`
targets `127.0.0.1:52773`. On the older instance this section was verified against (`irishealth`
behind a `webgateway` container) the only HTTP port is **80**, and 52773 refuses the connection
outright. Both are real; the point is that it depends on the deployment, so check rather than copy. Use the same host and port that serve `/api/monitor/metrics` in your browser —
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
it.** `Production.cls` ships `127.0.0.1:52773` — the compose stack's IRIS container serves
HTTP itself, so the target is in the same container and there is no gateway service. It
briefly shipped `webgateway-webinar:80` instead, which was the *separate* demo instance's
gateway container: it shares no docker network with this stack, so it never resolved here and
`Cloud API` only worked while a first-boot override happened to still be in place. Either way
the failure looks the same — every message fails and the operation sits in `Retry`:

```
ERROR #6059: Unable to open TCP/IP socket to server 127.0.0.1:52773
```

so **read the hostname in that error**: it names the target actually configured, which is the
fastest way to tell a wrong setting from a dead web server.

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

**Use `Triggers.cls` rather than the Management Portal.** Every row below is one call, each is
idempotent, each prints what it changed and what it is still waiting for, and
`Triggers.Reset()` undoes all of them:

```
do ##class(ProductionGuardian.LabDemo.Triggers).Status()          // what is armed
do ##class(ProductionGuardian.LabDemo.Triggers).ErrorRate()       // four findings at once
do ##class(ProductionGuardian.LabDemo.Triggers).Reset()           // undo everything
```

It refuses to act unless `ProductionGuardian.LabDemo.Production` is the running one, because
these toggles manipulate item names from `Production.cls` and would silently edit the wrong
thing otherwise (#34).

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
| `dead_host` | `do ##class(ProductionGuardian.LabDemo.Triggers).DeadHost()` | Absolute rule: fires on status `Disabled`. No baseline needed |
| `throughput_drop` | `...Triggers).ThroughputDrop()` — stops `EMR Source`, so it fires alone | Rate falls to 0, under the 0.4 baseline fraction. Needs baseline ≥ 0.1 msg/s — generating every 2 s gives 0.5 msg/s |
| `slow_processing` | `...Triggers).SlowProcessing()` — **no recompile**; the default is now **3000 ms**, not 1000 | Gate is the `Cloud API` floor, **raised to 1.5 s on 2026-08-27**, which beats 3× its ~0.05 s baseline. `SlowProcessing(1000)` measured 840 ms and is now **below the floor, so it induces nothing** — the method says so when you pass under **2000**. The warning boundary is deliberately above the 1.5 s floor rather than on it: the measured delay is ~0.84× what you arm, so the smallest armed value that actually reaches the floor is ~1786 ms, and a boundary at 1500 left 1500–1785 inducing nothing *and* printing no note. Why the floor moved: `PoolBottleneck()` throttles this same host to ~1.01 s per message, and that number is identical before and after Smart Resolve enlarges the pool, so the finding used to outlive the fix. See the `hostOverrides` note in `thresholds.json` |
| `growing_queue_wait` | Same `SlowProcessing()`; measured live at `7.04s is 5.0x baseline` | Messages wait behind the hung one. Floor is 0.15 s and 3× the ~0.03 s baseline, so a 1 s hang already clears it once traffic overlaps — **this one was never affected by the `slow_processing` floor change**, and it is the finding that still fires if you arm a smaller delay |
| `elevated_error_rate` | `...Triggers).ErrorRate()` — sets the closed port **and** all four timeouts together | Floor is 1.0 errors/min and 3× baseline. **The timeouts are the point:** at the default 15 s `FailureTimeout` each message burns 15 s before erroring, so the rate stays *under* the floor and nothing fires. With them at 1 s, measured live: `12.0 errors/min, 14x baseline` |
| `stalled_host` | `...Triggers).StalledHost()` — same toggle as `dead_host`, then wait | Needs no activity for `inactiveSeconds` (300) **while messages are queued** — so it takes **5 minutes**, and `requiresQueued` means an idle-but-empty host will not do |
| `queue_buildup` | `...Triggers).QueueBuildup()` — the same toggle as `ErrorRate()`, deliberately. **Disabling the host does NOT work**; see the caveat | Depth must exceed the floor of **50** *and* 5× baseline. Measured live: `Queue depth 110 is 14x baseline` against a baseline of 7.97 |
| `system_alert` | `...Triggers).SystemAlert()` | Writes an alert-severity entry **naming a host** — the name is what attributes it, so an alert about the instance produces nothing (#61). **`Alert on Error` does NOT work** (#57), and **`Reset()` cannot undo this one**: the proxy buffers alerts in memory, so restart it. Measured live at `info` severity — the only rule that produces one |

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
> | ratio | ceiling ~**2.18×** at the shipped `minBaselineSamples: 12`, under the 5× gate | **13.8×** — fires |
>
> So disabling `Cloud API` grew the queue 6 → 122 in silence, and the old `Run(80, 0.2)`
> instruction never worked. The closed-port trigger produced `Queue depth 110 is 14x
> baseline` live. A queue that builds **from idle** is still invisible, which is the open
> half of #43 — and it is the `dead_host`-adjacent case, where the queue is most obviously a
> problem. The ramp arithmetic is pinned in
> `services/detection-engine/test/baseline.test.ts`; the closed form is on #45 and the fix
> belongs with #25's thresholds ADR.
>
> **The 2.18× is not a constant** — it is `2N/(N−1)` for `N = minBaselineSamples`, so `24/11`
> at the shipped 12 and `2.087` at 24. Change that setting and this number moves; re-derive it
> rather than trusting the figure written here (#34, #45).
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

After any test, run **`Triggers.Reset()`**. It clears the injected delay, restores the port
and timeouts, and re-enables every host. The old instruction here was to remove a `hang`
from `PatientDemographicsOperation` and recompile — the delay is now a global the
operation reads at runtime, so there is nothing to leave behind in source.

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
