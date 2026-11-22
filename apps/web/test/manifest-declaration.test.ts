/**
 * How the web manifest is declared, and why the app declares it itself.
 *
 * Behind the private preview gate every page load logged a failed fetch of the
 * manifest. A manifest is the one subresource a browser fetches *without*
 * credentials unless the link says otherwise; the gate answers 403 to any
 * request that arrives without its cookie; and the framework's own
 * `<link rel="manifest">` carries no `crossorigin`: it sets one only on
 * Vercel preview deployments, which this is not. On `/login/callback` the
 * console entry for that failure quoted the document URL, and at that moment
 * the URL still carried the session in its fragment.
 *
 * So the app owns the link: one static document under `public/`, one link that
 * asks for credentials, and no `app/manifest.ts` left for the framework to put
 * a second, credential-less link beside it.
 *
 * And no link at all on `/login/callback`. The layout writes the link after the
 * boot script, but React treats `<link>` as hoistable metadata and flushes it
 * above everything the head renders (the document-order cases below run the
 * real renderer and show it) so the scrub cannot be relied on to happen before
 * the manifest is asked for. On the one page that holds a session in its
 * fragment the link is simply not rendered: a sign-in landing is never where an
 * install is started from, and a page that asks for nothing cannot be quoted in
 * a failure.
 *
 * What these cases cannot do: prove that a browser sends the cookie, or that
 * the gate answers 200. Only a request to the running preview shows that. What
 * they can do is fail when the link stops asking for credentials, when it comes
 * back on the callback route, when the document the link points at stops
 * existing, and when the copy inside it drifts from the product's own name and
 * description.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { AUTH_HANDOFF_BOOT_SCRIPT, AUTH_HANDOFF_PATH } from '@/lib/auth-handoff';
import {
  BROWSER_CHROME_DARK,
  BROWSER_CHROME_LIGHT,
  MANIFEST_CROSS_ORIGIN,
  MANIFEST_DECLARATION,
  MANIFEST_HREF,
} from '@/lib/manifest';
import { ManifestLink } from '@/lib/manifest-link';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';

/** The route being rendered, as the router would answer it. */
const route = { path: '/dashboard' };

vi.mock('next/navigation', () => ({ usePathname: () => route.path }));

const WEB_ROOT = resolve(__dirname, '..');
/** The file the declared href actually resolves to, so the two cannot drift. */
const PUBLISHED = resolve(WEB_ROOT, 'public', MANIFEST_HREF.replace(/^\//, ''));
const published = (): Record<string, unknown> =>
  JSON.parse(readFileSync(PUBLISHED, 'utf8')) as Record<string, unknown>;

/**
 * The head the root layout writes, rendered by the renderer that ships with the
 * app: the streaming one, not `renderToStaticMarkup`, because hoisting is the
 * whole point and only the streaming renderer does it.
 */
const document = (): ReactElement =>
  createElement(
    'html',
    { lang: 'en' },
    createElement(
      'head',
      null,
      createElement('script', { dangerouslySetInnerHTML: { __html: AUTH_HANDOFF_BOOT_SCRIPT } }),
      createElement(ManifestLink),
    ),
    createElement('body', null, 'Signing you in'),
  );

const renderDocument = async (): Promise<string> =>
  new Promise<string>((settle, fail) => {
    let html = '';
    const sink = new Writable({
      write(chunk, _encoding, done) {
        html += String(chunk);
        done();
      },
    });
    sink.on('finish', () => settle(html));
    const { pipe } = renderToPipeableStream(document(), {
      onAllReady: () => pipe(sink),
      onError: fail,
    });
  });

beforeEach(() => {
  route.path = '/dashboard';
});

describe('the manifest link', () => {
  it('asks for the manifest with credentials, so the private preview gate sees its cookie', () => {
    const markup = renderToStaticMarkup(createElement(ManifestLink));

    expect(markup).toContain('rel="manifest"');
    expect(markup).toContain(`href="${MANIFEST_HREF}"`);
    // The attribute as a browser reads it, not the React prop name. Without
    // this the fetch is anonymous and the gate refuses it.
    expect(markup).toContain('crossorigin="use-credentials"');
    expect(MANIFEST_CROSS_ORIGIN).toBe('use-credentials');
  });

  it('asks for nothing on the page a session arrives on', () => {
    route.path = AUTH_HANDOFF_PATH;

    expect(renderToStaticMarkup(createElement(ManifestLink))).toBe('');
  });

  // That the root layout renders this link in its head, and declares no
  // manifest of its own beside it, is asserted on the rendered layout in
  // `root-layout.test.tsx`.

  it('leaves no manifest route for the framework to emit a second link from', () => {
    // Regression guard on the deleted file convention. While `app/manifest.ts`
    // exists the framework re-adds its own credential-less link whatever the
    // layout says, and a browser uses the first one it parses.
    for (const convention of ['app/manifest.ts', 'app/manifest.tsx', 'app/manifest.js']) {
      expect(existsSync(resolve(WEB_ROOT, convention)), convention).toBe(false);
    }
  });
});

describe('where the link lands in the document', () => {
  it('is moved above the boot script, whatever order the head is written in', async () => {
    // Why the callback route cannot keep the link. The layout writes the
    // script first and the link last, but React hoists `<link>` out of the
    // head it was written in and flushes it with the rest of the document's
    // metadata, ahead of what the head rendered, so "the script runs first"
    // is not a property of this document, and nothing that depends on it may
    // be claimed. If a React upgrade ever changes that, this case is where it
    // is noticed; the callback route does not depend on the answer either way.
    const html = await renderDocument();

    expect(html).toContain('rel="manifest"');
    expect(html).toContain('__lsdlcAuthHandoff');
    expect(html.indexOf('rel="manifest"')).toBeLessThan(html.indexOf('__lsdlcAuthHandoff'));
  });

  it('is absent from the sign-in landing, where a failed fetch would quote the session', async () => {
    route.path = AUTH_HANDOFF_PATH;

    const html = await renderDocument();

    // Nothing asks for the manifest here, so no 403, no 404 and no rejected
    // content type can put this page's URL in a console entry.
    expect(html).not.toContain('rel="manifest"');
    expect(html).not.toContain(MANIFEST_HREF);
    // The scrub still runs, and it is still the first thing the page does.
    expect(html).toContain('__lsdlcAuthHandoff');
  });
});

describe('the published manifest', () => {
  it('exists where the link points, and is typed as a manifest rather than a download', () => {
    expect(existsSync(PUBLISHED), PUBLISHED).toBe(true);

    // `X-Content-Type-Options: nosniff` is set on every response, so a manifest
    // served under the wrong type is rejected by the browser, which logs the
    // same error on the same page as the 403 this change exists to remove, and
    // looks identical from the outside. Static files under public/ are served
    // by the framework's bundled `send`, so that is the table to ask. If this
    // stops resolving after a framework upgrade, re-check how the static
    // handler types `.webmanifest` rather than deleting the case.
    const send = createRequire(resolve(WEB_ROOT, 'package.json'))('next/dist/compiled/send') as {
      mime?: { lookup?: (ext: string) => string | false };
    };
    expect(typeof send.mime?.lookup, 'the static handler bundles a mime table').toBe('function');
    expect(send.mime!.lookup!('webmanifest')).toBe('application/manifest+json');
  });

  it('says exactly what the app declares', () => {
    // The document is JSON on disk rather than a typed route, so this is what
    // keeps the two halves of the move honest.
    expect(published()).toEqual(MANIFEST_DECLARATION);
  });

  it('keeps the product name, description and ground of the app it installs', () => {
    // Regression guard against drift between the published JSON and lib/site.
    const doc = published();

    expect(doc.short_name).toBe(SITE_NAME);
    expect(doc.name).toBe(`${SITE_NAME} — experiential software engineering`);
    expect(doc.description).toBe(SITE_DESCRIPTION);
    // The landing page, not /dashboard: an installed shortcut is opened by
    // signed-out visitors too, and /dashboard only sends them to sign in.
    expect(doc.start_url).toBe('/');
    expect(doc.scope).toBe('/');
    expect(doc.display).toBe('standalone');
    expect(doc.background_color).toBe(BROWSER_CHROME_LIGHT);
    expect(doc.theme_color).toBe(BROWSER_CHROME_LIGHT);
    expect(doc.icons).toEqual([
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    ]);
  });

  it('keeps the chrome colours the layout and the manifest share', () => {
    // Both read these two constants; `root-layout.test.tsx` asserts the
    // layout's viewport uses them.
    expect(BROWSER_CHROME_LIGHT).toBe('#f4f8fb');
    expect(BROWSER_CHROME_DARK).toBe('#142737');
  });
});
