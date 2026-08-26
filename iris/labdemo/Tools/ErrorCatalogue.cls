/// The error-code allowlist and its summary catalogue — one copy, shared by every tool that reads
/// `Ens_Util.Log`.
///
/// Both methods were `[ Private ]` on `Tools.Read` until `Tools.EventLog` needed the same allowlist.
/// They moved here rather than being copied, and the reason is the allowlist's own comment: it is the
/// PHI boundary for the log, and a boundary that exists in two places is one that gets widened in one
/// of them. `contracts/mcp-tools.md` §3.4a says "adding a row is a contract change" — that promise is
/// only checkable while there is a single row set to review.
///
/// NOT A `%AI.Tool` SUBCLASS, deliberately, and that is what makes the methods safe to make public.
/// `%AI.ToolMgr.FindTools` filters on `$$issubclassof(className, "%AI.Tool")`, so nothing here can
/// become an LLM-callable tool no matter how many public methods it grows. Putting them on a tool
/// class as public methods would have added two tools; leaving them private on one tool class would
/// have forced a copy onto the other. This class is the third option.
///
/// `Tools.Governance` uses the same technique for the same reason — see its class comment.
Class ProductionGuardian.LabDemo.Tools.ErrorCatalogue
{

/// Map error text to an allowlisted code, or "unclassified".
///
/// ALLOWLIST, never a denylist. Anything unrecognised yields "unclassified" and NO text, so a
/// novel error message cannot leak through a gap in a pattern list. A denylist would need to
/// anticipate every shape PHI can take in a log line, which is not a bet worth taking on a
/// healthcare system.
///
/// THE CALLER PASSES TEXT IN AND NEVER GETS TEXT OUT. That asymmetry is the whole design: the text
/// crosses into this method, and only a fixed token from the list below crosses back. A caller can
/// therefore read `Ens_Util.Log.Text` without any of it reaching a payload.
ClassMethod Classify(text As %String) As %String
{
    set known = $listbuild(
        "<Ens>ErrFailureTimeout",
        "<Ens>ErrConnectionLost",
        "<Ens>ErrHTTPStatus",
        "<Ens>ErrGeneral",
        "<Ens>ErrProductionSettingInvalid",
        "<Ens>ErrTCPTerminatedReadTimeoutExpired",
        "#6059",
        "#5001",
        "#5021")
    set ptr = 0
    while $listnext(known, ptr, token) {
        if text [ token {
            quit
        }
        set token = ""
    }
    quit $select(token '= "": token, 1: "unclassified")
}

/// The `summary` catalogue — `contracts/mcp-tools.md` §3.4a.
///
/// A FIXED STRING LOOKED UP BY `errorCode`, never derived from the log row. That is the whole reason
/// it is safe to send: `Ens_Util.Log` on this instance holds 61,772 rows carrying `PatientID` in
/// plain text, and a summary built from the row would carry whatever the row carries. A catalogue
/// cannot, by construction.
///
/// THE ALLOWLIST MUST NOT GAIN AN EXCEPTION FOR `#5021`. The tempting shortcut for MVP 3's scenario
/// is to return that error's message text, because it contains the missing path and the path is
/// *usually* harmless. That is the wrong shape twice: an allowlist with one exception is one an
/// implementer widens, and "usually harmless" is the rare-rather-than-absent pattern that survives
/// review and then leaks. The agent learns the KIND of fault here and the offending path from
/// `GetHostSettings` -- configuration, which the boundary permits.
///
/// Adding a row is a contract change (§3.4a), deliberately: a code that reaches an agent with a
/// human-readable meaning is a decision about what the model is told.
///
/// THE CATALOGUE DOES NOT COVER EVERY ROW, and that is measured rather than assumed. Classifying all
/// 60 `Type <= 3` rows on this instance yields 47 codes and 13 `unclassified` -- and all 13 are
/// production-lifecycle rows written by `Ens.Director`, which have no `ConfigName` at all. So the
/// gap is not random: it is the rows that belong to the production rather than to a host. That is
/// why `Tools.EventLog` publishes a VERIFIED `SourceClass`/`SourceMethod` pair alongside the code --
/// for those 13 rows it is the only thing that says what kind of event they were, and a class name
/// checked against `%Dictionary.CompiledClass` is configuration by the same reasoning `#5021`'s path
/// is not.
ClassMethod Summary(code As %String) As %String
{
    // Returns "" for anything not listed, which callers emit as JSON null -- §3.4a's
    // "null when unclassified". An unknown code gets a count and no interpretation, which is honest:
    // the agent can see something is failing and cannot be told what it means.
    quit $case(code,
        "#5021": "a configured directory or file path does not exist",
        "#6059": "the configured downstream host or port could not be reached",
        "#5001": "a general IRIS error was raised while handling a message",
        "<Ens>ErrFailureTimeout": "the host retried and gave up within its failure timeout",
        "<Ens>ErrConnectionLost": "the connection to the downstream target was lost",
        "<Ens>ErrHTTPStatus": "the downstream returned an HTTP status the adapter treats as an error",
        "<Ens>ErrProductionSettingInvalid": "a production setting on this host is not a valid value",
        "<Ens>ErrTCPTerminatedReadTimeoutExpired": "a TCP read timed out before the downstream replied",
        "<Ens>ErrGeneral": "the interoperability framework raised a general error",
        : "")
}

}
