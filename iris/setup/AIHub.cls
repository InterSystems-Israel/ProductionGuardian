/// The MVP 2 governance setup, as one idempotent call.
///
///   do ##class(ProductionGuardian.Setup.AIHub).Run()
///
/// WHY THIS EXISTS, and it is the same reason `FirstBoot` exists. Measured on the running compose
/// stack (`pg-iris`, up 2 days) on 2026-08-19, every piece of MVP 2's security model was ABSENT:
///
///   PG_Read resource            0
///   PG_Resolve resource         0
///   Guardian_Read role          0
///   Guardian_Resolve role       0
///   AI.Secrets resource         0
///   PGSecrets wallet            0
///   AI.LLM.pgdetective config   ERROR #5809 -- not found
///
/// `docs/mvp2-aihub-verified-api.md` records all of that as done, and it WAS done -- by hand, on the
/// hand-built `iris-webinar` instance the MCP dev connection used to point at. None of it reached the
/// container the demo actually runs from. That is exactly the failure `FirstBoot` was written for
/// (#70, #72): a step performed by a person on one instance is not a step the stack performs.
///
/// SO THE TOOLS WERE NOT GOVERNED. `Tools.AuthPolicy` checks `$SYSTEM.Security.Check("PG_Resolve")`,
/// and a resource that does not exist cannot be held -- but the policy was never registered either
/// (see `Tools.Governance`), so nothing consulted it. On a clean `docker compose up`, `SetPoolSize`
/// was callable against the live production by anything that could reach the MCP endpoint, with no
/// authorization check and no audit row. Every guard inside `Tools.Resolve` still applied; those are
/// the tool defending itself, not an authorization boundary.
///
/// WHAT THIS CLASS DELIBERATELY DOES NOT DO. It does not create the LLM credential. That needs an
/// API key, a key does not belong in a repository (root `CLAUDE.md` §6, MVP 2 §6 "Credential
/// exposure"), and the current one must be rotated regardless -- it was pasted into a chat transcript
/// to reach me. `Status()` REPORTS whether the provider config resolves and prints the exact
/// sequence to create it, so the missing piece is visible rather than discovered during a rehearsal.
Class ProductionGuardian.Setup.AIHub
{

/// Resource required to see or call any Production Guardian tool. Matches
/// `Tools.AuthPolicy.#READRESOURCE` -- and deliberately NOT imported from it, by the same rule that
/// keeps `Tools.Read.#PRODUCTION` a separate literal: a setup script that silently followed a rename
/// in the policy would create a resource for a boundary nobody reviewed.
Parameter READRESOURCE = "PG_Read";

/// Resource required to EXECUTE the one mutating tool.
Parameter WRITERESOURCE = "PG_Resolve";

/// Role granted to a caller that may gather evidence but not act. `mcp-tools.md` and
/// `resolve-api.md` write these `%Guardian_Read` / `%Guardian_Resolve`; IRIS refuses a leading `%`
/// with `ERROR #887: Invalid role name` because that prefix is reserved for system roles. The
/// unprefixed names are what can exist, and PR #93 is the contract correction.
Parameter READROLE = "Guardian_Read";

/// Role granted to a caller that may apply the governed action.
Parameter WRITEROLE = "Guardian_Resolve";

/// Application-defined resource type.
///
/// 2147483648 (0x80000000), read off the FSB_* resources this image already ships rather than picked
/// from a constant list -- the property is typed `Security.Datatype.ResourceType` with no VALUELIST
/// to read, so an existing resource of the right kind is the only honest source.
Parameter RESOURCETYPE = 2147483648;

/// The shipped role carrying database access, which a caller ALSO needs — and which these roles
/// deliberately do not include.
///
/// A PRINCIPAL NEEDS TWO THINGS, and only one of them is ours. `PG_Read:U` lets the policy say yes;
/// it does not let a principal run the code that asks. Measured: a real user holding only
/// `Guardian_Read` logged in successfully and then died with
///
///     <PROTECT> ... |ProductionGuardian.LabDemo.Tools.Governance.1    Access Denied
///
/// before any policy was consulted — it could not read the routine. Neither `mcp-tools.md` nor
/// `resolve-api.md` mentions a database privilege, so a reader implementing the roles from the
/// contracts alone produces roles that appear correct and cannot be used.
///
/// THESE ROLES STILL DO NOT GRANT IT, and that is @Ari-Glikman's call from the #94 review rather than
/// mine — I had folded `%DB_%DEFAULT:RW` into both roles and he argued the role should stay minimal
/// and mean one thing. He is right, and the deciding reason is what the grant would say: on this image
/// every database shares the `%DB_%DEFAULT` resource, so folding it in gives a role whose entire
/// purpose is "may look, may not act" the ability to write every database on the instance. A
/// least-privilege boundary that hands out broad write to keep a fixture working is not one.
///
/// SO WHERE DOES IT COME FROM? The invocation path, which is the layer that actually knows. In the
/// demo that is the CSP application hosting `REST.AgentDispatcher` — a web application authenticates
/// the caller and can carry application roles — and for the direct-session proof it is
/// `Test.GovernanceProof`, which grants this role to its throwaway user. Named here rather than in
/// both places so there is one spelling of it.
///
/// Reported by `Run()` rather than granted, because a requirement nobody states is how the
/// `<PROTECT>` above gets diagnosed as a policy bug.
Parameter DBROLE = "%DB_%DEFAULT";

/// Create the resources and roles, then report what is and is not in place.
///
/// IDEMPOTENT. Every step checks before acting and says what it found, so a re-run after a partial
/// failure is safe -- which matters because compose restarts containers and this is called from
/// `FirstBoot`.
ClassMethod Run() As %Status
{
    write "ProductionGuardian MVP 2 AI Hub governance setup", !
    write "===============================================", !, !

    set sc = ..CreateResources()
    if $$$ISERR(sc) {
        quit sc
    }
    set sc = ..CreateRoles()
    if $$$ISERR(sc) {
        quit sc
    }
    do ..ReportTools()
    do ..ReportProvider()

    write !, "-----------------------------------------------", !
    write "These roles grant the PG_* resources and nothing else. A principal", !
    write "ALSO needs database access or it dies with <PROTECT> before any", !
    write "policy is consulted -- grant ", ..#DBROLE, " alongside, from the", !
    write "invocation path (the CSP application, or the proof fixture).", !
    write "Policies are NOT registered by this call -- they cannot be.", !
    write "%AI.ToolMgr holds them in memory, per instance. Obtain a governed", !
    write "manager with:", !
    write "  set mgr = ##class(ProductionGuardian.LabDemo.Tools.Governance).ToolManager()", !
    quit $$$OK
}

/// The two IRIS resources the authorization policy checks.
ClassMethod CreateResources() As %Status
{
    set res(..#READRESOURCE) = "Production Guardian: list and call MCP read tools"
    set res(..#WRITERESOURCE) = "Production Guardian: execute set_pool_size on a live production"

    new $namespace
    set $namespace = "%SYS"
    set name = ""
    for {
        set name = $order(res(name), 1, desc)
        quit:name=""
        if ##class(Security.Resources).Exists(name) {
            write "1. resource ", name, ": exists", !
            continue
        }
        // PUBLIC PERMISSION IS EMPTY, which is the whole point of the resource. A public permission
        // of "U" would grant USE to everyone and make the policy's check pass for every caller --
        // a boundary that exists, is consulted, and never refuses. That is the shape of defect
        // `Tools.AuthPolicy` was written to remove, reintroduced one argument later.
        set sc = ##class(Security.Resources).Create(name, desc, "", ..#RESOURCETYPE)
        write "1. resource ", name, ": ", $select(sc: "created", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
        if $$$ISERR(sc) {
            quit
        }
    }
    quit $select($data(sc): sc, 1: $$$OK)
}

/// The two roles. `Guardian_Resolve` holds BOTH resources.
///
/// It is not enough for the write role to hold `PG_Resolve`: `%CanExecute` requires `PG_Read` on
/// every tool before it considers the write resource at all, so a role holding only `PG_Resolve`
/// would be refused on the first check with a message about the wrong privilege. Verified against
/// the policy's own ordering rather than assumed from the names.
ClassMethod CreateRoles() As %Status
{
    // THE PG_* RESOURCES ONLY. See #DBROLE for why database access is deliberately not folded in.
    set roles(..#READROLE) = $listbuild(
        "Production Guardian: evidence gathering, no mutation",
        ..#READRESOURCE _ ":U")
    set roles(..#WRITEROLE) = $listbuild(
        "Production Guardian: may apply the governed pool-size action",
        ..#READRESOURCE _ ":U," _ ..#WRITERESOURCE _ ":U")

    new $namespace
    set $namespace = "%SYS"
    set name = ""
    for {
        set name = $order(roles(name), 1, spec)
        quit:name=""
        set desc = $list(spec, 1)
        set resources = $list(spec, 2)
        if ##class(Security.Roles).Exists(name) {
            do ##class(Security.Roles).Get(name, .props)
            set current = $get(props("Resources"))
            if current = resources {
                write "2. role ", name, ": exists, resources = ", current, !
                continue
            }
            // CONVERGED, NOT LEFT ALONE -- and the difference from #66 is ownership. #66's lesson was
            // that restoring a HARDCODED value destroyed a port an operator had legitimately chosen.
            // These two roles are ours: the names are namespaced to this product, their entire
            // purpose is defined by this class, and a `Guardian_Read` holding the wrong resources is
            // not a tuned deployment, it is a stale one. The failure it causes is also silent -- the
            // policy refuses, the dashboard shows a disabled button, and the cause looks like a
            // policy bug -- so leaving it and printing a note would be the worse outcome.
            //
            // The old value is printed before the new one so the change is reviewable rather than
            // merely done. That is the part #66 was actually missing.
            kill mod
            set mod("Resources") = resources
            set sc = ##class(Security.Roles).Modify(name, .mod)
            write "2. role ", name, ": ", $select(sc: "updated", 1: "UPDATE FAILED " _ $system.Status.GetErrorText(sc)), !
            write "   was: ", current, !
            write "   now: ", resources, !
            if $$$ISERR(sc) {
                quit
            }
            continue
        }
        set sc = ##class(Security.Roles).Create(name, desc, resources, "")
        write "2. role ", name, ": ", $select(sc: "created with " _ resources, 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
        if $$$ISERR(sc) {
            quit
        }
    }
    quit $select($data(sc): sc, 1: $$$OK)
}

/// How many tools the runtime actually discovers, and their names.
///
/// SIX, AND THE COUNT IS THE TEST. `Tools.Read` and `Tools.Resolve` both warn that every public
/// ClassMethod becomes an LLM-callable tool, so a seventh name here means a helper was left public
/// -- and for `Tools.Resolve` a seventh name is a second way to mutate a live production. Printed on
/// every setup run so the regression is visible at boot rather than in a review.
ClassMethod ReportTools()
{
    set expected = 6
    set found = 0
    for class = "ProductionGuardian.LabDemo.Tools.Read", "ProductionGuardian.LabDemo.Tools.Resolve" {
        if '##class(%Dictionary.CompiledClass).%ExistsId(class) {
            write "3. tools ", class, ": NOT COMPILED", !
            continue
        }
        try {
            set inst = $classmethod(class, "%New")
            set cat = inst.%Discover()
            set names = ""
            if $isobject(cat.tools) {
                set it = cat.tools.%GetIterator()
                while it.%GetNext(.k, .t) {
                    set found = found + 1
                    set names = names _ $select(names = "": "", 1: ", ") _ t.name
                }
            }
            write "3. tools ", $piece(class, ".", *), ": ", names, !
        } catch ex {
            write "3. tools ", class, ": DISCOVERY FAILED ", ex.DisplayString(), !
        }
    }
    write "3. tools discovered: ", found, $select(found = expected: " (expected " _ expected _ ")", 1: " -- EXPECTED " _ expected _ ", INVESTIGATE"), !
}

/// Does an LLM provider configuration resolve? Reported, never created.
ClassMethod ReportProvider(pName As %String = "pgdetective")
{
    set id = "AI.LLM." _ pName
    try {
        set sc = ##class(%ConfigStore.Configuration).GetDetails(id, .d, 0, 0)
        if $$$ISERR(sc) {
            write "4. LLM provider ", id, ": NOT CONFIGURED", !
            write "   AI Detective cannot run until it is. It needs an API key, so it is not", !
            write "   created here -- a key in a repository is the credential-exposure risk", !
            // ASCII in terminal output. The comments in this area use a section sign freely and that
            // is fine in a source file, but IRIS wrote it to the terminal as a replacement character
            // -- and #81 was five raw 0x97 bytes doing the same kind of damage.
            write "   MVP 2 section 6 lists. Create it with the wallet pattern in", !
            write "   docs/mvp2-aihub-verified-api.md (""The LLM provider is configured"").", !
            quit
        }
        write "4. LLM provider ", id, ": configured, model = ", $select($isobject($get(d)): d.%Get("model", "?"), 1: "?"), !
    } catch ex {
        write "4. LLM provider ", id, ": CHECK FAILED ", ex.DisplayString(), !
    }
}

/// Report everything without changing anything.
ClassMethod Status()
{
    write "MVP 2 governance status", !
    write "-----------------------", !
    // The security check runs in its own method so `new $namespace` unwinds before the audit count,
    // which must read the LABDEMO table rather than %SYS.
    do ..ReportSecurity()
    set n = ..AuditCount()
    write "  audit rows: ", $select(n = "": "UNREADABLE from this principal", 1: n), !
    do ..ReportProvider()
}

/// Resources and roles as they actually stand. Private -- switches namespace.
ClassMethod ReportSecurity() [ Private ]
{
    new $namespace
    set $namespace = "%SYS"
    for name = ..#READRESOURCE, ..#WRITERESOURCE {
        write "  resource ", name, ": ", $select(##class(Security.Resources).Exists(name): "yes", 1: "MISSING"), !
    }
    for name = ..#READROLE, ..#WRITEROLE {
        if '##class(Security.Roles).Exists(name) {
            write "  role ", name, ": MISSING", !
            continue
        }
        do ##class(Security.Roles).Get(name, .props)
        write "  role ", name, ": ", $get(props("Resources")), !
    }
}

/// How many audit rows exist, or "" when the table cannot be read.
///
/// Delegates rather than keeping a second copy of the query -- two copies of a count is the #84
/// stale-copy pattern in miniature. See `Audit.Entry.AuditCountAll` for why an unreadable table is
/// "" and not 0.
ClassMethod AuditCount() As %Integer
{
    quit ##class(ProductionGuardian.LabDemo.Audit.Entry).AuditCountAll()
}

}
