import 'reflect-metadata';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  COHORT_IMPORT_MAX_BYTES,
  RUN_SHAPE_REFUSAL_CODES,
  uploadRefusalForRunShape,
  type RunResult,
  type RunShapeRefusalCode,
} from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { DeepValidationService } from '../src/authoring/deep-validation';
import { buildPackManifest, checkPackRuns } from '../src/authoring/upload-limits';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import { config } from '../src/config';
import { ContentService } from '../src/content/content.service';
import { isOlderLayout, layoutFromManifest } from '../src/content/legacy-layout';
import { MemoryPackSource, packRootOf } from '../src/content/memory-pack-source';
import { soleTaskFor } from '../src/content/pack-compiler';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../src/content/project.entities';
import type { CodeChecks, PhaseContent, PhaseRun, ProjectContent } from '../src/content/content.types';
import { readZip, zipLimits } from '../src/content/zip-reader';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { ExecutionService } from '../src/execution/execution.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { SandboxService } from '../src/execution/sandbox.service';
import { FeedbackService } from '../src/feedback/feedback.service';
import { zipDirectory } from './fixtures/upload-packs/archive';
import { HOSTILE_ARCHIVES } from './fixtures/upload-packs/hostile';
import { SHELF_DIR } from './fixtures/upload-packs/markers';
import { mockAiForRoutes } from './mock-ai';
import { stopOwnedChild } from './owned-child';
import { bearer } from './support/http';
import { bootApi } from './support/app';

/**
 * An uploaded project changes nothing about isolation.
 *
 * This is the one place a real runner, inside the Linux sandbox family's
 * microVM (`LINUX_FAMILY` below), proves that a teacher's upload buys no way
 * out of the sandbox. It holds three cases:
 *
 * 1. The Shelf pack's Implementation reference solution, graded through the real
 *    sandbox by the real grader (`FeedbackService.buildReport`), passes its
 *    hidden suite on every run. The pack is read the way an upload reads it: the
 *    fixture directory is zipped, read back by the upload door's `readZip`, and loaded
 *    through a `MemoryPackSource`. Its bytes are read at run time and never
 *    copied here.
 * 2. Three escape attempts from inside teacher-supplied hidden-test code:
 *    network egress, a write outside the workspace, and a time-limit overrun.
 *    Each is an in-spec overlay on the pack's hidden suite, and the fixture is
 *    never edited. Each one is graded beside its learner-code twin: the same
 *    attempt, written into the learner's own editable Python file and reached
 *    by one call from the suite. Both must come back with the same named
 *    fail-closed outcome and the same check status. The assertion names the
 *    outcome. It is never just "did not pass", so a runner that is down, or a
 *    stub that answers "passed" or "exit 0", cannot satisfy it.
 *    The limits are the API's own (`config.runTimeoutSeconds` and
 *    `config.runMemoryMb`, 15 s and 256 MB, which the runner caps at 60 s and
 *    512 MB). The pack sends no limit, and this spec changes none.
 * 3. A guard over the upload door's run-shape rule: a pack-declared argv
 *    outside the allowed list is refused before anything is booked. The upload door answers 400
 *    with the run-shape code and the ARGV_* finding. No `SandboxService`
 *    method is called, `DeepValidationService.start` is never called, and no
 *    row is written. This case needs no runner and is green on any host.
 *
 * On a host where the runner reports `kernel-isolation-unavailable` (macOS,
 * a laptop, any machine without Landlock or a microVM), cases 1 and 2 never
 * pass and never skip. The runner is started first on a temporary UNIX socket,
 * its `/health` is probed, and every real-runner test then fails with one named
 * reason: `KERNEL_ISOLATION_UNAVAILABLE` below. The Linux proof is a run
 * inside that family.
 *
 * The transport is `test/socket-runner.spec.ts`'s: `runner/serve.py` started as
 * a plain process on a UNIX socket in a fresh temporary directory, never a TCP
 * port, in socket mode. Unlike that spec, nothing is required a second time:
 * `SandboxService` reads `config.runnerMode` and `config.runnerSocket` at call
 * time, so this file sets them on the one imported `config` and restores them
 * in `afterAll`. A second module graph would cost about 30 MB of a family heap
 * capped at 640 MB (`--max-old-space-size=640`). The runner is spawned without
 * `RUNNER_ISOLATION`, and only Landlock (the family's own isolation step)
 * counts as isolated. It is stopped in `afterAll` with `stopOwnedChild`.
 * No AI is called: the reviewer is a fixed stub, and the AppModule's provider
 * is the route test double.
 */

/** The Linux family this spec is proved in. */
const LINUX_FAMILY = 'sandbox-20261002';

/** The one reason a real-runner case fails on a host that cannot isolate. */
const KERNEL_ISOLATION_UNAVAILABLE = `kernel isolation unavailable on this host: run in the ${LINUX_FAMILY} family`;

/** Where the socket transport could not even start: a different fact, said differently. */
const RUNNER_DID_NOT_ANSWER = 'the runner did not answer on its temporary socket, so nothing here could be graded';

/**
 * The runner's own refusal sentences, as its Python policy raises them
 * (`runner/sandbox_runner.py` `_blocked` and `_fs_refuse`; read, never edited).
 * The unittest harness reports an errored case as `<ExceptionType>: <message>`.
 */
const NETWORK_REFUSAL = 'RuntimeError: network access is disabled in the LearnSDLC sandbox';
const WRITE_REFUSAL_PREFIX = 'PermissionError: the LearnSDLC sandbox keeps a run inside its own workspace: ';

/** The named fail-closed outcomes this spec accepts, one per escape. */
type EscapeOutcome = 'network-refused' | 'write-refused' | 'time-limit';

const RUNNER_DIR = path.resolve(__dirname, '..', 'runner');

/* ===================================================================== */
/* Case 3: the run-shape rule at the upload door (no runner needed)       */
/* ===================================================================== */

describe('uploaded pack isolation: a pack argv outside the allowed list is refused before booking', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: DataSource;
  const stamp = Date.now();
  let accounts = 0;
  let address = 0;
  const spies: jest.SpyInstance[] = [];
  let deepStart: jest.SpyInstance;

  /** Every method `SandboxService` has, counted: the only way into a runner. */
  const sandboxCalls = (): number =>
    spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

  const from = () => ({ 'x-forwarded-for': `10.78.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  const teacher = async () => {
    accounts += 1;
    const registered = await request(server)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `lxd-${accounts}-${stamp}@uploaded-pack-isolation.test`, password: 'Correct-Horse-9', displayName: `lxd ${accounts}` })
      .expect(201);
    const id = registered.body.user.id as string;
    await db.manager.update(UserEntity, { id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(id);
    return registered.body.token as string;
  };

  /** One fresh teacher per upload: the route is 5/60 per teacher, and this file measures the rule, not the limiter. */
  const upload = async (archive: Buffer) =>
    request(server)
      .post(UPLOAD_PATH)
      .set(bearer(await teacher()))
      .set(from())
      .send({ title: 'Books on a shelf', archiveBase64: archive.toString('base64') });

  const rowCounts = async () => ({
    projects: await db.getRepository(ProjectEntity).count(),
    versions: await db.getRepository(ProjectVersionEntity).count(),
    phases: await db.getRepository(ProjectPhaseEntity).count(),
    tasks: await db.getRepository(ProjectTaskEntity).count(),
    files: await db.getRepository(ProjectFileEntity).count(),
    blobs: await db.getRepository(ContentBlobEntity).count(),
    audits: await db.getRepository(AuditEventEntity).count(),
  });

  const priorCap = process.env.IMPORT_MAX_BYTES;

  beforeAll(async () => {
    delete process.env.IMPORT_MAX_BYTES;
    // Before the module is built, so every instance the app makes is counted.
    for (const name of Object.getOwnPropertyNames(SandboxService.prototype)) {
      if (name === 'constructor') continue;
      const held = Object.getOwnPropertyDescriptor(SandboxService.prototype, name);
      if (!held || typeof held.value !== 'function') continue;
      spies.push(jest.spyOn(SandboxService.prototype as any, name as any));
    }
    deepStart = jest.spyOn(DeepValidationService.prototype, 'start');
    ({ app, http: server } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true }));
    db = app.get(DataSource);
  });

  afterAll(async () => {
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
    await app?.close();
    for (const spy of spies) spy.mockRestore();
    deepStart?.mockRestore();
  });

  it('the counters are live: the app’s sandbox is the counted class, and execute is among the counted methods', () => {
    expect(spies.length).toBeGreaterThan(0);
    expect(jest.isMockFunction(SandboxService.prototype.execute)).toBe(true);
    const sandbox = app.get(SandboxService);
    expect(sandbox).toBeInstanceOf(SandboxService);
    // No own-property override on the instance: its execute is the counted one.
    expect(Object.prototype.hasOwnProperty.call(sandbox, 'execute')).toBe(false);
    expect(jest.isMockFunction(DeepValidationService.prototype.start)).toBe(true);
  });

  it('each ARGV_* archive is refused at upload with its code, and the sandbox sees zero jobs and no deep validation is booked', async () => {
    const argvCodes = (RUN_SHAPE_REFUSAL_CODES as readonly string[]).filter((code) => code.startsWith('ARGV_'));
    expect(argvCodes.length).toBeGreaterThan(0);
    // The hostile set's own archives, read at run time: one per ARGV_* code, no more and no fewer.
    const hostile = HOSTILE_ARCHIVES.filter((one) => one.expectedCode !== null && argvCodes.includes(one.expectedCode));
    expect([...new Set(hostile.map((one) => one.expectedCode))].sort()).toEqual([...argvCodes].sort());

    for (const one of hostile) {
      const code = one.expectedCode as RunShapeRefusalCode;
      const archive = one.build();

      // The upload door's rule itself, over the same bytes the door reads: an
      // older archive (the hostile set's) converted once first, as the door converts it.
      const entries = readZip(archive, zipLimits(COHORT_IMPORT_MAX_BYTES));
      const archived = new MemoryPackSource(entries, 'upload', packRootOf(entries));
      const source = isOlderLayout(archived) ? layoutFromManifest(archived).source : archived;
      expect({ archive: one.name, rule: checkPackRuns(buildPackManifest(source)).map((finding) => finding.code) }).toEqual({
        archive: one.name,
        rule: expect.arrayContaining([code]),
      });

      const rows = await rowCounts();
      const calls = sandboxCalls();
      const starts = deepStart.mock.calls.length;
      const res = await upload(archive);
      expect({
        archive: one.name,
        status: res.status,
        code: res.body?.code,
        findings: ((res.body?.findings ?? []) as { code: string }[]).map((finding) => finding.code),
      }).toEqual({
        archive: one.name,
        status: 400,
        code: uploadRefusalForRunShape(code),
        findings: expect.arrayContaining([code]),
      });
      // The zero sandbox calls are not independent evidence: the control below
      // shows the upload door calls no sandbox even for a pack it accepts. The
      // claim "refused before booking" rests on the 400 with its ARGV_* finding,
      // no deep validation started and no row written (draft.ts: smoke and
      // drill change only by re-upload).
      expect({ archive: one.name, sandboxCalls: sandboxCalls() - calls, deepValidationStarts: deepStart.mock.calls.length - starts }).toEqual({
        archive: one.name,
        sandboxCalls: 0,
        deepValidationStarts: 0,
      });
      // No draft, so nothing exists that a booking could name.
      expect(await rowCounts()).toEqual(rows);
    }
  });

  it('control: the clean Shelf pack archive is accepted by the same door as a draft, and the upload alone books nothing', async () => {
    const rows = await rowCounts();
    const calls = sandboxCalls();
    const starts = deepStart.mock.calls.length;
    const res = await upload(zipDirectory(SHELF_DIR));
    expect({ status: res.status, body: res.status >= 400 ? res.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    const version = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: res.body.versionId });
    expect(version.status).toBe('draft');
    expect((await rowCounts()).versions).toBe(rows.versions + 1);
    expect({ sandboxCalls: sandboxCalls() - calls, deepValidationStarts: deepStart.mock.calls.length - starts }).toEqual({
      sandboxCalls: 0,
      deepValidationStarts: 0,
    });
  });
});

/* ===================================================================== */
/* Cases 1 and 2: the real runner                                         */
/* ===================================================================== */

interface RunnerHealth {
  ok?: boolean;
  isolation?: { status?: string; mechanism?: string; reason?: string };
}

/** GET /health over the UNIX socket; null when nothing answers yet. No keep-alive, so no socket outlives the call. */
function runnerHealth(socketPath: string): Promise<RunnerHealth | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path: '/health', method: 'GET', agent: false, timeout: 3000, headers: { connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? (JSON.parse(body) as RunnerHealth) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/** One sandbox call as the grader made it, and the runner's answer before the grader redacts it. */
interface Observed {
  job: SandboxJob;
  result: RunResult;
}

type Probe = 'ok' | 'isolation-unavailable' | 'no-runner';

describe('uploaded pack isolation: the real runner (the sandbox-20261002 family)', () => {
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdlc-lxd-'));
  const socketPath = path.join(socketDir, 'runner.sock');
  let runner: ChildProcess | undefined;
  let probe: Probe = 'no-runner';
  let saved: { runnerMode: typeof config.runnerMode; runnerSocket: string } | undefined;
  /** The runner's own last words, kept short: a run that is never re-run must say why the runner did not answer. */
  let runnerStderr = '';

  beforeAll(async () => {
    // The runner decides isolation from its own kernel. RUNNER_ISOLATION is the
    // fresh-VM supervisor's word and is never inherited here (the family's ENV
    // does not carry it either), so a laptop shell that happens to set it
    // cannot make this spec run real jobs without the fence.
    const env: NodeJS.ProcessEnv = { ...process.env, RUNNER_SOCKET: socketPath };
    delete env.RUNNER_ISOLATION;
    runner = spawn('python3', [path.join(RUNNER_DIR, 'serve.py')], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    runner.on('error', (error) => {
      runnerStderr = `${runnerStderr}spawn: ${error.message}\n`.slice(-2000);
    });
    runner.stderr?.setEncoding('utf8');
    runner.stderr?.on('data', (chunk: string) => {
      runnerStderr = `${runnerStderr}${chunk}`.slice(-2000);
    });
    // Probe first. /health answers whether or not this host can isolate, so the
    // two facts (the runner is up; the runner can fence a job) stay apart. Only
    // Landlock counts: it is what the family's isolation step asserts.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const health = fs.existsSync(socketPath) ? await runnerHealth(socketPath) : null;
      if (health) {
        probe = health.isolation?.status === 'ok' && health.isolation.mechanism === 'landlock' ? 'ok' : 'isolation-unavailable';
        break;
      }
      if (Date.now() > deadline || runner.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // SandboxService reads these at call time; one graph, set here, restored below.
    saved = { runnerMode: config.runnerMode, runnerSocket: config.runnerSocket };
    config.runnerMode = 'socket';
    config.runnerSocket = socketPath;
  });

  afterAll(async () => {
    if (saved) {
      config.runnerMode = saved.runnerMode;
      config.runnerSocket = saved.runnerSocket;
    }
    loaded = null;
    await stopOwnedChild(runner);
    runner?.stderr?.removeAllListeners('data');
    runner?.stderr?.destroy();
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  /** Never a pass and never a skip where the runner cannot fence a job: one named failure. */
  function requireKernelIsolation(): void {
    if (probe === 'isolation-unavailable') throw new Error(KERNEL_ISOLATION_UNAVAILABLE);
    if (probe !== 'ok') {
      const tail = runnerStderr.trim().slice(-400);
      throw new Error(tail ? `${RUNNER_DID_NOT_ANSWER}; the runner's stderr ended: ${tail}` : RUNNER_DID_NOT_ANSWER);
    }
  }

  let loaded: { content: ContentService; project: ProjectContent } | null = null;

  /** The Shelf pack as an upload reads it: the directory zipped, read back by the upload reader, loaded from memory. */
  function shelf() {
    if (loaded) return loaded;
    const archive = zipDirectory(SHELF_DIR);
    const entries = readZip(archive, zipLimits(COHORT_IMPORT_MAX_BYTES));
    const source = new MemoryPackSource(entries, 'upload', packRootOf(entries));
    const content = new ContentService();
    const project = content.loadProject(source);
    content.installVersions([{ versionId: `${project.slug}@${project.version}`, content: project }]);
    loaded = { content, project };
    return loaded;
  }

  function implementation(): { phase: PhaseContent; checks: CodeChecks } {
    const phase = shelf().project.phases.find((one) => one.key === 'implementation');
    if (!phase || phase.checks.kind !== 'code') throw new Error('the Shelf pack has no code implementation phase');
    return { phase, checks: phase.checks };
  }

  /** The repository double a report's reads go to; nothing here is stored. */
  function emptyRepo() {
    return {
      find: async () => [],
      findOne: async () => null,
      findOneBy: async () => null,
      findOneByOrFail: async (where: { id?: string }) => ({ id: where?.id ?? 'ps-lxd' }),
      count: async () => 0,
      save: async (row: unknown) => row,
      update: async () => ({ affected: 0 }),
      create: (fields: unknown) => fields,
    };
  }

  /**
   * The real grader over the real socket runner. The one double that matters
   * is the reviewer: a fixed stub, so no AI is called and the checks decide.
   * The sandbox is the real `SandboxService` with a recorder in front of
   * `execute` that keeps the runner's answer before the grader redacts it.
   */
  function grader() {
    const { content, project } = shelf();
    const real = new SandboxService();
    const observed: Observed[] = [];
    const sandbox = Object.assign(Object.create(real), {
      async execute(job: SandboxJob, owner?: unknown): Promise<RunResult> {
        const result = await real.execute(job, owner as never);
        observed.push({ job, result: JSON.parse(JSON.stringify(result)) as RunResult });
        return result;
      },
    });
    const assistant = {
      reviewSubmission: async (phase: PhaseContent) => ({
        provider: 'lxd-stub',
        verdict: 'pass' as const,
        summary: 'stub',
        strengths: [],
        improvements: [],
        processNote: '',
        criteriaEvidence: phase.rubric.criteria.map((criterion) => ({ key: criterion.key, met: true, evidence: 'stub', issue: '', nextStep: '' })),
      }),
    };
    const enrollments = { ...emptyRepo(), findOneByOrFail: async () => ({ id: 'e-lxd', userId: 'u-lxd', projectSlug: project.slug }) };
    const learnerTestFiles = ExecutionService.prototype.learnerTestFiles as unknown as (
      this: { content: unknown },
      ...args: unknown[]
    ) => Record<string, string>;
    const service = new FeedbackService(
      emptyRepo() as never,
      emptyRepo() as never,
      enrollments as never,
      emptyRepo() as never,
      content as never,
      sandbox as never,
      { learnerTestFiles: learnerTestFiles.bind({ content }) } as never,
      assistant as never,
      { register: () => undefined, enqueue: async () => undefined, durable: false } as never,
      { emitJob: () => undefined } as never,
      { onVerdict: async () => undefined } as never,
    );
    return { service, observed };
  }

  /** Grade the implementation phase once, the way a submission is graded. */
  async function grade(phase: PhaseContent, workspace: Record<string, string>) {
    const { service, observed } = grader();
    const tasks = [soleTaskFor(phase)];
    const state = {
      id: 'ps-lxd',
      enrollmentId: 'e-lxd',
      userId: 'u-lxd',
      phaseKey: phase.key,
      phaseOrder: phase.order,
      status: 'in_progress',
      bestScore: null,
      attempts: 1,
      reflection: null,
      workspace,
      acceptedScreenCopy: null,
      links: null,
      drill: null,
      ranBeforeSubmit: true,
      unlockedAt: null,
      passedAt: null,
      interview: null,
      solutionReadAt: null,
      runClock: null,
    };
    const report = await service.buildReport(phase, state as never, tasks, tasks[0]);
    return { report, observed };
  }

  const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((one, at) => one === b[at]);

  /** The graded (hidden) job of one run, as the runner answered it. */
  function hiddenOf(observed: Observed[], run: PhaseRun): Observed {
    const hit = observed.find(
      ({ job }) =>
        job.mode === 'tests' &&
        job.harness === run.hiddenHarness &&
        sameList(job.testPaths, run.testPaths) &&
        Object.keys(run.hiddenTestFiles).every((at) => at in job.files),
    );
    if (!hit) throw new Error(`no graded job was sent for the ${run.id || 'only'} run`);
    return hit;
  }

  /* ------------------------------ case 1 ------------------------------ */

  it('the Shelf pack: the Implementation reference solution, graded through the real sandbox, passes its hidden suite on every run', async () => {
    requireKernelIsolation();
    const { phase, checks } = implementation();
    expect(checks.runs.length).toBeGreaterThan(0);
    expect(Object.keys(checks.solutionFiles).length).toBeGreaterThan(0);

    const { report, observed } = await grade(phase, checks.solutionFiles);

    // A visible and a graded job per run, all answered by the runner.
    expect(observed.length).toBe(2 * checks.runs.length);
    expect(observed.map(({ result }) => result.exitKind)).toEqual(observed.map(() => 'ok'));
    for (const run of checks.runs) {
      const { job, result } = hiddenOf(observed, run);
      // The pack sends no limit; the API applies its own.
      expect({ run: run.id, timeoutSeconds: (job as any).timeoutSeconds, memoryMb: (job as any).memoryMb }).toEqual({
        run: run.id,
        timeoutSeconds: undefined,
        memoryMb: undefined,
      });
      const tests = result.tests;
      expect({
        run: run.id,
        ok: result.ok,
        exitKind: result.exitKind,
        failed: tests?.failed,
        errored: tests?.errored,
        everyCasePassed: !!tests && tests.total > 0 && tests.passed === tests.total && tests.cases.length === tests.total,
      }).toEqual({ run: run.id, ok: true, exitKind: 'ok', failed: 0, errored: 0, everyCasePassed: true });
    }
    const statusOf = (id: string) => report.checks.find((check) => check.id === id)?.status;
    expect(statusOf('hidden-tests')).toBe('passed');
    if (checks.runs.length > 1) {
      for (const run of checks.runs) expect({ check: `hidden-tests-${run.id}`, status: statusOf(`hidden-tests-${run.id}`) }).toEqual({ check: `hidden-tests-${run.id}`, status: 'passed' });
    }
  }, 180_000);

  /* ------------------------------ case 2 ------------------------------ */

  /**
   * The three attempts, each a Python function body the two twins share
   * byte for byte. Each would *pass* (or hang, for the network on a machine
   * with a route) if the fence were not there:
   * - egress dials TEST-NET-1 (RFC 5737, never routed), so even a broken fence
   *   sends nothing anywhere, and a dial that is not refused times out with a
   *   different message and goes red;
   * - the write names a file in this spec's own temporary directory, outside
   *   every workspace, and the host checks afterwards that it does not exist;
   * - the overrun spins until the runner's clock stops it.
   */
  const ESCAPES: { attempt: string; outcome: EscapeOutcome; body: (target: string) => string }[] = [
    {
      attempt: 'network egress',
      outcome: 'network-refused',
      body: () =>
        [
          'def lsdlc_escape_attempt():',
          '    import socket',
          '    connection = socket.create_connection(("192.0.2.1", 80), timeout=3)',
          '    connection.close()',
        ].join('\n'),
    },
    {
      attempt: 'a write outside the workspace',
      outcome: 'write-refused',
      body: (target) =>
        [
          'def lsdlc_escape_attempt():',
          `    with open(${JSON.stringify(target)}, "w") as handle:`,
          '        handle.write("escaped")',
        ].join('\n'),
    },
    {
      attempt: 'a time-limit overrun',
      outcome: 'time-limit',
      body: () => ['def lsdlc_escape_attempt():', '    while True:', '        pass'].join('\n'),
    },
  ];

  const TEACHER_CASE = 'TeacherSuppliedEscape.test_teacher_code_attempt';
  const LEARNER_CASE = 'LearnerCodeTwin.test_learner_code_attempt';

  /** The Shelf pack's Python run, the editable Python file the learner writes, and its import name. */
  function pythonSeat(checks: CodeChecks) {
    const run = checks.runs.find((one) => one.language === 'python' && one.hiddenHarness === 'unittest');
    if (!run) throw new Error('the Shelf pack Implementation has no Python run with a unittest hidden harness');
    const target = checks.editableTargets.find((at) => at.endsWith('.py') && at in checks.solutionFiles);
    if (!target) throw new Error('the Shelf pack Implementation has no editable Python file with a solution');
    const first = Object.keys(run.hiddenTestFiles).find((at) => at.endsWith('.py'));
    const dir = first && first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
    return { run, target, module: target.replace(/\.py$/, '').split('/').join('.'), dir };
  }

  /** The Shelf pack's Implementation with one more file in the Python run's hidden suite; the fixture is untouched. */
  function withHiddenOverlay(phase: PhaseContent, checks: CodeChecks, run: PhaseRun, at: string, body: string): PhaseContent {
    const runs = checks.runs.map((one) =>
      one === run ? { ...one, hiddenTestFiles: { ...one.hiddenTestFiles, [at]: body }, testPaths: [...one.testPaths, at] } : one,
    );
    return { ...phase, checks: { ...checks, hiddenTestFiles: { ...checks.hiddenTestFiles, [at]: body }, runs } };
  }

  /**
   * The named outcome of one attempt, read from the runner's answer to the
   * graded Python job. Anything that is not one of the three fail-closed
   * outcomes is named for what it is, so a failing assertion says what came back.
   */
  function outcomeOf(result: RunResult, caseName: string): string {
    // A short slice of what came back rides on every unexpected name, so a red
    // on a run that is never re-run says what happened. The case message is
    // this spec's own overlay speaking, never sealed bytes.
    const short = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (result.exitKind === 'unavailable') return `unavailable (${short(result.stderr)})`;
    if (result.exitKind === 'timeout') return !result.ok && !result.tests ? 'time-limit' : 'timeout-with-a-result';
    if (result.exitKind !== 'ok') return `exit:${result.exitKind} (${short(result.stderr)})`;
    const hit = result.tests?.cases.find((one) => one.name === caseName);
    if (!hit) return `no-such-case (${result.tests?.cases.length ?? 0} cases)`;
    if (hit.status === 'passed') return 'escaped';
    const message = String((hit as { message?: unknown }).message ?? '');
    if (hit.status === 'errored' && message === NETWORK_REFUSAL) return 'network-refused';
    if (hit.status === 'errored' && message.startsWith(WRITE_REFUSAL_PREFIX)) return 'write-refused';
    return `${hit.status}:other (${short(message)})`;
  }

  /** Grade one twin; what came back from the graded Python job and the report's line for it. */
  async function twin(kind: 'teacher' | 'learner', escape: (typeof ESCAPES)[number], target: string) {
    const { phase, checks } = implementation();
    const seat = pythonSeat(checks);
    const at = `${seat.dir ? `${seat.dir}/` : ''}test_lsdlc_${kind}_escape.py`;
    const body = escape.body(target);
    const hidden =
      kind === 'teacher'
        ? [
            `"""LX-D overlay: teacher-supplied hidden-test code attempting ${escape.attempt}."""`,
            'import unittest',
            '',
            '',
            body,
            '',
            '',
            'class TeacherSuppliedEscape(unittest.TestCase):',
            '    def test_teacher_code_attempt(self):',
            '        lsdlc_escape_attempt()',
            '',
          ].join('\n')
        : [
            `"""LX-D overlay: the suite calls the learner's own code, which attempts ${escape.attempt}."""`,
            'import unittest',
            '',
            `from ${seat.module} import lsdlc_escape_attempt`,
            '',
            '',
            'class LearnerCodeTwin(unittest.TestCase):',
            '    def test_learner_code_attempt(self):',
            '        lsdlc_escape_attempt()',
            '',
          ].join('\n');
    const workspace =
      kind === 'teacher'
        ? { ...checks.solutionFiles }
        : { ...checks.solutionFiles, [seat.target]: `${checks.solutionFiles[seat.target]}\n\n# LX-D overlay: the learner's own code\n${body}\n` };
    const overlaid = withHiddenOverlay(phase, checks, seat.run, at, hidden);
    const { report, observed } = await grade(overlaid, workspace);
    const graded = hiddenOf(observed, (overlaid.checks as CodeChecks).runs.find((one) => one.id === seat.run.id)!);
    // The same grading's visible Python job: no overlay rides in it, so it is
    // the control that shows the runner itself was healthy for this grading.
    const visible = observed.find(
      ({ job }) =>
        job !== graded.job &&
        job.mode === 'tests' &&
        job.language === seat.run.language &&
        job.harness === seat.run.harness &&
        sameList(job.testPaths, seat.run.visibleTests),
    );
    const caseName = kind === 'teacher' ? TEACHER_CASE : LEARNER_CASE;
    const checkId = checks.runs.length > 1 ? `hidden-tests-${seat.run.id}` : 'hidden-tests';
    return {
      outcome: outcomeOf(graded.result, caseName),
      status: report.checks.find((check) => check.id === checkId)?.status,
      result: graded.result,
      job: graded.job,
      visible: visible?.result ?? null,
      caseName,
    };
  }

  /** What else must hold for each named outcome, beyond the name: the rest of the suite ran, the host is untouched, the clock held. */
  function expectFailClosed(escape: (typeof ESCAPES)[number], one: Awaited<ReturnType<typeof twin>>, target: string) {
    // The control: the runner answered this grading's visible Python job in
    // full, so the named outcome belongs to the attempt, not to a runner that
    // times out (or fails) every job.
    expect({ visibleExitKind: one.visible?.exitKind ?? null, visibleTests: (one.visible?.tests?.total ?? 0) > 0 }).toEqual({
      visibleExitKind: 'ok',
      visibleTests: true,
    });
    expect(one.result.ok).toBe(false);
    expect({ timeoutSeconds: (one.job as any).timeoutSeconds, memoryMb: (one.job as any).memoryMb }).toEqual({
      timeoutSeconds: undefined,
      memoryMb: undefined,
    });
    if (escape.outcome === 'time-limit') {
      const limitMs = Math.min(config.runTimeoutSeconds, 60) * 1000;
      expect(one.result.tests ?? null).toBeNull();
      expect(one.result.durationMs).toBeGreaterThanOrEqual(limitMs - 2000);
      expect(one.result.durationMs).toBeLessThanOrEqual(limitMs + 10_000);
      return;
    }
    // Only the attempt failed: every case of the pack's own suite still passed beside it.
    expect(one.result.tests ?? null).not.toBeNull();
    const tests = one.result.tests!;
    const others = tests.cases.filter((c) => c.name !== one.caseName);
    expect({ others: others.length > 0, otherStatuses: [...new Set(others.map((c) => c.status))], failedOrErrored: tests.failed + tests.errored }).toEqual({
      others: true,
      otherStatuses: ['passed'],
      failedOrErrored: 1,
    });
    if (escape.outcome === 'write-refused') expect(fs.existsSync(target)).toBe(false);
  }

  for (const escape of ESCAPES) {
    it(`escape from teacher-supplied hidden-test code, ${escape.attempt}: fails closed as "${escape.outcome}", exactly as its learner-code twin`, async () => {
      requireKernelIsolation();
      // The learner limits, from config; the pack cannot raise them and this spec does not.
      expect({ runTimeoutSeconds: config.runTimeoutSeconds, runMemoryMb: config.runMemoryMb }).toEqual({ runTimeoutSeconds: 15, runMemoryMb: 256 });

      const teacherTarget = path.join(socketDir, `escape-teacher-${ESCAPES.indexOf(escape)}.txt`);
      const learnerTarget = path.join(socketDir, `escape-learner-${ESCAPES.indexOf(escape)}.txt`);
      const teacher = await twin('teacher', escape, teacherTarget);
      const learner = await twin('learner', escape, learnerTarget);

      expect({ teacher: teacher.outcome, learner: learner.outcome }).toEqual({ teacher: escape.outcome, learner: escape.outcome });
      expect({ teacher: teacher.status, learner: learner.status }).toEqual({ teacher: 'failed', learner: 'failed' });
      expect(teacher.result.exitKind).toBe(learner.result.exitKind);
      expectFailClosed(escape, teacher, teacherTarget);
      expectFailClosed(escape, learner, learnerTarget);
    }, 240_000);
  }
});
