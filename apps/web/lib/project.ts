'use client';

/**
 * Which project the learner is currently looking at.
 *
 * Enrolments are keyed on (userId, projectSlug), so a learner can hold more
 * than one project. Neither a preference remembered in `localStorage` nor a
 * fixed slug answers which one is in view: a remembered slug can name a
 * project this deployment does not ship, and a literal names the wrong
 * project for every learner whose class was assigned another one. The answer
 * is the slug the **server** resolved for this learner
 * (`projectVersionForLearner`'s four steps, their own enrolment first) held
 * for the tab and nothing more.
 *
 * So it is written by whoever loaded a project (`useProject`'s `load`, and the
 * workspace rooms from the phase they opened) and read by the places that need
 * the answer without waiting for a request of their own: the provider's cache
 * key, the in-flight join that keeps a named load and the shell's load from
 * being two fetches of one question, the slug a room falls back to when the
 * phase it loaded names none, and the project setup enrols into.
 *
 * It is **not** persisted, because a value that outlives the tab can name a
 * project this deployment does not ship.
 * And it is not authority: every request still names the slug or names
 * nothing and lets the server resolve it, and the server decides what you are
 * enrolled in.
 */

/**
 * Empty until a load has named one. Every reader already guards on a falsy
 * slug, because "the shell has not loaded yet" is always reachable.
 */
let active = '';

export function getActiveProject(): string {
  return active;
}

/** Called by the workspace, the drill and the pull request after loading a
 * phase; it remembers, for the tab, the slug they name. */
export function setActiveProject(slug: string): void {
  if (slug) active = slug;
}

/**
 * Forget it, because the tab no longer belongs to the account that resolved it.
 *
 * "Held for the tab and nothing more" was half the sentence: the tab outlives
 * the account. A shared lab machine signed one learner out and registered
 * another in the same tab, and this still held the first learner's project
 * (a teacher's, assigned to a class the new account was not in) which setup
 * then enrolled them into.
 *
 * Nothing above this line can tell when that happened, so the sign-out and the
 * change of token are wired where the rest of the per-tab caches already hear
 * about them (`useProject`, which drops its own copies in the same breath).
 * The server refuses the wrong project now either way; this is so the browser
 * stops asking for it.
 */
export function clearActiveProject(): void {
  active = '';
}
