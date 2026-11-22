import type { UserProfile } from '@learnsdlc/shared';

/** A return destination remains local after browser URL normalization, too. */
export function safeLocalPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'https://learnsdlc.invalid');
    if (url.origin !== 'https://learnsdlc.invalid' || url.pathname.startsWith('//')) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

/** The same home destination for sign-in, the brand and recovery links. */
export function homeHrefFor(user: Pick<UserProfile, 'role' | 'onboardingCompleted'> | null | undefined): string {
  if (user?.role === 'INSTRUCTOR' || user?.role === 'ADMIN') return '/teacher';
  return user?.onboardingCompleted === false ? '/onboarding' : '/dashboard';
}

type QueryPatch = Record<string, string | null | undefined>;

/** Any origin will do to parse a local address: only its path, query and fragment are kept. */
const PARSE_BASE = 'http://learnsdlc.local';

/** Preserve unrelated URL state when a page changes one of its own controls. */
export function patchPageHref(href: string, patch: QueryPatch): string {
  const url = new URL(href, PARSE_BASE);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Next integrates native history.pushState and replaceState with useSearchParams, so this changes the query without a server navigation. */
export function updatePageQuery(patch: QueryPatch, mode: 'push' | 'replace' = 'push') {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const next = patchPageHref(current, patch);
  if (next === current) return;
  if (mode === 'replace') window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
}

export function lessonChapter(value: string | null, count: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 0;
  const index = Number(value) - 1;
  return Number.isSafeInteger(index) && index < count ? index : 0;
}

/** A dossier may return only to an actual teacher roster, never an arbitrary redirect. */
export function teacherReturnHref(value: string | null, userId: string): string {
  const fallback = `/teacher?learner=${encodeURIComponent(userId)}`;
  const local = safeLocalPath(value, fallback);
  const pathname = new URL(local, PARSE_BASE).pathname;
  return pathname === '/teacher' || pathname === '/teacher/class' ? local : fallback;
}
