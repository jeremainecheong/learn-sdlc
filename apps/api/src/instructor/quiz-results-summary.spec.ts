import 'reflect-metadata';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  QUIZ_RESULTS_EXPORT_KINDS,
  QUIZ_SCORE_BANDS,
  quizScoreBand,
  type QuizQuestion,
  type QuizResultsExportKind,
  type QuizResultsSummary,
} from '@learnsdlc/shared';
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
import type { InstructorCaller } from './cohort-scope';
import { optionToken } from '../quiz/quiz-attempts.service';
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
 * The class quiz-results summary.
 *
 * Class "Monday 10am", four learners. `design-check` (design phase): A hands in
 * 33.3 then 100; B 0, 33.3, 66.7; C 33.3 and has one paper voided; D holds only
 * an open paper. `deployment-check` (deployment phase) is on the class's
 * assigned version and nobody has sat it. Every paper draws q1, q2, q3; the
 * sheets put q1 right 4 times in 6, q2 and q3 right 2 times in 6.
 *
 * Every paper is written straight into `quiz_attempts` in the shape the quiz
 * service leaves it, as the QX spec does, so this spec proves the reader.
 */

const SLUG = 'quiz-fixture';
/** A uuid-shaped version id, so the class's assignment row can name it. */
const V_QUIZ = '1d0d0d0d-0000-4000-8000-00000000000a';
const DESIGN_QUIZ = 'design-check';
const DEPLOY_QUIZ = 'deployment-check';

const RIGHT = (n: number) => `RDSEALRIGHT${n}`;
const WRONG = (n: number) => `RDSEALWRONG${n}`;

function sealedQuestions(): QuizQuestion[] {
  return [1, 2, 3].map((n) => ({
    id: `q${n}`,
    stem: `RDSEAL STEM ${n}`,
    options: [
      { id: RIGHT(n), text: `RDSEAL OPTION TEXT ${n} right` },
      { id: WRONG(n), text: `RDSEAL OPTION TEXT ${n} wrong` },
    ],
    correct: [RIGHT(n)],
    explanation: `RDSEAL EXPLANATION ${n}`,
    concept: `rdseal-concept-${n}`,
  }));
}

/** Words no byte of the summary JSON may contain. */
const SEAL_WORDS = ['RDSEAL', 'rdseal', '"correct"', 'explanation', 'stem', 'optionIds', 'answers'];
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

/** A file as objects keyed by its own header. */
function records(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((name, at) => [name, row[at]])));
}

/**
 * The byte golden: the four files on this fixture, as fixed captures. The
 * shared builders must produce every byte exactly.
 */
const GOLDEN: Record<'dana' | 'admin', Record<QuizResultsExportKind, string>> = {
  dana: {
    learners: [
      "email,displayName,class,project,phaseKey,taskKey,attempts used,attempts voided,best score,latest score,passed,first submittedAt,last submittedAt",
      "ana@rd.test,Ana,Monday 10am,quiz-fixture,design,design-check,2,0,100,100,yes,2026-09-01T09:05:00.000Z,2026-09-01T10:05:00.000Z",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,3,0,66.7,66.7,yes,2026-09-02T09:05:00.000Z,2026-09-02T11:05:00.000Z",
      "cai@rd.test,Cai,Monday 10am,quiz-fixture,design,design-check,1,1,33.3,33.3,no,2026-09-03T09:05:00.000Z,2026-09-03T09:05:00.000Z",
    ].map((row) => `${row}\r\n`).join(''),
    attempts: [
      "email,displayName,class,project,phaseKey,taskKey,epoch,attempt,status,score,passed,startedAt,submittedAt,packVersion",
      "ana@rd.test,Ana,Monday 10am,quiz-fixture,design,design-check,0,1,submitted,33.3,no,2026-09-01T09:00:00.000Z,2026-09-01T09:05:00.000Z,1.0.0",
      "ana@rd.test,Ana,Monday 10am,quiz-fixture,design,design-check,0,2,submitted,100,yes,2026-09-01T10:00:00.000Z,2026-09-01T10:05:00.000Z,1.0.0",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,0,1,submitted,0,no,2026-09-02T09:00:00.000Z,2026-09-02T09:05:00.000Z,1.0.0",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,0,2,submitted,33.3,no,2026-09-02T10:00:00.000Z,2026-09-02T10:05:00.000Z,1.0.0",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,0,3,submitted,66.7,yes,2026-09-02T11:00:00.000Z,2026-09-02T11:05:00.000Z,1.0.0",
      "cai@rd.test,Cai,Monday 10am,quiz-fixture,design,design-check,0,1,submitted,33.3,no,2026-09-03T09:00:00.000Z,2026-09-03T09:05:00.000Z,1.0.0",
      "cai@rd.test,Cai,Monday 10am,quiz-fixture,design,design-check,0,,voided,,,2026-09-03T10:00:00.000Z,2026-09-03T12:00:00.000Z,1.0.0",
    ].map((row) => `${row}\r\n`).join(''),
    questions: [
      "email,class,project,taskKey,epoch,attempt,position,questionId,outcome",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,1,1,q1,right",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,1,2,q2,wrong",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,1,3,q3,wrong",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,2,1,q1,right",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,2,2,q2,right",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,2,3,q3,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,1,1,q1,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,1,2,q2,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,1,3,q3,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,2,1,q1,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,2,2,q2,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,2,3,q3,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,3,1,q1,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,3,2,q2,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,3,3,q3,wrong",
      "cai@rd.test,Monday 10am,quiz-fixture,design-check,0,1,1,q1,wrong",
      "cai@rd.test,Monday 10am,quiz-fixture,design-check,0,1,2,q2,wrong",
      "cai@rd.test,Monday 10am,quiz-fixture,design-check,0,1,3,q3,right",
    ].map((row) => `${row}\r\n`).join(''),
    class: [
      "class,project,taskKey,questionId,times drawn,times right,% right,learners attempted,learners passed",
      "Monday 10am,quiz-fixture,design-check,q1,6,4,67,3,2",
      "Monday 10am,quiz-fixture,design-check,q2,6,2,33,3,2",
      "Monday 10am,quiz-fixture,design-check,q3,6,2,33,3,2",
    ].map((row) => `${row}\r\n`).join(''),
  },
  admin: {
    learners: [
      "email,displayName,class,project,phaseKey,taskKey,attempts used,attempts voided,best score,latest score,passed,first submittedAt,last submittedAt",
      "ana@rd.test,Ana,Monday 10am,quiz-fixture,design,design-check,2,0,100,100,yes,2026-09-01T09:05:00.000Z,2026-09-01T10:05:00.000Z",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,3,0,66.7,66.7,yes,2026-09-02T09:05:00.000Z,2026-09-02T11:05:00.000Z",
      "cai@rd.test,Cai,Monday 10am,quiz-fixture,design,design-check,1,1,33.3,33.3,no,2026-09-03T09:05:00.000Z,2026-09-03T09:05:00.000Z",
      "eve@rd.test,Eve,Thursday,quiz-fixture,design,design-check,1,0,100,100,yes,2026-09-05T09:05:00.000Z,2026-09-05T09:05:00.000Z",
    ].map((row) => `${row}\r\n`).join(''),
    attempts: [
      "email,displayName,class,project,phaseKey,taskKey,epoch,attempt,status,score,passed,startedAt,submittedAt,packVersion",
      "ana@rd.test,Ana,Monday 10am,quiz-fixture,design,design-check,0,1,submitted,33.3,no,2026-09-01T09:00:00.000Z,2026-09-01T09:05:00.000Z,1.0.0",
      "ana@rd.test,Ana,Monday 10am,quiz-fixture,design,design-check,0,2,submitted,100,yes,2026-09-01T10:00:00.000Z,2026-09-01T10:05:00.000Z,1.0.0",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,0,1,submitted,0,no,2026-09-02T09:00:00.000Z,2026-09-02T09:05:00.000Z,1.0.0",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,0,2,submitted,33.3,no,2026-09-02T10:00:00.000Z,2026-09-02T10:05:00.000Z,1.0.0",
      "ben@rd.test,Ben,Monday 10am,quiz-fixture,design,design-check,0,3,submitted,66.7,yes,2026-09-02T11:00:00.000Z,2026-09-02T11:05:00.000Z,1.0.0",
      "cai@rd.test,Cai,Monday 10am,quiz-fixture,design,design-check,0,1,submitted,33.3,no,2026-09-03T09:00:00.000Z,2026-09-03T09:05:00.000Z,1.0.0",
      "cai@rd.test,Cai,Monday 10am,quiz-fixture,design,design-check,0,,voided,,,2026-09-03T10:00:00.000Z,2026-09-03T12:00:00.000Z,1.0.0",
      "eve@rd.test,Eve,Thursday,quiz-fixture,design,design-check,0,1,submitted,100,yes,2026-09-05T09:00:00.000Z,2026-09-05T09:05:00.000Z,1.0.0",
    ].map((row) => `${row}\r\n`).join(''),
    questions: [
      "email,class,project,taskKey,epoch,attempt,position,questionId,outcome",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,1,1,q1,right",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,1,2,q2,wrong",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,1,3,q3,wrong",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,2,1,q1,right",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,2,2,q2,right",
      "ana@rd.test,Monday 10am,quiz-fixture,design-check,0,2,3,q3,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,1,1,q1,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,1,2,q2,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,1,3,q3,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,2,1,q1,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,2,2,q2,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,2,3,q3,wrong",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,3,1,q1,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,3,2,q2,right",
      "ben@rd.test,Monday 10am,quiz-fixture,design-check,0,3,3,q3,wrong",
      "cai@rd.test,Monday 10am,quiz-fixture,design-check,0,1,1,q1,wrong",
      "cai@rd.test,Monday 10am,quiz-fixture,design-check,0,1,2,q2,wrong",
      "cai@rd.test,Monday 10am,quiz-fixture,design-check,0,1,3,q3,right",
      "eve@rd.test,Thursday,quiz-fixture,design-check,0,1,1,q1,right",
      "eve@rd.test,Thursday,quiz-fixture,design-check,0,1,2,q2,right",
      "eve@rd.test,Thursday,quiz-fixture,design-check,0,1,3,q3,right",
    ].map((row) => `${row}\r\n`).join(''),
    class: [
      "class,project,taskKey,questionId,times drawn,times right,% right,learners attempted,learners passed",
      "Monday 10am,quiz-fixture,design-check,q1,6,4,67,3,2",
      "Monday 10am,quiz-fixture,design-check,q2,6,2,33,3,2",
      "Monday 10am,quiz-fixture,design-check,q3,6,2,33,3,2",
      "Thursday,quiz-fixture,design-check,q1,1,1,100,1,1",
      "Thursday,quiz-fixture,design-check,q2,1,1,100,1,1",
      "Thursday,quiz-fixture,design-check,q3,1,1,100,1,1",
    ].map((row) => `${row}\r\n`).join(''),
  },
};

const numberOrNull = (cell: string): number | null => (cell === '' ? null : Number(cell));

describe('quiz-results summary', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: QuizResultsExportService;

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let admin: InstructorCaller;
  let monday = '';
  let thursday = '';
  let papers: QuizAttemptEntity[] = [];

  const manager = () => dataSource.manager;
  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  /** A learner pinned to the quiz version, with both phase rows. */
  async function enrol(userId: string): Promise<{ design: PhaseStateEntity; deployment: PhaseStateEntity }> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug: SLUG, projectVersionId: V_QUIZ, currentPhaseOrder: 1 }),
    );
    const design = await manager().save(
      manager().create(PhaseStateEntity, { enrollmentId: enrollment.id, userId, phaseKey: 'design', phaseOrder: 1, status: 'in_progress' }),
    );
    const deployment = await manager().save(
      manager().create(PhaseStateEntity, { enrollmentId: enrollment.id, userId, phaseKey: 'deployment', phaseOrder: 2, status: 'in_progress' }),
    );
    return { design, deployment };
  }

  /**
   * One paper drawing q1, q2, q3. `right` names the questions the sheet
   * answers rightly; `score` and `passed` are what the grading job stored.
   */
  async function paper(
    state: PhaseStateEntity,
    over: {
      right?: number[];
      score?: number | null;
      passed?: boolean | null;
      startedAt: string;
      submittedAt: string | null;
      voided?: boolean;
    },
  ): Promise<QuizAttemptEntity> {
    const drawn = [1, 2, 3];
    const right = new Set(over.right ?? []);
    const handedIn = over.submittedAt !== null && !over.voided;
    const sheet: Record<string, string[]> = {};
    for (const n of drawn) sheet[`q${n}`] = [right.has(n) ? RIGHT(n) : WRONG(n)];
    return manager().save(
      manager().create(QuizAttemptEntity, {
        phaseStateId: state.id,
        userId: state.userId,
        taskKey: DESIGN_QUIZ,
        epoch: 0,
        voidedAt: over.voided ? over.submittedAt : null,
        projectVersionId: V_QUIZ,
        packVersion: '1.0.0',
        submissionId: null,
        paper: drawn.map((n, at) => ({ questionId: `q${n}`, optionIds: at % 2 ? [RIGHT(n), WRONG(n)] : [WRONG(n), RIGHT(n)] })),
        answers: handedIn ? sheet : null,
        score: handedIn ? (over.score ?? null) : null,
        passed: handedIn ? (over.passed ?? null) : null,
        startedAt: over.startedAt,
        submittedAt: over.submittedAt,
      }),
    );
  }

  const allFiles = async (caller: InstructorCaller, read = {}) =>
    Object.fromEntries(
      await Promise.all(QUIZ_RESULTS_EXPORT_KINDS.map(async (kind) => [kind, await service.export(caller, kind, read)])),
    ) as Record<QuizResultsExportKind, string>;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const written = writtenPhase();
    const executable = executablePhase(false);
    const checks = fixtureQuizChecks({ questions: sealedQuestions(), drawn: 3 });
    const snapshot = compilePack(fixturePack([written, executable]), {
      authored: {
        design: [soleGradedTask(written), fixtureQuizTask(DESIGN_QUIZ, 2, { title: 'Check the design' }, checks)],
        deployment: [soleGradedTask(executable), fixtureQuizTask(DEPLOY_QUIZ, 2, { title: 'Check the deployment' }, checks)],
      },
    });
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      { versionId: V_QUIZ, content: snapshot.content, compiler: snapshot.compiler, phases: snapshot.phases },
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
    const danaRow = await saveUser({ email: 'dana@rd.test', role: 'INSTRUCTOR', displayName: 'Dana' });
    const samRow = await saveUser({ email: 'sam@rd.test', role: 'INSTRUCTOR', displayName: 'Sam' });
    const adminRow = await saveUser({ email: 'ops@rd.test', role: 'ADMIN', displayName: 'Ops' });
    monday = (await manager().save(manager().create(CohortEntity, { name: 'Monday 10am', joinCode: 'RDMON001', ownerUserId: danaRow.id }))).id;
    thursday = (await manager().save(manager().create(CohortEntity, { name: 'Thursday', joinCode: 'RDTHU001', ownerUserId: samRow.id }))).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: monday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };
    admin = { id: adminRow.id, role: 'ADMIN', cohort: 'default' };

    // The class's assigned version: the catalogue rows the assignment names.
    const project = await manager().save(
      manager().create(ProjectEntity, { slug: SLUG, title: 'the quiz fixture project', origin: 'fork', ownerUserId: danaRow.id }),
    );
    await manager().save(
      manager().create(ProjectVersionEntity, {
        id: V_QUIZ,
        projectId: project.id,
        version: '1.0.0',
        status: 'published',
        manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] },
      }),
    );
    await manager().save(
      manager().create(CohortProjectAssignmentEntity, {
        cohortId: monday,
        projectVersionId: V_QUIZ,
        assignedByUserId: danaRow.id,
        state: 'active',
        reason: 'This class takes the concept checks.',
      }),
    );

    const ana = (await saveUser({ email: 'ana@rd.test', displayName: 'Ana', cohort: monday })).id;
    const ben = (await saveUser({ email: 'ben@rd.test', displayName: 'Ben', cohort: monday })).id;
    const cai = (await saveUser({ email: 'cai@rd.test', displayName: 'Cai', cohort: monday })).id;
    const dev = (await saveUser({ email: 'dev@rd.test', displayName: 'Dev', cohort: monday })).id;
    const eve = (await saveUser({ email: 'eve@rd.test', displayName: 'Eve', cohort: thursday })).id;
    const A = await enrol(ana);
    const B = await enrol(ben);
    const C = await enrol(cai);
    const D = await enrol(dev);
    const E = await enrol(eve);
    papers = [
      await paper(A.design, { right: [1], score: 33.3, passed: false, startedAt: '2026-09-01T09:00:00.000Z', submittedAt: '2026-09-01T09:05:00.000Z' }),
      await paper(A.design, { right: [1, 2, 3], score: 100, passed: true, startedAt: '2026-09-01T10:00:00.000Z', submittedAt: '2026-09-01T10:05:00.000Z' }),
      await paper(B.design, { right: [], score: 0, passed: false, startedAt: '2026-09-02T09:00:00.000Z', submittedAt: '2026-09-02T09:05:00.000Z' }),
      await paper(B.design, { right: [1], score: 33.3, passed: false, startedAt: '2026-09-02T10:00:00.000Z', submittedAt: '2026-09-02T10:05:00.000Z' }),
      await paper(B.design, { right: [1, 2], score: 66.7, passed: true, startedAt: '2026-09-02T11:00:00.000Z', submittedAt: '2026-09-02T11:05:00.000Z' }),
      await paper(C.design, { right: [3], score: 33.3, passed: false, startedAt: '2026-09-03T09:00:00.000Z', submittedAt: '2026-09-03T09:05:00.000Z' }),
      await paper(C.design, { right: [1, 2, 3], startedAt: '2026-09-03T10:00:00.000Z', submittedAt: '2026-09-03T12:00:00.000Z', voided: true }),
      await paper(D.design, { right: [1, 2, 3], startedAt: '2026-09-04T09:00:00.000Z', submittedAt: null }),
      // Eve is Sam's (Thursday): never in Monday's summary.
      await paper(E.design, { right: [1, 2, 3], score: 100, passed: true, startedAt: '2026-09-05T09:00:00.000Z', submittedAt: '2026-09-05T09:05:00.000Z' }),
    ];
  });

  /* ------------------- the four files, byte for byte ------------------- */

  it('the four CSVs on the §4.4 fixture are the step-1 golden, byte for byte', async () => {
    expect(await allFiles(dana)).toEqual(GOLDEN.dana);
    expect(await allFiles(dana, { cohort: monday })).toEqual(GOLDEN.dana);
    expect(await allFiles(admin)).toEqual(GOLDEN.admin);
    expect(papers).toHaveLength(9);
  });

  /* ----------------------- summary(), the numbers ---------------------- */

  const bands = (counts: Record<string, number>) =>
    QUIZ_SCORE_BANDS.map((band) => ({ band: band.key, learners: counts[band.key] ?? 0 }));
  const oneDecimal = (value: number) => Math.round(value * 10) / 10;

  it('summary() of Monday 10am holds the §4.4 numbers', async () => {
    const summary = await service.summary(dana, { cohort: monday });
    expect(summary.cohortId).toBe(monday);
    expect(summary.className).toBe('Monday 10am');
    expect(summary.learnersInClass).toBe(4);
    const design = summary.quizzes.find((quiz) => quiz.taskKey === DESIGN_QUIZ)!;
    expect(design).toEqual({
      project: SLUG,
      phaseKey: 'design',
      taskKey: DESIGN_QUIZ,
      title: 'Check the design',
      declared: true,
      attempts: 6,
      learnersAttempted: 3,
      learnersPassed: 2,
      learnersNotYetPassed: 1,
      passRate: 67,
      meanBestScore: 66.7,
      medianBestScore: 66.7,
      bestScoreBands: bands({ '20-39': 1, '60-79': 1, '80-100': 1 }),
      questions: [
        { questionId: 'q1', drawn: 6, right: 4, percentRight: 67 },
        { questionId: 'q2', drawn: 6, right: 2, percentRight: 33 },
        { questionId: 'q3', drawn: 6, right: 2, percentRight: 33 },
      ],
    });
    expect(summary.learners).toEqual([
      { email: 'ana@rd.test', displayName: 'Ana', project: SLUG, phaseKey: 'design', taskKey: DESIGN_QUIZ, attemptsUsed: 2, attemptsVoided: 0, bestScore: 100, latestScore: 100, passed: true },
      { email: 'ben@rd.test', displayName: 'Ben', project: SLUG, phaseKey: 'design', taskKey: DESIGN_QUIZ, attemptsUsed: 3, attemptsVoided: 0, bestScore: 66.7, latestScore: 66.7, passed: true },
      { email: 'cai@rd.test', displayName: 'Cai', project: SLUG, phaseKey: 'design', taskKey: DESIGN_QUIZ, attemptsUsed: 1, attemptsVoided: 1, bestScore: 33.3, latestScore: 33.3, passed: false },
    ]);
    // Dev holds only an open paper, Eve is another teacher's: neither is a row.
    expect(JSON.stringify(summary)).not.toContain('dev@rd.test');
    expect(JSON.stringify(summary)).not.toContain('eve@rd.test');
  });

  it('every summary number equals the value parsed from the matching CSV (same code path)', async () => {
    for (const [caller, read] of [
      [dana, { cohort: monday }],
      [admin, { cohort: monday }],
      [admin, { cohort: thursday }],
      [dana, { cohort: monday, project: SLUG }],
    ] as const) {
      const summary = await service.summary(caller, read);
      const files = await allFiles(caller, read);
      const learnersCsv = records(files.learners);
      const attemptsCsv = records(files.attempts);
      const classCsv = records(files.class);

      // learners[] is quiz-learners.csv, row for row, value for value.
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

      const sat = summary.quizzes.filter((quiz) => quiz.attempts > 0);
      expect(sat.length).toBeGreaterThan(0);
      for (const quiz of summary.quizzes) {
        const mine = learnersCsv.filter((row) => row.project === quiz.project && row.taskKey === quiz.taskKey && row.phaseKey === quiz.phaseKey);
        const submitted = attemptsCsv.filter(
          (row) => row.project === quiz.project && row.taskKey === quiz.taskKey && row.phaseKey === quiz.phaseKey && row.status === 'submitted',
        );
        const classRows = classCsv.filter((row) => row.project === quiz.project && row.taskKey === quiz.taskKey);
        // attempts = Σ attempts used = the submitted rows of the attempts file.
        expect(quiz.attempts).toBe(mine.reduce((sum, row) => sum + Number(row['attempts used']), 0));
        expect(quiz.attempts).toBe(submitted.length);
        // attempted / passed = the class file's columns (every row of the task says the same).
        expect(quiz.learnersAttempted).toBe(mine.length);
        expect(quiz.learnersPassed).toBe(mine.filter((row) => row.passed === 'yes').length);
        for (const row of classRows) {
          expect(Number(row['learners attempted'])).toBe(quiz.learnersAttempted);
          expect(Number(row['learners passed'])).toBe(quiz.learnersPassed);
        }
        expect(quiz.learnersNotYetPassed).toBe(quiz.learnersAttempted - quiz.learnersPassed);
        expect(quiz.passRate).toBe(quiz.learnersAttempted ? Math.round((100 * quiz.learnersPassed) / quiz.learnersAttempted) : null);
        // questions = the class file's rows for the task.
        expect(quiz.questions).toEqual(
          classRows.map((row) => ({
            questionId: row.questionId,
            drawn: Number(row['times drawn']),
            right: Number(row['times right']),
            percentRight: numberOrNull(row['% right']),
          })),
        );
        // mean / median / bands over learners.csv's best score, blanks skipped.
        const best = mine.map((row) => numberOrNull(row['best score'])).filter((score): score is number => score !== null);
        const sorted = [...best].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        expect(quiz.meanBestScore).toBe(best.length ? oneDecimal(best.reduce((a, b) => a + b, 0) / best.length) : null);
        expect(quiz.medianBestScore).toBe(
          sorted.length ? oneDecimal(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
        );
        const counts: Record<string, number> = {};
        for (const score of best) counts[quizScoreBand(score)] = (counts[quizScoreBand(score)] ?? 0) + 1;
        expect(quiz.bestScoreBands).toEqual(bands(counts));
      }
      // The quizzes come in quiz-class.csv's order.
      const order = [...new Set(classCsv.map((row) => `${row.project}|${row.taskKey}`))];
      expect(sat.map((quiz) => `${quiz.project}|${quiz.taskKey}`).filter((key) => order.includes(key))).toEqual(order);
    }
  });

  it('carries no stem, option, key, explanation, token or uuid but the class id', async () => {
    for (const caller of [dana, admin]) {
      const summary = await service.summary(caller, { cohort: monday });
      const { cohortId, ...rest } = summary;
      expect(cohortId).toBe(monday);
      const text = JSON.stringify(rest);
      for (const word of SEAL_WORDS) expect(text).not.toContain(word);
      expect(text).not.toMatch(UUID_ANYWHERE);
      for (const row of papers) {
        expect(text).not.toContain(row.id);
        for (const drawn of row.paper)
          for (const option of drawn.optionIds) {
            expect(text).not.toContain(option);
            expect(text).not.toContain(optionToken(row.id, drawn.questionId, option));
          }
      }
    }
  });

  it("another teacher's class is a 404 before any learner is read; blank is a 400; an unknown project a 404", async () => {
    const find = jest.spyOn(dataSource.manager, 'find');
    await expect(service.summary(sam, { cohort: monday })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.summary(dana, { cohort: thursday })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.summary(dana, { cohort: 'not-a-class' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.summary(admin, { cohort: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(NotFoundException);
    expect(find.mock.calls.some(([entity]) => entity === UserEntity || entity === QuizAttemptEntity)).toBe(false);
    await expect(service.summary(dana, { cohort: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.summary(dana, { cohort: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.summary(dana, { cohort: undefined as unknown as string })).rejects.toBeInstanceOf(BadRequestException);
    expect(find.mock.calls.some(([entity]) => entity === UserEntity || entity === QuizAttemptEntity)).toBe(false);
    await expect(service.summary(dana, { cohort: monday, project: 'no-such-project' })).rejects.toBeInstanceOf(NotFoundException);
    // ADMIN reads any class, with the owner's numbers.
    expect(await service.summary(admin, { cohort: monday })).toEqual(await service.summary(dana, { cohort: monday }));
    const theirs = await service.summary(admin, { cohort: thursday });
    expect(theirs.learners.map((row) => row.email)).toEqual(['eve@rd.test']);
    expect(theirs.className).toBe('Thursday');
  });

  it('writes nothing: every table holds the same rows after the summary', async () => {
    const counts = async () => Promise.all(ALL_ENTITIES.map((entity) => manager().count(entity as never)));
    const before = await counts();
    const snapshot = await manager().find(QuizAttemptEntity, { order: { id: 'ASC' } });
    await service.summary(dana, { cohort: monday });
    await service.summary(admin, { cohort: thursday });
    await service.summary(admin, { cohort: 'default' });
    expect(await counts()).toEqual(before);
    expect(await manager().find(QuizAttemptEntity, { order: { id: 'ASC' } })).toEqual(snapshot);
  });

  /* ------------------ declared quiz tasks ------------------ */

  it("a quiz on the class's assigned version that nobody has sat is declared, with zeros", async () => {
    const summary = await service.summary(dana, { cohort: monday });
    expect(summary.quizzes.map((quiz) => [quiz.phaseKey, quiz.taskKey, quiz.declared])).toEqual([
      ['design', DESIGN_QUIZ, true],
      ['deployment', DEPLOY_QUIZ, true],
    ]);
    expect(summary.quizzes[1]).toEqual({
      project: SLUG,
      phaseKey: 'deployment',
      taskKey: DEPLOY_QUIZ,
      title: 'Check the deployment',
      declared: true,
      attempts: 0,
      learnersAttempted: 0,
      learnersPassed: 0,
      learnersNotYetPassed: 0,
      passRate: null,
      meanBestScore: null,
      medianBestScore: null,
      bestScoreBands: bands({}),
      questions: [],
    });
    // The assigned project named as the filter: the same quizzes.
    expect(await service.summary(dana, { cohort: monday, project: SLUG })).toEqual(summary);
    // An assignment whose version the catalogue cannot resolve declares nothing: papers only.
    await manager().update(ProjectEntity, { slug: SLUG }, { slug: 'renamed-elsewhere' });
    const unresolved = await service.summary(dana, { cohort: monday });
    expect(unresolved.quizzes.map((quiz) => [quiz.taskKey, quiz.declared, quiz.title])).toEqual([[DESIGN_QUIZ, false, 'Check the design']]);
  });

  it('a class with no assigned version, and a task only papers name, are declared false', async () => {
    // Thursday has no assignment: its one quiz comes from Eve's paper.
    const thursdays = await service.summary(admin, { cohort: thursday });
    expect(thursdays.quizzes.map((quiz) => [quiz.taskKey, quiz.declared, quiz.title, quiz.attempts])).toEqual([
      [DESIGN_QUIZ, false, 'Check the design', 1],
    ]);
    // A paper on a task the version does not declare: listed, not declared, untitled, no question rows.
    const ana = await manager().findOneByOrFail(UserEntity, { email: 'ana@rd.test' });
    const design = await manager().findOneByOrFail(PhaseStateEntity, { userId: ana.id, phaseKey: 'design' });
    await manager().save(
      manager().create(QuizAttemptEntity, {
        ...papers[0],
        id: undefined,
        phaseStateId: design.id,
        taskKey: 'retired-check',
        startedAt: '2026-09-06T09:00:00.000Z',
        submittedAt: '2026-09-06T09:05:00.000Z',
      }),
    );
    const summary = await service.summary(dana, { cohort: monday });
    expect(summary.quizzes.map((quiz) => [quiz.taskKey, quiz.declared, quiz.title, quiz.attempts, quiz.questions.length])).toEqual([
      [DESIGN_QUIZ, true, 'Check the design', 6, 3],
      ['retired-check', false, null, 1, 0],
      [DEPLOY_QUIZ, true, 'Check the deployment', 0, 0],
    ]);
  });

  it('a stored score that is not a finite number is a blank, not a 500 (closer, review minor)', async () => {
    // Grading does not store NaN; if a row ever held one, the CSV prints it
    // and the summary must still answer: the learner is not banded, not in the
    // mean, and their best score reads as a blank (null).
    const original = (service as any).read.bind(service);
    jest.spyOn(service as any, 'read').mockImplementation(async (...args: unknown[]) => {
      const out = await original(...args);
      for (const one of out.papers) if (one.row.score === 66.7) one.row.score = Number.NaN;
      return out;
    });
    const summary = await service.summary(dana, { cohort: monday });
    const design = summary.quizzes.find((quiz) => quiz.taskKey === DESIGN_QUIZ)!;
    expect(design.bestScoreBands.reduce((sum, band) => sum + band.learners, 0)).toBe(2);
    expect(design.meanBestScore).toBe(oneDecimal((100 + 33.3) / 2));
    expect(design.medianBestScore).toBe(oneDecimal((100 + 33.3) / 2));
    const ben = summary.learners.find((row) => row.email === 'ben@rd.test')!;
    expect(ben.bestScore).toBeNull();
    expect(ben.latestScore).toBeNull();
    expect(ben.attemptsUsed).toBe(3);
  });

  it('an admin reading the unattached learners gets a nameless summary', async () => {
    const summary: QuizResultsSummary = await service.summary(admin, { cohort: 'default' });
    expect(summary).toEqual({ cohortId: 'default', className: null, learnersInClass: 0, quizzes: [], learners: [] });
  });
});
