import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { AuditEventEntity, CohortEntity, UserEntity } from '../src/db/entities';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * `PATCH /admin/cohorts/:id/owner` over HTTP: an admin hands a class to a new
 * owner.
 *
 * The service's own rules are in `admin.service.spec.ts`; what is asserted
 * here is the wiring nothing else covers: that the route is on the admin
 * controller and so behind its `@Roles('ADMIN')` guard, that its DTO rejects a
 * body with no owner in it, and that an instructor blocked from deleting their
 * account can delete it once an admin has run this.
 */
describe('Admin cohort owner (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let adminToken = '';
  let leavingToken = '';
  let leavingId = '';
  let leavingEmail = '';
  let arrivingId = '';
  let learnerId = '';
  let cohortId = '';

  /** Registers an account and then puts the role the guard reads on its row. */
  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN') => {
    const email = `${name}-${stamp}@cohort-owner.test`;
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
    return { id, email, token: registered.body.token as string };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));
    db = app.get(DataSource);

    adminToken = (await account('admin', 'ADMIN')).token;
    const leaving = await account('leaving', 'INSTRUCTOR');
    leavingToken = leaving.token;
    leavingId = leaving.id;
    leavingEmail = leaving.email;
    arrivingId = (await account('arriving', 'INSTRUCTOR')).id;
    learnerId = (await account('learner', 'LEARNER')).id;

    const created = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(leavingToken))
      .send({ name: 'Tuesday class' })
      .expect(201);
    cohortId = created.body.id;
    await db.manager.update(UserEntity, { id: learnerId }, { cohort: cohortId });
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses the route without a session, and to an instructor', async () => {
    const path = `/api/v1/admin/cohorts/${cohortId}/owner`;
    await request(http).patch(path).send({ ownerUserId: arrivingId }).expect(401);
    await request(http)
      .patch(path)
      .set(bearer(leavingToken))
      .send({ ownerUserId: arrivingId })
      .expect(403);
  });

  it('refuses a body with no owner in it', async () => {
    await request(http)
      .patch(`/api/v1/admin/cohorts/${cohortId}/owner`)
      .set(bearer(adminToken))
      .send({})
      .expect(400);
  });

  it('refuses to hand the class to a learner', async () => {
    const res = await request(http)
      .patch(`/api/v1/admin/cohorts/${cohortId}/owner`)
      .set(bearer(adminToken))
      .send({ ownerUserId: learnerId })
      .expect(400);
    expect(String(res.body.message)).toContain('instructor');
  });

  it('will not let the owner delete an account while the class has learners in it', async () => {
    const res = await request(http)
      .delete('/api/v1/account')
      .set(bearer(leavingToken))
      .send({ email: leavingEmail })
      .expect(400);
    expect(String(res.body.message)).toContain('Tuesday class, which has 1 learner in it');
    expect(await db.manager.count(UserEntity, { where: { id: leavingId } })).toBe(1);
  });

  it('moves the class, and then the account can go', async () => {
    const moved = await request(http)
      .patch(`/api/v1/admin/cohorts/${cohortId}/owner`)
      .set(bearer(adminToken))
      .send({ ownerUserId: arrivingId })
      .expect(200);
    expect(moved.body).toMatchObject({
      id: cohortId,
      name: 'Tuesday class',
      ownerUserId: arrivingId,
      memberCount: 1,
    });

    await request(http)
      .delete('/api/v1/account')
      .set(bearer(leavingToken))
      .send({ email: leavingEmail })
      .expect(200);

    // The class, its code and its learner outlive the account that made it.
    const cohort = await db.manager.findOneByOrFail(CohortEntity, { id: cohortId });
    expect(cohort.ownerUserId).toBe(arrivingId);
    expect((await db.manager.findOneByOrFail(UserEntity, { id: learnerId })).cohort).toBe(cohortId);

    // And the trail kept both halves: the move, and a deletion naming nobody.
    const rows = await db.manager.find(AuditEventEntity, {});
    expect(rows.some((row) => row.event === 'admin.cohort.owner' && row.targetId === cohortId)).toBe(
      true,
    );
    const deletion = rows.find((row) => row.event === 'account.delete');
    expect(deletion).toBeDefined();
    expect(deletion!.subjectUserId).toBeNull();
  });
});
