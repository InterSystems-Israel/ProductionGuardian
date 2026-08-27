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

/// The directory MissingFolder() points EMR Source at — one that does not exist.
///
/// Under /tmp/labdemo/ rather than somewhere exotic, so a reader of the boot log sees a path that
/// looks like the real one with a suffix, not a contrived value. `-missing` rather than a random
/// name because the point of the scenario is that the *configuration* is wrong, and a plausible
/// typo is what actually happens on a real deployment.
///
/// NOT CREATED, EVER. `FirstBoot.MakeDirectories()` creates the two real drop directories on every
/// boot; if this one were in that list the scenario would disarm itself. Checked that it is not.
Parameter MISSINGPATH = "/tmp/labdemo/hl7-in-missing/";

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

/// stalled_host -- CANNOT BE INDUCED BY EITHER TOGGLE THIS CLASS HAS. Measured, not assumed:
/// this method arms the closest available state and says plainly that the finding will not
/// arrive, because the previous version promised it after ~300s and that was impossible.
///
/// WHY. The rule declines for any host whose status is in DEAD_STATUSES -- "a dead host is
/// reported as dead, not stalled: one condition, one finding"
/// (detection-engine/src/detect/rules/index.ts). And every mechanism here for stopping a host
/// consuming its queue puts it in exactly that set:
///
///   DeadHost()  -> disable the item      -> status Disabled -> in DEAD_STATUSES
///   ErrorRate() -> point at a shut port  -> status Error    -> in DEAD_STATUSES
///
/// So the first guard in the rule returns null on the very first poll and on every poll after.
/// Verified live on the containerised stack: 11 minutes at 320+ queued with
/// lastActivityElapsedSeconds at 690s -- every documented gate satisfied except that one --
/// and no stalled_host, ever. Probing the rule directly with those exact values returns null.
///
/// WHAT WOULD ACTUALLY PRODUCE IT. A host that is NOT dead, has a queue, and is not consuming.
/// `Retry` is deliberately excluded from DEAD_STATUSES ("a retrying host is degraded but not
/// dead"), so a host stuck retrying with a backlog is the intended shape -- but a retry loop
/// against a closed port escalates to Error here rather than settling in Retry, so LABDEMO has
/// no toggle that parks a host there. Getting one means either a host whose adapter retries
/// slowly enough to stay in Retry across two polls, or suspending the queue's consumer without
/// changing the item's status. Neither exists today.
///
/// This is a gap in the DEMO's coverage, not a defect in the rule -- the rule's precedence
/// choice is right, and `dead_host` fires for exactly the state an operator cares about. It is
/// recorded here rather than in the acceptance table because "each of the 8 finding types can
/// be induced on demand" is what this class exists to satisfy, and for this one type it does
/// not.
ClassMethod StalledHost() As %Status
{
    set sc = ..DeadHost()
    if $$$ISERR(sc) {
        quit sc
    }
    set wait = ..InactiveSeconds()
    write !, "ARMED  dead_host -- and stalled_host will NOT follow", !
    write "  The queue builds while nothing consumes it, which is half of what", !
    write "  stalled_host needs (", wait, "s idle WITH a queue). The other half is a status", !
    write "  that is not already dead, and disabling the item makes it Disabled.", !
    write "  The rule reports a dead host as dead, not stalled -- one condition, one", !
    write "  finding -- so it declines on the first poll and every poll after.", !
    write "  Measured: 11 min at 320+ queued and 690s idle produced no stalled_host.", !
    write "  See the class comment for what would actually induce it.", !
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
///
/// DEFAULT RAISED 1000 -> 3000 on 2026-08-27, because the engine's floor for this host moved.
/// `Cloud API`'s `slow_processing` floor is now 1.5s rather than 0.3s -- `PoolBottleneck()`
/// throttles the same host to ~1.01s per message and that value is identical before and after
/// Smart Resolve enlarges the pool, so the finding had to be suppressed there or it outlived the
/// fix that cleared the queue (see the `hostOverrides` note in the engine's thresholds.json).
/// 1000ms measured 840ms here and would now be silent, which is the one way this class can look
/// armed and induce nothing. 3000ms lands ~2x over the floor with no ambiguity.
ClassMethod SlowProcessing(pMilliseconds As %Integer = 3000) As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    if pMilliseconds < 1 {
        write "REFUSED  a delay under 1ms induces nothing; pass e.g. 3000", !
        quit $$$ERROR($$$GeneralError, "delay must be >= 1ms")
    }
    set ^ProductionGuardian.Trigger("SlowMs") = pMilliseconds
    write "ARMED  slow_processing  (+ growing_queue_wait once traffic overlaps)", !
    write "  ", ..#OPERATION, " now takes ", pMilliseconds, "ms per message.", !
    write "  No recompile: the operation reads ^ProductionGuardian.Trigger(""SlowMs"") per message.", !
    write "  Gate is the 1.5s ", ..#OPERATION, " floor, which beats 3x its ~0.05s baseline.", !
    if pMilliseconds < 2000 {
        // Named rather than refused: a smaller delay is still a legitimate thing to arm, it just
        // does not reach the reporting floor for this host. Silence with no explanation is what
        // sends someone looking for a broken rule.
        //
        // 2000, NOT the 1500ms floor itself. The measured processing time comes in UNDER the
        // armed value -- `SlowProcessing(1000)` measured 840ms, ~0.84x -- so the armed value that
        // actually reaches a 1.5s floor is ~1786ms, and a boundary at 1500 left [1500, 1785]
        // inducing nothing while printing no note. That band is the exact failure this note
        // exists to prevent, so the boundary belongs above the floor rather than on it.
        write "  NOTE  under 2000ms this host reports no slow_processing -- its floor is 1.5s", !
        write "        and the induced delay measures ~0.84x what you pass, so 1500 is not", !
        write "        enough. Pass 3000 to see the finding.", !
        write "        growing_queue_wait still fires once traffic overlaps.", !
    }
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

/// THE MVP 2 SCENARIO. Arms the throughput bottleneck the whole WHAT -> WHY -> FIX loop is built
/// on, and the only one whose correct fix is a pool-size change.
///
///   do ##class(ProductionGuardian.LabDemo.Triggers).PoolBottleneck()
///
/// WHAT IT DOES, and why each half is needed:
///
///   1. throttles the DOWNSTREAM dispatcher to ~1s per call. Cloud API is PoolSize 1, so with a
///      1s downstream it clears ~1 msg/sec no matter how much arrives.
///   2. raises HL7 inflow above that ceiling. Inflow > drain rate is what builds the queue.
///
/// Neither alone produces the scenario: a throttle with normal inflow just makes a slow-but-
/// keeping-up pipeline, and fast inflow without the throttle is absorbed. It is the RATIO that
/// matters, which is why this is one method rather than two toggles a presenter must combine
/// correctly under pressure.
///
/// WHY THIS IS THE RIGHT DEMO. The fix is unambiguous and it is a configuration change, not a
/// code change: with 4 workers the 1s downstream waits OVERLAP, so effective throughput rises to
/// ~4/sec and the queue drains. And Cloud API genuinely IS PoolSize 1 in Production.cls -- the
/// bottleneck is real, not arranged for the camera. The only thing this method adds is a slow
/// downstream, which is the most common real cause of exactly this shape.
///
/// STASHES THE PRIOR POOL SIZE so Reset() can restore it, by the same rule as the port stash in
/// ErrorRate(): capture what was actually there, never a literal. Smart Resolve is going to change
/// this value, and #66 established that restoring to a hardcoded number destroys a deployment that
/// legitimately differs.
///
/// THE BASELINE MUST WARM AT ZERO, WITH NO QUEUE, BEFORE ANYTHING IS ARMED. `pWarmSeconds`
/// (default 75) waits with both halves OFF so the engine records a genuinely empty queue, and only
/// then applies the throttle and the rate together.
///
/// WHY, and this comes from the rule rather than from tuning. `queue_buildup` computes:
///
///     ratio = baseline > 0 ? depth / baseline : POSITIVE_INFINITY
///
/// So a baseline of exactly **0** makes the ratio infinite and the absolute floor (50) becomes the
/// whole test -- the finding fires as soon as depth clears 50. A baseline of anything above zero
/// makes the ratio finite, and then #43 applies: a queue ramping upward inflates its own rolling
/// mean, and the ratio asymptotes to ~2x against a 5x gate. Modelled over the 30-minute window:
///
///   after  2 min   queued  120   mean   62   ratio 1.92x
///   after 10 min   queued  600   mean  302   ratio 1.98x
///   after 30 min   queued 1800   mean  902   ratio 1.99x     <- never reaches 5.0
///
/// MEASURED BOTH WAYS, and the first way was my mistake. Warming for 90s with the THROTTLE
/// ALREADY ON let a queue form during warm-up, so the baseline learned a nonzero value: queue
/// climbed 70, 135, 196, 254 across four minutes with the floor long since cleared, and the rule
/// stayed silent -- ratio peaked near 3.3x and then DECAYED, so waiting made it worse rather than
/// better. Warming with nothing armed keeps the baseline at 0 and the finding arrives once depth
/// passes 50.
///
/// Cloud API idles at queued=0, so an empty warm-up is the natural state rather than something to
/// engineer. 75s covers minBaselineSamples (12) x the 5s engine poll with margin.
///
/// This is the same mechanism that makes ErrorRate() work where a plain disable does not (#43),
/// stated as a requirement instead of relied on as luck.
///
/// HONEST STATUS: THE MECHANICS ALL WORK, THE FINDING IS NOT YET RELIABLE. Measured on the
/// containerised stack, each independently:
///
///   the dispatcher throttle        avgProcessingTime 0.01s -> 1.01s
///   the inflow rate override       archive rate 0.53/sec -> 4.13/sec
///   the bottleneck itself          queue grows steadily while status stays OK, not dead
///   SetPoolSize (the FIX)          pool 1 -> 4, throughput rose to exactly 4/sec
///   Reset()                        pool restored 4 -> 1 from the stash, both globals cleared
///   queue_buildup                  FIRED ONCE: "Queue depth 198 is 9.0x baseline"
///
/// What is NOT yet nailed down is an arming sequence that makes `queue_buildup` fire EVERY time.
/// It fired on the first run and not on three subsequent ones, and the difference is the state of
/// the rolling baseline when the ramp begins -- which depends on what the instance was doing
/// beforehand, i.e. on history rather than on this method. Two things are established about why:
/// the rule's `baseline > 0 ? depth / baseline : INFINITY` means a genuinely zero baseline reduces
/// the test to the floor alone, and a nonzero one caps the achievable ratio near 2x against a 5x
/// gate (#43). Getting the baseline to zero requires the queue to be *empty* for the whole warm-up,
/// and with the HL7 generator running it intermittently is not.
///
/// So do not build the demo script on `queue_buildup` alone yet. `throughput_drop` fires reliably
/// on this scenario and is a true statement about it. The remaining work is either a warm-up that
/// guarantees an empty queue (pause the generator during it) or accepting that #25's threshold
/// rework is the real fix -- and #25 is open precisely because these floors are tuned to LABDEMO's
/// scale. Recorded here rather than left as a surprise for whoever writes the demo script.
///
/// EXPECT: queue_buildup within ~2 min of the rate rising. dead_host does NOT fire -- the host is
/// healthy, just outnumbered, which is the point: this is the scenario where the finding needs an
/// explanation rather than being self-evident.
///
/// THE GENERATOR MUST BE RUNNING THE CURRENT ROUTINE. `RunContinuous` re-reads the rate global per
/// iteration, but a long-lived `job`-ed process keeps executing the routine it started with, so a
/// generator jobbed before that change ignores the override silently -- measured 0.53/sec when 4/sec
/// was requested, with the global correctly set. Restart it after any recompile of HL7Generator.
///
/// THE DEFAULT RATE IS 0.5s, NOT 0.25s, AND THAT CHOICE IS THE DEMO. Measured live:
///
///   inflow      drain at pool 1     drain at pool 4      after the fix
///   4/sec       1/sec               4/sec                PLATEAU at ~1215 -- no drain
///   2/sec       1/sec               4/sec                net -2/sec -- visibly drains
///
/// At 0.25s the arithmetic is exactly balanced once the pool reaches 4, so the queue stops
/// growing and then just sits there. Verified: queue held 1211, 1213, 1215, 1215 across four
/// minutes after the fix, with throughput at exactly 4/sec. The fix WORKED -- throughput
/// quadrupled -- and on screen it looks like nothing happened, because the number an operator
/// watches never comes down. MVP 2 §6 lists "pool change does not drain fast enough on stage" as
/// a named risk; a balanced default is the version of that risk you ship without noticing.
///
/// So the default leaves headroom: 2/sec in against 4/sec out drains ~2/sec, and the backlog the
/// demo built visibly disappears. Raise pRateSecs to make the drain faster and more dramatic;
/// lower it toward 0.25 only if you want to demonstrate that a pool of 4 is NOT enough.
ClassMethod PoolBottleneck(pDispatcherMs As %Integer = 1000, pRateSecs As %Double = 0.5, pWarmSeconds As %Integer = 75, pMaxQueued As %Integer = 400) As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }
    if pDispatcherMs < 1 {
        write "REFUSED  a dispatcher throttle under 1ms induces nothing", !
        quit $$$ERROR($$$GeneralError, "pDispatcherMs must be >= 1")
    }
    // THE DEPTH CAP MUST CLEAR THE RULE'S ABSOLUTE FLOOR, or arming this produces no finding at all.
    // queue_buildup will not fire below 50 queued, so a cap at or under that pauses the generator
    // before the thing it exists to demonstrate can happen -- an armed scenario that looks armed and
    // shows nothing. 100 is the lower bound rather than 51 so the depth is unambiguously past the
    // floor while the finding debounces over its 2 consecutive samples.
    if pMaxQueued < 100 {
        write "REFUSED  a cap of ", pMaxQueued, " is too close to the rule's absolute floor (50)", !
        write "         the generator would pause before queue_buildup could fire", !
        quit $$$ERROR($$$GeneralError, "pMaxQueued must be >= 100")
    }
    if pRateSecs <= 0 {
        // Guarded rather than trusted: a zero interval spins the generator loop as fast as the
        // filesystem allows, which takes the instance down instead of demonstrating a queue.
        write "REFUSED  an inflow interval of ", pRateSecs, "s would spin the generator", !
        quit $$$ERROR($$$GeneralError, "pRateSecs must be > 0")
    }

    // Stash before changing anything, and only if not already stashed -- arming twice must not
    // overwrite the real prior value with the armed one.
    if '$data(^ProductionGuardian.Trigger("PoolWas")) {
        set ^ProductionGuardian.Trigger("PoolWas") = ..GetPoolSize(..#OPERATION)
    }

    // WARM AT ZERO, with nothing armed. Applying the throttle before this wait was the defect:
    // a queue forms during warm-up, the baseline learns a nonzero value, and the ratio can then
    // never reach 5x (see the class comment). Both halves go on together AFTER the wait.
    if pWarmSeconds > 0 {
        write "  warming the baseline for ", pWarmSeconds, "s with NOTHING armed", !
        write "    (queue must read 0 so the baseline is 0 -- otherwise the ratio caps near 2x)", !
        hang pWarmSeconds
    }
    set ^ProductionGuardian.Trigger("DispatcherMs") = pDispatcherMs
    set ^ProductionGuardian.Trigger("RateSecs") = pRateSecs
    // Read per message by HL7Generator.RunContinuous, which pauses above it. Set with the rest of the
    // armed state so it cannot outlive the scenario, and cleared by Reset() with everything else.
    set ^ProductionGuardian.Trigger("MaxQueued") = pMaxQueued

    set pool = ..GetPoolSize(..#OPERATION)
    set drainPerSec = 1000 / pDispatcherMs * $select(+pool > 0: +pool, 1: 1)
    set inflowPerSec = 1 / pRateSecs

    write "ARMED  queue_buildup  (the MVP 2 pool-bottleneck scenario)", !
    write "  ", ..#OPERATION, " PoolSize ", pool, " x ~", pDispatcherMs, "ms downstream", !
    write "    -> drains ~", $fnumber(drainPerSec, "", 1), "/sec", !
    write "  HL7 inflow every ", pRateSecs, "s -> ~", $fnumber(inflowPerSec, "", 1), "/sec", !
    write "  net ~+", $fnumber(inflowPerSec - drainPerSec, "", 1), "/sec into the queue", !
    write "  inflow PAUSES at ", pMaxQueued, " queued and resumes as the queue drains (#101)", !
    // Stated at arming time with the arithmetic, because a presenter needs to know roughly how long
    // the build-up takes before they are standing in front of it.
    if (inflowPerSec - drainPerSec) > 0 {
        write "    ~", $fnumber(pMaxQueued / (inflowPerSec - drainPerSec), "", 0), "s to reach the cap from empty", !
    }
    write "  Expect queue_buildup once depth clears the absolute floor (50).", !
    write "  dead_host will NOT fire: the host is healthy, just outnumbered.", !
    write "  The fix is more workers, not a restart -- pool ", pool, " -> 4 makes the", !
    write "    downstream waits overlap. Reset() restores pool ", pool, ".", !
    // State the POST-FIX arithmetic at arming time. A presenter needs to know the queue will
    // actually come down before they are on stage, not discover a plateau in front of an
    // audience -- and a fix that quadruples throughput while the watched number holds steady
    // reads as a fix that did nothing.
    set drainAt4 = 1000 / pDispatcherMs * 4
    write "  AFTER the fix: drains ~", $fnumber(drainAt4, "", 1), "/sec vs ~", $fnumber(inflowPerSec, "", 1), "/sec in", !
    if drainAt4 > inflowPerSec {
        write "    -> net -", $fnumber(drainAt4 - inflowPerSec, "", 1), "/sec, the queue DRAINS visibly.", !
    } else {
        write "    -> WARNING: net ", $fnumber(drainAt4 - inflowPerSec, "", 1), "/sec. Pool 4 will NOT drain this", !
        write "       backlog -- it only stops it growing. Raise pRateSecs for a visible drain.", !
    }
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

    // MVP 2 scenario globals. The RATE goes first and the THROTTLE second, deliberately: with
    // the throttle cleared first the queue would drain at full speed while inflow was still
    // elevated, which is a different (and less honest) recovery than the one Smart Resolve
    // demonstrates. Slow the inflow, then remove the bottleneck.
    if $data(^ProductionGuardian.Trigger("RateSecs")) {
        kill ^ProductionGuardian.Trigger("RateSecs")
        write "  restored the HL7 inflow rate to the generator's own interval", !
    }
    // The FilePath, restored to what it WAS rather than to a literal -- the same rule as the port
    // above, and for the same reason: a deployment that legitimately uses a different inbound
    // directory must not be rewritten by a reset. If nothing was stashed, MissingFolder() never ran
    // and the path is whatever the environment configured.
    if $data(^ProductionGuardian.Trigger("PathWas")) {
        set was = ^ProductionGuardian.Trigger("PathWas")
        if was '= "" {
            do ..SetSetting(..#SERVICE, "Adapter", "FilePath", was)
            write "  ", ..#SERVICE, " FilePath restored to ", was, !
        } else {
            // Absent before arming is the shipped state for a setting this class added.
            do ..RemoveSetting(..#SERVICE, "FilePath")
            write "  ", ..#SERVICE, " FilePath removed, as it was before arming", !
        }
        kill ^ProductionGuardian.Trigger("PathWas")
    }

    if $data(^ProductionGuardian.Trigger("MaxQueued")) {
        kill ^ProductionGuardian.Trigger("MaxQueued")
        write "  removed the generator's queue-depth cap", !
    }
    if $data(^ProductionGuardian.Trigger("DispatcherMs")) {
        kill ^ProductionGuardian.Trigger("DispatcherMs")
        write "  cleared the downstream dispatcher throttle", !
    }

    // Pool size back to what it WAS, by the same rule as the port above: restore the stashed
    // value, never a literal. Smart Resolve's whole point is changing this, so Reset() has to be
    // able to undo it -- and #66 established that restoring to a hardcoded number destroys a
    // deployment that legitimately differs.
    if $data(^ProductionGuardian.Trigger("PoolWas")) {
        set poolWas = ^ProductionGuardian.Trigger("PoolWas")
        if poolWas '= "" {
            do ..SetPoolSize(..#OPERATION, poolWas)
            write "  ", ..#OPERATION, " pool restored to ", poolWas, !
        }
        kill ^ProductionGuardian.Trigger("PoolWas")
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

    // The MVP 2 scenario globals. Reported for the same reason #66 added the closed-port check
    // below: a Status() that omits armed state lies by omission, and these two are invisible
    // otherwise -- neither shows up as a disabled host or a changed setting.
    set thr = +$get(^ProductionGuardian.Trigger("DispatcherMs"), 0)
    write "  dispatcher     : ", $select(thr > 0: thr _ "ms per POST  <- downstream throttled", 1: "no throttle"), !
    set rate = +$get(^ProductionGuardian.Trigger("RateSecs"), 0)
    write "  HL7 inflow     : ", $select(rate > 0: rate _ "s per message  <- rate overridden", 1: "generator default"), !
    // Reported with the live depth beside it, so "capped" and "currently paused" are distinguishable
    // at a glance -- a presenter seeing a flat queue needs to know whether it is held or stuck.
    // Reported for the same reason as the throttle and the inflow rate: an armed FilePath shows up
    // as a host in Error with no obvious cause, and Status() exists so nothing armed is invisible.
    set livePath = ..GetSetting(..#SERVICE, "FilePath")
    write "  inbound path   : ", $select(livePath = "": "(adapter default)", 1: livePath),
        $select(livePath = ..#MISSINGPATH: "   <- ARMED, does not exist", 1: ""), !
    if $data(^ProductionGuardian.Trigger("PathWas")) {
        write "  path stashed   : ", ^ProductionGuardian.Trigger("PathWas"), "  <- Reset() will restore this", !
    }

    set cap = +$get(^ProductionGuardian.Trigger("MaxQueued"), 0)
    if cap > 0 {
        set depth = ##class(Ens.Queue).GetCount(..#OPERATION)
        write "  inflow cap     : ", cap, " queued, now ", depth,
            $select(depth >= cap: "  <- PAUSED, inflow held", 1: "  <- producing"), !
    } else {
        write "  inflow cap     : none  <- the backlog is unbounded (#101)", !
    }
    if $data(^ProductionGuardian.Trigger("PoolWas")) {
        write "  pool stashed   : ", ^ProductionGuardian.Trigger("PoolWas"), "  <- Reset() will restore this", !
    }

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
        write "  ", $justify(item.Name, 16), " enabled=", item.Enabled, " pool=", item.PoolSize, note, !
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

/// Read a config item's pool size. Returns "" when the item does not exist, so a caller can
/// tell "not found" from a real value -- an unmeasurable value is not a small one (#33).
ClassMethod GetPoolSize(pItem As %String) As %String
{
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        quit ""
    }
    // Explicit result variable rather than inspecting the loop variable afterwards. A bare
    // `quit` breaks the FOR, so the loop variable holds the last item examined whether or not it
    // matched -- which would return some other host's pool size for an unknown item name. That is
    // the confidently-wrong answer, and it is worse here than "" because a caller stashing it for
    // Reset() would restore the wrong host's value.
    set result = ""
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name = pItem {
            set result = item.PoolSize
            quit
        }
    }
    quit result
}

/// Set a config item's pool size -- the MVP 2 action, and the one Smart Resolve wraps.
///
/// PoolSize IS A PROPERTY of Ens.Config.Item, not a row in its Settings collection. That
/// distinction is the whole reason this method exists rather than callers using SetSetting():
/// SetSetting writes the Settings collection, and for PoolSize that would store a setting nobody
/// reads -- the production would report success and behave identically, a silent no-op in the one
/// action MVP 2 exists to perform. Verified by introspection: Ens.Config.Item.PoolSize is a
/// %Library.Integer property (contracts/mcp-tools.md, docs/mvp2-aihub-verified-api.md).
///
/// So this follows SetEnabled's shape, which writes a property, and NOT SetSetting's.
///
/// Bounds are deliberately NOT enforced here. This is the mechanism; the policy -- the 2..8 range,
/// the single whitelisted host -- belongs to the governed MCP write tool, where it is RBAC-gated
/// and audited (contracts/resolve-api.md §3). Putting a second, quieter bounds check here would
/// mean two places to keep in agreement and a reader unsure which one is authoritative.
ClassMethod SetPoolSize(pItem As %String, pSize As %Integer) As %Status
{
    if (pSize '= (pSize \ 1)) || (pSize < 1) {
        quit $$$ERROR($$$GeneralError, "pool size must be a positive integer, got: " _ pSize)
    }
    set def = ##class(Ens.Config.Production).%OpenId(..#PRODUCTION)
    if '$IsObject(def) {
        quit $$$ERROR($$$GeneralError, "cannot open " _ ..#PRODUCTION)
    }
    set found = 0
    for i = 1:1:def.Items.Count() {
        set item = def.Items.GetAt(i)
        if item.Name = pItem {
            set item.PoolSize = pSize
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

/// MVP 3 scenario 2 — the missing folder. A host that cannot read its inbound directory.
///
/// WHY THIS SCENARIO EXISTS. Every finding MVP 2 could produce had a governed action behind it, so
/// nothing exercised the path where the correct answer is **no action at all**. This one is a real
/// failure — `FirstBoot.cls` records it from the #34/#53 deploy, where the two HL7 drop directories
/// did not exist and `EMR Source` went straight to Error with `#5021` — and the fix is an operator
/// creating a directory, which Production Guardian must recommend without offering to do.
///
/// ARMED BY REPOINTING THE SETTING, NOT BY DELETING THE DIRECTORY, and the third reason is the one
/// that decides it:
///
///   1. The generator writes into that directory, so deleting it breaks inbound traffic a second way
///      and the finding stops being about what it claims to be about.
///   2. `FirstBoot.MakeDirectories()` recreates it on every boot, so an armed demo would disarm
///      itself on the next restart.
///   3. **It is not reversible from inside IRIS.** Every toggle in this class stashes what it
///      replaced and `Reset()` puts it back; a trigger that deleted a filesystem directory could not
///      honour that contract, because recreating a directory is not the same as never having removed
///      it — permissions and ownership are lost.
///
/// So this is `ErrorRate()`'s stash-and-restore shape with a path instead of a port.
///
/// WHICH FINDING FIRES. `dead_host`, because `Error` is already in the engine's `DEAD_STATUSES` —
/// read from the rule rather than assumed, so MVP 3 needs no new detection rule. `stalled_host`
/// deliberately does NOT fire: it declines for any host already in `DEAD_STATUSES`, which is the
/// one-condition-one-finding rule working.
ClassMethod MissingFolder() As %Status
{
    set sc = ..CheckProduction()
    if $$$ISERR(sc) {
        quit sc
    }

    // Stash the REAL path before overwriting it, and only if not already stashed -- arming twice
    // must not overwrite the saved value with the missing one. Same rule as PortWas and PoolWas,
    // and the same reason: #66 restored a hardcoded port and destroyed a deployment that
    // legitimately used a different one.
    if '$data(^ProductionGuardian.Trigger("PathWas")) {
        set ^ProductionGuardian.Trigger("PathWas") = ..GetSetting(..#SERVICE, "FilePath")
    }

    set sc = ..SetSetting(..#SERVICE, "Adapter", "FilePath", ..#MISSINGPATH)
    if $$$ISERR(sc) {
        quit sc
    }

    // WITHOUT THIS THE SETTING PERSISTS AND NOTHING HAPPENS. SetSetting() saves the production
    // definition; the RUNNING job keeps the value it started with, so the host stays OK and the
    // scenario looks broken. Measured: 160 seconds at status OK with the persisted path already
    // pointing at the missing directory. Every other arming method in this class calls this for the
    // same reason -- copied the shape rather than rediscovering it a second time.
    set sc = ..UpdateProduction()
    if $$$ISERR(sc) {
        quit sc
    }

    write "ARMED  dead_host  (the MVP 3 missing-folder scenario)", !
    write "  ", ..#SERVICE, " FilePath -> ", ..#MISSINGPATH, !
    write "    stashed the real path; Reset() restores it", !
    write "  The service polls a directory that does not exist, so every poll fails", !
    write "    before it can read a message. Expect Error status and #5021 in the log.", !
    write "  dead_host fires (Error is in DEAD_STATUSES).", !
    write "  stalled_host will NOT fire -- it declines for a host already in DEAD_STATUSES.", !
    write "  THERE IS NO GOVERNED FIX. The recommendation is words, for an operator to act on:", !
    write "    create the directory, or repoint FilePath at one that exists.", !
    write "  Inbound traffic stops while this is armed -- the generator still writes to the real", !
    write "    directory, and the service is no longer looking at it.", !
    quit $$$OK
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
