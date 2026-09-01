/// MCP read tool over the detection engine's CURRENT findings — what Production Guardian is
/// reporting about this production right now.
///
/// Implements the one tool in `contracts/mcp-tools.md` §3.13. That contract is authoritative; where
/// this class and it disagree, the contract is right and this is a bug.
///
/// WHY THIS EXISTS. The chat assistant could describe what the production DID — throughput, latency,
/// what the event log said — and could not see what Production Guardian was SAYING about it. So
/// "are there any issues right now?" was answered from an activity table, and a live
/// `queue_buildup` on `Cloud API` went unmentioned while the dashboard showed it in red two panels
/// away. The user's report is the whole specification: the chat "only checks the tables but not the
/// findings", and it should relate to them.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE FINDINGS ARE SUPPLIED WITH THE QUESTION, NOT FETCHED
///
/// This is the one tool in the family that does not read IRIS. Findings are computed by the detection
/// engine on `:3002`, outside this instance, so there are only two ways for the agent to see them:
/// IRIS calls the engine back, or the engine sends them with the question it is already sending.
///
/// THE SECOND, and for three reasons rather than convenience:
///
///   1. The engine already holds the snapshot in the process handling the request — `index.ts` calls
///      `engine.snapshot()` one line above the chat call. Fetching it back over the network would be
///      a round trip to obtain data we are holding.
///   2. It needs no engine URL inside the IRIS container. A new environment variable is exactly the
///      thing `iris/CLAUDE.md` records going missing on three separate cold boots — and it would fail
///      by returning "no findings", which reads as a healthy production.
///   3. A findings read has no meaning outside the request that asked. `GetQueueDepth` answers the
///      same question whenever it is called; "what is wrong right now" is a fact about an instant,
///      and pinning it to the question's instant is more correct than re-reading it mid-turn and
///      answering about two different moments in one reply.
///
/// A TOOL RATHER THAN PROMPT CONTEXT, which was the other option and is a closer call. Injecting the
/// findings into the goal text would have been fewer moving parts. It loses three things:
///
///   - `evidence[].tool` in the reply contract has nothing to name, so a finding-derived claim cannot
///     be attributed the way every other claim in a chat answer is.
///   - There is no audit row. "Every tool call is audited, read and write" is a shipped guarantee
///     (root `CLAUDE.md` §2.1), and a second unlabelled channel of truth into the model quietly
///     exempts itself from it.
///   - Every turn pays the tokens, including "what was throughput yesterday", which does not want
///     them.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE HANDOFF, AND WHY IT IS KILLED BEFORE IT IS SET
///
/// `REST.ChatDispatcher.Ask()` writes the supplied array to `^||PGGuardian("chat","findings")` and
/// this tool reads it. A process-private global, because the agent loop runs in the same job as the
/// REST request — `agent.Run()` is a synchronous call inside `Ask()` — and per-request state must not
/// be visible to a concurrent request.
///
/// **CSP PROCESSES ARE POOLED AND REUSED**, so a process-private global outlives the request that set
/// it. A question that supplied no findings would otherwise read the PREVIOUS question's snapshot and
/// answer confidently about a production state minutes stale. `Ask()` therefore kills the node
/// unconditionally on entry, before it decides whether to set it. That ordering is the whole
/// correctness argument: killing on the way out would be skipped by any exception path.
///
/// `supplied: false` IS A FIRST-CLASS ANSWER, not an error. It is what the tool returns when the
/// caller sent no snapshot — an older dashboard build, or a hand-rolled POST — and the tool says so
/// rather than returning an empty list, because an empty list of findings means "this production is
/// healthy" and that is the one thing it must never say by accident. Same nullability rule as the
/// rest of the family (`contracts/mcp-tools.md` §2.1), applied to a list instead of a number.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE DATA BOUNDARY
///
/// Every field of a `Finding` is metrics or classification: `host`, `type`, `severity`,
/// `currentValue`, `baselineValue`, `detectedAt`, and `message` — which is composed by the detection
/// engine from metric values and never contains log or message text. `contracts/healthscan.d.ts`
/// §Finding is the authority for that list, and this tool republishes it rather than widening it: an
/// unrecognised key in the supplied array is DROPPED, so a future engine field cannot reach the LLM
/// by arriving in a payload.
///
/// EVERY PUBLIC CLASSMETHOD HERE BECOMES AN LLM-CALLABLE TOOL, verified in `%AI.Tool.Generator`.
/// One public method, one tool; the two helpers are `[ Private ]`.
Class ProductionGuardian.LabDemo.Tools.Findings Extends %AI.Tool
{

/// The process-private node `REST.ChatDispatcher` writes and this tool reads. Named once, here,
/// because a mistyped subscript on either side would present as "no findings supplied" — an answer
/// this tool gives legitimately, so the failure would be indistinguishable from the normal case.
Parameter HANDOFF = "findings";

/// Findings republished at most.
///
/// A cap the ENGINE also applies before sending (see `detect/chat.ts`), so this is the second of two
/// and deliberately so: the engine's cap keeps the request small and this one keeps a hand-rolled
/// POST from filling the model's context.
///
/// NEITHER CAP MAY BE SILENT, which both were until #165. The justification here used to be that eight
/// finding types across three hosts is 24, one under the cap, so 25 could not clip a real production.
/// That is a host COUNT written into a reason — the thing #25 and #34 forbid — and findings are keyed
/// `(host, type)`, so the true ceiling is `hosts × 8` and a fourth reported host puts it at 32. The
/// `total` and `truncated` fields below are what make a cap that DOES bite say so.
Parameter MAXFINDINGS = 25;

/// The `Finding` keys this tool will republish, from `contracts/healthscan.d.ts`.
///
/// AN ALLOWLIST, for the reason `Tools.Read.#SETTINGALLOWLIST` is one: the array arrives from another
/// service over HTTP, and copying it through wholesale would put whatever the engine adds next in
/// front of an external LLM without a decision being taken. Adding a key here is that decision.
Parameter FINDINGKEYS = {$listbuild(
    "id",
    "host",
    "type",
    "severity",
    "currentValue",
    "baselineValue",
    "detectedAt",
    "message")};

/// What Production Guardian is reporting about this production RIGHT NOW: the open findings, each
/// with its host, type, severity, the value that triggered it, the baseline it was compared against,
/// and when it was first confirmed.
///
/// Call this for any question about whether something is wrong now, or about a condition a user
/// names — a queue building, a pool bottleneck, a host being down, errors rising. These are CURRENT
/// readings computed by the detection engine, not recorded averages, so do not mix a value from here
/// with a figure from the activity or event-log tools without saying which is which.
///
/// Pass `host` to narrow to one interoperability host, or omit it for the whole production.
ClassMethod GetActiveFindings(host As %String = "") As %DynamicObject
{
    // `count`, `total` and `truncated` all start null and stay null on every path that returns without
    // reading a snapshot. `truncated: false` there would assert that a list nobody read is complete,
    // which is §2.1's rule applied to a boolean: an unmeasurable value is not a small one.
    set out = { "host": null, "supplied": false, "count": null, "total": null, "truncated": null,
        "findings": null, "asOf": null, "state": null, "sanitised": true }
    // null when unfiltered, so "every host" and "a host whose name is the empty string" are
    // different payloads rather than the same one.
    if host '= "" {
        set out.host = host
    }

    if '$data(^||PGGuardian("chat", ..#HANDOFF)) {
        // NOT an empty list. See the class comment -- an empty findings list asserts a healthy
        // production, and this is the one condition where that assertion would be unfounded.
        set out.reason = "no findings snapshot was supplied with this question, so the current " _
            "findings cannot be read from here -- do not conclude that the production is healthy"
        quit out
    }

    try {
        set raw = ##class(%DynamicArray).%FromJSON(^||PGGuardian("chat", ..#HANDOFF))
    } catch parseEx {
        set out.reason = "the supplied findings snapshot could not be parsed: " _
            parseEx.DisplayString()
        // RETURN, not QUIT. Inside a TRY or CATCH block `QUIT` exits the BLOCK and refuses an argument
        // -- `quit out` there is compile error #1043, not a method return. Every other exit in this
        // method is at top level and uses `quit`, which is the surrounding convention.
        return out
    }

    do out.%Set("supplied", 1, "boolean")
    set out.asOf = $get(^||PGGuardian("chat", "asOf"), "")
    // `ok`, `warming` or `stale` -- the DETECTION ENGINE's state at the poll these findings came from,
    // and the reason `count: 0` is not self-explanatory. See the note below.
    set out.state = $get(^||PGGuardian("chat", "state"), "")
    set findings = []
    set matched = 0
    set iter = raw.%GetIterator()
    while iter.%GetNext(.index, .finding) {
        if '$isobject(finding) {
            continue
        }
        // FILTER FIRST. The cap below tests `findings.%Size()`, which counts pushed MATCHES, so a
        // non-matching finding does not consume cap budget wherever these two blocks sit -- #165 reads
        // this as "capping first would return the first 25 of the production and then filter them",
        // and that is not what these lines do. It IS what a cap on the ITERATION would do, so the
        // order still carries the property: cap the filtered set, never the array.
        if (host '= "") && (finding.%Get("host") '= host) {
            continue
        }
        // AFTER THE FILTER, and this is the line that would break quietly. `matched` sizes the filtered
        // set; counted one line up instead it would size the production, and then `total` would answer
        // about every host while `count` answered about one -- "3 of 31 shown" for a host with three
        // findings, which is exactly the mis-scoping #186 fixed in `get_interface_path`. Pinned in
        // `Test.FindingsTruncation`, which was checked against that mutation rather than assumed to
        // catch it.
        set matched = matched + 1
        // `continue` rather than `quit`: the loop keeps counting past the cap, which is the only way
        // `truncated` can be computed rather than guessed.
        if findings.%Size() >= ..#MAXFINDINGS {
            continue
        }
        do findings.%Push(..Republish(finding))
    }
    set out.findings = findings
    set out.count = findings.%Size()

    // HOW MANY EXIST, AS AGAINST HOW MANY CAME BACK — and where that is unknowable, null rather than
    // the number we happen to have (#165).
    //
    // `total` is scoped to the SAME filter as `count`, which is `get_interface_path`'s rule for
    // `pathCount` and for the reason #186 gives there: a total describing the production while the
    // list describes one host reads as "22 of 31 shown" about a host with four findings.
    //
    // The three cases, and only the third is null:
    //
    //   unfiltered            the stashed total is the engine's own pre-slice length, so it is exact
    //                         and `count < total` catches a clip at EITHER stage
    //   filtered, full stash  every finding that exists is in the stash, so the matches are all of
    //                         them and `matched` is exact
    //   filtered, clipped     the withheld findings were dropped before this method saw a host, so
    //                         how many of them were on this one is not knowable here. `truncated`
    //                         still answers, because "some were dropped" is known even when "how
    //                         many of yours" is not
    set stashTotal = $get(^||PGGuardian("chat", "total"), "")
    if '$isvalidnum(stashTotal) {
        // Absent or unreadable: the stash is all we know of, so treat it as whole. Only reachable
        // from a node this build did not write, since `Ask()` kills the subtree on entry.
        set stashTotal = raw.%Size()
    }
    set stashClipped = (stashTotal > raw.%Size())
    if host = "" {
        set out.total = stashTotal
    } elseif 'stashClipped {
        set out.total = matched
    }
    do out.%Set("truncated", $select(out.total = "": 1, 1: out.count < out.total), "boolean")
    // Said in the payload because the model cannot otherwise tell an unfiltered empty list from a
    // filtered one, and "no findings on Cloud API" and "no findings anywhere" support different
    // answers.
    //
    // AND BECAUSE `count: 0` DOES NOT MEAN THE SAME THING IN EVERY ENGINE STATE. Under `warming` the
    // engine's six comparative rules are silent by design -- below `minBaselineSamples` there is
    // nothing to compare against -- so an empty list is "not measured yet", and a model that reads it
    // as health gives a confident all-clear on a production nobody has looked at. Under `stale` the
    // list is the last one the engine could compute, which is old rather than wrong. Neither is
    // inferable from the array, so the tool says which it is rather than leaving the emptiness to
    // speak for itself.
    set scope = $select(host = "": " on this production", 1: " on " _ host)
    if out.truncated {
        // TESTED BEFORE `count = 0`, and the order is the correctness argument. A filtered call whose
        // matches were all dropped upstream returns `count: 0`, and the plain note below would answer
        // it with "no open findings on Cloud API at the instant this question was asked" — a false
        // all-clear composed from a list nobody could see, which is the same defect as `supplied:
        // false` wearing the shape of a successful answer.
        //
        // Phrased as an instruction rather than a fact for the reason the notes below are: the failure
        // is not the model missing a flag, it is the model reporting `count` as the number of issues.
        if out.total '= "" {
            set out.note = "this list is INCOMPLETE: " _ out.count _ " of " _ out.total _
                " open findings" _ scope _ " are shown, and the rest were dropped by a size cap " _
                "before this tool could read them -- state " _ out.total _ " as the number of open " _
                "findings and say that only " _ out.count _ " of them are described here"
        } else {
            set out.note = "this list is INCOMPLETE and the true number is NOT KNOWN here: the " _
                "findings supplied with this question were capped across the whole production " _
                "before they could be narrowed to " _ host _ ", so there may be open findings on " _
                host _ " that are absent from this list -- treat " _ out.count _ " as a lower bound " _
                "and never as a count, and do not conclude that " _ host _ " is clear"
        }
    } elseif out.count = 0 {
        if out.state = "warming" {
            set out.note = "the detection engine is still warming up, so its comparative rules are " _
                "SILENT and no findings can be reported yet" _ scope _ " -- this is not evidence " _
                "that nothing is wrong"
        } elseif out.state = "stale" {
            set out.note = "no open findings" _ scope _ " as of " _ out.asOf _ ", but the engine " _
                "could not reach the metrics source at that poll, so this list may be out of date"
        } else {
            set out.note = "no open findings" _ scope _ " at the instant this question was asked"
        }
    }
    quit out
}

/// One finding, reduced to the allowlisted keys. Private.
///
/// COPIES KEY BY KEY rather than returning the object it was handed. Same reasoning as
/// `Tools.EventLog`'s two-query split: a filter that removed unwanted keys would be equally correct
/// today and one edit away from being wrong, while a copy cannot carry a key nobody listed.
///
/// A MISSING KEY BECOMES `null`, not an omission, so every finding in the array has the same shape —
/// a model comparing two findings should not have to notice that one lacks `baselineValue` because it
/// was warming.
ClassMethod Republish(finding As %DynamicObject) As %DynamicObject [ Private ]
{
    set out = {}
    set keys = ..#FINDINGKEYS
    for i = 1:1:$listlength(keys) {
        set key = $list(keys, i)
        if finding.%IsDefined(key) {
            do out.%Set(key, finding.%Get(key))
        } else {
            // The explicit "null" type, not `%Set(key, "")` -- the latter emits a JSON empty STRING,
            // and `"baselineValue": ""` is the fabricated-zero shape wearing different clothes.
            do out.%Set(key, "", "null")
        }
    }
    quit out
}

}
