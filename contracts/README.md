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

## Validating

The `contracts` CI job validates every file in `samples/` against the schemas. If a contract and
the shared fixtures disagree, CI says so — rather than the Day-5 rehearsal.

```bash
npx ajv-cli validate -s healthscan.schema.json -d samples/hosts-response.json
npx ajv-cli validate -s healthscan.schema.json -d samples/findings-response.json
```
