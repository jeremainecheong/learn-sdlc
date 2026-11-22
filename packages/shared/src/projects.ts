/**
 * The project model's vocabulary for teacher-authored projects.
 *
 * A project is stored as rows rather than read from a content directory, so
 * facts a directory carried implicitly (the role of a file, the version line
 * of `project.json`) have to be written down: the closed set a column may hold, the shape a version
 * string has, the key a phase's sole task carries. This file is where they are
 * written down once, so that the compiler, the importer, the entities and the
 * class export cannot each hold their own copy and drift.
 *
 * Nothing here is a learner-facing payload. The roles below are server-side
 * facts about a row: `workspace` is the only role a learner's workspace is
 * served from and `warmup` holds a pack's warm-up files, which are learner
 * material, which is exactly why the sealed set has to be a list and not an
 * instinct.
 *
 * `index.ts` re-exports this module, so every name below is imported from
 * `@learnsdlc/shared` like any other. Its one import from the contract modules
 * is `import type`, which TypeScript erases. The runtime imports are the record
 * modules for their paths (`./requirements-story`, `./runbook-record`,
 * `./change-record`), none of which imports this module, so it cannot be in a
 * cycle.
 */

import type { PhaseKey } from './phases';
import type { ArtifactKind } from './contract/phase-detail';
import { STORY_JSON } from './requirements-story';
import { RUNBOOK_JSON } from './runbook-record';
import { CHANGE_REQUEST_JSON } from './change-record';

/* ------------------------------ the project ------------------------------- */

/**
 * How a project came to exist. Written at insert and never changed, because it
 * is provenance rather than state: `seed` is the platform's own imported pack,
 * and the other three are the doors a teacher comes in by.
 */
export const PROJECT_ORIGINS = ['seed', 'fork', 'upload', 'blank'] as const;

export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number];

/**
 * A version's life. One `draft` at a time per project, any number `published`,
 * and `archived` for one withdrawn: withdrawal being refused by name while any
 * enrolment pins it.
 *
 * A `published` version is immutable. That is the whole reason the pin works:
 * a learner resolved to a published version cannot have the ground move under
 * an attempt, so a content fix is a new version rather than an edit.
 */
export const PROJECT_VERSION_STATUSES = ['draft', 'published', 'archived'] as const;

export type ProjectVersionStatus = (typeof PROJECT_VERSION_STATUSES)[number];

/** `MAJOR.MINOR.PATCH`, and nothing else. A pack declaring anything else is refused at import. */
export const PROJECT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function isProjectVersion(value: string): boolean {
  return PROJECT_VERSION_PATTERN.test(value);
}

/**
 * Orders two version strings field by field, as numbers, the way `sort` wants:
 * negative when `a` is older, positive when it is newer, zero when they are the
 * same version.
 *
 * It exists because the obvious alternative is wrong in a way that is invisible
 * until a project reaches its tenth patch: `'2.0.10' > '2.0.9'` is `false`
 * between strings, so a head resolved by comparing version strings would serve
 * 2.0.9 to every new enrolment for ever.
 *
 * A string that is not `MAJOR.MINOR.PATCH` sorts **before** every version that
 * is, so a malformed row can never come out of a sort as the newest published
 * version; two such strings compare equal, because there is nothing to order
 * them by.
 */
export function compareProjectVersions(a: string, b: string): number {
  const left = fieldsOf(a);
  const right = fieldsOf(b);
  if (!left || !right) {
    if (left) return 1;
    if (right) return -1;
    return 0;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function fieldsOf(value: string): number[] | null {
  if (!isProjectVersion(value)) return null;
  return value.split('.').map((field) => Number(field));
}

/* -------------------------------- the files ------------------------------- */

/** Whether a file row hangs off the project, one of its phases or one task. */
export const PROJECT_FILE_OWNER_KINDS = ['project', 'phase', 'task'] as const;

export type ProjectFileOwnerKind = (typeof PROJECT_FILE_OWNER_KINDS)[number];

/**
 * What a file **is to the version that holds it**, and the most misread column
 * in the model, so the reason is here rather than in a commit message.
 *
 * Blobs are keyed by sha256 and shared: a fork copies metadata only, and a
 * hundred forks of one project store one copy of it. That sharing is exactly
 * why a role cannot live on the blob: one sha is reached by many rows under
 * many roles. In the imported default project five shas are a **locked
 * `workspace` row** in one phase and a sealed `solution` file in another, so
 * "these bytes are the answer" is a statement about a
 * `(version, phase, path)`, never about bytes.
 *
 * `project_files.role` is therefore the only place a role exists, it is written
 * once at insert and **never updated**, there is no re-role operation to
 * refuse, and the two rules below are asked of *this version's* rows.
 */
export type ProjectFileRole =
  | 'workspace'
  | 'canonical'
  | 'hidden'
  | 'solution'
  | 'reference'
  | 'mutant'
  | 'support'
  | 'drill'
  | 'interview'
  | 'warmup';

export const PROJECT_FILE_ROLES: ProjectFileRole[] = [
  'workspace',
  'canonical',
  'hidden',
  'solution',
  'reference',
  'mutant',
  'support',
  'drill',
  'interview',
  'warmup',
];

/**
 * The roles whose rows may never appear in a learner-facing response, a
 * workspace, a preview, an export or a log. A row under one of these is read by
 * the grader and by nothing else.
 *
 * `canonical` is not in the list and is not therefore open: it is answer
 * material that a phase may legitimately mount as a **locked** workspace file,
 * which is what the pack's own `../../canonical/…` sources already do, so the
 * rule it needs is the editable one below rather than a seal. `warmup` is a
 * pack's warm-up, written for a learner, and `workspace` is what a workspace is.
 */
export const SEALED_FILE_ROLES: ProjectFileRole[] = [
  'hidden',
  'solution',
  'reference',
  'mutant',
  'support',
  'drill',
  'interview',
];

export function isSealedFileRole(role: ProjectFileRole): boolean {
  return SEALED_FILE_ROLES.includes(role);
}

/**
 * Bytes a `workspace` row may not hold, **editable or locked**: if this version
 * holds the same sha under any of these roles, mounting it in the workspace
 * would hand a learner a hidden test, a mutant, a drill's faulted copy, an
 * interview brief or a sealed support file to read.
 *
 * `solution` and `reference` are deliberately absent, and their absence is the
 * whole point of the set being written down: a locked workspace file whose
 * bytes are another phase's reference answer is the shipped shape of the
 * default project, the five dual-role shas, so forbidding them here would
 * refuse the platform's own content. The editable rule below is what stops
 * those bytes reaching a file the learner is being scored on filling in.
 */
export const WORKSPACE_FORBIDDEN_BLOB_ROLES: ProjectFileRole[] = [
  'hidden',
  'mutant',
  'drill',
  'interview',
  'support',
];

/**
 * Bytes an `editable: true` workspace row may not hold: every sealed role, plus
 * `canonical`. A learner asked to write the function cannot be handed the
 * finished function to edit, whichever seal it arrived under.
 */
export const EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES: ProjectFileRole[] = [
  ...SEALED_FILE_ROLES,
  'canonical',
];

/* ------------------------------ the task grain ---------------------------- */

/**
 * The key a phase's sole task carries when the phase declares no tasks of its
 * own.
 *
 * The empty string is the platform's own convention rather than an invention: a
 * phase declaring no runs already gets one synthesised run with `id: ''` and
 * `label: ''`, because a phase with one run has nothing to group by, and every
 * reader loops over the synthesised list instead of branching. Following it
 * exactly means a single-task phase behaves like a single-run phase, with no
 * data to migrate, and the empty key never reaches a URL.
 */
export const SOLE_TASK_KEY = '';

/** The longest an authored task key may be, in characters (`TASK_KEY_PATTERN`). */
export const TASK_KEY_MAX_LENGTH = 32;

/**
 * An **authored** task key: lower case, opening on a letter, at most
 * `TASK_KEY_MAX_LENGTH` characters, stable across versions so a learner's state
 * follows the task rather than its position. The sole task's key is not of this
 * shape, which is what keeps the two apart.
 */
export const TASK_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function isAuthoredTaskKey(key: string): boolean {
  return TASK_KEY_PATTERN.test(key);
}

/* ---------------------------- the artefact type --------------------------- */

/**
 * What a task produces, from a closed platform list. The type picks the room
 * the learner works in and the shape of the default path; the task's graded
 * units decide its check kind, which is a different question.
 */
export type ArtefactType =
  | 'user-story'
  | 'design-doc'
  | 'api-contract'
  | 'code'
  | 'tests'
  | 'runbook'
  | 'change-request'
  | 'document'
  // A quiz is a task, so what it produces is an
  // artefact type like any other, and the one type that produces no file at
  // all. It picks the quiz room; `ArtifactKind: 'quiz'` is what scores it.
  | 'quiz';

export const ARTEFACT_TYPES: ArtefactType[] = [
  'user-story',
  'design-doc',
  'api-contract',
  'code',
  'tests',
  'runbook',
  'change-request',
  'document',
  'quiz',
];

/**
 * What each phase *suggests*, as a suggestion and not an answer: the editor
 * pre-fills it and a teacher changes one select to get something else.
 */
export const PHASE_ARTEFACT_TYPE_SUGGESTION: Record<PhaseKey, ArtefactType> = {
  requirements: 'user-story',
  design: 'design-doc',
  implementation: 'code',
  testing: 'tests',
  deployment: 'runbook',
  maintenance: 'code',
};

/**
 * The artefact type of a phase's synthesised sole task, by its check kind
 * alone: every kind names one type, so the phase key moves nothing. Every
 * compiled task of the four phases that grade a record, a code task or a test
 * suite keeps the type it had. The `ArtefactType` union keeps `document` and
 * `change-request` so older rows still read.
 */
export function artefactTypeFor(checkKind: ArtifactKind, _phaseKey: PhaseKey): ArtefactType {
  switch (checkKind) {
    case 'story': return 'user-story';
    case 'design': return 'design-doc';
    case 'code': return 'code';
    case 'tests': return 'tests';
    case 'config': return 'runbook';
    case 'quiz': return 'quiz';
    default: {
      // The older written kind a stored draft row can still hold reads as `document`, so the door that
      // refuses that phase says its own sentence; any other kind outside the union is refused here.
      const unknownKind: never = checkKind;
      if (String(unknownKind) === 'markdown') return 'document';
      throw new Error(`A ${String(unknownKind)} check kind has no artefact type.`);
    }
  }
}

/**
 * The file each phase's own room is built around.
 *
 * The web holds the same list (`components/shell/routes.ts`
 * `PHASE_ROOM_ARTEFACT`): `TaskPanel.tsx` `taskRoomHref` opens a concept quiz's
 * paper, every other task of a phase listed here in that phase's room, and a
 * task of any other phase in the workspace editor. The API names a phase's room
 * task (the task that declares this file, else the first that owns it) from the
 * same paths, so the two halves read one list. Append only.
 */
export const PHASE_ROOM_ARTEFACT_PATHS: Readonly<Partial<Record<PhaseKey, string>>> = {
  // The story record: the Requirements room reads and writes it and nothing else.
  requirements: STORY_JSON,
  design: 'design/design.json',
  // The two records worked through forms: the IDE's Runbook tab and the change room's tabs.
  deployment: RUNBOOK_JSON,
  maintenance: CHANGE_REQUEST_JSON,
};
