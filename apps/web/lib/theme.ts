'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Two themes, one token layer. "paper" is the light one; "graphite" is its dark
 * twin. A learner either picks one or lets the machine decide, and that answer
 * lives in localStorage: the theme's own name when they picked, nothing at all
 * when they are following the machine. THEME_BOOT_SCRIPT resolves it and stamps
 * `data-theme` on <html> before React hydrates, so the first paint is already
 * the right colour.
 *
 * With nothing stored, the boot script follows `prefers-color-scheme`: a
 * default of paper would give a first-time visitor on a dark machine a
 * near-black browser toolbar (the manifest declares one for dark systems)
 * above a white page. The machine's setting is only the default: a stored
 * choice still outranks it.
 */
export type Theme = 'paper' | 'graphite';

/** What the learner chose. `null` is a choice too: "follow the machine". */
type ThemeChoice = Theme | null;

export const THEME_KEY = 'lsdlc_theme';
/** Fired on window whenever the applied theme changes, so anything that cannot
 * read a CSS variable (Monaco) can re-apply its own palette. */
export const THEME_EVENT = 'lsdlc-theme';
/** Where the app lands when nothing is stored and the machine says nothing. */
const DEFAULT_THEME: Theme = 'paper';
/** Stamped on <html> beside `data-theme` so the toggle can draw the *choice*
 * (following, or pinned) in the first paint rather than after an effect. */
const THEME_CHOICE_ATTR = 'data-theme-choice';

const isTheme = (v: unknown): v is Theme => v === 'paper' || v === 'graphite';

/**
 * Runs inline in <head>, before any stylesheet is applied. Kept as a plain
 * string so it can be injected with dangerouslySetInnerHTML; no imports, no
 * modern syntax, and every browser API it touches is wrapped in try/catch
 * because localStorage throws in private windows and sandboxed frames and
 * matchMedia is absent in a few embedded ones. The attributes are stamped
 * whatever happens, so the toggle is never left with no state to draw.
 */
export const THEME_BOOT_SCRIPT = `(function(){var c='system',t=null,r;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t==='paper'||t==='graphite'){c=t;r=t}else{r='${DEFAULT_THEME}';try{if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches){r='graphite'}}catch(e){}}try{var d=document.documentElement;d.setAttribute('data-theme',r);d.setAttribute('${THEME_CHOICE_ATTR}',c);d.style.colorScheme=r==='graphite'?'dark':'light'}catch(e){}})();`;

/** What the machine asks for, or the product default where it does not say. */
function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return DEFAULT_THEME;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** The stored choice: a theme, or null for "follow the machine". */
function getChoice(): ThemeChoice {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The theme currently applied. Safe on the server: returns the default there. */
export function getTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute('data-theme');
  if (isTheme(attr)) return attr;
  return getChoice() ?? systemTheme();
}

/** Stamps a theme on <html> and tells listeners. Storage is not touched. */
function stamp(theme: Theme, choice: ThemeChoice): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute(THEME_CHOICE_ATTR, choice ?? 'system');
  root.style.colorScheme = theme === 'graphite' ? 'dark' : 'light';
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}

/**
 * Applies a choice: remembers it, or forgets it when the choice is to follow
 * the machine, and stamps whatever that resolves to.
 */
function applyChoice(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  try {
    if (choice) window.localStorage.setItem(THEME_KEY, choice);
    else window.localStorage.removeItem(THEME_KEY);
  } catch {
    // storage unavailable; the attributes still apply for this page
  }
  stamp(choice ?? systemTheme(), choice);
}

/** Applies a theme and pins it. Choosing a theme is choosing to stop following. */
function applyTheme(theme: Theme): void {
  applyChoice(theme);
}

/**
 * Where the next press goes: off the machine's theme first, then onto the
 * machine's theme pinned, then back to following it. Three presses return you
 * to where you started, and the first press always does what a plain light and
 * dark toggle would have done.
 */
export function nextChoice(choice: ThemeChoice, system: Theme = systemTheme()): ThemeChoice {
  if (choice === null) return system === 'graphite' ? 'paper' : 'graphite';
  if (choice !== system) return system;
  return null;
}

/**
 * The applied theme as React state. Reads the DOM in an effect (never during
 * render) so server and first client render agree, then follows changes made by
 * any other toggle on the page, by another tab, and (while the choice is to
 * follow the machine) by the machine itself.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setThemeState(getTheme());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<Theme>).detail;
      setThemeState(isTheme(detail) ? detail : getTheme());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      // Another tab switched; mirror it here without re-writing storage. A
      // removed key is that tab going back to following the machine.
      const choice = isTheme(e.newValue) ? e.newValue : null;
      stamp(choice ?? systemTheme(), choice);
    };
    window.addEventListener(THEME_EVENT, onChange);
    window.addEventListener('storage', onStorage);

    // The machine can change its mind mid-session (sunset, a scheduled switch).
    // Only followers move with it: a stored choice outranks the machine.
    let media: MediaQueryList | null = null;
    const onSystem = () => {
      if (getChoice() === null) stamp(systemTheme(), null);
    };
    try {
      media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      media?.addEventListener('change', onSystem);
    } catch {
      media = null;
    }

    return () => {
      window.removeEventListener(THEME_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
      media?.removeEventListener('change', onSystem);
    };
  }, []);

  const setTheme = useCallback((t: Theme) => {
    applyTheme(t);
    setThemeState(t);
  }, []);

  return [theme, setTheme];
}

/**
 * The choice as React state, for the one control that has to say which of the
 * three the learner is on. The applied theme comes back with it, because the
 * control's label names both what it is following and what a press would do.
 */
export function useThemeChoice(): {
  choice: ThemeChoice;
  theme: Theme;
  system: Theme;
  set: (c: ThemeChoice) => void;
} {
  const [theme] = useTheme();
  const [choice, setChoiceState] = useState<ThemeChoice>(null);
  const [system, setSystem] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setChoiceState(getChoice());
    setSystem(systemTheme());
    const sync = () => {
      setChoiceState(getChoice());
      setSystem(systemTheme());
    };
    window.addEventListener(THEME_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = useCallback((c: ThemeChoice) => {
    applyChoice(c);
    setChoiceState(c);
  }, []);

  return { choice, theme, system, set };
}
