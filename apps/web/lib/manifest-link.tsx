'use client';

import { usePathname } from 'next/navigation';
import { AUTH_HANDOFF_PATH } from '@/lib/auth-handoff';
import { MANIFEST_CROSS_ORIGIN, MANIFEST_HREF } from '@/lib/manifest';

/**
 * The manifest link, and the one page that does not get one.
 *
 * Everywhere else this is the same link the framework would write, plus
 * `crossorigin="use-credentials"`, so the manifest fetch
 * carries the cookie a cookie-authenticated proxy expects instead of being
 * answered 403 and logged as a failure on every page load. See lib/manifest.ts.
 *
 * `/login/callback` is different, because for a moment it holds the session in
 * its fragment, and a failed fetch is quoted with the document URL it was made
 * from, which would put the session in a console entry.
 * The layout writes the link after the boot script that scrubs that fragment,
 * but source order is not document order: React treats `<link>` as hoistable
 * metadata and flushes it ahead of everything the head renders, which
 * `test/manifest-declaration.test.ts` runs the real renderer to show. So the
 * scrub cannot be relied on to happen first, and `use-credentials` only removes
 * the 403: a 404, a rejected content type or a stale proxy cookie would put the
 * same page's URL in the same console entry.
 *
 * Asking for nothing is the only version of this that is true at every instant,
 * and it costs nothing: a sign-in landing is not a page an install is started
 * from, and a learner is on it for a fraction of a second. Every other route
 * still declares the manifest, so the app stays installable.
 *
 * Where the router cannot name the route, the link is rendered, that is how
 * every other page behaves, and the callback route is the exception, not
 * the default.
 */
export function ManifestLink() {
  const pathname = usePathname();
  if (pathname === AUTH_HANDOFF_PATH) return null;
  return <link rel="manifest" href={MANIFEST_HREF} crossOrigin={MANIFEST_CROSS_ORIGIN} />;
}
