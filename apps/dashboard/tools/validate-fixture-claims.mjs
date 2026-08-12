/**
 * Checks the two fixture claims the schema cannot: that each finding's numbers are
 * internally consistent, and that Dev B's engine would actually emit it.
 *
 *   node tools/validate-fixture-claims.mjs
 *
 * Schema validation (`validate-fixtures.mjs`) proves a fixture is *shaped* like the
 * contract. It cannot prove the fixture is *true*. Two failure modes live in that gap,
 * and both were real:
 *
 *   1. `message` is authoritative and rendered as-is (CLAUDE.md §2.4), so a message
 *      asserting "23x baseline" against numbers that divide to 8.9 puts a false
 *      sentence on a projector. Nothing else checks that arithmetic.
 *   2. A fixture can describe a finding the engine would never produce — below an
 *      absolute floor, or at a severity outside the configured band. That fixture
 *      claims the product behaves in a way it does not.
 *
 * Both checks reproduce the engine's own logic rather than approximating it: the
 * formatters from `detect/rules/types.ts` and the bands from `thresholds.json`.
 * Reproducing means this drifts if Dev B retunes, which is intended — a fixture that
 * silently stops matching the engine is the thing being guarded against.
 *
 * Thresholds are read from the detection-engine directory when present and skipped
 * when it is not, so this stays useful in a dashboard-only checkout. Pass `--strict`
 * to make that skip a failure instead: CI needs to know the check actually ran, and a
 * step that silently validates nothing is the failure mode this file exists to catch.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const THRESHOLDS = join(HERE, '..', '..', '..', 'services', 'detection-engine', 'thresholds.json');

/** Mirrors `formatRatio` in the engine: "48x" at or above 10, "3.8x" below. */
const formatRatio = (ratio) => (ratio >= 10 ? `${Math.round(ratio)}x` : `${ratio.toFixed(1)}x`);

/** Mirrors `severityFromRatio` — higher is worse. */
const fromRatio = (ratio, bands) =>
  ratio >= bands.critical ? 'critical' : ratio >= bands.warning ? 'warning' : 'info';

/** Mirrors `severityFromFraction` — lower is worse, e.g. throughput. */
const fromFraction = (fraction, bands) =>
  fraction <= bands.critical ? 'critical' : fraction <= bands.warning ? 'warning' : 'info';

const DEAD_STATUSES = ['Error', 'Inactive', 'Stopped', 'Disabled'];

/** The metric each per-host rule reads, so a finding can be checked against its host row. */
const METRIC_FOR = {
  queue_buildup: 'queued',
  throughput_drop: 'messagesPerSec',
  slow_processing: 'avgProcessingTime',
  growing_queue_wait: 'avgQueueingTime',
};

const STRICT = process.argv.includes('--strict');

const thresholds = existsSync(THRESHOLDS)
  ? JSON.parse(readFileSync(THRESHOLDS, 'utf8'))
  : null;

if (thresholds === null && STRICT) {
  console.error(`FAIL  --strict, but no thresholds at ${THRESHOLDS}`);
  console.error('        the engine-emittable checks cannot run, so this is a failure');
  process.exit(1);
}

/** Host overrides win over the base rule, exactly as `configFor` resolves them. */
function ruleFor(type, host) {
  if (thresholds === null) return null;
  return { ...thresholds.rules[type], ...(thresholds.hostOverrides?.[host]?.[type] ?? {}) };
}

/** Claims the message makes about its own numbers. */
function checkArithmetic(finding, host) {
  const problems = [];
  const { currentValue: current, baselineValue: baseline, message } = finding;

  const ratioClaim = message.match(/([\d.]+)x baseline/);
  if (ratioClaim !== null && typeof baseline === 'number' && baseline > 0) {
    const actual = formatRatio(current / baseline);
    if (actual !== `${ratioClaim[1]}x`) {
      problems.push(`message claims ${ratioClaim[1]}x, ${current}/${baseline} is ${actual}`);
    }
  }

  const percentClaim = message.match(/(\d+)% below baseline/);
  if (percentClaim !== null && typeof baseline === 'number' && baseline > 0) {
    const actual = Math.round((1 - current / baseline) * 100);
    if (actual !== Number(percentClaim[1])) {
      problems.push(`message claims ${percentClaim[1]}% below, arithmetic gives ${actual}%`);
    }
  }

  // A finding must agree with the host row it describes, or the drawer and the card
  // disagree about the same number on the same screen.
  const metric = METRIC_FOR[finding.type];
  if (metric !== undefined && host !== undefined && current !== host[metric]) {
    problems.push(`currentValue ${current} != host.${metric} ${host[metric]}`);
  }

  if (host !== undefined) {
    if (finding.type === 'dead_host' && !DEAD_STATUSES.includes(host.status)) {
      problems.push(`dead_host but host.status is "${host.status}"`);
    }
    if (finding.type === 'stalled_host' && host.queued <= 0) {
      problems.push(`stalled_host but host.queued is ${host.queued}`);
    }
  }

  return problems;
}

/** Would the engine, with its shipped thresholds, emit this finding as written? */
function checkEmittable(finding) {
  const rule = ruleFor(finding.type, finding.host);
  if (rule === null || rule.enabled === false) return [];

  const problems = [];
  const { currentValue: current, baselineValue: baseline, severity } = finding;
  const infinite = typeof baseline !== 'number' || baseline === 0;
  const ratio = infinite ? Number.POSITIVE_INFINITY : current / baseline;

  /*
   * An infinite ratio cannot be graded by a ratio band, and the two rule families
   * resolve it differently — so this cannot be one shared expression.
   *
   * The duration rules judge absolute magnitude against the floor:
   * `criticalFloorMultiple` x floor earns critical, above the floor alone is a
   * warning (Dev B's fbb34da, from the review on #20). `queue_buildup` still
   * hardcodes critical on that branch, which is defensible where the duration
   * version was not — a floor of 50 queued messages is a meaningful absolute
   * quantity, whereas 150ms of queue wait is not.
   */
  const expectRatio = () => {
    if (Number.isFinite(ratio)) return fromRatio(ratio, rule.severityBands);
    if (finding.type === 'slow_processing' || finding.type === 'growing_queue_wait') {
      return current >= rule.absoluteFloorSeconds * rule.criticalFloorMultiple
        ? 'critical'
        : 'warning';
    }
    return 'critical';
  };

  switch (finding.type) {
    case 'queue_buildup':
      if (current < rule.absoluteFloor) {
        problems.push(`depth ${current} is below absoluteFloor ${rule.absoluteFloor} — would not fire`);
      } else if (expectRatio() !== severity) {
        problems.push(`severity "${severity}", engine gives "${expectRatio()}"`);
      }
      break;

    case 'slow_processing':
    case 'growing_queue_wait':
      if (current < rule.absoluteFloorSeconds) {
        problems.push(
          `${current}s is below absoluteFloorSeconds ${rule.absoluteFloorSeconds} — would not fire`,
        );
      } else if (expectRatio() !== severity) {
        problems.push(`severity "${severity}", engine gives "${expectRatio()}"`);
      }
      break;

    case 'elevated_error_rate':
      if (current < rule.errorsPerMinuteFloor) {
        problems.push(
          `${current}/min is below errorsPerMinuteFloor ${rule.errorsPerMinuteFloor} — would not fire`,
        );
      } else if (expectRatio() !== severity) {
        problems.push(`severity "${severity}", engine gives "${expectRatio()}"`);
      }
      break;

    case 'throughput_drop': {
      if (typeof baseline !== 'number') break;
      if (baseline < rule.minBaselineRate) {
        problems.push(`baseline ${baseline} is below minBaselineRate ${rule.minBaselineRate} — would not fire`);
        break;
      }
      const fraction = current / baseline;
      if (fraction > rule.baselineFraction) {
        problems.push(
          `${current}/${baseline} = ${fraction.toFixed(2)} is above baselineFraction ${rule.baselineFraction} — would not fire`,
        );
        break;
      }
      const expected = fromFraction(fraction, rule.severityBands);
      if (expected !== severity) problems.push(`severity "${severity}", engine gives "${expected}"`);
      break;
    }

    case 'stalled_host':
      if (current < rule.inactiveSeconds) {
        problems.push(`idle ${current}s is below inactiveSeconds ${rule.inactiveSeconds} — would not fire`);
      }
      if (severity !== rule.severity) {
        problems.push(`severity "${severity}", engine gives "${rule.severity}"`);
      }
      break;

    case 'dead_host':
      if (severity !== rule.severity) {
        problems.push(`severity "${severity}", engine gives "${rule.severity}"`);
      }
      break;

    // system_alert's severity comes from the IRIS alert's own numeric level, which a
    // fixture is free to choose — nothing to check against thresholds.
    default:
      break;
  }

  return problems;
}

/**
 * Comparative rules return early when their baseline is null, so only the two
 * absolute rules can appear in a warm-up fixture. Without this, a warm-up scenario
 * can depict findings the engine is structurally incapable of producing.
 */
function checkWarmUp(finding) {
  if (finding.baselineValue !== null) return [];
  if (finding.type === 'dead_host' || finding.type === 'stalled_host') return [];
  if (finding.type === 'system_alert') return [];
  return [`${finding.type} is comparative, so it cannot fire with baselineValue null`];
}

/* ── The reverse direction ───────────────────────────────────────────────────────
 *
 * Everything above walks the FINDINGS and asks "would the engine emit this?". That
 * misses the opposite error: a host row the engine WOULD flag, with no finding for
 * it. A fixture like that understates the product — the grid shows a host quietly
 * breaching a rule and the findings list says nothing.
 *
 * It is the same class as the two checks Dev B added upstream: a check that gets
 * quietly weaker rather than failing. It went unnoticed because `dead-host`'s
 * 41.6s queue wait was already far above the old 1.0s floor and slipped through
 * anyway, so this was never really about the #20 retune.
 *
 * Baselines come from `scenario-healthy.json`, which `fixtures/README.md` declares
 * as the measured LABDEMO steady state every other scenario departs from. Deriving
 * them beats a table of host names in here — #19 removed a hardcoded host count for
 * exactly that reason, and a fourth copy of the host list is what went stale when
 * FHIR Transform was removed.
 */

/** Statuses `stalled_host` defers on, since a dead host is reported as dead. */
const RULES_REVERSE_CHECKED = [
  'dead_host',
  'stalled_host',
  'queue_buildup',
  'slow_processing',
  'growing_queue_wait',
  'throughput_drop',
];

/* Two rules cannot be judged from a single host row, and saying so beats implying
   coverage this does not have. `elevated_error_rate` compares errors-per-MINUTE
   derived across consecutive polls; `host.errored` is a cumulative counter and one
   snapshot cannot yield a rate. `system_alert` comes from the proxy's alerts
   payload, which a scenario file does not carry at all. */
const RULES_NOT_REVERSE_CHECKABLE = ['elevated_error_rate', 'system_alert'];

/** The healthy fixture IS the baseline, so its own rows must never breach. */
function baselineHosts() {
  const healthy = JSON.parse(readFileSync(join(FIXTURES, 'scenario-healthy.json'), 'utf8'));
  return new Map(healthy.hosts.map((host) => [host.host, host]));
}

/**
 * Which rules would fire for this host row — mirroring each rule's branches in
 * `detect/rules/index.ts`, in the same order, including the early returns.
 */
function wouldEmit(host, base, warming) {
  const hit = [];
  const rule = (type) => ruleFor(type, host.host);

  const deadHost = rule('dead_host');
  if (deadHost?.enabled !== false && DEAD_STATUSES.includes(host.status)) hit.push('dead_host');

  // stalled_host defers to dead_host — one condition, one finding.
  const stalled = rule('stalled_host');
  if (
    stalled?.enabled !== false &&
    !DEAD_STATUSES.includes(host.status) &&
    !(stalled.requiresQueued && host.queued <= 0) &&
    host.lastActivitySecondsAgo >= stalled.inactiveSeconds
  ) {
    hit.push('stalled_host');
  }

  // Everything below is comparative, so a warming baseline silences all of it.
  if (warming || base === undefined) return hit;

  /** Both gates, in the engine's order: the floor first, then the multiplier. */
  const overBoth = (current, baseline, floor, multiplier) => {
    if (current < floor) return false;
    const ratio = baseline > 0 ? current / baseline : Number.POSITIVE_INFINITY;
    return ratio >= multiplier;
  };

  const queue = rule('queue_buildup');
  if (
    queue?.enabled !== false &&
    overBoth(host.queued, base.queued, queue.absoluteFloor, queue.baselineMultiplier)
  ) {
    hit.push('queue_buildup');
  }

  for (const [type, metric] of [
    ['slow_processing', 'avgProcessingTime'],
    ['growing_queue_wait', 'avgQueueingTime'],
  ]) {
    const duration = rule(type);
    if (
      duration?.enabled !== false &&
      overBoth(host[metric], base[metric], duration.absoluteFloorSeconds, duration.baselineMultiplier)
    ) {
      hit.push(type);
    }
  }

  const throughput = rule('throughput_drop');
  if (
    throughput?.enabled !== false &&
    base.messagesPerSec >= throughput.minBaselineRate &&
    host.messagesPerSec / base.messagesPerSec <= throughput.baselineFraction
  ) {
    hit.push('throughput_drop');
  }

  return hit;
}

const BASELINE = baselineHosts();

let failures = 0;
for (const file of readdirSync(FIXTURES).filter((f) => f.startsWith('scenario-'))) {
  const scenario = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  const hostByName = new Map(scenario.hosts.map((host) => [host.host, host]));

  /*
   * `queued` and `errored` are nullable as of Q13, and this file mirrors the engine
   * with comparisons like `host.queued <= 0` — which `null` satisfies, silently
   * reading "depth unknown" as "nothing queued". Refuse the shape rather than judge
   * it wrongly: the engine's own null semantics are still undecided (PR #33), so
   * there is nothing faithful to mirror yet. Every fixture carries measured LABDEMO
   * values, so this is a tripwire for whoever adds the first null, not a live case.
   */
  for (const host of scenario.hosts) {
    for (const field of ['queued', 'errored']) {
      if (host[field] === null) {
        failures += 1;
        console.error(`FAIL  ${file} — ${host.host}.${field} is null`);
        console.error('        nullable counts are valid per the contract but not judgeable here');
      }
    }
  }

  for (const finding of scenario.findings) {
    const host = hostByName.get(finding.host);
    const problems = [
      ...(host === undefined ? [`host "${finding.host}" is not in this scenario's hosts`] : []),
      ...checkArithmetic(finding, host),
      ...checkWarmUp(finding),
      ...checkEmittable(finding),
    ];

    if (problems.length > 0) {
      failures += 1;
      console.error(`FAIL  ${file} — ${finding.id} ${finding.type} @ ${finding.host}`);
      for (const problem of problems) console.error(`        ${problem}`);
    }
  }

  // A fixture that declares itself warming must mean it — the reverse check silences
  // every comparative rule on the strength of this flag, so a wrong flag would hide
  // real omissions rather than report them.
  const warming = scenario.baselineWarming === true;
  if (warming) {
    const dated = scenario.findings.filter((f) => f.baselineValue !== null);
    if (dated.length > 0) {
      failures += 1;
      console.error(`FAIL  ${file} — baselineWarming is true but these carry a baseline:`);
      for (const f of dated) console.error(`        ${f.id} ${f.type} baselineValue ${f.baselineValue}`);
    }
  }

  if (thresholds !== null) {
    for (const host of scenario.hosts) {
      const present = new Set(
        scenario.findings.filter((f) => f.host === host.host).map((f) => f.type),
      );
      const missing = wouldEmit(host, BASELINE.get(host.host), warming).filter(
        (type) => !present.has(type),
      );

      if (missing.length > 0) {
        failures += 1;
        console.error(`FAIL  ${file} — ${host.host} breaches a rule with no finding to show it`);
        for (const type of missing) console.error(`        ${type} would fire, but no finding of that type names this host`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} finding(s) failed.`);
  process.exit(1);
}

/* Say which checks actually ran, and which rules the reverse direction cannot judge.
   Claiming "engine-emittable" when thresholds.json was absent would report a check
   that did not happen as a pass — and so would letting "no missing findings" imply
   all eight rules were swept when two of them cannot be. */
if (thresholds === null) {
  console.log('All fixture findings are self-consistent.');
  console.log('note  no services/detection-engine/ checkout — the engine-emittable checks did NOT run');
  console.log('note  the missing-finding sweep did NOT run either; it needs the same thresholds');
} else {
  console.log('All fixture findings are self-consistent and engine-emittable.');
  console.log(`      no host breaches a rule silently, across ${RULES_REVERSE_CHECKED.length} of the 8 rules`);
  console.log(`note  ${RULES_NOT_REVERSE_CHECKABLE.join(' and ')} are NOT swept — neither is derivable`);
  console.log('      from a single host row, so a fixture could omit one and this would not say so');
}
