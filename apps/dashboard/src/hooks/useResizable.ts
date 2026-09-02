/**
 * Drag-to-resize, for the nav rail and the right-hand drawer.
 *
 * ONE HOOK FOR BOTH, because the two differ in exactly two ways — which custom property they drive
 * and which side the handle sits on — and everything with a decision in it is shared: the clamp, the
 * pointer capture, the keyboard fallback, and remembering the width. Two copies of that would drift,
 * and the half that drifts is always the keyboard half.
 *
 * THE WIDTH IS WRITTEN TO A CUSTOM PROPERTY ON <html>, NOT AS AN INLINE `width` ON THE PANEL. Both
 * targets already resolve theirs from a token and neither would obey an inline width correctly:
 *
 *   - the rail is a GRID COLUMN on `.pg-shell` (`grid-template-columns: var(--pg-rail-width) …`), so
 *     a width on the rail element itself does nothing at all;
 *   - `.pg-drawer` narrows to `min(var(--pg-drawer-width), 60vw)` under 1100px, and an inline width
 *     would override that clamp and cover the grid on a 1024px laptop — defeating the reason it is a
 *     drawer and not a modal.
 *
 * Overriding the variable leaves every existing rule, including the responsive one, in charge of how
 * the number is used. Same arrangement as `data-theme` (`lib/theme.ts`): the only thing JS decides is
 * a value, and CSS decides what it means.
 *
 * THE DEFAULT, MINIMUM AND MAXIMUM ARE ALSO TOKENS, read back off the document rather than written
 * here. They are geometry, so §9 puts them in `tokens.css`; reading them is what makes the reset
 * target unable to disagree with the width the page loads at, which is exactly the duplication that
 * keeps going stale in this repo. The read is cached per property and taken during the FIRST render,
 * before this hook has written anything — after that the computed value is our own override rather
 * than the token, so a later read would return whatever the operator last dragged to.
 *
 * POINTER CAPTURE RATHER THAN WINDOW LISTENERS. `setPointerCapture` routes every later move to the
 * handle even once the cursor has left it — which is the normal case while dragging — and the browser
 * releases it implicitly on `pointerup`. Nothing is attached to `window`, so there is no listener to
 * leak and no drag that can outlive the element it started on.
 *
 * A DRAG-ONLY CONTROL WOULD NOT MEET THE BAR (§7.3). The handle is a focusable `separator` — the ARIA
 * window-splitter pattern, which is why this one control is not a `<button>` — and it answers the
 * arrow keys, Home/End, and Enter/Space to reset, so both panels are resizable without a mouse.
 *
 * THE VARIABLE IS NEVER CLEANED UP ON UNMOUNT, DELIBERATELY. All three right-edge panels
 * (`FindingDetail`, `HostDetail`, `ThresholdSettings`) are mutually exclusive by construction and
 * share `--pg-drawer-width`, so the width has to survive one closing and the next opening. Each
 * mount re-reads the same remembered value, so they cannot disagree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

/**
 * Which edge of the panel the handle sits on, which is the same thing as the sign of a drag: a
 * handle on the panel's own end grows it when the pointer moves right, one on its start shrinks it.
 * Both keep "right widens the thing left of the separator", which is what a splitter means.
 */
export type ResizeEdge = 'start' | 'end';

const SIGN: Record<ResizeEdge, number> = { start: -1, end: 1 };

/** One press of an arrow key. `--pg-space-4`'s 16px, so a keyboard step lands on the 4px scale. */
const STEP = 16;

/** Shift + arrow, for crossing the whole range in a few presses rather than twenty. */
const COARSE_STEP = 64;

export interface UseResizableOptions {
  /** The custom property this drives, e.g. `--pg-rail-width`. Its `-min`/`-max` siblings bound it. */
  variable: string;
  /** `localStorage` key the width is remembered under. */
  storageKey: string;
  edge: ResizeEdge;
  /** The handle's accessible name — it is the only text this control has. */
  label: string;
}

export interface Resizable {
  /**
   * False when a bound could not be read, in which case nothing is written and `ResizeHandle`
   * renders nothing. A missing token is a mistake in `tokens.css`, and the honest response to one is
   * a panel that does not resize rather than a panel `NaN` pixels wide.
   */
  enabled: boolean;
  width: number;
  min: number;
  max: number;
  label: string;
  dragging: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onLostPointerCapture: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

interface Bounds {
  fallback: number;
  min: number;
  max: number;
}

/**
 * A px-valued custom property, read once and cached.
 *
 * CACHED BECAUSE THE FIRST READ IS THE ONLY HONEST ONE for the width itself — see the file comment.
 * `--pg-rail-width-min` and `-max` are never overridden and would be safe to re-read, but they go
 * through the same door so there is one rule rather than two.
 */
const TOKEN_PX = new Map<string, number>();

function tokenPx(variable: string): number {
  const cached = TOKEN_PX.get(variable);
  if (cached !== undefined) return cached;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable);
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[resize] ${variable} is not a px length; that panel will not be resizable`);
  }
  TOKEN_PX.set(variable, value);
  return value;
}

function clamp(value: number, bounds: Bounds): number {
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

/** Wrapped like `lib/theme.ts` and `api/lastGood.ts`: localStorage throws under `file://`. */
function readStored(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch (cause) {
    console.warn(`[resize] could not read ${key}`, cause);
    return null;
  }
}

function storeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch (cause) {
    // The width still applies for this session; only its persistence is lost.
    console.warn(`[resize] could not store ${key}`, cause);
  }
}

export function useResizable({ variable, storageKey, edge, label }: UseResizableOptions): Resizable {
  // Both initialisers run during the first render, in this order, which is what puts the token read
  // ahead of the first write. `useState` rather than `useMemo` because these must be computed once
  // and never recomputed — a `useMemo` is allowed to be dropped and re-run.
  const [bounds] = useState<Bounds>(() => ({
    fallback: tokenPx(variable),
    min: tokenPx(`${variable}-min`),
    max: tokenPx(`${variable}-max`),
  }));
  const enabled =
    Number.isFinite(bounds.fallback) && Number.isFinite(bounds.min) && Number.isFinite(bounds.max);

  const [width, setWidth] = useState<number>(() =>
    enabled ? clamp(readStored(storageKey) ?? bounds.fallback, bounds) : bounds.fallback,
  );
  const [dragging, setDragging] = useState(false);

  /** Where the drag started, in both axes of the problem. Null between drags. */
  const origin = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    document.documentElement.style.setProperty(variable, `${width}px`);
  }, [enabled, variable, width]);

  /*
   * Persisted when the width SETTLES, not on every pointermove — a drag produces a write per frame
   * otherwise. `dragging` gating it means the keyboard path, where every change is already discrete,
   * persists immediately and needs no separate branch. It also runs once on mount, writing back the
   * value it just read, which is harmless and cheaper than a ref to suppress.
   */
  useEffect(() => {
    if (!enabled || dragging) return;
    storeWidth(storageKey, width);
  }, [enabled, dragging, storageKey, width]);

  /*
   * A page-wide attribute for the duration of a drag, so the text under the cursor cannot be
   * selected and the col-resize cursor does not flicker back to a caret over prose. On <html> rather
   * than <body> to match `data-theme`, and removed by the cleanup so an unmount mid-drag cannot
   * leave the page unselectable.
   */
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.pgResizing = '';
    return () => {
      delete document.documentElement.dataset.pgResizing;
    };
  }, [dragging]);

  const endDrag = useCallback(() => {
    if (origin.current === null) return;
    origin.current = null;
    setDragging(false);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      // Primary button only. A right-click would otherwise start a drag that no pointerup ends.
      if (!enabled || event.button !== 0) return;
      // Suppresses the native selection and drag-image gestures, which would both fight the drag.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = { x: event.clientX, width };
      setDragging(true);
    },
    [enabled, width],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (start === null) return;
      // Measured from where the drag STARTED rather than accumulated per event, so a clamped edge
      // does not eat the pointer's position: drag past the maximum and back, and the panel follows
      // again from the same place the cursor is.
      setWidth(clamp(start.width + (event.clientX - start.x) * SIGN[edge], bounds));
    },
    [bounds, edge],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const step = (event.shiftKey ? COARSE_STEP : STEP) * SIGN[edge];
      let next: number;
      switch (event.key) {
        case 'ArrowRight':
          next = width + step;
          break;
        case 'ArrowLeft':
          next = width - step;
          break;
        // Home and End move the SEPARATOR to its extremes, which is the widest panel for one edge
        // and the narrowest for the other. Keyed off the sign so neither reads as inverted.
        case 'Home':
          next = SIGN[edge] > 0 ? bounds.min : bounds.max;
          break;
        case 'End':
          next = SIGN[edge] > 0 ? bounds.max : bounds.min;
          break;
        // Reset. The same thing double-clicking does, since a separator has no other obvious use
        // for Enter, and a dragged-somewhere-odd panel otherwise needs pixel-accurate mousework.
        case 'Enter':
        case ' ':
          next = bounds.fallback;
          break;
        default:
          return;
      }
      event.preventDefault();
      setWidth(clamp(next, bounds));
    },
    [bounds, edge, enabled, width],
  );

  const onDoubleClick = useCallback(() => {
    if (!enabled) return;
    setWidth(clamp(bounds.fallback, bounds));
  }, [bounds, enabled]);

  return {
    enabled,
    width,
    min: bounds.min,
    max: bounds.max,
    label,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    // Capture can be lost without a pointerup — a touch cancelled by the browser, or the element
    // being removed. Ending the drag here too means `dragging` cannot latch on.
    onLostPointerCapture: endDrag,
    onKeyDown,
    onDoubleClick,
  };
}
