'use client';

/**
 * Follow the machine, Paper, Graphite.
 *
 * Every icon is in the DOM and CSS picks between them from the two attributes
 * the boot script stamps on `<html>` before React runs: `data-theme` for the
 * theme in force, `data-theme-choice` for whether that was chosen or inherited.
 * That is the only way the button can be right on the *first* paint of every
 * load: reading storage in an effect would draw the moon on a dark page for
 * one frame, and because the shell is persistent it would flip on every
 * navigation.
 *
 * The third position lets the product follow the machine's own theme rather
 * than ignore it. The press order is chosen so a two-position
 * habit still works (the first press always takes you off the theme you are
 * looking at, the second pins the machine's own theme, the third goes back to
 * following it), and so the label can stay a plain statement of what the next
 * press does.
 *
 * `useThemeChoice` drives the click and the spoken label, both of which are
 * allowed to settle after mount because neither is drawn.
 */
import { nextChoice, useThemeChoice } from '@/lib/theme';
import { Icon } from './Icon';

const NAME = { paper: 'Paper', graphite: 'Graphite' } as const;
/** Hidden while a theme is pinned; the sun and the moon say which one it is. */
const ONLY_SYSTEM = 'hidden [html[data-theme-choice=system]_&]:block';
/** The pair the cascade already picks between, silenced while following. */
const NOT_SYSTEM = '[html[data-theme-choice=system]_&]:!hidden';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { choice, theme, system, set } = useThemeChoice();
  const next = nextChoice(choice, system);
  const label =
    next === null
      ? 'Follow your system theme'
      : next === 'graphite'
        ? 'Switch to dark theme'
        : 'Switch to light theme';
  const state =
    choice === null
      ? `Theme follows your system, currently ${NAME[theme]}.`
      : `Theme is ${NAME[choice]}.`;

  return (
    <button
      type="button"
      onClick={() => set(next)}
      aria-label={label}
      title={`${state} ${label}.`}
      data-testid="theme-toggle"
      data-theme-choice={choice ?? 'system'}
      className={`theme-toggle ${className}`}
    >
      {/* The screen the theme is coming from, drawn here rather than added to
          the icon set for one caller. */}
      <svg
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={`shrink-0 ${ONLY_SYSTEM}`}
        data-testid="theme-icon-system"
      >
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M9 20h6M12 16v4" />
      </svg>
      {/* when-paper shows on Paper and says "go dark"; when-graphite is its
          twin. While the machine is being followed, neither is the state. */}
      <Icon name="moon" size={15} className={`when-paper ${NOT_SYSTEM}`} />
      <Icon name="sun" size={15} className={`when-graphite ${NOT_SYSTEM}`} />
    </button>
  );
}
