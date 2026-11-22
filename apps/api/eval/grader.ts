import type { FeedbackReport } from '@learnsdlc/shared';
import type { ContentService } from '../src/content/content.service';
import type { PhaseContent } from '../src/content/content.types';
import type { CompiledTask } from '../src/content/pack-compiler';
import { ExecutionService } from '../src/execution/execution.service';
import { FeedbackService } from '../src/feedback/feedback.service';
import type { ReviewInput } from '../src/assistant/provider.types';
import type { SeatbeltSandbox } from './seatbelt-sandbox';

/**
 * The product's real grader, wired as `test/verdict-golden.ts` `graderFor`
 * wires it (the same eleven collaborators, the same borrowed
 * `learnerTestFiles`) with two differences: the sandbox is the Seatbelt
 * sandbox (real runs, not canned), and the reviewer stub records the exact
 * `ReviewInput` `FeedbackService` hands the provider, then answers a full pass
 * so the structural verdict is decided by the checks alone.
 */

function emptyRepo() {
  return {
    find: async () => [],
    findOne: async () => null,
    findOneBy: async () => null,
    findOneByOrFail: async (where: { id?: string }) => ({ id: where?.id ?? 'ps-1' }),
    count: async () => 0,
    save: async (row: unknown) => row,
    update: async () => ({ affected: 0 }),
    create: (fields: unknown) => fields,
  };
}

function graderWith(content: ContentService, slug: string, sandbox: SeatbeltSandbox): { service: FeedbackService; captured: ReviewInput[] } {
  const captured: ReviewInput[] = [];
  const assistant = {
    reviewSubmission: async (phase: PhaseContent, _state: unknown, input: ReviewInput) => {
      captured.push(input);
      const rubric = input.task?.rubric ?? phase.rubric;
      return {
        provider: 'recorded-stub',
        verdict: 'pass' as const,
        summary: 'recorded',
        strengths: [],
        improvements: [],
        processNote: '',
        criteriaEvidence: rubric.criteria.map((criterion) => ({ key: criterion.key, met: true, evidence: 'recorded', issue: '', nextStep: '' })),
      };
    },
  };
  const enrollments = { ...emptyRepo(), findOneByOrFail: async () => ({ id: 'e-1', userId: 'u-1', projectSlug: slug }) };
  const learnerTestFiles = ExecutionService.prototype.learnerTestFiles as unknown as (this: { content: ContentService }, ...args: unknown[]) => Record<string, string>;
  const execution = { learnerTestFiles: learnerTestFiles.bind({ content }) };
  const service = new FeedbackService(
    emptyRepo() as never,
    emptyRepo() as never,
    enrollments as never,
    emptyRepo() as never,
    content,
    sandbox as never,
    execution as never,
    assistant as never,
    { register: () => undefined, enqueue: async () => undefined, durable: false } as never,
    { emitJob: () => undefined } as never,
    { onVerdict: async () => undefined } as never,
  );
  return { service, captured };
}

/** A phase state for one graded workspace: the learner is "the learner" (u-1); nothing identifies anyone. */
export function evalState(phase: PhaseContent, workspace: Record<string, string>, ranBeforeSubmit: boolean): Record<string, unknown> {
  return {
    id: `ps-${phase.key}`,
    enrollmentId: 'e-1',
    userId: 'u-1',
    phaseKey: phase.key,
    phaseOrder: phase.order,
    status: 'in_progress',
    bestScore: null,
    attempts: 1,
    reflection: null,
    workspace,
    acceptedScreenCopy: null,
    links: null,
    drill: null,
    ranBeforeSubmit,
    unlockedAt: null,
    passedAt: null,
    interview: null,
    solutionReadAt: null,
    runClock: null,
  };
}

export async function gradeWorkspace(
  content: ContentService, slug: string, phase: PhaseContent, task: CompiledTask, tasks: CompiledTask[],
  workspace: Record<string, string>, ranBeforeSubmit: boolean, sandbox: SeatbeltSandbox,
): Promise<{ report: FeedbackReport; reviewInput: ReviewInput | null }> {
  const { service, captured } = graderWith(content, slug, sandbox);
  const report = await service.buildReport(phase, evalState(phase, workspace, ranBeforeSubmit) as never, tasks, task);
  return { report, reviewInput: captured[0] ?? null };
}
