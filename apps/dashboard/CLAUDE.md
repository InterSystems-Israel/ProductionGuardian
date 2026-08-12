# CLAUDE.md — Health Scan Dashboard (**Developer C**)

Scoped to `apps/dashboard/`. The root `CLAUDE.md` carries the shared rules — scope boundary, ownership, ports — and applies here too. `CONTRIBUTING.md` at the repo root explains the working agreements in full.

---

## 1. What you are building

The **Health Scan dashboard** — the operator-facing frontend for MVP 1 of Production Guardian.

It does exactly three things:

1. **Per-host status grid** — one tile per interoperability host in the monitored production.
2. **Live findings list** — detected issues, newest first, with severity.
3. **Severity summary** — counts of critical / warning / info.

Plus: a **finding detail view** (click a finding → current value vs. baseline, metric, timestamp), **live polling**, and a **demo-mode / live-mode toggle**.

You are the *display* layer. You render what Developer B's API gives you. You compute nothing.

### 1.1 Hard scope boundary — do not cross it

Health Scan is **detection and surfacing only**. When implementing, do **not** build:

| Do NOT build | Because it belongs to |
|---|---|
| Any "Fix this" / "Apply remediation" / "Restart job" button or flow | **Smart Resolve** (later module) |
| Root-cause narratives, evidence chains, confidence scores | **AI Detective** (later module) |
| Forecasts, "will breach in 17 minutes", trend prediction | **Early Warning** (later module) |
| A single 0–100 Health Score number or score ring | **Health Score** (later module) |
| Historical trend charts / time-series graphs | Out of MVP 1 scope |
| Production selector / multi-production switching | Out of MVP 1 scope — **single production only** |
| Chat / "Ask Guardian" input | **Ask Guardian** (later module) |
| Report generation, daily/exec summaries | **Health Summary** (later module) |

`docs/production-guardian-demo.html` is a **concept** demo showing all eight modules with scripted fake data. It is a **visual and narrative reference only**. Do not port its scenario engine, its score ring, its resolve flow, or its module carousel into the live dashboard. Treat it as read-only.

**If a request would add any capability from the table above, stop and say so rather than building it.** Scope creep here is the single biggest risk to the 5-day timeline.

---

## 2. The contract (this is the law)

Developer B owns two endpoints. They are published in **`contracts/`** at the repo root. That directory is **read-only for you** — never edit a file in it. If something is wrong or missing, raise it with Dev B; do not "fix" it locally.

`contracts/healthscan-api.md` is the human-readable contract. `contracts/healthscan.schema.json` / `contracts/healthscan.d.ts` are the machine-readable ones.

### 2.1 `GET /api/healthscan/hosts`

```json
[
  {
    "host": "LabRouter",
    "type": "operation",
    "status": "OK",
    "queued": 12,
    "messagesPerSec": 20.4,
    "errored": 0,
    "avgProcessingTime": 0.08,
    "avgQueueingTime": 0.02,
    "lastActivity": "2026-08-04T14:02:11Z"
  }
]
```

### 2.2 `GET /api/healthscan/findings`

```json
[
  {
    "id": "f-1042",
    "host": "LabRouter",
    "type": "queue_buildup",
    "severity": "warning",
    "currentValue": 486,
    "baselineValue": 15,
    "detectedAt": "2026-08-04T14:06:33Z",
    "message": "Queue depth 486 is 32x baseline"
  }
]
```

### 2.3 Types — mirror the contract, never invent fields

Keep `src/types/healthscan.ts` as a direct transcription of the contract. Every field the UI reads must exist in the contract. If you need a field that isn't there, that is a **contract change request to Dev B**, not a local addition.

```ts
export type Severity = 'info' | 'warning' | 'critical';

/**
 * The real IRIS enum (contract §4 Q1). There is no `Warning` — a struggling host
 * still reports `OK`, and the *finding* carries the alarm.
 */
export type HostStatus =
  | 'OK' | 'Error' | 'Inactive' | 'Retry' | 'Stopped' | 'Unconfigured' | 'Disabled';

export type FindingType =
  | 'dead_host'            // iris_interop_hosts status Inactive/Error
  | 'stalled_host'         // iris_last_activity stale while queued
  | 'queue_buildup'        // iris_interop_queued
  | 'elevated_error_rate'  // iris_interop_messages_errored
  | 'slow_processing'      // iris_interop_avg_processing_time
  | 'growing_queue_wait'   // iris_interop_avg_queueing_time
  | 'throughput_drop'      // iris_interop_messages_per_sec
  | 'system_alert';        // /api/monitor/alerts

export interface Host {
  host: string;
  type: string;            // 'service' | 'process' | 'operation' — treat as open string
  status: HostStatus;
  queued: number | null;       // null = not measurable for this host, NOT zero (Q13)
  messagesPerSec: number;
  errored: number | null;      // null = not measurable, NOT zero errors (Q13)
  avgProcessingTime: number;   // seconds
  avgQueueingTime: number;     // seconds
  lastActivity: string;        // ISO 8601 UTC
}

export interface Finding {
  id: string;
  host: string;
  type: FindingType;
  severity: Severity;
  currentValue: number;
  baselineValue: number | null;  // null while the baseline is warming up
  detectedAt: string;          // ISO 8601 UTC, second precision, Z-suffixed
  message: string;             // human-readable, render as-is
}
```

**Timestamps are second-precision `Z`-suffixed** (`2026-08-06T15:47:52Z`). `Date.prototype.toISOString()` is **not** conforming — it always emits milliseconds (`…52.000Z`), which the contract's pattern rejects. Use `toContractIso` in `src/api/scenarios.ts` when producing them.

### 2.4 Defensive rendering — required, not optional

The contract will drift during the sprint. The UI must never crash or blank out because of it.

- **Unknown `FindingType`** → render with a neutral icon and a humanized label derived from the string (`queue_buildup` → "Queue buildup"). Never throw, never filter it out silently.
- **Unknown `HostStatus`** → render as neutral/grey, not as OK.
- **Unknown `severity`** → treat as `info`.
- **Missing optional numerics** (`baselineValue` absent during baseline warm-up) → render `—`, not `NaN`, `null`, or `0`.
- **`message` is authoritative.** Render Dev B's `message` string as the finding's primary text. Do not reconstruct your own sentence from `currentValue`/`baselineValue` — you will disagree with the engine.
- Validate the response shape at the API boundary (one small guard function per endpoint) and log-and-skip malformed array entries rather than rejecting the whole payload.

### 2.5 The Day-1 questions — answered

All thirteen are settled in **`contracts/healthscan-api.md` §4** (issue #1, PR #3, and Q13 from PR #35). That document is the source of record; this is the summary.

Eight of the nine original assumptions held. **Q1 and Q13 are the two corrections**, and both are fixed:

| # | Answer |
|---|---|
| **Q1** | ❌ **The one correction.** No `Warning`. Real enum: `OK`, `Error`, `Inactive`, `Retry`, `Stopped`, `Unconfigured`, `Disabled`. |
| Q2 | Eight snake_case names, unchanged. |
| Q3 | `baselineValue: number \| null`. Also an advisory `X-Healthscan-State: warming` header, deliberately ignored — `null` is sufficient and one source of truth beats two. |
| Q4 | ids **stable** while the condition persists; findings **disappear** when cleared. The highlight animation and poll-surviving drawer are sound. |
| Q5 | Sorted server-side too. The client sort stays as cheap insurance. |
| Q6 | **Seconds**, confirmed empirically. `0.08 → "80 ms"` is right. |
| Q7 | `200` + `[]`, never `404`, including during startup. |
| Q8 | `finding.host` is always exactly a `host.host` value. |
| Q9 | CORS `*` is sent; the dev proxy is optional, kept as the default anyway. |
| Q10 | IRIS says `actor` for business processes; Dev B normalizes to `process`. |
| Q11 | `lastActivity` is derived from elapsed seconds — trust it to ±10s, not for sub-second ordering. |
| Q12 | `avgProcessingTime` is a sample-count-weighted aggregate across message types. |
| Q13 | `queued` / `errored` are `number \| null`. `null` is **"not measurable for this host"**, never zero — the counts come from a host-status endpoint merged on host name, and a host that merge does not reach stays null. Render `—`; never compare against it. |

**Keep the `// CONTRACT-Q<n>` convention** for future contract-dependent work. Tagging each assumption site with a greppable marker made reconciliation a `grep` rather than an audit — ADR 0004 recommends promoting it to practice.

Two open items raised back to Dev B on PR #3: the schema rejects the empty array `[]` that §3 mandates as the normal "no findings" response, and its timestamp `pattern` rejects `toISOString()` output.

---

## 3. Stack and project layout

**Stack:** React 18 + TypeScript + Vite. Plain CSS with custom properties — **no** Tailwind, no CSS-in-JS, no component library. The design is brand-specific enough that a utility framework buys nothing and a component library actively fights the brand.

**Dependencies:** keep them near-zero. React, React DOM, Vite, TypeScript, and `vite-plugin-singlefile` (for the fallback build, §6). Add nothing else without a stated reason. No date library (use `Intl`), no icon package (inline SVGs), no state manager (`useState`/`useReducer` is sufficient at this size), no fetch wrapper.

```
apps/dashboard/
├─ CLAUDE.md                    <- this file
├─ package.json
├─ vite.config.ts
├─ tsconfig.json
├─ index.html
├─ .env.example                 <- documents VITE_* vars; committed
├─ public/
│  └─ favicon.svg
├─ fixtures/                    <- demo-mode data; see §5
│  ├─ scenario-healthy.json
│  ├─ scenario-queue-buildup.json
│  ├─ scenario-dead-host.json
│  ├─ scenario-error-storm.json
│  ├─ scenario-slow-processing.json
│  ├─ scenario-throughput-drop.json
│  ├─ scenario-system-alert.json
│  └─ scenario-baseline-warming.json
└─ src/
   ├─ main.tsx
   ├─ App.tsx                   <- layout, mode toggle, polling orchestration
   ├─ types/
   │  └─ healthscan.ts          <- transcription of contracts/ (§2.3)
   ├─ api/
   │  ├─ HealthScanApi.ts       <- the interface both impls satisfy
   │  ├─ liveClient.ts          <- fetch against Dev B's endpoints
   │  ├─ mockClient.ts          <- fixture-backed, scripted progression
   │  ├─ guards.ts              <- runtime shape validation (§2.4)
   │  └─ lastGood.ts            <- localStorage cache of last successful payload
   ├─ hooks/
   │  ├─ usePolling.ts          <- interval + visibility + backoff
   │  └─ useHealthScan.ts       <- hosts + findings + status, one hook
   ├─ components/
   │  ├─ AppShell.tsx           <- nav rail + header + content region
   │  ├─ SeveritySummary.tsx    <- critical / warning / info counts
   │  ├─ HostGrid.tsx
   │  ├─ HostCard.tsx
   │  ├─ FindingsList.tsx
   │  ├─ FindingRow.tsx
   │  ├─ FindingDetail.tsx      <- side drawer
   │  ├─ SeverityBadge.tsx
   │  ├─ StatusDot.tsx
   │  ├─ ConnectionBanner.tsx   <- live/demo/stale/offline state
   │  ├─ EmptyState.tsx
   │  └─ icons.tsx              <- inline SVG set, one export per icon
   ├─ lib/
   │  ├─ format.ts              <- durations, ms, relative time, ratios
   │  ├─ findingMeta.ts         <- type -> label + icon + affected metric
   │  └─ severity.ts            <- ordering, counting, comparison
   └─ styles/
      ├─ tokens.css             <- design tokens ONLY (§7)
      └─ app.css                <- component styles
```

**Component rules.** One component per file, named the same as the file. Presentational components take data as props and hold no fetching logic — all network access lives in `src/api/` and reaches components through `useHealthScan`. Any component file growing past ~150 lines should be split.

---

## 4. Mock-first, then live

The MVP plan's whole parallelization bet is that you build against a mock from Day 1 and swap in Dev B's real API later. Honor that: **you must never be blocked waiting for the backend.**

### 4.1 One interface, two implementations

```ts
// src/api/HealthScanApi.ts
export interface HealthScanApi {
  getHosts(signal?: AbortSignal): Promise<Host[]>;
  getFindings(signal?: AbortSignal): Promise<Finding[]>;
}
```

`liveClient.ts` and `mockClient.ts` both implement it. `App.tsx` picks one based on mode and passes it down. **No component ever imports a client directly**, and no component ever calls `fetch`.

Deliberately **not using MSW / a service worker**: the demo fallback must run as a plain static file (§6), where service-worker registration is unreliable. A swappable module works identically in dev, in the live build, and in the single-file fallback.

### 4.2 Mode selection

```
?mode=demo   (default)  -> mockClient
?mode=live              -> liveClient
```

Default to **demo**. A URL with no query string must always render something presentable — that is the demo-reliability mitigation. Also expose a visible toggle in the header so the presenter can switch without editing the URL, and reflect the current mode in the URL via `history.replaceState` so it is shareable.

`liveClient` failure must **degrade, never blank**: show `ConnectionBanner` in a "cannot reach the Health Scan API" state, render the last-good cached payload from `lastGood.ts` dimmed with a "data as of HH:MM:SS" label, and keep retrying with capped backoff. After N consecutive failures, offer a one-click "switch to demo mode" in the banner.

### 4.3 Pointing at the backend

Backend language is not yet decided across the team, so bind to nothing language-specific. Read the base URL from an env var, defaulting to a Vite dev proxy path:

```
# .env.example
VITE_HEALTHSCAN_BASE_URL=/api/healthscan
VITE_HEALTHSCAN_TARGET=http://localhost:3002
VITE_POLL_INTERVAL_MS=5000
```

```ts
// vite.config.ts
server: {
  port: 5173,
  proxy: {
    '/api/healthscan': {
      target: process.env.VITE_HEALTHSCAN_TARGET ?? 'http://localhost:3002',
      changeOrigin: true,
    },
  },
}
```

Going through the dev proxy means **CORS is never your problem** and Dev B can be Node or Python without you changing a line.

**Ports:** metrics proxy `:3001` · findings API `:3002` · dashboard dev server `:5173`.

### 4.4 Polling

- Poll both endpoints on the same tick. Default **5 s** (`VITE_POLL_INTERVAL_MS`). This keeps the client off the critical path — it is the shortest of the four stages between a change in IRIS and a change on screen — but do **not** read it as meeting the "updates within 10 s of a change" bar. That bar is the *sum* of four stages: proxy → IRIS, engine → proxy, the engine's own sustained-breach gap, then this poll. Each was chosen defensibly in isolation and nobody multiplied them out; #44 measured the total at **16.1 s** against a 10 s bar. Read the two upstream intervals from `services/metrics-proxy/.env.example` and `services/detection-engine/src/index.ts` rather than quoting a number here — both have already changed once, and a duration copied into this file goes stale silently. #44 owns the bar itself.
- Pause polling when `document.hidden`; refetch immediately on becoming visible.
- Abort the in-flight request on unmount and before each new tick (`AbortController`).
- On error, back off (5 s → 10 s → 20 s, cap 30 s) and reset on the first success.
- Never let two intervals stack up. One timer, owned by `usePolling`.
- Show a subtle "last updated Xs ago" indicator. If the last success is older than 3× the interval, mark the data **stale** in `ConnectionBanner`.

---

## 5. Demo mode and fixtures

Demo mode is a **first-class deliverable**, not a stub — it is the Day-5 fallback and the screencast source.

- **Fixtures name only components that really exist in the monitored production**, so demo and live look continuous. **Read the host list from the `<Item>` set in `iris/labdemo/Production.cls`, which is the authority — do not restate it here.** A copied host list is the thing that keeps going stale: `FHIR Transform` was removed in `contracts/` PR #15 and had to be chased out of the contract samples, the engine fixtures, these fixtures, the CI count and the root `CLAUDE.md` separately. The rule being enforced is *never invent a host*, not *there are N hosts*. **Nothing in `src/` may hardcode a host name or a host count** — issue #25 has the reasoning and the evidence that the runtime is production-agnostic; issue #34 is the live case where the repo and the deployed instance disagree about the count.
- Fixture files are plain JSON matching the contract exactly — the same guards run over them. If a fixture fails validation, the contract transcription is wrong.
- Each fixture is a scenario file containing `{ hosts: Host[], findings: Finding[] }`. `scenario-healthy.json` has zero findings — that exercises the empty state, which is easy to forget and looks bad if broken on stage.
- `mockClient` supports a **scripted progression**: healthy → degrading → findings appear, advancing on each poll so the dashboard visibly comes alive during the demo without anyone touching IRIS. Make it loop, and make it restartable from the UI.
- Optional but useful: `?scenario=queue-buildup` to jump straight to one fixture for screenshots and for the presenter cue sheet.
- **Timestamps must be relative to load time**, computed at runtime from `Date.now()` minus an offset stored in the fixture. Hard-coded absolute dates make the demo read "3 weeks ago" the moment it is not rehearsal day.

---

## 6. Static fallback build

MVP 1 requires a static fallback that "just opens". With Vite that needs two settings:

```ts
// vite.config.ts
base: './',                        // relative asset paths so file:// works
plugins: [react(), viteSingleFile()]
```

- `npm run build` → `dist/index.html`, a single self-contained file, demo mode by default.
- Verify it by opening `dist/index.html` **directly from the filesystem** (not via a server). If it needs a server, the fallback has failed.
- `docs/production-guardian-demo.html` stays as the belt-and-braces concept fallback. Do not modify it.
- Deliver alongside: the **screencast** and the **presenter cue sheet** (`docs/demo/`), both explicitly on Dev C's task list.

---

## 7. Visual design — InterSystems brand-aligned

Match the brochure and deck, not the concept-demo HTML's generic dark theme. Palette extracted from `docs/production-guardian-deck.pptx` and `docs/Brochure.png`.

### 7.1 Tokens — all colors go in `styles/tokens.css`, nothing hard-coded

```css
:root {
  /* Brand */
  --pg-navy-900: #142138;   /* deepest — nav rail base            */
  --pg-navy-800: #1B2A4A;   /* primary brand navy — headings, rail */
  --pg-navy-700: #233A5C;   /* rail hover / elevated navy          */
  --pg-navy-600: #2A4570;
  --pg-teal-500: #00A887;   /* brand accent — healthy, active      */
  --pg-teal-200: #90C8BF;   /* muted accent                        */

  /* Neutrals */
  --pg-surface:      #FFFFFF;   /* cards                    */
  --pg-surface-alt:  #F0F4F8;   /* page background          */
  --pg-surface-sunk: #E8EEF5;   /* inset / table header     */
  --pg-border:       #D0DAE8;
  --pg-border-soft:  #E8EEF5;
  --pg-text:         #1B2A4A;
  --pg-text-muted:   #6B7280;
  --pg-text-invert:  #FFFFFF;

  /* Severity — the only semantic colors; never reuse for decoration */
  --pg-critical:     #C0392B;
  --pg-critical-bg:  #FCEBE9;
  --pg-warning:      #B8791C;
  --pg-warning-bg:   #FDF4E3;
  --pg-info:         #1F5F9E;
  --pg-info-bg:      #EAF2FA;
  --pg-ok:           #00806A;   /* darkened teal — AA on white  */
  --pg-ok-bg:        #E6F6F2;
  --pg-neutral:      #6B7280;   /* unknown status / warming up  */
  --pg-neutral-bg:   #F0F4F8;

  /* Type */
  --pg-font: "Inter", "Segoe UI", -apple-system, system-ui, sans-serif;
  --pg-font-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;

  /* Geometry — 4px scale, use these, not magic numbers */
  --pg-space-1: 4px;  --pg-space-2: 8px;  --pg-space-3: 12px;
  --pg-space-4: 16px; --pg-space-5: 24px; --pg-space-6: 32px;
  --pg-radius:    8px;
  --pg-radius-lg: 12px;
  --pg-radius-pill: 999px;
  --pg-shadow-card: 0 1px 2px rgb(20 33 56 / 6%), 0 2px 8px rgb(20 33 56 / 4%);
  --pg-shadow-drawer: -8px 0 24px rgb(20 33 56 / 12%);
}
```

Note that `--pg-critical` / `--pg-warning` / `--pg-ok` are **darkened** from the brochure's brighter marketing tones so that severity text clears WCAG AA on white. Severity must be legible on a projector at the back of a room.

### 7.2 Layout

Follow the brochure mockup: a **dark navy left nav rail** (Health Connect context: Home, Dashboard, Productions, Alerts, Messages, Jobs, Settings — only *Dashboard* is active and functional; the rest are inert visual context, and should look inert, not clickable-and-broken), a **white content area** on `--pg-surface-alt`, and a header carrying the shield mark, "Production Guardian — Health Scan", the live/demo pill, last-updated time, and the mode toggle.

Content, top to bottom:

1. **Severity summary** — a row of four count tiles: Critical, Warning, Info, and Hosts OK. Large numeral, small label, severity-tinted left edge. This is the at-a-glance row from the brochure, minus the score ring.
2. **Host status grid** — responsive cards, `repeat(auto-fill, minmax(260px, 1fr))`. Each card: status dot + host name, host type as a small caps label, and the metrics that matter — Queued, Msg/sec, Errors, Avg processing, Avg queueing, Last activity (relative). A card with an active finding gets a severity-colored left border at its worst severity.
3. **Findings list** — newest first. Each row: severity badge, humanized finding type, host, the `message` string, relative timestamp. Whole row is the click target, opening the detail drawer.
4. **Finding detail** — a right-hand drawer (not a modal; the operator should keep seeing the grid). Shows finding type and severity, host, **current value vs. baseline value side by side with the ratio or delta**, the underlying IRIS metric name, detected-at as both absolute UTC and relative, and the full message. This "current vs. baseline" pairing is the whole point of the detail view — make it the visual focus.

### 7.3 Interaction and quality bar

- Every state must be designed, not defaulted: **loading** (skeletons, not spinners), **empty** ("No findings — production is within baseline"), **error**, **stale**, **baseline warming up**.
- **Never full-page-reload on poll.** Keyed lists, stable identity from `finding.id`, so the drawer stays open and scroll position holds across refreshes.
- Newly appeared findings get a brief highlight so a change is noticeable on stage. Subtle — one soft pulse, not a flash. Honor `prefers-reduced-motion`.
- Numbers are monospaced (`--pg-font-mono`) and right-aligned in the metric rows so they do not jitter as values change.
- Formatting lives in `lib/format.ts`: sub-second times as ms (`0.08` → `80 ms`), relative times via `Intl.RelativeTimeFormat`, ratios as `32×` where meaningful and as a delta where not, `—` for absent values.
- Accessibility is part of the bar: real `<button>` for anything clickable, `aria-live="polite"` on the findings count so severity changes are announced, keyboard-reachable findings rows, drawer closes on `Esc` and returns focus to the row that opened it, and **severity is never signaled by color alone** — always badge text plus icon shape.
- Responsive down to a 1024px laptop. Not a mobile deliverable.

---

## 8. Task list and acceptance criteria

From §4.5 of the MVP plan, in order:

| # | Task | Est. | Done when |
|---|---|---|---|
| 1 | Dashboard against mocked schema — host grid, findings list, severity summary | 1.5 d | Renders every host the API returns, whatever the count, and all fixture findings; every state designed; `tsc` clean |
| 2 | Live polling + demo/live toggle (`?mode=live`) | 0.75 d | Visible change reflected within 10 s; API failure degrades to last-good + banner, never blanks |
| 3 | Finding detail view | 0.5 d | Click a finding → current vs. baseline, metric, timestamp; keyboard accessible; drawer survives polls |
| 4 | Screencast + static fallback | 0.5 d | `dist/index.html` opens from `file://` in demo mode; screencast recorded |
| 5 | Presenter cue sheet | 0.25 d | `docs/demo/cue-sheet.md` — click path, what to say, what to do if live mode dies |

**Overall acceptance (from the MVP doc):** *dashboard renders all hosts + findings live; updates within 10 s of a change; fallback to demo mode is seamless.*

Sequencing note: tasks 1–3 need only the contract, so they proceed regardless of backend readiness. Task 2's live path is verifiable against a two-endpoint stub returning fixture JSON — build that stub inside `apps/dashboard/` if Dev B's API is not up yet, and delete it once it is.

---

## 9. Instructions for Claude Code in this directory

- **Ask before widening scope.** If a request implies any module from §1.1, say so instead of building it.
- **The contract is upstream of you.** Never edit `contracts/`. Never add a field to a type to make a component work — surface it as a contract question.
- **Never invent data.** No placeholder hosts, no made-up metrics, no fabricated findings outside `fixtures/`. Fixtures name only components the monitored production really has, and only the eight real finding types.
- **Never hardcode a host name or a host count in `src/`.** The UI renders whatever the API returns. A count compiled in is a UI component tracking someone else's config, and it goes stale the moment the production changes — see issue #25.
- **No new dependencies** without stating why and what it replaces.
- **No `fetch` outside `src/api/`.** No component talks to the network.
- **No hard-coded colors, spacing, or radii.** Use the tokens in §7.1. If a token is missing, add it to `tokens.css` rather than inlining a value.
- **Match the surrounding code.** Same naming, same file shape, same comment density. Comment the non-obvious (why a poll aborts, why a ratio is displayed that way), not the obvious.
- **Stay inside `apps/dashboard/`** unless the task is explicitly about `docs/demo/`. Ownership map: root `CONTRIBUTING.md` §2.
- **Verify before claiming done.** `npm run build` and `npx tsc --noEmit` must pass. No `any`, no `@ts-ignore`. If something is broken or unverified, say so with the actual output.
