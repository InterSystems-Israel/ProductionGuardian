# ADR 0003 — Threshold configuration

- **Status:** proposed
- **Date:** 2026-08-06
- **Deciders:** Dev A, Dev B, Dev C
- **Drafted by:** Dev B (implementer)
- **Source:** §7.4 decision 3 of `production-guardian-healthscan-mvp1.docx`

## Context

Each of the eight rules needs numbers: how far above baseline is a `queue_buildup`, how long
without activity is `stalled_host`. Fixed constants, or configurable?

The MVP doc recommends "configurable via a small config file, seeded with conservative defaults,
so the demo can be tuned without redeploying." §6 lists **"too many false-positive findings"** as
a named risk, mitigated by conservative defaults plus configurability plus sustained-breach.

## Decision

**A single JSON config file, `services/detection-engine/thresholds.json`, re-read on change
without a restart. Conservative defaults committed. Every rule's numbers live there — no
thresholds hard-coded in rule logic.**

Structure: global defaults per rule, with optional per-host overrides.

```json
{
  "sustainedSamples": 2,
  "minBaselineSamples": 12,
  "rules": {
    "queue_buildup": {
      "baselineMultiplier": 5.0,
      "absoluteFloor": 50,
      "severity": { "warning": 5.0, "critical": 20.0 }
    },
    "stalled_host": {
      "inactiveSeconds": 300,
      "requiresQueued": true
    }
  },
  "hostOverrides": {
    "Cloud API": { "slow_processing": { "baselineMultiplier": 8.0 } }
  }
}
```

Two cross-rule keys sit at the top because they are engine-wide, not per-rule:
`sustainedSamples` (§6's 2+ requirement) and `minBaselineSamples` (ADR 0002's warm-up gate).

## Rationale

**A rule needs two conditions, not one.** `queue_buildup` at `baselineMultiplier: 5.0` alone
fires when depth goes 1 → 5, which is noise. With `absoluteFloor: 50` it must be both 5× baseline
*and* over 50 deep. This is the single biggest false-positive lever, and it only works if both
numbers are configurable together.

**Severity is a threshold, not a rule property.** The same condition is a warning at 5× and
critical at 20×. Putting severity bands in config means tuning demo drama without touching code.

**Hot-reload matters specifically for the demo.** "Tunable without redeploying" is the doc's
phrasing, and the reason is Day-5: if a trigger does not produce a visible finding during
rehearsal, the fix must be a number change, not a rebuild. Reload on file-mtime change, log the
new values, keep serving on malformed input.

**Per-host overrides because hosts are not alike.** Cloud API is an outbound operation whose
latency depends on a simulated remote call; Lab Router is in-process. One `slow_processing`
multiplier across both guarantees a wrong answer for one of them.

## Consequences

**Accepted costs:**

- **Config is a new failure mode.** A malformed file could silently disable detection. Mitigation:
  validate on load, refuse to apply an invalid file, keep the last-good values, and log loudly.
  Never fall back to zero-thresholds, which would fire everything.
- **Defaults are guesses until LABDEMO runs under load.** They are starting points to be corrected
  by observation, not settled values. The committed numbers should be revised once each of the
  eight triggers has been induced.
- **Per-host overrides can hide a real problem.** Raising Cloud API's multiplier to stop a nagging
  warning also raises the bar for a genuine regression. Overrides should be rare and commented.

**Gained:**

- False-positive tuning without a deploy — the §6 mitigation, actually available
- Demo can be made deterministic by setting absolute floors, the escape hatch §6 asks for
- Rule code stays declarative: rules read config, they do not embed policy

## Alternatives considered

**Hard-coded constants.** Rejected — it makes the §6 false-positive mitigation unavailable and
turns any Day-5 tuning into a rebuild.

**Environment variables.** Rejected. Nested per-rule, per-host structure flattens badly
(`QUEUE_BUILDUP_CLOUD_API_MULTIPLIER`), and env vars cannot hot-reload — the property we most
want.

**A settings UI in the dashboard.** Rejected, and out of scope: `apps/dashboard/CLAUDE.md` §1.1
makes the dashboard display-only and forbids control surfaces. It would also make Dev C's
component write to Dev B's, crossing the ownership boundary.

**Thresholds in IRIS as a lookup table.** Rejected — contradicts ADR 0001's "no custom IRIS code"
for MVP 1.

## Revisit when

- All eight triggers have been induced against LABDEMO and the defaults can be replaced with
  observed values
- Threshold tuning starts needing an audit trail (who changed what, when)
- **Smart Resolve** begins — acting on a finding raises the cost of a false positive sharply, and
  these numbers will deserve more rigor than a JSON file
