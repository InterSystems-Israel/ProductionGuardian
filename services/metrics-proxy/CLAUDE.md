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
    alerts.js        /api/monitor/alerts payload → normalized JSON + shape diagnostics
    poller.js        HTTP polling loop (metrics + alerts)
    cache.js         latest metrics snapshot; ACCUMULATING alerts buffer
    *.test.js        node --test, one file per module
  index.js           Entry point: wires poller → cache → HTTP server; holds the routes
  mock-server.js     Standalone mock: serves fixture data, no IRIS needed
  fixtures/          see fixtures/README.md for provenance — which are real captures
    metrics-live-capture.txt   real 313-line /api/monitor/metrics body (default mock)
    alerts-live-capture.json   real /api/monitor/alerts body
    metrics.txt      hand-trimmed 3-host excerpt (MOCK_FIXTURE=metrics.txt)
    alerts.json      hand-written; its field names do NOT match upstream
  .env.example       Environment variable template
  package.json
```

## Running

```bash
npm ci
npm run mock        # mock mode — no IRIS required, serves fixtures/
npm start           # real IRIS (needs .env)
npm test            # unit tests
```

### Pointing it at a real IRIS

`cp .env.example .env`, then set the connection to match the URL that works in your
browser. **The monitor API is not always at the web server root** — check which form
yours is:

| Browser URL that works | `.env` |
|---|---|
| `http://localhost:52773/api/monitor/metrics` | `IRIS_PORT=52773`, `IRIS_BASE_PATH=` |
| `http://localhost/iris4health_2024_1/api/monitor/metrics` | `IRIS_PORT=80`, `IRIS_BASE_PATH=/iris4health_2024_1` |

Getting `IRIS_BASE_PATH` wrong is quiet: the request lands on the web server's 404 page,
which parses as zero metric lines and reads as an idle production rather than a bad URL.
If `/proxy/metrics` reports `hostCount: 0` against a running production, suspect this
before suspecting the parser.

`/api/monitor/metrics` on the verified 2024.1 instance answers **without**
authentication, so a wrong password may not be what is failing.

### `/api/monitor/alerts` is consume-on-read — do not curl it casually

Reading that endpoint **clears** the alerts it returns; only `mgr/alerts.log` keeps them.
Anything else that reads it — a second proxy instance, a manual `curl`, the SMP — steals
alerts from the proxy, and they cannot be recovered. The proxy therefore accumulates
alerts in memory rather than replacing them each poll. See the note at the top of
`src/cache.js` and `fixtures/README.md`.

## Acceptance criteria (spec §4.3)

- Returns documented per-host JSON within 2 s of poll.
- Parser handles all 8 metric types.
- `/proxy/alerts` forwards `/api/monitor/alerts` JSON.

**"Handles all 8" cannot mean "always emits 8 values."** The verified 2024.1 instance
emits no `iris_interop_messages_errored` and no `iris_interop_last_activity` lines at
all — the families are absent, not zero. Every numeric field defaults to `null` and
`_meta.absentFamilies` names what IRIS did not send. Never default an absent metric to
`0`: it makes a rule structurally unable to fire while looking like a measurement. A
real measured zero (`messagesPerSec: 0` is emitted) must still read as `0`.
