import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { QUIZ_SCORE_BANDS, type AuthoredQuiz, type PublishVersionResult, type QuizResultsSummary } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { SandboxService } from '../src/execution/sandbox.service';
import { AuthService } from '../src/auth/auth.service';
import { RATE_LIMIT_KEY } from '../src/auth/rate-limit.guard';
import { ContentService } from '../src/content/content.service';
import { ALL_ENTITIES, PhaseStateEntity, QuizAttemptEntity, UserEntity } from '../src/db/entities';
import { QuizResultsSummaryController } from '../src/instructor/quiz-results-export.controller';
import { mockAiForRoutes } from './mock-ai';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * `GET /api/v1/instructor/quiz-results/summary` on the wired application, over
 * a fixed four-learner fixture.
 *
 * A teacher's class "Monday 10am" is assigned a copy of the platform project
 * carrying two quizzes: `design-check` beside the design phase's artefact task
 * and `deployment-check` beside the deployment phase's. Four learners join and
 * enrol through the learner routes; their papers are then written straight
 * into `quiz_attempts` in the shape the quiz service leaves them (the sheet in
 * the teacher's option ids, the stored score and pass the grading job wrote
 * back), so the stored scores can be 33.3 / 66.7 rather than what a
 * three-question paper rounds to. What this file proves is the route: the
 * numbers, that they are the CSV routes' numbers, who may read them, that a
 * read writes nothing, and the limit.
 *
 * The questions are the FIXTURE quiz (`quiz-fixture.ts`). No AI is asked
 * anything and no sandbox is booted.
 */
describe('the quiz-results summary route', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  const execute = jest.fn(async () => ({
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: 'the sandbox double ran nothing',
    durationMs: 1,
    truncated: false,
  }));

  const DESIGN_QUIZ = 'design-check';
  const DEPLOY_QUIZ = 'deployment-check';
  const quiz: AuthoredQuiz = {
    questions: fixtureQuizQuestions(3),
    drawn: 3,
    shuffleOptions: true,
    passMark: 60,
    attempts: { max: 3, cooldownSeconds: null },
    criterion: 'concepts',
  };

  interface Account {
    id: string;
    token: string;
    email: string;
  }

  let admin: Account;
  let owner: Account;
  let other: Account;
  let learnerA: Account;
  let monday = '';
  let thursday = '';
  let slug = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER'): Promise<Account> => {
    const email = `${name}-${stamp}@rd-quiz.test`;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string, email };
  };

  const newClass = async (teacher: Account, name: string): Promise<{ id: string; joinCode: string }> => {
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name }).expect(201);
    return { id: made.body.id as string, joinCode: made.body.joinCode as string };
  };

  const summaryOf = (token: string | null, query: string) => {
    const call = request(http).get(`/api/v1/instructor/quiz-results/summary${query}`);
    return token ? call.set(bearer(token)) : call;
  };
  const csvOf = (token: string, kind: string, query: string) =>
    request(http).get(`/api/v1/instructor/quiz-results/${kind}.csv${query}`).set(bearer(token));

  /** RFC 4180 enough for these files, keyed by the header. */
  const records = (text: string): Record<string, string>[] => {
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
    const [header, ...body] = rows;
    return body.map((one) => Object.fromEntries(header.map((name, at) => [name, one[at]])));
  };
  const numberOrNull = (cell: string): number | null => (cell === '' ? null : Number(cell));

  /** Every table's row count: the no-write guard. */
  const counts = async () => Promise.all(ALL_ENTITIES.map((entity) => db.manager.count(entity as never)));

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes], [SandboxService, { execute, startApp: jest.fn(), stopApp: jest.fn(), statusApp: jest.fn(), assetApp: jest.fn() }]] }));
    db = app.get(DataSource);

    admin = await account('ops', 'ADMIN');
    owner = await account('priya', 'INSTRUCTOR');
    other = await account('sam', 'INSTRUCTOR');

    // Monday 10am: a copy of the platform project carrying the two quizzes, published and assigned.
    const mondayClass = await newClass(owner, 'Monday 10am');
    monday = mondayClass.id;
    thursday = (await newClass(other, 'Thursday 2pm')).id;
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    slug = `rd-quiz-${stamp}`;
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(owner.token))
      .send({ title: 'Quiz results dashboard', slug, fromVersionId: platform.publishedVersionId })
      .expect(201);
    const projectId = created.body.project.id as string;
    const draftId = created.body.draftVersionId as string;
    for (const [phase, taskKey, title] of [
      ['design', DESIGN_QUIZ, 'Check the design'],
      ['deployment', DEPLOY_QUIZ, 'Check the deployment'],
    ]) {
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/phases/${phase}/tasks`)
        .set(bearer(owner.token))
        .send({ taskKey, title, brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false, quiz })
        .expect(201);
    }
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/publish`)
        .set(bearer(owner.token))
        .send({ version: '1.0.0', notes: 'Two quizzes for the dashboard.' })
        .expect(200)
    ).body as PublishVersionResult;
    const versionId = published.versionId;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${monday}/project`)
      .set(bearer(owner.token))
      .send({ projectVersionId: versionId, reason: 'This class takes the concept checks.' })
      .expect(200);

    // The quiz as the version holds it: which option is right, in the teacher's ids.
    const pin = { projectSlug: slug, projectVersionId: versionId };
    const designTask = app.get(ContentService).getTasksForEnrollment(pin, 'design').find((one) => one.taskKey === DESIGN_QUIZ)!;
    const questions = (designTask.checks as any).questions as { id: string; correct: string[]; options: { id: string }[] }[];
    const rightOf = (id: string) => questions.find((one) => one.id === id)!.correct;
    const wrongOf = (id: string) => {
      const question = questions.find((one) => one.id === id)!;
      return [question.options.find((option) => !question.correct.includes(option.id))!.id];
    };

    const enrol = async (learner: Account): Promise<string> => {
      await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).send({ code: mondayClass.joinCode }).expect(200);
      const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).send({ projectSlug: slug }).expect(201);
      const designId = enrolled.body.phases.find((one: any) => one.key === 'design').id as string;
      await db.manager.update(PhaseStateEntity, { id: designId }, { status: 'in_progress' });
      return designId;
    };
    const paper = async (
      learner: Account,
      designId: string,
      over: { right: string[]; score?: number; passed?: boolean; at: string; open?: boolean; voided?: boolean },
    ) => {
      const drawn = ['q1', 'q2', 'q3'];
      const handedIn = !over.open && !over.voided;
      const sheet = Object.fromEntries(drawn.map((id) => [id, over.right.includes(id) ? rightOf(id) : wrongOf(id)]));
      await db.manager.save(
        db.manager.create(QuizAttemptEntity, {
          phaseStateId: designId,
          userId: learner.id,
          taskKey: DESIGN_QUIZ,
          epoch: 0,
          voidedAt: over.voided ? `${over.at}:05:00.000Z` : null,
          projectVersionId: versionId,
          packVersion: '1.0.0',
          submissionId: null,
          paper: drawn.map((id) => ({ questionId: id, optionIds: questions.find((one) => one.id === id)!.options.map((option) => option.id) })),
          answers: handedIn ? sheet : null,
          score: handedIn ? over.score! : null,
          passed: handedIn ? over.passed! : null,
          startedAt: `${over.at}:00:00.000Z`,
          submittedAt: over.open ? null : `${over.at}:05:00.000Z`,
        }),
      );
    };

    learnerA = await account('ana');
    const learnerB = await account('ben');
    const learnerC = await account('cai');
    const learnerD = await account('dev');
    const a = await enrol(learnerA);
    const b = await enrol(learnerB);
    const c = await enrol(learnerC);
    const d = await enrol(learnerD);
    await paper(learnerA, a, { right: ['q1'], score: 33.3, passed: false, at: '2026-09-01T09' });
    await paper(learnerA, a, { right: ['q1', 'q2', 'q3'], score: 100, passed: true, at: '2026-09-01T10' });
    await paper(learnerB, b, { right: [], score: 0, passed: false, at: '2026-09-02T09' });
    await paper(learnerB, b, { right: ['q1'], score: 33.3, passed: false, at: '2026-09-02T10' });
    await paper(learnerB, b, { right: ['q1', 'q2'], score: 66.7, passed: true, at: '2026-09-02T11' });
    await paper(learnerC, c, { right: ['q3'], score: 33.3, passed: false, at: '2026-09-03T09' });
    await paper(learnerC, c, { right: ['q1', 'q2', 'q3'], at: '2026-09-03T10', voided: true });
    await paper(learnerD, d, { right: ['q1', 'q2', 'q3'], at: '2026-09-04T09', open: true });
  }, 240000);

  afterAll(async () => {
    await app?.close();
  });

  const bands = (filled: Record<string, number>) => QUIZ_SCORE_BANDS.map((band) => ({ band: band.key, learners: filled[band.key] ?? 0 }));

  // The AppModule picks its database from DATABASE_URL alone: a PostgreSQL
  // run sets it to a scratch database; otherwise in-memory SQLite.
  it(`runs on ${process.env.DATABASE_URL ? 'PostgreSQL (DATABASE_URL set)' : 'in-memory SQLite (no DATABASE_URL)'}`, () => {
    expect(db.options.type).toBe(process.env.DATABASE_URL ? 'postgres' : 'better-sqlite3');
  });

  it("the owner reads Monday 10am's §4.4 numbers", async () => {
    const body = (await summaryOf(owner.token, `?cohort=${monday}`).expect(200)).body as QuizResultsSummary;
    const email = (name: string) => `${name}-${stamp}@rd-quiz.test`;
    expect(body).toEqual({
      cohortId: monday,
      className: 'Monday 10am',
      learnersInClass: 4,
      quizzes: [
        {
          project: slug,
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
        },
        {
          project: slug,
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
        },
      ],
      learners: [
        { email: email('ana'), displayName: 'ana', project: slug, phaseKey: 'design', taskKey: DESIGN_QUIZ, attemptsUsed: 2, attemptsVoided: 0, bestScore: 100, latestScore: 100, passed: true },
        { email: email('ben'), displayName: 'ben', project: slug, phaseKey: 'design', taskKey: DESIGN_QUIZ, attemptsUsed: 3, attemptsVoided: 0, bestScore: 66.7, latestScore: 66.7, passed: true },
        { email: email('cai'), displayName: 'cai', project: slug, phaseKey: 'design', taskKey: DESIGN_QUIZ, attemptsUsed: 1, attemptsVoided: 1, bestScore: 33.3, latestScore: 33.3, passed: false },
      ],
    });
    // The seal: no stem, option text, explanation, concept or key; no uuid but the class id.
    const { cohortId: _id, ...rest } = body;
    const text = JSON.stringify(rest);
    for (const word of ['Fixture question', 'Option A', 'Option B', 'Fixture explanation', 'fixture-concept-', '"correct"', 'optionIds'])
      expect(text).not.toContain(word);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // The same numbers with the project named.
    expect((await summaryOf(owner.token, `?cohort=${monday}&project=${slug}`).expect(200)).body).toEqual(body);
  });

  it("the summary's numbers are the CSV routes' numbers for ?cohort=", async () => {
    const body = (await summaryOf(owner.token, `?cohort=${monday}`).expect(200)).body as QuizResultsSummary;
    const learners = records((await csvOf(owner.token, 'learners', `?cohort=${monday}`).expect(200)).text);
    const attempts = records((await csvOf(owner.token, 'attempts', `?cohort=${monday}`).expect(200)).text);
    const classRows = records((await csvOf(owner.token, 'class', `?cohort=${monday}`).expect(200)).text);
    expect(body.learners).toEqual(
      learners.map((row) => ({
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
    for (const quiz of body.quizzes) {
      const mine = classRows.filter((row) => row.project === quiz.project && row.taskKey === quiz.taskKey);
      expect(quiz.attempts).toBe(attempts.filter((row) => row.taskKey === quiz.taskKey && row.status === 'submitted').length);
      expect(quiz.questions).toEqual(
        mine.map((row) => ({
          questionId: row.questionId,
          drawn: Number(row['times drawn']),
          right: Number(row['times right']),
          percentRight: numberOrNull(row['% right']),
        })),
      );
      for (const row of mine) {
        expect(Number(row['learners attempted'])).toBe(quiz.learnersAttempted);
        expect(Number(row['learners passed'])).toBe(quiz.learnersPassed);
      }
    }
    expect(body.quizzes[0].attempts).toBe(6);
  });

  it('refuses: another teacher 404 naming nobody, a learner 403, no token 401, no or blank class 400, an unknown project 404; admin reads it', async () => {
    const refused = await summaryOf(other.token, `?cohort=${monday}`).expect(404);
    expect(refused.text).not.toContain('Monday 10am');
    expect(refused.text).not.toContain(learnerA.email);
    // The other teacher's own class answers, empty.
    const theirs = (await summaryOf(other.token, `?cohort=${thursday}`).expect(200)).body as QuizResultsSummary;
    expect(theirs).toEqual({ cohortId: thursday, className: 'Thursday 2pm', learnersInClass: 0, quizzes: [], learners: [] });
    await summaryOf(learnerA.token, `?cohort=${monday}`).expect(403);
    await summaryOf(null, `?cohort=${monday}`).expect(401);
    await summaryOf(owner.token, '').expect(400);
    await summaryOf(owner.token, '?cohort=').expect(400);
    await summaryOf(owner.token, '?cohort=%20%20').expect(400);
    await summaryOf(owner.token, `?cohort=${'x'.repeat(81)}`).expect(400);
    await summaryOf(owner.token, `?cohort=${monday}&project=no-such-project`).expect(404);
    const asAdmin = await summaryOf(admin.token, `?cohort=${monday}`).expect(200);
    const asOwner = await summaryOf(owner.token, `?cohort=${monday}`).expect(200);
    expect(asAdmin.body).toEqual(asOwner.body);
  });

  it('a read writes nothing, asks no AI and runs no sandbox', async () => {
    const before = await counts();
    const papers = await db.getRepository(QuizAttemptEntity).find({ order: { id: 'ASC' } });
    const ai = [mockAiForRoutes.chat, mockAiForRoutes.interview, mockAiForRoutes.reviewInterview, mockAiForRoutes.review].map(
      (fn) => fn.mock.calls.length,
    );
    const ran = execute.mock.calls.length;
    await summaryOf(owner.token, `?cohort=${monday}`).expect(200);
    await summaryOf(admin.token, `?cohort=${thursday}`).expect(200);
    await summaryOf(other.token, `?cohort=${monday}`).expect(404);
    await summaryOf(learnerA.token, `?cohort=${monday}`).expect(403);
    expect(await counts()).toEqual(before);
    expect(await db.getRepository(QuizAttemptEntity).find({ order: { id: 'ASC' } })).toEqual(papers);
    expect(
      [mockAiForRoutes.chat, mockAiForRoutes.interview, mockAiForRoutes.reviewInterview, mockAiForRoutes.review].map(
        (fn) => fn.mock.calls.length,
      ),
    ).toEqual(ai);
    expect(execute.mock.calls.length).toBe(ran);
  });

  it('is limited to 20 a minute per caller: the 21st is a 429', async () => {
    const handler = QuizResultsSummaryController.prototype.summary;
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual(expect.objectContaining({ max: 20, windowSeconds: 60 }));
    // A caller of its own, so no earlier test's reads are in its window.
    const fresh = await account('kim', 'INSTRUCTOR');
    const own = (await newClass(fresh, 'Friday 9am')).id;
    for (let call = 1; call <= 20; call++) await summaryOf(fresh.token, `?cohort=${own}`).expect(200);
    await summaryOf(fresh.token, `?cohort=${own}`).expect(429);
  }, 60000);
});
