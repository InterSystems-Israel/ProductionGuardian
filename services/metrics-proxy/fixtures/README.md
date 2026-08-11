# fixtures/

Captures from a live IRIS instance, plus the smaller hand-written excerpts that predate
them. Committed so every developer mocks against the same bytes (ADR 0004).

| File | Provenance |
|---|---|
| `metrics-live-capture.txt` | **Real.** Full 313-line `/api/monitor/metrics` body, IRIS for Health 2024.1 on Windows, captured 2026-08-11 running the post-`1801a50` `ProductionGuardian.LabDemo.Production`. |
| `alerts-live-capture.json` | **Real.** Full `/api/monitor/alerts` body, same instance, captured 2026-08-11. See the warning below — this endpoint cannot be re-captured at will. |
| `metrics.txt` | Hand-trimmed 3-host excerpt in the real label shape. Kept because it is small enough to reason about; `MOCK_FIXTURE=metrics.txt npm run mock` serves it. |
| `alerts.json` | **Hand-written, and its field names are wrong** — see below. |

## `/api/monitor/alerts` is consume-on-read

Verified 2026-08-11 against IRIS 2024.1: the first `GET` returned two alerts and every
`GET` after it returned `[]`, while `iris_system_alerts_log` stayed at `2` and
`iris_system_alerts_new` dropped `1 → 0`. The endpoint returns alerts *new since the
last read* and clears them. `mgr/alerts.log` keeps the durable copy.

Consequences:

- **`alerts-live-capture.json` may be the only JSON-shaped copy of this data.** It was
  obtained by accident, on the first-ever read of that instance. Re-running `curl`
  against a quiet instance returns `[]`, not this.
- The proxy **accumulates** alerts rather than replacing them each poll — its own read
  is what removes them from IRIS. See the note at the top of `../src/cache.js`.
- Anything else that reads that endpoint (a second proxy instance, a manual `curl`, the
  SMP) **steals alerts from the proxy**. If you need to inspect it by hand, expect to
  lose whatever you see from the proxy's view.

## The real alert shape vs `alerts.json`

The live body's keys are **`time`, `severity`, `message`**. `severity` is a
**numeric string** (`"2"`), matching the level column in `alerts.log`, not a word.

`alerts.json` was written before any capture existed and uses `id`, `severity`,
`text`, `timestamp`, `source` — with `severity: "warning"`. **Four of its five field
names do not exist upstream, and the fifth has a different value space.**

It has not been silently corrected, for two reasons:

1. Those field names are what `contracts/` implies downstream, and `contracts/` is
   read-only outside a contract PR. Rewriting the fixture to the real shape would put
   the mock and the contract in conflict without settling which one wins.
2. `alerts.json` is what Dev B's tests currently run against.

**This is an open contract question**, to be resolved in the `contracts/proxy-api.md` PR
alongside PROXY-Q1–Q5: either the proxy maps IRIS's `time`/`severity`/`message` onto the
`timestamp`/`severity`/`text` shape the findings API expects — including deciding what
`"2"` means as a word and where `source` comes from, since IRIS does not supply one — or
the contract adopts the upstream names. Until that is decided, the proxy forwards
upstream alert objects **unmodified** except for an added `observedAt`, so no mapping is
invented here.
