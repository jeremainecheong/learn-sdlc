import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { createHash } from 'crypto';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DataSource, getMetadataArgsStorage, type Logger as TypeOrmLogger } from 'typeorm';
import {
  ALL_ENTITIES,
  AgentProposalEntity,
  // The content model, which names people in four columns of its own
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  // The rows a teacher's own authoring writes, which the export carries
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
  AgentTurnEntity,
  SubmissionTeacherFeedbackEntity,
  AssistantMessageEntity,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  // One learner's paper on one quiz task
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  // The learner's state on one task of a phase, and what a reset took
  TaskResetEntity,
  TaskStateEntity,
  UserEntity,
  WarmupStateEntity,
  NotificationEntity,
  PreviewSessionEntity,
} from '../db/entities';
import { AdminService } from '../admin/admin.service';
import { optionToken, QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { AuthService } from '../auth/auth.service';
import { auditViews } from '../audit/audit';
import { AccountService, ACTOR_SCOPED_ENTITIES, CLEANUP_SCOPED_ENTITIES, SUBJECT_SCOPED_ENTITIES, USER_SCOPED_ENTITIES } from './account.service';
import { parseModelExplanationAssessment, UNDERSTANDING_DIMENSIONS } from '../assistant/explanation-assessment';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Let `intruder` run inside the next read of a users row.
 *
 * That read is the window these tests are about: the service has the row in hand,
 * has written nothing, and is about to spend a quarter of a second hashing at
 * cost 12. Anything another writer does in that quarter second is written back
 * over by a save of the row read before it. Driving the window from the read
 * rather than from a stubbed bcrypt keeps the timing exact instead of raced.
 *
 * One shot, so the intruder's own reads (and every later read the test makes)
 * pass straight through.
 */
const duringTheNextUserRead = (dataSource: DataSource, intruder: () => Promise<unknown>): void => {
  const manager = dataSource.manager;
  const read = manager.findOne.bind(manager);
  let armed = true;
  jest.spyOn(manager, 'findOne').mockImplementation((async (entity: unknown, options: unknown) => {
    const row = await read(entity as never, options as never);
    if (armed && entity === UserEntity) {
      armed = false;
      await intruder();
    }
    return row;
  }) as never);
};

/**
 * Read out of the decorator metadata rather than a second hand-written list:
 * a new table with a `userId` column appears here the moment it joins
 * ALL_ENTITIES, whether or not anyone remembered the account service.
 */
const entitiesScopedByUserId = (): string[] => {
  const declared = new Set(
    getMetadataArgsStorage()
      .columns.filter((column) => column.propertyName === 'userId')
      .map((column) => column.target),
  );
  return ALL_ENTITIES.filter((entity) => declared.has(entity))
    .map((entity) => entity.name)
    .sort();
};

/**
 * The same read for the other way a table can name a person: a `subjectUserId`
 * column. `audit_events` has one and no `userId`, so the list above cannot see
 * it: this is what stops the next such table slipping through the same gap.
 */
const entitiesScopedBySubjectUserId = (): string[] => {
  const declared = new Set(
    getMetadataArgsStorage()
      .columns.filter((column) => column.propertyName === 'subjectUserId')
      .map((column) => column.target),
  );
  return ALL_ENTITIES.filter((entity) => declared.has(entity))
    .map((entity) => entity.name)
    .sort();
};

/**
 * And the third way a table can name a person: as the **actor** of a record
 * that is somebody else's: a project's author, a version's publisher, a
 * class's assigner, a learner's countersignature.
 *
 * Not one of those four columns is visible to either scan above, so before this
 * one a teacher could delete their account, the suite stay green, and a live
 * class's content provenance dangle. With `ownerUserId` documented as "NULL =
 * platform-owned" that dangling case is one step from reading as platform
 * content, which is why `projects` carries an explicit `platformOwned` boolean
 * and stops inferring ownership from a NULL.
 */
const ACTOR_COLUMNS = ['ownerUserId', 'publishedByUserId', 'assignedByUserId', 'signedOffBy'];

const entitiesScopedByActor = (): string[] => {
  const declared = new Set(
    getMetadataArgsStorage()
      .columns.filter((column) => ACTOR_COLUMNS.includes(column.propertyName))
      .map((column) => column.target),
  );
  return ALL_ENTITIES.filter((entity) => declared.has(entity))
    .map((entity) => entity.name)
    .sort();
};

describe('SUBJECT_SCOPED_ENTITIES', () => {
  it('names every entity that records a person as the subject of an action', () => {
    expect(SUBJECT_SCOPED_ENTITIES.map(({ entity }) => entity.name).sort()).toEqual(
      entitiesScopedBySubjectUserId(),
    );
  });
});

describe('ACTOR_SCOPED_ENTITIES', () => {
  it('covers every actor column, so the next one fails the suite rather than the class', () => {
    expect(ACTOR_SCOPED_ENTITIES.map(({ entity }) => entity.name).sort()).toEqual(
      entitiesScopedByActor(),
    );
  });

  it('says what happens to each of them, and names the column it is about', () => {
    expect(
      ACTOR_SCOPED_ENTITIES.map(({ entity, column, policy }) => `${entity.name}.${column}: ${policy}`),
    ).toEqual([
      // The two the deletion acts on: a class is refused while anyone is in it
      // and closed when it is empty, and a project is refused while an
      // enrolment pins one of its published versions and archived when none
      // does. Everything else is an actor on somebody else's record and is left
      // exactly as it is: the phase gate reads whether a sign-off is set, so
      // nulling one would reclose a phase a teacher had opened.
      'CohortEntity.ownerUserId: refused-then-closed',
      'ProjectEntity.ownerUserId: refused-then-archived',
      'ProjectVersionEntity.publishedByUserId: kept',
      'CohortProjectAssignmentEntity.assignedByUserId: kept',
      // The countersignature. Kept for the reason the note above
      // gives in as many words: the gate reads whether a sign-off is set, so
      // nulling this one would reclose a phase a teacher had opened, for every
      // learner they had ever signed off, on the day they left.
      'TaskStateEntity.signedOffBy: kept',
    ]);
  });
});

describe('USER_SCOPED_ENTITIES', () => {
  it('accounts for every userId entity as coursework or bounded operational cleanup', () => {
    // The privacy policy promises a complete export and complete erasure, and
    // both operations read this one list, so the list is what has to be
    // exhaustive. Adding a userId-bearing table without listing it fails here
    // rather than silently omitting it from exports and orphaning it on delete.
    expect([...USER_SCOPED_ENTITIES.map(({ entity }) => entity.name), ...CLEANUP_SCOPED_ENTITIES.map(entity => entity.name)].sort()).toEqual(
      entitiesScopedByUserId(),
    );
    expect(CLEANUP_SCOPED_ENTITIES).toEqual([PreviewSessionEntity]);
    expect(USER_SCOPED_ENTITIES.some(({ entity }) => entity === PreviewSessionEntity)).toBe(false);
  });

  it('gives each table its own export key', () => {
    const keys = USER_SCOPED_ENTITIES.map(({ exportKey }) => exportKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists a quiz paper immediately after the submission it hangs off', () => {
    // Quiz papers. The position is the whole rule, so it is asserted rather
    // than described: `quiz_attempts.submissionId` names the revision the
    // grader scored, the export reads this list forwards and the deletion
    // reads it backwards, so a paper listed *before* its parent would be
    // deleted after it and leave, for the width of one statement, a row
    // pointing at a submission that has already gone. Anywhere later in the
    // list is still correct for the deletion and wrong for the reading order.
    const keys = USER_SCOPED_ENTITIES.map(({ exportKey }) => exportKey);
    expect(keys[keys.indexOf('submissions') + 1]).toBe('quizAttempts');
    expect(
      USER_SCOPED_ENTITIES.find(({ exportKey }) => exportKey === 'quizAttempts')!.entity,
    ).toBe(QuizAttemptEntity);
  });
});

describe('AccountService', () => {
  let dataSource: DataSource;
  let account: AccountService;
  /** The other writer on the users row: the console an operator is sitting at. */
  let admin: AdminService;
  /** Real, so a token minted mid-race is judged by the guard rather than by the test. */
  let auth: AuthService;
  let ownerId = '';
  let bystanderId = '';

  const ownerEmail = 'owner@learnsdlc.test';
  const bystanderEmail = 'bystander@learnsdlc.test';
  const passwordHash = '$2a$10$this-is-not-a-real-bcrypt-hash';
  const missingId = '00000000-0000-4000-8000-000000000000';

  /** A learner with one row in every table USER_SCOPED_ENTITIES names. */
  const seed = async (email: string): Promise<string> => {
    const manager = dataSource.manager;
    const user = await manager.save(
      manager.create(UserEntity, { email, passwordHash, displayName: 'Learner' }),
    );
    const enrollment = await manager.save(
      manager.create(EnrollmentEntity, { userId: user.id, projectSlug: 'tasktrackr' }),
    );
    const phase = await manager.save(
      manager.create(PhaseStateEntity, {
        userId: user.id,
        enrollmentId: enrollment.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        // Carries the address so a cross-account leak shows up as a string match.
        workspace: { 'requirements/draft.md': `# private draft by ${email}` },
      }),
    );
    // This learner's state on one authored task of the phase, and
    // what a reset of that task took away. Both carry the address, for the same
    // reason the workspace above does: a cross-account leak then shows up as a
    // string match rather than as a count.
    const task = await manager.save(
      manager.create(TaskStateEntity, {
        userId: user.id,
        phaseStateId: phase.id,
        taskKey: 'story',
      }),
    );
    await manager.save(
      manager.create(TaskResetEntity, {
        userId: user.id,
        taskStateId: task.id,
        files: { 'requirements/draft.md': `# reset draft by ${email}` },
      }),
    );
    const submission = await manager.save(
      manager.create(SubmissionEntity, { userId: user.id, phaseStateId: phase.id }),
    );
    // One handed-in quiz paper, hanging off that submission. The row
    // is a draw and a permutation (the ids of the two questions this learner
    // was shown and the option ids in the order they saw them) plus what they
    // picked and what it scored. `q3` is in the pool and not on this paper, and
    // no column on this table says which option was the right one; both facts
    // are what the export tests below read.
    await manager.save(
      manager.create(QuizAttemptEntity, {
        userId: user.id,
        phaseStateId: phase.id,
        taskKey: 'concepts',
        projectVersionId: 'version-under-test',
        packVersion: '1.1.0',
        submissionId: submission.id,
        paper: [
          { questionId: 'q1', optionIds: ['q1-b', 'q1-a', 'q1-c'] },
          { questionId: 'q2', optionIds: ['q2-a', 'q2-b'] },
        ],
        answers: { q1: ['q1-a'], q2: ['q2-b'] },
        score: 50,
        passed: false,
        startedAt: '2026-09-19T01:00:00.000Z',
        submittedAt: '2026-09-19T01:04:00.000Z',
      }),
    );
    await manager.save(
      manager.create(ExecutionRunEntity, { userId: user.id, phaseStateId: phase.id }),
    );
    await manager.save(
      manager.create(AssistantMessageEntity, {
        userId: user.id,
        enrollmentId: enrollment.id,
        phaseStateId: phase.id,
        phaseKey: 'requirements',
        role: 'user',
        content: 'what makes an acceptance criterion testable?',
      }),
    );
    await manager.save(
      manager.create(ReleaseRecordEntity, {
        userId: user.id,
        enrollmentId: enrollment.id,
        phaseStateId: phase.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        version: 'v1',
        score: 82,
        // Carries the address too: a merge message is the learner's own words.
        notes: `merged by ${email}`,
      }),
    );
    // The warm-up is the learner's own files too, so the export
    // and the erasure have to reach it. Carries the address for the same
    // reason the workspace above does.
    await manager.save(
      manager.create(WarmupStateEntity, {
        userId: user.id,
        projectSlug: 'tasktrackr',
        status: 'in_progress',
        workspace: { 'web/src/lib/greeting.ts': `// warm-up by ${email}` },
      }),
    );
    // The bell. A notification is a pointer rather than a record,
    // but it is a pointer *at this learner*, keyed by their id, so the export
    // has to carry it and the erasure has to take it. Carries the address for
    // the same reason the rows above do.
    await manager.save(
      manager.create(NotificationEntity, {
        userId: user.id,
        audience: 'learner',
        kind: 'instructor.note',
        subjectKey: `note-${email}`,
        title: 'A note from Ana Tan',
        detail: `written for ${email}`,
        href: '/dashboard',
      }),
    );
    await manager.save(manager.create(AgentProposalEntity, {
      userId: user.id, phaseStateId: phase.id, prompt: `private proposal for ${email}`,
      files: { 'requirements/draft.md': 'a proposed draft' }, proposalHash: 'a'.repeat(64),
      baseWorkspaceHash: 'b'.repeat(64), assessment: { adequate: false, feedback: 'Prompt has no constraints', questions: ['Explain the boundary'] },
    }));
    await manager.save(manager.create(AgentTurnEntity, {
      userId: user.id, phaseStateId: phase.id, requestId: 'request-' + user.id,
      requestHash: 'c'.repeat(64), kind: 'chat', status: 'completed',
      message: `private agent question from ${email}`, baseWorkspaceHash: 'b'.repeat(64),
      response: { kind: 'discussion', reply: `private agent reply for ${email}`, questions: [], proposal: null },
    }));
    await manager.save(manager.create(SubmissionTeacherFeedbackEntity, {
      userId: user.id, phaseStateId: phase.id, submissionId: 'submission-' + user.id,
      cohortId: 'class-test', authorUserId: 'teacher-test', authorName: 'Teacher',
      requestId: 'request-' + user.id, action: 'comment', text: `Feedback for ${email}`,
    }));
    return user.id;
  };

  /**
   * An override written about `subjectId` by `actorId`. The reason carries the
   * subject's address, so a row that outlives a deletion shows up as a string
   * match rather than a count.
   */
  const seedAudit = async (actorId: string, subjectId: string, subjectEmail: string) => {
    await dataSource.manager.save(
      dataSource.manager.create(AuditEventEntity, {
        event: 'phase.override',
        actorUserId: actorId,
        subjectUserId: subjectId,
        action: 'pass',
        reason: `discussed in class with ${subjectEmail}`,
      }),
    );
  };

  /**
   * A class owned by `ownerId`, with `learners` accounts sitting in it. Both
   * halves matter to account deletion: ownership is `cohorts.ownerUserId` and membership is
   * `users.cohort`, and neither is a foreign key, so nothing cascades and the
   * deletion has to look for both by hand.
   */
  const seedCohort = async (owner: string, name: string, learners = 0): Promise<string> => {
    const manager = dataSource.manager;
    const cohort = await manager.save(
      manager.create(CohortEntity, { name, joinCode: name.toUpperCase().slice(0, 8), ownerUserId: owner }),
    );
    await manager.update(UserEntity, { id: owner }, { cohort: cohort.id, role: 'INSTRUCTOR' });
    for (let i = 0; i < learners; i++) {
      const learner = await manager.save(
        manager.create(UserEntity, {
          email: `${name}-${i}@learnsdlc.test`,
          passwordHash,
          displayName: `Learner ${i}`,
          cohort: cohort.id,
        }),
      );
      expect(learner.cohort).toBe(cohort.id);
    }
    return cohort.id;
  };

  /**
   * A project this account authored, with one published version, one blob and
   * one file row, so "archived, not deleted" can be told from "deleted", and
   * so the blobs can be shown to be untouched.
   */
  const seedProject = async (
    owner: string,
    slug: string,
    title: string,
    publishedBy: string = owner,
  ): Promise<{ project: ProjectEntity; version: ProjectVersionEntity }> => {
    const manager = dataSource.manager;
    const project = await manager.save(
      manager.create(ProjectEntity, {
        slug,
        title,
        origin: 'blank',
        platformOwned: false,
        ownerUserId: owner,
      }),
    );
    const version = await manager.save(
      manager.create(ProjectVersionEntity, {
        projectId: project.id,
        version: '1.2.0',
        status: 'published',
        manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] },
        publishedByUserId: publishedBy,
        publishedAt: new Date().toISOString(),
      }),
    );
    const bytes = `# ${slug}\n`;
    const blob = await manager.save(
      manager.create(ContentBlobEntity, {
        sha: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        size: Buffer.byteLength(bytes, 'utf-8'),
      }),
    );
    await manager.save(
      manager.create(ProjectFileEntity, {
        projectVersionId: version.id,
        ownerKind: 'project',
        ownerId: project.id,
        path: 'README.md',
        role: 'workspace',
        editable: true,
        language: 'markdown',
        blobSha: blob.sha,
      }),
    );
    return { project, version };
  };

  /** Learners enrolled on `versionId`, each in the class they are named with. */
  const pinLearners = async (
    versionId: string,
    slug: string,
    learners: [string, string][],
  ): Promise<void> => {
    const manager = dataSource.manager;
    for (const [name, cohort] of learners) {
      const learner = await manager.save(
        manager.create(UserEntity, {
          email: `${name}@learnsdlc.test`,
          passwordHash,
          displayName: name,
          cohort,
        }),
      );
      await manager.save(
        manager.create(EnrollmentEntity, {
          userId: learner.id,
          projectSlug: slug,
          packVersion: '1.2.0',
          projectVersionId: versionId,
        }),
      );
    }
  };

  /**
   * The same learners with **no pin**, which is the shape every enrolment
   * created through the ordinary door has: `writeEnrollment` writes `userId`,
   * `projectSlug`, `currentPhaseOrder` and `packVersion`, and the only writer of
   * `projectVersionId` anywhere in this tree is the cohort importer.
   */
  const enrolUnpinned = async (slug: string, learners: [string, string][]): Promise<void> => {
    const manager = dataSource.manager;
    for (const [name, cohort] of learners) {
      const learner = await manager.save(
        manager.create(UserEntity, {
          email: `${name}@learnsdlc.test`,
          passwordHash,
          displayName: name,
          cohort,
        }),
      );
      await manager.save(
        manager.create(EnrollmentEntity, {
          userId: learner.id,
          projectSlug: slug,
          packVersion: '1.2.0',
        }),
      );
    }
  };

  /** Keyed by export key so a failure names the table that kept its rows. */
  const rowCounts = async (userId: string): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const { exportKey, entity } of USER_SCOPED_ENTITIES) {
      counts[exportKey] = await dataSource.manager.count(entity, { where: { userId } });
    }
    return counts;
  };

  const countsOf = (n: number): Record<string, number> =>
    Object.fromEntries(USER_SCOPED_ENTITIES.map(({ exportKey }) => [exportKey, n]));

  /** Every statement `run` sends, in order, so a test can say what was written. */
  const recordQueries = async (run: () => Promise<unknown>): Promise<string[]> => {
    const queries: string[] = [];
    const previous = dataSource.logger;
    dataSource.logger = {
      logQuery: (query: string) => {
        queries.push(query);
      },
      logQueryError: () => undefined,
      logQuerySlow: () => undefined,
      logSchemaBuild: () => undefined,
      logMigration: () => undefined,
      log: () => undefined,
    } satisfies TypeOrmLogger;
    try {
      await run();
    } finally {
      dataSource.logger = previous;
    }
    return queries;
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    account = new AccountService(passwordWorkFixture(), dataSource);
    admin = new AdminService(passwordWorkFixture(), dataSource);
    auth = new AuthService(passwordWorkFixture(), 
      dataSource.getRepository(UserEntity),
      new JwtService({ secret: 'account-spec', signOptions: { expiresIn: '1h' } }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    ownerId = await seed(ownerEmail);
    bystanderId = await seed(bystanderEmail);
  });

  describe('exportData', () => {
    it.each([['v5', false], ['v5', true], ['v6', false], ['v6', true]] as const)('preserves exact understanding history while protecting rejected rationale (version=%s, adequate=%s)', async (version, adequate) => {
      const learnerText = 'My exact answer.\nRésumé: café.\n';
      // Legacy snapshots are seeded directly: the current parser must not
      // manufacture a new approval from their old freeform contract.
      const assessment = version === 'v5' ? {
        version: 'learner-understanding-v5', answerHash: createHash('sha256').update(learnerText).digest('hex'), adequate,
        feedback: 'INTERNAL REFERENCE RECIPE', questions: adequate ? [] : ['Repeat the entire reference solution'],
        dimensions: UNDERSTANDING_DIMENSIONS.map(key => ({ key, met: adequate, learnerEvidence: [learnerText], reasoning: 'INTERNAL REFERENCE RECIPE' })),
      } : parseModelExplanationAssessment({ dimensions: UNDERSTANDING_DIMENSIONS.map(key => ({ key,
        met: adequate || key === 'consistency', finding: adequate || key === 'consistency' ? 'supported' : 'missing', learnerEvidenceIds: ['E1', 'E2'],
      })) }, learnerText);
      const proposal = await dataSource.manager.findOneByOrFail(AgentProposalEntity, { userId: ownerId });
      await dataSource.manager.update(AgentProposalEntity, proposal.id, { explanation: learnerText, explanationAssessment: assessment });
      const saved = await dataSource.manager.findOneByOrFail(AgentProposalEntity, { id: proposal.id });
      const turn = await dataSource.manager.findOneByOrFail(AgentTurnEntity, { userId: ownerId });
      await dataSource.manager.update(AgentTurnEntity, turn.id, { kind: 'explain', message: learnerText, response: { kind: 'explanation', reply: assessment.feedback, questions: assessment.questions, proposal: saved } });
      const exported = await account.exportData(ownerId);
      const exportedProposal = (exported.agentProposals as AgentProposalEntity[])[0];
      const exportedTurn = (exported.agentTurns as AgentTurnEntity[])[0];
      expect(exportedProposal.explanation).toBe(learnerText);
      expect(exportedTurn.message).toBe(learnerText);
      const exportedAssessment = exportedProposal.explanationAssessment as typeof assessment;
      expect(exportedAssessment.adequate).toBe(adequate);
      expect(exportedAssessment.answerHash).toBe(assessment.answerHash);
      expect(exportedAssessment.dimensions.map(({ reasoning: _reasoning, ...d }) => d)).toEqual(assessment.dimensions.map(({ reasoning: _reasoning, ...d }) => d));
      expect(JSON.stringify(exported).includes('INTERNAL REFERENCE RECIPE')).toBe(version === 'v5' && adequate);
      expect(exported.teacherFeedback).toEqual(await dataSource.manager.find(SubmissionTeacherFeedbackEntity, { where: { userId: ownerId } }));
      expect((await dataSource.manager.findOneByOrFail(AgentProposalEntity, { id: proposal.id })).explanationAssessment).toEqual(assessment);
      expect((await dataSource.manager.findOneByOrFail(AgentTurnEntity, { id: turn.id })).response).toMatchObject({ reply: assessment.feedback });
      expect(exported.note).toContain('learner-facing assessment feedback');
    });

    it('returns a table for every entity the constant names', async () => {
      const data = await account.exportData(ownerId);
      for (const { exportKey } of USER_SCOPED_ENTITIES) {
        expect(data[exportKey]).toHaveLength(1);
      }
    });

    /**
     * `task_resets` is an export and erasure table; this pins that a copy the
     * learner's reset writes (the bytes it took) is handed back under
     * `taskResets`, and goes with the account.
     */
    it('hands back what a reset took, under taskResets, and erases it with the account', async () => {
      const data = await account.exportData(ownerId);
      expect(JSON.stringify(data.taskResets)).toContain(`# reset draft by ${ownerEmail}`);
      await account.deleteAccount(ownerId, ownerEmail);
      expect(await dataSource.manager.count(TaskResetEntity, { where: { userId: ownerId } })).toBe(0);
      expect(await dataSource.manager.count(TaskResetEntity, { where: { userId: bystanderId } })).toBe(1);
    });

    it('describes the account but never the password hash', async () => {
      const data = await account.exportData(ownerId);
      expect(data.account).toMatchObject({ id: ownerId, email: ownerEmail });
      expect(JSON.stringify(data)).not.toContain(passwordHash);
    });

    it("carries none of another learner's rows", async () => {
      const data = await account.exportData(ownerId);
      expect(JSON.stringify(data)).not.toContain(bystanderEmail);
    });

    it('includes the staff actions written about this account', async () => {
      await seedAudit(bystanderId, ownerId, ownerEmail);
      const data = await account.exportData(ownerId);
      expect(data.auditEvents).toHaveLength(1);
      expect(JSON.stringify(data.auditEvents)).toContain(ownerEmail);
    });

    it('carries no audit row about somebody else', async () => {
      await seedAudit(bystanderId, bystanderId, bystanderEmail);
      const data = await account.exportData(ownerId);
      expect(data.auditEvents).toEqual([]);
    });

    it('carries the learner’s own papers, and no answer key', async () => {
      // The rule the whole quiz design turns on: the answer key is never sent
      // to a learner on any route, and this is a route. It
      // holds by construction rather than by a filter (`quiz_attempts` has no
      // column for a key, a stem, an explanation or a question the draw passed
      // over) so what this asserts is that the export is still *the row*, and
      // that nobody has since joined the sealed slice onto it on the way out.
      const data = await account.exportData(ownerId);
      const papers = data.quizAttempts as QuizAttemptEntity[];
      expect(papers).toHaveLength(1);
      // Every option is named by this paper's own token, which is
      // how the room served it and how the report names it, never by the id
      // the teacher wrote, which is the order they wrote the options in.
      const token = (questionId: string, optionId: string) =>
        optionToken(papers[0].id, questionId, optionId);
      expect(papers[0]).toMatchObject({
        userId: ownerId,
        taskKey: 'concepts',
        answers: { q1: [token('q1', 'q1-a')], q2: [token('q2', 'q2-b')] },
        score: 50,
        passed: false,
        submittedAt: '2026-09-19T01:04:00.000Z',
      });
      // The paper is the draw and the permutation, and nothing more: the
      // questions this learner was shown, and the options in their order.
      expect(papers[0].paper).toEqual([
        { questionId: 'q1', optionIds: ['q1-b', 'q1-a', 'q1-c'].map((id) => token('q1', id)) },
        { questionId: 'q2', optionIds: ['q2-a', 'q2-b'].map((id) => token('q2', id)) },
      ]);
      // Column by column, so a key smuggled in under any name fails here
      // rather than in a code review. `epoch` and `voidedAt` are the
      // recovery's two columns and they are named here deliberately: this
      // assertion exists to go red when the table grows, and the reading it
      // asks for is that neither carries anything a learner may not see. An
      // integer counting which run of the quiz a paper belongs to, and the
      // instant a teacher's reset closed an unsat paper, are facts about the
      // learner's own attempt: they are in the export for the same reason
      // `startedAt` is.
      expect(Object.keys(papers[0]).sort()).toEqual(
        [
          'answers', 'createdAt', 'epoch', 'id', 'packVersion', 'paper', 'passed',
          'phaseStateId', 'projectVersionId', 'score', 'startedAt',
          'submissionId', 'submittedAt', 'taskKey', 'userId', 'voidedAt',
        ].sort(),
      );
      const text = JSON.stringify(data.quizAttempts);
      // `correct` is the one key-bearing field in the whole contract, and
      // `explanation` is what a learner earns by finishing a question rather
      // than by asking for their data. Neither is a column here.
      for (const sealed of ['correct', 'explanation', 'stem', 'outcome']) {
        expect(text).not.toContain(sealed);
      }
      // A question in the pool that this paper did not draw is not in this
      // table at all, so it cannot leave through this door either.
      expect(text).not.toContain('q3');
    });

    it('names every option of an open paper by that paper’s token, never by the teacher’s id', async () => {
      // The export is a door of its own for the option ids.
      // A paper is written when it is DRAWN, so a learner who opens a paper and
      // then asks for their data (before answering anything) would read the
      // options in display order under the ids the teacher wrote them with.
      // Authoring mints those ids 'a', 'b', … from the top, so a teacher who
      // always writes the right answer first hands over the key by position.
      // The export speaks the paper's own language instead, the tokens the
      // room served and the report names: stable for the paper, opaque off it.
      const manager = dataSource.manager;
      const held = await manager.findOneByOrFail(QuizAttemptEntity, { userId: ownerId });
      const authored = ['a', 'b', 'c', 'd'];
      const opened = await new QuizAttemptsService(manager.getRepository(QuizAttemptEntity)).start({
        phaseStateId: held.phaseStateId,
        userId: ownerId,
        taskKey: 'story-concepts',
        projectVersionId: 'version-under-test',
        epoch: 0,
        checks: {
          kind: 'quiz',
          questions: ['q-first', 'q-second'].map((id) => ({
            id,
            stem: `The ${id} stem.`,
            options: authored.map((option) => ({ id: option, text: `Option ${option}` })),
            correct: ['a'],
            explanation: `Why ${id} is answered as it is.`,
            concept: 'concepts',
          })),
          shuffleOptions: true,
          passMark: 50,
          attempts: { max: 2, cooldownSeconds: null },
          criterion: 'concepts',
        },
      });
      expect(opened.submittedAt).toBeNull();

      const papers = (await account.exportData(ownerId)).quizAttempts as QuizAttemptEntity[];
      const open = papers.find((one) => one.id === opened.id)!;
      expect(open.answers).toBeNull();
      const exported = open.paper.flatMap((question) => question.optionIds);
      expect(exported).toHaveLength(8);
      for (const id of exported) expect(id).toMatch(/^o[0-9a-f]{24}$/);
      // Each one is the token the room served for that option on this paper.
      expect(open.paper).toEqual(
        opened.paper.map((question) => ({
          questionId: question.questionId,
          optionIds: question.optionIds.map((id) => optionToken(opened.id, question.questionId, id)),
        })),
      );
      // And no authored option id is anywhere in what this door hands out:
      // not on the open paper, not on the one already handed in.
      const everyOption = papers.flatMap((paper) => [
        ...paper.paper.flatMap((question) => question.optionIds),
        ...Object.values(paper.answers ?? {}).flat(),
      ]);
      for (const id of everyOption) {
        expect(authored).not.toContain(id);
        expect(['q1-a', 'q1-b', 'q1-c', 'q2-a', 'q2-b']).not.toContain(id);
      }
    });

    it('carries a paper a teacher’s reset voided, rather than losing it', async () => {
      // A reset returns a learner's attempts by starting a new epoch; it does
      // not delete a paper, and the paper it closes without a sheet is still
      // part of what happened to this learner. Both the export and the erasure
      // walk `userId` with no predicate on `submittedAt` or `voidedAt`, so
      // every row of the table is covered: this is that stated as a test
      // rather than as a reading of the scan.
      const manager = dataSource.manager;
      const paper = await manager.findOneByOrFail(QuizAttemptEntity, { userId: ownerId });
      await manager.save(
        manager.create(QuizAttemptEntity, {
          userId: ownerId,
          phaseStateId: paper.phaseStateId,
          taskKey: 'concepts',
          epoch: 0,
          projectVersionId: 'version-under-test',
          paper: [{ questionId: 'q1', optionIds: ['q1-a', 'q1-b', 'q1-c'] }],
          startedAt: '2026-09-19T02:00:00.000Z',
          submittedAt: '2026-09-19T02:30:00.000Z',
          voidedAt: '2026-09-19T02:30:00.000Z',
        }),
      );

      const papers = (await account.exportData(ownerId)).quizAttempts as QuizAttemptEntity[];
      expect(papers).toHaveLength(2);
      const voided = papers.find((one) => one.voidedAt !== null)!;
      // Closed, never sat: it says so, and it says nothing else.
      expect(voided).toMatchObject({ answers: null, score: null, passed: null, submissionId: null });
      for (const sealed of ['correct', 'explanation', 'stem']) {
        expect(JSON.stringify(papers)).not.toContain(sealed);
      }
    });

    it('hands back what a teacher wrote on a quiz task, and never its answer key', async () => {
      // Quizzes follow the same rule the note above `authoredProjects`
      // states for `project_versions.compiled`: what a teacher *wrote* comes
      // out, and the sealed slice of what they *copied* does not. A quiz's
      // sealed slice is its key and its explanations (`correct` is the one
      // key-bearing field in the whole contract) so this door has to hold the
      // same line every other door holds. It does so through the older-written
      // test on `checks.kind` (`isOlderWritten`), which a quiz never passes; the
      // test is here so that widening it fails rather than ships.
      const { project, version } = await seedProject(ownerId, 'quiz-project', 'Quiz Project');
      const manager = dataSource.manager;
      const phase = await manager.save(
        manager.create(ProjectPhaseEntity, {
          projectVersionId: version.id,
          key: 'requirements',
          order: 1,
          title: 'Requirements',
          intro: 'The phase intro the teacher wrote.',
          artifactKind: 'story',
          assistant: { systemPrompt: '', topics: [], progressive: [] },
        }),
      );
      await manager.save(
        manager.create(ProjectTaskEntity, {
          projectPhaseId: phase.id,
          taskKey: 'concepts',
          order: 1,
          required: true,
          artefactType: 'quiz',
          artefactPath: null,
          title: 'Check the concepts',
          brief: 'The brief the teacher wrote.',
          objectives: ['Tell a user story from a task'],
          rubric: { passThreshold: 60, criteria: [] },
          // A deliberately fake paper. Real questions are the authors'
          // to write; this one exists so the seal can be tested against
          // something that would be a leak if it left.
          checks: {
            kind: 'quiz',
            questions: [
              {
                id: 'fixture-q1',
                stem: 'FIXTURE QUESTION, not reviewed content',
                options: [
                  { id: 'fixture-q1-a', text: 'FIXTURE OPTION A' },
                  { id: 'fixture-q1-b', text: 'FIXTURE OPTION B' },
                ],
                correct: ['fixture-q1-b'],
                explanation: 'FIXTURE EXPLANATION, SEALED',
                concept: 'fixture-concept',
              },
            ],
            shuffleOptions: true,
            passMark: 60,
            attempts: { max: null, cooldownSeconds: null },
            criterion: 'the concepts behind the work',
          },
        }),
      );

      const data = await account.exportData(ownerId);
      const authored = data.authoredProjects as {
        slug: string;
        versions: { phases: { tasks: Record<string, unknown>[] }[] }[];
      }[];
      const mine = authored.find((one) => one.slug === project.slug)!;
      const task = mine.versions[0].phases[0].tasks[0];
      // Their own writing, in full.
      expect(task).toMatchObject({
        taskKey: 'concepts',
        title: 'Check the concepts',
        brief: 'The brief the teacher wrote.',
        objectives: ['Tell a user story from a task'],
        artefactType: 'quiz',
      });
      // And the paper itself, in none of it: a quiz's `checks` are not a
      // teacher's prose, they are the graded slice, exactly as a code task's
      // hidden suite is.
      expect(task.rules).toEqual([]);
      expect(task.rubric).toBeNull();
      const wire = JSON.stringify(data.authoredProjects);
      for (const sealed of [
        'FIXTURE EXPLANATION, SEALED',
        'FIXTURE QUESTION, not reviewed content',
        'fixture-q1-b',
        'correct',
        'passMark',
      ]) {
        expect(wire).not.toContain(sealed);
      }
    });

    it('carries no paper of another learner’s', async () => {
      const theirs = await dataSource.manager.findOneByOrFail(QuizAttemptEntity, {
        userId: bystanderId,
      });
      const data = await account.exportData(ownerId);
      expect(JSON.stringify(data)).not.toContain(theirs.id);
    });

    it('refuses an id with no account behind it', async () => {
      await expect(account.exportData(missingId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateProfile', () => {
    it('rejects stale profile drafts without overwriting another tab’s saved fields', async () => {
      const initial = await auth.profile(ownerId);
      const saved = await account.updateProfile(ownerId, { displayName: initial.displayName, bio: 'Saved in tab one', baseVersion: initial.profileVersion });
      expect(saved).toMatchObject({ profileVersion: 1 });
      await expect(account.updateProfile(ownerId, { displayName: initial.displayName, bio: 'Stale tab two', goals: 'Another draft', baseVersion: initial.profileVersion })).rejects.toThrow('changed in another tab');
      expect(await auth.profile(ownerId)).toMatchObject({ bio: 'Saved in tab one', goals: '', profileVersion: 1 });
      const fresh = await auth.profile(ownerId);
      await account.updateProfile(ownerId, { displayName: fresh.displayName, goals: 'Merged deliberately', baseVersion: fresh.profileVersion });
      expect(await auth.profile(ownerId)).toMatchObject({ bio: 'Saved in tab one', goals: 'Merged deliberately', profileVersion: 2 });
    });

    it('allows only one of two simultaneous edits based on the same profile revision', async () => {
      const results = await Promise.allSettled([
        account.updateProfile(ownerId, { displayName: 'First editor', baseVersion: 0 }),
        account.updateProfile(ownerId, { displayName: 'Second editor', baseVersion: 0 }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await auth.profile(ownerId)).toMatchObject({ profileVersion: 1 });
    });

    it('persists generated avatar, biography, goals and onboarding without altering role or history', async () => {
      const before = await rowCounts(ownerId);
      const profile = await account.updateProfile(ownerId, { displayName: ' Ada ', avatar: 5, bio: ' A builder ', goals: ' Better tests ', onboardingCompleted: true });
      expect(profile).toMatchObject({ id: ownerId, displayName: 'Ada', avatar: 5, bio: 'A builder', goals: 'Better tests', onboardingCompleted: true, role: 'LEARNER' });
      expect(await auth.profile(ownerId)).toMatchObject({ avatar: 5, bio: 'A builder', onboardingCompleted: true });
      expect(await rowCounts(ownerId)).toEqual(before);
      expect(await auth.profile(bystanderId)).toMatchObject({ avatar: 0, bio: '', onboardingCompleted: false });
    });

    it('renames the account, trimming what was typed', async () => {
      await expect(account.updateProfile(ownerId, { displayName: '  Ada Lovelace  ' })).resolves.toMatchObject({
        id: ownerId,
        displayName: 'Ada Lovelace',
      });
      expect((await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId })).displayName).toBe(
        'Ada Lovelace',
      );
    });

    it('refuses an id with no account behind it', async () => {
      await expect(account.updateProfile(missingId, { displayName: 'Nobody' })).rejects.toThrow(NotFoundException);
    });

    /**
     * The empty case.
     *
     * Length is the DTO's rule and it counts characters before this trims
     * them, so two spaces are two characters to the pipe and nothing at all
     * here. The service writes what it is given, which is the right division
     * of labour; a guard against an all-whitespace name belongs one layer up,
     * in `UpdateProfileDto`. Either way this stays true, which is why it is
     * here rather than left to the route.
     */
    it('writes what it is handed once trimmed, empty included', async () => {
      await expect(account.updateProfile(ownerId, { displayName: '   ' })).resolves.toMatchObject({ displayName: '' });
      expect(
        (await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId })).displayName,
      ).toBe('');
    });

    it('writes one statement naming the columns it owns, and never loads the row to save it whole', async () => {
      // A rename that loads the row and saves it writes every column it read,
      // so a suspension made between the load and the save is carried away by
      // it: the account is silently restored by somebody editing their name.
      // The window is the load, so the assertion is that nothing is read before
      // the one UPDATE, which names only the columns this operation owns. The
      // profile is read back afterwards only to answer with it.
      const queries = await recordQueries(() => account.updateProfile(ownerId, { displayName: 'Ada' }));

      expect(queries[0]).toContain('UPDATE "users"');
      expect(queries.filter((query) => query.includes('UPDATE'))).toHaveLength(1);
      expect(queries[0]).toContain('"displayName"');
      expect(queries[0]).not.toContain('"disabledAt"');
      expect(queries[0]).not.toContain('"tokenVersion"');
    });
  });

  describe('changePassword', () => {
    const current = 'Correct-Horse-9';
    const replacement = 'Staple-Battery-42';

    /** The seed's placeholder hash matches nothing; these cases need a real one. */
    const withRealHash = async (): Promise<UserEntity> => {
      const user = await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId });
      user.passwordHash = await bcrypt.hash(current, 4);
      user.tokenVersion = 3;
      return dataSource.manager.save(user);
    };

    it('refuses a wrong current password, changing nothing', async () => {
      const before = await withRealHash();
      await expect(account.changePassword(ownerId, 'not-it', replacement)).rejects.toThrow(
        BadRequestException,
      );
      const after = await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.tokenVersion).toBe(before.tokenVersion);
    });

    it('refuses a new password equal to the current one', async () => {
      await withRealHash();
      await expect(account.changePassword(ownerId, current, current)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('stores the new hash and revokes every token issued so far', async () => {
      const before = await withRealHash();
      await expect(account.changePassword(ownerId, current, replacement)).resolves.toEqual({
        changed: true,
      });

      const after = await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId });
      expect(await bcrypt.compare(replacement, after.passwordHash)).toBe(true);
      expect(await bcrypt.compare(current, after.passwordHash)).toBe(false);
      // The guard admits a token only while its `ver` equals this column, so
      // the increment is the revocation.
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    });

    it('refuses an id with no account behind it', async () => {
      await expect(account.changePassword(missingId, current, replacement)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('writes an audit row, with the account at both ends and no password in it', async () => {
      // A password change is the first write a stolen session makes, so it
      // leaves an audit row; without one, an account taken over looks exactly
      // like one whose owner chose a new password.
      await withRealHash();
      await account.changePassword(ownerId, current, replacement);

      const rows = await dataSource.manager.find(AuditEventEntity, {
        where: { event: 'password.change' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: ownerId,
        subjectUserId: ownerId,
        action: 'password changed',
        detail: { sessionsRevoked: true },
      });
      // What an appeal asks is that it happened, to whom and when; never what
      // the password was.
      expect(JSON.stringify(rows[0])).not.toContain(replacement);
    });

    it('writes no audit row for a change it refused', async () => {
      await withRealHash();
      await expect(account.changePassword(ownerId, 'not-it', replacement)).rejects.toThrow(
        BadRequestException,
      );
      expect(
        await dataSource.manager.count(AuditEventEntity, { where: { event: 'password.change' } }),
      ).toBe(0);
    });

    it('does not undo a suspension made while the new hash was being computed', async () => {
      const before = await withRealHash();

      // An operator suspends the same account in the window between the read
      // and the write. Saving the row read before it would put
      // `disabledAt: null` back and quietly restore an account somebody has
      // just been suspended from.
      let suspendedAt: string | null = null;
      duringTheNextUserRead(dataSource, async () => {
        suspendedAt = (await admin.update(bystanderId, ownerId, { disabled: true })).disabledAt;
      });

      await expect(account.changePassword(ownerId, current, replacement)).resolves.toEqual({
        changed: true,
      });

      const after = await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId });
      expect(suspendedAt).toEqual(expect.any(String));
      expect(after.disabledAt).toBe(suspendedAt);
      // Two revocations happened, so the version advanced twice.
      expect(after.tokenVersion).toBe(before.tokenVersion + 2);
      expect(await bcrypt.compare(replacement, after.passwordHash)).toBe(true);
    });

    it('advances the version once per racing revocation, and refuses a token minted between them', async () => {
      const before = await withRealHash();

      // The operator's reset runs entirely inside the window the learner's own
      // change opened: the learner has read version 3 and has not written yet,
      // so adding one in JavaScript makes both of them write 4.
      duringTheNextUserRead(dataSource, () =>
        admin.setPassword(bystanderId, ownerId, 'Operator-Chosen-7'),
      );

      await expect(account.changePassword(ownerId, current, replacement)).resolves.toEqual({
        changed: true,
      });

      const after = await dataSource.manager.findOneByOrFail(UserEntity, { id: ownerId });
      expect(after.tokenVersion).toBe(before.tokenVersion + 2);

      // The version a session minted between the two writes would carry. The
      // guard admits a token only while its `ver` equals the row, so this is
      // exactly the session that two revocations collapsing into one would
      // have left alive for the rest of its week.
      const intermediate = await auth.issueSession({
        ...before,
        tokenVersion: before.tokenVersion + 1,
      });
      await expect(auth.authenticate(intermediate.token)).rejects.toThrow(UnauthorizedException);

      // The learner wrote last, so their password is the one that stands, and
      // the one they replaced opens nothing.
      expect(await bcrypt.compare(replacement, after.passwordHash)).toBe(true);
      expect(await bcrypt.compare(current, after.passwordHash)).toBe(false);
    });
  });

  describe('deleteAccount', () => {
    it('retains only private runner cleanup ownership after erasure and never exports capability hashes', async () => {
      const session = await dataSource.getRepository(PreviewSessionEntity).save({
        id: 'd'.repeat(24), userId: ownerId, phaseStateId: 'owned-phase', tokenVersion: 0,
        runnerId: 'private-runner', capabilityHash: 'e'.repeat(64), status: 'ready', cleanupPending: false,
        state: { bundleOk: true, message: null, stopReason: null, startedAt: 1, readyAt: 2, expiresAt: 600001, lastSeenAt: 2, bytesServed: 0, forgetAt: null, buildMs: 1, launchDeadline: 600001 },
      });
      const exported = JSON.stringify(await account.exportData(ownerId));
      expect(exported).not.toContain(session.capabilityHash);
      expect(exported).not.toContain(session.runnerId);
      await account.deleteAccount(ownerId, ownerEmail);
      expect(await dataSource.getRepository(UserEntity).findOneBy({ id: ownerId })).toBeNull();
      expect(await dataSource.getRepository(PreviewSessionEntity).findOneBy({ id: session.id })).toEqual(session);
      expect(await rowCounts(ownerId)).toEqual(countsOf(0));
    });

    it('empties every table the constant names, and nobody else’s', async () => {
      // The opening assertion is load-bearing twice over: it proves the fixture
      // seeded every listed table, so the emptiness below means something.
      expect(await rowCounts(ownerId)).toEqual(countsOf(1));

      await expect(account.deleteAccount(ownerId, ownerEmail)).resolves.toEqual({ deleted: true });

      expect(await rowCounts(ownerId)).toEqual(countsOf(0));
      expect(await dataSource.manager.count(UserEntity, { where: { id: ownerId } })).toBe(0);
      expect(await rowCounts(bystanderId)).toEqual(countsOf(1));
      expect(await dataSource.manager.count(UserEntity, { where: { id: bystanderId } })).toBe(1);
    });

    it('takes a quiz paper away before the submission it hangs off', async () => {
      // Quiz papers. The constant's order is asserted above; this is the same
      // rule read off the statements the deletion actually sends, so a future
      // deletion that stops walking the list backwards fails here too.
      const queries = await recordQueries(() =>
        account.deleteAccount(ownerId, ownerEmail),
      );
      const deletion = (table: string): number =>
        queries.findIndex(
          (query) => query.startsWith('DELETE FROM') && query.includes(`"${table}"`),
        );
      expect(deletion('quiz_attempts')).toBeGreaterThanOrEqual(0);
      expect(deletion('submissions')).toBeGreaterThanOrEqual(0);
      expect(deletion('quiz_attempts')).toBeLessThan(deletion('submissions'));
      expect(
        await dataSource.manager.count(QuizAttemptEntity, { where: { userId: ownerId } }),
      ).toBe(0);
      // And the bystander still has theirs, papers included.
      expect(await rowCounts(bystanderId)).toEqual(countsOf(1));
    });

    it('accepts the address however it was typed', async () => {
      await expect(
        account.deleteAccount(ownerId, `  ${ownerEmail.toUpperCase()} `),
      ).resolves.toEqual({ deleted: true });
      expect(await dataSource.manager.count(UserEntity, { where: { id: ownerId } })).toBe(0);
    });

    it.each([
      ['another account', bystanderEmail],
      ['a near miss', ownerEmail.replace('@', '+1@')],
      ['nothing at all', ''],
    ])('refuses a confirmation naming %s, and deletes nothing', async (_case, confirmation) => {
      await expect(account.deleteAccount(ownerId, confirmation)).rejects.toThrow(
        BadRequestException,
      );
      expect(await rowCounts(ownerId)).toEqual(countsOf(1));
      expect(await dataSource.manager.count(UserEntity, { where: { id: ownerId } })).toBe(1);
    });

    it('keeps the event and nulls the subject when the account is deleted', async () => {
      // Audit rows where the account was the subject are kept, not deleted.
      // Deleting them would take the record of an instructor's override away
      // with the learner it was written about, and the record of the deletion
      // itself, so the one question an appeal asks weeks later (who did
      // this, and why) would have no answer at all.
      await seedAudit(bystanderId, ownerId, ownerEmail);
      await seedAudit(ownerId, bystanderId, bystanderEmail);

      await expect(account.deleteAccount(ownerId, ownerEmail)).resolves.toEqual({ deleted: true });

      const left = await dataSource.manager.find(AuditEventEntity, {});
      // The override written about the deleted account, the one it wrote about
      // the bystander, and the row recording the deletion.
      expect(left).toHaveLength(3);

      const tombstone = left.find((row) => row.actorUserId === bystanderId);
      expect(tombstone).toBeDefined();
      // The event, the actor and the reason survive. The person does not.
      expect(tombstone!.subjectUserId).toBeNull();
      expect(tombstone!.event).toBe('phase.override');
      expect(tombstone!.reason).toContain('discussed in class');

      // What this account wrote about somebody else is the bystander's record,
      // not this one's, and is untouched.
      const aboutTheBystander = left.find((row) => row.subjectUserId === bystanderId);
      expect(aboutTheBystander).toMatchObject({ actorUserId: ownerId, event: 'phase.override' });
    });

    it('records the deletion itself, as a row that names nobody', async () => {
      await expect(account.deleteAccount(ownerId, ownerEmail)).resolves.toEqual({ deleted: true });

      const rows = await dataSource.manager.find(AuditEventEntity, {
        where: { event: 'account.delete' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].subjectUserId).toBeNull();
      expect(rows[0].action).toBe('account deleted');
      // The id survives in the actor column and no longer resolves to a person,
      // which is what the console shows: an event, a date, and no name.
      expect(rows[0].actorUserId).toBe(ownerId);
      const [view] = await auditViews(dataSource.manager, rows);
      expect(view).toMatchObject({ subjectUserId: null, subjectName: null, actorName: null });
      expect(JSON.stringify(view)).not.toContain(ownerEmail);
    });

    it('refuses an id with no account behind it', async () => {
      await expect(account.deleteAccount(missingId, ownerEmail)).rejects.toThrow(NotFoundException);
    });

    describe('a class the account owns', () => {
      it('refuses the deletion, naming the class and its size', async () => {
        // Cohorts are keyed by ownerUserId and nothing cascades, so deleting
        // the owner would leave a class nobody could see with a join code that
        // still worked, and learners would keep walking into it. The deletion
        // refuses instead.
        await seedCohort(ownerId, 'Tuesday class', 12);

        await expect(account.deleteAccount(ownerId, ownerEmail)).rejects.toThrow(
          /Tuesday class, which has 12 learners in it/,
        );
        // Nothing was taken on the way to the refusal.
        expect(await dataSource.manager.count(UserEntity, { where: { id: ownerId } })).toBe(1);
        expect(await rowCounts(ownerId)).toEqual(countsOf(1));
        expect(await dataSource.manager.count(CohortEntity, {})).toBe(1);
      });

      it('names every class that still has people in it', async () => {
        await seedCohort(ownerId, 'Tuesday class', 1);
        await seedCohort(ownerId, 'Thursday class', 3);

        await expect(account.deleteAccount(ownerId, ownerEmail)).rejects.toThrow(
          /Tuesday class, which has 1 learner in it; Thursday class, which has 3 learners in it/,
        );
      });

      it('closes an empty class with the account, so no join code is left live', async () => {
        // The other half of the same rule. An empty class kept after its owner goes is
        // still a live join code pointing at a room no instructor is in.
        await seedCohort(ownerId, 'Cancelled class', 0);

        await expect(account.deleteAccount(ownerId, ownerEmail)).resolves.toEqual({
          deleted: true,
        });
        expect(await dataSource.manager.count(CohortEntity, {})).toBe(0);
        const [row] = await dataSource.manager.find(AuditEventEntity, {
          where: { event: 'account.delete' },
        });
        expect(row.detail).toEqual({ cohortsClosed: ['Cancelled class'] });
      });

      it('leaves somebody else’s class alone', async () => {
        await seedCohort(bystanderId, 'Tuesday class', 5);
        await expect(account.deleteAccount(ownerId, ownerEmail)).resolves.toEqual({
          deleted: true,
        });
        expect(await dataSource.manager.count(CohortEntity, {})).toBe(1);
      });
    });

    /**
     * The other half of erasure: the people the content names.
     *
     * `deleteAccount` is available to any account, instructors included. If it
     * refused only for owning a populated class, a teacher who authored a
     * project a class is working could delete their account and leave that
     * project's provenance dangling, and with `ownerUserId` documented as
     * "NULL = platform-owned", one step from reading as platform content.
     */
    describe('a project the account authored', () => {
      it('refuses the deletion while an enrolment pins a published version, naming it and its size', async () => {
        const { version } = await seedProject(ownerId, 'ops-for-analysts', 'Ops for Analysts');
        await pinLearners(version.id, 'ops-for-analysts', [
          ['first', 'Monday class'],
          ['second', 'Monday class'],
          ['third', 'Thursday class'],
        ]);

        // A version an enrolment pins cannot be withdrawn, so
        // this is the same invariant read from the other end.
        await expect(account.deleteAccount(ownerId, ownerEmail)).rejects.toThrow(
          /this account still owns Ops for Analysts 1\.2\.0, which 3 learners in 2 classes are enrolled on/,
        );
        await expect(account.deleteAccount(ownerId, ownerEmail)).rejects.toThrow(
          /ask an admin to transfer the project to somebody else first/,
        );

        // Nothing was taken on the way to the refusal.
        expect(await dataSource.manager.count(UserEntity, { where: { id: ownerId } })).toBe(1);
        expect(await rowCounts(ownerId)).toEqual(countsOf(1));
        expect(await dataSource.manager.count(ProjectEntity, {})).toBe(1);
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectVersionEntity, { id: version.id })).status,
        ).toBe('published');
      });

      it('refuses it while an enrolment resolves the project at all, pinned or not', async () => {
        const { version } = await seedProject(ownerId, 'ops-for-analysts', 'Ops for Analysts');
        await enrolUnpinned('ops-for-analysts', [
          ['unpinned-first', 'Monday class'],
          ['unpinned-second', 'Thursday class'],
        ]);

        // The guard read `enrollments.projectVersionId` and nothing else, and
        // nothing on the ordinary path writes that column, so it answered
        // "nothing is pinned" for a class working the project right now, and
        // the archive pass below it ran unconditionally: every version of the
        // departing owner's projects set to `archived`, and a learner resolving
        // "the newest published version" of which there is then none.
        await expect(account.deleteAccount(ownerId, ownerEmail)).rejects.toThrow(
          /this account still owns Ops for Analysts 1\.2\.0, which 2 learners in 2 classes are enrolled on/,
        );

        // Nothing was taken on the way to the refusal.
        expect(await dataSource.manager.count(UserEntity, { where: { id: ownerId } })).toBe(1);
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectVersionEntity, { id: version.id })).status,
        ).toBe('published');
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectEntity, { id: version.projectId }))
            .ownerUserId,
        ).toBe(ownerId);
      });

      it('counts a pinned and an unpinned enrolment under one version each', async () => {
        const { version } = await seedProject(ownerId, 'ops-for-analysts', 'Ops for Analysts');
        await pinLearners(version.id, 'ops-for-analysts', [['pinned-one', 'Monday class']]);
        await enrolUnpinned('ops-for-analysts', [['unpinned-one', 'Monday class']]);

        // One version, so the head and the pin are the same row and the
        // sentence names it once with both learners in it.
        await expect(account.deleteAccount(ownerId, ownerEmail)).rejects.toThrow(
          /still owns Ops for Analysts 1\.2\.0, which 2 learners in 1 class are enrolled on\. A version/,
        );
      });

      it('archives a project nothing pins, and never nulls an actor column', async () => {
        const mine = await seedProject(ownerId, 'ops-for-analysts', 'Ops for Analysts');
        // Somebody else's project, published by this account: a version's
        // provenance is the project's record, not the publisher's.
        const theirs = await seedProject(bystanderId, 'ledger', 'Ledger', ownerId);
        const blobs = await dataSource.manager.count(ContentBlobEntity, {});
        expect(blobs).toBe(2);

        await expect(account.deleteAccount(ownerId, ownerEmail)).resolves.toEqual({ deleted: true });

        // The actor column survives. The phase gate reads whether a sign-off is
        // set, so nulling an actor would reclose a phase a teacher had opened,
        // for every learner they had ever signed off, on the day they left.
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectVersionEntity, { id: theirs.version.id }))
            .publishedByUserId,
        ).toBe(ownerId);
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectVersionEntity, { id: mine.version.id }))
            .publishedByUserId,
        ).toBe(ownerId);

        // Archived, not deleted: the blobs are shared, so deleting the rows
        // would save nothing and lose a fork's lineage.
        const project = await dataSource.manager.findOneByOrFail(ProjectEntity, {
          id: mine.project.id,
        });
        expect({ ownerUserId: project.ownerUserId, platformOwned: project.platformOwned }).toEqual({
          ownerUserId: null,
          platformOwned: false,
        });
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectVersionEntity, { id: mine.version.id }))
            .status,
        ).toBe('archived');
        // and somebody else's project is untouched
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectEntity, { id: theirs.project.id }))
            .ownerUserId,
        ).toBe(bystanderId);
        expect(
          (await dataSource.manager.findOneByOrFail(ProjectVersionEntity, { id: theirs.version.id }))
            .status,
        ).toBe('published');
        expect(await dataSource.manager.count(ContentBlobEntity, {})).toBe(blobs);
        expect(await dataSource.manager.count(ProjectFileEntity, {})).toBe(2);
      });
    });
  });
});

/* ------------------------------------------------------------------------- *
 * What a teacher who made a copy their own takes with
 * them. The interview only where it is theirs, a file only where its bytes
 * are not the source's, and never the reference's sealed answers.
 * ------------------------------------------------------------------------- */
describe("the export of a copy the teacher made their own", () => {
  // Imported here rather than at the head of the file, beside the tests that use it.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fork = require('../../test/tasktrackr-phase') as typeof import('../../test/tasktrackr-phase');
  const roomdesk = require('../../test/reference-scenario-roomdesk') as typeof import('../../test/reference-scenario-roomdesk');
  const entities = require('../db/entities') as typeof import('../db/entities');
  /* eslint-enable @typescript-eslint/no-require-imports */
  /** A starting record of Design's the teacher replaced (TaskTrackr 4.0.0's Design mounts its records, no backlog document). */
  const API = 'shared/contract/api.json';
  const OWN_API = '{\n  "operations": [],\n  "errors": {}\n}\n';

  let world: Awaited<ReturnType<typeof fork.openForkWorld>>;
  let exporter: AccountService;

  beforeAll(async () => {
    world = await fork.openForkWorld();
    exporter = new AccountService(passwordWorkFixture(), world.dataSource);
    await world.dataSource.manager.save(
      world.dataSource.manager.create(entities.UserEntity, {
        id: fork.S1_TEACHER.id,
        email: 'teacher-s1@bx-export.test',
        passwordHash: 'x',
        displayName: 'A teacher',
        role: 'INSTRUCTOR',
      } as never),
    );
  });
  afterAll(async () => {
    await world.close();
  });

  type Exported = { slug: string; versions: { phases: { key: string; interview?: unknown; files?: { path: string; content: string }[] }[] }[] }[];
  const exportedCopy = async (slug: string) =>
    ((await exporter.exportData(fork.S1_TEACHER.id)).authoredProjects as Exported).find((one) => one.slug === slug)!;
  const referenceAnswers = () => fork.tasktrackrPhase('requirements').interview!.facts.map((fact) => fact.answer);

  it('exports neither the interview nor a file of an untouched copy', async () => {
    await fork.copyTaskTrackr(world, 'bx-export-untouched');
    const copy = await exportedCopy('bx-export-untouched');
    for (const phase of copy.versions[0].phases) {
      expect([phase.key, phase.interview]).toEqual([phase.key, undefined]);
      expect([phase.key, phase.files ?? []]).toEqual([phase.key, []]);
    }
    const wire = JSON.stringify(copy);
    for (const answer of referenceAnswers()) expect(wire).not.toContain(answer);
  });

  it('exports the interview and the design record the teacher wrote, and no reference answer', async () => {
    const made = await fork.copyTaskTrackr(world, 'bx-export-own');
    await world.service.putInterview(fork.S1_TEACHER, made.projectId, made.versionId, roomdesk.ROOMDESK_INTERVIEW);
    await world.service.replaceFile(fork.S1_TEACHER, made.projectId, made.versionId, 'design', { path: API, content: OWN_API });
    const copy = await exportedCopy('bx-export-own');
    const phases = copy.versions[0].phases;
    const requirements = phases.find((one) => one.key === 'requirements')!;
    expect(requirements.interview).toEqual(roomdesk.ROOMDESK_INTERVIEW);
    expect(requirements.files ?? []).toEqual([]);
    expect(phases.find((one) => one.key === 'design')!.files).toEqual([{ path: API, content: OWN_API }]);
    for (const phase of phases.filter((one) => one.key !== 'requirements')) expect(phase.interview).toBeUndefined();
    const wire = JSON.stringify(copy);
    for (const answer of referenceAnswers()) expect(wire).not.toContain(answer);
  });
});
