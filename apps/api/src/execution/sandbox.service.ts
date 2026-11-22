import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AnalyzerReport, PreviewUnsupported, RunExitKind, RunResult } from '@learnsdlc/shared';
// The rule the editor keys its "analysis could not run" notice off.
import { ANALYZER_UNAVAILABLE_RULE } from '@learnsdlc/shared';
import { config } from '../config';
import { resolveLocalAwsCredentials, resolvePrebakeProbeInTests } from '../config/execution';
import { sandboxExecutionDuration } from '../observability/metrics';
import { RunGate, SandboxBusyError } from './run-gate';
import { DEEP_VALIDATION_STEP_PREFIX, startupProbeOwner, STARTUP_PROBE_STEP_ID } from './startup-probe';

/** What every sandbox job may carry besides its files and mode. */
interface SandboxClock {
  /**
   * The day the child calls today, as an ISO date, or absent for the machine's
   * clock. The runner exports it as LEARNSDLC_NOW and the pack's
   * own helper is the only thing that reads it. `execute` spreads the job into
   * the payload, so this reaches the local, socket and Lambda transports
   * without any of them knowing about it.
   */
  clock?: string;
}

export interface SandboxTestJob extends SandboxClock {
  files: Record<string, string>;
  /**
   * Files the learner's code must not read: the reference implementation, a
   * planted mutant, a hidden suite. The runner writes these outside the
   * workspace, imports them and deletes them before any learner module loads,
   * so neither the file nor the path it imported from survives the run.
   */
  gradedFiles?: Record<string, string>;
  mode: 'tests';
  testPaths: string[];
  /** 'python' | 'javascript' | 'typescript'. */
  language?: string;
  /* ------------------------------ harness ------------------------------- */
  /**
   * Which harness runs the job: 'unittest' | 'pytest' | 'js'. Absent means the
   * language's own default (unittest for python, js otherwise) so a caller
   * that names no harness gets the language default. The pack
   * declares it per run (`checks.runs[].harness`), because the learner reads
   * and writes pytest while the sealed suites stay on unittest.
   */
  harness?: string;
  /**
   * esbuild the workspace's .ts/.tsx to CommonJS before the child starts. Only
   * a typescript run asks for it, and the tool is an enum of one: content names
   * a tool the runner knows, never an argv.
   */
  transform?: { tool: 'esbuild'; jsx?: 'automatic' };
  /**
   * The run this job belongs to (`checks.runs[].id`). The runner stamps it onto
   * every case as `step`, which is what lets two runs of one phase merge into
   * one list the Tests pane can group by layer. Absent for a phase with one
   * run, so a single-run result carries no step it would have nothing to group.
   */
  runId?: string;
}

export interface SandboxSmokeJob extends SandboxClock {
  files: Record<string, string>;
  mode: 'smoke';
  smokeCommands: string[][];
  expectInOutput?: string;
  language?: string;
}

export type SandboxJob = SandboxTestJob | SandboxSmokeJob;

/** Server-created association, separate from the learner source envelope. */
export interface SandboxTraceOwner {
  kind: 'run' | 'preview';
  ownerId: string;
  stepId: string;
}

/**
 * Seconds the harness around a learner's run may take beyond the learner's
 * own time limit: starting the interpreter, writing the files, collecting the
 * report. The learner's limit itself is never extended.
 */
const HARNESS_HEADROOM_SECONDS = 20;

/**
 * The longest one sandbox job may hold its caller: the learner's time limit,
 * the harness's headroom and, on the socket transport, the remote start-up
 * allowance. Read at call time, because specs change config while they run.
 */
export function sandboxHarnessTimeoutMs(): number {
  return (config.runTimeoutSeconds + HARNESS_HEADROOM_SECONDS +
    (config.runnerMode === 'socket' ? config.runnerTransportAllowanceSeconds : 0)) * 1000;
}

/** The static analyser's bound: it parses the learner's files and runs no learner code. */
const ANALYZER_TIMEOUT_MS = 20_000;

/* ------------------------------ execution metrics ------------------------- */

/**
 * What one execution was for, as the histogram labels it.
 *
 * A label value is a series name, so it comes from this fixed set and never
 * from a phase, a pack, a file or an identifier. It is read off the trace
 * owner, because that is all `execute` is told about its caller: an owner of
 * kind 'run' is a learner's Run press (`execution.service.ts`), the platform's
 * own pre-bake probe names itself with `STARTUP_PROBE_STEP_ID`, and a caller
 * that sends no owner is a graded submission job (`feedback.service.ts`
 * runSandbox).
 */
type SandboxPurpose = 'run' | 'grading' | 'probe' | 'validation';

function executionPurpose(owner: SandboxTraceOwner | undefined): SandboxPurpose {
  if (!owner) return 'grading';
  if (owner.stepId.startsWith(DEEP_VALIDATION_STEP_PREFIX)) return 'validation';
  return owner.stepId === STARTUP_PROBE_STEP_ID ? 'probe' : 'run';
}

/** The five kinds a run can end in, as `RunExitKind` declares them. */
const RUN_EXIT_KINDS = ['ok', 'timeout', 'memory', 'error', 'unavailable'] as const;

/**
 * The runner's exit kind reduced to those five.
 *
 * `parseResult` checks that `exitKind` is a string and stops there: narrowing
 * it would change what `execute` hands its callers, and every scorer reads
 * that value, so the union is a compile-time cast over a word the transport
 * chose. Anywhere the word is kept rather than branched on it goes through
 * here first: a label value is a series name the registry then holds for the
 * life of the process, and the row `feedback.service.ts` stores is read back
 * by the learner.
 */
export function boundedExitKind(exitKind: string): RunExitKind {
  return (RUN_EXIT_KINDS as readonly string[]).includes(exitKind) ? (exitKind as RunExitKind) : 'error';
}

/**
 * The wall clock a caller waited, including the queue behind the runner slots
 * and the fresh machine every job gets.
 *
 * `observedFrom` is a performance.now() reading rather than the wall clock the
 * result carries: a clock adjusted mid-job would otherwise observe a negative
 * duration, which a histogram's own `_sum` never recovers from.
 *
 * Wrapped, and deliberately silent: a registry that refuses a series must not
 * turn a learner's run into an outage, which is the one way an observation
 * could cost more than it is worth.
 */
function observeExecution(purpose: SandboxPurpose, outcome: RunExitKind, observedFrom: number): void {
  try {
    sandboxExecutionDuration.observe(
      { purpose, outcome: boundedExitKind(outcome) },
      Math.max(0, performance.now() - observedFrom) / 1000,
    );
  } catch {
    // Observation only; there is nothing to report and nobody to report it to.
  }
}

/* ------------------------------- the live preview ------------------------- */

/**
 * A non-200 from the runner over the socket, with the status kept.
 *
 * `/execute` only ever cared that something went wrong, but the preview routes
 * answer 404 for a session the runner has forgotten, 409 for one that is not
 * serving yet and 503 when every preview slot is taken: three different
 * things the door and the panel have to say differently, and a message string
 * is not something to parse them out of.
 */
export class SocketRunnerStatus extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`socket runner answered ${status}: ${body.slice(0, 500)}`);
  }

  /** What the runner put in `reason`, e.g. 'sessions-full', or null. */
  get reason(): string | null {
    try {
      const parsed: unknown = JSON.parse(this.body);
      const reason = (parsed as { reason?: unknown })?.reason;
      return typeof reason === 'string' ? reason : null;
    } catch {
      return null;
    }
  }
}

class LambdaHandlerRefusal extends Error {
  constructor() { super('lambda handler refused the request envelope'); }
}

/**
 * What "Run app" starts: the app-start envelope, exactly as the runner's
 * `/app/start` reads it.
 *
 * Nothing here is executable by the API's choosing: `service.command` and
 * `seed` come from the pack's own `preview` block, which the loader has already
 * checked down to argv[0] and the file argv[1] names, and the runner checks
 * again because the runner is the trust boundary.
 */
export interface SandboxAppJob {
  mode: 'preview';
  files: Record<string, string>;
  build?: { tool: 'esbuild'; entry: string; outfile: string; jsx: string };
  service: { command: string[]; portEnv: string; health: string };
  web: { root: string; html: string };
  env?: Record<string, string>;
  seed?: string[];
  ttlSeconds?: number;
  idleSeconds?: number;
  memoryMb?: number;
}

/**
 * What the runner answers about a live preview. Never the port, never a URL:
 * the capability and the door are entirely the API's business,
 * and a runner that returned a port would be a runner a browser could reach.
 */
export interface SandboxAppSession {
  id: string;
  /** 'starting' | 'ready' | 'failed' | 'stopped' | 'busy' | 'unavailable'. */
  status: string;
  message?: string | null;
  stopReason?: string | null;
  bundleOk?: boolean;
  startedAt?: string;
  readyAt?: string | null;
  expiresAt?: string;
  idleExpiresAt?: string;
  bytesServed?: number;
  console?: { stream: string; text: string; at: string }[];
  cursor?: number;
  /** Controller-confirmed teardown, independent of the learner app's status. */
  cleanupConfirmed?: boolean;
}

export type SandboxAppOwnerLookup = { found: false; cleanupConfirmed: false }
  | { found: true; runnerId: string; cleanupConfirmed: boolean };

/** One request from the learner's own browser to the learner's own API. */
export interface SandboxAppAnswer {
  status: number;
  headers: Record<string, string>;
  /** The exact bytes. `Set-Cookie` is already gone: the runner strips it too. */
  body: Buffer;
  /** True when the app's answer was longer than the runner will carry. */
  truncated: boolean;
}

/** One file out of the learner's built front end. */
export interface SandboxAppAsset {
  status: number;
  contentType: string;
  /** The exact bytes, which is what the door writes to the browser. */
  bytes: Buffer;
  /**
   * The same bytes as text, for a caller that wants to read the document (the
   * content checker asserts the pack's own marker is in its own HTML). A getter
   * rather than a field: the front-end bundle is more than a megabyte and the
   * door, which is the hot path, never looks at it.
   */
  readonly body: string;
}

/**
 * Why a preview could not be reached, as the panel reads it. `busy` is other
 * people's previews, `unavailable` is a transport that cannot preview at all;
 * both are outages rather than verdicts, exactly as RunResult's own
 * `unavailable` is.
 */
export class PreviewTransportError extends Error {
  constructor(
    readonly kind: 'busy' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** How long a lazily-started local preview runner has to answer on its socket. */
const LOCAL_PREVIEW_BOOT_MS = 15_000;

/** How often the boot wait asks the local preview runner whether it is serving. */
const LOCAL_PREVIEW_POLL_MS = 250;

/** How long a stopping local preview runner has to stop its sessions and exit. */
const LOCAL_PREVIEW_EXIT_GRACE_MS = 3_000;

/** One `/health` question to a runner socket; a runner slower than this is treated as absent. */
const RUNNER_HEALTH_TIMEOUT_MS = 2_000;

/**
 * How long a local preview runner stays up with nothing to do. Two minutes is
 * long enough to span the gap between one learner's previews and short enough
 * that a runner nobody killed is gone before anybody looks for it.
 */
const LOCAL_PREVIEW_IDLE_EXIT_SECONDS = 120;

/**
 * On top of PREVIEW_BUILD_SECONDS, for the seed (20 s in the runner) and for
 * writing a 26-file workspace to disk. `/app/start` answers as soon as the
 * child is spawned, so this is a bound on the build and the seed, not on the
 * app coming up.
 */
export const PREVIEW_START_HEADROOM_SECONDS = 40;

/** Status and stop: one small read or one kill, on a runner that is right there. */
const PREVIEW_CONTROL_TIMEOUT_MS = 10_000;

/** On top of PREVIEW_REQUEST_TIMEOUT_MS, so the runner's own timeout is the one that fires. */
const PREVIEW_PROXY_HEADROOM_MS = 5_000;

/**
 * A session id in a log line. Not the capability (that never leaves the
 * preview service), but an id is still a handle to one learner's session, and
 * the first eight characters are enough to follow one through a log.
 */
const loggableId = (id: string): string => (id ? `${id.slice(0, 8)}…` : 'none');

/**
 * Whether the pre-baked dependency layer is on this machine.
 *
 * Without it every learner's every run comes back `errored` with an import
 * error and the product looks broken rather than misconfigured, so the answer
 * is published on /health/ready and logged once at boot. `unknown` until the
 * probe has run: the probe is started at boot and not waited for, because a
 * page that is not a run must still be served while it happens.
 */
export type PrebakeStatus = 'unknown' | 'ok' | 'missing' | 'stale';

let prebake: PrebakeStatus = 'unknown';
let prebakeDetail = 'the pre-baked dependency layer has not been probed yet';

export type RunnerIsolationStatus = { status: 'ok' | 'unknown' | 'unsupported'; mechanism: 'landlock' | 'single-job-microvm' | 'none' | 'unknown' };
let localIsolation: RunnerIsolationStatus = { status: 'unknown', mechanism: 'unknown' };
/** The socket runner's own report, as the health probe last read it. */
let socketIsolation: RunnerIsolationStatus = { status: 'unknown', mechanism: 'unknown' };
export function runnerIsolationStatus(): RunnerIsolationStatus { return { ...localIsolation }; }
/**
 * What a runner last said about its kernel boundary, for the transport it
 * came from: the local runner's answer to a job, or the socket runner's
 * `/health`. `previewUnsupported` reads it, so a host whose runner refuses all
 * learner code says so on the Preview tab too.
 */
export function noteRunnerIsolation(transport: 'local' | 'socket', status: RunnerIsolationStatus): void {
  if (transport === 'local') localIsolation = { ...status };
  else socketIsolation = { ...status };
}
export function parseRunnerIsolation(value: unknown): RunnerIsolationStatus {
  const candidate = value as Partial<RunnerIsolationStatus> | null;
  if (candidate?.status === 'ok' && (candidate.mechanism === 'landlock' || candidate.mechanism === 'single-job-microvm')) {
    return { status: 'ok', mechanism: candidate.mechanism };
  }
  if (candidate?.status === 'unsupported' && candidate.mechanism === 'none') return { status: 'unsupported', mechanism: 'none' };
  return { status: 'unknown', mechanism: 'unknown' };
}

/** The last thing the boot probe learned. See PrebakeStatus. */
export function prebakeStatus(): { status: PrebakeStatus; detail: string } {
  return { status: prebake, detail: prebakeDetail };
}

/**
 * Why this deployment cannot run a learner's application, or null when it can.
 *
 * Here rather than in the preview module because it is a fact about the
 * transport, and two callers need it before any session exists: the phase
 * detail, so the Preview tab can say so the moment it is drawn, and the
 * preview service, so a start refuses without touching a socket.
 */
export function previewUnsupported(): PreviewUnsupported {
  if (config.runnerMode === 'lambda') return 'lambda-runner';
  if (!config.previewEnabled) return 'disabled';
  // A runner that has reported it cannot isolate
  // learner code runs none of it, an app included. Only a report of
  // `unsupported` refuses; `unknown` (no probe answered yet) does not, so a
  // healthy host is never turned away before its first answer.
  const isolation = config.runnerMode === 'local' ? localIsolation : socketIsolation;
  if (isolation.status === 'unsupported') return 'isolation';
  return null;
}

/** The sentence the runner answers with when nothing is baked. */
export const PREBAKE_MISSING_MESSAGE =
  'The sandbox dependencies are not built on this machine. Run npm run prebake.';

/**
 * Executes untrusted learner code through the sandbox runner.
 *
 * One JSON contract, three transports (the runner stays behind an
 * interface): RUNNER_MODE=local spawns runner/sandbox_runner.py as a child
 * of this process (development only: same uid, network and /proc as the
 * API, so refused in production); RUNNER_MODE=socket POSTs the job over a
 * UNIX socket to runner/serve.py running in its own container with no
 * network and no secrets (the compose production path); RUNNER_MODE=lambda
 * invokes the runner Lambda (runner/lambda_handler.py) through the AWS API:
 * real AWS in production or LocalStack for full-fidelity local/CI
 * verification. Static analysis is trusted platform code and always runs
 * locally.
 */
@Injectable()
export class SandboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxService.name);
  private lambdaClient: LambdaClient | null = null;

  /**
   * Every sandbox run in the process passes through one gate sized to
   * RUNNER_SLOTS: the number of sandbox children the runner container is
   * provisioned for, which is not the number of *jobs* a worker takes on
   * (JOB_CONCURRENCY). One job makes several runs one after another, and the
   * incident drill runs the container straight off the request path, so the
   * cap has to sit at the runner call and has to carry that headroom.
   * Static: one process, one runner, so one gate however many services hold a
   * SandboxService. The wait is bounded by RunGate's own defaults.
   */
  private static readonly gate = new RunGate(Math.max(1, config.runnerSlots));

  /**
   * The second gate: live previews, sized to
   * PREVIEW_SESSIONS.
   *
   * A preview is a run of a different shape: it builds a bundle, seeds a
   * database and then leaves a process running for up to ten minutes, so it
   * passes the gate above (it is a sandbox child like any other) and this one
   * as well, which is the API's half of a bound the runner also enforces. Two
   * halves because the API's gate is per API process and the runner's is per
   * runner, the same reason docker-compose.yml pins RUNNER_SLOTS on both
   * services. Static for the same reason the gate above is.
   */
  private static readonly previewGate = new RunGate(Math.max(1, config.previewSessions));

  /** The lazily-started local preview runner, and the promise that starts it once. */
  private static localPreviewRunner: Promise<string | null> | null = null;
  private static localPreviewChild: ChildProcess | null = null;

  /** The boot probe, kept so shutdown can wait for it rather than log through a closed app. */
  private probing: Promise<void> | null = null;

  /**
   * Ask the sandbox, once at boot, whether the pre-baked dependency layer is
   * here.
   *
   * Started and not awaited: a machine with no layer must still serve every
   * page that is not a run, and the probe spawns an interpreter. What it buys
   * is one named line in the log and a component on /health/ready, instead of
   * every learner's first submission coming back `errored` with a
   * ModuleNotFoundError nobody can act on.
   */
  onModuleInit(): void {
    // Jest boots this container in most of the API's suites and each boot
    // would spawn an interpreter for an answer no test reads. The probe itself
    // is proved by sandbox.service.spec.ts, which calls it directly.
    if (config.nodeEnv === 'test' && !resolvePrebakeProbeInTests()) return;
    this.probing = this.probePrebake();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.probing) await this.probing.catch(() => undefined);
    const child = SandboxService.localPreviewChild;
    if (child) {
      // SIGTERM and not SIGKILL: serve.py stops every live preview session in
      // its own `finally`, and a killed runner would leave the learner's app
      // running with nothing left that knows about it.
      SandboxService.localPreviewChild = null;
      SandboxService.localPreviewRunner = null;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, LOCAL_PREVIEW_EXIT_GRACE_MS);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * One trivial job that imports what the packs declare. `missing` is the
   * runner's own sentence naming `npm run prebake`; `stale` is a layer that is
   * there but cannot be imported, which is what a half-finished pre-bake or a
   * drifted pin looks like.
   */
  async probePrebake(): Promise<void> {
    let owner: SandboxTraceOwner;
    try {
      owner = startupProbeOwner();
    } catch {
      prebake = 'unknown';
      prebakeDetail = 'dependency probe refused because the platform startup identity is invalid';
      this.logger.warn(prebakeDetail);
      return;
    }
    const run = await this.execute({
      files: {
        'tests/test_probe.py': 'import flask, pytest\n\n\ndef test_probe():\n    assert True\n',
      },
      mode: 'tests',
      testPaths: ['tests'],
      language: 'python',
      harness: 'pytest',
    }, owner);
    if (run.stderr && run.stderr.includes(PREBAKE_MISSING_MESSAGE)) {
      prebake = 'missing';
      prebakeDetail = PREBAKE_MISSING_MESSAGE;
      this.logger.error(PREBAKE_MISSING_MESSAGE);
      return;
    }
    if (run.exitKind === 'unavailable') {
      prebake = 'unknown';
      prebakeDetail = localIsolation.status === 'unsupported'
        ? 'dependency probe not executed because kernel isolation is unsupported'
        : 'the runner did not answer the pre-bake probe';
      this.logger.warn(prebakeDetail);
      return;
    }
    const errored = run.tests?.cases?.filter((c) => c.status === 'errored') || [];
    if (!run.ok || errored.length) {
      prebake = 'stale';
      prebakeDetail = errored[0]?.message || run.stderr?.slice(0, 200) || 'the probe job did not pass';
      this.logger.error(
        `the pre-baked dependency layer is here but does not import: ${prebakeDetail}. Run npm run prebake.`,
      );
      return;
    }
    prebake = 'ok';
    prebakeDetail = `flask and pytest import in ${run.durationMs} ms`;
  }

  private lambda(): LambdaClient {
    if (!this.lambdaClient) {
      this.lambdaClient = new LambdaClient({
        region: config.awsRegion,
        ...(config.awsEndpointUrl
          ? {
              endpoint: config.awsEndpointUrl,
              credentials: resolveLocalAwsCredentials(),
            }
          : {}),
      });
    }
    return this.lambdaClient;
  }

  private async invokeLambda(payload: unknown, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.lambda().send(
        new InvokeCommand({
          FunctionName: config.lambdaFunction,
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
        { abortSignal: controller.signal },
      );
      if (response.FunctionError) {
        const detail = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : '';
        throw new Error(`lambda runner error: ${response.FunctionError} ${detail.slice(0, 500)}`);
      }
      if (!response.Payload) throw new Error('lambda runner returned an empty payload');
      const raw = Buffer.from(response.Payload).toString('utf-8');
      // lambda_handler.py answers a job it will not run (a preview, a job it
      // cannot read) with `{error}` rather than a function error, so that a
      // caller's mistake is not a spike on the function's metrics. It is
      // still no result: `parseResult` would refuse it as "runner returned no
      // result: {…}", which hides the one line that says why. Named here so
      // the log reads the handler's own sentence.
      // A result the runner could not run (`exitKind: 'unavailable'` with
      // its sentence in `stderr`) is not an envelope and passes through
      // untouched: that sentence is the one the learner reads.
      const refusal = SandboxService.handlerRefusal(raw);
      if (refusal) throw new LambdaHandlerRefusal();
      return raw;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The handler's `{error: string}` envelope, or null for anything else. */
  private static handlerRefusal(raw: string): string | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
        return (parsed as { error: string }).error.slice(0, 200);
      }
    } catch {
      // not JSON: parseResult says so
    }
    return null;
  }

  /**
   * One POST to the runner over a UNIX socket, whatever the route.
   *
   * `/execute` runs jobs, and the live preview has five more routes
   * (`/app/start`, `/app/status`, `/app/stop`, `/app/proxy`, `/app/asset`),
   * which speak the same JSON over the same socket and need the same timeout
   * teardown, the same status handling and the same error sentence naming the
   * path. `socketPath` is an argument rather than `config.runnerSocket` because
   * on RUNNER_MODE=local the preview lives behind a private socket of its own
   * (see previewSocket) while jobs still run as a child process.
   */
  private socketRequest(
    route: string,
    payload: unknown,
    timeoutMs: number,
    socketPath: string = config.runnerSocket,
    trace?: SandboxTraceOwner & { attemptId: string },
  ): Promise<string> {
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: route,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': body.length,
            ...(trace ? { 'x-learnsdlc-trace': JSON.stringify(trace) } : {}) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== 200) {
              reject(new SocketRunnerStatus(res.statusCode || 0, text));
            } else {
              resolve(text);
            }
          });
          res.on('error', reject);
        },
      );
      // 'timeout' only fires the event; the request has to be torn down by
      // hand, and destroying it surfaces as 'error' below.
      req.on('timeout', () => req.destroy(new Error('socket runner timed out')));
      req.on('error', (err) =>
        reject(err instanceof SocketRunnerStatus ? err : new Error(`socket runner (${socketPath}): ${err.message}`)),
      );
      req.end(body);
    });
  }

  private runPython(script: string, payload: unknown, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(config.pythonBin, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('sandbox harness timed out'));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`sandbox harness exited ${code}: ${stderr.slice(0, 2000)}`));
        } else {
          resolve(stdout);
        }
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  /**
   * Parse what the transport handed back, refusing anything that is not a
   * result. A truncated body or an error envelope is valid JSON, and casting
   * it to RunResult would hand the caller a verdict with `ok: undefined`:
   * a transport failure wearing a grade's clothes, which is exactly what
   * `unavailable` exists to prevent.
   */
  private static parseResult(raw: string): RunResult {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as RunResult).ok !== 'boolean' ||
      typeof (parsed as RunResult).exitKind !== 'string'
    ) {
      throw new Error(`runner returned no result: ${raw.slice(0, 200)}`);
    }
    // Transport metadata is private. Do not spread controller/guest fields
    // into durable learner results, exports or websocket responses.
    const { ok, exitKind, stdout, stderr, durationMs, tests } = parsed as RunResult;
    return { ok, exitKind, stdout, stderr, durationMs, ...(tests ? { tests } : {}) };
  }

  async execute(job: SandboxJob, owner?: SandboxTraceOwner): Promise<RunResult> {
    const trace = owner ? { ...owner, attemptId: randomUUID() } : undefined;
    const payload = {
      ...job,
      timeoutSeconds: config.runTimeoutSeconds,
      memoryMb: config.runMemoryMb,
    };
    const harnessTimeoutMs = sandboxHarnessTimeoutMs();
    const startedAt = Date.now();
    // The measurement keeps its own monotonic reading. `startedAt` is what the
    // unavailable result carries to the learner and must not move.
    const observedFrom = performance.now();
    const purpose = executionPurpose(owner);
    try {
      const raw = await SandboxService.gate.run(() =>
        config.runnerMode === 'lambda'
          ? this.invokeLambda(payload, harnessTimeoutMs)
          : config.runnerMode === 'socket'
            ? this.socketRequest('/execute', payload, harnessTimeoutMs, config.runnerSocket, trace)
            : this.runPython(
                path.join(config.runnerDir, 'sandbox_runner.py'),
                payload,
                harnessTimeoutMs,
              ),
      );
      if (config.runnerMode === 'local') {
        noteRunnerIsolation('local', parseRunnerIsolation((JSON.parse(raw) as { isolation?: unknown }).isolation));
      }
      const result = SandboxService.parseResult(raw);
      observeExecution(purpose, result.exitKind, observedFrom);
      return result;
    } catch (err) {
      // Everything that lands here means the same thing: the sandbox never
      // returned a verdict about this code. Reporting it as `exitKind:
      // 'error'` made an outage indistinguishable from a learner's failing
      // program, so a runner being down was graded as the learner failing the
      // rubric and cost them an attempt. `unavailable` is the outcome
      // callers branch on instead; stdout and stderr stay empty because the
      // only message we have here is the transport's, and it names the socket
      // path, the Lambda function or the harness's own stack.
      const category = err instanceof SocketRunnerStatus ? 'runner-status-' + err.status
        : err instanceof LambdaHandlerRefusal ? 'lambda-handler-refusal' : 'transport-unavailable';
      this.logger.error(`sandbox execution failed (${config.runnerMode}); category=${category}`);
      const result: RunResult = {
        ok: false,
        exitKind: 'unavailable',
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
      };
      // After the result is built, so the `durationMs` it carries is still
      // measured at the same point in the flow, off the same clock, as it
      // always was.
      observeExecution(purpose, result.exitKind, observedFrom);
      return result;
    }
  }

  /* ----------------------------- the live preview ------------------------- */

  /**
   * The socket a preview lives behind, or null when this deployment cannot
   * run one.
   *
   * In RUNNER_MODE=socket it is the runner's own socket: `/execute` and
   * `/app/*` are two contracts on one server. In local mode there is nothing
   * listening: that transport spawns a fresh sandbox_runner.py per job, and a
   * preview has to outlive a job, so one serve.py of our own is started here,
   * once, on a private socket beside the database, and killed on shutdown. On
   * Lambda there is nowhere for an app to keep running at all, which is how
   * "preview is unavailable here" reaches the panel.
   */
  async previewSocket(): Promise<string | null> {
    if (!config.previewEnabled) return null;
    if (config.runnerMode === 'socket') return config.runnerSocket;
    // The three transports, decided rather than fallen through. `local` is the
    // only one left that can hold a process, and treating "not socket" as
    // "local" would have this spawn a runner on the Lambda transport if
    // PREVIEW_ENABLED were ever true there, which it is not, by construction,
    // and that is exactly the kind of thing that stops being true.
    if (config.runnerMode !== 'local') return null;
    // One in-flight promise, so forty simultaneous starts spawn one process.
    if (!SandboxService.localPreviewRunner) {
      SandboxService.localPreviewRunner = this.startLocalPreviewRunner().catch((err) => {
        this.logger.error(`local preview runner: ${(err as Error).message}`);
        return null;
      });
      // A failed attempt is not remembered: an operator who fixes the machine
      // should not have to restart the API to get a preview back.
      void SandboxService.localPreviewRunner.then((path) => {
        if (!path) SandboxService.localPreviewRunner = null;
      });
    }
    return SandboxService.localPreviewRunner;
  }

  /**
   * Start (or adopt) one runner/serve.py listening on config.previewSocket.
   *
   * Adopt first: serve.py refuses to bind a socket another runner is already
   * serving, and an operator who started one by hand, or an API that was
   * restarted while its child outlived it, should be used rather than
   * fought with.
   */
  private async startLocalPreviewRunner(): Promise<string | null> {
    const socketPath = config.previewSocket;
    const found = await this.localRunnerHealth(socketPath);
    if (found === 'serving') {
      this.logger.log(`live preview: using the runner already serving ${socketPath}`);
      return socketPath;
    }
    // A runner that answers and says it cannot isolate learner
    // code is not a socket to fight over: spawning a second one beside it
    // only waits out the boot deadline. Its report is already noted, so
    // `previewUnsupported()` says why, straight away.
    if (found === 'cannot-isolate') return null;
    fs.mkdirSync(path.dirname(socketPath) || '.', { recursive: true });
    const script = path.join(config.runnerDir, 'serve.py');
    // Declared before the spawn so the exit handler can name it, and removed
    // by the child's own 'exit' so a long-lived process does not accumulate
    // one listener per restart.
    const reap = (): void => {
      SandboxService.localPreviewChild?.kill('SIGTERM');
    };
    const child = spawn(config.pythonBin, [script], {
      env: {
        ...process.env,
        RUNNER_SOCKET: socketPath,
        // The API's own numbers, so the two halves of every bound agree. The
        // runner reads them fresh on each session (app_session.limits), and a
        // runner that disagreed with the API about the idle cap would stop a
        // session the panel still thought was live.
        PREVIEW_SESSIONS: String(config.previewSessions),
        PREVIEW_MEMORY_MB: String(config.previewMemoryMb),
        PREVIEW_IDLE_SECONDS: String(config.previewIdleSeconds),
        PREVIEW_MAX_SECONDS: String(config.previewMaxSeconds),
        PREVIEW_BOOT_SECONDS: String(config.previewBootSeconds),
        PREVIEW_BUILD_SECONDS: String(config.previewBuildSeconds),
        PREVIEW_MAX_BYTES: String(config.previewMaxBytes),
        PREVIEW_REQUEST_TIMEOUT_MS: String(config.previewRequestTimeoutMs),
        // This runner belongs to this process, and this process is not always
        // the thing that ends cleanly: a killed test run, a Ctrl-C'd CLI, a
        // jest worker whose sandboxed `process` never fires an exit handler.
        // So the child is also told to stop itself once nobody is using it and
        // no preview is live. It costs a quarter of a second to start again,
        // and `previewSocket` adopts one that is still answering.
        RUNNER_IDLE_EXIT_SECONDS: String(LOCAL_PREVIEW_IDLE_EXIT_SECONDS),
      },
      // serve.py writes only to stderr; an unread stdout pipe is a buffer
      // waiting to block the child.
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    SandboxService.localPreviewChild = child;
    let died: string | null = null;
    child.on('exit', (code, signal) => {
      died = `serve.py exited ${signal || code}`;
      process.off('exit', reap);
      if (SandboxService.localPreviewChild === child) {
        SandboxService.localPreviewChild = null;
        SandboxService.localPreviewRunner = null;
      }
    });
    // At warn, not debug: the two sentences this child ever writes are "I am
    // serving" and why it could not, and the second one is the whole diagnosis
    // when a preview does not start.
    child.stderr.on('data', (chunk: Buffer) => this.logger.warn(`runner: ${String(chunk).trim()}`));
    // Neither the child nor its pipe keeps this process alive, and the child
    // does not outlive it either.
    //
    // Both halves are needed, the first because not every holder of a
    // SandboxService has a Nest lifecycle to close it. The content checker
    // constructs one directly, and without the unref its `preview-starts`
    // check would leave a runner behind that keeps the API test suite from
    // exiting ("Jest did not exit one second after the test run has completed").
    child.unref();
    // The pipe is a socket under the stream; unref it the same way.
    (child.stderr as unknown as { unref?: () => void }).unref?.();
    process.once('exit', reap);

    const deadline = Date.now() + LOCAL_PREVIEW_BOOT_MS;
    while (Date.now() < deadline) {
      if (died) throw new Error(`${died} while starting the live preview on ${socketPath}`);
      const health = await this.localRunnerHealth(socketPath);
      if (health === 'serving') {
        this.logger.log(`live preview: runner on ${socketPath} (pid ${child.pid})`);
        return socketPath;
      }
      if (health === 'cannot-isolate') {
        this.logger.warn(`live preview: the runner on ${socketPath} cannot isolate learner code; no preview runs here`);
        child.kill('SIGTERM');
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCAL_PREVIEW_POLL_MS));
    }
    child.kill('SIGTERM');
    throw new Error(`the preview runner did not answer on ${socketPath} within ${LOCAL_PREVIEW_BOOT_MS / 1000} seconds`);
  }

  /**
   * The same question `serve.py --check` asks, asked from here rather than by
   * spawning an interpreter for each of sixty polls.
   *
   * serve.py's `/health` carries its own isolation report, and its `ok` is
   * false on a host that cannot confine learner code (macOS). That report is
   * the same machine's answer a local job run gives, so it is noted for the
   * local transport: `previewUnsupported()` then says
   * "isolation" rather than the preview waiting out the boot deadline and
   * calling the runner unreachable. An `unknown` report changes nothing.
   */
  private localRunnerHealth(socketPath: string): Promise<'serving' | 'cannot-isolate' | 'absent'> {
    return new Promise((resolve) => {
      const req = http.request(
        { socketPath, path: '/health', method: 'GET', timeout: RUNNER_HEALTH_TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { ok?: unknown; isolation?: unknown } | null;
              if (res.statusCode !== 200) return resolve('absent');
              const isolation = parseRunnerIsolation(body?.isolation);
              if (isolation.status !== 'unknown') noteRunnerIsolation('local', isolation);
              if (body?.ok === true) return resolve('serving');
              resolve(isolation.status === 'unsupported' ? 'cannot-isolate' : 'absent');
            } catch {
              resolve('absent');
            }
          });
          res.on('error', () => resolve('absent'));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve('absent'));
      req.end();
    });
  }

  /**
   * One `/app/*` call, with the two things every caller needs: the socket this
   * deployment previews behind, and a refusal that says which kind of "no" it
   * was. A transport that is absent is `unavailable`; a runner with no free
   * session is `busy`; everything else is the runner's own status, which the
   * caller reads off `SocketRunnerStatus`.
   */
  private async appRequest(route: string, payload: unknown, timeoutMs: number, trace?: SandboxTraceOwner & { attemptId: string }): Promise<unknown> {
    const socketPath = await this.previewSocket();
    if (!socketPath) {
      throw new PreviewTransportError(
        'unavailable',
        config.previewEnabled
          ? 'this deployment has no preview transport'
          : 'live preview is turned off on this deployment',
      );
    }
    try {
      return JSON.parse(await this.socketRequest(route, payload, timeoutMs, socketPath, trace));
    } catch (err) {
      if (err instanceof SocketRunnerStatus) {
        if (err.status === 503) throw new PreviewTransportError('busy', err.reason || 'runner busy');
        throw err;
      }
      this.logger.error(`preview ${route} failed; category=transport-unavailable`);
      throw new PreviewTransportError('unavailable', 'The preview runner is unavailable. Your saved work is unchanged.');
    }
  }

  /**
   * Build the front end, seed the database and start the learner's own API.
   *
   * Through both gates, and through them only for the call: the runner
   * releases its own pool slot before the readiness probe, and holding one
   * here for the life of a session would let two previews starve a class of
   * thirty.
   *
   * Never throws. A transport that cannot preview and a runner with no free
   * session are outcomes the panel draws (`unavailable` and `busy`) for the
   * same reason `execute` answers `unavailable` instead of raising: an outage
   * is not a verdict about the learner's code.
   */
  async startApp(job: SandboxAppJob, owner?: SandboxTraceOwner): Promise<SandboxAppSession> {
    const timeoutMs = (config.previewBuildSeconds + PREVIEW_START_HEADROOM_SECONDS) * 1000;
    try {
      const answer = await SandboxService.gate.run(() =>
        SandboxService.previewGate.run(() => this.appRequest('/app/start', job, timeoutMs, owner ? { ...owner, attemptId: randomUUID() } : undefined)),
      );
      return answer as SandboxAppSession;
    } catch (err) {
      return this.appFailure('', err);
    }
  }

  /**
   * Where a session is now, and what it has printed since `cursor`.
   *
   * No gate: a poll every two seconds while an app boots must not queue behind
   * the class's grading, and it is one small read on the runner's side.
   */
  async statusApp(id: string, cursor = 0): Promise<SandboxAppSession> {
    try {
      const answer = await this.appRequest('/app/status', { id, cursor }, PREVIEW_CONTROL_TIMEOUT_MS);
      return answer as SandboxAppSession;
    } catch (err) {
      // 404 is the one status this method answers rather than reports: the
      // runner forgets a stopped session a minute after it stops, and "it is
      // not running any more" is exactly what the caller wanted to know.
      if (err instanceof SocketRunnerStatus && err.status === 404) {
        return { id, status: 'stopped', message: null, console: [], cursor, cleanupConfirmed: false };
      }
      return this.appFailure(id, err);
    }
  }

  /** Private controller reconciliation after a lost start response. Absence
   * cannot release capacity: an older in-flight request may still arrive. */
  async lookupAppOwner(ownerId: string): Promise<SandboxAppOwnerLookup> {
    const answer = await this.appRequest('/operation/owner', { kind: 'preview', ownerId }, PREVIEW_CONTROL_TIMEOUT_MS) as Partial<SandboxAppOwnerLookup>;
    if (answer?.found === false && answer.cleanupConfirmed === false) return { found: false, cleanupConfirmed: false };
    if (answer?.found === true && typeof answer.runnerId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(answer.runnerId)
      && typeof answer.cleanupConfirmed === 'boolean') {
      return { found: true, runnerId: answer.runnerId, cleanupConfirmed: answer.cleanupConfirmed };
    }
    throw new PreviewTransportError('unavailable', 'The preview operation could not be reconciled.');
  }

  /**
   * Stop a session. Best effort by design: a session the runner has already
   * swept, a runner that has gone away and a socket that never existed are all
   * "it is not running", and the reaper and the shutdown hook both call this
   * on rows they may have lost the race for.
   */
  async stopApp(id: string, reason = 'learner'): Promise<void> {
    try {
      await this.appRequest('/app/stop', { id, reason }, PREVIEW_CONTROL_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof SocketRunnerStatus && err.status === 404) return;
      this.logger.warn(`preview stop ${loggableId(id)}; category=transport-unavailable`);
    }
  }

  /**
   * One request from the learner's browser to the learner's own API.
   *
   * Throws rather than answers, unlike the three above: this one is a proxy,
   * and the door in front of it turns a 404 into its own 404 and a 409 into
   * the panel's "the app is not running". An answer with a status baked into
   * it would make those two indistinguishable from the app's own 404.
   */
  async proxyApp(
    id: string,
    method: string,
    at: string,
    headers: Record<string, string>,
    body?: Buffer,
  ): Promise<SandboxAppAnswer> {
    const answer = (await this.appRequest(
      '/app/proxy',
      {
        id,
        method,
        path: at,
        headers,
        ...(body && body.length ? { body: body.toString('base64') } : {}),
      },
      config.previewRequestTimeoutMs + PREVIEW_PROXY_HEADROOM_MS,
    )) as { status: number; headers?: Record<string, string>; body?: string; truncated?: boolean };
    return {
      status: answer.status,
      headers: answer.headers || {},
      body: Buffer.from(answer.body || '', 'base64'),
      truncated: !!answer.truncated,
    };
  }

  /**
   * One file out of the learner's built front end. `at` is relative to the
   * pack's `web.root`; an empty path is the app's own HTML.
   */
  async assetApp(id: string, at: string): Promise<SandboxAppAsset> {
    const answer = (await this.appRequest(
      '/app/asset',
      { id, path: at },
      config.previewRequestTimeoutMs + PREVIEW_PROXY_HEADROOM_MS,
    )) as { status: number; contentType?: string; body?: string };
    const bytes = Buffer.from(answer.body || '', 'base64');
    return {
      status: answer.status,
      contentType: answer.contentType || 'application/octet-stream',
      bytes,
      get body() {
        return bytes.toString('utf-8');
      },
    };
  }

  /** A refusal in the shape the panel reads, so no caller of the three above has to catch. */
  private appFailure(id: string, err: unknown): SandboxAppSession {
    if (err instanceof PreviewTransportError) {
      return { id, status: err.kind, message: err.message, console: [], cursor: 0 };
    }
    if (err instanceof SandboxBusyError) {
      return { id, status: 'busy', message: err.reason, console: [], cursor: 0 };
    }
    if (err instanceof SocketRunnerStatus) {
      // 400 is a job this runner will not run: a `node` service, an illegal
      // environment name. It is a fault in the pack, not in the machine, and
      // it reads as a failed start rather than as an outage.
      return { id, status: 'failed', message: err.reason || 'the runner refused this preview', console: [], cursor: 0 };
    }
    this.logger.error('preview call failed; category=transport-unavailable');
    return { id, status: 'unavailable', message: 'The preview runner is unavailable. Your saved work is unchanged.', console: [], cursor: 0 };
  }

  async analyze(
    files: Record<string, string>,
    targets: string[],
    language = 'python',
  ): Promise<AnalyzerReport> {
    const script = path.join(config.runnerDir, 'analyzer.py');
    try {
      const stdout = await this.runPython(script, { files, targets, language }, ANALYZER_TIMEOUT_MS);
      return JSON.parse(stdout) as AnalyzerReport;
    } catch (err) {
      this.logger.error(`analyzer failed: ${(err as Error).message}`);
      return {
        issues: [
          {
            path: targets[0] || '',
            line: 1,
            severity: 'error',
            rule: ANALYZER_UNAVAILABLE_RULE,
            message: 'Static analysis could not run for this submission.',
          },
        ],
        metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 0 },
      };
    }
  }
}
