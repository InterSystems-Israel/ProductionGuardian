/// MCP read tools for AI Detective — evidence gathering, no mutation.
///
/// Implements the five read tools in `contracts/mcp-tools.md`. That contract is authoritative;
/// where this class and the contract disagree, the contract is right and this is a bug.
///
/// HOW A TOOL IS DEFINED, verified by reading %AI.Tool.Generator rather than assumed: every
/// public, non-internal, non-abstract ClassMethod not starting with `%` becomes a tool. The
/// method's DESCRIPTION becomes the tool description the model reads, and argument descriptions
/// come from the formal spec. `%Invoke` and `%Discover` are GENERATED at compile time — do not
/// write them, and do not add helper ClassMethods here unless they are meant to be callable by
/// an LLM. A private helper is fine; a public one silently becomes a sixth tool.
///
/// RETURNS %DynamicObject THROUGHOUT. The generator produces an untyped schema from the return
/// value, so the field names below are a prose contract rather than an enforced one — which is
/// exactly why `contracts/mcp-tools.md` spells them out and why changing one here is a contract
/// change (@tanifgit flagged this; see that file's §7).
///
/// NULLABILITY IS THE RULE, NOT AN EDGE CASE. Every tool that can fail to measure returns null
/// for the value and states so, never a plausible zero. This project has been bitten three times
/// by the opposite (#33 an unmeasurable queue read as a small one; #49 an absent metric deflating
/// a baseline into a fake 6.5x warning; #58 a host that had never run published as "active now").
/// An agent diagnosing an error condition is the worst possible audience for a fabricated zero.
///
/// THE DATA BOUNDARY. Tool return values reach an external LLM, so nothing here may return
/// message content or PHI — only metrics and configuration. `GetRecentErrors` is where that is a
/// live risk rather than a formality: `Ens_Util.Log` on this instance currently holds 61,772 rows
/// carrying `PatientID` in plain text. See its own comment.
Class ProductionGuardian.LabDemo.Tools.Read Extends %AI.Tool
{

/// The production these tools report on. Same value as Triggers.#PRODUCTION, and deliberately
/// NOT imported from it: a tool that silently followed a change to the trigger class would start
/// reporting on a different production than the one it was authorised for.
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// Report the configured and observed status of one interoperability host.
///
/// Returns status as IRIS reports it, plus whether the host is enabled in the production. Use
/// this to establish whether a host is running at all before interpreting its other metrics.
ClassMethod GetHostStatus(host As %String) As %DynamicObject
{
    set out = { "host": (host), "found": false, "status": null, "enabled": null }
    set item = ..FindItem(host)
    if '$isobject(item) {
        set out.error = "no such config item in " _ ..#PRODUCTION
        quit out
    }
    set out.found = 1
    set out.enabled = ''item.Enabled
    // Status comes from EnumerateHostStatus, not from Enabled: an enabled host can be in Error
    // or Retry, and those are the states worth reporting.
    do ..HostStatusRow(host, .row)
    set out.status = $select($data(row("Status")): row("Status"), 1: "")
    quit out
}

/// Report the current queue depth for one interoperability host.
///
/// Returns null rather than zero when the depth cannot be measured, because an unmeasurable
/// depth is not a small one -- treating the two the same produced a false warning in #33.
ClassMethod GetQueueDepth(host As %String) As %DynamicObject
{
    set out = { "host": (host), "queued": null, "measured": false }
    do ..HostStatusRow(host, .row)
    if '$data(row("Queue")) {
        set out.reason = "host status unavailable"
        quit out
    }
    set out.queued = +row("Queue")
    set out.measured = 1
    quit out
}

/// Report the configured pool size (worker count) for one interoperability host.
///
/// Pool size is the number of concurrent workers. A host with pool 1 processes one message at a
/// time regardless of how many are queued, so this is the first thing to check when a queue is
/// building behind a host that is otherwise healthy.
ClassMethod GetPoolSize(host As %String) As %DynamicObject
{
    set out = { "host": (host), "poolSize": null, "found": false }
    set item = ..FindItem(host)
    if '$isobject(item) {
        set out.error = "no such config item in " _ ..#PRODUCTION
        quit out
    }
    set out.found = 1
    // PoolSize is a PROPERTY of Ens.Config.Item, not a row in its Settings collection. Reading it
    // from Settings would return "" on a host that has a pool size, which reads as "not
    // configured" rather than "read from the wrong place".
    set out.poolSize = +item.PoolSize
    quit out
}

/// Report recent error counts for one interoperability host, classified by IRIS error code.
///
/// Returns COUNTS and error CODES only -- never log text. Error text can contain patient data,
/// so this tool classifies rather than quotes.
ClassMethod GetRecentErrors(host As %String, sinceMinutes As %Integer = 15) As %DynamicObject
{
    // BOUNDED, and the bound is part of the data boundary rather than politeness. A count is not
    // content, but a count of one nearly is: "1 error for patient X in the last 5 seconds" is
    // identifying in a way "40 errors in 15 minutes" is not. 60 minutes is the ceiling because
    // this tool answers questions about a CONDITION, not a message search interface.
    if (sinceMinutes < 1) || (sinceMinutes > 60) {
        quit { "host": (host), "error": "sinceMinutes must be between 1 and 60", "sanitised": true }
    }

    set out = { "host": (host), "sinceMinutes": (sinceMinutes), "count": null, "sanitised": true, "byCode": [] }

    // THE PHI BOUNDARY, and this is measured rather than cautious. Ens_Util.Log on this instance
    // holds 61,772 Type=4 rows every one of which carries a PatientID in plain text, against 66
    // Type=2 rows carrying none. Filtering to Type>=2 and returning the text would therefore pass
    // every test written against today's log and STILL be wrong: that separation is a property of
    // how $$$LOGINFO and $$$LOGERROR happen to be used in PatientDemographicsOperation, not of the
    // log, and that operation already builds PatientID strings for its info path. One $$$LOGERROR
    // interpolating a patient id moves PHI into the error rows.
    //
    // 61,772 to 66 makes the unsafe case RARE RATHER THAN ABSENT, which is the worst shape a
    // defect can have -- it survives review, survives the demo, and shows up in production. So:
    // extract an allowlisted error token, never return text. No exceptions, including for text
    // that happens to be safe, because a rule with an exception is one an implementer widens.
    // $ztimestamp is "days,seconds" -- subtracting a fractional day from it produces a value
    // $zdatetime rejects with <ILLEGAL VALUE> rather than a wrong answer, which is at least loud.
    // Decompose, subtract seconds, and borrow a day if it goes negative.
    set days = $piece($ztimestamp, ",", 1)
    set secs = $piece($ztimestamp, ",", 2) - (sinceMinutes * 60)
    if secs < 0 {
        set days = days - 1
        set secs = secs + 86400
    }
    set since = $zdatetime(days _ "," _ secs, 3)
    set sql = "SELECT Text FROM Ens_Util.Log WHERE ConfigName = ? AND Type <= 2 AND TimeLogged >= ?"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, host, since)
    if rs.%SQLCODE < 0 {
        set out.reason = "log unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        // NULL, not 0. "No errors" is the worst possible wrong answer to an agent diagnosing an
        // error condition -- it would conclude the host is healthy from a failed read.
        quit out
    }

    set total = 0
    kill codes
    while rs.%Next() {
        set total = total + 1
        set code = ..ClassifyError(rs.%Get("Text"))
        set codes(code) = $get(codes(code), 0) + 1
    }
    set out.count = total
    set code = ""
    for {
        set code = $order(codes(code), 1, n)
        quit:code=""
        do out.byCode.%Push({ "errorCode": (code), "count": (n) })
    }
    quit out
}

/// Report average processing and queueing time in seconds for one interoperability host.
///
/// These are the times a message spends being handled and waiting to be handled. A high queueing
/// time with a normal processing time means the host is keeping up per message but is outnumbered.
ClassMethod GetProcessingTime(host As %String) As %DynamicObject
{
    set out = { "host": (host), "avgProcessingTime": null, "avgQueueingTime": null, "measured": false }

    // READS THE PROMETHEUS FAMILIES, not EnumerateHostStatus. That query returns exactly eight
    // columns -- Name, Type, Status, AdapterState, LastActivity, ElapsedTime, Queue, Count -- and
    // NONE of them is a processing or queueing time. I assumed TimeProcessing/TimeQueued existed
    // and they do not; checked with GetColumnName() rather than continuing to guess. Neither
    // EnumerateMetrics (Name, LastUpdate, IsRunning) nor EnumerateCounters (Category, Item, Count)
    // carries per-host timing either.
    //
    // So the only source is `iris_interop_avg_*` on /api/monitor/metrics, which is what
    // contracts/mcp-tools.md says this wraps: "aggregated as the proxy aggregates them". Read
    // locally over the instance's own web server -- the same endpoint the proxy polls, so the two
    // cannot disagree about what a host's timing is.
    set families = $listbuild("iris_interop_avg_processing_time", "iris_interop_avg_queueing_time")
    set fields = $listbuild("avgProcessingTime", "avgQueueingTime")
    for i = 1:1:$listlength(families) {
        set value = ..ScrapeGauge($list(families, i), host)
        if value '= "" {
            do out.%Set($list(fields, i), +value)
        }
    }
    // measured is false when NEITHER could be read. Both stay null rather than 0: IRIS omits these
    // families entirely for a host that has not processed anything, and a zero would read as
    // "instant" rather than "never measured" -- the #49 shape.
    set out.measured = ((out.avgProcessingTime '= "") || (out.avgQueueingTime '= ""))
    quit out
}

/// Sum one Prometheus gauge family for a host, or "" when absent. Private.
///
/// SUMS ACROSS messagetype, matching how the proxy aggregates: IRIS emits one series per
/// (host, messagetype), so a host handling two message types has two series and reading only the
/// first would understate it. Returns "" rather than 0 for an absent family, because those are
/// different facts and #49 is what conflating them costs.
ClassMethod ScrapeGauge(family As %String, host As %String) As %String [ Private ]
{
    set req = ##class(%Net.HttpRequest).%New()
    set req.Server = "127.0.0.1"
    set req.Port = 52773
    set req.Timeout = 5
    set sc = req.Get("/api/monitor/metrics")
    if $$$ISERR(sc) {
        quit ""
    }
    if (req.HttpResponse.StatusCode < 200) || (req.HttpResponse.StatusCode > 299) {
        quit ""
    }
    set body = req.HttpResponse.Data.Read(2000000)
    set total = "", needle = family _ "{"
    for i = 1:1:$length(body, $char(10)) {
        set line = $piece(body, $char(10), i)
        // Skip HELP/TYPE/UNIT comment lines, which contain the family name too.
        if $extract(line) = "#" {
            continue
        }
        if '(line [ needle) {
            continue
        }
        // The host label is quoted, so match host="<name>" exactly rather than a substring --
        // "Cloud API" must not match a hypothetical "Cloud API v2".
        if '(line [ ("host=""" _ host _ """")) {
            continue
        }
        set value = $piece(line, " ", $length(line, " "))
        if value = "" {
            continue
        }
        set total = $select(total = "": +value, 1: total + value)
    }
    quit total
}

/// Find a config item by name. Private so the tool generator does not expose it.
ClassMethod FindItem(host As %String) As Ens.Config.Item [ Private ]
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$isobject(def) {
        quit $$$NULLOREF
    }
    // Explicit result variable: a bare `quit` breaks the FOR and leaves the loop variable holding
    // the last item examined whether or not it matched, which would return another host's
    // configuration for an unknown name.
    set result = $$$NULLOREF
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name = host {
            set result = item
            quit
        }
    }
    quit result
}

/// One row of EnumerateHostStatus for a host, as a local array. Private.
ClassMethod HostStatusRow(host As %String, ByRef row) As %Status [ Private ]
{
    kill row
    set rs = ##class(%ResultSet).%New("Ens.Util.Statistics:EnumerateHostStatus")
    set sc = rs.Execute()
    if $$$ISERR(sc) {
        quit sc
    }
    while rs.Next() {
        // `Name`, not `ConfigName`. EnumerateHostStatus returns 8 columns -- Name, Type, Status,
        // AdapterState, LastActivity, ElapsedTime, Queue, Count -- and rs.Data("ConfigName") threw
        // <UNDEFINED> at runtime while compiling cleanly, which is the same runtime-only class as
        // #37 and the EnumerateConfigItems ConfigName/Name mix-up in EnableMetrics. Read from
        // GetColumnName() rather than assumed.
        if rs.Data("Name") '= host {
            continue
        }
        set col = ""
        for {
            set col = $order(rs.Data(col), 1, val)
            quit:col=""
            set row(col) = val
        }
        quit
    }
    quit $$$OK
}

/// Map error text to an allowlisted code, or "unclassified". Private.
///
/// ALLOWLIST, never a denylist. Anything unrecognised yields "unclassified" and NO text, so a
/// novel error message cannot leak through a gap in a pattern list. A denylist would need to
/// anticipate every shape PHI can take in a log line, which is not a bet worth taking on a
/// healthcare system.
ClassMethod ClassifyError(text As %String) As %String [ Private ]
{
    set known = $listbuild(
        "<Ens>ErrFailureTimeout",
        "<Ens>ErrConnectionLost",
        "<Ens>ErrHTTPStatus",
        "<Ens>ErrGeneral",
        "<Ens>ErrProductionSettingInvalid",
        "<Ens>ErrTCPTerminatedReadTimeoutExpired",
        "#6059",
        "#5001",
        "#5021")
    set ptr = 0
    while $listnext(known, ptr, token) {
        if text [ token {
            quit
        }
        set token = ""
    }
    quit $select(token '= "": token, 1: "unclassified")
}

}
