import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import type {
  InterviewAskResponse,
  InterviewRecord,
  InterviewState,
  InterviewTurn,
} from '@learnsdlc/shared';
import { AI_ROUTE_BUDGET_MS } from '@learnsdlc/shared';
import { ContentService, type EnrollmentPin } from '../content/content.service';
import { InterviewBrief, InterviewFact, PhaseContent } from '../content/content.types';
import { AssistantMessageEntity, PhaseStateEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { WorkflowService } from '../workflow/workflow.service';
import { AssistantService, INTERVIEW_USAGE_PROVIDER } from './assistant.service';
import { INTERVIEW_QUESTION_MAX_CHARS } from './mentor.dto';
import { PROVIDER_CALL_ENDED, PROVIDER_EMPTY_RESPONSE, PROVIDER_HTTP_ERROR, PROVIDER_STOPPED_EARLY, PROVIDER_TIMED_OUT } from './provider-errors';
import {
  detectOffPhase,
  isSolutionRequest,
  offPhaseReply,
  redactArtifactLikeReply,
  redactSolutions,
  sanitizeMessage,
} from './guardrails';
import { OpenAiProvider, ProviderUsageError, type InterviewRepair } from './openai.provider';
import { INTERVIEW_REVIEW_KEYS, INTERVIEW_REVIEW_VERSION, interviewReviewVersionOf } from './interview-review';
import { requestCorrelationId } from '../observability/logger';
import { recordReviewRejection } from './model-call-timing';
import { trackAiOperation, TrackedAiOperation } from './operation-tracker';

// `version` is the review prompt this turn is reviewed
// under, once the brief is known, the authored arm's own tag on a teacher's
// interview, so each recorded diagnostic names the prompt that reviewed it.
type InterviewDiagnostic = { requestId: string; stage: string; attempt: number; version?: string };

/** Classify only controlled provider failures; never return exception text. */
export function stakeholderFailureCode(error: unknown): string {
  // Native fetch/AbortSignal errors can cross a VM realm (including Jest's).
  const name=typeof error==='object' && error!==null ? (error as {name?:unknown}).name : undefined;
  if (name === 'TimeoutError') return 'provider_timeout';
  if (name === 'AbortError') return 'cancelled';
  if (!(error instanceof Error)) return 'unavailable';
  const known: Record<string, string> = {
    'Stakeholder answer is empty': 'empty_candidate',
    'Stakeholder drafted an assessed artifact': 'artifact_candidate',
    'Stakeholder revision repeated the withheld answer': 'repeated_candidate',
    'Stakeholder response did not satisfy its evidence review': 'semantic_rejection',
    'Stakeholder review was incomplete or malformed': 'malformed_review',
    [PROVIDER_STOPPED_EARLY]: 'truncated_completion',
    [PROVIDER_EMPTY_RESPONSE]: 'empty_completion',
    [PROVIDER_CALL_ENDED]: 'cancelled',
    'Stakeholder operation ended before its response could be used': 'cancelled',
    'Stakeholder operation ended before its review could be used': 'cancelled',
    'fetch failed': 'provider_network',
  };
  if (Object.prototype.hasOwnProperty.call(known,error.message)) return known[error.message];
  // The stakeholder route names only a 4xx or 5xx status, and only a timeout of at most ten digits.
  const status = PROVIDER_HTTP_ERROR.exec(error.message);
  if (status && /^[45]/.test(status[1])) return `provider_http_${status[1]}`;
  const timedOut = PROVIDER_TIMED_OUT.exec(error.message);
  if (timedOut && timedOut[1].length <= 10) return 'provider_timeout';
  if (error instanceof SyntaxError) return 'malformed_json';
  return 'unavailable';
}

/** The route's budget, which leaves time for the API response before the browser's 60-second deadline. */
export const STAKEHOLDER_REQUEST_TIMEOUT_MS = AI_ROUTE_BUDGET_MS;
const withheldReply = () => new ServiceUnavailableException({
  statusCode: 503,
  code: 'STAKEHOLDER_REPLY_WITHHELD',
  message: 'The stakeholder could not provide a reliable answer. Please retry.',
});

/**
 * The requirements interview: a second room for the person who is
 * already the reviewer, in which the learner asks the customer what they want
 * instead of asking the mentor how to write it.
 *
 * It is deliberately not a second mentor. The customer answers from a hidden
 * truth document in the content pack and from nothing else; every answer still
 * passes the output guardrails; and the one thing the customer will never do is
 * write the artefact, which is the whole reason the room can exist beside a
 * graded story without grading it.
 *
 * Recorded, not graded. The count of settled facts shows on the checklist and
 * on the instructor's learner page, and changes no rubric score and no report
 * check, scoring it would mean editing every pack's rubric mid-term, and the
 * interview already earns its keep by making the story better, which is the
 * thing that is graded.
 */
@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  private diagnostic(context: InterviewDiagnostic, code: string, checks: readonly string[] = []): void {
    const safeChecks = INTERVIEW_REVIEW_KEYS.filter(key => checks.includes(key));
    this.logger.warn(`Stakeholder diagnostic rid=${context.requestId} version=${context.version ?? INTERVIEW_REVIEW_VERSION} stage=${context.stage} attempt=${context.attempt} code=${code}${safeChecks.length ? ` checks=${safeChecks.join(',')}` : ''}`);
  }

  /**
   * How often a reviewed answer is refused, and nothing else. The arithmetic of
   * the repair is the reason to count it: an attempt of 1 is a turn that spent
   * four model calls instead of two, an attempt of 2 is a turn that spent four
   * and still withheld, and the latency review could only guess at the ratio
   * because nothing recorded it. Both labels come from a pair fixed here, so a
   * series can never carry a question, an answer or a learner.
   *
   * Observing is not allowed to become a failure mode. `answer()` turns every
   * throw below it into a withheld reply, so a registry that broke here would
   * cost the learner their question; the sample is the cheaper thing to lose.
   *
   * One count per refused answer, labelled by its first
   * failed check through the shared `recordReviewRejection` (see its rule).
   */
  private countRejection(attempt: number, failedChecks: readonly string[]): void {
    try {
      recordReviewRejection('interview', attempt === 0 ? 1 : 2, failedChecks);
    } catch {
      // Deliberately silent: a diagnostic that reports itself is still a fault.
    }
  }

  constructor(
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(AssistantMessageEntity)
    private readonly messages: Repository<AssistantMessageEntity>,
    private readonly workflow: WorkflowService,
    private readonly content: ContentService,
    private readonly assistant: AssistantService,
    private readonly openaiProvider: OpenAiProvider,
  ) {}

  /* ------------------------------- reading ------------------------------- */

  /**
   * The brief for a phase, or a 404 saying so. The route is drawn on the issue
   * page only when the phase declares one, but a learner with the URL, or a
   * pack that dropped the block between two loads, has to meet a sentence
   * rather than a stack trace.
   */
  private briefFor(phase: PhaseContent): InterviewBrief {
    const brief = this.content.interviewBrief(phase);
    if (!brief) throw new NotFoundException('this phase has no interview');
    return brief;
  }

  async state(userId: string, phaseStateId: string): Promise<InterviewState> {
    const { state, phase } = await this.workflow.loadOwnedState(userId, phaseStateId);
    return this.view(this.briefFor(phase), state.interview);
  }

  /** What the room shows: the pack's persona and topics over the learner's turns. */
  private view(brief: InterviewBrief, record: InterviewRecord | null): InterviewState {
    const turns = record?.turns ?? [];
    const settled = new Set(turns.flatMap((turn) => turn.facts));
    return {
      persona: { ...brief.persona },
      opening: brief.opening,
      startedAt: record?.startedAt ?? null,
      turns,
      // Topics only. The answers stay in the pack until the customer says one.
      facts: brief.facts.map((fact) => ({
        id: fact.id,
        topic: fact.topic,
        uncovered: settled.has(fact.id),
      })),
      factsExpected: brief.factsExpected,
      turnsLeft: Math.max(0, brief.maxTurns - turns.length),
      closedAt: record?.closedAt ?? (turns.length >= brief.maxTurns ? this.stampOf(turns) : null),
    };
  }

  private stampOf(turns: InterviewTurn[]): string | null {
    return turns.length ? turns[turns.length - 1].askedAt : null;
  }

  /* -------------------------------- asking ------------------------------- */

  @TrackedAiOperation('interview')
  async ask(
    userId: string,
    phaseStateId: string,
    rawQuestion: string,
    requestId?: string,
  ): Promise<InterviewAskResponse> {
    const diagnostic: InterviewDiagnostic = { requestId: requestCorrelationId(requestId), stage: 'ownership', attempt: 0 };
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        this.diagnostic(diagnostic, 'request_deadline');
        reject(withheldReply());
      }, STAKEHOLDER_REQUEST_TIMEOUT_MS);
    });
    const work = async () => {
      const { phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
      controller.signal.throwIfAborted();
      const brief = this.briefFor(phase);
      diagnostic.version = interviewReviewVersionOf(brief);
      diagnostic.stage = 'queue';
      // One question at a time per learner. An expired queued callback still
      // waits for its predecessor, then exits without starting another call.
      return this.assistant.serialise(userId, () => {
        controller.signal.throwIfAborted();
        return this.askSerialised(phaseStateId, brief, enrollment, rawQuestion, controller.signal, diagnostic);
      });
    };
    try {
      // Cancellation also reaches the provider and every persistence boundary;
      // merely racing a timer would leave late work free to save a hidden turn.
      return await Promise.race([trackAiOperation('interview', work), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async askSerialised(
    phaseStateId: string,
    brief: InterviewBrief,
    // The pin, not the slug: the project the customer is talking about is the
    // one this enrolment holds, and on a deployment with a second
    // published version the head is another learner's project.
    pin: EnrollmentPin,
    rawQuestion: string,
    signal: AbortSignal,
    diagnostic: InterviewDiagnostic,
  ): Promise<InterviewAskResponse> {
    // Re-read behind the queue: the record the previous ask wrote is the one
    // the cap has to be checked against.
    diagnostic.stage = 'state_read';
    const state = await this.phaseStates.findOneByOrFail({ id: phaseStateId });
    signal.throwIfAborted();
    const previous = state.interview ?? null;
    const record: InterviewRecord = previous
      ? { ...previous, turns: [...previous.turns] }
      : { startedAt: new Date().toISOString(), turns: [], closedAt: null };
    if (record.turns.length >= brief.maxTurns) {
      throw new ConflictException('the customer has no more time for questions');
    }

    const question = sanitizeMessage(rawQuestion).slice(0, INTERVIEW_QUESTION_MAX_CHARS);
    const settled = [...new Set(record.turns.flatMap((turn) => turn.facts))];
    const project = this.content.getForEnrollment(pin);

    const answered = await this.answer(brief, project.title, question, settled, state, signal, diagnostic);
    signal.throwIfAborted();
    const turn: InterviewTurn = {
      id: randomUUID(),
      question,
      answer: answered.answer,
      facts: answered.facts,
      provider: answered.provider,
      askedAt: new Date().toISOString(),
    };
    record.turns.push(turn);
    if (record.turns.length >= brief.maxTurns) record.closedAt = turn.askedAt;

    // The narrow write, for the same reason saveWorkspace uses one: a whole-row
    // save from here would post a stale workspace over an autosave that landed
    // while the customer was thinking.
    //
    // Conditional: only over the record this ask read. Another process
    // that wrote a turn in between loses nothing, its turn stays and this one
    // is refused, rather than the two records silently becoming one.
    const write = this.phaseStates
      .createQueryBuilder()
      .update(PhaseStateEntity)
      .set({ interview: record })
      .where('id = :id', { id: state.id });
    if (previous) write.andWhere('interview = :previous', { previous: JSON.stringify(previous) });
    else write.andWhere('interview IS NULL');
    signal.throwIfAborted();
    diagnostic.stage = 'persistence';
    const result = await write.execute();
    if (!result.affected) {
      throw new ConflictException('the customer was answering another question — ask again');
    }

    diagnostic.stage = 'usage_total';
    return {
      turn,
      state: this.view(brief, record),
      usage: {
        todayTokens: await this.assistant.tokensToday(state.userId),
      },
    };
  }

  /** One answer: guardrails, then the real provider with explicit failures. */
  private async answer(
    brief: InterviewBrief,
    projectTitle: string,
    question: string,
    settled: string[],
    state: PhaseStateEntity,
    signal: AbortSignal,
    diagnostic: InterviewDiagnostic,
  ): Promise<{ answer: string; facts: string[]; provider: string }> {
    // "Write the story for me" never reaches a model, and never settles a fact.
    // In the customer's room the refusal is the customer's own sentence, not
    // the mentor's: a product owner who suddenly talks about hint ladders is a
    // broken customer, and the pack already has the right words.
    if (isSolutionRequest(question)) {
      return { answer: brief.refusal, facts: [], provider: 'guardrail' };
    }
    // A Docker question in the interview is still a Docker question.
    const offPhase = detectOffPhase(question, 'requirements');
    if (offPhase) {
      return {
        answer: offPhaseReply(offPhase, 'Requirements'),
        facts: [],
        provider: 'guardrail',
      };
    }

    if (!this.openaiProvider.available) {
      diagnostic.stage = 'availability';
      this.diagnostic(diagnostic, 'provider_unavailable');
      throw new ServiceUnavailableException('The stakeholder AI is unavailable. Please retry when available.');
    }

    try {
      let repair: InterviewRepair | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        diagnostic.stage = 'generation';
        diagnostic.attempt = attempt + 1;
        signal.throwIfAborted();
        const reply = await this.openaiProvider.interview(brief, projectTitle, question, settled, repair, signal);
        // Usage includes drafts and reviews even when no turn is accepted.
        diagnostic.stage = 'generation_usage';
        await this.recordUsage(state, reply.provider, reply.tokensIn, reply.tokensOut);
        signal.throwIfAborted();

        diagnostic.stage = 'candidate_evidence';
        if (typeof reply.content !== 'string' || !reply.content.trim()) throw new Error('Stakeholder answer is empty');
        const guarded = this.guard(reply.content);
        if (guarded === null) throw new Error('Stakeholder drafted an assessed artifact');
        if (repair && guarded === repair.answer) {
          throw new Error('Stakeholder revision repeated the withheld answer');
        }

        const facts: string[] = []; // Generator tags are not part of the plain-answer protocol.
        // Different subjects may legitimately have opposite outcomes in one
        // answer. Review the whole answer before saving or uncovering facts.
        diagnostic.stage = 'review';
        const reviewed = await this.openaiProvider.reviewInterview({ brief, question, answer: guarded, claimedFactIds: facts }, signal);
        diagnostic.stage = 'review_usage';
        await this.recordUsage(state, reply.provider, reviewed.tokensIn, reviewed.tokensOut);
        signal.throwIfAborted();
        if (!reviewed.safe) {
          diagnostic.stage = 'semantic_rejection';
          this.diagnostic(diagnostic, 'semantic_rejection', reviewed.failedChecks);
          // Synchronous and after the log, so it cannot reorder the awaited work
          // above it or move the branch below it.
          this.countRejection(attempt, reviewed.failedChecks);
          if (attempt === 0) {
            // Correct one unseen draft, then review that new candidate from
            // scratch. A rejected answer is never retried for a different vote.
            repair = { answer: guarded, facts, failedChecks: reviewed.failedChecks };
            continue;
          }
          throw new Error('Stakeholder response did not satisfy its evidence review');
        }
        // Coverage is informational, independent of answer safety and phase
        // grading. Only the fresh review's fully supported facts earn credit;
        // the generator's tags cannot settle an omitted or partial rule.
        return { answer: guarded, facts: reviewed.supportedFactIds, provider: reply.provider };
      }
      throw new Error('Stakeholder response did not satisfy its evidence review');
    } catch (err) {
      if (err instanceof ProviderUsageError) await this.recordUsage(state, this.openaiProvider.name, err.tokensIn, err.tokensOut);
      this.diagnostic(diagnostic, stakeholderFailureCode(err));
      throw withheldReply();
    }
  }

  /**
   * A generated artefact is withheld, not replaced by an authored answer or
   * recorded as a successful interview turn. Input refusals remain explicit.
   */
  private guard(answer: string): string | null {
    // The requirements phase is a markdown phase, so there is no reference
    // solution to overlap with; the artefact-shaped filter is the one that bites.
    const solution = redactSolutions(answer, []);
    if (solution.redacted) return null;
    const artifact = redactArtifactLikeReply(solution.content);
    if (artifact.redacted) return null;
    const trimmed = solution.content.trim();
    return trimmed || null;
  }

  /**
   * One bookkeeping row per reported model completion, including withheld
   * drafts and their reviews, using the shape `recordReviewUsage`
   * established: the tokens land in `assistant_messages` because that table is
   * the ledger `tokensToday()` sums, and the row is tagged so the transcript,
   * the reliance index and the mentor-paste check all skip it.
   *
   * Crucially there is **no** user-role row. Hint counts and the reliance index
   * count `role: 'user'` rows only, so a learner who asks the customer ten
   * questions would otherwise be recorded as leaning on the mentor ten times.
   */
  private async recordUsage(
    state: PhaseStateEntity,
    provider: string,
    tokensIn: number,
    tokensOut: number,
  ): Promise<void> {
    if (tokensIn + tokensOut === 0) return;
    await this.messages.save(
      this.messages.create({
        userId: state.userId,
        enrollmentId: state.enrollmentId,
        phaseStateId: state.id,
        phaseKey: state.phaseKey,
        role: 'assistant',
        provider: INTERVIEW_USAGE_PROVIDER,
        content: `Interview turn answered by ${provider}.`,
        tokensIn,
        tokensOut,
      }),
    );
  }
}

/* ---------------------------- the fact matcher ---------------------------- */

/** The score at which a question is asking for a fact rather than brushing past it. */
const FACT_MATCH_THRESHOLD = 2;

/** Words too common to mean anything on their own. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'it', 'i', 'you', 'we', 'they', 'be', 'should', 'would', 'what', 'that', 'this', 'my', 'your',
]);

/**
 * Which fact a question is asking for, or null.
 *
 * The same "lower-case, includes" simplicity `LocalMentorProvider.matchTopic`
 * uses, with two additions: a topic word is worth less than a declared keyword,
 * and a fact the customer has already settled scores less than one they have
 * not, so a learner who asks the same thing twice is moved along rather than
 * told the same sentence again.
 */
export function matchFact(
  brief: InterviewBrief,
  question: string,
  settled: string[],
): InterviewFact | null {
  const lower = question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = new Set(lower.split(/\s+/).filter((w) => w && !STOP_WORDS.has(w)));
  const already = new Set(settled);

  let best: InterviewFact | null = null;
  let bestScore = 0;
  for (const fact of brief.facts) {
    let score = 0;
    for (const keyword of fact.keywords) {
      if (lower.includes(keyword.toLowerCase())) score += 2;
    }
    for (const word of fact.topic.toLowerCase().split(/\s+/)) {
      if (word && !STOP_WORDS.has(word) && words.has(word)) score += 1;
    }
    if (already.has(fact.id)) score -= 1;
    if (score > bestScore) {
      best = fact;
      bestScore = score;
    }
  }
  return bestScore >= FACT_MATCH_THRESHOLD ? best : null;
}

/** Parse the declared coverage without guessing or silently dropping bad IDs.
 * The fresh reviewer independently determines safety and earned fact credit. */
export function splitFactsLine(
  reply: string,
  brief: InterviewBrief,
): { answer: string; facts: string[] } {
  const declared = new Set(brief.facts.map(fact => fact.id));
  const lines = reply.trim().split(/\r?\n/);
  const evidenceLines = lines.flatMap((line, index) => {
    const match = line.trim().match(/^FACTS\s*:\s*(.*)$/i);
    return match ? [{ index, value: match[1].trim() }] : [];
  });
  if (evidenceLines.length !== 1 || evidenceLines[0].index !== lines.length - 1) {
    throw new Error('Stakeholder answer needs one final evidence line');
  }
  const declaredLine = evidenceLines[0].value;
  const facts = declaredLine.toLowerCase() === 'none' ? [] : declaredLine.split(/[,\s]+/);
  if (!declaredLine || facts.some(id => !declared.has(id)) || new Set(facts).size !== facts.length) {
    throw new Error('Stakeholder answer declared invalid fact evidence');
  }
  const answer = lines.slice(0, -1).join('\n').trim();
  if (!answer) throw new Error('Stakeholder answer is empty');
  return { answer, facts };
}
