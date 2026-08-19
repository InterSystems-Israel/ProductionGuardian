/// Audit policy for the Production Guardian MCP tools — persists what the runtime only announces.
///
/// WHAT THE RUNTIME ACTUALLY GIVES US, measured on build 126 rather than read from documentation.
/// `%AI.Policy.Audit.%LogExecution(call, metadata, result, duration, status)` is called by
/// `%AI.ToolMgr.ExecuteTool` after a tool runs. A real payload, captured from a live
/// `GetPoolSize("Cloud API")`:
///
///     call     {"id":"call_id","name":"GetPoolSize","arguments":"{\"host\":\"Cloud API\"}"}
///     metadata {}
///     result   {"tool_name":"GetPoolSize","result_json":"{...}","display_text":null}
///     duration 0
///     status   OK
///
/// Four things in that payload are not what `contracts/mcp-tools.md` §5.5 assumes, and each one
/// changes the implementation:
///
///   1. `call.id` is the LITERAL STRING "call_id" -- a placeholder, not an identifier. It is
///      identical on every call, so it cannot be the `auditId` that `resolve-api.md` §8 promises.
///      The handle is minted by `Audit.Entry` instead.
///   2. `call.arguments` is a JSON STRING, not an object. Iterating it yields nothing.
///   3. `metadata` is EMPTY. There is no caller identity in the payload, so `actor` comes from
///      `$username` -- which is also the only value a caller cannot forge.
///   4. `duration` is 0 for a call `ExecuteTool` itself timed at 0.0071 s. It is integer
///      milliseconds and every read tool here returns faster than that.
///
/// AND THE ONE THAT MATTERS MOST: this hook never runs for an authorization denial.
/// `ExecuteTool` checks the authorization policy, then executes, then audits, and a denial THROWS
/// `<%AICore>ToolAccessDenied` at the first step. Measured with a deny-all policy registered:
/// `%LogExecution` was not called and 0 rows were written. So `mcp-tools.md` §5.5's "a failed or
/// refused call is audited too" is true of a TOOL-LEVEL refusal -- our bounds guard returning
/// `outcome: "refused"` is audited, because the tool ran -- and false of `not_authorized`, which is
/// the one a security review asks about. `Tools.AuthPolicy` closes that half by recording its own
/// denials; see its class comment. Neither class can do it alone and the split is the runtime's,
/// not ours.
///
/// NEVER FAILS THE CALL. Every path returns $$$OK. By the time this runs the tool has executed and,
/// for `SetPoolSize`, the production has already changed -- so an error here would report failure
/// for a change that happened. An unwritable audit surfaces as `auditId: null`
/// (`resolve-api.md` §8), not as a fabricated success and not as a %Status nobody can act on.
Class ProductionGuardian.LabDemo.Tools.AuditPolicy Extends %AI.Policy.Audit
{

/// Record one executed tool call.
Method %LogExecution(call As %DynamicObject, metadata As %DynamicObject, result As %DynamicObject, duration As %Integer, status As %Status) As %Status
{
    // WRAPPED WHOLE. A <PROPERTY DOES NOT EXIST> in here would propagate out of ExecuteTool and
    // turn a successful pool change into an exception at the caller -- the audit reporting a failure
    // for a change that already landed. The tool has already run; nothing this method does may
    // change that outcome.
    try {
        set name = ""
        set args = ""
        if $isobject(call) {
            set name = call.%Get("name", "")
            // A STRING, not an object (measured -- see the class comment). Stored as received rather
            // than parsed and re-serialised, so the record shows exactly what the runtime passed.
            set args = call.%Get("arguments", "")
        }

        // `result_json` is where the tool's own return value lives; `display_text` was null on every
        // payload observed. Fall back to the whole object rather than to "" so an unexpected shape
        // still leaves evidence instead of an empty column.
        set payload = ""
        if $isobject(result) {
            set payload = result.%Get("result_json", "")
            if payload = "" {
                set payload = result.%ToJSON()
            }
        }

        set errText = ""
        if $$$ISERR(status) {
            set errText = $system.Status.GetErrorText(status)
        }

        do ##class(ProductionGuardian.LabDemo.Audit.Entry).Record(
            $username, name, args, payload, "executed", duration, errText)
    } catch ex {
        // Deliberately swallowed, and this is the one place in the area where that is right. There is
        // no device to write to -- an agent invoked over HTTP has no terminal -- and the alternative
        // is failing a completed call. The absence of a row IS the signal: `resolve-api.md` §8 makes
        // a missing `auditId` on an apply a `failed`/`verify` outcome rather than a silent success,
        // so a caller that needs the guarantee still gets one.
    }
    quit $$$OK
}

}
