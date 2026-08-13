# ADR 0005 — The "updates within 10 s" acceptance criterion is not met, and what we state instead

- **Status:** proposed
- **Date:** 2026-08-13
- **Deciders:** Dev B, Dev C
- **Drafted by:** Dev C
- **Source:** the overall acceptance criterion of `production-guardian-healthscan-mvp1.docx`; issue #44

## Context

The MVP doc's overall acceptance reads:

> *dashboard renders all hosts + findings live; **updates within 10 s of a change**; fallback to
> demo mode is seamless.*

We do not meet the middle clause, and we are not going to before MVP 1 ships. This ADR exists
because the criterion lives in a **read-only source document** (root `CLAUDE.md` §3), so the
deviation cannot be recorded by editing the spec. Without an ADR the only trace would be a long
issue thread, and the restated figure would look — to anyone reading later — as though it had
always been the target.

**This is a concession, not a re-interpretation.** We chose a slower, quieter product over a
faster, noisier one. That trade is defensible and it is written down here in those words.

## What was measured

Seven end-to-end runs, all by Dev B on the only machine where the whole chain runs (#70), with
the injection staggered across the proxy's poll phase at Dev C's request:

**Every measurement below was taken with the proxy polling at 5000 ms.** #75 has since halved
that to 2500 ms, which narrows one term and re-phases another — both effects are recorded below,
and the arithmetic bound is restated for the shipped configuration rather than the measured one.

| term | range at the time of measurement | measured, n=7 |
|---|---|---|
| proxy staleness | `[0, 5.0)` — 5000 ms poll | min 0.33, max 3.93, mean 1.77 |
| engine debounce | `[5.0, 10.0)` | min 5.64, max 7.35, mean 6.13 |
| dashboard poll | `[0, 2.0)` | bounded at 2.0; separately measured min 0.67, max 1.45, mean 1.03 |
| **on screen** | | **min 8.81, max 11.59, mean 9.90 — 2 of 7 over 10 s** |

**The measured mean is situational and must not be quoted as the system's behaviour.** Six of
seven runs put the debounce at 5.64–5.71 s, pinned to the floor of its range, because the proxy
and engine both poll at 5 s and were started within a second of each other — very nearly
phase-locked. That is an artifact of how the services were launched, not a property of the
product.

Worse, the two timers are independent `setInterval`s in separate processes, so the offset
**drifts**. A long-running deployment sweeps the whole `[5, 10)` debounce range rather than
sitting at its floor, which means the unfavourable case is not merely possible but eventually
certain — and it arrives hours into a run rather than at startup, where no restart reproduces it.

**This stopped being a prediction while the ADR was in review.** Halving the proxy poll to
2.5 s (#75) re-phased the two timers, and the debounce immediately left the floor it had been
pinned to:

| | debounce, measured |
|---|---|
| proxy at 5000 ms, n=7 | 5.64–7.35 s — six of seven within 0.07 s of each other |
| proxy at 2500 ms, n=2 | **6.43–8.86 s** — 8.86 s is the highest recorded on this project |

So the sweep was demonstrated in one restart rather than over hours, and the two runs after
that change came out at **10.18 s and 11.32 s** — worse than the mean above, because the proxy
improvement (−0.66 s) was smaller than the debounce re-phasing (+1.5 to +3.2 s). The 5.64–5.71 s
cluster was an artifact, as this section already argued; #75 is the evidence rather than the
argument. It also means **8.86 s is the first sample from the upper half of `[5, 10)`**, so the
arithmetic bound below is not a hypothetical worst case being defended against measurements —
the measurements have started walking into it.

So the honest bound is the arithmetic one, stated for the **shipped** intervals — proxy 2500 ms
(#75), engine 5000 ms, dashboard 2000 ms (#68):

```
worst    2.5 + 10.0 + 2.0  ~=  14.5 s
typical  1.25 + 7.5 + 1.0  ~=  9.8 s
```

For reference, at the 5000 ms proxy poll the n=7 measurements were taken against, the same
arithmetic gave `5.0 + 10.0 + 2.0 ≈ 17 s` worst and `~11 s` typical. **The decision does not
move**: 20 s covered 17 s and covers 14.5 s with more margin. What changes is that a reader
comparing the bound against the shipped configuration now gets the same answer the ADR gives.

Note the typical figure has dropped below 10 s while the **bound has not**, and the bound is what
a criterion is. That gap — a system that usually meets a bar it cannot guarantee — is the whole
reason this ADR exists rather than a one-line change to a number.

## Why 10 s is not reachable

The debounce dominates the budget, and it is `sustainedSeconds` doing its job.

A finding confirms only when a condition holds for `sustainedSamples` (2) consecutive polls
**and** `sustainedSeconds` (4) of elapsed time. The time gate exists precisely to stop a faster
poll rate shortening the debounce — added in #46, and #64 established it sets a hard floor under
`POLL_INTERVAL_MS` at the shipped 5000 ms, where 4500 ms already breaks an invariant.

Reaching 10 s therefore requires lowering `sustainedSeconds`, which is lowering the
false-positive protection MVP §6 names as **the top risk**. We declined that twice on the record
(#44, #64), for the same reason each time: a false `dead_host` from one bad scrape is not
explicable to an audience, and a self-imposed bar missed by a factor of two is.

The two other terms were examined and are not where the budget is:

- **the dashboard poll** was the one term gated by no invariant, and it was spent: 5 s → 2 s
  (#68), measured worst case 1.45 s. Nothing further to take
- **the proxy scrape** was halved 5 s → 2.5 s for margin (#75). It removes ~2.5 s from the worst
  case and does not reach the bar. 2.5 and 5 are harmonically related, so the two timers keep a
  fixed *ratio* — but the phase offset still wanders, so this neither prevents nor causes the
  sweep. It was in fact the restart that revealed it

## Decision

**State the criterion as: findings appear on screen within 20 s of a change, typically ~10 s,
measured 8.8–11.6 s — for the seven metric-derived finding types.**

Three numbers, each true, rather than one that needs a footnote:

- **20 s** is the bound we can defend without qualification, because it covers the swept worst
  case (14.5 s on the shipped intervals) rather than the phase alignment we happened to measure
- **~10 s** is the typical figure on the shipped intervals with the phase-lock artifact removed
  (9.8 s arithmetic). It was ~11 s before the proxy poll was halved
- **8.8–11.6 s** is what was actually observed, with `n` and whose machine, per #70 — n=7 at the
  5000 ms proxy poll, plus n=2 at 2500 ms which came out at 10.2 s and 11.3 s

**Do not collapse these into one number.** The typical figure sits below 10 s and the bound does
not, which is exactly the situation the criterion has to describe: a system that usually meets a
bar it cannot guarantee. Quoting only the typical would re-create the claim this ADR exists to
retract, and quoting only the bound would understate a product that is normally twice as good as
its guarantee.

`system_alert` is stated **separately** and is not covered by the above. Until #69 it came down a
different path — a blind 30 s poll of the consume-on-read alerts endpoint — so its worst case was
~30 s plus everything downstream. #69 gates collection on `iris_system_alerts_new`, bringing it to
roughly the metrics cadence, but the before/after has not been re-measured. **No figure is claimed
for it here.**

## Consequences

- MVP 1 ships not meeting one clause of its overall acceptance, deliberately and on the record
- the false-positive protection of `sustainedSamples` + `sustainedSeconds` is unchanged
- `sustainedSeconds` must not be lowered to chase this number without revisiting this ADR; #46's
  own comment and #64's floor are the reasons
- any figure in this ADR that is a mean is situational until the services are launched in a
  randomised phase relationship. The bound is not
- the criterion in the source document is unchanged and still says 10 s. This ADR is the
  deviation record, and the numbers quoted in `apps/dashboard/CLAUDE.md` §8 and
  `apps/dashboard/README.md` point here rather than restating a duration

## Status

`proposed`. Drafted by Dev C from the #44 thread; the measurements are Dev B's and are theirs to
confirm or correct. It should be `accepted` before anyone describes MVP 1 as complete, because
this is the single place where MVP 1 does not meet the spec as written and it needs to be
findable by someone who has only read the spec.
