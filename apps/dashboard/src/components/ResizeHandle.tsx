/**
 * The grab strip on a resizable panel's edge.
 *
 * PRESENTATIONAL AND STATELESS — every decision is in `hooks/useResizable.ts`, and this file exists
 * so the rail and the drawer cannot end up with different affordances or different keyboard support.
 * Spread the hook's return into it: `<ResizeHandle {...rail} className="pg-resize--rail" />`.
 *
 * A `separator`, NOT A `<button>`, which is the one exception to §7.3's "real `<button>` for anything
 * clickable". This is the ARIA window-splitter pattern: a focusable separator carrying
 * `aria-valuenow/min/max`, so assistive technology reads out a position rather than announcing a
 * press. A button would announce the wrong thing and would have no way to report the width.
 *
 * WIDER THAN IT LOOKS. The visible mark is a 2px line; the target is 10px, because a 1px seam is not
 * a pointer target on a laptop trackpad. The extra width sits inside the panel's own padding, so it
 * covers nothing clickable — see the rule in `app.css`.
 *
 * RENDERS NOTHING WHEN THE HOOK IS DISABLED, i.e. when a bound token could not be read. A handle that
 * is present and inert is worse than an absent one: it invites a drag and then reports nothing.
 */

import type { Resizable } from '../hooks/useResizable';

export interface ResizeHandleProps extends Resizable {
  /** Positioning modifier — which edge of which panel. Geometry only; behaviour is the hook's. */
  className: string;
}

export function ResizeHandle({
  className,
  enabled,
  width,
  min,
  max,
  label,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onLostPointerCapture,
  onKeyDown,
  onDoubleClick,
}: ResizeHandleProps): JSX.Element | null {
  if (!enabled) return null;

  return (
    <div
      className={`pg-resize ${className}${dragging ? ' pg-resize--dragging' : ''}`}
      role="separator"
      /* The separator itself is vertical; `separator`'s ARIA default is horizontal. */
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      /* Says how it works, since the control carries no visible text. Both halves matter: nobody
         discovers the keyboard path, and nobody discovers the reset without being told. */
      title={`${label} — drag, or focus it and use the arrow keys. Double-click to reset.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
