/// One call that takes a bare LABDEMO namespace to a running production.
///
///   do ##class(ProductionGuardian.Setup.FirstBoot).Run()
///
/// Every step here was performed BY HAND on the #34/#53 deploy, and three of them were
/// discovered only because the production failed on first start:
///
///   - the two HL7 drop directories did not exist, so EMR Source went straight to Error
///     with `#5021: Directory '/tmp/labdemo/hl7-archive/' does not exist`
///   - only ONE of the two web applications was registered, so Cloud API POSTed into a
///     404 while both upstream hosts looked perfectly healthy
///   - no credential existed, so the REST app answered 403 through the web gateway even
///     though /labdemo permits unauthenticated access locally
///
/// None of that is in `README.md`'s original setup section, and none of it is discoverable
/// from the code. This class exists so that knowledge survives the person who typed it
/// (#70, #72) -- it is the prerequisite for containerising the chain, and it is useful on
/// its own for anyone standing the demo up on a second machine.
///
/// IDEMPOTENT. Every step checks before acting and reports what it found, so re-running
/// after a partial failure is safe and says what it skipped.
///
/// VERIFIED ONLY AGAINST AN ALREADY-CONFIGURED INSTANCE, which is the only state we have --
/// every step reported "exists" and changed nothing. The FRESH-namespace path, where each
/// step actually creates something, cannot be exercised until there is a second environment
/// (#70, #72). Treat the create branches as unproven until then.
///
/// WHAT IT DOES NOT DO. It does not create the namespace or enable interop -- that is
/// `%Library.EnsembleMgr.EnableNamespace`, it takes minutes, and it has its own failure
/// modes (a dropped connection mid-call is the config activating, not an error). Run that
/// first; this class checks and refuses if the namespace is not interop-enabled.
Class ProductionGuardian.Setup.FirstBoot
{

Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// Where the HL7 generator drops files and where the service archives them. These must
/// match the FilePath/ArchivePath settings in Production.cls.
Parameter DROPDIR = "/tmp/labdemo/hl7-in/";

Parameter ARCHIVEDIR = "/tmp/labdemo/hl7-archive/";

/// The Ensemble credential Cloud API uses to POST to the REST app.
Parameter CREDENTIAL = "LabDemoREST";

/// Stand the whole thing up. `pSourceDir` is where the .cls files live, as seen from
/// inside IRIS; pass "" to skip compilation if the classes are already loaded.
ClassMethod Run(pSourceDir As %String = "", pStartGenerator As %Boolean = 1) As %Status
{
    write "ProductionGuardian first-boot setup", !
    write "==================================", !, !

    set sc = ..CheckNamespace()
    if $$$ISERR(sc) {
        quit sc
    }

    if pSourceDir '= "" {
        set sc = ..LoadClasses(pSourceDir)
        if $$$ISERR(sc) {
            quit sc
        }
    } else {
        write "2. classes: skipped (no source dir given)", !
    }

    do ..MakeDirectories()
    do ..RegisterWebApps()
    do ..ClearPasswordChangeFlag()
    do ..CreateCredential()

    set sc = ..EnableMetrics()
    if $$$ISERR(sc) {
        quit sc
    }

    set sc = ..ApplyDeploymentSettings()
    if $$$ISERR(sc) {
        quit sc
    }

    set sc = ..StartProduction()
    if $$$ISERR(sc) {
        quit sc
    }

    if pStartGenerator {
        do ..StartGenerator()
    }

    write !, "==================================", !
    write "Done. Verify with:", !
    write "  do ##class(ProductionGuardian.LabDemo.Triggers).Status()", !
    write "  do ##class(ProductionGuardian.Setup.EnableMetrics).Verify()", !
    quit $$$OK
}

/// Refuse unless this namespace is interop-enabled. IsEnsembleNamespace is the real test
/// -- the CPF `Interop` property reads 0 even on a known-good interop namespace.
ClassMethod CheckNamespace() As %Status
{
    set ns = $namespace
    set enabled = ##class(%Library.EnsembleMgr).IsEnsembleNamespace(ns)
    write "1. namespace ", ns, ": interop ", $select(enabled: "enabled", 1: "NOT ENABLED"), !
    if 'enabled {
        write "   Run %Library.EnsembleMgr.EnableNamespace(""", ns, """, 1) first.", !
        write "   That takes minutes and can drop the connection mid-call, which is the", !
        write "   config activating rather than a failure -- re-check state before retrying.", !
        quit $$$ERROR($$$GeneralError, ns _ " is not interop-enabled")
    }
    quit $$$OK
}

/// Compile every .cls under the source directory. `ck` and recurse, matching README §2.
ClassMethod LoadClasses(pSourceDir As %String) As %Status
{
    set sc = $system.OBJ.LoadDir(pSourceDir, "ck", .errorlog, 1)
    write "2. classes from ", pSourceDir, ": ", $select(sc: "compiled", 1: "FAILED"), !
    if $$$ISERR(sc) {
        write "   ", $system.Status.GetErrorText(sc), !
    }
    quit sc
}

/// The two HL7 directories. EMR Source is an EnsLib.HL7.Service.FileService and goes to
/// Error without them -- the first thing that broke on the #53 deploy.
ClassMethod MakeDirectories()
{
    for dir = ..#DROPDIR, ..#ARCHIVEDIR {
        if ##class(%File).DirectoryExists(dir) {
            write "3. dir ", dir, ": exists", !
        } else {
            do ##class(%File).CreateDirectoryChain(dir)
            write "3. dir ", dir, ": ", $select(##class(%File).DirectoryExists(dir): "created", 1: "COULD NOT CREATE"), !
        }
    }
}

/// BOTH web applications. Registering only /labdemo/monitor -- which is what had happened
/// on the instance -- leaves Cloud API POSTing into a 404 while EMR Source and Lab Router
/// look healthy, so nothing points at the cause.
///
/// AutheEnabled 96 is unauthenticated(32) OR password(64), so both work. Through an
/// external web gateway an unauthenticated GET is refused with 403 regardless, which is
/// why the credential below is not optional.
ClassMethod RegisterWebApps()
{
    set apps("/labdemo") = "ProductionGuardian.LabDemo.REST.PatientDispatcher"
    set apps("/labdemo/monitor") = "ProductionGuardian.LabDemo.REST.HostStatusDispatcher"
    set ns = $namespace

    new $namespace
    set $namespace = "%SYS"
    set path = ""
    for {
        set path = $order(apps(path), 1, dispatch)
        quit:path=""
        if ##class(Security.Applications).Exists(path) {
            write "4. web app ", path, ": exists", !
            continue
        }
        kill props
        set props("NameSpace") = ns
        set props("DispatchClass") = dispatch
        set props("AutheEnabled") = 96
        set props("Enabled") = 1
        set props("Description") = "Production Guardian LABDEMO (FirstBoot)"
        set sc = ##class(Security.Applications).Create(path, .props)
        write "4. web app ", path, ": ", $select(sc: "created", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
    }
}

/// Clear the "must change password on next login" flag on the account the proxy polls with.
///
/// A FRESH container ships `superuser` with ChangePassword=1, and IRIS then refuses REST
/// authentication until the password has been changed interactively -- so every request to
/// /labdemo/monitor/hoststatus comes back 401 no matter which credential is presented, even
/// the correct one. The verified demo instance has ChangePassword=0 only because somebody
/// changed it by hand months ago, which is exactly the kind of undocumented manual step this
/// class exists to capture (#73).
///
/// WHY IT LOOKS LIKE SOMETHING ELSE. The failure is partial in a very misleading way:
/// /api/monitor/metrics answers 200 UNAUTHENTICATED (it is served at the web server root,
/// where the %All-less monitor role suffices), so metrics flow, the proxy reports healthy,
/// the dashboard shows three hosts -- and only `queued` and `errored` are null, because
/// those two come from the one endpoint that needs a login. The visible symptom is a missing
/// FIELD, which reads as a parser or contract problem rather than an auth one. Found on the
/// first clean compose run; the 401 is in the proxy log, but the proxy correctly degrades
/// instead of failing, so nothing upstream goes red.
///
/// Do not misread this as an AutheEnabled problem. Both web applications are 96
/// (unauthenticated OR password) and that is correct; an unauthenticated GET through an
/// external gateway is refused regardless, which is why the credential exists at all. I
/// changed /labdemo/monitor to 32 while diagnosing this and it made no difference -- the
/// working instance returns 401 without auth too. The password flag was the whole story.
ClassMethod ClearPasswordChangeFlag()
{
    set user = $get(^ProductionGuardian.Setup("CredUser"), "superuser")
    set pass = $get(^ProductionGuardian.Setup("CredPass"), "SYS")

    new $namespace
    set $namespace = "%SYS"

    if '##class(Security.Users).Exists(user) {
        write "4b. user ", user, ": DOES NOT EXIST -- cannot clear password flag", !
        quit
    }
    do ##class(Security.Users).Get(user, .props)
    if +$get(props("ChangePassword")) = 0 {
        write "4b. user ", user, ": password flag already clear", !
        quit
    }
    // Setting Password alongside ChangePassword=0 is required: clearing the flag on its own
    // leaves the account in a state IRIS still treats as needing a change.
    kill p
    set p("Password") = pass
    set p("ChangePassword") = 0
    set sc = ##class(Security.Users).Modify(user, .p)
    write "4b. user ", user, ": ", $select(sc: "password flag cleared", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
}

/// The credential Cloud API POSTs with. Through an external gateway the REST app answers
/// 403 without it -- verified both ways on #53: 403 without, 200 {"count":0} with.
///
/// Username/password are overridable by global so this class carries no secret. Defaults
/// match the verified demo instance.
ClassMethod CreateCredential()
{
    if ##class(Ens.Config.Credentials).%ExistsId(..#CREDENTIAL) {
        write "5. credential ", ..#CREDENTIAL, ": exists", !
        quit
    }
    set user = $get(^ProductionGuardian.Setup("CredUser"), "superuser")
    set pass = $get(^ProductionGuardian.Setup("CredPass"), "SYS")
    set sc = ##class(Ens.Config.Credentials).SetCredential(..#CREDENTIAL, user, pass, 1)
    write "5. credential ", ..#CREDENTIAL, ": ", $select(sc: "created for " _ user, 1: "FAILED"), !
}

/// SAM export + per-production statistics. Delegates rather than restating -- EnableMetrics
/// already handles both and reports what it found.
ClassMethod EnableMetrics() As %Status
{
    write "6. interop metrics:", !
    // Pass OUR production name explicitly. This runs before StartProduction, so the active
    // production is still the image's own LABDEMOPKG.FoundationProduction -- letting the
    // check default to "whatever is running" made it inspect that one and print an ACTION
    // REQUIRED for an item Production.cls already contains (@tanifgit, #78).
    quit ##class(ProductionGuardian.Setup.EnableMetrics).Run(..#PRODUCTION)
}

/// Apply the three settings that depend on the deployment, from overridable globals.
///
/// `Production.cls` ships `webgateway-webinar:80`, which is the verified instance's web
/// gateway CONTAINER NAME -- correct there and meaningless anywhere else. #72 asks for that
/// literal to become a compose service name; this is the mechanism that makes it settable
/// without editing the production, and it is what a container's first boot would call.
///
///   set ^ProductionGuardian.Setup("HTTPServer") = "webgateway"
///   set ^ProductionGuardian.Setup("HTTPPort")   = 80
///
/// Absent globals leave the shipped values alone, so this is a no-op on the verified
/// instance -- deliberately, because silently rewriting a working deployment is the defect
/// Reset() had in #66.
ClassMethod ApplyDeploymentSettings() As %Status
{
    set server = $get(^ProductionGuardian.Setup("HTTPServer"), "")
    set port = $get(^ProductionGuardian.Setup("HTTPPort"), "")
    if (server = "") && (port = "") {
        write "6b. deployment settings: none set, keeping Production.cls values", !
        quit $$$OK
    }
    // Triggers.#OPERATION rather than a second copy of "Cloud API". That parameter exists
    // precisely so the name lives in one place (root CLAUDE.md §5), and re-copying it here
    // would matter more than usual: see the status check below.
    set item = ##class(ProductionGuardian.LabDemo.Triggers).#OPERATION

    // CHECK THE STATUS. Calling SetSetting with `do` discarded it, so the
    // no-such-config-item error added in #66 went unreported -- a rename of the operation
    // would leave a container's first boot silently misconfigured against the wrong web
    // gateway, which is the failure this whole class exists to prevent. Verified: the error
    // is returned and `do` swallows it (@tanifgit, #73).
    if server '= "" {
        set sc = ##class(ProductionGuardian.LabDemo.Triggers).SetSetting(item, "Adapter", "HTTPServer", server)
        if $$$ISERR(sc) {
            write "6b. HTTPServer FAILED: ", $system.Status.GetErrorText(sc), !
            quit sc
        }
        write "6b. HTTPServer -> ", server, !
    }
    if port '= "" {
        set sc = ##class(ProductionGuardian.LabDemo.Triggers).SetSetting(item, "Adapter", "HTTPPort", port)
        if $$$ISERR(sc) {
            write "6b. HTTPPort FAILED: ", $system.Status.GetErrorText(sc), !
            quit sc
        }
        write "6b. HTTPPort   -> ", port, !
    }
    quit $$$OK
}

/// Start the production, or report it already running. Refuses to switch a DIFFERENT
/// production out from under itself -- that is the #34 mistake in reverse.
ClassMethod StartProduction() As %Status
{
    do ##class(Ens.Director).GetProductionStatus(.running, .state)
    if (running = ..#PRODUCTION) && (state = 1) {
        write "7. production ", ..#PRODUCTION, ": already running", !
        quit $$$OK
    }
    if (running '= "") && (running '= ..#PRODUCTION) {
        write "7. production: '", running, "' is running, NOT ", ..#PRODUCTION, !
        write "   Refusing to stop another production. Stop it deliberately first.", !
        quit $$$ERROR($$$GeneralError, "a different production is running: " _ running)
    }
    set sc = ##class(Ens.Director).StartProduction(..#PRODUCTION)

    // A CONTAINER STOP IS NOT A CLEAN SHUTDOWN. `docker stop` / `compose stop` / a host
    // reboot kills IRIS with the production still running, and the next start then refuses:
    //
    //   ERROR <Ens>ErrProductionNotShutdownCleanly: Production '...' was not shutdown cleanly
    //
    // CleanProduction() clears that state and is the documented recovery. Retrying once here
    // rather than reporting the error is deliberate: for a containerised demo an unclean stop
    // is the NORMAL case, not an exception worth a human decision, and the alternative is a
    // stack that comes up dead every second time it is started with no hosts and no findings.
    // Only reached on that specific failure -- any other error still surfaces.
    if $$$ISERR(sc), $system.Status.GetErrorText(sc) [ "NotShutdownCleanly" {
        write "7. production: previous run did not shut down cleanly, cleaning...", !
        set clean = ##class(Ens.Director).CleanProduction()
        if $$$ISERR(clean) {
            write "7. CleanProduction FAILED: ", $system.Status.GetErrorText(clean), !
            quit clean
        }
        set sc = ##class(Ens.Director).StartProduction(..#PRODUCTION)
    }

    write "7. production ", ..#PRODUCTION, ": ", $select(sc: "started", 1: "FAILED " _ $system.Status.GetErrorText(sc)), !
    quit sc
}

/// Background HL7 traffic, so baselines warm and the dashboard is not empty. Not required
/// for the production to be healthy, which is why Run() takes a flag.
ClassMethod StartGenerator(pIntervalSeconds As %Integer = 2)
{
    job ##class(ProductionGuardian.LabDemo.HL7Generator).RunContinuous(pIntervalSeconds)
    write "8. HL7 generator: started, one message every ", pIntervalSeconds, "s", !
    write "   Baselines need minBaselineSamples x POLL_INTERVAL_MS -- about a minute at", !
    write "   the shipped 5s engine poll -- before comparative rules can fire.", !
}

}
