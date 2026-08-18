/// Test double for AuthPolicy: replaces the IRIS resource check with an injectable set.
///
/// WHY THIS EXISTS. AuthPolicy's only input is $SYSTEM.Security.Check, and every session that can
/// compile and run code here holds %All -- which makes Check return 1 for EVERY resource, including
/// ones that do not exist. So the deny branch is unreachable from a privileged session, and
/// "observe a denial" cannot be satisfied by calling the real policy as superuser.
///
/// Creating an unprivileged user instead needs %DB_* resources that do not exist on this instance
/// and a working REST path for that user -- several steps of RBAC plumbing to test three lines of
/// branching. Overriding the one seam is the smaller, more direct instrument.
///
/// WHAT THIS DOES NOT PROVE, stated so nobody reads more into it: that $SYSTEM.Security.Check
/// returns 0 for a user lacking the resource. That is IRIS's behaviour, not ours. What it proves is
/// that OUR policy denies when the check says no, which is the part we wrote and the part that
/// could be wrong.
Class ProductionGuardian.Test.StubPolicy Extends ProductionGuardian.LabDemo.Tools.AuthPolicy
{

/// Comma-separated resources this fake caller "holds".
Property Granted As %String;

Method HasResource(resource As %String) As %Boolean [ Private ]
{
    quit ''(("," _ ..Granted _ ",") [ ("," _ resource _ ","))
}

}
