import { passwordWorkFixture } from '../../test/password-work.fixture';
import { SECOND_PROJECT, addSecondProject } from '../../test/second-pack';
import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { COHORT_EXPORT_VERSION } from '@learnsdlc/shared';
import type { CohortExportDocument, FeedbackReport } from '@learnsdlc/shared';
import {
  AssistantMessageEntity,
  AuditEventEntity,
  CohortEntity,
  CohortImportEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  // Quizzes: the task row a quiz keeps its learner's state in, and the
  // papers, which are the one thing a class export deliberately leaves behind
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import { CohortsService } from './cohorts.service';
import { PortabilityService } from './portability.service';
import { IMPORT_MAX_LEARNERS } from './portability-validation';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The module object itself, not the `import * as` binding: the binding is a
 * set of non-configurable getters onto it, and the service reads `hash`
 * through the same getters, so a spy on the object is what the service sees.
 */
const bcryptModule = require('bcryptjs') as { hash: typeof bcrypt.hash };

/** The one sentence every account the caller may not claim gets, staff or not. */
const NOT_YOURS =
  'This account cannot be brought into a class from a file. If they belong in yours, ask them to type your join code.';

/** A verdict shaped like the real thing in the ways this file reads it. */
const REPORT = {
  overall: 86,
  passed: true,
  passThreshold: 70,
  criteria: [{ criterion: 'acceptance criteria covered', score: 3, of: 4 }],
  checks: [{ name: 'hidden tests', passed: true }],
} as unknown as FeedbackReport;

/**
 * A class moves between two laptops as one file.
 *
 * The round trip is driven against a single database on purpose: exporting a
 * class and importing it back is the sharpest test there is of "an import
 * always makes a new class and never merges", and it is the only way to assert
 * that a learner who is already here keeps the work they already have.
 */
describe('PortabilityService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let portability: PortabilityService;
  let cohortId = '';
  let instructorId = '';
  let outsiderId = '';
  let adaId = '';
  const JOIN_CODE = 'ABCD2345';

  /** The shipped pack as the directory read it, before any version is installed over it. */
  let disk: ProjectContent;
  /** This machine's published versions of `tasktrackr`: version -> `project_versions.id`. */
  let versions = new Map<string, string>();

  const instructor = () => ({ id: instructorId, role: 'INSTRUCTOR' as const });

  /** The pack cut to the phases named, each keeping the order it has on disk. */
  const holding = (version: string, keys?: string[]): ProjectContent => ({
    ...disk,
    version,
    phases: keys
      ? disk.phases.filter((phase) => keys.includes(phase.key))
      : disk.phases,
  });

  /**
   * `tasktrackr` as this machine's rows: one published version per entry, and
   * the ones marked installed handed to the catalogue the way
   * `ProjectRegistryService` installs the rows that hold a compiled snapshot.
   * A row left out of the install is a published row with no snapshot, which
   * the registry skips.
   */
  const publish = async (
    rows: { version: ProjectContent; installed?: boolean }[],
  ): Promise<Map<string, string>> => {
    const manager = dataSource.manager;
    const project =
      (await manager.findOne(ProjectEntity, { where: { slug: 'tasktrackr' } })) ??
      (await manager.save(
        manager.create(ProjectEntity, {
          slug: 'tasktrackr',
          title: 'TaskTrackr',
          platformOwned: true,
          ownerUserId: null,
          isDefault: true,
          origin: 'seed',
        }),
      ));
    await manager.delete(ProjectVersionEntity, { projectId: project.id });
    const byVersion = new Map<string, string>();
    const installed: { versionId: string; content: ProjectContent }[] = [];
    for (const { version, installed: install = true } of rows) {
      const row = await manager.save(
        manager.create(ProjectVersionEntity, {
          projectId: project.id,
          version: version.version,
          status: 'published',
          manifest: {
            tagline: 'a version row, for resolving a pin against',
            description: 'seeded by portability.service.spec.ts',
            language: 'python',
            languages: ['python'],
          },
          publishedAt: '2026-09-01T00:00:00.000Z',
        } as never),
      ) as unknown as ProjectVersionEntity;
      byVersion.set(version.version, row.id);
      if (install) installed.push({ versionId: row.id, content: version });
    }
    content.installVersions(installed);
    return byVersion;
  };

  const countRows = async () => ({
    users: await dataSource.manager.count(UserEntity),
    cohorts: await dataSource.manager.count(CohortEntity),
    enrollments: await dataSource.manager.count(EnrollmentEntity),
    phaseStates: await dataSource.manager.count(PhaseStateEntity),
    submissions: await dataSource.manager.count(SubmissionEntity),
    releases: await dataSource.manager.count(ReleaseRecordEntity),
    messages: await dataSource.manager.count(AssistantMessageEntity),
  });

  /** One learner with a term's worth of shape: two phases, a verdict, a transcript, a release. */
  const seedLearner = async (
    email: string,
    name: string,
    cohort: string,
  ): Promise<string> => {
    const manager = dataSource.manager;
    const user = await manager.save(
      manager.create(UserEntity, {
        email,
        displayName: name,
        passwordHash: 'not-a-real-hash',
        role: 'LEARNER',
        cohort,
        dailyTokenBudget: 5000,
      }),
    );
    if (cohort !== cohortId) return user.id;

    const enrollment = await manager.save(
      manager.create(EnrollmentEntity, {
        userId: user.id,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 2,
        packVersion: '1.1.0',
      }),
    );
    const first = await manager.save(
      manager.create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId: user.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'passed',
        bestScore: 86,
        attempts: 2,
        reflection: `${name} on the first gate`,
        workspace: { 'requirements/draft.md': '# US-1\n' },
        ranBeforeSubmit: true,
        passedAt: '2026-08-20T02:00:00.000Z',
      }),
    );
    await manager.save(
      manager.create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId: user.id,
        phaseKey: 'design',
        phaseOrder: 2,
        status: 'in_progress',
        attempts: 0,
      }),
    );
    await manager.save(
      manager.create(SubmissionEntity, {
        phaseStateId: first.id,
        userId: user.id,
        status: 'completed',
        score: 86,
        passed: true,
        report: REPORT,
        workspaceSnapshot: { 'requirements/draft.md': '# US-1\n' },
        packVersion: '1.1.0',
        createdAt: new Date('2026-08-20T01:59:00.000Z'),
      }),
    );
    await manager.save(
      manager.create(AssistantMessageEntity, {
        userId: user.id,
        enrollmentId: enrollment.id,
        phaseStateId: first.id,
        phaseKey: 'requirements',
        role: 'user',
        content: `${name} asked what an acceptance criterion is`,
        provider: '',
        tokensIn: 41,
        createdAt: new Date('2026-08-19T04:00:00.000Z'),
      }),
    );
    await manager.save(
      manager.create(AssistantMessageEntity, {
        userId: user.id,
        enrollmentId: enrollment.id,
        phaseStateId: first.id,
        phaseKey: 'requirements',
        role: 'assistant',
        content: 'Given, when, then. Try writing one for the empty list.',
        provider: 'local-mentor',
        tokensOut: 62,
        createdAt: new Date('2026-08-19T04:00:05.000Z'),
      }),
    );
    await manager.save(
      manager.create(ReleaseRecordEntity, {
        enrollmentId: enrollment.id,
        userId: user.id,
        phaseStateId: first.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        version: 'v1',
        score: 86,
        notes: 'Shipped the stories.',
      }),
    );
    return user.id;
  };

  const exported = () =>
    portability.exportCohort(instructor(), cohortId, ['messages']);

  const learnerIn = (document: CohortExportDocument, email: string) =>
    document.learners.find((learner) => learner.email === email)!;

  /**
   * The document as it would arrive from another laptop: one learner who is
   * already here with work of their own, one who is here without it, one who
   * is not here at all, and a staff address that must not become a learner.
   */
  const asAnotherMachinesFile = async (): Promise<CohortExportDocument> => {
    const document = JSON.parse(
      JSON.stringify(await exported()),
    ) as CohortExportDocument;
    // By address rather than by position: three learners seeded inside one
    // second share a createdAt, so the export's order is the id tie-break.
    learnerIn(document, 'grace@uni.test').email = 'dana@class.test';
    learnerIn(document, 'alan@uni.test').email = 'newcomer@class.test';
    document.learners.push({
      ...JSON.parse(JSON.stringify(learnerIn(document, 'newcomer@class.test'))),
      ref: 'l4',
      email: 'chen@uni.test',
      displayName: 'Dr Chen',
      enrollments: [],
    });
    document.source.host = 'bench-laptop';
    return document;
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
    portability = new PortabilityService(passwordWorkFixture(), dataSource, cohorts, content);

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
    const other = await manager.save(
      manager.create(UserEntity, {
        email: 'okonkwo@uni.test',
        displayName: 'Dr Okonkwo',
        passwordHash: 'not-a-real-hash',
        role: 'INSTRUCTOR',
      }),
    );
    outsiderId = other.id;
    const cohort = await manager.save(
      manager.create(CohortEntity, {
        name: 'Section A',
        joinCode: JOIN_CODE,
        ownerUserId: instructorId,
      }),
    );
    cohortId = cohort.id;
    await manager.update(
      UserEntity,
      { id: instructorId },
      { cohort: cohortId },
    );

    // This machine's own published version, at the version the seeded work
    // records, so an import pins to a row here: an import never writes a null
    // pin, and refuses an enrolment of a project with no published version.
    versions = await publish([{ version: holding('1.1.0') }]);

    adaId = await seedLearner('ada@uni.test', 'Ada Lovelace', cohortId);
    // One row of this machine's trail, so the export has something to carry and
    // the ref mapping has something to map.
    await manager.save(
      manager.create(AuditEventEntity, {
        event: 'phase.override',
        actorUserId: instructorId,
        subjectUserId: adaId,
        targetId: cohortId,
        action: 'pass',
        reason: 'The hidden test was wrong; fixed on disk.',
        detail: { phaseKey: 'requirements' },
      }),
    );
    await seedLearner('grace@uni.test', 'Grace Hopper', cohortId);
    await seedLearner('alan@uni.test', 'Alan Turing', cohortId);
    // Already on this machine, in no class and with no work: the case where an
    // import genuinely brings a learner's coursework in.
    await seedLearner('dana@class.test', 'Dana Scott', 'default');
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  /* -------------------------------- export ------------------------------- */

  it('carries the whole class, and none of its secrets, in the text of the file', async () => {
    const document = await exported();

    expect(document.format).toBe('learnsdlc.cohort');
    expect(document.cohort.name).toBe('Section A');
    expect(document.counts).toEqual({
      learners: 3,
      enrollments: 3,
      phaseStates: 6,
      submissions: 3,
      messages: 0,
      releases: 3,
      auditEvents: 1,
    });
    expect(document.learners.map((learner) => learner.ref)).toEqual([
      'l1',
      'l2',
      'l3',
    ]);
    expect(document.learners[0].enrollments[0].phases[0].ref).toBe('l1/e1/p1');

    // The trail travels as names and refs, never as ids from a machine the
    // reader has never heard of.
    const ada = learnerIn(document, 'ada@uni.test');
    expect(document.auditEvents).toEqual([
      {
        event: 'phase.override',
        actorName: 'Dr Chen',
        subjectRef: ada.ref,
        action: 'pass',
        reason: 'The hidden test was wrong; fixed on disk.',
        detail: { phaseKey: 'requirements' },
        createdAt: expect.any(String),
      },
    ]);

    // The assertion that cannot be fooled by a field somebody nests later: the
    // serialised text, not the object's own keys.
    const text = JSON.stringify(document);
    for (const secret of [
      'passwordHash',
      'tokenVersion',
      'disabledAt',
      'emailVerifiedAt',
      'joinCode',
      'not-a-real-hash',
      JOIN_CODE,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('never exports private transcripts even when requested; exports requested submitted files', async () => {
    const quiet = await portability.exportCohort(instructor(), cohortId, []);
    const phase = quiet.learners[0].enrollments[0].phases[0];
    expect(phase.messages).toEqual([]);
    expect(phase.submissions[0].snapshot).toBeNull();

    const loud = await portability.exportCohort(instructor(), cohortId, [
      'snapshots',
      'messages',
    ]);
    const loudPhase = loud.learners[0].enrollments[0].phases[0];
    expect(loudPhase.messages).toEqual([]);
    expect(JSON.stringify(loud)).not.toContain('tokensIn');
    expect(loudPhase.submissions[0].snapshot).toEqual({
      'requirements/draft.md': '# US-1\n',
    });
  });

  it('exports only submitted work and context while leaving newer private drafts untouched', async () => {
    const states = await dataSource.manager.find(PhaseStateEntity, {
      where: { userId: adaId },
      order: { phaseOrder: 'ASC' },
    });
    const [requirements, design] = states;
    await dataSource.manager.update(PhaseStateEntity, requirements.id, {
      workspace: { 'requirements/draft.md': 'PRIVATE_UNSUBMITTED_EDIT' },
      links: [
        { testId: 'private-test', criterionId: 'PRIVATE_UNSUBMITTED_LINK' },
      ] as any,
      reflection: 'PRIVATE_UNSUBMITTED_REFLECTION',
    });
    await dataSource.manager.update(PhaseStateEntity, design.id, {
      workspace: { 'design/design.json': 'PRIVATE_UNSUBMITTED_DESIGN' },
    });
    const document = await portability.exportCohort(instructor(), cohortId, [
      'snapshots',
      'messages',
    ]);
    expect(JSON.stringify(document)).not.toContain('PRIVATE_UNSUBMITTED');
    const phases = learnerIn(document, 'ada@uni.test').enrollments[0].phases;
    expect(phases[0].workspace).toEqual({
      'requirements/draft.md': '# US-1\n',
    });
    expect(phases[0].links).toEqual([]);
    expect(phases[1].workspace).toBeNull();
    const stillPrivate = await dataSource.manager.findOneByOrFail(
      PhaseStateEntity,
      { id: requirements.id },
    );
    expect(stillPrivate.workspace?.['requirements/draft.md']).toBe(
      'PRIVATE_UNSUBMITTED_EDIT',
    );
  });

  /**
   * Quizzes, and why the export format has no quiz-specific field.
   *
   * A quiz is a **task**, so a class export already carries it: the learner's
   * status and best score on it travel in `tasks[]`, which is precisely what
   * `COHORT_EXPORT_VERSION` 3 added. The document gains no key for quizzes;
   * that constant's own rule is one bump per field actually written, and the
   * field a quiz would add is the answer sheet, which the export does not
   * carry.
   *
   * These tests are the fence around that decision: the quiz's task row is
   * visibly in the file, and the papers behind it are visibly not.
   */
  describe('a quiz task in the class', () => {
    /** Ada's quiz: a passed task row, and the paper that passed it. */
    const seedQuiz = async (): Promise<QuizAttemptEntity> => {
      const manager = dataSource.manager;
      const phase = await manager.findOneOrFail(PhaseStateEntity, {
        where: { userId: adaId, phaseOrder: 1 },
      });
      await manager.save(
        manager.create(TaskStateEntity, {
          userId: adaId,
          phaseStateId: phase.id,
          taskKey: 'concepts',
          status: 'passed',
          bestScore: 80,
          attempts: 2,
          passedAt: '2026-08-20T01:58:00.000Z',
        }),
      );
      return manager.save(
        manager.create(QuizAttemptEntity, {
          userId: adaId,
          phaseStateId: phase.id,
          taskKey: 'concepts',
          projectVersionId: 'version-under-test',
          packVersion: '1.1.0',
          paper: [{ questionId: 'q1', optionIds: ['q1-b', 'q1-a'] }],
          answers: { q1: ['q1-a'] },
          score: 80,
          passed: true,
          startedAt: '2026-08-20T01:50:00.000Z',
          submittedAt: '2026-08-20T01:58:00.000Z',
        }),
      );
    };

    it('carries the quiz task the same way it carries every other task', async () => {
      await seedQuiz();
      const document = await exported();
      expect(document.formatVersion).toBe(COHORT_EXPORT_VERSION);
      expect(document.formatVersion).toBe(3);

      const phase = learnerIn(document, 'ada@uni.test').enrollments[0].phases[0];
      expect(phase.tasks).toEqual([
        {
          taskKey: 'concepts',
          status: 'passed',
          bestScore: 80,
          attempts: 2,
          ranBeforeSubmit: false,
          passedAt: '2026-08-20T01:58:00.000Z',
          solutionReadAt: null,
          awaitingSignOff: false,
          signedOffAt: null,
          resetAt: null,
          resetCount: 0,
          countersigned: false,
        },
      ]);
    });

    it('gains no key for it, at any of the three levels', async () => {
      await seedQuiz();
      const document = await exported();
      // Read off the object rather than the type: a field nested by a later
      // writer is what this is watching for, and the type would have been
      // changed in the same commit.
      expect(Object.keys(document).sort()).toEqual([
        'auditEvents', 'cohort', 'counts', 'exportedAt', 'exportedBy',
        'format', 'formatVersion', 'includes', 'learners', 'source',
      ]);
      const phase = learnerIn(document, 'ada@uni.test').enrollments[0].phases[0];
      expect(Object.keys(phase).sort()).toEqual([
        'attempts', 'bestScore', 'drill', 'links', 'messages', 'passedAt',
        'phaseKey', 'phaseOrder', 'ranBeforeSubmit', 'ref', 'reflection',
        'status', 'submissions', 'tasks', 'unlockedAt', 'workspace',
      ]);
      expect(Object.keys(phase.tasks![0]).sort()).toEqual([
        'attempts', 'awaitingSignOff', 'bestScore', 'countersigned',
        'passedAt', 'ranBeforeSubmit', 'resetAt', 'resetCount',
        'signedOffAt', 'solutionReadAt', 'status', 'taskKey',
      ]);
    });

    it('leaves the answer sheets on the machine they were written on', async () => {
      const attempt = await seedQuiz();
      // Everything a caller is allowed to ask for, so this is not "the file is
      // quiet because nobody asked it to speak".
      const document = await portability.exportCohort(instructor(), cohortId, [
        'snapshots',
        'messages',
      ]);
      const text = JSON.stringify(document);
      for (const sheet of [
        attempt.id,
        'quizAttempts',
        'answers',
        'q1',
        'version-under-test',
      ]) {
        expect(text).not.toContain(sheet);
      }
    });
  });

  it('is a 404 for an instructor whose class it is not, and writes a row when it is', async () => {
    await expect(
      portability.exportCohort(
        { id: outsiderId, role: 'INSTRUCTOR' },
        cohortId,
        [],
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await exported();
    const rows = await dataSource.manager.find(AuditEventEntity, {
      where: { event: 'cohort.export' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).not.toContain('messages');
    expect(rows[0].detail).toMatchObject({ learners: 3, submissions: 3 });
  });

  /* -------------------------------- import ------------------------------- */

  it('makes a second class, moves the learners who are here and mints the ones who are not', async () => {
    const document = await asAnotherMachinesFile();
    const result = await portability.importCohort(instructor(), document);

    expect(result.applied).toBe(true);
    expect(result.cohort!.name).toBe('Section A');
    expect(result.cohort!.id).not.toBe(cohortId);
    // A fresh code, so two machines never share one.
    expect(result.cohort!.joinCode).not.toBe(JOIN_CODE);
    expect(result.cohort!.memberCount).toBe(3);
    expect(result.source).toEqual({
      host: 'bench-laptop',
      exportedAt: document.exportedAt,
      name: 'Section A',
    });

    const outcomes = Object.fromEntries(
      result.learners.map((row) => [row.email, row]),
    );
    expect(outcomes['ada@uni.test'].outcome).toBe('matched');
    // Her work is not merged: she already has a tasktrackr enrolment here.
    expect(outcomes['ada@uni.test'].skippedProjects).toEqual(['tasktrackr']);
    expect(outcomes['dana@class.test'].outcome).toBe('matched');
    expect(outcomes['dana@class.test'].skippedProjects).toEqual([]);
    expect(outcomes['newcomer@class.test'].outcome).toBe('created');
    expect(outcomes['chen@uni.test']).toEqual({
      email: 'chen@uni.test',
      displayName: 'Dr Chen',
      outcome: 'skipped',
      note: NOT_YOURS,
      skippedProjects: [],
    });
    expect(result.createdAccounts).toEqual(['newcomer@class.test']);

    // Two learners' work came in; Ada's did not.
    expect(result.written).toMatchObject({
      learners: 3,
      enrollments: 2,
      phaseStates: 4,
      submissions: 2,
      messages: 0,
      releases: 2,
      // The other machine's trail stays in the file rather than becoming rows.
      auditEvents: 0,
    });

    const newcomer = await dataSource.manager.findOneOrFail(UserEntity, {
      where: { email: 'newcomer@class.test' },
    });
    expect(newcomer.role).toBe('LEARNER');
    expect(newcomer.cohort).toBe(result.cohort!.id);
    // Enabled, because the recovery link is the only way in and the guard
    // refuses a disabled account.
    expect(newcomer.disabledAt).toBeNull();
    expect(newcomer.emailVerifiedAt).toBeNull();
    expect(newcomer.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare('', newcomer.passwordHash)).toBe(false);

    const events = await dataSource.manager.find(AuditEventEntity, {
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const kinds = events.map((row) => row.event);
    expect(kinds.filter((kind) => kind === 'cohort.create')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'cohort.join')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'account.import')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'cohort.import')).toHaveLength(1);
    const joined = events
      .filter((row) => row.event === 'cohort.join')
      .map((row) => row.subjectUserId);
    expect(joined).toContain(adaId);

    const receipts = await dataSource.manager.find(CohortImportEntity);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].sourceHost).toBe('bench-laptop');
    expect(receipts[0].cohortId).toBe(result.cohort!.id);
    // The source's trail, kept verbatim and never replayed as rows here.
    expect(receipts[0].sourceAudit).toHaveLength(1);
    expect(receipts[0].sourceAudit![0].event).toBe('phase.override');
    // And it stayed in the file: no override arrived in this machine's trail.
    expect(kinds.filter((kind) => kind === 'phase.override')).toHaveLength(1);
  });

  it('reads a verdict back exactly as it was written, rather than as a string of JSON', async () => {
    const document = await asAnotherMachinesFile();
    const result = await portability.importCohort(instructor(), document);

    const learner = await dataSource.manager.findOneOrFail(UserEntity, {
      where: { email: 'newcomer@class.test' },
    });
    const submissions = await dataSource.manager.find(SubmissionEntity, {
      where: { userId: learner.id },
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0].report).toEqual(REPORT);
    expect(submissions[0].workspaceSnapshot).toBeNull();
    // The day the work was done travelled with it.
    expect(new Date(submissions[0].createdAt).toISOString()).toBe(
      '2026-08-20T01:59:00.000Z',
    );

    const messages = await dataSource.manager.find(AssistantMessageEntity, {
      where: { userId: learner.id },
      order: { createdAt: 'ASC' },
    });
    expect(messages).toEqual([]);
    expect(result.cohort!.id).toBeTruthy();
  });

  /**
   * The run a revision belongs to travels. An export carries `resetEpoch`; an
   * import maps it back; an older file has no such field, and its revisions
   * import as NULL (the current run) exactly as a row written before the
   * column existed is read.
   */
  it('carries each revision\'s run both ways, and reads an absent one as the current run', async () => {
    const ada = await dataSource.manager.findOneOrFail(UserEntity, { where: { email: 'grace@uni.test' } });
    await dataSource.manager.update(SubmissionEntity, { userId: ada.id }, { resetEpoch: 2 });
    const out = await exported();
    const theirs = learnerIn(out, 'grace@uni.test').enrollments[0].phases[0].submissions[0];
    expect(theirs.resetEpoch).toBe(2);
    expect(learnerIn(out, 'alan@uni.test').enrollments[0].phases[0].submissions[0].resetEpoch).toBeNull();

    const document = await asAnotherMachinesFile();
    const moved = learnerIn(document, 'newcomer@class.test').enrollments[0].phases[0];
    moved.submissions = [
      { ...moved.submissions[0], ref: `${moved.ref}/s1`, resetEpoch: 3 },
      (() => {
        const legacy = { ...moved.submissions[0], ref: `${moved.ref}/s2` };
        delete legacy.resetEpoch;
        return legacy;
      })(),
    ];
    await portability.importCohort(instructor(), document);
    const learner = await dataSource.manager.findOneOrFail(UserEntity, {
      where: { email: 'newcomer@class.test' },
    });
    const rows = await dataSource.manager.find(SubmissionEntity, { where: { userId: learner.id } });
    expect(rows.map((row) => row.resetEpoch).sort()).toEqual([3, null]);
  });

  it('says what it would do and writes nothing at all', async () => {
    const before = await countRows();
    const document = await asAnotherMachinesFile();

    const preview = await portability.importCohort(instructor(), document, {
      dryRun: true,
    });
    expect(preview.applied).toBe(false);
    expect(preview.cohort).toBeNull();
    expect(preview.written.enrollments).toBe(2);
    expect(preview.createdAccounts).toEqual(['newcomer@class.test']);
    expect(preview.learners).toHaveLength(4);

    expect(await countRows()).toEqual(before);
    expect(await dataSource.manager.count(CohortImportEntity)).toBe(0);
  });

  it('leaves the database exactly as it was when the import fails part-way', async () => {
    const document = await asAnotherMachinesFile();
    // A hand-edited file: the same learner enrolled twice on one project. The
    // enrolment index refuses the second, deep inside the write.
    const newcomer = learnerIn(document, 'newcomer@class.test');
    newcomer.enrollments.push(
      JSON.parse(JSON.stringify(newcomer.enrollments[0])),
    );
    const before = await countRows();

    await expect(
      portability.importCohort(instructor(), document),
    ).rejects.toThrow(/The import failed and nothing was changed/);
    expect(await countRows()).toEqual(before);
    expect(await dataSource.manager.count(CohortImportEntity)).toBe(0);
  });

  it('refuses a file it has already imported, and takes it when it is asked twice', async () => {
    const document = await asAnotherMachinesFile();
    await portability.importCohort(instructor(), document);

    await expect(
      portability.importCohort(instructor(), document),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      portability.importCohort(instructor(), document),
    ).rejects.toThrow(/Import it again to make a second copy/);
    // A dry run still answers, and says when it has seen this file before.
    const preview = await portability.importCohort(instructor(), document, {
      dryRun: true,
    });
    expect(preview.alreadyImportedAt).toEqual(expect.any(String));

    const second = await portability.importCohort(instructor(), document, {
      force: true,
    });
    expect(second.applied).toBe(true);
    expect(await dataSource.manager.count(CohortImportEntity)).toBe(2);
  });

  /* ------------------------ security review 2 ---------------------------- */

  /** A file naming one address, the way an attacker would write it by hand. */
  const fileNaming = (
    email: string,
    enrollments: CohortExportDocument['learners'][number]['enrollments'] = [],
  ): unknown => ({
    format: 'learnsdlc.cohort',
    formatVersion: 1,
    cohort: { name: 'Captured' },
    learners: [{ ref: 'l1', email, displayName: 'Someone', enrollments }],
  });

  describe('who an import may move', () => {
    let theirClassId = '';
    let learnerBId = '';

    beforeEach(async () => {
      const manager = dataSource.manager;
      const theirs = await manager.save(
        manager.create(CohortEntity, {
          name: 'Section B',
          joinCode: 'WXYZ7890',
          ownerUserId: outsiderId,
        }),
      );
      theirClassId = theirs.id;
      learnerBId = await seedLearner(
        'learnerb@class.test',
        'Learner B',
        theirClassId,
      );
    });

    it("leaves a learner in another instructor's class where they are, and says so without naming why", async () => {
      const result = await portability.importCohort(
        instructor(),
        fileNaming('learnerb@class.test'),
      );
      expect(result.applied).toBe(true);
      expect(result.learners).toEqual([
        expect.objectContaining({
          email: 'learnerb@class.test',
          outcome: 'skipped',
          note: NOT_YOURS,
        }),
      ]);
      expect(result.cohort!.memberCount).toBe(0);
      const learnerB = await dataSource.manager.findOneOrFail(UserEntity, {
        where: { id: learnerBId },
      });
      expect(learnerB.cohort).toBe(theirClassId);
      const joins = await dataSource.manager.find(AuditEventEntity, {
        where: { event: 'cohort.join' },
      });
      expect(joins).toHaveLength(0);
    });

    it('moves them for the instructor who owns their class, and for an admin', async () => {
      const byOwner = await portability.importCohort(
        { id: outsiderId, role: 'INSTRUCTOR' },
        fileNaming('learnerb@class.test'),
      );
      expect(byOwner.learners[0].outcome).toBe('matched');
      expect(
        (
          await dataSource.manager.findOneOrFail(UserEntity, {
            where: { id: learnerBId },
          })
        ).cohort,
      ).toBe(byOwner.cohort!.id);

      const admin = await dataSource.manager.save(
        dataSource.manager.create(UserEntity, {
          email: 'ops@uni.test',
          displayName: 'Ops',
          passwordHash: 'not-a-real-hash',
          role: 'ADMIN',
        }),
      );
      const byAdmin = await portability.importCohort(
        { id: admin.id, role: 'ADMIN' },
        {
          ...(fileNaming('learnerb@class.test') as object),
          cohort: { name: 'Captured again' },
        },
      );
      expect(byAdmin.learners[0].outcome).toBe('matched');
      expect(
        (
          await dataSource.manager.findOneOrFail(UserEntity, {
            where: { id: learnerBId },
          })
        ).cohort,
      ).toBe(byAdmin.cohort!.id);
    });

    it('still moves a learner in no class, and one in a class the caller owns', async () => {
      const result = await portability.importCohort(instructor(), {
        ...(fileNaming('dana@class.test') as object),
        learners: [
          { ref: 'l1', email: 'dana@class.test', enrollments: [] },
          { ref: 'l2', email: 'ada@uni.test', enrollments: [] },
        ],
      });
      expect(result.learners.map((row) => row.outcome)).toEqual([
        'matched',
        'matched',
      ]);
      expect(result.cohort!.memberCount).toBe(2);
    });

    it('reads the same for a staff address and for a learner who is not the caller’s, and leaves a row', async () => {
      const preview = await portability.importCohort(
        instructor(),
        {
          ...(fileNaming('x@y.z') as object),
          learners: [
            { ref: 'a', email: 'learnerb@class.test', enrollments: [] },
            { ref: 'b', email: 'okonkwo@uni.test', enrollments: [] },
            { ref: 'c', email: 'nobody-here@class.test', enrollments: [] },
          ],
        },
        { dryRun: true },
      );
      expect(preview.applied).toBe(false);
      const [learner, staff, unknown] = preview.learners;
      expect(learner).toMatchObject({ outcome: 'skipped', note: NOT_YOURS });
      expect(staff).toMatchObject({ outcome: 'skipped', note: NOT_YOURS });
      expect(JSON.stringify(preview)).not.toMatch(/staff/i);
      expect(unknown.outcome).toBe('created');

      const rows = await dataSource.manager.find(AuditEventEntity, {
        where: { event: 'cohort.import' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: instructorId,
        reason: 'A dry run: nothing was written.',
        detail: expect.objectContaining({ dryRun: true, addresses: 3 }),
      });
      expect(await dataSource.manager.count(CohortImportEntity)).toBe(0);
    });
  });

  describe('what one file may cost', () => {
    afterEach(() => jest.restoreAllMocks());

    it('refuses a file naming more learners than a class holds, before anything is read or written', async () => {
      const before = await countRows();
      const learners = Array.from(
        { length: IMPORT_MAX_LEARNERS + 1 },
        (_, i) => ({
          ref: `l${i + 1}`,
          email: `many-${i}@class.test`,
          enrollments: [],
        }),
      );
      const hash = jest.spyOn(bcryptModule, 'hash');
      await expect(
        portability.importCohort(instructor(), {
          ...(fileNaming('x@y.z') as object),
          learners,
        }),
      ).rejects.toThrow(new RegExp(`up to ${IMPORT_MAX_LEARNERS}`));
      expect(hash).not.toHaveBeenCalled();
      expect(await countRows()).toEqual(before);
    });

    it('costs one hash however many accounts it mints, and none of them can be signed into', async () => {
      const learners = Array.from({ length: 3 }, (_, i) => ({
        ref: `l${i + 1}`,
        email: `minted-${i}@class.test`,
        enrollments: [],
      }));
      const hash = jest.spyOn(bcryptModule, 'hash');
      const result = await portability.importCohort(instructor(), {
        ...(fileNaming('x@y.z') as object),
        learners,
      });
      expect(result.createdAccounts).toHaveLength(3);
      expect(hash).toHaveBeenCalledTimes(1);

      const minted = await dataSource.manager.find(UserEntity, {
        where: { cohort: result.cohort!.id },
      });
      expect(minted).toHaveLength(3);
      expect(new Set(minted.map((row) => row.passwordHash)).size).toBe(1);
      expect(minted[0].passwordHash).toMatch(/^\$2[aby]\$12\$/);
      expect(await bcrypt.compare('', minted[0].passwordHash)).toBe(false);
    });
  });

  describe('what one file may say', () => {
    const enrolment = (over: Record<string, unknown> = {}) => ({
      ref: 'l1/e1',
      projectSlug: 'tasktrackr',
      packVersion: null,
      currentPhaseOrder: 1,
      completed: false,
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: null,
      releases: [],
      phases: [
        {
          ref: 'l1/e1/p1',
          phaseKey: 'requirements',
          phaseOrder: 1,
          status: 'passed',
          bestScore: 80,
          attempts: 1,
          reflection: null,
          workspace: null,
          links: null,
          drill: null,
          ranBeforeSubmit: false,
          unlockedAt: null,
          passedAt: null,
          submissions: [],
          messages: [],
        },
      ],
      ...over,
    });
    const withLearner = (learner: Record<string, unknown>): unknown => ({
      ...(fileNaming('x@y.z') as object),
      learners: [
        {
          ref: 'l1',
          email: 'fresh@class.test',
          displayName: 'Fresh',
          enrollments: [],
          ...learner,
        },
      ],
    });

    it.each<[string, unknown, RegExp]>([
      [
        'an address that is not one',
        withLearner({ email: 'not an email <script>' }),
        /learner l1, email/,
      ],
      [
        'a name the console cannot show',
        withLearner({ displayName: 'N'.repeat(100_000) }),
        /displayName: is 100000 characters/,
      ],
      [
        'a name longer than registration and the account page allow',
        withLearner({ displayName: 'N'.repeat(61) }),
        /displayName: is 61 characters; a name is at most 60\./,
      ],
      [
        'a budget above the console ceiling',
        withLearner({ dailyTokenBudget: 99_999_999_999 }),
        /dailyTokenBudget/,
      ],
      [
        'a budget that is not a whole number',
        withLearner({ dailyTokenBudget: 1.5 }),
        /dailyTokenBudget/,
      ],
      [
        'a phase the map has no key for',
        withLearner({
          enrollments: [
            enrolment({
              phases: [{ ...enrolment().phases[0], phaseKey: 'bogus' }],
            }),
          ],
        }),
        /phase 1, phaseKey: "bogus"/,
      ],
      [
        'a status that is not one',
        withLearner({
          enrollments: [
            enrolment({
              phases: [{ ...enrolment().phases[0], status: 'winning' }],
            }),
          ],
        }),
        /status: "winning"/,
      ],
      [
        'a score off the scale',
        withLearner({
          enrollments: [
            enrolment({
              phases: [{ ...enrolment().phases[0], bestScore: 999 }],
            }),
          ],
        }),
        /bestScore: is 999/,
      ],
      [
        'a run number that is not a whole count (resetEpoch, SK16)',
        withLearner({
          enrollments: [
            enrolment({
              phases: [
                {
                  ...enrolment().phases[0],
                  submissions: [{ status: 'completed', score: 50, resetEpoch: 1.5 }],
                },
              ],
            }),
          ],
        }),
        /submission 1, resetEpoch: is not a whole number/,
      ],
      [
        'a run number an integer column cannot hold (resetEpoch, SK16)',
        withLearner({
          enrollments: [
            enrolment({
              phases: [
                {
                  ...enrolment().phases[0],
                  submissions: [{ status: 'completed', score: 50, resetEpoch: 2 ** 31 }],
                },
              ],
            }),
          ],
        }),
        /submission 1, resetEpoch: is not a whole number/,
      ],
      [
        'a message from nobody the transcript knows',
        withLearner({
          enrollments: [
            enrolment({
              phases: [
                {
                  ...enrolment().phases[0],
                  messages: [{ role: 'system', content: 'hi' }],
                },
              ],
            }),
          ],
        }),
        /message 1, role: "system"/,
      ],
      [
        'a class name too long to be one',
        {
          ...(fileNaming('fresh@class.test') as object),
          cohort: { name: 'X'.repeat(5000) },
        },
        /class name is 5000 characters/,
      ],
    ])(
      'refuses %s, naming the learner and the field, and writes nothing',
      async (_what, document, sentence) => {
        const before = await countRows();
        await expect(
          portability.importCohort(instructor(), document),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          portability.importCohort(instructor(), document),
        ).rejects.toThrow(sentence);
        expect(await countRows()).toEqual(before);
      },
    );

    it('leaves an enrolment on a project this machine does not have in the file, and says so', async () => {
      const document = withLearner({
        email: 'dana@class.test',
        enrollments: [
          enrolment({ projectSlug: 'no-such-project' }),
          enrolment(),
        ],
      });
      const result = await portability.importCohort(instructor(), document);
      const [dana] = result.learners;
      expect(dana.outcome).toBe('matched');
      expect(dana.skippedProjects).toEqual(['no-such-project']);
      // The unknown-project rule's own sentence: the no-version refusal opens with the
      // same "work is left in the file", so the prefix alone would pass with
      // this rule gone.
      expect(dana.note).toContain(
        'Their no-such-project work is left in the file: this machine does not have that project.',
      );
      expect(dana.note).not.toContain('has no published version here');
      expect(result.written.enrollments).toBe(1);
      const enrollments = await dataSource.manager.find(EnrollmentEntity, {
        where: {
          userId: (
            await dataSource.manager.findOneOrFail(UserEntity, {
              where: { email: 'dana@class.test' },
            })
          ).id,
        },
      });
      expect(enrollments.map((row) => row.projectSlug)).toEqual(['tasktrackr']);
    });

    /**
     * A teacher's project reaches only learners of a class it is assigned to,
     * and an import is a second writer of enrolments: a file naming another
     * teacher's published project pinned learners to it (an unattached one
     * pulled in by address included) with no class of theirs on it. The file
     * keeps that work, exactly as it keeps work on a project this machine does
     * not have, and says so in words that are true of it.
     */
    it("leaves an enrolment on another teacher's project in the file, and says so", async () => {
      const { listProjects, getProject } = content;
      addSecondProject(content);
      try {
        const rival = await dataSource.manager.save(
          dataSource.manager.create(UserEntity, {
            email: 'rival@class.test',
            passwordHash: 'x',
            displayName: 'Rival',
            role: 'INSTRUCTOR',
          }),
        );
        await dataSource.manager.save(
          dataSource.manager.create(ProjectEntity, {
            slug: SECOND_PROJECT,
            title: 'Rival pack',
            platformOwned: false,
            ownerUserId: rival.id,
            isDefault: false,
            origin: 'upload',
          } as ProjectEntity),
        );
        const document = withLearner({
          email: 'dana@class.test',
          enrollments: [enrolment({ projectSlug: SECOND_PROJECT }), enrolment()],
        });
        const result = await portability.importCohort(instructor(), document);
        const [dana] = result.learners;
        expect(dana.skippedProjects).toEqual([SECOND_PROJECT]);
        // The reach rule's own sentence, not the no-version one, which opens the same way.
        expect(dana.note).toContain(
          `Their ${SECOND_PROJECT} work is left in the file: that project is another teacher's, and none of your classes can be put on it.`,
        );
        expect(dana.note).not.toMatch(/does not have that project/);
        expect(dana.note).not.toContain('has no published version here');
        expect(result.written.enrollments).toBe(1);
        const held = await dataSource.manager.find(EnrollmentEntity, {
          where: {
            userId: (
              await dataSource.manager.findOneOrFail(UserEntity, {
                where: { email: 'dana@class.test' },
              })
            ).id,
          },
        });
        expect(held.map((row) => row.projectSlug)).toEqual(['tasktrackr']);
      } finally {
        content.listProjects = listProjects;
        content.getProject = getProject;
      }
    });
  });

  /**
   * The pin every imported enrolment gets.
   *
   * An enrolment written with a null pin follows every later head, so a
   * teacher's subset head would move it between phase sets. The import pins
   * each enrolment it writes to the version it imports into, by id, and holds
   * the enrolment to that version first: a phase key the version lacks, or an
   * order that disagrees with the version's, keeps the enrolment in the file,
   * whole, with a sentence that says why.
   */
  describe('the pin every imported enrolment gets (10.3)', () => {
    const HOLDS_A_PHASE =
      'This enrolment holds a phase its version does not, so it was not imported.';
    const NO_VERSION_HERE =
      "This enrolment's project has no published version here, so it was not imported.";
    const NUMBERS_DIFFER =
      'This enrolment numbers its phases differently from its version here, so it was not imported.';

    const carriedPhase = (key: string, order: number, ref: string) => ({
      ref,
      phaseKey: key,
      phaseOrder: order,
      status: 'in_progress',
      bestScore: null,
      attempts: 1,
      reflection: null,
      workspace: null,
      links: null,
      drill: null,
      ranBeforeSubmit: false,
      unlockedAt: null,
      passedAt: null,
      tasks: [],
      submissions: [
        {
          status: 'completed',
          score: 40,
          passed: false,
          report: null,
          snapshot: null,
          packVersion: null,
          error: null,
          createdAt: '2026-08-20T01:59:00.000Z',
        },
      ],
      messages: [],
    });

    /** One enrolment on `tasktrackr`, Requirements and Design, as a file carries it. */
    const enrolment = (over: Record<string, unknown> = {}) => ({
      ref: 'l1/e1',
      projectSlug: 'tasktrackr',
      projectVersion: null,
      packVersion: null,
      currentPhaseOrder: 2,
      completed: false,
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: null,
      releases: [
        {
          phaseKey: 'requirements',
          phaseOrder: 1,
          version: 'v1',
          score: 80,
          notes: null,
          createdAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      phases: [
        carriedPhase('requirements', 1, 'l1/e1/p1'),
        carriedPhase('design', 2, 'l1/e1/p2'),
      ],
      ...over,
    });

    const file = (...enrollments: Record<string, unknown>[]): unknown => ({
      format: 'learnsdlc.cohort',
      formatVersion: COHORT_EXPORT_VERSION,
      cohort: { name: 'Captured' },
      learners: [
        {
          ref: 'l1',
          email: 'fresh@class.test',
          displayName: 'Fresh',
          enrollments,
        },
      ],
    });

    /** Every row the import could have written for the learner the file names. */
    const freshRows = async () => {
      const user = await dataSource.manager.findOne(UserEntity, {
        where: { email: 'fresh@class.test' },
      });
      if (!user) return { enrollments: [], phaseStates: 0, submissions: 0, releases: 0 };
      return {
        enrollments: await dataSource.manager.find(EnrollmentEntity, {
          where: { userId: user.id },
        }),
        phaseStates: await dataSource.manager.count(PhaseStateEntity, {
          where: { userId: user.id },
        }),
        submissions: await dataSource.manager.count(SubmissionEntity, {
          where: { userId: user.id },
        }),
        releases: await dataSource.manager.count(ReleaseRecordEntity, {
          where: { userId: user.id },
        }),
      };
    };

    /** The refusal, and nothing of the enrolment written. */
    const expectRefused = async (
      result: Awaited<ReturnType<PortabilityService['importCohort']>>,
      sentence: string,
    ) => {
      const [fresh] = result.learners;
      expect(fresh.note).toContain(
        `Their tasktrackr work is left in the file: ${sentence}`,
      );
      expect(fresh.skippedProjects).toEqual(['tasktrackr']);
      expect(result.written.enrollments).toBe(0);
      expect(result.written.phaseStates).toBe(0);
      expect(result.written.submissions).toBe(0);
      expect(result.written.releases).toBe(0);
      expect(await freshRows()).toEqual({
        enrollments: [],
        phaseStates: 0,
        submissions: 0,
        releases: 0,
      });
    };

    it('pins an imported enrolment to the version it names when this machine holds it', async () => {
      versions = await publish([
        { version: holding('1.1.0') },
        { version: holding('2.0.0') },
      ]);
      const result = await portability.importCohort(
        instructor(),
        file(enrolment({ projectVersion: '1.1.0' })),
      );
      expect(result.written.enrollments).toBe(1);
      expect(result.learners[0].note).toBeNull();
      const [row] = (await freshRows()).enrollments;
      expect(row.projectVersionId).toBe(versions.get('1.1.0'));
    });

    it("pins it to this project's published head when the version it names is not here, and lists the ask", async () => {
      versions = await publish([
        { version: holding('1.1.0') },
        { version: holding('2.0.0') },
      ]);
      const result = await portability.importCohort(
        instructor(),
        file(enrolment({ packVersion: '0.0.9' })),
      );
      expect(result.written.enrollments).toBe(1);
      expect(result.learners[0].skippedProjects).toEqual([]);
      expect(result.learners[0].note).toBe(
        'Their tasktrackr 0.0.9 work came in pinned to 2.0.0: this machine does not have that version of the project, so the work reads the published one.',
      );
      const [row] = (await freshRows()).enrollments;
      expect(row.projectVersionId).toBe(versions.get('2.0.0'));
      // The provenance string travels untouched; it is not a claim about here.
      expect(row.packVersion).toBe('0.0.9');
    });

    it('never writes a null pin', async () => {
      // The whole class as another machine's file, each enrolment naming no
      // version (the export carries none for a row with no pin), plus one that
      // names nothing at all.
      const document = await asAnotherMachinesFile();
      for (const learner of document.learners) {
        for (const one of learner.enrollments) {
          one.projectVersion = null;
          one.packVersion = null;
        }
      }
      const result = await portability.importCohort(instructor(), document);
      expect(result.written.enrollments).toBe(2);
      const before = await dataSource.manager.find(EnrollmentEntity);
      // The three enrolments seeded in the class were written with no pin
      // before the import ran; every row the import wrote has one.
      expect(before.filter((row) => row.projectVersionId === null)).toHaveLength(3);
      const imported = before.filter((row) => row.projectVersionId !== null);
      expect(imported).toHaveLength(2);
      for (const row of imported) {
        expect(row.projectVersionId).toBe(versions.get('1.1.0'));
      }
    });

    it('refuses an enrolment holding a phase key its version lacks, writing none of it', async () => {
      await publish([
        {
          version: holding('1.1.0', ['requirements', 'design', 'implementation']),
        },
      ]);
      const result = await portability.importCohort(
        instructor(),
        file(
          enrolment({
            phases: [
              carriedPhase('requirements', 1, 'l1/e1/p1'),
              carriedPhase('testing', 4, 'l1/e1/p4'),
            ],
            currentPhaseOrder: 1,
          }),
        ),
      );
      await expectRefused(result, HOLDS_A_PHASE);
    });

    it('refuses an enrolment of a project with no published version here', async () => {
      // A catalogue that walked the directory and installed no version, over
      // a database holding no published row: the project is known, and there
      // is no version here to pin the work to.
      const unversioned = new ContentService();
      unversioned.loadAll();
      await dataSource.manager.clear(ProjectVersionEntity);
      const importer = new PortabilityService(
        passwordWorkFixture(),
        dataSource,
        new CohortsService(dataSource),
        unversioned,
      );
      const result = await importer.importCohort(instructor(), file(enrolment()));
      await expectRefused(result, NO_VERSION_HERE);
    });

    it("refuses a phase order above the version's phase count", async () => {
      // The shape check holds an order to LearnSDLC's six, because it runs
      // before any version is resolved; the version's own orders then hold it
      // to three.
      await publish([
        {
          version: holding('1.1.0', ['requirements', 'design', 'implementation']),
        },
      ]);
      const result = await portability.importCohort(
        instructor(),
        file(
          enrolment({
            phases: [
              carriedPhase('requirements', 1, 'l1/e1/p1'),
              carriedPhase('design', 5, 'l1/e1/p5'),
            ],
            currentPhaseOrder: 1,
          }),
        ),
      );
      await expectRefused(result, NUMBERS_DIFFER);
    });

    it('refuses an enrolment exported from a two-phase version against a six-phase version here, writing none of it', async () => {
      // Every key is one the six-phase head holds, so 10.3's sentence
      // would be false of it; the orders are the two-phase version's, and
      // written here they would name the wrong phases.
      const result = await portability.importCohort(
        instructor(),
        file(
          enrolment({
            currentPhaseOrder: 2,
            phases: [
              carriedPhase('implementation', 1, 'l1/e1/p1'),
              carriedPhase('testing', 2, 'l1/e1/p2'),
            ],
            releases: [
              {
                phaseKey: 'implementation',
                phaseOrder: 1,
                version: 'v1',
                score: 80,
                notes: null,
                createdAt: '2026-08-21T00:00:00.000Z',
              },
            ],
          }),
        ),
      );
      await expectRefused(result, NUMBERS_DIFFER);
    });

    it('refuses a release or a current phase whose order is not one of its phases', async () => {
      const release = enrolment({
        releases: [
          {
            phaseKey: 'design',
            phaseOrder: 3,
            version: 'v1',
            score: 80,
            notes: null,
            createdAt: '2026-08-21T00:00:00.000Z',
          },
        ],
      });
      await expectRefused(
        await portability.importCohort(instructor(), file(release)),
        NUMBERS_DIFFER,
      );
      await publish([
        {
          version: holding('1.1.0', ['requirements', 'design', 'implementation']),
        },
      ]);
      await expectRefused(
        await portability.importCohort(
          instructor(),
          file(enrolment({ currentPhaseOrder: 5 })),
        ),
        NUMBERS_DIFFER,
      );
    });

    it('pins to the installed head, never to a published row with no snapshot', async () => {
      // 2.0.0 is the newest published row, and it holds no compiled
      // snapshot, so the registry installs 1.1.0 as the head and skips 2.0.0.
      versions = await publish([
        { version: holding('1.1.0') },
        { version: holding('2.0.0'), installed: false },
      ]);
      const result = await portability.importCohort(
        instructor(),
        file(enrolment({ packVersion: '0.0.9' })),
      );
      expect(result.written.enrollments).toBe(1);
      expect(result.learners[0].note).toBe(
        'Their tasktrackr 0.0.9 work came in pinned to 1.1.0: this machine does not have that version of the project, so the work reads the published one.',
      );
      const [row] = (await freshRows()).enrollments;
      expect(row.projectVersionId).toBe(versions.get('1.1.0'));
      expect(row.projectVersionId).not.toBe(versions.get('2.0.0'));
    });
    it('never pins to a named published row with no snapshot', async () => {
      // 2.0.0 is published here and the registry skipped it (no compiled
      // snapshot), so a pin to it would read whatever the head is at the time,
      // which is the null pin's harm under another id. It counts as a version
      // this machine does not hold.
      versions = await publish([
        { version: holding('1.1.0') },
        { version: holding('2.0.0'), installed: false },
      ]);
      // An ask for it is left in the file, as for any version not held here.
      const asked = await portability.importCohort(
        instructor(),
        file(enrolment({ projectVersion: '2.0.0' })),
      );
      expect(asked.learners[0].note).toContain(
        'Their tasktrackr 2.0.0 work is left in the file: this machine does not have that version of the project.',
      );
      expect(asked.learners[0].skippedProjects).toEqual(['tasktrackr']);
      expect(asked.written.enrollments).toBe(0);
      expect((await freshRows()).enrollments).toEqual([]);
      // Provenance naming it comes in on the installed head, and says so.
      const stamped = await portability.importCohort(
        instructor(),
        file(enrolment({ packVersion: '2.0.0' })),
      );
      expect(stamped.written.enrollments).toBe(1);
      expect(stamped.learners[0].note).toBe(
        'Their tasktrackr 2.0.0 work came in pinned to 1.1.0: this machine does not have that version of the project, so the work reads the published one.',
      );
      const [row] = (await freshRows()).enrollments;
      expect(row.projectVersionId).toBe(versions.get('1.1.0'));
      expect(row.projectVersionId).not.toBe(versions.get('2.0.0'));
    });

    it('refuses a release whose phase the file does not carry', async () => {
      // Implementation is order 3 on the six-phase head, so the key and its
      // order are the version's; no carried phase has order 3.
      const result = await portability.importCohort(
        instructor(),
        file(
          enrolment({
            releases: [
          {
            phaseKey: 'implementation',
            phaseOrder: 3,
            version: 'v1',
            score: 80,
            notes: null,
            createdAt: '2026-08-21T00:00:00.000Z',
          },
            ],
          }),
        ),
      );
      await expectRefused(result, NUMBERS_DIFFER);
    });

    it('refuses a release on a phase its version lacks', async () => {
      await publish([
        {
          version: holding('1.1.0', ['requirements', 'design', 'implementation']),
        },
      ]);
      const result = await portability.importCohort(
        instructor(),
        file(
          enrolment({
            releases: [
          {
            phaseKey: 'testing',
            phaseOrder: 4,
            version: 'v1',
            score: 80,
            notes: null,
            createdAt: '2026-08-21T00:00:00.000Z',
          },
            ],
          }),
        ),
      );
      await expectRefused(result, HOLDS_A_PHASE);
    });

    it("refuses a release at a carried phase's order that is not its own key's", async () => {
      // Design is order 2 here, and order 1 is carried (Requirements): only the
      // release's own key-to-order check can see it.
      const result = await portability.importCohort(
        instructor(),
        file(
          enrolment({
            releases: [
          {
            phaseKey: 'design',
            phaseOrder: 1,
            version: 'v1',
            score: 80,
            notes: null,
            createdAt: '2026-08-21T00:00:00.000Z',
          },
            ],
          }),
        ),
      );
      await expectRefused(result, NUMBERS_DIFFER);
    });

    it('leaves only the refused enrolment in the file', async () => {
      const second = (over: Record<string, unknown> = {}) =>
        enrolment({
          ref: 'l2/e1',
          phases: [
            carriedPhase('requirements', 1, 'l2/e1/p1'),
            carriedPhase('design', 2, 'l2/e1/p2'),
          ],
          ...over,
        });
      const result = await portability.importCohort(instructor(), {
        format: 'learnsdlc.cohort',
        formatVersion: COHORT_EXPORT_VERSION,
        cohort: { name: 'Captured' },
        learners: [
          {
            ref: 'l1',
            email: 'fresh@class.test',
            displayName: 'Fresh',
            enrollments: [
              enrolment({
                releases: [
          {
            phaseKey: 'implementation',
            phaseOrder: 3,
            version: 'v1',
            score: 80,
            notes: null,
            createdAt: '2026-08-21T00:00:00.000Z',
          },
                ],
              }),
            ],
          },
          {
            ref: 'l2',
            email: 'other@class.test',
            displayName: 'Other',
            enrollments: [second()],
          },
        ],
      });
      const [fresh, other] = result.learners;
      expect(fresh.note).toContain(
        `Their tasktrackr work is left in the file: ${NUMBERS_DIFFER}`,
      );
      expect(fresh.skippedProjects).toEqual(['tasktrackr']);
      expect(other.note).toBeNull();
      expect(other.skippedProjects).toEqual([]);
      expect(result.written.enrollments).toBe(1);
      expect(result.written.phaseStates).toBe(2);
      expect(result.written.releases).toBe(1);
      expect(await freshRows()).toEqual({
        enrollments: [],
        phaseStates: 0,
        submissions: 0,
        releases: 0,
      });
      const otherUser = await dataSource.manager.findOneOrFail(UserEntity, {
        where: { email: 'other@class.test' },
      });
      const rows = await dataSource.manager.find(EnrollmentEntity, {
        where: { userId: otherUser.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].projectVersionId).toBe(versions.get('1.1.0'));
    });

    it('names the head each unmatched version came in pinned to, pair by pair', async () => {
      // Two projects, each stamped with a version this machine does not
      // hold, so the note carries two pins and must not make the reader zip
      // two lists to tell which head each one got.
      const { listProjects, getProject } = content;
      const pack = addSecondProject(content);
      try {
        const manager = dataSource.manager;
        const project = await manager.save(
          manager.create(ProjectEntity, {
            slug: SECOND_PROJECT,
            title: 'Second pack',
            platformOwned: true,
            ownerUserId: null,
            isDefault: false,
            origin: 'seed',
          } as ProjectEntity),
        );
        const row = (await manager.save(
          manager.create(ProjectVersionEntity, {
            projectId: project.id,
            version: '3.0.0',
            status: 'published',
            manifest: {
              tagline: 'a version row, for resolving a pin against',
              description: 'seeded by portability.service.spec.ts',
              language: 'python',
              languages: ['python'],
            },
            publishedAt: '2026-09-01T00:00:00.000Z',
          } as never),
        )) as unknown as ProjectVersionEntity;
        content.installVersions([
          { versionId: versions.get('1.1.0') as string, content: holding('1.1.0') },
          { versionId: row.id, content: { ...pack, version: '3.0.0' } },
        ]);
        const result = await portability.importCohort(
          instructor(),
          file(
            enrolment({ packVersion: '0.0.9' }),
            enrolment({
              ref: 'l1/e2',
              projectSlug: SECOND_PROJECT,
              packVersion: '0.0.8',
              phases: [
                carriedPhase('requirements', 1, 'l1/e2/p1'),
                carriedPhase('design', 2, 'l1/e2/p2'),
              ],
            }),
          ),
        );
        expect(result.written.enrollments).toBe(2);
        expect(result.learners[0].note).toBe(
          `Their tasktrackr 0.0.9 work came in pinned to 1.1.0, ${SECOND_PROJECT} 0.0.8 work came in pinned to 3.0.0: this machine does not have that version of the project, so the work reads the published one.`,
        );
      } finally {
        content.listProjects = listProjects;
        content.getProject = getProject;
      }
    });
  });

  it('refuses a file that is not a class export, and one from a newer build', async () => {
    await expect(
      portability.importCohort(instructor(), { hello: 'world' }),
    ).rejects.toThrow(/not a class export/);
    const document = await asAnotherMachinesFile();
    await expect(
      // One past this build's own version, read from the constant rather than
      // typed: when COHORT_EXPORT_VERSION is bumped, a literal here would turn
      // "a file from a newer build" into "a file from this one".
      portability.importCohort(instructor(), {
        ...document,
        formatVersion: COHORT_EXPORT_VERSION + 1,
      }),
    ).rejects.toThrow(/newer version of LearnSDLC/);
    await expect(
      portability.importCohort(instructor(), { hello: 'world' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
