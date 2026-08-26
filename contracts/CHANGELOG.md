# Contract changelog

Every contract change, dated, with the reason. Newest first.

---


## 2026-08-26 — `not_rising` is two fits, not one; documenting behaviour that shipped in #145

**`earlywarning-api.md` §2.1 (the `not_rising` row) and a new §2.2.1.** No schema change, no new
reason, no change to the precedence order — the seven reasons and their order are unchanged, and a
consumer sees exactly the same values it did before.

**This documents code already on `main`, which is the problem being fixed.** Step 6 has fitted the
series **twice** since `d48939e` — once over the 300 s window, once over its most recent 40% — and
declines unless both are positive. The contract still said *"Fitted slope is `<= 0` after rounding to
1 decimal"*, singular, which no longer described the implementation: a queue whose window slope is
positive but whose tail slope is not now reports `not_rising`, and nothing in the contract said so.

The behaviour is right and is what was asked for:

> the early warning sometimes comes up when the queue pool is being drained, because it takes a
> point in time measurement and does not notice the acceleration/deceleration of pool growth.

One gate covers three shapes a single fit reads as a rise — draining after the approved fix, levelled
off, turned over — while a queue rising *more slowly* than it was still projects. Five tests cover
it (`earlywarning.test.ts`).

**Why the contract fell behind.** `d48939e` was squash-merged as PR #145 under a title naming only
the `PollInterval` fix, because two agents' commits collapsed into one merge. So the change landed
with no contract amendment and no entry here, and was found only by reading the file. Recorded
because #84 is open about exactly this class of drift: the code was correct, tested, and invisible.

§2.2.1 also states two things a consumer cannot infer from the reason alone — the tail's slope is
never published (so a positive `slope` alongside `projection: null` cannot occur), and an unfittable
tail declines as `not_rising` rather than `insufficient_samples`, which is defined against the full
window's `fitSampleCount`.


## 2026-08-26 — clearing a finding takes the same bar as raising one (#149)

**`healthscan-api.md` §2.1 (a new paragraph under *Sustained breach*) and Q4.** No schema
change, no field added or removed, no sample change — this documents *when* a finding leaves,
which the contract described only for arriving.

**Q4 promised two things that the implementation could not both keep.** "ids are stable while
the condition persists" and "findings disappear when cleared" are only compatible if *cleared*
and *not breaching on this poll* are the same event. They are not. MVP §6's 2-consecutive-samples
rule was read as governing appearance alone, so a finding cost **two** samples to arrive and
**one** to leave, and a condition oscillating around a threshold produced a finding, dropped it,
and produced the same condition again under a **new `id`** — `f-1000`, gone, back as `f-1001`.
Reproduced against the shipped defaults (`sustainedSamples: 2`, `sustainedSeconds: 4`), not
theorised. To a viewer that is findings appearing and vanishing with no cause, which is how it
was reported.

Clearing now uses the same two gates, read from the same two knobs — no third tunable, because
"how many samples before I believe this changed" is one question asked in both directions.
`sustainedSamples: 1` / `sustainedSeconds: 0` still clears on the first non-breaching poll, so
the old behaviour remains reachable by configuration.

Two consumer-visible consequences, both stated in §2.1:

- a finding may persist **one extra poll** past the condition, showing its last breaching
  numbers (there is no newer verdict to refresh from)
- a finding **holds while its inputs are unmeasurable** — Q13's `null`. A rule that declines to
  evaluate has said "cannot tell", not "not breaching". Each rule now declares the inputs it
  cannot work without, so the engine can tell the two silences apart; `dead_host` declares none
  and clears exactly as before.

The same bar now governs a host vanishing from the proxy payload. That half was worse than a
flap: forgetting on the first absent poll discarded the **rolling baseline** along with the
findings, so a host that dropped out of one payload came back `warming` and every comparative
rule was silent for `minBaselineSamples` further polls. The finding did not flicker — it went
away and could not return, for a reason invisible from outside the process.

**Nothing changes for a consumer that renders whatever the endpoint returns.** What changes is
that an `id` is now stable for the lifetime of the condition, as Q4 always said it was.


## 2026-08-26 — `type` gains a second source; Q6's "treat unknown as a real value" amended (#127)

**`proxy-api.md` §1.1, §1.3, §5.1 (Q6) and a new §5.1.1; `proxy.schema.json`
`ProxyHost.type` description, new optional `ProxyHost.typeFromConfig`, three new
`HostStatusMeta` fields.** No sample change — `validate.mjs` stays green, and the three hosts in
`samples/hosts-response.json` are all typed already, so nothing there was affected. **No field
removed, no enum narrowed, no required field added.**

**Q6 said the wrong thing, and it is worth being precise about which part.** Its diagnosis was
correct: `hosttype` rides only on the `avg_*` metric families, so a host nothing has flowed through
carries no type in the Prometheus text. Its conclusion — *"Treat `unknown` as a real value, not a
bug"* — did not follow. `unknown` was a true statement about the **metrics text**, and Q6 promoted
it to a fact about the **host**. The production knows its own item types whether or not anything has
flowed through them, and the proxy was already reading the place that holds them:
`Ens.Util.Statistics:EnumerateHostStatus` returns a `Type` column, the host-status endpoint of §1.3
has run that query since #12, and it **discarded that column**.

So this is not new plumbing. It is one column that was already in the result set.

| Change | Where |
|---|---|
| `hostType` published, **raw IRIS word unchanged** (`BusinessService`/`BusinessOperation`/`BusinessProcess`/`Actor`) | `iris/labdemo/REST/HostStatusDispatcher.cls` |
| normalized to `service`/`operation`/`process` and folded into `type` | `services/metrics-proxy/src/hoststatus.js` |
| the raw words added to the **one existing** mapping, not a second one | `services/metrics-proxy/src/parser.js` `_hostType()` |

**Fill only, never overwrite.** The metrics `hosttype` label stays authoritative wherever it exists;
the config type lands only where `type` is still `unknown`. That is a structural guarantee rather
than a tested behaviour: the only hosts the second source can touch are the ones that already read
`unknown`, so the worst case is that it does nothing. Zero regression is therefore not a claim about
coverage.

Where both sources type a host and disagree, the metrics value stays in `type` and the config value
is recorded — `typeFromConfig` on the host, `typeDisagreements` in `_meta.hostStatus`. That is
deliberately the same shape as `statusFromMetrics` (2026-08-12) rather than a new convention: the
loser of a source disagreement is kept visible instead of being silently resolved. It is empty on
every live sample so far, which is the expected state; non-empty means one of the two sources is
reading a stale or misattributed host.

Measured live on the running stack, `ProductionGuardian.LabDemo.Production`, 12 hosts:

```
before:  8 of 12 unknown
after:   1 of 12 unknown   (Ens.Alarm)
typesFilled: 7   typeDisagreements: []   untypedHosts: ["Ens.Alarm"]
```

**`Ens.Alarm` is left `unknown` on purpose.** `EnumerateHostStatus` does not enumerate it, so
neither source has a type for it and nothing available would supply one without guessing from the
host name — which `parser.test.js`'s *'leaves type unknown rather than guessing it from the host
name'* forbids, and which still passes unchanged. Reading the production's own configuration is not
guessing; inferring "`Lab Router` is a process" from the string `Router` is. Hosts in that position
are now **named** in `_meta.hostStatus.untypedHosts` rather than left for a consumer to find by
scanning.

Note `untypedHosts` **includes framework hosts**, unlike `undescribedHosts` (2026-08-12), which
excludes them. Not an inconsistency: `undescribedHosts` is about a host losing its numbers, and the
endpoint legitimately omits some framework hosts, so counting them there would make a healthy state
look broken. `untypedHosts` is about type coverage, and the one host in it live *is* framework — so
excluding them would make the list always empty and useless.

**Nothing changes for a consumer that already handled `unknown`,** and the `type` enum is unchanged.
What changes is that `unknown` no longer implies "framework host": every framework host except
`Ens.Alarm` is now typed.


## 2026-08-23 — three activity-history read tools, for the chat assistant (Dev B)

**`mcp-tools.md` §1, §3.7–§3.9, §6, §8.** Additive: three new read tools in a new class,
`PG.Tools.Activity`. No existing tool changed, no schema change, no sample change — `validate.mjs`
stays at 3 samples / 26 reject.

- `get_activity_coverage` — which hosts have recorded activity, over what period, at which resolutions
- `get_activity_trend` — one host's throughput and latency, bucket by bucket
- `compare_host_activity` — every host ranked over one window

All three read `Ens_Activity_Data.{Seconds,Hours,Days}`. **The expected tool count moves 7 → 10**, and
`Setup.AIHub.ReportTools()` was updated with the discovered names read back rather than the number
bumped — that guard exists so an accidentally-public helper is caught at boot.

### The data-boundary finding, which is the reason this entry is long

**`SiteDimension` is derived from message body content, and nothing about the column name says so.**
Traced through the platform rather than read off the schema:
`Ens.Util.Statistics.GetStatsUserDimension` opens the in-flight `Ens.MessageHeader`, opens its body,
and calls **`GetStatsDimension()` on the message body object**. `EnsLib.HL7.Message` returns `..Name`;
where a body declines, the fallback is the body **class name**. `GetStatsDimension` is an
**overridable hook**, and `SetStatsUserDimension` lets an operator put free text there per host
without touching a class.

That is structurally the same situation as `Ens_Util.Log.Text` in §3.4 — safe on today's instance
because of how the writing code happens to be used, unsafe the moment a hook is overridden — so it
gets the same answer: **classify against an allowlist, never pass the value through.** A value is
published only when this instance can independently verify it names a loaded HL7 message structure or
a compiled class; anything else is `other` with no text. Not a regex, because "looks like a class
name" passes `Patient.Smith.John`.

**Demonstrated rather than asserted.** A PHI-shaped dimension (`SMITH^JOHN^A^MRN12345678`) was written
into the activity table for a real host, and the tool's reply contained neither `SMITH` nor
`MRN12345678` — only `{"kind":"other","verifiedAs":"unverified"}`. The test row was deleted afterwards.

**The generalisable lesson, recorded in §6:** a column is safe because of what writes it, not because
of what it is called. Any new tool over a table nobody has traced should be assumed to have one of
these until checked.

### `GovernAgent` gained a tool-set selector, and it is a CORRECTNESS guard

`GovernAgent(agent, includeWrite, toolSets)` now takes `"all"` (default), `"activity"` or
`"current"`. Both read families are `PG_Read` and neither mutates anything, so this is not a
privilege boundary — it fixes a wrong answer.

§3.5 and §3.9 answer questions that *sound* identical. On "which host has the highest average
queueing time", measured through the dashboard's own path:

```
get_processing_time("Cloud API")   ->  avgQueueingTime  0.12   <- true, and instantaneous
compare_host_activity("hours", 6)  ->  avgQueueingTime 77.66   <- true, and the answer
```

The model reached for the first. The answer was wrong by three orders of magnitude and carried
`confidence: 1` beside two evidence bullets reading `NOT MEASURED` — confidently wrong *and*
self-contradicting. **Prompt wording was tried first and failed**; the prompt already named each tool
and its purpose. So the chat assistant is registered with `"activity"` and cannot reach the
current-state tools, verified by execution (`ToolNotFound`) rather than by reading the registration —
`FindTools()` is namespace-wide discovery and lists tools that are not registered, so it proves
nothing. AI Detective keeps `"all"`, because it explains one finding and needs the live status beside
the history. An unrecognised value is an **error**, not a default: falling back to `"all"` on a typo
would silently widen what an agent can reach.

### Not in this entry

No `.d.ts` and no JSON Schema, consistent with the rest of this file: these tools' schemas are
*generated* from the ObjectScript at compile time by `%AI.Tool.Generator`, so a hand-written schema
would be a second source of truth that drifts (§7). The engine's `/api/chat` endpoint and its
response shape are **not** in `contracts/` at all yet, matching how `investigation-api.md` and
`resolve-api.md` began — flagged here rather than left implicit.

---

## 2026-08-23 — `get_recent_errors` reports HOW RECENT, not only how many (Dev B)

**`mcp-tools.md` §3.4 only.** Two additive nullable fields, no schema change, no sample change —
`validate.mjs` stays at 3 samples / 26 reject.

- `byCode[].secondsAgo` — age of that code's newest occurrence, in whole seconds
- `newestSecondsAgo` — age of the newest error of any code, on the reply itself

### Why a count inside a window was not enough

A count cannot distinguish *happening* from *happened*, and that distinction decides the diagnosis.
A queue building behind one worker was diagnosed as a **connectivity failure** from 22-minute-old
`#6059` rows still inside the 60-minute window — the host had stopped erroring entirely. Measured,
same host, same second:

```
sinceMinutes 15  ->  count 0,   byCode []
sinceMinutes 60  ->  count 134, newest #6059 1315s ago
```

Both true, and neither answers the question. **The window cannot settle it in either direction:**
narrow it and MVP 3's missing-folder scenario disappears, because that host logs `#5021` once on
entering `Error` and then goes quiet. So the window stays wide enough to see a one-shot fault and the
conclusion keys on age.

### A timestamp is not content

`secondsAgo` is a duration derived from a row's own clock field — nothing typed by a person, nothing
derived from a message, so it is on the metrics side of root `CLAUDE.md` §2.1. The message **text**
remains unreturnable for §3.4a's reasons, unchanged. Emitting an absolute timestamp instead was
rejected: an elapsed count answers the only question asked of it and cannot be correlated against
anything outside the instance.

`null` means **unmeasurable, not recent** — §2.1's nullability rule in the time dimension, and the
third shape of a defect this project has now hit four times (#33, #49, #58 were the value dimension).

### What this does NOT do

It does not change the window, the codes, the catalogue, or what may be returned. Two consumers of
the new fields — the recency rules in `AgentDispatcher` — live outside `contracts/` and are described
in that class rather than here, because *how* a diagnosis reads the evidence is not a contract term.

---


## 2026-08-23 — `get_host_settings`, and an optional argument does not default (Dev B)

**`mcp-tools.md` only.** No schema change, no sample change — `validate.mjs` stays at 3 samples /
26 reject. Two edits, one additive and one a correction to a statement that was wrong in a way that
cost a live investigation.

### 1. §3.4b — `get_host_settings` added

MVP 3's scenario needs the agent to **name** the directory a service cannot read. That value lives
in exactly two places: the `#5021` log message, and the host's configuration. `get_recent_errors`
will never return log text — `Ens_Util.Log` on this instance holds 61,772 rows carrying `PatientID`
in plain text — so without this tool the agent can learn *a path is missing* and never *which path*.

Configuration is what the boundary permits: root `CLAUDE.md` §2.1 is "metrics and configuration only,
never message content." A setting **value** is configuration by definition — typed by whoever
deployed the production, not derived from a message.

**An allowlist of nine setting names, not the whole collection.** Returning everything would be one
`Credentials` row away from handing an external LLM the name of a credential set, and one future
setting away from something worse, since productions are configured by people and people put
surprising things in free-text settings. `Credentials` is deliberately absent even though it is only
an identifier: an agent has no diagnostic use for it that outweighs saying its name out loud. Adding
a name to the allowlist is a contract change, on purpose — the same reasoning as `set_pool_size`'s
single whitelisted host and the `#5021` catalogue.

`settingsOnItem` reports the unfiltered count, so "this host has three settings" is distinguishable
from "the allowlist filtered most of them out". Without it, a host configured entirely through
refused settings looks identical to one with no configuration at all.

Expected tool count moves **6 → 7**; `Setup.AIHub.Run()` prints it at boot.

### 2. §2 — an optional parameter arrives as `""`, not as its default

The paragraph above it said required-vs-optional is expressed in the ObjectScript signature, which is
true of the **generated schema** and does not describe what the tool body receives.
`%AI.ToolMgr.ExecuteTool` passes `""` for a key the model omitted rather than omitting the argument,
so `sinceMinutes As %Integer = 15` never defaults on the tool path. Measured, same host, same second:

```
{"host":"EMR Source"}                      -> {"error": "sinceMinutes must be between 1 and 60"}
{"host":"EMR Source","sinceMinutes":15}    -> 3 errors, #5021 and <Ens>ErrProductionSettingInvalid
```

A tool declaring an optional parameter and range-checking it therefore **refused every call that
omitted it**. Live since #106.

**Why it survived that long, and why the fix is in the contract.** The only caller that omits an
optional parameter is the model. Every hand-written probe, test and demo script passed it explicitly,
so nothing we ran could see it. And the failure was not an error: blinded to the error codes, the
agent reasoned from the one value it could still read — `PoolSize 1` — and recommended enlarging the
pool of a host whose configured directory did not exist. **A tool that refuses is
indistinguishable, in the narrative, from a tool that found nothing.** That is §2.1's
unmeasurable-is-not-zero rule arriving through the argument list rather than the return value, which
is why it belongs next to the schema rule it corrects rather than in a code comment.

The contract now requires the body to restate the default (`if x = "" { set x = default }`) while
still refusing a value the model sent and got wrong, and asks that samples carry the
omitted-argument call rather than only the explicit one.

---


## 2026-08-20 — MVP 3's two contract changes, and the first MVP 2 schema (Dev B)

**Two documents changed, one schema and one captured sample added.** `validate.mjs` goes from
2 samples / 19 reject to **3 samples / 26 reject**. Reviewed by Dev A before merge, per §4.

### 1. `investigation-api.md` §3.3a — `manualRemediation`

MVP 3's scenario is a finding with **no governed action**: a service polls a directory that does not
exist, and the fix is an operator changing a setting. §3.1 already allows `recommendedAction: null`,
so the *absence* of a fix was expressible; a recommendation **in words** was not, and §3.3 is right
that `recommendedAction` must stay a structured object.

So this is an additive nullable sibling, and the reason it is a separate field rather than a flag is
worth stating plainly: the two carry different **authority**.

- `recommendedAction` — *there is a fix and the system may apply it, with approval*
- `manualRemediation` — *there is a fix and the system may not apply it at all*

Two shapes make the wrong UI **unrepresentable**: there is no `action` object to send, so a consumer
cannot render an approve control for it. One shape with an `applyable: false` flag makes the wrong UI
a forgotten `if`, and the thing being designed out is an approve button next to a recommendation the
system cannot carry out — which a human would click.

`appliedBy` is enumerated with `operator` as its only member, so autonomous remediation becomes a
contract change rather than a code change.

### 2. `mcp-tools.md` §3.4 — `get_recent_errors` reconciled with the implementation

This table specified a response the tool has never emitted, and the shapes differed **in kind**:

| | contract, before | `Tools/Read.cls` |
|---|---|---|
| window echo | `windowMinutes` | `sinceMinutes` |
| array | `errors[]` of `{occurredAt, errorCode, sourceClass, summary}` | `byCode[]` of `{errorCode, count}` |
| `truncated`, `limit` | specified | absent |

**The implementation's shape is kept and the contract corrected to it, except `summary`.** Aggregation
is what the one consumer needs — *what kind of thing is going wrong and how often* — and per-event
rows invite an agent to reason about individual occurrences, which is exactly the reasoning the data
boundary cannot support: the row it would want to quote is the one that may carry PHI. `limit` and
`truncated` bounded a list that no longer exists.

`summary` is added rather than dropped, because MVP 3 needs it, and §3.4a gives it a **catalogue**
keyed by `errorCode` — `#5021` → *"a configured directory or file path does not exist"*. A fixed
string cannot carry payload content by construction, which is why it is safe to send.

§3.4a also refuses the shortcut it invites: **the allowlist must not gain an exception for `#5021`**
so the agent can read the missing path out of the message. An allowlist with one exception is one an
implementer widens, and "the path is usually harmless" is the rare-rather-than-absent pattern that
survives review and then leaks. The path comes from configuration; the catalogue supplies the kind.

`occurredAt` and `sourceClass` are dropped, not deferred — neither is emitted, neither is needed, and
`occurredAt` on an aggregate is meaningless. A field specified and unimplemented for a month is a
claim the document should stop making.

### 3. `investigation.schema.json` — the first machine-readable MVP 2 contract

The 2026-08-20 entry above recorded that all four MVP 2 contracts were prose-only and that five
field-level divergences had reached `main` in shapes nothing validated. This closes that for the one
document MVP 3 edits.

`samples/investigation-response.json` is **captured from a live run** — `source: "agent"`,
`gpt-4o-mini`, 5 tool calls, five `mcp_tool` evidence bullets — with only the ids and timestamp
pinned so the fixture does not move. Same rule as the MVP 1 samples: a hand-written sample proves the
schema accepts what its author imagined; a captured one proves it accepts what the system emits.

**Seven negative cases, each a real defect or a safety property**, because a schema that accepts
everything would pass the positive case too:

```
rejects: manualRemediation carrying an action object -- a UI could render Approve for it
rejects: appliedBy 'system' -- autonomous remediation, which root CLAUDE.md §2.1 forbids
rejects: target carrying a message-content key -- the data boundary in schema form
rejects: steps: [] -- a manual remediation with no steps says nothing
rejects: evidence source 'tool' instead of 'mcp_tool' -- the enum that keeps provenance honest
rejects: action with a fourth key -- resolve-api.md §1.1 refuses unknown keys inside action
rejects: action.type 'restart_host' -- one action type, enumerated so a second is a decision
```

The first three are the ones that could not be caught by a TypeScript type: they are **values and
extra keys**, not shapes. That is the lesson from `capturedFrom: "live production"` (#111), which
sat in a correctly-typed string field and survived four readings of the line.

### Deliberately not done

`earlywarning-api.md` and `resolve-api.md` get no schema here. **MVP 3 does not touch them**, and
retrofitting two documents nothing is about to edit would be scope this change does not need. They
remain prose-only and that remains a known gap — recorded in the 2026-08-20 entry above rather than
silently carried.

`earlywarning-api.md` also still reads `Status: proposed` while its endpoint is shipped and consumed
by the merged dashboard. Left alone for the same reason, and flagged so it is a decision.


## 2026-08-20 — `reversal` is a record, not a request; the `1..8` asymmetry withdrawn (Dev A)

Closes #100. **Two files, no field added and none removed that anything emitted.** `resolve-api.md`
§4 and the field table; `mcp-tools.md` §3.6 and three bound references. `validate.mjs` unchanged and
passing — neither contract has a sample for it to check, which is the gap the entry above records.

### The contradiction

§4 told the caller *"Dev C can POST it back verbatim to undo"*, with `reversal.action.size` set to the
shipped pool size — `1`. §3 bounds `action.size` at `2..8`, and §5 lists exactly that as
`out_of_bounds`.

**So the endpoint handed the caller an undo request and then refused it.** That is internal to one
document and needed no implementation to be wrong.

### The resolution: reversal is documentation

`1` stays unapprovable, because §3.6's reason is sound — it is the shipped value, so approving it is a
no-op dressed as a fix that reports success and changes nothing. Widening the bound to make the undo
POSTable would trade a real safety property for a convenience.

Restoring the pool is an operator action through `Triggers.Reset()`, which is deliberately not
LLM-callable. **"Reversible" now means the prior value is measured, recorded and restorable** — which
is true, provable, and what the demo does. A second write path would need its own spec under root
`CLAUDE.md` §2.

### The contract was the outlier, not the code

Worth recording because it is the reverse of the usual direction and is why this survived a week.
`reversal` was specified as `{action: {...}, capturedFrom, automatic}`; `Tools.Resolve`, the engine and
the mock all shipped flat `{host, size, capturedFrom}` and **nothing ever emitted `automatic`**. Four
components agreed with each other and disagreed with the document.

The shape is now flat, matching them. `action` existed to make a body dispatchable and this body is not
dispatched. **No consumer loses a field it read or emitted.**

### And `set_pool_size` was never `1..8`

§3.6 ratified `1..8` for the tool against `2..8` for the endpoint, arguing "a tool that refuses `1`
cannot undo its own first call". The premise was true and the conclusion did not follow — **the third
time that shape has cost us something here**, after the `%`-prefix paragraph and §5.5's audit claim.

`Tools.Resolve` has shipped `MINSIZE = 2` since the tools landed, and its own comment rejects the
reversal argument by name: *"Reversal to `1` is `Reset()`'s job, through a path that is not
LLM-callable."* So the ratified range never described the implementation, and the undo path the wider
bound existed to serve did not work at either layer. Both are `2..8`.

Also corrected: `capturedFrom` was `"live production"` in `Tools.Resolve` against `"live"` in the
contract (#111) — a *value* drift in a correctly-shaped field, and the one that argues hardest for
schemas, since only an `enum` catches it.

### Not in this entry

Both documents' headers still say Dev A has left and name Dev C as a consumer. That is the same stale
premise root `CLAUDE.md` §3 carried until #113, and it is a separate change — kept out so this entry
describes one decision.


## 2026-08-20 — MVP 2 shipped; the four contracts carry no machine-readable artefact (Dev B)

**No contract text changed in this entry.** It records a gap that should be visible before anyone
starts MVP 3, because the honest answer to "are the MVP 2 contracts done" is *the prose is, the
enforcement is not*.

All four MVP 2 contracts are implemented and verified end to end from an empty volume. Three say
`Status: published`; `earlywarning-api.md` still says `proposed`. **None of the four has a
`.schema.json`, a `.d.ts`, or a captured sample**, and each says so in its own text — so
`validate.mjs` does not know these endpoints exist, and its counts (15 accept / 19 reject / 7
capture claims) are entirely MVP 1.

### What that costs, measured rather than asserted

Two drifts got through in a week, both in shapes no schema covered:

1. **`refusal` field names.** `Tools.Resolve`, the engine's type and the mock all emitted
   `{code, detail}` against a contract specifying `{reason, message, checkedBy}` (#99). It
   type-checked because the parser *cast* rather than read; §5 tells consumers to render
   `refusal.message` verbatim, so the UI would have shown `undefined`.
2. **`reversal` shape.** The contract specifies `{action: {...}, capturedFrom, automatic}`; every
   component ships flat `{host, size, capturedFrom}` and nothing emits `automatic` (#100). The
   implementation is self-consistent and the *contract* is the outlier — the reverse of the usual
   direction, and only findable by reading both.

`healthscan-api.md` has had a schema and a drift test since Day 1 and has produced neither class of
defect. That is the argument, and it is the reason this entry exists rather than a note in a PR.

### The stopgap that exists

`services/detection-engine/test/mvp2-contract-drift.test.ts` greps the contract *prose* for field
names. It caught nothing retroactively — it was written after both drifts — and its own header says
it should be **replaced** by schema validation rather than extended. A prose grep is weaker than a
schema and the risk is that a weak check gets trusted like a strong one.

### Before MVP 3 builds on these

Whoever specs MVP 3 should decide, explicitly, whether the four MVP 2 contracts get schemas and
captured samples first. Two reasons to do it before rather than after:

- MVP 3's modules (Health Score, Health Summary, Ask Guardian, Performance Coach — §2.2) all
  *consume* investigation and resolve output. A shape that is only enforced by review is a shape
  every new consumer re-litigates.
- `#100` is an open contract self-contradiction: the endpoint hands back `reversal` with `size: 1`
  and then refuses that exact body, because the bound is `2..8`. It needs a decision either way, and
  it is cheaper to settle while the four documents are being made machine-readable than afterwards.

Not proposing the work here — this is the record that it is outstanding, so it is a decision rather
than a discovery.


## 2026-08-19 — audit and RBAC: four corrections from implementing them (Dev A raised, Dev B wrote)

**Two files, no shape change.** `mcp-tools.md` §4/§5/§5.5 and `resolve-api.md` §8. No field added,
removed or retyped; `validate.mjs` unchanged and passing. Raised by @kskubach as #95 rather than as a
PR, because a contract change needs the other developer's review anyway and three of the four touch
Dev B's area. Every claim below was verified against the running build-126 instance, twice —
independently by each of us.

### 1. `not_authorized` refusals are not audited by the runtime — and cannot be

`%AI.ToolMgr.ExecuteTool` checks authorization, then executes, then audits. An authorization denial
throws at the first step, so the audit hook never runs: **0 rows written** with a deny-all policy
registered.

`mcp-tools.md` §5.5 and `resolve-api.md` §8 both attributed the whole guarantee to the runtime. The
guarantee is now real but it takes **two mechanisms**: the runtime audits executions, and
`Tools.AuthPolicy` writes its own row for denials. That distinction is the correction — the previous
wording made the one security-relevant gap invisible by pointing at the wrong component.

Note which half was broken. A **tool-level** refusal — our `2`–`8` bounds guard — *is* audited,
because the tool ran. Only the **authorization** denial was not, i.e. exactly the event a security
review asks about.

### 2. `auditId` implied an AI Hub audit store that does not exist

Example values were `aihub-audit-*`; they are now `pg-audit-*`. `%AI.Policy.ConsoleAudit` — the only
shipped implementation — writes a coloured box to the current device and returns. There is no
`%AI.Audit.*` persistent class in the image; verified by enumerating compiled classes. The record is
`ProductionGuardian.LabDemo.Audit.Entry` and the handle is ours.

The value was always opaque (§9.3 tells Dev C never to compare it to a literal), but the
*provenance* was not: `aihub-audit-*` claimed a system of record that would not survive someone
looking for it — the defect this document already names as "inventing an id that resolves to
nothing".

Also documented: `duration` is integer milliseconds and reads `0` for every read tool, against
`ExecuteTool`'s own timing of `0.0071 s` for the same call. A reader comparing §5.5's promise to a
column of zeroes should find the explanation in the contract.

### 3. The role definitions were unusable as specified

`Guardian_Read` / `Guardian_Resolve` grant only `PG_*`, and a principal holding one dies with
`<PROTECT>` on the tool routine **before any policy is consulted**. Both need `%DB_%DEFAULT:RW` as
well, granted from the invocation path rather than added to the roles.

`RW` and not `R`: the denial audit row is written **as the refused principal**, so a read-only grant
produces a denial that cannot be recorded — which would defeat item 1.

And a limitation now stated instead of implied: LABDEMO's database resource is `%DB_%DEFAULT`, the
*default* resource, so the grant is broad. **The least-privilege story is real at the tool boundary
and is not a database-isolation story.** A demo showing "AI Detective can look but not act" invites
the stronger reading, and the stronger reading is false.

### 4. An out-of-bounds argument is a REFUSAL, not a thrown failure

§4's table classified it under *Call failed — thrown `%Status`*. `Tools.Resolve` has returned a
structured `outcome: "refused"` payload since the tools landed. **The code was right and the
classification was wrong**, and §4 gains a `Refused` row.

Two reasons it matters beyond tidiness. `resolve-api.md` §5 requires `outcome: "refused"` with
`refusal.reason: "out_of_bounds"`, and reaching those from a thrown `%Status` would mean parsing
error *text* into a contract field. And `%LogExecution` receives the tool's *return value*: a throw
records a status and no payload, so the structured return is why `Audit.Entry.Result` can show what
was refused and why.

The existing warning — do not invent an error envelope, do not return `{"error": ...}` from a
successful `%Invoke` — still stands for genuine failures. The line is §5.2's: `refused` means the
system decided not to act and nothing was written; `failed` means it tried and did not complete.

### What all four have in common

**Each was found by implementing the promise, not by reviewing the text**, and three of the four are
a correct premise carried to a conclusion it does not support — the same shape as the `%`-prefix
paragraph corrected the day before. On this contract set the confident, well-argued passage is the
one to check first: it survives review precisely because it reads as already considered.


## 2026-08-18 — role names corrected: no `%` prefix (Dev B)

**Two files, values only, no shape change.** `mcp-tools.md` and `resolve-api.md`:
`%Guardian_Read` → `Guardian_Read`, `%Guardian_Resolve` → `Guardian_Resolve`. 14 occurrences. No
field added, removed or retyped; no schema and no sample affected (these two contracts still have
neither). `validate.mjs` unchanged and passing.

**The ratified names could not be created.** IRIS refuses them:

```
ERROR #887: Invalid role name '%Guardian_Read'
```

`%` marks a role as **system-supplied**, so a custom role may not use it. Resources follow the same
rule, which is why `PG_Read` / `PG_Resolve` were always fine.

**The reasoning in `mcp-tools.md` §5 was backwards, and that is the part worth reading.** It argued
that roles carry `%` *because* it is the convention for a system-supplied role — a true premise
supporting the opposite conclusion — and presented the `PG_*` / `%Guardian_*` split as "two
different naming rules, applied correctly, rather than one applied uniformly and wrongly". It is in
fact one rule applied wrongly. The paragraph has been rewritten rather than just having its values
swapped, because a corrected value under intact bad reasoning invites the next person to "fix" it
back.

**Found by trying to create the roles, not by review.** The passage reads as a considered decision,
complete with a rationale for the apparent inconsistency, which is exactly why it survived
ratification by three people. A confident explanation is harder to doubt than a bare value —
`AuthPolicy.cls` recorded the divergence in a class comment when it hit the error, and this entry
closes it.

**Verified against the running instance** rather than assumed from the error message:

```
RES   PG_Read           RES   PG_Resolve
ROLE  Guardian_Read     ROLE  Guardian_Resolve
```

`resolve-api.md` §9.3's instruction to Dev C — render `audit.role` as an **opaque string** and never
compare it to a literal — is what kept this from being a dashboard change, and is the reason it
stays in force now that the values are settled.


## 2026-08-18 — four new MVP 2 contracts (Dev B)

**Additive only. The two MVP 1 contracts are untouched** — `healthscan-api.md` and
`proxy-api.md` are byte-identical, no field added, removed or retyped, no sample changed.
`validate.mjs` unchanged at 15 accept / 19 reject / 7 capture claims, and still passing: the new
shapes have **no schema and no samples yet**, so CI does not know these endpoints exist. That gap
is named in each file rather than left to be discovered.

| New | Owner | Consumers |
|---|---|---|
| `earlywarning-api.md` | Dev B | Dev C |
| `investigation-api.md` | Dev B | Dev C |
| `resolve-api.md` | Dev B (spec says Dev A + Dev B; Dev A left 2026-08-12 and Dev B inherited `iris/**`) | Dev C |
| `mcp-tools.md` | Dev B (spec says Dev A; same reason) | Dev B, the AI Hub agent |

Status on all four is **`proposed`**, not published. Each names what is missing before that
changes: a `.schema.json`, a `.d.ts`, and a sample **captured from a live run**. The worked
examples in all four are hand-constructed and arithmetically consistent, which is not the same
bar as `contracts/samples/`, and every file says so at the top.

### The three design rules worth reading before the schemas

**A projection is not a measurement** (`earlywarning-api.md` §1.4). Every computed number is
nested inside `projection` with `kind: "projection"`; every observed number sits outside it, so a
consumer cannot hold a forecast without also holding the label. There is deliberately no
`secondsToThreshold: 0` for an already-crossed queue, because zero reads as a measurement of now.
This is #58's defect class — a derived value published in a slot promising an observed one — and
"queue crosses threshold in 4 minutes" is a far more attractive version of it, because an operator
will act on the sentence.

**The data boundary is structural, not a footnote** (`investigation-api.md` §2.3, `mcp-tools.md`
§6). The browser sends `{"findingId": "..."}` and nothing else, `additionalProperties: false` — so
every value the external model sees was engine-measured or tool-read, and a browser cannot inject
text into an LLM prompt. Tool *return values* are the only place instance data crosses the
boundary by design, so the permitted and forbidden lists are per-tool. `get_recent_errors` is the
live risk rather than a formality: it returns an IRIS error code mapped through an allowlist to a
catalogue string, `unclassified` with no text for anything unrecognised. Two edges named because
they are the ones that get missed — refusal *reason strings* cross the boundary too, and a count of
one can itself be content, which is why the windows are bounded.

**A recommended action is a structured object, never prose** (`investigation-api.md` §3.3). It is
the input to a live production write that a human approves, and free text cannot be bounds-checked
or matched against a whitelist. `recommendedAction.action` is `{type, host, size}` and is a
field-for-field match with what `resolve-api.md` accepts — verified across both files, so there is
no translation layer for Dev C to write.

### Three cross-contract conflicts found and resolved while drafting

Recorded because they were caught by writing the contracts *together* rather than in sequence, and
each would have been a live integration bug:

1. **`recommendedAction` shape.** `resolve-api.md` refuses unknown keys *inside* `action`, so a
   flat action object carrying advisory fields would have been rejected as `malformed_request`.
   Advisory fields (`currentValue`, `bounds`, `reversible`, `requiresApproval`, `summary`) are now
   siblings of `action`, not members of it.
2. **Bounds disagreed** — `1`–`4` versus `2`–`8`. Settled at `2`–`8`: the lower bound excludes `1`
   because `1` is the *shipped* value, so recommending it is a no-op dressed as a fix.
3. **Reusing Early Warning's `projection` inside an investigation would have been `null` every
   time.** Early Warning publishes `projection: null` with reason `already_crossed` exactly when a
   queue has crossed its threshold — which is the state that made `queue_buildup` fire, i.e. the
   only condition an investigation is ever requested for. Renamed to `trend`, keeping the field
   names and units but dropping the forecast framing, with `thresholdCrossed: true` and
   `secondsToThreshold: null` as the normal case. Without it the "queue slope positive" evidence
   bullet was unobtainable.

### `resource` vs `role` is a distinction, not a disagreement

`mcp-tools.md` gates on IRIS **resources** (`PG_Read`, `PG_Resolve`); `resolve-api.md` publishes
the **role** that holds one (`%Guardian_Read`, `%Guardian_Resolve`) in `audit.role`. Reconciled
after both landed, with a table in `resolve-api.md` §9.3, because grepping for one string and
finding the other looks exactly like the #84 stale-copy pattern and invites a "fix" that would
break it.

> **The role names in the line above were corrected on 2026-08-18** to `Guardian_Read` /
> `Guardian_Resolve` — see that day's second entry. Left as written here rather than rewritten: a
> changelog records what a contract *said*, and silently updating a past entry would erase the fact
> that the ratified names were unimplementable. The **resource/role distinction** the paragraph
> makes is unaffected and still correct.

### What is asserted about the runtime, and how it was established

Authorization and audit are stated as a **guarantee** rather than a convention: they are performed
by the runtime around every tool execution, in that order, so a tool author cannot forget them or
bypass them via a careless `%Invoke` — and because the check precedes execution, a denied call
cannot have partially mutated the production. Read from the shipped body of
`%AI.ToolMgr.ExecuteTool` in the running `pg-iris` container, not inferred from the class list,
because "the classes exist" and "the classes are enforced" are different claims and only the second
is worth anything on a live production. Working notes in `docs/mvp2-aihub-verified-api.md`.

Two things are **explicitly unverified** and flagged in the files rather than assumed: what an
audit record contains once written (Dev C has to display one), and whether the default policy
actually denies — `%AI.Policy.ConsoleAuth`/`ConsoleAudit` are wired out of the box, and "enforced
by the runtime" is only a safety property if the configured policy refuses. `resolve-api.md` makes
registering our own policy and testing a denial acceptance criteria rather than assumptions.

### One change outside `contracts/` that these depend on

`POST /api/resolve` cannot work as the engine stands: it sends `Access-Control-Allow-Methods: GET,
OPTIONS` and no `Access-Control-Allow-Headers`, so a browser preflight for a JSON POST fails while
every existing GET keeps working. Verified against the live engine. Not fixed here — it is engine
code, not a contract — but named so it is not discovered from a dashboard that silently cannot
submit an approval.

---


## 2026-08-13 — `system_alert` scope stated in `healthscan-api.md` (Dev B)

**Documentation only.** No field added, removed or retyped; no schema change; no sample
touched. `validate.mjs` unchanged at 15 accept / 19 reject / 7 capture claims. Recorded here
because `contracts/` is edited by PR regardless of size (root `CLAUDE.md` §4) — and because I
applied that rule to myself two PRs ago and then didn't, which @tanifgit caught on #62.

The `system_alert` row said *"New alert posted to alerts.log"*. That describes a rule which
surfaces the alert log; it surfaces the **host-attributable subset** of it. An alert naming no
reported host produces no finding at all — not an unattributed one — and a consumer could
learn the difference only by reading `detect/engine.ts`.

The row now says so, with the measured table (#61). Note "reported", not "configured": a
framework item like `Ens.MonitorService` **is** configured, but is filtered before the
attribution set is built, so it is not a candidate either. That distinction was wrong in my
first draft and is the case a reader is most likely to hit, since `/api/monitor/alerts` is
largely about IRIS's own subsystems.

No consumer behaviour changes. `Finding` and `FindingsResponse` are untouched — in particular
`FindingsResponse` stays a bare array rather than gaining a `_meta` for this diagnostic, which
would be a breaking change to both endpoints for a diagnostic. Dev C asked for it to stay as
is; the engine logs unattributed alerts instead, at no contract cost.


## 2026-08-13 — sample-provenance caveat on `metrics-dump.txt` (Dev B)

**Documentation only. No field added, removed or retyped; no schema change; every existing
payload stays valid.** Recorded here because `contracts/` is edited by PR regardless of how
small the change is, and because the thing being written down was load-bearing enough to cost
a full diagnosis cycle.

`samples/metrics-dump.txt` reports four application hosts, `samples/hosts-response.json`
reports three, and that disagreement sits in the one directory whose purpose is that everybody
mocks the same bytes. The reason is now stated in `proxy-api.md` §1: the sample was captured
from **`LABDEMO.Production`, an unrelated production with its own class tree that does not
exist in this repo** — not from a stale deployment of `iris/labdemo/Production.cls`, which was
not compiled in the namespace at all until 2026-08-12.

So the sample is authoritative for label *shapes* and metric *families*, and not for the
roster. Requested by Dev C on #34, who also asked that the note say **different production**
rather than *stale deployment*, since writing down the wrong reason is how a wrong conclusion
gets re-derived later.

**The evidence is in the repo, not on an instance** — deliberately, since `contracts/` is read
by whoever comes next and they will not have this instance. `metrics-dump.txt` carries
`production="LABDEMO.Production"`; `Production.cls` has been
`ProductionGuardian.LabDemo.Production` in every commit; and the sample's spaced host names
coexist with `FHIR Transform`, a combination no commit of `Production.cls` produced, because
FHIR Transform was removed *before* the rename to spaced names. Dev C established that chain
on #55 and it is stronger than the compile-date reason this entry originally carried.

For completeness, and cited rather than asserted: `LABDEMO.Production` was still present on the
instance on 2026-08-13 (it is deliberately not deleted, #34 condition 4), and its items are
`LABDEMO.Service.EMRSource`, `LABDEMO.Process.LabRouter`, `LABDEMO.Process.FHIRTransform`,
`LABDEMO.Operation.CloudAPI`. That is an observation from `Ens.Config.Production`, not something
derivable from this repo — which is why the note in `proxy-api.md` rests on the two repo facts
instead.


## 2026-08-12 — `_meta.hostStatus.undescribedHosts` added (Dev B)

Adds one diagnostic field, no change to any host or finding field. Follows the same-day entry
that made `queued`/`errored` measurable per host.

`merged === hostCount` was documented as the way to check the host-status join, and it does not
work in the failure that matters: if one host drops out of the endpoint — a rename, or a query
that missed it — both counts shrink together, the comparison still passes, and that host alone
keeps `queued: null`. Reproduced by Dev C on #36 and confirmed here:

```
all four described :  merged=4 hostCount=4  merged===hostCount? true  undescribedHosts=[]
Lab Router missing :  merged=3 hostCount=3  merged===hostCount? true  undescribedHosts=["Lab Router"]
```

`unmatchedHosts` already reported the opposite direction (endpoint → metrics). This is the
direction a consumer feels, because it is the one that leaves a `null` in front of them.

Framework hosts are excluded deliberately: the endpoint legitimately omits some, so on the live
instance `Ens.Alarm` and `Ens.MonitorService` are absent by design. Counting them would make a
healthy state look broken — which is also why `snapshot.hosts.length - merged` is not a usable
check, reading `15 - 13 = 2` while everything is fine.

## 2026-08-12 — `Host.queued` and `Host.errored` become `number | null` (Dev C)

**A real field-type change on the published contract, and the first one that requires an edit on
both sides.** `queued` and `errored` widen from `integer` to `integer | null`. `null` means *"not
measurable for this host"* and never *"zero"*. Both keys stay **required** — a `null` value is
legal, an absent key is not.

**Why: the engine publishes a `0` nobody measured, and one rule reads that `0` as a symptom.**
`iris_interop_queued` carries no `host` label (it emits once per production), so at the time of
writing the proxy sent `queued: null` for **every** host — established in issue #12 and confirmed
against the real capture on PR #33. The engine's `normalizeHost()` collapses that `null` to `0`
because this schema declared the field a required integer. So the coercion exists *to satisfy this
file*, which makes the fix belong here rather than in the engine.

That coercion is not inert. Two reproductions from the PR #33 review, both by probing rather than
reading:

```
after 20 healthy polls at 1.2 msg/s  : []
after 2 polls with messagesPerSec=null: ["throughput_drop"]
   -> throughput_drop | Throughput 0.0 msg/sec is 100% below baseline
```

```
Host idle 400s, status OK:
  queued: null  (what live sends)  -> Host.queued=0  -> findings=[NONE]
  queued: 5     (measurable depth) -> Host.queued=5  -> findings=[stalled_host]
```

The first is a critical-looking finding about a production running perfectly; the second is a rule
silently switched off, because `requiresQueued && host.queued <= 0` can never be satisfied when
every host reports `0`. **Note the asymmetry** — coercing to zero is harmless for every rule where
higher is worse (`slow_processing`, `growing_queue_wait` fall under their floors and stay quiet) and
unsafe for the one rule where lower is worse. That is what makes it a type problem and not a
threshold problem.

Dev A's parser already carries the argument, in `parser.js:264`:

> *Every numeric field starts null, not 0. IRIS omits whole families rather than emitting zeros,
> and `0` has to keep meaning "measured zero" or every comparative rule downstream reasons about
> invented data.*

The pipeline preserves `null` end to end and then discards it in the last function before the rules
run. This change lets it survive to the consumer, so **rules skip instead of comparing** and
`stalled_host` can tell *"nothing queued"* from *"depth unknown"*.

**Supersedes the "Known gap" note of 2026-08-06**, which concluded that `Host.queued` stays a
required number because per-host depth is available from `Ens.Util.Statistics:EnumerateHostStatus`.
That is still true of IRIS, and it is how the measured `48` in `samples/hosts-response.json` was
obtained — but the proxy read the Prometheus metrics text only, so the note's own condition
(*"no contract impact if that holds"*) did not hold.

### PR #36 changes which case is normal, and does not remove the need for this

**#36 makes per-host counts measurable** — a host-status REST endpoint in `iris/`, merged by the
proxy on host name — so the counts arrive as real numbers and the all-null era ends. That does not
make this change unnecessary; it changes `null` from *the norm* into *the documented exception*, and
an exception still has to be expressible:

- a host the endpoint's response did not describe (`_meta.hostStatus.unmatchedHosts`),
- the endpoint unreachable, 404 on a missing CSP application, or the third poll failing,
- the merge switched off with an empty `IRIS_HOSTSTATUS_PATH`.

**#36 holds exactly this invariant on its own side** — *"a host the endpoint did not describe keeps
`null`, not `0`"* — and its proxy contract already types both counts as `NullableCount`. Without
this change the published contract is the one place in the chain that cannot represent what the
proxy is careful to preserve, and the engine has to flatten it on the last hop. The two changes
agree; they are not alternatives.

Note this also means the *reproductions above stay reachable after #36*, on any host the merge
misses — which is the argument for landing both.

**Changes:**

- `healthscan.schema.json` — `queued` and `errored` → `"type": ["integer", "null"]`. `minimum: 0`
  is kept and still applies; draft-07 `minimum` does not constrain `null`.
- `healthscan.d.ts` — `queued: number | null`, `errored: number | null`.
- `healthscan-api.md` — §1 field table, an explicit present-but-null sentence under it, and **Q13**
  in §4. §4.1 records this as the second contradiction of a Dev C assumption after Q1.
- `validate.mjs` — one must-accept (`queued`/`errored` both null, the shape the live proxy sends
  today) and two must-reject: `queued` as a **string**, and the key **omitted entirely**. The
  accept case is what makes the change real; the reject cases are what stop it from meaning
  "anything goes". 14 checks, was 11.

**The samples are deliberately unchanged.** They carry measured LABDEMO values, and `queued: 48`
on a disabled Cloud API was genuinely observed. Rewriting them to `null` would trade a real number
for a synthetic one and would move the bytes Dev B's fixtures and Dev C's eight scenarios are
anchored to, mid-sprint, for no gain. The null shape is exercised in `validate.mjs` instead, which
is where a shape with no measured instance belongs.

Verified: `node validate.mjs` → 14/14. Reverting the schema to `"type": "integer"` fails the new
accept case, so it bites rather than decorating.

### Open on the consumer side, not resolved here

**`messagesPerSec` has the same argument and is deliberately left alone.** It is a *rate*, and
`parser.js:81` maps `NaN`/`Inf` to `null` — a zero-length sample window right after a production
restart yields exactly that. If the engine keeps coercing it, the dashboard prints a measured-looking
`0.0` msg/sec for a host whose throughput is simply unknown, which is this same defect in the grid
rather than in a rule. Widening it is a larger change than this PR (it is the metric `throughput_drop`
is built on), so it is raised as a question for Dev B rather than decided unilaterally.

**Whether `stalled_host` should skip or fire on an unknown depth is Dev B's call**, and PR #33's
review asks for it to be written down either way. This change only makes the choice expressible.

## 2026-08-12 — Metrics proxy contract published (Dev B, on Dev A's behalf)

Initial publication of `proxy-api.md`, `proxy.schema.json`, `samples/metrics-dump.txt`.

Closes the last Day-1 gate item from `CONTRIBUTING.md` §6 (issue #16 item 4). Answers all five
`PROXY-Q` markers in `services/detection-engine/src/types/proxy.ts` inline in §5, plus three that
surfaced while writing it.

**Dev A has moved to other work, so this is derived from their merged code rather than authored
alongside it.** Every claim comes from reading `services/metrics-proxy/` on `main` and running it,
not from intent. Attribution is Dev B's; the contract's owner in `README.md` stays Dev A, because
the code is still theirs and `CODEOWNERS` still routes `services/metrics-proxy/` to them.

`samples/metrics-dump.txt` is the real 1236-line `/api/monitor/metrics` body from a live LABDEMO
production, byte-identical to the capture behind issue #10 — copied, not regenerated. 957 metric
lines, 15 interop hosts, 4 application. **It is 1236 lines, not the 1249 quoted in issue #10 and in
`src/parser.js`'s comment**; the same file, counted differently, and the smaller number is what
`wc -l` reports. Not worth chasing, worth not silently contradicting.

### Three things the contract says that were not previously known

- **`iris_interop_messages_errored` carries no `host` label either.** It is per-production, exactly
  like `iris_interop_queued`: `iris_interop_messages_errored{id="LABDEMO",production="LABDEMO.Production"} 0`.
  The parser's `METRIC_MAP` treats it as per-host, so the line is skipped for want of a `host` label
  and `errored` is `null` on every host. **`elevated_error_rate` cannot fire per host today** — the
  same structural gap as `queue_buildup` (#12) and, unlike that one, not filed. §6.3. Worse than
  `queued` in one respect: no per-production total is published anywhere, because
  `messages_errored` is not in `SCALAR_FAMILIES`, so the value is parsed and dropped.
- **Every one of the 15 real hosts is rejected by Dev B's `isProxyHost()`.** Measured, not
  predicted. Three field-level mismatches, each independently sufficient: `name` vs `host`,
  `messagesErrored` vs `errored`, and `queued: null` against a finite-number guard. The guard
  log-and-skips per host, which is right — but a mismatch in a field every host shares turns "skip
  the bad entry" into "report zero hosts", with no error surfaced. §5.2.
- **The engine's live client cannot work today, for two more reasons the mock cannot show.** It
  requests `/api/metrics` (the real route is `/proxy/metrics` → `404`), and it reads `alerts` from
  the metrics payload, where they are never present — alerts are a separate endpoint, so
  `system_alert` can never fire in live mode. Both pass typecheck and every unit test. This is
  ADR 0004's named cost landing a second time: `mockClient.ts` reads fixtures written to the
  engine's own assumed shape, so mocking against them proves self-consistency and nothing else.

None of these change a published field. **All of the reconciliation is on Dev B's side** — the
proxy's shape is verified against live IRIS, and `contracts/` is not edited to make a consumer
compile.

### Two open items, deliberately not resolved here

- **§6.1 — `queued: null` vs `queued: 0`.** The schema permits `null` because that is what the
  proxy emits; a schema that rejected the running code would be a fiction. **The contract position
  is that `0` is the conformant placeholder**, and the recommended fix is one line on the engine
  side: accept `null` and have `queue_buildup` skip an unmeasurable host, the way comparative rules
  already skip a warming baseline. That preserves the absent-is-not-zero invariant the rest of the
  payload depends on instead of carving out an exception for the inconvenient field.
- **§6.2 — `errored` vs `messagesErrored`.** Raised on #16. Recommendation is `errored`, and the
  tie-break is blast radius: `errored` costs one line in the engine, `messagesErrored` costs a
  change to a ratified contract with a live consumer — its schema, its `.d.ts`, two samples and Dev
  C's components — for a naming preference. Published as `errored` because that is what the code
  emits. **A request for a decision, not a decision.**

### `validate.mjs`

Extended, structure unchanged: `PROXY_MUST_ACCEPT` (5), `PROXY_MUST_REJECT` (8), and
`CAPTURE_CLAIMS` (7) alongside the existing arrays. 31 checks total, up from 11.

`samples/metrics-dump.txt` is Prometheus text, not JSON, so it cannot be validated against a
schema the way the healthscan samples are. `CAPTURE_CLAIMS` covers it with regexes over the label
shapes the contract quotes — including two asserting a label is **absent** (`queued` and
`messages_errored` have no `host` label). An assertion that something is missing is the only way a
future capture silently gaining it gets noticed.

Two of the must-reject cases are the engine's *current* shape (`name`, `messagesErrored`). If §6.2
is settled the other way, those checks fail and say so — which is the point of putting them there
rather than in a comment.

Verified: `npm run validate` → 31/31. Confirmed the new checks can fail, rather than assuming it:
adding `Active` to the status enum fails 1, narrowing `NullableCount` to `integer` fails 3, and
stripping the `messages_errored` line from the capture fails 1. A validator never seen to fail is
not known to be testing anything.

## 2026-08-12 — `queued` and `errored` are measured per host (Dev B, for Dev A's area)

**Amends `proxy-api.md` and `proxy.schema.json` shortly after they were published.** When this was
written those files were not yet on `main` — they arrived with PR #30, which has since merged — so
it began as an amendment to an unmerged contract and landed as a change to a ratified one. It is recorded here anyway: the whole point of this
file is that no contract statement changes silently, and "it was only just written" is not an
exception.

**Dev A has moved to other work and Dev B has taken over their outstanding tasks**, including this
contract and the `iris/` and `services/metrics-proxy/` changes behind it.

### What changed

`queued` and `errored` were documented as **`null` on every host, always**. They are now **measured
numbers** whenever the new host-status source answers. Neither field's *type* changed —
`number | null` before and after — so **no consumer is required to change anything.** What changed
is which of the two cases is normal.

- `proxy-api.md` — new **§1.3** explaining the third data source and the exact-match join; §1
  sample payload replaced with a live capture; `queued`/`errored` rows in §1.1 rewritten; new
  optional `statusFromMetrics` row; new `_meta.hostStatus` row in §1.2; **Q2** and **Q8** answered
  differently; **§5.2** updated to record that PR #33 fixed the engine side; **§6.1** and **§6.3**
  closed.
- `proxy.schema.json` — `queued`/`errored` descriptions rewritten; new optional
  `ProxyHost.statusFromMetrics`; new `HostStatusMeta` definition; `MetricsMeta.hostStatus` added.
- `validate.mjs` — 5 new accept cases, 4 new reject cases (40 checks total, all passing).

### Why the values were null, and where they come from now

Neither `iris_interop_queued` nor `iris_interop_messages_errored` carries a `host` label — both are
emitted once per production. Two of the eight finding types, `queue_buildup` (#12) and
`elevated_error_rate` (#31), were structurally unable to fire per host because of it. Two checks in
`validate.mjs` assert that absence against the capture, and they still pass: **the metrics text has
not changed, the proxy reads somewhere else as well.**

That somewhere is `Ens.Util.Statistics:EnumerateHostStatus` plus `Ens.MessageHeader`, exposed by a
new read-only `%CSP.REST` class in `iris/` and polled on the metrics interval. This is option (1)
on #12, which Dev A proposed and Dev C endorsed.

**The join key survives unnormalized, which is what makes this safe.** `EnumerateHostStatus`'s
`Name` column and the metrics `host` label are the same string, spaces intact — verified against
both sources on one instance. No trimming, no case folding: a host that stops matching is reported
in `_meta.hostStatus.unmatchedHosts` rather than guessed at, because silently mapping `CloudAPI`
onto `Cloud API` would attribute one host's queue depth to another.

### `null` still means exactly what it meant

The "absent is not zero" invariant is unchanged and this change leans on it rather than eroding it.
`null` now means *the host-status source was unavailable, or did not describe this host* — still
never a placeholder, and still never substituted with `0`. `_meta.hostStatus` exists so a consumer
can tell **"every `queued` is null because the endpoint is down"** from **"every `queued` is
genuinely 0"**, which are identical in the host array alone. `merged: 0` with `shape: "hosts"` is
the specific case worth alerting on: the endpoint answered and nothing matched.

### Verified

- The endpoint called over HTTP against live LABDEMO: `200`, `application/json`, 13 hosts.
- `GET /proxy/metrics` from the proxy running against live IRIS: 15 hosts, **13 merged**,
  `unmatchedHosts: []`, `queued` and `errored` numbers on all four application hosts.
- `npm run validate` → 40/40. Proven load-bearing rather than merely passing: with
  `statusFromMetrics` and `HostStatusMeta` removed from the schema in memory, the new cases fail.
- `services/metrics-proxy`: 96 tests pass, up from 71.
- **Engine needs no change, and this was checked rather than assumed** — `ProxyHost.queued`/`.errored`
  are `NullableCount` and `isProxyHost` gates them with `isNullableCount` on
  `devB/live-mode-reconcile` (PR #33).

### Not verified — read this before treating either finding as done

**No non-zero queue depth or error count was observed on live IRIS.** The production is healthy: it
drains immediately, and all 163,392 rows in `Ens.MessageHeader` are `Status = 9` (Completed). 400
samples of `Ens.Queue.GetCount` and 40 of `EnumerateHostStatus` read `0`/empty throughout. Inducing
either state requires disabling or misconfiguring a host — a production change, out of bounds on a
shared instance.

So: **the plumbing is verified end to end; the two findings actually firing is not.** The non-zero
path is covered by schema cases and a unit test explicitly labelled synthetic, and rests on the
depth of `70` measured earlier on this instance with `Cloud API` disabled. Note also
`queue_buildup`'s `absoluteFloor: 50` (#16): real numbers arriving and the rule tripping are
separate milestones.

## 2026-08-10 — `FHIR Transform` removed from the samples (Dev A)

**No schema change and no field change.** `host` is `{"type": "string", "minLength": 1}` with no
`enum`, so this is samples plus one prose sentence. Consumers that read `host` as an opaque string
need no edit.

**Why:** the LABDEMO production no longer has a FHIR Transform host, so IRIS cannot emit that
`host` label. §2 of `healthscan-api.md` says only application config items appear; a host the
production cannot produce does not belong in a sample Dev B and Dev C mock against. Verified
against `iris/labdemo/Production.cls`: the items are `EMR Source`, `Lab Router`, `Cloud API`, plus
the framework-filtered `Ens.ActivityReporter`.

**It was real when the samples were written — this is a removal, not a correction of a fabrication.**
Worth stating plainly, because Dev B's live capture in issue #10 does show
`host="FHIR Transform"`. It was an `EnsLib.MsgRouter.RoutingEngine` whose rule forwarded everything
straight to CloudAPI: no DTL, and nothing FHIR, as its own class comment said. It existed to
generate metric activity. Keren removed it in `1801a50` when the pipeline became HL7→PID, and
PR #14 settled on the three hosts above. The samples are simply older than that change.

Restoring it instead would mean re-adding a pass-through host to the production for no reason
other than making a fixture true. Nothing in the pipeline produces FHIR — that name was aspirational
from the start.

**Dev B's instance still runs the older production definition,** so a fresh capture there will show
four hosts until it is reloaded from `iris/labdemo/`. That is expected and breaks nothing: an extra
host is over-coverage, and the parser reads whatever `host` labels arrive.

> **ATTRIBUTION SUPERSEDED 2026-08-13 — see the 2026-08-13 entry at the top.** The paragraph above
> reads the four-host capture as *this* production, one version behind. It was a different
> production: the sample's own label says `production="LABDEMO.Production"`, and
> `iris/labdemo/Production.cls` has been `ProductionGuardian.LabDemo.Production` in every commit.
> The sample's host names are also a combination this repo never produced — spaced names *and*
> `FHIR Transform`, whereas here FHIR Transform only ever coexisted with **unspaced** names.
>
> The rest of this entry stands, including the part that matters most: the capture is **real, not
> invented**. Only the "one version behind our own production" attribution is wrong. Left in place
> rather than rewritten, because an entry that quietly changes its reasoning stops being a record.

**Changes:**

- `samples/hosts-response.json` — the `FHIR Transform` entry is gone. Three hosts remain, still in
  stable alphabetical order per §1.
- `samples/findings-response.json` — finding `f-1038` (`slow_processing`) **reassigned** to
  `Lab Router`, not deleted. The samples carry exactly one finding per type; deleting it would
  have zeroed `slow_processing` coverage for everyone mocking against these bytes. The reassignment
  invents nothing: the finding cites `baselineValue: 0.08`, which is already Lab Router's measured
  `avgProcessingTime` in `hosts-response.json`. Its `host` is now a host that exists, and its
  baseline still agrees with that host's row — it agrees *better* than before.
- `healthscan-api.md` §2 — "exactly four: EMR Source, Lab Router, FHIR Transform, Cloud API" →
  "exactly three: EMR Source, Lab Router, Cloud API".

Verified: `node validate.mjs` passes; both samples still valid.

### Follow-up outside `contracts/`, not part of this PR

`FHIR Transform` also appears in `services/detection-engine/fixtures/proxy/*.json` (8 files) and the
four-component sentence in the root `CLAUDE.md`, `apps/dashboard/CLAUDE.md`,
`services/detection-engine/CLAUDE.md`. Those are each in their owner's area, so they are not touched
here. `services/metrics-proxy/fixtures/metrics.txt` is Dev A's and is already done on the PR #13
branch. Nothing breaks meanwhile — an extra host in a fixture is over-coverage, not a failure.

## 2026-08-09 — Schema fixes from Dev C's review (Dev B)

Two **schema** defects found by Dev C reviewing PR #3, both with reproductions, both confirmed
here before fixing. The prose contract was right in both cases; the schema disagreed with it. No
change to any documented field, so **nothing to reconcile on the consumer side.**

**1. The schema rejected `[]`.** The root `oneOf` failed on an empty array because it satisfied
*both* `HostsResponse` and `FindingsResponse` vacuously, and `oneOf` requires exactly one match.
§3 mandates `200` + `[]` for no findings, no hosts, *and* engine startup — so the CI job in
`README.md` would have failed on the single most common healthy response.

Fixed by removing the root `oneOf` entirely and validating against named definitions. That is
strictly better than switching to `anyOf`: it also closes a hole where a **hosts array served in
the findings position validated fine**, because the root schema accepted either and could not
tell them apart. A check that silently was not happening.

**2. The timestamp `pattern` rejected `toISOString()`.** It forbade fractional seconds, but JS
always emits milliseconds (`.000Z`) and Python's `isoformat()` gives microseconds. Dev C's eight
fixtures all failed on this for real. Fixed by allowing optional sub-second digits:
`(\.[0-9]{1,6})?`. Second precision stays valid, so nothing that passed before now fails.

Chose relaxing over demanding second precision because `format: date-time` already accepted what
`pattern` rejected — only the stricter one bit, which made it an accident rather than a decision.
Requiring emitters to slice digits off a native formatter is a tax with no benefit, given
`lastActivity` is ±10s anyway (Q11).

**Also added `validate.mjs` + `package.json`,** replacing the `ajv-cli` one-liners in `README.md`.
Dev C found those degrade silently: `-c ajv-formats` resolves from the invocation directory and
ignores `format` when run elsewhere, and the `#/definitions/...` argument is rewritten into a
filesystem path by Git Bash on Windows. The script also asserts **five must-reject and four
must-accept cases**, because both defects here were *structural* — the class that positive-only
and value-level testing cannot reach.

Verified: `npm run validate` → 11/11 checks pass; both committed samples still valid.

## 2026-08-06 — Health Scan contract published (Dev B)

Initial publication of `healthscan-api.md`, `healthscan.schema.json`, `healthscan.d.ts`,
`samples/hosts-response.json`, `samples/findings-response.json`.

Closes the Day-1 gate for the Dev B → Dev C contract (issues #1, #2). Answers all nine of Dev C's
schema questions inline in §4 of `healthscan-api.md`.

Follows §5 of the MVP doc exactly — no fields added or removed. Three deviations from what the
MVP doc *implies*, all forced by what live IRIS actually emits:

- **`status` has no `Warning`.** The real enum, read from IRIS source, is `OK`, `Error`,
  `Inactive`, `Retry`, `Stopped`, `Unconfigured`, plus `Disabled` from `EnumerateHostStatus`.
  This is the one answer that contradicts a Dev C assumption — the `HostStatus` union needs
  `Warning` removed. Existing code still degrades correctly because unknown statuses already
  render neutral.
- **`type` is normalized.** IRIS reports business processes as `actor`. We map
  `actor → process` so the contract keeps the MVP doc's vocabulary.
- **`avgProcessingTime` / `avgQueueingTime` are aggregates.** IRIS emits these per
  `(host, messagetype)`, so one host has several series. We collapse them to one number,
  weighted by `iris_interop_sample_count`.

Units confirmed empirically rather than assumed: Cloud API configured at 0.05s latency reports
`avgProcessingTime: 0.05`. Seconds, as Dev C assumed.

Samples carry real measured values from the LABDEMO production, including a genuinely induced
degraded state (Cloud API disabled → queue depth 48), not invented numbers.

### Known gap, not a contract change — CLOSED 2026-08-12

`iris_interop_queued` carries no `host` label — it emits once per production. Per-host queue depth
is available from `Ens.Util.Statistics:EnumerateHostStatus` (verified: `Cloud API = 48` while
disabled), so `Host.queued` stays a required number. **This needs Dev A's proxy to read host
status, not only the Prometheus metrics text.** Raised with Dev A separately; no contract impact
if that holds.

**Resolved, and one clause of it turned out wrong.** The proxy reads host status as of #12/#36,
so per-host depth flows end to end. But "`Host.queued` stays a required number" did not hold:
it is `["integer","null"]` since the 2026-08-12 entry above, because a host whose depth is not
measurable must be distinguishable from one measuring zero. Still required — a null *value* is
legal, an absent *key* is not. #31 confirmed the same per-production shape for
`messages_errored`, re-verified 2026-08-12 against `ProductionGuardian.LabDemo.Production`
with traffic flowing rather than only against the capture from an unrelated production.
