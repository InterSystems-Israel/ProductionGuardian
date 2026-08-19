/// REST bridge from the detection engine to the AI Hub agent and the governed write tool.
///
/// The engine runs outside IRIS (ADR 0001) and the agent, tools, RBAC and audit all run inside it.
/// This class is the seam. Two routes, both POST:
///
///   /labdemo/investigate   finding + snapshot  -> structured investigation
///   /labdemo/resolve       action + dryRun     -> the governed set_pool_size result
///
/// WHY A DISPATCHER RATHER THAN THE MCP HTTP SERVICE. `%AI.MCP.Service` exposes tools over MCP for
/// an MCP *client* to consume. The engine is not one: it needs one agent turn and one governed
/// write, not tool discovery and a session protocol. A dispatcher is the smaller surface, and it
/// keeps the agent's system prompt and iteration budget in IRIS where the model configuration
/// already lives -- rather than making the engine assemble prompts, which is exactly the
/// "we orchestrate, we do not reason" line in services/detection-engine/CLAUDE.md §1.1.
///
/// VERIFIED LIVE, and one behaviour worth knowing before you read a transcript. On a real run:
///
///   model: gpt-4o-mini   toolCalls: 6   confidence: 0.9
///   rootCause: "The Cloud API host has a configured pool size of 1, which means it can only
///               process one message at a time..."
///   recommendedAction: {"action":{"type":"set_pool_size","host":"Cloud API","size":2}}
///
/// The agent diagnosed the bottleneck and chose a bounded action on its own -- nothing about pool
/// size is in the system prompt beyond the permitted action type and range.
///
/// THE AGENT'S TOOL READINGS ARE LIVE; THE SNAPSHOT IS FROM WHEN THE FINDING FIRED. Those can
/// disagree, and did: the snapshot said queued=198 while `get_queue_depth` returned 0, because the
/// production had been reset between detection and investigation. Neither is wrong -- they answer
/// different questions -- but it means an investigation can carry a bullet that contradicts the
/// finding it explains, and a reader assuming both were taken at the same instant will think one is
/// broken. `evidence[].source` is the distinction: `mcp_tool` is NOW, `snapshot` is THEN. Worth
/// stating because the transcript looks like a defect otherwise.
///
/// THIS CLASS ADDS NO AUTHORITY -- BUT IT MUST GO THROUGH `Tools.Governance` TO HAVE NONE.
///
/// This comment previously said the write was "gated by `%AI.ToolMgr.ExecuteTool`'s authorization
/// check and audited by the same runtime path". That was FALSE as written (@kskubach, #92).
/// `ExecuteTool` does consult a policy -- but policies attach per manager INSTANCE, in memory, and
/// a freshly constructed `%AI.ToolMgr` has none. It therefore asked a policy that permits
/// everything and audited into nothing, while this comment asserted the opposite.
///
/// An unimplemented guard is a gap. A guard DOCUMENTED as present is a trap, because a reviewer
/// reading this comment has no reason to check. This was the second kind, which is why the
/// correction is here in full rather than quietly dropped.
///
/// The correct statement is conditional. Every guard -- the single whitelisted host, the 2..8
/// bounds, the production checks, the PG_Resolve requirement, the audit row -- lives in the tool
/// and its policies, not here. What this file must not do is build its own manager; that is the
/// one way a bug here could widen what may be written. `Tools.Governance` is the only documented
/// way to obtain a manager that cannot.
Class ProductionGuardian.LabDemo.REST.AgentDispatcher Extends %CSP.REST
{

/// The ConfigStore entry naming the provider and model. The API key is resolved from the AI Hub
/// wallet by GetDetails(..., resolveSecrets=1) -- it is never in this class, in the engine, or in
/// the repo.
Parameter LLMCONFIG = "AI.LLM.pgdetective";

/// Iteration cap for an investigation. The agent needs several read-tool calls before concluding,
/// and an unbounded loop against a metered API is a cost incident rather than a better diagnosis.
Parameter MAXITERATIONS = 8;

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
<Route Url="/investigate" Method="POST" Call="Investigate"/>
<Route Url="/resolve" Method="POST" Call="Resolve"/>
</Routes>
}

/// Run one investigation and return the structured result the engine validates.
ClassMethod Investigate() As %Status
{
    set %response.ContentType = "application/json"
    try {
        set body = ##class(%DynamicObject).%FromJSON(%request.Content)

        set agent = ..BuildAgent(.sc)
        if $$$ISERR(sc) {
            return ..Fail(503, "agent unavailable: " _ $system.Status.GetErrorText(sc))
        }

        // The GOAL is built from the request's measured values, and it asks for JSON back. Asking
        // the model to produce the shape directly rather than parsing prose out of a narrative:
        // the engine validates strictly, and a model that returns text would fail that validation
        // every time -- which is the honest outcome but a useless one.
        set goal = ..BuildGoal(body)
        set session = agent.CreateSession()
        set r = agent.Run(session, goal, ..#MAXITERATIONS)
        if '$isobject(r) {
            return ..Fail(502, "agent returned no response")
        }

        // The model is asked for JSON but may wrap it in prose or a fenced block. Extract rather
        // than trust -- and if extraction fails, say so instead of forwarding something the engine
        // will reject with a less specific message.
        set parsed = ..ExtractJson(r.Content)
        if '$isobject(parsed) {
            return ..Fail(502, "agent reply was not JSON")
        }
        // Attach what only IRIS knows: which model answered and how many tools it actually called.
        // toolCalls is the honest check that evidence was gathered rather than guessed -- a
        // plausible narrative with zero tool calls is a model reasoning from its own priors.
        set parsed.model = agent.Model
        set stats = session.GetStats()
        set parsed.toolCalls = $select($isobject(stats): stats."total_tool_calls", 1: "")

        write parsed.%ToJSON()
        return $$$OK
    } catch ex {
        return ..Fail(500, "investigation failed: " _ ex.DisplayString())
    }
}

/// Invoke the governed write tool. Every guard is the tool's, not this class's.
ClassMethod Resolve() As %Status
{
    set %response.ContentType = "application/json"
    try {
        set body = ##class(%DynamicObject).%FromJSON(%request.Content)
        set host = body.%Get("host", "")
        set size = body.%Get("size", "")
        set dryRun = ''body.%Get("dryRun", 0)

        if (host = "") || (size = "") {
            return ..Fail(400, "host and size are required")
        }

        // THROUGH Tools.Governance, not through a bare %AI.ToolMgr. This line is the difference
        // between a governed write and an ungoverned one, and the earlier version of this method
        // was the latter while its class comment claimed otherwise (@kskubach, #92).
        //
        // WHY A BARE MANAGER IS UNSAFE. Policies are attached PER INSTANCE, in memory, to the Rust
        // manager behind that object's %token -- there is no persisted setting and no default that
        // denies. So ##class(%AI.ToolMgr).%New() reports `AuthPolicy: <none>` and executes
        // SetPoolSize against the live production with no PG_Resolve check and no audit row.
        // Reproduced on this branch before changing it:
        //
        //     AuthPolicy : <none>
        //     AuditPolicy: <none>
        //     ExecuteTool: SUCCEEDED -> {"outcome":"previewed","before":{"poolSize":1},...}
        //
        // It works perfectly, which is what makes it dangerous: forgetting to attach a policy is
        // not a visible mistake.
        //
        // Invoke() rather than ToolManager() + ExecuteTool, for the auditId. The handle is only
        // knowable after the call, and resolve-api.md §8 requires it in every response -- a caller
        // that executes and then forgets to read it publishes a response claiming an audit entry
        // it cannot point at.
        set args = {"host": (host), "size": (+size), "dryRun": (dryRun)}
        set governed = ##class(ProductionGuardian.LabDemo.Tools.Governance).Invoke("SetPoolSize", args)

        if '$isobject(governed) {
            return ..Fail(502, "write tool returned no result")
        }
        // A DENIAL IS 403, NOT 500. The policy refused a caller lacking PG_Resolve -- that is the
        // boundary working, and reporting it as a server fault would send someone to debug the
        // production instead of granting a role. The auditId is included because the denial IS
        // audited: AuthPolicy writes that row itself, since the runtime throws before its own
        // audit hook runs.
        if governed.outcome = "denied" {
            set %response.Status = 403
            set denial = {"outcome": "refused", "refusal": {"code": "not_authorized", "detail": (governed.error)}, "audit": {"auditId": (governed.auditId)}}
            write denial.%ToJSON()
            return $$$OK
        }
        if governed.outcome '= "executed" {
            return ..Fail(503, "write tool unavailable: " _ governed.%Get("error", "unknown"))
        }

        // ExecuteTool wraps the tool's return in {"timing":..., "value":...}. Unwrap here rather
        // than in the engine: the wrapper is an AI Hub implementation detail, and leaking it across
        // the HTTP boundary would make contracts/resolve-api.md's shape depend on it.
        set result = governed.result
        set payload = result
        if $isobject(result), $isobject(result.%Get("value")) {
            set payload = result.value
        }
        if '$isobject(payload) {
            return ..Fail(502, "write tool returned an unreadable result")
        }
        // The audit handle travels WITH the outcome, in one object. §8 requires it on every
        // response, and a null one on an applied write is what tells the engine to treat the write
        // as unverified rather than as a silent success.
        set payload.audit = {"auditId": (governed.auditId)}
        write payload.%ToJSON()
        return $$$OK
    } catch ex {
        return ..Fail(500, "resolve failed: " _ ex.DisplayString())
    }
}

/// Build and initialise the agent from ConfigStore. Private.
ClassMethod BuildAgent(Output pStatus As %Status) As %AI.Agent [ Private ]
{
    set pStatus = ##class(%ConfigStore.Configuration).GetDetails(..#LLMCONFIG, .details, 0, 1)
    if $$$ISERR(pStatus) {
        quit $$$NULLOREF
    }
    set provider = ##class(%AI.Provider).Create(details."model_provider", details)
    if '$isobject(provider) {
        set pStatus = $$$ERROR($$$GeneralError, "could not create provider")
        quit $$$NULLOREF
    }
    set agent = ##class(%AI.Agent).%New(provider)
    set agent.Model = details."model"
    set agent.SystemPrompt = ..SystemPrompt()

    // %Init() FIRST, then govern. That is the REVERSE of what this method used to do, and the
    // order is forced: %Init builds the agent's ToolManager, and GovernAgent attaches the policies
    // to that object. There is nothing to govern before %Init has run, and GovernAgent says so
    // rather than attaching to nothing and reporting success.
    set pStatus = agent.%Init()
    if $$$ISERR(pStatus) {
        quit $$$NULLOREF
    }

    // GovernAgent, NOT UseToolSet. UseToolSet delegates straight to
    // ..ToolManager.RegisterToolSet, so it registers tools on a manager with NO policies --
    // meaning every read the agent performed was unaudited, while MVP 2 §2.2 promises "every MCP
    // tool call, read AND write, is recorded". The natural call is the ungoverned one (#94).
    //
    // pIncludeWrite = 0: read tools only. The agent investigates; it does not act. Registering
    // Tools.Resolve here would let a model call the write tool inside its own reasoning loop with
    // no human between the recommendation and the production -- the single thing root CLAUDE.md
    // §2.1 forbids. This is defence in depth rather than the boundary: AuthPolicy refuses
    // SetPoolSize without PG_Resolve even when the tool IS registered. Both hold.
    set pStatus = ##class(ProductionGuardian.LabDemo.Tools.Governance).GovernAgent(agent, 0)
    if $$$ISERR(pStatus) {
        quit $$$NULLOREF
    }
    quit agent
}

/// The agent's role and output contract. Private.
ClassMethod SystemPrompt() As %String [ Private ]
{
    set p = "You diagnose InterSystems IRIS interoperability production problems. "
    set p = p _ "Use the provided tools to gather evidence BEFORE concluding; do not guess values you can look up. "
    set p = p _ "You are given metrics and configuration only. You never see message content and must not speculate about it. "
    set p = p _ "Reply with ONLY a JSON object, no prose around it, with these keys: "
    set p = p _ "rootCause (string, 2-3 sentences explaining WHY in operator language), "
    set p = p _ "evidence (array of {label, detail, source, tool} where source is ""mcp_tool"" for a value you read with a tool "
    set p = p _ "or ""snapshot"" for one given to you, and tool is the tool name or null), "
    set p = p _ "confidence (number 0-1, your own judgement), "
    set p = p _ "recommendedAction ({action: {type, host, size}}) or null. "
    set p = p _ "The only action type you may recommend is set_pool_size, with size between 2 and 8, "
    set p = p _ "and host must be the host under investigation. Recommend nothing if no bounded action fits."
    quit p
}

/// Turn the request into a goal string. Private.
ClassMethod BuildGoal(body As %DynamicObject) As %String [ Private ]
{
    set f = body.finding, s = body.snapshot
    set g = "A monitoring rule fired on this production. Diagnose it."
    if $isobject(f) {
        set g = g _ " Finding: type=" _ f.%Get("type", "?") _ ", host=" _ f.%Get("host", "?")
        set g = g _ ", message=" _ f.%Get("message", "?")
    }
    if $isobject(s) {
        // Passed as JSON rather than re-narrated: the engine already built this as an allowlist of
        // metric and configuration fields, and re-describing it here would be a second place where
        // a field could be added without review.
        set g = g _ " Current metrics: " _ s.%ToJSON()
    }
    if $isobject(body.trend) {
        set g = g _ " Trend: " _ body.trend.%ToJSON()
    }
    set g = g _ " Use the tools to confirm the configuration before concluding."
    quit g
}

/// Pull a JSON object out of a model reply that may be fenced or padded. Private.
ClassMethod ExtractJson(text As %String) As %DynamicObject [ Private ]
{
    if text = "" {
        quit $$$NULLOREF
    }
    // Take the outermost braces rather than stripping fences by pattern: models wrap JSON in
    // ```json, in plain ```, in "Here is the JSON:", or in nothing, and a fence-specific rule
    // fails on the next variation. The first { to the last } is stable across all of them.
    set start = $find(text, "{") - 1
    if start < 1 {
        quit $$$NULLOREF
    }
    set end = $length(text)
    while (end > start) && ($extract(text, end) '= "}") {
        set end = end - 1
    }
    if end <= start {
        quit $$$NULLOREF
    }
    set candidate = $extract(text, start, end)
    try {
        set obj = ##class(%DynamicObject).%FromJSON(candidate)
    } catch {
        return $$$NULLOREF
    }
    quit obj
}

/// Emit a JSON error with a status code. Private.
ClassMethod Fail(code As %Integer, message As %String) As %Status [ Private ]
{
    set %response.Status = code
    write {"error": (message)}.%ToJSON()
    quit $$$OK
}

}
