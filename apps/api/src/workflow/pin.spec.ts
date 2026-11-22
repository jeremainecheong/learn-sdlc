import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { SOLE_TASK_KEY } from '@learnsdlc/shared';
import { ContentService, type RegisteredVersion } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import { SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH } from '../content/screen-copy';
import { AssistantService } from '../assistant/assistant.service';
import {
  AiCacheEntity,
  ALL_ENTITIES,
  AssistantMessageEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  NotificationEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { EventsGateway } from '../events/events.gateway';
import { ExecutionService, runInputHash } from '../execution/execution.service';
import { FeedbackService } from '../feedback/feedback.service';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { ViewAsService } from '../instructor/view-as.service';
import { NotificationsService } from '../notifications/notifications.service';
import { acceptedDesignScreenCopy, resolveScreenCopy } from './accepted-screen-copy';
import { WorkflowService } from './workflow.service';

/*
 * The grading-and-workflow half of the pin: every content resolution an
 * enrolment owns takes the *pinned* version, and the read paths still repair a
 * board whose rows went missing.
 *
 * The repair must not be guarded by `enrollment.packVersion ===
 * project.version`, which is a statement about a *string* and not about the
 * learner's board: the string is written by `writeEnrollment` at enrol time
 * from the very version the read then compares it against, so such a guard is
 * permanently true for every enrolment made against the pack it is loaded
 * with, and under the pin, where the pinned version's string is a constant
 * for the life of the enrolment: the only read-path repair would be dead for
 * ever.
 */

/** The two published version ids this file pins enrolments to. */
const V1 = 'pv-tasktrackr-1';
const V2 = 'pv-tasktrackr-2';

/**
 * Two published versions of the shipped pack, differing at exactly the places
 * enrolment-scoped call sites read.
 *
 * - `version` and `title`, for `packVersionFor` and `enrollmentView`;
 * - every phase's `title`, for the three board reads and the room;
 * - an editable `pinned/<tag>.md` in every phase, for the workspace save's
 *   editable set, for the Run's file map and for `designSources`;
 * - one extra rubric criterion in v2, so a submission evidenced against v1 is
 *   a pass under v1 and not under v2, which is what `advance` and
 *   `acceptedDesignScreenCopy` read through `strictEvidencePassed`;
 * - and v2 drops the accepted-screen-copy file from Implementation, which is
 *   the one thing `resolveScreenCopy`'s own `getPhaseForEnrollment` call looks
 *   at (`accepted-screen-copy.ts:50`).
 *
 * A real second version would be a second pack; this is the shipped one cut
 * twice, because what is under test is which of two snapshots a call reaches,
 * not what a teacher can author.
 */
function versionOf(shipped: ProjectContent, tag: 'v1' | 'v2'): ProjectContent {
  const phase = (base: PhaseContent): PhaseContent => {
    const files = [
      ...base.files,
      { path: `pinned/${tag}.md`, content: `${tag} only`, editable: true, language: 'markdown' },
    ];
    return {
      ...base,
      title: `${base.title} (${tag})`,
      files:
        tag === 'v2' && base.key === 'implementation'
          ? files.filter((file) => file.path !== SCREEN_COPY_PATH)
          : files,
      rubric:
        tag === 'v2'
          ? {
              ...base.rubric,
              criteria: [
                ...base.rubric.criteria,
                {
                  key: 'v2-only',
                  title: 'A question only the second version asks',
                  weight: 0,
                  description: 'Evidence cut against v1 cannot answer it, which is the point.',
                },
              ],
            }
          : base.rubric,
    };
  };
  return {
    ...shipped,
    version: tag === 'v1' ? '1.0.0' : '2.0.0',
    title: `${shipped.title} (${tag})`,
    phases: shipped.phases.map(phase),
  };
}

describe('the pin, and the board the read paths repair', () => {
  let dataSource: DataSource;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let releases: Repository<ReleaseRecordEntity>;
  let content: ContentService;
  let service: WorkflowService;
  let warn: jest.SpyInstance;
  let v1: ProjectContent;
  let v2: ProjectContent;
  let published: RegisteredVersion[];

  const learner = 'learner-1';
  const legacy = 'learner-2';

  /** Enrol, then hand back the phase state ids by key. */
  const enrol = async (userId = learner): Promise<Record<string, string>> => {
    const view = await service.enroll(userId, 'tasktrackr');
    return Object.fromEntries(view.phases.map((p) => [p.key, p.id]));
  };

  /**
   * Move an enrolment back onto a superseded published version: what a
   * learner who started last term holds. `enroll` pins to the head of the
   * moment, so this is the only way to make the head and the pin differ.
   */
  const pinTo = async (userId: string, versionId: string, packVersion: string): Promise<EnrollmentEntity> => {
    const enrollment = await enrollments.findOneByOrFail({ userId });
    await enrollments.update(enrollment.id, { projectVersionId: versionId, packVersion });
    return enrollments.findOneByOrFail({ id: enrollment.id });
  };

  /** A row from before the model had versions: no pin, and a read must not invent one. */
  const unpin = async (userId: string): Promise<EnrollmentEntity> => {
    const enrollment = await enrollments.findOneByOrFail({ userId });
    await enrollments.update(enrollment.id, { projectVersionId: null });
    return enrollments.findOneByOrFail({ id: enrollment.id });
  };

  /** A board that lost its last room to a crash, a restore or a half-written enrolment. */
  const loseTheLastPhase = async (enrollmentId: string): Promise<void> => {
    const project = content.getProject('tasktrackr');
    const last = project.phases[project.phases.length - 1];
    await phaseStates.delete({ enrollmentId, phaseOrder: last.order });
  };

  const boardSize = (enrollmentId: string): Promise<number> =>
    phaseStates.count({ where: { enrollmentId } });

  const phaseCount = (): number => content.getProject('tasktrackr').phases.length;

  /** Unlock a room, so a whole-board read has something to fan out to. */
  const open = async (id: string): Promise<void> => {
    await phaseStates.update(id, { status: 'in_progress' });
  };

  /** The retained screen contract a Design pass has to carry to be an accepted source. */
  const screenContract = {
    [SCREEN_CONTRACT_PATH]: JSON.stringify({
      screens: [{ route: '#/overdue', title: 'Late work', empty: 'Nothing is overdue.' }],
    }),
  };

  /**
   * A phase passed on retained, strict evidence: the only thing `advance`
   * accepts. The same fixture `workflow.service.spec.ts`'s `open` writes,
   * kept local to this file.
   */
  const pass = async (
    id: string,
    project: ProjectContent = content.getProject('tasktrackr'),
    workspaceSnapshot: Record<string, string> = { fixture: 'pin test evidence' },
  ): Promise<void> => {
    const state = await phaseStates.findOneByOrFail({ id });
    await phaseStates.update(id, { status: 'passed', bestScore: 80 });
    const phase = project.phases.find((p) => p.key === state.phaseKey)!;
    await dataSource.getRepository(SubmissionEntity).save({
      userId: state.userId,
      phaseStateId: id,
      status: 'completed',
      passed: true,
      workspaceSnapshot,
      contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
      report: {
        assessmentMode: 'strict_binary',
        passed: true,
        checks: [
          {
            id: 'fixture',
            label: 'Mocked assessment fixture',
            status: 'passed',
            detail: 'The pin test isolates the board, not the grader.',
          },
        ],
        tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
        aiReview: {
          provider: 'mock-ai',
          verdict: 'pass',
          criteriaEvidence: phase.rubric.criteria.map((c) => ({
            key: c.key,
            met: true,
            evidence: 'Fixture evidence for the board test only.',
            issue: '',
            nextStep: '',
          })),
        },
      } as never,
    });
  };

  /**
   * How many times a call asked the repair's own question. The probe is
   * `fillMissingPhaseStates`' first statement and the only `phaseStates.find`
   * in the service that carries a `select` (`workflow.service.ts:398-401`), so
   * counting those calls counts repairs rather than reads.
   */
  const countRepairProbes = (): { probes: () => number; stop: () => void } => {
    const spy = jest.spyOn(phaseStates, 'find');
    return {
      probes: () =>
        spy.mock.calls.filter((call) => Boolean((call[0] as { select?: unknown } | undefined)?.select))
          .length,
      stop: () => spy.mockRestore(),
    };
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    // The directory read is the fixture's source, not the runtime's: two
    // published versions are cut from it and installed the way
    // `ProjectRegistryService` installs the rows it reads out of
    // `project_versions`, so every resolution below goes through the same map
    // a deployment answers from.
    content.loadAll();
    const shipped = content.getProject('tasktrackr');
    v1 = versionOf(shipped, 'v1');
    v2 = versionOf(shipped, 'v2');
    published = [
      { versionId: V1, content: v1 },
      { versionId: V2, content: v2 },
    ];
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    releases = dataSource.getRepository(ReleaseRecordEntity);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    // Both versions published, v2 the head: the shape a deployment is in the
    // day after a content fix lands. One test publishes them in order instead,
    // so the install is redone per test rather than once.
    content.installVersions(published);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const feedback = {
      latestFor: async () => null,
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

  it('reconcile-repairs-a-pinned-board', async () => {
    const ids = await enrol();
    const enrollment = await pinTo(learner, V1, content.getProject('tasktrackr').version);
    const phases = content.getProject('tasktrackr').phases.length;

    // Each read path in turn, and each one on its own missing row: the point of
    // the enumeration is that a learner who never opens the dashboard is
    // repaired too, so it is not enough for one of the three to do the work.
    await loseTheLastPhase(enrollment.id);
    expect(await boardSize(enrollment.id)).toBe(phases - 1);
    await service.phaseSummaries(learner, 'tasktrackr');
    expect(await boardSize(enrollment.id)).toBe(phases);

    await loseTheLastPhase(enrollment.id);
    await service.enrollmentView(await enrollments.findOneByOrFail({ id: enrollment.id }));
    expect(await boardSize(enrollment.id)).toBe(phases);

    await loseTheLastPhase(enrollment.id);
    await service.phaseDetail(learner, ids.requirements);
    expect(await boardSize(enrollment.id)).toBe(phases);

    // And it says so. A board rebuilt underneath a learner is not a routine
    // event, and the warning is the only trace of it.
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining(`enrolment ${enrollment.id} was missing 1 phase state`)]),
    );
  });

  it('repairs the board the learner walks back onto, not just the one they enrol on', async () => {
    const ids = await enrol();
    const enrollment = await pinTo(learner, V1, content.getProject('tasktrackr').version);
    // A row from the middle of the board, and the row the learner is holding
    // open: a repair that only appends to the end is not a repair.
    await phaseStates.delete({ enrollmentId: enrollment.id, phaseOrder: 4 });
    await phaseStates.delete({ enrollmentId: enrollment.id, phaseOrder: 5 });

    const detail = await service.phaseDetail(learner, ids.requirements);

    expect(detail.key).toBe('requirements');
    const orders = (
      await phaseStates.find({ where: { enrollmentId: enrollment.id }, order: { phaseOrder: 'ASC' } })
    ).map((state) => state.phaseOrder);
    expect(orders).toEqual(content.getProject('tasktrackr').phases.map((p) => p.order));
    // A rebuilt row claims no pass the learner cannot evidence, and locks no
    // phase they have already walked through: `newPhaseState`'s rule, asserted
    // here because the repair is reached on every load, not only when a
    // version string moved.
    const repaired = await phaseStates.findOneByOrFail({ enrollmentId: enrollment.id, phaseOrder: 4 });
    expect([repaired.status, repaired.bestScore, repaired.passedAt]).toEqual(['locked', null, null]);
  });

  it('the reconcile does not rewrite a pinned enrolment\'s version', async () => {
    const ids = await enrol();
    // Pinned to a superseded version: the stamp names the version that grades
    // this learner's work, so a read that refreshes it to the head is the lie
    // the pin exists to stop.
    const enrollment = await pinTo(learner, V1, '1.0.0');
    await loseTheLastPhase(enrollment.id);

    await service.phaseSummaries(learner, 'tasktrackr');
    await service.phaseDetail(learner, ids.requirements);

    const held = await enrollments.findOneByOrFail({ id: enrollment.id });
    expect(held.packVersion).toBe('1.0.0');
    expect(held.projectVersionId).toBe(V1);
    expect(await boardSize(enrollment.id)).toBe(content.getProject('tasktrackr').phases.length);
  });

  it('still re-stamps a legacy unpinned enrolment, which has no other record of its pack', async () => {
    // Regression guard. An enrolment
    // with no pin has only `packVersion` to say which rules it started under,
    // and `reconcileToPack` is the one writer of it after enrol time.
    await enrol(legacy);
    // `enroll` pins every new enrolment now, so the legacy shape has to be
    // made rather than assumed: no pin, and a stamp from before the term.
    const enrollment = await unpin(legacy);
    await enrollments.update(enrollment.id, { packVersion: '0.9.0' });

    await service.phaseSummaries(legacy, 'tasktrackr');

    const held = await enrollments.findOneByOrFail({ id: enrollment.id });
    expect(held.packVersion).toBe(content.getProject('tasktrackr').version);
    expect(held.projectVersionId).toBeNull();
  });

  it('a legacy null pin resolves the published head, and no read writes one', async () => {
    // Regression guard: a null pin resolves the head, and a read never invents
    // a pin for a row that has none.
    const ids = await enrol(legacy);
    await unpin(legacy);
    const project = content.getProject('tasktrackr');

    const view = await service.enrollmentView(await enrollments.findOneByOrFail({ userId: legacy }));
    const detail = await service.phaseDetail(legacy, ids.requirements);

    expect(view.projectTitle).toBe(project.title);
    expect(view.packVersion).toBe(project.version);
    expect(detail.title).toBe(project.phases[0].title);
    expect((await enrollments.findOneByOrFail({ userId: legacy })).projectVersionId).toBeNull();
  });

  it('sends the pin on the enrolment view, as the shared type declares it: the version id, or null for a legacy row', async () => {
    // The shared `EnrollmentView` has declared `projectVersionId` since the pin landed, and the view never sent
    // it, so a client reading it saw undefined, "a body from an older API", on every enrolment.
    await enrol();
    await pinTo(learner, V1, '1.0.0');
    const pinned = await service.enrollmentView(await enrollments.findOneByOrFail({ userId: learner }));
    expect(pinned.projectVersionId).toBe(V1);
    await enrol(legacy);
    await unpin(legacy);
    const unpinned = await service.enrollmentView(await enrollments.findOneByOrFail({ userId: legacy }));
    expect(unpinned).toHaveProperty('projectVersionId', null);
    // A read sends what the row holds and writes nothing.
    expect((await enrollments.findOneByOrFail({ userId: legacy })).projectVersionId).toBeNull();
  });

  it('leaves the board alone when the read is told it may not write', async () => {
    // `ViewAsService.phase` and `.enrollment` reach exactly these two methods,
    // with the learner's own id (`view-as.service.ts:133`, `:106`), and the
    // sentence the six instructor reads rest on is that they are "provably
    // read-only" (`view-as.service.ts:38-41`). The repair is a write carrying
    // `userId: enrollment.userId`, so a teacher looking at a holed board must
    // be able to look without filling it in.
    const ids = await enrol();
    const enrollment = await pinTo(learner, V1, content.getProject('tasktrackr').version);
    await loseTheLastPhase(enrollment.id);

    const detail = await service.phaseDetail(learner, ids.requirements, 'full', false);
    const view = await service.myEnrollment(learner, 'tasktrackr', false);

    // The answer is the same answer: this is a read that declines to write,
    // not a read that refuses.
    expect(detail.key).toBe('requirements');
    expect(view!.phases).toHaveLength(phaseCount() - 1);
    expect(await boardSize(enrollment.id)).toBe(phaseCount() - 1);
    expect(warn).not.toHaveBeenCalled();

    // And nothing is lost by declining: the learner's own next read repairs it.
    await service.phaseDetail(learner, ids.requirements);
    expect(await boardSize(enrollment.id)).toBe(phaseCount());
  });

  it('repairs a whole-board read once, not once per open phase', async () => {
    const ids = await enrol();
    const enrollment = await pinTo(learner, V1, content.getProject('tasktrackr').version);
    // Four open rooms is a learner four phases in, the load the batched board
    // reads are measured against.
    for (const key of ['design', 'implementation', 'testing']) await open(ids[key]);
    await loseTheLastPhase(enrollment.id);

    const counted = countRepairProbes();
    await service.phaseSummaries(learner, 'tasktrackr');
    const probes = counted.probes();
    counted.stop();

    // The dashboard repairs the board once and then describes it. The fan-out
    // to `phaseDetail` re-asking per open phase is four more indexed reads per
    // dashboard load, for a board the same request has already made whole.
    expect(probes).toBe(1);
    expect(await boardSize(enrollment.id)).toBe(phaseCount());
  });

  it('refuses the missing room on the way through it, and builds it on the next read', async () => {
    // Regression guard. The stamp is on `loadOwnedState` and the repair on the
    // reads, so `advance`, `saveWorkspace`, run and submit do not repair, even
    // for a legacy unpinned enrolment whose stamp has moved. Stated here as the
    // deliberate rule `reconcileToPack`'s comment gives.
    const ids = await enrol();
    const enrollment = await unpin(learner);
    await enrollments.update(enrollment.id, { packVersion: '0.9.0' });
    await pass(ids.requirements);
    await phaseStates.delete({ enrollmentId: enrollment.id, phaseOrder: 2 });

    await expect(service.advance(learner, ids.requirements)).rejects.toThrow(
      'next phase record is missing',
    );
    expect(await boardSize(enrollment.id)).toBe(phaseCount() - 1);
    expect((await enrollments.findOneByOrFail({ id: enrollment.id })).currentPhaseOrder).toBe(1);

    await service.phaseDetail(learner, ids.requirements);
    expect(await boardSize(enrollment.id)).toBe(phaseCount());
  });

  it('says nothing about a board that is whole', async () => {
    // The repair is reached on every read now, so it has to be silent when
    // there is nothing to repair: a warning on every load is a warning nobody
    // reads.
    const ids = await enrol();
    await pinTo(learner, V1, content.getProject('tasktrackr').version);

    await service.phaseSummaries(learner, 'tasktrackr');
    await service.phaseDetail(learner, ids.requirements);

    expect(warn).not.toHaveBeenCalled();
  });

  /*
   * The pin's own rows. Each one names the call site it covers, and each one
   * is two-sided: the same call on an enrolment pinned
   * to the head answers v2, so a test that went green because everything
   * answers v1 would fail.
   */

  it('every enrolment-scoped resolution in workflow takes the pinned version', async () => {
    const ids = await enrol();
    const pinned = await pinTo(learner, V1, '1.0.0');
    const headIds = await enrol(legacy);
    const head = await enrollments.findOneByOrFail({ userId: legacy });

    // Five rows, one per enrolment-scoped call site, each resolved for the pinned
    // enrolment and for one pinned to the head, so the table cannot go green
    // over a call that resolves neither.
    const rows: [string, () => Promise<string>, () => Promise<string>][] = [
      [
        'workflow.service.ts phaseSummaries',
        async () =>
          (await service.phaseSummaries(learner, 'tasktrackr')).find((d) => d.key === 'requirements')!
            .title,
        async () =>
          (await service.phaseSummaries(legacy, 'tasktrackr')).find((d) => d.key === 'requirements')!
            .title,
      ],
      [
        'workflow.service.ts enrollmentView (the project title)',
        async () => (await service.enrollmentView(pinned)).projectTitle,
        async () => (await service.enrollmentView(head)).projectTitle,
      ],
      [
        'workflow.service.ts enrollmentView (the board)',
        async () => (await service.enrollmentView(pinned)).phases[0].title,
        async () => (await service.enrollmentView(head)).phases[0].title,
      ],
      [
        'workflow.service.ts phaseDetail',
        async () => (await service.phaseDetail(learner, ids.requirements)).title,
        async () => (await service.phaseDetail(legacy, headIds.requirements)).title,
      ],
      [
        'workflow.service.ts loadOwnedState (the phase every room action holds)',
        async () => (await service.loadOwnedState(learner, ids.requirements)).phase.title,
        async () => (await service.loadOwnedState(legacy, headIds.requirements)).phase.title,
      ],
    ];

    for (const [site, onPin, onHead] of rows) {
      expect([site, await onPin()]).toEqual([site, expect.stringContaining('(v1)')]);
      expect([site, await onHead()]).toEqual([site, expect.stringContaining('(v2)')]);
    }

    // And the files the room hands over are the pinned version's, which is the
    // same resolution read the other way: a path only v2 carries is not in the
    // workspace a v1-pinned learner is given.
    const paths = (await service.phaseDetail(learner, ids.requirements)).files.map((f) => f.path);
    expect(paths).toContain('pinned/v1.md');
    expect(paths).not.toContain('pinned/v2.md');
  });

  it('the workspace save takes its editable set from the pinned version', async () => {
    // `workflow.service.ts:631` through `loadOwnedState`'s phase: a path the
    // head made editable is not editable for a learner who is not on the head,
    // and the refusal is the one the route already gives.
    const ids = await enrol();
    await pinTo(learner, V1, '1.0.0');

    await expect(
      service.saveWorkspace(learner, ids.requirements, { 'pinned/v2.md': 'from the head' }),
    ).rejects.toThrow('file is not editable: pinned/v2.md');
    const saved = await service.saveWorkspace(learner, ids.requirements, {
      'pinned/v1.md': 'from the version this learner started on',
    });
    expect(saved.workspace['pinned/v1.md']).toBe('from the version this learner started on');
  });

  it('advance is decided by the pinned version\'s rubric, not by the head\'s', async () => {
    // `workflow.service.ts:843`. `strictPass` hands the resolved phase to
    // `strictEvidencePassed`, which refuses evidence that does not answer every
    // criterion, so a learner pinned to v1 advances on v1's questions while
    // the same evidence on a head-pinned enrolment is refused by name.
    const ids = await enrol();
    const enrollment = await pinTo(learner, V1, '1.0.0');
    await pass(ids.requirements, v1);

    await service.advance(learner, ids.requirements);
    expect((await enrollments.findOneByOrFail({ id: enrollment.id })).currentPhaseOrder).toBe(2);

    const headIds = await enrol(legacy);
    await pass(headIds.requirements, v1);
    await expect(service.advance(legacy, headIds.requirements)).rejects.toThrow(
      'Submit this phase for a strict evidence review before advancing',
    );
  });

  it('the accepted screen copy is read out of the pinned version', async () => {
    // The two pinned reads in `accepted-screen-copy.ts`.
    //
    // `acceptedDesignScreenCopy` resolves the Design phase the retained evidence
    // is judged against, so v1's rubric accepts a v1-shaped pass and the head's
    // does not. `resolveScreenCopy` resolves the phase the state is on, and v2's Implementation carries no
    // accepted-copy file at all, which is the one thing that read asks.
    const ids = await enrol();
    const pinned = await pinTo(learner, V1, '1.0.0');
    await pass(ids.design, v1, screenContract);

    expect(
      (await acceptedDesignScreenCopy(dataSource.manager, content, pinned))?.sourcePhaseStateId,
    ).toBe(ids.design);

    const headIds = await enrol(legacy);
    const head = await enrollments.findOneByOrFail({ userId: legacy });
    await pass(headIds.design, v1, screenContract);
    expect(await acceptedDesignScreenCopy(dataSource.manager, content, head)).toBeNull();

    // `:50`, both ways round, on the Implementation room. The cutoff is a date
    // no submission can be later than, so what decides the answer is which
    // version's Implementation phase the line resolves.
    await phaseStates.update(headIds.implementation, {
      status: 'in_progress',
      unlockedAt: '2099-01-01T00:00:00.000Z',
    });
    expect(
      await resolveScreenCopy(
        dataSource.manager,
        content,
        head,
        await phaseStates.findOneByOrFail({ id: headIds.implementation }),
      ),
    ).toBeNull();

    await phaseStates.update(ids.implementation, {
      status: 'in_progress',
      unlockedAt: '2099-01-01T00:00:00.000Z',
    });
    expect(
      await resolveScreenCopy(
        dataSource.manager,
        content,
        pinned,
        await phaseStates.findOneByOrFail({ id: ids.implementation }),
      ),
    ).toMatchObject({ sourcePhaseStateId: ids.design });
  });

  it('publishing a new head changes nothing a pinned learner is served', async () => {
    // The pin's promise, stated as the day it matters: the class enrols, a content
    // fix is published, and not one of the learner's answers moves. The
    // superseded version stays published and the pin keeps resolving it.
    content.installVersions([{ versionId: V1, content: v1 }]);
    const ids = await enrol();
    const enrollment = await enrollments.findOneByOrFail({ userId: learner });
    expect(enrollment.projectVersionId).toBe(V1);

    content.installVersions(published);
    expect(content.getProject('tasktrackr').version).toBe('2.0.0');

    const view = await service.enrollmentView(
      await enrollments.findOneByOrFail({ id: enrollment.id }),
    );
    const detail = await service.phaseDetail(learner, ids.requirements);
    expect(view.projectTitle).toBe(v1.title);
    expect(view.phases[0].title).toBe(v1.phases[0].title);
    expect(detail.title).toBe(v1.phases[0].title);
    expect(detail.files.map((f) => f.path)).toContain('pinned/v1.md');

    // And the pin and its stamp are left exactly where they were: a read is not
    // a migrate, and the migrate is the instructor's audited action.
    const held = await enrollments.findOneByOrFail({ id: enrollment.id });
    expect([held.projectVersionId, held.packVersion]).toEqual([V1, '1.0.0']);
  });

  it('a new enrolment is pinned to the head of the moment, and an existing one is never repinned', async () => {
    content.installVersions([{ versionId: V1, content: v1 }]);
    await enrol(legacy);
    expect((await enrollments.findOneByOrFail({ userId: legacy })).projectVersionId).toBe(V1);

    content.installVersions(published);
    await enrol();
    expect((await enrollments.findOneByOrFail({ userId: learner })).projectVersionId).toBe(V2);

    // A re-enrol (a double-tapped Start, a retried request) answers the
    // enrolment that exists and does not move it onto the new head.
    await enrol(legacy);
    expect((await enrollments.findOneByOrFail({ userId: legacy })).projectVersionId).toBe(V1);
  });

  it('a pin this deployment holds no row for still answers, out of the published head', async () => {
    // A row a class import wrote naming a version this machine never had. It is
    // a fault to be found, not a learner to be locked out: the head answers and
    // the log says so once.
    const ids = await enrol();
    await pinTo(learner, 'pv-from-another-machine', '1.0.0');

    const detail = await service.phaseDetail(learner, ids.requirements);

    expect(detail.title).toBe(v2.phases[0].title);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('holds no published row for'),
      ]),
    );
    expect((await enrollments.findOneByOrFail({ userId: learner })).projectVersionId).toBe(
      'pv-from-another-machine',
    );
  });
});

/*
 * The same table, in the three services that decide what a learner is graded
 * against, run and answered about: the graded phase, `packVersionFor` and
 * `designSources` in `feedback.service.ts`, the Run in `execution.service.ts`
 * and the mentor's phase context in `assistant.service.ts`, and
 * the read-only guarantee the instructor's view-as rests on.
 *
 * They are here rather than in each service's own spec because the assertion
 * is one fact about one enrolment: every one of these calls resolves the
 * version the learner holds, and not one of them resolves the published head.
 */
describe('the pin, in grading, in the sandbox, in the mentor and under view-as', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let workflow: WorkflowService;
  let feedback: FeedbackService;
  let execution: ExecutionService;
  let assistant: AssistantService;
  let viewAs: ViewAsService;
  let v1: ProjectContent;
  let v2: ProjectContent;
  let learnerId: string;
  let ids: Record<string, string>;

  const teacher: InstructorCaller = { id: 'an-instructor', role: 'ADMIN', cohort: 'default' };

  const enrollmentOf = (): Promise<EnrollmentEntity> =>
    dataSource.manager.findOneByOrFail(EnrollmentEntity, { userId: learnerId });

  /** Every row of the two tables an instructor's read must not touch. */
  const coursework = async (): Promise<unknown> => ({
    enrollments: await dataSource.manager.find(EnrollmentEntity, { order: { id: 'ASC' } }),
    phaseStates: await dataSource.manager.find(PhaseStateEntity, { order: { phaseOrder: 'ASC' } }),
  });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    const shipped = content.getProject('tasktrackr');
    v1 = versionOf(shipped, 'v1');
    v2 = versionOf(shipped, 'v2');
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    content.installVersions([
      { versionId: V1, content: v1 },
      { versionId: V2, content: v2 },
    ]);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
    feedback = new FeedbackService(
      dataSource.getRepository(SubmissionEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      {} as never,
      content,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: jest.fn(), register: jest.fn(), durable: false } as never,
      { emitJob: jest.fn() } as never,
      { onVerdict: jest.fn(async () => undefined) } as never,
    );
    execution = new ExecutionService(
      dataSource.getRepository(ExecutionRunEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      content,
      {} as never,
      { register: jest.fn(), durable: false } as never,
      { emitJob: jest.fn() } as never,
    );
    assistant = new AssistantService(
      dataSource.getRepository(AssistantMessageEntity),
      dataSource.getRepository(AiCacheEntity),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(SubmissionEntity),
      content,
      {} as never,
      {} as never,
      {} as never,
    );
    viewAs = new ViewAsService(
      dataSource,
      workflow,
      feedback,
      execution,
      assistant,
      {} as never,
      content,
    );

    const learner = await dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email: 'pinned@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'A learner who started last term',
      }),
    );
    learnerId = learner.id;
    const view = await workflow.enroll(learnerId, 'tasktrackr');
    ids = Object.fromEntries(view.phases.map((p) => [p.key, p.id]));
    // Enrolled on the head, then moved back onto the superseded version: what
    // a learner who started before the content fix holds.
    const enrollment = await enrollmentOf();
    await dataSource.manager.update(EnrollmentEntity, enrollment.id, {
      projectVersionId: V1,
      packVersion: '1.0.0',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('packVersionFor stamps the pinned version, not the head', async () => {
    // `packVersionFor` in `feedback.service.ts`. The head is 2.0.0 and the column that
    // says which rules graded this attempt has to read 1.0.0, or the regrade
    // tooling is reading a lie.
    const held = await workflow.loadOwnedState(learnerId, ids.requirements);
    const queued = await feedback.submit(held.phase, held.state);

    const stored = await dataSource.manager.findOneByOrFail(SubmissionEntity, { id: queued.id });
    expect(content.getProject('tasktrackr').version).toBe('2.0.0');
    expect(stored.packVersion).toBe('1.0.0');
  });

  it('the phase a submission is graded against is the pinned version\'s', async () => {
    // The phase `FeedbackService.submit` grades against.
    const held = await workflow.loadOwnedState(learnerId, ids.requirements);
    const queued = await feedback.submit(held.phase, held.state);
    const grading = jest
      .spyOn(feedback, 'buildReport')
      .mockResolvedValue({ overall: 0, passed: false, assessmentMode: 'strict_binary' } as never);

    await feedback.processSubmission({ id: queued.id });

    expect(grading.mock.calls[0][0].title).toBe(v1.phases[0].title);
    expect(grading.mock.calls[0][0].rubric.criteria.map((c) => c.key)).not.toContain('v2-only');
  });

  it('the conformance ledger reads the pinned version\'s design phase', async () => {
    // `designSources` in `feedback.service.ts`. It is private and is the
    // whole point of the line, so it is called by name.
    const held = await workflow.loadOwnedState(learnerId, ids.requirements);
    const sources = await (
      feedback as unknown as {
        designSources(phase: PhaseContent, state: PhaseStateEntity): Promise<Record<string, string>>;
      }
    ).designSources(held.phase, held.state);

    expect(Object.keys(sources)).toContain('pinned/v1.md');
    expect(Object.keys(sources)).not.toContain('pinned/v2.md');
  });

  it('a Run executes the pinned version\'s phase', async () => {
    // The phase a Run executes, in `execution.service.ts`.
    const input = { version: 1 as const, workspace: {}, runClock: null, acceptedScreenCopy: null };
    const runs = dataSource.getRepository(ExecutionRunEntity);
    const run = await runs.save(
      runs.create({
        phaseStateId: ids.requirements,
        userId: learnerId,
        kind: 'run',
        status: 'queued',
        inputSnapshot: input,
        inputHash: runInputHash(input),
      }),
    );
    const ran = jest
      .spyOn(execution, 'executeForPhase')
      .mockResolvedValue({ ok: true } as never);

    await execution.processRun({ id: run.id });

    expect(ran.mock.calls[0][0].title).toBe(v1.phases[0].title);
    expect(ran.mock.calls[0][0].files.map((f) => f.path)).toContain('pinned/v1.md');
  });

  it('the mentor reads the pinned version\'s phase context', async () => {
    // `assistant.service.ts`: the phase the mentor is told about and
    // the set of paths it redacts against.
    const loaded = await (
      assistant as unknown as {
        loadPhaseFor(userId: string, phaseStateId: string): Promise<{ phase: PhaseContent }>;
      }
    ).loadPhaseFor(learnerId, ids.requirements);

    expect(loaded.phase.title).toBe(v1.phases[0].title);
  });

  it('the bell names the pinned version\'s phase, and its next phase', async () => {
    // The bell's phase names in `notifications.service.ts` look
    // request-scoped, but the slug they read comes off the learner's own
    // enrolment row and nothing else, so resolved against the head, what the
    // bell says about a phase would be the published head's title and next
    // phase, said to a learner who is working a different version. With one
    // published version that is invisible; it is wrong the day a second
    // version is published under a live class.
    const notifications = new NotificationsService(dataSource, content, {
      emitNotification: () => undefined,
    } as unknown as EventsGateway);
    const state = await dataSource.manager.findOneByOrFail(PhaseStateEntity, {
      id: ids.requirements,
    });

    await notifications.onVerdict(
      state,
      'a-submission',
      { assessmentMode: 'strict_binary', passed: true, overall: 100, checks: [] } as never,
      true,
      // The phase's own move, which is what the bell rings on. This board is
      // sole-task, so `after` is `nextPhaseStatus(before, true)` and there is
      // no task row to count: the phase-wide expression, written out.
      { before: state.status, after: 'passed', taskKey: SOLE_TASK_KEY, taskAttempts: null },
    );

    const row = await dataSource.manager.findOneOrFail(NotificationEntity, {
      where: { userId: learnerId, kind: 'gate.passed' },
    });
    expect(row.title).toBe(`${v1.phases[0].title}: Pass`);
    expect(row.detail).toBe(`Merge it to open ${v1.phases[1].title}`);
    expect(row.title).not.toContain('(v2)');
    expect(row.detail).not.toContain('(v2)');
  });

  it('an instructor looking at a holed board writes nothing into it', async () => {
    // The regression this step exists to close. `phaseDetail` and
    // `myEnrollment` repair by default now, and `ViewAsService` calls both with
    // the learner's own id, so a teacher opening the page was writing
    // `phase_states` rows carrying that learner's `userId` into their
    // coursework, under the sentence "provably read-only".
    await dataSource.manager.delete(PhaseStateEntity, {
      enrollmentId: (await enrollmentOf()).id,
      phaseOrder: 6,
    });
    const before = await coursework();

    const seen = await viewAs.enrollment(teacher, learnerId, 'tasktrackr');
    const detail = await viewAs.phase(teacher, learnerId, ids.requirements);

    // The teacher is answered (this is a read that declines to write, not a
    // read that refuses) and the hole is visible to them, which is the honest
    // thing for it to be.
    expect(seen!.phases).toHaveLength(5);
    expect(detail.key).toBe('requirements');
    expect(await coursework()).toEqual(before);

    // And the learner's own read still repairs it, so nothing is lost by the
    // teacher's restraint.
    await workflow.phaseDetail(learnerId, ids.requirements);
    expect(await dataSource.manager.count(PhaseStateEntity)).toBe(6);
  });

  it('an instructor\'s view-as of a legacy unpinned enrolment rewrites no stamp either', async () => {
    // The second write on that path: `loadOwnedState` refreshes `packVersion`
    // for a row with no pin. A read made on somebody else's behalf must not do
    // that either: the stamp is a fact about the attempt, and the instructor
    // is not making one.
    const enrollment = await enrollmentOf();
    await dataSource.manager.update(EnrollmentEntity, enrollment.id, {
      projectVersionId: null,
      packVersion: '0.9.0',
    });
    const before = await coursework();

    // Both doors, because they stamp from different places: the room's is
    // `loadOwnedState`'s, and the board's is `reconcileToPack`'s, and every
    // enrolment in the deployed release has a null pin, so this is the shape
    // the first instructor to open a learner's page actually meets.
    await viewAs.phase(teacher, learnerId, ids.requirements);
    await viewAs.enrollment(teacher, learnerId, 'tasktrackr');

    expect(await coursework()).toEqual(before);
    // The learner's own read is still the one writer of it.
    await workflow.phaseDetail(learnerId, ids.requirements);
    expect((await enrollmentOf()).packVersion).toBe('2.0.0');
  });

  it('an instructor\'s view-as of a room that carries the retained screen copy retains nothing', async () => {
    // The third write on that path, and the one the two tests above cannot
    // see: `resolveScreenCopy` retains the accepted Design copy on the viewed
    // row and on the Implementation row, both carrying the learner's own
    // `userId`. Requirements never declares
    // `shared/contract/accepted-screen-copy.json` (only Implementation,
    // Testing, Deployment and Maintenance do) so a read-only assertion made
    // in the Requirements room is an assertion about a line that never runs.
    const copy = {
      version: 1 as const,
      sourceSubmissionId: 'a-design-pass',
      sourcePhaseStateId: ids.design,
      title: 'Late work',
      empty: 'Nothing is overdue.',
    };
    await dataSource.manager.update(PhaseStateEntity, ids.implementation, {
      status: 'passed',
      acceptedScreenCopy: copy,
    });
    await dataSource.manager.update(PhaseStateEntity, ids.testing, { status: 'in_progress' });
    const before = await coursework();

    const detail = await viewAs.phase(teacher, learnerId, ids.testing);

    // Answered, and answered about the pinned version's room: the instructor
    // sees what the learner sees without leaving a mark on it.
    expect(detail.key).toBe('testing');
    expect(detail.title).toBe(v1.phases[3].title);
    expect(await coursework()).toEqual(before);

    // And the learner's own read still retains it, so nothing is lost.
    await workflow.phaseDetail(learnerId, ids.testing);
    const held = await dataSource.manager.findOneByOrFail(PhaseStateEntity, { id: ids.testing });
    expect(held.acceptedScreenCopy).toEqual(copy);
  });
});
