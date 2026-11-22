import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { DrillState, PhaseKey, PhaseLink } from '@learnsdlc/shared';
import { EMPTY_STORY, INHERITED_TASK_KEY, RUNNER_UNAVAILABLE_MESSAGE, STORY_JSON, serialiseStory } from '@learnsdlc/shared';
import { API_CONTRACT_JSON, DEFAULT_DESIGN_FLOOR, DESIGN_JSON, EMPTY_DESIGN, SCREEN_CONTRACT_JSON, serialiseDesign } from '@learnsdlc/shared';
import { EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import { RunGate, SandboxBusyError } from '../execution/run-gate';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { RunnerUnavailableError, type FeedbackService, type SmokeCheckResult } from '../feedback/feedback.service';
import { fixtureQuizChecks, fixtureQuizRubric } from '../../test/quiz-fixture';
import { WorkflowService, type EnrolledPhaseSummary } from './workflow.service';
import { operationsFromDesign, summaryIntro } from './workflow-helpers';

const smokeOk = (over: Partial<SmokeCheckResult> = {}): SmokeCheckResult => ({
  ok: true,
  stdout: 'Ship the release',
  stderr: '',
  durationMs: 40,
  argv: ['python3', '/app/cli.py'],
  ...over,
});

const smokeFailed = (stderr: string): SmokeCheckResult =>
  smokeOk({ ok: false, stdout: '', stderr });

/** What `runSmokeCheck` throws when the sandbox could not be reached at all. */
const runnerDown = (): Error => new RunnerUnavailableError();

/** The drill as the column holds it: the view type plus the paged reading. */
type StoredDrill = DrillState & { pagedExit?: number | null };

/*
 * The deployment phase's fault, its faulted file and the
 * file the learner edits all come off the pack rather than out of this file.
 * A pack that renames its drill or moves its Dockerfile moves these with it;
 * a hard-coded literal here would have to be found by hand.
 */
const deployment = (content: ContentService) =>
  content.getPhase('tasktrackr', 'deployment').checks as {
    kind: 'config';
    smokeDockerfile: string;
    drill: { fault: string; faultedFiles: Record<string, unknown> };
  };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('operationsFromDesign', () => {
  it('reads the operations a learner wrote, keeping the fields they filled in', () => {
    const source = JSON.stringify({
      fields: [{ name: 'id' }],
      operations: [
        { name: 'complete_task(task_id)', satisfies: 'US-2', returns: 'the updated task' },
        { name: 'overdue_tasks(today)', boundary: 'due today is not overdue' },
      ],
      decisions: [{ id: 'D1' }],
    });
    expect(operationsFromDesign(source)).toEqual([
      { name: 'complete_task(task_id)', satisfies: 'US-2', returns: 'the updated task' },
      { name: 'overdue_tasks(today)', boundary: 'due today is not overdue' },
    ]);
  });

  it('accepts a bare array, and a string list such as satisfies', () => {
    const source = JSON.stringify([{ name: 'filter_tasks()', satisfies: ['US-3', 'US-4'] }]);
    expect(operationsFromDesign(source)).toEqual([
      { name: 'filter_tasks()', satisfies: ['US-3', 'US-4'] },
    ]);
  });

  it('drops entries with nothing that names an operation, and non-string values', () => {
    const source = JSON.stringify({
      operations: [
        { returns: 'a list' },
        { name: '  ' },
        'complete_task',
        { name: 'overdue_tasks(today)', complexity: 7, nested: { a: 1 } },
      ],
    });
    expect(operationsFromDesign(source)).toEqual([{ name: 'overdue_tasks(today)' }]);
  });

  it('yields nothing from a half-typed edit rather than throwing', () => {
    expect(operationsFromDesign('{"operations": [')).toEqual([]);
    expect(operationsFromDesign('')).toEqual([]);
    expect(operationsFromDesign(null)).toEqual([]);
    expect(operationsFromDesign('{"operations": 3}')).toEqual([]);
  });

  it('stops at fifty operations', () => {
    const operations = Array.from({ length: 80 }, (_, i) => ({ name: `op_${i}()` }));
    expect(operationsFromDesign(JSON.stringify({ operations }))).toHaveLength(50);
  });
});

describe('WorkflowService', () => {
  let dataSource: DataSource;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let releases: Repository<ReleaseRecordEntity>;
  let content: ContentService;
  let service: WorkflowService;
  let runSmokeCheck: jest.Mock;

  const learner = 'learner-1';
  const bystander = 'learner-2';

  /** Enrol, then hand back the phase state ids by key. */
  const enrol = async (userId = learner): Promise<Record<string, string>> => {
    const view = await service.enroll(userId, 'tasktrackr');
    return Object.fromEntries(view.phases.map((p) => [p.key, p.id]));
  };

  /** A phase the learner can act on: unlocked, and optionally already passed. */
  const open = async (id: string, over: Partial<PhaseStateEntity> = {}): Promise<PhaseStateEntity> => {
    const state = await phaseStates.findOneByOrFail({ id });
    Object.assign(state, { status: 'in_progress', ...over });
    const saved = await phaseStates.save(state);
    if (over.status === 'passed') {
      const phase = content.getPhase('tasktrackr', state.phaseKey);
      await dataSource.getRepository(SubmissionEntity).save({ userId: state.userId, phaseStateId: id, status: 'completed', passed: true, workspaceSnapshot: { fixture: 'workflow authority test evidence', ...(state.phaseKey === 'design' ? { 'shared/contract/screens.json': JSON.stringify({ screens: [{ route: '#/overdue', title: 'Overdue', empty: 'No overdue tasks.' }] }) } : {}) }, contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null }, report: {
        assessmentMode: 'strict_binary', passed: true, checks: [{ id: 'fixture', label: 'Mocked assessment fixture', status: 'passed', detail: 'The workflow test isolates persisted gate authority.' }], tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
        aiReview: { provider: 'mock-ai', verdict: 'pass', criteriaEvidence: phase.rubric.criteria.map(c => ({ key: c.key, met: true, evidence: 'Fixture evidence for workflow gate only, not real AI validation.', issue: '', nextStep: '' })) },
      } as any });
    }
    return saved;
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    releases = dataSource.getRepository(ReleaseRecordEntity);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    runSmokeCheck = jest.fn(async () => smokeOk());
    const feedback = {
      latestFor: async () => null,
      runSmokeCheck,
    } as unknown as FeedbackService;
    service = new WorkflowService(
      enrollments,
      phaseStates,
      releases,
      content,
      feedback,
      dataSource,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('links', () => {
    it('stores the set the learner sent, and returns it on the phase', async () => {
      const ids = await enrol();
      const saved = await service.saveLinks(learner, ids.requirements, [
        { from: 'test_add_assigns_ids', to: 'US-1/AC-1', kind: 'verifies' },
        { from: 'test_complete_twice', to: 'US-2/AC-2', kind: 'covers' },
      ]);

      expect(saved.map((l) => [l.from, l.to, l.kind])).toEqual([
        ['test_add_assigns_ids', 'US-1/AC-1', 'verifies'],
        ['test_complete_twice', 'US-2/AC-2', 'covers'],
      ]);
      const detail = await service.phaseDetail(learner, ids.requirements);
      expect(detail.links).toEqual(saved);
    });

    it('stamps its own timestamp, and keeps one a client replayed', async () => {
      const ids = await enrol();
      const before = Date.now();
      const [stamped, replayed] = await service.saveLinks(learner, ids.requirements, [
        { from: 'a', to: 'US-1', kind: 'verifies' },
        { from: 'b', to: 'US-2', kind: 'verifies', at: '2026-09-01T10:00:00.000Z' },
      ]);

      expect(Date.parse(stamped.at)).toBeGreaterThanOrEqual(before);
      expect(replayed.at).toBe('2026-09-01T10:00:00.000Z');
    });

    it('replaces its own timestamp when the client sends something unparseable', async () => {
      const ids = await enrol();
      const [link] = await service.saveLinks(learner, ids.requirements, [
        { from: 'a', to: 'US-1', kind: 'verifies', at: 'yesterday-ish' },
      ]);
      expect(Number.isNaN(Date.parse(link.at))).toBe(false);
    });

    it('replaces the whole set, so removing a link is as easy as making one', async () => {
      const ids = await enrol();
      await service.saveLinks(learner, ids.requirements, [
        { from: 'a', to: 'US-1', kind: 'verifies' },
        { from: 'b', to: 'US-2', kind: 'verifies' },
      ]);
      const kept = await service.saveLinks(learner, ids.requirements, [
        { from: 'b', to: 'US-2', kind: 'verifies' },
      ]);
      expect(kept).toHaveLength(1);
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).links).toHaveLength(1);
    });

    it('drops a kind it does not know, however it reached the service', async () => {
      const ids = await enrol();
      const saved = await service.saveLinks(learner, ids.requirements, [
        { from: 'a', to: 'US-1', kind: 'proves' as unknown as PhaseLink['kind'] },
        { from: 'b', to: 'US-2', kind: 'covers' },
      ]);
      expect(saved.map((l) => l.from)).toEqual(['b']);
    });

    it('drops a blank end and counts the same claim once', async () => {
      const ids = await enrol();
      const saved = await service.saveLinks(learner, ids.requirements, [
        { from: '  ', to: 'US-1', kind: 'verifies' },
        { from: 'a', to: '', kind: 'verifies' },
        { from: ' a ', to: 'US-1', kind: 'verifies' },
        { from: 'a', to: 'US-1', kind: 'verifies' },
        { from: 'a', to: 'US-1', kind: 'covers' },
      ]);
      expect(saved.map((l) => `${l.from} ${l.kind}`)).toEqual(['a verifies', 'a covers']);
    });

    it('refuses more links than a phase holds, and stores nothing', async () => {
      const ids = await enrol();
      const many = Array.from({ length: 201 }, (_, i) => ({
        from: `t${i}`,
        to: 'US-1',
        kind: 'verifies' as const,
      }));
      await expect(service.saveLinks(learner, ids.requirements, many)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).links).toBeNull();
    });

    it('refuses an end that is prose or markup rather than an id, and stores nothing', async () => {
      const ids = await enrol();
      const refused = [
        // The criterion end is an id, so anything with markup, a scheme or a space is out.
        { from: 'test_add_assigns_ids', to: '<img src=x onerror=alert(1)>', kind: 'verifies' as const },
        { from: 'test_add_assigns_ids', to: 'javascript:alert(1)', kind: 'verifies' as const },
        { from: 'test_add_assigns_ids', to: 'US-1 and US-2', kind: 'verifies' as const },
        // The test end may be a sentence, but never markup or a second line.
        { from: '<img src=x onerror=alert(1)>', to: 'US-1/AC-1', kind: 'verifies' as const },
        { from: 'a late task\nwears the badge', to: 'US-1/AC-1', kind: 'verifies' as const },
        { from: 'a late task\u0007wears the badge', to: 'US-1/AC-1', kind: 'verifies' as const },
      ];
      for (const link of refused) {
        await expect(service.saveLinks(learner, ids.requirements, [link])).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).links).toBeNull();
    });

    it('keeps every shape a real link has: a unittest case, a front-end sentence, a bare criterion', async () => {
      const ids = await enrol();
      const saved = await service.saveLinks(learner, ids.requirements, [
        { from: 'TaskManagerTests.test_add_assigns_ids', to: 'US-1/AC-1', kind: 'verifies' },
        { from: "a late task wears the badge, even when it's due today.", to: 'AC-2', kind: 'verifies' },
        { from: 'fn:overdue', to: 'US-3', kind: 'covers' },
      ]);
      expect(saved).toHaveLength(3);
    });

    it('refuses a phase that is not the caller´s, and one still locked', async () => {
      const ids = await enrol();
      const link = [{ from: 'a', to: 'US-1', kind: 'verifies' as const }];
      await expect(service.saveLinks(bystander, ids.requirements, link)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.saveLinks(learner, ids.design, link)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('the incident drill', () => {
    let ids: Record<string, string>;

    const INCIDENT = {
      rootCause: 'WORKDIR was /srv while the ENTRYPOINT started /app/cli.py.',
      fix: 'Pointed the ENTRYPOINT at the working directory the image builds into.',
      actionItem: 'Add a smoke run of the built image to CI before every release.',
    };

    /**
     * Page the learner the way the pack guarantees: the faulted copy does not
     * start (`expectFailure` is declared and content.spec proves it), so the
     * run the drill opens with is red.
     */
    const page = async (stderr = "python3: can´t open file '/app/cli.py': No such file") => {
      runSmokeCheck.mockResolvedValueOnce(smokeFailed(stderr));
      return service.drillStart(learner, ids.deployment);
    };

    const storedDrill = async (): Promise<StoredDrill> =>
      (await phaseStates.findOneByOrFail({ id: ids.deployment })).drill as StoredDrill;

    beforeEach(async () => {
      ids = await enrol();
      await open(ids.deployment);
    });

    it('pages the learner with the failure the faulted container produced', async () => {
      runSmokeCheck.mockResolvedValueOnce(
        smokeFailed("python3: can't open file '/app/cli.py': No such file or directory"),
      );

      const drill = await service.drillStart(learner, ids.deployment);
      const checks = deployment(content);
      expect(drill.fault).toBe(checks.drill.fault);
      expect(drill.beforeStderr).toContain('/app/cli.py');
      expect(drill.resolvedAt).toBeNull();
      expect(drill.incident).toBeNull();

      // The check ran against the pack's faulted copy, not the learner's file.
      const [, files] = runSmokeCheck.mock.calls[0];
      const faulted = Object.keys(checks.drill.faultedFiles);
      expect(faulted.length).toBeGreaterThan(0);
      const shipped = content.executionFiles(
        content.getPhase('tasktrackr', 'deployment'),
        null,
      );
      for (const path of faulted) {
        expect(files[path]).toEqual(expect.any(String));
        expect(files[path]).not.toBe(shipped[path]);
      }
    });

    it('keeps no runbook text at paging: TaskTrackr 5.0.0\'s runbook is the record, and its incident is written into it', async () => {
      await open(ids.deployment, { workspace: { [RUNBOOK_JSON]: serialiseRunbook(EMPTY_RUNBOOK) } });
      const drill = await service.drillStart(learner, ids.deployment);
      expect(drill.runbookBefore).toBeNull();
    });

    it('stores nothing of the faulted copy in the workspace', async () => {
      await service.drillStart(learner, ids.deployment);
      const state = await phaseStates.findOneByOrFail({ id: ids.deployment });
      expect(state.workspace).toBeNull();
    });

    it('re-runs the check on a second page without erasing an incident in progress', async () => {
      const first = await service.drillStart(learner, ids.deployment);
      await service.drillHealth(learner, ids.deployment);
      runSmokeCheck.mockResolvedValueOnce(smokeFailed('exited with 2'));

      const again = await service.drillStart(learner, ids.deployment);
      expect(again.pagedAt).toBe(first.pagedAt);
      expect(again.healthRanAt).not.toBeNull();
      expect(again.beforeStderr).toBe('exited with 2');
    });

    it('will not run a health check before the learner is paged', async () => {
      await expect(service.drillHealth(learner, ids.deployment)).rejects.toThrow(
        /start the drill/,
      );
      expect(runSmokeCheck).not.toHaveBeenCalled();
    });

    it('records a failing health check as exit 1, against the learner´s own files', async () => {
      const mine = 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT ["python3", "api/main.py"]\n';
      const dockerfile = deployment(content).smokeDockerfile;
      await open(ids.deployment, { workspace: { [dockerfile]: mine } });
      await page();
      runSmokeCheck.mockResolvedValueOnce(smokeFailed('no such file'));

      const health = await service.drillHealth(learner, ids.deployment);
      // startedBy is the command the check ran, so the panel can label the
      // output with what produced it.
      expect(health).toEqual({
        exit: 1,
        stdout: '',
        stderr: 'no such file',
        startedBy: 'python3 /app/cli.py',
      });

      const state = await phaseStates.findOneByOrFail({ id: ids.deployment });
      expect(state.drill?.healthExit).toBe(1);
      expect(state.drill?.healthRanAt).not.toBeNull();
      expect(state.drill?.fixAppliedAt).toBeNull();

      // The learner's own Dockerfile, not the pack's faulted copy.
      const [, files] = runSmokeCheck.mock.calls[1];
      expect(files[dockerfile]).toBe(mine);
    });

    it('dates the fix from the first green health check, not from the write-up', async () => {
      await page();
      const health = await service.drillHealth(learner, ids.deployment);
      expect(health.exit).toBe(0);

      const applied = (await storedDrill()).fixAppliedAt;
      expect(applied).not.toBeNull();

      const resolved = await service.drillResolve(learner, ids.deployment, INCIDENT);
      expect(resolved.fixAppliedAt).toBe(applied);
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it('reports a Dockerfile that never yields a command as a failure with the reason', async () => {
      await service.drillStart(learner, ids.deployment);
      runSmokeCheck.mockResolvedValueOnce(
        smokeOk({ ok: false, stdout: '', stderr: '', argv: [], problem: 'no ENTRYPOINT or CMD yet' }),
      );
      const health = await service.drillHealth(learner, ids.deployment);
      // No argv means no command was found, so there is nothing to label with.
      expect(health).toEqual({
        exit: 1,
        stdout: '',
        stderr: 'no ENTRYPOINT or CMD yet',
        startedBy: '',
      });
    });

    it('refuses to close an incident over a container that still does not start', async () => {
      await page();
      runSmokeCheck.mockResolvedValueOnce(
        smokeFailed("python3: can't open file '/app/cli.py': No such file"),
      );

      const closing = service.drillResolve(learner, ids.deployment, {
        rootCause: 'The working directory did not match the entrypoint path.',
        fix: 'I changed the ENTRYPOINT to match the WORKDIR the image uses.',
        actionItem: 'Smoke the image in CI so this cannot ship again.',
      });
      await expect(closing).rejects.toBeInstanceOf(ConflictException);
      await expect(closing).rejects.toThrow(/can´t open file|can't open file/);

      const state = await phaseStates.findOneByOrFail({ id: ids.deployment });
      expect(state.drill?.resolvedAt).toBeNull();
      expect(state.drill?.incident).toBeNull();
    });

    it('closes the incident once the container starts, keeping the three answers', async () => {
      await page();
      await service.drillHealth(learner, ids.deployment);
      const drill = await service.drillResolve(learner, ids.deployment, {
        rootCause: '  WORKDIR was /srv while the ENTRYPOINT started /app/cli.py.  ',
        fix: 'Pointed the ENTRYPOINT at /srv/cli.py so both agree.',
        actionItem: 'Add a container smoke step to CI before the release job.',
      });

      expect(drill.resolvedAt).not.toBeNull();
      expect(drill.incident?.rootCause).toBe(
        'WORKDIR was /srv while the ENTRYPOINT started /app/cli.py.',
      );
      const detail = await service.phaseDetail(learner, ids.deployment);
      expect(detail.drill?.incident?.actionItem).toContain('smoke step');
    });

    it('records what the paged run said, so the red the drill opens with is a fact', async () => {
      await page();
      expect((await storedDrill()).pagedExit).toBe(1);
      // Nothing of the learner's own state is claimed by the page: the health
      // reading is still empty, and the fix is undated.
      const drill = await storedDrill();
      expect(drill.healthRanAt).toBeNull();
      expect(drill.fixAppliedAt).toBeNull();
    });

    it('will not close an incident the learner never checked, though their container starts', async () => {
      // The pack tells the learner to start the drill with their build check
      // already green, so this is the ordinary case rather than the unlucky
      // one: the container starts, and closing INCIDENT-1 off the page would
      // prove nothing.
      await page();

      const closing = service.drillResolve(learner, ids.deployment, INCIDENT);
      await expect(closing).rejects.toBeInstanceOf(ConflictException);
      await expect(closing).rejects.toThrow(/from failing to passing/);
      const refused = await storedDrill();
      expect(refused.resolvedAt).toBeNull();
      expect(refused.incident).toBeNull();

      // One health check against their own files is what the phase asks for,
      // and it is enough: their Dockerfile was never touched to arrange it.
      const health = await service.drillHealth(learner, ids.deployment);
      expect(health.exit).toBe(0);
      const closed = await service.drillResolve(learner, ids.deployment, INCIDENT);
      expect(closed.resolvedAt).not.toBeNull();
      expect(closed.fixAppliedAt).not.toBeNull();
    });

    it('will not date a fix from a check that was green from the first moment', async () => {
      // The faulted copy started, so nothing was ever red and there is no
      // incident to close. A drill in that state is a broken pack, not a
      // learner who fixed something.
      await service.drillStart(learner, ids.deployment);
      expect((await storedDrill()).pagedExit).toBe(0);

      const health = await service.drillHealth(learner, ids.deployment);
      expect(health.exit).toBe(0);
      expect((await storedDrill()).fixAppliedAt).toBeNull();
      await expect(service.drillResolve(learner, ids.deployment, INCIDENT)).rejects.toThrow(
        /from failing to passing/,
      );
    });

    it.each([
      ['the health check writes first', 10, 60],
      ['the write-up writes first', 60, 10],
    ])('keeps both writes when a health check and a write-up land together, %s', async (
      _order,
      healthMs,
      resolveMs,
    ) => {
      await page();
      await service.drillHealth(learner, ids.deployment); // green: the fix is dated
      expect((await storedDrill()).fixAppliedAt).not.toBeNull();

      // Two buttons on one panel, both running a container check that takes
      // seconds. The learner pressed the check once more while the write-up
      // was in flight and this time it came back red, so each write changes a
      // field the other's copy of the drill still holds the old value of.
      runSmokeCheck
        .mockImplementationOnce(async () => {
          await sleep(healthMs);
          return smokeFailed('the container stopped again');
        })
        .mockImplementationOnce(async () => {
          await sleep(resolveMs);
          return smokeOk();
        });

      await Promise.all([
        service.drillHealth(learner, ids.deployment),
        service.drillResolve(learner, ids.deployment, INCIDENT),
      ]);

      const drill = await storedDrill();
      expect(drill.healthExit).toBe(1);
      expect(drill.resolvedAt).not.toBeNull();
      // a phase with the runbook record keeps the incident in the record, never on the drill
      const workspace = (await phaseStates.findOneByOrFail({ id: ids.deployment })).workspace ?? {};
      expect(validateRunbookRecord(workspace[RUNBOOK_JSON]).runbook?.incident.rootCause).toBe(INCIDENT.rootCause);
    });

    it('answers every health check when the runner is saturated, and writes nothing for the refusals', async () => {
      await page();
      const before = await storedDrill();

      // One slot and a short deadline, which is what a laptop running a class
      // at RUNNER_SLOTS=1 looks like: the gate refuses rather than holding the
      // request open, and sandbox.service turns that refusal into the same
      // unavailable outcome as an absent runner.
      const gate = new RunGate(1, { maxWaitMs: 120, maxWaiting: 200 });
      runSmokeCheck.mockImplementation(() =>
        gate
          .run(async () => {
            await sleep(40);
            return smokeOk();
          })
          .catch((err) => {
            if (err instanceof SandboxBusyError) throw runnerDown();
            throw err;
          }),
      );

      const started = Date.now();
      const answers = await Promise.allSettled(
        Array.from({ length: 10 }, () => service.drillHealth(learner, ids.deployment)),
      );
      const elapsed = Date.now() - started;

      expect(answers).toHaveLength(10);
      const refused = answers.filter((a) => a.status === 'rejected');
      expect(refused.length).toBeGreaterThan(0);
      expect(answers.filter((a) => a.status === 'fulfilled').length).toBeGreaterThan(0);
      // A 503 the learner is told to retry, never a 500 with no explanation.
      for (const answer of refused) {
        const reason = (answer as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(ServiceUnavailableException);
        expect(String(reason.message)).toBe(RUNNER_UNAVAILABLE_MESSAGE);
      }
      // Every one of them answered inside the gate's own deadline plus a run.
      expect(elapsed).toBeLessThan(2000);

      // A run that never happened is not a verdict about the learner's
      // container: the refusals wrote nothing at all.
      const drill = await storedDrill();
      expect(drill.healthExit).toBe(0);
      expect(drill.pagedExit).toBe(before.pagedExit);
    });

    it('answers a runner that cannot be reached with a 503 on all three routes', async () => {
      runSmokeCheck.mockRejectedValueOnce(runnerDown());
      await expect(service.drillStart(learner, ids.deployment)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // Nothing was paged, so there is no half-open incident to explain.
      expect(await phaseStates.findOneByOrFail({ id: ids.deployment })).toMatchObject({
        drill: null,
      });

      await page();
      runSmokeCheck.mockRejectedValueOnce(runnerDown());
      await expect(service.drillHealth(learner, ids.deployment)).rejects.toThrow(
        RUNNER_UNAVAILABLE_MESSAGE,
      );
      runSmokeCheck.mockRejectedValueOnce(runnerDown());
      await expect(
        service.drillResolve(learner, ids.deployment, INCIDENT),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const drill = await storedDrill();
      expect(drill.healthRanAt).toBeNull();
      expect(drill.resolvedAt).toBeNull();
    });

    it('refuses every drill route on a phase that declares no drill', async () => {
      const incident = {
        rootCause: 'x'.repeat(30),
        fix: 'y'.repeat(30),
        actionItem: 'z'.repeat(30),
      };
      await expect(service.drillStart(learner, ids.requirements)).rejects.toThrow(
        /no incident drill/,
      );
      await expect(service.drillHealth(learner, ids.requirements)).rejects.toThrow(
        /no incident drill/,
      );
      await expect(
        service.drillResolve(learner, ids.requirements, incident),
      ).rejects.toThrow(/no incident drill/);
      expect(runSmokeCheck).not.toHaveBeenCalled();
    });

    it('refuses a drill on a phase belonging to someone else', async () => {
      await expect(service.drillStart(bystander, ids.deployment)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('releases', () => {
    const merge = 'Wrote every acceptance criterion as given/when/then, and cut the vague one.';

    it('records the merge when a phase advances, and reads it back on the enrolment', async () => {
      const ids = await enrol();
      await open(ids.requirements, { status: 'passed', bestScore: 82, reflection: merge });

      const view = await service.advance(learner, ids.requirements);
      expect(view.releases).toHaveLength(1);
      expect(view.releases?.[0]).toMatchObject({
        version: 'v1',
        phaseKey: 'requirements',
        phaseOrder: 1,
        score: 82,
        notes: merge,
      });
    });

    /**
     * The reflection is not a gate. `advance` does not read it; the gate is
     * strict evidence: a passed phase can advance with a blank optional
     * reflection, and a reflection the learner starts is still held to the
     * minimum length. A client posting an
     * empty reflection to `/reflect` meets a 400, because the floor is about a
     * reflection somebody wrote, so the rule stays, and this pins the
     * half of it the client has to rely on.
     */
    it('advances a passed phase nobody reflected on, and records no merge message', async () => {
      const ids = await enrol();
      await open(ids.requirements, { status: 'passed', bestScore: 82 });

      const view = await service.advance(learner, ids.requirements);
      expect(view.releases?.[0]).toMatchObject({ phaseKey: 'requirements', notes: null });
      expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('in_progress');
    });

    it('rejects a claimed strict pass without its original execution context', async () => {
      const ids = await enrol();
      await open(ids.requirements, { status: 'passed' });
      await dataSource.manager.update(SubmissionEntity, { phaseStateId: ids.requirements }, { contextSnapshot: null });
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');
      expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('locked');
      expect(await releases.count()).toBe(0);
    });

    it('writes one record however many times advance is called', async () => {
      const ids = await enrol();
      await open(ids.requirements, { status: 'passed', bestScore: 82, reflection: merge });

      await service.advance(learner, ids.requirements);
      await service.advance(learner, ids.requirements);
      await service.advance(learner, ids.requirements);
      expect(await releases.count({ where: { enrollmentId: (await releases.find())[0].enrollmentId } })).toBe(1);
    });

    it('lists the releases oldest first', async () => {
      const ids = await enrol();
      await open(ids.requirements, { status: 'passed', bestScore: 70, reflection: merge });
      await service.advance(learner, ids.requirements);
      await open(ids.design, { status: 'passed', bestScore: 91, reflection: merge });
      const view = await service.advance(learner, ids.design);

      expect(view.releases?.map((r) => r.version)).toEqual(['v1', 'v2']);
      expect(view.releases?.map((r) => r.score)).toEqual([70, 91]);
    });

    it('records the last phase too, when all six strict reviews pass', async () => {
      const ids = await enrol();
      for (const id of Object.values(ids)) await open(id, { status: 'passed' });
      await open(ids.maintenance, { status: 'passed', bestScore: 88, reflection: merge });
      const enrollment = await dataSource.manager.findOneByOrFail(EnrollmentEntity, {
        userId: learner,
      });
      enrollment.currentPhaseOrder = 6;
      await dataSource.manager.save(enrollment);

      const view = await service.advance(learner, ids.maintenance);
      expect(view.completed).toBe(true);
      expect(view.releases?.map((r) => r.version)).toEqual(['v6']);
    });

    it('leaves an enrolment with nothing merged an empty list, not undefined', async () => {
      await enrol();
      const view = await service.myEnrollment(learner, 'tasktrackr');
      expect(view?.releases).toEqual([]);
    });
  });

  describe('the maintenance unlock', () => {
    const merge = 'Shipped the container and wrote the runbook, including INCIDENT-1.';

    /** Advance deployment so maintenance unlocks, with `design.json` as given. */
    const unlockMaintenance = async (designJson: string | null): Promise<PhaseStateEntity> => {
      const ids = await enrol();
      if (designJson !== null) {
        await open(ids.design, { workspace: { 'design/design.json': designJson } });
      }
      await open(ids.deployment, { status: 'passed', bestScore: 90, reflection: merge });
      const enrollment = await dataSource.manager.findOneByOrFail(EnrollmentEntity, {
        userId: learner,
      });
      enrollment.currentPhaseOrder = 5;
      await dataSource.manager.save(enrollment);
      await service.advance(learner, ids.deployment);
      return phaseStates.findOneByOrFail({ id: ids.maintenance });
    };

    it('seeds contracts.json from the operations the learner designed', async () => {
      const design = JSON.stringify({
        operations: [
          { name: 'complete_task(task_id)', satisfies: 'US-2', returns: 'the updated task' },
          { name: 'overdue_tasks(today)', boundary: 'due today is not overdue' },
        ],
      });
      const state = await unlockMaintenance(design);

      expect(state.status).toBe('in_progress');
      const seeded = JSON.parse(state.workspace!['design/contracts.json']);
      expect(seeded.operations).toHaveLength(2);
      expect(seeded.operations[0]).toEqual({
        name: 'complete_task(task_id)',
        satisfies: 'US-2',
        returns: 'the updated task',
      });
      // Written the way a learner would write it: readable, newline-terminated.
      expect(state.workspace!['design/contracts.json'].endsWith('\n')).toBe(true);
    });

    it('leaves the scaffold alone when the design record was never filled in', async () => {
      const state = await unlockMaintenance(null);
      expect(state.workspace?.['design/contracts.json']).toBeUndefined();
    });

    it('leaves the scaffold alone when the design record does not parse', async () => {
      const state = await unlockMaintenance('{"operations": [ {');
      expect(state.workspace?.['design/contracts.json']).toBeUndefined();
    });

    it('never overwrites contracts the learner has already written', async () => {
      const ids = await enrol();
      await open(ids.design, {
        workspace: {
          'design/design.json': JSON.stringify({ operations: [{ name: 'complete_task(id)' }] }),
        },
      });
      await open(ids.maintenance, {
        status: 'locked',
        workspace: { 'design/contracts.json': '{"operations": [{"name": "mine()"}]}' },
      });
      await open(ids.deployment, { status: 'passed', bestScore: 90, reflection: merge });
      const enrollment = await dataSource.manager.findOneByOrFail(EnrollmentEntity, {
        userId: learner,
      });
      enrollment.currentPhaseOrder = 5;
      await dataSource.manager.save(enrollment);

      await service.advance(learner, ids.deployment);
      const state = await phaseStates.findOneByOrFail({ id: ids.maintenance });
      expect(state.workspace!['design/contracts.json']).toContain('mine()');
    });

    it('seeds nothing at any other unlock', async () => {
      const ids = await enrol();
      await open(ids.design, {
        workspace: {
          'design/design.json': JSON.stringify({ operations: [{ name: 'complete_task(id)' }] }),
        },
      });
      await open(ids.requirements, { status: 'passed', bestScore: 80, reflection: merge });
      await service.advance(learner, ids.requirements);

      const design = await phaseStates.findOneByOrFail({ id: ids.design });
      expect(Object.keys(design.workspace || {})).toEqual(['design/design.json']);
    });
  });

  describe('a write that lands while a request is in flight', () => {
    // Requirements' one file is the story record; a draft is a record titled with the draft's words
    const STORY = STORY_JSON;
    const rec = (title: string): string => serialiseStory({ ...EMPTY_STORY, title });

    it('accepts exactly one concurrent first save with the public null revision and preserves the winner', async () => {
      const ids = await enrol();
      const detail = await service.phaseDetail(learner, ids.requirements);
      expect(detail.workspaceUpdatedAt).toBeNull();
      const saves = await Promise.allSettled(['draft A', 'draft B'].map(text => service.saveWorkspace(learner, ids.requirements, { [STORY]: rec(text) }, detail.workspaceUpdatedAt)));
      const winners = saves.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkflowService['saveWorkspace']>>> => result.status === 'fulfilled');
      const rejected = saves.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      let persisted = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(persisted.workspace).toEqual(winners[0].value.workspace);
      expect(persisted.workspaceUpdatedAt).toBe(winners[0].value.version);
      await expect(service.saveWorkspace(learner, ids.requirements, { [STORY]: rec('stale initial write') }, null)).rejects.toBeInstanceOf(ConflictException);
      persisted = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(persisted.workspace).toEqual(winners[0].value.workspace);
      // An omitted revision keeps the existing compatibility behaviour.
      await service.saveWorkspace(learner, ids.requirements, { [STORY]: rec('legacy caller') });
      expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).workspace?.[STORY]).toBe(rec('legacy caller'));
    });

    /**
     * The race the 700 ms autosave lives in: the request reads the phase
     * state, a grading lands while the request is still doing its work, and
     * then the request writes back. Hooked onto the read the service itself
     * makes, so the verdict lands inside that window every time rather than
     * near it.
     */
    const gradeAfterLoad = (verdict: Partial<PhaseStateEntity>): void => {
      const read = phaseStates.findOne.bind(phaseStates);
      jest.spyOn(phaseStates, 'findOne').mockImplementationOnce(async (options: any) => {
        const state = await read(options);
        if (state) await phaseStates.update(state.id, verdict as any);
        return state;
      });
    };

    const passed = {
      status: 'passed' as const,
      bestScore: 88,
      attempts: 1,
      passedAt: '2026-09-04T09:00:00.000Z',
    };

    it('autosaving keeps a pass the grader wrote mid-request, and still stores the file', async () => {
      const ids = await enrol();
      await open(ids.requirements, { workspace: { [STORY]: rec('first draft') } });
      gradeAfterLoad(passed);

      await service.saveWorkspace(learner, ids.requirements, { [STORY]: rec('second draft') });

      const state = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(state.status).toBe('passed');
      expect(state.bestScore).toBe(88);
      expect(state.attempts).toBe(1);
      expect(state.passedAt).toBe(passed.passedAt);
      expect(state.workspace![STORY]).toBe(rec('second draft'));
    });

    it('reflecting keeps the pass too, and does not post the editor back', async () => {
      const ids = await enrol();
      await open(ids.requirements, { workspace: { [STORY]: rec('first draft') } });
      gradeAfterLoad({ ...passed, workspace: { [STORY]: rec('graded draft') } });

      await service.reflect(learner, ids.requirements, '  I cut the vague acceptance criterion.  ');

      const state = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(state.reflection).toBe('I cut the vague acceptance criterion.');
      expect(state.status).toBe('passed');
      expect(state.bestScore).toBe(88);
      expect(state.workspace![STORY]).toBe(rec('graded draft'));
    });
  });

  describe('a save to a design-kind phase', () => {
    /**
     * TaskTrackr's Design is still of the markdown kind until its pack moves,
     * so the room is served a design phase of its own: the pack's Design with
     * design checks and the three documents mounted editable, through the one
     * read every phase action makes (`getPhaseForEnrollment`).
     */
    const asDesignPhase = (contracts: { api: boolean; screens: boolean }): void => {
      const read = content.getPhaseForEnrollment.bind(content);
      jest.spyOn(content, 'getPhaseForEnrollment').mockImplementation((enrollment, key) => {
        const phase = read(enrollment, key);
        if (key !== 'design') return phase;
        return {
          ...phase,
          artifactKind: 'design',
          checks: { kind: 'design', record: DESIGN_JSON, contracts, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR },
          files: [DESIGN_JSON, API_CONTRACT_JSON, SCREEN_CONTRACT_JSON].map((path) => ({ path, content: '{}', editable: true, language: 'json' })),
        } as PhaseContent;
      });
    };
    const record = serialiseDesign({
      ...EMPTY_DESIGN,
      entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: ['knows its due date'], satisfies: [] }],
    });

    it('stores the record as validated, so a key the record does not have is never stored', async () => {
      asDesignPhase({ api: true, screens: false });
      const ids = await enrol();
      await open(ids.design);
      const sent = JSON.stringify({ ...JSON.parse(record), padding: 'x'.repeat(1000) });
      const saved = await service.saveWorkspace(learner, ids.design, { [DESIGN_JSON]: sent });
      expect(saved.workspace[DESIGN_JSON]).toBe(record);
      expect((await phaseStates.findOneByOrFail({ id: ids.design })).workspace![DESIGN_JSON]).toBe(record);
    });

    it('refuses a record that is not valid, and a contract that is switched off, writing nothing', async () => {
      asDesignPhase({ api: true, screens: false });
      const ids = await enrol();
      await open(ids.design, { workspace: { [DESIGN_JSON]: record } });
      await expect(service.saveWorkspace(learner, ids.design, { [DESIGN_JSON]: '{' })).rejects.toThrow(
        new BadRequestException('The design record is not valid: The design record is not valid JSON.'),
      );
      await expect(service.saveWorkspace(learner, ids.design, { [SCREEN_CONTRACT_JSON]: '{ "screens": [] }' })).rejects.toThrow(
        new BadRequestException('The screen contract is switched off in this design and cannot be saved.'),
      );
      await expect(service.saveWorkspace(learner, ids.design, { [API_CONTRACT_JSON]: '{ "errors": {} }' })).rejects.toThrow(
        new BadRequestException('The API contract is not valid: The API contract has no operations list.'),
      );
      const state = await phaseStates.findOneByOrFail({ id: ids.design });
      expect(state.workspace).toEqual({ [DESIGN_JSON]: record });
      expect(state.workspaceUpdatedAt).toBeNull();
    });
  });

  describe('enrolment', () => {
    it('leaves one enrolment and one board when two requests race', async () => {
      const [first, second] = await Promise.all([
        service.enroll(learner, 'tasktrackr'),
        service.enroll(learner, 'tasktrackr'),
      ]);

      expect(second.id).toBe(first.id);
      expect(first.phases).toHaveLength(6);
      expect(second.phases).toHaveLength(6);
      expect(await enrollments.count({ where: { userId: learner } })).toBe(1);
      expect(await phaseStates.count({ where: { userId: learner } })).toBe(6);
    });

    it('writes the board and its enrolment together, or neither', async () => {
      // A board that refuses partway through: the pack has been edited to
      // declare two phases at order 3, so the second of them is refused by
      // UQ_phase_states_enrollment_order. A learner is either enrolled with
      // every phase or not enrolled, never enrolled onto a board with a hole.
      const project = content.getProject('tasktrackr');
      const original = project.phases;
      project.phases = [...original, { ...original[2], key: 'retrospective' as PhaseKey }];
      try {
        await expect(service.enroll(learner, 'tasktrackr')).rejects.toBeDefined();
        expect(await enrollments.count({ where: { userId: learner } })).toBe(0);
        expect(await phaseStates.count({ where: { userId: learner } })).toBe(0);
      } finally {
        project.phases = original;
      }
    });

    it('repairs an enrolment that lost phase states rather than refusing a second Start', async () => {
      const ids = await enrol();
      const enrollment = await enrollments.findOneByOrFail({ userId: learner });
      await phaseStates.update(ids.requirements, { workspace: { [STORY_JSON]: 'mine' } });
      await phaseStates.delete({ enrollmentId: enrollment.id, phaseOrder: In([3, 4, 5, 6]) });

      const view = await service.enroll(learner, 'tasktrackr');

      expect(view.id).toBe(enrollment.id);
      expect(view.phases.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await phaseStates.count({ where: { enrollmentId: enrollment.id } })).toBe(6);
      // Rebuilt rows are locked, and the work on the row that survived is untouched.
      expect(view.phases.filter((p) => p.status === 'locked').map((p) => p.order)).toEqual([2, 3, 4, 5, 6]);
      const kept = await phaseStates.findOneByOrFail({ id: ids.requirements });
      expect(kept.workspace).toEqual({ [STORY_JSON]: 'mine' });
    });

    it('returns the same complete board across repeated and concurrent enrollment retries', async () => {
      const first = await service.enroll(learner, 'tasktrackr');
      const views = await Promise.all(Array.from({ length: 4 }, () => service.enroll(learner, 'tasktrackr')));
      expect(views.every(view => view.id === first.id)).toBe(true);
      expect(views.every(view => view.phases.length === 6)).toBe(true);
      expect(await enrollments.count({ where: { userId: learner } })).toBe(1);
      expect(await phaseStates.count({ where: { enrollmentId: first.id } })).toBe(6);
    });
  });

  describe('a content pack edited under a live enrolment', () => {
    /** Swap the project's phase list for the length of one test, then put it back. */
    const withPhases = async (
      make: (phases: PhaseContent[]) => PhaseContent[],
      body: () => Promise<void>,
    ): Promise<void> => {
      const project = content.getProject('tasktrackr');
      const original = project.phases;
      project.phases = make(original);
      try {
        await body();
      } finally {
        project.phases = original;
      }
    };

    it('shows a phase the pack no longer has by its key, rather than 500ing the dashboard', async () => {
      await enrol();
      await withPhases(
        (phases) => phases.filter((phase) => phase.key !== 'testing'),
        async () => {
          const view = await service.myEnrollment(learner, 'tasktrackr');
          expect(view!.phases).toHaveLength(6);
          expect(view!.phases.find((p) => p.key === 'testing')!.title).toBe('testing');
          // The phases the pack still has keep their real titles.
          expect(view!.phases.find((p) => p.key === 'requirements')!.title).not.toBe('requirements');
        },
      );
    });

    it('refuses completion when the current content pack requires a missing phase', async () => {
      const ids = await enrol();
      await open(ids.maintenance, {
        status: 'passed',
        bestScore: 88,
        reflection: 'Shipped the change request and updated the changelog.',
      });
      const enrollment = await enrollments.findOneByOrFail({ userId: learner });
      enrollment.currentPhaseOrder = 6;
      await enrollments.save(enrollment);

      await withPhases(
        (phases) => [
          ...phases,
          { ...phases[phases.length - 1], key: 'retrospective' as PhaseKey, order: 7, title: 'Retrospective' },
        ],
        async () => {
          await expect(service.advance(learner, ids.maintenance)).rejects.toThrow('next phase record is missing');
          expect((await enrollments.findOneByOrFail({ id: enrollment.id })).completed).toBe(false);
        },
      );
    });
  });

  describe('the pack version an enrolment was cut from', () => {
    /**
     * Run the body against a different edition of the pack: a phase list and
     * the version that names it. Both go back afterwards: `getProject` hands
     * out the object the loader built once at boot.
     */
    const withPack = async (
      version: string,
      make: (phases: PhaseContent[]) => PhaseContent[],
      body: () => Promise<void>,
    ): Promise<void> => {
      const project: ProjectContent = content.getProject('tasktrackr');
      const phases = project.phases;
      const was = project.version;
      project.phases = make(phases);
      project.version = version;
      try {
        await body();
      } finally {
        project.phases = phases;
        project.version = was;
      }
    };

    it('stamps the pack an enrolment was cut from, and re-stamps it when the pack moves', async () => {
      await enrol();
      const project = content.getProject('tasktrackr');
      expect((await enrollments.findOneByOrFail({ userId: learner })).packVersion).toBe(
        project.version,
      );

      await withPack('9.9.9', (phases) => phases, async () => {
        await service.myEnrollment(learner, 'tasktrackr');
        expect((await enrollments.findOneByOrFail({ userId: learner })).packVersion).toBe('9.9.9');
      });
    });

    it('gives an enrolment made before a phase was added the row, on next load', async () => {
      // Enrolled on last term's pack, which stopped at testing.
      await withPack(
        '0.9.0',
        (phases) => phases.filter((phase) => phase.order <= 4),
        async () => {
          const view = await service.enroll(learner, 'tasktrackr');
          expect(view.phases).toHaveLength(4);
        },
      );

      // This term's pack has deployment and maintenance. Nobody re-enrols.
      const project = content.getProject('tasktrackr');
      const view = await service.myEnrollment(learner, 'tasktrackr');
      expect(view!.phases.map((p) => p.key)).toEqual(project.phases.map((p) => p.key));
      const added = view!.phases.find((p) => p.key === 'deployment')!;
      expect(added.status).toBe('locked');
      expect(added.title).toBe(project.phases.find((p) => p.key === 'deployment')!.title);
      // The board is repaired once, not on every load.
      expect((await enrollments.findOneByOrFail({ userId: learner })).packVersion).toBe(
        project.version,
      );
      expect((await service.myEnrollment(learner, 'tasktrackr'))!.phases).toHaveLength(
        project.phases.length,
      );
    });

    it('keeps the phase a newer pack removed, visible by its key', async () => {
      const ids = await enrol();
      await open(ids.testing, { status: 'passed', bestScore: 74 });

      await withPack(
        '2.0.0',
        (phases) => phases.filter((phase) => phase.key !== 'testing'),
        async () => {
          const view = await service.myEnrollment(learner, 'tasktrackr');
          const orphan = view!.phases.find((p) => p.key === 'testing')!;
          // Their work is still theirs: the row, the score and the key stand,
          // and the pack has no title left to give it.
          expect(orphan.title).toBe('testing');
          expect(orphan.bestScore).toBe(74);
          expect(view!.phases).toHaveLength(6);
        },
      );
    });
  });

  describe('phaseDetail', () => {
    it('carries an empty link set and a null drill before either exists', async () => {
      const ids = await enrol();
      const detail = await service.phaseDetail(learner, ids.requirements);
      expect(detail.links).toEqual([]);
      expect(detail.drill).toBeNull();
    });

    it('carries the links exactly as stored', async () => {
      const ids = await enrol();
      const links: PhaseLink[] = [
        { from: 'test_overdue_boundary', to: 'US-4/AC-2', kind: 'verifies', at: '2026-09-01T09:00:00.000Z' },
      ];
      await open(ids.requirements, { links });
      expect((await service.phaseDetail(learner, ids.requirements)).links).toEqual(links);
    });

    /**
     * The shell holds the summary of every open phase, not the whole phase:
     * holding them whole so the browser could build the project map from the
     * files would cost 133 KB of workspace for a learner three phases into
     * TaskTrackr, against a 60 KB landing budget (e2e/render-cost.spec.ts).
     */
    describe('the summary view', () => {
      it('keeps every path and drops every body, and says which view it is', async () => {
        const ids = await enrol();
        const full = await service.phaseDetail(learner, ids.requirements);
        const summary = await service.phaseDetail(learner, ids.requirements, 'summary');

        expect(summary.view).toBe('summary');
        expect(full.view).toBe('full');
        // The same files, in the same order: a tree, a tab strip and a shelf
        // draw from the index exactly as they drew from the workspace.
        expect(summary.files.map((f) => f.path)).toEqual(full.files.map((f) => f.path));
        expect(summary.files.map((f) => f.editable)).toEqual(full.files.map((f) => f.editable));
        expect(summary.files.every((f) => f.content === '')).toBe(true);
        expect(full.files.some((f) => f.content.length > 0)).toBe(true);
        // The brief is markdown for the workspace's Brief tab and for nothing
        // the shell draws.
        expect(summary.taskPanel).toBe('');
        expect(full.taskPanel.length).toBeGreaterThan(0);
        // And it is smaller than what it replaces, which is the whole point.
        expect(JSON.stringify(summary).length).toBeLessThan(
          JSON.stringify(full).length / 2,
        );
      });

    it('carries the two facts the phase card would otherwise read out of a file body', async () => {
        const ids = await enrol();
        await open(ids.implementation);
        // The phase card's two rules, applied to the bodies rather than to the
        // index, so what the API says and what the card would work out for
        // itself are checked against each other file by file.
        const full = await service.phaseDetail(learner, ids.implementation);
        const summary = await service.phaseDetail(learner, ids.implementation, 'summary');
        expect(full.files.length).toBeGreaterThan(0);
        for (const file of full.files) {
          const index = summary.files.find((f) => f.path === file.path)!;
          expect(index.lines).toBe(file.content ? file.content.split('\n').length : 0);
          if (file.editable) {
            expect(index.touched).toBe(
              file.content.trim().length > 0 && !/TODO\(learner\)/.test(file.content),
            );
          } else {
            // A locked file is nobody's work, so it carries a count and no verdict.
            expect(index.touched).toBeUndefined();
          }
        }
        // The stub the learner is asked to fill in carries the marker, so the
        // card says "Not started yet" for it and the index agrees.
        const stub = summary.files.find((f) => f.path === 'api/repository/tasks.py')!;
        expect(stub.editable).toBe(true);
        expect(stub.touched).toBe(false);

        await service.saveWorkspace(learner, ids.implementation, {
          'api/repository/tasks.py': 'def overdue(rows, today):\n    return []\n',
        });

        const after = await service.phaseDetail(learner, ids.implementation, 'summary');
        const written = after.files.find((f) => f.path === 'api/repository/tasks.py')!;
        expect(written.touched).toBe(true);
        expect(written.lines).toBe(3);
      });

      it('is not what the workspace gets: the default view is still the whole phase', async () => {
        const ids = await enrol();
        const detail = await service.phaseDetail(learner, ids.requirements);
        expect(detail.files.every((f) => f.content.length > 0)).toBe(true);
        expect(detail.files.every((f) => f.lines === undefined)).toBe(true);
        expect(detail.files.every((f) => f.touched === undefined)).toBe(true);
      });
    });
  });

  /**
   * The project map, built where the files already are.
   * It is the same `buildProjectMap` the browser calls, so what is served and
   * what a browser would have built are the same graph.
   */
  describe('projectMap', () => {
    it('draws the open phases, and folds them when the caller asks', async () => {
      const ids = await enrol();
      await open(ids.requirements);

      const unfolded = await service.projectMap(learner, 'tasktrackr', {
        compact: false,
        showLocked: false,
      });
      const folded = await service.projectMap(learner, 'tasktrackr', {
        compact: true,
        showLocked: false,
      });

      expect(unfolded.nodes.length).toBeGreaterThan(0);
      // Folding is what Home's card draws, and it is a different set of nodes,
      // which is why neither shape can be derived from the other.
      expect(folded.nodes.length).toBeLessThan(unfolded.nodes.length);
      expect(folded.nodes.some((n) => n.id.startsWith('fold:'))).toBe(true);
      // No locked phase is drawn as a placeholder when it was not asked for.
      expect(unfolded.nodes.some((n) => n.kind === 'placeholder')).toBe(false);
    });

    it('adds one placeholder per locked phase when asked, and defaults to asking', async () => {
      const ids = await enrol();
      await open(ids.requirements);

      const shown = await service.projectMap(learner, 'tasktrackr', { compact: false });
      const placeholders = shown.nodes.filter((n) => n.kind === 'placeholder');
      // Five of the six phases are locked for a learner who has just enrolled.
      expect(placeholders).toHaveLength(5);
      expect(placeholders.every((n) => n.sub?.startsWith('Opens in phase'))).toBe(true);
    });

    it('is an empty graph for a learner who has not started the project', async () => {
      expect(await service.projectMap('nobody', 'tasktrackr', {})).toEqual({
        nodes: [],
        edges: [],
      });
    });

    it('draws what the learner wrote, not the stub they were given', async () => {
      const ids = await enrol();
      await open(ids.requirements);
      // the story phase's record, as the form saves it
      await service.saveWorkspace(learner, ids.requirements, {
        [STORY_JSON]: serialiseStory({
          ...EMPTY_STORY,
          title: 'Remember the shopping',
          criteria: [{ id: 'AC-1', given: 'a list', when: 'I refresh', then: 'the list survives', tag: 'happy' }],
        }),
      });

      const map = await service.projectMap(learner, 'tasktrackr', {
        compact: false,
        showLocked: false,
      });
      expect(map.nodes.some((n) => n.label.includes('Remember the shopping'))).toBe(true);
    });
  });

  /**
   * `updatedAt` is an @UpdateDateColumn, so every write to the row moves it;
   * shown as the learner's save time, it would claim the workspace was saved a
   * second ago after "Run health check" when nothing had been written.
   */
  describe('what "last saved" means', () => {
    it('stamps workspaceUpdatedAt on a save and leaves it alone on a drill', async () => {
      const ids = await enrol();
      await open(ids.deployment);

      const dockerfile = deployment(content).smokeDockerfile;
      await service.saveWorkspace(learner, ids.deployment, {
        [dockerfile]: 'FROM python:3.11-slim\n',
      });
      const afterSave = await service.phaseDetail(learner, ids.deployment);
      expect(afterSave.workspaceUpdatedAt).toEqual(expect.any(String));

      // A second later, so a stamp that moved could not be mistaken for one
      // that did not. The column is an ISO string, to the millisecond.
      await sleep(1100);
      runSmokeCheck.mockResolvedValueOnce(smokeFailed("can't open file '/app/cli.py'"));
      await service.drillStart(learner, ids.deployment);
      await service.drillHealth(learner, ids.deployment);

      const afterDrill = await service.phaseDetail(learner, ids.deployment);
      // The label has not moved: the learner saved once and saved once.
      expect(afterDrill.workspaceUpdatedAt).toBe(afterSave.workspaceUpdatedAt);
      // The row stamp did move, which is what it is for.
      expect(String(afterDrill.updatedAt) > String(afterSave.updatedAt)).toBe(true);
    });

    it('is null until the learner has actually saved, rather than borrowing the row stamp', async () => {
      const ids = await enrol();
      await open(ids.deployment);
      await service.saveLinks(learner, ids.deployment, [
        { from: 'test_image_starts', to: 'US-6/AC-1', kind: 'verifies' },
      ]);

      const detail = await service.phaseDetail(learner, ids.deployment);
      expect(detail.workspaceUpdatedAt).toBeNull();
      expect(detail.updatedAt).toEqual(expect.any(String));
    });

    it('moves again on the next save, and keeps millisecond precision', async () => {
      const ids = await enrol();
      await open(ids.deployment);

      const dockerfile = deployment(content).smokeDockerfile;
      await service.saveWorkspace(learner, ids.deployment, {
        [dockerfile]: 'FROM python:3.11-slim\n',
      });
      const first = (await service.phaseDetail(learner, ids.deployment)).workspaceUpdatedAt!;
      await sleep(20);
      await service.saveWorkspace(learner, ids.deployment, {
        [dockerfile]: 'FROM python:3.12-slim\n',
      });
      const second = (await service.phaseDetail(learner, ids.deployment)).workspaceUpdatedAt!;

      // Two saves inside the same second are two different stamps, which
      // `updatedAt` (stored to the second) could not tell apart.
      expect(second > first).toBe(true);
      expect(first).toMatch(/\.\d{3}Z$/);
    });
  });
});

/**
 * `advance` on a phase of many tasks.
 *
 * Two independent statements, and both are needed.
 *
 * **The heal.** Two verdicts for the last two required tasks can each write
 * their own row and then read the task set without seeing the other's commit:
 * the phase is left `submitted` with every required task `passed`, and there
 * is no later verdict to correct it, a countersignature happens once. So
 * `advance` recomputes the roll-up from the rows and **persists** it, before
 * the precondition, so the map, the tile and the door read a phase that
 * opened rather than one that only `strictPass`' own copy thinks did.
 *
 * Its safety rests on an ordering nobody had asserted: the heal is inside
 * `this.transaction`, and `strictPass` re-reads the task rows **after** it. A
 * lost race therefore ends at the strict-evidence gate, which rolls the heal
 * back with it. A memoised task-row read, or a heal hoisted out of the
 * transaction for tidiness, is a silent regression, so it is a test here
 * rather than a comment there.
 *
 * **The gate's two new conjuncts.** The submission query gains `taskKey`,
 * because a project's rubrics share criteria keys and one task's clean
 * revision would otherwise strict-pass every required sibling. And the task
 * row itself is a conjunct: a stored passing revision says the work was once
 * right, the row says it still counts, and `task-reopen` withdraws a pass
 * **without deleting a submission**.
 */
describe('advance on a phase of many tasks', () => {
  const TEACHER = 'ms-tan-tasktrackr';
  const V_FLAT = 'v-tasktrackr-head';
  const V_SPLIT = 'v-teacher-split';
  const V_MAIN = 'v-teacher-main';
  const learner = 'advance-learner';

  let dataSource: DataSource;
  let content: ContentService;
  let service: WorkflowService;
  let phaseStates: Repository<PhaseStateEntity>;
  let submissions: Repository<SubmissionEntity>;
  let taskStates: Repository<TaskStateEntity>;
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  let ids: Record<string, string>;
  let queries: string[] = [];

  const phaseOf = (project: ProjectContent, key: string): PhaseContent =>
    project.phases.find((one) => one.key === key) as PhaseContent;

  const taskLike = (base: PhaseContent, over: Partial<CompiledTask>): CompiledTask => ({
    ...soleTaskFor(base),
    ...over,
  });

  const soleTasks = (project: ProjectContent): CompiledPhaseTasks[] =>
    project.phases.map((one) => ({ key: one.key, tasks: [soleTaskFor(one)] }));

  /** `requirements` split into two REQUIRED tasks, which is what the gate quantifies over. */
  const splitTasks = (project: ProjectContent, over: Partial<CompiledTask> = {}): CompiledPhaseTasks[] => {
    const requirements = phaseOf(project, 'requirements');
    return soleTasks(project).map((entry) =>
      entry.key !== 'requirements'
        ? entry
        : {
            key: entry.key,
            tasks: [
              taskLike(requirements, { taskKey: 'story', order: 1 }),
              taskLike(requirements, { taskKey: 'scope', order: 2, ...over }),
            ],
          },
    );
  };

  /**
   * One authored task per phase, keyed `main`: the mainline, and what
   * `AuthoringService`'s publish compiles for every copied project.
   */
  const mainTasks = (project: ProjectContent): CompiledPhaseTasks[] =>
    project.phases.map((one) => ({
      key: one.key,
      tasks: [taskLike(one, { taskKey: INHERITED_TASK_KEY, order: 1 })],
    }));

  const install = (
    ...versions: { versionId: string; content: ProjectContent; phases: CompiledPhaseTasks[] }[]
  ): void => {
    content.installVersions(versions.map((one) => ({ ...one, compiler: COMPILER_IDENTITY })));
  };

  const enrol = async (slug: string): Promise<void> => {
    const view = await service.enroll(learner, slug);
    ids = Object.fromEntries(view.phases.map((one) => [one.key, one.id]));
  };

  /** The learner's dashboard read, and therefore `reconcileToPack`'s repair. */
  const repair = async (slug: string): Promise<void> => {
    await service.enrollmentView(
      await dataSource
        .getRepository(EnrollmentEntity)
        .findOneByOrFail({ userId: learner, projectSlug: slug }),
    );
  };

  /** A completed, strict-evidenced passing revision of one task. */
  const evidence = (project: ProjectContent, phaseKey: string, taskKey: string): Promise<SubmissionEntity> => {
    const rubric = phaseOf(project, phaseKey).rubric;
    return submissions.save(
      submissions.create({
        phaseStateId: ids[phaseKey],
        userId: learner,
        taskKey,
        status: 'completed',
        passed: true,
        workspaceSnapshot: { fixture: 'gate authority fixture' },
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [{ id: 'fixture', label: 'Mocked assessment fixture', status: 'passed', detail: 'Persisted gate authority only.' }],
          tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
          aiReview: {
            provider: 'mock-ai',
            verdict: 'pass',
            criteriaEvidence: rubric.criteria.map((c) => ({ key: c.key, met: true, evidence: 'Fixture evidence for the gate only.', issue: '', nextStep: '' })),
          },
        } as never,
      }),
    );
  };

  const setPhase = (key: string, over: Partial<PhaseStateEntity>): Promise<unknown> =>
    phaseStates.update(ids[key], over);

  const setTask = (key: string, taskKey: string, over: Partial<TaskStateEntity>): Promise<unknown> =>
    taskStates.update({ phaseStateId: ids[key], taskKey }, over);

  const passedRow = { status: 'passed' as const, passedAt: '2026-09-18T09:00:00.000Z', bestScore: 80 };

  const firstAt = (re: RegExp): number => queries.findIndex((sql) => re.test(sql));
  const lastAt = (re: RegExp): number =>
    queries.reduce((at, sql, index) => (re.test(sql) ? index : at), -1);
  /** The heal's own statement: the three roll-up columns on one phase row. */
  const HEAL_WRITE = /^\s*UPDATE\s+"?phase_states"?[\s\S]*passedAt/i;
  const TASK_READ = /^\s*SELECT[\s\S]*task_states/i;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
      // The statement log is the probe: "the rows the gate reads are read
      // after the heal writes" is a claim about the order of SQL, and a spy on
      // a repository method would miss a query issued through the manager.
      logger: {
        logQuery: (query: string) => {
          queries.push(query);
        },
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
      },
    });
    await dataSource.initialize();
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    submissions = dataSource.getRepository(SubmissionEntity);
    taskStates = dataSource.getRepository(TaskStateEntity);
    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject('tasktrackr');
    teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)', version: '1.0.0' };
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    content = new ContentService();
    content.loadAll();
    service = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      phaseStates,
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
    queries = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a sole-task advance issues no task-row query at all', async () => {
    install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
    await enrol('tasktrackr');
    await evidence(shipped, 'requirements', '');
    await setPhase('requirements', { status: 'passed', passedAt: new Date().toISOString() });
    queries = [];

    await service.advance(learner, ids.requirements);

    // A sole task issues no task-row read, as a test rather than as an optimisation: `sole` is true, the heal
    // block is skipped entirely and `strictPass` returns at `if (sole) return
    // true;`, so no `task_states` read is issued anywhere in the call.
    expect(queries.filter((sql) => /task_states/i.test(sql))).toEqual([]);
    expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('in_progress');
  });

  it('the heal is read back by the gate that may refuse it', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol(TEACHER);
    await evidence(teacher, 'requirements', 'story');
    await evidence(teacher, 'requirements', 'scope');
    await setTask('requirements', 'story', passedRow);
    await setTask('requirements', 'scope', passedRow);
    // the lost race: every required task passed, the phase left behind
    await setPhase('requirements', { status: 'submitted', passedAt: null });
    queries = [];

    await service.advance(learner, ids.requirements);

    // The heal reads the rows, writes the phase, and the gate then re-reads
    // the rows it will judge on. Both halves, in that order. A memoised
    // task-row read, or a heal hoisted out of the transaction for tidiness,
    // fails the third line.
    expect(firstAt(HEAL_WRITE)).toBeGreaterThan(0);
    expect(firstAt(TASK_READ)).toBeGreaterThanOrEqual(0);
    expect(firstAt(TASK_READ)).toBeLessThan(firstAt(HEAL_WRITE));
    expect(lastAt(TASK_READ)).toBeGreaterThan(firstAt(HEAL_WRITE));
  });

  it('advance heals a phase a lost race left submitted', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol(TEACHER);
    await evidence(teacher, 'requirements', 'story');
    await evidence(teacher, 'requirements', 'scope');
    await setTask('requirements', 'story', passedRow);
    await setTask('requirements', 'scope', passedRow);
    await setPhase('requirements', { status: 'submitted', passedAt: null });

    await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    const healed = await phaseStates.findOneByOrFail({ id: ids.requirements });
    expect(healed.status).toBe('passed');
    expect(healed.passedAt).not.toBeNull();
    expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('in_progress');
  });

  it('a refused advance persists no heal', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol(TEACHER);
    // Rows say passed; no revision says why. The heal would write `passed`,
    // and the strict-evidence gate one line later refuses the request, which
    // rolls the heal back with it, because both are inside `this.transaction`.
    await setTask('requirements', 'story', passedRow);
    await setTask('requirements', 'scope', passedRow);
    await setPhase('requirements', { status: 'in_progress', passedAt: null });

    await expect(service.advance(learner, ids.requirements)).rejects.toThrow(
      'strict evidence review',
    );
    const row = await phaseStates.findOneByOrFail({ id: ids.requirements });
    expect(row.status).toBe('in_progress');
    expect(row.passedAt).toBeNull();
  });

  it("one task's clean submission does not re-pass its siblings", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol(TEACHER);
    // One revision on the phase state, and it is `story`'s. The two tasks
    // carry the phase's rubric, so its criteria keys are identical, without
    // `taskKey: task.taskKey` in the `where`, `scope` strict-passes on it.
    await evidence(teacher, 'requirements', 'story');
    await setTask('requirements', 'story', passedRow);
    await setTask('requirements', 'scope', passedRow);
    await setPhase('requirements', { status: 'submitted', passedAt: null });
    expect(await submissions.countBy({ phaseStateId: ids.requirements, passed: true })).toBe(1);

    await expect(service.advance(learner, ids.requirements)).rejects.toThrow(
      'strict evidence review',
    );
  });

  it('a required task whose row is not passed refuses advance, whatever its submissions say', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol(TEACHER);
    await evidence(teacher, 'requirements', 'story');
    await evidence(teacher, 'requirements', 'scope');
    await setTask('requirements', 'story', passedRow);
    // `task-reopen` deletes no submission: the row is the only thing that moved.
    await setTask('requirements', 'scope', { status: 'in_progress', passedAt: null });
    await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T08:00:00.000Z' });

    await expect(service.advance(learner, ids.requirements)).rejects.toThrow(
      'strict evidence review',
    );
    // and the heal did not un-pass the phase on its way past: `passed` is
    // sticky, which is what makes the row conjunct the statement that refuses.
    expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).status).toBe('passed');
  });

  it('a phase passed before tasks were keyed advances once its row is repaired', async () => {
    install({ versionId: V_MAIN, content: teacher, phases: mainTasks(teacher) });
    await enrol(TEACHER);
    // A learner who passed before tasks were keyed, in the state the migration
    // leaves them: a phase this learner passed, a revision the migration backfilled to
    // `''`, and no task row at all. The board repair writes the row; the adoption gives the
    // revision the key. `strictPass` asks for both, so either half alone
    // refuses this learner for ever while the tile stays green.
    await taskStates.delete({ userId: learner });
    await evidence(teacher, 'requirements', '');
    await setPhase('requirements', {
      status: 'passed',
      passedAt: '2026-09-10T08:00:00.000Z',
      bestScore: 82,
    });

    await repair(TEACHER);

    const row = await taskStates.findOneByOrFail({ phaseStateId: ids.requirements });
    expect([row.taskKey, row.status]).toEqual([INHERITED_TASK_KEY, 'passed']);
    await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('in_progress');
  });

  it('a split phase repaired under a passed phase row still refuses advance', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol(TEACHER);
    await evidence(teacher, 'requirements', 'story');
    await evidence(teacher, 'requirements', 'scope');
    await setTask('requirements', 'story', passedRow);
    // `scope`'s row goes, as a half-finished restore takes one, under a phase
    // row that still reads `passed`. Two tasks, so the phase's pass names no
    // single owner: the repair may put back an unstarted row and nothing more,
    // and the missing-row rule refuses the gate on it.
    await taskStates.delete({ phaseStateId: ids.requirements, taskKey: 'scope' });
    await setPhase('requirements', {
      status: 'passed',
      passedAt: '2026-09-18T08:00:00.000Z',
      bestScore: 80,
    });

    await repair(TEACHER);

    const scope = await taskStates.findOneByOrFail({
      phaseStateId: ids.requirements,
      taskKey: 'scope',
    });
    expect(scope.status).toBe('in_progress');
    await expect(service.advance(learner, ids.requirements)).rejects.toThrow(
      'strict evidence review',
    );
  });

  it('a required signOff task needs the countersignature', async () => {
    install({
      versionId: V_SPLIT,
      content: teacher,
      phases: splitTasks(teacher, { signOff: true }),
    });
    await enrol(TEACHER);
    await evidence(teacher, 'requirements', 'story');
    await evidence(teacher, 'requirements', 'scope');
    await setTask('requirements', 'story', passedRow);
    await setTask('requirements', 'scope', { ...passedRow, awaitingSignOff: false });
    await setPhase('requirements', { status: 'submitted', passedAt: null });

    // Not reachable through the task shapes that exist (a markdown task is
    // sealed by construction, and `taskRollup` refuses `passed` on a signOff
    // task until `task-signoff` writes it) and pinned anyway, for any shape
    // that later reaches it.
    await expect(service.advance(learner, ids.requirements)).rejects.toThrow(
      'strict evidence review',
    );
    await setTask('requirements', 'scope', { signedOffBy: 'ms-tan', signedOffAt: '2026-09-18T10:00:00.000Z' });
    await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
  });

  /**
   * The room and the gate have to say one thing.
   *
   * A teacher's Sign off, or their phase-wide Pass, writes the board: the
   * task row and then the phase row read `passed`, without a revision behind
   * it. The design says a countersignature is the second half of a pass and
   * never the first (`taskRollup`, `countersignatureNote`), and `strictPass`
   * asks every required task for a sealed, strictly reviewed revision of its
   * own, so `advance` refuses; a room that showed "Phase evidence accepted"
   * and Continue would be wrong. The gate is the one that is right, and the
   * room is told what the gate will say through this field: it names the
   * required tasks the gate would refuse, from the gate's own predicate, and
   * is absent whenever Continue will be accepted.
   */
  describe('what the room is told about the gate', () => {
    const SCOPE_TITLE = 'The scope note';

    it("names a signed-off required task with no reviewed revision, on both views, and advance refuses the same phase", async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher, { title: SCOPE_TITLE }) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await setTask('requirements', 'story', passedRow);
      // What `task-signoff` writes: the row passed, countersigned, no revision.
      await setTask('requirements', 'scope', {
        ...passedRow,
        signedOffBy: 'ms-tan',
        signedOffAt: '2026-09-18T10:00:00.000Z',
      });
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });

      const full = await service.phaseDetail(learner, ids.requirements);
      expect(full.status).toBe('passed');
      expect(full.evidenceNeeded).toEqual([{ key: 'scope', title: SCOPE_TITLE }]);
      const summary = await service.phaseDetail(learner, ids.requirements, 'summary');
      expect(summary.evidenceNeeded).toEqual([{ key: 'scope', title: SCOPE_TITLE }]);
      // The fan-out the shell reads carries it too.
      const listed = (await service.phaseSummaries(learner, TEACHER)).find((one) => one.id === ids.requirements);
      expect(listed?.evidenceNeeded).toEqual([{ key: 'scope', title: SCOPE_TITLE }]);

      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');
      expect((await phaseStates.findOneByOrFail({ id: ids.design })).status).toBe('locked');
    });

    it('goes quiet once the task has a reviewed pass of its own, and advance agrees', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher, { title: SCOPE_TITLE }) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await evidence(teacher, 'requirements', 'scope');
      await setTask('requirements', 'story', passedRow);
      await setTask('requirements', 'scope', { ...passedRow, signedOffBy: 'ms-tan', signedOffAt: '2026-09-18T10:00:00.000Z' });
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });

      const detail = await service.phaseDetail(learner, ids.requirements);
      expect('evidenceNeeded' in detail).toBe(false);
      await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    it('says nothing on a phase that is not passed, and asks nothing of its revisions', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher, { title: SCOPE_TITLE }) });
      await enrol(TEACHER);
      await setTask('requirements', 'story', passedRow);
      queries = [];

      const detail = await service.phaseDetail(learner, ids.requirements);
      expect(detail.status).toBe('in_progress');
      expect('evidenceNeeded' in detail).toBe(false);
      // The gate's question costs nothing on the rooms it cannot be about.
      expect(queries.some((sql) => /FROM\s+"?submissions"?[\s\S]*"?passed"?\s*=/i.test(sql))).toBe(false);
    });

    it('reads a malformed historical pass as no evidence: a refusal and a name, never a crash', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 70 });
      // A stored "strict pass" with no review and no checks list: the shape an
      // old or hand-edited row can have. It is not evidence, and asking whether
      // it is must not throw: `advance` answered it with a 500, and the
      // console's learner read would have too once it asked the same question.
      const legacy = await evidence(shipped, 'requirements', '');
      await submissions.update(legacy.id, {
        report: { assessmentMode: 'strict_binary', passed: true } as never,
      });

      const title = phaseOf(shipped, 'requirements').title;
      expect((await service.phaseDetail(learner, ids.requirements)).evidenceNeeded).toEqual([{ key: '', title }]);
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');
      // And a sound revision beside it still counts, whichever order they are read in.
      await evidence(shipped, 'requirements', '');
      await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    it("says nothing on a passed phase the learner has already moved past", async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher, { title: SCOPE_TITLE }) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await evidence(teacher, 'requirements', 'scope');
      await setTask('requirements', 'story', passedRow);
      await setTask('requirements', 'scope', passedRow);
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });
      await service.advance(learner, ids.requirements);
      // A later reopen of a task leaves this phase's row passed; the learner
      // is not standing on it, so there is no Continue here to be wrong about.
      await setTask('requirements', 'scope', { status: 'in_progress', passedAt: null });

      const detail = await service.phaseDetail(learner, ids.requirements);
      expect('evidenceNeeded' in detail).toBe(false);
    });

    it("names the phase's one task on a sole-task phase a teacher passed without a revision, and nothing once it has one", async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 70 });

      const title = phaseOf(shipped, 'requirements').title;
      expect((await service.phaseDetail(learner, ids.requirements)).evidenceNeeded).toEqual([
        { key: '', title },
      ]);
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');

      await evidence(shipped, 'requirements', '');
      queries = [];
      const detail = await service.phaseDetail(learner, ids.requirements);
      // TaskTrackr's payload on the ordinary path carries no such field.
      expect('evidenceNeeded' in detail).toBe(false);
      // A sole-task phase reads no task row to answer it.
      expect(queries.filter((sql) => /task_states/i.test(sql))).toEqual([]);
      await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    /*
     * Three things the field must say as truly as the gate it claims to be: a quiz whose papers are all spent is not a Submit
     * door; the last phase's Continue is also refused over an EARLIER phase
     * (`advance`'s completion arm); and the question must not load every
     * passing revision whole, workspace copy and all.
     */
    const QUIZ_TITLE = 'Booking concepts check';
    /** `story` required, `concepts` a REQUIRED quiz of two papers. */
    const storyAndQuiz = (project: ProjectContent): CompiledPhaseTasks[] => {
      const requirements = phaseOf(project, 'requirements');
      return soleTasks(project).map((entry) =>
        entry.key !== 'requirements'
          ? entry
          : {
              key: entry.key,
              tasks: [
                taskLike(requirements, { taskKey: 'story', order: 1 }),
                taskLike(requirements, {
                  taskKey: 'concepts',
                  order: 2,
                  title: QUIZ_TITLE,
                  checkKind: 'quiz',
                  artefactType: 'quiz',
                  artefactPath: null,
                  owns: [],
                  rubric: fixtureQuizRubric(),
                  checks: fixtureQuizChecks({ attempts: { max: 2, cooldownSeconds: null } }),
                }),
              ],
            },
      );
    };
    /** One paper handed in on `concepts`, and the revision that marked it. */
    const paper = async (status: 'completed' | 'queued' = 'completed', passed = false): Promise<void> => {
      const marked = await submissions.save(
        submissions.create({ phaseStateId: ids.requirements, userId: learner, taskKey: 'concepts', status, passed }),
      );
      const at = new Date().toISOString();
      await dataSource.getRepository(QuizAttemptEntity).save(
        dataSource.getRepository(QuizAttemptEntity).create({
          phaseStateId: ids.requirements,
          userId: learner,
          taskKey: 'concepts',
          epoch: 0,
          projectVersionId: V_SPLIT,
          paper: [],
          answers: {},
          score: 0,
          passed: false,
          startedAt: at,
          submittedAt: at,
          submissionId: marked.id,
        }),
      );
      await sleep(2);
    };

    it('says a required quiz credited with no paper left needs a reset, not a submit', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: storyAndQuiz(teacher) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await setTask('requirements', 'story', passedRow);
      // What `task-signoff` writes on the quiz: passed, countersigned, no paper.
      await setTask('requirements', 'concepts', { ...passedRow, signedOffBy: 'ms-tan', signedOffAt: passedRow.passedAt });
      await setPhase('requirements', { status: 'passed', passedAt: passedRow.passedAt });

      // One paper of two sat: the room's own Submit (a paper) still works.
      await paper();
      expect((await service.phaseDetail(learner, ids.requirements)).evidenceNeeded).toEqual([
        { key: 'concepts', title: QUIZ_TITLE },
      ]);
      // The second is still being marked, and may pass: not a teacher's problem yet.
      await paper('queued');
      expect((await service.phaseDetail(learner, ids.requirements)).evidenceNeeded).toEqual([
        { key: 'concepts', title: QUIZ_TITLE },
      ]);
      // Marked, and not a pass: nothing is left to draw, and the gate still refuses.
      await submissions.update({ phaseStateId: ids.requirements, taskKey: 'concepts', status: 'queued' }, { status: 'completed' });
      expect((await service.phaseDetail(learner, ids.requirements)).evidenceNeeded).toEqual([
        { key: 'concepts', title: QUIZ_TITLE, noPapersLeft: true },
      ]);
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');
    });

    it('on the last phase, names an earlier phase that completion re-checks, as advance refuses it', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      for (const one of shipped.phases) {
        await evidence(shipped, one.key, '');
        await setPhase(one.key, { status: 'passed', passedAt: passedRow.passedAt, bestScore: 80 });
      }
      await dataSource.getRepository(EnrollmentEntity).update({ userId: learner }, { currentPhaseOrder: 6 });
      // A teacher reopened Requirements after the learner had moved on.
      await setPhase('requirements', { status: 'in_progress', passedAt: null });

      const requirements = phaseOf(shipped, 'requirements');
      expect((await service.phaseDetail(learner, ids.maintenance)).evidenceNeeded).toEqual([
        {
          key: '',
          title: requirements.title,
          phaseId: ids.requirements,
          phaseKey: 'requirements',
          phaseTitle: requirements.title,
        },
      ]);
      await expect(service.advance(learner, ids.maintenance)).rejects.toThrow(
        'Course completion requires a strict, evidenced Pass in every phase',
      );

      // Passed again on its own evidence: the field goes, and completion is accepted.
      await setPhase('requirements', { status: 'passed', passedAt: passedRow.passedAt });
      expect('evidenceNeeded' in (await service.phaseDetail(learner, ids.maintenance))).toBe(false);
      expect((await service.advance(learner, ids.maintenance)).completed).toBe(true);
    });

    it('asks the gate its question without loading any revision’s workspace copy', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await evidence(shipped, 'requirements', '');
      await setPhase('requirements', { status: 'passed', passedAt: passedRow.passedAt, bestScore: 80 });
      const loadsSnapshot = (sql: string) => /"?(workspaceSnapshot|contextSnapshot)"?\s+AS\s/i.test(sql);

      queries = [];
      const detail = await service.phaseDetail(learner, ids.requirements);
      expect('evidenceNeeded' in detail).toBe(false);
      expect(queries.filter(loadsSnapshot)).toEqual([]);

      // And a revision whose copy retention has already cleared is no evidence.
      await submissions.update({ phaseStateId: ids.requirements }, { workspaceSnapshot: null });
      expect((await service.phaseDetail(learner, ids.requirements)).evidenceNeeded).toEqual([
        { key: '', title: phaseOf(shipped, 'requirements').title },
      ]);
      queries = [];
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');
      expect(queries.filter(loadsSnapshot)).toEqual([]);
    });
  });

  /**
   * The board tells a reviewed pass from a teacher's credit.
   *
   * `EnrollmentView.phases[].passKind` is what the surfaces that draw every
   * phase at once (the phases card, home, the printable record) read to say
   * "Credit awarded, review still needed" instead of a pass. It is the gate's
   * own predicate (`passKindOf` asks `phaseGaps`), on a phase behind, at or
   * ahead of the learner, and it moves nothing: `advance` answers as it would without it.
   */
  describe('what the board says about each pass', () => {
    const board = async (slug: string): Promise<EnrolledPhaseSummary[]> =>
      (await service.myEnrollment(learner, slug))!.phases as EnrolledPhaseSummary[];
    const kindOf = async (slug: string, key: string): Promise<EnrolledPhaseSummary> =>
      (await board(slug)).find((one) => one.key === key)!;

    it('reads a reviewed pass as reviewed', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await evidence(shipped, 'requirements', '');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 80 });

      expect((await kindOf('tasktrackr', 'requirements')).passKind).toBe('reviewed');
      await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    it("reads a teacher's credit with no reviewed pass as credit, and the gate still refuses it", async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 70 });

      const phase = await kindOf('tasktrackr', 'requirements');
      expect(phase.status).toBe('passed');
      expect(phase.passKind).toBe('credit');
      // The field moves nothing: the gate refuses as it did, and the board's
      // own facts are what they were.
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');
      expect(phase.passedAt).toBe('2026-09-18T10:00:00.000Z');
      expect(phase.bestScore).toBe(70);
    });

    it('reads credit, then reviewed once the reviewed pass of its own is in', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await setTask('requirements', 'story', passedRow);
      // What `task-signoff` writes on the second task: passed, no revision.
      await setTask('requirements', 'scope', { ...passedRow, signedOffBy: 'ms-tan', signedOffAt: '2026-09-18T10:00:00.000Z' });
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });

      expect((await kindOf(TEACHER, 'requirements')).passKind).toBe('credit');
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');

      await evidence(teacher, 'requirements', 'scope');
      expect((await kindOf(TEACHER, 'requirements')).passKind).toBe('reviewed');
      await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    it('answers on a phase the learner has already left: reviewed, and credit after a reset and a re-pass', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      const scope = await evidence(teacher, 'requirements', 'scope');
      await setTask('requirements', 'story', passedRow);
      await setTask('requirements', 'scope', passedRow);
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });
      await service.advance(learner, ids.requirements);

      expect((await kindOf(TEACHER, 'requirements')).passKind).toBe('reviewed');

      // A reset of `scope` (its revision stamped with the run that ended, the
      // row's count raised), then a teacher's Mark as passed with no new
      // revision: the board reads passed behind the learner, and the room's
      // `evidenceNeeded` says nothing there (it is asked only where Continue
      // is drawn). The board says credit.
      await submissions.update(scope.id, { resetEpoch: 0 });
      await setTask('requirements', 'scope', { ...passedRow, resetCount: 1 });
      expect('evidenceNeeded' in (await service.phaseDetail(learner, ids.requirements))).toBe(false);
      expect((await kindOf(TEACHER, 'requirements')).passKind).toBe('credit');
    });

    // A credit names the tasks the gate still wants, and which
    // of them wait only on the teacher's countersignature, so a reader says
    // "Awaiting your teacher's sign-off" where that is all that is missing.
    it('names what a credit still wants: a task with no review, or one awaiting only the countersignature', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher, { signOff: true }) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await setTask('requirements', 'story', passedRow);
      // A phase-wide Mark as passed over `scope`, a sign-off task with no
      // review yet: the lever leaves a sign-off task's row as it was.
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });
      expect(await kindOf(TEACHER, 'requirements')).toMatchObject({ passKind: 'credit', creditTasks: [{ key: 'scope' }] });
      expect((await kindOf(TEACHER, 'requirements')).creditTasks![0]).not.toHaveProperty('awaitsSignOff');

      // Its review passes: the row waits on the countersignature, and that is
      // all the gate still wants.
      await evidence(teacher, 'requirements', 'scope');
      await setTask('requirements', 'scope', { status: 'submitted', awaitingSignOff: true, bestScore: 80 });
      expect(await kindOf(TEACHER, 'requirements')).toMatchObject({
        passKind: 'credit',
        creditTasks: [{ key: 'scope', awaitsSignOff: true }],
      });
      await expect(service.advance(learner, ids.requirements)).rejects.toThrow('strict evidence review');

      // The countersignature lands: a reviewed pass, nothing named.
      await setTask('requirements', 'scope', { ...passedRow, awaitingSignOff: false, signedOffBy: 'ms-tan', signedOffAt: '2026-09-18T11:00:00.000Z' });
      const signed = await kindOf(TEACHER, 'requirements');
      expect(signed.passKind).toBe('reviewed');
      expect('creditTasks' in signed).toBe(false);
    });

    it("names the sole task of a shipped phase on a teacher's credit, never as awaiting a sign-off", async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 70 });
      const phase = await kindOf('tasktrackr', 'requirements');
      expect(phase.passKind).toBe('credit');
      expect(phase.creditTasks).toHaveLength(1);
      expect(phase.creditTasks![0]).not.toHaveProperty('awaitsSignOff');
    });

    // The field costs no extra pool connections at once: the phases are asked
    // one at a time, and the countersignature question reads
    // the task rows the board read already holds.
    it('asks one passed phase at a time, and reads no task row of its own for the countersignature', async () => {
      install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher, { signOff: true }) });
      await enrol(TEACHER);
      await evidence(teacher, 'requirements', 'story');
      await evidence(teacher, 'requirements', 'scope');
      await setTask('requirements', 'story', passedRow);
      await setTask('requirements', 'scope', { status: 'submitted', awaitingSignOff: true, bestScore: 80 });
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });
      await evidence(teacher, 'design', '');
      await setPhase('design', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });
      await setPhase('implementation', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z' });

      const asked = service as unknown as { passKindFor: (...args: unknown[]) => Promise<unknown> };
      const real = asked.passKindFor.bind(service);
      let inFlight = 0;
      let peak = 0;
      jest.spyOn(asked, 'passKindFor').mockImplementation(async (...args: unknown[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          return await real(...args);
        } finally {
          inFlight -= 1;
        }
      });
      queries = [];
      const phases = await board(TEACHER);

      expect(peak).toBe(1);
      expect(phases.find((one) => one.key === 'requirements')).toMatchObject({
        passKind: 'credit',
        creditTasks: [{ key: 'scope', awaitsSignOff: true }],
      });
      expect(phases.find((one) => one.key === 'design')!.passKind).toBe('reviewed');
      expect(phases.find((one) => one.key === 'implementation')!.passKind).toBe('credit');
      // The board's own read of the rows, and the gate's per-task reads; none
      // of them asks for the countersignature by key.
      expect(queries.some((sql) => /SELECT[\s\S]*"awaitingSignOff"[\s\S]*FROM\s+"?task_states"?[\s\S]*"taskKey"\s+IN/i.test(sql))).toBe(false);
    });

    // The credit after a reset holds on an authored task list
    // only. A sole task has no run to leave (its revisions are asked whatever
    // their `resetEpoch`), so there the earlier reviewed pass still counts,
    // exactly as `advance` counts it. This pins that present behaviour.
    it('mirrors advance on a sole-task phase: a Retry, then Mark as passed, still reads reviewed and advance accepts it', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      const reviewed = await evidence(shipped, 'requirements', '');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 80 });
      expect((await kindOf('tasktrackr', 'requirements')).passKind).toBe('reviewed');

      // The Retry (the phase back in progress, the revision stamped as a
      // reset stamps one), then a teacher's Mark as passed with no new revision.
      await submissions.update(reviewed.id, { resetEpoch: 0 });
      await setPhase('requirements', { status: 'in_progress' });
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-19T10:00:00.000Z' });

      expect((await kindOf('tasktrackr', 'requirements')).passKind).toBe('reviewed');
      await expect(service.advance(learner, ids.requirements)).resolves.toBeDefined();
    });

    it('mirrors advance on a sole-task phase already left: a reset, then Mark as passed, still reads reviewed', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      const reviewed = await evidence(shipped, 'requirements', '');
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-18T10:00:00.000Z', bestScore: 80 });
      await service.advance(learner, ids.requirements);

      await submissions.update(reviewed.id, { resetEpoch: 0 });
      await setPhase('requirements', { status: 'in_progress' });
      await setPhase('requirements', { status: 'passed', passedAt: '2026-09-19T10:00:00.000Z' });

      expect((await kindOf('tasktrackr', 'requirements')).passKind).toBe('reviewed');
    });

    it('says nothing on a phase that is not passed, and asks nothing of its revisions', async () => {
      install({ versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) });
      await enrol('tasktrackr');
      await evidence(shipped, 'requirements', '');
      queries = [];

      const phases = await board('tasktrackr');
      expect(phases.find((one) => one.key === 'requirements')!.status).toBe('in_progress');
      for (const phase of phases) expect('passKind' in phase).toBe(false);
      expect(queries.some((sql) => /FROM\s+"?submissions"?[\s\S]*"?passed"?\s*=/i.test(sql))).toBe(false);
    });
  });
});

/*
 * The learner's phase views carry the phase's provenance. `PhaseSummary.scenario` is the
 * roll-up and `PhaseSummary.intro` the intro's opening, at most
 * PHASE_SUMMARY_INTRO_MAX characters; `PhaseDetail.provenance` is the whole
 * view and `PhaseDetail.stakeholder` the interview's name and role, never a
 * fact. The resolver is asked of the pinned base phase: the registry's own
 * object, and never of the phase the accepted screen copy was laid over.
 */
import { PHASE_SUMMARY_INTRO_MAX } from '@learnsdlc/shared';
import * as provenanceModule from '../authoring/provenance';

describe('summaryIntro', () => {
  it('hands an intro at or under the limit back whole', () => {
    expect(summaryIntro('Short intro.')).toBe('Short intro.');
    const exact = 'a'.repeat(PHASE_SUMMARY_INTRO_MAX);
    expect(summaryIntro(exact)).toBe(exact);
    expect(summaryIntro(null)).toBe('');
    expect(summaryIntro(undefined)).toBe('');
  });

  it('cuts a longer intro at a word, under the limit, with an ellipsis', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const out = summaryIntro(words);
    expect(out.length).toBeLessThanOrEqual(PHASE_SUMMARY_INTRO_MAX);
    expect(out.endsWith('…')).toBe(true);
    const kept = out.slice(0, -1);
    expect(words.startsWith(kept)).toBe(true);
    // the cut falls between two words, never inside one
    expect(words[kept.length]).toBe(' ');
    expect(kept.endsWith(' ')).toBe(false);
  });

  it('cuts hard when no space is near the limit', () => {
    const out = summaryIntro(`${'x'.repeat(10)} ${'y'.repeat(900)}`);
    expect(out).toHaveLength(PHASE_SUMMARY_INTRO_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toBe(`${'x'.repeat(10)} ${'y'.repeat(PHASE_SUMMARY_INTRO_MAX - 12)}`);
  });
});

describe("the learner's phase views carry provenance", () => {
  let dataSource: DataSource;
  let phaseStates: Repository<PhaseStateEntity>;
  let content: ContentService;
  let service: WorkflowService;
  const learner = 'provenance-learner';

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
  });
  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    const feedback = { latestFor: async () => null, runSmokeCheck: jest.fn() } as unknown as FeedbackService;
    service = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      phaseStates,
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      feedback,
      dataSource,
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const enrol = async (): Promise<Record<string, string>> => {
    const view = await service.enroll(learner, 'tasktrackr');
    return Object.fromEntries(view.phases.map((p) => [p.key, p.id]));
  };
  const registryPhase = async (key: string): Promise<PhaseContent> => {
    const enrollment = await dataSource.getRepository(EnrollmentEntity).findOneByOrFail({ userId: learner });
    return content.getForEnrollment(enrollment).phases.find((p) => p.key === key)!;
  };

  it("gives every summary of a reference enrolment the roll-up 'reference' and the intro whole when it fits", async () => {
    await enrol();
    const view = (await service.myEnrollment(learner, 'tasktrackr'))!;
    expect(view.phases).toHaveLength(content.getProject('tasktrackr').phases.length);
    for (const summary of view.phases) {
      const phase = content.getPhase('tasktrackr', summary.key);
      expect(summary.scenario).toBe('reference');
      // whole when it fits; Design's Background (4.0.0, up to 2,000 characters) is cut at a word, with an ellipsis
      if (phase.intro.length <= PHASE_SUMMARY_INTRO_MAX) expect(summary.intro).toBe(phase.intro);
      else {
        expect(summary.intro!.length).toBeLessThanOrEqual(PHASE_SUMMARY_INTRO_MAX);
        expect(summary.intro!.endsWith('\u2026')).toBe(true);
        expect(phase.intro.startsWith(summary.intro!.slice(0, -1))).toBe(true);
      }
    }
    expect(view.phases.some((summary) => content.getPhase('tasktrackr', summary.key).intro.length <= PHASE_SUMMARY_INTRO_MAX)).toBe(true);
  });

  it("gives the Requirements detail the whole provenance and the stakeholder's name and role, never a fact", async () => {
    const ids = await enrol();
    await phaseStates.update({ id: ids.requirements }, { status: 'in_progress' });
    const detail = await service.phaseDetail(learner, ids.requirements);
    const base = await registryPhase('requirements');
    expect(detail.scenario).toBe('reference');
    expect(detail.provenance).toEqual(expect.objectContaining({ phaseKey: 'requirements', rollup: 'reference', intro: 'reference', interview: 'reference' }));
    expect(detail.stakeholder).toEqual({ name: base.interview!.persona.name, role: base.interview!.persona.role });
    const serialised = JSON.stringify({ provenance: detail.provenance, stakeholder: detail.stakeholder });
    for (const fact of base.interview!.facts) expect(serialised).not.toContain(fact.answer);
    // the detail's own intro is the whole intro
    expect(detail.intro).toBe(base.intro);
  });

  it('gives a phase with no interview a null stakeholder', async () => {
    const ids = await enrol();
    await phaseStates.update({ id: ids.design }, { status: 'in_progress' });
    const detail = await service.phaseDetail(learner, ids.design);
    expect((await registryPhase('design')).interview ?? null).toBeNull();
    expect(detail.stakeholder).toBeNull();
    expect(detail.provenance!.phaseKey).toBe('design');
  });

  it("cuts a long intro on the summary, and keeps it whole on the detail", async () => {
    const ids = await enrol();
    await phaseStates.update({ id: ids.requirements }, { status: 'in_progress' });
    const project = content.getProject('tasktrackr');
    const original = project.phases;
    const long = Array.from({ length: 150 }, (_, i) => `sentence${i}`).join(' ');
    project.phases = original.map((phase) => (phase.key === 'requirements' ? { ...phase, intro: long } : phase));
    try {
      const summary = (await service.myEnrollment(learner, 'tasktrackr'))!.phases.find((p) => p.key === 'requirements')!;
      expect(summary.intro).toBe(summaryIntro(long));
      expect(summary.intro!.length).toBeLessThanOrEqual(PHASE_SUMMARY_INTRO_MAX);
      expect(summary.intro!.endsWith('…')).toBe(true);
      // the teacher's own intro makes the phase mixed, not the reference's
      expect(summary.scenario).toBe('mixed');
      const detail = await service.phaseDetail(learner, ids.requirements);
      expect(detail.intro).toBe(long);
      expect(detail.provenance!.intro).toBe('own');
    } finally {
      project.phases = original;
    }
  });

  it('asks the resolver of the registry phase, never of the phase the accepted screen copy was laid over', async () => {
    const ids = await enrol();
    await phaseStates.update({ id: ids.implementation }, {
      status: 'in_progress',
      acceptedScreenCopy: { version: 1, sourceSubmissionId: 'sub-1', sourcePhaseStateId: ids.design, title: 'Late work', empty: 'Nothing is late.' } as never,
    });
    const spy = jest.spyOn(provenanceModule, 'phaseProvenance');
    const detail = await service.phaseDetail(learner, ids.implementation);
    const base = await registryPhase('implementation');
    // the room itself carries the learner's copy …
    expect(detail.acceptedScreenCopy).toEqual(expect.objectContaining({ title: 'Late work' }));
    // … and the resolver read the pinned base, the registry's own object
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      if (call[0].key === 'implementation') expect(call[0]).toBe(base);
    }
    expect(spy.mock.calls.some((call) => call[0].key === 'implementation')).toBe(true);
    expect(detail.provenance!.application).toBe(detail.provenance!.referenceName);
  });

  it('leaves scenario, intro and provenance off when the resolver cannot answer', async () => {
    const ids = await enrol();
    await phaseStates.update({ id: ids.requirements }, { status: 'in_progress' });
    jest.spyOn(provenanceModule, 'phaseProvenance').mockImplementation(() => {
      throw new Error('unreadable');
    });
    const summary = (await service.myEnrollment(learner, 'tasktrackr'))!.phases.find((p) => p.key === 'requirements')!;
    expect('scenario' in summary).toBe(false);
    expect('intro' in summary).toBe(false);
    const detail = await service.phaseDetail(learner, ids.requirements);
    expect('provenance' in detail).toBe(false);
    expect('scenario' in detail).toBe(false);
    // the detail's intro is its own, whole, whatever the resolver said
    expect(detail.intro).toBe((await registryPhase('requirements')).intro);
  });
});
