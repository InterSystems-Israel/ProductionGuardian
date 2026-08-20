/**
 * Nav rail + header + content region (§7.2).
 *
 * The rail carries Health Connect context — Home, Dashboard, Productions,
 * Alerts, Messages, Jobs, Settings — of which only *Dashboard* is real. The rest
 * are inert by design and must *look* inert: rendered as plain spans, not
 * buttons or links, so nothing is clickable-and-broken and nothing lands in the
 * keyboard tab order.
 *
 * MVP 3 ADDS TWO ITEMS THAT ARE THE OPPOSITE, and the difference has to be visible. Brochure and
 * Architecture are real views, so they are `<button>`s: focusable, keyboard-operable, in the tab
 * order. Rendering them as the same spans as their inert neighbours would make the one thing a
 * visitor can click indistinguishable from the six things they cannot — and the inert items exist
 * precisely so that nothing looks clickable-and-broken. A new item that *is* clickable must
 * therefore look and behave differently, not blend in.
 *
 * They sit in a second group below the Health Connect items rather than among them, because they are
 * Production Guardian's own views and not part of the simulated host product.
 */

import type { ReactNode } from 'react';
import {
  IconAlert,
  IconDashboard,
  IconHome,
  IconJobs,
  IconMessages,
  IconProductions,
  IconSettings,
  IconShield,
  type IconProps,
} from './icons';

interface RailItem {
  label: string;
  Icon: (props: IconProps) => JSX.Element;
  active?: boolean;
}

const RAIL: readonly RailItem[] = [
  { label: 'Home', Icon: IconHome },
  { label: 'Dashboard', Icon: IconDashboard, active: true },
  { label: 'Productions', Icon: IconProductions },
  { label: 'Alerts', Icon: IconAlert },
  { label: 'Messages', Icon: IconMessages },
  { label: 'Jobs', Icon: IconJobs },
  { label: 'Settings', Icon: IconSettings },
];

/** The views MVP 3 adds. `dashboard` is the MVP 1/2 findings view. */
export type View = 'dashboard' | 'brochure' | 'architecture';

interface GuardianItem {
  label: string;
  view: View;
  Icon: (props: IconProps) => JSX.Element;
}

/** Production Guardian's own views. Real buttons, unlike RAIL above. */
const GUARDIAN_VIEWS: readonly GuardianItem[] = [
  { label: 'Brochure', view: 'brochure', Icon: IconShield },
  { label: 'Architecture', view: 'architecture', Icon: IconProductions },
];

export interface AppShellProps {
  /** Header right side — mode pill, last-updated, toggle. */
  headerActions: ReactNode;
  children: ReactNode;
  /** Which view is showing. Defaults to `dashboard`, so the shell is unchanged without it. */
  view?: View;
  onView?: (view: View) => void;
}

export function AppShell({
  headerActions,
  children,
  view = 'dashboard',
  onView,
}: AppShellProps): JSX.Element {
  return (
    <div className="pg-shell">
      <nav className="pg-rail" aria-label="Health Connect">
        <span className="pg-rail__brand">Health Connect</span>
        <ul className="pg-rail__list">
          {RAIL.map((item) => (
            <li key={item.label}>
              {/* `Dashboard` stops being the current page when one of the new views is open --
                  otherwise two rail entries would claim `aria-current`, and a screen reader user
                  would be told they are on a page they left. */}
              {item.active === true && view === 'dashboard' ? (
                <span className="pg-rail__item pg-rail__item--active" aria-current="page">
                  <item.Icon size={17} />
                  {item.label}
                </span>
              ) : (
                <span className="pg-rail__item pg-rail__item--inert">
                  <item.Icon size={17} />
                  {item.label}
                </span>
              )}
            </li>
          ))}
        </ul>

        {onView !== undefined && (
          <>
            <span className="pg-rail__divider" aria-hidden="true" />
            <ul className="pg-rail__list">
              {GUARDIAN_VIEWS.map((item) => (
                <li key={item.view}>
                  <button
                    type="button"
                    className={`pg-rail__item pg-rail__item--action${
                      view === item.view ? ' pg-rail__item--active' : ''
                    }`}
                    aria-current={view === item.view ? 'page' : undefined}
                    onClick={() => onView(item.view)}
                  >
                    <item.Icon size={17} />
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      <header className="pg-header">
        <span className="pg-header__mark">
          <IconShield size={22} />
        </span>
        <h1 className="pg-header__title">
          Production Guardian
          <span className="pg-header__divider">—</span>
          <span className="pg-header__module">Health Scan</span>
        </h1>
        <div className="pg-header__actions">{headerActions}</div>
      </header>

      <main className="pg-content">{children}</main>
    </div>
  );
}
