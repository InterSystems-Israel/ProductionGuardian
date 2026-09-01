/// One persisted, queryable record of one MCP tool call.
///
/// WHY THIS CLASS EXISTS AT ALL, and it is not a preference. AI Hub ships no audit STORE.
/// `contracts/mcp-tools.md` §5.6(a) listed "what an audit record actually contains once written,
/// and whether it is queryable" as unverified; the answer, measured on build 126, is that nothing
/// is written anywhere:
///
///   %AI.ToolMgr.%New().AuditPolicy      ->  <none>
///   %AI.Policy.ConsoleAudit.%LogExecution -> ANSI-coloured text to the current device
///
/// So the only shipped policy prints a box to a terminal and returns. There is no `%AI.Audit.*`
/// persistent class -- searched `%Dictionary.CompiledClass` for `%AI.*` matching AUDIT or LOG and
/// the only hits are the policy classes themselves. "Every call is audited" was therefore true of
/// the HOOK and false of the RECORD, and MVP 2 §3's final demo step is showing an audit entry.
///
/// A ROW PER ATTEMPT, not per change. `iris/labdemo/Tools/AuditPolicy.cls` writes the executed
/// calls and `Tools.AuthPolicy` writes the denied ones -- see `Source` below for why those are two
/// writers rather than one, and see AuditPolicy's class comment for the measurement that forced it.
///
/// THE DATA BOUNDARY IS INHERITED, NOT RE-ENFORCED HERE. `Result` holds the tool's own return
/// value, and the tools are what guarantee that value carries only metrics and configuration --
/// `Tools.Read.GetRecentErrors` classifies errors to an allowlisted token precisely so that neither
/// the model nor this table ever sees log text (root `CLAUDE.md` §2.1, `mcp-tools.md` §6). This
/// class does not sanitise, and must not be read as a second line of defence: if a tool ever
/// returns PHI, it lands here in plain text. That is an argument for keeping the guarantee in the
/// tools, which is where `mcp-tools.md` §5.5 already puts it.
Class ProductionGuardian.LabDemo.Audit.Entry Extends %Persistent
{

/// Prefix of the public handle. `resolve-api.md` §8 shows `aihub-audit-44812`, which would claim
/// this row came out of an AI Hub audit store. It did not -- there is no such store on this build
/// (see the class comment), and we mint the handle ourselves. Naming it `pg-audit-` says who wrote
/// it. The contract renders the handle as an opaque string, so the value is free; the provenance it
/// implies is not, and inventing one is the same defect as inventing an id for the mock resolve
/// (`resolve-api.md` §8: "inventing an id that resolves to nothing is worse than admitting there is
/// none"). Recorded as a contract-correction request alongside the `%`-prefixed role names.
Parameter HANDLEPREFIX = "pg-audit-";

/// UTC, ISO 8601. `recordedAt` in `resolve-api.md` §8.
Property RecordedAt As %String(MAXLEN = 32) [ Required ];

/// The authenticated IRIS principal, from `$username` at the moment of the call.
///
/// `resolve-api.md` §8 is explicit that this is resolved server-side and that a caller cannot name
/// itself -- `requestedBy` is the advisory label and is recorded NEXT TO this, never instead of it.
/// Measured: `%LogExecution`'s `metadata` argument arrives as an empty object `{}`, so there is no
/// identity in the hook payload and `$username` is the only truthful source.
Property Actor As %String(MAXLEN = 128) [ Required ];

/// `$roles` at the moment of the call, verbatim.
///
/// Stored as the raw list rather than "the role that authorized", because which role satisfied the
/// check is not something the policy is told -- it asks `$SYSTEM.Security.Check` a yes/no question.
/// Recording the whole set is the honest answer and is what lets a reviewer see that the actor held
/// `%All` rather than `Guardian_Resolve`, which is the interesting fact about a demo instance.
Property Roles As %String(MAXLEN = 512);

/// Tool name as the runtime names it -- `GetPoolSize`, `SetPoolSize`.
///
/// THE OBJECTSCRIPT METHOD NAME, not the snake_case name in `mcp-tools.md`. Measured from a real
/// `%LogExecution` payload: `call.name` is `"GetPoolSize"`. The contract's catalogue calls the same
/// tool `get_pool_size`, so anything joining this column to the contract must map, and
/// `Tools.AuthPolicy.#WRITETOOL` already depends on the method-name form.
///
/// ON A `dropped` ROW THIS IS A GUARD, NOT A TOOL -- `DropUnapplicableAction` and its three siblings.
/// Still an ObjectScript method name, so the column stays one kind of thing and `ByTool` stays useful
/// for "did this guard ever fire". But it means **counting tool calls from this table must filter on
/// `Disposition`**, which the `Audit.Entry`-delta method in #192 did not have to do and any repeat of
/// it now does.
Property Tool As %String(MAXLEN = 128) [ Required ];

/// The call's arguments as JSON.
///
/// `call.arguments` arrives as a JSON STRING, not an object -- measured, and worth stating because
/// `%GetIterator()` on it fails rather than yielding the arguments. Stored as received.
Property Arguments As %String(MAXLEN = "");

/// The tool's return value as JSON, or "" when the call never executed.
///
/// This is the "what changed" half of *who acted, what changed, when*. For `SetPoolSize` it carries
/// `before`, `after` and `reversal`, which is what makes a change reviewable and reversible from the
/// record alone rather than from the operator's memory.
Property Result As %String(MAXLEN = "");

/// `executed` | `denied` | `dropped`.
///
/// ONE VALUE PER WRITER, and each writer exists because the one before it could not see the event.
/// `%AI.ToolMgr.ExecuteTool` checks authorization, then executes, then audits -- so an authorization
/// denial THROWS `<%AICore>ToolAccessDenied` at step one and the audit hook is never reached.
/// Measured, with a deny-all policy registered: 0 audit records written, `%LogExecution` never
/// called. `Tools.AuthPolicy` therefore writes its own `denied` row, because it is the only code
/// that ever learns a denial happened.
///
/// This is why `mcp-tools.md` §5.5 and `resolve-api.md` §8 both overpromise: a tool-level refusal
/// (our bounds guard returning `outcome: "refused"`) IS audited, because the tool ran; an
/// authorization refusal is not. The security-relevant one was the one missing.
///
/// `dropped` IS THE THIRD, and it arrived the same way (#196). `REST.AgentDispatcher`'s guards refuse
/// a *claim in the model's reply* -- after every tool has already run and audited -- so neither writer
/// above can see one, and the refusal used to live only on a response field the engine discards. A
/// distinct value rather than reusing `denied`: a security review asking "what was refused for lack of
/// privilege" and a demo review asking "what did we suppress in the narrative" are different
/// questions, and one disposition answering both makes neither query correct. `refused` was rejected
/// as the name because the `Disposition` paragraph above already spends it on a *tool-level* refusal
/// that audits as `executed`; `dropped` is the word this codebase already uses for the event, in the
/// guards' own method names and in the `droppedAction` / `droppedRemediation` / `droppedEvidence`
/// fields they set.
Property Disposition As %String(MAXLEN = 16) [ Required ];

/// Populated on `denied` and `dropped` rows: the reason the refusal happened.
///
/// On a `denied` row it names the rule and the missing privilege only. A refusal string crosses the
/// same boundary as any other tool output (`Tools.AuthPolicy` keeps it free of instance data), and
/// that discipline is worth preserving in storage too.
///
/// On a `dropped` row it is the guard's own `reason` token -- `not_whitelisted_host`,
/// `downstream_unreachable`, `stale_connectivity_claim`, `unsupported_config_absence_claim` -- taken
/// from the object the guard built rather than restated here, so the two cannot drift.
Property DenialReason As %String(MAXLEN = 512);

/// Milliseconds, as the runtime reports them.
///
/// MEASURED AS 0 FOR A 7 ms CALL. `%LogExecution` receives `duration` as an integer and
/// `ExecuteTool`'s own return carries `timing: 0.007099626` seconds for the same call, so anything
/// under a millisecond -- which every read tool here is -- audits as 0. Recorded rather than
/// smoothed: `mcp-tools.md` §5.5 lists duration as part of the record, and a reader comparing a
/// column of zeroes against that sentence should find the explanation here rather than assume the
/// clock is broken. Null on `denied` rows, which never ran.
Property DurationMs As %Integer;

/// Error text when the tool executed but returned a failure status; "" otherwise.
Property StatusText As %String(MAXLEN = 1024);

/// `live` | `mock`. Always `live` from this class -- IRIS is the live path by definition.
///
/// Present because `resolve-api.md` §8 makes `source` mandatory and makes `"mock"` mandatory for the
/// mock resolve. A row written here is a real tool call against the real production; the mock never
/// reaches IRIS and so never writes one. Stored rather than assumed so a UI reading the table does
/// not have to know that.
Property Source As %String(MAXLEN = 8) [ InitialExpression = "live" ];

Index ByRecordedAt On RecordedAt;

Index ByTool On Tool;

/// Write one row and return its public handle, or "" if the write failed.
///
/// TAKES THE ALREADY-EXTRACTED FIELDS rather than the raw hook payload, so that the two callers --
/// the audit policy and the authorization policy -- share the storage and nothing else. They are
/// recording different events and only one of them has a result.
///
/// A FAILED AUDIT WRITE MUST NOT BREAK THE CALL, which is a real decision and not an oversight.
/// `%LogExecution` runs after the tool has already executed and, for `SetPoolSize`, after the
/// production has already changed. Returning an error there would report a failure for a change that
/// did happen -- the worst of both. So this reports "" and the caller records that it could not
/// write; `resolve-api.md` §8 covers the consequence: `auditId: null`, and for an apply that is
/// `failed`/`verify` rather than a silent success.
/// `publishHandle` OFF MEANS "this row is not the call I just made". The process-private handle below
/// answers exactly one question -- what did *this* process last execute -- and `Tools.Governance.Invoke`
/// reads it unconditionally after `ExecuteTool`, including on the path where the tool's own audit write
/// failed. So a writer whose rows nobody correlates must not touch it, or a `SetPoolSize` whose audit
/// write failed would report a *guard refusal's* handle as its `auditId`. CSP reuses processes across
/// requests, so "an investigation and a resolve in the same process" is the ordinary case, not a
/// contrived one.
ClassMethod Record(actor As %String, tool As %String, arguments As %String, result As %String, disposition As %String, durationMs As %Integer = "", statusText As %String = "", denialReason As %String = "", publishHandle As %Boolean = 1) As %String
{
    set entry = ..%New()
    set entry.RecordedAt = ..NowUTC()
    set entry.Actor = actor
    set entry.Roles = $roles
    set entry.Tool = tool
    set entry.Arguments = arguments
    set entry.Result = result
    set entry.Disposition = disposition
    set entry.DurationMs = durationMs
    set entry.StatusText = statusText
    set entry.DenialReason = denialReason
    set sc = entry.%Save()
    if $$$ISERR(sc) {
        quit ""
    }
    set handle = ..#HANDLEPREFIX _ entry.%Id()
    // PROCESS-PRIVATE, and that is what makes it race-free rather than merely convenient. The tool
    // executes in the caller's own process, so the handle for "the call I just made" is unambiguous
    // here in a way that "the newest row for this actor and tool" is not -- two investigations
    // running concurrently would read each other's. Dev B's resolve endpoint needs `audit.auditId`
    // for the response and this is how it gets it without a query that can be wrong.
    if publishHandle {
        set ^||ProductionGuardian.Audit("last") = handle
    }
    quit handle
}

/// Write one row for a dispatcher guard that refused a claim in the model's reply. Returns the handle,
/// or "" if the write failed.
///
/// THE THIRD WRITER, and it lives here for the same reason the other two do: `Record` above takes
/// already-extracted fields precisely so that writers recording different events can share the
/// storage and nothing else. A guard refusal is a third kind of event -- see `Disposition`.
///
/// IT SWALLOWS ITS OWN FAILURE, and the four call sites therefore have no error handling. That is
/// deliberate and it is `Tools.AuthPolicy.Deny`'s argument applied to a different failure: a refusal
/// that could not be recorded is still a refusal, and a guard that let an audit-write error propagate
/// would turn "we suppressed a bad recommendation and could not log it" into a 500 for the whole
/// investigation -- restoring the bad recommendation's absence *and* losing the diagnosis. Wrapped
/// here rather than at each call site so a fifth guard cannot forget it, which is the same reasoning
/// that made `Deny()` the single deny path.
///
/// `refused` IS THE MODEL'S OWN CLAIM, verbatim, as it was removed. That is the point of the row --
/// #196's complaint was that "the AI recommended X and we suppressed it" was not reconstructable, and
/// `record` alone carries only our reason for the refusal, not the X. It stays inside the instance:
/// this table is never sent anywhere, unlike a tool return value.
ClassMethod RecordRefusal(guard As %String, host As %String, refused As %DynamicAbstractObject = "", record As %DynamicObject = "") As %String
{
    // Assigned, then quit AFTER the try. `quit <value>` inside a TRY is #1043 "QUIT argument not
    // allowed" -- inside a block, QUIT means leave the block, so it cannot also carry a return value.
    set handle = ""
    try {
        set arguments = {"host": (host)}
        set payload = { "refused": (refused), "record": (record) }
        set why = $select($isobject(record): record.%Get("reason", ""), 1: "")
        set handle = ..Record($username, guard, arguments.%ToJSON(), payload.%ToJSON(), "dropped", , , why, 0)
    } catch ex {
        set handle = ""
    }
    quit handle
}

/// The handle of the most recent row written by THIS process, or "" if none.
///
/// The integration seam for `resolve-api.md` §8's `auditId`: invoke the tool, then read this.
ClassMethod LastHandle() As %String
{
    quit $get(^||ProductionGuardian.Audit("last"), "")
}

/// One row as the `audit` object of `resolve-api.md` §8, or "" if the handle is unknown.
///
/// `role` is the recorded role SET rather than a single role -- see `Roles`. The contract instructs
/// consumers to render it as an opaque string and never compare it to a literal, which is exactly
/// what makes that honest.
ClassMethod Describe(handle As %String) As %DynamicObject
{
    set id = ..IdFor(handle)
    if id = "" {
        quit ""
    }
    set entry = ..%OpenId(id)
    if '$isobject(entry) {
        quit ""
    }
    quit {
        "auditId": (handle),
        "actor": (entry.Actor),
        "role": (entry.Roles),
        "tool": (entry.Tool),
        "recordedAt": (entry.RecordedAt),
        "source": (entry.Source),
        "disposition": (entry.Disposition),
        "denialReason": (entry.DenialReason)
    }
}

/// The row id inside a handle, or "" when the handle is not one of ours.
///
/// Validated rather than trusted: a handle arrives from an HTTP request, and `%OpenId` on arbitrary
/// text is a way to turn a typo into an unrelated row.
ClassMethod IdFor(handle As %String) As %String
{
    if $extract(handle, 1, $length(..#HANDLEPREFIX)) '= ..#HANDLEPREFIX {
        quit ""
    }
    set id = $extract(handle, $length(..#HANDLEPREFIX) + 1, *)
    quit $select(id = +id: id, 1: "")
}

/// The N most recent rows, newest first, as an array of `Describe` objects.
///
/// For the read-only audit view MVP 2 §5.4 gives Dev C. Bounded because an unbounded audit query is
/// a way to time out a dashboard once the table has a demo's worth of read calls in it.
ClassMethod Recent(limit As %Integer = 20) As %DynamicArray
{
    if (limit < 1) || (limit > 200) {
        set limit = 20
    }
    set out = []
    // Descending by ID rather than by RecordedAt: the id is monotonic per write and RecordedAt has
    // one-second resolution, so ordering by the timestamp would shuffle calls made in the same
    // second -- and every read tool here returns in under a millisecond.
    set sql = "SELECT TOP ? ID FROM ProductionGuardian_LabDemo_Audit.Entry ORDER BY ID DESC"
    set rs = ##class(%SQL.Statement).%ExecDirect(, sql, limit)
    if rs.%SQLCODE < 0 {
        quit out
    }
    while rs.%Next() {
        set desc = ..Describe(..#HANDLEPREFIX _ rs.%Get("ID"))
        if $isobject(desc) {
            do out.%Push(desc)
        }
    }
    quit out
}

/// Delete every row. For resetting between rehearsals, by the same logic as `Triggers.Reset()`.
///
/// DELIBERATELY AWKWARD TO REACH, and that is the whole design. Clearing an audit log is the one
/// operation an audit log exists to make impossible, so this is not on a tool class, is not
/// LLM-callable (`%AI.ToolMgr.FindTools` only discovers `%AI.Tool` subclasses -- verified), and is not
/// wired into `FirstBoot`. A boot that silently emptied the audit trail on every container restart
/// would be worse than no audit trail, because the table would still look authoritative.
///
/// It exists because a demo runs several times and `MVP 2 §3`'s last step shows the log -- eleven
/// rehearsal rows above the one the audience is meant to read is a worse story than a clean log. The
/// honest framing is that this is a DEMO FIXTURE, not an operations tool; a real deployment would
/// retain and archive instead, and nothing here should be read as a precedent for that.
ClassMethod Purge() As %Integer
{
    set n = ..AuditCountAll()
    do ..%KillExtent()
    kill ^||ProductionGuardian.Audit("last")
    write "audit log purged: ", n, " row", $select(n = 1: "", 1: "s"), " deleted", !
    quit n
}

/// Row count, or "" when the table cannot be read.
///
/// "" AND NOT 0, by the same rule as every other unmeasurable value in this area. Caught by running
/// as an unprivileged principal: `Guardian_Read` cannot SELECT this table, so the count came back as
/// a confident `0` for a table that had rows in it -- and a caller comparing counts before and after
/// a call concluded "no audit row was written" when one had been. That is #33 and #49 exactly (an
/// unmeasurable queue read as a small one; an absent metric deflating a baseline), reproduced in new
/// code by the person who wrote the comments warning about it.
ClassMethod AuditCountAll() As %Integer
{
    set rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT COUNT(*) AS N FROM ProductionGuardian_LabDemo_Audit.Entry")
    if rs.%SQLCODE < 0 {
        quit ""
    }
    quit $select(rs.%Next(): +rs.%Get("N"), 1: "")
}

/// ISO 8601 UTC. $ztimestamp is already UTC, unlike $horolog.
///
/// NO MANUAL "Z". `$zdatetime(..., 3, 7)` appends one itself -- appending a second produced
/// `2026-08-19T10:53:43ZZ`, which is not ISO 8601 and which `Date.parse` in the dashboard would
/// reject. Caught by reading a real row rather than by inspecting the format table.
ClassMethod NowUTC() As %String [ Private ]
{
    quit $zdatetime($ztimestamp, 3, 7)
}

Storage Default
{
<Data name="EntryDefaultData">
<Value name="1">
<Value>%%CLASSNAME</Value>
</Value>
<Value name="2">
<Value>RecordedAt</Value>
</Value>
<Value name="3">
<Value>Actor</Value>
</Value>
<Value name="4">
<Value>Roles</Value>
</Value>
<Value name="5">
<Value>Tool</Value>
</Value>
<Value name="6">
<Value>Arguments</Value>
</Value>
<Value name="7">
<Value>Result</Value>
</Value>
<Value name="8">
<Value>Disposition</Value>
</Value>
<Value name="9">
<Value>DenialReason</Value>
</Value>
<Value name="10">
<Value>DurationMs</Value>
</Value>
<Value name="11">
<Value>StatusText</Value>
</Value>
<Value name="12">
<Value>Source</Value>
</Value>
</Data>
<DataLocation>^PG.Audit.EntryD</DataLocation>
<DefaultData>EntryDefaultData</DefaultData>
<IdLocation>^PG.Audit.EntryD</IdLocation>
<IndexLocation>^PG.Audit.EntryI</IndexLocation>
<StreamLocation>^PG.Audit.EntryS</StreamLocation>
<Type>%Storage.Persistent</Type>
}

}
