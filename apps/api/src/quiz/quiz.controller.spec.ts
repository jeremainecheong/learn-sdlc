import 'reflect-metadata';
import { Module, UnauthorizedException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import request = require('supertest');
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { compiledQuizSnapshot, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { AssistantService } from '../assistant/assistant.service';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/auth.guards';
import { BODY_KEY_REFUSED } from '../body-keys.guard';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import { PhasesController } from '../workflow/phases.controller';
import { QuizAttemptEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import { repoToken } from '../db/inject';
import { ExecutionService } from '../execution/execution.service';
import { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from '../workflow/workflow.service';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';

/**
 * The learner's three quiz doors, over HTTP.
 *
 * The service spec holds what the answers are; this file holds the three facts
 * that only exist once a request has been through the pipeline.
 *
 * **`BodyKeysGuard` is mounted.** The hand-in body is
 * `{ answers: Record<questionId, optionId[]> }`, the free-form map shape the
 * guard exists for. Without it a body naming `__proto__` re-parents the nested
 * object and the answers **silently disappear** from what the service scores,
 * which is an unanswered sheet scored zero; one naming `constructor` 500s
 * inside class-transformer instead of refusing with a 400. Guards run ahead of
 * pipes, which is the only place in the request path where the raw parsed body
 * can still be looked at whole.
 *
 * **The seal, over the wire.** The real service and the
 * real projection answer a real request, and the assertion is over the whole
 * serialised response rather than over a field.
 *
 * **The routes are where the contract says they are**, and each one passes the caller
 * through as the authenticated user rather than as anything the body said.
 */

const LEARNER = 'u-1';
const PHASE_STATE = 'ps-1';
const QUIZ_KEY = 'design-check';
const snapshot = compiledQuizSnapshot();

const designPhase = (): PhaseContent => {
  const found = snapshot.content.phases.find((one) => one.key === 'design');
  if (!found) throw new Error('the fixture lost its written phase');
  return found;
};

const designTasks = () => {
  const found = snapshot.phases.find((one) => one.key === 'design');
  if (!found) throw new Error('the fixture lost its written phase’s tasks');
  return found.tasks;
};

const state = {
  id: PHASE_STATE,
  userId: LEARNER,
  enrollmentId: 'e-1',
  phaseKey: 'design',
};

const submit = jest.fn(async () => ({
  id: 'sub-1',
  status: 'queued',
  score: null,
  passed: null,
  report: null,
  createdAt: '2026-09-21T00:00:00.000Z',
}));

const workflow = {
  loadOwnedState: jest.fn(async () => ({
    state,
    phase: designPhase(),
    enrollment: { id: 'e-1' },
  })),
};

const content = {
  getTasksForEnrollment: jest.fn(() => designTasks()),
  resolveForEnrollment: jest.fn(() => ({ content: snapshot.content, versionId: 'pv-1' })),
};

const auth = {
  authenticate: jest.fn(async (token: string) => {
    if (token !== 'quiz-test-session') throw new UnauthorizedException();
    return { id: LEARNER, role: 'LEARNER', email: 'quiz@example.test', cohort: 'default' };
  }),
};

describe('the learner’s quiz doors', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await memoryDataSource();

    @Module({
      controllers: [QuizController],
      providers: [
        QuizService,
        { provide: WorkflowService, useValue: workflow },
        { provide: ContentService, useValue: content },
        { provide: FeedbackService, useValue: { submit } },
        {
          provide: QuizAttemptsService,
          useValue: new QuizAttemptsService(dataSource.getRepository(QuizAttemptEntity)),
        },
        {
          provide: repoToken(TaskStateEntity),
          useValue: dataSource.getRepository(TaskStateEntity),
        },
        {
          provide: repoToken(SubmissionEntity),
          useValue: dataSource.getRepository(SubmissionEntity),
        },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    })
    class QuizRoutesModule {}

    app = await NestFactory.create(QuizRoutesModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    // The deployment's own pipe, so the DTO refuses exactly what it refuses in
    // production and the guard is proven to run ahead of it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  const room = () =>
    request(app.getHttpServer())
      .get(`/api/v1/phases/${PHASE_STATE}/tasks/${QUIZ_KEY}/quiz`)
      .set('Authorization', 'Bearer quiz-test-session');

  const start = () =>
    request(app.getHttpServer())
      .post(`/api/v1/phases/${PHASE_STATE}/tasks/${QUIZ_KEY}/quiz/attempts`)
      .set('Authorization', 'Bearer quiz-test-session');

  const handIn = (attemptId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/phases/${PHASE_STATE}/tasks/${QUIZ_KEY}/quiz/attempts/${attemptId}`)
      .set('Authorization', 'Bearer quiz-test-session');

  it('requires a session on all three doors', async () => {
    expect((await request(app.getHttpServer()).get(`/api/v1/phases/${PHASE_STATE}/tasks/${QUIZ_KEY}/quiz`)).status).toBe(401);
    expect(workflow.loadOwnedState).not.toHaveBeenCalled();
  });

  it('answers the room and the paper with no key anywhere on the wire', async () => {
    const before = await room();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ taskKey: QUIZ_KEY, drawn: 3, paper: null });

    const drawn = await start();
    expect(drawn.status).toBe(200);
    const wire = JSON.stringify(drawn.body);
    expect(wire).not.toMatch(/"correct"/);
    expect(wire).not.toContain('Fixture explanation');
    expect(wire).not.toContain('fixture-concept');
    // A pool of five, a paper of three: the undrawn half is not on the wire.
    expect(fixtureQuizQuestions().filter((one) => wire.includes(one.stem))).toHaveLength(3);
    expect(drawn.body.questions).toHaveLength(3);

    // A second start is the same paper, over HTTP as well as in the service.
    const again = await start();
    expect(again.body.attemptId).toBe(drawn.body.attemptId);
  });

  // Sent as a raw string, and it has to be: `{ __proto__: … }` in a JavaScript
  // literal is the prototype setter, not an own key, so an object built here
  // would serialise to `{"answers":{}}` and the spec would pass against no
  // guard at all. `JSON.parse` on the other side keeps `__proto__` as an own
  // property, which is the whole of why this hazard exists.
  const raw = (attemptId: string, body: string) =>
    handIn(attemptId).set('Content-Type', 'application/json').send(body);

  it('refuses a body that names __proto__ before the sheet is ever read', async () => {
    const drawn = await start();
    const attemptId = drawn.body.attemptId;
    submit.mockClear();

    const refused = await raw(attemptId, '{"answers":{"__proto__":{"q1":["a"]}}}');
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe(BODY_KEY_REFUSED);
    // The failure this catches is a sheet that silently disappeared and was
    // scored as an empty paper, so the assertion is that nothing was scored.
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a body that names constructor with a 400 rather than a 500', async () => {
    const drawn = await start();
    const refused = await raw(drawn.body.attemptId, '{"answers":{"constructor":["a"]}}');
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe(BODY_KEY_REFUSED);
  });

  it('refuses a hand-in that carries no sheet at all', async () => {
    const drawn = await start();
    expect((await handIn(drawn.body.attemptId).send({})).status).toBe(400);
  });

  it('hands the sheet in and answers with the revision the room already polls', async () => {
    const drawn = await start();
    const attemptId = drawn.body.attemptId;
    const answers = Object.fromEntries(
      drawn.body.questions.map((one: { id: string; options: { id: string }[] }) => [
        one.id,
        [one.options[0].id],
      ]),
    );
    submit.mockClear();

    const handed = await handIn(attemptId).send({ answers });
    expect(handed.status).toBe(201);
    expect(handed.body).toMatchObject({ id: 'sub-1', status: 'queued' });
    expect(submit).toHaveBeenCalledWith(designPhase(), state, undefined, QUIZ_KEY, { attemptId });
  });
});

/**
 * The one thing `app.module.ts` risks: a **second** `@Controller('phases')`.
 *
 * Nest matches in declaration order and `PhasesController` is declared first,
 * so the question is whether its `:id`, `:id/submit` and
 * `:id/tasks/:taskKey/submit` swallow the quiz's four- and five-segment paths,
 * or whether the quiz's swallow theirs. Both controllers are mounted here in
 * the order the module lists them and each door is asked for by hand: the
 * assertion is which service was called, not which status came back, because a
 * shadowed route answers 200 from the wrong handler.
 */
describe('the quiz doors beside the phase doors', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const phaseDetail = jest.fn(async () => ({ id: PHASE_STATE, view: 'full' }));
  const loadOwnedState = jest.fn(async () => ({
    state,
    phase: designPhase(),
    enrollment: { id: 'e-1' },
  }));
  const roomOf = jest.fn(async () => ({ taskKey: QUIZ_KEY, paper: null }));

  beforeAll(async () => {
    dataSource = await memoryDataSource();

    @Module({
      // The order `app.module.ts` lists them in: the phase doors first.
      controllers: [PhasesController, QuizController],
      providers: [
        { provide: QuizService, useValue: { room: roomOf } },
        { provide: WorkflowService, useValue: { phaseDetail, loadOwnedState } },
        { provide: ContentService, useValue: content },
        { provide: FeedbackService, useValue: { submit } },
        { provide: ExecutionService, useValue: {} },
        { provide: AssistantService, useValue: {} },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    })
    class BothModule {}

    app = await NestFactory.create(BothModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  const as = (call: request.Test) => call.set('Authorization', 'Bearer quiz-test-session');

  beforeEach(() => jest.clearAllMocks());

  it('sends the quiz room to the quiz controller and not to the phase detail', async () => {
    const answered = await as(
      request(app.getHttpServer()).get(`/api/v1/phases/${PHASE_STATE}/tasks/${QUIZ_KEY}/quiz`),
    );
    expect(answered.status).toBe(200);
    expect(roomOf).toHaveBeenCalledTimes(1);
    expect(phaseDetail).not.toHaveBeenCalled();
  });

  it('leaves the phase’s own doors exactly where they were', async () => {
    expect((await as(request(app.getHttpServer()).get(`/api/v1/phases/${PHASE_STATE}`))).status).toBe(200);
    expect(phaseDetail).toHaveBeenCalledTimes(1);
    expect(roomOf).not.toHaveBeenCalled();

    // The per-task submit shares four segments with the quiz routes and
    // differs only in its last: it must still reach the grader.
    const submitted = await as(
      request(app.getHttpServer()).post(`/api/v1/phases/${PHASE_STATE}/tasks/main/submit`),
    ).send({});
    expect(submitted.status).toBe(201);
    expect(submit).toHaveBeenCalledWith(designPhase(), state, undefined, 'main');
  });
});
