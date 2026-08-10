# iris/setup — One-time IRIS Setup

Run these steps **once** in the demo namespace before starting the metrics proxy.

---

## Prerequisites

- IRIS for Health (or Health Connect) instance running locally or accessible.
- A namespace for LABDEMO (create one if needed: Management Portal → System Administration → Namespaces).
- The LABDEMO production loaded and **running** (see `../labdemo/README.md`).

---

## Step 1 — Import and run EnableMetrics

### Option A: Terminal (fastest)

```
// In a Terminal connected to the LABDEMO namespace:
do $system.OBJ.Load("/path/to/iris/setup/EnableMetrics.cls", "ck")
do ##class(ProductionGuardian.Setup.EnableMetrics).Run()
```

### Option B: Management Portal

1. Management Portal → System Explorer → Classes → Import
2. Browse to `iris/setup/EnableMetrics.cls` → Import
3. Open a Terminal in the LABDEMO namespace:
   ```
   do ##class(ProductionGuardian.Setup.EnableMetrics).Run()
   ```

---

## Step 2 — Add Ens.Activity.Operation.Local (if not already present)

The `Run()` method will tell you if this is needed. If it is:

1. Management Portal → Interoperability → Configure → Production
2. Click **+** (Add a New Config Item)
3. **Category:** Operations
4. **Class:** `Ens.Activity.Operation.Local`
5. **Item name:** `ActivityReporter`
6. Click **Apply** then **Start** the item.

---

## Step 3 — Verify

```
do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()
```

Expected output — all metrics listed as FOUND:

```
  FOUND:   iris_interop_queued
  FOUND:   iris_interop_avg_processing_time
  FOUND:   iris_interop_messages_per_sec
  FOUND:   iris_interop_messages_errored
  FOUND:   iris_interop_avg_queueing_time
  FOUND:   iris_last_activity
  FOUND:   iris_interop_hosts
  OK: /api/monitor/alerts returned JSON array
```

Once Verify() shows all green, the metrics proxy (`services/metrics-proxy/`) can be started.

---

## Credentials note

`Verify()` reads its IRIS credentials from globals:
```
set ^ProductionGuardian.Setup("IRISUser") = "YourUser"
set ^ProductionGuardian.Setup("IRISPass") = "YourPassword"
```
If those globals are not set it falls back to `_SYSTEM` / `SYS` — fine for a local demo instance, not for anything shared.
