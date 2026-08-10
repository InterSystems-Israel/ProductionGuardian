# CLAUDE.md — services/metrics-proxy (Dev A)

This proxy is Dev A's second deliverable. It polls the IRIS `/api/monitor/` endpoints
and exposes clean per-host JSON that the detection engine (Dev B) consumes.

See the parent area file `../../iris/CLAUDE.md` for the full Dev A context.

---

## Key facts

- **Port:** 3001 (never change without updating root CLAUDE.md)
- **Language:** Node.js, plain CommonJS (no TypeScript, no transpilation)
- **Poll intervals:** `/api/monitor/metrics` every 10 s; `/api/monitor/alerts` every 30 s
- **Output contract:** `../../contracts/proxy-schema.json` (read-only after Day 1 freeze)
- **Credentials:** environment variables only — see `.env.example`

## File layout

```
services/metrics-proxy/
  src/
    parser.js        Prometheus text → structured JS objects
    poller.js        HTTP polling loop (metrics + alerts)
    cache.js         In-memory latest-snapshot store
    router.js        Express route handlers
  index.js           Entry point: wires poller → cache → HTTP server
  mock-server.js     Standalone mock: serves fixture data, no IRIS needed
  fixtures/
    metrics.txt      Sample /api/monitor/metrics output (Prometheus text)
    alerts.json      Sample /api/monitor/alerts output
  .env.example       Environment variable template
  package.json
```

## Running

```bash
npm install
npm start           # real IRIS (needs .env)
npm run mock        # mock mode — no IRIS required
npm test            # parser unit tests
```

## Acceptance criteria (spec §4.3)

- Returns documented per-host JSON within 2 s of poll.
- Parser handles all 8 metric types.
- `/proxy/alerts` forwards `/api/monitor/alerts` JSON.
