# detection-engine

Health Scan's baseline + rule engine and findings API. **Dev B.** Port **3002**.

Consumes Dev A's metrics proxy (`:3001`), publishes the contract in
`contracts/healthscan-api.md` for Dev C's dashboard.

## Run it

Requires **Node ≥ 22.18** (native TypeScript type stripping — no build step, no transpiler).

```bash
npm install          # devDependencies only; zero runtime dependencies
npm start            # mock proxy, serves on :3002
npm run dev          # same, with --watch
npm test             # 375 tests
npm run typecheck    # tsc --noEmit, strict
```

**It runs with no proxy.** Mock-first is the plan, not a fallback (ADR 0004) — `npm start`
replays captured LABDEMO fixtures and serves real findings immediately:

```bash
curl localhost:3002/api/healthscan/hosts
curl localhost:3002/api/healthscan/findings
curl localhost:3002/api/healthscan/health   # operational, not in the contract
```

Against the real proxy:

```bash
PROXY_MODE=live PROXY_BASE_URL=http://localhost:3001 npm start
```

```powershell
# Windows. PowerShell has no one-shot VAR=value prefix -- the line above fails with
# "The term 'PROXY_MODE=live' is not recognized". Set them, then start:
$env:PROXY_MODE = 'live'
$env:PROXY_BASE_URL = 'http://localhost:3001'
npm start
```

Both stay set for the rest of that window, unlike the POSIX prefix — so a later `npm start` in the
same terminal is still in live mode and will sit there failing to reach a proxy that is not up.
`Remove-Item Env:\PROXY_MODE` undoes it. `curl` is an alias for `Invoke-WebRequest` in the
PowerShell that ships, so the three lines above need `curl.exe`. Root `README.md` → *On Windows*
has the full table and is the only place it is written down.

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3002` | |
| `PROXY_MODE` | `mock` | `mock` \| `live` |
| `PROXY_BASE_URL` | `http://localhost:3001` | live mode only |
| `POLL_INTERVAL_MS` | `5000` | matches the proxy's own IRIS poll. **A floor, not a preference** — `src/index.ts` documents the sweep, and `4500` already breaks an invariant |

## Shape of it

```
proxy poll ─> normalize ─> baseline window ─> 8 rules ─> registry ─> API
                (Q10/Q11)     (ADR 0002)     (ADR 0003)    (Q4)
```

- **`src/baseline/`** — trailing 30-min window per host+metric. Warm-up returns `null`, never a
  seeded guess.
- **`src/detect/rules/`** — the eight rules, pure functions of `(sample, window, config)`.
- **`src/detect/registry.ts`** — stable ids + sustained-breach state. This is what makes the
  contract's Q4 promises true.
- **`src/config/`** — `thresholds.json`, hot-reloaded, last-good on invalid input.
- **`src/proxy/`** — real and mock clients behind one interface.

## Demo fixtures

`fixtures/proxy/` holds **real captures from the live LABDEMO production**, not invented numbers.
The default scenario loops healthy → degrading → dead → recovery, so findings visibly appear
*and clear* without touching IRIS.

| Fixture | What it shows |
|---|---|
| `healthy.json` | Steady state. Includes `Ens.MonitorService` to prove framework filtering. |
| `queue-buildup.json` | Cloud API throttled: queue 486, slow, waiting. Trips four rules. |
| `error-storm{,-2,-3,-4}.json` | Errored count climbing 60 → 210 → 400 → 620 across consecutive polls. `-2` onward carry a system alert. |
| `stalled-host.json` | Lab Router hung: status still `OK`, idle 384s, 27 queued. The case `dead_host` cannot catch. |
| `cloud-api-dead.json` | Cloud API disabled. Real observed state — status `Disabled`, depth 48. |

**The loop reaches all eight finding types and all three severities.** `test/scenario.test.ts`
asserts it, because an earlier version silently reached only three — every rule was unit-tested and
passing, so nothing caught it until Dev C compared 46 live findings against the eight documented
types.

Two things that look like gaps and are not:

- `cloud-api-dead` sits at depth **48** against an `absoluteFloor` of **50**, so it deliberately
  does *not* trip `queue_buildup`. That is ADR 0003's two-condition design working.
- The error storm uses **four fixtures at one poll each** rather than one repeated. The engine
  derives errors/min from the *delta* between polls, so a step held for several polls has a flat
  counter and yields a rate of zero.

## Before claiming done

`npm run typecheck` and `npm test` must both pass, and the engine must still start with no proxy.
Test the negative cases: a rule that fires but never stops is broken, and a positive-only suite
will not notice.

Deeper instructions: `CLAUDE.md` in this directory. Decisions: `docs/decisions/0001`–`0004`.
