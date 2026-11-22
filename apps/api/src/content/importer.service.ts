import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import {
  DESKTOP_FOLDER,
  DRAFT_FIRST_VERSION,
  EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES,
  EDITOR_FOLDERS,
  INHERITED_TASK_KEY,
  MACHINE_OUTPUT_FOLDERS,
  PROJECT_TITLE_MAX,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVES_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_TITLE_MAX,
  WORKSPACE_FORBIDDEN_BLOB_ROLES,
  compareProjectVersions,
  isAuthoredTaskKey,
  isDesktopFile,
  isProjectSlug,
  isProjectVersion,
  type ProjectFileOwnerKind,
  type ProjectFileRole,
  type PhaseKey,
  type ProjectOrigin,
  type ValidationReport,
} from '@learnsdlc/shared';
// The upload's NOT_A_PACK refusal, for a malformed phase.json task block
import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_DETAIL_MAX } from '@learnsdlc/shared';
// The task block's as-sent caps count characters as UpdateTaskDto's
// @MaxLength does (a surrogate pair is one character).
import { maxLength } from 'class-validator';
import { config } from '../config';
import { INSERT_BATCH, chunked } from '../db/batches';
import { isUniqueViolation } from '../db/unique-violation';
import { blobShaFor, canonicalJson, sealedFilesOf, sha256Hex } from './blob.store';
import { ContentService, type CompilerDrift } from './content.service';
import { describeFirstPublishPins, describeImport, heldSlugRefusal, heldSlugResult } from './import-report';
import { sequencedTasks } from './quiz-files';
import {
  packRefusal,
  phaseTaskBlocksOf,
  soleTaskForBlock,
  taskBlockMovesTask,
  taskBlockPatch,
  taskBlockRefusal,
  type PhaseTaskBlock,
} from './task-blocks';
import { recordPathOf } from './checks-validation';
import type { InterviewBrief, ProjectContent } from './content.types';
// The one definition of what a task owns, so `deleteFileRows`
// asks the question `removeTask` and the compiler ask. `authoring/draft.ts`
// imports nothing of this file, so this is not a cycle.
import { ownsFor } from '../authoring/draft';
// A phase.json task block goes through the editor's own words overlay and
// draft compile (draft.ts imports nothing of this file), at the editor's caps.
import { compileDraft, overCapRefusal, taskWordsPatch } from '../authoring/draft';
// The fast tier a teacher's uploaded draft is held to
// on arrival. Neither file imports this one, so this is not a cycle.
import { fastValidation } from '../authoring/validation';
import type { ValidationPhaseInput } from '../authoring/validation';
import { readSupportedStacks } from '../authoring/runtime-stacks';
// The shared door rule for storable text
import { storableText } from '../authoring/door-rules';
import { refuseInterviewOverCaps } from '../authoring/interview-caps';
// A quiz file's row is the upload door's (`quiz-rows.ts`); the type only.
import type { QuizRowInput } from '../authoring/quiz-rows';
import { derivePack } from './folder-layout';
import { referencePacks } from './reference-content';
import {
  COMPILER_IDENTITY,
  compilePack,
  contentDigestOf,
  reservedPrefixOf,
  type CompiledSnapshot,
} from './pack-compiler';
import { isQuizTask, type CompiledTask } from './pack-compiler';
import { DirectoryPackSource, directoryPacksIn, type PackSource } from './pack-source';
import * as fs from 'fs';
import * as path from 'path';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
  type ProjectVersionManifest,
  type ProjectVersionValidation,
} from './project.entities';
import { hasStoredHead, pinNullRowsAtFirstPublish } from './version-pins';

/**
 * A pack's bytes become rows.
 *
 * The importer reads a pack through `ContentService.loadProject`, the same
 * loader the directory walk uses, so every validation a pack is held to runs
 * against the import, and only then does it write: the bytes
 * deduplicated by sha, one row per `(owner, path)` saying what each byte *is*,
 * the phases, and the compiled snapshot the runtime reads. A pack that does not
 * load never reaches a table.
 *
 * ## Idempotence, and why it is not "has this been seeded"
 *
 * Seed content reaches production by baking the directory into the image and
 * importing it at boot, so a content fix *is* a redeploy. An
 * existence check on `origin = 'seed'` would satisfy itself for ever after the
 * first boot and make that redeploy silently change nothing. So the key is
 * `(slug, version)` **and a digest of the pack's own bytes** (`packDigestOf`,
 * and see there for why it is not a digest of the compiled snapshot), and the
 * answers differ in kind:
 *
 * - no row for this version → import, compile, publish;
 * - published, same digest → nothing at all, and one log line;
 * - published, **different** digest → refuse by name, because a published
 *   version is immutable and the only honest fix is a version bump;
 * - a draft at this version → replaced, because drafts are mutable.
 *
 * A bumped version imports as a new published head. The superseded version
 * stays published and immutable, and enrolments pinned to it stay pinned:
 * that is the pin doing its job. So a content fix reaches new enrolments
 * immediately and existing ones at the next audited migrate.
 *
 * ## What it does not write
 *
 * **`project_tasks`.** A seeded phase that declares no tasks compiles to
 * exactly one task, keyed `''`, and that synthesised sole task is never a row.
 *
 * **`support` rows.** The loader refuses a `checks.supportFiles` entry that is
 * not also a locked `files` entry (a helper the learner's suite imports has to
 * still exist when it loads, so it is in the workspace deliberately and by name),
 * so in every pack that loads, support material *is* the locked workspace row
 * and writing it twice would be writing the same file under two roles. The role
 * stays in the vocabulary for material a phase does not mount, which is
 * precisely the case the first byte rule then refuses.
 *
 * **`interview` rows are written**, one per phase that declares an interview,
 * carrying the brief's canonical JSON. `project_phases.interview` is still the
 * only reader; the row exists so that the sha is in the version's rows and the
 * first byte rule's `interview` arm has something to see.
 *
 * **`canonical` rows.** A pack's `canonical/` directory is reached only through
 * a phase's own `files[]` (`../../canonical/…`), so its bytes arrive as the
 * workspace rows those entries describe. A `canonical` row is what an upload or
 * an authoring surface writes, and the second byte rule is what stops those
 * bytes reaching a file a learner is scored on filling in.
 */

/* --------------------------------- shapes --------------------------------- */

/** How a pack came in, and who owns what it created. */
export interface ImportOptions {
  origin?: ProjectOrigin;
  /** Explicit, never inferred from a NULL owner. */
  platformOwned?: boolean;
  ownerUserId?: string | null;
  /** The person who published it, when a person did. */
  publishedByUserId?: string | null;
  /**
   * What a platform import does with a pack whose slug a teacher's own project
   * already holds (a row with `platformOwned` false, with an owner or with
   * none after the author deleted their account): `'skip'`
   * writes nothing for that pack and answers `skipped-held`, which is the boot's
   * arm, since a throw would abort the whole directory's transaction and the
   * boot with it; `'refuse'` throws `heldSlugRefusal`, which is the
   * `import-pack` command's arm. The default is `'skip'`. A platform row with
   * the slug is imported as usual.
   */
  heldSlug?: 'skip' | 'refuse';
}

export interface DirectoryImportOptions extends ImportOptions {
  /** The slug to flag as the default; nothing is moved when it is absent. */
  defaultSlug?: string;
}

/**
 * `skipped-held`: a platform pack whose slug a teacher's project holds, skipped
 * at boot. It wrote nothing, and its result carries the pack's slug and version
 * only: empty ids and digest, zero counts, never the teacher's row.
 */
export type ImportOutcome = 'imported' | 'unchanged' | 'draft-replaced' | 'skipped-held';

export interface ImportResult {
  outcome: ImportOutcome;
  slug: string;
  version: string;
  projectId: string;
  projectVersionId: string;
  contentDigest: string;
  sandboxBudget: number;
  /** What was actually written, so a log line and a spec say the same thing. */
  blobsWritten: number;
  fileRows: number;
  phaseRows: number;
  /**
   * Set when this version was already published from these exact bytes and the
   * snapshot it holds is not the one this build's compiler produces. Null
   * otherwise, including on every import that wrote something: what it just
   * wrote is by definition this build's compile.
   */
  compilerDrift: CompilerDrift | null;
  /**
   * The null rows this import pinned at its project's first publish, present
   * only when above 0: the line beside `describeImport` is the
   * operator's only record of them (`describeFirstPublishPins`).
   */
  pinnedFromNull?: number;
}

/** A file row before it has an owner id: the pack says the phase, not the row. */
export interface DerivedFileRow {
  ownerKind: ProjectFileOwnerKind;
  /** The phase key this row belongs to, or `''` for the project itself. */
  ownerKey: string;
  path: string;
  role: ProjectFileRole;
  editable: boolean;
  language: string | null;
  bytes: string;
  blobSha: string;
}

/** A file row as a caller hands it over: the bytes, and what they are to this version. */
export interface NewFileRow {
  ownerKind: ProjectFileOwnerKind;
  ownerId: string;
  path: string;
  role: ProjectFileRole;
  editable: boolean;
  language: string | null;
  bytes: string;
}

/** Everything a file row may be edited to. `role` is deliberately not a member. */
export interface FileRowPatch {
  path?: string;
  editable?: boolean;
  language?: string | null;
}

/** The part of a row the two byte rules are about. */
interface RoleBearingRow {
  path: string;
  role: ProjectFileRole;
  editable: boolean;
  blobSha: string;
}

/**
 * Where a sealed row's path lives inside its owner.
 *
 * It is the role's own directory rather than the workspace path, because
 * `UNIQUE (projectVersionId, ownerId, path)` is the natural key and one phase
 * routinely holds the same workspace path twice: the implementation phase
 * mounts `api/repository/tasks.py` as an editable stub and holds the answer to
 * it in `solution/`. Mutants keep the pack's own `mutants/<name>/` because the
 * name is part of the identity: eight mutants of one file are eight rows, not
 * one row that kept the last of them.
 */
export const SEALED_ROW_DIRECTORY: [ProjectFileRole, string][] = [
  ['hidden', 'hidden'],
  ['solution', 'solution'],
  ['reference', 'reference'],
  ['drill', 'drill'],
];

/**
 * The roles a learner reads, which is who the first byte rule is about.
 *
 * `workspace` is what a workspace is, and `warmup` holds a pack's warm-up
 * files, written for a learner to read and edit with the learner's own
 * editability (`packages/shared/src/projects.ts` says so in as many words).
 * Asking the rule of the literal string `workspace` alone would leave the other
 * learner-facing role open: a version holding a phase's hidden suite as a
 * warm-up file would publish cleanly as learner material. The shipped pack cannot hit
 * it, its warm-up files are its own, so this is a wall for the authoring
 * surface and uploads.
 *
 * It would sit naturally beside the two byte-rule sets in the shared contract;
 * it lives here, next to the importer that asks it.
 */
export const LEARNER_FACING_FILE_ROLES: ProjectFileRole[] = ['workspace', 'warmup'];

/**
 * Where a phase's sealed interview brief is stored (one row per phase that
 * holds an interview), named once for the importer and `replaceInterviewRow`
 * alike.
 */
export const INTERVIEW_ROW_PATH = 'interview/brief.json';

/** Phase ids per `IN (...)` list when a draft's tasks are deleted. */
const PHASE_DELETE_BATCH = 100;

/** Blob hashes per `IN (...)` list when an import asks which bytes the store already holds. */
const BLOB_LOOKUP_BATCH = 200;

/** The kinds whose files are an application's: no authoring door writes or deletes them. */
const APPLICATION_KINDS: ReadonlySet<string> = new Set(['code', 'tests', 'config']);

/* ------------------------------ the derivations ---------------------------- */

/** The pack's header, which is everything it declares outside its phases. */
export function manifestOf(project: ProjectContent): ProjectVersionManifest {
  const manifest: ProjectVersionManifest = {
    tagline: project.tagline,
    description: project.description,
    language: project.language,
    languages: [...project.languages],
  };
  if (project.build) manifest.build = project.build;
  if (project.runtime) manifest.runtime = project.runtime;
  if (project.preview) manifest.preview = project.preview;
  if (project.warmup) manifest.warmup = project.warmup;
  return manifest;
}

/**
 * Every file row a loaded pack implies, in the order a reader of the table
 * wants them: a phase's workspace, then what is sealed from it, then the
 * warm-up, which is the project's own.
 *
 * The sealed sets come from `sealedFilesOf` rather than from a second reading
 * of `checks`, so the rows and the golden net's `sealed` digest cannot disagree
 * about what a phase seals. Mutants are read from `checks.mutants` instead,
 * because that function merges them by workspace path, which is right for a
 * digest over a phase's sealed bytes and would keep one of eight rows here.
 */
export function derivedFileRows(project: ProjectContent): DerivedFileRow[] {
  const rows: DerivedFileRow[] = [];
  const add = (
    ownerKind: ProjectFileOwnerKind,
    ownerKey: string,
    at: string,
    role: ProjectFileRole,
    editable: boolean,
    language: string | null,
    bytes: string,
  ): void => {
    rows.push({
      ownerKind,
      ownerKey,
      path: at,
      role,
      editable,
      language,
      bytes,
      blobSha: blobShaFor(bytes),
    });
  };

  for (const phase of project.phases) {
    for (const file of phase.files) {
      add('phase', phase.key, file.path, 'workspace', file.editable, file.language, file.content);
    }
    const sealed = sealedFilesOf(phase);
    for (const [role, directory] of SEALED_ROW_DIRECTORY) {
      for (const [at, bytes] of Object.entries(sealed[role] ?? {})) {
        add('phase', phase.key, `${directory}/${at}`, role, false, null, bytes);
      }
    }
    if (phase.checks.kind === 'tests') {
      for (const mutant of phase.checks.mutants) {
        for (const [at, bytes] of Object.entries(mutant.files)) {
          add('phase', phase.key, `mutants/${mutant.name}/${at}`, 'mutant', false, null, bytes);
        }
      }
    }
    // The interview brief, as one row per phase that has one. It is read off
    // `project_phases.interview` and not from here: it is a document rather
    // than a file a workspace could mount, which is why the phase row carries
    // it, but it is answer material, `WORKSPACE_FORBIDDEN_BLOB_ROLES` names
    // the role, and with no row carrying it that arm of rule 1 could not fire:
    // a version mounting the customer interview's bytes as a workspace file
    // published cleanly. One row puts the sha where the rule can see it.
    if (phase.interview) {
      add(
        'phase',
        phase.key,
        INTERVIEW_ROW_PATH,
        'interview',
        false,
        null,
        canonicalJson(phase.interview),
      );
    }
  }
  if (project.warmup) {
    for (const file of project.warmup.files) {
      add('project', '', `warmup/${file.path}`, 'warmup', file.editable, file.language, file.content);
    }
  }
  return rows;
}

/**
 * The digest a published version is keyed on: the pack's own bytes.
 *
 * Every file under the pack directory, by path and by the sha of its bytes, so
 * that the sentence the refusal says out loud: *"already published from
 * different bytes"*, is the question that was actually asked. It deliberately
 * digests neither the loader's output nor the compiler's, because both of those
 * move when *code* moves: a change to the loader or the compiler would make a
 * digest over the compiled snapshot new for content nobody had touched, and
 * the next redeploy would refuse the whole boot, telling the operator to bump a version for a change
 * that was not theirs.
 *
 * The other direction is the price, and it is the honest one: a file the loader
 * never reads is still a byte of the pack, so adding one needs a version bump
 * like any other change. `docs/authoring-format.md` says so.
 *
 * `walkForDigest`, not `walk`: the loading walk skips every dot-prefixed entry,
 * which is a rule about what may be mounted as a learner file and not a
 * statement about what the pack holds. The shipped pack carries
 * `canonical/.gitignore` and `canonical/.env.example`, either of which a phase
 * may source, so digesting the loading walk made the sentence above false for
 * them, and a fix to one at the same version came back as "unchanged" and then
 * as compiler drift, telling the operator the build had moved when the content
 * had.
 *
 * Built output is not identity: `web/.test/` (what `node web/run-tests.js`
 * compiles) and `.pytest_cache/` are named by the pack's own
 * `canonical/.gitignore`, appear on a machine that ran the suites and never in
 * a clean checkout. Digesting them made one pack two versions: an image built
 * on a laptop and one built from a clean checkout disagreed, and the boot
 * refused. They are left out here only; `walkForDigest` itself still lists
 * them, because the upload secret scan (`checkPackFiles`) must see every byte
 * of an archive.
 *
 * The same holds for what a maintainer's desktop, editor and local tools
 * leave: a `.DS_Store`, `Thumbs.db`, `desktop.ini` or AppleDouble
 * `._` file, a `__MACOSX/` folder, an `.idea` or `.vscode` folder, and the
 * local-tool folders (`.mypy_cache`, `.ruff_cache`, `.tox`, `.venv`, `venv`
 * beside the two above). None is authored, so none may move the digest; this
 * filter leaves them out, and the walk still lists them for the scan.
 */
const DIGEST_SKIPPED_DIRS: ReadonlySet<string> = new Set(['.test', '.pytest_cache']);

/** Whether a pack-relative path is a leftover of a maintainer's machine, by the folders it sits in or its own name. */
function isMachineLeftover(at: string): boolean {
  const parts = at.split('/');
  const folders = parts.slice(0, -1);
  return (
    folders.some((part) => MACHINE_OUTPUT_FOLDERS.has(part) || EDITOR_FOLDERS.has(part) || part === DESKTOP_FOLDER) ||
    isDesktopFile(parts[parts.length - 1])
  );
}

export function packDigestOf(source: PackSource): string {
  const files = [...source.walkForDigest()]
    .filter((at) => !at.split('/').some((part) => DIGEST_SKIPPED_DIRS.has(part)) && !isMachineLeftover(at))
    .sort();
  return sha256Hex(files.map((at) => `${at}\n${blobShaFor(source.read(at))}\n`).join(''));
}

/* --------------------------------- the rules ------------------------------- */

/**
 * Decision 37's two byte rules, asked of one version's rows.
 *
 * A role is a property of a `(version, phase, path)` and blobs are shared, so
 * the question is never "are these bytes sealed": in the shipped pack five
 * shas are a locked `workspace` row in one phase and a sealed `solution` file
 * in another, and that is correct. The two questions that *are* answerable are:
 *
 * 1. does a **workspace** row hold bytes this version also holds as a hidden
 *    test, a mutant, a drill's faulted copy, an interview brief or a sealed
 *    support file: material no learner may read at all, editable or locked;
 * 2. does an **editable** workspace row hold bytes this version also holds as
 *    answer material (every sealed role, plus `canonical`), because a learner
 *    asked to write the function cannot be handed the finished function to edit.
 *
 * `solution` and `reference` are deliberately outside rule 1, and their absence
 * is the whole point of the sets being written down: a locked workspace file
 * whose bytes are another phase's reference answer is the shipped shape of the
 * default project.
 */
export function refuseSealedWorkspaceBytes(where: string, rows: RoleBearingRow[]): void {
  const holders = new Map<string, Set<ProjectFileRole>>();
  for (const row of rows) {
    const roles = holders.get(row.blobSha) ?? new Set<ProjectFileRole>();
    roles.add(row.role);
    holders.set(row.blobSha, roles);
  }
  for (const row of rows) {
    if (!LEARNER_FACING_FILE_ROLES.includes(row.role)) continue;
    const roles = holders.get(row.blobSha) ?? new Set<ProjectFileRole>();
    for (const sealed of WORKSPACE_FORBIDDEN_BLOB_ROLES) {
      if (!roles.has(sealed)) continue;
      throw new BadRequestException(
        `${where}: the ${row.role} file "${row.path}" holds bytes this version also holds as ` +
          `${article(sealed)} ${sealed} file — sealed material may not be mounted where a learner ` +
          'reads it, editable or locked',
      );
    }
    if (!row.editable) continue;
    for (const answer of EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES) {
      if (!roles.has(answer)) continue;
      throw new BadRequestException(
        `${where}: the editable ${row.role} file "${row.path}" holds bytes this version also ` +
          `holds as ${article(answer)} ${answer} file — a learner asked to write it cannot be ` +
          'handed the finished one to edit',
      );
    }
  }
}

/** "a hidden file", "an interview file": the refusals read as sentences. */
/**
 * A learner file written where this version's own sealed rows live.
 *
 * The natural key is `UNIQUE (projectVersionId, ownerId, path)` and a phase's
 * sealed material is stored under `hidden/`, `solution/`, `reference/`,
 * `drill/`, `mutants/<name>/` and `interview/` inside that same owner. So a
 * workspace file mounted at `hidden/test_tasks.py` is not a naming
 * inconvenience: it is two roles arguing over one row, which is the one thing
 * the role model says cannot happen: a role is a property of a
 * `(version, phase, path)`, and that only holds while a path has one role.
 *
 * `compilePack` refuses the same shape for a whole pack, before a row is
 * written. This is the rule asked of a single row, which is how the authoring
 * surface writes one, and it is asked again at publish so
 * that a row written before the rule cannot be published after it.
 */
export function refuseReservedWorkspacePaths(where: string, rows: RoleBearingRow[]): void {
  for (const row of rows) {
    if (!LEARNER_FACING_FILE_ROLES.includes(row.role)) continue;
    const reserved = reservedPrefixOf(row.path);
    if (!reserved) continue;
    throw new BadRequestException(
      `${where}: the ${row.role} file "${row.path}" is under "${reserved}", which is where this ` +
        `version's ${reserved.slice(0, -1)} rows are stored. One path in one owner is one row ` +
        'with one role — rename the file.',
    );
  }
}

function article(role: ProjectFileRole): string {
  return /^[aeiou]/.test(role) ? 'an' : 'a';
}

/* -------------------------------- the service ------------------------------ */

@Injectable()
export class ProjectImporterService {
  private readonly logger = new Logger(ProjectImporterService.name);

  constructor(
    private readonly content: ContentService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * One pack, read through the loader and written as rows, compiled and
   * published in one transaction, so a failure part-way leaves the database as
   * it was rather than half a project.
   *
   * The write below is a read-then-insert, and the boot runs it on every
   * replica: the runbook's own procedure starts them concurrently
   * (`--scale api=3`), so at the deploy that bumps a content version several
   * processes read "no row for this version" and all of them insert. The
   * database settles it, and the loser is handed the winner's row rather than
   * an error: the same shape `enroll` already has for a double-tapped Start,
   * and the reason it matters here is that nothing catches a rejection out of
   * `onApplicationBootstrap`, so the loser's boot failed outright.
   */
  async importPack(source: PackSource, options: ImportOptions = {}): Promise<ImportResult> {
    try {
      return await this.writePack(source, options);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      this.logger.log(
        `"${source.name}": a row this import meant to insert already existed; reading it and ` +
          'importing again',
      );
      // Once, and the second attempt is the ordinary one: a lost race finds the
      // winner's committed row and answers `unchanged`, while a pack that
      // genuinely declares one path twice raises the same violation again and
      // it propagates. A retry loop at boot is worse than a boot that stops.
      return this.writePack(source, options);
    }
  }

  private async writePack(
    source: PackSource,
    options: ImportOptions = {},
    // The transaction to write inside, when the caller already opened one. A
    // whole content directory is imported in a single transaction so that a
    // later pack's refusal cannot leave an earlier pack published; one pack
    // imported on its own still opens its own.
    outer?: EntityManager,
  ): Promise<ImportResult> {
    const project = this.content.loadProject(source);
    if (!isProjectVersion(project.version)) {
      // The loader accepts a `-prerelease` or `+build` suffix and always has.
      // The model does not: a version here is compared field by field as
      // numbers to resolve the published head, and a suffix has no place in
      // that order.
      throw new BadRequestException(
        `${source.name}/project.json: version ("${project.version}") must be MAJOR.MINOR.PATCH ` +
          'to be imported — the head of a project is resolved by comparing versions field by ' +
          'field as numbers',
      );
    }
    const snapshot = compilePack(project);
    const contentDigest = packDigestOf(source);
    const derived = derivedFileRows(project);

    const write = async (manager: EntityManager): Promise<ImportResult> => {
      const projects = manager.getRepository(ProjectEntity);
      const versions = manager.getRepository(ProjectVersionEntity);

      let row = await projects.findOneBy({ slug: project.slug });
      if (row && options.platformOwned === true && !row.platformOwned) {
        // A teacher's project holds this slug (an upload or a copy took it
        // before this pack arrived), or held it: a project whose author deleted
        // their account keeps platformOwned false with no owner. Publishing here
        // would write the platform's version into it and delete its draft at
        // this version.
        if (options.heldSlug === 'refuse') throw new BadRequestException(heldSlugRefusal(project.slug));
        return heldSlugResult(project);
      }
      if (!row) {
        row = await projects.save(
          projects.create({
            slug: project.slug,
            title: project.title,
            origin: options.origin ?? 'seed',
            platformOwned: options.platformOwned ?? false,
            ownerUserId: options.ownerUserId ?? null,
            isDefault: false,
          }),
        );
      }

      const existing = await versions.findOneBy({ projectId: row.id, version: project.version });
      if (existing && existing.status !== 'draft') {
        if (existing.status === 'published' && existing.contentDigest === contentDigest) {
          // Not logged here: `describeImport` carries the sentence on the line
          // the boot and the CLI already print, which is one place rather than
          // two saying the same thing.
          const drift = compilerDriftOf(existing, snapshot);
          return this.resultFor(
            'unchanged',
            project,
            row.id,
            existing,
            contentDigest,
            0,
            0,
            0,
            drift,
          );
        }
        throw new BadRequestException(
          existing.status === 'published'
            ? `${project.slug} is at ${project.version}, which is already published from ` +
              'different bytes. A published version is immutable — bump project.json\'s version ' +
              'to import this change.'
            : `${project.slug} is at ${project.version}, which this deployment has archived. ` +
              "Bump project.json's version to import this change.",
        );
      }
      if (existing) await this.deleteVersion(manager, existing.id);

      // Asked before this version is written: a project with no stored head
      // until now has its null rows pinned to this version below.
      const hadHead = await hasStoredHead(manager, row.id);
      const version = await versions.save(
        versions.create({
          projectId: row.id,
          version: project.version,
          // The import *is* the publish: the pack has passed every
          // validation the loader has, its rows have passed decision 37's byte
          // rules, and nothing between here and the commit can be seen.
          status: 'published',
          manifest: manifestOf(project),
          compiled: snapshot,
          contentDigest,
          sandboxBudget: snapshot.sandboxBudget,
          publishedAt: new Date().toISOString(),
          publishedByUserId: options.publishedByUserId ?? null,
        }),
      );
      // The project's own title follows the version that is now its head: a
      // retitled pack is a retitled project, and the catalogue reads the row.
      if (row.title !== project.title) await projects.update({ id: row.id }, { title: project.title });
      // The first publish of a project pins the null rows waiting on it, as the
      // publish door does: they resolve this version from now on.
      const firstPins = hadHead ? 0 : (await pinNullRowsAtFirstPublish(manager, project.slug, version.id)).pinned;

      const phases = manager.getRepository(ProjectPhaseEntity);
      const owners = new Map<string, string>();
      for (const phase of project.phases) {
        const saved = await phases.save(
          phases.create({
            projectVersionId: version.id,
            key: phase.key,
            order: phase.order,
            title: phase.title,
            intro: phase.intro,
            artifactKind: phase.artifactKind,
            canRun: phase.canRun,
            canPreview: phase.canPreview,
            runLabel: phase.runLabel,
            assistant: phase.assistant,
            interview: phase.interview ?? null,
          }),
        );
        owners.set(phase.key, saved.id);
      }
      owners.set('', row.id);

      const written = await this.insertFiles(
        manager,
        version.id,
        derived.map((file) => ({
          ownerKind: file.ownerKind,
          ownerId: owners.get(file.ownerKey) as string,
          path: file.path,
          role: file.role,
          editable: file.editable,
          language: file.language,
          bytes: file.bytes,
        })),
      );

      const result = this.resultFor(
        existing ? 'draft-replaced' : 'imported',
        project,
        row.id,
        version,
        contentDigest,
        written.blobsWritten,
        written.rows,
        project.phases.length,
      );
      return firstPins > 0 ? { ...result, pinnedFromNull: firstPins } : result;
    };

    return outer ? write(outer) : this.dataSource.transaction(write);
  }

  /**
   * Every pack under a content root, in directory order.
   *
   * This is the boot path and the CLI's, and it is why the directory stays on
   * disk: it is the import source, and `config.ts` derives the repository root
   * by probing for `content/tasktrackr/project.json`.
   */
  async importContentDirectory(
    root: string = config.contentDir,
    options: DirectoryImportOptions = {},
  ): Promise<ImportResult[]> {
    const sources = directoryPacksIn(root);
    if (sources === null) {
      this.logger.warn(`content directory not found: ${root}; no project was imported`);
      return [];
    }
    if (sources.length === 0) {
      this.logger.warn(`no projects found under ${root}; no project was imported`);
      return [];
    }
    // One transaction for the whole directory, not one per pack: a later pack
    // that refuses: a version already published from different bytes, a
    // version string the model will not take, a decision-37 byte-rule
    // violation: must not leave an earlier one published. A deployment whose
    // content directory is half in the database is a deployment nothing says
    // is half in the database, and the boot that would have discovered it has
    // already died.
    let results: ImportResult[];
    try {
      results = await this.importAll(sources, options);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      this.logger.log(
        `"${root}": a row this import meant to insert already existed; reading it and ` +
          'importing again',
      );
      // The whole directory again rather than the one pack, because the first
      // attempt's transaction is gone: Postgres aborts a transaction at the
      // failed statement, so there is nothing left to carry the packs that had
      // already been written. The second attempt is the ordinary one: a lost
      // race finds the winner's committed rows and answers `unchanged`, and a
      // pack that genuinely declares one path twice raises the same violation
      // again and it propagates. A retry loop at boot is worse than a boot
      // that stops.
      results = await this.importAll(sources, options);
    }
    // After the commit, not inside it: the line an operator reads as "this is
    // what this deployment now holds" has to be about rows that are there.
    for (const result of results) {
      this.logger.log(describeImport(result));
      const pins = describeFirstPublishPins(result);
      if (pins) this.logger.log(pins);
    }
    await this.ensureDefaultProject(results, options.defaultSlug);
    return results;
  }

  /** Every pack under one root, written inside one transaction. */
  private importAll(sources: PackSource[], options: DirectoryImportOptions): Promise<ImportResult[]> {
    return this.dataSource.transaction(async (manager) => {
      const results: ImportResult[] = [];
      const each: ImportOptions = { ...options, heldSlug: options.heldSlug ?? 'skip' };
      for (const source of sources) results.push(await this.writePack(source, each, manager));
      return results;
    });
  }

  /* ---------- a teacher's uploaded draft ---------- */

  /**
   * One pack a teacher uploaded, written as **their own draft**.
   *
   * It shares `importPack`'s helpers and none of its decisions, so the seed's
   * path stays the boot path on every host. The differences are the whole
   * point:
   *
   * - **the slug is minted from the title**, never read from the archive, and
   *   never a reserved one (the reference project's and every slug this
   *   deployment already holds), so an upload can never collide with or
   *   shadow the reference project;
   * - the project is the teacher's: `ownerUserId` is theirs, `platformOwned`
   *   false, `origin` `upload`, and it is never the default;
   * - the version is a **draft** at `DRAFT_FIRST_VERSION`, whatever the pack's
   *   own `version` says, with no publish stamp: publishing goes through the
   *   authoring publish door and its refusals, never through here;
   * - the phases' sole tasks are materialised as rows keyed the way a copy
   *   keys them (`createProject`'s loop), because the editor addresses a task
   *   by its row.
   *
   * File rows go through `derivedFileRows` and `insertFiles`, so every role is
   * written exactly as the seed writes it and the two byte rules and
   * the reserved prefixes are asked before a byte lands. The compile is the one
   * compiler, and the fast tier runs and is stored the way the editor reads it.
   * One transaction: a pack the loader, the compiler or a byte rule refuses
   * leaves no row behind.
   */
  async importTeacherDraft(
    source: PackSource,
    opts: {
      ownerId: string;
      title: string;
      /**
       * Runs inside the draft's own transaction, after every
       * row is written and just before it commits, with the manager and the
       * ids the draft returns. A throw rolls the whole draft back, so a write
       * the caller makes here (the upload's audit row) commits with the draft
       * or not at all. Absent, the draft is written with no extra step.
       */
      onWritten?: (manager: EntityManager, ids: { projectId: string; versionId: string; slug: string }) => Promise<void>;
      /**
       * A folder-layout upload's quiz files, by phase, each the row the
       * editor's quiz door would write (`quizTaskRow`, the upload door's):
       * inserted beside the phase's work task, the phase's tasks
       * sequenced by order, ties by task key, then numbered 1 to n, and the
       * draft compiled the editor's way. Absent, no quiz is written.
       */
      quizzes?: ReadonlyMap<PhaseKey, readonly QuizRowInput[]>;
    },
  ): Promise<{ projectId: string; versionId: string; slug: string; report: ValidationReport; packDigest: string }> {
    const title = String(opts.title ?? '').trim();
    if (title.length === 0 || title.length > PROJECT_TITLE_MAX) {
      throw new BadRequestException(
        `A project needs a title of one to ${PROJECT_TITLE_MAX} characters, because its address is made from it.`,
      );
    }
    if (!opts.ownerId) throw new BadRequestException('An upload is always somebody\'s; no owner was named.');
    refuseUnfencedWarmup(source);
    // A Requirements or Design phase of the older markdown kind loads as a story or design phase, an older Deployment
    // with its runbook and an older Maintenance with its ticket and change request, as at the upload door.
    const loaded = this.content.loadProject(source, { convertLegacyRequirements: true, convertLegacyDesign: true, convertLegacyRunbook: true, convertLegacyChange: true, origin: 'upload' });
    refuseInterviewOverCaps(loaded, source); // the upload door's caps on a hand-written interview, asked again here
    // Each declared phase's `task` block, read and checked
    // before anything is written (the loader ignores the key).
    const blocks = phaseTaskBlocksOf(source);
    const packDigest = packDigestOf(source);
    // Uploads that minted one slug at the same moment: each loser reads the
    // winners' committed rows and mints past them. Bounded, and the last
    // refusal is a sentence rather than a driver's error.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.writeTeacherDraft(loaded, packDigest, opts.ownerId, title, opts.onWritten, blocks, opts.quizzes);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (attempt >= 4) {
          throw new ConflictException(
            'Several projects were being created under this title at the same moment. Upload again in a few seconds.',
          );
        }
      }
    }
  }

  private async writeTeacherDraft(
    loaded: ProjectContent,
    packDigest: string,
    ownerId: string,
    title: string,
    onWritten?: (manager: EntityManager, ids: { projectId: string; versionId: string; slug: string }) => Promise<void>,
    blocks: ReadonlyMap<string, { where: string; block: PhaseTaskBlock }> = new Map(),
    quizzes: ReadonlyMap<PhaseKey, readonly QuizRowInput[]> = new Map(),
  ): Promise<{ projectId: string; versionId: string; slug: string; report: ValidationReport; packDigest: string }> {
    return this.dataSource.transaction(async (manager) => {
      const taken = new Set(
        (await manager.find(ProjectEntity, { select: { slug: true } })).map((one) => one.slug),
      );
      const slug = mintTeacherSlug(title, taken);
      const project: ProjectContent = { ...loaded, slug, title, version: DRAFT_FIRST_VERSION };
      let snapshot = compilePack(project);
      const derived = derivedFileRows(project);
      // The task each block names, asked of the compiled list
      // before any row is written (exactly one non-quiz task per such phase).
      const named = new Map<string, CompiledTask>();
      for (const [phaseKey, { where, block }] of blocks) {
        const tasks = snapshot.phases.find((one) => one.key === phaseKey)?.tasks ?? [];
        named.set(phaseKey, soleTaskForBlock(where, tasks, block));
      }
      const savedPhases: ProjectPhaseEntity[] = [];
      const savedTasks = new Map<string, ProjectTaskEntity[]>();

      const row = await manager.save(
        manager.create(ProjectEntity, {
          slug,
          title,
          origin: 'upload' as ProjectOrigin,
          platformOwned: false,
          ownerUserId: ownerId,
          isDefault: false,
        }),
      );
      const version = await manager.save(
        manager.create(ProjectVersionEntity, {
          projectId: row.id,
          version: DRAFT_FIRST_VERSION,
          status: 'draft',
          manifest: manifestOf(project),
          compiled: snapshot,
          validation: null,
          contentDigest: null,
          sandboxBudget: null,
          forkedFromVersionId: null,
          publishedAt: null,
          publishedByUserId: null,
          notes: null,
        }),
      );

      const owners = new Map<string, string>();
      for (const phase of project.phases) {
        const saved = await manager.save(
          manager.create(ProjectPhaseEntity, {
            projectVersionId: version.id,
            key: phase.key,
            order: phase.order,
            title: phase.title,
            intro: phase.intro,
            artifactKind: phase.artifactKind,
            canRun: phase.canRun,
            canPreview: phase.canPreview,
            runLabel: phase.runLabel,
            assistant: phase.assistant,
            interview: phase.interview ?? null,
          }),
        );
        owners.set(phase.key, saved.id);
        savedPhases.push(saved);
        savedTasks.set(saved.id, []);
        const carried = [...(snapshot.phases.find((one) => one.key === phase.key)?.tasks ?? [])].sort(
          (a, b) => a.order - b.order,
        );
        const rows: QuizRowInput[] = carried.map((task, at) => ({
          taskKey: isAuthoredTaskKey(task.taskKey) ? task.taskKey : INHERITED_TASK_KEY,
          order: at + 1,
          required: task.required,
          signOff: task.signOff,
          artefactType: task.artefactType,
          artefactPath: task.artefactPath,
          title: task.title,
          brief: task.brief,
          objectives: task.objectives,
          primaryPath: null,
          anchor: null,
          rubric: task.rubric,
          checks: task.checks ?? phase.checks,
          // The block's words, through the editor's overlay, and its sign-off
          // mark, as the editor writes it
          ...(named.get(phase.key) === task ? taskBlockPatch(blocks.get(phase.key)!.block) : {}),
        }) as QuizRowInput);
        for (const [at, row] of sequencedTasks(rows, quizzes.get(phase.key) ?? []).entries()) {
          const savedTask = await manager.save(manager.create(ProjectTaskEntity, { ...row, projectPhaseId: saved.id, order: at + 1 }));
          savedTasks.get(saved.id)!.push(savedTask);
        }
      }
      owners.set('', row.id);

      await this.insertFiles(
        manager,
        version.id,
        derived.map((file) => ({
          ownerKind: file.ownerKind,
          ownerId: owners.get(file.ownerKey) as string,
          path: file.path,
          role: file.role,
          editable: file.editable,
          language: file.language,
          bytes: file.bytes,
        })),
      );

      // A block that moved a task's words, or a quiz file, compiles the draft
      // the way the editor compiles the same edit (draft.ts `compileDraft`),
      // so the stored snapshot is the one an editor save would have stored. A
      // pack with neither keeps the import's own compile, byte for byte.
      const withQuizzes = [...quizzes.values()].some((list) => list.length > 0);
      if (withQuizzes || [...blocks.values()].some(({ block }) => taskBlockMovesTask(block))) {
        const built = compileDraft(
          { content: snapshot.content, phases: savedPhases, tasks: savedTasks, sealed: new Map() },
          DRAFT_FIRST_VERSION,
        );
        if (!built.snapshot && withQuizzes) {
          // The quiz files' phases are named; the compiler's sentence, its pack label taken off, says why.
          const phases = [...quizzes].filter(([, list]) => list.length > 0).map(([key]) => key);
          throw packRefusal(
            `the quiz files of ${phases.join(', ')} make a draft that does not compile, so nothing was imported: ${String(built.error ?? '').replace(new RegExp(`(^|[\\s(])${slug}/`, 'g'), '$1')}`,
          );
        }
        if (!built.snapshot) {
          // Name the folder(s) whose block carries words, never
          // a key-only block's; the compiler's own message is not repeated.
          const wordy = [...blocks.values()].filter(({ block }) => taskBlockMovesTask(block)).map(({ where }) => where);
          throw taskBlockRefusal(
            wordy.join(', '),
            wordy.length === 1
              ? 'the draft its words make does not compile, so nothing was imported'
              : 'the draft these blocks\' words make does not compile, so nothing was imported',
          );
        }
        snapshot = built.snapshot;
        await manager.update(ProjectVersionEntity, { id: version.id, status: 'draft' }, { compiled: snapshot });
      }

      const report = fastValidation(
        {
          phases: snapshot.content.phases.map((phase): ValidationPhaseInput => {
            const tasks = snapshot.phases.find((one) => one.key === phase.key)?.tasks ?? [];
            return {
              key: phase.key,
              title: phase.title,
              checkKind: phase.checks.kind,
              hasDrill: phase.checks.kind === 'config' && Boolean(phase.checks.drill),
              tasks: tasks.map((task) => {
                const checks = task.checks ?? phase.checks;
                return {
                  taskKey: isAuthoredTaskKey(task.taskKey) ? task.taskKey : INHERITED_TASK_KEY,
                  title: task.title,
                  required: task.required,
                  artefactPath: task.artefactPath,
                  checkKind: checks.kind,
                  ...(checks.kind === 'quiz' ? { quiz: checks } : {}),
                  owns: [...task.owns],
                };
              }),
            };
          }),
          runtime: project.runtime ?? null,
          hasBuild: Boolean(project.build),
          hasPreview: Boolean(project.preview),
          compileError: null,
        },
        readSupportedStacks(),
      );
      // The shape `AuthoringService.persist` stores, so the editor opens on it.
      const stored = {
        findings: report.blocking.map((message) => ({ severity: 'error', message })),
        tier: report.tier,
        when: report.ranAt,
        report,
      };
      await manager.update(
        ProjectVersionEntity,
        { id: version.id, status: 'draft' },
        { validation: stored as unknown as ProjectVersionValidation },
      );

      // Before the log line, so a hook that refuses leaves no "uploaded" line
      // about rows that were rolled back.
      if (onWritten) await onWritten(manager, { projectId: row.id, versionId: version.id, slug });
      this.logger.log(
        `uploaded "${slug}" as a draft ${DRAFT_FIRST_VERSION}: ${project.phases.length} phases, ` +
          `${derived.length} files, ${snapshot.sandboxBudget} microVMs for one full pass; not published`,
      );
      return { projectId: row.id, versionId: version.id, slug, report, packDigest };
    });
  }

  /**
   * The newest published version of a project, compared field by field as
   * numbers so that 2.0.10 is newer than 2.0.9.
   *
   * A version string the pattern refuses sorts before every well-formed one, so
   * a malformed row can never come out of this as the head.
   */
  async newestPublishedVersion(
    manager: EntityManager,
    projectId: string,
  ): Promise<ProjectVersionEntity | null> {
    const published = await manager.find(ProjectVersionEntity, {
      where: { projectId, status: 'published' },
    });
    return (
      published.sort((a, b) => compareProjectVersions(b.version, a.version))[0] ?? null
    );
  }

  /**
   * Write file rows, with the two byte rules asked of the version's
   * rows as they will be once these are in.
   *
   * The single entry point for a file row: the importer calls it once with a
   * whole pack, and the authoring surface will call it with one file. The rule
   * is asked here rather than at publish alone because a version's rows are
   * readable (by a preview, by the assistant's redaction input) before it is
   * ever published.
   */
  async insertFiles(
    manager: EntityManager,
    projectVersionId: string,
    rows: NewFileRow[],
  ): Promise<{ rows: number; blobsWritten: number }> {
    if (rows.length === 0) return { rows: 0, blobsWritten: 0 };
    const held = await manager.find(ProjectFileEntity, { where: { projectVersionId } });
    const incoming: RoleBearingRow[] = rows.map((row) => ({
      path: row.path,
      role: row.role,
      editable: row.editable,
      blobSha: blobShaFor(row.bytes),
    }));
    const where = await this.labelFor(manager, projectVersionId);
    refuseSealedWorkspaceBytes(where, [...held, ...incoming]);
    refuseReservedWorkspacePaths(where, incoming);

    const blobsWritten = await this.writeBlobs(manager, rows);
    const files = manager.getRepository(ProjectFileEntity);
    const prepared = rows.map((row, at) =>
      files.create({
        projectVersionId,
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
        path: row.path,
        role: row.role,
        editable: row.editable,
        language: row.language,
        blobSha: incoming[at].blobSha,
      }),
    );
    for (const chunk of chunked(prepared, INSERT_BATCH)) await files.insert(chunk);
    return { rows: prepared.length, blobsWritten };
  }

  /**
   * Edit a file row, and refuse a patch that names a role.
   *
   * A role belongs to the row, is set when the row is created and is never
   * changed. There is no re-role operation to guard, which is the point:
   * changing a role is a delete and a create, so the bytes have to be supplied
   * again and the create's own rules apply to them. Blobs are shared, so a
   * fork's sealed rows point at the platform's own hidden tests and solutions:
   * a re-role on one row would be a re-role of somebody else's bytes.
   *
   * The role is not the only thing a patch could un-seal, and the other two are
   * refused here rather than only at publish for the same reason `insertFiles`
   * asks the rules at the write: a version's rows are readable (by a preview,
   * by the assistant's redaction input) before it is ever published.
   *
   * - **A published version's rows are not patchable at all.** A published
   *   version is immutable and that is the whole basis of the pin, so a path
   *   rewrite or an `editable` flip on content a class is being graded against
   *   is a version bump, not an edit.
   * - **A patch naming `editable` or `path` re-asks both byte rules.** Flipping
   *   `editable: false -> true` on one of the five dual-role shas is exactly
   *   the hand-the-learner-the-answer case rule 2 exists for, and it never
   *   passed through `insertFiles`.
   */
  async updateFile(manager: EntityManager, id: string, patch: FileRowPatch): Promise<void> {
    if ('role' in (patch as Record<string, unknown>)) {
      throw new BadRequestException(
        "a file's role is set when the row is created and never changed. Delete the row and " +
          'create it again with the bytes the new role needs.',
      );
    }
    const row = await manager.findOneByOrFail(ProjectFileEntity, { id });
    const where = await this.labelFor(manager, row.projectVersionId);
    const version = await manager.findOneByOrFail(ProjectVersionEntity, {
      id: row.projectVersionId,
    });
    if (version.status !== 'draft') {
      throw new BadRequestException(
        `${where} is ${version.status}; only a draft's file rows can be changed. A published ` +
          "version is immutable — bump the project's version to change it.",
      );
    }
    if ('editable' in patch || 'path' in patch) {
      const held = await manager.find(ProjectFileEntity, {
        where: { projectVersionId: row.projectVersionId },
      });
      const after = held.map((one) => (one.id === id ? { ...one, ...patch } : one));
      refuseSealedWorkspaceBytes(where, after);
      refuseReservedWorkspacePaths(where, after);
    }
    await manager.update(ProjectFileEntity, { id }, patch);
  }

  /* ---------- the doors that make a copy the teacher's own ---------- */

  /**
   * Replace the bytes of one or more `workspace` rows of a draft: a new blob,
   * the same rows: path, role and editability never move.
   *
   * More than one row only for one document several written phases mount (the
   * provided backlog), which is replaced everywhere in one call. Refused:
   *
   * - any version that is not a draft, which is the pin;
   * - any role but `workspace`: every sealed role, `canonical`, and `warmup`
   *   too, which has no authoring door;
   * - any row of an **application** phase (`code`, `tests`, `config`): those
   *   bytes are the reference application's and no authoring door writes them;
   *   except, under `options.startingRecord`, the one row a task of its phase
   *   grades as its record (Deployment's runbook, Maintenance's change
   *   request: `recordPathOf` of the task row's checks), which is the
   *   builder's starting point, not the application's;
   * - bytes the two byte rules refuse, asked of the version's rows as
   *   they will be with the new sha (a hidden suite's bytes in any learner
   *   file, an answer's in an editable one), and the reserved prefixes.
   */
  async replaceFileBytes(
    manager: EntityManager,
    rowIds: string[],
    bytes: string,
    options: { startingRecord?: boolean } = {},
  ): Promise<{ blobSha: string; rows: number }> {
    const ids = [...new Set(rowIds)];
    if (ids.length === 0) throw new BadRequestException('Name at least one file to replace.');
    const rows = await manager.find(ProjectFileEntity, { where: { id: In(ids) } });
    if (rows.length !== ids.length) throw new BadRequestException('A file named for replacement does not exist.');
    const versionId = rows[0].projectVersionId;
    if (rows.some((row) => row.projectVersionId !== versionId)) {
      throw new BadRequestException('One replacement writes the files of one version.');
    }
    const where = await this.requireDraftRows(manager, versionId);
    const records = new Set<string>();
    if (options.startingRecord) {
      const tasks = await manager.find(ProjectTaskEntity, { where: { projectPhaseId: In([...new Set(rows.map((row) => row.ownerId))]) } });
      for (const task of tasks) {
        const at = recordPathOf(task.checks);
        if (at) records.add(`${task.projectPhaseId}|${at}`);
      }
    }
    await this.refuseDoorRows(manager, where, versionId, rows, 'replaced', records);

    const blobSha = blobShaFor(bytes);
    const held = await manager.find(ProjectFileEntity, { where: { projectVersionId: versionId } });
    const after = held.map((one) => (ids.includes(one.id) ? { ...one, blobSha } : one));
    refuseSealedWorkspaceBytes(where, after);
    refuseReservedWorkspacePaths(where, after.filter((one) => ids.includes(one.id)));

    await this.writeBlobs(manager, [
      { ownerKind: 'phase', ownerId: rows[0].ownerId, path: rows[0].path, role: 'workspace', editable: false, language: null, bytes },
    ]);
    await manager.update(ProjectFileEntity, { id: In(ids) }, { blobSha });
    return { blobSha, rows: ids.length };
  }

  /**
   * Delete `workspace` rows of a draft that no remaining task owns. Blobs
   * are content-addressed and shared, so they stay.
   *
   * The first byte rule sees only rows, while a hidden suite or a mutant
   * lives on in the compiled checks, so a door that could delete a sealed row
   * would let `replaceFileBytes` write those bytes into a learner's file while
   * the grader kept using them. Hence refused: any version that is not a
   * draft; any role but `workspace` (the interview brief is removed only by
   * `replaceInterviewRow`); any row of an application phase; any row of
   * another version; and any row a task still owns.
   *
   * `removingTaskId` sets aside one task's claim. `removeTask` deletes the files
   * of the task it is removing **before** the task row, so ownership is asked
   * of the phase as it stands and that one task's claim is set aside: the
   * question `removeTask` itself asks (`held`, not `remaining`), because asked
   * of the survivors alone the inherited task would claim the leaving task's
   * file. A design task switching a contract off passes its own id too: the
   * claim it gives up is exactly the one on that contract's row.
   */
  async deleteFileRows(
    manager: EntityManager,
    projectVersionId: string,
    ids: string[],
    options: { removingTaskId?: string } = {},
  ): Promise<number> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;
    const where = await this.requireDraftRows(manager, projectVersionId);
    const rows = await manager.find(ProjectFileEntity, { where: { id: In(unique) } });
    const foreign = rows.find((row) => row.projectVersionId !== projectVersionId);
    if (rows.length !== unique.length || foreign) {
      throw new BadRequestException(`A file named for deletion is not a file of ${where}.`);
    }
    // The one row of an application phase this door may delete: the file a
    // teacher's **own** task minted, as that task leaves (a teacher may add a
    // written task to Maintenance). Never an inherited task's, and never
    // another path: the application's own files stay refused.
    const leaving = options.removingTaskId
      ? await manager.findOne(ProjectTaskEntity, { where: { id: options.removingTaskId } })
      : null;
    const mintedByLeaving =
      leaving && leaving.taskKey !== INHERITED_TASK_KEY && leaving.artefactPath
        ? new Set([`${leaving.projectPhaseId}|${leaving.artefactPath}`])
        : new Set<string>();
    await this.refuseDoorRows(manager, where, projectVersionId, rows, 'deleted', mintedByLeaving);

    for (const [phaseId, own] of groupBy(rows, (row) => row.ownerId)) {
      const tasks = await manager.find(ProjectTaskEntity, { where: { projectPhaseId: phaseId } });
      const editable = (
        await manager.find(ProjectFileEntity, {
          where: { projectVersionId, ownerKind: 'phase', ownerId: phaseId, role: 'workspace', editable: true },
        })
      ).map((row) => row.path);
      for (const task of tasks) {
        if (task.id === options.removingTaskId) continue;
        const owned = new Set(ownsFor(task, tasks, editable));
        const held = own.find((row) => owned.has(row.path));
        if (held) {
          throw new BadRequestException(
            `${where}: "${held.path}" cannot be deleted, because the task "${task.title}" still owns it — a file ` +
              'a task owns is what its learner writes and what it is graded on.',
          );
        }
      }
    }
    await manager.delete(ProjectFileEntity, { id: In(unique) });
    return unique.length;
  }

  /**
   * Keep a draft phase's sealed interview row in step with its brief: the old
   * row is deleted **before** the new one is inserted, so the natural key and
   * the byte rule see the new set; `null` removes the row with the interview.
   * The one door that touches an `interview` row. The insert goes through
   * `insertFiles`, so both byte rules are asked of the new brief's bytes.
   */
  async replaceInterviewRow(
    manager: EntityManager,
    projectVersionId: string,
    phaseRowId: string,
    brief: InterviewBrief | null,
  ): Promise<void> {
    await this.requireDraftRows(manager, projectVersionId);
    await manager.delete(ProjectFileEntity, {
      projectVersionId,
      ownerKind: 'phase',
      ownerId: phaseRowId,
      role: 'interview',
    });
    if (!brief) return;
    await this.insertFiles(manager, projectVersionId, [
      {
        ownerKind: 'phase',
        ownerId: phaseRowId,
        path: INTERVIEW_ROW_PATH,
        role: 'interview',
        editable: false,
        language: null,
        bytes: canonicalJson(brief),
      },
    ]);
  }

  /** A draft's label, or the refusal every door here gives a version that is not one. */
  private async requireDraftRows(manager: EntityManager, projectVersionId: string): Promise<string> {
    const where = await this.labelFor(manager, projectVersionId);
    const version = await manager.findOneByOrFail(ProjectVersionEntity, { id: projectVersionId });
    if (version.status !== 'draft') {
      throw new BadRequestException(
        `${where} is ${version.status}; only a draft's file rows can be changed. A published ` +
          "version is immutable — bump the project's version to change it.",
      );
    }
    return where;
  }

  /** The refusals `replaceFileBytes` and `deleteFileRows` share: the role, and the application's phases. */
  private async refuseDoorRows(
    manager: EntityManager,
    where: string,
    projectVersionId: string,
    rows: ProjectFileEntity[],
    what: 'replaced' | 'deleted',
    /** `<phase row id>|<path>` of rows exempt from the application refusal (a leaving teacher task's own file). */
    exempt: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const sealed = rows.find((row) => row.role !== 'workspace' || row.ownerKind !== 'phase');
    if (sealed) {
      throw new BadRequestException(
        `${where}: "${sealed.path}" is ${article(sealed.role)} ${sealed.role} file, and only a workspace file of a ` +
          `phase can be ${what} here — a role never changes, and a sealed row is never touched by an authoring door.`,
      );
    }
    const version = await manager.findOneByOrFail(ProjectVersionEntity, { id: projectVersionId });
    const guarded = rows.filter((row) => !exempt.has(`${row.ownerId}|${row.path}`));
    if (guarded.length === 0) return;
    const phases = await manager.find(ProjectPhaseEntity, {
      where: { id: In([...new Set(guarded.map((row) => row.ownerId))]) },
    });
    for (const phase of phases) {
      const compiled = version.compiled?.content.phases.find((one) => one.key === phase.key);
      const kind = compiled?.checks.kind ?? phase.artifactKind;
      if (APPLICATION_KINDS.has(kind)) {
        throw new BadRequestException(
          `${where}: ${phase.title}'s files are the reference application's — its code, hidden tests, ` +
            `deployment and maintenance — so they cannot be ${what} here.`,
        );
      }
    }
  }

  /**
   * A fork's rows: metadata only, carrying the source's roles and pointing at
   * the source's blobs.
   *
   * This is what makes a hundred forks of TaskTrackr one copy of TaskTrackr,
   * and it is also what makes sealed stay sealed through any number of forks:
   * the role is copied with the row rather than re-derived from the bytes.
   *
   * `owners` carries each row to its new owner as it is written. A copy's
   * phases are new rows, so a row that kept the source's `ownerId` would hang
   * off another version's phase until its caller re-pointed it. The map is old owner id →
   * new owner id (a phase row's, or the project's on a copy to a new project);
   * an owner it does not name keeps its id, which is what a caller passing no
   * map gets: metadata only, no byte, role or path moves.
   *
   * `only` names the source owner ids whose rows are copied (the Phases card's
   * Put back copies one phase's); absent, every row is, as a copy does.
   */
  async copyFilesToVersion(
    manager: EntityManager,
    fromVersionId: string,
    toVersionId: string,
    owners: ReadonlyMap<string, string> = new Map(),
    only?: ReadonlySet<string>,
  ): Promise<number> {
    const held = (await manager.find(ProjectFileEntity, { where: { projectVersionId: fromVersionId } }))
      .filter((row) => !only || only.has(row.ownerId));
    const files = manager.getRepository(ProjectFileEntity);
    const copies = held.map((row) =>
      files.create({
        projectVersionId: toVersionId,
        ownerKind: row.ownerKind,
        ownerId: owners.get(row.ownerId) ?? row.ownerId,
        path: row.path,
        role: row.role,
        editable: row.editable,
        language: row.language,
        blobSha: row.blobSha,
      }),
    );
    for (const chunk of chunked(copies, INSERT_BATCH)) await files.insert(chunk);
    return copies.length;
  }

  /**
   * Publish a version, re-asking the two byte rules of the rows
   * already in the database.
   *
   * The import publishes as it writes, so this is the authoring surface's path,
   * and it is the wall that means a row written before a rule
   * landed cannot be published after it.
   *
   * Only a draft can be published, and only a compiled one. Re-publishing a
   * published version is the other way to mutate it (`publishedAt` and the
   * publisher rewritten on content a class is being graded against), and
   * publishing a version whose `compiled` is still null produces a row the
   * registry skips by name, so an enrolment pinned to it silently resolves the
   * head instead. Both are refused at the door rather than logged at boot.
   */
  async publishVersion(
    manager: EntityManager,
    projectVersionId: string,
    publishedByUserId: string | null = null,
  ): Promise<void> {
    const where = await this.labelFor(manager, projectVersionId);
    const version = await manager.findOneByOrFail(ProjectVersionEntity, { id: projectVersionId });
    if (version.status !== 'draft') {
      throw new BadRequestException(
        `${where} is already ${version.status}; only a draft can be published. A published ` +
          "version is immutable — bump the project's version to publish a change.",
      );
    }
    const held = await manager.find(ProjectFileEntity, { where: { projectVersionId } });
    refuseSealedWorkspaceBytes(where, held);
    refuseReservedWorkspacePaths(where, held);
    if (!version.compiled) {
      throw new BadRequestException(
        `${where} holds no compiled snapshot; compile it before publishing, or the runtime ` +
          'registers nothing for it and an enrolment pinned to it resolves the head instead.',
      );
    }
    await manager.update(
      ProjectVersionEntity,
      { id: projectVersionId },
      { status: 'published', publishedAt: new Date().toISOString(), publishedByUserId },
    );
  }

  /**
   * Exactly one project is the default, and it is a fact about the project.
   *
   * Two rules, and the second is the one the resolution order's fourth step
   * (the flagged default project) needs:
   *
   * - **An operator's named slug moves the flag.** That is the third step's
   *   own choice (DEFAULT_PROJECT),
   *   read from the seed side, and it is the only thing that moves it.
   * - **Nobody's choice never moves it.** A project that is already flagged
   *   stays flagged, and only a deployment with no default at all takes the
   *   first pack of the walk. Deciding it from directory order on every boot
   *   would be wrong: a pack added later, or a
   *   renamed directory, would move every learner who names no project onto
   *   another project overnight.
   *
   * One transaction and two statements, in the order that cannot be seen
   * half-done: nothing in the database enforces "exactly one row is true", so a
   * crash between a row-by-row clear and set would leave a deployment with no
   * default and the fourth step with no answer. Two flagged rows are healed to one here rather
   * than answered arbitrarily by the reader.
   */
  private async ensureDefaultProject(
    results: ImportResult[],
    defaultSlug: string | undefined,
  ): Promise<void> {
    // A pack skipped for a held slug is a teacher's project, never the default,
    // even when DEFAULT_PROJECT names it: the flag stays where it was.
    const written = results.filter((result) => result.outcome !== 'skipped-held');
    if (!written.length) return;
    const named = written.some((result) => result.slug === defaultSlug)
      ? (defaultSlug as string)
      : null;
    await this.dataSource.transaction(async (manager) => {
      const projects = manager.getRepository(ProjectEntity);
      const flagged = await projects.find({ where: { isDefault: true }, order: { createdAt: 'ASC' } });
      const wanted = named ?? flagged[0]?.slug ?? written[0].slug;
      if (flagged.length === 1 && flagged[0].slug === wanted) return;
      await projects.update({ isDefault: true, slug: Not(wanted) }, { isDefault: false });
      await projects.update({ slug: wanted }, { isDefault: true });
      this.logger.log(`"${wanted}" is the project a request naming none answers for`);
    });
  }

  /** A draft, and everything that hung off it. Blobs are shared and are kept. */
  private async deleteVersion(manager: EntityManager, projectVersionId: string): Promise<void> {
    const phases = await manager.find(ProjectPhaseEntity, { where: { projectVersionId } });
    for (const chunk of chunked(phases.map((phase) => phase.id), PHASE_DELETE_BATCH)) {
      await manager.delete(ProjectTaskEntity, { projectPhaseId: In(chunk) });
    }
    await manager.delete(ProjectFileEntity, { projectVersionId });
    await manager.delete(ProjectPhaseEntity, { projectVersionId });
    await manager.delete(ProjectVersionEntity, { id: projectVersionId });
  }

  /** The bytes this import brings that the store does not already hold. */
  private async writeBlobs(manager: EntityManager, rows: NewFileRow[]): Promise<number> {
    const bytesBySha = new Map<string, string>();
    for (const row of rows) bytesBySha.set(blobShaFor(row.bytes), row.bytes);
    const blobs = manager.getRepository(ContentBlobEntity);
    const held = new Set<string>();
    for (const chunk of chunked([...bytesBySha.keys()], BLOB_LOOKUP_BATCH)) {
      const found = await blobs.find({ where: { sha: In(chunk) }, select: { sha: true } });
      for (const blob of found) held.add(blob.sha);
    }
    const missing = [...bytesBySha.entries()]
      .filter(([sha]) => !held.has(sha))
      .map(([sha, bytes]) =>
        blobs.create({ sha, bytes, size: Buffer.byteLength(bytes, 'utf-8') }),
      );
    for (const chunk of chunked(missing, INSERT_BATCH)) await blobs.insert(chunk);
    return missing.length;
  }

  /** `<slug> <version>`, which is how every refusal in this file names a version. */
  private async labelFor(manager: EntityManager, projectVersionId: string): Promise<string> {
    const version = await manager.findOneByOrFail(ProjectVersionEntity, { id: projectVersionId });
    const project = await manager.findOneByOrFail(ProjectEntity, { id: version.projectId });
    return `${project.slug} ${version.version}`;
  }

  private resultFor(
    outcome: ImportOutcome,
    project: ProjectContent,
    projectId: string,
    version: ProjectVersionEntity,
    contentDigest: string,
    blobsWritten: number,
    fileRows: number,
    phaseRows: number,
    compilerDrift: CompilerDrift | null = null,
  ): ImportResult {
    return {
      outcome,
      slug: project.slug,
      version: project.version,
      projectId,
      projectVersionId: version.id,
      contentDigest,
      sandboxBudget: version.sandboxBudget ?? 0,
      blobsWritten,
      fileRows,
      phaseRows,
      compilerDrift,
    };
  }
}

/**
 * The same bytes, and a snapshot this build did not compile.
 *
 * The idempotence key is the pack's own bytes, so a deployment whose *code*
 * moved boots rather than refusing, and it is then serving a snapshot its own
 * compiler would not produce. That is left exactly as it is: a published
 * version is immutable, an enrolment pinned to it resolves the snapshot it was
 * published with, and recompiling one in place would move the ground under an
 * attempt, which is the thing the pin exists to prevent. What changes here is
 * only that the fact is returned rather than whispered: `describeImport`
 * prints it, the CLI shows it on a terminal, and the registry reports the same
 * condition at readiness for versions whose pack is not on this disk at all.
 *
 * Two ways to be drift, and the second is the one a bump-less code change
 * makes: the identities differ, or they agree and the snapshots do not.
 */
export function compilerDriftOf(
  existing: ProjectVersionEntity,
  snapshot: CompiledSnapshot,
): CompilerDrift | null {
  if (!existing.compiled) return null;
  const compiledBy = existing.compiled.compiler ?? '';
  const sameIdentity = compiledBy === COMPILER_IDENTITY;
  const sameSnapshot = contentDigestOf(existing.compiled) === contentDigestOf(snapshot);
  if (sameIdentity && sameSnapshot) return null;
  return {
    slug: snapshot.slug,
    version: snapshot.version,
    compiledBy: !compiledBy
      ? 'a build that recorded no compiler identity'
      : sameIdentity
        ? `${compiledBy}, which compiles these bytes differently from this build`
        : compiledBy,
    thisBuild: COMPILER_IDENTITY,
  };
}

/* --------------------------------- helpers -------------------------------- */

/**
 * A teacher's draft never reads a warm-up from outside its own pack.
 *
 * The warm-up loader (`warmup.loader.ts`) reads `source.location` as a disk
 * path and does not go through the `PackSource`. For an archive that location
 * is a label (`upload:<name>`), so `path.resolve` would answer a warm-up from
 * the API process's own working directory, or from anywhere, for an absolute
 * or climbing `warmup` value. `UploadService` refuses a declared warm-up before
 * it calls here; this is the same fence at the method itself, so no other
 * caller can hand it an archive that reads the host:
 *
 * - a source that is not a folder on disk: any declared warm-up is refused;
 * - a folder: the warm-up folder must resolve (symlinks followed) strictly
 *   inside the pack folder.
 *
 * Neither sentence prints the path it was handed. A `project.json` that does
 * not parse is left to the loader, which says what is wrong with it.
 */
function refuseUnfencedWarmup(source: PackSource): void {
  let meta: unknown;
  try {
    meta = JSON.parse(source.read('project.json'));
  } catch {
    return;
  }
  const warmup = meta && typeof meta === 'object' ? (meta as { warmup?: unknown }).warmup : undefined;
  if (warmup === undefined || warmup === null) return;
  if (!(source instanceof DirectoryPackSource)) {
    throw new BadRequestException(
      'This project declares a warm-up, and a warm-up cannot be uploaded yet. Remove the warmup key from project.json, leave its folder out, and upload again.',
    );
  }
  const outside = new BadRequestException(
    "This project's warm-up folder is not inside the project folder. Keep the warm-up inside the project, or remove the warmup key from project.json.",
  );
  if (typeof warmup !== 'string' || warmup.length === 0 || path.isAbsolute(warmup)) throw outside;
  let root: string;
  let at: string;
  try {
    root = fs.realpathSync(source.location);
    at = fs.realpathSync(path.resolve(source.location, warmup));
  } catch {
    throw outside;
  }
  if (!at.startsWith(`${root}${path.sep}`)) throw outside;
}

/**
 * The address an uploaded project is given: minted from its
 * title, never from the archive, and never a reserved slug: the reference
 * project's (`referencePacks()`, held even on a deployment that has not
 * imported it) and every slug in `taken`. A clash takes the first free
 * `-2`, `-3`, … suffix, so two teachers' "Library" are two projects.
 */
export function mintTeacherSlug(title: string, taken: ReadonlySet<string>): string {
  let base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `project-${base}`.replace(/-+$/, '');
  base = base.slice(0, 40).replace(/-+$/, '');
  if (!isProjectSlug(base)) base = 'project';
  const reserved = new Set<string>([...taken, ...referencePacks()]);
  if (!reserved.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!reserved.has(candidate)) return candidate;
  }
}

/** Items grouped by a key, in first-seen order. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const held = out.get(key);
    if (held) held.push(item);
    else out.set(key, [item]);
  }
  return out;
}
