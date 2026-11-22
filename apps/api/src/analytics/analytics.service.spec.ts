import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { DataSource, Logger as TypeormLogger } from 'typeorm';
import type { ClassMapView, FeedbackReport, QuizChecks } from '@learnsdlc/shared';
import type { AssistantService } from '../assistant/assistant.service';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  AssistantMessageEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import type { InstructorCaller } from '../instructor/cohort-scope';
// Only one pack ships, so the second project a learner can be in is a fixture.
import { SECOND_PROJECT, addSecondProject } from '../../test/second-pack';
import { AnalyticsService } from './analytics.service';
import { memoryDataSource } from '../../test/support/memory-db';

/** Counts statements so a test can assert how many the overview costs. */
class CountingLogger implements TypeormLogger {
  queries = 0;
  /** Kept as well as counted, so a test can re-run one and see how much it read. */
  issued: { query: string; parameters: unknown[] }[] = [];
  logQuery(query: string, parameters?: unknown[]): void {
    this.queries += 1;
    this.issued.push({ query, parameters: parameters ?? [] });
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

/** TaskTrackr 3.0.0's markdown Design phase.json, kept as a fixture after 4.0.0 made Design a design phase. */
const LEGACY_DESIGN = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/legacy-design/phase.json'), 'utf8'));

describe('AnalyticsService.instructorOverview', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: AnalyticsService;
  const counter = new CountingLogger();

  const assistant = {
    defaultBudget: async () => 20_000,
    budgetFor: async () => 20_000,
    tokensToday: async () => 0,
    activeProviderName: () => 'local-mentor',
    recentProviderName: async () => 'local-mentor',
  } as unknown as AssistantService;

  let danaId = '';
  let samId = '';
  let adminId = '';
  const manager = () => dataSource.manager;

  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(
      manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }),
    );

  /** Materialises an enrolment the way WorkflowService.enroll does, passing the first `passed` phases. */
  async function enrol(userId: string, projectSlug: string, passed = 0): Promise<PhaseStateEntity[]> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug, currentPhaseOrder: passed + 1 }),
    );
    const states: PhaseStateEntity[] = [];
    for (const phase of content.getProject(projectSlug).phases) {
      const isPassed = phase.order <= passed;
      states.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: isPassed ? 'passed' : phase.order === passed + 1 ? 'in_progress' : 'locked',
            bestScore: isPassed ? 80 : null,
            attempts: isPassed ? 1 : 0,
          }),
        ),
      );
    }
    return states;
  }

  async function hint(userId: string, state: PhaseStateEntity, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await manager().save(
        manager().create(AssistantMessageEntity, {
          userId,
          enrollmentId: state.enrollmentId,
          phaseStateId: state.id,
          phaseKey: state.phaseKey,
          role: 'user',
          content: '…',
          tokensIn: 10,
          tokensOut: 20,
        }),
      );
    }
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
      logging: true,
      logger: counter,
    });
    await dataSource.initialize();
    content = new ContentService();
    content.loadAll();
    addSecondProject(content);
    service = new AnalyticsService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(AssistantMessageEntity),
      content,
      assistant,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    danaId = (await saveUser({ email: 'dana@learnsdlc.test', role: 'INSTRUCTOR', cohort: 'tuesday' })).id;
    samId = (await saveUser({ email: 'sam@learnsdlc.test', role: 'INSTRUCTOR', cohort: 'thursday' })).id;
    adminId = (await saveUser({ email: 'ops@learnsdlc.test', role: 'ADMIN' })).id;
  });

  it('is one row per learner × enrolment, plus a not-started row for a learner with none', async () => {
    const both = await saveUser({ email: 'both@learnsdlc.test', displayName: 'Both', cohort: 'tuesday' });
    await saveUser({ email: 'none@learnsdlc.test', displayName: 'None', cohort: 'tuesday' });
    const [first] = await enrol(both.id, 'tasktrackr', 1);
    await enrol(both.id, SECOND_PROJECT);
    await hint(both.id, first, 2);

    const overview = await service.instructorOverview(danaId);
    expect(overview.cohortSize).toBe(2);
    expect(
      overview.learners.map((r) => [r.email, r.projectSlug, r.progressPercent, r.totalHints]),
    ).toEqual([
      ['both@learnsdlc.test', 'tasktrackr', 17, 2],
      ['both@learnsdlc.test', SECOND_PROJECT, 0, 0],
      ['none@learnsdlc.test', null, 0, 0],
    ]);
    const python = overview.learners[0];
    expect(python).toMatchObject({ phasesPassed: 1, averageScore: 80, completed: false });
    expect(python.relianceIndex).toBeGreaterThan(0);
    // Today's tokens are per learner, not per row: both rows carry the same total.
    expect(overview.learners[0].tokensToday).toBe(60);
    expect(overview.learners[1].tokensToday).toBe(60);
  });

  it('?project= narrows to that enrolment and keeps everyone on the roll call', async () => {
    const both = await saveUser({ email: 'both@learnsdlc.test', displayName: 'Both', cohort: 'tuesday' });
    const jsOnly = await saveUser({ email: 'js@learnsdlc.test', displayName: 'Js', cohort: 'tuesday' });
    await enrol(both.id, 'tasktrackr', 1);
    await enrol(both.id, SECOND_PROJECT);
    await enrol(jsOnly.id, SECOND_PROJECT, 2);

    const python = await service.instructorOverview(danaId, 'tasktrackr');
    expect(python.learners.map((r) => [r.email, r.projectSlug, r.progressPercent])).toEqual([
      ['both@learnsdlc.test', 'tasktrackr', 17],
      ['js@learnsdlc.test', null, 0],
    ]);
    expect(python.cohortSize).toBe(2);

    const js = await service.instructorOverview(danaId, SECOND_PROJECT);
    expect(js.learners.map((r) => [r.email, r.projectSlug, r.progressPercent])).toEqual([
      ['js@learnsdlc.test', SECOND_PROJECT, 33],
      ['both@learnsdlc.test', SECOND_PROJECT, 0],
    ]);
  });

  // Pack 2.0.0 resets enrolments rather than migrating them, so a database
  // upgraded in place can hold an enrolment on a pack the catalogue no longer
  // ships. Such a row must not throw `unknown project: taskflow` out of
  // phaseAnalytics and 404 the whole console, hiding every learner in the class
  // behind one stale row.
  it('keeps the class when one enrolment is on a pack the catalogue lost', async () => {
    const live = await saveUser({ email: 'live@learnsdlc.test', displayName: 'Live', cohort: 'tuesday' });
    const stale = await saveUser({ email: 'stale@learnsdlc.test', displayName: 'Stale', cohort: 'tuesday' });
    await enrol(live.id, 'tasktrackr', 1);
    const gone = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: stale.id,
        projectSlug: 'a-pack-that-was-deleted',
        currentPhaseOrder: 2,
      }),
    );
    for (const [order, key, status] of [
      [1, 'requirements', 'passed'],
      [2, 'design', 'in_progress'],
    ] as const) {
      await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: gone.id,
          userId: stale.id,
          phaseKey: key,
          phaseOrder: order,
          status,
          bestScore: status === 'passed' ? 80 : null,
          attempts: status === 'passed' ? 1 : 0,
        }),
      );
    }

    const overview = await service.instructorOverview(danaId);
    // Sorted by progress, as every other row is: the stale enrolment is not a
    // special case in the console, it is just a learner.
    expect(overview.learners.map((r) => [r.email, r.projectSlug, r.progressPercent])).toEqual([
      ['stale@learnsdlc.test', 'a-pack-that-was-deleted', 50],
      ['live@learnsdlc.test', 'tasktrackr', 17],
    ]);
    // The row still reads: its phases come from its own rows, and the key
    // stands in for a title the pack took with it.
    const lost = await service.forLearner(stale.id);
    expect(lost.phases.map((p) => [p.key, p.title, p.status])).toEqual([
      ['requirements', 'requirements', 'passed'],
      ['design', 'design', 'in_progress'],
    ]);
  });

  it("is scoped to the instructor's cohort; an admin sees every class", async () => {
    await saveUser({ email: 'tue@learnsdlc.test', cohort: 'tuesday' });
    await saveUser({ email: 'thu@learnsdlc.test', cohort: 'thursday' });

    expect((await service.instructorOverview(danaId)).learners.map((r) => r.email)).toEqual([
      'tue@learnsdlc.test',
    ]);
    expect((await service.instructorOverview(samId)).learners.map((r) => r.email)).toEqual([
      'thu@learnsdlc.test',
    ]);
    expect((await service.instructorOverview(adminId)).learners.map((r) => r.email).sort()).toEqual([
      'thu@learnsdlc.test',
      'tue@learnsdlc.test',
    ]);
  });

  it('includes every class the instructor created, named, alongside their own cohort', async () => {
    // Creating a class moves the creator into it (CohortsService.create), so
    // Dana's cohort column now points at the newer class while an older one
    // she also owns still has learners in it.
    const older = await manager().save(
      manager().create(CohortEntity, { name: 'Monday class', joinCode: 'MONDAY22', ownerUserId: danaId }),
    );
    const newer = await manager().save(
      manager().create(CohortEntity, { name: 'Friday class', joinCode: 'FRIDAY22', ownerUserId: danaId }),
    );
    await manager().update(UserEntity, { id: danaId }, { cohort: newer.id });
    await saveUser({ email: 'mon@learnsdlc.test', cohort: older.id });
    await saveUser({ email: 'fri@learnsdlc.test', cohort: newer.id });
    await saveUser({ email: 'other@learnsdlc.test', cohort: 'thursday' });

    const rows = (await service.instructorOverview(danaId)).learners;
    expect(rows.map((r) => [r.email, r.cohortName]).sort()).toEqual([
      ['fri@learnsdlc.test', 'Friday class'],
      ['mon@learnsdlc.test', 'Monday class'],
    ]);
    // A cohort that is only a label, not a class, has no name to show.
    const sam = (await service.instructorOverview(samId)).learners;
    expect(sam.map((r) => [r.email, r.cohortName])).toEqual([['other@learnsdlc.test', null]]);
  });

  it('refuses an unknown project rather than showing an empty class', async () => {
    await expect(service.instructorOverview(danaId, 'nope')).rejects.toThrow(NotFoundException);
  });

  /**
   * The checklist percentage equals the progress percentage, in its conditional form.
   *
   * The identity is not asserted flatly, because flatly it pins a coincidence:
   * `progressPercent` is passed phases over the `phase_states` rows an enrolment
   * **holds**, and `checklistPercent` is required tasks passed over required
   * tasks declared by the **pinned version**. Two different questions that
   * usually have the same answer, because `writeEnrollment` saves every phase's
   * row in one statement. So the precondition is the spec.
   */
  describe('the checklist percentage, against progress (proof 12)', () => {
    it('equals progressPercent on a TaskTrackr board whose rows are complete', async () => {
      // Every phase of the shipped project declares exactly one required task,
      // so the checklist is six items long and the board is six rows long, and
      // the two answer the same number at every point on the way through.
      // `enrol` writes every phase's row, which is what `writeEnrollment` does.
      for (const passed of [0, 2, 6]) {
        const learner = await saveUser({
          email: `whole-${passed}@learnsdlc.test`,
          cohort: 'tuesday',
        });
        await enrol(learner.id, 'tasktrackr', passed);
        const numbers = await service.forLearner(learner.id, 'tasktrackr');
        expect(numbers.checklistPercent).toBe(numbers.progressPercent);
        expect(numbers.checklistPercent).toBe(Math.round((passed / 6) * 100));
        // No quiz anywhere on TaskTrackr, and a blank is not a zero.
        expect(numbers.masteryPercent).toBeNull();
      }
    });

    it('differs on a board short a row, and the checklist is the one that is right', async () => {
      // Reachable: a pack that gains a phase leaves an enrolment short a row
      // until `reconcileToPack` runs, and `forLearner` calls neither that nor
      // `fillMissingPhaseStates`; it reads the rows as it finds them.
      const learner = await saveUser({ email: 'short@learnsdlc.test', cohort: 'tuesday' });
      const enrollment = await manager().save(
        manager().create(EnrollmentEntity, {
          userId: learner.id,
          projectSlug: 'tasktrackr',
          currentPhaseOrder: 4,
        }),
      );
      const all = content.getProject('tasktrackr').phases;
      for (const phase of all.slice(0, 5)) {
        const isPassed = phase.order <= 3;
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId: learner.id,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: isPassed ? 'passed' : 'in_progress',
            bestScore: isPassed ? 80 : null,
            attempts: isPassed ? 1 : 0,
          }),
        );
      }

      const numbers = await service.forLearner(learner.id, 'tasktrackr');
      // Three of the five rows the board holds…
      expect(numbers.progressPercent).toBe(60);
      // …and three of the six required tasks the pinned version declares. The
      // sixth phase has no row and is counted as unpassed rather than as absent,
      // which is what makes this the honest number of the two: the learner has
      // not done that phase's work.
      expect(numbers.checklistPercent).toBe(50);
      expect(numbers.checklistPercent).not.toBe(numbers.progressPercent);
      // The phase with no row is not on the per-phase list either, because that
      // list is the rows, which is exactly the gap the overall number closes.
      expect(numbers.phases).toHaveLength(5);
      expect(numbers.phases.map((p) => p.checklistPercent)).toEqual([100, 100, 100, 0, 0]);
    });

    it('is absent, never 0, on an enrolment whose pack the catalogue lost', async () => {
      // The row still reads (that is the older spec above) and the two new
      // numbers say nothing rather than saying nought: there is no version to
      // count a checklist over, and 0% would read as a learner who has done no
      // work when in fact the whole of their board is passed.
      const stale = await saveUser({ email: 'lost@learnsdlc.test', cohort: 'tuesday' });
      const gone = await manager().save(
        manager().create(EnrollmentEntity, {
          userId: stale.id,
          projectSlug: 'a-pack-that-was-deleted',
          currentPhaseOrder: 2,
        }),
      );
      await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: gone.id,
          userId: stale.id,
          phaseKey: 'requirements',
          phaseOrder: 1,
          status: 'passed',
          bestScore: 80,
          attempts: 1,
        }),
      );

      const numbers = await service.forLearner(stale.id);
      expect(numbers.progressPercent).toBe(100);
      expect(numbers.checklistPercent).toBeUndefined();
      expect(numbers.masteryPercent).toBeUndefined();
      expect(numbers.phases[0].checklistPercent).toBeUndefined();
      const row = (await service.instructorOverview(danaId)).learners.find(
        (one) => one.email === 'lost@learnsdlc.test',
      );
      expect(row).toBeDefined();
      expect(row?.checklistPercent).toBeUndefined();
      expect(row?.masteryPercent).toBeUndefined();
    });

    it("is the same number on the class table as on the learner's own dashboard", async () => {
      const learner = await saveUser({ email: 'both@learnsdlc.test', cohort: 'tuesday' });
      await enrol(learner.id, 'tasktrackr', 4);
      const mine = await service.forLearner(learner.id, 'tasktrackr');
      const row = (await service.instructorOverview(danaId)).learners.find(
        (one) => one.email === 'both@learnsdlc.test',
      );
      expect(row?.checklistPercent).toBe(mine.checklistPercent);
      expect(row?.checklistPercent).toBe(67);
      expect(row?.masteryPercent).toBeNull();
    });
  });

  it('costs the same number of queries for one learner as for a full class', async () => {
    const solo = await saveUser({ email: 'solo@learnsdlc.test', cohort: 'tuesday' });
    const [first] = await enrol(solo.id, 'tasktrackr', 2);
    await hint(solo.id, first, 3);

    counter.queries = 0;
    await service.instructorOverview(danaId);
    const forOne = counter.queries;

    for (let i = 0; i < 8; i++) {
      const learner = await saveUser({ email: `l${i}@learnsdlc.test`, cohort: 'tuesday' });
      const [p1] = await enrol(learner.id, 'tasktrackr', i % 4);
      await enrol(learner.id, SECOND_PROJECT, i % 3);
      await hint(learner.id, p1, i);
    }

    counter.queries = 0;
    const overview = await service.instructorOverview(danaId);
    expect(overview.learners).toHaveLength(1 + 8 * 2);
    // The whole point of the set-query shape: the database is asked a fixed
    // number of questions, not a number that grows with the class.
    expect(counter.queries).toBe(forOne);
    // And a small fixed number, not a fixed hundred.
    expect(forOne).toBeLessThan(15);
    // The recorded number, because this is the spec that guards the docstring
    // above the method. Nine statements: one of them is
    // `taskStatesByPhaseState`, keyed on every phase state in the class at
    // once, which is the only read the two percentages are allowed; the pinned
    // task list each row is counted over is resolved in memory and costs none.
    // A reading per learner would still have
    // passed the `toBe(forOne)` line above, because that compares one class
    // against another rather than against a number, so this line is the one
    // that would go red.
    expect(forOne).toBe(9);
  });
});

describe('AnalyticsService.classMap', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: AnalyticsService;
  const counter = new CountingLogger();

  const assistant = {
    defaultBudget: async () => 20_000,
    budgetFor: async () => 20_000,
    tokensToday: async () => 0,
    activeProviderName: () => 'local-mentor',
    recentProviderName: async () => 'local-mentor',
  } as unknown as AssistantService;

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let ops: InstructorCaller;
  const manager = () => dataSource.manager;
  const DAY = 86_400_000;

  const saveUser = (email: string, cohort = 'tuesday') =>
    manager().save(
      manager().create(UserEntity, {
        email,
        passwordHash: 'x',
        displayName: email.split('@')[0],
        cohort,
      }),
    );

  /** An enrolment with its six phase states, as WorkflowService.enroll makes them. */
  async function enrol(
    userId: string,
    startedAt = new Date(),
    projectSlug = 'tasktrackr',
  ): Promise<PhaseStateEntity[]> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug,
        currentPhaseOrder: 1,
        startedAt,
      }),
    );
    const states: PhaseStateEntity[] = [];
    for (const phase of content.getProject(projectSlug).phases) {
      states.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: phase.order === 1 ? 'in_progress' : 'locked',
            ranBeforeSubmit: phase.order === 1,
          }),
        ),
      );
    }
    return states;
  }

  const report = (parts: Partial<FeedbackReport>): FeedbackReport => ({
    overall: 70,
    passed: true,
    passThreshold: 70,
    criteria: [],
    checks: [],
    aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'local' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: {
      relianceFlag: false,
      relianceIndex: 0,
      mentorPasteFlag: false,
      noEffortFlag: false,
      note: '',
    },
    ...parts,
  });

  const check = (id: string, status: 'passed' | 'failed' | 'warning') => ({
    id,
    label: id,
    status,
    detail: '',
  });

  const submit = (state: PhaseStateEntity, body: FeedbackReport, createdAt = new Date()) =>
    manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: state.id,
        userId: state.userId,
        status: 'completed',
        score: body.overall,
        passed: body.passed,
        report: body,
        createdAt,
      }),
    );

  const nodeById = (view: ClassMapView, id: string) =>
    view.phases.flatMap((phase) => phase.nodes).find((node) => node.id === id);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
      logging: true,
      logger: counter,
    });
    await dataSource.initialize();
    content = new ContentService();
    content.loadAll();
    addSecondProject(content);
    service = new AnalyticsService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(AssistantMessageEntity),
      content,
      assistant,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    const danaRow = await saveUser('dana@learnsdlc.test', 'tuesday');
    const samRow = await saveUser('sam@learnsdlc.test', 'thursday');
    const opsRow = await saveUser('ops@learnsdlc.test', 'default');
    await manager().update(UserEntity, { id: danaRow.id }, { role: 'INSTRUCTOR' });
    await manager().update(UserEntity, { id: samRow.id }, { role: 'INSTRUCTOR' });
    await manager().update(UserEntity, { id: opsRow.id }, { role: 'ADMIN' });
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: 'tuesday' };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: 'thursday' };
    ops = { id: opsRow.id, role: 'ADMIN', cohort: 'default' };
  });

  it('counts every artefact green, red or not reached, once per learner', async () => {
    const lee = await saveUser('lee@learnsdlc.test');
    const mo = await saveUser('mo@learnsdlc.test');
    const nia = await saveUser('nia@learnsdlc.test');
    const [leeFirst] = await enrol(lee.id);
    const [moFirst] = await enrol(mo.id);
    await enrol(nia.id);
    await manager().update(PhaseStateEntity, leeFirst.id, {
      status: 'passed',
      bestScore: 82,
      attempts: 1,
    });
    await manager().update(PhaseStateEntity, moFirst.id, { bestScore: 40, attempts: 3 });
    await submit(
      leeFirst,
      report({ checks: [check('story.sentence', 'passed'), check('story.criteria.min', 'failed')] }),
    );
    await submit(
      moFirst,
      report({
        checks: [check('story.sentence', 'failed'), check('story.criteria.min', 'failed')],
        integrity: {
          relianceFlag: true,
          relianceIndex: 71,
          mentorPasteFlag: false,
          noEffortFlag: false,
          note: '',
        },
      }),
    );

    const map = await service.classMap(dana, 'tasktrackr');
    expect(map.projectSlug).toBe('tasktrackr');
    expect(map.totalLearners).toBe(3);
    expect(map.phases.map((p) => p.key)).toEqual([
      'requirements',
      'design',
      'implementation',
      'testing',
      'deployment',
      'maintenance',
    ]);

    expect(nodeById(map, 'requirements:story:story.sentence')).toMatchObject({
      green: 1,
      red: 1,
      missing: 1,
    });
    expect(nodeById(map, 'requirements:story:story.criteria.min')).toMatchObject({
      green: 0,
      red: 2,
      missing: 1,
    });
    // A gate nobody's report mentions is not reached, which is not the same
    // as failing it.
    expect(nodeById(map, 'requirements:story:story.criteria.tags')).toMatchObject({
      green: 0,
      red: 0,
      missing: 3,
    });
    // Every node accounts for every learner on the roll.
    for (const node of map.phases.flatMap((p) => p.nodes)) {
      expect(node.green + node.red + node.missing).toBe(3);
    }

    const requirements = map.phases[0];
    expect(requirements.counts).toEqual({ locked: 0, in_progress: 2, submitted: 0, passed: 1 });
    expect(requirements.averageScore).toBe(61);
    expect(requirements.averageAttempts).toBe(1.3);
    expect(requirements.flagged).toBe(1);

    // The reddest artefact first, with the class-sized count beside it.
    expect(map.lecturePoints.map((point) => [point.title, point.count, point.phaseKey])).toEqual([
      ['At least 2 acceptance criteria', 2, 'requirements'],
      ['A full story sentence', 1, 'requirements'],
    ]);
  });

  it('queues the learners who need a look, most urgent first, one row each', async () => {
    const gate = content.getProject('tasktrackr').phases[0].rubric.passThreshold;
    const flagged = await saveUser('flagged@learnsdlc.test');
    const stuck = await saveUser('stuck@learnsdlc.test');
    const blind = await saveUser('blind@learnsdlc.test');
    const quiet = await saveUser('quiet@learnsdlc.test');
    const fine = await saveUser('fine@learnsdlc.test');

    const [flaggedFirst] = await enrol(flagged.id);
    await manager().update(PhaseStateEntity, flaggedFirst.id, { attempts: 1, bestScore: 90 });
    await submit(
      flaggedFirst,
      report({
        integrity: {
          relianceFlag: true,
          relianceIndex: 74,
          mentorPasteFlag: true,
          noEffortFlag: false,
          note: '',
        },
      }),
    );

    const [stuckFirst] = await enrol(stuck.id);
    await manager().update(PhaseStateEntity, stuckFirst.id, { attempts: 3, bestScore: gate - 12 });

    // On implementation, which is a phase the pack can run: the signal is
    // about a learner who never used the fast feedback loop, and a phase with
    // no Run button has no loop to skip.
    const blindStates = await enrol(blind.id);
    const blindImpl = blindStates.find((row) => row.phaseKey === 'implementation')!;
    await manager().update(PhaseStateEntity, blindImpl.id, { attempts: 1, ranBeforeSubmit: false });

    const old = new Date(Date.now() - 12 * DAY);
    const [quietFirst] = await enrol(quiet.id, old);
    await manager().update(PhaseStateEntity, quietFirst.id, { attempts: 1, bestScore: 90 });
    await submit(quietFirst, report({}), old);

    const [fineFirst] = await enrol(fine.id);
    await manager().update(PhaseStateEntity, fineFirst.id, { attempts: 1, bestScore: 90 });
    await submit(fineFirst, report({}));

    const map = await service.classMap(dana, 'tasktrackr');
    expect(map.queue.map((item) => [item.email, item.phaseKey, item.reason])).toEqual([
      [
        'flagged@learnsdlc.test',
        'requirements',
        'integrity flag on the latest submission: leaning on the mentor, a passage matches a mentor reply',
      ],
      ['stuck@learnsdlc.test', 'requirements', `3 attempts, best ${gate - 12} against a gate of ${gate}`],
      ['blind@learnsdlc.test', 'implementation', 'submitted without running the tests first'],
      ['quiet@learnsdlc.test', 'requirements', 'no activity for 12 days'],
    ]);
    expect(map.queue[3].since).toBe(old.toISOString());
  });

  it('never says a learner skipped the tests on a phase that has none to run', async () => {
    // Requirements and design are markdown: there is no Run at all, so
    // `ranBeforeSubmit` is false for the whole class and
    // this signal would bury the two that matter under twenty-three that do
    // not.
    const writer = await saveUser('writer@learnsdlc.test');
    const [requirements] = await enrol(writer.id);
    await manager().update(PhaseStateEntity, requirements.id, {
      attempts: 1,
      bestScore: 90,
      ranBeforeSubmit: false,
    });
    await submit(requirements, report({}));

    expect((await service.classMap(dana, 'tasktrackr')).queue).toEqual([]);
  });

  it('never says a learner skipped the tests on a phase they are retrying and have not submitted since', async () => {
    // A learner's retry of a passed TaskTrackr Implementation clears the
    // phase row's `ranBeforeSubmit` and puts it back in progress; attempts
    // and the earlier pass stay. No submission has come since, so there is
    // nothing they submitted without running.
    const retrying = await saveUser('retrying@learnsdlc.test');
    const states = await enrol(retrying.id);
    const impl = states.find((row) => row.phaseKey === 'implementation')!;
    await manager().update(PhaseStateEntity, impl.id, {
      status: 'in_progress',
      attempts: 2,
      bestScore: 90,
      passedAt: '2026-10-20T10:00:00.000Z',
      ranBeforeSubmit: false,
    });
    expect((await service.classMap(dana, 'tasktrackr')).queue).toEqual([]);
  });

  it('a mentor question counts as activity, so a learner mid-conversation is not queued as quiet', async () => {
    const talking = await saveUser('talking@learnsdlc.test');
    const old = new Date(Date.now() - 30 * DAY);
    const [first] = await enrol(talking.id, old);
    await manager().save(
      manager().create(AssistantMessageEntity, {
        userId: talking.id,
        enrollmentId: first.enrollmentId,
        phaseStateId: first.id,
        phaseKey: 'requirements',
        role: 'user',
        content: 'how do I phrase the boundary?',
      }),
    );
    expect((await service.classMap(dana, 'tasktrackr')).queue).toEqual([]);
  });

  it('is scoped to the caller: another class is not on the map', async () => {
    const mine = await saveUser('mine@learnsdlc.test', 'tuesday');
    const theirs = await saveUser('theirs@learnsdlc.test', 'thursday');
    await enrol(mine.id);
    await enrol(theirs.id);

    expect((await service.classMap(dana, 'tasktrackr')).totalLearners).toBe(1);
    expect((await service.classMap(sam, 'tasktrackr')).totalLearners).toBe(1);
    expect((await service.classMap(ops, 'tasktrackr')).totalLearners).toBe(2);
  });

  it('draws the project the class is actually on when none is named', async () => {
    const one = await saveUser('one@learnsdlc.test');
    const two = await saveUser('two@learnsdlc.test');
    const odd = await saveUser('odd@learnsdlc.test');
    await enrol(one.id);
    await enrol(two.id);
    await enrol(odd.id, new Date(), SECOND_PROJECT);

    const map = await service.classMap(dana);
    expect(map.projectSlug).toBe('tasktrackr');
    expect(map.totalLearners).toBe(2);
  });

  it('refuses an unknown project rather than drawing an empty map', async () => {
    await expect(service.classMap(dana, 'nope')).rejects.toThrow(NotFoundException);
  });

  it('costs the same number of queries for one learner as for a full class', async () => {
    const solo = await saveUser('solo@learnsdlc.test');
    const [first] = await enrol(solo.id);
    await submit(first, report({ checks: [check('story.sentence', 'passed')] }));

    counter.queries = 0;
    await service.classMap(dana, 'tasktrackr');
    const forOne = counter.queries;

    for (let i = 0; i < 8; i++) {
      const learner = await saveUser(`l${i}@learnsdlc.test`);
      const [states] = await enrol(learner.id);
      await submit(states, report({ checks: [check('story.sentence', 'failed')] }), new Date(Date.now() - (i + 1) * 60_000));
      await submit(states, report({ checks: [check('story.sentence', 'passed')] }));
    }

    counter.queries = 0;
    const map = await service.classMap(dana, 'tasktrackr');
    expect(map.totalLearners).toBe(9);
    expect(counter.queries).toBe(forOne);
    // The newest attempt is the one the map reads.
    expect(nodeById(map, 'requirements:story:story.sentence')).toMatchObject({ green: 9, red: 0 });
  });

  /**
   * The map must not read every submission the class has ever made and keep
   * the first per phase state as the rows go past: that makes its cost grow
   * with the term rather than with the class (121 ms on the event loop for a
   * fifty-learner cohort at 2,400 submissions, 170 ms at 10,080, with
   * `/health/live` slowing to 215 ms p50 beside it).
   *
   * Rows read rather than milliseconds, deliberately: the wall clock on a
   * shared machine is a flake, and rows crossing the driver is what the
   * latency is made of. Measured on its own at fifty learners, the bounded read
   * takes 5.3 ms instead of 18.4 ms at 2,400 submissions and 8.4 ms instead of
   * 103.9 ms at 24,000.
   */
  describe('the term does not have to be read to draw today', () => {
    /** How many rows every submissions query the map issued actually returned. */
    const submissionRowsRead = async (): Promise<number> => {
      const reads = counter.issued.filter(
        (issued) => issued.query.startsWith('SELECT') && issued.query.includes('"submissions"'),
      );
      expect(reads.length).toBeGreaterThan(0);
      let rows = 0;
      for (const read of reads) rows += (await dataSource.query(read.query, read.parameters)).length;
      return rows;
    };

    /** `attempts` more submissions per phase state, all older than what is there. */
    const backfill = async (states: PhaseStateEntity[], attempts: number): Promise<void> => {
      const rows = states.flatMap((state) =>
        Array.from({ length: attempts }, (_, n) => ({
          phaseStateId: state.id,
          userId: state.userId,
          status: 'completed' as const,
          score: 40,
          passed: false,
          report: report({ checks: [check('story.sentence', 'failed')] }),
          workspaceSnapshot: { 'requirements/draft.md': 'an old draft' },
          createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000),
        })),
      );
      for (let i = 0; i < rows.length; i += 100) {
        await manager().insert(SubmissionEntity, rows.slice(i, i + 100));
      }
    };

    it('reads one submission per phase however many attempts the class has made, and draws the same map', async () => {
      const states: PhaseStateEntity[] = [];
      for (let i = 0; i < 10; i++) {
        const learner = await saveUser(`scale${i}@learnsdlc.test`);
        const mine = await enrol(learner.id);
        states.push(...mine);
        await submit(mine[0], report({ checks: [check('story.sentence', 'passed')] }));
      }
      const phaseStates = states.length;
      expect(phaseStates).toBe(60);

      counter.issued = [];
      const before = await service.classMap(dana, 'tasktrackr');
      const readBefore = await submissionRowsRead();

      // Ten times the history, none of it newer than what is already there.
      await backfill(states, 20);
      expect(await manager().count(SubmissionEntity)).toBe(10 + phaseStates * 20);

      counter.issued = [];
      counter.queries = 0;
      const after = await service.classMap(dana, 'tasktrackr');
      const readAfter = await submissionRowsRead();

      // One row per phase state that has ever been submitted to, before and
      // after, never one row per attempt.
      expect(readBefore).toBeLessThanOrEqual(2 * 10);
      expect(readAfter).toBeLessThanOrEqual(2 * phaseStates);
      // and the map itself is untouched by history it does not show
      expect(JSON.stringify(after)).toEqual(JSON.stringify(before));
    });
  });
});

/**
 * The two reporting surfaces the class map draws
 * per phase, when a phase holds more than one task.
 *
 * The **cell** is the per-phase roll of a class: its counts, its average and
 * its median. It reads `phase_states`, which after the task roll-up *is* the
 * phase's answer, and it must go on reading `phase_states` rather than whichever
 * task's revision happens to be newest.
 *
 * The **node tally** is one row per artefact the pack gates on. Its `rules`
 * probe reads a report by check id, and on a split written phase each task's
 * report carries only its own rules, so read against the phase's newest
 * revision every sibling-owned rule node tallies `missing` for every learner,
 * and `lecturePoints` is computed from that tally. It has to ask the report of
 * the task that owns each rule.
 *
 * The `function`, `mutant` and `drill` probes are unreachable on a written
 * phase and are deliberately left exactly as they are; they need the same
 * per-task merge if those kinds ever become allowed on a written phase.
 */
describe('AnalyticsService.classMap, several tasks per phase', () => {
  let dataSource: DataSource;
  const manager = () => dataSource.manager;

  const assistant = {
    defaultBudget: async () => 20_000,
    budgetFor: async () => 20_000,
    tokensToday: async () => 0,
    activeProviderName: () => 'local-mentor',
    recentProviderName: async () => 'local-mentor',
  } as unknown as AssistantService;

  const TEACHER = 'ms-tan-tasktrackr';
  const V_FLAT = 'v-tasktrackr-head';
  const V_SPLIT = 'v-teacher-split';

  let dana: InstructorCaller;
  let learnerId = '';
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  let flatPhases: CompiledPhaseTasks[];
  let splitPhases: CompiledPhaseTasks[];

  /** The catalogue this describe block answers from: a flat shipped pack and a split copy. */
  const contentWithSplit = (): ContentService => {
    const loaded = new ContentService();
    loaded.loadAll();
    loaded.installVersions([
      { versionId: V_FLAT, content: shipped, phases: flatPhases, compiler: COMPILER_IDENTITY },
      { versionId: V_SPLIT, content: teacher, phases: splitPhases, compiler: COMPILER_IDENTITY },
    ]);
    return loaded;
  };

  const serviceOn = (content: ContentService): AnalyticsService =>
    new AnalyticsService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(AssistantMessageEntity),
      content,
      assistant,
    );

  const report = (checks: { id: string; status: 'passed' | 'failed' }[]): FeedbackReport => ({
    overall: 70,
    passed: true,
    passThreshold: 70,
    criteria: [],
    checks: checks.map((one) => ({ id: one.id, label: one.id, status: one.status, detail: '' })),
    aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'local' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: {
      relianceFlag: false,
      relianceIndex: 0,
      mentorPasteFlag: false,
      noEffortFlag: false,
      note: '',
    },
  });

  const nodeById = (view: ClassMapView, id: string) =>
    view.phases.flatMap((phase) => phase.nodes).find((node) => node.id === id);

  beforeAll(async () => {
    dataSource = await memoryDataSource();

    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject('tasktrackr');
    // a copy whose Design is still TaskTrackr 3.0.0's markdown kind, kept as the legacy fixture: the written
    // phase a teacher split (since 4.0.0 Design is a design phase and Requirements a story phase, each one work task)
    teacher = {
      ...shipped,
      slug: TEACHER,
      title: 'TaskTrackr (Ms Tan)',
      phases: shipped.phases.map((phase) => (phase.key === 'design' ? { ...phase, artifactKind: 'markdown', checks: LEGACY_DESIGN.checks, rubric: LEGACY_DESIGN.rubric } : phase)),
    } as ProjectContent;
    flatPhases = shipped.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] }));
    const design = teacher.phases.find((phase) => phase.key === 'design')!;
    const sole = soleTaskFor(design);
    // Two tasks about two parts of one document; the split a teacher makes a written phase for. The
    // rule units partition; `owns` deliberately does not have to.
    splitPhases = teacher.phases.map((phase) =>
      phase.key === 'design'
        ? {
            key: phase.key,
            tasks: [
              {
                ...sole,
                taskKey: 'story',
                order: 1,
                gradedUnits: [{ kind: 'rule' as const, id: 'trace-us2' }],
              },
              {
                ...sole,
                taskKey: 'scope',
                order: 2,
                gradedUnits: [{ kind: 'rule' as const, id: 'decision-tradeoff' }],
              },
            ],
          }
        : { key: phase.key, tasks: [soleTaskFor(phase)] },
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    const danaRow = await manager().save(
      manager().create(UserEntity, {
        email: 'dana@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'dana',
        cohort: 'tuesday',
        role: 'INSTRUCTOR',
      }),
    );
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: 'tuesday' };
    learnerId = (
      await manager().save(
        manager().create(UserEntity, {
          email: 'lee@learnsdlc.test',
          passwordHash: 'x',
          displayName: 'lee',
          cohort: 'tuesday',
        }),
      )
    ).id;
  });

  /** Enrol on the split copy, pinned to it, and hand back the phase states by key. */
  const enrolOnSplit = async (): Promise<Record<string, PhaseStateEntity>> => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: learnerId,
        projectSlug: TEACHER,
        projectVersionId: V_SPLIT,
        currentPhaseOrder: 1,
      }),
    );
    const out: Record<string, PhaseStateEntity> = {};
    for (const phase of teacher.phases) {
      out[phase.key] = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId: learnerId,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          status: phase.order === 1 ? 'in_progress' : 'locked',
        }),
      );
    }
    for (const taskKey of ['story', 'scope']) {
      await manager().save(
        manager().create(TaskStateEntity, {
          phaseStateId: out.design.id,
          userId: learnerId,
          taskKey,
        }),
      );
    }
    return out;
  };

  const revise = (
    state: PhaseStateEntity,
    taskKey: string,
    body: FeedbackReport,
    createdAt: Date,
  ) =>
    manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: state.id,
        userId: state.userId,
        taskKey,
        status: 'completed',
        score: body.overall,
        passed: body.passed,
        report: body,
        createdAt,
      }),
    );

  it('the cell reads the phase row, not an arbitrary submission', async () => {
    const states = await enrolOnSplit();
    await manager().update(PhaseStateEntity, states.design.id, {
      status: 'passed',
      bestScore: 82,
      attempts: 3,
    });
    // A newer, failing, low-scoring revision of one task. The cell must not
    // take it for the phase's answer: after the roll-up `phase_states` is.
    await revise(
      states.design,
      'scope',
      { ...report([{ id: 'decision-tradeoff', status: 'failed' }]), overall: 10, passed: false },
      new Date('2026-09-03T10:00:00.000Z'),
    );

    const map = await serviceOn(contentWithSplit()).classMap(dana, TEACHER);
    const design = map.phases.find((phase) => phase.key === 'design')!;
    expect(design.counts).toMatchObject({ passed: 1, submitted: 0, in_progress: 0 });
    expect(design.averageScore).toBe(82);
    expect(design.medianScore).toBe(82);
  });

  it('a board of sole-task phases draws the map it draws today', async () => {
    // The same class, on the shipped pack: no task rows, one revision per phase
    // state, and the tally is the tally the phase-wide read computes.
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: learnerId,
        projectSlug: 'tasktrackr',
        projectVersionId: V_FLAT,
        currentPhaseOrder: 1,
      }),
    );
    const first = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId: learnerId,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'in_progress',
      }),
    );
    await revise(
      first,
      '',
      report([
        { id: 'story.sentence', status: 'passed' },
        { id: 'story.scope.min', status: 'failed' },
      ]),
      new Date('2026-09-01T10:00:00.000Z'),
    );

    const map = await serviceOn(contentWithSplit()).classMap(dana, 'tasktrackr');
    expect(nodeById(map, 'requirements:story:story.sentence')).toMatchObject({ green: 1 });
    expect(await manager().count(TaskStateEntity)).toBe(0);
  });
});

/**
 * Quizzes: the two percentages over a version that holds a quiz.
 *
 * The questions below are a **fixture**, clearly marked as one. The starter
 * quizzes are a content task for the teaching team; nothing invented here is
 * ever presented as reviewed material, and none of it ships in TaskTrackr,
 * which stays quiz-free.
 *
 * The shape is the all-six-phases rule's: one non-quiz task owning every graded
 * unit and every editable path the phase mounts, beside a quiz task that owns
 * no file. On a `markdown` phase that is the wall's first arm (every task
 * graded by a kind whose evidence costs no microVM) so the version is servable
 * and an enrolment resolves against it.
 */
describe('AnalyticsService, the two percentages over a version holding a quiz', () => {
  let dataSource: DataSource;
  const manager = () => dataSource.manager;

  const assistant = {
    defaultBudget: async () => 20_000,
    budgetFor: async () => 20_000,
    tokensToday: async () => 0,
    activeProviderName: () => 'local-mentor',
    recentProviderName: async () => 'local-mentor',
  } as unknown as AssistantService;

  const TEACHER = 'ms-tan-quizzes';
  const V_QUIZ = 'v-teacher-quiz';

  let teacher: ProjectContent;
  let artefact: CompiledTask;
  let instructorId = '';
  let learnerId = '';

  /** Two questions, obviously made up, with a key and explanations to seal. */
  const QUIZ_CHECKS: QuizChecks = {
    kind: 'quiz',
    questions: [
      {
        id: 'q1',
        stem: 'FIXTURE — which colour is this test?',
        options: [
          { id: 'a', text: 'Green' },
          { id: 'b', text: 'Red' },
        ],
        correct: ['a'],
        explanation: 'FIXTURE — because the suite passes.',
        concept: 'fixtures',
      },
      {
        id: 'q2',
        stem: 'FIXTURE — how many questions are in this quiz?',
        options: [
          { id: 'a', text: 'One' },
          { id: 'b', text: 'Two' },
        ],
        correct: ['b'],
        explanation: 'FIXTURE — you are reading the second.',
        concept: 'fixtures',
      },
    ],
    shuffleOptions: false,
    passMark: 60,
    attempts: { max: null, cooldownSeconds: null },
    criterion: 'concepts',
  };

  const quizTask = (required: boolean): CompiledTask => ({
    taskKey: 'concepts',
    order: 2,
    required,
    signOff: false,
    checkKind: 'quiz',
    artefactType: 'quiz',
    // A quiz owns no file and reads none, and that
    // is why adding one to a phase moves the checklist's numerator and
    // denominator and nothing else about the phase.
    artefactPath: null,
    title: 'Concept check (fixture)',
    brief: 'FIXTURE — a made-up quiz, for tests only.',
    objectives: [],
    owns: [],
    gradedUnits: QUIZ_CHECKS.questions.map((one) => ({ kind: 'question' as const, id: one.id })),
    rubric: { criteria: [], passThreshold: 60 },
    checks: QUIZ_CHECKS,
  });

  /** The catalogue: one teacher copy whose requirements phase holds a quiz. */
  const contentWithQuiz = (required: boolean): ContentService => {
    const loaded = new ContentService();
    loaded.loadAll();
    loaded.installVersions([
      {
        versionId: V_QUIZ,
        content: teacher,
        phases: teacher.phases.map((phase) =>
          phase.key === 'requirements'
            ? { key: phase.key, tasks: [artefact, quizTask(required)] }
            : { key: phase.key, tasks: [soleTaskFor(phase)] },
        ),
        compiler: COMPILER_IDENTITY,
      },
    ]);
    return loaded;
  };

  const serviceOn = (content: ContentService): AnalyticsService =>
    new AnalyticsService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(AssistantMessageEntity),
      content,
      assistant,
    );

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const loader = new ContentService();
    loader.loadAll();
    const shipped = loader.getProject('tasktrackr');
    teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)' };
    // The artefact task a copy carries: keyed `main`, owning everything the
    // phase mounts, exactly as `createProject` writes it.
    artefact = {
      ...soleTaskFor(teacher.phases.find((phase) => phase.key === 'requirements')!),
      taskKey: 'main',
      order: 1,
    };
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    instructorId = (
      await manager().save(
        manager().create(UserEntity, {
          email: 'tan@learnsdlc.test',
          passwordHash: 'x',
          displayName: 'Ms Tan',
          cohort: 'tuesday',
          role: 'INSTRUCTOR',
        }),
      )
    ).id;
    learnerId = (
      await manager().save(
        manager().create(UserEntity, {
          email: 'lee@learnsdlc.test',
          passwordHash: 'x',
          displayName: 'Lee',
          cohort: 'tuesday',
        }),
      )
    ).id;
  });

  /**
   * A board on the quiz version: six phase rows, and the requirements phase's
   * two task rows. `bestScore` of `undefined` for the quiz means no row at all;
   * a quiz nobody has opened.
   */
  const enrolOnQuiz = async (facts: {
    artefactPassed: boolean;
    quizScore?: number | null;
  }): Promise<void> => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: learnerId,
        projectSlug: TEACHER,
        projectVersionId: V_QUIZ,
        currentPhaseOrder: 1,
      }),
    );
    let requirements = '';
    for (const phase of teacher.phases) {
      const row = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId: learnerId,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          status: phase.order === 1 ? 'in_progress' : 'locked',
        }),
      );
      if (phase.key === 'requirements') requirements = row.id;
    }
    await manager().save(
      manager().create(TaskStateEntity, {
        phaseStateId: requirements,
        userId: learnerId,
        taskKey: 'main',
        status: facts.artefactPassed ? 'passed' : 'in_progress',
        bestScore: facts.artefactPassed ? 90 : null,
      }),
    );
    if (facts.quizScore !== undefined) {
      await manager().save(
        manager().create(TaskStateEntity, {
          phaseStateId: requirements,
          userId: learnerId,
          taskKey: 'concepts',
          status: facts.quizScore !== null && facts.quizScore >= 60 ? 'passed' : 'in_progress',
          bestScore: facts.quizScore,
        }),
      );
    }
  };

  it('counts a required quiz on the checklist and its best score as mastery', async () => {
    await enrolOnQuiz({ artefactPassed: true, quizScore: 80 });
    const numbers = await serviceOn(contentWithQuiz(true)).forLearner(learnerId, TEACHER);

    // Seven required tasks across the version (the quiz is the seventh) and
    // two of them passed.
    expect(numbers.checklistPercent).toBe(Math.round((2 / 7) * 100));
    expect(numbers.masteryPercent).toBe(80);
    // The phase itself: both of its required tasks done, and one quiz scored.
    const requirements = numbers.phases.find((phase) => phase.key === 'requirements');
    expect(requirements?.checklistPercent).toBe(100);
    expect(requirements?.masteryPercent).toBe(80);
    // A phase with no quiz reads a blank, not a nought, on its own row too.
    const design = numbers.phases.find((phase) => phase.key === 'design');
    expect(design?.checklistPercent).toBe(0);
    expect(design?.masteryPercent).toBeNull();
    // And neither of the two shipped figures gained a summand: the phase rows
    // are untouched by a task's score until the roll-up writes them.
    expect(numbers.progressPercent).toBe(0);
    expect(numbers.averageScore).toBeNull();
  });

  it('reads a quiz nobody has opened as a blank, never as a zero', async () => {
    await enrolOnQuiz({ artefactPassed: true });
    const numbers = await serviceOn(contentWithQuiz(true)).forLearner(learnerId, TEACHER);
    // An unanswered question is not an answer scored badly. Counting the
    // missing row as 0 would put this learner's *concepts* number at 0%.
    expect(numbers.masteryPercent).toBeNull();
    // The checklist still counts it, because it is still declared and still
    // required: one of seven done.
    expect(numbers.checklistPercent).toBe(14);
  });

  it('leaves an optional quiz off the checklist and still reads its score', async () => {
    await enrolOnQuiz({ artefactPassed: true, quizScore: 50 });
    const numbers = await serviceOn(contentWithQuiz(false)).forLearner(learnerId, TEACHER);
    // Six required tasks now, not seven: an optional task moves no gate, so it
    // is not on the checklist at either end of the fraction.
    expect(numbers.checklistPercent).toBe(Math.round((1 / 6) * 100));
    // But it was answered, so the concepts number has something to say, and a
    // failed optional quiz says it honestly rather than being left out.
    expect(numbers.masteryPercent).toBe(50);
  });

  it('says the same two numbers to the class table as to the learner', async () => {
    await enrolOnQuiz({ artefactPassed: true, quizScore: 80 });
    const service = serviceOn(contentWithQuiz(true));
    const mine = await service.forLearner(learnerId, TEACHER);
    const [row] = (await service.instructorOverview(instructorId)).learners.filter(
      (one) => one.email === 'lee@learnsdlc.test',
    );
    expect(row.checklistPercent).toBe(mine.checklistPercent);
    expect(row.masteryPercent).toBe(mine.masteryPercent);
    expect(row.masteryPercent).toBe(80);
  });

  it('is the mean over every quiz of the version, not over the phases that hold one', async () => {
    // Two quizzes, in two phases, one scored and one not. The mean is over the
    // quizzes that have a score (one of them) and never over the phases.
    const loaded = new ContentService();
    loaded.loadAll();
    loaded.installVersions([
      {
        versionId: V_QUIZ,
        content: teacher,
        phases: teacher.phases.map((phase) =>
          phase.key === 'requirements'
            ? { key: phase.key, tasks: [artefact, quizTask(true)] }
            : phase.key === 'design'
              ? {
                  key: phase.key,
                  tasks: [
                    { ...soleTaskFor(teacher.phases[1]), taskKey: 'main', order: 1 },
                    quizTask(true),
                  ],
                }
              : { key: phase.key, tasks: [soleTaskFor(phase)] },
        ),
        compiler: COMPILER_IDENTITY,
      },
    ]);
    await enrolOnQuiz({ artefactPassed: true, quizScore: 70 });

    const numbers = await serviceOn(loaded).forLearner(learnerId, TEACHER);
    expect(numbers.masteryPercent).toBe(70);
    // Eight required tasks now (two phases hold two each) and two passed.
    expect(numbers.checklistPercent).toBe(25);
    expect(
      numbers.phases.find((phase) => phase.key === 'design')?.masteryPercent,
    ).toBeNull();
  });
});

// The memo key of `ruleOwnersFor` must not be typed with raw NUL bytes: they
// make the whole module binary to ordinary tooling, so grep skips it and a
// diff prints "Binary files differ" instead of the change, and checks that
// read the source pass on a file no one can read. The separator is behaviour
// and stays; the source is pinned to text so the bytes can neither go missing
// nor appear raw.
describe('AnalyticsService source hygiene', () => {
  const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8');

  it('writes the rule-owner memo key in plain ASCII, so no raw control byte lives in the module', () => {
    const raw = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    const module = read('analytics.service.ts');
    expect(module).not.toMatch(raw);
    // The separator still separates all three parts of the pin, escaped.
    expect(module).toContain('\\u0000${enrollment.projectVersionId');
    expect(module).toContain('\\u0000${phase.key}');
    // This file too: a fixture is the other place a raw control byte gets typed.
    expect(read('analytics.service.spec.ts')).not.toMatch(raw);
  });
});
