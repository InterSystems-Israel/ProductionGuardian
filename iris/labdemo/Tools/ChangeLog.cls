/// MCP read tool over `%SYS.Audit` — WHO CHANGED WHAT, for the production this project reports on.
///
/// Implements the one tool in `contracts/mcp-tools.md` §3.12. That contract is authoritative; where
/// this class and it disagree, the contract is right and this is a bug.
///
/// WHY THIS TOOL EXISTS. Every other read tool answers a question about the production's BEHAVIOUR —
/// what is true now, what throughput did, what the log said. None of them can answer the question an
/// operator asks first when a host breaks: *did someone change something?* On this instance
/// `EMR Source`'s `FilePath` and `Cloud API`'s `HTTPPort` were both edited within hours of the
/// findings they caused, and that fact sat in `%SYS.Audit` with nothing reading it.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// IT REPORTS THE CHANGE AND MUST NOT PRESCRIBE A REVERT
///
/// This is a product rule, not an implementation preference, and it is the reason the tool returns
/// the previous value at all. Whoever made the change had a reason this instance cannot see, and the
/// value they *intended* may be neither the old one nor the new one — a typo in a new path is not
/// repaired by restoring the old path. So the OLD VALUE IS EVIDENCE, NOT A RECOMMENDATION.
///
/// The rule is enforced in the two system prompts (`REST.AgentDispatcher`, `REST.ChatDispatcher`)
/// rather than by withholding the previous value, because withholding it would defeat the tool: an
/// agent that can only say "FilePath changed" cannot say "changed from a directory that exists to one
/// that does not", which is the whole diagnostic content. Data here, judgement there.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE SCHEMA, MEASURED RATHER THAN ASSUMED
///
/// `%SYS.Audit` on this instance holds 162,333 rows across 25 columns. The rows this tool wants are
/// `Event = 'ModifyConfiguration'` with `EventSource/EventType = %Ensemble/%Production` — 82 of them —
/// and only 8 of those describe a SETTING change. The rest are lifecycle text
/// (`Production class compiled`, `Item updated using Management Portal V2 interface`), which is why
/// the `>>` test below is a filter rather than an assertion.
///
/// TWO COLUMNS CARRY EVERYTHING, and their contents were read rather than guessed:
///
///   Description   `item EMR Source of ProductionGuardian.LabDemo.Production`
///   EventData     `FilePath:/tmp/labdemo/hl7-in-missing/>>/tmp/labdemo/hl7-in/`
///
/// So `Description` is the SUBJECT and `EventData` is the DETAIL — the opposite of what the names
/// suggest, and the opposite of the argument order `$SYSTEM.Security.Audit()` takes (see
/// `Triggers.SetSetting`). Both are `varbinary` in the SQL projection, which is why every predicate
/// here is on `Event` and `UTCTimeStamp` and the shape tests are done in ObjectScript: `LIKE '%>>%'`
/// against `EventData` returns SQLCODE -29, so a SQL-side filter on content silently cannot be
/// written.
///
/// HOST ATTRIBUTION COMES FROM `Description`, and it is exact rather than a prefix match. Config item
/// names contain spaces (`EMR Source`), so the host is what lies between the literal `item ` and the
/// literal ` of <production class>` — anchored at BOTH ends. A row naming another production is
/// dropped rather than reported unattributed.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE DATA BOUNDARY
///
/// Tool output reaches an external LLM, so metrics and configuration only: never message content,
/// never PHI (root `CLAUDE.md` §2.1, `contracts/mcp-tools.md` §6). An audit row is *more* dangerous
/// than a live item read, because it is free text written by whatever performed the change.
///
///   RETURNED
///     host            a config item name. Configuration, and dictionary-anchored by the `item … of`
///                     parse above.
///     setting         a setting NAME, and only from `Tools.Read.#SETTINGALLOWLIST` plus the two
///                     names below. Anything else is counted, never named.
///     previousValue   a setting VALUE. Permitted for exactly the reason `GetHostSettings` gives —
///                     it was typed by whoever deployed the production, not derived from a message —
///                     and only for an allowlisted name.
///     newValue        same.
///     changedAt       a clock reading. A timestamp carries nothing a person typed.
///
///   COUNTED, NEVER RETURNED
///     suppressed      rows whose setting name is not allowlisted. The COUNT is published so the
///                     model can tell "nothing changed" from "something changed that I may not
///                     name" — those are different answers and conflating them is how an agent
///                     concludes a host was untouched.
///
///   NEVER READ AT ALL
///     Username        WHO made the change. An operator's identity is neither a metric nor
///                     configuration, so it fails §2.1 on its face — and the tool does not need it:
///                     "this was changed 40 minutes ago" carries the whole diagnostic weight, and
///                     naming a person invites the agent to assign blame it cannot support. The
///                     column is not selected, so it cannot leak by a later edit to the payload.
///     ClientIPAddress, OSUsername, CSPSessionID, Roles, Pid, JobId
///                     identifiers of the actor or the session. Same reasoning as `Username`, and
///                     none of them answers a diagnostic question.
///     UserInfo        `varbinary`, caller-supplied, and unbounded. Refused for the reason
///                     `Tools.EventLog` refuses `TraceCat`: empty on this instance is the
///                     rare-rather-than-absent shape.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// SILENCE IS NOT EVIDENCE, AND THE PAYLOAD SAYS SO
///
/// Two mechanisms make an empty `changes` list uninformative, and a model cannot know either one:
///
///   1. **IRIS purges audit data.** Measured — an `AuditChange` / "Delete audit data" pair ran at
///      2026-08-30 06:00 on this instance. So the log's depth is a property of the instance, not of
///      the product, and `retention` reports it for the same reason `Tools.EventLog.Retention()`
///      does.
///   2. **Not every setting change is audited.** `Ens.Config.Production.%Save()` writes no audit row
///      — only the Management Portal's own save path does. `Triggers.SetSetting` therefore emits the
///      row itself; anything else in this codebase that mutates a setting through `%Save()` will be
///      invisible here. Measured by arming `Triggers.MissingFolder()` and finding no new row.
///
/// `auditEnabled` covers the third case: system auditing switched off makes every window empty.
/// Read from `Security.System.Get()`, not from `Security.System.AuditEnabled()` — that method does
/// not exist on this instance, which is worth stating because it is the name one reaches for first.
///
/// EVERY PUBLIC CLASSMETHOD HERE BECOMES AN LLM-CALLABLE TOOL, verified in `%AI.Tool.Generator`.
/// Helpers are `[ Private ]` — six of them against one public method, so this class would discover
/// seven tools if the keyword were ever dropped. One public method, one tool;
/// `Setup.AIHub.ReportTools()` is what makes a second name a loud defect rather than a quiet one.
Class ProductionGuardian.LabDemo.Tools.ChangeLog Extends %AI.Tool
{

/// The production whose changes this tool will report. Same value as `Tools.Read.#PRODUCTION`, and
/// deliberately NOT imported from `Triggers`, for that class's stated reason: a tool that silently
/// followed a change to the trigger class would start reporting on a different production than the
/// one it was authorised for.
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// Ceiling on `sinceHours`: 30 days.
///
/// Wide because the question is "was this touched recently" and a configuration change that broke a
/// host a fortnight ago is still the answer. It stops at 30 days because beyond that the audit log
/// on any real instance has been purged, so a wider window would offer coverage it cannot deliver —
/// and `retention` in the payload is what tells the model where the real edge is.
Parameter MAXWINDOW = 720;

/// Used when the model omits `sinceHours`. Seven days — see the restatement inside the method for
/// why an ObjectScript default is not enough on the tool path.
Parameter DEFAULTWINDOW = 168;

/// Rows read from `%SYS.Audit` before filtering, and it is a SQL `TOP` rather than a loop counter.
///
/// `AccessDenied` accounts for 111,228 of this instance's 162,333 audit rows and is still arriving
/// every ~2.5 s, so the table grows without bound while the population this tool wants does not.
/// The `Event` predicate excludes them, but a `TOP` is the guard that does not depend on an index
/// existing.
Parameter SCANROWS = 400;

/// Changes returned at most, after filtering.
///
/// A cap rather than a page, because there is no question this tool answers that needs the 26th most
/// recent change: the diagnosis turns on what was touched near the fault. `truncated` says when the
/// cap bit, so the model never reads a clipped list as a complete one.
Parameter MAXCHANGES = 25;

/// Setting names this tool may report BEYOND `Tools.Read.#SETTINGALLOWLIST`.
///
/// Both are configuration a diagnosis turns on, and both are already published by an existing tool —
/// `PoolSize` by `get_pool_size` and `GetHostSettings`, `Enabled` by `get_host_status` — so naming
/// them here reveals nothing new. They are separate from the shared list because that list is read
/// against an item's `Settings` collection, and neither of these is a `Settings` row: `PoolSize` and
/// `Enabled` are properties of `Ens.Config.Item`. An audit row does not make that distinction, which
/// is exactly why it has to be made here.
Parameter EXTRAALLOWED = {$listbuild("PoolSize", "Enabled")};

/// The marker an audited setting change puts between the old and the new value.
Parameter DELIM = ">>";

/// Recent configuration changes to this production's hosts, from the IRIS audit log — which setting
/// changed on which host, from what value to what value, and when.
///
/// Call this when a host is misbehaving and you want to know whether its configuration was edited
/// recently. A change close in time to the fault is worth reporting as a possible cause. You must
/// NOT recommend reverting it and must not describe the previous value as the correct one: whoever
/// made the change had a reason you cannot see, and the value they intended may be neither the old
/// one nor the new one. Report the change; leave the decision to the operator.
///
/// An empty result does not mean nothing was changed — read `retention` and `auditEnabled` before
/// saying so.
ClassMethod GetRecentConfigChanges(host As %String = "", sinceHours As %Integer = 168) As %DynamicObject
{
    // AN OMITTED ARGUMENT IS NOT AN INVALID ONE. `%AI.ToolMgr.ExecuteTool` builds the argument list
    // from the model's JSON and passes "" for a key the model did not send, so the `= 168` above
    // never applies on the tool path. `GetRecentErrors` shipped broken for exactly this reason from
    // #106 and it was invisible because every hand-written check passed the argument. Restated, not
    // relied on.
    if sinceHours = "" {
        set sinceHours = ..#DEFAULTWINDOW
    }
    if (sinceHours '= (sinceHours \ 1)) || (sinceHours < 1) || (sinceHours > ..#MAXWINDOW) {
        quit { "error": ("sinceHours must be an integer between 1 and " _ ..#MAXWINDOW),
            "sanitised": true }
    }

    set since = ..Since(sinceHours)
    set out = { "host": null, "sinceHours": (sinceHours), "since": (..IsoUTC(since)),
        "now": (..IsoUTC($zdatetime($ztimestamp, 3))), "changes": null, "suppressed": 0,
        "truncated": false, "sanitised": true }
    // null when unfiltered, so "every host" and "a host whose name is the empty string" are
    // different payloads rather than the same one.
    if host '= "" {
        set out.host = host
    }

    // THE ALLOWLISTS ARE READ BEFORE THE NAMESPACE SWITCH, and this is a correctness requirement
    // rather than an ordering preference. `##class(Tools.Read).#SETTINGALLOWLIST` resolves the class at
    // RUNTIME, and `Tools.Read` does not exist in %SYS -- measured: `<CLASS DOES NOT EXIST>` naming
    // `ProductionGuardian.LabDemo.Tools.Read`, from inside a method that had compiled cleanly. Reading
    // it here also costs nothing, since neither list depends on the query.
    set allowed = ##class(ProductionGuardian.LabDemo.Tools.Read).#SETTINGALLOWLIST
    set extra = ..#EXTRAALLOWED

    // THE NAMESPACE SWITCH IS THE FIRST THING THAT CAN FAIL, and `new $namespace` is what restores
    // it: `%SYS.Audit` is only queryable from %SYS, and a tool that left the process in %SYS would
    // break every subsequent tool call in the same agent turn. Scoped to this frame, so it unwinds
    // on an exception as well as on a normal return.
    new $namespace
    try {
        set $namespace = "%SYS"
    } catch switchEx {
        set out.error = "cannot read the audit log: " _ switchEx.DisplayString()
        // RETURN, not QUIT. Inside a TRY or CATCH block `QUIT` exits the BLOCK and refuses an argument
        // -- `quit out` there is compile error #1043, not a method return. The exits below are at top
        // level and use `quit`, which is the surrounding convention.
        return out
    }

    // `%Set` WITH AN EXPLICIT TYPE in all three branches, because `set out.auditEnabled = ""` emits a
    // JSON empty STRING and "" here means "could not tell". `"auditEnabled": ""` is falsy to most
    // readers, so it would say "auditing is off" — the opposite of what the helper returns it for.
    set enabled = ..AuditEnabled()
    if enabled = "" {
        do out.%Set("auditEnabled", "", "null")
    } else {
        do out.%Set("auditEnabled", ''enabled, "boolean")
    }
    // RETENTION FIRST, and unbounded by the window on purpose — same reason as
    // `Tools.EventLog.Retention()`. A model told "no changes in the last 7 days" needs to know
    // whether the audit log covers 7 days.
    set out.retention = ..Retention()

    set changes = []
    set suppressed = 0

    // Ordered DESC and capped by TOP: the newest changes are the ones a diagnosis turns on, and a
    // clipped scan must clip the OLD end.
    set rs = ##class(%SQL.Statement).%ExecDirect(,
        "SELECT TOP " _ ..#SCANROWS _ " UTCTimeStamp, Description, EventData FROM %SYS.Audit " _
        "WHERE Event = 'ModifyConfiguration' AND UTCTimeStamp >= ? ORDER BY UTCTimeStamp DESC",
        since)
    if rs.%SQLCODE < 0 {
        // null, not an empty array. A failed query and a quiet production are different facts, and
        // #33/#49/#58 are what conflating them costs.
        set out.error = "audit query failed with SQLCODE " _ rs.%SQLCODE
        quit out
    }

    while rs.%Next() {
        set rowHost = ..HostOf(rs.%Get("Description"))
        if rowHost = "" {
            // A lifecycle row (`Production class compiled`) or another production's. Neither is a
            // setting change on a host of ours.
            continue
        }
        if (host '= "") && (rowHost '= host) {
            continue
        }
        set data = rs.%Get("EventData")
        set stamp = ..IsoUTC(rs.%Get("UTCTimeStamp"))
        // ONE ROW MAY CARRY SEVERAL SETTINGS, one per line. Measured single-line on this instance,
        // but a Portal save of two settings at once is one user action and there is no reason to
        // assume it splits into two rows — so the loop is over lines, not over rows.
        for line = 1:1:$length(data, $char(10)) {
            set parsed = ..ParseChange($piece(data, $char(10), line))
            if parsed = "" {
                continue
            }
            if ($listfind(allowed, $list(parsed, 1)) = 0) && ($listfind(extra, $list(parsed, 1)) = 0) {
                set suppressed = suppressed + 1
                continue
            }
            if changes.%Size() >= ..#MAXCHANGES {
                do out.%Set("truncated", 1, "boolean")
                continue
            }
            do changes.%Push({ "host": (rowHost), "setting": ($list(parsed, 1)),
                "previousValue": ($list(parsed, 2)), "newValue": ($list(parsed, 3)),
                "changedAt": (stamp) })
        }
    }

    set out.changes = changes
    set out.suppressed = suppressed
    quit out
}

/// Whether system auditing is on at all. Private.
///
/// `Security.System.Get()` into a by-reference array, because `##class(Security.System).AuditEnabled()`
/// DOES NOT EXIST on this instance — measured, `<METHOD DOES NOT EXIST>`. Worth naming in a comment
/// because it is the method a reader will reach for first.
///
/// Returns "" rather than 0 when the read fails, so `auditEnabled: null` means "could not tell" and
/// never "auditing is off" — the two would license opposite conclusions about an empty result.
ClassMethod AuditEnabled() As %Boolean [ Private ]
{
    set sc = ##class(Security.System).Get("", .props)
    if $$$ISERR(sc) {
        quit ""
    }
    quit $select($data(props("AuditEnabled")): ''props("AuditEnabled"), 1: "")
}

/// How deep the audit log's `ModifyConfiguration` history actually runs. Private.
///
/// Deliberately counts the EVENT, not the whole table: `AccessDenied` dominates the row count here
/// and its oldest timestamp would advertise coverage this tool cannot deliver.
ClassMethod Retention() As %DynamicObject [ Private ]
{
    set rs = ##class(%SQL.Statement).%ExecDirect(,
        "SELECT COUNT(*) N, MIN(UTCTimeStamp) O, MAX(UTCTimeStamp) W FROM %SYS.Audit " _
        "WHERE Event = 'ModifyConfiguration'")
    if (rs.%SQLCODE < 0) || 'rs.%Next() {
        quit { "rows": null, "oldest": null, "newest": null }
    }
    // BUILT IN A VARIABLE FIRST, not inline in the literal below. A `{}` literal may span lines, but a
    // `_` concatenation continued onto the next line inside one does not parse -- the compiler reports
    // #1021 "Expected right bracket" and then reads each continuation line as a command.
    //
    // Said in the payload at all because it changes how an empty window should be read, and the model
    // has no other way to know it.
    set note = "IRIS purges audit data on a schedule, and a setting changed through code rather " _
        "than the Management Portal may not be audited at all -- an empty result is not proof " _
        "that nothing changed"
    quit { "rows": (rs.%Get("N")), "oldest": (..IsoUTC(rs.%Get("O"))),
        "newest": (..IsoUTC(rs.%Get("W"))), "note": (note) }
}

/// The config item named by an audit row's `Description`, or "" if it does not name one of ours.
/// Private.
///
/// ANCHORED AT BOTH ENDS — `item ` at the front and ` of <production class>` at the back — because
/// config item names contain spaces, so neither `$piece(d, " ", 2)` nor a `[` containment test can
/// recover `EMR Source`. Anchoring on the production class is also what drops a row describing a
/// DIFFERENT production, which a containment test on `item ` alone would report as ours.
ClassMethod HostOf(description As %String) As %String [ Private ]
{
    set head = "item "
    set tail = " of " _ ..#PRODUCTION
    // Explicit $length arithmetic rather than $extract's `*` offsets: the relative form reads more
    // neatly and is one platform-version question this class does not need to carry.
    set len = $length(description)
    if $extract(description, 1, $length(head)) '= head {
        quit ""
    }
    if $extract(description, len - $length(tail) + 1, len) '= tail {
        quit ""
    }
    quit $extract(description, $length(head) + 1, len - $length(tail))
}

/// `$listbuild(setting, previousValue, newValue)` for one `Setting:old>>new` line, or "" if the line
/// is not a setting change. Private.
///
/// SPLITS ON THE FIRST `:` AND REFUSES AMBIGUITY. A value may itself contain a colon (`URL:http://…`)
/// so only the first one delimits the name; a value could in principle contain `>>`, and a line with
/// more than one delimiter is DROPPED rather than split at a guessed position. Reporting
/// `previousValue` wrong is worse than reporting nothing: the whole point of the tool is that an
/// operator may read the old value.
///
/// An EMPTY previous value is legitimate and is kept — a setting added rather than edited audits as
/// `Setting:>>value`, and "this setting did not exist before" is a real diagnosis.
ClassMethod ParseChange(line As %String) As %String [ Private ]
{
    if line '[ ..#DELIM {
        quit ""
    }
    set name = $piece(line, ":", 1)
    if name = "" {
        quit ""
    }
    set rest = $extract(line, $length(name) + 2, $length(line))
    if $length(rest, ..#DELIM) '= 2 {
        quit ""
    }
    quit $listbuild(name, $piece(rest, ..#DELIM, 1), $piece(rest, ..#DELIM, 2))
}

/// The ODBC timestamp `hours` hours ago. Private.
ClassMethod Since(hours As %Integer) As %String [ Private ]
{
    set days = $piece($ztimestamp, ",", 1)
    set secs = $piece($ztimestamp, ",", 2) - (hours * 3600)
    while secs < 0 {
        set days = days - 1
        set secs = secs + 86400
    }
    quit $zdatetime(days _ "," _ secs, 3)
}

/// ODBC timestamp to ISO 8601 UTC. Private.
///
/// `%SYS.Audit.UTCTimeStamp` is already UTC — the column name says so and the values match
/// `$ZDATETIME($ZTIMESTAMP, 3)` — so the `Z` is a statement of fact rather than a conversion. The
/// fractional part is dropped: no question this class answers turns on milliseconds.
ClassMethod IsoUTC(stamp As %String) As %String [ Private ]
{
    if stamp = "" {
        quit ""
    }
    quit $translate($piece(stamp, ".", 1), " ", "T") _ "Z"
}

}
