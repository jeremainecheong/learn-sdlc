'use client';

/**
 * The folds at the foot of the workspace's left column, for a document page
 * drawn in the workspace's frame: "Mission and review
 * criteria" and "Phase requirements and review", in the workspace's order,
 * words, classes and test ids (`app/(app)/workspace/[phaseId]/page.tsx`, the
 * aside's `phase-task-content`), built from the phase detail the page already
 * holds and nothing else.
 *
 * One part of the workspace's "Phase requirements and review" is not here:
 * the phase panel's own card (`phase-panel-brief`, the workspace's
 * `PHASE_PANELS[key].Brief`), which reads the workspace's working state (its
 * run, its files, its records) that a document page does not load. The
 * phase's brief text and the grading guide are drawn as the workspace draws
 * them.
 *
 * The task is the one the workspace opens on with no task asked for
 * (`chooseTask(tasks, null)`); on a phase with one task, every phase these
 * pages draw, that is the phase's own task and nothing below changes.
 */

import type { ReactNode } from 'react';
import type { PhaseDetail, PhaseKey } from '@learnsdlc/shared';
import { isLastPhase } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { PlainText } from '@/components/PlainText';
import { MissionDetails } from '@/components/phases/Brief';
import { CellTitle, Table } from '@/components/ui';
import { lessonsOfferedOn } from '@/lib/scenario';
import { useProjectMaybe } from '@/lib/useProject';
import { runsReferenceApplication } from './application';
import { gradingPassLine } from './onward-copy';
import { chooseTask, isSplit, phaseRoomTaskKey } from './TaskPanel';

/** A held phase is a whole detail where it carries its rubric; a bare summary, or a stand-in, draws no folds. */
export function holdsFolds(phase: unknown): phase is PhaseDetail {
  return Boolean(phase && typeof phase === 'object' && Array.isArray((phase as PhaseDetail).rubric?.criteria));
}

export function PhaseFrameFolds({ detail, mission }: { detail: PhaseDetail; /** The page's own "Mission and review criteria", where it draws one (the change request). */ mission?: ReactNode }) {
  const held = useProjectMaybe();
  const enrollment = held?.enrollment;
  const lessons = lessonsOfferedOn(enrollment, detail.key as PhaseKey, held?.details);
  const isLast = enrollment ? isLastPhase(enrollment, detail.key) : false;
  const here = isSplit(detail.tasks) ? chooseTask(detail.tasks, null) : undefined;
  const authoredTask = here && here.key !== phaseRoomTaskKey(detail.key as PhaseKey, detail.tasks) ? here : undefined;
  const gradedBy = authoredTask?.rubric ?? detail.rubric;
  const passIsTheTasks = Boolean(
    authoredTask ||
      (isSplit(detail.tasks) &&
        detail.tasks!.some((task) => task.required && task.key !== phaseRoomTaskKey(detail.key as PhaseKey, detail.tasks))),
  );
  // The page's own fold is drawn as it was; the workspace's leaves its own out on a teacher's authored task.
  const missionFold = mission ?? (authoredTask ? null : <MissionDetails phase={detail} detail={detail} lessons={lessons} />);
  const textBrief = !authoredTask && detail.taskPanel ? (
    <section className="border-b-1.5 border-edge px-4 py-4" data-testid="phase-brief">
      <h3 className="text-[13.5px] font-semibold text-ink">The brief</h3>
      <div className="mt-2">
        <PlainText className="text-[13px] leading-[1.65] text-ink2" text={detail.taskPanel} commentsHidden />
      </div>
    </section>
  ) : null;
  // TaskTrackr's Implementation workspace reads the phase's brief text alone in this fold, above the mission.
  if (detail.key === 'implementation' && runsReferenceApplication(detail.provenance)) {
    return <>{textBrief && <details className="phase-contract-detail"><summary>Phase requirements and review</summary>{textBrief}</details>}{mission ?? (authoredTask ? null : <MissionDetails phase={detail} detail={detail} lessons={lessons} introCard={false} />)}</>;
  }
  const gradingGuide = (
    <details className="group px-4 py-4" data-testid="grading-guide">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        {authoredTask ? 'How this task is graded' : 'How this phase is graded'}
        <Icon name="chevron-down" size={14} className="shrink-0 text-dim transition group-open:rotate-180" />
      </summary>
      <p className="purpose mt-1.5">Every required criterion needs correct evidence. Verdicts are Pass or Needs revision.</p>
      <Table
        className="mt-3"
        cols={[
          { label: 'Criterion', width: '1fr' },
          { label: 'Requirement', width: 'auto', align: 'right' },
        ]}
        rows={gradedBy.criteria.map((c) => [<CellTitle key={c.key} state="todo" title={c.title} detail={c.description} />, 'Required'])}
        minWidth={280}
      />
      <p className="purpose mt-3">{gradingPassLine(passIsTheTasks, isLast)}</p>
    </details>
  );
  return <>
    {missionFold}
    <details className="phase-contract-detail"><summary>{authoredTask ? 'Task requirements and review' : 'Phase requirements and review'}</summary>{textBrief}{gradingGuide}</details>
  </>;
}
