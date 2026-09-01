# Contract changelog

Every contract change, dated, with the reason. Newest first.

---

## 2026-09-01 — `ResolveRequest`: the request half of `POST /api/resolve` is checkable, and §1.1 turns out to require three things nothing sends

**One new definition, one new captured sample, one existing sample corrected.** No response shape changed.

The entry below added a pass that validates the JSON fences in the prose. It left the four **request**
payloads in `resolve-api.md` unannotated for a stated reason: no request schema existed to name. This
closes that, and it is the follow-up that entry named.

### What landed

| File | What changed |
|---|---|
| `resolve.schema.json` | new `ResolveRequest` definition; `title` and top-level `description` corrected |
| `samples/resolve-request.json` | **new** — a live, §1.1-complete `apply` |
| `samples/resolve-refusal.json` | `requestId: null` → `"rq-contracts-capture-01"`, re-captured as a matched pair |
| `resolve-api.md` | the four request fences annotated (§1.1, §11.1, §11.2, §11.4) |
| `validate.mjs` | 1 sample, 3 accepts, 8 rejects |

`action` is the **same cross-schema `$ref`** the response already uses —
`investigation.schema.json#/definitions/ResolveAction`. §1.2's rule is that `action` is a field-for-field
copy of the investigation's structured `recommendedAction`, transcribed and never parsed. One definition
for what the agent recommends, what the caller approves, and what the server reports applying is how that
rule gets enforced instead of asserted three times.

### The title said "the request half is already covered". It wasn't

The original `description` on this schema read *"The request half is already covered:
`investigation.schema.json#/definitions/ResolveAction` is the `action` object and `validate.mjs` carries
must-reject cases for it."* True of `action`, and of nothing else in §1.1 — `mode`, `requestId`, `origin`,
`precondition`, `requestedBy` were all uncovered. Corrected in place, and recorded here because it is a
good specimen: a partial check reading as a complete one is the failure mode this whole directory's
process exists to prevent, and it happened in the sentence describing the check.

### §1.1's asymmetry is now enforced in both directions

> Unknown top-level fields are **ignored**, not rejected. Unknown fields *inside* `action` are
> **refused** (`malformed_request`).

So `ResolveRequest` is `additionalProperties: true` at the root and inherits `false` inside `action`. That
looks like an oversight, so there is a **must-accept** case for an unknown top-level key
(`approvedInTabId`) alongside the must-reject for an unknown key inside `action`. Without the accept case,
someone tightens the root in good faith and breaks a caller §1.1 promised would work.

### It found the requirement nothing enforces → #222

§1.1 marks `requestId`, `origin` and `origin.findingId` required **for `apply`**. `parseResolveRequest()`
enforces none of the three, and `apps/dashboard/src/api/liveClient.ts:230` sends
`{mode, action, origin, requestedBy}` — **no `requestId`, from any call site in the repo**.

So the replay key #220 needs a store for is not being sent either. That is both halves of §6 mechanism 3
missing, and §6's own sentence is the cost: *"One approval, one audit event."*

The schema encodes **§1.1, not the parser** — a request schema constrains callers, so a lenient server is
permissive rather than divergent, and encoding the leniency would have deleted the requirement instead of
recording that it is unenforced:

```json
"allOf": [{
  "if":   { "properties": { "mode": { "const": "apply" } }, "required": ["mode"] },
  "then": { "required": ["requestId", "origin"],
            "properties": { "origin": { "required": ["findingId"] } } }
}]
```

Three of the eight must-reject cases hold exactly that. **#222** carries the fix, its ordering (the
dashboard has to send a `requestId` before the parser may demand one, or the shipped Approve button
breaks), and why it is blocked on #220's A/B decision rather than started.

### One sample corrected, one knowingly left wrong

All three captured responses carried `requestId: null`, **two of them on an `apply`** — so the samples
collectively taught the opposite of what §1.1 requires, and a consumer mocking against them would build a
UI handling a state the contract says cannot occur. That is the same defect the "Why the samples matter"
section names about a laundered `requestedBy`, pointing the other way.

- `samples/resolve-refusal.json` was **re-captured from a §1.1-compliant request**, and
  `samples/resolve-request.json` is that request. `size: 9` is refused by the governed tool before any
  write, so the pair cost one audit row and moved nothing. Only `requestId` differs from the previous
  bytes; ids and timestamps stay pinned to the same values, so the diff is one line.
- `samples/resolve-response.json` — the `applied` capture — is **still a non-compliant apply** with
  `requestId: null`. Re-capturing it needs a real `set_pool_size` write plus a revert through
  `Triggers.SetPoolSize` (the governed tool's `2..8` bound cannot restore `PoolSize 1`), and a live
  production write to fix a sample is the wrong trade. Left as-is, recorded in #222 step 3, to be done
  when a live apply is happening anyway.

### Consumers

**None.** The dashboard's request already satisfies everything except `requestId`, and nothing validates
its outgoing body against this schema — `ResolveRequest` is enforced over `samples/` and the prose, not in
the request path. The one behaviour change this implies is #222's, and #222 is filed rather than started.

`cd contracts && npm run validate` now reports `7 samples, 19 accept, 40 reject, 7 capture claims, 18
prose fences`, with `resolve-api.md` at `8 annotated, 7 unannotated`.

The 7 that remain there are not annotatable and are not meant to be: five are single-key fragments
(`"reversal": {...}`, `"refusal": {...}`, `"failure": {...}`, `"confirmation": {...}`, `"audit": {...}`)
which are not JSON documents at all, and two are deliberately partial response objects showing "the
load-bearing parts". Wrapping them in braces to make a linter reach them would change how the document
reads to serve the tool.

---

## 2026-09-01 — the JSON payloads *inside* the contract prose are validated now, and the first run found two more divergences

**No shape changes to any schema except one optional field, and that field is a bug report.** `samples/`
was the only thing `validate.mjs` checked. The divergences kept turning up somewhere else: all three §8
payloads in `investigation-api.md` were schema-invalid for twelve days (#201), five more shipped in
`resolve-api.md` (#202). A fenced payload in a ratified contract is a published artefact — a consumer
mocks against it exactly as they mock against `samples/` — and nothing could disagree with it. #205.

### The convention

The annotation rides in the CommonMark info string, after the language:

````
```json validate=resolve.schema.json#/definitions/ResolveResponse
````

GitHub renders the block as `json` regardless, so nothing about how these files read changes. Ten
payloads across four files are annotated today:

| File | Annotated | Unannotated |
|---|---|---|
| `healthscan-api.md` | 2 | 0 |
| `proxy-api.md` | 3 | 0 |
| `investigation-api.md` | 5 | 4 |
| `earlywarning-api.md` | **0** | 3 |
| `resolve-api.md` | 4 | 11 |

**Opt-in, and the counts are the price of that.** Most fences in these files are deliberately not whole
documents — a bare `"reversal": {...}` fragment, a request body for an endpoint whose request has no
schema, an `{"error": "..."}` shape — and requiring `validate=none` on each would add noise to five
files to catch a mistake in one. But an unannotated fence is invisible, which is the hole this exists to
close, so every run prints both counts per file and a file that drops to `0 annotated` says so.

`earlywarning-api.md` is that zero, permanently until someone acts: it is the last MVP 2 endpoint with
no schema, so there is nothing for an annotation to name. Filed as **#219**. It is listed in
`CONTRACT_MD` rather than omitted precisely so the gap prints.

`mcp-tools.md` is deliberately out, and not for lack of a schema — so does earlywarning. It documents
MCP tool returns, a different protocol through a different boundary, and thirteen sections of
unannotated fences would bury the one conspicuous zero the table exists to show. Its divergences are
real and measured (#218), and the fix there is a schema for the tool returns.

**A malformed annotation fails rather than skips.** An unknown schema file, an unknown definition name,
a shape that isn't `<schema.json>#/definitions/<Definition>`, or unparseable JSON — all `fail`. The
whole point is that an unchecked payload must not be able to look checked, and a typo in a definition
name is the cheapest way for one to.

### It found two divergences on its first real run

All four `ResolveResponse` payloads in `resolve-api.md` failed, on `additionalProperties`, for two
independent reasons:

- **`replayed`** — §1.3's field table types it as a plain required `boolean`, §6 builds a whole replay
  contract on it, and §11's R5 cites it as one of three mechanisms answering "what happens if I click
  Approve twice?". **Nothing emits it.** `resolve.ts` accepts and echoes `requestId` and has no store,
  no window, and no `replayed`; it does not even require `requestId` on an `apply`, so §7's
  `malformed_request` row for that does not fire either. So mechanism 3 of three does not exist — the
  double-click is harmless (mechanisms 1 and 2 are real) but mints a second audit row for one human
  decision, on the screen the demo ends on. It is now **permitted and not required** in
  `resolve.schema.json`, with the reasoning on the field: requiring it would fail the shipped path,
  dropping it would fail the ratified contract. That is an unimplemented feature rather than a shape
  question, filed as **#220** with the A/B decision stated and deliberately not taken.
- **`before.readAt` / `after.readAt`** — present in five prose payloads, absent from §1.3's field table,
  absent from `resolve.ts`, absent from all three captures. **Removed from the prose** as unratified
  cruft: `PoolShape` is `{poolSize}` and nothing else, in the schema and in the code. Recorded here
  rather than only in a diff because there is a second reading worth reconsidering deliberately — that
  `readAt` documents *when* the pool size was read, which is the timestamp an optimistic-concurrency
  story around `precondition.poolSize` would want. If that is the intent, it comes back as a field
  table row and a schema property, not as a payload key nobody declared.

Both were invisible for as long as the payloads existed. That is the argument for the whole pass, and
it is #84's argument applied to a fenced block rather than to a copied number.

### Consumers

None. No schema loosened, no field required, no sample changed. The four `resolve-api.md` payloads a
consumer might have mocked against are now *closer* to the shipped shape by five keys. The engine and
the dashboard are unaffected.

`cd contracts && npm run validate` now reports `6 samples, 16 accept, 32 reject, 7 capture claims,
14 prose fences`.

---

## 2026-09-01 — `resolve.schema.json` + three captured samples: Smart Resolve is machine-checked for the first time

**No shape changes. This adds the missing artefact, not a new field.** `POST /api/resolve` was the
only MVP 2 endpoint nothing validated — the reason five field-level divergences between
`resolve-api.md` and the shipped path had to be found by reading the two side by side (#202) rather
than by CI. Every other contract here has a schema and a captured sample; this one had prose, and
prose does not fail when it stops being true.

### What landed

| File | What it is |
|---|---|
| `resolve.schema.json` | draft-07, `ResolveResponse` plus `PoolShape` / `Reversal` / `Refusal` / `Failure` / `Confirmation` / `Audit`. `additionalProperties: false` throughout |
| `samples/resolve-response.json` | a live `apply` that moved `Cloud API` 1 → 4 |
| `samples/resolve-preview.json` | a live `dry_run` |
| `samples/resolve-refusal.json` | a live `refused` / `out_of_bounds` |
| `validate.mjs` | 3 samples, 1 accept, 6 must-reject cases wired in |

`action` is a cross-schema `$ref` into `investigation.schema.json#/definitions/ResolveAction` rather
than a second transcription of it, so the object a consumer approves and the object the server reports
applying cannot drift apart. `ajv.addSchema` order matters for that and is commented where it matters.

### Three samples, not one, and all three are captures

The shape is outcome-dependent: `confirmation` is an object only on `applied`, `refusal` only on
`refused`, and `before` / `after` / `reversal` are all null on a refusal. One sample would leave both
branches a consumer actually has to handle uncovered.

All three come from `POST http://localhost:3002/api/resolve` against the live stack, with only
`resolveId`, `auditId` and the timestamps pinned — the rule `investigation-response.json` established:
a hand-written sample proves the schema accepts what its author imagined, a captured one proves it
accepts what the system emits.

Two details in them are deliberate rather than sloppy:

- **`requestedBy` is left as the capture's own label** (`"contracts/resolve.schema.json capture"`)
  rather than rewritten to `dashboard`. That is §8's point about the field made visible: it is
  advisory, caller-supplied, and recorded **next to** the server-resolved `actor`, not in place of it.
  A sample that laundered it into a plausible value would teach the opposite.
- **`role: "%All"` in all three is not a placeholder, it is #104.** The dedicated RBAC role that
  root `CLAUDE.md` §2.1 lists as part of the scope boundary is not the role the demo instance
  actually runs as, and a sample is where that is hardest to keep quiet.

The preview and the refusal mutate nothing. The `applied` capture did move `Cloud API` from PoolSize 1
to 4 on the demo instance, and it was restored to 1 afterwards — **not** through `/api/resolve`, which
bounds at `2..8` and refuses 1 as `out_of_bounds`, but through `Triggers.SetPoolSize`.

### The six rejections are safety properties, not type errors

Four are defects that reached `main` or shapes the schema exists to forbid:

- **`confirmation` on anything that did not apply** — a preview and a `no_change`. The panel renders
  "will clear within N seconds" from `confirmation !== null && !directEvidence`, so a response that
  wrote nothing while carrying a `confirmation` promises a clearance for a write that never happened.
  Expressed as an `if/then`: `outcome !== "applied"` ⇒ `confirmation: null`.
- **`mode: "dry_run"` with `outcome: "applied"`** — the preview wrote. The second `if/then`.
- **`audit` absent** — the 2026-08-19 defect, where every response claimed §8 compliance while
  carrying no attribution at all.
- **`refusal` as `{code, detail}`** — the field-name drift caught by a human in review on #92 rather
  than by a test, which is the whole argument for this entry existing.
- **an undocumented top-level field** — why `additionalProperties: false` is on every object here.

The valid base those five mutate is itself asserted valid, because a base the schema already refused
would make all six pass while testing nothing.

### Deliberately permissive at exactly two points

**`resolve-api.md` §4 (`after` on a preview) and §5 (`confirmation.directEvidence` / `clearsWhen`) are
open decisions on #202.** This schema is permissive at exactly those two points **and says so on the
fields** — `TIGHTEN THIS ONCE §5 IS DECIDED` is in the `description`, where a reader of the schema will
find it. So it holds the decided shape without quietly settling the undecided one, which is what
"write the schema first" would otherwise do: whichever form the capture happened to have would become
the contract by accident, and the decision would be made by a sample rather than by a person.

`refusal.reason` is a `string` and **not** an enum for the same class of reason, spelled out in
`resolve.ts`: an unrecognised refusal reason must still reach the UI. A schema that rejected a new
reason would turn "the tool refused for a reason we have not seen" into "the response is malformed".

### Consumers

None change. `resolve-api.md`'s header is updated — it said "no machine-readable artefact yet" — and
**where that document and the schema disagree about a shape the schema constrains, the schema now
wins**, the same reversal `investigation-api.md` made after #201. `contracts/README.md` gains the rows.
`resolve.d.ts` is still genuinely absent, as `investigation.d.ts` is; the engine
(`src/detect/resolve.ts`) and the dashboard (`src/types/mvp2.ts`) each keep their own transcription.

---

## 2026-09-01 — `investigation-api.md` §2.4: the scope gate now exists, keyed on type, and refuses `system_alert` separately

**A behaviour change, not a wording one, and it closes the hole the entry below filed as #206.**
`POST /api/investigate` previously accepted **any** finding on **any** host — including a
`system_alert`, whose `message` is text IRIS wrote into `alerts.log` and which an alert about a failed
send can use to name the message it failed to send. That string was forwarded verbatim to an external
LLM. Root `CLAUDE.md` §2.1 makes that a rule rather than a preference: metrics and configuration leave
the instance, never message content.

### What changed on the wire

| | Accepted |
|---|---|
| §2.4, until today | `type === 'queue_buildup'` **and** `host === 'Cloud API'` — asserted in three places in prose, enforced in none |
| §2.4, now | `type` is `queue_buildup` **or** `dead_host`. No host check. `system_alert` refused by a separate rule checked first |

Everything else is `200` + `state: "unavailable"` + `source: "none"` with a `note`, which is what §5
already specified for this case. **No consumer of a valid request sees a different response**, and
nothing in `investigation.schema.json` changes — an out-of-scope refusal is the `unavailable` shape
that was already schema-valid.

### Two lists, not one, and the order is the point

The boundary refusal (`NEVER_FORWARDED`) is **not derived from** the scope allowlist
(`INVESTIGABLE_TYPES`) and is checked before it. Until now §2.3's alert-text rule was *implied* by
§2.4's single accepted shape, so widening scope for a second scenario would have reopened it silently —
which is exactly how a gate asserted in three paragraphs came to be enforced nowhere. Widening scope
now cannot widen the boundary. `test/investigationScope.test.ts` pins the two sets as disjoint, and
every test there asserts **`callAgent` was not called**, because the absence of the outbound call is
the property that matters rather than the shape of the reply.

### The fix #206 proposed would have broken a shipped scenario

That issue proposed rejecting anything but `(queue_buildup, Cloud API)`. **MVP 3 shipped a second
scenario** — `dead_host` on a service polling a directory that does not exist
(`docs/production-guardian-mvp3.md` §2.1/§2.3, with `Triggers.MissingFolder()`, `get_host_settings`
and `manualRemediation` all built for it) — and §2.4 was never amended when it landed. Enforcing the
contract as literally written would have refused a scenario the product demonstrates. Two lessons, both
already in this file's history: a scope table is a contract surface and drifts like any other, and the
right response to "the code does not match the contract" is to check which one is wrong.

**The host half of the pair is dropped rather than extended.** The concern is the provenance of
`finding.message`, which is a property of the *type*; the agent's read tools are host-agnostic; and a
host name compiled into the engine or the panel is either of them tracking `Production.cls`'s config,
which `apps/dashboard/CLAUDE.md` §9 forbids outright (#25). `mockClient.investigate` already keys its
own branch on type for that reason (#84).

### Consumers

The panel hides Investigate for the six refused types and **distinguishes the two reasons in its
copy** — `system_alert` is a data rule, the other five are an unbuilt feature, and collapsing them into
"cannot investigate" would let a privacy boundary read as a missing feature. That duplicate type list
in `apps/dashboard/src/lib/findingMeta.ts` is deliberate: §2.4 says the engine's check is the backstop,
not the UI's contract, because a hidden button is not a boundary.

§4.1 gains the two new `note` shapes; §5 replaces its "no check exists" row with the two refusals; Q3
no longer promises a host filter or the retired `out_of_scope` failure reason.

## 2026-09-01 — `investigation-api.md`: `diagnostics` documented a block no build has ever sent

**No wire change.** Every field named here already ships and is already in
`investigation.schema.json`; what changes is the prose, which described a different object. So nothing
downstream needs updating — the point is that a consumer implementing from this file was being told to
read fields that cannot arrive, and one of those instructions failed **open**.

`diagnostics` is, and has always been, exactly four keys: `model`, `toolCalls`, `durationMs`, `note`.

### What §3.5 said, and what every implementation does

| | `diagnostics` keys |
|---|---|
| §3.5, until today | `durationMs`, **`agentInvoked`**, `model`, `toolCalls` *(array of names)*, **`failureReason`** |
| `investigation.schema.json`, since 2026-08-20 | `model`, `toolCalls` *(integer)*, `durationMs`, `note` — all required, `additionalProperties: false` |
| `samples/investigation-response.json` (live capture) | the same four |
| the engine, the dashboard, `REST.AgentDispatcher` | the same four |

`agentInvoked` and `failureReason` existed **only** in this file. `additionalProperties: false` means
the schema does not merely lack them, it rejects them — they were unrepresentable rather than
unimplemented — and `grep -rn "agentInvoked\|failureReason"` outside `contracts/` returns nothing.

### The one that would have caused real harm

Q10 told a consumer to detect a cached or canned investigation with
`diagnostics.agentInvoked === false`. That expression is `undefined === false`, which is `false`, so
the check **fails open and labels a canned investigation as live** — the defect the label exists to
prevent, arriving through the contract that mandates it. Q10, §4.1 and §4.3 now point at `state` and
`source`, which is what the shipped panel already reads.

### `toolCalls` is a count, and the reason it is a count survives

§3.5 called it an array of MCP tool names in call order. It is `stats."total_tool_calls"` from the AI
Hub runtime, an integer. **§3.2 of the same file had it right** — *"the count of tools used is
`diagnostics.toolCalls` … not the length of this array"* — so the file contradicted itself and §3.5
was the stale side. The rule that came with the wrong shape is kept, because it is the load-bearing
part: **no arguments and no results, ever**, since a tool result can carry data that has no business
being re-exported to a browser. A count cannot carry either even by accident.

### Why five documentation defects sat in one section

The preamble said *"this document is normative until [the schema and `.d.ts`] are [landed], and they
must be derived from it rather than the reverse."* The schema landed on 2026-08-20 and that sentence
did not change, so a reader had it in writing that checking the schema was unnecessary. It now says
the schema wins. `investigation.d.ts` is still genuinely absent and still says so.

Two other preamble claims were stale in the same way and are corrected: the live capture exists and is
the bytes to mock against, and the LLM provider has been live since MVP 2 shipped — which downgrades
several "specification, not observation" caveats, including Q14 (measured) and Q13 (partly measured).

`README.md`'s table gained the five MVP 2 files, which had been landing in this directory since MVP 2
opened without ever appearing in it. The sentence about the sample being *"noted rather than quietly
left off `README.md`'s table"* was itself the only place the omission was recorded, and it is where the
"not captured yet" claim outlived the capture by twelve days. The table also now says the dashboard
consumer is Dev B rather than Dev C, and names the two remaining gaps: no `investigation.d.ts`, and no
schema or sample for `resolve-api.md` (#202).

**Nothing validated the three §8 payloads, which is why all three were invalid.** `validate.mjs`
checks `samples/*.json` and does not look inside contract prose. Fixed by hand and re-checked with
ajv against `#/definitions/InvestigationResponse`; making that a committed check needs a fence
convention naming the definition, filed as **#205**.

One unrelated correction, made because it is in a section this PR edits and it concerns who reviews a
contract change: **§9 dated the drop to two developers `2026-08-12`**, which is not a date anyone left
on. Dev C left `2026-08-20` (root `CLAUDE.md` §4).

### Three behaviour divergences found on the way, documented but not fixed here

This was a documentation PR and these are code decisions, so the contract now states what ships and
names the issue rather than quietly asserting either side:

- **§2.4's scope gate does not exist** — no type or host check anywhere, so a `system_alert` finding,
  whose `message` is text IRIS wrote into `alerts.log`, can be forwarded to the external LLM. §2.3
  names that as the hole §2.4 closes, and it does not. **#206**, and the most serious of the three.
  *Fixed the same day — see the entry above. Left as written because this entry records what that PR
  found, and the fix turned out not to be the one the issue proposed.*
- **§4.3's fallback chain has no cache and `canned` is a boot mode, not a fallback**, so nothing ever
  produces `state: "degraded"` and §8.2 is schema-valid but unreachable. **#207**
- **A cleared `findingId` is a `400`**, not the `200` + `state: "unavailable"` §5 argues for at
  length. Both sides wrote down a good reason; they are about different inputs. **#207**

## 2026-09-01 — `mcp-tools.md` §3.13: `get_active_findings` capped at 25 in silence — `total` and `truncated`

**Two fields added to `get_active_findings`, and one field added to the request that feeds it.**
`total` (integer | null) is how many findings **exist**; `truncated` (boolean | null) says whether it
differs from `count`. On the request the engine now also sends `findingsTotal`. Nothing is removed and
no existing field changes meaning, so a consumer reading only `count` still reads what it read before —
it just no longer has to assume that number is the answer.

### What was wrong

`count` was the size of the list **after** the cap, and three separate caps of 25 could clip it: the
engine's slice, the stash on receipt, and the tool's own. A clipped payload was byte-identical to a
complete one, so the model stated `count` as the number of open findings. §3.13 mentioned no cap at all
— a consumer implementing from this contract could not know findings were droppable.

The section already goes to real trouble over `count: 0` meaning four different things. This was the
same failure pointing the other way and **more** likely to fire, because findings multiply exactly when
a production is in trouble, which is when someone asks how many there are (@tanifgit, #165).

### The shape follows §3.14 rather than inventing one

`get_interface_path` already solved this for itself — `pathsReturned` / `pathCount` / `truncated` — and
its own section named #165 as the open defect that made it state the rule. So this is that rule applied,
including the part #186 had to learn the hard way: **`total` is scoped to the same filter as `count`**,
never to the production, because "3 of 31 shown" about a host with three findings is a worse answer than
no total at all.

That scoping makes one case genuinely unknowable, and it is reported as `null` rather than guessed: a
filtered call against an already-clipped list cannot know how many of the withheld findings were on that
host. `truncated` still answers `true` there — that some were dropped is known even when how many of
yours is not — and the `note` refuses the all-clear rather than saying "no open findings on `Cloud API`".
`truncated` is tested **before** `count: 0` for that reason, which the section now states.

All three fields are `null`, never `false` or `0`, on any payload where no snapshot was read. §2.1's
rule, applied to a boolean and to a count instead of to a metric.

### Why the cap's justification is also gone

The same sentence appeared in all three cap comments: eight finding types across three hosts is 24, one
under 25, so the cap could not clip a real production. Findings are keyed `(host, type)`, so the ceiling
is `hosts × 8` — a **host count** compiled into a justification, which #25 and #34 forbid, and wrong at
four hosts. #165 filed it as the same defect for the same reason it filed the silence: the 25 is two
independent literals across the language boundary, so raising one silently drops findings at the other.
That is now observable instead of invisible.

Pinned by `Test.FindingsTruncation` (`iris/test/`, hand-run, 27 assertions), which was checked against
two mutations rather than assumed to catch them — including one that shows #165's own reading of the
filter/cap order was not quite what the code does. The class comment records the difference.

---

## 2026-09-01 — `resolve-api.md`: `audit.tool` is `SetPoolSize`, a preview runs the write tool, and `confirmation` is nullable

**One shape change, and it is the document catching up with five shipped implementations.**
`confirmation` becomes `object | null` — non-null **iff** `outcome` is `applied`. The `status` value
`not_applicable` is **removed**; it was never emitted by anything.

Three corrections, all found by diffing this document field by field against a live
`POST /api/resolve` dry-run and against `Audit.Entry`. The other two divergences that diff turned up
are **not** in this change — they are open decisions in #202, because in both the document's argument
is the better one and a shipped UI depends on the current behaviour.

### `audit.tool` — §8

`SetPoolSize`, PascalCase, **on a dry-run as well as an apply**. `%EXACT(Tool)` over the whole audit
table returns `SetPoolSize` and nothing else for this family; `get_pool_size` has never appeared in it
and, per `mcp-tools.md` §1, was never a callable name — the same defect #155 corrected in
`investigation-api.md`, one file over.

**`tool` is not the same string as `action.type`.** `action.type` is this contract's wire enum and is
correctly `set_pool_size`; `tool` is what the runtime stores. The two looking alike is how this drifted,
so the field row now says so and repeats the existing rule: render it, never compare it to a literal.

### The dry-run non-mutation guarantee — §2

The paragraph claimed the preview path calls a separate read tool and "never calls `set_pool_size`",
and called non-invocation "a stronger statement than 'it is invoked with a flag that makes it not
write'". The shipped path is the second thing: the engine POSTs `{host, size, dryRun}` to the one write
tool, which is why a preview audits as `SetPoolSize` with `{"dryRun":1,…}`.

**The guarantee held throughout** — `Tools/Resolve.cls` runs every guard and then returns before
`%Save()`, which is as structural as a second tool. But a safety claim that names the wrong mechanism
cannot be checked by the person it is written for: they go looking for a read tool and find that the
privileged one ran. §8 now also warns that counting writes needs `Arguments`, not just `Tool`.

### `confirmation: null` — §3, §7, and three §11 samples

The engine, the dashboard's guard and types, both mocks and two tests have shipped `null` since MVP 2.
The document was the only holdout, so the document moved — and `null` is the safer of the two forms,
because `InvestigationPanel.tsx` renders its clearance countdown from `confirmation !== null`, so a
`not_applicable` object would make a preview promise a clearance that is never coming.

### Why all three were invisible

**`resolve-api.md` is the only MVP 2 contract with no schema and no sample** — no `resolve.schema.json`,
no `samples/resolve-*.json`, so CI's `contracts — samples vs schema` job cannot see it. Its own preamble
has promised those artefacts as "a follow-up PR" since Day 1. Meanwhile `resolve.test.ts` asserted
`audit.tool === 'get_pool_size'` **citing §8's table**, and the two mocks fabricated the same name — so
the contract, the mock and the test all agreed with each other and none of them agreed with the runtime.
Committing the schema and a captured sample is tracked in #202 and is the durable half of this fix.

#202.

---

## 2026-09-01 — `evidence[].tool` is provenance text, and this file stopped teaching a name that was never callable

**No field, type or shape changes.** `investigation-api.md` §3.2's four sample values move from
snake_case to the runtime form (`get_pool_size` → `GetPoolSize`, `get_host_status` → `GetHostStatus`),
the `tool` row stops calling itself an "MCP tool name", and a paragraph plus a clause on Q5 say what the
field is: **free-form provenance, not an enum.**

`mcp-tools.md` §1 recorded in #153 that its own snake_case section titles **have never been callable** —
`%AI.Tool` derives a tool's name from the ClassMethod that implements it. `investigation-api.md` was not
touched then, so the two contracts disagreed on exactly the field a consumer implements `evidence[]`
against, and the wrong one was the file being copied from. `samples/investigation-response.json` has
carried `GetHostStatus` / `GetPoolSize` from a live capture all along, so the samples and the prose
disagreed inside this contract too.

### Three rules, and the third is the one with a cost

Render it, do not parse it. Tolerate a provider prefix — `functions.GetEventLogSummary` has been
observed, OpenAI-style namespacing echoed back by the model into its own JSON. And **never validate
`tool` against a name list or drop a bullet whose name is unrecognised**: a tool is added to
`mcp-tools.md` far more often than this file is reread, and discarding the bullet turns measured
evidence into absent evidence in front of the human approving a write. `mvp2Guards.ts` parses the field
with `nullableStr` and validates nothing, which is correct; the paragraph is what keeps it that way.

**On Q5 rather than Q8**, which is where #155 suggested it. Q8 answers "what is a nullable field" and
`evidence[].tool` is already listed there as nullable — which is true and is a different fact. Q5 is the
question a consumer asks *while writing the renderer*.

#155.

---

## 2026-09-01 — `get_event_log_trend` documents `reason`, and one value of it means "the host may not exist"

**No field, type or shape changes** — `reason` has been returnable from this tool since it shipped and
was simply absent from §3.11's output list. `mcp-tools.md` §3.11 now lists it, and tabulates its two
values against what they say about `buckets[]`.

The row worth the paragraph is `host existence unverified`, which is **new behaviour in the same PR**
(#156): the unknown-host guard's existence check tested `%SQLCODE >= 0` inside one `&&` chain, so a
failed check made the whole condition false and fell through to a complete set of zero-filled buckets.
This family inverts §2.1's sign — a log count of `0` is a measurement — so those zeros assert that the
host was quiet, which is precisely the claim the guard exists to prevent for a host name a model
invented. The fix separates the two tests and publishes `reason` instead of implying an all-clear.

**Documented rather than left internal** because the resulting payload is the one shape in this tool
that a consumer can read wrongly *while it is entirely correct*: the trend is true of the rows that
exist, and it still is not evidence that the host does. So the contract now says a populated trend
carrying that `reason` is not confirmation the host is real.

`reason` and not `error`, per §4: the tool ran and the buckets are readable. That distinction is the
same one §3.8 already draws between the two words.

#156.

---

## 2026-09-01 — `evidence[]` is not the record of what was read (documentation only)

**No field, type or shape changes.** `investigation-api.md` §3.2 gains a paragraph stating the limit of
the guarantee already there. That section promises the forward direction — a `mcp_tool` bullet means the
call is in the audit log — and a reader can easily take the converse, that every call produces a bullet.
It does not, and the gap was measured rather than supposed: `GetInterfacePath` was called on five
consecutive investigations, audited every time, and reached `evidence[]` in three (#192, @tanifgit).

The paragraph says so, names `diagnostics.toolCalls` as the count of tools used rather than the length of
the array, and states that the audit log is what adjudicates a disagreement — from the response the two
cases are indistinguishable.

**Documented rather than silently fixed** because the fix is prompt-side and probabilistic. The same PR
adds a one-entry-per-tool-call rule to the per-request goal, measured 8 of 8 against 3 of 5 before it,
which is a real improvement and not a shape the contract can promise. A consumer that needs certainty
needs the audit log, and that is now written down where a consumer will read it.

#192.

---

## 2026-09-01 — `inboundRatePerSec` is derived from the TAIL slope, not the window slope

**One file, one formula corrected and one field added.** `investigation-api.md` §2.2:
`snapshot.inboundRatePerSec` was defined as `messagesPerSec + trend.slope/60` and now reads
`messagesPerSec + trend.recentSlope/60`; `trend` gains `recentSlope`, the signed magnitude whose sign
has been published as `recentDirection` since #177.

**Additive for `trend`, a genuine semantic change for `inboundRatePerSec`** — the same field name can
now hold a different number for the same inputs. That is the honest description, and the reason this is
a contract change rather than an implementation detail. It is nonetheless safe to land in one step,
because the field had **never been populated by any engine build**: #188 found the only three mentions
of it in the repo were in this contract. Nothing has consumed it, so nothing changes meaning underneath
a consumer. The two things that will read it — `AgentDispatcher`'s prompt and `RaiseUndersizedPool` —
are in the same PR.

#188.

### Why the original formula was wrong

Arrival rate is completions plus the rate the backlog is growing, and **"is growing" has to mean now**.
The window fit is 300 s. Minutes into a drain it still leans up, so the estimate lands *above* the raw
completion rate on the one state where completions are already an overstatement.

Measured on the live drain-through transient: `set_pool_size 1 -> 4` applied, `recentDirection`
reporting `falling`, `messagesPerSec` reading 4 because four workers are clearing a backlog.

| Arrival rate from | Value | Agent's recommendation |
|---|---|---|
| `messagesPerSec` alone | 4 | `set_pool_size 4 -> 8` |
| `+ slope/60`, queue 94 | 4.57 | `set_pool_size 4 -> 6` |
| `+ recentSlope/60`, queue 108 | **3.82** | **none** |

The two derived rows are separate runs a few polls apart, not the same sample — the transient is short.
What decides the outcome is which side of `messagesPerSec` each estimate lands on.

So this is not a refinement of the original formula: it moved the number the wrong way. The flagship
rise is the only scenario that ever exercised it, and there the two spans agree — which is exactly why
the defect was invisible until #188 required both scenarios be measured.

One caveat on attribution, because the table above would otherwise overclaim. The `none` outcome is
produced by the corrected estimate **and** a new prompt directive that says to recommend nothing when
`recentDirection` is `falling` and `inboundRatePerSec` is below `messagesPerSec`. Neither alone is
sufficient: the directive cannot fire on an estimate that reads 4.57, and the estimate alone leaves the
sizing formula free to justify a second increase. The contract change is the half that lives here.

The field was ratified in the MVP 2 design, before either scenario existed to measure it against. That
is not a criticism of the original spec; it is the argument for #188's instruction to re-measure both.

### Why `recentSlope` is published rather than kept internal

The prompt asks the model to state its sizing arithmetic. A term it cannot see is a term it either
omits or invents — and the field it reaches for instead is `slope`, which is the wrong span. Measured
under the *previous* prompt, which never named the derived field at all: the model read
`inboundRatePerSec` off the snapshot JSON anyway and reported "Receiving approximately 4.69 messages
per second", presenting a derived estimate as an observation. A number the model will use regardless is
better named and caveated than hidden.

It stays off `earlywarning-api.md` — §1.4's rule that no bare slope accompanies a withheld forecast does
not distinguish the two spans, and `publishedProjection()`'s whitelist strips both.

### Also corrected

The §2.2 paragraph telling consumers to "treat a `null` `slope` on a crossed threshold as expected" was
stale: #187 delivered `slope` as specified and did not update the prose. Both slopes are now populated
on every investigation, and the section says so.

`inboundRatePerSec` is now stated to clamp at `0`. The two terms span different windows, so a steep
enough drain can put the sum negative; `null` would claim there was no fit.

---

## 2026-09-01 — a tool for the interface map, and `trend` gains the field that says a queue is draining

**Two files, both additive.** `mcp-tools.md` gains one read tool (§3.14, `get_interface_path`);
`investigation-api.md` §2.2 gains one nullable field on `trend` (`recentDirection`). No existing field
changes type or meaning, nothing is removed, and a consumer that ignores both behaves as before.

#177, and the topology source was @tanifgit's suggestion: IRIS's own Interface Maps feature.

### Why a tool at all

Every read tool in `mcp-tools.md` is scoped to ONE host, and so is the snapshot §2.2 sends. So AI
Detective could describe the host it was asked about in detail and had no way to know another host
existed. Measured: an upstream fault was fixed, 281 accumulated messages flushed through at once,
`Cloud API` queued 296, and the Detective recommended the MAXIMUM pool of 8 at 0.85 confidence on a
queue that drained to zero unaided while it answered — its own evidence reading "No errors recorded in
the last 60 minutes", true of `Cloud API` and false of the production.

### Why IRIS's map rather than reading config

`Ens.InterfaceMaps.Utils` resolves ROUTING RULES, and that is the whole reason. On this production
`EMR Source -> Lab Router` is a `TargetConfigNames` setting, and `Lab Router -> Cloud API` exists only
as a `<send>` inside a routing rule class. A topology hand-built from settings would have been missing
exactly the edge the tool exists for, and would have looked correct. It is also derived from the
production DEFINITION, so it still answers when a host is dead — which is when an investigation runs.

Two surfaces of that utility were tried and rejected, and §3.14 records why. `FindAllPaths` is an
**internal method** — its own dictionary description opens with that word — returning a `%Status` with
the paths handed back **byref** as `$listbuild` lists, `$lb(Service,Processes,Rules,DTLs,Operations)`,
per that same description. `FindSequentialPath` wants a JSON spec whose shape is not documented
anywhere reachable; passing it a path string returns `ERROR #5035 ... 'Parsing error'`.

**An earlier draft of this entry said `FindAllPaths` returned a control-character-delimited string in
an undocumented encoding. That was wrong** (@Ari-Glikman, #185): the `$c(12)`, `$c(11)` and `$c(1)`
bytes measured at offsets in the value are `$list` length and type headers, not delimiters, and
`$listget` reads it in one line — verified, `$listvalid` is 1 with five elements. Corrected here rather
than quietly dropped, because a wrong-but-plausible rationale is the kind a later reader trusts instead
of re-checking, and it would have told them the richer surface was undecodable when it is documented.
"Internal method" is the firmer reason and does not depend on decoding anything.

### `trend.recentDirection`, and the deviation it works around

§2.2 has always specified `slope` as "may be zero or negative here ... because a queue that is draining
is a fact the agent should see", and its §4 example carries a non-null slope beside
`thresholdCrossed: true`. **The engine has never delivered that.** It reads `slope` from Early Warning's
`projection`, which is `null` for `already_crossed` — i.e. for every condition this endpoint is called
about. So the one fact needed to tell a recovery from a runaway was specified, documented, and absent.

`recentDirection` (from `earlywarning-api.md` §1.5) is the half fixable without reopening that
contract's §1.4 prohibition on publishing a bare slope beside a withheld forecast: a direction is not a
rate, so it carries no forecast to mislabel. **The `slope` deviation itself is NOT fixed here** and is
filed separately — honouring it needs the window slope published or refitted, which is
`earlywarning-api.md`'s decision rather than this one's.

### Verified end to end, live agent

Same armed scenario, before and after:

| | Before | After |
|---|---|---|
| tool calls | 4 | 6 |
| upstream hosts read | none | both, via `get_recent_errors` |
| recommendation | `set_pool_size` -> 6 (conf 0.9) | **null** |
| root cause | "pool size 4 is insufficient" | "`EMR Source` errors #5021, 229 s ago, since ended — backlog draining through" |

And the ordinary rising case still recommends a pool increase (`1 -> 2`, conf 0.9), which is #108's
standing check and the thing a directive about transients could most easily have broken.

### Consumer impact

**None required.** Both changes are additive. A consumer already handling a `null` `slope` — which is
what has always arrived — needs no change; `recentDirection` is the field to read instead.

---

## 2026-08-31 — Early Warning publishes `recentDirection`, so a recovering queue stops reading like a runaway one

**`earlywarning-api.md` only.** Additive: one nullable field on `HostProjection`, plus a
`RecentDirection` type. **No reason added, no precedence moved**, no existing field changes type or
meaning. A consumer that ignores it behaves exactly as before.

#174, reported by @tanifgit from a live run.

### The defect, and why the reason code could not carry it

`already_crossed` is returned for a queue over its threshold whether it is climbing or draining
(§2.2 step 5). That precedence is deliberate and it is **kept**: a queue over its limit is a problem
however it is moving. What it could not do is let a consumer tell a recovery from a runaway, and both
rendered as the same sentence.

Measured on the containerised stack: an armed `queue_buildup` fixed by enlarging the pool 1 → 4 spent
**22 consecutive polls — 110 seconds — draining monotonically from 152 to 54, every one reporting
`already_crossed`**, byte-identical to the climb through the same depths. It flipped to `not_rising`
one poll after dropping under 50. For scale, a projection with an ETA exists for roughly **20
seconds** on that scenario, so the indistinguishable state is the one the panel spends most of its
life in.

### Why a sign and not an eighth reason

An eighth reason (`crossed_but_recovering`) would move the precedence and force every consumer that
enumerates reasons to learn a key — `mvp2Guards.ts` and `mockClient.ts` both do. The engine was
already **measuring** the answer: §2.2.1 fits the tail of the window and uses it as a sign test. So
the fix publishes that sign rather than inventing a state.

**The magnitude stays unpublished**, which is also §2.2.1's existing decision rather than a new one.
Two rates in one payload would leave a reader unable to tell which one `message` was built from, so
the tail keeps answering exactly one question — which way — and `recentDirection` is that answer.

### `null` is "no claim", and it is not only for an unfittable tail

`warming` and `insufficient_samples` rows always carry `null`. §2.2.1 lets the tail decide on as few
as two samples *because* the window behind it has cleared `minFitSamples`; published standalone on a
warming host, a sign fitted through three samples would be a claim with nothing behind it. So a
direction appears exactly when there is a fit worth signing.

### It lags a turn, and that is stated rather than discovered

The tail is a 120 s fit, so the sign changes once enough of the tail has turned rather than on the
first sample that moves. Measured: a queue peaked at 151 and began draining immediately, and the
field reported `rising` for a further **~35 s and 46 messages of real drain** before flipping.

That is §2.2.1's existing trade — the 40% tail exists so "one bursty poll cannot flip its sign" — and
a flapping direction beside a critical finding would be worse than a slow one. §1.5 states the
measurement and the consequence: the field answers "which way has this been going", so a consumer may
build a *coming down* claim on it and must not build a *recovered* one. Written down because the
buffering caveat on `mcp-tools.md` §3.12 was the same shape of known-but-unstated latency, and
arguing it away is what stopped the next reader checking (#171).

### Consumer impact

**None required**, and one opportunity. Nothing that validates today stops validating — there is no
`earlywarning.schema.json` at all (§7), so this endpoint has never been CI-validated in either
direction. Dev C's rendering requirement is new but additive: where a reason is rendered for a
crossed threshold, `falling` must not read the same as `rising`, and `null` must read as unknown
rather than as reassurance.

§4's examples gain the field. The three warming rows get `null`; the projection rows get `"rising"`,
which §1.5's invariant *requires* rather than assumes. §7 already records that these values are
constructed rather than captured. The one exception is the new draining delta in §4.3, whose values
are measured — shown as a delta precisely so that `fitSampleCount` and `fitSpanSeconds`, which were
not captured on that run, are not invented into the bytes Dev C mocks against.

---

## 2026-08-31 — `recommendedAction.currentValue` is documented as nullable, and `reversible` stops being defined against it

**`investigation-api.md` §3.3 only. No schema change, no sample change, no field added or removed.**
This entry corrects PROSE that disagreed with the two machine-readable artefacts it is supposed to
describe. Implementation half of #178 is separate and changes no contract.

### The disagreement

| Artefact | Said |
|---|---|
| `investigation-api.md` §3.3 table | `currentValue` \| **`integer`** |
| `investigation.schema.json` | `{ "type": ["integer", "null"] }` |
| `samples/investigation-response.json` | `"currentValue": null` |

So the prose was the outlier, and it was the outlier in the direction that hides a defect: a
consumer reading the table would build for a value that is always present, and the schema and the
sample everyone mocks against both permit — and the sample *encodes* — the case that actually
shipped. Nothing failed, which is the point. `null` was served on **every** investigation and the
approval label read `increase Cloud API pool ? -> 8`.

A ratified sample carrying the defective value is worse than a gap in the prose, because
mock-first is what this repo relies on to make "works against the mock" predict "works against the
real thing" (root `CLAUDE.md` §4). Here it predicted it exactly, and both were wrong.

### What the prose now says

- `currentValue` is `integer | null`, with **when** it is null (the agent did not report it) and what
  a consumer must do about it (omit the before-value, never render a placeholder). The two `summary`
  forms are spelled out, because §3.3 makes that string authoritative and rendered as-is.
- It may be **below `bounds.min`**. `bounds` constrains the *target* of a write, `2..8`; LABDEMO ships
  `Cloud API` at PoolSize 1, so a reader who validated the current value against the bounds would
  reject the true value in the shipped configuration.
- **`reversible` is no longer defined against `currentValue`.** It read *"whether re-applying
  `currentValue` undoes it"*, which made a `true` flag beside a `null` value look like a contradiction.
  It is not: `resolve-api.md`'s `reversal` is built from the `before` the **write tool** reports at
  apply time. That is also the only correct source, because the pool may have changed between the
  investigation and the approval — so the narrower definition was wrong even when the value was
  present.
- The claim that it *"feeds `precondition.poolSize` and the reversal target"* is replaced by an
  accurate account: `precondition` is optional and a consumer holding `null` must omit it rather
  than guess.

### Consumer impact

**None required.** No key changes type in the schema, so nothing that validates today stops
validating, and a consumer already handling `null` — which the schema and the sample have always
demanded — needs no change. A consumer that trusted the *prose* and assumed a non-null integer was
already broken against the shipped payload; that is what #178 found.

---

## 2026-08-31 — `get_recent_config_changes` gains `noOpSaves`, and the buffering caveat stops excusing itself

**`mcp-tools.md` §3.12 only.** Additive: one output field, `noOpSaves`, an integer count. No input
changes, no existing field changes type or meaning, and `changes[]` keeps its shape — a consumer that
ignores the new field sees strictly fewer bogus entries, never fewer real ones. Two prose sections are
rewritten, one of them a correction rather than an addition.

Both halves of #171, which @tanifgit found by comparing three live investigations.

### The correction, which matters more than the field

§3.12 already documented that `%SYS.Audit` rows are not readable the instant they are written. It then
closed with *"An agent turn spends seconds per tool call, so no consumer of this contract is affected in
practice; a test that arms and asserts in one breath is."*

**That was wrong.** An investigation of the `MissingFolder` scenario called the tool 16 seconds after the
`FilePath` edit, received `changes: []`, and reported *"no recent configuration changes were found"* — a
fabricated negative on the flagship scenario this tool was built for. Re-measured: the row appeared at
**+36 s**, and a `HTTPPort` edit in the same session appeared at **+24 s**. Tens of seconds, variable,
and an agent turn sits inside it.

A hazard that is identified and then argued away is worse than one nobody spotted, because the argument
is what stops the next reader from checking. The paragraph now states the measurement and turns it into
a consumer rule: **an empty `changes` list must never be reported as "nothing was changed"**, and
`retention.newest` — already in every payload since MVP 3 — is what separates "no change" from "the log
has not caught up". No new field was needed for that; the signal was there and nothing read it.

### `noOpSaves`

A count of rows whose `previousValue` equals `newValue`. Those rows are no longer listed in `changes[]`.

They were never operator error. `FirstBoot.ApplyDeploymentSettings()` writes `HTTPServer` and `HTTPPort`
through `Triggers.SetSetting()` on **every boot**, and `SetSetting()` audited unconditionally, so a
normal boot left two `X changed from Y to Y` rows in the window every investigation reads. A
`PoolBottleneck` investigation duly presented both as `Setting Change` evidence on a production nobody
had reconfigured.

Counted rather than silently dropped, for the reason `suppressed` and `truncated` are counted: a number
a consumer can read beats a number it cannot. It is a **separate** field from `suppressed`, which means
"something changed that I may not name" — a different fact from "something was saved and nothing moved",
and merging them would lose both.

**Why this is a filter and not only a producer fix.** `Triggers.SetSetting()` stops writing them, which
handles everything this project controls going forward. The tool filters anyway, because the rows already
in the audit log do not disappear and the Management Portal's own save path is not ours to change.

---

## 2026-08-30 — two tools: what was CHANGED, and what Guardian is REPORTING

**`mcp-tools.md` §1, §3.12, §3.13, §5.3's role table, and §6.** Additive: twelve tools become
fourteen, thirteen read and one write. No existing tool's input, output or name changes, so a consumer
that never calls the new pair sees nothing different. Four stale counts in prose are corrected on the
way through.

**Both asked for directly**, and each closes a gap where the product answered from the wrong source:

> *"check audit table for changes and suggest that there may be a change/typo to recently changed value
> if it fits … you can bring it up in analysis but do not suggest the fix because they likely changed it
> for a reason and we do not know what they wanted to change it to."*

> *"the ask about activity only checks the tables but not the findings. so when there is an issue, when
> we chat and ask if there is any issues (like pool bottleneck) it will not relate to the findings. it
> should."*

### `get_recent_config_changes` (§3.12)

Which setting changed on which host, from what value to what value, and when — from `%SYS.Audit`. Every
other read tool answers a question about the production's *behaviour*; none could answer the one an
operator asks first, which is *did someone change something?* On this instance `EMR Source`'s `FilePath`
and `Cloud API`'s `HTTPPort` were both edited within hours of the findings they caused, with nothing
reading it.

**The reporting rule is in the contract, not only in the prompts**, because it constrains what a
*caller* may do with the output: **a consumer must not recommend reverting a change it reports.** The
old value is returned — withholding it would leave "FilePath changed" where "changed from a directory
that exists to one that does not" is the diagnosis — so the restraint has to be stated rather than
engineered. `investigation-api.md`'s `manualRemediation.target` is the shape most likely to break it.

**Three fields exist because an empty list is not evidence**, and a caller cannot infer any of them:
`retention` (IRIS purges audit data on a schedule — measured, a purge ran 2026-08-30 06:00 here),
`auditEnabled` (`true` / `false` / **`null` for "could not tell"**), and `suppressed` (a *count* of
non-allowlisted setting names, never the names).

**Measured facts that a reader would otherwise have to rediscover**, all of them written into §3.12:
`Description` is the subject and `EventData` is the detail, which is the reverse of the names; both are
`varbinary`, so **`EventData LIKE '%>>%'` returns SQLCODE -29** and no SQL-side content filter can be
written; host attribution must be anchored at *both* ends because config item names contain spaces; and
only 8 of this instance's 82 `ModifyConfiguration` rows are setting changes at all.

**One behaviour change outside the contract, and it is a fix rather than a feature.**
`Triggers.SetSetting()` mutated a live production setting and wrote **no audit row** — measured by
arming `MissingFolder()` and finding the newest row three days stale, because only the Management
Portal's own save path audits and that method goes through `Ens.Config.Production.%Save()`. It now emits
a byte-compatible row itself via `$SYSTEM.Security.Audit()`, **after** the save succeeds, so the log
never claims a change that did not land. Without this the feature would have been undemonstrable
through the exact two scenarios it was asked for.

**`Username` and seven other actor columns are never selected** (§6). "This was changed 40 minutes ago"
carries the whole diagnostic weight; naming a person invites an agent to assign blame it cannot support.
`%SYS.Audit.EventData` is also free text written by whatever performed the change, which makes an audit
row a *less* controlled source than a live item read — §6 now lists this tool as the third live risk
alongside `get_recent_errors` and `compare_host_activity`.

**§3.12 also states that AI Detective calls this on EVERY investigation**, which is a contract fact
rather than an implementation note — a consumer sizes for one bounded call per investigation. It is
there because the first version of this tool shipped registered, described in the system prompt, and
**never called**: `toolCalls: 2` on the missing-folder scenario it was built for, the model satisfied
after reading the errors and the settings. `BuildGoal()` already carried a `MUST` for the previous two
tools for the same measured reason, so the third repeated a failure the codebase had already recorded.
A description is not a directive.

### `get_active_findings` (§3.13)

What Production Guardian is reporting right now. The chat could describe what the production *did* and
could not see what Guardian was *saying* about it, so "are there any issues?" was answered from an
activity table while a live `queue_buildup` sat on the dashboard two panels away.

**It reads nothing in IRIS** — the first tool in this catalogue that is not a query against the
instance. Findings are computed in the detection engine, so it sends them with the question
(`findings`, `findingsAsOf`, `findingsState` on `POST /labdemo/chat/ask`) and the tool republishes them.
Chosen over an IRIS→engine callback, which would need an engine URL inside the container — the class of
configuration `iris/CLAUDE.md` records going missing on three separate cold boots, failing as "no
findings", which reads as a healthy production. Chosen over prompt injection, which loses
`evidence[].tool` attribution and the §5.5 audit guarantee and taxes every turn.

**The `state` field is the part worth reviewing.** `count: 0` means four different things, and three of
them are not an all-clear: `supplied: false` is no snapshot, `warming` is *nothing measured yet* (the
engine's six comparative rules are structurally silent below `minBaselineSamples`), `stale` is a
last-known list, and only `ok` supports "no open findings". §2.1's rule — an unmeasurable value is not a
small one — applied to a list rather than a number.

**Registered for the `chat` tool set only.** AI Detective's caller supplies no snapshot, because
`/api/investigate` already hands that agent the finding it must explain, so registering it there would
advertise a tool that can only answer `supplied: false`.

### Four stale counts corrected

Each was right when written and staled when a family was added — #84's shape, and all four are in this
file's own prose rather than in a ratified field:

| Was | Now |
|---|---|
| "Four classes, not twelve" | six classes, fourteen tools |
| "A fifth class carries no tools" (`ErrorCatalogue`) | a seventh |
| `ReportTools()` "expects **12**" | expects **14** |
| §5.3: `PG_Read` grants "the five read tools" | **every** read tool in §1 — and the count is now deliberately absent, because `AuthPolicy` is generic and a new read tool requires no change there, so nothing forces the number to be maintained |

**`Tools.Read.#SETTINGALLOWLIST` became a `Parameter` rather than a ClassMethod** so `ChangeLog` could
share the one list. A public accessor on a `%AI.Tool` subclass would have become a fifteenth tool that
returns setting names to the model; a second copy of the list would have been #84 again.

### Verified live, both scenarios the user named

Against the running four-container stack with `AGENT_MODE=live` and a real `gpt-4o-mini`, not a mock:

| Check | Result |
|---|---|
| chat under `warming`, nothing armed | `toolCalls: 1`, `evidence[].tool: GetActiveFindings`, and the model **refused an all-clear** — "state is 'warming' … not possible to confirm that everything is functioning correctly" |
| chat with `PoolBottleneck()` armed | both real findings cited with their own numbers — queue depth 70, queue wait 7.68s at 384x baseline — attributed to `GetActiveFindings`, `confidence: 1` |
| AI Detective on the armed `MissingFolder()` `dead_host` | `toolCalls: 3` across three consecutive runs; the 10:27:26 `FilePath` change cited in `rootCause` and as attributed evidence; **no revert in any of the nine remediation steps** |

The `supplied: true` path is the one thing only a live run could test — it rests on the agent loop
running in the CSP request's own process, which is what makes a process-private global a valid handoff.

**One regression was found and fixed by these runs**, which is the argument for making them: the first
`BuildGoal()` directive closed by deferring to "the rules in your instructions", and every evidence entry
came back with `source` unset across three runs. `investigate.ts` maps an unrecognised source to
`"llm"`, so the reply stayed schema-valid while claiming the model had reasoned out values it had read
from governed tools — attribution silently lost, in the field §5.5's audit story depends on. The goal is
the last thing the model reads; a requirement stated there must not point at another part of the prompt.

---


## 2026-08-26 — the event log becomes readable: two tools, a shared host roster, and one inference moved into the payload

**`mcp-tools.md` §1, §3.9's closing note, and two new sections §3.10–§3.11.** Additive: ten tools
become twelve, eleven read and one write. No existing tool's input, output or name changes, so a
consumer that never calls the new pair sees nothing different.

**Asked for directly**: *"for the chat I would like to add this table Ens_Util.Log."* Before this the
chat had no tool that could answer "any errors?" at all — it would answer from throughput, which is
inference dressed as a reading.

`get_event_log_summary` groups a window by host and severity, classifies error and warning text through
the §3.4a allowlist, and never returns text. `get_event_log_trend` gives volume by severity bucket by
bucket, empty buckets included. Both are `PG_Read` and both are registered on the chat agent's
`"chat"` tool set, which was **added rather than widening `"activity"`**, so no existing caller's
meaning changed.

**Three things a consumer cannot infer, so they are written down:**

- **`(production)` is a sentinel, not a config item.** `ConfigName` is **NULL, not empty**, on the rows
  `Ens.Director` writes about the production itself — measured: `= ''` returns 0 rows, `IS NULL`
  returns 91. So no host-filtered query can ever reach them, and `get_recent_errors` has therefore
  never once reported a production that failed to start.
- **Framework hosts are labelled, not filtered** — a deliberate divergence from `healthscan-api.md`
  §2, which drops them. `application` is `true` / `false` / **`null`**, and the third value is the
  interesting one: it marks `(production)`, which is neither an application host nor framework
  plumbing. `false` there would file the production's own start failures under framework noise.
- **Zero inverts §2.1's sign in this family.** A log count of `0` is a real measurement — the query ran
  and nothing was logged. `null` stays reserved for what could not be read. Every other tool family
  says the opposite, which is exactly why this needs stating.

**`lifecycleFaults[]` is the entry worth reading twice, because it is a contract field that exists to
compensate for a model, not for a table.** Asked *"did the production have any trouble starting or
stopping today"*, the agent called both tools, **counted the 10 error rows correctly**, and closed with
"there were no issues starting or stopping the production" at `confidence: 0.9` — then, after two
prompt sentences were added telling it to read `sources[]`, closed with "the production started and
operated without additional issues indicated in the logs" at `confidence: 1`. Nine of those rows were
`Ens.Director.StartProduction` failures sitting in the array it had just been told to read.

The missing piece was never evidence. It was the **join** from a dictionary-verified method name to
"the production failed to start" — and because every code was `unclassified`, an unrecognised code read
as an absent fault. Prose held on one run of three, so the join moved into the payload as a fixed
catalogue keyed on `SourceMethod`: `ErrorCatalogue.Summary`'s shape exactly, deriving nothing from a log
row, so §6 is untouched. Correct on three runs of three afterwards. **The array is always present on
the `(production)` entry**, so empty means *measured clean* rather than *not checked*.

**A pre-existing contract/runtime mismatch is documented rather than fixed**, in a new subsection under
§1: the snake_case names in the catalogue column have **never** been callable. `%AI.Tool` derives the
runtime name from the ClassMethod name, so the real names are `GetEventLogSummary`,
`CompareHostActivity` and so on — measured, and `investigation-api.md`'s `evidence[].tool` has been
carrying `"functions.GetEventLogSummary"` all along. The model was bridging by resemblance. The column
is now labelled as section titles, with the consequence stated: **renaming a ClassMethod renames a
tool, and is a contract change.**

**A new §2 convention: a boolean field is a JSON boolean.** No sample changes — the samples in
`mcp-tools.md` have always shown `true`; the **implementation** was emitting `1`. `set out.found = 1`
on a `%DynamicObject` emits a number, so eight fields across §3.1, §3.2, §3.5, §3.7 and §3.9 (`found`,
`enabled`, `measured`, `readable`, `application`) changed JSON type depending on which branch ran.

Found by smoke-testing the chat after the event-log work landed, not by reading code: asked "how many
hosts are in this production", it answered *"7 … both application hosts and framework-related hosts"*
against 3 application hosts, while the prompt paragraph telling it to read the flag names `true` and
`false`. **Fixing the types alone, with no prompt change, gave "3 application hosts … EMR Source, Lab
Router and Cloud API" on three runs of three.** It survived this long because `1` and `true` are the
same value to every consumer except the one that reads the field name.

**Two `null`s that were empty strings, found the same way and in the same class.** §3.4's table says
`newestSecondsAgo` is `integer | null` and §3.4a says an unclassified code's `summary` is `null`;
`get_recent_errors` emitted `""` for both. An ObjectScript `""` inside a `%DynamicObject` literal
serialises as the string `""` — measured: `{"a":("")}` gives `{"a":""}`, `%Set(k,"","null")` gives
`{"k":null}`. `""` is not the same claim as `null`: it reads as *there is a summary and it is blank*,
which is §2.1's defect wearing a different type. `get_event_log_summary` has emitted `null` there from
the start, so **two tools reading the same catalogue disagreed on the same field** — the cost of the
copy §3.4a warns about, showing up as soon as there were two callers. `newestSecondsAgo: null` is
verified in emitted output; the `summary` branch is verified in its two halves (the catalogue returns
`""`, and `%Set(…,"null")` emits `null`) because no host-scoped unclassified error exists on this
instance to drive it end to end.

Also recorded: four host-roster copies became one (`Tools.HostRoster`), neither it nor
`Tools.ErrorCatalogue` extends `%AI.Tool` so their public methods cannot become tools, and
`Setup.AIHub.ReportTools()`'s guard moved `10 -> 12` in the same commit — verified reading
`12 (expected 12)`.


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

**One older undocumented path is written down at the same time**, found while checking the above: a
non-finite or `<= 0` `secondsToThreshold` also declines as `not_rising`. It predates the tail test and
should be unreachable — it would mean the arithmetic disagreed with `already_crossed` a step earlier —
but it was the third way to reach step 6's reason code and the contract described only one.


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
