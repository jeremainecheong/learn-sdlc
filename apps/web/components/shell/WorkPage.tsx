'use client';

/**
 * A working page: the phase strip and whatever the phase needs below it
 * (usually three columns: explorer, editor, panel) drawn inside the shell.
 *
 * The difference from {@link DocPage} is width. Here the page fills the
 * viewport and scrolls inside its own panes, because code and a persona
 * cannot both be below the fold. The sidebar opens on its rail here: that is
 * decided by the route, in lib/sidebar.ts, so it is true in the first paint
 * rather than declared after one; the learner can widen it, and that choice is
 * kept for the working pages alone. The bar and the sidebar themselves are
 * mounted once, by `app/(app)/layout.tsx`.
 */
import Link from 'next/link';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PhaseDetail, PhaseSummary } from '@learnsdlc/shared';
import { holdsPhase, placeLabel } from '@learnsdlc/shared';
import { dueLine, isPast, useNow } from '@/lib/schedule';
import { phaseArt } from '@/lib/phase';
import { Chip } from '@/components/ui';
import { STATE_LABEL, STATE_TONE, type LearnerState } from '@/components/workspace/gate-state';
import type { Crumb, NavKey, ShellNav } from './types';
import { useShellConfig } from './ShellProvider';
import { PhaseTutorialReplay } from './PhaseTutorial';
import { lessonsOfferedOn } from '@/lib/scenario';
import { useProjectMaybe } from '@/lib/useProject';

/**
 * The line that says which phase you are in and what you are trying to do in
 * it, then the chips that say how it is going, then the two things you can
 * press.
 */
export function PhaseStrip({
  phase,
  headline,
  chips,
  right,
  rowLine,
  menuLine,
  workHeader = false,
  state = null,
  testId,
  titleLevel,
}: {
  /**
   * `dueAt` rides along wherever the caller has the whole phase:
   * the class's due date belongs where the work is done, not only on the
   * phases page. A caller with only a key and a title simply has no date.
   */
  phase: Pick<PhaseSummary, 'key' | 'title'> & Partial<Pick<PhaseSummary, 'dueAt'>> & Partial<Pick<PhaseDetail, 'place' | 'count'>>;
  /** The one sentence for this phase: "Make manager.py true to your contracts". */
  headline?: React.ReactNode;
  /** Status chips: complete_task passes, filter_tasks: 3 failing, … */
  chips?: React.ReactNode;
  /** Run tests / Submit, and the link back to the phase's document. */
  right?: React.ReactNode;
  /**
   * The optional quick check on a Maintenance document page, placed as
   * the workspace's header places it: `rowLine` on the strip's own row where
   * that header keeps it on its row, `menuLine` inside Details where that
   * header keeps it in More. The caller passes one of the two, so no page of
   * the phase draws a row above its header for the offer.
   */
  rowLine?: React.ReactNode;
  menuLine?: React.ReactNode;
  /**
   * The strip is laid out as the workspace's header is. It carries that
   * header's class, so the line on its row shrinks, wraps and hides the place
   * exactly where that header's does; and, as in that header's More menu,
   * Replay tutorial, the phase guide and the reference solution's door are
   * read inside Details, which leaves the row the room it needs for the quick
   * check: the phase, the check, Details and the page's own actions. So is a
   * door back to the workspace that repeats the working-area row's own entry
   * (`back-workspace`).
   */
  workHeader?: boolean;
  /**
   * Where the phase stands, as the workspace header's chip says it: drawn
   * beside the place, in the same words, tone and test id. Only a
   * work header is handed one.
   */
  state?: LearnerState | null;
  testId?: string;
  /**
   * Draw the phase's name as the room's `h1`.
   *
   * Without it a working room's only heading would be `WorkPage`'s sr-only
   * one, 14px and unreadable, under a 19px heading inside a tab: the ramp upside down
   * on every one of these routes. The strip is the line every working room
   * draws and the one place "which room is this" is answered, so it carries
   * the heading, visibly, at the top of the ramp. A room that passes this
   * leaves `WorkPage`'s `heading` off, or the page has two.
   */
  titleLevel?: 1;
}) {
  // Read after mount: a date printed on the server is in the wrong zone.
  const now = useNow();
  const due = phase.dueAt ?? null;
  // The guide teaches the reference project's story,
  // so a phase that is the teacher's own draws no door to it.
  const held = useProjectMaybe();
  const lessons = lessonsOfferedOn(held?.enrollment, phase.key, held?.details);
  // "Phase 2 of 3": the phase's place in its own project. A phase detail
  // carries both numbers; a bare summary is placed in the enrolment the
  // shell holds, and with neither the strip names no number.
  const where = phase.place && phase.count
    ? `Phase ${phase.place} of ${phase.count}`
    : held?.enrollment && holdsPhase(held.enrollment, phase.key)
      ? placeLabel(held.enrollment, phase.key)
      : null;
  const flatten = (node: ReactNode): ReactNode[] => Children.toArray(node).flatMap(child => isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment ? flatten(child.props.children) : [child]);
  // On a strip laid out as the workspace's header, a door the page's working-area row already offers (the
  // planted bugs page's "Back to the workspace", beside the row's edit entry, which goes there too) is read in Details too, as the
  // reference solution's is, so the row keeps one 55 px line for the quick check and the page's own actions.
  const secondaryIds = new Set(['open-brief', 'open-document', 'header-mutants', 'open-pipeline', 'header-run-app', ...(workHeader ? ['solution-open', 'back-workspace'] : [])]);
  const actions = flatten(right);
  // A control that says where it goes (the header's Submit: on the row while it leads, inside
  // Details when there is nothing to resubmit, by the workspace header's rule) is placed where it says.
  const placedIn = (node: ReactNode) => {
    if (!isValidElement(node) || typeof node.type !== 'function') return null;
    const place = (node.type as { headerPlacement?: (props: unknown) => 'row' | 'details' }).headerPlacement;
    return place ? place(node.props) : null;
  };
  const isSecondary = (node: ReactNode) => placedIn(node) === 'details' || (placedIn(node) === null && isValidElement<{ testId?: string; 'data-testid'?: string }>(node) && secondaryIds.has(node.props.testId ?? node.props['data-testid'] ?? ''));
  const primary = actions.filter(action => !isSecondary(action));
  const secondary = actions.filter(isSecondary);
  // "Later" removes its own button from inside Details, so keyboard focus goes
  // back to the Details summary rather than to the document's body, as the
  // workspace header's menu does.
  // And on a strip laid out as the workspace's header, a door used inside
  // Details closes it, as that header's menu does: Replay tutorial points at
  // controls the open panel would cover.
  const afterLater = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const disclosure = event.currentTarget.closest('details');
    if (!target || !disclosure) return;
    if (target.closest('[data-testid="concept-prompt-skip"]')) {
      disclosure.open = false;
      disclosure.querySelector('summary')?.focus();
      return;
    }
    const door = target.closest('a, button');
    if (!workHeader || !door || (door as HTMLButtonElement).disabled) return;
    disclosure.open = false;
  };
  return (
    <div className={workHeader ? 'phase-strip-approved phase-header phase-header--doc' : 'phase-strip-approved'} data-testid={testId ?? 'phase-strip'}>
      <div className="phase-strip-identity">
        <img src={phaseArt(phase.key)} alt="" width={36} height={36} />
        {titleLevel === 1 ? <h1 data-testid="phase-title">{phase.title}</h1> : <span data-testid="phase-title">{phase.title}</span>}
      </div>
      {/* The phase's place on the strip itself, as PhaseHeader draws it, not only in Details. */}
      {where && <span className="phase-header-place tabular-nums" data-testid="phase-place">{where}</span>}
      {state && <Chip tone={STATE_TONE[state]} testId="phase-state">{STATE_LABEL[state]}</Chip>}
      <div className="phase-strip-spacer" />
      {rowLine}
      {!workHeader && <PhaseTutorialReplay />}
      {!workHeader && lessons && <Link href={`/learn/${phase.key}`} className="phase-strip-guide">Optional phase guide</Link>}
      <details className="phase-strip-details" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary>Details <ChevronDown size={13} aria-hidden="true" /></summary>
        <div className="phase-strip-detail-panel" onClick={afterLater}>
          {where && <strong className="tabular-nums">{where}</strong>}
          {headline && <p>{headline}</p>}
          {menuLine}
          {now !== null && due && <Chip tone={isPast(due, now) ? 'warn' : 'neutral'} testId="phase-strip-due">{dueLine(due, now)}</Chip>}
          {chips && <div className="phase-strip-chips">{chips}</div>}
          {workHeader
            ? <div className="phase-strip-secondary" role="group" aria-label="Phase actions">
                <PhaseTutorialReplay />
                {lessons && <Link href={`/learn/${phase.key}`} className="phase-strip-guide">Optional phase guide</Link>}
                {secondary}
              </div>
            : secondary.length > 0 && <div className="phase-strip-secondary">{secondary}</div>}
        </div>
      </details>
      {primary.length > 0 && <div className="phase-strip-primary">{primary}</div>}
    </div>
  );
}

export function WorkPage({
  crumbs,
  active = 'work',
  nav,
  heading,
  strip,
  children,
  testId,
}: {
  crumbs?: Crumb[];
  active?: NavKey;
  /** Only `paletteGroups` and `notificationsHref` are read, and the rest is accepted and ignored; see DocPage. */
  nav?: ShellNav;
  /**
   * The room's name, as the phase strip says it. A working page draws its
   * heading nowhere a heading can be read (the strip is a line of chips, and
   * the IDE's own title lives inside one tab and leaves with it) so the `h1`
   * every route needs is written here, once, and spoken rather than drawn.
   * A page that has a visible `h1` of its own leaves this off.
   */
  heading?: React.ReactNode;
  /** A {@link PhaseStrip}. Omitted only by a work page that has no phase. */
  strip?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  useShellConfig({
    crumbs,
    active,
    notificationsHref: nav?.notificationsHref,
    paletteGroups: nav?.paletteGroups,
  });

  return (
    // #main is the skip link's target (app/layout.tsx), and tabIndex -1 is
    // what moves focus rather than only scrolling: Safari does the latter on
    // an element that cannot hold focus, which leaves the caret in the nav.
    <main
      id="main"
      tabIndex={-1}
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
      data-testid={testId}
    >
      {heading && (
        <h1 className="sr-only" data-testid="work-heading">
          {heading}
        </h1>
      )}
      {strip}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </main>
  );
}
