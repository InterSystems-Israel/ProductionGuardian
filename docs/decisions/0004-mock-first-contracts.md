# ADR 0004 — Mock-first contracts

- **Status:** **proposed — needs explicit confirmation from all three developers**
- **Date:** 2026-08-06
- **Deciders:** Dev A, Dev B, Dev C
- **Drafted by:** Dev B — see the note below on why this one is different
- **Source:** §7.4 decision 4 of `production-guardian-healthscan-mvp1.docx`

## A note on this ADR

0001–0003 are technical choices with a recommended answer, drafted by the developer who will
implement them. **This one is not a technical choice — it is an agreement between three people**,
and §7.4 asks all three to *confirm* it rather than for one of us to decide it.

It is drafted here because it was identified (issue #2) as **load-bearing without being recorded**:
Dev C relied on it from Day 1 while building against a transcribed schema. Writing it down is
overdue. But Dev A and Dev C should each confirm rather than inherit my summary — this stays
`proposed` until they do.

## Context

§4.1's parallelization bet: all contracts are published Day 1, then Dev B builds against a mock of
Dev A's proxy and Dev C against a mock of Dev B's findings API. "So all three work in parallel and
only integrate at the end."

This works only if everyone actually does it. One developer waiting for a real endpoint serializes
the project and the 5-day timeline fails.

## Decision

**All three developers build against mocked contracts from Day 1. No developer is ever blocked on
another's service being up.**

Concretely:

- **`contracts/samples/` is the handoff currency.** Dev A's `proxy-response.json` *is* Dev B's
  mock input; Dev B's `findings-response.json` *is* Dev C's mock input. The same bytes, which is
  what makes "works against the mock" predict "works against the real thing."
- **Samples are captured from live IRIS wherever possible**, not invented. Real values catch
  real problems.
- **Mock-first is the plan, not a fallback.** Building against a mock is the intended path, not
  what you do when the real thing is down.
- **A contract change after Day 1** is a PR to `contracts/` with a `CHANGELOG.md` entry and a
  heads-up to the consumer. Never an in-place edit, never silent.

## Evidence it held

This is being written after the fact, so it can be assessed rather than asserted:

**Dev C** started the dashboard against a transcription of §5 (`apps/dashboard/CLAUDE.md` §2.3)
rather than idling for the published contract, tagging 13 assumption sites with `// CONTRACT-Q<n>`.
When the real contract landed (PR #3), **eight of the nine assumptions were correct**; only the
`HostStatus` enum needed changing — roughly one line against ~1,750 lines written. The bet paid
off almost exactly as intended.

**Dev B** published the findings contract while LABDEMO was still being built, and validated it
against real captured metrics rather than waiting for Dev A's proxy.

**The `CONTRACT-Q<n>` convention deserves promotion from accident to practice.** Tagging every
assumption site with a greppable marker is what made reconciliation a `grep` instead of an audit.
Recommend it explicitly for any future contract-dependent work.

## Consequences

**Accepted costs:**

- **A wrong assumption compounds silently** until the contract lands. Bounded here by the
  `CONTRACT-Q` markers; unbounded without them.
- **A mock can be wrong in ways the real thing is not** — this is exactly why samples must be real
  captures. A hand-written sample encodes the author's belief about the API, so mocking against it
  proves only self-consistency.
- **Integration risk is deferred, not removed.** Day 5 is the first time real components meet. The
  `contracts` CI job (validating `samples/` against the schemas) is the main defence, and it is
  worth more than the other three CI jobs combined.

**Gained:**

- Three developers working genuinely in parallel at ~3.5–4 dev-days each
- No developer idle waiting on another's environment
- Contract disagreements surface as schema-validation failures rather than Day-5 surprises

## Alternatives considered

**Sequential: A finishes, then B, then C.** Rejected — it is ~10–12 person-days of work in a
5-day window. Arithmetically impossible with three developers idling in turn.

**Shared live environment from Day 1.** Rejected. It makes every developer's progress depend on
one IRIS instance staying healthy, and inverts the risk: instead of integration risk on Day 5, you
get environment risk every day. (A live instance is still valuable *alongside* mocks — LABDEMO
exists and is where the real metric captures came from.)

**Contract-last: build, then reconcile.** Rejected — it is how you get three components that each
work alone and none together.

## Confirmation

Each developer confirms they are building against mocked contracts, not waiting on real endpoints:

- [ ] **Dev A** — metrics proxy, `iris/**`
- [x] **Dev B** — detection engine, findings API (confirmed: contract published and validated
      against captured metrics before the proxy existed)
- [ ] **Dev C** — dashboard (evidently followed in practice from Day 1; confirming your own
      position here is what makes it recorded rather than inferred)
