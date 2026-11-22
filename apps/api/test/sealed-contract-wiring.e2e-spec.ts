import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AUTHORING_ROUTES, CHANGE_REQUEST_JSON, RUNBOOK_JSON } from '@learnsdlc/shared';
import type { DraftVersionView, ExecutableTaskView, SealedFileView, SealedFileWriteBody } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/db/entities';
import { ALL_SHELF_MARKERS } from './fixtures/upload-packs/markers';
import { mockAiForRoutes } from './mock-ai';
import { CONTRACT_UPLOAD_ARCHIVES } from './fixtures/contract-exchanges/archives';
import { CONTRACT_SEALED_FILES } from './fixtures/contract-exchanges/sealed-files';
import { ExchangeLog, Redactor, holdExchangeContract } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The seal (sealed files are write-only to the editor), recorded through the
 * real `AppModule` for
 * `apps/web/test/sealed-upload-wiring.test.tsx`.
 *
 * The Shelf pack uploaded through the real door by a teacher, so the draft is the real
 * `UploadService` + `importTeacherDraft` answer. Recorded:
 *
 * - the draft read the editor opens on (`version.draft`): the implementation
 *   phase's executable task, every sealed member a `SealedFileView` (path,
 *   digest, size) and nothing else;
 * - a `sealed.write` of a new hidden test into the implementation task's
 *   first run (accepted: path, digest, size, never the bytes);
 * - a `sealed.write` whose path climbs out of the task's folder (refused, by
 *   sentence);
 * - the draft read again after the seal (the editor reads it to redraw);
 * - a hidden test sealed into the task's second run, and the
 *   draft after it (the file sits in that run, not the first);
 * - the editor's save under the editability rule (`{ runs }`, each
 *   run's shape and learner files echoed; never `owns`), accepted; a save
 *   naming `owns`, refused by sentence; a save changing a run's shape, and
 *   one giving the code task's run learner test files, each refused by
 *   sentence; and the draft after the save.
 *
 * The bytes a teacher seals are the fixture's (`contract-exchanges/sealed-files.ts`)
 * and are held in the recording by name (`<sealed:NAME>`), never as bytes or
 * base64; the web test builds the same bytes and checks the page sent exactly
 * those. Digests are `<sha256:n>` placeholders, one per digest.
 */
describe('the seal, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  /** The first run's label after the editor's save. */
  const SAVED_LABEL = 'API tests, as the class reads them';

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  it('confirms the stub AI before anything is driven (m8)', () => {
    expect((app.get(OpenAiProvider) as unknown as { name: string }).name).toBe('mock-ai');
  });

  it('records the draft’s sealed views, an accepted seal, a refused seal and the draft after', async () => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'teacher@rx-contract.test', password: PASSWORD, displayName: 'Zeb Quorrant' })
      .expect(201);
    redactor.name('Zeb Quorrant', 'name:teacher');
    const teacher = { id: registered.body.user.id as string, token: registered.body.token as string };
    await db.manager.update(UserEntity, { id: teacher.id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(teacher.id);

    const uploaded = await request(http)
      .post(`/api/v1${AUTHORING_ROUTES['projects.upload'].path}`)
      .set(bearer(teacher.token))
      .send({ title: 'Books on a shelf', archiveBase64: CONTRACT_UPLOAD_ARCHIVES.fix1().toString('base64') })
      .expect(201);
    const { projectId, versionId } = uploaded.body as { projectId: string; versionId: string };
    const said: string[] = [];

    const draftAt = `/api/v1${AUTHORING_ROUTES['version.draft'].path.replace(':projectId', projectId).replace(':versionId', versionId)}`;
    const readDraft = async (name: string) => {
      const res = await request(http).get(draftAt).set(bearer(teacher.token)).expect(200);
      said.push(res.text);
      log.take(name, 'GET', draftAt, undefined, res);
      return res.body as DraftVersionView;
    };

    const draft = await readDraft('draft');
    // The editor's deep-validation panel reads its state beside the draft.
    const deepAt = `/api/v1${AUTHORING_ROUTES['deepValidation.read'].path.replace(':projectId', projectId).replace(':versionId', versionId)}`;
    const deep = await request(http).get(deepAt).set(bearer(teacher.token)).expect(200);
    said.push(deep.text);
    log.take('deepValidation', 'GET', deepAt, undefined, deep);
    // The editor reads the file rows once at load when the draft carries a runbook or a change request, as
    // Shelf's Deployment and Maintenance do since their records (TaskTrackr 5.0.0's task).
    const filesAt = `/api/v1${AUTHORING_ROUTES['files.list'].path.replace(':projectId', projectId).replace(':versionId', versionId)}`;
    const files = await request(http).get(filesAt).set(bearer(teacher.token)).expect(200);
    said.push(files.text);
    // Recorded as the two rows that load reads (the starting runbook and change request): the other rows are the
    // application's source, which the recording's own guard keeps out, and nothing in the seal's replay reads them.
    const starting = (files.body as { phaseKey: string; path: string }[])
      .filter((row) => (row.phaseKey === 'deployment' && row.path === RUNBOOK_JSON) || (row.phaseKey === 'maintenance' && row.path === CHANGE_REQUEST_JSON));
    expect(starting).toHaveLength(2);
    log.take('draftFiles', 'GET', filesAt, undefined, { ...files, body: starting, text: JSON.stringify(starting) });
    const implementation = draft.phases.find((one) => one.key === 'implementation')!;
    const task = implementation.tasks.find((one) => one.executable)!;
    const exec = task.executable as ExecutableTaskView;
    expect(exec.checkKind).toBe('code');
    // Every sealed member is a view: path, digest, size. Nothing else.
    for (const view of [...exec.solution, ...exec.runs.flatMap((run) => run.hidden)]) {
      expect(Object.keys(view).sort()).toEqual(['bytes', 'path', 'sha256']);
    }
    const run = exec.runs[0];

    const sealedAt = `/api/v1${AUTHORING_ROUTES['sealed.write'].path
      .replace(':projectId', projectId)
      .replace(':versionId', versionId)
      .replace(':phaseKey', 'implementation')
      .replace(':taskKey', task.taskKey)}`;
    expect(AUTHORING_ROUTES['sealed.write'].method).toBe('PUT');
    const seal = async (name: string, file: keyof typeof CONTRACT_SEALED_FILES, body: Omit<SealedFileWriteBody, 'contentBase64'>, status: number) => {
      const res = await request(http)
        .put(sealedAt)
        .set(bearer(teacher.token))
        .send({ ...body, contentBase64: CONTRACT_SEALED_FILES[file]().toString('base64') })
        .expect(status);
      said.push(res.text);
      log.take(name, 'PUT', sealedAt, { ...body, contentBase64: `<sealed:${file}>` }, res);
      return res.body;
    };

    const written = (await seal('sealHidden', 'hidden-extra', { role: 'hidden', runId: run.id, path: 'tests/test_wire_extra.py' }, 200)) as SealedFileView;
    expect(Object.keys(written).sort()).toEqual(['bytes', 'path', 'sha256']);
    expect(written.bytes).toBe(CONTRACT_SEALED_FILES['hidden-extra']().length);
    const refused = await seal('sealRefused', 'hidden-extra', { role: 'hidden', runId: run.id, path: '../outside.py' }, 400);
    expect(typeof refused.message).toBe('string');

    const after = await readDraft('draftAfterSeal');
    const afterExec = after.phases.find((one) => one.key === 'implementation')!.tasks.find((one) => one.executable)!.executable!;
    const hidden = afterExec.runs.find((one) => one.id === run.id)!.hidden;
    expect(hidden.some((one) => one.sha256 === written.sha256 && one.bytes === written.bytes)).toBe(true);

    // The second run's suite is sealed into that run, not the first.
    const second = exec.runs[1];
    expect(second).toBeDefined();
    const writtenTwo = (await seal('sealHiddenRun2', 'hidden-extra-web', { role: 'hidden', runId: second.id, path: 'web/src/lib/wire.hidden.test.ts' }, 200)) as SealedFileView;
    const afterTwo = await readDraft('draftAfterSealRun2');
    const runsTwo = afterTwo.phases.find((one) => one.key === 'implementation')!.tasks.find((one) => one.executable)!.executable!.runs;
    expect(runsTwo.find((one) => one.id === second.id)!.hidden.some((one) => one.sha256 === writtenTwo.sha256)).toBe(true);
    expect(runsTwo.find((one) => one.id === run.id)!.hidden.some((one) => one.sha256 === writtenTwo.sha256)).toBe(false);

    // The editability rule (`editedExecutableSlice`): the
    // editor's save is `{ runs }` on a code task (the brief is the builder's
    // Brief step's), each run echoing its shape and learner files as
    // the API answered them; it never sends `owns`.
    const updateAt = `/api/v1${AUTHORING_ROUTES['tasks.update'].path
      .replace(':projectId', projectId)
      .replace(':versionId', versionId)
      .replace(':phaseKey', 'implementation')
      .replace(':taskKey', task.taskKey)}`;
    expect(AUTHORING_ROUTES['tasks.update'].method).toBe('PATCH');
    const current = runsTwo;
    const saveBody = {
      runs: current.map((one, at) => ({
        id: one.id,
        shape: one.shape,
        label: at === 0 ? SAVED_LABEL : one.label,
        testPaths: one.testPaths,
        visibleTests: one.visibleTests,
        learnerTestFiles: one.learnerTestFiles,
      })),
    };
    const saved = await request(http).patch(updateAt).set(bearer(teacher.token)).send(saveBody).expect(200);
    said.push(saved.text);
    log.take('saveExecutable', 'PATCH', updateAt, saveBody, saved);
    // What the editor never sends, the API refuses: the editable files are the upload's.
    const ownsRefused = await request(http)
      .patch(updateAt)
      .set(bearer(teacher.token))
      .send({ owns: ['api/elsewhere.py'] })
      .expect(400);
    said.push(ownsRefused.text);
    log.take('saveOwnsRefused', 'PATCH', updateAt, { owns: ['api/elsewhere.py'] }, ownsRefused);
    // The other two members the editor draws read-only: a run's shape and a
    // run's learner test files. A save that changes either is refused by
    // sentence, so the editor echoes both exactly as the draft answered them.
    const otherShape = current[0].shape === 'run-python-hidden' ? 'run-python' : 'run-python-hidden';
    const shapeBody = { ...saveBody, runs: saveBody.runs.map((one, at) => (at === 0 ? { ...one, shape: otherShape } : one)) };
    const shapeRefused = await request(http).patch(updateAt).set(bearer(teacher.token)).send(shapeBody).expect(400);
    expect(String(shapeRefused.body.message)).toContain('run shape');
    said.push(shapeRefused.text);
    log.take('saveShapeRefused', 'PATCH', updateAt, shapeBody, shapeRefused);
    const learnerBody = {
      ...saveBody,
      runs: saveBody.runs.map((one, at) => (at === 0 ? { ...one, learnerTestFiles: ['api/test_mine.py'] } : one)),
    };
    const learnerRefused = await request(http).patch(updateAt).set(bearer(teacher.token)).send(learnerBody).expect(400);
    expect(typeof learnerRefused.body.message).toBe('string');
    said.push(learnerRefused.text);
    log.take('saveLearnerFilesRefused', 'PATCH', updateAt, learnerBody, learnerRefused);
    const afterSave = await readDraft('draftAfterSave');
    const savedRuns = afterSave.phases.find((one) => one.key === 'implementation')!.tasks.find((one) => one.executable)!.executable!.runs;
    expect(savedRuns[0].label).toBe(SAVED_LABEL);

    // No answer carried a sealed byte: neither the Shelf pack's markers nor the bytes just sealed.
    const text = said.join('\n');
    expect(ALL_SHELF_MARKERS.filter((marker) => text.includes(marker))).toEqual([]);
    expect(text).not.toContain(CONTRACT_SEALED_FILES['hidden-extra']().toString('utf-8').trim());
    expect(text).not.toContain(CONTRACT_SEALED_FILES['hidden-extra']().toString('base64'));
    expect(text).not.toContain(CONTRACT_SEALED_FILES['hidden-extra-web']().toString('base64'));

    holdExchangeContract(
      'sealed',
      'apps/api/test/sealed-contract-wiring.e2e-spec.ts',
      log,
      { projectId, versionId, phaseKey: 'implementation', taskKey: task.taskKey, runId: run.id, secondRunId: second.id, savedLabel: SAVED_LABEL },
      redactor,
    );
  }, 240000);
});
