# Early Warning API contract

**Owner:** Dev B · **Consumer:** Dev C · **Port:** `3002` · **Status:** proposed

One read-only endpoint, added for MVP 2. It projects the queue-depth trend forward and estimates
time-to-threshold for each reported host — root `CLAUDE.md` §2.1, `services/detection-engine/CLAUDE.md`
§1.1.

**Early Warning adds nothing to Health Scan and changes nothing in it.** The eight finding types
are unchanged, `FindingType` does not grow, and no field is added to `Finding` or `Host`. A
projection is a *separate object on a separate endpoint*, joined to the rest by `host`. That
separation is the point of §1.4, not an accident of routing.

**Status is `proposed`, not `published`.** Dev C may mock against it now, and the two JSON examples
in §4 are the bytes to mock — but `earlywarning.schema.json`, `earlywarning.d.ts` and
`samples/earlywarning-response.json` are **not committed yet**, so nothing validates this shape in
CI. See §7 for exactly what is missing and what closes it.

---

## 1. `GET /api/earlywarning`

An array with **one entry per reported host**, whether or not that host has a projection. Same
roster and same filtering as `GET /api/healthscan/hosts` — only application config items appear,
framework items never do; the count is stated in `healthscan-api.md` §2 and deliberately not
restated here.

Sorted **alphabetically by `host`**, stable. Not by urgency: sorting by `secondsToThreshold` would
reorder the list every poll as the fit moves, and half the entries have no urgency key at all
because their projection is `null`. Dev C can sort client-side if a "most urgent first" layout is
wanted.

```ts
/** GET /api/earlywarning returns EarlyWarningResponse. */
export type EarlyWarningResponse = HostProjection[];

export interface HostProjection {
  /** Config item name. Always exactly equal to some Host.host — same string, same case. */
  host: string;
  /**
   * The metric being projected. Only 'queued' in MVP 2.
   * Treat as OPEN: if an unknown name arrives, label the axis from
   * projection.slopeUnit rather than assuming items.
   */
  metric: string;
  /**
   * Latest MEASURED value of `metric` for this host. `null` means not measurable
   * for this host, never zero — the same rule as Host.queued (healthscan Q13).
   */
  currentValue: number | null;
  /**
   * ISO 8601 UTC. The time of the sample `currentValue` came from — the engine's
   * poll clock, NOT the request clock. See EW-Q3.
   */
  measuredAt: string;
  /** Samples in the projection fit window. Measured, so present even when projection is null. */
  fitSampleCount: number;
  /** Seconds from the first to the last sample in the fit window. 0 when fitSampleCount < 2. */
  fitSpanSeconds: number;
  /**
   * Which way the metric is moving RIGHT NOW: the sign of the tail fit (§2.2.1's most
   * recent 40%). MEASURED, not forecast — it describes the recent past, never the
   * future. null when the tail cannot be fitted. See §1.5.
   */
  recentDirection: RecentDirection | null;
  /** The threshold being projected toward, or null when there isn't one. See §1.3. */
  threshold: Threshold | null;
  /** The forecast. null whenever we decline to forecast — see §2. */
  projection: Projection | null;
  /** Why `projection` is null. null exactly when `projection` is non-null. See §2.1. */
  projectionUnavailable: ProjectionUnavailableReason | null;
}

export interface Threshold {
  /** The value a crossing is projected toward. */
  value: number;
  /** Which arm of the queue_buildup gate produced `value`. See §1.3. */
  basis: 'absoluteFloor' | 'baselineMultiplier';
  /** The rolling baseline the multiplier arm used. Never null here — no baseline, no threshold. */
  baselineValue: number;
  /** The finding type whose gate this is. Only 'queue_buildup' in MVP 2. */
  findingType: string;
}

export interface Projection {
  /**
   * Literal discriminator. Every number in this object is computed, not observed.
   * A consumer that has this object in hand cannot claim it did not know. See §1.4.
   */
  kind: 'projection';
  /** How the slope was fitted. Only 'linear-least-squares' in MVP 2. */
  basis: string;
  /** Signed rate of change from the fit. Always > 0 when this object exists. */
  slope: number;
  /** Units of `slope`, spelled out. 'items/minute' for metric 'queued'. */
  slopeUnit: string;
  /** Whole seconds from `measuredAt` to the projected crossing. Integer, > 0. */
  secondsToThreshold: number;
  /** ISO 8601 UTC. Exactly measuredAt + secondsToThreshold — do not recompute from Date.now(). */
  projectedCrossingAt: string;
  /**
   * Authoritative human-readable text. Render as-is, do not reconstruct.
   * Always contains the hedge "at this rate". See §1.4.
   */
  message: string;
}

export type RecentDirection = 'rising' | 'falling' | 'steady';

export type ProjectionUnavailableReason =
  | 'disabled'
  | 'metric_unmeasurable'
  | 'warming'
  | 'insufficient_samples'
  | 'already_crossed'
  | 'not_rising'
  | 'beyond_horizon';
```

Every key is always **present**. `currentValue`, `recentDirection`, `threshold`, `projection` and
`projectionUnavailable` may be `null`; the rest are always numbers or strings. A missing key is a
contract violation, a `null` value is not — same rule as `healthscan-api.md` §1.

### 1.1 How the slope is fitted

Ordinary least squares of `value` against sample time (in minutes), unweighted, over every sample
in the **fit window**: the trailing **300 s**, i.e. up to 60 samples at the shipped 5000 ms engine
poll. `slope` is that line's gradient.

Three things about that, each a decision rather than an implementation detail:

- **The fit window is 300 s, not the 1800 s baseline window.** A 30-minute least-squares fit over
  mostly-flat history systematically understates a rise that started two minutes ago — it would
  hand back a comfortably distant ETA at exactly the moment the queue is running away. The whole
  claim is "at *this* rate", so the fit has to be over the recent rate.
- **It is not `(latest - previous) / interval`.** That is a one-sample difference and it is pure
  noise at this cadence — `window.ts` exposes `latest()` and `previous()` for rate-of-change
  comparisons and they are the wrong input here. It is also not `(last - first) / span`, which
  throws away every sample in between.
- **It needs no new state.** `MetricWindow` already stores `{at, value}` pairs pruned to a time
  window, so the fit is computable from what the baseline already holds. It needs one new accessor
  on that class; that is internal to `services/detection-engine/` and is not a contract change.

`300` (fit window) and `1800` (projection horizon, §2.1) are detection numbers, so per ADR 0003
they live in `thresholds.json` under an `earlyWarning` key and are hot-reloaded. They are **not**
hard-coded in the projection logic, and this contract states the shipped values rather than
promising they are the only possible ones.

### 1.2 Rounding, and why it is deliberate

| Field | Rounded to | Reason |
|---|---|---|
| `slope` | 1 decimal | `9.63841...` implies precision a 60-sample fit over a bursty queue does not have |
| `secondsToThreshold` | whole seconds | same |
| minutes inside `message` | nearest whole minute | the demo line is "~4 min", and a "~3.96 min" reads as a measurement |

A slope that rounds to `0.0` is treated as not rising (§2.2) rather than published as
`"rising ~0.0/min"`.

### 1.3 What the threshold is, and why it can move

`queue_buildup` fires when depth exceeds **both** its baseline multiplier and its absolute floor —
`thresholds.json` gives `baselineMultiplier: 5.0` and `absoluteFloor: 50`. So the value a crossing
is projected toward is:

```
threshold.value = max(baseline * 5.0, 50)
```

`threshold.basis` says which arm won, and `threshold.baselineValue` is the baseline that fed the
multiplier arm. Both are published because `50` and `baseline * 5.0` behave completely differently
over time:

- **`absoluteFloor`** is fixed. In the MVP 2 scenario `Cloud API` sits at a near-zero queue
  baseline, so `baseline * 5.0` is ~2 and the floor of 50 wins. The target does not move, and the
  projection is at its most trustworthy.
- **`baselineMultiplier`** is a **moving target**. The rolling mean includes the breaching samples
  (`services/detection-engine/CLAUDE.md` §5.1 — deliberate, pinned by a test), so while a queue
  climbs, so does `baseline * 5.0`. On a host where that arm is live, `secondsToThreshold` can
  *increase* from one poll to the next while the queue is rising. That is not a bug in the
  projection; it is the target receding. A consumer rendering a countdown must tolerate it going
  up.

`threshold` is `null` when there is no baseline yet — see `warming` in §2.1.

### 1.4 A projection is not a measurement

This is the central rule of this contract, and it is why the response is shaped the way it is
rather than as a flat object with a `secondsToThreshold` field alongside `currentValue`.

**Every computed number lives inside `projection`. Every observed number lives outside it.**
`currentValue`, `measuredAt`, `fitSampleCount`, `fitSpanSeconds` and `threshold` are things we read
or configured. `slope`, `secondsToThreshold`, `projectedCrossingAt` and `message` are things we
inferred. The nesting plus `kind: 'projection'` means a consumer cannot pick up a forecast value
without also holding the label that says it is one.

The reason for being this strict: **a forecast presented as a measurement is the same defect class
as issue #58.** There, `Host.lastActivity` was a required non-nullable date-time, so a host with no
`iris_interop_last_activity` line got the poll's own clock published in that field. The value was
well-formed, plausible, and meant "active now" to every reader — while the truth was "has not run
since production start". Nothing downstream could tell the difference, and `stalled_host` was
silently unable to fire for such a host: 30 minutes of idle-with-queue produced no finding, ever,
because the fabricated timestamp advanced with the poll.

The failure was not the arithmetic. It was that a *derived* value was published in a slot that
promised an *observed* one. `secondsToThreshold` is a much more attractive version of the same
mistake, because "queue crosses threshold in 4 minutes" is a sentence an operator will act on. So:

- `slope` is **not** published outside `projection`, even when we decline to forecast. A visible
  "rising ~0.5/min" next to no ETA still implies a forecast we refused to make.
- there is **no** `secondsToThreshold: 0` for a queue that has already crossed. Zero reads as a
  measurement of now; the honest answer is `projection: null` with reason `already_crossed` (§2.1).
- `message` always contains the substring **"at this rate"**. That is a testable invariant, and it
  is the hedge doing its job inside the one string Dev C renders verbatim.

**Rendering requirement for Dev C:** `message` is authoritative — render it as-is, do not
reconstruct it from the numbers. Render it inside a container that is visibly labelled as a
projection, and **not** adjacent to measured values in the same visual group. Do not tick
`secondsToThreshold` down client-side between polls: the underlying value does not tick, the slope
is not stable, and an animated countdown would be animating our poll loop rather than the queue.
Re-render from the served number on each poll and let it jump.

### 1.5 `recentDirection` — which way it is moving now, and why it is a sign rather than a slope

`recentDirection` is the **sign of the tail fit**: the same most-recent-40% fit §2.2.1 already runs,
reported rather than only tested.

| Value | Means |
|---|---|
| `rising` | tail slope, rounded to the published 1dp, is **> 0** |
| `falling` | rounded tail slope is **< 0** |
| `steady` | rounded tail slope is **0** — including a small negative that rounds to zero |
| `null` | no direction is claimed: the fit window holds fewer than `minFitSamples` (12), or the tail itself has fewer than two samples, or all of them share one timestamp |

**`null` below `minFitSamples` is the load-bearing part of that table**, and it follows §2.2.1's own
reasoning rather than being a separate rule. The tail is allowed to decide on as few as two samples
*because* the window behind it has already cleared twelve — it is confirming a grounded answer, not
producing one. Published standalone on a warming host, a sign fitted through three samples would be
a claim with nothing behind it. So `warming` and `insufficient_samples` rows always carry `null`
here, and a consumer gets a direction exactly when there is a fit worth signing.

**A SIGN, NOT A SECOND SLOPE, and that is §2.2.1's own decision rather than a new one.** That section
already states that the tail fit "is a sign test confirming an answer the window already grounded in
`minFitSamples`" and that its slope is deliberately never published. Publishing a magnitude here
would put two rates in one payload with no way for a reader to know which one `message` was built
from. So the tail keeps answering exactly one question — *which way* — and this field is that answer.

**MEASURED, so §1.4 does not apply to it.** It is computed from samples that have already happened,
which makes it the same kind of value as `currentValue` and `fitSampleCount`, not the same kind as
`slope` or `secondsToThreshold`. It carries no hedge and needs no projection framing. It says nothing
whatever about the future: a queue can be `falling` and still cross its threshold a minute later.

**Why it exists (#174).** `already_crossed` is returned for a queue over its threshold whether it is
climbing or draining (§2.2 step 5, and that precedence is unchanged). Measured on the live stack: an
armed `queue_buildup` then fixed by enlarging the pool spent **22 consecutive polls — 110 seconds —
draining monotonically from 152 to 54, every one reporting `already_crossed`**, indistinguishable
from the climb through the same depths. That is longer than the ~20 s in which a projection with an
ETA exists at all, so it is the state the panel spends most of its life in. The engine measured the
direction the whole time and published nothing that let a reader tell.

**The one invariant worth testing:** when `projection` is non-null, `recentDirection` is **always**
`'rising'` — the projection path cannot be reached with a non-positive tail (§2.2.1). The converse
does **not** hold: `rising` with `projection: null` is normal and means over the threshold already,
beyond the horizon, or the defensive decline at the end of §2.2.1.

**It LAGS a turn, by design, and a consumer must not read it as instantaneous.** The tail is a
120 s least-squares fit, so the sign changes only once enough of the tail has turned — not on the
first sample that moves the other way. Measured on the live stack: a queue peaked at 151 and began
draining immediately; `recentDirection` reported `rising` for a further **~35 seconds** and 46
messages of real drain before flipping to `falling`.

That is the intended trade and the same one §2.2.1 already makes for the gate — the 40% tail is
chosen so "one bursty poll cannot flip its sign". A field that reacted within a poll would flap on
every jitter, and a flapping direction beside a critical finding is worse than a slow one. So it
answers "which way has this been going" rather than "which way did it move just now", and **a
consumer must not build a "recovered" claim on it** — only a "coming down" one.

**Rendering requirement for Dev C:** where a reason is rendered for a crossed threshold, the
direction must distinguish recovering from still-rising. `null` is not "steady" — it means unknown,
and must read as no claim rather than as reassurance.

---

## 2. When there is no projection

`projection: null` is a normal, frequent, expected response. Most hosts most of the time have
nothing approaching a threshold, and **that must not be filled in with a plausible-looking ETA.**
Never invent a number here; there is a reason code for every case instead.

### 2.1 The seven reasons

| `projectionUnavailable` | Means | `threshold` | Dev C renders |
|---|---|---|---|
| `disabled` | `earlyWarning.enabled` is `false` in `thresholds.json` (hot-reloadable, so this can appear mid-run) | may be non-null | nothing — hide the module |
| `metric_unmeasurable` | `currentValue` is `null`. The metric is not measurable for this host, which is not zero (healthscan Q13) | `null` | `—` |
| `warming` | No rolling baseline yet, so **no threshold exists to project toward**. Fewer than `minBaselineSamples` (12) in the 1800 s baseline window | `null` | `—`, plus the warming affordance |
| `insufficient_samples` | Baseline is warm, but the 300 s fit window holds fewer than **12** samples — a newly appeared host, or a gap in polling | non-null | `—` |
| `already_crossed` | `currentValue >= threshold.value`. There is no time remaining to forecast; the `queue_buildup` finding is the thing to render | non-null | defer to the finding, **and read `recentDirection`** — a crossed queue that is `falling` is recovering, and must not read the same as one that is `rising` (§1.5) |
| `not_rising` | **Either** fit is `<= 0` after rounding to 1 decimal — the 300 s window, **or its most recent 40%**. Flat, draining, levelled off, or turned over — nothing is approaching anything. See §2.2.1 | non-null | nothing, or a neutral "steady" |
| `beyond_horizon` | Rising, but the projected crossing is more than **1800 s** away | non-null | nothing |

**The horizon is 1800 s because that is the baseline window.** Do not project further forward than
the span of history the fit is grounded in — a 90-minute ETA off a 5-minute fit is arithmetic, not
information. It is also the point where an operator has no reason to care.

`projectionUnavailable` is non-null **exactly when** `projection` is null. Both null, or both
non-null, is a contract violation.

### 2.2 Precedence — the order the checks run in

A mock and the engine must agree on which reason wins when several apply, or Dev C's fixtures will
disagree with live in ways that look like bugs. The order is:

1. `disabled`
2. `metric_unmeasurable` — no reading, nothing else can be evaluated
3. `warming` — no baseline, therefore no threshold
4. `insufficient_samples` — threshold exists, fit does not
5. `already_crossed` — checked **before** the slope, because a crossed threshold makes the slope
   irrelevant and a draining-but-crossed queue would otherwise report `not_rising`, which reads as
   "nothing to see"
6. `not_rising`
7. `beyond_horizon`

Otherwise: project.

#### 2.2.1 `not_rising` asks the question twice — the window, and its tail

**A single slope over the 300 s window describes the WINDOW, not the present**, and
`"rising ~N/min"` is a claim about the present. So step 6 fits twice and declines unless **both**
fits are positive: once over the whole window, once over its **most recent 40%** (120 s, ~24 samples
at the shipped 5 s poll). Reported from a live run:

> the early warning sometimes comes up when the queue pool is being drained, because it takes a
> point in time measurement and does not notice the acceleration/deceleration of pool growth.

One gate covers three shapes a single fit reports as a rise: a queue **draining** after the approved
fix, a rise that has **levelled off**, and a rise that has **turned over**. A queue rising more
slowly than it was still projects — decelerating is not falling.

**This adds no eighth reason and does not move the precedence.** `not_rising` is the accurate answer
and not merely the available one: a draining queue is not rising. It stays at step 6, *after*
`already_crossed`, so a queue draining while still **above** its threshold keeps reporting
`already_crossed` — draining-but-over-limit is still a problem.

**That remains true, and it was not the whole answer (#174).** Keeping `already_crossed` for a
draining queue is right — a queue over its limit is a problem however it is moving — but the reason
code alone left a consumer unable to tell a recovery from a runaway, and both rendered identically
for the 110 seconds a real cool-down takes. The fix is `recentDirection` (§1.5), which publishes the
sign this section already computes. **Still no eighth reason and still no precedence change**: the
answer to *which reason* is unchanged, and what is added is the answer to *which way*.

Two consequences worth stating, because a consumer cannot see them from the reason alone:

- **`slope` is never published for the tail** — the *magnitude*, that is. The tail fit is a sign test
  confirming an answer the window already grounded in `minFitSamples`; only the window slope is
  published as a rate. So a positive published `slope` with `projection: null` cannot occur — the
  decline happens before any projection is built. Its **sign** is published, as `recentDirection`
  (§1.5), which is a different claim: `rising` is not a rate and cannot be used as one.
- **An unfittable tail declines too**, and still as `not_rising`: fewer than two samples has no
  slope, and a tail sharing one timestamp is division by zero. `insufficient_samples` would be the
  wrong reason, since the contract defines that against the published `fitSampleCount` — the full
  window's count, which has already cleared `minFitSamples` by step 6.

**A third path declines as `not_rising` too, defensively** — and predates the tail test. Once both
slopes are positive, `secondsToThreshold` is computed; if it comes out non-finite or `<= 0`, step 6
declines rather than publishing it. That state would mean the arithmetic disagreed with
`already_crossed` one step earlier, so it should be unreachable — but publishing
`secondsToThreshold: 0` is exactly the "zero reads as a measurement of now" case §1.4 forbids. A consumer needs no special handling: it is the same reason
code with the same `null` projection.

**The 40% is not configurable, deliberately.** ADR 0003 governs the numbers that decide what fires;
this one says how much of the series the word "now" covers, which is the definition of "rising"
rather than a threshold for it. A fraction rather than a duration for two reasons: it can never be
set longer than the window it is a tail of, and it inherits the existing
`fitWindowSeconds / poll > minFitSamples` reachability check instead of needing its own.

### 2.3 Warm-up, and `X-Healthscan-State`

**The minimum sample count is 12** — `minBaselineSamples` from `thresholds.json`, reused rather
than a new number, and reused for a reason: `threshold.value` is `max(baseline * 5.0, 50)`, and
`baseline` is `null` below 12 samples (`baseline/window.ts` returns `null` and callers must not
substitute a guess, ADR 0002). Below 12 samples there is no target, so there is nothing to project
toward — not merely a noisy projection, but no projection defined at all.

At the shipped 5000 ms engine poll that is **60 s of data minimum** before any projection can
appear, and an engine restart resets it, because nothing is persisted (ADR 0002).

Note the two windows are counted separately: 12 samples in the 1800 s **baseline** window gates
`warming`; 12 samples in the 300 s **fit** window gates `insufficient_samples`. A host can pass the
first and fail the second after a polling gap.

**This endpoint sends the existing `X-Healthscan-State` header, unchanged, with the same
engine-wide value the healthscan endpoints get** — `ok`, `warming`, or `stale`. There is
deliberately **no** `X-Earlywarning-State`: it is the same engine, the same poll loop and the same
snapshot, so a second header would be a second vocabulary that could disagree with the first.

The header is advisory, exactly as in `healthscan-api.md` §3. `X-Healthscan-State: warming` implies
every entry carries `projection: null` with reason `warming`; the per-host `projectionUnavailable`
is the authoritative signal and Dev C may rely on it alone.

---

## 3. Errors and empty states

| Situation | Response |
|---|---|
| No host has a projection | `200` + full array, every `projection` null — **never** `404`, never a filtered array |
| No hosts yet / production stopped | `200` + `[]` |
| Engine starting, no sample yet | `200` + `[]`, plus `X-Healthscan-State: warming` |
| Baseline warming, hosts known | `200` + full array, all `projection` null, reason `warming`, plus `X-Healthscan-State: warming` |
| Upstream proxy unreachable | `200` + last-known payload, plus `X-Healthscan-State: stale`. `measuredAt` does not advance — that is how staleness is visible in the body |
| `earlyWarning.enabled: false` | `200` + full array, all `projection` null, reason `disabled` |
| Genuine server fault | `500` + `{"error":"..."}` |
| Non-`GET` method | `405` + `{"error":"..."}` |
| `OPTIONS` preflight | `204` |
| Unknown path | `404` + `{"error":"..."}` — the "never 404" rule is about empty *results*, not about routing |

Same disposition as the findings API: prefer stale-but-labelled over an error, because a blanked
dashboard is worse on stage than a slightly old one.

**Entries are never omitted to signal absence.** A host with no projection appears with
`projection: null` and a reason. Dropping it would leave Dev C unable to distinguish "not
projecting" from "host gone", which is the ambiguity `healthscan-api.md` §2.1 documents for
discarded alerts and would rather not repeat.

**CORS:** `Access-Control-Allow-Origin: *`, plus `Cache-Control: no-store`, on this endpoint as on
the other two (healthscan Q9). The dashboard works with or without the Vite dev proxy.

---

## 4. Worked examples

### 4.1 Live projection — the MVP 2 scenario

`Cloud API` at `PoolSize 1` against a ~1s-per-message downstream, so it clears ~1 msg/sec while
inflow exceeds that. Net queue growth ~9.6/min. Baseline is ~0.4, so `baseline * 5.0` is ~2 and the
absolute floor of 50 is the live arm.

`200` · `X-Healthscan-State: ok`

```json validate=earlywarning.schema.json#/definitions/EarlyWarningResponse
[
  {
    "host": "Cloud API",
    "metric": "queued",
    "currentValue": 12,
    "measuredAt": "2026-08-18T10:14:32Z",
    "fitSampleCount": 60,
    "fitSpanSeconds": 295,
    "recentDirection": "rising",
    "threshold": {
      "value": 50,
      "basis": "absoluteFloor",
      "baselineValue": 0.4,
      "findingType": "queue_buildup"
    },
    "projection": {
      "kind": "projection",
      "basis": "linear-least-squares",
      "slope": 9.6,
      "slopeUnit": "items/minute",
      "secondsToThreshold": 238,
      "projectedCrossingAt": "2026-08-18T10:18:30Z",
      "message": "Queue depth 12 rising ~9.6/min; at this rate it crosses 50 in ~4 min."
    },
    "projectionUnavailable": null
  },
  {
    "host": "EMR Source",
    "metric": "queued",
    "currentValue": 0,
    "measuredAt": "2026-08-18T10:14:32Z",
    "fitSampleCount": 60,
    "fitSpanSeconds": 295,
    "recentDirection": "steady",
    "threshold": {
      "value": 50,
      "basis": "absoluteFloor",
      "baselineValue": 0,
      "findingType": "queue_buildup"
    },
    "projection": null,
    "projectionUnavailable": "not_rising"
  },
  {
    "host": "Lab Router",
    "metric": "queued",
    "currentValue": 3,
    "measuredAt": "2026-08-18T10:14:32Z",
    "fitSampleCount": 60,
    "fitSpanSeconds": 295,
    "recentDirection": "steady",
    "threshold": {
      "value": 50,
      "basis": "absoluteFloor",
      "baselineValue": 1.2,
      "findingType": "queue_buildup"
    },
    "projection": null,
    "projectionUnavailable": "not_rising"
  }
]
```

Arithmetic, so a mock can reproduce it: `(50 - 12) / 9.6 = 3.958 min = 237.5 s`, rounded to `238`;
`10:14:32Z + 238 s = 10:18:30Z`; `3.958 min` rounds to `~4 min` in the message. Note `slope` is
absent from the two non-projecting entries — §1.4.

### 4.2 Insufficient data — 25 s after engine start

Five samples in, no baseline, therefore no threshold. `currentValue` is a real reading and is
published; nothing else is.

`200` · `X-Healthscan-State: warming`

```json validate=earlywarning.schema.json#/definitions/EarlyWarningResponse
[
  {
    "host": "Cloud API",
    "metric": "queued",
    "currentValue": 4,
    "measuredAt": "2026-08-18T10:09:07Z",
    "fitSampleCount": 5,
    "fitSpanSeconds": 20,
    "recentDirection": null,
    "threshold": null,
    "projection": null,
    "projectionUnavailable": "warming"
  },
  {
    "host": "EMR Source",
    "metric": "queued",
    "currentValue": 0,
    "measuredAt": "2026-08-18T10:09:07Z",
    "fitSampleCount": 5,
    "fitSpanSeconds": 20,
    "recentDirection": null,
    "threshold": null,
    "projection": null,
    "projectionUnavailable": "warming"
  },
  {
    "host": "Lab Router",
    "metric": "queued",
    "currentValue": 1,
    "measuredAt": "2026-08-18T10:09:07Z",
    "fitSampleCount": 5,
    "fitSpanSeconds": 20,
    "recentDirection": null,
    "threshold": null,
    "projection": null,
    "projectionUnavailable": "warming"
  }
]
```

Five samples at a 5000 ms poll is a 20 s span, and the queue *is* rising in this window — 0 to 4 in
20 s is 12/min, which would extrapolate to a crossing in ~4 minutes and look exactly like §4.1.
**That number is not published.** Twelve samples is the floor, and below it the honest response is
`null` plus a reason.

### 4.3 Already crossed — one entry, for the case a naive implementation gets wrong

`200` · `X-Healthscan-State: ok`

```json validate=earlywarning.schema.json#/definitions/EarlyWarningResponse
[
  {
    "host": "Cloud API",
    "metric": "queued",
    "currentValue": 128,
    "measuredAt": "2026-08-18T10:22:12Z",
    "fitSampleCount": 60,
    "fitSpanSeconds": 295,
    "recentDirection": "rising",
    "threshold": {
      "value": 50,
      "basis": "absoluteFloor",
      "baselineValue": 6.1,
      "findingType": "queue_buildup"
    },
    "projection": null,
    "projectionUnavailable": "already_crossed"
  }
]
```

No `secondsToThreshold: 0`, and no negative one. The threshold is behind us; the thing to render is
the `queue_buildup` finding on `/api/healthscan/findings`, which states what is actually true.
Note `baselineValue` has climbed from 0.4 to 6.1 — that is the self-inflating rolling mean of
§1.3, and at `6.1 * 5.0 = 30.5` the floor is still the live arm.

**The same reason, the other direction.** Once the fix is applied and the queue starts coming down,
`projectionUnavailable` stays `already_crossed` for as long as depth is over the threshold — the
precedence is unchanged (§2.2 step 5) and draining-but-over-limit is still a problem. Only
`recentDirection` distinguishes the two states:

```
… "currentValue": 56, "recentDirection": "falling",
  "projection": null, "projectionUnavailable": "already_crossed"
```

Shown as a delta rather than a second full payload because the only measured fields that differ are
those; `fitSampleCount` and `fitSpanSeconds` were not captured on the run this comes from, and
inventing them would put two unmeasured numbers into the bytes Dev C mocks against.

**Measured, 2026-08-31**, on the containerised stack: an armed `queue_buildup` fixed by enlarging the
pool 1 → 4 drained monotonically from **152 to 54 over 22 consecutive polls (110 s)**, every one
reporting `already_crossed`. It flipped to `not_rising` one poll after dropping under 50, at 46.
Before `recentDirection` existed, those 22 polls were byte-identical to the climb through the same
depths — which is #174, and it is why the field is on every row rather than only where a forecast
exists.

---

## 5. Accuracy limits, and what this is not

Stated here rather than left for someone to discover on stage.

**A straight line through a rolling window is a crude model, and this is a crude implementation of
it.** No confidence interval, no residual, no goodness-of-fit is published, because none is
computed. `secondsToThreshold` is one number with no error bar, and the honest reading of it is
"the current trend, if it holds, reaches the threshold around then" — which is what "at this rate"
in `message` is there to say.

**Queue slope is not stable.** The drain term is roughly constant in the MVP 2 scenario — PoolSize
1 against a ~1s downstream clears ~1 msg/sec — but the arrival term is whatever load is being sent,
and in the demo it is closer to a step than a ramp. A slope fitted across a step is an artifact of
where the fit window happens to sit relative to the step, and it will move substantially between
polls in the seconds after load changes.

**The target can move as well as the value** — §1.3, whenever `basis` is `baselineMultiplier`.

**Freshness is bounded by the poll intervals, not by this endpoint.** Per ADR 0005, on the shipped
configuration (proxy 2500 ms, engine 5000 ms, dashboard 2000 ms) the arithmetic worst case from a
change in IRIS to pixels is ~14.5 s, and the accepted criterion is 20 s with a measured 7.1–11.7 s,
median 10.8 s, n=12. Two consequences:

- `measuredAt` is already up to 7.5 s old when the response is generated, and up to ~14.5 s old
  when it is on screen. The projection's starting point is that stale before its arithmetic begins.
- **a `secondsToThreshold` below ~20 s is inside the pipeline's own latency bound.** It does not
  mean "you have 15 seconds"; it means "effectively at the threshold already". It is still
  published — suppressing the most urgent case would be worse — but it must not be rendered as time
  to act, and a second-by-second countdown at that scale is displaying our poll loop.

Early Warning does **not** shorten any of those intervals and must not be used as an argument to.
`sustainedSeconds` sets a hard floor under `POLL_INTERVAL_MS` at the shipped 5000 ms
(ADR 0005 and #64), and lowering it is lowering the false-positive protection MVP §6 names as the
top risk.

### What this is not

| Not | Which is |
|---|---|
| A forecast model | Linear extrapolation of a 300 s window. No seasonality, no anomaly detection, no learning, no per-host tuning |
| A 30-day baseline | 30 **minutes**, in memory, lost on restart (ADR 0002). `docs/production-guardian-demo.html` says "verified against a 30-day baseline"; that file is a concept demo with scripted data and is not what this is |
| A health score | A single 0–100 number is **Health Score**, still out of scope (root `CLAUDE.md` §2.2) |
| A trend chart | Historical trend charts are still out of scope. This endpoint publishes one slope, not a series — there is no time series on the wire and Dev C cannot draw one from it |
| A finding | No new `FindingType`, no "will breach" pseudo-finding. Findings state what is true now; this states what might be true later, on a different endpoint |
| A reason to act automatically | Nothing applies unattended. Smart Resolve is human-approved by default (root `CLAUDE.md` §2.1) |
| Root-cause narrative | AI Detective, and the narrative comes from the agent in IRIS |

---

## 6. The questions this raises, answered up front

Dev C has not raised these yet. `healthscan-api.md` §4 exists because thirteen questions arrived
after that contract shipped; this section is the attempt to answer the obvious ones before they
have to be asked.

| # | Question | Answer |
|---|---|---|
| **EW-Q1** | Is the endpoint path really `/api/earlywarning` and not `/api/earlywarning/projections`? | As specified, `/api/earlywarning`, on `:3002`. It does break the `/api/<module>/<resource>` shape the healthscan routes use. **Flagged rather than silently changed** — confirm before hardcoding it, because moving it later is a consumer-visible change for a cosmetic reason |
| **EW-Q2** | Join key to hosts and findings? | `host`, always exactly equal to some `Host.host` and to `Finding.host`. Same string, same case — healthscan Q8 |
| **EW-Q3** | Is `measuredAt` the request time? | **No.** It is the sample's poll time. Between engine polls the same bytes are served repeatedly and `measuredAt` does not advance; that is how a consumer sees staleness. A timestamp taken from the request clock would make a five-minute-old projection look fresh forever — which is #58 exactly (§1.4) |
| **EW-Q4** | Are `slope` and `secondsToThreshold` ever negative or zero? | No. Both are `> 0` whenever `projection` exists; the cases that would produce zero or negative are `not_rising` and `already_crossed`, and both yield `projection: null` |
| **EW-Q5** | Can a host disappear from the array between polls? | Yes — when it leaves the production roster, same as `/api/healthscan/hosts`. It does **not** disappear merely for having no projection |
| **EW-Q6** | Should the UI interpolate between polls? | No. Re-render from the served numbers; let `secondsToThreshold` jump. §1.4 |
| **EW-Q7** | Is `metric` a closed enum? | Treat as **open**, same defensive posture as `HostStatus`. Only `queued` in MVP 2; label from `slopeUnit` if an unknown name arrives, and render unknowns neutrally |
| **EW-Q8** | Does a projection ever contradict a finding? | It can look that way and it is not a contradiction: `queue_buildup` requires a **sustained** breach (`sustainedSamples` 2 **and** `sustainedSeconds` 4), so a queue can cross `threshold.value` and be reported `already_crossed` here for a poll or two before the finding is confirmed. Render the projection and the finding from their own endpoints; do not derive one from the other |
| **EW-Q9** | Why is there no `confidence` field? | Because nothing computes one. A confidence score is AI Detective's output and comes from the agent; a hand-rolled number here would be a made-up statistic on top of a crude fit |

**Marker convention**, per `README.md`: tag each assumption site inline with the assumption stated,
not just the number — `// EW-Q1: assumed path /api/earlywarning, unratified` — so reconciliation is
a `grep` rather than an audit.

---

## 7. What is not committed yet

Named rather than quietly left off the table, the way `README.md` handles the two missing proxy
samples.

| Missing | Consequence | What closes it |
|---|---|---|
| `earlywarning.schema.json` | Nothing in `contracts/` validates this shape; the `contracts` CI job does not know this endpoint exists | A schema with a named `EarlyWarningResponse` definition, plus accept/reject cases in `validate.mjs` — including rejects for `projection` and `projectionUnavailable` both non-null, for a `secondsToThreshold` outside `projection`, for a `recentDirection` outside the three members, and for a non-`rising` `recentDirection` on an entry that carries a `projection` (§1.5's invariant) |
| `earlywarning.d.ts` | Dev C transcribes from the TS block in §1 instead of importing | Lift §1 verbatim into a `.d.ts`, hand-maintained against the schema |
| `samples/earlywarning-response.json` | The §4 examples are the shared bytes, in Markdown rather than in `samples/` | Commit §4.1 as a sample, **captured from a live run** rather than kept as the hand-written numbers it is today |

The §4 values are constructed to be arithmetically consistent and to match the scenario, but they
are **not a live capture**. `contracts/samples/` was built from real measurements on purpose, and
this file does not meet that bar yet. Replace them with a capture before this contract moves from
`proposed` to `published`.

---

## 8. Changing this contract

Never edit in place. A change is a PR to `contracts/` with a `CHANGELOG.md` entry, reviewed by every
other developer. See `README.md` in this directory.

When estimating what a change costs, do not estimate from the size of the edit. **The question is
not how many lines reference a value, it is whether anything *means* something in terms of it** —
`README.md` has the worked example, where a one-line enum narrowing cost 83 insertions across 10
files because fixtures had built a concept on the removed value.

The field most exposed to that here is `projection`. Anything that flattens it, or that adds a
forecast-derived number outside it, is not a field change: it removes the structural guarantee in
§1.4 that a consumer holding a forecast also holds the label saying it is one. That is the whole
contract, and it is cheaper to defend than to reinstate.
