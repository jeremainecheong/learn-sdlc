import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';
import { AUTH_HANDOFF_BOOT_SCRIPT } from '@/lib/auth-handoff';
import { BROWSER_CHROME_DARK, BROWSER_CHROME_LIGHT } from '@/lib/manifest';
import { ManifestLink } from '@/lib/manifest-link';
import { SIDEBAR_BOOT_SCRIPT } from '@/lib/sidebar';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import './globals.css';
import './redesign.css';
import '@/components/ui/controls.css';
import './public-theme.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — experiential software engineering`,
    // Pages set only their own name; the brand is appended here so it can
    // never drift or be forgotten on a new page.
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'software development life cycle',
    'SDLC course',
    'learn software engineering',
    'requirements design testing deployment',
    'AI tutor for programming',
    'mutation testing practice',
  ],
  authors: [{ name: 'SMU School of Computing and Information Systems' }],
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: SITE_URL,
    title: `${SITE_NAME} — you already know how to code`,
    description: SITE_DESCRIPTION,
    locale: 'en_SG',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — you already know how to code`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Paper ground and Graphite ground, read from the same two constants the web
  // manifest publishes so the toolbar, an installed shortcut's splash and the
  // page cannot drift apart. The browser chrome follows the system setting and
  // so does the page when nothing is stored: the boot script seeds
  // `data-theme` from prefers-color-scheme, so a first-time visitor on a dark
  // machine never gets a near-black toolbar above a white page. A stored
  // choice still outranks both.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: BROWSER_CHROME_LIGHT },
    { media: '(prefers-color-scheme: dark)', color: BROWSER_CHROME_DARK },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot scripts stamp data-theme and
    // data-sidebar on <html> before React runs, which is the point: the first
    // paint is already the right theme at the right width, but it means the
    // client attribute set differs from the server's. React ignores extra DOM
    // attributes during hydration; the flag keeps dev builds quiet about it.
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Takes the session out of the address bar on the one page it can
            arrive in, while the document is still parsing: before React, and
            before any of the page's own code could report a URL. It returns
            immediately on every other route and everything it touches is
            wrapped in try/catch. See lib/auth-handoff.ts. */}
        <script dangerouslySetInnerHTML={{ __html: AUTH_HANDOFF_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} />
        {/* A manifest is fetched without credentials unless the link says
            otherwise, so a cookie-authenticated proxy would answer 403 to it
            on every page load. See lib/manifest.ts. Written last and emitted
            first: React hoists a <link> above everything this head renders, so
            nothing here may be read as running before the manifest is asked
            for, which is why the sign-in landing, the one page that holds a
            session, renders no link at all. See lib/manifest-link.tsx. */}
        <ManifestLink />
      </head>
      <body className="bg-ground font-sans text-ink">
        {/* Where the top of the tab order is, for anything that has to put it
            back. Monaco moves the browser's sequential focus
            navigation starting point into its own hidden textarea while it
            initialises, so on a workspace room the learner's first Tab would
            land inside the editor, and Tab inside an editor inserts a tab, so
            there would be no way back out to the chrome. `CodeEditor` focuses this
            once the editor is up, which puts the next Tab back on the skip
            link below. It is never a stop of its own: tabindex -1. */}
        <span id="focus-top" tabIndex={-1} aria-hidden className="sr-only" />
        {/* First tab stop on every page: keyboard and screen-reader users must
            be able to skip the nav rather than tabbing it on every route. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-ctl focus:bg-ink focus:px-4 focus:py-2.5 focus:text-[14px] focus:font-medium focus:text-ground"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
