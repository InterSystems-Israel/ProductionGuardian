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

/** Which top-level view is on screen. */
export type View = 'dashboard' | 'brochure' | 'architecture';

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
  children: ReactNode;
}

export function AppShell({ headerActions, view, onNavigate, children }: AppShellProps): JSX.Element {
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
        </ul>
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
        <div className="pg-header__actions">{headerActions}</div>
      </header>

      <main className="pg-content">{children}</main>
    </div>
  );
}
