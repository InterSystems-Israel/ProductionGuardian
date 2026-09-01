# `contracts/` — the coordination point

The API contracts, their schemas, and the shared sample payloads. This directory is the only
path every developer reads, which is why it is PR-gated.

**MVP 1 — Health Scan**

| File | Owner | Consumer |
|---|---|---|
| `proxy-api.md`, `proxy.schema.json` | Dev A | Dev B |
| `healthscan-api.md`, `healthscan.schema.json`, `healthscan.d.ts` | Dev B | Dev C |
| `samples/metrics-dump.txt` | Dev A | Dev B |
| `samples/hosts-response.json`, `samples/findings-response.json` | Dev B | Dev C |

**MVP 2 — Early Warning, AI Detective, Smart Resolve.** Added to this table on 2026-09-01: these had
been landing here since MVP 2 opened without ever reaching it, which is how
`samples/investigation-response.json` came to be described in `investigation-api.md` as "not captured
yet" for the twelve days after it was captured (#201).

| File | Owner | Consumer |
|---|---|---|
| `earlywarning-api.md`, `earlywarning.schema.json` | Dev B | Dev B (dashboard) |
| `samples/earlywarning-response.json`, `earlywarning-insufficient-samples.json`, `earlywarning-crossed.json` — three **live** captures from one `pool_bottleneck` cycle | Dev B | Dev B (dashboard) |
| `investigation-api.md`, `investigation.schema.json` | Dev B | Dev B (dashboard) |
| `samples/investigation-response.json` — a **live** `gpt-4o-mini` capture | Dev B | Dev B (dashboard) |
| `resolve-api.md`, `resolve.schema.json` | Dev B | Dev B (dashboard) |
| `samples/resolve-response.json`, `resolve-preview.json`, `resolve-refusal.json` — three **live** captures | Dev B | Dev B (dashboard) |
| `samples/resolve-request.json` — the **live** request that produced the refusal capture | Dev B | Dev B (dashboard) |
| `mcp-tools.md` | Dev A | Dev B |

**The dashboard consumer is Dev B, not Dev C** — Dev C left on 2026-08-20 and `apps/dashboard/**`
passed to Dev B (root `CLAUDE.md` §3). The MVP 1 rows above are left reading `Dev C` because that is
who consumed them when they were ratified, and rewriting history in an owner column is not the same
as recording who owns it now. It does mean the engine↔dashboard rows have the same name on both
sides, which is the seam the root file's mock-first rule addresses directly: nothing forces a
contract to be real when one author owns both ends of it.

Two gaps left in that block, noted rather than left to be discovered:

- **neither `investigation.d.ts` nor `resolve.d.ts` exists**, so unlike Health Scan there is no
  TypeScript transcription for a consumer to import — the engine and the dashboard each hand-maintain
  one for both shapes. `earlywarning.d.ts` does not exist either, and for the same reason
- **the two request-side shapes have no captured sample.** `resolve.schema.json`'s `ResolveRequest` has
  `samples/resolve-request.json`; `InvestigationRequest` has none, and that absence is deliberate rather
  than pending. `buildSnapshot()` still omits `capturedAt` and all four `*Baseline` fields (#211, half 1,
  which needs a metered live run), so a capture taken today would be **schema-invalid** — and committing
  one would mean either weakening the schema to match a defect or parking a red fixture in `samples/`.
  What stands in for it: the schema keeps those five fields `required`, and `validate.mjs` carries the
  engine's current snapshot as an explicit must-**reject** case, the same device this directory already
  uses for the engine's `name`/`messagesErrored` host shape. Both flip when half 1 lands

`resolve.schema.json` and the three captures closed the other gap on 2026-09-01 (#202): `POST
/api/resolve` was the one MVP 2 endpoint nothing validated, which is why five field-level divergences
in `resolve-api.md` had to be found by reading rather than by CI. Two points in that schema are
**deliberately permissive** — `resolve-api.md` §4's `after` on a preview and §5's `confirmation`
fields are open decisions, and the fields say so in their `description` — so for those two the prose
is still the only statement of intent, and there isn't one yet.

`earlywarning.schema.json` and three captures closed the last of them on 2026-09-01 (#219), so **all
five HTTP contracts now have a schema and at least one live sample.** Two things about that one are
worth knowing before reading it. First, its central rule is *structural* — `earlywarning-api.md` §1.4
puts every computed number inside `projection` and every observed one outside it — so
`additionalProperties: false` is doing the actual work: a top-level `slope` beside a declined forecast
is now a validation failure, which is the exact case §1.4 names. Second, **the captures were taken
before the schema was written**, and they disagree with two of the three worked examples in §4:
`warming` is unreachable on the shipped `referenceBaselines` (§4.2's state comes back as
`insufficient_samples` with a non-null threshold), and §4.3's climbing `baselineValue` cannot happen
for the same reason. Both are filed rather than encoded — whether the prose or the config is what
should change is a product decision, and a schema written from §4 would have settled it by accident.

`InvestigationRequest`, `InvestigationSnapshot` and `InvestigationTrend` landed the same day (#211, half
2), which makes **both directions of every endpoint machine-checked** — the request halves were the last
prose-only shapes here, and `investigation-api.md` §2.2 is the one that shows why that mattered: it
drifted in both directions for three MVPs (five fields specified and never sent, three sent and never
specified) while §4, which had a schema and a captured sample, stayed honest. Two things to know before
reading it. It is deliberately **weaker than `earlywarning.schema.json` over the same field names** —
`slope` may be zero or negative here, because a draining queue is a fact the agent should see rather than
a forecast to withhold — and all three such divergences are pinned as must-*accept* cases so a future
"unify the two slope definitions" fails loudly. And its fixture is **parsed out of §2.2's annotated
fence** rather than transcribed into `validate.mjs`, so the two cannot disagree.

`samples/alerts.json` and `samples/proxy-response.json` were planned in `CONTRIBUTING.md` §1 and do
not exist. Both are derivable without inventing anything — a real alerts capture is at
`services/metrics-proxy/fixtures/alerts-live-capture.json`, and a proxy response is
`src/parser.js` applied to `samples/metrics-dump.txt` — but neither is committed here yet, so a
consumer mocking Dev A must run the parser or point at `npm run mock`. Noted rather than quietly
left off the table.

## Why the samples matter

`samples/` is the handoff currency. Dev A's `proxy-response.json` is *literally* Dev B's mock
input; Dev B's `findings-response.json` is *literally* Dev C's mock input. Same bytes, which is
what makes "works against the mock" predict "works against the real thing."

Samples are captured from live IRIS wherever possible, not invented. The Health Scan samples in
this directory use real measured values from the LABDEMO production — `avgProcessingTime: 0.08`
for Lab Router is what IRIS actually reported, not a plausible-looking number.

`samples/metrics-dump.txt` is the strongest form of this: a raw 1236-line `/api/monitor/metrics`
body, not a reshaped one. It is what proved the proxy's original parser wrong in six places
(issue #10) and what turned up two further mismatches while `proxy-api.md` was written — both
found by running real code over real bytes, neither visible from a hand-written fixture.

## Never edit a contract in place

- **Never** edit a file here as part of an implementation task.
- **Never** add a field to a local type to make code compile. That is a contract change request
  to the owning developer.
- A contract change is its own PR: the schema edit, a `CHANGELOG.md` entry with the reason, and
  a heads-up to the consumer. CODEOWNERS requires all three reviewers.

The reason for the heavy process on a 5-day project: a silent contract change is the failure mode
that breaks the Day-5 integration, and the review takes 30 seconds.

### Estimating what a change costs

When proposing a change, do not estimate the cost from the size of the edit. **The question is not
how many lines reference a value, it's whether anything *means* something in terms of it.** Cost
scales with attached meaning, not with characters.

The worked example from this sprint: removing `Warning` from `HostStatus` was one line in a union,
and it was published as "roughly one line" of consumer impact. The actual reconciliation was **83
insertions across 10 files** — because seven demo fixtures used `status: "Warning"` to *mean* "this
host is degraded", so narrowing the enum made a concept the dashboard had built on
**unrepresentable**. Every one had to be rewritten to signal degradation through findings instead.

Two practices contained it, and they do different jobs:

- **Greppable assumption markers** (`// CONTRACT-Q<n>: assumed OK | Warning | Error | Inactive`)
  made reconciliation *findable*. State the assumption inline — a marker naming only a question
  number sends the reader back to the question list.
- **Defensive rendering** made it *bounded*. Unknown values went down a neutral path from the first
  commit, so the wrong assumption never spread past fixtures and one tone map.

Only the second limits blast radius. A contract change with perfect markers and no defensive
handling still reaches every consumer.

## Validating

The `contracts` CI job validates every file in `samples/` against the schemas. If a contract and
the shared fixtures disagree, CI says so — rather than the Day-5 rehearsal.

```bash
cd contracts && npm install && npm run validate
```

It checks five things, and the middle two are what make the first mean anything:

- each JSON sample against **one named definition** (`HostsResponse`, `FindingsResponse`,
  `InvestigationResponse`, `ResolveResponse`, `ResolveRequest`, `EarlyWarningResponse`).
  `InvestigationRequest` is absent from that list on purpose — it has no sample yet, and is checked
  through §2.2's annotated fence and its accept/reject cases instead (see the gap note above)
- structural cases that must **pass** — `[]`, sub-second timestamps from any language, and the real
  proxy payloads including their `null`s
- cases that must **fail** — a retired `Warning` status, an unknown finding type, a hosts array
  served in the findings position, an alerts response in the metrics position, and the engine's
  current `name`/`messagesErrored` host shape. For the two MVP 2 shapes these are safety properties
  rather than only type errors: a `manualRemediation` carrying an approvable `action`, an
  `appliedBy: "system"` (autonomous remediation, which root `CLAUDE.md` §2.1 forbids), a `dry_run`
  reporting `outcome: "applied"`, and a `confirmation` on a response that applied nothing — the UI
  renders "will clear within N seconds" from that object, so a preview carrying one promises a
  clearance for a write that never happened
- **claims about `samples/metrics-dump.txt`**, which is Prometheus text and cannot be schema-checked
  at all. Regexes over the label shapes `proxy-api.md` quotes, two of them asserting a label is
  **absent** — `iris_interop_queued` and `iris_interop_messages_errored` carry no `host` label, and
  an assertion that something is missing is the only way a future capture silently gaining it gets
  noticed
- **the JSON payloads fenced inside the `*-api.md` prose** (#205), which used to be the one published
  artefact nothing could disagree with — and where #201's twelve days of invalid payloads and #202's
  five divergences both lived. Opt-in via the CommonMark info string, so nothing about how the files
  read changes:

  ````
  ```json validate=resolve.schema.json#/definitions/ResolveResponse
  ````

  Opt-in because most fences here are deliberately *not* whole documents — request bodies, bare
  fragments, error shapes. The compensating rule: every run prints each file's annotated **and**
  unannotated counts, a malformed annotation **fails** rather than skips, and a file that drops to
  `0 annotated` says so on every CI run. `earlywarning-api.md` sat at `0` for as long as it had no
  schema and is at `3 annotated, 0 unannotated` since #219 — the zero was the gap being visible
  rather than absent, and the count moving is what closing it looks like

**Do not replace this with an `ajv-cli` one-liner.** Three reasons, all learned the hard way on
PR #3:

1. Validating against the root schema instead of a named definition cannot tell a hosts array
   from a findings array. That check silently does not happen.
2. `ajv validate -r '#/definitions/HostsResponse'` is not portable — Git Bash on Windows rewrites
   the `#/...` argument into a filesystem path and the command fails.
3. `-c ajv-formats` resolves relative to the invocation directory, so from the wrong place it
   silently ignores `format` rather than failing. A validator that quietly gets weaker is worse
   than one that breaks.
