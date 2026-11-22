/**
 * The project model's contract.
 *
 * Two kinds of fact are asserted here and nothing else: the closed sets a
 * teacher-authored project's rows are written from, and the two conventions the
 * task grain rests on. Every one of them is read elsewhere, by the
 * compiler, the importer, the entities, the export, so a silent widening of a
 * set, or a second copy of a convention, fails here rather than in the code
 * that trusted it.
 *
 * The export version is asserted in this file rather than beside the importer
 * because the constant is the contract: `readDocument` refuses a file whose
 * `formatVersion` is greater than it (`readDocument` in `portability.service.ts`), so the
 * number here decides which files that machine will read. The refusal sentence
 * itself is the importer's own suite to assert; what is asserted here is the
 * number it compares against, and that the comparison's two neighbours fall on
 * the right sides of it.
 */

import {
  COHORT_EXPORT_FORMAT,
  COHORT_EXPORT_VERSION,
  type CohortExportEnrollment,
  type EnrollmentView,
} from './index';
import {
  ARTEFACT_TYPES,
  EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES,
  PHASE_ARTEFACT_TYPE_SUGGESTION,
  PROJECT_FILE_OWNER_KINDS,
  PROJECT_FILE_ROLES,
  PROJECT_ORIGINS,
  PROJECT_VERSION_PATTERN,
  PROJECT_VERSION_STATUSES,
  SEALED_FILE_ROLES,
  SOLE_TASK_KEY,
  TASK_KEY_PATTERN,
  WORKSPACE_FORBIDDEN_BLOB_ROLES,
  artefactTypeFor,
  compareProjectVersions,
  isAuthoredTaskKey,
  isProjectVersion,
  isSealedFileRole,
} from './projects';

describe('the class export version', () => {
  it('COHORT_EXPORT_VERSION is 3', () => {
    // Version 3 carries a phase's task rows and a revision's task key; the
    // number moves with the fields rather than after them.
    expect(COHORT_EXPORT_VERSION).toBe(3);
  });

  it('refuses a formatVersion of 4 and reads a formatVersion of 3', () => {
    // The guard readDocument applies, at the new number: anything greater than
    // this build's version is a file this build must not read, and its own
    // version is not.
    const newer = (formatVersion: number): boolean =>
      Number(formatVersion) > COHORT_EXPORT_VERSION;
    expect(newer(4)).toBe(true);
    expect(newer(3)).toBe(false);
    expect(newer(2)).toBe(false);
    expect(newer(1)).toBe(false);
  });

  it('the format literal does not move with the version', () => {
    expect(COHORT_EXPORT_FORMAT).toBe('learnsdlc.cohort');
  });
});

describe('the pin on the two views that carry it', () => {
  it('an enrolment view carries the pinned version id beside the stamped string', () => {
    const view: Pick<EnrollmentView, 'packVersion' | 'projectVersionId'> = {
      packVersion: '2.0.1',
      projectVersionId: '11111111-1111-4111-8111-111111111111',
    };
    expect(view.projectVersionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('a legacy body carries neither, so both are optional', () => {
    const view: Pick<EnrollmentView, 'packVersion' | 'projectVersionId'> = {};
    expect(view.projectVersionId).toBeUndefined();
  });

  it('an exported enrolment carries the pinned version as a string', () => {
    // Ids are stripped from an export, so the pin travels as the version the
    // destination resolves against its own published rows.
    const exported: Pick<
      CohortExportEnrollment,
      'projectSlug' | 'packVersion' | 'projectVersion'
    > = {
      projectSlug: 'tasktrackr',
      packVersion: '2.0.1',
      projectVersion: '2.0.1',
    };
    expect(exported.projectVersion).toBe('2.0.1');
  });

  it('a version-1 file carries no projectVersion at all', () => {
    const exported: Pick<CohortExportEnrollment, 'projectVersion'> = {};
    expect(exported.projectVersion).toBeUndefined();
  });
});

describe('the vocabulary a project row is written from', () => {
  it('a project has four origins, one per door', () => {
    expect(PROJECT_ORIGINS).toEqual(['seed', 'fork', 'upload', 'blank']);
  });

  it('a version is a draft, published or archived, and nothing else', () => {
    expect(PROJECT_VERSION_STATUSES).toEqual([
      'draft',
      'published',
      'archived',
    ]);
  });

  it('a file belongs to the project, a phase or a task', () => {
    expect(PROJECT_FILE_OWNER_KINDS).toEqual(['project', 'phase', 'task']);
  });

  it('a file has ten roles, and every role a rule names is one of them', () => {
    expect(PROJECT_FILE_ROLES).toEqual([
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
    ]);
    for (const role of [
      ...SEALED_FILE_ROLES,
      ...WORKSPACE_FORBIDDEN_BLOB_ROLES,
      ...EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES,
    ]) {
      expect(PROJECT_FILE_ROLES).toContain(role);
    }
  });
});

describe('a role is a property of (version, phase, path), not of bytes', () => {
  it('the sealed roles are the seven no learner-facing response may carry', () => {
    expect(SEALED_FILE_ROLES).toEqual([
      'hidden',
      'solution',
      'reference',
      'mutant',
      'support',
      'drill',
      'interview',
    ]);
    expect(isSealedFileRole('hidden')).toBe(true);
    expect(isSealedFileRole('workspace')).toBe(false);
    expect(isSealedFileRole('canonical')).toBe(false);
    expect(isSealedFileRole('warmup')).toBe(false);
  });

  it('no workspace row may hold bytes this version also seals as a test, a mutant, a drill, an interview or a support file', () => {
    expect(WORKSPACE_FORBIDDEN_BLOB_ROLES).toEqual([
      'hidden',
      'mutant',
      'drill',
      'interview',
      'support',
    ]);
  });

  it('and solution and reference are deliberately not in that set, because five shas of the default project are both a locked workspace row and a sealed solution file', () => {
    expect(WORKSPACE_FORBIDDEN_BLOB_ROLES).not.toContain('solution');
    expect(WORKSPACE_FORBIDDEN_BLOB_ROLES).not.toContain('reference');
    expect(WORKSPACE_FORBIDDEN_BLOB_ROLES).not.toContain('canonical');
  });

  it('an editable workspace row may hold neither sealed bytes nor the answer', () => {
    expect([...EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES].sort()).toEqual(
      [...SEALED_FILE_ROLES, 'canonical'].sort(),
    );
    expect(EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES).toContain('solution');
    expect(EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES).toContain('canonical');
  });

  it('the editable rule is the stricter of the two', () => {
    for (const role of WORKSPACE_FORBIDDEN_BLOB_ROLES) {
      expect(EDITABLE_WORKSPACE_FORBIDDEN_BLOB_ROLES).toContain(role);
    }
  });
});

describe('a project version string', () => {
  it('is MAJOR.MINOR.PATCH and nothing else', () => {
    expect(isProjectVersion('2.0.1')).toBe(true);
    expect(isProjectVersion('10.20.30')).toBe(true);
    expect(isProjectVersion('2.0')).toBe(false);
    expect(isProjectVersion('2.0.1.1')).toBe(false);
    expect(isProjectVersion('v2.0.1')).toBe(false);
    expect(isProjectVersion('2.0.1-beta')).toBe(false);
    expect(isProjectVersion('')).toBe(false);
    expect(PROJECT_VERSION_PATTERN.test('2.0.1')).toBe(true);
  });

  it('orders field by field as numbers, so 2.0.10 is newer than 2.0.9', () => {
    expect(compareProjectVersions('2.0.10', '2.0.9')).toBeGreaterThan(0);
    expect(compareProjectVersions('2.0.9', '2.0.10')).toBeLessThan(0);
    expect(compareProjectVersions('2.0.2', '2.0.1')).toBeGreaterThan(0);
    expect(compareProjectVersions('2.1.0', '2.0.99')).toBeGreaterThan(0);
    expect(compareProjectVersions('3.0.0', '2.99.99')).toBeGreaterThan(0);
    expect(compareProjectVersions('2.0.1', '2.0.1')).toBe(0);
  });

  it('never lets a string that is not a version be the newest', () => {
    expect(compareProjectVersions('two', '0.0.0')).toBeLessThan(0);
    expect(compareProjectVersions('0.0.0', 'two')).toBeGreaterThan(0);
    expect(compareProjectVersions('two', 'three')).toBe(0);
  });

  it('sorts a list of published versions into the head', () => {
    const published = ['2.0.1', '2.0.10', '2.0.9', '1.9.0'];
    const head = [...published].sort(compareProjectVersions).pop();
    expect(head).toBe('2.0.10');
  });
});

describe('the task grain', () => {
  it('the sole task of a phase that declares none is keyed the empty string', () => {
    // The platform's own convention, not an invention: a phase declaring no
    // runs already gets one synthesised run keyed ''.
    expect(SOLE_TASK_KEY).toBe('');
  });

  it('an authored key is lower case, starts with a letter and is at most 32 characters', () => {
    expect(isAuthoredTaskKey('api')).toBe(true);
    expect(isAuthoredTaskKey('a')).toBe(true);
    expect(isAuthoredTaskKey('front-end-2')).toBe(true);
    expect(isAuthoredTaskKey('a'.repeat(32))).toBe(true);
    expect(isAuthoredTaskKey('a'.repeat(33))).toBe(false);
    expect(isAuthoredTaskKey('API')).toBe(false);
    expect(isAuthoredTaskKey('1api')).toBe(false);
    expect(isAuthoredTaskKey('-api')).toBe(false);
    expect(isAuthoredTaskKey('api_two')).toBe(false);
    expect(isAuthoredTaskKey('api two')).toBe(false);
    expect(TASK_KEY_PATTERN.test('api')).toBe(true);
  });

  it('the sole key is not an authored key, so the two can never be confused', () => {
    expect(isAuthoredTaskKey(SOLE_TASK_KEY)).toBe(false);
  });
});

describe('artefact types', () => {
  it('there are nine, and the list is closed', () => {
    // `quiz` is appended, never inserted. The eight before it keep their
    // order, because this list is what the
    // compiler's `artefact-type-is-known` refusal reads its sentence off and
    // what the authoring DTO's `@IsIn` validates against.
    expect(ARTEFACT_TYPES).toEqual([
      'user-story',
      'design-doc',
      'api-contract',
      'code',
      'tests',
      'runbook',
      'change-request',
      'document',
      'quiz',
    ]);
  });

  it('the phase-kind suggestions name one type for each of the six phases', () => {
    expect(PHASE_ARTEFACT_TYPE_SUGGESTION).toEqual({
      requirements: 'user-story',
      design: 'design-doc',
      implementation: 'code',
      testing: 'tests',
      deployment: 'runbook',
      maintenance: 'code',
    });
    for (const type of Object.values(PHASE_ARTEFACT_TYPE_SUGGESTION)) {
      expect(ARTEFACT_TYPES).toContain(type);
    }
  });

  it('types a task by its kind alone', () => {
    expect(['story', 'design', 'code', 'tests', 'config', 'quiz'].map((kind) => artefactTypeFor(kind as never, 'maintenance'))).toEqual(['user-story', 'design-doc', 'code', 'tests', 'runbook', 'quiz']);
    expect(artefactTypeFor('markdown' as never, 'testing')).toBe('document');
    expect(() => artefactTypeFor('prose' as never, 'design')).toThrow('A prose check kind has no artefact type.');
    expect(PHASE_ARTEFACT_TYPE_SUGGESTION.maintenance).toBe('code');
  });

  it('every type it can answer is one of the nine', () => {
    for (const kind of ['story', 'design', 'code', 'tests', 'config', 'quiz'] as const) {
      for (const phase of [
        'requirements',
        'design',
        'implementation',
        'testing',
        'deployment',
        'maintenance',
      ] as const) {
        expect(ARTEFACT_TYPES).toContain(artefactTypeFor(kind, phase));
      }
    }
  });

  /* ------------------------------- quizzes -------------------------------- */

  it('a quiz kind names its own type', () => {
    // The arm matters only for a phase whose own checks declare
    // `kind: "quiz"`, and the phase key moves nothing.
    for (const phase of [
      'requirements',
      'design',
      'implementation',
      'testing',
      'deployment',
      'maintenance',
    ] as const) {
      expect(artefactTypeFor('quiz', phase)).toBe('quiz');
    }
  });

  it('no phase suggests a quiz: a quiz is a task added beside the artefact, never instead of it', () => {
    expect(Object.values(PHASE_ARTEFACT_TYPE_SUGGESTION)).not.toContain('quiz');
  });
});
