/**
 * Theme preference: resolve it, apply it, remember it.
 *
 * The whole theme is a token override in `tokens.css` keyed on `data-theme` on
 * <html>, so this file's only job is deciding which value that attribute holds.
 * Nothing else in the app reads the theme — CSS does.
 *
 * THE SYSTEM PREFERENCE IS HONOURED HERE AND NOWHERE ELSE. `tokens.css`
 * deliberately carries no `@media (prefers-color-scheme: dark)` block: two
 * authorities over one decision disagree the moment an operator on a dark
 * desktop picks light, and the disagreement would be a theme that flips back on
 * reload.
 *
 * Every storage access is wrapped, matching `api/lastGood.ts`: localStorage
 * throws in private-mode Safari and can be unavailable under `file://`, which is
 * exactly how the static fallback build is opened (§6). A forgotten preference
 * costs one click; an exception here would blank the page.
 */

export type Theme = 'light' | 'dark';

/**
 * ALSO READ BY THE PRE-PAINT SCRIPT IN `index.html`, which cannot import from
 * here — it has to run before the deferred module bundle to avoid a flash of the
 * light page background on reload. That script and this constant are the one
 * duplicated fact in this feature and must change together.
 */
const KEY = 'pg.theme.v1';

const QUERY = '(prefers-color-scheme: dark)';

/** The operator's explicit choice, or null while they have never made one. */
export function readStoredTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch (cause) {
    console.warn('[theme] could not read the stored preference', cause);
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch (cause) {
    // The theme still applies for this session; only its persistence is lost.
    console.warn('[theme] could not store the preference', cause);
  }
}

/** What the desktop asks for. Light when the browser has no opinion. */
export function systemTheme(): Theme {
  return window.matchMedia(QUERY).matches ? 'dark' : 'light';
}

/** An explicit choice wins; otherwise follow the desktop. */
export function resolveTheme(): Theme {
  return readStoredTheme() ?? systemTheme();
}

/**
 * Calls `listener` when the desktop preference changes, and returns the
 * unsubscribe. Kept here rather than in the hook so `matchMedia` is named in one
 * place and the hook stays about React.
 */
export function watchSystemTheme(listener: (theme: Theme) => void): () => void {
  const query = window.matchMedia(QUERY);
  const onChange = (event: MediaQueryListEvent): void => {
    listener(event.matches ? 'dark' : 'light');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
