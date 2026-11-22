import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { INHERITED_TASK_KEY, SOLE_TASK_KEY } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  compilePack,
  editablePathsOf,
  gradedUnitsOf,
  soleTaskFor,
  type AuthoredTask,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from './workflow.service';

/**
 * Who writes a `task_states` row, and from which version.
 *
 * Three creators, matching the phase board's own: the enrolment,
 * the board repair, and `submit`. None of them is a gate input: a required key
 * with no row is a *failing* key, so if every creator here failed the phase
 * would stay shut rather than swing open. What they buy is a task panel that
 * can draw `0 attempts` instead of nothing, and a history whose rows know which
 * task they belong to.
 *
 * Two properties carry the whole design.
 *
 * **The wanted set is the pin's.** Every list comes from
 * `getTasksForEnrollment`, the accessor the roll-up's quantifier, the strict
 * gate, the door and the builders all read. Composing the *head* accessor with
 * a pinned board is two keyed structures that can disagree in both directions,
 * and both directions are tested below.
 *
 * **The adoption is triggered by the board's state, never by an insert.**
 * `submissions.taskKey` backfills to `''` (migration H3) while every phase of
 * every teacher-authored project declares `main`, so a learner who submitted
 * before tasks were keyed holds passing revisions the pinned version's required key
 * cannot see. `submit` creates its row through `loadOwnedState`, which stamps
 * the pack and does **not** repair the board, so an insert-keyed adoption never
 * fires for a learner whose first request after the migration is a submit,
 * and a one-shot adoption never reaches a revision that was `queued` at that
 * moment and completed afterwards. Hence: every creator, every pass.
 *
 * It is proved on fixtures rather than on real data, which is what the repair
 * has to be right about before there is any.
 */

const SHIPPED = 'tasktrackr';
const TEACHER = 'ms-tan-tasktrackr';

/** Version ids, which exist nowhere on disk: an answer keyed on one came from the map. */
const V_FLAT = 'v-tasktrackr-head';
const V_MAIN = 'v-teacher-main';
const V_SPLIT = 'v-teacher-split';
const V_SOLE = 'v-teacher-sole';

/** A hand-built compiled task over the phase's own sole task. */
const taskLike = (phase: PhaseContent, over: Partial<CompiledTask>): CompiledTask => ({
  ...soleTaskFor(phase),
  ...over,
});

/** One authored task per phase, keyed `main`: what a copied project compiles to. */
const inheritedTasks = (project: ProjectContent): Record<string, AuthoredTask[]> =>
  Object.fromEntries(
    project.phases.map((phase) => [
      phase.key,
      [
        {
          taskKey: INHERITED_TASK_KEY,
          order: 1,
          owns: editablePathsOf(phase),
          gradedUnits: gradedUnitsOf(phase),
        },
      ],
    ]),
  );

/** Every phase at its synthesised sole task: the shape a flattened head has. */
const soleTasks = (project: ProjectContent): CompiledPhaseTasks[] =>
  project.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] }));

describe('who writes a task_states row, from the pin', () => {
  let dataSource: DataSource;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let releases: Repository<ReleaseRecordEntity>;
  let submissions: Repository<SubmissionEntity>;
  let taskStates: Repository<TaskStateEntity>;
  let content: ContentService;
  let workflow: WorkflowService;
  let feedback: FeedbackService;

  /** Every statement the driver has executed, newest last. */
  let queries: string[] = [];

  let shipped: ProjectContent;
  let teacher: ProjectContent;
  /** `main` on every phase, as `AuthoringService`'s publish compiles a copy. */
  let mainTasks: CompiledPhaseTasks[];
  /** Requirements split into `story` (required) and `scope` (optional). */
  let splitTasks: CompiledPhaseTasks[];

  const learner = 'learner-1';
  const other = 'learner-2';

  /** The catalogue this test answers from; `installVersions` replaces the lot. */
  const publish = (
    ...versions: { versionId: string; content: ProjectContent; phases: CompiledPhaseTasks[] }[]
  ): void => {
    content.installVersions(
      versions.map((one) => ({ ...one, compiler: COMPILER_IDENTITY })),
    );
  };

  /** Enrol, and hand back the phase state ids by key. */
  const enrol = async (userId: string, slug: string): Promise<Record<string, string>> => {
    const view = await workflow.enroll(userId, slug);
    return Object.fromEntries(view.phases.map((phase) => [phase.key, phase.id]));
  };

  const enrolmentOf = (userId: string, slug: string): Promise<EnrollmentEntity> =>
    enrollments.findOneByOrFail({ userId, projectSlug: slug });

  /** Move a learner onto a superseded version, as a class held back is. */
  const pinTo = async (userId: string, slug: string, versionId: string): Promise<EnrollmentEntity> => {
    const held = await enrolmentOf(userId, slug);
    await enrollments.update(held.id, { projectVersionId: versionId });
    return enrollments.findOneByOrFail({ id: held.id });
  };

  /** One board-describing read: `reconcileToPack`, and therefore the repair. */
  const repair = async (userId: string, slug: string): Promise<void> => {
    await workflow.enrollmentView(await enrolmentOf(userId, slug));
  };

  const keysOn = async (phaseStateId: string): Promise<string[]> =>
    (await taskStates.find({ where: { phaseStateId }, order: { taskKey: 'ASC' } })).map(
      (row) => row.taskKey,
    );

  /** A revision as migration H3 leaves one handed in before tasks were keyed: keyed `''`. */
  const revision = async (
    phaseStateId: string,
    userId: string,
    over: Partial<SubmissionEntity> = {},
  ): Promise<SubmissionEntity> =>
    submissions.save(
      submissions.create({
        phaseStateId,
        userId,
        status: 'completed',
        passed: true,
        taskKey: '',
        ...over,
      }),
    );

  /** Statements that name the task table, whatever the driver spelled them. */
  const touchedTaskStates = (): string[] => queries.filter((sql) => /task_states/i.test(sql));

  /** The adoption's own statement: an UPDATE of the revision's key. */
  const adoptions = (): string[] =>
    queries.filter((sql) => /^\s*UPDATE\s+"?submissions"?/i.test(sql) && /taskKey/i.test(sql));

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
      // The statement log is the probe: "the repair issues no query for a
      // sole-task board" is a claim about SQL, and a spy on a repository method
      // would miss a query issued through the manager.
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
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    releases = dataSource.getRepository(ReleaseRecordEntity);
    submissions = dataSource.getRepository(SubmissionEntity);
    taskStates = dataSource.getRepository(TaskStateEntity);

    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject(SHIPPED);
    teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)', version: '1.0.0' };
    // Exactly what the publish compiles for a copied project: each phase's
    // inherited sole task materialised as a real authored row keyed `main`.
    mainTasks = compilePack(teacher, { authored: inheritedTasks(teacher) }).phases;
    const requirements = teacher.phases.find((phase) => phase.key === 'requirements') as PhaseContent;
    splitTasks = mainTasks.map((entry) =>
      entry.key === 'requirements'
        ? {
            key: entry.key,
            tasks: [
              taskLike(requirements, { taskKey: 'story', order: 1 }),
              taskLike(requirements, { taskKey: 'scope', order: 2, required: false }),
            ],
          }
        : entry,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    content = new ContentService();
    content.loadAll();
    publish(
      { versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) },
      { versionId: V_MAIN, content: teacher, phases: mainTasks },
    );
    workflow = new WorkflowService(
      enrollments,
      phaseStates,
      releases,
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
    feedback = new FeedbackService(
      submissions,
      phaseStates,
      enrollments,
      {} as never,
      content,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: jest.fn(), register: jest.fn(), durable: false } as never,
      { emitJob: jest.fn() } as never,
      { onVerdict: jest.fn(async () => undefined) } as never,
    );
    queries = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enrolment writes one row per authored task and none for a sole task', async () => {
    publish(
      { versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) },
      { versionId: V_SPLIT, content: teacher, phases: splitTasks },
    );

    const split = await enrol(learner, TEACHER);
    expect(await keysOn(split.requirements)).toEqual(['scope', 'story']);
    // and every other phase of that project is the one authored key
    expect(await keysOn(split.design)).toEqual([INHERITED_TASK_KEY]);
    const rows = await taskStates.find({ where: { phaseStateId: split.requirements } });
    // a fresh row claims nothing: `in_progress`, no score, no pass, no
    // countersignature, the only seed that is safe on a locked phase too,
    // because `nextPhaseStatus` makes `locked` sticky on a task row as well.
    expect(rows.map((row) => [row.status, row.bestScore, row.passedAt, row.attempts])).toEqual([
      ['in_progress', null, null, 0],
      ['in_progress', null, null, 0],
    ]);
    expect(rows.every((row) => row.userId === learner)).toBe(true);

    // TaskTrackr: zero rows, and the same one transaction.
    queries = [];
    const flat = await enrol(other, SHIPPED);
    expect(touchedTaskStates()).toEqual([]);
    expect(queries.filter((sql) => /^\s*BEGIN/i.test(sql))).toHaveLength(1);
    expect(await taskStates.countBy({ userId: other })).toBe(0);
    expect(Object.keys(flat)).toHaveLength(shipped.phases.length);
  });

  it('a teacher project gets a row on every phase, of every kind', async () => {
    const ids = await enrol(learner, TEACHER);
    const pin = await enrolmentOf(learner, TEACHER);

    for (const phase of teacher.phases) {
      expect(await keysOn(ids[phase.key])).toEqual([INHERITED_TASK_KEY]);
    }
    // The per-task machinery is not "markdown only". A teacher `code`
    // phase and a teacher `tests` phase each hold a row from day one, behind
    // the wall and without it moving.
    const kinds = teacher.phases.map(
      (phase) => content.getTasksForEnrollment(pin, phase.key)[0].checkKind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['story', 'design', 'code', 'tests', 'config']));
    expect(await taskStates.countBy({ userId: learner })).toBe(teacher.phases.length);
  });

  it('the board repair fills what enrolment missed, idempotently', async () => {
    const ids = await enrol(learner, TEACHER);
    await taskStates.delete({ phaseStateId: ids.design });
    expect(await keysOn(ids.design)).toEqual([]);

    await repair(learner, TEACHER);
    expect(await keysOn(ids.design)).toEqual([INHERITED_TASK_KEY]);
    const written = await taskStates.findOneByOrFail({ phaseStateId: ids.design });

    await repair(learner, TEACHER);
    expect(await keysOn(ids.design)).toEqual([INHERITED_TASK_KEY]);
    // the same row, not a second one written over the first
    expect((await taskStates.findOneByOrFail({ phaseStateId: ids.design })).id).toBe(written.id);

    // And a concurrent repair is swallowed rather than raised, exactly as
    // `fillMissingPhaseStates` swallows its own: the read below is made stale
    // on purpose, so the insert that follows it loses to `UQ_task_states_key`
    // and the learner's board is still answered.
    jest.spyOn(taskStates, 'find').mockResolvedValueOnce([]);
    queries = [];
    await expect(repair(learner, TEACHER)).resolves.toBeUndefined();
    // every phase's row was really attempted and really lost, which is what
    // makes this a test of the catch rather than of the read above it
    expect(touchedTaskStates().filter((sql) => /^\s*INSERT/i.test(sql))).toHaveLength(
      teacher.phases.length,
    );
    expect(await keysOn(ids.design)).toEqual([INHERITED_TASK_KEY]);
    expect((await taskStates.findOneByOrFail({ phaseStateId: ids.design })).id).toBe(written.id);
  });

  it('the repair issues no query for a sole-task board', async () => {
    const ids = await enrol(other, SHIPPED);
    const probe = jest.spyOn(phaseStates, 'find');
    queries = [];

    await repair(other, SHIPPED);
    await workflow.phaseSummaries(other, SHIPPED);
    await workflow.phaseDetail(other, ids.requirements);

    // Not "no rows written": no query at all. `repairBoard` runs from
    // `reconcileToPack` on every write-path enrolment read, so a per-read
    // SELECT looking for rows that never exist for a sole task would be a tax on every
    // learner of the imported project. This is the test that keeps the
    // wanted-set-first guard from being deleted as tidiness.
    expect(touchedTaskStates()).toEqual([]);
    expect(adoptions()).toEqual([]);
    // and the repair's own probe is still one read per reconcile, not two:
    // `pin.spec.ts` counts exactly these.
    const probes = probe.mock.calls.filter((call) =>
      Boolean((call[0] as { select?: unknown } | undefined)?.select),
    );
    // one per repairing read (the view, the summaries batch, the room) and
    // not two, because the task repair asks its question of the content first.
    expect(probes).toHaveLength(3);
  });

  it('the wanted set comes from the pin, never from the head', async () => {
    // A head that has been flattened since this learner was pinned: the pin
    // declares two tasks and the head one, and the rows are the pin's.
    publish(
      { versionId: V_SPLIT, content: teacher, phases: splitTasks },
      { versionId: V_SOLE, content: { ...teacher, version: '9.0.0' }, phases: soleTasks(teacher) },
    );
    const ids = await enrol(learner, TEACHER);
    expect(await keysOn(ids.requirements)).toEqual([]); // enrolled on the flat head
    await pinTo(learner, TEACHER, V_SPLIT);
    await repair(learner, TEACHER);
    expect(await keysOn(ids.requirements)).toEqual(['scope', 'story']);

    // And the other direction, which the defect also had: a head that has been
    // split since this learner was pinned writes nothing, because their own
    // version declares one synthesised task and has no keys to write.
    publish(
      { versionId: V_SOLE, content: teacher, phases: soleTasks(teacher) },
      { versionId: V_SPLIT, content: { ...teacher, version: '9.0.0' }, phases: splitTasks },
    );
    const theirs = await enrol(other, TEACHER);
    await pinTo(other, TEACHER, V_SOLE);
    // The rows the split head wrote at enrol time are gone, as they are for a
    // learner who enrolled before their class was moved: what is under test is
    // what the repair writes, reading their own version.
    await taskStates.delete({ userId: other });
    queries = [];
    await repair(other, TEACHER);
    expect(touchedTaskStates()).toEqual([]);
    expect(await keysOn(theirs.requirements)).toEqual([]);
  });

  it('a revision handed in before tasks were keyed, on a one-task phase, is adopted by that task', async () => {
    const ids = await enrol(learner, TEACHER);
    // The revision a learner handed in before tasks were keyed: H3 backfilled its
    // key to `''`, and the pinned version's only required key is `main`.
    const before = await revision(ids.requirements, learner);
    expect(before.taskKey).toBe('');

    await repair(learner, TEACHER);
    expect((await submissions.findOneByOrFail({ id: before.id })).taskKey).toBe(INHERITED_TASK_KEY);

    // A second pass affects nothing, and still runs: it is a narrow indexed
    // UPDATE over zero rows, and running it every time is what catches a
    // revision that lands after the first repair.
    const after = await submissions.findOneByOrFail({ id: before.id });
    queries = [];
    await repair(learner, TEACHER);
    expect(adoptions()).not.toHaveLength(0);
    expect(await submissions.findOneByOrFail({ id: before.id })).toEqual(after);

    // A sole-task phase's rows are never touched, because no creator ever runs
    // there: the adoption is unreachable rather than guarded.
    const flat = await enrol(other, SHIPPED);
    const untouched = await revision(flat.requirements, other);
    queries = [];
    await repair(other, SHIPPED);
    expect(adoptions()).toEqual([]);
    expect((await submissions.findOneByOrFail({ id: untouched.id })).taskKey).toBe(SOLE_TASK_KEY);
  });

  it('a pass handed in before tasks were keyed, on a one-task phase, is carried onto the row the repair writes', async () => {
    const ids = await enrol(learner, TEACHER);
    // The state a learner who PASSED a teacher-authored phase before tasks were
    // keyed is actually in: a passed phase row, a passing revision keyed
    // `''`, and no task row at all, because nothing had written one when they
    // last worked. The board's adoption closes the revision half; this is the other half, and
    // without it `strictPass`' row conjunct refuses them for ever while the
    // tile stays green.
    await taskStates.delete({ userId: learner });
    await phaseStates.update(ids.requirements, {
      status: 'passed',
      passedAt: '2026-09-10T08:00:00.000Z',
      bestScore: 82,
    });

    await repair(learner, TEACHER);

    // A phase with exactly one task has exactly one owner for its history:
    // the same sentence the adoption rests on, said about the row.
    const row = await taskStates.findOneByOrFail({ phaseStateId: ids.requirements });
    expect([row.taskKey, row.status, row.passedAt, row.bestScore]).toEqual([
      INHERITED_TASK_KEY,
      'passed',
      '2026-09-10T08:00:00.000Z',
      82,
    ]);
    // And nothing else moved. A phase this learner has not passed still gets
    // the unstarted row, which is what a required key with no history means,
    // and a `locked` phase is never seeded from, because `nextPhaseStatus`
    // makes `locked` sticky on a task row and such a row could never pass.
    const design = await taskStates.findOneByOrFail({ phaseStateId: ids.design });
    expect([design.status, design.passedAt, design.bestScore]).toEqual([
      'in_progress',
      null,
      null,
    ]);
  });

  it('a split phase gets the unstarted row, however its phase row reads', async () => {
    publish(
      { versionId: V_FLAT, content: shipped, phases: soleTasks(shipped) },
      { versionId: V_SPLIT, content: teacher, phases: splitTasks },
    );
    const ids = await enrol(learner, TEACHER);
    // Two tasks, so the phase's pass names no single owner: it is the roll-up
    // of a set, and a member of that set whose row is gone is a key that has
    // not passed. The seed above must not reach here, or the missing-row rule
    // (a required key with no row is failing) is worth nothing on the shape it was written for.
    await taskStates.delete({ phaseStateId: ids.requirements, taskKey: 'story' });
    await phaseStates.update(ids.requirements, {
      status: 'passed',
      passedAt: '2026-09-10T08:00:00.000Z',
      bestScore: 91,
    });

    await repair(learner, TEACHER);

    const story = await taskStates.findOneByOrFail({
      phaseStateId: ids.requirements,
      taskKey: 'story',
    });
    expect([story.status, story.passedAt, story.bestScore]).toEqual(['in_progress', null, null]);
  });

  it('a learner whose first request after the deploy is a submit is still adopted', async () => {
    const ids = await enrol(learner, TEACHER);
    // The state a learner from before task rows is actually in: phase states and history, no
    // task rows at all, because nothing had written one when they last worked.
    await taskStates.delete({ userId: learner });
    const before = await revision(ids.requirements, learner);

    // `POST /phases/:id/submit` and nothing else. `loadOwnedState` stamps the
    // pack and does NOT repair the board, so an insert-keyed adoption would
    // never fire on this path: the row would be created by `submit` and every
    // later repair would find it present and insert nothing.
    const held = await workflow.loadOwnedState(learner, ids.requirements);
    await feedback.submit(held.phase, held.state);

    expect((await submissions.findOneByOrFail({ id: before.id })).taskKey).toBe(INHERITED_TASK_KEY);
    expect(await keysOn(ids.requirements)).toEqual([INHERITED_TASK_KEY]);
  });

  it('a row that lands after the first repair is adopted on the next pass', async () => {
    const ids = await enrol(learner, TEACHER);
    // Queued at deploy time, keyed `''`, and deliberately excluded from the
    // first pass by the status predicate.
    const late = await revision(ids.requirements, learner, { status: 'queued', passed: null });

    await repair(learner, TEACHER);
    expect((await submissions.findOneByOrFail({ id: late.id })).taskKey).toBe('');

    // It completes after the first repair, which is precisely the population
    // the board's adoption is for, and precisely what a one-shot adoption never reaches.
    await submissions.update({ id: late.id }, { status: 'completed', passed: true });
    await repair(learner, TEACHER);
    expect((await submissions.findOneByOrFail({ id: late.id })).taskKey).toBe(INHERITED_TASK_KEY);
  });

  it('an in-flight row keyed "" is left alone', async () => {
    const ids = await enrol(learner, TEACHER);
    // The release window: a pre-deploy `queued` row keyed `''` beside a
    // post-deploy `queued` row keyed `main`, both legal under
    // `UQ_submissions_in_flight (phaseStateId, taskKey)`.
    const stale = await revision(ids.requirements, learner, { status: 'queued', passed: null });
    const live = await revision(ids.requirements, learner, {
      status: 'queued',
      passed: null,
      taskKey: INHERITED_TASK_KEY,
    });

    await expect(repair(learner, TEACHER)).resolves.toBeUndefined();
    expect((await submissions.findOneByOrFail({ id: stale.id })).taskKey).toBe('');
    expect((await submissions.findOneByOrFail({ id: live.id })).taskKey).toBe(INHERITED_TASK_KEY);

    // Without `status NOT IN ('queued','running')` the same UPDATE collides
    // with the live row under the partial unique index and the violation
    // propagates out of `repairBoard` and 500s the learner's board.
    await expect(
      dataSource.manager
        .createQueryBuilder()
        .update(SubmissionEntity)
        .set({ taskKey: INHERITED_TASK_KEY })
        .where('"phaseStateId" = :id AND "taskKey" = :empty', {
          id: ids.requirements,
          empty: '',
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('submit inserts only on the authored path', async () => {
    const flat = await enrol(other, SHIPPED);
    const sole = await workflow.loadOwnedState(other, flat.requirements);
    queries = [];
    await feedback.submit(sole.phase, sole.state);
    // A sole-task submit touches no task row.
    expect(touchedTaskStates()).toEqual([]);
    expect(adoptions()).toEqual([]);

    const ids = await enrol(learner, TEACHER);
    await taskStates.delete({ userId: learner });
    const held = await workflow.loadOwnedState(learner, ids.requirements);
    queries = [];
    await feedback.submit(held.phase, held.state);

    // One `orIgnore` insert, the attempt spent on the task's own counter, one
    // adoption UPDATE, and no other write of either table. The read beside the
    // insert is TypeORM's own reload of the generated columns, the same one
    // `advance`'s release record pays for. The second statement is the task
    // half of "a task's Submit spends an attempt on both rows":
    // it is a narrow SQL expression, never a recompute, and the sole-task case
    // above proves it touches nothing where there is no row to spend.
    const writes = touchedTaskStates().filter((sql) => !/^\s*SELECT/i.test(sql));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^INSERT INTO "task_states"/i);
    expect(writes[0]).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(writes[1]).toMatch(/^UPDATE "task_states" SET "attempts" = "attempts" \+ 1/i);
    expect(adoptions()).toHaveLength(1);
    expect(await keysOn(ids.requirements)).toEqual([INHERITED_TASK_KEY]);

    // and a second submit adds no second row and raises nothing: the insert is
    // idempotent by `UQ_task_states_key`, not by a read-then-write.
    await submissions.update({ phaseStateId: ids.requirements }, { status: 'completed' });
    const again = await workflow.loadOwnedState(learner, ids.requirements);
    await expect(feedback.submit(again.phase, again.state)).resolves.toBeDefined();
    expect(await keysOn(ids.requirements)).toEqual([INHERITED_TASK_KEY]);
  });
});
