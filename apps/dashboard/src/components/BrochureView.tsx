/**
 * The brochure — a served image, not a bundled one.
 *
 * `docs/Brochure.png` is 1.7 MB. Importing it would put it through Vite's asset pipeline and, with
 * `viteSingleFile()` inlining everything into one document (CLAUDE.md §6), base64 it straight into
 * `index.html` — roughly 2.3 MB added to the bundle and to first paint, for a view most sessions
 * never open. So it is fetched from `/assets/` on demand and the menu item is not the reason the
 * dashboard gets slower to load.
 *
 * THE FILE//: FALLBACK CANNOT SERVE IT, and that is stated rather than hidden. The single-file
 * artefact is meant to run from a local file with no server; a relative fetch of a 1.7 MB PNG has
 * nothing to fetch from. `onError` therefore renders where the original lives instead of a broken
 * image icon — the demo fallback is for the findings view, and this one degrades honestly.
 *
 * NOT COPIED INTO THE REPO. `docs/` is read-only source material (root `CLAUDE.md` §3), so the
 * asset is copied at build time by a script rather than duplicated into `public/`. A committed
 * second copy of a 1.7 MB binary is the #84 stale-copy pattern with no diff to catch it.
 */

import { useState } from 'react';

/**
 * Where the built asset lands, relative to the served document.
 *
 * One literal in one file. `tools/copy-assets.mjs` writes to the matching path and its header names
 * this constant, so the two cannot drift without the build failing to produce what this fetches.
 */
const BROCHURE_SRC = 'assets/brochure.png';

export function BrochureView(): JSX.Element {
  const [failed, setFailed] = useState(false);

  return (
    <section className="pg-view" aria-labelledby="pg-brochure-title">
      <h2 id="pg-brochure-title" className="pg-view__title">
        Production Guardian — brochure
      </h2>

      {failed ? (
        <div className="pg-view__fallback">
          <p>
            The brochure image could not be loaded. It is served from{' '}
            <span className="pg-facts__mono">{BROCHURE_SRC}</span>, which needs the dashboard to be
            served over HTTP — the single-file <span className="pg-facts__mono">file://</span>{' '}
            fallback has no server to fetch it from.
          </p>
          <p className="pg-investigate__note">
            The original is <span className="pg-facts__mono">docs/Brochure.png</span> in the
            repository.
          </p>
        </div>
      ) : (
        <img
          className="pg-brochure"
          src={BROCHURE_SRC}
          /* Descriptive rather than "Brochure": a screen reader user gets no value from the image
             itself, so the alt text says what it is and where the readable version lives. */
          alt="Production Guardian product brochure. The text is not machine-readable here; docs/Brochure.png is the source."
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </section>
  );
}
