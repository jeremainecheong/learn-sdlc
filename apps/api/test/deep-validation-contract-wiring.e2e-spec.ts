import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AUTHORING_ROUTES, DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';
import type { DeepValidationView, RunResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { DEEP_VALIDATION_SCOPE, DeepValidationService } from '../src/authoring/deep-validation';
import { ProjectImporterService } from '../src/content/importer.service';
import { DirectoryPackSource } from '../src/content/pack-source';
import type { CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { ProjectVersionEntity } from '../src/content/project.entities';
import { UserEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { ALL_SHELF_MARKERS, SHELF_DIR } from './fixtures/upload-packs/markers';
import { mockAiForRoutes } from './mock-ai';
import { ExchangeLog, Redactor, holdExchangeContract } from './fixtures/contract-exchanges/recorder';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * Deep validation through the real routes (`deepValidation.read` /
 * `deepValidation.start`, served by `DeepValidationService`), recorded for
 * `apps/web/test/deep-validation-wiring.test.tsx`.
 *
 * The Shelf pack as a teacher's draft (`importTeacherDraft`, the path an
 * upload lands it by). The sandbox is the real `SandboxService` with only its
 * transport replaced, judging a job by its bytes as deep-validation.e2e-spec.ts does, so no
 * microVM boots and nothing leaves the process; the AI is the stub
 * (`mockAiForRoutes`) and deep validation asks it nothing.
 *
 * Recorded, in the order the editor meets them: the view before any run (the
 * cost warning in microVMs), a start naming a stale count (409, by sentence,
 * nothing boots), a start naming the warned count (202), and the view once the
 * run settles. The draft's content digest is held as a `<sha256:n>`
 * placeholder, the same one wherever it appears.
 */
describe('deep validation, recorded', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const PASSWORD = 'Correct-Horse-9';
  const redactor = new Redactor();
  const log = new ExchangeLog();
  const payloads: unknown[] = [];
  let snapshot: CompiledSnapshot;

  /* The transport judges a job by its bytes, as in deep-validation.e2e-spec.ts. */
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
  const MICROVMS = 16 - (DEEP_VALIDATION_SCOPE.mutants ? 0 : 6) - (DEEP_VALIDATION_SCOPE.smoke ? 0 : 2);

  beforeAll(async () => {
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      payloads.push(args[1]);
      return JSON.stringify(judge(args[1] as SandboxJob));
    });
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('confirms the stub AI before anything is driven (m8)', () => {
    expect((app.get(OpenAiProvider) as unknown as { name: string }).name).toBe('mock-ai');
  });

  it('records the view before a run, a stale start, the accepted start and the settled view', async () => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'teacher@rx-contract.test', password: PASSWORD, displayName: 'Zeb Quorrant' })
      .expect(201);
    redactor.name('Zeb Quorrant', 'name:teacher');
    const owner = { id: registered.body.user.id as string, token: registered.body.token as string };
    await db.manager.update(UserEntity, { id: owner.id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(owner.id);

    const draft = await app
      .get(ProjectImporterService)
      .importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: owner.id, title: 'Shelf of our own' });
    snapshot = (await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: draft.versionId })).compiled as CompiledSnapshot;
    const at = `/api/v1${AUTHORING_ROUTES['deepValidation.read'].path
      .replace(':projectId', draft.projectId)
      .replace(':versionId', draft.versionId)}`;
    expect(AUTHORING_ROUTES['deepValidation.start'].path).toBe(AUTHORING_ROUTES['deepValidation.read'].path);

    const said: string[] = [];
    const get = async (name: string) => {
      const res = await request(http).get(at).set(bearer(owner.token)).expect(200);
      said.push(res.text);
      log.take(name, 'GET', at, undefined, res);
      return res.body as DeepValidationView;
    };
    const post = async (name: string, body: { acknowledgedMicroVMs: number }, status: number) => {
      const res = await request(http).post(at).set(bearer(owner.token)).send(body).expect(status);
      said.push(res.text);
      log.take(name, 'POST', at, body, res);
      return res.body;
    };

    const before = await get('readNotRun');
    expect(before).toMatchObject({ status: 'not-run', current: false, contentDigest: null });
    expect(before.costWarning).toEqual({ microVMs: MICROVMS, sentence: deepValidationCostWarning(MICROVMS) });

    const stale = await post('startStale', { acknowledgedMicroVMs: MICROVMS - 1 }, 409);
    expect(String(stale.message)).toContain(`${MICROVMS} microVMs`);
    expect(payloads).toHaveLength(0);

    const queued = (await post('start', { acknowledgedMicroVMs: before.costWarning.microVMs }, 202)) as DeepValidationView;
    expect(['queued', 'running']).toContain(queued.status);
    await app.get(DeepValidationService).idle();
    const settled = await get('readSettled');
    expect(settled.checks.map((one) => one.id)).toEqual([...DEEP_VALIDATION_CHECK_IDS]);
    expect(settled.current).toBe(true);
    expect(typeof settled.contentDigest).toBe('string');
    expect(payloads).toHaveLength(MICROVMS);

    // Nothing the routes answered carries a sealed byte of the Shelf pack.
    expect(ALL_SHELF_MARKERS.filter((marker) => said.join('\n').includes(marker))).toEqual([]);

    holdExchangeContract(
      'deep-validation',
      'apps/api/test/deep-validation-contract-wiring.e2e-spec.ts',
      log,
      { projectId: draft.projectId, versionId: draft.versionId, microVMs: MICROVMS, settledStatus: settled.status },
      redactor,
    );
  }, 240000);
});
