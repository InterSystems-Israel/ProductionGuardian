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
///
/// Verify() builds its own URL for the local monitor API. Where that API lives is
/// instance-specific, so three optional globals override the defaults:
///
///   ^ProductionGuardian.Setup("WebAppPrefix")  path in front of /api/monitor/  (default "")
///   ^ProductionGuardian.Setup("WebHost")       host to request                 (default 127.0.0.1)
///   ^ProductionGuardian.Setup("WebPort")       port to request                 (default: see WebPort())
///
/// Set them to match the URL that already works in a browser. This mirrors the
/// metrics proxy's IRIS_BASE_PATH / IRIS_HOST / IRIS_PORT — same problem, same fix:
///
///   http://localhost:52773/api/monitor/metrics        -> all three defaults are fine
///   http://localhost/iris4health_2024_1/api/monitor/  -> WebAppPrefix="/iris4health_2024_1", WebPort=80
Class ProductionGuardian.Setup.EnableMetrics
{

/// Main entry point. Run once per namespace.
///
/// `pProductionName` is the production step 3 should inspect. Pass it when calling this
/// BEFORE that production is started -- otherwise the check reads whichever production is
/// active, which on a fresh container is the image's own `LABDEMOPKG.FoundationProduction`,
/// and it then reports ACTION REQUIRED for an item our production already contains.
/// Empty means "whatever is running", which is right for an interactive re-run.
ClassMethod Run(pProductionName As %String = "") As %Status
{
    set sc = $$$OK
    // ASCII only. This banner used to carry an em-dash and printed as
    // `=== Production Guardian ? Enable Interop Metrics ===` in a container terminal, which
    // is the same mojibake family as #81 arriving through ObjectScript source instead of
    // markdown. Terminal output has no encoding negotiation, so keep it to ASCII.
    write "=== Production Guardian - Enable Interop Metrics ===",!

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
    do ..CheckActivityOperation(pProductionName)

    write !
    if $$$ISOK(sc) {
        write "Setup complete. Run Verify() to confirm metrics are live.",!
    } else {
        write "Setup completed with errors. Review output above.",!
    }
    quit sc
}

/// Check whether Ens.Activity.Operation.Local is configured in a production.
/// Reports what it finds; does not modify anything.
///
/// `pProductionName` names the production to inspect. It is a parameter rather than always
/// "whatever is running" because this check is useful BEFORE the production starts, and
/// reading the active one there is actively misleading: on a fresh container the active
/// production is the image's `LABDEMOPKG.FoundationProduction`, which of course does not
/// contain our activity reporter, so the check printed a confident ACTION REQUIRED telling
/// an operator to add an item that `Production.cls` already ships. Reported by @tanifgit on
/// the first cold compose run (#78) -- verified harmless (all 10 iris_interop_* families
/// appear once traffic flows) but wrong at the moment a first-time operator is least able to
/// judge it. EnumerateConfigItems works on a DEFINED production, running or not.
ClassMethod CheckActivityOperation(pProductionName As %String = "")
{
    set prodName = pProductionName
    if prodName = "" {
        set prodName = ##class(Ens.Director).GetActiveProductionName()
    }
    if prodName = "" {
        write "  WARNING: No production is currently running in this namespace.",!
        write "  Start the LABDEMO production first, then re-run this check.",!
        quit
    }

    write "  Checking production: ", prodName, !

    // Check if any item in the production is of class Ens.Activity.Operation.Local.
    set found = 0
    set rs = ##class(%ResultSet).%New("Ens.Config.Production:EnumerateConfigItems")
    do rs.Execute(prodName)
    while rs.Next() {
        if rs.Data("ClassName") = "Ens.Activity.Operation.Local" {
            set found = 1
            // ConfigName, not Name. EnumerateConfigItems returns 13 columns and the item
            // name is ConfigName -- rs.Data("Name") is undefined, so this line threw
            // <UNDEFINED> for anyone who ran the documented verification against a
            // production that DID have the activity reporter, i.e. the success path only.
            // Found by FirstBoot.cls calling this method (#72).
            write "  OK: Ens.Activity.Operation.Local is present as '", rs.Data("ConfigName"), "'",!
        }
    }

    if 'found {
        write "  ACTION REQUIRED: Ens.Activity.Operation.Local is NOT in this production.",!
        write "  Add it via Management Portal: Production > [your production] > + Add Item",!
        write "  Class: Ens.Activity.Operation.Local  Name: ActivityReporter  (any name is fine)",!
        write "  This is required for iris_interop_avg_processing_time to appear in metrics.",!
    }
}

/// Path prefix in front of /api/monitor/, or "" when the API is at the web server root.
/// On an instance fronted by an external web server the instance name is a path segment,
/// e.g. http://localhost/iris4health_2024_1/api/monitor/metrics — requesting the bare
/// path there returns the web server's 404, which reads as "metrics are not enabled" on
/// an instance where they are working correctly.
ClassMethod WebAppPrefix() As %String
{
    set prefix = $get(^ProductionGuardian.Setup("WebAppPrefix"), "")
    quit:prefix="" ""
    // Normalise to leading-slash, no-trailing-slash so path joining stays predictable.
    set prefix = $zstrip(prefix, ">", "/")
    quit $case($extract(prefix), "/": prefix, : "/" _ prefix)
}

/// Host to request the monitor API on. 127.0.0.1 is right for an instance whose web
/// server shares its network namespace; a containerised instance reaching a gateway
/// web server needs the override.
ClassMethod WebHost() As %String
{
    quit $get(^ProductionGuardian.Setup("WebHost"), "127.0.0.1")
}

/// Port to request the monitor API on.
///
/// ^%SYS("WebServer","Port") is NOT a safe source for this. On an instance served by an
/// external web server that node exists and holds 0 — so `$get(...,52773)` returns 0, not
/// the default, and the request fails with "Unable to open TCP/IP socket to ...:0". A
/// $get default only applies when the node is undefined, and this node is defined-but-zero.
ClassMethod WebPort() As %Integer
{
    set port = $get(^ProductionGuardian.Setup("WebPort"), "")
    quit:+port>0 +port
    set sysPort = $get(^%SYS("WebServer","Port"), 0)
    quit $select(+sysPort>0: +sysPort, 1: 52773)
}

/// Verify that the expected interop metrics are present in /api/monitor/metrics.
/// Call after Run() and after the production is running with Ens.Activity.Operation.Local.
///
/// Requires the %Net.HttpRequest class (available in all IRIS instances).
ClassMethod Verify() As %Status
{
    set prefix = ..WebAppPrefix()
    set host = ..WebHost()
    set port = ..WebPort()

    write "=== Verifying interop metrics in /api/monitor/metrics ===",!
    // Print the URL actually requested. A wrong prefix or port is otherwise invisible at
    // the one moment you would want to see it.
    write "Requesting: http://", host, ":", port, prefix, "/api/monitor/metrics",!

    set req = ##class(%Net.HttpRequest).%New()
    set req.Server = host
    set req.Port = port
    set req.Https = 0
    // Use the _SYSTEM account only for local verification — never in production code.
    set req.Username = $get(^ProductionGuardian.Setup("IRISUser"), "_SYSTEM")
    set req.Password = $get(^ProductionGuardian.Setup("IRISPass"), "SYS")

    set sc = req.Get(prefix _ "/api/monitor/metrics")
    if $$$ISERR(sc) {
        write "HTTP request failed: "
        do $system.Status.DisplayError(sc)
        do ..WriteURLHint()
        quit sc
    }

    // A reachable web server that does not serve this path answers 404 with an OK status —
    // Get() only errors when the socket itself fails. Without this check the 404 body is
    // scanned for metric names, every one is reported MISSING, and the operator is sent to
    // re-run EnableSAMForNamespace() when the real fault is the URL.
    set status = req.HttpResponse.StatusCode
    if (status < 200) || (status > 299) {
        write "  FAILED: HTTP ", status, " — the monitor API is not at this URL.",!
        do ..WriteURLHint()
        quit $$$ERROR($$$GeneralError, "GET " _ prefix _ "/api/monitor/metrics returned HTTP " _ status)
    }

    set body = req.HttpResponse.Data.Read(1000000)

    // The seven families the metrics proxy consumes. Names must match the metric text
    // exactly: the last-activity family is iris_interop_last_activity, and the bare
    // iris_last_activity this list used to carry appears nowhere in the output, so it
    // reported MISSING on a healthy instance.
    set checks = $listbuild("iris_interop_queued", "iris_interop_avg_processing_time", "iris_interop_messages_per_sec", "iris_interop_messages_errored", "iris_interop_avg_queueing_time", "iris_interop_last_activity", "iris_interop_hosts")
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

    // A 200 carrying no iris_interop_* at all is the quiet failure: on port 80 without a
    // prefix you reach the %SYS namespace's monitor web app, which answers with several
    // hundred lines of real system metrics and not one interop family. Nothing looks
    // broken; you simply get no hosts.
    if '(body [ "iris_interop_") {
        write !,"  NOTE: this response has no iris_interop_* families at all.",!
        write "  That is what a monitor API in the wrong namespace looks like — the request",!
        write "  succeeded, but against a namespace with no interoperability metrics.",!
        do ..WriteURLHint()
    }

    // Check alerts endpoint separately.
    //
    // Reading /api/monitor/alerts CLEARS the alerts it returns; only mgr/alerts.log keeps
    // them. This call therefore steals any pending alerts from the metrics proxy, which
    // cannot get them back. Run Verify() before starting the proxy, not alongside it.
    write !,"Checking /api/monitor/alerts (consume-on-read — see comment) ...",!
    set req2 = ##class(%Net.HttpRequest).%New()
    set req2.Server = req.Server
    set req2.Port = req.Port
    set req2.Https = 0
    set req2.Username = req.Username
    set req2.Password = req.Password
    set sc2 = req2.Get(prefix _ "/api/monitor/alerts")
    if $$$ISERR(sc2) {
        write "  FAILED to reach /api/monitor/alerts",!
    } elseif (req2.HttpResponse.StatusCode < 200) || (req2.HttpResponse.StatusCode > 299) {
        write "  FAILED: /api/monitor/alerts returned HTTP ", req2.HttpResponse.StatusCode, !
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
        write "  - Is the URL above the one that works in your browser?",!
        write "  - Is the production running?",!
        write "  - Was EnableSAMForNamespace() called in this namespace?",!
        write "  - Is Ens.Activity.Operation.Local in the production?",!
    }
    quit $$$OK
}

/// Print how to point Verify() at the URL that actually serves the monitor API.
ClassMethod WriteURLHint()
{
    write "  Open /api/monitor/metrics in a browser, then set the globals to match it:",!
    write "    set ^ProductionGuardian.Setup(""WebAppPrefix"") = ""/iris4health_2024_1""",!
    write "    set ^ProductionGuardian.Setup(""WebPort"")      = 80",!
    write "    set ^ProductionGuardian.Setup(""WebHost"")      = ""127.0.0.1""",!
    write "  These mirror the metrics proxy's IRIS_BASE_PATH / IRIS_PORT / IRIS_HOST.",!
}

}
