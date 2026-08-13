# Contributing — Production Guardian

How three developers work in this repo without colliding, especially since each is running Claude Code locally.

The short version: **ownership is directory-level and disjoint.** The only path two developers both read is `contracts/`, and that one is deliberately gated.

---

## 1. Repository layout

```
production-guardian/
│
├─ README.md                     # what this is, ports, how to run all three parts
├─ CONTRIBUTING.md               # this file — the rules, with the why
├─ CLAUDE.md                     # shared agent rules — terse restatement, see §3
├─ .gitignore  .gitattributes  .editorconfig
│
├─ contracts/                    # ★ THE COORDINATION POINT — PR-gated, see §4
│  ├─ README.md                  # how to change a contract
│  ├─ proxy-api.md               # Dev A owns: per-host metrics + alerts JSON
│  ├─ proxy.schema.json
│  ├─ healthscan-api.md          # Dev B owns: findings + hosts JSON
│  ├─ healthscan.schema.json
│  ├─ healthscan.d.ts            # generated TS types — Dev C consumes
│  ├─ CHANGELOG.md               # every contract change, dated, with the reason
│  └─ samples/                   # ★ the shared truth for all three mocks
│     ├─ metrics-dump.txt        # raw /api/monitor/metrics from live IRIS (Dev A)
│     ├─ alerts.json             # raw /api/monitor/alerts sample (Dev A)
│     ├─ proxy-response.json     # Dev A's output = Dev B's mock input
│     ├─ hosts-response.json     # Dev B's output = Dev C's mock input
│     └─ findings-response.json  #      "
│
├─ iris/                         # ── DEV A ONLY ──
│  ├─ CLAUDE.md
│  ├─ setup/                     # EnableSAMForNamespace, EnableStatsForProduction
│  ├─ labdemo/                   # LABDEMO production definition, 4 components
│  ├─ hl7-generator/             # synthetic HL7 feed
│  └─ triggers/                  # the 8 finding-trigger toggles
│
├─ services/
│  ├─ metrics-proxy/             # ── DEV A ONLY ──  :3001
│  │  ├─ CLAUDE.md
│  │  └─ ...                     # Prometheus text -> per-host JSON + alerts
│  │
│  └─ detection-engine/          # ── DEV B ONLY ──  :3002
│     ├─ CLAUDE.md
│     └─ ...                     # baseline, 8 rules, thresholds config,
│                                #   GET /api/healthscan/{findings,hosts}
│
├─ apps/
│  └─ dashboard/                 # ── DEV C ONLY ──  :5173
│     ├─ CLAUDE.md
│     └─ ...                     # React + Vite + TS
│
├─ tools/
│  ├─ mock-server/               # shared: serves contracts/samples/ on any port
│  └─ scripts/                   # dev-up, port checks, contract type generation
│
├─ docs/                         # source material — read-only after Day 1
│  ├─ Brochure.png
│  ├─ production-guardian-deck.pptx
│  ├─ production-guardian-demo.html          # concept demo — do not edit
│  ├─ production-guardian-healthscan-mvp1.docx
│  ├─ decisions/                 # ADRs: the 4 open decisions from §7.4 of the MVP doc
│  └─ demo/                      # ── DEV C ──  screencast, cue-sheet.md
│                                #   DESCOPED from MVP 1 (2026-08-13); dir not created yet
│
└─ .github/
   ├─ CODEOWNERS                 # ★ mechanically enforces ownership, see §4
   ├─ pull_request_template.md
   └─ workflows/ci.yml           # per-path jobs so A's push never fails on C's build
```

Three Claude Code sessions can run concurrently against this tree without touching a shared file, and no developer's build breaks another's CI.

## 2. Ownership map

> **Team change, 2026-08-12.** Dev A moved off the project and Dev B took over their
> outstanding tasks and their two areas (`iris/**`, `services/metrics-proxy/**`,
> `contracts/proxy-*`). Two developers remain. Where this file says "all three" it now means
> **every remaining developer** — the count was never the point; requiring someone other than
> the author is. GitHub will not let an author approve their own PR, so with two people the
> gate is exactly "the other person looked at it". Prose elsewhere describing the original
> three-way split is left as written, because it records how the project was structured.


| Path | Owner | Everyone else |
|---|---|---|
| `iris/**`, `services/metrics-proxy/**` | Dev B (was Dev A) | read-only |
| `services/detection-engine/**` | Dev B | read-only |
| `apps/dashboard/**`, `docs/demo/**` | Dev C | read-only |
| `contracts/proxy-*` | Dev B (was Dev A) | read + PR |
| `contracts/healthscan-*` | Dev B | read + PR |
| `contracts/samples/**` | producer of each file | read-only |
| `tools/**`, root config, `.github/**` | shared | PR + one review |
| `docs/*` (source material) | nobody | read-only |

Reading another developer's area for context is encouraged — that is how you understand the contract you are consuming. Writing to it is not.

## 3. Layer the CLAUDE.md files — don't write one big one

Claude Code reads the root `CLAUDE.md` **plus** the nearest one to the files being edited. Use that:

- **Root `CLAUDE.md`** — short and stable. What the project is, the scope boundary, the ownership map, ports, the "never edit `contracts/`" rule. Rules true for all three developers, nothing more. Every edit to it is a conflict for the other two, so it should barely change after Day 1.
- **`apps/dashboard/CLAUDE.md`**, **`services/detection-engine/CLAUDE.md`**, **`services/metrics-proxy/CLAUDE.md`**, **`iris/CLAUDE.md`** — deep, area-specific instructions.

This is the single biggest lever against Claude Code sessions colliding: each developer's agent gets detailed instructions only for its own area, and each developer edits an instruction file nobody else touches.

Three files describe ownership, each with a distinct job — keep them in sync, but don't merge them:

| File | Job |
|---|---|
| `.github/CODEOWNERS` | enforces ownership (machine) |
| `CONTRIBUTING.md` | explains it, with the why (humans) |
| root `CLAUDE.md` | terse restatement of the boundaries (agents) |

## 4. Two mechanisms that do the real work

### CODEOWNERS

Makes ownership mechanical rather than a promise:

```
/iris/                        @devA
/services/metrics-proxy/      @devA
/services/detection-engine/   @devB
/apps/dashboard/              @devC
/docs/demo/                   @devC
/contracts/                   @devA @devB @devC     # any contract change needs all three
*                             @devA @devB @devC     # root config
```

Requiring all three reviewers on `contracts/` sounds heavy — it is the point. A silent contract change is the failure mode that breaks the Day-5 integration, and the review takes 30 seconds.

### Per-path CI

So Dev A's push never goes red because Dev C's TypeScript is mid-refactor:

```yaml
jobs:
  dashboard:        # paths: apps/dashboard/**            -> tsc --noEmit + build
  detection-engine: # paths: services/detection-engine/**
  metrics-proxy:    # paths: services/metrics-proxy/**
  contracts:        # paths: contracts/**  -> validate samples against schemas
```

That last job is worth more than the other three combined: it validates every file in `contracts/samples/` against `contracts/*.schema.json`, so the moment a contract and the shared fixtures disagree, CI says so — instead of the Day-5 rehearsal.

## 5. Per-developer local guardrails

Nothing personal gets committed, but each developer sets up `.claude/settings.local.json` (gitignored) to stop their own agent from wandering. Dev C's:

```json
{
  "permissions": {
    "deny": [
      "Edit(./contracts/**)",
      "Edit(./services/**)",
      "Edit(./iris/**)",
      "Edit(./docs/production-guardian-demo.html)"
    ]
  }
}
```

Reading stays allowed — Dev C *should* read the contract. Only writing is blocked. Mirror it for A and B.

## 6. Contracts and the Day-1 gate

- **Day 1 is a gate, not a workday.** Nobody starts real implementation until `contracts/proxy-api.md`, `contracts/healthscan-api.md`, and the files in `contracts/samples/` are merged to `main`. That merge *is* the first milestone from §7.2 of the MVP doc.
- **`contracts/samples/` is the handoff currency.** Dev A's `proxy-response.json` is literally Dev B's mock input; Dev B's `findings-response.json` is literally Dev C's mock input. Same bytes, so "works against the mock" actually predicts "works against the real thing."
- **Mock-first is the plan, not a fallback.** After Day 1 no developer should ever be blocked on another's service being up.
- **A contract change after Day 1** is a PR to `contracts/` with a `CHANGELOG.md` entry and a heads-up to the consumer. Never an in-place edit, never a silent one.
- **Record the four open decisions** from §7.4 of the MVP doc as ADRs in `docs/decisions/` on Day 1 — detection-engine location, baseline strategy, threshold configuration, and the mock-first agreement. They are the questions most likely to be re-litigated on Day 4.

## 7. Git workflow

- Branch from `main` as `devA/<topic>`, `devB/<topic>`, `devC/<topic>`.
- Small, frequent commits. Subjects scoped to the area: `feat(dashboard): add finding detail drawer`.
- PR to `main`. A PR touching a file outside your own area needs the owning developer's review — CODEOWNERS will ask for it automatically.
- Never commit `.env`, `node_modules/`, `dist/`, `.claude/settings.local.json`, or video files (link the screencast or use Git LFS).
- Run your area's build and typecheck before opening a PR.

## 8. Day-1 setup checklist

Turn each of these into a GitHub issue rather than tracking it here — a checklist nobody ticks off in a file is worse than no checklist.

1. `README.md` — ports, and clone-to-running for each of the three parts.
2. Root `CLAUDE.md` (thin) + the four area files.
3. `contracts/` — both API docs, both schemas, `CHANGELOG.md`, and the five sample files. Stub them, then replace with real captures from live IRIS.
4. `.github/CODEOWNERS`, PR template, `ci.yml` with the four per-path jobs.
5. `.gitignore` — `node_modules/`, `dist/`, `.env`, `.claude/settings.local.json`, `*.mp4`.
6. `docs/decisions/0001`–`0004` — the four ADRs from §7.4 of the MVP doc.
