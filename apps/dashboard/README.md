# Health Scan dashboard

Operator-facing frontend for Production Guardian MVP 1. React 18 + Vite +
TypeScript, no runtime dependencies beyond React itself.

**Current state: MVP 1 complete.** Host grid, findings list, severity summary,
finding detail drawer, live polling and a demo/live toggle — tasks 1–4 of
`CLAUDE.md` §8, including the static fallback build. The screencast and the
presenter cue sheet are **descoped from MVP 1** and will follow after it — see
[Status by phase](#status-by-phase).

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
| `/?scenario=healthy` | All three hosts OK, zero counts, the designed empty state |
| `/?scenario=queue-buildup` | Lab Router queue at 486, two criticals |
| `/?scenario=dead-host` | Cloud API grey `Disabled` dot, three criticals and a warning, red left borders |
| `/?scenario=error-storm` | Cloud API in `Error`, 218 errored messages |
| `/?scenario=slow-processing` | Lab Router at 1.86 s per message |
| `/?scenario=throughput-drop` | EMR Source intake collapsed to 0 msg/sec, the drop reaching all three hosts |
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

## Live mode

The dashboard polls both endpoints every 2 s (`VITE_POLL_INTERVAL_MS`), pauses
while the tab is hidden, and refetches the moment it returns.

2 s, not 5 s: this poll is the last stage before the screen and the only one gated
by no invariant, so it is the one latency term we could spend (#68). What that does
and does not buy for the end-to-end figure is
[ADR 0005](../../docs/decisions/0005-latency-bar.md) — which is the only place that
figure is written down, deliberately, so there is nothing here to go stale.

Dev B's detection engine serves both endpoints on `:3002`. It runs with **nothing
on `:3001`** — it replays captured LABDEMO fixtures through healthy → degrading →
dead → recovery, so findings appear *and clear* without IRIS being involved:

```bash
cd ../../services/detection-engine && npm install && npm start
```

The engine's default 5 s poll means the baseline needs ~14 polls to warm before the
first finding is confirmed. To watch a whole cycle without waiting, compress it —
**but not below 2000 ms**:

```bash
POLL_INTERVAL_MS=2000 npm start    # full appear-and-clear cycle, still emits
```

```powershell
# Windows. There is no one-shot VAR=value prefix -- PowerShell reads it as the command name and
# fails with "The term 'POLL_INTERVAL_MS=2000' is not recognized".
$env:POLL_INTERVAL_MS = '2000'
npm start
Remove-Item Env:\POLL_INTERVAL_MS   # <- do not skip this, see below
```

**On Windows the compression outlives the demo, and that is the trap.** The POSIX prefix applies to
one command; `$env:` stays set for the rest of the window, so the next `npm start` in that terminal
is still at 2000 ms — and per the floors below, that is an engine running outside its designed
envelope while looking entirely normal. `Remove-Item Env:\POLL_INTERVAL_MS`, or use a fresh window
for the compressed run.

`POLL_INTERVAL_MS` has floors, and they do not fail loudly. The engine's
`sustainedSeconds` gate needs `(sustainedSamples - 1) x interval > sustainedSeconds`,
so **4500 ms already breaks an invariant** and finding types stop emitting entirely
below ~1750 ms (#64, #65). This file used to suggest `700`, at which **nothing fires
at all** — you get a warm baseline, a healthy grid, and no findings, which reads as a
broken dashboard rather than a poll rate below its floor.

Then open <http://localhost:5173/?mode=live>, or click **Live** in the header.
The mode is reflected in the URL, so it's shareable.

### Watch it degrade and recover

This is the demo-reliability path, and the one worth testing by hand:

1. Start the engine, open `?mode=live`, confirm the teal **LIVE** pill and data flowing.
2. **Kill the engine.** Within ~2 s: a red banner appears, the last-good data stays
   on screen but dimmed, labelled `Showing data as of HH:MM:SS UTC`. **It must
   never blank.**
3. Wait. Polling backs off by **doubling from the poll interval**, capped at 30 s,
   rather than hammering — at the default 2 s that is 4 s → 8 s → 16 s → 30 s. The
   ladder is derived from the interval rather than fixed, so it moves with
   `VITE_POLL_INTERVAL_MS`; don't re-copy it here when that changes. At
   **3 consecutive failures** a *Switch to demo mode* button appears — the
   on-stage escape hatch.
4. **Restart the engine.** The banner clears on the next successful poll, with no
   page reload.

The last-good payload is cached in `localStorage` (live mode only — caching demo
fixtures would let a stale scenario resurface as if it were real). So step 2 also
works on a *fresh page load* while the API is down: real data appears
immediately, dimmed, rather than empty skeletons.

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
start dist/index.html        # Windows -- PowerShell, cmd, and Git Bash all have `start`
open dist/index.html         # macOS
xdg-open dist/index.html     # Linux
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
   ├─ api/mockClient.ts   ─┐    demo: scripted progression
   └─ api/liveClient.ts   ─┤    live: fetch :3002 via the Vite proxy
                           │
                    api/HealthScanApi.ts     the seam: two impls, one interface
                           │
                    api/guards.ts            validate at the boundary
                           │
                  hooks/useHealthScan.ts     the only place data enters the UI
                     + api/lastGood.ts       localStorage, live mode only
                           │
                  hooks/usePolling.ts        one timer, abort, backoff
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

```powershell
Get-ChildItem -Recurse src | Select-String "CONTRACT-Q"
```

`Select-String` has no `-r`, so the obvious transliteration fails with *"A parameter cannot be found
that matches parameter name 'r'"* — the recursion is the pipeline's job, not the cmdlet's.

The load-bearing one is **Q4** in `hooks/useHealthScan.ts`: the new-finding
highlight assumes `finding.id` is stable while a condition persists. If ids churn
per poll, every finding pulses on every poll and the feature has to go.

Fixtures pass through the same guards as live data. **If a guard drops a fixture
entry, the transcription is wrong** — that is why fixture validation is worth
watching in the console.

## Running it in a container

`Dockerfile` builds the same single-file bundle the `file://` fallback uses and serves it
with nginx, which also proxies the findings API so the browser only ever talks to one
origin. This is the dashboard's service for the compose chain (#72).

```bash
docker build -t pg-dashboard:local apps/dashboard
docker run -d -p 5173:80 -e HEALTHSCAN_UPSTREAM=detection-engine:3002 pg-dashboard:local
```

`HEALTHSCAN_UPSTREAM` is `host:port`, no scheme, and defaults to the compose service name.
The app keeps its relative `/api/healthscan` base URL in every environment — nothing about
the image is environment-specific, which is why the proxy exists rather than a build-time
URL.

Two properties worth knowing, both verified rather than intended:

- **it does not need the engine to start.** nginx resolves the upstream per request, not at
  config load, so the container comes up immediately, serves demo mode (which needs no
  backend at all), returns 502 on the live path until the engine appears, and recovers on
  its own. Measured: engine stopped → `/` still 200 and the container stays healthy with 0
  restarts; engine restarted → live path back to 200 with no dashboard restart. **So it
  needs no `depends_on`**, which matters because IRIS takes minutes to initialise
- **on a plain `docker run` the upstream must be reachable by whatever DNS the container
  has.** The resolver is derived from `/etc/resolv.conf`, so on a user-defined network it is
  Docker's embedded DNS and service names resolve; on the default bridge it is public DNS
  and `host.docker.internal` does **not** resolve. Compose always creates a user-defined
  network, so this only bites ad-hoc runs

## Status by phase

| Phase | Work | Status |
|---|---|---|
| 2 | Live polling, demo/live toggle, `ConnectionBanner`, last-good cache | **done** |
| 3 | Finding detail drawer — current vs. baseline, metric, timestamp | **done** |
| 4 | Static fallback build | **done** — `dist/index.html` opens from `file://` |
| — | Screencast | **descoped from MVP 1** (2026-08-13) |
| — | `docs/demo/cue-sheet.md` | **descoped from MVP 1** (2026-08-13) |

Both are presentation artefacts rather than product, neither is verifiable by a
test, and the screencast needs a human to record. Nothing in MVP 1's overall
acceptance depends on either — the static fallback is what makes the demo
survivable, and it is done. `docs/demo/` does not exist yet by design.

Click any finding row to open the detail drawer: current vs. baseline side by
side, the comparison between them, the underlying IRIS metric, and detected-at as
both relative and absolute UTC. `Esc` closes it and returns focus to the row that
opened it.

The drawer looks its finding up from the live array on every poll rather than
holding a copy, so an open drawer's numbers update as the condition develops, and
it closes itself if the condition clears.

Out of scope for MVP 1 by design, not omission: remediation buttons, root-cause
narratives, forecasts, a 0–100 health score, trend charts, production switching,
chat. Each belongs to a later module — root `CLAUDE.md` §2.
