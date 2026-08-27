/// Which host names are the production's own application config items — one copy, shared by every
/// tool that reports a host name it did not receive from the caller.
///
/// THE QUESTION THIS ANSWERS. `Ens_Activity_Data` and `Ens_Util.Log` both record rows against hosts
/// that are not application components: `Ens.MonitorService`, `Ens.ScheduleHandler`, `Ens.Actor` and
/// `Ens.Alarm` are framework services the interop framework runs itself, and
/// `Ens.Activity.Operation.Local` IS a config item while `iris/CLAUDE.md` §3 states it is not an
/// application host. A tool that groups by host therefore returns names the dashboard never shows, and
/// a model given them cannot tell framework bookkeeping from a production fault.
///
/// Both methods were `[ Private ]` on `Tools.Activity` until `Tools.EventLog` needed the same answer.
/// They moved here rather than being copied, and the reason is the one root `CLAUDE.md` §6 gives for
/// the host list itself: a rule about which hosts are real, held in two places, is a rule that goes
/// stale in one of them. `Tools.ErrorCatalogue` is the precedent and the argument is identical.
///
/// IT ASKS THE PRODUCTION RATHER THAN CARRYING A LIST. §6 makes `Production.cls`'s `<Item>` set the
/// authority precisely because a copied host list is what went stale when `FHIR Transform` was
/// removed. So there is no framework-name list here to maintain: an `Ens.`-prefixed name is framework
/// by prefix, and anything absent from the running definition is framework by absence.
///
/// NOT A `%AI.Tool` SUBCLASS, deliberately, which is what makes the methods safe to make public --
/// `%AI.ToolMgr.FindTools` filters on `$$issubclassof(className, "%AI.Tool")`, so nothing here can
/// become a callable tool. `Tools.ErrorCatalogue` and `Tools.Governance` rely on the same fact for the
/// same reason.
Class ProductionGuardian.LabDemo.Tools.HostRoster
{

/// The production whose item set defines "application host".
///
/// A SIXTH COPY OF THIS STRING, and it is worth naming rather than hiding: `Tools.Read`,
/// `Tools.Activity`, `Tools.Resolve`, `Triggers` and `Setup.FirstBoot` each declare their own. This
/// class is the one whose *job* is the roster, so it is the right place for the other five to point at
/// eventually -- but repointing them is a change to five files that this one does not need, and
/// bundling it here would put a refactor inside a feature.
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// Is this host one of the production's APPLICATION config items?
///
/// `Ens.*` prefixed items are framework, config item or not. Everything else is application only if
/// the running definition actually lists it -- so a host recorded in the activity or log tables that
/// no longer exists in the production resolves to `false` rather than to a name a caller can act on.
ClassMethod IsApplication(host As %String) As %Boolean
{
    if $extract(host, 1, 4) = "Ens." {
        quit 0
    }
    quit ..IsConfigItem(host)
}

/// Is this host a config item in the production this roster reports on?
ClassMethod IsConfigItem(host As %String) As %Boolean
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$isobject(def) {
        quit 0
    }
    // Explicit result variable rather than a bare `quit` inside the FOR -- the same reasoning as
    // `Tools.Read.FindItem`, where breaking the loop left the variable holding whatever was last
    // examined.
    set result = 0
    for i = 1:1:def.Items.Count() {
        if def.Items.GetAt(i).Name = host {
            set result = 1
            quit
        }
    }
    quit result
}

}
