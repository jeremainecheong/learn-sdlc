import { OpenAiProvider } from '../src/assistant/openai.provider';
import { mockAiForRoutes } from './mock-ai';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { FeedbackReport, TestCaseResult } from '@learnsdlc/shared';
import { PhaseStateEntity, SubmissionEntity, UserEntity } from '../src/db/entities';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * "Explain this failing test" end to end.
 *
 * The point of the route is that it is a mentor turn and nothing else: it goes
 * through the same ownership check, the same rate limit, the same usage ledger
 * and the same transcript as a question the learner typed. So this file drives
 * it against the real container with an explicit AI test double, so nothing
 * here says how a real model answers.
 *
 * The failing verdict is written straight into the database rather than
 * produced by a sandbox run: this is a test about the mentor route, and a real
 * pytest run of the implementation phase would make it a test about the
 * sandbox instead.
 */
describe('Explain this failing test (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;

  let learnerToken = '';
  let learnerId = '';
  let strangerToken = '';
  let implementationId = '';

  const asLearner = () => ({ authorization: `Bearer ${learnerToken}` });
  const asStranger = () => ({ authorization: `Bearer ${strangerToken}` });

  const failingCase: TestCaseResult = {
    name: 'test_overdue_excludes_today',
    status: 'failed',
    hidden: true,
    message: 'AssertionError: assert 2 == 1',
    frames: [{ path: 'api/repository/tasks.py', line: 56 }],
  };

  const report = {
    overall: 41,
    passed: false,
    passThreshold: 70,
    criteria: [],
    checks: [],
    tests: { total: 1, passed: 0, failed: 1, errored: 0, cases: [failingCase] },
    aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'local-mentor' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: {
      relianceFlag: false,
      relianceIndex: 0,
      mentorPasteFlag: false,
      noEffortFlag: false,
      note: '',
    },
  } as unknown as FeedbackReport;

  const enrol = async (email: string, displayName: string) => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName })
      .expect(201);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set({ authorization: `Bearer ${registered.body.token}` })
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    return {
      token: registered.body.token as string,
      userId: registered.body.user.id as string,
      phases: Object.fromEntries(
        enrolled.body.phases.map((p: any) => [p.key, p.id]),
      ) as Record<string, string>,
    };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], pipeline: 'prefix' }));
    dataSource = app.get(DataSource);

    const lee = await enrol('explain-lee@learnsdlc.test', 'Lee');
    learnerToken = lee.token;
    learnerId = lee.userId;
    implementationId = lee.phases.implementation;

    const bo = await enrol('explain-bo@learnsdlc.test', 'Bo');
    strangerToken = bo.token;

    // The learner is three phases in: the workspace they are asking about is
    // open, and it holds a verdict with a case that did not pass.
    await dataSource
      .getRepository(PhaseStateEntity)
      .update(implementationId, { status: 'in_progress', attempts: 1 });
    await dataSource.getRepository(SubmissionEntity).save(
      dataSource.getRepository(SubmissionEntity).create({
        phaseStateId: implementationId,
        userId: learnerId,
        status: 'completed',
        score: 41,
        passed: false,
        report,
      }),
    );
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  it('answers, and the turn is in the history', async () => {
    const res = await request(http)
      .post(`/api/v1/phases/${implementationId}/explain-test`)
      .set(asLearner())
      .send({ testName: 'test_overdue_excludes_today', source: 'submission' })
      .expect(200);

    expect(res.body.question).toBe('Why does test_overdue_excludes_today fail?');
    expect(res.body.subject).toMatchObject({
      testName: 'test_overdue_excludes_today',
      hidden: true,
      assertion: 'AssertionError: assert 2 == 1',
      where: 'api/repository/tasks.py, line 56',
    });
    expect(res.body.reply.role).toBe('assistant');
    expect(res.body.reply.meta.provider).toBe('mock-ai');
    expect(res.body.reply.content).toContain('?');
    expect(res.body.usage).not.toHaveProperty('dailyBudget');
    // Nothing of the sealed suite reaches the learner, whichever mentor answered.
    expect(res.body.reply.content).not.toContain('def test_');

    const history = await request(http)
      .get(`/api/v1/assistant/history/${implementationId}`)
      .set(asLearner())
      .expect(200);
    const roles = history.body.map((m: any) => m.role);
    expect(roles.slice(-2)).toEqual(['user', 'assistant']);
    expect(history.body[history.body.length - 2].content).toBe(
      'Why does test_overdue_excludes_today fail?',
    );
  });

  it('refuses a case that is not in that result', async () => {
    await request(http)
      .post(`/api/v1/phases/${implementationId}/explain-test`)
      .set(asLearner())
      .send({ testName: 'test_that_never_ran', source: 'submission' })
      .expect(404);
  });

  it('refuses a body that names no source', async () => {
    await request(http)
      .post(`/api/v1/phases/${implementationId}/explain-test`)
      .set(asLearner())
      .send({ testName: 'test_overdue_excludes_today', source: 'guesswork' })
      .expect(400);
  });

  it('another learner cannot explain a test in my phase', async () => {
    await request(http)
      .post(`/api/v1/phases/${implementationId}/explain-test`)
      .set(asStranger())
      .send({ testName: 'test_overdue_excludes_today', source: 'submission' })
      .expect(403);
  });

  it('explains a saved failure even when a legacy user quota is zero', async () => {
    const budgeted = await enrol('explain-kim@learnsdlc.test', 'Kim');
    await dataSource
      .getRepository(PhaseStateEntity)
      .update(budgeted.phases.implementation, { status: 'in_progress', attempts: 1 });
    await dataSource.getRepository(SubmissionEntity).save(
      dataSource.getRepository(SubmissionEntity).create({
        phaseStateId: budgeted.phases.implementation,
        userId: budgeted.userId,
        status: 'completed',
        score: 41,
        passed: false,
        report,
      }),
    );
    // Old account settings cannot disable a new explanation.
    await dataSource.getRepository(UserEntity).update(budgeted.userId, { dailyTokenBudget: 0 });

    const res = await request(http)
      .post(`/api/v1/phases/${budgeted.phases.implementation}/explain-test`)
      .set({ authorization: `Bearer ${budgeted.token}` })
      .send({ testName: 'test_overdue_excludes_today', source: 'submission' })
      .expect(200);

    expect(res.body.reply.meta.budgetExceeded).toBeUndefined();
    expect(res.body.reply.meta.provider).toBe('mock-ai');
    expect(res.body.reply.content).toContain('?');
    expect(res.body.usage).not.toHaveProperty('dailyBudget');
  });

  it('the eleventh explanation in a minute is refused', async () => {
    const spammer = await enrol('explain-max@learnsdlc.test', 'Max');
    await dataSource
      .getRepository(PhaseStateEntity)
      .update(spammer.phases.implementation, { status: 'in_progress', attempts: 1 });
    await dataSource.getRepository(SubmissionEntity).save(
      dataSource.getRepository(SubmissionEntity).create({
        phaseStateId: spammer.phases.implementation,
        userId: spammer.userId,
        status: 'completed',
        score: 41,
        passed: false,
        report,
      }),
    );

    const press = () =>
      request(http)
        .post(`/api/v1/phases/${spammer.phases.implementation}/explain-test`)
        .set({ authorization: `Bearer ${spammer.token}` })
        .send({ testName: 'test_overdue_excludes_today', source: 'submission' });

    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await press()).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  }, 60000);
});
