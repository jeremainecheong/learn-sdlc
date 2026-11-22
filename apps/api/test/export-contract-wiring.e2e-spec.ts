import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AUTHORING_ROUTES } from '@learnsdlc/shared';
import type { ProjectUploadResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { EXPORT_REFUSALS } from '../src/authoring/export.service';
import { readZip, zipLimits } from '../src/content/zip-reader';
import { config } from '../src/config';
import { UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { zipDirectory } from './fixtures/upload-packs/archive';
import { ALL_SHELF_MARKERS, SHELF_DIR } from './fixtures/upload-packs/markers';
import { storeTaskTypeEdit } from './stored-task-edit';
import { ExchangeLog, EXCHANGES_RECORDING, Redactor, holdExchangeContract } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The export door (the export half of the export ↔ upload round trip),
 * recorded through the real `AppModule` for
 * `apps/web/test/export-wiring.test.tsx`.
 *
 * Recorded, as a teacher meets them on the version page:
 *
 * - `exported`: the Shelf pack uploaded by its teacher and exported: 200
 *   `application/zip`, `Content-Disposition: attachment;
 *   filename="<slug>-<version>.zip"`, `Cache-Control: no-store`,
 *   `x-export-withheld: 0`;
 * - `exportedCopy`: a copy of the platform project exported by the teacher who
 *   made it: 200 with `x-export-withheld` > 0 (the inherited sealed files are
 *   left out);
 * - `refusedTaskEdited`: a second upload whose Requirements task the teacher
 *   changed what it hands in (its artefact type) in the editor: 409, the
 *   read-back's `taskDrift` sentence as JSON, because the folder layout writes
 *   no artefact type and reads the phase back as its own task (every builder
 *   edit it does carry, and that exports 200);
 * - `refusedNotOwner`: another teacher asks for the first export: 404 JSON;
 * - `refusedLearner`: a learner asks: 403 JSON.
 *
 * **The archive is never recorded.** It holds the owner's sealed files, so the
 * exchange keeps its status and the headers the page reads, and its body is
 * the placeholder `<archive>` (the web test hands the page those bytes).
 *
 * The redactor is the recorder's (`fixtures/contract-exchanges/recorder.ts`,
 * read-only): ids `<uuid:n>`, the display names `<name:…>`; and the recorder
 * refuses to write a file that holds `@`, `eyJ`, a 64-hex string or a uuid.
 * `CONTRACT_EXCHANGES_RECORD=1` (inline) rewrites `fixtures/contract-exchanges/export.json`;
 * without it this spec replays the scenario and checks every exchange's shape.
 *
 * The stub AI (`mockAiForRoutes`) stands in for the provider; no sandbox job
 * is run (nothing here grades or deep-validates). The only server is one
 * listener on loopback at an ephemeral port (`app.listen(0, '127.0.0.1')`),
 * which every request reuses and `app.close()` closes: supertest never opens
 * a server of its own per request.
 */
describe('the export door, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  const HEADERS = ['content-type', 'content-disposition', 'cache-control', 'x-export-withheld'];
  let address = 0;
  /** Each request from its own address, so per-address gates measure the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.92.0.${++address}` });
  const priorCap = process.env.IMPORT_MAX_BYTES;

  /** supertest's body as the raw bytes, whatever the content type. */
  const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  const account = async (handle: string, displayName: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${handle}@rx-contract.test`, password: PASSWORD, displayName })
      .expect(201);
    redactor.name(displayName, `name:${handle}`);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const exportPath = (projectId: string, versionId: string) =>
    `/api/v1${AUTHORING_ROUTES['version.export'].path.replace(':projectId', projectId).replace(':versionId', versionId)}`;

  /** One export through the real door, kept as an exchange; an archive is kept as `<archive>`, never its bytes. */
  const exportAs = async (name: string, token: string, projectId: string, versionId: string) => {
    const url = exportPath(projectId, versionId);
    const res = await request(http).get(url).set(bearer(token)).set(from()).buffer(true).parse(binary as never);
    const bytes = res.body as Buffer;
    const zip = String(res.headers['content-type'] ?? '').startsWith('application/zip');
    const json = zip ? undefined : JSON.parse(bytes.toString('utf-8'));
    log.take(name, 'GET', url, undefined, { status: res.status, body: json, text: zip ? '<archive>' : bytes.toString('utf-8'), headers: res.headers }, HEADERS);
    return { res, bytes, json };
  };

  const upload = async (token: string, title: string) => {
    const res = await request(http)
      .post(`/api/v1${AUTHORING_ROUTES['projects.upload'].path}`)
      .set(bearer(token))
      .set(from())
      .send({ title, archiveBase64: zipDirectory(SHELF_DIR).toString('base64') });
    expect({ status: res.status, code: res.body?.code, message: res.status === 201 ? null : res.body?.message }).toEqual({ status: 201, code: undefined, message: null });
    return res.body as ProjectUploadResult;
  };

  beforeAll(async () => {
    delete process.env.IMPORT_MAX_BYTES;
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    // One listening server on loopback, an ephemeral port, closed by app.close.
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true, listen: true }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
  });

  it('confirms the stub AI before anything is driven (m8)', () => {
    expect(app.get(OpenAiProvider)).toBe(mockAiForRoutes);
    expect(http.address()).toEqual(expect.objectContaining({ address: '127.0.0.1' }));
  });

  it(`${EXCHANGES_RECORDING ? 'records' : 'replays'} the export, a copy's export, a task-edited refusal, a stranger's 404 and a learner's 403`, async () => {
    const teacher = await account('teacher', 'Zeb Quorrant', 'INSTRUCTOR');
    const stranger = await account('stranger', 'Oda Venwick', 'INSTRUCTOR');
    const learner = await account('learner', 'Ixa Pellowmere');

    // The Shelf pack, exported by its teacher.
    const shelf = await upload(teacher.token, 'Books on a shelf');
    const exported = await exportAs('exported', teacher.token, shelf.projectId, shelf.versionId);
    expect(exported.res.status).toBe(200);
    expect(exported.res.headers['content-type']).toBe('application/zip');
    expect(exported.res.headers['cache-control']).toBe('no-store');
    expect(exported.res.headers['content-disposition']).toBe(`attachment; filename="${shelf.slug}-${shelf.version}.zip"`);
    expect(exported.res.headers['x-export-withheld']).toBe('0');
    expect(readZip(exported.bytes, zipLimits(config.importMaxBytes)).length).toBeGreaterThan(0);

    // A copy of the platform project withholds the sealed files it inherited.
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).set(from()).expect(200);
    const platform = (library.body.library as { isDefault: boolean; publishedVersionId: string }[]).find((one) => one.isDefault)!;
    const copy = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacher.token))
      .set(from())
      .send({ title: 'Copied for the class', slug: 'copied-for-the-class', fromVersionId: platform.publishedVersionId });
    expect({ status: copy.status, message: copy.status === 201 ? null : copy.body?.message }).toEqual({ status: 201, message: null });
    const copied = await exportAs('exportedCopy', teacher.token, copy.body.project.id, copy.body.draftVersionId);
    expect(copied.res.status).toBe(200);
    expect(Number(copied.res.headers['x-export-withheld'])).toBeGreaterThan(0);

    // What a task hands in (its artefact type) is an edit the folder layout cannot carry: 409, the read-back's
    // drift naming the phase. (The upload's title is part of the recording, through its slug, so it keeps its words.)
    const edited = await upload(teacher.token, 'Books on a shelf, reworded');
    // stored as an older editor could leave it: no editor save moves a story task's type any more (not an exchange)
    await storeTaskTypeEdit(db, edited.versionId, 'requirements', 'document');
    const refused = await exportAs('refusedTaskEdited', teacher.token, edited.projectId, edited.versionId);
    expect(refused.res.status).toBe(409);
    expect(refused.json.message).toBe(`${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift('Requirements')}.`);

    // Nobody else exports it.
    const theirs = await exportAs('refusedNotOwner', stranger.token, shelf.projectId, shelf.versionId);
    expect(theirs.res.status).toBe(404);
    const learners = await exportAs('refusedLearner', learner.token, shelf.projectId, shelf.versionId);
    expect(learners.res.status).toBe(403);

    // No exchange holds a byte of the archive, and no answer holds a sealed marker.
    const said = log.exchanges.map((one) => JSON.stringify(one)).join('\n');
    expect(ALL_SHELF_MARKERS.filter((marker) => said.includes(marker))).toEqual([]);
    expect(log.exchanges.filter((one) => one.status === 200).map((one) => one.body)).toEqual([
      { contentType: 'application/zip', text: '<archive>' },
      { contentType: 'application/zip', text: '<archive>' },
    ]);

    const { live, recorded } = holdExchangeContract(
      'export',
      'apps/api/test/export-contract-wiring.e2e-spec.ts',
      log,
      {
        projectId: shelf.projectId,
        versionId: shelf.versionId,
        slug: shelf.slug,
        version: shelf.version,
        copyProjectId: copy.body.project.id,
        copyVersionId: copy.body.draftVersionId,
        copySlug: 'copied-for-the-class',
        editedProjectId: edited.projectId,
        editedVersionId: edited.versionId,
        editedSlug: edited.slug,
      },
      redactor,
    );
    // Replayed (no flag): the recording is the one on disk, exchange for exchange.
    expect(recorded.exchanges.map((one) => [one.name, one.method, one.status])).toEqual(live.exchanges.map((one) => [one.name, one.method, one.status]));
    expect(recorded.exchanges.find((one) => one.name === 'exported')?.headers).toEqual(live.exchanges.find((one) => one.name === 'exported')?.headers);
  }, 240000);
});
