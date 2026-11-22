/**
 * The contract for a teacher's own uploaded project.
 *
 * A teacher may upload a project of their own and edit its one executable
 * task per phase. Every value below is read elsewhere: by the upload door and
 * its refusals, the one runtime profile, the importer's draft mode, the
 * executable arm, the controller and the publish gate, the sealed roles, deep
 * validation, the sign-off table, the version export, the quiz-results export
 * and the teacher web. So a value that drifts or a sentence that starts
 * echoing an archive fails here, before any of them trusts it.
 *
 * Four rules this file holds on purpose:
 *
 * - **Append only.** The first twenty-five route keys and thirteen audit names
 *   are pinned exactly; the upload's own are added after them.
 * - **Sealed bytes have no field to ride in.** A sealed view is exactly
 *   `{path, sha256, bytes}`; the executable task view and the deep-validation
 *   view are pinned member for member, optional ones included.
 * - **No refusal echoes the archive.** Every upload and run-shape sentence is a
 *   fixed string: no placeholder, no path, no quoted name.
 * - **A removable part leaves no dead key.** The export, sign-off and
 *   quiz-export parts sit in their own regions of this file (and of the
 *   source), so removing one removes its key, its row and its test together.
 *
 * The type-level assertions are real assertions: ts-jest compiles this file
 * with diagnostics on, so a member that appears or a key that stops being
 * optional is a failed compile of this suite.
 */

import { createHash } from 'crypto';

import {
  AUTHORING_AUDIT_EVENTS,
  AUTHORING_ROUTES,
  AUTHORING_ROUTE_KEYS,
  BUDGET_CEILING,
  DEEP_VALIDATION_CHECK_IDS,
  DEEP_VALIDATION_STATUSES,
  EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES,
  LEARNER_RUN_LIMITS,
  PROJECT_UPLOAD_LIMITS,
  RUNTIME_PROFILES,
  RUN_SHAPES,
  RUN_SHAPE_COMMAND_KEYS,
  RUN_SHAPE_REFUSALS,
  RUN_SHAPE_REFUSAL_CODES,
  SEALED_ROLE_KINDS,
  SUPPORTED_STACKS_SENTENCE,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_DETAIL_MAX,
  budgetCeilingRefusal,
  deepValidationCostWarning,
  isAuthorableExecutableTask,
  uploadRefusalForRunShape,
  type AuditEventView,
  type AuthoringRouteKey,
  type DeepValidationCheckView,
  type DeepValidationCostWarning,
  type DeepValidationReceipt,
  type DeepValidationStartBody,
  type DeepValidationView,
  type DraftTaskView,
  type ExecutableRunBody,
  type ExecutableRunView,
  type ExecutableTaskView,
  type ProjectUploadCompileSummary,
  type ProjectUploadRefusal,
  type ProjectUploadRequest,
  type ProjectUploadResult,
  type ProjectVersionValidation,
  type RunShapeFinding,
  type RunShapeId,
  type RuntimeProfileId,
  type RuntimeProfileView,
  type SealedFileOwnerRead,
  type SealedFileReadQuery,
  type SealedFileView,
  type SealedFileWriteBody,
  type UpdateExecutableTaskBody,
  type UpdateTaskBody,
  type UploadRefusalCode,
} from './index';

/** True exactly when `K` may be left out of a `T`: an optional field. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

/** True exactly when `T`'s members are `K`, no more and no fewer, optional ones included. */
type HasExactlyKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? [K] extends [keyof T]
    ? true
    : false
  : false;

/** True exactly when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/* ----------------------------- the route keys ------------------------------ */

/** The table's first twenty-five keys, in their order. */
const RB_KEYS = [
  'projects.list',
  'projects.create',
  'projects.get',
  'projects.updateMeta',
  'projects.archive',
  'version.draft',
  'version.validate',
  'version.publish',
  'tasks.list',
  'tasks.add',
  'tasks.update',
  'tasks.setRequired',
  'tasks.reorder',
  'tasks.remove',
  'files.list',
  'assignment.assignable',
  'assignment.read',
  'assignment.assign',
  'versions.createDraft',
  'tasks.quizKey',
  'phases.update',
  'interview.replace',
  'interview.remove',
  'interview.read',
  'files.replace',
];

/** The upload's own keys, which are never removed, in their order. */
const XC_KEYS = [
  'projects.upload',
  'runtime.profile',
  'sealed.write',
  'sealed.read',
  'deepValidation.start',
  'deepValidation.read',
];

/** The Phases card's three doors, appended after the upload's keys. */
const S4_KEYS = ['phases.remove', 'phases.restore', 'phases.add'];

/** Keys in a removable region (as strings, so removing the region leaves this file compiling). */
const CUTTABLE_KEYS = ['version.export'];

const VERSION = '/instructor/projects/:projectId/versions/:versionId';
const TASK = `${VERSION}/phases/:phaseKey/tasks/:taskKey`;

describe('the authoring route keys', () => {
  it('keeps the twenty-five keys that were there, in order, and appends after them', () => {
    expect(AUTHORING_ROUTE_KEYS.slice(0, RB_KEYS.length)).toEqual(RB_KEYS);
    const appended = AUTHORING_ROUTE_KEYS.slice(RB_KEYS.length) as readonly string[];
    expect(appended.filter((key) => XC_KEYS.includes(key))).toEqual(XC_KEYS);
    expect(appended.filter((key) => S4_KEYS.includes(key))).toEqual(S4_KEYS);
    for (const key of appended) expect([key, [...XC_KEYS, ...CUTTABLE_KEYS, ...S4_KEYS].includes(key)]).toEqual([key, true]);
    // Every one of the upload's keys is a member of the key type, so this line compiles.
    const typed: AuthoringRouteKey[] = [
      'projects.upload',
      'runtime.profile',
      'sealed.write',
      'sealed.read',
      'deepValidation.start',
      'deepValidation.read',
    ];
    expect(typed).toEqual(XC_KEYS);
  });

  it("mounts the Phases card's three doors on a draft's phase, each audited as project.phase", () => {
    expect(AUTHORING_ROUTES['phases.remove']).toMatchObject({ method: 'DELETE', path: `${VERSION}/phases/:phaseKey`, mutates: true, audit: 'project.phase' });
    expect(AUTHORING_ROUTES['phases.restore']).toMatchObject({ method: 'POST', path: `${VERSION}/phases/:phaseKey/restore`, mutates: true, audit: 'project.phase' });
    expect(AUTHORING_ROUTES['phases.add']).toMatchObject({ method: 'POST', path: `${VERSION}/phases/:phaseKey`, mutates: true, audit: 'project.phase' });
  });

  it('uploads into a new draft, beside the project list and never on a project', () => {
    expect(AUTHORING_ROUTES['projects.upload']).toMatchObject({
      method: 'POST',
      path: '/instructor/projects/upload',
      mutates: true,
      audit: 'project.uploaded',
    });
  });

  it('reads the one runtime profile this deployment bakes', () => {
    expect(AUTHORING_ROUTES['runtime.profile']).toMatchObject({
      method: 'GET',
      path: '/instructor/runtime-profile',
      mutates: false,
      audit: null,
    });
  });

  it("writes a task's sealed file, and reads one back for the owner alone, audited", () => {
    expect(AUTHORING_ROUTES['sealed.write']).toMatchObject({
      method: 'PUT',
      path: `${TASK}/sealed`,
      mutates: true,
      audit: 'project.files',
    });
    // A read that leaves a row, as `tasks.quizKey` and `interview.read` are:
    // `audit` names what a write leaves, so it is null, and the row's name is
    // `project.sealed-read`.
    expect(AUTHORING_ROUTES['sealed.read']).toMatchObject({
      method: 'GET',
      path: `${TASK}/sealed`,
      mutates: false,
      audit: null,
    });
    expect(AUTHORING_ROUTES['sealed.read'].summary).toMatch(/owner alone/);
    expect(AUTHORING_ROUTES['sealed.read'].summary).toMatch(/Audited on every read/);
  });

  it('starts and reads deep validation on the version', () => {
    expect(AUTHORING_ROUTES['deepValidation.start']).toMatchObject({
      method: 'POST',
      path: `${VERSION}/deep-validation`,
      mutates: true,
      audit: 'project.deep-validation',
    });
    expect(AUTHORING_ROUTES['deepValidation.read']).toMatchObject({
      method: 'GET',
      path: `${VERSION}/deep-validation`,
      mutates: false,
      audit: null,
    });
  });

  it('keeps every appended route staff-only, under /instructor, and apart from every other route', () => {
    const shapes = new Set(
      AUTHORING_ROUTE_KEYS.map(
        (key) => `${AUTHORING_ROUTES[key].method} ${AUTHORING_ROUTES[key].path.replace(/:[a-zA-Z]+/g, ':p')}`,
      ),
    );
    expect(shapes.size).toBe(AUTHORING_ROUTE_KEYS.length);
    for (const key of AUTHORING_ROUTE_KEYS.slice(RB_KEYS.length)) {
      const route = AUTHORING_ROUTES[key];
      expect([key, [...route.roles].sort()]).toEqual([key, ['ADMIN', 'INSTRUCTOR']]);
      expect(route.path.startsWith('/instructor/')).toBe(true);
      expect(route.mutates).toBe(route.method !== 'GET');
      expect(route.summary.length).toBeGreaterThan(20);
    }
  });
});

/* ----------------------------- the audit names ----------------------------- */

/** The list's first thirteen names, in their order. */
const RB_EVENTS = [
  'project.create',
  'project.update',
  'project.tasks',
  'project.validate',
  'project.publish',
  'project.archive',
  'cohort.project',
  'project.draft',
  'project.quiz-key',
  'project.phase',
  'project.interview',
  'project.files',
  'project.interview-read',
];

const XC_EVENTS = ['project.uploaded', 'project.sealed-read', 'project.deep-validation'];

const CUTTABLE_EVENTS = ['project.exported', 'class.bulk-signoff'];

describe('the audit names', () => {
  it('keeps the thirteen names that were there, in order, and appends after them', () => {
    expect(AUTHORING_AUDIT_EVENTS.slice(0, RB_EVENTS.length)).toEqual(RB_EVENTS);
    const appended = AUTHORING_AUDIT_EVENTS.slice(RB_EVENTS.length) as readonly string[];
    expect(appended.filter((name) => XC_EVENTS.includes(name))).toEqual(XC_EVENTS);
    for (const name of appended) expect([name, [...XC_EVENTS, ...CUTTABLE_EVENTS].includes(name)]).toEqual([name, true]);
  });

  it("puts the upload's audit names in the audit row's union, so no writer needs a cast", () => {
    const names: AuditEventView['event'][] = ['project.uploaded', 'project.sealed-read', 'project.deep-validation'];
    expect(names).toEqual(XC_EVENTS);
  });
});

/* ----------------------------- the upload door ----------------------------- */

/** The first 28 upload codes, in their order. */
const FIRST_UPLOAD_REFUSAL_CODES = [
  'PATH_CLIMB',
  'SYMLINK',
  'DUPLICATE_NAME',
  'CASE_COLLISION',
  'NUL_IN_NAME',
  'RATIO_BOMB',
  'TOTAL_SIZE_BOMB',
  'TOO_MANY_ENTRIES',
  'ENCRYPTED_ENTRY',
  'ZIP64_OR_SIZE_MISMATCH',
  'CRC_MISMATCH',
  'RUNTIME_OUTSIDE_PROFILE',
  'RUN_LIMIT_ABOVE_LEARNER',
  'RUN_SHAPE_NOT_ALLOWED',
  'TWO_WORK_TASKS',
  'HIDDEN_IN_WORKSPACE',
  'SOLUTION_IN_EDITABLE',
  'CEILING_PER_PHASE',
  'CEILING_PER_VERSION',
  'RESERVED_NAME',
  'SECRET_FILE',
  'ARCHIVE_TOO_LARGE',
  'NOT_A_ZIP',
  'NOT_A_PACK',
  'WARMUP_NOT_UPLOADABLE',
  'TITLE_INVALID',
  'UNSUPPORTED_ARCHIVE',
  'EMPTY_ARCHIVE',
];

describe('the upload request, result and limits', () => {
  it('the request is a title and the archive, base64, and nothing the archive could use to name itself', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<ProjectUploadRequest, 'title' | 'archiveBase64'>,
      true satisfies HasExactlyKeys<
        ProjectUploadResult,
        'projectId' | 'versionId' | 'slug' | 'version' | 'compile' | 'validation'
      >,
      true satisfies HasExactlyKeys<ProjectUploadCompileSummary, 'phases' | 'tasks' | 'files' | 'sandboxBudget'>,
      true satisfies HasExactlyKeys<ProjectUploadRefusal, 'code' | 'sentence' | 'findings' | 'detail'>,
      true satisfies HasExactlyKeys<RunShapeFinding, 'code' | 'where' | 'sentence'>,
    ];
    expect(exact).toHaveLength(5);
    // @ts-expect-error the slug is minted from the title, never supplied
    const slugged: ProjectUploadRequest = { title: 'Shelf', archiveBase64: 'UEs=', slug: 'tasktrackr' };
    expect(slugged.title).toBe('Shelf');
  });

  it('caps an archive at 2,000 entries and a 100:1 ratio; the byte cap stays the import cap', () => {
    expect(PROJECT_UPLOAD_LIMITS).toEqual({ maxEntries: 2000, maxRatio: 100 });
    expect(Object.isFrozen(PROJECT_UPLOAD_LIMITS)).toBe(true);
    const exact: true = true satisfies HasExactlyKeys<typeof PROJECT_UPLOAD_LIMITS, 'maxEntries' | 'maxRatio'>;
    expect(exact).toBe(true);
  });

  it('names every attack of the hostile set with its own code', () => {
    expect([...UPLOAD_REFUSAL_CODES]).toEqual([
      'PATH_CLIMB',
      'SYMLINK',
      'DUPLICATE_NAME',
      'CASE_COLLISION',
      'NUL_IN_NAME',
      'RATIO_BOMB',
      'TOTAL_SIZE_BOMB',
      'TOO_MANY_ENTRIES',
      'ENCRYPTED_ENTRY',
      'ZIP64_OR_SIZE_MISMATCH',
      'CRC_MISMATCH',
      'RUNTIME_OUTSIDE_PROFILE',
      'RUN_LIMIT_ABOVE_LEARNER',
      'RUN_SHAPE_NOT_ALLOWED',
      'TWO_WORK_TASKS',
      'HIDDEN_IN_WORKSPACE',
      'SOLUTION_IN_EDITABLE',
      'CEILING_PER_PHASE',
      'CEILING_PER_VERSION',
      'RESERVED_NAME',
      'SECRET_FILE',
      'ARCHIVE_TOO_LARGE',
      'NOT_A_ZIP',
      // The door's other refusals, appended so no code moves.
      'NOT_A_PACK',
      'WARMUP_NOT_UPLOADABLE',
      'TITLE_INVALID',
      'UNSUPPORTED_ARCHIVE',
      'EMPTY_ARCHIVE',
      // Appended last, so no code moves.
      'ARCHIVE_NAME_TOO_LONG',
    ]);
    expect(Object.keys(UPLOAD_REFUSALS).sort()).toEqual([...UPLOAD_REFUSAL_CODES].sort());
  });

  it("ARCHIVE_NAME_TOO_LONG's sentence names the 1,024-byte and 64-folder limits and carries no archive text", () => {
    const sentence = UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG;
    expect(sentence).toContain('1,024 bytes');
    // The reader counts 64 parts including the file name.
    expect(sentence).toContain('64 parts');
    expect(sentence).toContain('nothing was imported');
    // A fixed string: no template hole, no quote, no path separator.
    expect(/\$\{|[{}<>"`]|%s|%d|\/|\\/.test(sentence)).toBe(false);
  });

  it("the name, ZIP64 and control-character sentences say only what the reader does", () => {
    // zip-reader.ts: a raw name over maxNameBytes (1,024) or more than
    // maxNameSegments (64) `/`-separated parts, the file name counted, is
    // ARCHIVE_NAME_TOO_LONG.
    expect(UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG).toBe(
      'An entry name in this archive is longer than 1,024 bytes or has more than 64 parts (folders and the file name), so nothing was imported.',
    );
    expect(UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG).toContain('more than 64 parts (folders and the file name)');
    // ZIP64 within the cap is read; only a ZIP64 size or offset beyond the cap
    // is refused (ARCHIVE_ZIP64), beside a size or local/central checksum the
    // entry does not have (ARCHIVE_SIZE_MISMATCH, ARCHIVE_DESCRIPTOR_MISMATCH).
    const zip64 = UPLOAD_REFUSALS.ZIP64_OR_SIZE_MISMATCH;
    expect(zip64).toBe(
      'An entry in this archive declares a size or checksum it does not have, or a large-archive (ZIP64) size or position beyond the upload limit, so nothing was imported.',
    );
    expect(/does not read|never read|not supported|cannot read/i.test(zip64)).toBe(false);
    expect(zip64).toContain('beyond the upload limit');
    // ARCHIVE_NAME_NUL refuses a raw 0x00 and any C0 control or DEL in the name.
    expect(UPLOAD_REFUSALS.NUL_IN_NAME).toBe(
      'An entry name in this archive holds a control character, such as a null, so nothing was imported.',
    );
    expect(UPLOAD_REFUSALS.NUL_IN_NAME).toContain('control character');
  });

  it('GUARD: the first 28 codes keep their index and their sentence byte-identical', () => {
    // The first 28 codes and their sentences; sha256 of
    // JSON.stringify([[code, sentence], ...]) in this order.
    const firstCodes = UPLOAD_REFUSAL_CODES.slice(0, 28);
    expect(firstCodes).toEqual(FIRST_UPLOAD_REFUSAL_CODES);
    const digest = createHash('sha256')
      .update(JSON.stringify(firstCodes.map((code) => [code, UPLOAD_REFUSALS[code]])))
      .digest('hex');
    // Any change to one of these codes, its index or its sentence moves this
    // digest, so rewording a sentence is a deliberate edit made here as well.
    expect(digest).toBe('543cbc46206ae70584905de2ede0de4e9b27bfe20f8ff8970ab3436b637606ee');
  });

  it('every refusal the door can answer is a shared code with its own true sentence', () => {
    // A zip that holds no project, a declared warm-up and a title that makes no
    // address are refusals of their own; the 4xx body's `code` is always one of
    // these, so `UPLOAD_REFUSALS[code]` is never undefined.
    const wire: ProjectUploadRefusal['code'][] = [
      'NOT_A_PACK',
      'WARMUP_NOT_UPLOADABLE',
      'TITLE_INVALID',
      'UNSUPPORTED_ARCHIVE',
      'EMPTY_ARCHIVE',
    ];
    for (const code of wire) expect([code, typeof UPLOAD_REFUSALS[code]]).toEqual([code, 'string']);
    expect(UPLOAD_REFUSALS.NOT_A_PACK).toContain('not a project');
    expect(UPLOAD_REFUSALS.WARMUP_NOT_UPLOADABLE).toContain('warm-up');
    expect(UPLOAD_REFUSALS.TITLE_INVALID).toContain('120 characters');
    // A real zip with an unread method or no entries is not called "not a zip".
    expect(UPLOAD_REFUSALS.UNSUPPORTED_ARCHIVE).not.toContain('not a zip');
    expect(UPLOAD_REFUSALS.EMPTY_ARCHIVE).not.toContain('not a zip');
    expect(UPLOAD_REFUSALS.UNSUPPORTED_ARCHIVE).toContain('stored and deflated');
    expect(UPLOAD_REFUSALS.EMPTY_ARCHIVE).toContain('no files');
  });

  it('files every run-shape finding under one upload code: a limit under RUN_LIMIT_ABOVE_LEARNER, the rest under RUN_SHAPE_NOT_ALLOWED', () => {
    const filed = RUN_SHAPE_REFUSAL_CODES.map((code) => `${code}>${uploadRefusalForRunShape(code)}`);
    expect(filed).toEqual([
      'RUN_FREEFORM_STRING>RUN_SHAPE_NOT_ALLOWED',
      'RUN_OWN_COMMAND>RUN_SHAPE_NOT_ALLOWED',
      'ARGV_INTERPRETER>RUN_SHAPE_NOT_ALLOWED',
      'ARGV_SCRIPT>RUN_SHAPE_NOT_ALLOWED',
      'ARGV_EXTRA>RUN_SHAPE_NOT_ALLOWED',
      'ARGV_SHELL>RUN_SHAPE_NOT_ALLOWED',
      'HARNESS_NOT_ALLOWED>RUN_SHAPE_NOT_ALLOWED',
      'HIDDEN_NOT_FILE>RUN_SHAPE_NOT_ALLOWED',
      'LIMIT_TIMEOUT>RUN_LIMIT_ABOVE_LEARNER',
      'LIMIT_MEMORY>RUN_LIMIT_ABOVE_LEARNER',
    ]);
    const code: UploadRefusalCode = uploadRefusalForRunShape('LIMIT_MEMORY');
    expect(code).toBe('RUN_LIMIT_ABOVE_LEARNER');
  });

  it('ProjectUploadRefusal may carry a detail of at most UPLOAD_REFUSAL_DETAIL_MAX (400) characters', () => {
    // NOT_A_PACK's loader text rides here, under the fixed sentence; the
    // sentence stays UPLOAD_REFUSALS[code].
    const pinned: true[] = [
      true satisfies IsOptional<ProjectUploadRefusal, 'detail'>,
      true satisfies Equals<ProjectUploadRefusal['detail'], string | undefined>,
      true satisfies Equals<typeof UPLOAD_REFUSAL_DETAIL_MAX, 400>,
    ];
    expect(pinned).toHaveLength(3);
    expect(UPLOAD_REFUSAL_DETAIL_MAX).toBe(400);
    const refused: ProjectUploadRefusal = {
      code: 'NOT_A_PACK',
      sentence: UPLOAD_REFUSALS.NOT_A_PACK,
      findings: [],
      detail: 'x'.repeat(UPLOAD_REFUSAL_DETAIL_MAX),
    };
    const bare: ProjectUploadRefusal = { code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, findings: [] };
    expect([refused.detail?.length, bare.detail]).toEqual([400, undefined]);
  });

  it('two work tasks in an executable phase are refused by the wall that already exists', () => {
    expect(UPLOAD_REFUSALS.TWO_WORK_TASKS).toContain('Several tasks in a coding, testing or deployment phase arrive next.');
  });
});

/* ---------------------------- the run-shape rule ---------------------------- */

describe('the run-shape closed list', () => {
  it('RUN_SHAPES lists exactly the seven run shapes', () => {
    const said = RUN_SHAPES.map((shape) => {
      if (shape.kind === 'test-run') {
        return `${shape.id}: run ${shape.language} ${shape.harness} hidden=${shape.hiddenHarness} transform=${shape.transform} warmup=${shape.warmup}`;
      }
      if (shape.kind === 'drill') return `${shape.id}: drill faultedFiles only`;
      return `${shape.id}: ${shape.kind} [${shape.interpreter}, <${shape.script}>${shape.extraArgs.map((one) => `, ${one}`).join('')}] at ${shape.sites.join(' + ')}`;
    });
    expect(said).toEqual([
      'run-python-hidden: run python pytest hidden=unittest transform=false warmup=false',
      'run-typescript-hidden: run typescript js hidden=js transform=true warmup=false',
      'run-python: run python pytest hidden=null transform=false warmup=false',
      'run-typescript: run typescript js hidden=null transform=true warmup=true',
      'smoke-python: smoke [python3, <smoke-impl-file>, --selfcheck] at checks.smoke.commands',
      'preview-python: preview [python3, <shipped-file>] at preview.service.command + preview.seed',
      'drill-faulted-files: drill faultedFiles only',
    ]);
    const ids: RunShapeId[] = RUN_SHAPES.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(7);
  });

  it('lists the ten refusal codes, each with its sentence, and the command keys a pack may not declare', () => {
    expect([...RUN_SHAPE_REFUSAL_CODES]).toEqual([
      'RUN_FREEFORM_STRING',
      'RUN_OWN_COMMAND',
      'ARGV_INTERPRETER',
      'ARGV_SCRIPT',
      'ARGV_EXTRA',
      'ARGV_SHELL',
      'HARNESS_NOT_ALLOWED',
      'HIDDEN_NOT_FILE',
      'LIMIT_TIMEOUT',
      'LIMIT_MEMORY',
    ]);
    expect(Object.keys(RUN_SHAPE_REFUSALS).sort()).toEqual([...RUN_SHAPE_REFUSAL_CODES].sort());
    expect([...RUN_SHAPE_COMMAND_KEYS]).toEqual([
      'command',
      'commands',
      'cmd',
      'argv',
      'shell',
      'script',
      'entrypoint',
      'exec',
      'run',
    ]);
  });

  it("never lets a pack ask for more than a learner's run gets: 15 seconds, 256 MB", () => {
    expect(LEARNER_RUN_LIMITS).toEqual({ timeoutSeconds: 15, memoryMb: 256 });
    expect(Object.isFrozen(LEARNER_RUN_LIMITS)).toBe(true);
    expect(RUN_SHAPE_REFUSALS.LIMIT_TIMEOUT).toContain('15 seconds');
    expect(RUN_SHAPE_REFUSALS.LIMIT_MEMORY).toContain('256 MB');
  });

  it('freezes the closed lists at runtime, not only in their types', () => {
    const lists: [string, object][] = [
      ['RUN_SHAPES', RUN_SHAPES],
      ...RUN_SHAPES.map((shape): [string, object] => [shape.id, shape]),
      ...RUN_SHAPES.flatMap((shape): [string, object][] =>
        shape.kind === 'smoke' || shape.kind === 'preview'
          ? [
              [`${shape.id}.extraArgs`, shape.extraArgs],
              [`${shape.id}.sites`, shape.sites],
            ]
          : [],
      ),
      ['RUN_SHAPE_COMMAND_KEYS', RUN_SHAPE_COMMAND_KEYS],
      ['RUN_SHAPE_REFUSAL_CODES', RUN_SHAPE_REFUSAL_CODES],
      ['UPLOAD_REFUSAL_CODES', UPLOAD_REFUSAL_CODES],
      ['SEALED_ROLE_KINDS', SEALED_ROLE_KINDS],
      ['DEEP_VALIDATION_CHECK_IDS', DEEP_VALIDATION_CHECK_IDS],
      ['DEEP_VALIDATION_STATUSES', DEEP_VALIDATION_STATUSES],
      ['EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES', EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES],
    ];
    for (const [name, list] of lists) expect([name, Object.isFrozen(list)]).toEqual([name, true]);
  });
});

/* ------------------------------- the sentences ------------------------------ */

describe('the refusal sentences echo nothing from the archive', () => {
  // Built inside the test, so a missing export is this test's failure.
  const all = (): [string, string][] => [
    ...UPLOAD_REFUSAL_CODES.map((code): [string, string] => [code, UPLOAD_REFUSALS[code]]),
    ...RUN_SHAPE_REFUSAL_CODES.map((code): [string, string] => [code, RUN_SHAPE_REFUSALS[code]]),
    ...RUN_SHAPES.map((shape): [string, string] => [shape.id, shape.summary]),
  ];

  it('every UPLOAD_REFUSALS and RUN_SHAPE sentence is non-empty and has no byte or path placeholder', () => {
    const sentences = all();
    expect(sentences).toHaveLength(29 + 10 + 7);
    for (const [code, sentence] of sentences) {
      expect([code, typeof sentence === 'string' && sentence.trim().length > 20]).toEqual([code, true]);
      // No template hole, no format directive, no quoted name, no path.
      expect([code, /\$\{|[{}<>"`]|%s|%d|\/|\\/.test(sentence)]).toEqual([code, false]);
      // Opens as a sentence, ends as one, and uses no middle dot or pipe (the web copy rules).
      expect([code, /^[A-Z]/.test(sentence), sentence.endsWith('.'), /[·|]/.test(sentence)]).toEqual([
        code,
        true,
        true,
        false,
      ]);
    }
  });

  it('no sentence names the reference project, so a reserved-name refusal does not advertise one', () => {
    for (const [code, sentence] of all()) expect([code, /tasktrackr/i.test(sentence)]).toEqual([code, false]);
  });
});

/* --------------------------- the runtime profile --------------------------- */

describe('one runtime profile', () => {
  it('RUNTIME_PROFILES has exactly one entry', () => {
    expect(RUNTIME_PROFILES).toHaveLength(1);
    expect(RUNTIME_PROFILES[0]).toEqual({ id: 'baked', name: 'Baked runtime', sentence: SUPPORTED_STACKS_SENTENCE });
    const one: true = true satisfies Equals<RuntimeProfileId, 'baked'>;
    expect(one).toBe(true);
  });

  it('the view is the baked allow-lists, named with the manifest digest, and nothing else', () => {
    const exact: true = true satisfies HasExactlyKeys<
      RuntimeProfileView,
      'id' | 'name' | 'manifestSha256' | 'python' | 'node' | 'tools' | 'sentence' | 'uploadMaxBytes'
    >;
    const view: RuntimeProfileView = {
      id: 'baked',
      name: 'Baked runtime',
      manifestSha256: 'a'.repeat(64),
      python: ['flask'],
      node: ['react'],
      tools: ['esbuild'],
      sentence: SUPPORTED_STACKS_SENTENCE,
    };
    // @ts-expect-error there is no second profile
    const other: RuntimeProfileId = 'gpu';
    expect([exact, view.id, other]).toEqual([true, 'baked', 'gpu']);
  });

  it('RuntimeProfileView may carry uploadMaxBytes, the archive cap in bytes', () => {
    // Optional, so an answer without it still reads; the web then falls back to COHORT_IMPORT_MAX_BYTES.
    const pinned: true[] = [
      true satisfies IsOptional<RuntimeProfileView, 'uploadMaxBytes'>,
      true satisfies Equals<RuntimeProfileView['uploadMaxBytes'], number | undefined>,
    ];
    const capped: RuntimeProfileView = {
      id: 'baked',
      name: 'Baked runtime',
      manifestSha256: 'a'.repeat(64),
      python: [],
      node: [],
      tools: [],
      sentence: SUPPORTED_STACKS_SENTENCE,
      uploadMaxBytes: 32 * 1024 * 1024,
    };
    expect([pinned.length, capped.uploadMaxBytes]).toEqual([2, 33554432]);
  });
});

/* ----------------------------- the ceiling ---------------------------------- */

describe('the budget ceiling', () => {
  it('BUDGET_CEILING is {10, 24}, and the upload refusals say the same numbers', () => {
    expect(BUDGET_CEILING).toEqual({ perPhase: 10, perVersion: 24 });
    expect(Object.isFrozen(BUDGET_CEILING)).toBe(true);
    const exact: true = true satisfies HasExactlyKeys<typeof BUDGET_CEILING, 'perPhase' | 'perVersion'>;
    // TaskTrackr's own price is 20 with no phase above 10, so it fits as it stands.
    expect(20).toBeLessThanOrEqual(BUDGET_CEILING.perVersion);
    expect(UPLOAD_REFUSALS.CEILING_PER_PHASE).toContain('more than 10 microVMs');
    expect(UPLOAD_REFUSALS.CEILING_PER_VERSION).toContain('more than 24 microVMs');
    expect(UPLOAD_REFUSALS.TOO_MANY_ENTRIES).toContain('more than 2,000 entries');
    expect(exact).toBe(true);
  });

  it('a refusal names the phase and the count, or the version and the count', () => {
    expect(budgetCeilingRefusal(12, 'Testing')).toBe(
      'Testing would boot 12 microVMs for one full pass, and a phase may boot at most 10. Remove runs or mutants from Testing to publish this version.',
    );
    expect(budgetCeilingRefusal(25, null)).toBe(
      'This version would boot 25 microVMs for one full pass, and a version may boot at most 24. Remove runs or mutants to publish it.',
    );
  });
});

/* ------------------------- the executable task DTOs ------------------------- */

describe('the executable task, with sealed roles as write-only inputs', () => {
  it('EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES and its predicate arrive from the index', () => {
    expect(EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES).toEqual(['code', 'tests']);
    expect(isAuthorableExecutableTask('code', 'code')).toBe(true);
    expect(isAuthorableExecutableTask('tests', 'code')).toBe(false);
  });

  it('a sealed view is exactly a path, a digest and a size: there is no field for its bytes', () => {
    expect([...SEALED_ROLE_KINDS]).toEqual(['hidden', 'solution', 'mutant']);
    const exact: true[] = [
      true satisfies HasExactlyKeys<SealedFileView, 'path' | 'sha256' | 'bytes'>,
      true satisfies HasExactlyKeys<SealedFileWriteBody, 'role' | 'runId' | 'path' | 'contentBase64'>,
      true satisfies HasExactlyKeys<SealedFileOwnerRead, 'role' | 'runId' | 'path' | 'sha256' | 'bytes' | 'contentBase64'>,
      true satisfies HasExactlyKeys<SealedFileReadQuery, 'role' | 'path' | 'runId'>,
    ];
    expect(exact).toHaveLength(4);
    // @ts-expect-error a view never carries content
    const leaked: SealedFileView = { path: 'tests/hidden/test_api.py', sha256: 'a'.repeat(64), bytes: 10, content: 'x' };
    expect(leaked.bytes).toBe(10);
  });

  it('the task view and the run view are pinned member for member, and carry digests, never bytes', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<
        ExecutableTaskView,
        | 'taskKey'
        | 'checkKind'
        | 'artefactType'
        | 'owns'
        | 'profile'
        | 'runs'
        | 'minTests'
        | 'coverageKeywords'
        | 'solution'
        | 'mutants'
        | 'sandboxBudget'
      >,
      true satisfies HasExactlyKeys<
        ExecutableRunView,
        'id' | 'shape' | 'label' | 'testPaths' | 'visibleTests' | 'learnerTestFiles' | 'hidden'
      >,
      true satisfies HasExactlyKeys<
        ExecutableRunBody,
        'id' | 'shape' | 'label' | 'testPaths' | 'visibleTests' | 'learnerTestFiles'
      >,
      true satisfies HasExactlyKeys<UpdateExecutableTaskBody, 'owns' | 'runs' | 'minTests' | 'coverageKeywords'>,
    ];
    expect(exact).toHaveLength(4);
    const digest = { path: 'tests/hidden/test_api.py', sha256: 'b'.repeat(64), bytes: 812 };
    const view: ExecutableTaskView = {
      taskKey: 'main',
      checkKind: 'code',
      artefactType: 'code',
      owns: ['api/app.py'],
      profile: 'baked',
      runs: [
        {
          id: 'api',
          shape: 'run-python-hidden',
          label: 'API tests',
          testPaths: ['tests'],
          visibleTests: ['tests/test_visible.py'],
          learnerTestFiles: [],
          hidden: [digest],
        },
      ],
      minTests: null,
      coverageKeywords: [],
      solution: [{ ...digest, path: 'api/app.py' }],
      mutants: [],
      sandboxBudget: 2,
    };
    const wire = JSON.stringify(view);
    expect(wire).not.toContain('content');
    expect(wire).not.toContain('Base64');
    // A test run takes only a test-run shape: a command shape is not a run.
    // @ts-expect-error a smoke command is not a test run's shape
    const smokeRun: ExecutableRunBody['shape'] = 'smoke-python';
    expect(smokeRun).toBe('smoke-python');
    // Every edit is optional, and the sealed roles are not members: they go through the sealed write.
    const optional: true[] = [
      true satisfies IsOptional<UpdateExecutableTaskBody, 'owns'>,
      true satisfies IsOptional<UpdateExecutableTaskBody, 'runs'>,
      true satisfies IsOptional<UpdateExecutableTaskBody, 'minTests'>,
      true satisfies IsOptional<UpdateExecutableTaskBody, 'coverageKeywords'>,
    ];
    expect(optional).toHaveLength(4);
  });

  it("the draft's task row carries the executable view, and tasks.update carries the editor's write", () => {
    // Read: an optional member of the row the draft already sends, absent on
    // every task the executable editor does not open.
    const read: true[] = [
      true satisfies IsOptional<DraftTaskView, 'executable'>,
      true satisfies Equals<NonNullable<DraftTaskView['executable']>, ExecutableTaskView>,
    ];
    // Write: `UpdateExecutableTaskBody`'s members on `UpdateTaskBody`, each
    // optional and each the very type the executable body declares, so the
    // editor's save goes through `tasks.update` and no member is a second shape.
    const write: true[] = [
      true satisfies IsOptional<UpdateTaskBody, 'owns'>,
      true satisfies IsOptional<UpdateTaskBody, 'runs'>,
      true satisfies IsOptional<UpdateTaskBody, 'minTests'>,
      true satisfies IsOptional<UpdateTaskBody, 'coverageKeywords'>,
      true satisfies Equals<
        Required<Pick<UpdateTaskBody, keyof UpdateExecutableTaskBody>>,
        Required<UpdateExecutableTaskBody>
      >,
    ];
    expect([read.length, write.length]).toEqual([2, 5]);
    const save: UpdateTaskBody = {
      brief: 'Build the shelf API.',
      owns: ['api/app.py'],
      runs: [
        {
          id: 'api',
          shape: 'run-python-hidden',
          label: 'API tests',
          testPaths: ['tests'],
          visibleTests: ['tests/test_visible.py'],
          learnerTestFiles: [],
        },
      ],
      minTests: null,
      coverageKeywords: [],
    };
    // The sealed roles are still not members of the write: they go through `sealed.write`.
    // @ts-expect-error a hidden suite is never a member of the task save
    const sealed: UpdateTaskBody = { hidden: [{ path: 'tests/hidden/test_api.py', contentBase64: 'eA==' }] };
    expect([Object.keys(save).length, Object.keys(sealed)]).toEqual([5, ['hidden']]);
    // The editor's save goes through the one task route there is.
    expect(AUTHORING_ROUTES['tasks.update']).toMatchObject({ method: 'PATCH', path: TASK, mutates: true });
  });
});

/* ----------------------------- deep validation ------------------------------ */

describe('deep validation and its cost warning', () => {
  it('names the four checks a to d, and the five states', () => {
    expect([...DEEP_VALIDATION_CHECK_IDS]).toEqual([
      'solution-passes-hidden',
      'starter-fails-hidden',
      'mutants-killed',
      'smoke-passes',
    ]);
    expect([...DEEP_VALIDATION_STATUSES]).toEqual(['not-run', 'queued', 'running', 'passed', 'failed']);
  });

  it('the view, the warning and the receipt are pinned member for member', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<
        DeepValidationView,
        'versionId' | 'status' | 'current' | 'contentDigest' | 'checks' | 'costWarning' | 'startedAt' | 'finishedAt'
      >,
      true satisfies HasExactlyKeys<DeepValidationCostWarning, 'microVMs' | 'sentence'>,
      // The start names the count the teacher was shown, so a run never costs more than the warning said.
      true satisfies HasExactlyKeys<DeepValidationStartBody, 'acknowledgedMicroVMs'>,
      true satisfies HasExactlyKeys<DeepValidationCheckView, 'id' | 'status' | 'sentence' | 'phaseKey' | 'taskKey'>,
      true satisfies HasExactlyKeys<
        DeepValidationReceipt,
        'contentDigest' | 'status' | 'checks' | 'microVMs' | 'startedAt' | 'finishedAt'
      >,
    ];
    expect(exact).toHaveLength(5);
  });

  it("ProjectVersionValidation gains deep, optional, beside the fast report's three fields", () => {
    const optional: true = true satisfies IsOptional<ProjectVersionValidation, 'deep'>;
    const exact: true = true satisfies HasExactlyKeys<ProjectVersionValidation, 'findings' | 'tier' | 'when' | 'deep'>;
    const fast: ProjectVersionValidation = { findings: [], tier: 'fast', when: '2026-10-02T01:00:00.000Z' };
    expect([optional, exact, fast.deep]).toEqual([true, true, undefined]);
  });

  it('the cost warning states microVMs, never money', () => {
    expect(deepValidationCostWarning(1)).toBe(
      'Deep validation boots 1 microVM in the sandbox, one at a time, and asks no AI model. You can run one deep validation at a time.',
    );
    expect(deepValidationCostWarning(14)).toBe(
      'Deep validation boots 14 microVMs in the sandbox, one at a time, and asks no AI model. You can run one deep validation at a time.',
    );
    for (const count of [0, 1, 2, 10, 24]) {
      const sentence = deepValidationCostWarning(count);
      expect(sentence).toMatch(/microVM/);
      expect(sentence).not.toMatch(/[$€£¥]|\b(usd|sgd|dollar|cent|price|cost|credit|bill)/i);
    }
  });
});

/* ========================== the version export key ========================== */

import { type AuditEventView as ExportAuditEventView } from './index';

describe('the export route and its audit name', () => {
  it('exports a version as a read that leaves a project.exported row', () => {
    expect(AUTHORING_ROUTE_KEYS).toContain('version.export');
    expect(AUTHORING_ROUTES['version.export']).toMatchObject({
      method: 'GET',
      path: `${VERSION}/export`,
      mutates: false,
      audit: null,
    });
    expect(AUTHORING_AUDIT_EVENTS).toContain('project.exported');
    const name: ExportAuditEventView['event'] = 'project.exported';
    expect(name).toBe('project.exported');
  });
});

/* ------------------------------ one row per key ------------------------------ */

describe('route keys and the authoring table stay one-to-one', () => {
  it('every key has exactly one row, and every row a key', () => {
    expect(Object.keys(AUTHORING_ROUTES).sort()).toEqual([...AUTHORING_ROUTE_KEYS].sort());
  });
});

/* =================== the sign-off table, never authoring =================== */

import {
  SIGNOFF_ROUTES,
  SIGNOFF_ROUTE_KEYS,
  type BulkSignoffBody,
  type BulkSignoffResult,
  type SignoffQueueRow,
  type SignoffQueueView,
  type SignoffRouteKey,
} from './index';

describe('the sign-off routes, a separate table', () => {
  it('SIGNOFF_ROUTES keys are disjoint from AuthoringRouteKey', () => {
    expect([...SIGNOFF_ROUTE_KEYS]).toEqual(['signoff.queue', 'signoff.bulk']);
    expect(Object.keys(SIGNOFF_ROUTES).sort()).toEqual([...SIGNOFF_ROUTE_KEYS].sort());
    for (const key of SIGNOFF_ROUTE_KEYS) {
      expect([key, (AUTHORING_ROUTE_KEYS as readonly string[]).includes(key)]).toEqual([key, false]);
    }
    const disjoint: true = true satisfies Equals<Extract<SignoffRouteKey, AuthoringRouteKey>, never>;
    expect(disjoint).toBe(true);
  });

  it('reads the queue and signs off in bulk on the class, staff only, leaving one class.bulk-signoff name', () => {
    expect(SIGNOFF_ROUTES['signoff.queue']).toMatchObject({
      method: 'GET',
      path: '/instructor/cohorts/:cohortId/signoff-queue',
      mutates: false,
      audit: null,
    });
    expect(SIGNOFF_ROUTES['signoff.bulk']).toMatchObject({
      method: 'POST',
      path: '/instructor/cohorts/:cohortId/signoff',
      mutates: true,
      audit: 'class.bulk-signoff',
    });
    for (const key of SIGNOFF_ROUTE_KEYS) {
      expect([...SIGNOFF_ROUTES[key].roles].sort()).toEqual(['ADMIN', 'INSTRUCTOR']);
    }
    expect(AUTHORING_AUDIT_EVENTS).toContain('class.bulk-signoff');
    const name: AuditEventView['event'] = 'class.bulk-signoff';
    expect(name).toBe('class.bulk-signoff');
  });

  it('one task, one reason, many learners', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<BulkSignoffBody, 'phaseKey' | 'taskKey' | 'userIds' | 'reason'>,
      true satisfies HasExactlyKeys<BulkSignoffResult, 'signedOff' | 'refused'>,
      true satisfies HasExactlyKeys<BulkSignoffResult['refused'][number], 'userId' | 'sentence'>,
      true satisfies HasExactlyKeys<SignoffQueueView, 'cohortId' | 'rows'>,
      true satisfies HasExactlyKeys<
        SignoffQueueRow,
        'userId' | 'learnerName' | 'phaseKey' | 'taskKey' | 'taskTitle' | 'awaitingSince'
      >,
    ];
    expect(exact).toHaveLength(5);
  });

  it('freezes the sign-off table and its rows at runtime', () => {
    expect(Object.isFrozen(SIGNOFF_ROUTES)).toBe(true);
    expect(Object.isFrozen(SIGNOFF_ROUTE_KEYS)).toBe(true);
    for (const key of SIGNOFF_ROUTE_KEYS) expect([key, Object.isFrozen(SIGNOFF_ROUTES[key])]).toEqual([key, true]);
  });
});

/* ----------------------- the contract's own bookkeeping --------------------- */

describe('the source of this contract', () => {
  it('every upload-contract export above arrives from the one index the API and the web read', () => {
    expect(typeof uploadRefusalForRunShape).toBe('function');
    expect(typeof budgetCeilingRefusal).toBe('function');
  });
});

/* ===================== the quiz-results export kinds ===================== */

import { QUIZ_RESULTS_EXPORT_KINDS, type QuizResultsExportKind } from './index';

describe('the quiz-results export kinds', () => {
  it('names the four files, in order', () => {
    expect([...QUIZ_RESULTS_EXPORT_KINDS]).toEqual(['learners', 'attempts', 'questions', 'class']);
    expect(Object.isFrozen(QUIZ_RESULTS_EXPORT_KINDS)).toBe(true);
    const kind: QuizResultsExportKind = 'questions';
    // @ts-expect-error there is no answer-key export
    const key: QuizResultsExportKind = 'key';
    expect([kind, key]).toEqual(['questions', 'key']);
  });
});

/* ====== a task's sign-off mark, and an own phase's reference name ====== */

import { type PhaseProvenanceView } from './index';

describe('the sign-off mark on a task, and an own phase\'s provenance', () => {
  it('a task edit may mark or unmark sign-off, and a draft task view says whether it waits for one', () => {
    const body: UpdateTaskBody = { signOff: true };
    const view: Pick<DraftTaskView, 'signOff'> = { signOff: false };
    expect(body.signOff).toBe(true);
    expect(view.signOff).toBe(false);
    // Optional on both: absent means unchanged (the edit) and false (the view).
    const unchanged: UpdateTaskBody = {};
    const older: Pick<DraftTaskView, 'signOff'> = {};
    expect([unchanged.signOff, older.signOff ?? false]).toEqual([undefined, false]);
  });

  it("an own phase's provenance names no reference project", () => {
    const name: PhaseProvenanceView['referenceName'] = null;
    expect(name).toBeNull();
    const reference: PhaseProvenanceView['referenceName'] = 'TaskTrackr';
    expect(reference).toBe('TaskTrackr');
  });
});

/* ===== the same two members, pinned exactly, so a loosening fails ===== */

describe('the sign-off mark, pinned exactly', () => {
  it('signOff is an optional boolean on the edit and on the draft task view, and nothing wider', () => {
    const pins: true[] = [
      true satisfies IsOptional<UpdateTaskBody, 'signOff'>,
      true satisfies IsOptional<DraftTaskView, 'signOff'>,
      true satisfies Equals<NonNullable<UpdateTaskBody['signOff']>, boolean>,
      true satisfies Equals<NonNullable<DraftTaskView['signOff']>, boolean>,
    ];
    expect(pins).toHaveLength(4);
    // @ts-expect-error sign-off is a boolean, not a label
    const label: UpdateTaskBody = { signOff: 'yes' };
    expect(label.signOff).toBe('yes');
  });

  it('referenceName stays a required member, exactly string | null', () => {
    const exact = true satisfies Equals<PhaseProvenanceView['referenceName'], string | null>;
    const required = false satisfies IsOptional<PhaseProvenanceView, 'referenceName'>;
    expect([exact, required]).toEqual([true, false]);
    // @ts-expect-error an own phase says null, never leaves the member out
    const missing: Pick<PhaseProvenanceView, 'referenceName'> = {};
    expect(missing.referenceName).toBeUndefined();
  });
});
