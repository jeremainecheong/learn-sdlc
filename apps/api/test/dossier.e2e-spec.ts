import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { EMPTY_STORY, serialiseStory } from '@learnsdlc/shared';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { JobsService } from '../src/jobs/jobs.service';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * An instructor prints a learner's whole project, over HTTP.
 *
 * The service's own rules are in `instructor.service.spec.ts`. What is
 * asserted here is everything the unit spec cannot see: that the route is on
 * the instructor controller and so behind its role guard, that a learner
 * calling it is refused by `RolesGuard` rather than by a scope check, that an
 * instructor from another class gets the same 404 every other instructor route
 * gives, and (the point of the whole route) that reading it leaves a
 * `dossier.read` row an appeal can find on `GET /instructor/audit` six weeks
 * later.
 */
describe('Dossier (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  let jobs: JobsService;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  /** The learner's story record (Requirements is a story phase whose one file is the record). */
  const STORY = serialiseStory({
    ...EMPTY_STORY,
    title: 'US-4 The overdue report',
    persona: 'team lead',
    capability: 'an overdue report',
    benefit: 'I can chase late work',
    criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' }],
  });

  let instructorToken = '';
  let outsiderToken = '';
  let leeToken = '';
  let leeId = '';
  let olaId = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const email = `${name}-${stamp}@dossier.test`;
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

  /** Enrol on tasktrackr, write the story, submit it and wait for the verdict. */
  const submitFirstPhase = async (token: string, message: string): Promise<string> => {
    const enrollment = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(token))
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    const phaseId = enrollment.body.phases.find((phase: any) => phase.order === 1).id as string;
    await request(http)
      .put(`/api/v1/phases/${phaseId}/workspace`)
      .set(bearer(token))
      .send({ files: { 'requirements/story.json': STORY } })
      .expect(200);
    await request(http)
      .post(`/api/v1/phases/${phaseId}/submit`)
      .set(bearer(token))
      .send({ message })
      .expect(201);
    await jobs.onIdle();
    return phaseId;
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix', excludeFromPrefix: ['metrics'] }));
    db = app.get(DataSource);
    jobs = app.get(JobsService);

    const dana = await account('dana', 'INSTRUCTOR');
    instructorToken = dana.token;
    outsiderToken = (await account('sam', 'INSTRUCTOR')).token;

    const created = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(instructorToken))
      .send({ name: 'Tuesday class' })
      .expect(201);
    // Creating a class moves the creator into it, and the guard is holding the
    // row from before that.
    app.get(AuthService).forgetSession(dana.id);

    const lee = await account('lee');
    const ola = await account('ola');
    leeToken = lee.token;
    leeId = lee.id;
    olaId = ola.id;
    await db.manager.update(UserEntity, { id: lee.id }, { cohort: created.body.id });

    await submitFirstPhase(lee.token, 'Write US-4 with two criteria');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('hands an instructor the learner the class, the files and the revisions', async () => {
    const res = await request(http)
      .get(`/api/v1/instructor/learners/${leeId}/dossier?project=tasktrackr`)
      .set(bearer(instructorToken))
      .expect(200);

    expect(res.body.audience).toBe('instructor');
    expect(res.body.userId).toBe(leeId);
    expect(res.body.cohortName).toBe('Tuesday class');
    expect(res.body.projectSlug).toBe('tasktrackr');
    expect(res.body.phases).toHaveLength(6);

    const first = res.body.phases[0];
    // The files the learner wrote, at the revision that was graded: the one
    // thing no other instructor route hands over.
    const story = first.files.find((f: any) => f.path === 'requirements/story.json');
    expect(story).toBeDefined();
    expect(story.content).toContain('US-4 The overdue report');
    expect(first.revisions).toHaveLength(1);
    expect(first.revisions[0].commitMessage).toBe('Write US-4 with two criteria');
    expect(first.revisions[0].attempt).toBe(1);

    // A locked phase prints no code at all.
    const locked = res.body.phases.find((p: any) => p.status === 'locked');
    expect(locked.files).toEqual([]);
  });

  it('refuses an instructor from another class, and a learner outright', async () => {
    await request(http)
      .get(`/api/v1/instructor/learners/${leeId}/dossier`)
      .set(bearer(outsiderToken))
      .expect(404);
    // A learner in nobody's class is invisible to an instructor too.
    await request(http)
      .get(`/api/v1/instructor/learners/${olaId}/dossier`)
      .set(bearer(instructorToken))
      .expect(404);
    // RolesGuard, not the scope check: a learner has no business on this
    // controller at all, including for their own id.
    await request(http)
      .get(`/api/v1/instructor/learners/${leeId}/dossier`)
      .set(bearer(leeToken))
      .expect(403);
    await request(http).get(`/api/v1/instructor/learners/${leeId}/dossier`).expect(401);
  });

  it('leaves a row on the trail that names who read whose project', async () => {
    await request(http)
      .get(`/api/v1/instructor/learners/${leeId}/dossier`)
      .set(bearer(instructorToken))
      .expect(200);

    const audit = await request(http)
      .get(`/api/v1/instructor/audit?learnerId=${leeId}`)
      .set(bearer(instructorToken))
      .expect(200);
    const rows = audit.body.filter((row: any) => row.event === 'dossier.read');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      event: 'dossier.read',
      subjectUserId: leeId,
      targetId: 'tasktrackr',
      action: 'read',
    });
    expect(rows[0].subjectName).toBe('lee');
  });
});
