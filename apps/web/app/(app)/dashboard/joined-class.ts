/**
 * "You joined <class>." said once, on the dashboard the first-run page lands
 * on after it joined a class.
 *
 * The first-run page writes the class's name down only once everything it does
 * has succeeded (the join, the enrolment, the profile), just before it moves to
 * the dashboard; the dashboard takes it, which removes it, so a reload or a
 * later visit says nothing. Kept in this tab's session storage rather than in
 * the address, so no class name or code is left in the address bar. A browser
 * with storage blocked simply lands without the sentence.
 */
const JOINED_KEY = "lsdlc_joined_class";

export function rememberJoinedClass(name: string | undefined | null): void {
  const trimmed = name?.trim();
  if (!trimmed) return;
  try {
    window.sessionStorage.setItem(JOINED_KEY, trimmed);
  } catch {
    // No storage: the dashboard opens without the sentence.
  }
}

/** The class just joined, once: reading it removes it. */
export function takeJoinedClass(): string | null {
  try {
    const name = window.sessionStorage.getItem(JOINED_KEY);
    if (name !== null) window.sessionStorage.removeItem(JOINED_KEY);
    return name || null;
  } catch {
    return null;
  }
}
