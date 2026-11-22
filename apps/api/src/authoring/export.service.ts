import { createHash } from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  DESKTOP_FOLDER,
  EDITOR_FOLDERS,
  EMPTY_CHANGE_REQUEST,
  EMPTY_RUNBOOK,
  INHERITED_TASK_KEY,
  MACHINE_OUTPUT_FOLDERS,
  SOLE_TASK_KEY,
  UPLOAD_REFUSAL_DETAIL_MAX,
  compareMountPaths,
  designDocumentPaths,
  isAuthoredTaskKey,
  isDesktopFile,
  isMachineOutputFile,
  isSealedFileRole,
  languageOfPath,
  phaseFolderName,
  plainTextOf,
  retiredWrittenPhaseAssignRefusal,
  serialiseChangeRequest,
  serialiseRunbook,
  type PhaseKey,
  type PhaseRubric,
  type ProjectFileRole,
  type QuizChecks,
} from '@learnsdlc/shared';
import { designChecksFromLegacyMarkdown } from '../content/design-legacy';
import { storyChecksFromLegacyMarkdown } from '../content/story-legacy';
import { runbookChecksFromLegacy } from '../content/runbook-legacy';
import { changeChecksFromLegacy } from '../content/change-legacy';
import { isOlderWritten } from '../content/older-written';
import { resolveImportMaxBytes } from '../config';
import { blobShaFor, canonicalJson } from '../content/blob.store';
import type {
  CodeChecks,
  ConfigChecks,
  ContentFileSpec,
  PhaseChecks,
  PhaseContent,
  PhaseRun,
  ProjectContent,
  TestsChecks,
} from '../content/content.types';
import { LAYOUT_SENTENCES } from '../content/folder-layout';
import { INTERVIEW_ROW_PATH } from '../content/importer.service';
import {
  phaseTaskBlocksOf,
  soleTaskForBlock,
  taskBlockMovesTask,
  taskBlockPatch,
  type PhaseTaskBlock,
} from '../content/task-blocks';
import { QuizFileRefusal, phaseQuizzesOf, sequencedTasks } from '../content/quiz-files';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import { ContentService, seededDesignDocument, seededStoryRecord } from '../content/content.service';
import { recordPathOf } from '../content/checks-validation';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import { checksOf, compilePack, isQuizTask, soleTaskFor, type CompiledPhaseTasks, type CompiledSnapshot, type CompiledTask } from '../content/pack-compiler';
import { plainPath } from '../content/secret-paths';
import { UploadRefusal, readZip, zipLimits, type ArchiveEntry } from '../content/zip-reader';
import { recordAudit } from '../audit/audit';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { centralHeader, dosStamp, endOfCentralDirectory, localHeader, type ZipEntry } from '../repo/zip';
import { overlaySealedRows, sealedRowsToOverlay, sealedRunRowPath } from './draft';
import { compileDraft } from './draft';
import { plainChecks as walkPlainChecks } from './plain-checks';
import { PlainTextRefusal, plainSource } from './plain-source';
import { clipEcho, quizFileBody, quizTaskRow, type QuizRowInput } from './quiz-rows';
import { ANCESTRY_MAX_HOPS, inheritedSealedRow, sealedViewOf, type SealedRoleView } from './sealed-roles';
import {
  buildPackManifest,
  checkLoadedPack,
  checkPackFiles,
  checkPackRuns,
  checkRunLimits,
  checkRuntimeProfile,
  checkSealedPaths,
  checkUploadShape,
  printable,
  type PackRefusal,
} from './upload-limits';
import { UPLOAD_MAX_BYTES_TOKEN } from './upload.service';
import { loaderSentence } from './loader-sentences';
import { COMPILE_CHECK_ID, rawPackManifestOf } from './validation';
import { UUID_PATTERN } from '../db/uuid';

/**
 * A version of a teacher's project, back to the folder layout
 * `docs/authoring-format.md` describes, as one stored zip.
 *
 * **The inverse of the importer.** `importTeacherDraft` reads a pack through
 * the loader and keeps what the loader made of it: the compiled snapshot, the
 * phase rows, the task rows and one `project_files` row per file and role.
 * The export writes the pack the upload door reads back into the same task
 * list:
 *
 *     <slug>/project.json                        the project, with no phase list
 *     <slug>/phases/NN-<key>/phase.json          the phase, written from its work task
 *     <slug>/phases/NN-<key>/files/<path>        a mount the learner edits, at its workspace path
 *     <slug>/phases/NN-<key>/readonly/<path>     a mount the learner reads, at its workspace path
 *     <slug>/phases/NN-<key>/interview.json      a requirements interview (sealed)
 *     <slug>/phases/NN-<key>/quizzes/<key>.json  a concept quiz of the phase
 *     <slug>/phases/NN-<key>/hidden_tests/<run>/<path>   code: a run's sealed suite
 *     <slug>/phases/NN-<key>/solution/<path>     code: the reference solution
 *     <slug>/phases/NN-<key>/reference/<path>    tests: the reference suite
 *     <slug>/phases/NN-<key>/impl/<path>         tests: the implementation it grades against
 *     <slug>/phases/NN-<key>/mutants/<name>/     tests: meta.json and the planted bug
 *     <slug>/phases/NN-<key>/smoke/<path>        config: a file the smoke run builds from
 *     <slug>/phases/NN-<key>/drill/<path>        config: the drill's faulted copy
 *
 * `NN` is the phase's place in the version, 1 to n. Every mount is written in
 * every phase that mounts it (a file several phases mount is written once per
 * phase), and `canonical/` is never written. A record the loader seeds again
 * (an untouched story or design record, an empty runbook or change request)
 * is left out, wherever it is mounted.
 *
 * **Every edit travels.** A phase holds one work task, and `phase.json` is
 * written from it as the editor last saved it: its brief as the phase's
 * `taskPanel`, its objectives, its rubric and its checks, and a `task` block
 * only for a title that differs from the phase's and for the sign-off mark.
 * Each quiz beside it is its own `quizzes/<task key>.json` (`{ title, brief,
 * order, objectives, required, checks }`). A phase holding quizzes and no
 * work task is refused by name. Every text member a teacher writes is
 * written as the upload door stores it, `plainTextOf` of it trimmed: the
 * brief, the task title, the intro,
 * each objective, each rubric sentence, the ticket and story lines, and each
 * quiz's title, brief, stems, options, explanations and concepts; so a
 * version stored before every brief was plain exports plain text, and its
 * stored bytes never change. Nothing is refused while it is written: a text
 * that held words and converts to nothing is written as it is, for the
 * read-back's plain-text pass to refuse in the door's own sentence.
 *
 * **The round trip inside every export.** The archive is read back the way
 * the upload door reads one (its secret scan, the derived layout's checks,
 * the plain-text pass, the quiz files, the loader, the loaded-pack checks and
 * the compile, task blocks and quizzes applied as the import applies them),
 * and refused with `taskDrift` when any phase compiles to another task list
 * than the version holds: each task's owned paths compared in path order
 * and its texts trimmed and through `plainTextOf` on both sides,
 * the stored side converted in memory for the compare only; and when any
 * phase mounts other files than the writer wrote, each mount compared as its
 * path, its editability, the language its path gives and its bytes, in path
 * order. An archive that withholds a
 * sealed file is asked every check that needs no whole archive, over the
 * layout it would have once the teacher writes those files back; the loader
 * waits for the teacher's own files.
 *
 * Every JSON file is written by `JSON.stringify(…, null, 2)` from the stored
 * snapshot, so the export reproduces what the platform holds, not an
 * author's own formatting. Exporting the re-import of an export gives the
 * same bytes (a fixed point).
 *
 * **Deterministic bytes.** Entries sorted by name, one fixed MS-DOS stamp
 * (1980-01-01 00:00), stored with `repo/zip.ts`'s writer: no clock, no
 * compression level, no dependency. Stored rather than deflated on purpose:
 * the upload caps the archive and what it unpacks to at the same
 * `importMaxBytes`, so deflating could never let a larger version back in.
 * The archive is read back with the upload's own reader under the upload's
 * own limits before it leaves, and anything that reader refuses is refused
 * here by its sentence. A warm-up is never exported: the upload refuses one,
 * so a copy of a project that has one exports without it.
 *
 * **The owner alone, and audited.** The owning teacher gets the archive; an
 * ADMIN or the platform's own project is 403 and another teacher's project is
 * 404 (`SealedRoleService`'s gate). A refusal writes nothing. A success writes
 * exactly one `project.exported` row: the version, the entry count and how
 * many files were withheld; never a byte, never a digest. The reads and the
 * build run outside any transaction; only the audit row is written in one.
 *
 * **Sealed files.** A sealed byte is written only when this version holds it
 * under a `project_files` row the caller did not inherit, or, in a version
 * whose copy chain never leaves the caller's own projects, when its own
 * compiled snapshot holds it (two runs may hold one hidden path with different
 * bytes, and only one row). Never from another project's blobs. A sealed row
 * that came with a copy of a project the caller does not own
 * (`inheritedSealedRow`, the question the owner's read asks) is withheld: its
 * bytes are not read and not written, and it is listed only as
 * `{ path, sha256, bytes }` in `withheld`. In a version with such a chain, a
 * sealed file with no matching row, and a smoke file no phase mounts, is
 * withheld too (fail closed). A mutant goes whole or not at all.
 *
 * No boot hook, no write but the audit row, no AI.
 */

/* ------------------------------ the contract ------------------------------ */

/** What `export` answers: the archive and what was kept out of it. */
export interface ExportResult {
  /** `<slug>-<version>.zip`. */
  filename: string;
  archive: Buffer;
  /** sha256 of `archive`, hex. Not in the audit row. */
  sha256: string;
  /** Files in the archive. */
  entries: number;
  /** Sealed files kept out, by the path they would have had inside the pack (sorted). */
  withheld: SealedRoleView[];
}

/** The audit name (`AUTHORING_AUDIT_EVENTS`), and the event the route table names. */
export const EXPORT_AUDIT_EVENT = 'project.exported' as const;

/** How many blobs one read asks for by sha, so an `IN` list stays within every driver's bound. */
const BLOB_READ_CHUNK = 500;

/** One fixed stamp, so the same version is always the same bytes. */
export const EXPORT_STAMP = dosStamp(new Date(1980, 0, 1, 0, 0, 0));

/** Sentences. None carries a byte of a file; a path named is one the teacher wrote. */
export const EXPORT_REFUSALS = Object.freeze({
  notFound: 'no project with that id in your library',
  noVersion: 'no version with that id in that project',
  platform: (title: string) =>
    `${title} is the platform's project, and its sealed files stay sealed. Copy it from the library to make a project of your own; you can export your own projects.`,
  notYours: 'That project is not yours to export. A teacher exports the projects they made, and nobody else exports them.',
  noSnapshot: (title: string, version: string) =>
    `${title} ${version} holds no compiled snapshot, so there is nothing to export. Open it in the editor, save once, and export again.`,
  // A phase folder holds its work task, and a quiz beside it is a file of its own
  noWorkTask: (phase: string) =>
    `${phase} holds no work task, only quizzes, and a phase folder holds its work task. Put the phase's task back, or remove the phase, and export again.`,
  taskDrift: (phase: string) =>
    `the archive would compile ${phase} to a different task than this version holds, so it is not exported`,
  kind: (phase: string) => `${phase} is graded by a kind of check the archive layout cannot hold, so this version cannot be exported yet.`,
  path: (phase: string, at: string) =>
    `${phase} holds "${at}", which the archive layout cannot carry where the loader would read it back (a sealed file needs a folder in its path, no part starting with a dot, and no build-output name). Rename it in the editor and export again.`,
  run: (phase: string, id: string) =>
    `${phase} has a run ("${id}") with no visible test or no implementation file, which the archive layout cannot write. Finish the run in the editor and export again.`,
  tooLarge: (mb: string) =>
    `This version is larger than the ${mb} an upload accepts, so its archive could not be uploaded again. Remove large files from the draft and export again.`,
  tooMany: (count: number) =>
    `This version holds more than the ${count.toLocaleString('en-US')} files an upload accepts, so its archive could not be uploaded again. Remove files from the draft and export again.`,
  unreadable: 'This version would make an archive the upload refuses, so it is not exported.',
  unloadable: 'This version would make an archive the upload refuses, so it is not exported:',
  missing: (phase: string) =>
    `${phase} names a sealed file whose bytes this version no longer holds, so the archive would be missing it. Write the file again in the editor and export again.`,
  runBytes: (phase: string, run: string, at: string) =>
    `${phase}'s run "${run}" holds its own copy of "${at}", and the archive layout holds a testing phase's suite and implementation once for every run, so that run would be graded by the other copy. Write the same file for every run in the editor and export again.`,
});

/* ---------------------------------- shapes --------------------------------- */

/**
 * The bytes the overlay is handed for an inherited row, whose blob is never
 * read: no sealed file holds a NUL (the sealed-role door refuses one), so it is never a file.
 */
const INHERITED_PLACE = '\u0000export: an inherited row, not read\u0000';

/** A sealed file resolved against the version's rows: its bytes, or why not. */
type Resolved = { bytes: string } | { view: SealedRoleView };

/** Everything a phase builder needs from the version's rows. */
interface RowIndex {
  /** phase key → row path → row (phase-owned rows). */
  byPhase: Map<string, Map<string, ProjectFileEntity>>;
  /** path → row (project-owned rows: the warm-up). */
  byProject: Map<string, ProjectFileEntity>;
  inherited: Set<string>;
  bytes: Map<string, string>;
  sizes: Map<string, number>;
  /** Whether the version's ancestry reaches a project the caller does not own. */
  foreign: boolean;
}

/** A phase's tasks as the archive writes them: its one work task, and the quizzes beside it. */
interface PhaseTasks {
  work: CompiledTask;
  quizzes: CompiledTask[];
}

/** The pack being written: path inside the pack → bytes, and the views kept out. */
class Layout {
  readonly files = new Map<string, Buffer>();
  readonly withheld = new Map<string, SealedRoleView>();

  put(at: string, bytes: string): void {
    const body = Buffer.from(bytes, 'utf-8');
    const held = this.files.get(at);
    // Two writers of one path is a defect of this file, never of the pack.
    if (held && !held.equals(body)) throw new Error(`the export layout wrote two different files at one path (${at})`);
    this.files.set(at, body);
  }

  json(at: string, value: unknown): void {
    this.put(at, `${JSON.stringify(value, null, 2)}\n`);
  }

  withhold(view: SealedRoleView): void {
    this.withheld.set(view.path, view);
  }

  /** Bytes in, or the view out; true when the file is in the archive. */
  place(resolved: Resolved, at: string): boolean {
    if ('bytes' in resolved) {
      this.put(at, resolved.bytes);
      return true;
    }
    this.withhold(resolved.view);
    return false;
  }
}

/* ------------------------------ pure helpers ------------------------------ */

/**
 * Whether the folder walk reads a file back at `at`: no empty or
 * relative part; no machine-output, editor or desktop folder on the way and
 * no machine-output or desktop file at the end (an upload refuses the first
 * two and leaves the desktop's out); and, for a sealed file, no part that
 * starts with a dot.
 */
function layoutCarries(at: string, sealed: boolean): boolean {
  const parts = at.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (sealed && parts.some((part) => part.startsWith('.'))) return false;
  const folders = parts.slice(0, -1);
  if (folders.some((part) => MACHINE_OUTPUT_FOLDERS.has(part) || EDITOR_FOLDERS.has(part) || part === DESKTOP_FOLDER)) return false;
  const name = parts[parts.length - 1];
  return !isMachineOutputFile(name) && !isDesktopFile(name);
}

/**
 * `runs[].testPaths` as the loader takes it back: only entries that cover one
 * of the run's own files (`loadRunTestPaths`), and none at all when that
 * leaves nothing (the loader's default is the run's own files). A path the
 * editor's overlay collected for a new reference helper is such an entry; the
 * layout cannot say it, and the loader would refuse the archive for it.
 */
function declaredTestPaths(testPaths: string[], own: string[]): { testPaths?: string[] } {
  const kept = testPaths.filter((entry) => own.some((one) => one === entry || one.startsWith(`${entry}/`)));
  return kept.length ? { testPaths: kept } : {};
}

/**
 * The rows a sealed file of one or more runs may live in, in the order they
 * are asked: the run-keyed rows (`sealedRunRowPath`) before the
 * bare path, or after it (`bareFirst`) for a file the layout holds once per
 * phase. A run id no row could carry is left out.
 */
function runRowPaths(rowPath: string, runIds: readonly string[], bareFirst = false): string[] {
  const carried: string[] = [];
  for (const runId of runIds) {
    try {
      carried.push(sealedRunRowPath(rowPath, runId));
    } catch {
      // not a run id a row carries: only the bare path can hold it
    }
  }
  return bareFirst ? [rowPath, ...carried] : [...carried, rowPath];
}

/**
 * A teacher's text as the upload door stores it (`plainSource`):
 * trimmed, then `plainTextOf`, then trimmed again, because a conversion
 * can leave a blank edge ("Intro\n\n---" reads "Intro\n\n"), so the archive
 * holds the text the door would store and the read-back compares like with
 * like. Never refuses here:
 * a text that held words and converts to nothing is written trimmed and as it
 * is, so the read-back's `plainSource` refuses it in the door's own sentence,
 * said after `unloadable`.
 */
function asStored(text: string): string {
  const trimmed = text.trim();
  const plain = plainTextOf(trimmed).trim();
  return trimmed.length > 0 && plain.length === 0 ? trimmed : plain;
}

/** A line inside a phase's checks (a story's, a design's, a ticket's), trimmed, plain and trimmed again; no door holds these to a blank rule. */
function plainLine(text: string): string {
  return plainTextOf(text.trim()).trim();
}

/**
 * A quiz's paper as the upload door stores it: each question's stem, option
 * texts, explanation and concept through `asStored`; ids, answers and every
 * setting as held. The quiz file's writer and the read-back's compare both
 * say it so. Nothing here refuses (the quiz door's `plainQuestion` would, with
 * a 400): a text that converts to nothing is written as it is, and the
 * read-back's `plainSource` refuses it, said after `unloadable` (409).
 */
function paperAsStored(paper: QuizChecks): QuizChecks {
  return {
    ...paper,
    questions: paper.questions.map((question) => ({
      ...question,
      stem: asStored(question.stem),
      options: question.options.map((option) => ({ ...option, text: asStored(option.text) })),
      explanation: asStored(question.explanation),
      ...(typeof question.concept === 'string' ? { concept: asStored(question.concept) } : {}),
    })),
  };
}

/** A rubric with each criterion's title and description as the door stores them (`asStored`). */
function plainRubric(rubric: PhaseRubric): PhaseRubric {
  return {
    ...rubric,
    criteria: rubric.criteria.map((one) => ({
      ...one,
      title: asStored(one.title),
      ...(typeof one.description === 'string' ? { description: asStored(one.description) } : {}),
    })),
  };
}

/**
 * The checks with a teacher's lines trimmed and plain (`plainLine`): a story phase's provided
 * stories (title, the sentence's three parts, each criterion's clauses) and
 * the learner story's hints, a design phase's stories (title and line), and a
 * Maintenance ticket's title, summary and acceptance lines. The members are
 * walked by `plain-checks.ts`, the one walker the draft conversion and the
 * upload door's plain-text pass walk too, so a member added there is written
 * here; a quiz never comes here (`paperAsStored`). A copy; any other kind
 * comes back as it is.
 */
function plainChecks(checks: PhaseChecks): PhaseChecks {
  const line = <T>(text: T): T => (typeof text === 'string' ? (plainLine(text) as T) : text);
  return walkPlainChecks(checks as ProjectTaskEntity['checks'], () => line) as PhaseChecks;
}

/**
 * A compiled task as the read-back compares it: the sole task's
 * key either way (`''` from a pack, `INHERITED_TASK_KEY` once the editor has
 * held it), its owned paths in path order, its texts as the door stores
 * them (`asStored`: trimmed, then `plainTextOf`), and every other
 * field as compiled. A quiz's checks are its paper, compared whole with its
 * texts as the door stores them (`paperAsStored`): the paper travels in its
 * quiz file, and the quiz door's rules read it back. Any other task's checks
 * are left out: a sealed file the owner wrote after the last compile is in the
 * archive (and so in the read-back's checks) and not yet in the held
 * snapshot's; the sealed bytes are the rows' own, and the run shapes are the
 * loader's read-back.
 */
function taskAsSaid(task: CompiledTask): string {
  return canonicalJson({
    taskKey: task.taskKey === INHERITED_TASK_KEY ? SOLE_TASK_KEY : task.taskKey,
    order: task.order ?? null,
    required: task.required ?? null,
    signOff: task.signOff ?? null,
    checkKind: task.checkKind ?? null,
    artefactType: task.artefactType ?? null,
    artefactPath: task.artefactPath ?? null,
    title: asStored(task.title ?? ''),
    brief: asStored(task.brief ?? ''),
    objectives: (task.objectives ?? []).map(asStored),
    owns: [...(task.owns ?? [])].sort(compareMountPaths),
    gradedUnits: task.gradedUnits ?? null,
    rubric: task.rubric ? plainRubric(task.rubric) : null,
    paper: isQuizTask(task) && task.checks ? paperAsStored(task.checks as QuizChecks) : null,
  });
}

/**
 * Whether a held phase is a Deployment or a Maintenance written before its
 * record: a config Deployment with no runbook, or a code Maintenance with
 * neither a ticket nor a change request. The upload door converts exactly
 * these (the loader's `recordConversion` asks the same), so the archive the
 * export writes for one is read back with its record.
 */
function isOlderRecord(phase: PhaseContent): boolean {
  const checks = phase.checks;
  return (phase.key === 'deployment' && checks.kind === 'config' && !checks.runbook)
    || (phase.key === 'maintenance' && checks.kind === 'code' && !checks.ticket && !checks.change);
}

/**
 * An older Requirements, Design, Deployment or Maintenance task as its
 * conversion at the upload door makes it: the kind, graded units, path and
 * owned files the converted phase gives it, and for a Design, Deployment or
 * Maintenance the rubric its rules are folded into; every other field the
 * held task's. The folded rubric is the door's own converter run over the
 * held phase (`designChecksFromLegacyMarkdown`, `runbookChecksFromLegacy`,
 * `changeChecksFromLegacy`, as the loader calls them), so the read-back's
 * rubric is still compared with what the archive had to say.
 */
function asConverted(phase: PhaseContent, task: CompiledTask, converted: CompiledTask): CompiledTask {
  const { checkKind, gradedUnits, artefactPath, owns } = converted;
  const held = { files: phase.files, checks: phase.checks, rubric: task.rubric, title: phase.title, intro: phase.intro, taskPanel: phase.taskPanel, objectives: phase.objectives };
  const rubric = phase.key === 'design'
    ? (designChecksFromLegacyMarkdown(phase.files, phase.checks, task.rubric).rubric ?? task.rubric)
    : isOlderRecord(phase)
      ? ((phase.key === 'deployment' ? runbookChecksFromLegacy : changeChecksFromLegacy)(held).rubric ?? task.rubric)
      : task.rubric;
  return { ...task, checkKind, gradedUnits, artefactPath, owns, rubric };
}

/**
 * A phase's sole task as the draft's own task row
 * says it, for a draft whose last compile failed. A failed compile leaves the
 * stored task list at the last one that compiled (`AuthoringService.persist`
 * refreshes the content and keeps the old phases), so an edit stored after it
 * is in the row and not in that list. The row is read the way the editor's
 * compile reads it (`authoredTasksFor` then the compiler's `authoredTaskFor`),
 * so the task is the one the next compile that succeeds would hold; the
 * checks, owns and graded units stay the held task's, because the content
 * (which the archive writes) already carries what the row says of them.
 */
function taskAsTheRowSaysIt(phase: PhaseContent, held: CompiledTask, row: ProjectTaskEntity): CompiledTask {
  return {
    ...held,
    taskKey: row.taskKey,
    required: row.required !== false,
    signOff: row.signOff === true,
    artefactType: row.artefactType ?? held.artefactType,
    artefactPath: row.artefactPath === undefined ? held.artefactPath : row.artefactPath,
    title: row.title ?? phase.title,
    brief: row.brief ?? phase.taskPanel,
    objectives: row.objectives ?? [],
    rubric: row.rubric ?? phase.rubric,
  };
}

/**
 * A phase's tasks as the draft's rows say them, in their order, for a draft
 * whose last compile failed: a work row through `taskAsTheRowSaysIt` over the
 * held task of its key (else the phase's sole task), a quiz row over the held
 * quiz of its key (else the quiz its row makes); no row at all is the
 * phase's own sole task (`compilePack`, no authored list), which is the task
 * the layout writes.
 */
function tasksAsTheRowsSayThem(phase: PhaseContent, held: readonly CompiledTask[], rows: readonly ProjectTaskEntity[]): CompiledTask[] {
  if (rows.length === 0) return [soleTaskFor(phase)];
  return rows.map((row, at) => {
    const same = held.find((task) => task.taskKey === row.taskKey || (row.taskKey === INHERITED_TASK_KEY && task.taskKey === SOLE_TASK_KEY));
    if (row.checks?.kind !== 'quiz') return { ...taskAsTheRowSaysIt(phase, same ?? soleTaskFor(phase), row), order: at + 1 };
    const checks = row.checks as QuizChecks;
    const base: CompiledTask = same ?? {
      taskKey: row.taskKey,
      order: at + 1,
      required: true,
      signOff: false,
      checkKind: 'quiz',
      artefactType: 'quiz',
      artefactPath: null,
      title: row.title ?? '',
      brief: row.brief ?? '',
      objectives: [],
      owns: [],
      gradedUnits: checks.questions.map((question) => ({ kind: 'question' as const, id: question.id })),
      rubric: row.rubric ?? phase.rubric,
    };
    return {
      ...base,
      taskKey: row.taskKey,
      order: at + 1,
      required: row.required !== false,
      signOff: row.signOff === true,
      title: row.title ?? base.title,
      brief: row.brief ?? base.brief,
      objectives: row.objectives ?? [],
      rubric: row.rubric ?? base.rubric,
      checks,
    };
  });
}

/** Whether the version's stored fast report says its last compile failed (`COMPILE_CHECK_ID`). */
function lastCompileFailed(version: ProjectVersionEntity): boolean {
  const stored = version.validation as { report?: { checks?: { id?: unknown; status?: unknown }[] } } | null;
  return (stored?.report?.checks ?? []).some((check) => check?.id === COMPILE_CHECK_ID && check?.status === 'failed');
}

/**
 * The first phase whose task list the read-back compiled differently from the
 * held one, or null; each task said by `taskAsSaid`, so the owned paths are
 * compared in path order and the texts as the door stores them on both sides.
 */
function taskListDrift(held: ProjectContent, heldTasks: CompiledPhaseTasks[], back: ProjectContent, backTasks: CompiledPhaseTasks[]): string | null {
  for (const phase of held.phases) {
    const again = back.phases.find((one) => one.key === phase.key);
    if (!again) return phase.title;
    const two = backTasks.find((entry) => entry.key === phase.key)?.tasks ?? [];
    // An older Requirements or Design is written as it was and read back converted, as the upload door reads
    // it: it must come back as its converted kind, and its task as the held one, but for what the conversion
    // derives from the record it makes (`asConverted`). An older Deployment or Maintenance likewise: it must
    // come back carrying its record (a runbook, or a ticket and a change request).
    const writtenOlder = isOlderWritten(phase.checks);
    const recordOlder = isOlderRecord(phase);
    if (writtenOlder && again.checks.kind !== (phase.key === 'requirements' ? 'story' : 'design')) return phase.title;
    if (recordOlder && recordPathOf(again.checks) === null) return phase.title;
    const older = writtenOlder || recordOlder;
    const one = (heldTasks.find((entry) => entry.key === phase.key)?.tasks ?? []).map((task, at) => (older && two[at] ? asConverted(phase, task, two[at]) : task));
    const said = (tasks: CompiledTask[]): string => tasks.map(taskAsSaid).join('\n');
    if (said(one) !== said(two)) return phase.title;
  }
  return held.phases.length === back.phases.length ? null : (held.phases[0]?.title ?? 'a phase');
}

/** Each phase's workspace bytes as the writer wrote them: phase key → workspace path → bytes (rows over the snapshot). */
export type WrittenMounts = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** A phase's mounts as the read-back compares them: `[path, editable, languageOfPath(path), sha]`, in path order. */
function mountsAsSaid(files: readonly { path: string; editable: boolean }[], bytesOf: (path: string) => string): string[] {
  return [...files]
    .sort((a, b) => compareMountPaths(a.path, b.path))
    .map((file) => canonicalJson([file.path, file.editable, languageOfPath(file.path), blobShaFor(bytesOf(file.path))]));
}

/**
 * An older written or older record phase's mounts as its conversion at the
 * upload door leaves them: the door's own converter (`storyChecksFromLegacyMarkdown`,
 * `designChecksFromLegacyMarkdown`, `runbookChecksFromLegacy`,
 * `changeChecksFromLegacy`, as the loader calls them) run over the files the
 * writer wrote, which drops the phase's markdown and adds or makes its record.
 * Any other phase's mounts as written.
 */
function mountsAsConverted(phase: PhaseContent, files: ContentFileSpec[]): ContentFileSpec[] {
  if (isOlderWritten(phase.checks)) {
    return phase.key === 'requirements' ? storyChecksFromLegacyMarkdown(files, phase.checks).files : designChecksFromLegacyMarkdown(files, phase.checks, phase.rubric).files;
  }
  if (!isOlderRecord(phase)) return files;
  const input = { files, checks: phase.checks, rubric: phase.rubric, title: phase.title, intro: phase.intro, taskPanel: phase.taskPanel, objectives: phase.objectives };
  return (phase.key === 'deployment' ? runbookChecksFromLegacy : changeChecksFromLegacy)(input).files;
}

/**
 * The first phase whose mounts the read-back holds differently from the
 * held ones, or null (each phase's mounts in the folder layout's order,
 * languages derived from the path on both sides). Each side is said by
 * `mountsAsSaid`; the held side's bytes are what the writer wrote (`written`,
 * the rows over the snapshot), so a file replaced after a failed compile is
 * no drift, and a record the export left out because the loader seeds it
 * again counts with the seed's bytes, which are the bytes it holds. An older
 * written phase or an older record phase is read back converted: its held
 * mounts as the door's conversion leaves them (`mountsAsConverted`) must each
 * be read back, equal, among the read-back's, which may add the record the
 * loader seeds. Exported for its spec, which asks it alone: through an
 * archive a phase's work task owns its editable mounts, so the task list's
 * compare meets an editability change first.
 */
export function mountDrift(held: ProjectContent, written: WrittenMounts, back: ProjectContent): string | null {
  for (const phase of held.phases) {
    const again = back.phases.find((one) => one.key === phase.key);
    if (!again) return phase.title;
    const bytes = written.get(phase.key);
    const files = phase.files.map((file) => ({ ...file, content: bytes?.get(file.path) ?? file.content }));
    const older = isOlderWritten(phase.checks) || isOlderRecord(phase);
    const mounts = older ? mountsAsConverted(phase, files) : files;
    const one = mountsAsSaid(mounts, (at) => mounts.find((file) => file.path === at)!.content);
    const two = mountsAsSaid(again.files, (at) => again.files.find((file) => file.path === at)!.content);
    if (older) {
      const read = new Set(two);
      if (one.some((mount) => !read.has(mount))) return phase.title;
      continue;
    }
    if (one.join('\n') !== two.join('\n')) return phase.title;
  }
  return null;
}

/** A task-block refusal's detail (the importer's: a folder, a member, a cap; never a value), or a plain sentence. */
function taskBlockDetail(error: HttpException): string {
  const body = error.getResponse() as { detail?: unknown };
  return typeof body?.detail === 'string' && body.detail ? body.detail : "a phase's task block is one the upload refuses";
}

/**
 * The read-back's task list as `importTeacherDraft` stores it: the task each
 * phase.json `task` block names (`soleTaskForBlock`, which refuses a phase
 * that is not one work task and a key that renames), then, when a block
 * carries words or the sign-off mark or the archive holds a quiz file, the
 * rows the import writes (the block's words through the editor's overlay,
 * `taskBlockPatch`; each quiz row beside the work task, the phase's tasks
 * sequenced by order, ties by task key, and numbered 1 to n), compiled by the
 * editor's draft compile (`compileDraft`). Null when that draft does not
 * compile. In memory only: no row is written.
 */
function asImported(
  snapshot: CompiledSnapshot,
  blocks: ReadonlyMap<string, { where: string; block: PhaseTaskBlock }>,
  quizzes: ReadonlyMap<PhaseKey, readonly QuizRowInput[]>,
): CompiledPhaseTasks[] | null {
  const named = new Map<string, CompiledTask>();
  for (const [phaseKey, { where, block }] of blocks) {
    named.set(phaseKey, soleTaskForBlock(where, snapshot.phases.find((one) => one.key === phaseKey)?.tasks ?? [], block));
  }
  const withQuizzes = [...quizzes.values()].some((list) => list.length > 0);
  if (!withQuizzes && ![...blocks.values()].some(({ block }) => taskBlockMovesTask(block))) return snapshot.phases;
  const phases: ProjectPhaseEntity[] = [];
  const tasks = new Map<string, ProjectTaskEntity[]>();
  for (const phase of snapshot.content.phases) {
    const id = `export-read-back-${phase.key}`;
    phases.push({ id, key: phase.key } as ProjectPhaseEntity);
    const carried = [...(snapshot.phases.find((one) => one.key === phase.key)?.tasks ?? [])].sort((a, b) => a.order - b.order);
    const rows = carried.map(
      (task, at) =>
        ({
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
          ...(named.get(phase.key) === task ? taskBlockPatch(blocks.get(phase.key)!.block) : {}),
        }) as QuizRowInput,
    );
    tasks.set(
      id,
      sequencedTasks(rows, quizzes.get(phase.key) ?? []).map((row, at) => ({ ...row, id: `${id}-${at + 1}`, projectPhaseId: id, order: at + 1 }) as ProjectTaskEntity),
    );
  }
  return compileDraft({ content: snapshot.content, phases, tasks, sealed: new Map() }, snapshot.content.version).snapshot?.phases ?? null;
}

/**
 * Each quiz file of the archive as the row the editor's quiz door writes,
 * as the upload door reads it: its JSON, then the DTO's wall, the
 * inherited key, the paper, `checkedQuiz`'s checks with the task key as the
 * title, and the title and brief caps, each refusal in the "<path> is not a
 * quiz: " shape with every value it echoes clipped (`clipEcho`), carried as a
 * `QuizFileRefusal`.
 */
function quizRowsOf(source: MemoryPackSource): Map<PhaseKey, QuizRowInput[]> {
  const out = new Map<PhaseKey, QuizRowInput[]>();
  for (const [key, list] of phaseQuizzesOf(source)) {
    out.set(key, list.map((one) => {
      try {
        return quizTaskRow(quizFileBody(one.raw), one.key, clipEcho);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        throw new QuizFileRefusal(LAYOUT_SENTENCES.notAQuiz(plainPath(one.at), error.message));
      }
    }));
  }
  return out;
}

/**
 * The archive's entries with an empty stand-in at every withheld path (and
 * a `meta.json` stand-in for a withheld mutant's folder), so the layout's own
 * rules, which need every sealed folder a phase holds, read the archive as it
 * will be once the teacher writes those files back. Never written anywhere.
 */
function withStandIns(entries: readonly ArchiveEntry[], root: string, withheld: readonly SealedRoleView[]): ArchiveEntry[] {
  const prefix = root ? `${root}/` : '';
  const held = new Set(entries.map((entry) => entry.name));
  const out = [...entries];
  const add = (at: string, text: string): void => {
    if (held.has(`${prefix}${at}`)) return;
    held.add(`${prefix}${at}`);
    out.push({ name: `${prefix}${at}`, bytes: Buffer.from(text, 'utf-8') });
  };
  for (const view of withheld) {
    add(view.path, '');
    const mutant = /^(phases\/[^/]+\/mutants\/[^/]+)\//.exec(view.path);
    if (mutant) add(`${mutant[1]}/meta.json`, '{}');
  }
  return out;
}

/**
 * A refusal's findings as one detail of at most `UPLOAD_REFUSAL_DETAIL_MAX`
 * characters: the upload's own sentences, first first, as many as fit with
 * room for "And N more." after them (the first alone, cut, when it fills it).
 */
function refusalDetail(found: readonly PackRefusal[]): string {
  const said: string[] = [];
  for (let at = 0; at < found.length; at += 1) {
    const sentence = `${printable(found[at].sentence)}.`;
    const rest = found.length - at - 1;
    const tail = rest > 0 ? ` And ${rest} more.` : '';
    const next = [...said, sentence].join(' ');
    if (next.length + tail.length <= UPLOAD_REFUSAL_DETAIL_MAX) {
      said.push(sentence);
      continue;
    }
    const more = ` And ${found.length - at} more.`;
    if (said.length === 0) {
      // The first finding alone is too long: cut it, keeping room for the count.
      const room = UPLOAD_REFUSAL_DETAIL_MAX - (rest > 0 ? tail.length : 0) - 1;
      return `${sentence.slice(0, Math.max(0, room)).trimEnd()}…${rest > 0 ? tail : ''}`;
    }
    return `${said.join(' ')}${more}`;
  }
  return said.join(' ');
}

/** The harness a language runs under when the pack names none (`content.service.ts`). */
function defaultHarness(language: string): string {
  return language === 'python' ? 'unittest' : 'js';
}

function mb(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/**
 * A stored zip of `files` under one top-level folder, entries sorted by name,
 * every header stamped `EXPORT_STAMP`: `repo/zip.ts`'s writer, whole in memory.
 */
export function storedZipOf(root: string, files: ReadonlyMap<string, Buffer>): Buffer {
  const names = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Buffer[] = [];
  const central: ZipEntry[] = [];
  let offset = 0;
  for (const name of names) {
    const body = files.get(name) as Buffer;
    const { header, entry } = localHeader(`${root}/${name}`, body, EXPORT_STAMP);
    central.push({ ...entry, offset });
    parts.push(header, body);
    offset += header.length + body.length;
  }
  const directory = Buffer.concat(central.map((entry) => centralHeader(entry, EXPORT_STAMP)));
  return Buffer.concat([...parts, directory, endOfCentralDirectory(central.length, directory.length, offset)]);
}

/** The archive's size before it is built: local headers, bodies, central headers, end record. */
function storedZipSize(root: string, files: ReadonlyMap<string, Buffer>): number {
  let total = 22;
  for (const [name, body] of files) {
    const nameBytes = Buffer.byteLength(`${root}/${name}`, 'utf-8');
    total += 30 + nameBytes + body.length + 46 + nameBytes;
  }
  return total;
}

/* -------------------------------- the service ------------------------------ */

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly maxBytes: number;

  constructor(
    private readonly dataSource: DataSource,
    // The loader the upload reads a pack with, so an export is read back the
    // same way before it leaves.
    private readonly content: ContentService,
    // The upload's own cap (the same token), so an export always fits the
    // door it would come back in through.
    @Optional() @Inject(UPLOAD_MAX_BYTES_TOKEN) maxBytes?: number,
  ) {
    this.maxBytes = maxBytes ?? resolveImportMaxBytes();
  }

  /**
   * One version of the caller's own project as an archive in the authoring
   * layout. The owner gate first, so a caller who may not export learns
   * nothing from the version id; then the reads and the build, outside any
   * transaction; then, only on success, the one audit row, in a short
   * transaction of its own.
   */
  async export(caller: InstructorCaller, projectId: string, versionId: string): Promise<ExportResult> {
    const manager = this.dataSource.manager;
    const project = await this.ownedProject(manager, caller, projectId);
    const version = UUID_PATTERN.test(versionId)
      ? await manager.findOne(ProjectVersionEntity, { where: { id: versionId, projectId: project.id } })
      : null;
    if (!version) throw new NotFoundException(EXPORT_REFUSALS.noVersion);
    const compiled = version.compiled;
    if (!compiled) throw new ConflictException(EXPORT_REFUSALS.noSnapshot(project.title, version.version));
    const content = compiled.content;

    // A draft whose last edit failed validation may be exported: export is a
    // read of the draft, and the re-upload validates it again. The only
    // refusals are the archive's own. When that edit also failed the compile,
    // the stored task list is the last one that compiled, so the draft's task
    // rows are read instead: an edit stored after it is carried, or refused by
    // the read-back's drift, never exported as the older task in silence.
    const rowsSay = lastCompileFailed(version) ? await this.taskRowsByPhase(manager, version) : null;

    // Each phase's work task and the quizzes beside it: the layout's grain.
    const tasksOf = new Map<string, PhaseTasks>();
    const heldTasks: CompiledPhaseTasks[] = [];
    for (const phase of content.phases) {
      const compiledTasks = compiled.phases.find((one) => one.key === phase.key)?.tasks ?? [];
      const rows = rowsSay?.get(phase.key);
      const tasks = rows !== undefined ? tasksAsTheRowsSayThem(phase, compiledTasks, rows) : compiledTasks.length ? compiledTasks : [soleTaskFor(phase)];
      const work = tasks.filter((task) => !isQuizTask(task));
      // A phase folder holds its work task, so a phase of quizzes alone has none to write
      if (work.length === 0) throw new ConflictException(EXPORT_REFUSALS.noWorkTask(phase.title));
      // A phase holding a second work task writes its first: the read-back's drift refuses it by name.
      tasksOf.set(phase.key, { work: work[0], quizzes: tasks.filter((task) => isQuizTask(task)) });
      heldTasks.push({ key: phase.key, tasks });
    }

    const rows = await this.rowIndex(manager, caller, version);
    const layout = new Layout();
    const written = this.writePack(layout, project, version, content, rows, tasksOf);

    const root = project.slug;
    const count = layout.files.size;
    const limits = zipLimits(this.maxBytes);
    if (count > limits.maxEntries) {
      throw new PayloadTooLargeException(EXPORT_REFUSALS.tooMany(limits.maxEntries));
    }
    if (storedZipSize(root, layout.files) > this.maxBytes) {
      throw new PayloadTooLargeException(EXPORT_REFUSALS.tooLarge(mb(this.maxBytes)));
    }
    const archive = storedZipOf(root, layout.files);
    // Read back with the upload's own reader and limits: what it refuses is
    // refused here, by its own sentence, which names no byte of the archive.
    let entries: ArchiveEntry[];
    try {
      entries = readZip(archive, limits);
    } catch (error) {
      if (error instanceof UploadRefusal) {
        throw new ConflictException(`${EXPORT_REFUSALS.unreadable} ${error.sentence}`);
      }
      throw error;
    }
    const withheld = [...layout.withheld.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // A whole pack is read back the way the upload door reads one, so a
    // layout rule this file restates and the loader changed, or a draft the
    // upload would not take (a secret-shaped file, a run past the microVM
    // ceiling), is a refusal here and not an archive that fails at the next
    // upload. An archive that withholds a file is asked every check that
    // needs no whole archive; the run shapes and the loader wait for the
    // teacher's own files.
    this.uploadReadBack(entries, content, heldTasks, withheld, written);

    const detail = { versionId: version.id, version: version.version, entries: count, withheld: withheld.length };
    await this.dataSource.transaction(async (audit) => {
      // The gate again, inside the write: a project that changed hands while
      // the archive was built leaves no row and no archive.
      await this.ownedProject(audit, caller, project.id);
      await recordAudit(audit, {
        event: EXPORT_AUDIT_EVENT,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: project.id,
        action: version.version,
        reason: null,
        detail,
      });
    });
    this.logger.log({ event: EXPORT_AUDIT_EVENT, actorId: caller.id, projectId: project.id, ...detail });
    return {
      filename: `${project.slug}-${version.version}.zip`,
      archive,
      sha256: createHash('sha256').update(archive).digest('hex'),
      entries: count,
      withheld,
    };
  }

  /**
   * The upload door's pipeline over the finished archive (no write): the
   * caller has already read the entries with the door's reader; this asks the
   * secret scan over every name and byte, the derived layout's manifest and
   * its checks (shape, run shapes, learner limits, runtime, the sealed dot
   * rule), the plain-text pass (`plainSource`), each quiz file through the
   * quiz door's rules and each phase's `task` block through the importer's
   * wall; then, for a whole archive, the loader with its four conversions,
   * the loaded-pack checks, publish's run-shape reading and the import's
   * compile, task blocks and quizzes applied as `importTeacherDraft` applies
   * them, which must give the task list the version holds (`taskListDrift`)
   * and each phase's mounts as the writer wrote them (`mountDrift`).
   * Each refusal is the door's own sentence. Step 6's UTF-8/NUL check, the
   * escape rule and `refuseInterviewOverCaps` are not repeated: every byte
   * here came out of the store. An archive that withholds a file is read
   * with a stand-in at each withheld path (`withStandIns`), so the layout's
   * rules see every sealed folder its phases hold; the run shapes, the loader
   * and the compile wait for the teacher's own files.
   */
  private uploadReadBack(
    entries: ArchiveEntry[],
    held: ProjectContent,
    heldTasks: CompiledPhaseTasks[],
    withheld: readonly SealedRoleView[],
    written: WrittenMounts,
  ): void {
    const refuse = (found: PackRefusal[]): never => {
      throw new ConflictException(`${EXPORT_REFUSALS.unloadable} ${refusalDetail(found)}`);
    };
    // A refusal that is no class the door names: the loader's own words, as the door says them.
    const loaderRefusal = (error: unknown, at: MemoryPackSource): never => {
      if (error instanceof UploadRefusal) return refuse([{ code: error.code, where: 'pack', sentence: error.sentence }]);
      if (error instanceof HttpException) return refuse([{ code: 'NOT_A_PACK', where: 'pack', sentence: taskBlockDetail(error) }]);
      if (!(error instanceof Error) || error.name === 'TypeError' || error.name === 'RangeError') throw error;
      return refuse([{ code: 'PACK_INVALID', where: 'pack', sentence: loaderSentence(error, at) }]);
    };
    const whole = withheld.length === 0;
    const root = packRootOf(entries);
    const archive = new MemoryPackSource(entries, 'export', root);
    const prefix = root ? `${root}/` : '';
    const names = entries.map((entry) => entry.name.slice(prefix.length));
    // The secret scan first, over every name and byte the archive holds.
    const secrets = checkPackFiles(archive, names, { layout: 'folder' });
    if (secrets.length) refuse(secrets);
    const derived = whole ? archive : new MemoryPackSource(withStandIns(entries, root, withheld), 'export', root);
    let manifest: ReturnType<typeof buildPackManifest>;
    try {
      manifest = buildPackManifest(derived);
    } catch (error) {
      return loaderRefusal(error, derived);
    }
    const findings = [
      ...checkUploadShape(manifest, names),
      // A run's shape names its hidden suite, which a withheld archive holds only as a stand-in.
      ...(whole ? checkPackRuns(manifest) : []),
      ...checkRunLimits(manifest),
      ...checkRuntimeProfile(manifest),
      ...checkSealedPaths(manifest),
    ];
    if (findings.length) refuse(findings);
    // Every teacher text as the door stores it, refused in the door's shapes.
    let plain: MemoryPackSource;
    try {
      plain = plainSource(derived).source;
    } catch (error) {
      if (!(error instanceof PlainTextRefusal)) throw error;
      const at = plainPath(error.at);
      const said =
        error.shape === 'quiz' ? LAYOUT_SENTENCES.notAQuiz(at, error.sentence)
          : error.shape === 'block' ? `${at}'s phase.json task block: ${error.sentence}`
            : `${at}: ${error.sentence}`;
      return refuse([{ code: 'PACK_INVALID', where: 'pack', sentence: said }]);
    }
    // Each quiz file through the quiz door's rules, and each task block through the import's wall.
    let quizzes: Map<PhaseKey, QuizRowInput[]>;
    let blocks: Map<string, { where: string; block: PhaseTaskBlock }>;
    try {
      quizzes = quizRowsOf(plain);
      blocks = phaseTaskBlocksOf(plain);
    } catch (error) {
      if (error instanceof QuizFileRefusal) return refuse([{ code: 'PACK_INVALID', where: 'quizzes', sentence: error.message }]);
      return loaderRefusal(error, plain);
    }
    if (!whole) return;
    let loaded: ProjectContent;
    try {
      loaded = this.content.loadProject(plain, { convertLegacyRequirements: true, convertLegacyDesign: true, convertLegacyRunbook: true, convertLegacyChange: true, origin: 'upload' });
    } catch (error) {
      // The loader's sentence as the upload door says it (`loaderSentence`):
      // no JSON.parse excerpt, no byte of a file, no source label, at most
      // UPLOAD_REFUSAL_DETAIL_MAX characters.
      return loaderRefusal(error, plain);
    }
    const after = checkLoadedPack(loaded);
    if (after.length) refuse(after);
    // The upload door's post-loader run-shape rule
    // (publish's reading of the loaded pack: a shipped script
    // is a file some phase mounts locked and no phase mounts editable), so an
    // archive the upload refuses with ARGV_SCRIPT is refused here instead.
    const published = checkPackRuns(rawPackManifestOf(loaded));
    if (published.length) refuse(published);
    // The import compiles what it loads (`importTeacherDraft`), and the
    // re-upload must come back as the same task list. A compile refusal is a
    // defect of this file's layout, never a teacher's, and says so.
    let snapshot: CompiledSnapshot;
    try {
      snapshot = compilePack(loaded);
    } catch (error) {
      if (!(error instanceof Error) || error.name === 'TypeError' || error.name === 'RangeError') throw error;
      return refuse([{ code: 'PACK_INVALID', where: 'pack', sentence: EXPORT_REFUSALS.taskDrift(loaded.phases[0]?.title ?? 'a phase') }]);
    }
    // The blocks and the quizzes applied as the import applies them, so the
    // task list compared is the one the re-upload stores.
    let back: CompiledPhaseTasks[] | null;
    try {
      back = asImported(snapshot, blocks, quizzes);
    } catch (error) {
      if (error instanceof HttpException) return refuse([{ code: 'NOT_A_PACK', where: 'pack', sentence: taskBlockDetail(error) }]);
      throw error;
    }
    if (back === null) {
      const first = loaded.phases.find((phase) => blocks.has(phase.key) || (quizzes.get(phase.key)?.length ?? 0) > 0);
      return refuse([{ code: 'PACK_INVALID', where: 'pack', sentence: EXPORT_REFUSALS.taskDrift(first?.title ?? 'a phase') }]);
    }
    const drift = taskListDrift(held, heldTasks, loaded, back) ?? mountDrift(held, written, loaded);
    if (drift !== null) refuse([{ code: 'PACK_INVALID', where: 'pack', sentence: EXPORT_REFUSALS.taskDrift(drift) }]);
  }

  /**
   * The draft's task rows by phase key, in order (only asked of a
   * version whose last compile failed). A phase with no row maps to [] (it
   * exports as its sole task), never left out: the caller's zero-row branch
   * (`soleTaskFor`) reads that [].
   */
  private async taskRowsByPhase(manager: EntityManager, version: ProjectVersionEntity): Promise<Map<string, ProjectTaskEntity[]>> {
    const phases = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: version.id } });
    const rows = phases.length ? await manager.find(ProjectTaskEntity, { where: { projectPhaseId: In(phases.map((phase) => phase.id)) } }) : [];
    const out = new Map<string, ProjectTaskEntity[]>();
    for (const phase of phases) {
      out.set(phase.key, rows.filter((row) => row.projectPhaseId === phase.id).sort((a, b) => a.order - b.order));
    }
    return out;
  }

  /* ------------------------------- the gate ------------------------------- */

  /**
   * `SealedRoleService`'s gate, restated (its `target` is private): a project
   * the caller cannot see is 404; one they can see and do not own (an ADMIN,
   * or the platform's own) is 403.
   */
  private async ownedProject(manager: EntityManager, caller: InstructorCaller, projectId: string): Promise<ProjectEntity> {
    const project = UUID_PATTERN.test(projectId) ? await manager.findOne(ProjectEntity, { where: { id: projectId } }) : null;
    const visible = project && (caller.role === 'ADMIN' || project.platformOwned || project.ownerUserId === caller.id);
    if (!project || !visible) throw new NotFoundException(EXPORT_REFUSALS.notFound);
    if (project.platformOwned) throw new ForbiddenException(EXPORT_REFUSALS.platform(project.title));
    if (project.ownerUserId !== caller.id) throw new ForbiddenException(EXPORT_REFUSALS.notYours);
    return project;
  }

  /* -------------------------------- the rows ------------------------------ */

  /**
   * This version's rows, which of its sealed rows came with a copy, and the
   * bytes of every row that did not. An inherited row's blob is never read:
   * its view takes the row's own sha and the blob's stored size.
   */
  private async rowIndex(manager: EntityManager, caller: InstructorCaller, version: ProjectVersionEntity): Promise<RowIndex> {
    const phases = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: version.id } });
    const keyOf = new Map(phases.map((phase) => [phase.id, phase.key as string]));
    const files = await manager.find(ProjectFileEntity, { where: { projectVersionId: version.id } });

    const byPhase = new Map<string, Map<string, ProjectFileEntity>>();
    const byProject = new Map<string, ProjectFileEntity>();
    const inherited = new Set<string>();
    // A version whose copy chain never leaves the caller's own projects holds
    // no inherited row (every arm of `inheritedSealedRow` answers false), so
    // the per-row walk is asked only of a version that has such a chain.
    const foreign = await this.foreignAncestry(manager, caller, version);
    for (const row of files) {
      if (row.ownerKind === 'project') {
        byProject.set(row.path, row);
        continue;
      }
      const key = keyOf.get(row.ownerId);
      if (key === undefined) continue;
      const held = byPhase.get(key) ?? new Map<string, ProjectFileEntity>();
      held.set(row.path, row);
      byPhase.set(key, held);
      if (foreign && isSealedFileRole(row.role) && (await inheritedSealedRow(manager, caller.id, version, key as PhaseKey, row))) {
        inherited.add(row.id);
      }
    }

    const readable = [...new Set(files.filter((row) => !inherited.has(row.id)).map((row) => row.blobSha))];
    const withheldShas = [...new Set(files.filter((row) => inherited.has(row.id)).map((row) => row.blobSha))];
    const bytes = new Map<string, string>();
    for (let at = 0; at < readable.length; at += BLOB_READ_CHUNK) {
      const blobs = await manager.find(ContentBlobEntity, { where: { sha: In(readable.slice(at, at + BLOB_READ_CHUNK)) }, select: { sha: true, bytes: true } });
      for (const blob of blobs) bytes.set(blob.sha, blob.bytes);
    }
    const sizes = new Map<string, number>();
    for (let at = 0; at < withheldShas.length; at += BLOB_READ_CHUNK) {
      const blobs = await manager.find(ContentBlobEntity, { where: { sha: In(withheldShas.slice(at, at + BLOB_READ_CHUNK)) }, select: { sha: true, size: true } });
      for (const blob of blobs) sizes.set(blob.sha, blob.size);
    }
    return { byPhase, byProject, inherited, bytes, sizes, foreign };
  }

  /** Whether the version's copy chain reaches a project the caller does not own (a broken chain is foreign). */
  private async foreignAncestry(manager: EntityManager, caller: InstructorCaller, version: ProjectVersionEntity): Promise<boolean> {
    let parentId = version.forkedFromVersionId;
    for (let hop = 0; hop < ANCESTRY_MAX_HOPS; hop++) {
      if (!parentId) return false;
      const parent = await manager.findOne(ProjectVersionEntity, {
        where: { id: parentId },
        select: { id: true, projectId: true, forkedFromVersionId: true },
      });
      if (!parent) return true;
      const owner = await manager.findOne(ProjectEntity, { where: { id: parent.projectId } });
      if (!owner || owner.platformOwned || owner.ownerUserId !== caller.id) return true;
      parentId = parent.forkedFromVersionId;
    }
    return true;
  }

  /* -------------------------------- the pack ------------------------------ */

  /** The pack into `layout`; answers each phase's workspace bytes as written, for the read-back's mount compare. */
  private writePack(
    layout: Layout,
    project: ProjectEntity,
    version: ProjectVersionEntity,
    content: ProjectContent,
    rows: RowIndex,
    tasksOf: ReadonlyMap<string, PhaseTasks>,
  ): WrittenMounts {
    const phases = [...content.phases].sort((a, b) => a.order - b.order);

    // Workspace bytes are the rows' (the snapshot's when a row is missing).
    const workspace = new Map<string, Map<string, string>>();
    // Every mount by path and bytes: a smoke file a phase also mounts is no reference material.
    const mounted = new Set<string>();
    for (const phase of phases) {
      const held = rows.byPhase.get(phase.key);
      const out = new Map<string, string>();
      for (const file of phase.files) {
        const row = held?.get(file.path);
        const fromRow = row && row.role === 'workspace' ? rows.bytes.get(row.blobSha) : undefined;
        const bytes = fromRow ?? file.content;
        out.set(file.path, bytes);
        mounted.add(`${file.path}\n${blobShaFor(bytes)}`);
      }
      workspace.set(phase.key, out);
    }
    // One folder per phase, numbered by its place in this version.
    phases.forEach((phase, at) => {
      this.writePhase(layout, phase, `phases/${phaseFolderName(at + 1, phase.key)}`, rows, workspace.get(phase.key)!, mounted, tasksOf.get(phase.key)!);
    });

    // No phase list (the folders are the list) and no warm-up: an upload never
    // carries one (PACK_WARMUP_NOT_UPLOADABLE), so a version that holds one (a
    // copy of a project that has one) exports without it, and its archive can
    // come back in. No warmup/ folder and no warmup key.
    const meta: Record<string, unknown> = {
      slug: project.slug,
      version: version.version,
      title: project.title,
      tagline: content.tagline,
      description: content.description,
      language: content.language,
      languages: content.languages,
    };
    if (content.build) meta.build = content.build;
    if (content.runtime) meta.runtime = content.runtime;
    if (content.preview) meta.preview = content.preview;
    layout.json('project.json', meta);
    return workspace;
  }

  private writePhase(
    layout: Layout,
    phase: PhaseContent,
    dir: string,
    rows: RowIndex,
    bytesOf: Map<string, string>,
    mounted: Set<string>,
    { work, quizzes }: PhaseTasks,
  ): void {
    const held = rows.byPhase.get(phase.key) ?? new Map<string, ProjectFileEntity>();

    /**
     * A sealed file by its row: the row's bytes, or the view (inherited, or no
     * row: fail closed). `rowPaths` are asked in order (a run's own row first,
     * the run-keyed `sealedRunRowPath`, then the bare path), and
     * the first that holds this place's bytes answers, so two runs holding one
     * path each answer by their own row, never by the last one written.
     */
    const sealed = (rowPaths: string | readonly string[], role: ProjectFileRole, at: string, snapshotBytes: string): Resolved => {
      const sha = blobShaFor(snapshotBytes);
      const candidates = (typeof rowPaths === 'string' ? [rowPaths] : rowPaths)
        .map((rowPath) => held.get(rowPath))
        .filter((row): row is ProjectFileEntity => Boolean(row) && row!.role === role);
      const holds = (row: ProjectFileEntity): boolean =>
        row.blobSha === sha || (snapshotBytes === INHERITED_PLACE && rows.inherited.has(row.id));
      const own = candidates.find(holds) ?? candidates[0];
      if (own && rows.inherited.has(own.id)) {
        // The row's view when it holds this place's bytes (or the place came
        // from the overlay, which never reads an inherited blob); otherwise
        // the bytes this place holds, which the row does not.
        return own.blobSha === sha || snapshotBytes === INHERITED_PLACE
          ? { view: { path: at, sha256: own.blobSha, bytes: rows.sizes.get(own.blobSha) ?? 0 } }
          : { view: sealedViewOf(at, snapshotBytes) };
      }
      // The row's own bytes when they are the bytes this place holds.
      if (own && own.blobSha === sha && rows.bytes.has(own.blobSha)) {
        return { bytes: rows.bytes.get(own.blobSha) as string };
      }
      // No row, or a row holding other bytes (two runs, one hidden path): the
      // version's own snapshot, only where its chain never left the caller's
      // own projects; otherwise fail closed.
      return rows.foreign ? { view: sealedViewOf(at, snapshotBytes) } : { bytes: snapshotBytes };
    };
    /** Reference material with no row: open when some phase mounts it, else the owner's only without a foreign ancestry. */
    const unrowed = (at: string, file: string, bytes: string): Resolved =>
      mounted.has(`${file}\n${blobShaFor(bytes)}`) || !rows.foreign ? { bytes } : { view: sealedViewOf(at, bytes) };
    const refuseUnless = (ok: boolean, at: string): void => {
      if (!ok) throw new ConflictException(EXPORT_REFUSALS.path(phase.title, at));
    };

    // The work task's checks as the editor last saved them (`checksOf`: its own slice, else the phase's).
    const checks = checksOf(phase, work);

    // The workspace: every mount at its workspace path, under files/ or
    // readonly/, but a record the loader seeds again: an untouched
    // story record, an untouched design record or contract that is on, an
    // empty runbook or change request, wherever it is mounted, since the
    // loader sorts every mount by path once it has seeded.
    const story = checks.kind === 'story' ? checks : null;
    const design = checks.kind === 'design' ? checks : null;
    const record = checks.kind === 'config' && checks.runbook ? { path: checks.runbook.record, seed: serialiseRunbook(EMPTY_RUNBOOK) }
      : checks.kind === 'code' && checks.change ? { path: checks.change.record, seed: serialiseChangeRequest(EMPTY_CHANGE_REQUEST) } : null;
    const seededAgain = (at: string, bytes: string): boolean =>
      story ? at === story.record && bytes === seededStoryRecord(story)
        : design ? designDocumentPaths(design.contracts).includes(at) && bytes === seededDesignDocument(at)
          : record ? at === record.path && bytes === record.seed : false;
    for (const file of phase.files) {
      const bytes = bytesOf.get(file.path) as string;
      if (seededAgain(file.path, bytes)) continue;
      refuseUnless(layoutCarries(file.path, false), file.path);
      layout.put(`${dir}/${file.editable ? 'files' : 'readonly'}/${file.path}`, bytes);
    }

    // phase.json, from the work task: its brief as the phase's
    // taskPanel, its objectives, its rubric and its checks, every text plain;
    // no key or order (the folder says both) and no file, folder or
    // source names.
    const spec: Record<string, unknown> = {
      title: phase.title,
      intro: asStored(phase.intro),
      artifactKind: phase.artifactKind,
      canRun: phase.canRun,
      runLabel: phase.runLabel,
      canPreview: phase.canPreview,
      taskPanel: asStored(work.brief),
      objectives: work.objectives.map(asStored),
      rubric: plainRubric(work.rubric),
      checks: this.checksFor(layout, phase, checks, rows, held, dir, sealed, unrowed, refuseUnless, bytesOf),
      assistant: phase.assistant,
    };
    // The task block only for what the phase's own members cannot say: a
    // title that differs from the phase's, and the sign-off mark. An
    // untouched phase writes none.
    const block: Record<string, unknown> = {};
    if (work.title !== phase.title) block.title = asStored(work.title);
    if (work.signOff === true) block.signOff = true;
    if (Object.keys(block).length) spec.task = block;
    if (phase.interview) {
      layout.place(sealed(INTERVIEW_ROW_PATH, 'interview', `${dir}/interview.json`, canonicalJson(phase.interview)), `${dir}/interview.json`);
    }
    layout.json(`${dir}/phase.json`, spec);

    // Each quiz beside the work task, as the file the upload's quiz door reads, every text plain.
    for (const quiz of quizzes) {
      const paper = checksOf(phase, quiz) as QuizChecks;
      layout.json(`${dir}/quizzes/${quiz.taskKey}.json`, {
        title: asStored(quiz.title),
        brief: asStored(quiz.brief),
        order: quiz.order,
        objectives: quiz.objectives.map(asStored),
        required: quiz.required,
        // converted here without refusing (`paperAsStored`); an option or a concept stored before texts were kept plain that converts to
        // nothing is written as it is, and the read-back's plainSource refuses it in the door's own sentence (409)
        checks: paperAsStored(paper),
      });
    }
  }

  /** `phase.json`'s `checks`, pointer-free, writing every file each folder of the kind holds. */
  private checksFor(
    layout: Layout,
    phase: PhaseContent,
    checks: PhaseChecks,
    rows: RowIndex,
    held: Map<string, ProjectFileEntity>,
    dir: string,
    sealed: (rowPaths: string | readonly string[], role: ProjectFileRole, at: string, snapshotBytes: string) => Resolved,
    unrowed: (at: string, file: string, bytes: string) => Resolved,
    refuseUnless: (ok: boolean, at: string) => void,
    bytesOf: Map<string, string>,
  ): Record<string, unknown> {
    if (isOlderWritten(checks)) {
      // an older Requirements or Design still exports as it was written (its upload converts it); a retired key does not
      if (phase.key !== 'requirements' && phase.key !== 'design') throw new ConflictException(retiredWrittenPhaseAssignRefusal(phase.title));
      return JSON.parse(JSON.stringify(checks)) as Record<string, unknown>;
    }
    if (checks.kind === 'story' || checks.kind === 'design') return JSON.parse(JSON.stringify(plainChecks(checks))) as Record<string, unknown>;
    if (checks.kind === 'config') return this.configChecks(layout, checks, dir, sealed, unrowed, refuseUnless);
    if (checks.kind !== 'code' && checks.kind !== 'tests') throw new ConflictException(EXPORT_REFUSALS.kind(phase.title));

    // A sealed file the owner wrote through the sealed-role door after the last compile
    // is in the rows and not yet in the snapshot: put where the compile will
    // put it (`draft.ts`, the editor's own overlay), so the export is the draft.
    const changed = sealedRowsToOverlay([...held.values()], checks) as ProjectFileEntity[];
    const slice = changed.length
      ? overlaySealedRows(
          checks,
          // An inherited row's blob is never read: its place is kept with no
          // bytes, and `sealed` answers it by its view.
          changed.map((row) => {
            if (rows.inherited.has(row.id)) return { role: row.role, path: row.path, bytes: INHERITED_PLACE };
            const bytes = rows.bytes.get(row.blobSha);
            if (bytes === undefined) throw new ConflictException(EXPORT_REFUSALS.missing(phase.title));
            return { role: row.role, path: row.path, bytes };
          }),
        )
      : checks;
    // A tests run has no hidden suite, and the upload's run rule reads a
    // declared `hiddenHarness` as one: it is written only where it is not the
    // loader's default, so the run reads back as the same run.
    const runHeader = (run: PhaseRun, hidden: boolean): Record<string, unknown> => ({
      id: run.id,
      language: run.language,
      harness: run.harness,
      ...(hidden || run.hiddenHarness !== defaultHarness(run.language) ? { hiddenHarness: run.hiddenHarness } : {}),
      label: run.label,
      transform: run.transform,
    });

    if (slice.kind === 'code') {
      const code = slice as CodeChecks;
      if (code.runs.length === 0) throw new ConflictException(EXPORT_REFUSALS.kind(phase.title));
      for (const run of code.runs) {
        // A declared run names a visible test (the loader), and every run is
        // written declared: the flat shape is no run shape the upload accepts.
        if (run.visibleTests.length === 0) throw new ConflictException(EXPORT_REFUSALS.run(phase.title, run.id));
        for (const [at, bytes] of Object.entries(run.hiddenTestFiles)) {
          const into = `${dir}/hidden_tests/${run.id}/${at}`;
          // This run's own row first, then the bare path.
          const resolved = sealed(runRowPaths(`hidden/${at}`, [run.id]), 'hidden', into, bytes);
          // a hidden test sits at the path it runs from, in a folder
          if ('bytes' in resolved) refuseUnless(layoutCarries(at, true) && at.includes('/'), at);
          layout.place(resolved, into);
        }
      }
      for (const [at, bytes] of Object.entries(code.solutionFiles)) {
        const into = `${dir}/solution/${at}`;
        const resolved = sealed(`solution/${at}`, 'solution', into, bytes);
        // a solution file completes a file the learner edits, at its path
        if ('bytes' in resolved) refuseUnless(layoutCarries(at, true) && code.editableTargets.includes(at), at);
        layout.place(resolved, into);
      }
      const ticketed = code.change && code.ticket ? (plainChecks(code) as CodeChecks) : null;
      return {
        kind: 'code',
        editableTargets: code.editableTargets,
        runs: code.runs.map((run) => ({
          ...runHeader(run, true),
          visibleTests: run.visibleTests,
          supportFiles: Object.keys(run.supportFiles),
          // Only entries the loader takes back (none at all is its default: the run's own files).
          ...declaredTestPaths(run.testPaths, Object.keys(run.hiddenTestFiles)),
        })),
        ...(ticketed ? { ticket: ticketed.ticket, change: { record: code.change!.record, contract: code.change!.contract, floor: code.change!.floor } } : {}),
      };
    }

    const tests = slice as TestsChecks;
    if (tests.runs.length === 0) throw new ConflictException(EXPORT_REFUSALS.kind(phase.title));
    for (const run of tests.runs) {
      if (run.learnerTestFiles.length === 0 || Object.keys(run.implFiles).length === 0) {
        throw new ConflictException(EXPORT_REFUSALS.run(phase.title, run.id));
      }
      // The layout holds a tests phase's suite and implementation once, and the
      // loader hands every run the phase's bytes at its paths: a run whose own
      // row holds other bytes at a path would be graded by the phase's
      // on the way back in, so it is refused by name, never exported changed.
      for (const field of ['referenceTestFiles', 'implFiles'] as const) {
        for (const [at, bytes] of Object.entries(run[field] ?? {})) {
          if (tests[field][at] !== undefined && tests[field][at] !== bytes) {
            throw new ConflictException(EXPORT_REFUSALS.runBytes(phase.title, run.id, at));
          }
        }
      }
    }
    const runIds = tests.runs.map((run) => run.id);
    for (const [at, bytes] of Object.entries(tests.referenceTestFiles)) {
      const into = `${dir}/reference/${at}`;
      const resolved = sealed(runRowPaths(`reference/${at}`, runIds, true), 'reference', into, bytes);
      if ('bytes' in resolved) refuseUnless(layoutCarries(at, true), at);
      layout.place(resolved, into);
    }
    for (const [at, bytes] of Object.entries(tests.implFiles)) {
      const into = `${dir}/impl/${at}`;
      const resolved = sealed(runRowPaths(`reference/${at}`, runIds, true), 'reference', into, bytes);
      if ('bytes' in resolved) refuseUnless(layoutCarries(at, true), at);
      layout.place(resolved, into);
    }
    // A support file is a read-only mount, read from the mount's bytes:
    // one the phase does not mount locked with these bytes cannot be carried.
    for (const [at, bytes] of Object.entries(tests.supportFiles)) {
      refuseUnless(phase.files.some((file) => file.path === at && !file.editable) && bytesOf.get(at) === bytes, at);
    }
    for (const mutant of tests.mutants) {
      const run = tests.runs.find((one) => one.id === mutant.run);
      refuseUnless(Boolean(run) && layoutCarries(mutant.name, true) && !mutant.name.includes('/'), `mutants/${mutant.name}`);
      // A mutant goes whole or not at all: one withheld file keeps every file
      // and the meta out, since the loader reads a mutant folder as a unit.
      const resolved = Object.entries(mutant.files).map(([at, bytes]) => {
        const into = `${dir}/mutants/${mutant.name}/${at}`;
        return { at, into, bytes, resolved: sealed(`mutants/${mutant.name}/${at}`, 'mutant', into, bytes) };
      });
      const whole = resolved.every((one) => 'bytes' in one.resolved);
      for (const one of resolved) {
        if (!whole) {
          layout.withhold('view' in one.resolved ? one.resolved.view : sealedViewOf(one.into, one.bytes));
          continue;
        }
        refuseUnless(layoutCarries(one.at, true) && one.at !== 'meta.json', `mutants/${mutant.name}/${one.at}`);
        layout.place(one.resolved, one.into);
      }
      if (whole) {
        const meta: Record<string, unknown> = { name: mutant.name, description: mutant.description };
        if (mutant.covers) meta.covers = mutant.covers;
        meta.run = mutant.run;
        layout.json(`${dir}/mutants/${mutant.name}/meta.json`, meta);
      }
    }
    return {
      kind: 'tests',
      learnerTestFiles: tests.learnerTestFiles,
      supportFiles: Object.keys(tests.supportFiles),
      runs: tests.runs.map((run) => ({
        ...runHeader(run, false),
        learnerTestFiles: run.learnerTestFiles,
        implFiles: Object.keys(run.implFiles),
        supportFiles: Object.keys(run.supportFiles),
        ...declaredTestPaths(run.testPaths, run.learnerTestFiles),
      })),
      coverageKeywords: tests.coverageKeywords,
      minTests: tests.minTests,
    };
  }

  private configChecks(
    layout: Layout,
    checks: ConfigChecks,
    dir: string,
    sealed: (rowPaths: string | readonly string[], role: ProjectFileRole, at: string, snapshotBytes: string) => Resolved,
    unrowed: (at: string, file: string, bytes: string) => Resolved,
    refuseUnless: (ok: boolean, at: string) => void,
  ): Record<string, unknown> {
    // Every file the smoke run builds from, under smoke/ at its path (not sealed).

    for (const [at, bytes] of Object.entries(checks.smokeImplFiles)) {
      const into = `${dir}/smoke/${at}`;
      const resolved = unrowed(into, at, bytes);
      if ('bytes' in resolved) refuseUnless(layoutCarries(at, false), at);
      layout.place(resolved, into);
    }
    const out: Record<string, unknown> = {
      kind: 'config',
      rules: checks.rules,
      smoke: {
        dockerfile: checks.smokeDockerfile,
        commands: checks.smokeCommands,
        expect: checks.expectInOutput,
      },
      ...(checks.runbook ? { runbook: { record: checks.runbook.record, floor: checks.runbook.floor } } : {}),
    };
    if (checks.drill) {
      for (const [at, bytes] of Object.entries(checks.drill.faultedFiles)) {
        const into = `${dir}/drill/${at}`;
        const resolved = sealed(`drill/${at}`, 'drill', into, bytes);
        if ('bytes' in resolved) refuseUnless(layoutCarries(at, true), at);
        layout.place(resolved, into);
      }
      out.drill = {
        fault: checks.drill.fault,
        description: checks.drill.description,
        expectFailure: checks.drill.expectFailure,
      };
    }
    return out;
  }
}
