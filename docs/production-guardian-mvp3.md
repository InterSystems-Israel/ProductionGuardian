# Production Guardian — MVP 3

**Draft spec, for review. Nothing here is built.**

Root `CLAUDE.md` §2 states that anything beyond MVP 2's single scenario "is MVP 3 scope and needs its
own spec before it is built." This is that spec, written first for the same reason MVP 2's was: three
modules landed because the boundary was written down before the code.

Two developers at this stage, not three. §5 splits the work and argues for the split it chooses.

---

## 1. What MVP 3 adds

Two things, deliberately small:

1. **A second scenario — the missing folder.** A business service turns red because it is configured
   to poll a directory that does not exist. AI Detective reads the log, identifies the directory as
   the cause, and **recommends a fix in words. There is no button and no automatic remediation.**
2. **Two dashboard menu items** — the brochure, and a two-slide architecture view, so an audience can
   see what sits behind the demo.

### 1.1 Why the second scenario is worth building

**It is the first finding with no governed action**, and that is the point rather than a limitation.
MVP 2 proved WHAT → WHY → FIX on a problem whose fix happened to be a bounded configuration change.
This scenario proves the product is honest when the fix is *not* something it may do: the diagnosis
is just as specific, and the response is "here is what a human should do" rather than a disabled
button or a fabricated action.

That distinction is currently untested. `resolve-api.md` and the Smart Resolve panel exist because
one action was whitelisted; nothing has yet exercised the path where the correct answer is **no
action at all**.

**It is also a real failure, already recorded in this repository.** From
`iris/setup/FirstBoot.cls`, describing the #34/#53 deploy:

> the two HL7 drop directories did not exist, so EMR Source went straight to Error with
> `#5021: Directory '/tmp/labdemo/hl7-archive/' does not exist`

So the scenario is not invented for a demo — it is the first thing that broke when this production
was stood up on a second machine, and it is the reason `FirstBoot.MakeDirectories()` exists. An
audience of Health Connect operators will recognise it.

### 1.2 What is out of scope for MVP 3

- **Any automatic remediation of the folder.** No `create_directory` tool, no write path, no button.
  Creating directories on a live host is a different risk class from changing a pool size within a
  bounded range, and it is not what this scenario is for.
- **A general action catalogue.** `set_pool_size` on `Cloud API` within `2..8` remains the only
  action MVP 2 shipped, and MVP 3 adds none.
- **The five remaining modules** — Health Score, Health Summary, Performance Coach, Ask Guardian
  (root `CLAUDE.md` §2.2). Still out.
- **Making the four MVP 2 contracts machine-readable.** Recorded as outstanding in
  `contracts/CHANGELOG.md` (2026-08-20). It is a prerequisite *decision* for MVP 3 (§6), not MVP 3
  work.

---

## 2. Scenario 2 — the missing folder

### 2.1 The shape

| Stage | What happens |
|---|---|
| **Arm** | `EMR Source`'s `FilePath` is pointed at a directory that does not exist |
| **Detect** | The host goes to `Error`; Health Scan raises `dead_host` on `EMR Source` |
| **WHY** | AI Detective reads the error log, sees `#5021`, reads the host's configured path, and states that the configured inbound directory does not exist |
| **No FIX** | `recommendedAction` is `null`. The panel shows a worded recommendation and **no approve control** |
| **Reset** | `Triggers.Reset()` restores the original `FilePath`; the host returns to `OK` |

### 2.2 Arm it by repointing the setting, not by deleting the directory

**Deleting `/tmp/labdemo/hl7-in/` would work and is the wrong mechanism.** Three reasons, and the
third is the one that matters:

1. The generator writes into that directory, so deleting it breaks inbound traffic in a second way
   and the finding stops being about one cause.
2. `FirstBoot.MakeDirectories()` recreates it on every boot, so an armed demo would silently disarm
   itself on restart.
3. **It is not reversible from inside IRIS.** Every other toggle in `Triggers.cls` stashes what it
   replaced and restores it in `Reset()` — the `PortWas` pattern from `ErrorRate()`, the `PoolWas`
   pattern from `PoolBottleneck()`. A trigger that deletes a filesystem directory cannot honour that
   contract, and `Reset()` would have to create a directory it never owned.

So the trigger repoints the *setting*:

```objectscript
// Triggers.MissingFolder() -- proposed
//   stash the current FilePath, then point it at a directory that does not exist
//   Reset() restores it, by the same rule as PortWas / PoolWas
```

`Triggers.cls` already has `GetSetting`, `SetSetting` and `SetEnabled`, so this needs no new
mechanism — it is the `ErrorRate()` shape with a path instead of a port.

**Verified precondition:** `EMR Source` is an `EnsLib.HL7.Service.FileService` with
`FilePath = /tmp/labdemo/hl7-in/` and `ArchivePath = /tmp/labdemo/hl7-archive/`
(`iris/labdemo/Production.cls`). Either is a candidate; `FilePath` is the clearer story because it is
the directory the service *polls*, so "it cannot see its inbound folder" needs no further explanation.

### 2.3 Which finding fires, and which deliberately does not

`Error` is in `DEAD_STATUSES` (`services/detection-engine/src/types/healthscan.ts`), so:

- **`dead_host` fires.** Confirmed by reading the rule: it returns early unless the status is in that
  set.
- **`stalled_host` does not**, because it declines for any host already in `DEAD_STATUSES` — one
  condition, one finding. This is the same precedence that made `stalled_host` un-inducible in
  `iris/CLAUDE.md` §6, and here it is working as intended rather than as a gap.

**No new rule is needed.** MVP 3 adds a scenario, not a detection type. That is worth stating because
"a new scenario" usually implies a new rule, and this one deliberately reuses `dead_host`.

### 2.4 The investigation needs one thing it cannot currently get

This is the substantive design problem, and it is a consequence of a rule we should not relax.

`get_recent_errors` **never returns log text, by design**. `Tools.Read.ClassifyError` extracts an
allowlisted token and nothing else, because `Ens_Util.Log` on this instance holds 61,772 rows
carrying `PatientID` in plain text (`docs/mvp2-aihub-verified-api.md`). `#5021` *is* in that
allowlist, so the agent can learn that a `#5021` occurred.

**But `#5021`'s message is where the directory name lives**, and the agent must not see the message.
So on its own the agent can say "a configured directory does not exist" and cannot say *which*.

Two pieces close that without weakening the boundary, and **both are configuration or catalogue data,
never log content**:

**(a) `summary`, and the response shape it has nowhere to live in.** This started as "the contract
specifies `summary` and the code does not emit it." It is larger than that — the two response shapes
differ **in kind**, not by one field (@Ari-Glikman, #112 review). Verified field by field:

| | `mcp-tools.md` §3.4 | `Tools/Read.cls` (`GetRecentErrors`) |
|---|---|---|
| window | `windowMinutes` | `sinceMinutes` — **renamed** |
| `truncated` | present | absent |
| array | `errors[]` of `{occurredAt, errorCode, sourceClass, summary}` | `byCode[]` of `{errorCode, count}` |

The contract describes **per-error rows with timestamps and a catalogue string**; the implementation
returns **an aggregated histogram**. The `errors[]` array does not exist at all. An agent written
against the contract looks for occurrences and finds counts.

**Resolved in #116, and not the way this section first argued.** An earlier draft claimed the shape
change was mandatory — that `summary` is a property of an error *occurrence* rather than of a *code
count*, so implementing it meant implementing `errors[]`. **That was wrong.** `summary` is "a catalogue
string keyed by `errorCode`", and keyed by `errorCode` makes it a property of **the code** — which is
exactly what a `byCode` entry is keyed on. It fits there as `{errorCode, count, summary}`.

The error mattered because it pointed at the less safe design. Per-event rows are the shape that
*invites an agent to reason about individual occurrences*, and the row it would want to quote is the
one that may carry PHI (@Ari-Glikman, #116). So aggregation is not a concession to the implementation —
it is the shape the data boundary wants, and the contract was corrected toward it.

**The resolution:** the implementation's `byCode` aggregation is kept and the contract corrected to it,
`summary` is added to each entry from a catalogue keyed by `errorCode`, and `windowMinutes`,
`occurredAt`, `sourceClass`, `limit` and `truncated` are dropped — none is emitted, none is needed, and
`limit`/`truncated` bounded a list that no longer exists.

This is a **pre-existing divergence** — the fifth to reach `main` in a shape no schema covered, after
the three in `contracts/CHANGELOG.md` (2026-08-20) and the one fixed in #111. Closing it is not MVP 3
scope creep; it is what this scenario happens to walk into first. `#5021 → "a configured directory or
file path does not exist"` is exactly the catalogue entry needed.

**It is also the strongest available argument for §6's question 3.** Four of the five were findable
only by reading two documents side by side, and the one in #111 took four readings of the same line.
Schemas for these four contracts turn all five into validation failures instead of archaeology.

**(b) The host's configured paths.** No current tool returns them: `get_host_status` gives status and
enabled, `get_pool_size` gives `PoolSize`. A new read tool — `get_host_settings(host)`, returning the
adapter settings for a host — lets the agent name the directory from *configuration*, which the data
boundary explicitly permits ("metrics and configuration only").

Combining the two, the agent can conclude: *`EMR Source` is in Error; a `#5021` was logged, which is
a missing configured path; its `FilePath` is `/tmp/labdemo/does-not-exist/`* — a specific diagnosis
built entirely from config and a catalogue, with no log text crossing the boundary.

**A tempting shortcut to refuse:** returning the `#5021` message text "just for this code". The
allowlist exists because a rule with an exception is one an implementer widens, and `#5021`'s message
contains a path that is *usually* harmless — which is precisely the "rare rather than absent" shape
that survives review and then leaks. `summary` plus configuration gets the same answer with none of
that.

### 2.5 The contract change: a recommendation that is not an action

`investigation-api.md` already supports a non-actionable investigation — `recommendedAction` may be
`null`, "when the agent recommended nothing", and §3.3 tells consumers to "render *no recommended
action*". So the **absence** of a fix is already expressible and the dashboard already has a defined
state for it.

**What is not expressible is a recommendation in words.** §3.3 is explicit that `recommendedAction` is
"a structured object, never prose", with good reasoning: it is the input to Smart Resolve, a human
approves it, and Dev C must not build a translation layer.

That reasoning should survive intact. So MVP 3 needs **one additive, nullable field** — working name
`manualRemediation` (string \| null) — carrying the human-readable step for a finding with no
governed action.

| Field | Meaning | Applicable by a button? |
|---|---|---|
| `recommendedAction` | structured, machine-consumable, input to Smart Resolve | yes |
| `manualRemediation` | prose, for a human to act on outside the product | **never** |

Keeping them separate is the whole point. **The two states are not "a fix with a button" and "a fix
without one" — they are "we may act" and "we may not", which is a claim about authority rather than
about UI** (@Ari-Glikman, #112 review). Encoding a claim about authority as two *shapes* means a
consumer cannot render an approve control for the second by accident.

**Which is why this must not be a flag on one object.** The obvious cheaper design — keep
`recommendedAction` and add `applyable: false` — fails by omission: the defect is someone forgetting
to check a boolean, and the result is an approve button on an action the product has no authority to
take. A field that does not exist cannot be forgotten. That is the same reasoning as
`Tools.Resolve`'s allow-list of one: fail closed by construction rather than by remembering.

It also leaves §3.3's "structured object, never prose" intact for the field that *is* applyable, which
is the one where it matters for safety.

**Subject to the data boundary like everything else** — it names configuration and an operator action,
never message content. And it is additive and nullable, so no MVP 2 consumer changes.

### 2.6 Acceptance

| Criterion | How it is checked |
|---|---|
| The scenario arms and disarms | `Triggers.MissingFolder()` then `Status()`, then `Reset()` restores the original `FilePath` and the host returns to `OK` |
| `dead_host` fires on `EMR Source` | the finding appears in `/api/healthscan/findings` |
| The agent names the directory | investigation `rootCause` contains the configured path, with `evidence[].source = mcp_tool` |
| No log text crosses the boundary | the investigation contains no `Ens_Util.Log` message text; evidence is config values and `summary` strings |
| **No approve control is rendered** | **Observed on screen, not asserted:** with a `manualRemediation` finding open, the drawer shows the recommendation text and **no Preview and no Approve control** |
| It is a live agent, not canned | #108's standing check: `source: agent`, non-null `model`, `toolCalls > 0` |

**The fifth row is stated as an observation deliberately, and it is the most important row in this
table.** A missing negative is invisible: a panel that renders an approve button for a null
`recommendedAction` looks entirely fine until someone clicks it, and a test suite only catches it if
somebody remembered to write the negative case.

@Ari-Glikman's #112 review is the evidence, and it is worth quoting because it is three occurrences in
one week rather than a hypothetical:

- Early Warning rendered nothing for `already_crossed`, so the module looked unbuilt
- the WHY and FIX endpoints worked for two days behind a UI that never called them
- the provider provisioned correctly and was never reached, because compose did not pass the variable

**Each time the checks passed and the absence was the defect.** So this criterion is phrased as
something a person confirms by looking, in five seconds, before a demo — with a test as reinforcement
rather than as the primary evidence. Where a test exists it should assert the *absence* of the control
for a null `recommendedAction`, which is the case nobody writes unprompted.

---

## 3. Dashboard — two menu items

Both are read-only views of material that already exists in `docs/`. Neither touches the findings
API, the engine, or IRIS.

`AppShell.tsx` already has a nav rail (`pg-rail`) and a header actions region, so there is somewhere
for these to live without new layout.

### 3.1 Brochure

`docs/Brochure.png` (1.7 MB) rendered in a view or overlay.

**It must be served, not imported.** 1.7 MB inlined into the bundle would show up in the dashboard's
build and first paint; it belongs as a static asset fetched on demand, and the menu item should not
be the reason the dashboard gets slower to load.

`docs/` is read-only source material (root `CLAUDE.md` §3), so the asset is **copied into the
dashboard's public assets at build time, not edited in place** — and the copy needs a note saying
where the original lives, or it becomes the stale second copy #84 is about.

### 3.2 Architecture — two slides

| Slide | Audience question it answers |
|---|---|
| **1 — general** | What are the pieces and how does data flow? Five services, IRIS → proxy → engine → dashboard, plus AI Hub inside IRIS |
| **2 — detailed** | How does one investigation actually work? The MCP tool calls, the authorization policy, the audit row, and where the LLM sits |

**These do not exist yet and have to be authored.** `docs/production-guardian-deck.pptx` is the
existing deck and `docs/production-guardian-demo.html` is the scripted concept demo — neither is an
architecture diagram of what was built.

Recommended form: **two SVGs, or one component per slide**, rather than exported images — because the
architecture will keep changing and an exported PNG is a copy that goes stale, which is #84 again.
The five-service topology, the port numbers and the tool names all already exist in
`docker-compose.yml`, root `CLAUDE.md` §5 and `contracts/mcp-tools.md`; a diagram that restates them
is a second copy, so it should be sparse and point at those as the authority.

**Content for slide 2 is mostly written already** — `docs/mvp2-aihub-verified-api.md` documents the
enforcement path, and `iris/CLAUDE.md` §7 documents the governance seam. The slide is a picture of
those, not new research.

---

## 4. What this does not change

- **No new detection rule** — reuses `dead_host` (§2.3).
- **No new governed action, no new write path, no new RBAC resource or role.** `Tools.Resolve` is
  untouched, and `PG_Resolve` still gates exactly one tool.
- **`resolve-api.md` is unchanged.** This scenario never reaches Smart Resolve.
- **The audit trail is unchanged in shape** — the new read tool is audited by the same runtime path
  as the other five, and `Audit.Entry` needs no new column.

---

## 5. Work split — two developers

**My recommendation: do not split the scenario. Split scenario from dashboard.**

The scenario looks like it wants splitting along the IRIS/engine boundary, the way MVP 2 was split.
It does not, and the reason is that **this scenario has no write path**. MVP 2's split earned its
keep because the governed action needed a contract negotiated between the side that could write and
the side that asked — approval, bounds, audit, RBAC. Here there is nothing to negotiate: the IRIS
side gains two read capabilities, and the engine side consumes them.

Cutting a feature that thin in half creates a contract conversation, a mock, and two review cycles
for something one person can carry end to end — and MVP 2's own retrospective says the expensive
defects were at the *seams* (`/labdemo/agent` unregistered, the compose variable not passed, a guard
whose comment lied). Adding a seam to save effort is the wrong trade.

### Track A — the scenario, end to end (one developer)

| Task | Area | Notes |
|---|---|---|
| `Triggers.MissingFolder()` + `Reset()` restore | `iris/**` | `ErrorRate()`'s stash-and-restore shape (§2.2) |
| `get_recent_errors`: emit `summary`, `occurredAt`, `sourceClass` | `iris/**` | closes an existing contract divergence (§2.4a) |
| `#5021` catalogue entry | `iris/**` | the string that names the fault class |
| New read tool `get_host_settings` | `iris/**` | + `mcp-tools.md` change |
| `manualRemediation` field | `contracts/` + engine + dashboard | additive, nullable (§2.5) |
| Panel state: recommendation with **no** approve control | `apps/dashboard/**` | the negative is the acceptance criterion |

Crosses `iris/**`, the engine and the dashboard — which is only tolerable because each piece is
small and there is no write path anywhere in it.

### Track B — the two menu items and the architecture slides (the other developer)

| Task | Area |
|---|---|
| Brochure view, asset served not bundled | `apps/dashboard/**` |
| Architecture slides 1 and 2, authored as SVG/components | `apps/dashboard/**` + `docs/` |
| Nav entries in `AppShell` | `apps/dashboard/**` |

Fully independent of Track A — no shared files beyond `AppShell.tsx` and the stylesheet, and no
contract between them.

### The ownership problem this created — resolved in #113

Both tracks touch `apps/dashboard/**`, which root `CLAUDE.md` §3 assigned to Dev C — **and there was no
Dev C at this stage**, so MVP 3's dashboard work had no owner. That table needed amending before either
track started, exactly as §2 needed amending before MVP 2 (#85).

**Resolved: the whole directory goes to Dev B, not split by file.** Splitting it between two people
would create exactly the seam this section argues against. So Track B *and* Track A's panel change both
belong to whoever owns `apps/dashboard/**`, and Track A's owner stops at the contract — making the split
**scenario back-end and contract** / **everything the audience sees**.

#113 also corrected a second wrong row nobody had noticed: `iris/**` and `services/metrics-proxy/**`
read "Dev B (was Dev A)", the reverse of the truth, contradicted by `iris/CLAUDE.md`, by MVP 2 §5.2 and
by the commit history. Worth recording here because it is the same failure mode as §2.4's contract
divergences — **a document that nobody follows, in the one place a newcomer would look to settle a
dispute.**

---

## 6. Decisions — all four taken, 2026-08-20

| # | Decision | Outcome | Where it lands |
|---|---|---|---|
| 1 | Who owns `apps/dashboard/**` with two developers | **Dev B, the whole directory** — not split by file | #113 |
| 2 | `manualRemediation`, or overload `rootCause` | **New field** | §2.5, and §6.1 below |
| 3 | Do the four MVP 2 contracts get schemas first | **Yes, before the `manualRemediation` change** | §6.1 below |
| 4 | #100, the `reversal` self-contradiction | **Settled** — reversal is a record, not a request; `2..8` at both layers | #114 |

Decisions 2 and 3 were taken by the project owner after both developers recommended them; 1 and 4 are
implemented in the PRs named. **Nothing in MVP 3 is built yet.**

### 6.1 Decision 3 reorders the work

This is the one consequence worth stating explicitly, because it changes sequence rather than content:
**schemas for the four MVP 2 contracts land before `manualRemediation` is added to one of them.**

Adding a fifth field-level change to a prose-only document is what decision 3 exists to stop. Five
divergences have now reached `main` in shapes no schema covered:

| Divergence | Kind | Closed by |
|---|---|---|
| `refusal` field names — `{code, detail}` vs `{reason, message, checkedBy}` | shape | #99 |
| `reversal` shape — `{action, capturedFrom, automatic}` vs flat | shape | #114 |
| `reversal.capturedFrom` — `"live production"` vs `"live"` | **value** | #111 |
| `get_recent_errors` — `errors[]` vs `byCode[]`, and `windowMinutes` vs `sinceMinutes` | shape + name | #116 |
| `set_pool_size` bound — `1..8` ratified, `2..8` shipped | value | #114 |

**Four of the five were findable only by reading two documents side by side**, and the `capturedFrom`
one took four readings of the same line by the person who had just written about it. That is not
inattention; it is what prose review cannot do. A schema with an `enum` catches the value drifts and a
`required`/`additionalProperties` pair catches the shape drifts, at validation time, without anyone
remembering to look.

So the order is:

1. Schemas and captured samples for the four MVP 2 contracts — which also closes the
   `get_recent_errors` divergence, since that one has to be settled to be written down
2. `manualRemediation` added to `investigation-api.md` **and its schema together**
3. Track A and Track B (§5)

`services/detection-engine/test/mvp2-contract-drift.test.ts` — the prose grep — is **replaced** by
this, not extended. Its own header asks for that, and a prose grep cannot see a wrong value in a
correctly-named field, which is exactly the class the schema is for.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| An approve button renders for a null `recommendedAction` | Medium | High | §2.6 states the criterion as an **on-screen observation**, with a test asserting the *absence* of the control as reinforcement. Three defects in one week were exactly this shape — the checks passed and the absence was the defect |
| Pressure to add "just create the folder" as an action | Medium | High | §1.2. Creating directories is a different risk class from a bounded pool change; MVP 3's value is a specific diagnosis with an honest refusal to act |
| The `#5021` message text gets returned "just for this code" | Medium | Critical | §2.4. The allowlist exists because an exception is a rule an implementer widens; `summary` + configuration reaches the same answer |
| The architecture slides go stale | High | Medium | Author as SVG/components that restate as little as possible and point at `docker-compose.yml` and `mcp-tools.md` as the authority (#84) |
| The brochure inflates the dashboard bundle | Medium | Low | Serve as a static asset, not an import (§3.1) |
| Two developers, three areas | Medium | Medium | §5's split, and amend the ownership table first |

---

## 8. Recommendation

**Minimum viable MVP 3:** the missing-folder scenario end to end — armed by a trigger, detected as
`dead_host`, diagnosed by a live agent naming the directory from configuration and a catalogue,
presented with a worded recommendation and **no button** — plus the brochure and the two architecture
slides.

**First milestone:** all four §6 decisions taken — done, 2026-08-20 — then **schemas and captured
samples for the four MVP 2 contracts** (§6.1), then `manualRemediation` added to
`investigation-api.md` together with its schema, then `Triggers.MissingFolder()` arming and resetting
cleanly. Everything after that runs in parallel on two tracks.

The schemas come first by decision 3, and that is a deliberate delay rather than an oversight: MVP 3
adds the fifth field-level change to documents that have already leaked four, and the cheapest moment
to make them machine-readable is before the fifth rather than after it.

**What would make this a bad MVP 3:** adding a second governed action. The reason to build this
scenario is that it is the first one the product cannot fix, and that is the honest half of an
AI-operations story — a tool that only shows you problems it can solve is a tool that has not been
tested against a real production.
