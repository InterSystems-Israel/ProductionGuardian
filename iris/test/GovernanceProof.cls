/// Proof that the MVP 2 governance boundary refuses — run against a live instance.
///
/// `contracts/resolve-api.md` §9.4 and `mcp-tools.md` §5.6(b) both make the acceptance criterion **an
/// observed denial**, not a passing allow: "a policy never seen to deny is not known to be enforcing
/// anything." This class is how that observation is made repeatable instead of remembered.
///
/// WHY A REAL USER AND NOT `StubPolicy`. `iris/test/StubPolicy.cls` injects a resource set, which
/// proves the policy's LOGIC branches correctly but cannot prove the boundary holds, because
/// `$SYSTEM.Security.Check` returns 1 for every resource -- including resources that do not exist --
/// when the caller holds `%All`. Every session that can compile this code holds `%All`. So the only
/// way to see a genuine refusal is to become a principal that genuinely lacks the privilege, and
/// that means a real user, a real login, and a real `PG_Resolve` resource to not hold.
///
/// TWO PROCESSES, NECESSARILY. `$SYSTEM.Security.Login` cannot be undone -- there is no way back to
/// `%All` without that account's password -- so the login must happen in a process that is about to
/// end. `Prove()` therefore does the privileged half (create the user, run the allowed calls) and
/// `AsReadOnlyUser()` is meant to be the LAST thing a throwaway session does. `Cleanup()` removes the
/// user afterwards from a fresh privileged session.
///
/// THE PASSWORD IS GENERATED, NEVER STORED. It is created, used within the same call chain, and
/// discarded with the user. Nothing here is a credential the repository knows -- root `CLAUDE.md` §6
/// and MVP 2 §6's credential-exposure row both apply to a test fixture exactly as much as to the LLM
/// key, and a default test password in source is how one ends up on a demo instance permanently.
Class ProductionGuardian.Test.GovernanceProof
{

/// The throwaway principal. Named so it is obviously not a demo account.
Parameter PROBEUSER = "pg_proof_readonly";

/// Create the read-only principal, then report what a privileged caller can do.
///
/// Returns the generated password so the caller can hand it to the second session. Printed, because
/// it is worthless the moment `Cleanup()` runs and the alternative is a fixture nobody can drive.
ClassMethod Prove() As %String
{
    write "MVP 2 governance proof -- privileged half", !
    write "========================================", !, !

    set pass = ..MakePassword()
    set sc = ..CreateProbeUser(pass)
    if $$$ISERR(sc) {
        write "could not create ", ..#PROBEUSER, ": ", $system.Status.GetErrorText(sc), !
        quit ""
    }
    // The roles must be right before the user is created, or the proof measures a stale boundary.
    // Converging them here rather than assuming AIHub.Run() was called makes the fixture
    // self-sufficient -- @Ari-Glikman's run failed because the roles on his instance predated the
    // definition this class expects, which is a fixture problem rather than his.
    do ##class(ProductionGuardian.Setup.AIHub).CreateResources()
    do ##class(ProductionGuardian.Setup.AIHub).CreateRoles()

    // PRECONDITION, CHECKED ON THIS SIDE because the other side cannot check it -- see the comment in
    // AsReadOnlyUser. A principal without the database role dies with <PROTECT> before any policy is
    // consulted, and that output reads like the boundary working. Refusing here is what stops an
    // inconclusive run from being reported as a pass.
    set granted = ..ProbeUserRoles()
    if '..HasRole(granted, ##class(ProductionGuardian.Setup.AIHub).#DBROLE) {
        write "   probe user roles are '", granted, "' -- missing ",
            ##class(ProductionGuardian.Setup.AIHub).#DBROLE, !
        write "   Refusing to continue: without it the proof dies at <PROTECT> before the", !
        write "   tool policy is reached, and that looks like a successful denial.", !
        quit ""
    }
    write "1. probe user ", ..#PROBEUSER, ": ready, holds ", granted, !
    write "   (", ##class(ProductionGuardian.Setup.AIHub).#READROLE, " grants ",
        ##class(ProductionGuardian.Setup.AIHub).#READRESOURCE, ":U and NOT ",
        ##class(ProductionGuardian.Setup.AIHub).#WRITERESOURCE, ")", !

    // The privileged calls, through the governed manager. Both must be audited.
    set before = ##class(ProductionGuardian.Setup.AIHub).AuditCount()
    set r1 = ##class(ProductionGuardian.LabDemo.Tools.Governance).Invoke("GetPoolSize", {"host": "Cloud API"})
    write "2. GetPoolSize as ", $username, ": ", r1.outcome, ", auditId = ", r1.auditId, !
    set r2 = ##class(ProductionGuardian.LabDemo.Tools.Governance).Invoke("SetPoolSize", {"host": "Cloud API", "size": 4, "dryRun": 1})
    write "3. SetPoolSize dry-run as ", $username, ": ", r2.outcome, ", auditId = ", r2.auditId, !
    set after = ##class(ProductionGuardian.Setup.AIHub).AuditCount()
    write "4. audit rows written by those two calls: ", (after - before), " (expected 2)", !

    write !, "Now run, in a SEPARATE session (the login cannot be undone):", !
    write "  do ##class(ProductionGuardian.Test.GovernanceProof).AsReadOnlyUser(""", pass, """)", !
    write "Then, from a privileged session:", !
    write "  do ##class(ProductionGuardian.Test.GovernanceProof).Cleanup()", !
    quit pass
}

/// Become the read-only principal and attempt the write. THE LAST THING A SESSION SHOULD DO.
///
/// EXPECTS A REFUSAL. A success here is not a passing test -- it means the boundary is not there,
/// and the message says so rather than leaving a reader to interpret an outcome string.
ClassMethod AsReadOnlyUser(pPassword As %String) As %Status
{
    write "MVP 2 governance proof -- unprivileged half", !
    write "==========================================", !, !

    set sc = $system.Security.Login(..#PROBEUSER, pPassword)
    if 'sc {
        write "login as ", ..#PROBEUSER, " FAILED -- cannot prove anything", !
        quit $$$ERROR($$$GeneralError, "login failed")
    }
    write "1. logged in as ", $username, ", roles = ", $roles, !

    // A read must still work: the demo's point is that AI Detective can LOOK without acting. A
    // failed read ABORTS rather than continuing to a "denied" that would prove nothing.
    //
    // THIS GUARD DOES NOT CATCH THE CASE @Ari-Glikman HIT, and I checked rather than assumed it did.
    // With the principal short of database access, `Invoke` dies at
    // `<PROTECT> ... Governance.1  Access Denied` while paging in the routine -- the process is gone
    // before `r1` is ever assigned, so nothing below this line runs. His option 2, "assert the tool
    // call was reached", is not implementable from inside the unprivileged half for that reason.
    //
    // So the real protection is the PRIVILEGED side: `Prove()` verifies the probe user holds the
    // database role before it hands over a password, and refuses otherwise. This guard stays because
    // it still catches the failures that DO return -- a misconfigured resource, a tool error, a policy
    // that refuses the read -- and those are the ones that would otherwise reach a meaningless PASS.
    set r1 = ##class(ProductionGuardian.LabDemo.Tools.Governance).Invoke("GetPoolSize", {"host": "Cloud API"})
    write "2. GetPoolSize : ", r1.outcome, "  <- expected executed", !
    if r1.outcome '= "executed" {
        write "   *** ABORTING: a ", ##class(ProductionGuardian.Setup.AIHub).#READROLE, " holder must be able to read.", !
        write "   error: ", r1.error, !
        write "   If this is <PROTECT>/Access Denied, the principal is short of database", !
        write "   access and the TOOL POLICY WAS NEVER REACHED -- so a refusal below would", !
        write "   prove nothing. Grant ", ##class(ProductionGuardian.Setup.AIHub).#DBROLE, " to the user.", !
        quit $$$ERROR($$$GeneralError, "read failed before the policy was reached -- proof inconclusive")
    }

    // And the write must be refused.
    set r2 = ##class(ProductionGuardian.LabDemo.Tools.Governance).Invoke("SetPoolSize", {"host": "Cloud API", "size": 4, "dryRun": 1})
    write "3. SetPoolSize : ", r2.outcome, "  <- expected denied", !
    write "   error   : ", r2.error, !
    write "   auditId : ", r2.auditId, !
    if r2.outcome '= "denied" {
        write "   *** THE BOUNDARY DID NOT HOLD. A caller without PG_Resolve applied a", !
        write "   *** production change. This is the failure resolve-api.md 9.4 exists to catch.", !
        quit $$$ERROR($$$GeneralError, "write tool was not refused")
    }

    // The denial must be IN THE LOG. The runtime cannot audit it -- ExecuteTool throws before the
    // audit hook -- so this is what proves Tools.AuthPolicy wrote the row itself.
    set desc = ##class(ProductionGuardian.LabDemo.Audit.Entry).Describe(r2.auditId)
    if '$isobject(desc) {
        write "4. audit row for the denial: MISSING -- the refusal left no trace", !
        quit $$$ERROR($$$GeneralError, "denial was not audited")
    }
    write "4. audit row for the denial: ", desc.%ToJSON(), !
    write !, "PASS: read allowed, write refused, refusal audited.", !
    quit $$$OK
}

/// Remove the probe user. Safe to call when it does not exist.
ClassMethod Cleanup() As %Status
{
    new $namespace
    set $namespace = "%SYS"
    if '##class(Security.Users).Exists(..#PROBEUSER) {
        write "probe user ", ..#PROBEUSER, ": already gone", !
        quit $$$OK
    }
    set sc = ##class(Security.Users).Delete(..#PROBEUSER)
    write "probe user ", ..#PROBEUSER, ": ", $select(sc: "deleted", 1: "DELETE FAILED " _ $system.Status.GetErrorText(sc)), !
    quit sc
}

/// Create the probe user holding Guardian_Read and nothing else.
///
/// `ChangePassword` MUST be 0. A fresh account defaults to "must change password on next login" and
/// IRIS then refuses authentication until it has been changed interactively -- #73 spent real time on
/// exactly that flag, from the other direction.
ClassMethod CreateProbeUser(pPassword As %String) As %Status [ Private ]
{
    // RESOLVED BEFORE THE NAMESPACE SWITCH. `##class(...).#READROLE` is a runtime class reference,
    // and `ProductionGuardian.Setup.AIHub` does not exist in %SYS -- reading it after the switch
    // throws <CLASS DOES NOT EXIST> from a line that looks like a compile-time constant. Cost
    // one run to find; worth a comment so it is not reintroduced.
    //
    // TWO ROLES, and the second one is not ours. `Guardian_Read` grants `PG_Read:U` and deliberately
    // nothing else (see `Setup.AIHub.#DBROLE`), so the probe user needs the shipped `%DB_%DEFAULT`
    // role as well or it cannot read the routine implementing the tool. Granting it to the USER
    // rather than to `Guardian_Read` is @Ari-Glikman's #94 review call: the role stays minimal and
    // means one thing, and the fixture carries its own plumbing instead of widening a boundary.
    set role = ##class(ProductionGuardian.Setup.AIHub).#READROLE _ "," _ ##class(ProductionGuardian.Setup.AIHub).#DBROLE

    new $namespace
    set $namespace = "%SYS"
    if ##class(Security.Users).Exists(..#PROBEUSER) {
        // Reset the password rather than reuse an unknown one: a leftover user from an interrupted
        // run has a password this process cannot know.
        kill props
        set props("Password") = pPassword
        set props("ChangePassword") = 0
        set props("Roles") = role
        quit ##class(Security.Users).Modify(..#PROBEUSER, .props)
    }
    quit ##class(Security.Users).Create(
        ..#PROBEUSER,
        role,
        pPassword,
        "Production Guardian governance proof (throwaway)",
        "LABDEMO",
        ,
        ,
        0,
        1)
}

/// The probe user's granted roles, as IRIS records them. "" if the user is absent.
ClassMethod ProbeUserRoles() As %String [ Private ]
{
    new $namespace
    set $namespace = "%SYS"
    if '##class(Security.Users).Exists(..#PROBEUSER) {
        quit ""
    }
    do ##class(Security.Users).Get(..#PROBEUSER, .props)
    quit $get(props("Roles"))
}

/// Is `role` one of the comma-separated `list`? Private.
///
/// EXACT ELEMENT MATCH, not `[`. A substring test would accept `Guardian_ReadOnly` as
/// `Guardian_Read`, and would also match `%DB_%DEFAULT` inside a hypothetical `%DB_%DEFAULTX` --
/// the same class of bug as the quoted-label match in `Tools.Read.ScrapeGauge`.
ClassMethod HasRole(list As %String, role As %String) As %Boolean [ Private ]
{
    // Explicit result variable: a bare `quit` breaks the FOR and leaves the loop index pointing at
    // whatever was examined last, matched or not -- the mistake `Tools.Read.FindItem` documents.
    set found = 0
    for i = 1:1:$length(list, ",") {
        if $zstrip($piece(list, ",", i), "<>W") = role {
            set found = 1
            quit
        }
    }
    quit found
}

/// A random password. Not stored, not derived from anything guessable.
ClassMethod MakePassword() As %String [ Private ]
{
    set out = "Pg"
    for i = 1:1:18 {
        // Letters and digits only: the point is a value nobody has to escape through a session
        // heredoc, not maximum entropy for an account that exists for one minute.
        set n = $random(62)
        set out = out _ $case(n < 26, 1: $char(65 + n), : $select(n < 52: $char(97 + n - 26), 1: $char(48 + n - 52)))
    }
    quit out
}

}
