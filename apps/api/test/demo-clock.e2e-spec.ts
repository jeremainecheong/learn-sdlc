import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { disengage } from '../src/demo/demo-clock';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * `GET` and `POST /api/v1/demo/clock` through the Nest container.
 *
 * The clock's own behaviour is in `src/demo/demo-clock.spec.ts`; what is
 * asserted here is the wiring nothing else covers: that a deployment which
 * did not ask for the clock answers 404 rather than 403 (a production API must
 * not admit the route exists), that a learner gets the same 404 rather than a 403 that admits the route exists, and
 * that a move actually lands on the rows the API writes afterwards, which is
 * the whole reason the subscriber is registered from `DemoService`.
 */
describe('Demo clock (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let adminToken = '';
  let learnerToken = '';

  const account = async (name: string, role: 'LEARNER' | 'ADMIN') => {
    const email = `${name}-${stamp}@demo-clock.test`;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, email, token: registered.body.token as string };
  };

  const boot = async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));
    db = app.get(DataSource);
    adminToken = (await account('admin', 'ADMIN')).token;
    learnerToken = (await account('learner', 'LEARNER')).token;
  };

  afterEach(async () => {
    disengage();
    if (app) await app.close();
    delete process.env.DEMO_CLOCK;
  });

  it('answers 404 on a deployment that did not ask for the clock', async () => {
    delete process.env.DEMO_CLOCK;
    await boot();

    await request(http).get('/api/v1/demo/clock').set(bearer(adminToken)).expect(404);
    await request(http)
      .post('/api/v1/demo/clock')
      .set(bearer(adminToken))
      .send({ advanceMs: 1000 })
      .expect(404);
  });

  describe('with DEMO_CLOCK=true', () => {
    beforeEach(async () => {
      process.env.DEMO_CLOCK = 'true';
      await boot();
    });

    it('answers a learner with the same 404 an unmatched route gets, never a 403', async () => {
      // A 403 "insufficient role" told every signed-in learner on every build
      // that this API has a demo clock; the route exists only to an admin.
      await request(http).get('/api/v1/demo/clock').set(bearer(learnerToken)).expect(404);
      await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(learnerToken))
        .send({ advanceMs: 1000 })
        .expect(404);
      await request(http).get('/api/v1/demo/clock').expect(401);
    });

    it('reports a clock that has not been moved', async () => {
      const { body } = await request(http)
        .get('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .expect(200);
      expect(body.engaged).toBe(false);
      expect(body.offsetMs).toBe(0);
      expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(5000);
    });

    it('moves to an instant, and the next row the API writes lands on it', async () => {
      const at = new Date(Date.now() - 35 * 86_400_000).toISOString();
      const moved = await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .send({ at })
        .expect(200);
      expect(moved.body.engaged).toBe(true);
      expect(Math.abs(Date.parse(moved.body.now) - Date.parse(at))).toBeLessThan(5000);

      // A row written by an ordinary route, not by the test: this is the
      // subscriber DemoService registered, doing the half of the job the
      // patched Date cannot reach.
      const registered = await request(http)
        .post('/api/v1/auth/register')
        .send({
          email: `back-dated-${stamp}@demo-clock.test`,
          password: PASSWORD,
          displayName: 'Back dated',
        })
        .expect(201);
      const row = await db.manager.findOneByOrFail(UserEntity, { id: registered.body.user.id });
      const raw = row.createdAt as unknown;
      const createdAt = raw instanceof Date ? raw : new Date(`${String(raw).replace(' ', 'T')}Z`);
      expect(Math.abs(createdAt.getTime() - Date.parse(at))).toBeLessThan(60_000);
    });

    it('walks forward on a span and comes back on release', async () => {
      await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .send({ at: new Date(Date.now() - 10 * 86_400_000).toISOString() })
        .expect(200);
      const stepped = await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .send({ advanceMs: 2 * 86_400_000 })
        .expect(200);
      expect(stepped.body.offsetMs).toBeGreaterThan(-9 * 86_400_000);
      expect(stepped.body.offsetMs).toBeLessThan(-7 * 86_400_000);

      const released = await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .send({ release: true })
        .expect(200);
      expect(released.body.engaged).toBe(false);
      expect(released.body.offsetMs).toBe(0);
    });

    it('refuses a body that means two things at once, and a negative span', async () => {
      await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .send({ at: new Date().toISOString(), advanceMs: 1000 })
        .expect(400);
      await request(http)
        .post('/api/v1/demo/clock')
        .set(bearer(adminToken))
        .send({ advanceMs: -1000 })
        .expect(400);
      await request(http).post('/api/v1/demo/clock').set(bearer(adminToken)).send({}).expect(400);
    });
  });
});
