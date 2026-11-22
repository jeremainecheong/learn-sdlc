import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AUTHORING_ROUTES, AUTHORING_ROUTE_KEYS } from '@learnsdlc/shared';
import type { AuthoringRouteKey, Role } from '@learnsdlc/shared';
// The audited off-table doors name their event.
import { AUTHORING_AUDIT_EVENTS } from '@learnsdlc/shared';
import type { AuthoringAuditEvent } from '@learnsdlc/shared';
import { ROLES_KEY } from '../auth/auth.decorators';
import { RolesGuard } from '../auth/auth.guards';
import { AuthoringController } from './authoring.controller';
import { RATE_LIMIT_KEY } from '../auth/rate-limit.guard';
import { bakedRuntimeProfile } from './runtime-stacks';

/** Nest's own numbering for `RequestMethod`, as the decorators write it. */
const METHOD_NAME = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** Every route this controller actually mounts, as `METHOD /path`. */
function mounted(): Set<string> {
  const base = Reflect.getMetadata(PATH_METADATA, AuthoringController) as string;
  const prototype = AuthoringController.prototype as unknown as Record<string, unknown>;
  const out = new Set<string>();
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name];
    const path = Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined;
    if (path === undefined) continue;
    const method = METHOD_NAME[Reflect.getMetadata(METHOD_METADATA, handler as object) as number];
    const full = `/${[base, path].filter((part) => part && part !== '/').join('/')}`;
    out.add(`${method} ${full}`);
  }
  return out;
}

/** The routes of the contract's table this controller owns. Assignment belongs to the classroom controller. */
const MINE: AuthoringRouteKey[] = AUTHORING_ROUTE_KEYS.filter(
  (key) => !key.startsWith('assignment.'),
);

/**
 * The doors this controller mounts beside the contract's table, each listed
 * here by hand since the table carries no `AUTHORING_ROUTES` key for it. All
 * are GETs. `OFF_TABLE_READS` write no row and no audit event at all.
 */
const OFF_TABLE_READS: readonly string[] = [
  'GET /instructor/projects/:projectId/versions/:versionId/learner-preview',
];

/**
 * Off-table GETs that are not quiet: each 200 writes exactly one audit row of
 * the event named here, and nothing else (counted in their e2e, which also
 * holds that a refusal writes none). The starter download is one: the
 * archives carry example hidden tests and solutions.
 */
const OFF_TABLE_AUDITED_READS: Readonly<Record<string, AuthoringAuditEvent>> = {
  'GET /instructor/starter/:name': 'project.sealed-read',
};

/** Every off-table door, quiet or audited. */
const OFF_TABLE: readonly string[] = [...OFF_TABLE_READS, ...Object.keys(OFF_TABLE_AUDITED_READS)];

/**
 * The doors, held against the table that declares them.
 *
 * The contract's `AUTHORING_ROUTES` is not documentation: the web app builds its
 * client from it, so a path that drifts by one segment is a 404 on a page that
 * was written correctly. This asserts the controller mounts exactly what the
 * table says, at the method the table says, and that nothing else is mounted
 * beside it.
 */
describe('the authoring controller', () => {
  it('mounts every route of the contract, at the method and path it declares', () => {
    const doors = mounted();

    for (const key of MINE) {
      const route = AUTHORING_ROUTES[key];
      expect(doors).toContain(`${route.method} ${route.path}`);
    }
    // and nothing beyond them: a route that is not in the table is a route no
    // client knows about and nobody declared (bar the off-table doors above)
    for (const door of OFF_TABLE) expect(doors).toContain(door);
    expect(doors.size).toBe(MINE.length + OFF_TABLE.length);
  });

  it('leaves the assignment routes to the class panel', () => {
    const doors = mounted();
    for (const key of AUTHORING_ROUTE_KEYS.filter((one) => one.startsWith('assignment.'))) {
      expect(doors).not.toContain(
        `${AUTHORING_ROUTES[key].method} ${AUTHORING_ROUTES[key].path}`,
      );
    }
  });

  it('is staff only at the API, on the class, so every handler inherits it', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AuthoringController) as Role[];

    expect(roles).toEqual(['INSTRUCTOR', 'ADMIN']);
    for (const key of MINE) {
      expect([...AUTHORING_ROUTES[key].roles]).toEqual(['INSTRUCTOR', 'ADMIN']);
    }
  });

  it('refuses a learner on every route before a service runs', () => {
    const guard = new RolesGuard(new Reflector());
    const contextFor = (role: Role, handler: unknown): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => AuthoringController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', role } }) }),
      }) as unknown as ExecutionContext;

    const prototype = AuthoringController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => prototype[name])
      .filter((handler) => Reflect.getMetadata(PATH_METADATA, handler as object) !== undefined);

    expect(handlers).toHaveLength(MINE.length + OFF_TABLE.length);
    for (const handler of handlers) {
      expect(() => guard.canActivate(contextFor('LEARNER', handler))).toThrow(ForbiddenException);
      expect(guard.canActivate(contextFor('INSTRUCTOR', handler))).toBe(true);
      expect(guard.canActivate(contextFor('ADMIN', handler))).toBe(true);
    }
  });

  /**
   * Every write this controller mounts leaves a trail.
   *
   * Asked of the *controller*, not of the table: holding `route.mutates`
   * against `route.audit !== null` is two fields of one literal agreeing with
   * each other, and stays green with the whole controller deleted. What has to
   * be true is that a handler mounted at anything but GET corresponds to a
   * table entry that declares a mutation and names the audit event it writes,
   * so a new write route added without one fails here rather than shipping an
   * unaudited door. (That each mutation then leaves exactly one row is
   * `authoring.service.spec.ts`'s, where the rows can be counted.)
   */
  it('audits every write it mounts, and mounts no write the table does not audit', () => {
    const byDoor = new Map(MINE.map((key) => [`${AUTHORING_ROUTES[key].method} ${AUTHORING_ROUTES[key].path}`, key]));
    const writes = [...mounted()].filter((door) => !door.startsWith('GET '));

    expect(writes.length).toBeGreaterThan(0);
    for (const door of writes) {
      const key = byDoor.get(door);
      expect(key).toBeDefined();
      const route = AUTHORING_ROUTES[key as AuthoringRouteKey];
      expect(route.mutates).toBe(true);
      expect(route.audit).not.toBeNull();
    }
    // and the reads mount nothing that claims to mutate (an off-table door is
    // a GET by its own declaration, and has no table entry to claim anything;
    // an audited one names an event the contract knows)
    expect(OFF_TABLE.filter((door) => !door.startsWith('GET '))).toEqual([]);
    for (const event of Object.values(OFF_TABLE_AUDITED_READS)) expect(AUTHORING_AUDIT_EVENTS).toContain(event);
    for (const door of [...mounted()].filter((one) => one.startsWith('GET ') && !OFF_TABLE.includes(one))) {
      const route = AUTHORING_ROUTES[byDoor.get(door) as AuthoringRouteKey];
      expect(route.mutates).toBe(false);
      expect(route.audit).toBeNull();
    }
  });
});

/* ======================================================================== *
 * The upload, profile, sealed-file and deep-validation handlers. The       *
 * controller delegates to the upload, sealed-role, deep-validation and     *
 * runtime-profile services, so here each is a mock and the question is     *
 * only "does the door reach it, with what, under which budget".            *
 * ======================================================================== */
describe('the executable authoring handlers', () => {
  const caller = { id: 'teacher-s3', role: 'INSTRUCTOR' as const, cohort: 'default' };
  const PID = '11111111-1111-4111-8111-111111111111';
  const VID = '22222222-2222-4222-8222-222222222222';

  /** The prototype method mounted at `METHOD /instructor/...`, or undefined. */
  function handlerFor(method: string, path: string): string | undefined {
    const prototype = AuthoringController.prototype as unknown as Record<string, unknown>;
    const base = Reflect.getMetadata(PATH_METADATA, AuthoringController) as string;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name] as object;
      const at = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (at === undefined) continue;
      const verb = METHOD_NAME[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      if (verb === method && `/${base}/${at}` === path) return name;
    }
    return undefined;
  }
  const doorOf = (key: AuthoringRouteKey) => {
    const route = AUTHORING_ROUTES[key];
    const name = handlerFor(route.method, route.path);
    expect(`${key}: ${name ?? 'not mounted'}`).not.toBe(`${key}: not mounted`);
    return name as string;
  };

  const mocks = () => ({
    authoring: {
      validate: jest.fn(async () => ({ tier: 'fast', publishable: true, blocking: [] })),
      requireOwnedVersion: jest.fn(async () => undefined),
    } as Record<string, jest.Mock>,
    upload: { upload: jest.fn(async () => ({ projectId: PID, versionId: VID, slug: 'pantry', validation: { tier: 'fast' } })) },
    sealed: {
      write: jest.fn(async () => ({ path: 'tests/test_x.py', sha256: 'a'.repeat(64), bytes: 3 })),
      readOwnerOnly: jest.fn(async () => ({ path: 'tests/test_x.py', content: 'x' })),
    },
    deep: {
      start: jest.fn(async () => ({ state: 'queued' })),
      view: jest.fn(async () => ({ state: 'none' })),
    },
    // ExportService, mocked
    exporter: {
      export: jest.fn(async () => ({ filename: 'pantry-0.1.0.zip', archive: Buffer.from('PK\u0005\u0006'), sha256: 'b'.repeat(64), entries: 0, withheld: [{ path: 'phases/03-implementation/hidden_tests/api/tests/test_x.py', sha256: 'c'.repeat(64), bytes: 3 }] })),
    },
  });
  const controllerWith = (m: ReturnType<typeof mocks>) =>
    new (AuthoringController as unknown as new (...args: unknown[]) => Record<string, (...args: unknown[]) => unknown>)(
      m.authoring,
      m.upload,
      m.sealed,
      m.exporter,
      m.deep,
    );

  it("version.export delegates to ExportService.export and answers the zip, no-store, with the withheld count", async () => {
    const name = doorOf('version.export');
    const handler = (AuthoringController.prototype as unknown as Record<string, object>)[name];
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual({ max: 10, windowSeconds: 60 });
    const m = mocks();
    const headers: Record<string, string> = {};
    const res = { setHeader: (key: string, value: string) => void (headers[key.toLowerCase()] = value) };
    const file = (await controllerWith(m)[name](caller, PID, VID, res)) as { getHeaders(): Record<string, unknown> };
    expect(m.exporter.export).toHaveBeenCalledWith(caller, PID, VID);
    expect(headers).toEqual({ 'cache-control': 'no-store', 'x-export-withheld': '1' });
    expect(file.getHeaders()).toMatchObject({ type: 'application/zip', disposition: 'attachment; filename="pantry-0.1.0.zip"', length: 4 });
  });

  it('projects.upload is rate limited 5 a minute and delegates to UploadService.upload', async () => {
    const name = doorOf('projects.upload');
    const handler = (AuthoringController.prototype as unknown as Record<string, object>)[name];
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual({ max: 5, windowSeconds: 60 });
    const m = mocks();
    const body = { title: 'Pantry', archiveBase64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==' };
    const out = await controllerWith(m)[name](caller, body);
    expect(m.upload.upload).toHaveBeenCalledWith(caller, body);
    // the report the editor opens on, run through the authoring service's own builder
    expect(m.authoring.validate).toHaveBeenCalledWith(caller, PID, VID);
    expect(out).toEqual({ ...(await m.upload.upload.mock.results[0].value), validation: await m.authoring.validate.mock.results[0].value });
    // the draft is committed: a failed second look answers the upload's own report, never a 500
    const failing = mocks();
    failing.authoring.validate.mockRejectedValueOnce(new Error('boom'));
    const fallback = (await controllerWith(failing)[name](caller, body)) as { validation: unknown };
    expect(fallback.validation).toEqual({ tier: 'fast' });
  });

  it("runtime.profile answers RP's baked profile", async () => {
    const name = doorOf('runtime.profile');
    const m = mocks();
    expect(await controllerWith(m)[name]()).toEqual(bakedRuntimeProfile());
  });

  it("sealed.write and sealed.read reach the sealed-role service with the path's ids, the phase and the task", async () => {
    const m = mocks();
    const write = doorOf('sealed.write');
    const body = { role: 'hidden', runId: null, path: 'tests/test_x.py', contentBase64: Buffer.from('x = 1\n').toString('base64') };
    await controllerWith(m)[write](caller, PID, VID, 'implementation', 'main', body);
    // the declared run rides as the ninth argument
    expect(m.sealed.write).toHaveBeenCalledWith(caller, PID, VID, 'implementation', 'main', 'hidden', 'tests/test_x.py', 'x = 1\n', null);
    // the stored compile follows the write
    expect(m.authoring.validate).toHaveBeenCalledWith(caller, PID, VID);

    const read = doorOf('sealed.read');
    await controllerWith(m)[read](caller, PID, VID, 'implementation', 'main', { role: 'solution', path: 'api/x.py' });
    expect(m.sealed.readOwnerOnly).toHaveBeenCalledWith(caller, PID, VID, 'implementation', 'main', 'solution', 'api/x.py', undefined);
  });

  it('the run a teacher declares reaches the sealed-role service on both sealed doors, so its "not the run" refusal can answer', async () => {
    const m = mocks();
    const body = { role: 'hidden', runId: 'api', path: 'tests/test_x.py', contentBase64: Buffer.from('x = 1\n').toString('base64') };
    await controllerWith(m)[doorOf('sealed.write')](caller, PID, VID, 'implementation', 'main', body);
    expect(m.sealed.write).toHaveBeenCalledWith(caller, PID, VID, 'implementation', 'main', 'hidden', 'tests/test_x.py', 'x = 1\n', 'api');
    await controllerWith(m)[doorOf('sealed.read')](caller, PID, VID, 'implementation', 'main', { role: 'hidden', path: 'tests/test_x.py', runId: 'web' });
    expect(m.sealed.readOwnerOnly).toHaveBeenCalledWith(caller, PID, VID, 'implementation', 'main', 'hidden', 'tests/test_x.py', 'web');
  });

  it("sealed.write asks who may write before it reads the bytes, and a committed write is answered even when the second look fails", async () => {
    const refused = mocks();
    refused.authoring.requireOwnedVersion.mockRejectedValueOnce(new Error('not yours'));
    const bad = { role: 'hidden', runId: null, path: 'tests/test_x.py', contentBase64: '!!not base64!!' };
    await expect(controllerWith(refused)[doorOf('sealed.write')](caller, PID, VID, 'implementation', 'main', bad)).rejects.toThrow('not yours');
    expect(refused.sealed.write).not.toHaveBeenCalled();

    const failing = mocks();
    failing.authoring.validate.mockRejectedValueOnce(new Error('boom'));
    const good = { role: 'hidden', runId: null, path: 'tests/test_x.py', contentBase64: Buffer.from('x = 1\n').toString('base64') };
    const out = await controllerWith(failing)[doorOf('sealed.write')](caller, PID, VID, 'implementation', 'main', good);
    expect(out).toEqual(await failing.sealed.write.mock.results[0].value);
  });

  it("deepValidation.start and deepValidation.read reach the deep-validation service for the version", async () => {
    const m = mocks();
    await controllerWith(m)[doorOf('deepValidation.start')](caller, PID, VID, { acknowledgedMicroVMs: 4 });
    expect(m.authoring.requireOwnedVersion).toHaveBeenCalledWith(caller, PID, VID);
    expect(m.deep.start).toHaveBeenCalledWith(caller, VID, { acknowledgedMicroVMs: 4 });
    await controllerWith(m)[doorOf('deepValidation.read')](caller, PID, VID);
    expect(m.deep.view).toHaveBeenCalledWith(caller, VID);
    // a version that is not this caller's own never reaches deep validation
    const refused = mocks();
    refused.authoring.requireOwnedVersion.mockRejectedValueOnce(new Error('not yours'));
    await expect(controllerWith(refused)[doorOf('deepValidation.start')](caller, PID, VID, { acknowledgedMicroVMs: 4 })).rejects.toThrow('not yours');
    expect(refused.deep.start).not.toHaveBeenCalled();
  });

  it('refuses a phase that is not one on the sealed doors, before a service runs', async () => {
    const m = mocks();
    expect(() => controllerWith(m)[doorOf('sealed.read')](caller, PID, VID, 'nowhere', 'main', { role: 'hidden', path: 'x.py' })).toThrow(/is not a phase/);
    expect(m.sealed.readOwnerOnly).not.toHaveBeenCalled();
  });
});

/* ======================================================================== *
 * The starter door. The service and its row                                *
 * are counted in `test/starter-route.e2e-spec.ts`; here the question is *
 * only the budget, the delegation and the headers.                         *
 * ======================================================================== */
describe('the starter door', () => {
  const caller = { id: 'teacher-rc', role: 'INSTRUCTOR' as const, cohort: 'default' };
  const prototype = AuthoringController.prototype as unknown as Record<string, object>;
  const name = Object.getOwnPropertyNames(prototype).find(
    (one) => one !== 'constructor' && Reflect.getMetadata(PATH_METADATA, prototype[one]) === 'starter/:name',
  ) as string;
  const controllerWith = (authoring: Record<string, jest.Mock>) =>
    new (AuthoringController as unknown as new (...args: unknown[]) => Record<string, (...args: unknown[]) => unknown>)(
      authoring,
      {},
      {},
      {},
      undefined,
    );

  it('is a GET under the staff roles, on quizKey’s 20-a-minute budget', () => {
    expect(name).toBeDefined();
    expect(METHOD_NAME[Reflect.getMetadata(METHOD_METADATA, prototype[name]) as number]).toBe('GET');
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, prototype[name])).toEqual({ max: 20, windowSeconds: 60 });
    expect(Reflect.getMetadata(ROLES_KEY, prototype[name])).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, AuthoringController)).toEqual(['INSTRUCTOR', 'ADMIN']);
  });

  it('delegates to AuthoringService.starterDownload with the raw name and answers the bytes as a zip attachment, no-store', async () => {
    const bytes = Buffer.from('PK\u0005\u0006');
    const authoring = { starterDownload: jest.fn(async () => ({ bytes, filename: 'learnsdlc-starter.zip', sha256: 'd'.repeat(64) })) };
    const headers: Record<string, string> = {};
    const res = { setHeader: (key: string, value: string) => void (headers[key.toLowerCase()] = value) };
    const file = (await controllerWith(authoring)[name](caller, 'starter', res)) as { getHeaders(): Record<string, unknown>; getStream(): unknown };
    expect(authoring.starterDownload).toHaveBeenCalledWith(caller, 'starter');
    expect(headers).toEqual({ 'cache-control': 'no-store' });
    expect(file.getHeaders()).toMatchObject({ type: 'application/zip', disposition: 'attachment; filename="learnsdlc-starter.zip"', length: 4 });
  });

  it("a refusal from the service (an unknown name's 404) is answered as itself, with no header set", async () => {
    const authoring = { starterDownload: jest.fn(async () => Promise.reject(new Error('no such download'))) };
    const headers: Record<string, string> = {};
    const res = { setHeader: (key: string, value: string) => void (headers[key.toLowerCase()] = value) };
    await expect(controllerWith(authoring)[name](caller, 'nothing', res)).rejects.toThrow('no such download');
    expect(headers).toEqual({});
  });
});

describe("tasks.update's body: an executable task's members", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ValidationPipe } = require('@nestjs/common') as typeof import('@nestjs/common');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { UpdateTaskDto } = require('./authoring.dto') as typeof import('./authoring.dto');
  // the global pipe exactly as main.ts mounts it
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true });
  const through = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateTaskDto });
  const run = { id: 'api', shape: 'run-python-hidden', label: 'API tests', testPaths: ['tests/test_hidden.py'], visibleTests: ['tests/test_api.py'], learnerTestFiles: [] };

  it('keeps owns, runs, minTests and coverageKeywords rather than stripping them', async () => {
    const out = (await through({ brief: 'b', owns: ['api/x.py'], runs: [run], minTests: 6, coverageKeywords: ['overdue'] })) as Record<string, unknown>;
    expect(out.owns).toEqual(['api/x.py']);
    expect(JSON.parse(JSON.stringify(out.runs))).toEqual([run]);
    expect(out.minTests).toBe(6);
    expect(out.coverageKeywords).toEqual(['overdue']);
  });

  it("refuses a run shape outside the four test-run shapes, and strips what a run body does not declare", async () => {
    await expect(through({ runs: [{ ...run, shape: 'smoke-python' }] })).rejects.toBeDefined();
    await expect(through({ runs: [{ ...run, id: 'API' }] })).rejects.toBeDefined();
    await expect(through({ minTests: 0 })).rejects.toBeDefined();
    const out = (await through({ runs: [{ ...run, hiddenTestFiles: { 'tests/test_hidden.py': 'x' } }] })) as { runs: Record<string, unknown>[] };
    expect(out.runs[0].hiddenTestFiles).toBeUndefined();
  });
});

describe('the executable bodies at the door', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ValidationPipe } = require('@nestjs/common') as typeof import('@nestjs/common');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dto = require('./authoring.dto') as typeof import('./authoring.dto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SEALED_FILE_MAX_CHARS } = require('./sealed-roles') as typeof import('./sealed-roles');
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true });

  it("sealed.write's contentBase64 is capped at the base64 of the largest sealed file the sealed-role door accepts", async () => {
    const through = (body: unknown) => pipe.transform(body, { type: 'body', metatype: dto.SealedFileWriteDto });
    const largest = Buffer.from('\u{1F600}'.repeat(SEALED_FILE_MAX_CHARS / 2)).toString('base64');
    await expect(through({ role: 'hidden', path: 'tests/test_x.py', contentBase64: largest })).resolves.toBeDefined();
    await expect(through({ role: 'hidden', path: 'tests/test_x.py', contentBase64: 'A'.repeat(dto.SEALED_BASE64_MAX + 1) })).rejects.toBeDefined();
  });

  it("projects.upload's title is UP's to refuse, in UP's sentence (UPLOAD_TITLE_INVALID), never the door's", async () => {
    const through = (body: unknown) => pipe.transform(body, { type: 'body', metatype: dto.ProjectUploadDto });
    await expect(through({ title: '', archiveBase64: 'UEsFBg==' })).resolves.toBeDefined();
    await expect(through({ title: 'x'.repeat(500), archiveBase64: 'UEsFBg==' })).resolves.toBeDefined();
    await expect(through({ title: 7, archiveBase64: 'UEsFBg==' })).resolves.toMatchObject({ title: 7 });
  });
});
