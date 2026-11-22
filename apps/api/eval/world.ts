import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { DRAFT_FIRST_VERSION } from '@learnsdlc/shared';
import { ContentService } from '../src/content/content.service';
import type { InterviewBrief, PhaseContent, ProjectContent } from '../src/content/content.types';
import { ProjectImporterService, mintTeacherSlug } from '../src/content/importer.service';
import { COMPILER_IDENTITY, compilePack, soleTaskFor, type CompiledTask } from '../src/content/pack-compiler';
import { UploadService } from '../src/authoring/upload.service';
import { phaseScopeOf, type PhaseScope } from '../src/assistant/project-scope';
import { zipDirectory } from '../test/fixtures/upload-packs/archive';
import type { CorpusCase } from './contracts';
import { repoRoot } from './io';

/**
 * The content every case is composed against, loaded the way the product
 * loads it:
 *
 * - TaskTrackr: `ContentService.loadAll()` and `getPhase('tasktrackr', key)`
 *   (the reference arm of every prompt).
 * - The Shelf starter: zipped and sent through the real upload door
 *   (`UploadService` → `ProjectImporterService`), carrying its own sealed
 *   interview (`phases/01-requirements/interview.json`), then compiled exactly as `writeTeacherDraft`
 *   compiles it and installed as a published version. It is never loaded as a
 *   built-in pack, so its cases take the authored arm, as they did live.
 */

export const STARTER_TITLE = 'Shelf — a small library you can run';

/** The Shelf starter fixture every Shelf case is composed against. */
export const STARTER_FIXTURE = path.join('apps', 'api', 'test', 'fixtures', 'upload-packs', 'starter');

/**
 * An optional one-line label at the checkout root naming which copy of the
 * Shelf starter fixture the checkout holds, for a checkout that swaps in an
 * older copy to repeat a recorded run's exact requests. Absent means
 * `unknown`.
 */
export const STARTER_STATE_FILE = '.eval-starter-state';

/**
 * Which Shelf starter the checkout holds: the sha256 over its sorted relative
 * paths and bytes, and the label in STARTER_STATE_FILE. The fixture's text is
 * part of every Shelf request, so a real run refuses to resume on a different
 * copy than it started with.
 */
export function starterFixtureState(repo: string = repoRoot()): { state: string; sha256: string; files: number } {
  const root = path.join(repo, STARTER_FIXTURE);
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(root);
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(`${path.relative(root, f)}\0`).update(fs.readFileSync(f)).update('\0');
  let state = 'unknown';
  try { state = fs.readFileSync(path.join(repo, STARTER_STATE_FILE), 'utf8').trim() || 'unknown'; } catch { /* no label: unknown */ }
  return { state, sha256: h.digest('hex'), files: files.length };
}

export interface PackWorld {
  slug: string;
  content: ContentService;
  project: ProjectContent;
  tasksOf: Map<string, CompiledTask[]>;
  phase(key: string): PhaseContent;
  tasks(key: string): CompiledTask[];
  brief(): InterviewBrief;
}

let tasktrackr: PackWorld | null = null;
let starter: Promise<PackWorld> | null = null;

function tasktrackrWorld(): PackWorld {
  if (tasktrackr) return tasktrackr;
  const content = new ContentService();
  content.loadAll();
  const project = content.getProject('tasktrackr');
  const tasksOf = new Map(project.phases.map((phase) => [phase.key as string, [soleTaskFor(content.getPhase('tasktrackr', phase.key))]]));
  tasktrackr = {
    slug: 'tasktrackr',
    content,
    project,
    tasksOf,
    phase: (key) => content.getPhase('tasktrackr', key as never),
    tasks: (key) => tasksOf.get(key) ?? [],
    brief: () => {
      const brief = content.interviewBrief(content.getPhase('tasktrackr', 'requirements'));
      if (!brief) throw new Error('TaskTrackr has no interview brief');
      return brief;
    },
  };
  return tasktrackr;
}

async function uploadStarter(): Promise<PackWorld> {
  const root = path.join(repoRoot(), STARTER_FIXTURE);
  const loader = new ContentService();
  const importer = new ProjectImporterService(loader, { transaction: async () => { throw new Error('no database here'); } } as unknown as DataSource);
  const written: ProjectContent[] = [];
  // The importer's own write is the one seam: capture the content it would store.
  (importer as unknown as { writeTeacherDraft: (loaded: ProjectContent) => Promise<unknown> }).writeTeacherDraft = async (loaded: ProjectContent) => {
    written.push(loaded);
    return { projectId: 'p', versionId: 'v', slug: 'eval-starter', report: { ok: true }, packDigest: 'd' };
  };
  const upload = new UploadService(importer, loader, {} as DataSource, 8 * 1024 * 1024);
  await upload.upload({ id: 'owner' } as never, { title: STARTER_TITLE, archiveBase64: zipDirectory(root).toString('base64') } as never);
  if (written.length !== 1) throw new Error('the starter upload did not reach the importer write');
  // writeTeacherDraft's own first lines: the minted slug, the title, the draft version, then compilePack.
  const project: ProjectContent = { ...written[0], slug: mintTeacherSlug(STARTER_TITLE, new Set()), title: STARTER_TITLE, version: DRAFT_FIRST_VERSION };
  const snapshot = compilePack(project);
  const content = new ContentService();
  content.installVersions([{ versionId: 'eval-starter-version', content: project, compiler: COMPILER_IDENTITY, phases: snapshot.phases } as never]);
  const tasksOf = new Map(snapshot.phases.map((one: { key: string; tasks: CompiledTask[] }) => [one.key, one.tasks]));
  return {
    slug: project.slug,
    content,
    project,
    tasksOf,
    phase: (key) => content.getPhase(project.slug, key as never),
    tasks: (key) => tasksOf.get(key) ?? [],
    brief: () => {
      const brief = project.phases.find((phase) => phase.key === 'requirements')?.interview;
      if (!brief) throw new Error('the starter has no derived interview');
      return brief;
    },
  };
}

function starterWorld(): Promise<PackWorld> {
  if (!starter) starter = uploadStarter();
  return starter;
}

async function worldFor(c: CorpusCase): Promise<PackWorld> {
  const pack = c.input.phase?.pack ?? (c.tags.project === 'starter' ? 'starter' : 'tasktrackr');
  return pack === 'starter' ? starterWorld() : tasktrackrWorld();
}

/**
 * The phase a case is composed against. Two Agentic chat diagnostics carry a
 * synthetic phase object; it is used as the phase, with no files, exactly as
 * those diagnostics composed it.
 */
export async function phaseFor(c: CorpusCase): Promise<{ phase: PhaseContent; tasks: CompiledTask[]; world: PackWorld | null; synthetic: boolean }> {
  const p = c.input.phase;
  if (p?.synthetic) {
    const phase = { files: [], checks: { kind: 'markdown', rules: [] }, rubric: { criteria: [] }, ...p.synthetic } as unknown as PhaseContent;
    return { phase, tasks: [], world: null, synthetic: true };
  }
  const world = await worldFor(c);
  const key = p?.phaseKey ?? c.tags.phase ?? 'requirements';
  return { phase: world.phase(key), tasks: world.tasks(key), world, synthetic: false };
}

/** The phase-room scope the product resolves for a mentor or Agentic call. */
export const scopeFor = (phase: PhaseContent, tasks: CompiledTask[], lesson = false): PhaseScope =>
  phaseScopeOf(phase, tasks.length ? tasks : undefined, { lesson });

/**
 * The interview brief: TaskTrackr's authored brief, or the starter's own (its
 * `interview.json`). For a starter case the corpus records the fact topics the
 * recorded conversation showed; `derivationMatches` says whether the brief
 * holds every one of those fact ids (null when the case records none). The
 * name is the key recorded results carry.
 */
export async function briefFor(c: CorpusCase): Promise<{ brief: InterviewBrief; derivationMatches: boolean | null }> {
  const kind = c.input.brief?.kind;
  if (kind === 'reference') return { brief: tasktrackrWorld().brief(), derivationMatches: null };
  const brief = (await starterWorld()).brief();
  const observed = c.input.brief?.observedFactTopics as Record<string, unknown> | undefined;
  const ids = new Set(brief.facts.map((fact) => fact.id));
  const derivationMatches = observed ? Object.keys(observed).every((id) => ids.has(id)) : null;
  return { brief, derivationMatches };
}
