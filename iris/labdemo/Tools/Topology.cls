/// MCP read tool over the production's INTERFACE MAP — which host feeds which.
///
/// Implements the one tool in `contracts/mcp-tools.md` §3.14. That contract is authoritative; where
/// this class and it disagree, the contract is right and this is a bug.
///
/// WHY THIS EXISTS (#177). Every other read tool in this family is scoped to ONE host, and so is the
/// snapshot the engine sends with an investigation. So AI Detective could describe the host it was
/// asked about in detail and could not see that anything else existed. Measured on a live run: an
/// upstream `MissingFolder` fault was fixed, 281 accumulated messages flushed through in one burst,
/// `Cloud API` queued 296 and `queue_buildup` fired — and the Detective, reading only `Cloud API`,
/// recommended doubling the pool to the maximum of its bounds at 0.85 confidence, on a queue that
/// drained to zero unaided while it was writing. Its own evidence said "No errors recorded in the
/// last 60 minutes", which was true of `Cloud API` and false of the production: `EMR Source` had been
/// erroring every poll for twenty minutes inside that same window.
///
/// A host-scoped tool cannot be wrong about that. It can only be silent, and a model reads silence as
/// absence.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// IRIS ALREADY KNOWS THE ANSWER, AND IT IS NOT IN THE SETTINGS
///
/// This tool computes nothing. `Ens.InterfaceMaps.Utils` is the engine behind the Management Portal's
/// Interface Maps page, and its `EnumeratePaths` query returns one row per end-to-end path with the
/// columns `Service, Processes, Rules, Transforms, Operation`.
///
/// THAT IT RESOLVES RULES IS THE WHOLE REASON TO USE IT rather than reading config here. On this
/// production the two links are declared in completely different places:
///
///   EMR Source -> Lab Router    a `TargetConfigNames` setting on the service
///   Lab Router -> Cloud API     a `<send target="Cloud API"/>` inside RoutingRule.cls
///
/// The second is invisible to anything that reads settings. `Ens.InterfaceMaps.Utils` walks routing
/// rules, DTLs and BPL diagrams (`findRuleConnections`, `handleSendTag`, `findBPLUse`) to find it. A
/// hand-rolled topology built from `TargetConfigNames` would have produced a map missing precisely
/// the edge #177 needs, and it would have looked right.
///
/// It also derives the map from the production DEFINITION rather than from runtime state, which is
/// what makes it usable here at all: an investigation runs when a host is broken, and a dead host is
/// still in the map.
///
/// NO SECOND SOURCE OF TRUTH. Root `CLAUDE.md` §6 makes the `<Item>` set in `Production.cls`
/// authoritative and forbids restating it; this reads IRIS's own derivation of it, so there is nothing
/// here to go stale when the production changes. That is the same argument `Tools.Read` makes for
/// reading `Ens.Config.Item` instead of a copied host list.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// THE QUERY, AND THE TWO SURFACES DELIBERATELY NOT USED
///
/// `Ens.InterfaceMaps.Utils` offers three ways in. This uses the SQL query, and the other two were
/// tried and rejected on evidence:
///
///   - `FindAllPaths()` returns each path as ONE STRING delimited by raw control characters --
///     measured as $c(12), $c(11) and $c(1) at byte offsets in a 122-character path. An undocumented
///     internal encoding, and #161 is open in this repo about exactly what raw control characters do
///     to a source file. The SQL query is that same data already parsed into named columns.
///   - `FindSequentialPath()` takes a JSON "spec" whose shape is not documented anywhere reachable.
///     Passing it a path string from `FindAllPaths` returns `ERROR #5035 ... 'Parsing error'`. Guessing
///     at an undocumented request shape would be a version-fragile dependency on an internal.
///
/// The query cost 33.7 ms on this production, measured. It walks rules and transforms, so that number
/// is about three hosts and one path and says nothing about a fifty-host production -- see the
/// contract's note.
///
/// **THE `Processes` COLUMN'S SEPARATOR FOR A CHAIN OF TWO OR MORE PROCESSES IS UNVERIFIED**, and
/// cannot be verified here: LABDEMO has exactly one business process, so no path in it has two. The
/// implementation source is not shipped, so it could not be read either. `SplitList` therefore parses
/// defensively -- any control character, or a comma-space -- and the contract records the gap rather
/// than implying it was checked. Getting this wrong on a longer chain degrades to a process name that
/// is not split, i.e. one wrong entry in `upstream`, not a wrong ANSWER about who is upstream of whom.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────
/// WHAT IT RETURNS, AND WHY `upstream` IS ORDERED
///
/// `upstream` and `downstream` are NEAREST FIRST. For `Cloud API` that is `["Lab Router",
/// "EMR Source"]` -- the host that feeds it, then the one that feeds that. Ordered because the model's
/// question is "who handed me this work", and an unordered set makes the immediate feeder
/// indistinguishable from something three hops away. Stated in the payload's own `note` as well, since
/// an array's order is not self-describing.
///
/// A TRUNCATED RESULT SAYS SO. `#MAXPATHS` caps what is returned and `truncated` reports it, because
/// #165 is open against exactly the opposite choice -- a tool that capped silently and published a
/// count of the capped list, so a consumer could not tell a small production from a clipped one.
///
/// CONFIGURATION ONLY, so §6's data boundary is not at risk here in the way it is for
/// `GetRecentErrors`: every value is a config item name, a rule class name or a DTL class name. No
/// message content, no PHI, nothing read from `Ens_Util.Log`. Rule and transform CLASS names are
/// included because "which transform runs between these two hosts" is diagnostic and is configuration;
/// their contents are not read.
Class ProductionGuardian.LabDemo.Tools.Topology Extends %AI.Tool
{

/// The production these tools report on. Same value as `Tools.Read.#PRODUCTION`, and deliberately NOT
/// imported from it, for the reason stated there: a tool that silently followed another class's change
/// would start reporting on a production it was not authorised for.
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// Cap on returned paths. Reported through `truncated` rather than applied silently (#165).
///
/// 50 rather than the 25 the findings tool uses: a path is one short row and the whole value of this
/// tool is seeing the shape of the production, where a clipped map could hide the one branch that
/// explains the fault. Still bounded, because the return value reaches a metered model.
Parameter MAXPATHS = 50;

/// Which hosts feed, and are fed by, one interoperability host — the production's interface map.
///
/// Use this whenever a finding might have been CAUSED SOMEWHERE ELSE. A queue building on a host that
/// is keeping up with its own work is the classic case: the work arrived in a burst because something
/// upstream was stopped and has been fixed, and the queue is draining through rather than growing.
///
/// `upstream` and `downstream` are nearest-first: the first entry in `upstream` is the host that hands
/// work directly to this one. The paths this host sits on are returned whole, with the routing rules
/// and transforms that connect each hop, so a fault can be traced to the hop that carries it.
///
/// Derived from the production's configuration by IRIS's own interface-map utility, which resolves
/// routing rules and transformations -- not only the `TargetConfigNames` settings. It describes how
/// the production is WIRED, not what is flowing now: pair it with the activity, event-log and findings
/// tools to see which of these hosts is actually in trouble.
///
/// Pass `host` to place one host in the map, or omit it for every path in the production.
ClassMethod GetInterfacePath(host As %String = "") As %DynamicObject
{
    set out = { "host": null, "production": (..#PRODUCTION), "known": false,
        "upstream": null, "downstream": null, "paths": null,
        "pathCount": 0, "pathsReturned": 0, "truncated": false,
        "basis": "Ens.InterfaceMaps.Utils", "note": null }
    // null when unfiltered, so "the whole production" and "a host whose name is empty" are different
    // payloads rather than the same one -- `Tools.Findings`'s rule, for its reason.
    if host '= "" {
        set out.host = host
    }

    set paths = [], upstream = [], downstream = []
    // Sets rather than arrays for the dedupe, keyed by name, with the nearest-first ORDER kept
    // separately: a host can sit on several paths and must not appear twice.
    kill seenUp, seenDown
    set truncated = 0, total = 0

    try {
        set rs = ##class(%SQL.Statement).%ExecDirect(
            ,
            "SELECT Service, Processes, Rules, Transforms, Operation "
                _ "FROM Ens_InterfaceMaps.Utils_EnumeratePaths(?,?,?,?,?,?)",
            "",
            // Every category in, because a filtered map would answer a different question than the
            // one asked. The shape is the utility's own default.
            "{""svc"":1,""op"":1,""proc"":1,""rule"":1,""xform"":1}",
            0,
            ..#PRODUCTION,
            "",
            ""
        )
        if rs.%SQLCODE < 0 {
            set out.note = "the interface map could not be read: SQLCODE " _ rs.%SQLCODE _ " " _ rs.%Message
            // RETURN, not QUIT: inside a TRY block `quit` exits the BLOCK and refuses an argument
            // (#1043). `Tools.Findings` carries the same note at the same kind of early exit.
            return out
        }

        while rs.%Next() {
            set total = total + 1
            if paths.%Size() >= ..#MAXPATHS {
                set truncated = 1
                continue
            }

            set svc = $zstrip(rs.Service, "<>W")
            set op = $zstrip(rs.Operation, "<>W")
            set procs = ..SplitList(rs.Processes)
            set rules = ..SplitList(rs.Rules)
            set xforms = ..SplitList(rs.Transforms)

            // The hops in flow order, service first. One list, so position and neighbours are read
            // off the same sequence rather than reasoned about per column -- which is what made the
            // rule-derived link easy to lose.
            set hops = []
            if svc '= "" {
                do hops.%Push(svc)
            }
            set pit = procs.%GetIterator()
            while pit.%GetNext(.pk, .pv) {
                do hops.%Push(pv)
            }
            if op '= "" {
                do hops.%Push(op)
            }

            set position = ""
            if host '= "" {
                set at = -1
                for i = 0:1:hops.%Size() - 1 {
                    if hops.%Get(i) = host {
                        set at = i
                        quit
                    }
                }
                if at < 0 {
                    // This path does not involve the host asked about. Not returned: the map for one
                    // host is the paths it sits on, and every other path is noise a model would have
                    // to filter itself.
                    continue
                }
                set out.known = 1
                set position = $case(at, 0: "service", (hops.%Size() - 1): "operation", : "process")
                // NEAREST FIRST in both directions -- walking outwards from the host rather than
                // along the path, which is the order the docstring promises.
                for i = at - 1:-1:0 {
                    set name = hops.%Get(i)
                    if '$data(seenUp(name)) {
                        set seenUp(name) = ""
                        do upstream.%Push(name)
                    }
                }
                for i = at + 1:1:hops.%Size() - 1 {
                    set name = hops.%Get(i)
                    if '$data(seenDown(name)) {
                        set seenDown(name) = ""
                        do downstream.%Push(name)
                    }
                }
            }

            set entry = { "service": (svc), "processes": (procs), "operation": (op),
                "rules": (rules), "transforms": (xforms), "hops": (hops) }
            if position '= "" {
                set entry.position = position
            }
            do paths.%Push(entry)
        }
    } catch ex {
        // The map is a diagnostic aid, so a failure to read it must not take an investigation down.
        // Reported as a reason rather than thrown, matching every other tool in this family.
        set out.note = "the interface map could not be read: " _ ex.DisplayString()
        return out
    }

    set out.paths = paths
    set out.pathsReturned = paths.%Size()
    set out.pathCount = total
    do out.%Set("truncated", truncated, "boolean")
    if host '= "" {
        set out.upstream = upstream
        set out.downstream = downstream
        do out.%Set("known", out.known, "boolean")
    }
    set out.note = ..Note(host, out.known, paths.%Size(), truncated)
    quit out
}

/// The payload's own explanation of what it does and does not assert. Private.
///
/// Written into the payload rather than left to the prompt, for `Tools.ChangeLog`'s reason: a model
/// reads the thing it was handed. The three sentences that matter are the ORDER of the arrays, that a
/// wiring map is not a statement about current traffic, and -- when the host is not in the map -- that
/// this is not evidence the host is fine.
ClassMethod Note(host As %String, known As %Boolean, returned As %Integer, truncated As %Boolean) As %String [ Private ]
{
    if (host '= "") && 'known {
        quit host _ " does not appear in any path of this production's interface map. That may mean "
            _ "it is not wired to anything, or that it is referenced only in a way the map cannot "
            _ "resolve -- it is NOT evidence that the host is healthy or that nothing feeds it."
    }
    set note = "upstream and downstream are NEAREST FIRST: the first entry in upstream hands work "
        _ "directly to this host. This describes how the production is WIRED, from its "
        _ "configuration, not what is flowing through it now -- a host being upstream does not mean "
        _ "it is currently sending anything."
    if truncated {
        set note = note _ " The path list is TRUNCATED at " _ returned _ " of " _ ..#MAXPATHS
            _ "; pathCount is the true total."
    }
    quit note
}

/// Split one column of the interface-map row into its members. Private.
///
/// DEFENSIVE BECAUSE THE SEPARATOR IS UNVERIFIED. See the class comment: LABDEMO has one business
/// process, so no path here has two, and the query's row-building source is not shipped. What IS
/// established is that the underlying path encoding uses control characters -- measured as $c(1),
/// $c(11) and $c(12) -- so those are split on, and a comma-space is split on as well because that is
/// how the portal renders a list.
///
/// Splitting on a bare comma would be worse than not splitting: a config item name may contain one,
/// and cutting a host name in half would put a host that does not exist into `upstream`. A separator
/// that turns out to be something else entirely leaves one unsplit name, which is visibly wrong rather
/// than quietly wrong.
ClassMethod SplitList(value As %String) As %DynamicArray [ Private ]
{
    set out = []
    if $get(value) = "" {
        quit out
    }
    // Normalise every control character to one delimiter first, so the split below is a single pass
    // and cannot depend on WHICH control character the utility used.
    set norm = ""
    for i = 1:1:$length(value) {
        set ch = $extract(value, i)
        set norm = norm _ $select($ascii(ch) < 32: $char(1), 1: ch)
    }
    set norm = $replace(norm, ", ", $char(1))
    for i = 1:1:$length(norm, $char(1)) {
        set piece = $zstrip($piece(norm, $char(1), i), "<>W")
        if piece '= "" {
            do out.%Push(piece)
        }
    }
    quit out
}

}
