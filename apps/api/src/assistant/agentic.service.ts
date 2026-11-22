import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { ExecutionRunEntity, PhaseStateEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import type { PhaseContent } from '../content/content.types';
import { ContentService } from '../content/content.service';
import { hasRecord, recordPathOf } from '../content/checks-validation';
import type { CompiledTask } from '../content/pack-compiler';
import { WorkflowService } from '../workflow/workflow.service';
import { refuseInvalidDesignDocument } from '../workflow/design-record-guard';
import { drillWithIncident } from '../workflow/drill-incident';
import { refuseInvalidRecord } from '../workflow/record-guard';
import { AgentProposalEntity } from './agent-proposal.entity';
import { AgentTurnEntity } from './agent-turn.entity';
import { AssistantService } from './assistant.service';
import { TrackedAiOperation } from './operation-tracker';
import { AiBusyError } from '../execution/run-gate';
import { OpenAiProvider, ProviderUsageError } from './openai.provider';
import { phaseScopeOf, readableTasks, type PhaseScope } from './project-scope';
import { MAX_COMPLETION_TOKENS, type AiCallLabel } from './model-call-timing';
import { parseAssessment, type SemanticAssessment } from './strict-assessment';
import { EXPLANATION_ASSESSMENT_PROMPT, STRUCTURED_EVIDENCE_RULE, STRUCTURED_MIXED_EVIDENCE_RULE, explanationAssessmentFailure, explanationAssessmentResponseSchema, explanationEvidence, hasGroundedUnderstanding, learnerExplanationAssessment, parseModelExplanationAssessment } from './explanation-assessment';
import { EVIDENCE_MAX_RUNS, learnerRecordedEvidence } from './explanation-evidence';
import { explanationReaskFits, explanationReaskNote, readExplanationRefusal } from './explanation-reask';
import { classifyReaskFits, classifyReaskNote, readIntentRefusal, type IntentRefusal } from './classify-reask';
import { config, resolveAgenticEditList, resolveAgenticPayload } from '../config';
import { chatGenerationData, proposeGenerationData, trimSentence } from './agentic-payload';
import { EditExpansionError, agentEditListSchema, checkSummaryPaths, editListRefusalReason, expandEditList, reaskPaths, readProposalSummary, requestNamedPaths, secondAnswerKept, summaryNamedPaths } from './proposal-edits';
import { AI_ROUTE_BUDGET_MS, floorSentence, type FieldChange } from '@learnsdlc/shared';
import { normaliseStoryProposal, storyCarried, validateStoryProposal } from './story-proposal';
import { RefusedProposalException, isRefusedProposalCode, refusedProposalMessage } from './proposal-refusal';
import { designBriefing, normaliseDesignProposal, validateDesignProposal } from './design-proposal';
import { changeTicketData, normaliseRecordProposal, recordBriefing, validateRecordProposal } from './record-proposal';
import { explanationReference, structuredReference } from './structured-evidence';
import { editableFiles, editablePaths } from './workspace-files';
import { readOnlyRefusal, readOnlyTargets } from './read-only-targets';
import { agenticContext, composeAgentChatAssessment, composeAgentChatGeneration, composeAgenticIntentAssessment, composeAgenticProposeGeneration } from './agentic-prompts';
import {
  INCOMPLETE_REASK_FIRST_MAX_MS, INCOMPLETE_REASK_SECOND_MAX_MS, INCOMPLETE_REGENERATION, PLAIN_PATH, REGENERATION_MIN_LEFT_MS, REGENERATION_REPLY_MS, incompleteRegenerationSentence, regenerable, regenerationFits, regenerationSentence, type Regeneration,
} from './agentic-regeneration';

export { readOnlyTargets } from './read-only-targets';
export { composeAgentChatAssessment, composeAgentChatGeneration, composeAgenticIntentAssessment, composeAgenticProposeGeneration } from './agentic-prompts';
export {
  INCOMPLETE_REASK_FIRST_MAX_MS, INCOMPLETE_REASK_SECOND_MAX_MS, REGENERATION_MIN_LEFT_MS, REGENERATION_REPLY_MS,
  incompleteRegenerationSentence, regenerationFits, regenerationSentence,
} from './agentic-regeneration';

export const workspaceHash = (files: Record<string, string>): string => createHash('sha256')
  .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
  .digest('hex');


/**
 * The paths the route left out of a generated answer as unchanged that count as files the
 * answer named and did not change: code and configuration files. A phase's structured
 * document (the story record, a design document, the runbook or change-request record) is
 * returned whole whenever the answer touches it, and under the edit-list contract the record
 * is asked for whole, so one returned as saved is the contract's own shape, not an omission;
 * it is still counted on the log line, and named only when the summary names it.
 */
function omittedPaths(phase: PhaseContent, dropped: readonly string[]): string[] {
  const checks = phase.checks;
  const document = (path: string) => checks?.kind === 'design' || (checks?.kind === 'story' && path === checks.record) || path === recordPathOf(checks);
  return dropped.filter(path => !document(path));
}

/** The record a story proposal is checked against: the saved one, or the pack's scaffold. */
function storyBase(phase: PhaseContent, workspace: Record<string, string>): string | undefined {
  return phase.checks?.kind === 'story' ? workspace[phase.checks.record] : undefined;
}

/** A design phase's generation payload carries the teacher's stories, as data; any other phase's payload carries none. */
function designStories(phase: PhaseContent): { designStories?: unknown } {
  return phase.checks?.kind === 'design' ? { designStories: phase.checks.stories } : {};
}

/**
 * What a story phase's generation call is told about the record it rewrites:
 * the fields in words, the criterion numbering and tags, the teacher's floor,
 * and that the whole record comes back with the id and the learner's wording kept.
 * `notes` is said to hold open questions only: the Requirements room labels it
 * "Open questions", and a proposal told less may put the whole story sentence there.
 * Only platform text goes in here: the floor is numbers and tag words the
 * loader validated, the path appears only as a plain path token, and the record,
 * the provided stories, the hints and the story id reach the model only as data.
 */
function storyRecordBriefing(phase: PhaseContent, saved: string | undefined): string {
  if (phase.checks?.kind !== 'story') return '';
  const { record, floor } = phase.checks;
  const target = PLAIN_PATH.test(record) ? `\`${record}\`` : 'the story record file';
  // Said only when the saved record holds them, so a record without them is briefed without this sentence.
  const carried = storyCarried(saved).some(field => field !== 'id')
    ? ' The saved record also has epics and parentEpicId: return both exactly as they are saved; a proposal never changes the story id, the epics or the parent epic.'
    : '';
  return ` The story record is JSON with the text fields id, title, persona (As a), capability (I want), benefit (So that) and notes (only open questions still to settle with the customer, empty when there are none, never the story sentence); criteria, a list of {"id","given","when","then","tag"} numbered AC-1, AC-2, … in order, each tag one of happy, boundary or error; and scopeExclusions, a list of out-of-scope lines. The teacher's floor asks for ${floorSentence(floor)}. Return the complete story record as the new content of ${target}; keep the story id; never change the learner's wording unless the request asks.${carried}`;
}

/** Said when the intent check is adequate but wrote no feedback. */
export const ADEQUATE_INTENT_FEEDBACK = 'The request is specific enough to propose a change.';

/**
 * The propose route's reading of agentic.classify. An adequate
 * verdict with no question and an empty feedback string is accepted, as the
 * chat route accepts an adequate reply, with the server's sentence in place of
 * the missing feedback. Every other shape is read by parseAssessment unchanged,
 * so an inadequate verdict still needs its one question.
 */
function parseIntentAssessment(value: unknown) {
  const row = value as Record<string, unknown> | null;
  if (row && typeof row === 'object' && !Array.isArray(row) && row.adequate === true && typeof row.feedback === 'string' && !row.feedback.trim() &&
      Array.isArray(row.questions) && row.questions.length === 0) {
    return { adequate: true, feedback: ADEQUATE_INTENT_FEEDBACK, questions: [] as string[] };
  }
  return parseAssessment(value);
}

/**
 * The propose route's whole rule for a classify answer: `parseIntentAssessment`,
 * then exactly one question when inadequate and none when adequate. A refused
 * answer comes back as the token of the rule it broke, never as text.
 */
function readIntentAnswer(value: unknown): { assessment: SemanticAssessment; refusal: null } | { assessment: null; refusal: IntentRefusal } {
  try {
    const assessment = parseIntentAssessment(value);
    if (assessment.questions.length !== (assessment.adequate ? 0 : 1)) throw new Error('Intent assessment requires one focused question or none when adequate');
    return { assessment, refusal: null };
  } catch { return { assessment: null, refusal: readIntentRefusal(value) }; }
}

/** The Agentic route's whole budget (queue, every model call and the save), under the browser's own deadline. */
export const AGENTIC_REQUEST_TIMEOUT_MS = AI_ROUTE_BUDGET_MS;
export const AGENT_TURN_STALE_MS = AGENTIC_REQUEST_TIMEOUT_MS + 5_000;
const AGENT_CONTEXT_MAX_TURNS = 12;
const AGENT_CONTEXT_MAX_CHARS = 64_000;
/** The largest one proposed file may be, and the whole proposal serialised. */
const PROPOSAL_FILE_MAX_CHARS = 200_000;
const PROPOSAL_MAX_CHARS = 400_000;
/** Proposals listed per read, and conversation turns per page (newest first). */
const PROPOSAL_LIST_SIZE = 30;
const TURNS_PAGE_SIZE = 30;
/** The longest chat reply, and the longest clarifying question, a classify answer may carry. */
const CHAT_REPLY_MAX_CHARS = 12_000;
const CLARIFYING_QUESTION_MAX_CHARS = 4000;
/**
 * How many turns may be marked as generating at once in this process.
 *
 * The mark is a progress hint and nothing else: it is cleared when the turn
 * settles, so the ceiling is only reached if a process somehow loses that
 * clear. A bound keeps that leak a fixed number of ids rather than a growing
 * one, and dropping the oldest keeps the turns a learner is actually waiting
 * on correct.
 */
export const AGENT_PROPOSING_STAGE_MAX = 256;

interface AgentChatInput {
  requestId: string; message: string; parentTurnId?: string;
  proposalId?: string; proposalHash?: string;
}
type ProposalView = Omit<AgentProposalEntity, 'userId' | 'updatedAt' | 'lastEdit'> & { changes?: FieldChange[]; carried?: string[] };
export interface AgentTurnResponse {
  kind: 'clarification' | 'discussion' | 'proposal' | 'explanation';
  reply: string; questions: string[]; proposal: ProposalView | null;
}

/**
 * Where an Agentic turn's `assessment_unavailable` came from, a fixed token
 * for `failTurn`'s log line: the route's 55 s `deadline`, a model call
 * that failed or came back unreadable (`model_call`, with its call label), the
 * provider not configured, or an answer the service could not read as the
 * mentor's reply, the intent assessment or the explanation assessment. `other`
 * is a ServiceUnavailableException this service did not throw.
 */
type UnavailableSite = 'deadline' | 'provider_unconfigured' | 'model_call' | 'chat_reply' | 'intent_assessment' | 'explanation_assessment' | 'other';

/** A ServiceUnavailableException that knows its throw site; the learner's code and message are unchanged by it. */
export class AgenticUnavailableException extends ServiceUnavailableException {
  constructor(message: string, readonly site: UnavailableSite, readonly call: AiCallLabel | 'none' = 'none') {
    super(message);
  }
}

/** What the reason says when a generated proposal changes no file at all. */
const NO_FILE_CHANGED = 'The proposal changes no file.';

@Injectable()
export class AgenticService {
  private readonly logger = new Logger(AgenticService.name);
  /**
   * Turns whose second model call, the one that retypes whole files, has
   * started, held in this process only.
   *
   * It is a hint about a wait, never authority: no entity, no column, nothing
   * a later read of the turn can be decided on. It reaches a learner only
   * through the turn view they already own, and only while that turn is
   * pending.
   */
  private readonly proposing = new Map<string, true>();
  constructor(
    @InjectRepository(AgentProposalEntity) private readonly proposals: Repository<AgentProposalEntity>,
    private readonly workflow: WorkflowService,
    private readonly assistant: AssistantService,
    private readonly provider: OpenAiProvider,
    private readonly dataSource: DataSource,
    @InjectRepository(ExecutionRunEntity) private readonly runs: Repository<ExecutionRunEntity>,
    // Read-only: the pinned version's task list for the phase a call is on,
    // which decides whether its prompts are TaskTrackr's or the teacher's.
    private readonly content: ContentService,
  ) {
    // An invalid
    // AI_AGENTIC_EDIT_LIST refuses the boot here, when Nest builds this
    // service, and never at config's module load.
    resolveAgenticEditList();
    // An invalid AI_AGENTIC_PAYLOAD refuses the boot the same way.
    resolveAgenticPayload();
  }

  /**
   * The scope this phase's calls are composed under: the phase as loaded and
   * the version's own tasks. A list that cannot be read falls back to the
   * phase's sole task, which is TaskTrackr's only when the bytes are.
   */
  private scopeOf(phase: PhaseContent, enrollment: { projectSlug: string; projectVersionId?: string | null } | undefined, phaseKey: string): PhaseScope {
    const tasks = enrollment
      ? readableTasks(() => this.content.getTasksForEnrollment({ projectSlug: enrollment.projectSlug, projectVersionId: enrollment.projectVersionId ?? null }, phaseKey))
      : undefined;
    return phaseScopeOf(phase, tasks);
  }

  /** Re-inserting moves a turn to the newest end, so the bound drops the stalest id first. */
  private markProposing(turnId: string) {
    this.proposing.delete(turnId);
    this.proposing.set(turnId, true);
    while (this.proposing.size > AGENT_PROPOSING_STAGE_MAX) {
      const oldest = this.proposing.keys().next();
      if (oldest.done) break;
      this.proposing.delete(oldest.value);
    }
  }

  private clearProposing(turnId: string) {
    this.proposing.delete(turnId);
  }

  /** One diagnostic log line. A diagnostic never fails the turn it describes, so a logger that throws is ignored. */
  private diagnostic(line: string) {
    try {
      this.logger.log(line);
    } catch { /* The turn goes on without the line. */ }
  }

  /**
   * Given the phase and the state the proposal is read against, a structured
   * kind's proposal (a story, runbook or change-request one that touches the
   * record, any design one) also carries its field-by-field changes from the saved documents (or the
   * pack's scaffold when nothing is saved yet) and what it keeps as saved.
   */
  private view(row: AgentProposalEntity, phase?: PhaseContent, state?: PhaseStateEntity) {
    const { userId: _userId, updatedAt: _updatedAt, lastEdit: _lastEdit, ...view } = row;
    if (!phase || !state) return this.learnerProposal(view);
    const reference = structuredReference(phase, editableFiles(phase, state.workspace), row.files);
    return this.learnerProposal(reference ? { ...view, ...reference } : view);
  }

  private learnerProposal(row: ProposalView): ProposalView {
    // Applied history is final. Unapplied obsolete or substituted answers cannot
    // advertise permission. Rejected model rationales remain private in storage.
    return { ...row, explanationAssessment: learnerExplanationAssessment(row.explanationAssessment, Object.keys(row.files)),
      approvedAt: row.appliedAt || hasGroundedUnderstanding(row.explanationAssessment, row.explanation) ? row.approvedAt : null };
  }

  private learnerResponse(value: unknown): AgentTurnResponse | null {
    const response = value as AgentTurnResponse | null;
    if (!response) return null;
    const proposal = response.proposal ? this.learnerProposal(response.proposal) : null;
    const assessment = proposal?.explanationAssessment;
    // Also project old immutable journals: hiding a card must not leave the
    // complete reference recipe in reply, questions or another API field.
    if (response.kind === 'explanation' && assessment && !assessment.adequate) {
      return { ...response, reply: assessment.feedback, questions: assessment.questions, proposal };
    }
    return { ...response, proposal };
  }

  private async owned(userId: string, phaseStateId: string, proposalId: string) {
    await this.workflow.loadOwnedState(userId, phaseStateId);
    const row = await this.proposals.findOneBy({ id: proposalId, userId, phaseStateId });
    if (!row) throw new NotFoundException('Proposal not found.');
    return row;
  }

  private unchanged(row: AgentProposalEntity, hash: string) {
    if (row.proposalHash !== hash) throw new ConflictException('The proposal changed. Read it and explain the current version.');
    if (row.appliedAt) throw new ConflictException('This proposal was already applied.');
  }

  /**
   * A generated file map, checked by `validateFiles`: its refusal is the model's answer refused, so it
   * fails as `files_proposal_refused` with the rule's sentence as the reason, on the chat route and the
   * propose route alike. A learner's own edit keeps `validateFiles`' plain 400.
   */
  private generatedFiles(phase: PhaseContent, value: unknown): Record<string, string> {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) {
      throw new RefusedProposalException('files_proposal_refused', 'invalid_files', NO_FILE_CHANGED);
    }
    try { return this.validateFiles(phase, value); } catch (error) {
      if (error instanceof BadRequestException) throw new RefusedProposalException('files_proposal_refused', 'invalid_files', error.message);
      throw error;
    }
  }

  private validateFiles(phase: PhaseContent, value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Proposal files must be an object.');
    const editable = new Set(editablePaths(phase));
    const entries = Object.entries(value);
    if (!entries.length || entries.length > editable.size || entries.some(([path, content]) => !editable.has(path) || typeof content !== 'string' || content.length > PROPOSAL_FILE_MAX_CHARS)) throw new BadRequestException('The proposal contains invalid or non-editable files.');
    if (JSON.stringify(value).length > PROPOSAL_MAX_CHARS) throw new BadRequestException('The proposal is too large.');
    return Object.fromEntries(entries) as Record<string, string>;
  }

  /**
   * Includes the learner queue and every model stage; leaves 5s for the HTTP response.
   *
   * `work` also receives `deadlineAt`, taken before the timer is armed, so a
   * stage can ask how much of the same single budget is left.
   */
  private async reviewedOperation<T>(userId: string, work: (signal: AbortSignal, deadlineAt: number) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const deadlineAt = Date.now() + AGENTIC_REQUEST_TIMEOUT_MS;
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Read before the abort takes the waiter out of the line. A budget
        // spent waiting at the AI gate is the class's load (provider_busy); one
        // spent in a model call, or in the learner's own queue, is not.
        // The read never stops the deadline: a provider that cannot answer it reads not busy.
        let busy = false;
        try { busy = this.provider?.waitingAtGate?.(controller.signal) === true; } catch { busy = false; }
        controller.abort();
        reject(busy ? new AiBusyError('deadline', AGENTIC_REQUEST_TIMEOUT_MS)
          : new AgenticUnavailableException('The agentic review did not finish in time. Refresh the proposal before retrying.', 'deadline'));
      }, AGENTIC_REQUEST_TIMEOUT_MS);
    });
    const queued = this.assistant.serialise(userId, () => {
      controller.signal.throwIfAborted();
      return work(controller.signal, deadlineAt);
    });
    try { return await Promise.race([queued, deadline]); }
    finally { clearTimeout(timer); }
  }

  /**
   * `call` names which of this service's model calls this is, and is required
   * rather than optional: none of them carries a schema the provider could
   * derive a name from, so an unnamed one would silently join the catch-all
   * series and take a whole-file rewrite's seconds with it. It is a label for
   * the timer only, the request the provider builds is byte for byte the same
   * one, whichever label rides along.
   */
  private async ai(state: PhaseStateEntity, call: AiCallLabel, system: string, data: unknown, tokens = MAX_COMPLETION_TOKENS['structured.other'], signal?: AbortSignal, responseSchema?: { name: string; schema: Record<string, unknown> }, note?: string) {
    signal?.throwIfAborted();
    if (!this.provider.available) throw new AgenticUnavailableException('The AI provider is not configured. No proposal or approval was fabricated.', 'provider_unconfigured', call);
    try {
      // `note` is only ever a re-ask's fixed note (the explanation's or the prompt assessment's); without one the call is the six-argument one it always was.
      const result = await this.provider.structured(system, data, tokens, signal, responseSchema, call, ...(note === undefined ? [] as [] : [note] as [string]));
      await this.assistant.recordReviewUsage(state, this.provider.name, result.tokensIn, result.tokensOut);
      signal?.throwIfAborted();
      return result.value;
    } catch (error) {
      if (error instanceof ProviderUsageError) await this.assistant.recordReviewUsage(state, this.provider.name, error.tokensIn, error.tokensOut);
      // The AI gate refused the call: keep its own sentence and its own code (provider_busy).
      if (error instanceof AiBusyError) throw error;
      throw new AgenticUnavailableException('AI assessment failed or returned an invalid response. Nothing was approved or applied. Retry when available.', 'model_call', call);
    }
  }

  /**
   * The one generation call of a proposal, in the mode `AI_AGENTIC_EDIT_LIST`
   * names, returning the files map the rest of the chain validates and the
   * learner's summary written beside it (null when absent). Off: the
   * whole-file call. On or strict: an edit
   * list under `agentic.generate.edits`, expanded against `base`, the bytes
   * the payload showed the model, by the pure `expandEditList`. A refused
   * list fails the turn loudly; nothing partial is ever written, and no
   * whole-file request is made in its place.
   */
  private async generate(
    state: PhaseStateEntity, site: 'chat' | 'propose', phase: PhaseContent, scope: PhaseScope,
    base: Record<string, string>, data: Record<string, unknown>, signal: AbortSignal,
    again?: Regeneration,
  ): Promise<{ files: unknown; summary: string | null }> {
    const generation = site === 'chat' ? composeAgentChatGeneration : composeAgenticProposeGeneration;
    const saved = phase.checks?.kind === 'story' ? editableFiles(phase, state.workspace)[phase.checks.record] : undefined;
    // Trim mode names the payload's trimmed keys last; full mode adds nothing.
    const trimmed = trimSentence(config.agenticPayload, data);
    // The regeneration's briefing ends with the first answer's refusal, or the files an incomplete first
    // answer named and did not change; the first call's briefing has no such ending.
    // The design and record briefings follow the contract `m`: under the edit list they ask for code through
    // edits and a record whole as compact JSON; the whole-file briefing asks for neither.
    const compose = (p: PhaseContent, m: 'files' | 'edits', s: PhaseScope) => `${generation(p, m, s)}${storyRecordBriefing(p, saved)}${designBriefing(p, m)}${recordBriefing(p, m)}${trimmed}${again === undefined ? '' : 'refused' in again ? regenerationSentence(again.refused, m) : incompleteRegenerationSentence(again.incomplete, m)}`;
    const wholeFiles = async () => {
      const answer = await this.ai(state, 'agentic.generate', compose(phase, 'files', scope), data, MAX_COMPLETION_TOKENS['agentic.generate'], signal) as { files?: unknown; summary?: unknown } | null;
      return { files: answer?.files, summary: readProposalSummary(answer?.summary) };
    };
    const mode = config.agenticEditList;
    if (mode !== 'on' && mode !== 'strict') return wholeFiles();
    const paths = editablePaths(phase);
    // No editable path, no edit list: the whole-file contract applies, and the
    // existing chain refuses the empty result exactly as it does with the flag off.
    if (!paths.length) return wholeFiles();
    const schema = agentEditListSchema(paths);
    const value = await this.ai(state, 'agentic.generate.edits', compose(phase, 'edits', scope), data, MAX_COMPLETION_TOKENS['agentic.generate.edits'], signal, schema);
    const counted = (key: 'edits' | 'files') => {
      const list = (value as Record<string, unknown> | null)?.[key];
      return Array.isArray(list) ? list.length : 0;
    };
    // The distinct paths the answer's entries name, edits and files together: a count, never a path.
    const named = () => new Set((['edits', 'files'] as const).flatMap((key) => {
      const list = (value as Record<string, unknown> | null)?.[key];
      return Array.isArray(list) ? list.map((entry) => (entry as { path?: unknown } | null)?.path).filter((path): path is string => typeof path === 'string') : [];
    })).size;
    try {
      const expanded = expandEditList(base, value);
      this.editListLine(mode, site, 'expanded', expanded.editCount, expanded.wholeFileCount, Object.keys(expanded.files).length, 'none');
      return { files: expanded.files, summary: expanded.summary };
    } catch (error) {
      if (!(error instanceof EditExpansionError)) throw error;
      this.editListLine(mode, site, 'rejected', counted('edits'), counted('files'), named(), error.code);
      // A refused list is the model's answer refused, not a failed call: the learner reads why.
      throw new RefusedProposalException('files_proposal_refused', 'edit_list', editListRefusalReason(error));
    }
  }

  /**
   * One generation, read by `check` (the route's own file and record checks), with the one
   * regeneration: when `check` or the edit-list expansion refuses the answer and
   * `regenerationFits` the time left, the same call is made once more with the refusal in its
   * briefing, and whatever that second answer gives is final.
   * Each answer `check` keeps is counted for the files it left out as unchanged (`unchangedDropped`).
   * A first answer `check` keeps that left out a file `reaskPaths` finds (the learner's `completeness.request`
   * and the answer's own entries) is asked for once more on the same terms (`INCOMPLETE_REGENERATION`), unless `completeness` is null: a chat refinement of an open proposal, where leaving a file as saved
   * may be what the learner just asked, or a turn that already re-asked its prompt assessment. See there for
   * what the second answer may do.
   */
  private async generateChecked(
    state: PhaseStateEntity, site: 'chat' | 'propose', phase: PhaseContent, scope: PhaseScope,
    base: Record<string, string>, data: Record<string, unknown>, signal: AbortSignal, deadlineAt: number,
    check: (files: unknown) => Record<string, string>, completeness: { request: string } | null,
  ): Promise<{ value: Record<string, string>; summary: string | null; dropped: string[] }> {
    const started = Date.now();
    let again: { refused: RefusedProposalException } | { incomplete: string[]; first: { value: Record<string, string>; summary: string | null; dropped: string[] } };
    try {
      const first = await this.generate(state, site, phase, scope, base, data, signal);
      const value = check(first.files);
      const dropped = this.unchangedDropped(site, first.files, value);
      const incomplete = completeness ? reaskPaths(first.summary, completeness.request, Object.keys(value), editablePaths(phase), omittedPaths(phase, dropped)) : [];
      if (!incomplete.length) return { value, summary: first.summary, dropped };
      again = { incomplete, first: { value, summary: first.summary, dropped } };
    } catch (error) {
      if (!regenerable(error)) throw error;
      again = { refused: error };
    }
    const fits = regenerationFits(deadlineAt - Date.now(), Date.now() - started);
    if ('incomplete' in again) {
      // The first answer is usable: it stands whenever the second is not asked for or cannot be used.
      // A first generation slower than `INCOMPLETE_REASK_FIRST_MAX_MS`, measured as `regenerationFits` measures it, is not
      // asked for again even when the budget fits: the learner's wait, not the route's, is what it bounds.
      const slow = fits && Date.now() - started > INCOMPLETE_REASK_FIRST_MAX_MS;
      this.regenerationLine(site, INCOMPLETE_REGENERATION, fits && !slow ? 'started' : 'skipped', slow ? 'first_slow' : undefined);
      if (!fits || slow) return again.first;
      signal.throwIfAborted();
      // Only this optional second call has its own cut-off, `REGENERATION_REPLY_MS` before the route's deadline, inside
      // the reply margin `regenerationFits` already keeps, or `INCOMPLETE_REASK_SECOND_MAX_MS` after it starts, whichever
      // comes first: a second call still running then is stopped and the usable first answer is saved instead of
      // the turn failing as the deadline or the learner waiting on it. The route's 55 s race and `OPENAI_TIMEOUT_MS` still apply.
      const cut = new AbortController();
      let capped = false;
      const timer = setTimeout(() => cut.abort(), Math.max(0, deadlineAt - Date.now() - REGENERATION_REPLY_MS));
      const cap = setTimeout(() => { capped = !cut.signal.aborted; cut.abort(); }, INCOMPLETE_REASK_SECOND_MAX_MS);
      try {
        const second = await this.generate(state, site, phase, scope, base, data, AbortSignal.any([signal, cut.signal]), { incomplete: again.incomplete });
        const value = check(second.files);
        const dropped = this.unchangedDropped(site, second.files, value);
        // A second answer missing a file the first held, or holding fewer of the files the request and the first summary named, does not replace it.
        const editable = editablePaths(phase);
        const wanted = [...Object.keys(again.first.value), ...requestNamedPaths(completeness?.request ?? '', editable),...summaryNamedPaths(again.first.summary ?? '', editable)];
        if (secondAnswerKept(Object.keys(again.first.value), Object.keys(value), wanted)) return { value, summary: second.summary, dropped };
        this.regenerationLine(site, INCOMPLETE_REGENERATION, 'first_kept');
        return again.first;
      } catch (error) {
        // Past the route's deadline the turn has already failed as the deadline; nothing is kept.
        if (signal.aborted) throw error;
        this.regenerationLine(site, INCOMPLETE_REGENERATION, 'first_kept', capped ? 'second_slow' : undefined);
        return again.first;
      } finally { clearTimeout(timer); clearTimeout(cap); }
    }
    const { refused } = again;
    this.regenerationLine(site, refused, fits ? 'started' : 'skipped');
    if (!fits) throw refused;
    signal.throwIfAborted();
    const second = await this.generate(state, site, phase, scope, base, data, signal, { refused });
    const value = check(second.files);
    const dropped = this.unchangedDropped(site, second.files, value);
    return { value, summary: second.summary, dropped };
  }

  /**
   * One greppable line per regeneration decision: fixed tokens only, the first refusal's code and clause, or the
   * incomplete clause's (`code=proposal_incomplete clause=incomplete`, and `outcome=first_kept` when its
   * second answer was refused, its call failed or was cut off before the deadline, so the first answer stood).
   * The incomplete clause's own bounds add a fixed `reason`: `outcome=skipped reason=first_slow` when the
   * first generation took longer than `INCOMPLETE_REASK_FIRST_MAX_MS`, `outcome=first_kept reason=second_slow` when
   * the second call was stopped `INCOMPLETE_REASK_SECOND_MAX_MS` after it started.
   */
  private regenerationLine(site: 'chat' | 'propose', cause: { code: string; clause: string }, outcome: 'started' | 'skipped' | 'first_kept', reason?: 'first_slow' | 'second_slow') {
    this.diagnostic(`agentic_regeneration site=${site} code=${cause.code} clause=${cause.clause} outcome=${outcome}${reason ? ` reason=${reason}` : ''}`);
  }

  /**
   * The one line a prompt assessment re-ask writes, once its outcome is known: fixed tokens only,
   * the rule the first answer broke and ok (a usable second answer), failed (a second refusal or a failed
   * second call) or skipped (the budget left no room). Never an id, the prompt or the model's words.
   */
  private classifyReaskLine(refusal: IntentRefusal, outcome: 'ok' | 'failed' | 'skipped') {
    this.diagnostic(`agentic_regeneration site=classify code=intent_assessment clause=${refusal} outcome=${outcome}`);
  }

  /**
   * One greppable line per edit-list outcome: fixed tokens and integers only. `paths` is the
   * number of distinct files the answer's edits and files entries name together, so
   * `edits=2 files=1 paths=3` held an entry for three files before any was dropped as unchanged.
   */
  private editListLine(mode: 'on' | 'strict', site: 'chat' | 'propose', outcome: 'expanded' | 'rejected', edits: number, files: number, paths: number, code: string) {
    this.diagnostic(`agentic_edit_list mode=${mode} site=${site} outcome=${outcome} edits=${edits} files=${files} paths=${paths} code=${code}`);
  }

  /**
   * The editable paths a generated answer held that the route's checks left out of the
   * proposal because they equal the saved files: the chat route's no-op filter, and the
   * design and record normalisers' `dropUnchanged`. Every other way a path can leave
   * an answer refuses the answer instead, so the paths `answer` held that `checked` does not
   * are exactly these. Logged as one line of fixed tokens when there is at least one:
   * `agentic_proposal_unchanged_dropped site=<site> count=<n>`, never a path.
   */
  private unchangedDropped(site: 'chat' | 'propose', answer: unknown, checked: Record<string, string>): string[] {
    const held = answer && typeof answer === 'object' && !Array.isArray(answer) ? Object.keys(answer) : [];
    const dropped = held.filter((path) => !Object.prototype.hasOwnProperty.call(checked, path));
    if (dropped.length) {
      this.diagnostic(`agentic_proposal_unchanged_dropped site=${site} count=${dropped.length}`);
    }
    return dropped;
  }

  async list(userId: string, phaseStateId: string) {
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    return (await this.proposals.find({ where: { userId, phaseStateId }, order: { createdAt: 'DESC', id: 'DESC' }, take: PROPOSAL_LIST_SIZE })).map(row => this.view(row, phase, state));
  }

  async proposal(userId: string, phaseStateId: string, proposalId: string) {
    const row = await this.owned(userId, phaseStateId, proposalId);
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    return this.view(row, phase, state);
  }

  /**
   * A refused structured proposal names the rule that refused it on one log line: fixed tokens
   * only. The reason itself goes to the learner, on the turn or in the door's 400, never to the log.
   */
  private logRefusal(kind: string, refused: RefusedProposalException) {
    this.logger.log(`agentic_proposal_refused kind=${kind} code=${refused.code} clause=${refused.clause}`);
  }

  /**
   * A generated design record's decision statuses read as proposed (`statusesAsCarried`) are counted on one
   * log line of fixed tokens, as a refusal is: the stored proposal is the record after that read, so
   * nothing a learner or a reader can GET shows it happened. Never the words the model wrote, never an id.
   */
  private readonly logStatusRead = (count: number) => {
    this.logger.log(`design_status_read_as_proposed count=${count}`);
  };

  /** A door's own validator checks (propose, edit, apply): a refusal is logged as a chat turn's is, then thrown on unchanged. */
  private refusedAtDoor<T>(kind: 'propose' | 'edit' | 'apply', check: () => T): T {
    try { return check(); } catch (error) {
      if (error instanceof RefusedProposalException) this.logRefusal(kind, error);
      throw error;
    }
  }

  private turnView(row: AgentTurnEntity) {
    // errorDetail rides the view only inside errorMessage, after the fixed sentence.
    const { userId: _userId, requestHash: _requestHash, errorDetail: _errorDetail, ...view } = row;
    // Only a turn still being worked on can be mid-generation. A settled turn
    // omits the field entirely rather than reporting a wait that is over, and
    // the field rides the view the caller's ownership was already checked for.
    const stage: { stage?: 'proposing' } = row.status === 'pending' && this.proposing.has(row.id) ? { stage: 'proposing' } : {};
    // A refused structured proposal keeps its fixed sentence on the turn, read back from its code, and
    // after it the rule's reason when the refusal carried one (`errorDetail`).
    const said = isRefusedProposalCode(row.errorCode) ? { errorMessage: refusedProposalMessage(row.errorCode, row.errorDetail) } : {};
    return { ...view, ...stage, ...said, response: this.learnerResponse(row.response) };
  }

  private async settleStaleTurn(row: AgentTurnEntity): Promise<AgentTurnEntity> {
    // A restart must not replay an unknown provider request. The deadline is
    // conservative across processes; a currently running request gets its full budget.
    if (row.status === 'pending' && Date.now() - new Date(row.createdAt).getTime() >= AGENT_TURN_STALE_MS) {
      await this.dataSource.getRepository(AgentTurnEntity).update({ id: row.id, status: 'pending' }, { status: 'failed', errorCode: 'request_expired' });
      return this.dataSource.getRepository(AgentTurnEntity).findOneByOrFail({ id: row.id });
    }
    return row;
  }

  async turns(userId: string, phaseStateId: string, cursor?: string) {
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const repo = this.dataSource.getRepository(AgentTurnEntity);
    const query = repo.createQueryBuilder('turn').where('turn.userId = :userId AND turn.phaseStateId = :phaseStateId', { userId, phaseStateId });
    if (cursor) {
      const anchor = await repo.findOneBy({ id: cursor, userId, phaseStateId });
      if (!anchor) throw new NotFoundException('Conversation cursor not found.');
      // PostgreSQL preserves microseconds while JavaScript Date keeps only
      // milliseconds. Compare the stored anchor directly so a page boundary
      // cannot skip older turns within the anchor's millisecond.
      query.innerJoin(AgentTurnEntity, 'cursorTurn',
        'cursorTurn.id = :cursorId AND cursorTurn.userId = :userId AND cursorTurn.phaseStateId = :phaseStateId', { cursorId: anchor.id });
      query.andWhere('(turn.createdAt < cursorTurn.createdAt OR (turn.createdAt = cursorTurn.createdAt AND turn.id < cursorTurn.id))');
    }
    const rows = await query.orderBy('turn.createdAt', 'DESC').addOrderBy('turn.id', 'DESC').take(TURNS_PAGE_SIZE + 1).getMany();
    const page = rows.slice(0, TURNS_PAGE_SIZE);
    const items = await Promise.all(page.map(async row => this.turnView(await this.settleStaleTurn(row))));
    return { items, nextCursor: rows.length > TURNS_PAGE_SIZE ? page[page.length - 1].id : null, currentWorkspaceHash: workspaceHash(editableFiles(phase, state.workspace)) };
  }

  async turn(userId: string, phaseStateId: string, requestId: string) {
    await this.workflow.loadOwnedState(userId, phaseStateId);
    const row = await this.dataSource.getRepository(AgentTurnEntity).findOneBy({ userId, phaseStateId, requestId });
    if (!row) throw new NotFoundException('Conversation request not found.');
    return this.turnView(await this.settleStaleTurn(row));
  }

  private turnRequestHash(kind: AgentTurnEntity['kind'], phaseStateId: string, input: AgentChatInput) {
    return createHash('sha256').update(JSON.stringify({ kind, phaseStateId, message: input.message,
      parentTurnId: input.parentTurnId ?? null, proposalId: input.proposalId ?? null, proposalHash: input.proposalHash ?? null })).digest('hex');
  }

  private async previousRequest(userId: string, phaseStateId: string, input: AgentChatInput, kind: AgentTurnEntity['kind']) {
    const row = await this.dataSource.getRepository(AgentTurnEntity).findOneBy({ userId, requestId: input.requestId });
    if (!row) return null;
    if (row.phaseStateId !== phaseStateId || row.requestHash !== this.turnRequestHash(kind, phaseStateId, input)) {
      throw new ConflictException('This request ID already belongs to a different message.');
    }
    return this.settleStaleTurn(row);
  }

  private async conversationContext(userId: string, phaseStateId: string, input: AgentChatInput, baseHash: string) {
    if (!!input.proposalId !== !!input.proposalHash) throw new BadRequestException('A proposal ID and its exact hash are required together.');
    const repo = this.dataSource.getRepository(AgentTurnEntity);
    const rows: AgentTurnEntity[] = [];
    const seen = new Set<string>();
    let next = input.parentTurnId;
    let chars = input.message.length;
    while (next) {
      if (seen.has(next) || rows.length >= AGENT_CONTEXT_MAX_TURNS) throw new BadRequestException('This conversation is too long. Start a new conversation with the intended change and constraints.');
      seen.add(next);
      const row = await repo.findOneBy({ id: next, userId, phaseStateId });
      if (!row) throw new NotFoundException('The preceding conversation turn was not found.');
      if (row.status !== 'completed') throw new ConflictException('Wait for the preceding reply or start a new conversation.');
      if (row.baseWorkspaceHash !== baseHash) throw new ConflictException('The saved workspace changed. Start a new conversation against the current files.');
      const response = this.learnerResponse(row.response);
      if (!response || typeof response.reply !== 'string' || !Array.isArray(response.questions)) throw new ConflictException('The preceding reply is unavailable. Start a new conversation.');
      chars += row.message.length + response.reply.length + JSON.stringify(response.questions).length;
      if (chars > AGENT_CONTEXT_MAX_CHARS) throw new BadRequestException('This conversation is too long. Start a new conversation with the intended change and constraints.');
      rows.push(row); next = row.parentTurnId ?? undefined;
    }
    rows.reverse();
    const priorProposal = [...rows].reverse().find(row => (row.response as AgentTurnResponse | null)?.proposal)?.response as AgentTurnResponse | undefined;
    const selectedId = input.proposalId ?? priorProposal?.proposal?.id;
    const selectedHash = input.proposalHash ?? priorProposal?.proposal?.proposalHash;
    let selected: AgentProposalEntity | null = null;
    if (selectedId) {
      selected = await this.owned(userId, phaseStateId, selectedId);
      this.unchanged(selected, selectedHash!);
      if (selected.baseWorkspaceHash !== baseHash) throw new ConflictException('The saved workspace changed. Request a new proposal against the current files.');
      if (!selected.assessment.adequate || !Object.keys(selected.files).length) throw new ConflictException('Select a complete proposal, or continue its clarification without selecting files.');
    }
    const transcript = rows.map(row => { const response = this.learnerResponse(row.response)!; return { learner: row.message, mentor: response.reply, questions: response.questions, kind: response.kind }; });
    // Persist the original requested behaviour for the later understanding review.
    // A short refinement must never replace the original constraints in row.prompt.
    const selectedFromEnd = selected ? [...rows].reverse().findIndex(row => row.proposalId === selected!.id && (row.response as AgentTurnResponse | null)?.kind === 'proposal') : -1;
    const selectedAt = selectedFromEnd < 0 ? -1 : rows.length - selectedFromEnd - 1;
    const requestTurns = (selected ? rows.slice(selectedAt + 1) : rows).filter(row => row.kind === 'chat');
    const intent = JSON.stringify({ selectedProposalOriginalRequest: selected?.prompt ?? null,
      precedingConversation: requestTurns.map(row => { const response = this.learnerResponse(row.response)!; return { learner: row.message, mentor: response.reply, questions: response.questions }; }),
      currentLearnerMessage: input.message });
    if (intent.length > AGENT_CONTEXT_MAX_CHARS || chars + (selected?.prompt.length ?? 0) > AGENT_CONTEXT_MAX_CHARS) throw new BadRequestException('This conversation is too long. Start a new conversation with the intended change and constraints.');
    return { selected, transcript, intent };
  }

  private async claimTurn(userId: string, phaseStateId: string, input: AgentChatInput, kind: AgentTurnEntity['kind'], baseHash: string, selected?: AgentProposalEntity | null) {
    const repo = this.dataSource.getRepository(AgentTurnEntity);
    const row = repo.create({ userId, phaseStateId, requestId: input.requestId, requestHash: this.turnRequestHash(kind, phaseStateId, input), kind,
      status: 'pending', message: input.message, parentTurnId: input.parentTurnId ?? null,
      parentProposalId: selected?.id ?? input.proposalId ?? null, parentProposalHash: selected?.proposalHash ?? input.proposalHash ?? null,
      baseWorkspaceHash: baseHash, proposalId: null, response: null, errorCode: null });
    try { return { row: await repo.save(row), claimed: true }; }
    catch (error) {
      const existing = await this.previousRequest(userId, phaseStateId, input, kind);
      if (existing) return { row: existing, claimed: false };
      throw error;
    }
  }

  /**
   * Refuse a change to read-only files before any model call, with one log
   * line naming the cause. The body says `retryable: false`: sending the same
   * words again is refused the same way, so the web offers no retry of them.
   */
  private refuseReadOnlyTarget(phase: PhaseContent, message: string, site: 'chat' | 'propose') {
    const paths = readOnlyTargets(phase, message);
    if (!paths.length) return;
    this.logger.log(`agentic_refused site=${site} cause=read_only_target files=${JSON.stringify(paths)}`);
    throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: readOnlyRefusal(paths), retryable: false });
  }

  private async failTurn(row: AgentTurnEntity, error: unknown) {
    const refused = error instanceof RefusedProposalException ? error : null;
    const errorCode = error instanceof ConflictException ? 'proposal_changed' :
      refused?.code ?? (error instanceof ForbiddenException || error instanceof NotFoundException ? 'phase_unavailable' :
        error instanceof AiBusyError ? 'provider_busy' :
          error instanceof ServiceUnavailableException ? 'assessment_unavailable' : 'request_failed');
    // A refused structured proposal names the rule that refused it: fixed tokens only; the
    // reason itself goes to the learner on the turn, never to the log.
    if (refused) this.logRefusal(row.kind, refused);
    // The learner's code says only that no answer could be used, so this line names where it came
    // from: a fixed site and, for a model call, its label. Never model or learner text.
    if (errorCode === 'assessment_unavailable') {
      const site = error instanceof AgenticUnavailableException ? error : null;
      this.logger.log(`agentic_turn_unavailable kind=${row.kind} site=${site?.site ?? 'other'} call=${site?.call ?? 'none'}`);
    }
    // The catch-all code says nothing about its cause, so this log line names
    // the error's class, and the message of the service's own HTTP
    // refusals only (fixed copy, never learner or model text).
    if (errorCode === 'request_failed') {
      const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof error;
      const said = error instanceof BadRequestException ? `: ${error.message}` : '';
      this.logger.log(`agentic_turn_failed kind=${row.kind} code=${errorCode} cause=${name}${said}`);
    }
    await this.dataSource.getRepository(AgentTurnEntity).update({ id: row.id, status: 'pending' }, { status: 'failed', errorCode, errorDetail: refused?.detail ?? null });
    return this.turnView(await this.dataSource.getRepository(AgentTurnEntity).findOneByOrFail({ id: row.id }));
  }

  @TrackedAiOperation('agentic')
  async chat(userId: string, phaseStateId: string, input: AgentChatInput) {
    const { state, phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const scope = this.scopeOf(phase, enrollment, state.phaseKey);
    const previous = await this.previousRequest(userId, phaseStateId, input, 'chat');
    if (previous) return this.turnView(previous);
    this.refuseReadOnlyTarget(phase, input.message, 'chat');
    const workspace = editableFiles(phase, state.workspace);
    const baseHash = workspaceHash(workspace);
    const context = await this.conversationContext(userId, phaseStateId, input, baseHash);
    const claim = await this.claimTurn(userId, phaseStateId, input, 'chat', baseHash, context.selected);
    if (!claim.claimed) return this.turnView(claim.row);
    try {
      return await this.reviewedOperation(userId, async (signal, deadlineAt) => {
        const current = await this.workflow.loadOwnedState(userId, phaseStateId);
        if (workspaceHash(editableFiles(current.phase, current.state.workspace)) !== baseHash) throw new ConflictException('Your workspace changed while this message waited.');
        // Recheck selected bytes after queueing; another tab may have edited them.
        const currentSelected = context.selected ? await this.owned(userId, phaseStateId, context.selected.id) : null;
        if (currentSelected) this.unchanged(currentSelected, context.selected!.proposalHash);
        const proposedWorkspace = { ...workspace, ...(currentSelected?.files ?? {}) };
        const value = await this.ai(state, 'agentic.classify', composeAgentChatAssessment(phase, scope), {
          currentMessage: input.message, precedingConversation: context.transcript,
          originalRequest: context.selected?.prompt ?? null, savedWorkspace: workspace,
          selectedProposal: currentSelected ? { id: currentSelected.id, hash: currentSelected.proposalHash, files: currentSelected.files,
            workflow: { understandingAccepted: Boolean(currentSelected.approvedAt) && hasGroundedUnderstanding(currentSelected.explanationAssessment, currentSelected.explanation), applied: false, applyRequiresExplicitControl: true } } : null,
        }, MAX_COMPLETION_TOKENS['agentic.classify'], signal);
        const reply = value as { kind?: unknown; reply?: unknown; questions?: unknown } | null;
        if (!reply || typeof reply !== 'object' || Array.isArray(reply) || Object.keys(reply).length !== 3 || Object.keys(reply).some(key => !['kind', 'reply', 'questions'].includes(key)) || !['clarification', 'discussion', 'proposal'].includes(String(reply.kind)) || typeof reply.reply !== 'string' || !reply.reply.trim() || reply.reply.length > CHAT_REPLY_MAX_CHARS ||
          !Array.isArray(reply.questions) || reply.questions.some(q => typeof q !== 'string' || !q.trim() || q.length > CLARIFYING_QUESTION_MAX_CHARS) || reply.questions.length !== (reply.kind === 'clarification' ? 1 : 0)) {
          throw new AgenticUnavailableException('The mentor returned an invalid conversational response. Nothing was approved.', 'chat_reply');
        }
        let files: Record<string, string> | null = null;
        let summary: string | null = null;
        if (reply.kind === 'proposal') {
          // The learner is now waiting on the long call, not the short one. Marked
          // before it starts so the first poll after this point already says so.
          this.markProposing(claim.row.id);
          // Off sends the whole-file request; an edit list expands against
          // proposedWorkspace, never savedWorkspace.
          const generated = await this.generateChecked(state, 'chat', phase, scope, proposedWorkspace,
            chatGenerationData(config.agenticPayload, phase, { request: context.intent, transcript: context.transcript, saved: workspace, proposed: proposedWorkspace,
              selectedPaths: Object.keys(currentSelected?.files ?? {}), extra: { ...designStories(phase), ...changeTicketData(phase) } }), signal, deadlineAt,
            (answer) => {
              // The story's sentence parts are cleaned before the unchanged files are dropped, so a record that only
              // differed from the saved one by the sentence's own words is dropped like any unchanged file.
              const patch = normaliseStoryProposal(this.generatedFiles(phase, answer), phase, storyBase(phase, workspace));
              const merged = this.generatedFiles(phase, Object.fromEntries(Object.entries({ ...(context.selected?.files ?? {}), ...patch }).filter(([path, content]) => content !== workspace[path])));
              validateStoryProposal(merged, phase, storyBase(phase, workspace));
              return normaliseRecordProposal(normaliseDesignProposal(merged, phase, workspace, { dropUnchanged: true, onStatusRead: this.logStatusRead }), phase, workspace, { dropUnchanged: true });
              // The re-ask reads only the learner's own message, the one the card's "Your request names ..." line reads
              // never the turn's context, whose earlier mentor replies are not the learner's request.
            }, context.selected ? null : { request: input.message });
          files = generated.value;
          summary = this.summaryChecked(phase, generated.summary, generated.value, generated.dropped);
        }
        signal.throwIfAborted();
        return this.workflow.transaction(async manager => {
          const held = await manager.getRepository(AgentTurnEntity).findOneByOrFail({ id: claim.row.id });
          this.assertPendingTurn(held);
          const liveState = await manager.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseStateId, userId });
          if (workspaceHash(editableFiles(phase, liveState.workspace)) !== baseHash) throw new ConflictException('The saved workspace changed while the reply was prepared.');
          if (context.selected) {
            const liveParent = await manager.getRepository(AgentProposalEntity).findOneByOrFail({ id: context.selected.id, userId, phaseStateId });
            this.unchanged(liveParent, context.selected.proposalHash);
          }
          signal.throwIfAborted();
          const proposal = files ? await manager.getRepository(AgentProposalEntity).save(this.proposals.create({ userId, phaseStateId, prompt: context.intent, files,
            proposalHash: workspaceHash(files), baseWorkspaceHash: baseHash, lastEdit: null, assessment: { adequate: true, feedback: reply.reply as string, questions: [] }, summary,
            explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null })) : null;
          signal.throwIfAborted();
          const response: AgentTurnResponse = { kind: reply.kind as AgentTurnResponse['kind'], reply: (reply.reply as string).trim(), questions: reply.questions as string[], proposal: proposal ? this.view(proposal, phase, state) : currentSelected ? this.view(currentSelected, phase, state) : null };
          const patch = { status: 'completed' as const, response, proposalId: proposal?.id ?? context.selected?.id ?? null };
          const saved = await manager.getRepository(AgentTurnEntity).update({ id: held.id, status: 'pending' }, patch);
          if (!saved.affected) throw new ConflictException('This request changed before its reply was saved.');
          return this.turnView(await manager.getRepository(AgentTurnEntity).findOneByOrFail({ id: held.id }));
        });
      });
    } catch (error) { return this.failTurn(claim.row, error); }
    // Completed, failed or timed out, the wait this described is over. The
    // views above are built before this runs and already read the settled row.
    finally { this.clearProposing(claim.row.id); }
  }

  @TrackedAiOperation('agentic')
  async explainTurn(userId: string, phaseStateId: string, id: string, hash: string, explanation: string, requestId: string, parentTurnId?: string) {
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const input: AgentChatInput = { requestId, message: explanation, proposalId: id, proposalHash: hash, parentTurnId };
    const previous = await this.previousRequest(userId, phaseStateId, input, 'explain');
    if (previous) return this.turnView(previous);
    const row = await this.owned(userId, phaseStateId, id);
    this.unchanged(row, hash);
    await this.conversationContext(userId, phaseStateId, input, workspaceHash(editableFiles(phase, state.workspace)));
    const claim = await this.claimTurn(userId, phaseStateId, input, 'explain', workspaceHash(editableFiles(phase, state.workspace)), row);
    if (!claim.claimed) return this.turnView(claim.row);
    try {
      return await this.reviewedOperation(userId, async (signal, deadlineAt) => this.turnView((await this.assessExplanation(userId, phaseStateId, id, hash, explanation, signal, deadlineAt, claim.row)).turn!));
    } catch (error) { return this.failTurn(claim.row, error); }
  }

  @TrackedAiOperation('agentic')
  async propose(userId: string, phaseStateId: string, prompt: string) {
    return this.reviewedOperation(userId, async (signal, deadlineAt) => {
      const { state, phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
      signal.throwIfAborted();
      this.refuseReadOnlyTarget(phase, prompt, 'propose');
      const scope = this.scopeOf(phase, enrollment, state.phaseKey);
      const workspace = editableFiles(phase, state.workspace);
      const system = composeAgenticIntentAssessment(phase, scope);
      // One ask, read by the route's own rule; a refused answer is read for the re-ask. Both asks bill their spend.
      const classify = async (note?: string) => readIntentAnswer(await this.ai(state, 'agentic.classify', system, { prompt, workspace }, MAX_COMPLETION_TOKENS['agentic.classify'], signal, undefined, note));
      const incomplete = () => new AgenticUnavailableException('The AI returned an incomplete prompt assessment. No proposal was approved.', 'intent_assessment');
      const asked = Date.now();
      const first = await classify();
      let assessment: SemanticAssessment;
      // The completeness regeneration is skipped on a turn that re-asked its assessment: one re-ask a turn.
      const reasked = !first.assessment;
      if (first.assessment) assessment = first.assessment;
      else {
        // An answer the rule refuses (not a readable assessment, or outside the
        // one-question rule) is asked about once more, with the same request and one fixed
        // note naming the rule, inside this same call: the learner's one place in the queue
        // and the route's one 55 s budget, never raised. The second answer meets the same
        // rule; anything but a usable assessment fails the proposal as a first refusal would.
        // Never a third ask; a call that failed before any answer is not re-asked.
        const answeredAt = Date.now();
        if (!classifyReaskFits(deadlineAt - answeredAt, answeredAt - asked)) {
          this.classifyReaskLine(first.refusal, 'skipped');
          throw incomplete();
        }
        const second = await classify(classifyReaskNote(first.refusal)).catch(() => null);
        this.classifyReaskLine(first.refusal, second?.assessment ? 'ok' : 'failed');
        if (!second?.assessment) throw incomplete();
        assessment = second.assessment;
      }
      let files: Record<string, string> = {};
      let summary: string | null = null;
      if (assessment.adequate) {
        // The saved workspace is this endpoint's base in both modes.
        // Only the refusal the learner reads is logged as one; a refused first answer is on the regeneration's line.
        const generated = await this.generateChecked(state, 'propose', phase, scope, workspace,
          proposeGenerationData(config.agenticPayload, phase, { prompt, workspace, extra: { ...designStories(phase), ...changeTicketData(phase) } }), signal, deadlineAt,
          (answer) => {
            const valid = this.generatedFiles(phase, answer);
            validateStoryProposal(valid, phase, storyBase(phase, workspace));
            const cleaned = normaliseStoryProposal(valid, phase, storyBase(phase, workspace));
            return normaliseRecordProposal(normaliseDesignProposal(cleaned, phase, workspace, { dropUnchanged: true, onStatusRead: this.logStatusRead }), phase, workspace, { dropUnchanged: true });
          }, reasked ? null : { request: prompt }).catch((error: unknown) => { if (error instanceof RefusedProposalException) this.logRefusal('propose', error); throw error; });
        files = generated.value;
        summary = this.summaryChecked(phase, generated.summary, generated.value, generated.dropped);
      }
      signal.throwIfAborted();
      return this.view(await this.proposals.save(this.proposals.create({ userId, phaseStateId, prompt, files, proposalHash: workspaceHash(files), baseWorkspaceHash: workspaceHash(workspace), lastEdit: null, assessment, summary, explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null })), phase, state);
    });
  }

  async edit(userId: string, phaseStateId: string, id: string, hash: string, files: Record<string, string>) {
    const row = await this.owned(userId, phaseStateId, id);
    this.unchanged(row, hash);
    if (!row.assessment.adequate) throw new ForbiddenException('Clarify your prompt before editing a proposal.');
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const live = editableFiles(phase, state.workspace);
    const valid = this.validateFiles(phase, files);
    const clean = this.refusedAtDoor('edit', () => {
      validateStoryProposal(valid, phase, storyBase(phase, live));
      return normaliseRecordProposal(normaliseDesignProposal(valid, phase, live, { refuseCarried: true }), phase, live, { refuseCarried: true });
    });
    const nextHash = workspaceHash(clean);
    // The summary described the proposal before the edit, so it goes with it: the card then shows none.
    const patch = { files: clean, proposalHash: nextHash, lastEdit: { previousFiles: row.files, previousHash: row.proposalHash, currentHash: nextHash, editedAt: new Date().toISOString() }, explanation: null, explanationAssessment: null, approvedAt: null, summary: null };
    const updated = await this.proposals.update({ id, userId, proposalHash: hash, appliedAt: IsNull() }, patch);
    if (!updated.affected) throw new ConflictException('The proposal changed before the edit could be saved.');
    return this.view({ ...row, ...patch }, phase, state);
  }

  @TrackedAiOperation('agentic')
  async explain(userId: string, phaseStateId: string, id: string, hash: string, explanation: string) {
    return this.reviewedOperation(userId, async (signal, deadlineAt) => (await this.assessExplanation(userId, phaseStateId, id, hash, explanation, signal, deadlineAt)).proposal);
  }

  private assertPendingTurn(row: AgentTurnEntity) {
    if (row.status !== 'pending' || Date.now() - new Date(row.createdAt).getTime() >= AGENT_TURN_STALE_MS) throw new ConflictException('This conversation request is no longer pending.');
  }

  private async assessExplanation(userId: string, phaseStateId: string, id: string, hash: string, explanation: string, signal: AbortSignal, deadlineAt: number, journal?: AgentTurnEntity): Promise<{ proposal: ProposalView; turn: AgentTurnEntity | null }> {
    const row = await this.owned(userId, phaseStateId, id);
    signal.throwIfAborted();
    this.unchanged(row, hash);
    if (!row.assessment.adequate || !Object.keys(row.files).length) throw new ForbiddenException('A sufficiently specified proposal is required first.');
    const { state, phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
    signal.throwIfAborted();
    const scope = this.scopeOf(phase, enrollment, state.phaseKey);
    if (workspaceHash(editableFiles(phase, state.workspace)) !== row.baseWorkspaceHash) throw new ConflictException('Your workspace changed. Request a new proposal against the current files.');
    // A new answer replaces the prior authorisation immediately. Provider failure or an
    // in-flight apply must not reuse approval for an answer now being reconsidered.
    if (journal) {
      await this.workflow.transaction(async manager => {
        this.assertPendingTurn(await manager.getRepository(AgentTurnEntity).findOneByOrFail({ id: journal.id }));
        signal.throwIfAborted();
        const revoked = await manager.getRepository(AgentProposalEntity).update({ id, userId, proposalHash: hash, appliedAt: IsNull() }, { explanation, explanationAssessment: null, approvedAt: null });
        if (!revoked.affected) throw new ConflictException('The proposal changed before your explanation could be assessed.');
      });
    } else {
      const revoked = await this.proposals.update({ id, userId, proposalHash: hash, appliedAt: IsNull() }, { explanation, explanationAssessment: null, approvedAt: null });
      if (!revoked.affected) throw new ConflictException('The proposal changed before your explanation could be assessed.');
    }
    // This is server-observed edit provenance, not an AI or learner assertion.
    // Legacy rows have no preceding proposal; never invent one for them.
    const lastEdit = row.lastEdit && row.lastEdit.previousFiles && typeof row.lastEdit.previousFiles === 'object' && !Array.isArray(row.lastEdit.previousFiles) &&
      Object.values(row.lastEdit.previousFiles).every(value => typeof value === 'string') && row.lastEdit.currentHash === row.proposalHash &&
      row.lastEdit.previousHash === workspaceHash(row.lastEdit.previousFiles) ? row.lastEdit : null;
    // The records this learner's own work wrote, for THIS phase state only.
    // `loadOwnedState` above already proved the phase state is theirs, and
    // `userId` is repeated on the query so a run row can never arrive from
    // another learner even if that check ever moved. On those two keys this
    // where clause is the rule and not an optimisation of one: the shared
    // builder reads `RecordedRunRow`, which carries neither an owner nor a
    // phase state, so it takes whatever rows it is handed and cannot
    // re-apply them. Never relax `userId` or `phaseStateId` here. The
    // builder does re-apply `kind`, `status` and this order, submissions,
    // verdicts, scores, stdout, stderr and test case names are excluded
    // there, so only that half is belt and braces. The `id` tie-break is
    // not decoration: two rows really can share a createdAt on sqlite.
    const recentRuns = await this.runs.find({
      where: { userId, phaseStateId, kind: 'run', status: 'completed' },
      order: { createdAt: 'DESC', id: 'DESC' }, take: EVIDENCE_MAX_RUNS,
    });
    signal.throwIfAborted();
    // A structured document's evidence is its field change set, as the overlay shows it; a record proposal that touches other files also carries those files.
    const { reference, structured, mixed } = explanationReference(phase, editableFiles(phase, state.workspace), row.files, { originalRequest: row.prompt, proposalHash: row.proposalHash, latestEdit: lastEdit });
    const system = `${agenticContext(phase, scope)} ${EXPLANATION_ASSESSMENT_PROMPT}${structured ? ` ${mixed ? STRUCTURED_MIXED_EVIDENCE_RULE : STRUCTURED_EVIDENCE_RULE}` : ''}`;
    const data = {
      reference,
      evidence: learnerRecordedEvidence({ drill: drillWithIncident(state.drill, state.workspace, phase), runs: recentRuns, latestEdit: lastEdit,
        proposedFiles: row.files, proposalAt: row.createdAt }),
      learnerAnswer: explanation,
      answerEvidence: explanationEvidence(explanation),
    };
    const schema = explanationAssessmentResponseSchema(explanation);
    // One ask, judged by the gate's own parser; a refused answer keeps its
    // warn line and is read for the re-ask. Both asks bill their spend.
    const assess = async (note?: string) => {
      const result = await this.ai(state, 'agentic.explanation', system, data, MAX_COMPLETION_TOKENS['agentic.explanation'], signal, schema, note);
      try { return { assessment: parseModelExplanationAssessment(result, explanation), refusal: null }; } catch (error) {
        this.logger.warn(`AI explanation assessment rejected: proposal=${id} code=${explanationAssessmentFailure(error)}`);
        return { assessment: null, refusal: readExplanationRefusal(error, result, explanation) };
      }
    };
    const invalid = () => new AgenticUnavailableException('The AI returned an invalid explanation assessment. Approval remains closed.', 'explanation_assessment');
    const asked = Date.now();
    const first = await assess();
    let assessment = first.assessment;
    if (first.refusal) {
      // An answer the parser refuses is asked about once more, with the same
      // request and one fixed note naming what could not be read, inside this
      // same call: the learner's one place in the queue and the route's one
      // 55 s budget, never raised. The second answer meets the same parser;
      // anything but a valid assessment fails the explanation as a first
      // refusal would. Never a third ask.
      // Only with the floor, and the first ask's own duration plus 10 s, left.
      const answeredAt = Date.now();
      const remaining = deadlineAt - answeredAt;
      if (!explanationReaskFits(remaining, answeredAt - asked)) {
        this.logger.warn(`agentic_explanation_reask_skipped cause=${first.refusal.code} remaining_ms=${Math.max(0, remaining)}`);
        throw invalid();
      }
      const second = await assess(explanationReaskNote(first.refusal)).catch(() => null);
      // Counted on one line of fixed tokens beside the warn line(s) above: the
      // phase key, the first refusal's code and the outcome, never an id or
      // the model's words. still_invalid is anything but a valid assessment
      // (a second refusal, whose own warn line names its code, or a failed call).
      this.logger.warn(`agentic_explanation_reasked phase=${phase.key} cause=${first.refusal.code} outcome=${second?.assessment ? 'ok' : 'still_invalid'}`);
      if (!second?.assessment) throw invalid();
      assessment = second.assessment;
    }
    if (!assessment) throw invalid();
    const patch = { explanation, explanationAssessment: assessment, approvedAt: assessment.adequate ? new Date().toISOString() : null };
    signal.throwIfAborted();
    if (journal) return this.workflow.transaction(async manager => {
      const held = await manager.getRepository(AgentTurnEntity).findOneByOrFail({ id: journal.id });
      this.assertPendingTurn(held);
      signal.throwIfAborted();
      const updated = await manager.getRepository(AgentProposalEntity).update({ id, userId, proposalHash: hash, explanation, explanationAssessment: IsNull(), approvedAt: IsNull(), appliedAt: IsNull() }, patch);
      if (!updated.affected) throw new ConflictException('The proposal changed while you were explaining it. Read and explain the new version.');
      const proposal = this.view({ ...row, ...patch }, phase, state);
      // The private immutable journal retains the original assessment for
      // audit. Every learner read and subsequent chat context uses projection.
      const response: AgentTurnResponse = { kind: 'explanation', reply: assessment.feedback, questions: assessment.questions,
        proposal: { ...proposal, explanationAssessment: assessment } };
      signal.throwIfAborted();
      const completed = await manager.getRepository(AgentTurnEntity).update({ id: held.id, status: 'pending' }, { status: 'completed', response, proposalId: proposal.id });
      if (!completed.affected) throw new ConflictException('The conversation request changed before approval could be saved.');
      signal.throwIfAborted();
      return { proposal, turn: await manager.getRepository(AgentTurnEntity).findOneByOrFail({ id: held.id }) };
    });
    const updated = await this.proposals.update({ id, userId, proposalHash: hash, explanation, explanationAssessment: IsNull(), approvedAt: IsNull(), appliedAt: IsNull() }, patch);
    if (!updated.affected) throw new ConflictException('The proposal changed while you were explaining it. Read and explain the new version.');
    return { proposal: this.view({ ...row, ...patch }, phase, state), turn: null };
  }

  async apply(userId: string, phaseStateId: string, id: string, hash: string) {
    const row = await this.owned(userId, phaseStateId, id);
    if (row.appliedAt && row.proposalHash === hash) {
      const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
      return { proposal: this.view(row, phase, state), workspace: state.workspace ?? {} };
    }
    this.unchanged(row, hash);
    if (!row.assessment.adequate || !hasGroundedUnderstanding(row.explanationAssessment, row.explanation) || !row.approvedAt) throw new ForbiddenException('Explain the current proposal correctly before applying it.');
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    if (workspaceHash(editableFiles(phase, state.workspace)) !== row.baseWorkspaceHash) throw new ConflictException('The workspace changed. Request and explain a new proposal before applying.');
    const live = editableFiles(phase, state.workspace);
    const files = this.validateFiles(phase, row.files);
    // Checked against the live documents, so the story's id, epics and parent epic, and the design's ids, statuses
    // and switched-off sequence, written are the saved ones.
    this.refusedAtDoor('apply', () => {
      validateStoryProposal(files, phase, storyBase(phase, live));
      validateDesignProposal(files, phase, live);
      // The runbook's and change request's ids, a switched-off contract and a drill phase's incident written are the saved ones.
      validateRecordProposal(files, phase, live);
    });
    // Written through the same guard as the learner's own save: each document as validated, a switched-off contract refused, a drill's incident carried.
    const guarded = phase.checks?.kind === 'design'
      ? Object.fromEntries(Object.entries(files).map(([path, content]) => [path, refuseInvalidDesignDocument(path, content, phase.checks!)]))
      : phase.checks && hasRecord(phase.checks)
        ? Object.fromEntries(Object.entries(files).map(([path, content]) => [path, refuseInvalidRecord(path, content, phase.checks!, live[path])]))
        : files;
    const workspace = { ...(state.workspace ?? {}), ...guarded };
    const at = new Date(Math.max(Date.now(), Date.parse(state.workspaceUpdatedAt || '') + 1 || 0)).toISOString();
    await this.workflow.transaction(async manager => {
      // Reserve this exact approved version first. Concurrent edits/apply/explain cannot substitute bytes.
      const claimed = await manager.getRepository(AgentProposalEntity).update({ id, userId, proposalHash: hash, approvedAt: row.approvedAt!, appliedAt: IsNull() }, { appliedAt: at });
      if (!claimed.affected) throw new ConflictException('This proposal was changed or applied elsewhere. Refresh before continuing.');
      const write = manager.createQueryBuilder().update(PhaseStateEntity).set({ workspace, workspaceUpdatedAt: at }).where('id = :id AND "userId" = :userId', { id: state.id, userId });
      if (state.workspaceUpdatedAt) write.andWhere('"workspaceUpdatedAt" = :version', { version: state.workspaceUpdatedAt });
      else write.andWhere('"workspaceUpdatedAt" IS NULL');
      const saved = await write.execute();
      if (!saved.affected) throw new ConflictException('The workspace changed during apply. Nothing was overwritten.');
    });
    return { proposal: this.view({ ...row, appliedAt: at }, phase, state), workspace };
  }

  /**
   * A generated summary as both doors store it: read against the
   * proposal's files (in their order) and the phase's own paths by `checkSummaryPaths`
   * with the phase's editable list, so a summary naming an editable path the proposal
   * does not hold is stored as the file sentence and the server's sentence (below), one
   * naming only read-only unheld paths besides a held file keeps its words, one
   * naming read-only unheld paths and no held file is stored as one sentence listing the held files
   * and nothing else, its words not shown, and one
   * naming a held file while leaving another held file out keeps its
   * words and gains that sentence. This runs once, before the proposal is stored; a
   * proposal is served as stored. Every summary checked writes one line of integers,
   * `agentic_summary_paths names=<n> held=<m> extra=<k> unnamed=<u>` (extra=0 when it
   * named only held files or no path; unnamed the held files it does not name); a
   * missing summary stays null with no line. When the answer named an editable file the
   * proposal does not change (its summary names it, or `dropped` holds a code or
   * configuration file the route left out as unchanged: `omittedPaths`), the stored
   * summary is the file sentence and the server's sentence naming those files.
   */
  private summaryChecked(phase: PhaseContent, summary: string | null, files: Record<string, string>, dropped: readonly string[]): string | null {
    if (summary === null) return null;
    const checked = checkSummaryPaths(summary, Object.keys(files), phase.files.map(file => file.path), { editable: editablePaths(phase), dropped: omittedPaths(phase, dropped) });
    this.diagnostic(`agentic_summary_paths names=${checked.names} held=${checked.held} extra=${checked.extra} unnamed=${checked.unnamed}`);
    return checked.summary;
  }
}
