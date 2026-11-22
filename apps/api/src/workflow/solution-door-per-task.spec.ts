import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { SOLUTION_LOCKED_MESSAGE } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { soleTaskFor } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { referenceFiles } from './solution.reference';
import { strictlyReviewed } from '../../test/strict-evidence-fixture';
import { SolutionService } from './solution.service';
import { WorkflowService } from './workflow.service';

/**
 * The answer-key door is **task-scoped**.
 *
 * On the shipped project it answers exactly what a phase-scoped door would:
 * the whole phase's `pairs(checks.editableTargets, checks.solutionFiles)`,
 * gated on the phase, and this spec pins that:
 *
 * - `referenceFiles` takes the task as well as the phase and reads
 *   `checksOf(phase, task)`, so its arity is 2.
 * - `SolutionService.read` reads **the task's** gate, and the stamp, the three
 *   numbers and the audit row are that task's too.
 *
 * On TaskTrackr `soleTaskList` is true for every phase, so `checksOf` answers
 * `phase.checks` and the gate is the three columns of `phase_states`. Four
 * editable targets, four answers, one refusal sentence: the numbers are the
 * proof that the shipped project's door is the phase's.
 */
describe('the answer key: one door per task', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: SolutionService;
  let learnerId = '';
  let states: PhaseStateEntity[] = [];

  const manager = () => dataSource.manager;
  const phase = (key: string): PhaseStateEntity => states.find((s) => s.phaseKey === key)!;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    const feedback = { latestFor: async () => null } as unknown as FeedbackService;
    const workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      feedback,
      dataSource,
    );
    service = new SolutionService(
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(SubmissionEntity),
      workflow,
      content,
      dataSource,
    );
    const learner = await manager().save(
      manager().create(UserEntity, {
        email: 'door@class.edu',
        passwordHash: 'x',
        displayName: 'door',
      }),
    );
    learnerId = learner.id;
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: learnerId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
        packVersion: content.getProject('tasktrackr').version,
      }),
    );
    states = [];
    for (const p of content.getProject('tasktrackr').phases) {
      states.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId: learnerId,
            phaseKey: p.key,
            phaseOrder: p.order,
            status: 'in_progress',
            attempts: 0,
            unlockedAt: new Date().toISOString(),
          }),
        ),
      );
    }
  });

  it("the answer key opens on the task's own gate, which for a sole task is the phase's", async () => {
    const implementation = content.getPhase('tasktrackr', 'implementation');
    if (implementation.checks.kind !== 'code') throw new Error('implementation is a code phase');
    const targets = implementation.checks.editableTargets;
    // The shipped pack's own numbers, so a content change that makes the hole
    // wider or narrower is visible here: four editable targets, four answers.
    expect(targets).toHaveLength(4);
    expect(Object.keys(implementation.checks.solutionFiles).sort()).toEqual(
      targets.slice().sort(),
    );

    // closed, in the words the browser reads
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      SOLUTION_LOCKED_MESSAGE,
    );

    // A sole task has no `task_states` row of its own, so the phase's two
    // gate columns are the task's. They are not the whole key: the board
    // reading passed is what a teacher's Pass writes with no
    // revision behind it, and the door stays shut until the strict gate's own
    // evidence is in, the reviewed pass `advance` requires. No per-file
    // condition of any kind.
    await manager().update(PhaseStateEntity, phase('implementation').id, {
      status: 'passed',
      passedAt: new Date().toISOString(),
      bestScore: 84,
    });
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      SOLUTION_LOCKED_MESSAGE,
    );
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: phase('implementation').id,
        userId: learnerId,
        status: 'completed',
        passed: true,
        score: 84,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(soleTaskFor(implementation).rubric),
      }),
    );

    const view = await service.read(learnerId, phase('implementation').id);
    expect(view.available).toBe(true);
    expect(view.files.map((f) => f.path)).toEqual(targets);
    expect(view.files).toHaveLength(4);
    for (const file of view.files) {
      expect(file.theirs).toBe(implementation.checks.solutionFiles[file.path]);
    }
  });

  it('the door asks which task the answer belongs to, and a sole task answers the phase', () => {
    const implementation = content.getPhase('tasktrackr', 'implementation');
    if (implementation.checks.kind !== 'code') throw new Error('implementation is a code phase');
    // `referenceFiles` takes the phase and the task and reads
    // `checksOf(phase, task)`. The sole task carries no slice of its own, so
    // `checksOf` answers `phase.checks` and the files are the phase's whole
    // answer.
    const sole = soleTaskFor(implementation);
    expect(referenceFiles(implementation, sole).files.map(([at]) => at)).toEqual(
      implementation.checks.editableTargets,
    );
    // Two parameters: the phase and the task.
    expect(referenceFiles.length).toBe(2);
  });
});
