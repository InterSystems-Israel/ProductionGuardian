/// Proof that `get_active_findings` filters BEFORE it truncates, and says so when it truncates.
///
/// WHY THIS IS PINNED RATHER THAN COMMENTED. #165 closes by naming the property this class exists for:
/// `GetActiveFindings` applies the `host` filter before the cap, which is the correct order, and
/// *"swapping them would still return plausible output and would be easy to miss in review"*. That is
/// the failure class this repository keeps meeting — a wrong answer wearing the shape of a right one —
/// and a comment does not fail when someone reorders two lines.
///
/// IT ALSO PINS THE FIELDS #165 ADDED. `count` was the post-cap size with nothing saying so, so a
/// clipped list and a complete one were byte-identical; `total` and `truncated` are what tell them
/// apart, and each of the states below is one a model would otherwise report as a fact.
///
/// WHAT THE MUTATION ACTUALLY SHOWED, because it was run rather than assumed and it corrects #165's
/// own reading. Swapping the filter block and the cap block leaves `count` correct: the cap tests
/// `findings.%Size()`, which counts pushed MATCHES, so a non-matching finding never consumes cap budget
/// and the "first 25 of the production, then filtered" outcome the issue describes does not arise from
/// that swap. What the swap breaks is `matched` — counted before the filter it sizes the production
/// while `count` sizes the host, and `FilterBeforeCap` fails on `total` and `truncated` rather than on
/// the count. Both properties are covered here: `count: 2` on an array whose first 28 elements are
/// another host is what would fail if the cap were ever moved onto the ITERATION, and the total
/// assertions are what fail if the two blocks trade places. Written down because a test justified by a
/// failure it does not actually catch is the same defect as a contract justified by a runtime it does
/// not match (#202).
///
/// THE INPUT IS SYNTHETIC AND DELIBERATELY LARGER THAN THIS PRODUCTION CAN PRODUCE. Host names and
/// finding types are the real ones (`iris/labdemo/Production.cls`, `contracts/healthscan.d.ts`), but
/// the arrays here run to 30 elements and findings are keyed `(host, type)`, so three reported hosts
/// across eight types cannot exceed 24. That is the point rather than a liberty taken: the cap under
/// test is the one whose justification in three separate comments *was* "24 is the ceiling, so 25
/// cannot clip", which is a host count compiled into a reason (#25, #34) and wrong at four hosts. A
/// fixture that stayed under the ceiling could not exercise the branch. Nothing here is served to a
/// dashboard, an LLM or an API — it is an argument to one method.
///
/// NO PRIVILEGE, NO USER, NO NETWORK, NO METERED CALL, unlike `Test.GovernanceProof`: the tool reads a
/// process-private global and this class writes it, so the whole proof is local and repeatable. It is
/// still hand-run rather than compiled at boot, because `iris/CLAUDE.md` keeps `iris/test/` out of what
/// the deploy ships and one cheap fixture is not a reason to change that.
///
/// ```
/// do $system.OBJ.LoadDir("/pg-src/test/", "ck", .errors, 1)
/// write ##class(ProductionGuardian.Test.FindingsTruncation).Prove()
/// ```
Class ProductionGuardian.Test.FindingsTruncation
{

/// The eight real finding types, cycled so the fixture does not carry 30 copies of one classification.
Parameter TYPES = {$listbuild(
    "queue_buildup",
    "growing_queue_wait",
    "slow_processing",
    "elevated_error_rate",
    "throughput_drop",
    "dead_host",
    "stalled_host",
    "system_alert")};

/// Run every case. Returns 1 only if all of them pass.
ClassMethod Prove() As %Boolean
{
    write "get_active_findings -- filter order and truncation reporting (#165)", !
    write "=================================================================", !, !

    set ok = 1
    set ok = ..FilterBeforeCap() && ok
    set ok = ..LocalCapIsReported() && ok
    set ok = ..UpstreamClipIsReported() && ok
    set ok = ..CompleteListIsNotFlagged() && ok
    set ok = ..FilteredClipIsNotAnAllClear() && ok
    set ok = ..AbsentTotalReadsAsWhole() && ok
    set ok = ..NoSnapshotReportsNeither() && ok

    kill ^||PGGuardian("chat")
    write !, $select(ok: "PASS -- all cases", 1: "FAIL -- see above"), !
    quit ok
}

/// THE HEADLINE. 28 findings on one host, then 2 on another, and the second host is the one asked
/// about — so every assertion here is about a number that must describe `Cloud API` and not the array
/// it was found in. Measured against the block swap and against a cap moved onto the iteration; see
/// the class comment for which assertion catches which.
ClassMethod FilterBeforeCap() As %Boolean [ Private ]
{
    do ..Stash(..Repeat("Lab Router", 28) _ "," _ ..Repeat("Cloud API", 2), 30)
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings("Cloud API")
    set ok = ..Check("filtered count is the matches, not the page", out.count, 2)
    set ok = ..Check("both returned findings are the host asked about", ..HostsOf(out),
        "Cloud API/Cloud API") && ok
    // Nothing matching was withheld and the stash was whole, so the filtered total is exact.
    set ok = ..Check("filtered total is exact", ..Shape(out, "total"), "number:2") && ok
    set ok = ..Check("not reported as truncated", ..Shape(out, "truncated"), "boolean:0") && ok
    quit ok
}

/// The cap in THIS method biting, with nothing dropped upstream. Unreachable while both caps are 25 —
/// `ChatDispatcher.StashFindings` cannot hand over more than the tool will return — and that is
/// precisely #165's other half: raise one literal and the other starts dropping. It must not drop
/// silently when it does.
ClassMethod LocalCapIsReported() As %Boolean [ Private ]
{
    do ..Stash(..Repeat("Cloud API", 30), 30)
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings()
    set ok = ..Check("count is the cap", out.count, 25)
    set ok = ..Check("total is what exists", ..Shape(out, "total"), "number:30") && ok
    set ok = ..Check("truncated", ..Shape(out, "truncated"), "boolean:1") && ok
    set ok = ..Check("note states the true number", ''(out.note [ "25 of 30"), 1) && ok
    quit ok
}

/// A clip that happened BEFORE this instance saw the list — the engine's own `MAX_FINDINGS` slice. The
/// stash holds 25 and `total` says 40, which is the only reason the difference is knowable at all.
ClassMethod UpstreamClipIsReported() As %Boolean [ Private ]
{
    do ..Stash(..Repeat("Cloud API", 25), 40)
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings()
    set ok = ..Check("count is what arrived", out.count, 25)
    set ok = ..Check("total is what the engine measured", ..Shape(out, "total"), "number:40") && ok
    set ok = ..Check("truncated", ..Shape(out, "truncated"), "boolean:1") && ok
    set ok = ..Check("note states the true number", ''(out.note [ "25 of 40"), 1) && ok
    quit ok
}

/// THE NEGATIVE CASE, and the one that keeps the flag worth reading. A `truncated` that is true often
/// enough is a field a model learns to ignore, so a complete list must come back clean and carry no
/// note at all — `note` exists for "this number does not speak for itself", and here it does.
ClassMethod CompleteListIsNotFlagged() As %Boolean [ Private ]
{
    do ..Stash("EMR Source,Lab Router,Cloud API", 3)
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings()
    set ok = ..Check("count", out.count, 3)
    set ok = ..Check("total equals count", ..Shape(out, "total"), "number:3") && ok
    set ok = ..Check("not truncated", ..Shape(out, "truncated"), "boolean:0") && ok
    set ok = ..Check("no note on a complete list", out.%IsDefined("note"), 0) && ok
    quit ok
}

/// THE CASE THE `count: 0` NOTE WOULD HAVE ANSWERED WRONGLY, and the reason `truncated` is tested
/// first in the method. The stash was clipped across the whole production before a host could be
/// applied, so how many of the withheld findings were on this host is not knowable here — `total` is
/// null rather than 0, and the note must not say "no open findings on Cloud API".
ClassMethod FilteredClipIsNotAnAllClear() As %Boolean [ Private ]
{
    do ..Stash(..Repeat("Lab Router", 5), 40)
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings("Cloud API")
    set ok = ..Check("count", out.count, 0)
    set ok = ..Check("total is null, not zero", ..Shape(out, "total"), "null:") && ok
    set ok = ..Check("truncated", ..Shape(out, "truncated"), "boolean:1") && ok
    set ok = ..Check("note refuses the all-clear", ''(out.note [ "do not conclude"), 1) && ok
    set ok = ..Check("note does not claim no open findings",
        ''(out.note [ "no open findings"), 0) && ok
    quit ok
}

/// A stash written without a `total` node. Only reachable from a build that predates #165, and it must
/// degrade to "as far as I know, whole" rather than to a null total on every call — the field is worth
/// nothing if the common case reads unknown.
ClassMethod AbsentTotalReadsAsWhole() As %Boolean [ Private ]
{
    do ..Stash("Cloud API,Lab Router", "")
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings()
    set ok = ..Check("total falls back to what was stashed", ..Shape(out, "total"), "number:2")
    set ok = ..Check("not truncated", ..Shape(out, "truncated"), "boolean:0") && ok
    quit ok
}

/// `supplied: false` — no snapshot reached the request. `truncated: false` here would assert that a
/// list nobody read is complete, so both fields stay null: `mcp-tools.md` §2.1's rule, applied to a
/// boolean and to a count rather than to a metric.
ClassMethod NoSnapshotReportsNeither() As %Boolean [ Private ]
{
    kill ^||PGGuardian("chat")
    set out = ##class(ProductionGuardian.LabDemo.Tools.Findings).GetActiveFindings()
    set ok = ..Check("supplied is false", ..Shape(out, "supplied"), "boolean:0")
    set ok = ..Check("count is null", ..Shape(out, "count"), "null:") && ok
    set ok = ..Check("total is null", ..Shape(out, "total"), "null:") && ok
    set ok = ..Check("truncated is null, not false", ..Shape(out, "truncated"), "null:") && ok
    quit ok
}

/// Write the handoff `REST.ChatDispatcher.StashFindings` writes, one finding per host in `hostList`.
///
/// `total` is passed separately and can be larger than the array, because that combination is exactly
/// what a clip upstream looks like on arrival: the node holds what fitted and `total` holds what
/// existed. Passing "" omits the node.
ClassMethod Stash(hostList As %String, total As %String) [ Private ]
{
    kill ^||PGGuardian("chat")
    set types = ..#TYPES
    set arr = []
    for i = 1:1:$length(hostList, ",") {
        do arr.%Push({
            "id": ("fixture-" _ i),
            "host": ($piece(hostList, ",", i)),
            "type": ($list(types, (i # $listlength(types)) + 1)),
            "severity": "critical",
            "currentValue": 1,
            "baselineValue": 0,
            "detectedAt": "2026-09-01T00:00:00Z",
            "message": "synthetic fixture finding -- Test.FindingsTruncation"
        })
    }
    set ^||PGGuardian("chat", "findings") = arr.%ToJSON()
    set ^||PGGuardian("chat", "asOf") = "2026-09-01T00:00:00Z"
    // `ok` throughout, so no case here can pass by way of the `warming` or `stale` note.
    set ^||PGGuardian("chat", "state") = "ok"
    if total '= "" {
        set ^||PGGuardian("chat", "total") = total
    }
}

/// `hostList` fragment repeating one host `n` times.
ClassMethod Repeat(host As %String, n As %Integer) As %String [ Private ]
{
    set out = ""
    for i = 1:1:n {
        set out = out _ $select(i = 1: "", 1: ",") _ host
    }
    quit out
}

/// The hosts of the returned findings, slash-separated.
///
/// ITERATED RATHER THAN INDEXED, because the first version read `%Get(0).host _ "/" _ %Get(1).host` and
/// the cap-on-iteration mutation returned an empty array, so the assertion died with `<INVALID OREF>`
/// and took the remaining six cases with it. A fixture that crashes instead of failing reports less
/// than one that fails, and the run it crashed on is the run that mattered.
ClassMethod HostsOf(out As %DynamicObject) As %String [ Private ]
{
    set hosts = ""
    if '$isobject(out.findings) {
        quit ""
    }
    set iter = out.findings.%GetIterator()
    while iter.%GetNext(.index, .finding) {
        set hosts = hosts _ $select(hosts = "": "", 1: "/") _ finding.%Get("host")
    }
    quit hosts
}

/// One field as `type:value`.
///
/// TYPE AND VALUE TOGETHER, because the distinction this whole change rests on is `null` versus
/// `false`, and both read as "" through `%Get`. Comparing the value alone would let a null pass a test
/// written for false, which is the one assertion that must not be loose here.
ClassMethod Shape(out As %DynamicObject, field As %String) As %String [ Private ]
{
    quit out.%GetTypeOf(field) _ ":" _ out.%Get(field)
}

/// Report one assertion.
ClassMethod Check(label As %String, actual As %String, expected As %String) As %Boolean [ Private ]
{
    set ok = (actual = expected)
    write $select(ok: "  PASS  ", 1: "  FAIL  "), label
    if 'ok {
        write " -- expected '", expected, "', got '", actual, "'"
    }
    write !
    quit ok
}

}
