/**
 * One project, shared by the suites that need a whole enrolment.
 *
 * It is the shape the API actually returns (an enrolment, a phase detail per
 * phase and the reports that hang off them) small enough to read in one
 * screen and complete enough that the map builder, the home derivations and
 * the record cache all have something real to chew on. The reports are the
 * ones the builders branch on: a failing hidden case with frames, a
 * contradicted contract claim, a surviving mutant, a resolved drill.
 *
 * Fields the tests never look at are filled with the emptiest legal value
 * rather than left out, so a required field added to the shared types shows
 * up here as a type error rather than as a wrong answer.
 */
import type {
  AuthResponse,
  EnrollmentView,
  ExecutionRunView,
  FeedbackReport,
  PhaseDetail,
  PhaseKey,
  PhaseStatus,
  PhaseSummary,
  PhaseTaskView,
  RunResult,
  SubmissionView,
  UserProfile,
  WorkspaceFile,
} from '@learnsdlc/shared';
import {
  DEFAULT_DESIGN_FLOOR,
  DEFAULT_STORY_FLOOR,
  DESIGN_JSON,
  EMPTY_DESIGN,
  STORY_JSON,
  serialiseDesign,
} from '@learnsdlc/shared';

export function phase(
  key: PhaseKey,
  order: number,
  id: string,
  status: PhaseStatus,
  extra: Partial<PhaseSummary> = {},
): PhaseSummary {
  return {
    id,
    key,
    order,
    title: TITLES[key],
    status,
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...extra,
  };
}

const TITLES: Record<PhaseKey, string> = {
  requirements: 'Requirements',
  design: 'Design',
  implementation: 'Implementation',
  testing: 'Testing',
  deployment: 'Deployment',
  maintenance: 'Maintenance',
};

export function file(
  path: string,
  content: string,
  editable = true,
  language = 'python',
): WorkspaceFile {
  return { path, content, editable, language };
}

export function detail(
  summary: PhaseSummary,
  files: WorkspaceFile[],
  extra: Partial<PhaseDetail> = {},
): PhaseDetail {
  return {
    ...summary,
    projectSlug: 'tasktrackr',
    intro: '',
    taskPanel: '',
    place: 1,
    count: 6,
    objectives: [],
    artifactKind: 'code',
    files,
    rubric: { passThreshold: 70, criteria: [] },
    canRun: true,
    runLabel: 'Run the checks',
    lastSubmission: null,
    updatedAt: null,
    ...extra,
  };
}

/** A signed-in learner's profile with every required field; a case gives only what it is about. */
export function userProfile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'u1',
    email: 'ada@example.test',
    displayName: 'Ada',
    role: 'LEARNER',
    cohort: 'default',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

/** What a sign-in answers: the session token and the profile it belongs to. */
export function authResult(token: string, user: Partial<UserProfile> = {}): AuthResponse {
  return { token, user: userProfile(user) };
}

/**
 * One task of a phase as the phase detail lists it: a required, sealed,
 * reviewed document task in progress, with nothing submitted yet. Its title is
 * its key unless the case gives one.
 */
export function taskView(over: Partial<PhaseTaskView> & { key: string; order: number }): PhaseTaskView {
  return {
    required: true,
    title: over.key,
    artefactType: 'document',
    evidence: 'reviewed',
    sealed: true,
    status: 'in_progress',
    awaitingSignOff: false,
    attempts: 0,
    bestScore: null,
    passedAt: null,
    lastSubmissionId: null,
    resetAt: null,
    solution: { available: false, files: 0, readAt: null },
    ...over,
  };
}

/** A report with every required field, so a case only writes what it is about. */
export function report(extra: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    overall: 0,
    passed: false,
    passThreshold: 70,
    criteria: [],
    checks: [],
    aiReview: { summary: '', points: [] },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: {},
    ...extra,
  } as FeedbackReport;
}

export function submission(extra: Partial<SubmissionView> = {}): SubmissionView {
  return {
    id: 's1',
    status: 'completed',
    score: null,
    passed: null,
    report: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...extra,
  };
}

export function run(
  id: string,
  kind: 'run' | 'submit',
  createdAt: string,
  result: RunResult | null,
  status: ExecutionRunView['status'] = 'completed',
): ExecutionRunView {
  return { id, kind, status, result, createdAt };
}

/** A run result with tests in it, which is the shape the run log reads. */
export function testResult(passed: number, total: number, extra: Partial<RunResult> = {}): RunResult {
  return {
    ok: passed === total,
    exitKind: 'exit',
    stdout: '',
    stderr: '',
    durationMs: 12,
    tests: { total, passed, failed: total - passed, errored: 0, cases: [] },
    ...extra,
  } as RunResult;
}

/* --------------------------- the sample project --------------------------- */

/** The story the Requirements phase provides, with the two criteria the map traces to. */
const PROVIDED_STORY = {
  id: 'US-3',
  title: 'Filter tasks',
  persona: 'user',
  capability: 'to filter tasks',
  benefit: 'I can focus on what is open',
  criteria: [
    { id: 'AC-1', tag: 'happy' as const, given: 'a status filter', when: 'I filter', then: 'only tasks with that status are listed' },
    { id: 'AC-2', tag: 'boundary' as const, given: 'a keyword in any case', when: 'I filter', then: 'matching tasks are listed' },
  ],
};

/** The learner's design record: one operation, the contract the map traces to. */
const DESIGN = serialiseDesign({
  ...EMPTY_DESIGN,
  operations: [{
    id: 'O1',
    name: 'filter_tasks(status, keyword)',
    inputs: ['a status string and a keyword string'],
    returns: 'the matching tasks',
    errors: ['none expected'],
    satisfies: ['US-3'],
  }],
});

const MANAGER = `class TaskManager:
    def __init__(self):
        self.tasks = []

    def complete_task(self, task_id):
        for task in self.tasks:
            if task.id == task_id:
                task.status = "completed"
                return task
        raise KeyError(task_id)

    def filter_tasks(self, status, keyword):
        found = []
        for task in self.tasks:
            if status and task.status != status:
                continue
            if keyword and keyword not in task.title:
                continue
            found.append(task)
        return found
`;

const TESTS = `import unittest


class TestManager(unittest.TestCase):
    def test_filter_keyword_is_case_insensitive(self):
        self.assertEqual(len(mgr.filter_tasks(None, "RENT")), 1)

    def test_complete_marks_task_done(self):
        self.assertEqual(mgr.complete_task(1).status, "completed")
`;

const CASE_FILTER = 'test_filter_keyword_is_case_insensitive (tests.test_manager.TestManager)';
const CASE_COMPLETE = 'test_complete_marks_task_done (tests.test_manager.TestManager)';

export interface Sample {
  enrollment: EnrollmentView;
  details: Record<string, PhaseDetail>;
}

/**
 * The learner four phases in: requirements, design and implementation passed,
 * testing open with a failing hidden case and a surviving mutant, deployment
 * open with the incident drill resolved, maintenance still locked.
 */
export function sample(): Sample {
  const phases: PhaseSummary[] = [
    phase('requirements', 1, 'p1', 'passed', { bestScore: 91, passedAt: '2026-09-01T09:00:00.000Z' }),
    phase('design', 2, 'p2', 'passed', { bestScore: 84, passedAt: '2026-09-01T11:00:00.000Z' }),
    phase('implementation', 3, 'p3', 'passed', { bestScore: 88, passedAt: '2026-09-02T09:30:00.000Z' }),
    phase('testing', 4, 'p4', 'in_progress', { attempts: 1 }),
    phase('deployment', 5, 'p5', 'in_progress'),
    phase('maintenance', 6, 'p6', 'locked'),
  ];

  const enrollment: EnrollmentView = {
    id: 'e1',
    projectSlug: 'tasktrackr',
    projectTitle: 'TaskTrackr — a command-line task manager',
    currentPhaseOrder: 4,
    completed: false,
    startedAt: '2026-09-01T08:00:00.000Z',
    completedAt: null,
    phases,
  };

  const testingReport = report({
    overall: 62,
    passThreshold: 70,
    tests: {
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      cases: [
        {
          name: CASE_FILTER,
          status: 'failed',
          message: 'AssertionError: 0 != 1',
          frames: [
            {
              path: 'tasktrackr/manager.py',
              line: 16,
              snippet: 'if keyword and keyword not in task.title:',
            },
            {
              path: 'tests/test_manager.py',
              line: 6,
              snippet: 'self.assertEqual(len(mgr.filter_tasks(None, "RENT")), 1)',
            },
          ],
          durationMs: 3,
        },
        { name: CASE_COMPLETE, status: 'passed', durationMs: 1 },
      ],
    },
    mutation: {
      total: 2,
      killed: 1,
      survivors: [
        { name: 'priority_order_reversed', description: 'Sorts by priority the other way round.' },
      ],
      matrix: [
        {
          mutant: 'filter_ignores_keyword',
          description: 'The keyword filter is skipped, so every task is returned.',
          killed: true,
          covers: 'US-3/AC-2',
          cases: [
            { name: CASE_FILTER, status: 'failed' },
            { name: CASE_COMPLETE, status: 'passed' },
          ],
        },
        {
          mutant: 'priority_order_reversed',
          description: 'Sorts by priority the other way round.',
          killed: false,
          cases: [{ name: CASE_FILTER, status: 'passed' }],
        },
      ],
    },
  } as Partial<FeedbackReport>);

  const implReport = report({
    overall: 88,
    passed: true,
    staticAnalysis: {
      issues: [],
      metrics: { files: 1, functions: 2, todosRemaining: 0, maxComplexity: 4, docstringCoverage: 1 },
      functions: [
        {
          name: 'filter_tasks',
          path: 'tasktrackr/manager.py',
          line: 11,
          endLine: 19,
          complexity: 4,
          calls: [],
          bodyHash: 'a',
        },
      ],
      imports: [],
    },
    contract: [
      {
        name: 'filter_tasks',
        story: 'US-3',
        claim: 'errors',
        text: 'Errors: none expected',
        verdict: 'contradicted',
        evidence: ['A hidden test expects ValueError for an unknown status.'],
      },
    ],
  } as Partial<FeedbackReport>);

  const details: Record<string, PhaseDetail> = {
    p1: detail(phases[0], [file(STORY_JSON, '{}', true, 'json')], {
      artifactKind: 'story',
      objectives: ['Write two acceptance criteria for US-3', 'Name one boundary case'],
      story: { id: 'US-3', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [PROVIDED_STORY] },
    }),
    p2: detail(phases[1], [file(DESIGN_JSON, DESIGN, true, 'json')], {
      artifactKind: 'design',
      design: { contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR },
    }),
    p3: detail(phases[2], [file('tasktrackr/manager.py', MANAGER)], {
      lastSubmission: submission({ id: 's3', score: 88, passed: true, report: implReport }),
    }),
    p4: detail(
      phases[3],
      [file('tasktrackr/manager.py', MANAGER, false), file('tests/test_manager.py', TESTS)],
      {
        lastSubmission: submission({
          id: 's4',
          score: 62,
          passed: false,
          report: testingReport,
          createdAt: '2026-09-02T13:00:00.000Z',
        }),
        links: [
          {
            from: 'test_filter_keyword_is_case_insensitive',
            to: 'US-3/AC-2',
            kind: 'verifies',
            at: '2026-09-02T14:00:00.000Z',
          },
        ],
      },
    ),
    p5: detail(
      phases[4],
      [
        file('Dockerfile', 'FROM python:3.11\n', true, 'docker'),
        file('docker-compose.yml', 'services: {}\n', true, 'yaml'),
      ],
      {
        drill: {
          fault: 'Dockerfile ENTRYPOINT in shell form',
          pagedAt: '2026-09-03T09:00:00.000Z',
          runbookBefore: null,
          healthRanAt: null,
          healthExit: null,
          fixAppliedAt: null,
          resolvedAt: '2026-09-03T09:20:00.000Z',
          incident: { rootCause: 'x', fix: 'y', actionItem: 'z' },
        },
      } as Partial<PhaseDetail>,
    ),
  };

  return { enrollment, details };
}
