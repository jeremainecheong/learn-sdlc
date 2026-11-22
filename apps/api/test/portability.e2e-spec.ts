import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { CohortExportDocument } from '@learnsdlc/shared';
import { COHORT_EXPORT_VERSION, COHORT_IMPORT_MAX_BYTES_HEADER } from '@learnsdlc/shared';
import { AuthService } from '../src/auth/auth.service';
import { CohortEntity, UserEntity } from '../src/db/entities';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/** Small enough that a test can go over it without moving 32 MB through a socket. */
const CAP = 65536;

/**
 * Class export and import over HTTP.
 *
 * The service's own rules are in `portability.service.spec.ts`. What is
 * asserted here is everything the unit spec cannot see: that both routes are
 * behind the instructor role guard, that a class belonging to somebody else is
 * a 404 rather than a 403, that the export arrives as a download with this
 * deployment's import ceiling on it, that a body over that ceiling is refused
 * by the body parser in a sentence rather than by body-parser in a phrase, and
 * that a dry run over the wire writes nothing while the real call writes a class.
 *
 * `configureApp` is mounted rather than a hand-rolled prefix, because the
 * path-scoped parser this feature depends on lives there and a spec that skips
 * it would prove nothing about the 413.
 */
describe('Class portability (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let ownerToken = '';
  let outsiderToken = '';
  let learnerToken = '';
  let cohortId = '';
  let joinCode = '';

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const email = `${name}-${stamp}@portability.test`;
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

  beforeAll(async () => {
    // Read by configureApp when it builds the scoped parser, so the ceiling
    // this suite exercises is one a test can actually exceed.
    process.env.IMPORT_MAX_BYTES = String(CAP);

    // The gate in front of the import parser verifies the bearer before a
    // byte is read; this suite mounts the real
    // AppModule, so it hands the gate the same check bootstrap does.
    ({ app, http } = await bootApi());
    db = app.get(DataSource);

    const owner = await account('chen', 'INSTRUCTOR');
    ownerToken = owner.token;
    const outsider = await account('okonkwo', 'INSTRUCTOR');
    outsiderToken = outsider.token;

    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(ownerToken))
      .send({ name: 'Section A' })
      .expect(201);
    cohortId = made.body.id;
    joinCode = made.body.joinCode;

    const learner = await account('ada');
    learnerToken = learner.token;
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(learnerToken))
      .send({ code: joinCode })
      .expect(200);
    await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learnerToken))
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
  });

  afterAll(async () => {
    delete process.env.IMPORT_MAX_BYTES;
    await app?.close();
  });

  /** The class as a document, taken the way the panel takes it. */
  const exportClass = async (): Promise<CohortExportDocument> => {
    const res = await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/export.json`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Section-A.json"');
    expect(res.headers[COHORT_IMPORT_MAX_BYTES_HEADER]).toBe(String(CAP));
    return res.body as CohortExportDocument;
  };

  it('hands the owner their class as a download and tells nobody else it exists', async () => {
    const document = await exportClass();
    expect(document.format).toBe('learnsdlc.cohort');
    // Version 3 is the format that carries a phase's task rows and a
    // revision's key. A class that has never seen an authored
    // task differs from its version-2 file in this integer and in one empty
    // string per revision, and in nothing else.
    expect(document.formatVersion).toBe(COHORT_EXPORT_VERSION);
    expect(COHORT_EXPORT_VERSION).toBe(3);
    expect(document.cohort.name).toBe('Section A');
    expect(document.counts.learners).toBe(1);
    expect(document.counts.phaseStates).toBe(6);
    expect(JSON.stringify(document)).not.toContain('passwordHash');

    await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/export.json`)
      .set(bearer(outsiderToken))
      .expect(404);
    // A learner is not staff, so the guard refuses before the service is asked.
    await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/export.json`)
      .set(bearer(learnerToken))
      .expect(403);
  });

  it('refuses a body over this deployment ceiling in a sentence, not a phrase', async () => {
    const res = await request(http)
      .post('/api/v1/instructor/cohorts/import')
      .set(bearer(ownerToken))
      .send({ format: 'learnsdlc.cohort', padding: 'x'.repeat(CAP * 2) })
      .expect(413);
    expect(res.body.message).toMatch(/An import accepts up to 64 KB/);
    expect(res.body.message).toMatch(/Export the class without the revision files/);
  });

  it('refuses a file that is not a class export, and one from a newer build', async () => {
    const notOne = await request(http)
      .post('/api/v1/instructor/cohorts/import')
      .set(bearer(ownerToken))
      .send({ hello: 'world' })
      .expect(400);
    expect(notOne.body.message).toMatch(/not a class export/);

    const document = await exportClass();
    const newer = await request(http)
      .post('/api/v1/instructor/cohorts/import')
      .set(bearer(ownerToken))
      .send({ ...document, formatVersion: 99 })
      .expect(400);
    expect(newer.body.message).toMatch(/newer version of LearnSDLC/);
  });

  it('writes nothing for a dry run, and a whole class for the real thing', async () => {
    const document = await exportClass();
    // As it would arrive from another laptop: a learner this machine has never
    // seen, so the import has an account to mint.
    document.learners[0].email = `grace-${stamp}@portability.test`;

    const before = await db.manager.count(CohortEntity);
    const preview = await request(http)
      .post('/api/v1/instructor/cohorts/import?dryRun=true')
      .set(bearer(ownerToken))
      .send(document as unknown as Record<string, unknown>)
      .expect(200);
    expect(preview.body.applied).toBe(false);
    expect(preview.body.cohort).toBeNull();
    expect(preview.body.createdAccounts).toEqual([`grace-${stamp}@portability.test`]);
    expect(await db.manager.count(CohortEntity)).toBe(before);

    const done = await request(http)
      .post('/api/v1/instructor/cohorts/import')
      .set(bearer(ownerToken))
      .send(document as unknown as Record<string, unknown>)
      .expect(200);
    expect(done.body.applied).toBe(true);
    expect(done.body.cohort.name).toBe('Section A');
    expect(done.body.cohort.id).not.toBe(cohortId);
    expect(done.body.cohort.joinCode).not.toBe(joinCode);
    expect(await db.manager.count(CohortEntity)).toBe(before + 1);

    const classes = await request(http)
      .get('/api/v1/instructor/cohorts')
      .set(bearer(ownerToken))
      .expect(200);
    expect(classes.body).toHaveLength(2);

    // And the same file a second time is refused rather than silently doubled.
    await request(http)
      .post('/api/v1/instructor/cohorts/import')
      .set(bearer(ownerToken))
      .send(document as unknown as Record<string, unknown>)
      .expect(409);
  });
});
