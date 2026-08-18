/// Authorization policy for the Production Guardian MCP tools.
///
/// WHY THIS CLASS HAS TO EXIST, and it is not a formality. `contracts/resolve-api.md` §9.4 states
/// that authorization is enforced by the runtime, which is true -- `%AI.ToolMgr.ExecuteTool` calls
/// `AuthorizationPolicy.can_execute()` before every invocation. But that claim is VACUOUS by
/// default, and I confirmed it rather than assuming the shipped behaviour was safe:
///
///     %AI.ToolMgr.%New().AuthPolicy   ->  <none>
///     %AI.Policy.Authorization::%CanExecute  ->  Return $$$OK
///
/// So with no policy registered, the runtime faithfully asks a policy that permits everything.
/// "Enforced by the runtime" is only a safety property if the configured policy REFUSES, and
/// nothing configured one. Every guard inside `Tools.Resolve` still applies -- the whitelist, the
/// bounds, the production checks -- but they are the tool defending itself, not an authorisation
/// boundary. This class is the boundary.
///
/// NOT `%AI.Policy.ConsoleAuth`, which is the other shipped option and looks like the obvious
/// choice. Reading it settles that: it writes an ANSI-coloured "Authorization Request" box to the
/// terminal and waits for a human to answer. That is correct for `%AI.Shell.Console` and wrong
/// here -- an agent invoked over HTTP has no terminal, so the prompt would either block forever or
/// be answered by nobody. It also gates on `%System_Callout:USE`, which is a privilege about
/// calling out of IRIS, not about changing a production.
///
/// THE MODEL: least privilege, split two ways, because `%CanList` and `%CanExecute` are separate
/// hooks and that separation is the demo the spec asks for.
///
///   read tools    listable and executable with PG_Read
///   set_pool_size LISTABLE with PG_Read, EXECUTABLE only with PG_Resolve
///
/// Listable-but-not-executable is deliberate. Hiding the write tool from an unauthorised caller
/// would make "you may not do this" indistinguishable from "this product cannot do this", and the
/// agent could not even name the action it recommends. Showing it and refusing execution is what
/// lets a dashboard render a disabled Approve button WITH A REASON -- and it is precisely the
/// "AI Detective can look without having permission to act" story.
///
/// OBSERVED DENIAL, which resolve-api.md §9.4 makes an acceptance criterion rather than an
/// assumption. Measured against ProductionGuardian.Test.StubPolicy:
///
///   holds PG_Read only     SetPoolSize    DENIED, "requires PG_Resolve:USE"
///                          SetPoolSize    listable = 1   <- visible but denied
///                          GetQueueDepth  allowed
///   holds both             SetPoolSize    allowed
///   holds nothing          GetQueueDepth  DENIED, "requires PG_Read:USE"
///                          GetQueueDepth  listable = 0
///
/// The deny branch is unreachable from any session that can run this code: $SYSTEM.Security.Check
/// returns 1 for every resource when the caller holds %All, including resources that do not exist.
/// So the test injects the resource set rather than manufacturing an unprivileged user, and the
/// stub class says what that does and does not prove.
///
/// ROLE NAMES CANNOT START WITH `%`. contracts/mcp-tools.md and resolve-api.md both write
/// `%Guardian_Read` / `%Guardian_Resolve`; IRIS refuses those with `ERROR #887: Invalid role name`
/// -- the `%` prefix is reserved for system roles. The created roles are `Guardian_Read` and
/// `Guardian_Resolve`, unprefixed, and the contracts need correcting. Recorded here because the
/// contracts are ratified and a silent divergence is worse than a noted one.
Class ProductionGuardian.LabDemo.Tools.AuthPolicy Extends %AI.Policy.Authorization
{

/// IRIS resource required to see any Production Guardian tool.
Parameter READRESOURCE = "PG_Read";

/// IRIS resource required to EXECUTE the one mutating tool.
Parameter WRITERESOURCE = "PG_Resolve";

/// The tool that mutates a live production. Named rather than pattern-matched: a rule like
/// "anything containing Set" would silently start gating a future GetSettings, and worse, would
/// silently STOP gating a rename to ApplyPoolSize.
Parameter WRITETOOL = "SetPoolSize";

/// May this caller see the tool at all?
///
/// Everything Production Guardian exposes needs PG_Read to be listed, including the write tool --
/// see the class comment for why the write tool is listable rather than hidden.
Method %CanList(tool As %String, metadata As %DynamicObject) As %Boolean
{
    quit ..HasResource(..#READRESOURCE)
}

/// May this caller run it?
///
/// Returns %Status rather than a boolean, which is what lets a refusal carry a REASON -- and the
/// reason is what a UI needs in order to explain a disabled button instead of just disabling it.
Method %CanExecute(tool As %String, call As %DynamicObject, metadata As %DynamicObject) As %Status
{
    // Tool NAME from the call, not from `tool`, which arrives as a JSON descriptor string in the
    // shipped ConsoleAuth implementation. Reading the wrong one would compare a name against a
    // blob and never match -- a gate that silently permits everything, which is the exact defect
    // this class exists to fix.
    set name = ""
    if $isobject(call) {
        set name = call.%Get("name", "")
    }
    if name = "" {
        // FAIL CLOSED. A call we cannot identify is not a call we can authorise, and defaulting to
        // allow here would reintroduce the permissive default in a subtler form.
        quit $$$ERROR($$$GeneralError, "tool call carried no name, so it cannot be authorised")
    }

    // Every tool needs PG_Read. Checked first so an unprivileged caller gets one clear answer
    // rather than a different one per tool.
    if '..HasResource(..#READRESOURCE) {
        quit $$$ERROR($$$GeneralError, "'" _ name _ "' requires " _ ..#READRESOURCE _ ":USE")
    }

    // The mutating tool needs the privileged resource ON TOP of PG_Read.
    if name = ..#WRITETOOL {
        if '..HasResource(..#WRITERESOURCE) {
            // The message names the rule and the missing privilege, and NOTHING else. A refusal
            // string crosses the same boundary to the model as any other tool output, so it must
            // not carry instance data -- no host names, no queue depths, no user identity.
            // One line: a $$$ macro cannot span lines -- MPP5612 "Referenced macro missing right
            // paren". Building the message first keeps it readable without breaking the macro.
            set why = "'" _ name _ "' modifies a live production and requires " _ ..#WRITERESOURCE _ ":USE"
            quit $$$ERROR($$$GeneralError, why)
        }
    }

    quit $$$OK
}

/// True when the current user holds USE on a resource. Private.
///
/// $SYSTEM.Security.Check is the same mechanism the shipped ConsoleAuth uses, so this follows the
/// platform's own convention rather than inventing one.
Method HasResource(resource As %String) As %Boolean [ Private ]
{
    quit ''$SYSTEM.Security.Check(resource, "USE")
}

}
