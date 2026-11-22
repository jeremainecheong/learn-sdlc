import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { AuthoredQuiz, PublishVersionResult, QuizResultsSummary } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { SandboxService } from '../src/execution/sandbox.service';
import { AuthService } from '../src/auth/auth.service';
import { ProjectEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * On the wired application: the summary route declares the quizzes of a class's version as
 * CohortProjectService resolves it, the active assignment row else the
 * deployment's default project.
 *
 * TaskTrackr (the seeded default) has no quiz task, so a class on it declares
 * nothing, as a live deployment does. The spec then makes a published copy carrying one quiz the
 * flagged default (as an operator's import would) and reads a class with no
 * assignment row: one zero card, declared. An assigned class keeps its own
 * version. No AI is asked anything and no sandbox is booted.
 */
describe('declared quizzes follow the class version', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  const quiz: AuthoredQuiz = {
    questions: fixtureQuizQuestions(3),
    drawn: 3,
    shuffleOptions: true,
    passMark: 60,
    attempts: { max: 3, cooldownSeconds: null },
    criterion: 'concepts',
  };

  let teacher: { id: string; token: string };
  let unassigned = '';
  let assigned = '';
  let slug = '';
  let platformSlug = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@re-quiz.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };
  const newClass = async (name: string) =>
    (await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name }).expect(201)).body.id as string;
  const summaryOf = async (cohort: string): Promise<QuizResultsSummary> =>
    (await request(http).get(`/api/v1/instructor/quiz-results/summary?cohort=${cohort}`).set(bearer(teacher.token)).expect(200)).body;
  const cards = (summary: QuizResultsSummary) =>
    summary.quizzes.map((one) => [one.project, one.phaseKey, one.taskKey, one.title, one.declared, one.attempts]);

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes], [SandboxService, { execute: jest.fn(), startApp: jest.fn(), stopApp: jest.fn(), statusApp: jest.fn(), assetApp: jest.fn() }]] }));
    db = app.get(DataSource);

    teacher = await account('priya', 'INSTRUCTOR');
    unassigned = await newClass('Tuesday 9am');
    assigned = await newClass('Wednesday 1pm');

    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    platformSlug = platform.slug;
    slug = `re-quiz-${stamp}`;
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Declared quiz', slug, fromVersionId: platform.publishedVersionId })
      .expect(201);
    const projectId = created.body.project.id as string;
    const draftId = created.body.draftVersionId as string;
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/phases/design/tasks`)
      .set(bearer(teacher.token))
      .send({ taskKey: 'design-check', title: 'Check the design', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false, quiz })
      .expect(201);
    const published = (
      await request(http)
        .post(`/api/v1/instructor/projects/${projectId}/versions/${draftId}/publish`)
        .set(bearer(teacher.token))
        .send({ version: '1.0.0', notes: 'One quiz.' })
        .expect(200)
    ).body as PublishVersionResult;
    // Wednesday is assigned the platform project's published version: no quiz there.
    await request(http)
      .put(`/api/v1/instructor/cohorts/${assigned}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: platform.publishedVersionId, reason: 'This class works the platform project.' })
      .expect(200);
    expect(published.versionId).toBeTruthy();
  }, 240000);

  afterAll(async () => {
    await app?.close();
  });

  it(`runs on ${process.env.DATABASE_URL ? 'PostgreSQL (DATABASE_URL set)' : 'in-memory SQLite (no DATABASE_URL)'}`, () => {
    expect(db.options.type).toBe(process.env.DATABASE_URL ? 'postgres' : 'better-sqlite3');
  });

  it('a class with no assignment row on the seeded default (no quiz task) declares nothing, as live', async () => {
    const summary = await summaryOf(unassigned);
    expect(summary.learnersInClass).toBe(0);
    expect(summary.quizzes).toEqual([]);
  });

  it('once the default project carries a quiz, a class with no assignment row shows it as a declared zero card', async () => {
    await db.manager.update(ProjectEntity, { slug: platformSlug }, { isDefault: false });
    await db.manager.update(ProjectEntity, { slug }, { isDefault: true });
    try {
      const summary = await summaryOf(unassigned);
      expect(cards(summary)).toEqual([[slug, 'design', 'design-check', 'Check the design', true, 0]]);
      expect(summary.quizzes[0]).toMatchObject({ learnersAttempted: 0, learnersPassed: 0, passRate: null, questions: [] });
      // The assigned class keeps its own version: the platform project's, which has no quiz.
      expect((await summaryOf(assigned)).quizzes).toEqual([]);
      // The CSVs list handed-in papers only: the zero card is in no file.
      const classCsv = await request(http)
        .get(`/api/v1/instructor/quiz-results/class.csv?cohort=${unassigned}`)
        .set(bearer(teacher.token))
        .expect(200);
      expect(classCsv.text).not.toContain('design-check');
    } finally {
      await db.manager.update(ProjectEntity, { slug }, { isDefault: false });
      await db.manager.update(ProjectEntity, { slug: platformSlug }, { isDefault: true });
    }
  });
});
