import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as ts from 'typescript';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';
import type { DeepValidationReceipt, DeepValidationView, RunResult } from '@learnsdlc/shared';
import { taskScopeOf } from '../assistant/project-scope';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { compilePack, isQuizTask, type CompiledSnapshot } from '../content/pack-compiler';
import type { CodeChecks, ConfigChecks, PhaseContent, TestsChecks } from '../content/content.types';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import type { ProjectVersionValidation } from '../content/project.entities';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ALL_SHELF_MARKERS, SHELF_DIR } from '../../test/fixtures/upload-packs/markers';
import { ALL_ENTITIES, AuditEventEntity } from '../db/entities';
import { SandboxService } from '../execution/sandbox.service';
import type { SandboxJob, SandboxTestJob, SandboxTraceOwner } from '../execution/sandbox.service';
import { SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH } from '../content/screen-copy';
import { sandboxExecutionDuration } from '../observability/metrics';
import {
  copyTaskTrackr,
  draftSnapshot,
  openForkWorld,
  phaseOf,
  S1_TEACHER,
  type Fork,
  type ForkWorld,
} from '../../test/tasktrackr-phase';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
  treeMigrationsDir,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import {
  DEEP_VALIDATION_AUDIT_EVENT,
  DEEP_VALIDATION_PLATFORM_IN_FLIGHT,
  DEEP_VALIDATION_SCOPE,
  DEEP_VALIDATION_STEP_PREFIX,
  DeepValidationService,
  deepRunHeartbeatBoundMs,
  executableContentDigest,
  hasCurrentDeepReceipt,
  isReferenceExecutablePhase,
} from './deep-validation';
import { isReferenceApplicationPhase } from './provenance';

/**
 * Deep validation of a teacher's draft, in the sandbox, with no model call.
 *
 * The four checks, a to d: the reference solution passes its hidden suite;
 * the starter fails it; every mutant dies under the reference tests (the
 * cuttable `mutants` sub-check); the deployment smoke runs on a working
 * configuration and the drill breaks it (the cuttable `smoke` sub-check).
 * (a) and (b) are never cut.
 *
 * Most executable phases here are a teacher's copy of the platform project,
 * doctored per case, and some come from the shelf upload fixture. The
 * sandbox is a stub that judges a job by its bytes: a hidden
 * suite passes exactly the workspace that holds the reference solution; a
 * reference suite passes exactly the reference implementation, and kills
 * anything else; a smoke run fails on the drill's faulted copy.
 *
 * Two cases use the real `SandboxService` with only its transport replaced,
 * because what they prove lives inside `execute`: the purpose a run is
 * labelled with, and the learner limits it is sent with.
 */

/* --------------------------------- helpers --------------------------------- */

const ADMIN = { id: 'admin-deep', role: 'ADMIN' as const, cohort: 'default' };
const OTHER_TEACHER = { id: 'teacher-deep-other', role: 'INSTRUCTOR' as const, cohort: 'default' };

const status = (error: unknown) => (error instanceof HttpException ? error.getStatus() : -1);
const caught = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const passing = (n = 4): RunResult => ({
  ok: true,
  exitKind: 'ok',
  stdout: '',
  stderr: '',
  durationMs: 1,
  tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] },
});
const failing = (n = 4, failed = 2): RunResult => ({
  ok: false,
  exitKind: 'error',
  stdout: '',
  stderr: '',
  durationMs: 1,
  tests: {
    total: n,
    passed: n - failed,
    failed,
    errored: 0,
    cases: [{ name: 'test_case', status: 'failed', message: 'assertion' } as never],
  },
});
const smoke = (ok: boolean): RunResult => ({ ok, exitKind: ok ? 'ok' : 'error', stdout: '', stderr: ok ? '' : 'refused', durationMs: 1 });

const executable = (snapshot: CompiledSnapshot): PhaseContent[] =>
  snapshot.content.phases.filter((p) => p.checks.kind === 'code' || p.checks.kind === 'tests' || p.checks.kind === 'config');

const sameFiles = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a).sort();
  return keys.join('\n') === Object.keys(b).sort().join('\n') && keys.every((k) => a[k] === b[k]);
};

/**
 * The stub's judgement, read off the snapshot the run was planned from:
 * - a smoke job fails when it carries the drill's faulted copy;
 * - a job with graded files is a reference-suite run: it passes exactly the
 *   reference implementation, a survivor's files included, and kills the rest;
 * - any other tests job is a hidden-suite run, which passes exactly the
 *   workspace whose solution paths hold the reference solution.
 */
function judgeFor(snapshot: CompiledSnapshot, survivors: string[] = []): (job: SandboxJob) => RunResult {
  const phases = executable(snapshot);
  return (job) => {
    if (job.mode === 'smoke') {
      for (const phase of phases) {
        const drill = phase.checks.kind === 'config' ? (phase.checks as ConfigChecks).drill : undefined;
        if (!drill) continue;
        const faulted = Object.entries(drill.faultedFiles).some(([at, bytes]) => job.files[at] === bytes);
        if (faulted) return smoke(false);
      }
      return smoke(true);
    }
    if (job.gradedFiles) {
      for (const phase of phases) {
        if (phase.checks.kind !== 'tests') continue;
        const checks = phase.checks as TestsChecks;
        for (const run of checks.runs) {
          if (sameFiles(job.gradedFiles, run.implFiles)) return passing();
          const survived = checks.mutants.some(
            (m) => survivors.includes(m.name) && sameFiles(job.gradedFiles!, { ...run.implFiles, ...m.files }),
          );
          if (survived) return passing();
        }
      }
      return failing();
    }
    for (const phase of phases) {
      if (phase.checks.kind !== 'code') continue;
      const checks = phase.checks as CodeChecks;
      const hidden = checks.runs.some((run) =>
        Object.entries(run.hiddenTestFiles).every(([at, bytes]) => job.files[at] === bytes) && Object.keys(run.hiddenTestFiles).length > 0,
      );
      if (!hidden) continue;
      const solved = Object.entries(checks.solutionFiles).every(([at, bytes]) => job.files[at] === bytes);
      return solved ? passing() : failing();
    }
    return failing();
  };
}

/**
 * TaskTrackr's selfcheck, asked of the bytes: a smoke run passes only when the
 * compose file it carries gives the web service an API_URL naming the api
 * service (ops/selfcheck.py's `web_reaches_api`). The starter's compose leaves
 * API_URL empty and the drill's names localhost, so both fail here as they
 * fail in the sandbox. Every other job is judged as `judgeFor` judges it.
 */
function selfcheckJudgeFor(snapshot: CompiledSnapshot): (job: SandboxJob) => RunResult {
  const rest = judgeFor(snapshot);
  return (job) =>
    job.mode === 'smoke' ? smoke(/^\s*API_URL:\s*"?http:\/\/api:8000"?\s*$/m.test(job.files['docker-compose.yml'] ?? '')) : rest(job);
}

/** A sandbox the spec controls: it records every job and can hold them all at a gate. */
class StubSandbox {
  calls: { job: SandboxJob; owner?: SandboxTraceOwner }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private released: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;

  constructor(public judge: (job: SandboxJob) => RunResult) {}

  hold(): void {
    this.released = new Promise<void>((resolve) => (this.release = resolve));
  }

  open(): void {
    this.release();
  }

  async execute(job: SandboxJob, owner?: SandboxTraceOwner): Promise<RunResult> {
    this.calls.push({ job, owner });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.released;
      return this.judge(job);
    } finally {
      this.inFlight -= 1;
    }
  }
}

/**
 * A sandbox whose jobs wait at a gate of their own draft, so a spec can
 * let one run finish while another still holds. A draft with no gate runs
 * straight through.
 */
class GateSandbox {
  calls: { job: SandboxJob; owner?: SandboxTraceOwner }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly gates = new Map<string, { at: Promise<void>; open: () => void }>();

  constructor(public judge: (job: SandboxJob) => RunResult) {}

  hold(...versionIds: string[]): void {
    for (const id of versionIds) {
      let open: () => void = () => undefined;
      const at = new Promise<void>((resolve) => (open = resolve));
      this.gates.set(id, { at, open });
    }
  }

  open(...versionIds: string[]): void {
    for (const id of versionIds.length ? versionIds : [...this.gates.keys()]) {
      this.gates.get(id)?.open();
      this.gates.delete(id);
    }
  }

  async execute(job: SandboxJob, owner?: SandboxTraceOwner): Promise<RunResult> {
    this.calls.push({ job, owner });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const gate = owner ? this.gates.get(owner.ownerId) : undefined;
      if (gate) await gate.at;
      return this.judge(job);
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** The calls of one draft, by index in the sandbox's order. */
const spanOf = (calls: { owner?: SandboxTraceOwner }[], versionId: string): { first: number; last: number } => {
  const at = calls.map((call, i) => (call.owner?.ownerId === versionId ? i : -1)).filter((i) => i >= 0);
  return { first: at.length ? at[0] : -1, last: at.length ? at[at.length - 1] : -1 };
};

/**
 * The most deep validations ever running at once, read off the sandbox's
 * order: a run is running from its first job to its last, and its jobs are
 * one after another, so overlapping spans are runs in flight together.
 */
const mostAtOnce = (calls: { owner?: SandboxTraceOwner }[]): number => {
  const ids = [...new Set(calls.map((call) => call.owner?.ownerId).filter((id): id is string => Boolean(id)))];
  const spans = ids.map((id) => spanOf(calls, id));
  let most = 0;
  for (let i = 0; i < calls.length; i += 1) most = Math.max(most, spans.filter((span) => span.first <= i && i <= span.last).length);
  return most;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (what: string, test: () => boolean | Promise<boolean>, ms = 10000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const checkOf = (view: DeepValidationView, id: (typeof DEEP_VALIDATION_CHECK_IDS)[number]) => {
  const one = view.checks.find((check) => check.id === id);
  if (!one) throw new Error(`no ${id} check in the view`);
  return one;
};

/**
 * What one full deep validation of a snapshot books, and how each check
 * reads when it is clean, under the release's cuts (DEEP_VALIDATION_SCOPE):
 * the compiler's own price, less a cut phase's share. A cut fails closed: a
 * cut phase that is not the reference project's own fails its check.
 */
const expectedOf = (snapshot: CompiledSnapshot) => {
  const byPhase = snapshot.sandboxBudgetByPhase ?? {};
  const phaseOf = (key: string) => snapshot.content.phases.find((p) => p.key === key);
  const kindOf = (key: string) => phaseOf(key)?.checks.kind;
  let microVMs = snapshot.sandboxBudget;
  for (const key of Object.keys(byPhase)) {
    if (kindOf(key) === 'tests' && !DEEP_VALIDATION_SCOPE.mutants) microVMs -= byPhase[key];
    if (kindOf(key) === 'config' && !DEEP_VALIDATION_SCOPE.smoke) microVMs -= byPhase[key];
  }
  const cutFails = (kind: 'tests' | 'config') =>
    snapshot.content.phases.some(
      (p) =>
        p.checks.kind === kind &&
        (kind === 'tests' || Boolean((p.checks as ConfigChecks).smokeCommands?.length)) &&
        !isReferenceApplicationPhase(p),
    );
  const statusOf = (id: string): string => {
    if (id === 'mutants-killed' && !DEEP_VALIDATION_SCOPE.mutants) return cutFails('tests') ? 'failed' : 'not-applicable';
    if (id === 'smoke-passes' && !DEEP_VALIDATION_SCOPE.smoke) return cutFails('config') ? 'failed' : 'not-applicable';
    return 'passed';
  };
  const clean = DEEP_VALIDATION_CHECK_IDS.map((id) => [id, statusOf(id)]);
  const passes = clean.every(([, status]) => status !== 'failed');
  return { microVMs, clean, status: passes ? 'passed' : 'failed', passes };
};
const itMutants = DEEP_VALIDATION_SCOPE.mutants ? it : it.skip;
const itSmoke = DEEP_VALIDATION_SCOPE.smoke ? it : it.skip;

/** The controller's own trace rule (infra/microvm/controller/operation_trace.py), restated. */
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const traceIsValid = (owner: SandboxTraceOwner): boolean =>
  Object.keys({ ...owner, attemptId: 'x' }).sort().join(',') === 'attemptId,kind,ownerId,stepId' &&
  owner.kind === 'run' &&
  (UUID.test(owner.ownerId) || /^[0-9a-f]{24}$/.test(owner.ownerId)) &&
  /^[A-Za-z0-9_.:-]{1,80}$/.test(owner.stepId);

/* ----------------------------- the service, sqlite ----------------------------- */

describe('DeepValidationService', () => {
  let world: ForkWorld;
  let fork: Fork;
  let base: CompiledSnapshot;

  const versions = () => world.dataSource.getRepository(ProjectVersionEntity);
  const snapshotOf = async (versionId: string): Promise<CompiledSnapshot> => {
    let row = await versions().findOneByOrFail({ id: versionId });
    if (!row.compiled) {
      const project = await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: row.projectId });
      await world.service.validate(S1_TEACHER, project.id, versionId);
      row = await versions().findOneByOrFail({ id: versionId });
    }
    return row.compiled as CompiledSnapshot;
  };
  const setSnapshot = async (versionId: string, snapshot: CompiledSnapshot) => {
    await versions().update({ id: versionId }, { compiled: snapshot });
  };
  const run = async (service: DeepValidationService, versionId: string, caller = S1_TEACHER) => {
    await service.start(caller, versionId);
    await service.idle();
    return service.view(caller, versionId);
  };

  beforeAll(async () => {
    world = await openForkWorld();
    fork = await copyTaskTrackr(world, 'deep-owner');
    base = clone(await snapshotOf(fork.versionId));
  });

  afterAll(async () => {
    await world?.close();
  });

  beforeEach(async () => {
    await setSnapshot(fork.versionId, clone(base));
    await versions().update({ id: fork.versionId }, { validation: null });
  });

  it('› a clean draft passes all four checks, and its receipt is current and keyed by the executable-content digest', async () => {
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    expect(view.status).toBe('passed');
    expect(view.checks.map((check) => [check.id, check.status])).toEqual(expectedOf(base).clean);
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    expect(row.validation?.['deep' as never]).toBeDefined();
    expect(view.contentDigest).toBe(executableContentDigest(row));
    expect(view.current).toBe(true);
    expect(hasCurrentDeepReceipt(row)).toBe(true);
    // one full pass of the executable phases: what the compiler prices it at
    expect(stub.calls).toHaveLength(expectedOf(base).microVMs);
    expect(view.costWarning).toEqual({ microVMs: expectedOf(base).microVMs, sentence: deepValidationCostWarning(expectedOf(base).microVMs) });
  });

  it('› refuses a starter that already passes', async () => {
    const doctored = clone(base);
    const implementation = doctored.content.phases.find((p) => p.key === 'implementation')!;
    const solution = (implementation.checks as CodeChecks).solutionFiles;
    implementation.files = implementation.files.map((file) =>
      solution[file.path] !== undefined && file.editable ? { ...file, content: solution[file.path] } : file,
    );
    await setSnapshot(fork.versionId, doctored);
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(doctored)) as never, world.content);
    const view = await run(service, fork.versionId);
    expect(view.status).toBe('failed');
    const starter = checkOf(view, 'starter-fails-hidden');
    expect(starter.status).toBe('failed');
    expect(starter.phaseKey).toBe('implementation');
    expect(starter.sentence).toContain(implementation.title);
    expect(starter.sentence).toMatch(/starter already passes/);
    expect(checkOf(view, 'solution-passes-hidden').status).toBe('passed');
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    expect(hasCurrentDeepReceipt(row)).toBe(false);
  });

  it('› refuses a reference solution that fails its hidden suite, a check that is never cut', async () => {
    const doctored = clone(base);
    const maintenance = doctored.content.phases.find((p) => p.key === 'maintenance')!;
    const checks = maintenance.checks as CodeChecks;
    const [first] = Object.keys(checks.solutionFiles);
    checks.solutionFiles = { ...checks.solutionFiles, [first]: `${checks.solutionFiles[first]}\n# drift\n` };
    await setSnapshot(fork.versionId, doctored);
    // the judge is the clean pack's: the drifted solution no longer matches it
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    const view = await run(service, fork.versionId);
    const solution = checkOf(view, 'solution-passes-hidden');
    expect({ status: solution.status, phaseKey: solution.phaseKey }).toEqual({ status: 'failed', phaseKey: 'maintenance' });
    expect(solution.sentence).toContain(maintenance.title);
    expect(view.status).toBe('failed');
  });

  itMutants('› refuses a mutant the reference tests do not kill (the mutant sub-check)', async () => {
    const doctored = clone(base);
    const testing = doctored.content.phases.find((p) => p.key === 'testing')!;
    const checks = testing.checks as TestsChecks;
    const run0 = checks.runs[0];
    const [target] = Object.keys(run0.implFiles);
    checks.mutants = [
      ...checks.mutants,
      {
        name: 'planted_survivor',
        description: 'Changes nothing the reference tests read.',
        run: run0.id,
        files: { [target]: run0.implFiles[target] },
      },
    ];
    await setSnapshot(fork.versionId, doctored);
    const stub = new StubSandbox(judgeFor(doctored, ['planted_survivor']));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    const mutants = checkOf(view, 'mutants-killed');
    expect({ status: mutants.status, phaseKey: mutants.phaseKey }).toEqual({ status: 'failed', phaseKey: 'testing' });
    expect(mutants.sentence).toContain('planted_survivor');
    expect(view.status).toBe('failed');
    expect(view.costWarning.microVMs).toBe(expectedOf(base).microVMs + 1);
    expect(stub.calls).toHaveLength(expectedOf(base).microVMs + 1);
  });

  itSmoke('› refuses a drill that does not break the smoke run (the drill sub-check)', async () => {
    const doctored = clone(base);
    const deployment = doctored.content.phases.find((p) => p.key === 'deployment')!;
    const stub = new StubSandbox((job) => (job.mode === 'smoke' ? smoke(true) : judgeFor(doctored)(job)));
    await setSnapshot(fork.versionId, doctored);
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    const check = checkOf(view, 'smoke-passes');
    expect({ status: check.status, phaseKey: check.phaseKey }).toEqual({ status: 'failed', phaseKey: 'deployment' });
    expect(check.sentence).toContain(deployment.title);
    const smokes = stub.calls.filter((call) => call.job.mode === 'smoke');
    expect(smokes).toHaveLength(2);
  });

  itSmoke("› the smoke step runs the working container on the pack's finished copy of each editable file", async () => {
    const deployment = base.content.phases.find((p) => p.key === 'deployment')!;
    const checks = deployment.checks as ConfigChecks;
    const finished = deployment.files.filter((f) => f.editable && checks.smokeImplFiles[f.path] !== undefined);
    // the case: TaskTrackr's starter compose is half-written, and the pack's smoke folder ships it finished
    expect(finished.map((f) => f.path)).toEqual(['docker-compose.yml']);
    expect(finished[0].content).toMatch(/^\s*API_URL: ""\s*$/m);
    expect(checks.smokeImplFiles['docker-compose.yml']).toMatch(/^\s*API_URL: http:\/\/api:8000\s*$/m);
    const stub = new StubSandbox(selfcheckJudgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    const smokes = stub.calls.filter((call) => call.job.mode === 'smoke');
    expect(smokes).toHaveLength(2);
    const working = smokes[0].job.files;
    // each editable file the smoke folder ships is the pack's finished copy, as the pack check's working workspace is
    for (const file of finished) expect({ at: file.path, bytes: working[file.path] }).toEqual({ at: file.path, bytes: checks.smokeImplFiles[file.path] });
    // and nothing broader: an editable file the smoke folder does not ship stays the starter's, a read-only file the phase's own
    for (const file of deployment.files.filter((f) => f.path !== checks.smokeDockerfile && !finished.includes(f))) {
      expect({ at: file.path, bytes: working[file.path] }).toEqual({ at: file.path, bytes: file.content });
    }
    // the Dockerfile is the one deep validation builds from the smoke command, whatever the starter's says
    expect(working[checks.smokeDockerfile]).toContain('ENTRYPOINT ["python3","api/main.py"]');
    expect(checkOf(view, 'smoke-passes').status).toBe('passed');
  });

  itSmoke('› the drill step still lays its broken file over the finished set', async () => {
    const deployment = base.content.phases.find((p) => p.key === 'deployment')!;
    const checks = deployment.checks as ConfigChecks;
    const drill = checks.drill!;
    expect(Object.keys(drill.faultedFiles)).toEqual(['docker-compose.yml']);
    const stub = new StubSandbox(selfcheckJudgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    const [working, broken] = stub.calls.filter((call) => call.job.mode === 'smoke');
    // the faulted compose over the working set, and only that file differs
    expect(broken.job.files).toEqual({ ...working.job.files, ...drill.faultedFiles });
    expect(broken.job.files['docker-compose.yml']).toMatch(/^\s*API_URL: http:\/\/localhost:8000\s*$/m);
    // the run on it still fails, and the working one passes: the check passes on both
    expect([stub.judge(working.job).ok, stub.judge(broken.job).ok]).toEqual([true, false]);
    const check = checkOf(view, 'smoke-passes');
    expect({ status: check.status, phaseKey: check.phaseKey }).toEqual({ status: 'passed', phaseKey: 'deployment' });
  });

  it('› a run the sandbox could not perform is never a pass', async () => {
    const stub = new StubSandbox(() => ({ ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 0 }));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    expect(view.status).toBe('failed');
    for (const check of view.checks) expect(check.status).toBe(check.status === 'not-applicable' ? 'not-applicable' : 'failed');
    expect(view.checks.filter((check) => check.status === 'failed').length).toBeGreaterThanOrEqual(2);
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    expect(hasCurrentDeepReceipt(row)).toBe(false);
  });

  it('› a second deep validation by the same teacher waits', async () => {
    const second = await copyTaskTrackr(world, 'deep-owner-two');
    const elsewhere = await world.service.createProject(OTHER_TEACHER as never, {
      title: 'Copy deep-other',
      slug: 'deep-other',
      fromVersionId: world.seedVersionId,
    });
    const stub = new StubSandbox(judgeFor(base));
    stub.hold();
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const auditsOf = async () =>
      (await world.dataSource.getRepository(AuditEventEntity).find({ where: { event: DEEP_VALIDATION_AUDIT_EVENT } })).filter(
        (row) => row.actorUserId === S1_TEACHER.id,
      ).length;
    const auditsBefore = await auditsOf();

    const first = await service.start(S1_TEACHER, fork.versionId);
    expect(['queued', 'running']).toContain(first.status);
    await waitFor('the first run to reach the sandbox', () => stub.calls.length === 1);
    expect((await service.view(S1_TEACHER, fork.versionId)).status).toBe('running');

    const waiting = await service.start(S1_TEACHER, second.versionId);
    expect(waiting.status).toBe('queued');
    // the same draft twice is the same run, not a second one
    const again = await service.start(S1_TEACHER, fork.versionId);
    expect(again.status).toBe('running');

    // another teacher is not behind this one
    await service.start(OTHER_TEACHER, elsewhere.draftVersionId);
    await waitFor('the other teacher to reach the sandbox', () =>
      stub.calls.some((call) => call.owner?.ownerId === elsewhere.draftVersionId),
    );
    expect((await service.view(S1_TEACHER, second.versionId)).status).toBe('queued');
    expect(stub.calls.filter((call) => call.owner?.ownerId === second.versionId)).toHaveLength(0);

    stub.open();
    await service.idle();
    expect((await service.view(S1_TEACHER, fork.versionId)).status).toBe('passed');
    expect((await service.view(S1_TEACHER, second.versionId)).status).toBe('passed');
    // the first teacher's runs never overlapped: all of the first draft's, then all of the second's
    const mine = stub.calls.filter((call) => call.owner?.ownerId !== elsewhere.draftVersionId).map((call) => call.owner?.ownerId);
    const firstIndexOfSecond = mine.indexOf(second.versionId);
    expect(mine.slice(0, firstIndexOfSecond).every((id) => id === fork.versionId)).toBe(true);
    expect(mine.slice(firstIndexOfSecond).every((id) => id === second.versionId)).toBe(true);
    expect(mine).toHaveLength(expectedOf(base).microVMs * 2);
    // one audit row per run started, none for the repeat press
    const audits = await world.dataSource.getRepository(AuditEventEntity).find({ where: { event: DEEP_VALIDATION_AUDIT_EVENT } });
    const ofThese = audits.filter(
      (row) => row.actorUserId === S1_TEACHER.id && (row.detail as { versionId?: string } | null)?.versionId === second.versionId,
    );
    expect(ofThese).toHaveLength(1);
    expect((await auditsOf()) - auditsBefore).toBe(2);
  });

  it('› the Shelf pack, uploaded as a teacher draft: one full pass, all four checks, and no sealed byte in the view or the receipt', async () => {
    const importer = new ProjectImporterService(world.content, world.dataSource);
    const draft = await importer.importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: S1_TEACHER.id, title: 'Shelf deep' });
    const shelf = await snapshotOf(draft.versionId);
    const stub = new StubSandbox(judgeFor(shelf));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const before = await service.view(S1_TEACHER, draft.versionId);
    expect(shelf.sandboxBudget).toBe(16);
    expect(before.costWarning.microVMs).toBe(expectedOf(shelf).microVMs);
    const view = await run(service, draft.versionId);
    // under a cut, the shelf upload's own Testing/Deployment fail closed
    expect(view.status).toBe(expectedOf(shelf).status);
    expect(view.checks.map((check) => [check.id, check.status])).toEqual(expectedOf(shelf).clean);
    expect(stub.calls).toHaveLength(expectedOf(shelf).microVMs);
    // implementation and maintenance (a, b), testing's 2 reference runs and 4 mutants (c), smoke then drill (d)
    expect(stub.calls.map((call) => call.job.mode)).toEqual([
      ...Array(8 + (DEEP_VALIDATION_SCOPE.mutants ? 6 : 0)).fill('tests'),
      ...(DEEP_VALIDATION_SCOPE.smoke ? ['smoke', 'smoke'] : []),
    ]);
    const row = await versions().findOneByOrFail({ id: draft.versionId });
    expect(hasCurrentDeepReceipt(row)).toBe(expectedOf(shelf).passes);
    const said = JSON.stringify({ before, view, deep: (row.validation as unknown as { deep: unknown }).deep });
    expect(ALL_SHELF_MARKERS.filter((marker) => said.includes(marker))).toEqual([]);

    // and the starter of the shelf upload's own implementation, made to pass, is refused
    const doctored = clone(shelf);
    const implementation = doctored.content.phases.find((p) => p.key === 'implementation')!;
    const solution = (implementation.checks as CodeChecks).solutionFiles;
    implementation.files = implementation.files.map((file) =>
      solution[file.path] !== undefined && file.editable ? { ...file, content: solution[file.path] } : file,
    );
    await setSnapshot(draft.versionId, doctored);
    stub.judge = judgeFor(doctored);
    const refused = await run(service, draft.versionId);
    expect({ status: refused.status, starter: checkOf(refused, 'starter-fails-hidden').status }).toEqual({ status: 'failed', starter: 'failed' });
    expect(ALL_SHELF_MARKERS.filter((marker) => JSON.stringify(refused).includes(marker))).toEqual([]);
  });

  it('› makes no model call', async () => {
    // every model transport this API has goes out through fetch, an http(s)
    // ClientRequest, or a raw socket; none of the three may move
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const httpSpy = jest.spyOn(http.ClientRequest.prototype, 'end');
    const socketSpy = jest.spyOn(net.Socket.prototype, 'connect');
    try {
      const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
      const view = await run(service, fork.versionId);
      expect(view.status).toBe('passed');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(socketSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      socketSpy.mockRestore();
    }
    // and nothing that could make one is in reach: the module's code names no
    // AI provider or AI setting, the only assistant imports are the pure
    // anchor modules (read-only), nothing in their import closure is a
    // provider or a service that calls one, and the service is built from the
    // database, the sandbox and the pack helpers. The module is parsed rather
    // than searched as text, so a comment may name a provider; its names,
    // strings and import specifiers may not.
    const source = fs.readFileSync(path.join(__dirname, 'deep-validation.ts'), 'utf-8');
    const specifiers: string[] = [];
    const words: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) words.push(node.text);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      const dynamic = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'));
      if (dynamic && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('deep-validation.ts', source, ts.ScriptTarget.Latest, true));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(words.filter((word) => /openai|AI_PROVIDER|aiMaxConcurrency/i.test(word))).toEqual([]);
    const assistantImports = specifiers.filter((one) => one.startsWith('../assistant/'));
    expect(assistantImports.filter((one) => !['../assistant/project-scope', '../assistant/reference-exec-anchors'].includes(one))).toEqual([]);
    const closure = new Set<string>();
    const walk = (file: string): void => {
      if (closure.has(file) || !fs.existsSync(file)) return;
      closure.add(file);
      const text = fs.readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
        const target = path.resolve(path.dirname(file), m[1]);
        walk(fs.existsSync(`${target}.ts`) ? `${target}.ts` : path.join(target, 'index.ts'));
      }
    };
    walk(path.join(__dirname, 'deep-validation.ts'));
    const reached = [...closure].map((file) => path.relative(path.join(__dirname, '..'), file));
    expect(reached.filter((file) => /provider|assistant\.service|agentic|interview\.service|explain\.service|stuck\.service|mentor\.controller|openai/i.test(file))).toEqual([]);
    const injected = (Reflect.getMetadata('design:paramtypes', DeepValidationService) as Function[]).map((one) => one.name);
    expect(injected).toEqual(['DataSource', 'SandboxService', 'ContentService']);
  });

  it("› its jobs carry purpose 'validation' and the learner limits", async () => {
    const judge = judgeFor(base);
    const payloads: Record<string, unknown>[] = [];
    const transport = jest
      .spyOn(SandboxService.prototype as any, 'runPython')
      .mockImplementation(async (...args: unknown[]) => {
        const payload = args[1] as Record<string, unknown>;
        payloads.push(payload);
        return JSON.stringify(judge(payload as unknown as SandboxJob));
      });
    const owners: SandboxTraceOwner[] = [];
    const sandbox = new SandboxService();
    const execute = sandbox.execute.bind(sandbox);
    jest.spyOn(sandbox, 'execute').mockImplementation(async (job, owner) => {
      if (owner) owners.push(owner);
      return execute(job, owner);
    });
    const count = async (purpose: string) =>
      ((await sandboxExecutionDuration.get()).values as { metricName?: string; labels: Record<string, unknown>; value: number }[])
        .filter((v) => v.metricName === 'sandbox_execution_duration_seconds_count' && v.labels.purpose === purpose)
        .reduce((sum, v) => sum + v.value, 0);
    const before = { validation: await count('validation'), grading: await count('grading'), run: await count('run') };
    try {
      const service = new DeepValidationService(world.dataSource, sandbox, world.content);
      const view = await run(service, fork.versionId);
      expect(view.status).toBe('passed');
    } finally {
      transport.mockRestore();
    }
    expect(payloads).toHaveLength(expectedOf(base).microVMs);
    for (const payload of payloads) {
      expect({ timeoutSeconds: payload.timeoutSeconds, memoryMb: payload.memoryMb }).toEqual({
        timeoutSeconds: config.runTimeoutSeconds,
        memoryMb: config.runMemoryMb,
      });
    }
    expect(owners).toHaveLength(expectedOf(base).microVMs);
    for (const owner of owners) {
      expect(owner.stepId.startsWith(DEEP_VALIDATION_STEP_PREFIX)).toBe(true);
      expect(owner.ownerId).toBe(fork.versionId);
      // the trace header the microVM controller accepts, exactly: no new field
      expect(traceIsValid(owner)).toBe(true);
    }
    expect((await count('validation')) - before.validation).toBe(expectedOf(base).microVMs);
    expect((await count('grading')) - before.grading).toBe(0);
    expect((await count('run')) - before.run).toBe(0);
  });

  it("GUARD › TaskTrackr grading jobs still carry purpose 'grading'", async () => {
    const transport = jest
      .spyOn(SandboxService.prototype as any, 'runPython')
      .mockImplementation(async () => JSON.stringify(passing()));
    const count = async (purpose: string) =>
      ((await sandboxExecutionDuration.get()).values as { metricName?: string; labels: Record<string, unknown>; value: number }[])
        .filter((v) => v.metricName === 'sandbox_execution_duration_seconds_count' && v.labels.purpose === purpose)
        .reduce((sum, v) => sum + v.value, 0);
    const job: SandboxJob = { files: {}, mode: 'tests', testPaths: ['tests'], language: 'python' };
    try {
      const sandbox = new SandboxService();
      const before = { grading: await count('grading'), run: await count('run'), validation: await count('validation') };
      // a graded submission sends no owner (feedback.service.ts runSandbox)
      await sandbox.execute(job);
      // a learner's Run press names its run and step (execution.service.ts)
      await sandbox.execute(job, { kind: 'run', ownerId: '00000000-0000-4000-8000-000000000001', stepId: 'api' });
      await sandbox.execute(job, { kind: 'run', ownerId: '00000000-0000-4000-8000-000000000001', stepId: 'smoke' });
      expect((await count('grading')) - before.grading).toBe(1);
      expect((await count('run')) - before.run).toBe(2);
      expect((await count('validation')) - before.validation).toBe(0);
    } finally {
      transport.mockRestore();
    }
  });

  it('› the digest moves with an executable byte and with nothing else', async () => {
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    const digest = executableContentDigest(row);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(executableContentDigest(clone(row))).toBe(digest);

    const hidden = clone(row);
    const implementation = hidden.compiled!.content.phases.find((p) => p.key === 'implementation')!;
    const run0 = (implementation.checks as CodeChecks).runs[0];
    const [at] = Object.keys(run0.hiddenTestFiles);
    run0.hiddenTestFiles[at] = `${run0.hiddenTestFiles[at]}\n# one more case\n`;
    expect(executableContentDigest(hidden)).not.toBe(digest);

    const written = clone(row);
    const requirements = written.compiled!.content.phases.find((p) => p.key === 'requirements')!;
    requirements.files = requirements.files.map((file, i) => (i === 0 ? { ...file, content: `${file.content}\nA new line.\n` } : file));
    expect(executableContentDigest(written)).toBe(digest);
  });

  it('› a receipt stops being current the moment an executable byte changes', async () => {
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    expect((await run(service, fork.versionId)).current).toBe(true);
    const doctored = clone(base);
    const testing = doctored.content.phases.find((p) => p.key === 'testing')!;
    const run0 = (testing.checks as TestsChecks).runs[0];
    const [at] = Object.keys(run0.referenceTestFiles);
    run0.referenceTestFiles[at] = `${run0.referenceTestFiles[at]}\n`;
    await setSnapshot(fork.versionId, doctored);
    const view = await service.view(S1_TEACHER, fork.versionId);
    expect({ status: view.status, current: view.current }).toEqual({ status: 'passed', current: false });
    expect(hasCurrentDeepReceipt(await versions().findOneByOrFail({ id: fork.versionId }))).toBe(false);
  });

  it('› the start is refused when the microVM count shown is not the count now, and nothing boots', async () => {
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const microVMs = expectedOf(base).microVMs;
    const refused = await caught(service.start(S1_TEACHER, fork.versionId, { acknowledgedMicroVMs: microVMs - 1 }));
    expect(status(refused)).toBe(409);
    expect((refused as HttpException).message).toContain(String(microVMs));
    await service.idle();
    expect(stub.calls).toHaveLength(0);
    const view = await service.start(S1_TEACHER, fork.versionId, { acknowledgedMicroVMs: microVMs });
    expect(['queued', 'running']).toContain(view.status);
    await service.idle();
  });

  it("› only the owner starts it: another teacher 404, an ADMIN 403, the platform's own version 403, a published version 409", async () => {
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    expect(status(await caught(service.start(OTHER_TEACHER, fork.versionId)))).toBe(404);
    expect(status(await caught(service.view(OTHER_TEACHER, fork.versionId)))).toBe(404);
    expect(status(await caught(service.start(ADMIN, fork.versionId)))).toBe(403);
    expect(status(await caught(service.start(S1_TEACHER, 'not-a-uuid')))).toBe(404);
    expect(status(await caught(service.start(S1_TEACHER, world.seedVersionId)))).toBe(403);
    await versions().update({ id: fork.versionId }, { status: 'published' });
    try {
      expect(status(await caught(service.start(S1_TEACHER, fork.versionId)))).toBe(409);
    } finally {
      await versions().update({ id: fork.versionId }, { status: 'draft' });
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('› a view before any run: not run, every check pending or not applicable, and the cost shown first', async () => {
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    const view = await service.view(S1_TEACHER, fork.versionId);
    expect(view).toMatchObject({ versionId: fork.versionId, status: 'not-run', current: false, contentDigest: null, startedAt: null, finishedAt: null });
    expect(view.checks.map((check) => check.id)).toEqual([...DEEP_VALIDATION_CHECK_IDS]);
    expect(view.checks.map((check) => [check.id, check.status])).toEqual(
      expectedOf(base).clean.map(([id, s]) => [id, s === 'passed' ? 'pending' : s]),
    );
    expect(view.costWarning.sentence).toBe(deepValidationCostWarning(expectedOf(base).microVMs));
    expect(view.costWarning.sentence).not.toMatch(/\$|dollar|cost of|price|money|USD|SGD/i);
  });

  /* ------------------------- further edge cases ------------------------- */

  const tokenOf = async (versionId: string) =>
    ((await versions().findOneByOrFail({ id: versionId })).validation as unknown as { deepRun?: Record<string, unknown> } | null)
      ?.deepRun;
  const writeToken = async (versionId: string, token: Record<string, unknown>) => {
    const row = await versions().findOneByOrFail({ id: versionId });
    await versions().update({ id: versionId }, { validation: { ...(row.validation ?? {}), deepRun: token } as never });
  };
  const shelfDraft = async (title: string) => {
    const importer = new ProjectImporterService(world.content, world.dataSource);
    const draft = await importer.importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: S1_TEACHER.id, title });
    return { versionId: draft.versionId, snapshot: await snapshotOf(draft.versionId) };
  };

  it("› under the mutant check an uploaded Testing phase fails closed, and the reference project's own Testing phase does not", async () => {
    const shelf = await shelfDraft('Shelf cut three');
    const stub = new StubSandbox(judgeFor(shelf.snapshot));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    service.scope = { mutants: false, smoke: true };
    const view = await run(service, shelf.versionId);
    const mutants = checkOf(view, 'mutants-killed');
    expect({ status: mutants.status, phaseKey: mutants.phaseKey }).toEqual({ status: 'failed', phaseKey: 'testing' });
    expect(mutants.sentence).toMatch(/written task/);
    expect(view.status).toBe('failed');
    expect(hasCurrentDeepReceipt(await versions().findOneByOrFail({ id: shelf.versionId }))).toBe(false);
    // the cut boots no reference-suite or mutant job
    expect(stub.calls.filter((call) => (call.job as { gradedFiles?: unknown }).gradedFiles)).toHaveLength(0);

    const copy = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    copy.scope = { mutants: false, smoke: true };
    const kept = await run(copy, fork.versionId);
    expect(checkOf(kept, 'mutants-killed').status).toBe('not-applicable');
    expect(kept.status).toBe('passed');
  });

  it("› under the drill check an uploaded Deployment smoke fails closed, and the reference project's own Deployment does not", async () => {
    const shelf = await shelfDraft('Shelf cut five');
    const stub = new StubSandbox(judgeFor(shelf.snapshot));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    service.scope = { mutants: true, smoke: false };
    const view = await run(service, shelf.versionId);
    const smokeCheck = checkOf(view, 'smoke-passes');
    expect({ status: smokeCheck.status, phaseKey: smokeCheck.phaseKey }).toEqual({ status: 'failed', phaseKey: 'deployment' });
    expect(smokeCheck.sentence).toMatch(/the runbook record is the Deployment's written part/);
    expect(view.status).toBe('failed');
    expect(stub.calls.filter((call) => call.job.mode === 'smoke')).toHaveLength(0);

    const copy = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    copy.scope = { mutants: true, smoke: false };
    const kept = await run(copy, fork.versionId);
    expect(checkOf(kept, 'smoke-passes').status).toBe('not-applicable');
    expect(kept.status).toBe('passed');
  });

  it("› under the mutant check a copy whose Testing bytes moved fails closed; it is not the reference's Testing phase any more", async () => {
    const copy = await copyTaskTrackr(world, 'deep-cut-three-edited');
    const testing = phaseOf(await draftSnapshot(world, copy), 'testing');
    const minTests = (testing.phase.checks as TestsChecks).minTests;
    const work = testing.tasks.find((task) => !isQuizTask(task))!;
    await world.service.updateTask(S1_TEACHER, copy.projectId, copy.versionId, 'testing', work.taskKey, {
      minTests: minTests === 1 ? 2 : minTests - 1,
    } as never);
    const snapshot = await snapshotOf(copy.versionId);
    const stub = new StubSandbox(judgeFor(snapshot));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    service.scope = { mutants: false, smoke: true };
    const view = await run(service, copy.versionId);
    const mutants = checkOf(view, 'mutants-killed');
    expect({ status: mutants.status, phaseKey: mutants.phaseKey }).toEqual({ status: 'failed', phaseKey: 'testing' });
    expect(view.status).toBe('failed');
    expect(hasCurrentDeepReceipt(await versions().findOneByOrFail({ id: copy.versionId }))).toBe(false);
    expect(stub.calls.filter((call) => (call.job as { gradedFiles?: unknown }).gradedFiles)).toHaveLength(0);
  });

  it('› a running token whose process died stops holding the draft after one job’s bound, and a beating run holds it however old', async () => {
    const digest = executableContentDigest(await versions().findOneByOrFail({ id: fork.versionId }));
    const microVMs = expectedOf(base).microVMs;
    const dead = new Date(Date.now() - deepRunHeartbeatBoundMs() - 61_000).toISOString();
    await writeToken(fork.versionId, {
      token: 'dead-run', userId: S1_TEACHER.id, state: 'running', requestedAt: dead, startedAt: dead, beatAt: dead, contentDigest: digest, microVMs,
    });
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    expect(view.status).toBe('passed');
    expect(stub.calls).toHaveLength(microVMs);

    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeToken(fork.versionId, {
      token: 'slow-run', userId: S1_TEACHER.id, state: 'running', requestedAt: longAgo, startedAt: longAgo,
      beatAt: new Date().toISOString(), contentDigest: digest, microVMs,
    });
    const held = new StubSandbox(judgeFor(base));
    const other = new DeepValidationService(world.dataSource, held as never, world.content);
    expect((await other.start(S1_TEACHER, fork.versionId)).status).toBe('running');
    // its pump stays blocked behind the beating run; stop it rather than wait it out
    await other.beforeApplicationShutdown();
    expect(held.calls).toHaveLength(0);
  });

  it('› a running deep validation beats before every job', async () => {
    const stub = new StubSandbox(judgeFor(base));
    stub.hold();
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    await service.start(S1_TEACHER, fork.versionId);
    await waitFor('the first job', () => stub.calls.length === 1);
    const token = await tokenOf(fork.versionId);
    expect(token?.state).toBe('running');
    expect(typeof token?.beatAt).toBe('string');
    expect(Date.parse(token?.beatAt as string)).toBeGreaterThanOrEqual(Date.parse(token?.startedAt as string));
    stub.open();
    await service.idle();
    expect((await service.view(S1_TEACHER, fork.versionId)).status).toBe('passed');
  });

  it('› a queued run a gone process left is picked up when its teacher next reads the view', async () => {
    const digest = executableContentDigest(await versions().findOneByOrFail({ id: fork.versionId }));
    await writeToken(fork.versionId, {
      token: 'left-queued', userId: S1_TEACHER.id, state: 'queued', requestedAt: new Date().toISOString(), startedAt: null,
      contentDigest: digest, microVMs: expectedOf(base).microVMs,
    });
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    expect(['queued', 'running']).toContain((await service.view(S1_TEACHER, fork.versionId)).status);
    await service.idle();
    expect((await service.view(S1_TEACHER, fork.versionId)).status).toBe('passed');
    expect(stub.calls).toHaveLength(expectedOf(base).microVMs);
  });

  it('› a draft published mid-run boots nothing more and is left untouched', async () => {
    const stub = new StubSandbox(judgeFor(base));
    stub.hold();
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    await service.start(S1_TEACHER, fork.versionId);
    await waitFor('the first job', () => stub.calls.length === 1);
    await versions().update({ id: fork.versionId }, { status: 'published' });
    try {
      stub.open();
      await service.idle();
      expect(stub.calls).toHaveLength(1);
      const row = await versions().findOneByOrFail({ id: fork.versionId });
      expect((row.validation as unknown as { deep?: unknown }).deep).toBeUndefined();
    } finally {
      await versions().update({ id: fork.versionId }, { status: 'draft' });
    }
  });

  it('› a press after an executable edit is never swallowed: a queued run takes the new bytes, a running one refuses by sentence', async () => {
    const second = await copyTaskTrackr(world, 'deep-owner-press');
    const stub = new StubSandbox(judgeFor(base));
    stub.hold();
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    await service.start(S1_TEACHER, fork.versionId);
    await waitFor('the first job', () => stub.calls.length === 1);
    const queued = await service.start(S1_TEACHER, second.versionId);
    expect(queued.status).toBe('queued');

    // an executable edit no cut touches: one more hidden file on Implementation's first run
    const edited = clone(await snapshotOf(second.versionId));
    const implementation = edited.content.phases.find((p) => p.key === 'implementation')!;
    const run0 = (implementation.checks as CodeChecks).runs[0];
    const [at] = Object.keys(run0.hiddenTestFiles);
    run0.hiddenTestFiles[`${at}.extra`] = '# one more hidden file\n';
    await setSnapshot(second.versionId, edited);
    const now = executableContentDigest(await versions().findOneByOrFail({ id: second.versionId }));
    expect(now).not.toBe(queued.contentDigest);
    const again = await service.start(S1_TEACHER, second.versionId);
    expect({ status: again.status, contentDigest: again.contentDigest }).toEqual({ status: 'queued', contentDigest: now });

    const moved = clone(base);
    const testingA = moved.content.phases.find((p) => p.key === 'testing')!;
    const runA = (testingA.checks as TestsChecks).runs[0];
    const [atA] = Object.keys(runA.referenceTestFiles);
    runA.referenceTestFiles[atA] = `${runA.referenceTestFiles[atA]}\n`;
    await setSnapshot(fork.versionId, moved);
    const refused = await caught(service.start(S1_TEACHER, fork.versionId));
    expect(status(refused)).toBe(409);
    expect((refused as HttpException).message).toMatch(/earlier copy/);

    stub.open();
    await service.idle();
    const after = await service.view(S1_TEACHER, second.versionId);
    expect({ status: after.status, current: after.current }).toEqual({ status: 'passed', current: true });
  });

  it('› an older run finishing last never replaces a current receipt', async () => {
    const stub = new StubSandbox(judgeFor(base));
    stub.hold();
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    await service.start(S1_TEACHER, fork.versionId);
    await waitFor('the first job', () => stub.calls.length === 1);
    const moved = clone(base);
    const testing = moved.content.phases.find((p) => p.key === 'testing')!;
    const run0 = (testing.checks as TestsChecks).runs[0];
    const [at] = Object.keys(run0.referenceTestFiles);
    run0.referenceTestFiles[at] = `${run0.referenceTestFiles[at]}\n`;
    await setSnapshot(fork.versionId, moved);
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    const newer = {
      contentDigest: executableContentDigest(row),
      status: 'passed',
      checks: [],
      microVMs: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    await versions().update({ id: fork.versionId }, { validation: { ...(row.validation ?? {}), deep: newer } as never });
    stub.open();
    await service.idle();
    const after = await versions().findOneByOrFail({ id: fork.versionId });
    expect((after.validation as unknown as { deep: { contentDigest: string } }).deep.contentDigest).toBe(newer.contentDigest);
    expect(hasCurrentDeepReceipt(after)).toBe(true);
    expect(await tokenOf(fork.versionId)).toBeUndefined();
  });

  it('› a run under way when a written phase leaves the draft leaves a receipt that reads not current, and a press meanwhile names the earlier copy', async () => {
    // Removing Requirements moves no executable byte, so the digest alone would call the run's receipt current;
    // the phase keys the run checked, stamped on its token and its receipt, say it was made on another phase set.
    const draft = await copyTaskTrackr(world, 'deep-phase-set');
    const stub = new StubSandbox(judgeFor(await snapshotOf(draft.versionId)));
    stub.hold();
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    await service.start(S1_TEACHER, draft.versionId);
    await waitFor('the first job', () => stub.calls.length === 1);
    const six = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
    expect((await tokenOf(draft.versionId))?.phaseKeys).toEqual(six);
    const digestBefore = executableContentDigest(await versions().findOneByOrFail({ id: draft.versionId }));

    await world.service.removePhase(S1_TEACHER, draft.projectId, draft.versionId, 'requirements');

    expect(executableContentDigest(await versions().findOneByOrFail({ id: draft.versionId }))).toBe(digestBefore);
    const refused = await caught(service.start(S1_TEACHER, draft.versionId));
    expect(status(refused)).toBe(409);
    expect((refused as HttpException).message).toMatch(/earlier copy/);
    stub.open();
    await service.idle();
    const row = await versions().findOneByOrFail({ id: draft.versionId });
    const deep = (row.validation as unknown as { deep?: { status: string; contentDigest: string; phaseKeys?: string[] } }).deep;
    expect(deep).toMatchObject({ status: 'passed', contentDigest: digestBefore, phaseKeys: six });
    expect(hasCurrentDeepReceipt(row)).toBe(false);
    expect((await service.view(S1_TEACHER, draft.versionId)).current).toBe(false);

    // a run on the phases the draft holds now is current
    const again = await run(service, draft.versionId);
    expect({ status: again.status, current: again.current }).toEqual({ status: 'passed', current: true });
    const now = (await versions().findOneByOrFail({ id: draft.versionId })).validation as unknown as { deep: { phaseKeys?: string[] } };
    expect(now.deep.phaseKeys).toEqual(six.slice(1));
  });

  it('GUARD › a receipt stored before the phase keys were stamped reads as it did: current when its digest is', async () => {
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    expect((await run(service, fork.versionId)).current).toBe(true);
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    const { phaseKeys: _keys, ...older } = (row.validation as unknown as { deep: Record<string, unknown> }).deep;
    await versions().update({ id: fork.versionId }, { validation: { ...(row.validation ?? {}), deep: older } as never });
    const after = await versions().findOneByOrFail({ id: fork.versionId });
    expect(hasCurrentDeepReceipt(after)).toBe(true);
    expect((await service.view(S1_TEACHER, fork.versionId)).current).toBe(true);
  });

  it.each(['timeout', 'memory'] as const)('› a starter whose hidden run ends on the learner %s limit is caught, as the grader fails it', async (exitKind) => {
    const judge = judgeFor(base);
    const stub = new StubSandbox((job) => {
      const result = judge(job);
      if (job.mode === 'tests' && !job.gradedFiles && !result.ok) {
        return { ok: false, exitKind, stdout: '', stderr: '', durationMs: 1 };
      }
      return result;
    });
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    const view = await run(service, fork.versionId);
    expect(checkOf(view, 'starter-fails-hidden').status).toBe('passed');
    expect(view.status).toBe('passed');
  });

  /* ----------------- the platform-wide in-flight cap of 2 ----------------- */

  const THIRD_TEACHER = { id: 'teacher-deep-third', role: 'INSTRUCTOR' as const, cohort: 'default' };
  const FOURTH_TEACHER = { id: 'teacher-deep-fourth', role: 'INSTRUCTOR' as const, cohort: 'default' };
  const copyFor = async (teacher: { id: string; role: 'INSTRUCTOR'; cohort: string }, slug: string): Promise<string> =>
    (
      await world.service.createProject(teacher as never, {
        title: `Copy ${slug}`,
        slug,
        fromVersionId: world.seedVersionId,
      })
    ).draftVersionId;
  /** Each draft's token state as the rows hold it now ('none' once its run has left a receipt). */
  const statesOf = async (versionIds: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const id of versionIds) out.push(String((await tokenOf(id))?.state ?? 'none'));
    return out;
  };
  /** Every gated sandbox and its service a case opened: a failing case never leaves a held run behind for the next. */
  const opened: { stub: GateSandbox; service: DeepValidationService }[] = [];
  const gated = (stub: GateSandbox): DeepValidationService => {
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    service.retryMs = 25;
    opened.push({ stub, service });
    return service;
  };
  afterEach(async () => {
    for (const one of opened.splice(0)) {
      one.stub.open();
      await one.service.beforeApplicationShutdown();
    }
  });
  /** Live running tokens platform-wide, counted from the rows. */
  const runningRows = async (): Promise<number> =>
    (await versions().find({ where: { status: 'draft' } })).filter(
      (row) => (row.validation as unknown as { deepRun?: { state?: string } } | null)?.deepRun?.state === 'running',
    ).length;

  it("› a third teacher's start stays queued while two run (platform-wide in-flight cap of 2)", async () => {
    const other = await copyFor(OTHER_TEACHER, 'deep-cap-other');
    const third = await copyFor(THIRD_TEACHER, 'deep-cap-third');
    const stub = new GateSandbox(judgeFor(base));
    stub.hold(fork.versionId, other, third);
    const service = gated(stub);
    expect(DEEP_VALIDATION_PLATFORM_IN_FLIGHT).toBe(2);

    await service.start(S1_TEACHER, fork.versionId);
    await service.start(OTHER_TEACHER, other);
    await waitFor('two runs in the sandbox', () => spanOf(stub.calls, fork.versionId).first >= 0 && spanOf(stub.calls, other).first >= 0);
    const waiting = await service.start(THIRD_TEACHER, third);
    // the existing token and sentence: queued, every check waiting its turn
    expect(waiting.status).toBe('queued');
    for (const check of waiting.checks.filter((one) => one.status !== 'not-applicable')) {
      expect({ status: check.status, sentence: check.sentence }).toEqual({
        status: 'pending',
        sentence: 'This check is waiting for its turn in the sandbox.',
      });
    }
    // several retry rounds later it is still queued, and nothing of it booted
    await pause(200);
    expect((await service.view(THIRD_TEACHER, third)).status).toBe('queued');
    expect(spanOf(stub.calls, third).first).toBe(-1);
    expect(await statesOf([fork.versionId, other, third])).toEqual(['running', 'running', 'queued']);
    expect(await runningRows()).toBe(2);

    stub.open();
    await service.idle();
    for (const [teacher, id] of [[S1_TEACHER, fork.versionId], [OTHER_TEACHER, other], [THIRD_TEACHER, third]] as const) {
      expect((await service.view(teacher, id)).status).toBe('passed');
    }
    expect(mostAtOnce(stub.calls)).toBe(2);
    expect(stub.calls).toHaveLength(expectedOf(base).microVMs * 3);
  });

  it('› when one finishes, the oldest queued run starts, and the next waits for the next slot (order)', async () => {
    const other = await copyFor(OTHER_TEACHER, 'deep-order-other');
    const third = await copyFor(THIRD_TEACHER, 'deep-order-third');
    const fourth = await copyFor(FOURTH_TEACHER, 'deep-order-fourth');
    const stub = new GateSandbox(judgeFor(base));
    stub.hold(fork.versionId, other);
    const service = gated(stub);

    await service.start(S1_TEACHER, fork.versionId);
    await service.start(OTHER_TEACHER, other);
    await waitFor('two runs in the sandbox', () => spanOf(stub.calls, fork.versionId).first >= 0 && spanOf(stub.calls, other).first >= 0);
    expect((await service.start(THIRD_TEACHER, third)).status).toBe('queued');
    await pause(5);
    expect((await service.start(FOURTH_TEACHER, fourth)).status).toBe('queued');

    // the first run finishes: the third teacher's (queued first) takes its slot, the fourth's waits
    stub.open(fork.versionId);
    await waitFor('the third teacher to pass', async () => (await service.view(THIRD_TEACHER, third)).status === 'passed');
    await waitFor('the fourth teacher to pass', async () => (await service.view(FOURTH_TEACHER, fourth)).status === 'passed');
    expect((await service.view(OTHER_TEACHER, other)).status).toBe('running');
    const t = spanOf(stub.calls, third);
    const f = spanOf(stub.calls, fourth);
    expect(t.first).toBeGreaterThan(spanOf(stub.calls, fork.versionId).last);
    // the fourth started only once the third had finished: the other teacher still held the second slot
    expect(f.first).toBeGreaterThan(t.last);

    stub.open();
    await service.idle();
    expect((await service.view(OTHER_TEACHER, other)).status).toBe('passed');
    expect(mostAtOnce(stub.calls)).toBe(2);
  });

  it('› the cap counts across teachers, and one run per teacher still holds', async () => {
    const second = (await copyTaskTrackr(world, 'deep-cap-mine-two')).versionId;
    const third = await copyFor(THIRD_TEACHER, 'deep-cap-across-third');
    const fourth = await copyFor(FOURTH_TEACHER, 'deep-cap-across-fourth');
    const stub = new GateSandbox(judgeFor(base));
    stub.hold(fork.versionId, second, third, fourth);
    const service = gated(stub);

    await service.start(S1_TEACHER, fork.versionId);
    await waitFor('the first run in the sandbox', () => spanOf(stub.calls, fork.versionId).first >= 0);
    // a slot is free, and still the same teacher's second draft waits behind the first
    expect((await service.start(S1_TEACHER, second)).status).toBe('queued');
    await pause(5);
    await service.start(THIRD_TEACHER, third);
    await waitFor('the third teacher in the sandbox', () => spanOf(stub.calls, third).first >= 0);
    // two running across two teachers: the fourth teacher waits, though they run nothing else
    expect((await service.start(FOURTH_TEACHER, fourth)).status).toBe('queued');
    await pause(200);
    expect(await statesOf([fork.versionId, second, third, fourth])).toEqual(['running', 'queued', 'running', 'queued']);
    expect(await runningRows()).toBe(2);

    // the teacher's first run finishes: their second draft, queued before the fourth teacher's, takes the slot
    stub.open(fork.versionId);
    await waitFor('the same teacher\'s second run in the sandbox', () => spanOf(stub.calls, second).first >= 0);
    await pause(100);
    expect(await statesOf([second, third, fourth])).toEqual(['running', 'running', 'queued']);
    expect(spanOf(stub.calls, fourth).first).toBe(-1);

    stub.open();
    await service.idle();
    for (const [teacher, id] of [[S1_TEACHER, fork.versionId], [S1_TEACHER, second], [THIRD_TEACHER, third], [FOURTH_TEACHER, fourth]] as const) {
      expect((await service.view(teacher, id)).status).toBe('passed');
    }
    expect(mostAtOnce(stub.calls)).toBe(2);
    // the teacher's two runs never overlapped
    expect(spanOf(stub.calls, second).first).toBeGreaterThan(spanOf(stub.calls, fork.versionId).last);
  });

  /* --------------- 'reference' by the recorded exec anchor --------------- */

  it("GUARD › deep validation's 'reference' agrees with the executable editor's isReferenceApplicationPhase and the reviewer scope's taskScopeOf on every executable phase", async () => {
    const answers = (snapshot: CompiledSnapshot) =>
      executable(snapshot).map((phase) => {
        const tasks = snapshot.phases.find((one) => one.key === phase.key)?.tasks ?? [];
        const work = tasks.filter((task) => !isQuizTask(task));
        return {
          phase: phase.key,
          val: isReferenceExecutablePhase(phase, tasks),
          spine: isReferenceApplicationPhase(phase),
          n5: work.length === 1 && taskScopeOf(phase, work[0], tasks).kind === 'reference',
        };
      });
    const all = (snapshot: CompiledSnapshot, value: boolean, except: Record<string, boolean> = {}) =>
      executable(snapshot).map((phase) => {
        const expected = except[phase.key] ?? value;
        return { phase: phase.key, val: expected, spine: expected, n5: expected };
      });
    const edited = async (
      slug: string,
      body: Record<string, unknown>,
      key: 'implementation' | 'testing' = 'implementation',
    ): Promise<CompiledSnapshot> => {
      const copy = await copyTaskTrackr(world, slug);
      const { tasks } = phaseOf(await draftSnapshot(world, copy), key);
      const work = tasks.find((task) => !isQuizTask(task))!;
      await world.service.updateTask(S1_TEACHER, copy.projectId, copy.versionId, key, work.taskKey, body as never);
      return draftSnapshot(world, copy);
    };

    const tasktrackr = compilePack(world.content.getProject('tasktrackr'));
    expect(tasktrackr.version).toBe('6.0.0');
    expect(answers(tasktrackr)).toEqual(all(tasktrackr, true));
    // an untouched teacher's copy
    expect(answers(base)).toEqual(all(base, true));
    // a title-only edit is not an edit (titleEdited): still the reference
    const titled = await edited('deep-anchor-title', { title: 'Build the overdue view, my way' });
    expect(answers(titled)).toEqual(all(titled, true));
    // a brief or objectives edit is the teacher's own task
    const briefed = await edited('deep-anchor-brief', { brief: 'Build the list view the way this class agreed on Monday.' });
    expect(answers(briefed)).toEqual(all(briefed, true, { implementation: false }));
    const objectived = await edited('deep-anchor-objectives', { objectives: ['Agree the view with the class first.'] });
    expect(answers(objectived)).toEqual(all(objectived, true, { implementation: false }));
    // a copy whose executable bytes moved is the teacher's own phase
    // for all three (the case a cut's fail-closed branch protects). The one
    // byte edit a teacher's route allows: a Testing task's smallest suite.
    const testingChecks = phaseOf(base, 'testing').phase.checks as TestsChecks;
    const suited = await edited('deep-anchor-min-tests', { minTests: testingChecks.minTests === 1 ? 2 : testingChecks.minTests - 1 }, 'testing');
    expect((phaseOf(suited, 'testing').phase.checks as TestsChecks).minTests).not.toBe(testingChecks.minTests);
    expect(answers(suited)).toEqual(all(suited, true, { testing: false }));
    // and any byte the routes cannot reach (a hidden test, a mutant, the smoke
    // run's expected output), moved in the snapshot itself
    const moved = clone(base);
    const at = (key: string) => moved.content.phases.find((phase) => phase.key === key)!;
    const firstRun = (at('implementation').checks as CodeChecks).runs[0];
    const hiddenPath = Object.keys(firstRun.hiddenTestFiles)[0];
    firstRun.hiddenTestFiles[hiddenPath] = `${firstRun.hiddenTestFiles[hiddenPath]}\n`;
    const mutant = (at('testing').checks as TestsChecks).mutants[0];
    const mutantPath = Object.keys(mutant.files)[0];
    mutant.files[mutantPath] = `${mutant.files[mutantPath]}\n`;
    const deployment = at('deployment').checks as ConfigChecks;
    deployment.expectInOutput = `${deployment.expectInOutput} `;
    expect(answers(moved)).toEqual(all(moved, true, { implementation: false, testing: false, deployment: false }));
    // the shelf upload: nothing in it is the reference's
    const shelf = await shelfDraft('Shelf anchor guard');
    expect(answers(shelf.snapshot)).toEqual(all(shelf.snapshot, false));
  });

  /* --------------- ProjectVersionValidation.deep on the entity --------------- */

  it("GUARD › the stored receipt type-checks as the entity's validation.deep", async () => {
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    expect((await run(service, fork.versionId)).status).toBe('passed');
    const row = await versions().findOneByOrFail({ id: fork.versionId });
    const validation: ProjectVersionValidation | null = row.validation;
    const deep: DeepValidationReceipt | undefined = validation?.deep;
    // and the other way: a shared receipt is assignable to the entity's field
    const asEntity: ProjectVersionValidation['deep'] = deep;
    expect(asEntity?.status).toBe('passed');
    expect(asEntity?.contentDigest).toBe(executableContentDigest(row));
  });

  /** The reference-suite and mutant jobs (graded files ride beside the suite), in the sandbox's order. */
  const suiteJobs = (calls: { job: SandboxJob }[]): SandboxTestJob[] =>
    calls.map((call) => call.job).filter((job): job is SandboxTestJob => job.mode === 'tests' && Boolean((job as SandboxTestJob).gradedFiles));

  /* ---------- the reference suite collects its own file list ---------- */

  itMutants('› a new reference test outside run.testPaths (tests/test_more.py) is in the job list of the reference-suite run and of every mutant run', async () => {
    const shelf = await shelfDraft('Shelf reference test');
    const doctored = clone(shelf.snapshot);
    const checks = phaseOf(doctored, 'testing').phase.checks as TestsChecks;
    const python = checks.runs.find((one) => one.language === 'python')!;
    const at = 'tests/test_more.py';
    const bytes = 'def test_more():\n    assert True\n';
    // the shape draft.spec pins ('a new reference test written to a tests
    // phase lands in referenceTestFiles and never in run.testPaths')
    checks.referenceTestFiles[at] = bytes;
    python.referenceTestFiles[at] = bytes;
    expect(python.testPaths).not.toContain(at);
    expect(python.testPaths.some((entry) => at.startsWith(`${entry.replace(/\/+$/, '')}/`))).toBe(false);
    await setSnapshot(shelf.versionId, doctored);
    const stub = new StubSandbox(judgeFor(doctored));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    expect((await run(service, shelf.versionId)).status).toBe('passed');
    const mounted = suiteJobs(stub.calls).filter((job) => job.files[at] === bytes);
    const own = checks.mutants.filter((m) => m.run === python.id || (python === checks.runs[0] && !checks.runs.some((r) => r.id === m.run)));
    // the reference-suite run and one run per mutant of the python run: mounted, and collected
    expect(mounted).toHaveLength(1 + own.length);
    for (const job of mounted) expect(job.testPaths).toEqual([...python.testPaths, at]);
  });

  itMutants("› a reference helper and a test in the other language, mounted in every run, are collected by no run that cannot run them", async () => {
    const shelf = await shelfDraft('Shelf helper and other language');
    const doctored = clone(shelf.snapshot);
    const checks = phaseOf(doctored, 'testing').phase.checks as TestsChecks;
    const python = checks.runs.find((one) => one.language === 'python')!;
    const typescript = checks.runs.find((one) => one.language === 'typescript')!;
    // the loader's shape (content.service 'plus any helper the reference
    // directory ships that lands on no learner test path at all'): each file
    // lands in EVERY run's referenceTestFiles
    const extra: Record<string, string> = {
      'tests/helpers.py': 'def shelf_row():\n    return {}\n',
      'tests/test_extra.py': 'def test_extra():\n    assert True\n',
      'web/src/lib/fixtures.ts': 'export const shelfRow = {};\n',
      'web/src/lib/extra.test.ts': "import { it, expect } from 'vitest';\nit('extra', () => expect(1).toBe(1));\n",
    };
    for (const [at, bytes] of Object.entries(extra)) {
      checks.referenceTestFiles[at] = bytes;
      for (const one of checks.runs) one.referenceTestFiles[at] = bytes;
    }
    for (const one of [python, typescript]) {
      for (const at of Object.keys(extra)) expect(one.testPaths.some((entry) => at === entry || at.startsWith(`${entry.replace(/\/+$/, '')}/`))).toBe(false);
    }
    await setSnapshot(shelf.versionId, doctored);
    const stub = new StubSandbox(judgeFor(doctored));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    expect((await run(service, shelf.versionId)).status).toBe('passed');
    const jobs = suiteJobs(stub.calls);
    const ofLanguage = (language: string) => jobs.filter((job) => job.language === language);
    expect(ofLanguage('python').length).toBeGreaterThan(0);
    expect(ofLanguage('typescript').length).toBeGreaterThan(0);
    // each run collects its own suite plus the hidden test of its own
    // language; a helper and the other language's test stay mounted only
    for (const job of ofLanguage('python')) {
      expect(job.files['tests/helpers.py']).toBe(extra['tests/helpers.py']);
      expect(job.testPaths).toEqual([...python.testPaths, 'tests/test_extra.py']);
    }
    for (const job of ofLanguage('typescript')) {
      expect(job.files['web/src/lib/fixtures.ts']).toBe(extra['web/src/lib/fixtures.ts']);
      expect(job.testPaths).toEqual([...typescript.testPaths, 'web/src/lib/extra.test.ts']);
    }
    for (const job of jobs) expect(job.testPaths.some((entry) => entry.endsWith('helpers.py') || entry.endsWith('fixtures.ts'))).toBe(false);
  });

  itMutants("GUARD › TaskTrackr's reference-suite and mutant jobs carry the same testPaths, in the same order", async () => {
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    expect((await run(service, fork.versionId)).status).toBe('passed');
    const checks = phaseOf(base, 'testing').phase.checks as TestsChecks;
    const subjectOf = (job: SandboxTestJob): string => {
      for (const one of checks.runs) {
        if (sameFiles(job.gradedFiles!, one.implFiles)) return 'reference';
        const mutant = checks.mutants.find((m) => sameFiles(job.gradedFiles!, { ...one.implFiles, ...m.files }));
        if (mutant) return mutant.name;
      }
      return 'unknown';
    };
    // net #3's testing share: 10 microVMs, each run's reference suite then that run's mutants
    expect(suiteJobs(stub.calls).map((job) => [job.testPaths, subjectOf(job)])).toEqual([
      [['tests'], 'reference'],
      [['tests'], 'complete_does_not_persist'],
      [['tests'], 'complete_unknown_returns_200'],
      [['tests'], 'filter_keyword_case_sensitive'],
      [['tests'], 'overdue_includes_done'],
      [['tests'], 'overdue_includes_due_today'],
      [['tests'], 'priority_order_reversed'],
      [['web/src'], 'reference'],
      [['web/src'], 'badge_ignores_completion'],
      [['web/src'], 'filters_drop_the_search'],
    ]);
  });

  /* ------ under a cut, 'reference' only when deep validation and publish both say so ------ */

  /**
   * A copy whose only change is a file the screen-copy overlay owns, inside
   * one of the maps the exec anchor leaves the overlay's paths out of: tests
   * `implFiles`/`supportFiles` (flat and per run) or config `smokeImplFiles`.
   * The anchor still reads the reference's task; publish's key
   * (`executableDigestKey`, the whole checks) does not. `shared/contract/screens.json`
   * is the overlay's only while the phase serves it locked, so the copy's
   * phase serves it locked, as a phase that lays the accepted copy over it does.
   */
  const overlaidEdit = (key: 'testing' | 'deployment', at: string): CompiledSnapshot => {
    const moved = clone(base);
    const phase = moved.content.phases.find((one) => one.key === key)!;
    if (!phase.files.some((file) => file.path === at)) {
      phase.files.push({ path: at, content: '{"screens": []}\n', editable: false, language: 'json' } as never);
    }
    const bytes = '{"screens": [], "moved": "by a sealed write"}\n';
    if (key === 'testing') {
      const checks = phase.checks as TestsChecks;
      checks.implFiles[at] = bytes;
      checks.supportFiles[at] = bytes;
      for (const one of checks.runs) {
        one.implFiles[at] = bytes;
        one.supportFiles[at] = bytes;
      }
    } else {
      const checks = phase.checks as ConfigChecks;
      checks.smokeImplFiles = { ...(checks.smokeImplFiles ?? {}), [at]: bytes };
    }
    return moved;
  };
  const readersOf = (snapshot: CompiledSnapshot, key: string) => {
    const phase = snapshot.content.phases.find((one) => one.key === key)!;
    const tasks = snapshot.phases.find((one) => one.key === key)?.tasks ?? [];
    const work = tasks.filter((task) => !isQuizTask(task));
    return {
      val: isReferenceExecutablePhase(phase, tasks),
      spine: isReferenceApplicationPhase(phase),
      n5: work.length === 1 && taskScopeOf(phase, work[0], tasks).kind === 'reference',
    };
  };

  it("› a copy's Testing phase whose only change is shared/contract/screens.json in implFiles/supportFiles is not reference for deep validation under the mutant check", async () => {
    for (const at of [SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH]) {
      const moved = overlaidEdit('testing', at);
      // the anchor strips the overlay's paths; publish's key keeps them: deep validation sides with publish
      expect({ at, ...readersOf(moved, 'testing') }).toEqual({ at, val: false, spine: false, n5: true });
      await setSnapshot(fork.versionId, moved);
      await versions().update({ id: fork.versionId }, { validation: null });
      const stub = new StubSandbox(judgeFor(moved));
      const service = new DeepValidationService(world.dataSource, stub as never, world.content);
      service.scope = { mutants: false, smoke: true };
      const view = await run(service, fork.versionId);
      const mutants = checkOf(view, 'mutants-killed');
      expect({ at, status: mutants.status, phaseKey: mutants.phaseKey }).toEqual({ at, status: 'failed', phaseKey: 'testing' });
      expect(view.status).toBe('failed');
      expect(hasCurrentDeepReceipt(await versions().findOneByOrFail({ id: fork.versionId }))).toBe(false);
      expect(suiteJobs(stub.calls)).toHaveLength(0);
    }
  });

  it("› a copy's Deployment phase whose only change is shared/contract/screens.json in smokeImplFiles is not reference for deep validation under the drill check", async () => {
    for (const at of [SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH]) {
      const moved = overlaidEdit('deployment', at);
      expect({ at, ...readersOf(moved, 'deployment') }).toEqual({ at, val: false, spine: false, n5: true });
      await setSnapshot(fork.versionId, moved);
      await versions().update({ id: fork.versionId }, { validation: null });
      const stub = new StubSandbox(judgeFor(moved));
      const service = new DeepValidationService(world.dataSource, stub as never, world.content);
      service.scope = { mutants: true, smoke: false };
      const view = await run(service, fork.versionId);
      const smokeCheck = checkOf(view, 'smoke-passes');
      expect({ at, status: smokeCheck.status, phaseKey: smokeCheck.phaseKey }).toEqual({ at, status: 'failed', phaseKey: 'deployment' });
      expect(view.status).toBe('failed');
      expect(stub.calls.filter((call) => call.job.mode === 'smoke')).toHaveLength(0);
    }
  });

  it("GUARD › under both cuts the reference project's own Testing and Deployment still read not applicable, and nothing else moved", async () => {
    // TaskTrackr itself and an untouched copy: all three readers say reference
    const tasktrackr = compilePack(world.content.getProject('tasktrackr'));
    for (const snapshot of [tasktrackr, base]) {
      for (const key of ['implementation', 'testing', 'deployment', 'maintenance']) {
        expect({ key, ...readersOf(snapshot, key) }).toEqual({ key, val: true, spine: true, n5: true });
      }
    }
    const service = new DeepValidationService(world.dataSource, new StubSandbox(judgeFor(base)) as never, world.content);
    service.scope = { mutants: false, smoke: false };
    const view = await run(service, fork.versionId);
    expect([checkOf(view, 'mutants-killed').status, checkOf(view, 'smoke-passes').status]).toEqual(['not-applicable', 'not-applicable']);
    expect(view.status).toBe('passed');
  });

  /* ------ a queued wait the platform cap holds never lapses while its pump lives ------ */

  /** Only the clock moves: every timer stays real, so the pumps' retry rounds and the database keep running. */
  const ONLY_THE_CLOCK = {
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ] as const,
  };

  /** `waitFor` by rounds, not by the clock: the clock is the spec's while it is faked. */
  const waitRounds = async (what: string, test: () => boolean | Promise<boolean>, rounds = 500): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      if (await test()) return;
      await pause(10);
    }
    throw new Error(`gave up waiting for ${what}`);
  };

  it('› a third teacher queued behind two running for 61 minutes, with its pump alive, is still live and then runs', async () => {
    const other = await copyFor(OTHER_TEACHER, 'deep-wait-other');
    const third = await copyFor(THIRD_TEACHER, 'deep-wait-third');
    const stub = new GateSandbox(judgeFor(base));
    stub.hold(fork.versionId, other);
    const service = gated(stub);
    await service.start(S1_TEACHER, fork.versionId);
    await service.start(OTHER_TEACHER, other);
    await waitFor('two runs in the sandbox', () => spanOf(stub.calls, fork.versionId).first >= 0 && spanOf(stub.calls, other).first >= 0);
    let now = Date.now();
    jest.useFakeTimers({ ...ONLY_THE_CLOCK, doNotFake: [...ONLY_THE_CLOCK.doNotFake], now });
    try {
      expect((await service.start(THIRD_TEACHER, third)).status).toBe('queued');
      // 61 minutes pass. The two runs keep beating, as a long run does between
      // its jobs (a job never outlasts its bound); the third waits on the cap.
      const step = Math.min(5 * 60_000, Math.floor(deepRunHeartbeatBoundMs() / 2));
      for (let passed = 0; passed < 61 * 60_000; ) {
        const by = Math.min(step, 61 * 60_000 - passed);
        passed += by;
        now += by;
        jest.setSystemTime(now);
        for (const id of [fork.versionId, other]) await writeToken(id, { ...(await tokenOf(id)), beatAt: new Date(now).toISOString() });
        await pause(120);
      }
      expect(await statesOf([fork.versionId, other, third])).toEqual(['running', 'running', 'queued']);
      expect((await service.view(THIRD_TEACHER, third)).status).toBe('queued');
      expect(spanOf(stub.calls, third).first).toBe(-1);
      stub.open();
      await service.idle();
      expect((await service.view(THIRD_TEACHER, third)).status).toBe('passed');
      expect(mostAtOnce(stub.calls)).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('GUARD › a queued token whose process died (no beat) still expires, and its view says it lapsed', async () => {
    const digest = executableContentDigest(await versions().findOneByOrFail({ id: fork.versionId }));
    const microVMs = expectedOf(base).microVMs;
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const stub = new StubSandbox(judgeFor(base));
    const service = new DeepValidationService(world.dataSource, stub as never, world.content);
    // no beat, requested 61 minutes ago; and beaten once, 61 minutes ago, by a pump that is gone
    for (const token of [
      { token: 'gone-no-beat', requestedAt: ago(61) },
      { token: 'gone-after-a-beat', requestedAt: ago(130), queuedBeatAt: ago(61) },
    ]) {
      await versions().update({ id: fork.versionId }, { validation: null });
      await writeToken(fork.versionId, { userId: S1_TEACHER.id, state: 'queued', startedAt: null, contentDigest: digest, microVMs, ...token });
      const view = await service.view(S1_TEACHER, fork.versionId);
      await service.idle();
      expect({ token: token.token, status: view.status }).toEqual({ token: token.token, status: 'not-run' });
      for (const check of view.checks.filter((one) => one.status !== 'not-applicable')) {
        expect(check.status).toBe('pending');
        expect(check.sentence).toMatch(/lapsed/);
        expect(check.sentence).toMatch(/Start it again\.$/);
      }
      expect(stub.calls).toHaveLength(0);
    }
    // beaten 59 minutes ago, requested two hours ago: still live, and picked up on the view
    await versions().update({ id: fork.versionId }, { validation: null });
    await writeToken(fork.versionId, {
      token: 'held-a-while', userId: S1_TEACHER.id, state: 'queued', startedAt: null, contentDigest: digest, microVMs,
      requestedAt: ago(120), queuedBeatAt: ago(59),
    });
    expect(['queued', 'running']).toContain((await service.view(S1_TEACHER, fork.versionId)).status);
    await service.idle();
    expect((await service.view(S1_TEACHER, fork.versionId)).status).toBe('passed');
    expect(stub.calls).toHaveLength(microVMs);
  });

  it('› a waiting pump refreshes its queued token’s beat at most once a minute, and never moves its place in line', async () => {
    const other = await copyFor(OTHER_TEACHER, 'deep-beat-other');
    const third = await copyFor(THIRD_TEACHER, 'deep-beat-third');
    const stub = new GateSandbox(judgeFor(base));
    stub.hold(fork.versionId, other);
    const service = gated(stub);
    await service.start(S1_TEACHER, fork.versionId);
    await service.start(OTHER_TEACHER, other);
    await waitFor('two runs in the sandbox', () => spanOf(stub.calls, fork.versionId).first >= 0 && spanOf(stub.calls, other).first >= 0);
    let now = Date.now();
    jest.useFakeTimers({ ...ONLY_THE_CLOCK, doNotFake: [...ONLY_THE_CLOCK.doNotFake], now });
    try {
      await service.start(THIRD_TEACHER, third);
      const queued = await tokenOf(third);
      await pause(150);
      // many retry rounds inside one minute: no write
      expect(await tokenOf(third)).toEqual(queued);
      now += 61_000;
      jest.setSystemTime(now);
      await waitRounds('a beat', async () => (await tokenOf(third))?.queuedBeatAt === new Date(now).toISOString());
      const beaten = await tokenOf(third);
      expect({ ...beaten, queuedBeatAt: undefined }).toEqual({ ...queued, queuedBeatAt: undefined });
      expect(beaten?.requestedAt).toBe(queued?.requestedAt);
    } finally {
      jest.useRealTimers();
      // drain the three runs, so no queued token (beaten 61 s
      // ahead of the real clock) is left in the shared world for a later case
      stub.open();
      await service.idle();
    }
    expect(await statesOf([fork.versionId, other, third])).toEqual(['none', 'none', 'none']);
  });
});

/* ------------- the validation column on PostgreSQL 16 ------------- */

const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rx_val';
const TEACHER = { id: '7b0e3c52-6a1f-4c1e-9d55-2f6c5e0d9a11', role: 'INSTRUCTOR' as const, cohort: 'default' };

describePg('deep validation on PostgreSQL 16: the receipt and the token fit the validation column (U1)', () => {
  let admin: DataSource;
  let one: DataSource;
  let two: DataSource;
  const schema = scratchSchema(PREFIX);
  let snapshot: CompiledSnapshot;
  let content: ContentService;
  const drafts: string[] = [];

  const open = async (): Promise<DataSource> =>
    new DataSource({
      ...postgresOptions(url!, schema, [], ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 4 },
    } as never).initialize();

  const draft = async (slug: string, ownerUserId: string = TEACHER.id): Promise<string> => {
    const project = await one.getRepository(ProjectEntity).save(
      one.getRepository(ProjectEntity).create({
        slug,
        title: `Deep ${slug}`,
        platformOwned: false,
        ownerUserId,
        isDefault: false,
        origin: 'upload',
      } as Partial<ProjectEntity>),
    );
    const version = await one.getRepository(ProjectVersionEntity).save(
      one.getRepository(ProjectVersionEntity).create({
        projectId: project.id,
        version: '0.1.0',
        status: 'draft',
        manifest: { tagline: '', description: '', language: 'python', languages: ['python'] },
        compiled: snapshot,
        validation: { findings: [], tier: 'fast', when: new Date().toISOString() },
      } as Partial<ProjectVersionEntity>),
    );
    return version.id;
  };

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const migrator = await new DataSource({
      ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 2 },
    } as never).initialize();
    await migrator.runMigrations({ transaction: 'all' });
    await migrator.destroy();
    one = await open();
    two = await open();
    content = new ContentService();
    content.loadAll();
    snapshot = compilePack(content.getProject('tasktrackr'));
    drafts.push(await draft('deep-pg-a'), await draft('deep-pg-b'));
  }, 120000);

  afterAll(async () => {
    for (const source of [one, two]) if (source?.isInitialized) await source.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('› no column, no migration: the receipt and the token round-trip through the simple-json column', async () => {
    const columns: { column_name: string; data_type: string }[] = await one.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'project_versions' ORDER BY column_name`,
      [schema],
    );
    expect(columns.find((c) => c.column_name === 'validation')?.data_type).toBe('text');
    const entityColumns = one.getMetadata(ProjectVersionEntity).columns.map((c) => c.databaseName).sort();
    expect(columns.map((c) => c.column_name)).toEqual(entityColumns);
    const migrations = fs.readdirSync(treeMigrationsDir()).filter((name) => /^[0-9]{13}-.+\.ts$/.test(name));
    expect(migrations).toHaveLength(36);

    const stub = new StubSandbox(judgeFor(snapshot));
    const service = new DeepValidationService(one, stub as never, content);
    await service.start(TEACHER, drafts[0]);
    await service.idle();
    const row = await two.getRepository(ProjectVersionEntity).findOneByOrFail({ id: drafts[0] });
    const deep = (row.validation as unknown as { deep?: { contentDigest: string; status: string; checks: unknown[] } }).deep;
    expect(deep?.status).toBe('passed');
    expect(deep?.checks.map((check: any) => [check.id, check.status])).toEqual(expectedOf(snapshot).clean);
    expect(deep?.contentDigest).toBe(executableContentDigest(row));
    expect(hasCurrentDeepReceipt(row)).toBe(true);
    // the fast report beside it is untouched
    expect(row.validation?.tier).toBe('fast');
  });

  it('› the compare-and-swap: two connections race one token, exactly one wins', async () => {
    const [raw] = await one.query(`SELECT "validation" FROM "project_versions" WHERE "id" = $1`, [drafts[1]]);
    const prev = raw.validation as string;
    const next = (token: string) => JSON.stringify({ ...JSON.parse(prev), deepRun: { token } });
    const a = one.createQueryRunner();
    const b = two.createQueryRunner();
    await a.connect();
    await b.connect();
    try {
      await a.startTransaction();
      await b.startTransaction();
      const sql = `UPDATE "project_versions" SET "validation" = $1 WHERE "id" = $2 AND "status" = 'draft' AND "validation" = $3`;
      const first = await a.query(sql, [next('a'), drafts[1], prev]);
      // b blocks on a's row lock, then re-reads the row a committed and finds its token gone
      const pending = b.query(sql, [next('b'), drafts[1], prev]);
      // a commits once PostgreSQL shows b waiting on the lock (at most two seconds)
      for (let poll = 0; poll < 80; poll += 1) {
        const waiting = (await admin.query(
          `SELECT 1 FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "query" LIKE 'UPDATE "project_versions" SET "validation"%' AND "pid" <> pg_backend_pid()`,
        )) as unknown[];
        if (waiting.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await a.commitTransaction();
      const second = await pending;
      await b.commitTransaction();
      const affected = (result: unknown) => (Array.isArray(result) ? (result[1] as number) : -1);
      expect([affected(first), affected(second)]).toEqual([1, 0]);
      const [after] = await two.query(`SELECT "validation" FROM "project_versions" WHERE "id" = $1`, [drafts[1]]);
      expect(JSON.parse(after.validation).deepRun.token).toBe('a');
    } finally {
      await a.release();
      await b.release();
      await one.query(`UPDATE "project_versions" SET "validation" = $1 WHERE "id" = $2`, [prev, drafts[1]]);
    }
  });

  it('› a second deep validation by the same teacher waits (PG 16 CAS, two connections)', async () => {
    await one.query(`UPDATE "project_versions" SET "validation" = NULL WHERE "id" = ANY($1)`, [drafts]);
    const stub = new StubSandbox(judgeFor(snapshot));
    stub.hold();
    const onOne = new DeepValidationService(one, stub as never, content);
    const onTwo = new DeepValidationService(two, stub as never, content);
    onOne.retryMs = 25;
    onTwo.retryMs = 25;
    const [a, b] = await Promise.all([onOne.start(TEACHER, drafts[0]), onTwo.start(TEACHER, drafts[1])]);
    expect([a.status, b.status].every((s) => s === 'queued' || s === 'running')).toBe(true);
    await waitFor('one run to reach the sandbox', () => stub.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const states = [(await onOne.view(TEACHER, drafts[0])).status, (await onTwo.view(TEACHER, drafts[1])).status].sort();
    expect(states).toEqual(['queued', 'running']);
    expect(new Set(stub.calls.map((call) => call.owner?.ownerId)).size).toBe(1);
    stub.open();
    await waitFor(
      'both receipts',
      async () =>
        (await onOne.view(TEACHER, drafts[0])).status === 'passed' && (await onTwo.view(TEACHER, drafts[1])).status === 'passed',
      60000,
    );
    await Promise.all([onOne.idle(), onTwo.idle()]);
    expect(stub.maxInFlight).toBe(1);
    const order = stub.calls.map((call) => call.owner?.ownerId);
    const switchAt = order.findIndex((id) => id !== order[0]);
    expect(order.slice(switchAt).every((id) => id === order[switchAt])).toBe(true);
    expect(order).toHaveLength(expectedOf(snapshot).microVMs * 2);
  }, 120000);

  it('› two simultaneous promotions never exceed 2 running (PG 16, two connections, the count read from the rows)', async () => {
    const teachers = [
      TEACHER,
      { id: '3f9a1c7e-2b4d-4e8a-9c61-0d5e7f2a8b13', role: 'INSTRUCTOR' as const, cohort: 'default' },
      { id: 'c4d2e8b1-7a3f-4b9c-8e15-6f0a2d9c3e47', role: 'INSTRUCTOR' as const, cohort: 'default' },
    ];
    const capDrafts = [drafts[0], await draft('deep-pg-cap-b', teachers[1].id), await draft('deep-pg-cap-c', teachers[2].id)];
    await one.query(`UPDATE "project_versions" SET "validation" = NULL WHERE "id" = ANY($1)`, [[...drafts, ...capDrafts]]);
    const stub = new StubSandbox(judgeFor(snapshot));
    stub.hold();
    const onOne = new DeepValidationService(one, stub as never, content);
    const onTwo = new DeepValidationService(two, stub as never, content);
    onOne.retryMs = 25;
    onTwo.retryMs = 25;
    // three teachers start at once, across both connections: each pump promotes on its own connection
    await Promise.all([
      onOne.start(teachers[0], capDrafts[0]),
      onTwo.start(teachers[1], capDrafts[1]),
      onTwo.start(teachers[2], capDrafts[2]),
    ]);
    await waitFor('two runs in the sandbox', () => new Set(stub.calls.map((call) => call.owner?.ownerId)).size >= 2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const tokens: { validation: string | null }[] = await two.query(
      `SELECT "validation" FROM "project_versions" WHERE "status" = 'draft' AND "validation" LIKE '%"deepRun"%'`,
    );
    const states = tokens.map((row) => (JSON.parse(row.validation!).deepRun as { state: string }).state).sort();
    expect(states).toEqual(['queued', 'running', 'running']);
    expect(new Set(stub.calls.map((call) => call.owner?.ownerId)).size).toBe(2);
    expect(stub.maxInFlight).toBe(2);

    stub.open();
    await waitFor(
      'three receipts',
      async () =>
        (await onOne.view(teachers[0], capDrafts[0])).status === 'passed' &&
        (await onTwo.view(teachers[1], capDrafts[1])).status === 'passed' &&
        (await onTwo.view(teachers[2], capDrafts[2])).status === 'passed',
      60000,
    );
    await Promise.all([onOne.idle(), onTwo.idle()]);
    expect(stub.maxInFlight).toBe(2);
    expect(mostAtOnce(stub.calls)).toBe(2);
    expect(stub.calls).toHaveLength(expectedOf(snapshot).microVMs * 3);
  }, 120000);

  it('› the platform lock serialises two claims that would each see a free slot (PG 16, two connections, a fixed interleaving)', async () => {
    // One teacher's run is live; teacher A's claim reads the rows (one running,
    // itself first in line) and pauses before it promotes. Teacher B's older
    // token commits after that read, and B's claim runs on the other connection.
    // Without the platform lock both claims see a free slot and three run; with
    // it, B waits for A's commit and then finds the cap reached.
    const ids = {
      x: 'a1c3e5f7-0b2d-4f6a-8c1e-3d5f7a9b1c2d',
      a: 'b2d4f6a8-1c3e-4a7b-9d2f-4e6a8b0c2d3e',
      b: 'c3e5a7b9-2d4f-4b8c-8e3a-5f7b9c1d3e4f',
    };
    const [onX, onA, onB] = [await draft('deep-pg-lock-x', ids.x), await draft('deep-pg-lock-a', ids.a), await draft('deep-pg-lock-b', ids.b)];
    await one.query(`UPDATE "project_versions" SET "validation" = NULL WHERE "validation" LIKE '%"deepRun"%'`);
    const contentDigest = executableContentDigest(await one.getRepository(ProjectVersionEntity).findOneByOrFail({ id: onA }));
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const put = (source: DataSource, versionId: string, userId: string, state: 'queued' | 'running', requestedAt: string) =>
      source.query(`UPDATE "project_versions" SET "validation" = $1 WHERE "id" = $2`, [
        JSON.stringify({
          findings: [],
          tier: 'fast',
          when: at(-5000),
          deepRun: {
            token: `lock-${userId}`,
            userId,
            state,
            requestedAt,
            startedAt: state === 'running' ? at(0) : null,
            beatAt: state === 'running' ? at(0) : null,
            contentDigest,
            microVMs: expectedOf(snapshot).microVMs,
          },
        }),
        versionId,
      ]);
    const runningNow = async () => {
      const rows: { validation: string }[] = await two.query(
        `SELECT "validation" FROM "project_versions" WHERE "status" = 'draft' AND "validation" LIKE '%"deepRun"%'`,
      );
      return rows.filter((row) => JSON.parse(row.validation).deepRun.state === 'running').length;
    };

    try {
      await put(one, onX, ids.x, 'running', at(-3000));
      await put(one, onA, ids.a, 'queued', at(-1000));
      const serviceA = new DeepValidationService(one, {} as never, content);
      const serviceB = new DeepValidationService(two, {} as never, content);
      let readDone: () => void = () => undefined;
      const read = new Promise<void>((resolve) => (readDone = resolve));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const hooked = serviceA as unknown as { tokensOf: (manager: unknown) => Promise<unknown>; claim: (userId: string) => Promise<unknown> };
      const original = hooked.tokensOf.bind(serviceA);
      let paused = false;
      hooked.tokensOf = async (manager: unknown) => {
        const rows = await original(manager);
        if (!paused) {
          paused = true;
          readDone();
          await gate;
        }
        return rows;
      };
      const claimA = hooked.claim(ids.a);
      await read;
      // B's token is older than A's, and becomes visible only after A's read
      await put(two, onB, ids.b, 'queued', at(-2000));
      const claimB = (serviceB as unknown as { claim: (userId: string) => Promise<unknown> }).claim(ids.b);
      const bSettledFirst = await Promise.race([
        claimB.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400)),
      ]);
      release();
      const [a, b] = await Promise.all([claimA, claimB]);
      expect(await runningNow()).toBe(DEEP_VALIDATION_PLATFORM_IN_FLIGHT);
      expect(bSettledFirst).toBe(false);
      expect(a).toMatchObject({ versionId: onA });
      expect(b).toBe('blocked');
    } finally {
      await one.query(`UPDATE "project_versions" SET "validation" = NULL WHERE "id" = ANY($1)`, [[onX, onA, onB]]);
    }
  }, 60000);
});
