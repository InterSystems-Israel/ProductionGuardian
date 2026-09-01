/// MCP read tools over `Ens_Util.Log` — the production's EVENT LOG, aggregated and classified.
///
/// Implements the two tools in `contracts/mcp-tools.md` §3.10–3.11. That contract is authoritative;
/// where this class and it disagree, the contract is right and this is a bug.
///
/// WHY A THIRD READ CLASS rather than more methods on `Tools.Read` or `Tools.Activity`. The same two
/// reasons `Tools.Activity` gives, and here the first one is sharper. `Tools.Read` answers *what is
/// true now*; `Tools.Activity` answers *what throughput and latency did over a period*; these answer
/// *what the production said about itself over a period*. The nullability story is different again
/// and it is the OPPOSITE of Activity's: a bucket with no log rows is a MEASURED ZERO -- we read the
/// log and it had nothing to say -- whereas an average over zero messages is `null`. Putting a `0`
/// and a `null` that both mean "empty bucket" in one class comment is how one of them gets returned
/// for the other. The second reason is `Setup.AIHub.ReportTools()`: a new tool FAMILY in a new class
/// moves the count by an amount attributable to one file.
///
/// EVERY PUBLIC CLASSMETHOD HERE BECOMES AN LLM-CALLABLE TOOL, verified in `%AI.Tool.Generator` and
/// restated because it is the mistake this project has already paid for once. Helpers are
/// `[ Private ]` -- nine of them, against two public methods, so this class would discover eleven
/// tools if the keyword were ever dropped. Two public methods, two tools; a third name at boot is a
/// defect, and `Setup.AIHub.ReportTools()` is what makes it a loud one.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE SCHEMA, MEASURED RATHER THAN ASSUMED
///
/// Fifteen columns, read from `%Dictionary.CompiledProperty` on the live instance:
///
///   ConfigName Job MessageId SessionId SourceClass SourceMethod Stack StatusValue Text
///   TimeLogged TraceCat Type   (plus %%OID, %Concurrency)
///
/// `Type` is `Ens.DataType.LogType`, and the enum is read from its own VALUELIST/DISPLAYLIST rather
/// than guessed: `1 Assert, 2 Error, 3 Warning, 4 Info, 5 Trace, 6 Alert`. Note that `2` is the
/// SECOND value, not the first -- `Type <= 2` therefore means "assert or error", which is what
/// `Tools.Read.GetRecentErrors` filters on, and it EXCLUDES warnings. On this instance that is not
/// hypothetical: there are 3 `Type = 3` rows, so a warning is a thing the chat can see and the
/// investigate path structurally cannot.
///
/// `ConfigName` IS NULL, NOT EMPTY, FOR PRODUCTION-LEVEL EVENTS, and this is the single most
/// load-bearing measurement in the class. 91 rows on this instance are written by `Ens.Director` and
/// `Ens.Job` about the production itself -- start, stop, suspend, recover -- and they have no config
/// item. Measured:
///
///     WHERE ConfigName = ''            ->  0 rows
///     WHERE ConfigName IS NULL         -> 91 rows
///     WHERE %EXACT(ConfigName) = ?     ->  0 rows for EVERY value of ?, including ''
///
/// So a tool that filters by host name can never return them, which is why `GetRecentErrors` has
/// never reported a production start failure and why `GetEventLogSummary` groups rather than filters.
/// The `"(production)"` sentinel below is the only way to ask for them by name, and it maps to
/// `IS NULL` rather than to a comparison.
///
/// THE THREE INDEXES ARE ON `ConfigName`, `SessionId` AND `TimeLogged` (read from
/// `%Dictionary.CompiledIndex`), so every predicate here is on an indexed column. `Type` is indexed
/// too. Nothing in this class table-scans.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE DATA BOUNDARY — and this table is the worst one on the instance
///
/// Tool output reaches an external LLM, so metrics and configuration only: never message content,
/// never PHI (root `CLAUDE.md` §2.1, `contracts/mcp-tools.md` §6). Nine of the fifteen columns are
/// refused outright. Column by column, with the reason rather than a verdict:
///
///   RETURNED
///     ConfigName    a config item name. Configuration. `null` becomes `"(production)"`.
///     Type          an enum ordinal, mapped to a fixed word by `..SeverityName`. Selected by BOTH
///                   queries now -- the aggregate one to group by, and the detail one because
///                   `lifecycleFaults` reports a severity per lifecycle event.
///     TimeLogged    a clock reading. A timestamp carries nothing a person typed.
///     SourceClass   a class name, AND ONLY IF `%Dictionary.CompiledClass` confirms it exists.
///     SourceMethod  a method name, AND ONLY IF `%Dictionary.CompiledMethod` confirms it exists. It
///                   is also the KEY into `..LifecycleEvent`'s fixed catalogue, which is why that
///                   catalogue is safe: the name was dictionary-verified before it was looked up.
///
///   COUNTED, NEVER RETURNED
///     Job           an OS process id. Not content, but an identifier of no diagnostic value to a
///                   model; the COUNT of distinct jobs is the useful part (four jobs erroring is a
///                   pool problem, one job erroring is not).
///     SessionId     a handle to a message session. Same reasoning, stronger: an id that can be
///                   dereferenced against message content is a pointer to PHI even though it
///                   contains none. `distinctSessions` is published; no id ever is.
///     MessageId     a handle to an `Ens.MessageHeader`. Populated on every row on this instance.
///                   Not even counted separately -- `distinctSessions` already carries the shape.
///
///   NEVER READ AT ALL
///     Text          the reason this whole class is careful. 61,772 `Type = 4` rows on this instance
///                   carry a `PatientID` in plain text against 66 `Type = 2` rows carrying none.
///                   `Tools.Read.GetRecentErrors`'s comment has the full argument; it applies here
///                   unchanged. Classified through `Tools.ErrorCatalogue`, never returned.
///     StatusValue   MEASURED AT 376-384 CHARACTERS on the error rows, and this is a finding rather
///                   than a size note: a serialised `%Status` embeds the FORMATTED error message,
///                   including every parameter substituted into it. It is `Text` one hop away
///                   wearing a name that sounds like a code. Never read, not even to classify --
///                   `Text` already answers that question and reading two copies doubles the
///                   surface for no gain.
///     Stack         157-746 characters of frame data on the error rows. A stack string can carry
///                   argument values depending on how the error was raised, so it fails the same
///                   test `SiteDimension` fails in `Tools.Activity`: safe because of how today's
///                   code happens to call it, not because of what the column is.
///     TraceCat      caller-supplied free text. Measured EMPTY on all 60 `Type <= 3` rows here, so
///                   nothing is lost by refusing it -- but "empty on this instance" is exactly the
///                   rare-rather-than-absent shape, and `$$$LOGTRACE` takes the category from its
///                   caller.
///
/// THE TYPE 4 POPULATION IS NEVER READ AS TEXT, structurally rather than by filter. The aggregate
/// query selects no `Text` column at all, and the detail query that does select it is bounded by
/// `Type <= ..#CLASSIFIEDMAXTYPE`. So the 8,700+ PHI-bearing info rows are counted by SQL and their
/// text never enters an ObjectScript variable. A `WHERE` clause that filtered them out of one query
/// would be equally correct and one edit away from being wrong; two queries cannot be.
///
/// `lifecycleFaults` RIDES THAT SAME QUERY AND CHANGES NOTHING ABOUT THIS. It is built in the detail
/// loop, from two columns that loop already had -- `SourceMethod` (already dictionary-verified) and
/// `Type` -- so it adds no column, no query and no text. The full argument for why an interpretation
/// belongs in the payload at all is on `..LifecycleEvent`; the boundary-relevant half is that it
/// derives from a fixed catalogue of method names, never from a log row's content.
///
/// WHY CLASSIFY ONLY `Type <= 3`. `Tools.ErrorCatalogue.Classify` is an allowlist of ERROR tokens.
/// Run over info text it returns `"unclassified"` for every row, which would publish "8,731
/// unclassified faults on Cloud API" about a host that logged 8,731 successful deliveries. That is
/// not a leak; it is worse than useless, because it reads as a finding.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// NULLABILITY, per `contracts/mcp-tools.md` §2.1, and read the SIGN of it carefully here. Zero is
/// the RIGHT answer for a count of log rows: the query ran, the window was covered, nothing was
/// logged. `null` is reserved for what could not be read -- a failed query, or a `SourceClass` the
/// dictionary does not confirm. This is the one class in the family where a `0` is not suspect, and
/// stating that is necessary precisely because the other two say the opposite.
Class ProductionGuardian.LabDemo.Tools.EventLog Extends %AI.Tool
{

/// Ceiling on `sinceMinutes` for the summary tool: one day.
///
/// WIDER THAN `GetRecentErrors`'s 60 for a stated reason. That tool answers "is this condition
/// happening" and its comment argues 60 as a data-boundary bound -- a count of one is nearly
/// content. This tool never returns a count below a host/severity pair and never returns text, and
/// the question it exists for is "what has this production been saying today", which 60 minutes
/// cannot answer. A day is where it stops because beyond that the answer is a trend, and that is the
/// other tool.
Parameter MAXWINDOW = 1440;

/// Used when the model omits `sinceMinutes` — see the restatement inside the method for why an
/// ObjectScript default is not enough on the tool path.
Parameter DEFAULTWINDOW = 60;

/// Deliberately the same 720 as `Tools.Activity.#MAXBUCKETS`, so the two trend tools refuse at the
/// same number rather than at two arbitrary ones a reader has to look up.
Parameter MAXBUCKETS = 720;

/// The resolutions the trend tool accepts, as a fixed list — a `$listfind` guard, never a default.
///
/// `"minutes"` WHERE `Tools.Activity` HAS `"seconds"`, and the difference is real rather than
/// careless. Activity's tables are pre-bucketed at 10 s, 1 h and 1 d, so its vocabulary names the
/// tables. `Ens_Util.Log` is event-driven with no buckets at all; buckets here are formed by taking
/// a PREFIX of the `TimeLogged` string (see `..BucketWidth`), and the finest prefix boundary that
/// falls on a clean unit is the minute. A sub-minute grain over a log this sparse would return
/// mostly empty buckets and read as an outage.
Parameter RESOLUTIONS = {$listbuild("minutes", "hours", "days")};

/// The name under which rows with no `ConfigName` are reported, and the only way to ask for them.
///
/// Parenthesised so it cannot collide with a real config item name: `Ens.Config.Item.Name` cannot
/// contain a parenthesis. That matters because the sentinel is compared against `host` before any
/// SQL is built, so a host genuinely called this would silently be redirected to the NULL rows.
Parameter PRODUCTIONSCOPE = "(production)";

/// The highest `Type` whose `Text` is read at all. 3 = warning; 4 = info is the PHI-bearing
/// population. See the class comment's boundary table — this parameter is that decision's only
/// switch, and widening it is a data-boundary change, not a tuning change.
Parameter CLASSIFIEDMAXTYPE = 3;

/// What this production has logged about itself over a recent window: how many events, of what
/// severity, on which hosts, and — for errors and warnings — what kind of fault, from an allowlist.
/// Never returns log message text. Call this before the trend tool when you do not already know
/// which host is logging or how far back the log goes.
ClassMethod GetEventLogSummary(sinceMinutes As %Integer = 60) As %DynamicObject
{
    // AN OMITTED ARGUMENT IS NOT AN INVALID ONE. `%AI.ToolMgr.ExecuteTool` builds the argument list
    // from the model's JSON and passes "" for a key the model did not send, so the `= 60` above never
    // applies on the tool path. `GetRecentErrors` shipped broken for exactly this reason from #106 and
    // it was invisible because every hand-written check passed the argument. Restated, not relied on.
    if sinceMinutes = "" {
        set sinceMinutes = ..#DEFAULTWINDOW
    }
    if (sinceMinutes '= (sinceMinutes \ 1)) || (sinceMinutes < 1) || (sinceMinutes > ..#MAXWINDOW) {
        quit { "error": ("sinceMinutes must be an integer between 1 and " _ ..#MAXWINDOW),
            "sanitised": true }
    }

    set since = ..Since(sinceMinutes)
    set out = { "sinceMinutes": (sinceMinutes), "since": (..IsoUTC(since)),
        "now": (..IsoUTC($zdatetime($ztimestamp, 3))), "rows": null, "bySeverity": [], "byHost": [],
        "classifiedThroughSeverity": (..SeverityName(..#CLASSIFIEDMAXTYPE)), "sanitised": true }

    // RETENTION FIRST, and unbounded by the window on purpose. `Ens_Util.Log` is purged by
    // `Ens.Util.Log.Purge(.deleted, daysToKeep)` and nothing schedules it here, so how far back the
    // log reaches is a property of this instance rather than of the product. A model told "0 errors in
    // the last 60 minutes" needs to know whether the log even covers 60 minutes; `Tools.Activity`'s
    // coverage tool exists for the same reason, and folding it in here is what keeps this family at
    // two tools instead of three.
    set out.retention = ..Retention()

    // QUERY ONE: aggregate, and it selects no `Text`, no `Stack`, no `StatusValue`. Every
    // PHI-bearing row on the instance is counted here and read nowhere.
    //
    // `%EXACT(ConfigName)` in the GROUP BY, not a bare `ConfigName`. The column collates SQLUPPER, so
    // grouping without it would fold `Cloud API` into `CLOUD API` and publish a host name that does
    // not exist in the production. Same reason every host name in `Tools.Activity` is wrapped.
    set sql = "SELECT %EXACT(ConfigName) CN, Type, COUNT(*) N, COUNT(DISTINCT Job) J, "
        _ "COUNT(DISTINCT SessionId) S, MIN(TimeLogged) O, MAX(TimeLogged) W "
        _ "FROM Ens_Util.Log WHERE TimeLogged >= ? GROUP BY %EXACT(ConfigName), Type"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, since)
    if rs.%SQLCODE < 0 {
        // NULL, not 0. "Nothing was logged" is the worst available wrong answer to an operator asking
        // what went wrong -- it would read as a healthy production rather than as a failed read.
        set out.reason = "event log unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        quit out
    }

    set total = 0
    kill host, sev
    while rs.%Next() {
        // `%Get` returns "" for a SQL NULL, which is precisely the ConfigName case the class comment
        // measures. The sentinel is applied here, once, so nothing downstream has to know.
        set name = rs.%Get("CN")
        if name = "" { set name = ..#PRODUCTIONSCOPE }
        set type = rs.%Get("Type"), n = rs.%Get("N")
        set total = total + n
        set sev(type) = $get(sev(type), 0) + n
        set host(name, "rows") = $get(host(name, "rows"), 0) + n
        set host(name, "sev", type) = n
        // Distinct counts are per (host, type) as SQL grouped them, so they cannot simply be summed
        // across types -- a job that logged both an error and an info would be counted twice. MAX is
        // the only honest aggregate available without a second query, and it is a LOWER BOUND: kept
        // because "at least 4 jobs" answers the pool question and an inflated sum would not.
        set host(name, "jobs") = $select($get(host(name, "jobs"), 0) > rs.%Get("J"): host(name, "jobs"), 1: rs.%Get("J"))
        set host(name, "sess") = $select($get(host(name, "sess"), 0) > rs.%Get("S"): host(name, "sess"), 1: rs.%Get("S"))
        set o = rs.%Get("O"), w = rs.%Get("W")
        // String comparison is correct for this format and it is worth saying why, because the
        // fractional part is VARIABLE width on this instance (`.37` and `.343` both occur). The fields
        // are fixed-width and most-significant-first down to the decimal point, and a fraction
        // compares correctly digit by digit from the left, so `]` orders these as time.
        if (o '= "") && (($get(host(name, "oldest")) = "") || (host(name, "oldest") ] o)) {
            set host(name, "oldest") = o
        }
        if (w '= "") && (w ] $get(host(name, "newest"), "")) {
            set host(name, "newest") = w
        }
    }
    set out.rows = total

    // QUERY TWO: the only one that reads `Text`, and it is bounded by Type rather than filtered.
    // Two queries instead of one `CASE` because the boundary is then structural: there is no
    // predicate to loosen by accident.
    set faultSql = "SELECT %EXACT(ConfigName) CN, %EXACT(Text) T, %EXACT(SourceClass) SC, "
        _ "%EXACT(SourceMethod) SM, Type TY, TimeLogged TL FROM Ens_Util.Log "
        _ "WHERE TimeLogged >= ? AND Type <= ?"
    set frs = ##class(%SQL.Statement).%ExecDirect(, faultSql, since, ..#CLASSIFIEDMAXTYPE)
    if frs.%SQLCODE < 0 {
        set out.reason = "fault classification unavailable (SQLCODE " _ frs.%SQLCODE _ ")"
    } else {
        kill fault, source, lifecycle
        while frs.%Next() {
            set name = frs.%Get("CN")
            if name = "" { set name = ..#PRODUCTIONSCOPE }
            // TEXT IN, TOKEN OUT. The row's text is passed to the catalogue and the local `code` is
            // the only thing that survives the statement -- `frs.%Get("T")` is never assigned to a
            // variable that outlives it and never reaches `out`.
            set code = ##class(ProductionGuardian.LabDemo.Tools.ErrorCatalogue).Classify(frs.%Get("T"))
            set fault(name, code) = $get(fault(name, code), 0) + 1
            set tl = frs.%Get("TL")
            if tl ] $get(fault(name, code, "newest"), "") {
                set fault(name, code, "newest") = tl
            }
            // The verified source pair, keyed so the count is per distinct pair rather than per row.
            set ref = ..SourceRef(frs.%Get("SC"), frs.%Get("SM"))
            if ref '= "" {
                set source(name, ref) = $get(source(name, ref), 0) + 1
                // AND THE SAME PAIR AGAIN, INTERPRETED, for the production scope only. See
                // `..LifecycleEvent` for why this is not redundant with `sources` above.
                if name = ..#PRODUCTIONSCOPE {
                    set ev = ..LifecycleEvent($piece(ref, ":", 2))
                    set lifecycle(ev, frs.%Get("TY")) = $get(lifecycle(ev, frs.%Get("TY")), 0) + 1
                }
            }
        }
    }

    // EMITTED IN $ORDER, so the array is alphabetical by host and identical between two calls over
    // the same data. A ranked order would be more useful and is not free: ranking by row count puts
    // whichever host logs most info at the top, which is the busiest host and not the interesting one.
    set name = ""
    for {
        set name = $order(host(name))
        quit:name=""
        set entry = { "host": (name),
            "rows": (host(name, "rows")), "bySeverity": [],
            "distinctJobsAtLeast": (host(name, "jobs")),
            "distinctSessionsAtLeast": (host(name, "sess")),
            "oldest": (..IsoUTC($get(host(name, "oldest")))),
            "newest": (..IsoUTC($get(host(name, "newest")))),
            "faults": [], "sources": [] }
        // `%Set` WITH AN EXPLICIT TYPE, because a `%DynamicObject` built from an ObjectScript 1 or 0
        // serialises as the NUMBER 1 or 0, not as a JSON boolean -- caught by reading the emitted JSON
        // rather than by reasoning about it. A model reading `"productionScope": 0` has to infer that
        // 0 means false; `false` says it.
        do entry.%Set("productionScope", $select(name = ..#PRODUCTIONSCOPE: 1, 1: 0), "boolean")
        // `application`, ON THE SAME REASONING AS `Tools.Activity`'s. This tool groups by whatever
        // `ConfigName` holds, and measured on this instance that is nine names of which five are
        // framework -- `Ens.MonitorService`, `Ens.ScheduleHandler`, `Ens.Actor`, `Ens.Alarm` and
        // `Ens.Activity.Operation.Local`. Without the flag a model reports "nine hosts logged
        // activity" against a dashboard that shows three, and cannot tell the framework's own
        // bookkeeping from a production fault. Shared with `Tools.Activity` through
        // `Tools.HostRoster` rather than copied, because a rule about which hosts are real is one
        // that goes stale in whichever copy nobody edits.
        //
        // NULL FOR THE PRODUCTION SCOPE, not false. `(production)` is not a host, so "is it an
        // application host" has no answer -- and `false` would file the production's own start
        // failures under framework noise, which is the opposite of their importance. §2.1's rule
        // covers this exactly: unmeasurable is null.
        if name = ..#PRODUCTIONSCOPE {
            do entry.%Set("application", "", "null")
            // `lifecycleFaults` ON THE PRODUCTION ENTRY ONLY, and it is present even when empty --
            // an empty array is the measured "nothing went wrong starting or stopping", which is a
            // different statement from the field being absent. See `..LifecycleEvent`.
            set entry.lifecycleFaults = []
            set ev = ""
            for {
                set ev = $order(lifecycle(ev))
                quit:ev=""
                set ty = ""
                for {
                    set ty = $order(lifecycle(ev, ty), 1, n)
                    quit:ty=""
                    do entry.lifecycleFaults.%Push({ "event": (ev),
                        "severity": (..SeverityName(ty)), "count": (n) })
                }
            }
        } else {
            do entry.%Set("application",
                ##class(ProductionGuardian.LabDemo.Tools.HostRoster).IsApplication(name), "boolean")
        }
        set type = ""
        for {
            set type = $order(host(name, "sev", type), 1, n)
            quit:type=""
            do entry.bySeverity.%Push({ "severity": (..SeverityName(type)), "typeCode": (+type),
                "count": (n) })
        }
        set code = ""
        for {
            set code = $order(fault(name, code), 1, n)
            quit:code=""
            // `summary` is JSON null for `unclassified`, which is §3.4a's rule: a count with no
            // interpretation is honest, an invented interpretation is not.
            //
            // AND IT IS SET AS A TYPED NULL, not left as "". A `%DynamicObject` given an ObjectScript
            // empty string serialises it as `""`, and `""` is a value -- a model reading
            // `"summary": ""` sees a summary that happens to be blank, which is the same
            // absent-read-as-measured confusion §2.1 is about. `null` is unambiguous.
            set sum = ##class(ProductionGuardian.LabDemo.Tools.ErrorCatalogue).Summary(code)
            set f = { "errorCode": (code), "count": (n),
                "newest": (..IsoUTC($get(fault(name, code, "newest")))) }
            if sum = "" {
                do f.%Set("summary", "", "null")
            } else {
                set f.summary = sum
            }
            do entry.faults.%Push(f)
        }
        set ref = ""
        for {
            set ref = $order(source(name, ref), 1, n)
            quit:ref=""
            do entry.sources.%Push({ "class": ($piece(ref, ":", 1)),
                "method": ($piece(ref, ":", 2)), "count": (n) })
        }
        do out.byHost.%Push(entry)
    }

    set type = ""
    for {
        set type = $order(sev(type), 1, n)
        quit:type=""
        do out.bySeverity.%Push({ "severity": (..SeverityName(type)), "typeCode": (+type),
            "count": (n) })
    }
    quit out
}

/// How this production's logging has moved over time: event counts per severity, bucket by bucket,
/// for one host or for the whole production. Use it to answer when something started or whether it is
/// getting worse. Never returns log message text.
ClassMethod GetEventLogTrend(host As %String = "", resolution As %String = "hours", buckets As %Integer = 24) As %DynamicObject
{
    // Restated for the same reason as the summary tool: "" arrives for every key the model omitted.
    // `host` is the one argument where "" is a legitimate VALUE -- it means the whole production,
    // hosts and production-level rows together -- so it is the one that is not defaulted here.
    if resolution = "" {
        set resolution = "hours"
    }
    if buckets = "" {
        set buckets = 24
    }
    // A FIXED $listfind, not a lookup the caller composes. An unrecognised resolution is an error
    // rather than a fallback to "hours", because a typo silently answering at the wrong grain is the
    // failure this project has already paid for -- `SystemPrompt` has to tell the model to pick a
    // resolution from the question's span precisely because it defaults to hours for everything.
    if '$listfind(..#RESOLUTIONS, resolution) {
        quit { "error": "resolution must be 'minutes', 'hours' or 'days'", "sanitised": true }
    }
    if (buckets '= (buckets \ 1)) || (buckets < 1) || (buckets > ..#MAXBUCKETS) {
        quit { "error": ("buckets must be an integer between 1 and " _ ..#MAXBUCKETS),
            "sanitised": true }
    }

    set out = { "host": ($select(host = "": "(all)", 1: host)), "resolution": (resolution),
        "buckets": [], "sanitised": true }

    // A HOST NAME THE MODEL INVENTED MUST NOT COME BACK AS ZEROS. Every bucket would read 0, which is
    // this class's MEASURED zero -- indistinguishable from a real host that logged nothing. #58 is the
    // same shape (a host that had never run, published as "active now"), and the fix is the same: say
    // the host is unknown instead of describing it.
    if (host '= "") && (host '= ..#PRODUCTIONSCOPE) {
        set crs = ##class(%SQL.Statement).%ExecDirect(,
            "SELECT COUNT(*) N FROM Ens_Util.Log WHERE %EXACT(ConfigName) = ?", host)
        // A FAILED EXISTENCE CHECK MUST NOT SKIP THE GUARD SILENTLY, which is what one `&&` chain did:
        // `%SQLCODE < 0` made the whole condition false, execution fell through, and the method
        // returned a complete set of zero-filled buckets -- the exact payload the paragraph above
        // exists to prevent, with nothing anywhere saying the check had not run (#156). Every other
        // query site in this class tests `%SQLCODE < 0` on its own; this was the one that folded it
        // into a success test.
        //
        // `reason` and not `error`, because the trend itself is still perfectly readable -- the caller
        // just cannot be told whether the host is real. That is §4's distinction between "could not
        // measure" and "call failed", and `reason` is the field this class already uses for it.
        //
        // `'crs.%Next()` is folded in here for `Retention()`'s reason: a `COUNT(*)` returns exactly one
        // row, so no row at all is a failure wearing a success's SQLCODE.
        if (crs.%SQLCODE < 0) || 'crs.%Next() {
            set out.reason = "host existence unverified (SQLCODE " _ crs.%SQLCODE _ ")"
        } elseif crs.%Get("N") = 0 {
            // NAMES THE TOOL AS THE RUNTIME NAMES IT, which is the METHOD name and not the contract's
            // section title. Measured: `%Discover()` on these classes returns `GetEventLogSummary`,
            // `CompareHostActivity`, `GetRecentErrors` -- PascalCase, no snake_case anywhere -- and
            // `Governance.Invoke` is called with those strings. `contracts/mcp-tools.md` heads its
            // sections `get_recent_errors`, which is a documentation convention; a refusal that told a
            // model to "call get_event_log_summary" would be pointing it at a tool it cannot reach.
            set out.error = "no event log rows exist for that host under any window -- "
                _ "call GetEventLogSummary to see which hosts have logged"
            quit out
        }
    }

    set width = ..BucketWidth(resolution), step = ..BucketStep(resolution)

    // BUCKETS ARE WALL-CLOCK ALIGNED, and they are formed by taking a PREFIX of `TimeLogged` --
    // 16 characters for a minute, 13 for an hour, 10 for a day. So SQL does the bucketing and this
    // method never reads a row: measured, a 3-hour window that holds 4,400+ rows comes back as 133
    // grouped rows. Selecting the rows and bucketing them here would have needed a row cap, and a cap
    // on a DESC scan silently drops the oldest buckets of a trend while the payload looks complete.
    set nowDays = $piece($ztimestamp, ",", 1), nowSecs = $piece($ztimestamp, ",", 2)
    // Align the newest bucket DOWN to its own boundary, so `14:31:36` at minute resolution asks about
    // the bucket starting `14:31` rather than a 60-second window ending now. The buckets then line up
    // with what an operator reads off the log itself.
    set alignedSecs = nowSecs - (nowSecs # step)

    // The oldest bucket's start is the SQL lower bound. Note it is a second-granularity stamp with no
    // fractional part, so it compares as a PREFIX of any row stamp inside that second -- which puts
    // such a row on the >= side, the direction a lower bound wants.
    set oldest = ..StampAt(nowDays, alignedSecs - ((buckets - 1) * step))
    set sql = "SELECT SUBSTR(TimeLogged,1," _ width _ ") B, Type, COUNT(*) N FROM Ens_Util.Log "
        _ "WHERE TimeLogged >= ?"
    // THE SENTINEL BECOMES `IS NULL`, NEVER A COMPARISON. `%EXACT(ConfigName) = ''` matches zero rows
    // on this instance -- measured -- so a sentinel implemented as a comparison would have returned an
    // empty trend for the 91 rows it exists to expose.
    if host = ..#PRODUCTIONSCOPE {
        set sql = sql _ " AND ConfigName IS NULL"
    } elseif host '= "" {
        set sql = sql _ " AND %EXACT(ConfigName) = ?"
    }
    set sql = sql _ " GROUP BY SUBSTR(TimeLogged,1," _ width _ "), Type"
    // The width is interpolated and the host is bound. `width` comes from `..BucketWidth`'s fixed
    // $case and can only be 10, 13 or 16 -- the same fixed-$case-never-concatenation rule
    // `Tools.Activity.TableFor` follows, and for the same injection reason.
    if (host '= "") && (host '= ..#PRODUCTIONSCOPE) {
        set rs = ##class(%SQL.Statement).%ExecDirect(, sql, oldest, host)
    } else {
        set rs = ##class(%SQL.Statement).%ExecDirect(, sql, oldest)
    }
    if rs.%SQLCODE < 0 {
        set out.reason = "event log unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        quit out
    }

    kill tally
    while rs.%Next() {
        set tally(rs.%Get("B"), rs.%Get("Type")) = rs.%Get("N")
    }

    // EMITTED OLDEST-FIRST, and EVERY bucket is emitted including the empty ones. This is the
    // opposite of `Tools.Activity.GetActivityTrend`, which takes the newest N NON-EMPTY buckets on
    // purpose so an idle host still returns the number of buckets asked for. The reason the choice
    // flips here: an event log is bursty, and "when did the errors start" is answered by the empty
    // buckets. Collapsing them would place a burst next to a quiet hour with nothing between them and
    // report a continuous problem. A `0` here is a real reading -- the log was queried for that
    // minute and had nothing in it.
    set totals = 0
    for i = buckets - 1 : -1 : 0 {
        set stamp = ..StampAt(nowDays, alignedSecs - (i * step))
        set key = $extract(stamp, 1, width)
        set b = { "start": (..IsoUTC(stamp)), "total": 0 }
        set n = 0
        for type = 1 : 1 : 6 {
            set c = $get(tally(key, type), 0)
            set n = n + c
            do b.%Set(..SeverityName(type), c)
        }
        set b.total = n
        set totals = totals + n
        do out.buckets.%Push(b)
    }
    set out.from = out.buckets.%Get(0).start
    set out.to = out.buckets.%Get(out.buckets.%Size() - 1).start
    // A TOTAL OVER EXACTLY THE BUCKETS RETURNED, so a question about the window as a whole does not
    // need the model to add up an array it may truncate in its own reasoning.
    set out.total = totals
    quit out
}

/// How far back the log reaches, and how much of it there is. Private — folded into the summary
/// payload rather than exposed as a third tool.
ClassMethod Retention() As %DynamicObject [ Private ]
{
    set rs = ##class(%SQL.Statement).%ExecDirect(,
        "SELECT COUNT(*) N, MIN(TimeLogged) O, MAX(TimeLogged) W FROM Ens_Util.Log")
    if (rs.%SQLCODE < 0) || 'rs.%Next() {
        quit { "rows": null, "oldest": null, "newest": null }
    }
    quit { "rows": (rs.%Get("N")), "oldest": (..IsoUTC(rs.%Get("O"))),
        "newest": (..IsoUTC(rs.%Get("W"))),
        // Said in the payload because it changes how a short window should be read, and the model has
        // no other way to know it: nothing on this instance schedules a purge.
        "note": "retention is purge-driven, not automatic -- Ens.Util.Log.Purge is not scheduled here" }
}

/// The fixed word for a `Type` ordinal. Private.
///
/// Read from `Ens.DataType.LogType`'s own VALUELIST/DISPLAYLIST on the live instance rather than
/// copied from documentation: VALUELIST is `,1,2,3,4,5,6` and DISPLAYLIST is
/// `,Assert,Error,Warning,Info,Trace,Alert`. Lower-cased here so the payload reads like the rest of
/// the contract's vocabulary.
///
/// A FIXED $case rather than `$piece($parameter(...,"DISPLAYLIST"), ",", type + 1)`. Deriving it would
/// be shorter and would make the payload's key names depend on a platform parameter -- so an IRIS
/// upgrade that added a seventh level would change the keys of a published contract without any
/// change here. An unrecognised ordinal becomes `"unrecognised"`, which is loud rather than absent.
ClassMethod SeverityName(type As %String) As %String [ Private ]
{
    quit $case(+type,
        1: "assert",
        2: "error",
        3: "warning",
        4: "info",
        5: "trace",
        6: "alert",
        : "unrecognised")
}

/// Characters of `TimeLogged` that identify a bucket at this resolution. Private.
///
/// `2026-08-26 14:31:36.318` -- 10 characters is the date, 13 adds the hour, 16 adds the minute.
/// Verified by running each width against the live log: 5, 13 and 133 groups respectively.
ClassMethod BucketWidth(resolution As %String) As %String [ Private ]
{
    quit $case(resolution, "minutes": 16, "hours": 13, "days": 10, : "")
}

/// Bucket width in seconds, for walking the boundaries backwards. Private.
ClassMethod BucketStep(resolution As %String) As %String [ Private ]
{
    quit $case(resolution, "minutes": 60, "hours": 3600, "days": 86400, : "")
}

/// An ODBC timestamp `secs` seconds into the day `days`, borrowing days as needed. Private.
///
/// `$ztimestamp` is "days,seconds" and subtracting a negative second count from the seconds half
/// produces a value `$zdatetime` rejects with `<ILLEGAL VALUE>` rather than a wrong answer.
/// `GetRecentErrors` borrows one day; a trend can reach back 720 days, so this borrows in a loop.
ClassMethod StampAt(days As %String, secs As %String) As %String [ Private ]
{
    while secs < 0 {
        set days = days - 1
        set secs = secs + 86400
    }
    quit $zdatetime(days _ "," _ secs, 3)
}

/// The ODBC timestamp `minutes` minutes ago. Private.
ClassMethod Since(minutes As %Integer) As %String [ Private ]
{
    quit ..StampAt($piece($ztimestamp, ",", 1), $piece($ztimestamp, ",", 2) - (minutes * 60))
}

/// `class:method`, and only if the dictionary confirms both exist. "" otherwise. Private.
///
/// THE SAME TECHNIQUE AS `Tools.Activity.ClassifyDimension`: a value is published only when it is
/// INDEPENDENTLY VERIFIABLE as configuration on this instance, never because it looked like a class
/// name. Measured -- all four `SourceClass` values in this log
/// (`Ens.Director`, `Ens.Job`, `EnsLib.File.InboundAdapter`,
/// `ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation`) exist in
/// `%Dictionary.CompiledClass`, so nothing real is lost by requiring it.
///
/// WHY PUBLISH IT AT ALL. Because it is the only thing that identifies the 13 `unclassified` rows on
/// this instance -- all production-lifecycle events with no `ConfigName` and no allowlisted token in
/// their text. `Ens.Director:moveEnsRuntimeToEnsSuspended` tells a model that a production was
/// suspended; `unclassified` alone tells it nothing. Both halves are checked because a method name is
/// a smaller surface than a class name and there is no reason to publish one unverified.
ClassMethod SourceRef(class As %String, method As %String) As %String [ Private ]
{
    if (class = "") || (method = "") {
        quit ""
    }
    if '##class(%Dictionary.CompiledClass).%ExistsId(class) {
        quit ""
    }
    if '##class(%Dictionary.CompiledMethod).%ExistsId(class _ "||" _ method) {
        quit ""
    }
    quit class _ ":" _ method
}

/// Which production lifecycle operation a `SourceMethod` belongs to. Private.
///
/// THE MEASURED DEFECT THIS EXISTS FOR, and it is a correctness finding rather than a nicety. Asked
/// "did the production have any trouble starting or stopping today", a live `gpt-4o-mini` turn read
/// this tool's output, correctly counted the 10 error rows, and answered "there were no issues
/// starting or stopping the production" -- twice, once with `confidence: 0.9` and once with
/// `confidence: 1`. All 10 rows it had just counted were `Ens.Director` lifecycle events and 9 of them
/// were `StartProduction` failures. The information was in `sources`; the inference from a verified
/// method name to "the production failed to start" was the step it would not take, because every one
/// of those codes classifies as `unclassified` and it read an unrecognised code as an absent fault.
///
/// A PROMPT SENTENCE WAS TRIED FIRST AND HELD ON ONE RUN OF THREE. `ChatDispatcher.SystemPrompt` now
/// tells the model to read `sources` before answering a question about a kind of event, and to treat
/// only a count of zero as "nothing happened". That is the fifth time on this project that prose was
/// tried before a deterministic guard, and it went the same way -- so the interpretation moves into the
/// payload, where the model reads a field instead of drawing a conclusion.
///
/// IT IS A FIXED CATALOGUE LOOKED UP BY A VERIFIED KEY, which is `Tools.ErrorCatalogue.Summary`'s shape
/// and deliberately not a new one. The key has already passed `..SourceRef`, so every method named
/// below exists in `%Dictionary.CompiledMethod` on this instance -- confirmed by listing `Ens.Director`
/// and matching. Nothing is derived from a log row, so the data boundary is untouched: a method name is
/// configuration by the same reasoning that publishes `SourceClass` at all.
///
/// `"other"` FOR ANYTHING UNLISTED, never a guess from the method name. A model told `event: "other"`
/// still has the verified pair in `sources` and can say what wrote the rows without being told what
/// they meant -- which is the same honesty `unclassified` and `messageKinds: "other"` ask for.
ClassMethod LifecycleEvent(method As %String) As %String [ Private ]
{
    quit $case(method,
        "StartProduction": "start",
        "SystemStart": "start",
        "RecoverProduction": "start",
        "StopProduction": "stop",
        "SystemStop": "stop",
        "moveEnsRuntimeToEnsSuspended": "stop",
        "UpdateProduction": "update",
        "TempStopConfigItem": "update",
        : "other")
}

/// ODBC timestamp to ISO 8601 UTC. Private.
///
/// `Ens.DataType.UTC` is already UTC -- it is written by `$ZDATETIME($ZTIMESTAMP,3,,3)` -- so the `Z`
/// is a statement of fact rather than a conversion. The fractional part is dropped: it varies in
/// width on this instance (`.37` and `.343` both occur) and no question this class answers turns on
/// milliseconds.
ClassMethod IsoUTC(stamp As %String) As %String [ Private ]
{
    if stamp = "" {
        quit ""
    }
    quit $translate($piece(stamp, ".", 1), " ", "T") _ "Z"
}

}
