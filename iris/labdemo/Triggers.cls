/// Trigger toggles: induce any of the eight Health Scan finding types on demand.
///
/// Dev A acceptance criterion 3 (spec §3, `iris/CLAUDE.md` §6):
///   "Each of the 8 finding types can be induced on demand via trigger toggles."
///
/// Until this class existed that criterion was met by a table of manual steps in
/// README.md, which is not the same thing. Two of those steps required editing
/// `PatientDemographicsOperation` and recompiling it mid-demo, and the README had to warn
/// that a forgotten `hang` "poisons every later baseline". One required changing five
/// settings together, where missing any of the four timeouts means nothing fires.
///
///   do ##class(ProductionGuardian.LabDemo.Triggers).DeadHost()
///   do ##class(ProductionGuardian.LabDemo.Triggers).Reset()
///
/// Every method is idempotent, prints what it changed, and every change is undone by
/// Reset(). Nothing here edits source or requires a recompile.
///
/// WHAT THIS CLASS DOES NOT DO. It does not shorten any wait that is inherent to a rule:
/// `stalled_host` still needs `inactiveSeconds` (300) to elapse, and the comparative rules
/// still need a warm baseline. Making those instant would mean changing thresholds, i.e.
/// demonstrating a different configuration from the one we ship. `Status()` reports what is
/// armed and what each is still waiting for.
///
/// Ordered by how a demo would use them: absolute first, then comparative.
Class ProductionGuardian.LabDemo.Triggers
{

/// Config item names, matching the `<Item Name="...">` set in Production.cls. Held as a
/// parameter rather than repeated per method, because a host list copied into several
/// places is what went stale when FHIR Transform was removed (root CLAUDE.md §5).
Parameter OPERATION = "Cloud API";

Parameter SERVICE = "EMR Source";

Parameter PROCESS = "Lab Router";

/// The production this class manipulates. Every method verifies it is the running one
/// before changing anything -- the instance ran an unrelated LABDEMO.Production until
/// 2026-08-12, and a trigger that silently edits the wrong production is worse than one
/// that refuses (#34).
Parameter PRODUCTION = "ProductionGuardian.LabDemo.Production";

/// The unreachable port ErrorRate() points the operation at.
///
/// A parameter rather than a literal in two places: Status() recognises the armed state by
/// comparing against it, so a change to one and not the other would leave Status() silently
/// reporting nothing armed -- a status method lying by omission (@tanifgit, #66).
Parameter CLOSEDPORT = 59999;

/// dead_host -- absolute, fires within two polls. The demo's headline finding.
ClassMethod DeadHost() As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    set sc = ..SetEnabled(..#OPERATION, 0)
    if $$$ISERR(sc) {
        quit sc
    }
    write "ARMED  dead_host", !
    write "  ", ..#OPERATION, " disabled. Expect dead_host + throughput_drop within ~10s.", !
    write "  Reset() re-enables it.", !
    quit $$$OK
}

/// stalled_host -- needs a queue AND no activity for inactiveSeconds. Disabling the
/// operation gives both, but the wait is real: 300s by default.
ClassMethod StalledHost() As %Status
{
    set sc = ..DeadHost()
    if $$$ISERR(sc) {
        quit sc
    }
    set wait = ..InactiveSeconds()
    write !, "ARMED  stalled_host", !
    write "  Same toggle as dead_host -- the queue builds while nothing consumes it.", !
    write "  stalled_host needs ", wait, "s of inactivity, so expect it after ~", wait, "s.", !
    write "  dead_host appears immediately; that is correct, not a duplicate.", !
    quit $$$OK
}

/// queue_buildup -- needs depth over the floor AND over the baseline multiplier.
///
/// Deliberately uses the BROKEN-TARGET toggle, not DeadHost(). A disabled host stops
/// consuming at once, so its queue ramps from zero while the baseline warms on that same
/// ramp and the ratio never reaches the gate (#43). A host whose target is unreachable
/// keeps retrying, learns a small real baseline first, and then runs away past it --
/// measured live at 14x. Which toggle you pick decides whether this fires at all.
ClassMethod QueueBuildup() As %Status
{
    quit ..ErrorRate()
}

/// elevated_error_rate -- and queue_buildup, growing_queue_wait, throughput_drop with it.
///
/// Points the operation at a closed port AND makes failure fast. The timeouts are the
/// point, not a refinement: at the default 15s FailureTimeout each message burns 15s
/// before erroring, so the rate stays under the 1.0/min floor and nothing fires. That
/// cost a whole measurement cycle to discover.
ClassMethod ErrorRate() As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    // Capture the real port BEFORE overwriting it. Production.cls says HTTPServer/HTTPPort/
    // Credentials are the only settings that depend on the deployment and should be
    // overridden per environment -- so "restore it to 80" would silently break any
    // environment that followed that instruction. Reproduced: with the port at 8443,
    // arm-then-Reset() left it at 80.
    //
    // Same stash pattern SlowProcessing() uses for the injected delay, and stashed only if
    // not already set, so arming twice does not overwrite the saved value with the closed port.
    if '$data(^ProductionGuardian.Trigger("PortWas")) {
        set ^ProductionGuardian.Trigger("PortWas") = ..GetSetting(..#OPERATION, "HTTPPort")
    }
    set sc = ..SetSetting(..#OPERATION, "Adapter", "HTTPPort", ..#CLOSEDPORT)
    if $$$ISERR(sc) {
        quit sc
    }
    set settings = $listbuild("FailureTimeout", "RetryInterval", "ConnectTimeout", "ResponseTimeout")
    for i = 1:1:$listlength(settings) {
        set sc = ..SetSetting(..#OPERATION, "Host", $list(settings, i), 1)
        // Bare `quit` breaks the LOOP, deliberately -- the status is re-checked below and
        // returned from there. Not `quit sc`, which inside a For would return from the loop
        // rather than the method and is the classic ObjectScript trap.
        if $$$ISERR(sc) {
            quit
        }
    }
    if $$$ISERR(sc) {
        quit sc
    }
    set sc = ..UpdateProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    write "ARMED  elevated_error_rate  (+ queue_buildup, throughput_drop, growing_queue_wait)", !
    write "  ", ..#OPERATION, " now POSTs to a closed port and fails within ~1s.", !
    write "  Measured live: 12.0 errors/min at 14x baseline; queue reached 110 at 14x.", !
    write "  The most productive single toggle here -- four types at once.", !
    quit $$$OK
}

/// slow_processing and growing_queue_wait -- an injected per-message delay.
///
/// Sets a global the operation reads at runtime, so nothing is edited or recompiled. The
/// README used to say "add `hang 1` to the top of OnMessage, recompile", which is a source
/// edit mid-demo and leaves a hang behind if forgotten.
ClassMethod SlowProcessing(pMilliseconds As %Integer = 1000) As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    if pMilliseconds < 1 {
        write "REFUSED  a delay under 1ms induces nothing; pass e.g. 1000", !
        quit $$$ERROR($$$GeneralError, "delay must be >= 1ms")
    }
    set ^ProductionGuardian.Trigger("SlowMs") = pMilliseconds
    write "ARMED  slow_processing  (+ growing_queue_wait once traffic overlaps)", !
    write "  ", ..#OPERATION, " now takes ", pMilliseconds, "ms per message.", !
    write "  No recompile: the operation reads ^ProductionGuardian.Trigger(""SlowMs"") per message.", !
    write "  Gate is the greater of the 0.3s Cloud API floor and 3x its ~0.05s baseline.", !
    quit $$$OK
}

/// throughput_drop -- rate falls below a fraction of baseline.
///
/// Stops the inbound service rather than the operation, so no queue builds and no other
/// rule fires with it. That isolation is the point: DeadHost() also produces
/// throughput_drop, but this shows it alone.
ClassMethod ThroughputDrop() As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    set sc = ..SetEnabled(..#SERVICE, 0)
    if $$$ISERR(sc) {
        quit sc
    }
    write "ARMED  throughput_drop", !
    write "  ", ..#SERVICE, " disabled, so no messages enter the pipeline.", !
    write "  Needs a baseline of >= 0.1 msg/s first -- run the generator for ~1 minute.", !
    write "  dead_host also fires for ", ..#SERVICE, "; that is correct.", !
    quit $$$OK
}

/// system_alert -- the only rule that produces an `info` finding.
///
/// Writes an alert-severity entry naming a host. The host name is load-bearing: the rule
/// matches an alert to a host by the name appearing in the message TEXT, so an alert about
/// the instance produces no finding at all (#61).
///
/// `Alert on Error` does NOT work for this -- it routes to an Ens.Alert business host,
/// which Production.cls does not define, so the setting is silently inert (#57).
ClassMethod SystemAlert(pHost As %String = {..#OPERATION}) As %Status
{
    set text = "ERROR <Ens>ErrGeneral: " _ pHost _ " failed to send message to remote endpoint"
    do ##class(%SYS.System).WriteToConsoleLog(text, 0, 2)
    write "ARMED  system_alert", !
    write "  Wrote a severity-2 alert naming '", pHost, "'.", !
    write "  The host NAME is what attributes it -- an alert naming no reported host", !
    write "  produces no finding at all (#61).", !
    write "  DO NOT curl /api/monitor/alerts to check: it is consume-on-read and would", !
    write "  steal the alert from the proxy. Read :3001/proxy/alerts instead.", !
    write "  Reset() CANNOT undo this one -- the proxy accumulates alerts in memory, so the", !
    write "  finding persists until the proxy restarts. Arm it last in a demo.", !
    quit $$$OK
}

/// Undo every trigger. Safe to call at any time, including when nothing is armed.
///
/// This is the method that matters most: four of the manual procedures it replaces had to
/// be reversed by hand, and the README had to warn about each one.
ClassMethod Reset() As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    write "RESET", !

    // The injected delay first, so in-flight messages drain at normal speed.
    if $data(^ProductionGuardian.Trigger("SlowMs")) {
        kill ^ProductionGuardian.Trigger("SlowMs")
        write "  cleared the injected processing delay", !
    }

    // Restore the operation's real target and its shipped timeouts. Removing the four
    // timeout settings rather than setting them back to a value: they are not in
    // Production.cls, so absent IS the shipped state.
    // Restore the port to what it WAS, not to a literal. If nothing was stashed then
    // ErrorRate() never ran, so the port is whatever the environment configured and must be
    // left alone -- touching it would be this method inventing a deployment setting.
    set restored = "left as configured"
    if $data(^ProductionGuardian.Trigger("PortWas")) {
        set was = ^ProductionGuardian.Trigger("PortWas")
        if was '= "" {
            do ..SetSetting(..#OPERATION, "Adapter", "HTTPPort", was)
            set restored = "port restored to " _ was
        } else {
            // Absent before arming: absent is the right state to return it to.
            do ..RemoveSetting(..#OPERATION, "HTTPPort")
            set restored = "HTTPPort removed, as it was before arming"
        }
        kill ^ProductionGuardian.Trigger("PortWas")
    }
    set settings = $listbuild("FailureTimeout", "RetryInterval", "ConnectTimeout", "ResponseTimeout", "AlertOnError")
    for i = 1:1:$listlength(settings) {
        do ..RemoveSetting(..#OPERATION, $list(settings, i))
    }
    write "  ", ..#OPERATION, ": ", restored, ", fast-failure timeouts removed", !

    // Re-enable every application host.
    set hosts = $listbuild(..#SERVICE, ..#PROCESS, ..#OPERATION)
    for i = 1:1:$listlength(hosts) {
        do ..SetEnabled($list(hosts, i), 1)
    }
    write "  re-enabled ", ..#SERVICE, ", ", ..#PROCESS, ", ", ..#OPERATION, !

    set sc = ..UpdateProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    write !, "  Findings clear on their own within ~10s; a drained queue may leave", !
    write "  growing_queue_wait briefly, which is a true reading of a real wait.", !
    write "  If a class changed, `update` is not enough -- stop and start the production.", !
    write !, "  CANNOT be reset from here: a system_alert finding persists until the alert", !
    write "  ages out of the PROXY's in-memory buffer, which is a Node process on :3001 and", !
    write "  not reachable from IRIS. Restart the proxy to clear it. Verified: an alert", !
    write "  written 11 hours earlier was still buffered and still producing the finding.", !
    quit $$$OK
}

/// What is armed, and what each armed trigger is still waiting for.
ClassMethod Status() As %Status
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        write "no such production: ", ..#PRODUCTION, !
        quit $$$OK
    }

    write "TRIGGER STATUS  (", ..#PRODUCTION, ")", !
    set slow = +$get(^ProductionGuardian.Trigger("SlowMs"), 0)
    write "  injected delay : ", $select(slow > 0: slow _ "ms  <- slow_processing armed", 1: "none"), !

    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if $extract(item.Name, 1, 4) = "Ens." {
            continue
        }
        set port = ""
        for j = 1:1:item.Settings.Count() {
            set setting = item.Settings.GetAt(j)
            if setting.Name = "HTTPPort" {
                set port = setting.Value
            }
        }
        set note = ""
        if 'item.Enabled {
            set note = "  <- disabled"
        }
        if port = ..#CLOSEDPORT {
            set note = "  <- pointed at a closed port"
        }
        write "  ", $justify(item.Name, 16), " enabled=", item.Enabled, note, !
    }
    quit $$$OK
}

/// Refuse to act unless the production this class knows about is the running one.
ClassMethod CheckProduction() As %Status
{
    set sc = ##class(Ens.Director).GetProductionStatus(.running, .state)
    if $$$ISERR(sc) {
        quit sc
    }
    if running '= ..#PRODUCTION {
        write "REFUSED  running production is '", running, "', not '", ..#PRODUCTION, "'", !
        write "  These triggers manipulate item names and settings from Production.cls.", !
        write "  Against a different production they would edit the wrong thing (#34).", !
        quit $$$ERROR($$$GeneralError, "wrong production running: " _ running)
    }
    // state 1 is Running. A stopped production accepts config edits that take effect on
    // start, which is confusing rather than wrong -- so warn instead of refusing.
    if state '= 1 {
        write "NOTE  production state is ", state, ", not Running. Changes apply on start.", !
    }
    quit $$$OK
}

/// Enable or disable one config item.
ClassMethod SetEnabled(pItem As %String, pEnabled As %Boolean) As %Status
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        quit $$$ERROR($$$GeneralError, "cannot open " _ ..#PRODUCTION)
    }
    set found = 0
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name = pItem {
            set item.Enabled = pEnabled
            set found = 1
        }
    }
    if 'found {
        quit $$$ERROR($$$GeneralError, "no such config item: " _ pItem)
    }
    set sc = def.%Save()
    if $$$ISERR(sc) {
        quit sc
    }
    quit ..UpdateProduction()
}

/// Set one setting on one config item, adding it if absent.
ClassMethod SetSetting(pItem As %String, pTarget As %String, pName As %String, pValue As %String) As %Status
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        quit $$$ERROR($$$GeneralError, "cannot open " _ ..#PRODUCTION)
    }
    // Track whether the ITEM was found, not just the setting. Without this an unknown item
    // makes this method a silent no-op, so a rename in Production.cls would have
    // ErrorRate() print ARMED having changed nothing -- and CheckProduction() would not
    // catch it, since it only compares the production NAME (@tanifgit, #66). A trigger that
    // reports armed and is not is the worst failure this class can have.
    set foundItem = 0
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name '= pItem {
            continue
        }
        set foundItem = 1
        set found = 0
        for j = 1:1:item.Settings.Count() {
            set setting = item.Settings.GetAt(j)
            if setting.Name = pName {
                set setting.Value = pValue
                set found = 1
            }
        }
        if 'found {
            set setting = ##class(Ens.Config.Setting).%New()
            set setting.Target = pTarget
            set setting.Name = pName
            set setting.Value = pValue
            do item.Settings.Insert(setting)
        }
    }
    if 'foundItem {
        quit $$$ERROR($$$GeneralError, "no such config item: " _ pItem _ " (renamed in Production.cls?)")
    }
    quit def.%Save()
}

/// Remove one setting from one config item, if present. Absent is the shipped state for
/// every setting this class adds, so removal is the correct undo rather than a default.
ClassMethod RemoveSetting(pItem As %String, pName As %String) As %Status
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        quit $$$ERROR($$$GeneralError, "cannot open " _ ..#PRODUCTION)
    }
    set foundItem = 0
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name '= pItem {
            continue
        }
        set foundItem = 1
        // Descending, because RemoveAt shifts the indices below it.
        for j = item.Settings.Count():-1:1 {
            set setting = item.Settings.GetAt(j)
            if setting.Name = pName {
                do item.Settings.RemoveAt(j)
            }
        }
    }
    // Same reason as SetSetting: silence here would make Reset() report success having
    // restored nothing.
    if 'foundItem {
        quit $$$ERROR($$$GeneralError, "no such config item: " _ pItem _ " (renamed in Production.cls?)")
    }
    quit def.%Save()
}

/// Apply the saved config to the running production.
ClassMethod UpdateProduction() As %Status
{
    quit ##class(Ens.Director).UpdateProduction()
}

/// stalled_host's configured wait, for the message StalledHost() prints.
///
/// RESTATES the shipped 300 from `services/detection-engine/thresholds.json` -- it does not
/// read it. Nothing writes the override global; it exists so a demo on a retuned engine can
/// set it by hand rather than print a wrong number.
///
/// An earlier comment here claimed the value was "read from thresholds rather than restated",
/// which was false: no writer existed, so it always returned 300. Correct today, because
/// thresholds.json says 300 -- which is what made it the same defect as the 2.18x ceiling
/// (#63), a restated constant whose comment claims it is derived. `inactiveSeconds` is
/// hot-reloaded (ADR 0003), so a retune would make this print a wrong wait confidently.
ClassMethod InactiveSeconds() As %Integer
{
    quit +$get(^ProductionGuardian.Trigger("InactiveSeconds"), 300)
}

/// One setting's current value, or "" when absent. Used to capture state before arming.
ClassMethod GetSetting(pItem As %String, pName As %String) As %String
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        quit ""
    }
    set value = ""
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name '= pItem {
            continue
        }
        for j = 1:1:item.Settings.Count() {
            set setting = item.Settings.GetAt(j)
            if setting.Name = pName {
                set value = setting.Value
            }
        }
    }
    quit value
}

}
