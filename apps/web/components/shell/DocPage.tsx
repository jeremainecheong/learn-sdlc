'use client';

/**
 * A document page: one column of panels, drawn inside the shell.
 *
 * Everything that is read rather than typed into lives in this frame: Home,
 * Phases, Map, Journal, Artefacts, the pull request, the kill matrix, the
 * incident drill, the change request, the class and a learner's detail. The
 * frame owns the width (1440 max), the padding (24) and the rhythm between
 * panels (14), so no page has to decide those and none of them disagree.
 *
 * It does not draw the bar or the sidebar. Those are mounted once by
 * `app/(app)/layout.tsx`; this frame *declares* what it wants of them (the
 * breadcrumbs, which entry is lit, this page's palette rows) before the
 * browser paints. What it does not declare is the sidebar's width: that is the
 * learner's, and a document page never takes it away.
 */
import type { Crumb, NavKey, ShellNav } from './types';
import { useShellConfig } from './ShellProvider';

export function DocPage({
  crumbs,
  active,
  nav,
  title,
  purpose,
  purposeInline,
  chips,
  right,
  aside,
  children,
  testId,
  titleTestId,
}: {
  crumbs?: Crumb[];
  active?: NavKey;
  /**
   * The shell derives the phases, the current phase and the bell's count from
   * the project provider, so only two fields here are read: this page's
   * `paletteGroups` and an override for the bell panel's `notificationsHref`.
   * The rest of {@link ShellNav} is accepted and ignored, so a page that
   * builds a whole one compiles and behaves.
   */
  nav?: ShellNav;
  /** The h1. Omit for a page that draws its own heading inside the column. */
  title?: React.ReactNode;
  /** One line under the title saying what the page is for. */
  purpose?: React.ReactNode;
  /**
   * Stack the purpose directly under the title inside the title row's left
   * block, rather than on its own full-width line under the whole row. The map
   * needs this: its controls sit at the right of the same row as the purpose.
   */
  purposeInline?: boolean;
  /** Sits on the title's baseline: the phase line, status chips, a count. */
  chips?: React.ReactNode;
  /** Buttons at the right of the title row. */
  right?: React.ReactNode;
  /**
   * A full-height column flush against the right edge, a sibling of main
   * rather than a cell inside its padded column, the map's node inspector.
   * It is rendered here rather than declared, so it goes when the page goes.
   */
  aside?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
  /** Test id for the h1, e.g. dashboard-title, phases-title, journal-title. */
  titleTestId?: string;
}) {
  useShellConfig({
    crumbs,
    active,
    notificationsHref: nav?.notificationsHref,
    paletteGroups: nav?.paletteGroups,
  });

  return (
    <>
      {/* The skip link in app/layout.tsx points at #main, and this is the
          element every document page is drawn in, so the id belongs here. The
          tabindex is what makes the jump work: without it Safari scrolls the
          heading into view and leaves focus in the nav, so the next Tab is
          back at the top of the chrome. */}
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto" data-testid={testId}>
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3.5 p-4 sm:p-6">
          {(title || chips || right) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {title && (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h1 className="h1 min-w-0" data-testid={titleTestId}>
                    {title}
                  </h1>
                  {purpose && purposeInline && (
                    <p className="purpose max-w-[80ch]">{purpose}</p>
                  )}
                </div>
              )}
              {chips}
              <span className="flex-1" aria-hidden />
              {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
            </div>
          )}
          {purpose && !purposeInline && <p className="purpose -mt-2 max-w-[80ch]">{purpose}</p>}
          {children}
        </div>
      </main>
      {aside}
    </>
  );
}
