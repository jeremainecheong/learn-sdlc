import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  COHORT_IMPORT_MAX_BYTES,
  RUN_SHAPE_REFUSAL_CODES,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_DETAIL_MAX,
  type UploadRefusalCode,
} from '@learnsdlc/shared';
import { AuthService } from '../src/auth/auth.service';
import { UPLOAD_PATH, uploadBodyLimit } from '../src/authoring/upload.service';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../src/content/project.entities';
import { HOSTILE_ARCHIVES } from './fixtures/upload-packs/hostile';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';
import { uploadPack } from './fixtures/paths';

/**
 * The upload door over HTTP, on the real AppModule.
 *
 * What the unit specs cannot see: that the route is mounted where the web
 * client will call it, that the path's own body parser sits in front of it
 * (and answers a body over its limit in JSON, never an HTML 413), that the
 * guard chain refuses a learner and limits a teacher to five uploads a minute,
 * and that a refused archive leaves every table exactly as it found it.
 *
 * The archive cap is the production one (IMPORT_MAX_BYTES unset, so the
 * shared default, 32 MiB): a one-byte-over archive at that cap, about 45
 * million base64 characters, is refused by sentence over a real socket.
 * The clean archive is the Shelf pack (`upload-packs/shelf`) when it is on
 * disk, else TaskTrackr's own pack with its warm-up left out; the hostile set
 * is `HOSTILE_ARCHIVES`, each with the refusal code it expects.
 */

const CAP = COHORT_IMPORT_MAX_BYTES;
const REPO = path.resolve(__dirname, '../../..');
const SHELF = uploadPack('shelf');
const TASKTRACKR = path.join(REPO, 'content', 'tasktrackr');

/* ------------------------------ a zip writer ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string | Buffer;
  data: Buffer;
  method?: number;
  flags?: number;
  madeBy?: number;
  external?: number;
  crc?: number;
}

function zipOf(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const sum = entry.crc ?? crc(entry.data);
    const flags = (entry.flags ?? 0) | 0x0800;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.external ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/* ------------------------------ the fixtures ------------------------------ */

function filesUnder(root: string, skip: (rel: string) => boolean = () => false): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(child) || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      if (entry.isDirectory()) visit(child);
      else out[child] = fs.readFileSync(path.join(root, child));
    }
  };
  visit('');
  return out;
}

/** The clean archive: the Shelf pack, or TaskTrackr without its warm-up when the Shelf pack is not on disk. */
function fix1Files(): Record<string, Buffer> {
  if (fs.existsSync(path.join(SHELF, 'project.json'))) return filesUnder(SHELF);
  const files = filesUnder(TASKTRACKR, (rel) => rel === 'warmup');
  const project = JSON.parse(files['project.json'].toString('utf8'));
  delete project.warmup;
  files['project.json'] = Buffer.from(JSON.stringify(project, null, 2));
  return files;
}

const asEntries = (files: Record<string, Buffer>): Entry[] =>
  Object.entries(files).map(([name, data]) => ({ name, data }));

/** The hostile set (each refused archive with the door code it expects), plus a body that is not a zip at all. */
function fix2(): { attack: string; archive: Buffer; code: UploadRefusalCode; finding?: string }[] {
  return [
    ...HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'refused').map((one) => ({
      attack: one.name,
      archive: one.build(),
      code: one.expectedUploadCode!,
      finding: (RUN_SHAPE_REFUSAL_CODES as readonly string[]).includes(one.expectedCode!) ? one.expectedCode! : undefined,
    })),
    { attack: 'not a zip', archive: Buffer.from('plainly not an archive'), code: 'NOT_A_ZIP' as const },
    // the reader's name limits, each under its own shared code
    {
      attack: 'a name over 1,024 bytes',
      archive: zipOf([...asEntries(fix1Files()), { name: `docs/${'n'.repeat(1100)}.md`, data: Buffer.from('x') }]),
      code: 'ARCHIVE_NAME_TOO_LONG' as const,
    },
    {
      attack: 'a name with more than 64 parts (folders and the file name)',
      archive: zipOf([...asEntries(fix1Files()), { name: `${Array.from({ length: 65 }, () => 'd').join('/')}.md`, data: Buffer.from('x') }]),
      code: 'ARCHIVE_NAME_TOO_LONG' as const,
    },
  ];
}

/** A string planted in a file body; no response may carry it. */
const PLANTED = 'QZXPLANTED7731MARK';

/* --------------------------------- the spec -------------------------------- */

describe('teacher upload (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();
  let accounts = 0;
  let address = 0;

  /** Each request from its own address, so the path's per-address gate measures the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.77.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  const account = async (role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN') => {
    accounts += 1;
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `up-${accounts}-${stamp}@teacher-upload.test`, password: 'Correct-Horse-9', displayName: `up ${accounts}` })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  /** A teacher is good for five uploads a minute; a fresh one for each batch. */
  let teacher: { id: string; token: string } | null = null;
  let used = 0;
  const uploader = async () => {
    if (!teacher || used >= 5) {
      teacher = await account('INSTRUCTOR');
      used = 0;
    }
    used += 1;
    return teacher;
  };

  const upload = async (archive: Buffer | string, title = 'Books on a shelf') => {
    const who = await uploader();
    return request(http)
      .post(UPLOAD_PATH)
      .set(bearer(who.token))
      .set(from())
      .send({ title, archiveBase64: typeof archive === 'string' ? archive : archive.toString('base64') });
  };

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
    // Test-only: read the client address from X-Forwarded-For, so each request
    // can arrive from its own address (see `from`).
    ({ app, http } = await bootApi({ trustProxy: true }));
    db = app.get(DataSource);
  });

  afterAll(async () => {
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
    await app?.close();
  });

  it('uploading the Shelf pack yields a draft whose fast validation is clean', async () => {
    const res = await upload(zipOf(asEntries(fix1Files())));
    expect({ status: res.status, body: res.status >= 400 ? res.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    const { projectId, versionId, slug } = res.body as { projectId: string; versionId: string; slug: string };
    expect(projectId).toBeTruthy();
    expect(versionId).toBeTruthy();
    // the slug is the title's, never the archive's
    expect(slug).toMatch(/^books-on-a-shelf/);

    const project = await db.getRepository(ProjectEntity).findOneByOrFail({ id: projectId });
    expect(project.ownerUserId).toBe(teacher!.id);
    expect(project.platformOwned).toBe(false);
    expect(project.isDefault).toBe(false);
    const version = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    expect(version.status).toBe('draft');

    const validated = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${versionId}/validate`)
      .set(bearer(teacher!.token))
      .expect(200);
    expect(validated.body.blocking).toEqual([]);

    const audit = await db.getRepository(AuditEventEntity).findOneByOrFail({ targetId: projectId, event: 'project.uploaded' as never });
    expect(audit.actorUserId).toBe(teacher!.id);
  });

  it('every refused hostile archive is refused with 4xx and writes no row (row counts before and after)', async () => {
    const before = await rowCounts();
    const set = fix2();
    expect(set.length).toBe(HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'refused').length + 3);
    const runtimeDetails: unknown[] = [];
    for (const { attack, archive, code, finding } of set) {
      const res = await upload(archive);
      expect({ attack, status: res.status >= 400 && res.status < 500, code: res.body?.code }).toEqual({ attack, status: true, code });
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.sentence).toBe(UPLOAD_REFUSALS[code]);
      expect(res.body.message).toBe(UPLOAD_REFUSALS[code]);
      // RUNTIME_OUTSIDE_PROFILE carries the sentence naming the package; every
      // other code but NOT_A_PACK carries no detail.
      if (code === 'RUNTIME_OUTSIDE_PROFILE') {
        runtimeDetails.push(res.body.detail);
        expect({ attack, sentence: String(res.body.sentence).includes('requests') }).toEqual({ attack, sentence: false });
      } else if (code !== 'NOT_A_PACK') expect({ attack, detail: 'detail' in res.body }).toEqual({ attack, detail: false });
      if (finding) expect({ attack, findings: (res.body.findings as { code: string }[]).map((one) => one.code) }).toEqual({ attack, findings: expect.arrayContaining([finding]) });
      // no byte of the archive comes back
      expect(JSON.stringify(res.body)).not.toContain(archive.toString('base64').slice(0, 64));
    }
    expect(runtimeDetails).toEqual([
      'project.runtime asks for requests, which is outside the runtime this deployment bakes. Use only the packages the runtime profile lists, and upload again.',
    ]);
    expect(await rowCounts()).toEqual(before);
  });

  it('the accepted hostile archive (project.json names tasktrackr) imports under a slug minted from the title, never the archive’s', async () => {
    for (const hostile of HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'accepted')) {
      const res = await upload(hostile.build(), 'Books on a shelf');
      expect({ attack: hostile.name, status: res.status }).toEqual({ attack: hostile.name, status: 201 });
      expect(res.body.slug).not.toBe(hostile.mintedSlugIsNot);
      expect(res.body.slug).toMatch(/^books-on-a-shelf/);
    }
  });

  it('a one-byte-over archive is refused by sentence, not by an HTML 413', async () => {
    const before = await rowCounts();
    const over = Buffer.alloc(CAP + 1, 0x41);
    const res = await upload(over);
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.code).toBe('ARCHIVE_TOO_LARGE');
    expect(res.body.sentence).toBe(UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE);
    // a body over the path's own parser limit is answered the same way, in JSON
    const huge = 'A'.repeat(uploadBodyLimit(CAP) + 16);
    const parsed = await upload(huge);
    expect(parsed.status).toBe(413);
    expect(parsed.headers['content-type']).toMatch(/application\/json/);
    expect(parsed.body.code).toBe('ARCHIVE_TOO_LARGE');
    expect(parsed.text).not.toMatch(/<html|<!DOCTYPE/i);
    expect(await rowCounts()).toEqual(before);
  });

  it('a pack the loader refuses answers NOT_A_PACK’s fixed sentence over a real socket; the loader text rides only in detail (≤400), never a planted byte, and no row is written', async () => {
    const before = await rowCounts();
    const files = fix1Files();
    const project = JSON.parse(files['project.json'].toString('utf8'));
    project.version = 'not-a-version';
    const bad: Record<string, Record<string, Buffer>> = {
      'a version that is not one, a marker in a prose file': {
        'project.json': Buffer.from(JSON.stringify(project, null, 2)),
        // a teacher's own note beside phase.json (the folder layout neither stores nor reads it)
        'phases/03-implementation/NOTES.md': Buffer.from(`# Notes\n\n${PLANTED}\n`),
      },
      'a mutant meta.json that is not JSON': {
        'phases/04-testing/mutants/lend_twice_allowed/meta.json': Buffer.from(`{"run": "api", ${PLANTED}`),
      },
    };
    for (const [attack, changes] of Object.entries(bad)) {
      const res = await upload(zipOf(asEntries({ ...files, ...changes })));
      expect({ attack, status: res.status, code: res.body?.code }).toEqual({ attack, status: 400, code: 'NOT_A_PACK' });
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(res.body.message).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(res.body.findings).toEqual([]);
      expect(typeof res.body.detail).toBe('string');
      expect(res.body.detail.length).toBeGreaterThan(0);
      expect(res.body.detail.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
      expect({ attack, echoed: res.text.includes(PLANTED) || res.text.includes(PLANTED.slice(0, 6)) }).toEqual({ attack, echoed: false });
      expect(res.text).not.toMatch(/Unexpected token/);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('a non-JSON body on the upload path answers JSON, never an HTML page', async () => {
    const before = await rowCounts();
    const who = await account('INSTRUCTOR');
    const bodies: Record<string, { type: string; body: string }> = {
      // over the global urlencoded parser's 4 MB, which would answer an HTML 413
      'a form body over 4 MB': { type: 'application/x-www-form-urlencoded', body: `title=x&archiveBase64=${'A'.repeat(5 * 1024 * 1024)}` },
      // refused before it is read, a large body must still be
      // drained so the client reads the refusal rather than a reset socket
      'a 24 MB form body (1)': { type: 'application/x-www-form-urlencoded', body: `archiveBase64=${'A'.repeat(24 * 1024 * 1024)}` },
      'a 24 MB form body (2)': { type: 'application/x-www-form-urlencoded', body: `archiveBase64=${'A'.repeat(24 * 1024 * 1024)}` },
      'a 24 MB text body': { type: 'text/plain', body: 'A'.repeat(24 * 1024 * 1024) },
      'a small form body': { type: 'application/x-www-form-urlencoded', body: `title=x&archiveBase64=${zipOf(asEntries(fix1Files())).toString('base64').slice(0, 64)}` },
      'plain text': { type: 'text/plain', body: 'plainly not a request' },
      'a multipart body': { type: 'multipart/form-data; boundary=x', body: '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n--x--\r\n' },
    };
    for (const [attack, { type, body }] of Object.entries(bodies)) {
      const res = await request(http).post(UPLOAD_PATH).set(bearer(who.token)).set(from()).set('content-type', type).send(body);
      expect({ attack, client: res.status >= 400 && res.status < 500 }).toEqual({ attack, client: true });
      expect({ attack, type: res.headers['content-type'] }).toEqual({ attack, type: expect.stringMatching(/application\/json/) });
      expect({ attack, html: /<html|<!DOCTYPE|<pre>/i.test(res.text) }).toEqual({ attack, html: false });
      expect({ attack, code: res.body.code }).toEqual({ attack, code: 'NOT_A_ZIP' });
      expect(res.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_ZIP);
      expect(res.text).not.toContain('AAAAAAAA');
    }
    // the staff gate still answers first: no token is a 401, a learner a 403, in JSON
    const noToken = await request(http).post(UPLOAD_PATH).set(from()).set('content-type', 'text/plain').send('x');
    expect(noToken.status).toBe(401);
    expect(noToken.headers['content-type']).toMatch(/application\/json/);
    const learner = await account('LEARNER');
    const byLearner = await request(http).post(UPLOAD_PATH).set(bearer(learner.token)).set(from()).set('content-type', 'text/plain').send('x');
    expect(byLearner.status).toBe(403);
    expect(await rowCounts()).toEqual({ ...before, audits: expect.any(Number) });
    expect((await rowCounts()).projects).toBe(before.projects);
  });

  it('hostile probe: every entry of hostile.ts over the real AppModule: never a 5xx; each refused one is 4xx JSON with a code and leaves project, version and blob rows unchanged; the one accepted entry adds exactly one draft', async () => {
    const coreCounts = async () => ({
      projects: await db.getRepository(ProjectEntity).count(),
      versions: await db.getRepository(ProjectVersionEntity).count(),
      blobs: await db.getRepository(ContentBlobEntity).count(),
    });
    expect(HOSTILE_ARCHIVES.length).toBeGreaterThanOrEqual(30);
    const seen: string[] = [];
    for (const hostile of HOSTILE_ARCHIVES) {
      const before = await coreCounts();
      const res = await upload(hostile.build());
      seen.push(hostile.name);
      expect({ attack: hostile.name, serverError: res.status >= 500 }).toEqual({ attack: hostile.name, serverError: false });
      expect({ attack: hostile.name, type: res.headers['content-type'] }).toEqual({ attack: hostile.name, type: expect.stringMatching(/application\/json/) });
      const after = await coreCounts();
      if (hostile.expectedOutcome === 'refused') {
        expect({ attack: hostile.name, client: res.status >= 400 && res.status < 500, code: typeof res.body?.code }).toEqual({ attack: hostile.name, client: true, code: 'string' });
        expect({ attack: hostile.name, code: res.body.code }).toEqual({ attack: hostile.name, code: hostile.expectedUploadCode });
        expect({ attack: hostile.name, rows: after }).toEqual({ attack: hostile.name, rows: before });
      } else {
        expect({ attack: hostile.name, status: res.status }).toEqual({ attack: hostile.name, status: 201 });
        expect({ attack: hostile.name, projects: after.projects - before.projects, versions: after.versions - before.versions }).toEqual({ attack: hostile.name, projects: 1, versions: 1 });
      }
    }
    expect(seen).toEqual(HOSTILE_ARCHIVES.map((one) => one.name));
  });

  describe('what the importer could not store, compile or publish is refused at the door, by sentence', () => {
    const IMPL = 'phases/03-implementation/phase.json';
    const SHELF_PREVIEW = uploadPack('shelf-preview');
    const phaseWith = (files: Record<string, Buffer>, change: (phase: any) => void): Buffer => {
      const phase = JSON.parse(files[IMPL].toString('utf8'));
      change(phase);
      return Buffer.from(JSON.stringify(phase));
    };
    const expectNotAPack = (res: request.Response, label: string): void => {
      expect({ label, status: res.status, code: res.body?.code }).toEqual({ label, status: 400, code: 'NOT_A_PACK' });
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(typeof res.body.detail).toBe('string');
      expect(res.body.detail.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
    };

    it('a code target mounted locked (a refusal only the compiler makes) answers 400 NOT_A_PACK with rows unchanged', async () => {
      const files = fix1Files();
      // the folder layout locks a mount by where it sits (docs/authoring-format.md, "The archive layout"): the code target under readonly/
      files['phases/03-implementation/readonly/api/shelf.py'] = files['phases/03-implementation/files/api/shelf.py'];
      delete files['phases/03-implementation/files/api/shelf.py'];
      const before = await rowCounts();
      const res = await upload(zipOf(asEntries(files)));
      expect(await rowCounts()).toEqual(before);
      expectNotAPack(res, 'RR-API-1');
      expect(res.body.detail).toContain('api/shelf.py');
    });

    it('a mounted binary asset (NUL, or not UTF-8) is refused at the door (400 NOT_A_PACK naming the path), never stored', async () => {
      const assets: Record<string, Buffer> = {
        'favicon.ico': Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0]),
        'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]),
      };
      const before = await rowCounts();
      for (const [name, bytes] of Object.entries(assets)) {
        const files = fix1Files();
        // a locked mount at web/public/<name>
        files[`phases/03-implementation/readonly/web/public/${name}`] = bytes;
        const res = await upload(zipOf(asEntries(files)));
        expectNotAPack(res, name);
        expect(res.body.detail).toContain(`phases/03-implementation/readonly/web/public/${name}`);
        const stored = await db.getRepository(ProjectFileEntity).createQueryBuilder('f').where('f.path LIKE :at', { at: `%${name}` }).getCount();
        expect({ name, stored }).toEqual({ name, stored: 0 });
      }
      expect(await rowCounts()).toEqual(before);
    });

    it('a NUL or a lone surrogate written as a JSON escape in phase.json or project.json is 400 NOT_A_PACK naming the file, never a 500 or a stored draft', async () => {
      const cases: Record<string, { rel: string; change: (value: any) => void }> = {
        'a NUL in the phase intro': { rel: IMPL, change: (p) => { p.intro += '\u0000'; } },
        // a folder-layout task block holds no brief (the upload refuses one first), so the NUL rides in its title
        'a NUL in the task block title': { rel: IMPL, change: (p) => { p.task = { title: 'Lend the book.\u0000' }; } },
        'a NUL in the project description': { rel: 'project.json', change: (p) => { p.description += '\u0000'; } },
        'a lone surrogate in the phase intro': { rel: IMPL, change: (p) => { p.intro += '\ud800'; } },
      };
      const before = await rowCounts();
      for (const [label, { rel, change }] of Object.entries(cases)) {
        const files = fix1Files();
        const value = JSON.parse(files[rel].toString('utf8'));
        change(value);
        files[rel] = Buffer.from(JSON.stringify(value));
        const res = await upload(zipOf(asEntries(files)));
        expectNotAPack(res, label);
        expect({ label, names: res.body.detail.includes(rel) }).toEqual({ label, names: true });
      }
      expect(await rowCounts()).toEqual(before);
    });

    it('a preview script the learner edits is refused ARGV_SCRIPT at upload, as publish refuses it; shelf-preview itself is accepted', async () => {
      const files = filesUnder(SHELF_PREVIEW);
      const project = JSON.parse(files['project.json'].toString('utf8'));
      project.preview.service.command = ['python3', 'api/shelf.py'];
      const before = await rowCounts();
      const res = await upload(zipOf(asEntries({ ...files, 'project.json': Buffer.from(JSON.stringify(project)) })));
      expect({ status: res.status, code: res.body?.code }).toEqual({ status: 400, code: 'RUN_SHAPE_NOT_ALLOWED' });
      expect(res.body.findings).toEqual([expect.objectContaining({ code: 'ARGV_SCRIPT', where: 'project.preview.service.command' })]);
      expect(await rowCounts()).toEqual(before);
      const fine = await upload(zipOf(asEntries(filesUnder(SHELF_PREVIEW))));
      expect({ status: fine.status, body: fine.status >= 400 ? fine.body : 'ok' }).toEqual({ status: 201, body: 'ok' });
    });

    it('hostile probe: a malformed phase.json task block is 400 NOT_A_PACK naming the phase, never a 500, and writes no row', async () => {
      const blocks: Record<string, unknown> = {
        'an unknown member': { title: 'Lend a book', notes: 'x' },
        'a title that is not text': { title: 42 },
        'objectives that are not a list': { objectives: 'lend books' },
        'a title over the cap': { title: 't'.repeat(161) },
        'a brief over the cap': { brief: 'b'.repeat(20001) },
        'too many objectives': { objectives: Array.from({ length: 21 }, (_, i) => `objective ${i}`) },
        'a key that renames the task': { key: 'renamed' },
        'a block that is not an object': ['title'],
      };
      const before = await rowCounts();
      for (const [label, task] of Object.entries(blocks)) {
        const files = fix1Files();
        files[IMPL] = phaseWith(files, (phase) => {
          phase.task = task;
        });
        const res = await upload(zipOf(asEntries(files)));
        expectNotAPack(res, label);
        expect({ label, names: /03-implementation/.test(res.body.detail) }).toEqual({ label, names: true });
        expect({ label, echoed: res.text.includes('t'.repeat(40)) || res.text.includes('b'.repeat(40)) }).toEqual({ label, echoed: false });
      }
      expect(await rowCounts()).toEqual({ ...before, audits: before.audits });
    });

    it('reserved paths: a workspace file under hidden/ is 400 NOT_A_PACK naming the path, never HIDDEN_IN_WORKSPACE', async () => {
      const files = fix1Files();
      // a locked mount at hidden/notes.md
      files['phases/03-implementation/readonly/hidden/notes.md'] = Buffer.from('# Notes for the shelf\n');
      const before = await rowCounts();
      const res = await upload(zipOf(asEntries(files)));
      expect(await rowCounts()).toEqual(before);
      expectNotAPack(res, 'reserved');
      expect(res.body.detail).toContain('hidden/notes.md');
    });
  });

  it('the route is 5/60 and INSTRUCTOR/ADMIN', async () => {
    const tiny = zipOf([{ name: 'project.json', data: Buffer.from('{}') }]).toString('base64');
    // no token: the gate in front of the parser says 401 before reading a byte
    await request(http).post(UPLOAD_PATH).set(from()).send({ title: 'x', archiveBase64: tiny }).expect(401);
    // a learner: 403
    const learner = await account('LEARNER');
    await request(http).post(UPLOAD_PATH).set(bearer(learner.token)).set(from()).send({ title: 'x', archiveBase64: tiny }).expect(403);
    // an admin reaches the service (a refusal by sentence, not a role refusal)
    const admin = await account('ADMIN');
    const byAdmin = await request(http).post(UPLOAD_PATH).set(bearer(admin.token)).set(from()).send({ title: 'x', archiveBase64: tiny });
    expect(byAdmin.status).toBe(400);
    expect(byAdmin.body.sentence).toBeTruthy();
    // a teacher: five a minute, the sixth is 429
    const one = await account('INSTRUCTOR');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(http).post(UPLOAD_PATH).set(bearer(one.token)).set(from()).send({ title: 'x', archiveBase64: tiny });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
