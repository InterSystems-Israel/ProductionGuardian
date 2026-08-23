/**
 * Check that no Architecture-slide label overlaps a node box.
 *
 * WHY THIS EXISTS. Two labels shipped sitting on top of node boxes — "investigate · resolve" across
 * "Detection engine", and "finding + snapshot" across "Authorization policy" — reported by
 * @Ari-Glikman as "there is things on top of other things". Both were positioned by eye by me, in
 * the same change that fixed the labels rendering at the origin. The type system was made to require
 * a position; nothing checked that the position was any *good*.
 *
 * So this is the third iteration of the same lesson on one component: a label with no coordinates is
 * a compile error, and a label with bad coordinates is now a build error too.
 *
 * PARSES THE JSX RATHER THAN IMPORTING THE COMPONENT, deliberately. The alternative — exporting a
 * layout table the component renders from — creates a second source of truth that can agree with
 * the test while disagreeing with the markup. The rendered attributes are what an audience sees, so
 * those are what get checked. The cost is a regex over source, which is why the patterns below are
 * anchored tightly and the script fails loudly if it finds nothing to check.
 *
 * Run by `npm run validate:architecture`, and by `npm run build` so a bad position cannot ship.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'src/components/ArchitectureView.tsx'), 'utf8');

/*
 * Character width for the 10.5px label face, and the ascent above the baseline.
 *
 * DELIBERATELY GENEROUS. 5.9px/char is wider than the average glyph in this family, and an
 * over-estimate is the safe direction: it can report a clash that is visually a near-miss, but it
 * cannot miss a real overlap. `text-anchor` is `start` for these labels (the CSS sets no anchor on
 * `.pg-arch__flow-label`), so the box grows rightward from `lx`.
 */
const CHAR_WIDTH = 5.9;
const ASCENT = 8;
const DESCENT = 2;

/** Every <Node .../> in one slide function, as a box. */
function nodesIn(body) {
  const out = [];
  const re = /<Node\s+x=\{(-?\d+)\}\s+y=\{(-?\d+)\}(?:\s+w=\{(\d+)\})?(?:\s+h=\{(\d+)\})?[^/]*title="([^"]*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const [, x, y, w, h, title] = m;
    // Defaults mirror the component's own: w = 132, h = 52.
    out.push({
      title,
      x0: Number(x),
      y0: Number(y),
      x1: Number(x) + Number(w ?? 132),
      y1: Number(y) + Number(h ?? 52),
    });
  }
  return out;
}

/** Every labelled <Flow .../> in one slide function, as a box. */
function labelsIn(body) {
  const out = [];
  const re = /<Flow\s+d="[^"]*"\s+label="([^"]*)"\s+lx=\{(-?\d+)\}\s+ly=\{(-?\d+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const [, label, lx, ly] = m;
    out.push({
      label,
      x0: Number(lx),
      y0: Number(ly) - ASCENT,
      x1: Number(lx) + label.length * CHAR_WIDTH,
      y1: Number(ly) + DESCENT,
    });
  }
  return out;
}

/** The body of one slide function, so labels are only checked against their own slide's nodes. */
function slideBody(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  // To the next top-level `function ` / `export function `, which is where the next slide begins.
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:export )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

function overlaps(a, b) {
  return !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
}

const SLIDES = ['Overview', 'Investigation'];
const problems = [];
let checked = 0;

for (const slide of SLIDES) {
  const body = slideBody(slide);
  if (body === null) {
    problems.push(`slide function ${slide}() not found — has this component been restructured?`);
    continue;
  }
  const nodes = nodesIn(body);
  const labels = labelsIn(body);

  // A silent pass because the regexes stopped matching would be worse than a failure, so the
  // structure itself is asserted.
  if (nodes.length === 0) problems.push(`${slide}: parsed no <Node> boxes`);
  if (labels.length === 0) problems.push(`${slide}: parsed no labelled <Flow> arrows`);

  for (const label of labels) {
    checked += 1;
    for (const node of nodes) {
      if (overlaps(label, node)) {
        problems.push(
          `${slide}: label "${label.label}" (x ${label.x0.toFixed(0)}–${label.x1.toFixed(0)}, ` +
            `y ${label.y0}–${label.y1}) overlaps node "${node.title}" ` +
            `(x ${node.x0}–${node.x1}, y ${node.y0}–${node.y1})`,
        );
      }
    }
    // Also outside the shared viewBox is a defect, and cheap to catch here.
    if (label.x0 < 0 || label.y0 < 0 || label.x1 > 640 || label.y1 > 360) {
      problems.push(
        `${slide}: label "${label.label}" falls outside the 640×360 viewBox ` +
          `(x ${label.x0.toFixed(0)}–${label.x1.toFixed(0)}, y ${label.y0}–${label.y1})`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('architecture layout: FAILED');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nMove the label into clear space rather than shortening it — the labels name the flows and ' +
      'are load-bearing for the slide.',
  );
  process.exit(1);
}

console.log(`architecture layout: ok (${checked} labels, no overlaps, all within the viewBox)`);
