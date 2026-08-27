# CLAUDE.md — Detection Engine & Findings API (**Developer B**)

Scoped to `services/detection-engine/`. The root `CLAUDE.md` carries the shared rules — scope
boundary, ownership, ports — and applies here too.

---

## 1. What you are building

The **detection engine**: the brains of Health Scan. Three things:

1. **Rolling baseline** — trailing 30-minute, per-host, per-metric window with warm-up handling.
2. **Detection rules** — the eight finding types, configurable thresholds, sustained-breach logic.
3. **Findings API** — `GET /api/healthscan/findings` and `/api/healthscan/hosts` on **`:3002`**.

You consume Dev A's proxy JSON from `:3001`. You produce the contract in
`contracts/healthscan-api.md` for Dev C.

You are the *detection* layer. You read metrics, compare to baseline, emit findings. **You compute
nothing else and act on nothing.**

### 1.1 Scope boundary — MOVED for MVP 2

**Three rows moved from "do NOT build" to "build" when MVP 2 opened.** Root `CLAUDE.md` §2.1 is
authoritative; this section says what it means *here*, because two of the three land in this
service:

| Now in scope for this service | What it is |
|---|---|
| **Early Warning** | Project the queue-depth trend forward and estimate time-to-threshold. An extension of the existing rolling baseline, not a new component — this service already holds the time series in memory |
| **AI Detective orchestration** | Call the AI Hub agent with a finding plus a metric snapshot; receive and serve `{rootCause, evidence[], confidence, recommendedAction}`. **We orchestrate; we do not reason** — the narrative comes from the agent, and the agent lives in IRIS |
| **Smart Resolve endpoint** | `POST /api/resolve` proxies the governed MCP write tool. **We do not mutate the production ourselves** — the write happens in IRIS behind RBAC, and this service is a caller that records what it asked for and what came back |

The distinction in those last two rows is the whole architecture. This service gained
*orchestration* responsibilities, not *authority*: no LLM key reaches it, no write path lives in
it, and it cannot change a production setting even if a bug tried to.

| Still do NOT build here | Belongs to |
|---|---|
| A single 0–100 health score | **Health Score** |
| Report or summary generation | **Health Summary** |
| Natural-language endpoints | **Ask Guardian** |
| Tuning advice | **Performance Coach** |
| Direct mutation of the production from this service | `iris/**` — the governed write tool |
| Root-cause narrative *generated here* rather than by the agent | AI Detective, in IRIS |
| Persisted baseline history, trend storage | Still out — see ADR 0002 |

**A finding still states what is true now, compared to what was normal.** Early Warning adds a
*projection* alongside it, and it must be labelled as a projection rather than folded into the
finding — a forecast presented as a measurement is the same defect class as the coerced
`lastActivity` in #58.

## 2. Architecture, and the decisions behind it

Read the ADRs before changing structure — they record *why*, and each names what would reopen it:

| ADR | Decision |
|---|---|
| `docs/decisions/0001` | Engine runs **outside IRIS**. No ObjectScript here. Consume proxy JSON over HTTP. |
| `docs/decisions/0002` | Baseline is a **rolling in-memory window**. Nothing persisted. Warm-up is `baselineValue: null`, never a seeded guess. |
| `docs/decisions/0003` | Thresholds live in **`thresholds.json`**, hot-reloaded. No thresholds hard-coded in rule logic. |
| `docs/decisions/0004` | **Mock-first.** Never block on Dev A's proxy being up. |

```
services/detection-engine/
├─ CLAUDE.md                  <- this file
├─ package.json               <- zero runtime dependencies (§3)
├─ tsconfig.json
├─ thresholds.json            <- ADR 0003; the only place numbers live
├─ fixtures/
│  └─ proxy/                  <- mocked Dev A responses; scenario per file
└─ src/
   ├─ index.ts                <- wiring: poll loop + HTTP server
   ├─ types/
   │  ├─ proxy.ts             <- Dev A's shape. UNRATIFIED — see §4
   │  └─ healthscan.ts        <- transcription of contracts/healthscan.d.ts
   ├─ config/
   │  └─ thresholds.ts        <- load, validate, hot-reload, last-good fallback
   ├─ baseline/
   │  └─ window.ts            <- ring buffer, per host+metric
   ├─ detect/
   │  ├─ engine.ts            <- runs rules, owns the finding registry
   │  ├─ registry.ts          <- stable ids + sustained-breach state
   │  └─ rules/               <- one file per finding type, eight total
   ├─ proxy/
   │  ├─ client.ts            <- fetch from :3001
   │  └─ mockClient.ts        <- fixture-backed, same interface
   └─ api/
      └─ server.ts            <- the two endpoints
```

## 3. Stack

**Node 20 + TypeScript. Zero runtime dependencies.** Node 20 provides everything needed: `fetch`,
`node:http`, `node:test`, `node:fs.watch`. TypeScript and `@types/node` are the only devDeps.

No Express (14 lines of `node:http` covers two GET routes), no Zod (hand-written guards are
explicit and dependency-free), no test framework (`node:test` is built in), no Prometheus parser —
**we consume Dev A's JSON, not Prometheus text.** Parsing is their component's job, per ADR 0001.

Adding a dependency requires stating why and what it replaces.

## 4. The two contracts, and their different status

**Downstream — `contracts/healthscan-*` is ratified and ours.** Published in PR #3. `src/types/healthscan.ts`
is a direct transcription. **We own it, which means we may not quietly drift from it** — a change is
a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by all three. Dev C's UI is built
against those exact bytes.

**Upstream — Dev A's proxy contract does not exist yet.** `contracts/proxy-api.md` is unlanded.
So `src/types/proxy.ts` is *our assumption* of their output, not an agreed contract.

Follow Dev C's convention, which worked: **tag every assumption site with `// PROXY-Q<n>`** and keep
the running list at the top of `src/types/proxy.ts`. Reconciling when Dev A lands their contract
must be a `grep`, not an audit:

```bash
grep -rn "PROXY-Q" src/
```

Known assumptions so far, each carrying a marker:

- **PROXY-Q1** — per-host objects keyed by config name, with `status` as IRIS reports it
- **PROXY-Q2** — `queued` present per host. **Not in the Prometheus text** (`iris_interop_queued`
  has no `host` label); the proxy must read `Ens.Util.Statistics:EnumerateHostStatus`. Raised in
  ADR 0001 and PR #4
- **PROXY-Q3** — `avg*` fields already aggregated across `messagetype`, weighted by sample count.
  If Dev A passes raw per-messagetype series instead, aggregation moves here
- **PROXY-Q4** — `lastActivityElapsedSeconds` (as IRIS gives it) vs a pre-computed timestamp.
  We assume elapsed and convert, since that is what the metric holds

## 5. Rules — the eight, and how they must behave

| Finding type | Fires on |
|---|---|
| `dead_host` | status is `Error`, `Inactive`, `Stopped`, or `Disabled` |
| `stalled_host` | no activity > threshold **while messages are queued** |
| `queue_buildup` | depth over baseline multiplier **and** over the absolute floor |
| `elevated_error_rate` | errored count rising faster than baseline |
| `slow_processing` | avg processing time over baseline multiplier |
| `growing_queue_wait` | avg queueing time over baseline multiplier |
| `throughput_drop` | messages/sec below baseline fraction |
| `system_alert` | new alert in the proxy's alerts payload |

Non-negotiable behaviours:

- **Sustained breach.** Per MVP §6, a rule needs **2+ consecutive breaching samples**
  (`sustainedSamples`) before a finding is emitted. A single-sample spike emits nothing.
- **Stable ids.** A finding's `id` is stable for the life of the condition, keyed by
  `(host, type)`. Contract Q4 promises Dev C this — their highlight animation and detail drawer
  depend on it. **Never regenerate an id for an ongoing condition.**
- **Findings disappear when cleared.** No `resolvedAt`, no tombstones. Contract Q4.
- **No baseline, no comparative finding.** Below `minBaselineSamples`, comparative rules stay
  silent. `dead_host` and `system_alert` are absolute and still fire.
- **Two absolute rules, six comparative.** Only `dead_host` and `system_alert` work without a
  baseline.
- **`message` is authoritative.** Dev C renders it verbatim and is told not to reconstruct it. It
  must state the actual numbers — `"Queue depth 486 is 32x baseline"`, not `"Queue is high"`.
- **Rules are pure functions** of `(sample, window, config)`. No I/O, no clock reads inside a
  rule — pass time in. This is what makes them testable against fixtures.

### 5.1 Baseline self-inflation — and the two exemptions from it

**A reference baseline exempts a host+metric.** `thresholds.json` `referenceBaselines` states a
normal that does not move; where one exists it wins over the rolling mean, and self-inflation
cannot occur for that pair. Currently only `Cloud API` / `queued`, set to `0`.

**`messagesPerSec` is exempt everywhere, because its baseline is a MEDIAN, not a mean.**
`ROBUST_METRICS` in `baseline/window.ts` carries the full argument and the measurements; the short
version is that self-inflation is only *safe* when higher is worse. Where higher is worse an
inflated baseline makes a rule quieter, which is the failure direction you want. `throughput_drop`
is the only comparative rule where **lower** is worse, so for it an inflated baseline is the
opposite: it manufactures findings on a healthy production, which MVP §6 names as the top risk.

It was measured doing exactly that (2026-08-27). A reset after `pool_bottleneck` removes the
throttle and the accumulated backlog flushes in one burst — 402 messages in 3 seconds, ~134/sec
against an idle 0.5/sec — and a single sample of that burst supplied 68% of a 53-sample mean,
giving a baseline of 1.53 against a true 0.50 and firing `throughput_drop` on all three hosts with
nothing armed. No window length fixes that; a longer window only holds the spike for longer.

Note the direction this exemption cuts: a median makes `throughput_drop` **hold a real drop for
longer**, since a stopped host must fill more than half the window with zeroes before its own
baseline decays. So this is not the "excluding breaching samples" option listed at the end of this
section — it does not exclude anything, and the burst is still recorded and still graphed.

Everything else behaves exactly as described below, which is most metrics on most hosts.

Why it was needed, with the arithmetic rather than the anecdote. §5.1 as originally written
describes a **step**: queue jumps 0 → 486, fires, then clears as the mean climbs. A **ramp** is
worse and was not covered. For a linear rise of `k` per sample over `n` samples the mean is
`k(n+1)/2`, so:

```
ratio = nk / (k(n+1)/2) = 2n/(n+1)     ->  approaches 2.0, never reaches it
```

`k` cancels, so the inflow rate is irrelevant — a faster ramp does not help. Against the 5.0
multiplier the rule is **structurally unable to fire on a rising queue**, at any depth and any
duration. Measured on the live stack: ratio pinned at exactly 2.00 while the queue climbed past
1200, with no finding at any point.

That matters for MVP 2 specifically. MVP 1's scenarios were all steps — disable a host, break its
target — so `queue_buildup` always fired, and `dead_host` is absolute anyway. MVP 2's scenario is
a **ramp on a host whose status stays OK**: throughput-bound but healthy, which is precisely the
case that needs explaining rather than being self-evident. No absolute rule backs it up.

A longer window was considered and rejected: it fixes the arithmetic but not a demo, because a
fresh `compose up` has no history to put in it, `minBaselineSamples` is satisfied after 12
samples, and a multi-day window holding only the last minute would claim evidence it does not
have. A stated reference says "assumed"; a long window implies "measured".

`test/silence.test.ts` now pins the **new** behaviour — that the finding persists while the queue
does. The previous test pinned the opposite and carried the note *"if this now fails,
self-inflation has been addressed and CLAUDE.md §5.1 needs updating"*. It failed, and this is that
update. Inverted rather than deleted, so it keeps noticing.

#### The original behaviour, which still applies everywhere without a reference

A rolling mean includes the breaching samples, so **a sustained problem becomes the new normal
and its comparative finding clears while the bad value persists.** With `queued` going 0 → 486,
`queue_buildup` fires, then stops once the mean has climbed enough that the ratio falls below the
multiplier.

This is inherent to ADR 0002's rolling window, not a bug. `test/baseline.test.ts` pins the
behaviour so nobody "fixes" it unknowingly. Note that the absolute rules are unaffected —
`dead_host` keeps firing for as long as the host is down, which is why the demo's headline
finding is a reliable one.

If it needs addressing later, the options are excluding breaching samples from the window, or a
longer window, or a persisted baseline (ADR 0002's named revisit trigger). All three are out of
scope for MVP 1.

### 5.2 Severity `info` is deliberately unreachable for the seven per-host rules

Each comparative rule's firing gate **equals** its `severityBands.warning` — `queue_buildup` fires
at 5× and warns at 5× — so anything that fires is at least a warning. `dead_host` and
`stalled_host` carry fixed severities. **`system_alert` is the only source of an `info` finding.**

Do not "fix" this by lowering a warning band: reaching `info` would require lowering the firing
**gate**, which widens what fires and reintroduces exactly the false positives MVP §6 names as the
top risk. A quiet findings list is the point. `thresholds.json` carries the same note, and
`test/scenario.test.ts` asserts `info` comes only from `system_alert`, so a drift fails loudly.

### 5.2b `system_alert` only sees alerts that name a host

An alert is matched to a host by **substring**: the host name must appear in the alert's
message text (`detect/engine.ts`, `#evaluateAlerts`). An alert naming no **reported** host
produces **no finding at all** — not an unattributed one, and nothing records that it was seen.
Measured (#61):

```
Cloud API failed to send message                      -> FIRES
Disk space for database IRIS/mgr/ is critically low   -> SILENT
License limit exceeded: 100 of 100 connections        -> SILENT
Journal file system is full                           -> SILENT
WARNING: write daemon is falling behind               -> SILENT
Ens.MonitorService failed to start                    -> SILENT   <- see below
```

**"Reported", not "configured".** A framework host IS a config item in the production — what
it is not is *reported*: `applyPoll` skips `isFrameworkHost(...)` before adding to `seenHosts`,
so framework items are absent from the roster and from the attribution set. So an alert naming
`Ens.MonitorService` or `Ens.Alarm` produces no finding either, and that is the near-miss a
reader is most likely to hit, since `/api/monitor/alerts` is largely about IRIS's own
subsystems. The wording matters because "no configured host" sends someone to check the
production, where they find the item present and conclude the log means something else
(@tanifgit, #62).

**This is deliberate for MVP 1 and it is a real coverage limitation.** Instance-level alerts
are the class an operator most wants surfaced, and Health Scan does not surface them. The two
ways to change that both cost more than they are worth here: a synthetic `System` host would
be an entry in the host array corresponding to no config item, which breaks the "only
application config items appear" guarantee in `contracts/healthscan-api.md` §2 — the same
invariant #34 was diagnosed against — and a production-level findings channel is a new output
shape, i.e. Health Summary's job (root `CLAUDE.md` §2).

**Do not "fix" this by loosening the match.** Matching more broadly means attributing an
instance-wide condition to whichever host name happens to appear in the text, which is worse
than silence: a confident wrong attribution rather than a known gap. If it is addressed later,
the shape to reach for is a count of unattributed alerts in an existing `_meta` object, not a
change to what a `Finding` is.

The engine logs each unattributed alert once, so the gap is visible in operation rather than
only in this file.

### 5.3 An alert is an event, not a sustained condition

`system_alert` is exempt from the sustained-breach *suppression* that the other rules use, though
the registry still requires two consecutive verdicts before confirming. It reports for as long as
the alert stays in the proxy payload and clears when it ages out.

An earlier version marked an alert seen on its first poll and returned `null` afterwards, which
made the rule **structurally unable to fire**: the registry needs `sustainedSamples` consecutive
verdicts and only ever got one. Every rule unit test passed, because the conflict was *between*
the rule and the registry rather than inside either. It surfaced only because Dev C observed 46
live findings with no `system_alert` and no `info` severity among them.

The lesson generalises: a rule tested in isolation can be dead once composed with the registry.
`test/scenario.test.ts` exists to catch that class — it asserts the demo loop can actually produce
all eight types.

### 5.4 A finding that no action can clear is a defect in the threshold, not in the fix

`Cloud API`'s `slow_processing` floor is **1.5s**, not the 0.2s the rule ships — a `hostOverrides`
entry, with the full derivation in `thresholds.json`. It looks like an over-tolerant bound and it is
not; **do not lower it back without reading that note.**

The reasoning is worth stating here because it generalises past this one number. MVP 2's scenario
throttles `Cloud API`'s downstream to ~1s per call, and Smart Resolve fixes it by enlarging the pool.
`avgProcessingTime` reads **1.01s before the fix and 1.01s after it** — measured, 13 samples across
two sessions — because pool size changes *concurrency*, not per-message latency: four workers make
four 1s waits overlap, so throughput quadruples and the queue drains to zero while every individual
message still takes ~1s.

So at a 0.3s floor this rule emitted a `critical` finding that **the product's own remediation could
not clear**, and it sat on the board after a fix that had emptied the queue. That is the shape to
watch for: when a comparative rule reads a metric the recommended action does not move, no
multiplier and no floor can make it fire during the fault and clear after it — the two values are
the same measurement. The choice is then between suppressing it for that host and shipping a finding
that outlives every remedy, and the second is worse than a coverage gap, because it teaches an
operator that a cleared condition still shows red.

Suppression is right *here* specifically because the host is an outbound operation whose processing
time is a remote dependency's latency, and because the two findings that do describe the fault —
`queue_buildup` and `growing_queue_wait` — both clear correctly. Verified end to end on
2026-08-27: two criticals during the fault, `queue_buildup` gone 72s after the apply, the last
finding aged out at ~200s, then zero findings held for a further 200s with the throttle still armed.

**The baseline was deliberately not touched.** Raising `referenceBaselines` to 0.34 would also have
silenced it, and would have put an invented normal into every finding message and into the evidence
the agent reads — the values in that block are captured from `contracts/samples/`, per §6. The floor
answers "is this worth reporting", which is the question that actually changed.

## 6. Never invent data

- **No fabricated hosts, metrics, or findings outside `fixtures/`.** Fixtures use the LABDEMO
  application components — **EMR Source** (service), **Lab Router** (process), **Cloud API**
  (operation) — and the eight real finding types. The authoritative list is the `<Item>` set in
  `iris/labdemo/Production.cls`; do not restate it here beyond this note, because a host list
  duplicated across areas is exactly what went stale when `FHIR Transform` was removed.
- Fixture values should be **captured from live LABDEMO**, not invented. Real numbers catch real
  problems; `contracts/samples/` was built that way.
- If the proxy is unreachable, serve last-known findings and report `X-Healthscan-State: stale`.
  **Never invent a plausible reading to fill a gap**, and never emit a finding from absent data.

## 7. API behaviour

Per §3 of `contracts/healthscan-api.md`:

- Zero findings → `200` + `[]`. **Never `404`.**
- Warming up → `200` + `[]` + `X-Healthscan-State: warming`.
- Proxy unreachable → `200` + last-known + `X-Healthscan-State: stale`.
- Genuine fault → `500` + `{"error": "..."}`.
- Always send `Access-Control-Allow-Origin: *` (contract Q9).
- `findings` sorted `detectedAt` desc, severity tiebreak. `hosts` sorted by name.
- **Filter framework hosts.** `Ens.MonitorService`, `Ens.Alarm`, `Ens.ScheduleHandler`,
  `Ens.Actor`, `EnsLib.Testing.*`, `Ens.Activity.Operation.Local` and friends never reach the API.
  **The count is in `contracts/healthscan-api.md` §2 and is not restated here** — this line said
  "exactly four" until 2026-08-14, contradicting the ratified contract's "exactly three", while
  naming `Ens.Activity.Operation.Local` as filtered *in the same sentence*. `Production.cls` has
  four `<Item>` entries and the fourth is that framework host, so three are returned; every live
  run confirms three. Almost certainly correct when written and staled when the item set changed
  underneath it (@tanifgit, #84).

Prefer stale-but-labelled over an error: a blanked dashboard is worse on stage than slightly old
data.

## 8. Verify before claiming done

```bash
npm run typecheck    # tsc --noEmit, strict. No `any`, no @ts-ignore
npm test             # node:test
npm run dev          # engine against fixtures, no proxy needed
```

- **Test the negative cases.** A rule that fires correctly but never *stops* firing is broken. A
  schema test that only checks valid input proves nothing — prove rejection too.
- **Run the tests and show real output.** If something fails or is unverified, say which and paste
  it. A green claim over a red build costs the team more than the bug did.
- The engine must start and serve with **no proxy running** (ADR 0004). If it cannot, mock-first
  is broken.
