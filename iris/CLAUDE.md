# CLAUDE.md — iris/ and services/metrics-proxy/ (Dev A)

This file governs everything under `iris/**` and `services/metrics-proxy/**`.
It supplements (and is subordinate to) the root `CLAUDE.md`.

---

## 1. Area ownership

Developer A owns:

| Path | Purpose |
|---|---|
| `iris/setup/` | One-time ObjectScript setup scripts for the demo namespace |
| `iris/labdemo/` | LABDEMO production class, HL7 generator, trigger toggles |
| `iris/labdemo/Tools/` | MVP 2: the MCP tools, the authorization and audit policies, the governed-manager factory. **The count is in `contracts/mcp-tools.md` §1 and is not restated here** |
| `iris/labdemo/Audit/` | MVP 2: the persisted audit trail — AI Hub ships no audit store |
| `services/metrics-proxy/` | Node.js proxy: polls `/api/monitor/metrics` + `/api/monitor/alerts`, exposes per-host JSON |

Do **not** touch `services/detection-engine/`, `apps/dashboard/`, `contracts/` (read only), or any root config shared with other devs without a PR.

---

## 2. IRIS setup context

Interoperability metrics require two one-time calls in the demo namespace:

```objectscript
do ##class(Ens.Util.Statistics).EnableSAMForNamespace()
do ##class(Ens.Util.Statistics).EnableStatsForProduction()
```

`Ens.Activity.Operation.Local` must also be added to the production (provides `iris_interop_avg_processing_time`).

Verification: `iris_interop_queued` and `iris_interop_avg_processing_time` must appear in `/api/monitor/metrics` output.

---

## 3. LABDEMO production

Three application components. **The `<Item Name="...">` set in `iris/labdemo/Production.cls`
is authoritative** — do not maintain a second copy of the host list here, because a
duplicated list is exactly what went stale when `FHIR Transform` was removed.

Note the names carry a space (`EMR Source`, not `EMRSource`). The spaced form is what
appears in `/api/monitor/metrics`, in the proxy JSON, and in the dashboard, so use it
verbatim. Class names differ from config item names: the `Cloud API` item is
`ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation`.

`Ens.Activity.Operation.Local` is a fourth item, but it is framework plumbing for metrics
and the findings API filters it out — it is not an application host.

The synthetic HL7 generator (`iris/labdemo/HL7Generator.cls`) emits ADT^A01 messages on a
configurable interval. That is the only type it emits and the only type the routing rule
routes.

---

## 4. Metrics proxy conventions

- Language: **Node.js** (no transpilation; plain CommonJS).
- Port: **3001** (never change without updating `CLAUDE.md` in root).
- Poll `/api/monitor/metrics` every **10 s**; `/api/monitor/alerts` every **30 s**.
- Parser: use `prom-client` for model compatibility **or** a hand-rolled Prometheus text-format parser — keep it in `src/parser.js`.
- Output schema lives in `contracts/proxy-schema.json` (read-only after Day 1 freeze).
- Never hard-code credentials — use environment variables (`IRIS_HOST`, `IRIS_PORT`, `IRIS_USER`, `IRIS_PASS`, `IRIS_NAMESPACE`).

---

## 5. Running locally

```bash
# Start proxy against a real IRIS instance
cd services/metrics-proxy
cp .env.example .env   # fill in IRIS_HOST etc.
npm install
npm start

# Start proxy in mock mode (no IRIS required)
npm run mock
```

---

## 6. Dev A acceptance criteria (from spec §3)

1. Proxy returns documented per-host JSON within 2 s of poll.
2. Parser handles all 8 metric types listed in spec §1.3.
3. Each of the 8 finding types can be induced on demand via trigger toggles.
   **Met by `iris/labdemo/Triggers.cls` for 6 of 8, with the other two stated rather than
   implied** — one idempotent method per type, `Reset()` to undo all of them, `Status()` to
   report what is armed. Until 2026-08-13 this criterion was met by a table of manual steps in
   `README.md`, which is not the same thing: two of them required editing and recompiling
   `PatientDemographicsOperation` mid-demo, and one required five settings changed together.

   **Demonstrated live against the containerised stack** (2026-08-13, four containers, real
   IRIS): `dead_host`, `throughput_drop`, `elevated_error_rate`, `growing_queue_wait`,
   `slow_processing`, `queue_buildup`. Each with real numbers, each cleared by `Reset()`.

   Two do not fully meet the criterion, and both are recorded where someone will hit them:

   - **`stalled_host` cannot be induced by any toggle this class has.** The rule declines for
     any host already in `DEAD_STATUSES` — one condition, one finding — and both mechanisms for
     stopping a host consuming its queue (disable the item; point it at a closed port) land in
     that set as `Disabled`/`Error`. Measured: 11 minutes at 320+ queued and 690s idle produced
     none, and probing the rule with those exact values returns null. `StalledHost()` now says
     so instead of promising it after ~300s. A gap in the demo's coverage, not a defect in the
     rule.
   - **`system_alert` outlives `Reset()`**, because the alert sits in the proxy's in-memory
     buffer on `:3001`, which IRIS cannot reach. Documented in the class and the README.
4. `/api/monitor/alerts` forwarded as JSON at `/proxy/alerts`.

---

## 7. MVP 2 — the governed MCP tools (read this before touching `Tools/`)

Full measurements are in `docs/mvp2-aihub-verified-api.md`. The rules that matter here — **deliberately
not counted, for the reason the tool count below is not restated**: this line read "the four rules"
while the section held six, which is the same staling this file indicts two paragraphs down:

**Every public ClassMethod on a `%AI.Tool` subclass becomes an LLM-callable tool.** Verified by
reading `%AI.Tool.Generator`. A helper left public on `Tools.Resolve` is a second way to mutate a
live production. Helpers are `[ Private ]`, and `Setup.AIHub.Run()` prints the discovered tool count
on every boot so an extra name shows up at boot rather than in review. **The expected count lives in
`Setup.AIHub.ReportTools()` and in `contracts/mcp-tools.md` §1 — it is deliberately not restated
here.** This line read "Six is the expected count" from MVP 2 through three families being added, so
it was wrong by eight: #84's shape, in the file a newcomer trusts. Move the number in `ReportTools()`
only after reading the discovered names back, which is the discipline every previous bump followed.

**A shared list between two tool classes must be a `Parameter`, not a method.** `Tools.ChangeLog`
needs `Tools.Read`'s setting allowlist, and a public accessor for it would have become another
LLM-callable tool that returns setting names to the model. Parameters are cross-class accessible
(`##class(X).#PARAM`) and generate no tool, so `#SETTINGALLOWLIST` is one — which is also the only
arrangement that avoids a second copy of the list.

**`Triggers.SetSetting()` writes its own audit row, and it has to.** A setting changed through
`Ens.Config.Production.%Save()` is **not** audited — only the Management Portal's own save path is,
measured by arming `MissingFolder()` and finding the newest `ModifyConfiguration` row three days
stale. So the method emits a byte-compatible row via `$SYSTEM.Security.Audit()` **after** the save
succeeds, and `get_recent_config_changes` can see what the triggers do. **Note the argument order:
arg4 lands in `EventData` and arg5 in `Description`** — the reverse of what the names suggest, and
getting it wrong produces a valid row that the tool's host parse silently discards as a lifecycle
event. Anything else here that mutates a setting through `%Save()` is invisible to that tool.

**A tool that is registered and described is not a tool that gets CALLED.** Adding a tool takes three
things, and the third is the one that keeps being forgotten: register it in `Tools.Governance`,
describe it in the system prompt, and **name it in a `MUST` in the per-request goal**. Measured twice.
`BuildGoal` already carries that directive for `get_recent_errors` and `get_host_settings` because
"use the tools" left them uncalled in two of three live runs; `GetRecentConfigChanges` then repeated
it exactly — registered, its prompt paragraph verified present in the compiled `.INT`, and
`toolCalls: 2` on the very scenario it was built for, because the model had a satisfying answer after
two calls and stopped. A description is not a directive.

**And when you add a directive to `BuildGoal`, re-check `evidence[].source`.** The goal is the last
thing the model reads, so a long block there outcompetes the system prompt. The first version of that
directive closed by deferring to "the rules in your instructions" and cost every evidence entry its
attribution across three consecutive runs — `source` unset, which `investigate.ts` maps to `"llm"`, so
the reply stayed schema-valid while claiming the model had reasoned out values it read from governed
tools. State a requirement in the same breath as the instruction it applies to; do not point at
another part of the prompt.

**Governance is per-`%AI.ToolMgr` and held in memory — there is no setting.** So never construct a
`%AI.ToolMgr` or call `%AI.Agent.UseToolSet` directly: both give you an ungoverned manager with no
authorization check, no audit row, and `SetPoolSize` live. Go through
`Tools.Governance.ToolManager()` or `Tools.Governance.GovernAgent()`, which cannot return one.

**The runtime does not audit authorization denials.** It checks, then executes, then audits, so a
denial throws before the audit hook. `Tools.AuthPolicy` writes that row itself. Anything that adds a
new deny path must go through its `Deny()` helper or the refusal leaves no trace — which is the one
event a security review actually asks about.

**Tool return values reach an external LLM: metrics and configuration only, never message content
or PHI** (root `CLAUDE.md` §2.1). `Ens_Util.Log` on this instance holds 61,772 rows carrying
`PatientID` in plain text, so `GetRecentErrors` extracts an allowlisted error token and never returns
log text. The audit table *inherits* that guarantee rather than re-enforcing it — if a tool ever
returns PHI, it lands in `Audit.Entry.Result` in plain text.

### Dev A MVP 2 acceptance

| Criterion | State |
|---|---|
| Read tools return real evidence | met — six tools discovered, live values |
| `set_pool_size` changes the live pool and is reversible | met — a real `1 → 4` against a queue held at its cap, drained to 0, `Reset()` restored pool 1 (#102). Reversal is *recorded* and correct; reversing **through the API** is blocked by #100 |
| An unauthorized role is refused | met **by the fixture, not by the running system** — see below |
| Every call appears in the audit log | met for executions and for authorization denials |
| RBAC roles and resources exist from a clean boot | met, and **verified from a real boot** rather than inferred: the four security objects were deleted and `docker compose restart iris` recreated them through step 9. `Audit/` compiled on the way through, including its SQL table, so the recursive load picks up a new subdirectory |
| A principal can actually *use* the roles | needs `%DB_%DEFAULT` **as well**, from the invocation path — the `Guardian_*` roles stay minimal and grant only `PG_*`. Without it you get `<PROTECT>` before any policy is consulted |
| LLM credential in the vault | met — `Setup.AIHub.CreateProvider()` provisions the wallet entry and the `AI.LLM.pgdetective` config from `PG_LLM_API_KEY` at boot (#106), verified on a cold-provisioned instance. **No key, no default:** absent, the boot says `SKIPPED` and AI Detective degrades to a labelled `source: "canned"` |
| One live investigation returns `source: "agent"` | **standing pre-demo check, not a one-off** — see #108 and below |

```objectscript
do ##class(ProductionGuardian.Setup.AIHub).Status()          // what is and is not in place
do ##class(ProductionGuardian.LabDemo.Audit.Entry).Purge()   // reset the log between rehearsals
```

### Before a demo: prove the agent is live, not canned (#108)

`source: "canned"` builds a plausible narrative **from real measured values**, so a rehearsal looks
correct while demonstrating nothing about the agent. The three fields that cannot be faked:

```
POST /api/investigate  ->  state: complete
                           source: agent        <- NOT "canned"
                           model: non-null      <- e.g. gpt-4o-mini
                           toolCalls: > 0       <- evidence was gathered, not guessed
```

**Run it after any change to the provider path** — `CreateProvider()`, the wallet, the ConfigStore
entry, `REST.AgentDispatcher`, or the compose variables.

`source: "agent"` is the cheapest assertion that covers the whole chain at once, because it cannot be
produced unless the compose variable, the provider config, the wallet entry, the web application and
the agent are *all* correct simultaneously. That matters because three defects in this path were each
invisible to the check that preceded them, and each failed at a different link:

| Defect | Where it broke | Found in |
|---|---|---|
| `/labdemo/agent` never registered — every MVP 2 write `404`d | web application | #106 |
| `CreateProvider()` never ran — the variable was not passed to the `iris` service | compose | `f4e6561` |
| the wallet restore was inert — `%Wallet.KeyValue.Secret` is `transient=1` | error path | `4a0fb8e` |

The common gap: **a mechanism that works and a mechanism that is reached are different claims**, and
only the second is what a demo depends on.

Not automatable in CI — it needs a real API key and costs a metered call, so it is a human check. If
it is ever scripted it belongs in `tools/` and run on request, for the same reason
`Test.GovernanceProof` is hand-run rather than compiled at boot.

### Every row above means "on a boot", so test with `compose down -v`

**A fresh clone is not a fresh instance.** `docker-compose.yml` fixes the volume name
(`name: production-guardian`), so cloning the repo into a new directory and running `compose up`
reuses the existing volume — the boot then reports `exists` for every security object, every web
application and the provider config, and looks perfectly clean. Only `docker compose down -v`
destroys the volume and tests what a colleague actually gets.

This has now cost the team three defects in one day, each invisible on every machine we had:

| Missing on a cold boot | Found in |
|---|---|
| `iris/test/` never compiled, so the acceptance proof did not exist | #97 |
| `/labdemo/agent` web app unregistered, so **every MVP 2 write returned 404** | #106 |
| the LLM wallet entry and `AI.LLM.pgdetective` config, so AI Detective could not run | #106 |

All three existed everywhere we tested because each of us created it by hand while building it.
@Ari-Glikman's framing is the one to keep: **the state that matters is what a fresh boot produces,
not what your instance contains.** That is #84's argument arriving by a different route — the second
copy here is a live instance rather than a stale number, and the "staling" event is having worked on
it.

So a row reading "met" in the table above is a claim about a boot, and the only way to check one is
to throw the volume away first.

### The running system cannot refuse anything, and "met" above means the fixture

`docker-compose.yml` gives the engine and the proxy `IRIS_USER=superuser`, which holds `%All`, and
under `%All` `$SYSTEM.Security.Check` returns 1 for **every** resource — including ones that do not
exist. Measured:

```
roles: %All
  Check PG_Resolve:USE       = 1
  Check PG_TotallyMadeUp:USE = 1
```

So `Tools.AuthPolicy` is correct code on a path the deployed stack never exercises, and every audit
row reads `actor: SuperUser`. The observed denial in `Test.GovernanceProof` is real, but it works by
manufacturing a throwaway low-privilege principal *because* the deployed one is over-privileged.
Read the acceptance row as "the policy denies when asked by a principal that lacks the resource",
not as "the demo shows the boundary refusing a live request".

**Do not try to fix this by creating service accounts before reading #104.** @Ari-Glikman built
exactly that, it worked, and it had to be reverted: `Ens.Director.UpdateProduction()` returns
`ERROR #940: Insufficient privilege` for a non-`%All` caller, and the privilege cannot be granted
because **no `%Ens_*` resource or role exists on this instance** — verified independently, 0 rows in
both `Security.Resources` and `Security.Roles`. `EnableNamespace` normally creates them and never
did here; `%All` has masked it since day one. The end state was a policy that authorizes the write
and a write that cannot land, which is worse than either extreme.

### `iris/test/` is not deployed by first boot — compile it by hand

`docker/iris-firstboot.sh` loads `/pg-src/setup/` and `/pg-src/labdemo/` and **nothing else**, so on a
fresh instance `Test.GovernanceProof` and `Test.StubPolicy` do not exist and the acceptance proof
fails with `<CLASS DOES NOT EXIST>`. Found by deleting the security objects, restarting the container,
and looking for the classes in the boot log rather than in the namespace — they were present, but only
as leftovers from an earlier manual compile, which is exactly the kind of thing that reads as "it
works" until someone tries it on a second machine.

Left out of the boot deliberately rather than fixed: `GovernanceProof` **creates and deletes an IRIS
user**, and auto-compiling that onto every container start widens what the deploy ships for the
benefit of a fixture. Compile it when you want to run the proof:

```objectscript
do $system.OBJ.LoadDir("/pg-src/test/", "ck", .errors, 1)
set pw = ##class(ProductionGuardian.Test.GovernanceProof).Prove()
// then, in a SEPARATE session, because the login cannot be undone:
do ##class(ProductionGuardian.Test.GovernanceProof).AsReadOnlyUser(pw)
do ##class(ProductionGuardian.Test.GovernanceProof).Cleanup()
```
