import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtService } from '@nestjs/jwt';
import {
  assertBindSafety,
  assertJwtSecretSet,
  assertProductionSecrets,
  config,
  JWT_SECRET_MISSING,
  hostParallelism,
  isLoopbackAddress,
  jwtSecretProblem,
  resolveBindAddress,
  resolveDefaultProject,
  resolveGoogleRedirectUrl,
  resolveQuizSeedSecret,
  resolveJobConcurrency,
  resolveJwtExpiresIn,
  resolveRunMigrations,
  resolveRunnerMode,
  resolveRunnerSlots,
  resolveRunnerWait,
  resolveRunnerTransportAllowance,
  resolvePasswordWork,
  resolveSchemaSync,
  resolveSignInMaxPerAddress,
  // The fairness cap on submissions in flight
  resolveSubmitInFlightPerLearner,
  // The live preview
  RUNNER_CONTAINER_MB,
  resolvePreviewEnabled,
  resolvePreviewSessions,
  resolvePreviewSocket,
  runnerContainerBudgetMb,
  // The Agentic edit-list flag
  AGENTIC_EDIT_LIST_MODES,
  agenticEditListAtLoad,
  resolveAgenticEditList,
  // The Agentic payload trim
  AGENTIC_PAYLOAD_MODES,
  agenticPayloadAtLoad,
  resolveAgenticPayload,
  // The grading fan-out
  assertGradingFanout,
  gradingFanoutAtLoad,
  resolveGradingRunFanout,
  resolveGradingSpeculativeMutants,
} from './config';

const env = (over: Record<string, string | undefined> = {}) => over as NodeJS.ProcessEnv;

/** A secret of the shape the runbook tells an operator to generate. */
const REAL_SECRET = 'q7C0nQ2m8yE4tR1vB6xZ3jK9wL5sP0aD2fG8hJ4kM6nQ8rT2u';

describe('bounded password work configuration', () => {
  it('uses a finite queue, total deadline and idle release by default', () => {
    expect(resolvePasswordWork(env())).toEqual({ passwordWorkQueueLimit: 64, passwordWorkTimeoutMs: 30_000, passwordWorkIdleMs: 30_000 });
  });
  it.each(['PASSWORD_WORK_QUEUE_LIMIT', 'PASSWORD_WORK_TIMEOUT_MS', 'PASSWORD_WORK_IDLE_MS'])('rejects malformed and unbounded %s', (key) => {
    for (const value of ['', '0', '-1', '1.5', 'Infinity', 'NaN', '30000ms', '999999999999999999999']) {
      expect(() => resolvePasswordWork(env({ [key]: value }))).toThrow(key);
    }
  });
  it('rejects out-of-range values and accepts both reviewed boundaries', () => {
    expect(() => resolvePasswordWork(env({ PASSWORD_WORK_QUEUE_LIMIT: '129' }))).toThrow('PASSWORD_WORK_QUEUE_LIMIT');
    for (const key of ['PASSWORD_WORK_TIMEOUT_MS', 'PASSWORD_WORK_IDLE_MS']) {
      for (const value of ['999', '60001']) expect(() => resolvePasswordWork(env({ [key]: value }))).toThrow(key);
    }
    expect(resolvePasswordWork(env({ PASSWORD_WORK_QUEUE_LIMIT: '1', PASSWORD_WORK_TIMEOUT_MS: '1000', PASSWORD_WORK_IDLE_MS: '60000' }))).toEqual({ passwordWorkQueueLimit: 1, passwordWorkTimeoutMs: 1000, passwordWorkIdleMs: 60000 });
    expect(resolvePasswordWork(env({ PASSWORD_WORK_QUEUE_LIMIT: '128' })).passwordWorkQueueLimit).toBe(128);
  });
});

describe('remote runner transport allowance', () => {
  it('keeps the local allowance at zero and accepts bounded cloud startup time', () => {
    expect(resolveRunnerTransportAllowance(env())).toBe(0);
    expect(resolveRunnerTransportAllowance(env({ RUNNER_TRANSPORT_ALLOWANCE_SECONDS: '60' }))).toBe(60);
    expect(resolveRunnerTransportAllowance(env({ RUNNER_TRANSPORT_ALLOWANCE_SECONDS: '120' }))).toBe(120);
  });
  it.each(['-1', '121', '1.5', 'Infinity', 'NaN', '60seconds', ''])('rejects an unsafe allowance %s', (value) => {
    expect(() => resolveRunnerTransportAllowance(env({ RUNNER_TRANSPORT_ALLOWANCE_SECONDS: value }))).toThrow('RUNNER_TRANSPORT_ALLOWANCE_SECONDS');
  });
});

describe('JWT duration configuration across the Nest upgrade', () => {
  it.each<[string | undefined, number]>([
    [undefined, 7 * 24 * 60 * 60],
    ['90m', 90 * 60],
    ['1.5h', 90 * 60],
    ['120000', 120],
  ])('preserves the signing lifetime for %s, including millisecond numeric strings', (value, seconds) => {
    const jwt = new JwtService({ secret: REAL_SECRET, signOptions: { expiresIn: resolveJwtExpiresIn(env({ JWT_EXPIRES_IN: value })) } });
    const claims = jwt.decode<{ iat: number; exp: number }>(jwt.sign({ sub: 'duration-probe', iat: 1_710_000_000 }));
    expect(claims.exp - claims.iat).toBe(seconds);
  });

  it('retains invalid-duration rejection instead of silently issuing a default-lived token', () => {
    const jwt = new JwtService({ secret: REAL_SECRET, signOptions: { expiresIn: resolveJwtExpiresIn(env({ JWT_EXPIRES_IN: 'invalid-duration' })) } });
    expect(() => jwt.sign({ sub: 'duration-probe' })).toThrow('expiresIn');
  });
});

describe('assertProductionSecrets', () => {
  const prod = (over: Record<string, string | undefined> = {}) =>
    env({ NODE_ENV: 'production', ...over });
  const complete = {
    JWT_SECRET: REAL_SECRET,
    ADMIN_EMAIL: 'ops@example.edu',
    ADMIN_PASSWORD: 'Correct-Horse-9',
  };

  it('allows any configuration outside production', () => {
    expect(() => assertProductionSecrets(env({ NODE_ENV: 'development' }))).not.toThrow();
    expect(() => assertProductionSecrets(env({}))).not.toThrow();
    expect(() => assertProductionSecrets(env({ NODE_ENV: 'development', RUNNER_MODE: 'local' }))).not.toThrow();
  });

  it('refuses to start in production with the in-process runner', () => {
    // The local runner executes learner code inside the API process: the
    // risk the socket runner exists to close. Production must fail
    // closed rather than quietly run it.
    expect(() => assertProductionSecrets(prod({ ...complete, RUNNER_MODE: 'local' }))).toThrow(
      /socket[\s\S]*lambda/,
    );
    expect(() => assertProductionSecrets(prod({ ...complete, RUNNER_MODE: 'socket' }))).not.toThrow();
  });

  it('refuses to start in production with no JWT secret', () => {
    const { JWT_SECRET: _omitted, ...rest } = complete;
    expect(() => assertProductionSecrets(prod(rest))).toThrow(/JWT_SECRET/);
  });

  it('refuses to start in production with the shipped development secret', () => {
    expect(() =>
      assertProductionSecrets(prod({ ...complete, JWT_SECRET: 'dev-secret-change-me-in-production' })),
    ).toThrow(/JWT_SECRET/);
  });

  it('refuses every published placeholder, not only the one constant in config.ts', () => {
    // scripts/setup.sh copies .env.example to .env and docker-compose.yml
    // reads it, so the value printed in the repository is a working admin
    // token signer everywhere the compose stack runs.
    for (const secret of ['change-me-in-production', 'changeme', 'secret', 'CHANGE-ME']) {
      expect(() => assertProductionSecrets(prod({ ...complete, JWT_SECRET: secret }))).toThrow(
        /JWT_SECRET/,
      );
    }
  });

  it('refuses a secret shorter than 32 bytes, published or not', () => {
    expect(() => assertProductionSecrets(prod({ ...complete, JWT_SECRET: 'a-real-secret' }))).toThrow(
      /JWT_SECRET/,
    );
    expect(() => assertProductionSecrets(prod({ ...complete, JWT_SECRET: 'x'.repeat(31) }))).toThrow(
      /JWT_SECRET/,
    );
    expect(() =>
      assertProductionSecrets(prod({ ...complete, JWT_SECRET: 'x'.repeat(32) })),
    ).not.toThrow();
  });

  it('refuses the JWT_SECRET this repository actually ships in .env.example', () => {
    // Read rather than restated: the point is that whatever that file carries
    // cannot be a working secret, however it is edited later.
    const file = path.resolve(__dirname, '..', '..', '..', '.env.example');
    const line = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('JWT_SECRET='));
    expect(line).toBeDefined();
    const shipped = (line as string).slice('JWT_SECRET='.length).split('#')[0].trim();
    expect(jwtSecretProblem(shipped)).not.toBeNull();
    expect(() => assertProductionSecrets(prod({ ...complete, JWT_SECRET: shipped }))).toThrow(
      /JWT_SECRET/,
    );
  });

  it('refuses to start in production without the first administrator', () => {
    const { ADMIN_EMAIL: _e, ADMIN_PASSWORD: _p, ...rest } = complete;
    expect(() => assertProductionSecrets(prod(rest))).toThrow(/ADMIN_EMAIL, ADMIN_PASSWORD/);
    expect(() => assertProductionSecrets(prod({ ...rest, ADMIN_EMAIL: 'ops@example.edu' }))).toThrow(
      /ADMIN_PASSWORD/,
    );
  });

  it('does not require SEED_PASSWORD: the demo accounts it protects need SEED_DEMO_ACCOUNTS', () => {
    expect(() => assertProductionSecrets(prod(complete))).not.toThrow();
  });

  it('refuses the local runner in production and points at the isolated transports', () => {
    expect(() => assertProductionSecrets(prod({ ...complete, RUNNER_MODE: 'local' }))).toThrow(
      /socket.*lambda/,
    );
    expect(() => assertProductionSecrets(prod({ ...complete, RUNNER_MODE: 'socket' }))).not.toThrow();
    expect(() => assertProductionSecrets(prod({ ...complete, RUNNER_MODE: 'lambda' }))).not.toThrow();
  });
});

describe('resolveRunnerMode', () => {
  it('never resolves to the local runner on its own, in any environment', () => {
    // The local runner executes a learner's code as a child of the API, with
    // this uid, this network and /proc access to this environment. Nothing
    // may arrive at it by omission: a start script that pinned
    // RUNNER_MODE=local would make the documented way to host a class hand
    // every learner a shell on the instructor's machine.
    for (const over of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { RUNNER_MODE: '' }]) {
      expect(resolveRunnerMode(env(over))).not.toBe('local');
    }
  });

  it('resolves an unset or unrecognised value to the socket runner, which fails closed', () => {
    expect(resolveRunnerMode(env({}))).toBe('socket');
    expect(resolveRunnerMode(env({ NODE_ENV: 'production' }))).toBe('socket');
    // A typo must not be the difference between a sandbox and a shell.
    expect(resolveRunnerMode(env({ RUNNER_MODE: 'Local' }))).toBe('socket');
    expect(resolveRunnerMode(env({ RUNNER_MODE: 'subprocess' }))).toBe('socket');
  });

  it('honours an explicit value in either environment', () => {
    expect(resolveRunnerMode(env({ RUNNER_MODE: 'lambda' }))).toBe('lambda');
    expect(resolveRunnerMode(env({ NODE_ENV: 'production', RUNNER_MODE: 'lambda' }))).toBe('lambda');
    expect(resolveRunnerMode(env({ RUNNER_MODE: 'local' }))).toBe('local');
    expect(resolveRunnerMode(env({ RUNNER_MODE: ' local ' }))).toBe('local');
  });
});

describe('the bind address, and what it makes unsafe', () => {
  it('binds loopback unless API_BIND says otherwise', () => {
    expect(resolveBindAddress(env({}))).toBe('127.0.0.1');
    expect(resolveBindAddress(env({ API_BIND: '' }))).toBe('127.0.0.1');
    expect(resolveBindAddress(env({ API_BIND: '0.0.0.0' }))).toBe('0.0.0.0');
  });

  it('knows which addresses only this machine can reach', () => {
    for (const address of ['127.0.0.1', '127.0.1.1', 'localhost', '::1', '[::1]', ' LocalHost '])
      expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ['0.0.0.0', '::', '192.168.1.14', '10.0.0.2', 'learn.example.edu'])
      expect(isLoopbackAddress(address)).toBe(false);
  });

  it('allows the local runner while nobody else can reach the API', () => {
    // The laptop demo, and the e2e suite. This is the path that has to keep
    // working, and the reason the check is about the bind and not NODE_ENV.
    expect(() => assertBindSafety(env({ RUNNER_MODE: 'local' }))).not.toThrow();
    expect(() =>
      assertBindSafety(env({ RUNNER_MODE: 'local', API_BIND: '127.0.0.1' })),
    ).not.toThrow();
  });

  it('refuses the local runner the moment the API is reachable', () => {
    expect(() => assertBindSafety(env({ RUNNER_MODE: 'local', API_BIND: '0.0.0.0' }))).toThrow(
      /RUNNER_MODE=local/,
    );
    expect(() =>
      assertBindSafety(env({ RUNNER_MODE: 'local', API_BIND: '192.168.1.14', JWT_SECRET: REAL_SECRET })),
    ).toThrow(/shell/);
  });

  it('refuses a reachable API with no real JWT_SECRET, whatever NODE_ENV says', () => {
    // A class-hosting laptop sets no NODE_ENV, so without this check
    // config.jwtSecret would fall back to the development secret published in
    // this repository while a cohort signs in over the network.
    expect(() => assertBindSafety(env({ API_BIND: '0.0.0.0' }))).toThrow(/JWT_SECRET/);
    expect(() =>
      assertBindSafety(env({ API_BIND: '0.0.0.0', JWT_SECRET: 'dev-secret-change-me-in-production' })),
    ).toThrow(/JWT_SECRET/);
    expect(() => assertBindSafety(env({ API_BIND: '0.0.0.0', JWT_SECRET: 'short' }))).toThrow(
      /JWT_SECRET/,
    );
    expect(() =>
      assertBindSafety(env({ API_BIND: '0.0.0.0', JWT_SECRET: REAL_SECRET })),
    ).not.toThrow();
  });

  it('leaves the loopback default alone: no secret is needed to run the demo', () => {
    expect(() => assertBindSafety(env({}))).not.toThrow();
    expect(() => assertBindSafety(env({ NODE_ENV: 'development' }))).not.toThrow();
  });
});

describe('migrations and schema sync', () => {
  it('runs migrations in production unless explicitly told not to', () => {
    expect(resolveRunMigrations(env({ NODE_ENV: 'production' }))).toBe(true);
    expect(resolveRunMigrations(env({ NODE_ENV: 'production', RUN_MIGRATIONS: 'false' }))).toBe(false);
    expect(resolveRunMigrations(env({ NODE_ENV: 'production', RUN_MIGRATIONS: 'true' }))).toBe(true);
  });

  it('auto-syncs the schema only in development without migrations', () => {
    expect(resolveRunMigrations(env({}))).toBe(false);
    expect(resolveSchemaSync(env({}))).toBe(true);
    expect(resolveSchemaSync(env({ RUN_MIGRATIONS: 'true' }))).toBe(false);
  });

  it('never turns schema sync on in production, even with migrations off', () => {
    expect(resolveSchemaSync(env({ NODE_ENV: 'production' }))).toBe(false);
    expect(resolveSchemaSync(env({ NODE_ENV: 'production', RUN_MIGRATIONS: 'false' }))).toBe(false);
  });
});

describe('concurrency defaults', () => {
  it('sizes the workers from the host rather than a fixed number', () => {
    // Thirty submissions on an eight-core laptop behind two workers leave
    // six cores idle: p50 8.6 s, slowest 15.9 s, against 5.0 s and 8.7 s at
    // eight. One core is left for the API, the database and the
    // instructor's browser.
    expect(resolveJobConcurrency(env({}))).toBe(Math.max(2, hostParallelism() - 1));
    expect(hostParallelism()).toBeGreaterThanOrEqual(1);
  });

  it('never drops below two workers, however small the host', () => {
    expect(resolveJobConcurrency(env({}))).toBeGreaterThanOrEqual(2);
  });

  it('gives the runner more slots than there are workers', () => {
    // One grading job makes several sandbox runs and the incident drill makes
    // them straight off the request path, so sizing the runner to the worker
    // count puts a learner pressing "Run health check" behind the whole
    // class's grading.
    const workers = resolveJobConcurrency(env({}));
    expect(resolveRunnerSlots(env({}))).toBeGreaterThan(workers);
    expect(resolveRunnerSlots(env({ JOB_CONCURRENCY: '4' }))).toBe(6);
  });

  it('still lets the environment override every number', () => {
    expect(resolveJobConcurrency(env({ JOB_CONCURRENCY: '8' }))).toBe(8);
    expect(resolveRunnerSlots(env({ RUNNER_SLOTS: '3' }))).toBe(3);
    expect(resolveRunnerWait(env({ RUNNER_MAX_WAIT_MS: '5000', RUNNER_MAX_WAITING: '12' }))).toEqual({
      maxWaitMs: 5000,
      maxWaiting: 12,
    });
    expect(resolveSignInMaxPerAddress(env({ SIGNIN_MAX_PER_ADDRESS: '40' }))).toBe(40);
  });

  it('falls back to the default when a variable is not a positive whole number', () => {
    // A blank, a zero or a typo would otherwise become NaN or 0 through
    // parseInt, and a gate of zero is a gate that never opens.
    const derived = resolveJobConcurrency(env({}));
    for (const bad of ['', '0', '-4', 'eight', '2.5']) {
      expect(resolveJobConcurrency(env({ JOB_CONCURRENCY: bad }))).toBe(derived);
      expect(resolveRunnerSlots(env({ RUNNER_SLOTS: bad }))).toBe(derived + 2);
      expect(resolveRunnerWait(env({ RUNNER_MAX_WAIT_MS: bad })).maxWaitMs).toBe(120_000);
      expect(resolveSignInMaxPerAddress(env({ SIGNIN_MAX_PER_ADDRESS: bad }))).toBe(200);
    }
  });

  it('bounds the wait for a sandbox slot by default', () => {
    // The gate was an unbounded FIFO: forty learners on the drill's health
    // check meant the last of them held a request open for about eleven
    // minutes. Both halves of the bound have to be on without configuration.
    const wait = resolveRunnerWait(env({}));
    expect(wait.maxWaitMs).toBe(120_000);
    expect(wait.maxWaiting).toBe(200);
  });

  it('lets a room behind one address sign in as a room', () => {
    // A cohort shares one venue NAT, so the address ceiling is room-sized;
    // the per-account limit in auth/auth.controller.ts is what stops guessing.
    expect(resolveSignInMaxPerAddress(env({}))).toBe(200);
  });
});

/* ------------------------------ the fairness cap ------------------------- */

describe('how many submissions one learner may hold at once', () => {
  it('defaults to two across every phase and every task', () => {
    // Narrowing `UQ_submissions_in_flight` to `(phaseStateId, taskKey)` is
    // exactly what lets one learner hold one submission per task of every
    // open phase, so the fairness bound is a separate number with a separate
    // mechanism. Two is a learner working two things while the class waits on
    // neither.
    expect(resolveSubmitInFlightPerLearner(env({}))).toBe(2);
    expect(config.submitInFlightPerLearner).toBe(2);
  });

  it('is a deployment setting, and falls back on anything that is not a positive whole number', () => {
    expect(resolveSubmitInFlightPerLearner(env({ SUBMIT_IN_FLIGHT_PER_LEARNER: '5' }))).toBe(5);
    expect(resolveSubmitInFlightPerLearner(env({ SUBMIT_IN_FLIGHT_PER_LEARNER: '1' }))).toBe(1);
    for (const bad of ['', '0', '-4', 'two', '2.5']) {
      expect(resolveSubmitInFlightPerLearner(env({ SUBMIT_IN_FLIGHT_PER_LEARNER: bad }))).toBe(2);
    }
  });
});

/* --------------------------- the default project ------------------------ */

describe('the default project', () => {
  const roots: string[] = [];

  /** A content directory of the shape ContentService walks: a pack per directory. */
  const contentDir = (packs: Record<string, unknown>): string => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lsdlc-content-'));
    roots.push(root);
    for (const [name, project] of Object.entries(packs)) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      if (project !== null) {
        fs.writeFileSync(path.join(root, name, 'project.json'), JSON.stringify(project));
      }
    }
    return root;
  };

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers with the pack the content directory holds, not a hard-coded slug', () => {
    // A hard-coded slug such as 'tasktrackr' would break on a rename: renaming
    // the pack has to change the answer, or the default silently asks for a
    // project that does not exist on every request without ?project=.
    const root = contentDir({ 'the-pack': { slug: 'renamed-pack' } });
    expect(resolveDefaultProject(root, env({}))).toBe('renamed-pack');
  });

  it('reads the slug out of project.json rather than trusting the directory name', () => {
    const root = contentDir({ 'a-directory': { slug: 'the-slug-that-counts' } });
    expect(resolveDefaultProject(root, env({}))).toBe('the-slug-that-counts');
  });

  it('skips a directory that is not a pack', () => {
    // Editors, archives and scratch directories live under content/ too, and
    // sort before a pack often enough to matter.
    const root = contentDir({ '.cache': null, archive: null, tasktrackr: { slug: 'tasktrackr' } });
    expect(resolveDefaultProject(root, env({}))).toBe('tasktrackr');
  });

  it('lets a deployment with more than one pack name the one it means', () => {
    const root = contentDir({ first: { slug: 'first' }, second: { slug: 'second' } });
    expect(resolveDefaultProject(root, env({}))).toBe('first');
    expect(resolveDefaultProject(root, env({ DEFAULT_PROJECT: 'second' }))).toBe('second');
  });

  it('is empty rather than wrong when there is no pack to read', () => {
    // ContentService refuses an empty content directory by name at boot, so
    // this deployment never serves a request; an invented slug would only make
    // the eventual error say the wrong thing.
    expect(resolveDefaultProject(path.join(os.tmpdir(), 'lsdlc-no-such-content'), env({}))).toBe('');
    expect(resolveDefaultProject(contentDir({}), env({}))).toBe('');
  });

  it('resolves to the project this repository ships', () => {
    // The end of the chain EnrollmentsController.mine reads, against the real
    // content directory: one pack, and config carries its slug.
    const shipped = JSON.parse(
      fs.readFileSync(path.join(config.contentDir, 'tasktrackr', 'project.json'), 'utf-8'),
    ).slug;
    expect(config.defaultProject).toBe(shipped);
    expect(config.defaultProject).not.toBe('');
  });
});

/* ------------------------------ live preview ----------------------------- */

describe('the live preview switch', () => {
  const env = (over: Record<string, string | undefined> = {}) =>
    ({ ...over }) as NodeJS.ProcessEnv;

  it('is off on the Lambda transport whatever anyone sets', () => {
    // A Lambda invoke returns and the process goes away, so there is nowhere
    // for an app to keep running. A Start button that could only ever fail is
    // worse than no button.
    expect(resolvePreviewEnabled(env({ RUNNER_MODE: 'lambda' }))).toBe(false);
    expect(resolvePreviewEnabled(env({ RUNNER_MODE: 'lambda', PREVIEW_ENABLED: 'true' }))).toBe(false);
  });

  it('is on everywhere else until an operator turns it off by name', () => {
    expect(resolvePreviewEnabled(env({ RUNNER_MODE: 'socket' }))).toBe(true);
    expect(resolvePreviewEnabled(env({ RUNNER_MODE: 'local' }))).toBe(true);
    expect(resolvePreviewEnabled(env({ RUNNER_MODE: 'socket', PREVIEW_ENABLED: 'false' }))).toBe(false);
  });
});

describe('how many previews at once', () => {
  const env = (over: Record<string, string | undefined> = {}) =>
    ({ ...over }) as NodeJS.ProcessEnv;

  it('is one where the runner shares the machine, and two where it has a container', () => {
    // Decision 6: one on a laptop, two in the container. RUNNER_MODE=local is
    // what "this machine is also the API, the database and the browser" looks
    // like from here.
    expect(resolvePreviewSessions(env({ RUNNER_MODE: 'local' }))).toBe(1);
    expect(resolvePreviewSessions(env({ RUNNER_MODE: 'socket' }))).toBe(2);
  });

  it('is whatever the deployment says', () => {
    expect(resolvePreviewSessions(env({ RUNNER_MODE: 'local', PREVIEW_SESSIONS: '4' }))).toBe(4);
    // Nonsense falls back rather than disabling the feature by arithmetic.
    expect(resolvePreviewSessions(env({ RUNNER_MODE: 'socket', PREVIEW_SESSIONS: 'lots' }))).toBe(2);
    expect(resolvePreviewSessions(env({ RUNNER_MODE: 'socket', PREVIEW_SESSIONS: '0' }))).toBe(2);
  });
});

describe('where the preview transport listens', () => {
  const env = (over: Record<string, string | undefined> = {}) =>
    ({ ...over }) as NodeJS.ProcessEnv;

  it('sits beside the database, which is the directory a laptop already owns', () => {
    expect(resolvePreviewSocket(env({ DB_PATH: 'data/learnsdlc.sqlite' }))).toBe(
      path.join('data', 'preview.sock'),
    );
    expect(resolvePreviewSocket(env({ DB_PATH: '/srv/lsdlc/db.sqlite' }))).toBe(
      path.join('/srv/lsdlc', 'preview.sock'),
    );
  });

  it('is whatever PREVIEW_SOCKET says', () => {
    expect(resolvePreviewSocket(env({ PREVIEW_SOCKET: '/tmp/p.sock' }))).toBe('/tmp/p.sock');
  });
});

describe('the runner container’s memory arithmetic', () => {
  const env = (over: Record<string, string | undefined> = {}) =>
    ({ ...over }) as NodeJS.ProcessEnv;

  /**
   * Three places encode this figure: docker-compose.yml's `mem_limit`, the
   * comment above it and the runbook, and a container over its limit is
   * killed and takes every in-flight learner's run with it. This is the one
   * that is executable.
   */
  it('fits the shipped container profile inside the limit compose sets', () => {
    const container = env({
      RUNNER_MODE: 'socket',
      RUNNER_SLOTS: '4',
      RUN_MEMORY_MB: '256',
      PREVIEW_SESSIONS: '2',
      PREVIEW_MEMORY_MB: '512',
    });
    expect(runnerContainerBudgetMb(container)).toBeLessThanOrEqual(RUNNER_CONTAINER_MB);
  });

  it('fits the documented laptop profile too', () => {
    const laptop = env({
      RUNNER_MODE: 'local',
      RUNNER_SLOTS: '2',
      RUN_MEMORY_MB: '256',
      PREVIEW_SESSIONS: '1',
      PREVIEW_MEMORY_MB: '256',
    });
    expect(runnerContainerBudgetMb(laptop)).toBeLessThanOrEqual(RUNNER_CONTAINER_MB);
  });

  it('says so when a profile would not fit, which is the whole point of the sum', () => {
    // The runs alone fit (4 x 512 + 512 = 2.5 GB); it is the two previews on
    // top that go over. A sum that forgot the preview term would call this
    // profile safe, which is the mistake worth catching.
    const greedy = env({
      RUNNER_MODE: 'socket',
      RUNNER_SLOTS: '4',
      RUN_MEMORY_MB: '512',
      PREVIEW_SESSIONS: '2',
      PREVIEW_MEMORY_MB: '512',
    });
    expect(runnerContainerBudgetMb({ ...greedy, PREVIEW_ENABLED: 'false' })).toBeLessThanOrEqual(
      RUNNER_CONTAINER_MB,
    );
    expect(runnerContainerBudgetMb(greedy)).toBeGreaterThan(RUNNER_CONTAINER_MB);
  });

  it('spends nothing on previews where they are switched off', () => {
    const noPreview = env({ RUNNER_MODE: 'lambda', RUNNER_SLOTS: '4', RUN_MEMORY_MB: '256' });
    expect(runnerContainerBudgetMb(noPreview)).toBe(4 * 256 + 512);
  });
});

/**
 * The bounded edit-list experiment is off unless an operator names a mode. An
 * invalid value refuses the boot: AgenticService validates it when Nest
 * builds it, and never the config module's load, which an acceptance script
 * may `require` without the variable.
 */
describe('the Agentic edit-list flag (AI_AGENTIC_EDIT_LIST)', () => {
  it('is off when unset, and takes exactly off, on or strict', () => {
    expect(AGENTIC_EDIT_LIST_MODES).toEqual(['off', 'on', 'strict']);
    expect(resolveAgenticEditList(env())).toBe('off');
    for (const mode of ['off', 'on', 'strict']) expect(resolveAgenticEditList(env({ AI_AGENTIC_EDIT_LIST: mode }))).toBe(mode);
  });

  it.each(['', 'true', '1', 'ON', 'yes', ' on', 'strict '])('refuses %j, naming the variable', (value) => {
    expect(() => resolveAgenticEditList(env({ AI_AGENTIC_EDIT_LIST: value }))).toThrow('AI_AGENTIC_EDIT_LIST must be off, on or strict');
  });

  it('never throws at module load: an invalid value loads as off and is refused at boot instead', () => {
    expect(agenticEditListAtLoad(env({ AI_AGENTIC_EDIT_LIST: 'bogus' }))).toBe('off');
    expect(agenticEditListAtLoad(env({ AI_AGENTIC_EDIT_LIST: 'strict' }))).toBe('strict');
    const held = process.env.AI_AGENTIC_EDIT_LIST;
    process.env.AI_AGENTIC_EDIT_LIST = 'bogus';
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect((require('./config') as typeof import('./config')).config.agenticEditList).toBe('off');
      });
    } finally {
      if (held === undefined) delete process.env.AI_AGENTIC_EDIT_LIST;
      else process.env.AI_AGENTIC_EDIT_LIST = held;
    }
  });

  it('ships off, and leaves the model settings the acceptance observer reads by name', () => {
    expect(config.agenticEditList).toBe('off');
    expect(Object.keys(config)).toEqual(expect.arrayContaining(['openaiModel', 'openaiReasoningEffort']));
    expect(typeof config.openaiModel).toBe('string');
    expect(typeof config.openaiReasoningEffort).toBe('string');
  });
});

/*
 * AI_AGENTIC_PAYLOAD: `full`, the default and the value of an unset variable,
 * builds the whole generation payload; `trim` drops the
 * duplicate saved workspace and narrows a request that names its files. An
 * invalid value refuses the boot, never the module's load, as the edit-list
 * flag does.
 */
describe('the Agentic payload flag (AI_AGENTIC_PAYLOAD)', () => {
  it('is full when unset, and takes exactly full or trim', () => {
    expect(AGENTIC_PAYLOAD_MODES).toEqual(['full', 'trim']);
    expect(resolveAgenticPayload(env())).toBe('full');
    for (const mode of ['full', 'trim']) expect(resolveAgenticPayload(env({ AI_AGENTIC_PAYLOAD: mode }))).toBe(mode);
  });

  it.each(['', 'on', 'TRIM', ' trim', 'full ', 'off'])('refuses %j, naming the variable', (value) => {
    expect(() => resolveAgenticPayload(env({ AI_AGENTIC_PAYLOAD: value }))).toThrow('AI_AGENTIC_PAYLOAD must be full or trim');
  });

  it('never throws at module load: an invalid value loads as full and is refused at boot instead', () => {
    expect(agenticPayloadAtLoad(env({ AI_AGENTIC_PAYLOAD: 'bogus' }))).toBe('full');
    expect(agenticPayloadAtLoad(env({ AI_AGENTIC_PAYLOAD: 'trim' }))).toBe('trim');
  });

  it('ships full', () => {
    expect(config.agenticPayload).toBe('full');
  });
});

/**
 * `GRADING_RUN_FANOUT`: the most sandbox runs one submission may hold at
 * once, and `GRADING_SPECULATIVE_MUTANTS`: whether a Testing review starts
 * its mutant runs beside its reference runs. Unset, both are today's grader
 * (runs one after another, mutants after the references). A bad value refuses
 * the API's boot (`assertGradingFanout` in `main.ts`), never the config
 * module's load.
 */
describe('the grading fan-out (GRADING_RUN_FANOUT, GRADING_SPECULATIVE_MUTANTS)', () => {
  it('GRADING_RUN_FANOUT unset is today’s', () => {
    expect(resolveGradingRunFanout(env())).toBeNull();
    expect(resolveGradingSpeculativeMutants(env())).toBe(false);
    expect(() => assertGradingFanout(env())).not.toThrow();
    expect(config.gradingRunFanout).toBeNull();
    expect(config.gradingSpeculativeMutants).toBe(false);
  });

  it('takes a positive integer up to RUNNER_SLOTS', () => {
    expect(resolveGradingRunFanout(env({ GRADING_RUN_FANOUT: '1', RUNNER_SLOTS: '2' }))).toBe(1);
    expect(resolveGradingRunFanout(env({ GRADING_RUN_FANOUT: '8', RUNNER_SLOTS: '8' }))).toBe(8);
    // RUNNER_SLOTS unset is its own default, workers + 2.
    expect(resolveGradingRunFanout(env({ GRADING_RUN_FANOUT: '3', JOB_CONCURRENCY: '2' }))).toBe(3);
  });

  it('above RUNNER_SLOTS refuses the boot', () => {
    const over = env({ GRADING_RUN_FANOUT: '3', RUNNER_SLOTS: '2' });
    expect(() => resolveGradingRunFanout(over)).toThrow('GRADING_RUN_FANOUT (3) must not exceed RUNNER_SLOTS (2)');
    expect(() => assertGradingFanout(over)).toThrow('GRADING_RUN_FANOUT');
    expect(() => assertGradingFanout(env({ GRADING_RUN_FANOUT: '5', JOB_CONCURRENCY: '2' }))).toThrow('RUNNER_SLOTS (4)');
  });

  it.each(['', '0', '-1', '1.5', '2.0', ' 2', 'two', 'Infinity', '1e1'])('non-integer or non-positive %j refuses the boot', (value) => {
    expect(() => resolveGradingRunFanout(env({ GRADING_RUN_FANOUT: value, RUNNER_SLOTS: '64' }))).toThrow(
      'GRADING_RUN_FANOUT must be a positive whole number',
    );
  });

  it('GRADING_SPECULATIVE_MUTANTS takes on or off, and on needs a fanout', () => {
    expect(resolveGradingSpeculativeMutants(env({ GRADING_SPECULATIVE_MUTANTS: 'off' }))).toBe(false);
    expect(resolveGradingSpeculativeMutants(env({ GRADING_SPECULATIVE_MUTANTS: 'on', GRADING_RUN_FANOUT: '2', RUNNER_SLOTS: '2' }))).toBe(true);
    expect(() => resolveGradingSpeculativeMutants(env({ GRADING_SPECULATIVE_MUTANTS: 'on' }))).toThrow(
      'GRADING_SPECULATIVE_MUTANTS=on needs GRADING_RUN_FANOUT',
    );
    for (const value of ['', 'true', '1', 'ON', ' on']) {
      expect(() => resolveGradingSpeculativeMutants(env({ GRADING_SPECULATIVE_MUTANTS: value, GRADING_RUN_FANOUT: '2', RUNNER_SLOTS: '2' }))).toThrow(
        'GRADING_SPECULATIVE_MUTANTS must be on or off',
      );
    }
  });

  it('never throws at module load: a bad value loads as today’s and is refused at boot instead', () => {
    expect(gradingFanoutAtLoad(env({ GRADING_RUN_FANOUT: 'bogus' }))).toEqual({ runFanout: null, speculativeMutants: false });
    expect(gradingFanoutAtLoad(env({ GRADING_RUN_FANOUT: '9', RUNNER_SLOTS: '2', GRADING_SPECULATIVE_MUTANTS: 'on' }))).toEqual({
      runFanout: null,
      speculativeMutants: false,
    });
    expect(gradingFanoutAtLoad(env({ GRADING_RUN_FANOUT: '4', RUNNER_SLOTS: '4', GRADING_SPECULATIVE_MUTANTS: 'on' }))).toEqual({
      runFanout: 4,
      speculativeMutants: true,
    });
    const held = { fanout: process.env.GRADING_RUN_FANOUT, slots: process.env.RUNNER_SLOTS };
    process.env.GRADING_RUN_FANOUT = '99';
    process.env.RUNNER_SLOTS = '2';
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = (require('./config') as typeof import('./config')).config;
        expect(loaded.gradingRunFanout).toBeNull();
        expect(loaded.gradingSpeculativeMutants).toBe(false);
      });
    } finally {
      if (held.fanout === undefined) delete process.env.GRADING_RUN_FANOUT;
      else process.env.GRADING_RUN_FANOUT = held.fanout;
      if (held.slots === undefined) delete process.env.RUNNER_SLOTS;
      else process.env.RUNNER_SLOTS = held.slots;
    }
  });
});

describe('the numeric settings config loads with', () => {
  /** `config` as it loads under these variables, with the process environment put back afterwards. */
  const loadedWith = (over: Record<string, string | undefined>): typeof config => {
    const held = Object.fromEntries(Object.keys(over).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      let loaded!: typeof config;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        loaded = (require('./config') as typeof import('./config')).config;
      });
      return loaded;
    } finally {
      for (const [key, value] of Object.entries(held)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  const NUMERIC: Record<string, keyof typeof config> = {
    API_PORT: 'port',
    JOB_ATTEMPTS: 'jobAttempts',
    RUN_TIMEOUT_SECONDS: 'runTimeoutSeconds',
    RUN_MEMORY_MB: 'runMemoryMb',
    PREVIEW_MEMORY_MB: 'previewMemoryMb',
    PREVIEW_IDLE_SECONDS: 'previewIdleSeconds',
    PREVIEW_MAX_SECONDS: 'previewMaxSeconds',
    PREVIEW_BOOT_SECONDS: 'previewBootSeconds',
    PREVIEW_BUILD_SECONDS: 'previewBuildSeconds',
    PREVIEW_MAX_BYTES: 'previewMaxBytes',
    PREVIEW_REQUEST_TIMEOUT_MS: 'previewRequestTimeoutMs',
  };

  /** Every one of them unset, so `config` loads each with its default. */
  const UNSET = Object.fromEntries([...Object.keys(NUMERIC), 'TRUSTED_PROXIES'].map((key) => [key, undefined]));

  it('reads a well-formed value exactly as written', () => {
    const loaded = loadedWith({ ...Object.fromEntries(Object.keys(NUMERIC).map((key) => [key, '7'])), TRUSTED_PROXIES: '1' });
    for (const field of Object.values(NUMERIC)) expect([field, loaded[field]]).toEqual([field, 7]);
    expect(loaded.trustedProxies).toBe(1);
    expect(loadedWith({ TRUSTED_PROXIES: '0' }).trustedProxies).toBe(0);
  });

  it('loads a malformed value as its default, the way the neighbouring settings do, never as NaN or a truncated number', () => {
    const defaults = loadedWith(UNSET);
    for (const raw of ['abc', '15s', '-3', '2.5']) {
      const loaded = loadedWith({ ...Object.fromEntries(Object.keys(NUMERIC).map((key) => [key, raw])), TRUSTED_PROXIES: raw });
      for (const [variable, field] of Object.entries(NUMERIC)) {
        expect([variable, raw, loaded[field]]).toEqual([variable, raw, defaults[field]]);
      }
      expect([raw, loaded.trustedProxies]).toEqual([raw, defaults.trustedProxies]);
    }
  });

  it('takes 0 where it means something (any free port, no proxy hops) and loads it as the default elsewhere', () => {
    const defaults = loadedWith(UNSET);
    const loaded = loadedWith({ ...Object.fromEntries(Object.keys(NUMERIC).map((key) => [key, '0'])), TRUSTED_PROXIES: '0' });
    expect([loaded.port, loaded.trustedProxies]).toEqual([0, 0]);
    for (const [variable, field] of Object.entries(NUMERIC)) {
      if (variable !== 'API_PORT') expect([variable, loaded[field]]).toEqual([variable, defaults[field]]);
    }
  });
});

describe('the JWT secret config loads with', () => {
  const secretUnder = (over: Record<string, string | undefined>): string => {
    const keys = ['JWT_SECRET', 'API_BIND', 'NODE_ENV'];
    const held = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) {
      if (over[key] === undefined) delete process.env[key];
      else process.env[key] = over[key];
    }
    try {
      let loaded!: string;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        loaded = (require('./config') as typeof import('./config')).config.jwtSecret;
      });
      return loaded;
    } finally {
      for (const [key, value] of Object.entries(held)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  it('is JWT_SECRET whenever it is set', () => {
    expect(secretUnder({ JWT_SECRET: REAL_SECRET, API_BIND: '0.0.0.0', NODE_ENV: 'production' })).toBe(REAL_SECRET);
    expect(secretUnder({ JWT_SECRET: REAL_SECRET })).toBe(REAL_SECRET);
  });

  it('is empty when JWT_SECRET is unset, on any bind and in any environment, and never a published one', () => {
    expect(secretUnder({})).toBe('');
    expect(secretUnder({ API_BIND: '127.0.0.1' })).toBe('');
    expect(secretUnder({ API_BIND: '0.0.0.0' })).toBe('');
    expect(secretUnder({ NODE_ENV: 'production' })).toBe('');
    expect(secretUnder({ JWT_SECRET: '', API_BIND: '192.168.1.24' })).toBe('');
  });
});

describe('a boot without a session secret', () => {
  it('is refused on a loopback bind outside production too, with the command that creates one', () => {
    expect(() => assertJwtSecretSet({} as NodeJS.ProcessEnv)).toThrow(JWT_SECRET_MISSING);
    expect(() => assertJwtSecretSet({ JWT_SECRET: '  ' } as NodeJS.ProcessEnv)).toThrow(JWT_SECRET_MISSING);
    expect(JWT_SECRET_MISSING).toMatch(/JWT_SECRET is not set/);
    expect(JWT_SECRET_MISSING).toContain('bash scripts/setup.sh');
    // One sentence: a person reads it on the line before the process exits.
    expect(JWT_SECRET_MISSING.split(/\.\s/)).toHaveLength(1);
  });

  it('goes ahead with any secret on a loopback bind, where the other checks judge its strength off loopback', () => {
    expect(() => assertJwtSecretSet({ JWT_SECRET: 'test-secret' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertJwtSecretSet({ JWT_SECRET: REAL_SECRET } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('the quiz key, when QUIZ_SEED_SECRET sets one', () => {
  const quiz = 'z8Lq3Vw1Nc5Rb7Ty2Hk4Jm6Fd0Sa9Gp1Xe3Uo5Ci7Bn8Mv2Qw';

  it('reads a value of only spaces as unset, so the key falls back to the JWT secret', () => {
    expect(resolveQuizSeedSecret(env({}))).toBe('');
    expect(resolveQuizSeedSecret(env({ QUIZ_SEED_SECRET: '' }))).toBe('');
    expect(resolveQuizSeedSecret(env({ QUIZ_SEED_SECRET: '   ' }))).toBe('');
    expect(resolveQuizSeedSecret(env({ QUIZ_SEED_SECRET: quiz }))).toBe(quiz);
  });

  it('starts anywhere when it is unset', () => {
    expect(() => assertBindSafety(env({ API_BIND: '0.0.0.0', JWT_SECRET: REAL_SECRET }))).not.toThrow();
    expect(() =>
      assertProductionSecrets(
        env({ NODE_ENV: 'production', JWT_SECRET: REAL_SECRET, ADMIN_EMAIL: 'ops@example.edu', ADMIN_PASSWORD: 'Correct-Horse-9' }),
      ),
    ).not.toThrow();
  });

  it('refuses a placeholder or a short value off loopback, naming QUIZ_SEED_SECRET', () => {
    for (const value of ['changeme', 'short'])
      expect(() =>
        assertBindSafety(env({ API_BIND: '0.0.0.0', JWT_SECRET: REAL_SECRET, QUIZ_SEED_SECRET: value })),
      ).toThrow(/refusing to bind 0\.0\.0\.0: QUIZ_SEED_SECRET is (one of the placeholders|shorter than 32 bytes)/);
    expect(() =>
      assertBindSafety(env({ API_BIND: '0.0.0.0', JWT_SECRET: REAL_SECRET, QUIZ_SEED_SECRET: quiz })),
    ).not.toThrow();
  });

  it('refuses a placeholder or a short value in production, naming QUIZ_SEED_SECRET', () => {
    const complete = { NODE_ENV: 'production', JWT_SECRET: REAL_SECRET, ADMIN_EMAIL: 'ops@example.edu', ADMIN_PASSWORD: 'Correct-Horse-9' };
    for (const value of ['changeme', 'short'])
      expect(() => assertProductionSecrets(env({ ...complete, QUIZ_SEED_SECRET: value }))).toThrow(
        /set QUIZ_SEED_SECRET /,
      );
    expect(() => assertProductionSecrets(env({ ...complete, QUIZ_SEED_SECRET: quiz }))).not.toThrow();
  });

  it('accepts any value on loopback outside production', () => {
    expect(() => assertBindSafety(env({ JWT_SECRET: REAL_SECRET, QUIZ_SEED_SECRET: 'changeme' }))).not.toThrow();
    expect(() => assertProductionSecrets(env({ QUIZ_SEED_SECRET: 'short' }))).not.toThrow();
  });
});

describe('the Google redirect address by default', () => {
  it('names the port the API listens on, which is the default when API_PORT is malformed', () => {
    expect(resolveGoogleRedirectUrl(env({ API_PORT: '4100' }))).toBe('http://localhost:4100/api/v1/auth/google/callback');
    for (const port of ['abc', '15s', '-3', '2.5'])
      expect(resolveGoogleRedirectUrl(env({ API_PORT: port }))).toBe('http://localhost:4000/api/v1/auth/google/callback');
  });
});
