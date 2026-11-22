import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { QUIZ_RESULTS_EXPORT_KINDS } from '@learnsdlc/shared';
import type { AuthoredQuiz, PublishVersionResult, QuizOpenPaper } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { SandboxService } from '../src/execution/sandbox.service';
import { AuthService } from '../src/auth/auth.service';
import { PhaseStateEntity, QuizAttemptEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The four quiz-results CSVs on the wired application.
 *
 * Two teachers, each with a class on a copy of their own that carries a quiz
 * beside the design phase's artefact task, and a learner in each who sits the
 * quiz through the learner's own routes. What this file holds is the scope:
 * one teacher asking for the other's class is a 404 that names nobody, and an
 * admin reads both classes.
 *
 * And the guard beside it: the two other teacher CSVs and the learner's
 * own export answer the same bytes before and after the four files are read
 * (the account export's `exportedAt` stamp aside, which is the moment of the
 * read and moves on every call).
 *
 * The questions are the FIXTURE quiz (`quiz-fixture.ts`), which says so in
 * every stem. No AI is asked anything, and no sandbox is booted.
 */
describe('the quiz-results export', () => {
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

  const QUIZ_KEY = 'concepts';
  const POOL = fixtureQuizQuestions(5);
  const quiz: AuthoredQuiz = {
    questions: POOL,
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
  interface Class {
    teacher: Account;
    cohortId: string;
    slug: string;
    learner: Account;
    designId: string;
    tokens: string[];
  }

  let admin: Account;
  let first: Class;
  let second: Class;
  /** A second learner in the first class, holding only an open paper. */
  let opener: Account;

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER'): Promise<Account> => {
    const email = `${name}-${stamp}@qx-export.test`;
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

  const waitFor = async (submissionId: string, token: string): Promise<any> => {
    return waitForSubmission(http, bearer(token), submissionId, { attempts: 100, intervalMs: 200, message: `submission ${submissionId} did not finish` });
  };

  /** A learner joins, enrols, and stands on the design phase. */
  const enrol = async (learner: Account, joinCode: string, slug: string): Promise<string> => {
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).send({ code: joinCode }).expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learner.token))
      .send({ projectSlug: slug })
      .expect(201);
    const designId = enrolled.body.phases.find((one: any) => one.key === 'design').id as string;
    await db.manager.update(PhaseStateEntity, { id: designId }, { status: 'in_progress' });
    return designId;
  };

  const draw = async (learner: Account, designId: string): Promise<QuizOpenPaper> =>
    (
      await request(http)
        .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts`)
        .set(bearer(learner.token))
        .expect(200)
    ).body as QuizOpenPaper;

  /** Draw a paper, answer the first `right` questions rightly, hand it in. */
  const sit = async (learner: Account, designId: string, right: number) => {
    const paper = await draw(learner, designId);
    const answers: Record<string, string[]> = {};
    paper.questions.forEach((question, at) => {
      const letter = at < right ? 'A' : 'B';
      answers[question.id] = [question.options.find((option) => option.text.startsWith(`Option ${letter} —`))!.id];
    });
    const handed = await request(http)
      .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts/${paper.attemptId}`)
      .set(bearer(learner.token))
      .send({ answers })
      .expect(201);
    const verdict = await waitFor(handed.body.id, learner.token);
    expect(verdict.status).toBe('completed');
    return paper;
  };

  /** A teacher, a class, a copy carrying the quiz, published and assigned. */
  const classWithQuiz = async (name: string, className: string): Promise<Omit<Class, 'learner' | 'designId' | 'tokens'> & { joinCode: string }> => {
    const teacher = await account(name, 'INSTRUCTOR');
    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacher.token))
      .send({ name: className })
      .expect(201);
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const slug = `qx-${name}-${stamp}`;
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: `Quiz results ${name}`, slug, fromVersionId: platform.publishedVersionId })
      .expect(201);
    const projectId = created.body.project.id as string;
    const draftId = created.body.draftVersionId as string;
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/phases/design/tasks`)
      .set(bearer(teacher.token))
      .send({
        taskKey: QUIZ_KEY,
        title: 'Check the design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz,
      })
      .expect(201);
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/publish`)
        .set(bearer(teacher.token))
        .send({ version: '1.0.0', notes: 'A design phase with a quiz beside it.' })
        .expect(200)
    ).body as PublishVersionResult;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${made.body.id}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'This class takes the concept check.' })
      .expect(200);
    return { teacher, cohortId: made.body.id, slug, joinCode: made.body.joinCode };
  };

  const quizFile = (token: string, kind: string, query = '') =>
    request(http).get(`/api/v1/instructor/quiz-results/${kind}.csv${query}`).set(bearer(token));

  /** The three files the quiz-results reads must leave byte-identical. */
  const existingExports = async (teacher: Account, learner: Account) => {
    const grades = await request(http).get('/api/v1/instructor/export.csv').set(bearer(teacher.token)).expect(200);
    const book = await request(http).get('/api/v1/instructor/gradebook.csv').set(bearer(teacher.token)).expect(200);
    const mine = await request(http).get('/api/v1/account/export').set(bearer(learner.token)).expect(200);
    const { exportedAt, ...rest } = JSON.parse(mine.text);
    expect(typeof exportedAt).toBe('string');
    return { grades: grades.text, book: book.text, account: JSON.stringify(rest) };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes], [SandboxService, { execute, startApp: jest.fn(), stopApp: jest.fn(), statusApp: jest.fn(), assetApp: jest.fn() }]] }));
    db = app.get(DataSource);

    admin = await account('ops', 'ADMIN');

    const one = await classWithQuiz('priya', 'Monday 10am');
    const learner = await account('amir');
    const designId = await enrol(learner, one.joinCode, one.slug);
    const paperOne = await sit(learner, designId, 1);
    const paperTwo = await sit(learner, designId, 3);
    opener = await account('noor');
    const openerDesign = await enrol(opener, one.joinCode, one.slug);
    const openPaper = await draw(opener, openerDesign);
    first = {
      ...one,
      learner,
      designId,
      tokens: [paperOne, paperTwo, openPaper].flatMap((paper) =>
        paper.questions.flatMap((question) => question.options.map((option) => option.id)),
      ),
    };

    const two = await classWithQuiz('sam', 'Thursday 2pm');
    const learnerTwo = await account('bea');
    const designTwo = await enrol(learnerTwo, two.joinCode, two.slug);
    const paperThree = await sit(learnerTwo, designTwo, 2);
    second = {
      ...two,
      learner: learnerTwo,
      designId: designTwo,
      tokens: paperThree.questions.flatMap((question) => question.options.map((option) => option.id)),
    };
  }, 240000);

  afterAll(async () => {
    await app?.close();
  });

  it("another instructor's class is 404 and returns no learner of it; ADMIN sees both", async () => {
    const before = await existingExports(first.teacher, first.learner);
    const attemptsBefore = await db.getRepository(QuizAttemptEntity).find({ order: { id: 'ASC' } });

    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
      // The other teacher's class: a 404 that names nobody in it.
      const refused = await quizFile(first.teacher.token, kind, `?cohort=${second.cohortId}`).expect(404);
      expect(refused.text).not.toContain(second.learner.email);
      expect(refused.text).not.toContain('Thursday 2pm');
      expect(refused.headers['content-disposition']).toBeUndefined();

      // The caller's own class, named and unnamed: the same file.
      const own = await quizFile(first.teacher.token, kind, `?cohort=${first.cohortId}`).expect(200);
      const all = await quizFile(first.teacher.token, kind).expect(200);
      expect(own.text).toBe(all.text);
      expect(own.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(own.headers['content-disposition']).toBe(`attachment; filename="quiz-${kind}.csv"`);
      expect(all.text).not.toContain(second.learner.email);
      expect(all.text).not.toContain('Thursday 2pm');
      // The open paper is in no file; a learner with only an open paper neither.
      expect(all.text).not.toContain(opener.email);

      // The seal: no stem, no option text, no explanation, no concept, no key,
      // no paper token, no uuid.
      for (const word of ['Fixture question', 'Option A', 'Option B', 'Fixture explanation', 'fixture-concept-', '"correct"'])
        expect(all.text).not.toContain(word);
      for (const token of [...first.tokens, ...second.tokens]) expect(all.text).not.toContain(token);
      expect(all.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

      // ADMIN: both classes, whole and one at a time.
      const everyone = await quizFile(admin.token, kind).expect(200);
      const onlySecond = await quizFile(admin.token, kind, `?cohort=${second.cohortId}`).expect(200);
      if (kind === 'class') {
        expect(everyone.text).toContain('Monday 10am');
        expect(everyone.text).toContain('Thursday 2pm');
        expect(onlySecond.text).not.toContain('Monday 10am');
      } else {
        expect(everyone.text).toContain(first.learner.email);
        expect(everyone.text).toContain(second.learner.email);
        expect(onlySecond.text).toContain(second.learner.email);
        expect(onlySecond.text).not.toContain(first.learner.email);
      }
    }

    // A learner is refused the whole surface.
    await quizFile(first.learner.token, 'learners').expect(403);

    // What the files say about the first class: two papers, numbered 1 and 2.
    const attempts = (await quizFile(admin.token, 'attempts', `?cohort=${first.cohortId}&project=${first.slug}`).expect(200)).text;
    const rows = attempts.trimEnd().split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain(',1,submitted,33,');
    expect(rows[2]).toContain(',2,submitted,100,');

    // The guard: nothing was written and the three other exports are the same bytes.
    expect(await db.getRepository(QuizAttemptEntity).find({ order: { id: 'ASC' } })).toEqual(attemptsBefore);
    expect(await existingExports(first.teacher, first.learner)).toEqual(before);
  }, 120000);
});
