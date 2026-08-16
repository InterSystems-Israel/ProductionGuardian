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

### 1.1 Hard scope boundary

| Do NOT build | Belongs to |
|---|---|
| Restarting hosts, clearing queues, any remediation | **Smart Resolve** |
| Root-cause narratives, evidence chains, confidence scores | **AI Detective** |
| Forecasts, "will breach in N minutes", trend extrapolation | **Early Warning** |
| A single 0–100 health score | **Health Score** |
| Report or summary generation | **Health Summary** |
| Natural-language endpoints | **Ask Guardian** |
| Persisted baseline history, trend storage | Out of MVP 1 — see ADR 0002 |

**A finding states what is true now, compared to what was normal. Nothing more.** If a request
implies a row above, say so instead of building it.

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

### 5.1 Baseline self-inflation — known, deliberate, pinned by a test

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
