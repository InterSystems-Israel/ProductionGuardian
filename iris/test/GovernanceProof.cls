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
    write "1. probe user ", ..#PROBEUSER, ": ready, holds Guardian_Read only", !

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

    // A read must still work: the demo's point is that AI Detective can LOOK without acting.
    set r1 = ##class(ProductionGuardian.LabDemo.Tools.Governance).Invoke("GetPoolSize", {"host": "Cloud API"})
    write "2. GetPoolSize : ", r1.outcome, "  <- expected executed", !
    if r1.outcome '= "executed" {
        write "   UNEXPECTED: a Guardian_Read holder must be able to read.", !
        write "   error: ", r1.error, !
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
    set role = ##class(ProductionGuardian.Setup.AIHub).#READROLE

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
