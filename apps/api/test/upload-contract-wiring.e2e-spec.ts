import * as fs from 'fs';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AUTHORING_ROUTES, UPLOAD_REFUSALS, UPLOAD_REFUSAL_DETAIL_MAX } from '@learnsdlc/shared';
import type { ProjectUploadRefusal, ProjectUploadResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { HOSTILE_BY_NAME } from './fixtures/upload-packs/hostile';
import { ALL_SHELF_MARKERS } from './fixtures/upload-packs/markers';
import { mockAiForRoutes } from './mock-ai';
import { leaksIn } from './fixtures/contract-bodies/recorder';
import { CONTRACT_UPLOAD_ARCHIVES } from './fixtures/contract-exchanges/archives';
import { ExchangeLog, CONTRACT_EXCHANGES_DIR, Redactor, holdExchangeContract, exchangeRecordingNames, exchangeRecordingPath } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The upload door, recorded through the real `AppModule` for
 * `apps/web/test/upload-wiring.test.tsx`.
 *
 * Recorded, in the order a teacher meets them: the runtime-profile read the
 * door makes first (its archive cap), four refusals and one acceptance (five
 * uploads: the door's five a minute per teacher):
 *
 * - hostile `runtime-outside-allow-lists`: refused by the profile's sentence,
 *   and a `detail` naming the package;
 * - hostile `run-timeout-above-limit`: a run-shape refusal with findings;
 * - hostile `path-traversal`: a hostile archive refused by its code's sentence;
 * - the Shelf pack with a manifest the loader rejects: `NOT_A_PACK`, the fixed
 *   sentence, and a `detail` (the loader's cleaned-up text, at most
 *   `UPLOAD_REFUSAL_DETAIL_MAX` characters, never a byte of a file);
 * - the Shelf pack as it is: 201, a draft the teacher owns.
 *
 * The archive in each request body is held by name and size, never as bytes
 * (`<archive:...>`): the web test rebuilds the same archive from the same
 * fixture and checks the page sent exactly those bytes.
 *
 * The second describe is the redaction test: no file under
 * `fixtures/contract-exchanges/` holds `@`, `eyJ` or a 64-hex string. It lives here
 * because the upload recording is always present.
 */
describe('the upload door, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  const priorCap = process.env.IMPORT_MAX_BYTES;
  let address = 0;
  /** Each upload from its own address, so the door's per-address gate measures the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.88.0.${++address}` });

  /** The archives, by the name the web test rebuilds them by (`contract-exchanges/archives.ts`). */
  const ARCHIVES = CONTRACT_UPLOAD_ARCHIVES;

  beforeAll(async () => {
    delete process.env.IMPORT_MAX_BYTES;
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true }));
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

  it('records the profile read, four refusals and the accepted draft', async () => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: 'teacher@rx-contract.test', password: PASSWORD, displayName: 'Zeb Quorrant' })
      .expect(201);
    redactor.name('Zeb Quorrant', 'name:teacher');
    const teacher = { id: registered.body.user.id as string, token: registered.body.token as string };
    await db.manager.update(UserEntity, { id: teacher.id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(teacher.id);

    const profileAt = `/api/v1${AUTHORING_ROUTES['runtime.profile'].path}`;
    const profile = await request(http).get(profileAt).set(bearer(teacher.token)).expect(200);
    for (const one of [...profile.body.python, ...profile.body.node, ...profile.body.tools] as string[]) {
      if (one.includes('@')) redactor.name(one, `npm:${one.replace(/@/g, '')}`);
    }
    log.take('profile', 'GET', profileAt, undefined, profile);

    const at = `/api/v1${AUTHORING_ROUTES['projects.upload'].path}`;
    expect(AUTHORING_ROUTES['projects.upload'].method).toBe('POST');
    const said: string[] = [];
    const sizes: Record<string, number> = {};
    const upload = async (name: string, archive: string, title: string) => {
      const bytes = ARCHIVES[archive]();
      sizes[archive] = bytes.length;
      const res = await request(http)
        .post(at)
        .set(bearer(teacher.token))
        .set(from())
        .send({ title, archiveBase64: bytes.toString('base64') });
      said.push(res.text);
      // The archive is held by name and size; the web rebuilds it from the same fixture.
      log.take(name, 'POST', at, { title, archiveBase64: `<archive:${archive}>` }, res);
      return res;
    };

    const runtime = await upload('refusedRuntime', 'fix2:runtime-outside-allow-lists', 'Books on a shelf');
    expect(runtime.status).toBeGreaterThanOrEqual(400);
    expect(runtime.status).toBeLessThan(500);
    const runtimeBody = runtime.body as ProjectUploadRefusal;
    expect(runtimeBody.code).toBe(HOSTILE_BY_NAME.get('runtime-outside-allow-lists')!.expectedUploadCode);
    expect(runtimeBody.sentence).toBe(UPLOAD_REFUSALS[runtimeBody.code]);
    // The package the profile does not bake is named in `detail`, never in `sentence`.
    expect(runtimeBody.detail).toMatch(/^project\.runtime asks for requests, which is outside the runtime this deployment bakes\./);
    expect(runtimeBody.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
    expect(runtimeBody.sentence).not.toContain('requests');

    const runShape = await upload('refusedRunShape', 'fix2:run-timeout-above-limit', 'Books on a shelf');
    const runShapeBody = runShape.body as ProjectUploadRefusal;
    expect(runShapeBody.code).toBe(HOSTILE_BY_NAME.get('run-timeout-above-limit')!.expectedUploadCode);
    expect(runShapeBody.sentence).toBe(UPLOAD_REFUSALS[runShapeBody.code]);
    expect(runShapeBody.findings.length).toBeGreaterThan(0);

    const climb = await upload('refusedPathClimb', 'fix2:path-traversal', 'Books on a shelf');
    expect((climb.body as ProjectUploadRefusal).code).toBe('PATH_CLIMB');
    expect((climb.body as ProjectUploadRefusal).sentence).toBe(UPLOAD_REFUSALS.PATH_CLIMB);

    const notPack = await upload('refusedNotAPack', 'fix1:manifest-version-invalid', 'Books on a shelf');
    const notPackBody = notPack.body as ProjectUploadRefusal;
    expect(notPackBody.code).toBe('NOT_A_PACK');
    expect(notPackBody.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
    // The loader's own words travel in `detail`, never in `sentence`.
    expect(typeof notPackBody.detail).toBe('string');
    expect(notPackBody.detail!.length).toBeGreaterThan(0);
    expect(notPackBody.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);

    const accepted = await upload('accepted', 'fix1', 'Books on a shelf');
    expect(accepted.status).toBe(201);
    const made = accepted.body as ProjectUploadResult;
    expect(made.slug).toMatch(/^books-on-a-shelf/);
    expect(made.version).toBeTruthy();

    // No answer carried a sealed byte of the Shelf pack.
    expect(ALL_SHELF_MARKERS.filter((marker) => said.join('\n').includes(marker))).toEqual([]);

    holdExchangeContract(
      'upload',
      'apps/api/test/upload-contract-wiring.e2e-spec.ts',
      log,
      { projectId: made.projectId, versionId: made.versionId, archiveBytes: sizes, uploadMaxBytes: profile.body.uploadMaxBytes },
      redactor,
    );
  }, 240000);
});

describe('no contract recording holds an address, a token or a digest', () => {
  it('every recording (*.json) under fixtures/contract-exchanges/ is free of "@", "eyJ" and any 64-hex string', () => {
    const names = exchangeRecordingNames();
    // The recorded seams. These four must be there; the sign-off and
    // quiz-results recordings are scanned when present and not required.
    expect(names.length).toBeGreaterThan(0);
    expect(['upload', 'runtime-profile', 'sealed', 'deep-validation'].filter((name) => !names.includes(name))).toEqual([]);
    const found: Record<string, string[]> = {};
    for (const name of names) {
      const text = fs.readFileSync(exchangeRecordingPath(name), 'utf-8');
      // The contract-bodies check: '@', 'eyJ', a 64-hex string, and (stricter) a raw uuid.
      const leaks = leaksIn(text);
      if (leaks.length) found[name] = leaks;
    }
    expect(found).toEqual({});
    expect(CONTRACT_EXCHANGES_DIR.endsWith('contract-exchanges')).toBe(true);
  });

  it('vacuity: the same check finds each of the three in a body that holds it', () => {
    expect(leaksIn(JSON.stringify({ body: 'someone@example.test' }))).toContain('@');
    expect(leaksIn(JSON.stringify({ body: 'eyJhbGciOi.x.y' }))).toContain('eyJ');
    expect(leaksIn(JSON.stringify({ body: 'a'.repeat(64) }))).toContain('64-hex');
    expect(leaksIn(JSON.stringify({ body: '<sha256:1> <email:1> <jwt>' }))).toEqual([]);
  });
});
