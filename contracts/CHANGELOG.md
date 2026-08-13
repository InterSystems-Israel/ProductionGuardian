# Contract changelog

Every contract change, dated, with the reason. Newest first.

---


## 2026-08-13 — `system_alert` scope stated in `healthscan-api.md` (Dev B)

**Documentation only.** No field added, removed or retyped; no schema change; no sample
touched. `validate.mjs` unchanged at 15 accept / 19 reject / 7 capture claims. Recorded here
because `contracts/` is edited by PR regardless of size (root `CLAUDE.md` §4) — and because I
applied that rule to myself two PRs ago and then didn't, which @tanifgit caught on #62.

The `system_alert` row said *"New alert posted to alerts.log"*. That describes a rule which
surfaces the alert log; it surfaces the **host-attributable subset** of it. An alert naming no
reported host produces no finding at all — not an unattributed one — and a consumer could
learn the difference only by reading `detect/engine.ts`.

The row now says so, with the measured table (#61). Note "reported", not "configured": a
framework item like `Ens.MonitorService` **is** configured, but is filtered before the
attribution set is built, so it is not a candidate either. That distinction was wrong in my
first draft and is the case a reader is most likely to hit, since `/api/monitor/alerts` is
largely about IRIS's own subsystems.

No consumer behaviour changes. `Finding` and `FindingsResponse` are untouched — in particular
`FindingsResponse` stays a bare array rather than gaining a `_meta` for this diagnostic, which
would be a breaking change to both endpoints for a diagnostic. Dev C asked for it to stay as
is; the engine logs unattributed alerts instead, at no contract cost.


## 2026-08-13 — sample-provenance caveat on `metrics-dump.txt` (Dev B)

**Documentation only. No field added, removed or retyped; no schema change; every existing
payload stays valid.** Recorded here because `contracts/` is edited by PR regardless of how
small the change is, and because the thing being written down was load-bearing enough to cost
a full diagnosis cycle.

`samples/metrics-dump.txt` reports four application hosts, `samples/hosts-response.json`
reports three, and that disagreement sits in the one directory whose purpose is that everybody
mocks the same bytes. The reason is now stated in `proxy-api.md` §1: the sample was captured
from **`LABDEMO.Production`, an unrelated production with its own class tree that does not
exist in this repo** — not from a stale deployment of `iris/labdemo/Production.cls`, which was
not compiled in the namespace at all until 2026-08-12.

So the sample is authoritative for label *shapes* and metric *families*, and not for the
roster. Requested by Dev C on #34, who also asked that the note say **different production**
rather than *stale deployment*, since writing down the wrong reason is how a wrong conclusion
gets re-derived later.

**The evidence is in the repo, not on an instance** — deliberately, since `contracts/` is read
by whoever comes next and they will not have this instance. `metrics-dump.txt` carries
`production="LABDEMO.Production"`; `Production.cls` has been
`ProductionGuardian.LabDemo.Production` in every commit; and the sample's spaced host names
coexist with `FHIR Transform`, a combination no commit of `Production.cls` produced, because
FHIR Transform was removed *before* the rename to spaced names. Dev C established that chain
on #55 and it is stronger than the compile-date reason this entry originally carried.

For completeness, and cited rather than asserted: `LABDEMO.Production` was still present on the
instance on 2026-08-13 (it is deliberately not deleted, #34 condition 4), and its items are
`LABDEMO.Service.EMRSource`, `LABDEMO.Process.LabRouter`, `LABDEMO.Process.FHIRTransform`,
`LABDEMO.Operation.CloudAPI`. That is an observation from `Ens.Config.Production`, not something
derivable from this repo — which is why the note in `proxy-api.md` rests on the two repo facts
instead.


## 2026-08-12 — `_meta.hostStatus.undescribedHosts` added (Dev B)

Adds one diagnostic field, no change to any host or finding field. Follows the same-day entry
that made `queued`/`errored` measurable per host.

`merged === hostCount` was documented as the way to check the host-status join, and it does not
work in the failure that matters: if one host drops out of the endpoint — a rename, or a query
that missed it — both counts shrink together, the comparison still passes, and that host alone
keeps `queued: null`. Reproduced by Dev C on #36 and confirmed here:

```
all four described :  merged=4 hostCount=4  merged===hostCount? true  undescribedHosts=[]
Lab Router missing :  merged=3 hostCount=3  merged===hostCount? true  undescribedHosts=["Lab Router"]
```

`unmatchedHosts` already reported the opposite direction (endpoint → metrics). This is the
direction a consumer feels, because it is the one that leaves a `null` in front of them.

Framework hosts are excluded deliberately: the endpoint legitimately omits some, so on the live
instance `Ens.Alarm` and `Ens.MonitorService` are absent by design. Counting them would make a
healthy state look broken — which is also why `snapshot.hosts.length - merged` is not a usable
check, reading `15 - 13 = 2` while everything is fine.

## 2026-08-12 — `Host.queued` and `Host.errored` become `number | null` (Dev C)

**A real field-type change on the published contract, and the first one that requires an edit on
both sides.** `queued` and `errored` widen from `integer` to `integer | null`. `null` means *"not
measurable for this host"* and never *"zero"*. Both keys stay **required** — a `null` value is
legal, an absent key is not.

**Why: the engine publishes a `0` nobody measured, and one rule reads that `0` as a symptom.**
`iris_interop_queued` carries no `host` label (it emits once per production), so at the time of
writing the proxy sent `queued: null` for **every** host — established in issue #12 and confirmed
against the real capture on PR #33. The engine's `normalizeHost()` collapses that `null` to `0`
because this schema declared the field a required integer. So the coercion exists *to satisfy this
file*, which makes the fix belong here rather than in the engine.

That coercion is not inert. Two reproductions from the PR #33 review, both by probing rather than
reading:

```
after 20 healthy polls at 1.2 msg/s  : []
after 2 polls with messagesPerSec=null: ["throughput_drop"]
   -> throughput_drop | Throughput 0.0 msg/sec is 100% below baseline
```

```
Host idle 400s, status OK:
  queued: null  (what live sends)  -> Host.queued=0  -> findings=[NONE]
  queued: 5     (measurable depth) -> Host.queued=5  -> findings=[stalled_host]
```

The first is a critical-looking finding about a production running perfectly; the second is a rule
silently switched off, because `requiresQueued && host.queued <= 0` can never be satisfied when
every host reports `0`. **Note the asymmetry** — coercing to zero is harmless for every rule where
higher is worse (`slow_processing`, `growing_queue_wait` fall under their floors and stay quiet) and
unsafe for the one rule where lower is worse. That is what makes it a type problem and not a
threshold problem.

Dev A's parser already carries the argument, in `parser.js:264`:

> *Every numeric field starts null, not 0. IRIS omits whole families rather than emitting zeros,
> and `0` has to keep meaning "measured zero" or every comparative rule downstream reasons about
> invented data.*

The pipeline preserves `null` end to end and then discards it in the last function before the rules
run. This change lets it survive to the consumer, so **rules skip instead of comparing** and
`stalled_host` can tell *"nothing queued"* from *"depth unknown"*.

**Supersedes the "Known gap" note of 2026-08-06**, which concluded that `Host.queued` stays a
required number because per-host depth is available from `Ens.Util.Statistics:EnumerateHostStatus`.
That is still true of IRIS, and it is how the measured `48` in `samples/hosts-response.json` was
obtained — but the proxy read the Prometheus metrics text only, so the note's own condition
(*"no contract impact if that holds"*) did not hold.

### PR #36 changes which case is normal, and does not remove the need for this

**#36 makes per-host counts measurable** — a host-status REST endpoint in `iris/`, merged by the
proxy on host name — so the counts arrive as real numbers and the all-null era ends. That does not
make this change unnecessary; it changes `null` from *the norm* into *the documented exception*, and
an exception still has to be expressible:

- a host the endpoint's response did not describe (`_meta.hostStatus.unmatchedHosts`),
- the endpoint unreachable, 404 on a missing CSP application, or the third poll failing,
- the merge switched off with an empty `IRIS_HOSTSTATUS_PATH`.

**#36 holds exactly this invariant on its own side** — *"a host the endpoint did not describe keeps
`null`, not `0`"* — and its proxy contract already types both counts as `NullableCount`. Without
this change the published contract is the one place in the chain that cannot represent what the
proxy is careful to preserve, and the engine has to flatten it on the last hop. The two changes
agree; they are not alternatives.

Note this also means the *reproductions above stay reachable after #36*, on any host the merge
misses — which is the argument for landing both.

**Changes:**

- `healthscan.schema.json` — `queued` and `errored` → `"type": ["integer", "null"]`. `minimum: 0`
  is kept and still applies; draft-07 `minimum` does not constrain `null`.
- `healthscan.d.ts` — `queued: number | null`, `errored: number | null`.
- `healthscan-api.md` — §1 field table, an explicit present-but-null sentence under it, and **Q13**
  in §4. §4.1 records this as the second contradiction of a Dev C assumption after Q1.
- `validate.mjs` — one must-accept (`queued`/`errored` both null, the shape the live proxy sends
  today) and two must-reject: `queued` as a **string**, and the key **omitted entirely**. The
  accept case is what makes the change real; the reject cases are what stop it from meaning
  "anything goes". 14 checks, was 11.

**The samples are deliberately unchanged.** They carry measured LABDEMO values, and `queued: 48`
on a disabled Cloud API was genuinely observed. Rewriting them to `null` would trade a real number
for a synthetic one and would move the bytes Dev B's fixtures and Dev C's eight scenarios are
anchored to, mid-sprint, for no gain. The null shape is exercised in `validate.mjs` instead, which
is where a shape with no measured instance belongs.

Verified: `node validate.mjs` → 14/14. Reverting the schema to `"type": "integer"` fails the new
accept case, so it bites rather than decorating.

### Open on the consumer side, not resolved here

**`messagesPerSec` has the same argument and is deliberately left alone.** It is a *rate*, and
`parser.js:81` maps `NaN`/`Inf` to `null` — a zero-length sample window right after a production
restart yields exactly that. If the engine keeps coercing it, the dashboard prints a measured-looking
`0.0` msg/sec for a host whose throughput is simply unknown, which is this same defect in the grid
rather than in a rule. Widening it is a larger change than this PR (it is the metric `throughput_drop`
is built on), so it is raised as a question for Dev B rather than decided unilaterally.

**Whether `stalled_host` should skip or fire on an unknown depth is Dev B's call**, and PR #33's
review asks for it to be written down either way. This change only makes the choice expressible.

## 2026-08-12 — Metrics proxy contract published (Dev B, on Dev A's behalf)

Initial publication of `proxy-api.md`, `proxy.schema.json`, `samples/metrics-dump.txt`.

Closes the last Day-1 gate item from `CONTRIBUTING.md` §6 (issue #16 item 4). Answers all five
`PROXY-Q` markers in `services/detection-engine/src/types/proxy.ts` inline in §5, plus three that
surfaced while writing it.

**Dev A has moved to other work, so this is derived from their merged code rather than authored
alongside it.** Every claim comes from reading `services/metrics-proxy/` on `main` and running it,
not from intent. Attribution is Dev B's; the contract's owner in `README.md` stays Dev A, because
the code is still theirs and `CODEOWNERS` still routes `services/metrics-proxy/` to them.

`samples/metrics-dump.txt` is the real 1236-line `/api/monitor/metrics` body from a live LABDEMO
production, byte-identical to the capture behind issue #10 — copied, not regenerated. 957 metric
lines, 15 interop hosts, 4 application. **It is 1236 lines, not the 1249 quoted in issue #10 and in
`src/parser.js`'s comment**; the same file, counted differently, and the smaller number is what
`wc -l` reports. Not worth chasing, worth not silently contradicting.

### Three things the contract says that were not previously known

- **`iris_interop_messages_errored` carries no `host` label either.** It is per-production, exactly
  like `iris_interop_queued`: `iris_interop_messages_errored{id="LABDEMO",production="LABDEMO.Production"} 0`.
  The parser's `METRIC_MAP` treats it as per-host, so the line is skipped for want of a `host` label
  and `errored` is `null` on every host. **`elevated_error_rate` cannot fire per host today** — the
  same structural gap as `queue_buildup` (#12) and, unlike that one, not filed. §6.3. Worse than
  `queued` in one respect: no per-production total is published anywhere, because
  `messages_errored` is not in `SCALAR_FAMILIES`, so the value is parsed and dropped.
- **Every one of the 15 real hosts is rejected by Dev B's `isProxyHost()`.** Measured, not
  predicted. Three field-level mismatches, each independently sufficient: `name` vs `host`,
  `messagesErrored` vs `errored`, and `queued: null` against a finite-number guard. The guard
  log-and-skips per host, which is right — but a mismatch in a field every host shares turns "skip
  the bad entry" into "report zero hosts", with no error surfaced. §5.2.
- **The engine's live client cannot work today, for two more reasons the mock cannot show.** It
  requests `/api/metrics` (the real route is `/proxy/metrics` → `404`), and it reads `alerts` from
  the metrics payload, where they are never present — alerts are a separate endpoint, so
  `system_alert` can never fire in live mode. Both pass typecheck and every unit test. This is
  ADR 0004's named cost landing a second time: `mockClient.ts` reads fixtures written to the
  engine's own assumed shape, so mocking against them proves self-consistency and nothing else.

None of these change a published field. **All of the reconciliation is on Dev B's side** — the
proxy's shape is verified against live IRIS, and `contracts/` is not edited to make a consumer
compile.

### Two open items, deliberately not resolved here

- **§6.1 — `queued: null` vs `queued: 0`.** The schema permits `null` because that is what the
  proxy emits; a schema that rejected the running code would be a fiction. **The contract position
  is that `0` is the conformant placeholder**, and the recommended fix is one line on the engine
  side: accept `null` and have `queue_buildup` skip an unmeasurable host, the way comparative rules
  already skip a warming baseline. That preserves the absent-is-not-zero invariant the rest of the
  payload depends on instead of carving out an exception for the inconvenient field.
- **§6.2 — `errored` vs `messagesErrored`.** Raised on #16. Recommendation is `errored`, and the
  tie-break is blast radius: `errored` costs one line in the engine, `messagesErrored` costs a
  change to a ratified contract with a live consumer — its schema, its `.d.ts`, two samples and Dev
  C's components — for a naming preference. Published as `errored` because that is what the code
  emits. **A request for a decision, not a decision.**

### `validate.mjs`

Extended, structure unchanged: `PROXY_MUST_ACCEPT` (5), `PROXY_MUST_REJECT` (8), and
`CAPTURE_CLAIMS` (7) alongside the existing arrays. 31 checks total, up from 11.

`samples/metrics-dump.txt` is Prometheus text, not JSON, so it cannot be validated against a
schema the way the healthscan samples are. `CAPTURE_CLAIMS` covers it with regexes over the label
shapes the contract quotes — including two asserting a label is **absent** (`queued` and
`messages_errored` have no `host` label). An assertion that something is missing is the only way a
future capture silently gaining it gets noticed.

Two of the must-reject cases are the engine's *current* shape (`name`, `messagesErrored`). If §6.2
is settled the other way, those checks fail and say so — which is the point of putting them there
rather than in a comment.

Verified: `npm run validate` → 31/31. Confirmed the new checks can fail, rather than assuming it:
adding `Active` to the status enum fails 1, narrowing `NullableCount` to `integer` fails 3, and
stripping the `messages_errored` line from the capture fails 1. A validator never seen to fail is
not known to be testing anything.

## 2026-08-12 — `queued` and `errored` are measured per host (Dev B, for Dev A's area)

**Amends `proxy-api.md` and `proxy.schema.json` shortly after they were published.** When this was
written those files were not yet on `main` — they arrived with PR #30, which has since merged — so
it began as an amendment to an unmerged contract and landed as a change to a ratified one. It is recorded here anyway: the whole point of this
file is that no contract statement changes silently, and "it was only just written" is not an
exception.

**Dev A has moved to other work and Dev B has taken over their outstanding tasks**, including this
contract and the `iris/` and `services/metrics-proxy/` changes behind it.

### What changed

`queued` and `errored` were documented as **`null` on every host, always**. They are now **measured
numbers** whenever the new host-status source answers. Neither field's *type* changed —
`number | null` before and after — so **no consumer is required to change anything.** What changed
is which of the two cases is normal.

- `proxy-api.md` — new **§1.3** explaining the third data source and the exact-match join; §1
  sample payload replaced with a live capture; `queued`/`errored` rows in §1.1 rewritten; new
  optional `statusFromMetrics` row; new `_meta.hostStatus` row in §1.2; **Q2** and **Q8** answered
  differently; **§5.2** updated to record that PR #33 fixed the engine side; **§6.1** and **§6.3**
  closed.
- `proxy.schema.json` — `queued`/`errored` descriptions rewritten; new optional
  `ProxyHost.statusFromMetrics`; new `HostStatusMeta` definition; `MetricsMeta.hostStatus` added.
- `validate.mjs` — 5 new accept cases, 4 new reject cases (40 checks total, all passing).

### Why the values were null, and where they come from now

Neither `iris_interop_queued` nor `iris_interop_messages_errored` carries a `host` label — both are
emitted once per production. Two of the eight finding types, `queue_buildup` (#12) and
`elevated_error_rate` (#31), were structurally unable to fire per host because of it. Two checks in
`validate.mjs` assert that absence against the capture, and they still pass: **the metrics text has
not changed, the proxy reads somewhere else as well.**

That somewhere is `Ens.Util.Statistics:EnumerateHostStatus` plus `Ens.MessageHeader`, exposed by a
new read-only `%CSP.REST` class in `iris/` and polled on the metrics interval. This is option (1)
on #12, which Dev A proposed and Dev C endorsed.

**The join key survives unnormalized, which is what makes this safe.** `EnumerateHostStatus`'s
`Name` column and the metrics `host` label are the same string, spaces intact — verified against
both sources on one instance. No trimming, no case folding: a host that stops matching is reported
in `_meta.hostStatus.unmatchedHosts` rather than guessed at, because silently mapping `CloudAPI`
onto `Cloud API` would attribute one host's queue depth to another.

### `null` still means exactly what it meant

The "absent is not zero" invariant is unchanged and this change leans on it rather than eroding it.
`null` now means *the host-status source was unavailable, or did not describe this host* — still
never a placeholder, and still never substituted with `0`. `_meta.hostStatus` exists so a consumer
can tell **"every `queued` is null because the endpoint is down"** from **"every `queued` is
genuinely 0"**, which are identical in the host array alone. `merged: 0` with `shape: "hosts"` is
the specific case worth alerting on: the endpoint answered and nothing matched.

### Verified

- The endpoint called over HTTP against live LABDEMO: `200`, `application/json`, 13 hosts.
- `GET /proxy/metrics` from the proxy running against live IRIS: 15 hosts, **13 merged**,
  `unmatchedHosts: []`, `queued` and `errored` numbers on all four application hosts.
- `npm run validate` → 40/40. Proven load-bearing rather than merely passing: with
  `statusFromMetrics` and `HostStatusMeta` removed from the schema in memory, the new cases fail.
- `services/metrics-proxy`: 96 tests pass, up from 71.
- **Engine needs no change, and this was checked rather than assumed** — `ProxyHost.queued`/`.errored`
  are `NullableCount` and `isProxyHost` gates them with `isNullableCount` on
  `devB/live-mode-reconcile` (PR #33).

### Not verified — read this before treating either finding as done

**No non-zero queue depth or error count was observed on live IRIS.** The production is healthy: it
drains immediately, and all 163,392 rows in `Ens.MessageHeader` are `Status = 9` (Completed). 400
samples of `Ens.Queue.GetCount` and 40 of `EnumerateHostStatus` read `0`/empty throughout. Inducing
either state requires disabling or misconfiguring a host — a production change, out of bounds on a
shared instance.

So: **the plumbing is verified end to end; the two findings actually firing is not.** The non-zero
path is covered by schema cases and a unit test explicitly labelled synthetic, and rests on the
depth of `70` measured earlier on this instance with `Cloud API` disabled. Note also
`queue_buildup`'s `absoluteFloor: 50` (#16): real numbers arriving and the rule tripping are
separate milestones.

## 2026-08-10 — `FHIR Transform` removed from the samples (Dev A)

**No schema change and no field change.** `host` is `{"type": "string", "minLength": 1}` with no
`enum`, so this is samples plus one prose sentence. Consumers that read `host` as an opaque string
need no edit.

**Why:** the LABDEMO production no longer has a FHIR Transform host, so IRIS cannot emit that
`host` label. §2 of `healthscan-api.md` says only application config items appear; a host the
production cannot produce does not belong in a sample Dev B and Dev C mock against. Verified
against `iris/labdemo/Production.cls`: the items are `EMR Source`, `Lab Router`, `Cloud API`, plus
the framework-filtered `Ens.ActivityReporter`.

**It was real when the samples were written — this is a removal, not a correction of a fabrication.**
Worth stating plainly, because Dev B's live capture in issue #10 does show
`host="FHIR Transform"`. It was an `EnsLib.MsgRouter.RoutingEngine` whose rule forwarded everything
straight to CloudAPI: no DTL, and nothing FHIR, as its own class comment said. It existed to
generate metric activity. Keren removed it in `1801a50` when the pipeline became HL7→PID, and
PR #14 settled on the three hosts above. The samples are simply older than that change.

Restoring it instead would mean re-adding a pass-through host to the production for no reason
other than making a fixture true. Nothing in the pipeline produces FHIR — that name was aspirational
from the start.

**Dev B's instance still runs the older production definition,** so a fresh capture there will show
four hosts until it is reloaded from `iris/labdemo/`. That is expected and breaks nothing: an extra
host is over-coverage, and the parser reads whatever `host` labels arrive.

> **ATTRIBUTION SUPERSEDED 2026-08-13 — see the 2026-08-13 entry at the top.** The paragraph above
> reads the four-host capture as *this* production, one version behind. It was a different
> production: the sample's own label says `production="LABDEMO.Production"`, and
> `iris/labdemo/Production.cls` has been `ProductionGuardian.LabDemo.Production` in every commit.
> The sample's host names are also a combination this repo never produced — spaced names *and*
> `FHIR Transform`, whereas here FHIR Transform only ever coexisted with **unspaced** names.
>
> The rest of this entry stands, including the part that matters most: the capture is **real, not
> invented**. Only the "one version behind our own production" attribution is wrong. Left in place
> rather than rewritten, because an entry that quietly changes its reasoning stops being a record.

**Changes:**

- `samples/hosts-response.json` — the `FHIR Transform` entry is gone. Three hosts remain, still in
  stable alphabetical order per §1.
- `samples/findings-response.json` — finding `f-1038` (`slow_processing`) **reassigned** to
  `Lab Router`, not deleted. The samples carry exactly one finding per type; deleting it would
  have zeroed `slow_processing` coverage for everyone mocking against these bytes. The reassignment
  invents nothing: the finding cites `baselineValue: 0.08`, which is already Lab Router's measured
  `avgProcessingTime` in `hosts-response.json`. Its `host` is now a host that exists, and its
  baseline still agrees with that host's row — it agrees *better* than before.
- `healthscan-api.md` §2 — "exactly four: EMR Source, Lab Router, FHIR Transform, Cloud API" →
  "exactly three: EMR Source, Lab Router, Cloud API".

Verified: `node validate.mjs` passes; both samples still valid.

### Follow-up outside `contracts/`, not part of this PR

`FHIR Transform` also appears in `services/detection-engine/fixtures/proxy/*.json` (8 files) and the
four-component sentence in the root `CLAUDE.md`, `apps/dashboard/CLAUDE.md`,
`services/detection-engine/CLAUDE.md`. Those are each in their owner's area, so they are not touched
here. `services/metrics-proxy/fixtures/metrics.txt` is Dev A's and is already done on the PR #13
branch. Nothing breaks meanwhile — an extra host in a fixture is over-coverage, not a failure.

## 2026-08-09 — Schema fixes from Dev C's review (Dev B)

Two **schema** defects found by Dev C reviewing PR #3, both with reproductions, both confirmed
here before fixing. The prose contract was right in both cases; the schema disagreed with it. No
change to any documented field, so **nothing to reconcile on the consumer side.**

**1. The schema rejected `[]`.** The root `oneOf` failed on an empty array because it satisfied
*both* `HostsResponse` and `FindingsResponse` vacuously, and `oneOf` requires exactly one match.
§3 mandates `200` + `[]` for no findings, no hosts, *and* engine startup — so the CI job in
`README.md` would have failed on the single most common healthy response.

Fixed by removing the root `oneOf` entirely and validating against named definitions. That is
strictly better than switching to `anyOf`: it also closes a hole where a **hosts array served in
the findings position validated fine**, because the root schema accepted either and could not
tell them apart. A check that silently was not happening.

**2. The timestamp `pattern` rejected `toISOString()`.** It forbade fractional seconds, but JS
always emits milliseconds (`.000Z`) and Python's `isoformat()` gives microseconds. Dev C's eight
fixtures all failed on this for real. Fixed by allowing optional sub-second digits:
`(\.[0-9]{1,6})?`. Second precision stays valid, so nothing that passed before now fails.

Chose relaxing over demanding second precision because `format: date-time` already accepted what
`pattern` rejected — only the stricter one bit, which made it an accident rather than a decision.
Requiring emitters to slice digits off a native formatter is a tax with no benefit, given
`lastActivity` is ±10s anyway (Q11).

**Also added `validate.mjs` + `package.json`,** replacing the `ajv-cli` one-liners in `README.md`.
Dev C found those degrade silently: `-c ajv-formats` resolves from the invocation directory and
ignores `format` when run elsewhere, and the `#/definitions/...` argument is rewritten into a
filesystem path by Git Bash on Windows. The script also asserts **five must-reject and four
must-accept cases**, because both defects here were *structural* — the class that positive-only
and value-level testing cannot reach.

Verified: `npm run validate` → 11/11 checks pass; both committed samples still valid.

## 2026-08-06 — Health Scan contract published (Dev B)

Initial publication of `healthscan-api.md`, `healthscan.schema.json`, `healthscan.d.ts`,
`samples/hosts-response.json`, `samples/findings-response.json`.

Closes the Day-1 gate for the Dev B → Dev C contract (issues #1, #2). Answers all nine of Dev C's
schema questions inline in §4 of `healthscan-api.md`.

Follows §5 of the MVP doc exactly — no fields added or removed. Three deviations from what the
MVP doc *implies*, all forced by what live IRIS actually emits:

- **`status` has no `Warning`.** The real enum, read from IRIS source, is `OK`, `Error`,
  `Inactive`, `Retry`, `Stopped`, `Unconfigured`, plus `Disabled` from `EnumerateHostStatus`.
  This is the one answer that contradicts a Dev C assumption — the `HostStatus` union needs
  `Warning` removed. Existing code still degrades correctly because unknown statuses already
  render neutral.
- **`type` is normalized.** IRIS reports business processes as `actor`. We map
  `actor → process` so the contract keeps the MVP doc's vocabulary.
- **`avgProcessingTime` / `avgQueueingTime` are aggregates.** IRIS emits these per
  `(host, messagetype)`, so one host has several series. We collapse them to one number,
  weighted by `iris_interop_sample_count`.

Units confirmed empirically rather than assumed: Cloud API configured at 0.05s latency reports
`avgProcessingTime: 0.05`. Seconds, as Dev C assumed.

Samples carry real measured values from the LABDEMO production, including a genuinely induced
degraded state (Cloud API disabled → queue depth 48), not invented numbers.

### Known gap, not a contract change — CLOSED 2026-08-12

`iris_interop_queued` carries no `host` label — it emits once per production. Per-host queue depth
is available from `Ens.Util.Statistics:EnumerateHostStatus` (verified: `Cloud API = 48` while
disabled), so `Host.queued` stays a required number. **This needs Dev A's proxy to read host
status, not only the Prometheus metrics text.** Raised with Dev A separately; no contract impact
if that holds.

**Resolved, and one clause of it turned out wrong.** The proxy reads host status as of #12/#36,
so per-host depth flows end to end. But "`Host.queued` stays a required number" did not hold:
it is `["integer","null"]` since the 2026-08-12 entry above, because a host whose depth is not
measurable must be distinguishable from one measuring zero. Still required — a null *value* is
legal, an absent *key* is not. #31 confirmed the same per-production shape for
`messages_errored`, re-verified 2026-08-12 against `ProductionGuardian.LabDemo.Production`
with traffic flowing rather than only against the capture from an unrelated production.
