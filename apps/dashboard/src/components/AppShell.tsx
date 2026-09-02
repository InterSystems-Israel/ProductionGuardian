/**
 * Nav rail + header + content region (§7.2).
 *
 * The rail carries Health Connect context — Home, Dashboard, Productions,
 * Alerts, Messages, Jobs, Settings — of which only *Dashboard* is real. The rest
 * are inert by design and must *look* inert: rendered as plain spans, not
 * buttons or links, so nothing is clickable-and-broken and nothing lands in the
 * keyboard tab order.
 *
 * MVP 3 adds a SECOND, SEPARATELY LABELLED group for the two views that are ours
 * — Brochure and Architecture. They are real `<button>`s, in the tab order, and
 * they sit under their own heading rather than joining the list above.
 *
 * That separation is the point rather than decoration. The rail's top group is a
 * deliberate fiction: six of its seven items do nothing. Dropping two working
 * controls into it would make the fiction ambiguous — an operator would have no
 * way to tell which of the nine items respond, and the existing design goes out
 * of its way to ensure "inert" is legible. Ours are grouped, headed, and styled
 * as controls; theirs stay flat text.
 *
 * THRESHOLD SETTINGS JOINS THE SECOND GROUP, NOT THE INERT "Settings" ITEM ABOVE,
 * and the temptation to reuse that item is exactly what the paragraph above warns
 * against. Health Connect's "Settings" stands for the whole product's
 * configuration; ours edits three detection thresholds. Making that one item real
 * would promise the former and deliver the latter, and it would break the "six of
 * seven do nothing" rule an operator has already learned from the other five inert
 * items. So it stays inert and ours is a separately labelled control, consistent
 * with how Brochure and Architecture were added.
 *
 * IT IS A DRAWER, NOT A VIEW, so it does not join the `View` union: it opens over
 * the dashboard rather than replacing it, because an operator changing what fires
 * wants to watch the findings list respond. `onOpenSettings` is therefore separate
 * from `onNavigate`.
 */

import type { ReactNode } from 'react';
import {
  IconAlert,
  IconArchitecture,
  IconBrochure,
  IconDashboard,
  IconHome,
  IconJobs,
  IconMessages,
  IconProductions,
  IconSettings,
  IconShield,
  type IconProps,
} from './icons';
import { ResizeHandle } from './ResizeHandle';
import { ThemeToggle } from './ThemeToggle';
import { TriggerRail } from './TriggerRail';
import { useResizable } from '../hooks/useResizable';

/** Which top-level view is on screen. */
export type View = 'dashboard' | 'brochure' | 'architecture';

/**
 * The IRIS interoperability editor, for jumping from a finding to the production that produced it.
 *
 * THE NEW ANGULAR UI, not the Zen page. `/ui/interop/interop-editor/` is what current IRIS builds
 * ship and what an operator on this instance actually uses; the old
 * `/csp/healthshare/labdemo/EnsPortal.ProductionConfig.zen` still answers 200 and remains a working
 * fallback if anyone needs it, but landing an audience on the legacy portal from a modern dashboard
 * is a jarring seam. Both verified 200 against the running instance before switching.
 *
 * THE QUERY STRING IS PERCENT-ENCODED AND MUST STAY THAT WAY. `%24` is `$`, and the editor expects
 * `$NAMESPACE` / `$PRODUCTION` as literal parameter names. Writing them raw here works in some
 * contexts and breaks in others depending on how the URL is parsed, so the encoded form is kept
 * verbatim as verified — do not "tidy" it.
 *
 * NAMESPACE AND PRODUCTION ARE LABDEMO-SPECIFIC, exactly as the old path was. That is not a
 * regression in generality: this whole default is a convenience for the demo instance, and
 * `VITE_IRIS_PORTAL_URL` replaces the entire URL for anything else.
 *
 * ABSOLUTE AND CONFIGURABLE, unlike the API base, and the two differ for a real reason. The API is
 * reached through nginx on the dashboard's own origin, so a relative path is correct and keeps the
 * bundle environment-independent. The portal is a *different service on a different port* that
 * nothing proxies, so the browser must be told where it is.
 *
 * The port is not read from `docker-compose.yml`'s `PG_IRIS_WEB_PORT`: the bundle is built before
 * compose runs and the browser is on the host, so the build cannot know the mapping. A wrong
 * default is visible and one variable away from fixed, which is the honest trade.
 */
const DEFAULT_PORTAL_URL =
  'http://localhost:52773/ui/interop/interop-editor/index.html' +
  '?%24NAMESPACE=LABDEMO&%24PRODUCTION=ProductionGuardian.LabDemo.Production';

function portalUrl(): string {
  const configured = import.meta.env.VITE_IRIS_PORTAL_URL;
  return configured !== undefined && configured !== '' ? configured : DEFAULT_PORTAL_URL;
}

interface RailItem {
  label: string;
  Icon: (props: IconProps) => JSX.Element;
  /** Set on the one Health Connect item that represents this product. */
  standsFor?: View;
}

const RAIL: readonly RailItem[] = [
  { label: 'Home', Icon: IconHome },
  { label: 'Dashboard', Icon: IconDashboard, standsFor: 'dashboard' },
  { label: 'Productions', Icon: IconProductions },
  { label: 'Alerts', Icon: IconAlert },
  { label: 'Messages', Icon: IconMessages },
  { label: 'Jobs', Icon: IconJobs },
  { label: 'Settings', Icon: IconSettings },
];

const OURS: readonly { label: string; view: View; Icon: (props: IconProps) => JSX.Element }[] = [
  { label: 'Architecture', view: 'architecture', Icon: IconArchitecture },
  { label: 'Brochure', view: 'brochure', Icon: IconBrochure },
];

const MODULE_LABEL: Record<View, string> = {
  dashboard: 'Health Scan',
  brochure: 'Brochure',
  architecture: 'Architecture',
};

export interface AppShellProps {
  /** Header right side — mode pill, last-updated, toggle. */
  headerActions: ReactNode;
  view: View;
  onNavigate: (view: View) => void;
  /** Opens the threshold settings drawer. Separate from `onNavigate` — see the file comment. */
  onOpenSettings: () => void;
  /** True while the drawer is open, for `aria-expanded` on the rail control. */
  settingsOpen: boolean;
  children: ReactNode;
}

export function AppShell({
  headerActions,
  view,
  onNavigate,
  onOpenSettings,
  settingsOpen,
  children,
}: AppShellProps): JSX.Element {
  /* Drives `--pg-rail-width`, which `.pg-shell`'s grid column reads — see `useResizable`. Owned here
     rather than by the rail's contents because the rail is not the element that is sized; the shell
     is, and this is the component that renders both. */
  const rail = useResizable({
    variable: '--pg-rail-width',
    storageKey: 'pg.railWidth.v1',
    edge: 'end',
    label: 'Navigation rail width',
  });

  return (
    <div className="pg-shell">
      <nav className="pg-rail" aria-label="Health Connect">
        <span className="pg-rail__brand">Health Connect</span>
        <ul className="pg-rail__list">
          {RAIL.map((item) => (
            <li key={item.label}>
              {/* `aria-current` follows the actual view: on Brochure or Architecture,
                  Dashboard is no longer the current page and must stop claiming to be. */}
              {item.standsFor === 'dashboard' ? (
                <button
                  type="button"
                  className={`pg-rail__item pg-rail__item--action${
                    view === 'dashboard' ? ' pg-rail__item--active' : ''
                  }`}
                  aria-current={view === 'dashboard' ? 'page' : undefined}
                  onClick={() => onNavigate('dashboard')}
                >
                  <item.Icon size={17} />
                  {item.label}
                </button>
              ) : (
                <span className="pg-rail__item pg-rail__item--inert">
                  <item.Icon size={17} />
                  {item.label}
                </span>
              )}
            </li>
          ))}
        </ul>

        <span className="pg-rail__brand pg-rail__brand--ours">Production Guardian</span>
        <ul className="pg-rail__list">
          {OURS.map((item) => (
            <li key={item.view}>
              <button
                type="button"
                className={`pg-rail__item pg-rail__item--action${
                  view === item.view ? ' pg-rail__item--active' : ''
                }`}
                aria-current={view === item.view ? 'page' : undefined}
                onClick={() => onNavigate(item.view)}
              >
                <item.Icon size={17} />
                {item.label}
              </button>
            </li>
          ))}
          {/* Last in our group, and it carries `aria-expanded` rather than `aria-current` because it
              opens a drawer instead of navigating -- the two items above change the page, this one
              does not, and claiming `page` for it would be wrong. */}
          <li>
            <button
              type="button"
              className={`pg-rail__item pg-rail__item--action${
                settingsOpen ? ' pg-rail__item--active' : ''
              }`}
              aria-expanded={settingsOpen}
              /* The focus-return target when the drawer closes (`App.tsx` `closeSettings`). An
                 explicit attribute rather than an `[aria-expanded]` selector, which would match any
                 expandable control added later. */
              data-rail-settings=""
              onClick={onOpenSettings}
            >
              <IconSettings size={17} />
              Thresholds
            </button>
          </li>
        </ul>

        {/* Renders nothing unless the deployment enables it — see TriggerRail. Placed last in the
            rail so an audience reads the product's own navigation first and the demo scaffolding
            after it, and so its absence leaves the rail visually unchanged. */}
        <TriggerRail />

        {/* Last of all, and absolutely positioned on the rail's own right edge — so it tracks the
            column whatever the rail contains, including the demo triggers being off. Hidden under
            1100px, where the media query pins the rail to an icon strip and a drag would appear to
            do nothing. */}
        <ResizeHandle {...rail} className="pg-resize--rail" />
      </nav>

      <header className="pg-header">
        <span className="pg-header__mark">
          <IconShield size={22} />
        </span>
        <h1 className="pg-header__title">
          Production Guardian
          <span className="pg-header__divider">—</span>
          {/* Follows the view. Leaving it at "Health Scan" while the brochure is on
              screen would caption the wrong thing, and the header is the only place
              on the page that names where you are. */}
          <span className="pg-header__module">{MODULE_LABEL[view]}</span>
        </h1>
        <div className="pg-header__actions">
          {headerActions}
          {/* Rendered here rather than passed in through `headerActions`, which carries what the
              DATA is — the mode pill, the scenario step, when it last updated. The theme is a
              property of the display and belongs to the shell that owns the chrome, so `App` does
              not need to know it exists. */}
          <ThemeToggle />
          {/* A real link, not a button with an onClick: it navigates to another application, so it
              must be middle-clickable and copyable like any other link. `rel="noreferrer"` alongside
              `noopener` because the portal is a different origin. */}
          <a
            className="pg-header__portal"
            href={portalUrl()}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this production in the IRIS interoperability editor, in a new tab"
          >
            <IconProductions size={14} />
            Management Portal
            {/* Marks the new-tab behaviour for screen readers, since the icon cannot. */}
            <span className="pg-visually-hidden"> (opens in a new tab)</span>
          </a>
        </div>
      </header>

      <main className="pg-content">{children}</main>
    </div>
  );
}
