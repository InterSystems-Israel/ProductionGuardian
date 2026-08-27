# Invalid HL7, the router's `Validation` setting, and the trigger inventory

Investigation notes, measured against the live `pg-iris` stack on 2026-08-23. Not a contract.

Three questions were asked: what happens when the production is fed an invalid HL7 message,
what the `Validation` setting on `Lab Router` does, and what the trigger inventory actually
covers. The answer to the first decides the third, so it comes first.

---

## 1. The headline: a validation failure is invisible to Health Scan

**An invalid HL7 message is detected by IRIS, logged by IRIS, and surfaced by exactly one of
our tools. No finding fires, and no finding can fire.** The message is discarded, the router
stays `OK`, nothing queues, and the engine's error rate stays at zero.

Measured end to end. Two independent experiments, both with real traffic flowing:

| Probe | Reading |
|---|---|
| Does the production reject it? | **Yes, silently.** The file is consumed and archived normally |
| Does the message reach `Cloud API`? | **No.** Not forwarded; no `PatientRecord` row written |
| `Ens_Util.Log` | **One `Type=2` (Error) row on `Lab Router`**, `SourceMethod=OnError` |
| `Ens.MessageHeader` | Status **`9` (Completed)**, not `8` (Error) — see §1.2 |
| `GetRecentErrors("Lab Router")` | **Sees it.** `count` rises, `errorCode: "<Ens>ErrGeneral"` |
| `GetHostStatus("Lab Router")` | **`"OK"`** — the host never leaves OK |
| `GetQueueDepth("Lab Router")` | **`0`** — nothing queues, the message is dropped not retried |
| proxy `/proxy/metrics` → `Lab Router.errored` | **`0`**, throughout |
| `GET /api/healthscan/findings` | **No validation-related finding, ever** |

The definitive run: `Validation` set to `dmt` on `Lab Router` so that *every* real generator
message fails validation. Over four minutes that produced **38 validation-failure log rows**
and **0 errored message headers**, while the host read `OK` and the findings list showed
nothing attributable to validation.

### 1.1 The actual tool JSON

Single hand-injected invalid message (an `ADT^A99` — a message type with no `DocType` in
schema `2.5`), synthetic patient data only:

```json
{"host":"Lab Router","sinceMinutes":15,"count":1,"sanitised":true,
 "byCode":[{"errorCode":"<Ens>ErrGeneral","count":1,
            "summary":"the interoperability framework raised a general error",
            "secondsAgo":76}],
 "newestSecondsAgo":76}

{"host":"Lab Router","found":1,"status":"OK","enabled":1}
{"host":"Lab Router","queued":0,"measured":1}
```

Under strict validation with all traffic failing, the same three tools:

```json
{"host":"Lab Router","sinceMinutes":15,"count":38,"sanitised":true,
 "byCode":[{"errorCode":"<Ens>ErrGeneral","count":38,
            "summary":"the interoperability framework raised a general error",
            "secondsAgo":84}],
 "newestSecondsAgo":84}

{"host":"Lab Router","found":1,"status":"OK","enabled":1}
{"host":"Lab Router","queued":0,"measured":1}
```

So `GetRecentErrors` is the **only** tool that sees a validation failure at all, and it sees it
as `<Ens>ErrGeneral` — which is allowlisted, so it is not `unclassified`, but it is also the
catch-all bucket. **The error code cannot distinguish a validation failure from any other
framework error.** An agent reading `<Ens>ErrGeneral` learns that something in the
interoperability framework complained, not that a message was malformed.

### 1.2 Why no finding can fire — the mechanism, not a tuning problem

`elevated_error_rate` is the only rule that could plausibly fire, and its input is
`errorsPerMinute`, derived in `services/detection-engine/src/detect/engine.ts` from the
proxy's per-host `errored` field. That field comes from
`iris/labdemo/REST/HostStatusDispatcher.cls`, which counts:

```sql
SELECT %EXACT(TargetConfigName), COUNT(*) FROM Ens.MessageHeader WHERE Status = 8
```

`Status = 8` is `Error`. **A validation failure never produces one.** The router declines to
forward the message and completes the header as `Status = 9` (`Completed`) — verified on the
exact header for the injected message, and confirmed as `0` rows of `Status = 8` for
`Lab Router` for all time. So `errored` stays `0`, `errorsPerMinute` stays `0`, and the rule's
`errorsPerMinuteFloor` (1.0) is never approached.

This is a **structural gap, not a threshold**. Lowering any number in `thresholds.json` would
not help, because the signal never reaches the engine. The validation failure exists only in
`Ens_Util.Log`, and nothing in the proxy or the engine reads that table.

> Note for whoever touches `#errorsPerMinute`: its comment says "`errored` is null on every
> host today: `iris_interop_messages_errored` has no `host` label (#31)". That is **no longer
> true** — `HostStatusDispatcher` closed it, and `Cloud API` currently reports
> `errored: 715`. The comment is stale, not the code.

### 1.3 What the agent says

`POST /api/investigate` was run against a live `dead_host` finding while the stack was in this
state. The agent is genuinely live — `source: "agent"`, `model: "gpt-4o-mini"`,
`toolCalls: 2`, per the `iris/CLAUDE.md` §7 pre-demo check — and it produced a correct,
well-evidenced diagnosis of the *directory* fault it was asked about.

**But there was no validation finding to investigate**, which is the point. The agent can only
explain findings the engine produces, so a validation failure never reaches it. Had it
investigated one, the only evidence available would have been `<Ens>ErrGeneral` with a count —
enough to say "something is failing", not enough to say "messages are malformed".

---

## 2. `Validation` on `EnsLib.HL7.MsgRouter.RoutingEngine`

### 2.1 The flag letters, and the source

`Lab Router` **is** `EnsLib.HL7.MsgRouter.RoutingEngine` (confirmed in
`iris/labdemo/Production.cls`).

Source: the `Description` of the `Validation` property on the compiled class, read out of the
live instance's dictionary rather than from documentation —

```objectscript
##class(%Dictionary.CompiledProperty).%OpenId("EnsLib.HL7.MsgRouter.RoutingEngine||Validation")
```

| Flag | Meaning (quoted from the property description) |
|---|---|
| `d` | require DocType |
| `m` | don't tolerate BuildMap segment mapping errors (includes `z` by default; specify `-z` to tolerate unrecognized trailing Z-segments) |
| `z` | don't tolerate unrecognized trailing Z-segments |
| `n` | enforce segment structures |
| `r` | enforce required fields being present |
| `l` | enforce field size restrictions |
| `a` | enforce field array repetition limits |
| `t` | enforce code tables |
| `b` | permit values not explicitly listed in a code table to pass when the table uses `...` |
| `u` | ignore code tables that list no permissible values |
| `y` | enforce data types |
| `p` | enforce component data structures |
| `j` | enforce optionality at the subcomponent level |
| `w` | enforce subcomponent size restrictions |
| `s` | all subcomponent-level validations. Equivalent to `pjw` |
| `g` | enforce field data structures |
| `o` | enforce optionality at the component level |
| `i` | enforce component size restrictions |
| `c` | all component-level validations. Equivalent to `gois` |
| `f` | all validations within an individual segment. Equivalent to `nrlatbuyc` |
| `e` | every available validation. Equivalent to `dmf` |
| `x` | stop at the first error (**the default**). `-x` scans the whole document and reports all errors |

Two things worth pinning down, because they are easy to get wrong:

- **`-z` means "the opposite of `z`"**, i.e. *do* tolerate unrecognized trailing Z-segments,
  which the description calls "the customary HL7 behavior". So `dm-z` is more permissive than
  `dm`, not less.
- **`Validation = 1` is exactly equivalent to `dm-z`.** The description says so, and it is
  confirmed empirically below.

### 2.2 `Lab Router`'s current setting

**There is no `Validation` row on the item.** `Lab Router` carries exactly one setting,
`Host.BusinessRuleName`. So it runs the class default, which is the `InitialExpression`
of the property:

```
Validation = "dm-z"
```

That is: require a DocType, reject segment-mapping errors, tolerate trailing Z-segments, stop
at the first error. **Validation is therefore already ON** — the injected invalid message in
§1 was rejected by the shipped configuration, with nothing armed.

A related setting worth knowing about: **`ActOnValidationError`, default `0`**. With it off,
a validation failure is logged and the message is dropped. Turning it on routes the error
through the Reply Code Actions setting instead. It was not changed during this investigation.

### 2.3 `Tools.Read.GetHostSettings` does not expose `Validation`

Confirmed — the allowlist in `GetHostSettings` is nine names (`FilePath`, `ArchivePath`,
`WorkPath`, `FileSpec`, `CallInterval`, `HTTPServer`, `HTTPPort`, `URL`, `TargetConfigNames`)
plus `PoolSize`, and `Validation` is not among them:

```json
{"host":"Lab Router","found":1,"settings":{"PoolSize":1},"settingsOnItem":1}
```

This is worth reporting but is **not** currently a gap that matters, because there is no
validation finding for an agent to investigate. If §3's proposal were ever taken up, adding
`Validation` to that allowlist would be the accompanying contract change — it is configuration
by the §2.1 definition (typed by whoever deployed the production, not derived from a message),
so it is on the permitted side of the boundary.

### 2.4 Does stricter validation produce a better-classified error? No.

Measured by running `EnsLib.HL7.Message.Validate(spec)` across flag settings, and then by
arming `dmt` on the live router.

**Same allowlisted code either way.** Whether validation is at the default `dm-z` or at
`dmt`, the log row classifies as `<Ens>ErrGeneral`, and the tools' output is identical in
shape — only `count` changes. Stricter validation produces *more* errors, not
*better-classified* ones, and it produces **no** change in what the engine or the dashboard
can see, because `Ens.MessageHeader.Status` stays `9` regardless.

One genuinely different code exists but never reaches us. A structurally incomplete message
(required segments absent) validates to **`<EnsEDI>ErrMapRequired`**, which is **not in
`Tools.ErrorCatalogue.Classify`'s allowlist** and would therefore land as **`unclassified`**. That path was
reachable only through a direct `Validate()` call in this investigation; through the router the
wrapping error is `<Ens>ErrGeneral`, so `unclassified` was not observed on the live path.

### 2.5 SECURITY: stricter validation puts message field values into the log

**This is the most important finding in §2, and it is a reason not to turn validation up.**

The field-level flags inspect field *content*, and their error text **quotes the offending
value**. Measured with distinctive synthetic sentinels planted in a test message:

| Flag | Leaks a field value into the error text? |
|---|---|
| `dm-z` (shipped) | No |
| `dmr` | No |
| `dml`, `dmf` | No — names the field position only |
| `dmy` (data types) | **Yes** — quoted the sentinel from `PID-7` |
| `dmt` (code tables) | **Yes** — quoted the value from `MSH-3` |
| `e-x` (every validation, report all) | **Yes** — quoted multiple sentinels |

Under live `dmt`, **all 38** `Lab Router` error rows carried both a quoted field value and the
message's `MSH-10` control ID (`Doc Identifier=`). `PID-7` is a date of birth and `PID-5` is a
patient name — so on a real feed, raising `Validation` to include `y` or `t` writes **patient
demographics into `Ens_Util.Log` in plain text**, in rows that `GetRecentErrors` reads.

**The boundary held.** This did not become a leak, because `Tools.Read.GetRecentErrors`
returns codes and counts and never text. Verified against the live armed state — the tool
output contains none of `EMRSYSTEM`, `Invalid value`, `Doc Identifier`, `MSG2026`,
`segment 1:MSH`, or `PID`:

```
leaks 'EMRSYSTEM'?      no
leaks 'Invalid value'?  no
leaks 'Doc Identifier'? no
```

So the allowlist-not-denylist design in `Tools.ErrorCatalogue.Classify` is doing exactly the job its comment
claims, on an error shape nobody anticipated when it was written. **The lesson is that the
design is load-bearing, not that the risk is theoretical**: any future change that returned
log text — for any error code, including a well-intentioned exception for a validation code —
would leak PHI the moment someone raised `Validation`. The class comment's warning against
"an allowlist with one exception" now has a second, sharper example behind it.

---

## 3. Trigger inventory

### 3.1 The eight finding types against trigger coverage

| Finding type | Trigger | Exposed in dashboard | Notes |
|---|---|---|---|
| `dead_host` | `DeadHost()`, `MissingFolder()` | **yes** (`missing_folder`) | disable the item, or repoint `FilePath` |
| `stalled_host` | `StalledHost()` — **arms nothing that fires** | no | documented gap, still true (§3.2) |
| `queue_buildup` | `QueueBuildup()` → `ErrorRate()`, `PoolBottleneck()` | **yes** (both) | `PoolBottleneck` is the MVP 2 scenario |
| `elevated_error_rate` | `ErrorRate()` | **yes** (`closed_port`) | closed port + fast-failure timeouts |
| `slow_processing` | `SlowProcessing()` | no | injected per-message delay via a global |
| `growing_queue_wait` | `SlowProcessing()`, `ErrorRate()`, `PoolBottleneck()` | **yes** (indirectly) | falls out of the other three |
| `throughput_drop` | `ThroughputDrop()`, and `DeadHost()`/`ErrorRate()` | no (direct) | `ThroughputDrop()` isolates it |
| `system_alert` | `SystemAlert()` | no | **outlives `Reset()`** (§3.2) |

Arming methods in `Triggers.cls`: `DeadHost`, `StalledHost`, `QueueBuildup`, `ErrorRate`,
`SlowProcessing`, `ThroughputDrop`, `SystemAlert`, `PoolBottleneck`, `MissingFolder`. Nine
methods, and `TriggerDispatcher.cls` exposes **three** — `pool_bottleneck`, `missing_folder`,
`closed_port`. `SlowProcessing` and `PoolBottleneck` take parameters, which is the stated
reason the dispatcher does not accept them; `SystemAlert` is excluded because `Reset()` cannot
undo it.

### 3.2 The two documented gaps — confirmed, not restated

Both were re-verified against the current code rather than taken on trust.

**`stalled_host` still cannot be induced.** `services/detection-engine/src/detect/rules/index.ts`
line 64 is `if (DEAD_STATUSES.includes(host.status)) return null;` — the rule declines for any
host already dead, with the comment "a dead host is reported as dead, not stalled — one
condition, one finding". Both mechanisms `Triggers.cls` has for stopping a host consuming its
queue land in that set (`Disabled` via `DeadHost()`, `Error` via `ErrorRate()`). Still true.
This is a **documented design consequence**, not a defect — the rule's precedence choice is
correct.

**`system_alert` still outlives `Reset()`.** The proxy's alert buffer is in-memory and
unbounded: `/proxy/alerts` reports `accumulatedSince` equal to the proxy's own start time and
`droppedCount: 0`, with no expiry or cap anywhere in `services/metrics-proxy/src/alerts.js`.
IRIS cannot reach a Node process on `:3001`, so `Reset()` structurally cannot clear it. Still
true. Also a **design consequence** — the fix is restarting the proxy.

Neither is a genuine gap in `Triggers.cls`. The one genuine coverage gap is `stalled_host`,
and it is a gap in the *demo*, not in the rule.

### 3.3 Promised in a spec but never built? No.

All three MVP docx specs and `docs/production-guardian-mvp3.md` were read. **No spec anywhere
mentions HL7 validation, invalid messages, malformed messages, NACKs, or a validation-failure
trigger.** The closest any spec comes to naming trigger mechanisms is MVP 1:

> "Build finding-trigger toggles (induce each of the 8 finding types on demand: kill a job,
> throttle an operation, disable a host, etc.)"

— all three of which exist. MVP 3 proposes exactly one new trigger, `MissingFolder()`, and it
is **built**:

> "`Triggers.MissingFolder()` -- proposed / stash the current `FilePath`, then point it at a
> directory that does not exist / `Reset()` restores it, by the same rule as `PortWas` / `PoolWas`"

So there is **nothing promised-but-missing**. The only shortfall against a spec is MVP 1's
"each of the 8 finding types can be induced on demand", which `iris/CLAUDE.md` §6 already
records as met for 6 of 8 with the other two stated — and that record is accurate.

### 3.4 New triggers worth having

**An invalid-HL7 / validation-failure trigger: DO NOT BUILD IT.** It passes every safety test
and fails the only test that matters.

| Criterion | Verdict |
|---|---|
| Reversible from inside IRIS? | **Yes.** `SetSetting`/`RemoveSetting` on `Validation` round-trips cleanly; absent is the shipped state |
| Survives `docker compose restart`? | **Yes** — and in the safe direction: `Production.cls` declares no `Validation` row, so a recompile reverts to *disarmed* |
| Needs a >60s wait? | **No.** Applies within one `CallInterval` (2s) after `UpdateProduction()` |
| Produces a finding type we do not demo? | **No — it produces NO finding at all** |

The last row is disqualifying. Per §1.2 the signal never reaches the engine, so the trigger
would arm a scenario that is invisible on the dashboard: a presenter would click it and nothing
would happen. That is the failure mode `PoolBottleneck()`'s comment calls out as the worst a
trigger can have — "an armed scenario that looks armed and shows nothing" — and
`SetSetting`'s comment makes the same point about a trigger that reports armed and is not.

**What would have to change first**, in order, before such a trigger is worth writing:

1. **A signal the engine can see.** Either `HostStatusDispatcher` gains a per-host count of
   validation failures from `Ens_Util.Log` (counts only — never text, per §2.5), or the router
   is configured so failures produce `Status = 8` headers. The first is additive and cheap; the
   second changes message flow and is a bigger decision.
2. **A distinguishable error code.** `<Ens>ErrGeneral` is the catch-all. A validation-specific
   token in `Tools.ErrorCatalogue.Classify`'s allowlist plus a `.Summary` row would be a
   `contracts/mcp-tools.md` §3.4a change.
3. **A rule, or a mapping onto an existing one.** This is the part MVP 3 explicitly avoided for
   its own scenario ("No new rule is needed... MVP 3 adds a scenario, not a detection type"), so
   a new detection type is **MVP 4 scope and needs its own spec** under root `CLAUDE.md` §2.
4. **`Validation` added to `GetHostSettings`'s allowlist**, so an agent could name the setting
   that caused the failures (§2.3).

That is four changes across three ownership areas and two contracts — which is the honest cost,
and the reason to write it down rather than build the trigger.

**Two other candidates**, neither built, both offered for judgement rather than as
recommendations:

- **A `stalled_host` trigger.** The one genuine coverage gap. `Triggers.cls` already documents
  what would produce it — a host that is not in `DEAD_STATUSES`, has a queue, and is not
  consuming, i.e. one parked in `Retry`. No mechanism in LABDEMO parks a host there; a retry
  loop against a closed port escalates to `Error`. Worth having (it closes the last of the
  eight), but the mechanism is unsolved, so it is research rather than a task.
- **Exposing `SlowProcessing()` and `ThroughputDrop()` through the dispatcher.** Not a new
  trigger — both exist, are reversible, and are fast. `ThroughputDrop()` takes no parameters,
  so it needs nothing new; `SlowProcessing()` would need a fixed default, which is the
  dispatcher's stated no-parameters rule and is a one-line `$case` entry. This is the
  cheapest available increase in demo coverage.

**Recommended, not done:** wiring anything into `TriggerDispatcher.cls`. That file was being
edited concurrently and was deliberately left alone.

---

## 4. What was changed

**No code.** The investigation's conclusion is that the one candidate trigger should not be
built, so `iris/labdemo/Triggers.cls` is untouched. This document is the deliverable.

The stack was left demo-ready: the `Validation` setting removed (back to the class default),
`Triggers.Reset()` run, `Ens_Util.Log` purged, and the injected test files deleted from both
the inbound and archive directories.

One thing to know when reading the evidence above: a **concurrent agent armed and re-armed the
`missing_folder` scenario twice** during this session, which is why `EMR Source` appears as
`Error` with `#5021` in some readings. Those readings are theirs, not this investigation's; the
`Lab Router` measurements are unaffected, and each is timestamped so the two can be told apart.
