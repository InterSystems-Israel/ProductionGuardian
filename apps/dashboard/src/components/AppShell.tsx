/**
 * Nav rail + header + content region (§7.2).
 *
 * The rail carries Health Connect context — Home, Dashboard, Productions,
 * Alerts, Messages, Jobs, Settings — of which only *Dashboard* is real. The rest
 * are inert by design and must *look* inert: rendered as plain spans, not
 * buttons or links, so nothing is clickable-and-broken and nothing lands in the
 * keyboard tab order.
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

export interface AppShellProps {
  /** Header right side — mode pill, last-updated, toggle. */
  headerActions: ReactNode;
  children: ReactNode;
}

export function AppShell({ headerActions, children }: AppShellProps): JSX.Element {
  return (
    <div className="pg-shell">
      <nav className="pg-rail" aria-label="Health Connect">
        <span className="pg-rail__brand">Health Connect</span>
        <ul className="pg-rail__list">
          {RAIL.map((item) => (
            <li key={item.label}>
              {item.active === true ? (
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
