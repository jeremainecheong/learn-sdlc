import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QUIZ_RESULTS_EXPORT_KINDS, type QuizQuestion, type QuizResultsExportKind } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { compilePack } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  CohortEntity,
  CohortProjectAssignmentEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  QuizAttemptEntity,
  UserEntity,
} from '../db/entities';
import { classProjectVersionOf } from '../classroom/cohort-project.service';
import type { InstructorCaller } from './cohort-scope';
import { QuizResultsExportService } from './quiz-results-export.service';
import {
  executablePhase,
  fixturePack,
  fixtureQuizChecks,
  fixtureQuizTask,
  soleGradedTask,
  writtenPhase,
} from '../../test/quiz-fixture';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The quiz summary's
 * declared quizzes come from the class's version as CohortProjectService
 * resolves it: the active assignment row, else the deployment's default
 * project (the one the class card says a joiner starts on), at the version
 * the catalogue serves for it.
 *
 * Fixture: `quiz-fixture` 1.0.0 (assigned to Monday) declares design-check and
 * deployment-check; `quiz-default` 1.0.0 (the flagged default, platform-owned)
 * declares default-design-check and default-deploy-check. Thursday has no
 * assignment row; Eve (Thursday) has handed in one paper on
 * default-design-check. Friday has no assignment row and no learner.
 */

const SLUG = 'quiz-fixture';
const DEFAULT_SLUG = 'quiz-default';
const V_QUIZ = '1d0d0d0d-0000-4000-8000-00000000000a';
const V_DEFAULT = '1d0d0d0d-0000-4000-8000-00000000000d';
/** A version row the catalogue does not hold. */
const V_GONE = '1d0d0d0d-0000-4000-8000-00000000000f';

const RIGHT = (n: number) => `RESEALRIGHT${n}`;
const WRONG = (n: number) => `RESEALWRONG${n}`;

function sealedQuestions(): QuizQuestion[] {
  return [1, 2, 3].map((n) => ({
    id: `q${n}`,
    stem: `RESEAL STEM ${n}`,
    options: [
      { id: RIGHT(n), text: `RESEAL OPTION TEXT ${n} right` },
      { id: WRONG(n), text: `RESEAL OPTION TEXT ${n} wrong` },
    ],
    correct: [RIGHT(n)],
    explanation: `RESEAL EXPLANATION ${n}`,
    concept: `reseal-concept-${n}`,
  }));
}

/** RFC 4180, enough for these files: quoted cells, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const ch = text[at];
    if (quoted) {
      if (ch === '"' && text[at + 1] === '"') {
        cell += '"';
        at++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[at + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      at++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function records(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((name, at) => [name, row[at]])));
}

const numberOrNull = (cell: string): number | null => (cell === '' ? null : Number(cell));

describe('declared quizzes follow the class version CohortProjectService resolves', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: QuizResultsExportService;
  let monday: string;
  let thursday: string;
  let friday: string;
  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let admin: InstructorCaller;

  const manager = () => dataSource.manager;
  const saveUser = (fields: Partial<UserEntity> & { email: string }) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  const allFiles = async (caller: InstructorCaller, read = {}) =>
    Object.fromEntries(
      await Promise.all(QUIZ_RESULTS_EXPORT_KINDS.map(async (kind) => [kind, await service.export(caller, kind, read)])),
    ) as Record<QuizResultsExportKind, string>;

  const shape = (quizzes: { project: string; taskKey: string; declared: boolean; title: string | null; attempts: number }[]) =>
    quizzes.map((quiz) => [quiz.project, quiz.taskKey, quiz.declared, quiz.title, quiz.attempts]);

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const checks = fixtureQuizChecks({ questions: sealedQuestions(), drawn: 3 });
    const assigned = (() => {
      const written = writtenPhase();
      const executable = executablePhase(false);
      return compilePack(fixturePack([written, executable]), {
        authored: {
          design: [soleGradedTask(written), fixtureQuizTask('design-check', 2, { title: 'Check the design' }, checks)],
          deployment: [soleGradedTask(executable), fixtureQuizTask('deployment-check', 2, { title: 'Check the deployment' }, checks)],
        },
      });
    })();
    const fallback = (() => {
      const written = writtenPhase();
      const executable = executablePhase(false);
      return compilePack(
        { ...fixturePack([written, executable]), slug: DEFAULT_SLUG, title: 'the default project' },
        {
          authored: {
            design: [soleGradedTask(written), fixtureQuizTask('default-design-check', 2, { title: 'Default design check' }, checks)],
            deployment: [
              soleGradedTask(executable),
              fixtureQuizTask('default-deploy-check', 2, { title: 'Default deployment check' }, checks),
            ],
          },
        },
      );
    })();
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      { versionId: V_QUIZ, content: assigned.content, compiler: assigned.compiler, phases: assigned.phases },
      { versionId: V_DEFAULT, content: fallback.content, compiler: fallback.compiler, phases: fallback.phases },
    ]);
    service = new QuizResultsExportService(dataSource, content);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const danaRow = await saveUser({ email: 'dana@re.test', role: 'INSTRUCTOR', displayName: 'Dana' });
    const samRow = await saveUser({ email: 'sam@re.test', role: 'INSTRUCTOR', displayName: 'Sam' });
    const adminRow = await saveUser({ email: 'ops@re.test', role: 'ADMIN', displayName: 'Ops' });
    monday = (await manager().save(manager().create(CohortEntity, { name: 'Monday 10am', joinCode: 'REMON001', ownerUserId: danaRow.id }))).id;
    thursday = (await manager().save(manager().create(CohortEntity, { name: 'Thursday', joinCode: 'RETHU001', ownerUserId: samRow.id }))).id;
    friday = (await manager().save(manager().create(CohortEntity, { name: 'Friday', joinCode: 'REFRI001', ownerUserId: samRow.id }))).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: monday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };
    admin = { id: adminRow.id, role: 'ADMIN', cohort: 'default' };

    const project = await manager().save(
      manager().create(ProjectEntity, { slug: SLUG, title: 'the quiz fixture project', origin: 'fork', ownerUserId: danaRow.id }),
    );
    const fallback = await manager().save(
      manager().create(ProjectEntity, { slug: DEFAULT_SLUG, title: 'the default project', origin: 'seed', platformOwned: true, isDefault: true }),
    );
    const manifest = { tagline: 't', description: 'd', language: 'python', languages: ['python'] };
    await manager().save(manager().create(ProjectVersionEntity, { id: V_QUIZ, projectId: project.id, version: '1.0.0', status: 'published', manifest }));
    await manager().save(manager().create(ProjectVersionEntity, { id: V_DEFAULT, projectId: fallback.id, version: '1.0.0', status: 'published', manifest }));
    await manager().save(
      manager().create(CohortProjectAssignmentEntity, {
        cohortId: monday,
        projectVersionId: V_QUIZ,
        assignedByUserId: danaRow.id,
        state: 'active',
        reason: 'This class takes the concept checks.',
      }),
    );

    // Eve (Thursday) works the default project and has handed in one paper.
    const eve = (await saveUser({ email: 'eve@re.test', displayName: 'Eve', cohort: thursday })).id;
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId: eve, projectSlug: DEFAULT_SLUG, projectVersionId: V_DEFAULT, currentPhaseOrder: 1 }),
    );
    const design = await manager().save(
      manager().create(PhaseStateEntity, { enrollmentId: enrollment.id, userId: eve, phaseKey: 'design', phaseOrder: 1, status: 'in_progress' }),
    );
    await manager().save(
      manager().create(QuizAttemptEntity, {
        phaseStateId: design.id,
        userId: eve,
        taskKey: 'default-design-check',
        epoch: 0,
        voidedAt: null,
        projectVersionId: V_DEFAULT,
        packVersion: '1.0.0',
        submissionId: null,
        paper: [1, 2, 3].map((n) => ({ questionId: `q${n}`, optionIds: [WRONG(n), RIGHT(n)] })),
        answers: { q1: [RIGHT(1)], q2: [RIGHT(2)], q3: [WRONG(3)] },
        score: 66.7,
        passed: true,
        startedAt: '2026-10-01T09:00:00.000Z',
        submittedAt: '2026-10-01T09:05:00.000Z',
      }),
    );
  });

  it('a class on the default project with no assignment row declares its quizzes: a sat one, and a zero card', async () => {
    const summary = await service.summary(sam, { cohort: thursday });
    expect(shape(summary.quizzes)).toEqual([
      [DEFAULT_SLUG, 'default-design-check', true, 'Default design check', 1],
      [DEFAULT_SLUG, 'default-deploy-check', true, 'Default deployment check', 0],
    ]);
    const zero = summary.quizzes.find((quiz) => quiz.taskKey === 'default-deploy-check')!;
    expect(zero).toMatchObject({ phaseKey: 'deployment', learnersAttempted: 0, learnersPassed: 0, passRate: null, questions: [] });

    // A class with nobody in it and no assignment row: the zero cards alone.
    const empty = await service.summary(sam, { cohort: friday });
    expect(empty.learnersInClass).toBe(0);
    expect(shape(empty.quizzes)).toEqual([
      [DEFAULT_SLUG, 'default-design-check', true, 'Default design check', 0],
      [DEFAULT_SLUG, 'default-deploy-check', true, 'Default deployment check', 0],
    ]);
  });

  it('an assigned class is unchanged: its own version, never the default project', async () => {
    const summary = await service.summary(dana, { cohort: monday });
    expect(shape(summary.quizzes)).toEqual([
      [SLUG, 'design-check', true, 'Check the design', 0],
      [SLUG, 'deployment-check', true, 'Check the deployment', 0],
    ]);
    expect(JSON.stringify(summary)).not.toContain(DEFAULT_SLUG);
  });

  it('a pin the deployment no longer holds still declares nothing (assignment row or default)', async () => {
    // The assignment names a version the catalogue does not hold: nothing, and not the default either.
    const project = await manager().findOneByOrFail(ProjectEntity, { slug: SLUG });
    await manager().save(manager().create(ProjectVersionEntity, { id: V_GONE, projectId: project.id, version: '0.9.0', status: 'published', manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] } }));
    await manager().update(CohortProjectAssignmentEntity, { cohortId: monday }, { projectVersionId: V_GONE });
    expect((await service.summary(dana, { cohort: monday })).quizzes).toEqual([]);

    // The flagged default is a project the catalogue does not serve: nothing; papers still list.
    await manager().update(ProjectEntity, { slug: DEFAULT_SLUG }, { slug: 'not-served-here' });
    expect((await service.summary(sam, { cohort: friday })).quizzes).toEqual([]);
    expect(shape((await service.summary(sam, { cohort: thursday })).quizzes)).toEqual([
      [DEFAULT_SLUG, 'default-design-check', false, 'Default design check', 1],
    ]);

    // No flagged default at all: nothing declared.
    await manager().update(ProjectEntity, { slug: 'not-served-here' }, { isDefault: false });
    expect((await service.summary(sam, { cohort: friday })).quizzes).toEqual([]);
  });

  it('a project filter other than the default project declares nothing from it', async () => {
    const summary = await service.summary(sam, { cohort: friday, project: SLUG });
    expect(summary.quizzes).toEqual([]);
    const own = await service.summary(sam, { cohort: friday, project: DEFAULT_SLUG });
    expect(own.quizzes.map((quiz) => quiz.taskKey)).toEqual(['default-design-check', 'default-deploy-check']);
  });

  it('classProjectVersionOf: the active row, else the flagged default by slug, else null', async () => {
    expect(await classProjectVersionOf(manager(), monday)).toEqual({ from: 'assignment', projectVersionId: V_QUIZ });
    expect(await classProjectVersionOf(manager(), thursday)).toEqual({ from: 'default', projectSlugs: [DEFAULT_SLUG] });
    await manager().update(CohortProjectAssignmentEntity, { cohortId: monday }, { state: 'superseded' });
    expect(await classProjectVersionOf(manager(), monday)).toEqual({ from: 'default', projectSlugs: [DEFAULT_SLUG] });
    await manager().update(ProjectEntity, { slug: DEFAULT_SLUG }, { isDefault: false });
    expect(await classProjectVersionOf(manager(), thursday)).toBeNull();
  });

  it('every summary number on the default-project class equals the value parsed from the matching CSV', async () => {
    for (const [caller, read] of [
      [sam, { cohort: thursday }],
      [admin, { cohort: thursday }],
      [sam, { cohort: thursday, project: DEFAULT_SLUG }],
    ] as const) {
      const summary = await service.summary(caller, read);
      const files = await allFiles(caller, read);
      const learnersCsv = records(files.learners);
      const attemptsCsv = records(files.attempts);
      const classCsv = records(files.class);
      expect(summary.learners).toEqual(
        learnersCsv.map((row) => ({
          email: row.email,
          displayName: row.displayName,
          project: row.project,
          phaseKey: row.phaseKey,
          taskKey: row.taskKey,
          attemptsUsed: Number(row['attempts used']),
          attemptsVoided: Number(row['attempts voided']),
          bestScore: numberOrNull(row['best score']),
          latestScore: numberOrNull(row['latest score']),
          passed: row.passed === '' ? null : row.passed === 'yes',
        })),
      );
      for (const quiz of summary.quizzes) {
        const mine = learnersCsv.filter((row) => row.project === quiz.project && row.taskKey === quiz.taskKey && row.phaseKey === quiz.phaseKey);
        const submitted = attemptsCsv.filter(
          (row) => row.project === quiz.project && row.taskKey === quiz.taskKey && row.phaseKey === quiz.phaseKey && row.status === 'submitted',
        );
        const classRows = classCsv.filter((row) => row.project === quiz.project && row.taskKey === quiz.taskKey);
        expect(quiz.attempts).toBe(submitted.length);
        expect(quiz.attempts).toBe(mine.reduce((sum, row) => sum + Number(row['attempts used']), 0));
        expect(quiz.learnersAttempted).toBe(mine.length);
        expect(quiz.learnersPassed).toBe(mine.filter((row) => row.passed === 'yes').length);
        expect(quiz.questions).toEqual(
          classRows.map((row) => ({
            questionId: row.questionId,
            drawn: Number(row['times drawn']),
            right: Number(row['times right']),
            percentRight: numberOrNull(row['% right']),
          })),
        );
      }
      // The declared zero card is in no file: the CSVs list handed-in papers only.
      expect(classCsv.some((row) => row.taskKey === 'default-deploy-check')).toBe(false);
      expect(summary.quizzes.filter((quiz) => quiz.attempts > 0).map((quiz) => quiz.taskKey)).toEqual(['default-design-check']);
    }
  });
});
