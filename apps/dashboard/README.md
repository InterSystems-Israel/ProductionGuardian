# Health Scan dashboard

Operator-facing frontend for Production Guardian MVP 1. React 18 + Vite +
TypeScript, no runtime dependencies beyond React itself.

**Current state:** the host grid, findings list and severity summary run against
fixture data. Live polling, the demo/live toggle and the finding detail drawer are
not built yet — see [Not built yet](#not-built-yet).

---

## Run it

```bash
cd apps/dashboard
npm install
npm run dev
```

Then open <http://localhost:5173/>. No backend needed and no `.env` required —
demo mode is the default, so a bare URL always renders something presentable.

## Try each state

Every scenario is reachable by URL, which is also how you grab screenshots.

| URL | What you should see |
|---|---|
| `/` | Scripted progression — advances one fixture per refresh, then loops |
| `/?scenario=healthy` | All four hosts OK, zero counts, the designed empty state |
| `/?scenario=queue-buildup` | Lab Router queue at 486, two warnings |
| `/?scenario=dead-host` | Cloud API grey `Inactive` dot, two criticals, red left borders |
| `/?scenario=error-storm` | Cloud API in `Error`, 218 errored messages |
| `/?scenario=slow-processing` | FHIR Transform at 1.86 s per message |
| `/?scenario=throughput-drop` | EMR Source intake collapsed to 1.8 msg/sec |
| `/?scenario=system-alert` | An alert from `/api/monitor/alerts` |
| `/?scenario=baseline-warming` | `baselineValue: null` — comparisons render `—`, never `NaN` |

An unknown slug logs the valid ones to the console and falls back to the
progression rather than breaking.

### The progression

The default view walks `healthy → queue-buildup → slow-processing → error-storm
→ dead-host → healthy` and loops. It advances on each poll, so once polling
lands (Phase 2) the dashboard comes alive unattended during a demo. Until then,
drive it from the header:

- **Advance** — fetch the next step.
- **↻** (restart) — back to step 1.

The header caption shows which fixture is on screen and the step number, so you
can always tell what you are looking at.

## Things worth deliberately checking

These are the behaviours most likely to regress, and none of them are obvious
from a screenshot:

- **Empty state** — `?scenario=healthy` must show "No findings — production is
  within baseline", not a blank panel. It is the state most likely to be on
  screen when the demo opens.
- **Baseline warm-up** — `?scenario=baseline-warming` has `baselineValue: null`.
  Nothing anywhere should read `NaN`, `null`, `0` or `Infinity×`.
- **Keyboard path** — <kbd>Tab</kbd> should reach every findings row and skip the
  nav rail entirely. The rail is inert visual context: it must not be focusable
  or look clickable.
- **Unknown values** — an unrecognized host status renders grey, never green. An
  unrecognized finding type gets a neutral icon and a humanized label rather
  than disappearing.
- **Number alignment** — metric values are monospaced and right-aligned so
  digits do not jitter as values change across refreshes.
- **Reduced motion** — with OS "reduce motion" on, the new-finding pulse and the
  skeleton shimmer both stop.
- **1024–1100px** — the rail collapses to icons and the grid reflows. Below
  1024px is out of scope; this is not a mobile deliverable.

## Static fallback build

The Day-5 fallback has to open with no server at all:

```bash
npm run build
```

Produces `dist/index.html` as a **single self-contained file** — JS, CSS,
fixtures and favicon all inlined. Verify by opening it directly from the
filesystem:

```bash
start dist/index.html        # Windows
```

If it needs a server, the fallback has failed. Fixtures are imported statically
rather than fetched precisely so this works from `file://`.

## Checks before a PR

```bash
npx tsc --noEmit    # strict, no `any`, no @ts-ignore
npm run build       # runs tsc first, then builds
```

Both are clean as of the current commit.

---

## How it fits together

```
fixtures/*.json                 8 scenarios, LABDEMO's 4 components
   │
   ├─ api/scenarios.ts          static imports; relative → absolute timestamps
   ├─ api/mockClient.ts   ─┐
   └─ api/liveClient.ts   ─┤    (Phase 2 — not built yet)
                           │
                    api/HealthScanApi.ts     the seam: two impls, one interface
                           │
                    api/guards.ts            validate at the boundary
                           │
                  hooks/useHealthScan.ts     the only place data enters the UI
                           │
                      components/*           props in, no fetching
```

Two rules make the demo/live swap safe: **no component imports a client**, and
**no component calls `fetch`**. `App.tsx` picks the implementation; everything
below it is unaware of which one is running.

### Timestamps

Fixtures store `detectedSecondsAgo` / `lastActivitySecondsAgo`, not absolute
dates, and `mockClient` resolves them against load time. Hard-coded dates would
make the demo read "3 weeks ago" the day after rehearsal.

### The contract

`src/types/healthscan.ts` is a transcription of the Health Scan API contract.
`contracts/` is not published yet, so the current source of record is
`apps/dashboard/CLAUDE.md` §2.3, which matches §5 of the MVP spec.

Seven of the nine open questions (Q1–Q6, Q8) are tagged at the 13 sites that
rely on them. Q7 (empty/error payloads) and Q9 (CORS) only bite once the live
client exists, so they land in Phase 2.

```bash
grep -rn "CONTRACT-Q" src/
```

The load-bearing one is **Q4** in `hooks/useHealthScan.ts`: the new-finding
highlight assumes `finding.id` is stable while a condition persists. If ids churn
per poll, every finding pulses on every poll and the feature has to go.

Fixtures pass through the same guards as live data. **If a guard drops a fixture
entry, the transcription is wrong** — that is why fixture validation is worth
watching in the console.

## Not built yet

| Phase | Work | Status |
|---|---|---|
| 2 | Live polling, demo/live toggle, `ConnectionBanner`, last-good cache | not started |
| 3 | Finding detail drawer — current vs. baseline, metric, timestamp | not started |
| 4 | Screencast (needs a human to record) | not started |
| 5 | `docs/demo/cue-sheet.md` | not started |

Out of scope for MVP 1 by design, not omission: remediation buttons, root-cause
narratives, forecasts, a 0–100 health score, trend charts, production switching,
chat. Each belongs to a later module — root `CLAUDE.md` §2.
