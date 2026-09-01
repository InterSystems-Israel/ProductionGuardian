# AI Detective investigation API contract

**Owner:** Dev B · **Consumer:** Dev C · **Port:** `3002` · **Status:** published for Day-1 mocking

One endpoint: `POST /api/investigate`. It takes a finding id and returns a structured root-cause
investigation produced by the AI Hub agent inside the `iris` container.

**The detection engine orchestrates; it does not reason.** The narrative, the evidence and the
recommendation all originate in the agent (`services/detection-engine/CLAUDE.md` §1.1). The engine
adds a request envelope, a timeout, a state label and a cache. A `rootCause` string composed by the
engine would be a contract violation even if it were accurate, because a consumer cannot tell it
apart from the agent's.

Machine-readable: `investigation.schema.json` and `investigation.d.ts` are **not landed yet**. This
document is normative until they are, and they must be derived from it rather than the reverse.
`samples/investigation-response.json` is likewise **not captured yet** — noted rather than quietly
left off `README.md`'s table. Until it exists, the payloads in §8 are the bytes to mock against, and
they are illustrative: the numbers are plausible for the scenario but were **not** captured from a
live run, unlike the Health Scan samples. Replace them with a capture before they become a fixture.

**ASCII inside payload strings, deliberately.** `1 -> 4`, not `1 → 4`. Prose in this file uses
proper UTF-8 em dashes; payloads do not, because a sample is compared byte for byte and an arrow
that survives one editor and not another is how both of this project's encoding incidents started.

**Two neighbouring contracts this one leans on.** `earlywarning-api.md` owns the queue-depth slope
reused as `trend` in §2.2, and `mcp-tools.md` (Dev A) owns the read-tool names quoted in §3.2 and
`diagnostics.toolCalls`. Tool names here are **not authoritative** — if that catalogue names them
differently, it wins and this file is amended. `resolve-api.md` consumes `recommendedAction` (§3.3).

**No LLM provider is configured on the instance yet** (`docs/mvp2-aihub-verified-api.md`): nothing
has called an external model from it. So every claim in this contract about what the *agent* returns
is a specification of what the engine will accept, not an observation of what an agent produced.
That cuts both ways — it is why §4.4 discards a malformed agent response entirely rather than
salvaging fields, and it is why the timings in §4.2 are labelled as chosen rather than measured.

---

## 1. Two hops, and which one this contract governs

There are two request/response pairs, and conflating them is how the data boundary in §2.3 gets
broken:

```
Dev C (browser)  --POST /api/investigate-->  detection-engine :3002
detection-engine --InvestigationRequest--->  AI Hub agent (in the iris container)
                                             agent --MCP read tools--> IRIS
                                             agent --prompt----------> external LLM
```

| Hop | Request | Response | Governed by |
|---|---|---|---|
| Browser → engine | §2.1 — a finding id, nothing else | §3.1 `InvestigationResponse` | this contract |
| Engine → agent | §2.2 `InvestigationRequest` | §3.1 `InvestigationResponse` | this contract |
| Agent → IRIS | MCP read tool calls | tool results | `mcp-tools.md` (Dev A) |
| Agent → LLM | prompt built by the agent | completion | AI Hub configuration |

The response shape is deliberately the **same object on both hops**, minus the envelope fields the
engine fills in (`state`, `source`, `diagnostics.durationMs`). One shape means the mock agent, the
live agent and the cache are interchangeable, which is what ADR 0004's mock-first bet requires.

**The engine never reaches the LLM and holds no LLM key.** Everything the model sees passes through
the agent, which is inside IRIS with the credential vault and the audit log. That is the point of
the architecture and it is why §2.3 is enforceable at all.

## 2. The request

### 2.1 What the dashboard sends

```json
{ "findingId": "f-1041" }
```

| Field | Type | Notes |
|---|---|---|
| `findingId` | string | Must equal a `Finding.id` currently served by `GET /api/healthscan/findings`. |

**That is the whole body.** `additionalProperties: false`. There is no `question`, no `metrics`, no
`context`, no `prompt`, no `hostOverride`.

This is not minimalism for its own sake — it is the structural half of the data boundary. If the
dashboard could supply metrics or free text, the browser would become a data source feeding an
external LLM prompt, and **nothing downstream could distinguish operator-typed text from a measured
metric.** Because the body is one id, every value the model sees was measured by the engine or read
by an MCP tool. Adding a field here is both a contract change and a change to the safety argument.

`Content-Type: application/json` is required. A body that is not an object, or that carries any key
other than `findingId`, is a `400` (§5) — not a best-effort parse.

### 2.2 What the engine sends to the agent — `InvestigationRequest`

The engine builds this from its own in-memory state. It is a closed allowlist:
`additionalProperties: false` at **every** level.

```json
{
  "requestId": "inv-8a31f0",
  "requestedAt": "2026-08-18T09:14:22Z",
  "finding": {
    "id": "f-1041",
    "host": "Cloud API",
    "type": "queue_buildup",
    "severity": "critical",
    "currentValue": 214,
    "baselineValue": 3,
    "detectedAt": "2026-08-18T09:13:48Z",
    "message": "Queue depth 214 is 71x baseline"
  },
  "snapshot": {
    "host": "Cloud API",
    "capturedAt": "2026-08-18T09:14:20Z",
    "status": "OK",
    "queued": 214,
    "queuedBaseline": 3,
    "messagesPerSec": 0.97,
    "messagesPerSecBaseline": 0.94,
    "avgProcessingTime": 1.02,
    "avgProcessingTimeBaseline": 0.05,
    "avgQueueingTime": 61.4,
    "avgQueueingTimeBaseline": 0.03,
    "errored": 0,
    "lastActivity": "2026-08-18T09:14:19Z",
    "inboundRatePerSec": 3.04
  },
  "trend": {
    "metric": "queued",
    "slope": 124.2,
    "slopeUnit": "items/minute",
    "recentDirection": "rising",
    "thresholdValue": 50,
    "thresholdCrossed": true,
    "secondsToThreshold": null
  }
}
```

**Envelope**

| Field | Type | Notes |
|---|---|---|
| `requestId` | string | Engine-generated, unique per agent call. Echoed in the response and used to correlate with the AI Hub audit log. Not a finding id. |
| `requestedAt` | string | ISO 8601 UTC, `Z`-suffixed. Same format as every timestamp in `healthscan-api.md`. |
| `finding` | object | **Exactly `healthscan.schema.json#/definitions/Finding`, embedded verbatim.** |
| `snapshot` | object | See below. Always present. |
| `trend` | object \| **null** | Queue-depth trend from Early Warning's fit, or `null` when there is no usable fit. **Not** Early Warning's `projection` — see below. |

**`finding` is embedded, not reshaped.** It validates against the ratified `Finding` definition
unchanged — all eight required fields (`id`, `host`, `type`, `severity`, `currentValue`,
`baselineValue`, `detectedAt`, `message`), `additionalProperties: false`, `baselineValue` still
nullable. An investigation is *about* a finding, so redefining the shape here would be a second
transcription of a ratified object, and a second transcription drifts. If the agent needs a field
`Finding` does not carry, that is a change request against `healthscan-api.md`, not a local addition.

**`snapshot`** — every field is a value **this engine already holds**, derived from the proxy's
per-host payload and the rolling baseline window:

| Field | Type | Notes |
|---|---|---|
| `host` | string | Always equal to `finding.host`. |
| `capturedAt` | string | ISO 8601 UTC. The poll the snapshot came from, not the request time. |
| `status` | string | As `healthscan-api.md` Q1. Open string. |
| `queued` | integer \| null | `null` means **not measurable**, never zero (Q13). |
| `queuedBaseline` | number \| null | `null` while the baseline is warming (Q3). |
| `messagesPerSec` | number | Completions per second over the last interval. |
| `messagesPerSecBaseline` | number \| null | |
| `avgProcessingTime` | number | **Seconds** (Q6). |
| `avgProcessingTimeBaseline` | number \| null | |
| `avgQueueingTime` | number | **Seconds** (Q6). |
| `avgQueueingTimeBaseline` | number \| null | |
| `errored` | integer \| null | `null` means not measurable, never zero (Q13). |
| `lastActivity` | string | ISO 8601 UTC, ±10 s (Q11). |
| `inboundRatePerSec` | number \| null | **Derived, not measured** — see below. |

The baseline fields are not decoration. For this scenario the load-bearing one is
`avgProcessingTime` against `avgProcessingTimeBaseline`: Cloud API's measured steady state is
~0.05 s, and the downstream dispatcher's ~1 s throttle shows up as ~1.02 s. The ratio is what the
"each message ~1s from the downstream dispatcher throttle" evidence bullet rests on. A snapshot
without baselines would force the agent to assert that number instead of comparing it.

**`inboundRatePerSec` is derived and must be labelled as such wherever it is shown.** No metric
measures arrival rate at a host's queue. The engine computes `messagesPerSec + trend.slope/60` —
completions plus the rate the queue is growing. It is `null` when either term is unavailable,
**including whenever `trend` is `null`**, rather than falling back to `messagesPerSec` and reading as
"inflow equals throughput", which is precisely the conclusion the finding contradicts. This is the
same defect class as the coerced `lastActivity` in #58: a computed value presented as a measurement.

It sits in `snapshot` rather than `trend` because it is a rate *now*, not a forecast — but it is the
one field in `snapshot` that is not measured, so it is the one field in `snapshot` that carries a
"derived" caveat. If it grows a second consumer, move it out.

**There is no `poolSize` in the snapshot, and that is deliberate.** The engine reads metrics, not
configuration; it has no path to `Ens.Config.Item`. `PoolSize` reaches the agent through the
`get_pool_size` MCP read tool. So the central piece of evidence in this scenario is *tool-measured*
rather than *engine-asserted* — which is exactly why `evidence[].source` (§3.2) exists.

**`trend` is the queue-depth fit, and it is deliberately NOT Early Warning's `projection` object.**
This is the one place where reusing the neighbouring contract's shape would have been wrong, so the
reasoning is written down rather than left to be rediscovered:

By the time a `queue_buildup` finding exists, the queue has **already crossed** `threshold.value` —
that is what made the finding fire. `earlywarning-api.md` §2.1 publishes `projection: null` with
`projectionUnavailable: "already_crossed"` in exactly that state, because there is no time remaining
to forecast, and §1.4 forbids publishing `slope` outside `projection` since a visible rate next to no
ETA implies a forecast it refused to make.

Both rules are right for that endpoint and both are fatal here: **the investigation would receive
`null` for the one condition it is always invoked on**, and "queue slope positive" is a required
evidence bullet. So `trend` reuses the *field names and units* and drops the *forecast framing*. It
is a description of a slope now, not a prediction of a crossing.

| Field | Type | Notes |
|---|---|---|
| `metric` | string | `HostProjection.metric`. Only `queued` in MVP 2. Open string. |
| `slope` | number | Same fit and same units as `Projection.slope` — OLS over the trailing 300 s. **May be zero or negative here**, unlike in `earlywarning-api.md`, because a queue that is draining is a fact the agent should see rather than a forecast to withhold. |
| `slopeUnit` | string | Spelled out, e.g. `items/minute`. Carried so the agent never has to infer the unit. |
| `recentDirection` | string \| **null** | `rising` \| `falling` \| `steady`, from `earlywarning-api.md` §1.5 — the **sign** of the tail fit, measured. `null` when no direction is claimed. **This is the field that says a queue is draining**; see below for why `slope` does not. |
| `thresholdValue` | number | `Threshold.value` — `max(baseline * 5.0, 50)`. For this scenario the `absoluteFloor` arm of 50 wins, because Cloud API's queue baseline is near zero. |
| `thresholdCrossed` | boolean | `queued >= thresholdValue`. **Normally `true`** on an investigated finding. Present so the agent never has to infer it from a null ETA. |
| `secondsToThreshold` | integer \| null | Whole seconds, `> 0`. **`null` whenever `thresholdCrossed` is `true`**, which is the usual case — there is no crossing left to forecast. Never `0`, never negative. |

**`recentDirection` exists because `slope` does not deliver what the row above promises.** `slope` is
specified here as "may be zero or negative ... because a queue that is draining is a fact the agent
should see", and the §4 example carries a non-null slope beside `thresholdCrossed: true`. The engine
does not produce that: it reads `slope` from Early Warning's `projection`, which is `null` for
`already_crossed` — i.e. for **every** condition this endpoint is ever called about. So the draining
fact this contract promises has never reached an agent, and the measured consequence was a
recommendation to enlarge a pool on a queue falling from 261 to 181, because nothing in the input said
"falling" (#177).

`recentDirection` is the part of that fixable without reopening `earlywarning-api.md` §1.4, which
forbids publishing a bare slope beside a withheld forecast. A **direction is not a rate**, so it
carries no forecast to mislabel — the same argument that lets `kind: 'projection'` stay absent below.
**The `slope` deviation is not fixed by this change and is tracked separately**: honouring it needs the
window slope published or refitted, which is that contract's decision rather than this one's. Until
then, read `recentDirection` and treat a `null` `slope` on a crossed threshold as expected.

`trend` is `null` when there is no usable fit at all — a warming baseline, or fewer than 12 samples
in the fit window. `null` rather than a zero slope, because "not fitted" and "flat" are different
claims and only one of them is a measurement.

`earlywarning-api.md` still owns the slope's **definition**: the fit window, the estimator and the
threshold arithmetic are specified there, and if they change there they change here. What this
contract owns is the decision to carry the slope past the point that contract stops publishing it.

**`kind: 'projection'` is deliberately absent, and the rename is why that is safe.** That
discriminator exists so a consumer cannot hold a forecast without holding the label saying it is one
(`earlywarning-api.md` §1.4, issue #58's defect class). `trend` carries no forecast to mislabel: the
one predictive field is `secondsToThreshold`, and it is `null` in the case this endpoint actually
serves. **If a field from this object is ever hoisted alongside `snapshot`, or if `secondsToThreshold`
starts arriving non-null, the discriminator comes back with it.**

### 2.3 The data boundary is part of the schema

**Only metrics and configuration may reach the external LLM. Never message content. Never PHI.**
Root `CLAUDE.md` §2.1 states this as a rule rather than a preference; this section is where it is
made structural.

This matters because Production Guardian is a healthcare operations tool sitting on an HL7
interoperability production, and **the LLM is a third party outside the instance.** Everything else
in MVP 2 — RBAC, the credential vault, the audit log — is inside IRIS where the data already is. The
LLM call is the one hop that leaves, so it is the one hop where a leak is not recoverable by
revoking a role.

The allowlist in §2.2 *is* the enforcement. There are exactly three top-level keys plus the
envelope, every object is `additionalProperties: false`, and every leaf is a number, a null, a
timestamp, a host name, a status enum, or `finding.message`.

**A field carrying message bodies is a contract violation, not a configuration mistake.** Named
explicitly, so no future PR has to infer it:

| Must never appear | Why it is tempting |
|---|---|
| HL7 message text, segments, or fields | "the agent could see what is actually queued" |
| Patient identifiers — MRN, name, DOB, address, account number | rides along inside message text |
| `Ens.MessageHeader` rows or `Ens.MessageBody` contents | the read tools can reach them |
| Raw SQL or MCP tool results pasted into the request | "more context helps the model" |
| Free text originating from an operator or a browser | §2.1 |
| Session, correlation or trace ids that resolve to a patient encounter | looks like plumbing |

Counts derived from those sources are fine — `errored: 37` is a number, not a message. The rule is
about content, not about provenance.

**`finding.message` is the one prose field crossing the boundary, so it gets its own rule.** For the
seven per-host rules the engine authors that string itself and it is metric prose by construction
("Queue depth 214 is 71x baseline"). It must stay that way: a `message` that quotes message content
would carry it across the boundary through a field nobody was watching.

**`system_alert` findings are the concrete hole, and §2.4 closes it.** Their `message` copies text
from `alerts.log`, which the engine did **not** author — IRIS wrote it, and an alert about a failed
send can name the message it failed to send. That text is not safe to forward unread, and there is
no reliable way to sanitise arbitrary alert prose. So the engine does not accept those findings at
all.

### 2.4 Only one finding shape is accepted

`POST /api/investigate` accepts a finding where **`type` is `queue_buildup` and `host` is
`Cloud API`.** Anything else returns `200` with `state: "unavailable"` and
`failureReason: "out_of_scope"` (§5).

Two reasons, and both are load-bearing:

1. **Scope.** MVP 2 is one scenario end to end, not a general capability (root `CLAUDE.md` §2.1).
   One finding type, one host, one action type. An endpoint that accepts all eight types implies
   eight investigations exist.
2. **Safety.** It is what makes §2.3's alert-text hole unreachable rather than merely discouraged.

The dashboard should not offer the Investigate button for other findings; the check here is the
backstop, not the UI's contract. When a second scenario lands, widening this set is a contract change
that must say what it does about `system_alert`.

## 3. The response

### 3.1 `InvestigationResponse`

```
{
  requestId, findingId, state, source, investigatedAt,
  rootCause, evidence, confidence, recommendedAction, diagnostics
}
```

| Field | Type | Notes |
|---|---|---|
| `requestId` | string | Echoes §2.2. Correlates to the AI Hub audit entries for this investigation. |
| `findingId` | string | Echoes the requested id. Always present, even when `state` is `unavailable`. |
| `state` | string | `complete` \| `degraded` \| `unavailable` — see §4.1. Also sent as `X-Investigation-State`. |
| `source` | string | `agent` \| `cache` \| `canned` \| `none`. Where the content came from — see §4.3. |
| `investigatedAt` | string | ISO 8601 UTC. **When the content was produced**, not when it was served. For `source: "cache"` this is older than the request, and that gap is what the UI must surface. |
| `rootCause` | string \| **null** | The agent's narrative. Human-readable and **authoritative — render as-is, do not reconstruct or summarise.** `null` when `state` is `unavailable`. |
| `evidence` | array | §3.2. May be `[]`. Never `null`, never absent. |
| `confidence` | number \| **null** | 0.0–1.0. §3.4. |
| `recommendedAction` | object \| **null** | §3.3. `null` when the agent recommended nothing, and always `null` when `state` is `unavailable`. |
| `diagnostics` | object | §3.5. Always present. |

Every key is always **present**. `rootCause`, `confidence` and `recommendedAction` may be `null`; a
missing key is a contract violation, a `null` value is not. This is the same discipline as
`healthscan-api.md` §1, and for the same reason: a consumer that must distinguish absent from null
ends up guessing.

`rootCause` is prose *about metrics and configuration*, generated outside the instance. It is safe
to render but it is not a measurement — §3.2's `source` field is how a reader tells which parts of
the investigation were measured.

### 3.2 `evidence[]`

```json
{
  "label": "Cloud API pool size",
  "detail": "Cloud API PoolSize = 1",
  "source": "mcp_tool",
  "tool": "get_pool_size"
}
```

| Field | Type | Notes |
|---|---|---|
| `label` | string | Short noun phrase. For grouping or a table column. |
| `detail` | string | **The bullet.** Renderable on its own, authoritative, render as-is. |
| `source` | string | `mcp_tool` \| `snapshot` \| `llm`. Open string: render unknown values as `llm`, the least-trusted value. |
| `tool` | string \| null | MCP tool name when `source` is `mcp_tool`; otherwise `null`. Name only. |

`evidence` is ordered most-to-least load-bearing, as the agent ranked it. Dev C may render in order
and need not sort.

**`source` is the field worth having.** A human is about to approve a write to a live production, and
the single most useful thing to know about a bullet is whether a tool measured it or the model said
it. `mcp_tool` means an MCP read tool returned it and the call is in the audit log. `snapshot` means
it came from §2.2, so the engine measured it. `llm` means the model asserted it — it may still be
right, and it is not evidence in the same sense. Render the distinction; do not flatten these into
identical bullets.

`evidence: []` with `state: "complete"` is valid and means the agent produced a narrative without
citing anything. That is a weak investigation, and it should look weak in the UI rather than being
padded from the snapshot by either side.

### 3.3 `recommendedAction` is a structured object, never prose

```json
{
  "action": {
    "type": "set_pool_size",
    "host": "Cloud API",
    "size": 4
  },
  "currentValue": 1,
  "bounds": { "min": 2, "max": 8 },
  "reversible": true,
  "requiresApproval": true,
  "summary": "increase Cloud API pool 1 -> 4"
}
```

**`action` is the part that travels, and it is exactly three keys.** `resolve-api.md` §1.2 requires
`POST /api/resolve`'s `action` to be a **field-for-field copy** of this object — same three keys, same
spelling, same types — and §1.1 **refuses unknown keys inside `action`** (`malformed_request`). So
`action` is nested rather than flat, and the advisory fields are its siblings, not its members.

| Field | Type | Notes |
|---|---|---|
| `action` | object | **Passed to `POST /api/resolve` verbatim.** Exactly three keys, `additionalProperties: false`. |
| `action.type` | string | **Enumerated. Exactly one member for MVP 2: `set_pool_size`.** |
| `action.host` | string | The config item to act on. Equal to `finding.host`, and `Cloud API` is the only whitelisted value (`resolve-api.md` §3). |
| `action.size` | integer | Target pool size. **`size`, not `proposedValue`** — the name is `resolve-api.md`'s. |
| `currentValue` | integer \| **null** | Pool size now, as read by `get_pool_size` or `get_host_settings`. Not the engine's guess — it holds no production configuration. **`null` when the agent did not report it**; a consumer must then omit the before-value rather than render a placeholder. May be below `bounds.min`, which bounds the *target* only. |
| `bounds` | object | `{ min: integer, max: integer }`. `2`–`8` per `resolve-api.md` §3. **Advisory** — see below. |
| `reversible` | boolean | Whether the change can be undone. **Independent of `currentValue`** — `POST /api/resolve` captures `before` from the write tool at apply time and builds its own `reversal` from it, so this stays `true` with `currentValue: null`. |
| `requiresApproval` | boolean | **Always `true` for MVP 2.** |
| `summary` | string | One line for the approval button's label. Authoritative, render as-is. |

`additionalProperties: false` at both levels.

**`currentValue` is nullable, and `summary` is what a reader actually sees.** The schema has always
typed it `["integer", "null"]` and `samples/investigation-response.json` has always carried `null`,
while the table above said `integer` until 2026-08-31 — so the disagreement was between this prose
and the two machine-readable artefacts, not a behaviour change. It matters because `summary` is
**authoritative and rendered as-is**, so the producer must not use it to report an absent value:

```
currentValue: 4      ->  "increase Cloud API pool 4 -> 8"
currentValue: null   ->  "increase Cloud API pool to 8"
```

Never a placeholder. A `?` in that string reaches an approval control for a live production write
(#178).

**Where the before-value is used, and where it is not.** It is advisory context for the human
approving the action, and it is the value to send as `precondition.poolSize` on the resolve call *if
a consumer chooses to send one* — that field is optional, and a consumer with `currentValue: null`
must simply omit it rather than guess. It is **not** the reversal target: `resolve-api.md`'s
`reversal` is built from the `before` the write tool itself reports at apply time, which is the only
reading that is correct if the pool changed between the investigation and the approval.

### 3.3a `manualRemediation` — a fix that is not ours to apply

**MVP 3.** `recommendedAction` above stays exactly as specified: a structured object whose `action`
travels verbatim to `POST /api/resolve`. This is a **separate, additive, nullable sibling** for the
case where the agent knows the fix and the system may not perform it.

```json
{
  "recommendedAction": null,
  "manualRemediation": {
    "summary": "EMR Source polls a directory that does not exist",
    "steps": [
      "Create the directory /tmp/labdemo/hl7-in/ on the IRIS host, or",
      "point EMR Source's FilePath setting at an existing directory"
    ],
    "target": { "host": "EMR Source", "setting": "FilePath", "currentValue": "/tmp/labdemo/hl7-in-missing/" },
    "appliedBy": "operator"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `summary` | string | One line naming the condition. Rendered as-is; not a button label — there is no button. |
| `steps` | array of string | Ordered, imperative, each independently actionable. Rendered as a list, verbatim. |
| `target` | object \| null | What to change, **configuration only**: `{ host, setting, currentValue }`. `null` when the agent could not identify it. |
| `appliedBy` | string | Enumerated. **`operator` is the only member.** Present so a second value is a contract change rather than a code change. |
| `steps[]` | — | **Never contains message content or PHI** — same boundary as everything else that leaves the instance (§6 of `mcp-tools.md`). |

`additionalProperties: false`.

**WHY A SEPARATE FIELD RATHER THAN LOOSENING `recommendedAction`.** §3.3 is right that a recommended
action is a structured object and never prose — that is what makes it safe to hand to a write
endpoint. Adding a `prose` variant, or an `applyable: false` flag, would put two things with
different **authority** into one shape:

- `recommendedAction` means *"there is a fix and the system may apply it, with your approval"*
- `manualRemediation` means *"there is a fix and the system may not apply it at all"*

Two shapes make the wrong UI **unrepresentable**: a consumer cannot render an approve control for a
`manualRemediation`, because there is no `action` object to send. One shape with a boolean makes the
wrong UI a forgotten `if`. The failure mode being designed out is an approve button appearing next
to a recommendation the system cannot carry out — the single worst thing this endpoint could cause,
because a human would click it.

**BOTH MAY BE NULL, AND THAT IS STILL A VALID INVESTIGATION.** §3.1 already allows
`recommendedAction: null` on a `complete` investigation. `manualRemediation: null` alongside it means
the agent explained the condition and recommended nothing — which stays legal and must render as
*no recommended action* rather than as an error.

**THEY ARE MUTUALLY EXCLUSIVE IN PRACTICE AND NOT ENFORCED HERE.** Nothing in this contract forbids
both being non-null; a future condition might legitimately have a bounded action *and* a manual
follow-up. A consumer that receives both must render both, and must not treat `manualRemediation` as
a reason to suppress the approve control for a genuine `recommendedAction`.

**ACCEPTANCE IS THE ABSENCE OF A CONTROL, WHICH IS WHY IT NEEDS AN EXPLICIT CHECK.** *"With a
`manualRemediation` finding open, the drawer shows the summary and steps and NO Preview or Approve
button."* A missing negative is invisible: every check can pass while the control is wrongly present,
because nothing asserts what should not be there. Stated here rather than left to the UI, because
this contract is where the authority distinction lives.

**Dev C must not build a translation layer.** Take `recommendedAction.action` and send it as
`action`; take `currentValue` and send it as `precondition.poolSize`. Any reshaping between the two
endpoints is the prose-parsing failure with extra steps, which is `resolve-api.md` §1.2's stated
concern and the reason the field names here are that contract's and not this one's.

**Why this is not a string.** `recommendedAction` is the input to Smart Resolve, and a human approves
it before it is applied to a live production. Free prose cannot be validated against a whitelist,
cannot be bounds-checked, and cannot be turned into a `POST /api/resolve` body without something
parsing English — which is a second reasoning step in the layer that is explicitly not allowed to
reason. A structured object can be checked field by field before anything is offered for approval.

**An unknown `action.type` must be rejected, and the shape makes that possible.** It is a closed enum
with one member, so an unrecognised value is a schema failure rather than a passthrough. Required
consumer behaviour: treat the whole `recommendedAction` as absent, render "no recommended action
available", and **disable the approve control**. Do not render the `summary` for an unknown type —
prose the consumer cannot validate is exactly what a whitelist exists to stop. Same for a `size`
outside `bounds`, a non-integer `size`, or a `host` that is not `finding.host`.

**`bounds` is advisory and is not authorization.** The authoritative range is `2`–`8`, enforced by
the engine's resolve endpoint and re-enforced by the `set_pool_size` MCP write tool inside IRIS
behind RBAC; `resolve-api.md` §3 and `mcp-tools.md` own it. `bounds` is carried here so the UI can
validate before a round trip. A consumer that treats `bounds` as permission has moved the safety
check into the browser.

**Note the agent cannot recommend `size: 1`, and that is a real constraint on it, not a formality.**
`resolve-api.md` §3 sets the lower bound at `2` because `1` is the shipped value, so recommending it
is a no-op dressed as a fix. An agent that returns `size: 1` produces a `recommendedAction` the
consumer must reject under the rule above — the correct outcome, and worth knowing when writing the
agent's prompt rather than discovering at the refusal.

**`requiresApproval: true` is invariant, not a default.** MVP 2 has no unattended path. It is in the
schema so that a future change making it `false` is visible as a contract change reviewed by
everyone, rather than a config flag someone flips. §7.3 of the MVP 2 spec floats
"confidence-gated auto-apply" as a possible enhancement; this contract does not make it possible,
and §3.4 explains why it should not.

**This endpoint never writes.** `recommendedAction` is a proposal. Applying it is
`POST /api/resolve`, a separate endpoint under a separate contract, and the write happens in IRIS.

### 3.4 `confidence` — what it is, and what it is not

**Type:** `number | null`. **Range:** `0.0` to `1.0` inclusive. Not a percentage; the UI may render
one.

**It comes from the LLM. It is not a calibrated probability.** Stated plainly because the field name
invites the opposite reading:

- It is the model's self-report, produced in the same completion as the narrative it is scoring.
- Nothing calibrates it. There is no labelled set of investigations, no held-out evaluation, no
  reliability curve. `0.9` has never been shown to be right nine times in ten, because that
  measurement has not been made — and with one scenario there is nothing to make it against.
- Language models are known to be poorly calibrated and to shift with prompt wording and model
  version. **The model is an AI Hub configuration, not code** (MVP 2 spec §2.2), so the number can
  move without a single line of this repo changing. It is therefore not even stable across
  deployments of the same commit.

**Use it to:** display it next to the narrative; sort or de-emphasise; prompt an operator to look
harder when it is low; log it.

**Do not use it to:** gate the approve control; auto-apply anything; branch on a threshold
(`>= 0.8` means nothing measurable); average, combine or aggregate across investigations; or present
it as "N% chance this root cause is correct". **Nothing safety-critical may depend on it.** The
safety model is human approval plus a bounded whitelist (root `CLAUDE.md` §2.1) — a number the
system cannot vouch for is not a control.

`confidence: null` is valid on a `complete` investigation and means the agent returned no score.
Render `—`, never `0` and never `0.5`; a fabricated midpoint is a claim nobody made. Same
convention as `baselineValue` (Q3).

`confidence` is **not** a health score. That is the Health Score module and it is still out of scope.

### 3.5 `diagnostics`

```json
{
  "durationMs": 8421,
  "agentInvoked": true,
  "model": "claude-sonnet-4-5",
  "toolCalls": ["get_host_status", "get_queue_depth", "get_pool_size"],
  "failureReason": null
}
```

| Field | Type | Notes |
|---|---|---|
| `durationMs` | integer | Engine-measured, end to end, including the LLM round trip. |
| `agentInvoked` | boolean | `false` for `source: "cache"` and `"canned"`. The honest signal that no live investigation happened. |
| `model` | string \| null | As reported by AI Hub. `null` when it does not report one. Configuration, not data. |
| `toolCalls` | array of string | MCP tool **names only**, in call order. `[]` when none. |
| `failureReason` | string \| null | `null` when `state` is `complete`. §4.1. |

**`toolCalls` carries names, never arguments and never results.** A tool result can contain data that
has no business being re-exported to a browser, and an echo of it in a diagnostics blob is a leak
through the back door. **The authoritative record is the AI Hub audit log**, which captures every
read and write call with its arguments inside IRIS; this array is a convenience for the UI and for
support, and it is not evidence of what happened.

## 4. Failure discipline: degraded, unavailable, and never invented

The LLM is external and may be slow, unavailable or rate-limited (MVP 2 spec §6 rates this
*medium* likelihood, *high* impact). A degraded investigation is therefore a **normal response
shape**, not an error path bolted on afterwards.

**The absolute rule: never invent an explanation.** Serving "could not investigate" is worse for a
demo and better for everything else. A fabricated root cause on a healthcare production tool is a
confident wrong attribution that an operator may act on — the same failure mode
`services/detection-engine/CLAUDE.md` §5.2b refuses for alert matching, and the reasoning transfers
intact. In particular the engine must not compose a narrative from its own detection rules: it has
the numbers and could write a fluent paragraph, and doing so would make `source: "agent"` a lie.

### 4.1 The three states

| `state` | Meaning | `rootCause` | `evidence` | `confidence` | `recommendedAction` |
|---|---|---|---|---|---|
| `complete` | The agent investigated **this** finding **now** | non-null | may be `[]` | number or `null` | object or `null` |
| `degraded` | Content is being served, but it is not this investigation of this finding | non-null | may be `[]` | number or `null` | object or `null` |
| `unavailable` | No investigation. Nothing is being claimed | **`null`** | **`[]`** | **`null`** | **`null`** |

`degraded` exists so the fallback is visible rather than silent. A cached investigation of the same
condition is usually still true and is worth showing; presenting it as `complete` would hide that
nothing was measured at request time. `source` and `investigatedAt` say which and how old, and
`diagnostics.agentInvoked` is `false`. **The UI must label a `degraded` response** — an unlabelled
cached explanation next to a live queue graph is how a stale conclusion gets acted on.

`unavailable` is the shape that makes "never invent" enforceable: there is no field left to put a
guess in. A response with `state: "unavailable"` and a non-null `rootCause` is invalid, and the
schema should reject it.

`failureReason` is set on `degraded` and `unavailable`:

| Value | Meaning |
|---|---|
| `agent_unreachable` | The AI Hub agent did not answer at the transport level |
| `agent_timeout` | The agent accepted the request and did not finish in time (§4.2) |
| `agent_error` | The agent returned an error |
| `llm_unavailable` | The agent reported that the external LLM could not be reached |
| `llm_rate_limited` | The agent reported a rate limit |
| `malformed_agent_response` | The agent answered but the payload failed validation (§4.4) |
| `finding_not_found` | No finding with that id is currently active |
| `out_of_scope` | The finding is outside §2.4 |

Treat as an **open** string and render unknown values neutrally, per the project's convention for
every other enum on the wire.

### 4.2 Timeouts and retries

- **Hard deadline: 30 s.** The endpoint always answers within roughly that plus HTTP overhead. It
  never hangs waiting on a model.
- **Soft deadline: 20 s.** At 20 s the engine stops waiting for the agent and begins the fallback
  chain in §4.3, so the remaining budget is spent producing a labelled answer rather than waiting.
- **At most one retry, and only on a transport error** (connection refused, reset, DNS) where it is
  certain the agent never ran.
- **Never retry a timeout.** A timeout means the agent may still be working: its MCP read tool calls
  are already in the audit log, and a retry duplicates them. An audit trail showing two
  investigations where an operator saw one is worse than a slow answer — attributability is the
  point of the audit log (root `CLAUDE.md` §2.1).
- A duplicate `POST` for a finding already under investigation **joins the in-flight call** and
  receives the same response. It does not start a second agent run. No `202`, no polling endpoint:
  the call is synchronous and the dashboard awaits it.

**These numbers are not measured against a live agent.** They are chosen to be comfortably above a
typical LLM round trip and below a demo's patience. They live in engine config, not in
`thresholds.json` — ADR 0003 governs *detection* numbers, and a timeout is not one. Retuning them
against the real agent is expected and is not a contract change unless the 30 s guarantee moves.

### 4.3 Fallback order

In order, stopping at the first that produces content:

1. **Live agent** → `state: "complete"`, `source: "agent"`.
2. **Cache** — the last successful investigation for the same `(host, type)` condition, while that
   condition is still active. → `state: "degraded"`, `source: "cache"`, `investigatedAt` unchanged
   from when it was produced.
3. **Canned response** — the committed fixture for this one scenario, from the engine's fixtures
   directory. → `state: "degraded"`, `source: "canned"`.
4. **Nothing** → `state: "unavailable"`, `source: "none"`.

The cache is keyed by `(host, type)` rather than by `finding.id` on purpose: ids are stable for the
life of a condition (Q4), so those keys are equivalent while the finding persists — and if a
condition clears and recurs, a new id is correct and reusing the old narrative would not be.

**The cache is in-memory and is dropped on restart**, consistent with ADR 0002's refusal to persist.
A cold engine has no cache, so step 3 is what a fresh start falls back to.

**The canned response is a fixture, and it is honest about being one.** It is `source: "canned"`, it
is `degraded`, and its `investigatedAt` is the time it was captured, not now. It is the demo's
standby (MVP 2 spec §6) and it exists because a scripted fallback beats a blank panel on stage —
but it is never dressed up as a live investigation. `agentInvoked: false` says so in the payload.

### 4.4 A malformed agent response is a failure, not a partial success

If the agent answers but the payload does not validate — unknown `recommendedAction.action.type`,
`confidence` out of range, missing `rootCause` on a `complete` claim, extra properties — the engine
**discards it entirely** and continues down §4.3 with `failureReason: "malformed_agent_response"`.

It does not salvage the fields that parsed. A half-validated investigation is one whose
recommendation was rejected but whose narrative is still on screen next to an approve button, and
that is the worst of the available outcomes. Validate the whole object or use none of it.

## 5. Errors and empty states

| Situation | Response |
|---|---|
| Investigation succeeded | `200`, `state: "complete"` |
| Agent slow / unreachable / rate-limited, cache available | `200`, `state: "degraded"`, `source: "cache"` |
| Agent unavailable, no cache | `200`, `state: "degraded"`, `source: "canned"` |
| Agent unavailable, no cache, no fixture | `200`, `state: "unavailable"`, `source: "none"` |
| Finding cleared between the poll and the click | `200`, `state: "unavailable"`, `failureReason: "finding_not_found"` |
| Finding outside §2.4 | `200`, `state: "unavailable"`, `failureReason: "out_of_scope"` |
| Malformed body — not JSON, no `findingId`, extra keys | `400` + `{"error":"..."}` |
| Wrong method on the path | `405` |
| Genuine server fault | `500` + `{"error":"..."}` |

**Why an unknown `findingId` is `200` and not `404`.** Findings disappear when they clear and carry
no tombstone (`healthscan-api.md` Q4). An operator reading a finding while it resolves is the
*expected* lifecycle, not a client bug — the same reasoning that makes zero findings `200` + `[]`
rather than `404` (`healthscan-api.md` Q7). The dashboard needs to render "this finding is no longer
active", which is a state, and states travel in the body here.

**Bare `Q<n>` in this file means `healthscan-api.md`'s question list**, which was published first and
is what "Q13" has meant in this directory since PR #3. §6 numbers its own questions and always names
the section. Flagged because two overlapping `Q1..Q14` lists in one directory is a footgun, and
renumbering the ratified one is not an option.

**`400` is genuine, though.** A body the engine cannot parse is a client defect with no meaningful
state to label, and swallowing it as `200` would hide a Dev C bug behind a plausible-looking empty
panel. This is the line: a *race* is a state, a *malformed request* is an error.

**`X-Investigation-State`** carries `complete` \| `degraded` \| `unavailable`, mirroring
`X-Healthscan-State`. Advisory — it duplicates `state` in the body, and a consumer may ignore it.

**CORS, and one thing that is new.** `Access-Control-Allow-Origin: *` is sent, as on the Health Scan
endpoints (Q9). **But this is a `POST` with `Content-Type: application/json`, which is not a CORS
simple request** — the browser sends an `OPTIONS` preflight that neither MVP 1 endpoint ever needed.
The engine answers preflight with `Access-Control-Allow-Methods: POST, OPTIONS` and
`Access-Control-Allow-Headers: Content-Type`. Called out because "CORS already works" is true of the
GET endpoints and does not carry over, and the symptom is a request the server never logs.

## 6. The Day-1 questions, answered

Published before Dev C has raised any, so the answers exist when the mock is written. Marked where
an answer is an assumption rather than a fact.

| # | Question | Answer |
|---|---|---|
| **Q1** | What does the dashboard send? | `{"findingId": "..."}` and nothing else (§2.1). Not negotiable — it is half the data-boundary argument. |
| **Q2** | Is it synchronous? How long? | Synchronous. Hard deadline 30 s, so build the panel for a multi-second spinner, not an instant swap. No polling endpoint. |
| **Q3** | Can I investigate any finding? | No. `queue_buildup` on `Cloud API` only (§2.4). Anything else is `200` + `out_of_scope`. Hide the button elsewhere. |
| **Q4** | Is `rootCause` safe to render verbatim? | Yes, and it is authoritative — do not summarise or reflow it. Same rule as `Finding.message`. |
| **Q5** | Is `evidence[]` strings or objects? | Objects. Render `detail` as the bullet; use `source` to mark what was tool-measured versus model-asserted (§3.2). |
| **Q6** | Can I bind the approve button straight to `recommendedAction`? | Yes when `action.type` is `set_pool_size` and `action.size` is within `bounds`. Otherwise disable it and render nothing (§3.3). **Send `recommendedAction.action` to `POST /api/resolve` as `action`, unmodified** — it is already that contract's exact shape, and reshaping it is the failure `resolve-api.md` §1.2 warns about. Applying is that endpoint, not this one. |
| **Q7** | Can I gate the approve button on `confidence`? | **No.** It is an uncalibrated LLM self-report (§3.4). Display it; never branch on it. |
| **Q8** | What is a nullable field? | `rootCause`, `confidence`, `recommendedAction`, `diagnostics.model`, `diagnostics.failureReason`, `evidence[].tool`. Every key is always present; `evidence` is `[]` rather than `null`. |
| **Q9** | Does a failed investigation 404 or 500? | Neither. `200` + `state` (§5). `400` on a malformed body, `500` only on a genuine fault. |
| **Q10** | How do I know a response is cached or canned? | `state: "degraded"`, plus `source`, `investigatedAt` and `diagnostics.agentInvoked: false`. **You must label it.** |
| **Q11** | Do I need a CORS change? | Yes — this `POST` preflights where the GETs did not (§5). |
| **Q12** | Is there a `question` field, ever? | No. That is Ask Guardian (§7). |
| **Q15** | Why is it `trend` and not the `projection` from `earlywarning-api.md`? | Because Early Warning correctly publishes `projection: null` / `already_crossed` for exactly the condition this endpoint investigates, so reusing it would deliver `null` every time (§2.2). Same field names and units, no forecast framing. Read the two panels from their own endpoints; do not derive one from the other. |
| **Q13** | *(assumption)* Is 30 s enough? | **Unverified against a live agent.** Chosen, not measured — an agent doing several MCP calls plus one LLM completion should land well inside it. Expect retuning; only the 30 s guarantee is contractual. |
| **Q14** | *(assumption)* Does AI Hub report the model name? | Assumed yes, hence `diagnostics.model`. `null` is a valid answer, so a mock should exercise both. |

## 7. What this is not

- **Not Ask Guardian.** No chat, no conversation, no follow-up turns, no session. The request carries
  no question and the response is not a reply. One finding in, one investigation out. A `question`
  field would be both a contract change and a scope change, and it is the single most likely piece of
  scope creep to arrive at this endpoint.
- **Not Health Summary.** No report generation, no multi-finding narrative, no export. It investigates
  one finding. A response that summarised the production would be a different module's output.
- **Not Smart Resolve.** This endpoint never writes to anything. `recommendedAction` is a proposal a
  human approves; the write is a governed MCP tool inside IRIS behind RBAC, reached through
  `POST /api/resolve`.
- **Not Health Score.** `confidence` scores the explanation, not the production.
- **Not a general diagnostic engine.** One finding type, one host, one action type, one scenario. It
  cannot diagnose `slow_processing`, it cannot diagnose Lab Router, and it will not tell you why disk
  is full. Generalising is later work, and it starts with a contract change here.

## 8. Worked examples

Illustrative, not captured — see the note at the top of this file. ASCII inside payload strings.

### 8.1 `complete` — the pool-size scenario

`POST /api/investigate` → `200`, `X-Investigation-State: complete`

```json
{
  "requestId": "inv-8a31f0",
  "findingId": "f-1041",
  "state": "complete",
  "source": "agent",
  "investigatedAt": "2026-08-18T09:14:31Z",
  "rootCause": "Cloud API is throughput-bound - PoolSize 1 against a ~1s-per-message downstream dispatcher, so it clears ~1 msg/sec while inflow exceeds that",
  "evidence": [
    {
      "label": "Cloud API pool size",
      "detail": "Cloud API PoolSize = 1",
      "source": "mcp_tool",
      "tool": "get_pool_size"
    },
    {
      "label": "Downstream cost per message",
      "detail": "each message ~1s from the downstream dispatcher throttle (avg processing time 1.02s against a 0.05s baseline)",
      "source": "snapshot",
      "tool": null
    },
    {
      "label": "Inbound rate",
      "detail": "inflow rate > 1/sec (~3.0 msg/sec against a ~1 msg/sec ceiling)",
      "source": "snapshot",
      "tool": null
    },
    {
      "label": "Queue trend",
      "detail": "queue slope positive - depth 214, rising ~124/min",
      "source": "snapshot",
      "tool": null
    },
    {
      "label": "Host health",
      "detail": "Cloud API status OK with 0 errored messages, so this is a throughput limit and not a fault",
      "source": "mcp_tool",
      "tool": "get_host_status"
    }
  ],
  "confidence": 0.86,
  "recommendedAction": {
    "action": {
      "type": "set_pool_size",
      "host": "Cloud API",
      "size": 4
    },
    "currentValue": 1,
    "bounds": { "min": 2, "max": 8 },
    "reversible": true,
    "requiresApproval": true,
    "summary": "increase Cloud API pool 1 -> 4"
  },
  "diagnostics": {
    "durationMs": 8421,
    "agentInvoked": true,
    "model": "claude-sonnet-4-5",
    "toolCalls": ["get_host_status", "get_queue_depth", "get_pool_size", "get_processing_time"],
    "failureReason": null
  }
}
```

Note that the pool size is `source: "mcp_tool"` while the timings are `source: "snapshot"`: the
engine has no path to configuration (§2.2) and the agent has no need to re-measure what the snapshot
already carried. The two bullets that read most like a conclusion are the ones a tool measured.

`confidence: 0.86` is displayable and gates nothing. Approval is required regardless.

The `model` string is a **placeholder shaped like a model id, not a chosen model.** No provider is
configured on the instance yet, and the model is an AI Hub configuration rather than code (MVP 2 spec
§2.2), so a mock must not treat this value as fixed — and a UI must not parse it. Exercise `null`
too, per Q14.

### 8.2 `degraded` — LLM rate-limited, cached investigation served

`200`, `X-Investigation-State: degraded`

```json
{
  "requestId": "inv-8a3204",
  "findingId": "f-1041",
  "state": "degraded",
  "source": "cache",
  "investigatedAt": "2026-08-18T09:14:31Z",
  "rootCause": "Cloud API is throughput-bound - PoolSize 1 against a ~1s-per-message downstream dispatcher, so it clears ~1 msg/sec while inflow exceeds that",
  "evidence": [
    {
      "label": "Cloud API pool size",
      "detail": "Cloud API PoolSize = 1",
      "source": "mcp_tool",
      "tool": "get_pool_size"
    },
    {
      "label": "Queue trend",
      "detail": "queue slope positive - depth 214, rising ~124/min",
      "source": "snapshot",
      "tool": null
    }
  ],
  "confidence": 0.86,
  "recommendedAction": {
    "action": {
      "type": "set_pool_size",
      "host": "Cloud API",
      "size": 4
    },
    "currentValue": 1,
    "bounds": { "min": 2, "max": 8 },
    "reversible": true,
    "requiresApproval": true,
    "summary": "increase Cloud API pool 1 -> 4"
  },
  "diagnostics": {
    "durationMs": 20114,
    "agentInvoked": false,
    "model": null,
    "toolCalls": [],
    "failureReason": "llm_rate_limited"
  }
}
```

`investigatedAt` is 09:14:31 while the request was made minutes later. `agentInvoked` is `false` and
`toolCalls` is `[]` — nothing was measured for *this* request. `durationMs` of 20114 is the soft
deadline being spent before the fallback. **The panel must say the investigation is cached and show
its age**, and it should be visibly the same recommendation rather than a fresh one.

### 8.3 `unavailable` — nothing to serve, and nothing claimed

`200`, `X-Investigation-State: unavailable`

```json
{
  "requestId": "inv-8a3299",
  "findingId": "f-1041",
  "state": "unavailable",
  "source": "none",
  "investigatedAt": "2026-08-18T09:31:07Z",
  "rootCause": null,
  "evidence": [],
  "confidence": null,
  "recommendedAction": null,
  "diagnostics": {
    "durationMs": 30007,
    "agentInvoked": true,
    "model": null,
    "toolCalls": [],
    "failureReason": "agent_timeout"
  }
}
```

Every content field is null or empty. There is nowhere to put a guess, which is the design. Render
"could not investigate", offer a retry, and **do not** synthesise a root cause from the finding's own
numbers — the engine has them and deliberately does not use them (§4).

`agentInvoked: true` with `toolCalls: []` is the honest report of a call that was made and did not
come back with a usable answer. Whether the agent ran tools is in the AI Hub audit log, which is why
this array is not evidence of anything (§3.5).

An out-of-scope or cleared finding has the same shape with `agentInvoked: false`, `durationMs` near
zero, and `failureReason` of `out_of_scope` or `finding_not_found`.

---

## 9. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by every
other developer. See `README.md` in this directory.

Two developers remain since 2026-08-12, so in practice that is one other person — and GitHub will
not let an author approve their own PR, which is the point.

**Two kinds of change here are heavier than their diff.** Estimate the cost from attached meaning,
not from line count (`README.md`, "Estimating what a change costs"):

- **Widening `InvestigationRequest`** is a change to the data-boundary argument in §2.3, not a field
  addition. It needs the PR to say what the new field can and cannot carry, and why a message body
  cannot reach it.
- **Widening `recommendedAction.action.type`**, widening `bounds`, or setting
  `requiresApproval: false` is a change to the safety model in root `CLAUDE.md` §2.1. It is a scope
  amendment as well as a contract change, and the two should land together. `action`'s shape is
  additionally co-owned in effect: `resolve-api.md` refuses unknown keys inside it, so adding one
  here breaks that endpoint rather than this one.

Everything else — a new `failureReason`, a new `evidence[].source` — is additive, and consumers
already render unknown enum values neutrally, so it does not break a mock.
