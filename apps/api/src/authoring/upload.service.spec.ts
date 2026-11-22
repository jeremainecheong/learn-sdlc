import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { HttpException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.decorators';
import { ContentService } from '../content/content.service';
import { MemoryPackSource } from '../content/memory-pack-source';
import type { PackSource } from '../content/pack-source';
import {
  RUN_SHAPE_REFUSAL_CODES,
  RUN_SHAPE_REFUSALS,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_DETAIL_MAX,
  type UploadRefusalCode,
} from '@learnsdlc/shared';
import { HOSTILE_ARCHIVES } from '../../test/fixtures/upload-packs/hostile';
import { onePhasePack } from '../../test/fixtures/folder-packs';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { UploadService, uploadJsonOnly, uploadParseRefusal, type TeacherDraftImporter } from './upload.service';

/**
 * `UploadService.upload` over a mocked importer.
 *
 * The clean archive is TaskTrackr's own pack with its warm-up left out (the
 * one part of the format an upload refuses), zipped in-spec. The importer is
 * `importTeacherDraft`, mocked behind its interface; the data
 * source is a recorder, so "writes no row" is "nothing reached it".
 */

const REPO = path.resolve(__dirname, '../../../..');
const PACK = path.join(REPO, 'content', 'tasktrackr');

const TEACHER: AuthUser = { id: 'teacher-up-1', email: 'teacher@upload.test', role: 'INSTRUCTOR', cohort: 'default' };

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

/** A plain deflate zip, the way any archiver writes one. */
function zipOf(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const body = zlib.deflateRawSync(data);
    const sum = crc(data);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
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

/**
 * TaskTrackr's pack as an upload: every file, the warm-up left out, and its
 * `canonical/` left out too. In the folder layout `canonical/` is the
 * maintainers' reference no loader reads, and an upload in the folder
 * layout that holds one is refused by name, so a teacher's archive of
 * TaskTrackr is its project.json and its phases.
 */
function cleanPackFiles(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(PACK, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === 'warmup' || child === 'canonical' || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      if (entry.isDirectory()) visit(child);
      else out[child] = fs.readFileSync(path.join(PACK, child));
    }
  };
  visit('');
  const project = JSON.parse(out['project.json'].toString('utf8'));
  delete project.warmup;
  out['project.json'] = Buffer.from(JSON.stringify(project, null, 2));
  return out;
}

/**
 * TaskTrackr 5.0.0 as an older archive (the frozen pointer-layout pack,
 * `olderTaskTrackrPack`): for the cases about a pointer only an older archive
 * can hold, which the door reads once through its conversion.
 */
function olderPackFiles(): Record<string, Buffer> {
  const older = olderTaskTrackrPack();
  return Object.fromEntries(older.walkForDigest('').map((at) => [at, Buffer.from(older.read(at), 'utf8')]));
}

const DRAFT = { projectId: 'p-1', versionId: 'v-1', slug: 'shelf', report: { tier: 'fast', blocking: [], advisory: [] } };

function world(maxBytes = 32 * 1024 * 1024) {
  const saved: unknown[] = [];
  // Like the real importer, the mock runs `onWritten` with
  // its (recording) manager before it returns the draft.
  const importer: TeacherDraftImporter & { calls: [PackSource, { ownerId: string; title: string }][] } = {
    calls: [],
    async importTeacherDraft(source, opts) {
      importer.calls.push([source, opts]);
      await opts.onWritten?.(manager as never, { projectId: DRAFT.projectId, versionId: DRAFT.versionId, slug: DRAFT.slug });
      return DRAFT as never;
    },
  };
  const manager = {
    create: (_entity: unknown, row: unknown) => row,
    save: async (row: unknown) => {
      saved.push(row);
      return row;
    },
  };
  const dataSource = { manager, transaction: async (fn: (m: unknown) => unknown) => fn(manager) };
  const service = new UploadService(importer, new ContentService(), dataSource as never, maxBytes);
  return { service, importer, saved };
}

type Refused = {
  code: string;
  sentence: string;
  message?: string;
  findings: { code: string; where: string; sentence: string }[];
  detail?: string;
};

/** A string planted in a file body; no refusal may carry it, in part or whole. */
const PLANTED = 'QZXPLANTED7731MARK';

async function refusalOf(run: Promise<unknown>): Promise<{ status: number; body: Refused }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), body: error.getResponse() as Refused };
    }
    throw error;
  }
  throw new Error('expected a refusal, and the upload was accepted');
}

describe('UploadService (UP)', () => {
  const clean = cleanPackFiles();

  it('a clean Shelf archive reaches importTeacherDraft with a MemoryPackSource', async () => {
    const { service, importer, saved } = world();
    const archive = zipOf(clean);
    const result = await service.upload(TEACHER, { title: '  Shelf  ', archiveBase64: archive.toString('base64') });

    expect(importer.calls).toHaveLength(1);
    const [source, opts] = importer.calls[0];
    expect(source).toBeInstanceOf(MemoryPackSource);
    expect({ ownerId: opts.ownerId, title: opts.title }).toEqual({ ownerId: TEACHER.id, title: 'Shelf' });
    expect(Object.keys(opts).sort()).toEqual(['onWritten', 'ownerId', 'title']);
    // the source is the archive read once into the folder layout: its project.json lists no
    // phases, and a mount holds the archive's bytes, read back byte for byte, at its workspace path
    expect(JSON.parse(source.read('project.json')).phases).toBeUndefined();
    expect(source.read('phases/03-implementation/files/api/repository/tasks.py')).toBe(
      clean['phases/03-implementation/files/api/repository/tasks.py'].toString('utf8'),
    );
    expect(result).toMatchObject({ projectId: 'p-1', versionId: 'v-1', slug: 'shelf', version: '0.1.0', validation: DRAFT.report });
    expect(result.compile).toEqual({ phases: 6, tasks: 6, files: expect.any(Number), sandboxBudget: 20 });
    // one audit row, project.uploaded, naming no byte of the archive
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ event: 'project.uploaded', actorUserId: TEACHER.id, targetId: 'p-1' });
    expect(JSON.stringify(saved[0])).not.toContain('TaskTrackr');
  });

  it('the audit row is written inside the importer’s transaction; a failed audit write fails the upload (not a refusal) and is never logged as “the draft stands”', async () => {
    const { service, importer } = world();
    const failing = (service as unknown as { dataSource: { manager: { save: () => Promise<never> } } }).dataSource;
    const failure = new Error('audit table unavailable');
    failing.manager.save = async () => {
      throw failure;
    };
    const warned: string[] = [];
    (service as unknown as { logger: { warn: (m: string) => void; log: () => void } }).logger = {
      warn: (message: string) => warned.push(message),
      log: () => undefined,
    };
    await expect(service.upload(TEACHER, { title: 'Shelf', archiveBase64: zipOf(clean).toString('base64') })).rejects.toBe(failure);
    expect(importer.calls).toHaveLength(1);
    expect(warned.some((line) => /the draft stands/.test(line))).toBe(false);
  });

  it('the project.uploaded audit row is written inside the importer’s transaction (onWritten); when it fails, no draft remains and the failure is not a refusal', async () => {
    // A recording importer that, like the real one, keeps the draft only when
    // onWritten (run inside its transaction) returns; a throw rolls it back.
    const drafts: string[] = [];
    const auditRows: unknown[] = [];
    let failAudit = false;
    const manager = {
      create: (_entity: unknown, row: unknown) => row,
      save: async (row: unknown) => {
        if (failAudit) throw new Error('audit insert failed');
        auditRows.push(row);
        return row;
      },
    };
    const importer: TeacherDraftImporter = {
      async importTeacherDraft(_source, opts) {
        const ids = { projectId: 'p-9', versionId: 'v-9', slug: 'shelf' };
        await (opts as { onWritten?: (m: unknown, i: typeof ids) => Promise<void> }).onWritten?.(manager, ids);
        drafts.push(ids.projectId);
        return { ...ids, report: DRAFT.report } as never;
      },
    };
    const outside = { manager: { create: () => { throw new Error('the audit row was written outside the importer’s transaction'); }, save: async () => { throw new Error('outside'); } } };
    const service = new UploadService(importer, new ContentService(), outside as never, 32 * 1024 * 1024);
    const body = { title: 'Shelf', archiveBase64: zipOf(clean).toString('base64') };

    await expect(service.upload(TEACHER, body)).resolves.toMatchObject({ projectId: 'p-9' });
    expect(drafts).toEqual(['p-9']);
    expect(auditRows).toHaveLength(1);
    // the detail keeps `slug`: AuditList reads detail.slug
    expect(auditRows[0]).toMatchObject({
      event: 'project.uploaded',
      actorUserId: TEACHER.id,
      subjectUserId: TEACHER.id,
      targetId: 'p-9',
      action: 'shelf',
      detail: { slug: 'shelf', versionId: 'v-9', archiveBytes: expect.any(Number) },
    });

    failAudit = true;
    const failed = await service.upload(TEACHER, body).then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(HttpException);
    expect(drafts).toEqual(['p-9']);
  });

  it('a refused archive writes no row', async () => {
    const cases: Record<string, { body: () => unknown; code: string; finding?: string }> = {
      'not base64': { body: () => ({ title: 'Shelf', archiveBase64: '%%%not-base64%%%' }), code: 'NOT_A_ZIP' },
      'not a zip': { body: () => ({ title: 'Shelf', archiveBase64: Buffer.from('hello').toString('base64') }), code: 'NOT_A_ZIP' },
      'path escape': {
        body: () => ({ title: 'Shelf', archiveBase64: zipOf({ ...clean, '../evil.py': Buffer.from('x') }).toString('base64') }),
        code: 'PATH_CLIMB',
      },
      'canonical/.env': {
        body: () => ({ title: 'Shelf', archiveBase64: zipOf({ ...clean, 'canonical/.env': Buffer.from('K=v') }).toString('base64') }),
        code: 'SECRET_FILE',
      },
      'a run asking for more time': {
        body: () => {
          const phase = JSON.parse(clean['phases/03-implementation/phase.json'].toString('utf8'));
          phase.checks.runs[0].timeoutSeconds = 600;
          const files = { ...clean, 'phases/03-implementation/phase.json': Buffer.from(JSON.stringify(phase)) };
          return { title: 'Shelf', archiveBase64: zipOf(files).toString('base64') };
        },
        code: 'RUN_LIMIT_ABOVE_LEARNER',
        finding: 'LIMIT_TIMEOUT',
      },
      'a smoke command of its own': {
        body: () => {
          const phase = JSON.parse(clean['phases/05-deployment/phase.json'].toString('utf8'));
          phase.checks.smoke.commands = [['bash', 'api/main.py', '--selfcheck']];
          const files = { ...clean, 'phases/05-deployment/phase.json': Buffer.from(JSON.stringify(phase)) };
          return { title: 'Shelf', archiveBase64: zipOf(files).toString('base64') };
        },
        code: 'RUN_SHAPE_NOT_ALLOWED',
        finding: 'ARGV_INTERPRETER',
      },
      'a pack the loader refuses': {
        body: () => {
          const project = JSON.parse(clean['project.json'].toString('utf8'));
          project.version = 'not-a-version';
          return { title: 'Shelf', archiveBase64: zipOf({ ...clean, 'project.json': Buffer.from(JSON.stringify(project)) }).toString('base64') };
        },
        code: 'NOT_A_PACK',
      },
      'a warm-up, which the loader would read off the host disk': {
        body: () => {
          const project = JSON.parse(clean['project.json'].toString('utf8'));
          project.warmup = '../../../../../../../../etc';
          return { title: 'Shelf', archiveBase64: zipOf({ ...clean, 'project.json': Buffer.from(JSON.stringify(project)) }).toString('base64') };
        },
        code: 'WARMUP_NOT_UPLOADABLE',
      },
      'no title': { body: () => ({ title: '   ', archiveBase64: zipOf(clean).toString('base64') }), code: 'TITLE_INVALID' },
      // a title is held to door-rules' storableText, as every other stored string is
      'a title with a lone high surrogate': { body: () => ({ title: 'Shelf \ud800', archiveBase64: zipOf(clean).toString('base64') }), code: 'TITLE_INVALID' },
      'a title with a lone low surrogate': { body: () => ({ title: '\udc00 Shelf', archiveBase64: zipOf(clean).toString('base64') }), code: 'TITLE_INVALID' },
      'no archive': { body: () => ({ title: 'Shelf' }), code: 'NOT_A_ZIP' },
      'an entry packed by a method the reader does not read': {
        body: () => {
          const zip = zipOf({ 'project.json': Buffer.from('{}') });
          const dir = zip.readUInt32LE(zip.length - 22 + 16);
          zip.writeUInt16LE(12, 8); // local header: bzip2
          zip.writeUInt16LE(12, dir + 10); // central header: bzip2
          return { title: 'Shelf', archiveBase64: zip.toString('base64') };
        },
        code: 'UNSUPPORTED_ARCHIVE',
      },
      'an archive with no entries': { body: () => ({ title: 'Shelf', archiveBase64: zipOf({}).toString('base64') }), code: 'EMPTY_ARCHIVE' },
    };
    for (const [name, { body, code, finding }] of Object.entries(cases)) {
      const { service, importer, saved } = world();
      const refused = await refusalOf(service.upload(TEACHER, body() as never));
      // the body is the contract's ProjectUploadRefusal: the shared code, its fixed
      // sentence, and run-shape findings only for the two run-shape codes
      expect({ name, code: refused.body.code }).toEqual({ name, code });
      // the wire sentence is ALWAYS UPLOAD_REFUSALS[code],
      // a pack the loader refuses included; only NOT_A_PACK may carry `detail`
      expect({ name, sentence: refused.body.sentence }).toEqual({ name, sentence: UPLOAD_REFUSALS[code as UploadRefusalCode] });
      expect({ name, message: refused.body.message }).toEqual({ name, message: refused.body.sentence });
      if (code !== 'NOT_A_PACK') expect({ name, detail: 'detail' in refused.body }).toEqual({ name, detail: false });
      expect(refused.body.findings.map((one) => one.code)).toEqual(finding ? [finding] : []);
      for (const one of refused.body.findings) {
        expect(one.sentence).toBe(RUN_SHAPE_REFUSALS[one.code as keyof typeof RUN_SHAPE_REFUSALS]);
      }
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(typeof refused.body.sentence).toBe('string');
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    }
  });

  describe('the reader’s name limits answer their own shared code', () => {
    const expectNameTooLong = async (name: string): Promise<void> => {
      const { service, importer, saved } = world();
      const refused = await refusalOf(
        service.upload(TEACHER, { title: 'Shelf', archiveBase64: zipOf({ ...clean, [name]: Buffer.from('x') }).toString('base64') }),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('ARCHIVE_NAME_TOO_LONG');
      expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG);
      expect(refused.body.message).toBe(UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG);
      expect(refused.body.findings).toEqual([]);
      expect('detail' in refused.body).toBe(false);
      expect(JSON.stringify(refused.body)).not.toContain('nnnnnnnn');
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    };

    it('a name over 1,024 bytes is ARCHIVE_NAME_TOO_LONG', async () => {
      await expectNameTooLong(`docs/${'n'.repeat(1100)}.md`);
    });

    it('more than 64 segments is ARCHIVE_NAME_TOO_LONG', async () => {
      await expectNameTooLong(`${Array.from({ length: 65 }, () => 'd').join('/')}.md`);
    });
  });

  describe('a pack the loader refuses (the PACK_INVALID ruling)', () => {
    // a null change leaves the entry out of the archive
    const archiveWith = (changes: Record<string, Buffer | null>): string =>
      zipOf(Object.fromEntries(Object.entries({ ...clean, ...changes }).filter((one): one is [string, Buffer] => one[1] !== null))).toString('base64');
    const projectWith = (change: (project: Record<string, unknown>) => void): Buffer => {
      const project = JSON.parse(clean['project.json'].toString('utf8'));
      change(project);
      return Buffer.from(JSON.stringify(project, null, 2));
    };
    const IMPL_PHASE = 'phases/03-implementation/phase.json';

    it('PACK_INVALID answers NOT_A_PACK’s fixed sentence; the loader text appears only in detail, ≤400 characters', async () => {
      const { service, importer, saved } = world();
      const refused = await refusalOf(
        service.upload(TEACHER, {
          title: 'Shelf',
          archiveBase64: archiveWith({ 'project.json': projectWith((project) => { project.version = 'not-a-version'; }) }),
        }),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('NOT_A_PACK');
      expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(refused.body.message).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(refused.body.findings).toEqual([]);
      // the loader's own words, which name the field to fix, ride in detail only
      expect(typeof refused.body.detail).toBe('string');
      expect(refused.body.detail!.length).toBeGreaterThan(0);
      expect(refused.body.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
      expect(refused.body.detail).toMatch(/version/);
      expect(refused.body.detail).not.toMatch(/^upload\//);
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);

      // a loader text far longer than the cap is cut to it, and stays printable
      // (a graded target with a 900-character name, which the folder layout's rule quotes back)
      const long = world();
      const phase = JSON.parse(clean[IMPL_PHASE].toString('utf8'));
      phase.checks.editableTargets.push(`api/${'q'.repeat(900)}.py`);
      const cut = await refusalOf(
        long.service.upload(TEACHER, { title: 'Shelf', archiveBase64: archiveWith({ [IMPL_PHASE]: Buffer.from(JSON.stringify(phase)) }) }),
      );
      expect(cut.body.code).toBe('NOT_A_PACK');
      expect(cut.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(typeof cut.body.detail).toBe('string');
      expect(cut.body.detail!.length).toBeGreaterThan(100);
      expect(cut.body.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
      expect(cut.body.detail).toMatch(/^[\x20-\x7e]+$/);
      expect(long.importer.calls).toHaveLength(0);
      expect(long.saved).toHaveLength(0);
    });

    it('a marker planted in a file body never appears in sentence or detail', async () => {
      const notJson = (text: string) => Buffer.from(text);
      const cases: Record<string, Record<string, Buffer | null>> = {
        // the loader's own JSON.parse of a file it reads (V8 quotes an excerpt of the body)
        'an interview file that is not JSON': { 'phases/01-requirements/interview.json': notJson(`{"persona": ${PLANTED}}`) },
        'an interview file whose string holds a control character': {
          'phases/01-requirements/interview.json': notJson(`{"persona": "${PLANTED}\n"}`),
        },
        'a mutant meta.json that is not JSON': {
          'phases/04-testing/mutants/overdue_includes_done/meta.json': notJson(`[1, 2, ${PLANTED}`),
        },
        // the door's own JSON reads, before the loader
        // (an unreadable project.json takes the secret scan's folder arm, which ships no .env.example)
        'a project.json that is not JSON': { 'project.json': notJson(`{"slug": "shelf", ${PLANTED}`), 'canonical/.env.example': null },
        'a phase.json that is not JSON': { [IMPL_PHASE]: notJson(`${PLANTED}`) },
        // a loader refusal elsewhere, with the marker sitting in a prose file
        'a marker in task.md beside a bad version': {
          'phases/03-implementation/task.md': Buffer.from(`# Task\n\n${PLANTED}\n`),
          'project.json': projectWith((project) => { project.version = 'not-a-version'; }),
        },
      };
      for (const [name, changes] of Object.entries(cases)) {
        const { service, importer, saved } = world();
        const refused = await refusalOf(service.upload(TEACHER, { title: 'Shelf', archiveBase64: archiveWith(changes) }));
        expect({ name, code: refused.body.code }).toEqual({ name, code: 'NOT_A_PACK' });
        expect({ name, sentence: refused.body.sentence }).toEqual({ name, sentence: UPLOAD_REFUSALS.NOT_A_PACK });
        const said = `${refused.body.sentence}\n${refused.body.message}\n${refused.body.detail ?? ''}`;
        for (const probe of [PLANTED, PLANTED.slice(0, 6), PLANTED.slice(-6)]) {
          expect({ name, probe, echoed: said.includes(probe) }).toEqual({ name, probe, echoed: false });
        }
        // no JSON.parse excerpt at all: neither its quoted body nor its "Unexpected token 'x'"
        expect({ name, excerpt: /Unexpected token|is not valid JSON"|"\.\.\./.test(said) }).toEqual({ name, excerpt: false });
        expect({ name, length: (refused.body.detail ?? '').length <= UPLOAD_REFUSAL_DETAIL_MAX }).toEqual({ name, length: true });
        expect(importer.calls).toHaveLength(0);
        expect(saved).toHaveLength(0);
      }
    });

    it('detail names the file to fix: the JSON file that does not parse, by its path in the pack', async () => {
      const { service } = world();
      const refused = await refusalOf(
        service.upload(TEACHER, {
          title: 'Shelf',
          archiveBase64: archiveWith({ 'phases/01-requirements/interview.json': Buffer.from(`{"persona": ${PLANTED}}`) }),
        }),
      );
      expect(refused.body.code).toBe('NOT_A_PACK');
      expect(refused.body.detail).toContain('phases/01-requirements/interview.json');
      expect(refused.body.detail).not.toContain(PLANTED);
    });

    it('detail names the file the loader failed on, never a JSON-with-comments file it never reads', async () => {
      // JSON with comments, as a Vite template, an editor and a linter write them:
      // the loader never parses any of these, and the pack is fine with them
      // (beside the phases, not under canonical/, which an upload in the folder layout may not hold)
      const commented = {
        'web/tsconfig.app.json': Buffer.from('{\n  // the app\n  "compilerOptions": {}\n}\n'),
        '.vscode/settings.json': Buffer.from('{ /* editor */ }'),
        'web/.eslintrc.json': Buffer.from('{ // lint\n}'),
      };
      const phase01 = 'phases/01-requirements/phase.json';
      // An interview named by a path or written inline in phase.json is a pointer only an
      // older archive holds (the folder layout reads interview.json alone), so those two
      // cases are TaskTrackr 5.0.0's older archive, read once through the door's conversion.
      const older = olderPackFiles();
      const requirementsWith = (interview: unknown): Buffer => {
        const phase = JSON.parse(older[phase01].toString('utf8'));
        phase.interview = interview;
        return Buffer.from(JSON.stringify(phase, null, 2));
      };
      const cases: Record<string, { base?: Record<string, Buffer>; changes: Record<string, Buffer>; names: string }> = {
        'a broken interview file': {
          changes: { 'phases/01-requirements/interview.json': Buffer.from(`{"persona": ${PLANTED}}`) },
          names: 'phases/01-requirements/interview.json',
        },
        'a broken interview named by a bare path (an older archive)': {
          base: older,
          changes: {
            [phase01]: requirementsWith('brief.json'),
            'phases/01-requirements/brief.json': Buffer.from(`{"persona": ${PLANTED}`),
          },
          names: 'phases/01-requirements/brief.json',
        },
        'a broken inline interview (an older archive)': {
          base: older,
          changes: { [phase01]: requirementsWith({ content: `{"persona": ${PLANTED}` }) },
          names: phase01,
        },
        'a broken mutant meta.json': {
          changes: { 'phases/04-testing/mutants/badge_ignores_completion/meta.json': Buffer.from(`[1, ${PLANTED}`) },
          names: 'phases/04-testing/mutants/badge_ignores_completion/meta.json',
        },
      };
      // the interview really is read by the loader, so the clean pack plus the
      // commented files alone is accepted: they never reach a parser
      const fine = world();
      await expect(fine.service.upload(TEACHER, { title: 'Shelf', archiveBase64: archiveWith(commented) })).resolves.toMatchObject({ slug: 'shelf' });
      for (const [name, { base, changes, names }] of Object.entries(cases)) {
        const { service, importer, saved } = world();
        const archiveBase64 = base ? zipOf({ ...base, ...commented, ...changes }).toString('base64') : archiveWith({ ...commented, ...changes });
        const refused = await refusalOf(service.upload(TEACHER, { title: 'Shelf', archiveBase64 }));
        expect({ name, code: refused.body.code }).toEqual({ name, code: 'NOT_A_PACK' });
        expect({ name, sentence: refused.body.sentence }).toEqual({ name, sentence: UPLOAD_REFUSALS.NOT_A_PACK });
        const detail = refused.body.detail ?? '';
        expect({ name, names: detail.includes(names) }).toEqual({ name, names: true });
        for (const never of ['tsconfig', '.vscode', 'eslintrc', PLANTED, 'Unexpected', 'position']) {
          expect({ name, never, said: detail.includes(never) }).toEqual({ name, never, said: false });
        }
        expect(detail.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
        expect(importer.calls).toHaveLength(0);
        expect(saved).toHaveLength(0);
      }
    });

    it('detail never carries the source’s internal upload label, in either form', async () => {
      // a mount whose source is missing is a pointer only an older archive holds: TaskTrackr 5.0.0's, converted at the door
      const { service } = world();
      const older = olderPackFiles();
      const phase = JSON.parse(older[IMPL_PHASE].toString('utf8'));
      phase.files[0].source = '../../canonical/missing.py';
      const refused = await refusalOf(
        service.upload(TEACHER, { title: 'Shelf', archiveBase64: zipOf({ ...older, [IMPL_PHASE]: Buffer.from(JSON.stringify(phase)) }).toString('base64') }),
      );
      expect(refused.body.code).toBe('NOT_A_PACK');
      expect(refused.body.detail).toContain('canonical/missing.py');
      expect(refused.body.detail).not.toMatch(/upload:|(^|[\s(])upload\//);
    });
  });

  describe('the door refuses what the importer could not store, compile or publish', () => {
    const IMPL = 'phases/03-implementation/phase.json';
    const SHELF_DIR = path.join(REPO, 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf');
    const SHELF_PREVIEW_DIR = path.join(REPO, 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf-preview');
    const filesOf = (root: string): Record<string, Buffer> => {
      const out: Record<string, Buffer> = {};
      const visit = (rel: string): void => {
        for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
          const child = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
          if (entry.isDirectory()) visit(child);
          else out[child] = fs.readFileSync(path.join(root, child));
        }
      };
      visit('');
      return out;
    };
    /** Where the implementation phase mounts `web/public/<name>` locked: its `readonly/` folder. */
    const assetAt = (name: string): string => `phases/03-implementation/readonly/web/public/${name}`;
    /** `files` plus `web/public/<name>`, mounted locked in the implementation phase. */
    const withAsset = (files: Record<string, Buffer>, name: string, bytes: Buffer): Record<string, Buffer> => ({
      ...files,
      [assetAt(name)]: bytes,
    });
    const upload = (service: UploadService, files: Record<string, Buffer>) =>
      service.upload(TEACHER, { title: 'Shelf', archiveBase64: zipOf(files).toString('base64') });
    const NUL_ICON = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0]);
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]);

    it('a mounted asset holding NUL, or bytes that are not UTF-8, is refused NOT_A_PACK naming the path and the reason, never the bytes; plain text is accepted', async () => {
      const cases: Record<string, { name: string; bytes: Buffer; why: RegExp }> = {
        'a NUL-holding favicon': { name: 'favicon.ico', bytes: NUL_ICON, why: /null/i },
        'a PNG (no NUL, not UTF-8)': { name: 'logo.png', bytes: PNG, why: /UTF-8/ },
        'NUL inside otherwise plain text': { name: 'notes.txt', bytes: Buffer.from(`${PLANTED}\u0000tail\n`), why: /null/i },
      };
      for (const [label, { name, bytes, why }] of Object.entries(cases)) {
        const { service, importer, saved } = world();
        const refused = await refusalOf(upload(service, withAsset(clean, name, bytes)));
        expect({ label, status: refused.status, code: refused.body.code }).toEqual({ label, status: 400, code: 'NOT_A_PACK' });
        expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
        expect(refused.body.message).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
        expect(refused.body.findings).toEqual([]);
        expect({ label, names: (refused.body.detail ?? '').includes(assetAt(name)) }).toEqual({ label, names: true });
        expect({ label, why: why.test(refused.body.detail ?? '') }).toEqual({ label, why: true });
        expect((refused.body.detail ?? '').length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
        expect(JSON.stringify(refused.body)).not.toContain(PLANTED.slice(0, 6));
        expect(JSON.stringify(refused.body)).not.toMatch(/\\u0000|PNG|�/);
        expect(importer.calls).toHaveLength(0);
        expect(saved).toHaveLength(0);
      }
      const control = world();
      await expect(upload(control.service, withAsset(clean, 'robots.txt', Buffer.from('User-agent: *\n')))).resolves.toMatchObject({ slug: 'shelf' });
      expect(control.importer.calls).toHaveLength(1);
    });

    it('a binary file the loader never reads (docs, an unmounted image) is not the door’s business: accepted', async () => {
      const { service, importer } = world();
      await upload(service, { ...clean, 'docs/diagram.png': PNG, 'web/public/unused.ico': NUL_ICON });
      expect(importer.calls).toHaveLength(1);
    });

    it('a NUL or a lone surrogate written as a JSON escape in a file the pack is read from is refused NOT_A_PACK naming that file, never stored', async () => {
      const json = (rel: string, change: (value: any) => void): Record<string, Buffer> => {
        const value = JSON.parse(clean[rel].toString('utf8'));
        change(value);
        // JSON.stringify writes U+0000 as the six ASCII bytes \u0000 and a lone
        // surrogate as \ud800: every byte of the file is plain text.
        return { ...clean, [rel]: Buffer.from(JSON.stringify(value, null, 2)) };
      };
      const firstString = (value: any): void => {
        for (const key of Object.keys(value)) {
          if (typeof value[key] === 'string') {
            value[key] = `${value[key]}\u0000`;
            return;
          }
        }
        throw new Error('no top-level string to poison');
      };
      const INTERVIEW = 'phases/01-requirements/interview.json';
      const META = 'phases/04-testing/mutants/overdue_includes_done/meta.json';
      const cases: Record<string, { files: Record<string, Buffer>; file: string; why: RegExp }> = {
        'the project description': { files: json('project.json', (p) => { p.description += '\u0000'; }), file: 'project.json', why: /null/i },
        'a phase intro': { files: json(IMPL, (p) => { p.intro += '\u0000'; }), file: IMPL, why: /null/i },
        'a phase title': { files: json(IMPL, (p) => { p.title += '\u0000'; }), file: IMPL, why: /null/i },
        'an objective': { files: json(IMPL, (p) => { p.objectives[0] += '\u0000'; }), file: IMPL, why: /null/i },
        'the task block title': { files: json(IMPL, (p) => { p.task = { title: 'Lend a book\u0000' }; }), file: IMPL, why: /null/i },
        // the folder layout keeps a task's brief in the phase's taskPanel (a task block's brief is refused as a move),
        // so the brief is poisoned where it lives

        'the task block brief, in taskPanel': { files: json(IMPL, (p) => { p.taskPanel += '\u0000'; }), file: IMPL, why: /null/i },
        'a key': { files: json(IMPL, (p) => { p.assistant['note\u0000'] = 'x'; }), file: IMPL, why: /null/i },
        'the interview file': { files: json(INTERVIEW, firstString), file: INTERVIEW, why: /null/i },
        'a mutant meta.json': { files: json(META, (m) => { m.description += '\u0000'; }), file: META, why: /null/i },
        'a lone surrogate in a phase intro': { files: json(IMPL, (p) => { p.intro += '\ud800'; }), file: IMPL, why: /surrogate/i },
      };
      for (const [label, { files, file, why }] of Object.entries(cases)) {
        const { service, importer, saved } = world();
        let refused: { status: number; body: Refused };
        try {
          refused = await refusalOf(upload(service, files));
        } catch (error) {
          throw new Error(`${label}: ${(error as Error).message}`);
        }
        expect({ label, status: refused.status, code: refused.body.code }).toEqual({ label, status: 400, code: 'NOT_A_PACK' });
        expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
        expect({ label, names: (refused.body.detail ?? '').includes(file) }).toEqual({ label, names: true });
        expect({ label, why: why.test(refused.body.detail ?? '') }).toEqual({ label, why: true });
        expect((refused.body.detail ?? '').length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
        expect({ label, raw: /[\u0000\ud800-\udfff]/.test(`${refused.body.sentence} ${refused.body.detail}`) }).toEqual({ label, raw: false });
        expect(importer.calls).toHaveLength(0);
        expect(saved).toHaveLength(0);
      }
    });

    it('a mounted JSON data file holding the text of an escape (stored as written, never parsed) is accepted', async () => {
      const { service, importer } = world();
      await upload(service, withAsset(clean, 'sample.json', Buffer.from('{ "separator": "\\u0000", "pair": "\\ud83d\\ude00" }\n')));
      expect(importer.calls).toHaveLength(1);
    });

    it('PACK_NOT_TEXT: with a 200-character path the detail still ends on its remedy, within 400 characters', async () => {
      const { service } = world();
      const name = `${'n'.repeat(180)}.ico`;
      const refused = await refusalOf(upload(service, withAsset(clean, name, NUL_ICON)));
      expect(refused.body.code).toBe('NOT_A_PACK');
      expect(refused.body.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
      expect(refused.body.detail).toMatch(/upload again\.?$/);
    });

    it('a pack only the compiler refuses (a graded target mounted locked) is NOT_A_PACK with the compiler’s sentence in detail, and never reaches the importer', async () => {
      const { service, importer, saved } = world();
      // the graded target moved from files/ (editable) to readonly/ (locked)
      const files = { ...clean };
      files['phases/03-implementation/readonly/api/repository/tasks.py'] = files['phases/03-implementation/files/api/repository/tasks.py'];
      delete files['phases/03-implementation/files/api/repository/tasks.py'];
      const refused = await refusalOf(upload(service, files));
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 400, code: 'NOT_A_PACK' });
      expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(refused.body.detail).toMatch(/api\/repository\/tasks\.py/);
      // the door reads the archive in the folder layout, whose own rule names the
      // graded target that is not a file the learner edits, before the compiler is asked
      expect(refused.body.detail).toBe('phases/03-implementation: checks names api/repository/tasks.py in editableTargets, which files/ does not hold.');
      expect(refused.body.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });

    it('an importer failure that is not the archive’s (a database error) is never filed as a refusal', async () => {
      const { service } = world();
      const failure = new Error('connection terminated unexpectedly');
      (service as unknown as { importer: TeacherDraftImporter }).importer = { importTeacherDraft: async () => { throw failure; } };
      await expect(upload(service, clean)).rejects.toBe(failure);
    });

    it('a compiler throw that is not its own refusal (a TypeError) stays a 400 NOT_A_PACK but is logged as a warning naming the error class only', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const compiler = require('../content/pack-compiler') as typeof import('../content/pack-compiler');
      const spy = jest.spyOn(compiler, 'compilePack').mockImplementation(() => {
        throw new TypeError(`Cannot read properties of undefined (reading '${PLANTED}')`);
      });
      try {
        const { service, importer } = world();
        const warned: string[] = [];
        (service as unknown as { logger: { warn: (m: string) => void; log: () => void } }).logger = {
          warn: (message: string) => warned.push(message),
          log: () => undefined,
        };
        const refused = await refusalOf(upload(service, clean));
        expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 400, code: 'NOT_A_PACK' });
        expect(importer.calls).toHaveLength(0);
        expect(warned.filter((line) => /TypeError/.test(line))).toHaveLength(1);
        expect(warned.join('\n')).not.toContain(PLANTED);
      } finally {
        spy.mockRestore();
      }
    });

    it('a preview script the learner edits passes the archive’s canonical/ rule but not publish’s, so the door refuses it ARGV_SCRIPT', async () => {
      const preview = filesOf(SHELF_PREVIEW_DIR);
      const project = JSON.parse(preview['project.json'].toString('utf8'));
      // api/shelf.py ships under canonical/ AND is the implementation phase's editable target
      project.preview.service.command = ['python3', 'api/shelf.py'];
      const { service, importer, saved } = world();
      const refused = await refusalOf(upload(service, { ...preview, 'project.json': Buffer.from(JSON.stringify(project, null, 2)) }));
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 400, code: 'RUN_SHAPE_NOT_ALLOWED' });
      expect(refused.body.findings).toEqual([
        { code: 'ARGV_SCRIPT', where: 'project.preview.service.command', sentence: RUN_SHAPE_REFUSALS.ARGV_SCRIPT },
      ]);
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });

    it('the shelf and shelf-preview archives are still accepted', async () => {
      for (const dir of [SHELF_DIR, SHELF_PREVIEW_DIR]) {
        const { service, importer } = world();
        await upload(service, filesOf(dir));
        expect({ dir: path.basename(dir), calls: importer.calls.length }).toEqual({ dir: path.basename(dir), calls: 1 });
      }
    });

    it('reserved paths: a workspace file under a sealed prefix is NOT_A_PACK naming the path, never HIDDEN_IN_WORKSPACE’s false “holds the bytes of a hidden test”', async () => {
      const { service, importer, saved } = world();
      // mounted locked at the workspace path hidden/notes.md
      const files = { ...clean, 'phases/03-implementation/readonly/hidden/notes.md': Buffer.from('# Notes for the shelf\n') };
      const refused = await refusalOf(upload(service, files));
      expect(refused.body.code).not.toBe('HIDDEN_IN_WORKSPACE');
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 400, code: 'NOT_A_PACK' });
      expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
      expect(refused.body.detail).toContain('hidden/notes.md');
      expect(refused.body.detail).toContain('"hidden/"');
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });
  });

  it('a body that is not JSON is handed to the refusal before any parser reads it, and answered 415 in JSON by the NOT_A_ZIP sentence', () => {
    const parsed: string[] = [];
    const parse = (_req: unknown, _res: unknown, next: (error?: unknown) => void) => {
      parsed.push('json');
      next();
    };
    const gate = uploadJsonOnly(parse);
    const refuse = uploadParseRefusal(32 * 1024 * 1024);
    const answer = (headers: Record<string, string>, is: string | false | null) => {
      const sent: { status?: number; body?: Refused } = {};
      const res = { status: (code: number) => ({ json: (body: unknown) => { sent.status = code; sent.body = body as Refused; } }) };
      let passed = false;
      gate({ headers, is: () => is }, res, (error?: unknown) => {
        if (error === undefined) passed = true;
        else refuse(error, {}, res, () => { throw new Error('the refusal passed the error on'); });
      });
      return { passed, ...sent };
    };
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
      const res = answer({ 'content-type': type, 'content-length': '12' }, false);
      expect({ type, passed: res.passed, status: res.status }).toEqual({ type, passed: false, status: 415 });
      expect(res.body).toMatchObject({ code: 'NOT_A_ZIP', sentence: UPLOAD_REFUSALS.NOT_A_ZIP, message: UPLOAD_REFUSALS.NOT_A_ZIP, findings: [] });
      expect(res.body!.detail).toBeUndefined();
    }
    // chunked, with no type at all: refused the same way
    expect(answer({ 'transfer-encoding': 'chunked' }, false).status).toBe(415);
    expect(parsed).toEqual([]);
    // JSON goes to the parser; a request with no body goes on to the route
    expect(answer({ 'content-type': 'application/json', 'content-length': '12' }, 'application/json').passed).toBe(true);
    expect(answer({}, null).passed).toBe(true);
    expect(parsed).toEqual(['json', 'json']);
  });

  it('checks the base64 length against the archive cap before decoding anything', async () => {
    const cap = 1024;
    const { service, importer, saved } = world(cap);
    // 4/3 of the cap, rounded up to a whole base64 quantum, is the longest body that can decode within it
    const longest = 4 * Math.ceil(cap / 3);
    const tooLong = 'A'.repeat(longest + 4);
    const refused = await refusalOf(service.upload(TEACHER, { title: 'Shelf', archiveBase64: tooLong }));
    expect(refused.body.code).toBe('ARCHIVE_TOO_LARGE');
    expect(refused.status).toBe(413);
    // a one-byte-over archive whose base64 still fits the quantum is refused after decoding, by the same sentence
    const over = Buffer.alloc(cap + 1, 0x41).toString('base64');
    const byDecode = await refusalOf(service.upload(TEACHER, { title: 'Shelf', archiveBase64: over }));
    expect(byDecode.body.code).toBe('ARCHIVE_TOO_LARGE');
    expect(byDecode.body.sentence).toBe(refused.body.sentence);
    expect(importer.calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('the slug is never taken from the archive: only the title reaches the importer', async () => {
    const { service, importer } = world();
    const project = JSON.parse(clean['project.json'].toString('utf8'));
    project.slug = 'tasktrackr';
    await service.upload(TEACHER, {
      title: 'Books on a shelf',
      archiveBase64: zipOf({ ...clean, 'project.json': Buffer.from(JSON.stringify(project)) }).toString('base64'),
    });
    expect({ ownerId: importer.calls[0][1].ownerId, title: importer.calls[0][1].title }).toEqual({ ownerId: TEACHER.id, title: 'Books on a shelf' });
  });

  describe('at the production cap (IMPORT_MAX_BYTES default, 32 MiB)', () => {
    const PROD = 32 * 1024 * 1024;

    /** Seeded bytes that deflate barely at all, so the archive is as large as its contents. */
    function noise(bytes: number, seed: number): Buffer {
      const out = Buffer.alloc(bytes);
      let s = seed >>> 0;
      for (let i = 0; i < bytes; i += 1) {
        s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
        out[i] = s >>> 24;
      }
      return out;
    }

    it('a valid archive whose base64 is over 4.5 million characters is read, never a 500', async () => {
      const { service, importer } = world(PROD);
      const archive = zipOf({ ...clean, 'docs/scan.bin': noise(4 * 1024 * 1024, 7) });
      const encoded = archive.toString('base64');
      expect(encoded.length).toBeGreaterThan(4_500_000);
      await service.upload(TEACHER, { title: 'Shelf', archiveBase64: encoded });
      expect(importer.calls).toHaveLength(1);
    });

    it('a one-byte-over archive is refused by sentence (413), never a 500', async () => {
      const { service, importer, saved } = world(PROD);
      const over = Buffer.alloc(PROD + 1, 0x41).toString('base64');
      // its base64 is no longer than the cap's own, so only the decoded length can tell
      expect(over.length).toBe(4 * Math.ceil(PROD / 3));
      const refused = await refusalOf(service.upload(TEACHER, { title: 'Shelf', archiveBase64: over }));
      expect(refused.status).toBe(413);
      expect(refused.body.code).toBe('ARCHIVE_TOO_LARGE');
      expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE);
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    });

    it('base64 that is not canonical is refused NOT_A_ZIP, at any length', async () => {
      const { service } = world(PROD);
      const good = zipOf(clean).toString('base64');
      const bad: Record<string, string> = {
        'a space inside': `${good.slice(0, 40)} ${good.slice(41)}`,
        'a newline inside': `${good.slice(0, 40)}\n${good.slice(41)}`,
        'padding in the middle': `QQ==${good.slice(4)}`,
        'non-zero bits in the last quantum': 'QR==',
        'url-safe alphabet': good.replace(/\+/g, '-').replace(/\//g, '_').padEnd(good.length, 'A'),
      };
      for (const [name, body] of Object.entries(bad)) {
        if (name === 'url-safe alphabet' && body === good) continue;
        const refused = await refusalOf(service.upload(TEACHER, { title: 'Shelf', archiveBase64: body }));
        expect({ name, code: refused.body.code }).toEqual({ name, code: 'NOT_A_ZIP' });
      }
    });
  });

  it('every hostile archive (HOSTILE_ARCHIVES) draws its expected code at the production cap, through the real loader, and nothing reaches the importer', async () => {
    const refusedSet = HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'refused');
    expect(refusedSet.length).toBeGreaterThanOrEqual(29);
    for (const hostile of refusedSet) {
      const { service, importer, saved } = world(32 * 1024 * 1024);
      const refused = await refusalOf(
        service.upload(TEACHER, { title: 'Books on a shelf', archiveBase64: hostile.build().toString('base64') }),
      );
      expect({ name: hostile.name, code: refused.body.code }).toEqual({ name: hostile.name, code: hostile.expectedUploadCode });
      expect(refused.body.sentence).toBe(UPLOAD_REFUSALS[hostile.expectedUploadCode!]);
      if ((RUN_SHAPE_REFUSAL_CODES as readonly string[]).includes(hostile.expectedCode!)) {
        expect({ name: hostile.name, findings: refused.body.findings.map((one) => one.code) }).toEqual({
          name: hostile.name,
          findings: expect.arrayContaining([hostile.expectedCode]),
        });
      }
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(importer.calls).toHaveLength(0);
      expect(saved).toHaveLength(0);
    }
  });

  it('the one accepted hostile archive (an archive-declared reserved slug) reaches the importer with the title only', async () => {
    const accepted = HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'accepted');
    expect(accepted.map((one) => one.name)).toEqual(['slug-tasktrackr']);
    for (const hostile of accepted) {
      const { service, importer } = world(32 * 1024 * 1024);
      await service.upload(TEACHER, { title: 'Books on a shelf', archiveBase64: hostile.build().toString('base64') });
      expect(importer.calls).toHaveLength(1);
      expect({ ownerId: importer.calls[0][1].ownerId, title: importer.calls[0][1].title }).toEqual({ ownerId: TEACHER.id, title: 'Books on a shelf' });
    }
  });

  it('a folder-layout archive holding warmup/ is refused at the door as a warm-up, naming no path on the server', async () => {
    const { service, importer, saved } = world();
    const files = Object.fromEntries(
      Object.entries({ ...onePhasePack(), 'warmup/warmup.json': '{ "title": "Warm-up" }', 'warmup/brief.md': 'Warm up.\n' }).map(([at, text]) => [at, Buffer.from(text, 'utf8')]),
    );
    const refused = await refusalOf(service.upload(TEACHER, { title: 'Folders', archiveBase64: zipOf(files).toString('base64') }));
    expect(refused.status).toBe(400);
    // the door's own warm-up refusal comes first (checkUploadShape); the loader's warmupUploaded stays behind it
    expect(refused.body.code).toBe('WARMUP_NOT_UPLOADABLE');
    expect(refused.body.sentence).toBe(UPLOAD_REFUSALS.WARMUP_NOT_UPLOADABLE);
    expect(JSON.stringify(refused.body)).not.toContain(process.cwd());
    expect(JSON.stringify(refused.body)).not.toContain('upload:');
    expect(importer.calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('an archive wrapped in one top-level folder is read from inside it', async () => {
    const { service, importer } = world();
    const wrapped = Object.fromEntries(Object.entries(clean).map(([name, bytes]) => [`shelf/${name}`, bytes]));
    await service.upload(TEACHER, { title: 'Shelf', archiveBase64: zipOf(wrapped).toString('base64') });
    // read from inside the folder, then once into the folder layout: the archive's project.json less its phase list
    const { phases: _listed, ...project } = JSON.parse(clean['project.json'].toString('utf8'));
    expect(JSON.parse(importer.calls[0][0].read('project.json'))).toEqual(project);
  });
});
