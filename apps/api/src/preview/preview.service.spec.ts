import 'reflect-metadata';
import { createHash } from 'crypto';
import {
  PREVIEW_CLEANUP_HELD_MESSAGE, PREVIEW_DISABLED_MESSAGE, PREVIEW_ISOLATION_MESSAGE, PREVIEW_PAUSED_MESSAGE,
  PREVIEW_RUNNER_UNAVAILABLE_MESSAGE, PREVIEW_UNAVAILABLE_MESSAGE,
} from '@learnsdlc/shared';
import { SANDBOX_BUSY_MESSAGE } from '../execution/run-gate';
import type { SandboxAppSession, SandboxAppOwnerLookup } from '../execution/sandbox.service';

/**
 * The live preview, on this side of the socket.
 *
 * What the service owns and the runner deliberately does not: whose session
 * this is, the capability that opens it, and when it stops. The runner knows
 * about a process and a workspace and never learns a user id, so every rule
 * below: one app per learner, a capability that dies with the session, a
 * status poll that counts as a touch: is only true if it is true here.
 */

const PHASE = {
  key: 'implementation',
  canPreview: true,
  files: [{ path: 'api/main.py', content: 'print(1)\n', editable: false, language: 'python' }],
};

const PROJECT = {
  slug: 'tasktrackr',
  build: { tool: 'esbuild', entry: 'web/src/main.tsx', outfile: 'web/dist/app.js', jsx: 'automatic' },
  preview: {
    service: { command: ['python3', 'api/main.py'], portEnv: 'PORT', health: '/api/health' },
    web: { root: 'web/dist', html: 'web/index.html' },
    env: { TASKTRACKR_DB: 'data/preview.sqlite' },
    seed: ['python3', 'ops/seed.py'],
  },
};

const view = (over: Partial<SandboxAppSession> = {}): SandboxAppSession => ({
  id: `run-${Math.random().toString(36).slice(2, 8)}`,
  status: 'starting',
  message: null,
  stopReason: null,
  bundleOk: true,
  console: [],
  cursor: 0,
  ...over,
});

interface Harness {
  service: import('./preview.service').PreviewService;
  sandbox: {
    started: unknown[];
    stopped: { id: string; reason: string }[];
    next: SandboxAppSession[];
    statusAnswer: SandboxAppSession | null;
    ownerLookups: string[];
  };
  audits: { event: string; targetId?: string | null; detail?: Record<string, unknown> | null }[];
  /** Every phase id that has been handed to loadOwnedState, and whose. */
  owned: (userId: string, phaseStateId: string) => void;
  revoke: (userId: string) => Promise<void>;
  dataSource: import('typeorm').DataSource;
  replica: () => import('./preview.service').PreviewService;
  /** Move the phase row's save stamp, as a save or an Agentic apply would. */
  setSaved: (version: string | null) => void;
}

/**
 * `config` is read from the environment once, at import, and the tests below
 * change the environment (`PREVIEW_SESSIONS`, `RUNNER_MODE`) before they build
 * a service. Calling `jest.resetModules()` in each `harness` and requiring the
 * service afresh would load `typeorm`, every entity and the whole graph the
 * service imports (workflow, feedback, the assistant…) once per test. Those
 * copies are never collected: typeorm keeps its decorator metadata in a global
 * store, which holds every copy's entity classes and so every copy's modules:
 * about 780 MB by the end of this file, carried into every file the in-band
 * suite runs after it.
 *
 * So the modules are loaded once, and what changes per test is the one thing
 * that has to: the environment is read afresh, in an isolated registry that
 * holds nothing but `config` and is dropped straight after, and written over
 * the one `config` object every module here reads its values from at call
 * time. `afterEach` puts the values it was loaded with back.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('../config') as { config: Record<string, unknown> };
const CONFIG_AT_LOAD = { ...config };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const auditModule = require('../audit/audit');
const realRecordAudit = auditModule.recordAudit;

function rereadConfig(): void {
  let fresh: Record<string, unknown> = {};
  jest.isolateModules(() => {
    fresh = require('../config').config;
  });
  Object.assign(config, fresh);
}

/** The service with its four collaborators stubbed, against the environment as it is now. */
async function harness(over: { canPreview?: boolean; hasPreview?: boolean; refuse?: Error; start?: Promise<SandboxAppSession>; stop?: Promise<void>; status?: Promise<SandboxAppSession>; auditStart?: Promise<void>; auditEntered?: () => void; lookup?: () => Promise<SandboxAppOwnerLookup>; stopConfirmed?: boolean; socket?: () => Promise<string | null> } = {}): Promise<Harness> {
  rereadConfig();
  const { PreviewService } = require('./preview.service');
  const audits: Harness['audits'] = [];
  const sandbox: Harness['sandbox'] = {
    started: [],
    stopped: [],
    next: [],
    statusAnswer: null,
    ownerLookups: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const owners: string[] = [];
  // The phase row's `workspaceUpdatedAt`, which a save or an apply moves.
  let savedVersion: string | null = null;

  const workflow = {
    async loadOwnedState(userId: string, phaseStateId: string) {
      owners.push(`${userId}:${phaseStateId}`);
      if (over.refuse) throw over.refuse;
      return {
        state: { id: phaseStateId, workspace: null, workspaceUpdatedAt: savedVersion },
        phase: { ...PHASE, canPreview: over.canPreview ?? true },
        // The shape `loadOwnedState` really hands back. A null
        // pin is what every enrolment made before the model had versions
        // carries, and it resolves the published head, which is the project
        // this harness answers with.
        enrollment: { projectSlug: 'tasktrackr', projectVersionId: null },
      };
    },
  };
  const project = () => (over.hasPreview === false ? { ...PROJECT, preview: undefined } : PROJECT);
  const content = {
    getProject: project,
    // The enrolment-scoped accessor the service reads.
    // Same answer as `getProject` here, because the enrolment above carries no
    // pin: which *version* a pinned enrolment resolves is `repo-pin.spec.ts`'s,
    // against a catalogue that holds two of them.
    getForEnrollment: project,
    executionFiles: () => ({ 'api/main.py': 'print(1)\n' }),
  };
  const sandboxStub = {
    started: sandbox.started,
    stopped: sandbox.stopped,
    // The transport a start is about to use. A stub socket unless the case
    // says the runner could not be reached.
    async previewSocket() { return over.socket ? over.socket() : '/tmp/preview-harness.sock'; },
    async lookupAppOwner(ownerId: string) { sandbox.ownerLookups.push(ownerId); return over.lookup?.() ?? { found: false, cleanupConfirmed: false }; },
    async startApp(job: unknown) {
      sandbox.started.push(job);
      return over.start ?? sandbox.next.shift() ?? view();
    },
    async statusApp(id: string) {
      if (sandbox.stopped.some(row => row.id === id)) return view({ id, status: 'stopped', cleanupConfirmed: over.stopConfirmed ?? true });
      return over.status ?? sandbox.statusAnswer ?? view({ status: 'ready' });
    },
    async stopApp(id: string, reason: string) {
      sandbox.stopped.push({ id, reason });
      await over.stop;
    },
  };
  const { DataSource } = require('typeorm');
  const { ALL_ENTITIES, UserEntity, AuditEventEntity } = require('../db/entities');
  const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ALL_ENTITIES, synchronize: true });
  await dataSource.initialize();
  databases.push(dataSource);
  for (let i = 1; i <= 3; i++) await dataSource.manager.save(UserEntity, dataSource.manager.create(UserEntity, {
    id: `learner-${i}`, email: `preview-${i}@example.invalid`, displayName: `Learner ${i}`, passwordHash: 'unused',
  }));
  const record = realRecordAudit;
  jest.spyOn(auditModule, 'recordAudit').mockImplementation(async (...args: unknown[]) => {
    const manager = args[0];
    const row = args[1] as Record<string, unknown>;
    if (row.event === 'preview.start') { over.auditEntered?.(); await over.auditStart; }
    audits.push(row as Harness['audits'][number]);
    return record(manager, row);
  });
  let revoke: ((id: string) => void) | undefined;
  return {
    service: new PreviewService(workflow, content, sandboxStub, dataSource, { onSessionRevoked: (listener: (id: string) => void) => { revoke = listener; } }),
    sandbox: Object.assign(sandbox, sandboxStub),
    audits,
    dataSource,
    replica: () => new PreviewService(workflow, content, sandboxStub, dataSource),
    owned: (userId, phaseStateId) => expect(owners).toContain(`${userId}:${phaseStateId}`),
    setSaved: version => { savedVersion = version; },
    revoke: async id => {
      await dataSource.manager.update(UserEntity, { id }, { tokenVersion: () => '"tokenVersion" + 1' });
      revoke?.(id);
    },
  };
}

const databases: import('typeorm').DataSource[] = [];
const saved = { ...process.env };
afterEach(async () => {
  // Settle already-released revocation cleanup before closing its owned fixture DB.
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const db of databases.splice(0)) if (db.isInitialized) await db.destroy();
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  // The shared modules outlive the test, so what a test set on them is undone
  // here: the `recordAudit` spy, and the environment `config` was re-read with.
  jest.restoreAllMocks();
  Object.assign(config, CONFIG_AT_LOAD);
});

describe('PreviewService.start', () => {
  it('hands the capability over exactly once, in the url, on the start answer', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');

    expect(started.status).toBe('starting');
    expect(started.url).toMatch(/^\/api\/v1\/preview\/[A-Za-z0-9_-]{20,}\/$/);

    // Every later answer about the same session has no url at all: repeating
    // it would put a live credential into every poll, cache and HAR file.
    const polled = await h.service.status('learner-1', 'phase-1');
    expect(polled?.url).toBeNull();
    expect(polled?.id).toBe(started.id);
  });

  it('checks ownership before it starts anything', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');
    h.owned('learner-1', 'phase-1');
  });

  it('refuses another learner’s phase, and starts nothing', async () => {
    const h = await harness({ refuse: new Error('not your phase') });
    await expect(h.service.start('learner-2', 'phase-1')).rejects.toThrow('not your phase');
    expect(h.sandbox.started).toHaveLength(0);
  });

  it('refuses a phase the pack does not let anyone preview', async () => {
    const h = await harness({ canPreview: false });
    await expect(h.service.start('learner-1', 'phase-1')).rejects.toThrow('no app to run');
    expect(h.sandbox.started).toHaveLength(0);
  });

  it('sends the pack’s own preview block and the learner’s own files', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');

    const job = h.sandbox.started[0] as Record<string, unknown>;
    expect(job.mode).toBe('preview');
    expect(job.service).toEqual(PROJECT.preview.service);
    expect(job.seed).toEqual(PROJECT.preview.seed);
    expect(job.build).toEqual(PROJECT.build);
    expect(job.files).toEqual({ 'api/main.py': 'print(1)\n' });
  });

  it('replaces a learner’s own running app rather than giving them two', async () => {
    const h = await harness();
    const first = await h.service.start('learner-1', 'phase-1');
    const second = await h.service.start('learner-1', 'phase-1');

    expect(second.id).not.toBe(first.id);
    expect(h.sandbox.stopped).toHaveLength(1);
    expect((await h.service.liveSessions())).toHaveLength(1);
  });

  /**
   * A stopped session is remembered for a minute so the panel can say why it
   * stopped, so after a second start the register holds the replaced one
   * first. A poll answered about it would say `stopped`; the panel stops
   * polling on `stopped`, so it would draw "You stopped the app." over an
   * application that is booting, and leave it there.
   */
  it('answers the poll after a second start about the new app, not the one it replaced', async () => {
    const h = await harness();
    const first = await h.service.start('learner-1', 'phase-1');
    const second = await h.service.start('learner-1', 'phase-1');

    const polled = await h.service.status('learner-1', 'phase-1');
    expect(polled?.id).toBe(second.id);
    expect(polled?.id).not.toBe(first.id);
    expect(polled?.stopReason).toBeNull();
    // And Stop stops the one on screen, not the one it replaced.
    await h.service.stop('learner-1', 'phase-1');
    expect((await h.service.liveSessions())).toHaveLength(0);
  });

  it('tells the third learner the runner is busy, in the sentence the product already uses', async () => {
    process.env.PREVIEW_SESSIONS = '2';
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');
    await h.service.start('learner-2', 'phase-2');

    const third = await h.service.start('learner-3', 'phase-3');

    expect(third.status).toBe('busy');
    expect(third.message).toBe(SANDBOX_BUSY_MESSAGE);
    expect(third.url).toBeNull();
    expect(h.sandbox.started).toHaveLength(2);
  });

  it('says so plainly on the Lambda transport, without calling a runner at all', async () => {
    process.env.RUNNER_MODE = 'lambda';
    const h = await harness();

    const started = await h.service.start('learner-1', 'phase-1');

    expect(started.status).toBe('unavailable');
    expect(started.message).toBe(PREVIEW_UNAVAILABLE_MESSAGE);
    expect(h.sandbox.started).toHaveLength(0);
  });

  it('says so plainly when the runner cannot isolate an app, without calling a runner at all', async () => {
    // macOS, and any host whose runner reports no kernel boundary: Submit
    // says "The code runner cannot provide kernel isolation on this host".
    // Run app must say the same at once, not "Your app could not be started.
    // Try again in a moment." after half a minute or "Every seat is taken":
    // neither would be true, and trying again could never succeed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sandbox = require('../execution/sandbox.service');
    const h = await harness();
    sandbox.noteRunnerIsolation('local', { status: 'unsupported', mechanism: 'none' });
    try {
      expect(sandbox.previewUnsupported()).toBe('isolation');
      const started = await h.service.start('learner-1', 'phase-1');
      expect(started.status).toBe('unavailable');
      expect(started.message).toBe(PREVIEW_ISOLATION_MESSAGE);
      expect(started.url).toBeNull();
      expect(h.sandbox.started).toHaveLength(0);
      expect(h.sandbox.ownerLookups).toHaveLength(0);
      // No row: nothing reserved, so nothing is left to clean up.
      expect(await h.service.liveSessions()).toHaveLength(0);
    } finally {
      sandbox.noteRunnerIsolation('local', { status: 'unknown', mechanism: 'unknown' });
    }
  });

  // After an API restart on macOS the isolation report is not in until a run
  // answers; a Run app that spawned the local runner regardless would wait on
  // it twice, answer "turned off" after ~30 s, and leave a seat held by a row
  // no runner ever saw. The runner's own health says it
  // cannot isolate; a start that learns so on the way says so, and reserves
  // nothing on a transport that is not there.
  it('says so plainly when the runner reports no isolation on the way to the first start, and holds no seat', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sandbox = require('../execution/sandbox.service');
    const h = await harness({
      socket: async () => {
        sandbox.noteRunnerIsolation('local', { status: 'unsupported', mechanism: 'none' });
        return null;
      },
    });
    try {
      expect(sandbox.previewUnsupported()).toBeNull();
      const started = await h.service.start('learner-1', 'phase-1');
      expect(started.status).toBe('unavailable');
      expect(started.message).toBe(PREVIEW_ISOLATION_MESSAGE);
      expect(h.sandbox.started).toHaveLength(0);
      expect(h.sandbox.ownerLookups).toHaveLength(0);
      expect(await h.service.liveSessions()).toHaveLength(0);
    } finally {
      sandbox.noteRunnerIsolation('local', { status: 'unknown', mechanism: 'unknown' });
    }
  });

  it('never says "turned off" about a runner that could not be reached, and holds no seat for it', async () => {
    process.env.PREVIEW_SESSIONS = '1';
    const h = await harness({ socket: async () => null });
    const first = await h.service.start('learner-1', 'phase-1');
    expect(first.status).toBe('unavailable');
    expect(first.message).toBe(PREVIEW_RUNNER_UNAVAILABLE_MESSAGE);
    expect(first.message).not.toBe(PREVIEW_DISABLED_MESSAGE);
    expect(h.sandbox.started).toHaveLength(0);
    expect(await h.service.liveSessions()).toHaveLength(0);
    // Nobody else is told the class is using a seat nobody holds.
    const second = await h.service.start('learner-2', 'phase-2');
    expect(second.message).not.toBe(SANDBOX_BUSY_MESSAGE);
  });

  it('never says "turned off" when the transport failed after the seat was taken', async () => {
    const h = await harness();
    h.sandbox.next.push(view({ id: '', status: 'unavailable', message: 'The preview runner is unavailable. Your saved work is unchanged.' }));
    const started = await h.service.start('learner-1', 'phase-1');
    expect(started.status).toBe('unavailable');
    expect(started.message).toBe(PREVIEW_RUNNER_UNAVAILABLE_MESSAGE);
  });

  it('reads the socket runner’s own report of its boundary the same way', async () => {
    process.env.RUNNER_MODE = 'socket';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sandbox = require('../execution/sandbox.service');
    const h = await harness();
    try {
      // Not verified yet is not a refusal: a healthy host is not turned away
      // before its first probe has answered.
      expect(sandbox.previewUnsupported()).toBeNull();
      sandbox.noteRunnerIsolation('socket', { status: 'unsupported', mechanism: 'none' });
      expect(sandbox.previewUnsupported()).toBe('isolation');
      expect((await h.service.start('learner-1', 'phase-1')).message).toBe(PREVIEW_ISOLATION_MESSAGE);
      sandbox.noteRunnerIsolation('socket', { status: 'ok', mechanism: 'single-job-microvm' });
      expect(sandbox.previewUnsupported()).toBeNull();
    } finally {
      sandbox.noteRunnerIsolation('socket', { status: 'unknown', mechanism: 'unknown' });
    }
  });

  it('records one audit row for the start and one for the stop, and none in between', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');
    await h.service.status('learner-1', 'phase-1');
    await h.service.stop('learner-1', 'phase-1');

    expect(h.audits.map((row) => row.event)).toEqual(['preview.start', 'preview.stop']);
    expect(h.audits[0].targetId).toBe('phase-1');
    expect(h.audits[1].detail?.stopReason).toBe('learner');
  });
});

/**
 * Rebuild preview (a second start while the learner's own app runs). The
 * stop's single ask can come back unconfirmed, so the replaced row keeps its
 * seat, and a reservation made at once would refuse the learner because of
 * their own stopped app ("Every seat is taken … busy with the rest of the
 * class", with one learner on a ten-seat host). The press asks again for a
 * few seconds; the seat is still released only on the runner's confirmation,
 * and when that does not come the answer says what is true.
 */
describe('a press while the learner’s own app is still stopping', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PreviewSessionEntity } = require('./preview-session.entity') as typeof import('./preview-session.entity');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module_ = require('./preview.service') as typeof import('./preview.service');
  const WAIT_AT_LOAD = { ...module_.OWN_STOP_WAIT };
  afterEach(() => { Object.assign(module_.OWN_STOP_WAIT, WAIT_AT_LOAD); });

  /** Every stop the service sends the runner, timed, with an optional delay and a hook. */
  const recordStops = (h: Harness, each: (asks: number) => void = () => undefined, delayMs = 0) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox = (h.service as any).sandbox as { stopApp: (id: string, reason: string) => Promise<void> };
    const real = sandbox.stopApp.bind(sandbox);
    const at: number[] = [];
    sandbox.stopApp = async (id, reason) => {
      at.push(Date.now());
      each(at.length);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      return real(id, reason);
    };
    return at;
  };
  const row = (h: Harness, id: string) => h.dataSource.manager.findOneByOrFail(PreviewSessionEntity, { id });

  it('lands on the first press once the runner confirms the old app gone on a later ask, with one seat held', async () => {
    process.env.PREVIEW_SESSIONS = '10';
    const options = { stopConfirmed: false };
    const h = await harness(options);
    const first = await h.service.start('learner-1', 'phase-1');
    // The stop's own ask is unconfirmed; the second ask hears the app gone.
    const stops = recordStops(h, asks => { if (asks >= 2) options.stopConfirmed = true; });

    const second = await h.service.start('learner-1', 'phase-1');

    expect(second.status).toBe('starting');
    expect(second.url).toMatch(/^\/api\/v1\/preview\//);
    expect(stops).toHaveLength(2);
    const live = await h.service.liveSessions();
    expect(live.map(r => r.id)).toEqual([second.id]);
    // The press's own extra ask is not counted against the clean-up bound.
    const old = await row(h, first.id);
    expect(old).toMatchObject({ status: 'stopped', cleanupPending: false });
    expect(old.state.cleanupAttempts).toBe(1);
  });

  it('says the learner’s own preview is still stopping, never the class, and books no second seat, when the runner does not confirm', async () => {
    process.env.PREVIEW_SESSIONS = '1';
    const options = { stopConfirmed: false };
    // Shortened: the production wait is pinned by the sizing case below.
    Object.assign(module_.OWN_STOP_WAIT, { asks: 4, pauseMs: 50, lastAskMs: 1_000, ceilingMs: 2_000 });
    const h = await harness(options);
    const first = await h.service.start('learner-1', 'phase-1');
    const stops = recordStops(h);
    const pressed = Date.now();

    const second = await h.service.start('learner-1', 'phase-1');

    expect(Date.now() - pressed).toBeLessThan(module_.OWN_STOP_WAIT.ceilingMs);
    expect(second.status).toBe('busy');
    // Word for word what the panel matches (web copy.ts OWN_STOPPING_MESSAGE).
    expect(second.message).toBe('Your earlier preview is still stopping. Your work is saved. Try again in a moment.');
    expect(second.message).not.toBe(SANDBOX_BUSY_MESSAGE);
    // The panel titles it by the `reason` field; the whole sentence also
    // stays in `message`, for a client that reads only the message.
    expect(second.reason).toBe('own-preview-stopping');
    expect(second.url).toBeNull();
    // Bounded: the stop's ask and at most OWN_STOP_WAIT.asks more.
    expect(stops).toHaveLength(1 + module_.OWN_STOP_WAIT.asks);
    // Nothing launched and nothing reserved: the old row alone holds the seat.
    expect(h.sandbox.started).toHaveLength(1);
    expect((await h.service.liveSessions()).map(r => r.id)).toEqual([first.id]);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(1);
    // Another learner, with the one seat held by someone else, keeps the class's sentence.
    const other = await h.service.start('learner-2', 'phase-2');
    expect(other.status).toBe('busy');
    expect(other.message).toBe(SANDBOX_BUSY_MESSAGE);
    // The class-full answer carries no `reason` key at all.
    expect('reason' in other).toBe(false);
    // Once the runner confirms, the next press lands.
    options.stopConfirmed = true;
    const third = await h.service.start('learner-1', 'phase-1');
    expect(third.status).toBe('starting');
    expect((await h.service.liveSessions()).map(r => r.id)).toEqual([third.id]);
  });

  it('begins no new ask once the window has passed, so a slow runner cannot hold the press', async () => {
    Object.assign(module_.OWN_STOP_WAIT, { asks: 50, pauseMs: 20, lastAskMs: 600, ceilingMs: 5_000 });
    const h = await harness({ stopConfirmed: false });
    await h.service.start('learner-1', 'phase-1');
    const stops = recordStops(h, () => undefined, 200);
    const pressed = Date.now();

    const second = await h.service.start('learner-1', 'phase-1');

    expect(second.message).toBe(module_.PREVIEW_OWN_STOPPING_MESSAGE);
    expect(stops.length).toBeGreaterThan(1);
    expect(stops.length).toBeLessThan(50);
    for (const at of stops) expect(at - pressed).toBeLessThan(600);
    // The window plus at most one ask that began inside it.
    expect(Date.now() - pressed).toBeLessThan(600 + 200 + 300);
  });

  it('answers by the ceiling when the runner hangs on a re-ask, and the abandoned ask frees nothing', async () => {
    Object.assign(module_.OWN_STOP_WAIT, { asks: 8, pauseMs: 20, lastAskMs: 200, ceilingMs: 400 });
    const h = await harness({ stopConfirmed: false });
    const first = await h.service.start('learner-1', 'phase-1');
    // The press's own stop answers (unconfirmed); every re-ask after it hangs
    // until the test lets it go.
    let release: () => void = () => undefined;
    const hung = new Promise<void>(resolve => { release = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox = (h.service as any).sandbox as { stopApp: (id: string, reason: string) => Promise<void> };
    const real = sandbox.stopApp.bind(sandbox);
    let stops = 0;
    sandbox.stopApp = async (id, reason) => {
      stops += 1;
      if (stops >= 2) await hung;
      return real(id, reason);
    };
    const pressed = Date.now();

    const second = await h.service.start('learner-1', 'phase-1');

    const took = Date.now() - pressed;
    expect(took).toBeGreaterThanOrEqual(400 - 20);
    expect(took).toBeLessThan(400 + 300);
    expect(second.status).toBe('busy');
    expect(second.message).toBe(module_.PREVIEW_OWN_STOPPING_MESSAGE);
    expect(stops).toBe(2);
    // The deadline freed nothing: the old row keeps its seat, its one counted
    // miss is the press's own stop, and nothing was launched.
    const held = await row(h, first.id);
    expect(held).toMatchObject({ status: 'stopped', cleanupPending: true });
    expect(held.state.cleanupAttempts).toBe(1);
    expect(h.sandbox.started).toHaveLength(1);
    expect((await h.service.liveSessions()).map(r => r.id)).toEqual([first.id]);

    // Let the abandoned ask finish, unconfirmed: still uncounted, still held,
    // and no ask begins after the press has answered.
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(stops).toBe(2);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(1);
    expect((await h.service.liveSessions()).map(r => r.id)).toEqual([first.id]);
  });

  it('is sized from the live host: the measured case lands with margin and the press stays inside the client’s 20 s', () => {
    const { asks, pauseMs, lastAskMs, ceilingMs } = WAIT_AT_LOAD;
    // The bridge's stop answers about 3.1 s after the press; the provider
    // confirmed between about 3 s and 6 s. Two bridge re-asks (get, terminate,
    // get: about 3 s) fit between the first answer and the last ask.
    expect(3_100 + pauseMs + 3_000 + pauseMs).toBeLessThan(lastAskMs);
    // Answers that come back at once still reach the last ask, not run out early.
    expect(3_100 + asks * pauseMs).toBeGreaterThanOrEqual(lastAskMs - pauseMs);
    expect(lastAskMs).toBeLessThan(ceilingMs);
    // The web client gives up at 20 s (apps/web/lib/api.ts REQUEST_TIMEOUT_MS);
    // the ceiling leaves the reservation and the launch request eight seconds.
    expect(ceilingMs).toBeLessThanOrEqual(12_000);
  });

  it('tells a second tab the learner’s own start is still launching, not that the class is busy', async () => {
    let launch: (answer: SandboxAppSession) => void = () => undefined;
    const h = await harness({ start: new Promise<SandboxAppSession>(resolve => { launch = resolve; }) });
    // Tab A's start has its seat and is waiting on the runner: no runner id yet.
    const tabA = h.service.start('learner-1', 'phase-1');
    while (!h.sandbox.started.length) await new Promise(resolve => setImmediate(resolve));

    const tabB = await h.service.start('learner-1', 'phase-1');

    expect(tabB.status).toBe('busy');
    expect(tabB.message).toBe('Your preview is already starting. Give it a moment.');
    expect(tabB.message).toBe(module_.PREVIEW_OWN_STARTING_MESSAGE);
    expect(tabB.reason).toBe('own-preview-starting');
    expect(tabB.url).toBeNull();
    // Nothing stopped, nothing launched twice; tab A's start goes on.
    expect(h.sandbox.stopped).toHaveLength(0);
    expect(h.sandbox.started).toHaveLength(1);
    launch(view({ status: 'starting' }));
    expect((await tabA).status).toBe('starting');
    expect(await h.service.liveSessions()).toHaveLength(1);
  });

  it('tells a press that finds the learner’s own new app starting that it is starting, not that the class is busy', async () => {
    const h = await harness();
    const first = await h.service.start('learner-1', 'phase-1');
    // While this press stops the first app, another start of the learner's
    // own (a second tab) reserves its seat and is named by the runner.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox = (h.service as any).sandbox as { stopApp: (id: string, reason: string) => Promise<void> };
    const real = sandbox.stopApp.bind(sandbox);
    const other = 'b'.repeat(24);
    sandbox.stopApp = async (id, reason) => {
      sandbox.stopApp = real;
      const now = Date.now();
      await h.dataSource.manager.save(PreviewSessionEntity, h.dataSource.manager.create(PreviewSessionEntity, {
        id: other, userId: 'learner-1', phaseStateId: 'phase-1', tokenVersion: 0, runnerId: 'run-tab-a',
        capabilityHash: 'c'.repeat(64), status: 'starting', cleanupPending: false, revision: 0,
        state: { bundleOk: true, message: null, stopReason: null, startedAt: now, readyAt: null, expiresAt: now + 60_000,
          lastSeenAt: now, bytesServed: 0, forgetAt: null, buildMs: 0, launchDeadline: now + 60_000, builtFromVersion: null },
      }));
      return real(id, reason);
    };

    const second = await h.service.start('learner-1', 'phase-1');

    expect(second.status).toBe('busy');
    expect(second.message).toBe(module_.PREVIEW_OWN_STARTING_MESSAGE);
    expect(second.reason).toBe('own-preview-starting');
    // One learner, one live app: the other tab's; nothing launched by this press.
    expect(h.sandbox.started).toHaveLength(1);
    expect((await h.service.liveSessions()).map(r => r.id)).toEqual([other]);
    expect((await row(h, first.id)).cleanupPending).toBe(false);
  });

  it('adds no asks of its own once the row’s counted asks have reached the back-off (a runner in trouble)', async () => {
    Object.assign(module_.OWN_STOP_WAIT, { asks: 3, pauseMs: 10, lastAskMs: 2_000, ceilingMs: 4_000 });
    const h = await harness({ stopConfirmed: false });
    const first = await h.service.start('learner-1', 'phase-1');
    const stops = recordStops(h);
    const asked = async () => {
      const before = stops.length;
      const answer = await h.service.start('learner-1', 'phase-1');
      expect(answer.message).toBe(module_.PREVIEW_OWN_STOPPING_MESSAGE);
      return stops.length - before;
    };

    // Each press makes one counted ask (the stop) and, while the misses are
    // under the back-off, a few uncounted ones of its own.
    expect(await asked()).toBe(1 + 3);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(1);
    expect(await asked()).toBe(1 + 3);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(2);
    // The third counted miss reaches CLEANUP_IMMEDIATE_ATTEMPTS: no extra asks.
    expect(await asked()).toBe(1);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(module_.CLEANUP_IMMEDIATE_ATTEMPTS);
    // Inside the back-off the press asks nothing at all.
    expect(await asked()).toBe(0);
    // The seat is still the old row's alone.
    expect((await h.service.liveSessions()).map(r => r.id)).toEqual([first.id]);
  });

  it.each([
    ['its stop', 'stopApp'],
    ['the status read after its stop', 'statusApp'],
  ] as const)('keeps the press whole when a re-ask throws in %s: no rejection, the old row holds its seat, nothing counted, and the press says the learner’s own preview is still stopping', async (_where, method) => {
    Object.assign(module_.OWN_STOP_WAIT, { asks: 8, pauseMs: 20, lastAskMs: 200, ceilingMs: 400 });
    const h = await harness({ stopConfirmed: false });
    const first = await h.service.start('learner-1', 'phase-1');
    // The press's own stop answers (unconfirmed); from its first re-ask on,
    // the runner errors mid-ask.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox = (h.service as any).sandbox as Record<typeof method, (...args: unknown[]) => Promise<unknown>>;
    const real = sandbox[method].bind(sandbox);
    let calls = 0;
    sandbox[method] = async (...args) => {
      calls += 1;
      if (calls >= 2) throw new Error('runner socket reset mid-ask');
      return real(...args);
    };
    const warned: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn((h.service as any).logger, 'warn').mockImplementation((message: unknown) => { warned.push(String(message)); });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const pressed = Date.now();

      const second = await h.service.start('learner-1', 'phase-1');

      const took = Date.now() - pressed;
      // Give a stray rejection the turns it needs to surface.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      // The error was the settle's, logged, and not the press's.
      expect(warned).toContain('preview own-stop settle: runner socket reset mid-ask');
      expect(took).toBeLessThan(module_.OWN_STOP_WAIT.ceilingMs);
      expect(second.status).toBe('busy');
      expect(second.message).toBe(module_.PREVIEW_OWN_STOPPING_MESSAGE);
      expect(second.reason).toBe('own-preview-stopping');
      expect(second.url).toBeNull();
      // One ask that threw and none after it.
      expect(calls).toBe(2);
      // The old row keeps its seat; its one counted miss is the press's own
      // stop, and the uncounted re-ask that threw added none; nothing launched.
      const held = await row(h, first.id);
      expect(held).toMatchObject({ status: 'stopped', cleanupPending: true });
      expect(held.state.cleanupAttempts).toBe(1);
      expect(h.sandbox.started).toHaveLength(1);
      expect((await h.service.liveSessions()).map(r => r.id)).toEqual([first.id]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /**
   * OWN_STOP_WAIT's sizing as behaviour: a runner that confirms the
   * old app gone T after the press, at the live host's measured T (3 to 6 s)
   * and the 8 s the wait is sized for, lands on the first press; one that
   * never confirms gets the "still stopping" refusal; every press answers
   * inside the ceiling.
   *
   * Scaled 1:5 in time so the suite stays fast, with every proportion kept:
   *   asks 8 → 8; pause 750 ms → 150 ms; last ask 9 s → 1 800 ms; ceiling
   *   12 s → 2 400 ms (the production values, divided by SCALE);
   *   the bridge's own stop, about 3.1 s → 620 ms; a bridge re-ask (get,
   *   terminate, get), about 3 s → 600 ms; T = 4, 6, 8 s → 800, 1 200,
   *   1 600 ms. (1:10 left the bridge's never-confirmed press about 140 ms
   *   under its ceiling, which a GC pause in the in-band suite could eat.)
   * The fake reads the provider only when the ask's status is read, at the
   * end of the ask (the conservative case: the bridge's first get can see it
   * about two seconds earlier).
   */
  describe('sized from the live host, as behaviour', () => {
    const SCALE = 5;
    const BRIDGE_STOP_MS = 3_100 / SCALE;
    const BRIDGE_REASK_MS = 3_000 / SCALE;
    const sleep = (ms: number) => (ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

    /** One Rebuild press against a runner that confirms `confirmAfterMs` (real) after it, or never. */
    const press = async (reAskMs: number, confirmAfterMs: number | null) => {
      expect(WAIT_AT_LOAD).toEqual({ asks: 8, pauseMs: 750, lastAskMs: 9_000, ceilingMs: 12_000 });
      Object.assign(module_.OWN_STOP_WAIT, {
        asks: WAIT_AT_LOAD.asks,
        pauseMs: WAIT_AT_LOAD.pauseMs / SCALE,
        lastAskMs: WAIT_AT_LOAD.lastAskMs / SCALE,
        ceilingMs: WAIT_AT_LOAD.ceilingMs / SCALE,
      });
      const h = await harness();
      const first = await h.service.start('learner-1', 'phase-1');
      const oldRunner = (await row(h, first.id)).runnerId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sandbox = (h.service as any).sandbox as {
        stopApp: (id: string, reason: string) => Promise<void>;
        statusApp: (id: string, cursor: number) => Promise<SandboxAppSession>;
      };
      const realStop = sandbox.stopApp.bind(sandbox);
      const realStatus = sandbox.statusApp.bind(sandbox);
      let pressed = 0;
      let stops = 0;
      sandbox.stopApp = async (id, reason) => {
        stops += 1;
        await sleep(stops === 1 ? BRIDGE_STOP_MS : reAskMs);
        return realStop(id, reason);
      };
      sandbox.statusApp = async (id, cursor) => (id === oldRunner
        ? view({ id, status: 'stopped', cleanupConfirmed: confirmAfterMs !== null && Date.now() - pressed >= confirmAfterMs / SCALE })
        : realStatus(id, cursor));
      pressed = Date.now();
      const second = await h.service.start('learner-1', 'phase-1');
      return { h, first, second, took: Date.now() - pressed, stops };
    };

    describe.each([
      ['the MicroVM bridge (each re-ask about 3 s)', BRIDGE_REASK_MS],
      ['a runner whose re-asks answer at once', 0],
    ])('against %s', (_runner, reAskMs) => {
      it.each([4_000, 6_000, 8_000])('lands on the first press when the runner confirms %i ms after it', async confirmAfterMs => {
        const { h, first, second, took, stops } = await press(reAskMs, confirmAfterMs);

        expect(took).toBeLessThan(module_.OWN_STOP_WAIT.ceilingMs);
        expect(second.status).toBe('starting');
        expect(second.url).toMatch(/^\/api\/v1\/preview\//);
        // A new session reserved and started; the old one confirmed gone by a
        // re-ask, its one counted miss the press's own stop.
        expect(stops).toBeGreaterThan(1);
        expect(h.sandbox.started).toHaveLength(2);
        expect((await h.service.liveSessions()).map(r => r.id)).toEqual([second.id]);
        const old = await row(h, first.id);
        expect(old).toMatchObject({ status: 'stopped', cleanupPending: false });
        expect(old.state.cleanupAttempts).toBe(1);
      });

      it('answers the “still stopping” refusal inside the ceiling when the runner never confirms', async () => {
        const { h, first, second, took } = await press(reAskMs, null);

        expect(took).toBeLessThan(module_.OWN_STOP_WAIT.ceilingMs);
        expect(second.status).toBe('busy');
        expect(second.message).toBe(module_.PREVIEW_OWN_STOPPING_MESSAGE);
        expect(second.reason).toBe('own-preview-stopping');
        expect(h.sandbox.started).toHaveLength(1);
        expect((await h.service.liveSessions()).map(r => r.id)).toEqual([first.id]);
        expect((await row(h, first.id)).state.cleanupAttempts).toBe(1);
      });
    });
  });

  it('accepted behaviour: while a re-ask abandoned at the ceiling is still out, the next press’s own unconfirmed ask counts one miss; the abandoned ask’s late confirmation frees nothing and touches no other row; only a later ask that hears the confirmation frees the seat', async () => {
    process.env.PREVIEW_SESSIONS = '10';
    Object.assign(module_.OWN_STOP_WAIT, { asks: 8, pauseMs: 20, lastAskMs: 200, ceilingMs: 400 });
    const options = { stopConfirmed: false };
    const h = await harness(options);
    // Another learner's live app, which nothing below may touch.
    const bystander = await h.service.start('learner-2', 'phase-2');
    const first = await h.service.start('learner-1', 'phase-1');
    const oldRunner = (await row(h, first.id)).runnerId;
    // Ask 1 (press A's own stop) answers unconfirmed; ask 2 (press A's first
    // re-ask) hangs until released, as on the bridge when the per-operation
    // claim is held; every later ask answers at once.
    let release: () => void = () => undefined;
    const hung = new Promise<void>(resolve => { release = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox = (h.service as any).sandbox as { stopApp: (id: string, reason: string) => Promise<void> };
    const real = sandbox.stopApp.bind(sandbox);
    let asks = 0;
    sandbox.stopApp = async (id, reason) => {
      asks += 1;
      if (asks === 2) await hung;
      return real(id, reason);
    };
    const stopsOfOld = () => h.sandbox.stopped.filter(stop => stop.id === oldRunner).length;

    // Press A: its re-ask is abandoned at the ceiling, still out.
    const pressA = await h.service.start('learner-1', 'phase-1');
    expect(pressA.reason).toBe('own-preview-stopping');
    expect(asks).toBe(2);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(1);

    // Press B, the abandoned ask still out: its own first ask comes back
    // unconfirmed and counts one miss (its re-asks are uncounted).
    const pressB = await h.service.start('learner-1', 'phase-1');
    expect(pressB.reason).toBe('own-preview-stopping');
    expect(asks).toBeGreaterThan(3);
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(2);

    // The abandoned ask resolves, and the runner now confirms: the ask
    // completes and hears it, but its row snapshot predates press B's counted
    // miss, so it frees nothing by itself and writes no row at all.
    const oldBefore = await row(h, first.id);
    const bystanderBefore = await row(h, bystander.id);
    const stopsBefore = stopsOfOld();
    options.stopConfirmed = true;
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(stopsOfOld()).toBe(stopsBefore + 1);
    const oldAfter = await row(h, first.id);
    expect(oldAfter).toMatchObject({ status: 'stopped', cleanupPending: true, revision: oldBefore.revision });
    expect(oldAfter.state).toEqual(oldBefore.state);
    expect(await row(h, bystander.id)).toEqual(bystanderBefore);
    expect(h.sandbox.stopped.map(stop => stop.id)).not.toContain(bystanderBefore.runnerId);
    expect((await h.service.liveSessions()).map(r => r.id).sort()).toEqual([bystander.id, first.id].sort());

    // Only a later ask that hears the confirmation frees the seat: the next press's.
    const pressC = await h.service.start('learner-1', 'phase-1');
    expect(pressC.status).toBe('starting');
    expect(await row(h, first.id)).toMatchObject({ status: 'stopped', cleanupPending: false });
    expect((await row(h, first.id)).state.cleanupAttempts).toBe(2);
    expect((await h.service.liveSessions()).map(r => r.id).sort()).toEqual([bystander.id, pressC.id].sort());
  });
});

describe('the save a preview was built from', () => {
  const FIRST = '2026-11-08T10:00:00.000Z';
  const APPLIED = '2026-11-08T10:04:30.000Z';

  it('records the workspace save the start built from and answers it on the start and on every poll', async () => {
    const h = await harness();
    h.setSaved(FIRST);
    const started = await h.service.start('learner-1', 'phase-1');
    expect(started.builtFromVersion).toBe(FIRST);
    expect(started.workspaceVersion).toBe(FIRST);

    const polled = await h.service.status('learner-1', 'phase-1');
    expect(polled?.builtFromVersion).toBe(FIRST);
    expect(polled?.workspaceVersion).toBe(FIRST);
  });

  it('answers the newer save on the poll after an apply, while the running app keeps the build it started with', async () => {
    const h = await harness();
    h.setSaved(FIRST);
    await h.service.start('learner-1', 'phase-1');
    h.setSaved(APPLIED);

    const polled = await h.service.status('learner-1', 'phase-1');
    expect(polled?.status).toBe('ready');
    expect(polled?.builtFromVersion).toBe(FIRST);
    expect(polled?.workspaceVersion).toBe(APPLIED);
  });

  it('names a never-saved workspace as null on both sides', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    expect(started.builtFromVersion).toBeNull();
    expect(started.workspaceVersion).toBeNull();
  });

  it('rebuilds by a second start: the old app is stopped first, one seat is held, and the new build names the current save', async () => {
    process.env.PREVIEW_SESSIONS = '1';
    const h = await harness();
    h.setSaved(FIRST);
    const first = await h.service.start('learner-1', 'phase-1');
    h.setSaved(APPLIED);
    const second = await h.service.start('learner-1', 'phase-1');

    expect(second.id).not.toBe(first.id);
    expect(second.url).toMatch(/^\/api\/v1\/preview\//);
    expect(h.sandbox.stopped).toHaveLength(1);
    expect(await h.service.liveSessions()).toHaveLength(1);
    expect(second.builtFromVersion).toBe(APPLIED);
    expect(second.workspaceVersion).toBe(APPLIED);
    // The same job as any start: the limits are the configured ones.
    const jobs = h.sandbox.started as Record<string, unknown>[];
    expect(jobs).toHaveLength(2);
    expect(jobs[1].ttlSeconds).toBe(jobs[0].ttlSeconds);
    expect(jobs[1].idleSeconds).toBe(jobs[0].idleSeconds);
    expect(jobs[1].memoryMb).toBe(jobs[0].memoryMb);
    // Another learner is still refused the one seat while it is held.
    const other = await h.service.start('learner-2', 'phase-2');
    expect(other.status).toBe('busy');
  });

  it('makes no claim about a row written before the field', async () => {
    const h = await harness();
    h.setSaved(FIRST);
    const started = await h.service.start('learner-1', 'phase-1');
    const { PreviewSessionEntity } = require('./preview-session.entity') as typeof import('./preview-session.entity');
    const row = await h.dataSource.manager.findOneByOrFail(PreviewSessionEntity, { id: started.id });
    delete row.state.builtFromVersion;
    await h.dataSource.manager.save(PreviewSessionEntity, row);

    const polled = await h.service.status('learner-1', 'phase-1');
    expect(polled).not.toHaveProperty('builtFromVersion');
    expect(polled?.workspaceVersion).toBe(FIRST);
  });
});

describe('the capability', () => {
  it('revokes the owner capability through shared authority even while runner cleanup is pending, leaving another learner live', async () => {
    process.env.PREVIEW_SESSIONS = '2';
    let stopped!: () => void;
    const stop = new Promise<void>(resolve => { stopped = resolve; });
    const h = await harness({ stop });
    const first = await h.service.start('learner-1', 'phase-1');
    const second = await h.service.start('learner-2', 'phase-2');
    const cap = (url: string | null) => String(url).split('/').filter(Boolean).pop() as string;
    expect(await h.service.resolve(cap(first.url))).not.toBeNull();
    expect(await h.service.resolve(cap(second.url))).not.toBeNull();
    await h.revoke('learner-1');
    expect(await h.service.resolve(cap(first.url))).toBeNull();
    expect(await h.service.resolve(cap(second.url))).not.toBeNull();
    stopped();
  });

  it('does not resurrect a revoked capability from an older in-flight status poll', async () => {
    let answer!: (value: SandboxAppSession) => void;
    const status = new Promise<SandboxAppSession>(resolve => { answer = resolve; });
    const h = await harness({ status });
    const started = await h.service.start('learner-1', 'phase-1');
    const capability = String(started.url).split('/').filter(Boolean).pop() as string;
    const poll = h.service.status('learner-1', 'phase-1');
    await Promise.resolve();
    await h.revoke('learner-1');
    answer(view({ status: 'ready' }));
    await expect(poll).resolves.toMatchObject({ status: 'stopped', url: null });
    expect(await h.service.resolve(capability)).toBeNull();
  });

  it('withholds the start reply when revocation happens during its audit write', async () => {
    let audited!: () => void;
    const auditStart = new Promise<void>(resolve => { audited = resolve; });
    let auditEntered!: () => void;
    const atAudit = new Promise<void>(resolve => { auditEntered = resolve; });
    const h = await harness({ auditStart, auditEntered });
    const request = h.service.start('learner-1', 'phase-1');
    await atAudit;
    await h.revoke('learner-1'); audited();
    await expect(request).rejects.toThrow('signed out');
    expect((await h.service.liveSessions())).toHaveLength(0);
  });

  it('stops a runner that returns after revocation without handing out a new capability', async () => {
    let started!: (answer: SandboxAppSession) => void;
    const start = new Promise<SandboxAppSession>(resolve => { started = resolve; });
    const h = await harness({ start });
    const request = h.service.start('learner-1', 'phase-1');
    while (h.sandbox.started.length === 0) await Promise.resolve();
    await h.revoke('learner-1');
    started(view({ id: 'late-revoked-runner', status: 'ready' }));
    await expect(request).rejects.toThrow('signed out');
    expect((await h.service.liveSessions())).toHaveLength(0);
    // Cleanup is deliberately idempotent across replicas: more than one observer
    // may request the same stop, but every request targets only this runner.
    expect(h.sandbox.stopped.length).toBeGreaterThanOrEqual(1);
    expect(h.sandbox.stopped.every(row => row.id === 'late-revoked-runner' && row.reason === 'learner')).toBe(true);
    expect(h.audits.filter(row => row.event === 'preview.stop')).toHaveLength(1);
  });
  it('opens the session it was minted for', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    const capability = String(started.url).split('/').filter(Boolean).pop();

    expect(await h.service.resolve(capability as string)).not.toBeNull();
  });

  it('is stored hashed, so nothing that reads the register can open an app', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    const capability = String(started.url).split('/').filter(Boolean).pop() as string;

    const register = JSON.stringify((await h.service.liveSessions()));
    expect(register).not.toContain(capability);
    // What is kept is a sha256 digest of it, and only that: asserted against
    // the digest itself rather than against "does not look like the string",
    // which any encoding of the plaintext would also pass.
    expect((await h.service.liveSessions())[0].capabilityHash).toEqual(
      createHash('sha256').update(capability, 'utf-8').digest('hex'),
    );
  });

  it('opens nothing else: a wrong guess of the same shape is refused', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    const capability = String(started.url).split('/').filter(Boolean).pop() as string;
    const wrong = `${capability.slice(0, -1)}${capability.endsWith('A') ? 'B' : 'A'}`;

    expect(await h.service.resolve(wrong)).toBeNull();
    expect(await h.service.resolve('')).toBeNull();
    // The door runs before any check can happen, so an unbounded probe is
    // refused before it is even hashed.
    expect(await h.service.resolve('x'.repeat(50_000))).toBeNull();
  });

  it('is revoked by a stop the runner made on its own, which nothing here reset', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    const capability = String(started.url).split('/').filter(Boolean).pop() as string;

    // The runner's own sweep hit the idle cap; the API learns about it on the
    // next poll and never calls `finish`, so the status check is the only
    // thing standing between that capability and a running app.
    h.sandbox.statusAnswer = view({ status: 'stopped', stopReason: 'idle' });
    await h.service.status('learner-1', 'phase-1');

    expect(await h.service.resolve(capability)).toBeNull();
  });

  it('dies with the session: Stop revokes it', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    const capability = String(started.url).split('/').filter(Boolean).pop() as string;

    await h.service.stop('learner-1', 'phase-1');

    expect(await h.service.resolve(capability)).toBeNull();
    expect(h.sandbox.stopped).toHaveLength(1);
    expect(h.sandbox.stopped[0].reason).toBe('learner');
  });
});

describe('the status poll', () => {
  it('is null when the learner has never started anything', async () => {
    const h = await harness();
    await expect(h.service.status('learner-1', 'phase-1')).resolves.toBeNull();
  });

  it('counts as a touch, so idle means the tab is closed rather than quiet', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-05T10:00:00.000Z'));
    try {
      const h = await harness();
      const started = await h.service.start('learner-1', 'phase-1');
      jest.setSystemTime(new Date('2026-09-05T10:04:00.000Z'));
      const polled = await h.service.status('learner-1', 'phase-1');

      expect(Date.parse(String(polled?.idleExpiresAt))).toBeGreaterThan(
        Date.parse(String(started.idleExpiresAt)),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps saying ready when a poll cannot reach the runner', async () => {
    const h = await harness();
    h.sandbox.next.push(view({ status: 'ready' }));
    await h.service.start('learner-1', 'phase-1');
    h.sandbox.statusAnswer = view({ status: 'unavailable', message: 'socket gone' });

    const polled = await h.service.status('learner-1', 'phase-1');

    // A poll that failed says nothing about the app; overwriting `ready` with
    // `unavailable` would tell the learner their app had stopped when it had not.
    expect(polled?.status).toBe('ready');
  });

  it('carries the reason and the console of a session the runner stopped by itself', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');
    h.sandbox.statusAnswer = view({
      status: 'stopped',
      stopReason: 'budget',
      console: [{ stream: 'err', text: 'Traceback', at: '2026-09-05T10:00:00.000Z' }],
      cursor: 3,
    });

    const polled = await h.service.status('learner-1', 'phase-1');

    expect(polled?.status).toBe('stopped');
    expect(polled?.stopReason).toBe('budget');
    expect(polled?.console).toEqual([
      { stream: 'err', text: 'Traceback', at: '2026-09-05T10:00:00.000Z' },
    ]);
    expect(polled?.cursor).toBe(3);
  });
});

describe('the sweep', () => {
  it('stops a session that has run its ten minutes', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');

    const stopped = await h.service.sweep(Date.now() + 11 * 60_000);

    expect(stopped).toBe(1);
    expect(h.sandbox.stopped[0].reason).toBe('expired');
    expect((await h.service.liveSessions())).toHaveLength(0);
  });

  it('stops one nobody has looked at for five minutes', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');

    const stopped = await h.service.sweep(Date.now() + 6 * 60_000);

    expect(stopped).toBe(1);
    expect(h.sandbox.stopped[0].reason).toBe('idle');
  });

  it('leaves a session that is inside both caps alone', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');

    expect(await h.service.sweep(Date.now() + 60_000)).toBe(0);
    expect((await h.service.liveSessions())).toHaveLength(1);
  });

  it('forgets a stopped session once its last words have been read', async () => {
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');
    await h.service.stop('learner-1', 'phase-1');

    // Still readable a minute later: the poll that discovers the stop is the
    // one that has to carry the reason.
    await h.service.sweep(Date.now() + 60_000);
    expect(await h.service.status('learner-1', 'phase-1')).not.toBeNull();

    await h.service.sweep(Date.now() + 10 * 60_000);
    expect(await h.service.status('learner-1', 'phase-1')).toBeNull();
  });

  it('stops every live session when the API goes down', async () => {
    process.env.PREVIEW_SESSIONS = '2';
    const h = await harness();
    await h.service.start('learner-1', 'phase-1');
    await h.service.start('learner-2', 'phase-2');

    expect(await h.service.stopAll('shutdown')).toBe(2);
    expect(h.sandbox.stopped.map((s) => s.reason)).toEqual(['shutdown', 'shutdown']);
    expect((await h.service.liveSessions())).toHaveLength(0);
  });
});


describe('durable cross-replica preview ownership', () => {
  const capability = (url: string | null) => String(url).split('/').filter(Boolean).pop()!;

  it('opens, polls and stops the same session through independent API services', async () => {
    const h = await harness();
    const second = h.replica();
    const started = await h.service.start('learner-1', 'phase-1');
    expect((await second.resolve(capability(started.url)))?.id).toBe(started.id);
    expect((await second.status('learner-1', 'phase-1'))?.id).toBe(started.id);
    await second.stop('learner-1', 'phase-1');
    expect(await h.service.resolve(capability(started.url))).toBeNull();
    expect((await h.service.status('learner-1', 'phase-1'))?.status).toBe('stopped');
  });

  it('refuses a capability after remote token rotation with no local notification', async () => {
    process.env.PREVIEW_SESSIONS = '2';
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    const other = await h.service.start('learner-2', 'phase-2');
    const { UserEntity } = require('../db/entities');
    await h.dataSource.manager.update(UserEntity, { id: 'learner-1' }, { tokenVersion: 1 });
    expect(await h.replica().resolve(capability(started.url))).toBeNull();
    expect(await h.replica().resolve(capability(other.url))).not.toBeNull();
    await expect(h.replica().start('learner-1', 'phase-1', 0)).rejects.toThrow('signed out');
    await h.service.sweep();
  });

  it('serializes a global one-slot reservation across services before either launches', async () => {
    process.env.PREVIEW_SESSIONS = '1';
    let release!: (answer: SandboxAppSession) => void;
    const held = new Promise<SandboxAppSession>(resolve => { release = resolve; });
    const h = await harness({ start: held });
    const first = h.service.start('learner-1', 'phase-1');
    while (h.sandbox.started.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const second = await h.replica().start('learner-2', 'phase-2');
    expect(second.status).toBe('busy');
    expect(h.sandbox.started).toHaveLength(1);
    release(view({ id: 'reserved-runner', status: 'ready' }));
    await expect(first).resolves.toMatchObject({ status: 'ready' });
  });

  it('does not cancel the first launch when a second replica receives a duplicate start', async () => {
    let release!: (answer: SandboxAppSession) => void;
    const held = new Promise<SandboxAppSession>(resolve => { release = resolve; });
    const h = await harness({ start: held });
    const first = h.service.start('learner-1', 'phase-1');
    while (h.sandbox.started.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
    expect((await h.replica().start('learner-1', 'phase-1')).status).toBe('busy');
    expect(h.sandbox.stopped).toHaveLength(0);
    release(view({ id: 'duplicate-start-runner', status: 'ready' }));
    await expect(first).resolves.toMatchObject({ status: 'ready' });
    expect(h.sandbox.started).toHaveLength(1);
  });

  it('does not resurrect a stopped row when a remote status response is delayed', async () => {
    let release!: (answer: SandboxAppSession) => void;
    const held = new Promise<SandboxAppSession>(resolve => { release = resolve; });
    const h = await harness({ status: held });
    const started = await h.service.start('learner-1', 'phase-1');
    const polling = h.replica().status('learner-1', 'phase-1');
    await new Promise<void>(resolve => setImmediate(resolve));
    await h.service.stop('learner-1', 'phase-1');
    release(view({ id: 'old-poll', status: 'ready' }));
    expect((await polling)?.status).toBe('stopped');
    expect(await h.replica().resolve(capability(started.url))).toBeNull();
  });

  it('fails closed on shared storage outage without using the last resolved capability', async () => {
    const h = await harness();
    const started = await h.service.start('learner-1', 'phase-1');
    expect(await h.replica().resolve(capability(started.url))).not.toBeNull();
    const { PreviewSessionEntity } = require('./preview-session.entity');
    jest.spyOn(h.dataSource.getRepository(PreviewSessionEntity), 'find').mockRejectedValueOnce(new Error('controlled preview storage outage'));
    await expect(h.replica().resolve(capability(started.url))).rejects.toThrow('controlled preview storage outage');
    expect(await h.replica().resolve(capability(started.url))).not.toBeNull();
  });

  it('recovers an ambiguous launch by its exact persisted owner trace, retaining capacity while lookup is unavailable', async () => {
    let found = false;
    const h = await harness({ lookup: async () => {
      if (!found) throw new Error('controlled lookup outage');
      return { found: true, runnerId: 'recovered-owned-runner', cleanupConfirmed: false };
    } });
    h.sandbox.next.push(view({ id: '', status: 'unavailable' }));
    expect((await h.service.start('learner-1', 'phase-1')).status).toBe('unavailable');
    const [pending] = await h.replica().liveSessions();
    expect(pending).toMatchObject({ runnerId: null, cleanupPending: true, status: 'stopped' });
    expect(h.sandbox.ownerLookups).toEqual([pending.id]);
    found = true;
    await h.replica().sweep();
    expect(await h.service.liveSessions()).toHaveLength(0);
    expect(h.sandbox.stopped).toEqual([{ id: 'recovered-owned-runner', reason: 'learner' }]);
    expect(h.sandbox.ownerLookups.every(id => id === pending.id)).toBe(true);
  });

  it('keeps a stopped-label reservation until cleanup is explicitly confirmed, including during a DB outage', async () => {
    const options = { stopConfirmed: false };
    const h = await harness(options);
    const started = await h.service.start('learner-1', 'phase-1');
    await h.replica().stop('learner-1', 'phase-1');
    expect((await h.service.liveSessions())[0]).toMatchObject({ id: started.id, cleanupPending: true, status: 'stopped' });
    const transaction = jest.spyOn(h.dataSource, 'transaction').mockRejectedValueOnce(new Error('controlled DB outage'));
    await expect(h.replica().sweep()).rejects.toThrow('controlled DB outage');
    transaction.mockRestore();
    expect((await h.service.liveSessions())[0]).toMatchObject({ id: started.id, cleanupPending: true });
    options.stopConfirmed = true;
    await h.replica().sweep();
    expect(await h.service.liveSessions()).toHaveLength(0);
  });

  it.each(['failed', 'stopped'] as const)('retains terminal %s launch evidence and capacity without cleanup confirmation', async status => {
    process.env.PREVIEW_SESSIONS = '1';
    const options = { stopConfirmed: false };
    const h = await harness(options);
    h.sandbox.next.push(view({ id: 'terminal-launch-runner', status, message: 'retained launch evidence',
      console: [{ stream: 'err', text: 'authored build diagnostic', at: '2026-09-16T00:00:00.000Z' }] }));
    const terminal = await h.service.start('learner-1', 'phase-1');
    expect(terminal).toMatchObject({ status, url: null, message: 'retained launch evidence' });
    expect(terminal.console[0].text).toBe('authored build diagnostic');
    expect(await h.replica().liveSessions()).toEqual([expect.objectContaining({ id: terminal.id, status, cleanupPending: true })]);
    expect((await h.replica().start('learner-2', 'phase-2')).status).toBe('busy');
    await h.replica().sweep(Date.now() + 24 * 60 * 60 * 1000);
    expect(await h.service.liveSessions()).toHaveLength(1);
    options.stopConfirmed = true;
    await h.replica().sweep();
    expect(await h.service.liveSessions()).toHaveLength(0);
  });

  it.each([
    ['failed', false], ['failed', undefined], ['stopped', false], ['stopped', undefined],
  ] as const)('does not release %s status capacity when cleanupConfirmed is %s', async (status, cleanupConfirmed) => {
    process.env.PREVIEW_SESSIONS = '1';
    const options = { stopConfirmed: false };
    const h = await harness(options);
    const started = await h.service.start('learner-1', 'phase-1');
    h.sandbox.statusAnswer = view({ status, cleanupConfirmed, message: 'retained status evidence' });
    expect(await h.replica().status('learner-1', 'phase-1')).toMatchObject({ status, url: null, message: 'retained status evidence' });
    expect(await h.service.liveSessions()).toEqual([expect.objectContaining({ id: started.id, status, cleanupPending: true })]);
    expect(await h.replica().resolve(capability(started.url))).toBeNull();
    expect((await h.replica().start('learner-2', 'phase-2')).status).toBe('busy');
    options.stopConfirmed = true;
    await h.replica().sweep();
    expect(await h.service.liveSessions()).toHaveLength(0);
  });

  it.each(['start', 'status'] as const)('releases terminal %s capacity only with affirmative cleanup evidence', async action => {
    process.env.PREVIEW_SESSIONS = '1';
    const h = await harness();
    if (action === 'start') h.sandbox.next.push(view({ status: 'failed', cleanupConfirmed: true }));
    const started = await h.service.start('learner-1', 'phase-1');
    if (action === 'status') {
      h.sandbox.statusAnswer = view({ status: 'stopped', cleanupConfirmed: true });
      expect((await h.replica().status('learner-1', 'phase-1'))?.status).toBe('stopped');
    }
    expect(await h.service.liveSessions()).toHaveLength(0);
    if (started.url) expect(await h.replica().resolve(capability(started.url))).toBeNull();
    expect((await h.replica().start('learner-2', 'phase-2')).status).toBe('starting');
  });

});

/**
 * A clean-up the runner never confirms.
 *
 * A preview row left `stopped` with `cleanupPending` and no runner id makes
 * every sweep ask the runner who owns it. On a host whose runner cannot start,
 * each ask spawns a local runner and waits fifteen seconds for it; unbounded,
 * that is one python process every thirty seconds, for ever, surviving every
 * API restart. Elapsed time is never proof that an app stopped, so the seat
 * stays reserved, but the asking is bounded: a few tries at once, then
 * backing off, then the row is marked failed with one line an operator can act
 * on, and nothing asks again, on this API or the next one.
 */
describe('a clean-up the runner never confirms', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PreviewSessionEntity } = require('./preview-session.entity') as typeof import('./preview-session.entity');

  it('asks a bounded number of times, backing off, then marks the session failed once and stops asking', async () => {
    let clock = Date.now();
    const asked: number[] = [];
    const h = await harness({
      lookup: async () => {
        asked.push(clock);
        throw new Error('the preview runner did not answer on data/preview.sock within 15 seconds');
      },
    });
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // The walker's row: a start the runner never answered, left stopped and
    // pending with no runner id.
    h.sandbox.next.push(view({ id: '', status: 'unavailable' }));
    expect((await h.service.start('learner-1', 'phase-1')).status).toBe('unavailable');
    const [pending] = await h.service.liveSessions();
    expect(pending).toMatchObject({ runnerId: null, cleanupPending: true, status: 'stopped' });

    // An hour of the reaper's fifteen-second sweeps.
    for (let tick = 0; tick < 240; tick += 1) {
      clock += 15_000;
      await h.replica().sweep(clock);
    }

    // Bounded: eight asks in all, the start's own included, not 240.
    expect(asked).toHaveLength(8);
    // Backing off: after the first few, every wait is at least twice the last.
    const gaps = asked.slice(1).map((at, i) => at - asked[i]);
    for (let i = 3; i < gaps.length; i += 1) expect(gaps[i]).toBeGreaterThanOrEqual(2 * gaps[i - 1]);
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(8 * 60_000);

    // Marked failed, the seat still held (elapsed time is not proof), and
    // said once to the operator, naming the session.
    const [held] = await h.service.liveSessions();
    expect(held).toMatchObject({ id: pending.id, status: 'failed', cleanupPending: true, runnerId: null });
    expect(held.state.cleanupAttempts).toBe(8);
    expect(held.state.cleanupAbandonedAt).toEqual(expect.any(Number));
    const lines = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('preview clean-up'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(pending.id);
    expect(lines[0]).toContain('8 attempts');

    // Nothing asks again: not the next hour, and not an API that restarted.
    for (let tick = 0; tick < 240; tick += 1) {
      clock += 15_000;
      await h.replica().sweep(clock);
    }
    await h.replica().stopAll();
    expect(asked).toHaveLength(8);
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('preview clean-up'))).toHaveLength(1);
    // The learner's own poll reads the row and asks nothing either.
    await h.replica().status('learner-1', 'phase-1');
    expect(asked).toHaveLength(8);
    expect(await h.dataSource.getRepository(PreviewSessionEntity).count()).toBe(1);
  });

  /** A row abandoned by the bound, as the walker's would be after ~16 minutes. */
  const abandon = async (h: Harness, clock: { now: number }) => {
    h.sandbox.next.push(view({ id: '', status: 'unavailable' }));
    await h.service.start('learner-1', 'phase-1');
    for (let tick = 0; tick < 240; tick += 1) {
      clock.now += 15_000;
      await h.replica().sweep(clock.now);
    }
    const [held] = await h.service.liveSessions();
    expect(held.state.cleanupAbandonedAt).toEqual(expect.any(Number));
    return held;
  };

  // The abandoned row must not read "Your app did not start. The console has
  // what it printed." to its owner (for an app that may have run and been
  // stopped), nor may every later Run app say "Every seat is taken … busy with
  // the rest of the class … Try again in a moment", which no amount of trying
  // could change. And a runner that comes back after the bound must still be
  // able to clear it.
  it('tells its owner the truth about the held seat, not that the app did not start', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const clock = { now: Date.now() };
    const h = await harness({ lookup: async () => { throw new Error('controlled lookup outage'); } });
    const held = await abandon(h, clock);
    // The row itself says failed, for the operator the log line names.
    expect(held.status).toBe('failed');
    const polled = await h.replica().status('learner-1', 'phase-1');
    expect(polled?.status).toBe('unavailable');
    expect(polled?.message).toBe(PREVIEW_CLEANUP_HELD_MESSAGE);
  });

  it('asks the runner once more when its owner presses Run app, and says what holds the seat when it still cannot tell', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    process.env.PREVIEW_SESSIONS = '1';
    const clock = { now: Date.now() };
    const h = await harness({ lookup: async () => { throw new Error('controlled lookup outage'); } });
    await abandon(h, clock);
    const asked = h.sandbox.ownerLookups.length;
    const again = await h.service.start('learner-1', 'phase-1');
    // One ask per press, not a loop.
    expect(h.sandbox.ownerLookups.length).toBe(asked + 1);
    expect(again.status).toBe('unavailable');
    expect(again.message).toBe(PREVIEW_CLEANUP_HELD_MESSAGE);
    expect(again.message).not.toBe(SANDBOX_BUSY_MESSAGE);
    // Another learner, the one seat held by a row nobody can confirm.
    const other = await h.service.start('learner-2', 'phase-2');
    expect(other.status).toBe('unavailable');
    expect(other.message).toBe(PREVIEW_PAUSED_MESSAGE);
    // The sweep still asks nothing.
    for (let tick = 0; tick < 40; tick += 1) {
      clock.now += 15_000;
      await h.replica().sweep(clock.now);
    }
    expect(h.sandbox.ownerLookups.length).toBe(asked + 1);
  });

  it('clears the seat on its owner’s press once the runner confirms the app is gone', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let answer = false;
    const clock = { now: Date.now() };
    const h = await harness({
      lookup: async () => {
        if (!answer) throw new Error('controlled lookup outage');
        return { found: true, runnerId: 'confirmed-runner', cleanupConfirmed: true };
      },
    });
    await abandon(h, clock);
    answer = true;
    const started = await h.service.start('learner-1', 'phase-1');
    expect(started.status).toBe('starting');
    expect(started.url).toMatch(/^\/api\/v1\/preview\//);
  });

  it('still clears at once when the runner does confirm, inside the bound', async () => {
    let answer = false;
    const h = await harness({
      lookup: async () => {
        if (!answer) throw new Error('controlled lookup outage');
        return { found: true, runnerId: 'confirmed-runner', cleanupConfirmed: true };
      },
    });
    h.sandbox.next.push(view({ id: '', status: 'unavailable' }));
    await h.service.start('learner-1', 'phase-1');
    let clock = Date.now();
    for (let tick = 0; tick < 3; tick += 1) {
      clock += 15_000;
      await h.replica().sweep(clock);
    }
    expect(await h.service.liveSessions()).toHaveLength(1);
    answer = true;
    // The next ask is due inside the back-off, and it clears the seat.
    for (let tick = 0; tick < 40 && (await h.service.liveSessions()).length; tick += 1) {
      clock += 15_000;
      await h.replica().sweep(clock);
    }
    expect(await h.service.liveSessions()).toHaveLength(0);
  });
});
