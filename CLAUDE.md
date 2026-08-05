# CLAUDE.md — Production Guardian (shared rules)

Rules that apply to **all three developers**. Deep, area-specific instructions live in the nearest `CLAUDE.md` to the files being edited:

| Area | File |
|---|---|
| Dashboard / UI (Dev C) | `apps/dashboard/CLAUDE.md` |
| Detection engine + findings API (Dev B) | `services/detection-engine/CLAUDE.md` |
| Metrics proxy (Dev A) | `services/metrics-proxy/CLAUDE.md` |
| IRIS, LABDEMO, triggers (Dev A) | `iris/CLAUDE.md` |

**Keep this file stable.** Every edit here is a merge conflict for the other two developers. Area-specific rules belong in an area file, not here.

---

## 1. What this project is

**Production Guardian** is an AI-powered production health and optimization layer for InterSystems Health Connect. Eight modules are planned; **MVP 1 is Health Scan only**.

Health Scan reads production metrics from the built-in IRIS `/api/monitor/` API, compares them to a rolling baseline, and surfaces findings — dead jobs, hung processes, queue buildup, elevated error rates, slow processing, system alerts.

Spec: `docs/production-guardian-healthscan-mvp1.docx`.

## 2. Hard scope boundary

**Health Scan performs detection and surfacing only.** It reads, compares, and reports — nothing more.

Out of scope for MVP 1 because each belongs to a later module:

| Not in MVP 1 | Belongs to |
|---|---|
| Fixing, remediation, restarting, tuning | Smart Resolve |
| Root-cause analysis, evidence chains, confidence | AI Detective |
| Forecasting, "will breach in N minutes" | Early Warning |
| A single 0–100 health score | Health Score |
| Report / summary generation | Health Summary |
| Natural-language chat | Ask Guardian |

Also out: historical trend charts, multi-production support (single production only), persisted baseline history.

`docs/production-guardian-demo.html` is a **concept** demo of all eight modules with scripted fake data. It is a visual reference only — never a source of implementation, never edited.

**If a request would add a capability from the table above, say so instead of building it.** Scope creep is the biggest risk to the 5-day timeline.

## 3. Ownership — stay in your own directory

| Path | Owner |
|---|---|
| `iris/**`, `services/metrics-proxy/**` | Dev A |
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
- A contract change is its own PR, with a `contracts/CHANGELOG.md` entry, reviewed by all three developers.

## 5. Ports and conventions

| Service | Port | Owner |
|---|---|---|
| Metrics proxy | `3001` | Dev A |
| Findings API (`/api/healthscan/*`) | `3002` | Dev B |
| Dashboard dev server | `5173` | Dev C |

Branches: `devA/…`, `devB/…`, `devC/…`. Commit subjects scoped to the area: `feat(dashboard): …`, `fix(detection-engine): …`. Never commit `.env`, `node_modules/`, `dist/`, `.claude/settings.local.json`, or video files.

## 6. Working rules for Claude Code

- **Never invent data.** No placeholder hosts, no fabricated metrics or findings outside a declared fixtures directory. Demo data uses the four LABDEMO components (EMR Source, Lab Router, FHIR Transform, Cloud API) and the eight real finding types.
- **Mock-first is the plan, not a fallback.** Dev B builds against a mock of Dev A's proxy; Dev C builds against a mock of Dev B's findings API. Never block on another developer's service being up.
- **No new dependencies** without stating why and what it replaces.
- **Match the surrounding code** — same naming, file shape, and comment density. Comment the non-obvious, not the obvious.
- **Verify before claiming done.** Run the area's build/typecheck/tests. If something fails or is unverified, say which and show the actual output. A green claim over a red build costs the team more than the bug did.
