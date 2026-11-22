import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type {
  CohortExportDocument,
  CohortExportTask,
  FeedbackReport,
} from '@learnsdlc/shared';
import { COHORT_EXPORT_VERSION } from '@learnsdlc/shared';
import {
  AuditEventEntity,
  CohortEntity,
  CohortImportEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  RegradeBatchEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { soleTaskFor } from '../content/pack-compiler';
import { SCREEN_COPY_PATH } from '../content/screen-copy';
import type { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CohortsService } from './cohorts.service';
import type { InstructorCaller } from './cohort-scope';
import { InstructorService } from './instructor.service';
import { PortabilityService } from './portability.service';
import { RegradeService } from './regrade.service';
import { SubmissionTeacherFeedbackService } from './submission-feedback.service';
import { ViewAsService } from './view-as.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The pin travels between machines, or it is not a pin.
 *
 * `portability.service.spec.ts` is the class export's own suite; this file is
 * the version pin's half of it. The property under test: `enrollments.
 * projectVersionId` is not in the file, so without carrying the version every
 * *imported* enrolment would arrive null and the null-pin fallback would send
 * it to the destination's published head, not a legacy row grandfathered in,
 * but a new one, in perpetuity, and the class-export suite alone would not
 * notice.
 *
 * The round trip runs against one database on purpose, exactly as the class-export
 * suite does: the learner's address is rewritten between the export and the
 * import so the file arrives as another machine's, and the destination's own
 * `projects` / `project_versions` rows are what the carried version resolves
 * against.
 */

/** A verdict shaped like the real thing in the ways this file reads it. */
const REPORT = {
  overall: 91,
  passed: true,
  passThreshold: 70,
  assessmentMode: 'strict_binary',
  criteria: [{ criterion: 'acceptance criteria covered', score: 4, of: 4 }],
  checks: [{ name: 'hidden tests', passed: true }],
  aiReview: { verdict: 'pass', notes: [] },
} as unknown as FeedbackReport;

/** Everything `project_versions` needs that says nothing about this test. */
const MANIFEST = {
  tagline: 'a version row, for resolving a pin against',
  description: 'seeded by portability.spec.ts',
  language: 'python',
  languages: ['python', 'typescript'],
};

describe('PortabilityService: the version pin, in both directions', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let portability: PortabilityService;
  let workflow: WorkflowService;
  let cohortId = '';
  let instructorId = '';
  let adaId = '';
  let enrollmentId = '';
  /** The destination's own published versions of `tasktrackr`: version -> id. */
  let versions = new Map<string, string>();
  /** The shipped pack as the directory read it, before any version is installed over it. */
  let disk: ProjectContent;

  const instructor = () => ({ id: instructorId, role: 'INSTRUCTOR' as const });

  /**
   * A project as rows, with its published versions in the order a teacher
   * shipped them. The head is the last one, and `compareProjectVersions` is
   * what resolves it, never string order.
   */
  const seedProject = async (
    slug: string,
    published: string[],
  ): Promise<Map<string, string>> => {
    const manager = dataSource.manager;
    const project = await manager.save(
      manager.create(ProjectEntity, {
        slug,
        title: slug,
        platformOwned: true,
        ownerUserId: null,
        isDefault: true,
        origin: 'seed',
      }),
    );
    const byVersion = new Map<string, string>();
    for (const version of published) {
      const row = await manager.save(
        manager.create(ProjectVersionEntity, {
          projectId: project.id,
          version,
          status: 'published',
          manifest: MANIFEST,
          publishedAt: '2026-09-01T00:00:00.000Z',
        }),
      );
      byVersion.set(version, row.id);
    }
    return byVersion;
  };

  /**
   * One learner with a phase they passed and the evidence that passed it.
   * `currentPhaseOrder` is the passed phase's own order so `advance` reaches
   * the strict-evidence predicate rather than returning as a retried advance.
   */
  const seedLearner = async (
    email: string,
    name: string,
    projectVersionId: string | null,
    packVersion: string | null,
  ): Promise<{ userId: string; enrollmentId: string }> => {
    const manager = dataSource.manager;
    const user = await manager.save(
      manager.create(UserEntity, {
        email,
        displayName: name,
        passwordHash: 'not-a-real-hash',
        role: 'LEARNER',
        cohort: cohortId,
      }),
    );
    const enrollment = await manager.save(
      manager.create(EnrollmentEntity, {
        userId: user.id,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
        packVersion,
        projectVersionId,
      }),
    );
    const first = await manager.save(
      manager.create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId: user.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'passed',
        bestScore: 91,
        attempts: 1,
        workspace: { 'requirements/draft.md': '# US-1\n' },
        ranBeforeSubmit: true,
        passedAt: '2026-08-20T02:00:00.000Z',
      }),
    );
    await manager.save(
      manager.create(SubmissionEntity, {
        phaseStateId: first.id,
        userId: user.id,
        status: 'completed',
        score: 91,
        passed: true,
        report: REPORT,
        workspaceSnapshot: { 'requirements/draft.md': '# US-1\n' },
        // The source machine has it; the file does not carry it and the
        // importer writes none. That is the whole of the residual asserted
        // at the foot of this file.
        contextSnapshot: { links: [], drill: null, ranBeforeSubmit: true },
        packVersion,
        createdAt: new Date('2026-08-20T01:59:00.000Z'),
      }),
    );
    return { userId: user.id, enrollmentId: enrollment.id };
  };

  const exported = () =>
    portability.exportCohort(instructor(), cohortId, ['snapshots']);

  /**
   * The document as it would arrive from another laptop: the learner is not an
   * address this machine knows, so the import writes their enrolment rather
   * than skipping it as already held.
   */
  const asAnotherMachinesFile = async (): Promise<CohortExportDocument> => {
    const document = JSON.parse(
      JSON.stringify(await exported()),
    ) as CohortExportDocument;
    document.learners[0].email = 'newcomer@class.test';
    document.source.host = 'bench-laptop';
    return document;
  };

  const importedEnrollment = async (): Promise<EnrollmentEntity> => {
    const user = await dataSource.manager.findOneOrFail(UserEntity, {
      where: { email: 'newcomer@class.test' },
    });
    return dataSource.manager.findOneOrFail(EnrollmentEntity, {
      where: { userId: user.id },
    });
  };

  beforeAll(() => {
    // The real catalogue, so an enrolment on a project this machine does not
    // have can be told from one it does.
    content = new ContentService();
    content.loadAll();
    disk = content.getProject('tasktrackr');
  });

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    const cohorts = new CohortsService(dataSource);
    portability = new PortabilityService(
      passwordWorkFixture(),
      dataSource,
      cohorts,
      content,
    );
    workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      {
        latestFor: async () => null,
        runSmokeCheck: async () => ({}),
      } as unknown as FeedbackService,
      dataSource,
    );

    const manager = dataSource.manager;
    const chen = await manager.save(
      manager.create(UserEntity, {
        email: 'chen@uni.test',
        displayName: 'Dr Chen',
        passwordHash: 'not-a-real-hash',
        role: 'INSTRUCTOR',
      }),
    );
    instructorId = chen.id;
    const cohort = await manager.save(
      manager.create(CohortEntity, {
        name: 'Section A',
        joinCode: 'ABCD2345',
        ownerUserId: instructorId,
      }),
    );
    cohortId = cohort.id;
    await manager.update(
      UserEntity,
      { id: instructorId },
      { cohort: cohortId },
    );

    // Two published versions, and the learner pinned to the older one: the
    // head is 2.0.0 and every assertion below is that 1.0.0 is what travels.
    versions = await seedProject('tasktrackr', ['1.0.0', '2.0.0']);
    // And installed, the way `ProjectRegistryService` installs the rows, so
    // the catalogue's head is 2.0.0 at the row's own id: an enrolment whose
    // version is not here is pinned to that head, never written null.
    content.installVersions(
      [...versions].map(([version, versionId]) => ({
        versionId,
        content: { ...disk, version },
      })),
    );
    const seeded = await seedLearner(
      'ada@uni.test',
      'Ada Lovelace',
      versions.get('1.0.0')!,
      '1.0.0',
    );
    adaId = seeded.userId;
    enrollmentId = seeded.enrollmentId;
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  /* -------------------------------- export -------------------------------- */

  it('the export carries projectVersion per enrolment at the current formatVersion', async () => {
    const document = await exported();

    // Version 3 adds `CohortExportPhase.tasks` and
    // `CohortExportSubmission.taskKey`. The pin this file is about is a
    // version-2 field and still travels at 3.
    expect(COHORT_EXPORT_VERSION).toBe(3);
    expect(document.formatVersion).toBe(3);
    const enrollment = document.learners[0].enrollments[0];
    // The version the learner is pinned to, as a string: an export carries no
    // ids, so the destination has something it can resolve for itself.
    expect(enrollment.projectVersion).toBe('1.0.0');
    // And the stamped string is still its own field, unchanged.
    expect(enrollment.packVersion).toBe('1.0.0');
    expect(enrollment.projectSlug).toBe('tasktrackr');
  });

  it('an unpinned enrolment carries a null projectVersion rather than the head', async () => {
    await dataSource.manager.update(
      EnrollmentEntity,
      { id: enrollmentId },
      { projectVersionId: null },
    );

    const document = await exported();

    expect(document.learners[0].enrollments[0].projectVersion).toBeNull();
  });

  /* -------------------------------- import -------------------------------- */

  it('an import pins the enrolment to the carried version, not to the head', async () => {
    const document = await asAnotherMachinesFile();

    const result = await portability.importCohort(instructor(), document);

    expect(result.written.enrollments).toBe(1);
    const enrollment = await importedEnrollment();
    expect(enrollment.projectVersionId).toBe(versions.get('1.0.0'));
    expect(enrollment.projectVersionId).not.toBe(versions.get('2.0.0'));
    expect(enrollment.packVersion).toBe('1.0.0');
  });

  it('a version this machine does not hold refuses the enrolment by name', async () => {
    const document = await asAnotherMachinesFile();
    document.learners[0].enrollments[0].projectVersion = '9.9.9';

    const result = await portability.importCohort(instructor(), document);

    const [newcomer] = result.learners;
    expect(newcomer.note).toMatch(
      /tasktrackr 9\.9\.9 work is left in the file/,
    );
    expect(newcomer.skippedProjects).toEqual(['tasktrackr']);
    expect(result.written.enrollments).toBe(0);
    const user = await dataSource.manager.findOneOrFail(UserEntity, {
      where: { email: 'newcomer@class.test' },
    });
    expect(
      await dataSource.manager.count(EnrollmentEntity, {
        where: { userId: user.id },
      }),
    ).toBe(0);
  });

  it('a version-1 file still imports and is pinned by resolving packVersion', async () => {
    const document = await asAnotherMachinesFile();
    document.formatVersion = 1;
    for (const enrollment of document.learners[0].enrollments) {
      delete enrollment.projectVersion;
    }

    const result = await portability.importCohort(instructor(), document);

    expect(result.written.enrollments).toBe(1);
    const enrollment = await importedEnrollment();
    expect(enrollment.projectVersionId).toBe(versions.get('1.0.0'));
  });

  it('a version-1 file whose packVersion resolves to nothing still imports, pinned to the head', async () => {
    // `packVersion` is provenance (the version that stamped the submissions
    // under it) and not a pin request, which is why a file that carries only
    // it is resolved by it rather than refused on it. No match means this
    // machine cannot name the version that graded the work, so the work is
    // pinned to the head installed here at import time, by id:
    // the learner's board, submissions, releases and feedback all present,
    // and no later head moves them. The refusal belongs to the file that
    // *asks* for a version (below), and that test is unchanged.
    const document = await asAnotherMachinesFile();
    document.formatVersion = 1;
    for (const enrollment of document.learners[0].enrollments) {
      delete enrollment.projectVersion;
      enrollment.packVersion = '0.0.9';
    }

    const result = await portability.importCohort(instructor(), document);

    expect(result.written.enrollments).toBe(1);
    expect(result.written.phaseStates).toBe(1);
    expect(result.written.submissions).toBe(1);
    expect(result.learners[0].skippedProjects).toEqual([]);
    // Said rather than silent: the work is here and reads the published version.
    expect(result.learners[0].note).toMatch(
      /tasktrackr 0\.0\.9 work came in pinned to 2\.0\.0: this machine does not have that version of the project, so the work reads the published one\./,
    );
    const enrollment = await importedEnrollment();
    expect(enrollment.projectVersionId).toBe(versions.get('2.0.0'));
    // The provenance string travels untouched; it is not a claim about here.
    expect(enrollment.packVersion).toBe('0.0.9');
  });

  it('an unpinned enrolment whose packVersion this machine lacks still brings the work in', async () => {
    // The normal case, not an edge. Nothing writes
    // `enrollments.projectVersionId` at enrol time (`writeEnrollment`
    // (`workflow.service.ts`) sets `packVersion` and no pin) so every export
    // carries `projectVersion: null`, and `stampPack` has put the *source*
    // machine's head into `packVersion`. Two deployments are rarely on the
    // same head, so refusing on that string would make every cross-machine
    // import drop every learner's board, submissions, releases and teacher
    // feedback, while `portability.e2e-spec.ts` (which imports onto the
    // machine that exported) would stay green over it.
    await dataSource.manager.update(
      EnrollmentEntity,
      { id: enrollmentId },
      { projectVersionId: null, packVersion: '2.0.1' },
    );
    const document = await asAnotherMachinesFile();
    expect(document.learners[0].enrollments[0].projectVersion).toBeNull();
    expect(document.learners[0].enrollments[0].packVersion).toBe('2.0.1');

    const result = await portability.importCohort(instructor(), document);

    expect(result.written.enrollments).toBe(1);
    expect(result.written.phaseStates).toBe(1);
    expect(result.written.submissions).toBe(1);
    expect(result.learners[0].skippedProjects).toEqual([]);
    expect(result.learners[0].note).toMatch(
      /tasktrackr 2\.0\.1 work came in pinned to 2\.0\.0: this machine does not have that version of the project, so the work reads the published one\./,
    );
    const enrollment = await importedEnrollment();
    expect(enrollment.projectVersionId).toBe(versions.get('2.0.0'));
    const board = await dataSource.manager.count(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id },
    });
    expect(board).toBe(1);
  });

  it('a machine holding no versions of the project leaves the enrolment in the file, and says so', async () => {
    // A database that has not run the importer has no `project_versions`
    // rows, and a catalogue that walked the directory installed no version:
    // there is no version here to pin the work to, and an import never writes
    // a null pin, which would follow every later head. The work stays in the file with the sentence that says why.
    const document = await asAnotherMachinesFile();
    await dataSource.manager.clear(ProjectVersionEntity);
    await dataSource.manager.clear(ProjectEntity);
    const unversioned = new ContentService();
    unversioned.loadAll();
    const importer = new PortabilityService(
      passwordWorkFixture(),
      dataSource,
      new CohortsService(dataSource),
      unversioned,
    );

    const result = await importer.importCohort(instructor(), document);

    expect(result.written.enrollments).toBe(0);
    expect(result.learners[0].skippedProjects).toEqual(['tasktrackr']);
    expect(result.learners[0].note).toBe(
      "Their tasktrackr work is left in the file: This enrolment's project has no published version here, so it was not imported.",
    );
  });

  it('a dry run reports the refusal and writes nothing', async () => {
    const document = await asAnotherMachinesFile();
    document.learners[0].enrollments[0].projectVersion = '9.9.9';

    const preview = await portability.importCohort(instructor(), document, {
      dryRun: true,
    });

    expect(preview.applied).toBe(false);
    expect(preview.written.enrollments).toBe(0);
    expect(preview.learners[0].note).toMatch(
      /tasktrackr 9\.9\.9 work is left in the file/,
    );
    expect(await dataSource.manager.count(EnrollmentEntity)).toBe(1);
  });

  /* ------------------------------- the receipt ---------------------------- */

  it('the receipt formatVersion and counts describe the document that was read', async () => {
    const document = await asAnotherMachinesFile();

    await portability.importCohort(instructor(), document);

    const receipt = await dataSource.manager.findOneOrFail(
      CohortImportEntity,
      { where: {} },
    );
    expect(receipt.formatVersion).toBe(3);
    // Every collection a version-3 document carries has a count, and nothing
    // that is not in the document does: a receipt is sha-stamped and has to be
    // a true statement about the file it was taken from. `taskStates` is the
    // per-task collection, counted for the same reason the other seven are.
    expect(Object.keys(receipt.counts ?? {}).sort()).toEqual([
      'auditEvents',
      'enrollments',
      'learners',
      'messages',
      'phaseStates',
      'releases',
      'submissions',
      'taskStates',
    ]);
    expect(receipt.counts).toEqual({
      learners: 1,
      enrollments: 1,
      phaseStates: 1,
      submissions: 1,
      messages: 0,
      releases: 0,
      auditEvents: 0,
      taskStates: 0,
    });
  });

  it('a version-1 document records formatVersion 1 in its receipt', async () => {
    const document = await asAnotherMachinesFile();
    document.formatVersion = 1;
    for (const enrollment of document.learners[0].enrollments) {
      delete enrollment.projectVersion;
    }

    await portability.importCohort(instructor(), document);

    const receipt = await dataSource.manager.findOneOrFail(
      CohortImportEntity,
      { where: {} },
    );
    expect(receipt.formatVersion).toBe(1);
    expect(receipt.counts?.enrollments).toBe(1);
  });

  /* ------------------------------ the residual ---------------------------- */

  it('an imported learner whose phase arrives passed still cannot advance', async () => {
    // A known residual, asserted here so a future reader does not mistake it
    // for the pin's doing or the task grain's. The importer writes no
    // `contextSnapshot` (the column is in the export's read path only) and
    // `strictPass` requires one, so the door is open and the lock finds
    // nothing. Neither the pin nor the task grain touches it.
    const document = await asAnotherMachinesFile();
    await portability.importCohort(instructor(), document);

    const enrollment = await importedEnrollment();
    const state = await dataSource.manager.findOneOrFail(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id },
    });
    const submission = await dataSource.manager.findOneOrFail(
      SubmissionEntity,
      { where: { phaseStateId: state.id } },
    );
    expect(state.status).toBe('passed');
    // The bytes travelled; the context did not.
    expect(submission.workspaceSnapshot).toEqual({
      'requirements/draft.md': '# US-1\n',
    });
    expect(submission.contextSnapshot).toBeNull();

    await expect(
      workflow.advance(enrollment.userId, state.id),
    ).rejects.toThrow(
      /Submit this phase for a strict evidence review before advancing/,
    );

    // And the source row it was cut from can still show its own evidence, so
    // the loss is the file's and not the fixture's.
    const source = await dataSource.manager.findOneOrFail(SubmissionEntity, {
      where: { userId: adaId },
    });
    expect(source.contextSnapshot).not.toBeNull();
  });

  /* ----------------------------- the task grain --------------------------- */

  /*
   * Two halves of one property:
   *
   *   - a class export carries each phase's `task_states` rows and each
   *     revision's key, so a term of per-task work survives the move; and
   *   - the import is a **writer of phase status**, so it goes through the one
   *     roll-up like the other four. Not where the file looks odd, for every
   *     imported phase, with no predicate on the file's shape at all, because
   *     the common case is a file whose `tasks[]` is non-empty and names keys
   *     the destination's pinned version does not declare.
   */
  describe('the task grain travels, and the roll-up decides what a file may open', () => {
    /** A compiled task built off the phase's own sole task, so every field is real. */
    const taskOf = (key: string, over: Partial<CompiledTask> = {}): CompiledTask => {
      const phase = content
        .getProject('tasktrackr')
        .phases.find((one) => one.key === 'requirements')!;
      return { ...soleTaskFor(phase), taskKey: key, ...over };
    };

    /**
     * The destination's catalogue, installed at the very `project_versions.id`s
     * the rows carry, so a pin that travelled in a file resolves against the
     * same ids these reads do. Only Requirements declares a task list; every
     * other phase falls back to its sole task, exactly as a deployment that
     * stored none does.
     */
    const catalogueWith = (
      atOneOh: CompiledTask[],
      atTwoOh: CompiledTask[],
    ): ContentService => {
      const disk = content.getProject('tasktrackr');
      const service = new ContentService();
      service.installVersions([
        {
          versionId: versions.get('1.0.0') as string,
          content: { ...disk, version: '1.0.0' },
          phases: [{ key: 'requirements', tasks: atOneOh }],
        },
        {
          versionId: versions.get('2.0.0') as string,
          content: { ...disk, version: '2.0.0' },
          phases: [{ key: 'requirements', tasks: atTwoOh }],
        },
      ]);
      return service;
    };

    const importerOn = (catalogue?: ContentService): PortabilityService =>
      new PortabilityService(
        passwordWorkFixture(),
        dataSource,
        new CohortsService(dataSource),
        catalogue,
      );

    const importedPhases = async (): Promise<PhaseStateEntity[]> => {
      const enrollment = await importedEnrollment();
      return dataSource.manager.find(PhaseStateEntity, {
        where: { enrollmentId: enrollment.id },
        order: { phaseOrder: 'ASC' },
      });
    };

    const importedTasks = async (): Promise<TaskStateEntity[]> => {
      const user = await dataSource.manager.findOneOrFail(UserEntity, {
        where: { email: 'newcomer@class.test' },
      });
      return dataSource.manager.find(TaskStateEntity, {
        where: { userId: user.id },
        order: { taskKey: 'ASC' },
      });
    };

    /** What the sha-stamped receipt's own row records about the roll-up's work. */
    const flattened = async (): Promise<unknown[]> => {
      const row = await dataSource.manager.findOneOrFail(AuditEventEntity, {
        where: { event: 'cohort.import' },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      const detail = (row.detail ?? {}) as { flattenedPhases?: unknown[] };
      return detail.flattenedPhases ?? [];
    };

    /** The other direction: phases the roll-up opened over a file that said shut. */
    const opened = async (): Promise<unknown[]> => {
      const row = await dataSource.manager.findOneOrFail(AuditEventEntity, {
        where: { event: 'cohort.import' },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      const detail = (row.detail ?? {}) as { openedPhases?: unknown[] };
      return detail.openedPhases ?? [];
    };

    /** A second phase on the file, never submitted: the status the roll-up has no word for. */
    const withDesignInProgress = (
      document: CohortExportDocument,
    ): CohortExportDocument => {
      const enrollment = document.learners[0].enrollments[0];
      enrollment.phases.push({
        ref: `${enrollment.ref}/p2`,
        phaseKey: 'design',
        phaseOrder: 2,
        status: 'in_progress',
        bestScore: null,
        attempts: 0,
        reflection: null,
        workspace: null,
        links: [],
        drill: null,
        ranBeforeSubmit: false,
        unlockedAt: null,
        passedAt: null,
        tasks: [],
        submissions: [],
        messages: [],
      });
      return document;
    };

    /** One exported task row, at the fields a test cares to vary. */
    const exportedTask = (
      key: string,
      over: Partial<CohortExportTask> = {},
    ): CohortExportTask => ({
      taskKey: key,
      status: 'passed',
      bestScore: 91,
      attempts: 2,
      ranBeforeSubmit: false,
      passedAt: '2026-08-20T02:00:00.000Z',
      solutionReadAt: null,
      awaitingSignOff: false,
      signedOffAt: null,
      resetAt: null,
      resetCount: 0,
      countersigned: false,
      ...over,
    });

    /* ------------------------------- export ------------------------------- */

    it('every exported task row carries all twelve fields', async () => {
      const state = await dataSource.manager.findOneOrFail(PhaseStateEntity, {
        where: { userId: adaId },
      });
      await dataSource.manager.save(
        dataSource.manager.create(TaskStateEntity, {
          phaseStateId: state.id,
          userId: adaId,
          taskKey: 'story',
          status: 'passed',
          bestScore: 91,
          attempts: 2,
          ranBeforeSubmit: true,
          passedAt: '2026-08-20T02:00:00.000Z',
          solutionReadAt: '2026-08-21T09:00:00.000Z',
          awaitingSignOff: false,
          signedOffBy: instructorId,
          signedOffAt: '2026-08-22T10:00:00.000Z',
          resetAt: '2026-08-19T08:00:00.000Z',
          resetCount: 1,
        }),
      );

      const document = await exported();
      const [task] = document.learners[0].enrollments[0].phases[0].tasks ?? [];

      expect(Object.keys(task).sort()).toEqual([
        'attempts',
        'awaitingSignOff',
        'bestScore',
        'countersigned',
        'passedAt',
        'ranBeforeSubmit',
        'resetAt',
        'resetCount',
        'signedOffAt',
        'solutionReadAt',
        'status',
        'taskKey',
      ]);
      expect(task).toEqual({
        taskKey: 'story',
        status: 'passed',
        bestScore: 91,
        attempts: 2,
        ranBeforeSubmit: true,
        passedAt: '2026-08-20T02:00:00.000Z',
        solutionReadAt: '2026-08-21T09:00:00.000Z',
        awaitingSignOff: false,
        signedOffAt: '2026-08-22T10:00:00.000Z',
        resetAt: '2026-08-19T08:00:00.000Z',
        resetCount: 1,
        // The fact, never the person: an export carries no ids.
        countersigned: true,
      });
      expect(JSON.stringify(document)).not.toContain('signedOffBy');
      expect(JSON.stringify(document)).not.toContain(instructorId);
    });

    it('a v3 export of a class that has never seen an authored task differs from its v2 export in one integer and one empty string per revision', async () => {
      const document = await exported();

      expect(document.formatVersion).toBe(3);
      for (const phase of document.learners[0].enrollments[0].phases) {
        expect(phase.tasks).toEqual([]);
        for (const submission of phase.submissions) {
          expect(submission.taskKey).toBe('');
        }
      }

      // And the roll-up answers exactly what the file said, so it moves no
      // phase and the receipt records nothing.
      await portability.importCohort(instructor(), await asAnotherMachinesFile());
      const [requirements] = await importedPhases();
      expect(requirements.status).toBe('passed');
      expect(requirements.passedAt).toBe('2026-08-20T02:00:00.000Z');
      expect(await flattened()).toEqual([]);
      expect(await importedTasks()).toEqual([]);
    });

    /* ------------------------------- import ------------------------------- */

    it('a v2 file imported against an authored head imports shut', async () => {
      const document = withDesignInProgress(await asAnotherMachinesFile());
      document.formatVersion = 2;
      for (const phase of document.learners[0].enrollments[0].phases) {
        delete phase.tasks;
      }
      const importer = importerOn(
        catalogueWith([taskOf('story'), taskOf('scope')], [taskOf('main')]),
      );

      const result = await importer.importCohort(instructor(), document);

      const [requirements, design] = await importedPhases();
      expect(requirements.status).toBe('submitted');
      expect(requirements.passedAt).toBeNull();
      // The roll-up has no word for a phase nobody has submitted to, and it
      // does not invent one: a phase the file did not claim keeps its own.
      expect(design.status).toBe('in_progress');
      expect(await importedTasks()).toEqual([]);
      expect(await flattened()).toEqual([
        {
          ref: 'l1/e1/p1',
          slug: 'tasktrackr',
          phaseKey: 'requirements',
          from: 'passed',
          to: 'submitted',
        },
      ]);
      expect(result.learners[0].note).toMatch(
        /tasktrackr requirements work came in shut/,
      );
    });

    it('a v3 file whose phase is shut over passing tasks imports open, and is not called shut', async () => {
      // The other direction of the same roll-up, and not an exotic one: the
      // roll-up race can leave exactly this on the source deployment (a phase still
      // `submitted` with every required task `passed`) which is why `advance`
      // carries a heal for it. The roll-up opens it here, and a receipt that
      // filed it under `flattenedPhases` would tell the teacher the opposite of
      // what happened.
      const document = await asAnotherMachinesFile();
      const phase = document.learners[0].enrollments[0].phases[0];
      phase.status = 'submitted';
      phase.passedAt = null;
      phase.tasks = [exportedTask('story')];
      const importer = importerOn(
        catalogueWith([taskOf('story')], [taskOf('main')]),
      );

      const result = await importer.importCohort(instructor(), document);

      const [requirements] = await importedPhases();
      expect(requirements.status).toBe('passed');
      expect(requirements.passedAt).toBe('2026-08-20T02:00:00.000Z');
      // Recorded, because the roll-up did not take the file's word, and
      // recorded as what it was.
      expect(await flattened()).toEqual([]);
      expect(await opened()).toEqual([
        {
          ref: 'l1/e1/p1',
          slug: 'tasktrackr',
          phaseKey: 'requirements',
          from: 'submitted',
          to: 'passed',
        },
      ]);
      expect(result.learners[0].note).toMatch(
        /tasktrackr requirements work came in open/,
      );
      expect(result.learners[0].note).not.toMatch(/came in shut/);
    });

    it('a v3 file against a matching pin imports its tasks', async () => {
      const document = await asAnotherMachinesFile();
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('story'),
        exportedTask('scope', { bestScore: 100 }),
      ];
      const importer = importerOn(
        catalogueWith(
          [taskOf('story'), taskOf('scope', { required: false })],
          [taskOf('main')],
        ),
      );

      await importer.importCohort(instructor(), document);

      const [requirements] = await importedPhases();
      expect(requirements.status).toBe('passed');
      expect(requirements.passedAt).toBe('2026-08-20T02:00:00.000Z');
      const rows = await importedTasks();
      expect(rows.map((row) => row.taskKey)).toEqual(['scope', 'story']);
      expect(rows.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(rows.map((row) => row.bestScore)).toEqual([100, 91]);
      expect(rows.map((row) => row.attempts)).toEqual([2, 2]);
      expect(rows.every((row) => row.phaseStateId === requirements.id)).toBe(true);
      // The file said passed and the rows say so too, so nothing was moved.
      expect(await flattened()).toEqual([]);
    });

    it('a v3 file whose keys are not the destination pin’s imports shut', async () => {
      const document = await asAnotherMachinesFile();
      // The destination's head declares one task keyed `main` (every phase of
      // every teacher-authored project does) and the file names two others.
      document.learners[0].enrollments[0].projectVersion = '2.0.0';
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('story'),
        exportedTask('scope'),
      ];
      const importer = importerOn(
        catalogueWith([taskOf('story'), taskOf('scope')], [taskOf('main')]),
      );

      await importer.importCohort(instructor(), document);

      const [requirements] = await importedPhases();
      expect(requirements.status).toBe('submitted');
      expect(requirements.passedAt).toBeNull();
      // The learner did that work and the rows keep it; the gate does not
      // consult them, because `main` is the only required key here and it has
      // no row at all.
      expect((await importedTasks()).map((row) => row.taskKey)).toEqual([
        'scope',
        'story',
      ]);
      expect(await flattened()).toHaveLength(1);
    });

    it('a row naming a key the pinned version does not declare is recorded and never required', async () => {
      const document = await asAnotherMachinesFile();
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('story'),
        exportedTask('legacy', { status: 'in_progress', passedAt: null }),
      ];
      const importer = importerOn(
        catalogueWith([taskOf('story')], [taskOf('main')]),
      );

      await importer.importCohort(instructor(), document);

      const [requirements] = await importedPhases();
      // `story` is the pinned version's only required key and it passed, so the
      // phase opens although `legacy` did not.
      expect(requirements.status).toBe('passed');
      expect((await importedTasks()).map((row) => row.taskKey)).toEqual([
        'legacy',
        'story',
      ]);
    });

    it('a countersigned required task round-trips advanceable', async () => {
      const document = await asAnotherMachinesFile();
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('story', {
          countersigned: true,
          signedOffAt: '2026-08-22T10:00:00.000Z',
        }),
      ];
      const importer = importerOn(catalogueWith([taskOf('story')], [taskOf('main')]));

      await importer.importCohort(instructor(), document);

      const [requirements] = await importedPhases();
      expect(requirements.status).toBe('passed');
      const [story] = await importedTasks();
      // The fact travelled; the person is this machine's own operator, and the
      // trail says where the countersignature came from.
      expect(story.signedOffBy).toBe(instructorId);
      expect(story.signedOffAt).toBe('2026-08-22T10:00:00.000Z');
      const restored = await dataSource.manager.find(AuditEventEntity, {
        where: { event: 'task.signoff' },
      });
      expect(restored).toHaveLength(1);
      expect(restored[0].reason).toMatch(/restored from a class export/i);
    });

    it('a countersigned task with no signedOffAt is refused, by field', async () => {
      const document = await asAnotherMachinesFile();
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('story', { countersigned: true, signedOffAt: null }),
      ];
      const importer = importerOn(catalogueWith([taskOf('story')], [taskOf('main')]));

      await expect(
        importer.importCohort(instructor(), document),
      ).rejects.toThrow(/countersigned/);
      expect(await dataSource.manager.count(TaskStateEntity)).toBe(0);
    });

    it('a task row whose key is not a task key is refused, by field', async () => {
      const document = await asAnotherMachinesFile();
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('Story Two'),
      ];
      const importer = importerOn(
        catalogueWith([taskOf('story')], [taskOf('main')]),
      );

      await expect(
        importer.importCohort(instructor(), document),
      ).rejects.toThrow(/taskKey/);
      expect(await dataSource.manager.count(TaskStateEntity)).toBe(0);
    });

    it('a submission whose task key is not a task key is refused, by field', async () => {
      const document = await asAnotherMachinesFile();
      const phase = document.learners[0].enrollments[0].phases[0];
      // Long enough to overrun the column, and out of shape besides: the one
      // string on a submission the register never looked at.
      phase.submissions[0].taskKey = 'A'.repeat(200);
      const importer = importerOn(
        catalogueWith([taskOf('story')], [taskOf('main')]),
      );

      await expect(
        importer.importCohort(instructor(), document),
      ).rejects.toThrow(/taskKey/);
      expect(await dataSource.manager.count(CohortImportEntity)).toBe(0);
    });

    it('a submission whose task key is not text at all is refused before the write', async () => {
      const document = await asAnotherMachinesFile();
      const phase = document.learners[0].enrollments[0].phases[0];
      // Not a driver error deep inside the transaction, reported as somebody
      // registering an address; a sentence naming the field.
      phase.submissions[0].taskKey = 7 as unknown as string;
      const importer = importerOn(
        catalogueWith([taskOf('story')], [taskOf('main')]),
      );

      await expect(
        importer.importCohort(instructor(), document),
      ).rejects.toThrow(/taskKey/);
      expect(await dataSource.manager.count(CohortImportEntity)).toBe(0);
    });

    it('the sole task key travels: an empty submission key is not a refusal', async () => {
      const document = await asAnotherMachinesFile();
      expect(
        document.learners[0].enrollments[0].phases[0].submissions[0].taskKey,
      ).toBe('');

      await expect(
        importerOn(
          catalogueWith([taskOf('story')], [taskOf('main')]),
        ).importCohort(instructor(), document),
      ).resolves.toBeDefined();
    });

    it('an import with no content service is refused, not reconciled silently', async () => {
      const document = await asAnotherMachinesFile();
      const before = await dataSource.manager.count(UserEntity);

      await expect(
        importerOn(undefined).importCohort(instructor(), document),
      ).rejects.toThrow(/no project content loaded/);

      expect(await dataSource.manager.count(UserEntity)).toBe(before);
      expect(await dataSource.manager.count(CohortImportEntity)).toBe(0);
      // A dry run is refused by the same sentence: it reports what the real
      // call would do, and what it would do is refuse.
      await expect(
        importerOn(undefined).importCohort(instructor(), document, {
          dryRun: true,
        }),
      ).rejects.toThrow(/no project content loaded/);
    });

    it('the receipt counts the task rows', async () => {
      const document = await asAnotherMachinesFile();
      document.learners[0].enrollments[0].phases[0].tasks = [
        exportedTask('story'),
        exportedTask('scope'),
      ];
      const importer = importerOn(
        catalogueWith([taskOf('story'), taskOf('scope')], [taskOf('main')]),
      );

      const result = await importer.importCohort(instructor(), document);

      const counted = (counts: unknown) =>
        (counts as { taskStates?: number }).taskStates;
      expect(counted(result.written)).toBe(2);
      const receipt = await dataSource.manager.findOneOrFail(
        CohortImportEntity,
        { where: {} },
      );
      expect(counted(receipt.counts)).toBe(2);
    });
  });

  /* ---------------------------- the four pin rows ------------------------- */

  /*
   * The readers that hold an enrolment: `regrade.service.ts`,
   * `instructor.service.ts` (three sites), `submission-feedback.service.ts`
   * and `view-as.service.ts`. Every one of them must resolve through the
   * enrolment's pin rather than `getProject(slug)` / `getPhase(slug, key)`.
   *
   * They live in this file because the fixture above is the one they need: a
   * project with two published versions and a learner pinned to the older one.
   * The catalogue here is its own `ContentService` (`installVersions` replaces
   * the whole set an instance holds, and `content` above is the real disk load
   * the export path reads) installed at the very `project_versions.id`s the
   * rows carry, so a pin that travelled through an import resolves against the
   * same ids these reads do.
   */
  describe('what an instructor sees is the version the learner holds', () => {
    /** The published head, at 2.0.0: a different title, phase title and gate. */
    let head: ProjectContent;
    /** What Ada started on, at 1.0.0, still published and still hers. */
    let startedOn: ProjectContent;
    let pinned: ContentService;

    /** The caller, with the class they own, which is what `learnerScope` reads. */
    const staff = (): InstructorCaller => ({
      id: instructorId,
      role: 'INSTRUCTOR',
      cohort: cohortId,
    });

    /** The one phase both versions differ in, found by key rather than by index. */
    const requirementsOf = (project: ProjectContent) =>
      project.phases.find((phase) => phase.key === 'requirements') as ProjectContent['phases'][number];

    const phaseStateOf = async (userId: string): Promise<PhaseStateEntity> =>
      dataSource.manager.findOneOrFail(PhaseStateEntity, { where: { userId } });

    beforeEach(() => {
      const disk = content.getProject('tasktrackr');
      const retitle = (
        project: ProjectContent,
        title: string,
        phaseTitle: string,
        passThreshold: number,
        criteria: number,
        extraFiles: ProjectContent['phases'][number]['files'],
      ): ProjectContent => ({
        ...project,
        title,
        phases: project.phases.map((phase) =>
          phase.key === 'requirements'
            ? {
                ...phase,
                title: phaseTitle,
                files: [...phase.files, ...extraFiles],
                rubric: {
                  ...phase.rubric,
                  passThreshold,
                  criteria: phase.rubric.criteria.slice(0, criteria),
                },
              }
            : phase,
        ),
      });
      head = retitle(
        { ...disk, version: '2.0.0' },
        'TaskTrackr (2.0.0)',
        'Write the stories (2.0.0)',
        80,
        3,
        [],
      );
      startedOn = retitle(
        { ...disk, version: '1.0.0' },
        'TaskTrackr (1.0.0)',
        'Write the stories (1.0.0)',
        55,
        1,
        // A locked file 2.0.0 withdrew. It is the design handoff's own path, so
        // `ViewAsService` reaches for it by name and answers with it or drops
        // it, which makes "which version did view-as read" a fact about the
        // instructor's screen rather than about a spy.
        [
          {
            path: SCREEN_COPY_PATH,
            content: '{\n  "version": 1\n}\n',
            editable: false,
            language: 'json',
          },
        ],
      );
      pinned = new ContentService();
      // The newest last on purpose: the head is the newest published version,
      // never the last row that arrived.
      pinned.installVersions([
        { versionId: versions.get('2.0.0') as string, content: head },
        { versionId: versions.get('1.0.0') as string, content: startedOn },
      ]);
    });

    const instructorService = () =>
      new InstructorService(
        dataSource,
        pinned,
        { tokensToday: async () => 0 } as never,
      );

    it('the roll call heads the learner’s card with the project they are on, at their own version', async () => {
      // The roll call in `instructor.service.ts`. The card's heading is the one sentence on
      // the page that says which piece of work the rest of it is about, so a
      // heading naming 2.0.0 over a board built from 1.0.0 is the console
      // telling a teacher the wrong thing about the learner in front of them.
      const detail = await instructorService().learnerDetail(staff(), adaId);

      const [enrollment] = detail.enrollments;
      expect(enrollment.projectSlug).toBe('tasktrackr');
      expect(enrollment.projectTitle).toBe('TaskTrackr (1.0.0)');
      expect(enrollment.phases.map((phase) => phase.title)).toEqual([
        'Write the stories (1.0.0)',
      ]);
      // And the gate the card prints beside the score is the one the learner
      // was actually held to.
      expect(enrollment.phases[0].passThreshold).toBe(55);
    });

    it('an override passes the phase at the pinned version’s gate, not the head’s', async () => {
      // The override in `instructor.service.ts`. `pass` floors the score at the phase's own
      // `passThreshold`, so the version this line resolves is written into the
      // learner's record as a number: 55 is what 1.0.0 asked of them, and 80 is
      // a mark a teacher never gave.
      const state = await phaseStateOf(adaId);
      await dataSource.manager.update(
        PhaseStateEntity,
        { id: state.id },
        { status: 'in_progress', passedAt: null, bestScore: 0 },
      );

      const view = await instructorService().overridePhase(
        staff(),
        adaId,
        state.id,
        'pass',
        'agreed at the appeal panel',
      );

      expect(view.title).toBe('Write the stories (1.0.0)');
      expect(view.bestScore).toBe(55);
      expect(view.passThreshold).toBe(55);
    });

    it('the dossier is cut from the version the learner holds', async () => {
      // The dossier in `instructor.service.ts`. The dossier is the document an appeal
      // reads, and it is printed: the project and phase names on it have to be
      // the ones the work was done under.
      const dossier = await instructorService().learnerDossier(staff(), adaId);

      expect(dossier.projectTitle).toBe('TaskTrackr (1.0.0)');
      expect(dossier.phases.map((phase) => phase.title)).toEqual([
        'Write the stories (1.0.0)',
      ]);
    });

    it('the dossier says which project it could not find, and says it differently when none was named', async () => {
      // The two branches of one 404, pinned because they are the only thing an
      // instructor sees when the page is empty and they differ by one word.
      // A named project that this learner never started is a different fact
      // from a learner who has started nothing at all, and the console's next
      // step differs with it.
      const service = instructorService();
      const newcomer = await dataSource.manager.save(
        dataSource.manager.create(UserEntity, {
          email: 'noel@uni.test',
          displayName: 'Noel Tan',
          passwordHash: 'not-a-real-hash',
          role: 'LEARNER',
          cohort: cohortId,
        }),
      );

      await expect(
        service.learnerDossier(staff(), adaId, 'other-pack'),
      ).rejects.toThrow('this learner has not started that project');
      await expect(
        service.learnerDossier(staff(), newcomer.id),
      ).rejects.toThrow('this learner has not started a project');
      // And the named branch is about the project, not about the learner: Ada
      // has started something, and the sentence still names the project.
      await expect(
        service.learnerDossier(staff(), adaId, 'tasktrackr'),
      ).resolves.toMatchObject({ projectTitle: 'TaskTrackr (1.0.0)' });
    });

    it('a regrade re-runs the pinned version’s phase', async () => {
      // `regrade.service.ts`. This is the grading reader of the five: a
      // regrade that re-ran the head's phase would hold a learner's six-week-old
      // revision to a rubric nobody had written when they submitted it, and
      // write the verdict back over theirs.
      const state = await phaseStateOf(adaId);
      const parent = await dataSource.manager.findOneOrFail(SubmissionEntity, {
        where: { userId: adaId },
      });
      const batch = await dataSource.manager.save(
        dataSource.manager.create(RegradeBatchEntity, {
          actorUserId: instructorId,
          cohort: cohortId,
          projectSlug: 'tasktrackr',
          phaseKey: 'requirements',
          packVersionTo: '2.0.0',
          reason: 'the rubric wording was corrected',
          status: 'running',
          requested: 1,
        }),
      );
      const rerun = await dataSource.manager.save(
        dataSource.manager.create(SubmissionEntity, {
          phaseStateId: state.id,
          userId: adaId,
          status: 'queued',
          regradeOf: parent.id,
          regradeBatchId: batch.id,
        }),
      );
      const graded: ProjectContent['phases'] = [];
      const feedback = {
        gradeSnapshot: jest.fn(async (phase: ProjectContent['phases'][number]) => {
          graded.push(phase);
          return { ...REPORT, overall: 91, passed: true };
        }),
      };
      const regrade = new RegradeService(
        dataSource,
        pinned,
        feedback as never,
        { register: jest.fn() } as never,
      );

      await regrade.processRegrade({ id: rerun.id } as never);

      expect(graded).toHaveLength(1);
      expect(graded[0].title).toBe('Write the stories (1.0.0)');
      expect(graded[0].rubric.passThreshold).toBe(55);
    });

    it('the evidence panel re-derives the gate against the pinned version', async () => {
      // `submission-feedback.service.ts`. The panel does not read a stored
      // verdict: it re-runs `strictEvidencePassed` over the phase it resolves,
      // so the version it resolves decides whether a teacher is shown a
      // verified pass or a pass they have to go and argue about. 1.0.0 asked
      // for one criterion and the review answered one; 2.0.0 asks for three, so
      // the head's reading of this learner's evidence is "not verified".
      const submission = await dataSource.manager.findOneOrFail(
        SubmissionEntity,
        { where: { userId: adaId } },
      );
      const [first] = requirementsOf(startedOn).rubric.criteria;
      await dataSource.manager.update(
        SubmissionEntity,
        { id: submission.id },
        {
          report: {
            ...REPORT,
            checks: [{ id: 'structure', name: 'structure', status: 'passed' }],
            aiReview: {
              provider: 'stub',
              verdict: 'pass',
              notes: [],
              criteriaEvidence: [
                {
                  key: first.key,
                  met: true,
                  evidence: 'each story carries a role, a need and a reason',
                },
              ],
            },
          } as unknown as FeedbackReport,
        },
      );
      // The third argument is the project resolver, which this test never
      // reaches: `evidence` is asked about one submission by id, so no project
      // is being resolved from a request that named none.
      const panel = new SubmissionTeacherFeedbackService(
        dataSource,
        pinned,
        new WorkflowService(
          dataSource.getRepository(EnrollmentEntity),
          dataSource.getRepository(PhaseStateEntity),
          dataSource.getRepository(ReleaseRecordEntity),
          pinned,
          {} as never,
          dataSource,
        ),
      );

      const evidence = await panel.evidence(staff() as never, submission.id);

      expect(evidence.verifiedPass).toBe(true);
      // And the head's rubric is what would have said otherwise, so the
      // assertion above is about the pin rather than about a gate that passes
      // whatever it is handed.
      expect(requirementsOf(head).rubric.criteria).toHaveLength(3);
    });

    it('view-as renders the pinned version’s phase', async () => {
      // `view-as.service.ts`. The screen-copy file is declared by 1.0.0 and
      // withdrawn by 2.0.0, so an instructor reading the head sees a learner's
      // room with a locked file missing from it; a page that does not match
      // the page the learner is looking at, which is the one thing this feature
      // exists to guarantee.
      const state = await phaseStateOf(adaId);
      const workflow = new WorkflowService(
        dataSource.getRepository(EnrollmentEntity),
        dataSource.getRepository(PhaseStateEntity),
        dataSource.getRepository(ReleaseRecordEntity),
        pinned,
        {
          latestFor: async () => null,
          runSmokeCheck: async () => ({}),
        } as unknown as FeedbackService,
        dataSource,
      );
      const viewAs = new ViewAsService(
        dataSource,
        workflow,
        null as never,
        null as never,
        null as never,
        null as never,
        pinned,
      );

      const detail = await viewAs.phase(staff(), adaId, state.id);

      expect(detail.key).toBe('requirements');
      expect(detail.files.map((file) => file.path)).toContain(SCREEN_COPY_PATH);
      // The head does not declare it, so a read of the head would have dropped
      // the file from the instructor's copy of the learner's room.
      expect(requirementsOf(head).files.map((file) => file.path)).not.toContain(
        SCREEN_COPY_PATH,
      );
    });
  });
});
