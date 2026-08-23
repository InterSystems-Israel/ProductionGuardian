/// REST bridge to the demo scenario triggers, for the dashboard's trigger buttons.
///
/// Three routes, all POST except the first:
///
///   GET  /labdemo/trigger/status    what is armed right now
///   POST /labdemo/trigger/arm       {"scenario": "pool_bottleneck"} -> arms it
///   POST /labdemo/trigger/reset     undoes everything Triggers.Reset() can undo
///
/// THIS IS A SECOND WRITE PATH INTO A LIVE PRODUCTION, and it is deliberately NOT the governed one.
/// `Tools.Resolve` exists so an AI-recommended change is RBAC-checked, bounded, previewable,
/// reversible and audited. These triggers are the opposite by design: they BREAK the production on
/// purpose so there is something for Health Scan to detect. Routing them through the same governance
/// would be dishonest -- it would make "the AI may only change a pool size within 2..8" and "a demo
/// operator may disable a host and repoint a path" look like the same class of act.
///
/// So the boundary here is a different one, and it is stated rather than implied:
///
///   1. **A DEMO-ONLY FLAG.** `PG_DEMO_TRIGGERS` must be set, or every route returns 404 -- not 403.
///      404 because a disabled demo surface should be indistinguishable from one that was never
///      deployed; a 403 advertises that there is a way to break this production if you find the
///      credential. The shipped default is off, so `compose up` with no flag has no arming path.
///   2. **A FIXED SCENARIO LIST.** The scenario name is looked up in a `$case`, never dispatched
///      dynamically. `$classmethod("...Triggers", pName)` would turn one JSON field into "call any
///      class method in this namespace", which is a remote code execution primitive rather than a
///      demo convenience.
///   3. **NO PARAMETERS.** Every trigger is invoked with its own defaults. `SlowProcessing(ms)` and
///      `PoolBottleneck(ms, rate, warm, cap)` all take arguments, and accepting them from the wire
///      would mean validating four numeric ranges to prevent a caller pinning the instance with
///      `PoolBottleneck(1, 0.001, 0, 999999)`. The demo does not need the knobs.
///   4. **RESET IS ALWAYS AVAILABLE** when the flag is on, and takes no scenario name. The one
///      operation that makes the others safe must not be reachable only via a correct argument.
///
/// WHY NOT `%CSP.REST` AUTHENTICATION FOR THIS. The engine already authenticates to
/// `/labdemo/agent` with a credential from its environment, and the same credential reaches here.
/// That is sufficient BECAUSE of the flag: without it there is nothing to reach, and with it the
/// operator has deliberately opted a throwaway demo instance into being breakable. On anything that
/// is not a throwaway demo instance, do not set the flag.
///
/// `Triggers.Reset()` is the compensating control and it is genuinely complete for the three
/// scenarios exposed here -- each stashes what it replaced and restores it. One caveat inherited
/// from that class: `system_alert` cannot be reset from IRIS because the alert sits in the proxy's
/// in-memory buffer, which is why no alert scenario is exposed here.
Class ProductionGuardian.LabDemo.REST.TriggerDispatcher Extends %CSP.REST
{

/// The environment variable that must be set for any of this to exist.
///
/// Read at REQUEST time rather than cached in a parameter: a compiled-in value would need a
/// recompile to turn off, and "turn this off now" is the operation most likely to be urgent.
Parameter FLAGVAR = "PG_DEMO_TRIGGERS";

/// Scenarios that take longer to arm than the web server will wait, so they run as a background job.
///
/// A LIST RATHER THAN A DURATION THRESHOLD, because the cost is not measurable before the call: the
/// only way to know a scenario is slow is to know what it does. `pool_bottleneck` warms a baseline
/// for 75s; the other two return in under a second. Adding a scenario means deciding which side of
/// this it falls on, which is the decision that should be explicit.
Parameter SLOWSCENARIOS = {$listbuild("pool_bottleneck")};

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
<Route Url="/status" Method="GET" Call="Status"/>
<Route Url="/arm" Method="POST" Call="Arm"/>
<Route Url="/reset" Method="POST" Call="Reset"/>
</Routes>
}

/// True when the demo surface is enabled. Private.
ClassMethod Enabled() As %Boolean [ Private ]
{
    set v = $system.Util.GetEnviron(..#FLAGVAR)
    // Any non-empty value except an explicit "0"/"false", so `=1`, `=true` and `=yes` all work --
    // an operator who set the variable meant to set it, and failing on a spelling is worse than
    // being liberal here. The DEFAULT is what carries the safety, not the parsing.
    quit (v '= "") && (v '= "0") && ($zconvert(v, "L") '= "false")
}

/// Report what is armed. Also the endpoint the UI uses to decide whether to render the buttons.
///
/// PUBLISHES TWO MAPS, `armed` AND `activating`, because there are THREE states and only two of
/// them were previously observable. See `Scenarios()` for how the pair is derived; the short version
/// is that "the request was accepted" and "the scenario is in effect" are up to 75 seconds apart for
/// `pool_bottleneck`, and a presenter watching a button needs to tell those apart from each other
/// and from nothing having happened.
///
/// `armed` KEEPS ITS NAME ON THE WIRE even though the operator-facing word is now "trigger
/// activated". Two reasons: renaming it would break an older engine or dashboard against a newer
/// IRIS for no gain, and `armed` is the accurate technical word for what the global witnesses say.
/// The rename is a wording change in the UI, and it stays one.
ClassMethod Status() As %Status
{
    set %response.ContentType = "application/json"
    if '..Enabled() {
        quit ..Gone()
    }

    // ONE PASS OVER ONE TABLE. The published descriptors and both state maps come from the same
    // `Scenarios()` entries, so a scenario cannot be advertised without a witness pair or carry a
    // witness pair nobody advertises. Two lists here -- a %Push block plus a separate set of %Set
    // lines keyed by name -- is what this method had, and it is the stale-copy shape root CLAUDE.md
    // §6 names: adding a fourth scenario would have advertised a button whose state read `false`
    // forever.
    set out = { "enabled": true, "scenarios": [], "armed": {}, "activating": {} }
    set it = ..Scenarios().%GetIterator()
    while it.%GetNext(.index, .s) {
        // Only the four public fields reach the wire. The witness names are an implementation detail
        // of this class, and a caller keying on them would be reading our globals.
        do out.scenarios.%Push({ "id": (s.id), "label": (s.label), "detail": (s.detail),
            "findings": (s.findings) })

        // Read from the trigger globals rather than inferred, so the UI can show state instead of
        // assuming its own button presses are the whole truth. Someone driving the terminal at the
        // same time is a normal thing to do in a rehearsal.
        set requested = ''$data(^ProductionGuardian.Trigger(s.requestWitness))
        set inEffect = ''$data(^ProductionGuardian.Trigger(s.effectWitness))

        do out.armed.%Set(s.id, inEffect, "boolean")
        // ACTIVATING = the request landed and the scenario is not yet in effect. DERIVED, not
        // stored: a third global tracking "arming in progress" would be state that can disagree with
        // the two witnesses, and it would have to be cleared on every path a jobbed arm can die on.
        // This derivation cannot go stale, because it is two $data reads of the witnesses themselves.
        //
        // A scenario whose two witnesses are the SAME global is structurally never activating, which
        // is the right answer for one that arms atomically -- no branch is needed for that case and
        // none should be added. `missing_folder` and `closed_port` are both that shape.
        do out.activating.%Set(s.id, (requested && 'inEffect), "boolean")
    }

    write out.%ToJSON()
    quit $$$OK
}

/// The scenario table: what each one is, and the two globals that witness its state. Private.
///
/// THE THREE STATES, AND WHY ONE OF THEM NEEDS TWO WITNESSES.
///
///   not activated   neither witness present
///   activating      the request landed; the scenario is not in effect yet
///   activated       the scenario is in effect
///
/// The middle state is real and observable, not a UI nicety. `PoolBottleneck()` warms the baseline
/// at zero for 75 seconds BEFORE arming anything -- that wait is load-bearing (see that method, and
/// #43: a queue forming during warm-up caps the ratio near 2x and `queue_buildup` can then never
/// fire) -- and it runs as a background job, so the HTTP call returns in ~0.26s. For 75 seconds the
/// operator has a scenario that was accepted and is doing nothing yet. Reporting that as "not
/// activated" invites a second click; reporting it as "activated" is a claim the presenter notices
/// is false when no queue appears.
///
/// `effectWitness` IS THE ONE THAT MEANS "IN EFFECT", and for `pool_bottleneck` it is deliberately
/// NOT the stash. `DispatcherMs` is set unconditionally, only by this scenario, and only AFTER the
/// warm-up. `PoolWas` is set immediately BEFORE the wait, which makes it an honest witness for "the
/// request landed" and a wrong one for "armed" -- keying `armed` on it was #129's second bug, where
/// arming on an instance already at pool 1 stashed nothing and the button read "not armed" while the
/// scenario was fully armed. Verified on the live instance across one warm-up: `PoolWas` present
/// with `DispatcherMs` absent during the wait, both present after it.
///
/// `PathWas` and `PortWas` serve as BOTH witnesses for their scenarios, because those arm in one
/// step with nothing to wait for. Listing the same global twice states that, rather than leaving a
/// reader to infer it from a missing field, and it makes `activating` false by construction instead
/// of by a special case.
///
/// ONE HONEST AMBIGUITY, stated rather than papered over: `PoolWas` present with `DispatcherMs`
/// absent is also what a jobbed arm that DIED during its warm-up looks like. "Activating" is the
/// truthful report either way -- this class cannot see the job -- and `Reset()` clears the stash,
/// which is the recovery for both.
ClassMethod Scenarios() As %DynamicArray [ Private ]
{
    // The scenario list is published so the UI does not hardcode it. A button that posts a scenario
    // this class does not know would 400, and the UI having its own copy of the list is how that
    // happens -- the same stale-copy argument as the host list in root CLAUDE.md §6.
    set out = []
    do out.%Push({ "id": "pool_bottleneck", "label": "Pool bottleneck",
        "detail": "Throttles the downstream and raises inflow. Queue builds behind one worker; the fix is a bigger pool.",
        "findings": "queue_buildup, growing_queue_wait",
        "requestWitness": "PoolWas", "effectWitness": "DispatcherMs" })
    do out.%Push({ "id": "missing_folder", "label": "Missing directory",
        "detail": "Repoints EMR Source at a directory that does not exist. No governed fix -- the recommendation is words.",
        "findings": "dead_host",
        "requestWitness": "PathWas", "effectWitness": "PathWas" })
    do out.%Push({ "id": "closed_port", "label": "Downstream unreachable",
        "detail": "Points Cloud API at a closed port. The queue is a symptom; a bigger pool would only fail faster.",
        "findings": "elevated_error_rate, queue_buildup, throughput_drop",
        "requestWitness": "PortWas", "effectWitness": "PortWas" })
    quit out
}

/// Arm one named scenario.
ClassMethod Arm() As %Status
{
    set %response.ContentType = "application/json"
    if '..Enabled() {
        return ..Gone()
    }
    try {
        set body = ##class(%DynamicObject).%FromJSON(%request.Content)
        set scenario = body.%Get("scenario", "")

        // THE TRIGGERS WRITE TO THE CURRENT DEVICE, so their progress text lands in the HTTP
        // response body ahead of the JSON and the caller gets `non-JSON (HTTP 200)` for a call that
        // actually succeeded. Measured before the fix: the scenario armed, the engine reported a
        // parse failure, and the two disagreed about whether anything had happened -- the worst
        // shape for a demo control, because the operator retries an action that already worked.
        //
        // CAPTURED RATHER THAN SUPPRESSED, into a temporary file that becomes the current device for
        // the duration of the call. That text is the clearest explanation of each scenario anyone has
        // written -- what it arms, which findings to expect, which deliberately will NOT fire -- so
        // it is returned as `log` for the UI to show. Suppressing it would discard the one thing a
        // presenter wants on screen.
        //
        // A FILE rather than %Device.ReDirectIO: the redirect API dispatches to six labels in a
        // MAC routine, which this class is not, and a half-working redirect leaks into every
        // subsequent response on the same process. `use` on a file device is the smaller mechanism
        // and it restores in the `catch` too, which is what makes a failed trigger safe rather than
        // silently breaking the next request.
        set capturePath = "/tmp/pg-trigger-" _ $job _ ".log"
        set prior = $io
        set log = ""

        // A FIXED $case, not $classmethod. See the class comment: dynamic dispatch on a wire value
        // is arbitrary code execution wearing a scenario name.
        //
        // PoolBottleneck's defaults are used unchanged, which includes a 75-second baseline warm-up
        // -- so this call BLOCKS for over a minute. That is why the UI shows a pending state rather
        // than assuming a quick reply, and why the engine's timeout for this route is generous.
        //
        // The unknown-scenario branch is evaluated BEFORE the redirect opens, so a bad name never
        // creates a temp file. Checked separately for that reason rather than folded into the $case.
        if '$listfind($listbuild("pool_bottleneck", "missing_folder", "closed_port"), scenario) {
            set %response.Status = "400 Bad Request"
            write { "error": ("unknown scenario '" _ scenario _ "'"), "scenario": (scenario) }.%ToJSON()
            return $$$OK
        }

        // SCENARIOS THAT BLOCK LONGER THAN THE WEB SERVER WILL WAIT MUST BE JOBBED.
        //
        // The embedded Apache in this image answers **504 after exactly 60 seconds**, regardless of
        // what the engine or nginx allow. Measured directly against IRIS with no proxy in front:
        //
        //     POST /labdemo/trigger/arm {"scenario":"pool_bottleneck"}  ->  HTTP 504 in 60.2s
        //
        // `PoolBottleneck()` waits 75s BEFORE arming anything -- the baseline has to warm at exactly
        // zero or `queue_buildup` can never fire (see that method's comment, and #43). So the wait is
        // load-bearing and cannot be shortened, which means the REQUEST has to stop being long.
        //
        // Raising timeouts was the wrong fix and I tried it first: nginx 35s -> 180s and the engine
        // at 150s both sat outside a limit neither of them owned, and the symptom was unchanged.
        // The 504 came from IRIS itself.
        //
        // So a slow scenario is JOBBED and the route answers immediately with `pending`. The UI
        // already polls the armed state, so it learns the outcome from the state it was reading
        // anyway rather than from this response -- which is why this is a small change rather than a
        // new progress channel.
        //
        // No captured log for a jobbed scenario: there is no output to capture yet when the response
        // is written. `detail` carries what the scenario will do instead, which is the same text a
        // reader wants and is knowable in advance.
        if $listfind(..#SLOWSCENARIOS, scenario) {
            job ..JobScenario(scenario)::5
            if '$test {
                // Built first: a concatenation inside a %DynamicObject literal is #1021. Second time
                // in this class, so it is worth the note rather than the silent fix.
                set jobErr = "could not start the background job for '" _ scenario _ "'"
                set %response.Status = "503 Service Unavailable"
                write { "error": (jobErr) }.%ToJSON()
                return $$$OK
            }
            write { "armed": (scenario), "ok": true, "pending": true, "log": "",
                "note": "Warming the baseline at zero for ~75s before arming, so queue_buildup can fire. The armed indicator will appear when it starts." }.%ToJSON()
            return $$$OK
        }

        open capturePath:("NRW"):5
        if '$test {
            // Could not open the capture file. Run the trigger anyway with output going nowhere
            // useful rather than refusing to arm: the scenario matters more than its narration.
            set sc = ..Invoke(scenario)
        } else {
            use capturePath
            set sc = ..Invoke(scenario)
            use prior
            close capturePath
            set log = ..ReadCapture(capturePath)
        }

        if $$$ISERR(sc) {
            // 400 rather than 500 for an unknown name: it is the caller's input that is wrong. A
            // trigger that genuinely failed also lands here, which is imprecise but honest -- the
            // message carries the difference and the UI renders it.
            set %response.Status = "400 Bad Request"
            write { "error": ($system.Status.GetErrorText(sc)), "scenario": (scenario) }.%ToJSON()
            return $$$OK
        }

        write { "armed": (scenario), "ok": true, "log": (log) }.%ToJSON()
        return $$$OK
    } catch ex {
        // RESTORE THE DEVICE FIRST, before anything that writes. A leaked redirect would send this
        // error response -- and every subsequent response on this process -- into a temp file, so
        // the visible symptom of a failed trigger would be an empty reply to an unrelated request.
        use prior
        set %response.Status = "500 Internal Server Error"
        write { "error": ("arm failed: " _ ex.DisplayString()) }.%ToJSON()
        return $$$OK
    }
}

/// Entry point for a JOBBED scenario. Public because `job` cannot reach a private method.
///
/// `job ..Invoke(...)` starts a NEW PROCESS, and a private method is not callable from one --
/// measured as `<PRIVATE METHOD> 197 Arm+66`, returned as a 200 with an error rather than a crash,
/// which is why it looked like a logic bug rather than a visibility one.
///
/// PUBLIC BUT NOT A WIDER SURFACE. It is not a `%CSP.REST` route, so it is unreachable over HTTP;
/// it re-checks `Enabled()` so a jobbed call cannot outlive the flag being turned off mid-run; and it
/// takes only a scenario name, which `Invoke` validates against the same fixed `$case`. An unknown
/// name is a no-op status rather than a dispatch.
ClassMethod JobScenario(scenario As %String) As %Status
{
    if '..Enabled() {
        quit $$$ERROR($$$GeneralError, "demo triggers are not enabled")
    }
    quit ..Invoke(scenario)
}

/// Run one named scenario. Private, and the only place the scenario names map to methods.
///
/// Split out of Arm() so the mapping is not tangled with the IO redirect around it -- and so the
/// name check in Arm() and this $case cannot drift into disagreeing about which names are real.
ClassMethod Invoke(scenario As %String) As %Status [ Private ]
{
    quit $case(scenario,
        "pool_bottleneck": ##class(ProductionGuardian.LabDemo.Triggers).PoolBottleneck(),
        "missing_folder":  ##class(ProductionGuardian.LabDemo.Triggers).MissingFolder(),
        "closed_port":     ##class(ProductionGuardian.LabDemo.Triggers).ErrorRate(),
        : $$$ERROR($$$GeneralError, "unknown scenario '" _ scenario _ "'"))
}

/// Read a capture file back as one string and delete it. Private.
ClassMethod ReadCapture(path As %String) As %String [ Private ]
{
    set out = ""
    set stream = ##class(%Stream.FileCharacter).%New()
    if $$$ISOK(stream.LinkToFile(path)) {
        while 'stream.AtEnd {
            // Bounded: a runaway trigger must not put megabytes into a JSON field. 4000 characters
            // is far more than any scenario prints and small enough to render in a rail panel.
            if $length(out) > 4000 {
                set out = out _ $char(10) _ "... truncated"
                quit
            }
            set out = out _ stream.ReadLine() _ $char(10)
        }
    }
    do ##class(%File).Delete(path)
    quit out
}

/// Undo everything the trigger class can undo. Takes no argument, deliberately.
ClassMethod Reset() As %Status
{
    set %response.ContentType = "application/json"
    if '..Enabled() {
        return ..Gone()
    }
    try {
        // SAME CAPTURE AS Arm(), for the same reason and it was missed here first: Reset() writes a
        // long summary of what it restored, so without this the response body is that text followed
        // by JSON and the caller reports `non-JSON (HTTP 200)` for a reset that worked. Found by
        // testing both routes rather than assuming the fix generalised -- Arm() was clean and this
        // was not, in the same commit.
        set capturePath = "/tmp/pg-trigger-reset-" _ $job _ ".log"
        set prior = $io
        set log = ""

        open capturePath:("NRW"):5
        if '$test {
            set sc = ##class(ProductionGuardian.LabDemo.Triggers).Reset()
        } else {
            use capturePath
            set sc = ##class(ProductionGuardian.LabDemo.Triggers).Reset()
            use prior
            close capturePath
            set log = ..ReadCapture(capturePath)
        }

        if $$$ISERR(sc) {
            set %response.Status = "500 Internal Server Error"
            write { "error": ($system.Status.GetErrorText(sc)) }.%ToJSON()
            return $$$OK
        }
        // The known-incomplete part of a reset, stated in the response rather than only in a class
        // comment nobody reading a UI will see: a system_alert finding outlives this because the
        // alert is buffered in the proxy, a Node process IRIS cannot reach.
        write { "ok": true, "log": (log),
            "note": "Findings clear within ~10s. A system_alert finding persists until it ages out of the proxy's buffer." }.%ToJSON()
        return $$$OK
    } catch ex {
        // Device restored before writing, as in Arm().
        use prior
        set %response.Status = "500 Internal Server Error"
        write { "error": ("reset failed: " _ ex.DisplayString()) }.%ToJSON()
        return $$$OK
    }
}

/// 404, for a disabled demo surface. Private.
///
/// NOT 403. A 403 says "this exists and you may not use it", which tells a reader of a production
/// instance that there is a way to break it if they find the right credential. 404 says nothing.
ClassMethod Gone() As %Status [ Private ]
{
    set %response.Status = "404 Not Found"
    write { "error": "not found" }.%ToJSON()
    quit $$$OK
}

}
