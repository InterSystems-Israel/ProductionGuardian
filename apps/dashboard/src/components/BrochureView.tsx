/**
 * The product brochure, for showing an audience what the product claims.
 *
 * IMPORTED RATHER THAN SERVED, and that reverses what the MVP 3 spec §3.1
 * recommended. The spec said serve it as a static asset so 1.7 MB never lands in
 * the bundle. That is the right instinct and the wrong call for this deployment,
 * established by reading it rather than assuming:
 *
 *   - `docker-compose.yml` builds this image with `context: ./apps/dashboard`, so
 *     `docs/Brochure.png` is outside the build context and cannot be copied in.
 *   - `Dockerfile`'s runtime stage copies `dist/index.html` and nothing else — by
 *     design, "the output is one HTML file plus an nginx config". A `public/` asset
 *     would be built into `dist/` and then not shipped, so the served dashboard
 *     would 404 it.
 *   - `vite-plugin-singlefile` exists so `dist/index.html` opens from `file://`
 *     (CLAUDE.md §6). A separate asset breaks that promise too.
 *
 * So serving it would mean committing a duplicate 1.7 MB binary AND changing the
 * Dockerfile AND weakening the single-file fallback. Importing it keeps one copy,
 * one artefact, and both delivery paths working. The cost is bundle size, measured
 * and recorded in the PR rather than guessed at.
 *
 * The asset still lives in `docs/` — read-only source material (root `CLAUDE.md`
 * §3) — and is referenced across the directory boundary rather than copied, so
 * there is no second file to go stale.
 */

import { useState } from 'react';
import brochureUrl from '../../../../docs/Brochure.png';

export function BrochureView(): JSX.Element {
  const [failed, setFailed] = useState(false);

  return (
    <section className="pg-view" aria-labelledby="pg-brochure-heading">
      <div className="pg-view__head">
        <h2 id="pg-brochure-heading" className="pg-view__title">
          Brochure
        </h2>
      </div>

      {failed ? (
        /* Degrade visibly, never blank (§7.3). The image is inlined, so this should
           be unreachable — which is exactly why it says where the original is
           rather than just apologising. */
        <p className="pg-view__caption">
          The brochure image could not be loaded. The original is{' '}
          <code>docs/Brochure.png</code> in the repository.
        </p>
      ) : (
        <div className="pg-brochure">
          <img
            src={brochureUrl}
            alt="Production Guardian brochure: the eight planned modules and the product positioning."
            onError={() => setFailed(true)}
          />
        </div>
      )}

      <p className="pg-view__caption">
        Marketing material, not a specification. Where it and the shipped product
        disagree, the product and the contracts in <code>contracts/</code> are right —
        five of the eight modules shown here are not built.
      </p>
    </section>
  );
}
