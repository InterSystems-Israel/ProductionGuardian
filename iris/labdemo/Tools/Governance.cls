/// The one way to obtain a governed tool manager — because governance is per-instance, not global.
///
/// THE FINDING THIS CLASS EXISTS FOR, and it invalidates the obvious reading of
/// `contracts/mcp-tools.md` §5.6(b). "Register ours with `%AI.ToolMgr.SetAuthPolicy(policy)`" sounds
/// like a one-time instance configuration. It is not. Read from the shipped `SetAuditPolicy` body:
///
///     Set ..AuditPolicy = policy
///     If ..%token '= "" { Do $ZF(-6, $$$IrisLLMLibrary, $$$LLMTOOLMANAGERADDAUDIT, ..%token, policy) }
///
/// The policy is attached to the Rust tool manager identified by THIS OBJECT'S `%token`. It is
/// in-memory and per-`%AI.ToolMgr`. Measured: a freshly constructed manager reports
/// `AuthPolicy: <none>`, `AuditPolicy: <none>`, `DiscoveryPolicy: <none>`. So there is no persisted
/// setting, nothing a first-boot script can switch on once, and no default that denies.
///
/// WHY THAT IS A SAFETY PROBLEM RATHER THAN AN INCONVENIENCE. Every caller that builds its own
/// `%AI.ToolMgr` -- or its own `%AI.Agent`, which builds one -- gets an UNGOVERNED one: no
/// authorization check, no audit row, and `SetPoolSize` fully callable against the live production.
/// Forgetting two lines is not a visible mistake; it produces a manager that works perfectly and
/// silently mutates a production without a trace. `iris/setup/AIHub.cls` can create the roles and
/// resources at boot, but it cannot pre-register a policy onto a manager that does not exist yet.
///
/// So the mitigation is structural: there is one factory, it is the only documented way in, and it
/// cannot hand back an ungoverned manager. Dev B's AI Detective orchestration calls `Govern()` on
/// its agent rather than assembling policies itself -- that keeps the RBAC and audit story in
/// `iris/**` where root `CLAUDE.md` §3 puts it, and means a change to the policy model does not need
/// a matching change in the detection engine.
///
/// NOT A `%AI.Tool` SUBCLASS, deliberately. `%AI.ToolMgr.FindTools` filters on
/// `$$issubclassof(className, "%AI.Tool")` -- verified by reading it -- so nothing here can become a
/// seventh LLM-callable tool no matter how many public methods it grows.
Class ProductionGuardian.LabDemo.Tools.Governance
{

/// The read-tool class. Registered for every caller.
Parameter READTOOLS = "ProductionGuardian.LabDemo.Tools.Read";

/// The activity-history read tools.
///
/// A SECOND READ CLASS RATHER THAN MORE METHODS ON THE FIRST -- see `Tools.Activity`'s own class
/// comment for why. Both are gated by `PG_Read` and neither can mutate anything, so the read/write
/// split that `AuthPolicy` enforces is unaffected by which of the two a caller gets.
///
/// WHY `GovernAgent` CAN NEVERTHELESS REGISTER ONE WITHOUT THE OTHER, and this is a correctness
/// finding rather than a security one. The two families answer questions that SOUND identical and
/// are not: `Tools.Read.GetProcessingTime` reports the instant reading from
/// `/api/monitor/metrics`, and `Tools.Activity` reports the recorded history. Given both, a model
/// asked "which host has the highest average queueing time" reached for the current-state tool and
/// answered from it. Measured through the dashboard's own path:
///
///     GetProcessingTime("Cloud API")            -> avgQueueingTime 0.12   <- true, and instantaneous
///     CompareHostActivity("hours", 6)           -> avgQueueingTime 77.66  <- true, and the answer
///
/// Both readings are correct. The answer built on the first was wrong by three orders of magnitude,
/// and it carried `confidence: 1` with two evidence bullets reading `NOT MEASURED` -- so it was
/// confidently wrong AND self-contradicting, which is the worst available shape. On another run the
/// same question produced "all hosts have reported an average queueing time of null".
///
/// Prompt wording did not fix it and was tried first: the chat prompt already named each tool and
/// what it was for. That is the fifth time on this project that a behaviour something depended on
/// needed a deterministic guard rather than politer instruction, so the guard is the tool surface --
/// a model cannot prefer a tool that is not registered. The chat assistant gets `"activity"`;
/// AI Detective keeps `"all"`, because a root-cause investigation genuinely needs the instantaneous
/// status, queue depth and pool size, and it is given ONE finding to explain rather than an open
/// question about a time range.
Parameter ACTIVITYTOOLS = "ProductionGuardian.LabDemo.Tools.Activity";

/// The write-tool class, in its own class so the RBAC requirement does not leak onto the reads.
Parameter WRITETOOLS = "ProductionGuardian.LabDemo.Tools.Resolve";

/// A tool manager with both policies registered and both tool sets loaded.
///
/// POLICIES BEFORE TOOL SETS. Registration order is not documented, and the ordering that has been
/// exercised is this one -- a manager that registered tools first and policies second has never been
/// observed here, so it is not what this returns. Cheap to keep; expensive to guess wrong about.
///
/// `pIncludeWrite = 0` yields a manager that cannot reach `SetPoolSize` at all, for a caller that
/// only gathers evidence. That is defence in depth rather than the boundary: the boundary is
/// `AuthPolicy`, which refuses `SetPoolSize` without `PG_Resolve` even when the tool IS registered.
/// Both matter -- §5.3's demo needs the write tool VISIBLE and refused, which is the default.
ClassMethod ToolManager(pIncludeWrite As %Boolean = 1, Output pStatus As %Status) As %AI.ToolMgr
{
    set pStatus = $$$OK
    set mgr = ##class(%AI.ToolMgr).%New()
    if '$isobject(mgr) {
        set pStatus = $$$ERROR($$$GeneralError, "could not create a %AI.ToolMgr")
        quit $$$NULLOREF
    }

    set pStatus = ..Attach(mgr)
    if $$$ISERR(pStatus) {
        // NO UNGOVERNED MANAGER LEAVES THIS METHOD. Returning the manager with a warning would put a
        // fully functional, unaudited `SetPoolSize` in a caller's hands, and the caller most likely
        // to ignore a status is the one that most needs the policy.
        quit $$$NULLOREF
    }

    set pStatus = mgr.RegisterToolSet(..#READTOOLS)
    if $$$ISERR(pStatus) {
        quit $$$NULLOREF
    }
    set pStatus = mgr.RegisterToolSet(..#ACTIVITYTOOLS)
    if $$$ISERR(pStatus) {
        quit $$$NULLOREF
    }
    if pIncludeWrite {
        set pStatus = mgr.RegisterToolSet(..#WRITETOOLS)
        if $$$ISERR(pStatus) {
            quit $$$NULLOREF
        }
    }
    quit mgr
}

/// Attach our authorization and audit policies to an existing tool manager.
///
/// The seam for `%AI.Agent`: an agent builds its own manager and exposes it as `.ToolManager`, so
/// governing an agent means governing that object rather than replacing it.
ClassMethod Attach(pManager As %AI.ToolMgr) As %Status
{
    if '$isobject(pManager) {
        quit $$$ERROR($$$GeneralError, "no tool manager to govern")
    }
    set sc = pManager.SetAuthPolicy(##class(ProductionGuardian.LabDemo.Tools.AuthPolicy).%New())
    if $$$ISERR(sc) {
        quit sc
    }
    quit pManager.SetAuditPolicy(##class(ProductionGuardian.LabDemo.Tools.AuditPolicy).%New())
}

/// Govern an agent's tool manager and register the tool sets on it.
///
/// FOR DEV B's AI DETECTIVE. `%AI.Agent.UseToolSet(className)` delegates to
/// `..ToolManager.RegisterToolSet(className)`, so an agent that calls `UseToolSet` directly gets the
/// tools with NO policies attached -- which is exactly the ungoverned manager described in the class
/// comment, and it is the natural thing to write. Call this instead of `UseToolSet`.
///
/// Call it AFTER `%Init()`: `%Init` runs `%LoadToolSets()`, and an agent whose TOOLSETS parameter
/// names our classes will have registered them on an ungoverned manager by then. Attaching
/// afterwards still governs every subsequent execution, because the policy is consulted per call
/// rather than per registration.
///
/// `pToolSets` SELECTS WHICH FAMILIES ARE REGISTERED. See the parameter's own comment for the
/// measurement that made a narrower option necessary rather than merely available.
ClassMethod GovernAgent(pAgent As %AI.Agent, pIncludeWrite As %Boolean = 1, pToolSets As %String = "all") As %Status
{
    if '$isobject(pAgent) {
        quit $$$ERROR($$$GeneralError, "no agent to govern")
    }
    if '$isobject(pAgent.ToolManager) {
        // %Init() builds it. An agent handed over before initialisation cannot be governed, and
        // saying so is better than attaching to nothing and reporting success.
        quit $$$ERROR($$$GeneralError, "agent has no ToolManager yet -- call %Init() first")
    }
    // POLICIES FIRST, always, and before any early return below. An agent that got its tools
    // registered and its policies skipped is the ungoverned manager this class exists to prevent.
    set sc = ..Attach(pAgent.ToolManager)
    if $$$ISERR(sc) {
        quit sc
    }

    // A FIXED $case over three names, not a list the caller composes. An unrecognised value is an
    // ERROR rather than a default, because the two failure directions are not symmetric: defaulting
    // to "all" on a typo would silently widen what an agent can reach, which is the one mistake this
    // method must not make quietly.
    if '$listfind($listbuild("all", "activity", "current"), pToolSets) {
        quit $$$ERROR($$$GeneralError, "pToolSets must be 'all', 'activity' or 'current'")
    }

    if pToolSets '= "activity" {
        set sc = pAgent.ToolManager.RegisterToolSet(..#READTOOLS)
        if $$$ISERR(sc) {
            quit sc
        }
    }
    if pToolSets '= "current" {
        set sc = pAgent.ToolManager.RegisterToolSet(..#ACTIVITYTOOLS)
        if $$$ISERR(sc) {
            quit sc
        }
    }
    if pIncludeWrite {
        set sc = pAgent.ToolManager.RegisterToolSet(..#WRITETOOLS)
    }
    quit sc
}

/// Execute one tool through a governed manager and report the audit handle alongside the result.
///
/// THE CONVENIENCE THAT KEEPS THE TWO FACTS TOGETHER. `resolve-api.md` §8 requires `audit.auditId`
/// in every response, and the handle is only knowable after the call. A caller that builds a manager,
/// executes, and then forgets to read the handle produces a response claiming an audit entry it
/// cannot point at.
///
/// `outcome` here is the TRANSPORT outcome, not the tool's. A tool that refuses on its own bounds
/// returns `executed` with a refusal inside `result` -- because it ran. Only an authorization denial
/// yields `denied`, and that distinction is the whole subject of `AuthPolicy`'s class comment.
ClassMethod Invoke(pTool As %String, pArguments As %DynamicObject) As %DynamicObject
{
    set out = { "tool": (pTool), "outcome": null, "result": null, "auditId": null, "error": null }
    set mgr = ..ToolManager(1, .sc)
    if $$$ISERR(sc) {
        set out.outcome = "unavailable"
        set out.error = $system.Status.GetErrorText(sc)
        quit out
    }
    try {
        set res = mgr.ExecuteTool(pTool, pArguments)
        set out.outcome = "executed"
        set out.result = res
    } catch ex {
        // `<%AICore>ToolAccessDenied` arrives here, and ONLY as an exception -- there is no status
        // return for a denial. The audit row was written by AuthPolicy before the throw, so the
        // handle below is populated for a denial too, which is what makes §11.3's RBAC-denied
        // example possible.
        set out.outcome = "denied"
        set out.error = ex.DisplayString()
    }
    set handle = ##class(ProductionGuardian.LabDemo.Audit.Entry).LastHandle()
    set out.auditId = $select(handle '= "": handle, 1: "")
    quit out
}

}
