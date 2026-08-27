# Production Guardian — presenter cue sheet

**Every timing in this document was measured on the containerised stack on 2026-08-23, not estimated.**
Where a number is a range or an assumption, it says so.

This is the end-to-end flow: what to click, what to say, what the audience should see, and how long
to wait. It is written to be read *while presenting* — the prose is in the "say" column, the
mechanics are in the commands.

Read [`README.md`](../../README.md) first if the stack is not already up. This file assumes it is.

---

## 0. Before you present — the pre-flight

Do this **at least fifteen minutes before**, not on stage. Three of these five have bitten us.

```bash
export PG_AGENT_MODE=live          # else the agent serves a CANNED reply that looks correct
export PG_DEMO_TRIGGERS=1          # else the rail's trigger buttons do not exist
docker compose up -d
```

```powershell
# Windows. Set these in the SAME window as the compose up -- compose reads them from the shell.
$env:PG_AGENT_MODE = 'live'
$env:PG_DEMO_TRIGGERS = '1'
docker compose up -d
```

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | All four services healthy | `docker compose ps` | four `(healthy)` |
| 2 | **The agent is live, not canned** | `docker logs pg-detection-engine --tail 5 \| grep listening` | `agent=live`, `demo-triggers=ON` |
| 3 | Trigger buttons exist | `curl -s localhost:5173/api/demo/triggers` | `"enabled": true`, 3 scenarios |
| 4 | Nothing armed, no findings | `curl -s localhost:5173/api/healthscan/findings` | `[]` |
| 5 | **Error window is clean** | see below | `purged N` |

On Windows, checks 2–4 are `Select-String listening` rather than `grep listening`, and `curl.exe`
rather than `curl` — the alias `curl` resolves to in PowerShell binds `-s` to `-SessionVariable` and
then prompts for a `Uri`, which on stage reads as a hang. Full table: root `README.md` → *On Windows*.

```bash
# 5. Reset triggers AND purge the event log. Reset alone is not enough — see the trap below.
curl -s -XPOST -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{}' localhost:5173/api/demo/reset
docker exec -i pg-iris iris session IRIS <<'EOF'
zn "LABDEMO"
do ##class(Ens.Util.Log).Purge(.d, 0)
write "purged ",$get(d,0),!
halt
EOF
```

```powershell
# Windows. One line for the POST -- `--%` stops PowerShell parsing, so a backtick continuation
# would be sent as a literal character and the body would go out empty.
curl.exe --% -s -XPOST -H "Content-Type: application/json" -H "Origin: http://localhost:5173" -d "{}" localhost:5173/api/demo/reset

# PowerShell has no `<<'EOF'`. The equivalent is a SINGLE-quoted here-string, piped in:
@'
zn "LABDEMO"
do ##class(Ens.Util.Log).Purge(.d, 0)
write "purged ",$get(d,0),!
halt
'@ | docker exec -i pg-iris iris session IRIS
```

**`@'` and not `@"`, for the same reason the bash form quotes its `EOF`.** A double-quoted
here-string interpolates, and ObjectScript is made of `$`: measured on the running stack, `@"…"@`
sent `write "PGV|",$zversion,!` as `WRITE "PGV|",,!` — PowerShell had already replaced `$zversion`
with an empty string, and IRIS echoed a syntactically valid line that printed nothing. That is the
worst kind of failure to hit on stage, because the here-string above would purge nothing and still
look like it ran. The `@'` form passed `$zversion` through untouched and IRIS answered with the
build. Two layout rules the parser enforces: `@'` must end its line, and `'@` must start its own
line at **column 0** — indent it and PowerShell does not see the terminator.

### The traps, in the order they will bite you

1. **`AGENT_MODE` defaults to `mock`.** A canned investigation is built from *real measured values*, so
   it reads as correct and demonstrates nothing about the agent. Check `source: "agent"` and a
   non-zero `toolCalls` in any investigation — those two cannot be faked. This is the standing
   pre-demo check and it has caught a real regression.
2. **`Reset()` cannot clear the event log** — and note it is now the *only* error store it cannot
   clear, which is why this trap is easy to talk yourself out of. Reset purges the MESSAGE store, so
   the error count on a host tile does return to 0. The EVENT LOG is a different table: a previous
   scenario's errors stay in the 60-minute window and a later diagnosis reads them as evidence. That
   is exactly how a pool bottleneck got diagnosed as a connectivity failure. So a clean tile does not
   mean clean evidence — **always purge** (step 5).
3. **Restarting the `iris` container disarms triggers.** Recompiling `Production.cls` resets its item
   settings, so `FilePath` and `PoolSize` revert. Re-arm after any restart; the rail shows live state.
4. **`Cloud API` may be left at pool 4** from a previous run of the Smart Resolve beat. `Reset()`
   restores it to 1. If the queue never builds, check this first.
5. **Never `curl /api/monitor/alerts`.** It is consume-on-read — reading it destroys the alert the
   `system_alert` path depends on. Use `:3001/proxy/alerts`.
6. **Reset all empties the Message Viewer, whenever a scenario errored.** Clearing the per-host error
   count means deleting message rows — that count is a `COUNT(*)` over `Ens.MessageHeader`, so nothing
   restorable moves it — and `Ens.Purge` has no status filter, so it cannot delete only the errored
   ones. Measured: **2,550 headers removed to clear 21 errored.** The completed traffic goes with them,
   and how much survives depends on which sessions happened to be in flight, not on anything you can
   plan. **So if a later beat needs the Message Viewer populated, show it before you reset.** A reset
   with nothing errored skips the purge entirely and leaves history alone.
7. **Reset all restarts the baselines, so nothing comparative fires for about a minute.** This is
   deliberate — a load step-down is not a fault, and after a reset the engine genuinely does not know
   what normal is yet — but it means *reset, arm, expect a finding* looks broken for the first ~60s
   (`minBaselineSamples` × the shipped poll interval; both live in `services/detection-engine/`, so
   check there rather than trusting this number). `queue_buildup`, `throughput_drop`, `slow_processing`
   and `growing_queue_wait` are all comparative and all silent in that window; `dead_host` is absolute
   and unaffected, which makes it the safe thing to arm first. **The reliable signal that the wait is
   over is Early Warning: it says "Baseline still warming — no projection yet" until it is.**

**Open two browser tabs before you start:** `http://localhost:5173` (the dashboard) and the
Management Portal link from its header (the IRIS interoperability editor). Switching tabs is faster
than finding a URL on stage.

---

## The shape of the story

Three acts, each answering a different question. **Acts 1 and 2 are the demo**; act 3 is the one
people ask for afterwards.

| Act | Question | Beat | Wall clock |
|---|---|---|---|
| **1** | *Does it see the problem?* | WHAT | ~2 min |
| **2** | *Does it understand and fix it?* | WHY → FIX | ~6 min |
| **3** | *What if there is no button to press?* | the honest answer | ~2 min |

Total ≈ 10 minutes of demo. Budget 15 with questions.

Act 2 was ~4 min until 2026-08-27, on the assumption that the drain beat ended when the queue hit
zero. Re-measured, the last finding takes ~200s rather than ~103s to age out — see §2.3. The number
here is the one that matters for a slot, so it follows the measurement rather than the intent.

---

## Act 1 — WHAT: a healthy production, then a real fault

### 1.1 Start on the healthy state (30s)

**Say:** *"This is a live InterSystems Health Connect production — three interoperability hosts moving
HL7 messages. Everything is green. Production Guardian is watching it, and the important thing right
now is that it is quiet."*

**Show:** the host grid, ordered as the message flows — **EMR Source** (service) → **Lab Router**
(process) → **Cloud API** (operation). Zero findings. Under each host, Early Warning says
*"Watching — not trending toward a threshold."*

> **Why that matters:** a monitoring tool that is silent when nothing is wrong is the whole point.
> False positives are the top risk this product was designed against, so a quiet list is a feature.

### 1.2 Break something real (45s)

Click **Pool bottleneck** in the rail under *Demo triggers*.

**Say while it warms:** *"I have just throttled the downstream system this production talks to, and
raised the inbound rate. Nothing is broken — the host is healthy, it is simply outnumbered. This is
the most common real-world failure and the hardest to see, because every individual message succeeds."*

| t | What happens |
|---|---|
| 0s | Button returns immediately; shows *activating* |
| **~77s** | Takes effect — measured 77s. It warms a baseline at zero first |
| ~90s | Queue starts climbing, ~1/sec net |
| ~2min | First findings confirmed |

> **Do not skip the 77 seconds and do not fill it with silence.** The wait exists for a real reason and
> it is worth saying out loud: *"it is establishing what normal looks like before I break anything —
> a baseline learned during a fault is worthless."* That line lands well with a technical audience.

### 1.3 The findings arrive (60s)

**Measured, from a clean instance:**

```
queue_buildup       critical   Queue depth 123 with no baseline queue
growing_queue_wait  critical   Average queue wait 37.66s is 1883x baseline
```

**Say:** *"Two findings, and each states the actual number — not 'queue is high'. 37 seconds of
queue wait against a normal of hundredths of a second. And notice the host still reports its status
as OK, because it is: the process is running fine. The finding carries the alarm, not the status."*

> **This was three findings until 2026-08-27**, the third being
> `slow_processing critical Average processing time 1.01s is 20x baseline`. It was removed by
> raising `Cloud API`'s processing-time floor to 1.5s, because **that 1.01s is the same before and
> after the fix** — the throttled downstream takes ~1s per call whether one worker or four are
> waiting on it, so the finding survived Act 2.3 and read on stage as *"the fix didn't fully
> work"*. Both findings that remain are about **queueing**, which is exactly what the fix
> addresses, so the board now empties completely. If someone asks why a 1s downstream call is not
> itself reported: that floor is a deliberate tolerance for an outbound operation, recorded in
> `thresholds.json`, and the honest answer is that Guardian treats ~1s per remote call as this
> host's normal.

**Show:** the severity tiles. **Hosts OK now reads 2 of 3**, not 3 — a host with a critical finding is
not counted as OK. Click the host to filter the findings to it and open its live graphs.

> **If asked "how fast?":** ~10s from a metric changing to a finding appearing, and the dashboard polls
> every 2s. There is a deliberate two-sample debounce so a single bad scrape cannot produce a finding.

---

## Act 2 — WHY and FIX: the closed loop

This is the act that sells the product. Do not rush it.

### 2.1 Ask the AI Detective (90s)

Click a finding → **Investigate**.

**Say while it thinks (~6-8s):** *"This is not a chatbot summarising a dashboard. There is an agent
running **inside** the IRIS instance, and it is reading live values through governed tools — checking
the host's status, its queue depth, its configuration, its recent error history. Every one of those
reads is authorization-checked and written to an audit trail."*

**Measured:** `source: agent`, `model: gpt-4o-mini`, `toolCalls: 2`, `durationMs: 5828`.

```
rootCause: "The Cloud API host is currently configured with a pool size of 1, which severely
            limits its ability to process incoming messages..."
recommendedAction: {"type": "set_pool_size", "host": "Cloud API", "size": 4}
```

**Point at the provenance line.** *"`source: agent`, two tool calls. If this said `canned` it would be
a scripted answer built from real numbers — plausible, and proving nothing. Those two fields are how
you tell."*

> **The strongest thing to say here, and it is true:** *"Nothing about pool size is in the agent's
> instructions beyond which action it is permitted to suggest and the allowed range. It worked out the
> bottleneck itself from the evidence it gathered."*

> **And point at the NUMBER, not just the recommendation.** It does not double the pool — it sizes it.
> One message per second at ~1s of work each means one worker is exactly break-even, so a pool of 2
> would hold the queue steady forever and never clear it. Four drains it. The agent states that
> arithmetic in its own evidence, so you can read the working off the screen rather than asserting it.
> *"It picked a number it can defend"* is a stronger claim than *"it noticed a problem"*.

### 2.2 Preview, then approve (60s)

**Say:** *"It has recommended a change to a live production. It cannot make that change. A human has
to approve it, and before approving you get a dry run."*

**Show** the dry run: `outcome: previewed`, `before: {"poolSize": 1}` — and note it returns *before*
any write happens.

Then approve. **Measured:** `outcome: applied`, `reversal: {"host": "Cloud API", "size": 1}`.

**Say:** *"Applied, and the previous value was captured live so it is reversible. Both the preview and
the apply are in the audit trail as separate rows."*

### 2.3 Watch it drain — the money shot (~3.5 min)

**Measured drain, pool 1 → 4** (re-measured end to end on 2026-08-27):

```
t+0s     queued=157   2 findings
t+54s    queued=49    2 findings
t+72s    queued=10    1 finding    <- queue_buildup clears
t+90s    queued=0     1 finding    <- the QUEUE is gone here
t+182s   queued=0     1 finding    growing_queue_wait "340ms is 17x baseline"
t+202s   queued=0     0 findings   <- the BOARD is clean here
```

**The queue empties at ~90s; the board takes until ~200s, and the gap is not a bug.**
`growing_queue_wait` is an *average* over a window that still contains the backlog, so it decays
rather than dropping. Verified it then held at zero findings for a further 200s. The old version of
this block collapsed both into one line (`t+103s queued=0 <- findings clear on their own`), which
sets a presenter up to say "cleared" while one finding is still on screen.

**Say at ~90s:** *"Queue's at zero."* **Then, while the last finding decays:** *"Four workers now,
so the downstream waits overlap. That one remaining finding is an average — it still has the
backlog in its window, and it will age out rather than being switched off. Which is the point:
the findings disappear when the condition does. No acknowledging, no clearing, no tombstones. If
it is still listed, it is still true."*

> **The board really does reach zero now, and that is new.** Until 2026-08-27 a third finding —
> `slow_processing`, on the same host — survived this beat forever, because the throttled downstream
> takes ~1s per message whether one worker or four are waiting on it. Raising `Cloud API`'s
> processing-time floor to 1.5s removed it (Act 1.3 has the detail). If you are presenting from an
> older build and see a stuck `slow_processing critical`, that is what it is — say the fix addressed
> the backlog and the downstream is still a second per call, which is true and on-message.

> **Fill the time** with the safety model — it is the right moment because they have just watched
> an AI change a production:
> - **one** action, **one** host, bounded 2–8 — anything else is refused by name
> - dry run first, and that path returns before writing
> - reversible, with the prior value captured live
> - RBAC-gated, so the investigating agent **cannot** call the write tool at all
> - every call audited, reads included — and *refusals are audited too*
> - **metrics and configuration only ever leave the instance. Never message content. Never PHI.**

---

## Act 3 — the honest answer: a fault with no button

The single most credible thing in the demo. It shows the product knows its limits.

Reset first (`Reset all`), then click **Missing directory**.

**Measured:** `dead_host` appears at **t+12s**.

**Say:** *"Different fault. A service is configured to read from a directory that does not exist. Watch
what the AI does with it."*

Investigate. **Measured:** `source: agent`, `toolCalls: 2`, ~7s.

```
recommendedAction: null
manualRemediation: "Correct the missing directory and invalid production setting."
```

**Say, slowly:** *"No approve button. There isn't one, because creating a directory on a server is not
something this system is permitted to do — so it tells you what to do instead, and says plainly that a
person has to do it. A product that offered a button here would be lying to you."*

> **If asked how it knows the path:** from the host's **configuration**, never from the log. Error text
> can contain patient data, so the tool returns a fixed catalogue string keyed by error code —
> `#5021` → *"a configured directory or file path does not exist"* — and the path itself comes from the
> configuration, which is not message content.

---

## Optional beats — for questions, not the main line

### Ask the activity assistant

**Say:** *"There are three activity tables in IRIS holding days of per-host history. You can just ask."*

```
"which host has the worst queueing time?"
  -> "The host with the worst queueing time is the Cloud API, with an average queueing time of
      27.92 seconds over the last 3 days."       (measured: source agent, 2 tool calls)
```

### The architecture slides and the brochure

Rail → **Architecture** (two slides) and **Brochure**. Both static; no setup, no risk. Good filler if
something upstream is slow.

### Downstream unreachable — if someone asks "what if the target is down?"

Click **Downstream unreachable**. It produces four finding types at once, and the interesting part is
what the AI does **not** recommend: it declines the pool increase, because more workers failing to
reach a closed port is just a faster failure. That distinction is enforced in code, not left to the
model's judgement.

---

## Recovery — when something goes wrong on stage

| Symptom | Cause | Fix |
|---|---|---|
| Investigation says `source: "canned"` | `PG_AGENT_MODE` not `live` | Can't fix live. **Say it is demo mode** and continue — the loop still works |
| Investigation returns `state: unavailable`, `rootCause: null` | LLM key wrong or expired | The FIX half does not use the LLM, so demo that instead |
| Trigger buttons missing from the rail | `PG_DEMO_TRIGGERS` unset | Drive from the terminal instead (see README) |
| Queue never builds | `Cloud API` already at pool 4 | `Reset all` |
| A connectivity diagnosis on a queue problem | Stale errors in the window | Purge the log (pre-flight step 5) |
| Everything looks stale | Engine can't reach the proxy | Banner says `stale` — it degrades rather than blanking. Say so; it is a feature |
| Whole stack unavailable | — | `apps/dashboard/dist/index.html` opens from `file://` in demo mode with fixture data |

**The general rule: if something is wrong, say what is wrong.** This product's whole argument is that
it tells you the truth about a production. Narrating a real failure honestly is on-message; pretending
is not.

---

## Between rehearsals

```bash
curl -s -XPOST -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{}' localhost:5173/api/demo/reset
docker exec -i pg-iris iris session IRIS <<'EOF'
zn "LABDEMO"
do ##class(Ens.Util.Log).Purge(.d, 0)
do ##class(ProductionGuardian.LabDemo.Audit.Entry).Purge()
halt
EOF
```

```powershell
curl.exe --% -s -XPOST -H "Content-Type: application/json" -H "Origin: http://localhost:5173" -d "{}" localhost:5173/api/demo/reset
@'
zn "LABDEMO"
do ##class(Ens.Util.Log).Purge(.d, 0)
do ##class(ProductionGuardian.LabDemo.Audit.Entry).Purge()
halt
'@ | docker exec -i pg-iris iris session IRIS
```

Single quotes on the here-string, and `'@` at column 0 — §0 says why.

Purging the audit log is optional but makes "six rows for six tool calls" legible on the next run.

---

## Known rough edges — say these plainly if asked

Being straight about these is more persuasive than hoping nobody notices.

- **`auditId` is `null` in the resolve response** even though the audit rows *are* written (verified:
  rows 360 and 361 for a dry run and an apply). The trail is complete; the response just doesn't
  point at it.
- **RBAC is not exercised by the running stack.** The services connect as a `%All` user, so every audit
  row reads `SuperUser` and the authorization policy never actually refuses. The policy is real and
  refuses a genuinely low-privileged caller — but the deployed demo does not show that boundary firing.
- **`stalled_host` cannot be induced.** Both ways of stopping a host consuming its queue put it into a
  status the rule declines for. A gap in demo coverage, not a defect in the rule.
- **`system_alert` outlives `Reset()`** — the alert sits in the metrics proxy's in-memory buffer, which
  IRIS cannot reach. Restart the proxy to clear it.
- **One scenario, one action.** `set_pool_size` on `Cloud API` within 2–8 is the *only* thing this
  system can change. That is deliberate — a general action catalogue is later work, and the safety
  argument depends on the boundary being narrow.
- **A newly added host shows as `unknown` type** until it processes its first message, because the type
  label only appears on per-message-type metrics.
