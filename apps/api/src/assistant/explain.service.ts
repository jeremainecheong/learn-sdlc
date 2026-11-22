import { Injectable, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { ExplainSubjectView, ExplainTestResponse, TestCaseResult } from '@learnsdlc/shared';
import { explainQuestionFor } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { PhaseContent } from '../content/content.types';
import { ExecutionRunEntity, PhaseStateEntity, SubmissionEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { WorkflowService } from '../workflow/workflow.service';
import { AssistantService } from './assistant.service';
import { ExplainTestDto } from './mentor.dto';
import { FailingTestContext } from './provider.types';

/** The same cap as `derive.ts`'s: the first line carries the point. */
const MAX_ASSERTION_CHARS = 160;
/** Twelve lines either side of the frame is the method, not the file. */
const EXCERPT_RADIUS = 12;
/** The same cap the prompt applies, so the service never hands over more. */
const MAX_EXCERPT_CHARS = 2000;

/**
 * The first line of a message, capped, the same string `derive.ts` shows the
 * learner in the run panel, written out here rather than imported because the
 * browser's copy lives in the web app. If one changes, change both.
 */
export function firstLine(message: string | undefined): string {
  const first = (message ?? '').trim().split('\n')[0] ?? '';
  return first.length > MAX_ASSERTION_CHARS
    ? `${first.slice(0, MAX_ASSERTION_CHARS - 1)}…`
    : first;
}

/**
 * "Explain this failing test".
 *
 * Built the way `InterviewService` is: it owns this room's rules, which result
 * the button was drawn from, which case it named, and what the mentor is
 * allowed to see about it, and delegates every shared rule to
 * `AssistantService.chat`. The budget cap, the cache,
 * the output guardrails, the transcript pair and the daily meter are all the
 * chat path's, unchanged, because an explanation *is* a mentor turn: the
 * product typed the question on the learner's behalf, and it is counted,
 * metered and remembered like any other hint.
 */
@Injectable()
export class ExplainService {
  constructor(
    @InjectRepository(SubmissionEntity) private readonly submissions: Repository<SubmissionEntity>,
    @InjectRepository(ExecutionRunEntity) private readonly runs: Repository<ExecutionRunEntity>,
    private readonly workflow: WorkflowService,
    private readonly content: ContentService,
    private readonly assistant: AssistantService,
  ) {}

  async explainFailingTest(
    userId: string,
    phaseStateId: string,
    dto: ExplainTestDto,
  ): Promise<ExplainTestResponse> {
    // The one ownership, lock and schedule check the product has. A phase that
    // is not this learner's, or is not open yet, is refused here and the
    // control is never drawn on one anyway.
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);

    const cases = await this.casesFor(state, dto);
    // A test name is unique inside one half of a multi-run result, not across
    // both: the button sends the step it drew, and a result with no
    // steps sends none.
    const failing = cases.find(
      (c) =>
        c.name === dto.testName &&
        c.status !== 'passed' &&
        (dto.step === undefined || c.step === dto.step),
    );
    if (!failing) {
      // The result the button was drawn from is gone, or a newer run replaced
      // it, or the case passed this time. All three are the same answer to the
      // learner: ask about the result that is on the screen now.
      throw new NotFoundException('that test is not in this result any more');
    }

    const failingTest = this.contextFor(phase, state, failing);
    const question = explainQuestionFor(failing.name);
    const chat = await this.assistant.chat(userId, phaseStateId, question, { failingTest });

    const subject: ExplainSubjectView = {
      testName: failing.name,
      hidden: Boolean(failing.hidden),
      assertion: failingTest.assertion,
      where:
        failingTest.path && failingTest.line
          ? `${failingTest.path}, line ${failingTest.line}`
          : null,
      step: failing.step ?? null,
    };
    return { question, reply: chat.reply, usage: chat.usage, subject };
  }

  /**
   * The cases of the result the button was drawn from.
   *
   * `id: 'DESC'` beside `createdAt: 'DESC'` is not decoration: two rows can
   * share a `createdAt` on sqlite, and `feedback.service.ts` breaks the same
   * tie the same way. Without it "the newest submission" is whichever row the
   * driver happened to return first.
   */
  private async casesFor(
    state: PhaseStateEntity,
    dto: ExplainTestDto,
  ): Promise<TestCaseResult[]> {
    if (dto.source === 'submission') {
      const submission = await this.submissions.findOne({
        where: dto.sourceId
          ? { id: dto.sourceId, phaseStateId: state.id }
          : { phaseStateId: state.id, status: 'completed' },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      return submission?.report?.tests?.cases ?? [];
    }
    const run = await this.runs.findOne({
      where: dto.sourceId
        ? { id: dto.sourceId, phaseStateId: state.id }
        : { phaseStateId: state.id, status: 'completed' },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return run?.result?.tests?.cases ?? [];
  }

  /**
   * What the mentor may see about the failure, and nothing else.
   *
   * The excerpt is read through `ContentService.executionFiles`, which maps
   * `phase.files` alone, a hidden test lives in `phase.checks.hiddenTestFiles`
   * and is never in that map, and it is taken only when the frame landed in a
   * file the learner may edit. So the hidden suite's source cannot reach the
   * prompt by this path by construction, not by filtering.
   */
  private contextFor(
    phase: PhaseContent,
    state: PhaseStateEntity,
    failing: TestCaseResult,
  ): FailingTestContext {
    const frame = failing.frames?.[0] ?? null;
    const path = frame?.path ?? null;
    const line = frame?.line ?? null;
    return {
      name: failing.name,
      hidden: Boolean(failing.hidden),
      assertion: firstLine(failing.message),
      path,
      line,
      excerpt: path && line ? this.excerptAround(phase, state, path, line) : '',
    };
  }

  /** The learner's own file around the frame: at most 25 lines and 2000 characters. */
  private excerptAround(
    phase: PhaseContent,
    state: PhaseStateEntity,
    path: string,
    line: number,
  ): string {
    const declared = phase.files.find((f) => f.path === path);
    if (!declared?.editable) return '';
    const source = this.content.executionFiles(phase, state.workspace)[path];
    if (!source) return '';
    const lines = source.split('\n');
    const from = Math.max(0, line - 1 - EXCERPT_RADIUS);
    const to = Math.min(lines.length, line + EXCERPT_RADIUS);
    return lines.slice(from, to).join('\n').slice(0, MAX_EXCERPT_CHARS);
  }
}
