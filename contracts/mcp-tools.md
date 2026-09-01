# MCP tool catalogue

**Owner:** Dev B (inherited `iris/**` from Dev A) · **Consumer:** Dev B (agent orchestration), Dev C
(approval UI, indirectly) · **Runs in:** the `pg-iris` container · **Status:** published

**Twelve tools since the chat assistant gained the event log. Eleven read, one write.** They exist so
the **AI Detective** agent can gather evidence about one condition on one host, so **Smart Resolve**
can apply one bounded action to it, and so the **chat assistant** can answer an operator's question
about interoperability activity and about what the production logged. Root `CLAUDE.md` §2.1 is the
scope boundary; this file is the interface.

**The eleven reads are three families answering three different questions**, and the split matters
because the first two sound alike. §3.1–§3.5 report **what is true now** — a status, a depth, a pool
size, read from the live production. §3.7–§3.9 report **how much moved and how fast over a period**,
read from the persisted `Ens_Activity_Data` tables. §3.10–§3.11 report **what the production said
while it moved**, read from `Ens_Util.Log`. Given the first two together, a model asked "which host
has the highest average queueing time" answered from the instantaneous reading and was wrong by three
orders of magnitude, so `Tools.Governance.GovernAgent` can register any subset of the families — see
§3.9's closing note.

The organising principle is **least privilege**: the read tools are granted broadly, the write tool
is not, and the two are gated separately. The demo the spec asks for is a direct consequence —
**AI Detective can look without having permission to act.**

Machine-readable: none yet. These tools are ObjectScript classes, and their JSON Schemas are
*generated* from the class at compile time by `%AI.Tool.Generator` (§7), so a hand-written
`mcp-tools.schema.json` would be a second source of truth that drifts. The schemas below are what
the generator will produce from the stated signatures; if generated and stated ever disagree, the
generated one is what the agent sees and this file is wrong.

**Where this contract sits relative to the other three.** `resolve-api.md` §9 specifies the
*endpoint* that calls `set_pool_size`; this file specifies the *tool*. They were written in parallel
and three things were reconciled rather than left to collide — recorded here because a contract that
silently disagrees with its neighbour is worse than one that is wrong out loud:

| | `resolve-api.md` | here | Why they differ |
|---|---|---|---|
| dry-run | a `mode` on the endpoint | **no flag on the tool** | The endpoint's dry-run calls `get_pool_size` and never invokes the write tool. §3.6 |
| `size` range | `2..8` | `2..8` | **Agreed since 2026-08-20 (#100)** — the `1..8` asymmetry was withdrawn. §3.6 |
| role names | `Guardian_Resolve`, "illustrative, not ratified" | **ratified here** | §5.3 is the naming authority; the values match its examples |

`investigation-api.md` is the other consumer: its `evidence[].tool` values are names from §1, and its
§2.3 data boundary is the same boundary as §6 here, enforced one hop earlier.

---

## 1. The catalogue

| Tool | Class | R/W | Listable to | Executable by | Wraps |
|---|---|---|---|---|---|
| `get_host_status` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `Ens.Util.Statistics:EnumerateHostStatus` |
| `get_queue_depth` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `EnumerateHostStatus`, `Queue` column |
| `get_pool_size` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `Ens.Config.Production` → `Ens.Config.Item.PoolSize` |
| `get_recent_errors` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `Ens.Util.Log`, **sanitised** — see §3.4 |
| `get_host_settings` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `Ens.Config.Item.Settings`, **allowlisted** — see §3.4b |
| `get_processing_time` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `iris_interop_avg_*`, aggregated as the proxy aggregates them |
| `get_activity_coverage` | `PG.Tools.Activity` | read | `PG_Read` | `PG_Read` | `Ens_Activity_Data.Hours` + all three tables' extents — §3.7 |
| `get_activity_trend` | `PG.Tools.Activity` | read | `PG_Read` | `PG_Read` | `Ens_Activity_Data.{Seconds,Hours,Days}`, one host — §3.8 |
| `compare_host_activity` | `PG.Tools.Activity` | read | `PG_Read` | `PG_Read` | `Ens_Activity_Data.{Seconds,Hours,Days}`, all hosts — §3.9 |
| `get_event_log_summary` | `PG.Tools.EventLog` | read | `PG_Read` | `PG_Read` | `Ens_Util.Log`, aggregated, **no text** — §3.10 |
| `get_event_log_trend` | `PG.Tools.EventLog` | read | `PG_Read` | `PG_Read` | `Ens_Util.Log`, bucketed, **no text** — §3.11 |
| `get_recent_config_changes` | `PG.Tools.ChangeLog` | read | `PG_Read` | `PG_Read` | `%SYS.Audit`, `ModifyConfiguration` rows, **allowlisted** — §3.12 |
| `get_active_findings` | `PG.Tools.Findings` | read | `PG_Read` | `PG_Read` | **nothing in IRIS** — the snapshot supplied with the request — §3.13 |
| `get_interface_path` | `PG.Tools.Topology` | read | `PG_Read` | `PG_Read` | `Ens.InterfaceMaps.Utils` — the production's own interface map — §3.14 |
| `set_pool_size` | `PG.Tools.Resolve` | **write** | `PG_Read` | **`PG_Resolve`** | `Ens.Config.Production` + `Ens.Director.UpdateProduction()` |

### The names in this column are section titles, not callable names

**Measured and corrected 2026-08-26.** `%AI.Tool` derives a tool's callable name from the
**ClassMethod name**, so `%Discover()` on a governed manager reports `GetHostStatus`,
`CompareHostActivity`, `GetEventLogSummary` — PascalCase, one per method. The snake_case forms above
are this document's own headings and have never been accepted by the runtime.

That went unnoticed because it fails silently in the only direction that looks like something else:
`ChatDispatcher.SystemPrompt()` named all three activity tools in snake_case for two weeks and the
model called them anyway, mapping the prose onto the PascalCase name in its tool schema by
resemblance. A model that failed to make that leap would have answered without calling a tool, which
reads as the model declining rather than as a broken name. The prompt now uses the callable names.

Two consequences worth stating rather than leaving to be rediscovered:

- **`investigation-api.md`'s `evidence[].tool` values are the *callable* names**, not §1's. Observed
  live: `"tool": "GetEventLogSummary"`, and on one run `"tool": "functions.GetEventLogSummary"` —
  the provider's own prefix, which comes from the model and is not something this project sets.
  Treat that field as free-form provenance, not as an enum to validate against this table.
- **Renaming a ClassMethod renames a tool.** There is no name attribute in between, so a method
  rename is a contract change even when the signature is untouched.

`PG_Read` and `PG_Resolve` are **IRIS resources**, held by roles `Guardian_Read` and
`Guardian_Resolve`. §5 explains the resource-not-role choice and why the write tool is
**listable to `PG_Read` but executable only by `PG_Resolve`**.

Six classes, not fourteen, because discovery is per class: `%AI.Tool` exposes every public method of a
subclass as a tool (§7). Splitting read from write across classes means the write tool can carry
class-level parameters — `REQUIRESAUTH`, its own `Policy` — that must not apply to the read tools.
`PG.Tools.Activity` is a **third** class rather than five more methods on `PG.Tools.Read` for two
reasons: its nullability story is different (an empty result means "no traffic in that window", not
"unmeasurable"), and a new tool family in a new class moves `Setup.AIHub.ReportTools()`'s expected
count by an amount attributable to one file.

`PG.Tools.EventLog` is a **fourth** on the same two reasons, and its nullability story does not merely
differ — it **inverts**. §2.1's rule is that an unmeasurable value is `null` and never `0`. For a log
count the opposite holds: a window with no rows is a *measured* zero, the query ran and found nothing,
and it is usually the answer the operator most wants. Folding these two methods into `Tools.Activity`
would have put both rules in one class where a reader cannot tell which applies to which field.

`PG.Tools.ChangeLog` and `PG.Tools.Findings` are the **fifth and sixth**, and each is one tool in one
file for a reason the two above do not cover:

- **`ChangeLog` reads a HISTORICAL record of the very thing `PG.Tools.Read` reads live.** A tool that
  returns "`FilePath` was changed to X" sitting in the same class as one that returns "`FilePath` is
  currently Y" is one docstring away from a model reporting an audit row's `newValue` as the present
  setting. Separate files make the two families answer visibly different questions.
- **`Findings` reads nothing in IRIS at all** — it republishes a snapshot the caller supplied with the
  request (§3.13). Every other tool in this catalogue is a query against this instance, and putting a
  non-query among them would make "these tools read the production" false for one method in fourteen.

**A seventh class carries no tools at all, deliberately.** `PG.Tools.ErrorCatalogue` holds the error-code
allowlist and its summary catalogue — §3.4a — which `PG.Tools.Read` and `PG.Tools.EventLog` both need.
It does **not** extend `%AI.Tool`, so `FindTools`' `$$issubclassof` filter skips it and its two public
methods are not tools. That is the only arrangement that neither copies the PHI boundary into two
files nor publishes it as two callable tools, and §3.4a's "adding a row is a contract change" is only
checkable while there is a single row set to review.

**`Setup.AIHub.ReportTools()` prints the discovered count on every boot and flags an unexpected one.**
It expects **14**. That guard is the reason an accidentally-public helper is caught at boot rather
than in review, so the number moves only with the tool list read back — the two `EventLog` tools were
confirmed by discovery before the expectation was raised, which mattered here: that class has eight
`[ Private ]` helpers and would have discovered ten tools had any of them been left public.

**The count is 14 from `ChangeLog` and `Findings`, one tool each and six private helpers between
them** — and `Tools.Read.#SETTINGALLOWLIST` is a `Parameter` rather than a ClassMethod for this exact
reason: `ChangeLog` needs the same allowlist, and a public accessor for it on a `%AI.Tool` subclass
would have become a fifteenth tool that returns a list of setting names to the model.

---

## 2. Conventions common to every tool

**`host` is the config item name, exactly as IRIS holds it** — `Cloud API`, `EMR Source`,
`Lab Router`. Spaces intact, no case folding, no trimming. It is the same join key that runs through
`contracts/proxy.schema.json` and `contracts/healthscan-api.md` (Q8), and it survives unnormalised
for the same reason: silently mapping `CloudAPI` onto `Cloud API` would attribute one host's queue
depth to another. A `host` that names no config item in the running production is an **error**, not
an empty result — see §4.

**Timestamps** are ISO 8601 UTC, `Z`-suffixed, millisecond precision, matching
`HostStatusDispatcher.UTCTimestamp()` and the `Timestamp` definition in `proxy.schema.json`.

**Required vs optional is expressed in the ObjectScript signature, not in prose.** Read from
`%AI.Tool.Generator.GenerateDiscover` in the running container: a formal parameter **with a default**
is omitted from the generated `required` array; a parameter **without** one is required. So
`sinceMinutes As %Integer = 15` is optional *because* it has a default. Do not document a parameter
as optional and then declare it without a default — the generated schema, not this table, is what
the agent obeys.

**But the ObjectScript default does not apply on the tool path, and a tool must restate it in the
body.** `%AI.ToolMgr.ExecuteTool` builds the argument list from the model's JSON and passes `""` for
a key the model omitted — it does not omit the argument, so `= 15` never fires. A parameter declared
optional therefore arrives as the empty string, and any range check written against it rejects the
call. Measured on the same host in the same second:

```
Invoke("GetRecentErrors", {"host":"EMR Source"})                      -> {"error": "sinceMinutes must be between 1 and 60"}
Invoke("GetRecentErrors", {"host":"EMR Source", "sinceMinutes": 15})  -> 3 errors, #5021 and <Ens>ErrProductionSettingInvalid
```

So the signature declares the *schema* and the body must enforce the *default*:

```objectscript
if sinceMinutes = "" { set sinceMinutes = 15 }   // absence -> default
if (sinceMinutes < 1) || (sinceMinutes > 60) { ... }   // a wrong value the model SENT is still refused
```

The two branches are separate on purpose: absence means "use the default", a sent-and-wrong value
means "refuse and name the range". Collapsing them either way loses one of those.

**Why this is worth a contract paragraph rather than a code comment.** It was live from #106 and
invisible to every check we had, because the only caller that omits an optional parameter is the
model — every hand-written probe, test and demo script passed the argument explicitly. It surfaced
only in a live agent turn, and the failure was not an error: blinded to the error codes, the agent
reasoned from the one value it could still read (`PoolSize 1`) and recommended enlarging the pool of
a host whose configured directory did not exist. **A tool that refuses is indistinguishable, in the
narrative, from a tool that found nothing** — which makes this the same defect class as §2.1's
unmeasurable-vs-zero, arriving through the argument list instead of the return value.

Any new tool with an optional parameter must do the same, and `contracts/samples/` should carry the
omitted-argument call rather than only the explicit one.

**Units are seconds**, everywhere a duration appears, matching `healthscan-api.md` Q6. Confirmed
empirically rather than assumed: `Cloud API` configured at 0.05s latency reports `0.05`.

**A boolean field is a JSON boolean, and in ObjectScript that takes `%Set(key, val, "boolean")`.**
`set out.found = 1` on a `%DynamicObject` emits the **number** `1`, so a field initialised to `false`
in a literal and later assigned `1` changed JSON *type* depending on which branch ran. Eight fields
across §3.1, §3.2, §3.5, §3.7 and §3.9 shipped that way — `found`, `enabled`, `measured`, `readable`,
`application` — against samples in this contract that have always shown `true`.

**Worth a convention rather than a code comment, because the consumer is a language model and the
mismatch was silent.** Asked "how many hosts are in this production", the chat answered *"7 hosts …
both application hosts and framework-related hosts"* against 3 application hosts, while the prompt
paragraph telling it to read the flag names `true` and `false` and the payload said `"application":1`.
A rule stated in one vocabulary and a payload emitted in another. Correcting the **types alone**, with
no prompt change, produced *"3 application hosts … EMR Source, Lab Router and Cloud API"* on three runs
of three. Nothing that reads these fields for truthiness was affected, which is exactly why it survived:
`1` and `true` are the same value to every consumer except the one that reads the field name.

### 2.1 Nullability: an unmeasurable value is not a small one

This is the rule the project has been bitten by three times — issues #33, #49, #58 — and every read
tool below repeats it in its own terms because a shared paragraph is not what an implementer reads.

**`null` means "not measurable"; `0` means "measured zero". They are never interchangeable.**

- An unmeasurable **queue depth** is not a shallow queue. #33: coercing `queued: null` to `0` made
  `stalled_host`'s `requiresQueued && queued <= 0` gate structurally unsatisfiable — a rule silently
  switched off, with every unit test green.
- A host with **no activity line** is not "active now". #58: `lastActivity` derived from an absent
  elapsed-seconds metric reads as the current instant, which is the most confident possible wrong
  answer.
- An **absent metric family** is not a zero reading. `services/metrics-proxy/src/parser.js` records
  a live capture where IRIS emitted no `iris_interop_messages_errored` lines at all, and where the
  `avg_*` families appeared for exactly one host of thirteen.

Consequences the tools must honour:

1. Every numeric read field is `number | null`. A tool that cannot measure returns `null` in that
   field and **succeeds** — an unmeasurable value is not a failure (§4).
2. **No tool substitutes a plausible number for a missing one.** Not a zero, not a last-known value,
   not a default.
3. Where `null` and `0` would otherwise be indistinguishable to the *caller*, the tool carries an
   explicit discriminator — `measured`, `productionState`, `sampleCount` — for the same reason
   `_meta.hostStatus` exists in the proxy contract: "every depth is null because the source is down"
   and "every depth is genuinely 0" look identical in the payload alone.

This matters more here than anywhere else in the project, because **the consumer is a language
model**. A downstream rule that compares a fabricated `0` produces a wrong finding; an LLM handed a
fabricated `0` produces a fluent, confident, wrong root cause and a recommended action derived from
it. `null` is the only value that reliably stops that.

---

## 3. The tools

### 3.1 `get_host_status` — read

Current interoperability state of one host, or of every application host.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | optional | Config item name. Omit for every application host. |

Signature: `ClassMethod getHostStatus(host As %String = "") As %DynamicObject` — exposed as
`get_host_status`. (Snake-case method names are legal here: verified by compiling and invoking a
class method literally named `get_queue_depth` in the running container.)

**Output**

```json
{
  "hosts": [
    {
      "host": "Cloud API",
      "type": "operation",
      "status": "OK",
      "statusSource": "EnumerateHostStatus",
      "lastActivityElapsedSeconds": 3.2,
      "enabled": true
    }
  ],
  "production": "ProductionGuardian.LabDemo.Production",
  "productionState": "Running",
  "sampledAt": "2026-08-18T08:15:08.281Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | string | As IRIS reports it. `OK`, `Error`, `Inactive`, `Retry`, `Stopped`, `Unconfigured`, `Disabled`. **There is no `Warning` and no `Active`** (Q1). Treat as open. |
| `type` | string | `service` \| `process` \| `operation`. Normalised — IRIS says `actor` for a process and that word must not reach a consumer (Q10). |
| `lastActivityElapsedSeconds` | number \| null | **Elapsed seconds**, not a timestamp. |
| `enabled` | boolean | `Ens.Config.Item.Enabled`. |

**Wraps** `Ens.Util.Statistics:EnumerateHostStatus`, the same source
`iris/labdemo/REST/HostStatusDispatcher.cls` publishes and the proxy merges. Framework items
(`Ens.*`, `EnsLib.*`, `ActivityReporter`) are filtered, matching `healthscan-api.md` §2 — for
LABDEMO that is three hosts.

**Nullability.** `lastActivityElapsedSeconds` is `null` when IRIS emitted no activity line for the
host, never `0`: `0` reads as "active this instant", which is #58 exactly. `status` is a string and
carries `Unknown` when the source did not describe the host — a *stated* unknown rather than a
guessed `Inactive`, because `Inactive` is in the engine's `DEAD_STATUSES` and guessing it would
manufacture a `dead_host` finding out of a missing row. A host the source did not describe at all is
**absent from `hosts`**; it is not synthesised.

### 3.2 `get_queue_depth` — read

Current queue depth for one host.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Config item name. |

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed, so a result is self-describing in an agent transcript. |
| `queued` | integer \| null | Depth, `>= 0`. `null` when not measurable. |
| `measured` | boolean | `false` iff `queued` is `null`. The discriminator — see below. |
| `productionState` | string | `Running` \| `Stopped` \| `Suspended` \| `Troubled` \| `Unknown`. |
| `sampledAt` | string | When IRIS sampled, not when the tool was called. |

**Wraps** the `Queue` column of `EnumerateHostStatus`.

**Nullability, and the one place `+` coercion is correct.** `EnumerateHostStatus` returns the **empty
string** for an idle host, not `"0"`. That is verified in the shipped source of
`EnumerateHostStatusFetch` (`Set tQueueCount=$G($$$EnsQueue(qHandle,0,"count")) If tQueueCount=0 Set
tQueueCount=""`) — the global *was* read and *did* hold zero. So empty means **measured zero** and
`+rs.Get("Queue")` is right, exactly as `HostStatusDispatcher` does it. A truthiness test would read
the same empty string as "no value", which is the opposite of what it means.

`queued` is `null` in exactly three cases, none of them a zero:

- the query returned no row for this host;
- **the production is stopped** — `EnumerateHostStatus` returns *zero rows*, indistinguishable from
  "this production has no hosts" without `productionState`;
- the query itself failed.

`measured` exists because an agent reasoning over `{"queued": 0}` cannot tell those apart, and
because `null` is easy for a model to narrate away. Two fields disagreeing is harder to ignore than
one field being absent.

**Worked example.**

```jsonc
// -> get_queue_depth
{ "host": "Cloud API" }
```

```jsonc
// <- during the demo's queue_buildup
{
  "host": "Cloud API",
  "queued": 486,
  "measured": true,
  "productionState": "Running",
  "sampledAt": "2026-08-18T08:15:08.281Z"
}
```

```jsonc
// <- production stopped: NOT a drained queue
{
  "host": "Cloud API",
  "queued": null,
  "measured": false,
  "productionState": "Stopped",
  "sampledAt": "2026-08-18T08:15:08.281Z"
}
```

The second response is a **success**, not an error. The tool measured nothing and says so.

### 3.3 `get_pool_size` — read

Configured pool size for one host. The read half of the MVP 2 scenario.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Config item name. |

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed. |
| `poolSize` | integer \| null | `Ens.Config.Item.PoolSize`. `null` only when the item was not found. |
| `production` | string | The production the value was read from. |
| `pendingUpdate` | boolean | `Ens.Director.ProductionNeedsUpdate()` — the saved config differs from what is running. |

**Wraps** `Ens.Config.Production.%OpenId(...)` → the matching `Ens.Config.Item` → its `PoolSize`
property (`%Library.Integer`, verified against `%Dictionary.CompiledProperty` in the running
container).

**Limitation, stated rather than papered over: this is the CONFIGURED pool size, not the number of
running jobs.** `set_pool_size` saves the config and then calls `UpdateProduction()`; between the
save and the update taking effect, this tool reports the new number while the old jobs are still the
ones doing the work. `pendingUpdate` is how a caller sees that, and it is why the demo's "pool size
now shows 4" step should be read after the queue starts draining, not before. Reporting the live job
count instead would need a different source and is not in MVP 2.

**Nullability.** `poolSize` is `null` **only** when the host is not a config item in this
production — and that case is an error (§4), so in practice a successful call always carries a
number. Stated anyway for one reason: **`PoolSize: 0` is a real configured value** with a
framework-defined meaning, not an unmeasurable one. Coercing `0` to `null` here would be the same
defect in the opposite direction. Measured live on the running instance: all four LABDEMO items are
`PoolSize=1`, including `Cloud API`, which is what makes the scenario real rather than staged.

### 3.4 `get_recent_errors` — read, and the one with a data-boundary problem

Recent error events for one host, **sanitised**. Read §6 before implementing this tool.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Config item name. |
| `sinceMinutes` | integer | optional, default `15` | Window, 1..60. Bounded rather than open — see §6. |

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed. |
| `sinceMinutes` | integer | The window actually applied. **Echoes the input name** — see the reconciliation note below. |
| `count` | integer \| null | Events in the window. `null` when the log could not be read, **never `0`**. |
| `byCode` | array | One entry per distinct `errorCode`, with a count and a catalogue summary. |
| `sanitised` | boolean | Always `true`. Present so its absence is conspicuous. |

Each `byCode` entry:

| Field | Type | Notes |
|---|---|---|
| `errorCode` | string | The IRIS error token only — `<Ens>ErrFailureTimeout`, `#6059`, `#5021`, or `unclassified`. |
| `count` | integer | Occurrences of this code in the window. |
| `summary` | string \| null | A **catalogue** string keyed by `errorCode`, from the table in §3.4a. `null` when unclassified. |
| `secondsAgo` | integer \| null | Age of this code's **newest** occurrence, in whole seconds. `null` when unmeasurable — never `0`, which would read as "just now". |

Plus one field on the reply itself:

| Field | Type | Notes |
|---|---|---|
| `newestSecondsAgo` | integer \| null | Age of the newest error of **any** code, so a consumer need not scan `byCode` to ask "is this still happening". `null` when there are no errors at all. |

**WHY AGE, WHEN THE WINDOW ALREADY BOUNDS IT (added 2026-08-23).** A count inside a window cannot
distinguish *happening* from *happened*, and that distinction decides the diagnosis. Measured on one
host in one second:

```
sinceMinutes 15  ->  count 0,   byCode []
sinceMinutes 60  ->  count 134, byCode [#6059 x63 ...], newest 1315s ago
```

Both true. A queue building behind a single worker was diagnosed as a **connectivity failure** from
22-minute-old `#6059` rows still inside the 60-minute window — the host had stopped erroring entirely.
The window cannot settle it either way: narrow it and the MVP 3 missing-folder scenario disappears,
because that host logs `#5021` once on entering `Error` and then goes quiet. So the window stays wide
enough to see a one-shot fault and the **conclusion** keys on age.

**A TIMESTAMP IS NOT CONTENT.** `secondsAgo` is a duration derived from a row's own clock field. It
carries nothing typed by a person and nothing derived from a message, so it sits on the metrics side
of root `CLAUDE.md` §2.1 — unlike the message text, which remains unreturnable for the reasons in
§3.4a. Emitting the absolute timestamp instead was considered and rejected: an elapsed count answers
the only question asked of it and cannot be correlated against anything outside the instance.

Consumers must treat `null` as **unmeasurable, not recent** — §2.1's nullability rule in the time
dimension, and the third shape of the same defect this project has hit (#33, #49, #58 were the value
dimension).

**RECONCILED WITH THE IMPLEMENTATION 2026-08-20, and the contract moved further than the code.** This
table specified something the tool has never emitted, and the two shapes differed in kind rather than
by a field (@kskubach, MVP 3 spec §2.4; @Ari-Glikman, #112 review):

| | this table, before | `Tools/Read.cls` |
|---|---|---|
| window echo | `windowMinutes` | `sinceMinutes` |
| array | `errors[]` of per-event rows | `byCode[]` of `{errorCode, count}` |
| `truncated` | specified | absent |
| `limit` input | specified | not a parameter |
| `occurredAt`, `sourceClass` | specified | absent |

**The implementation's shape is kept and the contract corrected to it, except for `summary`.** Three
reasons, in ascending order of weight:

1. **`sinceMinutes` on both sides.** A different name on input and output is a translation step for no
   gain, and the divergence proves nobody wanted it. One name.
2. **Aggregation beats per-event rows for the consumer that exists.** The agent asks *"what kind of
   thing is going wrong and how often"*, and `byCode` answers exactly that. Per-event rows with
   timestamps invite an agent to reason about individual occurrences, which is the reasoning the data
   boundary cannot support — the row it would want to quote is the one that may carry PHI.
3. **`limit` and `truncated` were solving a problem aggregation removes.** They exist to bound a list
   of events; there are at most a handful of distinct codes, so there is nothing to truncate. Removing
   them removes two fields nothing emitted and nothing needed.

**`summary` is the one thing the contract was right about, and it is added rather than dropped.** MVP
3's missing-folder scenario needs the agent to learn *what kind of failure* `#5021` is without reading
log text — see §3.4a. It is a property of a code, so it lives on a `byCode` entry naturally, which is
where the original `errors[]` shape had nowhere to put it.

**`occurredAt` and `sourceClass` are dropped, not deferred.** Neither is emitted, neither is needed by
the one consumer, and `occurredAt` on an aggregate is meaningless. A field specified and unimplemented
for a month is a claim the document should stop making.

### 3.4a The `summary` catalogue — configuration knowledge, not log text

`summary` is a **fixed string looked up by `errorCode`**. It is not derived from the log row, so it
cannot carry payload-derived content by construction — which is the whole reason it is safe to send
and the reason it is a catalogue rather than a message excerpt.

| `errorCode` | `summary` |
|---|---|
| `#5021` | `a configured directory or file path does not exist` |
| `#6059` | `the configured downstream host or port could not be reached` |
| `<Ens>ErrFailureTimeout` | `the host retried and gave up within its failure timeout` |
| `unclassified` | `null` |

**THE ALLOWLIST MUST NOT GAIN AN EXCEPTION FOR `#5021`.** The obvious shortcut for MVP 3 is to return
`#5021`'s message text, because it contains the missing path and the path is *usually* harmless. That
is the wrong shape twice over: an allowlist with one exception is an allowlist an implementer widens,
and "usually harmless" is the rare-rather-than-absent pattern that survives review and then leaks.
The path is obtained instead from the host's configured settings — configuration, which §6 permits —
and this catalogue supplies the *kind* of failure.

**Adding a row is a contract change**, deliberately. A code that reaches an agent with a
human-readable meaning is a decision about what the model is told, not an implementation detail.

**Wraps** `Ens.Util.Log` filtered to error and alert types for the host, plus a count of
`Ens.MessageHeader` rows at `Status = 8` (Error) — the same `MSGSTATUSERROR = 8` that
`HostStatusDispatcher` reads from the compiled `VALUELIST` rather than guessing.

**Why this tool is dangerous.** Its outputs leave the instance (§6). Error text on this pipeline is
generated by HL7 message processing, so it can contain payload-derived content — patient
identifiers, segment fragments, a target URL with a query string. Measured on the running instance,
`Ens_Util.Log` currently holds these real error texts for `Cloud API` and `EMR Source`:

```
ERROR <Ens>ErrFailureTimeout: FailureTimeout of 1 seconds exceeded in
  ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation; status from
  last attempt was ERROR #6059: U...
ERROR #6059: Unable to open TCP/IP socket to server 127.0.0.1:59999
ERROR <Ens>ErrProductionSettingInvalid: Production setting 'PollInterval' for item
  'EMR Source' is invalid
```

None of those three contains PHI. That is not the argument for returning them — **it is the argument
for not deciding case by case.**

**And the case-by-case reading is now measured to be a trap.** Counted on the running instance
(`docs/mvp2-aihub-verified-api.md`): `Ens_Util.Log` holds **61,772 `Type=4` info rows, every one
carrying a `PatientID`**, against **66 `Type=2` error rows, none of which do**. So filtering to
`Type >= 2` and returning the text would pass any test written against today's log — and be wrong
anyway, because that separation is a property of how `$$$LOGINFO` and `$$$LOGERROR` happen to be
used in `PatientDemographicsOperation`, not of the log. One `$$$LOGERROR` interpolating a patient
id puts PHI into the error rows, and that operation already builds `PatientID` strings for its info
path. A ratio of 61,772 to 66 makes the unsafe case rare rather than absent, which is the worst
shape a defect can have: it survives review, survives the demo, and shows up in production. The tool cannot know which case it is in, so:

**Sanitisation is an allowlist, never a denylist.** The tool extracts the leading IRIS error token
and nothing else from the raw text, then looks `summary` up in a fixed in-code catalogue of known
codes. Text that does not match a known code yields `errorCode: "unclassified"` and `summary: null`.
**No path returns free-form log text**, including text that happens to be safe — the third example
above is pure configuration and it is still not forwarded verbatim, because a rule with an exception
is a rule an implementer will widen.

A denylist — regex out anything that looks like an MRN, a date of birth, a name — cannot be shown
correct, and its failures are silent and unbounded. An allowlist's failure is a visible
`unclassified` with no text, which is a worse *diagnostic* and a safe *boundary*. That trade is
deliberate. If the demo needs richer text, the answer is adding a code to the catalogue, in code,
reviewed — not loosening the filter.

**May return:** counts, ISO timestamps, IRIS error codes, the config item name, class names, and
catalogue summary strings.
**Must never return:** message content or any part of it, HL7 segments or fields, patient
identifiers of any kind, `Ens.MessageBody` or `Ens.MessageHeader` field values other than a count,
stack traces, and raw `Ens.Util.Log` text.

**Nullability.** `count` is `null` when the log could not be read — never `0`, because "no errors"
is the single most consequential wrong answer this tool can give an agent diagnosing an error
condition. An empty `errors` array with `count: 0` is a measurement; an empty array with
`count: null` is not, and the agent must treat them differently.

**Worked example, showing sanitisation.**

Raw rows in `Ens_Util.Log` (what the tool reads, and what it must not publish):

```
2026-08-18 07:46:29.533  Cloud API  ERROR <Ens>ErrFailureTimeout: FailureTimeout of 1
  seconds exceeded in ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation;
  status from last attempt was ERROR #6059: U...
2026-08-18 07:46:29.533  Cloud API  ERROR #6059: Unable to open TCP/IP socket to server
  127.0.0.1:59999
```

```jsonc
// -> get_recent_errors
{ "host": "Cloud API", "sinceMinutes": 15 }
```

```jsonc
// <- what the agent, and therefore the external LLM, sees
{
  "host": "Cloud API",
  "sinceMinutes": 15,
  "count": 42,
  "sanitised": true,
  "byCode": [
    {
      "errorCode": "<Ens>ErrFailureTimeout",
      "count": 27,
      "summary": "the host retried and gave up within its failure timeout"
    },
    {
      "errorCode": "#6059",
      "count": 15,
      "summary": "the configured downstream host or port could not be reached"
    }
  ]
}
```

And the MVP 3 scenario, where the host is a service that cannot read its inbound directory:

```jsonc
// <- get_recent_errors for EMR Source
{
  "host": "EMR Source",
  "sinceMinutes": 15,
  "count": 8,
  "sanitised": true,
  "byCode": [
    { "errorCode": "#5021", "count": 8, "summary": "a configured directory or file path does not exist" }
  ]
}
```

Note what did **not** survive: the `127.0.0.1:59999` target, the timeout value, the missing path, and
every character of the original text. `summary` is written by us and indexed by code (§3.4a), so the
agent learns the KIND of failure from this tool and the offending path from the host's configured
settings — never from a log row.

**The `#5021` entry is the whole reason MVP 3 needs this tool at all**, and it is also why the tool
alone is insufficient: `count: 8` and that summary tell the agent a path is missing and not *which*
path. Naming it requires reading configuration, which is a different tool and a different boundary.

### 3.4b `get_host_settings` — read, added in MVP 3

The configured adapter settings for one host, **filtered by an allowlist of setting names**.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Config item name. |

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed. |
| `found` | boolean | `false` with an `error` when the host is not in the running production. |
| `settings` | object | Permitted setting names to their values. Absent names are absent, not null. |
| `settingsOnItem` | integer | How many settings the item carries **before** filtering. |

Permitted names: `FilePath`, `ArchivePath`, `WorkPath`, `FileSpec`, `PollInterval`, `HTTPServer`,
`HTTPPort`, `URL`, `TargetConfigNames`, plus `PoolSize` (a property of `Ens.Config.Item`, not a
settings row — the same value `get_pool_size` publishes, not a second source of truth).

**WHY THIS TOOL EXISTS, and it is a boundary decision rather than a convenience.** MVP 3's scenario
needs the agent to name a directory a service cannot read. That name lives in exactly two places:
the `#5021` log message, and the configuration. `get_recent_errors` will never return log text
(§3.4, §6), so without this tool the agent learns *a path is missing* and never *which path*.
Configuration is what root `CLAUDE.md` §2.1 permits — a setting value was typed by whoever deployed
the production, not derived from a message.

**AN ALLOWLIST, NOT THE WHOLE COLLECTION.** Returning every setting is one `Credentials` row away
from handing an external LLM the name of a credential set, and one future setting away from
something worse: productions are configured by people, and people put surprising things in free-text
settings. So the tool names what it returns and refuses the rest by construction — the same
reasoning as `set_pool_size`'s single whitelisted host.

**`Credentials` is deliberately absent** even though it is only an identifier. It names a stored
secret, and no diagnosis needs it enough to justify saying its name outside the instance.

**`settingsOnItem` exists so filtering is visible.** Without it, a host configured entirely through
refused settings looks identical to one with no configuration at all — and "this host has nothing
set" is a materially different diagnosis from "I am not allowed to see what is set".

```jsonc
// -> get_host_settings
{ "host": "EMR Source" }
```

```jsonc
// <- the missing-folder scenario, armed
{
  "host": "EMR Source",
  "found": true,
  "settings": {
    "FilePath": "/tmp/labdemo/hl7-in-missing/",
    "FileSpec": "*.hl7",
    "ArchivePath": "/tmp/labdemo/hl7-archive/",
    "PollInterval": "2",
    "TargetConfigNames": "Lab Router",
    "PoolSize": 1
  },
  "settingsOnItem": 6
}
```

Combined with `get_recent_errors`, the agent can conclude: *`EMR Source` is in Error; a `#5021` was
logged, which means a configured path does not exist; its `FilePath` is
`/tmp/labdemo/hl7-in-missing/`* — a specific diagnosis built entirely from configuration and a
catalogue, with no log text crossing the boundary.

Measured on `Cloud API`, which carries a `Credentials` setting: `settingsOnItem` reads `4` and
`settings` returns `3`. The filter is doing something, and the response says so.

### 3.5 `get_processing_time` — read

Average processing and queueing time for one host.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Config item name. |

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed. |
| `avgProcessingTime` | number \| null | **Seconds.** |
| `avgQueueingTime` | number \| null | **Seconds.** |
| `sampleCount` | integer \| null | Total weight behind the averages. |
| `aggregated` | boolean | Always `true` — see below. |
| `unit` | string | `"seconds"`. Stated in the payload because a unit error here is invisible. |

**Wraps** `iris_interop_avg_processing_time` and `iris_interop_avg_queueing_time`, aggregated the
way `services/metrics-proxy/src/parser.js` aggregates them: IRIS emits one series per
`(host, messagetype)`, and they are collapsed to one number **weighted by
`iris_interop_sample_count`**. A plain mean is wrong when one message type dominates;
last-write-wins is wrong always. `aggregated: true` says so in the payload, because a host handling
two message types reports their weighted mean and not either one (Q12).

**Nullability.** Both averages are `null` when the host has processed nothing since stats were
enabled — IRIS emits these families **only** for hosts with activity, and in a live capture they
appeared for exactly one host of thirteen. `null` here means "not measured", never "instant". A
`0.0` returned for an idle host would tell an agent diagnosing `slow_processing` that processing is
infinitely fast, which is the inverse of the truth. `sampleCount` is the discriminator: `null`
averages with `sampleCount: null` is an absent family; if a build ever emits a real zero, the
sample count will be non-null and say so.

Reference values, measured not invented: `Cloud API` configured at 0.05s latency reports `0.05`;
`Lab Router` reports `0.08`.

### 3.6 `set_pool_size` — the only write tool

Set the configured pool size of one host and apply it to the running production.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Must be `Cloud API`. Whitelist of one. |
| `size` | integer | **required** | `2..8` inclusive — see bounds below. |

**There is no `dryRun` parameter, deliberately.** This tool always writes. Preview is
`get_pool_size`, a *read* tool. That is a reconciliation with `resolve-api.md` §2, which guarantees
structurally that a `dry_run` cannot mutate: the engine's dry-run path calls `get_pool_size` and the
checks, and **never invokes `set_pool_size` at all**, so no code path exists that could write. A
`dryRun` flag on the privileged tool would weaken that from "the tool was not called" to "the tool
was called with a flag that made it not write", and would add a non-writing branch to the one tool
whose entire justification is that it writes. **One tool, one job.**

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed. |
| `production` | string | The production actually changed. |
| `previousSize` | integer | The value before the call. **This is what makes the action reversible.** |
| `requestedSize` | integer | Echoed. |
| `appliedSize` | integer | Read back from the saved config after the write, not assumed from `requestedSize`. |
| `applied` | boolean | Always `true` on a successful return; a call that did not apply is an error (§4), not a result with `false`. |
| `updateProduction` | string | `ok`, or the failure reason from `Ens.Director.UpdateProduction()`. |
| `reversal` | object | `{"tool": "set_pool_size", "host": ..., "size": <previousSize>}` — the exact call that undoes this one. |
| `sampledAt` | string | ISO 8601 UTC. |

`applied` is present rather than implied because the audit record and `resolve-api.md`'s `outcome`
both key off it, and a field that is always `true` on success is cheap insurance against a future
partial-apply mode being added without a discriminator.

**Wraps** the write path `iris/labdemo/Triggers.cls` already proves in this production:
`Ens.Config.Production.%OpenId(...)` → locate the `Ens.Config.Item` by name → set `PoolSize` →
`def.%Save()` → `Ens.Director.UpdateProduction()`. Nothing new; the same three moves as
`Triggers.SetSetting` / `SetEnabled` followed by `Triggers.UpdateProduction`.

**Guards, and where each one comes from.**

1. **Refuse unless the running production is the expected one**, as
   `Triggers.CheckProduction()` does. `Ens.Director.GetProductionStatus()` must report
   `ProductionGuardian.LabDemo.Production`. Rationale from #34: a tool that silently edits the wrong
   production is worse than one that refuses.

   **And one place this tool must be STRICTER than the proven path.** `CheckProduction()` treats a
   production that is not Running as a *warning*, not a refusal — "a stopped production accepts
   config edits that take effect on start, which is confusing rather than wrong". That is right for
   a trigger that arms a condition for later, and wrong here: against a stopped production `%Save()`
   succeeds, `UpdateProduction()` changes no running job, `appliedSize` reads back the saved value,
   and the response says applied — while nothing drains, because nothing is running. True field by
   field and false as a whole. **State `1` (Running) is required.** Recorded because someone will
   read `Triggers.cls`, see a warning, and "align" the tool with the proven path; the proven path is
   proven for a different job. Matches `resolve-api.md`'s `production_not_running` refusal.
2. **Refuse if the config item is not found.** Track that the *item* was found, not just that a loop
   completed — the `foundItem` lesson from `Triggers.SetSetting` (#66). A rename in `Production.cls`
   would otherwise make this method a silent no-op that reports success, and `CheckProduction()` does
   not catch it because it compares only the production *name*. **A write tool that reports applied
   and applied nothing is the worst failure in this file.**
3. **Bounds.** `host` must be `Cloud API`; `size` must be an integer in `2..8`. Anything else is an
   error, not a clamp — clamping `40` to `8` would apply a change nobody approved, report it as
   applied, and be indistinguishable in the audit log from someone deliberately choosing `8`.
4. **Reversibility is returned, not remembered.** `previousSize` and `reversal` are in the response
   so the caller can undo without the tool holding state. A stateful undo would be a second thing to
   get wrong.
5. **Step 3 is a PROPERTY, not a setting.** `PoolSize` is a property of `Ens.Config.Item`
   (`PoolSize As %Library.Integer`, verified against `%Dictionary.CompiledProperty` on the running
   instance), so the tool assigns `item.PoolSize` directly. It must **not** go through the `Settings`
   collection the way `Triggers.SetSetting()` does. `SetSetting` is the closest existing code, and
   copying it here would add an `Ens.Config.Setting` row named `PoolSize` that changes nothing while
   reporting success — #66's failure mode in a new place.

**Why `2..8` at both layers — the asymmetry was withdrawn on 2026-08-20 (#100).**

| Layer | Range | Why |
|---|---|---|
| `POST /api/resolve` (`resolve-api.md` §3) | `2..8` | An operator-facing action. `1` is the shipped value, so approving it is a no-op dressed as a fix. |
| `set_pool_size` (here) | `2..8` | Same reason. The tool is LLM-callable, so `1` is the *worst* value to accept: it reports success and changes nothing. |

This section previously ratified `1..8` here against `2..8` at the endpoint, on the grounds that "a
tool that refuses `1` cannot undo its own first call". **The premise was true and the conclusion did
not follow**, which is the third time on this contract set that shape has cost us something (see the
`%`-prefix paragraph and §5.5's audit claim).

Two things it missed. `Tools.Resolve` has shipped `MINSIZE = 2` since the tools landed and its own
comment rejects the reversal argument by name — *"Reversal to `1` is `Reset()`'s job, through a path
that is not LLM-callable"* — so the ratified range never described the implementation. And
`resolve-api.md` §4 promised the caller could POST the reversal body back to undo, while §3 refused
exactly that body: the undo path the wider bound existed to serve **did not work at either layer**.

`resolve-api.md` §4.1 now records reversal as a *record of the prior value* rather than a request, and
restoring the pool is an operator action through `Triggers.Reset()`. With no POST-the-reversal path,
nothing needs `1`, and accepting it in an LLM-callable tool is a liability rather than a capability.

`8` is the shared ceiling, for `resolve-api.md`'s reason: every pool job is a real IRIS process, and
an unbounded `size` lets one fat-fingered digit — or one hallucinated number — spawn hundreds of jobs
and denial-of-service the production this tool exists to protect. `4` is the scenario's target and
`8` leaves the rehearsal headroom MVP 2 §6 asks for.

**`0` is excluded from both.** Its meaning is adapter- and version-dependent and nobody here has
verified it; on some host classes it means "no dedicated jobs", which would stop the host and produce
exactly the `dead_host` finding Smart Resolve exists to avoid causing. Excluded rather than reasoned
about — an unverified claim about IRIS semantics has no place in the bounds check of a write tool.

Widening either range is a **change to a contract**, not a configuration tweak. That is the point of
writing the bound here rather than in a settings file.

**What this tool does NOT enforce: human approval.** The safety model in root `CLAUDE.md` §2.1 says
nothing applies unattended, and the tool cannot verify that. It has no way to know whether a human
clicked Approve; it sees an authorized caller and a bounded argument. **Approval is enforced upstream**,
at Dev B's `POST /api/resolve` and Dev C's approval UI. Stated plainly because "the write tool is
governed" invites the reading that approval lives in the tool, and it does not. What the tool
enforces is *authorization, bounds, target, and reversibility*. Four of the five safety properties;
the fifth is somebody else's.

**Worked example — applied.**

```jsonc
// -> set_pool_size
{ "host": "Cloud API", "size": 4 }
```

```jsonc
// <-
{
  "host": "Cloud API",
  "production": "ProductionGuardian.LabDemo.Production",
  "previousSize": 1,
  "requestedSize": 4,
  "appliedSize": 4,
  "applied": true,
  "updateProduction": "ok",
  "reversal": { "tool": "set_pool_size", "host": "Cloud API", "size": 1 },
  "sampledAt": "2026-08-18T08:16:02.117Z"
}
```

**Worked example — the reversal**, which is why the tool's lower bound is `1`:

```jsonc
// -> set_pool_size   (the `reversal` object from the response above, replayed)
{ "host": "Cloud API", "size": 1 }
```

```jsonc
// <-
{
  "host": "Cloud API",
  "production": "ProductionGuardian.LabDemo.Production",
  "previousSize": 4,
  "requestedSize": 1,
  "appliedSize": 1,
  "applied": true,
  "updateProduction": "ok",
  "reversal": { "tool": "set_pool_size", "host": "Cloud API", "size": 4 },
  "sampledAt": "2026-08-18T08:22:10.004Z"
}
```

**Worked example — denied.** The same apply call from a caller holding `PG_Read` but not
`PG_Resolve`. There is **no result object at all**: the runtime refuses before `%Invoke` runs
(§5.2), so this is an error response and not a `set_pool_size` payload with `applied: false`.

```jsonc
// -> set_pool_size
{ "host": "Cloud API", "size": 4 }
```

```jsonc
// <-
{
  "error": "tool_access_denied",
  "tool": "set_pool_size",
  "reason": "set_pool_size requires PG_Resolve:USE",
  "audited": true
}
```

The distinction that matters: a denial means the pool size **was not read, was not saved, and
`UpdateProduction()` was not called**. Nothing partially happened (§5.2). Contrast a *failure* —
wrong production, item not found — where the tool did run and reports through `%ToolError`. Both are
audited (§5.5), and `resolve-api.md` maps them to `not_authorized` and `failure.stage` respectively.

---

### 3.7 `get_activity_coverage` — read, added for the activity chat assistant

Which hosts have recorded activity, over what period, and at which resolutions. **The orientation
call**: it is what makes a valid `host` argument and an honest date range knowable without guessing.

**Input** — none.

**Output**

| Field | Type | Notes |
|---|---|---|
| `namespace` | string | The namespace reported on. Pinned to the tool's own, not an argument. |
| `readable` | boolean | `false` with an `error` when no activity table could be read. |
| `resolutions` | array | One entry per resolution — see below. |
| `hosts` | array | One entry per host with recorded activity, busiest first. |

`resolutions[]`: `resolution` (`seconds` \| `hours` \| `days`), `buckets` (row count),
`periodSeconds` (bucket width, **null when the table is empty** — an empty table has not said what
its width is), `earliestUTC`, `latestUTC`. `periodVaries` and `periodSecondsMax` appear **only** if a
table holds mixed widths, which would mean the table is not what the tool assumes.

`hosts[]`: `host` (config item name, verbatim), `hostType`, `application`, `messages`,
`firstActivityUTC`, `lastActivityUTC`.

**`hostType` is `service` \| `process` \| `operation` \| `actor_pool` \| `unknown`.** Translated from
the numeric `HostType` column, whose mapping is read from the column's own description in
`%Dictionary.CompiledProperty` (`1=Service, 2=Process, 3=Operation, 4 = Production Actor Pool`) —
there is no `VALUELIST` to read. **It can disagree with `Ens.Config.Item.BusinessType()` and that is
not a bug:** measured, `Lab Router` is `businessType=2` on the config item and `HostType=4` in the
activity tables, because a routing engine is *configured* as a process and its activity is *recorded*
against the actor pool that runs it. This tool reports what was recorded. Note this is also **not**
normalised the way `healthscan-api.md` Q10 normalises `actor` to `process`.

**`application` distinguishes the production's own hosts from framework plumbing**, computed from
`Production.cls`'s `<Item>` set minus `Ens.*`-prefixed names rather than from a list in the tool. The
activity tables record hosts that are not config items at all — `Ens.MonitorService`,
`Ens.Alerting.AlertMonitor`, `Ens.ScheduleService`, `Ens.ScheduleHandler` — and
`Ens.Activity.Operation.Local` **is** a config item that `iris/CLAUDE.md` §3 states is not an
application host. Both resolve to `false`. Without this an agent asked "which host is slowest"
can report the framework's own bookkeeping as a finding.

```jsonc
// <- measured on the live instance, abridged to three hosts
{
  "namespace": "LABDEMO",
  "readable": true,
  "resolutions": [
    { "resolution": "seconds", "buckets": 22220, "periodSeconds": 10,
      "earliestUTC": "2026-08-20T09:07:30Z", "latestUTC": "2026-08-23T11:26:00Z" },
    { "resolution": "hours", "buckets": 112, "periodSeconds": 3600, "earliestUTC": "2026-08-20T09:00:00Z", "latestUTC": "2026-08-23T11:00:00Z" },
    { "resolution": "days", "buckets": 29, "periodSeconds": 86400, "earliestUTC": "2026-08-20T00:00:00Z", "latestUTC": "2026-08-23T00:00:00Z" }
  ],
  "hosts": [
    { "host": "EMR Source", "hostType": "service", "application": true, "messages": 32501,
      "firstActivityUTC": "2026-08-20T09:00:00Z", "lastActivityUTC": "2026-08-23T11:00:00Z" },
    { "host": "Lab Router", "hostType": "actor_pool", "application": true, "messages": 32501, "firstActivityUTC": "2026-08-20T09:00:00Z", "lastActivityUTC": "2026-08-23T11:00:00Z" },
    { "host": "Ens.MonitorService", "hostType": "service", "application": false, "messages": 11598, "firstActivityUTC": "2026-08-20T09:00:00Z", "lastActivityUTC": "2026-08-23T11:00:00Z" }
  ]
}
```

### 3.8 `get_activity_trend` — read

One host's throughput and latency, bucket by bucket, so a rise or fall is visible rather than
averaged away.

**Input**

| Field | Type | Req | Notes |
|---|---|---|---|
| `host` | string | **required** | Config item name. |
| `resolution` | string | optional, default `hours` | `seconds` \| `hours` \| `days`. |
| `buckets` | integer | optional, default `24` | `1..720`. |

**Both optional parameters restate their default in the body**, per §2 — an omitted key arrives as
`""` and the ObjectScript default never fires. Verified for this tool specifically, because that bug
was live for four days in `get_recent_errors`:

```
Invoke("GetActivityTrend", {"host":"Cloud API"})  ->  resolution "hours", 22 buckets   (NOT a refusal)
Invoke("GetActivityTrend", {"host":"Cloud API","buckets":9999})  ->  {"error":"buckets must be an integer between 1 and 720"}
Invoke("GetActivityTrend", {"host":"Cloud API","buckets":0})     ->  {"error":"buckets must be an integer between 1 and 720"}
```

Absence uses the default; a value the model **sent** and got wrong is still refused with its range
named.

**Output**: `host`, `resolution`, `measured`, `buckets[]`, `from`, `to`, `totals`,
`aggregatedAcross`. `reason` instead of buckets when there is no data; `error` when unreadable.

`buckets[]`: `startUTC`, `periodSeconds`, `messages`, `avgProcessingTime`, `avgQueueingTime`,
`messagesPerSecond`. Oldest first.

`totals`: `messages`, `avgProcessingTime`, `avgQueueingTime` over exactly the buckets returned.
**Weighted by message count by construction** — the sums are summed and divided once, where averaging
the per-bucket averages would weight a one-message bucket like a thousand-message one.

**`buckets` is a count of ROWS, not a wall-clock window.** The newest N buckets that exist are
returned, with no time cutoff, so "the last 24 hours" and "the last 24 hours that had traffic" are
distinguishable: every returned bucket is one that exists, and `from`/`to` state the span actually
covered. A cutoff would silently return fewer buckets for an idle host and read as missing data.

**An empty result distinguishes an unknown host from a silent one**, checked against the production's
config item set rather than inferred from the absence of rows:

```jsonc
{ "host": "No Such Host", "resolution": "hours", "buckets": [], "measured": false,
  "reason": "no activity recorded, and 'No Such Host' is not a config item in ProductionGuardian.LabDemo.Production" }
```

**`aggregatedAcross` states what was collapsed** rather than leaving it implicit: `instances` is
always `true`, and `messageKinds` is `true` when the host wrote more than one `SiteDimension` series.
`Instance` is part of the table's grain and a long-lived volume holds several — this one has rows
under three container lifetimes — so a reply that summed across them silently would be a number
nobody could reproduce.

```jsonc
// <- Cloud API, hours, 6 buckets. Real values: the pool bottleneck is visible in the queueing time.
{
  "host": "Cloud API", "resolution": "hours", "measured": true,
  "buckets": [
    { "startUTC": "2026-08-23T06:00:00Z", "periodSeconds": 3600, "messages": 1800, "avgProcessingTime": 0.006011, "avgQueueingTime": 0.002471, "messagesPerSecond": 0.5 },
    { "startUTC": "2026-08-23T09:00:00Z", "periodSeconds": 3600, "messages": 881, "avgProcessingTime": 2.685064, "avgQueueingTime": 387.968395, "messagesPerSecond": 0.2447 }
  ],
  "from": "2026-08-23T06:00:00Z", "to": "2026-08-23T11:00:00Z",
  "totals": { "messages": 9681, "avgProcessingTime": 1.005398, "avgQueueingTime": 81.249508 },
  "aggregatedAcross": { "instances": true, "messageKinds": true }
}
```

### 3.9 `compare_host_activity` — read

Every host ranked over **one** window, so "which host is busiest" is a single call rather than one
trend call per host.

**Input**: `resolution` (optional, default `hours`), `buckets` (optional, default `24`, `1..720`).
Same restated-default and refusal behaviour as §3.8.

**Output**: `resolution`, `measured`, `from`, `to`, `bucketsRequested`, `hosts[]`.

`hosts[]`: `host`, `hostType`, `application`, `messages`, `avgProcessingTime`, `avgQueueingTime`,
`totalProcessingTime`, `bucketsWithActivity`, `messageKinds[]`. Ordered by message count descending.

**`totalProcessingTime` is kept alongside the average because they answer different questions**: the
average says how slow each message was, the total says where the instance's time actually went. A
host at 0.001s × 12,000 messages and one at 1.0s × 12 have the same story in only one of the two.

**The window is derived from the data, not the clock.** The newest `buckets` distinct time slots
present are found first and every host is compared over exactly those, so the comparison is never
between different periods for different hosts — which is the defect a "compare" tool exists to avoid.

#### `messageKinds` — a CLASSIFICATION of `SiteDimension`, never the value

**This is the data-boundary decision in this tool family and it is not visible from the column name.**
`Ens_Activity_Data.*.SiteDimension` is **derived from message body content**. Traced through the
platform: `Ens.Util.Statistics.GetStatsUserDimension` opens the in-flight `Ens.MessageHeader`, opens
its body, and calls **`GetStatsDimension()` on the message body object**.
`EnsLib.HL7.Message.GetStatsDimension` returns `..Name`; `Ens.MessageBody` returns the default `-`;
where the body declines the fallback is the body **class name**.

So the value is chosen *by the message*, `GetStatsDimension` is an **overridable hook**, and a
per-host override exists as well (`SetStatsUserDimension`, stored under
`^Ens.Config("stats","userdim")`) — an operator can put free text there without touching a class.
That makes the column structurally identical to `Ens_Util.Log.Text` (§3.4): safe on today's instance
because of how the writing code happens to be used, unsafe the moment a hook is overridden. **Same
answer as §3.4a: classify against an allowlist, never pass the value through.**

A value is published **only when this instance can independently verify it names configuration**:

| `kind` | `verifiedAs` | Verified against |
|---|---|---|
| `none` | `platform_default` | The literal `-` / empty — no message contributed it |
| the value | `hl7_message_structure` | `EnsLib.HL7.Schema:MessageStructures` |
| the value | `compiled_class` | `%Dictionary.CompiledClass` |
| `other` | `unverified` | Nothing. **No text is returned.** |

Not a regex, deliberately: "looks like a class name" passes `Patient.Smith.John`, and "looks like an
HL7 structure" passes `MRN_00998877`. Checking against what the instance actually holds is the
strongest available test and it **fails closed** — an unreadable schema table yields `false`, so a
read failure cannot become a disclosure.

**Demonstrated, by writing a PHI-shaped dimension into the table for a real host** and asking the
tool. The row genuinely contained `SMITH^JOHN^A^MRN12345678`:

```jsonc
// Cloud API's messageKinds, with that row present
[ { "kind": "ProductionGuardian.LabDemo.Message.PatientDemographics", "verifiedAs": "compiled_class" },
  { "kind": "other", "verifiedAs": "unverified" } ]
// and the full reply contains neither "SMITH" nor "MRN12345678"
```

Entries are **deduplicated on the classification, not on the raw value**, so several unverifiable
dimensions collapse to one `other` rather than revealing how many distinct values existed — which
would itself be a small disclosure about the traffic.

```jsonc
// <- hours, 6 buckets, abridged. Cloud API's total processing time is where the time went.
{
  "resolution": "hours", "measured": true,
  "from": "2026-08-23T06:00:00Z", "to": "2026-08-23T11:00:00Z", "bucketsRequested": 6,
  "hosts": [
    { "host": "EMR Source", "hostType": "service", "application": true, "messages": 12318,
      "avgProcessingTime": 0.003073, "avgQueueingTime": 0, "totalProcessingTime": 37.858,
      "bucketsWithActivity": 6,
      "messageKinds": [ { "kind": "ADT_A01", "verifiedAs": "hl7_message_structure" } ] },
    { "host": "Cloud API", "hostType": "operation", "application": true, "messages": 9681,
      "avgProcessingTime": 1.005398, "avgQueueingTime": 81.249508, "totalProcessingTime": 9733.256,
      "bucketsWithActivity": 6,
      "messageKinds": [ { "kind": "ProductionGuardian.LabDemo.Message.PatientDemographics", "verifiedAs": "compiled_class" } ] },
    { "host": "Ens.MonitorService", "hostType": "service", "application": false, "messages": 3851,
      "avgProcessingTime": 0.001277, "avgQueueingTime": 0, "totalProcessingTime": 4.918,
      "bucketsWithActivity": 6,
      "messageKinds": [ { "kind": "none", "verifiedAs": "platform_default" } ] }
  ]
}
```

#### What the three tools assume about the tables, measured rather than documented

**They are not a pipeline.** `Ens.Activity.Utils.AddActivity` writes **all three rows in one
transaction**, each into its own bucket via `RoundTimeBack("hh"/"d", ...)`. There is no rollup job and
no ordering between them, so `Days` is not derived from `Hours` and the three cannot disagree except
by a purge. Verified: `SUM(TotalCount)` is 102,842 in all three.

**So choosing a table is choosing a RESOLUTION, never a freshness.** `Period` is the bucket width in
seconds and is constant per table — 10 / 3600 / 86400, confirmed by MIN/MAX over every row. Note
`Seconds` buckets at **ten** seconds, so its name is its unit and not its grain.

**Retention is purge-driven and nothing schedules it here.** `Ens.Activity.Data.<T>.Purge(period)`
deletes `TimeSlotUTC <= cutoff`; absent a caller, every table holds history back to its first message
and `Seconds` is simply the largest (22,220 rows against 112 and 29). A tool must never imply that a
short window is all the data there is — which is why §3.7 exists.

**`%EXACT(HostName)` in every query, and it is not cosmetic.** The column collates `SQLUPPER`, so a
bare `SELECT HostName ... GROUP BY HostName` returns `CLOUD API` — measured. §2 makes the config item
name the join key across four contracts and requires it verbatim, so an uppercased name would be one
that matches nothing the agent can pass back and nothing the engine can join on.

**`resolution` is looked up in a fixed `$case`, never concatenated into the query.** It arrives from a
model, and `"Ens_Activity_Data." _ resolution` would let one JSON field name any table in the
namespace. Verified: `{"resolution":"Ens_Util.Log"}` returns
`{"error":"resolution must be one of seconds, hours, days"}`.

#### A CALLER MAY BE GIVEN SOME READ FAMILIES WITHOUT THE OTHERS

`Tools.Governance.GovernAgent(agent, includeWrite, toolSets)` takes `"all"` (default), `"chat"`,
`"activity"` or `"current"`. **This is a correctness guard, not an additional safety one** — all three
families are `PG_Read` and none mutates anything.

| `toolSets` | Read families registered | Used by |
|---|---|---|
| `"all"` | §3.1–§3.5, §3.7–§3.9, §3.10–§3.11 | AI Detective |
| `"chat"` | §3.7–§3.9, §3.10–§3.11 | the chat assistant |
| `"activity"` | §3.7–§3.9 | — |
| `"current"` | §3.1–§3.5 | — |

`"chat"` was added rather than widening `"activity"` to mean both, so no existing caller's meaning
changed when the event-log family landed. `"activity"` still means §3.7–§3.9 exactly.

The reason is that §3.5 and §3.9 answer questions that *sound* identical. Measured through the
dashboard's own path, on the question "which host has the highest average queueing time":

```
get_processing_time("Cloud API")   ->  avgQueueingTime  0.12   <- true, and instantaneous
compare_host_activity("hours", 6)  ->  avgQueueingTime 77.66   <- true, and the answer
```

Both readings are correct. The answer built on the first was wrong by three orders of magnitude, and
it arrived with `confidence: 1` alongside two evidence bullets reading `NOT MEASURED` — confidently
wrong *and* self-contradicting. A second run on the same question produced "all hosts have reported an
average queueing time of null". **Prompt wording was tried first and did not fix it**: the chat
prompt already named each tool and what it was for.

So the chat assistant is registered with `"chat"` and cannot reach the current-state tools at all.
Verified by execution rather than by reading the registration, because
`ToolManager.FindTools()` is namespace-wide discovery and lists tools that are not registered:

```
ExecuteTool("CompareHostActivity", …)  ->  REACHABLE
ExecuteTool("GetProcessingTime", …)    ->  ERROR <%AICore>ToolNotFound
ExecuteTool("SetPoolSize", …)          ->  ERROR <%AICore>ToolNotFound
```

**AI Detective keeps `"all"`**, because it explains *one finding* rather than answering an open
question about a time range, and a root-cause diagnosis genuinely needs the live status, queue depth
and pool size beside the history. An unrecognised `toolSets` value is an **error**, not a default:
falling back to `"all"` on a typo would silently widen what an agent can reach.

### 3.10 `get_event_log_summary` — read, added in MVP 3

**Runtime name `GetEventLogSummary`.** What the production has *said about itself* over a recent
window, grouped by host and severity — the counterpart to §3.7–§3.9, which say how much moved and how
fast. Reads `Ens_Util.Log`.

**Input**: `sinceMinutes` (optional, default `60`, `1..1440`). **There is no host argument** — the tool
returns every host every time, which is the point: the caller usually does not yet know which host is
logging. A window outside the range is refused, not clamped:
`{"error":"sinceMinutes must be an integer between 1 and 1440","sanitised":true}`.

**Output**: `sinceMinutes`, `since`, `now`, `rows`, `bySeverity[]`, `byHost[]`,
`classifiedThroughSeverity`, `sanitised`, `retention`.

`bySeverity[]`: `severity`, `typeCode`, `count`. `byHost[]`: `host`, `rows`, `bySeverity[]`,
`distinctJobsAtLeast`, `distinctSessionsAtLeast`, `oldest`, `newest`, `faults[]`, `sources[]`,
`productionScope`, `application` — plus `lifecycleFaults[]` on the `(production)` entry only.

**The severity vocabulary is the full `Ens.DataType.LogType` enum**, read from its own
VALUELIST/DISPLAYLIST rather than assumed: `1 assert, 2 error, 3 warning, 4 info, 5 trace, 6 alert`.
Note that **`error` is `2`, not `1`** — so §3.4's `Type <= 2` filter means "assert or error" and
**excludes warnings**, which this tool can see and `get_recent_errors` structurally cannot.

**`(production)` is a sentinel host name, not a config item.** `ConfigName` is **NULL, not empty**, on
the rows `Ens.Director` writes about the production itself. Measured: `WHERE ConfigName = ''` returns
0 rows and `WHERE ConfigName IS NULL` returns 91. So no host-filtered query can ever reach them, and
they are reported under the parenthesised name — parenthesised because `Ens.Config.Item.Name` cannot
contain one, so a real host can never collide with it. `productionScope: true` marks the entry.

**Framework hosts are LABELLED, not filtered — a deliberate divergence from `healthscan-api.md` §2**,
which drops them. Nine host names come back on this instance and five are interop framework services
(`Ens.MonitorService`, `Ens.ScheduleHandler`, `Ens.Actor`, `Ens.Alarm`,
`Ens.Activity.Operation.Local`). §3.7's precedent is followed instead: `application` is `true` for a
config item of this production, `false` for framework plumbing, and **`null` for the `(production)`
entry**, which is neither. The inversion matters — `false` there would file the production's own start
failures under framework noise. Filtering would be wrong for a different reason: a framework service
*is* where some real faults are logged, and a tool that silently omits rows cannot be checked against
the row count it just published.

**`faults[]` classifies, it never quotes.** `errorCode`, `count`, `newest`, `summary` — the same
allowlist and the same `unclassified`/`null` pair as §3.4a, shared through `Tools.ErrorCatalogue`
rather than copied. `classifiedThroughSeverity: "warning"` states the boundary: **only `Type <= 3`
rows have their `Text` read at all.** That is structural, not a filter — the aggregate query selects
no text column, and the only query that does is bounded. The info population is where the PHI is
(measured: 61,772 `Type = 4` rows carry a `PatientID` in plain text against 66 `Type = 2` rows
carrying none), so it is counted by SQL and never enters a variable.

**`sources[]` is evidence, not a footnote.** `class`, `method`, `count` — published **only** when
`%Dictionary.CompiledClass` and `%Dictionary.CompiledMethod` confirm both names exist. When every code
in `faults[]` is `unclassified`, this array is the only thing that says what *kind* of event it was.

**`lifecycleFaults[]` exists because prose could not carry that inference.** Present on the
`(production)` entry only; each entry is `event` (`start` / `stop` / `update` / `other`), `severity`
and `count`. It is a fixed catalogue over the `Ens.Director` method names that
`%Dictionary.CompiledMethod` already confirmed — `ErrorCatalogue.Summary`'s shape exactly, so nothing
is derived from a log row and §6 is untouched.

Measured twice, on the question *"did the production have any trouble starting or stopping today"*:
the model called both tools, **counted the 10 error rows correctly**, and closed with "there were no
issues starting or stopping the production" at `confidence: 0.9`, then "the production started and
operated without additional issues indicated in the logs" at `confidence: 1`. Nine of those rows were
`Ens.Director.StartProduction` failures, sitting in the `sources[]` array. The missing piece was not
evidence but the **join** from a verified method name to "the production failed to start"; every code
was `unclassified` and an unrecognised code read as an absent fault. Prompt sentences were tried first
and held on one run of three. With `lifecycleFaults[]` in the payload the answer was correct on three
runs of three.

**The array is ALWAYS present on that entry**, so empty means *measured clean* rather than *not
checked* — the same reasoning §2.1 gives for never omitting a key.

**`distinctJobsAtLeast` and `distinctSessionsAtLeast` are lower bounds, and the names say so.** They
are a MAX across severity groups rather than a sum, because a job that logged both an error and an
info would otherwise be counted twice. `Job`, `SessionId` and `MessageId` themselves are **counted,
never returned** (§6) — a session id is dereferenceable against message content, so it points at PHI
without containing any.

**`retention` is published for the same reason §3.7 exists**: `Ens.Util.Log.Purge` is not scheduled
here, so the table holds everything back to first boot and a short window is never all the data there
is. It carries `rows`, `oldest`, `newest` and a `note` saying so.

```jsonc
// <- sinceMinutes 1440, abridged to three of the nine hosts
{
  "sinceMinutes": 1440, "since": "2026-08-25T15:10:11Z", "now": "2026-08-26T15:10:11Z",
  "rows": 5888,
  "bySeverity": [ { "severity": "error", "typeCode": 2, "count": 57 },
                  { "severity": "warning", "typeCode": 3, "count": 3 },
                  { "severity": "info", "typeCode": 4, "count": 5828 } ],
  "byHost": [
    { "host": "(production)", "rows": 91,
      "bySeverity": [ { "severity": "error", "typeCode": 2, "count": 10 },
                      { "severity": "warning", "typeCode": 3, "count": 3 },
                      { "severity": "info", "typeCode": 4, "count": 78 } ],
      "distinctJobsAtLeast": 12, "distinctSessionsAtLeast": 0,
      "oldest": "2026-08-26T12:27:45Z", "newest": "2026-08-26T14:00:53Z",
      "faults": [ { "errorCode": "unclassified", "count": 13,
                    "newest": "2026-08-26T13:39:22Z", "summary": null } ],
      "sources": [ { "class": "Ens.Director", "method": "StartProduction", "count": 9 },
                   { "class": "Ens.Director", "method": "moveEnsRuntimeToEnsSuspended", "count": 4 } ],
      "productionScope": true, "application": null,
      "lifecycleFaults": [ { "event": "start", "severity": "error", "count": 9 },
                           { "event": "stop", "severity": "error", "count": 1 },
                           { "event": "stop", "severity": "warning", "count": 3 } ] },
    { "host": "Cloud API", "rows": 5749,
      "bySeverity": [ { "severity": "error", "typeCode": 2, "count": 46 },
                      { "severity": "info", "typeCode": 4, "count": 5703 } ],
      "distinctJobsAtLeast": 11, "distinctSessionsAtLeast": 5691,
      "oldest": "2026-08-26T12:27:45Z", "newest": "2026-08-26T15:10:11Z",
      "faults": [ { "errorCode": "#6059", "count": 23, "newest": "2026-08-26T12:42:10Z",
                    "summary": "the configured downstream host or port could not be reached" },
                  { "errorCode": "<Ens>ErrFailureTimeout", "count": 23, "newest": "2026-08-26T12:42:21Z",
                    "summary": "the host retried and gave up within its failure timeout" } ],
      "sources": [ { "class": "ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation",
                     "method": "MessageHeaderHandler", "count": 46 } ],
      "productionScope": false, "application": true },
    { "host": "Ens.ScheduleHandler", "rows": 17,
      "bySeverity": [ { "severity": "info", "typeCode": 4, "count": 17 } ],
      "distinctJobsAtLeast": 4, "distinctSessionsAtLeast": 6,
      "oldest": "2026-08-26T12:27:45Z", "newest": "2026-08-26T13:39:22Z",
      "faults": [], "sources": [], "productionScope": false, "application": false }
  ],
  "classifiedThroughSeverity": "warning", "sanitised": true,
  "retention": { "rows": 10246, "oldest": "2026-08-24T11:52:27Z", "newest": "2026-08-26T15:10:11Z",
                 "note": "retention is purge-driven, not automatic -- Ens.Util.Log.Purge is not scheduled here" }
}
```

### 3.11 `get_event_log_trend` — read, added in MVP 3

**Runtime name `GetEventLogTrend`.** Log volume by severity, bucket by bucket, so "when did the errors
start" and "has it stopped" are answerable.

**Input**: `host` (optional — omit to trend every host together; `"(production)"` is a valid value),
`resolution` (optional, default `hours`), `buckets` (optional, default `24`, `1..720`).

**The resolution vocabulary is `minutes` / `hours` / `days` — NOT §3.8's `seconds` / `hours` /
`days`**, and the difference is structural rather than careless. The activity tables are pre-bucketed
at 10 s / 1 h / 1 d, so §3.8's vocabulary names tables. `Ens_Util.Log` is event-driven with no buckets
at all; buckets here are formed by taking a **prefix of the `TimeLogged` string**, and the finest
prefix boundary falling on a clean unit is the minute. Looked up in a fixed `$case`, never concatenated
— verified: `{"resolution":"Ens_Util.Log"}` returns
`{"error":"resolution must be 'minutes', 'hours' or 'days'","sanitised":true}`.

**`buckets` is a COUNT, where §3.10's `sinceMinutes` is a DURATION.** Two caps stated without that
distinction is how a model asks for 1440 buckets of days. Out of range is refused:
`{"error":"buckets must be an integer between 1 and 720","sanitised":true}`.

**Output**: `host`, `resolution`, `buckets[]`, `sanitised`, `from`, `to`, `total`.

`buckets[]`: `start`, `total`, and one count per severity — `assert`, `error`, `warning`, `info`,
`trace`, `alert`. **All six keys are always present**, so a severity that did not occur reads as `0`
rather than as absent.

**`from` and `to` are bucket STARTS, not window edges.** `to` is the start of the newest bucket, so the
window actually covered runs one bucket width past it. Stating that is necessary because `to` looks
like an end.

**Empty buckets are INCLUDED, and this is the tool's main reason for existing.** A run of zeros between
two populated buckets is the answer to "has it stopped"; omitting them would make a gap
indistinguishable from a shorter history.

**Zero is a MEASUREMENT here, and this family inverts §2.1's sign.** For a latency average, `0` is
impossible and `null` means unmeasurable. For a log count, `0` means the query ran and the window was
covered and nothing was logged — usually the answer the operator most wants. `null` stays reserved for
what could not be read.

**An unknown host is an error, not an empty trend**, because a run of zero buckets and a misspelled
name look identical otherwise:

```jsonc
{ "host": "No Such Host", "resolution": "hours", "buckets": [], "sanitised": true,
  "error": "no event log rows exist for that host under any window -- call GetEventLogSummary to see which hosts have logged" }
```

```jsonc
// <- host "(production)", hours, 6. The two empty leading buckets are the point.
{
  "host": "(production)", "resolution": "hours",
  "buckets": [
    { "start": "2026-08-26T10:00:00Z", "total": 0,  "assert": 0, "error": 0, "warning": 0, "info": 0,  "trace": 0, "alert": 0 },
    { "start": "2026-08-26T11:00:00Z", "total": 0,  "assert": 0, "error": 0, "warning": 0, "info": 0,  "trace": 0, "alert": 0 },
    { "start": "2026-08-26T12:00:00Z", "total": 30, "assert": 0, "error": 7, "warning": 2, "info": 21, "trace": 0, "alert": 0 },
    { "start": "2026-08-26T13:00:00Z", "total": 53, "assert": 0, "error": 3, "warning": 1, "info": 49, "trace": 0, "alert": 0 },
    { "start": "2026-08-26T14:00:00Z", "total": 8,  "assert": 0, "error": 0, "warning": 0, "info": 8,  "trace": 0, "alert": 0 },
    { "start": "2026-08-26T15:00:00Z", "total": 0,  "assert": 0, "error": 0, "warning": 0, "info": 0,  "trace": 0, "alert": 0 }
  ],
  "sanitised": true, "from": "2026-08-26T10:00:00Z", "to": "2026-08-26T15:00:00Z", "total": 91
}
```

#### What both event-log tools assume about the table, measured rather than documented

**Fifteen columns, and nine of them are refused outright** — the column-by-column boundary table lives
in `Tools.EventLog`'s class comment and §6 governs it. `StatusValue` is the one worth naming here: it
measures 376–384 characters on the error rows because a serialised `%Status` embeds the **formatted**
error message with every parameter substituted in. It is `Text` one hop away wearing a name that sounds
like a code, and it is never read — not even to classify.

**Every predicate is on an indexed column.** `%Dictionary.CompiledIndex` confirms indexes on
`ConfigName`, `SessionId` and `TimeLogged`, and `Type` is indexed too. Nothing here table-scans.

**`%EXACT()` on every text column read**, for §3.9's reason: the columns collate `SQLUPPER`, so a bare
`SELECT ConfigName` returns `CLOUD API` and §2's verbatim-name rule is broken by the query itself.

**Four host-roster copies became one.** `application` here and in §3.7–§3.9 is the same rule, shared
through `Tools.HostRoster` rather than duplicated — and that class asks the running
`Ens.Config.Production` rather than carrying a framework-name list, per root `CLAUDE.md` §6. Neither
`Tools.HostRoster` nor `Tools.ErrorCatalogue` extends `%AI.Tool`, which is what makes their methods
safe to make public: `%AI.ToolMgr.FindTools` filters on `$issubclassof(className, "%AI.Tool")`, so
nothing in either can become a callable tool. Verified by count — `ReportTools()` still reads
`12 (expected 12)` with both classes present.

### 3.12 `get_recent_config_changes` — read, added in MVP 3

**Runtime name `GetRecentConfigChanges`.** Which setting changed on which host, from what value to what
value, and when — read from `%SYS.Audit`. The one question no other tool in this catalogue can answer:
*did someone change something?*

**Input**: `host` (optional — omit for every host of this production), `sinceHours` (optional, default
`168`, `1..720`).

**Output**: `host`, `sinceHours`, `since`, `now`, `changes[]`, `suppressed`, `noOpSaves`, `truncated`,
`sanitised`, `auditEnabled`, `retention`.

`changes[]`: `host`, `setting`, `previousValue`, `newValue`, `changedAt`. Newest first.

**A row where `previousValue` equals `newValue` is not a change and is never listed** — it is counted in
`noOpSaves`. See "A save that moved nothing" below; this is the one shape of row the tool refuses on
content rather than on the allowlist.

#### The reporting rule is part of the contract, not a prompt detail

**A consumer of this tool MUST NOT recommend reverting a change it reports.** Whoever made the change
had a reason the instance cannot see, and the value they *intended* may be neither the old one nor the
new one — a typo in a new path is not repaired by restoring the old path. So `previousValue` is
**evidence, not a recommendation**, and it is returned precisely because "changed from a directory that
exists to one that does not" is a diagnosis while "`FilePath` changed" is not.

Stated here rather than only in the two system prompts because it constrains what a *caller* may do
with the output. `investigation-api.md`'s `manualRemediation.target` is the shape most likely to break
it: a recently-changed setting must not become a remediation step proposing the old value.

#### Two columns carry everything, and the names are the wrong way round

Measured on the live instance rather than assumed:

```
Description   item EMR Source of ProductionGuardian.LabDemo.Production
EventData     FilePath:/tmp/labdemo/hl7-in-missing/>>/tmp/labdemo/hl7-in/
```

`Description` is the **subject** and `EventData` is the **detail**. Both are `varbinary` in the SQL
projection, so **`EventData LIKE '%>>%'` returns SQLCODE -29** — a SQL-side content filter cannot be
written, and every predicate is on `Event` and `UTCTimeStamp` with the shape tests done in
ObjectScript over a `TOP 400` result set.

**Host attribution is anchored at both ends** — between the literal `item ` and the literal
` of <production class>` — because config item names contain spaces, so neither `$piece(d," ",2)` nor a
containment test recovers `EMR Source`. Anchoring on the production class is also what drops a row
describing a *different* production instead of reporting it as ours.

**Only 8 of this instance's 82 `ModifyConfiguration` rows are setting changes.** The rest are lifecycle
text (`Production class compiled`, `Item updated using Management Portal V2 interface`), which is why
the `>>` test is a filter rather than an assertion.

#### An empty list is not evidence that nothing changed, and the payload says so three ways

This is the tool's central caveat and the reason three fields exist that a naive version would omit:

- **`retention`** — `rows`, `oldest`, `newest` and a `note`, counted over `ModifyConfiguration` only.
  IRIS purges audit data on a schedule (measured: an `AuditChange` / "Delete audit data" pair ran
  2026-08-30 06:00 here), so the log's depth is a property of the instance.
- **`auditEnabled`** — `true`, `false`, or **`null` for "could not tell"**, which is why it is not a
  plain boolean. Read from `Security.System.Get()`; `Security.System.AuditEnabled()` does not exist on
  this instance.
- **`suppressed`** — a **count** of changes whose setting name is not allowlisted, never their names.
  Published so "nothing changed" and "something changed that I may not name" are distinguishable
  answers; conflating them is how an agent concludes a host was untouched.
- **`noOpSaves`** — a **count** of rows where `previousValue` equals `newValue`. A separate number from
  `suppressed` because it is a different fact: that one says "something changed and I may not name it",
  this one says "something was saved and nothing moved".

#### A save that moved nothing is not a change, and reporting one is worse than dropping it

`previousValue == newValue` rows are **counted, not listed**. They are produced by ordinary operation,
not by misuse: `FirstBoot.ApplyDeploymentSettings()` writes `HTTPServer` and `HTTPPort` through
`Triggers.SetSetting()` on **every boot**, and `Triggers.Reset()` restores settings that are often
already correct. Until #171, `SetSetting()` audited unconditionally, so a normal boot left two rows in
the window every investigation reads.

That is a false positive in the one direction this tool is most dangerous. §3.12's own framing tells a
consumer that "a setting changed shortly before a finding is the likeliest cause of it" — so an agent
handed `HTTPPort changed from 52773 to 52773` timestamped near a restart has been pointed at a
non-cause with the tool's full authority behind it. Observed in a `PoolBottleneck` investigation, which
presented both boot-time no-ops as `Setting Change` evidence on a production nobody had reconfigured.

Fixed at both ends: `Triggers.SetSetting()` no longer audits a save that moved nothing, and this tool
filters the shape anyway — for the rows already in the log, and for the Management Portal, which this
project does not control.

**Not every setting change is audited.** `Ens.Config.Production.%Save()` writes no audit row — only the
Management Portal's own save path does. Measured by arming `Triggers.MissingFolder()` and finding the
newest row three days stale. `Triggers.SetSetting()` therefore emits a byte-compatible row itself via
`$SYSTEM.Security.Audit()`, **after** the save succeeds; anything else in this codebase that mutates a
setting through `%Save()` is invisible here.

**A row is not readable the instant it is written.** IRIS buffers audit writes and a daemon flushes
them — measured: a trigger armed, this tool called from the next line of the same session reported
`changes: []` with `retention.newest` 101 seconds stale, and the identical call a minute later returned
the row stamped at the earlier time. So **a caller must not assert a change exists immediately after
making one.**

**This paragraph used to close by saying no consumer was affected in practice, on the reasoning that an
agent turn spends seconds per tool call. That was wrong, and it is the whole of #171.** The hazard was
identified here and then reasoned away, which is worse than not having noticed it: an investigation of
the `MissingFolder` scenario called the tool **16 seconds** after the `FilePath` edit, got `changes: []`,
and reported *"no recent configuration changes were found"* — a fabricated negative, on the very
scenario this tool was built for. Re-measured by arming the trigger and polling for the specific new
timestamp: the row became visible at **+36 s**, while a `HTTPPort` edit in the same session was visible
at **+24 s**. So the lag is tens of seconds and variable, and an agent turn is comfortably inside it.

**The consequence for consumers is a rule, not a caveat: an empty `changes` list must never be reported
as "nothing was changed".** `retention.newest` is what distinguishes the two cases and it is already in
every payload — if it is older than the condition being diagnosed, the log has not caught up and the
correct statement is that the audit log cannot answer yet. A consumer that reports absence without
checking `retention.newest` against the finding's own timestamp is reporting the buffer, not the
production.

#### The data boundary — `Username` is never read

`setting`, `previousValue` and `newValue` are allowlisted: `Tools.Read.#SETTINGALLOWLIST` (§3.4b, the
same list, shared as a `Parameter` rather than copied) plus `PoolSize` and `Enabled`, which are
`Ens.Config.Item` properties rather than `Settings` rows and are already published by §3.3 and §3.1.

**`Username`, `ClientIPAddress`, `OSUsername`, `CSPSessionID`, `Roles`, `Pid`, `JobId` and `UserInfo`
are not selected at all.** An operator's identity is neither a metric nor configuration, so it fails
§6 on its face — and the tool does not need it: "this was changed 40 minutes ago" carries the whole
diagnostic weight, while naming a person invites an agent to assign blame it cannot support.

```jsonc
// <- host omitted, sinceHours 24
{
  "host": null, "sinceHours": 24,
  "since": "2026-08-29T09:40:00Z", "now": "2026-08-30T09:40:00Z",
  "changes": [
    { "host": "EMR Source", "setting": "FilePath",
      "previousValue": "/tmp/labdemo/hl7-in/", "newValue": "/tmp/labdemo/hl7-in-missing/",
      "changedAt": "2026-08-30T09:02:14Z" },
    { "host": "Cloud API", "setting": "HTTPPort",
      "previousValue": "52773", "newValue": "52771",
      "changedAt": "2026-08-29T16:45:03Z" }
  ],
  "suppressed": 0, "noOpSaves": 2, "truncated": false, "sanitised": true, "auditEnabled": true,
  "retention": { "rows": 82, "oldest": "2026-08-11T07:22:41Z", "newest": "2026-08-30T09:02:14Z",
    "note": "IRIS purges audit data on a schedule, and a setting changed through code rather than the Management Portal may not be audited at all -- an empty result is not proof that nothing changed" }
}
```

A failed query sets `error` and leaves `changes` **null, not `[]`** — §2.1's rule applied to a list.

#### AI Detective calls this on EVERY investigation, and that is part of the contract

`REST.AgentDispatcher.BuildGoal()` names `GetRecentConfigChanges` in a `MUST`, alongside
`get_recent_errors` and `get_host_settings`. **Unconditionally, not for misconfiguration-shaped
findings only** — "misconfiguration-shaped" is a conclusion, and a model cannot use it to decide what
evidence to gather without the circularity that left the tool uncalled: registered, described in the
system prompt, and `toolCalls: 2` on the missing-folder scenario it exists for. Consumers should size
for one bounded call per investigation, not one per some subset.

**Reporting a change stays discretionary; looking does not.** The prohibition below is what governs the
report:

> A recent change is **evidence, never a recommendation.** An agent may state that a setting changed,
> when, and from what to what, and may say it is the likely cause. It must **not** recommend reverting
> it, must not put a revert in `manualRemediation.steps`, and must not call the previous value the
> correct one — the value the operator INTENDED may be neither the old one nor the new one, and a typo
> in a new path is not repaired by restoring the old path.

Verified live across three consecutive runs on the armed missing-folder scenario: `toolCalls: 3`, the
change cited in `rootCause` and as an `evidence` entry attributed to this tool, and no revert in any of
the nine remediation steps produced. This is a **prompt-enforced** rule with no structural guard, and
deliberately so — a guard would have to recognise "revert" in free prose, so it would pass a paraphrase
and fail an honest one.

### 3.13 `get_active_findings` — read, added in MVP 3, and it reads nothing in IRIS

**Runtime name `GetActiveFindings`.** What Production Guardian is reporting about this production right
now: every open finding with its host, type, severity, the value that triggered it and the baseline it
was compared against.

**Input**: `host` (optional — omit for the whole production).

**Output**: `host`, `supplied`, `count`, `findings[]`, `asOf`, `state`, `sanitised`, and `note` or
`reason` where they apply.

`findings[]`: the eight `healthscan.d.ts` `Finding` keys — `id`, `host`, `type`, `severity`,
`currentValue`, `baselineValue`, `detectedAt`, `message`. **Allowlisted and copied key by key**, so a
future engine field cannot reach the LLM by arriving in a payload; a key absent from a supplied finding
is republished as `null` rather than omitted.

#### Why it exists

The chat assistant could describe what the production *did* — throughput, latency, the event log — and
could not see what Production Guardian was *saying* about it. So "are there any issues right now?" was
answered from an activity table while a live `queue_buildup` on `Cloud API` went unmentioned with the
dashboard showing it in red two panels away.

#### The findings are SUPPLIED WITH THE REQUEST, not queried

Findings are computed by the detection engine on `:3002`, outside this instance. The engine sends them
in the body of its `POST /labdemo/chat/ask` (`findings`, `findingsAsOf`, `findingsState`);
`REST.ChatDispatcher` stashes them in a process-private global on entry and this tool republishes them.

Chosen over an IRIS→engine callback because the engine already holds the snapshot in the process making
the request, and a callback needs an engine URL inside the IRIS container — the class of configuration
`iris/CLAUDE.md` records going missing on three separate cold boots, failing as "no findings", which
reads as a healthy production.

Chosen over injecting the findings into the prompt text because a tool keeps `evidence[].tool`
attribution, keeps the §5.5 audit guarantee ("every tool call is audited, read and write"), and does
not tax every turn with tokens a throughput question does not want.

**Two consequences a consumer must know.** The findings describe the instant the question was asked,
not the instant the model speaks — `asOf` is the engine's poll clock and is never substituted with an
IRIS timestamp. And this tool is registered for the **chat** tool set only: AI Detective's caller
supplies no snapshot, because `/api/investigate` already hands that agent the one finding it must
explain, so registering it there would advertise a tool that can only answer `supplied: false`.

#### An empty list must never be read as a healthy production

Four distinct payloads mean four different things, and three of them carry no findings:

| Payload | Meaning |
|---|---|
| `supplied: false` + `reason` | no snapshot reached the request — an older client, or a hand-rolled POST. **Not** an error, and **not** an all-clear |
| `count: 0`, `state: "warming"` | the engine has no baseline, so its six comparative rules are structurally silent. **Nothing has been measured** |
| `count: 0`, `state: "stale"` | the last list the engine could compute; the proxy was unreachable at that poll. Old, not wrong |
| `count: 0`, `state: "ok"` | the only payload that supports "no open findings" |

`state` is forwarded from `EngineSnapshot.state` for exactly this reason. Without it, `count: 0` is
ambiguous between the four rows above, and the reassuring reading is available without the consumer
doing anything wrong — which is the same failure as `supplied: false` wearing the shape of a successful
answer. §2.1 governs: an unmeasurable value is not a small one, and here the "value" is a list.

```jsonc
// <- host "Cloud API"
{
  "host": "Cloud API", "supplied": true, "count": 1,
  "findings": [
    { "id": "cloud-api-queue-buildup", "host": "Cloud API", "type": "queue_buildup",
      "severity": "critical", "currentValue": 486, "baselineValue": 0,
      "detectedAt": "2026-08-30T09:38:12Z",
      "message": "Queue depth 486 is 32x baseline" }
  ],
  "asOf": "2026-08-30T09:39:50Z", "state": "ok", "sanitised": true
}
```

### 3.14 `get_interface_path` — read, added in MVP 3, and the only tool about RELATIONSHIPS

**Runtime name `GetInterfacePath`.** The production's interface map for one host: which hosts feed it,
which it feeds, and the routing rules and transformations on each path between them.

**Input**: `host` (optional — omit for every path in the production).

**Output**: `host`, `production`, `known`, `upstream[]`, `downstream[]`, `paths[]`, `pathCount`,
`pathsReturned`, `truncated`, `basis`, `note`.

`paths[]` entries carry `service`, `processes[]`, `operation`, `rules[]`, `transforms[]`, `hops[]` and
`position` (`service` | `process` | `operation` — where the requested host sits). `hops[]` is the same
path in flow order, service first, so a consumer reads neighbours off one sequence rather than
recomposing them from three columns.

#### Why it exists

**Every other read tool in this family is scoped to one host, and so is the snapshot
`investigation-api.md` §2.2 sends.** So AI Detective could describe the host it was asked about in
detail and had no way to know another host existed.

Measured on a live run: an upstream `MissingFolder` fault was fixed, 281 accumulated messages flushed
through at once, `Cloud API` queued 296, `queue_buildup` fired, and the Detective recommended raising
the pool to 8 — the maximum of its bounds — at 0.85 confidence, on a queue that drained to zero unaided
while it answered. Its own evidence read *"No errors recorded in the last 60 minutes"*, which was true
of `Cloud API` and false of the production: `EMR Source` had been erroring on every poll for twenty
minutes inside that same window.

A host-scoped tool cannot be *wrong* about another host. It can only be silent, and a model reads
silence as absence.

#### `upstream` and `downstream` are NEAREST FIRST

For `Cloud API` on the LABDEMO production that is `["Lab Router", "EMR Source"]` — the host that feeds
it, then the one that feeds that. Ordered because the consumer's question is "who handed me this work",
and an unordered set makes the immediate feeder indistinguishable from something three hops away. The
payload's own `note` states the order, since an array's order is not self-describing.

#### It resolves ROUTING RULES, which is the whole reason to use it

This tool computes nothing. It reads `Ens.InterfaceMaps.Utils` — the utility behind the Management
Portal's Interface Maps page — whose `EnumeratePaths` query returns one row per end-to-end path.

That matters because on this production the two links are declared in completely different places:

```
EMR Source -> Lab Router     a TargetConfigNames setting on the service
Lab Router -> Cloud API      a <send target="Cloud API"/> inside RoutingRule.cls
```

The second is **invisible to anything that reads settings.** The utility walks routing rules, DTLs and
BPL diagrams to find it. A topology hand-built from `TargetConfigNames` would have been missing exactly
the edge this tool exists for, and would have looked correct.

It is derived from the production **definition**, not from runtime state, which is what makes it usable
here at all: an investigation runs when a host is broken, and a dead host is still in the map.

**The SQL query is the surface, and the alternatives are internal.** `Ens.InterfaceMaps.Utils` also
exposes `FindAllPaths` — whose own dictionary description opens with "Internal method", and which hands
paths back byref as `$lb(Service,Processes,Rules,DTLs,Operations)` lists — and `FindSequentialPath`,
which takes a JSON spec whose shape is not documented anywhere reachable. The query returns the same
data already parsed into named columns and is what the portal's own list is built on, so it is the least
internal of the three. None of them is a published API; this is a dependency on an internal utility
either way, and that is the honest characterisation.

**No second source of truth.** Root `CLAUDE.md` §6 makes the `<Item>` set in `Production.cls`
authoritative; this reads IRIS's own derivation of it, so there is nothing here to go stale when the
production changes.

#### WIRING, NOT TRAFFIC — the available misreading

`upstream` means "is configured to feed this host". It is **not** a claim that the host is sending
anything, has sent anything recently, or is healthy. A consumer that conflates the two will report an
idle upstream host as a cause. Pair it with the activity, event-log and findings tools to find out
which of these hosts is actually in trouble.

#### `known: false` is not an all-clear

**The match is on the config item name, exactly.** Worth stating because `known` carries a
not-an-all-clear claim and the underlying query is a *term search*: `EnumeratePaths`'s first argument is
`pSearchTerm`, searched across services, operations, processes, **rules and transforms**. The
implementation passes it empty and filters rows by exact equality against the config item names on each
path, so a host name that happens to be a substring of a rule or DTL class name cannot produce
`known: true` (@Ari-Glikman, #185). "Appears in a path" means "is one of that path's hosts", not
"occurs somewhere in that path's text".

A host that appears in no path returns `known: false`, `paths: []`, and a `note` saying so explicitly.
That may mean it is wired to nothing, or that it is referenced only in a way the map cannot resolve.
**It is not evidence that the host is healthy or that nothing feeds it** — §2.1's rule, applied to a
map instead of a metric.

#### Truncation is reported, never silent

`#MAXPATHS` is 50. `pathsReturned` is what came back, `pathCount` is the true total, and `truncated`
says whether they differ. Stated because the opposite choice is an open defect elsewhere in this
contract (#165): a tool that capped silently and published a count of the *capped* list, leaving a
consumer unable to tell a small production from a clipped one.

#### Two things measured, and one that is not

**Cost: 33.7 ms** on this production. The utility walks rules and transforms, so that number describes
three hosts and one path and says nothing about a fifty-host production. A consumer on a large
production should expect this to be the slowest read in the family.

**The `Processes` separator for a chain of two or more processes is UNVERIFIED.** LABDEMO has exactly
one business process, so no path in it has two, and the utility's row-building source is not shipped.
The implementation splits defensively — any control character, or a comma-space — and getting it wrong
degrades to one unsplit name in `upstream`, not a wrong answer about who is upstream of whom. Stated
rather than implied, because a caveat that is discovered later reads as a defect.

**The data boundary is not at risk here** the way it is for `get_recent_errors` (§3.4). Every value is
a config item name, a rule class name or a DTL class name — configuration, per §6. Rule and transform
class names are included because "which transform runs between these two hosts" is diagnostic; their
contents are never read.

```jsonc
// <- host "Cloud API"
{
  "host": "Cloud API", "production": "ProductionGuardian.LabDemo.Production", "known": true,
  "upstream": ["Lab Router", "EMR Source"],
  "downstream": [],
  "paths": [
    { "service": "EMR Source", "processes": ["Lab Router"], "operation": "Cloud API",
      "rules": ["ProductionGuardian.LabDemo.RoutingRule"],
      "transforms": ["ProductionGuardian.LabDemo.Transform.HL7ToPID"],
      "hops": ["EMR Source", "Lab Router", "Cloud API"],
      "position": "operation" }
  ],
  "pathCount": 1, "pathsReturned": 1, "truncated": false,
  "basis": "Ens.InterfaceMaps.Utils",
  "note": "upstream and downstream are NEAREST FIRST: ... This describes how the production is WIRED, from its configuration, not what is flowing through it now ..."
}
```

## 4. Errors, and the three things that are not the same

A caller must be able to tell these apart, and only one of them is an error.

| Outcome | Shape | Meaning |
|---|---|---|
| **Could not measure** | a normal, successful result with `null` in the field | The tool ran. The value does not exist on this instance right now. Not an error. |
| **Call failed** | thrown `%Status`, surfaced as a tool error | The tool could not do its job: query failure, or an argument it cannot interpret at all. |
| **Refused** | a normal, successful result carrying `outcome: "refused"` and a `refusal` object | The tool ran, understood the request, and declined it: out-of-bounds size, non-whitelisted host, wrong production, host not in the production. **The safety model working, not a fault.** |
| **Not authorized** | `$$$AICoreToolAccessDenied` from the authorization policy | The tool **did not run at all**. |

**A REFUSAL IS NOT A FAILURE, and the `Refused` row above is new — added 2026-08-19 (#95).**

This table previously classified an "out-of-bounds argument" under *Call failed*, i.e. a thrown
`%Status`. `Tools.Resolve` has instead returned a structured `outcome: "refused"` payload since the
six tools landed, and after review (@kskubach) **the code is right and this classification was
wrong.** Two reasons, both load-bearing rather than stylistic:

1. **`resolve-api.md` §5 requires `outcome: "refused"` with `refusal.reason: "out_of_bounds"`.**
   From a thrown `%Status` the engine would have to parse error *text* to reach those fields.
   Text-parsing a refusal into a contract field is fragile in a way a structured return is not.
2. **It is what makes the audit trail useful.** `%LogExecution` receives the tool's *return value*;
   a throw records a status and no result payload. So a returned refusal is why `Audit.Entry.Result`
   can show *what* was refused and *why*, rather than only that something failed. A denial and a
   bounds refusal stay distinguishable through `Disposition`.

The warning below still stands for genuine failures, and the distinction is exactly the one §5.2 of
`resolve-api.md` draws: `refused` means the system decided not to act and nothing was written;
`failed` means it tried and did not complete. Returning `refused` for something that actually broke
is the defect this warning is about.

**Failure mechanism: `%AI.Tool` provides `%ToolError`, and that is what a tool uses.** Do not invent
an error envelope and do not return `{"error": ...}` from a successful `%Invoke`. Verified from the
compiled method body in the running container, `%AI.Tool.%ToolError(sc As %Status)` is exactly:

```objectscript
$$$ThrowStatus(sc)
```

So a tool reports failure by handing a `%Status` to `%ToolError`, which throws it; the runtime turns
that into the tool-error response and — because auditing wraps execution (§5.4) — records the
failure. A tool that catches its own errors and returns a cheerful payload defeats both.

**The distinction that costs the most if collapsed** is the first row against the third. Both leave
the agent without a number. But `queued: null` means *keep investigating with what you have*, while
a denial means *this avenue is closed to you*. An agent told "could not measure" when it was actually
refused will retry, narrate around the gap, and reason from an incomplete evidence set without
knowing it. So a denial must never be rendered as a null field, and an unmeasurable value must never
be rendered as a failure.

**A refusal carries a reason, and the reason is part of the interface.**
`%AI.Policy.Authorization.%CanExecute` returns a `%Status`, not a boolean (verified signature, §5.1),
so a denial can say *why*. That reason is surfaced to the caller because it is what lets Dev C render
a disabled Approve button with an explanation instead of a dead control. **Constraint on the reason
string:** it names the tool and the missing privilege and nothing else. No user names, no role
inventory, no host state, no message content. It crosses the same boundary as §6 and gets the same
treatment — a reason string is a string an external model may see.

---

## 5. RBAC, and why the columns are separate

### 5.1 The two policy hooks

`%AI.Policy.Authorization` and `%AI.Policy.Audit` are abstract base classes you subclass. Their exact
signatures, introspected from the running container:

```objectscript
%AI.Policy.Authorization
  %CanExecute(tool As %String, call As %DynamicObject, metadata As %DynamicObject) As %Status
  %CanList(tool As %String, metadata As %DynamicObject) As %Boolean

%AI.Policy.Audit
  %LogExecution(call As %DynamicObject, metadata As %DynamicObject,
                result As %DynamicObject, duration As %Integer,
                status As %Status) As %Status
```

Register ours with `%AI.ToolMgr.SetAuthPolicy(policy)` and `SetAuditPolicy(policy)`.

**`%CanList` and `%CanExecute` are separate gates.** "Can see that this tool exists" and "can run it"
are independently controlled. That separation is what makes the spec's demo expressible rather than
staged, and it is why §1 has two columns instead of one "RBAC role".

### 5.2 The gate is enforced by the runtime, not by the tools

Read from the implementation of `%AI.ToolMgr.ExecuteTool` in the running container — its own comment
describes what the native layer does:

```
// Call Rust ToolManager.execute() which:
// 1. Checks AuthorizationPolicy.can_execute()
// 2. Executes the tool via provider
// 3. Calls AuditPolicy.log_execution()
// 4. Returns result as %DynamicObject
```

Attributed deliberately: this is read from the shipped implementation, not inferred from the class
list. **"The classes exist" and "the classes are enforced" are different claims**, and only the
second one justifies the rest of this section.

Three consequences:

1. **A tool's `%Invoke` must not check permissions itself.** The check is centralised and runs for
   every tool. Per-tool checks are the pattern that eventually produces the one tool that forgot —
   and here they would be redundant on top of a check that already ran.
2. **The check happens before execution**, so a denied call cannot have partially executed. There is
   no half-applied pool change to reason about.
3. **Audit is automatic for reads too**, not only for the write. So this contract's claim that
   *every tool call, read and write, is recorded* is structurally true rather than aspirational.

### 5.3 The role table, and the listable-but-not-executable choice

| Resource | Held by role | Grants |
|---|---|---|
| `PG_Read` | `Guardian_Read` | listing and executing **every** read tool in §1; **listing** `set_pool_size` |
| `PG_Resolve` | `Guardian_Resolve` | **executing** `set_pool_size` |

**BOTH ROLES ALSO NEED A DATABASE PRIVILEGE — `%DB_%DEFAULT:RW` on this image.** Added 2026-08-19
(#95). The table above is correct and a role built from it alone *cannot be used*: a principal
holding only `PG_Read:U` logs in successfully and then dies with

```
<PROTECT> ... |ProductionGuardian.LabDemo.Tools.Governance.1    Access Denied
```

**before any policy is consulted**, because it cannot read the routine. Verified — the observed
denial in §5.6 only passes once the probe user also holds `%DB_%DEFAULT`.

`RW`, not `R`, and this is the non-obvious part: the denial audit row is written **as the refused
principal**, which is what makes it attributable rather than anonymous. A read-only grant produces a
denial that cannot be recorded, defeating the guarantee in §5.5.

Grant it **from the invocation path** — the web application, or the proof fixture — rather than
adding it to `Guardian_*`. The roles stay minimal and mean one thing: "may use the Production
Guardian tools". A role that also carried database access would make "holds `Guardian_Read`" an
answer to two different questions.

**And the limit of the least-privilege claim, stated rather than implied.** LABDEMO's database
resource is `%DB_%DEFAULT` (read from `SYS.Database` for its directory), which is the *default*
resource — so the grant is broad, and a principal permitted to run the tools can reach any database
sharing it. The least-privilege story MVP 2 §2.2 tells is real at the **tool** boundary:
`PG_Resolve` genuinely gates `set_pool_size`, with an observed denial to prove it. It is **not** a
database-isolation story. Worth one sentence because a demo showing "AI Detective can look but not
act" invites the stronger reading, and the stronger reading is false.

**This file is where the names are ratified.** `resolve-api.md` §9.3 defers to it, calling the
`Guardian_Resolve` in its own examples "illustrative and not ratified here" and instructing Dev C to
render `audit.role` as an opaque string and never compare it to a literal. That instruction stands
even now that the value is fixed: Dev C comparing against a literal is what would make a later rename
a dashboard change. The names here match `resolve-api.md`'s examples so nothing has to be rewritten.

**"Every read tool" rather than a number, deliberately.** This row read "the five read tools" from
Day 1 through three families being added, so it was wrong by eight before anyone noticed — the #84
stale-copy shape, in a table whose *other* column is load-bearing. `AuthPolicy` is generic: it requires
`PG_Read` for every tool and `PG_Resolve` additionally for `SetPoolSize`, so **a new read tool needs no
change here at all**, which is exactly why nothing forces the count to be maintained.

Resources are named `PG_*` and roles `Guardian_*` — **neither takes a `%` prefix.**

CORRECTED 2026-08-18, and the original reasoning was backwards. This paragraph used to argue that
roles carry `%` because it "is the IRIS convention for a system-supplied role", concluding that two
different naming rules were being applied correctly. The premise is true and the conclusion does not
follow: `%` marks a role as **system-supplied**, which is exactly why a *custom* role may not use it.
IRIS refuses outright:

```
ERROR #887: Invalid role name '%Guardian_Read'
```

So the ratified names were unimplementable, and this was found by trying to create them rather than
by review — the paragraph reads as a considered decision, which is what made it survive ratification.
The rule is one rule, not two: `%` is reserved for what InterSystems ships, for both resources and
roles. Custom names take no prefix.

Resources gated with `$SYSTEM.Security.Check("PG_Resolve","USE")` rather than a `$ROLES` string
match. That is the shape the shipped `%AI.Policy.ConsoleAuth` already uses — read from its
implementation, it denies with
`$$$ERROR($$$AICoreToolAccessDenied,"Tool '"_call.name_"' requires %System_Callout:USE")` after
checking `$SYSTEM.Security.Check("%System_Callout","USE")`. Following the runtime's own pattern beats
inventing one, and a resource check keeps working when roles are nested or renamed.

**`set_pool_size` is listable to `PG_Read` and executable only by `PG_Resolve`.** `%CanList` returns
true for it under both resources; `%CanExecute` requires `PG_Resolve`.

Why listable rather than hidden:

- **The demo is the denial.** The spec wants AI Detective shown looking without being able to act. A
  hidden tool produces an agent that recommends nothing and a UI with no control — indistinguishable
  from a feature that was not built. A visible, refused tool produces a disabled Approve button with
  a reason, which is the observable form of least privilege.
- **The agent should recommend the right action even when it cannot perform it.** AI Detective's job
  is `recommendedAction`. If `set_pool_size` is invisible, the agent cannot name the action it is
  supposed to recommend, and the WHY step degrades to prose.
- **Discovery is not an escalation.** The tool's name, its bounds and its one legal host are in this
  file, which is in the repo. Hiding the name protects nothing while costing the demo its point.

The cost, stated: an unprivileged caller can see that a write capability exists. That is accepted
here because the capability's *existence* is public by design and its *use* is gated and audited. If
a later module adds tools where the name itself is sensitive, `%CanList` is the right lever and this
decision does not generalise to them.

### 5.4 Two layers of authorization, and they fail differently

A reader will otherwise conflate these.

| Layer | Enforced by | Fails as | Granularity |
|---|---|---|---|
| **Transport / service** | `%AI.MCP.Service` — `%IsAuthorized()`, `AccessCheck(*pAuthorized)`, plus web-application authentication on the CSP app hosting it | an HTTP-level rejection before any tool is named | all-or-nothing for the whole MCP endpoint |
| **Per-tool** | `%CanExecute` inside `%AI.ToolMgr.ExecuteTool` | `$$$AICoreToolAccessDenied` with a reason | per tool, per call, per argument set |

The first says *you may not talk to this MCP service*. The second says *you may talk to it, and you
may read, and you may not write*. Only the second can produce the demo in §5.3, and only the first
protects the endpoint from an unauthenticated caller. Both are required; neither substitutes.

### 5.5 Audit

**Two mechanisms, not one — and the split is the runtime's, not a choice.** The runtime audits
*executions*; our authorization policy audits *denials*. Every call is recorded, but by different
code, and a reader who assumes one mechanism will look for denials in the wrong place.

| Event | Recorded by |
|---|---|
| successful read | the runtime, via `%LogExecution` |
| dry-run of the write tool | the runtime |
| **tool-level** refusal — our `2`–`8` bounds guard returning `outcome: "refused"` | the runtime (the tool ran) |
| unknown host | the runtime |
| **authorization** denial — `%CanExecute` refuses | **`Tools.AuthPolicy`, writing its own row** |

CORRECTED 2026-08-19 (#95, found by implementing it). This section previously read:

> `%LogExecution` receives `status` and `duration`, so **a failed or refused call is audited too**.

The premise is true and the conclusion does not follow. `%AI.ToolMgr.ExecuteTool` checks
authorization, *then* executes, *then* audits — so an authorization denial throws
`<%AICore>ToolAccessDenied` at the first step and the audit hook is never reached. Measured with a
deny-all policy registered: `%LogExecution` not called, **0 rows written**. The one event a security
review actually asks about was the one going unrecorded, and the wording made it invisible by
attributing it to the runtime.

The reasoning is still right and is why the gap was worth closing rather than documenting: "we log
attempts" is the correct goal, and `status`/`duration` in the signature genuinely is suggestive. It
is just not *sufficient*, because the denial path never reaches that signature. Same shape as the
`%`-prefix paragraph corrected in the 2026-08-18 role-name entry — a sound premise carried to a
conclusion it does not support, which is harder to doubt than a bare claim.

**So the guarantee is real but it is ours.** Anything that adds a new deny path must write its own
audit row, or that refusal leaves no trace. `Tools.AuthPolicy` is the only code that ever learns a
denial happened.

`duration` is integer milliseconds and reads **0** for every read tool here — `ExecuteTool` timed
the same call at `0.0071 s`. Stated because a reader comparing §5.5's promise of a duration against
a column of zeroes should find the explanation here rather than assume the field is broken.

Every one of the seven tools is audited on every call. Not a per-tool setting: it is where the audit
hook sits in the execution path (§5.2) — plus the policy's own row for the one case that path
cannot see.

The audit record must be sufficient to answer *who acted, what changed, when* — the demo's final
step. For `set_pool_size` that means the caller identity, the tool name, the arguments including
`previousSize` and `appliedSize` from the result, the duration, and the status.

**Audit records are subject to §6 as well.** `%LogExecution` receives the full `result` object, and
for `get_recent_errors` that result is already sanitised — which is a second reason the sanitisation
lives in the tool rather than in the caller.

### 5.6 Unverified — close these before promising them

Flagged rather than asserted, because this contract's credibility rests on the difference.

- **(a) What an audit record actually contains once written, and whether it is queryable.** The hook
  and its arguments are verified; the persisted shape is not. Anything in the demo that *shows* an
  audit entry depends on this. Owner: Dev B, before Day 3.
- **(b) Whether the default policy permits everything until ours is registered.**
  `%AI.Policy.ConsoleAuth` and `%AI.Policy.ConsoleAudit` exist alongside the abstract bases, so
  *some* policy is wired by default — and `ConsoleAuth` is an interactive terminal prompt with an
  `AlwaysAllow` property, which is not a policy for an unattended service. **Do not assume the
  default denies.** Registering our own `%AI.Policy.Authorization` subclass is mandatory, and the
  acceptance test is **an observed denial**, not a passing allow: call `set_pool_size` as a caller
  without `PG_Resolve` and see it refused. A policy never seen to deny is not known to be enforcing
  anything — the same argument `contracts/README.md` makes about the validator.

---

## 6. The data boundary

**Tool outputs may reach an external LLM.** The agent runs in IRIS, the model does not. Whatever a
tool returns can appear in a prompt.

**Metrics and configuration only. Never message content. Never PHI.** Root `CLAUDE.md` §2.1 states
this as a rule rather than a preference, and it is a rule about *tool return values* specifically,
because that is the only place in MVP 2 where instance data crosses the boundary by design.

Permitted, for every tool: host names, host types, statuses, queue depths, pool sizes, message
*counts*, error *counts*, rates, durations, timestamps, production names and states, IRIS error
codes, and class names.

Forbidden, for every tool: message bodies or any part of one, HL7 segments or fields, patient
identifiers of any kind, `Ens.MessageBody` contents, `Ens.MessageHeader` field values other than
counts, `Ens.Util.Log` text, credentials, and stack traces.

**Three tools are where this is a live risk** rather than a formality, and all three handle it the same
way — classify or allowlist, never pass the value through:

- **`get_recent_errors`** (§3.4, §3.4a): extracts only the IRIS error code and maps it to a catalogue
  string, with `unclassified` and no text for anything unrecognised. `Ens_Util.Log` on this instance
  holds 61,772 rows carrying a `PatientID` in plain text.
- **`compare_host_activity`** (§3.9): `Ens_Activity_Data.*.SiteDimension` is **derived from message
  body content** via `GetStatsDimension()` on the message body — an overridable hook, with a
  free-text per-host override available as well. So it is never returned raw; only a value this
  instance can independently verify as a loaded HL7 structure or a compiled class name survives, and
  everything else becomes `other` with no text.
- **`get_recent_config_changes`** (§3.12): `%SYS.Audit.EventData` is **free text written by whatever
  performed the change**, so an audit row is a *less* controlled source than a live item read. Only an
  allowlisted setting name has its values returned; anything else is counted and never named, and the
  eight actor-identifying columns are not selected at all.

**The second one is the more instructive**, because nothing about the column name says it carries
message-derived data. It was found by tracing `GetStatsUserDimension` through the platform rather
than by reading the schema, and the lesson generalises: **a column is safe because of what writes it,
not because of what it is called.** Any new tool over a table nobody has traced should be assumed to
have one of these until it is checked.

Two smaller edges, both worth naming because they are the ones that get missed:

- **Error and refusal reason strings cross the boundary too** (§4). They name a tool and a missing
  privilege, nothing else.
- **Counts are not content, but a count of one can be.** A count is permitted at every window size
  this contract allows. `sinceMinutes` is bounded at 60 and `limit` at 50 partly for that reason —
  the tool is an evidence source about a *condition*, not a message search interface.

- **One tool returns data this instance did not produce**, which is a direction this section did not
  previously have to cover. `get_active_findings` (§3.13) republishes a snapshot the *caller* supplied
  over HTTP. The boundary is held the same way — an allowlist of the eight `Finding` keys, copied key
  by key rather than filtered — so a field the detection engine adds later cannot reach the model by
  arriving in a payload. Every one of those eight is a metric or a classification, and `message` is
  composed by the engine from metric values.

If a future tool needs message content to do its job, that is not a sanitisation problem. It is a
tool that does not belong in this catalogue.

---

## 7. Implementation notes

Facts introspected from `pg-iris`, `IRIS for UNIX ... 2026.3.0AI (Build 126U)`. InterSystems AI Hub
is bundled in that image; **there is no separate AI Hub container.**

**A tool is a public method on a subclass of `%AI.Tool`.** `%AI.Tool` is abstract, extends
`%Library.RegisteredObject`, and provides instance methods `%Invoke`, `%Discover`, `%Encode`,
`%Decode`, `%ToolError` and class methods `%FromObject`, `%ToObject`, `%TypeMode`. Its own class
description: *"Base abstraction for a Tool Provider. Automatically exposes public methods as tools
via introspection."*

**Discovery generates the JSON Schema from the class at compile time**, via
`%AI.Tool.Generator.GenerateDiscover` / `GenerateInvoke`. Read from that implementation, the rules
an implementer must work with:

- **Excluded from discovery:** `Private`, `Internal`, `Abstract` methods, and any name starting with
  `%`. So a helper must be `[ Private ]` or it becomes a tool.
- **Only methods originating in the class itself** are discovered, unless `DISCOVERYLIMIT` is set
  explicitly. Inheriting a tool is opt-in.
- **The first line of the method's description becomes the tool `description`**; the remainder, if
  separated by a blank line, becomes `instructions`. This is prompt text the model reads — write it
  for the model, not for a maintainer.
- **A parameter with a default is optional; one without is required** (§2). This is the only place
  required/optional is expressed.
- **The return type generates the `returns` schema.** Returning `%DynamicObject` yields an untyped
  object, which is why the output tables above are contract prose rather than generated schema.
- `requires_auth` in the generated spec comes from the class parameter `REQUIRESAUTH`. Set it on
  `PG.Tools.Resolve`. `%AI.Policy.ConsoleAuth` is the shipped precedent for a policy reading it.

**Runtime registration** goes through `%AI.ToolMgr`:

| Method | Use |
|---|---|
| `FindTools(package, includeToolSets, &sc)` | class method; discovers tools in a package |
| `GetOrCreate(serviceName, *isNew)` | class method; the manager for a service |
| `AddTool(tool)` / `RegisterToolSet(className)` | register |
| `SetAuthPolicy(...)` / `SetAuditPolicy(...)` | **register ours — see §5.6(b)** |
| `ExecuteTool(toolName, arguments)` | the path that checks, executes, audits (§5.2) |
| `PurgeShared(serviceName)` | class method; clear shared registration |

Also present on this build: `%AI.ToolSet` and `%AI.ToolSet.Specification.*` (declarative XData tool
sets, including `MCP`, `MCP.Remote`, `MCP.Stdio`), `%AI.Tools.SQL` / `FileSystem` / `ShellTools`,
`%AI.Utils.ConfigStore` / `SettingStore` / `WalletStore`, `%AI.MCP.Service`, and the `%AI.Agent.*`
family. **`%AI.Tools.ShellTools` and `%AI.Tools.FileSystem` must not be registered on our tool
manager.** They are general-purpose and would hand the agent capabilities this catalogue exists to
withhold.

### 7.1 Compile order — a ToolSet compiled too early discovers nothing, silently

`%AI.ToolSet.Specification.Compiler` validates referenced classes at **compile time**. A ToolSet
compiled before the classes its `<Include>` targets exist discovers **zero tools, with no error**.

`docker/iris-firstboot.sh` currently loads with `$system.OBJ.LoadDir(..., "ck", ...)` in a single
pass. A ToolSet class added under `iris/labdemo/` would therefore come up empty depending on load
order, and the symptom is an agent that reports no tools — which reads as a policy or endpoint
problem, not a compile-order one. Whatever registers these tools must either compile the tool classes
in a prior pass or recompile the ToolSet afterwards, and the smoke check must assert the discovered
tool **count**, not merely that discovery returned successfully.

Same failure class as the `IRIS_BASE_PATH` case in `services/metrics-proxy/CLAUDE.md`: a wrong
configuration that answers `200` with plausible-looking emptiness.

---

## 8. What this is not

- **Not a general tool catalogue.** The write side is still one action on one host: `queue_buildup` on
  `Cloud API`, caused by `PoolSize 1`, fixed by raising it. A generalised action catalogue is later
  work (root `CLAUDE.md` §2.2). The three activity tools widen what can be **read**, not what can be
  **done**.
- **§3.7–§3.9 are not a message search interface.** They report counts and durations per time bucket,
  and the one column that could identify a message is classified rather than returned (§3.9, §6).
  There is no tool here that takes a message id, a session id or a patient identifier, and a tool
  needing message content to do its job does not belong in this catalogue.
- **Not a remote-execution surface.** There is one mutating operation, on one host, over one
  setting, within a four-value range. It is not a settings API, not a production editor, and not a
  path to `Ens.Director.StartProduction` / `StopProduction`.
- **Not an approval mechanism** (§3.6). Approval lives at `POST /api/resolve` and in the UI.
- **Not a message search interface** (§6). `get_recent_errors` counts and classifies; it does not
  retrieve.
- **Not multi-production.** Every tool is scoped to the single running
  `ProductionGuardian.LabDemo.Production` and refuses otherwise, following
  `Triggers.CheckProduction()` and #34.

---

## 9. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by every
other developer. See `README.md` in this directory.

Two developers remain since 2026-08-12, so in practice that is one other person — and GitHub will
not let an author approve their own PR, which is the point.

**Ownership.** The MVP 2 spec (§5.1, §5.2) assigns `mcp-tools.md` to **Dev A**, together with the
MCP tool definitions, the RBAC role, the credential vault entry and the audit configuration. Dev A
has moved off the project. **Dev B inherited `iris/**` and `services/metrics-proxy/**` and therefore
owns this contract**, on the same basis as the 2026-08-12 handover recorded in `CHANGELOG.md`. The
spec's table is left as written rather than mentally reassigned, because a contract whose stated
owner does not match its actual one is how a review gets skipped.

`README.md` in this directory does not yet list this file in its owner table. Adding it belongs to
the same PR as publishing this file.

**These changes are contract changes, not configuration:** the `2..8` bound on `size`, the
`Cloud API` whitelist, the `PG_Read` / `PG_Resolve` split, the listable-but-not-executable decision
in §5.3, the `get_recent_errors` allowlist and its catalogue policy, and any widening of what a tool
may return under §6. Each is written here specifically so that changing it requires review rather
than an edit to a settings file.
