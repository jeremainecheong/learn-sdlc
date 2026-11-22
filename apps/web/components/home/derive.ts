'use client';

/**
 * Pure derivations for the learner's next steps. Nothing here touches the
 * network or the DOM: it turns the enrolment and its phase details into the
 * steps under "Do next" that the top bar's bell draws, and shortens a project
 * title for a crumb.
 */
import type { EnrollmentView, FeedbackReport, PhaseDetail, PhaseSummary } from '@learnsdlc/shared';
import { DEFAULT_PASS_THRESHOLD, isLastPhase, nextPhaseOf, placeOf } from '@learnsdlc/shared';
import { scoreLabel, type StatusState } from '@/lib/phase';
import { doorWithTasks, phaseDoorHref } from '@/components/shell/routes';
import { phaseAwaitingSignOff, reviewAwaitsSignOff, signOffPassLine } from '@/components/workspace/signoff-status';
import { citeChecks } from '@/components/pr/checkCitations';
import { projectName } from '@/lib/project-name';

/* --------------------------------- words --------------------------------- */

/** A title reads as its name in a crumb: the part before the dash that {@link projectName} splits at, or the whole title. */
export function shortTitle(title: string): string {
  return projectName(title) || title;
}

export function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * True only when a review scored the work below its pass mark: a refusal at or
 * above it, or a review that could not be done (`assessmentError`), is not a
 * score short of the pass mark, and with no pass mark in the report nothing is
 * said of it.
 */
function belowPassMark(report: FeedbackReport | null | undefined): boolean {
  if (!report || report.aiReview?.assessmentError || report.passThreshold == null) return false;
  return report.overall < report.passThreshold;
}

/* --------------------------------- do next ------------------------------- */

export interface NextStep {
  key: string;
  state: StatusState;
  title: string;
  detail: string;
  /** Where to look: a file name, or the phase when there is no file yet. */
  meta: string;
  href: string;
}

export interface NextPlan {
  purpose: string;
  steps: NextStep[];
}

const MAX_STEPS = 5;

/**
 * The ordered list under "Do next", worked out from the current phase: its
 * last verdict when there is one, otherwise its objectives. Every step links
 * to the place the work happens.
 */
export function buildNextSteps(
  enrollment: EnrollmentView,
  details: Record<string, PhaseDetail>,
  current: PhaseSummary | undefined,
): NextPlan {
  if (enrollment.completed) {
    return {
      purpose: 'Every phase has passed its gate. Nothing is waiting on you.',
      steps: [
        {
          key: 'done',
          state: 'pass',
          title: 'Pass every gate',
          detail: 'Every phase of the project, each reviewed and passed.',
          meta: `${enrollment.phases.length} of ${enrollment.phases.length}`,
          href: '/complete',
        },
        {
          key: 'summary',
          state: 'todo',
          title: 'Read your completion summary',
          detail: 'Scores, hints and reflections for the whole project, in one place.',
          meta: 'Summary',
          href: '/complete',
        },
      ],
    };
  }
  if (!current) return { purpose: '', steps: [] };

  const detail = details[current.id];
  // Every step opens the phase through its door, and through the task list
  // this function was already handed, so a phase whose quiz is all that is
  // left opens the paper.
  const href = phaseDoorHref(doorWithTasks(current, details));
  const firstFile = detail?.files.find((f) => f.editable)?.path;
  const meta = firstFile ? baseName(firstFile) : `Phase ${placeOf(enrollment, current.key)}`;
  const gate = detail?.rubric.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const sub = detail?.lastSubmission ?? null;
  const title = current.title;
  const next = nextPhaseOf(enrollment, current.key);
  const steps: NextStep[] = [];

  // Gate passed, not yet moved on: the reflection is the only thing in the way.
  if (current.status === 'passed') {
    steps.push({
      key: 'passed',
      state: 'pass',
      title: `Pass the ${title} gate`,
      detail: `${scoreLabel(current.bestScore, gate)}. The reviewer has signed it off.`,
      meta,
      href,
    });
    steps.push(
      current.reflection
        ? {
            key: 'advance',
            state: 'now',
            title: next ? `Move on to ${next.title}` : 'Finish the project',
            detail: 'Your reflection is saved. Continue from the workspace.',
            meta,
            href,
          }
        : {
            key: 'reflect',
            state: 'warn',
            title: 'Write a short reflection',
            detail: `What you learned in ${title}. It unlocks ${next ? next.title : 'the summary'}.`,
            meta,
            href,
          },
    );
    return { purpose: `Worked out from your ${title} result.`, steps };
  }

  if (sub && (sub.status === 'queued' || sub.status === 'running')) {
    steps.push({
      key: 'pending',
      state: 'now',
      title: `Wait for the ${title} verdict`,
      detail: 'Your submission is being graded. The result lands in the workspace.',
      meta,
      href,
    });
    return { purpose: `Submission ${current.attempts} of ${title} is with the reviewer.`, steps };
  }

  // The work passed review and the phase waits on the teacher's
  // countersignature. A passing verdict is none of the arms below, so without
  // this arm it would fall to the "nothing submitted" arm and list
  // "Submit <Phase> for the gate": a resubmit that costs a review and,
  // refused, clears the learner's place in the sign-off queue. Judged as the
  // dashboard's line is (`reviewAwaitsSignOff`). One neutral step: the wait.
  if (sub ? reviewAwaitsSignOff(detail, sub) : phaseAwaitingSignOff(detail)) {
    steps.push({
      key: 'signoff',
      state: 'now',
      title: `Waiting for your teacher's sign-off on ${title}`,
      detail: signOffPassLine(isLastPhase(enrollment, current.key)),
      meta,
      href,
    });
    return { purpose: `Your ${title} work passed review.`, steps };
  }

  if (sub && sub.status === 'completed' && sub.passed === false && sub.report) {
    const report = sub.report;
    const improvement = citeChecks(report.aiReview?.improvements?.[0] ?? '', report.checks);
    steps.push({
      key: 'gate',
      state: 'fail',
      // The score's threshold is the pass mark, the product's own word for
      // it. A review can refuse work at or above the pass mark (needs
      // revision, or a review that could not be done): then the title names
      // the phase's gate, since "up to the pass mark" would be false.
      title: belowPassMark(report) ? `Bring ${title} up to the pass mark` : `Bring ${title} up to the gate`,
      detail: `Scored ${Math.round(report.overall)}, pass mark ${report.passThreshold}, on submission ${current.attempts}.${
        improvement ? ` ${improvement}` : ''
      }`,
      meta,
      href,
    });
    const weakest = [...report.criteria]
      .filter((c) => c.score < gate)
      .sort((a, b) => a.score - b.score)
      .slice(0, 2);
    weakest.forEach((c) => {
      const evidence = c.evidence?.[0] ?? '';
      steps.push({
        key: `criterion:${c.key}`,
        state: 'fail',
        title: c.title,
        detail: `Scored ${Math.round(c.score)} of 100 on this criterion.${evidence ? ` ${evidence}` : ''}`,
        meta,
        href,
      });
    });
    const failedCheck = report.checks.find((c) => c.status === 'failed');
    if (failedCheck) {
      steps.push({
        key: `check:${failedCheck.id}`,
        state: 'warn',
        title: failedCheck.label,
        detail: failedCheck.detail,
        meta,
        href,
      });
    }
    steps.push({
      key: 'resubmit',
      state: 'todo',
      title: 'Submit again',
      detail: 'Each submission is graded in full, and your best score is the one that counts.',
      meta,
      href,
    });
    return {
      purpose: `Worked out from what submission ${current.attempts} of ${title} was marked down on.`,
      steps: steps.slice(0, MAX_STEPS),
    };
  }

  if (sub && sub.status === 'failed') {
    steps.push({
      key: 'retry',
      state: 'warn',
      title: 'Submit again',
      detail: sub.error || 'The last submission did not finish grading. Nothing was scored.',
      meta,
      href,
    });
    return { purpose: `The last submission of ${title} did not complete.`, steps };
  }

  if (detail) {
    detail.objectives.slice(0, 3).forEach((objective, i) => {
      steps.push({
        key: `objective:${i}`,
        state: i === 0 ? 'now' : 'todo',
        title: objective,
        detail: i === 0 ? `The first objective in ${title}.` : '',
        meta,
        href,
      });
    });
    if (detail.canRun) {
      steps.push({
        key: 'run',
        state: 'todo',
        title: detail.runLabel || 'Run the checks',
        detail: 'As often as you like. Nothing is graded until you submit.',
        meta,
        href,
      });
    }
    steps.push({
      key: 'submit',
      state: 'todo',
      title: `Submit ${title} for the gate`,
      detail: `${gate} of 100 passes. The reviewer scores every criterion in the rubric.`,
      meta,
      href,
    });
    return {
      purpose: `Worked out from the ${title} brief. Nothing has been submitted yet.`,
      steps: steps.slice(0, MAX_STEPS),
    };
  }

  steps.push({
    key: 'open',
    state: 'now',
    title: `Open ${title}`,
    detail: 'Read the brief and start on the first objective.',
    meta,
    href,
  });
  return { purpose: `You are at the start of ${title}.`, steps };
}
