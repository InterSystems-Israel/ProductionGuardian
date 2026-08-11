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
  mock-server.js     Standalone mock: serves fixture data, no IRIS needed — must match
                     index.js field for field (see Testing)
  smoke-test.js      HTTP checks against a running proxy; npm run smoke
  fixtures/          see fixtures/README.md for provenance — which are real captures
    metrics-live-capture.txt   real 310-line /api/monitor/metrics body (default mock)
    metrics-live-capture-preRename.txt  real, 313 lines, pre-rename host spellings
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
npm run smoke       # HTTP checks against a RUNNING proxy (mock or real)
```

### Pointing it at a real IRIS

`cp .env.example .env`, then set the connection to match the URL that works in your
browser. **The monitor API is not always at the web server root** — check which form
yours is:

| Browser URL that works | `.env` |
|---|---|
| `http://localhost:52773/api/monitor/metrics` | `IRIS_PORT=52773`, `IRIS_BASE_PATH=` |
| `http://localhost/iris4health_2024_1/api/monitor/metrics` | `IRIS_PORT=80`, `IRIS_BASE_PATH=/iris4health_2024_1` |

Getting `IRIS_BASE_PATH` wrong is quiet, and worse than a 404. Measured 2026-08-11:
omitting the prefix on port 80 reaches the **`%SYS` namespace's** `/api/monitor/` web app,
which answers **HTTP 200 with 906 lines of perfectly real metrics and not one
`iris_interop_*` family**. The poll succeeds, so nothing looks broken — you just get
`hostCount: 0`, indistinguishable from a stopped production. `/proxy/health` detects this
case by name and prints a `hint`; check it first, before suspecting the parser.

`/api/monitor/metrics` on the verified 2024.1 instance answers **without**
authentication, so a wrong password may not be what is failing.

## Testing

Three layers, cheapest first. All three verified green on 2026-08-11.

```bash
npm test            # 71 unit tests: parser, alerts, cache, poller. No network, no IRIS.
npm run mock &      # then, in the same or another shell:
npm run smoke       # 15 HTTP checks against whatever is on port 3001
```

`npm test` covers the modules in isolation, both fixture captures included.
`npm run smoke` covers what unit tests cannot: that the process starts, reaches IRIS, and
publishes a payload a consumer can actually use. It exits non-zero, so it can gate a demo,
and prints the values it saw — a green tick with no numbers is not evidence.

Run smoke in **both** modes; they catch different things:

| Mode | Command | Catches |
|---|---|---|
| Mock | `npm run mock` then `npm run smoke` | parser/route regressions, without needing IRIS |
| Real | `npm start` then `npm run smoke` | wrong `IRIS_BASE_PATH`, stopped production, credentials, a namespace with no interop |

The mock deliberately mirrors the real routes **field for field**, including `_meta` and
the health `hint`. Keep it that way: when the mock published a narrower `_meta` than the
live route, smoke passed against it while reporting `newInLastPoll: undefined` — the mock
was certifying a shape the real proxy does not serve, which is precisely what ADR 0004
exists to prevent. If you add a field to a route in `index.js`, add it to
`mock-server.js` in the same commit.

What smoke does **not** assert: which hosts exist. The production changes; the proxy is
correct as long as it reports what IRIS said. The only structural claim is that an
interop-enabled instance yields at least one host.

To confirm the failure detection actually works, misconfigure it on purpose:

```bash
IRIS_BASE_PATH=wrongprefix npm start   # note: no leading slash — Git Bash rewrites /wrongprefix
```

A wrong prefix 404s, so no poll ever completes: smoke fails 7 of 15 and exits 1, starting
with `a poll has completed — status: starting`. Drop `IRIS_BASE_PATH` entirely instead and
you get the 200-with-no-interop case, where health reports
`reachable, but no interop metrics` plus the `hint`. A test suite that has never been seen
to fail is not known to be testing anything — both of these were run, and the second one
found two real bugs in the smoke test itself.

Note the alerts count in smoke output is usually `0` against live IRIS even when
`alerts.log` holds entries — consume-on-read, see below. Smoke prints that explanation
rather than failing.

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
