import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TaskResetEntity, TaskStateEntity } from '../src/db/entities';
import type { UserProfile } from '@learnsdlc/shared';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The account routes over HTTP.
 *
 * `AccountService` has a thorough spec, but nothing had ever driven these
 * routes: not the pipe that decides which names are legal, not the guard that
 * scopes them to the caller, and not the confirmation that stands between a
 * mis-click and a term of work. This is the layer where "there is no path
 * parameter, so there is no shape of request that can name someone else's
 * account" is either true or a comment.
 */
describe('Account routes (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const OWNER = 'account-routes@learnsdlc.test';
  const BYSTANDER = 'account-bystander@learnsdlc.test';
  const TASKED = 'account-tasks@learnsdlc.test';
  const PASSWORD = 'Correct-Horse-9';

  let token = '';
  let bystanderToken = '';

  const registered = async (email: string, displayName: string): Promise<string> => {
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, displayName })
      .expect(201);
    return res.body.token as string;
  };

  const me = async (bearer = token) => {
    const res = await request(http)
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${bearer}`)
      .expect(200);
    return res.body as UserProfile;
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));
    db = app.get(DataSource);

    token = await registered(OWNER, 'Ada');
    bystanderToken = await registered(BYSTANDER, 'Grace');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('PATCH /account/profile', () => {
    it('stores the name trimmed, and /auth/me agrees', async () => {
      const res = await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: '  Ada Lovelace  ' })
        .expect(200);

      expect(res.body).toEqual(await me());
      expect(res.body).toMatchObject({ displayName: 'Ada Lovelace', avatar: 0, bio: '', goals: '', onboardingCompleted: false, profileVersion: 1 });
      expect(Object.keys(res.body).sort()).toEqual(['avatar', 'bio', 'cohort', 'createdAt', 'displayName', 'email', 'goals', 'id', 'onboardingCompleted', 'profileVersion', 'role'].sort());
      // The shell draws the name from the profile route, so the two have to
      // be the same string or a rename looks like it did not take.
      expect((await me()).displayName).toBe('Ada Lovelace');
    });

    it('accepts the shortest legal name and refuses one shorter', async () => {
      await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: 'Jo' })
        .expect(200);
      expect((await me()).displayName).toBe('Jo');

      await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: 'J' })
        .expect(400);
      await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: 'x'.repeat(61) })
        .expect(400);
      await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: 42 })
        .expect(400);
      // None of the refusals changed anything.
      expect((await me()).displayName).toBe('Jo');
    });

    it('refuses a stale profile save and preserves the newer revision', async () => {
      const current = await me();
      await request(http).patch('/api/v1/account/profile').set('authorization', `Bearer ${token}`)
        .send({ displayName: current.displayName, bio: 'Newest biography', baseVersion: current.profileVersion }).expect(200);
      await request(http).patch('/api/v1/account/profile').set('authorization', `Bearer ${token}`)
        .send({ displayName: 'Stale name', bio: 'Old biography', baseVersion: current.profileVersion }).expect(409);
      expect(await me()).toMatchObject({ displayName: current.displayName, bio: 'Newest biography', profileVersion: (current.profileVersion ?? 0) + 1 });
      expect((await me(bystanderToken)).bio).toBe('');
    });

    it('is refused without a session', async () => {
      await request(http)
        .patch('/api/v1/account/profile')
        .send({ displayName: 'Nobody' })
        .expect(401);
    });

    it('names no account but the caller’s own', async () => {
      await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: 'Ada Lovelace' })
        .expect(200);

      // There is deliberately no path parameter on these routes; the only
      // account a request can name is the one its token names.
      expect((await me(bystanderToken)).displayName).toBe('Grace');
    });

    /**
     * The length rule is the DTO's and it counts characters, so two spaces used
     * to be two characters to the pipe, reach the service, and be trimmed to a
     * blank name on the learner's own row and on the instructor's list. The
     * @Transform on UpdateProfileDto trims first, so the rule now counts what
     * would actually be stored and the request is refused.
     */
    it('refuses a name that is only whitespace, and changes nothing', async () => {
      await request(http)
        .patch('/api/v1/account/profile')
        .set('authorization', `Bearer ${token}`)
        .send({ displayName: '  ' })
        .expect(400);

      expect((await me()).displayName).toBe('Ada Lovelace');
    });
  });

  /**
   * The per-task tables (`task_states`, `task_resets`) are part of the
   * learner's own data, and an erasure list that does not name a table is an
   * export that silently omits it and a deletion that silently keeps it. The
   * service's spec asserts the lists; this asserts the route, end to end, over
   * rows that really are in the database.
   */
  describe('the task grain is exported and erased with the account', () => {
    it('carries the learner’s task rows, and a deletion leaves none', async () => {
      const bearer = await registered(TASKED, 'Task Holder');
      const { id } = await me(bearer);

      const task = await db.manager.save(
        db.manager.create(TaskStateEntity, {
          // No foreign keys in this schema: what makes these the learner's
          // rows, for both the export and the erasure, is the userId column.
          phaseStateId: randomUUID(),
          userId: id,
          taskKey: 'story',
          status: 'passed',
          bestScore: 88,
          attempts: 2,
          passedAt: '2026-08-20T02:00:00.000Z',
        }),
      );
      await db.manager.save(
        db.manager.create(TaskResetEntity, {
          taskStateId: task.id,
          userId: id,
          files: { 'requirements/draft.md': '# US-1\n' },
        }),
      );

      const exported = await request(http)
        .get('/api/v1/account/export')
        .set('authorization', `Bearer ${bearer}`)
        .expect(200);

      expect(exported.body.taskStates).toHaveLength(1);
      expect(exported.body.taskStates[0]).toMatchObject({
        taskKey: 'story',
        status: 'passed',
        bestScore: 88,
        attempts: 2,
      });
      expect(exported.body.taskResets).toHaveLength(1);
      expect(exported.body.taskResets[0]).toMatchObject({
        taskStateId: task.id,
        files: { 'requirements/draft.md': '# US-1\n' },
      });

      await request(http)
        .delete('/api/v1/account')
        .set('authorization', `Bearer ${bearer}`)
        .send({ email: TASKED })
        .expect(200);

      // Children before parents: `USER_SCOPED_ENTITIES` lists taskStates then
      // taskResets and the deletion walks the list backwards, so the reset row
      // goes before the task row it names.
      expect(await db.manager.count(TaskResetEntity, { where: { userId: id } })).toBe(0);
      expect(await db.manager.count(TaskStateEntity, { where: { userId: id } })).toBe(0);
    });
  });

  describe('DELETE /account', () => {
    it('refuses a mistyped address, and changes nothing', async () => {
      await request(http)
        .delete('/api/v1/account')
        .set('authorization', `Bearer ${token}`)
        .send({ email: 'ada@somewhere.else' })
        .expect(400);

      // Still there, still signed in, still named.
      expect((await me()).email).toBe(OWNER);
    });

    it('refuses a body with no address at all', async () => {
      await request(http)
        .delete('/api/v1/account')
        .set('authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
      expect((await me()).email).toBe(OWNER);
    });

    it('takes the address however it was typed, and then the account is gone', async () => {
      await request(http)
        .delete('/api/v1/account')
        .set('authorization', `Bearer ${token}`)
        .send({ email: OWNER.toUpperCase() })
        .expect(200);

      // The token names a row that no longer exists.
      await request(http).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`).expect(401);
      // And the account beside it is untouched.
      expect((await me(bystanderToken)).email).toBe(BYSTANDER);
    });
  });
});
