# CLAUDE.md — iris/ and services/metrics-proxy/ (Dev A)

This file governs everything under `iris/**` and `services/metrics-proxy/**`.
It supplements (and is subordinate to) the root `CLAUDE.md`.

---

## 1. Area ownership

Developer A owns:

| Path | Purpose |
|---|---|
| `iris/setup/` | One-time ObjectScript setup scripts for the demo namespace |
| `iris/labdemo/` | LABDEMO production, HL7 generator, patient demographics pipeline |
| `services/metrics-proxy/` | Node.js proxy: polls `/api/monitor/metrics` + `/api/monitor/alerts`, exposes per-host JSON |

Do **not** touch `services/detection-engine/`, `apps/dashboard/`, `contracts/` (read only), or any root config shared with other devs without a PR.

---

## 2. IRIS setup context

Interoperability metrics require two one-time calls in the demo namespace:

```objectscript
do ##class(Ens.Util.Statistics).EnableSAMForNamespace()
do ##class(Ens.Util.Statistics).EnableStatsForProduction()
```

`Ens.Activity.Operation.Local` must also be added to the production (provides `iris_interop_avg_processing_time`).

The setup class handles all of this: `do ##class(ProductionGuardian.Setup.EnableMetrics).Run()`  
Verification: `do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()`

See `iris/setup/README.md` for the full walkthrough.

---

## 3. LABDEMO production — current pipeline

The production has been fully built and extended. The pipeline is:

```
EMRSource → LabRouter → PIDExtractProcess → PatientDemographicsOperation
(HL7 file)  (routing)   (DTL: PID extract)  (HTTP POST)
                                                   ↓
                                         PatientDispatcher (REST API)
                                                   ↓
                                         PatientRecord table (upsert by PatientID)
```

### 3.1 All files and classes

| File | Class | Purpose |
|---|---|---|
| `labdemo/Production.cls` | `ProductionGuardian.LabDemo.Production` | 4-item production + ActivityReporter |
| `labdemo/RoutingRule.cls` | `ProductionGuardian.LabDemo.RoutingRule` | Routes ADT^A01 + ORU^R01 → PIDExtractProcess |
| `labdemo/Process/PIDExtractProcess.cls` | `ProductionGuardian.LabDemo.Process.PIDExtractProcess` | BP: applies HL7ToPID DTL, async-forwards PatientDemographics |
| `labdemo/Transform/HL7ToPID.cls` | `ProductionGuardian.LabDemo.Transform.HL7ToPID` | DTL: maps PID-3/5/7/8/11/13 + MSH-10 to PatientDemographics |
| `labdemo/Message/PatientDemographics.cls` | `ProductionGuardian.LabDemo.Message.PatientDemographics` | Ens.Request: PatientID, name, DOB, sex, address, phone, sourceMessageID |
| `labdemo/Operation/PatientDemographicsOperation.cls` | `ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation` | BO: JSON POST to /labdemo/patients via EnsLib.HTTP.OutboundAdapter |
| `labdemo/REST/PatientDispatcher.cls` | `ProductionGuardian.LabDemo.REST.PatientDispatcher` | %CSP.REST — POST/GET /labdemo/patients |
| `labdemo/Data/PatientRecord.cls` | `ProductionGuardian.LabDemo.Data.PatientRecord` | %Persistent table, unique index on PatientID, `Upsert()` class method |
| `labdemo/HL7Generator.cls` | `ProductionGuardian.LabDemo.HL7Generator` | Writes synthetic ADT^A01 .hl7 files to the file drop dir |
| `labdemo/FHIRRoutingRule.cls` | `ProductionGuardian.LabDemo.FHIRRoutingRule` | **Deprecated stub — do not load or reference** |

### 3.2 Production item names (exact — these appear in proxy JSON)

| Item name | Class | Role |
|---|---|---|
| `EMRSource` | `EnsLib.HL7.Service.FileService` | Reads `.hl7` files from `C:\Practice\IN\HL7` |
| `LabRouter` | `EnsLib.HL7.MsgRouter.RoutingEngine` | Routes to PIDExtractProcess |
| `PIDExtractProcess` | `ProductionGuardian.LabDemo.Process.PIDExtractProcess` | DTL transform BP |
| `PatientDemographicsOperation` | `ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation` | REST POST to 127.0.0.1:52773 |
| `ActivityReporter` | `Ens.Activity.Operation.Local` | Exposes processing-time metrics |

**File drop path (Windows):** `C:\Practice\IN\HL7` — archive: `C:\Practice\ARCHIVE`.  
Change `FilePath` / `ArchivePath` in `Production.cls` if your path differs.

### 3.3 Load order

```objectscript
do $system.OBJ.LoadDir("/path/to/iris/labdemo/", "ckr")
// The 'r' flag recurses into Message/, Process/, Transform/, etc.
```

### 3.4 REST web application — one manual step required

Before `PatientDemographicsOperation` can POST, register the web app in IRIS Management Portal:

> System Administration → Security → Applications → Web Applications → Create New  
> - Path: `/labdemo`  
> - Namespace: `LABDEMO`  
> - Enable: REST  
> - Dispatch class: `ProductionGuardian.LabDemo.REST.PatientDispatcher`

This is portal-only — cannot be done in code.

### 3.5 REST API endpoints

Base: `http://localhost:52773/labdemo`

| Method | Path | Description |
|---|---|---|
| `POST` | `/patients` | Upsert patient by PatientID |
| `GET` | `/patients/:id` | Get one patient |
| `GET` | `/patients` | List patients (`?offset=0&limit=50`) |
| `GET` | `/patients/count` | Total record count |

### 3.6 Key design decisions

- `PIDExtractProcess` uses `SendRequestAsync` — non-blocking for LabRouter throughput.
- `PatientRecord` upsert uses the unique index `PatientIDIndex` — one `%OpenId` call, no SQL overhead.
- `PatientDemographicsOperation` targets `127.0.0.1:52773` — change `HTTPPort` in Production.cls if IRIS uses a different web port.
- `FHIRRoutingRule.cls` cannot be deleted from source control; it is a blank deprecated stub. Never import it.

---

## 4. Metrics proxy conventions

- Language: **Node.js**, plain CommonJS (no transpilation).
- Port: **3001** (never change without updating root `CLAUDE.md` §5).
- Poll `/api/monitor/metrics` every **10 s**; `/api/monitor/alerts` every **30 s**.
- Parser lives in `src/parser.js` — hand-rolled Prometheus text format, no external parser library.
- Output schema will be published to `contracts/proxy-schema.json` (read-only after Day 1 freeze).
- Credentials via env vars only: `IRIS_HOST`, `IRIS_PORT`, `IRIS_USER`, `IRIS_PASS`, `IRIS_NAMESPACE`.

### 4.1 Proxy JSON output shape

```json
{
  "hosts": [
    {
      "host": "EMRSource",
      "type": "service",
      "status": "Active",
      "queued": 0,
      "messagesPerSec": 0.5,
      "errored": 0,
      "avgProcessingTime": 0.012,
      "avgQueueingTime": 0.001,
      "lastActivity": "2026-08-10T08:00:00.000Z"
    }
  ],
  "systemAlertsNew": 0,
  "_meta": { "polledAt": "2026-08-10T08:00:00.000Z" }
}
```

`type` values: `"service"` | `"process"` | `"operation"` | `"unknown"` (from IRIS SAM label: BS/BP/BO).  
`lastActivity` is ISO 8601 UTC converted from Unix epoch; never a raw integer.

### 4.2 Running locally

```bash
cd services/metrics-proxy
cp .env.example .env   # fill in IRIS_HOST, IRIS_PORT, IRIS_USER, IRIS_PASS
npm install
npm start              # real IRIS

npm run mock           # mock mode — fixture data, no IRIS needed
node --test src/parser.test.js   # 13 unit tests, all passing
```

---

## 5. What still needs to be done (Dev A remaining tasks)

| Task | Status | Notes |
|---|---|---|
| Enable + verify metrics | ✅ Done | `EnableMetrics.cls` built and tested |
| LABDEMO production | ✅ Done | Full pipeline with patient demographics REST upsert |
| Metrics proxy + parser | ✅ Done | All 8 metric types, 13 tests pass |
| Alerts forwarding | ✅ Done | `/proxy/alerts` endpoint live |
| Publish proxy JSON schema to `contracts/` | ⏳ Pending | **Day 1 blocker for Dev B** — write `contracts/proxy-schema.json` |
| Finding-trigger toggles | ⏳ Pending | `iris/labdemo/triggers/` — not yet built; needed Day 3 |

---

## 6. Dev A acceptance criteria (from spec §3)

1. Proxy returns documented per-host JSON within 2 s of poll. *(proxy built; needs live IRIS test)*
2. Parser handles all 8 metric types listed in spec §1.3. ✅ *13 unit tests pass*
3. Each of the 8 finding types can be induced on demand via trigger toggles. *(trigger toggles not yet built)*
4. `/api/monitor/alerts` forwarded as JSON at `/proxy/alerts`. ✅ *wired in poller + router*
