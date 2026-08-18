# MCP tool catalogue

**Owner:** Dev B (inherited `iris/**` from Dev A) · **Consumer:** Dev B (agent orchestration), Dev C
(approval UI, indirectly) · **Runs in:** the `pg-iris` container · **Status:** published

Six tools. Five read, one write. They exist so the **AI Detective** agent can gather evidence about
one condition on one host, and so **Smart Resolve** can apply one bounded action to it. Root
`CLAUDE.md` §2.1 is the scope boundary; this file is the interface.

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
| `size` range | `2..8` | `1..8` | The tool must be able to express the reversal to `1`. §3.6 |
| role names | `%Guardian_Resolve`, "illustrative, not ratified" | **ratified here** | §5.3 is the naming authority; the values match its examples |

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
| `get_processing_time` | `PG.Tools.Read` | read | `PG_Read` | `PG_Read` | `iris_interop_avg_*`, aggregated as the proxy aggregates them |
| `set_pool_size` | `PG.Tools.Resolve` | **write** | `PG_Read` | **`PG_Resolve`** | `Ens.Config.Production` + `Ens.Director.UpdateProduction()` |

`PG_Read` and `PG_Resolve` are **IRIS resources**, held by roles `%Guardian_Read` and
`%Guardian_Resolve`. §5 explains the resource-not-role choice and why the write tool is
**listable to `PG_Read` but executable only by `PG_Resolve`**.

Two classes, not six, because discovery is per class: `%AI.Tool` exposes every public method of a
subclass as a tool (§7). Splitting read from write across two classes means the write tool can carry
class-level parameters — `REQUIRESAUTH`, its own `Policy` — that must not apply to the read tools.

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

**Units are seconds**, everywhere a duration appears, matching `healthscan-api.md` Q6. Confirmed
empirically rather than assumed: `Cloud API` configured at 0.05s latency reports `0.05`.

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

```json
// -> get_queue_depth
{ "host": "Cloud API" }
```

```json
// <- during the demo's queue_buildup
{
  "host": "Cloud API",
  "queued": 486,
  "measured": true,
  "productionState": "Running",
  "sampledAt": "2026-08-18T08:15:08.281Z"
}
```

```json
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
| `sinceMinutes` | integer | optional, default `15` | Window, 1..60. |
| `limit` | integer | optional, default `20` | Max events returned, 1..50. |

**Output**

| Field | Type | Notes |
|---|---|---|
| `host` | string | Echoed. |
| `windowMinutes` | integer | The window actually applied. |
| `count` | integer \| null | Events in the window. `null` when the log could not be read. |
| `errors` | array | At most `limit` entries, newest first. |
| `truncated` | boolean | `true` when `count > limit`. |
| `sanitised` | boolean | Always `true`. Present so its absence is conspicuous. |

Each entry:

| Field | Type | Notes |
|---|---|---|
| `occurredAt` | string | ISO 8601 UTC. |
| `errorCode` | string | The IRIS error token only — `<Ens>ErrFailureTimeout`, `#6059`, or `unclassified`. |
| `sourceClass` | string | Class name from the log row. A class name, never an instance value. |
| `summary` | string \| null | A **catalogue** string keyed by `errorCode`. `null` when unclassified. |

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
for not deciding case by case.** The tool cannot know which case it is in, so:

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

```json
// -> get_recent_errors
{ "host": "Cloud API", "sinceMinutes": 15, "limit": 20 }
```

```json
// <- what the agent, and therefore the external LLM, sees
{
  "host": "Cloud API",
  "windowMinutes": 15,
  "count": 42,
  "truncated": true,
  "sanitised": true,
  "errors": [
    {
      "occurredAt": "2026-08-18T07:46:29.533Z",
      "errorCode": "<Ens>ErrFailureTimeout",
      "sourceClass": "ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation",
      "summary": "The host did not complete a message within its FailureTimeout."
    },
    {
      "occurredAt": "2026-08-18T07:46:29.533Z",
      "errorCode": "#6059",
      "sourceClass": "ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation",
      "summary": "Could not open a TCP/IP socket to the configured target."
    }
  ]
}
```

Note what did **not** survive: the `127.0.0.1:59999` target, the timeout value, and every character
of the original text. `summary` is written by us, indexed by code. The two entries share a timestamp
because the raw rows do — that is a real property of `Ens.Util.Log`, not a formatting artefact.

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
| `size` | integer | **required** | `1..8` inclusive — see bounds below. |

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
3. **Bounds.** `host` must be `Cloud API`; `size` must be an integer in `1..8`. Anything else is an
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

**Why `1..8`, and why the tool's range is wider than the endpoint's.** This is deliberate and the
asymmetry is the point:

| Layer | Range | Why |
|---|---|---|
| `POST /api/resolve` (`resolve-api.md` §3) | `2..8` | An operator-facing action. `1` is the shipped value, so approving it is a no-op dressed as a fix. |
| `set_pool_size` (here) | `1..8` | Must be able to express the **reversal**. `previousSize` is `1`, so a tool that refuses `1` cannot undo its own first call. |

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

```json
// -> set_pool_size
{ "host": "Cloud API", "size": 4 }
```

```json
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

```json
// -> set_pool_size   (the `reversal` object from the response above, replayed)
{ "host": "Cloud API", "size": 1 }
```

```json
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

```json
// -> set_pool_size
{ "host": "Cloud API", "size": 4 }
```

```json
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

## 4. Errors, and the three things that are not the same

A caller must be able to tell these apart, and only one of them is an error.

| Outcome | Shape | Meaning |
|---|---|---|
| **Could not measure** | a normal, successful result with `null` in the field | The tool ran. The value does not exist on this instance right now. Not an error. |
| **Call failed** | thrown `%Status`, surfaced as a tool error | The tool could not do its job: item not found, wrong production, out-of-bounds argument, query failure. |
| **Not authorized** | `$$$AICoreToolAccessDenied` from the authorization policy | The tool **did not run at all**. |

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
| `PG_Read` | `%Guardian_Read` | listing and executing the five read tools; **listing** `set_pool_size` |
| `PG_Resolve` | `%Guardian_Resolve` | **executing** `set_pool_size` |

**This file is where the names are ratified.** `resolve-api.md` §9.3 defers to it, calling the
`%Guardian_Resolve` in its own examples "illustrative and not ratified here" and instructing Dev C to
render `audit.role` as an opaque string and never compare it to a literal. That instruction stands
even now that the value is fixed: Dev C comparing against a literal is what would make a later rename
a dashboard change. The names here match `resolve-api.md`'s examples so nothing has to be rewritten.

Resources are named `PG_*` while roles are named `%Guardian_*`, which looks inconsistent and is not:
the `%` prefix is the IRIS convention for a system-supplied role and is what `resolve-api.md`'s
examples already carry, while a **custom resource must not use `%`** — that prefix is reserved and
collides with the shipped `%Ens_*` / `%System_*` namespace. Two different naming rules, applied
correctly, rather than one applied uniformly and wrongly.

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

`%LogExecution` receives `status` and `duration`, so **a failed or refused call is audited too**.
That is the difference between "we log actions" and "we log attempts" — and the second is what makes
"the AI changed a production setting" reviewable, because the interesting security event is usually
the one that was blocked.

Every one of the six tools is audited on every call. Not a per-tool setting: it is where the audit
hook sits in the execution path (§5.2).

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

**`get_recent_errors` is the tool where this is a live risk** rather than a formality, and §3.4
specifies its handling in full: an allowlist that extracts only the IRIS error code and maps it to a
catalogue string, with `unclassified` and no text for anything unrecognised.

Two smaller edges, both worth naming because they are the ones that get missed:

- **Error and refusal reason strings cross the boundary too** (§4). They name a tool and a missing
  privilege, nothing else.
- **Counts are not content, but a count of one can be.** A count is permitted at every window size
  this contract allows. `sinceMinutes` is bounded at 60 and `limit` at 50 partly for that reason —
  the tool is an evidence source about a *condition*, not a message search interface.

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

- **Not a general tool catalogue.** Six tools for one scenario: `queue_buildup` on `Cloud API`,
  caused by `PoolSize 1`, fixed by raising it. A generalised action catalogue is later work
  (root `CLAUDE.md` §2.2).
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

**These changes are contract changes, not configuration:** the `1..8` bound on `size`, the
`Cloud API` whitelist, the `PG_Read` / `PG_Resolve` split, the listable-but-not-executable decision
in §5.3, the `get_recent_errors` allowlist and its catalogue policy, and any widening of what a tool
may return under §6. Each is written here specifically so that changing it requires review rather
than an edit to a settings file.
