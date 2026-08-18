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
ClassMethod RunContinuous(delaySecs As %Double = 2)
{
    set sc = ..EnsureDropDir()
    quit:$$$ISERR(sc)

    write "Continuous HL7 generation started (Ctrl-C to stop). Interval: ", delaySecs, "s",!
    write "  Rate is re-read from ^ProductionGuardian.Trigger(""RateSecs"") each message.",!
    set i = 1
    for {
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
