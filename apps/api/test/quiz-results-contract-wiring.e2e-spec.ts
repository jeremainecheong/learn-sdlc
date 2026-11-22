import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { QUIZ_RESULTS_EXPORT_KINDS } from '@learnsdlc/shared';
import type { AuthoredQuiz, PublishVersionResult, QuizOpenPaper } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { PhaseStateEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import { ExchangeLog, Redactor, holdExchangeContract } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The four quiz-results files, recorded through the real `AppModule` for
 * `apps/web/test/quiz-results-wiring.test.tsx`.
 *
 * The quiz-results scenario, cut to one class: a teacher's copy whose design phase carries
 * the FIXTURE quiz beside its artefact, and a learner who sits it twice through
 * the learner's own routes. Recorded are the reads the teacher's page makes
 * (the classes, the overview, the learners, the stuck list), and the four CSVs
 * exactly as the web asks for them (`GET /instructor/quiz-results/<kind>.csv`,
 * no project), with their content type and disposition. The CSV text is held
 * redacted (emails, names, ids), because the web test checks the page saves
 * the file the API answered and draws none of it.
 *
 * The stub AI (`mockAiForRoutes`) and the in-process runner; no AI is asked
 * anything. Four CSV reads stay inside the route's 5 a minute.
 */
describe('the quiz-results export, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  const QUIZ_KEY = 'concepts';
  const quiz: AuthoredQuiz = {
    questions: fixtureQuizQuestions(5),
    drawn: 3,
    shuffleOptions: true,
    passMark: 60,
    attempts: { max: 3, cooldownSeconds: null },
    criterion: 'concepts',
  };

  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${handle}@rx-contract.test`, password: PASSWORD, displayName })
      .expect(201);
    const id = registered.body.user.id as string;
    redactor.name(displayName, `name:${handle}`);
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const get = async (name: string, url: string, token: string, headers: string[] = []) => {
    const res = await request(http).get(url).set(bearer(token)).expect(200);
    log.take(name, 'GET', url, undefined, res, headers);
    return res;
  };

  const waitFor = async (submissionId: string, token: string) => {
    return waitForSubmission(http, bearer(token), submissionId, { attempts: 100, intervalMs: 200, message: `submission ${submissionId} did not finish` });
  };

  /** Draw a paper, answer the first `right` questions rightly, hand it in. */
  const sit = async (token: string, designId: string, right: number) => {
    const paper = (await request(http).post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts`).set(bearer(token)).expect(200))
      .body as QuizOpenPaper;
    const answers: Record<string, string[]> = {};
    paper.questions.forEach((question, at) => {
      const letter = at < right ? 'A' : 'B';
      answers[question.id] = [question.options.find((option) => option.text.startsWith(`Option ${letter} —`))!.id];
    });
    const handed = await request(http)
      .post(`/api/v1/phases/${designId}/tasks/${QUIZ_KEY}/quiz/attempts/${paper.attemptId}`)
      .set(bearer(token))
      .send({ answers })
      .expect(201);
    expect((await waitFor(handed.body.id, token)).status).toBe('completed');
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('confirms the stub AI before anything is driven (m8)', () => {
    expect((app.get(OpenAiProvider) as unknown as { name: string }).name).toBe('mock-ai');
  });

  it('records the teacher page’s reads and the four files as the web asks for them', async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Monday 10am' }).expect(201);
    redactor.name(made.body.joinCode, 'join-code');
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const slug = 'quiz-results-copy';
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Quiz results', slug, fromVersionId: platform.publishedVersionId })
      .expect(201);
    const at = `/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}`;
    await request(http)
      .post(`${at}/phases/design/tasks`)
      .set(bearer(teacher.token))
      .send({ taskKey: QUIZ_KEY, title: 'Check the design concepts', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false, quiz })
      .expect(201);
    const published = (
      await request(http).post(`${at}/publish`).set(bearer(teacher.token)).send({ version: '1.0.0', notes: 'A design phase with a quiz beside it.' }).expect(200)
    ).body as PublishVersionResult;
    await request(http)
      .put(`/api/v1/instructor/cohorts/${made.body.id}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'This class takes the concept check.' })
      .expect(200);

    const learner = await account('amir', 'Ixa Pellowmere');
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).send({ code: made.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).send({ projectSlug: slug }).expect(201);
    const designId = enrolled.body.phases.find((one: any) => one.key === 'design').id as string;
    await db.manager.update(PhaseStateEntity, { id: designId }, { status: 'in_progress' });
    await sit(learner.token, designId, 1);
    await sit(learner.token, designId, 3);

    // The teacher page's own reads, in the order it makes them.
    await get('cohorts', '/api/v1/instructor/cohorts', teacher.token);
    await get('overview', '/api/v1/instructor/overview', teacher.token);
    const learners = (await get('learners', '/api/v1/instructor/learners?limit=50', teacher.token)).body;
    await get('stuck', '/api/v1/instructor/stuck', teacher.token);
    await get('schedule', `/api/v1/instructor/cohorts/${made.body.id}/schedule?project=${slug}`, teacher.token);
    const submissionIds = new Set<string>();
    const walk = (value: unknown, key = '') => {
      if (Array.isArray(value)) value.forEach((one) => walk(one));
      else if (value && typeof value === 'object') {
        if (key === 'lastSubmission' && typeof (value as { id?: unknown }).id === 'string') submissionIds.add((value as { id: string }).id);
        for (const [k, one] of Object.entries(value)) walk(one, k);
      }
    };
    walk(learners);
    for (const [n, id] of [...submissionIds].entries()) {
      await get(`teacherFeedback${n + 1}`, `/api/v1/submissions/${id}/teacher-feedback`, teacher.token);
    }

    const files: Record<string, string> = {};
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
      const res = await get(`file:${kind}`, `/api/v1/instructor/quiz-results/${kind}.csv`, teacher.token, ['content-type', 'content-disposition']);
      expect(String(res.headers['content-type'])).toMatch(/^text\/csv/);
      files[kind] = res.text;
    }
    // Every file has its header row and at least one data row for the class.
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) expect(files[kind].trim().split(/\r?\n/).length).toBeGreaterThan(1);
    // The learner's email is in the per-learner files, and redaction takes it out of the recording.
    expect(files.learners).toContain('amir@rx-contract.test');

    holdExchangeContract(
      'quiz-results',
      'apps/api/test/quiz-results-contract-wiring.e2e-spec.ts',
      log,
      { kinds: [...QUIZ_RESULTS_EXPORT_KINDS], slug },
      redactor,
    );
  }, 240000);
});
