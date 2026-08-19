# AI Hub API surface, verified on our image

Working notes for MVP 2, not a contract. Everything here was **introspected from the running
`pg-iris` container**, not read from documentation — because the `aihub-eap` skill documents
build **162** and we run build **126**, and the skill itself records that builds 141 → 159 → 161
→ 162 each broke something. Assuming a version's API is how you spend a day on
`<PROPERTY DOES NOT EXIST>`.

```
IRIS for UNIX (Ubuntu Server LTS for x86-64 Containers) 2026.3.0AI
  (Shelves 8246870 9296934 9324128) (Build 126U) Tue Jul 21 2026
```

## What we have, and it is more than expected

Build 126 carries the classes the skill lists as **new in 162**, including the ones it warns are
absent on enterprise 161. So the skill's newest patterns apply to us:

| Group | Present |
|---|---|
| Agent core | `%AI.Agent`, `%AI.Agent.Session`, `%AI.Agent.Skill`, `%AI.Agent.SubAgent` |
| Tools | `%AI.Tool`, `%AI.ToolMgr`, `%AI.Tool.Generator`, `%AI.Tool.Resolver`, `%AI.Tool.Schema` |
| ToolSet spec | `%AI.ToolSet` + `%AI.ToolSet.Specification.*` (incl. `MCP`, `MCP.Remote`, `MCP.Stdio`) |
| Built-in tools | `%AI.Tools.SQL`, `%AI.Tools.FileSystem`, `%AI.Tools.ShellTools` |
| Governance | `%AI.Policy.Authorization`, `%AI.Policy.Audit`, `%AI.Policy.Discovery` |
| MCP service | `%AI.MCP.Service` |
| Config / secrets | `%AI.Utils.ConfigStore`, `%AI.Utils.SettingStore`, `%AI.Utils.WalletStore`, `%ConfigStore.Configuration` |
| LLM | `%AI.Provider`, `%AI.LLM.Context`, `%AI.LLM.Response`, `%AI.LLM.ContentPart` |
| RAG | `%AI.RAG.*` — present, and out of scope for MVP 2 |

## `%AI.Agent` — the methods and properties we will actually use

Introspected signatures, not guessed:

```
%Init(context:%DynamicObject = {})        -> %Status     REQUIRED before the first Chat
%OnInit()                                 -> %Status     the subclass hook
CreateSession(config:%DynamicObject = "") -> %AI.Agent.Session
Chat(session, input:%String, feedback)    -> %AI.LLM.Response
ChatWithContent(session, content:%DynamicArray, feedback) -> %AI.LLM.Response
Run(session, goal:%String, maxIterations = ..MaxIterations, callbackOref) -> %AI.LLM.Response
StreamChat(session, input, callbackObj, callbackMethod)   -> %AI.LLM.Response
UseToolSet(className:%String)             -> %Status
UseSkill(skillOrClassName)                -> %Status
CreateSubAgent(systemPrompt = "")         -> %AI.Agent
```

Properties: `Provider` (`%AI.Provider`), `Model`, `SystemPrompt`, `Temperature`,
`MaxIterations`, `ToolSets`, `Skills`, `ToolManager` (`%AI.ToolMgr`), `Session`,
`InstructionsTemplate`, `AutoCompactOnTokenLimit`.

**There is no `LLMConfig` property.** The skill flags it as removed after build 141 and that
holds here — confirmed by its absence from the introspected property list, not by trying it.

`Run(session, goal, ...)` is worth noting: an agentic loop with a goal and an iteration cap,
which fits AI Detective better than a single `Chat` turn, since the agent needs to call several
read tools before concluding.

## `%AI.Tool` — how a tool is implemented

```
Abstract class, extends %Library.RegisteredObject
  instance:  %Invoke, %Discover, %Encode, %Decode, %ToolError
  class:     %FromObject, %ToObject, %TypeMode
```

So an MCP tool is a **subclass of `%AI.Tool` implementing `%Invoke`**, and `%ToolError` is the
built-in way to report failure — which is what `contracts/mcp-tools.md` should specify rather
than inventing an error convention.

`%AI.ToolMgr` class methods: `FindTools(package, includeToolSets, &sc)`,
`GetOrCreate(serviceName, *isNew)`, `PurgeShared(serviceName)`.

## Two warnings from the skill that we must respect

**1. Compile order for ToolSets.** `%AI.ToolSet.Specification.Compiler` validates referenced
classes at compile time, so a ToolSet compiled before its `<Include>` targets discovers **zero
tools** — silently. The skill's three-step pattern:

```objectscript
do $system.OBJ.LoadDir("/pg-src/...", "k", , 0)     // load, do not compile
do $system.OBJ.CompilePackage("ProductionGuardian", "ck")
do $system.OBJ.Compile("<the ToolSet class>", "ck") // recompile the ToolSet LAST
```

This matters for us specifically: `docker/iris-firstboot.sh` currently loads with `"ck"` in one
pass. Adding a ToolSet to `iris/labdemo/` without changing that would produce a ToolSet with no
tools, and nothing would report an error.

**2. `AutheEnabled=96` for MCP over HTTP.** The MCP service endpoint is requested
*unauthenticated*; `64` (password only) answers 500. Our web applications are already 96
(`FirstBoot.RegisterWebApps`), so this is satisfied — but a new MCP web application would need
the same, and #78 established that 96 is deliberate rather than incidental.

## Enforcement is automatic — the single most important finding

`%AI.ToolMgr.ExecuteTool(toolName, arguments)` is the invocation path, and its shipped
implementation settles the question that MVP 2's whole safety story rests on:

```objectscript
// Call Rust ToolManager.execute() which:
// 1. Checks AuthorizationPolicy.can_execute()
// 2. Executes the tool via provider
// 3. Calls AuditPolicy.log_execution()
// 4. Returns result as %DynamicObject
Return $ZF(-6, $$$IrisLLMLibrary, 50, ..%token, toolName, argsJson)
```

**The authorization check and the audit write happen in the runtime, not in each tool.** A tool
author cannot forget to call them, and cannot bypass them by implementing `%Invoke` carelessly.
That is a much stronger guarantee than "every tool is expected to check permissions", and it is
what lets `contracts/resolve-api.md` promise that *every* call is gated and audited rather than
*every call we remembered to gate*.

Read from the compiled method body rather than inferred from the class list, because "the classes
exist" and "the classes are enforced" are different claims and only the second one is worth
anything on a live production.

Corollary: the audit log records the call whether it succeeded, failed, or was refused —
`%LogExecution` takes both `status` and `duration`. So "we audit attempts", not just "we audit
changes".

`%AI.MCP.Service` additionally carries `%IsAuthorized()` and `AccessCheck(*pAuthorized)` for the
HTTP surface, and `HandleToolRequest` / `RouteToolRequest` / `ToolCall` for dispatch — so there
are two layers: web-application authentication at the service, then per-tool authorization at
execution.

## What is NOT yet verified

- ~~No LLM provider is configured.~~ **CLOSED** -- see the provider section at the end of this
  file. A real OpenAI call and an agent tool call have both been made from this instance.
  **But not on the compose stack** -- see "None of it was on `pg-iris`" below.
- ~~**What an audit record CONTAINS, and whether it is queryable.**~~ **CLOSED 2026-08-19** -- the
  answer is that *nothing is written at all*. See "There is no audit store" below.
- ~~**Which policy implementation is active by default.**~~ **CLOSED 2026-08-19** -- none is. A
  fresh `%AI.ToolMgr` reports `AuthPolicy: <none>`, `AuditPolicy: <none>`,
  `DiscoveryPolicy: <none>`. The default permits everything and records nothing.
- **`@{wallet.*}` substitution** was broken on build 159 per the skill (only `env` and `config`
  registered). Unknown on 126. `%AI.Utils.WalletStore` exists, but existence is not function.

## There is no audit store — the hook fires into nothing

Measured 2026-08-19 on `pg-iris`. `%AI.Policy.Audit` is an abstract base whose one interesting
method is

```
%LogExecution(call:%DynamicObject, metadata:%DynamicObject, result:%DynamicObject,
              duration:%Integer, status:%Status) -> %Status
```

The only shipped implementation, `%AI.Policy.ConsoleAudit`, writes an ANSI-coloured box to the
current device and returns. There is no `%AI.Audit.*` persistent class — searched
`%Dictionary.CompiledClass` for `%AI.*` matching AUDIT or LOG and the only hits are the policy
classes themselves.

So `mcp-tools.md` §5.5's "every one of the six tools is audited on every call" was true of the
**hook** and false of the **record**, and MVP 2 §3's final demo step is showing an audit entry.
`iris/labdemo/Audit/Entry.cls` is the store; `iris/labdemo/Tools/AuditPolicy.cls` is the policy that
fills it.

### A real `%LogExecution` payload, captured from a live `GetPoolSize("Cloud API")`

```
call     {"id":"call_id","name":"GetPoolSize","arguments":"{\"host\":\"Cloud API\"}"}
metadata {}
result   {"tool_name":"GetPoolSize","result_json":"{...}","display_text":null}
duration 0
status   OK
```

Four things there are not what a reader would assume, and each one changed the implementation:

| Assumption | Reality |
|---|---|
| `call.id` identifies the call | it is the **literal string `"call_id"`** on every call — unusable as `auditId` |
| `call.arguments` is an object | it is a **JSON string**; iterating it yields nothing |
| `metadata` carries caller identity | it is **empty** `{}` — `actor` has to come from `$username` |
| `duration` is meaningful | **0** for a call `ExecuteTool` itself timed at `0.0071 s`; it is integer ms |

Tool names are the **ObjectScript method names** — `GetPoolSize`, `SetPoolSize` — not the
snake_case names in `mcp-tools.md`'s catalogue. Anything joining the two must map.

## A refused call is NOT audited — the contracts overpromise

**This is the most important finding in this file.** `contracts/mcp-tools.md` §5.5 and
`resolve-api.md` §8 both state that refusals, `not_authorized` explicitly, are audited:

> Every call produces exactly one attributable audit event: applies, refusals, and dry-runs alike.

The runtime cannot deliver that. `ExecuteTool` checks authorization, **then** executes, **then**
audits — so an authorization denial throws `<%AICore>ToolAccessDenied` at step one and the audit
hook is never reached. Measured with a deny-all policy registered: `%LogExecution` not called, **0
rows written**.

The distinction is sharp, and only one half was broken:

| Case | Audited by the runtime? |
|---|---|
| successful read | yes |
| dry-run of the write tool | yes |
| **tool-level** refusal (our own bounds guard returns `outcome: "refused"`) | yes — the tool ran |
| unknown host | yes |
| **authorization** denial (`%CanExecute` refuses) | **no** |

The security-relevant event was the one going unrecorded — an audit log that records only what
succeeded cannot answer *did anything try to write to the production*.

**Fixed in `iris/labdemo/Tools/AuthPolicy.cls`**, which writes its own `denied` row before
returning the refusal. It is the only code that ever learns a denial happened, so it is the only
place the row can come from. That is why `Audit.Entry.Disposition` has two values and two writers.

**Two contract corrections are owed** (`contracts/` is read-only — these are change requests, not
edits): §5.5 and §8 should say that the *runtime* audits executions and that authorization denials
are audited by our policy, and `resolve-api.md` §8's `auditId` example `aihub-audit-44812` implies
an AI Hub audit store that does not exist. The handles are `pg-audit-<n>` — minted by us, because
inventing AI Hub provenance is the same defect as the mock inventing an id.

## Policies are per-ToolMgr and in memory — not a setting

`SetAuthPolicy` / `SetAuditPolicy` attach the policy to the Rust tool manager identified by that
object's `%token`:

```objectscript
Set ..AuditPolicy = policy
If ..%token '= "" { Do $ZF(-6, $$$IrisLLMLibrary, $$$LLMTOOLMANAGERADDAUDIT, ..%token, policy) }
```

There is no persisted configuration, so **a first-boot script cannot switch governance on once.**
Every caller that builds its own `%AI.ToolMgr` — or its own `%AI.Agent`, which builds one — gets an
ungoverned manager: no authorization check, no audit row, and `SetPoolSize` fully callable against
the live production. `%AI.Agent.UseToolSet` delegates straight to
`..ToolManager.RegisterToolSet(className)`, so the natural thing to write is the unsafe thing.

`iris/labdemo/Tools/Governance.cls` is the mitigation: one factory, it cannot return an ungoverned
manager, and `GovernAgent()` is what Dev B's AI Detective should call instead of `UseToolSet`.

## None of it was on `pg-iris`

Measured 2026-08-19 against the running compose stack, up 2 days:

| | Present |
|---|---|
| `PG_Read` / `PG_Resolve` resources | no |
| `Guardian_Read` / `Guardian_Resolve` roles | no |
| `AI.Secrets` resource | no |
| `PGSecrets` wallet collection | no |
| `AI.LLM.pgdetective` config | no — `ERROR #5809` |
| `Tools.Read` / `Tools.Resolve` / `Tools.AuthPolicy` compiled | **no** |

Everything the provider section below records as done *was* done — by hand, on the hand-built
`iris-webinar` instance the MCP dev connection used to point at. None of it reached the container
the demo runs from, and the tool classes were not even compiled there because the container had
been up since before #90 landed.

That is the failure `FirstBoot` exists to prevent (#70, #72): a step a person performed on one
instance is not a step the stack performs. `iris/setup/AIHub.cls` now creates the resources and
roles idempotently and `FirstBoot` calls it, so a clean `docker compose up` has the boundary armed.
It deliberately does **not** create the LLM credential — that needs a key, a key does not belong in
a repository, and this one must be rotated anyway — but it reports the config as missing and prints
the sequence to create it.

### Observed denial, which is the acceptance criterion

`resolve-api.md` §9.4 and `mcp-tools.md` §5.6(b) both require an *observed* denial rather than a
passing allow. `iris/test/GovernanceProof.cls` makes it repeatable. It cannot use
`iris/test/StubPolicy.cls` for this: `$SYSTEM.Security.Check` returns 1 for every resource when the
caller holds `%All`, and every session that can compile the code holds `%All`. So it creates a real
throwaway user with a generated password, logs in as it, and attempts the write:

```
1. logged in as pg_proof_readonly, roles = Guardian_Read
2. GetPoolSize : executed  <- expected executed
3. SetPoolSize : denied    <- expected denied
   error   : ERROR <%AICore>ToolAccessDenied: Tool access denied: Global policy denied:
             ERROR #5001: 'SetPoolSize' modifies a live production and requires PG_Resolve:USE
   auditId : pg-audit-6
4. audit row for the denial:
   {"auditId":"pg-audit-6","actor":"pg_proof_readonly","role":"Guardian_Read",
    "tool":"SetPoolSize","recordedAt":"2026-08-19T10:53:43Z","source":"live",
    "disposition":"denied","denialReason":"'SetPoolSize' modifies a live production
    and requires PG_Resolve:USE"}

PASS: read allowed, write refused, refusal audited.
```

**The roles need a database privilege the contracts never mention.** A user holding only
`PG_Read:U` logged in fine and then died with `<PROTECT> ... Access Denied` on
`Tools.Governance.1` — before any policy was consulted, because it could not read the routine. Both
roles therefore carry `%DB_%DEFAULT:RW`, and `RW` rather than `R` because `AuthPolicy` writes the
denial row *as the refused principal*, which is what makes it attributable.

**An honest limitation:** on this image every database shares `%DB_%DEFAULT`, so that grant is
broad. The least-privilege story is real at the **tool** boundary — `PG_Resolve` genuinely gates
`set_pool_size` — and is not a database-isolation story. A demo should not imply otherwise.

## The MCP dev connection

`iris-agentic-dev` reads **`~/.iris-agentic-dev.toml`** — the home directory, *not* a
repo-local copy. A repo-local file is silently ignored, which is worth knowing before someone
commits one and expects it to take effect.

It is now pointed at the compose stack:

```toml
host = "localhost"   web_port = 52773   namespace = "LABDEMO"
```

Previously `localhost:80` — the hand-built `iris-webinar` instance, saved at
`~/.iris-agentic-dev.toml.bak-mvp2`. **Both instances have a LABDEMO namespace**, so the wrong
target does not fail; it answers plausibly about the wrong production. That is why the port is
named explicitly rather than relying on `container =` port discovery.

The config hot-reloads on the next tool call — no restart needed.

## `Ens_Util.Log` carries PHI right now — measured, not hypothesised

`get_recent_errors` reads `Ens_Util.Log`, and on the running instance that table contains patient
identifiers in plain text. Counted 2026-08-18 on `pg-iris`:

| `Type` | Meaning | Rows | Contains `PatientID` |
|---|---|---|---|
| 4 | info | 61,772 | **yes — every one** |
| 2 | error | 66 | no |

A sample of the info rows:

```
PatientDemographicsOperation: upserted PatientID=309191
PatientDemographicsOperation: upserted PatientID=145662
```

and of the error rows:

```
ERROR #6059: Unable to open TCP/IP socket to server 127.0.0.1:59999
ERROR <Ens>ErrFailureTimeout: FailureTimeout of 1 seconds exceeded
ERROR <Ens>ErrProductionSettingInvalid: Production setting 'PollInterval' for item 'EMR Source' is invalid
```

**This is the strongest possible argument for `mcp-tools.md`'s allowlist, and it is also a trap.**
Filtering to `Type >= 2` happens to exclude every `PatientID` today, so a naive implementation
would pass any test written against the current log and look correct. It is wrong anyway:

- the separation is a property of what `$$$LOGINFO` and `$$$LOGERROR` are *currently used for* in
  `PatientDemographicsOperation`, not a property of the log. One `$$$LOGERROR` that interpolates a
  patient id — and the operation already builds strings containing `PatientID` for its info path —
  puts PHI straight into the error rows.
- 61,772 to 66 is a ratio that makes the unsafe case rare rather than absent, which is the worst
  shape for a defect: it survives review, survives the demo, and appears in production.

So the rule has to be "extract an allowlisted error token, never return log text" rather than
"filter to error rows and return the text". `mcp-tools.md` §3.4 specifies the former, and this
measurement is why it should not be relaxed to the latter on the grounds that the error rows look
clean. They do look clean. That is not the same as being clean by construction.

Related: the same reasoning is why `count` must be `null` rather than `0` when the log is
unreadable — "no errors" is the worst wrong answer to give an agent diagnosing an error condition.

## The LLM provider is configured, and an agent has used our tools

Closed 2026-08-18. Previously listed here as "No LLM provider is configured ... real work, not a
checkbox".

**The key is in the AI Hub wallet, not in this repo and not in an env var.** Following the
`aihub-eap` skill's production pattern -- Wallet holds the secret, ConfigStore references it:

```objectscript
Security.Resources.Create("AI.Secrets", ...)
%Wallet.Collection.Create("PGSecrets", {"UseResource":"AI.Secrets","EditResource":"AI.Secrets"})
%Wallet.KeyValue.Create("PGSecrets.openai", {"Usage":"CUSTOM","Secret":{"apikey":"<the key>"}})
%ConfigStore.Configuration.Create("AI","LLM","","pgdetective", {
    "model_provider": "openai",
    "model":          "gpt-4o-mini",
    "api_key":        "secret://PGSecrets.openai#apikey"
})
```

`GetDetails("AI.LLM.pgdetective", .d, 0, 1)` -- the trailing `1` is `resolveSecrets` -- returns the
real key. Verified it resolves rather than handing back the `secret://` string, because the failure
mode is a provider that authenticates with a literal URI and reports an auth error rather than a
config error.

**A real call, from inside IRIS:**

```
provider created: %AI.Provider
%Init: OK
response: AIHUB LIVE
```

**And an agent using OUR MCP tools, which is the whole AI Detective mechanism:**

```
UseToolSet("ProductionGuardian.LabDemo.Tools.Read")  -> OK
Run(session, "What is the pool size of the host named Cloud API? ...")
answer: 1          <- the real configured value
tool calls: 1
```

That is the loop MVP 2 needs: agent -> MCP read tool -> live production -> LLM -> structured answer.
Nothing hardcoded, nothing mocked.

### Pattern notes worth keeping

- `%AI.Provider.Create(providerName, detailsObject)` takes the whole ConfigStore details object; it
  reads `api_key` from it directly. No separate key argument.
- `%Init()` before the first `Chat()` or `Run()`, as the skill says. Without it the provider and
  tools are unwired.
- `Run(session, goal, maxIterations)` rather than `Chat` for AI Detective: it is an agentic loop, so
  the model can call several read tools before concluding. `Chat` is one turn.
- `session.GetStats()."total_tool_calls"` is how to prove a tool was actually used rather than the
  model answering from its own guess -- worth asserting, since a plausible wrong number looks
  identical to a correct one in the response text.

### Two security notes

**The key must be rotated.** It was pasted into a chat transcript to reach me, so it should be
treated as exposed regardless of where it now lives. MVP 2 §6 already lists "rotate after the demo"
as the mitigation for credential exposure; this is that case.

**`gpt-4o-mini` is a deliberate choice, not a default.** AI Detective sends metrics and
configuration only -- no message content, no PHI (root `CLAUDE.md` §2.1) -- so the reasoning task is
small and structured. A larger model would cost more per investigation and add latency to a loop
that already sits inside the ADR 0005 budget.
