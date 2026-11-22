'use client';

/**
 * The pass banner and the way out of a passed phase.
 *
 * One component, mounted by every room a passed phase can be read in: the
 * phase room, the design studio, the requirements workspace, and the document
 * frame that draws the case file, the change request, the pull request, the
 * kill matrix, the incident drill and the reference solution, so no sub-route
 * of a passed phase says nothing and offers no way forward.
 *
 * Exactly one of these may be rendered per route. `gate-banner` and
 * `open-reflection` are pressed without a first-match narrowing by several
 * harnesses, and two merge sheets would fight each other over the body's
 * overflow.
 *
 * A room is told its phase rather than asked to share the shell's copy: the
 * room's own detail is refreshed the moment a verdict lands, it does not wait
 * on the shell's next project fetch, and it is still right when that fetch
 * fails. {@link ShellPhaseGateBanner} is for a frame that holds no detail of
 * its own and reads the enrolment the shell already loaded.
 */
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { PhaseEvidenceGap, PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';
import { andList, isLastPhase } from '@learnsdlc/shared';
import type { EnrollmentView } from '@learnsdlc/shared';
import { api } from '@/lib/api';
import { refreshPhaseRecords } from '@/lib/records';
import { invalidateProject, useProjectMaybe } from '@/lib/useProject';
import { ProjectContext } from '@/lib/project-context';
import { doorWithTasks, phaseDoorHref, roomHref } from '@/components/shell/routes';
import { Button } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { MergePanel, REFLECTION_MIN, reflectionLength } from './MergePanel';
import { taskRoomHref } from './TaskPanel';
import { CREDIT_EXPLANATION, STATE_LABEL } from './gate-state';
import { signOffPassLine } from './signoff-status';
import { movedOnFrom } from './moved-on';

/**
 * What the banner needs to know about the phase it is announcing.
 *
 * `evidenceNeeded` is the API's own answer to "would
 * Continue be refused?": present only on a passed phase whose strict-evidence
 * gate still wants a reviewed pass of the named tasks, which is what a
 * teacher's Sign off or phase-wide Pass leaves behind. `key` and `tasks` are
 * what the door to each named task is built from. All three are optional: a
 * phase the gate wants nothing more of carries no `evidenceNeeded`, a caller
 * may pass a phase without the other two, and a banner with none of them is
 * the plain pass banner.
 */
export type PhaseGatePhase = Pick<PhaseSummary, 'status' | 'title' | 'order' | 'bestScore' | 'reflection'> &
  Partial<Pick<PhaseSummary, 'key'>> & {
    evidenceNeeded?: PhaseEvidenceGap[];
    tasks?: PhaseTaskView[];
    /** A pass ahead of the phase the learner stands on. */
    notReachedYet?: true;
  };

/**
 * Where a task the gate is still waiting on is submitted.
 *
 * The task list's own door when the phase carries one (a quiz opens its paper,
 * the phase room's own task opens that room, any other task opens the
 * workspace focused on it). On a phase with one task the key is `''` and
 * the door is the phase's own room. With neither, the workspace focused by
 * `?task=`, which is the route every task's room answers.
 *
 * A gap in an EARLIER phase (`gap.phaseId`, the last phase's completion arm)
 * opens that phase: its task by `?task=`, or its own room where the whole
 * phase needs a pass again.
 */
export function evidenceDoorHref(
  phaseId: string,
  phase: Pick<PhaseGatePhase, 'key' | 'status' | 'tasks'>,
  gap: PhaseEvidenceGap,
): string {
  if (gap.phaseId && gap.phaseId !== phaseId) {
    if (gap.key) return `/workspace/${gap.phaseId}?task=${encodeURIComponent(gap.key)}`;
    if (!gap.phaseKey) return `/workspace/${gap.phaseId}`;
    return gap.phaseKey === 'requirements'
      ? `/workspace/${gap.phaseId}/issue`
      : roomHref({ id: gap.phaseId, key: gap.phaseKey, status: 'in_progress' });
  }
  const room = { id: phaseId, key: phase.key!, status: phase.status };
  const listed = gap.key ? phase.tasks?.find((task) => task.key === gap.key) : undefined;
  if (listed && phase.key) return taskRoomHref(room, phase.tasks, listed);
  if (!gap.key) {
    if (!phase.key) return `/workspace/${phaseId}`;
    return phase.key === 'requirements' ? `/workspace/${phaseId}/issue` : roomHref(room);
  }
  return `/workspace/${phaseId}?task=${encodeURIComponent(gap.key)}`;
}

/** A gap in another phase, by the name a learner knows it by. */
function elsewhereName(gap: PhaseEvidenceGap): string {
  return gap.key ? `${gap.title} in ${gap.phaseTitle ?? 'an earlier phase'}` : (gap.phaseTitle ?? gap.title);
}

// The rule for "moved on" lives in its own module, so the workspace layout reads it for the
// first-visit tutorial without loading this band.
export { movedOnFrom };

/**
 * The shared chrome, which a room may replace with a treatment of its own.
 * One slim strip: the label and its sentence on one line where they
 * fit, the band's own action on the right.
 */
const CHROME = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b-1.5 border-edge bg-passtint px-4 py-1.5';

/**
 * The chrome of a banner that holds the learner where they are:
 * the waiting tint, never the pass tint, because green there would say "go" over a
 * state that blocks. A room's own treatment keeps its shape and trades its
 * pass tint for the waiting one.
 */
function waitingChrome(className: string | undefined): string {
  return (className ?? CHROME).replace(/\bbg-passtint\b/g, 'bg-warntint');
}

export interface PhaseGateBannerProps {
  phaseId: string;
  /** The room's copy of the phase, or null while the room has none yet. */
  phase: PhaseGatePhase | null;
  /** The project's last phase completes the project rather than continuing. */
  isLast: boolean;
  /**
   * A room's own banner treatment, used **instead of** the shared chrome.
   * `phase-gate-banner` is kept either way, so the mobile rule and the two
   * verification scripts that measure the banner by that class still find it.
   */
  className?: string;
  /**
   * Flush this room's unsaved buffer before the advance, or refuse it. May
   * reject; the message reaches the merge sheet's own error line and the
   * learner stays where they are with nothing recorded.
   */
  onBeforeContinue?: () => Promise<void>;
  /**
   * The advance has been recorded and the next phase is open. A room that
   * holds copies of this phase drops them here rather than in
   * {@link PhaseGateBannerProps.onBeforeContinue}: the guard runs before the
   * reflection and the advance, so a cache emptied there can be refilled by a
   * read of the phase as it still was, and the advance that would have
   * justified emptying it may never happen at all.
   */
  onAdvanced?: () => void;
  /**
   * The Continue pressed in this band did not go ahead (the room refused it, or a request failed), so the
   * enrolment is as it was. A room that holds its own state for "Continue pressed here" lets it go here, as the
   * band does.
   */
  onContinueFailed?: () => void;
  /**
   * Whether the merge sheet is up, for a room that has to know: the phase
   * room suppresses three keyboard shortcuts while it is. Left out, the banner
   * keeps that state itself.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Open the room's review where it has one: the band then offers
   * "View review" beside its own action. Left out, nothing is drawn for it.
   */
  onViewReview?: () => void;
  /**
   * The task the room is working in, where the room's own header already
   * offers its Submit: the band does not repeat that door. Doors to
   * other tasks and other phases are still drawn.
   */
  roomTaskKey?: string;
}

/**
 * The review on screen: the room's Review tab selected inside a code surface
 * showing its results (`data-focus-show="results"`, what the workspace's
 * `viewReview` sets). A selected Review tab alone is not the review in view:
 * the focused mode showing Code hides the lower panel, a collapsed results
 * split hides the tab's contents, and after a Submit the code view keeps the
 * review only as the lower strip, where the band's door is the way to the
 * full-height review.
 */
export const REVIEW_TAB_SHOWN = '[data-focus-show="results"] [data-testid="tab-feedback"][aria-selected="true"]';
const reviewTabShown = () => typeof document !== 'undefined' && document.querySelector(REVIEW_TAB_SHOWN) !== null;
/**
 * Read again when a tab's selection or a surface's view changes, and on every
 * render of the band: only those two attributes are watched, so an editor's
 * keystrokes cost no query of the document.
 */
function subscribeReviewTab(listener: () => void) {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-selected', 'data-focus-show'] });
  return () => observer.disconnect();
}

/**
 * "View review", the band's second door where the room has a review to show.
 *
 * Not drawn while the review is the thing on screen (the room's
 * Review tab selected in the results view, `REVIEW_TAB_SHOWN`): the door would
 * lead where the learner already is. Drawn whenever the review is not in
 * view. It is read from the page itself, so a room says nothing more to the
 * band. When the press that opens the review takes
 * the door away, focus goes to the Review tab rather than to the page's body.
 */
function ViewReview({ onViewReview }: { onViewReview?: () => void }) {
  const shown = useSyncExternalStore(subscribeReviewTab, reviewTabShown, () => false);
  const pressed = useRef(false);
  useEffect(() => {
    if (!shown || !pressed.current) return;
    pressed.current = false;
    if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>(REVIEW_TAB_SHOWN)?.focus();
  }, [shown]);
  if (!onViewReview || shown) return null;
  return (
    <Button size="sm" variant="secondary" testId="gate-view-review" onClick={() => { pressed.current = true; onViewReview(); }}>
      View review
    </Button>
  );
}

/**
 * The tasks of this phase the teacher signed off. A task marked as
 * needing the teacher's sign-off (`evidence: 'signed-off'`, the API's
 * `taskView`) is passed only once the teacher countersigns a passing review
 * (signoff-status.ts), so a passed one is a sign-off that happened. Read from
 * the task list the band is already handed; nothing when it holds none.
 */
export function signedOffTitles(phase: Pick<PhaseGatePhase, 'tasks'>): string[] {
  return (phase.tasks ?? []).filter((task) => task.evidence === 'signed-off' && task.status === 'passed').map((task) => task.title);
}

/**
 * The band for a room whose review asks for more (Needs revision) or whose
 * reviewed pass waits on the teacher's countersignature. The phase room draws
 * it where {@link PhaseGateBanner} has nothing to say; it opens nothing and
 * changes no gate.
 */
export function ReviewBand({
  state,
  onViewReview,
  isLast = false,
}: {
  state: 'revise' | 'awaiting';
  onViewReview?: () => void;
  /** The project's last phase: the sign-off words say it completes the project, not that a next phase opens. */
  isLast?: boolean;
}) {
  return (
    <div className={`phase-gate-banner review-band ${waitingChrome(undefined)}`} data-testid="review-band" data-gate={state}>
      <Icon name="merge" size={16} className="shrink-0 text-warn" />
      <p className="min-w-0 flex-1 text-[13px] text-ink2" data-testid="review-band-text">
        <strong className="text-[13.5px] font-semibold text-ink">{STATE_LABEL[state]}.</strong>{' '}
        {state === 'awaiting'
          ? signOffPassLine(isLast)
          : 'Your last review found criteria still to meet. Read it, revise, then submit again.'}
      </p>
      <span className="flex flex-wrap items-center gap-2">
        <ViewReview onViewReview={onViewReview} />
      </span>
    </div>
  );
}

export function PhaseGateBanner({
  phaseId,
  phase,
  isLast,
  className,
  onBeforeContinue,
  onAdvanced,
  onContinueFailed,
  open,
  onOpenChange,
  onViewReview,
  roomTaskKey,
}: PhaseGateBannerProps) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const showReflection = open ?? ownOpen;
  const setShowReflection = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setOwnOpen(next);
  };

  if (!phase || phase.status !== 'passed') return null;

  // The room's own Submit is in its header; the band does not draw it twice.
  // Only a door into this very room is the header's: a task worked in another
  // room (the backlog, the design board) keeps its door here. Both arms that
  // offer Submit doors read this, the ahead arm included.
  const notTheHeaders = (gaps: PhaseEvidenceGap[]) =>
    roomTaskKey === undefined
      ? gaps
      : gaps.filter((gap) => gap.key !== roomTaskKey || evidenceDoorHref(phaseId, phase, gap).split('?')[0] !== `/workspace/${phaseId}`);

  /*
   * Passed ahead of the learner.
   *
   * A teacher's Unlock early and Pass make a phase the learner has not reached
   * read passed, and `advance` refuses it until they reach it: it is not the
   * phase they stand on. "Phase evidence accepted" with a Continue would only
   * come back "This phase must pass before advancing." So the room says what
   * is true instead, and offers nothing it would refuse. The
   * banner reads only the phase it is handed, so every room that mounts it,
   * inside the shell or not, says the same.
   */
  if (phase.notReachedYet) {
    /*
     * Which of two true things: the API names on
     * an ahead phase what the strict gate will still want once the learner
     * reaches it (`evidenceNeeded`). Nothing named is their own reviewed pass,
     * submitted while the phase was unlocked early, and reaching it does open
     * Continue. A named task is a teacher's board-only Pass, and reaching it
     * does not: so the room says so, and offers the review it will need.
     */
    const waiting = phase.evidenceNeeded?.filter(Boolean) ?? [];
    const submittable = waiting.filter((gap) => !gap.noPapersLeft);
    const spent = waiting.filter((gap) => gap.noPapersLeft);
    const aheadDoors = notTheHeaders(submittable);
    const one = waiting.length === 1;
    return (
      <div className={`phase-gate-banner ${waitingChrome(className)}`} data-testid="gate-banner" data-gate="not-reached">
        <Icon name="merge" size={16} className="shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink">Marked passed ahead of time</p>
          {waiting.length === 0 ? (
            <p className="text-[12.5px] text-ink2">
              {phase.title} is marked passed, but it is ahead of the phase you are on. Continue opens here once you
              reach it, so finish the phase you are on first.
            </p>
          ) : (
            <p className="text-[12.5px] text-ink2">
              {phase.title} is marked passed, but it is ahead of the phase you are on, and{' '}
              {one && !waiting[0].key ? 'it' : andList(waiting.map((gap) => gap.title))} {one ? 'has' : 'have'} no
              reviewed pass of {one ? 'its' : 'their'} own yet. Continue opens here once you reach it and{' '}
              {one ? 'it has' : 'each has'} one
              {submittable.length > 0 && (
                <>
                  , so submit{' '}
                  {submittable.length === waiting.length
                    ? one
                      ? 'it'
                      : 'each one'
                    : andList(submittable.map((gap) => gap.title))}{' '}
                  for review
                </>
              )}
              .
              {spent.length > 0 && (
                <>
                  {' '}
                  {andList(spent.map((gap) => gap.title))} {spent.length === 1 ? 'has' : 'have'} no papers left, so
                  your teacher has to reset {spent.length === 1 ? 'it' : 'them'} before you can sit{' '}
                  {spent.length === 1 ? 'it' : 'them'} again.
                </>
              )}
            </p>
          )}
        </div>
        {(waiting.length > 0 || onViewReview) && (
          <span className="flex flex-wrap items-center gap-2">
            <ViewReview onViewReview={onViewReview} />
            {aheadDoors.map((gap) => (
              <Button
                key={gap.key || 'phase'}
                size="sm"
                href={evidenceDoorHref(phaseId, phase, gap)}
                testId={`gate-evidence-submit-${gap.key || 'phase'}`}
              >
                Submit {gap.title} for review
              </Button>
            ))}
            {spent.map((gap) => (
              <Button
                key={gap.key}
                size="sm"
                variant="secondary"
                href={evidenceDoorHref(phaseId, phase, gap)}
                testId={`gate-evidence-open-${gap.key}`}
              >
                Open {gap.title}
              </Button>
            ))}
          </span>
        )}
      </div>
    );
  }

  /*
   * Passed on the board, not yet through the gate.
   *
   * A teacher's Sign off or phase-wide Pass writes the task and the phase as
   * passed without a reviewed revision behind them, and the strict-evidence
   * gate is right to refuse Continue over that: a countersignature is the
   * second half of a pass, never the first. So the room says what is true,
   * the work is credited, and each named task still needs a review of its own,
   * and offers the door to submit it, never a Continue the server refuses.
   * Once that review passes, the task moves, the phase is read again and this
   * field is gone.
   */
  const gaps = phase.evidenceNeeded?.filter(Boolean) ?? [];
  if (gaps.length > 0) {
    // Three kinds of gap, each with its own true sentence. The wording is
    // about the board, not about who wrote it: the field is also served over a
    // stored pass no teacher touched that the gate reads as no evidence, so
    // "your teacher credited" would not always be true.
    //  - a task of this phase a Submit can close;
    //  - a quiz of this phase with no paper left (`noPapersLeft`), which only
    //    a teacher's Reset reopens: its door is its room, which says so;
    //  - on the last phase, an earlier phase the completion arm checks again.
    const inAnother = (gap: PhaseEvidenceGap) =>
      Boolean((gap.phaseId && gap.phaseId !== phaseId) || (gap.phaseKey && phase.key && gap.phaseKey !== phase.key));
    const here = gaps.filter((gap) => !inAnother(gap));
    const elsewhere = gaps.filter(inAnother);
    const submittable = here.filter((gap) => !gap.noPapersLeft);
    const spent = here.filter((gap) => gap.noPapersLeft);
    const doors = notTheHeaders(submittable);
    const next = isLast ? 'The project completes' : 'The next phase opens';
    const one = here.length === 1;
    return (
      <div
        className={`phase-gate-banner ${waitingChrome(className)}`}
        data-testid="gate-banner"
        data-gate="evidence-needed"
      >
        <Icon name="merge" size={16} className="shrink-0 text-warn" />
        <div className="min-w-0 flex-1" data-testid="gate-evidence-needed">
          <p className="text-[13.5px] font-semibold text-ink" data-testid="gate-label">
            {here.length ? STATE_LABEL.credited : 'An earlier phase needs a reviewed pass again'}
          </p>
          {here.length > 0 && (
            <p className="text-[12.5px] text-ink2">
              {CREDIT_EXPLANATION}.{' '}
              {andList(here.map((gap) => gap.title))} {one ? 'is' : 'are'} marked passed, but{' '}
              {one ? 'has' : 'have'} no reviewed pass of {one ? 'its' : 'their'} own yet. {next} once{' '}
              {one ? 'it has' : 'each has'} one
              {submittable.length > 0 && (
                <>
                  , so submit{' '}
                  {submittable.length === here.length
                    ? one
                      ? 'it'
                      : 'each one'
                    : andList(submittable.map((gap) => gap.title))}{' '}
                  for review
                </>
              )}
              .
              {spent.length > 0 && (
                <>
                  {' '}
                  {andList(spent.map((gap) => gap.title))} {spent.length === 1 ? 'has' : 'have'} no papers left, so
                  your teacher has to reset {spent.length === 1 ? 'it' : 'them'} before you can sit{' '}
                  {spent.length === 1 ? 'it' : 'them'} again.
                </>
              )}
            </p>
          )}
          {elsewhere.length > 0 && (
            <p className="text-[12.5px] text-ink2">
              {andList(elsewhere.map(elsewhereName))} {elsewhere.length === 1 ? 'has' : 'have'} no reviewed pass that
              counts now. The project completes once every phase has one, so open{' '}
              {elsewhere.length === 1 ? 'it' : 'each one'} and submit it for review.
            </p>
          )}
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <ViewReview onViewReview={onViewReview} />
          {doors.map((gap) => (
            <Button
              key={gap.key || 'phase'}
              size="sm"
              href={evidenceDoorHref(phaseId, phase, gap)}
              testId={`gate-evidence-submit-${gap.key || 'phase'}`}
            >
              Submit {gap.title} for review
            </Button>
          ))}
          {spent.map((gap) => (
            <Button
              key={gap.key}
              size="sm"
              variant="secondary"
              href={evidenceDoorHref(phaseId, phase, gap)}
              testId={`gate-evidence-open-${gap.key}`}
            >
              Open {gap.title}
            </Button>
          ))}
          {elsewhere.map((gap) => (
            <Button
              key={`${gap.phaseId}-${gap.key || 'phase'}`}
              size="sm"
              href={evidenceDoorHref(phaseId, phase, gap)}
              testId={`gate-evidence-open-${gap.phaseKey ?? 'phase'}-${gap.key || 'phase'}`}
            >
              Open {gap.key ? gap.title : (gap.phaseTitle ?? gap.title)}
            </Button>
          ))}
        </span>
      </div>
    );
  }

  return (
    <PassedBand
      phaseId={phaseId}
      phase={phase}
      isLast={isLast}
      className={className}
      onBeforeContinue={onBeforeContinue}
      onAdvanced={onAdvanced}
      onContinueFailed={onContinueFailed}
      onViewReview={onViewReview}
      router={router}
      showReflection={showReflection}
      setShowReflection={setShowReflection}
    />
  );
}

/**
 * A passed phase whose gate is met: "Ready to continue" and its Continue (or,
 * on the last phase, "Complete the project") with the merge sheet, as it has
 * always been, or the quiet "moved on" line once the learner has
 * already continued past the phase or completed the project.
 *
 * Its own component so that the shell's enrolment is read only here, where a
 * passed phase's band decides between the two: a room that mounts the band
 * over a phase in progress reads nothing more than it did. The sheet's open
 * state and the router stay with {@link PhaseGateBanner}, as they were.
 */
function PassedBand({
  phaseId,
  phase,
  isLast,
  className,
  onBeforeContinue,
  onAdvanced,
  onContinueFailed,
  onViewReview,
  router,
  showReflection,
  setShowReflection,
}: Pick<PhaseGateBannerProps, 'phaseId' | 'isLast' | 'className' | 'onBeforeContinue' | 'onAdvanced' | 'onContinueFailed' | 'onViewReview'> & {
  phase: PhaseGatePhase;
  router: ReturnType<typeof useRouter>;
  showReflection: boolean;
  setShowReflection: (next: boolean) => void;
}) {
  // The enrolment the shell holds, read only to tell whether the learner has already moved on from this phase.
  // Outside the shell's provider (a room mounted bare) there is none, and the band is what it always was.
  const held = useContext(ProjectContext);
  // Set when the learner presses Continue (or Complete the project) in this band's drawer. The
  // merge puts the advance's answer into the shell's enrolment a moment before the router leaves the room, and in
  // that moment the enrolment already says the learner has moved on; the band that pressed Continue keeps "Ready to
  // continue" and its open drawer, as it always did, until the next room replaces it. Set at the press, so it is on
  // screen long before the advance answers; a refused Continue leaves the enrolment as it was, so it changes nothing.
  const [continuedHere, setContinuedHere] = useState(false);
  // Where the teacher's countersignature is what passed the phase, the band says so, by the task's name.
  const signed = signedOffTitles(phase);
  const accepted = signed.length ? `Your teacher signed off ${andList(signed)}.` : 'Phase evidence accepted.';

  /*
   * Moved on. The learner has already continued past this
   * phase, or completed the project: the rule the pull request page reads for
   * "merged" (`enrollment.completed || currentPhaseOrder > order`). An advance
   * on a phase behind the current one changes nothing, so "Ready to continue"
   * and a Continue would offer a step already taken; on the last phase of a
   * completed project, a second "Complete the project". The band says what is
   * true, quietly, with a plain door on. Reached only when the shell's
   * enrolment holds this phase and says so: a learner still on the phase, a
   * room mounted with no enrolment, or an enrolment that does not hold this
   * phase all get the band below, unchanged.
   */
  const movedOn = continuedHere ? null : movedOnFrom(held?.enrollment ?? null, phaseId);
  /*
   * The band can turn to "moved on" under an open drawer (the learner continued in another tab and
   * this one read the enrolment again). The moved-on band draws no drawer, so the room's open state is closed too:
   * the room's own actions stand down while it is set, and would otherwise stay down until the room was opened again.
   */
  const closeDrawer = useRef(setShowReflection);
  closeDrawer.current = setShowReflection;
  const leftWithDrawerOpen = movedOn !== null && showReflection;
  useEffect(() => {
    if (leftWithDrawerOpen) closeDrawer.current(false);
  }, [leftWithDrawerOpen]);
  if (movedOn) {
    const complete = movedOn.enrollment.completed && (isLast || !movedOn.next);
    const rest = complete ? `${accepted} The project is complete.` : `${accepted} You have moved on from this phase.`;
    const door = complete
      ? { href: '/completion', label: 'Open your completion record' }
      : movedOn.next
        ? { href: phaseDoorHref(doorWithTasks(movedOn.next, held?.details)), label: `Open ${movedOn.next.title}` }
        : null;
    return (
      <div className={`phase-gate-banner ${className ?? CHROME}`} data-testid="gate-banner" data-gate={complete ? 'complete' : 'moved-on'}>
        <Icon name="check-circle" size={16} className="shrink-0 text-pass" />
        <p className="phase-gate-sentence min-w-0 flex-1 text-[13px] text-ink2" title={`Passed. ${rest}`}>
          <strong className="text-[13.5px] font-semibold text-ink" data-testid="gate-label">
            Passed.
          </strong>{' '}
          {rest}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <ViewReview onViewReview={onViewReview} />
          {door && (
            <Button size="sm" variant="ghost" href={door.href} testId="gate-next-phase">
              {door.label}
            </Button>
          )}
        </span>
      </div>
    );
  }

  const merge = async (reflection: string) => {
    // A reflection is optional, and a written one is at least
    // `REFLECTION_MIN` characters. Advancing never reads it, so an
    // empty box is no reflection at all and nothing is posted for it: the
    // route that stores one refuses an empty body, so posting it would block
    // Continue behind a box that is meant to be optional.
    const text = reflection.trim();
    if (text.length > 0 && reflectionLength(text) < REFLECTION_MIN) {
      throw new Error(`A reflection needs at least ${REFLECTION_MIN} characters. Clear it to continue without one.`);
    }
    // This room stays as it was until the router replaces it (see `continuedHere`). Taken once the reflection
    // is known to be acceptable, still before any request, and let go again if the Continue does not go ahead (a
    // refusal or a failed request leaves the enrolment as it was).
    setContinuedHere(true);
    let updated: Awaited<ReturnType<typeof api.advance>>;
    try {
      // The next phase may read this one's files, and a room may have its own
      // reason to refuse. Both are the room's business, settled before anything
      // is recorded.
      await onBeforeContinue?.();
      if (text) await api.reflect(phaseId, text);
      updated = await api.advance(phaseId);
    } catch (error) {
      setContinuedHere(false);
      onContinueFailed?.();
      throw error;
    }
    // Merging changes this phase and opens the next one, so the copies this
    // session is holding of both are no longer what the server would say. The
    // advance's answer goes in with the invalidation: the room pushed below
    // reads the next phase's status from it, never the held `locked`.
    invalidateProject(updated);
    refreshPhaseRecords(phaseId);
    // And so are the room's own, for the same reason. Here rather than in the
    // guard: nothing can refill them with the phase as it was, because the
    // advance has already happened.
    onAdvanced?.();
    if (updated.completed) {
      router.push('/complete');
      return;
    }
    const next = updated.phases.find((p) => p.order === updated.currentPhaseOrder);
    // The next phase's door: its room, in one step.
    router.push(next ? phaseDoorHref(next) : '/dashboard');
  };
  // On the project's last phase the button reads "Complete the project", so the
  // sentence names that button rather than a Continue the band does not draw.
  const readyRest = `${accepted} ${phase.reflection ? 'Merge message recorded.' : isLast ? 'Complete the project when ready; a reflection is optional.' : 'Continue when ready; a reflection is optional.'}`;
  const readySentence = `${STATE_LABEL.ready}. ${readyRest}`;

  return (
    <>
      <div className={`phase-gate-banner ${className ?? CHROME}`} data-testid="gate-banner">
        <Icon name="merge" size={16} className="shrink-0 text-pass" />
        {/* On a short window the sentence is one line cut with an ellipsis;
           its title keeps the whole sentence. */}
        <p className="phase-gate-sentence min-w-0 flex-1 text-[13px] text-ink2" title={readySentence}>
          <strong className="text-[13.5px] font-semibold text-ink" data-testid="gate-label">
            {STATE_LABEL.ready}.
          </strong>{' '}
          {readyRest}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <ViewReview onViewReview={onViewReview} />
          <Button size="sm" testId="open-reflection" onClick={() => setShowReflection(true)} icon="merge">
            {isLast ? 'Complete the project' : 'Continue to next phase'}
          </Button>
        </span>
      </div>
      {showReflection && (
        <MergePanel
          phaseTitle={phase.title}
          score={phase.bestScore == null ? null : Math.round(phase.bestScore)}
          isLast={isLast}
          onSubmit={merge}
          onClose={() => setShowReflection(false)}
        />
      )}
    </>
  );
}

/**
 * The same banner for a frame that holds no phase detail of its own: the
 * shell's enrolment is what it reads.
 *
 * `useProjectMaybe` rather than `useProject`, because the frame is mounted
 * bare by unit tests and `useProject` throws outside the provider. Outside
 * one, and for a phase the enrolment does not carry, this draws nothing.
 */
export function ShellPhaseGateBanner({
  phaseId,
  className,
  onBeforeContinue,
  onAdvanced,
  onContinueFailed,
}: Omit<PhaseGateBannerProps, 'phase' | 'isLast'>) {
  const project = useProjectMaybe();
  const phases = project?.enrollment?.phases;
  const summary = phases?.find((p) => p.id === phaseId) ?? null;
  // The enrolment's phases never carry `evidenceNeeded`; the shell's
  // per-phase summaries do, and the gate's answer and the task list are read
  // from there, so a document route of a signed-off phase offers the same
  // submit door as its room rather than a Continue the server refuses.
  const held = project?.details?.[phaseId];
  const phase: PhaseGatePhase | null = summary
    ? {
        ...summary,
        evidenceNeeded: held?.evidenceNeeded,
        tasks: held?.tasks,
        ...(held?.notReachedYet ? { notReachedYet: true as const } : {}),
      }
    : null;
  return (
    <PhaseGateBanner
      phaseId={phaseId}
      phase={phase}
      isLast={Boolean(phases && summary && isLastPhase({ phases }, summary.key))}
      className={className}
      onBeforeContinue={onBeforeContinue}
      onAdvanced={onAdvanced}
      onContinueFailed={onContinueFailed}
    />
  );
}
