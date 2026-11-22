import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { InstructorLearnerDetail } from '@learnsdlc/shared';
import { AuthService } from '../src/auth/auth.service';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The teacher home's read of a whole class, over HTTP.
 *
 * One `GET /instructor/learners/:userId` per learner, against the instructor
 * controller's 60-a-minute limit, would keep a class of more than about sixty
 * from loading its own home page, so `GET /instructor/learners` answers the
 * same details for a page of the class in one request. What this file holds that the unit spec cannot see: the
 * route is on the instructor controller and behind its role guard, the query
 * is held by the global pipe, `learners` does not shadow `learners/:userId`
 * (nor the other way round), each detail is byte for byte the per-learner
 * route's, another teacher's class is an empty page, and the read writes no
 * row.
 */
describe('The class read (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let danaToken = '';
  let samToken = '';
  let learnerToken = '';
  let classId = '';
  const classIds: string[] = [];

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@class-learners.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix', excludeFromPrefix: ['metrics'] }));
    db = app.get(DataSource);

    const dana = await account('dana', 'INSTRUCTOR');
    danaToken = dana.token;
    samToken = (await account('sam', 'INSTRUCTOR')).token;
    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(danaToken))
      .send({ name: 'Tuesday class' })
      .expect(201);
    classId = made.body.id;
    app.get(AuthService).forgetSession(dana.id);

    for (const name of ['ada', 'bo', 'cy']) {
      const learner = await account(name);
      learnerToken = learner.token;
      classIds.push(learner.id);
      await request(http)
        .post('/api/v1/enrollments/join')
        .set(bearer(learner.token))
        .send({ code: made.body.joinCode })
        .expect(200);
      await request(http)
        .post('/api/v1/enrollments')
        .set(bearer(learner.token))
        .send({ projectSlug: 'tasktrackr' })
        .expect(201);
    }
    classIds.sort();
    // a learner in nobody's class, which no instructor reaches
    await account('una');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("answers the teacher's class in one request, each learner exactly as the per-learner route does", async () => {
    const page = (await request(http).get('/api/v1/instructor/learners').set(bearer(danaToken)).expect(200))
      .body as InstructorLearnerDetail[];
    expect(page.map((one) => one.userId)).toEqual(classIds);
    for (const one of page) {
      const single = await request(http)
        .get(`/api/v1/instructor/learners/${one.userId}`)
        .set(bearer(danaToken))
        .expect(200);
      expect(one).toEqual(single.body);
    }
    expect(page[0].enrollments).toHaveLength(1);
    expect(page[0].cohortName).toBe('Tuesday class');

    const narrowed = await request(http)
      .get(`/api/v1/instructor/learners?cohort=${classId}`)
      .set(bearer(danaToken))
      .expect(200);
    expect(narrowed.body.map((one: InstructorLearnerDetail) => one.userId)).toEqual(classIds);
  });

  it("gives another teacher an empty page, never Dana's class, and refuses a learner at the role guard", async () => {
    expect((await request(http).get('/api/v1/instructor/learners').set(bearer(samToken)).expect(200)).body).toEqual([]);
    expect(
      (await request(http).get(`/api/v1/instructor/learners?cohort=${classId}`).set(bearer(samToken)).expect(200)).body,
    ).toEqual([]);
    // and the per-learner route agrees: a 404 for the same learner
    await request(http).get(`/api/v1/instructor/learners/${classIds[0]}`).set(bearer(samToken)).expect(404);
    await request(http).get('/api/v1/instructor/learners').set(bearer(learnerToken)).expect(403);
    await request(http).get('/api/v1/instructor/learners').expect(401);
  });

  it('is bounded and paged: a limit of at most 50, an id cursor, and the pipe refuses anything else', async () => {
    const first = await request(http).get('/api/v1/instructor/learners?limit=2').set(bearer(danaToken)).expect(200);
    expect(first.body.map((one: InstructorLearnerDetail) => one.userId)).toEqual(classIds.slice(0, 2));
    const rest = await request(http)
      .get(`/api/v1/instructor/learners?limit=2&after=${first.body[1].userId}`)
      .set(bearer(danaToken))
      .expect(200);
    expect(rest.body.map((one: InstructorLearnerDetail) => one.userId)).toEqual(classIds.slice(2));

    await request(http).get('/api/v1/instructor/learners?limit=51').set(bearer(danaToken)).expect(400);
    await request(http).get('/api/v1/instructor/learners?limit=0').set(bearer(danaToken)).expect(400);
    await request(http).get('/api/v1/instructor/learners?after=not-a-uuid').set(bearer(danaToken)).expect(400);
  });

  it('writes nothing: no audit row, no other row', async () => {
    const audits = await db.manager.count(AuditEventEntity);
    const users = await db.manager.count(UserEntity);
    await request(http).get('/api/v1/instructor/learners').set(bearer(danaToken)).expect(200);
    await request(http).get(`/api/v1/instructor/learners?cohort=${classId}`).set(bearer(danaToken)).expect(200);
    expect(await db.manager.count(AuditEventEntity)).toBe(audits);
    expect(await db.manager.count(UserEntity)).toBe(users);
  });
});
