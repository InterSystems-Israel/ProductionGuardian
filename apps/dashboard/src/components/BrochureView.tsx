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
 *
 * THE CARD IS A THUMBNAIL AND THE READER IS THE DELIVERABLE. `docs/Brochure.png` is
 * 1024×1536, and this card bounds it to 68vh — about 0.44 of its own width on a
 * 1024-high laptop, which reduces the body copy to unreadable grey. So the card's
 * only real job is "here is the brochure, open it", and it says so; the reading
 * happens in `BrochureLightbox`, which owns the zoom controls and the reasoning for
 * them. Nothing about the import-not-serve decision above changes — both render the
 * same inlined bytes from one import.
 */

import { useCallback, useRef, useState } from 'react';
import brochureUrl from '../../../../docs/Brochure.png';
import { BrochureLightbox } from './BrochureLightbox';

/* One description of the image, shared by the card and the reader. Two copies of alt
   text for one asset is two things to keep in agreement. */
const BROCHURE_ALT =
  'Production Guardian brochure: the eight planned modules and the product positioning.';

export function BrochureView(): JSX.Element {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  /* Focus returns to the button that opened the reader (§7.3). Held as a ref to the
     element rather than looked up by selector as `App.tsx` does for finding rows —
     that indirection exists because the list re-renders rows across polls and the
     drawer's opener may be replaced; this trigger is a single stable node in a view
     that does not poll, so the ref is both simpler and exact. */
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((): void => {
    setOpen(false);
    /* Deferred a frame for the same reason the drawer's is: the overlay is still
       mounted this tick and its focus trap would take the ring straight back. */
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  /* An image that cannot load has nothing to enlarge, so the reader closes with it and
     the view falls through to the message below. Both surfaces report into this one
     flag because they render one asset — a failure in either is the same fact. */
  const handleImageError = useCallback((): void => {
    setFailed(true);
    setOpen(false);
  }, []);

  return (
    <section className="pg-view" aria-labelledby="pg-brochure-heading">
      <div className="pg-view__head">
        <h2 id="pg-brochure-heading" className="pg-view__title">
          Brochure
        </h2>

        {/* In the head as well as on the image, because the image itself being the
            control is not discoverable — a labelled button is, and it is the tab stop
            that reaches the reader from the keyboard. Both call the same handler. */}
        {!failed && (
          <button
            ref={triggerRef}
            type="button"
            className="pg-button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
          >
            Enlarge and zoom
          </button>
        )}
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
          {/* A real `<button>` wrapping the image rather than an `onClick` on the
              `<img>` (§7.3): clicking the page is the gesture an audience expects, and
              a bare handler on an image is neither focusable nor Enter-activatable.
              Not a second TAB STOP though — `tabIndex={-1}`, so the labelled button
              above stays the single keyboard route in and a keyboard user does not meet
              two stops that do one thing.
              NOT `aria-hidden`, which was the first thing I wrote and was wrong: it
              would have removed the brochure's own alt text from the accessibility
              tree, so the one description of the asset would exist only for sighted
              users. Out of the tab order and still in the tree is the correct pair. */}
          <button
            type="button"
            className="pg-brochure__open"
            onClick={() => setOpen(true)}
            tabIndex={-1}
          >
            <img src={brochureUrl} alt={BROCHURE_ALT} onError={handleImageError} />
          </button>
        </div>
      )}

      {open && !failed && (
        <BrochureLightbox
          src={brochureUrl}
          alt={BROCHURE_ALT}
          onClose={close}
          onImageError={handleImageError}
        />
      )}

      <p className="pg-view__caption">
        Marketing material, not a specification. Where it and the shipped product
        disagree, the product and the contracts in <code>contracts/</code> are right —
        five of the eight modules shown here are not built.
      </p>
    </section>
  );
}
