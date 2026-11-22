import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';
import type { RunResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { DEEP_VALIDATION_SCOPE, DeepValidationService, hasCurrentDeepReceipt } from '../src/authoring/deep-validation';
import { config } from '../src/config';
import { ProjectImporterService } from '../src/content/importer.service';
import { DirectoryPackSource } from '../src/content/pack-source';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { sandboxExecutionDuration } from '../src/observability/metrics';
import { ALL_SHELF_MARKERS, SHELF_DIR } from './fixtures/upload-packs/markers';
import { mockAiForRoutes } from './mock-ai';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * Deep validation on the wired application, through the real routes
 * (`deepValidation.start` / `deepValidation.read`), on the Shelf pack
 * uploaded as a teacher's draft.
 *
 * The sandbox is the real `SandboxService` with only its transport replaced
 * (this host's runner refuses without kernel isolation), so the job each
 * check sends goes through `execute` as any learner's does: the `RunGate`
 * line, the learner limits stamped on the payload, the purpose label. The
 * transport judges a job by its bytes, exactly as the unit spec's stub does.
 *
 * The order is the teacher's: the cost is shown first, a start
 * naming a stale count boots nothing, a starter that already passes is
 * refused, and the fixed draft passes with a current receipt.
 */
describe('deep validation, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  let owner = { id: '', token: '' };
  let other = { id: '', token: '' };
  let admin = { id: '', token: '' };
  let projectId = '';
  let versionId = '';
  let clean: CompiledSnapshot;
  let snapshot: CompiledSnapshot;
  const payloads: Record<string, unknown>[] = [];
  const said: string[] = [];
  /** While set, every job waits here before the transport answers it. */
  let hold: Promise<void> | null = null;

  const account = async (name: string, role: 'INSTRUCTOR' | 'ADMIN') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@deep-validation.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    await db.manager.update(UserEntity, { id }, { role });
    app.get(AuthService).forgetSession(id);
    return { id, token: registered.body.token as string };
  };

  const route = () => `/api/v1/instructor/projects/${projectId}/versions/${versionId}/deep-validation`;
  const read = async (token = owner.token, expect = 200) => {
    const res = await request(http).get(route()).set(bearer(token)).expect(expect);
    said.push(res.text);
    return res.body;
  };
  const start = async (acknowledgedMicroVMs: number, token = owner.token, expect = 202) => {
    const res = await request(http).post(route()).set(bearer(token)).send({ acknowledgedMicroVMs }).expect(expect);
    said.push(res.text);
    return res.body;
  };
  const settle = async () => {
    await app.get(DeepValidationService).idle();
    return read();
  };

  /* -------- the transport: judges a job by its bytes (see the unit spec) -------- */
  const ok = (n = 4): RunResult => ({ ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] } });
  const bad = (n = 4): RunResult => ({ ok: false, exitKind: 'error', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n - 1, failed: 1, errored: 0, cases: [] } });
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.keys(a).every((k) => a[k] === b[k]);
  const judge = (job: SandboxJob): RunResult => {
    const phases = snapshot.content.phases;
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
      const hidden = checks.runs.some(
        (run) => Object.keys(run.hiddenTestFiles).length > 0 && Object.entries(run.hiddenTestFiles).every(([at, bytes]) => job.files[at] === bytes),
      );
      if (!hidden) continue;
      return Object.entries(checks.solutionFiles).every(([at, bytes]) => job.files[at] === bytes) ? ok() : bad();
    }
    return bad();
  };
  /** The Shelf pack's 16 microVMs, less a cut sub-check's share (testing 6, deployment 2). */
  const MICROVMS = 16 - (DEEP_VALIDATION_SCOPE.mutants ? 0 : 6) - (DEEP_VALIDATION_SCOPE.smoke ? 0 : 2);
  /** The Shelf pack is an upload: a cut sub-check fails closed on it, so under a cut it cannot pass. */
  const CLEAN = DEEP_VALIDATION_CHECK_IDS.map((id) => [
    id,
    (id === 'mutants-killed' && !DEEP_VALIDATION_SCOPE.mutants) || (id === 'smoke-passes' && !DEEP_VALIDATION_SCOPE.smoke)
      ? 'failed'
      : 'passed',
  ]);
  const PASSES = DEEP_VALIDATION_SCOPE.mutants && DEEP_VALIDATION_SCOPE.smoke;
  const purposeCount = async (purpose: string) =>
    ((await sandboxExecutionDuration.get()).values as { metricName?: string; labels: Record<string, unknown>; value: number }[])
      .filter((v) => v.metricName === 'sandbox_execution_duration_seconds_count' && v.labels.purpose === purpose)
      .reduce((sum, v) => sum + v.value, 0);

  beforeAll(async () => {
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as Record<string, unknown>;
      payloads.push(payload);
      if (hold) await hold;
      return JSON.stringify(judge(payload as unknown as SandboxJob));
    });
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);

    owner = await account('deep-owner', 'INSTRUCTOR');
    other = await account('deep-other', 'INSTRUCTOR');
    admin = await account('deep-admin', 'ADMIN');

    // the Shelf pack as the upload path lands it: a teacher-owned draft
    const draft = await app
      .get(ProjectImporterService)
      .importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: owner.id, title: `Shelf ${stamp}` });
    projectId = draft.projectId;
    versionId = draft.versionId;
    const row = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    clean = JSON.parse(JSON.stringify(row.compiled)) as CompiledSnapshot;
    snapshot = clean;
  }, 120000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('the routes are mounted and answer the view, with the cost in microVMs before anything starts', async () => {
    const view = await read();
    expect(view).toMatchObject({ versionId, status: 'not-run', current: false, contentDigest: null });
    expect(view.checks.map((check: { id: string }) => check.id)).toEqual([...DEEP_VALIDATION_CHECK_IDS]);
    expect(clean.sandboxBudget).toBe(16);
    expect(view.costWarning).toEqual({ microVMs: MICROVMS, sentence: deepValidationCostWarning(MICROVMS) });
  });

  it('another teacher is 404 and an ADMIN is 403; nothing boots', async () => {
    await read(other.token, 404);
    await start(MICROVMS, other.token, 404);
    const refused = await request(http).post(route()).set(bearer(admin.token)).send({ acknowledgedMicroVMs: MICROVMS });
    expect(refused.status).toBe(403);
    expect(payloads).toHaveLength(0);
  });

  it('a start naming a stale microVM count is refused by sentence, and nothing boots', async () => {
    const refused = await request(http).post(route()).set(bearer(owner.token)).send({ acknowledgedMicroVMs: MICROVMS - 1 }).expect(409);
    expect(refused.body.message).toContain(`${MICROVMS} microVMs`);
    expect(payloads).toHaveLength(0);
  });

  it('a starter that already passes is refused, naming the phase', async () => {
    const doctored = JSON.parse(JSON.stringify(clean)) as CompiledSnapshot;
    const implementation = doctored.content.phases.find((p) => p.key === 'implementation')!;
    const solution = (implementation.checks as CodeChecks).solutionFiles;
    implementation.files = implementation.files.map((file) =>
      solution[file.path] !== undefined && file.editable ? { ...file, content: solution[file.path] } : file,
    );
    await db.getRepository(ProjectVersionEntity).update({ id: versionId }, { compiled: doctored });
    snapshot = doctored;
    const queued = await start(MICROVMS);
    expect(['queued', 'running']).toContain(queued.status);
    const view = await settle();
    expect(view.status).toBe('failed');
    const starter = view.checks.find((check: { id: string }) => check.id === 'starter-fails-hidden');
    expect(starter).toMatchObject({ status: 'failed', phaseKey: 'implementation' });
    expect(starter.sentence).toContain('starter already passes');
    expect(hasCurrentDeepReceipt(await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId }))).toBe(false);
  });

  it('the fixed draft passes all four checks with a current receipt; its jobs went through execute as validation, under the learner limits', async () => {
    await db.getRepository(ProjectVersionEntity).update({ id: versionId }, { compiled: clean });
    snapshot = clean;
    payloads.length = 0;
    const before = { validation: await purposeCount('validation'), grading: await purposeCount('grading') };
    await start(MICROVMS);
    const view = await settle();
    expect(view.status).toBe(PASSES ? 'passed' : 'failed');
    expect(view.current).toBe(true);
    expect(view.checks.map((check: { id: string; status: string }) => [check.id, check.status])).toEqual(CLEAN);
    const row = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    expect(hasCurrentDeepReceipt(row)).toBe(PASSES);

    expect(payloads).toHaveLength(MICROVMS);
    for (const payload of payloads) {
      expect({ timeoutSeconds: payload.timeoutSeconds, memoryMb: payload.memoryMb }).toEqual({
        timeoutSeconds: config.runTimeoutSeconds,
        memoryMb: config.runMemoryMb,
      });
    }
    expect((await purposeCount('validation')) - before.validation).toBe(MICROVMS);
    expect((await purposeCount('grading')) - before.grading).toBe(0);

    // one audit row per run started, on the owner
    const audits = await db.getRepository(AuditEventEntity).find({ where: { event: 'project.deep-validation' } });
    expect(audits.filter((one) => one.actorUserId === owner.id && one.targetId === projectId)).toHaveLength(2);
  });

  it("through the route, a third teacher's start answers queued while two run, and runs once a slot frees", async () => {
    const third = await account('deep-third', 'INSTRUCTOR');
    const draftOf = async (who: { id: string }, title: string) => {
      const made = await app.get(ProjectImporterService).importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: who.id, title });
      return `/api/v1/instructor/projects/${made.projectId}/versions/${made.versionId}/deep-validation`;
    };
    const drafts = [
      { who: owner, at: await draftOf(owner, `Shelf cap one ${stamp}`) },
      { who: other, at: await draftOf(other, `Shelf cap two ${stamp}`) },
      { who: third, at: await draftOf(third, `Shelf cap three ${stamp}`) },
    ];
    const press = async (one: (typeof drafts)[number]) => {
      const res = await request(http).post(one.at).set(bearer(one.who.token)).send({ acknowledgedMicroVMs: MICROVMS }).expect(202);
      said.push(res.text);
      return res.body as { status: string };
    };
    const look = async (one: (typeof drafts)[number]) => {
      const res = await request(http).get(one.at).set(bearer(one.who.token)).expect(200);
      said.push(res.text);
      return res.body as { status: string };
    };
    let open: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (open = resolve));
    payloads.length = 0;
    // the waiting teacher looks again every 25 ms here, so 300 ms is
    // several rounds of the pump finding the cap reached, not less than one
    const service = app.get(DeepValidationService);
    const retryMs = service.retryMs;
    service.retryMs = 25;
    try {
      await press(drafts[0]);
      await press(drafts[1]);
      const until = Date.now() + 10000;
      while (Date.now() < until && ((await look(drafts[0])).status !== 'running' || (await look(drafts[1])).status !== 'running')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect([(await look(drafts[0])).status, (await look(drafts[1])).status]).toEqual(['running', 'running']);
      expect((await press(drafts[2])).status).toBe('queued');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await look(drafts[2])).status).toBe('queued');
    } finally {
      hold = null;
      open();
    }
    await service.idle();
    service.retryMs = retryMs;
    for (const one of drafts) expect((await look(one)).status).toBe(PASSES ? 'passed' : 'failed');
    expect(payloads).toHaveLength(MICROVMS * 3);
  });

  it('no response carried a sealed byte of the Shelf pack', () => {
    const text = said.join('\n');
    expect(said.length).toBeGreaterThan(5);
    expect(ALL_SHELF_MARKERS.filter((marker) => text.includes(marker))).toEqual([]);
  });
});
