import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { HttpException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { htmlCommentWarning, markdownKeptWarning, plainTextOf, type PhaseKey } from '@learnsdlc/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { ContentService } from '../content/content.service';
import { LAYOUT_SENTENCES } from '../content/folder-layout';
import { ProjectImporterService } from '../content/importer.service';
import { OLDER_LAYOUT_WARNING } from '../content/legacy-layout';
import { MemoryPackSource } from '../content/memory-pack-source';
import { ProjectEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { UserEntity } from '../db/entities';
import {
  codeFolder,
  configFolder,
  designFolder,
  projectJson,
  storyFolder,
  testsFolder,
  type PackFiles,
} from '../../test/fixtures/folder-packs';
import { entriesOf, writeZip, type ZipEntrySpec } from '../../test/fixtures/upload-packs/archive';
import { fixtureQuizQuestions } from '../../test/quiz-fixture';
import { checkedQuiz } from './quiz-rows';
import {
  CANONICAL_IN_UPLOAD,
  DESKTOP_FOLDER_WARNING,
  NEW_LAYOUT_SECRET,
  SEALED_DOT_PATH,
  buildPackManifest,
  checkPackFiles,
  desktopFileWarning,
  moreDesktopFilesWarning,
} from './upload-limits';
import { UploadService } from './upload.service';
import { rawPackManifestOf } from './validation';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The upload door on the derived layout: a new-layout archive read by its
 * folders, an older one
 * converted once, every teacher text stored plain, desktop leftovers named
 * and never stored, and quiz files imported through the quiz door's rules.
 *
 * The door over the real importer and an in-memory database, the archives
 * built in-spec from `folder-packs.ts`'s phases with the fixtures' zip writer.
 */

const OWNER_ID = '5b0d6a0e-1f2c-4c3d-8e4f-20a7c1d2e3f4';
const TEACHER: AuthUser = { id: OWNER_ID, email: 'teacher@folder-upload.test', role: 'INSTRUCTOR', cohort: 'default' };
const UPLOAD_PACKS = path.resolve(__dirname, '../../test/fixtures/upload-packs');

const zipOf = (files: PackFiles): Buffer =>
  writeZip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text, 'utf-8') })));

const body = (title: string, archive: Buffer) => ({ title, archiveBase64: archive.toString('base64') });

/** Shelf as it shipped in the older layout, frozen before the Shelf family moved to the folder layout. */
const OLDER_SHELF = path.resolve(__dirname, '../../test/fixtures/older-shelf');

/**
 * An older fixture directory, with entries added, replaced (by name) or
 * edited: `shelf` is the frozen older Shelf (`upload-packs/shelf` is in the
 * folder layout now); any other name is an older fixture under `upload-packs/`.
 */
function olderArchive(dir: string, change: (entries: ZipEntrySpec[]) => ZipEntrySpec[] = (one) => one): Buffer {
  return writeZip(change(entriesOf(dir === 'shelf' ? OLDER_SHELF : path.join(UPLOAD_PACKS, dir))));
}

/** A quiz file as an export writes one: `{ title, brief, order, objectives, required, checks }`. */
function quizFile(over: Record<string, unknown> = {}, checks: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Concepts',
    brief: 'Answer the five questions.',
    order: 2,
    objectives: ['Know the terms'],
    required: false,
    checks: { kind: 'quiz', questions: fixtureQuizQuestions(5), passMark: 60, criterion: 'concepts', ...checks },
    ...over,
  });
}

interface Refused {
  status: number;
  code: string;
  detail?: string;
}

/**
 * The phases an upload's run-shape rule accepts: `folder-packs.ts`'s code and
 * tests phases with one run `main` declared in TaskTrackr's shape (a flat
 * code phase loads as a unittest run, which no closed shape is).
 */
const code = (folder = '03-implementation', edit: (spec: Record<string, any>) => void = () => undefined): PackFiles =>
  codeFolder(folder, (spec) => {
    spec.checks.runs = [{ id: 'main', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'Tests', visibleTests: ['tests/test_main.py'] }];
    edit(spec);
  });
const tests = (folder = '04-testing', edit: (spec: Record<string, any>) => void = () => undefined): PackFiles =>
  testsFolder(folder, (spec) => {
    spec.checks.runs = [{ id: 'main', language: 'python', harness: 'pytest', label: 'Tests', learnerTestFiles: ['tests/test_app.py'], implFiles: ['app/core.py'], testPaths: ['tests'] }];
    edit(spec);
  });
/** Requirements, Design and Implementation, uploadable. */
const three = (): PackFiles => ({ ...projectJson(), ...storyFolder(), ...designFolder(), ...code() });

describe('the upload door on the derived layout', () => {
  let dataSource: DataSource;
  let service: UploadService;
  let titles = 0;

  /** A title no other case has used, so each draft mints its own slug. */
  const fresh = (label: string): string => `${label} ${(titles += 1)}`;

  const refusalOf = async (run: Promise<unknown>): Promise<Refused> => {
    try {
      await run;
    } catch (error) {
      if (error instanceof HttpException) {
        const said = error.getResponse() as { code: string; detail?: string };
        return { status: error.getStatus(), code: said.code, ...(said.detail !== undefined ? { detail: said.detail } : {}) };
      }
      throw error;
    }
    throw new Error('the upload was accepted');
  };

  const phasesOf = async (versionId: string) =>
    (await dataSource.getRepository(ProjectPhaseEntity).findBy({ projectVersionId: versionId })).sort((a, b) => a.order - b.order);

  const tasksOf = async (versionId: string, key: PhaseKey) => {
    const phase = await dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key });
    return (await dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id })).sort((a, b) => a.order - b.order);
  };

  const filePaths = async (versionId: string) =>
    (await dataSource.getRepository(ProjectFileEntity).findBy({ projectVersionId: versionId })).map((one) => one.path);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await memoryDataSource();
    await dataSource.manager.insert(UserEntity, { id: OWNER_ID, email: TEACHER.email, passwordHash: 'x', displayName: 'folder teacher', role: 'INSTRUCTOR' } as never);
    const content = new ContentService();
    service = new UploadService(new ProjectImporterService(content, dataSource), content, dataSource, 16 * 1024 * 1024);
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('uploads a three-phase folder archive as a draft of three phases, orders 1 to 3', async () => {
    const made = await service.upload(TEACHER, body(fresh('Three'), zipOf(three())));
    expect(made.compile.phases).toBe(3);
    const phases = await phasesOf(made.versionId);
    expect(phases.map((one) => [one.key, one.order])).toEqual([['requirements', 1], ['design', 2], ['implementation', 3]]);
    expect(made.warnings).toBeUndefined();
  });

  it('uploads an archive holding phases/03-implementation/files/.DS_Store and a top-level __MACOSX/ with two warnings and no mount for either', async () => {
    const files = { ...three(), 'phases/03-implementation/files/.DS_Store': 'finder', '__MACOSX/._project.json': 'fork' };
    const made = await service.upload(TEACHER, body(fresh('Desktop'), zipOf(files)));
    expect(made.warnings).toEqual([
      'left out: phases/03-implementation/files/.DS_Store is a desktop file',
      'left out: __MACOSX/ is a desktop folder',
    ]);
    expect(DESKTOP_FOLDER_WARNING).toBe('left out: __MACOSX/ is a desktop folder');
    const paths = await filePaths(made.versionId);
    expect(paths.filter((at) => at.includes('.DS_Store') || at.includes('__MACOSX'))).toEqual([]);
  });

  it('says five desktop files and then a count', async () => {
    const files: PackFiles = { ...three() };
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) files[`phases/03-implementation/files/${name}/.DS_Store`] = 'finder';
    const made = await service.upload(TEACHER, body(fresh('Seven'), zipOf(files)));
    expect(made.warnings).toEqual([
      ...['a', 'b', 'c', 'd', 'e'].map((name) => desktopFileWarning(`phases/03-implementation/files/${name}/.DS_Store`)),
      moreDesktopFilesWarning(2),
    ]);
    expect(moreDesktopFilesWarning(2)).toBe('left out: 2 more desktop files');
  });

  it('uploads an archive with .DS_Store in hidden_tests/main/, solution/, mutants/ and quizzes/ and a __MACOSX/ inside a phase folder with warnings and no refusal, and stores none of them', async () => {
    const files: PackFiles = {
      ...projectJson(),
      ...storyFolder(),
      ...code(),
      ...tests(),
      'phases/03-implementation/hidden_tests/main/.DS_Store': 'finder',
      'phases/03-implementation/solution/.DS_Store': 'finder',
      'phases/04-testing/mutants/.DS_Store': 'finder',
      'phases/01-requirements/quizzes/.DS_Store': 'finder',
      'phases/03-implementation/__MACOSX/._phase.json': 'fork',
    };
    const made = await service.upload(TEACHER, body(fresh('Sealed desktop'), zipOf(files)));
    expect(made.warnings).toEqual([
      'left out: phases/01-requirements/quizzes/.DS_Store is a desktop file',
      'left out: phases/03-implementation/hidden_tests/main/.DS_Store is a desktop file',
      'left out: phases/03-implementation/solution/.DS_Store is a desktop file',
      'left out: phases/04-testing/mutants/.DS_Store is a desktop file',
      'left out: phases/03-implementation/__MACOSX/ is a desktop folder',
    ]);
    const paths = await filePaths(made.versionId);
    expect(paths.filter((at) => at.includes('.DS_Store') || at.includes('__MACOSX'))).toEqual([]);
    expect((await tasksOf(made.versionId, 'requirements')).map((one) => one.taskKey)).toEqual(['main']);
  });

  it('prints a desktop file\'s path through plainPath', async () => {
    const long = `phases/03-implementation/files/${'d'.repeat(200)}/${'e'.repeat(20)}/.DS_Store`;
    expect(long.length).toBeGreaterThan(250);
    const files = {
      ...three(),
      [long]: 'finder',
      'phases/03-implementation/files/my notes/.DS_Store': 'finder',
      'phases/03-implementation/files/plain/.DS_Store': 'finder',
    };
    const made = await service.upload(TEACHER, body(fresh('Plain path'), zipOf(files)));
    const warnings = made.warnings ?? [];
    expect(warnings.filter((one) => one === 'left out: a file in the archive is a desktop file')).toHaveLength(2);
    expect(warnings).toContain('left out: phases/03-implementation/files/plain/.DS_Store is a desktop file');
    expect(warnings.every((one) => !one.includes('my notes') && !one.includes('ddddd'))).toBe(true);
  });

  it('refuses phases/03-implementation/files/.pytest_cache/v/ by the machine-output sentence', async () => {
    const files = { ...three(), 'phases/03-implementation/files/.pytest_cache/v/cache/nodeids': '[]' };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Cache'), zipOf(files))))).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: 'phases/03-implementation/files/.pytest_cache is machine output. Remove it from the archive and upload again.',
    });
  });

  it('refuses an editor\'s settings folder by its own sentence', async () => {
    const files = { ...three(), 'phases/03-implementation/files/.vscode/settings.json': '{}' };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Editor'), zipOf(files))))).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: "phases/03-implementation/files/.vscode is an editor's settings folder. Remove it from the archive and upload again.",
    });
  });

  it('refuses a .env.example in a new-layout archive with the sentence that has no exception clause, and keeps today\'s sentence for an older archive', async () => {
    const source = new MemoryPackSource([
      { name: 'project.json', bytes: Buffer.from('{}') },
      { name: 'canonical/.env.example', bytes: Buffer.from('PORT=1\n') },
      { name: 'phases/03-implementation/files/.env.example', bytes: Buffer.from('PORT=1\n') },
    ], 'upload', '');
    const names = ['project.json', 'canonical/.env.example', 'phases/03-implementation/files/.env.example'];
    expect(checkPackFiles(source, names, { layout: 'folder' }).map((one) => one.sentence)).toEqual([
      'canonical/.env.example looks like a secret (a .env file, a private key or a credential). Leave secrets out of the archive and upload again.',
      'phases/03-implementation/files/.env.example looks like a secret (a .env file, a private key or a credential). Leave secrets out of the archive and upload again.',
    ]);
    expect(NEW_LAYOUT_SECRET('x')).toBe('x looks like a secret (a .env file, a private key or a credential). Leave secrets out of the archive and upload again.');
    expect(checkPackFiles(source, names, { layout: 'older' }).map((one) => one.sentence)).toEqual([
      'phases/03-implementation/files/.env.example looks like a secret (a .env file, a private key or a credential). Only canonical/.env.example may ship; leave secrets out of the archive and upload again.',
    ]);
    // the door: a new-layout archive is refused for it (the secret scan runs before the canonical/ rule)
    const files = { ...three(), 'canonical/.env.example': 'PORT=1\n' };
    expect((await refusalOf(service.upload(TEACHER, body(fresh('Env'), zipOf(files))))).code).toBe('SECRET_FILE');
    // an older archive keeps its exception: Shelf with canonical/.env.example uploads
    const older = olderArchive('shelf', (entries) => [...entries, { name: 'canonical/.env.example', data: Buffer.from('PORT=1\n') }]);
    await expect(service.upload(TEACHER, body(fresh('Older env'), older))).resolves.toMatchObject({ version: expect.any(String) });
  });

  it('refuses a secret under a desktop file\'s folder: files/.aws/.DS_Store', async () => {
    const files = { ...three(), 'phases/03-implementation/files/.aws/.DS_Store': 'finder' };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Aws'), zipOf(files))))).toEqual({ status: 400, code: 'SECRET_FILE' });
  });

  it('refuses canonical/ in a new-layout archive', async () => {
    const files = { ...three(), 'canonical/app/main.py': 'print(1)\n' };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Canonical'), zipOf(files))))).toEqual({ status: 400, code: 'NOT_A_PACK', detail: CANONICAL_IN_UPLOAD });
    expect(CANONICAL_IN_UPLOAD).toBe("canonical/ is not read in an upload. Put each file a phase mounts under that phase's files/ or readonly/ folder, and upload again.");
  });

  it('refuses a warmup/ folder at the door as a warm-up', async () => {
    const files = { ...three(), 'warmup/warmup.json': '{}' };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Warmup'), zipOf(files))))).toEqual({ status: 400, code: 'WARMUP_NOT_UPLOADABLE' });
  });

  it('converts an older archive once and says so', async () => {
    const made = await service.upload(TEACHER, body(fresh('Older shelf'), olderArchive('shelf')));
    const warnings = made.warnings ?? [];
    expect(warnings[0]).toBe(OLDER_LAYOUT_WARNING);
    expect(warnings.filter((one) => one === OLDER_LAYOUT_WARNING)).toHaveLength(1);
    expect((await phasesOf(made.versionId)).map((one) => one.key)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
  });

  it('names an older archive\'s own phase folder in a refusal the loader makes after the conversion', async () => {
    const older = olderArchive('shelf-task', (entries) =>
      entries.map((one) => {
        const name = one.name.replace(/^phases\/01-requirements\//, 'phases/req/');
        if (name === 'project.json') {
          const meta = JSON.parse(one.data.toString('utf8'));
          meta.phases = ['phases/req'];
          return { name, data: Buffer.from(JSON.stringify(meta)) };
        }
        if (name === 'phases/req/phase.json') {
          const spec = JSON.parse(one.data.toString('utf8'));
          spec.rubric.criteria[0].weight = 'heavy';
          return { name, data: Buffer.from(JSON.stringify(spec)) };
        }
        return { ...one, name };
      }),
    );
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Renamed'), older)));
    expect(said.code).toBe('NOT_A_PACK');
    expect(said.detail).toMatch(/^phases\/req: /);
    expect(said.detail).not.toContain('01-requirements');
  });

  it('names an older archive\'s own phase folder in a task block refusal the importer makes, and writes nothing', async () => {
    const older = olderArchive('shelf-task', (entries) =>
      entries.map((one) => {
        const name = one.name.replace(/^phases\/01-requirements\//, 'phases/req/');
        if (name === 'project.json') {
          const meta = JSON.parse(one.data.toString('utf8'));
          meta.phases = ['phases/req'];
          return { name, data: Buffer.from(JSON.stringify(meta)) };
        }
        if (name === 'phases/req/phase.json') {
          const spec = JSON.parse(one.data.toString('utf8'));
          spec.task = { key: 'build' };
          return { name, data: Buffer.from(JSON.stringify(spec)) };
        }
        return { ...one, name };
      }),
    );
    const projects = dataSource.getRepository(ProjectEntity);
    const before = await projects.countBy({ ownerUserId: OWNER_ID });
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Renamed block'), older)));
    expect(said.code).toBe('NOT_A_PACK');
    expect(said.detail).toMatch(/^phases\/req's phase\.json task block: its key names no task of this phase; the phase's task is "[^"]+"\.$/);
    expect(said.detail).not.toContain('01-requirements');
    // the draft's transaction rolled back: no project, version or row of it was written
    expect(await projects.countBy({ ownerUserId: OWNER_ID })).toBe(before);
  });

  it('holds an older archive\'s files to the strict text rule by the archive\'s own paths', async () => {
    const IMPL = 'phases/03-implementation/phase.json';
    const older = olderArchive('shelf', (entries) => {
      const out = entries.map((one) => {
        if (one.name !== IMPL) return one;
        const spec = JSON.parse(one.data.toString('utf8'));
        spec.files.push({ path: 'web/public/logo.png', source: '../../canonical/web/public/logo.png', editable: false });
        return { ...one, data: Buffer.from(JSON.stringify(spec)) };
      });
      return [...out, { name: 'canonical/web/public/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]) }];
    });
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Png'), older)));
    expect(said.code).toBe('NOT_A_PACK');
    expect(said.detail).toContain('canonical/web/public/logo.png');
  });

  it('refuses a JSON escape that decodes to a null character in a folder phase.json, naming the file', async () => {
    const files = code('03-implementation', (spec) => {
      spec.intro = 'Fill in the gap.\u0000';
    });
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Escape'), zipOf({ ...projectJson(), ...files }))));
    expect(said.code).toBe('NOT_A_PACK');
    expect(said.detail).toContain('phases/03-implementation/phase.json');
  });

  it('names a folder phase.json that is not JSON, never quoting it', async () => {
    const files = { ...three(), 'phases/02-design/phase.json': '{ "title": "Design", oops' };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Bad json'), zipOf(files))))).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: 'phases/02-design/phase.json is not valid JSON. Open it in an editor that checks JSON, fix it and upload again.',
    });
  });

  it('stores an uploaded markdown brief as plain text and warns once for the phase', async () => {
    const brief = 'Make **add** return the sum of its two arguments.';
    const files = {
      ...projectJson(),
      ...storyFolder(),
      ...designFolder('02-design', (spec) => {
        spec.taskPanel = '# The design\n\nRecord one entity.';
        spec.objectives = ['Record **one** entity'];
      }),
      ...code('03-implementation', (spec) => {
        spec.taskPanel = brief;
      }),
    };
    const made = await service.upload(TEACHER, body(fresh('Markdown'), zipOf(files)));
    expect(made.warnings).toEqual([
      "Design's brief and objectives had markdown in them. They were kept as plain text, every word in place; read them in the editor.",
      "Implementation's brief had markdown in it. It was kept as plain text, every word in place; read it in the editor.",
    ]);
    expect(markdownKeptWarning('Implementation', ['brief'])).toBe(made.warnings![1]);
    const [work] = await tasksOf(made.versionId, 'implementation');
    expect(work.brief).toBe(plainTextOf(brief));
    expect(work.brief).toBe('Make add return the sum of its two arguments.');
    const [design] = await tasksOf(made.versionId, 'design');
    expect(design.objectives).toEqual(['Record one entity']);
  });

  it('stores the story, Design story and ticket lines of an upload plain, through the draft conversion\'s walker, and names them in the phase\'s warning', async () => {
    const edited = (entries: ZipEntrySpec[], name: string, edit: (spec: Record<string, any>) => void): ZipEntrySpec[] =>
      entries.map((one) => {
        if (one.name !== name) return one;
        const spec = JSON.parse(Buffer.from(one.data as Buffer).toString('utf-8'));
        edit(spec);
        return { ...one, data: Buffer.from(JSON.stringify(spec, null, 2), 'utf-8') };
      });
    const older = olderArchive('shelf', (entries) => {
      let out = edited(entries, 'phases/01-requirements/phase.json', (spec) => {
        spec.checks.providedStories[0].title = 'Browse the **shelf**';
        spec.checks.providedStories[0].criteria[0].then = 'they are listed by _title_';
        spec.checks.learnerStory.hints = { persona: 'A **member** of the club', benefit: 'so that they *find* a book' };
      });
      out = edited(out, 'phases/02-design/phase.json', (spec) => {
        spec.checks.stories[0].line = 'As a member, I want to see every book in **shelf order**, so that I can find one without asking.';
      });
      return edited(out, 'phases/06-maintenance/phase.json', (spec) => {
        spec.checks.ticket.summary = 'Fix **the** bug';
        spec.checks.ticket.acceptance[0].line = `${spec.checks.ticket.acceptance[0].line} \`api/shelf.py\` *first*`;
      });
    });
    const made = await service.upload(TEACHER, body(fresh('Older shelf with markdown lines'), older));
    // the phase's one markdown warning, whatever else in the phase it names ("Requirements' brief and story lines ...")
    const owner = (title: string) => markdownKeptWarning(title, ['brief']).split(' brief ')[0];
    const warningOf = (title: string) => (made.warnings ?? []).find((one) => one.startsWith(`${owner(title)} `) && one.includes('had markdown'));
    expect(warningOf('Requirements')).toContain('story lines');
    expect(warningOf('Design')).toContain('story lines');
    expect(warningOf('Maintenance')).toContain('ticket lines');

    const checksOf = async (key: PhaseKey) => (await tasksOf(made.versionId, key)).find((one) => one.checks?.kind !== 'quiz')!.checks as Record<string, any>;
    const story = (await checksOf('requirements')).providedStories[0];
    expect(story.title).toBe('Browse the shelf');
    expect(story.criteria[0].then).toBe('they are listed by title');
    // the learner story's hints are story lines too (the shared walker converts them)
    expect((await checksOf('requirements')).learnerStory.hints).toEqual({ persona: 'A member of the club', benefit: 'so that they find a book' });
    expect((await checksOf('design')).stories[0].line).toBe('As a member, I want to see every book in shelf order, so that I can find one without asking.');
    const ticket = (await checksOf('maintenance')).ticket;
    expect(ticket.summary).toBe('Fix the bug');
    // a code span keeps its backticks; the stars around a word go
    expect(ticket.acceptance[0].line.endsWith(' `api/shelf.py` first')).toBe(true);
  });

  it("refuses an older archive's task block whose brief is not text, or is over 20000 characters, in the block's own words, before it converts the archive", async () => {
    const withBlock = (task: unknown) => olderArchive('shelf', (entries) => entries.map((one) => {
      if (one.name !== 'phases/03-implementation/phase.json') return one;
      const spec = JSON.parse(Buffer.from(one.data as Buffer).toString('utf-8'));
      return { ...one, data: Buffer.from(JSON.stringify({ ...spec, task }, null, 2), 'utf-8') };
    }));
    const notText = await refusalOf(service.upload(TEACHER, body(fresh('Older block brief type'), withBlock({ brief: 7 }))));
    expect(notText).toEqual({ status: 400, code: 'NOT_A_PACK', detail: "phases/03-implementation's phase.json task block: its brief must be text." });
    const over = await refusalOf(service.upload(TEACHER, body(fresh('Older block brief cap'), withBlock({ brief: 'x'.repeat(20001) }))));
    expect(over.status).toBe(400);
    expect(over.detail).toMatch(/^phases\/03-implementation's phase\.json task block: .*at most 20000 characters/);
  });

  it('warns once for an HTML comment in a brief, and keeps the comment', async () => {
    const brief = 'Make add return the sum.\n<!-- the teacher\'s own note -->\n';
    const files = {
      ...projectJson(),
      ...storyFolder(),
      ...designFolder('02-design', (spec) => {
        spec.taskPanel = 'Record one entity. <!-- hidden -->';
        spec.objectives = ['Record it <!-- also hidden -->'];
      }),
      ...code('03-implementation', (spec) => {
        spec.taskPanel = brief;
      }),
    };
    const made = await service.upload(TEACHER, body(fresh('Comment'), zipOf(files)));
    expect(made.warnings).toEqual([
      "Design's brief and objectives hold HTML comments. Learners do not see them; read them in the editor.",
      "Implementation's brief holds an HTML comment. Learners do not see it; read it in the editor.",
    ]);
    expect(htmlCommentWarning('Implementation', ['brief'])).toBe(made.warnings![1]);
    const [work] = await tasksOf(made.versionId, 'implementation');
    expect(work.brief).toContain('<!-- the teacher\'s own note -->');
  });

  it('refuses a text whose conversion leaves nothing, in the editor\'s own sentence', async () => {
    const files = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.intro = '---';
    }) };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Blank'), zipOf(files))))).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: 'phases/03-implementation/phase.json: The intro of Implementation cannot be empty.',
    });
  });

  it('refuses every member whose conversion leaves nothing in the editor\'s own sentence, and leaves a blank stem or explanation to the quiz check', async () => {
    const PHASE = 'phases/03-implementation/phase.json';
    const QUIZ = 'phases/01-requirements/quizzes/concepts.json';
    const withPhase = (edit: (spec: Record<string, any>) => void): PackFiles => ({ ...projectJson(), ...code('03-implementation', edit) });
    const withQuiz = (edit: (question: Record<string, any>) => void): PackFiles => {
      const questions = fixtureQuizQuestions(5) as unknown as Record<string, any>[];
      edit(questions[0]);
      return { ...three(), [QUIZ]: quizFile({}, { questions }) };
    };
    // the editor's sentences: `requirePlainText`'s for the phase's texts, `checkedTaskBlock`'s shape for the block,
    // the editor's draft doors' for a quiz option and a concept, and the quiz check's own for a stem and an explanation
    const cases: [string, PackFiles, string][] = [
      ['brief', withPhase((spec) => { spec.taskPanel = '---'; }), `${PHASE}: A brief cannot be empty.`],
      ['objective', withPhase((spec) => { spec.objectives = ['Fill the gap', '#']; }), `${PHASE}: An objective cannot be empty.`],
      ['criterion title', withPhase((spec) => { spec.rubric.criteria[0].title = '***'; }), `${PHASE}: A criterion title cannot be empty.`],
      ['criterion description', withPhase((spec) => { spec.rubric.criteria[0].description = '---'; }), `${PHASE}: A criterion description cannot be empty.`],
      ['block title', withPhase((spec) => { spec.task = { key: 'main', title: '---' }; }), "phases/03-implementation's phase.json task block: A title cannot be empty."],
      ['quiz option', withQuiz((question) => { question.options[1].text = '---'; }), `${QUIZ} is not a quiz: A quiz option cannot be empty.`],
      ['concept', withQuiz((question) => { question.concept = '#'; }), `${QUIZ} is not a quiz: A concept label cannot be empty.`],
      ['stem', withQuiz((question) => { question.stem = '---'; }), `${QUIZ} is not a quiz: Question 1's stem must be text of 1 to 4000 characters.`],
      ['stem that converts to a line break', withQuiz((question) => { question.stem = '---\n---'; }), `${QUIZ} is not a quiz: Question 1's stem must be text of 1 to 4000 characters.`],
      ['explanation', withQuiz((question) => { question.explanation = '***'; }), `${QUIZ} is not a quiz: Question 1's explanation must be text of 1 to 4000 characters.`],
      ['explanation that converts to a line break', withQuiz((question) => { question.explanation = '---\n---'; }), `${QUIZ} is not a quiz: Question 1's explanation must be text of 1 to 4000 characters.`],
    ];
    for (const [label, files, detail] of cases) {
      const said = await refusalOf(service.upload(TEACHER, body(fresh(`Blank ${label}`), zipOf(files))));
      expect({ label, ...said }).toEqual({ label, status: 400, code: 'NOT_A_PACK', detail });
    }
  });

  it('prints an archive-chosen path, name or value in a layout refusal only clipped and plain', async () => {
    const MARKER = `MARKER ${'x'.repeat(200)}`;
    const refusals = [
      // a phase.json value: a path checks names that the folder does not hold
      { ...projectJson(), ...code('03-implementation', (spec) => { spec.checks.editableTargets = [...spec.checks.editableTargets, MARKER]; }) },
      { ...projectJson(), ...code('03-implementation', (spec) => { spec.checks.runs[0].visibleTests = [...spec.checks.runs[0].visibleTests, MARKER]; }) },
      // a phase.json value: a run id with no hidden_tests/ folder
      { ...projectJson(), ...code('03-implementation', (spec) => { spec.checks.runs.push({ ...spec.checks.runs[0], id: MARKER }); }) },
      // an entry name: a folder that is not one of a phase's folders
      { ...projectJson(), ...code('03-implementation'), [`phases/03-implementation/${MARKER}/a.txt`]: 'a' },
      // an entry name: a folder under hidden_tests/ named for no run
      { ...projectJson(), ...code('03-implementation'), [`phases/03-implementation/hidden_tests/${MARKER}/tests/test_x.py`]: 'x = 1\n' },
      // an entry name: a quiz file named for no task key
      { ...projectJson(), ...code('03-implementation'), [`phases/03-implementation/quizzes/${MARKER}.json`]: quizFile() },
      // an entry name: a phase folder named for no phase
      { ...projectJson(), ...code('03-implementation'), [`phases/07-${MARKER}/phase.json`]: '{}' },
      // a phase.json value: a smoke command's script that smoke/ does not hold
      { ...projectJson(), ...configFolder('01-deployment', (spec) => { spec.checks.smoke.commands = [['python3', MARKER]]; }) },
    ];
    for (const files of refusals) {
      const said = await refusalOf(service.upload(TEACHER, body(fresh('Clipped'), zipOf(files))));
      expect(said.status).toBe(400);
      expect(said.detail ?? '').not.toContain('MARKER');
      expect((said.detail ?? '').length).toBeLessThan(400);
    }
    // a plain value is still named
    const plain = await refusalOf(service.upload(TEACHER, body(fresh('Named'), zipOf({ ...projectJson(), ...code('03-implementation', (spec) => { spec.checks.editableTargets = [...spec.checks.editableTargets, 'app/missing.py']; }) }))));
    expect(plain.detail).toContain('app/missing.py');
    // the smoke script's sentence names a plain script, and a long one only as a file in the archive
    const smokeOf = async (script: string) =>
      (await refusalOf(service.upload(TEACHER, body(fresh('Smoke'), zipOf({ ...projectJson(), ...configFolder('01-deployment', (spec) => { spec.checks.smoke.commands = [['python3', script]]; }) }))))).detail;
    expect(await smokeOf('app/missing.py')).toBe(LAYOUT_SENTENCES.smokeScriptMissing('phases/01-deployment', 'app/missing.py'));
    expect(await smokeOf(`app/${'s'.repeat(200)}.py`)).toBe(LAYOUT_SENTENCES.smokeScriptMissing('phases/01-deployment', 'a file in the archive'));
    // a name of plain characters past 48 code units is clipped to its first 48, never past them
    const LONG = `M${'x'.repeat(60)}TAIL`;
    const clippedNames = [
      // an entry name: a folder that is not one of a phase's folders
      { ...projectJson(), ...code('03-implementation'), [`phases/03-implementation/${LONG}/a.txt`]: 'a' },
      // an entry name: a folder under hidden_tests/ named for no run
      { ...projectJson(), ...code('03-implementation'), [`phases/03-implementation/hidden_tests/${LONG}/tests/test_x.py`]: 'x = 1\n' },
      // a phase.json value: a run id with no hidden_tests/ folder
      { ...projectJson(), ...code('03-implementation', (spec) => { spec.checks.runs.push({ ...spec.checks.runs[0], id: LONG }); }) },
    ];
    for (const files of clippedNames) {
      const said = await refusalOf(service.upload(TEACHER, body(fresh('Clipped name'), zipOf(files))));
      expect(said.status).toBe(400);
      expect(said.detail).toContain(`M${'x'.repeat(47)}`);
      expect(said.detail).not.toContain('x'.repeat(48));
      expect(said.detail).not.toContain('TAIL');
    }
  });

  it('holds a folder Requirements interview.json to the interview door\'s caps, naming the file', async () => {
    const interview = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../content/tasktrackr/phases/01-requirements/interview.json'), 'utf8'));
    interview.persona.name = 'N'.repeat(500);
    const files = { ...three(), 'phases/01-requirements/interview.json': JSON.stringify(interview) };
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Interview'), zipOf(files))));
    expect(said.code).toBe('NOT_A_PACK');
    expect(said.detail).toMatch(/^phases\/01-requirements\/interview\.json: The interview persona's name is at most \d+ characters, and this one is 500\.$/);
  });

  it('holds each text to its editor cap before it is converted, asked of what was sent', async () => {
    const over = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.taskPanel = `**${'b'.repeat(19999)}**`;
    }) };
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Long brief'), zipOf(over))))).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: 'phases/03-implementation/phase.json: A brief is at most 20000 characters, and this one is 20003.',
    });
  });

  it('measures a cap on the trimmed text, as the editor does: a brief of exactly the cap and a closing line break is accepted', async () => {
    const files = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.taskPanel = `${'b'.repeat(20000)}\n`;
    }) };
    const made = await service.upload(TEACHER, body(fresh('Brief at the cap'), zipOf(files)));
    const [work] = await tasksOf(made.versionId, 'implementation');
    expect(work.brief).toBe('b'.repeat(20000));
    // the door trims, measures and stores the trimmed text, as the editor does: no whitespace rides past the cap
    const brief = `Make **add** return ${'b'.repeat(19980)}`;
    const wrapped = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.taskPanel = `${' '.repeat(50000)}${brief}${' '.repeat(50000)}`;
    }) };
    // stored, not deflated, so the archive's ratio guard does not meet 100,000 spaces
    const storedZip = writeZip(Object.entries(wrapped).map(([name, text]) => ({ name, data: Buffer.from(text, 'utf-8'), method: 0 as const })));
    const padded = await service.upload(TEACHER, body(fresh('Brief in whitespace'), storedZip));
    const [stored] = await tasksOf(padded.versionId, 'implementation');
    expect(brief.length).toBe(20000);
    expect(stored.brief).toBe(plainTextOf(brief.trim()));
    expect(stored.brief.length).toBe(plainTextOf(brief.trim()).length);
  });

  it('trims again after converting, so a brief whose markup left a blank edge is stored without it', async () => {
    const files = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.taskPanel = 'Intro\n\n---';
      spec.objectives = ['---\nName one edge'];
    }) };
    const made = await service.upload(TEACHER, body(fresh('Brief with a closing rule'), zipOf(files)));
    const [work] = await tasksOf(made.versionId, 'implementation');
    // plainTextOf('Intro\n\n---') is 'Intro\n\n': the door stores 'Intro', what a second upload of it would store
    expect(work.brief).toBe('Intro');
    expect(work.objectives).toEqual(['Name one edge']);
    expect(made.warnings).toEqual([markdownKeptWarning('Implementation', ['brief', 'objectives'])]);
  });

  it('applies a folder phase.json task block to its phase\'s task, keyed by the phase folder', async () => {
    const files = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.task = { key: 'main', title: 'Add **two** numbers', objectives: ['Fill the gap'], signOff: true };
    }) };
    const made = await service.upload(TEACHER, body(fresh('Block'), zipOf(files)));
    const [work] = await tasksOf(made.versionId, 'implementation');
    expect([work.taskKey, work.title, work.objectives, work.signOff]).toEqual(['main', 'Add two numbers', ['Fill the gap'], true]);
    expect(made.warnings).toEqual([
      "Implementation's task title had markdown in it. It was kept as plain text, every word in place; read it in the editor.",
    ]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const compiled = version.compiled!.phases.find((one) => one.key === 'implementation')!.tasks;
    expect(compiled.map((one) => one.title)).toEqual(['Add two numbers']);
  });

  it('refuses a folder task block whose key names no task of the phase, at the phase folder', async () => {
    const files = { ...projectJson(), ...code('03-implementation', (spec) => {
      spec.task = { key: 'build', title: 'Build it' };
    }) };
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Block key'), zipOf(files))));
    expect(said).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: 'phases/03-implementation\'s phase.json task block: its key names no task of this phase; the phase\'s task is "main".',
    });
  });

  it('imports a quiz file through the quiz door\'s rules, at the place its order names', async () => {
    const files = { ...three(), 'phases/01-requirements/quizzes/concepts.json': quizFile({ order: 1 }) };
    const made = await service.upload(TEACHER, body(fresh('Quiz'), zipOf(files)));
    const tasks = await tasksOf(made.versionId, 'requirements');
    expect(tasks.map((one) => [one.taskKey, one.order, one.artefactType])).toEqual([['concepts', 1, 'quiz'], ['main', 2, 'user-story']]);
    const [quiz] = tasks;
    expect(quiz.checks.kind).toBe('quiz');
    expect((quiz.checks as { questions: unknown[] }).questions).toHaveLength(5);
    expect([quiz.title, quiz.brief, quiz.objectives, quiz.required]).toEqual(['Concepts', 'Answer the five questions.', ['Know the terms'], false]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const compiled = version.compiled!.phases.find((one) => one.key === 'requirements')!.tasks;
    expect(compiled.map((one) => one.taskKey)).toEqual(['concepts', expect.any(String)]);
  });

  it('sequences a quiz whose order ties the work task\'s by task key, then renumbers 1 to n', async () => {
    const files = {
      ...three(),
      // zeta before alpha in the archive, each with question ids of its own
      'phases/03-implementation/quizzes/zeta.json': quizFile({ order: 1 }, { criterion: 'zeta', questions: fixtureQuizQuestions(5, 'z') }),
      'phases/03-implementation/quizzes/alpha.json': quizFile({ order: 1 }, { criterion: 'alpha' }),
    };
    const made = await service.upload(TEACHER, body(fresh('Ties'), zipOf(files)));
    const tasks = await tasksOf(made.versionId, 'implementation');
    expect(tasks.map((one) => [one.taskKey, one.order])).toEqual([['alpha', 1], ['main', 2], ['zeta', 3]]);
    // two quizzes of one phase holding one question id make a draft the compiler refuses: nothing is imported
    const shared = { ...files, 'phases/03-implementation/quizzes/zeta.json': quizFile({ order: 1 }, { criterion: 'zeta' }) };
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Shared ids'), zipOf(shared))));
    expect(said.code).toBe('NOT_A_PACK');
    expect(said.detail).toMatch(/^the quiz files of implementation make a draft that does not compile, so nothing was imported: implementation: tasks "alpha" and "zeta" both own the question "q1"/);
  });

  it('stores a quiz file\'s markdown texts plain and warns for the phase\'s quiz text', async () => {
    const questions = fixtureQuizQuestions(5).map((one, i) => (i === 0 ? { ...one, stem: 'Which is **right**?' } : one));
    const files = { ...three(), 'phases/02-design/quizzes/concepts.json': quizFile({}, { questions }) };
    const made = await service.upload(TEACHER, body(fresh('Quiz text'), zipOf(files)));
    expect(made.warnings).toEqual([
      "Design's quiz text had markdown in it. It was kept as plain text, every word in place; read it in the editor.",
    ]);
    const quiz = (await tasksOf(made.versionId, 'design')).find((one) => one.taskKey === 'concepts')!;
    expect((quiz.checks as { questions: { stem: string }[] }).questions[0].stem).toBe('Which is right?');
  });

  it('refuses a quiz file in the \'is not a quiz: \' shape, under 400 characters, with the title its key', async () => {
    const files = {
      ...three(),
      'phases/01-requirements/quizzes/concepts.json': quizFile({ title: 'T'.repeat(160) }, { passMark: 500 }),
    };
    const said = await refusalOf(service.upload(TEACHER, body(fresh('Pass mark'), zipOf(files))));
    expect(said).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: 'phases/01-requirements/quizzes/concepts.json is not a quiz: A pass mark is a whole percentage from 0 to 100, and this one is 500. A mark above 100 is a gate no paper can clear.',
    });
    expect(said.detail!.length).toBeLessThanOrEqual(400);
    // the editor's own refusal for the same body is the same sentence, byte for byte
    let editor = '';
    try {
      checkedQuiz({ questions: fixtureQuizQuestions(5), passMark: 500 } as never, true, 'T'.repeat(160));
    } catch (error) {
      editor = (error as Error).message;
    }
    expect(editor).toBe('A pass mark is a whole percentage from 0 to 100, and this one is 500. A mark above 100 is a gate no paper can clear.');
    // the title a refusal names is the quiz's task key
    const reveal = { ...three(), 'phases/01-requirements/quizzes/concepts.json': quizFile({ required: true, title: 'T'.repeat(160) }, { revealExplanation: 'always' }) };
    const named = await refusalOf(service.upload(TEACHER, body(fresh('Reveal'), zipOf(reveal))));
    expect(named.detail).toMatch(/^phases\/01-requirements\/quizzes\/concepts\.json is not a quiz: /);
    expect(named.detail).toContain('concepts');
    expect(named.detail).not.toContain('TTTT');
    // a value the quiz chose is echoed clipped
    const criterion = { ...three(), 'phases/01-requirements/quizzes/concepts.json': quizFile({}, { criterion: `Bad${'x'.repeat(300)}` }) };
    const clipped = await refusalOf(service.upload(TEACHER, body(fresh('Criterion'), zipOf(criterion))));
    expect(clipped.detail!.length).toBeLessThanOrEqual(400);
    expect(clipped.detail).not.toContain('x'.repeat(60));
  });

  it('refuses a quiz file the quiz door would refuse: no questions, a blank title, an unknown member', async () => {
    const at = 'phases/01-requirements/quizzes/concepts.json';
    const cases: [string, string, string][] = [
      ['no questions', quizFile({}, { questions: [] }), `${at} is not a quiz: A quiz task is scored by the questions you write, and this one carries none.`],
      ['no checks', JSON.stringify({ title: 'Concepts', brief: 'Answer.', order: 2 }), `${at} is not a quiz: A quiz task is scored by the questions you write, and this one carries none.`],
      ['blank title', quizFile({ title: '   ' }), `${at} is not a quiz: A title cannot be empty.`],
      ['long brief', quizFile({ brief: 'b'.repeat(20001) }), `${at} is not a quiz: A brief is at most 20000 characters, and this one is 20001.`],
    ];
    for (const [label, text, start] of cases) {
      const said = await refusalOf(service.upload(TEACHER, body(fresh(label), zipOf({ ...three(), [at]: text }))));
      expect({ label, code: said.code, starts: said.detail?.startsWith(start.replace(/\.$/, '')) }).toEqual({ label, code: 'NOT_A_PACK', starts: true });
    }
    const unknown = await refusalOf(service.upload(TEACHER, body(fresh('Unknown member'), zipOf({ ...three(), [at]: quizFile({ rules: [] }) }))));
    expect(unknown.detail).toMatch(/^phases\/01-requirements\/quizzes\/concepts\.json is not a quiz: /);
    const notJson = await refusalOf(service.upload(TEACHER, body(fresh('Quiz json'), zipOf({ ...three(), [at]: '{ nope' }))));
    expect(notJson.detail).toBe(`${at} is not valid JSON. Open it in an editor that checks JSON, fix it and upload again.`);
  });

  it('refuses quizzes/main.json and quizzes/Bad.json by name', async () => {
    const main = await refusalOf(service.upload(TEACHER, body(fresh('Main quiz'), zipOf({ ...three(), 'phases/01-requirements/quizzes/main.json': quizFile() }))));
    expect(main.detail).toBe(LAYOUT_SENTENCES.quizIsWorkTask('phases/01-requirements/quizzes/main.json', 'main'));
    const bad = await refusalOf(service.upload(TEACHER, body(fresh('Bad quiz'), zipOf({ ...three(), 'phases/01-requirements/quizzes/Bad.json': quizFile() }))));
    expect(bad.detail).toBe(LAYOUT_SENTENCES.quizKeyInvalid('phases/01-requirements/quizzes/Bad.json', 'Bad'));
  });

  it('refuses a hidden test at a dot-prefixed path by name', async () => {
    const files: PackFiles = { ...three() };
    const hidden = files['phases/03-implementation/hidden_tests/main/tests/test_hidden.py'];
    delete files['phases/03-implementation/hidden_tests/main/tests/test_hidden.py'];
    files['phases/03-implementation/hidden_tests/main/tests/.cache/test_hidden.py'] = hidden;
    expect(await refusalOf(service.upload(TEACHER, body(fresh('Dot hidden'), zipOf(files))))).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: SEALED_DOT_PATH('phases/03-implementation/hidden_tests/main/tests/.cache/test_hidden.py'),
    });
    expect(SEALED_DOT_PATH('x')).toBe("x: a sealed file's path has no part that starts with a dot, so the editor could not replace it. Rename it and upload again.");
  });

  it('builds the raw manifest from the folders: the phases, each run\'s hidden files and the shipped files', () => {
    const files = { ...projectJson(), ...storyFolder(), ...designFolder(), ...codeFolder(), ...testsFolder(), ...configFolder() };
    const manifest = buildPackManifest(new MemoryPackSource(Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.from(text) })), 'upload', ''));
    const loaded = new ContentService().loadProject(
      new MemoryPackSource(Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.from(text) })), 'upload', ''),
      { origin: 'upload' },
    );
    const raw = rawPackManifestOf(loaded);
    expect(manifest.phases.map((one) => one.key)).toEqual(raw.phases.map((one) => one.key));
    // each run's hidden files, by the file's path inside the run's suite (the flat run is keyed '' in the raw manifest, `main` once loaded)
    const suites = (phase: { hiddenTestFiles: Record<string, string[]> }, strip: RegExp) =>
      Object.fromEntries(Object.entries(phase.hiddenTestFiles).map(([id, list]) => [id || 'main', list.map((at) => at.replace(strip, '')).sort()]));
    for (const [i, phase] of manifest.phases.entries()) {
      expect({ key: phase.key, suites: suites(phase, /^hidden_tests\/[^/]+\//) }).toEqual({ key: raw.phases[i].key, suites: suites(raw.phases[i], /^hidden\//) });
    }
    expect([...manifest.shippedFiles].sort()).toEqual([...raw.shippedFiles].sort());
    const smoke = manifest.phases.find((one) => one.key === 'deployment')!;
    expect(smoke.smokeFiles).toEqual(Object.keys((raw.phases.find((one) => one.key === 'deployment')!.checks as { smoke: { implFiles: Record<string, string> } }).smoke.implFiles));
  });
});
