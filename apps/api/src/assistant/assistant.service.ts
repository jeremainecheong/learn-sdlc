import { assessmentFailure } from './assessment-failure';
import { AiBusyError } from '../execution/run-gate';
import { trackAiOperation, TrackedAiOperation } from './operation-tracker';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { In, LessThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import type {
  AiRubricReview,
  AssistantChatResponse,
  AssistantMessageView,
  MentorMemoryView,
} from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { PhaseContent } from '../content/content.types';
import {
  AiCacheEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { InjectRepository } from '../db/inject';
import {
  usageDayStart,
  detectOffPhase,
  EXPLAIN_WITHHELD_NOTICE,
  isSolutionRequest,
  offPhaseReply,
  redactArtifactLikeReply,
  redactSolutions,
  sanitizeMessage,
  solutionRequestPreamble,
  WITHHELD_REPLY_NOTICE,
} from './guardrails';
import { DifficultyTier, difficultyTier, relianceIndex, tierHintOffset } from '../feedback/checkers';
// The class schedule, read through the same helpers the workflow gate
// uses, so the chat door cannot open a phase the phase page holds shut.
import { opensAtMessage, scheduledShut, scheduleForCohort } from '../instructor/schedule.service';
import { LocalMentorProvider } from './local.provider';
import { buildMemory, memoryBlock, PassedPhaseInput } from './memory';
import { NotesService } from '../instructor/notes.service';
import { LESSON_SENTENCE, MENTOR_HISTORY_TURNS, ProviderUsageError, OpenAiProvider, mentorInstructionIdentity, type ReviewReask } from './openai.provider';
import { aiCacheTtlMs, openaiTimeoutMs } from '../config/ai';
import { REVIEW_REASK_DEADLINE, REVIEW_REASK_FLOOR_MS, reviewContradictionOf } from './review-reask';
import { phaseScopeOf, readableTasks, sealedRedactionSources, type PhaseScope } from './project-scope';
import type { CompiledTask } from '../content/pack-compiler';
import { HOUR_MS } from '../db/timestamps';
import { isUniqueViolation } from '../db/unique-violation';
import { editableEntries, editableFiles } from './workspace-files';
import { hintsByPhaseState } from '../analytics/queries';

/** The optional lesson's one sentence, owned by the provider's composers. */
export { LESSON_SENTENCE };
import {
  FailingTestContext,
  MentorContext,
  MentorSignals,
  ProviderReply,
  ReviewInput,
} from './provider.types';

/**
 * Extra context a caller other than the chat box supplies.
 *
 * The explain route is a second door into the same room: it composes the
 * question, hands the failing test over here, and everything below, the
 * request throttling, the cache, the output guardrails, the
 * transcript pair and the meter, happens to it exactly as it happens to a
 * question the learner typed. That reuse is the whole design of the feature.
 */
interface ChatExtra {
  /** Explicit optional-lesson route only; never grants workspace access. */
  lesson?: boolean;
  failingTest?: FailingTestContext;
}

/**
 * Provider tag on the rows that carry rubric-review spend. Review tokens have
 * to land in assistant_messages because that table is the ledger tokensToday()
 * sums, but they are bookkeeping, not conversation, so the chat transcript and
 * the mentor-paste check exclude them by this tag.
 */
export const REVIEW_USAGE_PROVIDER = 'rubric-review';

/**
 * Provider tag on the rows that carry customer-interview spend.
 * A copy of the tag above, for the same reason and with the same consequences:
 * the tokens have to land in assistant_messages because that table is the
 * ledger, and the row must be invisible to the transcript, to the reliance
 * index and to the mentor-paste check, because an interview turn is not a hint.
 *
 * Note what is *not* written: no `role: 'user'` row. Hint counts and the
 * reliance index count user rows only, so a learner who asks the customer ten
 * questions would otherwise be recorded as having leaned on the mentor ten
 * times, and every instructor's hint column would say so.
 */
export const INTERVIEW_USAGE_PROVIDER = 'interview';

/** The bookkeeping tags: metered spend that is not conversation. */
const USAGE_ONLY_PROVIDERS = [REVIEW_USAGE_PROVIDER, INTERVIEW_USAGE_PROVIDER];

/** A row's own time, whichever way the driver handed it back. */
const stampOf = (row: { createdAt?: Date | string; updatedAt?: Date | string }): number => {
  const value = row.updatedAt ?? row.createdAt;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** How long "the provider actually in use" looks back for the instructor console, and at most how many replies it reads. */
const PROVIDER_WINDOW_MS = HOUR_MS;
const PROVIDER_WINDOW_ROWS = 500;
/** The most messages one transcript read returns. */
const TRANSCRIPT_PAGE_SIZE = 200;
/** The workspaces whose stub list is remembered at once; the memo starts again when full. */
const TODO_MEMO_MAX = 500;
/** How far back mentor memory looks for questions the mentor would not answer: the learner's questions, and the withheld replies. */
const MEMORY_QUESTION_SCAN = 100;
const MEMORY_WITHHELD_SCAN = 10;
/** How many of this phase's earlier questions the hint ladder counts. */
const LADDER_QUESTION_SCAN = 50;

/**
 * One queue per key, in this process.
 *
 * Serialising one learner's calls preserves conversation ordering and the
 * interview's read-then-write turn count. Usage is recorded for diagnostics;
 * it does not limit access. The queue is per learner.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * AI orchestration: loads the phase's prompt and guardrail rules, calls the
 * model for every chat turn (with no provider configured the turn is refused
 * with a 503, never simulated), filters replies so the learner receives hints
 * rather than answers, records provider token usage, and caches responses.
 * The local hint ladder answers only the solution-request guardrail.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @InjectRepository(AssistantMessageEntity)
    private readonly messages: Repository<AssistantMessageEntity>,
    @InjectRepository(AiCacheEntity) private readonly cache: Repository<AiCacheEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(EnrollmentEntity) private readonly enrollments: Repository<EnrollmentEntity>,
    @InjectRepository(SubmissionEntity) private readonly submissions: Repository<SubmissionEntity>,
    private readonly content: ContentService,
    private readonly localProvider: LocalMentorProvider,
    private readonly openaiProvider: OpenAiProvider,
    private readonly notes: NotesService,
  ) {}

  /** One learner's billable calls, one at a time. */
  private readonly perLearner = new KeyedLock();

  /**
   * Run `work` behind every other billable call this learner has in flight.
   * The interview and the rubric review share the ledger the chat path bills
   * to, so they share the queue.
   */
  serialise<T>(userId: string, work: () => Promise<T>): Promise<T> {
    return trackAiOperation('serialised', () => this.perLearner.run(userId, work));
  }

  /** The provider this deployment is configured to use. */
  activeProviderName(): string {
    return this.openaiProvider.available ? this.openaiProvider.name : 'unavailable';
  }

  /**
   * The provider that actually answered in the last hour, which is not the
   * same question as the one above: guardrail replies and usage bookkeeping
   * rows name no mentor and are left out, so the console reports what the
   * learners were really answered by. Falls back to the configured name only
   * when nobody has asked anything in the window.
   */
  async recentProviderName(
    withinMs: number = PROVIDER_WINDOW_MS,
    now: Date = new Date(),
  ): Promise<string> {
    const rows = await this.messages.find({
      where: { role: 'assistant', createdAt: MoreThanOrEqual(new Date(now.getTime() - withinMs)) },
      select: ['provider'],
      order: { createdAt: 'DESC' },
      take: PROVIDER_WINDOW_ROWS,
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const provider = row.provider;
      // Guardrail replies and review bookkeeping name no mentor.
      if (!provider || provider === 'guardrail' || USAGE_ONLY_PROVIDERS.includes(provider)) continue;
      counts.set(provider, (counts.get(provider) || 0) + 1);
    }
    // Rows arrive newest first, so on a tie the most recent one wins.
    let winner = '';
    let best = 0;
    for (const [provider, count] of counts) {
      if (count > best) {
        winner = provider;
        best = count;
      }
    }
    return winner || this.activeProviderName();
  }

  /* ---------------------------- usage reporting --------------------------- */

  /**
   * Provider usage since local midnight. This is observational data only;
   * no number of consumed tokens disables a learner's AI access.
   */
  async tokensToday(userId: string, now: Date = new Date()): Promise<number> {
    const dayStart = usageDayStart(now);
    const rows = await this.messages.find({
      where: { userId, createdAt: MoreThanOrEqual(dayStart) },
      select: ['tokensIn', 'tokensOut'],
    });
    return rows.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0);
  }

  /* -------------------------------- chat --------------------------------- */

  private toView(m: AssistantMessageEntity): AssistantMessageView {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
      meta: {
        provider: m.provider || undefined,
        cached: m.cached || undefined,
        redacted: m.redacted || undefined,
        scopeRedirected: m.scopeRedirected || undefined,
        tokensIn: m.tokensIn || undefined,
        tokensOut: m.tokensOut || undefined,
      },
    };
  }

  async history(userId: string, phaseStateId: string, conversationScope: 'project' | 'lesson' = 'project'): Promise<AssistantMessageView[]> {
    // Reading one's own saved conversation does not unlock project work.
    await this.loadPhaseFor(userId, phaseStateId, true);
    const rows = await this.messages.find({
      where: { userId, phaseStateId, conversationScope, provider: Not(In(USAGE_ONLY_PROVIDERS)) },
      order: { createdAt: 'ASC' },
      take: TRANSCRIPT_PAGE_SIZE,
    });
    return rows.map((m) => this.toView(m));
  }

  async lessonHistory(userId: string, phaseStateId: string): Promise<AssistantMessageView[]> {
    return this.history(userId, phaseStateId, 'lesson');
  }

  /**
   * The learner's row supplies class dates and the instructor notes the
   * mentor may quote.
   */
  private async loadPhaseFor(
    userId: string,
    phaseStateId: string,
    lesson = false,
  ): Promise<{
    state: PhaseStateEntity;
    phase: PhaseContent;
    enrollment: EnrollmentEntity;
    learner: Pick<UserEntity, 'id' | 'cohort'>;
  }> {
    const state = await this.phaseStates.findOne({ where: { id: phaseStateId } });
    if (!state) throw new NotFoundException('phase not found');
    if (state.userId !== userId) throw new ForbiddenException('not your phase');
    if (!lesson && state.status === 'locked') throw new ForbiddenException('phase is locked');
    const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId });
    const learner = await this.users.findOne({
      where: { id: userId },
      select: ['id', 'cohort'],
    });
    // The row is only ever missing when the account has been deleted while a
    // signed token for it is still in someone's browser.
    if (!learner) throw new UnauthorizedException('this account no longer exists');
    // A release date holds a phase shut whatever the row says, and this door
    // must hold it too, or the mentor answers, and bills, on a phase the class
    // has not opened. The same helpers as `WorkflowService.requireUnlocked`,
    // so the refusal is the same sentence.
    const opensAt = (
      await scheduleForCohort(this.phaseStates.manager, learner.cohort, enrollment.projectSlug)
    ).get(state.phaseKey)?.opensAt;
    if (!lesson && opensAt && scheduledShut(opensAt)) throw new ForbiddenException(opensAtMessage(opensAt));
    // The mentor's phase context and its redaction set come from the
    // enrolment's pinned version. The set of sealed paths is a property of the version, so a
    // mentor reading the head's would be redacting against a phase the learner
    // is not on.
    const phase = this.content.getPhaseForEnrollment(enrollment, state.phaseKey);
    return { state, phase, enrollment, learner };
  }

  /**
   * The unfinished functions in the learner's files, memoised on the exact
   * bytes they were read from.
   *
   * This is a regular-expression pass over every line of every editable file,
   * and its result is part of the cache key, so it runs before the cache is
   * even consulted; the memo spares a learner asking the same question twice
   * from paying for it twice. The key is a hash of the sources themselves, not of a revision
   * number, so a pack edit, an autosave and a revision restore all land on a
   * different entry by construction: the memo cannot go stale, only unused.
   * Bounded, and cleared rather than evicted one by one, because it is an
   * optimisation and not a store.
   */
  private readonly todoMemo = new Map<string, string[]>();
  private scans = 0;

  /** How many times the workspace has actually been scanned rather than remembered. */
  get workspaceScans(): number {
    return this.scans;
  }

  private todosRemainingFor(state: PhaseStateEntity, phase: PhaseContent): string[] {
    if (phase.checks.kind !== 'code' && phase.checks.kind !== 'tests') return [];
    // Merging the pack's files with the learner's is a record spread; the
    // expensive part below is the line-by-line match, and that is what the
    // memo is for.
    const files = this.content.executionFiles(phase, state.workspace);
    const targets =
      phase.checks.kind === 'code' ? phase.checks.editableTargets : phase.checks.learnerTestFiles;
    const sources = targets.map((target) => files[target] || '');
    const stamp = createHash('sha256')
      .update([phase.key, ...sources].join('\u0000'))
      .digest('hex');
    const remembered = this.todoMemo.get(stamp);
    if (remembered) return remembered.slice();

    this.scans += 1;
    const todos: string[] = [];
    for (const source of sources) {
      let currentDef = '';
      for (const line of source.split('\n')) {
        // a Python `def name(` or a JS class method `name(...) {`, the
        // keyword guard keeps `if (...) {` from being mistaken for a method
        const def = line.match(
          /^\s*(?:def\s+(\w+)|(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)(\w+)\s*\([^)]*\)\s*\{)/,
        );
        if (def) currentDef = def[1] || def[2];
        if (/TODO\(learner\)|NotImplementedError|not implemented/.test(line) && currentDef) {
          if (!todos.includes(currentDef)) todos.push(currentDef);
        }
      }
    }
    if (this.todoMemo.size >= TODO_MEMO_MAX) this.todoMemo.clear();
    this.todoMemo.set(stamp, todos);
    return todos.slice();
  }

  private async signalsFor(state: PhaseStateEntity, phase: PhaseContent): Promise<MentorSignals> {
    const signals: MentorSignals = {
      todosRemaining: this.todosRemainingFor(state, phase),
      lastFailedChecks: [],
    };

    const last = await this.submissions.find({
      where: { phaseStateId: state.id, status: 'completed' },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    if (last.length && last[0].report) {
      signals.lastFailedChecks = last[0].report.checks
        .filter((c) => c.status === 'failed')
        .slice(0, 2)
        .map((c) => c.label);
    }
    return signals;
  }

  /**
   * The learner's adaptive-difficulty tier for this enrollment: mastery
   * (high scores, low reliance) earns terser, deeper hints; struggling or
   * over-reliant learners get fuller scaffolding.
   */
  private async tierFor(passed: PhaseStateEntity[]): Promise<DifficultyTier> {
    if (passed.length === 0) return 'standard';
    const avgScore = Math.round(
      passed.reduce((s, p) => s + (p.bestScore ?? 0), 0) / passed.length,
    );
    // One GROUP BY over every passed phase, not one COUNT per phase. A COUNT
    // per phase grows with the learner's progress, so the mentor would get
    // slower the further into the project they were, a per-turn cost, paid
    // before the reply cache is even consulted.
    const hints = await hintsByPhaseState(this.messages.manager, passed.map((p) => p.id));
    const relianceTotal = passed.reduce(
      (sum, p) => sum + relianceIndex(hints.get(p.id) ?? 0, p.attempts),
      0,
    );
    const reliance = Math.round(relianceTotal / passed.length);
    return difficultyTier(avgScore, reliance, passed.length);
  }

  /**
   * What the mentor carries into this reply out of the phases the learner has
   * already finished.
   *
   * Built lazily, here, on the next question, never at merge. Building it
   * here keeps it out of `advance()` in workflow.service.ts and needs only the
   * repositories this service already injects.
   * The write is `update()` rather than `save()` for the same reason
   * `saveWorkspace` uses one: a whole-row save from the chat path would post a
   * stale `currentPhaseOrder` over a merge that landed mid-request.
   *
   * The passed phases are handed in rather than read here: `tierFor`
   * wants the same rows in the same order, and two identical `SELECT`s per
   * turn is one more than a cached reply should cost.
   */
  private async memoryFor(
    enrollment: EnrollmentEntity,
    passed: PhaseStateEntity[],
  ): Promise<MentorMemoryView | null> {
    const current = enrollment.mentorMemory ?? null;
    if (passed.length === 0) return null;
    if (current && current.builtThrough >= passed.length) return current;

    const inputs: PassedPhaseInput[] = [];
    for (const state of passed) {
      const last = await this.submissions.find({
        where: { phaseStateId: state.id, status: 'completed' },
        order: { createdAt: 'DESC' },
        take: 1,
      });
      // The Maintenance line names the change request by its ticket, read from the learner's pinned phase.
      const checks = state.phaseKey === 'maintenance' ? this.content.getPhaseForEnrollment(enrollment, state.phaseKey).checks : null;
      inputs.push({
        phaseKey: state.phaseKey,
        phaseOrder: state.phaseOrder,
        workspace: state.workspace,
        report: last[0]?.report ?? null,
        ...(checks ? { ticketId: checks.kind === 'code' ? checks.ticket?.id ?? null : null } : {}),
      });
    }
    // What the mentor would not answer is worth remembering too: it is the one
    // thing in a transcript that is still open.
    const declinedRows = await this.messages.find({
      where: { userId: enrollment.userId, role: 'user' },
      order: { createdAt: 'DESC' },
      take: MEMORY_QUESTION_SCAN,
    });
    const withheld = await this.messages.find({
      where: { userId: enrollment.userId, role: 'assistant', redacted: true },
      order: { createdAt: 'DESC' },
      take: MEMORY_WITHHELD_SCAN,
    });
    const declined: string[] = [];
    for (const reply of withheld) {
      const asked = declinedRows.find(
        (row) => row.phaseStateId === reply.phaseStateId && stampOf(row) <= stampOf(reply),
      );
      if (asked) declined.push(asked.content);
    }

    const memory = buildMemory(inputs, declined);
    await this.enrollments.update(enrollment.id, { mentorMemory: memory });
    enrollment.mentorMemory = memory;
    return memory;
  }

  /**
   * What makes two questions the same question. Everything that changes the
   * answer belongs here: the phase, the words, the workspace the words are
   * about, and the mentor, the model and the difficulty tier. Without those
   * three, one provider's or model's replies would still be served after the
   * deployment moved to another, and a learner who had earned terser hints
   * would get someone else's fuller ones.
   */
  private cacheKey(
    phase: PhaseContent,
    message: string,
    signals: MentorSignals,
    difficultyOffset: number,
    memory: MentorMemoryView | null,
    noteStamps: string[],
    // The failing test this turn is about, or undefined for a
    // question the learner typed.
    failingTest: FailingTestContext | undefined,
    // The pack. Two packs can share a phase key and nothing else.
    projectSlug: string,
    workspaceDigest = '',
    // The scope the prompt is composed under. TaskTrackr's identity is its
    // fixed reference JSON; a teacher's phase keys its own replies.
    scope?: PhaseScope,
  ): string {
    const normalized = message.toLowerCase().replace(/\s+/g, ' ').trim();
    const block = memoryBlock(memory);
    return createHash('sha256')
      .update(
        [
          phase.key,
          normalized,
          signals.todosRemaining.join(','),
          signals.lastFailedChecks.join(','),
          this.activeProviderName(),
          this.openaiProvider.available ? config.openaiModel : '',
          String(difficultyOffset),
          // Memory and notes. Both of these change the reply, so both belong in the
          // key. Without the first, a learner in phase 4 is served the phase-2
          // answer to the same words; without the second, an edited note
          // reaches nobody until the 24-hour TTL runs out. The cost is a cold
          // cache for that class after a note is edited, which is the intent.
          String(memory?.builtThrough ?? 0),
          block ? createHash('sha256').update(block).digest('hex').slice(0, 12) : '',
          noteStamps.join(','),
          // The failing test. Appended after the others so their positions stay fixed.
          // Two different failures of the same test, and the same failure
          // after the learner has edited the file, are different questions,
          // and a cached answer about the previous assertion would be worse
          // than no answer at all. The empty string for an ordinary chat turn
          // is deliberate: appending only when present would make the key
          // ambiguous between "no failing test" and "an empty one".
          failingTest
            ? createHash('sha256')
                .update(
                  [
                    failingTest.name,
                    failingTest.assertion,
                    `${failingTest.path ?? ''}:${failingTest.line ?? 0}`,
                    failingTest.excerpt,
                  ].join(' '),
                )
                .digest('hex')
                .slice(0, 16)
            : '',
          // The pack slug, appended last for the same reason. `phase.key` is the phase
          // ('requirements'), and every pack has one: without the slug a
          // second pack's learner reads a reply written against the first
          // pack's prompt and redacted against the first pack's solution.
          projectSlug,
          this.openaiProvider.name,
          mentorInstructionIdentity(phase, scope),
          workspaceDigest,
        ].join('|'),
      )
      .digest('hex');
  }

  /** A reply older than the TTL is not an answer for today. */
  private cacheEntryExpired(entry: AiCacheEntity, now: number = Date.now()): boolean {
    const created =
      entry.createdAt instanceof Date
        ? entry.createdAt.getTime()
        : Date.parse(String(entry.createdAt));
    if (!Number.isFinite(created)) return true;
    return now - created > aiCacheTtlMs();
  }

  /**
   * Drop every cache row past its TTL.
   *
   * Two windows with two jobs, and they are meant to differ: this one is
   * freshness, so a reply written before a content or guardrail change is
   * never served again, and `RetentionService.pruneAiCache` is size, keeping
   * a month of rows nobody asked for twice. Call it from a script when a pack
   * changes mid-term.
   */
  async sweepAiCache(now: Date = new Date()): Promise<number> {
    const result = await this.cache.delete({
      createdAt: LessThan(new Date(now.getTime() - aiCacheTtlMs())),
    });
    return result.affected ?? 0;
  }

  /**
   * One mentor turn. In `extra`, a caller that is not
   * the chat box (the explain route) hands over the failing test the question
   * is about, and every rule below applies to it unchanged.
   */
  @TrackedAiOperation('guided')
  async chat(
    userId: string,
    phaseStateId: string,
    rawMessage: string,
    extra: ChatExtra = {},
  ): Promise<AssistantChatResponse> {
    const loaded = await this.loadPhaseFor(userId, phaseStateId, extra.lesson === true);
    const { state, enrollment, learner } = loaded;
    // Whose content this is, decided on the phase as the version
    // serves it and on the version's own task list, **before** the lesson
    // wrap below, which empties `files` and extends the prompt and would make
    // every TaskTrackr lesson look like a teacher's.
    const scope = phaseScopeOf(loaded.phase, this.pinnedTasks(enrollment, state.phaseKey), { lesson: extra.lesson === true });
    const phase = extra.lesson ? { ...loaded.phase, files: [], assistant: { ...loaded.phase.assistant, systemPrompt: `${loaded.phase.assistant.systemPrompt}\n${LESSON_SENTENCE}` } } : loaded.phase;
    const message = sanitizeMessage(rawMessage);
    // Preserve private conversation order across simultaneous learner turns.
    return this.serialise(userId, () =>
      this.answer(userId, state, phase, enrollment, learner, message, extra, scope),
    );
  }

  /**
   * The pinned version's task list for a phase, or undefined when it cannot be
   * read, in which case `phaseScopeOf` falls back to the phase's sole task,
   * which is TaskTrackr's only when the bytes are.
   */
  private pinnedTasks(enrollment: EnrollmentEntity, phaseKey: string): CompiledTask[] | undefined {
    return readableTasks(() => this.content.getTasksForEnrollment(enrollment, phaseKey));
  }

  private async answer(
    userId: string,
    state: PhaseStateEntity,
    phase: PhaseContent,
    enrollment: EnrollmentEntity,
    learner: Pick<UserEntity, 'id' | 'cohort'>,
    message: string,
    extra: ChatExtra,
    scope?: PhaseScope,
  ): Promise<AssistantChatResponse> {
    /**
     * The learner's turn and the reviewer's, written together.
     *
     * `counted: false` writes the reviewer's turn alone. A hint is a
     * `role: 'user'` row, that is the definition `hintsByPhaseState`
     * in `analytics/queries.ts` and the web's `questionsAsked` all share, so a
     * turn that must not be charged is a turn with no user row. Only one thing
     * uses it: an explanation the product asked for that could not be given.
     */
    const persistPair = async (
      fields: Partial<AssistantMessageEntity>,
      { counted = true }: { counted?: boolean } = {},
    ): Promise<AssistantMessageEntity> => {
      const conversationScope = extra.lesson ? 'lesson' : 'project';
      const last = await this.messages.findOne({ where: { userId, phaseStateId: state.id }, order: { createdAt: 'DESC' } });
      const timestamp = Math.max(Date.now(), last ? new Date(last.createdAt).getTime() + 1 : 0);
      if (counted) {
        await this.messages.save(
          this.messages.create({
            userId,
            enrollmentId: enrollment.id,
            phaseStateId: state.id,
            phaseKey: state.phaseKey,
            role: 'user',
            conversationScope,
            createdAt: new Date(timestamp),
            content: message,
            tokensIn: 0,
            tokensOut: 0,
          }),
        );
      }
      return this.messages.save(
        this.messages.create({
          userId,
          enrollmentId: enrollment.id,
          phaseStateId: state.id,
          phaseKey: state.phaseKey,
          role: 'assistant',
          conversationScope,
          createdAt: new Date(timestamp + 1),
          ...fields,
        }),
      );
    };

    const spent = await this.tokensToday(userId);

    /**
     * The meter as this turn found it. A reply that bills nothing, every
     * guardrail refusal and every cache hit, cannot have moved it, so it is
     * reported from the number already in hand rather than by scanning the
     * day's messages a second time.
     */
    const meter = () => ({ todayTokens: spent });
    /** The meter after this turn billed something, which does need the re-read. */
    const meterAfterSpend = async () => ({
      todayTokens: await this.tokensToday(userId),
    });

    // 1 · phase-scope guardrail
    //
    // A failing test in this phase's own report is on this phase's
    // topic by construction. The redirect is for a learner asking about a
    // phase they have not reached, and a case named `test_raises_on_missing`
    // is not that.
    const offPhase = extra.failingTest ? null : detectOffPhase(message, state.phaseKey);
    if (offPhase) {
      const reply = await persistPair({
        content: offPhaseReply(offPhase, phase.title),
        provider: 'guardrail',
        scopeRedirected: true,
      });
      return { reply: this.toView(reply), usage: meter() };
    }

    // 2 · everything the cache key is made of, and nothing else.
    //
    // These four decide which answer this question has, so they cannot be
    // deferred past the lookup. The fifty-row history and the topic pass over
    // it decide only how the *prompt* reads, and a cache hit never reaches a
    // prompt, so they wait in `contextFor` below until something is actually
    // going to send one.
    //
    // Memory is derived from the learner's own artefacts, so it is
    // learner data and rides in the user turn; the notes are staff writing, so
    // they go in the system message under an explicit precedence line.
    const signals = extra.lesson ? { todosRemaining: [], lastFailedChecks: [] } : await this.signalsFor(state, phase);
    const passed = await this.phaseStates.find({
      where: { enrollmentId: enrollment.id, status: 'passed' },
      order: { phaseOrder: 'ASC' },
    });
    const memory = extra.lesson ? null : await this.memoryFor(enrollment, passed);
    const notes = await this.notes.forMentor(
      learner.cohort ?? '',
      enrollment.projectSlug,
      state.phaseKey,
    );
    const difficultyOffset = tierHintOffset(await this.tierFor(passed));

    // Private conversation context is bounded and excluded from teacher projections.
    const recentTurns = (await this.messages.find({
      where: { userId, phaseStateId: state.id, conversationScope: extra.lesson ? 'lesson' : 'project', provider: Not(In(USAGE_ONLY_PROVIDERS)) },
      order: { createdAt: 'DESC', id: 'DESC' }, take: MENTOR_HISTORY_TURNS,
    })).reverse().map(turn => ({ role: turn.role, content: turn.content }));

    /** The prompt's context: built on a miss, and for the withheld answer. */
    const contextFor = async (): Promise<MentorContext> => {
      const priorUserMessages = await this.messages.find({
        where: { userId, phaseStateId: state.id, role: 'user', conversationScope: extra.lesson ? 'lesson' : 'project' },
        order: { createdAt: 'ASC' },
        take: LADDER_QUESTION_SCAN,
      });
      const topicUseCounts: Record<number, number> = {};
      for (const prior of priorUserMessages) {
        const idx = this.localProvider.matchTopic({
          phase,
          message: prior.content,
          interactionCount: 0,
          topicUseCounts: {},
          signals,
          // Counted on the same ladder the reply climbs.
          ...(scope ? { scope } : {}),
        });
        if (idx !== null) topicUseCounts[idx] = (topicUseCounts[idx] || 0) + 1;
      }
      return {
        phase,
        message,
        history: recentTurns,
        workspace: extra.lesson ? undefined : editableFiles(phase, state.workspace),
        interactionCount: priorUserMessages.length,
        topicUseCounts,
        signals,
        difficultyOffset,
        memory,
        instructorNotes: notes.map((note) => note.text),
        // The whole subject of an explain-route question, and the block
        // the prompt puts behind the learner-data fence.
        failingTest: extra.failingTest,
        // Resolved before the lesson wrap, in `chat`.
        ...(scope ? { scope } : {}),
      };
    };

    // 3 · answer-withholding: an outright solution request gets a guarded hint
    //     in question form, never the deepest rung of the hint ladder, which
    //     is the closest thing to an answer the bundle contains
    if (isSolutionRequest(message)) {
      const hint = await this.localProvider.questionHint(await contextFor());
      const content = `${solutionRequestPreamble()}\n\n${hint.content}`;
      const reply = await persistPair({
        content,
        provider: 'guardrail',
        redacted: true,
        tokensIn: hint.tokensIn,
        tokensOut: hint.tokensOut,
      });
      return { reply: this.toView(reply), usage: await meterAfterSpend() };
    }

    // 4 · response cache (guardrail metadata replays with the content)
    //
    // Only a model's reply is worth keeping. The local mentor's answer is a
    // rung on a ladder chosen by how far this learner has already climbed it;
    // a cached rung would be replayed to the next learner's first question,
    // possibly the deepest one, which the solution-request path deliberately
    // never hands out, and to this learner's repeat of an earlier question,
    // in place of the next rung. It costs nothing to compute, so it is not
    // cached and not looked up.
    const cacheable = this.openaiProvider.available;
    const key = this.cacheKey(
      phase,
      message,
      signals,
      difficultyOffset,
      memory,
      notes.map((note) => `${note.id}:${stampOf(note)}`),
      extra.failingTest,
      enrollment.projectSlug,
      createHash('sha256').update(JSON.stringify({ userId, model: config.openaiModel, reasoningEffort: config.openaiReasoningEffort, files: editableEntries(phase, state.workspace), history: recentTurns })).digest('hex'),
      scope,
    );
    const hit = cacheable ? await this.cache.findOne({ where: { cacheKey: key } }) : null;
    // A cached withheld-reply notice for a failing-test explanation would
    // replay for the whole TTL, so it is treated as a miss and answered again.
    const staleWithheld = Boolean(
      hit && extra.failingTest && hit.content === WITHHELD_REPLY_NOTICE,
    );
    if (hit && !staleWithheld && !this.cacheEntryExpired(hit)) {
      const reply = await persistPair({
        content: hit.content,
        provider: hit.provider,
        cached: true,
        redacted: hit.redacted,
      });
      return { reply: this.toView(reply), usage: meter() };
    }
    if (hit) await this.cache.delete({ cacheKey: key });

    const ctx = await contextFor();

    // Provider outages are visible and never replaced by a simulated conversation.
    if (!this.openaiProvider.available) throw new ServiceUnavailableException('AI mentor is not configured. Your work is saved; configure the provider to continue.');
    let generated: ProviderReply;
    let explanationWithheld = false;
    try {
      generated = await this.openaiProvider.chat(ctx);
      if (!generated.content.trim()) throw new Error('Empty mentor reply');
    } catch (error) {
      if (error instanceof ProviderUsageError) await this.recordReviewUsage(state, this.openaiProvider.name, error.tokensIn, error.tokensOut);
      this.logger.warn('AI mentor provider failed; no simulated reply was recorded');
      if (error && typeof error === 'object' && 'guidedReplyUnavailable' in error) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: 'GUIDED_REPLY_WITHHELD',
          message: 'The mentor could not produce a reply that passed its teaching checks. No reply was shown. This is not a judgment of your work; please retry.',
        });
      }
      // The AI gate turned this reply away after its wait: the class is busy, and its sentence says so.
      if (error instanceof AiBusyError) throw error;
      throw new ServiceUnavailableException('The AI mentor could not respond. Your work is saved. Please retry.');
    }

    // 5 · output guardrail: redact solution reproductions, long code blocks,
    //     and prose replies that amount to the finished artefact
    // Every sealed source of every executable kind, a code phase's reference
    // answer and hidden suites, a tests phase's own suites, the implementation
    // it grades against and its mutants, a config phase's smoke files and
    // drill, not a code phase's answer alone. Less every line the learner is
    // served or wrote: quoting the
    // learner's own screen back is not a leak.
    const solutionSources = sealedRedactionSources(phase.checks, {
      files: phase.files,
      workspace: editableFiles(phase, state.workspace),
    });
    let { content, redacted } = redactSolutions(generated.content, solutionSources);
    // Every phase kind, not the two prose ones: a model asked for a Dockerfile,
    // a CI workflow or a test suite writes the finished artefact just as
    // readily, and the phase kind it happens in does not make it a hint.
    const artifactCheck = redactArtifactLikeReply(content);
    if (artifactCheck.redacted) {
      content = artifactCheck.content;
      redacted = true;
    }

    /**
     * An explanation the product asked for.
     *
     * The explain button writes the question itself, so a model draft the
     * output guardrail eats whole leaves the learner holding a refusal to a
     * question they never asked. The learner gets the fixed withheld-explanation
     * notice instead, from the guardrail, and the turn is not counted as a hint.
     *
     * The model's draft was never shown, so it is not written to the cache
     * either; `explanationWithheld` is exactly that rule.
     */
    let provider = generated.provider;
    let counted = true;
    if (extra.failingTest && content === WITHHELD_REPLY_NOTICE) {
      content = EXPLAIN_WITHHELD_NOTICE;
      provider = 'guardrail';
      explanationWithheld = true;
      counted = false;
    }

    if (cacheable && !explanationWithheld) {
      try {
        await this.cache.save(
          this.cache.create({ cacheKey: key, content, provider, redacted }),
        );
      } catch (err) {
        // Two learners asking the same thing at the same moment both miss the
        // cache and both insert; the unique index settles it. Rethrown, the
        // loser would take a 500 with neither message row written, because
        // persistPair runs after this. Read the winner instead, so both see one
        // answer.
        if (!isUniqueViolation(err)) throw err;
        const winner = await this.cache.findOne({ where: { cacheKey: key } });
        if (winner) {
          content = winner.content;
          redacted = winner.redacted;
        }
        this.logger.log(
          `an identical question was cached concurrently (${key.slice(0, 12)}); keeping the first`,
        );
      }
    }

    const reply = await persistPair(
      {
        content,
        provider,
        redacted,
        // The spend happened upstream whatever the guardrail then made of the
        // draft, so it stays on the ledger.
        tokensIn: generated.tokensIn,
        tokensOut: generated.tokensOut,
      },
      { counted },
    );
    return { reply: this.toView(reply), usage: await meterAfterSpend() };
  }

  /* ------------------------------- reviews ------------------------------- */

  /**
   * Rubric review for one submission. Rate limits and execution concurrency
   * govern admission; usage is diagnostic. On provider failure the verdict
   * remains closed and no authored fallback grants approval.
   */
  @TrackedAiOperation('grading')
  async reviewSubmission(
    phase: PhaseContent,
    state: PhaseStateEntity,
    input: ReviewInput,
  ): Promise<AiRubricReview> {
    // Teacher-authored projects: the synthesis answers the rubric
    // the gate will count it against. `strictTaskEvidencePassed` compares
    // `criteriaEvidence` to the **task's** criteria key for key, and a
    // teacher-created task's rubric is derived from its own rules, so a
    // phase-shaped synthesis here would not even be the right length. For a
    // sole task `input.task.rubric` *is* `phase.rubric`, and a caller naming no
    // task gets the phase's.
    const rubric = input.task?.rubric ?? phase.rubric;
    // A review the AI gate refused says to resubmit shortly, not to wait for the provider.
    const unavailable = (reason: string, busy = false): AiRubricReview => {
      const nextStep = busy ? 'Resubmit in a minute.' : 'Retry assessment when the provider is available.';
      return {
        summary: 'Needs revision: AI assessment could not be completed.',
        strengths: [], improvements: [reason], processNote: `No approval was granted. ${busy ? 'Resubmit in a minute.' : 'Resubmit when assessment is available.'}`,
        provider: 'unavailable', verdict: 'needs_revision', assessmentError: reason,
        criteriaEvidence: rubric.criteria.map(c => ({ key: c.key, met: false, evidence: 'Semantic assessment unavailable.', issue: reason, nextStep })),
      };
    };
    if (!this.openaiProvider.available) return unavailable('Configure the AI provider before requesting an assessed verdict.');
    // One ask: its spend billed whatever came back, and a refusal logged and
    // classified by `assessmentFailure`.
    const ask = async (reask?: ReviewReask) => {
      try {
        const { tokensIn, tokensOut, ...review } = await this.openaiProvider.review(phase, input, reask);
        await this.recordReviewUsage(state, review.provider, tokensIn, tokensOut);
        return { review };
      } catch (error) {
        if (error instanceof ProviderUsageError) await this.recordReviewUsage(state, this.openaiProvider.name, error.tokensIn, error.tokensOut);
        const failure = assessmentFailure(error);
        this.logger.warn(`AI assessment ${failure.code}; phase=${phase.key}; state=${state.id}; ${failure.detail}; verdict remains closed`);
        return { failure, contradiction: failure.code === 'invalid_evidence' ? reviewContradictionOf(error) : null };
      }
    };
    // Both asks run inside this one place in the learner's queue, so the
    // learner still holds one AI slot at a time and makes one review.
    return this.serialise(state.userId, async () => {
      const started = Date.now();
      const first = await ask();
      if (first.review) return first.review;
      // An answer that contradicts its own criterion evidence (and only that)
      // is asked about once more, the contradiction named in fixed copy and
      // rubric keys. The second answer meets the same checks; if it fails
      // them, or anything else fails, the review stays unavailable with the
      // first refusal's sentence. Never a third ask.
      if (!first.contradiction) return unavailable(first.failure.learnerMessage, first.failure.code === 'provider_busy');
      // The review's own bound: a review has one call's OPENAI_TIMEOUT_MS of
      // model time, so the second ask runs only inside that same window from
      // the first ask, and only with REVIEW_REASK_FLOOR_MS of it left.
      const remaining = started + openaiTimeoutMs() - Date.now();
      if (remaining < REVIEW_REASK_FLOOR_MS) {
        this.logger.warn(`grading_assessment_reask_skipped phase=${phase.key} cause=invalid_evidence remaining_ms=${Math.max(0, remaining)}`);
        return unavailable(first.failure.learnerMessage);
      }
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error(REVIEW_REASK_DEADLINE)), remaining);
      try {
        const second = await ask({ contradiction: first.contradiction, signal: deadline.signal });
        this.logger.warn(`grading_assessment_reasked phase=${phase.key} cause=invalid_evidence outcome=${second.review ? 'ok' : 'still_invalid'}`);
        return second.review ?? unavailable(first.failure.learnerMessage);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Bill review spend to the same ledger the chat path writes to, so one meter
   * covers both AI paths and tokensToday() counts it.
   */
  async recordReviewUsage(
    state: PhaseStateEntity,
    provider: string,
    tokensIn: number,
    tokensOut: number,
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        userId: state.userId,
        enrollmentId: state.enrollmentId,
        phaseStateId: state.id,
        phaseKey: state.phaseKey,
        role: 'assistant',
        provider: REVIEW_USAGE_PROVIDER,
        content: `AI provider usage reported by ${provider}.`,
        tokensIn,
        tokensOut,
      }),
    );
  }
}
