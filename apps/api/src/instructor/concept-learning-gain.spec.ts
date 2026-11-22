import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PHASE_ORDER } from '@learnsdlc/shared';
import { CohortEntity, EnrollmentEntity, PhaseStateEntity, QuizAttemptEntity, UserEntity } from '../db/entities';
import type { InstructorCaller } from './cohort-scope';
import { LEARNING_GAIN_COLUMNS, QuizLearningGainController } from './quiz-results-export.controller';
import { QUIZ_CONTROLLERS } from '../quiz/quiz.module';
import { QuizResultsExportService } from './quiz-results-export.service';
import { conceptChecks, conceptTask } from '../quiz/concept/concept';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The before/after learning gain, for the teacher.
 *
 * Monday (Dana's): Ana before 50 after 83; Ben before 33 after 100; Cai before
 * 67 only (unpaired); a voided after for Ben is ignored; Ana also holds a pack
 * quiz paper, which the gain never reads and the per-paper exports do.
 * Thursday (Sam's): Eve before 0 after 100, never in Dana's view.
 */
describe('learning gain', () => {
  let dataSource: DataSource;
  let service: QuizResultsExportService;
  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let monday = '';

  const manager = () => dataSource.manager;
  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  async function design(userId: string): Promise<PhaseStateEntity> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug: 'starter', projectVersionId: 'pv-1', currentPhaseOrder: 1 }),
    );
    return manager().save(
      manager().create(PhaseStateEntity, { enrollmentId: enrollment.id, userId, phaseKey: 'design', phaseOrder: 1, status: 'passed' }),
    );
  }

  let clock = 0;
  async function paper(state: PhaseStateEntity, taskKey: string, score: number, voided = false) {
    clock += 1;
    const at = new Date(Date.UTC(2026, 9, 6, 9, clock)).toISOString();
    await manager().save(
      manager().create(QuizAttemptEntity, {
        phaseStateId: state.id,
        userId: state.userId,
        taskKey,
        epoch: 0,
        voidedAt: voided ? at : null,
        projectVersionId: 'pv-1',
        packVersion: taskKey.startsWith('concept-') ? 'concept-bank@1' : '1.0.0',
        submissionId: null,
        paper: [{ questionId: 'des-coupling-cohesion', optionIds: ['a', 'b', 'c', 'd'] }],
        answers: voided ? null : { 'des-coupling-cohesion': ['b'] },
        score: voided ? null : score,
        passed: voided ? null : true,
        startedAt: at,
        submittedAt: at,
      }),
    );
  }

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    service = new QuizResultsExportService(dataSource, {} as never);
    const danaRow = await saveUser({ email: 'dana@rf.test', role: 'INSTRUCTOR', displayName: 'Dana' });
    const samRow = await saveUser({ email: 'sam@rf.test', role: 'INSTRUCTOR', displayName: 'Sam' });
    monday = (await manager().save(manager().create(CohortEntity, { name: 'Monday', joinCode: 'RFMON001', ownerUserId: danaRow.id }))).id;
    const thursday = (await manager().save(manager().create(CohortEntity, { name: 'Thursday', joinCode: 'RFTHU001', ownerUserId: samRow.id }))).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: monday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };

    const A = await design((await saveUser({ email: 'ana@rf.test', displayName: 'Ana', cohort: monday })).id);
    const B = await design((await saveUser({ email: 'ben@rf.test', displayName: '=HYPERLINK("x")', cohort: monday })).id);
    const C = await design((await saveUser({ email: 'cai@rf.test', displayName: 'Cai', cohort: monday })).id);
    const E = await design((await saveUser({ email: 'eve@rf.test', displayName: 'Eve', cohort: thursday })).id);
    await paper(A, 'concept-before', 50);
    await paper(A, 'concept-after', 83);
    await paper(A, 'design-check', 40);
    await paper(B, 'concept-before', 33);
    await paper(B, 'concept-after', 0, true);
    await paper(B, 'concept-after', 100);
    await paper(C, 'concept-before', 67);
    await paper(E, 'concept-before', 0);
    await paper(E, 'concept-after', 100);
    // Dee takes the before check only after starting the after one: not a pre-measure.
    const D = await design((await saveUser({ email: 'dee@rf.test', displayName: 'Dee', cohort: monday })).id);
    await paper(D, 'concept-after', 100);
    await paper(D, 'concept-before', 17);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('pairs before and after per learner and averages paired learners only', async () => {
    const gain = await service.learningGain(dana, { cohort: monday });
    expect(gain.phases.map((one) => one.phaseKey)).toEqual(PHASE_ORDER);
    const designGain = gain.phases.find((one) => one.phaseKey === 'design')!;
    expect(designGain.title).toBe('Design');
    expect(designGain.n).toBe(2);
    expect(designGain.beforeAvgPct).toBe(41.5);
    expect(designGain.afterAvgPct).toBe(91.5);
    expect(designGain.deltaPct).toBe(50);
    expect(designGain.learners).toEqual([
      { learner: '=HYPERLINK("x")', beforePct: 33, afterPct: 100, deltaPct: 67 },
      { learner: 'Ana', beforePct: 50, afterPct: 83, deltaPct: 33 },
      { learner: 'Cai', beforePct: 67, afterPct: null, deltaPct: null },
      { learner: 'Dee', beforePct: null, afterPct: 100, deltaPct: null },
    ]);
    const empty = gain.phases.find((one) => one.phaseKey === 'testing')!;
    expect(empty).toEqual({ phaseKey: 'testing', title: 'Testing', n: 0, beforeAvgPct: null, afterAvgPct: null, deltaPct: null, learners: [] });
    expect(JSON.stringify(gain)).not.toMatch(/@rf\.test|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('scopes to the caller’s classes', async () => {
    const all = await service.learningGain(dana, {});
    expect(all.phases.find((one) => one.phaseKey === 'design')!.learners.map((one) => one.learner)).not.toContain('Eve');
    const thursday = await service.learningGain(sam, {});
    expect(thursday.phases.find((one) => one.phaseKey === 'design')!.learners).toEqual([
      { learner: 'Eve', beforePct: 0, afterPct: 100, deltaPct: 100 },
    ]);
    await expect(service.learningGain(sam, { cohort: monday })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes the CSV with the agreed columns and injection-safe cells', async () => {
    // The other quiz files' register; camelCase
    // identifiers, worded measures (phaseKey, 'attempts used', '% right').
    expect(LEARNING_GAIN_COLUMNS).toEqual(['phaseKey', 'learner', 'before %', 'after %', 'change (points)']);
    const csv = await service.learningGainCsv(dana, { cohort: monday });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('phaseKey,learner,before %,after %,change (points)');
    expect(lines).toContain('design,Ana,50,83,33');
    expect(lines).toContain('design,Cai,67,,');
    expect(lines).toContain('design,Dee,,100,');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('keeps concept papers out of the existing summary and CSVs', async () => {
    const summary = await service.summary(dana, { cohort: monday });
    expect(summary.learners.map((one) => one.taskKey)).toEqual(['design-check']);
    expect(summary.quizzes.map((one) => one.taskKey)).toEqual(['design-check']);
    for (const kind of ['learners', 'attempts', 'questions', 'class'] as const) {
      expect(await service.export(dana, kind)).not.toMatch(/concept/);
    }
  });

  it('the four quiz CSVs carry zero concept rows for a class whose learner took both checks, class-scoped and unscoped', async () => {
    // Ana (Monday) took both concept checks and one pack quiz paper. The
    // catalogue below declares the concept keys as quizzes too, so a paper
    // that got past the read's concept filter would mark and land in every
    // file; only the read's filter keeps them out.
    const checks = conceptChecks('design')!;
    const declared = [
      conceptTask('design', 'concept-before', checks),
      conceptTask('design', 'concept-after', checks),
      { ...conceptTask('design', 'concept-before', checks), taskKey: 'design-check' },
    ];
    const catalogue = {
      resolveForEnrollment: () => ({ versionId: 'pv-1' }),
      getPhaseForEnrollment: () => ({ key: 'design', checks }),
      getTasksForEnrollment: () => declared,
    };
    const files = new QuizResultsExportService(dataSource, catalogue as never);
    const rowsOf = (csv: string) => csv.split('\r\n').filter(Boolean).slice(1);
    const expected = { learners: 1, attempts: 1, questions: 1, class: 1 } as const;
    for (const read of [{ cohort: monday }, {}]) {
      for (const kind of ['learners', 'attempts', 'questions', 'class'] as const) {
        const csv = await files.export(dana, kind, read);
        const header = csv.split('\r\n')[0].split(',');
        const at = header.indexOf('taskKey');
        expect(at).toBeGreaterThanOrEqual(0);
        const rows = rowsOf(csv);
        // Only the pack quiz's rows: concept-check papers add none.
        expect(rows).toHaveLength(expected[kind]);
        for (const row of rows) expect(row.split(',')[at]).toBe('design-check');
        expect(csv).not.toMatch(/concept-(before|after)/);
      }
    }
  });

  it('mounts both routes on the instructor controllers', async () => {
    const quizResults = {
      learningGain: jest.fn(async () => ({ phases: [] })),
      learningGainCsv: jest.fn(async () => 'phaseKey,learner,before %,after %,change (points)\r\n'),
    };
    expect(QUIZ_CONTROLLERS).toContain(QuizLearningGainController);
    expect(Reflect.getMetadata('path', QuizLearningGainController)).toBe('instructor');
    expect(Reflect.getMetadata('roles', QuizLearningGainController)).toEqual(['INSTRUCTOR', 'ADMIN']);
    const files = new QuizLearningGainController(quizResults as never);
    await expect(files.learningGain({ id: 'x' } as never, { cohort: 'c' })).resolves.toEqual({ phases: [] });
    expect(Reflect.getMetadata('path', QuizLearningGainController.prototype.learningGain)).toBe('quiz-results/learning-gain');
    const headers: Record<string, string> = {};
    const body = await files.learningGainCsv({ id: 'x' } as never, {}, { setHeader: (k: string, v: string) => (headers[k] = v) } as never);
    expect(body).toMatch(/^phaseKey,learner/);
    expect(headers['content-type']).toMatch(/text\/csv/);
    expect(headers['content-disposition']).toContain('quiz-learning-gain.csv');
    expect(Reflect.getMetadata('path', QuizLearningGainController.prototype.learningGainCsv)).toBe('quiz-results/learning-gain.csv');
  });
});
