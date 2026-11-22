import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import { ForbiddenException, Logger } from '@nestjs/common';
import {
  AiCacheEntity,
  ALL_ENTITIES,
  AssistantMessageEntity,
  CohortEntity,
  CohortPhaseScheduleEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SettingEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { NotesService } from '../instructor/notes.service';
import { opensAtMessage } from '../instructor/schedule.service';
import {
  AssistantService,
  INTERVIEW_USAGE_PROVIDER,
  REVIEW_USAGE_PROVIDER,
} from './assistant.service';
import { LocalMentorProvider } from './local.provider';
import { OpenAiProvider } from './openai.provider';
import { AI_BUSY_MESSAGE, AiBusyError } from '../execution/run-gate';
import { AI_REVIEW_BUSY_MESSAGE } from '@learnsdlc/shared';
import * as providerModule from './openai.provider';
import { GUIDED_REVIEW_KEYS } from './guided-review';
import type { ReviewInput } from './provider.types';
import { reviewReaskNote, withReviewContradiction } from './review-reask';

/**
 * The orchestrator's two fallbacks, a provider that throws on chat, a
 * provider that answers a review with something other than JSON, are the
 * paths a class actually takes the first afternoon OpenAI has a bad hour, so
 * they are the paths this file drives.
 */

/** What OpenAiProvider looks like from the service's side of the function Object() { [native code] }. */
interface FakeOpenAi {
  available: boolean;
  name: string;
  chat?: jest.Mock;
  review?: jest.Mock;
}

/** A completion in the shape fetch hands back, for the tests that use the real provider. */
const completion = (content: string, tokensIn = 12, tokensOut = 34): Response =>
  ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
    }),
    text: async () => content,
  }) as unknown as Response;

const failure = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  ({
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => body,
  }) as unknown as Response;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('AssistantService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let local: LocalMentorProvider;
  let notes: NotesService;
  let phase: PhaseContent;

  let userId = '';
  let enrollmentId = '';
  let state: PhaseStateEntity;

  const realFetch = global.fetch;
  const realKey = config.openaiApiKey;

  const manager = () => dataSource.manager;
  const messages = () => dataSource.getRepository(AssistantMessageEntity);
  const caches = () => dataSource.getRepository(AiCacheEntity);
  const settings = () => dataSource.getRepository(SettingEntity);

  const build = (openai: FakeOpenAi | OpenAiProvider): AssistantService =>
    new AssistantService(
      dataSource.getRepository(AssistantMessageEntity),
      dataSource.getRepository(AiCacheEntity),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(SubmissionEntity),
      content,
      local,
      openai as unknown as OpenAiProvider,
      // The notes the mentor may quote to this learner's class.
      notes,
    );

  const offline: FakeOpenAi = { available: false, name: 'openai' };
  /** Model substitute for context transport tests; not real-provider quality coverage. */
  const contextual = (): FakeOpenAi => ({ available: true, name: 'mock-ai', chat: jest.fn(async ctx => ({ ...await local.chat(ctx), provider: 'mock-ai' })) });

  /**
   * A model that answers at once. The cost tests below measure a cache hit,
   * and only a model's reply is cached: the local mentor's is a rung
   * chosen by how far the learner has climbed, so it is answered fresh.
   */
  const answering = (): FakeOpenAi => ({
    available: true,
    name: 'openai',
    chat: jest.fn().mockResolvedValue({
      content: 'Which outcome would you check first?',
      tokensIn: 3,
      tokensOut: 6,
      provider: 'openai',
    }),
  });

  const reviewInput: ReviewInput = {
    criteria: [
      { title: 'Clarity', score: 82 },
      { title: 'Testability', score: 61 },
    ] as never,
    checks: [
      { status: 'passed', label: 'Every story has a persona', detail: 'three of three' },
      { status: 'failed', label: 'Criteria are checkable', detail: 'US-2 has no observable outcome' },
    ] as never,
    overall: 74,
    hints: 2,
    ranBeforeSubmit: true,
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    local = new LocalMentorProvider();
    notes = new NotesService(dataSource);
    phase = content.getPhase('tasktrackr', 'requirements');
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    delete process.env.AI_CACHE_TTL_HOURS;
    delete process.env.AI_USAGE_TIMEZONE;
    delete process.env.AI_MAX_CONCURRENCY;

    const user = await manager().save(
      manager().create(UserEntity, {
        email: 'lee@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'Lee',
      }),
    );
    userId = user.id;
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
      }),
    );
    enrollmentId = enrollment.id;
    let first: PhaseStateEntity | null = null;
    for (const p of content.getProject('tasktrackr').phases) {
      const row = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId,
          userId,
          phaseKey: p.key,
          phaseOrder: p.order,
          status: p.order === 1 ? 'in_progress' : 'locked',
          attempts: 0,
        }),
      );
      if (p.order === 1) first = row;
    }
    state = first as PhaseStateEntity;
  });

  afterEach(() => {
    global.fetch = realFetch;
    config.openaiApiKey = realKey;
    delete process.env.OPENAI_TIMEOUT_MS;
  });

  /* --------------------- what a cached reply costs ------------------------- */

  /**
   * The cache must be consulted first: otherwise `signalsFor` re-parses every
   * editable file, a fifty-row history comes back, a topic pass runs over it
   * and `tierFor` issues one COUNT per passed phase, all before the lookup
   * that makes the whole thing unnecessary, and the last of those grows as
   * the learner gets further into the project.
   */
  describe('what a cached reply costs', () => {
    const phaseStates = () => dataSource.getRepository(PhaseStateEntity);

    /** Every statement the driver issued while `run` was in flight. */
    const queriesDuring = async (run: () => Promise<unknown>): Promise<string[]> => {
      const connection = dataSource as unknown as { logger: Record<string, unknown> };
      const original = connection.logger;
      const seen: string[] = [];
      const spy = Object.create(original) as Record<string, unknown>;
      spy.logQuery = (query: unknown, ...rest: unknown[]) => {
        seen.push(String(query));
        (original.logQuery as ((...a: unknown[]) => void) | undefined)?.call(
          original,
          query,
          ...rest,
        );
      };
      connection.logger = spy;
      try {
        await run();
      } finally {
        connection.logger = original;
      }
      return seen;
    };

    /** The learner is mid-project: these phases are behind them, each with a hint on it. */
    const passPhases = async (keys: string[]): Promise<void> => {
      for (const key of keys) {
        const row = await phaseStates().findOneByOrFail({ enrollmentId, phaseKey: key as never });
        await phaseStates().update(row.id, { status: 'passed', bestScore: 80, attempts: 2 });
        await messages().save(
          messages().create({
            userId,
            enrollmentId,
            phaseStateId: row.id,
            phaseKey: row.phaseKey,
            role: 'user',
            content: 'where do I start?',
            tokensIn: 0,
            tokensOut: 0,
          }),
        );
      }
    };

    /** A code phase, so the editable-file scan actually has something to scan. */
    const openImplementation = async (): Promise<PhaseStateEntity> => {
      const row = await phaseStates().findOneByOrFail({
        enrollmentId,
        phaseKey: 'implementation' as never,
      });
      await phaseStates().update(row.id, {
        status: 'in_progress',
        workspace: {
          'tasktrackr/manager.py':
            'class TaskManager:\n' +
            '    def add(self, title):\n' +
            '        raise NotImplementedError  # TODO(learner)\n' +
            '\n' +
            '    def overdue(self, today):\n' +
            '        raise NotImplementedError  # TODO(learner)\n',
        },
      });
      return phaseStates().findOneByOrFail({ id: row.id });
    };

    it('does not cost more as the learner gets further into the course', async () => {
      const service = build(answering());
      const work = await openImplementation();
      const question = 'How should I decide what add() returns?';

      await passPhases(['requirements']);
      await service.chat(userId, work.id, question); // miss: warms the cache and the memory
      const oneBehind = await queriesDuring(() => service.chat(userId, work.id, question));

      await passPhases(['design', 'testing', 'deployment']);
      await service.chat(userId, work.id, question); // the tier and the memory moved, so re-warm
      const fourBehind = await queriesDuring(() => service.chat(userId, work.id, question));

      // The reliance index is one grouped query, not one COUNT per passed
      // phase, so the statement count does not grow with the phases behind
      // the learner.
      expect(fourBehind.length).toBe(oneBehind.length);
      expect(oneBehind.filter((q) => /GROUP BY/i.test(q))).toHaveLength(1);
    });

    it('reuses workspace analysis while sending private conversational context on follow-ups', async () => {
      const model = answering();
      const service = build(model);
      const work = await openImplementation();
      await passPhases(['requirements', 'design']);
      const question = 'What should overdue() do on the due date itself?';
      const first = await service.chat(userId, work.id, question);
      const scansAfterWarming = service.workspaceScans;
      const second = await service.chat(userId, work.id, 'Why does that boundary matter?');
      expect(second.reply.meta?.cached).toBeUndefined();
      expect(service.workspaceScans).toBe(scansAfterWarming);
      const context = model.chat!.mock.calls[1][0];
      expect(context.history).toEqual(expect.arrayContaining([{ role: 'user', content: question }, { role: 'assistant', content: first.reply.content }]));
      expect(context.workspace).toBeDefined();
    });

    it('bills each new conversational context and reports the persisted meter', async () => {
      const service = build(answering());
      const work = await openImplementation();
      const question = 'How should I decide what add() returns?';

      const first = await service.chat(userId, work.id, question);
      const second = await service.chat(userId, work.id, question);

      expect(second.reply.meta?.cached).toBeUndefined();
      // A cached reply bills nothing, so the number it reports is the number
      // the day's messages still add up to.
      expect(second.usage.todayTokens).toBeGreaterThan(first.usage.todayTokens);
      expect(second.usage.todayTokens).toBe(await service.tokensToday(userId));
      expect(second.usage).not.toHaveProperty('dailyBudget');
    });
  });

  it('allows optional lesson guidance on an owned locked phase without exposing its workspace or unlocking it', async () => {
    const locked = await manager().findOneByOrFail(PhaseStateEntity, { enrollmentId, phaseOrder: 3 });
    const model = answering();
    const service = build(model);
    await expect(service.chat(userId, locked.id, 'How does implementation connect to design?')).rejects.toThrow('locked');
    const result = await service.chat(userId, locked.id, 'How do I reason about Python None values?', { lesson: true });
    expect(result.reply.meta?.provider).toBe('openai');
    expect(model.chat!.mock.calls[0][0].workspace).toBeUndefined();
    expect(model.chat!.mock.calls[0][0].phase.files).toEqual([]);
    expect((await manager().findOneByOrFail(PhaseStateEntity, { id: locked.id })).status).toBe('locked');
    expect(await service.lessonHistory(userId, locked.id)).toHaveLength(2);
    expect(await service.history(userId, locked.id)).toEqual([]);
    await expect(service.lessonHistory('another-owner', locked.id)).rejects.toThrow('not your phase');
    await expect(service.history('another-owner', locked.id)).rejects.toThrow('not your phase');
    await expect(service.history('another-owner', state.id)).rejects.toThrow('not your phase');
  });

  /* ------------------------------ the fallbacks ---------------------------- */

  it('reports provider failure without inventing a mentor answer', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('upstream exploded'));
    const service = build({ available: true, name: 'openai', chat });
    await expect(service.chat(userId, state.id, 'What makes a criterion checkable?')).rejects.toThrow('could not respond');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(await service.history(userId, state.id)).toHaveLength(0);
  });

  it('reports a withheld Guided reply with a stable code, meters usage, and persists no rejected conversation or cache', async () => {
    const error = Object.assign(new providerModule.ProviderUsageError('unshown draft failed review', 44, 28), { guidedReplyUnavailable: true });
    const service = build({ available: true, name: 'openai', chat: jest.fn().mockRejectedValue(error) });
    const failure = await service.chat(userId, state.id, 'How should I start reasoning about the missing story?').catch(error => error);
    expect(failure.getStatus()).toBe(503);
    expect(failure.getResponse()).toMatchObject({ statusCode: 503, code: 'GUIDED_REPLY_WITHHELD' });
    expect(await service.history(userId, state.id)).toHaveLength(0);
    expect(await caches().count()).toBe(0);
    expect(await service.tokensToday(userId)).toBe(72);
    expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(1);
    expect(await manager().findOneByOrFail(PhaseStateEntity, { id: state.id })).toMatchObject({ status: 'in_progress', attempts: 0 });
  });

  it('persists only the freshly reviewed repair and its complete usage, never the first candidate', async () => {
    config.openaiApiKey = 'sk-test';
    const unsafe = 'The entire assigned story belongs here. This would finish the missing artifact.';
    const repaired = 'A capability and its benefit answer different questions. What decision should the report help its reader make?';
    const review = (met: boolean) => JSON.stringify({ revealedDecisions: [], remainingReasoning: { description: 'The learner must identify the intended decision.', substantive: true, candidateEvidenceIds: ['G2'] }, checks: GUIDED_REVIEW_KEYS.map(key => ({ key, met: key === 'limited_step' ? met : true, candidateEvidenceIds: ['G1', 'G2'], reason: 'Mock semantic outcome for persistence verification.' })) });
    global.fetch = jest.fn().mockResolvedValueOnce(completion(unsafe, 11, 7)).mockResolvedValueOnce(completion(review(false), 11, 7))
      .mockResolvedValueOnce(completion(repaired, 11, 7)).mockResolvedValueOnce(completion(review(true), 11, 7));
    const service = build(new OpenAiProvider());
    const result = await service.chat(userId, state.id, 'How should I start reasoning about the missing story?');
    expect(result.reply.content).toBe(repaired);
    expect(global.fetch).toHaveBeenCalledTimes(4);
    const history = await service.history(userId, state.id);
    expect(history).toHaveLength(2);
    expect(history.some(message => message.content === unsafe)).toBe(false);
    expect(await service.tokensToday(userId)).toBe(72);
    const cached = await caches().find();
    expect(cached).toHaveLength(1);
    expect(cached[0].content).toBe(repaired);
  });

  // A review or a guided reply the AI gate refused after its queue wait says the class is busy,
  // never that the provider failed, and still awards no Pass.
  it('reviewSubmission tells the learner the class is busy when the AI gate refused the review', async () => {
    const review = jest.fn().mockRejectedValue(new AiBusyError('deadline', 120000));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const result = await build({ available: true, name: 'openai', review } as unknown as FakeOpenAi).reviewSubmission(phase, state, reviewInput);
      expect(result).toMatchObject({ provider: 'unavailable', verdict: 'needs_revision', assessmentError: AI_REVIEW_BUSY_MESSAGE, improvements: [AI_REVIEW_BUSY_MESSAGE] });
      expect(result.criteriaEvidence!.length).toBeGreaterThan(0);
      expect(result.criteriaEvidence!.every(c => !c.met && c.issue === AI_REVIEW_BUSY_MESSAGE && c.nextStep === 'Resubmit in a minute.')).toBe(true);
      expect(result.processNote).toBe('No approval was granted. Resubmit in a minute.');
      expect(warn.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringMatching(/^AI assessment provider_busy; .*gate=deadline waitedMs=120000; verdict remains closed$/));
      expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it('keeps the provider sentence and its next step for a review the provider failed', async () => {
    const review = jest.fn().mockRejectedValue(new Error('openai api returned HTTP 500'));
    const result = await build({ available: true, name: 'openai', review } as unknown as FakeOpenAi).reviewSubmission(phase, state, reviewInput);
    expect(result.assessmentError).not.toBe(AI_REVIEW_BUSY_MESSAGE);
    expect(result.criteriaEvidence!.every(c => c.nextStep === 'Retry assessment when the provider is available.')).toBe(true);
    expect(result.processNote).toBe('No approval was granted. Resubmit when assessment is available.');
  });

  it('a guided reply the AI gate refused says the class is busy and records nothing', async () => {
    const chat = jest.fn().mockRejectedValue(new AiBusyError('queue-full', 0));
    const service = build({ available: true, name: 'openai', chat });
    const refused = await service.chat(userId, state.id, 'What makes a criterion checkable?').catch(error => error);
    expect(refused.getStatus()).toBe(503);
    expect(refused.message).toBe(AI_BUSY_MESSAGE);
    expect(refused.getResponse()).toMatchObject({ statusCode: 503, code: 'AI_BUSY' });
    expect(await service.history(userId, state.id)).toHaveLength(0);
  });

  it('reviewSubmission reports needs revision with assessment error when the model answers with prose', async () => {
    config.openaiApiKey = 'sk-test';
    process.env.OPENAI_TIMEOUT_MS = '5000';
    global.fetch = jest.fn(async () =>
      completion('Sure! The scope is bounded and the criteria need a little work.'),
    ) as unknown as typeof fetch;
    const service = build(new OpenAiProvider());

    const review = await service.reviewSubmission(phase, state, reviewInput);

    expect(review).toMatchObject({ provider: 'unavailable', verdict: 'needs_revision' });
    expect(review.assessmentError).toBeTruthy();
    expect(review.summary.length).toBeGreaterThan(0);
    // The provider reported actual usage despite the unusable response.
    expect(await service.tokensToday(userId)).toBe(46);
    expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(1);
    expect(await service.history(userId, state.id)).toEqual([]);
  });

  it('does not invent usage when the provider never supplied a response or usage record', async () => {
    config.openaiApiKey = 'sk-test';
    global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable')) as typeof fetch;
    const service = build(new OpenAiProvider());
    expect((await service.reviewSubmission(phase, state, reviewInput)).provider).toBe('unavailable');
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'not valid JSON' } }] }) }) as typeof fetch;
    expect((await service.reviewSubmission(phase, state, reviewInput)).provider).toBe('unavailable');
    expect(await service.tokensToday(userId)).toBe(0);
    expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(0);
  });

  it('counts only one reported completion after a rate-limit retry returns malformed output', async () => {
    config.openaiApiKey = 'sk-test';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => 'rate limited' })
      .mockResolvedValueOnce(completion('not JSON', 31, 17)) as typeof fetch;
    const service = build(new OpenAiProvider());
    expect((await service.reviewSubmission(phase, state, reviewInput)).provider).toBe('unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(await service.tokensToday(userId)).toBe(48);
    expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(1);
  });

  it('meters a provider-reported truncated completion without granting a verdict or creating a conversation', async () => {
    config.openaiApiKey = 'sk-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":' }, finish_reason: 'length' }], usage: { prompt_tokens: 71, completion_tokens: 9 } }) }) as typeof fetch;
    const service = build(new OpenAiProvider());
    const review = await service.reviewSubmission(phase, state, reviewInput);
    expect(review.verdict).toBe('needs_revision');
    expect(review.assessmentError).toContain('ended before');
    expect(await service.tokensToday(userId)).toBe(80);
    expect(await service.history(userId, state.id)).toEqual([]);
  });

  it('reviews despite exhausted legacy budgets and keeps recording actual usage', async () => {
    await settings().save({ key: 'aiDailyTokenBudget', value: '100' });
    await messages().save(
      messages().create({
        userId,
        enrollmentId,
        phaseStateId: state.id,
        phaseKey: 'requirements',
        role: 'assistant',
        provider: 'local-mentor',
        content: 'earlier today',
        tokensIn: 60,
        tokensOut: 60,
      }),
    );
    await manager().update(UserEntity, userId, { dailyTokenBudget: 0 });
    const review = jest.fn().mockResolvedValue({ provider: 'openai', verdict: 'needs_revision', summary: 'One criterion needs evidence.', strengths: [], improvements: ['Explain the boundary.'], processNote: '', criteriaEvidence: [], tokensIn: 30, tokensOut: 20 });
    const service = build({ available: true, name: 'openai', review });

    const out = await service.reviewSubmission(phase, state, reviewInput);

    expect(out.provider).toBe('openai');
    expect(out.verdict).toBe('needs_revision');
    expect(review).toHaveBeenCalledTimes(1);
    expect(await service.tokensToday(userId)).toBe(170);
  });

  it('bills a rubric review to the same ledger usage diagnostics read', async () => {
    const review = jest.fn().mockResolvedValue({
      summary: 'Clear scope, thin criteria.',
      strengths: ['Scope is bounded'],
      improvements: ['Make US-2 observable'],
      processNote: 'You ran the checks first.',
      provider: 'openai',
      tokensIn: 120,
      tokensOut: 80,
    });
    const service = build({ available: true, name: 'openai', review });

    const out = await service.reviewSubmission(phase, state, reviewInput);

    expect(out.provider).toBe('openai');
    expect((out as unknown as Record<string, unknown>).tokensIn).toBeUndefined();
    expect(await service.tokensToday(userId)).toBe(200);
    // The ledger row is bookkeeping, so it stays out of the transcript.
    const ledger = await messages().find({ where: { provider: REVIEW_USAGE_PROVIDER } });
    expect(ledger).toHaveLength(1);
    expect(await service.history(userId, state.id)).toHaveLength(0);
  });

  /* ---------------------- the review re-ask ---------------------- */

  describe('the review re-ask', () => {
    const keys = () => phase.rubric.criteria.map(c => c.key);
    /** A consistent needs_revision answer: every criterion unmet, each with its issue and next step. */
    const consistentAnswer = () => JSON.stringify({
      verdict: 'needs_revision', summary: 'The stories need checkable outcomes.', strengths: [], improvements: ['Make every outcome observable.'], processNote: 'A note.',
      criteriaEvidence: keys().map(key => ({ key, met: false, evidence: `requirements.md does not show ${key}.`, issue: `${key} is not shown.`, nextStep: `Show ${key}.` })),
    });
    /** A self-contradicting review: needs_revision over every criterion met. */
    const contradictedAnswer = () => JSON.stringify({
      verdict: 'needs_revision', summary: 'FIRST-ANSWER WORDS', strengths: [], improvements: ['FIRST-ANSWER IMPROVEMENT'], processNote: 'A note.',
      criteriaEvidence: keys().map(key => ({ key, met: true, evidence: 'FIRST-ANSWER EVIDENCE', issue: '', nextStep: '' })),
    });
    const contradiction = () => ({ kind: 'revision_with_all_met' as const, keys: keys() });
    const refusal = () => withReviewContradiction(new Error('Verdict contradicts criterion evidence'), contradiction());
    const consistent = { provider: 'openai', verdict: 'needs_revision', summary: 'Second answer.', strengths: [], improvements: ['Revise.'], processNote: 'A note.', criteriaEvidence: [], tokensIn: 0, tokensOut: 0 };
    const warned = (service: AssistantService) => jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const lines = (spy: jest.SpyInstance) => spy.mock.calls.map(call => String(call[0]));
    const todaysMessage = 'The AI provider returned incomplete or contradictory assessment evidence. No approval was granted; resubmit for another review.';
    afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

    it('asks the reviewer once more when its answer contradicts its own criterion evidence, and keeps the consistent second answer', async () => {
      config.openaiApiKey = 'sk-test';
      process.env.OPENAI_TIMEOUT_MS = '60000';
      global.fetch = jest.fn()
        .mockResolvedValueOnce(completion(contradictedAnswer(), 100, 40))
        .mockResolvedValueOnce(completion(consistentAnswer(), 110, 50)) as unknown as typeof fetch;
      const service = build(new OpenAiProvider());
      const warn = warned(service);

      const review = await service.reviewSubmission(phase, state, reviewInput);

      expect(review).toMatchObject({ provider: 'openai', verdict: 'needs_revision', summary: 'The stories need checkable outcomes.' });
      expect(review.assessmentError).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const bodies = (global.fetch as jest.Mock).mock.calls.map(call => JSON.parse(call[1].body));
      // The first briefing byte for byte, then the fixed note: nothing of the first answer's words.
      expect(bodies[1].messages.slice(0, -1)).toEqual(bodies[0].messages);
      expect(bodies[1].messages.at(-1)).toEqual({ role: 'system', content: reviewReaskNote(contradiction()) });
      expect(JSON.stringify(bodies[1])).not.toContain('FIRST-ANSWER');
      expect(bodies[1].response_format).toEqual(bodies[0].response_format);
      // Both calls' spend is on the ledger; still one review, no transcript.
      expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(2);
      expect(await service.tokensToday(userId)).toBe(300);
      expect(await service.history(userId, state.id)).toEqual([]);
      // The existing warn line for the refused answer is kept, then one counting line.
      expect(lines(warn)).toEqual([
        `AI assessment invalid_evidence; phase=${phase.key}; state=${state.id}; Verdict contradicts criterion evidence; verdict remains closed`,
        `grading_assessment_reasked phase=${phase.key} cause=invalid_evidence outcome=ok`,
      ]);
    });

    it('leaves the review unavailable when the second answer contradicts itself too, and asks no third time', async () => {
      config.openaiApiKey = 'sk-test';
      process.env.OPENAI_TIMEOUT_MS = '60000';
      global.fetch = jest.fn(async () => completion(contradictedAnswer(), 100, 40)) as unknown as typeof fetch;
      const service = build(new OpenAiProvider());
      const warn = warned(service);

      const review = await service.reviewSubmission(phase, state, reviewInput);

      expect(review).toMatchObject({ provider: 'unavailable', verdict: 'needs_revision', assessmentError: todaysMessage });
      expect(review.criteriaEvidence!.every(c => c.met === false && c.evidence === 'Semantic assessment unavailable.')).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(await messages().count({ where: { provider: REVIEW_USAGE_PROVIDER } })).toBe(2);
      expect(lines(warn)).toEqual([
        `AI assessment invalid_evidence; phase=${phase.key}; state=${state.id}; Verdict contradicts criterion evidence; verdict remains closed`,
        `AI assessment invalid_evidence; phase=${phase.key}; state=${state.id}; Verdict contradicts criterion evidence; verdict remains closed`,
        `grading_assessment_reasked phase=${phase.key} cause=invalid_evidence outcome=still_invalid`,
      ]);
    });

    it('never re-asks a refusal that is not a contradiction: unreadable, malformed, ungrounded, timed out or failed', async () => {
      for (const error of [
        new Error('AI review was not JSON'),
        new Error('Missing summary'),
        new Error('Passing assessment did not ground every criterion in submitted evidence'),
        new Error('openai api timed out after 60000ms'),
        new Error('openai api returned HTTP 500'),
        // A consistency message with nothing carried (the answer did not show it) is not re-asked on a guess.
        new Error('Verdict contradicts criterion evidence'),
      ]) {
        const review = jest.fn().mockRejectedValue(error);
        const service = build({ available: true, name: 'openai', review });
        const warn = warned(service);
        expect((await service.reviewSubmission(phase, state, reviewInput)).provider).toBe('unavailable');
        expect(review).toHaveBeenCalledTimes(1);
        expect(lines(warn).some(line => line.startsWith('grading_assessment_'))).toBe(false);
      }
    });

    it('re-asks under the same per-learner lock: the learner’s next billable call waits for both asks, another learner does not', async () => {
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
      const review = jest.fn()
        .mockImplementationOnce(async () => { events.push('ask 1'); await firstHeld; throw refusal(); })
        .mockImplementationOnce(async () => { events.push('ask 2'); return consistent; });
      const service = build({ available: true, name: 'openai', review });
      warned(service);

      const reviewed = service.reviewSubmission(phase, state, reviewInput);
      const next = service.serialise(state.userId, async () => { events.push('same learner next'); });
      const other = service.serialise('another-learner', async () => { events.push('other learner'); });
      await other;
      expect(events).toEqual(['ask 1', 'other learner']);
      releaseFirst();
      await Promise.all([reviewed, next]);
      expect(events).toEqual(['ask 1', 'other learner', 'ask 2', 'same learner next']);
      expect((await reviewed).provider).toBe('openai');
      expect(review.mock.calls[1][2]).toMatchObject({ contradiction: contradiction() });
    });

    it('re-asks only inside the review’s own bound: one OPENAI_TIMEOUT_MS from the first ask, at least ten seconds left', async () => {
      process.env.OPENAI_TIMEOUT_MS = '60000';
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const slowFirst = (spent: number) => jest.fn()
        .mockImplementationOnce(async () => { now += spent; throw refusal(); })
        .mockImplementationOnce(async () => consistent);

      // 50.001 s spent: 9.999 s left, below the floor, so no second ask.
      let review = slowFirst(50_001);
      let service = build({ available: true, name: 'openai', review });
      let warn = warned(service);
      expect(await service.reviewSubmission(phase, state, reviewInput)).toMatchObject({ provider: 'unavailable', assessmentError: todaysMessage });
      expect(review).toHaveBeenCalledTimes(1);
      expect(lines(warn).at(-1)).toBe(`grading_assessment_reask_skipped phase=${phase.key} cause=invalid_evidence remaining_ms=9999`);

      // 50 s spent: exactly 10 s left, so the second ask runs.
      review = slowFirst(50_000);
      service = build({ available: true, name: 'openai', review });
      warn = warned(service);
      expect((await service.reviewSubmission(phase, state, reviewInput)).provider).toBe('openai');
      expect(review).toHaveBeenCalledTimes(2);
      expect(lines(warn).at(-1)).toBe(`grading_assessment_reasked phase=${phase.key} cause=invalid_evidence outcome=ok`);
    });

    it('ends the second ask when the bound runs out: unavailable, counted still_invalid', async () => {
      process.env.OPENAI_TIMEOUT_MS = '60000';
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const start = Date.now();
      let seen: AbortSignal | undefined;
      const review = jest.fn()
        .mockImplementationOnce(async () => { jest.setSystemTime(start + 45_000); throw refusal(); })
        .mockImplementationOnce((_phase: unknown, _input: unknown, reask: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          seen = reask.signal;
          reask.signal.addEventListener('abort', () => reject(reask.signal.reason), { once: true });
        }));
      const service = build({ available: true, name: 'openai', review });
      const warn = warned(service);

      const reviewed = service.reviewSubmission(phase, state, reviewInput);
      await jest.advanceTimersByTimeAsync(14_999);
      expect(seen?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(seen?.aborted).toBe(true);
      expect(await reviewed).toMatchObject({ provider: 'unavailable', verdict: 'needs_revision', assessmentError: todaysMessage });
      expect(lines(warn).at(-1)).toBe(`grading_assessment_reasked phase=${phase.key} cause=invalid_evidence outcome=still_invalid`);
    });
  });

  /* --------------------------- the response cache -------------------------- */

  it('does not answer tomorrow out of an outage today', async () => {
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new Error('upstream exploded'))
      .mockResolvedValue({
        content: 'What would make that criterion checkable by someone else?',
        tokensIn: 5,
        tokensOut: 9,
        provider: 'openai',
      });
    const service = build({ available: true, name: 'openai', chat });
    const question = 'What makes a criterion checkable?';

    await expect(service.chat(userId, state.id, question)).rejects.toThrow('could not respond');
    // The consolation reply was never written under the key OpenAI's answer uses.
    expect(await caches().count()).toBe(0);

    const second = await service.chat(userId, state.id, question);
    expect(second.reply.meta?.provider).toBe('openai');
    expect(second.reply.meta?.cached).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await caches().count()).toBe(1);

    const third = await service.chat(userId, state.id, question);
    expect(third.reply.meta?.cached).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('does not manufacture or cache replies when no provider is configured', async () => {
    const service = build(offline);
    await expect(service.chat(userId, state.id, 'What makes a criterion checkable?')).rejects.toThrow('not configured');
    expect(await caches().count()).toBe(0);
    expect(await service.history(userId, state.id)).toHaveLength(0);
  });

  it('preserves two simultaneous turns as distinct private conversation contexts', async () => {
    let active = 0, maxActive = 0;
    const chat = jest.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await sleep(10);
      active--;
      return {
        content: 'Which outcome would you check first?',
        tokensIn: 4,
        tokensOut: 7,
        provider: 'openai',
      };
    });
    const service = build({ available: true, name: 'openai', chat });
    const question = 'What belongs in an acceptance criterion?';

    const [a, b] = await Promise.all([
      service.chat(userId, state.id, question),
      service.chat(userId, state.id, question),
    ]);

    expect(a.reply.content).toBe(b.reply.content);
    expect(a.reply.id).not.toBe(b.reply.id);
    expect(await caches().count()).toBe(2);
    const rows = await messages().find({ where: { phaseStateId: state.id } });
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(2);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(2);
  });

  it('redacts each contextual response and persists only guarded text', async () => {
    const leaked = [
      '**US-4: User Story**',
      '',
      'As a project manager, I want to see overdue reports so that I can prioritise the week.',
      '',
      '**Given:** the report list is open',
      '**When:** a report passes its due date',
      '**Then:** it appears at the top of the list',
    ].join('\n');
    const chat = jest.fn().mockResolvedValue({
      content: leaked,
      tokensIn: 3,
      tokensOut: 40,
      provider: 'openai',
    });
    const service = build({ available: true, name: 'openai', chat });
    const question = 'Can you sketch the shape of one?';

    const first = await service.chat(userId, state.id, question);
    expect(first.reply.meta?.redacted).toBe(true);
    expect(first.reply.content).not.toContain('project manager');

    const [row] = await caches().find();
    expect(row.redacted).toBe(true);
    expect(row.content).not.toContain('project manager');

    const second = await service.chat(userId, state.id, question);
    expect(second.reply.meta?.cached).toBeUndefined();
    expect(second.reply.meta?.redacted).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('stops answering from a cache row past its TTL, and sweeps it away', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: 'Name the observable outcome first. Which one is it?',
      tokensIn: 4,
      tokensOut: 8,
      provider: 'openai',
    });
    const service = build({ available: true, name: 'openai', chat });
    const question = 'What makes a criterion checkable?';

    await service.chat(userId, state.id, question);
    const [fresh] = await caches().find();

    // Age the row two days: older than the 24 hour default.
    await caches().delete({ cacheKey: fresh.cacheKey });
    await caches().save(
      caches().create({
        cacheKey: fresh.cacheKey,
        content: 'an answer from the day before yesterday',
        provider: 'openai',
        redacted: false,
        createdAt: new Date(Date.now() - 48 * 3_600_000),
      }),
    );
    const [aged] = await caches().find();
    expect(Date.now() - new Date(aged.createdAt).getTime()).toBeGreaterThan(24 * 3_600_000);

    const second = await service.chat(userId, state.id, question);
    expect(second.reply.meta?.cached).toBeUndefined();
    expect(second.reply.content).not.toContain('day before yesterday');
    expect(chat).toHaveBeenCalledTimes(2);
    // Changed conversation receives a new key; the expired prior context is swept.
    expect(await caches().count()).toBe(2);

    await caches().update({ cacheKey: fresh.cacheKey }, { content: 'still here' });
    await caches().save(
      caches().create({
        cacheKey: 'some-other-question',
        content: 'older still',
        provider: 'openai',
        createdAt: new Date(Date.now() - 72 * 3_600_000),
      }),
    );
    expect(await service.sweepAiCache()).toBe(2);
    expect(await caches().count()).toBe(1);
  });

  /* ------------------------ load, refusal and provenance ------------------- */

  it('answers thirty learners at once and names the mentor on every reply', async () => {
    process.env.AI_MAX_CONCURRENCY = '4';
    process.env.OPENAI_TIMEOUT_MS = '5000';
    config.openaiApiKey = 'sk-test';

    let inFlight = 0;
    let peak = 0;
    global.fetch = jest.fn(async (_url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // The stub is the upstream's rate limit: above four in flight it refuses.
      if (inFlight > 4) {
        inFlight -= 1;
        return failure(429, 'slow down', { 'retry-after': '0' });
      }
      await sleep(3);
      inFlight -= 1;
      return completion(String(init?.body).includes('candidateEvidence')
        ? JSON.stringify({ revealedDecisions: [], remainingReasoning: { description: "One concrete boundary remains for the learner to reason about.", substantive: true, candidateEvidenceIds: ["G1"] }, checks: GUIDED_REVIEW_KEYS.map(key => ({ key, met: true, candidateEvidenceIds: ['G1'], reason: 'A bounded observation with a relevant question.' })) })
        : 'One step at a time. What have you tried?');
    }) as unknown as typeof fetch;

    const service = build(new OpenAiProvider());
    const replies = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        service.chat(userId, state.id, `question number ${i} about the boundary`),
      ),
    );

    expect(replies).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(4);
    expect(replies.every((r) => r.reply.meta?.provider === 'openai')).toBe(true);
    expect(replies.every((r) => r.reply.content.includes('One step at a time'))).toBe(true);
  }, 30_000);

  it('does not report a simulated provider after an upstream failure', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('upstream failure'));
    const service = build({ available: true, name: 'openai', chat });
    await expect(service.chat(userId, state.id, 'What makes a criterion checkable?')).rejects.toThrow('could not respond');
    expect(await service.history(userId, state.id)).toHaveLength(0);
    expect(await service.recentProviderName()).toBe('openai');
  });

  it('withholds an unsafe Guided draft from history and cache, while billing both real responses', async () => {
    config.openaiApiKey = 'sk-test';
    const unsafe = 'The entire assigned algorithm belongs here. What will you copy?';
    const review = { revealedDecisions: [], remainingReasoning: { description: "One concrete boundary remains for the learner to reason about.", substantive: true, candidateEvidenceIds: ["G1"] }, checks: GUIDED_REVIEW_KEYS.map(key => ({ key, met: key !== 'limited_step', candidateEvidenceIds: ['G1'], reason: key === 'limited_step' ? 'It supplies the assigned answer.' : 'Applicable response evidence.' })) };
    global.fetch = jest.fn().mockResolvedValueOnce(completion(unsafe, 20, 10)).mockResolvedValueOnce(completion(JSON.stringify(review), 30, 15));
    const service = build(new OpenAiProvider());
    await expect(service.chat(userId, state.id, 'Help me reason about the boundary')).rejects.toThrow('not a judgment of your work');
    expect(await service.history(userId, state.id)).toHaveLength(0);
    expect(await caches().count()).toBe(0);
    expect(await service.tokensToday(userId)).toBe(75);
    const saved = await messages().find();
    expect(saved).toHaveLength(1);
    expect(saved[0].content).not.toContain(unsafe);
    expect(saved[0]).toMatchObject({ provider: REVIEW_USAGE_PROVIDER, tokensIn: 50, tokensOut: 25 });
  });

  it('cannot reuse a response cache entry created before semantic Guided review', () => {
    const service = build({ available: true, name: 'openai' }) as unknown as { cacheKey: (...args: unknown[]) => string };
    const args = [phase, 'Explain this boundary.', { todosRemaining: [], lastFailedChecks: [] }, 0, null, [], undefined, 'tasktrackr', 'same-workspace-and-history'];
    const currentIdentity = providerModule.mentorInstructionIdentity(phase);
    const legacy = JSON.parse(currentIdentity); delete legacy.guidedReview; delete legacy.guidedReviewPrompt;
    const oldPolicy = jest.spyOn(providerModule, 'mentorInstructionIdentity').mockReturnValue(JSON.stringify(legacy));
    const oldKey = service.cacheKey(...args); oldPolicy.mockRestore();
    expect(service.cacheKey(...args)).not.toBe(oldKey);
  });

  /* ------------------- memory and instructor notes ------------------------- */

  describe('the mentor\'s memory and its class\'s notes', () => {
    const STORY = JSON.stringify({
      id: 'US-4',
      title: 'Overdue report',
      persona: 'busy team lead',
      capability: 'a report of my overdue tasks',
      benefit: 'I catch what I missed',
      criteria: [{ id: 'AC-1', given: 'a task due today', when: 'I run the report', then: 'it does not appear', tag: 'boundary' }],
      scopeExclusions: [],
      notes: '',
    });

    /** Marks the requirements phase passed with a story on it, so memory has something to read. */
    const finishRequirements = async (): Promise<void> => {
      await manager().update(PhaseStateEntity, state.id, {
        status: 'passed',
        workspace: { 'requirements/story.json': STORY },
      });
    };

    /** A class with this learner in it, and a note written for it. */
    const writeNote = async (text: string, over: Record<string, unknown> = {}): Promise<string> => {
      const instructor = await manager().save(
        manager().create(UserEntity, {
          email: `ana${Math.random()}@class.edu`,
          passwordHash: 'x',
          displayName: 'Ana',
          role: 'INSTRUCTOR',
        }),
      );
      const cohort = await manager().save(
        manager().create(CohortEntity, {
          name: 'Monday class',
          joinCode: `code-${Math.random()}`,
          ownerUserId: instructor.id,
        }),
      );
      await manager().update(UserEntity, userId, { cohort: cohort.id });
      const written = await notes.write(
        { id: instructor.id, role: 'INSTRUCTOR', cohort: cohort.id },
        {
          kind: 'mentor',
          cohortId: cohort.id,
          text,
          ...over,
        } as never,
      );
      return written.id;
    };

    it('carries nothing before the first gate, and no line to the learner', async () => {
      const service = build(contextual());
      await service.chat(userId, state.id, 'Where should I start?');

      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { id: enrollmentId });
      expect(enrollment.mentorMemory).toBeNull();
    });

    it('builds the memory from the learner\'s own artefact on the next question', async () => {
      await finishRequirements();
      const design = await manager().findOneByOrFail(PhaseStateEntity, {
        enrollmentId,
        phaseOrder: 2,
      });
      await manager().update(PhaseStateEntity, design.id, { status: 'in_progress' });

      const service = build(contextual());
      const { reply } = await service.chat(userId, design.id, 'How do I lay out the contract?');

      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { id: enrollmentId });
      expect(enrollment.mentorMemory?.builtThrough).toBe(1);
      expect(enrollment.mentorMemory?.items[0].text).toContain('busy team lead');
      // The offline mentor names one decision, and only one.
      expect(reply.content).toContain('Earlier you decided:');
      expect(reply.content).toContain('busy team lead');
    });

    it('carries an instructor note through the mocked provider context', async () => {
      const note = 'Use datetime.date.today() when you compare due dates, not datetime.now().';
      await writeNote(note);

      const service = build(contextual());
      const { reply } = await service.chat(userId, state.id, 'How do I test the boundary?');

      expect(reply.content).toContain("Your instructor's note for this class:");
      expect(reply.content).toContain(note);
    });

    it('carries a note only to the class it was written for', async () => {
      await writeNote('Use datetime.date.today() when you compare due dates.');
      // The learner leaves the class; the note goes with the class, not with them.
      await manager().update(UserEntity, userId, { cohort: 'default' });

      const service = build(contextual());
      const { reply } = await service.chat(userId, state.id, 'How do I test the boundary?');
      expect(reply.content).not.toContain("Your instructor's note");
    });

    it('changes the cache key when a note is edited, so the class hears the new one', async () => {
      const noteId = await writeNote('Use datetime.date.today() when you compare due dates.');
      const service = build(answering());
      const question = 'How do I test the boundary?';

      await service.chat(userId, state.id, question);
      const firstKeys = (await caches().find()).map((row) => row.cacheKey);
      expect(firstKeys).toHaveLength(1);

      const instructorId = (await manager().findOneByOrFail(UserEntity, {
        email: (await manager().find(UserEntity, { where: { role: 'INSTRUCTOR' } }))[0].email,
      })).id;
      const cohortId = (await manager().findOneByOrFail(UserEntity, { id: userId })).cohort;
      await sleep(1100); // sqlite stamps updatedAt to the second
      await notes.update(
        { id: instructorId, role: 'INSTRUCTOR', cohort: cohortId },
        noteId,
        { text: 'Compare dates with date.today(), and say so in the criterion.' },
      );

      await service.chat(userId, state.id, question);
      const keys = (await caches().find()).map((row) => row.cacheKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    }, 20_000);

    it('changes the cache key when the memory grows a phase', async () => {
      const design = await manager().findOneByOrFail(PhaseStateEntity, {
        enrollmentId,
        phaseOrder: 2,
      });
      await manager().update(PhaseStateEntity, design.id, { status: 'in_progress' });

      // Same learner, same phase, same words, twice, the only thing that moves
      // between them is that a gate was passed and the mentor now remembers it.
      const service = build(answering());
      const question = 'How do I lay out the contract table?';
      await service.chat(userId, design.id, question);
      expect(await caches().count()).toBe(1);

      await finishRequirements();
      await service.chat(userId, design.id, question);

      // Without the memory in the key, the second learner is handed the answer
      // written before they had decided anything.
      expect(await caches().count()).toBe(2);
      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { id: enrollmentId });
      expect(enrollment.mentorMemory?.builtThrough).toBe(1);
    });

    it('excludes interview bookkeeping from the transcript, the mentor named, and the hint count', async () => {
      await messages().save(
        messages().create({
          userId,
          enrollmentId,
          phaseStateId: state.id,
          phaseKey: 'requirements',
          role: 'assistant',
          provider: INTERVIEW_USAGE_PROVIDER,
          content: 'Interview turn answered by openai.',
          tokensIn: 90,
          tokensOut: 30,
        }),
      );
      const service = build(contextual());

      expect(await service.history(userId, state.id)).toEqual([]);
      // …but it is still billed: the ledger is the same table.
      expect(await service.tokensToday(userId)).toBe(120);
      // …and it names no mentor, so a console reading it does not say "interview".
      expect(await service.recentProviderName()).toBe('mock-ai');
      // …and ten of them do not make a learner look reliant on hints.
      expect(await messages().count({ where: { phaseStateId: state.id, role: 'user' } })).toBe(0);
    });
  });

  /* ----------------------------- the usage day ---------------------------- */

  it('measures the usage day in AI_USAGE_TIMEZONE, not in UTC', async () => {
    process.env.AI_USAGE_TIMEZONE = 'Asia/Singapore';
    const service = build(contextual());

    // A message sent at 23:00 Singapore on 5 September, which is 15:00 UTC.
    await messages().save(
      messages().create({
        userId,
        enrollmentId,
        phaseStateId: state.id,
        phaseKey: 'requirements',
        role: 'assistant',
        provider: 'local-mentor',
        content: 'late in the lab',
        tokensIn: 100,
        tokensOut: 200,
        createdAt: new Date('2026-09-05T15:00:00Z'),
      }),
    );
    const [row] = await messages().find();
    expect(new Date(row.createdAt).toISOString()).toBe('2026-09-05T15:00:00.000Z');

    // 23:30 Singapore, the same evening: still spent.
    expect(await service.tokensToday(userId, new Date('2026-09-05T15:30:00Z'))).toBe(300);
    // 00:30 Singapore the next morning: a new reporting day, and 16:30 UTC of the
    // same UTC day: the boundary a UTC day would get wrong.
    expect(await service.tokensToday(userId, new Date('2026-09-05T16:30:00Z'))).toBe(0);
  });

  it('keeps project and optional lesson chat available above legacy user and installation quotas', async () => {
    await settings().save({ key: 'aiDailyTokenBudget', value: '0' });
    await manager().update(UserEntity, userId, { dailyTokenBudget: 0 });
    await messages().save(messages().create({ userId, enrollmentId, phaseStateId: state.id,
      phaseKey: 'requirements', role: 'assistant', provider: REVIEW_USAGE_PROVIDER,
      content: 'Historical usage', tokensIn: 20_000_000, tokensOut: 1 }));
    const model = answering();
    const service = build(model);
    const project = await service.chat(userId, state.id, 'What makes a criterion checkable?');
    const lesson = await service.chat(userId, state.id, 'How do I separate a need from a design?', { lesson: true });
    expect(model.chat).toHaveBeenCalledTimes(2);
    for (const result of [project, lesson]) {
      expect(result.reply.meta?.provider).toBe('openai');
      expect(result.reply.meta?.budgetExceeded).toBeUndefined();
      expect(result.usage).not.toHaveProperty('dailyBudget');
      expect(result.usage.todayTokens).toBeGreaterThan(20_000_001);
    }
    expect(lesson.usage.todayTokens).toBeGreaterThan(project.usage.todayTokens);
    expect((await manager().findOneByOrFail(UserEntity, { id: userId })).dailyTokenBudget).toBe(0);
    expect((await settings().findOneByOrFail({ key: 'aiDailyTokenBudget' })).value).toBe('0');
  });

  /* ------------------------- answer withholding, live ---------------------- */

  it('withholds a written-out artefact in a phase whose checks are not prose', async () => {
    // The artefact filter runs on every phase, not only markdown and config
    // ones; a model writes the learner's test cases out just as readily.
    expect(['markdown', 'config']).not.toContain(content.getPhase('tasktrackr', 'testing').checks.kind);
    const testing = await manager().findOneByOrFail(PhaseStateEntity, {
      enrollmentId,
      phaseKey: 'testing',
    });
    await manager().update(PhaseStateEntity, testing.id, { status: 'in_progress' });

    const chat = jest.fn().mockResolvedValue({
      content: [
        'Here are the cases to write:',
        '',
        'Given a task due yesterday, when the list is built, then it appears first.',
        'Given a task with no due date, when the list is built, then it is left out.',
      ].join('\n'),
      tokensIn: 5,
      tokensOut: 30,
      provider: 'openai',
    });
    const service = build({ available: true, name: 'openai', chat });

    const { reply } = await service.chat(userId, testing.id, 'How many cases should I aim for?');

    expect(reply.meta?.redacted).toBe(true);
    expect(reply.content).not.toContain('due yesterday');
  });


  it('withholds a wall of code the model indented instead of fencing', async () => {
    const deployment = await manager().findOneByOrFail(PhaseStateEntity, {
      enrollmentId,
      phaseKey: 'deployment',
    });
    await manager().update(PhaseStateEntity, deployment.id, { status: 'in_progress' });

    const chat = jest.fn().mockResolvedValue({
      content: [
        'Here is the runbook section:',
        '',
        '    FROM python:3.11-slim',
        '    WORKDIR /app',
        '    COPY requirements.txt .',
        '    RUN pip install --no-cache-dir -r requirements.txt',
        '    COPY . .',
        '    USER 65534',
        '    EXPOSE 8000',
        '    HEALTHCHECK CMD curl -f http://localhost:8000/health',
        '    CMD ["python", "-m", "app"]',
      ].join('\n'),
      tokensIn: 6,
      tokensOut: 60,
      provider: 'openai',
    });
    const service = build({ available: true, name: 'openai', chat });

    const { reply } = await service.chat(userId, deployment.id, 'How should the image be layered?');

    expect(reply.meta?.redacted).toBe(true);
    expect(reply.content).not.toContain('pip install');
    expect(reply.content).not.toContain('HEALTHCHECK');
  });

  /* --------------------- explain a failure --------------------------------- */

  /** The context the explain route hands `chat`, in the shape the service builds. */
  const failingTest = (over: Record<string, unknown> = {}) => ({
    name: 'test_overdue_excludes_today',
    hidden: false,
    assertion: 'AssertionError: assert 2 == 1',
    path: 'api/repository/tasks.py',
    line: 56,
    excerpt: '',
    ...over,
  });

  const implementationState = async (): Promise<PhaseStateEntity> =>
    dataSource.getRepository(PhaseStateEntity).findOneByOrFail({
      enrollmentId,
      phaseKey: 'implementation',
    });

  it('two different failures of the same test do not share a cached answer', async () => {
    const model = answering();
    const service = build(model);
    const asked = model.chat!;

    await service.chat(userId, state.id, 'Why does test_overdue_excludes_today fail?', {
      failingTest: failingTest(),
    });
    await service.chat(userId, state.id, 'Why does test_overdue_excludes_today fail?', {
      failingTest: failingTest({ assertion: 'AssertionError: assert 0 == 1' }),
    });

    // Same words, same phase, same workspace: without the failing test in the
    // key the second turn is served the first turn's answer, about an
    // assertion the learner has already fixed.
    expect(asked).toHaveBeenCalledTimes(2);
    expect(await caches().count()).toBe(2);
  });

  it('an explanation about a test is not redirected to another phase', async () => {
    const implementation = await implementationState();
    await dataSource
      .getRepository(PhaseStateEntity)
      .update(implementation.id, { status: 'in_progress' });
    const service = build(contextual());

    // "assertraises" is the testing phase's own strong keyword, so this
    // question would be redirected out of implementation if the words were all
    // the guardrail had to go on. A case in this phase's own report is on this
    // phase's topic by construction.
    const { reply } = await service.chat(
      userId,
      implementation.id,
      'Why does test_assertRaises_on_missing fail?',
      { failingTest: failingTest({ name: 'test_assertRaises_on_missing' }) },
    );

    expect(reply.meta?.scopeRedirected).toBeUndefined();
    expect(reply.meta?.provider).toBe('mock-ai');
  });

  it('the same question with no failing test is still redirected', async () => {
    const implementation = await implementationState();
    await dataSource
      .getRepository(PhaseStateEntity)
      .update(implementation.id, { status: 'in_progress' });
    const service = build(contextual());

    const { reply } = await service.chat(
      userId,
      implementation.id,
      'Why does test_assertRaises_on_missing fail?',
    );

    expect(reply.meta?.scopeRedirected).toBe(true);
  });

  it('an explanation is a hint like any other', async () => {
    const service = build(contextual());
    await service.chat(userId, state.id, 'Why does test_overdue_excludes_today fail?', {
      failingTest: failingTest(),
    });

    const rows = await messages().find({ where: { phaseStateId: state.id, role: 'user' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Why does test_overdue_excludes_today fail?');
    const history = await service.history(userId, state.id);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  /* ---------------------- access and isolation ----------------------------- */

  /** A second learner with the first phase open. */
  const enrolAnother = async (email: string): Promise<{ userId: string; stateId: string }> => {
    const user = await manager().save(
      manager().create(UserEntity, { email, passwordHash: 'x', displayName: email }),
    );
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId: user.id,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
      }),
    );
    const row = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId: user.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'in_progress',
        attempts: 0,
      }),
    );
    return { userId: user.id, stateId: row.id };
  };

  it('refuses to chat on a phase the class schedule holds shut, in the phase page\'s words', async () => {
    const owner = await manager().save(
      manager().create(UserEntity, {
        email: 'staff@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'Staff',
        role: 'INSTRUCTOR',
      }),
    );
    const cohort = await manager().save(
      manager().create(CohortEntity, { name: 'G1', joinCode: 'G1CODE', ownerUserId: owner.id }),
    );
    await manager().update(UserEntity, userId, { cohort: cohort.id });
    const opensAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await manager().save(
      manager().create(CohortPhaseScheduleEntity, {
        cohortId: cohort.id,
        projectSlug: 'tasktrackr',
        phaseKey: 'requirements',
        opensAt,
        dueAt: null,
      }),
    );
    const chat = jest.fn();
    const service = build({ available: true, name: 'openai', chat });

    await expect(service.chat(userId, state.id, 'What should my first story say?')).rejects.toThrow(
      opensAtMessage(opensAt),
    );
    expect(chat).not.toHaveBeenCalled();
    expect(await messages().count()).toBe(0);

    // The date passing opens the door without the row changing.
    await manager().update(
      CohortPhaseScheduleEntity,
      { cohortId: cohort.id, phaseKey: 'requirements' },
      { opensAt: new Date(Date.now() - 60_000).toISOString() },
    );
    const reply = await build(contextual()).chat(userId, state.id, 'What should my first story say?');
    expect(reply.reply.meta?.provider).toBe('mock-ai');
  });

  it('never uses the authored hint ladder as a fallback for unavailable AI', async () => {
    const service = build(offline);
    const other = await enrolAnother('other@learnsdlc.test');
    await expect(service.chat(userId, state.id, 'zzz alpha')).rejects.toThrow('not configured');
    await expect(service.chat(other.userId, other.stateId, 'zzz alpha')).rejects.toThrow('not configured');
    expect(await caches().count()).toBe(0);
  });

  it('serialises a burst without a token cap and records each completion', async () => {
    let active = 0, maxActive = 0;
    const chat = jest.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await sleep(10);
      active--;
      return {
        content: 'Which outcome would you check first?',
        tokensIn: 30,
        tokensOut: 30,
        provider: 'openai',
      };
    });
    const service = build({ available: true, name: 'openai', chat });
    // A retained legacy value must not deny any of these calls.
    await manager().update(UserEntity, userId, { dailyTokenBudget: 50 });

    const replies = await Promise.all([
      service.chat(userId, state.id, 'zzz first question'),
      service.chat(userId, state.id, 'zzz second question'),
      service.chat(userId, state.id, 'zzz third question'),
    ]);

    expect(chat).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
    expect(replies.every(r => r.reply.meta?.provider === 'openai')).toBe(true);
    expect(replies.every(r => !r.reply.meta?.budgetExceeded)).toBe(true);
    expect(await service.tokensToday(userId)).toBe(180);
  });

  it('keys the reply cache by pack as well as by phase', () => {
    const service = build(answering()) as unknown as {
      cacheKey: (...args: unknown[]) => string;
    };
    const signals = { todosRemaining: [], lastFailedChecks: [] };
    const a = service.cacheKey(phase, 'zzz alpha', signals, 0, null, [], undefined, 'tasktrackr');
    const b = service.cacheKey(phase, 'zzz alpha', signals, 0, null, [], undefined, 'tasktrackr-b');
    expect(a).not.toBe(b);
  });
});
