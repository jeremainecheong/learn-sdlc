import { PHASE_ORDER, PHASE_TITLES, type EnrollmentView, type PhaseKey, type PhaseSummary } from '@learnsdlc/shared';
import { lessonHiddenReason } from '@/lib/scenario';

/** The catalogue's phase map: what the learner makes in each of the
 * reference project's six phases, the gate that ends each, and the state of
 * each phase for the person reading. Words checked against
 * `content/tasktrackr/phases/<nn>-<phase>/` (files, task titles, rubric). */

/** The six phases in order and their names, as the shared contract holds them. */
export { PHASE_ORDER, PHASE_TITLES as PHASE_NAMES };

export const PHASE_MAKES: Record<PhaseKey, string[]> = {
  requirements: ['User story US-4 and its acceptance criteria, in a guided backlog', 'Where the overdue report appears and what it will not do', 'An epic only if you choose to add one'],
  design: ['The UML model: entities, operations and a decision (design.json)', 'The API contract (api.json)', 'The screen contract (screens.json)', 'A sequence diagram of the overdue request'],
  implementation: ['Code that fills the five marked gaps', 'A run of the visible tests against your change'],
  testing: ['API and front-end acceptance suites that pass on the healthy app', 'A kill matrix: your suites run against eight planted bugs on submit'],
  deployment: ['api/Dockerfile, docker-compose.yml and the CI workflow', 'A runbook another person can follow', 'An incident record from the drill'],
  maintenance: ['The CR-2 change: comments on a task, and the count on the task row', 'A green run of the regression suite you are given', 'The change request: impact, contract amendments, checks and the 2.1.0 release'],
};

/** What a phase's gate asks, in the phase briefs' own terms ("Every required
 * criterion and its evidence must pass review before the next phase opens",
 * the `taskPanel` of each `phase.json`). The gate is binary on evidence, not a
 * score against a pass mark: `strictTaskEvidencePassed` in
 * `apps/api/src/feedback/strict-evidence.ts` never compares the score with a
 * threshold, and the reviewer is told "there is no pass threshold". */
export const GATE_RULE = 'every required check passes and every criterion and its evidence pass review';

/** The gate at the end of a phase: what passes it, and what a Pass opens.
 * The last phase's Pass completes the project (its brief: "passing completes
 * the project"). */
export function gateSentence(key: PhaseKey): string {
  const at = PHASE_ORDER.indexOf(key);
  const next = PHASE_ORDER[at + 1];
  const end = next ? `opens ${PHASE_TITLES[next]}` : 'completes the project';
  return `The phase passes when ${GATE_RULE}. A score on its own never passes it. The Pass ${end}.`;
}

export type MapState = 'passed' | 'current' | 'open' | 'locked' | 'not-offered' | 'not-held';

export interface MapNode {
  key: PhaseKey;
  state: MapState;
  /** The state in words, always drawn. */
  note: string;
  /** A guide is offered for this phase, so the panel may link to it. */
  offered: boolean;
}

const HIDDEN_NOTE = { own: 'Your teacher wrote this phase', mixed: 'Your teacher changed this phase', unknown: 'No guide for this phase' } as const;

/** Each phase's state for the reader. With no enrolment (a teacher, an
 * account not in a class) every phase is open. A learner's phases come from
 * the enrolment: passed, the phase in hand ("You are here"), open, locked
 * until the phase before it passes, a phase the project does not hold, or a
 * phase whose guide is not offered (the reason said only as far as the
 * payload knows it, as `/learn/<phase>` does). */
export function mapNodes(enrollment: Pick<EnrollmentView, 'phases'> | null | undefined, offered: readonly PhaseKey[]): MapNode[] {
  if (!enrollment) return PHASE_ORDER.map((key) => ({ key, state: 'open', note: 'Open', offered: offered.includes(key) }));
  const held = [...(enrollment.phases ?? [])].sort((a, b) => a.order - b.order);
  const current = held.find((one) => one.status === 'in_progress' || one.status === 'submitted');
  return PHASE_ORDER.map((key): MapNode => {
    const summary: PhaseSummary | undefined = held.find((one) => one.key === key);
    const isOffered = offered.includes(key);
    if (!summary) return { key, state: 'not-held', note: 'Not in your project', offered: isOffered };
    if (!isOffered) return { key, state: 'not-offered', note: HIDDEN_NOTE[lessonHiddenReason(summary)], offered: false };
    if (summary.status === 'passed') return { key, state: 'passed', note: 'Passed', offered: true };
    if (summary === current) return { key, state: 'current', note: 'You are here', offered: true };
    if (summary.status === 'locked') {
      const before = held[held.indexOf(summary) - 1];
      return { key, state: 'locked', note: before ? `Opens after ${PHASE_TITLES[before.key]}` : 'Locked', offered: true };
    }
    return { key, state: 'open', note: 'Open', offered: true };
  });
}
