# CLAUDE.md — iris/ and services/metrics-proxy/ (Dev A)

This file governs everything under `iris/**` and `services/metrics-proxy/**`.
It supplements (and is subordinate to) the root `CLAUDE.md`.

---

## 1. Area ownership

Developer A owns:

| Path | Purpose |
|---|---|
| `iris/setup/` | One-time ObjectScript setup scripts for the demo namespace |
| `iris/labdemo/` | LABDEMO production class, HL7 generator, trigger toggles |
| `services/metrics-proxy/` | Node.js proxy: polls `/api/monitor/metrics` + `/api/monitor/alerts`, exposes per-host JSON |

Do **not** touch `services/detection-engine/`, `apps/dashboard/`, `contracts/` (read only), or any root config shared with other devs without a PR.

---

## 2. IRIS setup context

Interoperability metrics require two one-time calls in the demo namespace:

```objectscript
do ##class(Ens.Util.Statistics).EnableSAMForNamespace()
do ##class(Ens.Util.Statistics).EnableStatsForProduction()
```

`Ens.Activity.Operation.Local` must also be added to the production (provides `iris_interop_avg_processing_time`).

Verification: `iris_interop_queued` and `iris_interop_avg_processing_time` must appear in `/api/monitor/metrics` output.

---

## 3. LABDEMO production

Three application components. **The `<Item Name="...">` set in `iris/labdemo/Production.cls`
is authoritative** — do not maintain a second copy of the host list here, because a
duplicated list is exactly what went stale when `FHIR Transform` was removed.

Note the names carry a space (`EMR Source`, not `EMRSource`). The spaced form is what
appears in `/api/monitor/metrics`, in the proxy JSON, and in the dashboard, so use it
verbatim. Class names differ from config item names: the `Cloud API` item is
`ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation`.

`Ens.Activity.Operation.Local` is a fourth item, but it is framework plumbing for metrics
and the findings API filters it out — it is not an application host.

The synthetic HL7 generator (`iris/labdemo/HL7Generator.cls`) emits ADT^A01 messages on a
configurable interval. That is the only type it emits and the only type the routing rule
routes.

---

## 4. Metrics proxy conventions

- Language: **Node.js** (no transpilation; plain CommonJS).
- Port: **3001** (never change without updating `CLAUDE.md` in root).
- Poll `/api/monitor/metrics` every **10 s**; `/api/monitor/alerts` every **30 s**.
- Parser: use `prom-client` for model compatibility **or** a hand-rolled Prometheus text-format parser — keep it in `src/parser.js`.
- Output schema lives in `contracts/proxy-schema.json` (read-only after Day 1 freeze).
- Never hard-code credentials — use environment variables (`IRIS_HOST`, `IRIS_PORT`, `IRIS_USER`, `IRIS_PASS`, `IRIS_NAMESPACE`).

---

## 5. Running locally

```bash
# Start proxy against a real IRIS instance
cd services/metrics-proxy
cp .env.example .env   # fill in IRIS_HOST etc.
npm install
npm start

# Start proxy in mock mode (no IRIS required)
npm run mock
```

---

## 6. Dev A acceptance criteria (from spec §3)

1. Proxy returns documented per-host JSON within 2 s of poll.
2. Parser handles all 8 metric types listed in spec §1.3.
3. Each of the 8 finding types can be induced on demand via trigger toggles.
4. `/api/monitor/alerts` forwarded as JSON at `/proxy/alerts`.
