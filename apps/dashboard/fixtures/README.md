# Fixtures — demo-mode scenarios

Demo mode is a first-class deliverable, not a stub: it is the Day-5 fallback and
the screencast source (`apps/dashboard/CLAUDE.md` §5).

## Rules these files follow

- **The three LABDEMO components only** — `EMR Source` (service), `Lab Router`
  (process), `Cloud API` (operation). Demo and live must look continuous, so no
  invented hosts. `FHIR Transform` was a fourth until `contracts/` PR #15: it was
  a real pass-through routing item, removed from the production when the pipeline
  became HL7→PID, so the samples were older than the production rather than wrong.
- **Numbers are anchored to measured LABDEMO values, never invented** (issue #6).
  The healthy steady state is the capture Dev B re-measured over three samples:
  `EMR Source 0.2` msg/sec, `Lab Router 1.2`, `Cloud API 0.4`;
  `avgProcessingTime` `0`/`0.08`/`0.05`; `avgQueueingTime` **0 except Cloud API**
  at `0.02`, because only the terminal operation ever waits. Every other scenario
  is a departure from those numbers. The topology matters as much as the
  magnitude — service lowest, process highest, operation between — since hosts
  reporting the same rate is what made the old set read as synthetic.
- **The eight real finding types only** — the snake_case names in the contract.
- **Timestamps are relative**, stored as `lastActivitySecondsAgo` /
  `detectedSecondsAgo`. `mockClient` resolves them against load time into ISO
  strings. Absolute dates would make the demo read "3 weeks ago" the day after
  rehearsal.
- **Shape matches the contract exactly.** The same guards in `src/api/guards.ts`
  run over fixture data as over live data. If a fixture is dropped by a guard,
  the type transcription is wrong — that is the point of running them here.
- **`status` uses the real IRIS enum** — `OK`, `Error`, `Inactive`, `Retry`,
  `Stopped`, `Unconfigured`, `Disabled` (contract §4 Q1). There is **no
  `Warning`**: a struggling host still reports `OK`, and the *finding* is what
  signals trouble. Fixtures that used `Warning` to mean "degraded" were rewritten
  to say so through findings instead.

## Checking them

The guards are deliberately lenient — they coerce and log-and-skip so one bad
payload cannot blank the grid on stage. That leniency means a fixture can drift
from the contract and still render, so the shape claim above gets a strict check
of its own:

```bash
npm run validate:fixtures
```

That runs two checks. The first resolves each fixture's relative ages into
timestamps exactly as `mockClient` does, then validates the result against
`contracts/healthscan.schema.json`. It skips cleanly when `contracts/` is not
checked out.

The second (`validate-fixture-claims.mjs`) checks the two things the schema
cannot, because a fixture can be perfectly *shaped* and still be false:

- **The arithmetic in `message`.** `message` is authoritative and rendered as-is
  (`CLAUDE.md` §2.4), so "23x baseline" against numbers that divide to 8.9 puts a
  false sentence on a projector. Also checks that a finding agrees with the host
  row it describes — otherwise the card and the drawer disagree about the same
  number on the same screen.
- **That Dev B's engine would actually emit it.** Reproduces the bands and floors
  from `services/detection-engine/thresholds.json`, so a fixture below
  `absoluteFloor`, or claiming a severity outside the configured band, fails. It
  also rejects a comparative finding with `baselineValue: null`, since every
  comparative rule returns early when its baseline is absent — only `dead_host`,
  `stalled_host` and `system_alert` can appear during warm-up.

That second check caught two findings in this set that validated fine and the
engine would never have produced. Reproducing the engine's logic means it drifts if
Dev B retunes — which is the point, since a fixture that silently stops matching the
engine is exactly what is being guarded against.

Both checks **skip cleanly** when the thing they need is absent: `contracts/` and
`services/detection-engine/` each land via their own PR, so neither may fail a
dashboard branch that simply predates them. That leniency is wrong for CI, where a
step reporting success while validating nothing is the failure mode being guarded
against — so use the strict form there:

```bash
npm run validate:fixtures:strict   # a missing contract or thresholds file FAILS
```

## The files

| File | Purpose |
|---|---|
| `scenario-healthy.json` | Zero findings — exercises the empty state, which looks bad if it breaks on stage. Also the measured baseline every other file departs from |
| `scenario-queue-buildup.json` | Lab Router's queue climbing behind a slowed Cloud API |
| `scenario-dead-host.json` | Cloud API `Disabled`, plus the stall and throughput collapse it causes on Lab Router upstream |
| `scenario-error-storm.json` | Cloud API in `Error`, rejecting messages while Lab Router retries |
| `scenario-slow-processing.json` | Lab Router processing time inflated, queue climbing behind it |
| `scenario-throughput-drop.json` | EMR Source intake stopped, the drop propagating through all three hosts |
| `scenario-system-alert.json` | Alert posted to alerts.log |
| `scenario-baseline-warming.json` | `baselineValue: null` — the warm-up state (contract §4 Q3), so only the absolute rules appear |

Two notes on reading these, both learned from checking them against the real engine:

- **A zero baseline is normal, not a bug.** LABDEMO idles at `queued: 0` and
  `avgQueueingTime: 0` on two of the three hosts, so a real buildup has no ratio
  to quote. The engine treats its absolute floor as the whole test there and says
  "with no baseline queue" rather than "∞x baseline".
- **A rolling baseline is not the steady-state table.** `scenario-slow-processing`
  gives Lab Router a `growing_queue_wait` baseline of `0.02` even though the
  measured table has its `avgQueueingTime` at `0`. That is deliberate: the engine's
  baseline is a 30-minute rolling mean (ADR 0002), so a host that idles at zero
  still carries a small non-zero mean if anything queued during the window. The
  value came from the finding this scenario used to hang on `FHIR Transform`, and
  it is kept rather than zeroed because a zero baseline changes the engine's own
  message to the "no baseline" wording, which a fixture may not invent.
- **`elevated_error_rate` compares a rate, not the counter.** `host.errored` is
  IRIS's cumulative count, but the finding's `currentValue` is errors/min — a
  cumulative counter only ever rises and would flag forever once it moved. The two
  numbers are meant to differ.

`mockClient` walks a scripted progression through a subset of these so the
dashboard visibly comes alive during the demo without anyone touching IRIS.
`?scenario=<id>` jumps straight to one for screenshots.
