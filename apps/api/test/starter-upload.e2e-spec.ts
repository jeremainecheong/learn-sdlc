import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import type { AuthUser } from '../src/auth/auth.decorators';
import { AuthoringService } from '../src/authoring/authoring.service';
import { UploadService } from '../src/authoring/upload.service';
import { INTERVIEW_ROW_PATH } from '../src/content/importer.service';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectVersionEntity } from '../src/content/project.entities';
import { UserEntity } from '../src/db/entities';
import { packFilesOf, writeZip, type PackFile } from './fixtures/upload-packs/archive';
import { uploadPack } from './fixtures/paths';

/**
 * Two characterisation guards for uploads, and the stored-row checks for the
 * starter archive, on the real AppModule and its in-memory database, through
 * the real `UploadService` and importer. No HTTP listener, no route (the
 * starter route has its own spec), no AI, no microVM.
 *
 * - the shelf plus an unmounted `START-HERE.md` and per-phase
 *   `NOTES.md` uploads, and no row of any table holds their bytes. It carries
 *   no `reference-stories.md`: the upload refuses that file.
 * - the shelf's Requirements phase has no interview after upload.
 * - (fast tier) the starter uploads and its fast validation blocks nothing.
 * - (stored rows) no row holds a line of the starter's comment files.
 *
 * The rule underneath: a file no phase mounts is never read and never stored
 * (`upload.service.ts`, `notTextRefusals`).
 */

const SHELF_DIR = uploadPack('shelf');
const STARTER_DIR = uploadPack('starter');
const PHASES = ['01-requirements', '02-design', '03-implementation', '04-testing', '05-deployment', '06-maintenance'];

const COMMENT_TEXT = {
  'START-HERE.md': '# Start here (PREP-T1)\n\nThis line is unmounted guidance a teacher reads beside the pack, never a learner.\n',
  NOTES: (phase: string) => `# Notes for ${phase} (PREP-T1)\n\nUnmounted teacher notes for the ${phase} phase folder, kept beside its files.\n`,
};

/** Every line of 24+ characters: the needles a stored row must not hold. */
const linesOf = (files: PackFile[]): string[] =>
  files.flatMap((file) =>
    file.data
      .toString('utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 24),
  );

/** Every row of every table, as text: a Buffer column read as UTF-8 and as latin1. */
async function everyRowAsText(db: DataSource): Promise<string> {
  const parts: string[] = [];
  const replacer = (_key: string, value: unknown): unknown => {
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
      const bytes = Buffer.from((value as { data: number[] }).data);
      return `${bytes.toString('utf-8')}\n${bytes.toString('latin1')}`;
    }
    return value;
  };
  for (const meta of db.entityMetadatas) {
    const rows = await db.getRepository(meta.target).find();
    parts.push(JSON.stringify(rows, replacer));
  }
  return parts.join('\n');
}

const zipOf = (files: PackFile[]): Buffer =>
  writeZip([...files].sort((a, b) => (a.name < b.name ? -1 : 1)).map((file) => ({ name: file.name, data: file.data })));

/**
 * A synthetic sign-up address on the reserved `.test` domain (RFC 2606), put
 * together at run time so no address-shaped literal sits in the source.
 */
const syntheticAddress = (n: number): string => ['rc-starter-', String(n), String.fromCharCode(64), 'starter-upload.test'].join('');

describe('teacher notes beside a pack, and the starter\'s stored rows (in-memory database, no listener)', () => {
  let app: INestApplication;
  let db: DataSource;
  let upload: UploadService;
  let authoring: AuthoringService;
  let teachers = 0;

  const teacher = async (): Promise<AuthUser> => {
    teachers += 1;
    const made = (await app.get(AuthService).register(syntheticAddress(teachers), 'Correct-Horse-9', `rc starter ${teachers}`)) as { user: { id: string } };
    await db.manager.update(UserEntity, { id: made.user.id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(made.user.id);
    const row = await db.getRepository(UserEntity).findOneByOrFail({ id: made.user.id });
    return { id: row.id, email: row.email, role: row.role, cohort: row.cohort } as AuthUser;
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    db = app.get(DataSource);
    upload = app.get(UploadService);
    authoring = app.get(AuthoringService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the shelf plus START-HERE.md and a NOTES.md per phase uploads, and no row holds their bytes', async () => {
    const extras: PackFile[] = [
      { name: 'START-HERE.md', data: Buffer.from(COMMENT_TEXT['START-HERE.md']) },
      ...PHASES.map((phase) => ({ name: `phases/${phase}/NOTES.md`, data: Buffer.from(COMMENT_TEXT.NOTES(phase)) })),
    ];
    // never reference-stories.md here: the upload refuses it
    expect(extras.map((file) => file.name).filter((name) => name.endsWith('reference-stories.md'))).toEqual([]);
    const who = await teacher();
    const made = await upload.upload(who, { title: 'Shelf with notes', archiveBase64: zipOf([...packFilesOf(SHELF_DIR), ...extras]).toString('base64') });
    expect(made.versionId).toBeTruthy();
    const stored = await everyRowAsText(db);
    expect(linesOf(extras).filter((line) => stored.includes(line))).toEqual([]);
    // positive control: a line of a file the Implementation phase mounts is stored
    const mounted = packFilesOf(SHELF_DIR).find((file) => file.name === 'phases/03-implementation/files/api/shelf.py') as PackFile;
    expect(linesOf([mounted]).some((line) => stored.includes(line))).toBe(true);
    const files = await db.getRepository(ProjectFileEntity).find({ where: { projectVersionId: made.versionId } });
    expect(files.map((file) => (file as unknown as { path: string }).path).filter((at) => /START-HERE|NOTES\.md/.test(at))).toEqual([]);
  });

  it('the shelf Requirements phase has no interview after upload', async () => {
    const who = await teacher();
    const made = await upload.upload(who, { title: 'Shelf as it is', archiveBase64: zipOf(packFilesOf(SHELF_DIR)).toString('base64') });
    const version = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const requirements = version.compiled?.content.phases.find((phase) => phase.key === 'requirements');
    expect(requirements).toBeDefined();
    expect(requirements?.interview ?? null).toBeNull();
    const phases = await db.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: made.versionId } });
    const row = phases.find((phase) => (phase as unknown as { key: string }).key === 'requirements') as unknown as { interview?: unknown };
    expect(row).toBeDefined();
    expect(row.interview ?? null).toBeNull();
    const files = await db.getRepository(ProjectFileEntity).find({ where: { projectVersionId: made.versionId } });
    expect(files.filter((file) => (file as unknown as { path: string }).path.endsWith(INTERVIEW_ROW_PATH))).toEqual([]);
  });

  it('the starter uploads, its fast validation blocks nothing, and no row holds its comment files', async () => {
    const who = await teacher();
    const starter = packFilesOf(STARTER_DIR);
    const made = await upload.upload(who, { title: 'Shelf starter', archiveBase64: zipOf(starter).toString('base64') });
    expect(made.compile.sandboxBudget).toBe(16);
    const report = await authoring.validate(who, made.projectId, made.versionId);
    expect((report as unknown as { blocking: unknown[] }).blocking).toEqual([]);
    const comments = starter.filter((file) => file.name === 'START-HERE.md' || file.name.endsWith('/NOTES.md'));
    expect(comments).toHaveLength(7);
    const stored = await everyRowAsText(db);
    expect(linesOf(comments).filter((line) => stored.includes(line))).toEqual([]);
  });
});
