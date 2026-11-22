import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { INHERITED_TASK_KEY, REQUIREMENTS_OLDER_FORMAT_ROOM, RUNBOOK_OLDER_FORMAT_ROOM, RUNNER_UNAVAILABLE_MESSAGE, SOLE_TASK_KEY, serialiseStory } from '@learnsdlc/shared';
import type { AnalyzerReport, ReportStepTiming, RunResult, TestCaseResult } from '@learnsdlc/shared';
import { DataSource, In, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { QUEUE_UNAVAILABLE_MESSAGE } from '../jobs/bull.queue';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import * as errors from '../observability/errors';
import { ContentService } from '../content/content.service';
import { SandboxService } from '../execution/sandbox.service';
import type { PhaseContent, PhaseRun, StoryChecks } from '../content/content.types';
import { fixtureQuizChecks, writtenPhase } from '../../test/quiz-fixture';
import { HOST_STORY } from '../../test/written-phase-pack';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import { COMPILER_IDENTITY, soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { composeReviewMessages } from '../assistant/openai.provider';
import { FeedbackService } from './feedback.service';
import { mentorUseSentences } from './mentor-use';
import { submissionId } from './submission-id';
import { taskForRequest, taskForRevision } from './task-resolution';

/**
 * The graded paths that do not need a sandbox: dedupe, the revision list, the
 * kill matrix and the smoke check, each with in-memory stand-ins for the
 * repositories and the runner.
 */
type Row = {
  id: string;
  phaseStateId: string;
  userId: string;
  /** The `taskKey` column, at its own backfill default: the compiled sole task's key. */
  taskKey: string;
  status: string;
  score: number | null;
  passed: boolean | null;
  report: unknown;
  error: string | null;
  createdAt: Date;
  workspaceSnapshot?: Record<string, string> | null;
};

const EPOCH = Date.parse('2026-09-01T00:00:00.000Z');

/** A find operator's kind and operand, whichever way TypeORM exposes them. */
function operator(value: any): { type: string; operand: any } | null {
  if (!value || typeof value !== 'object') return null;
  const type = value.type ?? value._type;
  if (typeof type !== 'string') return null;
  return { type, operand: value.value ?? value._value };
}

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  // An array of clauses is OR in TypeORM, which is how attemptNumber counts
  // the rows that sort before one submission.
  if (Array.isArray(where)) return where.some((clause) => matches(row, clause));
  for (const [key, value] of Object.entries(where)) {
    const actual = (row as any)[key];
    const op = operator(value);
    if (op) {
      const operand = op.operand;
      const ok =
        op.type === 'in'
          ? (Array.isArray(operand) ? operand : [operand]).includes(actual)
          : op.type === 'lessThan'
            ? actual < operand
            : op.type === 'lessThanOrEqual'
              ? actual <= operand
              : (() => {
                  throw new Error(`test double does not implement ${op.type}`);
                })();
      if (!ok) return false;
    } else if (actual !== value) {
      return false;
    }
  }
  return true;
}

function submissionRepo(rows: Row[]) {
  // The ties are the point. sqlite stores `createdAt` to the second, so two
  // submissions inside one second are indistinguishable by timestamp and the
  // id decides, but only for a query that asked for it. Ordering ties the way
  // the database would leaves an unordered query returning the older row here
  // too, which is what makes the spec able to see the bug.
  const ordered = (opts: any) => {
    const dir = opts.order?.createdAt === 'DESC' ? -1 : 1;
    const tie = opts.order?.id === 'DESC' ? -1 : 1;
    const out = rows
      .filter((r) => matches(r, opts.where))
      .sort(
        (a, b) =>
          dir * (a.createdAt.getTime() - b.createdAt.getTime()) || tie * a.id.localeCompare(b.id),
      );
    return opts.take ? out.slice(0, opts.take) : out;
  };
  return {
    findOne: jest.fn(async (opts: any) => ordered({ ...opts, order: opts.order ?? { createdAt: 'DESC' } })[0] || null),
    find: jest.fn(async (opts: any) => {
      const out = ordered(opts);
      if (!opts.select) return out;
      const keys = Object.keys(opts.select).filter((k) => opts.select[k]);
      return out.map((r) => Object.fromEntries(keys.map((k) => [k, (r as any)[k]])) as Row);
    }),
    count: jest.fn(async (opts: any) => rows.filter((r) => matches(r, opts.where)).length),
    create: jest.fn((fields: any) => ({ ...fields })),
    save: jest.fn(async (row: any) => {
      const saved = {
        score: null,
        passed: null,
        report: null,
        error: null,
        // The column's default, so the double answers the narrowed in-flight
        // and attempt reads the way the schema does.
        taskKey: SOLE_TASK_KEY,
        ...row,
        id: row.id || `sub-${rows.length + 1}`,
        // Stamped now, the way the column's default does: the in-flight guard
        // is bounded by age, so a row this test just created must not read as
        // one left behind days ago.
        createdAt: row.createdAt || new Date(),
      };
      rows.push(saved);
      return saved;
    }),
    // Writes land, so a row aged out of the in-flight guard is really out of it.
    update: jest.fn(async (criteria: any, patch: any) => {
      const where = typeof criteria === 'string' ? { id: criteria } : criteria;
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, patch);
      return { affected: hit.length };
    }),
  };
}

function seed(rows: Row[], fields: Partial<Row> & { id: string }): Row {
  const row: Row = {
    phaseStateId: 'ps-1',
    userId: 'u-1',
    taskKey: SOLE_TASK_KEY,
    status: 'completed',
    score: 80,
    passed: true,
    report: null,
    error: null,
    createdAt: new Date(EPOCH + rows.length * 1000),
    workspaceSnapshot: { 'cli.py': 'print(1)' },
    ...fields,
  };
  rows.push(row);
  return row;
}

const designPhase = {
  key: 'design',
  files: [{ path: 'docs/notes.md', content: '# scaffold', editable: true, language: 'markdown' }],
} as any;

/** Mirrors ContentService.executionFiles: the learner's copy wins where they have one. */
function contentStub(phase: unknown = designPhase) {
  const stub = {
    executionFiles: jest.fn((phase: any, workspace: Record<string, string> | null) =>
      Object.fromEntries(
        phase.files.map((f: any) => [
          f.path,
          f.editable && workspace && workspace[f.path] !== undefined ? workspace[f.path] : f.content,
        ]),
      ),
    ),
    getPhase: jest.fn((_slug?: string, _key?: string) => phase as any),
    // Every submission is stamped with the pack version, so the stub project
    // carries one, and the six keys it holds: the conformance ledger asks
    // whether the version holds Design before it reads it.
    getProject: jest.fn((_slug?: string) => ({
      slug: 'tasktrackr',
      version: '1.4.0',
      phases: ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'].map((key, at) => ({ key, order: at + 1 })),
    })),
    // The enrolment-scoped accessors the service resolves through. They
    // delegate to the plain accessors, which version a pin resolves is proved in
    // `workflow/pin.spec.ts`, against two really published versions, because a
    // stub cannot have two.
    getPhaseForEnrollment: jest.fn(
      (enrollment: { projectSlug: string }, key: string): any =>
        stub.getPhase(enrollment.projectSlug, key),
    ),
    getForEnrollment: jest.fn(
      (enrollment: { projectSlug: string }): any => stub.getProject(enrollment.projectSlug),
    ),
    // The task grain, at its sole-task arm. Every phase of the shipped project
    // compiles to one *synthesised* task keyed `SOLE_TASK_KEY`, so
    // `soleTaskList` is true, no `task_states` row is ever written and every
    // submit in this file runs the phase-level statements the rows below
    // assert. A phase keyed `main`, and
    // the creator and the adoption it brings, is
    // `workflow/task-states.spec.ts`'s, against a really published copy,
    // because a stub cannot have one.
    getTasksForEnrollment: jest.fn(
      (_enrollment: { projectSlug: string }, _key: string): any => [soleTask(phase)],
    ),
  };
  return stub;
}

/**
 * The phase's synthesised sole task, as the compiler mints it (`soleTaskFor`).
 *
 * `soleTaskList` is true over a one-element list keyed `SOLE_TASK_KEY`, so
 * every per-task derivation in the grader takes its phase-wide arm: the task's
 * rubric *is* the phase's object, its owned paths *are* every editable path and
 * `checksOf` answers `phase.checks`. That is what lets every row of this file
 * assert phase-level behaviour.
 *
 * The check lists are defaulted because the fixtures here declare only what
 * their own assertions need, and `gradedUnitsOf` walks whichever list the kind
 * names. The units it produces are read only on the authored arm, which a sole
 * task never takes.
 */
function soleTask(phase: any): CompiledTask {
  return soleTaskFor({
    ...phase,
    checks: { kind: 'code', targets: [], rules: [], runs: [], mutants: [], ...phase.checks },
  } as any);
}

function build(stubs: { sandbox?: unknown; execution?: unknown; state?: unknown } = {}) {
  const rows: Row[] = [];
  const submissions = submissionRepo(rows);
  const phaseStates = {
    save: jest.fn(async (s: any) => s),
    update: jest.fn(async (_criteria: any, _patch: any) => undefined),
    findOne: jest.fn(async () => null),
    findOneByOrFail: jest.fn(async (where: any) => stubs.state ?? { id: where.id }),
  };
  const enrollments = {
    findOneByOrFail: jest.fn(async () => ({ id: 'e-1', projectSlug: 'tasktrackr' })),
  };
  const content = contentStub();
  const messages = { count: jest.fn(async () => 0), find: jest.fn(async () => []) };
  const assistant = { reviewSubmission: jest.fn(async () => ({ summary: 'reviewed' })) };
  const jobs = { enqueue: jest.fn(async () => undefined), register: jest.fn(), durable: false };
  // The submit's lock-to-insert section runs in one
  // transaction on the repositories' manager. These doubles have no database,
  // so the manager routes each call to the double that already answers it,
  // and its "transaction" is the work itself (the sqlite shape: one
  // connection, `atomic` serialises).
  const txManager: any = {
    connection: { options: { type: 'better-sqlite3' }, transaction: (work: any) => work(txManager) },
    findOne: (entity: unknown, opts: any) =>
      entity === SubmissionEntity ? submissions.findOne(opts) : Promise.resolve(null),
    findOneByOrFail: (_entity: unknown, where: any) => phaseStates.findOneByOrFail(where),
    update: (entity: unknown, criteria: any, patch: any) =>
      entity === PhaseStateEntity ? phaseStates.update(criteria, patch) : submissions.update(criteria, patch),
    create: (_entity: unknown, fields: any) => submissions.create(fields),
    save: (_entity: unknown, row: any) => submissions.save(row),
  };
  (submissions as any).manager = txManager;
  const service = new FeedbackService(
    submissions as any,
    phaseStates as any,
    enrollments as any,
    messages as any,
    content as any,
    (stubs.sandbox ?? {}) as any,
    (stubs.execution ?? {}) as any,
    assistant as any,
    jobs as any,
    {} as any,
    // The bell. A stub that resolves, because the pipeline awaits
    // it inside its own try: an undefined provider would be a thrown
    // TypeError on the success branch rather than a missing notification.
    { onVerdict: jest.fn(async () => undefined) } as any,
  );
  return { service, rows, submissions, phaseStates, enrollments, content, messages, assistant, jobs };
}

const implementationPhase = {
  key: 'implementation',
  files: [
    { path: 'tasktrackr/manager.py', content: '# scaffold', editable: true, language: 'python' },
    { path: 'tests/test_visible.py', content: '# given', editable: false, language: 'python' },
  ],
} as any;

describe('FeedbackService.submit', () => {
  const phase = implementationPhase;

  it('queues one submission and counts the attempt', async () => {
    const { service, rows, jobs, phaseStates } = build();
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;
    const view = await service.submit(phase, state);
    expect(view.status).toBe('queued');
    expect(rows).toHaveLength(1);
    expect(state.attempts).toBe(1);
    // The counter column and nothing else: a save() of the whole entity would
    // write this request's copy of `workspace` back over the autosave that
    // landed while it was running. And the counter is incremented by the
    // database, not by this request's copy of the number, so two submits that
    // overlap cannot both write the same value back.
    expect(phaseStates.update).toHaveBeenCalledTimes(1);
    expect(phaseStates.update).toHaveBeenCalledWith('ps-1', { attempts: expect.any(Function) });
    expect(phaseStates.update.mock.calls[0][1].attempts()).toBe('attempts + 1');
    expect(phaseStates.save).not.toHaveBeenCalled();
    // The owner is what the fair scheduler takes turns by, so the
    // payload names it. A submission that reached the queue unowned would
    // share one turn with every other unowned job.
    expect(jobs.enqueue).toHaveBeenCalledWith('submission', {
      id: view.id,
      ownerId: 'u-1',
    });
  });

  it('returns the in-flight submission instead of queuing a second one', async () => {
    const { service, rows, jobs } = build();
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;
    const first = await service.submit(phase, state);
    const second = await service.submit(phase, state);
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(state.attempts).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);

    // once grading has finished the learner can submit again
    rows[0].status = 'completed';
    const third = await service.submit(phase, state);
    expect(third.id).not.toBe(first.id);
    expect(rows).toHaveLength(2);
    expect(state.attempts).toBe(2);
  });

  it('dedupes per phase, not per learner', async () => {
    const { service, rows } = build();
    const a = await service.submit(phase, { id: 'ps-a', userId: 'u-1', attempts: 0, workspace: null } as any);
    const b = await service.submit(phase, { id: 'ps-b', userId: 'u-1', attempts: 0, workspace: null } as any);
    expect(a.id).not.toBe(b.id);
    expect(rows).toHaveLength(2);
  });

  it('waits on a submission that is being graded right now', async () => {
    const { service, rows, jobs } = build();
    const live = seed(rows, {
      id: 'sub-live',
      status: 'running',
      score: null,
      passed: null,
      createdAt: new Date(Date.now() - 90_000),
    });
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;

    const view = await service.submit(phase, state);

    expect(view.id).toBe(live.id);
    expect(rows).toHaveLength(1);
    expect(state.attempts).toBe(0);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('steps over a submission wedged in flight and grades the new one', async () => {
    // A job can end without its row ever being written (BullMQ fails a job
    // that stalls past maxStalledCount without calling the handler at all) and
    // an unbounded guard turns that into a phase gate nobody can open again.
    const { service, rows, jobs } = build();
    const wedged = seed(rows, {
      id: 'sub-wedged',
      status: 'running',
      score: null,
      passed: null,
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;

    const view = await service.submit(phase, state);

    expect(view.id).not.toBe(wedged.id);
    expect(view.status).toBe('queued');
    // The owner is what the fair scheduler takes turns by, so the
    // payload names it. A submission that reached the queue unowned would
    // share one turn with every other unowned job.
    expect(jobs.enqueue).toHaveBeenCalledWith('submission', {
      id: view.id,
      ownerId: 'u-1',
    });
    // Written off first, which is also what frees UQ_submissions_in_flight for
    // the row that follows it.
    expect(wedged.status).toBe('failed');
    expect(wedged.error).toContain('stopped responding');
    expect(state.attempts).toBe(1);
  });

  it('hands the attempt back when the queue refuses the work', async () => {
    const { service, rows, jobs } = build();
    jobs.enqueue.mockRejectedValueOnce(new Error(QUEUE_UNAVAILABLE_MESSAGE));
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;

    await expect(service.submit(phase, state)).rejects.toThrow(QUEUE_UNAVAILABLE_MESSAGE);

    // Nothing is holding this phase's in-flight slot for a job that was never
    // accepted, and the learner has not been charged for it.
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe(QUEUE_UNAVAILABLE_MESSAGE);
    expect(state.attempts).toBe(0);
  });

  it('stores a snapshot of the editable files as they were graded', async () => {
    const state = {
      id: 'ps-1',
      userId: 'u-1',
      attempts: 0,
      workspace: { 'tasktrackr/manager.py': 'def complete_task():\n    return True\n' },
    } as any;
    // The snapshot is of the phase row as re-read under the
    // enrolment lock, so the double's store must hold that row.
    const { service, rows } = build({ state });
    await service.submit(phase, state);
    expect(rows[0].workspaceSnapshot).toEqual({
      'tasktrackr/manager.py': 'def complete_task():\n    return True\n',
    });
  });
});

describe('FeedbackService.listFor', () => {
  it('returns the revisions oldest first with attempt numbers and no snapshots', async () => {
    const { service, rows } = build();
    seed(rows, { id: 'sub-1', score: 40 });
    seed(rows, { id: 'sub-2', score: 60 });
    seed(rows, { id: 'sub-3', score: 90 });
    seed(rows, { id: 'other-phase', phaseStateId: 'ps-2' });
    seed(rows, { id: 'other-learner', userId: 'u-2' });

    const list = await service.listFor('ps-1', 'u-1');
    expect(list.map((s) => s.id)).toEqual(['sub-1', 'sub-2', 'sub-3']);
    expect(list.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(list.every((s) => !('workspaceSnapshot' in s))).toBe(true);
  });

  it('keeps the newest 50 and still numbers them from the first attempt', async () => {
    const { service, rows } = build();
    for (let i = 1; i <= 60; i += 1) seed(rows, { id: `sub-${String(i).padStart(2, '0')}` });

    const list = await service.listFor('ps-1', 'u-1');
    expect(list).toHaveLength(50);
    expect(list[0].attempt).toBe(11);
    expect(list[49].attempt).toBe(60);
    expect(list[49].id).toBe('sub-60');
  });

  it('is empty for a phase with no submissions', async () => {
    const { service } = build();
    expect(await service.listFor('ps-1', 'u-1')).toEqual([]);
  });
});

describe('FeedbackService.getSubmission', () => {
  it('adds the attempt number and the workspace snapshot', async () => {
    const { service, rows } = build();
    seed(rows, { id: 'sub-1' });
    seed(rows, { id: 'sub-2', workspaceSnapshot: { 'cli.py': 'print(2)' } });

    const view = await service.getSubmission('sub-2', 'u-1', { snapshot: true });
    expect(view.attempt).toBe(2);
    expect(view.workspaceSnapshot).toEqual({ 'cli.py': 'print(2)' });
  });

  it('leaves the snapshot out unless it is asked for, because this is the poll route', async () => {
    const { service, rows } = build();
    seed(rows, { id: 'sub-1' });
    seed(rows, { id: 'sub-2', workspaceSnapshot: { 'cli.py': 'print(2)' } });

    const view = await service.getSubmission('sub-2', 'u-1');
    expect(view.attempt).toBe(2);
    expect('workspaceSnapshot' in view).toBe(false);
  });

  it('reports a null snapshot for a submission graded before snapshots existed', async () => {
    const { service, rows } = build();
    seed(rows, { id: 'sub-1', workspaceSnapshot: undefined });
    const view = await service.getSubmission('sub-1', 'u-1', { snapshot: true });
    expect(view.attempt).toBe(1);
    expect(view.workspaceSnapshot).toBeNull();
  });

  it('refuses another learner submission', async () => {
    const { service, rows } = build();
    seed(rows, { id: 'sub-1', userId: 'u-2' });
    await expect(service.getSubmission('sub-1', 'u-1')).rejects.toThrow('submission not found');
  });
});

/* ------------------------------ kill matrix ------------------------------ */

function testsRun(cases: TestCaseResult[]): RunResult {
  const failed = cases.filter((c) => c.status === 'failed').length;
  const errored = cases.filter((c) => c.status === 'errored').length;
  return {
    ok: failed === 0 && errored === 0,
    exitKind: 'ok',
    stdout: '',
    stderr: '',
    durationMs: 5,
    tests: { total: cases.length, passed: cases.length - failed - errored, failed, errored, cases },
  };
}

const PASSING = [
  { name: 'test_complete_marks_done', status: 'passed' as const },
  { name: 'test_overdue_boundary', status: 'passed' as const },
];

const testingPhase = {
  key: 'testing',
  language: 'python',
  rubric: {
    passThreshold: 70,
    criteria: [
      { key: 'tests_pass', title: 'Suite passes', weight: 0.3, description: '' },
      { key: 'mutants_killed', title: 'Mutants killed', weight: 0.45, description: '' },
      { key: 'coverage_mapping', title: 'Coverage', weight: 0.25, description: '' },
    ],
  },
  checks: {
    kind: 'tests',
    learnerTestFiles: ['tests/test_acceptance.py'],
    implFiles: { 'tasktrackr/manager.py': '# reference' },
    mutants: [
      { name: 'complete_noop', description: 'complete_task does nothing', files: {}, covers: 'US-2/AC-1' },
      { name: 'done_returns_open', description: 'done tasks report as open', files: {} },
      { name: 'overdue_boundary', description: 'overdue is off by one day', files: {} },
    ],
    coverageKeywords: [{ criterion: 'US-2/AC-1', keywords: ['complete'] }],
    minTests: 2,
  },
} as any;

const learnerSuite = {
  learnerTestFiles: jest.fn(() => ({
    'tests/test_acceptance.py':
      'def test_complete_marks_done():\n    assert True\n\ndef test_overdue_boundary():\n    assert True\n',
  })),
};

describe('FeedbackService mutation matrix', () => {
  it('keeps a row per mutant and only counts a failing suite as a kill', async () => {
    const runs: RunResult[] = [
      testsRun(PASSING), // the suite on the reference implementation
      testsRun([{ name: 'test_complete_marks_done', status: 'failed', message: 'AssertionError' }, PASSING[1]]),
      testsRun(PASSING), // survived: every test still passes against the bug
      { ok: false, exitKind: 'error', stdout: '', stderr: 'SyntaxError', durationMs: 3 }, // crashed harness
    ];
    const sandbox = { execute: jest.fn(async () => runs.shift() as RunResult) };
    const { service } = build({ sandbox, execution: learnerSuite });

    const report = await service['buildTestsReport'](testingPhase, testingPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);

    // A crash with no result line proves nothing, so it is not a kill.
    expect(report.mutation?.killed).toBe(1);
    expect(report.mutation?.survivors.map((s) => s.name)).toEqual(['done_returns_open', 'overdue_boundary']);

    const matrix = report.mutation?.matrix ?? [];
    expect(matrix.map((r) => r.mutant)).toEqual(['complete_noop', 'done_returns_open', 'overdue_boundary']);
    expect(matrix[0]).toMatchObject({ killed: true, covers: 'US-2/AC-1' });
    expect(matrix[0].cases).toEqual([
      { name: 'test_complete_marks_done', status: 'failed' },
      { name: 'test_overdue_boundary', status: 'passed' },
    ]);
    expect(matrix[1].killed).toBe(false);
    expect(matrix[1].covers).toBeUndefined();
    expect(matrix[2]).toMatchObject({ killed: false, cases: [] });
  });

  it('reports an empty matrix when the suite does not pass on the reference implementation', async () => {
    const sandbox = {
      execute: jest.fn(async () => testsRun([{ name: 'test_complete_marks_done', status: 'failed' }])),
    };
    const { service } = build({ sandbox, execution: learnerSuite });

    const report = await service['buildTestsReport'](testingPhase, testingPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);

    expect(sandbox.execute).toHaveBeenCalledTimes(1); // no mutant is run
    expect(report.mutation?.killed).toBe(0);
    expect(report.mutation?.matrix?.map((r) => ({ mutant: r.mutant, killed: r.killed, cases: r.cases }))).toEqual([
      { mutant: 'complete_noop', killed: false, cases: [] },
      { mutant: 'done_returns_open', killed: false, cases: [] },
      { mutant: 'overdue_boundary', killed: false, cases: [] },
    ]);
  });
});

/* --------------------- graded artefacts and parallelism --------------------- */

/** The six mutants a real pack ships, each overlaying the implementation file. */
const SEALED_MUTANTS = [
  'complete_noop',
  'complete_unknown_returns_none',
  'done_returns_open',
  'filter_ignores_keyword',
  'overdue_boundary',
  'priority_order_reversed',
].map((name) => ({
  name,
  description: `${name} plants a bug`,
  files: { 'tasktrackr/manager.py': `# ${name}` },
}));

const sealedPhase = {
  ...testingPhase,
  checks: { ...testingPhase.checks, mutants: SEALED_MUTANTS },
} as any;

/** Which implementation a job was given, by the one line each copy carries. */
const implOf = (job: any) => job.gradedFiles?.['tasktrackr/manager.py'];

describe('FeedbackService mutation runs', () => {
  it('keeps the graded implementation out of the workspace the learner tests run in', async () => {
    const jobs: any[] = [];
    const sandbox = {
      execute: jest.fn(async (job: any) => {
        jobs.push(job);
        return testsRun(PASSING);
      }),
    };
    const { service } = build({ sandbox, execution: learnerSuite });

    await service['buildTestsReport'](sealedPhase, sealedPhase.checks, { id: 'ps-1', workspace: null } as any);

    expect(jobs).toHaveLength(1 + SEALED_MUTANTS.length);
    for (const job of jobs) {
      // The learner's suite is the whole workspace. The implementation it is
      // graded against is a graded artefact, which the runner keeps outside it.
      expect(Object.keys(job.files)).toEqual(['tests/test_acceptance.py']);
      expect(job.files['tasktrackr/manager.py']).toBeUndefined();
      expect(job.testPaths).toEqual(['tests/test_acceptance.py']);
    }
    // The reference run is sealed too: seal only the mutants and a test that
    // reads the file passes here and errors against all six, and an errored
    // suite is a kill.
    expect(jobs.map(implOf)).toEqual(['# reference', ...SEALED_MUTANTS.map((m) => `# ${m.name}`)]);
  });

  it('runs the mutants together and keeps the matrix in the pack order', async () => {
    // Each mutant answers a little sooner than the one before, so the runs
    // finish in the reverse of the order the pack lists them in.
    const delayFor = (impl: string) => {
      const at = SEALED_MUTANTS.findIndex((m) => `# ${m.name}` === impl);
      return at < 0 ? 40 : 40 - at * 5;
    };
    let inFlight = 0;
    let peak = 0;
    const sandbox = {
      execute: jest.fn(async (job: any) => {
        const impl = implOf(job);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delayFor(impl)));
        inFlight -= 1;
        if (impl === '# reference') return testsRun(PASSING);
        // one case per mutant, so a row that ends up beside the wrong mutant shows
        return testsRun([{ name: `caught ${impl}`, status: 'failed', message: 'AssertionError' }]);
      }),
    };
    const { service } = build({ sandbox, execution: learnerSuite });

    const started = Date.now();
    const report = await service['buildTestsReport'](sealedPhase, sealedPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);
    const elapsed = Date.now() - started;

    // Serially this is seven runs, at least 205 ms of them; together it is two.
    expect(peak).toBe(SEALED_MUTANTS.length);
    expect(elapsed).toBeLessThan(160);
    expect(report.mutation?.killed).toBe(SEALED_MUTANTS.length);
    const matrix = report.mutation?.matrix ?? [];
    expect(matrix.map((r) => r.mutant)).toEqual(SEALED_MUTANTS.map((m) => m.name));
    expect(matrix.map((r) => r.cases[0].name)).toEqual(SEALED_MUTANTS.map((m) => `caught # ${m.name}`));
  });

  it('gives the outage back when a mutant run cannot reach the runner', async () => {
    const unavailable: RunResult = {
      ok: false,
      exitKind: 'unavailable',
      stdout: '',
      stderr: '',
      durationMs: 1,
    };
    const sandbox = {
      execute: jest.fn(async (job: any) =>
        implOf(job) === '# reference' ? testsRun(PASSING) : unavailable,
      ),
    };
    const { service } = build({ sandbox, execution: learnerSuite });

    // Six rejections settle, and the first in mutant order is the one thrown:
    // the outage still leaves the pipeline here rather than scoring a zero.
    await expect(
      service['buildTestsReport'](sealedPhase, sealedPhase.checks, { id: 'ps-1', workspace: null } as any),
    ).rejects.toThrow(RUNNER_UNAVAILABLE_MESSAGE);
  });
});

/**
 * The whole mutation path against the real packs and the real runner: the
 * reference suite each pack ships is imported from a workspace that holds
 * nothing but itself, and it still kills all six planted bugs.
 */
describe('FeedbackService mutation against the real packs (sandbox)', () => {
  const content = new ContentService();
  content.loadAll();

  for (const project of content.listProjects()) {
    it(`${project.slug}: the reference suite kills every mutant through the sealed runner`, async () => {
      const phase = content.getPhase(project.slug, 'testing');
      const checks = phase.checks;
      if (checks.kind !== 'tests') throw new Error('expected tests checks');
      const { service } = build({
        sandbox: new SandboxService(),
        execution: { learnerTestFiles: jest.fn(() => checks.referenceTestFiles) },
      });

      const report = await service['buildTestsReport'](phase, checks, {
        id: 'ps-1',
        workspace: null,
      } as any);

      expect(report.tests?.failed).toBe(0);
      expect(report.tests?.errored).toBe(0);
      expect(report.mutation?.survivors).toEqual([]);
      expect(report.mutation?.killed).toBe(checks.mutants.length);
      expect(report.mutation?.matrix ?? []).toHaveLength(checks.mutants.length);
      expect((report.mutation?.matrix ?? []).map((r) => r.mutant)).toEqual(
        checks.mutants.map((m) => m.name),
      );
    }, 120000);
  }
});

/* --------------------------- frames passthrough --------------------------- */

const codePhase = {
  key: 'implementation',
  language: 'python',
  files: implementationPhase.files,
  rubric: {
    passThreshold: 70,
    criteria: [
      { key: 'correctness_hidden', title: 'Hidden tests', weight: 0.4, description: '' },
      { key: 'visible_tests', title: 'Visible tests', weight: 0.3, description: '' },
      { key: 'code_quality', title: 'Code quality', weight: 0.2, description: '' },
      { key: 'process', title: 'Process', weight: 0.1, description: '' },
    ],
  },
  checks: {
    kind: 'code',
    editableTargets: ['tasktrackr/manager.py'],
    visibleTests: ['tests/test_visible.py'],
    hiddenTestFiles: { 'tests/test_hidden.py': '# hidden' },
    solutionSources: [],
  },
} as any;

const analysis: AnalyzerReport = {
  issues: [],
  metrics: { files: 2, functions: 4, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 1 },
};

describe('FeedbackService report.tests', () => {
  it('passes the runner frames and durations through untouched', async () => {
    const visible = testsRun([
      {
        name: 'test_complete_marks_done',
        status: 'failed',
        message: 'AssertionError: task still open',
        durationMs: 12,
        frames: [
          { path: 'tasktrackr/manager.py', line: 42, snippet: 'raise KeyError(task_id)' },
          { path: 'tests/test_visible.py', line: 8, snippet: 'manager.complete(1)' },
        ],
      },
    ]);
    const hidden = testsRun([{ name: 'test_unknown_id', status: 'passed', durationMs: 3 }]);
    const runs = [visible, hidden];
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => runs.shift() as RunResult),
    };
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](codePhase, codePhase.checks, {
      id: 'ps-1',
      workspace: null,
      ranBeforeSubmit: true,
    } as any, 0);

    const failing = report.tests?.cases.find((c) => c.name === 'test_complete_marks_done');
    expect(failing?.durationMs).toBe(12);
    expect(failing?.frames).toEqual([
      { path: 'tasktrackr/manager.py', line: 42, snippet: 'raise KeyError(task_id)' },
      { path: 'tests/test_visible.py', line: 8, snippet: 'manager.complete(1)' },
    ]);
    const hiddenCase = report.tests?.cases.find((c) => c.name === 'test_unknown_id');
    expect(hiddenCase).toMatchObject({ hidden: true, durationMs: 3 });
  });
});

describe('FeedbackService hidden test frames', () => {
  const SECRET = "self.assertEqual(add(-1, 1), 0, 'SECRET EDGE CASE: signs cancel')";

  it('strips the frames of a case that failed outside the learner files', async () => {
    // The hidden suite is written into the workspace to be run, and the runner
    // returns a frame for any file inside it, so a failing hidden case came
    // back carrying the path, the line and the source of the case that caught
    // the learner out.
    const visible = testsRun([
      {
        name: 'test_complete_marks_done',
        status: 'failed',
        message: 'AssertionError: task still open',
        frames: [
          { path: 'tasktrackr/manager.py', line: 42, snippet: 'raise KeyError(task_id)' },
          { path: 'tests/test_visible.py', line: 8, snippet: 'manager.complete(1)' },
        ],
      },
    ]);
    const hidden = testsRun([
      {
        name: 'test_hidden_edge',
        status: 'failed',
        message: `AssertionError: 0 != -1\n  ${SECRET}\n`,
        frames: [{ path: 'tests/test_hidden.py', line: 5, snippet: SECRET }],
      },
      {
        name: 'test_hidden_long_message',
        status: 'failed',
        message: `AssertionError: ${'e'.repeat(400)}`,
        frames: [{ path: 'tests/test_hidden.py', line: 9, snippet: SECRET }],
      },
      {
        name: 'test_hidden_through_learner_code',
        status: 'failed',
        message: 'KeyError: 7',
        frames: [
          { path: 'tasktrackr/manager.py', line: 42, snippet: 'raise KeyError(task_id)' },
          { path: 'tests/test_hidden.py', line: 12, snippet: SECRET },
        ],
      },
    ]);
    const runs = [visible, hidden];
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => runs.shift() as RunResult),
    };
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](
      codePhase,
      codePhase.checks,
      { id: 'ps-1', workspace: null, ranBeforeSubmit: true } as any,
      0,
    );
    const caseFor = (name: string) => report.tests?.cases.find((c) => c.name === name);

    // The hidden case whose deepest frame is the hidden file itself: no frames,
    // and one capped line of the message.
    expect(caseFor('test_hidden_edge')).toEqual({
      name: 'test_hidden_edge',
      status: 'failed',
      hidden: true,
      message: 'AssertionError: 0 != -1',
    });
    expect(caseFor('test_hidden_long_message')?.message).toHaveLength(160);
    // Its own code raised it, so that frame is the learner's to read, and the
    // hidden case that called into it is not, even as a caller frame.
    expect(caseFor('test_hidden_through_learner_code')).toEqual({
      name: 'test_hidden_through_learner_code',
      status: 'failed',
      hidden: true,
      message: 'KeyError: 7',
      frames: [{ path: 'tasktrackr/manager.py', line: 42, snippet: 'raise KeyError(task_id)' }],
    });
    // Nothing anywhere in the report names the hidden suite or its source.
    expect(JSON.stringify(report)).not.toContain('SECRET EDGE CASE');
    expect(JSON.stringify(report)).not.toContain('tests/test_hidden.py');
    // The visible failure is untouched: the learner can open both of its files.
    expect(caseFor('test_complete_marks_done')?.frames).toEqual([
      { path: 'tasktrackr/manager.py', line: 42, snippet: 'raise KeyError(task_id)' },
      { path: 'tests/test_visible.py', line: 8, snippet: 'manager.complete(1)' },
    ]);
    expect(caseFor('test_complete_marks_done')?.message).toBe('AssertionError: task still open');
  });
});

/* ----------------------------- smoke check ------------------------------- */

const deploymentPhase = {
  key: 'deployment',
  language: 'python',
  files: [
    { path: 'Dockerfile', content: '# scaffold', editable: true, language: 'dockerfile' },
    { path: '.github/workflows/ci.yml', content: '# scaffold', editable: true, language: 'yaml' },
    { path: 'deployment/runbook.json', content: '{}', editable: true, language: 'json' },
    { path: 'cli.py', content: '# reference cli', editable: false, language: 'python' },
  ],
  rubric: {
    passThreshold: 70,
    criteria: [{ key: 'build_smoke', title: 'Build check', weight: 1, description: '' }],
  },
  checks: {
    kind: 'config',
    rules: [],
    // The smoke map carries the CLI the ENTRYPOINT starts, as both shipped
    // packs do: the smoke check refuses an ENTRYPOINT naming a file the phase does not
    // ship, so a fixture without it would be testing that refusal instead.
    smokeImplFiles: { 'tasktrackr/manager.py': '# reference', 'cli.py': '# reference cli' },
    smokeCommands: [['python', 'cli.py', 'list']],
    expectInOutput: 'Tasks',
    drill: {
      // The fault both packs ship: the container's working directory and the
      // path its ENTRYPOINT starts do not agree, so nothing lives there.
      fault: 'workdir-entrypoint-mismatch',
      description: 'WORKDIR is /srv but the ENTRYPOINT starts /app/cli.py, so the container exits immediately',
      faultedFiles: {
        Dockerfile: 'FROM python:3.11-slim\nWORKDIR /srv\nCOPY . /app\nENTRYPOINT ["python", "/app/cli.py"]\n',
      },
      expectFailure: true,
    },
  },
} as any;

const DOCKERFILE = 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT ["python", "/app/cli.py"]\n';

describe('FeedbackService.runSmokeCheck', () => {
  it('starts the CLI through the argv from the learner Dockerfile', async () => {
    const sandbox = {
      execute: jest.fn(async () => ({
        ok: true,
        exitKind: 'ok' as const,
        stdout: 'Tasks',
        stderr: '',
        durationMs: 42,
      })),
    };
    const { service } = build({ sandbox });

    const smoke = await service.runSmokeCheck(deploymentPhase, { Dockerfile: DOCKERFILE });
    expect(smoke).toMatchObject({ ok: true, stdout: 'Tasks', durationMs: 42, argv: ['python', 'cli.py'] });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'smoke',
        smokeCommands: [['python', 'cli.py', 'list']],
        expectInOutput: 'Tasks',
        files: expect.objectContaining({ 'tasktrackr/manager.py': '# reference', Dockerfile: DOCKERFILE }),
      }),
    );
  });

  it('reports the problem and runs nothing when the Dockerfile starts no CLI', async () => {
    const sandbox = { execute: jest.fn() };
    const { service } = build({ sandbox });

    const smoke = await service.runSmokeCheck(deploymentPhase, { Dockerfile: 'FROM python:3.11-slim\n' });
    expect(smoke.ok).toBe(false);
    expect(smoke.argv).toEqual([]);
    expect(smoke.problem).toContain('no ENTRYPOINT or CMD');
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it('says so for a phase without a smoke check', async () => {
    const { service } = build();
    const smoke = await service.runSmokeCheck(testingPhase, {});
    expect(smoke.ok).toBe(false);
    expect(smoke.problem).toBe('The testing phase has no smoke check.');
  });

  it('is the same run the build check scores, not a second one', async () => {
    const sandbox = {
      execute: jest.fn(async () => ({
        ok: true,
        exitKind: 'ok' as const,
        stdout: 'Tasks',
        stderr: '',
        durationMs: 42,
      })),
    };
    const { service } = build({ sandbox });

    const built = await service['buildConfigReport'](deploymentPhase, deploymentPhase.checks, {
      id: 'ps-1',
      workspace: { Dockerfile: DOCKERFILE },
    } as any);

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(built.smoke.ok).toBe(true);
    expect(built.report.checks.find((c) => c.id === 'build-smoke')?.status).toBe('passed');
    expect(built.report.checks.find((c) => c.id === 'execution-scope')).toMatchObject({ status: 'info', detail: expect.stringContaining('does not build Docker images') });
    expect(built.report.overall).toBe(100);
    // The review's line keeps "Dockerfile" a name and quotes the command; the check's detail, which the
    // reviewer model is sent, keeps its bytes.
    const line = built.report.criteria.find((c) => c.key === 'build_smoke')?.evidence[0] ?? '';
    expect(line).toMatch(/^Source syntax and isolated selfcheck passed, isolated process invoked from the Dockerfile command "[^"`]+"\. This checks /);
    expect(line).not.toMatch(/dockerfile|`/);
    expect(built.report.checks.find((c) => c.id === 'build-smoke')?.detail).toMatch(/^Isolated process invoked from Dockerfile command `[^`]+`; the selfcheck completed in 42ms\./);
  });
});

/* --------------------------- phase-specific sections --------------------- */

const CI_YAML = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m unittest discover
`;

const maintenancePhase = {
  key: 'maintenance',
  language: 'python',
  files: [
    { path: 'tasktrackr/manager.py', content: '# scaffold', editable: true, language: 'python' },
    {
      path: 'design/contracts.json',
      content: '{\n  "operations": []\n}\n',
      editable: true,
      language: 'json',
    },
  ],
  checks: { kind: 'code' },
} as any;

const reportSoFar = { overall: 80, criteria: [], checks: [] } as any;

/**
 * The task a report is about.
 *
 * `reportExtras` reads exactly one field of it, the kind that **scores** the
 * task, because a quiz has no material for any of these sections whatever
 * phase it sits in. Every row below is about a graded task, so the fixture
 * states that one field and takes it from the phase, which is what every
 * non-quiz task does by construction. The quiz's own answer
 * is asserted in `quiz-report-extras.spec.ts`.
 */
const gradedTaskOf = (phase: any): CompiledTask =>
  ({ checkKind: phase.checks.kind }) as CompiledTask;

describe('FeedbackService report sections', () => {
  it('adds the pipeline and the drill to a deployment report', async () => {
    const sandbox = { execute: jest.fn() };
    const { service } = build({ sandbox });
    const smoke = { ok: true, stdout: 'Tasks', stderr: '', durationMs: 42, argv: ['python', 'cli.py'] };

    const extras = await service['reportExtras'](
      deploymentPhase,
      { id: 'ps-1', enrollmentId: 'e-1', workspace: { Dockerfile: DOCKERFILE, '.github/workflows/ci.yml': CI_YAML } } as any,
      reportSoFar,
      smoke,
      gradedTaskOf(deploymentPhase),
    );

    expect(extras.ci?.length).toBeGreaterThan(0);
    expect(extras.drill).toMatchObject({
      fault: 'workdir-entrypoint-mismatch',
      failedBeforeFix: true,
      passedAfterFix: true,
    });
    // The incident detail names the path the faulted container starts, and the
    // fix side is the run the build check already paid for, never a second
    // graded run. This fault is refused before it can start, so the
    // drill costs no sandbox run at all.
    expect(extras.drill?.beforeStderr).toContain('/app/cli.py');
    expect(sandbox.execute).not.toHaveBeenCalled();
    expect(extras.contract).toBeUndefined();
    expect(extras.impact).toBeUndefined();
  });

  it('holds an implementation report against the design phase of the same enrolment', async () => {
    const { service, content, phaseStates, enrollments } = build();

    await service['reportExtras'](
      codePhase,
      { id: 'ps-3', enrollmentId: 'e-1', workspace: null } as any,
      reportSoFar,
      undefined,
      gradedTaskOf(codePhase),
    );

    expect(enrollments.findOneByOrFail).toHaveBeenCalledWith({ id: 'e-1' });
    expect(phaseStates.findOne).toHaveBeenCalledWith({
      where: { enrollmentId: 'e-1', phaseKey: 'design' },
    });
    // The ledger resolves the design phase through the *enrolment*, not
    // through its slug, so that a
    // learner pinned to a superseded version is held against the design phase
    // they actually agreed to.
    expect(content.getPhaseForEnrollment).toHaveBeenCalledWith(
      { id: 'e-1', projectSlug: 'tasktrackr' },
      'design',
    );
  });

  it('holds a maintenance report against the contract record that phase carries', async () => {
    // design/contracts.json is seeded from the design record at unlock and then
    // amended: an operation the learner adds there has to reach the ledger, or
    // the change request is graded against a contract nobody can edit any more.
    const { service } = build();
    const contracts = JSON.stringify({
      operations: [
        {
          name: 'reopen_task(task_id)',
          returns: 'the task with completed set back to false',
          errors: 'KeyError when the id is unknown',
        },
      ],
    });

    const extras = await service['reportExtras'](
      maintenancePhase,
      {
        id: 'ps-4',
        enrollmentId: 'e-1',
        workspace: { 'design/contracts.json': contracts },
      } as any,
      reportSoFar,
      undefined,
      gradedTaskOf(maintenancePhase),
    );

    expect(extras.contract?.map((claim) => claim.name)).toContain('reopen_task');
  });

  it('reads the maintenance scaffold when the learner has not touched the record', async () => {
    const { service } = build();
    const extras = await service['reportExtras'](
      maintenancePhase,
      { id: 'ps-4', enrollmentId: 'e-1', workspace: null } as any,
      reportSoFar,
      undefined,
      gradedTaskOf(maintenancePhase),
    );
    expect(extras.contract).toBeUndefined();
  });

  it('adds nothing to a requirements report', async () => {
    const { service, enrollments } = build();
    const extras = await service['reportExtras'](
      { key: 'requirements', files: [], checks: { kind: 'story' } } as any,
      { id: 'ps-1', enrollmentId: 'e-1', workspace: null } as any,
      reportSoFar,
      undefined,
      gradedTaskOf({ checks: { kind: 'story' } }),
    );
    expect(extras).toEqual({});
    expect(enrollments.findOneByOrFail).not.toHaveBeenCalled();
  });
});

/* ------------------------- against the real driver ----------------------- */

describe('FeedbackService.listFor with a real repository', () => {
  let dataSource: DataSource;
  let service: FeedbackService;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const repo = dataSource.getRepository(SubmissionEntity);
    for (let i = 0; i < 3; i += 1) {
      await repo.save(
        repo.create({
          phaseStateId: 'ps-1',
          userId: 'u-1',
          status: 'completed',
          score: 50 + i * 10,
          passed: i > 1,
          // Explicit so the order is the order they were made, not whatever
          // fits in one millisecond.
          createdAt: new Date(EPOCH + i * 1000),
        }),
      );
    }
    await repo.save(repo.create({ phaseStateId: 'ps-1', userId: 'u-2', status: 'queued' }));
    service = new FeedbackService(
      repo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { register: jest.fn() } as any,
      {} as any,
      { onVerdict: jest.fn(async () => undefined) } as any,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('reads the learner revisions oldest first', async () => {
    const list = await service.listFor('ps-1', 'u-1');
    expect(list.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(list.map((s) => s.score)).toEqual([50, 60, 70]);
    expect(list.every((s) => !('workspaceSnapshot' in s))).toBe(true);
  });

  it('numbers a single submission by its place in the phase', async () => {
    const list = await service.listFor('ps-1', 'u-1');
    const middle = await service.getSubmission(list[1].id, 'u-1');
    expect(middle.attempt).toBe(2);
  });
});

/**
 * One revision, one number, wherever it is read.
 *
 * `GET /phases/records` reads a phase without naming a task: it is the batch
 * the workspace, the journal and the dossier are drawn from, while
 * `GET /submissions/:id` reports `attemptNumber`, which counts tries at the
 * task the row names. On a split phase those two are read on one screen, so
 * "Revision 3" in the panel and "#3" in the dossier have to be the same try at
 * the same piece of work. Nothing pinned that before this.
 */
describe('FeedbackService.listFor on a phase holding more than one task', () => {
  let dataSource: DataSource;
  let service: FeedbackService;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const repo = dataSource.getRepository(SubmissionEntity);
    // Interleaved on purpose: a phase-wide ordinal and a per-task one then
    // disagree about every revision but the first.
    const keys = ['story', 'scope', 'story', 'scope', 'story'];
    for (let i = 0; i < keys.length; i += 1) {
      await repo.save(
        repo.create({
          phaseStateId: 'ps-2',
          userId: 'u-1',
          taskKey: keys[i],
          status: 'completed',
          score: 50,
          passed: false,
          createdAt: new Date(EPOCH + i * 1000),
        }),
      );
    }
    service = new FeedbackService(
      repo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { register: jest.fn() } as any,
      {} as any,
      { onVerdict: jest.fn(async () => undefined) } as any,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('numbers every revision the way the single-submission route numbers it', async () => {
    const list = await service.listFor('ps-2', 'u-1');
    expect(list.map((s) => s.taskKey)).toEqual(['story', 'scope', 'story', 'scope', 'story']);
    expect(list.map((s) => s.attempt)).toEqual([1, 1, 2, 2, 3]);
    for (const row of list) {
      const one = await service.getSubmission(row.id, 'u-1');
      expect(one.attempt).toBe(row.attempt);
    }
  });

  it('answers a narrowed read exactly as it did', async () => {
    const list = await service.listFor('ps-2', 'u-1', 'scope');
    expect(list.map((s) => s.attempt)).toEqual([1, 2]);
    expect(list.every((s) => s.taskKey === 'scope')).toBe(true);
  });
});

/**
 * Which task a request and a revision are about.
 *
 * The property here is one a grep over the source cannot state: **a
 * phase-level question resolves the phase's only task, never
 * `SOLE_TASK_KEY`.** A grep cannot say that, `tasks.length === 1` is the right
 * expression in the resolvers and the wrong one in `soleTaskList`, and both
 * spellings live in this tree for good reasons. So it is asserted instead, on
 * the exact shape that breaks: a one-task phase keyed `main`, which is every
 * phase of every teacher-authored project.
 *
 * Each test names the rejected alternative beside the answer, so a body that
 * ever defaults the key back to `SOLE_TASK_KEY` fails here rather than 404ing
 * a learner off the answer door.
 */
describe('FeedbackService task resolution', () => {
  /** A compiled task of the shape the compiler mints, re-keyed. */
  function keyed(taskKey: string, order: number): CompiledTask {
    return { ...soleTask(implementationPhase), taskKey, order };
  }

  const authored = [keyed(INHERITED_TASK_KEY, 1)];
  const split = [keyed('story', 1), keyed('criteria', 2), keyed('scope', 3)];

  it('the kept route resolves a teacher-authored one-task phase, which SOLE_TASK_KEY would not', () => {
    // The rejected alternative, first: this is why the default cannot be the
    // compiled key. `soleTaskList` is false here, so a body written around it
    // takes its `find` arm, and `''` names nothing on this phase.
    expect(soleTaskList(authored)).toBe(false);
    expect(authored.find((task) => task.taskKey === SOLE_TASK_KEY)).toBeUndefined();

    expect(taskForRequest(authored, undefined)).toBe(authored[0]);
    expect(taskForRequest(authored, undefined).taskKey).toBe(INHERITED_TASK_KEY);
  });

  it('the kept route still resolves a compiled sole task', () => {
    const sole = [soleTask(implementationPhase)];
    expect(soleTaskList(sole)).toBe(true);
    expect(taskForRequest(sole, undefined)).toBe(sole[0]);
    expect(taskForRequest(sole, SOLE_TASK_KEY)).toBe(sole[0]);
  });

  it('a phase-level request against a split phase refuses by name rather than picking one', () => {
    expect(() => taskForRequest(split, undefined)).toThrow(BadRequestException);
    try {
      taskForRequest(split, undefined);
      throw new Error('a phase-level request against three tasks must not resolve one');
    } catch (error) {
      expect((error as BadRequestException).message).toBe(
        'This phase has 3 tasks. Submit one of them: story, criteria, scope.',
      );
    }
  });

  it('the per-task route resolves its key and 404s a key the version does not declare', () => {
    expect(taskForRequest(split, 'scope')).toBe(split[2]);
    expect(() => taskForRequest(split, 'nope')).toThrow(NotFoundException);
    try {
      taskForRequest(split, 'nope');
      throw new Error('an undeclared key must not fall back to another task');
    } catch (error) {
      expect((error as NotFoundException).message).toBe('unknown task: nope');
    }
  });

  it("a revision on a one-task phase is that task's, whatever key the row carries", () => {
    // The `taskKey` column default is `''` until the per-task submit path names a key,
    // so a stored row on a `main`-keyed phase carries neither key the reader
    // could match on. The phase's only task is the answer for both.
    expect(taskForRevision(authored, SOLE_TASK_KEY)).toBe(authored[0]);
    expect(taskForRevision(authored, INHERITED_TASK_KEY)).toBe(authored[0]);
  });

  it('a revision on a split phase is graded as the task its row names, or as none', () => {
    expect(taskForRevision(split, 'criteria')).toBe(split[1]);
    expect(taskForRevision(split, SOLE_TASK_KEY)).toBeUndefined();
    expect(taskForRevision(split, 'nope')).toBeUndefined();
  });
});

describe('FeedbackService.buildReport', () => {
  it('preserves automated results but cannot pass without full AI evidence when a supplemental section fails', async () => {
    // A pack whose fault is in the CLI rather than the Dockerfile, so the
    // drill's run against the faulted copy really reaches the sandbox, which
    // is the run that falls over here.
    const crashingDrillPhase = {
      ...deploymentPhase,
      checks: {
        ...deploymentPhase.checks,
        drill: {
          ...deploymentPhase.checks.drill,
          fault: 'cli-raises-on-start',
          faultedFiles: { 'cli.py': 'raise SystemExit("no data volume")\n' },
        },
      },
    } as any;
    const smokeOk = {
      ok: true,
      exitKind: 'ok' as const,
      stdout: 'Tasks',
      stderr: '',
      durationMs: 42,
    };
    let call = 0;
    const sandbox = {
      execute: jest.fn(async () => {
        call += 1;
        // The graded smoke run answers; the drill's second run falls over.
        if (call === 1) return smokeOk;
        throw new Error('runner unavailable');
      }),
    };
    const state = {
      id: 'ps-1',
      userId: 'u-1',
      enrollmentId: 'e-1',
      attempts: 1,
      ranBeforeSubmit: true,
      workspace: { Dockerfile: DOCKERFILE, '.github/workflows/ci.yml': CI_YAML },
    };
    const { service } = build({ sandbox, state });

    const report = await service['buildReport'](crashingDrillPhase, state as any, [soleTask(crashingDrillPhase)], soleTask(crashingDrillPhase));

    expect(call).toBe(2);
    expect(report.overall).toBe(100);
    expect(report.passed).toBe(false);
    expect(report.assessmentMode).toBe('strict_binary');
    expect(report.passThreshold).toBeUndefined();
    expect(report.drill).toBeUndefined();
  });
});

/* ---------------- against the real schema and its indexes ---------------- */

/**
 * The service over a real sqlite schema, which is where the two things the
 * doubles cannot model live: `UQ_submissions_in_flight`, the partial unique
 * index that settles the race between two submits, and a counter the database
 * increments rather than the request's own copy of the number.
 */
async function realStack(stubs: { sandbox?: unknown; jobs?: Record<string, unknown> } = {}) {
  const dataSource = await memoryDataSource();
  const submissions = dataSource.getRepository(SubmissionEntity);
  const phaseStates = dataSource.getRepository(PhaseStateEntity);
  const state = await phaseStates.save(
    phaseStates.create({
      enrollmentId: 'e-1',
      userId: 'u-1',
      phaseKey: 'implementation',
      phaseOrder: 3,
      status: 'in_progress',
      attempts: 0,
      workspace: null,
      ranBeforeSubmit: true,
    }),
  );
  const content = contentStub(codePhase);
  const enrollments = {
    findOneByOrFail: jest.fn(async () => ({ id: 'e-1', projectSlug: 'tasktrackr' })),
    // `packVersionFor` reads the enrolment by id and tolerates its absence,
    // which is what the two pack-version tests below drive.
    findOne: jest.fn(async ({ where }: any) =>
      where?.id === 'e-1' ? { id: 'e-1', projectSlug: 'tasktrackr' } : null,
    ),
  };
  const messages = { count: jest.fn(async () => 0), find: jest.fn(async () => []) };
  const assistant = { reviewSubmission: jest.fn(async () => ({ summary: 'reviewed' })) };
  const events = { emitJob: jest.fn() };
  const jobs = {
    enqueue: jest.fn(async () => undefined),
    register: jest.fn(),
    durable: false,
    ...(stubs.jobs ?? {}),
  };
  const service = new FeedbackService(
    submissions,
    phaseStates,
    enrollments as any,
    messages as any,
    content as any,
    (stubs.sandbox ?? {}) as any,
    {} as any,
    assistant as any,
    jobs as any,
    events as any,
    // The bell. A stub that resolves, because the pipeline awaits
    // it inside its own try: an undefined provider would be a thrown
    // TypeError on the success branch rather than a missing notification.
    { onVerdict: jest.fn(async () => undefined) } as any,
  );
  const reload = async () => phaseStates.findOneByOrFail({ id: state.id });
  return { dataSource, service, submissions, phaseStates, state, jobs, reload, content };
}

/** The timestamp sqlite would have stamped that many minutes ago. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

describe('FeedbackService.submit against the real schema', () => {
  it('lets the database settle two submits that arrive together', async () => {
    const { dataSource, service, submissions, phaseStates, state, jobs, reload } = await realStack();
    // Two requests, each holding its own copy of the phase state read at the
    // start of the request, which is exactly where `attempts + 1` computed in
    // JavaScript loses a count.
    const [one, two] = await Promise.all([
      phaseStates.findOneByOrFail({ id: state.id }),
      phaseStates.findOneByOrFail({ id: state.id }),
    ]);

    const [first, second] = await Promise.all([
      service.submit(codePhase, one),
      service.submit(codePhase, two),
    ]);

    // One row, one job, one attempt, and both callers are told about the same
    // submission rather than one of them getting a 500 from the index.
    expect(second.id).toBe(first.id);
    expect(await submissions.count({ where: { phaseStateId: state.id } })).toBe(1);
    expect((await reload()).attempts).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    await dataSource.destroy();
  });

  it('takes the in-flight slot back from a submission that wedged', async () => {
    const { dataSource, service, submissions, state, jobs } = await realStack();
    const wedged = await submissions.save(
      submissions.create({ phaseStateId: state.id, userId: 'u-1', status: 'running' }),
    );
    await submissions.query('UPDATE submissions SET createdAt = ? WHERE id = ?', [
      minutesAgo(11),
      wedged.id,
    ]);

    const view = await service.submit(codePhase, state);

    // The insert only gets past `UQ_submissions_in_flight` because the wedged
    // row was written off first, which an age bound on the read alone would
    // have missed.
    expect(view.id).not.toBe(wedged.id);
    expect(view.status).toBe('queued');
    expect((await submissions.findOneByOrFail({ id: wedged.id })).status).toBe('failed');
    expect(
      await submissions.count({ where: { phaseStateId: state.id, status: In(['queued', 'running']) } }),
    ).toBe(1);
    // The owner is what the fair scheduler takes turns by, so the
    // payload names it. A submission that reached the queue unowned would
    // share one turn with every other unowned job.
    expect(jobs.enqueue).toHaveBeenCalledWith('submission', {
      id: view.id,
      ownerId: 'u-1',
    });
    await dataSource.destroy();
  });
});

describe('FeedbackService.submit and the pack that graded it', () => {
  it('records the version of the pack the attempt was graded against', async () => {
    const { dataSource, service, submissions, state } = await realStack();

    const view = await service.submit(codePhase, state);

    // The pack version: the enrolment is stamped at enrolment, the submission
    // at submit, so a score can be read against the content that produced it.
    const row = await submissions.findOneByOrFail({ id: view.id });
    expect(row.packVersion).toBe('1.4.0');
    await dataSource.destroy();
  });

  it('still queues the work when the enrolment it was cut from is gone', async () => {
    const { dataSource, service, submissions, state, jobs, phaseStates } = await realStack();
    // A learner whose enrolment has been deleted under them. A version is a
    // note in the margin; it must never be the reason a submission is refused.
    const orphan = await phaseStates.save(
      phaseStates.create({
        enrollmentId: 'gone',
        userId: 'u-1',
        phaseKey: 'implementation',
        phaseOrder: 3,
        status: 'in_progress',
        attempts: 0,
        workspace: null,
        ranBeforeSubmit: true,
      }),
    );

    const view = await service.submit(codePhase, orphan);

    expect(view.status).toBe('queued');
    expect((await submissions.findOneByOrFail({ id: view.id })).packVersion).toBeNull();
    // The owner is what the fair scheduler takes turns by, so the
    // payload names it. A submission that reached the queue unowned would
    // share one turn with every other unowned job.
    expect(jobs.enqueue).toHaveBeenCalledWith('submission', {
      id: view.id,
      ownerId: 'u-1',
    });
    expect(state.id).not.toBe(orphan.id);
    await dataSource.destroy();
  });
});

describe('FeedbackService.processSubmission when the runner is unreachable', () => {
  it('records the outage as retryable and gives the attempt back', async () => {
    // execute() resolves on an outage, so the pipeline's catch never fires;
    // without this path the outage would be scored as a failed rubric:
    // bestScore and all.
    const unavailable: RunResult = {
      ok: false,
      exitKind: 'unavailable',
      stdout: '',
      stderr: '',
      durationMs: 12,
    };
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => unavailable),
    };
    const { dataSource, service, submissions, state, reload } = await realStack({ sandbox });

    const queued = await service.submit(codePhase, state);
    expect((await reload()).attempts).toBe(1);

    await service.processSubmission({ id: queued.id });

    const row = await submissions.findOneByOrFail({ id: queued.id });
    expect(row.status).toBe('failed');
    expect(row.error).toBe(RUNNER_UNAVAILABLE_MESSAGE);
    expect(row.score).toBeNull();
    expect(row.passed).toBeNull();
    expect(row.report).toBeNull();

    // Nothing about the phase moved, and the attempt was handed back: it feeds
    // the reliance index, and an outage is not a try at the rubric.
    const after = await reload();
    expect(after.attempts).toBe(0);
    expect(after.bestScore).toBeNull();
    expect(after.status).toBe('in_progress');
    expect(after.passedAt).toBeNull();
    await dataSource.destroy();
  });
});

describe('FeedbackService.processSubmission while the durable queue retries', () => {
  it.each(['queued', 'running'] as const)('retains an old durable %s job and its original snapshot when the learner resubmits', async status => {
    const { dataSource, service, state, reload, submissions, jobs } = await realStack({ jobs: { durable: true } });
    try {
      const queued = await service.submit(codePhase, state);
      const lease = new Date(Date.now() + 30_000).toISOString();
      await submissions.update(queued.id, { status, createdAt: new Date(Date.now() - 20 * 60_000), processingToken: 'recoverable-worker', processingLeaseUntil: lease });
      const before = await submissions.findOneByOrFail({ id: queued.id });
      const retry = await service.submit(codePhase, { ...await reload(), workspace: { 'tasktrackr/manager.py': '# newer unrelated draft' } }, 'Do not replace the original interrupted attempt');
      expect(retry.id).toBe(queued.id);
      const after = await submissions.findOneByOrFail({ id: queued.id });
      expect(after.status).toBe(status);
      expect(after.processingToken).toBe('recoverable-worker');
      expect(after.processingLeaseUntil).toBe(lease);
      expect(after.workspaceSnapshot).toEqual(before.workspaceSnapshot);
      expect(after.error).toBeNull();
      expect((await reload()).attempts).toBe(1);
      expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    } finally { await dataSource.destroy(); }
  });

  it('never shows failed for a job that still has attempts left', async () => {
    let runs = 0;
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => {
        runs += 1;
        if (runs <= 2) throw new Error('the sandbox host went away');
        return testsRun(PASSING);
      }),
    };
    const { dataSource, service, state, reload } = await realStack({
      sandbox,
      jobs: { durable: true },
    });
    const queued = await service.submit(codePhase, state);

    const seen: string[] = [];
    for (let delivery = 1; delivery <= 3; delivery += 1) {
      // The queue counts the attempt and redelivers; the third one answers.
      await service.processSubmission({ id: queued.id }).catch(() => undefined);
      const view = await service.getSubmission(queued.id, 'u-1');
      seen.push(view.status);
      if (view.status !== 'completed') {
        // A resubmit while the queue is still retrying gets the row that is
        // already in flight, not a second grading of the same phase.
        const resubmit = await service.submit(codePhase, await reload());
        expect(resubmit.id).toBe(queued.id);
      }
    }

    // The workspace treats failed as final, so it is never written while
    // something is still going to run this job.
    expect(seen).toEqual(['running', 'running', 'completed']);
    expect((await reload()).attempts).toBe(1);
    await dataSource.destroy();
  });
});

describe('FeedbackService with two submissions stored in the same second', () => {
  let dataSource: DataSource;
  let submissions: Repository<SubmissionEntity>;
  let service: FeedbackService;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    submissions = dataSource.getRepository(SubmissionEntity);
    service = new FeedbackService(
      submissions,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { register: jest.fn() } as any,
      {} as any,
      { onVerdict: jest.fn(async () => undefined) } as any,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /**
   * Two graded submissions sharing one timestamp, the way `datetime('now')`
   * writes them: sqlite stores the column to the second, and a learner who
   * submits twice inside one second is not a hypothetical, the auditor's six
   * rows came back with one distinct `createdAt` between them.
   */
  async function tiedPair(phaseStateId: string, order: string[]): Promise<void> {
    for (const id of order) {
      await submissions.save(
        submissions.create({ id, phaseStateId, userId: 'u-1', status: 'completed', score: 70 }),
      );
    }
    await submissions.query('UPDATE submissions SET createdAt = ? WHERE phaseStateId = ?', [
      '2026-09-01 00:00:00',
      phaseStateId,
    ]);
  }

  const runs: [string, number][] = [
    ['the lower id was written first', 1],
    ['the lower id was written second', 2],
  ];

  for (const [name, run] of runs) {
    it(`reads the last revision as the newest when ${name}`, async () => {
      const low = `1111111${run}-1111-4111-8111-111111111111`;
      const high = `2222222${run}-2222-4222-8222-222222222222`;
      const phaseStateId = `ps-tie-${run}`;
      await tiedPair(phaseStateId, run === 1 ? [low, high] : [high, low]);

      const list = await service.listFor(phaseStateId, 'u-1');
      expect(list.map((s) => s.id)).toEqual([low, high]);
      expect(list.map((s) => s.attempt)).toEqual([1, 2]);

      // What the dashboard calls "your last submission" has to be the row the
      // revision list puts last, whichever order they went in.
      const latest = await service.latestFor(phaseStateId);
      expect(latest?.id).toBe(list[list.length - 1].id);
      expect((await service.getSubmission(low, 'u-1')).attempt).toBe(1);
      expect((await service.getSubmission(high, 'u-1')).attempt).toBe(2);
    });
  }

  /*
   * Agreeing with each other is not enough: on a tie the readers above agree
   * on an order that a random uuid chose, so "your last submission" is a coin
   * flip between a fail and the pass that followed it, a Requirements phase
   * whose gate banner says "Gate passed" beside a verdict panel reading
   * "Scored 0 of 70", from two rows stamped in the same second. The id is
   * time-ordered, so the tie the clock cannot break the id can.
   */
  it('mints submission ids that sort in the order they were minted', () => {
    // A thousand pairs a millisecond apart: with a random v4 id this fails on
    // the first pair that sorts backwards, which is half of them.
    const minted = Array.from({ length: 1000 }, (_, i) => submissionId(1_780_000_000_000 + i));
    expect([...minted].sort()).toEqual(minted);
    // And it is a uuid, because the column is one on the production stack.
    expect(minted[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('reads the newer of two submissions the clock could not separate', async () => {
    const phaseStateId = 'ps-tie-time';
    // Minted in order, five milliseconds apart, inside one sqlite second.
    const first = submissionId(1_780_000_000_000);
    const second = submissionId(1_780_000_000_005);
    await tiedPair(phaseStateId, [first, second]);

    const list = await service.listFor(phaseStateId, 'u-1');
    expect(list.map((s) => s.id)).toEqual([first, second]);
    const latest = await service.latestFor(phaseStateId);
    expect(latest?.id).toBe(second);
  });

  it('stamps the time it was made into the id of a real submission', () => {
    const before = Date.now();
    const id = submissionId();
    const stamped = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

/* ------------------- the commit message and the clock ------------------- */

/**
 * A stack whose phase is a testing phase, so the clock reaches a grading run.
 *
 * `realStack` grades the code phase, which runs no mutants; the clock is only
 * ever set on a testing phase, and the property under test is that every run
 * inside one report saw one instant.
 */
const clockPhase = {
  ...testingPhase,
  files: [
    { path: 'tests/test_acceptance.py', content: '# starter', editable: true, language: 'python' },
    { path: 'tests/clock.py', content: '# the clock helper', editable: false, language: 'python' },
  ],
} as any;

async function clockStack() {
  const dataSource = await memoryDataSource();
  const submissions = dataSource.getRepository(SubmissionEntity);
  const phaseStates = dataSource.getRepository(PhaseStateEntity);
  const state = await phaseStates.save(
    phaseStates.create({
      enrollmentId: 'e-1',
      userId: 'u-1',
      phaseKey: 'testing',
      phaseOrder: 4,
      status: 'in_progress',
      attempts: 0,
      workspace: null,
      ranBeforeSubmit: true,
      runClock: '2026-03-01',
    }),
  );
  const jobs: any[] = [];
  const sandbox = {
    execute: jest.fn(async (job: any) => {
      jobs.push(job);
      return testsRun(PASSING);
    }),
  };
  const content = contentStub(clockPhase);
  const enrollments = {
    findOneByOrFail: jest.fn(async () => ({ id: 'e-1', projectSlug: 'tasktrackr' })),
    findOne: jest.fn(async () => ({ id: 'e-1', projectSlug: 'tasktrackr' })),
  };
  const service = new FeedbackService(
    submissions,
    phaseStates,
    enrollments as any,
    { count: jest.fn(async () => 0), find: jest.fn(async () => []) } as any,
    content as any,
    sandbox as any,
    learnerSuite as any,
    { reviewSubmission: jest.fn(async () => ({ summary: 'reviewed' })) } as any,
    { enqueue: jest.fn(async () => undefined), register: jest.fn(), durable: false } as any,
    { emitJob: jest.fn() } as any,
    // The bell. A stub that resolves, because the pipeline awaits
    // it inside its own try: an undefined provider would be a thrown
    // TypeError on the success branch rather than a missing notification.
    { onVerdict: jest.fn(async () => undefined) } as any,
  );
  return { dataSource, service, submissions, phaseStates, state, jobs };
}

describe('FeedbackService.submit and the words the learner put on it', () => {
  it('stores the message trimmed, and hands it straight back on the view', async () => {
    const { dataSource, service, submissions, state } = await realStack();

    const view = await service.submit(codePhase, state, '  Fix the overdue boundary  ');

    expect(view.commitMessage).toBe('Fix the overdue boundary');
    expect((await submissions.findOneByOrFail({ id: view.id })).commitMessage).toBe(
      'Fix the overdue boundary',
    );
    await dataSource.destroy();
  });

  it('records a revision with no message when the field was empty', async () => {
    const { dataSource, service, submissions, state } = await realStack();

    // The three ways a learner sends nothing: no argument at all (every script
    // and e2e spec in the repository), an empty field, and a field of spaces.
    // All three are one fact (no message) so all three are one null column.
    for (const message of [undefined, '', '   ']) {
      await submissions.delete({ phaseStateId: state.id });
      const view = await service.submit(codePhase, state, message);
      expect(view.commitMessage).toBeNull();
      expect((await submissions.findOneByOrFail({ id: view.id })).commitMessage).toBeNull();
    }
    await dataSource.destroy();
  });

  it('carries the message into the revision list and the single read', async () => {
    const { dataSource, service, submissions, state } = await realStack();
    const view = await service.submit(codePhase, state, 'Add the completed-task case');

    const [listed] = await service.listFor(state.id, 'u-1');
    const single = await service.getSubmission(view.id, 'u-1');

    expect(listed.commitMessage).toBe('Add the completed-task case');
    expect(single.commitMessage).toBe('Add the completed-task case');
    // The list still refuses to carry a workspace, which is what LIST_COLUMNS
    // exists for: the message joined that list, the snapshots did not.
    expect(listed.workspaceSnapshot).toBeUndefined();
    expect(submissions).toBeDefined();
    await dataSource.destroy();
  });

  it('keeps the winner’s message when a double-click submits twice', async () => {
    const { dataSource, service, submissions, phaseStates, state, reload } = await realStack();
    const [one, two] = await Promise.all([
      phaseStates.findOneByOrFail({ id: state.id }),
      phaseStates.findOneByOrFail({ id: state.id }),
    ]);

    const [first, second] = await Promise.all([
      service.submit(codePhase, one, 'the first press'),
      service.submit(codePhase, two, 'the second press'),
    ]);

    // The second press is the same submission, not a revision of its
    // description: one row, one attempt, one message, and both callers are
    // told about the row that won.
    expect(second.id).toBe(first.id);
    expect(await submissions.count({ where: { phaseStateId: state.id } })).toBe(1);
    expect((await reload()).attempts).toBe(1);
    const stored = await submissions.findOneByOrFail({ id: first.id });
    expect([first.commitMessage, second.commitMessage]).toEqual([
      stored.commitMessage,
      stored.commitMessage,
    ]);
    expect(['the first press', 'the second press']).toContain(stored.commitMessage);
    await dataSource.destroy();
  });
});

describe('FeedbackService and the clock a revision was graded at', () => {
  it('copies the phase state’s clock onto the submission at submit', async () => {
    const { dataSource, service, submissions, state } = await clockStack();

    const view = await service.submit(clockPhase, state);

    expect(view.runClock).toBe('2026-03-01');
    expect((await submissions.findOneByOrFail({ id: view.id })).runClock).toBe('2026-03-01');
    await dataSource.destroy();
  });

  it('grades at the clock the revision was submitted with, not today’s', async () => {
    const { dataSource, service, submissions, phaseStates, state, jobs } = await clockStack();
    const view = await service.submit(clockPhase, state);

    // The learner moves the control while the submission sits in the queue.
    // A regrade six weeks later has to answer the question this revision
    // asked, so the stored clock is what the runs see.
    await phaseStates.update(state.id, { runClock: '2027-12-25' });
    await service.processSubmission({ id: view.id });

    expect(jobs).toHaveLength(1 + clockPhase.checks.mutants.length);
    expect(new Set(jobs.map((job) => job.clock))).toEqual(new Set(['2026-03-01']));
    const graded = await submissions.findOneByOrFail({ id: view.id });
    expect(graded.status).toBe('completed');
    expect(graded.report?.runClock).toBe('2026-03-01');
    await dataSource.destroy();
  });

  it('sends no clock at all when the learner is on the machine’s clock', async () => {
    const { dataSource, service, submissions, phaseStates, state, jobs } = await clockStack();
    await phaseStates.update(state.id, { runClock: null });
    const fresh = await phaseStates.findOneByOrFail({ id: state.id });

    const view = await service.submit(clockPhase, fresh);
    await service.processSubmission({ id: view.id });

    // Absent, not the empty string: the runner reads a missing key as the
    // machine's date, and a blank one would be a malformed clock it drops.
    for (const job of jobs) expect('clock' in job).toBe(false);
    const graded = await submissions.findOneByOrFail({ id: view.id });
    expect(graded.runClock).toBeNull();
    expect(graded.report?.runClock).toBeNull();
    await dataSource.destroy();
  });
});

/* ========================== two runs, one report ========================== */
/*
 * Two runs, one report. A phase that spans a Python API and a TypeScript front
 * end declares two `checks.runs`; the graders execute them one at a time, pool
 * the cases and score the pooled rate. Every
 * test below is written against the two-run shape or against the single-run
 * shape it must not disturb.
 */

/** One run with the loader's own defaults filled in, so a fixture says only what it means. */
function phaseRun(fields: Partial<PhaseRun> & { id: string; label: string }): PhaseRun {
  return {
    language: 'python',
    harness: 'unittest',
    hiddenHarness: 'unittest',
    transform: false,
    testPaths: [],
    visibleTests: [],
    hiddenTestFiles: {},
    learnerTestFiles: [],
    referenceTestFiles: {},
    implFiles: {},
    supportFiles: {},
    ...fields,
  };
}

const cases = (n: number, prefix: string, status: TestCaseResult['status'] = 'passed') =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix}_${i + 1}`, status }) as TestCaseResult);

const runApi = phaseRun({
  id: 'api',
  label: 'API tests',
  language: 'python',
  harness: 'pytest',
  hiddenHarness: 'unittest',
  visibleTests: ['tests/test_tasks_api.py'],
  hiddenTestFiles: { 'tests/test_hidden_api.py': '# hidden api' },
  testPaths: ['tests/test_hidden_api.py'],
});

const runWeb = phaseRun({
  id: 'web',
  label: 'Front end',
  language: 'typescript',
  harness: 'js',
  hiddenHarness: 'js',
  transform: true,
  visibleTests: ['web/src/lib/overdue.test.ts'],
  hiddenTestFiles: { 'web/src/hidden.test.tsx': '// hidden web' },
  testPaths: ['web/src/hidden.test.tsx'],
});

const fullStackPhase = {
  key: 'implementation',
  language: 'python',
  files: [
    { path: 'api/repository/tasks.py', content: '# scaffold', editable: true, language: 'python' },
    { path: 'web/src/lib/overdue.ts', content: '// scaffold', editable: true, language: 'typescript' },
    { path: 'tests/test_tasks_api.py', content: '# given', editable: false, language: 'python' },
    { path: 'web/src/lib/overdue.test.ts', content: '// given', editable: false, language: 'typescript' },
  ],
  rubric: codePhase.rubric,
  checks: {
    kind: 'code',
    editableTargets: ['api/repository/tasks.py', 'web/src/lib/overdue.ts'],
    visibleTests: [...runApi.visibleTests, ...runWeb.visibleTests],
    hiddenTestFiles: { ...runApi.hiddenTestFiles, ...runWeb.hiddenTestFiles },
    solutionSources: [],
    runs: [runApi, runWeb],
  },
} as any;

/** Which of the four jobs a two-run code phase sends this is. */
const jobKind = (job: any) =>
  `${job.runId}:${job.files['tests/test_hidden_api.py'] || job.files['web/src/hidden.test.tsx'] ? 'hidden' : 'visible'}`;

function codeSandbox(answer: (job: any) => RunResult) {
  const jobs: any[] = [];
  return {
    jobs,
    analyze: jest.fn(async () => analysis),
    execute: jest.fn(async (job: any) => {
      jobs.push(job);
      return answer(job);
    }),
  };
}

const codeState = { id: 'ps-1', workspace: null, ranBeforeSubmit: true } as any;

describe('FeedbackService and a phase that spans two layers', () => {
  it('pools the hidden score over both runs, so a finished API and an empty front end is not 100', async () => {
    const sandbox = codeSandbox((job) =>
      jobKind(job) === 'api:hidden'
        ? testsRun(cases(14, 'api'))
        : jobKind(job) === 'web:hidden'
          ? testsRun(cases(8, 'web', 'failed'))
          : testsRun(cases(2, `${job.runId}_visible`)),
    );
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](fullStackPhase, fullStackPhase.checks, codeState, 0);

    // 14 of 22 cases, pooled by case and not averaged by run: a learner who
    // finished the API and skipped the front end scores 64, never 100.
    expect(report.criteria.find((c) => c.key === 'correctness_hidden')?.score).toBe(64);
    expect(report.tests).toMatchObject({ total: 26, passed: 18, failed: 8 });
  });

  it('sends each run its own harness, transform and step, one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async (job: any) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return testsRun(cases(1, job.runId));
      }),
    };
    const { service } = build({ sandbox });

    await service['buildCodeReport'](fullStackPhase, fullStackPhase.checks, codeState, 0);

    // Sequential: one learner's Submit holds one runner slot at a time.
    expect(peak).toBe(1);
    const sent = sandbox.execute.mock.calls.map(([job]: any[]) => job);
    expect(sent.map(jobKind)).toEqual(['api:visible', 'web:visible', 'api:hidden', 'web:hidden']);
    // The learner reads and writes pytest; the sealed suite stays on the
    // harness whose seal has been proved.
    expect(sent.map((j: any) => j.harness)).toEqual(['pytest', 'js', 'unittest', 'js']);
    expect(sent.map((j: any) => j.language)).toEqual(['python', 'typescript', 'python', 'typescript']);
    expect(sent.map((j: any) => j.testPaths)).toEqual([
      ['tests/test_tasks_api.py'],
      ['web/src/lib/overdue.test.ts'],
      ['tests/test_hidden_api.py'],
      ['web/src/hidden.test.tsx'],
    ]);
    // esbuild only on the TypeScript runs, and the step on every job so the
    // merged case list can be grouped by layer.
    expect(sent.map((j: any) => j.transform)).toEqual([
      undefined,
      { tool: 'esbuild', jsx: 'automatic' },
      undefined,
      { tool: 'esbuild', jsx: 'automatic' },
    ]);
    expect(sent.map((j: any) => j.runId)).toEqual(['api', 'web', 'api', 'web']);
  });

  it('gives each layer its own line beside the pooled one', async () => {
    const sandbox = codeSandbox((job) =>
      jobKind(job) === 'web:hidden'
        ? testsRun([...cases(3, 'web'), ...cases(5, 'web_bad', 'failed')])
        : testsRun(cases(4, job.runId)),
    );
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](fullStackPhase, fullStackPhase.checks, codeState, 0);

    const line = (id: string) => report.checks.find((c) => c.id === id);
    // The pooled row keeps its id: analytics/class-map.ts probes 'hidden-tests'.
    expect(line('hidden-tests')).toMatchObject({ status: 'failed', detail: '7/12 passed.' });
    expect(line('hidden-tests-api')).toMatchObject({
      label: 'Hidden test suite, API tests',
      status: 'passed',
      detail: '4/4 passed.',
    });
    expect(line('hidden-tests-web')).toMatchObject({
      label: 'Hidden test suite, Front end',
      status: 'failed',
      detail: '3/8 passed.',
    });
  });

  it('scores nothing at all when either run could not reach the runner', async () => {
    const unavailable: RunResult = { ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 1 };
    const sandbox = codeSandbox((job) => (job.runId === 'web' ? unavailable : testsRun(cases(14, 'api'))));
    const { service } = build({ sandbox });

    // A transport failure is an outage, not a verdict: fourteen green API
    // cases must not become a rate while the other layer never ran.
    await expect(
      service['buildCodeReport'](fullStackPhase, fullStackPhase.checks, codeState, 0),
    ).rejects.toThrow(RUNNER_UNAVAILABLE_MESSAGE);
  });
});

/* ------------------- two runs on a testing phase, and the matrix ---------- */

const testsApi = phaseRun({
  id: 'api',
  label: 'API tests',
  language: 'python',
  harness: 'pytest',
  learnerTestFiles: ['tests/test_acceptance.py'],
  testPaths: ['tests/test_acceptance.py'],
  implFiles: { 'api/repository/tasks.py': '# reference api' },
  supportFiles: { 'tests/clock.py': '# clock' },
});

const testsWeb = phaseRun({
  id: 'web',
  label: 'Front end',
  language: 'typescript',
  harness: 'js',
  hiddenHarness: 'js',
  transform: true,
  learnerTestFiles: ['web/src/acceptance.test.tsx'],
  testPaths: ['web/src/acceptance.test.tsx'],
  implFiles: { 'web/src/lib/overdue.ts': '// reference web' },
  supportFiles: { 'web/src/testing/clock.ts': '// clock' },
});

const fullStackTestsPhase = {
  key: 'testing',
  language: 'python',
  rubric: testingPhase.rubric,
  checks: {
    kind: 'tests',
    learnerTestFiles: ['tests/test_acceptance.py', 'web/src/acceptance.test.tsx'],
    implFiles: { ...testsApi.implFiles, ...testsWeb.implFiles },
    supportFiles: { ...testsApi.supportFiles, ...testsWeb.supportFiles },
    // Three: two `def test_` in the API suite and one `test(` in the front
    // end's, counted in each run's own language (stage B). At stage A's
    // `countTestMethods` the `.tsx` file read as zero and this was 2.
    minTests: 3,
    coverageKeywords: [{ criterion: 'US-4/AC-2', keywords: ['overdue'] }],
    mutants: [
      {
        name: 'overdue_includes_due_today',
        description: 'the overdue query uses <= where < belongs',
        files: { 'api/repository/tasks.py': '# mutant api' },
        covers: 'US-4/AC-2',
        run: 'api',
      },
      {
        name: 'badge_never_shows',
        description: 'the overdue badge never renders',
        files: { 'web/src/lib/overdue.ts': '// mutant web' },
        covers: 'US-5/AC-1',
        run: 'web',
      },
    ],
    runs: [testsApi, testsWeb],
  },
} as any;

/**
 * The learner's two suites, plus a helper the reference directory ships that
 * no run claims: the shape `referenceTestFiles` really has.
 */
const fullStackSuite = {
  learnerTestFiles: jest.fn(() => ({
    'tests/test_acceptance.py':
      'def test_overdue_excludes_today():\n    assert True\n\ndef test_overdue_lists_late():\n    assert True\n',
    'web/src/acceptance.test.tsx': "test('overdue badge shows', () => {});\n",
    'tests/helpers.py': '# a helper no learner test path names',
  })),
};

/** Which implementation a job was graded against, whichever layer it belongs to. */
const gradedOf = (job: any) =>
  job.gradedFiles['api/repository/tasks.py'] ?? job.gradedFiles['web/src/lib/overdue.ts'];

describe('FeedbackService and a kill matrix over two layers', () => {
  it('runs each mutant against its own run: its implementation, its suite, its harness', async () => {
    const jobs: any[] = [];
    const sandbox = {
      execute: jest.fn(async (job: any) => {
        jobs.push(job);
        return gradedOf(job).startsWith('# reference') || gradedOf(job).startsWith('// reference')
          ? testsRun(cases(1, 'reference'))
          : testsRun(cases(1, 'caught', 'failed'));
      }),
    };
    const { service } = build({ sandbox, execution: fullStackSuite });

    const report = await service['buildTestsReport'](fullStackTestsPhase, fullStackTestsPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);

    // Two reference runs, then one run per mutant.
    expect(jobs).toHaveLength(4);
    const [refApi, refWeb, mutantApi, mutantWeb] = jobs;
    expect(refApi.runId).toBe('api');
    expect(refWeb.runId).toBe('web');

    // The API mutant meets the API implementation and the API suite.
    expect(mutantApi.gradedFiles).toEqual({
      'api/repository/tasks.py': '# mutant api',
    });
    expect(Object.keys(mutantApi.files).sort()).toEqual([
      'tests/clock.py',
      'tests/helpers.py',
      'tests/test_acceptance.py',
    ]);
    expect(mutantApi).toMatchObject({ language: 'python', harness: 'pytest', testPaths: ['tests/test_acceptance.py'] });
    expect(mutantApi.transform).toBeUndefined();

    // The web mutant meets the web implementation and the web suite, esbuilt.
    expect(mutantWeb.gradedFiles).toEqual({ 'web/src/lib/overdue.ts': '// mutant web' });
    expect(Object.keys(mutantWeb.files).sort()).toEqual([
      'tests/helpers.py',
      'web/src/acceptance.test.tsx',
      'web/src/testing/clock.ts',
    ]);
    expect(mutantWeb).toMatchObject({
      language: 'typescript',
      harness: 'js',
      transform: { tool: 'esbuild', jsx: 'automatic' },
      testPaths: ['web/src/acceptance.test.tsx'],
    });

    // One grid over both layers.
    expect(report.mutation?.killed).toBe(2);
    expect(report.mutation?.matrix?.map((row) => `${row.mutant}:${row.covers}`)).toEqual([
      'overdue_includes_due_today:US-4/AC-2',
      'badge_never_shows:US-5/AC-1',
    ]);
  });

  it('gives each layer its own reference line beside the pooled one', async () => {
    const sandbox = {
      execute: jest.fn(async (job: any) =>
        job.runId === 'web' && gradedOf(job) === '// reference web'
          ? testsRun([...cases(1, 'web'), ...cases(1, 'web_bad', 'failed')])
          : testsRun(cases(2, job.runId ?? 'mutant')),
      ),
    };
    const { service } = build({ sandbox, execution: fullStackSuite });

    const report = await service['buildTestsReport'](fullStackTestsPhase, fullStackTestsPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);

    const line = (id: string) => report.checks.find((c) => c.id === id);
    // The pooled row keeps its id: analytics/class-map.ts probes it.
    expect(line('tests-on-correct')).toMatchObject({ status: 'failed', detail: '3/4 passed.' });
    expect(line('tests-on-correct-api')).toMatchObject({
      label: 'Suite passes on the reference implementation, API tests',
      status: 'passed',
      detail: '2/2 passed.',
    });
    expect(line('tests-on-correct-web')).toMatchObject({
      label: 'Suite passes on the reference implementation, Front end',
      status: 'failed',
      detail: '1/2 passed.',
    });
  });

  it('counts the learner tests in each run with the language that run declares', async () => {
    // python and typescript, the two languages the pack actually declares: the
    // plumbing under test is that each run is counted with its own language
    // and the counts are pooled into the pack's one `minTests`.
    const phase = {
      ...fullStackTestsPhase,
      checks: {
        ...fullStackTestsPhase.checks,
        minTests: 4,
        runs: [testsApi, testsWeb],
      },
    } as any;
    const sandbox = { execute: jest.fn(async () => testsRun(cases(1, 'ok'))) };
    const { service } = build({
      sandbox,
      execution: {
        learnerTestFiles: jest.fn(() => ({
          'tests/test_acceptance.py': 'def test_overdue_one():\n    pass\n\ndef test_overdue_two():\n    pass\n',
          'web/src/acceptance.test.tsx': "test('overdue badge', () => {});\nit('counts late tasks', () => {});\n",
        })),
      },
    });

    const report = await service['buildTestsReport'](phase, phase.checks, { id: 'ps-1', workspace: null } as any);

    // Two `def test_` and two `test(`/`it(`: four, so the pack's minimum of
    // four is met. Counted with one language it would have been two.
    expect(report.checks.find((c) => c.id === 'enough-tests')).toMatchObject({
      status: 'passed',
      detail: '4 test method(s) found.',
    });
  });

  it('does not count a mutant the author broke as a mutant the learner killed', async () => {
    // A TypeScript mutant that does not compile comes back exitKind "error"
    // with one errored case per esbuild diagnostic. The
    // suite never ran, so nothing about it was proved.
    const compileFailure: RunResult = {
      ok: false,
      exitKind: 'error',
      stdout: '',
      stderr: 'web/src/lib/overdue.ts:3:9: ERROR: Expected ")" but found "}"',
      durationMs: 4,
      tests: {
        total: 1,
        passed: 0,
        failed: 0,
        errored: 1,
        cases: [{ name: 'web/src/lib/overdue.ts', status: 'errored', message: 'Expected ")"' }],
      },
    };
    const sandbox = {
      execute: jest.fn(async (job: any) => {
        // Keyed off each layer's own file rather than `gradedOf`, so the run
        // that meets the broken mutant is the same one whichever
        // implementation set a job carries.
        if (job.gradedFiles['web/src/lib/overdue.ts'] === '// mutant web') return compileFailure;
        if (job.gradedFiles['api/repository/tasks.py'] === '# mutant api') {
          return testsRun(cases(1, 'caught', 'failed'));
        }
        // The suite has to pass on the reference implementation before a
        // single mutant is run at all.
        return testsRun(cases(1, 'reference'));
      }),
    };
    const { service } = build({ sandbox, execution: fullStackSuite });

    const report = await service['buildTestsReport'](fullStackTestsPhase, fullStackTestsPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);

    expect(report.mutation?.killed).toBe(1);
    expect(report.mutation?.survivors.map((s) => s.name)).toEqual(['badge_never_shows']);
    expect(report.mutation?.matrix?.map((row) => row.killed)).toEqual([true, false]);
  });

  it('caps the matrix at sixty cases per mutant, with eight mutants on the grid', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      name: `mutant_${i + 1}`,
      description: `mutant ${i + 1} plants a bug`,
      files: { 'api/repository/tasks.py': `# mutant ${i + 1}` },
      covers: `US-4/AC-${i + 1}`,
      run: 'api',
    }));
    const phase = {
      ...fullStackTestsPhase,
      checks: { ...fullStackTestsPhase.checks, mutants: eight },
    } as any;
    const sandbox = {
      execute: jest.fn(async (job: any) =>
        gradedOf(job).startsWith('# mutant')
          ? testsRun([...cases(79, 'green'), ...cases(1, 'caught', 'failed')])
          : testsRun(cases(2, 'reference')),
      ),
    };
    const { service } = build({ sandbox, execution: fullStackSuite });

    const report = await service['buildTestsReport'](phase, phase.checks, { id: 'ps-1', workspace: null } as any);

    const matrix = report.mutation?.matrix ?? [];
    expect(matrix).toHaveLength(8);
    // The cap is per mutant, not over the whole grid: eight rows of sixty.
    expect(matrix.map((row) => row.cases.length)).toEqual([60, 60, 60, 60, 60, 60, 60, 60]);
    expect(report.mutation?.killed).toBe(8);
  });
});

/* --------------- the Dockerfile a two-service application smokes ---------- */

describe('FeedbackService.runSmokeCheck and the pack that ships two Dockerfiles', () => {
  /** A two-service pack: the API image is built from `api/Dockerfile`. */
  const twoServicePhase = {
    ...deploymentPhase,
    files: [
      { path: 'api/Dockerfile', content: '# scaffold', editable: true, language: 'dockerfile' },
      { path: 'docker-compose.yml', content: '# scaffold', editable: true, language: 'yaml' },
      { path: 'api/main.py', content: '# reference api', editable: false, language: 'python' },
    ],
    checks: {
      ...deploymentPhase.checks,
      smokeDockerfile: 'api/Dockerfile',
      smokeImplFiles: { 'api/main.py': '# reference api' },
      smokeCommands: [['python3', 'api/main.py', '--selfcheck']],
      expectInOutput: 'selfcheck: web reaches api, 13 routes, 5 tables',
      drill: undefined,
    },
  } as any;

  const API_DOCKERFILE =
    'FROM python:3.11-slim\nWORKDIR /app\nCOPY . .\nENTRYPOINT ["python3", "api/main.py"]\n';

  it('starts the service through the Dockerfile the checks name, not one called Dockerfile', async () => {
    const sandbox = {
      execute: jest.fn(async () => ({
        ok: true,
        exitKind: 'ok' as const,
        stdout: 'selfcheck: web reaches api, 13 routes, 5 tables',
        stderr: '',
        durationMs: 30,
      })),
    };
    const { service } = build({ sandbox });

    const smoke = await service.runSmokeCheck(twoServicePhase, {
      'api/Dockerfile': API_DOCKERFILE,
      // The web image is in the workspace too, and it must not be the one the
      // smoke run reads: its ENTRYPOINT starts the static server, not the API.
      'web/Dockerfile': 'FROM node:22-slim\nWORKDIR /app\nENTRYPOINT ["node", "web/serve.js"]\n',
    });

    expect(smoke).toMatchObject({ ok: true, argv: ['python3', 'api/main.py'] });
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ smokeCommands: [['python3', 'api/main.py', '--selfcheck']] }),
    );
  });

  it('still reads a top-level Dockerfile for a pack that names none', async () => {
    const sandbox = {
      execute: jest.fn(async () => ({ ok: true, exitKind: 'ok' as const, stdout: 'Tasks', stderr: '', durationMs: 9 })),
    };
    const { service } = build({ sandbox });

    const smoke = await service.runSmokeCheck(deploymentPhase, { Dockerfile: DOCKERFILE });
    expect(smoke).toMatchObject({ ok: true, argv: ['python', 'cli.py'] });
  });
});

/* ------------- the pack written before two runs, graded unchanged --------- */

/**
 * The single-run regression proof: a phase that declares one run, a
 * single-run pack, and every `checks` object a spec builds by hand, must
 * produce the same report, field for field, as the single-run graders. The
 * two reports below are fixed captures of that report and are compared
 * whole, so a change anywhere in the pooling, the labels, the ids or the
 * order fails here.
 */
const GOLDEN_CODE_REPORT = {
    "overall": 90,
    "criteria": [
      {
        "key": "correctness_hidden",
        "title": "Hidden tests",
        "weight": 0.4,
        "score": 75,
        "evidence": [
          "3/4 passed."
        ]
      },
      {
        "key": "visible_tests",
        "title": "Visible tests",
        "weight": 0.3,
        "score": 100,
        "evidence": [
          "2/2 passed."
        ]
      },
      {
        "key": "code_quality",
        "title": "Code quality",
        "weight": 0.2,
        "score": 100,
        "evidence": []
      },
      {
        "key": "process",
        "title": "Process",
        "weight": 0.1,
        "score": 100,
        "evidence": [
          "Ran tests before submitting.",
          "2 Guided hints this phase."
        ]
      }
    ],
    "checks": [
      {
        "id": "visible-tests",
        "label": "Visible test suite",
        "status": "passed",
        "detail": "2/2 passed."
      },
      {
        "id": "hidden-tests",
        "label": "Hidden test suite (edge cases)",
        "status": "failed",
        "detail": "3/4 passed."
      },
      {
        "id": "static-analysis",
        "label": "Static analysis",
        "status": "passed",
        "detail": "No findings."
      },
      {
        "id": "ran-before-submit",
        "label": "Ran the tests before submitting",
        "status": "passed",
        "detail": "Good practice — you used the fast feedback loop."
      }
    ],
    "staticAnalysis": {
      "issues": [],
      "metrics": {
        "files": 2,
        "functions": 4,
        "todosRemaining": 0,
        "maxComplexity": 3,
        "docstringCoverage": 1
      }
    },
    "tests": {
      "total": 6,
      "passed": 5,
      "failed": 1,
      "errored": 0,
      "cases": [
        {
          "name": "visible_1",
          "status": "passed"
        },
        {
          "name": "visible_2",
          "status": "passed"
        },
        {
          "name": "hidden_1",
          "status": "passed",
          "hidden": true
        },
        {
          "name": "hidden_2",
          "status": "passed",
          "hidden": true
        },
        {
          "name": "hidden_3",
          "status": "passed",
          "hidden": true
        },
        {
          "name": "hidden_bad_1",
          "status": "failed",
          "hidden": true
        }
      ]
    }
  };

const GOLDEN_TESTS_REPORT = {
    "overall": 85,
    "criteria": [
      {
        "key": "tests_pass",
        "title": "Suite passes",
        "weight": 0.3,
        "score": 100,
        "evidence": [
          "2/2 passed.",
          "2 test methods."
        ]
      },
      {
        "key": "mutants_killed",
        "title": "Mutants killed",
        "weight": 0.45,
        "score": 67,
        "evidence": [
          "4/6 mutants killed."
        ]
      },
      {
        "key": "coverage_mapping",
        "title": "Coverage",
        "weight": 0.25,
        "score": 100,
        "evidence": [
          "✓ US-2/AC-1"
        ]
      }
    ],
    "checks": [
      {
        "id": "tests-on-correct",
        "label": "Suite passes on the reference implementation",
        "status": "passed",
        "detail": "2/2 passed."
      },
      {
        "id": "enough-tests",
        "label": "At least 2 tests written",
        "status": "passed",
        "detail": "2 test method(s) found."
      },
      {
        "id": "mutation",
        "label": "Seeded bugs caught (mutation testing)",
        "status": "warning",
        "detail": "4/6 buggy variants caught; survived: overdue_boundary plants a bug · priority_order_reversed plants a bug"
      },
      {
        "id": "coverage-us-2/ac-1",
        "label": "Covers US-2/AC-1",
        "status": "passed",
        "detail": "Behaviour referenced in your suite."
      }
    ],
    "tests": {
      "total": 2,
      "passed": 2,
      "failed": 0,
      "errored": 0,
      "cases": [
        {
          "name": "test_complete_marks_done",
          "status": "passed"
        },
        {
          "name": "test_overdue_boundary",
          "status": "passed"
        }
      ]
    },
    "mutation": {
      "total": 6,
      "killed": 4,
      "survivors": [
        {
          "name": "overdue_boundary",
          "description": "overdue_boundary plants a bug"
        },
        {
          "name": "priority_order_reversed",
          "description": "priority_order_reversed plants a bug"
        }
      ],
      "matrix": [
        {
          "mutant": "complete_noop",
          "description": "complete_noop plants a bug",
          "killed": true,
          "cases": [
            {
              "name": "test_complete_marks_done",
              "status": "failed"
            },
            {
              "name": "test_overdue_boundary",
              "status": "passed"
            }
          ]
        },
        {
          "mutant": "complete_unknown_returns_none",
          "description": "complete_unknown_returns_none plants a bug",
          "killed": true,
          "cases": [
            {
              "name": "test_complete_marks_done",
              "status": "failed"
            },
            {
              "name": "test_overdue_boundary",
              "status": "passed"
            }
          ]
        },
        {
          "mutant": "done_returns_open",
          "description": "done_returns_open plants a bug",
          "killed": true,
          "cases": [
            {
              "name": "test_complete_marks_done",
              "status": "failed"
            },
            {
              "name": "test_overdue_boundary",
              "status": "passed"
            }
          ]
        },
        {
          "mutant": "filter_ignores_keyword",
          "description": "filter_ignores_keyword plants a bug",
          "killed": true,
          "cases": [
            {
              "name": "test_complete_marks_done",
              "status": "failed"
            },
            {
              "name": "test_overdue_boundary",
              "status": "passed"
            }
          ]
        },
        {
          "mutant": "overdue_boundary",
          "description": "overdue_boundary plants a bug",
          "killed": false,
          "cases": [
            {
              "name": "test_complete_marks_done",
              "status": "passed"
            },
            {
              "name": "test_overdue_boundary",
              "status": "passed"
            }
          ]
        },
        {
          "mutant": "priority_order_reversed",
          "description": "priority_order_reversed plants a bug",
          "killed": false,
          "cases": [
            {
              "name": "test_complete_marks_done",
              "status": "passed"
            },
            {
              "name": "test_overdue_boundary",
              "status": "passed"
            }
          ]
        }
      ]
    },
    "runClock": null
  };

// The hint count (Guided messages) feeds the process score; the sentences say it is Guided, and say what happened in
// Agentic mode from the phase's proposals, which no score reads, so the Process row never says no help was used when
// the mentor proposed the change.
describe('the process criterion\'s mentor sentences', () => {
  it('says Guided hints for 0, 1 and n, and Agentic proposals for 0, 1 and n, applied or not', () => {
    expect(mentorUseSentences(0, null)).toEqual(['No Guided hints this phase.']);
    expect(mentorUseSentences(1, null)).toEqual(['One Guided hint this phase.']);
    expect(mentorUseSentences(7, null)).toEqual(['7 Guided hints this phase.']);
    const agentic = (proposals: number, applied: number) => mentorUseSentences(0, { proposals, applied })[1];
    expect(agentic(0, 0)).toBe('No Agentic proposals this phase.');
    expect(agentic(1, 0)).toBe('One Agentic proposal this phase, not applied.');
    expect(agentic(1, 1)).toBe('One Agentic proposal this phase, applied after its explanation was accepted.');
    expect(agentic(3, 0)).toBe('3 Agentic proposals this phase, none applied.');
    expect(agentic(3, 1)).toBe('3 Agentic proposals this phase; one applied after its explanation was accepted.');
    expect(agentic(3, 2)).toBe('3 Agentic proposals this phase; 2 applied after their explanations were accepted.');
    expect(agentic(2, 2)).toBe('2 Agentic proposals this phase, all applied after their explanations were accepted.');
    expect(mentorUseSentences(2, { proposals: 1, applied: 1 })).toEqual(['2 Guided hints this phase.', 'One Agentic proposal this phase, applied after its explanation was accepted.']);
  });

  const sandbox = () => ({
    analyze: jest.fn(async () => analysis),
    execute: jest.fn(async () => testsRun(cases(2, 'visible'))),
  });
  /** A message repository whose manager answers the phase's proposals, as the one indexed read asks for them. */
  const withProposals = (messages: any, rows: Array<{ appliedAt: string | null }>) => {
    const find = jest.fn(async () => rows.map((row, at) => ({ id: `p-${at}`, ...row })));
    messages.manager = { getRepository: jest.fn(() => ({ find })) };
    return find;
  };

  it('reads the phase\'s proposals once, by owner and phase, and says them beside the Guided count', async () => {
    const { service, messages } = build({ sandbox: sandbox() });
    const find = withProposals(messages, [{ appliedAt: '2026-11-17T10:00:00.000Z' }]);
    const report = await service['buildCodeReport'](codePhase, codePhase.checks, { ...codeState, userId: 'u-1' }, 0);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ select: { id: true, appliedAt: true }, where: { userId: 'u-1', phaseStateId: 'ps-1' } });
    expect(report.criteria.find((c) => c.key === 'process')?.evidence).toEqual([
      'Ran tests before submitting.',
      'No Guided hints this phase.',
      'One Agentic proposal this phase, applied after its explanation was accepted.',
    ]);
  });

  it('scores process from the run and the Guided count alone: Agentic proposals move no score, check or verdict', async () => {
    const graded = async (hints: number, rows: Array<{ appliedAt: string | null }> | null) => {
      const { service, messages } = build({ sandbox: sandbox() });
      if (rows) withProposals(messages, rows);
      const report = await service['buildCodeReport'](codePhase, codePhase.checks, { ...codeState, userId: 'u-1' }, hints);
      return { scores: report.criteria.map((c) => [c.key, c.score]), checks: report.checks, overall: (report as any).overall };
    };
    for (const hints of [0, 1, 12]) {
      const without = await graded(hints, null);
      expect(await graded(hints, [])).toEqual(without);
      expect(await graded(hints, [{ appliedAt: null }, { appliedAt: '2026-11-17T10:00:00.000Z' }, { appliedAt: '2026-11-17T11:00:00.000Z' }])).toEqual(without);
    }
    // And the hint count still costs what it cost: twelve Guided hints score lower than none.
    const score = async (hints: number) => (await graded(hints, null)).scores.find(([key]) => key === 'process')?.[1];
    expect(await score(12)).toBeLessThan((await score(0)) as number);
  });

  it('says nothing about Agentic when the proposals cannot be read', async () => {
    const { service, messages } = build({ sandbox: sandbox() });
    (messages as any).manager = { getRepository: () => ({ find: async () => { throw new Error('no such table'); } }) };
    const report = await service['buildCodeReport'](codePhase, codePhase.checks, { ...codeState, userId: 'u-1' }, 1);
    expect(report.criteria.find((c) => c.key === 'process')?.evidence).toEqual(['Ran tests before submitting.', 'One Guided hint this phase.']);
  });
});

describe('FeedbackService and a pack written before two runs existed', () => {
  it('grades a single-run code phase field for field as it did at aec707d', async () => {
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async (job: any) =>
        job.testPaths[0] === 'tests/test_hidden.py'
          ? testsRun([...cases(3, 'hidden'), ...cases(1, 'hidden_bad', 'failed')])
          : testsRun(cases(2, 'visible')),
      ),
    };
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](codePhase, codePhase.checks, codeState, 2);

    expect(report).toEqual(GOLDEN_CODE_REPORT);
    // Nothing was stamped and nothing was merged: the sandbox's own two
    // results are what the report is built from.
    expect(sandbox.execute.mock.calls.map(([job]: any[]) => job.runId)).toEqual([undefined, undefined]);
    expect(report.checks.map((c) => c.id)).toEqual([
      'visible-tests',
      'hidden-tests',
      'static-analysis',
      'ran-before-submit',
    ]);
  });

  it('grades a single-run testing phase field for field as it did at aec707d', async () => {
    // The sealed pack's six mutants, four of them caught: a golden report with
    // kills, survivors and a matrix in it says more than one with none.
    const caught = new Set(SEALED_MUTANTS.slice(0, 4).map((m) => `# ${m.name}`));
    const sandbox = {
      execute: jest.fn(async (job: any) =>
        caught.has(job.gradedFiles['tasktrackr/manager.py'])
          ? testsRun([{ name: 'test_complete_marks_done', status: 'failed', message: 'AssertionError' }, PASSING[1]])
          : testsRun(PASSING),
      ),
    };
    const { service } = build({ sandbox, execution: learnerSuite });

    const report = await service['buildTestsReport'](sealedPhase, sealedPhase.checks, {
      id: 'ps-1',
      workspace: null,
    } as any);

    expect(report).toEqual(GOLDEN_TESTS_REPORT);
    expect(report.checks.map((c) => c.id)).toEqual([
      'tests-on-correct',
      'enough-tests',
      'mutation',
      'coverage-us-2/ac-1',
    ]);
  });
});

/* ---------------- the analyzer over a two-language target list ------------ */

describe('FeedbackService static analysis when the editable files are two languages', () => {
  /** The real analyzer, the stubbed runner: the point is which parser reads what. */
  const OVERDUE_TS =
    'export function isOverdue(task: { due_date: string | null }, today: string): boolean {\n' +
    '  return task.due_date !== null && task.due_date < today;\n' +
    '}\n';
  const TASKS_PY = 'def overdue(conn, today):\n    # TODO(learner) write the query\n    return []\n';

  const mixedPhase = {
    ...fullStackPhase,
    files: [
      { path: 'api/repository/tasks.py', content: TASKS_PY, editable: true, language: 'python' },
      { path: 'web/src/lib/overdue.ts', content: OVERDUE_TS, editable: true, language: 'typescript' },
      { path: 'tests/test_tasks_api.py', content: '# given', editable: false, language: 'python' },
      { path: 'web/src/lib/overdue.test.ts', content: '// given', editable: false, language: 'typescript' },
    ],
  } as any;

  it('reads the Python file and skips the TypeScript one, in one call', async () => {
    const analyzer = new SandboxService();
    const sandbox = {
      analyze: jest.fn((files: any, targets: any, language: any) => analyzer.analyze(files, targets, language)),
      execute: jest.fn(async () => testsRun(cases(1, 'ok'))),
    };
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](mixedPhase, mixedPhase.checks, codeState, 0);

    // One call, both targets: `analyzer.py` dispatches per target by extension
    // so nothing here has to split them.
    expect(sandbox.analyze).toHaveBeenCalledTimes(1);
    expect(sandbox.analyze.mock.calls[0][1]).toEqual([
      'api/repository/tasks.py',
      'web/src/lib/overdue.ts',
    ]);

    const issues = report.staticAnalysis?.issues ?? [];
    // The Python half was really read: the marker it still carries is found.
    expect(issues.map((i) => `${i.path}:${i.rule}`)).toEqual([
      'api/repository/tasks.py:todo-remaining',
      'api/repository/tasks.py:missing-docstring',
    ]);
    // And the TypeScript half was skipped, not handed to Python's `ast`: a
    // syntax error there would cost the learner the whole code_quality weight
    // and tell them nothing.
    expect(issues.some((i) => i.path === 'web/src/lib/overdue.ts')).toBe(false);
    // `metrics.files` counts what was analysable, so the score is divided by
    // the files that were read.
    expect(report.staticAnalysis?.metrics.files).toBe(1);
    // Two findings from the one file that was read and none from the one that
    // was not: 100 - 10 for the warning - 2 for the note.
    expect(report.criteria.find((c) => c.key === 'code_quality')?.score).toBe(88);
  }, 30000);
});

/* -------- one run, two harnesses: what the learner writes and what grades -- */

describe('FeedbackService and a phase whose sealed suite is not the learner harness', () => {
  // Phase 3: the learner reads and writes pytest, and the suite that
  // decides the score stays on unittest, whose seal has been proved.
  // One run, two harnesses, and sending one of them twice
  // silently collects nothing from the other file.
  const pytestPhase = {
    ...codePhase,
    checks: {
      ...codePhase.checks,
      runs: [
        phaseRun({
          id: 'api',
          label: 'API tests',
          language: 'python',
          harness: 'pytest',
          hiddenHarness: 'unittest',
          visibleTests: ['tests/test_visible.py'],
          hiddenTestFiles: { 'tests/test_hidden.py': '# hidden' },
          testPaths: ['tests/test_hidden.py'],
        }),
      ],
    },
  } as any;

  it('collects both suites, each under the harness it is written in', async () => {
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async (job: any) => {
        // A harness collects nothing from a file written for the other one:
        // plain `def test_x()` functions are invisible to unittest, and a
        // `TestCase` is not what pytest was pointed at here.
        const written = job.testPaths[0] === 'tests/test_hidden.py' ? 'unittest' : 'pytest';
        return job.harness === written ? testsRun(cases(4, written)) : testsRun([]);
      }),
    };
    const { service } = build({ sandbox });

    const report = await service['buildCodeReport'](pytestPhase, pytestPhase.checks, codeState, 0);

    // Either half collected under the wrong harness is `total === 0`, which
    // `scoreTests` reads as zero: a perfect answer scoring nothing, with no
    // sentence saying why.
    expect(report.criteria.find((c) => c.key === 'visible_tests')?.score).toBe(100);
    expect(report.criteria.find((c) => c.key === 'correctness_hidden')?.score).toBe(100);
    expect(sandbox.execute.mock.calls.map(([job]: any[]) => job.harness)).toEqual(['pytest', 'unittest']);
    // One run, so nothing is stamped and nothing is merged.
    expect(sandbox.execute.mock.calls.map(([job]: any[]) => job.runId)).toEqual([undefined, undefined]);
  });
});

/* ------------------- a runner that cannot run a step ------------------- */

describe('FeedbackService.processSubmission when the runner cannot run a step here', () => {
  const SENTENCE =
    'this transport cannot run JavaScript: there is no node here. The front-end half of a phase needs RUNNER_MODE=local or socket.';

  it('writes the runner’s own sentence on the row, not "try again", and still gives the attempt back', async () => {
    // The Lambda shape: `execute()` resolves with the runner's sentence in
    // stderr. That limit does not go away on the next press, so the generic
    // "Try again in a moment" was wrong for it.
    const cannotRun: RunResult = {
      ok: false,
      exitKind: 'unavailable',
      stdout: '',
      stderr: SENTENCE,
      durationMs: 0,
    };
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => cannotRun),
    };
    const { dataSource, service, submissions, state, reload } = await realStack({ sandbox });

    const queued = await service.submit(codePhase, state);
    expect((await reload()).attempts).toBe(1);

    await service.processSubmission({ id: queued.id });

    const row = await submissions.findOneByOrFail({ id: queued.id });
    expect(row.status).toBe('failed');
    expect(row.error?.startsWith(SENTENCE)).toBe(true);
    expect(row.error).toContain('Nothing was scored and this attempt was not counted.');
    expect(row.error).not.toBe(RUNNER_UNAVAILABLE_MESSAGE);
    expect(row.error).not.toContain('Try again');
    expect(row.score).toBeNull();
    expect(row.report).toBeNull();

    const after = await reload();
    expect(after.attempts).toBe(0);
    expect(after.bestScore).toBeNull();
    await dataSource.destroy();
  });

  it('keeps the generic sentence when the transport itself failed', async () => {
    const outage: RunResult = { ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 12 };
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => outage),
    };
    const { dataSource, service, submissions, state } = await realStack({ sandbox });
    const queued = await service.submit(codePhase, state);
    await service.processSubmission({ id: queued.id });
    const row = await submissions.findOneByOrFail({ id: queued.id });
    expect(row.error).toBe(RUNNER_UNAVAILABLE_MESSAGE);
    await dataSource.destroy();
  });
});

/** Real SQLite, mocked grading result: verifies submission authority across queue delay/re-delivery. */
describe('submission evidence immutability', () => {
  it('defers a duplicate durable delivery and reclaims an expired lease without allowing the old worker to overwrite it', async () => {
    const { dataSource, service, submissions, state } = await clockStack();
    (service as any).jobs.durable = true;
    const queued = await service.submit(clockPhase, state);
    let finishFirst!: (report: any) => void;
    const firstReport = { overall: 0, passed: false, checks: [], aiReview: { summary: 'older worker' } } as any;
    const newerReport = { overall: 0, passed: false, checks: [], aiReview: { summary: 'recovered worker' } } as any;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const grading = jest.spyOn(service, 'buildReport')
      .mockImplementationOnce(() => { entered(); return new Promise(resolve => { finishFirst = resolve; }); })
      .mockResolvedValue(newerReport);
    const first = service.processSubmission({ id: queued.id });
    await started;
    await expect(service.processSubmission({ id: queued.id })).rejects.toMatchObject({ name: 'JobDeferredUntil' });
    expect(grading).toHaveBeenCalledTimes(1);
    expect((await submissions.findOneByOrFail({ id: queued.id })).status).toBe('running');
    // Advance only the persisted lease clock, simulating recovery after the original process died.
    await submissions.update(queued.id, { processingLeaseUntil: new Date(Date.now() - 1).toISOString() });
    await service.processSubmission({ id: queued.id });
    expect(grading).toHaveBeenCalledTimes(2);
    finishFirst(firstReport);
    await first;
    const recovered = await submissions.findOneByOrFail({ id: queued.id });
    expect(recovered.status).toBe('completed');
    expect(recovered.report).toEqual(newerReport);
    expect(recovered.processingToken).toBeNull();
    expect(recovered.processingLeaseUntil).toBeNull();
    await dataSource.destroy();
  });

  it('grades submitted files and context instead of later autosaves and keeps the first verdict on redelivery', async () => {
    const { dataSource, service, submissions, phaseStates, state } = await clockStack();
    const queued = await service.submit(clockPhase, state);
    const snapshot = await submissions.findOneByOrFail({ id: queued.id });
    await phaseStates.update(state.id, { workspace: { 'later.py': 'unsubmitted code' }, links: [{ from: 'later.py::test', to: 'US-4/AC-2', kind: 'verifies', at: new Date().toISOString() }], ranBeforeSubmit: !state.ranBeforeSubmit });
    const fakeReport = { overall: 0, passed: false, assessmentMode: 'strict_binary', checks: [], criteria: [], aiReview: { provider: 'mock-ai', verdict: 'needs_revision', summary: 'Test fixture verdict.', improvements: [], strengths: [], processNote: 'Mocked assessment.' } } as any;
    const grading = jest.spyOn(service, 'buildReport').mockResolvedValue(fakeReport);
    await service.processSubmission({ id: queued.id });
    expect(grading).toHaveBeenCalledTimes(1);
    expect(grading.mock.calls[0][1].workspace).toEqual(snapshot.workspaceSnapshot);
    expect(grading.mock.calls[0][1].links).toEqual(snapshot.contextSnapshot!.links);
    expect(grading.mock.calls[0][1].ranBeforeSubmit).toBe(snapshot.contextSnapshot!.ranBeforeSubmit);
    await service.processSubmission({ id: queued.id });
    expect(grading).toHaveBeenCalledTimes(1);
    const retained = await submissions.findOneByOrFail({ id: queued.id });
    expect(retained.workspaceSnapshot).toEqual(snapshot.workspaceSnapshot);
    expect(retained.contextSnapshot).toEqual(snapshot.contextSnapshot);
    expect(retained.report).toEqual(fakeReport);
    expect((await phaseStates.findOneByOrFail({ id: state.id })).workspace).toEqual({ 'later.py': 'unsubmitted code' });
    await dataSource.destroy();
  });
});

/* ---------------------- sandbox step timings ------------------------------ */

/**
 * The graders hold one duration per sandbox job; `timings` keeps them in the
 * stored report, so the share of a Submit that is sandbox time is a fact
 * rather than an estimate. A record is all it may ever be: the
 * same inputs must still produce the same verdict, field for field, whatever
 * the runner's clock says. Each builder fills the caller's rows rather than
 * returning them, so what a builder answers with is still only the verdict.
 */
describe('FeedbackService report timings', () => {
  it('keeps one row per sandbox step of a code report, named by the pack run', async () => {
    const durationFor: Record<string, number> = {
      'api:visible': 1100,
      'web:visible': 1200,
      'api:hidden': 1300,
      'web:hidden': 1400,
    };
    const sandbox = codeSandbox((job) => ({
      ...testsRun(cases(2, job.runId)),
      durationMs: durationFor[jobKind(job)],
    }));
    const { service } = build({ sandbox });
    const timings: ReportStepTiming[] = [];

    await service['buildCodeReport'](fullStackPhase, fullStackPhase.checks, codeState, 0, timings);

    // In the order the grader ran them: every visible run, then every hidden
    // one (the serial loops), each named the way its own check line is.
    expect(timings).toEqual([
      { step: 'visible-api', durationMs: 1100, outcome: 'ok' },
      { step: 'visible-web', durationMs: 1200, outcome: 'ok' },
      { step: 'hidden-api', durationMs: 1300, outcome: 'ok' },
      { step: 'hidden-web', durationMs: 1400, outcome: 'ok' },
    ]);
  });

  it('names the two steps of a single-run phase without a run id, and keeps the exit kind', async () => {
    const runs: RunResult[] = [
      { ...testsRun(PASSING), durationMs: 2100 },
      { ...testsRun([]), durationMs: 2600, ok: false, exitKind: 'timeout' },
    ];
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => runs.shift() as RunResult),
    };
    const { service } = build({ sandbox });
    const timings: ReportStepTiming[] = [];

    await service['buildCodeReport'](codePhase, codePhase.checks, {
      id: 'ps-1',
      workspace: null,
      ranBeforeSubmit: true,
    } as any, 0, timings);

    // A phase with one run has no group to name, exactly as its checks have no
    // per-run line. The outcome is the runner's exit kind, not a learner's pass.
    expect(timings).toEqual([
      { step: 'visible', durationMs: 2100, outcome: 'ok' },
      { step: 'hidden', durationMs: 2600, outcome: 'timeout' },
    ]);
  });

  it('cannot store a runner sentence where the exit kind belongs', async () => {
    // The sandbox checks that `exitKind` is a string and no more, so the union
    // is a compile-time cast over whatever the transport handed back. This row
    // is stored on the report and the report reaches the learner, so a runner
    // that grows a new kind (or puts a sentence in the field) may not write
    // into it.
    const rogue: string = 'killed: /run/sandbox/9 exceeded its cgroup at 03:11:42';
    const runs: RunResult[] = [
      { ...testsRun(PASSING), durationMs: 2100 },
      { ...testsRun([]), durationMs: 2600, ok: false, exitKind: rogue as RunResult['exitKind'] },
    ];
    const sandbox = {
      analyze: jest.fn(async () => analysis),
      execute: jest.fn(async () => runs.shift() as RunResult),
    };
    const { service } = build({ sandbox });
    const timings: ReportStepTiming[] = [];

    await service['buildCodeReport'](codePhase, codePhase.checks, {
      id: 'ps-1',
      workspace: null,
      ranBeforeSubmit: true,
    } as any, 0, timings);

    expect(timings).toEqual([
      { step: 'visible', durationMs: 2100, outcome: 'ok' },
      { step: 'hidden', durationMs: 2600, outcome: 'error' },
    ]);
  });

  it('keeps a row for each reference run and for every mutant of a tests report', async () => {
    const durations = [3100, 3200, 3300, 3400];
    const sandbox = {
      execute: jest.fn(async (job: any) => ({
        ...testsRun(cases(1, job.runId ?? 'x', gradedOf(job).includes('reference') ? 'passed' : 'failed')),
        durationMs: durations.shift() as number,
      })),
    };
    const { service } = build({ sandbox, execution: fullStackSuite });
    const timings: ReportStepTiming[] = [];

    const report = await service['buildTestsReport'](
      fullStackTestsPhase,
      fullStackTestsPhase.checks,
      { id: 'ps-1', workspace: null } as any,
      timings,
    );

    // Two reference runs one after the other, then the mutant wave in the
    // pack's own order: the order `mutation.matrix` is in.
    expect(timings).toEqual([
      { step: 'reference-api', durationMs: 3100, outcome: 'ok' },
      { step: 'reference-web', durationMs: 3200, outcome: 'ok' },
      { step: 'mutant-api', durationMs: 3300, outcome: 'ok' },
      { step: 'mutant-web', durationMs: 3400, outcome: 'ok' },
    ]);
    expect(report.mutation?.killed).toBe(2);
  });

  it('keeps the smoke run of a deployment report, and nothing when no job ran', async () => {
    const sandbox = {
      execute: jest.fn(async () => ({
        ok: true,
        exitKind: 'ok' as const,
        stdout: 'Tasks',
        stderr: '',
        durationMs: 4200,
      })),
    };
    const { service } = build({ sandbox });
    const timings: ReportStepTiming[] = [];
    const unfinished: ReportStepTiming[] = [];

    await service['buildConfigReport'](deploymentPhase, deploymentPhase.checks, {
      id: 'ps-1',
      workspace: { Dockerfile: DOCKERFILE },
    } as any, timings);
    await service['buildConfigReport'](deploymentPhase, deploymentPhase.checks, {
      id: 'ps-1',
      workspace: { Dockerfile: 'FROM python:3.11-slim\n' },
    } as any, unfinished);

    // The smoke result keeps its own shape, which carries no exit kind, so the
    // row is the duration alone.
    expect(timings).toEqual([{ step: 'smoke', durationMs: 4200 }]);
    // A Dockerfile that starts no CLI never reaches the sandbox, and a row of
    // zero would read as a machine that started instantly.
    expect(unfinished).toEqual([]);
  });

  it('holds nothing that could name a hidden test, a file or a learner', async () => {
    const sandbox = codeSandbox(() => testsRun(cases(1, 'api')));
    const { service } = build({ sandbox });
    const timings: ReportStepTiming[] = [];

    await service['buildCodeReport'](fullStackPhase, fullStackPhase.checks, codeState, 0, timings);

    // The steps are stems fixed in the grader plus the pack's own run id,
    // `^[a-z][a-z0-9-]{0,15}$`, which every per-run check line already carries.
    expect(timings.map((row) => row.step)).toEqual([
      'visible-api',
      'visible-web',
      'hidden-api',
      'hidden-web',
    ]);
    for (const row of timings) expect(Object.keys(row).sort()).toEqual(['durationMs', 'outcome', 'step']);
  });

  it('carries the rows on the stored report and changes nothing else in it', async () => {
    const graded = (offset: number) => {
      const sandbox = codeSandbox((job) => ({
        ...testsRun(cases(2, 'visible')),
        durationMs: offset + job.testPaths.length,
      }));
      const state = {
        id: 'ps-1',
        userId: 'u-1',
        enrollmentId: 'e-1',
        attempts: 1,
        ranBeforeSubmit: true,
        workspace: null,
      };
      const { service } = build({ sandbox, state });
      return service['buildReport'](codePhase, state as any, [soleTask(codePhase)], soleTask(codePhase));
    };

    const quick = await graded(500);
    const slow = await graded(9000);

    expect(quick.timings).toEqual([
      { step: 'visible', durationMs: 501, outcome: 'ok' },
      { step: 'hidden', durationMs: 501, outcome: 'ok' },
    ]);
    // Eighteen times slower, byte for byte the same verdict: one new key and
    // nothing else, so a stored report still holds everything it held.
    const { timings: quickTimings, ...quickRest } = quick;
    const { timings: slowTimings, ...slowRest } = slow;
    expect(slowRest).toEqual(quickRest);
    expect(slowTimings).not.toEqual(quickTimings);
    expect(Object.keys(quick).sort()).toEqual([...Object.keys(quickRest).sort(), 'timings'].sort());
  });

  it('leaves the field off a report that ran no sandbox job at all', async () => {
    const { service } = build();
    const state = { id: 'ps-1', userId: 'u-1', enrollmentId: 'e-1', attempts: 1, workspace: null };
    // a written phase (a story, graded by its floor): no sandbox job
    const phase = {
      ...designPhase,
      rubric: { passThreshold: 70, criteria: [] },
      checks: writtenPhase().checks,
    } as any;

    const report = await service['buildReport'](phase, state as any, [soleTask(phase)], soleTask(phase));

    expect(report.timings).toBeUndefined();
    expect('timings' in report).toBe(false);
  });
});

/* ------------- the roll-up writer ------------- */

/**
 * A split written phase with three tasks (two required and one optional) and
 * a real sqlite schema behind it, because what this section is about is what
 * the grader **writes**: the task's row, the phase's roll-up, the attempt on
 * both, and the transaction the two live in.
 *
 * Nothing here is compiled through the real compiler: the shapes are built by
 * hand as the compiler produces them, and the publish path is tested
 * elsewhere.
 */
/** Shelf's story floor, which `HOST_STORY` passes and a blank record fails. */
const ROLLUP_FLOOR = writtenPhase().checks as StoryChecks;

/** One story task over one record of its own, graded by the story floor. */
function writtenTask(key: string, order: number, required = true): CompiledTask {
  const record = `design/${key}.json`;
  return {
    taskKey: key,
    order,
    required,
    signOff: false,
    checkKind: 'story',
    artefactType: 'user-story',
    artefactPath: null,
    title: key,
    brief: `Write ${key}.`,
    objectives: [],
    owns: [record],
    gradedUnits: [{ kind: 'record', id: record }],
    rubric: {
      passThreshold: 70,
      criteria: [{ key, title: key, weight: 100, description: '' }],
    },
    checks: { ...ROLLUP_FLOOR, record },
  } as unknown as CompiledTask;
}

const alphaTask = writtenTask('alpha', 1);
const betaTask = writtenTask('beta', 2);
const gammaTask = writtenTask('gamma', 3, false);
const ROLLUP_TASKS: CompiledTask[] = [alphaTask, betaTask, gammaTask];

const rollupPhase = {
  key: 'design',
  title: 'Design',
  taskPanel: 'The phase brief.',
  intro: '',
  objectives: [],
  language: 'json',
  files: ['alpha', 'beta', 'gamma'].map((key) => ({
    path: `design/${key}.json`,
    content: '',
    editable: true,
    language: 'json',
  })),
  rubric: {
    passThreshold: 70,
    criteria: ['alpha', 'beta', 'gamma'].map((key) => ({ key, title: key, weight: 100 / 3, description: '' })),
  },
  checks: { ...ROLLUP_FLOOR, record: 'design/alpha.json' },
} as any;

/** A learner workspace where all three records pass the floor. */
const ROLLUP_WORKSPACE: Record<string, string> = {
  'design/alpha.json': serialiseStory(HOST_STORY),
  'design/beta.json': serialiseStory(HOST_STORY),
  'design/gamma.json': serialiseStory(HOST_STORY),
};

/** Every statement the service issues, so "touches no task row" is a fact. */
function queryLog() {
  const queries: string[] = [];
  const logger = {
    logQuery: (query: string) => {
      queries.push(query);
    },
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };
  return { queries, logger };
}

async function rollupStack(
  opts: {
    phase?: any;
    tasks?: CompiledTask[];
    /** Which task rows exist before the first verdict; defaults to every task. */
    seedKeys?: string[];
    status?: string;
    bestScore?: number | null;
    /** The learner's answers; a blank one fails every rule, which is a real failing verdict. */
    workspace?: Record<string, string>;
    jobs?: Record<string, unknown>;
  } = {},
) {
  const phase = opts.phase ?? rollupPhase;
  const tasks = opts.tasks ?? ROLLUP_TASKS;
  const { queries, logger } = queryLog();
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ALL_ENTITIES,
    synchronize: true,
    logging: ['query'],
    logger: logger as any,
  });
  await dataSource.initialize();
  const submissions = dataSource.getRepository(SubmissionEntity);
  const phaseStates = dataSource.getRepository(PhaseStateEntity);
  const taskStates = dataSource.getRepository(TaskStateEntity);
  const state = await phaseStates.save(
    phaseStates.create({
      enrollmentId: 'e-1',
      userId: 'u-1',
      phaseKey: phase.key,
      phaseOrder: 2,
      status: (opts.status ?? 'in_progress') as any,
      attempts: 0,
      bestScore: opts.bestScore ?? null,
      workspace: { ...(opts.workspace ?? ROLLUP_WORKSPACE) },
      ranBeforeSubmit: true,
    }),
  );
  for (const key of opts.seedKeys ?? tasks.map((task) => task.taskKey)) {
    await taskStates.save(
      taskStates.create({ phaseStateId: state.id, userId: 'u-1', taskKey: key }),
    );
  }
  const content = contentStub(phase);
  content.getTasksForEnrollment = jest.fn(
    (_enrollment: { projectSlug: string }, _key: string): any => tasks,
  );
  const enrollments = {
    findOneByOrFail: jest.fn(async () => ({ id: 'e-1', userId: 'u-1', projectSlug: 'tasktrackr' })),
    findOne: jest.fn(async () => ({ id: 'e-1', userId: 'u-1', projectSlug: 'tasktrackr' })),
  };
  const messages = { count: jest.fn(async () => 0), find: jest.fn(async () => []) };
  /** Which tasks the reviewer passes; anything unnamed passes. */
  const verdicts = new Map<string, 'pass' | 'revise'>();
  const assistant = {
    reviewSubmission: jest.fn(async (_phase: any, _state: any, input: any) => ({
      provider: 'openai',
      verdict: verdicts.get(input.task.taskKey) ?? 'pass',
      summary: 'reviewed',
      strengths: [],
      improvements: [],
      processNote: '',
      criteriaEvidence: input.task.rubric.criteria.map((criterion: any) => ({
        key: criterion.key,
        met: true,
        evidence: 'the artefact says so',
      })),
    })),
  };
  const onVerdict = jest.fn(async () => undefined);
  const jobs = {
    enqueue: jest.fn(async () => undefined),
    register: jest.fn(),
    durable: false,
    ...(opts.jobs ?? {}),
  };
  const service = new FeedbackService(
    submissions,
    phaseStates,
    enrollments as any,
    messages as any,
    content as any,
    {} as any,
    {} as any,
    assistant as any,
    jobs as any,
    { emitJob: jest.fn() } as any,
    { onVerdict } as any,
  );
  const reload = () => phaseStates.findOneByOrFail({ id: state.id });
  const rowFor = (taskKey: string) =>
    taskStates.findOne({ where: { phaseStateId: state.id, taskKey } });
  const grade = async (taskKey?: string) => {
    const held = await reload();
    const view = await service.submit(phase, held, undefined, taskKey);
    await service.processSubmission({ id: view.id });
    return view;
  };
  return {
    dataSource, service, submissions, phaseStates, taskStates, state, queries, verdicts,
    onVerdict, jobs, reload, rowFor, grade, phase, tasks,
  };
}

describe('the grader is the roll-up writer', () => {
  it('writes the task row and the phase row in one transaction', async () => {
    const stack = await rollupStack();
    try {
      stack.queries.length = 0;
      await stack.grade('alpha');

      // The task's own four columns.
      const alpha = await stack.rowFor('alpha');
      expect(alpha).toMatchObject({ status: 'passed', bestScore: 100, awaitingSignOff: false, attempts: 1 });
      expect(alpha!.passedAt).toEqual(expect.any(String));

      // Its siblings are not touched by somebody else's verdict.
      expect(await stack.rowFor('beta')).toMatchObject({ status: 'in_progress', bestScore: null, passedAt: null, attempts: 0 });

      // The phase's three columns, and only those three: one of two required
      // tasks has passed, so the mean over the required set is 50 and the gate
      // has not moved.
      const phaseRow = await stack.reload();
      expect(phaseRow.status).toBe('submitted');
      expect(phaseRow.bestScore).toBe(50);
      expect(phaseRow.passedAt).toBeNull();

      // One transaction: the task row and the phase row move together, with no
      // COMMIT between them.
      const begin = stack.queries.map((sql) => /^BEGIN/i.test(sql)).lastIndexOf(true);
      expect(begin).toBeGreaterThanOrEqual(0);
      const inTransaction = stack.queries.slice(begin);
      const taskWrite = inTransaction.findIndex((sql) => /^UPDATE "task_states"/i.test(sql));
      const phaseWrite = inTransaction.findIndex((sql) => /^UPDATE "phase_states"/i.test(sql));
      const commit = inTransaction.findIndex((sql) => /^COMMIT/i.test(sql));
      expect(taskWrite).toBeGreaterThan(0);
      expect(phaseWrite).toBeGreaterThan(taskWrite);
      expect(commit).toBeGreaterThan(phaseWrite);

      // The narrow `{ id }` predicate, and the three roll-up columns, never a
      // whole-row write, which would post this job's copy of `workspace` back
      // over an autosave that landed while it was grading, and never the
      // attempt counter, which is spent in SQL of its own.
      const phaseWrites = inTransaction.filter((sql) => /^UPDATE "phase_states"/i.test(sql));
      expect(phaseWrites).toHaveLength(1);
      expect(phaseWrites[0]).toMatch(/WHERE "id" IN \(\?\)/);
      expect(phaseWrites[0]).toMatch(/"status" = /);
      expect(phaseWrites[0]).toMatch(/"passedAt" = /);
      expect(phaseWrites[0]).toMatch(/"bestScore" = /);
      expect(phaseWrites[0]).not.toMatch(/"workspace"|"attempts"|"reflection"|"solutionReadAt"/);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('leaves the phase submitted while one required task is unpassed, and opens it on the last one', async () => {
    const stack = await rollupStack();
    try {
      await stack.grade('alpha');
      expect((await stack.reload()).status).toBe('submitted');

      // The optional task moves no gate and no phase score: the mean is over
      // the required set and over nothing else.
      await stack.grade('gamma');
      const afterOptional = await stack.reload();
      expect(afterOptional.status).toBe('submitted');
      expect(afterOptional.bestScore).toBe(50);
      expect(await stack.rowFor('gamma')).toMatchObject({ status: 'passed', bestScore: 100 });

      await stack.grade('beta');
      const opened = await stack.reload();
      expect(opened.status).toBe('passed');
      expect(opened.passedAt).toEqual(expect.any(String));
      expect(opened.bestScore).toBe(100);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('keeps the phase shut for a required task that has no row at all', async () => {
    // The standing inversion: if every creator of a task row failed, the
    // gate stays shut. A required key with no row is a key that has not
    // passed, and the roll-up quantifies over the pinned version's keys rather
    // than over the rows it was handed.
    const stack = await rollupStack({ seedKeys: ['alpha'] });
    try {
      await stack.grade('alpha');

      const phaseRow = await stack.reload();
      expect(phaseRow.status).toBe('submitted');
      expect(phaseRow.passedAt).toBeNull();
      // And the writer did not invent the missing row on the sibling's behalf.
      expect(await stack.rowFor('beta')).toBeNull();
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('spends and refunds the attempt on both rows', async () => {
    const stack = await rollupStack({ jobs: { enqueue: jest.fn(async () => undefined) } });
    try {
      const held = await stack.reload();
      await stack.service.submit(stack.phase, held, undefined, 'alpha');
      expect((await stack.reload()).attempts).toBe(1);
      expect((await stack.rowFor('alpha'))!.attempts).toBe(1);
      expect((await stack.rowFor('beta'))!.attempts).toBe(0);

      // The queue refuses the work, so neither counter may keep the attempt:
      // they are the denominator of the reliance index and an outage is not a
      // try at the rubric.
      (stack.jobs.enqueue as jest.Mock).mockRejectedValueOnce(new Error(QUEUE_UNAVAILABLE_MESSAGE));
      await stack.submissions.update({ phaseStateId: stack.state.id }, { status: 'completed' });
      const again = await stack.reload();
      await expect(stack.service.submit(stack.phase, again, undefined, 'beta')).rejects.toThrow(
        QUEUE_UNAVAILABLE_MESSAGE,
      );
      expect((await stack.reload()).attempts).toBe(1);
      expect((await stack.rowFor('beta'))!.attempts).toBe(0);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('holds a learner to two queued-or-running submissions across every phase and task', async () => {
    // Sequentially, because the cap is ADVISORY: it is a bare count with no
    // lock and no constraint behind it, so two submits that arrive together
    // can both read the same count and both insert. The only database
    // guarantee is `UQ_submissions_in_flight`, which says nothing about a
    // learner's total, and a test asserting a hard bound would be asserting a
    // property the code does not have.
    const stack = await rollupStack();
    try {
      await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      await stack.service.submit(stack.phase, await stack.reload(), undefined, 'beta');
      const before = await stack.reload();

      await expect(
        stack.service.submit(stack.phase, before, undefined, 'gamma'),
      ).rejects.toThrow('Two of your submissions are still grading.');

      // Refused before the attempt was spent, and before a third row existed.
      expect((await stack.reload()).attempts).toBe(2);
      expect((await stack.rowFor('gamma'))!.attempts).toBe(0);
      expect(await stack.submissions.count({ where: { phaseStateId: stack.state.id } })).toBe(2);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('refuses a submit that names a task the pinned version does not declare, and one that names none', async () => {
    const stack = await rollupStack();
    try {
      await expect(
        stack.service.submit(stack.phase, await stack.reload(), undefined, 'delta'),
      ).rejects.toThrow('unknown task');

      // A learner's browser never asks this (the web sends the key) but a
      // journey script or a stale tab does, and picking one of three is how a
      // learner's work goes to the wrong grader.
      await expect(stack.service.submit(stack.phase, await stack.reload(), undefined)).rejects.toThrow(
        'This phase has 3 tasks. Submit one of them: alpha, beta, gamma.',
      );
      expect(await stack.submissions.count({ where: { phaseStateId: stack.state.id } })).toBe(0);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('writes a verdict onto a row the board lost between submit and grading', async () => {
    const stack = await rollupStack();
    try {
      const view = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      // A reset, a repair or an erasure landing between the two halves. The
      // verdict is real work and has to land somewhere, so the writer settles
      // it on `UQ_task_states_key` rather than on a read-then-write.
      await stack.taskStates.delete({ phaseStateId: stack.state.id, taskKey: 'alpha' });

      await stack.service.processSubmission({ id: view.id });

      expect(await stack.rowFor('alpha')).toMatchObject({ status: 'passed', bestScore: 100 });
      expect((await stack.reload()).status).toBe('submitted');
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('hands the bell the phase s own move and the task s own counter', async () => {
    const stack = await rollupStack();
    try {
      await stack.grade('alpha');
      expect(stack.onVerdict).toHaveBeenLastCalledWith(
        expect.anything(), expect.any(String), expect.anything(), true,
        { before: 'in_progress', after: 'submitted', taskKey: 'alpha', taskAttempts: 1 },
      );

      await stack.grade('beta');
      expect(stack.onVerdict).toHaveBeenLastCalledWith(
        expect.anything(), expect.any(String), expect.anything(), true,
        { before: 'submitted', after: 'passed', taskKey: 'beta', taskAttempts: 1 },
      );
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('records the task each revision is about, and narrows the in-flight guard to it', async () => {
    const stack = await rollupStack();
    try {
      const alpha = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      // Two tasks of one phase may be in flight at once: the guard is
      // `(phaseStateId, taskKey)`, and it is the database that says so.
      const beta = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'beta');
      expect(beta.id).not.toBe(alpha.id);
      // By id rather than by order: two submissions minted in one millisecond
      // are ordered by the random half of `submissionId`, and which of two
      // tasks was pressed first is not what this is about.
      expect((await stack.submissions.findOneByOrFail({ id: alpha.id })).taskKey).toBe('alpha');
      expect((await stack.submissions.findOneByOrFail({ id: beta.id })).taskKey).toBe('beta');

      // And a double-click on one of them is still the same submission.
      const again = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      expect(again.id).toBe(alpha.id);
      expect(await stack.submissions.count()).toBe(2);
    } finally {
      await stack.dataSource.destroy();
    }
  });
});

/**
 * Seeding a task row for a learner whose board predates per-task rows (an
 * upgraded database), at the creator such a learner reaches first.
 *
 * `POST /phases/:id/submit` goes through `loadOwnedState`, which stamps the
 * pack and does **not** repair the board, so a learner of a teacher-authored
 * project whose first request after the upgrade is a submit gets their
 * `task_states` row from `writeTaskState` and from nowhere else. Every later
 * repair finds it present and inserts nothing. A row seeded `in_progress` on a
 * phase they had already passed makes `strictPass`' row conjunct false for
 * ever: the tile stays green and `advance` refuses the merge they had earned.
 *
 * So all three creators answer the same question the same way, and the seed is
 * bounded by the same three conjuncts `newTaskState` is bounded by: one task
 * in the pinned list, a phase that reads `passed`, and that task required.
 */
describe('the submit creator carries a phase pass from before per-task rows onto the row it writes', () => {
  /** When the learner passed the phase, before per-task rows existed. */
  const PASSED_AT = '2026-09-10T08:00:00.000Z';

  /** The board such a learner of a teacher project is actually in. */
  const passedBoard = async (tasks: CompiledTask[], seedKeys: string[] = []) => {
    const stack = await rollupStack({ tasks, seedKeys, status: 'passed', bestScore: 82 });
    await stack.phaseStates.update(stack.state.id, { passedAt: PASSED_AT });
    return stack;
  };

  it('seeds the row from the phase the learner had already passed', async () => {
    const stack = await passedBoard([alphaTask]);
    try {
      // The revision they handed in before the upgrade: the migration backfilled its key
      // to `''`, and the pinned version's one required key is `alpha`.
      const before = await stack.submissions.save(
        stack.submissions.create({
          phaseStateId: stack.state.id,
          userId: 'u-1',
          taskKey: '',
          status: 'completed',
          score: 82,
          passed: true,
        }),
      );

      await stack.service.submit(stack.phase, await stack.reload(), undefined);

      // A phase with exactly one task has exactly one owner for its history:
      // the sentence the adoption rests on, said about the row as well as
      // about the revision.
      const row = await stack.rowFor('alpha');
      expect([row?.status, row?.passedAt, row?.bestScore]).toEqual(['passed', PASSED_AT, 82]);
      expect((await stack.submissions.findOneByOrFail({ id: before.id })).taskKey).toBe('alpha');
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('writes the unstarted row on a phase of two tasks, however the phase reads', async () => {
    const stack = await passedBoard([alphaTask, betaTask]);
    try {
      await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');

      // Two tasks and the phase's pass names no single owner: it is the
      // roll-up of a set, and a member of that set with no row is a key that
      // has not passed. The standing inversion has to survive this seed.
      const row = await stack.rowFor('alpha');
      expect([row?.status, row?.passedAt, row?.bestScore]).toEqual(['in_progress', null, null]);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('writes the unstarted row for an optional task, and for a phase that has not passed', async () => {
    // Optional: the phase's pass was never this task's to inherit.
    const optional = await passedBoard([gammaTask]);
    try {
      await optional.service.submit(optional.phase, await optional.reload(), undefined);
      const row = await optional.rowFor('gamma');
      expect([row?.status, row?.passedAt, row?.bestScore]).toEqual(['in_progress', null, null]);
    } finally {
      await optional.dataSource.destroy();
    }

    // Not passed: there is nothing to inherit, and a row that claimed one
    // would be a pass this block has no evidence for.
    const open = await rollupStack({ tasks: [alphaTask], seedKeys: [], status: 'submitted', bestScore: 40 });
    try {
      await open.service.submit(open.phase, await open.reload(), undefined);
      const row = await open.rowFor('alpha');
      expect([row?.status, row?.passedAt, row?.bestScore]).toEqual(['in_progress', null, null]);
    } finally {
      await open.dataSource.destroy();
    }
  });

  it('never rewrites a row the board already has', async () => {
    const stack = await passedBoard([alphaTask], ['alpha']);
    try {
      await stack.service.submit(stack.phase, await stack.reload(), undefined);

      // The seed is a creator's decision and this creator created nothing: the
      // insert settles on `UQ_task_states_key` and the row the board holds is
      // the answer, attempt spent on it and all.
      const row = await stack.rowFor('alpha');
      expect([row?.status, row?.passedAt, row?.bestScore]).toEqual(['in_progress', null, null]);
      expect(row?.attempts).toBe(1);
    } finally {
      await stack.dataSource.destroy();
    }
  });
});

describe('the sole-task gate keeps no task row', () => {
  /** The phase of the shipped project, as its compiler mints it: one synthesised task. */
  const solePhase = { ...rollupPhase, key: 'design' } as any;
  const soleList = [soleTask(solePhase)];

  /** Nothing answered, so every floor line fails and the verdict really is a failure. */
  const BLANK_WORKSPACE = { 'design/alpha.json': '', 'design/beta.json': '', 'design/gamma.json': '' };

  it.each([
    ['locked', true],
    ['locked', false],
    ['passed', true],
    ['in_progress', true],
    ['in_progress', false],
    ['submitted', true],
    ['submitted', false],
  ] as const)('%s + %s writes what nextPhaseStatus wrote', async (status, passed) => {
    const stack = await rollupStack({
      phase: solePhase, tasks: soleList, seedKeys: [], status, bestScore: 40,
      workspace: passed ? ROLLUP_WORKSPACE : BLANK_WORKSPACE,
    });
    try {
      await stack.grade();

      const after = await stack.reload();
      const expected = status === 'locked' || status === 'passed' ? status : passed ? 'passed' : 'submitted';
      expect(after.status).toBe(expected);
      // `Math.max(held.bestScore ?? 0, report.overall)`, at the same
      // expression: monotonic, and never moved by a failing verdict.
      expect(after.bestScore).toBe(passed ? 100 : 40);
      // `passedAt` is stamped exactly when the phase first opens, and never
      // restamped: the phase-wide arm of the roll-up carries the same
      // `held.status !== 'passed'` term as the phase-level writer.
      if (expected === 'passed' && status !== 'passed') expect(after.passedAt).toEqual(expect.any(String));
      else expect(after.passedAt).toBeNull();
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('reads and writes no task row at all', async () => {
    const stack = await rollupStack({ phase: solePhase, tasks: soleList, seedKeys: [] });
    try {
      stack.queries.length = 0;
      await stack.grade();

      // As a statement about the statements: a sole task has no row, so
      // nothing may go looking for one. This is the test that keeps the guard
      // from being deleted as tidiness.
      expect(stack.queries.filter((sql) => /task_states/i.test(sql))).toEqual([]);
      expect(await stack.taskStates.count()).toBe(0);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('admits one in-flight submission per phase state, and keys every revision the empty key', async () => {
    const stack = await rollupStack({ phase: solePhase, tasks: soleList, seedKeys: [] });
    try {
      const first = await stack.service.submit(solePhase, await stack.reload(), undefined);
      const second = await stack.service.submit(solePhase, await stack.reload(), undefined);
      expect(second.id).toBe(first.id);
      expect(await stack.submissions.count()).toBe(1);
      // The compiled sole task's own key IS the column's backfill default,
      // so the narrowed guard constrains exactly the phase-wide set.
      expect((await stack.submissions.findOneByOrFail({ id: first.id })).taskKey).toBe(SOLE_TASK_KEY);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('spends the attempt on the phase row and on nothing else', async () => {
    const stack = await rollupStack({ phase: solePhase, tasks: soleList, seedKeys: [] });
    try {
      stack.queries.length = 0;
      await stack.service.submit(solePhase, await stack.reload(), undefined);
      expect((await stack.reload()).attempts).toBe(1);
      expect(stack.queries.filter((sql) => /task_states/i.test(sql))).toEqual([]);
    } finally {
      await stack.dataSource.destroy();
    }
  });
});

/* ----------- the run a revision belongs to ----------- */

/**
 * The reset-epoch rules and the snapshot rule. `submissions.resetEpoch` is the task
 * row's `resetCount` at insert, read under the enrolment lock in the same
 * transaction as the insert; NULL is the current run (every row written before the column existed, a
 * rollback-window row, every sole-task row). A non-quiz verdict whose revision
 * is of an earlier run is kept on the revision and moves no gate.
 */
describe('the run a revision belongs to (release B, B1A)', () => {
  const solePhase = { ...rollupPhase, key: 'design' } as any;
  const soleList = [soleTask(solePhase)];
  it('stamps the task row\'s count on an authored submit', async () => {
    const stack = await rollupStack();
    try {
      await stack.taskStates.update({ phaseStateId: stack.state.id, taskKey: 'alpha' }, { resetCount: 2 });
      const view = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      expect((await stack.submissions.findOneByOrFail({ id: view.id })).resetEpoch).toBe(2);
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('a sole-task (TaskTrackr) submit stamps NULL (guard)', async () => {
    const stack = await rollupStack({ phase: solePhase, tasks: soleList, seedKeys: [] });
    try {
      const view = await stack.service.submit(solePhase, await stack.reload(), undefined);
      expect((await stack.submissions.findOneByOrFail({ id: view.id })).resetEpoch).toBeNull();
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('5b: the stored snapshot is the phase row re-read under the lock, not the caller\'s copy', async () => {
    const stack = await rollupStack();
    try {
      const stale = await stack.reload();
      // A reset (or any writer) commits between the request's outer read and
      // its insert: the row now holds different bytes than the caller's copy.
      await stack.phaseStates.update(stack.state.id, {
        workspace: { ...ROLLUP_WORKSPACE, 'design/alpha.json': 'written after the outer read' },
      });
      const view = await stack.service.submit(stack.phase, stale, undefined, 'alpha');
      const row = await stack.submissions.findOneByOrFail({ id: view.id });
      expect(row.workspaceSnapshot!['design/alpha.json']).toBe('written after the outer read');
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('a non-quiz verdict of an earlier run moves no task row and no roll-up', async () => {
    const stack = await rollupStack();
    try {
      const view = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      expect((await stack.submissions.findOneByOrFail({ id: view.id })).resetEpoch).toBe(0);
      // The task is started over while nothing of it was being marked would be
      // refused; the row moving under a queued revision is the regrade shape,
      // and the predicate is one for both writers.
      await stack.taskStates.update({ phaseStateId: stack.state.id, taskKey: 'alpha' }, { resetCount: 1 });
      const before = await stack.rowFor('alpha');
      await stack.service.processSubmission({ id: view.id });

      const after = await stack.rowFor('alpha');
      expect([after!.status, after!.bestScore, after!.passedAt]).toEqual([
        before!.status,
        before!.bestScore,
        before!.passedAt,
      ]);
      const phaseRow = await stack.reload();
      expect([phaseRow.status, phaseRow.bestScore]).toEqual(['in_progress', null]);
      // The verdict itself is kept on the revision: it is the record.
      expect((await stack.submissions.findOneByOrFail({ id: view.id })).status).toBe('completed');
    } finally {
      await stack.dataSource.destroy();
    }
  });

  it('NULL reads as the current run, so a NULL revision\'s verdict moves the row (guard)', async () => {
    const stack = await rollupStack();
    try {
      const view = await stack.service.submit(stack.phase, await stack.reload(), undefined, 'alpha');
      await stack.submissions.update({ id: view.id }, { resetEpoch: null });
      await stack.taskStates.update({ phaseStateId: stack.state.id, taskKey: 'alpha' }, { resetCount: 1 });
      await stack.service.processSubmission({ id: view.id });
      expect((await stack.rowFor('alpha'))!.bestScore).not.toBeNull();
    } finally {
      await stack.dataSource.destroy();
    }
  });
});

/**
 * A phase the learner's pinned version holds in the older format: TaskTrackr 4.0.0's Deployment, a config task with no
 * runbook record. Nothing grades it the way the room writes it, so a submit answers 409 with
 * the room's sentence and spends nothing, and a grading job already queued for one fails closed with that sentence.
 */
describe('FeedbackService and a phase its pinned version holds in the older format', () => {
  const olderDeployment = () => new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source).phases.find((phase) => phase.key === 'deployment')!;

  it('refuses a submit with the room\'s sentence, before anything is written or spent', async () => {
    const { service, rows, jobs, phaseStates } = build();
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;
    await expect(service.submit(olderDeployment(), state)).rejects.toThrow(new ConflictException(RUNBOOK_OLDER_FORMAT_ROOM));
    expect(rows).toHaveLength(0);
    expect(state.attempts).toBe(0);
    expect(phaseStates.update).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('fails a queued submission for it closed, with the room\'s sentence, and grades nothing', async () => {
    const execute = jest.fn();
    const { dataSource, service, submissions, state, content } = await realStack({ sandbox: { analyze: jest.fn(), execute } });
    try {
      const queued = await service.submit(codePhase, state);
      // a republish between the submit and the job: the pin now answers the older phase
      content.getPhaseForEnrollment.mockImplementation(() => olderDeployment());
      await service.processSubmission({ id: queued.id });
      const row = await submissions.findOneByOrFail({ id: queued.id });
      expect([row.status, row.error, row.report, row.score]).toEqual(['failed', RUNBOOK_OLDER_FORMAT_ROOM, null, null]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await dataSource.destroy();
    }
  });
});

/**
 * A stored older Requirements of two written tasks and a quiz, as an older
 * build published it. This build serves the version (the learner keeps their board)
 * but grades nothing through the markdown tasks: a submit on one answers 409
 * with the Requirements older-format room sentence, never a 500, and a job
 * already queued for one fails closed with the same sentence.
 */
describe('FeedbackService and a stored older Requirements of two written tasks and a quiz', () => {
  const VERSION = 'v-older-written';

  /** The phase as the seam serves it, resolved through a ContentService holding the 2.0.1-shaped version. */
  const servedRequirements = (): PhaseContent => {
    const loader = new ContentService();
    loader.loadAll();
    const head = loader.getProject('tasktrackr');
    const phases = head.phases.map((phase) =>
      phase.key === 'requirements'
        ? ({ ...phase, artifactKind: 'markdown', checks: { kind: 'markdown', targets: ['requirements/my-story.md'], rules: [] } } as unknown as PhaseContent)
        : phase,
    );
    const quiz = fixtureQuizChecks();
    const tasksOf = (phase: PhaseContent): CompiledTask[] =>
      phase.key !== 'requirements'
        ? [soleTaskFor(phase)]
        : [
            { ...soleTaskFor(phase), taskKey: 'story', order: 1, checkKind: 'markdown' as never },
            { ...soleTaskFor(phase), taskKey: 'criteria', order: 2, checkKind: 'markdown' as never },
            { ...soleTaskFor(phase), taskKey: 'concepts', order: 3, checkKind: 'quiz', artefactType: 'quiz', artefactPath: null, owns: [],
              gradedUnits: quiz.questions.map((one) => ({ kind: 'question' as const, id: one.id })), checks: quiz },
          ];
    const content = new ContentService();
    content.installVersions([{
      versionId: VERSION,
      content: { ...head, version: '2.0.1', phases },
      compiler: COMPILER_IDENTITY,
      phases: phases.map((phase) => ({ key: phase.key, tasks: tasksOf(phase) })),
    }]);
    expect(content.unservableVersions()).toEqual([]);
    const at = { projectSlug: 'tasktrackr', projectVersionId: VERSION };
    expect(content.getTasksForEnrollment(at, 'requirements').map((task) => task.taskKey)).toEqual(['story', 'criteria', 'concepts']);
    return content.getPhaseForEnrollment(at, 'requirements');
  };

  it('refuses a submit on a written task with the older-format sentence, a 409 before anything is written or spent', async () => {
    const { service, rows, jobs, phaseStates } = build();
    const state = { id: 'ps-1', userId: 'u-1', attempts: 0, workspace: null } as any;
    const refused = await service.submit(servedRequirements(), state, undefined, 'story').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getStatus()).toBe(409);
    expect((refused as ConflictException).message).toBe(REQUIREMENTS_OLDER_FORMAT_ROOM);
    expect(rows).toHaveLength(0);
    expect(state.attempts).toBe(0);
    expect(phaseStates.update).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('fails a queued submission for it closed, with the older-format sentence, and grades nothing', async () => {
    const execute = jest.fn();
    const { dataSource, service, submissions, state, content } = await realStack({ sandbox: { analyze: jest.fn(), execute } });
    try {
      const queued = await service.submit(codePhase, state);
      const older = servedRequirements();
      content.getPhaseForEnrollment.mockImplementation(() => older);
      await service.processSubmission({ id: queued.id });
      const row = await submissions.findOneByOrFail({ id: queued.id });
      expect([row.status, row.error, row.report, row.score]).toEqual(['failed', REQUIREMENTS_OLDER_FORMAT_ROOM, null, null]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await dataSource.destroy();
    }
  });
});

/*
 * Spec 4.4: a version without Design. The conformance ledger reads Design's
 * contract only where the pinned version holds Design; without it, the
 * phase's own carried `design/contracts.json` is the ledger's only source, and
 * `phaseOf` keeps its 404 for everyone else.
 */
describe('the conformance ledger of a project without Design', () => {
  const V_NO_DESIGN = 'v-no-design';
  let dataSource: DataSource;
  let content: ContentService;
  let service: FeedbackService;
  let maintenancePhase: PhaseContent;
  let maintenanceState: PhaseStateEntity;
  let enrolmentOnThree: EnrollmentEntity;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    const shipped = content.getProject('tasktrackr');
    // Requirements, Implementation and Maintenance, renumbered 1 to 3 as the draft compiler numbers them.
    const phases = shipped.phases
      .filter((one) => ['requirements', 'implementation', 'maintenance'].includes(one.key))
      .map((one, at) => ({ ...one, order: at + 1 }));
    const project = { ...shipped, slug: 'no-design', phases };
    content.installVersions([{
      versionId: V_NO_DESIGN,
      content: project,
      phases: phases.map((one) => ({ key: one.key, tasks: [soleTaskFor(one)] })),
      compiler: COMPILER_IDENTITY,
    }]);
    const manager = dataSource.manager;
    enrolmentOnThree = await manager.save(manager.create(EnrollmentEntity, {
      userId: 'u-ledger', projectSlug: 'no-design', projectVersionId: V_NO_DESIGN, currentPhaseOrder: 3,
    }));
    for (const one of phases) {
      const saved = await manager.save(manager.create(PhaseStateEntity, {
        enrollmentId: enrolmentOnThree.id, userId: 'u-ledger', phaseKey: one.key, phaseOrder: one.order,
        status: one.key === 'maintenance' ? 'in_progress' : 'passed',
      }));
      if (one.key === 'maintenance') maintenanceState = saved;
    }
    maintenancePhase = content.getPhaseForEnrollment(enrolmentOnThree, 'maintenance');
    service = new FeedbackService(
      dataSource.getRepository(SubmissionEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      {} as any,
      content,
      {} as any,
      {} as any,
      {} as any,
      { register: jest.fn() } as any,
      {} as any,
      { onVerdict: jest.fn(async () => undefined) } as any,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("builds Maintenance's ledger from its own design/contracts.json, throws nothing and logs nothing", async () => {
    // Maintenance's carried contract is an editable mount of TaskTrackr's own.
    expect(maintenancePhase.files.some((one) => one.path === 'design/contracts.json' && one.editable)).toBe(true);
    const getPhaseForEnrollment = jest.spyOn(content, 'getPhaseForEnrollment');
    const captureException = jest.spyOn(errors, 'captureException');
    const sources = await (service as any).designSources(maintenancePhase, maintenanceState);
    expect(Object.keys(sources)).toEqual(['design/contracts.json']);
    expect(sources['design/contracts.json']).toBe(maintenancePhase.files.find((one) => one.path === 'design/contracts.json')?.content);
    expect(getPhaseForEnrollment).not.toHaveBeenCalledWith(expect.anything(), 'design');
    // And through the report's sections, whose catch is where a throw here was logged.
    await (service as any).reportExtras(maintenancePhase, maintenanceState, reportSoFar, undefined, gradedTaskOf(maintenancePhase));
    expect(getPhaseForEnrollment).not.toHaveBeenCalledWith(expect.anything(), 'design');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('keeps phaseOf answering 404 for a phase the version does not hold', () => {
    expect(() => content.getPhaseForEnrollment(enrolmentOnThree, 'design')).toThrow(NotFoundException);
  });
});
