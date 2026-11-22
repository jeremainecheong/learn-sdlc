import type { MetadataRoute } from 'next';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';

/**
 * The web manifest, declared by the app instead of by the framework.
 *
 * Why the app owns this. A manifest is the one subresource a browser fetches
 * without credentials unless the link asks for them, and the framework's file
 * convention emits `<link rel="manifest">` with no `crossorigin` (it adds one
 * only on a Vercel preview deployment, which this is not). A deployment behind
 * a cookie-authenticated proxy answers that uncredentialed request with 403, so
 * every page load would log a failed fetch, and on `/login/callback` the
 * console entry for it would quote a document URL that still carries the
 * session in its fragment. `use-credentials` makes the browser send the cookie
 * it already holds: the same link, plus that attribute.
 *
 * Nothing about the boundary moves. A browser the proxy has not admitted still
 * has no cookie and still gets 403; an admitted one stops logging an error at
 * itself.
 *
 * The attribute is not reachable through the metadata API, so the document is
 * a static file under `public/` and the link is written by the app.
 * `test/manifest-declaration.test.ts` holds that file to
 * {@link MANIFEST_DECLARATION}, which reads the product's name and description
 * from `lib/site.ts`, so publishing it as JSON costs no drift.
 *
 * This module is the declaration; `lib/manifest-link.tsx` is the link, and it
 * is the one that knows which page does not get one. Keeping the two apart is
 * what lets the root layout read the chrome colours below into its `viewport`
 * export: a `'use client'` module's exports are not values a server component
 * can read.
 */
export const MANIFEST_HREF = '/manifest.webmanifest';

/** What makes the browser send a cookie-authenticated proxy's cookie with the fetch. */
export const MANIFEST_CROSS_ORIGIN = 'use-credentials' as const;

/**
 * The browser chrome, and the ground an installed shortcut opens on. These are
 * the live Paper and Graphite grounds, read by both the root layout's
 * `viewport.themeColor` and the manifest below, so the toolbar, the splash and
 * the page cannot disagree.
 */
export const BROWSER_CHROME_LIGHT = '#f4f8fb';
export const BROWSER_CHROME_DARK = '#142737';

/**
 * What `public/manifest.webmanifest` must say. Typed as the framework's own
 * manifest shape so the published document keeps the check it had while it was
 * a route.
 */
export const MANIFEST_DECLARATION: MetadataRoute.Manifest = {
  name: `${SITE_NAME} — experiential software engineering`,
  short_name: SITE_NAME,
  description: SITE_DESCRIPTION,
  // The landing page, not /dashboard: an installed shortcut is opened by
  // signed-out visitors too, and /dashboard only sends them to sign in.
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: BROWSER_CHROME_LIGHT,
  theme_color: BROWSER_CHROME_LIGHT,
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
  ],
};
