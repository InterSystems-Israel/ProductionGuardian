/// MCP read tools over the interoperability ACTIVITY tables — throughput and latency history.
///
/// Implements the three tools in `contracts/mcp-tools.md` §3.7–3.9. That contract is authoritative;
/// where this class and it disagree, the contract is right and this is a bug.
///
/// WHY A SEPARATE CLASS FROM `Tools.Read` rather than three more methods on it. Two reasons, and the
/// second is the one that matters. `Tools.Read` answers *what is true now* -- a status, a depth, a
/// pool size, all read from the live production's own state. These answer *what happened over a
/// period*, read from three persisted rollup tables, and the whole set of failure modes is
/// different: an empty result here means "no traffic in that window", not "unmeasurable". Mixing
/// them would put two nullability stories in one class comment.
///
/// The second reason is the tool count guard. `Setup.AIHub.ReportTools()` prints the number of
/// discovered tools at boot and fails loudly on an unexpected one, because a public helper on
/// `Tools.Resolve` would be a second way to mutate a production. Keeping a new tool FAMILY in a new
/// class means the count moves by a known amount attributable to one file, rather than a diff to a
/// class that already carries the write-adjacent reads.
///
/// EVERY PUBLIC CLASSMETHOD HERE BECOMES AN LLM-CALLABLE TOOL, verified in `%AI.Tool.Generator` and
/// restated because it is the mistake this project has already paid for once. Helpers are
/// `[ Private ]`. Three public methods, three tools; a fourth name at boot is a defect.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE SCHEMA, MEASURED RATHER THAN ASSUMED
///
/// All three tables -- `Ens_Activity_Data.Seconds`, `.Hours`, `.Days` -- carry the SAME twelve
/// columns. Read from `%Dictionary.CompiledProperty`, not from documentation:
///
///   Instance HostName HostType Namespace SiteDimension Period TimeSlot TimeSlotUTC
///   TotalCount TotalDuration TotalDurationSquare TotalQueueDuration
///
/// THEY ARE NOT A PIPELINE. This is the fact that most changes how the tools are written, and it is
/// read out of `Ens.Activity.Utils.AddActivity` rather than inferred from the names: ONE call writes
/// all three rows in one transaction, each into its own bucket via `RoundTimeBack("hh"/"d", ...)`.
/// There is no rollup job, no aggregation pass, and no ordering between them -- so `Days` is not
/// derived from `Hours`, and the three cannot disagree except by a purge. Verified on the live
/// instance: `SUM(TotalCount)` is 102,842 in all three tables.
///
/// So choosing a table is choosing a RESOLUTION, never a freshness or a completeness. `Period` is
/// the bucket width in seconds and is constant per table -- 10, 3600, 86400 -- confirmed by
/// MIN/MAX over every row. The 10 is worth noting: the `Seconds` table buckets at ten seconds, not
/// one, so its name describes its unit and not its grain.
///
/// RETENTION IS PURGE-DRIVEN AND NOT AUTOMATIC. `Ens.Activity.Data.<T>.Purge(periodToKeep)`
/// delegates to `Ens.Activity.Utils.Purge`, which deletes rows with `TimeSlotUTC <= cutoff`. Nothing
/// schedules it here, so on this instance every table holds history back to its first message and
/// `Seconds` is simply the largest -- 21,778 rows against 110 and 29. A tool must therefore never
/// tell an agent that a short window is all the data there is.
///
/// THE GRAIN IS (Instance, Namespace, SiteDimension, HostName, TimeSlot) -- read off the `Lock` and
/// the `WHERE` in `AddActivity`. `Instance` matters in practice and not only in theory: this volume
/// has survived three containers, so `Days` holds rows under three `Instance` values and a naive
/// `GROUP BY HostName` silently sums across container lifetimes. Every query here therefore
/// aggregates deliberately and says in the payload what it collapsed.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE DATA BOUNDARY — and this class has a live risk `Tools.Read` does not
///
/// Tool output reaches an external LLM, so metrics and configuration only: never message content,
/// never PHI (root `CLAUDE.md` §2.1, `contracts/mcp-tools.md` §6).
///
/// Eleven of the twelve columns are counts, sums, timestamps, a host name, a host type, a namespace
/// and an instance name. Those are metrics and configuration by any reading, and they are returned.
///
/// **`SiteDimension` IS DERIVED FROM MESSAGE BODY CONTENT AND IS NEVER RETURNED RAW.** This is the
/// one finding in this class that is a boundary decision rather than a schema note, and it is not
/// visible from the column name -- which is exactly why it is stated at length. Traced through the
/// platform's own code:
///
///   `Ens.Util.Statistics.GetStatsUserDimension` opens the in-flight `Ens.MessageHeader`, opens its
///   `MessageBodyId` as its `MessageBodyClassName`, and calls **`GetStatsDimension()` on the message
///   body object**. `EnsLib.HL7.Message.GetStatsDimension` returns `..Name`. `Ens.MessageBody`
///   returns the default `"-"`. Where the body declines, the fallback is the body CLASS NAME.
///
/// So the value is *computed by the message* on this instance and happens to be a schema structure
/// name or a class name. It is a value a message body chose, and `GetStatsDimension` is an
/// overridable hook: any custom message class may return anything from it, including a field it read
/// off itself. A per-host override also exists -- `SetStatsUserDimension(configName, value)`, stored
/// under `^Ens.Config("stats","userdim")` -- so an operator can put a free-text string here without
/// touching a class.
///
/// That makes `SiteDimension` structurally identical to `Ens_Util.Log.Text`: a field that is safe on
/// today's instance because of how the code that writes it happens to be used, and unsafe the moment
/// someone overrides a hook. `Tools.Read.GetRecentErrors` refused to return log text for exactly
/// that reasoning -- 61,772 rows carry a `PatientID`, and the separation that keeps them out of the
/// error rows is a property of usage rather than of the log. This is the same shape one hop away,
/// and the same answer applies: **classify against an allowlist, never pass the value through.**
///
/// `..ClassifyDimension` is that allowlist. A value is returned only when it is INDEPENDENTLY
/// VERIFIABLE as configuration on this instance -- a loaded HL7 message structure, or a compiled
/// class name -- and anything else becomes `"other"` with no text. Measured live: `ADT_A01` verifies
/// against `EnsLib.HL7.Schema:MessageStructures`, and
/// `ProductionGuardian.LabDemo.Message.PatientDemographics` verifies against
/// `%Dictionary.CompiledClass`. Both are configuration; both survive. A hand-set dimension would not,
/// and that is the point rather than a limitation.
///
/// WHY NOT SIMPLY DROP THE COLUMN. Because it carries the one piece of shape a throughput question
/// needs -- "which kind of message" -- and a diagnosis that cannot distinguish two message types on
/// one host is materially weaker. Returning a CLASSIFICATION keeps the shape and drops the payload,
/// which is the same trade `ErrorSummary`'s catalogue makes: fixed strings looked up by a verified
/// key, never a value copied out of a row.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// NULLABILITY, per `contracts/mcp-tools.md` §2.1: an unmeasurable value is not a small one. An
/// average over zero messages is `null`, never `0` -- a `0` would tell an agent diagnosing slow
/// processing that processing is infinitely fast, which is the inverse of the truth. Every average
/// here is guarded on its own denominator.
Class ProductionGuardian.LabDemo.Tools.Activity Extends %AI.Tool
{

/// The namespace whose activity these tools report on.
///
/// `Ens.Activity.Data.*` is keyed by `Namespace` because a single instance can host several interop
/// namespaces writing into one activity store (`Ens.Activity.Operation.Base` has a
/// `StorageNamespace` setting for exactly that). Pinning it means a tool cannot be induced to report
/// another namespace's traffic by an argument.
///
/// `$namespace` rather than a literal `"LABDEMO"`: these tools run inside the namespace they report
/// on, so reading it is correct in every deployment and a literal would be one more copy to go
/// stale. Held as a method rather than a Parameter because a Parameter is compiled in.
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// The three resolutions, and the SQL table each maps to.
///
/// A FIXED $case in `..TableFor`, never string concatenation into a query. The resolution arrives
/// from an LLM, and `"Ens_Activity_Data." _ resolution` would turn one model-supplied word into a
/// choice of any table in the namespace -- a SQL injection primitive wearing a parameter name. This
/// is the same reasoning as `TriggerDispatcher`'s fixed scenario `$case`.
Parameter RESOLUTIONS = {$listbuild("seconds", "hours", "days")};

/// Largest number of buckets any tool will return, per call.
///
/// A BOUND ON THE RESPONSE, not on the query's reach. `hours` at 720 covers a month and `seconds`
/// at 720 covers two hours, so the cap is generous at every resolution while keeping a reply small
/// enough to put in a prompt. Unbounded, one question could return 21,778 rows -- which is a cost
/// incident against a metered API rather than a better answer.
Parameter MAXBUCKETS = 720;

/// Report which interoperability hosts have recorded activity, and over what period.
///
/// Call this FIRST when you do not already know which hosts exist or how far back the data goes.
/// It answers three things nothing else can: which host names are valid arguments to the other
/// tools, which resolutions actually hold data, and the earliest and latest activity on record --
/// so a question about "last week" can be answered honestly rather than as an empty result.
ClassMethod GetActivityCoverage() As %DynamicObject
{
    set out = { "namespace": ($namespace), "resolutions": [], "hosts": [], "readable": false }

    // COVERAGE IS REPORTED PER RESOLUTION because the three tables are independent (see the class
    // comment) and a purge applies to one at a time. A single "history starts here" would be a
    // claim about whichever table happened to be queried.
    set ptr = 0
    set resolutions = ..#RESOLUTIONS
    while $listnext(resolutions, ptr, resolution) {
        set row = ..CoverageRow(resolution)
        if $isobject(row) {
            do out.resolutions.%Push(row)
            set out.readable = 1
        }
    }
    if 'out.readable {
        // NULL-shaped rather than an empty success: every table failed to read, which is a
        // different fact from "no traffic" and must not be presented as one.
        set out.error = "the activity tables could not be read in " _ $namespace
        quit out
    }

    // Hosts from the HOURS table. Chosen deliberately over `Seconds`: all three receive the same
    // writes, so any of them yields the same host set, and `Hours` is ~200x smaller than `Seconds`
    // for an identical answer (110 rows against 21,778 on this instance).
    set sql = "SELECT %EXACT(HostName) AS HostName, HostType, SUM(TotalCount) AS Msgs, "
        _ "MIN(TimeSlotUTC) AS FirstSlot, MAX(TimeSlotUTC) AS LastSlot "
        _ "FROM Ens_Activity_Data.Hours WHERE Namespace = ? "
        _ "GROUP BY %EXACT(HostName), HostType ORDER BY SUM(TotalCount) DESC"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, $namespace)
    if rs.%SQLCODE < 0 {
        set out.error = "host list unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        quit out
    }
    while rs.%Next() {
        // %EXACT(HostName), and this is not cosmetic. The column's default collation is
        // SQLUPPER, so a bare `SELECT HostName ... GROUP BY HostName` returns `CLOUD API` --
        // measured. `contracts/mcp-tools.md` §2 makes the config item name the join key across
        // four contracts and requires it verbatim, spaces intact and no case folding, so an
        // uppercased name would be a host name that matches nothing the agent can pass back to
        // `get_host_status` or the engine can join on.
        do out.hosts.%Push({
            "host": (rs.%Get("HostName")),
            "hostType": (..HostTypeName(rs.%Get("HostType"))),
            // `application` distinguishes the three LABDEMO hosts from framework plumbing without
            // the caller needing a list of framework names. `Ens.Activity.Operation.Local` writes
            // these rows and appears in them, and `iris/CLAUDE.md` §3 is explicit that it is not an
            // application host -- so an agent asked "which host is slowest" must be able to tell
            // `Ens.MonitorService` from `Cloud API` rather than reporting the framework's own
            // bookkeeping as a finding.
            "application": (..IsApplicationHost(rs.%Get("HostName"))),
            "messages": (+rs.%Get("Msgs")),
            "firstActivityUTC": (..IsoUTC(rs.%Get("FirstSlot"))),
            "lastActivityUTC": (..IsoUTC(rs.%Get("LastSlot")))
        })
    }
    quit out
}

/// Report message throughput and latency for one host over a time window, bucket by bucket.
///
/// Use this to answer questions about a TREND -- whether a host is speeding up or slowing down,
/// when a backlog began, whether traffic is steady. Each bucket carries the message count and the
/// average processing and queueing time for that bucket, so a rise or fall is visible rather than
/// averaged away. Choose the resolution to suit the question: "days" for weeks, "hours" for a day,
/// "seconds" (ten-second buckets) for the last few minutes.
///
/// Averages are null for a bucket with no messages, never zero.
ClassMethod GetActivityTrend(host As %String, resolution As %String = "hours", buckets As %Integer = 24) As %DynamicObject
{
    // AN OMITTED OPTIONAL ARGUMENT ARRIVES AS "", NOT AS THE DEFAULT ABOVE, so both defaults are
    // restated here. `%AI.ToolMgr.ExecuteTool` builds the argument list from the model's JSON and
    // passes "" for a key the model did not send -- the ObjectScript default never fires on the tool
    // path. `contracts/mcp-tools.md` §2 documents this after it was live for four days in
    // `GetRecentErrors`, where the tool refused every call the model made and the agent, blinded to
    // the evidence, recommended a fix for the wrong cause.
    //
    // ABSENCE AND A WRONG VALUE ARE HANDLED SEPARATELY, which is the half that is easy to lose:
    // absence means "use the default", a value the model SENT and got wrong is still refused with
    // its range named. Collapsing them either way loses one.
    if resolution = "" {
        set resolution = "hours"
    }
    if buckets = "" {
        set buckets = 24
    }

    set out = { "host": (host), "resolution": (resolution), "buckets": [], "measured": false }

    set table = ..TableFor(resolution)
    if table = "" {
        quit { "host": (host), "error": ("resolution must be one of " _ $listtostring(..#RESOLUTIONS, ", ")) }
    }
    if (buckets '= (buckets \ 1)) || (buckets < 1) || (buckets > ..#MAXBUCKETS) {
        quit { "host": (host), "error": ("buckets must be an integer between 1 and " _ ..#MAXBUCKETS) }
    }

    // TOP ? ... ORDER BY TimeSlotUTC DESC takes the most recent N buckets, then they are emitted
    // oldest-first below. Ordering the other way and truncating would return the oldest N, which is
    // the wrong end of the history for every question a trend answers.
    //
    // NO `WHERE TimeSlotUTC >= <cutoff>`, deliberately. A cutoff derived from `buckets x Period`
    // would return fewer buckets than asked for whenever the host was idle -- so "the last 24
    // hours" and "the last 24 hours that had traffic" would be indistinguishable in the reply, and
    // an agent asking about a quiet period would see a short array rather than a quiet one. Taking
    // the newest N ROWS means every returned bucket is one that exists, and `from`/`to` state the
    // span they actually cover.
    //
    // GROUPED BY TimeSlotUTC across Instance and SiteDimension, because this volume has outlived
    // three containers and holds rows under three `Instance` values -- and one host can write two
    // SiteDimension series. Both collapses are reported in the payload rather than left implicit.
    set sql = "SELECT TOP ? TimeSlotUTC, SUM(TotalCount) AS Msgs, SUM(TotalDuration) AS Dur, "
        _ "SUM(TotalQueueDuration) AS QDur, MIN(Period) AS Secs, COUNT(*) AS Series "
        _ "FROM Ens_Activity_Data." _ table _ " "
        _ "WHERE Namespace = ? AND HostName = ? "
        _ "GROUP BY TimeSlotUTC ORDER BY TimeSlotUTC DESC"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, buckets, $namespace, host)
    if rs.%SQLCODE < 0 {
        // NULL, not an empty bucket list. "No traffic" and "could not read" are opposite
        // conclusions for an agent diagnosing a throughput drop, and an empty array reads as the
        // first.
        set out.error = "activity unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        quit out
    }

    // Collected then reversed, so the array reads oldest -> newest while the query took the newest.
    kill rows
    set n = 0
    while rs.%Next() {
        set n = n + 1
        set rows(n) = $listbuild(rs.%Get("TimeSlotUTC"), +rs.%Get("Msgs"), +rs.%Get("Dur"),
            +rs.%Get("QDur"), +rs.%Get("Secs"), +rs.%Get("Series"))
    }
    if n = 0 {
        // A SUCCESS, and it says so. An unknown host and a silent host are different facts, so the
        // reason names which -- checked against the production's own config item set rather than
        // guessed from the absence of rows.
        set out.reason = $select(..IsConfigItem(host): "no recorded activity for this host",
            1: "no activity recorded, and '" _ host _ "' is not a config item in " _ ..#PRODUCTION)
        quit out
    }

    set totalMsgs = 0, totalDur = 0, totalQDur = 0, multiSeries = 0
    for i = n:-1:1 {
        set slot = $list(rows(i), 1), msgs = $list(rows(i), 2)
        set dur = $list(rows(i), 3), qdur = $list(rows(i), 4)
        set secs = $list(rows(i), 5), series = $list(rows(i), 6)
        if series > 1 {
            set multiSeries = 1
        }
        set totalMsgs = totalMsgs + msgs
        set totalDur = totalDur + dur
        set totalQDur = totalQDur + qdur
        do out.buckets.%Push({
            "startUTC": (..IsoUTC(slot)),
            "periodSeconds": (secs),
            "messages": (msgs),
            // Averages, not the raw sums. A sum of durations is meaningless without its count and
            // an agent would have to divide -- which is a step it can get wrong. The SUMS are what
            // the table holds; the averages are what the question is about.
            "avgProcessingTime": (..Divide(dur, msgs)),
            "avgQueueingTime": (..Divide(qdur, msgs)),
            // Messages per second WITHIN the bucket, so buckets of different widths are
            // comparable. `periodSeconds` is stated alongside so the derivation is checkable.
            "messagesPerSecond": (..Rate(msgs, secs))
        })
    }

    set out.measured = 1
    set out.from = out.buckets.%Get(0).startUTC
    set out.to = out.buckets.%Get(out.buckets.%Size() - 1).startUTC
    // A TOTALS BLOCK over exactly the buckets returned, so a question about the window as a whole
    // does not require the model to re-aggregate an array it was given. Its averages are weighted
    // by message count by construction -- summing the sums and dividing once is the weighted mean,
    // where averaging the per-bucket averages would weight a one-message bucket like a
    // thousand-message one.
    set out.totals = {
        "messages": (totalMsgs),
        "avgProcessingTime": (..Divide(totalDur, totalMsgs)),
        "avgQueueingTime": (..Divide(totalQDur, totalMsgs))
    }
    // STATED RATHER THAN SILENT. `Instance` is part of the table's grain and this volume holds
    // three of them, so a reply that summed across container lifetimes without saying so would be
    // a number nobody could reproduce.
    set out.aggregatedAcross = { "instances": true, "messageKinds": (''multiSeries) }
    quit out
}

/// Compare recorded activity across all hosts over one window, ranked by volume.
///
/// Use this to answer "which host is busiest", "which is slowest", or "where is time being spent"
/// without calling the trend tool once per host. Returns one row per host with its message count,
/// average processing and queueing time, and a classification of the KINDS of message it handled.
///
/// Averages are null for a host with no messages in the window, never zero.
ClassMethod CompareHostActivity(resolution As %String = "hours", buckets As %Integer = 24) As %DynamicObject
{
    // Both optional arguments restated, for the reason given in full on GetActivityTrend.
    if resolution = "" {
        set resolution = "hours"
    }
    if buckets = "" {
        set buckets = 24
    }

    set table = ..TableFor(resolution)
    if table = "" {
        quit { "error": ("resolution must be one of " _ $listtostring(..#RESOLUTIONS, ", ")) }
    }
    if (buckets '= (buckets \ 1)) || (buckets < 1) || (buckets > ..#MAXBUCKETS) {
        quit { "error": ("buckets must be an integer between 1 and " _ ..#MAXBUCKETS) }
    }

    set out = { "resolution": (resolution), "hosts": [], "measured": false }

    // THE WINDOW IS DERIVED FROM THE DATA, not from the clock. The newest `buckets` distinct time
    // slots present are found first, and the comparison runs over exactly those -- so every host is
    // compared over the SAME span, and a window with no traffic yields an honest empty result
    // rather than a wall-clock range that happens to contain nothing.
    //
    // Two queries rather than one, because a per-host TOP N would give each host its own window and
    // the comparison would be between different periods -- which is the defect a "compare" tool
    // exists to avoid.
    set slotSql = "SELECT TOP ? TimeSlotUTC FROM Ens_Activity_Data." _ table _ " "
        _ "WHERE Namespace = ? GROUP BY TimeSlotUTC ORDER BY TimeSlotUTC DESC"
    set rs = ##class(%SQL.Statement).%ExecDirect(, slotSql, buckets, $namespace)
    if rs.%SQLCODE < 0 {
        set out.error = "activity unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        quit out
    }
    // The query is ORDER BY DESC, so the first row is the newest and the last is the oldest. Taken
    // positionally rather than compared: `to` is set once from the first row and `from` is
    // overwritten by every row, which leaves it holding the last. A min/max comparison would work
    // too and this cannot disagree with the ORDER BY.
    //
    // Fixed-width, most-significant-first timestamps would compare correctly as strings, but not
    // relying on that is what makes this independent of the column's format.
    set from = "", to = ""
    while rs.%Next() {
        set slot = rs.%Get("TimeSlotUTC")
        if to = "" {
            set to = slot
        }
        set from = slot
    }
    if to = "" {
        set out.reason = "no activity recorded at this resolution"
        quit out
    }

    set sql = "SELECT %EXACT(HostName) AS HostName, HostType, SUM(TotalCount) AS Msgs, "
        _ "SUM(TotalDuration) AS Dur, SUM(TotalQueueDuration) AS QDur, "
        _ "COUNT(DISTINCT TimeSlotUTC) AS Slots, MIN(Period) AS Secs "
        _ "FROM Ens_Activity_Data." _ table _ " "
        _ "WHERE Namespace = ? AND TimeSlotUTC >= ? AND TimeSlotUTC <= ? "
        _ "GROUP BY %EXACT(HostName), HostType ORDER BY SUM(TotalCount) DESC"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, $namespace, from, to)
    if rs.%SQLCODE < 0 {
        set out.error = "comparison unreadable (SQLCODE " _ rs.%SQLCODE _ ")"
        quit out
    }

    while rs.%Next() {
        set host = rs.%Get("HostName"), msgs = +rs.%Get("Msgs")
        do out.hosts.%Push({
            "host": (host),
            "hostType": (..HostTypeName(rs.%Get("HostType"))),
            "application": (..IsApplicationHost(host)),
            "messages": (msgs),
            "avgProcessingTime": (..Divide(+rs.%Get("Dur"), msgs)),
            "avgQueueingTime": (..Divide(+rs.%Get("QDur"), msgs)),
            // TOTAL processing time, kept alongside the average because they answer different
            // questions: the average says how slow each message was, the total says where the
            // instance's time actually went. A host at 0.001s x 12,000 messages and one at
            // 1.0s x 12 have the same story only in one of the two columns.
            "totalProcessingTime": (+rs.%Get("Dur")),
            "bucketsWithActivity": (+rs.%Get("Slots")),
            // CLASSIFIED, NEVER THE RAW VALUE. See the class comment: SiteDimension is computed by
            // the message body via an overridable hook, so it is treated as untrusted text and only
            // independently-verifiable configuration names survive.
            "messageKinds": (..MessageKinds(table, host))
        })
        set out.measured = 1
    }
    set out.from = ..IsoUTC(from)
    set out.to = ..IsoUTC(to)
    set out.bucketsRequested = buckets
    quit out
}

/// One coverage row for a resolution, or "" when its table cannot be read. Private.
ClassMethod CoverageRow(resolution As %String) As %DynamicObject [ Private ]
{
    set table = ..TableFor(resolution)
    if table = "" {
        quit ""
    }
    set sql = "SELECT COUNT(*) AS Rows_, MIN(TimeSlotUTC) AS FirstSlot, MAX(TimeSlotUTC) AS LastSlot, "
        _ "MIN(Period) AS MinSecs, MAX(Period) AS MaxSecs "
        _ "FROM Ens_Activity_Data." _ table _ " WHERE Namespace = ?"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, $namespace)
    if rs.%SQLCODE < 0 {
        quit ""
    }
    if 'rs.%Next() {
        quit ""
    }
    set rows = +rs.%Get("Rows_")
    // `periodSeconds` is null when the table is EMPTY rather than 0: the bucket width is a property
    // of the table and an empty table has not told us what it is. Reported from the data instead of
    // a compiled-in 10/3600/86400, so a build that changes a width is visible rather than
    // contradicted.
    set out = {
        "resolution": (resolution),
        "buckets": (rows),
        "periodSeconds": ($select(rows = 0: "", 1: +rs.%Get("MinSecs"))),
        "earliestUTC": (..IsoUTC(rs.%Get("FirstSlot"))),
        "latestUTC": (..IsoUTC(rs.%Get("LastSlot")))
    }
    // A MIXED PERIOD WOULD MEAN THE TABLE IS NOT WHAT THIS CLASS ASSUMES. Reported rather than
    // silently taking the minimum, because every rate in the trend tool divides by this number --
    // measured as constant per table on this instance (10 / 3600 / 86400), and a build where it is
    // not would make those rates wrong without anything looking wrong.
    if (rows > 0) && (+rs.%Get("MinSecs") '= +rs.%Get("MaxSecs")) {
        set out.periodVaries = 1
        set out.periodSecondsMax = +rs.%Get("MaxSecs")
    }
    quit out
}

/// The classified message kinds one host recorded in a table. Private.
///
/// Returns an array of `{kind, verifiedAs}` objects, deduplicated. See `ClassifyDimension` for why
/// nothing is passed through unverified.
ClassMethod MessageKinds(table As %String, host As %String) As %DynamicArray [ Private ]
{
    set out = []
    set sql = "SELECT DISTINCT %EXACT(SiteDimension) AS Dim FROM Ens_Activity_Data." _ table _ " "
        _ "WHERE Namespace = ? AND HostName = ?"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, $namespace, host)
    if rs.%SQLCODE < 0 {
        quit out
    }
    kill seen
    while rs.%Next() {
        set classified = ..ClassifyDimension(rs.%Get("Dim"))
        set kind = $list(classified, 1), verifiedAs = $list(classified, 2)
        // Deduplicated on the CLASSIFICATION, not on the raw value: several unverifiable dimensions
        // all collapse to one `other` entry rather than revealing how many distinct values existed,
        // which would itself be a small leak about the traffic.
        if $data(seen(kind)) {
            continue
        }
        set seen(kind) = 1
        do out.%Push({ "kind": (kind), "verifiedAs": (verifiedAs) })
    }
    quit out
}

/// Classify a SiteDimension into a safe-to-return value. Private.
///
/// THE ALLOWLIST FOR THIS CLASS, and it is a verification rather than a pattern match. A value is
/// returned VERBATIM only when this instance can independently confirm it names configuration:
///
///   `-`               the platform's own default, `$$$StatsDefaultDimension` -- no message
///                     contributed it. Returned as `none`.
///   an HL7 structure  present in `EnsLib.HL7.Schema:MessageStructures` for a loaded category.
///                     Configuration: someone loaded that schema into this namespace.
///   a compiled class  present in `%Dictionary.CompiledClass`. Configuration: someone deployed it.
///   anything else     `other`, with NO text.
///
/// WHY VERIFICATION AND NOT A REGEX. A pattern like "looks like a class name" would pass
/// `Patient.Smith.John` -- three dots and legal identifier characters -- and a pattern for "looks
/// like an HL7 structure" would pass `MRN_12345`. Both would be a leak through a gap in a pattern,
/// which is precisely why `Tools.Read.ClassifyError` is an allowlist of literal tokens rather than a
/// shape test. Checking against what this instance actually has is the strongest available test and
/// it fails closed: an unrecognised value is refused rather than reasoned about.
///
/// A DENYLIST WAS NOT CONSIDERABLE. It would have to anticipate every shape a patient identifier can
/// take, which is not a bet worth taking on a healthcare system -- `mcp-tools.md` §6 and
/// `Tools.Read`'s own comment both settle this, and the conclusion is the same here.
///
/// Returns a two-element $list: the value to publish, and how it was verified.
ClassMethod ClassifyDimension(dim As %String) As %List [ Private ]
{
    if (dim = "") || (dim = "-") {
        // `$$$StatsDefaultDimension` is "-" on this build, confirmed by reading it. Compared as a
        // literal because the macro is not available to every compilation unit that might inline
        // this, and the platform writes "-" into the column itself when the value is empty
        // (`AddActivity`: `If pSiteDimension = "" Set pSiteDimension = "-"`).
        quit $listbuild("none", "platform_default")
    }
    // COMPILED CLASS FIRST, because it is an exact-case dictionary lookup and therefore the
    // cheapest definite answer. `%ExistsId` is case-SENSITIVE for class names -- measured: the
    // exact-case name exists and the uppercased one does not -- which is also why every query in
    // this class reads `%EXACT(SiteDimension)`. Without it the collated value `PRODUCTIONGUARDIAN...`
    // would fail this check and a legitimate class name would be published as `other`.
    if ##class(%Dictionary.CompiledClass).%ExistsId(dim) {
        quit $listbuild(dim, "compiled_class")
    }
    if ..IsHL7Structure(dim) {
        quit $listbuild(dim, "hl7_message_structure")
    }
    // NO TEXT. The count of unverifiable kinds is not published either -- see MessageKinds.
    quit $listbuild("other", "unverified")
}

/// Is this a message structure in a loaded HL7 schema category? Private.
///
/// Enumerates `EnsLib.HL7.Schema:MessageStructures` per category. The rows come back as
/// `<category>:<structure>` -- measured, `2.5:ADT_A01`, which is why the comparison is on the piece
/// after the colon rather than on the whole row. A first attempt compared the whole value and
/// reported `ADT_A01` as unverified, which would have published a real structure name as `other`;
/// caught by asserting the positive case rather than only the negative.
ClassMethod IsHL7Structure(name As %String) As %Boolean [ Private ]
{
    // Bare-name guard before touching the schema tables: a value with a colon or a space in it
    // cannot be a structure name, and this keeps a long free-text dimension from being enumerated
    // against every loaded category.
    if (name [ ":") || (name [ " ") || ($length(name) > 32) {
        quit 0
    }
    set found = 0
    set rs = ##class(%ResultSet).%New("EnsLib.HL7.Schema:MessageStructures")
    // IncludeBase = 1 so structures inherited from a base category count. A structure a loaded
    // schema resolves is configuration on this instance whether it was declared locally or
    // inherited, and excluding the inherited ones would refuse names the production really uses.
    set sc = rs.Execute("", 1)
    if $$$ISERR(sc) {
        // FAILS CLOSED. An unreadable schema table means "cannot verify", and an unverified value
        // must be refused rather than trusted -- returning 1 here would turn a read failure into a
        // disclosure.
        quit 0
    }
    while rs.Next() {
        // `<category>:<structure>`; take the structure. $piece with the LAST piece rather than the
        // second, so a category containing a colon cannot shift the field.
        set row = rs.GetData(1)
        if $piece(row, ":", $length(row, ":")) = name {
            set found = 1
            quit
        }
    }
    do rs.Close()
    quit found
}

/// Table suffix for a resolution, or "" when the name is not one of the three. Private.
///
/// A FIXED $case, never concatenation of the argument into a table name. `resolution` arrives from a
/// model, and building `"Ens_Activity_Data." _ resolution` would let one JSON field name any table
/// in the namespace -- an injection primitive rather than a parameter. Same reasoning as
/// `TriggerDispatcher`'s scenario `$case`, and the value returned here is the only thing ever
/// concatenated into a query.
ClassMethod TableFor(resolution As %String) As %String [ Private ]
{
    quit $case($zconvert(resolution, "L"),
        "seconds": "Seconds",
        "hours": "Hours",
        "days": "Days",
        : "")
}

/// Host type number to name. Private.
///
/// The mapping is read from the COLUMN'S OWN DESCRIPTION in `%Dictionary.CompiledProperty`:
/// "Business host type: 1=Service, 2=Process, 3=Operation, 4 = Production Actor Pool." The property
/// carries no VALUELIST, so its description is the authority available on the instance.
///
/// NOT `Ens.Config.Item.BusinessType()`, which disagrees for one of the LABDEMO hosts and would
/// have been the natural thing to reuse. Measured: `Lab Router` reports `businessType=2` from the
/// config item and `HostType=4` in the activity tables. Both are right about different things -- a
/// routing engine is configured as a process and its activity is recorded against the actor pool
/// that runs it -- so this translates what the TABLE says and does not reconcile the two.
/// `contracts/healthscan-api.md` Q10 already notes the engine normalises `actor` to `process` for
/// its own output; that normalisation is not applied here, because this reports what was recorded.
ClassMethod HostTypeName(type As %String) As %String [ Private ]
{
    quit $case(+type,
        1: "service",
        2: "process",
        3: "operation",
        4: "actor_pool",
        : "unknown")
}

/// Is this host one of the production's APPLICATION config items? Private.
///
/// Reads the running production's `<Item>` set and excludes the framework hosts, rather than
/// carrying a list of framework names. Root `CLAUDE.md` §6 makes `Production.cls`'s item set the
/// authority precisely because a copied host list is what went stale when `FHIR Transform` was
/// removed -- so this asks the production instead of restating it.
///
/// `Ens.*` prefixed items are framework: `Ens.Activity.Operation.Local` IS a config item and
/// `iris/CLAUDE.md` §3 states it is not an application host. The activity tables also record hosts
/// that are not config items at all -- `Ens.MonitorService`, `Ens.Alerting.AlertMonitor`,
/// `Ens.ScheduleService`, `Ens.ScheduleHandler` -- which are framework services the interop
/// framework runs itself. Both cases resolve to `false` here, by the prefix test and by absence
/// respectively.
ClassMethod IsApplicationHost(host As %String) As %Boolean [ Private ]
{
    if $extract(host, 1, 4) = "Ens." {
        quit 0
    }
    quit ..IsConfigItem(host)
}

/// Is this host a config item in the production this class reports on? Private.
ClassMethod IsConfigItem(host As %String) As %Boolean [ Private ]
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$isobject(def) {
        quit 0
    }
    // Explicit result variable rather than a bare `quit` inside the FOR -- the same reasoning as
    // `Tools.Read.FindItem`, where breaking the loop left the variable holding whatever was last
    // examined.
    set result = 0
    for i = 1:1:def.Items.Count() {
        if def.Items.GetAt(i).Name = host {
            set result = 1
            quit
        }
    }
    quit result
}

/// numerator / denominator, or "" when the denominator is zero. Private.
///
/// "" BECOMES JSON null, AND THAT IS THE WHOLE POINT. An average over zero messages is not zero
/// seconds -- `contracts/mcp-tools.md` §2.1, and this project has paid for the opposite three times
/// (#33, #49, #58). A `0` here would tell an agent diagnosing `slow_processing` that processing is
/// infinitely fast, which is the most confident possible wrong answer.
///
/// Rounded to microseconds. The stored sums carry more digits than the measurement justifies --
/// `TotalDuration` is a sum of individually-rounded millisecond readings -- and a full-precision
/// quotient like 1.0064032363351939... in a prompt is noise the model has to look past.
ClassMethod Divide(total As %Numeric, count As %Integer) As %String [ Private ]
{
    if +count = 0 {
        quit ""
    }
    quit $number(total / count, 6)
}

/// Messages per second across a bucket, or "" when the width is unknown. Private.
ClassMethod Rate(count As %Integer, seconds As %Integer) As %String [ Private ]
{
    if +seconds = 0 {
        quit ""
    }
    quit $number(count / seconds, 4)
}

/// An ODBC timestamp as ISO 8601 UTC, or "" when absent. Private.
///
/// The column is `%TimeStamp`, so SQL hands back `2026-08-23 11:07:00` -- space-separated and with
/// no zone marker. `contracts/mcp-tools.md` §2 requires `Z`-suffixed ISO 8601, and the value IS
/// already UTC (`TimeSlotUTC`, and the property description says so), so this is a format change
/// and not a conversion.
///
/// "" IN, "" OUT -- never a substituted "now". An absent timestamp is the #58 shape: a host that had
/// never run published as active at this instant is the most confident possible wrong answer.
ClassMethod IsoUTC(stamp As %String) As %String [ Private ]
{
    if stamp = "" {
        quit ""
    }
    quit $translate($piece(stamp, ".", 1), " ", "T") _ "Z"
}

}
