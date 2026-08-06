# ADR 0002 — Baseline strategy

- **Status:** proposed
- **Date:** 2026-08-06
- **Deciders:** Dev A, Dev B, Dev C
- **Drafted by:** Dev B (implementer)
- **Source:** §7.4 decision 2 of `production-guardian-healthscan-mvp1.docx`

## Context

Every detection rule except `dead_host` and `system_alert` is comparative — "queue depth exceeds
baseline by > X%", "throughput falls below baseline". So the engine needs a notion of normal.

Two candidates: a rolling in-memory window, or persisted history in a table. The MVP doc
recommends in-memory for MVP 1, "persistence is a later enhancement."

`docs/…mvp1.docx` §6 also names baseline warm-up as a named risk: "Baseline needs warm-up time
(no history at startup)," mitigated by seeding from the first N samples and showing a "baseline
warming up" state.

## Decision

**A rolling in-memory window: a trailing 30-minute, per-host, per-metric ring buffer of samples,
held in the engine process. Nothing is persisted.**

Warm-up is explicit and visible rather than hidden:

- Below the minimum sample count, a metric has **no baseline**. Comparative rules do not fire.
- The API reports this as **`baselineValue: null`** (contract Q3) plus an advisory
  `X-Healthscan-State: warming` header.
- At 10s proxy polls, a 30-minute window is ~180 samples. We require **12 samples (~2 minutes)**
  before a baseline is usable — enough to be meaningful, short enough that a demo does not stall.

## Rationale

**No historical trend charts are in scope.** §1.4 rules them out, and `apps/dashboard/CLAUDE.md`
§1.1 forbids time-series graphs. Persistence exists to serve history; MVP 1 displays none. Building
a store for data nothing reads is the definition of premature.

**It keeps the engine stateless-by-restart, which is a testing advantage.** Rules are pure
functions of (current sample, window). That is what makes the 8 rules unit-testable against
fixtures with no database and no IRIS.

**Warm-up as a first-class state is better than a seeded guess.** The doc suggests seeding the
baseline from the first N samples. We do the stricter thing: report "no baseline yet" honestly.
A fabricated baseline produces fabricated findings — a false `queue_buildup` at second 11 because
the "baseline" is one sample old. `baselineValue: null` is the contract-visible truth, and Dev C
already renders it as an em dash.

**It composes with sustained-breach.** §6 requires 2+ consecutive samples before flagging. Both
mechanisms need the same ring buffer, so there is one state structure, not two.

## Consequences

**Accepted costs:**

- **An engine restart loses all baselines**, and the dashboard shows warming for ~2 minutes.
  Mitigation for the demo: start the engine before the rehearsal, not during it. Worth putting on
  the presenter cue sheet.
- **No cross-restart or day-over-day comparison.** "Normal for a Monday morning" is not
  expressible. Out of scope for MVP 1; it is Early Warning's problem.
- **Memory grows with hosts × metrics.** Bounded and small: 4 hosts × 6 numeric metrics × 180
  samples ≈ 4,300 numbers. Irrelevant at LABDEMO scale; worth revisiting at hundreds of hosts.

**Gained:**

- No schema, no migration, no persistence layer to build in a 5-day project
- Rules are pure and trivially testable
- No stale-baseline bugs, because there is no stale baseline to have

## Alternatives considered

**Persisted history in an IRIS or SQLite table.** Rejected for MVP 1 — it serves history, and MVP 1
shows none. This is the obvious first enhancement, and the natural prerequisite for **Early
Warning** (forecasting needs more than 30 minutes) and **Health Score** (trending a score over
time).

**Seed the baseline from the first sample** so rules fire immediately. Rejected: it manufactures
false findings during warm-up, which §6 lists "too many false-positive findings" as a named risk
against. A demo that shows three spurious criticals in its first ten seconds is worse than one
that says "warming up."

**Fixed thresholds only, no baseline.** Rejected — it is a different product. Five of the eight
finding types are defined comparatively. But note thresholds are configurable per ADR 0003, so a
demo *can* be forced deterministic by setting absolute floors, which is the escape hatch §6 asks
for.

## Revisit when

- Early Warning begins — forecasting needs persisted history
- Baseline warm-up after restart proves disruptive in rehearsal
- Host count grows enough for memory to matter
