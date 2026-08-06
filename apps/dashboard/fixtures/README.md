# Fixtures — demo-mode scenarios

Demo mode is a first-class deliverable, not a stub: it is the Day-5 fallback and
the screencast source (`apps/dashboard/CLAUDE.md` §5).

## Rules these files follow

- **The four LABDEMO components only** — `EMR Source` (service), `Lab Router`
  (process), `FHIR Transform` (process), `Cloud API` (operation). Demo and live
  must look continuous, so no invented hosts.
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

It resolves each fixture's relative ages into timestamps exactly as `mockClient`
does, then validates the result against `contracts/healthscan.schema.json`. Skips
cleanly when `contracts/` is not checked out.

## The files

| File | Purpose |
|---|---|
| `scenario-healthy.json` | Zero findings — exercises the empty state, which looks bad if it breaks on stage |
| `scenario-queue-buildup.json` | Lab Router queue climbing past baseline |
| `scenario-dead-host.json` | Cloud API stopped, plus the stall it causes upstream |
| `scenario-error-storm.json` | Cloud API rejecting messages, errors well above baseline |
| `scenario-slow-processing.json` | FHIR Transform processing time inflated |
| `scenario-throughput-drop.json` | EMR Source intake collapsed |
| `scenario-system-alert.json` | Alert posted to alerts.log |
| `scenario-baseline-warming.json` | `baselineValue: null` — the warm-up state (contract §4 Q3) |

`mockClient` walks a scripted progression through a subset of these so the
dashboard visibly comes alive during the demo without anyone touching IRIS.
`?scenario=<id>` jumps straight to one for screenshots.
