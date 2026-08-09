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
npm test             # 95 tests
npm run typecheck    # tsc --noEmit, strict
```

**It runs with no proxy.** Mock-first is the plan, not a fallback (ADR 0004) — `npm start`
replays captured LABDEMO fixtures and serves real findings immediately:

```bash
curl localhost:3002/api/healthscan/hosts
curl localhost:3002/api/healthscan/findings
curl localhost:3002/api/healthscan/health   # operational, not in the contract
```

Against Dev A's real proxy:

```bash
PROXY_MODE=live PROXY_BASE_URL=http://localhost:3001 npm start
```

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3002` | |
| `PROXY_MODE` | `mock` | `mock` \| `live` |
| `PROXY_BASE_URL` | `http://localhost:3001` | live mode only |
| `POLL_INTERVAL_MS` | `10000` | matches the proxy's own IRIS poll |

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
| `queue-buildup.json` | Cloud API throttled: queue 486, slow, erroring. Trips four rules. |
| `cloud-api-dead.json` | Cloud API disabled. Real observed state — status `Disabled`, depth 48. |

Note `cloud-api-dead` sits at depth **48** against an `absoluteFloor` of **50**, so it
deliberately does *not* trip `queue_buildup`. That is the two-condition design in ADR 0003
working, not a gap.

## Before claiming done

`npm run typecheck` and `npm test` must both pass, and the engine must still start with no proxy.
Test the negative cases: a rule that fires but never stops is broken, and a positive-only suite
will not notice.

Deeper instructions: `CLAUDE.md` in this directory. Decisions: `docs/decisions/0001`–`0004`.
