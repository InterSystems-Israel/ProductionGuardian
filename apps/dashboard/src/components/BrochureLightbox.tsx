/**
 * Full-screen brochure reader — the enlarge-and-zoom half of the Brochure view.
 *
 * AN OVERLAY RATHER THAN IN-PLACE ZOOM, and the deciding argument is geometry, not
 * taste. The brochure is a 1024×1536 portrait page rendered inside a card that sits
 * beside a 208px nav rail inside a padded content region — so in place, the widest
 * viewport it can ever have is a few hundred pixels narrower than the screen, and
 * panning it would mean a second scroll container nested inside the page's own. A
 * full-viewport overlay hands the page every pixel the presenter actually has, which
 * is the whole complaint: at 68vh the text is unreadable on a projector.
 *
 * Shaped after `FindingDetail` — `position: fixed`, `Esc` closes, focus returns to
 * the control that opened it — with one deliberate difference. That drawer is
 * `aria-modal="false"` because the operator must keep seeing the grid behind it.
 * This one IS modal (`aria-modal="true"` plus the focus trap below), because "give
 * the brochure the whole screen" means there is nothing behind it left to read, and a
 * `Tab` that walked into the dashboard underneath would leave focus somewhere the
 * presenter cannot see.
 *
 * ZOOM IS LAYOUT WIDTH, NOT `transform: scale()`. A transform does not change layout,
 * so a scaled image overflows a scroll container that does not know it grew: the
 * scrollable area stays the unscaled size and everything outside the transform-origin
 * corner is unreachable. Setting the image's width instead makes the stage's own
 * scrollbars exactly the right size, and native scrolling *is* the pan — wheel,
 * trackpad, scrollbar drag and the arrow keys, none of which a drag handler would have
 * given for free. No dependency either way (§3); this is the cheaper of the two.
 *
 * ZOOM IS A MULTIPLE OF THE STAGE WIDTH, NOT OF THE ASSET'S OWN PIXELS. A ladder
 * against the file's intrinsic 1024px would read as an honest "100% = 1:1", and would
 * also compile that number into the UI — the same class of staleness as a copied host
 * list (root `CLAUDE.md` §6). Against the stage, `1` means "as wide as the panel
 * allows" on a 1024-wide projector and a 2560-wide laptop alike, and the labels say
 * "width" rather than "%" so they are not claiming pixel fidelity they do not have.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconClose } from './icons';

/**
 * The zoom ladder, lowest first. Index 0 is fit-to-width and the ladder only climbs:
 * below fit-width the useful state is "the whole page at once", which is its own mode
 * rather than a rung.
 *
 * The multiplier is carried as a CLASS NAME, not a number. A number could only reach
 * CSS as an inline custom property, and nothing in this directory sets one — five
 * rules in `app.css` keep every dimension where the rest of them live (§9).
 */
const ZOOM_STEPS = [
  { label: 'Fit width', className: 'pg-reader__img--w1' },
  { label: '1.5× width', className: 'pg-reader__img--w15' },
  { label: '2× width', className: 'pg-reader__img--w2' },
  { label: '3× width', className: 'pg-reader__img--w3' },
  { label: '4× width', className: 'pg-reader__img--w4' },
] as const;

const TOP_STEP = ZOOM_STEPS.length - 1;

export interface BrochureLightboxProps {
  src: string;
  /** The same alt text the card uses — one description of the image, not two. */
  alt: string;
  onClose: () => void;
  /**
   * The image failed to load. Owned by the caller because the card and this overlay
   * render the same bytes, so a failure in either is the same fact about one asset.
   */
  onImageError: () => void;
}

export function BrochureLightbox({
  src,
  alt,
  onClose,
  onImageError,
}: BrochureLightboxProps): JSX.Element {
  /* Fit-to-width is the default. On the presenter's case — a tall portrait page on a
     1024px-high laptop — fitting the HEIGHT would render 1536px of page into ~900px of
     stage, i.e. 0.6x, barely better than the 68vh that made this unreadable in the
     first place. 1:1 would pin the page to 1024px and leave a 1920-wide screen half
     empty, so the first thing a presenter did would be to zoom in. Fit-width is the
     only default that is never smaller than the screen can show, and vertical scroll is
     the natural gesture on a page taller than it is wide. */
  const [step, setStep] = useState(0);
  const [wholePage, setWholePage] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  /* Focus lands on the SCROLLER, not on Close. At fit-width the page is taller than the
     stage before anything else happens, so panning is the first thing wanted, and arrow
     keys only pan once the scroll container itself holds focus. Close is last in the
     toolbar and the toolbar precedes the stage in the DOM, so a single Shift+Tab from
     here reaches it. */
  useEffect(() => {
    stageRef.current?.focus();
  }, []);

  /* Bound to the document rather than to the overlay, for both jobs:
       - `Esc` has to work wherever focus is, exactly as the drawer's does.
       - the trap has to be able to pull focus back IN. A handler on the overlay only
         sees keys pressed inside it, which is one browser quirk away from a `Tab`
         landing in the dashboard underneath and never coming back. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const root = overlayRef.current;
      if (root === null) return;

      /* Every focusable this component renders: the toolbar buttons and the stage.
         Queried at keypress rather than cached, because the zoom buttons disable and
         re-enable as the ladder is walked and a disabled button is not a tab stop. */
      const stops = Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'),
      );
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (active === null || !root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /* Zooming in from "whole page" enters the ladder at its bottom rung rather than
     remembering where it was: the two are different questions ("show me the shape" vs
     "let me read it"), and resuming at 4x from a fitted page is a jump nobody asked
     for. */
  const zoomIn = useCallback((): void => {
    setWholePage((page) => {
      if (!page) setStep((current) => Math.min(current + 1, TOP_STEP));
      return false;
    });
  }, []);

  const zoomOut = useCallback((): void => {
    setStep((current) => Math.max(current - 1, 0));
  }, []);

  const canZoomIn = wholePage || step < TOP_STEP;
  const canZoomOut = !wholePage && step > 0;

  const rung = ZOOM_STEPS[step] ?? ZOOM_STEPS[0];
  const level = wholePage ? 'Whole page' : rung.label;
  const imgClass = wholePage ? 'pg-reader__img--page' : rung.className;

  return (
    /* `aria-labelledby` points at the visible heading rather than repeating it as an
       `aria-label`, so the accessible name cannot drift from what is on screen — same
       reasoning as the drawer's. */
    <div
      ref={overlayRef}
      className="pg-reader"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pg-reader-title"
    >
      <header className="pg-reader__bar">
        <h2 id="pg-reader-title" className="pg-reader__title">
          Brochure
        </h2>

        <div className="pg-reader__controls">
          {/* The two fit modes are mutually exclusive, so they are the same
              `pg-toggle` + `aria-pressed` pattern the Architecture slide picker uses
              rather than a third way of saying "one of these". */}
          <div className="pg-toggle" role="group" aria-label="Brochure fit">
            <button
              type="button"
              className={`pg-toggle__option${wholePage ? '' : ' pg-toggle__option--active'}`}
              onClick={() => setWholePage(false)}
              aria-pressed={!wholePage}
            >
              Fit width
            </button>
            <button
              type="button"
              className={`pg-toggle__option${wholePage ? ' pg-toggle__option--active' : ''}`}
              onClick={() => setWholePage(true)}
              aria-pressed={wholePage}
            >
              Whole page
            </button>
          </div>

          {/* Words, not glyphs. A projector at the back of a room is the same reason
              severity carries a label beside its icon (§7.3), and "+"/"−" alone would
              also leave the buttons with no accessible name worth reading. */}
          <button type="button" className="pg-button" onClick={zoomOut} disabled={!canZoomOut}>
            Zoom out
          </button>

          {/* Announced, because a zoom step changes nothing else a screen reader would
              notice. Monospaced and min-width in CSS so stepping does not shift the
              buttons either side of it. */}
          <span className="pg-reader__level" aria-live="polite">
            {level}
          </span>

          <button type="button" className="pg-button" onClick={zoomIn} disabled={!canZoomIn}>
            Zoom in
          </button>

          <button type="button" className="pg-button" onClick={onClose}>
            <IconClose size={14} />
            Close
          </button>
        </div>
      </header>

      {/* `tabIndex` on a scroll container is what makes the arrow keys pan: a div that
          scrolls but cannot hold focus is mouse-only. `role="region"` so the label is
          announced rather than dropped on an unroled element. */}
      <div
        ref={stageRef}
        className="pg-reader__stage"
        role="region"
        aria-label="Brochure page — scroll, or use the arrow keys to pan"
        tabIndex={0}
      >
        <img className={`pg-reader__img ${imgClass}`} src={src} alt={alt} onError={onImageError} />
      </div>
    </div>
  );
}
