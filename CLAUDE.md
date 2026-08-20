# CLAUDE.md — Production Guardian (shared rules)

Rules that apply to **every developer**. Deep, area-specific instructions live in the nearest `CLAUDE.md` to the files being edited:

| Area | File |
|---|---|
| Dashboard / UI (Dev B) | `apps/dashboard/CLAUDE.md` |
| Detection engine + findings API (Dev B) | `services/detection-engine/CLAUDE.md` |
| Metrics proxy (Dev A) | `services/metrics-proxy/CLAUDE.md` |
| IRIS, LABDEMO, triggers (Dev A) | `iris/CLAUDE.md` |

**Keep this file stable.** Every edit here is a merge conflict for everyone else. Area-specific rules belong in an area file, not here.

---

## 1. What this project is

**Production Guardian** is an AI-powered production health and optimization layer for InterSystems Health Connect. Eight modules are planned. **MVP 1 (Health Scan) and MVP 2 (Early Warning, AI Detective, Smart Resolve) are both shipped.**

Health Scan reads production metrics from the built-in IRIS `/api/monitor/` API, compares them to a rolling baseline, and surfaces findings — dead jobs, hung processes, queue buildup, elevated error rates, slow processing, system alerts. MVP 2 turns one of those findings into a closed loop: **WHAT** (project it forward) → **WHY** (explain it) → **FIX** (apply a governed, approved action and confirm it clears).

Specs: `docs/production-guardian-healthscan-mvp1.docx`, `docs/production-guardian-mvp2.docx`. Both are read-only source material (§3).

## 2. Hard scope boundary

**MVP 1 and MVP 2 are both complete and shipped.** MVP 2 deliberately crossed three of the
boundaries MVP 1 held. This section is the record of what is in and out *now*; the MVP 1
boundary is kept below it because the reasoning still governs the five modules that remain out.

Spec: `docs/production-guardian-mvp2.docx`.

**MVP 2 shipped on 2026-08-20**, verified from an empty volume in one `compose up`: Early
Warning projected the crossing (`eta` tightening 820s -> 23s), `queue_buildup` fired, a live
`gpt-4o-mini` agent explained it with all evidence read through governed tools, and one approved
`set_pool_size 1 -> 4` drained the queue to zero. Six audit rows for six tool calls. The
standing pre-demo check is #108 and `iris/CLAUDE.md`'s acceptance table.

**What shipped is one scenario, not a general capability** — that was the §2.1 bargain and it
held. `set_pool_size` on `Cloud API` within `2..8` is still the only action, and the five
modules in §2.2 are still out. **Anything beyond that is MVP 3 scope and needs its own spec
before it is built**, for the same reason MVP 2 had one: three modules landed because the
boundary was written down first.

### 2.1 In scope for MVP 2 — three modules, one scenario

| Now in scope | What it does | Owner |
|---|---|---|
| **Early Warning** | Projects a building condition forward: "queue rising ~N/min, crosses threshold in ~M minutes" | Dev B (detection-engine) |
| **AI Detective** | An AI Hub agent that explains root cause with evidence and a confidence score, and recommends an action | Dev B (orchestration) + `iris/**` (agent, MCP tools) |
| **Smart Resolve** | Applies one governed, human-approved, reversible action to the live production and confirms the condition clears | `iris/**` (write tool) + Dev B (endpoint and approval UI) |

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

**Two developers since 2026-08-20**, corrected below. Dev C left the project; `apps/dashboard/**` and
`docs/demo/**` pass to Dev B, who has been the only author in that directory since MVP 2's UI landed.

| Path | Owner |
|---|---|
| `iris/**`, `services/metrics-proxy/**` | Dev A |
| `services/detection-engine/**` | Dev B |
| `apps/dashboard/**`, `docs/demo/**` | **Dev A from 2026-08-20** (MVP 3 Track B) — was Dev B |
| `contracts/**` | see §4 — **nobody edits without a PR** |
| `tools/**`, root config, `.github/**` | shared, PR + review |
| `docs/*` source material (brochure, deck, MVP docx, demo html) | read-only |

**Reading another area for context is encouraged. Writing to it is not.** If a task seems to require editing outside your area, stop and say so.

**The two rows above were both wrong until 2026-08-20**, and one had been wrong for a week — which is
why the MVP 3 spec makes amending this table its first task rather than an afterthought, exactly as §2
had to be amended before MVP 2 (#85).

- `iris/**` and `services/metrics-proxy/**` read "Dev B (was Dev A)". That was the reverse of the
  truth: `iris/CLAUDE.md` has said "Developer A owns" throughout, the MVP 2 spec §5.2 assigns Dev A
  "everything inside `iris/**`", and Dev A authored 7 of the 9 `iris/` commits in MVP 2 while Dev B
  reviewed them as the consumer. A table nobody followed is worse than no table, because it is the one
  a newcomer trusts.
- `apps/dashboard/**` read "Dev C" after Dev C left, so MVP 3's dashboard work had **no owner at all**.

**The whole directory moves to one developer rather than splitting by file.** Splitting `apps/dashboard/**`
between two people would create exactly the seam MVP 2's retrospective indicts — every expensive defect
in MVP 2 was at a boundary between owners, not inside one.

Full explanation and rationale: `CONTRIBUTING.md`.

## 4. `contracts/` is read-only

`contracts/` holds the two Day-1 API contracts, their JSON schemas, and the shared sample payloads in `contracts/samples/`. Those samples are the *same bytes* each developer mocks against, which is what makes "works against the mock" predict "works against the real thing."

- **Never edit a file in `contracts/`** as part of an implementation task.
- Never add a field to a local type to make code compile — that is a **contract change request** to the owning developer.
- A contract change is its own PR, with a `contracts/CHANGELOG.md` entry, reviewed by **every other developer**. Two remain (Dev C left on 2026-08-20; Dev B took their areas — see §3), so in practice that is one other person — and GitHub will not let an author approve their own PR, which is the point. The parenthetical here said "Dev A moved off" until 2026-08-20 and was the source of §3's reversed row.

## 5. Ports and conventions

| Service | Port | Owner |
|---|---|---|
| Metrics proxy | `3001` | Dev A |
| Findings API (`/api/healthscan/*`) | `3002` | Dev B |
| Dashboard dev server | `5173` | Dev B |

Branches: `devA/…`, `devB/…`. Commit subjects scoped to the area: `feat(dashboard): …`, `fix(detection-engine): …`. Never commit `.env`, `node_modules/`, `dist/`, `.claude/settings.local.json`, or video files.

## 6. Working rules for Claude Code

- **Never invent data.** No placeholder hosts, no fabricated metrics or findings outside a declared fixtures directory. Demo data uses the LABDEMO application components and the eight real finding types. The authoritative host list is the `<Item>` set in `iris/labdemo/Production.cls` — do not restate it, because a copied host list is what went stale when `FHIR Transform` was removed.
- **Mock-first is the plan, not a fallback.** Dev B builds against a mock of Dev A's proxy, and the dashboard against a mock of the findings API. Never block on another developer's service being up.
  **With two developers the engine↔dashboard boundary is now inside one person, so mock-first there is a discipline rather than a necessity** — nothing forces the contract to be real when the same author owns both sides. Keep the mock anyway: MVP 2's two costliest UI defects were at that seam (the WHY/FIX endpoints served for two days behind a UI that never called them, and nginx proxying only `/api/healthscan/` so every other endpoint returned HTML with a 200). Both were found by driving the UI's own path, which is what the mock exists to make cheap.
- **No new dependencies** without stating why and what it replaces.
- **Match the surrounding code** — same naming, file shape, and comment density. Comment the non-obvious, not the obvious.
- **Verify before claiming done.** Run the area's build/typecheck/tests. If something fails or is unverified, say which and show the actual output. A green claim over a red build costs the team more than the bug did.
