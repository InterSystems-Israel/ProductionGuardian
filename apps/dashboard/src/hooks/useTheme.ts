/**
 * Light or dark, and the one control that flips it.
 *
 * `lib/theme.ts` holds the decision; this holds the React part of it. The
 * attribute is re-applied from an effect rather than only at startup so the
 * control works — the pre-paint script in `index.html` sets the initial value and
 * then never runs again.
 *
 * THE DESKTOP PREFERENCE IS FOLLOWED ONLY UNTIL THE OPERATOR CHOOSES. Before the
 * first click the dashboard tracks `prefers-color-scheme` live, which is what
 * makes an unattended kiosk match the machine it is on; after it, the choice is
 * pinned and the listener is dropped. A dashboard that re-darkened itself
 * mid-demo because the desktop hit its evening schedule would be worse than
 * either fixed theme.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  watchSystemTheme,
  type Theme,
} from '../lib/theme';

export interface ThemeControl {
  theme: Theme;
  toggle: () => void;
}

export function useTheme(): ThemeControl {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme());

  /* Whether the operator has chosen explicitly. Held as state rather than read
     from storage inside the effect below, because storage is not reactive and the
     effect has to re-run at the moment of the first click to unsubscribe. */
  const [pinned, setPinned] = useState<boolean>(() => readStoredTheme() !== null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (pinned) return undefined;
    return watchSystemTheme(setTheme);
  }, [pinned]);

  const toggle = useCallback((): void => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      storeTheme(next);
      return next;
    });
    setPinned(true);
  }, []);

  return { theme, toggle };
}
