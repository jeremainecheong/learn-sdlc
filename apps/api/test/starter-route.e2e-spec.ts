import { createHash } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { SEALED_READ_AUDIT_EVENT } from '../src/authoring/sealed-roles';
import { STARTER_ARCHIVE_RECORDS } from '../src/authoring/starter-archive.generated';
import { STARTER_ARCHIVE_NOT_FOUND } from '../src/authoring/starter-archive';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import { mockAiForRoutes } from './mock-ai';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * `GET /instructor/starter/:name` on the real AppModule.
 *
 * - A teacher reads each of the two archives with a 200: the body is exactly
 *   `STARTER_ARCHIVE_RECORDS[name]` decoded, `application/zip`, an attachment
 *   named `learnsdlc-<name>.zip`, `no-store`.
 * - A learner is refused with a 403 before the service runs, and leaves no row.
 * - An unknown name is a 404 that names nothing it was asked for, and leaves no
 *   audit row (the name is checked before the audit is called).
 * - Every 200 writes exactly one `project.sealed-read` row (that event reused,
 *   `targetId` null, `action` the archive's name, the
 *   detail its name, filename, size and digest, never a byte of it), and no
 *   other table gains or loses a row. No provider or sandbox is reached.
 */

const NAMES = ['starter', 'shelf'] as const;
const STARTER_PATH = (name: string) => `/api/v1/instructor/starter/${encodeURIComponent(name)}`;

/** A synthetic sign-up address on the reserved `.test` domain, put together at run time. */
const syntheticAddress = (label: string, n: number): string =>
  ['rc-wire-', label, '-', String(n), String.fromCharCode(64), 'starter-route.test'].join('');

/** supertest's raw body, as bytes (a zip is not text). */
const binary = (res: any, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('the starter route', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();
  let address = 0;
  let accounts = 0;
  const from = () => ({ 'x-forwarded-for': `10.93.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  const aiCalls: string[] = [];
  const countingAi = new Proxy(mockAiForRoutes as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            aiCalls.push(String(key));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          }
        : value;
    },
  });
  let sandboxCalls = 0;

  const account = async (label: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER') => {
    accounts += 1;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: syntheticAddress(label, stamp + accounts), password: 'Correct-Horse-9', displayName: `wire ${label}` })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const starterRows = (actor: string) =>
    db.manager.find(AuditEventEntity, { where: { event: SEALED_READ_AUDIT_EVENT, actorUserId: actor }, order: { createdAt: 'ASC' } });

  const tableCounts = async (): Promise<Record<string, number>> => {
    const tables = (await db.query(
      db.options.type === 'postgres'
        ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
        : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )) as { name: string }[];
    expect(tables.length).toBeGreaterThan(10);
    const out: Record<string, number> = {};
    for (const { name } of tables) out[name] = Number((await db.query(`SELECT COUNT(*) AS n FROM "${name}"`))[0].n);
    return out;
  };

  beforeAll(async () => {
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async () => {
      sandboxCalls += 1;
      throw new Error('the starter route must never reach the sandbox');
    });
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, countingAi]], trustProxy: true }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it.each(NAMES)('a teacher reads the %s archive: 200, the recorded bytes exactly, a zip attachment, never cached', async (name) => {
    const teacher = await account(`t-${name}`, 'INSTRUCTOR');
    const record = STARTER_ARCHIVE_RECORDS[name];
    const expected = Buffer.from(record.base64, 'base64');

    const res = await request(http).get(STARTER_PATH(name)).set(bearer(teacher.token)).buffer(true).parse(binary);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.equals(expected)).toBe(true);
    expect(createHash('sha256').update(body).digest('hex')).toBe(record.sha256);
    expect(body.length).toBe(record.size);
    expect(res.headers['content-type']).toMatch(/^application\/zip\b/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="learnsdlc-${name}.zip"`);
    expect(record.filename).toBe(`learnsdlc-${name}.zip`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('every 200 writes exactly one sealed-read audit row naming the archive, and no other table moves', async () => {
    const teacher = await account('t-audit', 'INSTRUCTOR');
    const grabbed = aiCalls.length;
    const sandboxBefore = sandboxCalls;
    const before = await tableCounts();

    for (const name of NAMES) {
      await request(http).get(STARTER_PATH(name)).set(bearer(teacher.token)).buffer(true).parse(binary).expect(200);
    }
    await request(http).get(STARTER_PATH('starter')).set(bearer(teacher.token)).buffer(true).parse(binary).expect(200);

    const after = await tableCounts();
    const auditTable = db.getMetadata(AuditEventEntity).tableName;
    expect(after[auditTable]).toBe(before[auditTable] + 3);
    expect({ ...after, [auditTable]: 0 }).toEqual({ ...before, [auditTable]: 0 });

    const rows = await starterRows(teacher.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.action).sort()).toEqual(['shelf', 'starter', 'starter']);
    for (const row of rows) {
      const name = row.action as (typeof NAMES)[number];
      const record = STARTER_ARCHIVE_RECORDS[name];
      expect({
        event: row.event,
        actorUserId: row.actorUserId,
        subjectUserId: row.subjectUserId,
        targetId: row.targetId,
        reason: row.reason,
        detail: row.detail,
      }).toEqual({
        event: 'project.sealed-read',
        actorUserId: teacher.id,
        subjectUserId: teacher.id,
        targetId: null,
        reason: null,
        detail: { name, filename: record.filename, size: record.size, sha256: record.sha256 },
      });
      // never a byte of the archive
      expect(JSON.stringify(row.detail)).not.toContain(record.base64.slice(0, 64));
    }
    expect({ ai: aiCalls.length - grabbed, sandbox: sandboxCalls - sandboxBefore }).toEqual({ ai: 0, sandbox: 0 });
  });

  it('an ADMIN may download too (staff), with its own row', async () => {
    const admin = await account('admin', 'ADMIN');
    await request(http).get(STARTER_PATH('shelf')).set(bearer(admin.token)).buffer(true).parse(binary).expect(200);
    expect((await starterRows(admin.id)).map((row) => row.action)).toEqual(['shelf']);
  });

  it('a learner is refused (403) on both names, and leaves no row anywhere', async () => {
    const learner = await account('learner');
    const before = await tableCounts();
    for (const name of NAMES) {
      const res = await request(http).get(STARTER_PATH(name)).set(bearer(learner.token));
      expect(res.status).toBe(403);
      expect(res.headers['content-type'] ?? '').not.toMatch(/application\/zip/);
    }
    expect(await tableCounts()).toEqual(before);
    expect(await starterRows(learner.id)).toEqual([]);
  });

  it('no session is a 401, and no row', async () => {
    const before = await tableCounts();
    await request(http).get(STARTER_PATH('starter')).expect(401);
    expect(await tableCounts()).toEqual(before);
  });

  it('an unknown name is a 404 that names nothing it was asked, and writes no audit row', async () => {
    const teacher = await account('t-unknown', 'INSTRUCTOR');
    const before = await tableCounts();
    for (const name of ['nothing-here', 'tasktrackr', 'STARTER', 'starter.zip', '..%2Fstarter']) {
      const res = await request(http).get(`/api/v1/instructor/starter/${name}`).set(bearer(teacher.token));
      expect(res.status).toBe(404);
      expect(res.headers['content-type'] ?? '').not.toMatch(/application\/zip/);
      if (res.body && typeof res.body.message === 'string' && name === 'nothing-here') {
        expect(res.body.message).toBe(STARTER_ARCHIVE_NOT_FOUND);
        expect(res.body.message).not.toContain(name);
      }
    }
    expect(await tableCounts()).toEqual(before);
    expect(await starterRows(teacher.id)).toEqual([]);
  });
});
