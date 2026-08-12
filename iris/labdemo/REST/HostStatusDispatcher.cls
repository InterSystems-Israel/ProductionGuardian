/// Per-host interoperability state as JSON, for the metrics proxy to merge into
/// /proxy/metrics by host name.
/// 
/// This exists because two of the eight Health Scan finding types cannot fire from
/// /api/monitor/metrics alone. Both `iris_interop_queued` and
/// `iris_interop_messages_errored` are emitted ONCE PER PRODUCTION, with labels `id`
/// and `production` only — neither carries a `host` label, so per-host queue depth and
/// per-host error counts are simply not in the Prometheus text. `queue_buildup` (#12)
/// and `elevated_error_rate` (#31) are blocked by that same gap.
/// 
/// The data does exist in IRIS, in a different place: `Ens.Util.Statistics`'s
/// `EnumerateHostStatus` query. This class wraps it, adds per-host error counts from
/// `Ens.MessageHeader`, and publishes both keyed by the config item name.
/// 
/// URL map (registered in the web application configuration):
/// 
///   GET /labdemo/monitor/hoststatus  — per-host queue depth, status and error counts
/// 
/// Register this dispatcher under its OWN CSP web application — see ../README.md §1b, not
/// §1. A CSP application maps one path to one dispatch class, so this cannot share
/// PatientDispatcher's `/labdemo`; pointing `/labdemo` here would break the patients API,
/// and the endpoint would then answer at `/labdemo/hoststatus` while the proxy polls
/// `/labdemo/monitor/hoststatus` — a 404 that surfaces only as `queued`/`errored` staying
/// `null`, which looks like an idle production rather than a misconfiguration.
///   Management Portal → System Administration → Security → Applications → Web Applications
///   Path: /labdemo/monitor  →  Dispatch class: ProductionGuardian.LabDemo.REST.HostStatusDispatcher
///   Namespace: LABDEMO
/// 
/// READ-ONLY. This class reads host state and counts rows; it never writes, never
/// changes an item setting, and never starts or stops anything.
Class ProductionGuardian.LabDemo.REST.HostStatusDispatcher Extends %CSP.REST
{

Parameter CONTENTTYPE = "application/json";

/// All responses are JSON; CORS is open for the demo dashboard.
Parameter HandleCorsRequest = 1;

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/hoststatus" Method="GET" Call="GetHostStatus"/>
</Routes>
}

/// Message header Status code meaning "Error".
/// 
/// Not a guess: read from the compiled property. `Ens.MessageHeader:Status` is an
/// `Ens.DataType.MessageStatus` whose VALUELIST is `,1,2,3,4,5,6,7,8,9` against
/// DISPLAYLIST `,Created,Queued,Delivered,Discarded,Suspended,Deferred,Aborted,Error,Completed`
/// — so 8 is Error and 9 is Completed. Hard-coding the display name in SQL instead
/// would compare against the stored code and silently match nothing.
Parameter MSGSTATUSERROR = 8;

// ── GET /hoststatus ───────────────────────────────────────────────────────────

/// Per-host state the Prometheus text cannot supply.
/// 
/// Response shape — an array of hosts plus a small _meta:
/// {
///   "hosts": [
///     { "host": "Cloud API", "status": "OK", "queued": 0, "errored": 0, "messageCount": 17488 }
///   ],
///   "_meta": {
///     "sampledAt":       "2026-08-12T10:57:44.123Z",
///     "production":      "LABDEMO.Production",
///     "productionState": "Running",
///     "hostCount":       13,
///     "erroredAvailable": true
///   }
/// }
/// 
/// `host` is the join key and is published EXACTLY as IRIS holds it — spaces intact
/// ("Cloud API", not "CloudAPI"). That is what makes the proxy-side merge work with no
/// normalization on either side: `EnumerateHostStatus`'s `Name` column and the metrics
/// `host` label are the same string.
ClassMethod GetHostStatus() As %Status
{
    set sc = $$$OK
    try {
        set sampledAt = ..UTCTimestamp()

        // Error counts first: one aggregate query, then a lookup per host. Doing it the
        // other way (a COUNT per host) is a full Status-index scan per host.
        set erroredAvailable = ..ErroredByHost(.errored)

        set hosts = []
        set hostCount = 0

        set rs = ##class(%ResultSet).%New("Ens.Util.Statistics:EnumerateHostStatus")
        set scQuery = rs.Execute()
        if $$$ISERR(scQuery) {
            do ..WriteErrorResponse(500, $system.Status.GetErrorText(scQuery))
            quit
        }

        while rs.Next() {
            set name = rs.Get("Name")
            set hostCount = hostCount + 1

            // `Queue` is the EMPTY STRING for an idle host, not "0". Verified in the
            // shipped source of EnumerateHostStatusFetch:
            //   Set tQueueCount=$G($$$EnsQueue(qHandle,0,"count"))
            //   If tQueueCount=0 Set tQueueCount=""
            // So empty means a real measured zero — the global was read and held 0 — and
            // coercing with + is correct here. A truthiness test would read the same
            // empty string as "no value", which is the opposite of what it means.
            set queued = +rs.Get("Queue")

            // Resolved into locals rather than called inline in the literal below:
            // a ByRef argument cannot be passed from inside a JSON literal.
            // "" (JSON null), not 0, when the per-host error count could not be
            // obtained — the proxy's "absent is not zero" invariant depends on an
            // unmeasurable value never arriving as a measurement.
            set errCount = ""
            if erroredAvailable { set errCount = $get(errored(name), 0) }

            do hosts.%Push({
                "host":   (name),
                "status": (rs.Get("Status")),
                "queued": (queued),
                "errored": (errCount),
                "messageCount": (+rs.Get("Count"))
            })
        }
        do rs.Close()

        set meta = {}
        set meta.sampledAt = sampledAt
        set meta.production = ##class(Ens.Director).GetActiveProductionName()
        set meta.productionState = ..ProductionState()
        set meta.hostCount = hostCount
        // %Set with an explicit "boolean" type: a bare 1/0 assignment serializes as a
        // JSON NUMBER, so this field would otherwise be `1` where the contract says
        // `true`.
        do meta.%Set("erroredAvailable", erroredAvailable, "boolean")

        set %response.Status = "200 OK"
        do ..WriteJSON({
            "hosts": (hosts),
            "_meta": (meta)
        })

    } catch ex {
        do ..WriteErrorResponse(500, ex.DisplayString())
        set sc = ex.AsStatus()
    }
    quit sc
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Per-host errored message counts, into `pErrored(<correctly cased host name>)`.
/// Returns 1 when the counts were obtained, 0 when the query failed.
/// 
/// The subtlety is the key casing. `SELECT TargetConfigName ... GROUP BY TargetConfigName`
/// returns the name UPPERCASED — measured live: `CLOUD API`, `LAB ROUTER`. That is a
/// GROUP BY collation artifact, not a property transform: `Ens.MessageHeader` collates
/// `TargetConfigName` with %SQLUPPER, so the grouping key is the uppercased form and it
/// is the key that comes back. A plain (ungrouped) SELECT of the same column returns
/// the correct case.
/// 
/// Uppercased keys cannot be joined against the metrics `host` label, and uppercasing
/// the label to match would be a guess about how IRIS folds case. So the aggregate is
/// re-keyed here on `%EXACT(TargetConfigName)`, which suppresses the collation and
/// yields the stored spelling — the same string `EnumerateHostStatus` reports.
ClassMethod ErroredByHost(ByRef pErrored) As %Boolean [ Private ]
{
    kill pErrored
    set sql = "SELECT %EXACT(TargetConfigName) AS Host, COUNT(*) AS Errored "
            _ "FROM Ens.MessageHeader WHERE Status = ? GROUP BY %EXACT(TargetConfigName)"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, ..#MSGSTATUSERROR)
    if '$isobject(rs) { quit 0 }
    while rs.%Next() {
        set host = rs.%Get("Host")
        if host '= "" { set pErrored(host) = +rs.%Get("Errored") }
    }
    // Checked AFTER iterating: %SQLCODE is 100 (no more rows) at the end of a
    // successful result set and only negative on a real error.
    if rs.%SQLCODE < 0 { quit 0 }
    quit 1
}

/// Current production state as a word, for the "no rows" case.
/// 
/// `EnumerateHostStatus` returns ZERO ROWS when the production is stopped, which is
/// indistinguishable from "this production has no hosts" in the payload alone. This
/// field is what lets the proxy tell the two apart rather than publishing an empty host
/// list as though it were a measurement.
ClassMethod ProductionState() As %String [ Private ]
{
    set sc = ##class(Ens.Director).GetProductionStatus(.name, .stateCode)
    if $$$ISERR(sc) { quit "Unknown" }
    // Ens.Director state codes: 1 Running, 2 Stopped, 3 Suspended, 4 Troubled.
    if stateCode = 1 { quit "Running" }
    elseif stateCode = 2 { quit "Stopped" }
    elseif stateCode = 3 { quit "Suspended" }
    elseif stateCode = 4 { quit "Troubled" }
    quit "Unknown"
}

/// Sample time as ISO 8601 UTC, millisecond precision, matching what the proxy publishes.
/// 
/// The `7` timezone argument ALREADY appends the `Z`, so concatenating one produces
/// `...:54ZZ` — measured, and it is not a parse error in JS (`new Date()` accepts it),
/// which is exactly why it would have survived into the samples. The `3` at the end is
/// fractional-second digits, so this matches `toISOString()`'s milliseconds.
ClassMethod UTCTimestamp() As %String [ Private ]
{
    quit $zdatetime($ztimestamp, 3, 7, 3)
}

/// Write a %DynamicObject as the response body.
/// 
/// `%ToJSON()` takes no argument here on purpose: with none it writes to the current
/// device, which inside a %CSP.REST request is the CSP output stream. Passing
/// `%response.Output` — as `PatientDispatcher.WriteJSON` does — fails at runtime with
/// `<PROPERTY DOES NOT EXIST> *Output,%CSP.Response`, because %CSP.Response has no such
/// property on IRIS 2026.1. Measured: that call returned HTTP 500 from this endpoint
/// before the fix. PatientDispatcher has the same latent defect on its POST/GET paths.
ClassMethod WriteJSON(dyn As %DynamicObject) [ Private ]
{
    set %response.ContentType = "application/json"
    do dyn.%ToJSON()
}

/// Write a JSON error response.
ClassMethod WriteErrorResponse(httpStatus As %Integer, message As %String) [ Private ]
{
    set %response.Status = httpStatus _ " Error"
    set %response.ContentType = "application/json"
    write {"error": (message)}
}

}

