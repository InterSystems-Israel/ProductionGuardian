/// One-time setup: enable interoperability metrics for the LABDEMO namespace.
///
/// Run from a Terminal session connected to the LABDEMO namespace:
///
///   do ##class(ProductionGuardian.Setup.EnableMetrics).Run()
///
/// Or paste the body directly into a Terminal prompt.
///
/// What this does:
///   1. Enables SAM (System Alerting and Monitoring) metric export for this namespace.
///   2. Enables per-production statistics collection.
///   3. Checks whether Ens.Activity.Operation.Local is already present in the
///      running production and reports if it still needs to be added manually.
///
/// After running, verify with:
///   do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()
Class ProductionGuardian.Setup.EnableMetrics
{

/// Main entry point. Run once per namespace.
ClassMethod Run() As %Status
{
    set sc = $$$OK
    write "=== Production Guardian — Enable Interop Metrics ===",!

    // Step 1: Enable SAM metric export for this namespace.
    // This makes iris_interop_* metrics appear in /api/monitor/metrics.
    write "Step 1: EnableSAMForNamespace ... "
    set sc1 = ##class(Ens.Util.Statistics).EnableSAMForNamespace()
    if $$$ISERR(sc1) {
        write "FAILED",!
        do $system.Status.DisplayError(sc1)
        set sc = sc1
    } else {
        write "OK",!
    }

    // Step 2: Enable per-production statistics (required for queue-depth and
    // processing-time metrics: iris_interop_queued, iris_interop_avg_processing_time).
    write "Step 2: EnableStatsForProduction ... "
    set sc2 = ##class(Ens.Util.Statistics).EnableStatsForProduction()
    if $$$ISERR(sc2) {
        write "FAILED",!
        do $system.Status.DisplayError(sc2)
        set sc = $$$ADDSC(sc, sc2)
    } else {
        write "OK",!
    }

    // Step 3: Remind operator to add Ens.Activity.Operation.Local if needed.
    // This operation must be present in the production to expose per-host
    // processing-time activity metrics. We can't add it programmatically here
    // because production modification requires a config change + restart.
    write "Step 3: Checking for Ens.Activity.Operation.Local ...",!
    do ..CheckActivityOperation()

    write !
    if $$$ISOK(sc) {
        write "Setup complete. Run Verify() to confirm metrics are live.",!
    } else {
        write "Setup completed with errors. Review output above.",!
    }
    quit sc
}

/// Check whether Ens.Activity.Operation.Local is configured in the current production.
/// Reports what it finds; does not modify anything.
ClassMethod CheckActivityOperation()
{
    // Get the name of the currently running production in this namespace.
    set prodName = ##class(Ens.Director).GetActiveProductionName()
    if prodName = "" {
        write "  WARNING: No production is currently running in this namespace.",!
        write "  Start the LABDEMO production first, then re-run this check.",!
        quit
    }

    write "  Active production: ", prodName, !

    // Check if any item in the production is of class Ens.Activity.Operation.Local.
    set found = 0
    set rs = ##class(%ResultSet).%New("Ens.Config.Production:EnumerateConfigItems")
    do rs.Execute(prodName)
    while rs.Next() {
        if rs.Data("ClassName") = "Ens.Activity.Operation.Local" {
            set found = 1
            write "  OK: Ens.Activity.Operation.Local is present as '", rs.Data("Name"), "'",!
        }
    }

    if 'found {
        write "  ACTION REQUIRED: Ens.Activity.Operation.Local is NOT in this production.",!
        write "  Add it via Management Portal: Production > [your production] > + Add Item",!
        write "  Class: Ens.Activity.Operation.Local  Name: ActivityReporter  (any name is fine)",!
        write "  This is required for iris_interop_avg_processing_time to appear in metrics.",!
    }
}

/// Verify that the expected interop metrics are present in /api/monitor/metrics.
/// Call after Run() and after the production is running with Ens.Activity.Operation.Local.
///
/// Requires the %Net.HttpRequest class (available in all IRIS instances).
ClassMethod Verify() As %Status
{
    write "=== Verifying interop metrics in /api/monitor/metrics ===",!

    // Build an HTTP request to the local /api/monitor/metrics endpoint.
    set req = ##class(%Net.HttpRequest).%New()
    set req.Server = "127.0.0.1"
    set req.Port = $get(^%SYS("WebServer","Port"), 52773)  // default IRIS private web server port
    set req.Https = 0
    // Use the _SYSTEM account only for local verification — never in production code.
    set req.Username = $get(^ProductionGuardian.Setup("IRISUser"), "_SYSTEM")
    set req.Password = $get(^ProductionGuardian.Setup("IRISPass"), "SYS")

    // Instances fronted by a web server serve the API under an instance prefix
    // (e.g. /iris4health_2024_1/api/monitor/...). Set this global to that prefix
    // if Verify() reports 404 against the bare path.
    set prefix = $get(^ProductionGuardian.Setup("WebAppPrefix"), "")
    set sc = req.Get(prefix _ "/api/monitor/metrics")
    if $$$ISERR(sc) {
        write "HTTP request failed: "
        do $system.Status.DisplayError(sc)
        quit sc
    }

    set body = req.HttpResponse.Data.Read(1000000)

    // Check for the two critical metric families.
    set checks = $listbuild(
        "iris_interop_queued",
        "iris_interop_avg_processing_time",
        "iris_interop_messages_per_sec",
        "iris_interop_messages_errored",
        "iris_interop_avg_queueing_time",
        "iris_last_activity",
        "iris_interop_hosts"
    )
    set allFound = 1
    set ptr = 0
    while $listnext(checks, ptr, metric) {
        if body [ metric {
            write "  FOUND:   ", metric, !
        } else {
            write "  MISSING: ", metric, !
            set allFound = 0
        }
    }

    // Check alerts endpoint separately.
    write !,"Checking /api/monitor/alerts ...",!
    set req2 = ##class(%Net.HttpRequest).%New()
    set req2.Server = req.Server
    set req2.Port = req.Port
    set req2.Https = 0
    set req2.Username = req.Username
    set req2.Password = req.Password
    set sc2 = req2.Get(prefix _ "/api/monitor/alerts")
    if $$$ISERR(sc2) {
        write "  FAILED to reach /api/monitor/alerts",!
    } else {
        set alertBody = req2.HttpResponse.Data.Read(10000)
        if alertBody [ "[" {
            write "  OK: /api/monitor/alerts returned JSON array",!
        } else {
            write "  WARNING: /api/monitor/alerts response does not look like a JSON array",!
            write "  First 200 chars: ", $extract(alertBody, 1, 200), !
        }
    }

    write !
    if allFound {
        write "All expected metrics found. Metrics proxy can now be started.",!
    } else {
        write "Some metrics are missing. Check:",!
        write "  - Is the production running?",!
        write "  - Was EnableSAMForNamespace() called in this namespace?",!
        write "  - Is Ens.Activity.Operation.Local in the production?",!
    }
    quit $$$OK
}

}
