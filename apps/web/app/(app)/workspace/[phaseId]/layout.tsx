'use client';

import { useEffect } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useProject } from '@/lib/useProject';
import { WorkPage, doorWithTasks, phaseDoorHref, quizHref } from '@/components/shell';
import { Button, Notice } from '@/components/ui';
import { phaseRoomTaskKey } from '@/components/workspace/TaskPanel';
import { RequirementsWorkspace } from '@/components/workspace/requirements/RequirementsWorkspace';
import { PhaseTutorialProvider } from '@/components/shell/PhaseTutorial';
import { useSession } from '@/lib/session';
import { lessonsOfferedOn } from '@/lib/scenario';
import { PhaseHeldNotice } from '@/components/phases/PhaseHeldNotice';
import { QuickCheckProvider } from '@/components/workspace/QuickCheck';
import { movedOnFrom } from '@/components/workspace/moved-on';

/**
 * The design room, opened in place of the bare workspace path: a structured Design is never shown as files.
 * A quiz the phase holds is the one exception: `?task=<quiz key>` (a cross-phase evidence door) opens that quiz.
 */
function ToDesignRoom({ href, quiz }: { href: string; quiz: boolean }) {
  const router = useRouter();
  useEffect(() => router.replace(href), [router, href]);
  const label = quiz ? 'Opening the quiz' : 'Opening the design room';
  return <WorkPage heading={label} testId="design-room-redirect"><p className="p-5" role="status">{label}…</p></WorkPage>;
}

const ROUTE_OWNER: Record<string, string> = { '/interview': 'requirements', '/issue': 'requirements', '/design': 'design', '/matrix': 'testing', '/drill': 'deployment', '/change': 'maintenance' };

/** These phase panes share their state and chrome across App Router child routes. */
export default function PhaseWorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { phaseId } = useParams<{ phaseId: string }>();
  const pathname = usePathname();
  const project = useProject();
  const user = useSession();
  const phase = project.details[phaseId] ?? project.enrollment?.phases.find(item => item.id === phaseId);
  const suffix = pathname.slice(`/workspace/${phaseId}`.length).replace(/\/$/, '');
  const coreView = ['', '/interview', '/issue', '/brief'].includes(suffix);
  /**
   * Which task the URL asks for, and whether this room is its room.
   *
   * Requirements' own room is swapped in for `children` on the bare workspace
   * path, which is also the route every other task of the phase answers by
   * `?task=` (a quiz opens its paper there). So the swap stands down for a task
   * the backlog is not about, and the workspace underneath draws it. A key the phase does not declare falls
   * through, and the workspace says so rather than opening someone else's work.
   *
   * **A task list that has not arrived is not a reason to serve the backlog.**
   * `api.phaseSummaries` is caught to `[]`, so the enrolment resolves and this
   * layout finds its phase in `enrollment.phases` with no tasks on it, and a
   * guard that asked `tasks?.length` first would answer "this is the backlog's
   * own task" for every URL. A learner who followed an authored story's door
   * would be handed the backlog, bound to the inherited story's file, with the
   * URL still naming the task they asked for. Only the backlog's **own** key keeps
   * the backlog; anything else, including a list nobody could read, goes to the
   * room that resolves the task from the phase it fetches itself.
   */
  const search = useSearchParams();
  const asked = search.get('task');
  const tasks = project.details[phaseId]?.tasks;
  // A story-kind Requirements phase's own task is always the backlog here; any other task the query names on a
  // split phase is resolved by the workspace underneath, so the query still opens it.
  const askedElsewhere = Boolean(asked) && asked !== phaseRoomTaskKey('requirements', tasks);
  const designKind = phase?.key === 'design' && Boolean(project.details[phaseId]?.design);
  // Both doors below read the task lists `useProject` already holds, so a
  // phase whose quiz is the last thing left opens the paper rather than the
  // room. The phase in the URL usually resolves from `details` and so carries
  // its own tasks already; the join is written the same way on both anyway,
  // because a file with one spelling is a file the next reader can check.
  const recoveryHref = project.currentPhase ? phaseDoorHref(doorWithTasks(project.currentPhase, project.details)) : '/progress';
  const recoveryLabel = project.currentPhase ? 'Open current phase' : 'View progress';
  if (!phase) return <WorkPage heading="Opening your project" testId="phase-opening">
    <div className="p-5">{project.error ? <Notice tone="fail">{project.error}<button className="ml-3 underline" onClick={() => void project.reload()}>Try again</button></Notice> : project.loading ? <p role="status">Opening your project…</p> : <Notice tone="warn">This phase is not available in your project. Your saved progress is still available.</Notice>}{!project.loading && <Button href={recoveryHref} className="mt-4" variant="secondary">{recoveryLabel}</Button>}</div>
  </WorkPage>;
  if (phase.status === 'locked') return <WorkPage heading={`${phase.title} is locked`} testId="phase-locked"><div className="p-5"><PhaseHeldNotice phase={phase} phases={project.enrollment?.phases} /><Button href={recoveryHref} className="mt-4" variant="secondary">{recoveryLabel}</Button></div></WorkPage>;
  if (designKind && suffix === '') {
    const quiz = tasks?.find(task => task.key === asked && task.artefactType === 'quiz');
    if (quiz) return <ToDesignRoom quiz href={quizHref({ id: phaseId }, quiz.key)} />;
    const query = search.toString();
    return <ToDesignRoom quiz={false} href={`/workspace/${phaseId}/design${query ? `?${query}` : ''}`} />;
  }
  const requiredPhase = ROUTE_OWNER[suffix];
  if (requiredPhase && phase.key !== requiredPhase) return <WorkPage heading={phase.title} testId="phase-view-mismatch"><div className="p-5"><Notice tone="warn">This working view belongs to {requiredPhase[0].toUpperCase() + requiredPhase.slice(1)}. Your {phase.title} work is kept in its own phase.</Notice><Button href={phaseDoorHref(doorWithTasks(phase, project.details))} className="mt-4" variant="secondary">Open {phase.title}</Button></div></WorkPage>;
  // The tutorial names the phase guide only where the strip draws it. On a phase the learner has passed and moved on
  // from (the gate band's rule, read from the same enrolment this layout found the phase in), it does not open by
  // itself; on a phase in progress, not started or awaiting a sign-off it opens on the first entry.
  const movedOn = phase.status === 'passed' && movedOnFrom(project.enrollment, phaseId) !== null;
  return <PhaseTutorialProvider key={`${user?.id ?? 'anonymous'}:${phaseId}`} phaseId={phaseId} phaseKey={phase.key} lessons={lessonsOfferedOn(project.enrollment, phase.key, project.details)} provenance={project.details[phaseId]?.provenance} movedOn={movedOn}>
    {/* The optional quick check before and after the phase, as one line (never a modal). The provider
        holds the offer, keyed by phase so each entry to a phase offers it afresh, and draws the line above the
        room unless the room claims it for its own header (the work room does). Never on the check's own page. */}
    <QuickCheckProvider key={`concept-prompt:${phaseId}`} phaseId={phaseId} phaseStatus={phase.status} enabled={suffix !== '/concept'}>
      {phase.key === 'requirements' && coreView && !(suffix === '' && askedElsewhere) ? <RequirementsWorkspace key={phaseId} phaseId={phaseId} /> : children}
    </QuickCheckProvider>
  </PhaseTutorialProvider>;
}
