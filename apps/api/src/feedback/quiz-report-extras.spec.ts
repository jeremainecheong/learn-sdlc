import 'reflect-metadata';
import type { AnalyzerReport } from '@learnsdlc/shared';
import type { ContentFileSpec, PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { FeedbackService } from './feedback.service';

/**
 * A quiz costs nothing to report on.
 *
 * `sandboxBudgetFor` skips a quiz task, which is the whole argument for
 * letting one sit beside an executable task, but that covers only the
 * **budget**. `reportExtras` is keyed on `phase.key`, so without its guard a
 * quiz handed in on the **deployment** phase would reach `drillFor`, which
 * runs the pack's faulted copy through the sandbox: a real microVM, off the
 * request path, billed to a hand-in that scored an MCQ by set equality. A
 * quiz on **implementation** or **maintenance** would attach a
 * conformance ledger and an impact report built out of another task's static
 * analysis.
 *
 * So the guard is stated once, at the top of `reportExtras`, and asked of the
 * kind that **scores** the task. The danger in a guard like that is the
 * opposite failure: a blanket that quietly takes the sections away from the
 * phase's real work, so every assertion below is paired: the quiz carries
 * none of the four, and the **same phase's** executable task still carries
 * the ones that phase has material for.
 *
 * The fixtures are hand-built and none of them is TaskTrackr, which declares
 * no quiz at all.
 */

/* ------------------------------- the harness ------------------------------ */

const file = (path: string, editable: boolean, language = 'python'): ContentFileSpec => ({
  path,
  content: `# ${path}\n`,
  editable,
  language,
});

/** The analyzer report both halves of the impact report are built from. */
const analysisOf = (bodyHash: string): AnalyzerReport => ({
  issues: [],
  metrics: { files: 1, functions: 1, todosRemaining: 0, maxComplexity: 2, docstringCoverage: 1 },
  functions: [
    {
      name: 'reopen_task',
      path: 'tasktrackr/manager.py',
      line: 10,
      endLine: 20,
      complexity: 2,
      calls: [],
      bodyHash,
    },
  ],
});

const CONTRACTS = JSON.stringify({
  operations: [
    {
      name: 'reopen_task(task_id)',
      returns: 'the task with completed set back to false',
      errors: 'KeyError when the id is unknown',
    },
  ],
});

const designPhase: PhaseContent = {
  key: 'design',
  files: [file('design/contracts.json', true, 'json')],
  checks: { kind: 'config', rules: [] },
} as unknown as PhaseContent;

/**
 * Implementation carries no contract record of its own: the ledger is read off
 * the **design** phase of the same enrolment, which is the point of the
 * assertion below. Maintenance does carry one, and amends it.
 */
const codePhase: PhaseContent = {
  key: 'implementation',
  language: 'python',
  files: [file('tasktrackr/manager.py', true)],
  checks: { kind: 'code' },
} as unknown as PhaseContent;

const maintenancePhase: PhaseContent = {
  key: 'maintenance',
  language: 'python',
  files: [file('tasktrackr/manager.py', true), file('design/contracts.json', true, 'json')],
  checks: { kind: 'code' },
} as unknown as PhaseContent;

/**
 * The deployment phase, with a drill whose faulted copy really starts.
 *
 * The fault both shipped packs use is refused before the container starts, so
 * a fixture that copied it would assert *zero sandbox calls* for a path that
 * never reached the sandbox either way. This one is startable, so the
 * executable task's drill spends a microVM and the quiz's silence is a fact
 * about the guard rather than about the Dockerfile.
 */
const deploymentPhase: PhaseContent = {
  key: 'deployment',
  language: 'python',
  files: [
    file('Dockerfile', true, 'dockerfile'),
    file('.github/workflows/ci.yml', true, 'yaml'),
    file('cli.py', false),
  ],
  checks: {
    kind: 'config',
    rules: [],
    smokeDockerfile: 'Dockerfile',
    smokeImplFiles: { 'cli.py': '# reference cli' },
    smokeCommands: [['python', 'cli.py', 'list']],
    expectInOutput: 'Tasks',
    drill: {
      fault: 'fixture-fault',
      description: 'the fixture fault',
      faultedFiles: {
        Dockerfile: 'FROM scratch\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["python", "/app/cli.py"]\n',
      },
      expectFailure: true,
    },
  },
} as unknown as PhaseContent;

const DOCKERFILE = 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT ["python", "/app/cli.py"]\n';

const CI_YAML = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m unittest discover
`;

/**
 * The task a report is about. `reportExtras` reads one field of it: the kind
 * that **scores** it, because that is the one fact that separates a quiz
 * from the work of the phase it sits in.
 */
const gradedTask = (phase: PhaseContent): CompiledTask =>
  ({ taskKey: 'main', checkKind: phase.checks.kind }) as CompiledTask;

const quizTask = (): CompiledTask =>
  ({ taskKey: 'check', checkKind: 'quiz', owns: [] }) as unknown as CompiledTask;

function build() {
  const sandbox = { execute: jest.fn(async () => ({ ok: false, exitKind: 'ok' as const, stdout: '', stderr: 'the fixture fault', durationMs: 3 })) };
  const submissions = {
    find: jest.fn(async () => [{ report: { staticAnalysis: analysisOf('baseline') } }]),
  };
  const phaseStates = {
    findOne: jest.fn(async (opts: any) =>
      opts?.where?.phaseKey === 'design'
        ? { id: 'ps-design', workspace: { 'design/contracts.json': CONTRACTS } }
        : { id: 'ps-impl', workspace: null },
    ),
  };
  const enrollments = {
    findOneByOrFail: jest.fn(async () => ({ id: 'e-1', projectSlug: 'fixture' })),
  };
  const content = {
    executionFiles: jest.fn((phase: any, workspace: Record<string, string> | null) =>
      Object.fromEntries(
        phase.files.map((one: ContentFileSpec) => [
          one.path,
          one.editable && workspace && workspace[one.path] !== undefined
            ? workspace[one.path]
            : one.content,
        ]),
      ),
    ),
    getPhaseForEnrollment: jest.fn(() => designPhase),
    // The Design read asks whether the version holds Design (`holdsPhase`), so the
    // stub names the phases this fixture's project carries.
    getForEnrollment: jest.fn(() => ({ phases: [{ key: 'requirements', order: 1 }, { ...designPhase, key: 'design', order: 2 }] })),
  };
  const service = new FeedbackService(
    submissions as any,
    phaseStates as any,
    enrollments as any,
    { count: jest.fn(async () => 0), find: jest.fn(async () => []) } as any,
    content as any,
    sandbox as any,
    {} as any,
    { reviewSubmission: jest.fn() } as any,
    { enqueue: jest.fn(), register: jest.fn(), durable: false } as any,
    {} as any,
    { onVerdict: jest.fn(async () => undefined) } as any,
  );
  return { service, sandbox, submissions, phaseStates, enrollments, content };
}

/** The report so far, with the static analysis the ledger and the impact read. */
const reportSoFar = (over: Record<string, unknown> = {}): any => ({
  overall: 80,
  criteria: [],
  checks: [],
  staticAnalysis: analysisOf('current'),
  ...over,
});

const stateFor = (workspace: Record<string, string> | null) =>
  ({ id: 'ps-1', enrollmentId: 'e-1', workspace }) as any;

/* -------------------------------- the proof ------------------------------- */

describe('a quiz hand-in buys none of the phase-specific sections', () => {
  it('runs no microVM on a deployment phase that declares a drill, and the phase’s own task still does', async () => {
    const workspace = { Dockerfile: DOCKERFILE, '.github/workflows/ci.yml': CI_YAML };
    const smoke = { ok: true, stdout: 'Tasks', stderr: '', durationMs: 42, argv: ['python', 'cli.py'] };

    // The quiz. Nothing is built, and the sandbox is never reached.
    const quiz = build();
    const forQuiz = await quiz.service['reportExtras'](
      deploymentPhase,
      stateFor(workspace),
      reportSoFar(),
      smoke,
      quizTask(),
    );
    expect(forQuiz).toEqual({});
    expect(forQuiz.drill).toBeUndefined();
    expect(forQuiz.ci).toBeUndefined();
    expect(forQuiz.contract).toBeUndefined();
    expect(forQuiz.impact).toBeUndefined();
    // The bill, which is the whole point: zero.
    expect(quiz.sandbox.execute).toHaveBeenCalledTimes(0);
    // and the guard is above every read, not only above the sandbox
    expect(quiz.content.executionFiles).not.toHaveBeenCalled();

    // The same phase's executable task, in the same spec, so the guard cannot
    // be a blanket: the pipeline and the drill are still there, and the drill
    // still spends its microVM against the pack's faulted copy.
    const executable = build();
    const forTask = await executable.service['reportExtras'](
      deploymentPhase,
      stateFor(workspace),
      reportSoFar(),
      smoke,
      gradedTask(deploymentPhase),
    );
    expect(forTask.ci?.length).toBeGreaterThan(0);
    expect(forTask.drill).toMatchObject({ fault: 'fixture-fault', failedBeforeFix: true });
    expect(executable.sandbox.execute).toHaveBeenCalledTimes(1);
  });

  it('carries no contract on an implementation phase, while the phase’s own task does', async () => {
    const quiz = build();
    const forQuiz = await quiz.service['reportExtras'](
      codePhase,
      stateFor(null),
      reportSoFar(),
      undefined,
      quizTask(),
    );
    expect(forQuiz).toEqual({});
    // The ledger is built from the DESIGN phase of the same enrolment, which
    // is another task's work: the quiz never asks for it.
    expect(quiz.enrollments.findOneByOrFail).not.toHaveBeenCalled();
    expect(quiz.phaseStates.findOne).not.toHaveBeenCalled();

    const executable = build();
    const forTask = await executable.service['reportExtras'](
      codePhase,
      stateFor(null),
      reportSoFar(),
      undefined,
      gradedTask(codePhase),
    );
    expect(forTask.contract?.map((claim) => claim.name)).toContain('reopen_task');
  });

  it('carries no contract and no impact on a maintenance phase, while the phase’s own task carries both', async () => {
    const quiz = build();
    const forQuiz = await quiz.service['reportExtras'](
      maintenancePhase,
      stateFor({ 'design/contracts.json': CONTRACTS }),
      reportSoFar(),
      undefined,
      quizTask(),
    );
    expect(forQuiz).toEqual({});
    expect(forQuiz.contract).toBeUndefined();
    expect(forQuiz.impact).toBeUndefined();
    // The impact report is the learner's implementation baseline read back;
    // the quiz does not reach for it either.
    expect(quiz.submissions.find).not.toHaveBeenCalled();

    const executable = build();
    const forTask = await executable.service['reportExtras'](
      maintenancePhase,
      stateFor({ 'design/contracts.json': CONTRACTS }),
      reportSoFar(),
      undefined,
      gradedTask(maintenancePhase),
    );
    expect(forTask.contract?.map((claim) => claim.name)).toContain('reopen_task');
    expect(forTask.impact).toBeDefined();
  });

  it('adds nothing to a written phase for either task, which is unchanged', async () => {
    // The equivalence: the guard moves nothing on a phase that had no sections
    // to begin with, and a quiz on a written phase is the plain case.
    const { service, enrollments } = build();
    for (const task of [gradedTask(designPhase), quizTask()]) {
      expect(
        await service['reportExtras'](
          { key: 'requirements', files: [], checks: { kind: 'tests' } } as any,
          stateFor(null),
          reportSoFar(),
          undefined,
          task,
        ),
      ).toEqual({});
    }
    expect(enrollments.findOneByOrFail).not.toHaveBeenCalled();
  });
});
