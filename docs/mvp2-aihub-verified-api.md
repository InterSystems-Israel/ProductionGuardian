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

- **No LLM provider is configured.** No `%AI.Provider` instance, no ConfigStore entry, no API
  key. Nothing has called an external model from this instance. The provider/key path is real
  work, not a checkbox.
- **What an audit record CONTAINS, and whether it is queryable.** Enforcement is confirmed (see
  above), but the written record has not been observed, and Dev C needs to display one. This is
  now the highest-value remaining unknown.
- **Which policy implementation is active by default.** `%AI.Policy.ConsoleAuth` and
  `%AI.Policy.ConsoleAudit` exist alongside the abstract bases, so something is wired out of the
  box -- whether it permits everything until configured is unknown, and "enforced by the runtime"
  is only a safety property if the configured policy actually denies.
- **`@{wallet.*}` substitution** was broken on build 159 per the skill (only `env` and `config`
  registered). Unknown on 126. `%AI.Utils.WalletStore` exists, but existence is not function.

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
