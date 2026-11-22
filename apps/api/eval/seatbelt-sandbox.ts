import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AnalyzerReport, RunResult } from '@learnsdlc/shared';
import { ANALYZER_UNAVAILABLE_RULE } from '@learnsdlc/shared';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { config } from '../src/config';
import { ensureDir, repoRoot } from './io';

/**
 * Executable truth on a Mac without Docker and without running
 * model-written code bare.
 *
 * The product's own runner (`apps/api/runner/sandbox_runner.py`) and analyser
 * (`runner/analyzer.py`) run as they run in `RUNNER_MODE=local` (job JSON on
 * stdin, result JSON on stdout), but each job is one fresh process under macOS
 * `sandbox-exec` (Seatbelt) with:
 *   - **all network denied** (`(deny network*)`), loopback included;
 *   - **writes confined** to that job's own scratch directory (deleted after);
 *   - **exec refused** except the pinned Python, the pinned Node and the
 *     runner's baked runtime; LaunchServices (`open`) and Apple Events
 *     (`osascript`) refused;
 *   - **file contents unreadable anywhere under the user's home** except the
 *     two toolchains, and the credential folders, the evaluation tree and the
 *     repository's node_modules refused by name as well;
 *   - a **live preflight canary** (`seatbeltPreflight`) proves the fence before
 *     any job runs; if it fails, nothing runs;
 *   - an empty environment except PATH, HOME/TMPDIR (the job directory) and
 *     the runner's own settings: no AWS profile, no key, no token;
 *   - a hard wall-clock kill at 60 s.
 *
 * The runner refuses to execute without kernel isolation
 * (`isolation_status()`): on macOS it has no Landlock. Seatbelt is the kernel
 * fence here, so the wrapper (and only the wrapper, in its fixed environment)
 * tells the runner it is inside a single-job isolated environment
 * (`RUNNER_ISOLATION=single-job-microvm`), exactly as the trusted microVM
 * supervisor does. The runner's in-process defences (socket/exec/ctypes blocks,
 * rlimits, sealed graded files) all stay on. If `sandbox-exec` is missing the
 * sandbox reports `unavailable` and nothing runs.
 */

const SEATBELT_BIN = '/usr/bin/sandbox-exec';
const JOB_WALL_CLOCK_MS = 60_000;
/** The first of these on PATH, as an absolute path: Seatbelt allows exec by exact path. */
function onPath(names: string[]): string {
  for (const name of names) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
    }
  }
  return names[names.length - 1];
}
const PYTHON = process.env.EVAL_PYTHON || onPath(['python3.11', 'python3']);
const NODE = process.env.EVAL_NODE_BIN || process.execPath;

export function seatbeltAvailable(): boolean {
  return fs.existsSync(SEATBELT_BIN);
}

const q = (p: string) => JSON.stringify(p);

/**
 * The repository's own dependency trees are unreadable inside a job: in
 * production the runner image carries only the runner's baked
 * `runtime/node/node_modules`, and a job directory under the checkout would
 * otherwise resolve a second React (the web app's) by walking up the tree.
 */
function repoNodeModules(): string[] {
  const root = repoRoot();
  const out = [path.join(root, 'node_modules')];
  for (const sub of ['apps', 'packages']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const nm = path.join(dir, name, 'node_modules');
      if (fs.existsSync(nm)) out.push(nm);
    }
  }
  return out.flatMap((p) => [p, fs.realpathSync(p)]).filter((p, i, all) => all.indexOf(p) === i);
}

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };

/** The two toolchains a job may read and run from: the pinned Python's prefix and the pinned Node's. */
function toolchainRoots(): string[] {
  const roots = [path.dirname(path.dirname(real(PYTHON))), path.dirname(path.dirname(real(NODE)))];
  return roots.filter((p, i) => roots.indexOf(p) === i);
}

/**
 * The fence (the last matching rule wins, so the order matters):
 *   - network denied, loopback included;
 *   - exec denied except the pinned Python, the pinned Node and the runner's
 *     baked runtime (esbuild); LaunchServices (`open`) and Apple Events
 *     (`osascript`) denied, since both act outside the sandbox;
 *   - reading file contents anywhere under the user's home denied, except the
 *     two toolchains;
 *   - writes only to the job directory;
 *   - credentials, the evaluation folder and the repository's node_modules
 *     denied last, whatever an earlier allow said.
 */
export function seatbeltProfile(jobDir: string): string {
  const home = os.homedir();
  const jobReal = real(jobDir);
  const runtime = path.join(repoRoot(), 'apps', 'api', 'runner', 'runtime');
  const execs = [...new Set([PYTHON, real(PYTHON)])].map((p) => `(literal ${q(p)})`)
    .concat([...new Set([NODE, real(NODE)])].map((p) => `(literal ${q(p)})`))
    .concat([...new Set([runtime, real(runtime)])].map((p) => `(subpath ${q(p)})`));
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny process-exec)',
    `(allow process-exec ${execs.join(' ')})`,
    '(deny lsopen)',
    '(deny appleevent-send)',
    `(deny file-read-data (subpath ${q(home)}))`,
    `(allow file-read-data ${toolchainRoots().map((p) => `(subpath ${q(p)})`).join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(jobReal)}) (subpath ${q(jobDir)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))`,
    `(deny file-read* (subpath ${q(path.join(home, '.aws'))}) (subpath ${q(path.join(home, '.ssh'))}) (subpath ${q(path.join(home, '.config'))}) (subpath ${q(path.join(home, 'Library', 'Keychains'))}) (subpath ${q(path.join(repoRoot(), '.preview'))}))`,
    `(deny file-read* ${repoNodeModules().map((p) => `(subpath ${q(p)})`).join(' ')})`,
  ].join('\n');
}

export interface PreflightResult { ok: boolean; failures: string[]; checks: Record<string, boolean> }

let preflightCache: PreflightResult | null = null;

/**
 * A live canary under the exact profile, before any model-written code runs
 * (exec stage and derive). Each check passes only when the fence behaves:
 * reading a file created in $HOME fails, reading the real tree's .env fails,
 * exec of osascript and open fails, a TCP connect fails, and the pinned Python
 * and Node still start (Node also as a child of Python, as the runner starts it). Only exit codes are read; no content leaves a probe.
 * Any failure → executable truth is `not_run`.
 */
/**
 * SIGKILL a job: first every descendant of the fenced process, found by
 * walking the parent links the kernel reports (a child that called setsid()
 * leaves the group but keeps its parent), then the whole process group, then
 * the process itself. The kill list is derived only from the process tree,
 * never from anything the job could write. Residual: a process that
 * double-forks so that launchd adopts it escapes both walks; it stays behind
 * the fence (no network, writes only to the job directory, which is deleted)
 * and under the runner's own rlimits.
 */
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    let out = '';
    try { out = String(spawnSync('/usr/bin/pgrep', ['-P', String(parent)], { encoding: 'utf8', timeout: 5_000 }).stdout ?? ''); } catch { out = ''; }
    for (const line of out.split('\n')) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0 && child !== process.pid && !descendants.includes(child)) { descendants.push(child); queue.push(child); }
    }
  }
  for (const stray of descendants.reverse()) { try { process.kill(stray, 'SIGKILL'); } catch { /* gone */ } }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export async function seatbeltPreflight(scratch: string, options: { fresh?: boolean; profile?: (jobDir: string) => string } = {}): Promise<PreflightResult> {
  if (preflightCache && !options.fresh && !options.profile) return preflightCache;
  if (!seatbeltAvailable()) return { ok: false, failures: ['sandbox-exec unavailable'], checks: {} };
  const profileFor = options.profile ?? seatbeltProfile;
  const canary = path.join(os.homedir(), `.eval-seatbelt-canary-${randomUUID()}`);
  fs.writeFileSync(canary, 'canary', { mode: 0o600 });
  const realEnv = path.join(repoRoot(), '.env');
  const runIn = (argv: string[]): Promise<number | null> => {
    const jobDir = ensureDir(path.join(scratch, `preflight-${randomUUID()}`));
    return new Promise((resolve) => {
      const child = spawn(SEATBELT_BIN, ['-p', profileFor(jobDir), ...argv], { stdio: ['ignore', 'ignore', 'ignore'], cwd: jobDir, detached: true, env: { PATH: '/usr/bin:/bin', HOME: jobDir, TMPDIR: `${jobDir}/` } });
      const timer = setTimeout(() => killGroup(child.pid), 20_000);
      child.on('error', () => { clearTimeout(timer); fs.rmSync(jobDir, { recursive: true, force: true }); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); fs.rmSync(jobDir, { recursive: true, force: true }); resolve(code); });
    });
  };
  // Each refusal probe exits 0 only when the forbidden thing worked.
  const py = (code: string) => runIn([PYTHON, '-I', '-S', '-B', '-c', code]);
  // Exit 0 when the exec itself happened (whatever the program then did), 3 when the kernel refused it.
  const tryExec = (bin: string, args: string[]) => py(`import subprocess,sys\ntry:\n  subprocess.run([${JSON.stringify(bin)},${args.map((a) => JSON.stringify(a)).join(',')}],capture_output=True,timeout=10)\n  sys.exit(0)\nexcept Exception:\n  sys.exit(3)`);
  const tryRead = (file: string) => py(`import sys\ntry:\n  open(${JSON.stringify(file)},'rb').read(1)\n  sys.exit(0)\nexcept Exception:\n  sys.exit(3)`);
  try {
    const [pythonRuns, nodeRuns, homeRead, realTreeRead, osascriptExec, openExec, childNodeRuns, netConnect] = await Promise.all([
      py('pass'),
      runIn([NODE, '-e', '0']),
      tryRead(canary),
      fs.existsSync(realEnv) ? tryRead(realEnv) : Promise.resolve(3),
      tryExec('/usr/bin/osascript', ['-e', 'return 1']),
      // An unknown flag: if exec were allowed, open would only print usage, never launch anything.
      tryExec('/usr/bin/open', ['--eval-canary-unknown-flag']),
      py(`import subprocess,sys\nsys.exit(subprocess.run([${JSON.stringify(NODE)},'-e','0'],capture_output=True,timeout=15).returncode)`),
      py('import socket,sys\ntry:\n  socket.create_connection(("1.1.1.1",53),timeout=5)\n  sys.exit(0)\nexcept Exception:\n  sys.exit(3)'),
    ]);
    const checks: Record<string, boolean> = {
      pythonRuns: pythonRuns === 0,
      nodeRuns: nodeRuns === 0,
      homeRead: homeRead !== 0,
      realTreeRead: realTreeRead !== 0,
      osascriptExec: osascriptExec !== 0,
      openExec: openExec !== 0,
      childNodeRuns: childNodeRuns === 0,
      netConnect: netConnect !== 0,
    };
    const failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    const result = { ok: failures.length === 0, failures, checks };
    if (!options.profile) preflightCache = result;
    return result;
  } finally {
    fs.rmSync(canary, { force: true });
  }
}

export interface SeatbeltJobRecord {
  kind: 'tests' | 'smoke' | 'analyze';
  runId: string | null;
  exitKind: string;
  ok: boolean;
  total: number | null;
  passed: number | null;
  failed: number | null;
  errored: number | null;
  durationMs: number;
  killed: boolean;
}

export class SeatbeltSandbox {
  readonly jobs: SeatbeltJobRecord[] = [];
  constructor(private readonly scratch: string) {}

  private async run(script: string, payload: unknown): Promise<{ stdout: string; killed: boolean; code: number | null; ms: number }> {
    // No job runs behind a fence the canary has not proved (cached once per process).
    const preflight = await seatbeltPreflight(this.scratch);
    if (!preflight.ok) throw new Error('Seatbelt preflight failed');
    const jobDir = ensureDir(path.join(this.scratch, `job-${randomUUID()}`));
    const started = Date.now();
    return new Promise((resolve, reject) => {
      if (!seatbeltAvailable()) { reject(new Error('sandbox-exec is unavailable')); return; }
      const child = spawn(SEATBELT_BIN, ['-p', seatbeltProfile(jobDir), PYTHON, '-B', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: jobDir,
        // Its own process group, so the wall-clock kill below reaches every
        // process the job started, not only the runner.
        detached: true,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: jobDir,
          TMPDIR: `${jobDir}/`,
          RUNNER_ISOLATION: 'single-job-microvm',
          NODE_BIN: NODE,
          PYTHONDONTWRITEBYTECODE: '1',
          LANG: 'C.UTF-8',
        },
      });
      let stdout = '';
      let killed = false;
      const timer = setTimeout(() => { killed = true; killGroup(child.pid); }, JOB_WALL_CLOCK_MS);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', () => { /* never surfaced: it can carry paths */ });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        fs.rmSync(jobDir, { recursive: true, force: true });
        resolve({ stdout, killed, code, ms: Date.now() - started });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async execute(job: SandboxJob): Promise<RunResult> {
    const payload = { ...job, timeoutSeconds: config.runTimeoutSeconds, memoryMb: config.runMemoryMb };
    const kind = job.mode === 'smoke' ? 'smoke' : 'tests';
    const runId = (job as { runId?: string }).runId ?? null;
    try {
      const out = await this.run(path.join(repoRoot(), 'apps', 'api', 'runner', 'sandbox_runner.py'), payload);
      if (out.killed || out.code !== 0) throw Object.assign(new Error('runner did not finish'), { killed: out.killed, ms: out.ms });
      const result = JSON.parse(out.stdout) as RunResult & { isolation?: unknown };
      delete (result as { isolation?: unknown }).isolation;
      this.jobs.push({ kind, runId, exitKind: result.exitKind, ok: result.ok, total: result.tests?.total ?? null, passed: result.tests?.passed ?? null, failed: result.tests?.failed ?? null, errored: result.tests?.errored ?? null, durationMs: out.ms, killed: false });
      return result;
    } catch (error) {
      const killed = Boolean((error as { killed?: boolean }).killed);
      this.jobs.push({ kind, runId, exitKind: 'unavailable', ok: false, total: null, passed: null, failed: null, errored: null, durationMs: (error as { ms?: number }).ms ?? 0, killed });
      return { ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 0 };
    }
  }

  async analyze(files: Record<string, string>, targets: string[], language = 'python'): Promise<AnalyzerReport> {
    try {
      const out = await this.run(path.join(repoRoot(), 'apps', 'api', 'runner', 'analyzer.py'), { files, targets, language });
      if (out.killed || out.code !== 0) throw new Error('analyzer did not finish');
      this.jobs.push({ kind: 'analyze', runId: null, exitKind: 'ok', ok: true, total: null, passed: null, failed: null, errored: null, durationMs: out.ms, killed: false });
      return JSON.parse(out.stdout) as AnalyzerReport;
    } catch {
      this.jobs.push({ kind: 'analyze', runId: null, exitKind: 'unavailable', ok: false, total: null, passed: null, failed: null, errored: null, durationMs: 0, killed: false });
      return {
        issues: [{ path: targets[0] || '', line: 1, severity: 'error', rule: ANALYZER_UNAVAILABLE_RULE, message: 'Static analysis could not run for this submission.' }],
        metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 0 },
      } as AnalyzerReport;
    }
  }
}

