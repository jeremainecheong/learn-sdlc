import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { EMPTY_STORY, serialiseStory } from '@learnsdlc/shared';
import { AuthService } from '../src/auth/auth.service';
import { AuditEventEntity, SubmissionEntity, UserEntity } from '../src/db/entities';
import { JobsService } from '../src/jobs/jobs.service';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * Regrade a phase across a class, over HTTP.
 *
 * The service's own rules are in `regrade.service.spec.ts`. What is asserted
 * here is everything the unit spec cannot see: that the three routes are on
 * the instructor controller and so behind its role guard, that the DTO refuses
 * a reason too short to be one, that a batch enqueued through the real queue
 * runs to `finished`, and (the point of the whole feature) that two learners
 * in the class each end up with a second revision and a row in the trail while
 * a learner in another class is not touched at all.
 */
describe('Regrade (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  let jobs: JobsService;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  const REASON = 'The hidden boundary test was wrong; fixed on disk.';

  let instructorToken = '';
  let outsiderToken = '';
  let adaToken = '';
  let adaId = '';
  let graceId = '';
  let alanId = '';
  let adaPhaseId = '';
  let alanPhaseId = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const email = `${name}-${stamp}@regrade.test`;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      // The guard caches the row for a minute; drop it so the promotion is
      // live on the token already in hand.
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  /** Enrol on tasktrackr, submit the first phase, and wait for its verdict. */
  const submitFirstPhase = async (token: string): Promise<string> => {
    const enrollment = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(token))
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    const phaseId = enrollment.body.phases.find((phase: any) => phase.order === 1).id as string;
    await request(http)
      .put(`/api/v1/phases/${phaseId}/workspace`)
      .set(bearer(token))
      .send({
        files: {
          'requirements/story.json': serialiseStory({
            ...EMPTY_STORY,
            title: 'Add a task',
            persona: 'user',
            capability: 'to add a task',
            benefit: 'I can track it',
            criteria: [{ id: 'AC-1', given: 'an empty list', when: 'I add "buy milk"', then: 'it appears', tag: 'happy' }],
          }),
        },
      })
      .expect(200);
    await request(http).post(`/api/v1/phases/${phaseId}/submit`).set(bearer(token)).expect(201);
    await jobs.onIdle();
    return phaseId;
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix', excludeFromPrefix: ['metrics'] }));
    db = app.get(DataSource);
    jobs = app.get(JobsService);

    const instructor = await account('dana', 'INSTRUCTOR');
    instructorToken = instructor.token;
    outsiderToken = (await account('sam', 'INSTRUCTOR')).token;

    const created = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(instructorToken))
      .send({ name: 'Tuesday class' })
      .expect(201);
    // Creating a class moves the creator into it, and the guard is holding the
    // row from before that; the batch is filed under the caller's class.
    app.get(AuthService).forgetSession(instructor.id);

    const ada = await account('ada');
    const grace = await account('grace');
    const alan = await account('alan');
    adaToken = ada.token;
    adaId = ada.id;
    graceId = grace.id;
    alanId = alan.id;
    await db.manager.update(UserEntity, { id: In([ada.id, grace.id]) }, { cohort: created.body.id });

    adaPhaseId = await submitFirstPhase(ada.token);
    await submitFirstPhase(grace.token);
    alanPhaseId = await submitFirstPhase(alan.token);

    // Every verdict above came from the pack that is on disk, which is the
    // point of `stale-pack`, so the fix being simulated here is one that did
    // not bump the version, and `everyone` is the scope for that.
    const graded = await db.manager.count(SubmissionEntity, { where: { status: 'completed' } });
    expect(graded).toBe(3);
  });

  afterAll(async () => {
    await app.close();
  });

  const dto = (over: Record<string, unknown> = {}) => ({
    projectSlug: 'tasktrackr',
    phaseKey: 'requirements',
    scope: 'everyone',
    reason: REASON,
    ...over,
  });

  it('refuses the routes without a session and to a learner', async () => {
    await request(http).post('/api/v1/instructor/regrades').send(dto()).expect(401);
    await request(http)
      .post('/api/v1/instructor/regrades')
      .set(bearer(adaToken))
      .send(dto())
      .expect(403);
    await request(http)
      .get('/api/v1/instructor/regrades/00000000-0000-4000-8000-000000000000')
      .set(bearer(adaToken))
      .expect(403);
  });

  it('refuses a reason too short to act on, and a phase the pack does not have', async () => {
    await request(http)
      .post('/api/v1/instructor/regrades')
      .set(bearer(instructorToken))
      .send(dto({ reason: 'oops' }))
      .expect(400);
    await request(http)
      .post('/api/v1/instructor/regrades')
      .set(bearer(instructorToken))
      .send(dto({ phaseKey: 'archaeology' }))
      .expect(400);
  });

  it('previews the class without writing anything', async () => {
    const before = await db.manager.count(SubmissionEntity);
    const preview = await request(http)
      .post('/api/v1/instructor/regrades/preview')
      .set(bearer(instructorToken))
      .send(dto())
      .expect(200);
    expect(preview.body.id).toBe('');
    expect(preview.body.requested).toBe(2);
    expect(preview.body.candidates.map((row: any) => row.userId).sort()).toEqual(
      [adaId, graceId].sort(),
    );
    expect(preview.body.candidates.every((row: any) => row.attempt === 1)).toBe(true);
    expect(await db.manager.count(SubmissionEntity)).toBe(before);
    expect(
      await db.manager.count(AuditEventEntity, { where: { event: 'regrade.start' } }),
    ).toBe(0);
  });

  it('regrades both learners in the class and leaves the other class alone', async () => {
    const started = await request(http)
      .post('/api/v1/instructor/regrades')
      .set(bearer(instructorToken))
      .send(dto())
      .expect(201);
    expect(started.body).toMatchObject({ status: 'running', requested: 2, done: 0, failed: 0 });

    await jobs.onIdle();
    const finished = await request(http)
      .get(`/api/v1/instructor/regrades/${started.body.id}`)
      .set(bearer(instructorToken))
      .expect(200);
    expect(finished.body).toMatchObject({ status: 'finished', requested: 2, done: 2, failed: 0 });
    expect(finished.body.finishedAt).toEqual(expect.any(String));

    for (const [userId, phaseId] of [
      [adaId, adaPhaseId],
      [graceId, null],
    ] as const) {
      const rows = await db.manager.find(SubmissionEntity, { where: { userId } });
      expect(rows).toHaveLength(2);
      const fresh = rows.find((row) => row.regradeOf);
      expect(fresh).toBeTruthy();
      expect(fresh!.regradeBatchId).toBe(started.body.id);
      expect(fresh!.status).toBe('completed');
      // the old verdict is still there, untouched, which is what an appeal reads
      expect(rows.some((row) => !row.regradeOf && row.status === 'completed')).toBe(true);
      if (phaseId) {
        const list = await request(http)
          .get(`/api/v1/phases/${phaseId}/submissions`)
          .set(bearer(adaToken))
          .expect(200);
        expect(list.body).toHaveLength(2);
      }
    }

    const trail = await db.manager.find(AuditEventEntity, { where: { event: 'phase.regrade' } });
    expect(trail.map((row) => row.subjectUserId).sort()).toEqual([adaId, graceId].sort());
    expect(trail.every((row) => row.reason === REASON)).toBe(true);

    // and the learner in nobody's class has exactly the one attempt he made
    const theirs = await db.manager.find(SubmissionEntity, { where: { userId: alanId } });
    expect(theirs).toHaveLength(1);
    expect(theirs[0].regradeOf).toBeNull();
    expect(alanPhaseId).toBeTruthy();
  });

  it("refuses a second instructor the batch, and the class's learners", async () => {
    const [batch] = await db.manager.query(`SELECT id FROM regrade_batches LIMIT 1`);
    await request(http)
      .get(`/api/v1/instructor/regrades/${batch.id}`)
      .set(bearer(outsiderToken))
      .expect(404);
    const preview = await request(http)
      .post('/api/v1/instructor/regrades/preview')
      .set(bearer(outsiderToken))
      .send(dto())
      .expect(200);
    expect(preview.body.requested).toBe(0);
    expect(preview.body.candidates).toEqual([]);
  });
});
