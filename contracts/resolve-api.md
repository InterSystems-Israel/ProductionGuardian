# Smart Resolve API contract

**Owner:** Dev A + Dev B (per MVP 2 §2.4) — **Dev A has left; Dev B inherited `iris/**` on
2026-08-12, so in practice Dev B holds both halves.** · **Consumer:** Dev C · **Port:** `3002` ·
**Status:** published

One endpoint, and it is the only thing in this repository that **writes to a live production**.
Everything else in `contracts/` describes a read. That difference is why this document is longer
than what it defines: the schema is small, the reasons it is shaped this way are not.

Smart Resolve applies **one** governed, human-approved, reversible corrective action to the
running production and then tells the caller how to confirm the condition cleared. Root
`CLAUDE.md` §2.1 already ratifies the safety model as a **scope boundary**, not an
implementation preference:

- human approval by default — nothing applies unattended
- exactly one whitelisted action, `set_pool_size` on `Cloud API`, within a bounded range
- dry-run / preview before apply, and the action is reversible
- RBAC-gated, so AI Detective can investigate without being able to act
- every tool call audited, read and write — **authorization and audit are enforced by the AI Hub
  runtime around every tool call, before and after execution respectively (§9.4), so neither is a
  convention a tool author can forget**
- metrics and configuration only ever leave the instance — never message content, never PHI

**The engine does not mutate the production.** `services/detection-engine/CLAUDE.md` §1.1:
"`POST /api/resolve` proxies the governed MCP write tool. We do not mutate the production
ourselves — the write happens in IRIS behind RBAC, and this service is a caller that records
what it asked for and what came back." The engine gained orchestration, not authority. Read §9
before assuming otherwise.

**Machine-readable: `resolve.schema.json` landed 2026-09-01 and `contracts/validate.mjs` enforces it,
over three captured samples.** Until then this was the only MVP 2 contract where prose was the sole
normative form and nothing failed when it stopped being true — which is why five field-level
divergences from the shipped path went unnoticed until they were found by hand (#202). **Where this
file and the schema disagree about a shape the schema constrains, the schema wins** — the same
reversal `investigation-api.md`'s header made after #201.

**Two points are deliberately left un-decided, and the schema says so on the fields rather than
picking:** §4's `after` on a preview, and §5's `confirmation.directEvidence` / `clearsWhen`. Both are
open decisions on #202 and both are typed permissively, so the schema holds the decided shape without
quietly settling the undecided one. A permissive field with `TIGHTEN THIS ONCE …` in its `description`
is a marker, not an answer; the schema does not become the authority for those two until they are
tightened. `resolve.d.ts` is still genuinely absent — as `investigation.d.ts` is — so there is no
TypeScript transcription to check against; the engine (`src/detect/resolve.ts`) and the dashboard
(`src/types/mvp2.ts`) each carry their own.

**`samples/resolve-response.json`, `resolve-preview.json` and `resolve-refusal.json` are captured from
the live stack and are the bytes to mock against.** Three rather than one because the shape is
outcome-dependent: `confirmation` is an object only on `applied`, `refusal` only on `refused`, and
`before`/`after`/`reversal` are all null on a refusal, so one capture would leave both branches a
consumer has to handle uncovered. The JSON in §11 stays **illustrative** — read §11 for shape and the
samples for bytes. **CI counts are deliberately not quoted here** — this paragraph carried
"15 accept / 19 reject / 7 capture claims" and the reject count had reached 26, a copied number staling
exactly as §3's host lists do. `validate.mjs`'s own output is the count.

---

## 1. `POST /api/resolve`

Not under `/api/healthscan/`. Health Scan reads; this writes, and the path should not suggest
they are the same family of thing.

### 1.1 Request

```json
{
  "requestId": "rq-6f2c1e",
  "mode": "apply",
  "action": {
    "type": "set_pool_size",
    "host": "Cloud API",
    "size": 4
  },
  "origin": {
    "findingId": "f-1042",
    "investigationId": "inv-8801"
  },
  "precondition": {
    "poolSize": 1
  },
  "requestedBy": "presenter@laptop"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `requestId` | string | **for `apply`** | Client-generated, opaque, ≤ 64 chars. The replay key — see §6. Optional for `dry_run`, which has nothing to replay. |
| `mode` | string | **always** | `dry_run` \| `apply`. **No default** — see §2. |
| `action` | object | **always** | The whitelisted action. Transcribed, never composed — see §1.2. |
| `action.type` | string | **always** | Exactly `set_pool_size`. Anything else is refused. |
| `action.host` | string | **always** | Exactly `Cloud API`. Anything else is refused — see §3. |
| `action.size` | number | **always** | Integer, `2 ≤ size ≤ 8`. Out of range is refused, not clamped — see §3. |
| `origin` | object | **for `apply`** | What motivated the write. Both ids are opaque strings here. |
| `origin.findingId` | string | **for `apply`** | The `Finding.id` from `healthscan-api.md` §2. Used for the confirmation contract (§7) and the audit trail (§8). |
| `origin.investigationId` | string | no | The AI Detective investigation this recommendation came from. Opaque — its shape belongs to `investigation-api.md`. |
| `precondition` | object | no | Optimistic concurrency. When present, the live value must match or the call is refused. |
| `precondition.poolSize` | number | no | The pool size the approver believed they were changing *from*. |
| `requestedBy` | string | no | **Provenance label only. Never used for authorization.** Recorded next to the authenticated actor in the audit block, never in place of it — see §8. |

Unknown top-level fields are **ignored**, not rejected. Unknown fields *inside* `action` are
**refused** (`malformed_request`). The asymmetry is deliberate: an unrecognised sibling of
`requestedBy` is harmless metadata, while an unrecognised key inside the action object means the
caller believes it is asking for something this endpoint is not going to do, and silently
dropping it would make the response describe a different operation from the request.

`precondition` exists because approval is not instantaneous. Between the investigation rendering
"PoolSize = 1" and the operator clicking Approve & Apply, a rehearsal reset or a second browser
tab can move the value. Approving a recommendation computed against `1` when the live value is
now `6` is approving something the operator did not read.

### 1.2 The action is transcribed, never parsed

`action` is a field-for-field copy of the **structured** `recommendedAction` the AI Detective
investigation returns (`services/detection-engine/CLAUDE.md` §1.1:
`{rootCause, evidence[], confidence, recommendedAction}`). Dev C passes it through; nothing
between the agent and this endpoint reads prose.

**This endpoint does not accept a natural-language action, in any field, ever.** Deriving
`{type, host, size}` by parsing `"increase Cloud API pool 1 → 4"` out of model output is the
single most dangerous line anybody could write in MVP 2: it makes the write path depend on LLM
phrasing, and a phrasing change becomes a wrong write with no failing test anywhere.

**Agreed with the sibling contract.** `contracts/investigation-api.md` §3.3 types
`recommendedAction.action` as exactly `{ "type": "set_pool_size", "host": "Cloud API", "size": 4 }`
— the same three keys, same spelling, same types, `additionalProperties: false` — so the dashboard
hands it here unmodified. It also maps `recommendedAction.currentValue` onto this endpoint's
`precondition.poolSize`. Both contracts were authored in the same Day-1 batch and both state the
rule, because a mismatch between them would surface as Dev C writing a translation layer, which is
the prose-parsing failure with extra steps.

### 1.3 Response

`200` in every case the request was understood. One shape for all five outcomes, so Dev C
renders from one type rather than from a status code.

```json
{
  "resolveId": "rs-19f3",
  "requestId": "rq-6f2c1e",
  "mode": "apply",
  "outcome": "applied",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 4 },
  "before": { "poolSize": 1, "readAt": "2026-08-18T14:06:41Z" },
  "after":  { "poolSize": 4, "readAt": "2026-08-18T14:06:43Z" },
  "reversal": {
    "host": "Cloud API",
    "size": 1,
    "capturedFrom": "live"
  },
  "refusal": null,
  "failure": null,
  "confirmation": {
    "status": "pending",
    "findingId": "f-1042",
    "clearsWhen": "queue_buildup for Cloud API disappears from GET /api/healthscan/findings",
    "observeVia": ["GET /api/healthscan/findings", "GET /api/healthscan/hosts"],
    "expectedWithinSeconds": 60,
    "directEvidence": "hosts[host=\"Cloud API\"].queued falling"
  },
  "audit": {
    "auditId": "pg-audit-44812",
    "actor": "guardian_resolve",
    "role": "Guardian_Resolve",
    "requestedBy": "presenter@laptop",
    "tool": "SetPoolSize",
    "recordedAt": "2026-08-18T14:06:43Z",
    "source": "live"
  },
  "requestedAt": "2026-08-18T14:06:41Z",
  "completedAt": "2026-08-18T14:06:43Z",
  "replayed": false
}
```

| Field | Type | Notes |
|---|---|---|
| `resolveId` | string | Server-generated, unique per *evaluation*. A replay (§6) returns the original. |
| `requestId` | string \| null | Echoed. `null` when the request omitted it (legal only for `dry_run`). |
| `mode` | string | Echoed, so a stored response is self-describing. |
| `outcome` | string | One of the five in §1.4. **The field Dev C branches on.** |
| `action` | object | Echoed **as evaluated**, not as sent. If the request was refused for being out of bounds, this still shows what was asked for. |
| `before` | object \| null | Live state read immediately before the write. `null` only when nothing could be read (`wrong_production`, `host_not_in_production`, `not_authorized`). |
| `after` | object \| null | Live state read back **after** the update. `null` for `previewed` and for refusals. **Populated even on `failed`** — see §4. |
| `reversal` | object \| null | **A record of the prior value, not a request** — `{host, size, capturedFrom}`. `null` unless `outcome` is `applied`. It is not POSTable: `size` is the shipped value and §3 bounds `action.size` at `2..8`. See §4.1. |
| `refusal` | object \| null | Non-null **iff** `outcome` is `refused`. See §5. |
| `failure` | object \| null | Non-null **iff** `outcome` is `failed`. See §5.2. |
| `confirmation` | object \| null | Non-null **iff** `outcome` is `applied`. `null` for every other outcome — nothing changed, so there is nothing to watch for. See §7. |
| `audit` | object | Always present, for every outcome including refusals and dry-runs. See §8. |
| `requestedAt` / `completedAt` | string | ISO 8601 UTC, `Z`-suffixed, matching `healthscan-api.md`. |
| `replayed` | boolean | `true` when this is a stored result returned for a repeated `requestId`. See §6. |

Every field is always **present**. `before`, `after`, `reversal`, `refusal`, `failure` and
`confirmation` may be `null`; the others are always objects, strings or booleans. A missing key is a
contract violation, a `null` value is not — same rule as `healthscan-api.md` §1, for the same reason.

Advisory response header: `X-Resolve-Outcome`, carrying the same string as `outcome`. Advisory
because the body is authoritative; a consumer may ignore the header entirely.

**CORS.** `Access-Control-Allow-Origin: *` as on the two GETs (Q9). The engine's current
`Access-Control-Allow-Methods` is `GET, OPTIONS` and its preflight sends no
`Access-Control-Allow-Headers`, so implementing this endpoint means widening both to admit
`POST` and `Content-Type`. Noted because the write endpoint will otherwise fail preflight while
the two reads keep working, which looks like a Dev C bug and is not one. See §13 for the
security question `*` raises on a write endpoint.

### 1.4 `outcome` — the five terminal states

| `outcome` | Meaning | Wrote? |
|---|---|---|
| `previewed` | A `dry_run` completed. Every check passed; nothing was written. | **No** |
| `applied` | The pool size changed. `before` ≠ `after`. | Yes |
| `no_change` | Every check passed and the live value already equalled `action.size`. | **No** — see §6 |
| `refused` | The request was understood and declined. Expected, not an error. | **No** |
| `failed` | Checks passed, the write was attempted, and it did not complete. | **Unknown — read `after`** |

Treat the set as **closed**, unlike `HostStatus` in `healthscan-api.md`. A `HostStatus` can grow
with an IRIS version, so the dashboard renders unknown values neutrally. An unknown `outcome`
here means the contract changed underneath the UI on the one endpoint that writes, and the
correct rendering is a hard "unrecognised result — verify the pool size by hand", not a neutral
badge. Defensive rendering means *safe*, not *quiet*.

---

## 2. Dry-run is a mode, not a flag

`mode` is **required and has no default.** A defaulted mode means an omitted field, a typo, or a
half-written client becomes a live write to a production. Fail closed: a request with no `mode`
is `refused` / `malformed_request`, and the engine never infers intent.

It is a `mode` rather than a `dryRun: true` boolean for the same reason. A boolean has a falsy
default in every serialization path — absent, `null`, `""`, `0`, and `"false"` all collapse to
"not a dry run" somewhere between a React state hook and `JSON.parse`. `"apply"` cannot be
arrived at by accident.

**A `dry_run` mutates nothing.** Guaranteed, and the guarantee is structural rather than promised:
`Tools.Resolve` runs the whitelist, bounds, production and RBAC checks and then **returns before the
write**, `if dryRun { set out.outcome = "previewed" … quit out }` — commented in the class as
"Guaranteed not to mutate, structurally: this returns before the write." There is no path from the
preview branch to `%Save()`.

**Corrected 2026-09-01 (#202). This paragraph previously said the dry-run path invokes a separate read
tool `get_pool_size` and "never calls `set_pool_size`", calling non-invocation "a stronger statement
than 'it is invoked with a flag that makes it not write'."** The shipped path is the second thing: the
engine POSTs `{host, size, dryRun}` to the one write tool, which is why a preview audits as
`SetPoolSize` with `{"dryRun":1,…}` (§8) and why `get_pool_size` appears nowhere in the audit table.
The guarantee held throughout — an early `quit` before any write is as structural as a second tool —
but a safety claim that names the wrong mechanism cannot be checked by the person it is written for:
they go looking for a read tool and find that the privileged one ran.

What a `dry_run` returns:

- `outcome: "previewed"` if every check passes, or `refused` with the real reason if any fails.
  **A dry-run that would be refused is refused** — that is the entire point of previewing.
- `before` — the live pool size, measured now.
- `after` — **`null`**, not the projected value. A predicted number in a field named `after` is
  the `lastActivity` coercion defect from #58 and the "forecast presented as a measurement"
  problem `services/detection-engine/CLAUDE.md` §1.1 names for Early Warning. The projected
  value is already in `action.size`; the UI can render "1 → 4" from `before.poolSize` and
  `action.size` without a field that pretends to have been observed.
- `reversal: null` — nothing changed, so there is nothing to reverse. Offering a reversal for a
  no-op invites a "restore" that writes a value nobody measured.
- `confirmation: null` — see §7.
- `audit` — **present**. Dry-runs are audited too (§8).

RBAC is checked in `dry_run`. A preview that succeeds and an apply that then denies is the worst
possible ordering on stage; it also means Dev C can disable the Approve & Apply button from the
preview response rather than discovering the denial on the click that matters.

---

## 3. The whitelist and the bounds

Exactly one action type, exactly one host, one bounded integer range.

| | Allowed | Refusal if not |
|---|---|---|
| `action.type` | `set_pool_size` | `not_whitelisted_action` |
| `action.host` | `Cloud API` | `not_whitelisted_host` |
| `action.size` | integer, `2`–`8` inclusive | `out_of_bounds` |

**`Cloud API` and no other host.** `EMR Source` and `Lab Router` are real hosts in the
production (`iris/labdemo/Production.cls` is the authoritative `<Item>` set) and both have a
`PoolSize`, and neither is whitelisted. `Lab Router` is an
`EnsLib.HL7.MsgRouter.RoutingEngine`: giving a routing engine more jobs lets it process messages
concurrently, and message ordering is not something a performance fix gets to trade away
quietly. Whether that matters for this pipeline is beside the point — MVP 2 is one scenario, and
a host is out until somebody has a reason to put it in.

**`size` lower bound is 2, not 0 or 1.** `1` is the shipped value
(`PoolSize="1"` on the `Cloud API` item), so setting it is a no-op dressed as a fix and reaches
§6 anyway. `0` is excluded because its meaning is adapter- and version-dependent and nobody here
has verified it: on some host classes it means "no dedicated jobs", which would stop the host
processing and produce exactly the `dead_host` finding Smart Resolve exists to avoid causing. It
is excluded rather than reasoned about — an unverified claim about IRIS semantics has no place in
the bounds check of a write tool.

**`size` upper bound is 8.** The recommended action is `4`. The range leaves rehearsal headroom,
because MVP 2 §6 names "pool change does not drain fast enough on stage" as a risk whose
mitigation is "pre-tune the bombard rate and target pool size". It is capped because every pool
job is a real IRIS process: an unbounded `size` lets one fat-fingered digit — or one hallucinated
number — spawn hundreds of jobs and denial-of-service the production this tool is supposed to be
protecting.

**Out of range is refused, never clamped.** Clamping `40` to `8` would apply a change the
operator did not approve, report it as `applied`, and be indistinguishable in the audit log from
someone deliberately choosing `8`. A refusal is legible; a silent correction is not.

### 3.1 Why an allow-list and not a blocklist

A blocklist is only as good as the enumeration of harm that existed when it was written, and it
**fails open**: anything nobody thought of is permitted. An allow-list **fails closed**: a new
action type, a renamed host, a new setting, a typo, and a model that invents a plausible-sounding
tool all land in the same place — refused, with a reason.

That property is load-bearing here specifically because **the action is proposed by an LLM**. The
set of strings a model can produce is not enumerable in advance, so "block the dangerous ones" is
not a strategy that can be completed. It is also why the whitelist is compared by **exact
equality**, not by pattern, prefix or case-insensitive match: `"Cloud API "`, `"cloud api"` and
`"Cloud API/2"` are all refused. A matcher generous enough to accept those is generous enough to
accept something else.

The same reasoning applies to the repo's own history: the whitelist is the mechanism that would
have caught #34, where the instance ran an unrelated `LABDEMO.Production` and a tool that edited
"the production" by name would have edited the wrong one.

### 3.2 Which check is authoritative

Both sides check. Only one of them counts.

- The **engine** validates the whitelist and bounds before calling anything. This is a **UX
  affordance**: it lets Dev C render a refusal without a round trip and keeps a malformed request
  off the privileged path.
- The **MCP write tool inside IRIS** re-validates all of it — whitelist, bounds, production,
  item existence — and its verdict is the one that decides whether a byte changes.

The engine is **not a trust boundary.** It holds no IRIS role of its own, it has no write path in
it (`services/detection-engine/CLAUDE.md` §1.1: "it cannot change a production setting even if a
bug tried to"), and anything reaching `POST /api/resolve` has already crossed an unauthenticated
HTTP hop. A validation that only exists in the caller is a validation an attacker skips by
calling the tool directly. If the two disagree, IRIS wins and the response reports IRIS's reason.

---

## 4. Reversibility — capture the actual prior value

`before.poolSize` is read from the **live** `Ens.Config.Item.PoolSize` immediately before the
write, inside the same call, and returned. `reversal` then records that measured value:

```json
"reversal": {
  "host": "Cloud API",
  "size": 1,
  "capturedFrom": "live"
}
```

`capturedFrom` is always `"live"`; the field exists so that a future value like `"assumed"` would be
visible rather than inferred, and so a mock that cannot read the live value has to say so instead of
emitting a plausible `1`.

### 4.1 `reversal` is a record, not a request — corrected 2026-08-20 (#100)

**This section previously said "Dev C can POST it back verbatim to undo", and wrapped the value in an
`action` object plus an `automatic` flag to make that possible. Both were withdrawn, because the
endpoint would refuse that body.**

`reversal.size` is the *shipped* pool size, which for `Cloud API` is `1` — and §3 bounds `action.size`
at `2..8`, with §5 listing exactly that as `out_of_bounds`. So the contract handed the caller an undo
request and then declined it. That is a self-contradiction inside this document, independent of any
implementation.

**The resolution is that reversal is documentation.** It answers *what was the value before* so an
operator can restore it, and it is deliberately not a body anything POSTs:

- **`1` must stay unapprovable.** §3.6's reason is sound — `1` is the shipped value, so approving it
  is a no-op dressed as a fix that would report success, change nothing, and leave an operator
  believing the problem was addressed. Widening the bound to `1..8` to make the undo POSTable would
  trade a real safety property for a convenience.
- **Restoring the pool is an operator action**, through `Triggers.Reset()`, which is deliberately not
  LLM-callable. "Reversible" means *the prior value is measured, recorded and restorable* — which is
  true, provable and what the demo actually does.
- **A second write path is out of scope.** MVP 2 §1.3 puts a generalised action catalogue in later
  work, and root `CLAUDE.md` §2 now requires a spec before anything beyond the one action is built.

**The shape is now flat, matching what every component already shipped.** `Tools.Resolve`, the engine
and the mock all emitted `{host, size, capturedFrom}` and nothing ever emitted `automatic` — so here
the *contract* was the outlier rather than the code, which is the reverse of the usual direction and
is why it went unnoticed for a week. `action` and `automatic` are removed: an `action` wrapper exists
to make a body dispatchable, and this body is not dispatched.

**Consumer impact: none.** No component is losing a field it emitted or read.

**Never hardcode the restore value.** This is not a hypothetical — it is a bug that was found and
fixed in the exact write path this tool wraps. `Triggers.ErrorRate()` points `Cloud API` at a
closed port, and its restore path used to set the port back to the literal `80`. From
`iris/labdemo/Triggers.cls`:

> Capture the real port BEFORE overwriting it. `Production.cls` says HTTPServer/HTTPPort/
> Credentials are the only settings that depend on the deployment and should be overridden per
> environment — so "restore it to 80" would silently break any environment that followed that
> instruction. **Reproduced: with the port at 8443, arm-then-Reset() left it at 80.**

`Reset()` now restores `^ProductionGuardian.Trigger("PortWas")`, and — the part most likely to be
missed — when nothing was stashed it *leaves the setting alone*, because "the port is whatever the
environment configured and must be left alone; touching it would be this method inventing a
deployment setting."

Applied here: `PoolSize` is `1` in `Production.cls` **today**, so a hardcoded `"restore to 1"`
would be right today and silently wrong the first time anyone rehearses at `2`, ships a tuned
default, or runs the demo twice without a reset. A hardcoded restore value is not a shortcut; it
is a second write, to a value nobody measured, disguised as an undo.

Two further consequences:

- **`before` is measured, never inherited.** It does not come from `precondition.poolSize`, from
  the finding's `currentValue`, or from the investigation payload — all three are claims made
  earlier by something else. It is read off the live production definition (`+item.PoolSize`)
  inside the write tool, at the moment of the call — not from a prior read tool's answer, which
  would be a claim made earlier by something else too.
- **There is no automatic rollback on failure**, hence `automatic: false`. A failed
  `Ens.Director.UpdateProduction()` may have already `%Save()`d the config, so the live state
  after a failure is genuinely unknown, and a blind rollback write is a second unverified
  mutation on top of the first. Instead, `after` is **always read back**, including on `failed`,
  so the caller learns the real state and a human decides. Reversal is an operator action with an
  audit entry of its own, not an error handler.

---

## 5. Refusals — ten distinguishable states

A refusal is `200`, `outcome: "refused"`, and a populated `refusal`:

```json
"refusal": {
  "reason": "out_of_bounds",
  "message": "size 40 is outside the allowed range 2-8 for set_pool_size",
  "bounds": { "min": 2, "max": 8 },
  "checkedBy": "iris"
}
```

| `reason` | Fires when | `before` populated? |
|---|---|---|
| `not_authorized` | The resolved actor does not hold the write role — see §5.1 | no |
| `not_whitelisted_action` | `action.type` is not exactly `set_pool_size` | no |
| `not_whitelisted_host` | `action.host` is not exactly `Cloud API` | no |
| `out_of_bounds` | `action.size` is not an integer in `2`–`8` | yes |
| `wrong_production` | The running production is not `ProductionGuardian.LabDemo.Production` | no |
| `production_not_running` | The right production exists but is not in state Running — see §9.2 | no |
| `host_not_in_production` | Whitelisted host name is absent from the running config — see §9.2 | no |
| `precondition_failed` | `precondition.poolSize` does not equal the live value | **yes** |
| `unattributable` | No IRIS principal could be resolved for the call — see §8 | no |
| `malformed_request` | Missing `mode`, missing `action`, missing `requestId` on an `apply`, wrong types, unknown key inside `action` | no |

`refusal.message` is **human-readable and authoritative** — render it as-is, do not reconstruct
it, exactly as `Finding.message` works in `healthscan-api.md` §2. `refusal.reason` is what code
branches on. `refusal.checkedBy` is `"engine"` or `"iris"` and is diagnostic only (§3.2);
`bounds` appears only for `out_of_bounds`.

The list is longer than it needs to be to *stop* a bad write, and that is the point. Every one of
these could be a single `refused` with a sentence, and then the UI could only ever say "no". They
are separate because the correct next action differs: `not_authorized` means find someone with
the role, `precondition_failed` means re-read and re-approve, `wrong_production` means the
instance is not the one you think it is, and `host_not_in_production` means somebody renamed an
item. Collapsing them makes the dashboard's denied state a shrug.

Treat this set as **closed**, per §1.4. An unrecognised `reason` should render
`refusal.message` verbatim and still show the request as refused — never as applied.

**`400` is reserved for one case:** a body that is not parseable JSON, or a missing/incorrect
`Content-Type`. There is no request to evaluate, so there is no `outcome` to report and no audit
subject. A *well-formed* body with bad contents is always `200` + `refused` /
`malformed_request`, because that request was understood, evaluated and declined.

### 5.1 RBAC denial is a normal response, not an error

`not_authorized` is `200`. It is not `403`, and it is not a `500`.

Three reasons, in ascending order of how much they cost when ignored:

1. **The demo requires it to be renderable.** MVP 2 §5.4 lists "disabled if unauthorized" as a
   deliverable and its acceptance criterion is "the RBAC-denied state is visible". A state that
   is visible has to arrive in a shape the UI can lay out, with a message next to it.
2. **A status code carries one bit and gets swallowed.** Dev C's client branches on `res.ok`;
   every generic fetch wrapper turns a non-2xx into a thrown error and a generic banner. The
   specific, informative refusal becomes "something went wrong" in the layer above the one that
   knew.
3. **It matches the precedent already ratified in this directory.** `healthscan-api.md` §3:
   zero findings is `200` + `[]`, never `404`; an unreachable upstream is `200` + labelled stale
   data, because "a blanked dashboard is worse on stage than a slightly old one". `500` is for a
   genuine fault. A refusal is not a fault — it is the safety model working.

An authorized caller and an unauthorized one differ **only** in `outcome`, `refusal` and the
absence of `before`/`after`. Same endpoint, same status, same shape. Dev C mocks the denied state
by changing two fields.

The demo depends on this being real rather than cosmetic: MVP 2 §2.2 wants to show that "AI
Detective can look without having permission to act". The read tools (`GetHostStatus`,
`GetQueueDepth`, `GetPoolSize`, `GetRecentErrors`, `GetProcessingTime`) are granted more
broadly; only the write tool needs the privileged role. So an unauthorized caller can still get
a full `dry_run` refusal *with* `before` unavailable and a complete investigation — which is the
point being demonstrated, not a degraded mode.

### 5.2 A refusal is not a failure

`refused` and `failed` are different outcomes and must not be merged in the UI.

- **`refused`** — the system decided not to act. Nothing was written. **The safety model
  worked.** The operator's next step is to change something about the request or the environment.
- **`failed`** — the system decided to act, tried, and did not complete. Something is wrong with
  the instance, not with the request.

```json
"failure": {
  "stage": "update_production",
  "message": "ERROR #5001: Ens.Director.UpdateProduction() returned an error",
  "liveStateVerified": true
}
```

| `failure.stage` | Where it broke | What `after` means |
|---|---|---|
| `transport` | The engine could not reach the MCP tool at all | `null` — nothing was attempted |
| `authorize` | Role resolution itself errored (distinct from a clean denial) | `null` |
| `save` | `%Save()` on the config failed | Read back; probably unchanged |
| `update_production` | Config saved, `UpdateProduction()` failed | Read back; **config and running state may disagree** |
| `verify` | The write returned OK but the read-back did not show `action.size` | Read back; trust `after` over the write |

`liveStateVerified` says whether `after` is a real read or whether even the read-back failed.
`false` means the response cannot tell you what the pool size is, and a human must look — which
is a worse outcome than a refusal and should be rendered as such. A `verify` failure in
particular is why the read-back exists at all: "the write returned OK" and "the production has
the new value" are two claims, and only the second one is the one anybody cares about.

---

## 6. Idempotency and double-apply

The demo will hit this. A presenter clicks Approve & Apply, nothing visibly happens for two
seconds, and they click again.

**Two independent mechanisms, because they answer different questions.**

**1. The action is absolute, so applying it twice is harmless.** `set_pool_size(host, size)` sets
a value; it does not adjust one. There is deliberately no `increase_pool_size(by: 3)` in the
vocabulary: a relative action applied twice compounds, and a retried relative write is unbounded
— exactly the failure the §3 cap exists to prevent, arriving through the front door. An absolute
setter applied N times leaves the same state as applying it once.

**2. Already at the target is `no_change`, not `applied`.**

```json
{ "outcome": "no_change", "before": { "poolSize": 4 }, "after": { "poolSize": 4 }, "reversal": null }
```

`no_change` is a distinct outcome and not a flavour of `applied` for two reasons:

- An operator shown "applied" for a call that changed nothing cannot distinguish a working fix
  from a no-op, and the second click on stage is precisely when that distinction matters.
- **`no_change` guarantees `Ens.Director.UpdateProduction()` was not called.** That is a real
  behavioural promise, not bookkeeping: `UpdateProduction()` restarts affected pool jobs, so
  re-applying `4` over `4` would briefly drop `Cloud API` throughput to zero — during the drain,
  in front of an audience, undoing the thing being demonstrated. Not calling it is the safe
  behaviour; `no_change` is how the caller knows it was not called.

`reversal` is `null` on `no_change` for the §4 reason: reversing to a value that was never
changed means writing a number nobody measured.

**3. The same `requestId` twice returns the first result.** `requestId` is required for `apply`
and is the replay key. A repeat within the replay window returns the **stored original response
verbatim** — same `resolveId`, same `before`/`after`, same `audit.auditId` — with
`replayed: true`. It does not re-evaluate and does not re-call the tool.

This is what makes the double-click correct rather than merely harmless. Without it, the second
click *would* return `no_change` (which is fine) but would also mint a second audit entry for one
human decision, and MVP 2 §3's final demo step is showing the audit log. One approval, one audit
event.

Constraints, stated rather than implied:

- **The replay window is in-memory and bounded** — 10 minutes, most-recent-N. It is not
  persisted, consistent with ADR 0002's "nothing persisted" stance for this service. **An engine
  restart forgets it**, so a `requestId` replayed across a restart is evaluated as a fresh
  request. That is acceptable because mechanism 1 and 2 make re-evaluation safe; it is written
  down because "idempotent" without a stated window is a promise the implementation is not
  making.
- A **different** `requestId` with the same `action` is a genuinely new request and is evaluated
  normally — landing on `no_change` if the value already matches. Deliberate: two operators
  independently deciding the same thing are two decisions, and both belong in the audit log.
- Reusing a `requestId` with a **different** `action` is `refused` / `malformed_request`. Returning
  the stored result would answer a question that was not asked; evaluating it would make the
  replay key meaningless.

---

## 7. Confirmation is asynchronous, and this contract says so out loud

The requirement is "confirm the condition clears" (MVP 2 §1.1). **This response cannot do that**,
and pretending otherwise would be the most consequential lie in the contract: the caller would
render "fixed" on the strength of a config write.

`Ens.Director.UpdateProduction()` returns in well under a second. The queue then drains over tens
of seconds, and the `queue_buildup` finding disappears only after the rule stops breaching —
which is gated by the engine's poll interval (5000 ms) and the sustained-breach gates in
`thresholds.json` (`sustainedSamples: 2`, `sustainedSeconds: 4`). So the earliest a cleared
finding can *possibly* be observed is measurably after the write returns, by construction.

Therefore `confirmation` **hands the caller the observation path instead of a verdict**:

```json
"confirmation": {
  "status": "pending",
  "findingId": "f-1042",
  "clearsWhen": "queue_buildup for Cloud API disappears from GET /api/healthscan/findings",
  "observeVia": ["GET /api/healthscan/findings", "GET /api/healthscan/hosts"],
  "expectedWithinSeconds": 60,
  "directEvidence": "hosts[host=\"Cloud API\"].queued falling"
}
```

| `confirmation` | When |
|---|---|
| `{ "status": "pending", … }` | `outcome: "applied"`, and only then. The write landed; clearing is now observed elsewhere. `pending` is the only value `status` ever takes. |
| `null` | Every other outcome. Nothing was changed, so there is nothing to confirm. |

**Corrected 2026-09-01 (#202): a non-`applied` outcome carries `null`, not an object with
`status: "not_applicable"`.** This section, the §3 field table and three §11 samples all promised the
object form; the engine, the dashboard's guard and types, both mocks and two tests have all shipped
`null` since MVP 2. The document was the only holdout, so it was the document that moved — and the
`null` form is also the safer of the two, because a consumer that branches on presence rather than on
`status` cannot then render a clearance countdown for a preview. A consumer must still not infer
"nothing happened" from `confirmation: null` alone: `outcome` is the field to branch on, and a `failed`
apply carries `null` here while having possibly written (§5.2).

`clearsWhen` is authoritative human-readable text (same rule as `Finding.message`).
`expectedWithinSeconds` is **advisory and explicitly not a promise** — MVP 2 §6 lists "pool
change does not drain fast enough on stage" as a live risk whose drain rate "depends on the
dispatcher hang value and the chosen target pool size". A countdown rendered from this number
must degrade to "still draining" rather than to "failed", because the number is a rehearsal
estimate and the finding path is the truth.

There is deliberately **no callback, no webhook, and no `GET /api/resolve/{id}` poll**.
Confirmation already exists: it is `healthscan-api.md`, which Dev C already polls and already
renders, and where a finding disappearing is already the documented signal for "condition cleared"
(Q4: findings vanish when cleared, no tombstones). Adding a second channel that says the same
thing creates a way for the two to disagree.

**And one honest caveat, because it would otherwise be discovered on stage.**
`services/detection-engine/CLAUDE.md` §5.1 documents baseline self-inflation: the rolling mean
includes the breaching samples, so a sustained problem becomes the new normal and its comparative
finding clears **while the bad value persists**. `queue_buildup` is a comparative rule. So:

> **A cleared `queue_buildup` finding is necessary but not sufficient evidence that the fix
> worked.** The finding can clear because the baseline caught up rather than because the queue
> drained.

That is why `directEvidence` exists and names `hosts[].queued`. The queue depth falling is the
direct measurement; the finding clearing is the derived signal. A confirmation UI that shows both
is honest and — since the demo's whole claim is "the queue drains on screen" — also more
convincing than a badge.

---

## 8. Audit — the contract does not permit an unattributed write

**Every call produces exactly one attributable audit event: applies, refusals, and dry-runs
alike.** `audit` is present in every response.

**It is a property of the runtime for executions, and of OUR authorization policy for denials.**
Corrected 2026-08-19 (#95). This paragraph previously said "a property of the runtime, not of our
discipline" — which is true of everything the runtime sees and false of the one event it does not.

`%AI.Policy.Audit`'s `%LogExecution(call, metadata, result, duration, status)` is called after every
*execution*, and taking `status` and `duration` does make a refusal, a dry-run and a failure
first-class auditable events. But `%AI.ToolMgr.ExecuteTool` checks authorization *before* executing,
so an authorization denial throws and never reaches that hook: measured, **0 rows written** with a
deny-all policy registered. `Tools.AuthPolicy` writes that row itself, which is why §11.3's
RBAC-denied example can carry a populated `audit` block naming the refused identity.

So "we audit attempts" holds, and it holds because two components cooperate. Anything that adds a
new deny path must write its own row or the refusal leaves no trace. A preview that leaves no trace
is not reviewable; a *denial* that leaves none is worse.

**THERE IS NO AI HUB AUDIT STORE.** `auditId` values in this document were written as
`aihub-audit-*` and are now `pg-audit-*`. `%AI.Policy.ConsoleAudit` — the only shipped
implementation — writes a coloured box to the current device and returns; there is no `%AI.Audit.*`
persistent class in the image (verified: `%AI.Policy.Audit` is the abstract base and
`%AI.Policy.ConsoleAudit` its only concrete subclass, and no `%AI.Audit*` class exists at all). The
record is `ProductionGuardian.LabDemo.Audit.Entry` and the handle is ours.

The value is opaque either way — §9.3 already tells Dev C to render it as a string and never compare
it to a literal — but the *provenance* it implied was not. `aihub-audit-*` claims a system of record
that would not survive someone going to look for it, which is the same defect this document names in
the mock's own words: "inventing an id that resolves to nothing is worse than admitting there is
none."

```json
"audit": {
  "auditId": "pg-audit-44812",
  "actor": "guardian_resolve",
  "role": "Guardian_Resolve",
  "requestedBy": "presenter@laptop",
  "tool": "SetPoolSize",
  "recordedAt": "2026-08-18T14:06:43Z",
  "source": "live"
}
```

| Field | Notes |
|---|---|
| `auditId` | Handle into the **Production Guardian** audit trail (`Audit.Entry`), so the UI can link to the record MVP 2 §3's last demo step shows. AI Hub persists nothing itself — see above. `null` when the record could not be written, and if it could not be written for an `apply`, that is `failed` / `verify`, not a silent success. Retrievable: `Audit.Entry.Describe(handle)` returns the block below. |
| `actor` | **The authenticated IRIS principal, resolved server-side.** The identity the RBAC decision was made about. |
| `role` | The role that authorized (or, on `not_authorized`, the role that was required). Lets the UI say *what* is missing. |
| `requestedBy` | The request's advisory label, echoed. Recorded **next to** `actor`, never in place of it. |
| `tool` | **The runtime's own method name, `SetPoolSize`** — on an apply *and* on a dry-run, because the preview goes through the same write tool with `dryRun` set (§2). **PascalCase, and not the same string as `action.type`.** `action.type` is this contract's wire enum, `set_pool_size`; `tool` is what `Audit.Entry.Tool` stores, and reading it as a snake_case name is what #202 corrected here. Render it, never compare it to a literal. |
| `recordedAt` | ISO 8601 UTC. |
| `source` | `"live"` \| `"mock"`. |

`duration` is not in this block, and where the runtime does report it (`%LogExecution`) it is integer
milliseconds and reads **0** for every read tool — `ExecuteTool` timed the same call at `0.0071 s`.
Noted so a reader comparing a duration column of zeroes against §5.5 of `mcp-tools.md` does not
conclude the field is broken.

**`actor` is not a request field, and a caller cannot name itself.** `requestedBy` is a string a
browser typed; treating it as identity would make the audit log a record of what the client
claimed rather than of who acted, which is worse than no audit log because it is trusted. The
actor is resolved from the credential the IRIS-side tool authenticates with, and it is returned
so the operator can see which identity acted.

**If no principal resolves, nothing is written.** `outcome: "refused"`, `refusal.reason:
"unattributable"`. There is no path through this contract that mutates the production without a
named actor — an unattributed write is not a degraded mode, it is a contract violation. MVP 2
§2.2 is explicit that the purpose of the audit trail is that "the AI changed a production
setting" is a reviewable, attributable event; an anonymous write defeats the entire reason the
tool lives in IRIS instead of in the engine.

**Dry-runs are audited.** Two reasons. A preview reads live production configuration, and reads
are audited by design (MVP 2 §2.2: "every MCP tool call, read and write"). And "who was probing
the production, and when" is part of the same story as "who changed it" — an audit log with a
hole where the reconnaissance was is a partial account. It is also not optional: the dry-run path
invokes the write tool through the same governed path, so `%LogExecution` runs for it whether or not
anyone wanted it to — and the row is indistinguishable from an apply except by its arguments,
`{"dryRun":1,"host":"Cloud API","size":4}`. **A reviewer counting writes must read `Arguments`, not
just `Tool`.**

**Refusals are audited.** Including `not_authorized`. A denied attempt is the security-relevant
event in the set — an audit trail that records only what succeeded cannot answer "did anything try
to write to the production", which is the question a healthcare operations review actually asks.
This is why §11.3's RBAC-denied example carries a populated `audit` block naming the refused
identity.

**`source: "mock"` is mandatory for the mock resolve.** ADR 0004 keeps mock-first, and MVP 2 §5.3
ships a mock resolve. A mock response that reports `"live"` produces a screenshot, a rehearsal
recording, or a support ticket in which a simulated write is indistinguishable from an audited
one. The mock also carries `auditId: null` — it has no audit entry, and inventing an id that
resolves to nothing is worse than admitting there is none. This is `never invent data` (root
`CLAUDE.md` §6) applied to the field where inventing it matters most.

**The LLM boundary, for completeness.** The resolve path sends nothing to the external model at
all — it is a deterministic tool call over a structured action (§1.2). The reasoning already
happened in AI Detective. Root `CLAUDE.md` §2.1's rule still binds everything upstream: metrics
and configuration only, never message content, never PHI.

---

## 9. The MCP write-tool boundary

### 9.1 What `set_pool_size(host, size)` wraps

One mutating tool, in IRIS, in the AI Hub instance. It wraps the path
`iris/labdemo/Triggers.cls` already proves in this production:

1. `##class(Ens.Config.Production).%OpenId("ProductionGuardian.LabDemo.Production")`
2. Find the `Ens.Config.Item` whose `.Name` equals `host`
3. Set `item.PoolSize`
4. `def.%Save()`
5. `##class(Ens.Director).UpdateProduction()`
6. Read `item.PoolSize` back and return it as `after`

The tool is a **`%AI.Tool` subclass implementing `%Invoke`**. `%AI.Tool` is abstract and supplies
`%Invoke` / `%Discover` / `%Encode` / `%Decode` / `%ToolError` on the instance and
`%FromObject` / `%ToObject` / `%TypeMode` on the class, so the tool inherits an error convention
rather than needing one invented: **`%ToolError` is the failure mechanism**, and §5.2's
`failure.stage` values are a mapping of it onto the wire, not a parallel scheme.

**Step 3 is a property, not a setting.** `PoolSize` is a property of `Ens.Config.Item`
(`PoolSize As %Library.Integer`, alongside `Name`, `Enabled`, `Category`, `Settings`), so the
tool assigns `item.PoolSize` directly. It does **not** go through the `Settings` collection the
way `Triggers.SetSetting()` does, and it does not add an `Ens.Config.Setting` row named
`PoolSize`. Worth stating because `SetSetting` is the closest existing code and copying it here
would produce a setting row that changes nothing while reporting success — the exact failure mode
#66 was filed about, in a new place. Verified against `Ens.Config.Item` on the live instance, not
assumed from the `PoolSize="1"` attribute in the XData, which is a different serialization.

The engine's role is limited to: validate, call, record the request, record the response, and
return this document's shape. `services/detection-engine/CLAUDE.md` §1.1 again — the engine is a
caller, not an author of change.

### 9.2 The guards, and one deliberate divergence from `Triggers.cls`

The write tool must carry the guards `Triggers.cls` earned the hard way. Each maps to a §5
refusal reason:

| Guard | Modelled on | Refusal |
|---|---|---|
| The running production must be `ProductionGuardian.LabDemo.Production` | `Triggers.CheckProduction()` | `wrong_production` |
| The named item must exist in the running config | `Triggers.SetSetting()`'s `foundItem` | `host_not_in_production` |
| Whitelist and bounds | §3, re-checked in IRIS | `not_whitelisted_*`, `out_of_bounds` |
| Role check before any read of live config | §5.1 | `not_authorized` |

**The production check.** `CheckProduction()` exists because "the instance ran an unrelated
LABDEMO.Production until 2026-08-12, and a trigger that silently edits the wrong production is
worse than one that refuses (#34)". Same reasoning, higher stakes: these triggers manipulate a
demo, this tool answers to an approval click.

**The item check.** `SetSetting()` tracks whether the *item* was found, not just the setting,
because without it "an unknown item makes this method a silent no-op, so a rename in
`Production.cls` would have `ErrorRate()` print ARMED having changed nothing — and
`CheckProduction()` would not catch it, since it only compares the production NAME". The same
sentence rewritten for this endpoint is: a rename would have `POST /api/resolve` return
`applied` having changed nothing. `host_not_in_production` is the refusal that makes it loud. The
generalisation from #66 is worth keeping in one line: **a tool that reports success having done
nothing is the worst failure it can have.**

**And one place this tool must be STRICTER than the proven path.** `CheckProduction()` treats a
production that is not Running as a *warning*, not a refusal:

```objectscript
// state 1 is Running. A stopped production accepts config edits that take effect on
// start, which is confusing rather than wrong -- so warn instead of refusing.
if state '= 1 {
    write "NOTE  production state is ", state, ", not Running. Changes apply on start."
}
```

That is right for a trigger that arms a condition for later. It is **wrong here**, and
`production_not_running` is a refusal rather than a warning. This contract promises `after` is a
read-back of live state and that `confirmation` leads to a condition clearing. Against a stopped
production, `%Save()` succeeds, `UpdateProduction()` changes no running job, `after` reports the
saved value, and the response says `applied` — while nothing drains, because nothing is running.
The response would be true field by field and false as a whole.

**This divergence is deliberate and is called out because it is a divergence.** Someone will read
`Triggers.CheckProduction()`, see a warning, and "align" the tool with the proven path. The
proven path is proven for a different job.

### 9.3 RBAC, and where the check actually happens

- **One dedicated IRIS role gates `set_pool_size`.** Nothing else needs it, and no read tool has
  it. Least privilege, and it is what makes MVP 2 §2.2's demonstration real: AI Detective can
  look and cannot act.
- **The read tools are granted more broadly** — `GetHostStatus`, `GetQueueDepth`, `GetPoolSize`,
  `GetRecentErrors`, `GetProcessingTime`. **The dry-run path uses none of them**: it goes through the
  write tool with `dryRun`, so it needs the privileged role, which is why RBAC is checked in `dry_run`
  and why a preview is refused for an unauthorized caller (§2).
- **The role name, its grants, and the tool catalogue belong to `contracts/mcp-tools.md`**, which
  MVP 2 §2.4 makes a separate contract. Dev C must render `audit.role` as an opaque string and
  never compare it to a literal — this contract deliberately does not fix its value, so that
  choosing it later is not a breaking change to the dashboard.

  **Reconciled with `mcp-tools.md` §1 after both landed, and they agree** — but only once you read
  the distinction it draws, which is easy to miss and looks like drift:

  | | `mcp-tools.md` calls it | appears in this contract as |
  |---|---|---|
  | IRIS **resource** — what is gated | `PG_Resolve` (write), `PG_Read` (read) | not published; internal to the gate |
  | IRIS **role** — what a caller holds | `Guardian_Resolve`, `Guardian_Read` | `audit.role` |

  So `audit.role: "Guardian_Resolve"` in §11 and "executable by `PG_Resolve`" in the catalogue are
  the same rule stated from two ends, not two names for one thing. A reader grepping for one string
  and finding the other should not "fix" it. The resource is the thing `%CanExecute` tests; the role
  is the thing an audit record can attribute an action to, which is why only the latter is in this
  contract's response shape.

### 9.4 Authorization and audit are enforced by the runtime, not by the tool

Source for everything in this section: `docs/mvp2-aihub-verified-api.md`, introspected from the
running `pg-iris` container. Cited rather than restated, so there is one place this is maintained.

The two governance hooks are AI Hub policy classes:

```
%AI.Policy.Authorization
  %CanExecute(tool, call, metadata) -> %Status
  %CanList(tool, metadata)          -> %Boolean

%AI.Policy.Audit
  %LogExecution(call, metadata, result, duration, status) -> %Status
```

**They are invoked by the runtime around every tool execution, in a fixed order.** This is read
from the shipped implementation of `%AI.ToolMgr.ExecuteTool` in the running container, whose own
comment states that the call into the Rust tool manager:

```
// 1. Checks AuthorizationPolicy.can_execute()
// 2. Executes the tool via provider
// 3. Calls AuditPolicy.log_execution()
// 4. Returns result as %DynamicObject
```

Three consequences, and they are the reason this contract can make promises it otherwise could
not:

1. **A tool author cannot forget to check permissions.** `%CanExecute` is not something
   `set_pool_size`'s `%Invoke` calls; it is something the invocation path calls before `%Invoke`
   runs at all. So this contract states as a **guarantee, not a convention**: every call to the
   write tool is authorization-checked and audited. Not "every call we remembered to gate" — a
   carelessly written `%Invoke` is still gated.
2. **Authorization precedes execution, so a denied call cannot have partially mutated the
   production.** This is why `not_authorized` always has `before: null` and `after: null` (§5) and
   why the refusal is safe to render as "nothing happened" rather than "state unknown". On an
   endpoint that writes to a live production, "the check runs first" and "the check runs" are
   different claims and only the first one closes the partial-write question.
3. **Read from the implementation, not inferred from the class list.** Stated that way
   deliberately: "the policy classes exist" and "the policy classes are enforced" are different
   claims, and only the second is worth anything on a live production. This documents the second.

**`%CanExecute` returns `%Status`, not a boolean** — so a denial carries a machine-readable
reason, which is what makes §5.1's renderable denied state possible at all rather than a bare
"no". That reason is what fills `refusal.message`, subject to one constraint: **the message must
not leak detail a denied caller should not have.** It names what was required (the role) and what
was refused (the tool). It must not enumerate who does hold the role, echo credential material,
or report live configuration — which is the other reason `before` is `null` on `not_authorized`.

**`%CanList` is separate from `%CanExecute`, so visibility and executability are gated
independently.** This contract requires the action be **listable to an unauthorized caller and not
executable** — present-but-denied, not hidden.

Two reasons. A hidden action is indistinguishable from a broken dashboard: the operator sees no
Smart Resolve panel and has no way to learn that a fix exists and that they lack the role to apply
it, which is worse operationally than a disabled button with a reason. And MVP 2 §5.4's acceptance
criterion is that "the RBAC-denied state is **visible**" — a hidden action cannot satisfy it. The
demo point being made (§5.1) is that AI Detective can look without being able to act, and that is
only demonstrable if the thing it cannot do is on screen.

**What is NOT yet settled: whether the configured policy actually denies.** `%AI.Policy.Authorization`
and `%AI.Policy.Audit` are abstract bases, and `%AI.Policy.ConsoleAuth` / `%AI.Policy.ConsoleAudit`
exist alongside them, so *some* policy is wired by default. Whether the default permits everything
until a real one is registered is **unverified** (§13.3). "Enforced by the runtime" is a safety
property only if the policy it enforces denies something. So this contract requires two things of
the IRIS side, and they are acceptance criteria rather than notes:

- **Our own Authorization policy is registered**, not left on whatever ships as the default.
- **Denial is tested.** An unauthorized caller must be observed being refused, with the refusal
  arriving in this document's shape. `services/detection-engine/CLAUDE.md` §8 already states the
  general form of this — "a schema test that only checks valid input proves nothing; prove
  rejection too" — and on the write path it is the only test that proves the safety model exists.

---

## 10. What Smart Resolve is NOT

| Not this | Why / where it belongs |
|---|---|
| **Autonomous remediation** | Human approval by default (root `CLAUDE.md` §2.1; MVP 2 §1.3). There is no `mode` that acts unattended, no confidence threshold that skips approval, and no scheduler. `apply` is only ever the direct consequence of a click. |
| **A general action catalogue** | One action type, one host, one bounded range (§3). A catalogue is later work — MVP 2 §7.3 lists "a second recommended action type" as an *optional enhancement, once the first is proven end to end.* |
| **Multiple action types** | `action.type` has exactly one legal value. Adding a second is a contract PR, not a config change (§12). |
| **A remediation engine, a runbook runner, or a tuning advisor** | Tuning advice is Performance Coach; a 0–100 score is Health Score; summaries are Health Summary; chat is Ask Guardian (root `CLAUDE.md` §2.2). |
| **A restart / stop / start control** | Nothing here starts, stops, disables or enables anything. `set_pool_size` is the only mutation, and `size: 0`-as-stealth-disable is excluded by the bounds (§3). |
| **Root-cause analysis** | AI Detective's job, in IRIS. This endpoint receives a decision; it does not make one. |
| **A confirmation oracle** | It cannot tell you the condition cleared (§7). It tells you where to look. |
| **A trust boundary** | The engine validates for convenience; IRIS decides (§3.2). |

---

## 11. Worked examples

Four, matching the four states Dev C's Smart Resolve panel has to render. These are the mock
payloads until `samples/` files land.

### 11.1 Dry-run / preview — nothing written

Request:

```json
{
  "mode": "dry_run",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 4 },
  "origin": { "findingId": "f-1042", "investigationId": "inv-8801" }
}
```

Response `200`, `X-Resolve-Outcome: previewed`:

```json
{
  "resolveId": "rs-19f2",
  "requestId": null,
  "mode": "dry_run",
  "outcome": "previewed",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 4 },
  "before": { "poolSize": 1, "readAt": "2026-08-18T14:06:12Z" },
  "after": null,
  "reversal": null,
  "refusal": null,
  "failure": null,
  "confirmation": null,
  "audit": {
    "auditId": "pg-audit-44810",
    "actor": "guardian_resolve",
    "role": "Guardian_Resolve",
    "requestedBy": null,
    "tool": "SetPoolSize",
    "recordedAt": "2026-08-18T14:06:12Z",
    "source": "live"
  },
  "requestedAt": "2026-08-18T14:06:12Z",
  "completedAt": "2026-08-18T14:06:12Z",
  "replayed": false
}
```

Note `after: null` and `confirmation: null` — nothing was written, so there is nothing to read back
and nothing to watch for. `tool` still reads `SetPoolSize`: the write tool ran and returned before
the write (§2), which is what the audit row records. The UI renders "1 → 4" from `before.poolSize`
and `action.size`.

### 11.2 Apply — succeeded, with before and after

Request:

```json
{
  "requestId": "rq-6f2c1e",
  "mode": "apply",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 4 },
  "origin": { "findingId": "f-1042", "investigationId": "inv-8801" },
  "precondition": { "poolSize": 1 },
  "requestedBy": "presenter@laptop"
}
```

Response `200`, `X-Resolve-Outcome: applied` — the full payload is the one in §1.3. The
load-bearing parts:

```json
{
  "outcome": "applied",
  "before": { "poolSize": 1, "readAt": "2026-08-18T14:06:41Z" },
  "after":  { "poolSize": 4, "readAt": "2026-08-18T14:06:43Z" },
  "reversal": {
    "host": "Cloud API",
    "size": 1,
    "capturedFrom": "live"
  },
  "confirmation": { "status": "pending", "findingId": "f-1042" },
  "audit": { "actor": "guardian_resolve", "auditId": "pg-audit-44812", "source": "live" }
}
```

`reversal.action.size` is `1` because `before.poolSize` was **measured as** `1` — not because
`Production.cls` says `PoolSize="1"` (§4).

### 11.3 RBAC-denied — a normal response

Same request as §11.2, from a caller without the write role. Response `200`,
`X-Resolve-Outcome: refused`:

```json
{
  "resolveId": "rs-19f4",
  "requestId": "rq-6f2c1e",
  "mode": "apply",
  "outcome": "refused",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 4 },
  "before": null,
  "after": null,
  "reversal": null,
  "refusal": {
    "reason": "not_authorized",
    "message": "caller is not authorized to invoke set_pool_size; the write role is required",
    "checkedBy": "iris"
  },
  "failure": null,
  "confirmation": null,
  "audit": {
    "auditId": "pg-audit-44813",
    "actor": "guardian_readonly",
    "role": "Guardian_Resolve",
    "requestedBy": "presenter@laptop",
    "tool": "SetPoolSize",
    "recordedAt": "2026-08-18T14:07:02Z",
    "source": "live"
  },
  "requestedAt": "2026-08-18T14:07:02Z",
  "completedAt": "2026-08-18T14:07:02Z",
  "replayed": false
}
```

`200`, not `403` (§5.1). `audit.actor` is the identity that was *refused* — a denial is an
attributable event too. `audit.role` names what was required, so the UI can say what is missing.
`before` is `null`: an unauthorized caller does not get a live configuration read out of a
refusal.

### 11.4 Out of bounds — refused, not clamped

Request (`size: 40`):

```json
{
  "requestId": "rq-6f2c22",
  "mode": "apply",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 40 },
  "origin": { "findingId": "f-1042" }
}
```

Response `200`, `X-Resolve-Outcome: refused`:

```json
{
  "resolveId": "rs-19f5",
  "requestId": "rq-6f2c22",
  "mode": "apply",
  "outcome": "refused",
  "action": { "type": "set_pool_size", "host": "Cloud API", "size": 40 },
  "before": { "poolSize": 1, "readAt": "2026-08-18T14:07:20Z" },
  "after": null,
  "reversal": null,
  "refusal": {
    "reason": "out_of_bounds",
    "message": "size 40 is outside the allowed range 2-8 for set_pool_size",
    "bounds": { "min": 2, "max": 8 },
    "checkedBy": "engine"
  },
  "failure": null,
  "confirmation": null,
  "audit": {
    "auditId": "pg-audit-44814",
    "actor": "guardian_resolve",
    "role": "Guardian_Resolve",
    "requestedBy": null,
    "tool": "SetPoolSize",
    "recordedAt": "2026-08-18T14:07:20Z",
    "source": "live"
  },
  "requestedAt": "2026-08-18T14:07:20Z",
  "completedAt": "2026-08-18T14:07:20Z",
  "replayed": false
}
```

`action.size` still echoes `40` — the request as sent, not a corrected version — and `after` is
`null` because nothing was written. `checkedBy: "engine"` shows the engine caught it first;
IRIS would have refused identically (§3.2).

---

## 12. The Day-1 questions, answered before they were asked

`healthscan-api.md` §4 answers questions Dev C raised on issue #1. These are answered in advance,
because this contract is published on Day 1 against no implementation and the questions are
predictable. Marked `R` and not `Q`: the dashboard already carries `// CONTRACT-Q<n>` markers
that mean Health Scan question `n`, and a colliding marker would make the grep-based
reconciliation `README.md` describes ambiguous on the one contract where being sure matters.
Convention: `// RESOLVE-R<n>: <the assumption, stated inline>` — naming only the number sends the
reader back to this table.

| # | Question | Answer |
|---|---|---|
| **R1** | Is dry-run a separate call or a flag? | A required `mode` with no default (§2). `dry_run` never invokes the write tool at all. |
| **R2** | What HTTP status does a denial use? | `200`, always, with `outcome: "refused"` (§5.1). `400` only for an unparseable body; `500` only for a genuine engine fault. |
| **R3** | Can I distinguish "not allowed" from "broke"? | Yes — `refused` vs `failed`, and ten `refusal.reason` values (§5). Do not merge them (§5.2). |
| **R4** | Does the response prove the queue drained? | **No** (§7). It returns `confirmation.status: "pending"` and the path to observe. Clearing is seen on `/api/healthscan/findings`, and `hosts[].queued` is the direct evidence. |
| **R5** | What happens if I click Approve twice? | Nothing bad, by three mechanisms (§6): the action is absolute, already-at-target is `no_change` with **no** `UpdateProduction()` call, and a repeated `requestId` replays the stored result with `replayed: true`. |
| **R6** | Where do I get the reversal value? | `reversal.action`, a ready-to-POST body carrying the **measured** prior value (§4). Never hardcode `1`. |
| **R7** | Do I need to send who the user is? | No, and you cannot. `actor` is resolved server-side; `requestedBy` is an advisory label recorded beside it (§8). |
| **R8** | Which host names may I offer in the UI? | Exactly one: `Cloud API`. `EMR Source` and `Lab Router` are real hosts and are **not** whitelisted (§3). Offer no host picker. |
| **R9** | Can I clamp the size in the UI and skip the refusal path? | Clamp for input convenience if you like, but **the refusal path must still be implemented and reachable** — the authoritative check is in IRIS (§3.2), and a UI-only bound is not a bound. |
| **R10** | How do I tell a mock apply from a real one? | `audit.source` is `"mock"` and `audit.auditId` is `null` (§8). Render the difference; a screenshot must not be ambiguous. |
| **R11** | Is `audit.role` safe to compare against a string? | **No.** Opaque string. The role name belongs to `mcp-tools.md` and is not ratified here (§9.3). |
| **R12** | Is `outcome` open like `HostStatus`? | **No — closed** (§1.4). An unrecognised value renders as an explicit "unrecognised result, verify by hand", never as a neutral badge and never as applied. |
| **R13** | Should the Smart Resolve panel be hidden when I lack the role? | **No — present-but-denied.** `%CanList` and `%CanExecute` are gated independently and the action stays listable (§9.4). A hidden panel is indistinguishable from a broken dashboard, and MVP 2 §5.4 requires the denied state be *visible*. |
| **R14** | Can I fetch the audit record by `auditId`? | **Unverified — do not build on it** (§13.4). Render the `audit` block from the response body, which is guaranteed present. Treat `auditId` as a correlation token until read-back is confirmed. |

### 12.1 What this asks of the other Day-1 contracts

Two dependencies, both inside the same Day-1 batch, recorded so they are agreed rather than
discovered:

1. **`investigation-api.md`** — **agreed and landed.** §3.3 types `recommendedAction.action` as
   exactly `{type, host, size}`, the object §1.1's `action` is a copy of (§1.2), and maps
   `currentValue` onto `precondition.poolSize`. Without that agreement something has to parse prose
   to build a write.
2. **`mcp-tools.md`** owns the write role's name and grants, the read-tool list, and the tool
   input/output shapes. This contract references them and fixes none of them (§9.3).

Neither `healthscan-api.md` nor `proxy-api.md` changes. MVP 2 §2.4 says so, and nothing here
needs a new field from either: `origin.findingId` uses the existing `Finding.id`, and
`confirmation` points at the two existing endpoints.

---

## 13. Open items — decisions, not defects

Five things this contract does not settle. Each needs a decision or a measurement from someone,
and picking a side unilaterally on the endpoint that writes is worse here than anywhere else in
`contracts/`. The last two are open **unknowns about AI Hub**, flagged rather than asserted
because MVP 2's safety story rests on them and an honest contract is worth more than a confident
one.

### 13.1 How the actor is authenticated — the one thing to settle first

§8 fixes the *shape* (`actor` resolved server-side, never client-supplied) and deliberately does
not fix the *mechanism*. Two candidates:

- **Service account.** The engine authenticates to IRIS as a configured user holding the write
  role. Simple, works with today's dashboard, and MVP 2 ships no login. But then `actor` is the
  same string for every call, and "who approved this" is only ever `requestedBy` — a client
  claim, which §8 says is not identity. The audit log becomes attributable to a process, not a
  person.
- **Pass-through credential.** The dashboard sends an `Authorization` header, the engine forwards
  it, IRIS resolves the real principal. Genuinely attributable and makes §5.1's demonstration
  real rather than staged, at the cost of a login the dashboard does not have.

**Assumption in force until decided:** the service-account model, with `actor` reporting the
configured IRIS user and `requestedBy` recorded beside it. That is what the §11 examples show.
Nothing in the response *shape* changes if the decision goes the other way — only which string
lands in `actor` — which is why the mechanism can be deferred and the shape cannot.

### 13.2 `Access-Control-Allow-Origin: *` on an endpoint that writes

Q9 sends `*` unconditionally on the two GETs so the dev proxy stays optional, and §1.3 keeps it
here for consistency. On a write endpoint that is a different proposition: any page in the
browser can POST to `:3002`.

It is tolerable — not fine — for three reasons: the compose stack runs on a laptop, the engine
holds no authority of its own, and IRIS re-checks everything (§3.2). But under 13.1's
service-account model the engine holds a credential that *does* have the write role, which makes
it a confused deputy: the browser cannot write, and the engine can, and `*` lets the browser ask
it to. The options are binding `:3002` to localhost, an origin allow-list for `POST` only, or the
pass-through credential in 13.1 — which removes the standing privilege and closes this at the
same time. Raised rather than resolved, and it is the second-strongest argument for the
pass-through model.

### 13.3 UNVERIFIED — whether the default policy denies anything

`%AI.Policy.ConsoleAuth` and `%AI.Policy.ConsoleAudit` exist alongside the abstract bases, so a
policy is wired by default. **Whether that default permits everything until a real one is
registered has not been observed.**

This is the one open unknown that could invert a safety claim rather than merely leave a gap.
§9.4 establishes that the runtime *enforces* a policy; if the enforced policy is permissive, the
enforcement is real and the gate is open. "Enforced by the runtime" is a safety property only if
the configured policy actually denies.

Hence §9.4's two requirements — register our own Authorization policy, and **test denial** — are
acceptance criteria, not notes. Until an unauthorized caller has been observed being refused,
`not_authorized` is a shape this contract defines and not a behaviour it has seen. Dev C can mock
against the shape today; nobody should describe the RBAC gate as working until that observation
exists.

### 13.4 UNVERIFIED — what an audit record contains, and whether it is queryable

`%LogExecution`'s **signature** is verified (§8). What it *writes* is not: neither the fields of a
stored record nor whether one can be read back by `auditId`.

That matters to two things in this document. `audit.auditId` is defined as a handle the UI can
link to, and MVP 2 §5.4 makes "show AI Hub audit entry for the action (read-only view)" a Dev C
deliverable with a dependency literally named "audit available". If records turn out not to be
queryable, the demo's final step needs a different source and `auditId` becomes a correlation
token rather than a link — a response-shape change, so it is better closed before Day 1 than
after.

**What is safe to build against now:** that a call produces an audit event (verified — the runtime
calls `%LogExecution`), and that `audit` is present in every response with `actor` resolved
server-side (this contract's own rule, §8). **What is not:** any claim about the *contents* of the
stored record. Dev C should render the `audit` block from the response body — which this contract
guarantees — rather than from a lookup that may not exist.

### 13.5 Nothing here has been executed

Every other document in `contracts/` documents shipped code. This one describes an endpoint that
does not exist, against an MCP tool that does not exist. `proxy-api.md` was written from merged
code; `healthscan-api.md`'s units were "confirmed empirically, not assumed".

What is verified here, and what is not:

- **Verified.** `PoolSize` is a property of `Ens.Config.Item` (§9.1) — introspected, not inferred
  from XData. `Cloud API` is `PoolSize="1"` at `iris/labdemo/Production.cls:76`. The
  `Ens.Config.Production` + `%Save()` + `Ens.Director.UpdateProduction()` path works on this
  instance, because `Triggers.cls` uses it. `CheckProduction()` warns rather than refuses on a
  non-Running production (§9.2). The `Triggers.ErrorRate()` hardcoded-restore bug and its
  reproduction at port 8443 (§4). The poll interval and sustained-breach gates behind §7's
  asynchrony.
- **Verified on the AI Hub side, on the running `pg-iris` container.** The signatures of
  `%AI.Policy.Authorization` (`%CanExecute` returning `%Status`, `%CanList` returning `%Boolean`)
  and `%AI.Policy.Audit` (`%LogExecution` taking `status` and `duration`). That `%AI.Tool` is
  abstract and supplies `%Invoke` / `%ToolError`. And — read from the shipped implementation of
  `%AI.ToolMgr.ExecuteTool`, not inferred from the class list — that the runtime checks
  authorization, then executes, then logs, around every tool call (§9.4).
- **Not verified.** That `set_pool_size` drains the queue at `4`; MVP 2 §6 flags exactly this as
  a risk to rehearse. That `size: 0` disables the host — which is why §3 excludes it rather than
  reasoning about it. **Whether the default AI Hub policy denies anything (§13.3), and what a
  written audit record contains or whether it is queryable (§13.4)** — the two open unknowns, both
  EAP, both being closed by Dev B.

The numbers in §11 are illustrative and labelled as such. **The first live apply should be
diffed against this document**, and where they disagree the document is what is wrong.

---

## 14. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by
every other developer. See `README.md` in this directory. Two developers remain since
2026-08-12, so in practice that is one other person — and GitHub will not let an author approve
their own PR, which is the point.

**This contract is co-owned on paper and singly-held in practice.** MVP 2 §2.4 assigns it to
Dev A + Dev B: Dev A for the IRIS-side write tool and RBAC, Dev B for the endpoint. Dev A left on
2026-08-12 and Dev B inherited `iris/**`, so both halves sit with one person. `proxy-api.md` §7
already records what that costs: "with Dev A gone, this contract has no author to arbitrate it.
That makes the changelog entry matter more, not less." The same applies here with a sharper edge —
the two-owner split was itself a safety property. The read/write boundary in §9 was meant to be
argued across a team boundary, and now it is not.

So, for this file specifically:

- **Adding an action type, a host, or widening the bounds is a safety change, not a feature.** It
  must say in the `CHANGELOG.md` entry what the new bound protects against and who reviewed the
  refusal path — not just what the new value is.
- **Do not estimate the cost of a change from the size of the edit.** `README.md`'s worked
  example: removing `Warning` from `HostStatus` was one line in a union and cost 83 insertions
  across 10 files, because seven fixtures *meant* something in terms of it. Adding a second
  `action.type` is a smaller diff than that and reaches further — it turns §3's "exactly one"
  into a list, which is the moment the whitelist stops being a whitelist and starts being a
  catalogue.
- **Loosening a check is never a bug fix.** If a live run is refused and the refusal looks wrong,
  the first hypothesis is that the request is wrong. §3.1's argument for an allow-list is also an
  argument against quietly widening one.
