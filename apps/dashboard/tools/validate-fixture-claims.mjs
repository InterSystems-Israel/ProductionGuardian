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
 * when it is not, so this stays useful in a dashboard-only checkout.
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

const thresholds = existsSync(THRESHOLDS)
  ? JSON.parse(readFileSync(THRESHOLDS, 'utf8'))
  : null;

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
  const expectRatio = () => (Number.isFinite(ratio) ? fromRatio(ratio, rule.severityBands) : 'critical');

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

let failures = 0;
for (const file of readdirSync(FIXTURES).filter((f) => f.startsWith('scenario-'))) {
  const scenario = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  const hostByName = new Map(scenario.hosts.map((host) => [host.host, host]));

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
}

if (failures > 0) {
  console.error(`\n${failures} finding(s) failed.`);
  process.exit(1);
}

/* Say which checks actually ran. Claiming "engine-emittable" when thresholds.json
   was absent would report a check that did not happen as a pass. */
console.log(
  thresholds === null
    ? 'All fixture findings are self-consistent.\nnote  no services/detection-engine/ checkout — the engine-emittable checks did NOT run'
    : 'All fixture findings are self-consistent and engine-emittable.',
);
