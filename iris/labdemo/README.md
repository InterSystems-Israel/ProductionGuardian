# iris/labdemo — LABDEMO Production

The LABDEMO production provides a running HL7 lab pipeline that Health Scan monitors.
Four components model a realistic path from EMR to cloud FHIR API.

```
EMRSource  →  LabRouter  →  FHIRTransform  →  CloudAPI
(HL7 file)    (routing)      (pass-through)    (HTTP out)
```

---

## Load order

Import all `.cls` files in this order (or let IRIS resolve dependencies):

```bash
# From a Terminal in the LABDEMO namespace:
do $system.OBJ.LoadDir("/path/to/iris/labdemo/", "ck")
```

Or import individually:
1. `RoutingRule.cls`
2. `FHIRRoutingRule.cls`
3. `HL7Generator.cls`
4. `Production.cls`

---

## Start the production

```
do ##class(Ens.Director).StartProduction("ProductionGuardian.LabDemo.Production")
```

Or via Management Portal: Interoperability → Configure → Production → Start.

---

## Start message flow

The EMRSource polls `/tmp/labdemo/hl7-in/` every 2 seconds.
Use the HL7Generator to put messages there:

```
// 20 messages, 2-second gaps:
do ##class(ProductionGuardian.LabDemo.HL7Generator).Run()

// Continuous (Ctrl-C to stop):
do ##class(ProductionGuardian.LabDemo.HL7Generator).RunContinuous(2)
```

Messages are archived to `/tmp/labdemo/hl7-archive/` after processing.

---

## Component reference

| Name | Class | Purpose |
|---|---|---|
| `EMRSource` | `EnsLib.HL7.Service.FileService` | Reads `.hl7` files from drop dir |
| `LabRouter` | `EnsLib.HL7.MsgRouter.RoutingEngine` | Routes ADT/ORU to FHIRTransform |
| `FHIRTransform` | `EnsLib.MsgRouter.RoutingEngine` | Passes messages to CloudAPI |
| `CloudAPI` | `EnsLib.HTTP.OutboundAdapter` | HTTP POST to localhost:9999/fhir/r4 |
| `ActivityReporter` | `Ens.Activity.Operation.Local` | Exposes processing-time metrics |

**Note on CloudAPI:** The downstream endpoint (localhost:9999) is intentionally not running by default.
This means CloudAPI will log errors — which is useful for Health Scan testing (error-rate finding).
To stop the errors: start a simple HTTP listener on port 9999, or disable CloudAPI from the portal.

---

## Inducing findings (for Health Scan testing)

See `iris/labdemo/triggers/` (created in a later task) for scripts that induce each of the 8 finding types on demand.

Quick manual methods:
- **Dead host** — disable EMRSource from the portal.
- **Error rate** — CloudAPI errors naturally (localhost:9999 not running).
- **Queue buildup** — suspend FHIRTransform and run the generator at high rate.
- **Stalled host** — pause LabRouter from the portal.

---

## Verify

After starting the production, run the metrics verification:

```
do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()
```

You should see `iris_interop_queued` and all other metrics as FOUND.
