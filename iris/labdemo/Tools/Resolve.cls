/// The single governed MCP WRITE tool — Smart Resolve's action.
///
/// Implements `set_pool_size` from `contracts/mcp-tools.md` and the guards from
/// `contracts/resolve-api.md`. Those contracts are authoritative; where this class and they
/// disagree, they are right and this is a bug.
///
/// SEPARATE CLASS FROM THE READ TOOLS, and that separation is the security boundary rather than
/// tidiness. `%AI.Tool` parameters and any per-class policy apply to the whole class, so the write
/// tool needs its own in order to carry a privileged RBAC requirement the read tools must not
/// inherit. One class holding both would mean either the reads are over-privileged or the write is
/// under-privileged, and there is no third option.
///
/// EXACTLY ONE PUBLIC CLASSMETHOD. Every public method here becomes an LLM-callable tool
/// (verified in `%AI.Tool.Generator`), so a second one is a second way to mutate a live
/// production. Helpers are Private. If this class ever discovers two tools, that is a defect.
///
/// AUTHORIZATION AND AUDIT ARE NOT IMPLEMENTED HERE, deliberately, and this is worth stating
/// because their absence looks like an omission. `%AI.ToolMgr.ExecuteTool` performs both around
/// every invocation -- read from its shipped body:
///
///     // 1. Checks AuthorizationPolicy.can_execute()
///     // 2. Executes the tool via provider
///     // 3. Calls AuditPolicy.log_execution()
///
/// So a tool cannot forget to check permissions, cannot bypass the check by implementing %Invoke
/// carelessly, and cannot execute before being authorised -- the ordering means a denied call
/// cannot have partially mutated anything. Re-implementing the check here would add a second
/// place to keep in agreement and a reader unsure which one is authoritative.
///
/// UNVERIFIED, and flagged rather than assumed: whether the DEFAULT policy actually denies.
/// `%AI.Policy.ConsoleAuth` and `%AI.Policy.ConsoleAudit` exist out of the box, and "enforced by
/// the runtime" is only a safety property if the configured policy refuses. Registering our own
/// Authorization policy and OBSERVING a denial is an acceptance criterion in
/// `contracts/resolve-api.md` §9.4, not something to infer from the classes existing.
Class ProductionGuardian.LabDemo.Tools.Resolve Extends %AI.Tool
{

/// The production this tool may act on. The ONLY production it may act on.
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// The only host whose pool size this tool may change.
///
/// An allow-list of one, not a blocklist. A blocklist has to anticipate every host that must not
/// be touched, including ones added after this was written; an allow-list fails closed when the
/// production grows. MVP 2 needs exactly one action on exactly one host, so the narrowest
/// possible list is also the correct one.
Parameter ALLOWEDHOST = "Cloud API";

/// Bounds on the requested pool size, from `contracts/resolve-api.md` §3.
///
/// The lower bound is 2, not 1, and that is not an off-by-one. 1 is the SHIPPED value, so
/// "set the pool to 1" is a no-op dressed as a fix -- it would report success, change nothing,
/// and leave an operator believing the problem was addressed. Reversal to 1 is Reset()'s job,
/// through a path that is not LLM-callable.
Parameter MINSIZE = 2;

Parameter MAXSIZE = 8;

/// Change the worker pool size of an interoperability host, after human approval.
///
/// This is the only tool that modifies the live production. It is bounded to one host and a
/// small size range, it reports the value it replaced so the change can be reversed, and it
/// refuses rather than guessing when anything is out of range. Set dryRun to true to preview
/// the change without applying it.
ClassMethod SetPoolSize(host As %String, size As %Integer, dryRun As %Boolean = 0) As %DynamicObject
{
    set out = {
        "tool": "set_pool_size",
        "host": (host),
        "requestedSize": (size),
        "mode": ($select(dryRun: "dry_run", 1: "apply")),
        "outcome": null,
        "before": null,
        "after": null,
        "reversal": null,
        "refusal": null
    }

    // EVERY GUARD BEFORE ANY WRITE, and each refusal names itself. A generic failure would leave
    // the caller -- and the human reading the dashboard -- unable to tell "you asked for something
    // forbidden" from "the production is broken", which are opposite situations.
    if host '= ..#ALLOWEDHOST {
        quit ..Refuse(out, "not_whitelisted_host",
            "this tool may only change '" _ ..#ALLOWEDHOST _ "'")
    }
    if (size '= (size \ 1)) || (size < ..#MINSIZE) || (size > ..#MAXSIZE) {
        quit ..Refuse(out, "out_of_bounds",
            "size must be an integer between " _ ..#MINSIZE _ " and " _ ..#MAXSIZE)
    }

    do ##class(Ens.Director).GetProductionStatus(.running, .state)
    if running '= ..#PRODUCTION {
        quit ..Refuse(out, "wrong_production",
            "'" _ running _ "' is running, not " _ ..#PRODUCTION)
    }
    // STRICTER THAN Triggers.CheckProduction(), which only WARNS on a stopped production because a
    // config edit there is confusing rather than wrong. For a governed write it is wrong: the
    // caller is told the pool changed, the audit records that it changed, and the running system
    // is unaffected until someone restarts. Called out so nobody "aligns" the two later.
    if state '= 1 {
        quit ..Refuse(out, "production_not_running",
            "production state is " _ state _ ", not Running")
    }

    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$isobject(def) {
        quit ..Refuse(out, "wrong_production", "cannot open " _ ..#PRODUCTION)
    }
    set item = $$$NULLOREF
    for i = 1:1:def.Items.Count() {
        set candidate = def.Items.GetAt(i)
        if candidate.Name = host {
            set item = candidate
            quit
        }
    }
    if '$isobject(item) {
        quit ..Refuse(out, "host_not_in_production",
            host _ " is whitelisted but not present in the running production")
    }

    // Capture the ACTUAL prior value, never a literal. #66 established what the alternative costs:
    // ErrorRate() restored a hardcoded port and destroyed a deployment that legitimately used a
    // different one. The same mistake with a pool size would silently discard whatever an operator
    // had tuned.
    set before = +item.PoolSize
    set out.before = { "poolSize": (before) }
    // `capturedFrom` IS "live", NOT "live production". `resolve-api.md` §4 states it is always
    // `"live"`, and this emitted `"live production"` until 2026-08-20 -- a value drift found by
    // diffing the two documents field by field for #110, after reading the line several times
    // without seeing it. An `enum: ["live", "mock"]` in a schema catches this at validation time and
    // review demonstrably does not, which is the argument that CHANGELOG entry is making.
    //
    // THE SHAPE IS STILL WRONG AND IS DELIBERATELY LEFT ALONE. The contract specifies
    // `{"action": {"type", "host", "size"}, "capturedFrom", "automatic"}` and this is flat with no
    // `automatic`. Fixing that means deciding what `reversal` is FOR -- #100 is open on exactly
    // that, because the contract hands the caller a body with `size: 1` and then refuses it against
    // its own `2..8` bound. Changing the shape before that decision would be guessing at an
    // interface, so only the value that is wrong under every option is corrected here.
    set out.reversal = { "host": (host), "size": (before), "capturedFrom": "live" }

    if before = size {
        // Not an error and not a refusal: the requested state is already true. A demo will hit
        // this by clicking Approve twice, and reporting failure there would look like the tool
        // broke when it is the one case where doing nothing is correct.
        set out.outcome = "no_change"
        set out.after = { "poolSize": (before) }
        quit out
    }

    if dryRun {
        // Guaranteed not to mutate, structurally: this returns before the write. The `after` value
        // is what WOULD result, and it is inside a response whose mode says dry_run -- the caller
        // cannot mistake a preview for an application.
        set out.outcome = "previewed"
        set out.after = { "poolSize": (size) }
        quit out
    }

    set item.PoolSize = size
    set sc = def.%Save()
    if $$$ISERR(sc) {
        set out.outcome = "failed"
        set out.failure = { "stage": "save", "message": ($system.Status.GetErrorText(sc)) }
        quit out
    }
    // UpdateProduction is what makes the change take effect in the RUNNING production. Without it
    // the save persists and the workers are unchanged -- success reported, nothing different, which
    // is the silent no-op this whole class exists to avoid.
    set sc = ##class(Ens.Director).UpdateProduction(10)
    if $$$ISERR(sc) {
        set out.outcome = "failed"
        set out.failure = {
            "stage": "update",
            "message": ($system.Status.GetErrorText(sc)),
            "liveStateVerified": false
        }
        quit out
    }

    // Re-read rather than echoing the request. Reporting the value we ASKED for would make a
    // partial failure indistinguishable from success, and this is the one field a human uses to
    // confirm the fix landed.
    set out.after = { "poolSize": (..ReadPoolSize(host)) }
    set out.outcome = "applied"
    quit out
}

/// Attach a named refusal and return. Private.
ClassMethod Refuse(out As %DynamicObject, code As %String, detail As %String) As %DynamicObject [ Private ]
{
    set out.outcome = "refused"
    // The reason is surfaced because it is what lets a UI explain WHY Approve is disabled, but it
    // names only the rule and the bound -- never instance data, since a refusal string crosses the
    // same boundary to the model as any other tool output.
    // §5 FIELD NAMES: reason, message, checkedBy. This emitted { code, detail } until
    // 2026-08-19 -- a drift from the ratified contract in the object Dev C renders when Approve is
    // refused, so their banner read `undefined` (@kskubach, #92). The parameter names are kept as
    // code/detail because that is what every call site passes; only the wire shape was wrong.
    //
    // checkedBy is "iris" unconditionally, and it is a fact rather than a label: this method only
    // runs inside the tool, so a refusal carrying it WAS decided by the production's own guard and
    // not by the engine's convenience validation.
    set out.refusal = { "reason": (code), "message": (detail), "checkedBy": "iris" }
    // §5 carries the range on an out_of_bounds refusal so a UI can state it without hardcoding a
    // copy -- which is the #84 stale-number pattern waiting to happen.
    if code = "out_of_bounds" {
        set out.refusal.bounds = { "min": (..#MINSIZE), "max": (..#MAXSIZE) }
    }
    quit out
}

/// Current pool size for a host, or "" when unreadable. Private.
ClassMethod ReadPoolSize(host As %String) As %String [ Private ]
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$isobject(def) {
        quit ""
    }
    set result = ""
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name = host {
            set result = +item.PoolSize
            quit
        }
    }
    quit result
}

}
