import 'reflect-metadata';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UPLOAD_REFUSALS } from '@learnsdlc/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { ALL_ENTITIES, UserEntity } from '../db/entities';
import { packFilesOf, writeZip } from '../../test/fixtures/upload-packs/archive';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { UploadService } from './upload.service';

/**
 * The upload door's text rule, through the real importer, on PostgreSQL 16.
 *
 * `content_blobs.bytes` is `text`, and PostgreSQL text cannot hold U+0000:
 * without the rule a NUL-holding mounted file would reach `writeBlobs` inside
 * the importer's transaction and escape as driver error 22021 (a 500), and a
 * binary file without NUL would be stored decoded leniently, mangled to
 * U+FFFD. Both are a 400 `NOT_A_PACK` from the door, before any row is written.
 *
 * Needs a PostgreSQL config (`POSTGRES_TEST_CONFIG`), one scratch schema `rx_up3_<uuid>`
 * per run, dropped in afterAll; skipped without the config.
 */

const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rx_up3';
const SHELF = path.resolve(__dirname, '../../test/fixtures/upload-packs/shelf');
const OWNER_ID = '7a1c3e55-2b4d-4f60-9e81-0c2d3b4a5f68';
const TEACHER: AuthUser = { id: OWNER_ID, email: 'teacher@upload-door.test', role: 'INSTRUCTOR', cohort: 'default' };
const IMPL = 'phases/03-implementation/phase.json';

/** Where the implementation phase mounts `web/public/<name>` locked, in the folder layout: its `readonly/` folder. */
const assetAt = (name: string): string => `phases/03-implementation/readonly/web/public/${name}`;

/** The shelf fixture plus `web/public/<name>`, mounted locked in the implementation phase, as an upload body. */
function withAsset(name: string, bytes: Buffer): { title: string; archiveBase64: string } {
  const files = packFilesOf(SHELF).map((one) => ({ name: one.name, data: one.data }));
  files.push({ name: assetAt(name), data: bytes });
  return { title: `Door ${name}`, archiveBase64: writeZip(files).toString('base64') };
}

describePg('on PostgreSQL: the door refuses bytes PostgreSQL text cannot hold, or would mangle', () => {
  let admin: DataSource;
  let one: DataSource;
  let service: UploadService;
  const schema = scratchSchema(PREFIX);

  const counts = async () => {
    const [row] = await one.query(
      'SELECT (SELECT count(*) FROM projects) AS p, (SELECT count(*) FROM project_versions) AS v, (SELECT count(*) FROM project_files) AS f, (SELECT count(*) FROM content_blobs) AS b',
    );
    return { projects: Number(row.p), versions: Number(row.v), files: Number(row.f), blobs: Number(row.b) };
  };

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const extra = { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 2 };
    const migrate = await new DataSource({ ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES), extra } as never).initialize();
    await migrate.runMigrations({ transaction: 'all' });
    await migrate.destroy();
    one = await new DataSource({ ...postgresOptions(url!, schema, [], ALL_ENTITIES), extra } as never).initialize();
    await one.manager.insert(UserEntity, { id: OWNER_ID, email: TEACHER.email, passwordHash: 'x', displayName: 'door teacher', role: 'INSTRUCTOR' } as never);
    const content = new ContentService();
    service = new UploadService(new ProjectImporterService(content, one), content, one, 32 * 1024 * 1024);
  }, 180000);

  afterAll(async () => {
    if (one?.isInitialized) await one.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      const left = await admin.query(`SELECT count(*) AS n FROM pg_namespace WHERE nspname LIKE '${PREFIX}\\_%'`);
      expect(Number(left[0].n)).toBe(0);
      await admin.destroy();
    }
  });

  const refusalOf = async (run: Promise<unknown>): Promise<{ http: boolean; status?: number; code?: string; detail?: string; driver?: string }> => {
    try {
      await run;
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse() as { code?: string; detail?: string };
        return { http: true, status: error.getStatus(), code: body.code, detail: body.detail };
      }
      const failure = error as { driverError?: { code?: string }; code?: string };
      return { http: false, driver: failure?.driverError?.code ?? failure?.code };
    }
    return { http: false, driver: 'accepted' };
  };

  it('control: shelf with a plain-text asset imports, and the stored bytes are the uploaded bytes', async () => {
    const text = 'User-agent: *\nDisallow:\n';
    const out = await service.upload(TEACHER, withAsset('robots.txt', Buffer.from(text)));
    const rows = await one.query(
      `SELECT b.bytes AS bytes FROM project_files f JOIN content_blobs b ON b.sha = f."blobSha" WHERE f."projectVersionId" = $1 AND f.path = $2`,
      [out.versionId, 'web/public/robots.txt'],
    );
    expect(rows.map((row: { bytes: string }) => row.bytes)).toEqual([text]);
  });

  it('the project.uploaded audit row is part of the draft’s transaction: when its insert fails, no draft row remains (and it is not a refusal)', async () => {
    const before = await counts();
    await one.query('ALTER TABLE audit_events RENAME TO audit_events_away');
    let said: Awaited<ReturnType<typeof refusalOf>>;
    try {
      said = await refusalOf(service.upload(TEACHER, withAsset('humans.txt', Buffer.from('Made by a teacher.\n'))));
    } finally {
      await one.query('ALTER TABLE audit_events_away RENAME TO audit_events');
    }
    expect({ http: said.http, accepted: said.driver === 'accepted' }).toEqual({ http: false, accepted: false });
    expect(await counts()).toEqual(before);
  });

  it('a NUL-holding asset is a 400 NOT_A_PACK from the door (never driver error 22021), and no row is written', async () => {
    const before = await counts();
    const said = await refusalOf(service.upload(TEACHER, withAsset('favicon.ico', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0]))));
    expect({ http: said.http, status: said.status, code: said.code, driver: said.driver }).toEqual({ http: true, status: 400, code: 'NOT_A_PACK', driver: undefined });
    expect(said.detail).toContain(assetAt('favicon.ico'));
    expect(await counts()).toEqual(before);
  });

  it('a binary asset without NUL (a PNG signature) is a 400 NOT_A_PACK, never stored mangled to U+FFFD', async () => {
    const before = await counts();
    const said = await refusalOf(service.upload(TEACHER, withAsset('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]))));
    expect({ http: said.http, status: said.status, code: said.code }).toEqual({ http: true, status: 400, code: 'NOT_A_PACK' });
    expect(said.detail).toContain(assetAt('logo.png'));
    expect(await counts()).toEqual(before);
    const mangled = await one.query(`SELECT count(*) AS n FROM project_files WHERE path LIKE '%logo.png'`);
    expect(Number(mangled[0].n)).toBe(0);
    expect(UPLOAD_REFUSALS.NOT_A_PACK).toBeTruthy();
  });

  it('a NUL or a lone surrogate written as a JSON escape (every byte ASCII) is a 400 NOT_A_PACK naming the file (never driver error 22021, never stored with the escape or as U+FFFD), and no row is written', async () => {
    const PROJECT = 'project.json';
    const edited = (rel: string, change: (value: any) => void, title: string): { title: string; archiveBase64: string } => {
      const files = packFilesOf(SHELF).map((one) => ({ name: one.name, data: one.data }));
      const at = files.find((one) => one.name === rel)!;
      const value = JSON.parse(at.data.toString('utf8'));
      change(value);
      at.data = Buffer.from(JSON.stringify(value));
      return { title, archiveBase64: writeZip(files).toString('base64') };
    };
    const cases: Record<string, { body: { title: string; archiveBase64: string }; file: string }> = {
      'phase intro': { body: edited(IMPL, (p) => { p.intro += '\u0000'; }, 'Esc intro'), file: IMPL },
      'phase title': { body: edited(IMPL, (p) => { p.title += '\u0000'; }, 'Esc title'), file: IMPL },
      'task block title': { body: edited(IMPL, (p) => { p.task = { title: 'Lend a book\u0000' }; }, 'Esc task title'), file: IMPL },
      // the folder layout keeps a task's brief in the phase's taskPanel (a task block's brief is refused as a move)
      'task block brief, in taskPanel': { body: edited(IMPL, (p) => { p.taskPanel += '\u0000'; }, 'Esc task brief'), file: IMPL },
      'an objective': { body: edited(IMPL, (p) => { p.objectives[0] += '\u0000'; }, 'Esc objective'), file: IMPL },
      'the project description': { body: edited(PROJECT, (p) => { p.description += '\u0000'; }, 'Esc description'), file: PROJECT },
      'a lone surrogate in a phase intro': { body: edited(IMPL, (p) => { p.intro += '\ud800'; }, 'Esc surrogate'), file: IMPL },
    };
    const before = await counts();
    for (const [label, { body, file }] of Object.entries(cases)) {
      const said = await refusalOf(service.upload(TEACHER, body));
      expect({ label, http: said.http, status: said.status, code: said.code, driver: said.driver }).toEqual({ label, http: true, status: 400, code: 'NOT_A_PACK', driver: undefined });
      expect({ label, names: (said.detail ?? '').includes(file) }).toEqual({ label, names: true });
      expect({ label, after: await counts() }).toEqual({ label, after: before });
    }
    const [stored] = await one.query(
      `SELECT count(*) AS mangled FROM project_phases WHERE intro LIKE '%' || chr(65533) || '%' OR title LIKE '%' || chr(65533) || '%'`,
    );
    expect(Number(stored.mangled)).toBe(0);
  });
});
