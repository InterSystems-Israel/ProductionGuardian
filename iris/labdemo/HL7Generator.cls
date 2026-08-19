/// Synthetic HL7 v2 message generator for the LABDEMO production.
///
/// Writes ADT^A01 messages to /tmp/labdemo/hl7-in/ on a configurable interval
/// so the production has continuous message flow. ADT^A01 is the only type
/// emitted, and the only type the routing rule routes.
///
/// Usage:
///   // Generate 20 messages with 2-second gaps (default):
///   do ##class(ProductionGuardian.LabDemo.HL7Generator).Run()
///
///   // Generate 50 messages with 500ms gaps:
///   do ##class(ProductionGuardian.LabDemo.HL7Generator).Run(50, 0.5)
///
///   // Run continuously until Ctrl-C:
///   do ##class(ProductionGuardian.LabDemo.HL7Generator).RunContinuous(2)
///
/// The generated messages use realistic but entirely fictitious patient data.
Class ProductionGuardian.LabDemo.HL7Generator
{

/// Default output directory — must match the EMR Source FilePath setting.
Parameter DropDir = "/tmp/labdemo/hl7-in/";

/// Generate `count` messages with `delaySecs` between each.
ClassMethod Run(count As %Integer = 20, delaySecs As %Double = 2) As %Status
{
    set sc = ..EnsureDropDir()
    quit:$$$ISERR(sc) sc

    write "Generating ", count, " HL7 messages to ", ..#DropDir, " ...", !
    for i = 1:1:count {
        set msg = ..BuildADTA01(i)
        set msgType = "ADT_A01"
        set filename = ..#DropDir _ msgType _ "_" _ $translate($horolog, ",", "_") _ "_" _ i _ ".hl7"
        set sc = ..WriteFile(filename, msg)
        if $$$ISERR(sc) {
            write "  ERROR writing ", filename, !
            do $system.Status.DisplayError(sc)
        } else {
            write "  [", i, "/", count, "] ", msgType, " → ", filename, !
        }
        if (delaySecs > 0) && (i < count) {
            hang delaySecs
        }
    }
    write "Done.",!
    quit $$$OK
}

/// Run continuously, generating one message every delaySecs until interrupted.
///
/// THE INTERVAL IS RE-READ EVERY ITERATION, from `^ProductionGuardian.Trigger("RateSecs")` when
/// that global is set, falling back to the `delaySecs` argument. `delaySecs` is therefore the
/// starting rate, not a fixed one.
///
/// Why: MVP 2's scenario needs inbound volume raised above the ~1 msg/sec Cloud API ceiling
/// mid-demo ("bombard"). This method is normally `job`-ed by FirstBoot, so an argument-only rate
/// would mean killing that background process and starting another to change it -- on stage, with
/// the audience watching, and with a gap in the traffic that shows up as a throughput dip right
/// before the demo wants to show a queue building. A global read per iteration costs nothing and
/// takes effect within one interval.
///
/// Same pattern as the injected delay in PatientDemographicsOperation: a global read at runtime,
/// so nothing is edited or recompiled mid-demo, and Triggers.Reset() clears it.
///
/// RECOMPILING THIS CLASS DOES NOT AFFECT A GENERATOR ALREADY RUNNING, and that distinction cost me
/// a run to learn. `FirstBoot.StartGenerator()` `job`s this method, and the loop below never returns
/// -- so the process keeps executing the routine version it loaded at start, and new CODE reaches it
/// only after the process is restarted. The rate override works on a running generator precisely
/// because the old code already read that global; the depth cap added for #101 did nothing until the
/// job was cycled, while the queue sailed past it to 231.
///
/// So: a fresh `docker compose up` picks up changes here, and a mid-session recompile needs
///
///     do ##class(%SYSTEM.Process).Terminate(pid)   // pid from %SYS.ProcessQuery, Routine LIKE '%HL7Generator%'
///     do ##class(ProductionGuardian.Setup.FirstBoot).StartGenerator(2)
///
/// A global that changes BEHAVIOUR the existing code already reads takes effect within one interval;
/// a global that only new code reads takes effect never, and looks identical from the outside.
ClassMethod RunContinuous(delaySecs As %Double = 2)
{
    set sc = ..EnsureDropDir()
    quit:$$$ISERR(sc)

    write "Continuous HL7 generation started (Ctrl-C to stop). Interval: ", delaySecs, "s",!
    write "  Rate is re-read from ^ProductionGuardian.Trigger(""RateSecs"") each message.",!
    write "  Depth cap re-read from ^ProductionGuardian.Trigger(""MaxQueued"") each message.",!
    set i = 1
    set paused = 0
    for {
        // THE DEPTH CAP, checked BEFORE producing rather than after (#101). `PoolBottleneck()` arms
        // the scenario and exits, so nothing in the trigger can bound the backlog -- the only place
        // that can is the loop actually producing load. A run left armed reached 2,650 queued and
        // IRIS's embedded Apache stopped serving on :52773 entirely, taking the portal, the metrics
        // endpoint the proxy polls and the agent dispatcher with it for ~40 minutes.
        //
        // PAUSES, DOES NOT STOP, and that is what keeps the demo's shape. Depth climbs, the
        // queue_buildup finding fires and stays lit -- the cap is far above the rule's absolute
        // floor of 50 -- and once Smart Resolve raises the pool the queue drains and inflow resumes
        // by itself as depth falls back under the cap. A generator that stopped would need
        // restarting mid-demo, in front of an audience, and the visible drain is the last step of
        // the whole MVP 2 loop.
        //
        // THIS REDUCES EXPOSURE RATHER THAN FIXING THE WEDGE. If worker exhaustion is the
        // mechanism, a smaller backlog makes it less likely and not impossible. Stated so nobody
        // reads the cap as a fix and closes #101 on the strength of it.
        //
        // THE PAUSE IS UNBOUNDED, DELIBERATELY. @Ari-Glikman's parallel implementation (#103) capped
        // it at 300s and then resumed with a warning, so a permanently stuck queue could not silence
        // the generator forever -- a demo showing no traffic reads as dead rather than stuck. He
        // flagged it as a guess and left the call here; declining it, because the argument against is
        // stronger than the argument for.
        //
        // If the queue is genuinely not draining, resuming inflow makes it worse, and unbounded
        // inflow into a non-draining queue is exactly what wedged the web server in #101. A timed
        // resume would convert a visible stall into the failure this cap exists to prevent.
        //
        // The visibility concern is real and is answered better elsewhere: `Triggers.Status()`
        // prints the cap beside the live depth and says "PAUSED, inflow held", so "held at the cap"
        // and "stuck" are distinguishable without putting more messages into a queue that is not
        // moving. Diagnose with Status(), not by resuming.
        set cap = +$get(^ProductionGuardian.Trigger("MaxQueued"), 0)
        if cap > 0 {
            set depth = ..QueueDepth()
            if (depth '= "") && (depth >= cap) {
                if 'paused {
                    // Announced ONCE per pause, not per iteration. A line every interval would bury
                    // the drain a presenter is watching for under identical messages.
                    write $zdatetime($ztimestamp, 3, 1), "  PAUSED at ", depth, " queued (cap ", cap, ")", !
                    set paused = 1
                }
                // Re-check on the same cadence as production, so inflow resumes within one interval
                // of the queue dropping under the cap.
                set override = +$get(^ProductionGuardian.Trigger("RateSecs"), 0)
                hang $select(override > 0: override, 1: delaySecs)
                continue
            }
            if paused {
                write $zdatetime($ztimestamp, 3, 1), "  RESUMED at ", depth, " queued (cap ", cap, ")", !
                set paused = 0
            }
        }

        set msg = ..BuildADTA01(i)
        set msgType = "ADT_A01"
        set filename = ..#DropDir _ msgType _ "_" _ $translate($horolog, ",", "_") _ "_" _ i _ ".hl7"
        do ..WriteFile(filename, msg)  // errors are silent in continuous mode
        write $zdatetime($ztimestamp, 3, 1), "  ", msgType, !
        // Re-read per iteration. Guarded: a zero or negative override would spin this loop as
        // fast as the filesystem allows, which is a way to take the instance down rather than a
        // way to demonstrate a queue -- so anything not strictly positive falls back to the
        // argument.
        set override = +$get(^ProductionGuardian.Trigger("RateSecs"), 0)
        hang $select(override > 0: override, 1: delaySecs)
        set i = i + 1
    }
}

/// Current queue depth for the bottlenecked host, or "" when it cannot be read. Private.
///
/// "" AND NOT 0, by the rule this project keeps relearning (#33, #49): an unmeasurable depth is not
/// a small one. A failed read returning 0 would compare below any cap and let the generator produce
/// without limit -- which is the exact condition the cap exists to prevent, reached through the cap's
/// own error path.
///
/// Reads `Ens.Queue.GetCount` rather than EnumerateHostStatus: verified signature
/// `GetCount(pQueueName)`, the queue name is the config item name, and it is one call per message
/// rather than a result set.
ClassMethod QueueDepth() As %String [ Private ]
{
    // `return`, not `quit`. Inside a TRY block `quit` is the block terminator and cannot carry an
    // argument -- `#1043: QUIT argument not allowed`, which is a compile error rather than a runtime
    // one and so failed the whole class. Worth a note because every other method in this area uses
    // argumentless `quit` to return, and this is the one place that shape is wrong.
    set depth = ""
    try {
        // Triggers.#OPERATION rather than a second copy of "Cloud API" -- that parameter exists so
        // the name lives in one place (root CLAUDE.md §5), and a stale copied host name is #84.
        set host = ##class(ProductionGuardian.LabDemo.Triggers).#OPERATION
        set depth = ##class(Ens.Queue).GetCount(host)
    } catch ex {
        set depth = ""
    }
    quit depth
}

/// Build an ADT^A01 (Admit) message.
ClassMethod BuildADTA01(seq As %Integer) As %String [ Private ]
{
    set ts = $translate($zdatetime($ztimestamp, 8), "-:T ", "")
    set ts = $extract(ts, 1, 14)
    set pid = $random(899999) + 100000  // 6-digit patient ID
    set msgCtrl = "MSG" _ $extract(ts, 1, 8) _ $translate($justify(seq, 5), " ", "0")

    // HL7 v2.5 ADT^A01 — segment separator is carriage return (\r = char 13)
    set cr = $char(13)
    set msg =
        "MSH|^~\&|EMRSYSTEM|LABDEMO|LABROUTER|LABDEMO|" _ ts _ "||ADT^A01^ADT_A01|" _ msgCtrl _ "|P|2.5" _ cr _
        "EVN|A01|" _ ts _ cr _
        "PID|1||" _ pid _ "^^^LABDEMO^MR||DOE^JOHN^A||19800101|M|||123 MAIN ST^^SPRINGFIELD^IL^62701||555-555-" _ $translate($justify($random(9999), 4), " ", "0") _ cr _
        "PV1|1|I|3W^301^A^LABDEMO|||||||MED||||1|||" _ pid _ "^^^LABDEMO^VN|" _ cr
    quit msg
}

/// Write a string to a file. Creates the file if it doesn't exist.
ClassMethod WriteFile(path As %String, content As %String) As %Status [ Private ]
{
    set file = ##class(%Stream.FileCharacter).%New()
    set file.Filename = path
    do file.Write(content)
    quit file.%Save()
}

/// Create the drop directory and archive directory if they don't exist.
ClassMethod EnsureDropDir() As %Status [ Private ]
{
    set tStatus = $$$OK
    set dirs = $listbuild(..#DropDir, "/tmp/labdemo/hl7-archive/")
    set ptr = 0
    while $listnext(dirs, ptr, dir) {
        if '##class(%File).DirectoryExists(dir) {
            if '##class(%File).CreateDirectoryChain(dir) {
                set tStatus = $$$ERROR($$$GeneralError, "Could not create directory: " _ dir)
                quit
            }
        }
    }
    quit tStatus
}

}
