# Architecture decision records

The four decisions §7.4 of the MVP doc asks to settle before starting. Recorded because they are
the questions most likely to be re-litigated on Day 4.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-detection-engine-location.md) | Detection engine runs outside IRIS, in `services/detection-engine/` | proposed |
| [0002](0002-baseline-strategy.md) | Rolling 30-minute in-memory window; nothing persisted | proposed |
| [0003](0003-threshold-configuration.md) | JSON config file, hot-reloaded, conservative defaults | proposed |
| [0004](0004-mock-first-contracts.md) | All three build against mocked contracts from Day 1 | **needs all three to confirm** |

0001–0003 were drafted by Dev B, who implements them, and follow the MVP doc's recommendations.
0004 is not a technical choice but an agreement between three people — it stays `proposed` until
Dev A and Dev C each confirm rather than inherit someone else's summary.

## Conventions

- One decision per file, `NNNN-short-slug.md`, numbered in decision order.
- **Never rewrite a decided ADR.** Supersede it with a new one and mark the old
  `superseded by NNNN`. The point is the record of *why*, including reasoning later abandoned.
- Every ADR carries a **Revisit when** section. A decision right for MVP 1 is often wrong for
  Smart Resolve; naming the trigger in advance is what stops Day-4 re-litigation.
- `docs/decisions/` is shared and PR-gated — a change needs review, not a direct push.
