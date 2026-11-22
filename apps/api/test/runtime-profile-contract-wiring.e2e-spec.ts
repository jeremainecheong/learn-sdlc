import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AUTHORING_ROUTES, COHORT_IMPORT_MAX_BYTES, RUNTIME_PROFILES } from '@learnsdlc/shared';
import type { RuntimeProfileView } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { ExchangeLog, Redactor, holdExchangeContract } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The one runtime profile, recorded through the real `AppModule` for
 * `apps/web/test/runtime-profile-wiring.test.tsx`.
 *
 * Recorded: the teacher's read of `runtime.profile` (its three allow-lists,
 * its name, the manifest digest as a `<sha256:n>` placeholder, and
 * `uploadMaxBytes`, the archive cap the upload page states), the same
 * read on a deployment that configured a 6 MiB cap (`IMPORT_MAX_BYTES`, read
 * per request), and a learner's read, refused.
 */
describe('the runtime profile, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  const priorCap = process.env.IMPORT_MAX_BYTES;
  /** 6 MiB: a configured cap the web's own default could not stand in for. */
  const SMALL_CAP = 6 * 1024 * 1024;

  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${handle}@rx-contract.test`, password: PASSWORD, displayName })
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
    delete process.env.IMPORT_MAX_BYTES;
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
    await app?.close();
  });

  it('confirms the stub AI before anything is driven (m8)', () => {
    expect((app.get(OpenAiProvider) as unknown as { name: string }).name).toBe('mock-ai');
  });

  it('records the teacher’s read (lists, name, digest, archive cap) and a learner’s refusal', async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const learner = await account('learner', 'Ixa Pellowmere');
    const at = `/api/v1${AUTHORING_ROUTES['runtime.profile'].path}`;
    expect(AUTHORING_ROUTES['runtime.profile'].method).toBe('GET');

    const res = await request(http).get(at).set(bearer(teacher.token)).expect(200);
    log.take('profile', 'GET', at, undefined, res);
    const profile = res.body as RuntimeProfileView;
    expect(profile.id).toBe(RUNTIME_PROFILES[0].id);
    expect(profile.name).toBe(RUNTIME_PROFILES[0].name);
    for (const list of [profile.python, profile.node, profile.tools]) expect(Array.isArray(list)).toBe(true);
    expect(profile.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    // The configured archive cap, in bytes of the archive (default = the class import's).
    expect(profile.uploadMaxBytes).toBe(COHORT_IMPORT_MAX_BYTES);
    // A scoped npm package (`@scope/name`) would put an `@` in the file; each
    // is held as `<npm:scope/name>`, the same everywhere it appears.
    for (const one of [...profile.python, ...profile.node, ...profile.tools]) {
      if (one.includes('@')) redactor.name(one, `npm:${one.replace(/@/g, '')}`);
    }

    // A deployment that configured a smaller cap: the read answers that number
    // (it is read per request), so the web can be shown to state the API's
    // cap rather than its own default.
    process.env.IMPORT_MAX_BYTES = String(SMALL_CAP);
    let small: RuntimeProfileView;
    try {
      const configured = await request(http).get(at).set(bearer(teacher.token)).expect(200);
      log.take('profileSmallCap', 'GET', at, undefined, configured);
      small = configured.body as RuntimeProfileView;
    } finally {
      delete process.env.IMPORT_MAX_BYTES;
    }
    expect(small.uploadMaxBytes).toBe(SMALL_CAP);

    const refused = await request(http).get(at).set(bearer(learner.token)).expect(403);
    log.take('profileLearner', 'GET', at, undefined, refused);

    holdExchangeContract(
      'runtime-profile',
      'apps/api/test/runtime-profile-contract-wiring.e2e-spec.ts',
      log,
      { uploadMaxBytes: profile.uploadMaxBytes, defaultCap: COHORT_IMPORT_MAX_BYTES, smallCap: SMALL_CAP },
      redactor,
    );
  }, 120000);
});
