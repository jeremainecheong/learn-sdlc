import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import type { RunResult } from '@learnsdlc/shared';
import { deepReceiptRefusal } from '../src/authoring/validation';
import { SEALED_REFUSALS } from '../src/authoring/sealed-roles';
import { DeepValidationService, hasCurrentDeepReceipt } from '../src/authoring/deep-validation';
import { UPLOAD_PATH, UploadService } from '../src/authoring/upload.service';
import { taskScopeOf } from '../src/assistant/project-scope';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { PhaseStateEntity, UserEntity } from '../src/db/entities';
import { ProjectEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectVersionEntity } from '../src/content/project.entities';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { SandboxService } from '../src/execution/sandbox.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { config } from '../src/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipDirectory } from './fixtures/upload-packs/archive';
import { SHELF_DIR, SHELF_MARKERS } from './fixtures/upload-packs/markers';
import { ProjectFileEntity as FileRow } from '../src/content/project.entities';
import { mockAiForRoutes } from './mock-ai';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';
import { OLDER_SHELF_DIR } from './fixtures/paths';

/** Shelf as it shipped in the older layout, for a case about an older archive. */

/**
 * The publish arm, mounted: publishing through the real AppModule and its
 * routes, and the editor's messages agreeing with publish.
 *
 * A teacher copies the reference project, edits the implementation's hidden
 * suite through the sealed door, and is told (by the fast tier as a warning,
 * and by publish as a refusal, in the same words) that the phase now needs a
 * current deep validation. The draft stays a draft. No AI call.
 *
 * The journey: the Shelf pack uploaded through the real route, its
 * implementation hidden suite edited, deep-validated and published, and a
 * learner graded against the new suite: on a stub sandbox transport and the
 * route-mocked AI provider.
 */
/** The archive cap this file boots with (well above the Shelf pack's archive), set before the app reads it. */
const SPEC_IMPORT_MAX_BYTES = 6 * 1024 * 1024;

describe('authoring executable phases, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();
  let address = 0;
  const from = () => ({ 'x-forwarded-for': `10.88.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  const teacher = async (n: number) => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `ae-${n}-${stamp}@authoring-executable.test`, password: 'Correct-Horse-9', displayName: `ae ${n}` })
      .expect(201);
    const id = registered.body.user.id as string;
    await db.manager.update(UserEntity, { id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(id);
    return { id, token: registered.body.token as string };
  };

  /*
   * The journey's stub sandbox. Only the transport is replaced: every job
   * still goes through `execute` under the
   * RunGate and the learner limits. A job is judged by its bytes against
   * `judged`, the snapshot the step under test runs (the draft while deep
   * validation runs, the published version while a learner is graded).
   * Before the journey sets `judged`, nothing in this file boots a job. The
   * static analyser (`analyze`, the same transport) answers clean, and while
   * a learner is graded a job that carries no sealed suite is the learner's
   * own visible run, which passes.
   */
  const payloads: Record<string, unknown>[] = [];
  let judged: CompiledSnapshot | null = null;
  let grading = false;
  const ok = (n = 4): RunResult => ({ ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] } });
  const bad = (n = 4): RunResult => ({ ok: false, exitKind: 'error', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n - 1, failed: 1, errored: 0, cases: [] } });
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.keys(a).every((k) => a[k] === b[k]);
  const judge = (job: SandboxJob): RunResult => {
    const phases = judged?.content.phases ?? [];
    if (job.mode === 'smoke') {
      const drill = phases.map((p) => (p.checks.kind === 'config' ? (p.checks as ConfigChecks).drill : undefined)).find(Boolean);
      const faulted = drill && Object.entries(drill.faultedFiles).some(([at, bytes]) => job.files[at] === bytes);
      return { ok: !faulted, exitKind: faulted ? 'error' : 'ok', stdout: '', stderr: '', durationMs: 1 };
    }
    if (job.gradedFiles) {
      const tests = phases.find((p) => p.checks.kind === 'tests')?.checks as TestsChecks | undefined;
      return tests?.runs.some((run) => same(job.gradedFiles!, run.implFiles)) ? ok() : bad();
    }
    for (const phase of phases) {
      if (phase.checks.kind !== 'code') continue;
      const checks = phase.checks as CodeChecks;
      // a run whose sealed suite is in the job byte for byte: the suite it grades against
      const run = checks.runs.find(
        (one) => Object.keys(one.hiddenTestFiles).length > 0 && Object.entries(one.hiddenTestFiles).every(([at, bytes]) => job.files[at] === bytes),
      );
      if (!run) continue;
      return Object.entries(checks.solutionFiles).every(([at, bytes]) => job.files[at] === bytes) ? ok() : bad();
    }
    return grading ? ok() : bad();
  };

  const priorCap = process.env.IMPORT_MAX_BYTES;

  beforeAll(async () => {
    process.env.IMPORT_MAX_BYTES = String(SPEC_IMPORT_MAX_BYTES);
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as Record<string, unknown>;
      if (String(args[0]).endsWith('analyzer.py')) {
        return JSON.stringify({ issues: [], metrics: { files: 1, functions: 1, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 } });
      }
      payloads.push(payload);
      return JSON.stringify(judge(payload as unknown as SandboxJob));
    });
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true }));
    db = app.get(DataSource);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
  });

  it('an edited hidden suite warns in the fast tier and refuses at publish, in the same words; the draft stays a draft', async () => {
    const owner = await teacher(1);
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const reference = (library.body.library as { publishedVersionId: string | null }[]).find((one) => one.publishedVersionId);
    expect(reference).toBeDefined();
    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(owner.token))
      .send({ title: 'Edited executable', slug: `edited-exec-${stamp}`, fromVersionId: reference!.publishedVersionId })
      .expect(201);
    const projectId = made.body.project.id as string;
    const versionId = made.body.draftVersionId as string;

    // a fresh, unedited copy asks for no deep validation
    const fresh = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/validate`)
      .set(bearer(owner.token))
      .expect(200);
    expect(fresh.body.blocking).toEqual([]);
    expect((fresh.body.checks as { id: string }[]).some((one) => one.id === 'deep-validation-current')).toBe(false);

    // the implementation's first hidden file, through the sealed door
    const phase = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'implementation' });
    const hiddenRow = (await db.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId, ownerId: phase.id, role: 'hidden' } }))
      .sort((a, b) => (a.path < b.path ? -1 : 1))[0];
    const hidden = hiddenRow.path.slice('hidden/'.length);
    const marker = `MARKER-AE-${stamp}`;
    const written = await request(http)
      .put(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/implementation/tasks/main/sealed`)
      .set(bearer(owner.token))
      .send({ role: 'hidden', runId: null, path: hidden, contentBase64: Buffer.from(`# ${marker}\nimport unittest\n`).toString('base64') })
      .expect(200);
    expect(Object.keys(written.body).sort()).toEqual(['bytes', 'path', 'sha256']);
    expect(JSON.stringify(written.body)).not.toContain(marker);

    const validated = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/validate`)
      .set(bearer(owner.token))
      .expect(200);
    expect(validated.body.blocking).toEqual([]);
    const warnings = (validated.body.checks as { id: string; advisory?: string; sentence: string }[]).filter((one) => one.advisory === 'warning');
    expect(warnings.map((one) => one.sentence)).toEqual(expect.arrayContaining([deepReceiptRefusal('Implementation')]));
    // no warning row is drawn for the executable scope
    expect((validated.body.checks as { id: string }[]).some((one) => one.id === 'executable-review-ready')).toBe(false);
    // no sealed byte in the editor's payloads
    const draft = await request(http).get(`/api/v1/instructor/projects/${projectId}/versions/${versionId}`).set(bearer(owner.token)).expect(200);
    const files = await request(http).get(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/files`).set(bearer(owner.token)).expect(200);
    expect(JSON.stringify(draft.body) + JSON.stringify(files.body) + JSON.stringify(validated.body)).not.toContain(marker);

    const refused = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/publish`)
      .set(bearer(owner.token))
      .send({ version: '1.0.0' })
      .expect(400);
    expect(String(refused.body.message)).toContain(deepReceiptRefusal('Implementation'));
    expect(String(refused.body.message)).not.toContain(marker);
    expect((await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).status).toBe('draft');
  });

  it("the run a teacher declares reaches SEAL over HTTP: another run is refused on write (400) and on read (404); another teacher's bad base64 is their 404", async () => {
    const owner = await teacher(3);
    const stranger = await teacher(4);
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const reference = (library.body.library as { publishedVersionId: string | null }[]).find((one) => one.publishedVersionId);
    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(owner.token))
      .send({ title: 'Declared run', slug: `declared-run-${stamp}`, fromVersionId: reference!.publishedVersionId })
      .expect(201);
    const projectId = made.body.project.id as string;
    const versionId = made.body.draftVersionId as string;
    const door = `/api/v1/instructor/projects/${projectId}/versions/${versionId}/phases/implementation/tasks/main/sealed`;
    const phase = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'implementation' });
    const hiddenRow = (await db.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId, ownerId: phase.id, role: 'hidden' } }))
      .sort((a, b) => (a.path < b.path ? -1 : 1))[0];
    const hidden = hiddenRow.path.slice('hidden/'.length);

    // an inherited row is not readable (the sealed door answers 403), so the owner writes it first, leaving the run for the door to choose
    const bytes = Buffer.from('import unittest\n# declared run\n').toString('base64');
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: null, path: hidden, contentBase64: bytes }).expect(200);
    const read = await request(http).get(door).query({ role: 'hidden', path: hidden }).set(bearer(owner.token)).expect(200);
    const runId = read.body.runId as string;
    expect(typeof runId).toBe('string');
    const other = `zz${runId}`.slice(0, 16);
    await request(http).get(door).query({ role: 'hidden', path: hidden, runId: other }).set(bearer(owner.token)).expect(404);
    await request(http).get(door).query({ role: 'hidden', path: hidden, runId }).set(bearer(owner.token)).expect(200);

    const refused = await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: other, path: hidden, contentBase64: bytes }).expect(400);
    expect(String(refused.body.message)).toContain(SEALED_REFUSALS.run);
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId, path: hidden, contentBase64: bytes }).expect(200);

    // who may write answers before what was sent
    await request(http).put(door).set(bearer(stranger.token)).send({ role: 'hidden', runId: null, path: hidden, contentBase64: '!!not base64!!' }).expect(404);
  });

  it('a runtime block that makes runtimeProfileRefusals throw is refused by sentence at validate and at publish (not a 500)', async () => {
    const owner = await teacher(6);
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(owner.token)).expect(200);
    const reference = (library.body.library as { publishedVersionId: string | null }[]).find((one) => one.publishedVersionId);
    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(owner.token))
      .send({ title: 'Unreadable profile', slug: `unreadable-profile-${stamp}`, fromVersionId: reference!.publishedVersionId })
      .expect(201);
    const base = `/api/v1/instructor/projects/${made.body.project.id}/versions/${made.body.draftVersionId}`;
    // the runner's manifest without the lock beside it (a missing runtime lock)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-s6-e2e-runner-'));
    fs.copyFileSync(path.join(config.runnerDir, 'runtime_manifest.py'), path.join(dir, 'runtime_manifest.py'));
    const held = config.runnerDir;
    (config as { runnerDir: string }).runnerDir = dir;
    try {
      const validated = await request(http).post(`${base}/validate`).set(bearer(owner.token));
      expect(validated.status).toBe(200);
      const sentence = (await import('../src/authoring/validation') as Record<string, unknown>).RUNTIME_PROFILE_UNREADABLE as string;
      expect(typeof sentence).toBe('string');
      expect(validated.body.blocking).toContain(sentence);
      const refused = await request(http).post(`${base}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' });
      expect(refused.status).toBe(400);
      expect(String(refused.body.message)).toContain(sentence);
      expect(validated.text + refused.text).not.toContain(dir);
      expect(validated.text + refused.text).not.toMatch(/runtime-locks|python-requirements/);
    } finally {
      (config as { runnerDir: string }).runnerDir = held;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The Shelf pack with a second python run in Maintenance (`api-more`), built
   * in a temp folder from the pack's bytes (the fixture folder itself is
   * frozen and has one python run per phase): "run 2+ of a shared language".
   */
  const shelfWithSecondPythonRun = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-s11-e2e-shelf-'));
    fs.cpSync(SHELF_DIR, dir, { recursive: true });
    const phaseDir = path.join(dir, 'phases', '06-maintenance');
    const phaseJson = JSON.parse(fs.readFileSync(path.join(phaseDir, 'phase.json'), 'utf-8'));
    phaseJson.checks.runs.push({
      id: 'api-more', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'More API tests',
      visibleTests: ['tests/test_shelf_order_more.py'], supportFiles: ['tests/conftest.py'],
    });
    fs.writeFileSync(path.join(phaseDir, 'phase.json'), JSON.stringify(phaseJson, null, 2));
    // the folder layout (docs/authoring-format.md, "The archive layout"): the visible test is a locked mount under readonly/, and the run's hidden
    // suite sits under hidden_tests/<run id>/ at the path it runs from
    fs.mkdirSync(path.join(phaseDir, 'readonly', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'readonly', 'tests', 'test_shelf_order_more.py'), 'def test_more_visible():\n    assert True\n');
    fs.mkdirSync(path.join(phaseDir, 'hidden_tests', 'api-more', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'hidden_tests', 'api-more', 'tests', 'test_hidden_more.py'), 'import unittest\n\n\nclass More(unittest.TestCase):\n    def test_more(self):\n        self.assertTrue(True)\n');
    return dir;
  };

  it("a new hidden test written to Maintenance's second python run of the Shelf pack lands in run 2 and is graded there; the same path in run 1 and run 2 is two rows with their own bytes", async () => {
    const owner = await teacher(8);
    const dir = shelfWithSecondPythonRun();
    let archive: Buffer;
    try {
      archive = zipDirectory(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const uploaded = await request(http).post(UPLOAD_PATH).set(bearer(owner.token)).set(from())
      .send({ title: `Shelf two runs ${stamp}`, archiveBase64: archive.toString('base64') });
    expect({ status: uploaded.status, body: uploaded.status >= 400 ? uploaded.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    const projectId = uploaded.body.projectId as string;
    const versionId = uploaded.body.versionId as string;
    const base = `/api/v1/instructor/projects/${projectId}/versions/${versionId}`;
    const door = `${base}/phases/maintenance/tasks/main/sealed`;
    const b64 = (text: string) => Buffer.from(text).toString('base64');

    // a NEW file, declared to the second python run
    const extra = 'tests/test_hidden_extra.py';
    const extraBytes = `import unittest\n# MARKER-HIDDEN-RUN-TWO-${stamp}\n`;
    const wrote = await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: extra, contentBase64: b64(extraBytes) });
    expect({ status: wrote.status, message: wrote.status >= 400 ? wrote.body.message : 'ok' }).toEqual({ status: 200, message: 'ok' });
    // a run of another language is still refused
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'web', path: extra, contentBase64: b64(extraBytes) }).expect(400);

    // one path, two runs, two rows, each with its own bytes
    const twice = 'tests/test_hidden_twice.py';
    const one = `import unittest\n# run one ${stamp}\n`;
    const two = `import unittest\n# run two ${stamp}\n`;
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: twice, contentBase64: b64(one) }).expect(200);
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: twice, contentBase64: b64(two) }).expect(200);
    const phaseRow = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'maintenance' });
    const rows = (await db.getRepository(FileRow).find({ where: { projectVersionId: versionId, ownerId: phaseRow.id, role: 'hidden' } }))
      .filter((row) => row.path.endsWith(twice));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.blobSha)).size).toBe(2);
    const readBack = async (runId: string) =>
      Buffer.from((await request(http).get(door).query({ role: 'hidden', path: twice, runId }).set(bearer(owner.token)).expect(200)).body.contentBase64, 'base64').toString('utf-8');
    expect(await readBack('api')).toBe(one);
    expect(await readBack('api-more')).toBe(two);

    // the compile puts each where it was declared
    await request(http).post(`${base}/validate`).set(bearer(owner.token)).expect(200);
    judged = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled as CompiledSnapshot;
    const runsOf = (snapshot: CompiledSnapshot) =>
      Object.fromEntries((snapshot.content.phases.find((p) => p.key === 'maintenance')!.checks as CodeChecks).runs.map((run) => [run.id, run]));
    const draftRuns = runsOf(judged);
    expect(draftRuns['api-more'].hiddenTestFiles[extra]).toBe(extraBytes);
    expect(draftRuns['api-more'].testPaths).toContain(extra);
    expect(draftRuns.api.hiddenTestFiles[extra]).toBeUndefined();
    expect([draftRuns.api.hiddenTestFiles[twice], draftRuns['api-more'].hiddenTestFiles[twice]]).toEqual([one, two]);

    // deep-validate, publish
    grading = false;
    const cost = await request(http).get(`${base}/deep-validation`).set(bearer(owner.token)).expect(200);
    await request(http).post(`${base}/deep-validation`).set(bearer(owner.token)).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const proved = await request(http).get(`${base}/deep-validation`).set(bearer(owner.token)).expect(200);
    expect({ status: proved.body.status, current: proved.body.current }).toEqual({ status: 'passed', current: true });
    const published = await request(http).post(`${base}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' }).expect(200);
    const live = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: published.body.versionId })).compiled as CompiledSnapshot;
    expect(runsOf(live)['api-more'].hiddenTestFiles[extra]).toBe(extraBytes);

    // a learner's Maintenance submission: run 2's graded job carries the new test and collects it; run 1's does not
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(owner.token)).send({ name: `s11-${stamp}` }).expect(201);
    await request(http).put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`).set(bearer(owner.token))
      .send({ projectVersionId: published.body.versionId, reason: 'Hidden run two journey.' }).expect(200);
    const registered = await request(http).post('/api/v1/auth/register').set(from())
      .send({ email: `ae-s11-learner-${stamp}@authoring-executable.test`, password: 'Correct-Horse-9', displayName: 'ae s11 learner' }).expect(201);
    const learner = registered.body.token as string;
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner)).send({ code: cohort.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner)).send({}).expect(201);
    const stateId = (enrolled.body.phases as { key: string; id: string }[]).find((p) => p.key === 'maintenance')!.id;
    // the declared test shortcut (as in authored-reviewer): one repository write opens Maintenance
    await db.getRepository(PhaseStateEntity).update({ id: stateId }, { status: 'in_progress', unlockedAt: new Date().toISOString() });
    judged = live;
    grading = true;
    const maintenance = live.content.phases.find((p) => p.key === 'maintenance')!;
    await request(http).put(`/api/v1/phases/${stateId}/workspace`).set(bearer(learner)).send({ files: (maintenance.checks as CodeChecks).solutionFiles }).expect(200);
    payloads.length = 0;
    const submitted = await request(http).post(`/api/v1/phases/${stateId}/submit`).set(bearer(learner)).expect(201);
    const verdict = await waitForSubmission(http, bearer(learner), submitted.body.id, { attempts: 200, intervalMs: 100 });
    expect(verdict?.status).toBe('completed');
    const hiddenJob = (runId: string) =>
      payloads.find((job) => job.runId === runId && job.harness === 'unittest') as { files: Record<string, string>; testPaths: string[] } | undefined;
    expect(hiddenJob('api-more')?.files[extra]).toBe(extraBytes);
    expect(hiddenJob('api-more')?.testPaths).toContain(extra);
    expect(hiddenJob('api-more')?.files[twice]).toBe(two);
    expect(hiddenJob('api')?.files[extra]).toBeUndefined();
    expect(hiddenJob('api')?.testPaths).not.toContain(extra);
    expect(hiddenJob('api')?.files[twice]).toBe(one);
    expect(JSON.stringify(verdict)).not.toContain(`MARKER-HIDDEN-RUN-TWO-${stamp}`);
  }, 180000);

  it('after a copy, a file carried to run 2 is rewritten where the teacher says: the graded bytes and the read-back are the new bytes, for a run-2-only path and for a path both runs hold', async () => {
    const owner = await teacher(9);
    const dir = shelfWithSecondPythonRun();
    let archive: Buffer;
    try {
      archive = zipDirectory(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const uploaded = await request(http).post(UPLOAD_PATH).set(bearer(owner.token)).set(from())
      .send({ title: `Shelf copy runs ${stamp}`, archiveBase64: archive.toString('base64') });
    expect({ status: uploaded.status, body: uploaded.status >= 400 ? uploaded.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    const sourceBase = `/api/v1/instructor/projects/${uploaded.body.projectId}/versions/${uploaded.body.versionId}`;
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const runsOf = (snapshot: CompiledSnapshot) =>
      Object.fromEntries((snapshot.content.phases.find((p) => p.key === 'maintenance')!.checks as CodeChecks).runs.map((run) => [run.id, run]));

    // the source: a run-2-only file, and one path held by both runs with its own bytes in each
    const extra = 'tests/test_hidden_extra.py';
    const twice = 'tests/test_hidden_twice.py';
    const old = { extra: `import unittest\n# source extra ${stamp}\n`, one: `import unittest\n# source one ${stamp}\n`, two: `import unittest\n# source two ${stamp}\n` };
    const sourceDoor = `${sourceBase}/phases/maintenance/tasks/main/sealed`;
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: extra, contentBase64: b64(old.extra) }).expect(200);
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: twice, contentBase64: b64(old.one) }).expect(200);
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: twice, contentBase64: b64(old.two) }).expect(200);
    await request(http).post(`${sourceBase}/validate`).set(bearer(owner.token)).expect(200);
    judged = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: uploaded.body.versionId })).compiled as CompiledSnapshot;
    grading = false;
    const cost = await request(http).get(`${sourceBase}/deep-validation`).set(bearer(owner.token)).expect(200);
    await request(http).post(`${sourceBase}/deep-validation`).set(bearer(owner.token)).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const published = await request(http).post(`${sourceBase}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' }).expect(200);

    // the copy
    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(owner.token))
      .send({ title: 'Copied runs', slug: `copied-runs-${stamp}`, fromVersionId: published.body.versionId })
      .expect(201);
    const versionId = made.body.draftVersionId as string;
    const base = `/api/v1/instructor/projects/${made.body.project.id}/versions/${versionId}`;
    const door = `${base}/phases/maintenance/tasks/main/sealed`;
    const readBack = async (at: string, runId?: string) =>
      Buffer.from(
        (await request(http).get(door).query(runId ? { role: 'hidden', path: at, runId } : { role: 'hidden', path: at }).set(bearer(owner.token)).expect(200)).body.contentBase64,
        'base64',
      ).toString('utf-8');
    const compiledCopy = async () => {
      await request(http).post(`${base}/validate`).set(bearer(owner.token)).expect(200);
      return runsOf((await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled as CompiledSnapshot);
    };

    // rewritten under run 2: run 2 grades the new bytes, run 1 keeps its own
    const fresh = { extra: `import unittest\n# copy extra ${stamp}\n`, two: `import unittest\n# copy two ${stamp}\n` };
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: extra, contentBase64: b64(fresh.extra) }).expect(200);
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: twice, contentBase64: b64(fresh.two) }).expect(200);
    const runs = await compiledCopy();
    expect({
      extraRun2: runs['api-more'].hiddenTestFiles[extra],
      extraRun1: runs.api.hiddenTestFiles[extra],
      twiceRun2: runs['api-more'].hiddenTestFiles[twice],
      twiceRun1: runs.api.hiddenTestFiles[twice],
    }).toEqual({ extraRun2: fresh.extra, extraRun1: undefined, twiceRun2: fresh.two, twiceRun1: old.one });
    expect(await readBack(extra, 'api-more')).toBe(fresh.extra);
    expect(await readBack(twice, 'api-more')).toBe(fresh.two);

    // rewritten with no run: every run that grades it grades the new bytes, and one row holds them
    const plain = `import unittest\n# copy plain ${stamp}\n`;
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: null, path: extra, contentBase64: b64(plain) }).expect(200);
    const after = await compiledCopy();
    expect({ run2: after['api-more'].hiddenTestFiles[extra], run1: after.api.hiddenTestFiles[extra] }).toEqual({ run2: plain, run1: undefined });
    expect(await readBack(extra, 'api-more')).toBe(plain);
    expect(await readBack(extra)).toBe(plain);
    const phaseRow = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'maintenance' });
    const extraRows = (await db.getRepository(FileRow).find({ where: { projectVersionId: versionId, ownerId: phaseRow.id, role: 'hidden' } }))
      .filter((row) => row.path.endsWith(extra));
    // a file held only by run 2's carried row is rewritten in that row, never
    // moved to a plain row
    expect(extraRows.map((row) => row.path)).toEqual([`hidden/\\run\\api-more/${extra}`]);
  }, 180000);

  /*
   * One sealed write lands in the same
   * place in a draft and in its copy. Which rows hold a path is read off the
   * version's carried rows, never off the task row's slice, which a copy's
   * compile has already filled with the carried run's file.
   */
  const uploadDir = async (owner: { token: string }, dir: string, title: string) => {
    let archive: Buffer;
    try {
      archive = zipDirectory(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const uploaded = await request(http).post(UPLOAD_PATH).set(bearer(owner.token)).set(from())
      .send({ title, archiveBase64: archive.toString('base64') });
    expect({ status: uploaded.status, body: uploaded.status >= 400 ? uploaded.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    return { projectId: uploaded.body.projectId as string, versionId: uploaded.body.versionId as string };
  };
  const compiledOf = async (versionId: string) =>
    (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled as CompiledSnapshot;
  const runsIn = (snapshot: CompiledSnapshot, phaseKey: string) =>
    Object.fromEntries((snapshot.content.phases.find((p) => p.key === phaseKey)!.checks as CodeChecks | TestsChecks).runs.map((run) => [run.id, run]));
  /** Validate, deep-validate (stub sandbox), publish, then copy: the copy's draft. */
  const publishThenCopy = async (owner: { token: string }, source: { projectId: string; versionId: string }, slug: string) => {
    const sourceBase = `/api/v1/instructor/projects/${source.projectId}/versions/${source.versionId}`;
    await request(http).post(`${sourceBase}/validate`).set(bearer(owner.token)).expect(200);
    judged = await compiledOf(source.versionId);
    grading = false;
    const cost = await request(http).get(`${sourceBase}/deep-validation`).set(bearer(owner.token)).expect(200);
    await request(http).post(`${sourceBase}/deep-validation`).set(bearer(owner.token)).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const published = await request(http).post(`${sourceBase}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' });
    expect({ status: published.status, message: published.status >= 400 ? published.body.message : 'ok' }).toEqual({ status: 200, message: 'ok' });
    const made = await request(http).post('/api/v1/instructor/projects').set(bearer(owner.token))
      .send({ title: `Copy ${slug}`, slug: `${slug}-${stamp}`, fromVersionId: published.body.versionId }).expect(201);
    const versionId = made.body.draftVersionId as string;
    return { versionId, base: `/api/v1/instructor/projects/${made.body.project.id}/versions/${versionId}` };
  };
  const readSealed = async (door: string, owner: { token: string }, role: string, at: string, runId?: string) =>
    Buffer.from(
      (await request(http).get(door).query(runId ? { role, path: at, runId } : { role, path: at }).set(bearer(owner.token)).expect(200)).body.contentBase64,
      'base64',
    ).toString('utf-8');

  /** The Shelf pack with a second python run in Testing (`api-more`), its own learner and reference suites; both python runs grade api/shelf.py. */
  const shelfWithSecondTestingRun = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-s17-e2e-shelf-'));
    fs.cpSync(SHELF_DIR, dir, { recursive: true });
    const phaseDir = path.join(dir, 'phases', '04-testing');
    const phaseJson = JSON.parse(fs.readFileSync(path.join(phaseDir, 'phase.json'), 'utf-8'));
    phaseJson.checks.learnerTestFiles.push('tests/test_acceptance_more.py');
    phaseJson.checks.runs.push({
      id: 'api-more', language: 'python', harness: 'pytest', label: 'More API tests',
      learnerTestFiles: ['tests/test_acceptance_more.py'], implFiles: ['api/main.py', 'api/shelf.py'], supportFiles: ['tests/conftest.py'],
    });
    // the folder layout (docs/authoring-format.md, "The archive layout"): the learner's new suite is an editable mount at its path under files/
    fs.writeFileSync(path.join(phaseDir, 'phase.json'), JSON.stringify(phaseJson, null, 2));
    fs.writeFileSync(path.join(phaseDir, 'files', 'tests', 'test_acceptance_more.py'), '"""More acceptance tests for the shelf API."""\n');
    fs.writeFileSync(path.join(phaseDir, 'reference', 'tests', 'test_acceptance_more.py'), 'def test_more_reference(client):\n    assert client.get("/api/books").status_code == 200\n');
    return dir;
  };

  it('after a copy, a write naming run 1 for a path both runs hold leaves run 2 its own bytes, as the same write does on the source draft', async () => {
    const owner = await teacher(30);
    const source = await uploadDir(owner, shelfWithSecondPythonRun(), `Shelf s17 a ${stamp}`);
    const sourceBase = `/api/v1/instructor/projects/${source.projectId}/versions/${source.versionId}`;
    const sourceDoor = `${sourceBase}/phases/maintenance/tasks/main/sealed`;
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const twice = 'tests/test_hidden_twice.py';
    const old = { one: `import unittest\n# s17 a source one ${stamp}\n`, two: `import unittest\n# s17 a source two ${stamp}\n` };
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: twice, contentBase64: b64(old.one) }).expect(200);
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: twice, contentBase64: b64(old.two) }).expect(200);
    // the control, on the SOURCE draft: a second write naming run 1 leaves run 2 alone
    const sourceNew = `import unittest\n# s17 a source one rewritten ${stamp}\n`;
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: twice, contentBase64: b64(sourceNew) }).expect(200);
    await request(http).post(`${sourceBase}/validate`).set(bearer(owner.token)).expect(200);
    const sourceRuns = runsIn(await compiledOf(source.versionId), 'maintenance') as Record<string, CodeChecks['runs'][number]>;

    const copy = await publishThenCopy(owner, source, 's17-a');
    const door = `${copy.base}/phases/maintenance/tasks/main/sealed`;
    const copyNew = `import unittest\n# s17 a copy one ${stamp}\n`;
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: twice, contentBase64: b64(copyNew) }).expect(200);
    await request(http).post(`${copy.base}/validate`).set(bearer(owner.token)).expect(200);
    const runs = runsIn(await compiledOf(copy.versionId), 'maintenance') as Record<string, CodeChecks['runs'][number]>;
    expect({
      source: { run1: sourceRuns.api.hiddenTestFiles[twice], run2: sourceRuns['api-more'].hiddenTestFiles[twice] },
      copy: {
        run1: runs.api.hiddenTestFiles[twice],
        run2: runs['api-more'].hiddenTestFiles[twice],
        read1: await readSealed(door, owner, 'hidden', twice, 'api'),
        read2: await readSealed(door, owner, 'hidden', twice, 'api-more'),
      },
    }).toEqual({
      source: { run1: sourceNew, run2: old.two },
      copy: { run1: copyNew, run2: old.two, read1: copyNew, read2: old.two },
    });
  }, 180000);

  it('on the source draft, a no-run rewrite of a file held only by run 2\'s carried row rewrites that row in place: run 1 gains nothing', async () => {
    const owner = await teacher(31);
    const source = await uploadDir(owner, shelfWithSecondPythonRun(), `Shelf s17 b ${stamp}`);
    const sourceBase = `/api/v1/instructor/projects/${source.projectId}/versions/${source.versionId}`;
    const door = `${sourceBase}/phases/maintenance/tasks/main/sealed`;
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const extra = 'tests/test_hidden_extra.py';
    const first = `import unittest\n# s17 b run two ${stamp}\n`;
    const plain = `import unittest\n# s17 b plain ${stamp}\n`;
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: extra, contentBase64: b64(first) }).expect(200);
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: null, path: extra, contentBase64: b64(plain) }).expect(200);
    await request(http).post(`${sourceBase}/validate`).set(bearer(owner.token)).expect(200);
    const runs = runsIn(await compiledOf(source.versionId), 'maintenance') as Record<string, CodeChecks['runs'][number]>;
    const phaseRow = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: source.versionId, key: 'maintenance' });
    const rows = (await db.getRepository(FileRow).find({ where: { projectVersionId: source.versionId, ownerId: phaseRow.id, role: 'hidden' } }))
      .filter((row) => row.path.endsWith(extra))
      .map((row) => row.path)
      .sort();
    expect({
      run2: runs['api-more'].hiddenTestFiles[extra],
      run1Holds: extra in runs.api.hiddenTestFiles,
      run1Collects: runs.api.testPaths.includes(extra),
      rows,
      read: await readSealed(door, owner, 'hidden', extra),
      read2: await readSealed(door, owner, 'hidden', extra, 'api-more'),
    }).toEqual({ run2: plain, run1Holds: false, run1Collects: false, rows: [`hidden/\\run\\api-more/${extra}`], read: plain, read2: plain });
  }, 180000);

  it("a no-run write of a path held by run 1's plain row and run 2's carried row: every run grades the new bytes, and both rows hold them, on a draft and on its copy alike", async () => {
    const owner = await teacher(33);
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const twice = 'tests/test_hidden_twice.py';
    const A = `import unittest\n# s17 d one ${stamp}\n`;
    const B = `import unittest\n# s17 d two ${stamp}\n`;
    const Y = `import unittest\n# s17 d plain ${stamp}\n`;
    const tag = (bytes: string | undefined) => (bytes === A ? 'A' : bytes === B ? 'B' : bytes === Y ? 'Y' : bytes === undefined ? 'none' : 'other');
    const rowsOf = async (versionId: string) => {
      const phaseRow = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'maintenance' });
      return (await db.getRepository(FileRow).find({ where: { projectVersionId: versionId, ownerId: phaseRow.id, role: 'hidden' } }))
        .filter((row) => row.path.endsWith(twice))
        .map((row) => row.path.replace(twice, '<twice>'))
        .sort();
    };
    const twoWrites = async (door: string) => {
      await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: twice, contentBase64: b64(A) }).expect(200);
      await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: twice, contentBase64: b64(B) }).expect(200);
    };
    const observe = async (base: string, versionId: string) => {
      const door = `${base}/phases/maintenance/tasks/main/sealed`;
      await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: null, path: twice, contentBase64: b64(Y) }).expect(200);
      await request(http).post(`${base}/validate`).set(bearer(owner.token)).expect(200);
      const runs = runsIn(await compiledOf(versionId), 'maintenance') as Record<string, CodeChecks['runs'][number]>;
      return {
        run1: tag(runs.api.hiddenTestFiles[twice]),
        run2: tag(runs['api-more'].hiddenTestFiles[twice]),
        read: tag(await readSealed(door, owner, 'hidden', twice)),
        read2: tag(await readSealed(door, owner, 'hidden', twice, 'api-more')),
        rows: await rowsOf(versionId),
      };
    };

    // the source: run 1's plain row and run 2's carried row, published and copied
    const source = await uploadDir(owner, shelfWithSecondPythonRun(), `Shelf s17 d ${stamp}`);
    await twoWrites(`/api/v1/instructor/projects/${source.projectId}/versions/${source.versionId}/phases/maintenance/tasks/main/sealed`);
    const copy = await publishThenCopy(owner, source, 's17-d');
    // the control: a second draft with the same two writes
    const control = await uploadDir(owner, shelfWithSecondPythonRun(), `Shelf s17 d control ${stamp}`);
    const controlBase = `/api/v1/instructor/projects/${control.projectId}/versions/${control.versionId}`;
    await twoWrites(`${controlBase}/phases/maintenance/tasks/main/sealed`);

    const expected = { run1: 'Y', run2: 'Y', read: 'Y', read2: 'Y', rows: ['hidden/<twice>', 'hidden/\\run\\api-more/<twice>'] };
    expect({ draft: await observe(controlBase, control.versionId), copy: await observe(copy.base, copy.versionId) }).toEqual({ draft: expected, copy: expected });
  }, 240000);

  it("a tests task's reference files after a copy: a write naming run 1 leaves run 2's carried suite file and run 2's implementation their own bytes", async () => {
    const owner = await teacher(32);
    const source = await uploadDir(owner, shelfWithSecondTestingRun(), `Shelf s17 c ${stamp}`);
    const sourceBase = `/api/v1/instructor/projects/${source.projectId}/versions/${source.versionId}`;
    const sourceDoor = `${sourceBase}/phases/testing/tasks/main/sealed`;
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const suite = 'tests/test_ref_twice.py';
    const impl = 'api/shelf.py';
    const old = { one: `def test_ref_twice():\n    assert True  # s17 c source one ${stamp}\n`, two: `def test_ref_twice():\n    assert True  # s17 c source two ${stamp}\n` };
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: suite, contentBase64: b64(old.one) }).expect(200);
    await request(http).put(sourceDoor).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api-more', path: suite, contentBase64: b64(old.two) }).expect(200);
    await request(http).post(`${sourceBase}/validate`).set(bearer(owner.token)).expect(200);
    const sourceRuns = runsIn(await compiledOf(source.versionId), 'testing') as Record<string, TestsChecks['runs'][number]>;
    expect([sourceRuns.api.referenceTestFiles[suite], sourceRuns['api-more'].referenceTestFiles[suite]]).toEqual([old.one, old.two]);
    const shippedImpl = sourceRuns['api-more'].implFiles[impl];
    expect(sourceRuns.api.implFiles[impl]).toBe(shippedImpl);

    const copy = await publishThenCopy(owner, source, 's17-c');
    const door = `${copy.base}/phases/testing/tasks/main/sealed`;
    const copyNew = `def test_ref_twice():\n    assert True  # s17 c copy one ${stamp}\n`;
    const implNew = `${shippedImpl}\n# s17 c copy impl ${stamp}\n`;
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'hidden', runId: 'api', path: suite, contentBase64: b64(copyNew) }).expect(200);
    await request(http).put(door).set(bearer(owner.token)).send({ role: 'solution', runId: 'api', path: impl, contentBase64: b64(implNew) }).expect(200);
    await request(http).post(`${copy.base}/validate`).set(bearer(owner.token)).expect(200);
    const runs = runsIn(await compiledOf(copy.versionId), 'testing') as Record<string, TestsChecks['runs'][number]>;
    expect({
      suite: {
        run1: runs.api.referenceTestFiles[suite],
        run2: runs['api-more'].referenceTestFiles[suite],
        read1: await readSealed(door, owner, 'hidden', suite, 'api'),
        read2: await readSealed(door, owner, 'hidden', suite, 'api-more'),
      },
      impl: {
        run1: runs.api.implFiles[impl],
        run2: runs['api-more'].implFiles[impl],
        read1: await readSealed(door, owner, 'solution', impl, 'api'),
        read2: await readSealed(door, owner, 'solution', impl, 'api-more'),
      },
    }).toEqual({
      suite: { run1: copyNew, run2: old.two, read1: copyNew, read2: old.two },
      impl: { run1: implNew, run2: shippedImpl, read1: implNew, read2: shippedImpl },
    });
  }, 180000);

  /** The Shelf pack (or `from`, another pack folder) with a `task` block written into phase folders' phase.json, zipped. */
  const shelfArchiveWith = (blocks: Record<string, unknown>, from: string = SHELF_DIR): Buffer => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ae-s13-')), 'shelf');
    fs.cpSync(from, dir, { recursive: true });
    try {
      for (const [rel, block] of Object.entries(blocks)) {
        const file = path.join(dir, rel, 'phase.json');
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), task: block }, null, 2));
      }
      return zipDirectory(dir);
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  };

  it("a phase.json task block uploads over HTTP: the editor opens on the block's title, brief and objectives", async () => {
    const owner = await teacher(20);
    // an older archive's block carries its own brief, which the door's conversion moves into taskPanel;
    // a folder-layout block holds no brief, the phase's taskPanel being the brief
    const archive = shelfArchiveWith({
      'phases/03-implementation': { key: 'main', title: 'Shelve the books', brief: 'Shelve every book by its author.', objectives: ['Sort by author'] },
    }, OLDER_SHELF_DIR);
    const uploaded = await request(http).post(UPLOAD_PATH).set(bearer(owner.token)).set(from())
      .send({ title: `Shelf block ${stamp}`, archiveBase64: archive.toString('base64') });
    expect({ status: uploaded.status, body: uploaded.status >= 400 ? uploaded.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    const listed = await request(http)
      .get(`/api/v1/instructor/projects/${uploaded.body.projectId}/versions/${uploaded.body.versionId}/phases/implementation/tasks`)
      .set(bearer(owner.token)).set(from())
      .expect(200);
    const tasks = (Array.isArray(listed.body) ? listed.body : listed.body.tasks) as { taskKey: string; title: string; brief: string; objectives: string[] }[];
    expect(tasks.map((one) => [one.taskKey, one.title, one.brief, one.objectives])).toEqual([
      ['main', 'Shelve the books', 'Shelve every book by its author.', ['Sort by author']],
    ]);
  });

  it('a malformed task block is refused over HTTP as 400 NOT_A_PACK with a detail naming the phase, never a 500, and writes no project', async () => {
    const owner = await teacher(21);
    const title = `Shelf bad block ${stamp}`;
    for (const block of [{ title: 'Shelve', hidden: 'def test_secret(): pass' }, { title: 'x'.repeat(161) }, { objectives: 'one' }]) {
      const refused = await request(http).post(UPLOAD_PATH).set(bearer(owner.token)).set(from())
        .send({ title, archiveBase64: shelfArchiveWith({ 'phases/03-implementation': block }).toString('base64') });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('NOT_A_PACK');
      expect(refused.body.sentence).toBe(refused.body.message);
      expect(String(refused.body.detail)).toMatch(/^phases\/03-implementation's phase\.json task block: /);
      expect(JSON.stringify(refused.body)).not.toContain('test_secret');
    }
    expect(await db.getRepository(ProjectEntity).count({ where: { title } })).toBe(0);
  });

  it("the runtime profile is served to staff (a learner's 403 is the route-table e2e's)", async () => {
    const owner = await teacher(2);
    const profile = await request(http).get('/api/v1/instructor/runtime-profile').set(bearer(owner.token)).expect(200);
    expect(JSON.stringify(profile.body)).toMatch(/python|node/i);
  });

  it('GET /instructor/runtime-profile answers uploadMaxBytes equal to IMPORT_MAX_BYTES, the archive cap UploadService enforces', async () => {
    const owner = await teacher(7);
    const profile = await request(http).get('/api/v1/instructor/runtime-profile').set(bearer(owner.token)).expect(200);
    expect(process.env.IMPORT_MAX_BYTES).toBe(String(SPEC_IMPORT_MAX_BYTES));
    expect(profile.body.uploadMaxBytes).toBe(SPEC_IMPORT_MAX_BYTES);
    // the archive's bytes, not the base64 body: the upload door's own base64 ceiling is 4/3 of it
    expect(app.get(UploadService).maxBase64Length).toBe(4 * Math.ceil(SPEC_IMPORT_MAX_BYTES / 3));
  });

  it("edit the Shelf pack's implementation hidden suite → deep-validate → publish → a learner's submission is graded against the new suite (stub sandbox)", async () => {
    const owner = await teacher(5);
    // the Shelf pack, through the real upload route
    const uploaded = await request(http)
      .post(UPLOAD_PATH)
      .set(bearer(owner.token))
      .set(from())
      .send({ title: `Shelf journey ${stamp}`, archiveBase64: zipDirectory(SHELF_DIR).toString('base64') });
    expect({ status: uploaded.status, body: uploaded.status >= 400 ? uploaded.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    const projectId = uploaded.body.projectId as string;
    const versionId = uploaded.body.versionId as string;
    const base = `/api/v1/instructor/projects/${projectId}/versions/${versionId}`;

    // edit the implementation's sealed python suite through the sealed door
    const phase = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'implementation' });
    const hiddenRows = await db.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId, ownerId: phase.id, role: 'hidden' } });
    const pyRow = hiddenRows.find((one) => one.path.endsWith('.py'))!;
    const hidden = pyRow.path.slice('hidden/'.length);
    const draftBefore = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled as CompiledSnapshot;
    const shippedRun = (draftBefore.content.phases.find((one) => one.key === 'implementation')!.checks as CodeChecks).runs.find((run) => run.hiddenTestFiles[hidden] !== undefined)!;
    const shipped = shippedRun.hiddenTestFiles[hidden];
    expect(shipped).toContain(SHELF_MARKERS.hidden);
    const marker = `MARKER-AE-JOURNEY-${stamp}`;
    const edited = `${shipped}\n# ${marker}: one more sealed case the teacher added\n`;
    await request(http)
      .put(`${base}/phases/implementation/tasks/main/sealed`)
      .set(bearer(owner.token))
      .send({ role: 'hidden', runId: null, path: hidden, contentBase64: Buffer.from(edited).toString('base64') })
      .expect(200);

    // the draft now asks for deep validation, and nothing else
    const validated = await request(http).post(`${base}/validate`).set(bearer(owner.token)).expect(200);
    expect(validated.body.blocking).toEqual([]);
    const refusedFirst = await request(http).post(`${base}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' }).expect(400);
    expect(String(refusedFirst.body.message)).toContain(deepReceiptRefusal('Implementation', { uploaded: true }));

    // deep-validate the edited draft over the mounted routes (stub sandbox)
    judged = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled as CompiledSnapshot;
    const editedRun = (judged.content.phases.find((one) => one.key === 'implementation')!.checks as CodeChecks).runs.find((run) => run.hiddenTestFiles[hidden] !== undefined)!;
    expect(editedRun.hiddenTestFiles[hidden]).toBe(edited);
    const cost = await request(http).get(`${base}/deep-validation`).set(bearer(owner.token)).expect(200);
    const microVMs = cost.body.costWarning.microVMs as number;
    payloads.length = 0;
    await request(http).post(`${base}/deep-validation`).set(bearer(owner.token)).send({ acknowledgedMicroVMs: microVMs }).expect(202);
    await app.get(DeepValidationService).idle();
    const proved = await request(http).get(`${base}/deep-validation`).set(bearer(owner.token)).expect(200);
    expect({ status: proved.body.status, current: proved.body.current }).toEqual({ status: 'passed', current: true });
    expect(payloads).toHaveLength(microVMs);
    expect(hasCurrentDeepReceipt(await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId }))).toBe(true);

    // publish: the current deep validation is all it asks for
    const published = await request(http).post(`${base}/publish`).set(bearer(owner.token)).send({ version: '1.0.0' }).expect(200);
    const publishedVersionId = published.body.versionId as string;
    const live = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: publishedVersionId })).compiled as CompiledSnapshot;
    const implementation = live.content.phases.find((one) => one.key === 'implementation')!;
    expect(Object.values((implementation.checks as CodeChecks).runs.find((run) => run.hiddenTestFiles[hidden] !== undefined)!.hiddenTestFiles)).toContain(edited);
    // the published phase is the teacher's, so its reviewer is AUTHORED
    const work = live.phases.find((one) => one.key === 'implementation')!.tasks;
    expect(taskScopeOf(implementation).kind).toBe('authored');
    expect(taskScopeOf(implementation, work[0], work).kind).toBe('authored');

    // a class on the published version, and a learner in it
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(owner.token)).send({ name: `journey-${stamp}` }).expect(201);
    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`)
      .set(bearer(owner.token))
      .send({ projectVersionId: publishedVersionId, reason: 'SPINE-2 S5 journey.' })
      .expect(200);
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `ae-learner-${stamp}@authoring-executable.test`, password: 'Correct-Horse-9', displayName: 'ae learner' })
      .expect(201);
    const learner = registered.body.token as string;
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner)).send({ code: cohort.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner)).send({}).expect(201);
    const phaseStateId = (enrolled.body.phases as { key: string; id: string }[]).find((one) => one.key === 'implementation')!.id;
    // the declared test shortcut (as in authored-reviewer): one repository write opens Implementation; no pass opened it
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseStateId })).status).toBe('locked');
    await db.getRepository(PhaseStateEntity).update({ id: phaseStateId }, { status: 'in_progress', unlockedAt: new Date().toISOString() });

    // the learner hands in the answer; the grader runs it against the teacher's new suite
    judged = live;
    grading = true;
    const solution = (implementation.checks as CodeChecks).solutionFiles;
    await request(http).put(`/api/v1/phases/${phaseStateId}/workspace`).set(bearer(learner)).send({ files: solution }).expect(200);
    payloads.length = 0;
    const submitted = await request(http).post(`/api/v1/phases/${phaseStateId}/submit`).set(bearer(learner)).expect(201);
    const verdict = await waitForSubmission(http, bearer(learner), submitted.body.id, { attempts: 200, intervalMs: 100 });
    expect(verdict?.status).toBe('completed');
    expect((verdict.report.checks as { id: string; status: string }[]).find((one) => one.id === 'hidden-tests-api')).toMatchObject({ status: 'passed' });
    // the graded job carried the edited suite, and never the one the pack shipped
    const graded = payloads.filter((one) => (one.files as Record<string, string> | undefined)?.[hidden] !== undefined);
    expect(graded.length).toBeGreaterThan(0);
    for (const job of graded) expect((job.files as Record<string, string>)[hidden]).toBe(edited);
    expect(JSON.stringify(payloads)).not.toContain(JSON.stringify(shipped));
    // and no response the learner read carried a sealed byte
    expect(JSON.stringify(verdict)).not.toContain(marker);
    expect(JSON.stringify(verdict)).not.toContain(SHELF_MARKERS.hidden);
  }, 120000);
});
