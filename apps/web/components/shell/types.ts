import type { PhaseKey, PhaseSummary } from '@learnsdlc/shared';
import type { IconName } from '@/components/Icon';

/** One breadcrumb in the top bar. The last one is the page and is not a link. */
export type Crumb = { label: string; href?: string; testId?: string };

/** Which nav entry is lit. Pages pass it; the shell falls back to the route. */
export type NavKey =
  | 'home'
  | 'learn'
  | 'progress'
  | 'feedback'
  | 'profile'
  | 'map'
  | 'work'
  | 'artefacts'
  // The dossier: the whole project as one printable document.
  | 'dossier'
  | 'journal'
  | 'join'
  | 'class'
  // A teacher's projects: the authoring surface, a row of its own.
  | 'projects'
  // The teacher guide.
  | 'guide'
  | 'accounts'
  | 'account';

/** A row in the jump palette. */
export interface PaletteItem {
  /** The thing itself: a criterion, a function, a test, an artefact, a verb. */
  label: string;
  /** Where it lives, one line: "US-4.1, Overdue report", "manager.py, line 83". */
  detail?: string;
  /** Right-aligned outcome or key: "passing", "open file", "explain", "⌘⇧↵". */
  hint?: string;
  icon?: IconName;
  /** Draws the phase numeral tile instead of an icon. */
  phaseKey?: PhaseKey;
  /** The phase's place in its project, the number the tile draws. */
  place?: number;
  /** Where Enter goes. Ignored when `onSelect` is given. */
  href?: string;
  /** A discoverable, unavailable destination. It never performs an action. */
  disabled?: boolean;
  /** What Enter does instead of navigating. */
  onSelect?: () => void;
  /**
   * Words the row should answer to but does not show.
   *
   * A criterion's row draws its story ("US-4") as the detail, so without these
   * words the file it lives in would be searchable inside the IDE and nowhere
   * else, and a node's own id would not be
   * searchable at all. The palette
   * promises "criteria, contracts, code, tests, artefacts and actions"; this is
   * how a row keeps that promise without a second line on screen.
   */
  keywords?: string;
}

/** A titled group of palette rows: Criteria, Code, Tests, Artefacts, Actions. */
export interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

/**
 * What the chrome needs beyond the route: the project's phases and scores for
 * the sidebar, the open-question count for the bell, and anything extra the
 * page wants findable in ⌘K.
 *
 * Pages already hold all of this from their own loader, so the shell costs no
 * extra request; a page with none of it renders the links alone.
 */
export interface ShellNav {
  projectTitle?: string;
  phases?: PhaseSummary[];
  /** The phase the learner is in, where "Work" and the sidebar highlight go. */
  currentPhaseId?: string;
  /** Recorded mentor tokens used today, for usage diagnostics. */
  tokensToday?: number;
  /** The bell's numeric badge: open review questions plus hints waiting. */
  notifications?: number;
  /** Where the bell goes. Defaults to the current phase's review, else /journal. */
  notificationsHref?: string;
  /** Extra palette groups this page can offer (criteria, code, tests, artefacts). */
  paletteGroups?: PaletteGroup[];
}
