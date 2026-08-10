# iris/labdemo — LABDEMO Production

The LABDEMO production models a realistic HL7 lab message pipeline that Health Scan monitors.

```
EMR Source  →  Lab Router  →  Cloud API
(HL7 file)     (routing +      (HTTP POST → PatientDispatcher)
                PID extract)              ↓
                               PatientRecord table (upsert by PatientID)
```

**Item names carry spaces.** They are the join key between the proxy's host list and the
findings API (`contracts/healthscan-api.md` Q8) — the `host` label in `/api/monitor/metrics`
is the config item name verbatim, and it must stay byte-equal to
`contracts/samples/hosts-response.json`. Renaming an item silently breaks every finding
that refers to it.

---

## File inventory

| File | Purpose |
|---|---|
| `Production.cls` | Production definition — 3 items + `Ens.ActivityReporter` |
| `RoutingRule.cls` | Routes ADT^A01 to Cloud API, applying the HL7ToPID DTL on the send |
| `Transform/HL7ToPID.cls` | DTL: HL7 PID segment → PatientDemographics message |
| `Message/PatientDemographics.cls` | Ens.Request carrying extracted PID fields |
| `Operation/PatientDemographicsOperation.cls` | BO: HTTP POST to REST dispatcher — the "Cloud API" item |
| `REST/PatientDispatcher.cls` | %CSP.REST dispatcher — POST/GET /labdemo/patients |
| `Data/PatientRecord.cls` | %Persistent table — upsert keyed on PatientID |
| `HL7Generator.cls` | Writes synthetic ADT .hl7 files to drop dir |
| `Process/PIDExtractProcess.cls` | **Not a production item** — kept as a BP-transform reference |

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

Click **Save**. The API is now live at `http://localhost:52773/labdemo/patients`.

### 2 — Load all classes

```
// From a Terminal in the LABDEMO namespace:
do $system.OBJ.LoadDir("/path/to/iris/labdemo/", "ckr",,1)
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
// 20 messages, 2-second gaps (all ADT^A01):
do ##class(ProductionGuardian.LabDemo.HL7Generator).Run()

// Continuous until Ctrl-C:
do ##class(ProductionGuardian.LabDemo.HL7Generator).RunContinuous(2)
```

Each message flows:
1. Written to `C:\Practice\IN\HL7` as a `.hl7` file
2. EMR Source picks it up and sends to Lab Router
3. Lab Router runs the HL7ToPID DTL — extracts PatientID, name, DOB, sex, address, phone — and routes the result to Cloud API
4. Cloud API HTTP-POSTs the JSON to `/labdemo/patients`
5. PatientDispatcher upserts the record in `PatientRecord` (insert first time, update thereafter)

---

## REST API reference

Base URL: `http://localhost:52773/labdemo`

| Method | Path | Description |
|---|---|---|
| `POST` | `/patients` | Upsert patient by PatientID |
| `GET` | `/patients/:id` | Get one patient by PatientID |
| `GET` | `/patients` | List patients (`?offset=0&limit=50`) |
| `GET` | `/patients/count` | Total record count |

Example — query a patient directly:
```bash
curl http://localhost:52773/labdemo/patients/123456
```

Example — check total count:
```bash
curl http://localhost:52773/labdemo/patients/count
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

| Finding type | How to induce |
|---|---|
| Dead / inactive host | Disable "EMR Source" from Management Portal |
| Elevated error rate | Misconfigure "Cloud API" HTTPPort to a closed port |
| Queue buildup | Suspend "Cloud API"; run generator at a fast rate |
| Stalled host | Pause "Lab Router" from Management Portal |
| Slow processing | Add a `hang 5` to `PatientDemographicsOperation.OnMessage` temporarily |
| Throughput drop | Stop the HL7Generator |

`queue_buildup` will not currently produce a finding even when the queue is genuinely
deep — per-host queue depth is not in `/api/monitor/metrics`. See issue #12.

---

## Verify metrics

```
do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()
```

All 7 metric families should show FOUND after the production is running with messages flowing.
