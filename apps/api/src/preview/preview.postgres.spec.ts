import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { config } from '../config';
import { UserEntity, AuditEventEntity, ALL_ENTITIES } from '../db/entities';
import { AuthService } from '../auth/auth.service';
import { AccountService } from '../account/account.service';
import * as auditModule from '../audit/audit';
import { PreviewService } from './preview.service';
import { PreviewSessionEntity } from './preview-session.entity';
import type { ContentService } from '../content/content.service';
import type { WorkflowService } from '../workflow/workflow.service';
import type { SandboxService, SandboxAppSession } from '../execution/sandbox.service';
import { describePostgres, postgresTarget } from '../../test/support/postgres';

describePostgres('two actual PostgreSQL API stores (isolated gap_security schema)', () => {
  let admin: DataSource;
  let first: DataSource;
  let second: DataSource;
  let schema: string;
  let users: UserEntity[];
  const previous = { authProvider: config.authProvider, previewSessions: config.previewSessions, previewEnabled: config.previewEnabled, runnerMode: config.runnerMode };
  const calls: string[] = [];
  const stopped = new Set<string>();
  let release: (() => void) | null = null;
  let entered: (() => void) | null = null;
  let held: Promise<void> | null = null;
  let stopUnavailable = false;
  const sandbox = {
    // Asked before a seat is reserved; on the socket
    // transport these cases run, the real service answers the runner socket.
    async previewSocket() { return '/tmp/gap-security-preview.sock'; },
    async lookupAppOwner() { return { found: false, cleanupConfirmed: false }; },
    async startApp(_job: unknown, owner: { ownerId: string }) {
      calls.push(owner.ownerId); entered?.(); await held;
      return { id: `runner-${owner.ownerId}`, status: 'ready', bundleOk: true, console: [], cursor: 0 };
    },
    async stopApp(id: string) { if (!stopUnavailable) stopped.add(id); },
    async statusApp(id: string) {
      return { id, status: stopUnavailable ? 'unavailable' : stopped.has(id) ? 'stopped' : 'ready', cleanupConfirmed: !stopUnavailable && stopped.has(id), console: [], cursor: 0 };
    },
  } as unknown as SandboxService;
  const content = {
    getProject: () => ({ preview: { service: {}, web: {}, env: {} } }),
    // The accessor `PreviewService` reads. The enrolment below
    // carries no pin, so this answers what `getProject` answers.
    getForEnrollment: () => ({ preview: { service: {}, web: {}, env: {} } }),
    executionFiles: () => ({ 'api/main.py': 'print(1)' }),
  } as unknown as ContentService;
  const workflow = {
    async loadOwnedState(userId: string, phase: string) {
      if (phase !== `phase-${userId}`) throw new Error('not your phase');
      return { state: { workspace: {} }, phase: { canPreview: true }, enrollment: { projectSlug: 'test', projectVersionId: null } };
    },
  } as unknown as WorkflowService;
  const service = (db: DataSource) => new PreviewService(workflow, content, sandbox, db);
  const cap = (url: string | null) => String(url).split('/').filter(Boolean).pop()!;

  beforeAll(async () => {
    const url = new URL(postgresTarget()!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== '5494') throw new Error('isolated PostgreSQL target refused');
    schema = `gap_security_${randomUUID().replace(/-/g, '')}`;
    admin = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const options = { type: 'postgres' as const, url: url.toString(), schema, entities: ALL_ENTITIES };
    first = await new DataSource({ ...options, synchronize: true }).initialize();
    second = await new DataSource(options).initialize();
  });
  afterAll(async () => {
    release?.();
    if (first?.isInitialized) await first.destroy();
    if (second?.isInitialized) await second.destroy();
    if (admin?.isInitialized) {
      if (!/^gap_security_[0-9a-f]{32}$/.test(schema)) throw new Error('cleanup namespace refused');
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      expect(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).toEqual([]);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    Object.assign(config, { authProvider: 'local', previewSessions: 1, previewEnabled: true, runnerMode: 'socket' });
    calls.length = 0; stopped.clear(); held = null; release = null; entered = null; stopUnavailable = false;
    await first.getRepository(PreviewSessionEntity).clear();
    await first.getRepository(UserEntity).clear();
    users = await first.manager.save(UserEntity, [0, 1].map(i => first.manager.create(UserEntity, {
      email: `gap-pg-${i}@example.invalid`, displayName: 'Isolated security fixture', passwordHash: 'unused',
    })));
  });
  afterEach(() => { release?.(); jest.restoreAllMocks(); Object.assign(config, previous); });

  it('serializes simultaneous global capacity reservations across real SQL connections', async () => {
    held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const requests = users.map((user, i) => service(i ? second : first).start(user.id, `phase-${user.id}`));
    await started;
    // The second real connection cannot reserve the same global slot while
    // the first is launching; the runner transport has not completed yet.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(calls).toHaveLength(1);
    release!();
    const results = await Promise.all(requests);
    expect(results.map(row => row.status).sort()).toEqual(['busy', 'ready']);
    expect(await first.getRepository(PreviewSessionEntity).count()).toBe(1);
  });

  it('revokes authentication and capability through a different connection, with another owner untouched', async () => {
    Object.assign(config, { previewSessions: 2 });
    const jwt = new JwtService({ secret: 'gap-native-test-only', signOptions: { expiresIn: '1h' } });
    const authA = new AuthService(passwordWorkFixture(), first.getRepository(UserEntity), jwt);
    const authB = new AuthService(passwordWorkFixture(), second.getRepository(UserEntity), jwt);
    const token = await authA.issueSession(users[0]);
    await authB.authenticate(token.token);
    const a = await service(first).start(users[0].id, `phase-${users[0].id}`);
    const b = await service(first).start(users[1].id, `phase-${users[1].id}`);
    await authA.signOut(users[0].id);
    await expect(authB.authenticate(token.token)).rejects.toThrow('signed out');
    expect(await service(second).resolve(cap(a.url))).toBeNull();
    expect(await service(second).resolve(cap(b.url))).not.toBeNull();
    await service(first).sweep();
  });

  it('retains a stopped cleanup reservation through unavailable runner responses and recovers on another replica', async () => {
    const api = service(first);
    const a = await api.start(users[0].id, `phase-${users[0].id}`);
    stopUnavailable = true;
    await service(second).stop(users[0].id, `phase-${users[0].id}`);
    expect(await first.getRepository(PreviewSessionEntity).findOneByOrFail({ id: a.id })).toMatchObject({ status: 'stopped', cleanupPending: true });
    expect(await api.resolve(cap(a.url))).toBeNull();
    expect((await api.start(users[1].id, `phase-${users[1].id}`)).status).toBe('busy');
    stopUnavailable = false;
    await service(second).sweep();
    expect(await first.getRepository(PreviewSessionEntity).findOneByOrFail({ id: a.id })).toMatchObject({ cleanupPending: false });
    expect((await api.start(users[1].id, `phase-${users[1].id}`)).status).toBe('ready');
  });

  it('does not invent cleanup from a deadline after an uncertain launch and API loss', async () => {
    const api = service(first);
    const now = Date.now();
    const row = await first.manager.save(PreviewSessionEntity, first.manager.create(PreviewSessionEntity, {
      id: randomUUID().replace(/-/g, '').slice(0, 24), userId: users[0].id, phaseStateId: `phase-${users[0].id}`,
      tokenVersion: 0, runnerId: null, capabilityHash: 'a'.repeat(64), status: 'starting', cleanupPending: false,
      revision: 0, state: { bundleOk: true, message: null, stopReason: null, startedAt: now,
        readyAt: null, expiresAt: now + 1000, lastSeenAt: now, bytesServed: 0,
        forgetAt: null, buildMs: 0, launchDeadline: now + 1000 },
    }));
    expect((await service(second).start(users[1].id, `phase-${users[1].id}`)).status).toBe('busy');
    await service(second).sweep(now + 2000);
    expect(await first.getRepository(PreviewSessionEntity).findOneByOrFail({ id: row.id })).toMatchObject({ status: 'stopped', cleanupPending: true });
    expect((await api.start(users[1].id, `phase-${users[1].id}`)).status).toBe('busy');
  });

  it('serializes account erasure against an already-authorized preview audit, then purges cleaned operational ownership', async () => {
    const owner = users[0];
    let auditEntered!: () => void;
    let releaseAudit!: () => void;
    const enteredAudit = new Promise<void>(resolve => { auditEntered = resolve; });
    const heldAudit = new Promise<void>(resolve => { releaseAudit = resolve; });
    const original = auditModule.recordAudit;
    jest.spyOn(auditModule, 'recordAudit').mockImplementation(async (manager, row) => {
      if (row.event === 'preview.start') { auditEntered(); await heldAudit; }
      return original(manager, row);
    });
    const launching = service(first).start(owner.id, `phase-${owner.id}`).then(result => result, error => error);
    await enteredAudit;
    let erased = false;
    const deletion = new AccountService(passwordWorkFixture(), second).deleteAccount(owner.id, owner.email).then(result => { erased = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(erased).toBe(false);
    releaseAudit();
    await launching;
    await expect(deletion).resolves.toEqual({ deleted: true });
    const audits = await first.getRepository(AuditEventEntity).findBy({ targetId: `phase-${owner.id}`, event: 'preview.start' });
    expect(audits).toHaveLength(1);
    expect(audits[0].subjectUserId).toBeNull();
    await service(second).sweep();
    expect(await first.getRepository(PreviewSessionEntity).countBy({ userId: owner.id })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('refuses a new launch after erasure wins the shared user lock, with no orphan reservation', async () => {
    const owner = users[0];
    const account = new AccountService(passwordWorkFixture(), first);
    let enteredDelete!: () => void;
    let releaseDelete!: () => void;
    const deleting = new Promise<void>(resolve => { enteredDelete = resolve; });
    const heldDelete = new Promise<void>(resolve => { releaseDelete = resolve; });
    jest.spyOn(account as unknown as { ownedCohorts: (...args: unknown[]) => Promise<unknown[]> }, 'ownedCohorts').mockImplementationOnce(async () => {
      enteredDelete(); await heldDelete; return [];
    });
    const deletion = account.deleteAccount(owner.id, owner.email);
    await deleting;
    const launching = service(second).start(owner.id, `phase-${owner.id}`).then(result => result, error => error);
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(calls).toHaveLength(0);
    releaseDelete();
    await deletion;
    expect(await launching).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
    expect(await first.getRepository(PreviewSessionEntity).countBy({ userId: owner.id })).toBe(0);
  });

});
