/**
 * The light/dark control, in the header beside the mode toggle.
 *
 * SELF-CONTAINED, and the only component in this app that owns its own state
 * rather than receiving it as props (§3). That is not an exception being carved
 * out: the theme has exactly one consumer and it is not React. `useTheme` writes
 * `data-theme` on <html> and every rule in `app.css` reads its tokens from there,
 * so threading a `theme` prop down from `App` would move state further from its
 * only reader and buy nothing. Nothing else re-renders when the theme changes.
 *
 * IT SHOWS WHAT THE CLICK WILL DO, not what is currently on — a moon while the
 * page is light. An icon-only control naming its own state is the ambiguous case
 * (is the moon a label or a button?), and the accessible name and the tooltip say
 * the same thing the icon does, so the two can never be read against each other.
 *
 * No `aria-pressed` for that reason: this is an action whose label changes, not a
 * two-state switch with a fixed one. And no transition on the switch, so there is
 * nothing for `prefers-reduced-motion` to suppress (§7.3) — a theme change is a
 * repaint of the whole page, and cross-fading every surface at once is the one
 * animation that reliably looks broken.
 */

import { useTheme } from '../hooks/useTheme';
import { IconMoon, IconSun } from './icons';

export function ThemeToggle(): JSX.Element {
  const { theme, toggle } = useTheme();
  const target = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to the ${target} theme`;

  return (
    <button
      type="button"
      className="pg-button pg-button--icon"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
    </button>
  );
}
