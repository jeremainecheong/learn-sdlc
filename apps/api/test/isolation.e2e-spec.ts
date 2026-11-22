import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { EMPTY_STORY, serialiseStory } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { mockAiForRoutes } from './mock-ai';
import { AuthService } from '../src/auth/auth.service';
import {
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../src/db/entities';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * Cross-account isolation.
 *
 * The privacy policy tells learners that "access to your coursework is scoped
 * to your account". That is a security assurance published to the public, so
 * it should not rest on nobody having broken it yet. This drives two real
 * accounts through the API and asserts the second is refused everywhere the
 * first has data: including the routes that only take an opaque id, which are
 * exactly the ones where an ownership check is easiest to forget.
 */
/** Requirements is a story phase: its one file is the record, and a marker rides in its title. */
const RECORD = 'requirements/story.json';
const recordTitled = (title: string): string => serialiseStory({ ...EMPTY_STORY, title });

describe('cross-account isolation', () => {
  let app: INestApplication;
  let http: HttpTarget;

  // alice owns everything; mallory is a second, legitimate account trying to
  // read it. Both are ordinary learners: this is not a privilege-escalation
  // test, it is the far more common case of one user guessing another's id.
  let aliceToken = '';
  let aliceId = '';
  let malloryToken = '';
  let alicePhaseId = '';
  let aliceSubmissionId = '';
  let aliceRunId = '';

  const stamp = Date.now();

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], pipeline: 'prefix', excludeFromPrefix: ['metrics'] }));

    const alice = await request(http)
      .post('/api/v1/auth/register')
      .send({
        email: `alice-${stamp}@isolation.test`,
        password: 'Correct-Horse-9',
        displayName: 'Alice',
      })
      .expect(201);
    aliceToken = alice.body.token;
    aliceId = alice.body.user.id;

    const mallory = await request(http)
      .post('/api/v1/auth/register')
      .send({
        email: `mallory-${stamp}@isolation.test`,
        password: 'Correct-Horse-9',
        displayName: 'Mallory',
      })
      .expect(201);
    malloryToken = mallory.body.token;

    const enrollment = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(aliceToken))
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    alicePhaseId = enrollment.body.phases.find((p: any) => p.order === 1).id;

    await request(http)
      .put(`/api/v1/phases/${alicePhaseId}/workspace`)
      .set(bearer(aliceToken))
      .send({ files: { [RECORD]: recordTitled('# Alice private draft') } })
      .expect(200);

    const submission = await request(http)
      .post(`/api/v1/phases/${alicePhaseId}/submit`)
      .set(bearer(aliceToken))
      .expect(201);
    aliceSubmissionId = submission.body.id;

    // A run row needs a phase the pack can run (the run route refuses
    // requirements with 400 before any row exists), so the
    // implementation phase is unlocked directly and run there.
    const aliceRunPhaseId = enrollment.body.phases.find(
      (p: any) => p.order === 3,
    ).id;
    await app
      .get(DataSource)
      .manager.update(
        PhaseStateEntity,
        { id: aliceRunPhaseId },
        { status: 'in_progress' },
      );
    const run = await request(http)
      .post(`/api/v1/phases/${aliceRunPhaseId}/run`)
      .set(bearer(aliceToken))
      .expect(201);
    aliceRunId = run.body.id;

    await request(http)
      .post('/api/v1/assistant/chat')
      .set(bearer(aliceToken))
      .send({
        phaseStateId: alicePhaseId,
        message: 'What belongs in an acceptance criterion?',
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets the owner read her own phase, submission, run and transcript', async () => {
    await request(http)
      .get(`/api/v1/phases/${alicePhaseId}`)
      .set(bearer(aliceToken))
      .expect(200);
    await request(http)
      .get(`/api/v1/submissions/${aliceSubmissionId}`)
      .set(bearer(aliceToken))
      .expect(200);
    await request(http)
      .get(`/api/v1/runs/${aliceRunId}`)
      .set(bearer(aliceToken))
      .expect(200);

    const history = await request(http)
      .get(`/api/v1/assistant/history/${alicePhaseId}`)
      .set(bearer(aliceToken))
      .expect(200);
    expect(history.body.length).toBeGreaterThan(0);
  });

  it('refuses another account on every id-addressed route', async () => {
    // 403 (it exists, not yours) and 404 (we will not confirm it exists) are
    // both acceptable answers; 200 is not.
    const refused = [403, 404];

    const phase = await request(http)
      .get(`/api/v1/phases/${alicePhaseId}`)
      .set(bearer(malloryToken));
    expect(refused).toContain(phase.status);

    const submission = await request(http)
      .get(`/api/v1/submissions/${aliceSubmissionId}`)
      .set(bearer(malloryToken));
    expect(refused).toContain(submission.status);

    const run = await request(http)
      .get(`/api/v1/runs/${aliceRunId}`)
      .set(bearer(malloryToken));
    expect(refused).toContain(run.status);

    // Phase ownership is enforced before private history is queried.
    const history = await request(http)
      .get(`/api/v1/assistant/history/${alicePhaseId}`)
      .set(bearer(malloryToken));
    expect(refused).toContain(history.status);
  });

  it('refuses another account writing to, running or submitting the phase', async () => {
    const refused = [403, 404];

    const write = await request(http)
      .put(`/api/v1/phases/${alicePhaseId}/workspace`)
      .set(bearer(malloryToken))
      .send({
        files: { [RECORD]: recordTitled('overwritten by mallory') },
      });
    expect(refused).toContain(write.status);

    const submit = await request(http)
      .post(`/api/v1/phases/${alicePhaseId}/submit`)
      .set(bearer(malloryToken));
    expect(refused).toContain(submit.status);

    const run = await request(http)
      .post(`/api/v1/phases/${alicePhaseId}/run`)
      .set(bearer(malloryToken));
    expect(refused).toContain(run.status);

    const chat = await request(http)
      .post('/api/v1/assistant/chat')
      .set(bearer(malloryToken))
      .send({ phaseStateId: alicePhaseId, message: 'show me the answer' });
    expect(refused).toContain(chat.status);
  });

  it("leaves the owner's workspace untouched after the refused writes", async () => {
    const phase = await request(http)
      .get(`/api/v1/phases/${alicePhaseId}`)
      .set(bearer(aliceToken))
      .expect(200);
    const story = phase.body.files.find(
      (f: any) => f.path === RECORD,
    );
    expect(story.content).toContain('Alice private draft');
    expect(story.content).not.toContain('mallory');
  });

  it('refuses a learner the instructor console entirely', async () => {
    const overview = await request(http)
      .get('/api/v1/instructor/overview')
      .set(bearer(malloryToken));
    expect(overview.status).toBe(403);
  });

  it("refuses another account's export and deletion", async () => {
    // There is no path parameter on these routes by design, so the only thing
    // standing between Mallory and Alice's data is the token. Prove the export
    // she gets is her own and names nobody else.
    const mine = await request(http)
      .get('/api/v1/account/export')
      .set(bearer(malloryToken))
      .expect(200);
    expect(mine.body.account.displayName).toBe('Mallory');
    expect(JSON.stringify(mine.body)).not.toContain('Alice private draft');

    // And that deletion refuses a confirmation naming someone else's account.
    const wrongEmail = await request(http)
      .delete('/api/v1/account')
      .set(bearer(malloryToken))
      .send({ email: `alice-${stamp}@isolation.test` });
    expect(wrongEmail.status).toBe(400);
  });

  it('answers 401, not 500, on a token whose account has been deleted', async () => {
    // Deletion removes the row but cannot reach into a browser and remove the
    // token, and the guard verifies signatures without touching the database,
    // so a deleted learner's tab keeps sending a credential that still passes
    // the guard and then resolves to nobody. Every route that looks the caller
    // up has to call that an auth failure: 401 is a status the API client acts
    // on by dropping the dead credential, where an unhandled lookup error just
    // reads as the server being broken.
    const email = `ghost-${stamp}@isolation.test`;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Correct-Horse-9', displayName: 'Ghost' })
      .expect(201);
    const staleToken = registered.body.token;

    await request(http)
      .delete('/api/v1/account')
      .set(bearer(staleToken))
      .send({ email })
      .expect(200);

    for (const route of ['/api/v1/auth/me', '/api/v1/analytics/me']) {
      const res = await request(http).get(route).set(bearer(staleToken));
      expect([route, res.status]).toEqual([route, 401]);
    }
  });

  it('signs every earlier session out when the password changes', async () => {
    // The scenario this protects: a token was copied off a shared machine, the
    // owner notices and changes their password. The token is still signed and
    // still a week from expiry; only its version is now behind the row's.
    const email = `rotator-${stamp}@isolation.test`;
    const oldPassword = 'Correct-Horse-9';
    const newPassword = 'Staple-Battery-42';
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: oldPassword, displayName: 'Rotator' })
      .expect(201);
    const stolenToken = registered.body.token;

    // The token works right up to the change, and this request itself warms
    // the guard's row cache, so a change that failed to evict it would show.
    await request(http)
      .get('/api/v1/auth/me')
      .set(bearer(stolenToken))
      .expect(200);
    await request(http)
      .post('/api/v1/account/password')
      .set(bearer(stolenToken))
      .send({ currentPassword: oldPassword, newPassword })
      .expect(200);

    await request(http)
      .get('/api/v1/auth/me')
      .set(bearer(stolenToken))
      .expect(401);
    await request(http)
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword })
      .expect(401);

    const fresh = await request(http)
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword })
      .expect(200);
    const me = await request(http)
      .get('/api/v1/auth/me')
      .set(bearer(fresh.body.token))
      .expect(200);
    expect(me.body.email).toBe(email);
  });

  /**
   * Role boundaries, over HTTP.
   *
   * Beyond a learner against the instructor overview, this asserts the
   * escalation a two-tier staff model actually has (an instructor reaching an
   * admin route) and the whole console: `admin/users`, `admin/cohorts`,
   * `instructor/class-map`, `instructor/audit`, the override route and the CSV
   * export. Every route below is named explicitly rather than swept out of the
   * router, so deleting one from the table is as visible as deleting its guard.
   *
   * Guards run before pipes in Nest, so an empty body on the write routes is
   * answered 403 by the guard and never reaches a DTO or a service. Nothing
   * here can change a row.
   */
  it('returns explicit JSON for independent learners without class membership', async () => {
    const response = await request(http)
      .get('/api/v1/enrollments/classroom')
      .set(bearer(malloryToken))
      .expect(200);
    expect(response.body).toEqual({ classroom: null });
  });

  describe('role boundaries', () => {
    let instructorToken = '';
    let adminToken = '';
    let instructorId = '';

    /** Registers a learner, then makes them staff on the row the guard reads. */
    const staff = async (name: string, role: 'INSTRUCTOR' | 'ADMIN') => {
      const registered = await request(http)
        .post('/api/v1/auth/register')
        .send({
          email: `${name}-${stamp}@isolation.test`,
          password: 'Correct-Horse-9',
          displayName: name,
        })
        .expect(201);
      const id = registered.body.user.id;
      await app.get(DataSource).manager.update(UserEntity, { id }, { role });
      // The guard caches the row for a minute; drop it so the promotion is
      // live on the token that is already in hand.
      app.get(AuthService).forgetSession(id);
      return { id, token: registered.body.token as string };
    };

    // `ADMIN` on the class, so every route on the controller is covered by one
    // decorator, and one deletion.
    const ADMIN_ROUTES: [string, string][] = [
      ['get', '/api/v1/admin/users?email=someone@isolation.test'],
      ['get', '/api/v1/admin/cohorts'],
      [
        'patch',
        `/api/v1/admin/users/${'11111111-1111-4111-8111-111111111111'}`,
      ],
      [
        'patch',
        `/api/v1/admin/cohorts/${'11111111-1111-4111-8111-111111111111'}/owner`,
      ],
      [
        'post',
        `/api/v1/admin/users/${'11111111-1111-4111-8111-111111111111'}/password`,
      ],
    ];

    beforeAll(async () => {
      const instructor = await staff('instructor', 'INSTRUCTOR');
      instructorToken = instructor.token;
      instructorId = instructor.id;
      adminToken = (await staff('admin', 'ADMIN')).token;
    });

    it('refuses a learner every admin route', async () => {
      for (const [method, path] of ADMIN_ROUTES) {
        const res = await (request(http) as any)
          [method](path)
          .set(bearer(malloryToken))
          .send({});
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('refuses an instructor every admin route', async () => {
      // Staff is two tiers. An instructor who can suspend accounts or set
      // another instructor's password is not an instructor.
      for (const [method, path] of ADMIN_ROUTES) {
        const res = await (request(http) as any)
          [method](path)
          .set(bearer(instructorToken))
          .send({});
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('lets an admin in, so the refusals above are the guard and not a broken route', async () => {
      await request(http)
        .get('/api/v1/admin/cohorts')
        .set(bearer(adminToken))
        .expect(200);
      await request(http)
        .get(`/api/v1/admin/users?email=alice-${stamp}@isolation.test`)
        .set(bearer(adminToken))
        .expect(200);
    });

    it('refuses a learner every instructor route', async () => {
      const routes: [string, string][] = [
        ['get', '/api/v1/instructor/overview'],
        ['get', '/api/v1/instructor/rubrics/tasktrackr'],
        ['get', '/api/v1/instructor/class-map'],
        ['get', '/api/v1/instructor/audit'],
        ['get', `/api/v1/instructor/learners/${aliceId}`],
        [
          'post',
          `/api/v1/instructor/learners/${aliceId}/phases/${alicePhaseId}/override`,
        ],
        ['get', '/api/v1/instructor/export.csv'],
        ['post', '/api/v1/instructor/cohorts'],
        ['get', '/api/v1/instructor/cohorts'],
      ];
      for (const [method, path] of routes) {
        const res = await (request(http) as any)
          [method](path)
          .set(bearer(malloryToken))
          .send({});
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('does not expose retired token-quota routes to learners', async () => {
      for (const path of ['/api/v1/instructor/settings', `/api/v1/instructor/learners/${aliceId}/budget`]) {
        await request(http).patch(path).set(bearer(malloryToken)).send({ dailyTokenBudget: 0 }).expect(404);
      }
    });

    it('refuses staff the learner-only join route', async () => {
      // A class code is passed around a room. An instructor who redeems one
      // takes on that cohort, and their scope is their cohort column, so they
      // would then be reading another instructor's class.
      for (const token of [instructorToken, adminToken]) {
        const res = await request(http)
          .post('/api/v1/enrollments/join')
          .set(bearer(token))
          .send({ code: 'AAAA-BBBB' });
        expect(res.status).toBe(403);
      }
    });

    it('refuses an unauthenticated caller before it refuses their role', async () => {
      // 401, not 403: the client's job is to sign in, not to ask for a
      // different account.
      await request(http).get('/api/v1/admin/cohorts').expect(401);
      await request(http).get('/api/v1/instructor/class-map').expect(401);
    });

    it('does not open /metrics to a signed-in learner', async () => {
      // The metrics credential is METRICS_TOKEN, never the session. With one
      // configured, a learner's bearer must not be mistaken for it.
      const previous = process.env.METRICS_TOKEN;
      process.env.METRICS_TOKEN = 'metrics-spec-token';
      try {
        await request(http)
          .get('/metrics')
          .set(bearer(malloryToken))
          .expect(401);
        await request(http)
          .get('/metrics')
          .set(bearer(instructorToken))
          .expect(401);
        await request(http).get('/metrics').expect(401);
        await request(http)
          .get('/metrics')
          .set({ authorization: 'Bearer metrics-spec-token' })
          .expect(200);
      } finally {
        if (previous === undefined) delete process.env.METRICS_TOKEN;
        else process.env.METRICS_TOKEN = previous;
      }
    });

    it('keeps an instructor out of another account’s learner detail', async () => {
      // Not a role check: the role is right and the scope is not. Alice is in
      // `default`, which no instructor's class contains.
      const res = await request(http)
        .get(`/api/v1/instructor/learners/${aliceId}`)
        .set(bearer(instructorToken));
      expect([403, 404]).toContain(res.status);
      expect(instructorId).not.toEqual(aliceId);
    });
  });

  /**
   * View as learner, and the scope that keeps it honest.
   *
   * The whole design rests on there being no impersonation token: the six
   * reads below are ordinary instructor routes that resolve a learner through
   * `scopedLearner`, and the instructor's own bearer token is what makes them.
   * So the two things to prove over HTTP are that a second instructor is
   * refused on every one of them, and that not one of them accepts a write,
   * because a read-only projection that quietly took a POST would be exactly
   * the impersonation this design exists to avoid.
   */
  describe('view as learner', () => {
    let danaToken = '';
    let samToken = '';
    let leeId = '';
    let leePhaseId = '';

    const staff = async (name: string) => {
      const registered = await request(http)
        .post('/api/v1/auth/register')
        .send({
          email: `${name}-view-${stamp}@isolation.test`,
          password: 'Correct-Horse-9',
          displayName: name,
        })
        .expect(201);
      const id = registered.body.user.id as string;
      await app
        .get(DataSource)
        .manager.update(UserEntity, { id }, { role: 'INSTRUCTOR' });
      app.get(AuthService).forgetSession(id);
      return { id, token: registered.body.token as string };
    };

    /** Every read the console makes while it is showing a learner's screens. */
    const reads = (): string[] => [
      `/api/v1/instructor/learners/${leeId}/enrollment?project=tasktrackr`,
      `/api/v1/instructor/learners/${leeId}/analytics?project=tasktrackr`,
      `/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}`,
      `/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}/submissions`,
      `/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}/runs`,
      `/api/v1/instructor/learners/${leeId}/assistant/${leePhaseId}`,
      // The dashboard's and the shell's batch reads. Without their own twins
      // the phase route would read "summaries" as a phase id and answer 500,
      // and the map would be the teacher's own.
      `/api/v1/instructor/learners/${leeId}/phases/summaries?project=tasktrackr`,
      `/api/v1/instructor/learners/${leeId}/phases/records?project=tasktrackr`,
      `/api/v1/instructor/learners/${leeId}/projects/tasktrackr/map?compact=1&showLocked=1`,
      // A split phase's revision list is read per task, so that read needs a
      // twin too: without one, every room of a split phase would ask the
      // learner-only route and be refused "not your phase".
      `/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}/tasks/story/submissions`,
    ];

    /** Every row of Lee's coursework, to prove a read wrote nothing. */
    const leeRows = async (): Promise<string> => {
      const manager = app.get(DataSource).manager;
      const states = await manager.find(PhaseStateEntity, { where: { userId: leeId }, order: { id: 'ASC' } });
      return JSON.stringify([
        states,
        await manager.find(EnrollmentEntity, { where: { userId: leeId }, order: { id: 'ASC' } }),
        await manager.find(TaskStateEntity, { order: { id: 'ASC' } }),
        await manager.find(SubmissionEntity, { where: { userId: leeId }, order: { id: 'ASC' } }),
      ]);
    };

    beforeAll(async () => {
      const dana = await staff('dana');
      danaToken = dana.token;
      samToken = (await staff('sam')).token;

      const cohort = await request(http)
        .post('/api/v1/instructor/cohorts')
        .set(bearer(danaToken))
        .send({ name: 'Tuesday class' })
        .expect(201);
      app.get(AuthService).forgetSession(dana.id);

      const lee = await request(http)
        .post('/api/v1/auth/register')
        .send({
          email: `lee-view-${stamp}@isolation.test`,
          password: 'Correct-Horse-9',
          displayName: 'Lee',
        })
        .expect(201);
      leeId = lee.body.user.id;
      await app
        .get(DataSource)
        .manager.update(UserEntity, { id: leeId }, { cohort: cohort.body.id });

      const enrollment = await request(http)
        .post('/api/v1/enrollments')
        .set(bearer(lee.body.token))
        .send({ projectSlug: 'tasktrackr' })
        .expect(201);
      leePhaseId = enrollment.body.phases.find(
        (phase: any) => phase.order === 1,
      ).id;
      await request(http)
        .put(`/api/v1/phases/${leePhaseId}/workspace`)
        .set(bearer(lee.body.token))
        .send({ files: { [RECORD]: recordTitled('# Lee private draft') } })
        .expect(200);
    });

    it('shows authorized coursework but refuses private mentor conversations', async () => {
      const start = await request(http)
        .post(`/api/v1/instructor/learners/${leeId}/view`)
        .set(bearer(danaToken))
        .expect(200);
      expect(start.body).toMatchObject({ userId: leeId, displayName: 'Lee' });

      for (const path of reads()) {
        const res = await request(http).get(path).set(bearer(danaToken));
        expect([path, res.status]).toEqual([
          path,
          path.includes('/assistant/') ? 403 : 200,
        ]);
      }
      const phase = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}`)
        .set(bearer(danaToken))
        .expect(200);
      expect(JSON.stringify(phase.body)).not.toContain('Lee private draft');
      expect(phase.body.files.filter((file: any) => file.editable)).toEqual([]);
    });

    it("answers the dashboard's batch reads with the learner's own board, and writes nothing", async () => {
      // A board a learner's own read WOULD write to: an unpinned enrolment
      // carrying a stale pack stamp, and a
      // locked room the board lost. `myEnrollment`, `phaseSummaries` and the
      // room each stamp the pack and put the room back when the read may
      // write, so a twin that forgot `write: false` changes these rows, which
      // a complete, pinned fixture board could never show.
      const manager = app.get(DataSource).manager;
      const held = await manager.findOneByOrFail(EnrollmentEntity, { userId: leeId, projectSlug: 'tasktrackr' });
      const lost = await manager.findOneByOrFail(PhaseStateEntity, { enrollmentId: held.id, phaseKey: 'maintenance' });
      await manager.update(EnrollmentEntity, { id: held.id }, { projectVersionId: null, packVersion: '0.0.0-stale' });
      await manager.delete(PhaseStateEntity, { id: lost.id });
      try {
      const before = await leeRows();
      const summaries = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/summaries?project=tasktrackr`)
        .set(bearer(danaToken))
        .expect(200);
      expect(Array.isArray(summaries.body)).toBe(true);
      expect(summaries.body.map((phase: any) => phase.id)).toContain(leePhaseId);
      expect(summaries.body.every((phase: any) => phase.view === 'summary')).toBe(true);
      expect(summaries.body.every((phase: any) => phase.projectSlug === 'tasktrackr')).toBe(true);
      // The same privacy rule as the phase route: the draft stays the learner's.
      expect(JSON.stringify(summaries.body)).not.toContain('Lee private draft');
      expect(
        summaries.body
          .find((phase: any) => phase.id === leePhaseId)
          .files.filter((file: any) => file.editable),
      ).toEqual([]);

      // No project named: the learner's own, as the enrolment twin resolves it.
      const unnamed = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/summaries`)
        .set(bearer(danaToken))
        .expect(200);
      expect(unnamed.body.map((phase: any) => phase.id)).toEqual(summaries.body.map((phase: any) => phase.id));

      const records = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/records?project=tasktrackr`)
        .set(bearer(danaToken))
        .expect(200);
      expect(Object.keys(records.body)).toContain(leePhaseId);
      // The mentor conversation stays private here too.
      expect(records.body[leePhaseId].chat).toEqual([]);

      const map = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/projects/tasktrackr/map?compact=1&showLocked=1`)
        .set(bearer(danaToken))
        .expect(200);
      expect(map.body.nodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(map.body)).not.toContain('Lee private draft');

      // The review history the dashboard reads has a teacher's door already.
      await request(http)
        .get(`/api/v1/submissions/learner-history/${leeId}?project=tasktrackr`)
        .set(bearer(danaToken))
        .expect(200);

      // The rest of the twins, over the same board.
      for (const path of reads()) await request(http).get(path).set(bearer(danaToken));
      await request(http).get(`/api/v1/instructor/learners/${leeId}/enrollment`).set(bearer(danaToken)).expect(200);

      expect(await leeRows()).toBe(before);
      } finally {
        await manager.update(
          EnrollmentEntity,
          { id: held.id },
          { projectVersionId: held.projectVersionId, packVersion: held.packVersion },
        );
        await manager.save(PhaseStateEntity, lost);
      }
    });

    it("reads one task's revisions of a split phase, the learner's own and nobody else's", async () => {
      const manager = app.get(DataSource).manager;
      const saved = await manager.save(
        manager.create(SubmissionEntity, {
          userId: leeId,
          phaseStateId: leePhaseId,
          taskKey: 'story',
          status: 'completed',
          passed: false,
          workspaceSnapshot: { [RECORD]: recordTitled('# Story revision') },
          contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false },
        }),
      );
      try {
        const story = await request(http)
          .get(`/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}/tasks/story/submissions`)
          .set(bearer(danaToken))
          .expect(200);
        expect(story.body.map((one: any) => one.id)).toEqual([saved.id]);
        const other = await request(http)
          .get(`/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}/tasks/other/submissions`)
          .set(bearer(danaToken))
          .expect(200);
        expect(other.body).toEqual([]);
        await request(http)
          .get(`/api/v1/instructor/learners/${leeId}/phases/not-a-phase/tasks/story/submissions`)
          .set(bearer(danaToken))
          .expect(400);
      } finally {
        await manager.delete(SubmissionEntity, saved.id);
      }
    });

    it('refuses a word in the phase slot with a 400, never a 500', async () => {
      for (const path of [
        `/api/v1/instructor/learners/${leeId}/phases/not-a-phase`,
        `/api/v1/instructor/learners/${leeId}/phases/not-a-phase/submissions`,
        `/api/v1/instructor/learners/${leeId}/phases/not-a-phase/runs`,
        `/api/v1/instructor/learners/${leeId}/assistant/not-a-phase`,
        `/api/v1/instructor/learners/not-a-learner/phases/summaries`,
      ]) {
        const res = await request(http).get(path).set(bearer(danaToken));
        expect([path, res.status]).toEqual([path, 400]);
      }
    });

    it('refuses a malformed learner or phase id with a 400 on every learner route, as on the phase routes', async () => {
      const reason = { action: 'reopen', reason: 'A malformed id is refused before the reason is read.' };
      for (const [method, path] of [
        ['get', '/api/v1/instructor/learners/not-a-learner'],
        ['post', `/api/v1/instructor/learners/not-a-learner/phases/${leePhaseId}/override`],
        ['post', `/api/v1/instructor/learners/${leeId}/phases/not-a-phase/override`],
        ['post', '/api/v1/instructor/learners/not-a-learner/view'],
        ['get', '/api/v1/instructor/learners/not-a-learner/enrollment'],
        ['get', '/api/v1/instructor/learners/not-a-learner/analytics'],
        ['get', '/api/v1/instructor/learners/not-a-learner/dossier'],
        ['post', '/api/v1/instructor/learners/not-a-learner/note'],
      ] as const) {
        const call = request(http)[method](path).set(bearer(danaToken));
        const res = method === 'post' ? await call.send(path.endsWith('/note') ? { text: 'A note.' } : reason) : await call;
        expect([path, res.status]).toEqual([path, 400]);
      }
    });

    it('opens the exact submitted snapshot while a newer draft stays private', async () => {
      const manager = app.get(DataSource).manager;
      const submission = await manager.save(
        manager.create(SubmissionEntity, {
          userId: leeId,
          phaseStateId: leePhaseId,
          status: 'completed',
          passed: false,
          workspaceSnapshot: {
            [RECORD]: recordTitled('# Submitted evidence for review'),
          },
          contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false },
        }),
      );
      const phase = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}`)
        .set(bearer(danaToken))
        .expect(200);
      expect(
        phase.body.files.find(
          (file: any) => file.path === RECORD,
        ).content,
      ).toBe(recordTitled('# Submitted evidence for review'));
      expect(JSON.stringify(phase.body)).not.toContain('Lee private draft');
      expect(phase.body.canRun).toBe(false);
      expect(phase.body.canPreview).toBe(false);
      await manager.delete(SubmissionEntity, submission.id);
    });

    it('does not expose private exploratory run output in teacher run history', async () => {
      const manager = app.get(DataSource).manager;
      const run = await manager.save(
        manager.create(ExecutionRunEntity, {
          userId: leeId,
          phaseStateId: leePhaseId,
          kind: 'run',
          status: 'completed',
          result: {
            ok: true,
            exitKind: 'ok',
            stdout: 'PRIVATE_DRAFT_RUN_OUTPUT',
            stderr: '',
            durationMs: 1,
          },
        }),
      );
      const history = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}/runs`)
        .set(bearer(danaToken))
        .expect(200);
      expect(history.body).toEqual([]);
      expect(
        (await manager.findOneByOrFail(ExecutionRunEntity, { id: run.id }))
          .result?.stdout,
      ).toBe('PRIVATE_DRAFT_RUN_OUTPUT');
      await manager.delete(ExecutionRunEntity, run.id);
    });

    it('refuses a second instructor every one of the reads, with a 404', async () => {
      const start = await request(http)
        .post(`/api/v1/instructor/learners/${leeId}/view`)
        .set(bearer(samToken));
      expect(start.status).toBe(404);
      for (const path of reads()) {
        const res = await request(http).get(path).set(bearer(samToken));
        expect([path, res.status]).toEqual([path, 404]);
      }
    });

    it('refuses a learner the reads entirely', async () => {
      for (const path of reads()) {
        const res = await request(http).get(path).set(bearer(malloryToken));
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('accepts no write on any of them, from the instructor whose class it is', async () => {
      // 404 is Nest saying there is no such route, which is the answer that
      // proves nothing on this path can be written through.
      for (const path of reads().map((path) => path.split('?')[0])) {
        for (const method of ['post', 'put', 'patch', 'delete'] as const) {
          const res = await (request(http) as any)
            [method](path)
            .set(bearer(danaToken))
            .send({
              files: {
                [RECORD]: recordTitled('overwritten by an instructor'),
              },
            });
          expect([method, path, res.status]).toEqual([method, path, 404]);
        }
      }
    });

    it("leaves the learner's own work exactly as they left it", async () => {
      const phase = await request(http)
        .get(`/api/v1/instructor/learners/${leeId}/phases/${leePhaseId}`)
        .set(bearer(danaToken))
        .expect(200);
      expect(JSON.stringify(phase.body)).not.toContain('Lee private draft');
      const state = await app
        .get(DataSource)
        .manager.findOneByOrFail(PhaseStateEntity, { id: leePhaseId });
      expect(state.workspace?.[RECORD]).toContain(
        'Lee private draft',
      );
      expect(state.workspace?.[RECORD]).not.toContain(
        'overwritten by an instructor',
      );
    });

    it('records who looked at whose work, because that happened to them', async () => {
      const rows = await app
        .get(DataSource)
        .manager.query(
          `SELECT "event", "subjectUserId", "action" FROM audit_events WHERE "event" = 'instructor.view-as'`,
        );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.some(
          (row: any) => row.subjectUserId === leeId && row.action === 'start',
        ),
      ).toBe(true);
    });
  });

  it('refuses a suspended account’s token', async () => {
    const email = `suspended-${stamp}@isolation.test`;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Correct-Horse-9', displayName: 'Suspended' })
      .expect(201);
    const token = registered.body.token;
    const userId = registered.body.user.id;
    await request(http).get('/api/v1/auth/me').set(bearer(token)).expect(200);

    // Suspension is an admin action; the shape of it is what matters here
    // (disabledAt set on the row, and the guard's cached copy of that row
    // dropped) so the check is driven straight at the row rather than
    // through whichever admin route ends up doing this.
    await app
      .get(DataSource)
      .manager.update(
        UserEntity,
        { id: userId },
        { disabledAt: new Date().toISOString() },
      );
    app.get(AuthService).forgetSession(userId);

    for (const route of ['/api/v1/auth/me', '/api/v1/analytics/me']) {
      const res = await request(http).get(route).set(bearer(token));
      expect([route, res.status]).toEqual([route, 401]);
    }
  });
});
