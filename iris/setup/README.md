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

**The path is on the IRIS instance's filesystem, not your shell's.** So it depends on where IRIS
runs, not on which OS you are typing from — under this repo's compose it is a container path
(`/opt/…`), and on a Windows-native instance it is a Windows path,
`"C:\repos\ProductionGuardian\iris\setup\EnableMetrics.cls"`. Write the backslashes as they are:
ObjectScript string literals do not treat `\` as an escape, so doubling them is what breaks it.
Nothing else in this file is shell-dependent — every command here is ObjectScript in a Terminal.

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
