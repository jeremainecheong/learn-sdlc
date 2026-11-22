/**
 * The sections of the project editor, and how the address names the open one.
 *
 * The editor shows one section at a time: Overview, one phase, Validate or
 * Publish. The open section is in the address as `?section=<key>` so a link,
 * a reload and Back land on it. Overview is the default and is written as no
 * `section` at all, the way the class page leaves its default view out of its
 * address.
 */
import { PHASE_ORDER, type PhaseKey } from '@learnsdlc/shared';
import { patchPageHref } from '@/lib/navigation';

export type EditorSection = 'overview' | PhaseKey | 'validate' | 'publish';

/** Every key a `?section=` may name, in the order the tabs are drawn. */
export const EDITOR_SECTION_KEYS: readonly EditorSection[] = Object.freeze([
  'overview',
  ...PHASE_ORDER,
  'validate',
  'publish',
]);

/** The `id` base the section tabs and their panels are drawn from. */
export const SECTION_TABS_ID = 'project-section';

/** The one panel every phase tab controls: the selected phase's tasks. */
export const PHASE_PANEL_ID = 'project-phase-panel';

/** The `id` of a section's tab, as `useTabs` derives it from `SECTION_TABS_ID`. */
function sectionTabId(key: EditorSection): string {
  return `${SECTION_TABS_ID}-tab-${key}`;
}

/**
 * The roles and ids of a section's panel, pointing back at its tab. Overview,
 * Validate and Publish each have their own panel (`project-section-panel-<key>`,
 * as `useTabs` names it); the six phases share one, `project-phase-panel`,
 * labelled by the tab of the phase it is showing.
 */
export function sectionPanelProps(key: EditorSection) {
  return {
    role: 'tabpanel' as const,
    id: isPhaseSection(key) ? PHASE_PANEL_ID : `${SECTION_TABS_ID}-panel-${key}`,
    'aria-labelledby': sectionTabId(key),
    tabIndex: 0,
    'data-project-section': key,
  };
}

export function isPhaseSection(key: string): key is PhaseKey {
  return (PHASE_ORDER as readonly string[]).includes(key);
}

/** The section an address names, or Overview when it names none or one that does not exist. */
export function sectionFromSearch(search: string): EditorSection {
  const named = new URLSearchParams(search).get('section') ?? '';
  return (EDITOR_SECTION_KEYS as readonly string[]).includes(named) ? (named as EditorSection) : 'overview';
}

/** The same address with `section` set to `key`, everything else kept (Overview drops it). */
export function sectionHref(current: string, key: EditorSection): string {
  return patchPageHref(current, { section: key === 'overview' ? null : key });
}

/**
 * Write the open section into the address.
 *
 * `push` for a tab pressed with the pointer or Enter, a step of the path and a
 * validation link, so Back returns to the section the teacher came from:
 * the class page's view tabs push the same way (`updatePageQuery`). The arrow
 * keys open nothing (the row is manual activation), so they write nothing.
 * `replace` for an address put right without the teacher asking (a phase the
 * draft no longer holds, a fragment on arrival). `null` as the state, as
 * `updatePageQuery` does, so the app router copies its own state in.
 */
export function writeSection(key: EditorSection, mode: 'push' | 'replace'): void {
  if (typeof window === 'undefined') return;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  // A hash a step of the path left behind is dropped: the section is the address now.
  const next = sectionHref(`${window.location.pathname}${window.location.search}`, key);
  if (next === current) return;
  if (mode === 'replace') window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
}
