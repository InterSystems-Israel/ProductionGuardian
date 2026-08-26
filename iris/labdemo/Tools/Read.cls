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

/// Report the configured adapter settings for one interoperability host.
///
/// WHY THIS TOOL EXISTS, and it is a data-boundary decision rather than a convenience. MVP 3's
/// scenario needs the agent to name the directory a service cannot read. That name lives in exactly
/// two places: the `#5021` log message, and the host's configuration. `GetRecentErrors` will never
/// return log text -- `Ens_Util.Log` holds 61,772 rows carrying `PatientID` in plain text -- so
/// without this tool the agent can learn *a path is missing* and never *which path*.
///
/// Configuration is what the boundary permits: root `CLAUDE.md` §2.1 is "metrics and configuration
/// only, never message content". A setting VALUE is configuration by definition; it was typed by
/// whoever deployed the production, not derived from a message.
///
/// AN ALLOWLIST OF SETTING NAMES, NOT EVERY SETTING. Returning the whole collection would be one
/// `Credentials` row away from handing an external LLM the name of a credential set, and one future
/// setting away from something worse -- a production is configured by people, and people put
/// surprising things in free-text settings. So the tool names what it will return and refuses the
/// rest by construction. Adding a name here is a decision, which is the same reasoning as
/// `Tools.Resolve`'s single whitelisted host and the `#5021` catalogue.
///
/// `Credentials` is deliberately ABSENT even though it is only an identifier: it names a stored
/// secret, and an agent has no diagnostic use for it that outweighs saying its name out loud.
ClassMethod GetHostSettings(host As %String) As %DynamicObject
{
    set out = { "host": (host), "found": false, "settings": {} }
    set item = ..FindItem(host)
    if '$isobject(item) {
        set out.error = "no such config item in " _ ..#PRODUCTION
        quit out
    }
    set out.found = 1

    // The allowlist. Path and target settings, because those are what a misconfiguration diagnosis
    // needs -- where the host reads from, where it writes to, and where it sends.
    set allowed = $listbuild(
        "FilePath",
        "ArchivePath",
        "WorkPath",
        "FileSpec",
        // CallInterval, not PollInterval. This allowlist named a setting that does not
        // exist on any adapter in this production, so the entry could never match and
        // the polling interval was unreachable to the agent -- a dead allowlist row,
        // which is worse than an absent one because it reads as coverage. Same root
        // cause as the invalid setting in Production.cls: `Ens.InboundAdapter` calls it
        // CallInterval and nothing calls it PollInterval.
        "CallInterval",
        "HTTPServer",
        "HTTPPort",
        "URL",
        "TargetConfigNames")

    for i = 1:1:item.Settings.Count() {
        set setting = item.Settings.GetAt(i)
        // $listfind, not %INLIST -- the latter is SQL-only and raises #1010 in method code.
        if $listfind(allowed, setting.Name) > 0 {
            do out.settings.%Set(setting.Name, setting.Value)
        }
    }

    // The POOL SIZE is a property rather than a Settings row, so it is not in the loop above. Added
    // because a diagnosis about throughput needs it and `get_pool_size` already publishes it -- this
    // is the same value, not a second source of truth.
    set out.settings.PoolSize = +item.PoolSize

    // COUNTED, so the agent can tell "this host has three settings" from "the allowlist filtered
    // most of them out". Without it, a host configured entirely through settings this tool refuses
    // looks identically bare to one with no configuration at all.
    set out.settingsOnItem = item.Settings.Count()
    quit out
}

/// Report recent error counts for one interoperability host, classified by IRIS error code.
///
/// Returns COUNTS and error CODES only -- never log text. Error text can contain patient data,
/// so this tool classifies rather than quotes.
ClassMethod GetRecentErrors(host As %String, sinceMinutes As %Integer = 15) As %DynamicObject
{
    // AN OMITTED ARGUMENT IS NOT AN INVALID ONE, and the ObjectScript default above does not cover
    // this. `%AI.ToolMgr.ExecuteTool` builds the argument list from the model's JSON and passes ""
    // for a key the model did not send -- so the `= 15` default never applies on the tool path, ""
    // fails `< 1` below, and the tool refused every call that omitted the parameter. Measured:
    //
    //   Invoke("GetRecentErrors", {"host":"EMR Source"})                 -> error, sinceMinutes
    //   Invoke("GetRecentErrors", {"host":"EMR Source","sinceMinutes":15}) -> 3 errors, #5021
    //
    // Same host, same second, opposite answers. This was live from #106 and invisible because every
    // hand-written check passed the argument -- the only caller that omits it is the model, whose
    // schema marks it optional. It cost a live investigation: blinded to the error codes, the agent
    // reasoned from the one number it could still see (PoolSize 1) and recommended enlarging the pool
    // of a host whose directory did not exist.
    if sinceMinutes = "" {
        set sinceMinutes = 15
    }

    // BOUNDED, and the bound is part of the data boundary rather than politeness. A count is not
    // content, but a count of one nearly is: "1 error for patient X in the last 5 seconds" is
    // identifying in a way "40 errors in 15 minutes" is not. 60 minutes is the ceiling because
    // this tool answers questions about a CONDITION, not a message search interface.
    //
    // Still rejects a value the model actually sent and got wrong -- `0` and `90` are refusals, and
    // the refusal names the range. Only absence now means "use the default".
    if (sinceMinutes < 1) || (sinceMinutes > 60) {
        quit { "host": (host), "error": "sinceMinutes must be between 1 and 60", "sanitised": true }
    }

    // `sinceMinutes` echoed under the SAME name as the input. The contract said `windowMinutes` on
    // output until 2026-08-20 and this said `sinceMinutes`; reconciled in #116 toward one name,
    // because a different name on each side is a translation step nobody wanted.
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
    // TimeLogged IS SELECTED TOO, so each code can report HOW RECENT it is and not only how many.
    // A count alone is what produced the reported defect: a queue building behind one worker was
    // diagnosed as a connectivity failure because 20-minute-old #6059 rows were still inside the
    // window. Measured on the same host in the same second:
    //
    //     sinceMinutes 15  ->  count 0,   byCode []
    //     sinceMinutes 60  ->  count 134, byCode [#6059 x63, ErrFailureTimeout x63, ...]
    //
    // Both true. Neither says whether the failure is HAPPENING or merely HAPPENED, and that is the
    // whole distinction between "the target is unreachable" and "the target was unreachable and the
    // backlog is now draining slowly". The window cannot settle it either: a short window hides the
    // missing-folder scenario, where a host logs #5021 once on entering Error and then goes quiet.
    //
    // A TIMESTAMP IS NOT CONTENT. `secondsAgo` is a duration derived from a row's own clock field,
    // carries nothing typed by a person and nothing derived from a message, so it is on the metrics
    // side of the §2.1 boundary. The message TEXT stays unreturnable, as below.
    set sql = "SELECT Text, TimeLogged FROM Ens_Util.Log WHERE ConfigName = ? AND Type <= 2 AND TimeLogged >= ?"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, host, since)
    if rs.%SQLCODE < 0 {
        set out.reason = "log unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        // NULL, not 0. "No errors" is the worst possible wrong answer to an agent diagnosing an
        // error condition -- it would conclude the host is healthy from a failed read.
        quit out
    }

    set total = 0
    kill codes
    kill newest
    while rs.%Next() {
        set total = total + 1
        set code = ..ClassifyError(rs.%Get("Text"))
        set codes(code) = $get(codes(code), 0) + 1
        // Newest per code, as an ODBC timestamp string. String comparison is correct for this
        // format -- "2026-08-23 10:47:54" sorts identically as text and as time, because the fields
        // are fixed-width and most-significant-first.
        set stamp = rs.%Get("TimeLogged")
        if stamp ] $get(newest(code), "") {
            set newest(code) = stamp
        }
    }
    set out.count = total

    // `now` once, outside the loop, so every secondsAgo in one reply is measured against the same
    // instant. Computed per entry it would drift by the loop's own duration, and two codes logged
    // together could report different ages.
    set nowH = $ztimestamp
    set code = ""
    for {
        set code = $order(codes(code), 1, n)
        quit:code=""
        set ago = ..SecondsSince($get(newest(code), ""), nowH)
        // `summary` lives on the byCode entry because it is keyed by `errorCode` -- a property of
        // the CODE, not of an occurrence. That is what made the aggregate shape sufficient and the
        // per-event `errors[]` array unnecessary (@kskubach's correction on #116).
        //
        // `secondsAgo` is the newest occurrence of THIS code, so a reply can carry one code that is
        // seconds old and another that is an hour old -- which is exactly the case a single
        // `count` collapses and a diagnosis needs.
        do out.byCode.%Push({ "errorCode": (code), "count": (n), "summary": (..ErrorSummary(code)),
            "secondsAgo": (ago) })
    }

    // ONE SUMMARY FIELD FOR THE WHOLE REPLY, because a model reasoning about "is this still
    // happening" should not have to scan an array to find the minimum. Null when there are no
    // errors at all -- not 0, which would read as "an error just now".
    set overall = ""
    set code = ""
    for {
        set code = $order(newest(code))
        quit:code=""
        if newest(code) ] overall {
            set overall = newest(code)
        }
    }
    set out.newestSecondsAgo = $select(overall = "": "", 1: ..SecondsSince(overall, nowH))
    quit out
}

/// Whole seconds between an ODBC timestamp and a $ztimestamp value. Private.
///
/// Returns "" for an unparseable or absent input, which the caller emits as JSON null -- an
/// unmeasurable age must not read as "just now", which is §2.1's nullability rule applied to time.
ClassMethod SecondsSince(stamp As %String, nowH As %String) As %String [ Private ]
{
    if stamp = "" {
        quit ""
    }
    // $zdatetimeh with format 3 is the inverse of the $zdatetime(...,3) used to build the window
    // bound above. It throws on malformed input rather than returning a wrong number, so the
    // try/catch is the guard rather than a validation pass.
    try {
        set h = $zdatetimeh(stamp, 3)
    } catch {
        // Return, not Quit: `Quit value` inside a Try is #1043. Third time in this codebase, so it
        // is worth the note -- $$$OK expands to 1 and hits the same rule.
        return ""
    }
    set d = ($piece(nowH, ",", 1) - $piece(h, ",", 1)) * 86400
    set d = d + ($piece(nowH, ",", 2) - $piece(h, ",", 2))
    // Clamped at zero. A row stamped a second in the future -- clock skew, or a timestamp written by
    // a different process -- must not report a negative age, which a consumer would render as
    // nonsense rather than recognise as skew.
    quit $select(d < 0: 0, 1: d \ 1)
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
/// The `summary` catalogue — `contracts/mcp-tools.md` §3.4a.
///
/// A FIXED STRING LOOKED UP BY `errorCode`, never derived from the log row. That is the whole reason
/// it is safe to send: `Ens_Util.Log` on this instance holds 61,772 rows carrying `PatientID` in
/// plain text, and a summary built from the row would carry whatever the row carries. A catalogue
/// cannot, by construction.
///
/// THE ALLOWLIST MUST NOT GAIN AN EXCEPTION FOR `#5021`. The tempting shortcut for MVP 3's scenario
/// is to return that error's message text, because it contains the missing path and the path is
/// *usually* harmless. That is the wrong shape twice: an allowlist with one exception is one an
/// implementer widens, and "usually harmless" is the rare-rather-than-absent pattern that survives
/// review and then leaks. The agent learns the KIND of fault here and the offending path from
/// `GetHostSettings` -- configuration, which the boundary permits.
///
/// Adding a row is a contract change (§3.4a), deliberately: a code that reaches an agent with a
/// human-readable meaning is a decision about what the model is told.
ClassMethod ErrorSummary(code As %String) As %String [ Private ]
{
    // Returns "" for anything not listed, which GetRecentErrors emits as JSON null -- §3.4a's
    // "null when unclassified". An unknown code gets a count and no interpretation, which is honest:
    // the agent can see something is failing and cannot be told what it means.
    quit $case(code,
        "#5021": "a configured directory or file path does not exist",
        "#6059": "the configured downstream host or port could not be reached",
        "#5001": "a general IRIS error was raised while handling a message",
        "<Ens>ErrFailureTimeout": "the host retried and gave up within its failure timeout",
        "<Ens>ErrConnectionLost": "the connection to the downstream target was lost",
        "<Ens>ErrHTTPStatus": "the downstream returned an HTTP status the adapter treats as an error",
        "<Ens>ErrProductionSettingInvalid": "a production setting on this host is not a valid value",
        "<Ens>ErrTCPTerminatedReadTimeoutExpired": "a TCP read timed out before the downstream replied",
        "<Ens>ErrGeneral": "the interoperability framework raised a general error",
        : "")
}

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
