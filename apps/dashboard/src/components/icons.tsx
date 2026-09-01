/**
 * Inline SVG set — no icon package (§3). One export per icon.
 *
 * All icons are 24×24, `currentColor`, 1.6 stroke. Shapes are deliberately
 * distinguishable by silhouette alone: severity must never be signaled by
 * color only (§7.3), so the badge icon carries meaning on a projector where
 * the red/amber distinction may not survive.
 */

export interface IconProps {
  size?: number;
  className?: string;
}

type PathIcon = (props: IconProps) => JSX.Element;

function svg(children: JSX.Element, { size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ── Severity ─────────────────────────────────────────────────────────────── */

/** Octagon — the most distinct silhouette, reserved for critical. */
export const IconCritical: PathIcon = (props) =>
  svg(
    <>
      <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2L8.2 3Z" />
      <path d="M12 8v4.5" />
      <circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" />
    </>,
    props,
  );

/** Triangle — warning. */
export const IconWarning: PathIcon = (props) =>
  svg(
    <>
      <path d="M12 3.8 21 19.5H3L12 3.8Z" />
      <path d="M12 9.5v4" />
      <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
    </>,
    props,
  );

/** Circle — info. */
export const IconInfo: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </>,
    props,
  );

/* ── Finding types ────────────────────────────────────────────────────────── */

/** Dead / inactive host — power symbol. */
export const IconDead: PathIcon = (props) =>
  svg(
    <>
      <path d="M12 3v8" />
      <path d="M6.5 6.8a8 8 0 1 0 11 0" />
    </>,
    props,
  );

/** Stalled / hung — clock with a stopped hand. */
export const IconStalled: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 1.9" />
    </>,
    props,
  );

/** Queue buildup — stacking bars. */
export const IconQueue: PathIcon = (props) =>
  svg(
    <>
      <path d="M4 18.5h16" />
      <rect x="6" y="13" width="12" height="3" rx="0.6" />
      <rect x="8" y="8.5" width="8" height="3" rx="0.6" />
      <rect x="10" y="4" width="4" height="3" rx="0.6" />
    </>,
    props,
  );

/** Elevated error rate — crossed circle. */
export const IconError: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>,
    props,
  );

/** Slow processing — hourglass. */
export const IconSlow: PathIcon = (props) =>
  svg(
    <>
      <path d="M7 3.5h10M7 20.5h10" />
      <path d="M8 3.5c0 4 4 5.9 4 8.5s-4 4.5-4 8.5" />
      <path d="M16 3.5c0 4-4 5.9-4 8.5s4 4.5 4 8.5" />
    </>,
    props,
  );

/** Growing queue wait — rising line. */
export const IconWait: PathIcon = (props) =>
  svg(
    <>
      <path d="M4 19.5V4.5" />
      <path d="M4 19.5h16" />
      <path d="M7 16l3.5-3.6 3 2.2L20 8" />
    </>,
    props,
  );

/** Throughput drop — falling line. */
export const IconDrop: PathIcon = (props) =>
  svg(
    <>
      <path d="M4 19.5V4.5" />
      <path d="M4 19.5h16" />
      <path d="M7 8l3.5 3.6 3-2.2L20 16" />
      <path d="M20 16h-3.4M20 16v-3.4" />
    </>,
    props,
  );

/** System alert — bell. */
export const IconAlert: PathIcon = (props) =>
  svg(
    <>
      <path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15L18 15.5Z" />
      <path d="M10 21h4" />
    </>,
    props,
  );

/** Unknown finding type — neutral marker, never a severity shape. */
export const IconUnknown: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" strokeDasharray="3 2.6" />
      <path d="M12 15.6v-.7c0-1 .6-1.5 1.3-2 .7-.5 1.2-1 1.2-2a2.5 2.5 0 0 0-5 0" />
      <circle cx="12" cy="18" r="0.9" fill="currentColor" stroke="none" />
    </>,
    props,
  );

/* ── Chrome ───────────────────────────────────────────────────────────────── */

export const IconShield: PathIcon = (props) =>
  svg(
    <>
      <path d="M12 3 4.5 5.9v6.4c0 4.8 3.2 7.9 7.5 9 4.3-1.1 7.5-4.2 7.5-9V5.9L12 3Z" />
      <path d="M9.2 12.2l2 2 3.6-4" />
    </>,
    props,
  );

export const IconClose: PathIcon = (props) =>
  svg(<path d="M6 6l12 12M18 6L6 18" />, props);

export const IconChevronRight: PathIcon = (props) =>
  svg(<path d="M9.5 5.5l7 6.5-7 6.5" />, props);

export const IconRestart: PathIcon = (props) =>
  svg(
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>,
    props,
  );

export const IconCheck: PathIcon = (props) =>
  svg(<path d="M4.5 12.5l5 5 10-11" />, props);

/**
 * Enclosed check — the Early Warning *watching* state.
 *
 * A SEPARATE ICON FROM `IconCheck` ON PURPOSE, though the tick inside is the same gesture.
 * `IconCheck` is a bare tick used where something *completed* — the reconnected banner, the
 * "no findings" empty mark, the Hosts OK tile. "Watching" completes nothing; it reports an
 * ongoing observation with nothing to report, so the ring is the meaning: a tick held inside a
 * boundary rather than a tick handed over. Reusing the bare tick would have read as a verdict.
 *
 * The circle also keeps it off the severity silhouettes. Per the header rule, shapes must be
 * distinguishable by outline alone — this is a *ring* with a tick, where `IconInfo` is a ring with
 * a bar and dot, so neither can be misread as the other on a projector.
 */
export const IconWatching: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 12.4l2.6 2.6 5-5.6" />
    </>,
    props,
  );

/* Nav rail — inert visual context (§7.2), so these are deliberately plain. */

export const IconHome: PathIcon = (props) =>
  svg(<path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z" />, props);

export const IconDashboard: PathIcon = (props) =>
  svg(
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>,
    props,
  );

export const IconProductions: PathIcon = (props) =>
  svg(
    <>
      <path d="M4 20V9l5 3V9l5 3V6l6 4v10H4Z" />
    </>,
    props,
  );

export const IconMessages: PathIcon = (props) =>
  svg(
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M4 7l8 6 8-6" />
    </>,
    props,
  );

export const IconJobs: PathIcon = (props) =>
  svg(
    <>
      <rect x="3.5" y="7.5" width="17" height="11" rx="1.5" />
      <path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5" />
    </>,
    props,
  );

export const IconSettings: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.3M17.6 15.2l2.2 1.3M4.2 16.5l2.2-1.3M17.6 8.8l2.2-1.3" />
    </>,
    props,
  );

/* ── Production Guardian views (MVP 3) ────────────────────────────────────── */

/** Open book — the brochure. Distinct from IconMessages' single sheet. */
export const IconBrochure: PathIcon = (props) =>
  svg(
    <>
      <path d="M12 6.5v13" />
      <path d="M12 6.5C10.5 5 8.4 4.5 5 4.5v13c3.4 0 5.5.5 7 2 1.5-1.5 3.6-2 7-2v-13c-3.4 0-5.5.5-7 2Z" />
    </>,
    props,
  );

/** Three linked nodes — the architecture. Reads as a topology at 17px. */
export const IconArchitecture: PathIcon = (props) =>
  svg(
    <>
      <rect x="9" y="3.5" width="6" height="5" rx="1.2" />
      <rect x="3" y="15.5" width="6" height="5" rx="1.2" />
      <rect x="15" y="15.5" width="6" height="5" rx="1.2" />
      <path d="M12 8.5v3.5M12 12H6v3.5M12 12h6v3.5" />
    </>,
    props,
  );

/* ── Theme ────────────────────────────────────────────────────────────────── */

/**
 * Sun — shown while the dark theme is on, because the button offers the switch
 * back. THE CENTRE IS FILLED, unlike `IconSettings`, which is a hollow circle
 * with the same six-spoke perimeter: at 15px those two silhouettes are otherwise
 * near-identical, and §7.3's rule that shape carries the meaning applies to
 * chrome as much as to severity.
 */
export const IconSun: PathIcon = (props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M5.2 18.8l2.1-2.1M16.7 7.3l2.1-2.1" />
    </>,
    props,
  );

/** Crescent — shown while the light theme is on. Unmistakable at any size. */
export const IconMoon: PathIcon = (props) =>
  svg(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />, props);
