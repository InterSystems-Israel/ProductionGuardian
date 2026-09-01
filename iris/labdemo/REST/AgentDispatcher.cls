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

/// Error codes that mean "the downstream could not be reached". Same list the prompt names.
///
/// ONE COPY, referenced by both the guard below and (by name) the prompt above. Read from
/// `Tools.Read`'s catalogue when it was written; a code here that the catalogue does not classify
/// would simply never match, which fails closed.
Parameter CONNECTIVITYCODES = {$listbuild("#6059", "<Ens>ErrConnectionLost", "<Ens>ErrHTTPStatus", "<Ens>ErrFailureTimeout", "<Ens>ErrTCPTerminatedReadTimeoutExpired")};

/// Seconds after which a connectivity error describes history rather than the present.
///
/// DERIVED, NOT PICKED. A host failing to reach a closed target retries continuously -- Cloud API
/// against a closed port wrote 12 errors/minute, i.e. one every five seconds. The engine confirms a
/// finding after two polls at a 5s cadence, so anything it currently reports has been true for ~10s.
/// Two minutes of silence from a host that would be erroring every five seconds is therefore the
/// fault being OVER, not a gap in the data.
Parameter CONNECTIVITYMAXAGE = 120;

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

        do ..DropUnapplicableAction(parsed)
        // Host from the REQUEST's finding, never from the model's reply: a guard that trusted the
        // reply for the thing it is checking could be steered by the reply.
        if $isobject(body.%Get("finding")) {
            set findingHost = body.finding.%Get("host", "")
            // Order matters only in that both read the same evidence; they are mutually exclusive by
            // construction -- one fires when a connectivity error is recent, the other when it is
            // not, so they cannot both act on one reply.
            do ..DropPoolFixDuringOutage(parsed, findingHost)
            do ..DropStaleConnectivityClaim(parsed, findingHost)
            // Independent of the two above -- it reads the audit log, not the error log, and touches
            // only `evidence`, so it cannot interact with either.
            do ..DropUnsupportedConfigAbsence(parsed, findingHost)
            // AFTER the two drop guards, deliberately: there is no point sizing a recommendation
            // that is about to be removed, and running it first would emit a `resizedAction` for an
            // action the response does not contain.
            do ..RaiseUndersizedPool(parsed, body.%Get("snapshot"))
        }

        write parsed.%ToJSON()
        return $$$OK
    } catch ex {
        return ..Fail(500, "investigation failed: " _ ex.DisplayString())
    }
}

/// Drop a `recommendedAction` the write tool would refuse anyway. Private.
///
/// WHY A DETERMINISTIC GUARD RATHER THAN A BETTER PROMPT. The prompt already states the bound --
/// `set_pool_size` applies only to the whitelisted host, and never both fields -- and the model
/// obeys it **most** of the time. Measured over four consecutive live runs on the same finding,
/// same prompt, same model:
///
///   action=set_pool_size on EMR Source   manual=yes     <- both, and the action is unapplicable
///   action=set_pool_size on EMR Source   manual=yes
///   action=set_pool_size on EMR Source   manual=null    <- worst: the only fix offered cannot apply
///   action=null                          manual=yes     <- correct
///
/// One in four. **A prompt is a request, not a constraint**, and a demo cannot run on a 25% gate.
/// This is the same lesson as the ungoverned write in #92 from the other direction: there, a guard
/// was documented and absent; here, a guard was *asked for* and probabilistic. Neither is a guard.
///
/// So the bound is enforced where it is checkable. `Tools.Resolve` would refuse the call regardless
/// -- that boundary always held and is what makes this safe rather than merely tidy. What it could
/// not prevent is the **recommendation** reaching a UI that then renders an approve button for an
/// action guaranteed to fail. An operator clicking it learns nothing except that the product is
/// broken.
///
/// DROPPED, NOT REWRITTEN. This method never invents a `manualRemediation` to replace what it
/// removes, and never edits the narrative: `rootCause` and `evidence` are the model's and stay
/// verbatim. If the model offered only an unapplicable action, the honest result is a diagnosis
/// with no fix -- which §3.1 has always allowed and which is exactly what MVP 3's scenario is
/// about. Substituting our own words here would make the dispatcher a second author.
ClassMethod DropUnapplicableAction(parsed As %DynamicObject) [ Private ]
{
    if '$isobject(parsed.%Get("recommendedAction")) {
        quit
    }
    set action = parsed.recommendedAction.%Get("action")
    if '$isobject(action) {
        quit
    }

    // Read the bound from the tool, not from a literal -- the whole defect being fixed is a second
    // copy of a rule disagreeing with the rule.
    set host = action.%Get("host", "")
    if host = ##class(ProductionGuardian.LabDemo.Tools.Resolve).#ALLOWEDHOST {
        quit
    }

    set parsed.recommendedAction = ""
    // Built before the literal: a concatenation inside a %DynamicObject constructor is #1021
    // "Expected right bracket". Only a parenthesised single expression is accepted there.
    set detail = "set_pool_size applies only to '" _ ##class(ProductionGuardian.LabDemo.Tools.Resolve).#ALLOWEDHOST _ "'"
    // Recorded on the response rather than only in the log, because "the model recommended
    // something we dropped" is information the engine and a reviewer both want, and a silent
    // filter is indistinguishable from a model that behaved. The engine ignores unknown keys.
    set parsed.droppedAction = { "type": (action.%Get("type", "")), "host": (host),
        "reason": "not_whitelisted_host", "detail": (detail) }
}

/// Raise a pool recommendation that is at or below break-even. Private.
///
/// SEVENTH TIME ON THIS CLASS that a behaviour needed a guard rather than wording, and this one is
/// the most user-visible of them: the model reliably suggested `current + 1`, which on the demo
/// scenario is exactly the pool at which the queue stops growing and never shrinks. Measured live at
/// pool 2, 2 msg/sec, 1.01s per message -- queue 112, 112, 114 across 50 seconds. The operator
/// approves a change and watches nothing happen, which is worse than being told no fix exists.
///
/// RAISES, NEVER LOWERS, and never invents a recommendation where the model made none. If the model
/// asked for MORE than this floor it is left alone -- it may be reading something this arithmetic
/// does not, and the bound that actually protects the production is `Tools.Resolve`'s 2..8, not this.
///
/// THE FLOOR IS BREAK-EVEN PLUS ONE, not a full drain target. Break-even is
/// `messagesPerSec x avgProcessingTime`; one spare worker is the minimum that makes the backlog
/// shrink at all, and choosing how FAST to drain is a judgement about how much capacity to spend,
/// which is the model's to make. This guard only refuses the sizes that cannot work.
///
/// SILENT WHEN IT CANNOT COMPUTE. An absent or zero rate, or an unmeasurable processing time, leaves
/// the recommendation untouched -- a fabricated floor from missing inputs would be the
/// unmeasurable-is-not-zero defect (§2.1) in a new place.
ClassMethod RaiseUndersizedPool(parsed As %DynamicObject, snapshot As %DynamicObject) [ Private ]
{
    if '$isobject(parsed.%Get("recommendedAction")) {
        quit
    }
    set action = parsed.recommendedAction.%Get("action")
    if '$isobject(action) || (action.%Get("type", "") '= "set_pool_size") {
        quit
    }
    if '$isobject(snapshot) {
        quit
    }

    set rate = snapshot.%Get("messagesPerSec")
    set perMsg = snapshot.%Get("avgProcessingTime")
    // Both must be present AND positive. A zero rate means nothing is arriving, so there is no
    // break-even to compute; a zero service time means the work is free and no pool size is wrong.
    if (rate = "") || (perMsg = "") || (+rate <= 0) || (+perMsg <= 0) {
        quit
    }

    // Break-even, rounded UP: 2.02 workers means 3 to have any spare capacity at all, not 2.
    set breakEven = +rate * +perMsg
    set floor = $select(breakEven = (breakEven \ 1): breakEven \ 1, 1: (breakEven \ 1) + 1) + 1
    if floor > ##class(ProductionGuardian.LabDemo.Tools.Resolve).#MAXSIZE {
        set floor = ##class(ProductionGuardian.LabDemo.Tools.Resolve).#MAXSIZE
    }

    set asked = +action.%Get("size", 0)
    if asked >= floor {
        quit
    }

    do action.%Set("size", floor)
    // Recorded on the response, like the other guards: a silently corrected number is
    // indistinguishable from a model that got it right, and the arithmetic is exactly what a
    // presenter wants to be able to point at.
    set detail = "break-even is " _ $fnumber(breakEven, "", 2) _ " workers ("
        _ $fnumber(+rate, "", 2) _ " msg/sec x " _ $fnumber(+perMsg, "", 2) _ "s), so "
        _ asked _ " would hold the queue steady rather than drain it"
    set parsed.resizedAction = { "requested": (asked), "applied": (floor),
        "reason": "at_or_below_break_even", "detail": (detail) }
}

/// Drop a pool recommendation while the host is CURRENTLY failing to reach its target. Private.
///
/// THE MIRROR OF DropStaleConnectivityClaim, and it exists because adding recency to the prompt
/// regressed the case recency was not about. Measured on a live closed-port scenario with
/// `#6059 secondsAgo 3` -- unambiguously current -- across three runs:
///
///     action=null       <- correct
///     action=pool->2    <- wrong
///     action=pool->2    <- wrong
///
/// Two in three. Explaining `secondsAgo` gave the model a reason to discount errors and it applied
/// that reason to errors three seconds old. The previous wording held 3/3 on this case but caused the
/// stale-error defect; the new wording fixes stale and breaks current. **A prompt cannot hold both
/// ends** -- which is the fifth time on this class that a behaviour needed a guard rather than
/// wording, so both ends are now checked in code and the prompt only has to explain.
///
/// SAFE BY CONSTRUCTION ANYWAY, and that is worth being clear about: `set_pool_size` on a host in
/// this state would be *applied* successfully -- it is `Cloud API`, within 2..8 -- and would make
/// things worse, four workers failing to reach a closed port instead of one. So unlike
/// `DropUnapplicableAction`, where the tool refused the action regardless, here nothing downstream
/// would have stopped it. This is the guard, not a tidier presentation of one.
ClassMethod DropPoolFixDuringOutage(parsed As %DynamicObject, host As %String) [ Private ]
{
    if '$isobject(parsed.%Get("recommendedAction")) {
        quit
    }
    set action = parsed.recommendedAction.%Get("action")
    if '$isobject(action) {
        quit
    }
    // Only the pool action. If the catalogue ever gains an action that IS right during an outage,
    // this must not silently drop it.
    if action.%Get("type", "") '= "set_pool_size" {
        quit
    }

    set errors = ##class(ProductionGuardian.LabDemo.Tools.Read).GetRecentErrors(host, 60)
    set freshest = ..FreshestConnectivityAge(errors)
    // "" means no connectivity error in the window, or an unmeasurable age. Either way there is no
    // evidence of a current outage, so the recommendation stands -- this guard only ever fires on
    // POSITIVE evidence, never on absent evidence.
    if (freshest = "") || (freshest > ..#CONNECTIVITYMAXAGE) {
        quit
    }

    set parsed.recommendedAction = ""
    set detail = "a connectivity error occurred " _ freshest _ "s ago, so more workers would fail faster rather than drain the queue"
    set parsed.droppedAction = { "type": "set_pool_size", "host": (host),
        "reason": "downstream_unreachable", "detail": (detail) }
}

/// Age in seconds of the newest CONNECTIVITY error in a get_recent_errors reply, or "". Private.
///
/// Shared by both guards so they cannot disagree about which codes count or how age is read -- a
/// second copy of this loop is exactly the drift that produced the original defect.
ClassMethod FreshestConnectivityAge(errors As %DynamicObject) As %String [ Private ]
{
    set freshest = ""
    if '$isobject(errors) {
        quit ""
    }
    set list = errors.%Get("byCode")
    if '$isobject(list) {
        quit ""
    }
    set it = list.%GetIterator()
    while it.%GetNext(.i, .entry) {
        if '$listfind(..#CONNECTIVITYCODES, entry.%Get("errorCode", "")) {
            continue
        }
        set age = entry.%Get("secondsAgo")
        if age = "" {
            continue
        }
        if (freshest = "") || (age < freshest) {
            set freshest = age
        }
    }
    quit freshest
}

/// Strip a connectivity claim the evidence does not support. Private.
///
/// WHY A CHECK AND NOT JUST A BETTER PROMPT. Fifth time on this class: every behaviour this project
/// actually depends on has needed a deterministic guard, not politer wording. The prompt now explains
/// `secondsAgo` and states the 120-second threshold; this makes the threshold true.
///
/// THE NARROW CLAIM IT REFUTES. Only one: "the downstream is unreachable" asserted while the host has
/// logged no connectivity error recently. That is checkable from a number the tool now returns, so it
/// is checked. Everything else the model says stands -- this method has no opinion on a queue depth,
/// a pool size, or whether the recommendation is wise.
///
/// AND IT ONLY EVER REMOVES. It cannot add a `recommendedAction`, because "the model was wrong to
/// blame connectivity" does not establish that a pool increase is right -- the live numbers might
/// support neither. A diagnosis narrowed to "no fix named" is honest; one where the dispatcher
/// invented the fix would make it a second author, which is the same line `DropUnapplicableAction`
/// draws.
ClassMethod DropStaleConnectivityClaim(parsed As %DynamicObject, host As %String) [ Private ]
{
    set manual = parsed.%Get("manualRemediation")
    if '$isobject(manual) {
        quit
    }

    // Only a claim that NAMES connectivity. A manualRemediation about a missing directory or an
    // invalid setting is untouched, so this cannot silently eat MVP 3's scenario.
    set summary = $zconvert(manual.%Get("summary", ""), "L")
    set claimsConnectivity = 0
    for term = "unreachable", "connectivity", "downstream host", "cannot be reached", "connection" {
        if summary [ term {
            set claimsConnectivity = 1
        }
    }
    if 'claimsConnectivity {
        quit
    }

    // The evidence, read fresh rather than taken from the model's own account of it. A model that
    // misread the age would also misreport it.
    set errors = ##class(ProductionGuardian.LabDemo.Tools.Read).GetRecentErrors(host, 60)
    set newest = errors.%Get("newestSecondsAgo")

    // No errors at all in an hour, or an unmeasurable age -- either way there is nothing supporting
    // a connectivity claim. "" is the tool's unmeasurable marker and must not read as "just now".
    // The newest CONNECTIVITY code specifically, not the newest error of any kind: an
    // ErrProductionSettingInvalid a second ago says nothing about reachability. Shared helper, so
    // this guard and DropPoolFixDuringOutage cannot drift apart on the definition.
    set freshest = ..FreshestConnectivityAge(errors)
    set unsupported = (freshest = "") || (freshest > ..#CONNECTIVITYMAXAGE)

    if 'unsupported {
        quit
    }

    set parsed.manualRemediation = ""
    set detail = "no connectivity error on this host within " _ ..#CONNECTIVITYMAXAGE _ "s"
        _ $select(newest = "": " (none in the last hour)", 1: "; newest error of any kind " _ newest _ "s ago")
    // Recorded, not silent -- same reasoning as droppedAction. A reviewer needs to see that the
    // model claimed something and that we refused it, or this looks like a model that behaved.
    set parsed.droppedRemediation = { "reason": "stale_connectivity_claim", "detail": (detail) }
}

/// Strip an evidence entry that reports configuration the audit log cannot report. Private.
///
/// WHY A GUARD AND NOT A BETTER PROMPT. Sixth time on this class, and the most thoroughly measured:
/// `BuildGoal` forbids the claim in as many words, and two successive rewordings of that prohibition
/// -- one offering a safe sentence to say instead, one supplying the literal text to copy -- each
/// failed in a different direction on 20 live runs. The block above `BuildGoal`'s prohibition carries
/// both results. The short version is that "no change was found" and the only safe thing to say about
/// an empty list differ by one clause, so no wording separates them reliably.
///
/// THE NARROW CLAIM IT REFUTES, in the shape `DropStaleConnectivityClaim` set. Only an evidence entry
/// attributed to `GetRecentConfigChanges`, and only when a fresh read of that tool returns no change
/// at all for this host. Everything else the model says stands -- including a config entry that names
/// a real change, which is the whole point of the tool and which six runs on the armed missing-folder
/// scenario got right.
///
/// MATCHED ON `tool`, NOT ON PROSE, deliberately: the prohibition is about a claim of absence and any
/// phrasing of one is refused, so there is no phrase list to keep current. `endsWith` rather than
/// equality because the model sometimes reports the OpenAI-qualified name (`functions.` prefix,
/// measured once in 20) and an entry is no less wrong for being labelled that way.
///
/// IT CHECKS THE FINDING'S HOST, so an absence claim about a DIFFERENT host is out of its reach. The
/// tool takes a host argument and a model may call it for an upstream one; if the finding's host has a
/// change and an upstream host does not, this guard stays quiet and the upstream absence claim
/// survives. Left as a known limit rather than widened, because widening it means enumerating the
/// hosts the model might have asked about and dropping an entry on a guess about which one an entry
/// refers to -- prose recognition by another route. It matters more once #186 lands, which is the
/// change that makes per-upstream tool calls routine.
///
/// THE WINDOW IS THE TOOL'S OWN DEFAULT, seven days, and it is deliberately the WIDE end. The reply
/// does not say which window the model asked for, so this reads the widest one the tool offers by
/// default and drops only when even that comes back empty. A narrower window here would delete
/// entries legitimately describing an older change; this errs toward leaving the model's words alone,
/// which is the line `DropUnapplicableAction` draws.
///
/// AND IT ONLY EVER REMOVES. The caveat that replaces the claim goes in `droppedEvidence`, not into
/// `evidence` or `rootCause` -- same division as `droppedRemediation`. The dispatcher may refuse a
/// claim; it may not become a second author of the narrative.
///
/// `droppedEvidence` REACHES THE AUDIT TRAIL AND THIS INSTANCE'S OWN REPLY, NOT THE API. Same reach as
/// `droppedAction` and `droppedRemediation`, and worth stating rather than assuming: `investigate.ts`
/// builds its response field by field from a parsed subset, so an extra key here is ignored rather
/// than rejected -- no contract change, and no route to the dashboard either. Surfacing a refusal in
/// the UI is a findings-API question and belongs in that contract, not in this class.
ClassMethod DropUnsupportedConfigAbsence(parsed As %DynamicObject, host As %String) [ Private ]
{
    set evidence = parsed.%Get("evidence")
    if '$isobject(evidence) || (host = "") {
        quit
    }

    // The change list, read fresh rather than taken from the model's account of it -- the same reason
    // `DropStaleConnectivityClaim` re-reads the error log. A model that misread an empty list would
    // also misreport it.
    set changes = ##class(ProductionGuardian.LabDemo.Tools.ChangeLog).GetRecentConfigChanges(
        host, ##class(ProductionGuardian.LabDemo.Tools.ChangeLog).#DEFAULTWINDOW)
    set list = changes.%Get("changes")
    // A FAILED READ IS NOT AN EMPTY ONE. `changes` is null when the query or the namespace switch
    // failed, and dropping on that would delete the model's words on the strength of our own error.
    if '$isobject(list) || (list.%Size() > 0) {
        quit
    }

    set kept = []
    set dropped = 0
    for i = 0:1:evidence.%Size() - 1 {
        set entry = evidence.%Get(i)
        set tool = $select($isobject(entry): entry.%Get("tool", ""), 1: "")
        if $piece(tool, ".", $length(tool, ".")) = "GetRecentConfigChanges" {
            set dropped = dropped + 1
            continue
        }
        do kept.%Push(entry)
    }
    if 'dropped {
        quit
    }

    set parsed.evidence = kept
    // Recorded, not silent -- same reasoning as `droppedRemediation`. A reviewer needs to see that the
    // model claimed something and that we refused it, and an operator needs to know the audit log was
    // read, since the entry that used to say so is gone.
    set parsed.droppedEvidence = { "reason": "unsupported_config_absence_claim", "entries": (dropped),
        "detail": ("audit log read for " _ host _ ": no change attributable to this host in the last "
            _ ##class(ProductionGuardian.LabDemo.Tools.ChangeLog).#DEFAULTWINDOW _ "h. Rows take tens "
            _ "of seconds to become readable and a setting changed outside the Management Portal is "
            _ "not audited at all, so this cannot rule a change out.") }
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
        // A DENIAL IS 200 WITH `outcome: "refused"`. NOT 403, and the contract forbids it by name
        // (resolve-api.md §5.1: "`not_authorized` is `200`. It is not `403`, and it is not a
        // `500`.").
        //
        // I wrote 403 first, on the reasoning that a policy refusal is not a server fault
        // (@kskubach, #92 -- who noted they would have written 403 too). The reasoning is fine and
        // the conclusion breaks the demo: Dev C's client branches on `res.ok`, so every generic
        // fetch wrapper turns a non-2xx into a thrown error and a generic banner. The specific,
        // informative refusal becomes "something went wrong" in the layer above the one that knew
        // -- and MVP 2 §5.4's acceptance criterion is that the RBAC-denied state is VISIBLE. A
        // thrown error is not a visible state.
        //
        // SAME SHAPE AS THE AUTHORIZED PATH, which is the other half of §5.1: an authorized caller
        // and an unauthorized one differ only in `outcome`, `refusal`, and `before`/`after` being
        // null. Every other field is present, because Dev C mocks the denied state by changing two
        // fields rather than by handling a second shape.
        if governed.outcome = "denied" {
            // Describe() reads back the row the denial WROTE -- AuthPolicy writes it itself,
            // because the runtime throws before its own audit hook. So `audit.actor` names the
            // identity that was REFUSED, which §8 requires and which is the entire point of
            // auditing denials.
            set audit = ##class(ProductionGuardian.LabDemo.Audit.Entry).Describe(governed.auditId)
            // denialReason, not governed.error. The raw error is
            // `ERROR <%AICore>ToolAccessDenied: Tool access denied: Global policy denied: ERROR
            // #5001: ...` -- fine in a log, poor as a UI message. The audit row carries the clean
            // sentence, and it is free of instance data by construction, which matters because
            // this crosses the same boundary as any other output.
            set message = governed.error
            if $isobject(audit), audit.%Get("denialReason", "") '= "" {
                set message = audit.denialReason
            }
            set denial = {
                "outcome": "refused",
                "before": null,
                "after": null,
                "reversal": null,
                "refusal": {
                    "reason": "not_authorized",
                    "message": (message),
                    "checkedBy": "iris"
                },
                "failure": null,
                // §3 marks confirmation always present. `not_applicable` rather than null: nothing
                // was written, so there is no clearance to wait for, and a null would read as
                // "unknown" to a UI deciding whether to poll.
                "confirmation": { "status": "not_applicable" },
                "audit": (audit)
            }
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
        // The full §8 audit block, not just the handle -- same reason as the denial branch: §8
        // wants actor, role, tool, recordedAt and source, and Describe() returns them straight from
        // the row this call wrote. A handle alone makes a consumer perform a second lookup it has
        // no endpoint for.
        //
        // Falls back to the bare handle if the row cannot be read. A null audit on an applied write
        // is what tells the engine to treat the write as unverified rather than as a silent
        // success, so degrading to less information is right and inventing any is not.
        set audit = ##class(ProductionGuardian.LabDemo.Audit.Entry).Describe(governed.auditId)
        set payload.audit = $select($isobject(audit): audit, 1: {"auditId": (governed.auditId)})
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
    set p = p _ "recommendedAction ({action: {type, host, size}, currentValue}) or null, "
    set p = p _ "manualRemediation ({summary, steps, target}) or null. "
    // The bounds are READ FROM THE TOOL rather than restated, because a prompt that disagrees with
    // the guard produces a recommendation the guard then refuses -- which is what happened. The
    // wording was "host must be the host under investigation", and on the missing-folder scenario the
    // model dutifully recommended set_pool_size on `EMR Source`; a dry run came back
    // `not_whitelisted_host`. The safety boundary held perfectly and the recommendation was still
    // useless, so the UI would have offered an approve button for an action that cannot apply.
    //
    // Naming the one host it CAN change is also what makes manualRemediation reachable: told the
    // action is unavailable here, the model has somewhere else to put a real fix. Told only that the
    // action exists, it will reach for it.
    set p = p _ "The only action type you may recommend is set_pool_size, with size between "
        _ ##class(ProductionGuardian.LabDemo.Tools.Resolve).#MINSIZE _ " and "
        _ ##class(ProductionGuardian.LabDemo.Tools.Resolve).#MAXSIZE _ ". "
    set p = p _ "It can ONLY be applied to '" _ ##class(ProductionGuardian.LabDemo.Tools.Resolve).#ALLOWEDHOST
        _ "', and only when that host is the one under investigation. "
    set p = p _ "For any other host this action is unavailable and recommending it is an error -- "
    set p = p _ "it will be refused before it applies. "

    // WHEN A POOL INCREASE IS THE WRONG FIX, and this is the one piece of domain reasoning the
    // prompt has to carry, because the model gets it backwards with the evidence in front of it.
    // Observed on the closed-port scenario: get_recent_errors returned 246 unreachable-downstream
    // errors and 242 timeouts, the model NAMED them in its rootCause, and still recommended
    // set_pool_size 2. Four workers failing to reach a closed port is not four times the
    // throughput; it is four times the error rate.
    //
    // The distinction is a queue that is SLOW versus a queue that is FAILING, and it is decidable
    // from the byCode breakdown the tool already returns -- no new tool and no new evidence, just
    // the rule for reading what is there. Stated as a hard precondition rather than a caution,
    // since a caution is what the previous version effectively was.
    set p = p _ "A LARGER POOL ONLY HELPS A QUEUE THAT IS PROCESSING SLOWLY, never one that is "
    set p = p _ "failing. The connectivity codes are #6059, <Ens>ErrConnectionLost, "
    set p = p _ "<Ens>ErrHTTPStatus, <Ens>ErrFailureTimeout and "
    set p = p _ "<Ens>ErrTCPTerminatedReadTimeoutExpired. "

    // RECENCY, NOT PRESENCE, and this is the correction. The rule above said "if get_recent_errors
    // SHOWS connectivity failures", which is a statement about the window rather than about the
    // host -- so a pool bottleneck armed after a closed-port scenario was diagnosed as a
    // connectivity failure from 22-minute-old rows still inside the 60-minute window. Reported by
    // @Ari-Glikman. Measured, same host, same second:
    //
    //     sinceMinutes 15  ->  count 0
    //     sinceMinutes 60  ->  count 134, newest #6059 secondsAgo 1315
    //
    // The two directives were in direct conflict: BuildGoal tells the model to use a 60-minute
    // window (because the missing-folder scenario logs once and goes quiet), and this rule then read
    // anything in that window as current. `secondsAgo` is what resolves it -- the window can stay
    // wide enough to see a one-shot fault while the CONCLUSION keys on how recent the fault is.
    //
    // 120 seconds is the threshold and it is derived rather than picked: the engine confirms a
    // finding after `sustainedSamples` polls at a 5s cadence, so anything it is currently reporting
    // has been true for at least ~10s, and a failing host retries continuously -- Cloud API against
    // a closed port wrote 12 errors/minute. Two minutes of silence from a host that would be
    // erroring every five seconds is therefore not a gap in the data; it is the fault being over.
    set p = p _ "Each byCode entry carries secondsAgo, the age of that code's NEWEST occurrence, and "
    set p = p _ "the reply carries newestSecondsAgo for the host overall. USE THEM: a connectivity "
    set p = p _ "code with secondsAgo above 120 is a fault that has ENDED, and its errors describe "
    set p = p _ "the backlog's history rather than the present. Do not diagnose a current "
    set p = p _ "connectivity problem from it, and do not let it stop you recommending a pool "
    set p = p _ "increase that the live numbers support. "
    set p = p _ "Say so explicitly when you rely on this -- for example that the host errored 20 "
    set p = p _ "minutes ago, is no longer erroring, and is now simply outnumbered. "

    set p = p _ "So: connectivity codes with secondsAgo at or under 120 mean the queue is the "
    set p = p _ "SYMPTOM and the unreachable target is the cause -- more workers would only fail "
    set p = p _ "faster, recommendedAction MUST be null, and the fix belongs in manualRemediation, "
    set p = p _ "where the operator repoints the host or restores the downstream. "
    set p = p _ "Recommend set_pool_size when the host is processing successfully and simply cannot "
    set p = p _ "keep up: work accumulating behind a single worker, and no RECENT connectivity "
    set p = p _ "errors. A host with a queue, a normal processing time and only stale errors is the "
    set p = p _ "pool case, not the connectivity case. "

    // SIZE THE POOL, DO NOT DOUBLE IT. The model reliably suggested `current + 1` -- 1 -> 2 -- which
    // on the demo scenario is EXACTLY break-even and therefore fixes nothing. Measured live at pool 2
    // with 2 msg/sec arriving and 1.01s of work each: queue 112, 112, 114 over 50 seconds. It was not
    // draining, it was creeping up, and the approve button appeared to do nothing.
    //
    // The arithmetic is Little's law and every term is already in the snapshot the goal carries, so
    // this needs no new tool:
    //
    //     workers to keep up   = messagesPerSec x avgProcessingTime
    //     workers to also drain = enough spare capacity to clear `queued` in a few minutes
    //
    // Stated as an explicit calculation rather than "choose a sensible size", because a model asked
    // for a judgement produces a round number and a model asked for a computation shows its working
    // -- and the working is what a presenter needs to justify the number on screen.
    set p = p _ "SIZE THE POOL FROM THE NUMBERS, never by simply doubling or adding one. Work it out: "
    set p = p _ "workersToKeepUp = messagesPerSec x avgProcessingTime, which is the pool that merely "
    set p = p _ "stops the queue growing -- at that size the backlog NEVER clears. Then add capacity "
    set p = p _ "to drain what is already queued within a few minutes, and round UP. So a host taking "
    set p = p _ "1s per message with 2 arriving per second needs 2 just to break even, and 4 to break "
    set p = p _ "even and drain a backlog at about 2 per second. "
    set p = p _ "State the arithmetic in rootCause or in an evidence entry, including the break-even "
    set p = p _ "figure, so a reader can see why that size and not a smaller one. "
    set p = p _ "If the computed size exceeds the permitted maximum, recommend the maximum and say in "
    set p = p _ "rootCause that it will reduce the backlog rather than clear it. "

    // MVP 3. The two fields are described as MUTUALLY EXCLUSIVE and as differing in AUTHORITY rather
    // than in format, because that is the distinction the model has to get right: one is a change we
    // may make, the other is a change only a person may make. A prompt that described them as "a
    // structured fix or a written fix" would invite both, or the wrong one.
    // THE BEFORE-VALUE, AND THIS SIDE IS THE ONLY ONE THAT CAN SUPPLY IT (#178). The engine holds no
    // production configuration -- `investigate.ts` is passed null for it deliberately -- so with the
    // field unasked-for the approval label rendered `increase Cloud API pool ? -> 8`, a question mark
    // on the one string a human reads before authorising a write to a live production.
    //
    // ASKED FOR AS A SEPARATE KEY rather than inside `action`, because `action` travels VERBATIM to
    // `POST /api/resolve` (`investigation-api.md` §3.3) and the write tool's argument list is
    // `{host, size}`. An extra member inside it would either be forwarded to a tool that does not
    // take it or have to be stripped on the way -- so it sits beside the action, which is where the
    // contract already puts it.
    //
    // NOT A NEW READ: `get_pool_size` and `get_host_settings` are both mandatory in `BuildGoal`
    // already, so the value is in the transcript by the time this is answered. The model is told to
    // report what it read rather than to compute it, because the one thing worse than an absent
    // before-value is a plausible invented one next to an approve button.
    set p = p _ "recommendedAction.currentValue is the pool size the host is set to RIGHT NOW, as an "
    set p = p _ "integer, taken from what get_pool_size or get_host_settings returned for it. Do not "
    set p = p _ "calculate it and do not guess it: if you did not read it, use null. "
    set p = p _ "Use recommendedAction ONLY for a bounded action from that list. "
    set p = p _ "Use manualRemediation when the fix is real but outside what this system may do -- "
    set p = p _ "for example a directory that must be created on the host, or a setting an operator "
    set p = p _ "must repoint. Never both, and null for both if nothing can be recommended. "
    set p = p _ "manualRemediation.summary is one line naming the condition; steps is an ordered array "
    set p = p _ "of imperative strings, each independently actionable; target is "
    set p = p _ "{host, setting, currentValue} identifying the CONFIGURATION to change, or null if you "
    set p = p _ "cannot identify it. "

    // The one thing the model must not be allowed to infer. `appliedBy` is set by the dispatcher, not
    // read from the reply (investigate.ts does the same), so the prompt does not mention it -- a model
    // told the field exists could assert "system", and autonomous remediation is what root
    // CLAUDE.md §2.1 forbids outright. Naming a field only to forbid a value is weaker than not
    // offering it.
    set p = p _ "Never claim this system will apply a manual remediation itself; it will not. "

    // Says where the path comes from, because the alternative is the model quoting an error message
    // it should not have. get_recent_errors returns a catalogue `summary` and never log text, so the
    // OFFENDING VALUE has to come from get_host_settings -- and a model that does not know that will
    // either guess a path or ask for the log.
    set p = p _ "To name a specific path or setting value, read it with get_host_settings. "
    set p = p _ "get_recent_errors gives you the KIND of failure and never the message text. "

    // THE AUDIT TOOL, and this is the one paragraph in this prompt whose main job is a PROHIBITION.
    //
    // Named in PascalCase while the two names above are snake_case, and the inconsistency is
    // deliberate rather than an oversight. `%AI.ToolMgr` derives the tool name from the ClassMethod
    // name, so `GetRecentConfigChanges` is what `%Discover()` reports and what the model's schema
    // holds; the snake_case names above work because the model maps them onto the real names by
    // resemblance, which `REST.ChatDispatcher` records as "a coincidence to stop relying on" after it
    // silently failed there. Correcting the existing two is #155's job and a contract question; there
    // is no reason to add a third name that is known not to match.
    set p = p _ "GetRecentConfigChanges lists recent configuration changes to this production's hosts "
    set p = p _ "from the IRIS audit log: which setting changed on which host, from what value to what "
    set p = p _ "value, and when. Call it for any misconfiguration-shaped fault -- a path that does not "
    set p = p _ "exist, a port nothing answers on, a host that stopped consuming -- because a change "
    set p = p _ "made shortly before the finding is the likeliest cause and the audit log is the only "
    set p = p _ "place that says so. "

    // THE PROHIBITION, and it needs to be sharper here than in the chat prompt for a structural
    // reason: this agent HAS a field for prescribing a setting change. `manualRemediation.target` is
    // `{host, setting, currentValue}`, so "restore the previous value" is not merely something the
    // model could say -- it is a shape the reply schema invites. A recently-changed setting plus a
    // slot for a setting fix is a strong pull toward exactly the recommendation the operator did not
    // ask for.
    //
    // WHY THE OLD VALUE IS RETURNED AT ALL, given that. Withholding it would defeat the tool: "FilePath
    // changed" is not a diagnosis, and "changed from a directory that exists to one that does not" is.
    // So the data stays and the restraint lives here. `Tools.ChangeLog`'s class comment carries the
    // full argument.
    //
    // NO STRUCTURAL GUARD, and the reason is worth stating because this class does prefer one where it
    // exists (`DropUnapplicableAction`). A guard here would have to recognise "revert" in free prose or
    // match a step's text against a previous value, which is string-matching a recommendation's
    // MEANING -- it would pass "set FilePath back to /tmp/labdemo/hl7-in/" and fail on a paraphrase.
    // A field that cannot be checked is worse than a rule that is stated.
    set p = p _ "A recent change is EVIDENCE, never a recommendation. Report it in rootCause and "
    set p = p _ "evidence -- name the setting, when it changed, and what it changed from and to, and "
    set p = p _ "say it may be the cause. You must NOT recommend reverting it, must not put a revert in "
    set p = p _ "manualRemediation.steps, and must not describe the previous value as the correct one. "
    set p = p _ "Whoever made the change had a reason you cannot see, and the value they INTENDED may "
    set p = p _ "be neither the old one nor the new one -- a typo in a new path is not repaired by "
    set p = p _ "restoring the old path. State the fault and what changed; the operator decides. "
    // SILENCE IS NOT EVIDENCE. Same sentence as the chat prompt, for the same measured reasons: IRIS
    // purges audit data on a schedule, and a setting changed through `Ens.Config.Production.%Save()`
    // rather than the Management Portal is never audited at all.
    set p = p _ "An empty change list does not prove nothing was changed -- audit data is purged and "
    set p = p _ "some changes are not audited. Read retention and auditEnabled before saying a host's "
    set p = p _ "configuration was untouched, and never offer the absence of a change as a finding. "

    set p = p _ "Recommend nothing if no bounded action and no manual step fits."
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
    // NAMES THE TWO TOOLS THAT ANSWER *WHY*, because "use the tools" did not get them called
    // reliably and the finding itself never says why. Measured over three consecutive live runs on
    // the armed missing-folder scenario, only one produced a `manualRemediation` -- the other two
    // returned a diagnosis with no fix, having never read the error codes or the setting values.
    // Honest, and useless: the evidence was one tool call away.
    //
    // The failure is asymmetric, which is why this is worth a directive rather than a hope. A
    // status and a queue depth describe THAT something is wrong; only the error catalogue and the
    // configuration describe WHAT. A model that stops after the first two has enough to write a
    // fluent paragraph and nothing to recommend.
    set g = g _ " Before concluding you MUST call get_recent_errors and get_host_settings on this"
    set g = g _ " host: the first names the KIND of failure, the second gives the configured values"
    set g = g _ " a fix would change. A status and a queue depth alone cannot tell you why."

    // The window is stated because the default is 15 minutes and a host in Error logs once on
    // entering that state and then goes quiet. So the evidence EXPIRES while the condition
    // persists, and an empty byCode is then indistinguishable from a healthy host -- the same
    // unmeasurable-is-not-zero trap as §2.1, in the time dimension. 60 is the tool's ceiling.
    set g = g _ " Call get_recent_errors with sinceMinutes 60, not the default: a host logs its"
    set g = g _ " error once on entering Error and then stops, so a short window can come back"
    set g = g _ " empty while the fault is still present. An empty result does not mean healthy."
    // The other half of the same instruction, and it was missing. Telling the model to widen the
    // window without telling it the window contains history is what made a stale fault look current.
    set g = g _ " A WIDE WINDOW CONTAINS HISTORY. Check secondsAgo on each code before treating it as"
    set g = g _ " current: errors from 20 minutes ago on a host that is no longer erroring describe"
    set g = g _ " a fault that has ended, and the backlog draining behind it is a different problem."

    // A THIRD MANDATORY CALL, for the reason the two above are mandatory, and it is the same failure
    // arriving a third time. `SystemPrompt()` describes `GetRecentConfigChanges` and tells the model
    // to "call it for any misconfiguration-shaped fault" -- which is a description, and descriptions
    // do not get tools called. Measured on the armed missing-folder scenario, the fault this tool was
    // built for: `toolCalls: 2`, `GetRecentErrors` and `GetHostSettings`, and a rootCause that named
    // the non-existent path without mentioning that the path had been changed to it eight minutes
    // earlier. The tool was registered, the prompt paragraph was in the compiled routine, and the
    // model still had a satisfying answer after two calls and stopped.
    //
    // UNCONDITIONAL, rather than gated on the finding type. "Misconfiguration-shaped" is a judgement
    // about the DIAGNOSIS and the model cannot make it before gathering evidence, which is the
    // circularity that left the tool uncalled. The type does not partition the space either: a
    // `dead_host` is a missing folder or a genuinely stopped host, and a `queue_buildup` following a
    // PoolSize edit is exactly the case worth catching. The call is one bounded query returning at
    // most 25 rows of setting names and values, so the cost of always making it is far below the cost
    // of the one time it mattered and was skipped.
    //
    // WHETHER TO REPORT the change remains the model's judgement -- the user's ask was to raise it
    // "if it fits". This directive removes the discretion about LOOKING, not about concluding, and
    // says so, because a model told it must call a tool will otherwise find something to say about
    // the result.
    //
    // AND THE EMPTY CASE NOW POINTS AT THE RULE BELOW rather than asking for silence. "Say nothing
    // about it" was the wording here, which contradicted the attribution rule this method closes
    // with -- see the block below for the measurement that contradiction produced.
    set g = g _ " You MUST also call GetRecentConfigChanges before concluding. A setting changed"
    set g = g _ " shortly before a finding is the likeliest cause of it, and the audit log is the only"
    set g = g _ " place that records one. If a change is relevant, report it in rootCause and as an"
    set g = g _ " evidence entry naming the setting, the old and new values and when it changed; if"
    set g = g _ " nothing relevant comes back, record the call under the rule below and draw no"
    set g = g _ " conclusion from it -- the absence of a change is not a finding."

    // AND IT MUST NOT SAY THE OPPOSITE, WHICH IS WHAT IT DID (#171). "Say nothing about it" above was
    // already the instruction, and a live run on the armed missing-folder scenario returned
    // "No recent configuration changes were found that could also contribute to this issue" -- while
    // the FilePath edit sat in the audit log, 16 seconds old and not yet flushed. So the model both
    // ignored a prohibition phrased as silence AND turned an empty list into a positive claim.
    //
    // TELLING IT NOT TO IS NOT ENOUGH ON ITS OWN. A PROHIBITION NEEDS A SANCTIONED ALTERNATIVE or the
    // model invents one -- so the sentence it may say instead is now UNCONDITIONAL, and the two things
    // that made the previous version's alternative unreachable are why (#189).
    //
    // THAT VERSION GATED THE ALTERNATIVE ON A COMPARISON, and told the model to stay silent whenever
    // the comparison came out the other way: "compare retention.newest with when this finding began;
    // if retention.newest is older, say the audit log cannot answer yet ... otherwise stay silent
    // about configuration entirely." Both halves fail:
    //
    //   1. `retention.newest` CANNOT DECIDE THAT. `ChangeLog.Retention()` takes no host argument and
    //      counts every `ModifyConfiguration` row, including the ones `changes` drops -- lifecycle
    //      rows whose host parse comes back empty, settings off the allowlist (`suppressed`), and
    //      saves that moved nothing (`noOpSaves`). Measured here: a `compose restart` alone left
    //      `retention.newest` at 06:10:59 while the newest row in the UNFILTERED `changes` list was
    //      two days older. So the field routinely reads "the log has caught up" on the strength of a
    //      row the model is never shown, and the "cannot answer yet" branch is close to unreachable.
    //   2. WHICH LEAVES SILENCE AS THE ONLY BRANCH, and silence is not a sanctioned alternative here,
    //      because the attribution rule 20 lines below requires an evidence entry for every value
    //      read with a tool and this call was made compulsory 30 lines above. The goal therefore
    //      ordered the model to call the tool, to attribute what it read, and to say nothing about
    //      the only thing the call returned. An empty list leaves one utterance that satisfies the
    //      first two rules, and it is the one the first sentence forbids.
    //
    // MEASURED, 7 live `gpt-4o-mini` runs against one armed `queue_buildup` on `Cloud API` with an
    // empty change list for that host and `retention.newest` newer than the finding -- the "stay
    // silent" branch: the model called the tool in 2 runs and BOTH returned the forbidden claim as an
    // `mcp_tool` entry ("No changes in the configuration found in the last hour."). The other 5 runs
    // complied only by skipping a MUST. A rule with an 0/2 record on the path it governs is not a
    // rule, and #171's fix reappearing as #189 is what that costs.
    //
    // AND THE WORDING IS NOT LEFT TO THE PROMPT AT ALL. `DropUnsupportedConfigAbsence` enforces it,
    // for the reason every other guard on this class exists -- but the two prompt-only attempts are
    // recorded here because each failed differently and the second failure is what chose the guard.
    //
    //   ATTEMPT 1, asking for the SENSE of a safe sentence ("the one thing you may say is that the
    //   audit log shows no change attributable to this host in the window and cannot rule one out"):
    //   20 live runs called the tool 20/20 -- up from 2/7, so pointing the empty case at a rule
    //   instead of at silence is what makes the MUST hold, and that half is kept below. But 13 of the
    //   20 still returned the forbidden claim, and the other 7 were no better in kind: "No changes in
    //   the last hour.", "No configuration changes noted in the last hour.", and -- using the
    //   sanctioned wording and dropping the only clause that mattered -- "No changes found
    //   attributable to this host in the last hour." Any sentence about an empty list is a statement
    //   of absence; the caveat is what separates the safe one from the forbidden one, and the caveat
    //   is the part a model compresses away.
    //
    //   ATTEMPT 2, supplying the LITERAL text to copy: 20/20 called the tool and 20/20 reproduced the
    //   string exactly, with no forbidden claim anywhere -- and it was still wrong, because the model
    //   emitted it UNCONDITIONALLY. Six runs on the armed missing-folder scenario named the FilePath
    //   edit correctly and then appended "audit log inconclusive: no change attributable to this
    //   host..." next to it, 6/6. A verbatim string in a prompt gets reproduced; its guard clause does
    //   not.
    //
    // So the prompt keeps only what it demonstrably achieves -- the call happening, and no verdict in
    // `rootCause` (0 violations there across all 40 runs) -- and the claim itself is refused
    // downstream where the change list is a fact rather than a request.
    //
    // The lag measurement stays -- `contracts/mcp-tools.md` §3.12 carries it and made it a consumer
    // rule (a row written at 10:50:04 first became queryable at +36s, an HTTPPort edit in the same
    // session at +24s) -- but it is now a REASON the list may be empty rather than a test the model
    // has to run.
    set g = g _ " NEVER state that no configuration change was found, or that nothing was changed:"
    set g = g _ " an empty changes list is not evidence of anything. Audit rows take tens of seconds"
    set g = g _ " to become readable, retention counts rows this tool cannot show you, and a setting"
    set g = g _ " changed outside the Management Portal may never be audited at all. So an empty list"
    set g = g _ " supports no conclusion in either direction: give no verdict on configuration in"
    set g = g _ " rootCause and draw nothing from it."
    // `noOpSaves` exists because these rows used to reach the model AS changes, and it read
    // `HTTPPort changed from 52773 to 52773` as evidence for a fault nothing had reconfigured. The
    // tool now filters them, so this is the belt to that braces: a count is not a change, and a model
    // that sees a non-zero number next to an empty list must not narrate it as one.
    set g = g _ " noOpSaves counts saves where the value did not move. It is NOT a change: never"
    set g = g _ " report it as one, and never treat a non-zero count as evidence of anything."

    // ATTRIBUTION, RESTATED HERE, and it is a repair rather than a belt-and-braces addition. The
    // directive above cost the reply its evidence attribution: the first version closed with "report
    // it as evidence under the rules in your instructions", and across three consecutive live runs
    // EVERY entry came back `source` unset and `tool` null -- including the two tool reads that had
    // been correctly attributed as `mcp_tool` in the run immediately before the edit. `investigate.ts`
    // maps an unrecognised source to `"llm"`, so the reply stayed valid and silently claimed the model
    // had reasoned out values it had in fact read from governed tools.
    //
    // The mechanism is displacement: this block is the last thing the model reads and it is now the
    // longest instruction about evidence, so a vague pointer at "your instructions" competed with the
    // system prompt's concrete {label, detail, source, tool} schema and won. Deferring to another part
    // of the prompt is what failed; naming the requirement in the same breath as the mandatory calls
    // is what fixes it.
    set g = g _ " EVERY value you obtained from a tool must be attributed: that evidence entry takes"
    set g = g _ " source ""mcp_tool"" and tool set to the exact tool name you called. Use source"
    set g = g _ " ""snapshot"" only for the metrics given to you above. Never leave source or tool"
    set g = g _ " unset for something you read with a tool."
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
