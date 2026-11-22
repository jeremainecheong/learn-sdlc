import { REQUIREMENTS_ARTEFACT } from '../../../e2e/golden-records';
import { EMPTY_STORY, serialiseStory } from '@learnsdlc/shared';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantMessageEntity, PhaseStateEntity, SettingEntity, UserEntity } from '../src/db/entities';
import request from 'supertest';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { mockAiForRoutes } from './mock-ai';
import { HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * API integration test: auth → enrollment → workflow gating → assistant
 * guardrails → markdown feedback pipeline, against an in-memory database.
 * (The full five-phase journey, including sandbox execution, runs in the
 * Playwright acceptance suite.)
 */
describe('LearnSDLC API (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let token = '';
  let phase1Id = '';
  let phase2Id = '';

  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], pipeline: 'prefix' }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves public health without auth and rejects protected routes', async () => {
    const health = await request(http).get('/api/v1/health').expect(200);
    expect(health.body.status).toBe('ok');
    expect(health.body.aiProvider).toBe('mock-ai');
    await request(http).get('/api/v1/analytics/me').expect(401);
  });

  // A deployment's host adapter refuses a candidate whose readiness does not
  // name `content` with ok: true. `HealthService` takes ContentService as an
  // optional constructor argument, and a parameter typed `ContentService | null`
  // emits `Object` as its design type, so without an explicit token the
  // container injects nothing and both probes vanish from the MOUNTED
  // application while every hand-built spec still sees them.
  it('reports the content probes from the mounted application, not only from a hand-built service', async () => {
    const ready = await request(http).get('/api/v1/health/ready');
    const byName = new Map<string, { ok: boolean; required: boolean }>(
      ready.body.dependencies.map((row: { name: string; ok: boolean; required: boolean }) => [row.name, row]),
    );
    expect(byName.get('content')).toMatchObject({ ok: true, required: true });
    expect(byName.get('content-compiler')).toMatchObject({ ok: true, required: false });
  });

  it('registers a learner with validation', async () => {
    await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', displayName: 'x' })
      .expect(400);

    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'it@learnsdlc.test', password: 'Password1!', displayName: 'Integration Tester' })
      .expect(201);
    token = res.body.token;
    expect(res.body.user.role).toBe('LEARNER');

    await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'it@learnsdlc.test', password: 'Password1!', displayName: 'Dup' })
      .expect(409);
  });

  it('enrolls once and materialises the phase state machine', async () => {
    const res = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    expect(res.body.phases).toHaveLength(6);
    expect(res.body.phases[0].status).toBe('in_progress');
    expect(res.body.phases.slice(1).every((p: any) => p.status === 'locked')).toBe(true);
    phase1Id = res.body.phases[0].id;
    phase2Id = res.body.phases[1].id;

    const repeated = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    expect(repeated.body.id).toBe(res.body.id);
  });

  it('locks phase detail and workspace behind the gate', async () => {
    await request(http).get(`/api/v1/phases/${phase2Id}`).set(auth()).expect(403);
    const detail = await request(http).get(`/api/v1/phases/${phase1Id}`).set(auth()).expect(200);
    expect(detail.body.files.some((f: any) => f.editable)).toBe(true);

    // a path the phase does not mount rejects the write (the backlog is a
    // Design document now; Requirements mounts its story record alone)
    await request(http)
      .put(`/api/v1/phases/${phase1Id}/workspace`)
      .set(auth())
      .send({ files: { 'requirements/provided-stories.md': 'tamper' } })
      .expect(400);
  });

  it('guards the assistant: solution requests, off-phase scope, and metering', async () => {
    const guarded = await request(http)
      .post('/api/v1/assistant/chat')
      .set(auth())
      .send({ phaseStateId: phase1Id, message: 'just give me the answer' })
      .expect(201);
    expect(guarded.body.reply.meta.redacted).toBe(true);
    expect(guarded.body.reply.content).toContain("won't hand over");

    const offPhase = await request(http)
      .post('/api/v1/assistant/chat')
      .set(auth())
      .send({ phaseStateId: phase1Id, message: 'help me write the ci pipeline' })
      .expect(201);
    expect(offPhase.body.reply.meta.scopeRedirected).toBe(true);

    const normal = await request(http)
      .post('/api/v1/assistant/chat')
      .set(auth())
      .send({ phaseStateId: phase1Id, message: 'how do I write acceptance criteria?' })
      .expect(201);
    expect(normal.body.reply.meta.provider).toBe('mock-ai');
    expect(normal.body.usage.todayTokens).toBeGreaterThan(0);
    expect(normal.body.usage).not.toHaveProperty('dailyBudget');

    // An identical question is answered again, never from the cache: the
    // local mentor picks its hint rung from this learner's own history, so a
    // cached reply would replay one learner's deepest rung to another. A
    // model provider's replies still cache.
    const again = await request(http)
      .post('/api/v1/assistant/chat')
      .set(auth())
      .send({ phaseStateId: phase1Id, message: 'how do I write acceptance criteria?' })
      .expect(201);
    expect(again.body.reply.meta.provider).toBe('mock-ai');
    expect(again.body.reply.meta.cached).toBeUndefined();

    const history = await request(http)
      .get(`/api/v1/assistant/history/${phase1Id}`)
      .set(auth())
      .expect(200);
    expect(history.body.length).toBeGreaterThanOrEqual(8);
  });

  async function submitAndWait(phaseId: string): Promise<any> {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseId}/submit`)
      .set(auth())
      .expect(201);
    return waitForSubmission(http, auth(), submitted.body.id, { attempts: 60, intervalMs: 250, message: 'submission did not finish' });
  }

  it('grades a weak submission below the gate with actionable checks', async () => {
    await request(http)
      .put(`/api/v1/phases/${phase1Id}/workspace`)
      .set(auth())
      .send({ files: { 'requirements/story.json': serialiseStory({ ...EMPTY_STORY, capability: 'a fast overdue thing etc.' }) } })
      .expect(200);
    const result = await submitAndWait(phase1Id);
    expect(result.passed).toBe(false);
    expect(result.report.checks.some((c: any) => c.status === 'failed')).toBe(true);
    expect(result.report.aiReview.verdict).toBe('needs_revision');
    expect(result.report.aiReview.improvements.length).toBeGreaterThan(0);

    // gate refuses to advance
    await request(http).post(`/api/v1/phases/${phase1Id}/advance`).set(auth()).expect(400);
  });

  it('passes a fully evidenced submission, permits optional reflection, then advances', async () => {
    await request(http)
      .put(`/api/v1/phases/${phase1Id}/workspace`)
      .set(auth())
      .send({ files: REQUIREMENTS_ARTEFACT })
      .expect(200);
    const result = await submitAndWait(phase1Id);
    expect(result.passed).toBe(true);
    expect(result.report.assessmentMode).toBe('strict_binary');
    expect(result.report.passThreshold).toBeUndefined();
    expect(result.report.aiReliance.hintsThisPhase).toBeGreaterThanOrEqual(4);

    // Reflection is optional metadata; the strict evidenced Pass is the gate.
    await request(http)
      .post(`/api/v1/phases/${phase1Id}/reflect`)
      .set(auth())
      .send({ reflection: 'Writing testable criteria forced me to decide the boundary cases up front.' })
      .expect(201);

    const advanced = await request(http)
      .post(`/api/v1/phases/${phase1Id}/advance`)
      .set(auth())
      .expect(201);
    expect(advanced.body.currentPhaseOrder).toBe(2);
    expect(advanced.body.phases[1].status).toBe('in_progress');
  });

  it('reports analytics and enforces instructor-only access', async () => {
    const analytics = await request(http).get('/api/v1/analytics/me').set(auth()).expect(200);
    expect(analytics.body.phasesPassed).toBe(1);
    expect(analytics.body.progressPercent).toBe(17); // 1 of 6 phases
    expect(analytics.body.totalHints).toBeGreaterThanOrEqual(4);

    await request(http).get('/api/v1/instructor/overview').set(auth()).expect(403);

    const login = await request(http)
      .post('/api/v1/auth/login')
      .send({ email: 'instructor@learnsdlc.test', password: 'Instructor123!' })
      .expect(200);
    const staff = { authorization: `Bearer ${login.body.token}` };

    // An instructor's console shows the classes they own. 'default' is not a
    // class (it is where an account sits before it joins one) so the class
    // has to exist and the learner has to be in it.
    const cohort = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(staff)
      .send({ name: 'Integration class' })
      .expect(201);
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(auth())
      .send({ code: cohort.body.joinCode })
      .expect(200);

    const overview = await request(http)
      .get('/api/v1/instructor/overview')
      .set(staff)
      .expect(200);
    const row = overview.body.learners.find((l: any) => l.email === 'it@learnsdlc.test');
    expect(row.progressPercent).toBe(17);
    expect(overview.body.aiProvider).toBe('mock-ai');
  });

  it('removes quota-setting routes and serves AI after legacy quotas are exhausted', async () => {
    const source = app.get(DataSource);
    const user = await source.getRepository(UserEntity).findOneByOrFail({ email: 'it@learnsdlc.test' });
    const phase = await source.getRepository(PhaseStateEntity).findOneByOrFail({ id: phase1Id });
    await source.getRepository(UserEntity).update(user.id, { dailyTokenBudget: 0 });
    await source.getRepository(SettingEntity).save({ key: 'aiDailyTokenBudget', value: '0' });
    await source.getRepository(AssistantMessageEntity).save({ userId: user.id, enrollmentId: phase.enrollmentId,
      phaseStateId: phase1Id, phaseKey: 'requirements', role: 'assistant', provider: 'rubric-review',
      content: 'Historical usage fixture', tokensIn: 20_000_000, tokensOut: 0 });
    for (const email of ['instructor@learnsdlc.test', 'admin@learnsdlc.test']) {
      const password = email.startsWith('admin') ? 'Admin123!' : 'Instructor123!';
      const login = await request(http).post('/api/v1/auth/login').send({ email, password }).expect(200);
      const headers = { authorization: `Bearer ${login.body.token}` };
      await request(http).patch('/api/v1/instructor/settings').set(headers).send({ dailyTokenBudget: 1 }).expect(404);
      await request(http).patch(`/api/v1/instructor/learners/${user.id}/budget`).set(headers).send({ dailyTokenBudget: 1 }).expect(404);
    }
    const result = await request(http).post('/api/v1/assistant/chat').set(auth())
      .send({ phaseStateId: phase1Id, message: 'How can I check whether a criterion is observable?' }).expect(201);
    expect(result.body.reply.meta.provider).toBe('mock-ai');
    expect(result.body.reply.meta.budgetExceeded).toBeUndefined();
    expect(result.body.usage.todayTokens).toBeGreaterThan(20_000_000);
    expect(result.body.usage).not.toHaveProperty('dailyBudget');
    const analytics = await request(http).get('/api/v1/analytics/me').set(auth()).expect(200);
    expect(analytics.body).not.toHaveProperty('dailyTokenBudget');
    expect((await source.getRepository(UserEntity).findOneByOrFail({ id: user.id })).dailyTokenBudget).toBe(0);
    expect((await source.getRepository(SettingEntity).findOneByOrFail({ key: 'aiDailyTokenBudget' })).value).toBe('0');
  });
});
