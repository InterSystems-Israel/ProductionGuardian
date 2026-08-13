// Measure end-to-end detection latency against a running stack.
//
//   node tools/measure-latency.mjs [runs] [--engine URL]
//
// WHY A SCRIPT RATHER THAN A SEQUENCE OF COMMANDS. The clock has to start when the fault is
// injected and stop when the finding is visible, and BOTH have to happen inside one process.
// Driving the injection from an agent tool call adds ~15s of round trip to the measured
// interval, which is larger than the thing being measured -- that mistake invalidated the
// first figure on #44 and a later stopwatch reading on #67. Anything that measures this has
// to own both ends.
//
// WHAT IS MEASURED. Wall clock from "the fault exists in IRIS" to "the finding is readable
// from the findings API". That is proxy staleness + engine debounce, and it deliberately
// EXCLUDES the dashboard's own poll -- the dashboard adds [0, VITE_POLL_INTERVAL_MS) on top,
// which is bounded arithmetic rather than something worth sampling. Report both.
//
// PHASE STAGGERING. Injecting at a fixed offset in the proxy's poll cycle measures one
// favourable phase and calls it the distribution -- exactly the artifact that made an earlier
// set of numbers look better than the system was (#75). Each run therefore sleeps a fraction of
// the proxy interval first, so the samples spread across the cycle. Derived from the run index
// rather than Math.random(), so a re-run is comparable.
//
// The offsets are BIT-REVERSED rather than a linear ramp -- see the comment at the stagger. A
// ramp correlates run order with phase and produces a monotonic sequence that reads as a trend
// in the system when it is an artifact of the sweep.

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  // A trailing `--engine` with no value used to yield undefined and fail later inside fetch(),
  // with an error naming neither the flag nor the omission (@tanifgit, #83).
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value, e.g. ${name} http://localhost:3002`);
    process.exit(2);
  }
  return value;
};

const ENGINE = flag('--engine', 'http://localhost:3002');
// The proxy interval, used only to size the phase stagger. Read from the environment so this
// stays correct if compose changes it.
const PROXY_INTERVAL_MS = Number(process.env.METRICS_POLL_INTERVAL_MS ?? 2500);
const DASHBOARD_INTERVAL_MS = Number(process.env.VITE_POLL_INTERVAL_MS ?? 2000);

// NO HOST NAME HERE. Root CLAUDE.md §6: the `<Item>` set in Production.cls is authoritative and
// must not be restated -- a copied host list is what went stale when FHIR Transform was removed.
// A literal 'Cloud API' here would be a third copy in a third area, and `devA/labdemo-pipeline-simplify`
// is an open branch that RENAMES production items. The day it lands, every run would time out with
// "no dead_host within 60s", which reads as the product failing to detect rather than as a stale
// constant in the measuring tool (@tanifgit, #83).
//
// Matching on type alone is sufficient: reset() + waitForClear() guarantee an empty findings list
// before arming, so any dead_host inside the window is the one this run armed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Triggers are ObjectScript, so arming one means a session inside the container. `docker exec`
// is a LOCAL process spawn (~200ms), and crucially the clock starts AFTER it returns -- so the
// spawn cost is outside the sample rather than something to subtract.
import { spawn } from 'node:child_process';

// spawn with an explicit stdin.end(), NOT execFile's `input` option. With `input` the session
// opened and then hung until the timeout killed it -- stdout stopped at the bare `LABDEMO>`
// prompt and the process died on SIGTERM. The terminal reads interactively and needs stdin
// CLOSED before it will act on the trailing `halt`; writing then ending is unambiguous.
function irisSession(code) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', 'pg-iris', 'iris', 'session', 'IRIS', '-U', 'LABDEMO']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('iris session timed out after 60s'));
    }, 60_000);
    p.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    p.on('error', reject);
    p.stdin.write(code + '\nhalt\n');
    p.stdin.end();
  });
}

async function arm() {
  return irisSession('do ##class(ProductionGuardian.LabDemo.Triggers).DeadHost()');
}
async function reset() {
  return irisSession('do ##class(ProductionGuardian.LabDemo.Triggers).Reset()');
}

async function findings() {
  const res = await fetch(`${ENGINE}/api/healthscan/findings`);
  if (!res.ok) throw new Error(`findings -> HTTP ${res.status}`);
  return res.json();
}

async function waitForClear(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const f = await findings();
    if (f.length === 0) return true;
    await sleep(500);
  }
  return false;
}

/** Poll the findings API hard until dead_host appears, and return the elapsed ms. */
async function timeToDetect(t0, timeoutMs = 60_000) {
  const until = t0 + timeoutMs;
  while (Date.now() < until) {
    const f = await findings();
    if (f.some((x) => x.type === 'dead_host')) {
      return Date.now() - t0;
    }
    // 100ms so the sampling granularity is far below the thing measured. The findings API is
    // an in-memory read, so this costs the engine nothing meaningful.
    await sleep(100);
  }
  return null;
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: sum / s.length,
    median: s[Math.floor(s.length / 2)],
  };
};

console.log(`measuring ${runs} runs against ${ENGINE}`);
console.log(`proxy interval ${PROXY_INTERVAL_MS}ms, dashboard interval ${DASHBOARD_INTERVAL_MS}ms`);
console.log('clock: fault armed in IRIS -> dead_host readable from the findings API');
console.log('(dashboard adds [0, dashboardInterval) on top -- reported separately)\n');

const samples = [];
for (let i = 0; i < runs; i++) {
  // Start clean, or the finding from the previous run is still present and the next
  // measurement reads ~0.
  await reset();
  if (!(await waitForClear())) {
    console.log(`run ${i + 1}: findings did not clear, skipping`);
    continue;
  }
  // Let the baseline settle so the comparative rules are not warming. dead_host is absolute
  // and does not need it, but a warm baseline keeps the run representative of the demo.
  await sleep(8_000);

  // Phase stagger: DECORRELATE consecutive runs from the proxy's poll cycle.
  //
  // Not "sweep the cycle evenly", which an earlier version of this comment claimed and the
  // harness cannot deliver (@tanifgit, #83): the value below is an ADDED SLEEP, and the true
  // offset is that sleep plus uncontrolled variable time -- waitForClear polls at 500ms
  // granularity, then an 8s settle, then a variable-duration session spawn. So the offsets are
  // decorrelated, not controlled, which is all this needs to be. Also note runs is rounded up to
  // a power of two below, so for n=12 the four offsets at ==3 mod 4 are never drawn.
  //
  // A LINEAR RAMP IS NOT A STAGGER. Sweeping 0 -> interval in equal increments produced samples
  // that fell monotonically (10.67 -> 9.25 across 2143ms), which reads as a trend in the system
  // and is really just the ramp walking toward the next poll boundary in step with the runs.
  // Interleaving the offsets breaks that correlation while still covering the cycle evenly:
  // run order 0, 1/2, 1/4, 3/4, 1/8 ... via bit-reversal of the run index.
  const bitrev = (n, bits) => {
    let r = 0;
    for (let b = 0; b < bits; b++) if (n & (1 << b)) r |= 1 << (bits - 1 - b);
    return r;
  };
  const bits = Math.max(1, Math.ceil(Math.log2(runs)));
  const phase = Math.round((bitrev(i, bits) / (1 << bits)) * PROXY_INTERVAL_MS);
  await sleep(phase);

  await arm();
  // t0 AFTER arm() resolves, which is when `docker exec` CLOSES -- not when the trigger ran.
  //
  // BIAS, STATED RATHER THAN IMPLIED (@tanifgit, #83): the fault exists in IRIS from the moment
  // DeadHost() executes, which is before `halt`, process exit and the exec round trip. All of
  // that teardown sits outside the interval, so these samples are biased LOW and true latency is
  // >= reported. The direction is favourable to us, which is exactly why it needs saying: "9 of
  // 12 over the bar" is a FLOOR, not an estimate, and nobody should later argue these numbers
  // are pessimistic. Removing the bias means stamping t0 inside the session ($ZTIMESTAMP written
  // by the trigger) -- deliberately not done, because it would put a clock read in Triggers.cls
  // for the benefit of a measuring tool.
  const t0 = Date.now();
  const ms = await timeToDetect(t0);

  if (ms === null) {
    console.log(`run ${i + 1}: no dead_host within 60s (+${phase}ms sleep)`);
    continue;
  }
  samples.push(ms);
  const worst = ms + DASHBOARD_INTERVAL_MS;
  console.log(
    `run ${i + 1}: ${(ms / 1000).toFixed(2)}s to API` +
      `  (+dashboard worst case = ${(worst / 1000).toFixed(2)}s)` +
      `  +${phase}ms sleep`,
  );
}

await reset();
await waitForClear();

if (samples.length === 0) {
  console.log('\nno samples collected');
  process.exit(1);
}

const api = stats(samples);
// TWO on-screen figures, because one of them is not comparable to anything.
//
// The dashboard's contribution is uniform on [0, interval): a change can land just before its
// next poll or just after one. So:
//   - WORST CASE adds the full interval. It is the honest upper bound, and it is what a
//     "within 10s" criterion has to be judged against if the claim is to hold every time.
//   - EXPECTED adds half. This is what the ADR's existing figures effectively report, because
//     it measured the dashboard poll as an observed value (mean 1.03s at a 2s interval).
// Quoting worst case against the ADR's expected case would manufacture a regression out of a
// change of convention, which is the kind of comparison #63 was about.
const worst = stats(samples.map((x) => x + DASHBOARD_INTERVAL_MS));
const expected = stats(samples.map((x) => x + DASHBOARD_INTERVAL_MS / 2));
const overWorst = samples.filter((x) => x + DASHBOARD_INTERVAL_MS > 10_000).length;
const overExpected = samples.filter((x) => x + DASHBOARD_INTERVAL_MS / 2 > 10_000).length;

const f = (x) => (x / 1000).toFixed(2);
console.log(`\n--- to findings API (proxy staleness + engine debounce), n=${api.n} ---`);
console.log(`  min ${f(api.min)}  median ${f(api.median)}  mean ${f(api.mean)}  max ${f(api.max)}`);
console.log(`\n--- on screen, EXPECTED (+${DASHBOARD_INTERVAL_MS / 2}ms, half the poll) ---`);
console.log(
  `  min ${f(expected.min)}  median ${f(expected.median)}  mean ${f(expected.mean)}  max ${f(expected.max)}`,
);
console.log(`  over the 10s bar: ${overExpected} of ${api.n}`);
console.log(`\n--- on screen, WORST CASE (+${DASHBOARD_INTERVAL_MS}ms, a full poll) ---`);
console.log(
  `  min ${f(worst.min)}  median ${f(worst.median)}  mean ${f(worst.mean)}  max ${f(worst.max)}`,
);
console.log(`  over the 10s bar: ${overWorst} of ${api.n}`);
