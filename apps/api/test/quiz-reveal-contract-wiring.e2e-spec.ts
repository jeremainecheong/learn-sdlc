import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { AuthoredQuiz, EnrollmentView, PublishVersionResult, QuizOpenPaper, QuizRoomView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import { Redactor, holdContract } from './fixtures/contract-bodies/recorder';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The recorded reveal contract, through the real `AppModule`.
 *
 * 1. **The round trip** a teacher's editor makes: a stored rule → the task
 *    list (the view) → the audited key read → a save of the form untouched
 *    (the key payload sent back as the editor builds it) → the rule is kept,
 *    on the list and on a second key read. The same for a quiz with no rule:
 *    it stays absent.
 * 2. **The caller wiring**: `releaseExplanations` reads
 *    `revealRuleFor(task, checks)` at the verdict. A capped optional quiz set
 *    to "after every attempt" shows every explanation on a failed paper with
 *    attempts left; the same quiz without the rule shows none. Without the
 *    `reveal:` argument at the call site both papers would read alike, so the
 *    first assertion fails.
 * 3. **`passCredited`**, shared between the API and the quiz room: after a
 *    teacher's Sign off of a failed quiz the room answers
 *    `passCredited: true` under the shared name `QuizRoom` reads; an
 *    uncredited quiz carries no such key.
 * 4. **The teacher's audit trail**, as the web's AuditList labels it: what
 *    these routes wrote, as `GET /instructor/audit`
 *    answers it, drawn by `apps/web/test/authoring-audit-wiring.test.tsx`.
 *
 * Recorded in `fixtures/contract-bodies/quiz-reveal.json` for
 * `apps/web/test/quiz-reveal-wiring.test.tsx`, which rebuilds the untouched
 * save from the recorded key with the editor's own functions and renders the
 * learner's marked paper from the recorded verdict.
 */
describe('the quiz reveal, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const capped = { max: 3, cooldownSeconds: null };

  const quiz = (prefix: string, over: Partial<AuthoredQuiz> = {}): AuthoredQuiz => ({
    questions: fixtureQuizQuestions(8, prefix),
    drawn: 5,
    shuffleOptions: true,
    passMark: 80,
    attempts: capped,
    criterion: 'concepts',
    ...over,
  });

  /** Display names no product text holds, so replacing them cannot touch a word of copy. */
  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${handle}@contract-bodies.test`, password: PASSWORD, displayName })
      .expect(201);
    const id = registered.body.user.id as string;
    redactor.name(displayName, `name:${handle}`);
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const waitFor = async (token: string, submissionId: string): Promise<any> => {
    return waitForSubmission(http, bearer(token), submissionId, { attempts: 100, intervalMs: 200, message: `submission ${submissionId} did not finish` });
  };

  /** Sit a whole wrong paper (every fixture question keys option A; B is wrong). */
  const sitWrong = async (token: string, phaseId: string, taskKey: string) => {
    const paper = (await request(http).post(`/api/v1/phases/${phaseId}/tasks/${taskKey}/quiz/attempts`).set(bearer(token)).expect(200))
      .body as QuizOpenPaper;
    const answers: Record<string, string[]> = {};
    for (const question of paper.questions) {
      const wrong = question.options.find((option) => option.text.startsWith('Option B —'));
      answers[question.id] = [wrong!.id];
    }
    const handed = await request(http)
      .post(`/api/v1/phases/${phaseId}/tasks/${taskKey}/quiz/attempts/${paper.attemptId}`)
      .set(bearer(token))
      .send({ answers })
      .expect(201);
    const verdict = await waitFor(token, handed.body.id);
    const room = (await request(http).get(`/api/v1/phases/${phaseId}/tasks/${taskKey}/quiz`).set(bearer(token)).expect(200))
      .body as QuizRoomView;
    return { verdict, room };
  };

  const explanationsOf = (verdict: any): Array<string | null> =>
    (verdict.report.quiz.questions as any[]).map((one) => one.explanation);

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('keeps a stored rule through view, key read and an untouched save; the verdict reveals by it', async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Reveal Copy', slug: 'reveal-copy', fromVersionId: platform.publishedVersionId })
      .expect(201);
    const at = `/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}`;
    const tasksAt = `${at}/phases/requirements/tasks`;

    const add = (taskKey: string, title: string, body: AuthoredQuiz) =>
      request(http)
        .post(tasksAt)
        .set(bearer(teacher.token))
        .send({ taskKey, title, brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false, quiz: body })
        .expect(201);
    await add('practice-always', 'Practice, shown every time', quiz('pa', { revealExplanation: 'always' }));
    await add('practice-plain', 'Practice, as built', quiz('pp'));

    const ruleOf = (list: any, key: string) => (list.tasks as any[]).find((one) => one.taskKey === key)?.quiz?.revealExplanation ?? null;

    // 1. the view
    const listed = (await request(http).get(tasksAt).set(bearer(teacher.token)).expect(200)).body;
    expect([ruleOf(listed, 'practice-always'), ruleOf(listed, 'practice-plain')]).toEqual(['always', null]);

    // 2. the audited key read
    const keyAlways = (await request(http).get(`${tasksAt}/practice-always/quiz/key`).set(bearer(teacher.token)).expect(200)).body;
    const keyPlain = (await request(http).get(`${tasksAt}/practice-plain/quiz/key`).set(bearer(teacher.token)).expect(200)).body;
    expect(keyAlways.revealExplanation).toBe('always');
    expect(keyPlain.revealExplanation).toBeUndefined();

    // 3. an untouched save: what the key read answered, sent back whole
    const saveAlways = { title: 'Practice, shown every time', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', quiz: keyAlways };
    const savePlain = { title: 'Practice, as built', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', quiz: keyPlain };
    await request(http).patch(`${tasksAt}/practice-always`).set(bearer(teacher.token)).send(saveAlways).expect(200);
    await request(http).patch(`${tasksAt}/practice-plain`).set(bearer(teacher.token)).send(savePlain).expect(200);

    // 4. the rule kept (and still absent where there was none)
    const relisted = (await request(http).get(tasksAt).set(bearer(teacher.token)).expect(200)).body;
    expect([ruleOf(relisted, 'practice-always'), ruleOf(relisted, 'practice-plain')]).toEqual(['always', null]);
    const rekeyed = (await request(http).get(`${tasksAt}/practice-always/quiz/key`).set(bearer(teacher.token)).expect(200)).body;
    expect(rekeyed.revealExplanation).toBe('always');

    // The learner's side: publish, assign, sit both papers wrong.
    const published = (
      await request(http).post(`${at}/publish`).set(bearer(teacher.token)).send({ version: '1.0.0', notes: 'Two practice quizzes.' }).expect(200)
    ).body as PublishVersionResult;
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Monday' }).expect(201);
    redactor.name(cohort.body.joinCode, 'join-code');
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'Monday practises before it writes.' })
      .expect(200);
    const learner = await account('learner', 'Ixa Pellowmere');
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).send({ code: cohort.body.joinCode }).expect(200);
    const board = (await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).send({}).expect(201)).body as EnrollmentView;
    const requirementsId = board.phases.find((one) => one.key === 'requirements')!.id;

    const always = await sitWrong(learner.token, requirementsId, 'practice-always');
    const plain = await sitWrong(learner.token, requirementsId, 'practice-plain');
    expect(always.verdict.passed).toBe(false);
    expect(plain.verdict.passed).toBe(false);
    // 'always' on a capped optional quiz: every explanation, attempts left
    expect(explanationsOf(always.verdict)).toHaveLength(5);
    expect(explanationsOf(always.verdict).every((one) => typeof one === 'string' && one.includes('Fixture explanation'))).toBe(true);
    // absent on a capped optional quiz: the default rule, none
    expect(explanationsOf(plain.verdict).every((one) => one === null)).toBe(true);
    expect(JSON.stringify(plain.verdict.report)).not.toContain('Fixture explanation');

    // 3. `passCredited` under the shared name: the teacher signs off the plain
    //    quiz the learner failed, so the row reads passed with no paper behind
    //    it. The room the learner reads says so by the shared field; the quiz
    //    no one credited carries no such key.
    await request(http)
      .post(`/api/v1/instructor/learners/${learner.id}/phases/${requirementsId}/override`)
      .set(bearer(teacher.token))
      .send({ action: 'task-signoff', taskKey: 'practice-plain', reason: 'Talked it through in the Monday session.' })
      .expect(200);
    const creditedRoom = (
      await request(http).get(`/api/v1/phases/${requirementsId}/tasks/practice-plain/quiz`).set(bearer(learner.token)).expect(200)
    ).body as QuizRoomView;
    const uncreditedRoom = (
      await request(http).get(`/api/v1/phases/${requirementsId}/tasks/practice-always/quiz`).set(bearer(learner.token)).expect(200)
    ).body as QuizRoomView;
    expect(creditedRoom.status).toBe('passed');
    expect(creditedRoom.passCredited).toBe(true);
    expect(uncreditedRoom.status).not.toBe('passed');
    expect('passCredited' in uncreditedRoom).toBe(false);

    // 4. The teacher's record of changes: the trail these routes left,
    //    as the teacher reads it, for the web to draw through AuditList.
    const trail = (await request(http).get('/api/v1/instructor/audit').set(bearer(teacher.token)).expect(200)).body as any[];
    const names = new Set(trail.map((one) => one.event));
    for (const name of ['project.create', 'project.tasks', 'project.quiz-key', 'project.publish', 'cohort.project', 'task.signoff']) {
      expect([name, names.has(name)]).toEqual([name, true]);
    }

    holdContract(
      'quiz-reveal',
      'apps/api/test/quiz-reveal-contract-wiring.e2e-spec.ts',
      {
        listed: { tasks: (listed.tasks as any[]).filter((one) => one.quiz) },
        keyAlways,
        keyPlain,
        saveAlways,
        savePlain,
        relisted: { tasks: (relisted.tasks as any[]).filter((one) => one.quiz) },
        rekeyed,
        learnerAlways: { verdict: always.verdict, room: always.room },
        learnerPlain: { verdict: plain.verdict, room: plain.room },
        learnerCredited: { room: creditedRoom, uncreditedRoom },
        teacherTrail: trail,
      },
      redactor,
    );
  }, 240000);
});
