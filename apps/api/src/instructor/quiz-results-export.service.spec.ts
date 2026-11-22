import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QUIZ_RESULTS_EXPORT_KINDS, type QuizQuestion, type QuizResultsExportKind } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { compilePack } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  UserEntity,
} from '../db/entities';
import { optionToken, QuizAttemptsService } from '../quiz/quiz-attempts.service';
import type { InstructorCaller } from './cohort-scope';
import {
  QUIZ_ATTEMPTS_COLUMNS,
  QUIZ_CLASS_COLUMNS,
  QUIZ_LEARNERS_COLUMNS,
  QUIZ_QUESTIONS_COLUMNS,
  QuizResultsExportService,
} from './quiz-results-export.service';
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
 * The four read-only quiz-results CSVs.
 *
 * Every paper here is written straight into `quiz_attempts`, in the shape the
 * quiz service leaves it (the sheet in the teacher's ids, the stored score and
 * pass the grading job wrote back), so what this spec proves is the reader:
 * what the four files say about a set of rows, and what they never say.
 *
 * The questions are SENTINELS rather than the fixture's own: every stem,
 * option text, option id, explanation and concept carries a word no cell may
 * ever contain, so the seal is a substring test over each whole file.
 */

const SLUG = 'quiz-fixture';
const V_QUIZ = 'v-qx-quiz';
const DESIGN_QUIZ = 'design-check';
const DEPLOY_QUIZ = 'deployment-check';
const HYPERLINK = '=HYPERLINK("http://example.test","click")';

const RIGHT = (n: number) => `SENTINELRIGHT${n}`;
const WRONG = (n: number) => `SENTINELWRONG${n}`;

function sentinelQuestions(): QuizQuestion[] {
  return [1, 2, 3, 4, 5].map((n) => ({
    id: `q${n}`,
    stem: `SENTINEL STEM ${n}`,
    options: [
      { id: RIGHT(n), text: `SENTINEL OPTION TEXT ${n} right` },
      { id: WRONG(n), text: `SENTINEL OPTION TEXT ${n} wrong` },
    ],
    correct: [RIGHT(n)],
    explanation: `SENTINEL EXPLANATION ${n}`,
    concept: `sentinel-concept-${n}`,
  }));
}

/** Words no cell of any file may contain. */
const SENTINEL_WORDS = ['SENTINEL', 'sentinel', '"correct"', 'explanation'];
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

describe('QuizResultsExportService (QX, CUT-9)', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: QuizResultsExportService;
  let attemptsService: QuizAttemptsService;

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let admin: InstructorCaller;
  let tuesday = '';
  let thursday = '';

  const manager = () => dataSource.manager;
  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  /** A learner pinned to the quiz version, with both phase rows. */
  async function enrol(userId: string): Promise<{ design: PhaseStateEntity; deployment: PhaseStateEntity }> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId, projectSlug: SLUG, projectVersionId: V_QUIZ, currentPhaseOrder: 1 }),
    );
    const design = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId,
        phaseKey: 'design',
        phaseOrder: 1,
        status: 'in_progress',
      }),
    );
    const deployment = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId,
        phaseKey: 'deployment',
        phaseOrder: 2,
        status: 'in_progress',
      }),
    );
    return { design, deployment };
  }

  /**
   * One paper. `right` names how many of its three drawn questions the sheet
   * answers rightly; the stored score is the grader's own rounding of that.
   */
  async function paper(
    state: PhaseStateEntity,
    taskKey: string,
    over: {
      epoch?: number;
      questions?: number[];
      right?: number;
      startedAt: string;
      submittedAt: string | null;
      voided?: boolean;
      graded?: boolean;
      passed?: boolean;
    },
  ): Promise<QuizAttemptEntity> {
    const drawn = over.questions ?? [1, 2, 3];
    const right = over.right ?? 0;
    const sheet: Record<string, string[]> = {};
    drawn.forEach((n, at) => {
      sheet[`q${n}`] = [at < right ? RIGHT(n) : WRONG(n)];
    });
    const handedIn = over.submittedAt !== null && !over.voided;
    const graded = handedIn && over.graded !== false;
    const score = graded ? Math.round((100 * right) / drawn.length) : null;
    return manager().save(
      manager().create(QuizAttemptEntity, {
        phaseStateId: state.id,
        userId: state.userId,
        taskKey,
        epoch: over.epoch ?? 0,
        voidedAt: over.voided ? over.submittedAt : null,
        projectVersionId: V_QUIZ,
        packVersion: '1.0.0',
        submissionId: null,
        // The order the learner saw the options in: the wrong one first on
        // every other question, so a position is not a key either.
        paper: drawn.map((n, at) => ({
          questionId: `q${n}`,
          optionIds: at % 2 ? [RIGHT(n), WRONG(n)] : [WRONG(n), RIGHT(n)],
        })),
        answers: handedIn ? sheet : null,
        score,
        passed: graded ? (over.passed ?? score! >= 70) : null,
        startedAt: over.startedAt,
        submittedAt: over.submittedAt,
      }),
    );
  }

  const exportOf = (caller: InstructorCaller, kind: QuizResultsExportKind, read = {}) =>
    service.export(caller, kind, read);
  const allFiles = async (caller: InstructorCaller, read = {}) =>
    Object.fromEntries(
      await Promise.all(QUIZ_RESULTS_EXPORT_KINDS.map(async (kind) => [kind, await exportOf(caller, kind, read)])),
    ) as Record<QuizResultsExportKind, string>;

  let lee = '';
  let kai = '';
  let ola = '';
  let ben = '';
  let papers: QuizAttemptEntity[] = [];

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const written = writtenPhase();
    const executable = executablePhase(false);
    const checks = fixtureQuizChecks({ questions: sentinelQuestions(), drawn: 3 });
    const snapshot = compilePack(fixturePack([written, executable]), {
      authored: {
        design: [soleGradedTask(written), fixtureQuizTask(DESIGN_QUIZ, 2, {}, checks)],
        deployment: [soleGradedTask(executable), fixtureQuizTask(DEPLOY_QUIZ, 2, {}, checks)],
      },
    });
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      { versionId: V_QUIZ, content: snapshot.content, compiler: snapshot.compiler, phases: snapshot.phases },
    ]);
    service = new QuizResultsExportService(dataSource, content);
    attemptsService = new QuizAttemptsService(dataSource.getRepository(QuizAttemptEntity));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const danaRow = await saveUser({ email: 'dana@qx.test', role: 'INSTRUCTOR', displayName: 'Dana' });
    const samRow = await saveUser({ email: 'sam@qx.test', role: 'INSTRUCTOR', displayName: 'Sam' });
    const adminRow = await saveUser({ email: 'ops@qx.test', role: 'ADMIN', displayName: 'Ops' });
    tuesday = (await manager().save(manager().create(CohortEntity, { name: 'Tuesday', joinCode: 'QXTUES01', ownerUserId: danaRow.id }))).id;
    thursday = (await manager().save(manager().create(CohortEntity, { name: 'Thursday', joinCode: 'QXTHUR01', ownerUserId: samRow.id }))).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };
    admin = { id: adminRow.id, role: 'ADMIN', cohort: 'default' };
    lee = (await saveUser({ email: 'lee@qx.test', displayName: 'Lee', cohort: tuesday })).id;
    kai = (await saveUser({ email: 'kai@qx.test', displayName: HYPERLINK, cohort: tuesday })).id;
    ola = (await saveUser({ email: 'ola@qx.test', displayName: 'Ola', cohort: tuesday })).id;
    ben = (await saveUser({ email: 'ben@qx.test', displayName: 'Ben', cohort: thursday })).id;

    const leeBoard = await enrol(lee);
    const kaiBoard = await enrol(kai);
    const olaBoard = await enrol(ola);
    const benBoard = await enrol(ben);
    papers = [
      // Lee, epoch 0: two handed in, then a paper the teacher's reset voided.
      await paper(leeBoard.design, DESIGN_QUIZ, { right: 2, startedAt: '2026-09-01T09:00:00.000Z', submittedAt: '2026-09-01T09:05:00.000Z' }),
      await paper(leeBoard.design, DESIGN_QUIZ, { questions: [2, 4, 5], right: 3, startedAt: '2026-09-01T10:00:00.000Z', submittedAt: '2026-09-01T10:05:00.000Z' }),
      await paper(leeBoard.design, DESIGN_QUIZ, { questions: [1, 3, 5], startedAt: '2026-09-02T09:00:00.000Z', submittedAt: '2026-09-02T12:00:00.000Z', voided: true }),
      // Lee, epoch 1 (after the reset): one handed in, one still open.
      await paper(leeBoard.design, DESIGN_QUIZ, { epoch: 1, questions: [1, 4, 5], right: 1, startedAt: '2026-09-03T09:00:00.000Z', submittedAt: '2026-09-03T09:05:00.000Z' }),
      await paper(leeBoard.design, DESIGN_QUIZ, { epoch: 1, questions: [2, 3, 4], startedAt: '2026-09-03T10:00:00.000Z', submittedAt: null }),
      // Kai: a full mark on the design quiz, nothing on the deployment one, and
      // a third paper handed in whose verdict has not landed yet.
      await paper(kaiBoard.design, DESIGN_QUIZ, { questions: [3, 4, 5], right: 3, startedAt: '2026-09-01T11:00:00.000Z', submittedAt: '2026-09-01T11:04:00.000Z' }),
      await paper(kaiBoard.deployment, DEPLOY_QUIZ, { right: 0, startedAt: '2026-09-04T11:00:00.000Z', submittedAt: '2026-09-04T11:04:00.000Z' }),
      await paper(kaiBoard.deployment, DEPLOY_QUIZ, { right: 2, startedAt: '2026-09-05T11:00:00.000Z', submittedAt: '2026-09-05T11:04:00.000Z', graded: false }),
      // Ola: only an open paper.
      await paper(olaBoard.design, DESIGN_QUIZ, { right: 3, startedAt: '2026-09-01T12:00:00.000Z', submittedAt: null }),
      // Ben is Sam's (Thursday): never in Dana's files.
      await paper(benBoard.design, DESIGN_QUIZ, { right: 3, startedAt: '2026-09-01T13:00:00.000Z', submittedAt: '2026-09-01T13:04:00.000Z' }),
    ];
  });

  /* ------------------------------- red first ------------------------------ */

  it('an open paper contributes no row to any of the four files', async () => {
    const files = await allFiles(dana);
    // Ola's only paper is open: she is in no file at all.
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) expect(files[kind]).not.toContain('ola@qx.test');
    // Lee's open epoch-1 paper is not a row of the attempts file, and its
    // questions (q2, q3, q4 at epoch 1) are not rows of the questions file.
    const attempts = records(files.attempts).filter((row) => row.email === 'lee@qx.test');
    expect(attempts).toHaveLength(4);
    expect(attempts.every((row) => row.submittedAt !== '')).toBe(true);
    const epochOne = records(files.questions).filter((row) => row.email === 'lee@qx.test' && row.epoch === '1');
    expect(epochOne.map((row) => row.questionId)).toEqual(['q1', 'q4', 'q5']);
    // And the class file counts no draw an open paper made: q2 is on Lee's
    // first two papers, and on Lee's and Ola's open ones, which do not count.
    const classRows = records(files.class).filter((row) => row.taskKey === DESIGN_QUIZ);
    expect(classRows.find((row) => row.questionId === 'q2')?.['times drawn']).toBe('2');
    // Ola attempted nothing that counts.
    expect(classRows.every((row) => row['learners attempted'] === '2')).toBe(true);
  });

  it('no cell of any file contains a correct option id, an explanation, a stem or an option token', async () => {
    for (const caller of [dana, admin]) {
      const files = await allFiles(caller);
      for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
        const text = files[kind];
        for (const word of SENTINEL_WORDS) expect(text).not.toContain(word);
        // No uuid: not a user's, not a paper's, not a version's, not a class's.
        expect(text).not.toMatch(UUID_ANYWHERE);
        for (const row of papers) {
          expect(text).not.toContain(row.id);
          for (const drawn of row.paper)
            for (const option of drawn.optionIds) expect(text).not.toContain(optionToken(row.id, drawn.questionId, option));
        }
      }
    }
  });

  it('attempt equals QuizAttemptsService.attemptNumberOf for every row, across a reset epoch', async () => {
    const files = await allFiles(admin);
    const byStamp = new Map(papers.filter((row) => row.submittedAt).map((row) => [`${row.userId}|${row.submittedAt}`, row]));
    const emails = new Map([[lee, 'lee@qx.test'], [kai, 'kai@qx.test'], [ben, 'ben@qx.test']]);
    const userOf = (email: string) => [...emails].find(([, one]) => one === email)![0];
    let checked = 0;
    for (const row of records(files.attempts)) {
      const entity = byStamp.get(`${userOf(row.email)}|${row.submittedAt}`)!;
      expect(entity).toBeDefined();
      if (row.status === 'voided') {
        expect(row.attempt).toBe('');
        continue;
      }
      expect(Number(row.attempt)).toBe(await attemptsService.attemptNumberOf(entity));
      expect(Number(row.epoch)).toBe(entity.epoch);
      checked++;
    }
    // Lee 3, Kai 3, Ben 1.
    expect(checked).toBe(7);
    // Lee's epoch 1 starts again at 1: the reset is a new run.
    const lee1 = records(files.attempts).filter((row) => row.email === 'lee@qx.test' && row.status === 'submitted');
    expect(lee1.map((row) => [row.epoch, row.attempt])).toEqual([
      ['0', '1'],
      ['0', '2'],
      ['1', '1'],
    ]);
    // The questions file numbers its rows the same way.
    for (const row of records(files.questions)) {
      const match = records(files.attempts).find(
        (one) => one.email === row.email && one.taskKey === row.taskKey && one.epoch === row.epoch && one.attempt === row.attempt,
      );
      expect(match?.status).toBe('submitted');
    }
  });

  it('a voided paper is listed as voided and never scored', async () => {
    // Even a voided row carrying a score and a pass (which no writer leaves)
    // is read as unscored: the file never trusts a number on a paper nobody sat.
    const voidedRow = papers.find((row) => row.voidedAt)!;
    await manager().update(QuizAttemptEntity, { id: voidedRow.id }, { score: 100, passed: true });
    const files = await allFiles(dana);
    const voided = records(files.attempts).filter((row) => row.status === 'voided');
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({ email: 'lee@qx.test', epoch: '0', attempt: '', score: '', passed: '' });
    // Its three draws (q1, q3, q5 at epoch 0 after the first two papers) are in
    // no questions row: Lee's epoch-0 rows are the first two papers' six.
    const lee0 = records(files.questions).filter((row) => row.email === 'lee@qx.test' && row.epoch === '0');
    expect(lee0).toHaveLength(6);
    // And the learner row counts it as voided, not as used.
    const learner = records(files.learners).find((row) => row.email === 'lee@qx.test' && row.taskKey === DESIGN_QUIZ)!;
    expect(learner['attempts used']).toBe('3');
    expect(learner['attempts voided']).toBe('1');
  });

  it('per-question rights over drawn × 100 equals the stored score for every paper', async () => {
    const files = await allFiles(admin);
    const questions = records(files.questions);
    let scored = 0;
    for (const row of records(files.attempts)) {
      if (row.status !== 'submitted') continue;
      const mine = questions.filter(
        (one) => one.email === row.email && one.taskKey === row.taskKey && one.epoch === row.epoch && one.attempt === row.attempt,
      );
      expect(mine.map((one) => one.position)).toEqual(['1', '2', '3']);
      if (row.score === '') continue;
      const rights = mine.filter((one) => one.outcome === 'right').length;
      expect(Math.round((100 * rights) / mine.length)).toBe(Number(row.score));
      scored++;
    }
    // Every handed-in paper but Kai's ungraded one.
    expect(scored).toBe(6);
    expect(questions.every((one) => one.outcome === 'right' || one.outcome === 'wrong')).toBe(true);
  });

  it('a displayName "=HYPERLINK(…)" is written as literal text', async () => {
    const files = await allFiles(dana);
    for (const kind of ['learners', 'attempts'] as const) {
      expect(files[kind]).toContain(`"'=HYPERLINK(""http://example.test"",""click"")"`);
      const kaiRow = records(files[kind]).find((row) => row.email === 'kai@qx.test')!;
      expect(kaiRow.displayName).toBe(`'${HYPERLINK}`);
    }
  });

  /* ------------------------------ the shapes ------------------------------ */

  it('writes each file under its own header, CRLF, in the stated order', async () => {
    const files = await allFiles(dana);
    expect(files.learners.split('\r\n')[0]).toBe(QUIZ_LEARNERS_COLUMNS.join(','));
    expect(files.attempts.split('\r\n')[0]).toBe(QUIZ_ATTEMPTS_COLUMNS.join(','));
    expect(files.questions.split('\r\n')[0]).toBe(QUIZ_QUESTIONS_COLUMNS.join(','));
    expect(files.class.split('\r\n')[0]).toBe(QUIZ_CLASS_COLUMNS.join(','));
    expect([...QUIZ_LEARNERS_COLUMNS]).toEqual([
      'email', 'displayName', 'class', 'project', 'phaseKey', 'taskKey', 'attempts used', 'attempts voided',
      'best score', 'latest score', 'passed', 'first submittedAt', 'last submittedAt',
    ]);
    expect([...QUIZ_ATTEMPTS_COLUMNS]).toEqual([
      'email', 'displayName', 'class', 'project', 'phaseKey', 'taskKey', 'epoch', 'attempt', 'status', 'score',
      'passed', 'startedAt', 'submittedAt', 'packVersion',
    ]);
    expect([...QUIZ_QUESTIONS_COLUMNS]).toEqual([
      'email', 'class', 'project', 'taskKey', 'epoch', 'attempt', 'position', 'questionId', 'outcome',
    ]);
    expect([...QUIZ_CLASS_COLUMNS]).toEqual([
      'class', 'project', 'taskKey', 'questionId', 'times drawn', 'times right', '% right', 'learners attempted',
      'learners passed',
    ]);
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) expect(files[kind].endsWith('\r\n')).toBe(true);

    // learners: email, project, phase order, taskKey.
    expect(records(files.learners).map((row) => [row.email, row.phaseKey, row.taskKey])).toEqual([
      ['kai@qx.test', 'design', DESIGN_QUIZ],
      ['kai@qx.test', 'deployment', DEPLOY_QUIZ],
      ['lee@qx.test', 'design', DESIGN_QUIZ],
    ]);
    const leeRow = records(files.learners).find((row) => row.email === 'lee@qx.test')!;
    expect(leeRow).toMatchObject({
      class: 'Tuesday',
      project: SLUG,
      'best score': '100',
      'latest score': '33',
      // The latest run (epoch 1) has not passed; the pass in epoch 0 was withdrawn by the reset.
      passed: 'no',
      'first submittedAt': '2026-09-01T09:05:00.000Z',
      'last submittedAt': '2026-09-03T09:05:00.000Z',
    });
    const kaiDeploy = records(files.learners).find((row) => row.taskKey === DEPLOY_QUIZ)!;
    // The newest paper has no verdict yet: latest score is blank, never 0.
    expect(kaiDeploy).toMatchObject({ 'attempts used': '2', 'best score': '0', 'latest score': '', passed: 'no' });

    // attempts: …, then epoch, then submittedAt.
    expect(records(files.attempts).filter((row) => row.email === 'lee@qx.test').map((row) => [row.epoch, row.status])).toEqual([
      ['0', 'submitted'],
      ['0', 'submitted'],
      ['0', 'voided'],
      ['1', 'submitted'],
    ]);

    // class: one row per drawn question, never an undrawn one; % right rounded.
    const design = records(files.class).filter((row) => row.taskKey === DESIGN_QUIZ);
    expect(design.map((row) => row.questionId)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    const q4 = design.find((row) => row.questionId === 'q4')!;
    // Drawn by Lee's 2nd (right), Lee's epoch-1 (wrong) and Kai's (right).
    expect(q4).toMatchObject({ class: 'Tuesday', 'times drawn': '3', 'times right': '2', '% right': '67', 'learners passed': '1' });
    const deploy = records(files.class).filter((row) => row.taskKey === DEPLOY_QUIZ);
    expect(deploy.map((row) => row.questionId)).toEqual(['q1', 'q2', 'q3']);
    expect(deploy.every((row) => row['learners attempted'] === '1' && row['learners passed'] === '0')).toBe(true);
  });

  /* ------------------------------- the scope ------------------------------ */

  it('a class the caller does not own is a 404 and nothing is read; ADMIN sees every class', async () => {
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
      await expect(exportOf(dana, kind, { cohort: thursday })).rejects.toBeInstanceOf(NotFoundException);
      await expect(exportOf(sam, kind, { cohort: tuesday })).rejects.toBeInstanceOf(NotFoundException);
      await expect(exportOf(dana, kind, { cohort: 'not-a-class' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(exportOf(admin, kind, { cohort: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    const danas = await allFiles(dana);
    const sams = await allFiles(sam);
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
      expect(danas[kind]).not.toContain('ben@qx.test');
      expect(danas[kind]).not.toContain('Thursday');
      expect(sams[kind]).not.toContain('lee@qx.test');
      expect(sams[kind]).not.toContain('Tuesday');
    }
    const own = await allFiles(dana, { cohort: tuesday });
    expect(own).toEqual(danas);
    const everyone = await exportOf(admin, 'attempts');
    expect(everyone).toContain('ben@qx.test');
    expect(everyone).toContain('lee@qx.test');
    const thursdayOnly = await exportOf(admin, 'learners', { cohort: thursday });
    expect(records(thursdayOnly).map((row) => row.email)).toEqual(['ben@qx.test']);
    // An unknown project is the catalogue's own 404.
    await expect(exportOf(dana, 'learners', { project: 'no-such-project' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes nothing: every table holds the same rows after all four files', async () => {
    const counts = async () => Promise.all(ALL_ENTITIES.map((entity) => manager().count(entity as never)));
    const before = await counts();
    const snapshot = await manager().find(QuizAttemptEntity, { order: { id: 'ASC' } });
    await allFiles(admin);
    await allFiles(dana);
    expect(await counts()).toEqual(before);
    expect(await manager().find(QuizAttemptEntity, { order: { id: 'ASC' } })).toEqual(snapshot);
  });
});
