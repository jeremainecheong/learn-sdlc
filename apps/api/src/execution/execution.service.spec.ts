import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { RunResult, TestCaseResult } from '@learnsdlc/shared';
import { isRunnerUnavailable, RUNNER_UNAVAILABLE_MESSAGE } from '@learnsdlc/shared';
import type { ContentService } from '../content/content.service';
import type {
  CodeChecks,
  ContentFileSpec,
  PhaseChecks,
  PhaseContent,
  PhaseRun,
  TestsChecks,
} from '../content/content.types';
import { EnrollmentEntity, ExecutionRunEntity, PhaseStateEntity } from '../db/entities';
import type { EventsGateway } from '../events/events.gateway';
import type { JobsService } from '../jobs/jobs.service';
import type { SandboxService, SandboxTestJob, SandboxTraceOwner } from './sandbox.service';
import {
  ExecutionService,
  isPermanentUnavailable,
  MERGED_OUTPUT_LIMIT,
  mergeRunResults,
  NOTHING_TO_RUN,
  RUN_LIST_CAP,
  runInputHash,
  runnerSentence,
  unavailableSentence,
  type MergedRunResult,
} from './execution.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The run history a phase panel reads. Only listFor is exercised here (the
 * sandbox paths have their own suites), so the collaborators are stubs and the
 * database is real, which is where the ordering and the scoping actually live.
 */
describe('ExecutionService.listFor', () => {
  let dataSource: DataSource;
  let runs: Repository<ExecutionRunEntity>;
  let service: ExecutionService;

  const owner = 'learner-1';
  const bystander = 'learner-2';
  const phaseStateId = 'phase-1';
  const otherPhaseId = 'phase-2';

  /** Rows are inserted with explicit timestamps so "oldest first" is testable. */
  const addRun = async (
    userId: string,
    phase: string,
    minute: number,
    kind: 'run' | 'submit' = 'run',
  ): Promise<ExecutionRunEntity> => {
    const run = await runs.save(
      runs.create({ userId, phaseStateId: phase, kind, status: 'completed' }),
    );
    await runs.update(run.id, { createdAt: new Date(Date.UTC(2026, 8, 1, 9, minute)) });
    return run;
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    runs = dataSource.getRepository(ExecutionRunEntity);
    service = new ExecutionService(
      runs,
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      {} as ContentService,
      {} as SandboxService,
      {} as JobsService,
      {} as EventsGateway,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.manager.clear(ExecutionRunEntity);
  });

  it('returns nothing for a phase that has never been run', async () => {
    expect(await service.listFor(phaseStateId, owner)).toEqual([]);
  });

  it('returns the phase runs oldest first, whatever order they were written in', async () => {
    const noon = await addRun(owner, phaseStateId, 30);
    const early = await addRun(owner, phaseStateId, 5);
    const late = await addRun(owner, phaseStateId, 55);

    const list = await service.listFor(phaseStateId, owner);
    expect(list.map((r) => r.id)).toEqual([early.id, noon.id, late.id]);
    expect(list[0].createdAt < list[2].createdAt).toBe(true);
  });

  it('carries the full run view, result and all', async () => {
    const run = await addRun(owner, phaseStateId, 1, 'submit');
    const result: RunResult = {
      ok: true,
      exitKind: 'ok',
      stdout: 'two tasks',
      stderr: '',
      durationMs: 12,
    };
    await runs.update(run.id, { result });

    const [view] = await service.listFor(phaseStateId, owner);
    expect(view.kind).toBe('submit');
    expect(view.status).toBe('completed');
    expect(view.result?.stdout).toBe('two tasks');
    expect(typeof view.createdAt).toBe('string');
  });

  it('shows another phase nothing, and another learner nothing', async () => {
    await addRun(owner, phaseStateId, 10);
    await addRun(owner, otherPhaseId, 11);
    await addRun(bystander, phaseStateId, 12);

    expect(await service.listFor(phaseStateId, owner)).toHaveLength(1);
    expect(await service.listFor(otherPhaseId, owner)).toHaveLength(1);
    // A phase id guessed from someone else's URL is an empty list, not their history.
    expect(await service.listFor(phaseStateId, 'nobody')).toEqual([]);
  });

  it('caps a long history at the newest 50, still oldest first', async () => {
    const all: string[] = [];
    for (let i = 0; i < RUN_LIST_CAP + 12; i += 1) {
      all.push((await addRun(owner, phaseStateId, i)).id);
    }

    const list = await service.listFor(phaseStateId, owner);
    expect(list).toHaveLength(RUN_LIST_CAP);
    // The recent runs are the ones a learner acts on, so the first twelve go.
    expect(list.map((r) => r.id)).toEqual(all.slice(12));
  });
});

describe('ExecutionService.getRun', () => {
  let dataSource: DataSource;
  let service: ExecutionService;
  let runs: Repository<ExecutionRunEntity>;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    runs = dataSource.getRepository(ExecutionRunEntity);
    service = new ExecutionService(
      runs,
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      {} as ContentService,
      {} as SandboxService,
      {} as JobsService,
      {} as EventsGateway,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('refuses a run belonging to someone else exactly as it refuses one that does not exist', async () => {
    const run = await runs.save(
      runs.create({ userId: 'learner-1', phaseStateId: 'phase-1', kind: 'run', status: 'queued' }),
    );
    await expect(service.getRun(run.id, 'learner-2')).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.getRun(run.id, 'learner-1')).id).toBe(run.id);
  });
});

/**
 * The Run button on a phase the pack marks `canRun: false`. A job queued
 * anyway would fail on "no runnable action" and leave a failed row that the
 * records batch, the dossier and the export all count as an attempt: one per
 * call, thirty a minute, for a learner who wanted to.
 */
describe('ExecutionService.runPhase', () => {
  let dataSource: DataSource;
  let runs: Repository<ExecutionRunEntity>;
  let enqueue: jest.Mock;
  let service: ExecutionService;

  const state = {
    id: 'phase-1',
    userId: 'learner-1',
  } as PhaseStateEntity;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    runs = dataSource.getRepository(ExecutionRunEntity);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.manager.clear(ExecutionRunEntity);
    enqueue = jest.fn(async () => undefined);
    service = new ExecutionService(
      runs,
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      {} as ContentService,
      {} as SandboxService,
      { enqueue } as unknown as JobsService,
      {} as EventsGateway,
    );
  });

  it('refuses a phase that cannot run before any row exists, and queues nothing', async () => {
    const requirements: PhaseContent = {
      ...phaseWith(twoLayerCode),
      key: 'requirements',
      canRun: false,
    };

    await expect(service.runPhase(requirements, state)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.runPhase(requirements, state)).rejects.toThrow(NOTHING_TO_RUN);

    expect(await runs.count()).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still queues a run for a phase that can', async () => {
    const view = await service.runPhase(phaseWith(twoLayerCode), state);

    expect(view.status).toBe('queued');
    expect(await runs.count()).toBe(1);
    expect(enqueue).toHaveBeenCalledWith('run', { id: view.id, ownerId: 'learner-1' });
  });
});

/* --------------------------------- two runs -------------------------------- */

/**
 * The two-run branch of `executeForPhase`: a phase that
 * spans a Python API and a TypeScript front end declares two `checks.runs` and
 * gets two sandbox jobs, one after the other, merged into one result.
 *
 * The collaborators are stubs, because what is under test is the shape of the
 * jobs and the order they are sent in. The most important case in the file is
 * the first one: a phase with one run has to take a single job and get back
 * the sandbox's own result.
 */
const blankRun = (over: Partial<PhaseRun> & { id: string }): PhaseRun => ({
  language: 'python',
  harness: 'unittest',
  hiddenHarness: 'unittest',
  label: 'Tests',
  transform: false,
  testPaths: [],
  visibleTests: [],
  hiddenTestFiles: {},
  learnerTestFiles: [],
  referenceTestFiles: {},
  implFiles: {},
  supportFiles: {},
  ...over,
});

const phaseWith = (checks: PhaseChecks, files: ContentFileSpec[] = []): PhaseContent =>
  ({
    key: 'implementation',
    order: 3,
    title: 'Implementation',
    intro: '',
    artifactKind: 'code',
    language: 'python',
    canRun: true,
    canPreview: false,
    runLabel: 'Run tests',
    taskPanel: '',
    objectives: [],
    files,
    rubric: { passThreshold: 70, criteria: [] },
    checks,
    assistant: { systemPrompt: '', topics: [], progressive: [] },
  }) as unknown as PhaseContent;

const source = (path: string, content: string, editable = false): ContentFileSpec => ({
  path,
  content,
  editable,
  language: path.endsWith('.py') ? 'python' : 'typescript',
});

const passed = (label: string, over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  exitKind: 'ok',
  stdout: `${label} ran`,
  stderr: '',
  durationMs: 10,
  tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [{ name: label, status: 'passed' }] },
  ...over,
});

/** A sandbox that records the jobs it was given, and when each one ran. */
function recordingSandbox(results: RunResult[]) {
  const jobs: SandboxTestJob[] = [];
  const order: string[] = [];
  const queue = [...results];
  const sandbox = {
    execute: jest.fn(async (job: SandboxTestJob, _owner?: SandboxTraceOwner) => {
      jobs.push(job);
      const name = job.runId || 'only';
      order.push(`start ${name}`);
      // A real run takes time; the point of the assertion below is that the
      // second job is not sent until the first has come back.
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${name}`);
      return queue.shift() as RunResult;
    }),
  };
  return { sandbox, jobs, order };
}

/** Mirrors ContentService.executionFiles: the learner's copy wins where they have one. */
const contentStub = {
  executionFiles: (phase: PhaseContent, workspace: Record<string, string> | null) => {
    const files: Record<string, string> = {};
    for (const f of phase.files) {
      files[f.path] =
        f.editable && workspace && workspace[f.path] !== undefined ? workspace[f.path] : f.content;
    }
    return files;
  },
} as unknown as ContentService;

function executionService(sandbox: unknown): ExecutionService {
  return new ExecutionService(
    {} as Repository<ExecutionRunEntity>,
    {} as Repository<PhaseStateEntity>,
    {} as Repository<EnrollmentEntity>,
    contentStub,
    sandbox as SandboxService,
    {} as JobsService,
    {} as EventsGateway,
  );
}

const twoLayerCode: CodeChecks = {
  kind: 'code',
  editableTargets: ['api/repository/tasks.py', 'web/src/lib/overdue.ts'],
  visibleTests: ['tests/test_tasks_api.py', 'web/src/lib/overdue.test.ts'],
  hiddenTestFiles: {},
  solutionFiles: {},
  solutionSources: [],
  runs: [
    blankRun({
      id: 'api',
      label: 'API tests',
      harness: 'pytest',
      visibleTests: ['tests/test_tasks_api.py'],
    }),
    blankRun({
      id: 'web',
      label: 'Front end',
      language: 'typescript',
      harness: 'js',
      hiddenHarness: 'js',
      transform: true,
      visibleTests: ['web/src/lib/overdue.test.ts'],
    }),
  ],
};

describe('ExecutionService.executeForPhase, one run', () => {
  const oneRunCode: CodeChecks = {
    kind: 'code',
    editableTargets: ['tasktrackr/manager.py'],
    visibleTests: ['tests/test_visible.py'],
    hiddenTestFiles: {},
    solutionFiles: {},
    solutionSources: [],
    runs: [blankRun({ id: 'main', visibleTests: ['tests/test_visible.py'] })],
  };

  it('sends a one-run phase the plain job (no step id, transform or clock), and returns the runner’s own result', async () => {
    const result = passed('main');
    const { sandbox, jobs } = recordingSandbox([result]);
    const phase = phaseWith(oneRunCode, [
      source('tasktrackr/manager.py', '# scaffold', true),
      source('tests/test_visible.py', '# visible'),
    ]);

    const returned = await executionService(sandbox).executeForPhase(phase, {
      'tasktrackr/manager.py': '# mine',
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].files).toEqual({
      'tasktrackr/manager.py': '# mine',
      'tests/test_visible.py': '# visible',
    });
    expect(jobs[0].testPaths).toEqual(['tests/test_visible.py']);
    expect(jobs[0].language).toBe('python');
    // No step to group by, no transform to ask for, and no clock was pinned.
    expect(jobs[0].runId).toBeUndefined();
    expect(jobs[0].transform).toBeUndefined();
    expect(jobs[0].clock).toBeUndefined();
    // The runner's own result, not a merged copy of it.
    expect(returned).toBe(result);
    expect(returned).not.toHaveProperty('steps');
  });

  it('takes the day the learner pinned into the job', async () => {
    const { sandbox, jobs } = recordingSandbox([passed('main')]);
    await executionService(sandbox).executeForPhase(phaseWith(oneRunCode), null, '2026-03-01');
    expect(jobs[0].clock).toBe('2026-03-01');
  });

  it('refuses a phase whose checks carry no run at all', async () => {
    const { sandbox } = recordingSandbox([]);
    const phase = phaseWith({ ...oneRunCode, runs: [] });
    await expect(executionService(sandbox).executeForPhase(phase, null)).rejects.toThrow(
      'phase implementation declares no runs',
    );
  });

  it('still smokes a config phase, which has no runs and no merge', async () => {
    const { sandbox, jobs } = recordingSandbox([passed('smoke')]);
    const phase = phaseWith(
      {
        kind: 'config',
        rules: [],
        smokeImplFiles: { 'ops/selfcheck.py': '# checker', 'api/main.py': '# app' },
        smokeDockerfile: 'api/Dockerfile',
        smokeCommands: [['python3', 'api/main.py', '--selfcheck']],
        expectInOutput: 'selfcheck: ok',
      },
      [source('api/Dockerfile', 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT [\"python3\", \"api/main.py\"]\n')],
    );

    await executionService(sandbox).executeForPhase(phase, null);

    expect((jobs[0] as unknown as { mode: string }).mode).toBe('smoke');
    expect(jobs[0].runId).toBeUndefined();
  });
});

describe('config launcher evidence', () => {
  it.each(['FROM python:3.11-slim\n', 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT ["python3", "missing.py"]\n'])('does not substitute the authored selfcheck when the learner launcher is absent or invalid', async (dockerfile) => {
    const { sandbox, jobs } = recordingSandbox([passed('authored command')]);
    const phase = phaseWith({kind:'config',rules:[],smokeImplFiles:{'api/main.py':'# app'},smokeDockerfile:'api/Dockerfile',smokeCommands:[['python3','api/main.py','--selfcheck']],expectInOutput:'selfcheck: ok'}, [source('api/Dockerfile',dockerfile)]);
    const result = await executionService(sandbox).executeForPhase(phase, null);
    expect(jobs).toHaveLength(0);
    expect(result).toMatchObject({ok:false,exitKind:'error',durationMs:0});
    expect(result.stderr).toContain('Selfcheck did not run');
  });
});

describe('ExecutionService.executeForPhase, two runs', () => {
  it('passes the durable Run owner and content step IDs separately from source jobs', async () => {
    const { sandbox } = recordingSandbox([passed('api'), passed('web')]);
    const execute = jest.spyOn(sandbox, 'execute');
    const owner = '2d223774-3546-45de-83a7-c29b8db720af';
    await executionService(sandbox).executeForPhase(phaseWith(twoLayerCode), null, null, owner);
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      { kind: 'run', ownerId: owner, stepId: 'api' },
      { kind: 'run', ownerId: owner, stepId: 'web' },
    ]);
    for (const [job] of execute.mock.calls) expect(job).not.toHaveProperty('ownerId');
  });

  it('runs the layers one at a time, each collecting only its own visible tests', async () => {
    const { sandbox, jobs, order } = recordingSandbox([passed('api'), passed('web')]);
    const phase = phaseWith(twoLayerCode, [
      source('api/repository/tasks.py', '# api scaffold', true),
      source('tests/test_tasks_api.py', '# api tests'),
      source('web/src/lib/overdue.ts', '// web scaffold', true),
      source('web/src/lib/overdue.test.ts', '// web tests'),
    ]);

    await executionService(sandbox).executeForPhase(phase, null);

    // Sequential, so one learner's Run press holds one runner slot at a time.
    expect(order).toEqual(['start api', 'end api', 'start web', 'end web']);
    expect(jobs.map((j) => j.runId)).toEqual(['api', 'web']);
    expect(jobs.map((j) => j.testPaths)).toEqual([
      ['tests/test_tasks_api.py'],
      ['web/src/lib/overdue.test.ts'],
    ]);
    expect(jobs.map((j) => j.language)).toEqual(['python', 'typescript']);
    expect(jobs.map((j) => j.harness)).toEqual(['pytest', 'js']);
    expect(jobs[0].transform).toBeUndefined();
    expect(jobs[1].transform).toEqual({ tool: 'esbuild', jsx: 'automatic' });
    // Both layers are mounted for both runs: the front end's tests import the
    // component, and the API's fixtures import the repository.
    expect(Object.keys(jobs[0].files)).toEqual(Object.keys(jobs[1].files));
  });

  it('merges the two results through the seam, in the order the runs are declared', async () => {
    const first = passed('api');
    const second = passed('web');
    const { sandbox } = recordingSandbox([first, second]);
    const service = executionService(sandbox);
    const merged = passed('merged');
    service.mergeRuns = jest.fn(() => merged);

    const returned = await service.executeForPhase(phaseWith(twoLayerCode), null);

    expect(service.mergeRuns).toHaveBeenCalledTimes(1);
    expect(service.mergeRuns).toHaveBeenCalledWith([first, second], twoLayerCode.runs);
    expect(returned).toBe(merged);
  });

  it('gives a tests phase only the files its own run needs', async () => {
    const checks: TestsChecks = {
      kind: 'tests',
      learnerTestFiles: ['tests/test_acceptance.py', 'web/src/acceptance.test.tsx'],
      referenceTestFiles: {},
      implFiles: {
        'api/repository/tasks.py': '# reference api',
        'web/src/lib/overdue.ts': '// reference web',
      },
      mutants: [],
      coverageKeywords: [],
      minTests: 6,
      supportFiles: { 'tests/clock.py': '# clock', 'web/src/testing/clock.ts': '// clock' },
      runs: [
        blankRun({
          id: 'api',
          label: 'API tests',
          harness: 'pytest',
          learnerTestFiles: ['tests/test_acceptance.py'],
          implFiles: { 'api/repository/tasks.py': '# reference api' },
          supportFiles: { 'tests/clock.py': '# clock' },
        }),
        blankRun({
          id: 'web',
          label: 'Front end',
          language: 'typescript',
          harness: 'js',
          hiddenHarness: 'js',
          transform: true,
          learnerTestFiles: ['web/src/acceptance.test.tsx'],
          implFiles: { 'web/src/lib/overdue.ts': '// reference web' },
          supportFiles: { 'web/src/testing/clock.ts': '// clock' },
        }),
      ],
    };
    const { sandbox, jobs } = recordingSandbox([passed('api'), passed('web')]);
    const phase = phaseWith(checks, [
      source('tests/test_acceptance.py', '# scaffold', true),
      source('web/src/acceptance.test.tsx', '// scaffold', true),
      source('tests/clock.py', '# clock'),
      source('web/src/testing/clock.ts', '// clock'),
    ]);

    await executionService(sandbox).executeForPhase(phase, {
      'tests/test_acceptance.py': '# my python suite',
      'web/src/acceptance.test.tsx': '// my dom suite',
    });

    expect(jobs[0].files).toEqual({
      'tests/clock.py': '# clock',
      'api/repository/tasks.py': '# reference api',
      'tests/test_acceptance.py': '# my python suite',
    });
    expect(jobs[1].files).toEqual({
      'web/src/testing/clock.ts': '// clock',
      'web/src/lib/overdue.ts': '// reference web',
      'web/src/acceptance.test.tsx': '// my dom suite',
    });
    expect(jobs.map((j) => j.testPaths)).toEqual([
      ['tests/test_acceptance.py'],
      ['web/src/acceptance.test.tsx'],
    ]);
  });
});

describe('mergeRunResults', () => {
  const runs = twoLayerCode.runs;

  const api = (over: Partial<RunResult> = {}): RunResult => ({
    ok: true,
    exitKind: 'ok',
    stdout: '14 passed',
    stderr: '',
    durationMs: 900,
    tests: {
      total: 14,
      passed: 14,
      failed: 0,
      errored: 0,
      cases: [{ name: 'test_overdue', status: 'passed', step: 'api' } as TestCaseResult],
    },
    ...over,
  });

  const web = (over: Partial<RunResult> = {}): RunResult => ({
    ok: false,
    exitKind: 'ok',
    stdout: '',
    stderr: 'overdue.test.ts: expected 2, got 0',
    durationMs: 600,
    tests: {
      total: 8,
      passed: 0,
      failed: 8,
      errored: 0,
      cases: [{ name: 'renders the badge', status: 'failed', step: 'web' } as TestCaseResult],
    },
    ...over,
  });

  it('pools the cases of both runs and keeps them in the order the runs ran', () => {
    const merged = mergeRunResults([api(), web()], runs);

    expect(merged.ok).toBe(false);
    expect(merged.tests).toEqual({
      total: 22,
      passed: 14,
      failed: 8,
      errored: 0,
      cases: [
        { name: 'test_overdue', status: 'passed', step: 'api' },
        { name: 'renders the badge', status: 'failed', step: 'web' },
      ],
    });
    // The runs are sequential, so the durations add up rather than overlap.
    expect(merged.durationMs).toBe(1500);
  });

  it('writes one step per run, so the Tests pane can group by layer', () => {
    const merged = mergeRunResults([api(), web()], runs) as MergedRunResult;

    expect(merged.steps).toEqual([
      {
        id: 'api',
        label: 'API tests',
        ok: true,
        exitKind: 'ok',
        durationMs: 900,
        total: 14,
        passed: 14,
        failed: 0,
        errored: 0,
      },
      {
        id: 'web',
        label: 'Front end',
        ok: false,
        exitKind: 'ok',
        durationMs: 600,
        total: 8,
        passed: 0,
        failed: 8,
        errored: 0,
      },
    ]);
  });

  it('puts each run’s output under its own label, and says nothing for a run that printed nothing', () => {
    const merged = mergeRunResults([api(), web()], runs);

    expect(merged.stdout).toBe('API tests\n14 passed');
    expect(merged.stderr).toBe('Front end\noverdue.test.ts: expected 2, got 0');
  });

  it('leaves both outputs empty when neither run printed anything', () => {
    const quiet = { ...api(), stdout: '', stderr: '' };
    const merged = mergeRunResults([quiet, { ...web(), stdout: '', stderr: '' }], runs);

    expect(merged.stdout).toBe('');
    expect(merged.stderr).toBe('');
  });

  it('clips the merged output to one run’s worth', () => {
    const merged = mergeRunResults(
      [api({ stdout: 'x'.repeat(MERGED_OUTPUT_LIMIT) }), web({ stdout: 'y'.repeat(500) })],
      runs,
    );

    expect(merged.stdout.length).toBe(MERGED_OUTPUT_LIMIT + '\n… (truncated)'.length);
    expect(merged.stdout.endsWith('\n… (truncated)')).toBe(true);
  });

  it('takes the exit kind of the first run that did not finish cleanly', () => {
    const merged = mergeRunResults([api(), web({ exitKind: 'timeout' })], runs);
    expect(merged.exitKind).toBe('timeout');

    const both = mergeRunResults([api({ ok: false, exitKind: 'memory' }), web({ exitKind: 'timeout' })], runs);
    expect(both.exitKind).toBe('memory');
  });

  it('is ok, and exits ok, only when every run did', () => {
    const merged = mergeRunResults([api(), api()], runs);
    expect(merged.ok).toBe(true);
    expect(merged.exitKind).toBe('ok');
  });

  const outage: RunResult = {
    ok: false,
    exitKind: 'unavailable',
    stdout: '',
    stderr: '',
    durationMs: 40,
  };

  it('reports an outage in either layer as an outage, and counts nothing', () => {
    const merged = mergeRunResults([api(), outage], runs) as MergedRunResult;

    // A transport failure is not a verdict: the learner passed 14 of 14 in the
    // API, and pooling that into a score would grade an outage.
    expect(merged.exitKind).toBe('unavailable');
    expect(isRunnerUnavailable(merged)).toBe(true);
    expect(merged.tests).toBeUndefined();
    // The steps still say which layer went down.
    expect(merged.steps.map((s) => s.exitKind)).toEqual(['ok', 'unavailable']);
  });

  it('lets an outage anywhere win over a run that failed before it', () => {
    // Without this the merged result reads 'error' (the learner's own bug),
    // and the second layer, which never ran at all, is scored as zero.
    const merged = mergeRunResults([api({ ok: false, exitKind: 'error' }), outage], runs);

    expect(merged.exitKind).toBe('unavailable');
    expect(merged.tests).toBeUndefined();
  });
});

/* ------------------- the runner's own refusal sentence ------------------ */

/**
 * The runner's own sentence for a job the transport cannot run at all (a
 * TypeScript step on Lambda, where there is no node) is a permanent limit,
 * and "try again in a moment" was what a learner read for it. The rule: an
 * `unavailable` result with a non-empty stderr is the runner's sentence and
 * reaches the learner verbatim; an empty one is the transport failing, and
 * keeps the retry and the "try again" sentence.
 */
describe('mergeRunResults: the runner’s own sentence', () => {
  const runs = twoLayerCode.runs;
  const SENTENCE =
    'this transport cannot run JavaScript: there is no node here. The front-end half of a phase needs RUNNER_MODE=local or socket.';

  const apiOk: RunResult = {
    ok: true,
    exitKind: 'ok',
    stdout: '14 passed',
    stderr: '',
    durationMs: 900,
    tests: { total: 14, passed: 14, failed: 0, errored: 0, cases: [] },
  };
  const webCannotRun: RunResult = { ok: false, exitKind: 'unavailable', stdout: '', stderr: SENTENCE, durationMs: 0 };
  const webTransport: RunResult = { ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 40 };

  it('tells a permanent limit from a transport failure by the sentence the runner wrote', () => {
    expect(runnerSentence(webCannotRun)).toBe(SENTENCE);
    expect(isPermanentUnavailable(webCannotRun)).toBe(true);
    expect(unavailableSentence(webCannotRun)).toBe(SENTENCE);

    expect(runnerSentence(webTransport)).toBeNull();
    expect(isPermanentUnavailable(webTransport)).toBe(false);
    expect(unavailableSentence(webTransport)).toBe(RUNNER_UNAVAILABLE_MESSAGE);

    // A verdict is never a sentence, whatever its stderr says.
    expect(runnerSentence({ exitKind: 'error', stderr: 'AssertionError' })).toBeNull();
  });

  it('carries the sentence verbatim, unlabelled, and says which step was checked', () => {
    const merged = mergeRunResults([apiOk, webCannotRun], runs) as MergedRunResult;

    expect(merged.exitKind).toBe('unavailable');
    expect(merged.tests).toBeUndefined();
    expect(merged.stderr.startsWith(SENTENCE)).toBe(true);
    expect(merged.stderr).toContain('The API tests step was checked');
    expect(merged.stderr).toContain('the gate stays shut');
    // No "Front end" label over the sentence: it is prose the learner reads,
    // not a layer's output.
    expect(merged.stderr).not.toMatch(/^Front end\n/);
    expect(isPermanentUnavailable(merged)).toBe(true);
    expect(unavailableSentence(merged)).toBe(merged.stderr);
  });

  it('says nothing was scored when no step could run', () => {
    const merged = mergeRunResults([webCannotRun, webCannotRun], runs);
    expect(merged.stderr).toBe(`${SENTENCE} Nothing is scored, so the gate stays shut.`);
  });

  it('leaves stderr empty on a transient outage, so the try-again sentence is the one drawn', () => {
    const merged = mergeRunResults([apiOk, webTransport], runs);
    expect(merged.exitKind).toBe('unavailable');
    expect(merged.stderr).toBe('');
    expect(isPermanentUnavailable(merged)).toBe(false);
    expect(unavailableSentence(merged)).toBe(RUNNER_UNAVAILABLE_MESSAGE);
  });
});

describe('ExecutionService.processRun on a transport that cannot run a step', () => {
  let dataSource: DataSource;
  let runs: Repository<ExecutionRunEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let enrollments: Repository<EnrollmentEntity>;
  let execute: jest.Mock;
  let emitJob: jest.Mock;
  let service: ExecutionService;
  let state: PhaseStateEntity;

  const SENTENCE = 'this transport cannot run JavaScript: there is no node here.';
  const apiOk: RunResult = {
    ok: true,
    exitKind: 'ok',
    stdout: '14 passed',
    stderr: '',
    durationMs: 900,
    tests: { total: 14, passed: 14, failed: 0, errored: 0, cases: [] },
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    runs = dataSource.getRepository(ExecutionRunEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    enrollments = dataSource.getRepository(EnrollmentEntity);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.manager.clear(ExecutionRunEntity);
    await dataSource.manager.clear(PhaseStateEntity);
    await dataSource.manager.clear(EnrollmentEntity);
    const enrollment = await enrollments.save(
      enrollments.create({ userId: 'learner-1', projectSlug: 'tasktrackr' }),
    );
    state = await phaseStates.save(
      phaseStates.create({
        enrollmentId: enrollment.id,
        userId: 'learner-1',
        phaseKey: 'implementation',
        phaseOrder: 3,
        status: 'in_progress',
        workspace: null,
        ranBeforeSubmit: false,
      }),
    );
    execute = jest.fn();
    emitJob = jest.fn();
    const content = {
      getPhase: jest.fn(() => phaseWith(twoLayerCode)),
      // A Run resolves the phase through the enrolment. It delegates to the
      // same phase as `getPhase` here; which version a pin resolves is proved against two
      // really published versions in `workflow/pin.spec.ts`.
      getPhaseForEnrollment: jest.fn(() => phaseWith(twoLayerCode)),
      executionFiles: jest.fn(() => ({})),
    };
    service = new ExecutionService(
      runs,
      phaseStates,
      enrollments,
      content as unknown as ContentService,
      { execute } as unknown as SandboxService,
      { enqueue: jest.fn(), register: jest.fn() } as unknown as JobsService,
      { emitJob } as unknown as EventsGateway,
    );
  });

  const queued = async () =>
    runs.save(runs.create({ phaseStateId: state.id, userId: 'learner-1', kind: 'run', status: 'queued', inputSnapshot: { version: 1, workspace: {}, runClock: null, acceptedScreenCopy: null }, inputHash: runInputHash({ version: 1, workspace: {}, runClock: null, acceptedScreenCopy: null }) }));

  it('keeps the runner’s sentence on the failed row and does not ask the queue to retry', async () => {
    execute
      .mockResolvedValueOnce(apiOk)
      .mockResolvedValueOnce({ ok: false, exitKind: 'unavailable', stdout: '', stderr: SENTENCE, durationMs: 0 });
    const row = await queued();

    // Resolves: a retry would run the Python half again to hear the same
    // sentence from the same transport.
    await expect(service.processRun({ id: row.id })).resolves.toBeUndefined();

    const after = await runs.findOneByOrFail({ id: row.id });
    expect(after.status).toBe('failed');
    expect(after.result?.exitKind).toBe('unavailable');
    expect(after.result?.stderr.startsWith(SENTENCE)).toBe(true);
    expect(after.result?.tests).toBeUndefined();
    // Nothing ran to a verdict, so it is not a run before submit.
    expect((await phaseStates.findOneByOrFail({ id: state.id })).ranBeforeSubmit).toBe(false);
    expect(emitJob).toHaveBeenLastCalledWith('learner-1', expect.objectContaining({ id: row.id, status: 'failed' }));
  });

  it('still throws for the queue to retry when the transport itself failed, with an empty sentence on the row', async () => {
    execute
      .mockResolvedValueOnce(apiOk)
      .mockResolvedValueOnce({ ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 40 });
    const row = await queued();

    await expect(service.processRun({ id: row.id })).rejects.toThrow('the code runner was unavailable');

    const after = await runs.findOneByOrFail({ id: row.id });
    expect(after.status).toBe('failed');
    // The empty-stderr result is what makes the panel say "try again".
    expect(after.result?.exitKind).toBe('unavailable');
    expect(after.result?.stderr).toBe('');
  });
});
