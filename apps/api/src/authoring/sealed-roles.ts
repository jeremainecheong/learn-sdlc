import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  draftOnlyRefusal,
  isSealedFileRole,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
  REPLACE_FILE_CONTENT_MAX,
  SEALED_ROLE_KINDS,
} from '@learnsdlc/shared';
import type {
  PhaseKey,
  ProjectFileRole,
  SealedFileOwnerRead,
  SealedFileView,
  SealedRoleKind,
} from '@learnsdlc/shared';
import { blobShaFor } from '../content/blob.store';
import type { CodeChecks, PhaseChecks, TestsChecks } from '../content/content.types';
import { LEARNER_FACING_FILE_ROLES, ProjectImporterService } from '../content/importer.service';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import { AuditEventEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
import { RUN_PATH_MAX, languagesOfPath } from './draft';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { overlaySealedRows, sealedRowRunOf, sealedRunRowPath } from './draft';
// the doors' shared leaf rules
import { isHiddenTestName, strictText } from './door-rules';
import { UUID_PATTERN } from '../db/uuid';

/**
 * The write-only store for an executable task's sealed
 * files: its hidden suite, its reference solution and its mutants.
 *
 * **One door in, one door out.** A sealed file is written through `write`,
 * which answers `{ path, sha256, bytes }` and nothing else, and read back only
 * through `readOwnerOnly`: the project's owner, never an ADMIN (403), never
 * another teacher (404, which says nothing about whether the project exists),
 * and one `project.sealed-read` audit row on every read: `readQuizKey`'s
 * shape and its reason, because a hidden suite or a reference solution *is*
 * the passing answer. A mutant is written and never read back, the owner
 * included: the store refuses to reveal one whatever the editor does.
 *
 * **Stored as the importer stores a pack.** One `project_files` row per file,
 * owned by the phase, locked, under the role's own directory (`hidden/`,
 * `solution/`, `reference/`, `mutants/<name>/`: `SEALED_ROW_DIRECTORY`), with
 * its bytes in `content_blobs` keyed by `blobShaFor`. Every row goes through
 * `ProjectImporterService.insertFiles`, the single entry point for a file row,
 * so the importer's two byte rules are asked of the version as it will be: a
 * hidden test whose bytes a learner already reads is refused, and so is an
 * answer whose bytes sit in a file the learner is asked to write.
 *
 * **Which row a role is, by the task's kind** (the importer's own layout):
 *
 * | task kind | `hidden`                         | `solution`                     | `mutant`                          |
 * |-----------|----------------------------------|--------------------------------|-----------------------------------|
 * | `code`    | `hidden` at `hidden/<path>`       | `solution` at `solution/<path>` | refused (a code task has none)     |
 * | `tests`   | `reference` at `reference/<path>` (the reference suite) | `reference` at `reference/<path>` (the implementation it grades against) | `mutant` at `mutants/<name>/<file>`, the path written `<name>/<file>` |
 *
 * A tests task's suite and implementation share `reference/`, so the store
 * itself does not record which a row is; the door makes the declared role
 * the one the compile will read (`sealedPlacement`), and refuses the write
 * otherwise. The run is likewise the overlay's, never a guess that differs.
 *
 * This file writes rows. Deriving a task's compiled `checks` from them
 * (`hiddenTestFiles`, `solutionFiles`, `solutionSources`, mutants) is
 * `draft.ts`'s job, and `authoring.controller.ts` mounts `sealed.write` /
 * `sealed.read`.
 *
 * `stripSealed` is the pure half: any payload, any depth, with every sealed
 * byte replaced by its view.
 */

/* ------------------------------ the contract ------------------------------ */
// The contract's shared names (packages/shared/src/upload-contract.ts), one definition each.

// Two aliases name the shared views as this file's callers read them.

/** A sealed file as every view carries it: a path, a digest (sha256 of the UTF-8 bytes) and a size. Never its bytes. */
export type SealedRoleView = SealedFileView;
/** `readOwnerOnly`'s answer: the view, the run that grades the file, and the bytes, base64. */
export type SealedRoleOwnerRead = SealedFileOwnerRead;

/** The audit name of the owner's read (a member of the contract's `AUDIT_EVENTS`). */
export const SEALED_READ_AUDIT_EVENT = 'project.sealed-read' as const;
/** The audit name of a write: `AUTHORING_ROUTES['sealed.write'].audit`. */
export const SEALED_WRITE_AUDIT_EVENT = 'project.files' as const;

/** The characters one sealed file may hold: the `files.replace` cap. */
export const SEALED_FILE_MAX_CHARS = REPLACE_FILE_CONTENT_MAX;
/** The characters a sealed file's path may hold, the role's directory not counted: a run's path cap. */
export const SEALED_PATH_MAX = RUN_PATH_MAX;

/* --------------------------------- sentences ------------------------------ */
// Fixed strings: none echoes a byte, and none echoes a path the caller could
// not already see (a refused path is never repeated back).

export const SEALED_REFUSALS = Object.freeze({
  role: 'A sealed file is a hidden test, the reference solution or a mutant; that is not one of them.',
  notExecutable:
    "Only a phase's executable task holds sealed files: a code task's hidden suite and reference solution, or a tests task's reference suite, implementation and mutants.",
  codeMutant: 'A code task has no mutants. Mutants belong to a tests task, which grades a learner’s own suite by whether it kills them.',
  path:
    'A sealed file’s path is relative, uses forward slashes, and names folders and a file with letters, digits, dots, dashes and underscores; no part may start with a dot or be "..".',
  mutantPath: 'A mutant’s path starts with the mutant’s own name, then the file it overlays: <name>/<path>.',
  empty: 'A sealed file cannot be empty.',
  tooLong: `A sealed file is at most ${REPLACE_FILE_CONTENT_MAX} characters.`,
  nul: 'A sealed file is text, and text holds no NUL character.',
  base64: 'A sealed file arrives as base64 of UTF-8 text, and this is not that.',
  roleClash: 'That path in this phase is already a file of another kind, and a file’s role never changes.',
  testsRole:
    'In a tests task the reference suite is its test files (test_*.py, *_test.py, *.test.ts, *.spec.ts and the like) and the implementation is every other file; this path reads as the other one.',
  solutionTarget:
    "A code task's reference solution completes one of the files the learner is asked to write, and that path is not one of them.",
  mounted:
    'A hidden test cannot sit at a path the phase already gives the learner: in the graded run it would replace the learner’s file.',
  run: 'That is not the run this file is graded in. A hidden test or a tests task’s implementation names the run that grades it; a code task’s solution names none.',
  mutantRead:
    'A mutant is written and never read back, by anyone: what it changes is the test a learner’s suite has to pass, so it stays sealed.',
  noFile: 'This task holds no sealed file of that kind at that path.',
  inherited:
    'That sealed file came with the project you copied, and it stays sealed for you as it is for every learner. Write your own and you can read it back.',
  // A code task's hidden file is a test file by its name
  // (`isHiddenTestName`), because publish asks the same rule and no door
  // removes a sealed row. There are no hidden helper files.
  hiddenName:
    'A hidden test is a test file the runner executes by its name: test_<name>.py in a Python run, or <name>.test.ts or <name>.test.tsx in a TypeScript run. A hidden suite holds no helper files.',
});

/** The most copies a version's ancestry is walked up before the answer is "inherited" (fail closed). */
export const ANCESTRY_MAX_HOPS = 64;

/**
 * Whether the owner wrote this row through this door in this version: the
 * door's own audit row (`project.files`, action `<phase>:sealed`) names the
 * version and the row's path. A row the owner wrote is theirs to read whatever
 * its bytes are, which is what keeps the read from being an oracle: a right
 * guess of an inherited file, written back, answers as a wrong one does.
 */
async function sealWroteRow(
  manager: EntityManager,
  actorId: string,
  version: Pick<ProjectVersionEntity, 'id' | 'projectId'>,
  phaseKey: PhaseKey,
  rowPath: string,
): Promise<boolean> {
  const written = await manager.find(AuditEventEntity, {
    where: { actorUserId: actorId, event: SEALED_WRITE_AUDIT_EVENT, targetId: version.projectId, action: `${phaseKey}:sealed` },
    select: { id: true, detail: true },
  });
  return written.some((one) => one.detail?.versionId === version.id && one.detail?.rowPath === rowPath);
}

/**
 * Whether one sealed row of the caller's version came to it by copying from a
 * project the caller does not own (the platform's, or another teacher's) and
 * not by the owner's own write. Such a row stays sealed for the owner as it is
 * for every learner, so the owner's read (and the owner's export, which should
 * ask the same question) must not reveal it.
 *
 * Asked of **this version's ancestry only** (`forkedFromVersionId`), matched by
 * phase, row path, role and blob, never of the platform's whole blob store,
 * where another teacher's byte-identical file would seal the owner's own and a
 * read would confirm a guess of anyone's hidden suite. Walking up: a row the
 * owner wrote through this door in a version is theirs (stop, not inherited); a
 * parent that does not hold the same row is not where the bytes came from
 * (stop, not inherited); a parent that holds it in a project the caller does
 * not own is the source (inherited); a parent of the caller's own is asked
 * the same question in turn. A broken or over-long chain answers inherited.
 */
export async function inheritedSealedRow(
  manager: EntityManager,
  callerId: string,
  version: Pick<ProjectVersionEntity, 'id' | 'projectId' | 'forkedFromVersionId'>,
  phaseKey: PhaseKey,
  row: Pick<ProjectFileEntity, 'path' | 'role' | 'blobSha'>,
): Promise<boolean> {
  let at = version;
  for (let hop = 0; hop < ANCESTRY_MAX_HOPS; hop++) {
    if (await sealWroteRow(manager, callerId, at, phaseKey, row.path)) return false;
    if (!at.forkedFromVersionId) return false;
    const parent = await manager.findOne(ProjectVersionEntity, {
      where: { id: at.forkedFromVersionId },
      select: { id: true, projectId: true, forkedFromVersionId: true },
    });
    if (!parent) return true;
    const phase = await manager.findOne(ProjectPhaseEntity, {
      where: { projectVersionId: parent.id, key: phaseKey },
      select: { id: true },
    });
    if (!phase) return false;
    // (projectVersionId, blobSha) leads, so IDX_project_files_blob answers it.
    const held = await manager.findOne(ProjectFileEntity, {
      where: { projectVersionId: parent.id, blobSha: row.blobSha, ownerKind: 'phase', ownerId: phase.id, path: row.path, role: row.role },
      select: { id: true },
    });
    if (!held) return false;
    const project = await manager.findOne(ProjectEntity, { where: { id: parent.projectId } });
    if (!project || project.platformOwned || project.ownerUserId !== callerId) return true;
    at = parent;
  }
  return true;
}

/**
 * The draft's version row, locked for the rest of the
 * transaction (PostgreSQL only; TypeORM's pessimistic locks throw on sqlite,
 * whose writers are serialised anyway, so there it answers null and locks
 * nothing).
 *
 * A sealed write changes `project_files` rows and nothing on the version row,
 * so `persist`'s compare-and-swap on `compiled` and `validation` cannot see it.
 * The sealed door takes this lock (`pessimistic_write`) before it touches any
 * row, and `persist` holds the row lock of its own swap and asks the file rows
 * again under it: a sealed write either committed before that question (and
 * persist compiles it) or waits until the version's writer commits (and then
 * meets a published version, 409). The answer is the row as locked, so the
 * door asks "still a draft?" of the row it holds rather than of its first read.
 */
export async function lockVersionRow(
  manager: EntityManager,
  versionId: string,
  mode: 'pessimistic_write' | 'for_no_key_update' = 'pessimistic_write',
): Promise<Pick<ProjectVersionEntity, 'id' | 'status' | 'version'> | null> {
  if (manager.connection.options.type !== 'postgres') return null;
  return manager.findOne(ProjectVersionEntity, {
    where: { id: versionId },
    select: { id: true, status: true, version: true },
    lock: { mode },
  });
}

/* ------------------------------ pure helpers ------------------------------ */

/** The view of one file: never its bytes. */
export function sealedViewOf(path: string, bytes: string): SealedRoleView {
  return { path, sha256: blobShaFor(bytes), bytes: Buffer.byteLength(bytes, 'utf-8') };
}

/** Views of a path -> bytes map, sorted by path. */
export function sealedViewsOf(files: Record<string, string>): SealedRoleView[] {
  return Object.keys(files)
    .sort()
    .map((path) => sealedViewOf(path, files[path]));
}

/**
 * `sealed.write`'s `contentBase64`, decoded: base64 of UTF-8 text, with no NUL.
 * Strict, because a lenient decoder would store bytes the teacher never sent.
 */
export function decodeSealedBase64(contentBase64: unknown): string {
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
    throw new BadRequestException(SEALED_REFUSALS.base64);
  }
  const clean = contentBase64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new BadRequestException(SEALED_REFUSALS.base64);
  }
  const raw = Buffer.from(clean, 'base64');
  // The shared `strictText` (fatal UTF-8, a byte-order mark
  // dropped, U+0000 refused), with this door's own sentences.
  const decoded = strictText(raw);
  if (!decoded.ok) {
    throw new BadRequestException(decoded.why === 'nul' ? SEALED_REFUSALS.nul : SEALED_REFUSALS.base64);
  }
  if (decoded.text.length === 0) throw new BadRequestException(SEALED_REFUSALS.empty);
  return decoded.text;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MUTANT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A relative, forward-slash path whose every part is plain; never one that climbs. */
export function checkedSealedPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > SEALED_PATH_MAX) {
    throw new BadRequestException(SEALED_REFUSALS.path);
  }
  const parts = path.split('/');
  if (parts.some((part) => !SEGMENT.test(part) || part === '..' || part === '.')) {
    throw new BadRequestException(SEALED_REFUSALS.path);
  }
  return path;
}

/**
 * A sealed path the export could not write back where the loader
 * reads it, refused at the door, so a teacher never seals a file that makes
 * every version published from the draft unexportable (export.service.ts:
 * `hiddenTarget` files a one-segment hidden test under `tests/`, and
 * `overlayTarget` does the same to a tests task's suite file that is not one
 * of the learner's test files). Every other path, and every other role, is
 * answered as usual; reads are not asked.
 *
 * The door answers in its own sentence,
 * `SEALED_FOLDER_REFUSAL`, which names the folder and says "seal it again":
 * the export's sentence ends with the export's remedy. Defined here, so this
 * module does not import export.service (which imports this one).
 */
export const SEALED_FOLDER_REFUSAL = (at: string): string =>
  `"${at}" is not under a folder, so an export of this project could not put it back where it is read. Put it under a folder, such as tests/${at}, and seal it again.`;

export function exportLayoutRefusal(
  checks: PhaseChecks | null | undefined,
  role: SealedRoleKind,
  at: string,
): string | null {
  if (role !== 'hidden' || at.includes('/')) return null;
  if (checks?.kind === 'tests' && ((checks as TestsChecks).learnerTestFiles ?? []).includes(at)) return null;
  return SEALED_FOLDER_REFUSAL(at);
}

function checkedBytes(bytes: unknown): string {
  if (typeof bytes !== 'string' || bytes.length === 0) throw new BadRequestException(SEALED_REFUSALS.empty);
  if (bytes.length > SEALED_FILE_MAX_CHARS) throw new BadRequestException(SEALED_REFUSALS.tooLong);
  if (bytes.includes('\u0000')) throw new BadRequestException(SEALED_REFUSALS.nul);
  return bytes;
}

function checkedRole(role: unknown): SealedRoleKind {
  if (typeof role !== 'string' || !(SEALED_ROLE_KINDS as readonly string[]).includes(role)) {
    throw new BadRequestException(SEALED_REFUSALS.role);
  }
  return role as SealedRoleKind;
}

/**
 * Where a sealed role of a task of this kind is stored: the row's role and its
 * path inside the phase (the importer's layout, `SEALED_ROW_DIRECTORY`).
 */
export function sealedRowFor(
  checkKind: string,
  role: SealedRoleKind,
  path: string,
): { role: ProjectFileRole; rowPath: string } {
  if (checkKind === 'code') {
    if (role === 'hidden') return { role: 'hidden', rowPath: `hidden/${path}` };
    if (role === 'solution') return { role: 'solution', rowPath: `solution/${path}` };
    throw new BadRequestException(SEALED_REFUSALS.codeMutant);
  }
  if (checkKind === 'tests') {
    if (role === 'mutant') {
      const [name, ...rest] = path.split('/');
      if (!MUTANT_NAME.test(name) || rest.length === 0) throw new BadRequestException(SEALED_REFUSALS.mutantPath);
      return { role: 'mutant', rowPath: `mutants/${path}` };
    }
    return { role: 'reference', rowPath: `reference/${path}` };
  }
  throw new BadRequestException(SEALED_REFUSALS.notExecutable);
}

/** Bytes the overlay is handed to see where a file would land; never stored, never compared with a real file. */
const PLACEMENT_PROBE = '\u0000sealed-roles placement probe\u0000';

/** Where the overlay puts one sealed file: the runs that grade it (empty for a code task's solution). */
export interface SealedPlacement {
  runIds: string[];
  /**
   * Set when the file is graded in this run only because the
   * teacher declared it: a run of the file's language that does not hold the
   * path, where the overlay would not otherwise put it. Its row then carries
   * the run in its path (`draft.ts` `sealedRunRowPath`). Absent: the default placement.
   */
  declaredRun?: string;
}

/**
 * A declared run the default placement does not
 * include, accepted when the slice has that run, the run speaks the file's
 * language, and the overlay itself puts a run-carrying row there (asked with
 * the probe, so the door and the compile cannot disagree). Null otherwise:
 * the caller refuses the run.
 */
function declaredRunPlacement(
  slice: CodeChecks | TestsChecks,
  rowRole: 'hidden' | 'reference',
  field: 'hiddenTestFiles' | 'referenceTestFiles' | 'implFiles',
  at: string,
  runId: string,
): SealedPlacement | null {
  const run = slice.runs.find((one) => one.id === runId);
  if (!run) return null;
  const languages = languagesOfPath(at);
  if (languages && !languages.includes(run.language)) return null;
  let rowPath: string;
  try {
    rowPath = sealedRunRowPath(`${rowRole}/${at}`, runId);
  } catch {
    return null;
  }
  const out = overlaySealedRows(slice, [{ role: rowRole, path: rowPath, bytes: PLACEMENT_PROBE }]);
  const placed = out.runs.find((one) => one.id === runId);
  return placed?.[field]?.[at] === PLACEMENT_PROBE ? { runIds: [runId], declaredRun: runId } : null;
}

/** The stored roles whose rows may carry a run (a code task's hidden test, a tests task's suite or implementation). */
function carriesRuns(role: ProjectFileRole): boolean {
  return role === 'hidden' || role === 'reference';
}

/** A row path with a run carried, or null for a run id no row could carry. */
function carriedRowPath(rowPath: string, runId: string): string | null {
  try {
    return sealedRunRowPath(rowPath, runId);
  } catch {
    return null;
  }
}

/** A refusal `sealedPlacement` answers, so the write throws it and the read answers 404 instead. */
export class SealedPlacementRefusal extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Whether a tests slice already holds a path in one half of its reference, flat or in a run. */
function testsHolds(slice: TestsChecks, field: 'referenceTestFiles' | 'implFiles', at: string): boolean {
  return at in (slice[field] ?? {}) || (slice.runs ?? []).some((run) => at in (run[field] ?? {}));
}

/**
 * The runs whose own slice grades this path in a
 * run-carrying role: a code task's hidden test, or a tests task's suite or
 * implementation in the half the role names. A no-run write lays a plain row
 * for any of them that has no carried row of its own.
 */
function sliceGraders(slice: CodeChecks | TestsChecks, role: SealedRoleKind, at: string): string[] {
  const runs = slice.runs ?? [];
  if (slice.kind === 'code') return runs.filter((run) => at in (run.hiddenTestFiles ?? {})).map((run) => run.id);
  const field = role === 'hidden' ? 'referenceTestFiles' : 'implFiles';
  return (runs as TestsChecks['runs']).filter((run) => at in (run[field] ?? {})).map((run) => run.id);
}

/**
 * Where the overlay (`draft.ts` `overlaySealedRows`) will put a
 * sealed file this task holds or is about to hold (asked of the overlay
 * itself, with a probe, so the door and the compile can never disagree:
 *
 * - a code task's `hidden`: the runs that hold the path, else the run of its
 *   language (the overlay's `runForPath`);
 * - a code task's `solution`: only an editable target, since the overlay maps
 *   a solution onto the targets and ignores any other path) a write the
 *   compile would drop is refused, not answered 200;
 * - a tests task's `hidden` (the reference suite) or `solution` (the
 *   implementation): the store keeps both as `reference/<path>`, and the
 *   overlay files a path under whichever half already holds it, else by its
 *   name (a test file is the suite). The declared role must be that half: a
 *   path held as the other half is a role clash (409), a new path whose name
 *   reads as the other half is refused (400). This is what makes the declared
 *   role survive a store that does not record it.
 * - a mutant: the run of the mutant it joins.
 *
 * `checks` is the task row's slice (an executable phase's sole work task).
 */
export function sealedPlacement(
  checks: PhaseChecks | null | undefined,
  role: SealedRoleKind,
  at: string,
  runId?: string | null,
): SealedPlacement {
  const kind = checks?.kind ?? '';
  if (kind !== 'code' && kind !== 'tests') throw new SealedPlacementRefusal(400, SEALED_REFUSALS.notExecutable);
  const raw = checks as CodeChecks | TestsChecks;
  const slice = { ...raw, runs: raw.runs ?? [] } as CodeChecks | TestsChecks;

  if (slice.kind === 'code') {
    if (role === 'mutant') throw new SealedPlacementRefusal(400, SEALED_REFUSALS.codeMutant);
    if (role === 'solution') {
      if (!(slice.editableTargets ?? []).includes(at)) throw new SealedPlacementRefusal(400, SEALED_REFUSALS.solutionTarget);
      return { runIds: [] };
    }
    const out = overlaySealedRows(slice, [{ role: 'hidden', path: `hidden/${at}`, bytes: PLACEMENT_PROBE }]) as CodeChecks;
    const runIds = out.runs.filter((run) => run.hiddenTestFiles?.[at] === PLACEMENT_PROBE).map((run) => run.id);
    const placed = !runId || runIds.includes(runId) ? { runIds } : (declaredRunPlacement(slice, 'hidden', 'hiddenTestFiles', at, runId) ?? { runIds });
    // The hidden-test name rule publish asks, of every run the
    // file lands in, before any row is written. A file that
    // lands in no run is refused too (fail closed; the rule would ask a language
    // this door cannot name).
    const landing = slice.runs.filter((run) => placed.runIds.includes(run.id));
    const named = landing.length > 0 && landing.every((run) => isHiddenTestName(at, run.language));
    if (!named) throw new SealedPlacementRefusal(400, SEALED_REFUSALS.hiddenName);
    return placed;
  }

  if (role === 'mutant') {
    const [name, ...rest] = at.split('/');
    const out = overlaySealedRows(slice, [{ role: 'mutant', path: `mutants/${at}`, bytes: PLACEMENT_PROBE }]) as TestsChecks;
    const run = out.mutants.find((one) => one.name === name && one.files[rest.join('/')] === PLACEMENT_PROBE)?.run;
    return { runIds: run ? [run] : [] };
  }
  const out = overlaySealedRows(slice, [{ role: 'reference', path: `reference/${at}`, bytes: PLACEMENT_PROBE }]) as TestsChecks;
  const field: 'referenceTestFiles' | 'implFiles' | null =
    out.referenceTestFiles?.[at] === PLACEMENT_PROBE ? 'referenceTestFiles' : out.implFiles?.[at] === PLACEMENT_PROBE ? 'implFiles' : null;
  const declared = role === 'hidden' ? 'referenceTestFiles' : 'implFiles';
  if (field !== declared) {
    const heldAsOther = testsHolds(slice, declared === 'referenceTestFiles' ? 'implFiles' : 'referenceTestFiles', at);
    throw new SealedPlacementRefusal(heldAsOther ? 409 : 400, heldAsOther ? SEALED_REFUSALS.roleClash : SEALED_REFUSALS.testsRole);
  }
  const runIds = out.runs.filter((run) => run[declared]?.[at] === PLACEMENT_PROBE).map((run) => run.id);
  if (!runId || runIds.includes(runId)) return { runIds };
  return declaredRunPlacement(slice, 'reference', declared, at, runId) ?? { runIds };
}

/**
 * The paths a code phase gives its learner: its workspace rows (any
 * learner-facing role), its editable targets, its visible tests and the
 * support helpers its runs mount. A hidden file at one of them would be
 * spread over the learner's own file in the graded run (`feedback.service`
 * lays `run.hiddenTestFiles` over the workspace), which content-check's
 * `no-graded-file-in-the-workspace` calls a defect; the door refuses it.
 */
function slicePathsMounted(slice: CodeChecks): Set<string> {
  const out = new Set<string>([...(slice.editableTargets ?? []), ...(slice.visibleTests ?? [])]);
  for (const run of slice.runs ?? []) {
    for (const at of run.visibleTests ?? []) out.add(at);
    for (const at of Object.keys(run.supportFiles ?? {})) out.add(at);
  }
  return out;
}

/* ------------------------------- stripSealed ------------------------------ */

/**
 * The keys under which a compiled phase, run, task or mutant holds sealed
 * bytes as a `path -> bytes` map (`content.types.ts`): each becomes a list of
 * views. `implFiles` and `smokeImplFiles` are the reference application a
 * tests run or a smoke grades against (`reference` rows) and `faultedFiles`
 * is the drill's sealed copy.
 */
export const SEALED_MAP_KEYS: readonly string[] = [
  'hiddenTestFiles',
  'solutionFiles',
  'referenceTestFiles',
  'implFiles',
  'supportFiles',
  'faultedFiles',
  'smokeImplFiles',
];

/** Strings that are the solution itself (the assistant's guardrail snippets). */
export const SEALED_SNIPPET_KEYS: readonly string[] = ['solutionSources'];

/** Fields an object carrying a file's bytes may hold them in. */
const CONTENT_FIELDS = ['content', 'contentBase64', 'bytes'] as const;

function isPlainStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((member) => typeof member === 'string')
  );
}

/** Bytes as text, from a string or a byte array; null for anything else. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  return null;
}

function bytesOfContentField(record: Record<string, unknown>): string | null {
  for (const field of CONTENT_FIELDS) {
    const value = record[field];
    if (field === 'contentBase64' && typeof value === 'string') return Buffer.from(value, 'base64').toString('utf-8');
    const text = textOf(value);
    if (text !== null) return text;
  }
  return null;
}

/**
 * A sealed-role record whose bytes are in no field this file knows: only its
 * path, its role, a well-formed digest and its number and boolean fields are
 * kept. Fail closed: a string or an object under an unknown name may be the
 * file itself.
 */
function sealedRecordWithoutBytes(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [member, value] of Object.entries(record)) {
    if ((member === 'path' || member === 'role') && typeof value === 'string') out[member] = value;
    else if (member === 'sha256' && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) out[member] = value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[member] = value;
  }
  return out;
}

/**
 * A sealed map in a shape other than `path -> string`: each entry becomes the
 * view of its bytes (a string, a byte array, or a record carrying them), or,
 * when no bytes can be found, just its path. Never passed through.
 */
function sealedMapViews(map: Record<string, unknown>): SealedRoleView[] | { path: string }[] {
  return Object.keys(map)
    .sort()
    .map((at) => {
      const value = map[at];
      const text =
        textOf(value) ?? (value && typeof value === 'object' && !Array.isArray(value) ? bytesOfContentField(value as Record<string, unknown>) : null);
      return text === null ? { path: at } : sealedViewOf(at, text);
    });
}

/**
 * Any payload with every sealed byte replaced by its view, at any depth.
 *
 * - a `path -> bytes` map under a `SEALED_MAP_KEYS` key becomes a sorted list
 *   of `{ path, sha256, bytes }`;
 * - a mutant (an element of a `mutants` array) keeps its name and meta, and
 *   its `files` become views;
 * - `solutionSources` snippets become views named `solution-source-<n>`;
 * - a file record whose `role` is sealed (`isSealedFileRole`) and that carries
 *   `content`, `contentBase64` or `bytes` (a string or a byte array) becomes
 *   the view of that file; one whose bytes are under no known field keeps only
 *   its path, role, digest and number/boolean fields (fail closed);
 * - a sealed map key holding records or byte arrays rather than strings
 *   becomes views as well, never a pass-through.
 *
 * Pure: the input is never written, the answer shares no object with it, and a
 * cycle in the input is a cycle in the answer. Dates are kept as they are.
 */
export function stripSealed<T>(payload: T): T {
  const seen = new WeakMap<object, unknown>();

  const visit = (value: unknown, key: string | null, inMutants: boolean): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (seen.has(value)) return seen.get(value);

    if (key !== null && SEALED_MAP_KEYS.includes(key) && isPlainStringMap(value)) {
      const views = sealedViewsOf(value);
      seen.set(value, views);
      return views;
    }
    // Any other object under a sealed map key (records or byte arrays as
    // values): views too, never a pass-through. An array there is already a
    // list of views (a payload stripped twice) and is walked as one.
    if (key !== null && SEALED_MAP_KEYS.includes(key) && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      const views = sealedMapViews(value as Record<string, unknown>);
      seen.set(value, views);
      return views;
    }
    if (key !== null && SEALED_SNIPPET_KEYS.includes(key) && Array.isArray(value)) {
      const views = value.map((one, at) =>
        typeof one === 'string' ? sealedViewOf(`solution-source-${at + 1}`, one) : visit(one, null, false),
      );
      seen.set(value, views);
      return views;
    }

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      const mutants = key === 'mutants';
      for (const member of value) out.push(visit(member, null, mutants));
      return out;
    }

    const record = value as Record<string, unknown>;
    const role = record.role;
    if (typeof role === 'string' && isSealedFileRole(role as ProjectFileRole)) {
      const bytes = bytesOfContentField(record);
      const view = bytes !== null ? sealedViewOf(String(record.path ?? ''), bytes) : sealedRecordWithoutBytes(record);
      seen.set(value, view);
      return view;
    }

    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [member, inner] of Object.entries(record)) {
      if (inMutants && member === 'files' && isPlainStringMap(inner)) {
        out[member] = sealedViewsOf(inner);
        continue;
      }
      out[member] = visit(inner, member, false);
    }
    return out;
  };

  return visit(payload, null, false) as T;
}

/* -------------------------------- the store ------------------------------- */

interface SealedTarget {
  project: ProjectEntity;
  version: ProjectVersionEntity;
  phase: ProjectPhaseEntity;
  task: ProjectTaskEntity;
}

@Injectable()
export class SealedRoleService {
  private readonly logger = new Logger(SealedRoleService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly importer: ProjectImporterService,
  ) {}

  /**
   * Write one sealed file of a draft's executable task, whole, and answer its
   * view. The owner only (ADMIN 403, another teacher 404), a draft only (409,
   * `draftOnlyRefusal`). The same path written again replaces the row's bytes:
   * the old row is deleted before the new one is inserted, so the natural key
   * and both byte rules see the new set (`replaceInterviewRow`'s order).
   *
   * The file must be one the compile will grade where the teacher said
   * (`sealedPlacement`): a tests task's declared suite or implementation, a
   * code task's solution at an editable target, a code task's hidden test at
   * no path the phase gives the learner, and (when `runId` is given) the run
   * the overlay grades it in. Each is refused before a row is touched.
   */
  async write(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    role: SealedRoleKind,
    path: string,
    bytes: string,
    runId?: string | null,
  ): Promise<SealedRoleView> {
    return this.dataSource.transaction(async (manager) => {
      // The gate first, so a caller who may not write learns nothing from the
      // shape of their input.
      const target = await this.target(manager, caller, projectId, versionId, phaseKey, taskKey);
      // The version row first, before any other row lock, and
      // the draft-only question asked of the row as locked.
      const locked = await lockVersionRow(manager, target.version.id);
      const status = locked?.status ?? target.version.status;
      if (status !== 'draft') {
        throw new ConflictException(draftOnlyRefusal(locked?.version ?? target.version.version, status));
      }
      const kind = checkedRole(role);
      const at = checkedSealedPath(path);
      const text = checkedBytes(bytes);
      const checks = target.task.checks;
      const row = sealedRowFor(checks?.kind ?? '', kind, at);
      const held = await manager.findOne(ProjectFileEntity, {
        where: { projectVersionId: target.version.id, ownerKind: 'phase', ownerId: target.phase.id, path: row.rowPath },
      });
      let placement: SealedPlacement;
      try {
        placement = sealedPlacement(checks, kind, at, runId);
      } catch (error) {
        if (!(error instanceof SealedPlacementRefusal)) throw error;
        // A tests task's file already written at this path, read as the other
        // half: the same path under the other role is a clash, not a new name.
        if (error.status === 409 || (held && checks?.kind === 'tests')) throw new ConflictException(SEALED_REFUSALS.roleClash);
        throw new BadRequestException(error.message);
      }
      if (runId !== undefined && runId !== null && !placement.runIds.includes(runId)) {
        throw new BadRequestException(SEALED_REFUSALS.run);
      }
      // The export-layout check: after the role, name and run answers, before any row.
      const layout = exportLayoutRefusal(checks, kind, at);
      if (layout !== null) throw new BadRequestException(layout);
      // A file graded in a run only because the teacher declared
      // it carries that run in its row path; every other row is stored at its plain path.
      let rowPaths = [placement.declaredRun ? sealedRunRowPath(row.rowPath, placement.declaredRun) : row.rowPath];
      // The same write lands in the same place in
      // a draft and in its copy. Which runs hold the file as a carried row is
      // read off the version's rows, never off the task row's slice, which in
      // a copy already holds the carried run's file and in its source does not.
      // The overlay lays a run's carried row over that run after every plain
      // row, so:
      //  1. a write naming a run writes that run's carried row (created when
      //     needed); it rewrites the plain row only when every other run the
      //     plain row reaches has its own carried row, so no other run moves.
      //     It never deletes or rewrites another run's carried row.
      //  2. a write naming no run means "every run that grades it grades these
      //     bytes", and deletes no row: every carried
      //     row of the path is rewritten in place, and the plain row is written
      //     or rewritten when a plain row already holds the path, when no
      //     carried row does (a new file takes the default placement), or when
      //     a run that grades the path in the task's slice has no carried row
      //     of its own. A file held only by carried rows writes no plain row.
      if (!placement.declaredRun && carriesRuns(row.role)) {
        const sliceRuns = ((checks as CodeChecks | TestsChecks).runs ?? []).map((one) => one.id);
        const carriedPathOf = new Map<string, string>();
        for (const one of sliceRuns) {
          const carried = carriedRowPath(row.rowPath, one);
          if (carried) carriedPathOf.set(one, carried);
        }
        const carriedRows = carriedPathOf.size
          ? await manager.find(ProjectFileEntity, {
              where: { projectVersionId: target.version.id, ownerKind: 'phase', ownerId: target.phase.id, path: In([...carriedPathOf.values()]) },
              select: { id: true, path: true, role: true },
            })
          : [];
        const carriedBy = sliceRuns.filter((one) => carriedRows.some((held) => held.path === carriedPathOf.get(one)));
        if (runId) {
          const plainReachesOnly = placement.runIds.every((one) => one === runId || carriedBy.includes(one));
          if (carriedBy.includes(runId) || !plainReachesOnly) rowPaths = [carriedPathOf.get(runId) ?? sealedRunRowPath(row.rowPath, runId)];
        } else {
          const uncarried = sliceGraders(checks as CodeChecks | TestsChecks, kind, at).filter((one) => !carriedBy.includes(one));
          const plain = Boolean(held) || carriedBy.length === 0 || uncarried.length > 0;
          rowPaths = [...carriedBy.map((one) => carriedPathOf.get(one)!), ...(plain ? [row.rowPath] : [])];
        }
      }
      const heldRows: (ProjectFileEntity | null)[] = [];
      for (const rowPath of rowPaths) {
        heldRows.push(
          rowPath === row.rowPath
            ? held
            : await manager.findOne(ProjectFileEntity, {
                where: { projectVersionId: target.version.id, ownerKind: 'phase', ownerId: target.phase.id, path: rowPath },
              }),
        );
      }
      if (checks?.kind === 'code' && kind === 'hidden') {
        const mountedRow = await manager.findOne(ProjectFileEntity, {
          where: {
            projectVersionId: target.version.id,
            ownerKind: 'phase',
            ownerId: target.phase.id,
            path: at,
            role: In(LEARNER_FACING_FILE_ROLES),
          },
          select: { id: true },
        });
        if (mountedRow || slicePathsMounted(checks as CodeChecks).has(at)) {
          throw new BadRequestException(SEALED_REFUSALS.mounted);
        }
      }

      if (heldRows.some((heldRow) => heldRow && heldRow.role !== row.role)) throw new ConflictException(SEALED_REFUSALS.roleClash);
      const replacedRows = heldRows.filter((heldRow): heldRow is ProjectFileEntity => Boolean(heldRow));
      if (replacedRows.length) await manager.delete(ProjectFileEntity, { id: In(replacedRows.map((one) => one.id)) });

      await this.importer.insertFiles(
        manager,
        target.version.id,
        rowPaths.map((rowPath) => ({
          ownerKind: 'phase' as const,
          ownerId: target.phase.id,
          path: rowPath,
          role: row.role,
          editable: false,
          language: null,
          bytes: text,
        })),
      );

      const view = sealedViewOf(at, text);
      // The path and the byte length, never the bytes or their digest.
      // `rowPath` is what marks the row as the owner's own (`sealWroteRow`):
      // one audit row per row written (a no-run rewrite of a file held
      // by several runs' carried rows writes each of them).
      for (const [at2, rowPath] of rowPaths.entries()) {
        const detail = {
          versionId: target.version.id,
          phaseKey,
          taskKey,
          taskTitle: target.task.title,
          role: kind,
          path: at,
          rowPath,
          runId: sealedRowRunOf(rowPath).runId ?? placement.runIds[0] ?? null,
          bytes: view.bytes,
          replaced: Boolean(heldRows[at2]),
        };
        this.logger.log({ event: SEALED_WRITE_AUDIT_EVENT, actorId: caller.id, projectId, ...detail });
        await recordAudit(manager, {
          event: SEALED_WRITE_AUDIT_EVENT,
          actorUserId: caller.id,
          subjectUserId: caller.id,
          targetId: projectId,
          action: `${phaseKey}:sealed`,
          reason: null,
          detail,
        });
      }
      return view;
    });
  }

  /**
   * One sealed file with its bytes, for the project's owner alone, and one
   * `project.sealed-read` row on every read. A published version is readable
   * too: a teacher asking what they shipped (`readQuizKey`'s rule). A mutant is
   * refused for everyone (403) and leaves no row.
   *
   * Asked under the role it was written as: a tests task's suite file read as
   * its implementation (or the reverse), or under a run that does not grade
   * it, is the owner's 404. The answer names the run the overlay grades the
   * file in (null for a code task's solution). `role` and `path` arrive as the
   * query gave them and are checked here (`checkedRole`, `checkedSealedPath`).
   */
  async readOwnerOnly(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    role: unknown,
    path: unknown,
    runId?: string | null,
  ): Promise<SealedRoleOwnerRead> {
    return this.dataSource.transaction(async (manager) => {
      const target = await this.target(manager, caller, projectId, versionId, phaseKey, taskKey);
      const kind = checkedRole(role);
      if (kind === 'mutant') throw new ForbiddenException(SEALED_REFUSALS.mutantRead);
      const at = checkedSealedPath(path);
      const row = sealedRowFor(target.task.checks?.kind ?? '', kind, at);
      let placement: SealedPlacement;
      try {
        placement = sealedPlacement(target.task.checks, kind, at, runId || null);
      } catch (error) {
        if (!(error instanceof SealedPlacementRefusal)) throw error;
        throw new NotFoundException(SEALED_REFUSALS.noFile);
      }
      if (runId !== undefined && runId !== null && runId !== '' && !placement.runIds.includes(runId)) {
        throw new NotFoundException(SEALED_REFUSALS.noFile);
      }

      // The row a declared run's file was written to carries the run.
      // Read what the overlay grades. A named run's carried row
      // wins over the plain row (the overlay lays it last), also in a copy whose
      // slice already holds the file there; with no run named, the plain row,
      // else the carried row of the first run that grades the file.
      // And with no run named, a file held only by another
      // run's carried row (a no-run write rewrites it in place) reads too.
      const asked = runId || null;
      const sliceRuns = ((target.task.checks as CodeChecks | TestsChecks | null)?.runs ?? []).map((one) => one.id);
      const order: string[] = placement.declaredRun
        ? [sealedRunRowPath(row.rowPath, placement.declaredRun)]
        : !carriesRuns(row.role)
          ? [row.rowPath]
          : asked
            ? [carriedRowPath(row.rowPath, asked), row.rowPath].filter((one): one is string => Boolean(one))
            : [
                row.rowPath,
                ...[...placement.runIds, ...sliceRuns.filter((one) => !placement.runIds.includes(one))]
                  .map((one) => carriedRowPath(row.rowPath, one))
                  .filter((one): one is string => Boolean(one)),
              ];
      const found = await manager.find(ProjectFileEntity, {
        where: {
          projectVersionId: target.version.id,
          ownerKind: 'phase',
          ownerId: target.phase.id,
          path: In(order),
          role: row.role,
        },
      });
      const file = order.map((at) => found.find((one) => one.path === at)).find(Boolean);
      if (!file) throw new NotFoundException(SEALED_REFUSALS.noFile);
      // Only bytes the owner authored come back. A copy's sealed rows point at
      // the source's blobs, so without this any teacher who copied the
      // platform's project could read its hidden suite and solution, which
      // no teacher may. Refused before the blob is read, and no row.
      if (await inheritedSealedRow(manager, caller.id, target.version, phaseKey, file)) {
        throw new ForbiddenException(SEALED_REFUSALS.inherited);
      }
      const blob = await manager.findOne(ContentBlobEntity, { where: { sha: file.blobSha } });
      if (!blob) throw new NotFoundException(SEALED_REFUSALS.noFile);

      const view = sealedViewOf(at, blob.bytes);
      const detail = {
        versionId: target.version.id,
        phaseKey,
        taskKey,
        taskTitle: target.task.title,
        role: kind,
        path: at,
        bytes: view.bytes,
      };
      this.logger.log({ event: SEALED_READ_AUDIT_EVENT, actorId: caller.id, projectId, ...detail });
      await recordAudit(manager, {
        event: SEALED_READ_AUDIT_EVENT,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        // The phase key, as `solution.read` and `project.quiz-key` write it.
        action: phaseKey,
        reason: null,
        detail,
      });
      return {
        role: kind,
        runId: sealedRowRunOf(file.path).runId ?? placement.runIds[0] ?? null,
        path: at,
        sha256: view.sha256,
        bytes: view.bytes,
        contentBase64: Buffer.from(blob.bytes, 'utf-8').toString('base64'),
      };
    });
  }

  /**
   * The owner gate, then the version, the phase and the task.
   *
   * `AuthoringService.requireOwnedProject`'s rule, restated because that method
   * is private to that service: a project the caller cannot see is 404 (another
   * teacher learns nothing from guessing ids); one they can see and do not own
   * (an ADMIN, or the platform's own project) is 403.
   */
  private async target(
    manager: EntityManager,
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
  ): Promise<SealedTarget> {
    const project = UUID_PATTERN.test(projectId) ? await manager.findOne(ProjectEntity, { where: { id: projectId } }) : null;
    const visible = project && (caller.role === 'ADMIN' || project.platformOwned || project.ownerUserId === caller.id);
    if (!project || !visible) throw new NotFoundException('no project with that id in your library');
    if (project.platformOwned) throw new ForbiddenException(platformProjectCopyOnlyRefusal(project.title));
    if (project.ownerUserId !== caller.id) throw new ForbiddenException(projectNotYoursRefusal());

    const version = UUID_PATTERN.test(versionId)
      ? await manager.findOne(ProjectVersionEntity, { where: { id: versionId, projectId } })
      : null;
    if (!version) throw new NotFoundException('no version with that id in that project');
    const phase = await manager.findOne(ProjectPhaseEntity, { where: { projectVersionId: version.id, key: phaseKey } });
    if (!phase) throw new NotFoundException(`this project has no ${String(phaseKey)} phase`);
    const task = await manager.findOne(ProjectTaskEntity, { where: { projectPhaseId: phase.id, taskKey } });
    if (!task) throw new NotFoundException(`${phase.title} has no task keyed "${taskKey}"`);
    return { project, version, phase, task };
  }
}
