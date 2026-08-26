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

/// Environment variable carrying the LLM API key. Never defaulted, never logged, never stored
/// outside the AI Hub wallet.
///
/// NO FALLBACK, for the same reason the roles have no default password: a key in source is a key in
/// git history. Absent, the provider is not created and `ReportProvider()` says NOT CONFIGURED --
/// which is the honest state, and one the engine already degrades to (`source: "canned"`).
Parameter APIKEYVAR = "PG_LLM_API_KEY";

/// Wallet collection and entry holding the key. The `secret://` URI in the ConfigStore entry
/// references these, so the key itself never appears in the configuration.
Parameter WALLET = "PGSecrets";

Parameter WALLETENTRY = "PGSecrets.openai";

/// Security resource guarding the wallet collection.
Parameter SECRETRESOURCE = "AI.Secrets";

/// Provider and model for the ConfigStore entry. `gpt-4o-mini` is what every live run on this
/// project used; overridable by PG_LLM_MODEL so a demo can switch model without a code change.
Parameter PROVIDER = "openai";

Parameter MODEL = "gpt-4o-mini";

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
    do ..CreateProvider()
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
/// Create the LLM provider config from the environment, or report why not. Idempotent.
///
/// WHAT THIS CLOSES. Until 2026-08-19 the wallet entry and ConfigStore config were created BY HAND
/// and lived only in a durable volume, so a fresh clone booted with
/// `4. LLM provider AI.LLM.pgdetective: NOT CONFIGURED` and AI Detective could not be demonstrated
/// at all. `ReportProvider()` reported it and nothing created it -- the same
/// "deployed interactively once" state #97 found for `iris/test/` and #106 for `/labdemo/agent`.
///
/// THE KEY GOES IN THE WALLET, NOT THE CONFIG. The ConfigStore entry holds
/// `secret://PGSecrets.openai#apikey`, and `GetDetails(..., resolveSecrets=1)` resolves it at read
/// time. So the key is in one place, guarded by a resource, and never in the configuration, the
/// repo, or a log line. Root `CLAUDE.md` §2.1 and MVP 2 §6's credential-exposure row both apply.
///
/// REPORTS AND CONTINUES on failure, matching the rest of GovernanceSetup(): MVP 1 does not need an
/// LLM, and the engine degrades to a labelled canned investigation rather than breaking.
ClassMethod CreateProvider() As %Status
{
    set key = $system.Util.GetEnviron(..#APIKEYVAR)
    if key = "" {
        write "4b. LLM provider: SKIPPED -- ", ..#APIKEYVAR, " is not set", !
        write "    AI Detective will serve a CANNED investigation (source ""canned""), which is", !
        write "    labelled and correct but is not a live agent. Set the variable to enable it.", !
        quit $$$OK
    }

    set model = $system.Util.GetEnviron("PG_LLM_MODEL")
    if model = "" {
        set model = ..#MODEL
    }

    try {
        // The resource first: %Wallet.Collection.Create refers to it, and creating the collection
        // against a nonexistent resource is the failure that reads as a wallet problem.
        new $namespace
        set $namespace = "%SYS"
        if '##class(Security.Resources).Exists(..#SECRETRESOURCE) {
            set sc = ##class(Security.Resources).Create(..#SECRETRESOURCE, "Production Guardian LLM secrets", "")
            write "4b. resource ", ..#SECRETRESOURCE, ": ", $select(sc: "created", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
        }

        // Collection, then entry, both idempotent by inspection rather than by relying on Create
        // returning a benign error for an existing name.
        //
        // THE ENVIRONMENT VARIABLE IS THE SINGLE SOURCE OF TRUTH for the key, so the ENTRY below is
        // rewritten on every boot when PG_LLM_API_KEY is set. An earlier version of this comment
        // argued the opposite -- that an existing wallet must not be overwritten because it might
        // hold a key rotated by hand -- while the code overwrote it anyway (@kskubach, #106). Both
        // positions are defensible and holding both is a footgun: an operator who rotates in the
        // wallet gets silently reverted on the next restart and diagnoses it as a rejected key.
        //
        // Rotation is therefore: change the variable, restart. DO NOT rotate by editing the wallet;
        // it will be overwritten. The COLLECTION is left alone once it exists, because it carries
        // only the resource bindings and nothing an operator would tune.
        if '##class(%Wallet.Collection).Exists(..#WALLET) {
            set sc = ##class(%Wallet.Collection).Create(..#WALLET, {"UseResource": (..#SECRETRESOURCE), "EditResource": (..#SECRETRESOURCE)})
            write "4b. wallet ", ..#WALLET, ": ", $select(sc: "created", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
        } else {
            write "4b. wallet ", ..#WALLET, ": exists", !
        }

        // The KEY IS WRITTEN EVERY BOOT when the variable is set, so rotating it is
        // "change the env var and restart" rather than a manual wallet edit. That is deliberate:
        // a rotation that needs a documented interactive procedure is a rotation that does not
        // happen. Never printed -- only whether it was stored.
        set sc = ##class(%Wallet.KeyValue).Create(..#WALLETENTRY, {"Usage": "CUSTOM", "Secret": {"apikey": (key)}})
        if $$$ISERR(sc) {
            // ALREADY PRESENT. Rewrite it -- but NOT by deleting first (@kskubach, #106).
            //
            // `Delete` then `Create` turns a *stale* key into *no* key when the second call fails,
            // and this runs on every boot from FirstBoot, so one transient failure takes out a demo
            // that was working. The old value is captured first and restored if the rewrite fails,
            // so the worst case is the key the instance already had.
            // GetSecretValue(name), NOT %OpenId(...).Secret. `Secret` is transient=1, so a
            // reopened entry reports it as "" -- verified: GetSecretValue returns 180 chars for the
            // same entry whose .Secret reads 0. The earlier version captured .Secret, so `previous`
            // was always empty, the restore guard below could never fire, and the comment claiming
            // the old value was preserved was false (@kskubach, #106). An inert safety net is worse
            // than none, because it stops anyone looking.
            set previous = ""
            try {
                set previous = ##class(%Wallet.KeyValue).GetSecretValue(..#WALLETENTRY)
            } catch {
                set previous = ""
            }
            do ##class(%Wallet.KeyValue).Delete(..#WALLETENTRY)
            set sc = ##class(%Wallet.KeyValue).Create(..#WALLETENTRY, {"Usage": "CUSTOM", "Secret": {"apikey": (key)}})
            if $$$ISERR(sc), previous '= "" {
                // Put back what was there. Reported, because a boot that silently reverted to an
                // older key would present as the provider rejecting a good one.
                do ##class(%Wallet.KeyValue).Delete(..#WALLETENTRY)
                // `previous` is the STORED shape -- the JSON object GetSecretValue returns, e.g.
                // {"apikey":"..."} -- so it is passed through as Secret rather than re-wrapped.
                // Double-wrapping would restore a secret whose apikey is itself a JSON string, and
                // the URI would then resolve to something that looks like a key and is not.
                set restore = ##class(%Wallet.KeyValue).Create(..#WALLETENTRY, {"Usage": "CUSTOM", "Secret": (previous)})
                write "4b. wallet entry rewrite FAILED; previous value ",
                    $select(restore: "restored", 1: "COULD NOT BE RESTORED"), !
            }
        }
        write "4b. wallet entry ", ..#WALLETENTRY, ": ", $select(sc: "stored (" _ $length(key) _ " chars, not logged)", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
        if $$$ISERR(sc) {
            quit
        }

        // The ConfigStore entry, holding the secret:// URI rather than the key.
        set cfg = {"model_provider": (..#PROVIDER), "model": (model), "api_key": ("secret://" _ ..#WALLETENTRY _ "#apikey")}
        set sc = ##class(%ConfigStore.Configuration).Create("AI", "LLM", "", "pgdetective", cfg)
        if $$$ISERR(sc) {
            // Already present: replace, so a PG_LLM_MODEL change takes effect. Same restore-on-
            // failure discipline as the wallet entry above -- this config is what BuildAgent reads,
            // so losing it disables AI Detective entirely.
            // Get(fqn, .config) -- a DOTTED name and an output, not the four positional arguments
            // Create() takes. Passing Create's shape throws <PARAMETER> at runtime while compiling
            // cleanly, and the catch turned that into "LLM provider: FAILED" on a boot where the
            // config had in fact been written. Read from the compiled FormalSpec rather than
            // assumed symmetrical with Create.
            set previousCfg = ""
            do ##class(%ConfigStore.Configuration).Get("AI.LLM.pgdetective", .previousCfg)
            do ##class(%ConfigStore.Configuration).Delete("AI.LLM.pgdetective")
            set sc = ##class(%ConfigStore.Configuration).Create("AI", "LLM", "", "pgdetective", cfg)
            if $$$ISERR(sc), $isobject(previousCfg) {
                do ##class(%ConfigStore.Configuration).Delete("AI.LLM.pgdetective")
                set restoreCfg = ##class(%ConfigStore.Configuration).Create("AI", "LLM", "", "pgdetective", previousCfg)
                write "4b. config rewrite FAILED; previous value ",
                    $select(restoreCfg: "restored", 1: "COULD NOT BE RESTORED"), !
            }
        }
        write "4b. config AI.LLM.pgdetective: ", $select(sc: "created, model = " _ model, 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
    } catch ex {
        write "4b. LLM provider: FAILED ", ex.DisplayString(), !
    }
    quit $$$OK
}

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
/// THE COUNT IS THE TEST. `Tools.Read`, `Tools.Activity` and `Tools.Resolve` all warn that every
/// public ClassMethod becomes an LLM-callable tool, so an unexpected name here means a helper was
/// left public -- and for `Tools.Resolve` an extra name is a second way to mutate a live production.
/// Printed on every setup run so the regression is visible at boot rather than in a review.
ClassMethod ReportTools()
{
    // TWELVE since the chat assistant gained the event log, from ten. `Tools.EventLog` adds two read
    // tools over `Ens_Util.Log` -- GetEventLogSummary and GetEventLogTrend (mcp-tools.md §3.10-3.11).
    // Before that it was ten, from seven, when `Tools.Activity` added three over
    // `Ens_Activity_Data.{Seconds,Hours,Days}` (§3.7-3.9).
    //
    // Moved DELIBERATELY and with the tool list read back, which is the discipline the bump to 7
    // established: the guard's whole value is that an unexpected count is loud, and bumping it without
    // reading the names would defeat it. Read back on the first compile of each bump -- `Tools.Activity`
    // discovered exactly three, `Tools.EventLog` exactly two, so eleven reads plus one write and no
    // helper left public. Both classes keep their helpers `[ Private ]`, which is what holds the count
    // down: `Tools.EventLog` has nine of them and would otherwise discover eleven.
    //
    // `Tools.ErrorCatalogue` AND `Tools.HostRoster` ARE DELIBERATELY ABSENT FROM THIS LIST, and that is
    // not an oversight. Between them they hold four methods that used to be private on `Tools.Read` and
    // `Tools.Activity`, made public so `Tools.EventLog` could share them rather than copy them -- and
    // neither extends `%AI.Tool`, so `%AI.ToolMgr.FindTools`'s `$$issubclassof` filter cannot see them.
    // Verified rather than assumed: `%IsA("%AI.Tool")` on `Tools.ErrorCatalogue` returns 0, and the
    // count read back as 12 after `Tools.HostRoster` landed with two public methods. Listing either here
    // would call `%Discover()` on a class that has no such method.
    set expected = 12
    set found = 0
    // EVERY TOOL CLASS IS LISTED HERE, not only registered in Governance. A tool class the count does
    // not cover is a class whose accidental extra method nothing catches at boot -- which is the one
    // thing this method exists to prevent.
    for class = "ProductionGuardian.LabDemo.Tools.Read", "ProductionGuardian.LabDemo.Tools.Activity", "ProductionGuardian.LabDemo.Tools.EventLog", "ProductionGuardian.LabDemo.Tools.Resolve" {
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
