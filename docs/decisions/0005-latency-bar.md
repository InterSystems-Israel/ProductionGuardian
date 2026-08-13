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
argument. It also means **8.86 s was the first sample from the upper half of `[5, 10)`**, so the
arithmetic bound below is not a hypothetical worst case being defended against measurements —
the measurements have started walking into it. ("The highest recorded on this project", as the
table above said when written; the n=12 run below has since exceeded it, which is the point that
section makes.)

### Confirmed against the containerised stack, n=12 — the prediction above held

The measurements above were taken on the demo instance: IRIS behind an external web gateway,
with the proxy and engine as host processes. The compose stack (#72, #78) is the reference
environment now — four containers, no gateway hop, `Cloud API` posting to `127.0.0.1:52773`
in-container. Re-measured there with `tools/measure-latency.mjs`, which arms the trigger and
reads the findings API **inside one process**, so no agent round trip enters the sample (the
mistake that invalidated the first figure on #44):

| | to findings API | on screen, +1.0 s expected | over the 10 s bar |
|---|---|---|---|
| n=12, proxy 2500 ms, engine 5000 ms | min 6.09, median 9.75, mean 9.04, max 10.73 | min 7.09, median 10.75, mean 10.04, max 11.73 | **9 of 12** |

**This is worse than the 2 of 7 above, and it is the section above being proved right rather
than a regression.** That earlier figure came from very nearly phase-locked timers; this section
predicted that drift would sweep the debounce across `[5, 10)` and make the unfavourable case
"not merely possible but eventually certain". With the phase-lock removed — consecutive runs
inject at decorrelated offsets in the proxy's cycle — the samples do exactly that, and the
majority land above the bar.

**So the measured typical is now above 10 s, not below it.** The median is 10.75 s. The 9.8 s
"typical" quoted elsewhere in this ADR is the *arithmetic* figure derived from the intervals, and
it is no longer what the samples show — which is why the Decision below no longer states a
typical at all. Naming that explicitly because the first version of this section said the typical
case "sits just under" the bar, directly beneath a table showing the opposite; the arithmetic and
the measurement had diverged and only one of them was in front of me.

Two notes on the method, because both were mistakes I made first:

- **A linear phase ramp is not a stagger.** Sweeping the offset 0 → interval in equal increments
  produced a monotonic sequence (10.67 → 9.25 s) that reads as a trend in the product and is
  really the ramp walking toward the next poll boundary in step with the run counter. The offsets
  are bit-reversed now, and the correlation disappears.
- **Worst case and expected case are not comparable.** Adding a full dashboard interval to every
  sample and comparing against figures that used a measured mean would manufacture a regression
  out of a change of convention. The harness reports both; the table above uses the expected
  case, matching how the n=7 row was built.

The containerised topology did **not** make this faster, which is worth stating because the
opposite was the reasonable expectation from removing a network hop. The gateway hop was never a
significant term — it was inside the proxy staleness window either way — and the budget is
dominated by the debounce, which is unchanged. Removing a service simplified the deployment; it
did not buy latency.

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

Note the **arithmetic** typical has dropped below 10 s while the **bound has not**, and the bound
is what a criterion is. That gap is the whole reason this ADR exists rather than a one-line change
to a number.

This paragraph used to add "a system that usually meets a bar it cannot guarantee". The n=12
measurement below retires that phrasing: the *arithmetic* typical is 9.8 s, but the *measured*
median is 10.75 s with 9 of 12 runs over, so "usually meets" describes the arithmetic and not the
system. The gap is real either way — it is now between the bound and the measurement rather than
between the bound and a comfortable typical.

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

**State the criterion as: findings appear on screen within 20 s of a change, measured
7.1–11.7 s with a median of 10.8 s — for the seven metric-derived finding types.**

Two numbers, each true, rather than one that needs a footnote:

- **20 s** is the bound we can defend without qualification, because it covers the swept worst
  case (14.5 s on the shipped intervals) rather than the phase alignment we happened to measure
- **7.1–11.7 s, median 10.8 s** is what was actually observed, with `n` and whose machine per
  #70 — n=12 on the containerised reference stack with injection staggered across the proxy's
  poll cycle. **9 of those 12 were over 10 s.** Earlier samples, superseded because their timers
  were near phase-locked: n=7 at a 5000 ms proxy poll gave 8.8–11.6 s with 2 over, and n=2 after
  #75 gave 10.2 s and 11.3 s

**A "typically ~10 s" figure used to be the third number here and it has been removed.** It read
as a claim about observed behaviour, and the n=12 measurement contradicts it: the measured median
is 10.75 s, i.e. *above* the bar, and three quarters of runs miss it. The 9.8 s arithmetic
*typical* is still computable from the intervals and still appears above in the bound derivation,
but it is not what a reader gets when they see "typically" next to a measured range, so quoting
it in the criterion overstated the product. Caught by Dev C on the review of the n=12 change,
which is the review catching exactly what it is for: the confirming measurement falsified the
sentence it was appended beneath, and appending without re-reading the Decision left the ADR
contradicting itself.

**Do not collapse the two remaining numbers into one.** The bound is what a criterion *is*, and
the measured range is what someone will see; a system that misses a self-imposed bar in most runs
while never approaching its stated bound is precisely the situation this ADR exists to describe.
Quoting only the measurement would suggest a guarantee we do not have, and quoting only the bound
would understate a product that is normally well inside it.

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
  randomised phase relationship. The bound is not. The n=12 run is the closest thing here to a
  non-situational sample, because it staggers injection across the proxy's poll cycle rather
  than launching the services and hoping — and it is the worse number of the two
- **re-measuring is now one command**: `node tools/measure-latency.mjs [runs]` against a running
  stack. Anyone disputing a figure here can produce their own rather than arguing from the
  arithmetic, and the harness owns both ends of the clock so an agent round trip cannot leak in
- the criterion in the source document is unchanged and still says 10 s. This ADR is the
  deviation record, and the numbers quoted in `apps/dashboard/CLAUDE.md` §8 and
  `apps/dashboard/README.md` point here rather than restating a duration

## Status

`proposed`, pending Dev C's review of the n=12 section.

Drafted by Dev C from the #44 thread. The measurements were Dev B's to confirm or correct, and
they are now **confirmed** — re-measured against the containerised reference stack with the
phase-lock removed, which is what the "any figure that is a mean is situational" caveat was
waiting for. The direction of the correction is worth naming: the new numbers are **worse** than
the ones drafted here, and they move the deviation from "misses the bar occasionally" to "misses
it more often than not". That does not change the decision — 20 s still covers the 14.5 s bound
with margin — but it does change what an honest sentence about it says, so it should not flip to
`accepted` on the author of the measurement's word alone.

It should be `accepted` before anyone describes MVP 1 as complete, because this is the single
place where MVP 1 does not meet the spec as written and it needs to be findable by someone who
has only read the spec.
