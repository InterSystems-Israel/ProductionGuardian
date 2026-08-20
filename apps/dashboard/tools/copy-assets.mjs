/**
 * Copy the brochure into the built output as a served asset.
 *
 * WHY A SCRIPT RATHER THAN AN IMPORT. `docs/Brochure.png` is 1.7 MB, and this app builds with
 * `viteSingleFile()` -- an import would base64 it into `index.html`, adding roughly 2.3 MB to the
 * bundle and to first paint for a view most sessions never open. `BrochureView` fetches it from
 * `assets/brochure.png` instead, and this puts it there.
 *
 * WHY NOT A COMMITTED COPY IN `public/`. `docs/` is read-only source material (root CLAUDE.md §3),
 * and a committed second copy of a 1.7 MB binary is the #84 stale-copy pattern with no diff to
 * catch it drifting. Copying at build time means there is exactly one brochure in the repository.
 *
 * The destination path is duplicated in exactly one other place -- `BROCHURE_SRC` in
 * `src/components/BrochureView.tsx` -- and this script fails loudly if the source is missing, so a
 * moved or renamed original breaks the build rather than shipping a broken image.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Two candidate locations, checked in order, because this runs in two different layouts.
 *
 * A LOCAL `npm run build` sees the repository tree, so `docs/` is three levels up from here. Inside
 * the DOCKER BUILD the app is at `/app` and the Dockerfile stages the brochure at `/repo/docs/`,
 * because a `COPY` of the whole repository into the app directory would drag the other services and
 * the IRIS source into the image for one PNG.
 *
 * Probing beats an env var: nothing to set, nothing to forget, and a layout that matches neither
 * fails loudly below with both paths named.
 */
const CANDIDATES = [
  join(here, '..', '..', '..', 'docs', 'Brochure.png'),
  '/repo/docs/Brochure.png',
];

const SOURCE = CANDIDATES.find((candidate) => existsSync(candidate));
/** Must match `BROCHURE_SRC` in src/components/BrochureView.tsx. */
const DEST = join(here, '..', 'dist', 'assets', 'brochure.png');

if (SOURCE === undefined) {
  // Loud rather than skipped. A missing brochure that fails the build is a five-second fix; one
  // that silently produces a view with a broken image is found by whoever is presenting.
  console.error('copy-assets: Brochure.png not found. Looked in:');
  for (const candidate of CANDIDATES) console.error(`  ${candidate}`);
  process.exit(1);
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SOURCE, DEST);
console.log(`copy-assets: brochure -> dist/assets/brochure.png`);
