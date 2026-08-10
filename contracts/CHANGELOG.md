# Contract changelog

Every contract change, dated, with the reason. Newest first.

---

## 2026-08-10 — `FHIR Transform` removed from the samples (Dev A)

**No schema change and no field change.** `host` is `{"type": "string", "minLength": 1}` with no
`enum`, so this is samples plus one prose sentence. Consumers that read `host` as an opaque string
need no edit.

**Why:** the LABDEMO production has no FHIR Transform host. It never did. The HL7→PID transform is
a DTL applied *inside* Lab Router's process, so it produces no config item and therefore no
`host` label in `/api/monitor/metrics`. §2 of `healthscan-api.md` says only application config
items appear; a host that IRIS cannot emit does not belong in a sample that Dev B and Dev C mock
against. Verified against `iris/labdemo/Production.cls`: the items are `EMR Source`, `Lab Router`,
`Cloud API`, plus the framework-filtered `Ens.ActivityReporter`.

The alternative — adding a fourth component so the fixture becomes true — would be inventing a
production host to satisfy a fixture. Nothing in the pipeline produces FHIR, and the root
`CLAUDE.md` forbids fabricated demo data.

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

`FHIR Transform` also appears in `services/detection-engine/fixtures/proxy/*.json` (8 files),
`services/metrics-proxy/fixtures/metrics.txt`, and the four-component sentence in the root
`CLAUDE.md`, `apps/dashboard/CLAUDE.md`, `services/detection-engine/CLAUDE.md`. Those are each in
their owner's area. Dev A will fix the metrics-proxy fixture; the rest is on the owning developer.
Nothing breaks meanwhile — an extra host in a fixture is over-coverage, not a failure.

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
