# Contract changelog

Every contract change, dated, with the reason. Newest first.

---

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

### Known gap, not a contract change

`iris_interop_queued` carries no `host` label — it emits once per production. Per-host queue depth
is available from `Ens.Util.Statistics:EnumerateHostStatus` (verified: `Cloud API = 48` while
disabled), so `Host.queued` stays a required number. **This needs Dev A's proxy to read host
status, not only the Prometheus metrics text.** Raised with Dev A separately; no contract impact
if that holds.
