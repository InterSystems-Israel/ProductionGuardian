# ADR 0001 — Where the detection engine lives

- **Status:** proposed
- **Date:** 2026-08-06
- **Deciders:** Dev A, Dev B, Dev C
- **Drafted by:** Dev B (implementer)
- **Source:** §7.4 decision 1 of `production-guardian-healthscan-mvp1.docx`

## Context

Health Scan polls IRIS metrics, compares them to a rolling baseline, and emits findings. That
detection work has to run somewhere. Two candidates:

1. In the Node/Python service alongside the metrics proxy (Layer 3 of the §2.1 data flow)
2. Inside IRIS as ObjectScript, reading the metrics natively

The MVP doc recommends the proxy, "to keep MVP 1 free of custom IRIS code and reusable across
environments."

## Decision

**The detection engine runs outside IRIS, in the `services/detection-engine/` service on port
3002.** It consumes Dev A's proxy JSON over HTTP and never touches IRIS directly.

MVP 1 ships **no custom ObjectScript for detection**.

## Rationale

**It uses only the built-in `/api/monitor/` API.** This is §1.2's stated reason Health Scan is
first — lowest-risk module, no custom IRIS code required. Putting detection in ObjectScript would
forfeit that property on day one.

**Deployability is the real argument.** A customer evaluating Production Guardian can point it at
an existing production without installing classes into their namespace. Detection in ObjectScript
means a code deployment into a live interoperability namespace — a much harder sell, and a much
harder rollback.

**It matches the ownership split.** `iris/**` is Dev A's, `services/detection-engine/**` is Dev
B's. An in-IRIS engine would put the engine inside Dev A's directory and make the two developers
share a component, which is precisely what the three-way split exists to avoid.

**Language freedom for the consumer.** Dev C binds to nothing language-specific — they read a base
URL from an env var (`apps/dashboard/CLAUDE.md` §4.3). That stays true only while the engine is an
HTTP service.

## Consequences

**Accepted costs:**

- Every metric crosses a process boundary, so the engine sees data at proxy-poll granularity
  (10s) rather than live. Acceptable: the bar is "updates within 10s of a change," and the
  dashboard polls at 5s, so the proxy is the pacing item either way.
- Baseline state lives in a process that can restart, losing warm-up. See ADR 0002.
- Some IRIS state is not in the Prometheus text at all — `iris_interop_queued` has no `host`
  label. Per-host queue depth comes from `Ens.Util.Statistics:EnumerateHostStatus` instead, which
  means **the proxy must expose host status, not only parse `/metrics`.** This is a real
  constraint on Dev A's component discovered while building LABDEMO, and the one place this
  decision costs something concrete.

**Gained:**

- MVP 1 installs nothing into IRIS beyond enabling built-in metrics
- The engine is testable against fixture JSON with no IRIS at all — which is what makes
  mock-first (ADR 0004) work

## Alternatives considered

**Detection in ObjectScript inside IRIS.** Rejected for MVP 1. It has genuine advantages —
sub-second access to host state, no serialization, direct `Ens.*` API access — and is worth
revisiting for **Smart Resolve**, which must act on the production and will need in-IRIS presence
anyway. But adopting it now trades away Health Scan's lowest-risk property for capability MVP 1
does not use.

**Split: detection in the proxy, host-state reads in IRIS.** Rejected as premature. It is what
we would build if the queue-depth constraint above proves limiting, but it splits one component
across two owners for a problem we have not yet hit.

## Revisit when

- Smart Resolve begins — it needs in-IRIS presence, and the engine may follow it
- Per-host state proves unavailable through the proxy in a way that blocks a finding type
- Sub-10s detection becomes a requirement
