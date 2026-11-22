'use client';

/**
 * The quiz room.
 *
 * A quiz is a task, and a task's artefact type picks the room it is worked in,
 * where the other rooms are chosen by phase key. This room is chosen by the
 * task, so it is reached two ways and both of them are built rather than
 * assumed: from the phase's task panel, which routes a quiz row here instead
 * of re-keying the room it is drawn in, and from the board, once the quiz is
 * the only thing in the phase still to pass (`phaseWorkHref`).
 *
 * It mounts **no** editing surface (no editor, no run control, no preview, no
 * agentic propose) and carries the phase's task panel back, so a learner who
 * arrived from a coding phase can return to their code without going through
 * the board.
 */

import { useParams, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { railOf } from '@/lib/rail';
import { useProject } from '@/lib/useProject';
import { DocPage, briefHref, phaseDocHref, phaseDocLabel, roomHref } from '@/components/shell';
import { TaskPanel } from '@/components/workspace/TaskPanel';
import { ShellPhaseGateBanner } from '@/components/workspace/PhaseGateBanner';
import { QuizRoom } from '@/components/workspace/quiz/QuizRoom';
import { quizTaskKey } from '@/components/workspace/quiz/contract';
import { Button, EmptyState } from '@/components/ui';
import { projectName } from '@/lib/project-name';

export default function QuizPage() {
  const params = useParams<{ phaseId: string }>();
  const phaseId = params.phaseId;
  const asked = useSearchParams().get('task');
  const { details, enrollment, analytics, currentPhase } = useProject();
  const held = details[phaseId];

  const tasks = held?.tasks;
  const taskKey = useMemo(() => quizTaskKey(tasks, asked), [tasks, asked]);
  /**
   * This quiz's own task row, for the two facts that outlive an attempt run.
   *
   * The quiz route answers about the **current** run, because a teacher's
   * reset hands the attempts back by moving the run, so the room it serves
   * after a reset reads exactly like a quiz nobody has opened. `resetAt` and
   * `attempts` are on the task's row, they are not scoped to the run, and the
   * panel above this room is already drawn from the very payload that carries
   * them, so the room gets them from here rather than from a second request.
   */
  const row = useMemo(() => tasks?.find((task) => task.key === taskKey), [tasks, taskKey]);
  const title = held?.title ?? 'Phase';
  const phaseKey = held?.key;
  const back = phaseKey ? roomHref({ id: phaseId, key: phaseKey, status: held.status }) : `/workspace/${phaseId}`;

  const nav = railOf(enrollment, analytics, currentPhase);
  const crumbs = [
    ...(enrollment
      ? [{ label: projectName(enrollment.projectTitle), href: '/dashboard', testId: 'back-dashboard' }]
      : []),
    // The phase links to its place on the phases page, as on every other page of a phase.
    { label: title, href: phaseKey ? `/phases?phase=${phaseKey}` : back },
    { label: 'Quiz' },
  ];

  return (
    <DocPage
      crumbs={crumbs}
      nav={nav}
      active="work"
      testId="quiz-page"
      title="Quiz"
      titleTestId="quiz-title"
      purpose="A few questions on the ideas behind this phase. Your best score is the one that counts."
      right={
        <>
          <Button href={briefHref({ id: phaseId })} variant="ghost" size="sm" icon="doc" testId="open-brief">
            Brief
          </Button>
          <Button href={back} variant="ghost" size="sm" icon="arrow-left" testId="quiz-back">
            Back to the work
          </Button>
          {phaseKey && (
            <Button
              href={phaseDocHref({ id: phaseId, key: phaseKey })}
              variant="ghost"
              size="sm"
              icon="doc"
              testId="quiz-doc"
            >
              {phaseDocLabel({ key: phaseKey })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        {/* A passed phase says so here and offers the way on, like every
            other room. The quiz is often the last thing a
            phase waits on, so this is where a learner is when it passes. The
            shell's copy of the phase is what it reads, as every document route
            does; the paper's own verdict refreshes that copy. */}
        <ShellPhaseGateBanner phaseId={phaseId} className="phase-gate-banner-quiz flex flex-wrap items-center gap-3 rounded-panel border-1.5 border-edge bg-passtint px-4 py-2.5" />
        {/* The panel comes with the learner, so the way back to the phase's own
            work is a click and never a trip through the board. */}
        <TaskPanel tasks={tasks} phase={held} selected={taskKey ?? null} counts={held?.taskCounts} />
        {taskKey ? (
          <QuizRoom
            phaseId={phaseId}
            taskKey={taskKey}
            resetAt={row?.resetAt ?? null}
            papersInRecord={row?.attempts ?? 0}
          />
        ) : (
          <EmptyState
            icon="doc"
            title="This phase has no quiz"
            body="Nothing here is missing. The phase's work is where it has always been."
            action={
              <Button size="sm" href={back}>
                Back to the work
              </Button>
            }
            testId="quiz-none"
          />
        )}
      </div>
    </DocPage>
  );
}
