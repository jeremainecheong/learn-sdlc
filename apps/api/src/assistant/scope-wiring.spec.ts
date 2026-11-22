import 'reflect-metadata';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { soleTaskFor } from '../content/pack-compiler';
import type { ContentService } from '../content/content.service';
import {
  AiCacheEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { NotesService } from '../instructor/notes.service';
import { AssistantService, LESSON_SENTENCE } from './assistant.service';
import { LocalMentorProvider } from './local.provider';
import type { OpenAiProvider } from './openai.provider';
import { REFERENCE_SCOPE } from './project-scope';
import type { MentorContext, ReviewInput } from './provider.types';
import { fixedState, graderFor } from '../../test/verdict-golden';
import {
  ROOM_DESIGN_EDIT,
  S1_TEACHER,
  copyTaskTrackr,
  openForkWorld,
  tasktrackrContent,
  type ForkWorld,
} from '../../test/tasktrackr-phase';

/**
 * The scope reaches the provider through the production call paths (the
 * wiring half of reviewer scoping).
 *
 * A composer that scopes correctly proves nothing if the service in front of
 * it hands over a scope computed from the wrong phase, or none at all. Three
 * call sites decide it:
 * - `AssistantService.chat` resolves the scope from the phase **before** the
 *   lesson wrap (which empties `files` and extends the prompt, and would
 *   otherwise make every TaskTrackr lesson turn look like a teacher's) and
 *   from the pinned version's task list;
 * - `FeedbackService.buildReport` hands the reviewer the phase's task list;
 * - the Agentic service (in `authored-agentic.spec.ts`) reads the same list.
 */
describe('the scope, as the services hand it to the provider', () => {
  let world: ForkWorld;
  let forkSlug = '';
  let forkVersionId = '';
  const seen: MentorContext[] = [];
  let service: AssistantService;

  beforeAll(async () => {
    world = await openForkWorld();
    const provider = {
      available: true,
      name: 'openai',
      chat: jest.fn(async (ctx: MentorContext) => {
        seen.push(ctx);
        return { content: 'Which one case would you check first?', tokensIn: 1, tokensOut: 1, provider: 'openai' };
      }),
    };
    const db = world.dataSource;
    service = new AssistantService(
      db.getRepository(AssistantMessageEntity),
      db.getRepository(AiCacheEntity),
      db.getRepository(UserEntity),
      db.getRepository(PhaseStateEntity),
      db.getRepository(EnrollmentEntity),
      db.getRepository(SubmissionEntity),
      world.content,
      new LocalMentorProvider(),
      provider as unknown as OpenAiProvider,
      new NotesService(db),
    );
  });
  afterAll(async () => {
    await world?.close();
  });

  let learners = 0;
  const enrol = async (projectSlug: string, projectVersionId: string | null): Promise<{ userId: string; requirements: string; design: string }> => {
    learners += 1;
    const manager = world.dataSource.manager;
    const user = await manager.save(manager.create(UserEntity, { email: `wiring-${learners}@s1.test`, passwordHash: 'unused', displayName: `Wiring ${learners}` }));
    const enrollment = await manager.save(manager.create(EnrollmentEntity, { userId: user.id, projectSlug, projectVersionId, currentPhaseOrder: 1 }));
    const phases = world.content.getForEnrollment({ projectSlug, projectVersionId }).phases;
    let requirements = '';
    let design = '';
    for (const phase of phases) {
      const row = await manager.save(manager.create(PhaseStateEntity, {
        enrollmentId: enrollment.id, userId: user.id, phaseKey: phase.key, phaseOrder: phase.order, status: 'in_progress',
      }));
      if (phase.key === 'requirements') requirements = row.id;
      if (phase.key === 'design') design = row.id;
    }
    return { userId: user.id, requirements, design };
  };

  it("hands a TaskTrackr turn and a TaskTrackr lesson turn the reference scope, resolved before the lesson wrap", async () => {
    const learner = await enrol('tasktrackr', world.seedVersionId);
    seen.length = 0;
    await service.chat(learner.userId, learner.requirements, 'Where should I start with this story?');
    await service.chat(learner.userId, learner.requirements, 'Can you teach me what makes a criterion testable?', { lesson: true });
    expect(seen).toHaveLength(2);
    expect(seen[0].scope).toBe(REFERENCE_SCOPE);
    expect(seen[1].scope).toBe(REFERENCE_SCOPE);
    // the wrap is still applied to the phase the reference branch composes from
    expect(seen[1].phase.files).toEqual([]);
    expect(seen[1].phase.assistant.systemPrompt.endsWith(`\n${LESSON_SENTENCE}`)).toBe(true);
  });

  it('hands the reviewer the pinned task list beside the task', async () => {
    const content: ContentService = tasktrackrContent();
    const phase = content.getProject('tasktrackr').phases.find((one) => one.key === 'requirements')!;
    const { service: grader } = graderFor(content);
    const calls: ReviewInput[] = [];
    (grader as unknown as { assistant: unknown }).assistant = {
      reviewSubmission: async (_phase: unknown, _state: unknown, input: ReviewInput) => {
        calls.push(input);
        return { provider: 'stub', verdict: 'needs_revision', summary: 's', strengths: [], improvements: [], processNote: 'p',
          criteriaEvidence: input.task!.rubric.criteria.map((one) => ({ key: one.key, met: false, evidence: 'e', issue: 'i', nextStep: 'n' })) };
      },
    };
    const tasks = [soleTaskFor(phase)];
    await grader.buildReport(phase, fixedState(phase, phase.order) as never, tasks, tasks[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe(tasks[0]);
    expect(calls[0].phaseTasks).toBe(tasks);
  });

  /*
   * A teacher's own Design task, on TaskTrackr's Design. Not on the
   * written-phase host: the learner's questions below are about design, which
   * the Deployment phase's off-phase guardrail answers without the provider.
   * Since 4.0.0 a Design phase holds one design task, so the teacher's phase
   * is that task made the teacher's in place (`ROOM_DESIGN_EDIT`).
   */
  describe("on TaskTrackr's Design", () => {
    beforeAll(async () => {
      const fork = await copyTaskTrackr(world, 's1-wiring');
      await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, ROOM_DESIGN_EDIT as never);
      const published = await world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' });
      forkSlug = 's1-wiring';
      forkVersionId = published.versionId;
    });

    it("hands a teacher's design phase the authored scope, holding the version's own task", async () => {
      const learner = await enrol(forkSlug, forkVersionId);
      seen.length = 0;
      await service.chat(learner.userId, learner.design, 'Where should I start with the booking record?');
      await service.chat(learner.userId, learner.design, 'Can you teach me what makes a design decision defensible?', { lesson: true });
      expect(seen).toHaveLength(2);
      for (const [at, ctx] of seen.entries()) {
        const scope = ctx.scope!;
        expect(scope.kind).toBe('authored');
        if (scope.kind !== 'authored' || !('tasks' in scope)) throw new Error('an authored phase scope');
        expect(scope.tasks.map((task) => task.taskKey)).toEqual([INHERITED_TASK_KEY]);
        expect(scope.tasks[0].brief).toBe(ROOM_DESIGN_EDIT.brief);
        expect(scope.lesson).toBe(at === 1);
      }
    });

    it("counts a teacher's learner's earlier questions on the authored ladder", async () => {
      const learner = await enrol(forkSlug, forkVersionId);
      const local = (service as unknown as { localProvider: LocalMentorProvider }).localProvider;
      const matchTopic = jest.spyOn(local, 'matchTopic');
      try {
        await service.chat(learner.userId, learner.design, 'Where should I start with the booking record?');
        await service.chat(learner.userId, learner.design, 'What makes a design decision defensible?');
        // the counter's calls: one per earlier question, each asked with no count of its own
        const counted = matchTopic.mock.calls.map(([input]) => input).filter((input) => input.interactionCount === 0 && Object.keys(input.topicUseCounts).length === 0);
        expect(counted.length).toBeGreaterThan(0);
        for (const input of counted) expect(input.scope?.kind).toBe('authored');
      } finally {
        matchTopic.mockRestore();
      }
    });
  });
});
