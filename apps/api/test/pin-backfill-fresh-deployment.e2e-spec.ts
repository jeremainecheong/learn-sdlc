import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { ContentService } from '../src/content/content.service';
import { EnrollmentEntity, ProjectEntity, ProjectVersionEntity } from '../src/db/entities';
import { H9PinLegacyEnrolments1789800100000 } from '../src/migrations/1789800100000-H9-PinLegacyEnrolments';
import { mockAiForRoutes } from './mock-ai';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * A null-pin TaskTrackr learner (an enrolment written before H2 gave the pin
 * a column) on a fresh deployment of the shipped pack. H9 pins such a row to
 * the published 2.0.1, and only where 2.0.1 is published: TaskTrackr ships
 * 6.0.0 now, so a fresh deployment holds no 2.0.1, the statement's guard makes
 * it a no-op, and the row keeps resolving to the published head.
 *
 * The pinning itself, and the no-op on a database without 2.0.1, are proved
 * row by row in `pin-backfill-migration-cases.ts`; this case proves the premise those
 * cases rest on holds for the real app's seed.
 */
describe('H9 on a fresh deployment of the shipped pack', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  it('is a no-op where no 2.0.1 is published: the null row stays null and resolves to the 6.0.0 head', async () => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `legacy-${stamp}@h9.test`, password: 'Correct-Horse-9', displayName: 'Legacy' })
      .expect(201);
    const token = registered.body.token as string;
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set({ authorization: `Bearer ${token}` })
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    const enrollmentId = enrolled.body.id as string;
    // The row as written before H2: no pin.
    await db.getRepository(EnrollmentEntity).update({ id: enrollmentId }, { projectVersionId: null });

    const content = app.get(ContentService);
    const resolved = async () => {
      const enrollment = await db.getRepository(EnrollmentEntity).findOneByOrFail({ id: enrollmentId });
      return { pin: enrollment.projectVersionId, version: content.getForEnrollment(enrollment).version };
    };

    expect(await resolved()).toEqual({ pin: null, version: '6.0.0' });
    const project = await db.getRepository(ProjectEntity).findOneByOrFail({ slug: 'tasktrackr' });
    expect(
      await db.getRepository(ProjectVersionEntity).countBy({ projectId: project.id, version: '2.0.1', status: 'published' }),
    ).toBe(0);

    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await new H9PinLegacyEnrolments1789800100000().up(runner);
    } finally {
      await runner.release();
    }

    expect(await resolved()).toEqual({ pin: null, version: '6.0.0' });
  }, 120000);
});
