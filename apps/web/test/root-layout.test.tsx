/**
 * What the root layout puts in every page's head, read from the layout itself.
 *
 * The layout is rendered to markup with the two font packages stood in for
 * (they are build-time modules that hand back class names), so these cases
 * read the tags a browser receives, in the order it receives them, and the
 * `metadata` and `viewport` objects the framework turns into more tags.
 *
 * The scripts and the manifest link each have their own tests
 * (`auth-handoff-boot.test.ts`, `manifest-declaration.test.ts`); what is
 * asserted here is that the layout mounts them, and where.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_HANDOFF_BOOT_SCRIPT } from '@/lib/auth-handoff';
import { BROWSER_CHROME_DARK, BROWSER_CHROME_LIGHT, MANIFEST_HREF } from '@/lib/manifest';
import { SIDEBAR_BOOT_SCRIPT } from '@/lib/sidebar';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-sans-variable' } }));
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-mono-variable' } }));

import RootLayout, { metadata, viewport } from '@/app/layout';

const markup = () => renderToStaticMarkup(createElement(RootLayout, null, createElement('main', { id: 'main' }, 'page')));

/** The inline scripts of the head, in document order, by their text. */
const headScripts = (html: string): string[] => {
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  return [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
};

describe('the root layout runs the handoff script before anything can read the URL', () => {
  it('mounts it in the head', () => {
    expect(headScripts(markup())).toContain(AUTH_HANDOFF_BOOT_SCRIPT);
  });

  it('puts it in front of the other boot scripts', () => {
    // It exists to take the session out of the address bar while the document
    // is still parsing, so no other script of the page may run before it.
    expect(headScripts(markup())).toEqual([AUTH_HANDOFF_BOOT_SCRIPT, THEME_BOOT_SCRIPT, SIDEBAR_BOOT_SCRIPT]);
  });
});

describe('the root layout declares the manifest once, with credentials', () => {
  it('renders the credentialed manifest link in the head', () => {
    const html = markup();
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

    expect(head.match(/rel="manifest"/g)).toHaveLength(1);
    expect(head).toContain(`href="${MANIFEST_HREF}"`);
    expect(head).toContain('crossorigin="use-credentials"');
  });

  it('gives the framework no manifest of its own to emit a second link from', () => {
    // A `manifest` key in the metadata would make the framework write its own
    // credential-less link, and a browser uses the first one it parses.
    expect(metadata).not.toHaveProperty('manifest');
  });

  it('shares one pair of chrome colours with the manifest', () => {
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: BROWSER_CHROME_LIGHT },
      { media: '(prefers-color-scheme: dark)', color: BROWSER_CHROME_DARK },
    ]);
  });
});
