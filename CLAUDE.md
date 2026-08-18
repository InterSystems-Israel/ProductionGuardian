# CLAUDE.md — Production Guardian (shared rules)

Rules that apply to **every developer**. Deep, area-specific instructions live in the nearest `CLAUDE.md` to the files being edited:

| Area | File |
|---|---|
| Dashboard / UI (Dev C) | `apps/dashboard/CLAUDE.md` |
| Detection engine + findings API (Dev B) | `services/detection-engine/CLAUDE.md` |
| Metrics proxy (Dev B, was Dev A) | `services/metrics-proxy/CLAUDE.md` |
| IRIS, LABDEMO, triggers (Dev B, was Dev A) | `iris/CLAUDE.md` |

**Keep this file stable.** Every edit here is a merge conflict for everyone else. Area-specific rules belong in an area file, not here.

---

## 1. What this project is

**Production Guardian** is an AI-powered production health and optimization layer for InterSystems Health Connect. Eight modules are planned. **MVP 1 (Health Scan) is shipped; MVP 2 adds Early Warning, AI Detective and Smart Resolve.**

Health Scan reads production metrics from the built-in IRIS `/api/monitor/` API, compares them to a rolling baseline, and surfaces findings — dead jobs, hung processes, queue buildup, elevated error rates, slow processing, system alerts. MVP 2 turns one of those findings into a closed loop: **WHAT** (project it forward) → **WHY** (explain it) → **FIX** (apply a governed, approved action and confirm it clears).

Specs: `docs/production-guardian-healthscan-mvp1.docx`, `docs/production-guardian-mvp2.docx`. Both are read-only source material (§3).

## 2. Hard scope boundary

**MVP 1 (Health Scan) is complete and shipped.** We are now building **MVP 2**, which
deliberately crosses three of the boundaries MVP 1 held. This section is the record of what is
in and out *now*; the MVP 1 boundary is kept below it because the reasoning still governs the
five modules that remain out.

Spec: `docs/production-guardian-mvp2.docx`.

### 2.1 In scope for MVP 2 — three modules, one scenario

| Now in scope | What it does | Owner |
|---|---|---|
| **Early Warning** | Projects a building condition forward: "queue rising ~N/min, crosses threshold in ~M minutes" | Dev B (detection-engine) |
| **AI Detective** | An AI Hub agent that explains root cause with evidence and a confidence score, and recommends an action | Dev B (orchestration) + `iris/**` (agent, MCP tools) |
| **Smart Resolve** | Applies one governed, human-approved, reversible action to the live production and confirms the condition clears | `iris/**` (write tool) + Dev B (endpoint) + Dev C (approval UI) |

**MVP 2 is one scenario, end to end, not a general capability.** `Cloud API` runs at
`PoolSize 1` against a ~1s-per-message downstream dispatcher, so it clears ~1 msg/sec; inbound
load above that builds a queue; the fix is enlarging the pool (1 → 4). One finding type, one
recommended action, one write tool. A generalised action catalogue is later work.

**Smart Resolve writes to a live production, so the safety model is part of the scope
boundary, not an implementation detail:**

- **human approval by default** — nothing applies unattended
- **exactly one whitelisted action**, `set_pool_size` on `Cloud API`, within a bounded range
- **dry-run / preview** before apply, and the action is **reversible**
- **RBAC-gated** — a dedicated IRIS role, so AI Detective can investigate without being able to act
- **every tool call audited**, read and write, so "the AI changed a production setting" is
  attributable
- **metrics and configuration only ever leave the instance.** Never message content, never PHI.
  This is a rule, not a preference: the LLM is external.

`ADR 0001` anticipated this — it records that the detection engine runs outside IRIS for MVP 1
while noting Smart Resolve "must act on the production and will need in-IRIS presence anyway",
and lists "Smart Resolve begins" under *Revisit when*. MVP 2 is that revisit.

### 2.2 Still out of scope

| Not in MVP 2 | Belongs to |
|---|---|
| A single 0–100 health score | Health Score |
| Report / summary generation | Health Summary |
| Natural-language chat | Ask Guardian |
| Tuning advice | Performance Coach |

Also still out: **autonomous remediation without approval**, more than one scenario or action
type, multi-production support (single production only), historical trend of interventions,
historical trend charts, persisted baseline history.

`docs/production-guardian-demo.html` is a **concept** demo of all eight modules with scripted
fake data. It is a visual reference only — never a source of implementation, never edited.

**If a request would add a capability from the §2.2 table, say so instead of building it.**
Scope creep is still the biggest risk to the timeline — which is why MVP 2 is one scenario
rather than three.

### 2.3 What MVP 1 held, and why it is worth keeping written down

The MVP 1 boundary was: **Health Scan performs detection and surfacing only — it reads,
compares, and reports, nothing more.** Fixing, root-cause analysis and forecasting were all
out, each because it belonged to a later module.

That boundary is what made a 5-day MVP 1 land, and the three modules it deferred are exactly
the three MVP 2 now adds. Keeping the record visible matters for two reasons: it shows the
deferral was deliberate rather than an oversight, and it is the reason `queue_buildup` detection
already exists for MVP 2's scenario to build on.

## 3. Ownership — stay in your own directory

| Path | Owner |
|---|---|
| `iris/**`, `services/metrics-proxy/**` | Dev B (was Dev A) |
| `services/detection-engine/**` | Dev B |
| `apps/dashboard/**`, `docs/demo/**` | Dev C |
| `contracts/**` | see §4 — **nobody edits without a PR** |
| `tools/**`, root config, `.github/**` | shared, PR + review |
| `docs/*` source material (brochure, deck, MVP docx, demo html) | read-only |

**Reading another area for context is encouraged. Writing to it is not.** If a task seems to require editing outside your area, stop and say so.

Full explanation and rationale: `CONTRIBUTING.md`.

## 4. `contracts/` is read-only

`contracts/` holds the two Day-1 API contracts, their JSON schemas, and the shared sample payloads in `contracts/samples/`. Those samples are the *same bytes* each developer mocks against, which is what makes "works against the mock" predict "works against the real thing."

- **Never edit a file in `contracts/`** as part of an implementation task.
- Never add a field to a local type to make code compile — that is a **contract change request** to the owning developer.
- A contract change is its own PR, with a `contracts/CHANGELOG.md` entry, reviewed by **every other developer**. Two remain since 2026-08-12 (Dev A moved off; Dev B took their areas), so in practice that is one other person — and GitHub will not let an author approve their own PR, which is the point.

## 5. Ports and conventions

| Service | Port | Owner |
|---|---|---|
| Metrics proxy | `3001` | Dev B (was Dev A) |
| Findings API (`/api/healthscan/*`) | `3002` | Dev B |
| Dashboard dev server | `5173` | Dev C |

Branches: `devA/…`, `devB/…`, `devC/…`. Commit subjects scoped to the area: `feat(dashboard): …`, `fix(detection-engine): …`. Never commit `.env`, `node_modules/`, `dist/`, `.claude/settings.local.json`, or video files.

## 6. Working rules for Claude Code

- **Never invent data.** No placeholder hosts, no fabricated metrics or findings outside a declared fixtures directory. Demo data uses the LABDEMO application components and the eight real finding types. The authoritative host list is the `<Item>` set in `iris/labdemo/Production.cls` — do not restate it, because a copied host list is what went stale when `FHIR Transform` was removed.
- **Mock-first is the plan, not a fallback.** Dev B builds against a mock of Dev A's proxy; Dev C builds against a mock of Dev B's findings API. Never block on another developer's service being up.
- **No new dependencies** without stating why and what it replaces.
- **Match the surrounding code** — same naming, file shape, and comment density. Comment the non-obvious, not the obvious.
- **Verify before claiming done.** Run the area's build/typecheck/tests. If something fails or is unverified, say which and show the actual output. A green claim over a red build costs the team more than the bug did.
