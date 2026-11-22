import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { EnrollmentView, PublishVersionResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { Redactor, holdContract } from './fixtures/contract-bodies/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The recorded enrolment contract, through the real `AppModule`.
 *
 * - `GET /enrollments/mine` for a learner on a teacher's copy
 *   (`projectIsDefault: false`) and one on the platform default (`true`): the
 *   one fact every lesson door reads (`lessonsVisibleFor`, fail closed).
 * - The class-scoped teacher read the teacher portal makes
 *   (`GET /instructor/learners?cohort=&limit=`), beside the two reads the portal
 *   makes first (`GET /instructor/cohorts`, `GET /instructor/overview`): the
 *   class's own learners only, `userId` ascending.
 * - `GET /auth/providers` in local mode, which `useSignOut` reads to choose
 *   between `/login` and the managed sign-out.
 *
 * Recorded in `fixtures/contract-bodies/enrollment.json` for
 * `apps/web/test/lessons-wiring.test.tsx`.
 */
describe('the enrolment, the class read and the providers answer, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();

  /** Display names no product text holds, so replacing them cannot touch a word of copy. */
  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${handle}@contract-bodies.test`, password: PASSWORD, displayName })
      .expect(201);
    const id = registered.body.user.id as string;
    redactor.name(displayName, `name:${handle}`);
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('records both enrolments, the class read the portal walks, and the providers answer', async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const created = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .send({ title: 'Lesson Copy', slug: 'lesson-copy', fromVersionId: platform.publishedVersionId })
      .expect(201);
    const at = `/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}`;
    await request(http)
      .patch(`${at}/phases/requirements`)
      .set(bearer(teacher.token))
      .send({ intro: 'Lesson Copy keeps a small library of shared books. Start with what its readers need.' })
      .expect(200);
    const published = (await request(http).post(`${at}/publish`).set(bearer(teacher.token)).send({ version: '1.0.0' }).expect(200))
      .body as PublishVersionResult;
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Wednesday' }).expect(201);
    redactor.name(cohort.body.joinCode, 'join-code');
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`)
      .set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'Wednesday keeps the library this term.' })
      .expect(200);
    // A second class of the same teacher, so the class read has something to leave out.
    const other = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: 'Thursday' }).expect(201);
    redactor.name(other.body.joinCode, 'join-code-2');

    const inClass: string[] = [];
    let classToken = '';
    for (const [handle, name] of [
      ['class-one', 'Ixa Pellowmere'],
      ['class-two', 'Quon Adrevelle'],
      ['class-three', 'Yul Marrowgate'],
    ]) {
      const who = await account(handle, name);
      await request(http).post('/api/v1/enrollments/join').set(bearer(who.token)).send({ code: cohort.body.joinCode }).expect(200);
      await request(http).post('/api/v1/enrollments').set(bearer(who.token)).send({}).expect(201);
      inClass.push(who.id);
      classToken ||= who.token;
    }
    const elsewhere = await account('other-class', 'Wim Tarrowby');
    await request(http).post('/api/v1/enrollments/join').set(bearer(elsewhere.token)).send({ code: other.body.joinCode }).expect(200);
    await request(http).post('/api/v1/enrollments').set(bearer(elsewhere.token)).send({ projectSlug: platform.slug }).expect(201);

    const plain = await account('plain', 'Oru Vantelli');
    await request(http).post('/api/v1/enrollments').set(bearer(plain.token)).send({ projectSlug: platform.slug }).expect(201);

    const copyMine = (await request(http).get('/api/v1/enrollments/mine').query({ project: 'lesson-copy' }).set(bearer(classToken)).expect(200))
      .body as EnrollmentView;
    const defaultMine = (await request(http).get('/api/v1/enrollments/mine').query({ project: platform.slug }).set(bearer(plain.token)).expect(200))
      .body as EnrollmentView;
    expect(copyMine.projectIsDefault).toBe(false);
    expect(defaultMine.projectIsDefault).toBe(true);
    for (const summary of defaultMine.phases) expect([summary.key, summary.scenario]).toEqual([summary.key, 'reference']);
    expect(copyMine.phases.find((one) => one.key === 'requirements')!.scenario).toBe('mixed');

    const cohorts = (await request(http).get('/api/v1/instructor/cohorts').set(bearer(teacher.token)).expect(200)).body;
    const overview = (await request(http).get('/api/v1/instructor/overview').set(bearer(teacher.token)).expect(200)).body;
    const classPage = (
      await request(http).get('/api/v1/instructor/learners').query({ cohort: cohort.body.id, limit: 50 }).set(bearer(teacher.token)).expect(200)
    ).body as Array<{ userId: string; cohort: string | null }>;
    const scopePage = (await request(http).get('/api/v1/instructor/learners').query({ limit: 50 }).set(bearer(teacher.token)).expect(200))
      .body as Array<{ userId: string }>;
    expect(classPage.map((one) => one.userId)).toEqual([...inClass].sort());
    expect(new Set(classPage.map((one) => one.cohort))).toEqual(new Set([cohort.body.id]));
    expect(scopePage.map((one) => one.userId)).toEqual([...inClass, elsewhere.id].sort());

    const providers = (await request(http).get('/api/v1/auth/providers').expect(200)).body;
    expect(providers.authProvider).toBe('local');

    holdContract(
      'enrollment',
      'apps/api/test/enrollment-contract-wiring.e2e-spec.ts',
      {
        copyEnrollment: copyMine,
        defaultEnrollment: defaultMine,
        cohorts,
        overview,
        classLearners: classPage,
        scopeLearners: scopePage,
        classId: cohort.body.id,
        providers,
      },
      redactor,
    );
  }, 240000);
});
