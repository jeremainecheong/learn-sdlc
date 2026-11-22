import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import {
  API_CONTRACT_JSON,
  DESIGN_JSON,
  EMPTY_DESIGN,
  STORY_JSON,
  serialiseDesign,
  serialiseStory,
  type AddTaskBody,
  type PhaseKey,
  type Story,
} from '@learnsdlc/shared';
import type { AuthoringService } from '../src/authoring/authoring.service';
import { executableContentDigest } from '../src/authoring/deep-validation';
import type { ContentService } from '../src/content/content.service';
import { ProjectImporterService } from '../src/content/importer.service';
import { layoutFromManifest } from '../src/content/legacy-layout';
import { MemoryPackSource } from '../src/content/memory-pack-source';
import { ProjectVersionEntity } from '../src/content/project.entities';
import type { ProjectRegistryService } from '../src/content/project-registry.service';
import { entriesOf } from './fixtures/upload-packs/archive';
import { fixtureQuizQuestions } from './quiz-fixture';
import { S1_TEACHER, type Fork } from './tasktrackr-phase';
import { OLDER_SHELF_DIR } from './fixtures/paths';

/**
 * The host for specs that need "a phase a teacher adds tasks to". The host has
 * no written phase; LearnSDLC has no markdown task kind. It is Shelf's
 * Requirements phase (`upload-packs/shelf`, kind story, its one story task),
 * mounting two read-only reference files the fencing and scenario suites read,
 * imported as a platform pack at order 1 under a slug of the caller's. A copy takes two
 * concept quizzes (`addHostQuizzes`), so the phase holds several tasks and
 * still publishes, a quiz can be removed, the story task takes the sign-off
 * mark, and a reset is task-scoped. Built in memory; nothing on disk changes.
 *
 * A pack's `phase.json` task block carries words only, so the pack cannot
 * declare a quiz: the quizzes are added to a copy through the authoring door,
 * as a teacher adds them.
 *
 * What it does not give: a reference arm (nothing here is TaskTrackr's); a
 * phase after it (the three-phase variant below has two).
 */
export const HOST_PHASE = 'requirements' as const;
export const HOST_SLUG = 'shelf-host';
/** Read-only, named like a provided reference, so a reviewer reads it when a brief names it. */
export const HOST_RUNBOOK = 'release/provided-runbook.md';
/** Read-only. */
export const HOST_ARCHITECTURE = 'release/architecture.md';
/** The story task's record: what a learner saves in the story room. */
export const HOST_RECORD = STORY_JSON;
/** SH-5, the story Shelf's Requirements asks for; it passes Shelf's story floor. */
export const HOST_STORY: Story = {
  id: 'SH-5',
  title: 'Free to borrow',
  persona: 'member',
  capability: "to see which of an author's books are free to borrow right now",
  benefit: 'I only walk to the shelf for a book I can take home',
  criteria: [
    { id: 'AC-1', given: 'an author with three books', when: 'I open the author', then: 'I see which of the three are free to borrow', tag: 'happy' },
    {
      id: 'AC-2',
      given: 'a book that is already on loan',
      when: 'I open its author',
      then: 'it is shown as on loan with the date it is due back',
      tag: 'boundary',
    },
  ],
  scopeExclusions: ['reserving a book that is on loan'],
  notes: '',
};
/** Work that passes the story task: what a learner saves for it. */
export const HOST_WORK: Readonly<Record<string, string>> = { [STORY_JSON]: serialiseStory(HOST_STORY) };
export const HOST_QUIZ_KEYS = ['concepts-one', 'concepts-two'] as const;

/**
 * A concept quiz over the fixture questions, keyed and titled by `taskKey`
 * ("Concept check: <taskKey>"): required, three attempts, five drawn from a
 * pool of six. Publish refuses a required quiz that
 * draws its whole pool each time (`quiz-retake-is-a-new-paper`), and five makes
 * the default pass mark (60%) a score a paper lands on (three of five).
 */
export function hostQuizBody(taskKey: string): AddTaskBody {
  const first = taskKey === HOST_QUIZ_KEYS[0];
  return {
    taskKey,
    title: `Concept check: ${taskKey}`,
    brief: 'Answer the fixture questions.',
    artefactType: 'quiz',
    required: true,
    quiz: { questions: fixtureQuizQuestions(6, first ? 'a' : 'b'), drawn: 5, attempts: { max: 3, cooldownSeconds: null } },
  };
}

// The hosts are built from Shelf in the older layout (`OLDER_SHELF_DIR`), so
// each host stays one whole pointer-layout pack, as a teacher's older archive
// is; a caller that loads one converts it through `layoutFromManifest`.

type Entry = { name: string; bytes: Buffer };

/**
 * The part of a pack's `phase.json` the host edits: its order, and the files
 * it mounts (each read from `source` under the phase folder). Every other
 * field rides through as Shelf wrote it.
 */
type PhaseJson = Record<string, unknown> & {
  order: number;
  files?: { path: string; source: string; editable: boolean; language: string }[];
};

const folderOf = (order: number, key: string) => `phases/${String(order).padStart(2, '0')}-${key}`;

/** Shelf's `project.json`, under this slug and naming these phase folders. */
function shelfProject(slug: string, folders: string[]): Entry {
  const entry = entriesOf(OLDER_SHELF_DIR).find((one) => one.name === 'project.json')!;
  const project = JSON.parse(entry.data.toString('utf8'));
  return { name: 'project.json', bytes: Buffer.from(JSON.stringify({ ...project, slug, phases: folders }, null, 2)) };
}

/** Shelf's phase folder `from` copied to `order`, its phase.json's order set and `edit` applied; `extra` files under it by path. */
function shelfPhase(from: string, order: number, edit: (spec: PhaseJson) => void = () => undefined, extra: Record<string, string> = {}): Entry[] {
  const key = from.replace(/^\d+-/, '');
  const folder = folderOf(order, key);
  const out = entriesOf(OLDER_SHELF_DIR).flatMap((entry) => {
    if (!entry.name.startsWith(`phases/${from}/`)) return [];
    const name = entry.name.replace(`phases/${from}`, folder);
    if (entry.name !== `phases/${from}/phase.json`) return [{ name, bytes: entry.data }];
    const spec = JSON.parse(entry.data.toString('utf8')) as PhaseJson;
    spec.order = order;
    edit(spec);
    return [{ name, bytes: Buffer.from(JSON.stringify(spec, null, 2)) }];
  });
  return [...out, ...Object.entries(extra).map(([at, text]) => ({ name: `${folder}/${at}`, bytes: Buffer.from(text) }))];
}

/** The Requirements phase with the two reference files mounted read-only. */
function hostPhase(order: number): Entry[] {
  return shelfPhase(
    '01-requirements',
    order,
    (spec) => {
      spec.files = [
        ...(spec.files ?? []),
        { path: HOST_RUNBOOK, source: 'files/provided-runbook.md', editable: false, language: 'markdown' },
        { path: HOST_ARCHITECTURE, source: 'files/architecture.md', editable: false, language: 'markdown' },
      ];
    },
    {
      'files/provided-runbook.md': '# Runbook\n\nRestart the shelf service, then check the loans page loads.\n',
      'files/architecture.md': '# Architecture\n\nOne API process and one database file.\n',
    },
  );
}

/** The one-phase pack, as a source the importer reads. */
export function hostPack({ slug = HOST_SLUG, order = 1 }: { slug?: string; order?: number } = {}): MemoryPackSource {
  return new MemoryPackSource([shelfProject(slug, [folderOf(order, HOST_PHASE)]), ...hostPhase(order)], slug);
}

/*
 * The three-phase variant: Shelf's Requirements, Design and Implementation in
 * their own order, for the serial journeys that enter and leave a middle
 * phase. Design (its one design task, and the two quizzes a copy adds) is the
 * middle phase; Implementation is only opened, never graded.
 */
export const LEAD_IN_PHASE = 'requirements' as const;
/** Work that passes the lead-in's story task. */
export const LEAD_IN_WORK: Readonly<Record<string, string>> = HOST_WORK;
export const MIDDLE_PHASE = 'design' as const;
/** Shelf's design record and API contract: work that passes the middle phase's design floor. */
export const MIDDLE_WORK: Readonly<Record<string, string>> = {
  [DESIGN_JSON]: serialiseDesign({
    ...EMPTY_DESIGN,
    entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: ['knows who has it on loan'], satisfies: ['SH-1'] }],
    operations: [
      { id: 'O1', name: 'listBooks', inputs: ['author'], returns: 'every book, in shelf order', errors: [], satisfies: ['SH-1'] },
      {
        id: 'O2',
        name: 'lendBook',
        inputs: ['id', 'borrower'],
        returns: 'the book with its borrower',
        errors: ['book_not_found', 'cannot_lend'],
        satisfies: ['SH-2'],
      },
      {
        id: 'O3',
        name: 'returnBook',
        inputs: ['id'],
        returns: 'the book, back on the shelf',
        errors: ['book_not_found', 'not_on_loan'],
        satisfies: ['SH-3'],
      },
    ],
    decisions: [
      {
        id: 'D1',
        title: 'Keep the shelf in memory',
        choice: 'an in-memory shelf',
        alternative: 'a database',
        rationale: 'The shelf is small.',
        tradeOff: 'The books are gone when the process stops.',
        status: 'accepted',
        satisfies: ['SH-1'],
      },
    ],
  }),
  [API_CONTRACT_JSON]: `${JSON.stringify(
    {
      operations: [
        { id: 'listBooks', method: 'GET', path: '/api/books', summary: 'Every book.', errors: [] },
        { id: 'addBook', method: 'POST', path: '/api/books', summary: 'Adds a book.', errors: [] },
        { id: 'lendBook', method: 'POST', path: '/api/books/{id}/lend', summary: 'Lends a book.', errors: ['book_not_found', 'cannot_lend'] },
        { id: 'returnBook', method: 'POST', path: '/api/books/{id}/return', summary: 'Returns a book.', errors: ['book_not_found', 'not_on_loan'] },
      ],
      errors: {
        book_not_found: { status: 404, meaning: 'No book has the id.' },
        cannot_lend: { status: 409, meaning: 'On loan already.' },
        not_on_loan: { status: 409, meaning: 'Not on loan.' },
      },
    },
    null,
    2,
  )}\n`,
};
export const CLOSING_PHASE = 'implementation' as const;
export const HOST_THREE_PHASE_SLUG = 'shelf-host-three';

/** The three-phase pack, as a source the importer reads. */
export function hostPackThreePhase({ slug = HOST_THREE_PHASE_SLUG }: { slug?: string } = {}): MemoryPackSource {
  return new MemoryPackSource(
    [
      shelfProject(slug, [folderOf(1, LEAD_IN_PHASE), folderOf(2, MIDDLE_PHASE), folderOf(3, CLOSING_PHASE)]),
      ...hostPhase(1),
      ...shelfPhase('02-design', 2),
      ...shelfPhase('03-implementation', 3),
      // Implementation mounts canonical files (`../../canonical/...` in its phase.json), so the pack carries them
      ...entriesOf(OLDER_SHELF_DIR)
        .filter((one) => one.name.startsWith('canonical/'))
        .map((one) => ({ name: one.name, bytes: one.data })),
    ],
    slug,
  );
}

/**
 * Stands in for the deep validation a teacher runs before publishing a copy of
 * the three-phase variant. Its closing phase is Shelf's Implementation, which
 * is executable and not the reference project's, so publish asks for a passed
 * deep receipt against its bytes (`deep-validation-current`), and a test run
 * has no code runner to earn one. This writes a passed receipt for the draft's
 * executable bytes as they stand, beside the fast report (a fast validation
 * keeps it). Call it after the copy is made and before the publish; an edit to
 * the Implementation phase after it makes it stale, as a real one would be.
 * Nothing graded rides on it: the closing phase is only opened.
 */
export async function stampDeepReceipt(dataSource: DataSource, versionId: string): Promise<void> {
  const versions = dataSource.getRepository(ProjectVersionEntity);
  const draft = await versions.findOneByOrFail({ id: versionId });
  const at = new Date().toISOString();
  await versions.update(
    { id: versionId },
    {
      validation: {
        ...(draft.validation ?? { findings: [], tier: 'fast', when: at }),
        deep: { contentDigest: executableContentDigest(draft), status: 'passed', checks: [], microVMs: 0, startedAt: at, finishedAt: at },
      },
    },
  );
}

/** What the importers need: the content, the database and the registry they reload. */
export interface ImportWorld {
  content: ContentService;
  dataSource: DataSource;
  registry: ProjectRegistryService;
}

/** Imports a pack as a platform pack, reloads the registry, and answers its version id. */
async function importPlatformPack(world: ImportWorld, source: MemoryPackSource): Promise<string> {
  // the loader reads only the folder layout: the older host is converted once, as the upload door converts one
  const imported = await new ProjectImporterService(world.content, world.dataSource).importPack(layoutFromManifest(source).source, {
    origin: 'seed',
    platformOwned: true,
  });
  await world.registry.load();
  return imported.projectVersionId;
}

/** Imports the one-phase host as a platform pack and answers its version id. */
export function importHostPack(world: ImportWorld, options: { slug?: string; order?: number } = {}): Promise<string> {
  return importPlatformPack(world, hostPack(options));
}

/** `importHostPack` for the three-phase variant. */
export function importHostPackThreePhase(world: ImportWorld, options: { slug?: string } = {}): Promise<string> {
  return importPlatformPack(world, hostPackThreePhase(options));
}

/** A teacher's untouched copy of the imported pack. */
export async function copyHost(
  world: { service: AuthoringService },
  fromVersionId: string,
  slug: string,
  teacher: Parameters<AuthoringService['createProject']>[0] = S1_TEACHER,
): Promise<Fork> {
  const made = await world.service.createProject(teacher, { title: `Copy ${slug}`, slug, fromVersionId });
  return { projectId: made.project.id, versionId: made.draftVersionId };
}

/** The two concept quizzes, added to the copy's phase through the authoring door. */
export async function addHostQuizzes(
  world: { service: AuthoringService },
  fork: Fork,
  phaseKey: PhaseKey = HOST_PHASE,
  teacher: Parameters<AuthoringService['addTask']>[0] = S1_TEACHER,
): Promise<void> {
  for (const key of HOST_QUIZ_KEYS) await world.service.addTask(teacher, fork.projectId, fork.versionId, phaseKey, hostQuizBody(key));
}
