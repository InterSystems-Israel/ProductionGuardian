# `contracts/` — the coordination point

Two API contracts, their schemas, and the shared sample payloads. This directory is the only
path all three developers read, which is why it is PR-gated.

| File | Owner | Consumer |
|---|---|---|
| `proxy-api.md`, `proxy.schema.json` | Dev A | Dev B |
| `healthscan-api.md`, `healthscan.schema.json`, `healthscan.d.ts` | Dev B | Dev C |
| `samples/metrics-dump.txt`, `samples/alerts.json`, `samples/proxy-response.json` | Dev A | Dev B |
| `samples/hosts-response.json`, `samples/findings-response.json` | Dev B | Dev C |

## Why the samples matter

`samples/` is the handoff currency. Dev A's `proxy-response.json` is *literally* Dev B's mock
input; Dev B's `findings-response.json` is *literally* Dev C's mock input. Same bytes, which is
what makes "works against the mock" predict "works against the real thing."

Samples are captured from live IRIS wherever possible, not invented. The Health Scan samples in
this directory use real measured values from the LABDEMO production — `avgProcessingTime: 0.08`
for Lab Router is what IRIS actually reported, not a plausible-looking number.

## Never edit a contract in place

- **Never** edit a file here as part of an implementation task.
- **Never** add a field to a local type to make code compile. That is a contract change request
  to the owning developer.
- A contract change is its own PR: the schema edit, a `CHANGELOG.md` entry with the reason, and
  a heads-up to the consumer. CODEOWNERS requires all three reviewers.

The reason for the heavy process on a 5-day project: a silent contract change is the failure mode
that breaks the Day-5 integration, and the review takes 30 seconds.

### Estimating what a change costs

When proposing a change, do not estimate the cost from the size of the edit. **The question is not
how many lines reference a value, it's whether anything *means* something in terms of it.** Cost
scales with attached meaning, not with characters.

The worked example from this sprint: removing `Warning` from `HostStatus` was one line in a union,
and it was published as "roughly one line" of consumer impact. The actual reconciliation was **83
insertions across 10 files** — because seven demo fixtures used `status: "Warning"` to *mean* "this
host is degraded", so narrowing the enum made a concept the dashboard had built on
**unrepresentable**. Every one had to be rewritten to signal degradation through findings instead.

Two practices contained it, and they do different jobs:

- **Greppable assumption markers** (`// CONTRACT-Q<n>: assumed OK | Warning | Error | Inactive`)
  made reconciliation *findable*. State the assumption inline — a marker naming only a question
  number sends the reader back to the question list.
- **Defensive rendering** made it *bounded*. Unknown values went down a neutral path from the first
  commit, so the wrong assumption never spread past fixtures and one tone map.

Only the second limits blast radius. A contract change with perfect markers and no defensive
handling still reaches every consumer.

## Validating

The `contracts` CI job validates every file in `samples/` against the schemas. If a contract and
the shared fixtures disagree, CI says so — rather than the Day-5 rehearsal.

```bash
cd contracts && npm install && npm run validate
```

It checks three things, and the last two are what make the first mean anything:

- each sample against **one named definition** (`HostsResponse` / `FindingsResponse`)
- structural cases that must **pass** — `[]`, and sub-second timestamps from any language
- cases that must **fail** — a retired `Warning` status, an unknown finding type, a hosts array
  served in the findings position

**Do not replace this with an `ajv-cli` one-liner.** Three reasons, all learned the hard way on
PR #3:

1. Validating against the root schema instead of a named definition cannot tell a hosts array
   from a findings array. That check silently does not happen.
2. `ajv validate -r '#/definitions/HostsResponse'` is not portable — Git Bash on Windows rewrites
   the `#/...` argument into a filesystem path and the command fails.
3. `-c ajv-formats` resolves relative to the invocation directory, so from the wrong place it
   silently ignores `format` rather than failing. A validator that quietly gets weaker is worse
   than one that breaks.
