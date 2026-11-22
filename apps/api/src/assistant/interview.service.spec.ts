import 'reflect-metadata';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { register } from 'prom-client';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import type { InterviewBrief } from '../content/content.types';
import {
  ALL_ENTITIES,
  AiCacheEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SettingEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { NotesService } from '../instructor/notes.service';
import { aiReviewRejections } from '../observability/metrics';
import { WorkflowService } from '../workflow/workflow.service';
import { AssistantService, INTERVIEW_USAGE_PROVIDER } from './assistant.service';
import {
  InterviewService,
  STAKEHOLDER_REQUEST_TIMEOUT_MS,
  matchFact,
  splitFactsLine,
  stakeholderFailureCode,
} from './interview.service';
import { LocalMentorProvider } from './local.provider';
import { OpenAiProvider, ProviderUsageError } from './openai.provider';
import type { InterviewReviewKey, InterviewReviewResult } from './interview-review';
import { AUTHORED_INTERVIEW_REVIEW_VERSION, INTERVIEW_REVIEW_VERSION, interviewReviewVersionOf } from './interview-review';

describe('stakeholder diagnostic classification',()=>{
  it.each([
    [new ProviderUsageError('Stakeholder review was incomplete or malformed',2,1),'malformed_review'],
    [new Error('AI provider stopped before completing its response'),'truncated_completion'],
    [new Error('AI provider returned an empty response'),'empty_completion'],
    [new SyntaxError('private malformed response text'),'malformed_json'],
    [new Error('openai api timed out after 60000ms'),'provider_timeout'],
    [new DOMException('private timeout detail','TimeoutError'),'provider_timeout'],
    [new DOMException('private cancelled detail','AbortError'),'cancelled'],
    [new Error('openai api returned HTTP 429'),'provider_http_429'],
    [new Error('openai api returned HTTP 503'),'provider_http_503'],
    [new TypeError('fetch failed'),'provider_network'],
    [new Error('openai api returned HTTP 401 private-secret'),'unavailable'],
    [new Error('private-key or candidate body'),'unavailable'],
  ])('maps controlled failure without retaining exception content (%#)',(error,expected)=>{
    expect(stakeholderFailureCode(error)).toBe(expected);
  });
});

/**
 * The interview, driven against the shipped TaskTrackr pack and a real
 * in-memory database.
 *
 * The paths that matter are the ones a class actually takes: no API key at all
 * (which is what CI and most laptops are), a key whose provider throws, a
 * legacy quota metadata that must be ignored, and a learner who asks the customer to write
 * the story. Unavailable or unreviewed replies must leave an explicit failure;
 * accepted replies must not author the learner's artefact.
 */
describe('InterviewService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let assistant: AssistantService;
  let workflow: WorkflowService;
  let brief: InterviewBrief;

  let userId = '';
  let phaseStateId = '';
  let otherPhaseStateId = '';

  const realKey = config.openaiApiKey;
  const manager = () => dataSource.manager;

  /** Most cases isolate persistence; semantic outcomes are explicitly mocked. */
  const build = (openai: Partial<OpenAiProvider>): InterviewService =>
    new InterviewService(
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(AssistantMessageEntity),
      workflow,
      content,
      assistant,
      { reviewInterview: jest.fn(async (input: { answer: string }) => ({ safe: true, failedChecks: [], supportedFactIds: brief.facts.filter(fact => fact.answer === input.answer).map(fact => fact.id), tokensIn: 0, tokensOut: 0 })), ...openai } as unknown as OpenAiProvider,
    );

  const offline = { available: false, name: 'openai' } as unknown as Partial<OpenAiProvider>;
  /** Provider test fixture, used only for persistence and cap tests. */
  const answering = () => ({ available: true, name: 'mock-ai', interview: jest.fn(async () => ({ content: `${brief.facts.find(f => f.id === 'F2')!.answer}`, provider: 'mock-ai', tokensIn: 0, tokensOut: 0 })) });

  /** One learner, enrolled, with the first phase open. Returns the phase state id. */
  const enrol = async (email: string): Promise<{ userId: string; first: string; second: string }> => {
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
    let first = '';
    let second = '';
    for (const phase of content.getProject('tasktrackr').phases) {
      const row = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId: user.id,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          // Both open, so a design-phase 404 is about the pack and not the gate.
          status: phase.order <= 2 ? 'in_progress' : 'locked',
          attempts: 0,
        }),
      );
      if (phase.order === 1) first = row.id;
      if (phase.order === 2) second = row.id;
    }
    return { userId: user.id, first, second };
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    brief = content.interviewBrief(content.getPhase('tasktrackr', 'requirements')) as InterviewBrief;
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    config.openaiApiKey = '';

    const feedback = { latestFor: async () => null } as unknown as FeedbackService;
    workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      feedback,
      dataSource,
    );
    assistant = new AssistantService(
      dataSource.getRepository(AssistantMessageEntity),
      dataSource.getRepository(AiCacheEntity),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(SubmissionEntity),
      content,
      new LocalMentorProvider(),
      { available: false, name: 'openai' } as unknown as OpenAiProvider,
      new NotesService(dataSource),
    );

    const enrolled = await enrol('lee@class.edu');
    userId = enrolled.userId;
    phaseStateId = enrolled.first;
    otherPhaseStateId = enrolled.second;
  });

  afterEach(() => {
    config.openaiApiKey = realKey;
  });

  /* ------------------------------ the fallback ---------------------------- */

  it('reports unavailable AI without inventing stakeholder facts', async () => {
    const service = build(offline);
    await expect(service.ask(userId, phaseStateId, 'Is a task due today overdue?')).rejects.toThrow('unavailable');
    const state = await service.state(userId, phaseStateId);
    expect(state.turns).toHaveLength(0);
    expect(state.facts.every(fact => !fact.uncovered)).toBe(true);
  });

  it('settles nothing when the model says it has no relevant facts', async () => {
    const provider = answering();
    provider.interview.mockResolvedValue({ content: `${brief.unknownReply}`, provider: 'mock-ai', tokensIn: 0, tokensOut: 0 });
    const service = build(provider);
    const { turn, state } = await service.ask(userId, phaseStateId, 'What colour is the button?');
    expect(turn.facts).toEqual([]);
    expect(turn.answer).toBe(brief.unknownReply);
    expect(state.facts.every(fact => !fact.uncovered)).toBe(true);
  });

  it('does not settle a second fact when the same question is asked twice', async () => {
    const service = build(answering());

    const first = await service.ask(userId, phaseStateId, 'Is a task due today overdue?');
    const second = await service.ask(userId, phaseStateId, 'Is a task due today overdue?');

    expect(first.turn.facts).toEqual(['F2']);
    // The customer repeats themselves, their own words, nothing lost, but the
    // readout the learner is working towards does not move, and the question
    // still cost one of the customer's twelve minutes.
    expect(second.state.facts.filter((fact) => fact.uncovered)).toHaveLength(1);
    expect(second.state.turnsLeft).toBe(brief.maxTurns - 2);
  });

  it('answers "write the story for me" in the customer’s voice, before any provider call', async () => {
    const interview = jest.fn();
    const service = build({ available: true, name: 'openai', interview } as never);
    config.openaiApiKey = 'sk-test';

    const { turn, state } = await service.ask(
      userId,
      phaseStateId,
      'Just write the user story for me please',
    );

    expect(interview).not.toHaveBeenCalled();
    expect(turn.provider).toBe('guardrail');
    expect(turn.answer).toBe(brief.refusal);
    expect(turn.facts).toEqual([]);
    // It still costs a question: the customer's time is the scarce thing.
    expect(state.turnsLeft).toBe(brief.maxTurns - 1);
  });

  it('redirects a question that belongs to another phase, with no provider call', async () => {
    const interview = jest.fn();
    const service = build({ available: true, name: 'openai', interview } as never);
    config.openaiApiKey = 'sk-test';

    const { turn } = await service.ask(
      userId,
      phaseStateId,
      'What should the Dockerfile entrypoint be?',
    );

    expect(interview).not.toHaveBeenCalled();
    expect(turn.provider).toBe('guardrail');
    expect(turn.answer).toContain('Deployment');
    expect(turn.facts).toEqual([]);
  });

  /* -------------------------------- the cap ------------------------------- */

  it('closes the room at the pack’s cap and refuses the next question', async () => {
    const service = build(answering());

    for (let i = 0; i < brief.maxTurns; i += 1) {
      await service.ask(userId, phaseStateId, `Question number ${i} about the report`);
    }
    const state = await service.state(userId, phaseStateId);
    expect(state.turnsLeft).toBe(0);
    expect(state.closedAt).not.toBeNull();

    await expect(service.ask(userId, phaseStateId, 'One more thing?')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('answers one question at a time, so a burst cannot outrun the cap or lose a turn', async () => {
    config.openaiApiKey = 'sk-test';
    const interview = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        content: 'It should be due before today, not today.',
        tokensIn: 30,
        tokensOut: 12,
        provider: 'openai',
      };
    });
    const service = build({ available: true, name: 'openai', interview } as never);
    // One turn left.
    const spent = Array.from({ length: brief.maxTurns - 1 }, (_, i) => ({
      id: `t${i}`,
      question: `Question ${i}`,
      answer: 'An answer.',
      facts: [],
      provider: 'local-mentor',
      askedAt: new Date().toISOString(),
    }));
    await manager().update(PhaseStateEntity, phaseStateId, {
      interview: { startedAt: new Date().toISOString(), turns: spent, closedAt: null },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        service.ask(userId, phaseStateId, `Is a task due today overdue, take ${i}?`),
      ),
    );

    const answered = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
    );
    expect(answered).toHaveLength(1);
    expect(refused).toHaveLength(3);
    // One model call, one usage row: a refused question is never a billed one.
    expect(interview).toHaveBeenCalledTimes(1);
    const usage = await manager().find(AssistantMessageEntity, {
      where: { provider: INTERVIEW_USAGE_PROVIDER },
    });
    expect(usage).toHaveLength(1);
    const state = await service.state(userId, phaseStateId);
    expect(state.turns).toHaveLength(brief.maxTurns);
    expect(state.turnsLeft).toBe(0);
    expect(state.closedAt).not.toBeNull();
  });

  it('refuses to write over a record another process moved while the customer was thinking', async () => {
    config.openaiApiKey = 'sk-test';
    // The model call is where another API process would land its own turn.
    const interview = jest.fn(async () => {
      const row = await manager().findOneByOrFail(PhaseStateEntity, { id: phaseStateId });
      await manager().update(PhaseStateEntity, phaseStateId, {
        interview: {
          startedAt: row.interview?.startedAt ?? new Date().toISOString(),
          turns: [
            ...(row.interview?.turns ?? []),
            {
              id: 'elsewhere',
              question: 'Asked on another node',
              answer: 'Answered there.',
              facts: [],
              provider: 'local-mentor',
              askedAt: new Date().toISOString(),
            },
          ],
          closedAt: null,
        },
      });
      return { content: 'No.', tokensIn: 3, tokensOut: 2, provider: 'openai' };
    });
    const service = build({ available: true, name: 'openai', interview } as never);

    await expect(
      service.ask(userId, phaseStateId, 'Is a task due today overdue?'),
    ).rejects.toBeInstanceOf(ConflictException);
    // The other node's turn is the one that stands.
    const state = await service.state(userId, phaseStateId);
    expect(state.turns.map((turn) => turn.id)).toEqual(['elsewhere']);
  });

  /* ------------------------------- the model ------------------------------ */

  it('reviews a plain answer without generator tags, persists only reviewed credit and bills the turn', async () => {
    config.openaiApiKey = 'sk-test';
    const interview = jest.fn(async () => ({
      content: 'It is for whoever opens it in the morning.',
      tokensIn: 90,
      tokensOut: 30,
      provider: 'openai',
    }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview: jest.fn(async () => ({ safe: true, failedChecks: [], supportedFactIds: ['F1'], tokensIn: 0, tokensOut: 0 })) } as never);

    const { turn, usage } = await service.ask(userId, phaseStateId, 'Who reads the report?');

    expect(turn.provider).toBe('openai');
    expect(turn.answer).toBe('It is for whoever opens it in the morning.');
    expect(turn.answer).not.toContain('FACTS');
    expect(turn.facts).toContain('F1');
    expect(usage.todayTokens).toBe(120);

    // The row is bookkeeping, not conversation: no user row, and the transcript
    // and the hint count never see it.
    const rows = await dataSource.getRepository(AssistantMessageEntity).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'assistant', provider: INTERVIEW_USAGE_PROVIDER });
    expect(await assistant.history(userId, phaseStateId)).toEqual([]);
  });

  it('never accepts an untagged answer without the independent review', async () => {
    const interview = jest.fn(async () => ({ content: 'A task due today is not overdue.', tokensIn: 10, tokensOut: 12, provider: 'openai' }));
    const reviewInterview = jest.fn(async () => { throw new Error('Malformed semantic review'); });
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    await expect(service.ask(userId, phaseStateId, 'Is a task due today overdue?')).rejects.toThrow('reliable answer');
    expect(reviewInterview).toHaveBeenCalledWith(expect.objectContaining({ answer: 'A task due today is not overdue.', claimedFactIds: [] }), expect.any(AbortSignal));
    expect((await service.state(userId, phaseStateId)).turns).toEqual([]);
    expect(await assistant.tokensToday(userId)).toBe(22);
  });

  it('does not derive any fact credit from the untagged answer without supported review evidence', async () => {
    const interview = jest.fn(async () => ({ content: 'That particular unfinished task due yesterday appears.', tokensIn: 10, tokensOut: 12, provider: 'openai' }));
    const reviewInterview = jest.fn(async () => ({ safe: true, failedChecks: [], supportedFactIds: [], tokensIn: 5, tokensOut: 3 }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    const response = await service.ask(userId, phaseStateId, 'Does this one task appear?');
    expect(response.turn.answer).toBe('That particular unfinished task due yesterday appears.');
    expect(response.turn.facts).toEqual([]);
    expect(response.state.facts.every(fact => !fact.uncovered)).toBe(true);
    expect(response.usage.todayTokens).toBe(30);
  });

  /* --------------- the paraphrase says what the fact says -------------------- */

  it('never delivers a paraphrase that inverts the fact it settles', async () => {
    config.openaiApiKey = 'sk-test';
    // Word for word what qwen2.5-0.5b answered to "if a task is due today, is
    // it overdue?". Unchecked, the room would stamp "Settled: whether a task
    // due today is overdue" underneath it, and AC-2 is the
    // boundary phase 3's hidden tests and phase 4's mutants both turn on.
    const interview = jest.fn(async () => ({
      content:
        "Yes, a task due today is considered overdue. It's not late this morning; it's later " +
        'tomorrow when you plan to work on the task.',
      tokensIn: 60,
      tokensOut: 40,
      provider: 'openai',
    }));
    const reviewInterview = jest.fn(async () => ({ safe: false, failedChecks: ['grounded'], supportedFactIds: [], tokensIn: 30, tokensOut: 10 }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview } as never);

    await expect(service.ask(userId, phaseStateId, 'Is a task due today overdue?')).rejects.toThrow('reliable answer');
    expect(reviewInterview).toHaveBeenCalledWith(expect.objectContaining({ brief, claimedFactIds: [], answer: expect.stringContaining('Yes, a task due today is considered overdue') }), expect.any(AbortSignal));
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    // The tokens were spent upstream and stay on the ledger.
    const rows = await dataSource.getRepository(AssistantMessageEntity).find();
    // An unchanged rejected candidate is not re-reviewed for a different vote.
    expect(interview).toHaveBeenCalledTimes(2);
    expect(reviewInterview).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);
    expect(rows.reduce((total, row) => total + row.tokensIn + row.tokensOut, 0)).toBe(240);
  });

  it('accepts a reviewed mixed answer without confusing overdue tasks with excluded task types', async () => {
    const answer = 'Overdue tasks have a due date before today and are unfinished. Tasks due today are not overdue. Completed tasks and tasks with no due date do not appear.';
    const reviewInterview = jest.fn(async () => ({ safe: true, failedChecks: [], supportedFactIds: ['F2', 'F3', 'F5'], tokensIn: 40, tokensOut: 15 }));
    const service = build({ available: true, name: 'openai', interview: jest.fn(async () => ({ content: `${answer}`, provider: 'openai', tokensIn: 20, tokensOut: 30 })), reviewInterview });
    const { turn, usage } = await service.ask(userId, phaseStateId, 'What is overdue and which tasks are excluded?');
    expect(turn).toMatchObject({ answer, facts: ['F2', 'F3', 'F5'], provider: 'openai' });
    expect(reviewInterview).toHaveBeenCalledWith({ answer, brief, claimedFactIds: [], question: 'What is overdue and which tasks are excluded?' }, expect.any(AbortSignal));
    expect(usage.todayTokens).toBe(105);
    expect((await service.state(userId, phaseStateId)).facts.filter(fact => fact.uncovered).map(fact => fact.id)).toEqual(['F2', 'F3', 'F5']);
  });

  it('saves a useful grounded example with only independently supported fact credit, independently of generator metadata', async () => {
    const answer = 'The unfinished task due yesterday appears. A task without a due date never appears.';
    const reviewInterview = jest.fn(async () => ({ safe: true, failedChecks: [], supportedFactIds: ['F5'], tokensIn: 40, tokensOut: 15 }));
    const interview = jest.fn(async () => ({ content: `${answer}`, provider: 'openai', tokensIn: 20, tokensOut: 30 }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    const response = await service.ask(userId, phaseStateId, 'Which of these two tasks appears?');
    expect(response.turn).toMatchObject({ answer, facts: ['F5'] });
    expect(response.state.facts.filter(fact => fact.uncovered).map(fact => fact.id)).toEqual(['F5']);
    expect((await dataSource.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseStateId })).interview!.turns).toEqual([response.turn]);
    expect(interview).toHaveBeenCalledTimes(1);
    expect(reviewInterview).toHaveBeenCalledTimes(1);
    expect(response.usage.todayTokens).toBe(105);
  });

  it('can record a useful partial example without granting any full-rule credit or advancing the project', async () => {
    const prior = await dataSource.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseStateId });
    const answer = 'That one unfinished task due yesterday appears.';
    const reviewInterview = jest.fn(async () => ({ safe: true, failedChecks: [], supportedFactIds: [], tokensIn: 40, tokensOut: 15 }));
    const service = build({ available: true, name: 'openai', interview: jest.fn(async () => ({ content: `${answer}`, provider: 'openai', tokensIn: 20, tokensOut: 30 })), reviewInterview });
    const response = await service.ask(userId, phaseStateId, 'What happens to this example task?');
    expect(response.turn).toMatchObject({ answer, facts: [] });
    expect(response.state.facts.every(fact => !fact.uncovered)).toBe(true);
    const after = await dataSource.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseStateId });
    expect({ status: after.status, attempts: after.attempts, passedAt: after.passedAt }).toEqual({ status: prior.status, attempts: prior.attempts, passedAt: prior.passedAt });
  });

  it('never turns a blank provider candidate into an authored unknown reply', async () => {
    const reviewInterview = jest.fn();
    const service = build({ available: true, name: 'openai', interview: jest.fn(async () => ({ content: ' \n\t', provider: 'openai', tokensIn: 7, tokensOut: 2 })), reviewInterview });
    await expect(service.ask(userId, phaseStateId, 'What happens today?')).rejects.toThrow('reliable answer');
    expect(reviewInterview).not.toHaveBeenCalled();
    expect((await service.state(userId, phaseStateId)).turns).toEqual([]);
    expect(await assistant.tokensToday(userId)).toBe(9);
  });

  it('keeps the answer and facts unrecorded until the separate review finishes', async () => {
    let completeReview!: (value: InterviewReviewResult & { tokensIn: number; tokensOut: number }) => void;
    const reviewInterview = jest.fn(() => new Promise<InterviewReviewResult & { tokensIn: number; tokensOut: number }>(resolve => { completeReview = resolve; }));
    const service = build({ ...answering(), reviewInterview });
    const asking = service.ask(userId, phaseStateId, 'Is a task due today overdue?');
    while (!reviewInterview.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    completeReview({ safe: true, failedChecks: [], supportedFactIds: ['F2'], tokensIn: 5, tokensOut: 3 });
    await asking;
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(1);
  });

  it('appends a reviewed greeting after F2/F5 without changing prior history, settled coverage or phase gates',async()=>{
    const interview=jest.fn()
      .mockResolvedValueOnce({content:'A task due today is not overdue. A task with no due date is never overdue.',provider:'openai',tokensIn:12,tokensOut:8})
      .mockResolvedValueOnce({content:'Hello! What would you like to ask about the report?',provider:'openai',tokensIn:12,tokensOut:8});
    const reviewInterview=jest.fn()
      .mockResolvedValueOnce({safe:true,failedChecks:[],supportedFactIds:['F2','F5'],tokensIn:14,tokensOut:6})
      .mockResolvedValueOnce({safe:true,failedChecks:[],supportedFactIds:[],tokensIn:14,tokensOut:6});
    const service=build({available:true,name:'openai',interview,reviewInterview});
    const earlier=await service.ask(userId,phaseStateId,'Are due-today and undated tasks overdue?');
    const phaseBefore=await dataSource.getRepository(PhaseStateEntity).findOneByOrFail({id:phaseStateId});
    const greeting=await service.ask(userId,phaseStateId,'hello');
    expect(greeting.turn).toMatchObject({question:'hello',facts:[],provider:'openai'});
    expect(greeting.state.turns).toEqual([...earlier.state.turns,greeting.turn]);
    expect(greeting.state.facts).toEqual(earlier.state.facts);
    expect(greeting.state.turnsLeft).toBe(earlier.state.turnsLeft-1);
    expect(greeting.state.startedAt).toBe(earlier.state.startedAt);
    expect(greeting.usage.todayTokens).toBe(80);
    expect(reviewInterview).toHaveBeenLastCalledWith(expect.objectContaining({question:'hello',answer:greeting.turn.answer,claimedFactIds:[]}),expect.any(AbortSignal));
    expect((await service.state(userId,phaseStateId))).toEqual(greeting.state);
    const phaseAfter=await dataSource.getRepository(PhaseStateEntity).findOneByOrFail({id:phaseStateId});
    expect({status:phaseAfter.status,attempts:phaseAfter.attempts,passedAt:phaseAfter.passedAt}).toEqual({status:phaseBefore.status,attempts:phaseBefore.attempts,passedAt:phaseBefore.passedAt});
    expect(interview).toHaveBeenCalledTimes(2);expect(reviewInterview).toHaveBeenCalledTimes(2);
  });

  // A teacher's interview is reviewed under the
  // authored prompt, so its diagnostic names that prompt's version, and the
  // reference interview keeps naming its own.
  it('names the authored review version in the diagnostic of a teacher interview', async () => {
    const authored = { ...brief, facts: brief.facts.map((fact, at) => at === 0 ? { ...fact, answer: `${fact.answer} (a teacher's own wording)` } : fact) };
    expect(interviewReviewVersionOf(authored)).toBe(AUTHORED_INTERVIEW_REVIEW_VERSION);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const requestId = '3f0c6a52-1d7e-4c55-9d1b-6f7c2b1e9a40';
      const service = build({ available: true, name: 'openai', interview: jest.fn(async () => { throw new Error('upstream private-secret-canary'); }) });
      jest.spyOn(service as unknown as { briefFor: (phase: unknown) => unknown }, 'briefFor').mockReturnValue(authored);
      const failure = await service.ask(userId, phaseStateId, 'private-question-authored', requestId).catch(error => error);
      expect(failure.getResponse()).toMatchObject({ code: 'STAKEHOLDER_REPLY_WITHHELD' });
      const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('Stakeholder diagnostic'));
      expect(lines).toEqual([`Stakeholder diagnostic rid=${requestId} version=${AUTHORED_INTERVIEW_REVIEW_VERSION} stage=generation attempt=1 code=unavailable`]);
      expect(lines.join('\n')).not.toMatch(/private-question|private-secret-canary|teacher's own wording/);
    } finally {
      warn.mockRestore();
    }
  });

  it('correlates separate concurrent provider failures without leaking either private question or exception', async()=>{
    const second=await enrol('diagnostic-second@example.test');
    const refs=['7b102d2c-837e-4fb5-abee-cbeaf8232d49','92ece9dc-c1a1-4553-a748-a6fd70fc1185'];
    const pending=new Map<string,(error:Error)=>void>();
    const interview=jest.fn((_brief,_title,question:string)=>new Promise<never>((_resolve,reject)=>pending.set(question,reject)));
    const service=build({available:true,name:'openai',interview});
    const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
    try {
      const first=service.ask(userId,phaseStateId,'private-question-one',refs[0]).catch(error=>error);
      const other=service.ask(second.userId,second.first,'private-question-two',refs[1]).catch(error=>error);
      while(pending.size<2)await new Promise(resolve=>setImmediate(resolve));
      pending.get('private-question-two')!(new ProviderUsageError('AI provider stopped before completing its response',8,3));
      pending.get('private-question-one')!(new Error('upstream private-secret-canary'));
      for(const result of await Promise.all([first,other]))expect(result.getResponse()).toMatchObject({code:'STAKEHOLDER_REPLY_WITHHELD'});
      const lines=warn.mock.calls.map(call=>String(call[0])).filter(line=>line.startsWith('Stakeholder diagnostic'));
      expect(lines).toHaveLength(2);
      expect(lines).toContain(`Stakeholder diagnostic rid=${refs[0]} version=${INTERVIEW_REVIEW_VERSION} stage=generation attempt=1 code=unavailable`);
      expect(lines).toContain(`Stakeholder diagnostic rid=${refs[1]} version=${INTERVIEW_REVIEW_VERSION} stage=generation attempt=1 code=truncated_completion`);
      expect(lines.join('\n')).not.toMatch(/private-question|private-secret-canary/);
      expect((await service.state(userId,phaseStateId)).turns).toEqual([]);
      expect((await service.state(second.userId,second.first)).turns).toEqual([]);
      expect(await assistant.tokensToday(userId)).toBe(0);
      expect(await assistant.tokensToday(second.userId)).toBe(11);
      expect(interview).toHaveBeenCalledTimes(2);
    } finally {warn.mockRestore();}
  });

  describe('reviewed conversational redirects and clarification (mocked semantic decisions)',()=>{
    const initialAnswer='A task with no due date is never overdue.';
    const completion=(answer:string)=>({content:answer,provider:'openai',tokensIn:12,tokensOut:8});
    const approved=(facts:string[])=>({safe:true,failedChecks:[],supportedFactIds:facts,tokensIn:14,tokensOut:6});
    const progress=async()=>({
      enrollments:await manager().find(EnrollmentEntity,{where:{userId},select:['id','currentPhaseOrder']}),
      phases:await manager().find(PhaseStateEntity,{where:{userId},select:['id','status','attempts','passedAt','workspace'],order:{phaseOrder:'ASC'}}),
    });

    it.each([
      {kind:'unrelated-topic redirect',question:'What is the weather in Paris?',answer:'I am here to discuss what I need from TaskTrackr. What would you like to know about the overdue report?',facts:[]},
      {kind:'unclear-message clarification',question:'What about that thing?',answer:'Which part of the overdue report do you mean?',facts:[]},
      {kind:'mixed unrelated and TaskTrackr question',question:'What is the weather in Paris, and is a task due today overdue?',answer:'I cannot help with weather here. For TaskTrackr, a task due today is not overdue; it becomes late tomorrow morning.',facts:['F2']},
    ])('persists an AI-reviewed $kind only after review, preserving earlier turns and gates',async({question,answer,facts})=>{
      const interview=jest.fn().mockResolvedValueOnce(completion(initialAnswer)).mockResolvedValueOnce(completion(answer));
      let finishReview!: (value:ReturnType<typeof approved>)=>void;
      const reviewInterview=jest.fn().mockResolvedValueOnce(approved(['F5']))
        .mockImplementationOnce(()=>new Promise(resolve=>{finishReview=resolve;}));
      const service=build({available:true,name:'openai',interview,reviewInterview});
      const prior=await service.ask(userId,phaseStateId,'Can an undated task be overdue?');
      const gates=await progress();
      const asking=service.ask(userId,phaseStateId,question);
      while(reviewInterview.mock.calls.length<2)await new Promise(resolve=>setImmediate(resolve));
      expect(await service.state(userId,phaseStateId)).toEqual(prior.state);
      expect(reviewInterview).toHaveBeenLastCalledWith({brief,question,answer,claimedFactIds:[]},expect.any(AbortSignal));
      finishReview(approved(facts));
      const result=await asking;
      expect(result.turn).toMatchObject({question,answer,facts,provider:'openai'});
      expect(result.state.turns).toEqual([...prior.state.turns,result.turn]);
      expect(result.state.facts.filter(fact=>fact.uncovered).map(fact=>fact.id).sort()).toEqual([...facts,'F5'].sort());
      expect(result.state.startedAt).toBe(prior.state.startedAt);
      expect(result.state.turnsLeft).toBe(prior.state.turnsLeft-1);
      expect(await service.state(userId,phaseStateId)).toEqual(result.state);
      expect(await progress()).toEqual(gates);
      expect(result.usage.todayTokens).toBe(80);
      expect(interview).toHaveBeenCalledTimes(2);expect(reviewInterview).toHaveBeenCalledTimes(2);
      expect(await dataSource.getRepository(AssistantMessageEntity).count()).toBe(4);
    });

    it.each(['rejected','malformed_review','provider_timeout'] as const)('keeps prior history, facts and gates when an off-topic response is %s',async(kind)=>{
      const interview=jest.fn().mockResolvedValueOnce(completion(initialAnswer));
      const reviewInterview=jest.fn().mockResolvedValueOnce(approved(['F5']));
      if(kind==='provider_timeout')interview.mockRejectedValueOnce(new ProviderUsageError('openai api timed out after 60000ms',2,1));
      else if(kind==='malformed_review'){
        interview.mockResolvedValueOnce(completion('I can discuss TaskTrackr needs. What would you like to ask about the report?'));
        reviewInterview.mockRejectedValueOnce(new ProviderUsageError('Stakeholder review was incomplete or malformed',2,1));
      }else{
        interview.mockResolvedValueOnce(completion('TaskTrackr must send the weather by email.'))
          .mockResolvedValueOnce(completion('I require daily weather notifications in TaskTrackr.'));
        reviewInterview.mockResolvedValue({safe:false,failedChecks:['grounded'],supportedFactIds:[],tokensIn:14,tokensOut:6});
      }
      const service=build({available:true,name:'openai',interview,reviewInterview});
      const prior=await service.ask(userId,phaseStateId,'Can an undated task be overdue?');
      const gates=await progress();
      const failure=await service.ask(userId,phaseStateId,'What is the weather in Paris?').catch(error=>error);
      expect(failure.getResponse()).toMatchObject({statusCode:503,code:'STAKEHOLDER_REPLY_WITHHELD'});
      expect(await service.state(userId,phaseStateId)).toEqual(prior.state);
      expect(await progress()).toEqual(gates);
      expect(interview).toHaveBeenCalledTimes(kind==='rejected'?3:2);
      expect(reviewInterview).toHaveBeenCalledTimes(kind==='rejected'?3:kind==='malformed_review'?2:1);
      expect(await assistant.tokensToday(userId)).toBe(kind==='rejected'?120:kind==='malformed_review'?63:43);
    });
  });

  it.each([false, true])('review failure cannot record a fact and accounts only actual partial usage (reported=%s)', async reported => {
    const reviewInterview = jest.fn(async () => { throw reported ? new ProviderUsageError('Malformed review', 8, 3) : new Error('Review disconnected'); });
    const provider = answering();
    const service = build({ ...provider, reviewInterview });
    const failure = await service.ask(userId, phaseStateId, 'Is a task due today overdue?').catch(error => error);
    expect(failure.getResponse()).toMatchObject({ statusCode: 503, code: 'STAKEHOLDER_REPLY_WITHHELD' });
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    expect((await service.state(userId, phaseStateId)).facts.every(fact => !fact.uncovered)).toBe(true);
    expect(await assistant.tokensToday(userId)).toBe(reported ? 11 : 0);
    expect(provider.interview).toHaveBeenCalledTimes(1);
    expect(reviewInterview).toHaveBeenCalledTimes(1);
  });

  it('records only a corrected candidate after its own completed review, with usage from all four calls', async () => {
    const question = 'Is a task due today overdue?';
    const rejected = 'A task due today is overdue.';
    const corrected = 'A task due today is not overdue; it is late tomorrow if still unfinished.';
    const interview = jest.fn()
      .mockResolvedValueOnce({ content: `${rejected}`, provider: 'openai', tokensIn: 60, tokensOut: 40 })
      .mockResolvedValueOnce({ content: `${corrected}`, provider: 'openai', tokensIn: 60, tokensOut: 40 });
    let finishReview!: (value: InterviewReviewResult & { tokensIn: number; tokensOut: number }) => void;
    const reviewInterview = jest.fn()
      .mockResolvedValueOnce({ safe: false, failedChecks: ['grounded'], supportedFactIds: [], tokensIn: 30, tokensOut: 10 })
      .mockImplementationOnce(() => new Promise(resolve => { finishReview = resolve; }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    const asking = service.ask(userId, phaseStateId, question);
    while (reviewInterview.mock.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    expect((await service.state(userId, phaseStateId)).facts.every(fact => !fact.uncovered)).toBe(true);
    expect(interview.mock.calls[1]).toEqual([brief, content.getProject('tasktrackr').title, question, [], { answer: rejected, facts: [], failedChecks: ['grounded'] }, expect.any(AbortSignal)]);
    expect(reviewInterview.mock.calls[1]).toEqual([{ brief, question, answer: corrected, claimedFactIds: [] }, interview.mock.calls[1][5]]);
    finishReview({ safe: true, failedChecks: [], supportedFactIds: ['F2'], tokensIn: 30, tokensOut: 10 });
    const response = await asking;
    expect(response.turn).toMatchObject({ question, answer: corrected, facts: ['F2'], provider: 'openai' });
    expect(response.state.turns).toEqual([response.turn]);
    expect(response.usage.todayTokens).toBe(280);
    expect(await dataSource.getRepository(AssistantMessageEntity).count()).toBe(4);
    expect(interview).toHaveBeenCalledTimes(2);
    expect(reviewInterview).toHaveBeenCalledTimes(2);
  });

  it('stops after a second distinct rejected answer without settling any facts', async () => {
    const interview = jest.fn()
      .mockResolvedValueOnce({ content: 'Tasks due today are overdue.', provider: 'openai', tokensIn: 60, tokensOut: 40 })
      .mockResolvedValueOnce({ content: 'Any due date today belongs in the overdue report.', provider: 'openai', tokensIn: 60, tokensOut: 40 });
    const reviewInterview = jest.fn(async () => ({ safe: false, failedChecks: ['grounded'] as InterviewReviewKey[], supportedFactIds: [], tokensIn: 30, tokensOut: 10 }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    await expect(service.ask(userId, phaseStateId, 'Is today overdue?')).rejects.toThrow('reliable answer');
    expect(interview).toHaveBeenCalledTimes(2);
    expect(reviewInterview).toHaveBeenCalledTimes(2);
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    expect((await service.state(userId, phaseStateId)).facts.every(fact => !fact.uncovered)).toBe(true);
    expect(await assistant.tokensToday(userId)).toBe(280);
  });

  /* ------------ the repair counter · how often a turn costs four calls ------- */

  /**
   * A repaired turn is two model calls plus two more, and the reviewed
   * explanation could only guess how often that happens because nothing
   * counted it. The counter is the count and nothing else: it must not change
   * the answer, the error, the ledger or anything the learner is shown, and a
   * broken registry must cost a sample rather than a question.
   */
  describe('semantic rejections on the metrics registry', () => {
    /** ai_review_rejections_total for the interview surface, as Prometheus would scrape it. */
    const counted = async (): Promise<Record<string, number>> => {
      const { values } = await register.getSingleMetric('ai_review_rejections_total')!.get();
      const byAttempt: Record<string, number> = {};
      for (const value of values) {
        // A series per failed check, so an attempt sums its checks.
        if (value.labels.surface === 'interview') byAttempt[String(value.labels.attempt)] = (byAttempt[String(value.labels.attempt)] ?? 0) + value.value;
      }
      return byAttempt;
    };

    /** Deltas, because the registry is process-wide and outlives one test. */
    const since = (
      before: Record<string, number>,
      after: Record<string, number>,
    ): Record<string, number> => {
      const moved: Record<string, number> = {};
      for (const attempt of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
        const delta = (after[attempt] ?? 0) - (before[attempt] ?? 0);
        if (delta) moved[attempt] = delta;
      }
      return moved;
    };

    /** One rejected draft, then a corrected one the reviewer accepts. */
    const repaired = (corrected: string) => ({
      available: true,
      name: 'openai',
      interview: jest.fn()
        .mockResolvedValueOnce({ content: 'A task due today is overdue.', provider: 'openai', tokensIn: 60, tokensOut: 40 })
        .mockResolvedValueOnce({ content: `${corrected}`, provider: 'openai', tokensIn: 60, tokensOut: 40 }),
      reviewInterview: jest.fn()
        .mockResolvedValueOnce({ safe: false, failedChecks: ['grounded'], supportedFactIds: [], tokensIn: 30, tokensOut: 10 })
        .mockResolvedValueOnce({ safe: true, failedChecks: [], supportedFactIds: ['F2'], tokensIn: 30, tokensOut: 10 }),
    });

    it('counts the first rejection of a repaired turn and hands the learner the same accepted answer', async () => {
      const corrected = 'A task due today is not overdue; it is late tomorrow morning.';
      const service = build(repaired(corrected));
      const before = await counted();

      const response = await service.ask(userId, phaseStateId, 'Is a task due today overdue?');

      expect(since(before, await counted())).toEqual({ '1': 1 });
      expect(response.turn).toMatchObject({ answer: corrected, facts: ['F2'], provider: 'openai' });
      // Nothing new reaches the learner: the turn carries the same six keys.
      expect(Object.keys(response.turn).sort()).toEqual(['answer', 'askedAt', 'facts', 'id', 'provider', 'question']);
      expect(Object.keys(response).sort()).toEqual(['state', 'turn', 'usage']);
      expect(response.usage.todayTokens).toBe(280);
    });

    it('counts both rejections of a turn that never recovered, and withholds the same reply', async () => {
      const interview = jest.fn()
        .mockResolvedValueOnce({ content: 'Tasks due today are overdue.', provider: 'openai', tokensIn: 60, tokensOut: 40 })
        .mockResolvedValueOnce({ content: 'Any due date today belongs in the overdue report.', provider: 'openai', tokensIn: 60, tokensOut: 40 });
      const reviewInterview = jest.fn(async () => ({ safe: false, failedChecks: ['grounded'] as InterviewReviewKey[], supportedFactIds: [], tokensIn: 30, tokensOut: 10 }));
      const service = build({ available: true, name: 'openai', interview, reviewInterview });
      const before = await counted();

      const failure = await service.ask(userId, phaseStateId, 'Is today overdue?').catch(error => error);

      expect(failure.getResponse()).toEqual({ statusCode: 503, code: 'STAKEHOLDER_REPLY_WITHHELD', message: 'The stakeholder could not provide a reliable answer. Please retry.' });
      expect(since(before, await counted())).toEqual({ '1': 1, '2': 1 });
      expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
      expect(await assistant.tokensToday(userId)).toBe(280);
    });

    // The one count a rejected answer makes names the
    // check that failed it, from the same frozen set the Guided path uses.
    it('labels each rejected answer with its failed check, once per answer', async () => {
      const inc = jest.spyOn(aiReviewRejections, 'inc');
      try {
        const service = build(repaired('A task due today is not overdue.'));
        await service.ask(userId, phaseStateId, 'Is a task due today overdue?');
        expect(inc.mock.calls).toEqual([[{ surface: 'interview', attempt: '1', check: 'grounded' }]]);
      } finally {
        inc.mockRestore();
      }
    });

    it('counts nothing when the reviewer accepts the first answer', async () => {
      const service = build(answering());
      const before = await counted();

      await service.ask(userId, phaseStateId, 'Is a task due today overdue?');

      expect(since(before, await counted())).toEqual({});
    });

    it('loses the sample rather than the turn when the registry itself throws', async () => {
      const corrected = 'A task due today is not overdue.';
      const inc = jest.spyOn(aiReviewRejections, 'inc').mockImplementation(() => {
        throw new Error('registry exploded');
      });
      try {
        const service = build(repaired(corrected));

        const response = await service.ask(userId, phaseStateId, 'Is a task due today overdue?');

        expect(inc).toHaveBeenCalled();
        expect(response.turn).toMatchObject({ answer: corrected, facts: ['F2'], provider: 'openai' });
        expect((await service.state(userId, phaseStateId)).turns).toEqual([response.turn]);
      } finally {
        inc.mockRestore();
      }
    });
  });

  it('does not re-review identical rejected plain answers for a different vote', async () => {
    const answer = 'Tasks due today and undated tasks are overdue.';
    const interview = jest.fn()
      .mockResolvedValueOnce({ content: `${answer}`, provider: 'openai', tokensIn: 5, tokensOut: 5 })
      .mockResolvedValueOnce({ content: `${answer}`, provider: 'openai', tokensIn: 5, tokensOut: 5 });
    const reviewInterview = jest.fn(async () => ({ safe: false, failedChecks: ['grounded'] as InterviewReviewKey[], supportedFactIds: [], tokensIn: 5, tokensOut: 5 }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    await expect(service.ask(userId, phaseStateId, 'What is overdue?')).rejects.toThrow('reliable answer');
    expect(reviewInterview).toHaveBeenCalledTimes(1);
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    expect(await assistant.tokensToday(userId)).toBe(30);
  });

  it('does not re-review the same rejected spoken answer after surrounding whitespace changes', async () => {
    const answer = 'Tasks due today are overdue.';
    const interview = jest.fn()
      .mockResolvedValueOnce({ content: `  ${answer}  `, provider: 'openai', tokensIn: 5, tokensOut: 5 })
      .mockResolvedValueOnce({ content: `${answer}`, provider: 'openai', tokensIn: 5, tokensOut: 5 });
    const reviewInterview = jest.fn(async () => ({ safe: false, failedChecks: ['grounded'] as InterviewReviewKey[], supportedFactIds: [], tokensIn: 5, tokensOut: 5 }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    await expect(service.ask(userId, phaseStateId, 'Is a task due today overdue?')).rejects.toThrow('reliable answer');
    expect(interview).toHaveBeenCalledTimes(2);
    expect(reviewInterview).toHaveBeenCalledTimes(1);
    expect((await service.state(userId, phaseStateId)).turns).toEqual([]);
    expect(await assistant.tokensToday(userId)).toBe(30);
  });

  it.each(['generation', 'evidence', 'review'] as const)('withholds a failed correction at %s and meters only known usage once', async failureStage => {
    const interview = jest.fn()
      .mockResolvedValueOnce({ content: 'Tasks due today are overdue.', provider: 'openai', tokensIn: 60, tokensOut: 40 });
    if (failureStage === 'generation') interview.mockRejectedValueOnce(new ProviderUsageError('Provider interrupted', 8, 3));
    else interview.mockResolvedValueOnce({ content: failureStage === 'evidence' ? ' ' : 'Tasks due today are not overdue.', provider: 'openai', tokensIn: 60, tokensOut: 40 });
    const reviewInterview = jest.fn()
      .mockResolvedValueOnce({ safe: false, failedChecks: ['grounded'], supportedFactIds: [], tokensIn: 30, tokensOut: 10 })
      .mockRejectedValueOnce(new ProviderUsageError('Review incomplete', 8, 3));
    const service = build({ available: true, name: 'openai', interview, reviewInterview });
    await expect(service.ask(userId, phaseStateId, 'Is today overdue?')).rejects.toThrow('reliable answer');
    expect(interview).toHaveBeenCalledTimes(2);
    expect(reviewInterview).toHaveBeenCalledTimes(failureStage === 'review' ? 2 : 1);
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    expect(await assistant.tokensToday(userId)).toBe(failureStage === 'generation' ? 151 : failureStage === 'evidence' ? 240 : 251);
  });

  it.each(['generation', 'review'] as const)('expires an in-flight %s without letting an abort-ignoring late result save a turn', async pendingStage => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
    const requestId='830adf65-e5f8-4ec8-a4d0-2d93c54ad495';
    try {
      const generated = { content: 'Tasks due today are not overdue.', provider: 'openai', tokensIn: 7, tokensOut: 5 };
      const approved = { safe: true, failedChecks: [], supportedFactIds: ['F2'], tokensIn: 8, tokensOut: 3 };
      let resolveLate!: (value: unknown) => void;
      const pending = new Promise(resolve => { resolveLate = resolve; });
      const interview = jest.fn().mockImplementation(() => pendingStage === 'generation' ? pending : Promise.resolve(generated));
      const reviewInterview = jest.fn().mockImplementation(() => pending);
      const service = build({ available: true, name: 'openai', interview, reviewInterview });
      const failed = service.ask(userId, phaseStateId, 'Is today overdue?',requestId).catch(error => error);
      while (!(pendingStage === 'generation' ? interview : reviewInterview).mock.calls.length) await new Promise(resolve => setImmediate(resolve));
      const signal = interview.mock.calls[0][5] as AbortSignal;
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(STAKEHOLDER_REQUEST_TIMEOUT_MS);
      expect((await failed).getResponse()).toMatchObject({ statusCode: 503, code: 'STAKEHOLDER_REPLY_WITHHELD' });
      expect(signal.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith(`Stakeholder diagnostic rid=${requestId} version=${INTERVIEW_REVIEW_VERSION} stage=${pendingStage} attempt=1 code=request_deadline`);
      expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
      resolveLate(pendingStage === 'generation' ? generated : approved);
      // Wait for the detached provider mock to settle behind the real user
      // queue; it ignores abort deliberately to exercise the service boundary.
      await assistant.serialise(userId, async () => undefined);
      expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
      expect((await service.state(userId, phaseStateId)).facts.every(fact => !fact.uncovered)).toBe(true);
      expect(interview).toHaveBeenCalledTimes(1);
      expect(reviewInterview).toHaveBeenCalledTimes(pendingStage === 'generation' ? 0 : 1);
      expect(await assistant.tokensToday(userId)).toBe(pendingStage === 'generation' ? 12 : 23);
      expect(warn.mock.calls.filter(call=>String(call[0]).startsWith('Stakeholder diagnostic')).every(call=>String(call[0]).includes(`rid=${requestId}`))).toBe(true);
    } finally { warn.mockRestore();jest.useRealTimers(); }
  });

  it('includes the learner queue in its deadline and never starts an expired queued question', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let releasePredecessor!: () => void;
      const predecessor = assistant.serialise(userId, () => new Promise<void>(resolve => { releasePredecessor = resolve; }));
      while (!releasePredecessor) await new Promise(resolve => setImmediate(resolve));
      const provider = answering();
      const service = build(provider);
      const failed = service.ask(userId, phaseStateId, 'Is today overdue?').catch(error => error);
      await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(STAKEHOLDER_REQUEST_TIMEOUT_MS);
      expect((await failed).getResponse()).toMatchObject({ code: 'STAKEHOLDER_REPLY_WITHHELD' });
      expect(provider.interview).not.toHaveBeenCalled();
      releasePredecessor();
      await predecessor;
      await assistant.serialise(userId, async () => undefined);
      expect(provider.interview).not.toHaveBeenCalled();
      expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
      expect(await assistant.tokensToday(userId)).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('keeps a paraphrase that still says what the fact says', async () => {
    config.openaiApiKey = 'sk-test';
    const interview = jest.fn(async () => ({
      content: 'A task due today is not late until tomorrow morning.',
      tokensIn: 10,
      tokensOut: 12,
      provider: 'openai',
    }));
    const service = build({ available: true, name: 'openai', interview, reviewInterview: jest.fn(async () => ({ safe: true, failedChecks: [], supportedFactIds: ['F2'], tokensIn: 0, tokensOut: 0 })) } as never);

    const { turn } = await service.ask(userId, phaseStateId, 'Is a task due today overdue?');
    expect(turn.answer).toBe('A task due today is not late until tomorrow morning.');
    expect(turn.provider).toBe('openai');
    expect(turn.facts).toEqual(['F2']);
  });

  it('withholds a generated artifact without substituting a canned successful turn or consuming a question', async () => {
    config.openaiApiKey = 'sk-test';
    const interview = jest.fn(async () => ({
      content:
        'As a busy team lead, I want an overdue report, so that I catch what I missed.\n' +
        'Given an open task due yesterday, when I run the report, then it appears.\n' +
        'Given a task due today, when I run the report, then it does not appear.',
      tokensIn: 10,
      tokensOut: 60,
      provider: 'openai',
    }));
    const service = build({ available: true, name: 'openai', interview } as never);

    await expect(service.ask(userId, phaseStateId, 'Who uses the overdue report?')).rejects.toThrow('reliable answer');
    const state = await service.state(userId, phaseStateId);
    expect(state.turns).toHaveLength(0);
    expect(state.turnsLeft).toBe(brief.maxTurns);
    expect(state.facts.every(fact => !fact.uncovered)).toBe(true);
    // Reported provider usage is retained independently of saved turns.
    expect(await assistant.tokensToday(userId)).toBe(70);
  });

  it('fails visibly when the provider throws, without recording simulated facts', async () => {
    config.openaiApiKey = 'sk-test';
    const interview = jest.fn(async () => {
      throw new Error('upstream exploded');
    });
    const service = build({ available: true, name: 'openai', interview } as never);

    await expect(service.ask(userId, phaseStateId, 'Is a task due today overdue?')).rejects.toThrow('reliable answer');
    expect(interview).toHaveBeenCalledTimes(1);
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(0);
    // Nothing is billed for a call that never produced an answer.
    expect(await assistant.tokensToday(userId)).toBe(0);
  });

  it('ignores zero legacy user and global quotas while preserving actual usage diagnostics', async () => {
    config.openaiApiKey = 'sk-test';
    await dataSource.getRepository(SettingEntity).save({ key: 'aiDailyTokenBudget', value: '0' });
    await dataSource.getRepository(UserEntity).update(userId, { dailyTokenBudget: 0 });
    await dataSource.getRepository(AssistantMessageEntity).save(
      dataSource.getRepository(AssistantMessageEntity).create({
        userId,
        enrollmentId: (await manager().findOneByOrFail(PhaseStateEntity, { id: phaseStateId }))
          .enrollmentId,
        phaseStateId,
        phaseKey: 'requirements',
        role: 'assistant',
        content: 'spent',
        tokensIn: 1000000,
        tokensOut: 0,
      }),
    );
    const interview = jest.fn().mockResolvedValue({ content: 'It is for whoever opens it in the morning.', tokensIn: 90, tokensOut: 30, provider: 'openai' });
    const service = build({ available: true, name: 'openai', interview } as never);

    const result = await service.ask(userId, phaseStateId, 'Who reads the report?');
    expect(result.turn.provider).toBe('openai');
    expect(interview).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({ todayTokens: 1000120 });
    expect((await service.state(userId, phaseStateId)).turns).toHaveLength(1);
  });

  /* -------------------------------- scoping ------------------------------- */

  it('is a 404 on a phase whose pack declares no interview', async () => {
    const service = build(offline);
    await expect(service.state(userId, otherPhaseStateId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.ask(userId, otherPhaseStateId, 'Who reads this?')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses another learner’s phase, through the one ownership check', async () => {
    const service = build(offline);
    const bystander = await enrol('sam@class.edu');

    await expect(service.state(bystander.userId, phaseStateId)).rejects.toThrow('not your phase');
    await expect(
      service.ask(bystander.userId, phaseStateId, 'Who reads the report?'),
    ).rejects.toThrow('not your phase');
  });

  it('shows the topics and never the answers before the customer has said them', async () => {
    const service = build(offline);
    const state = await service.state(userId, phaseStateId);

    expect(state.turns).toEqual([]);
    expect(state.opening).toBe(brief.opening);
    expect(state.factsExpected).toBe(brief.factsExpected);
    const serialised = JSON.stringify(state);
    for (const fact of brief.facts) {
      expect(serialised).toContain(fact.topic);
      expect(serialised).not.toContain(fact.answer);
    }
  });
});

/* ---------------------------- the pure helpers ---------------------------- */

const testBrief: InterviewBrief = {
  persona: { name: 'Dana', role: 'owner' },
  opening: 'go',
  unknownReply: 'not decided',
  refusal: 'not the author',
  maxTurns: 4,
  factsExpected: 1,
  facts: [
    { id: 'F1', topic: 'who the report is for', keywords: ['who', 'audience'], answer: 'a' },
    { id: 'F2', topic: 'whether a task due today is overdue', keywords: ['due today'], answer: 'b' },
  ],
};

describe('matchFact', () => {
  it('scores a declared keyword above a shared topic word', () => {
    expect(matchFact(testBrief, 'is a task due today overdue?', [])?.id).toBe('F2');
    expect(matchFact(testBrief, 'who is the audience?', [])?.id).toBe('F1');
  });

  it('is null when nothing scores high enough', () => {
    expect(matchFact(testBrief, 'what colour is the button', [])).toBeNull();
    // One shared topic word alone is a brush past, not a question about it.
    expect(matchFact(testBrief, 'is the report long', [])).toBeNull();
  });

  it('discounts a fact the customer has already settled', () => {
    expect(matchFact(testBrief, 'and the audience?', [])?.id).toBe('F1');
    expect(matchFact(testBrief, 'and the audience?', ['F1'])).toBeNull();
  });
});

describe('splitFactsLine', () => {
  it('parses known IDs and strips the evidence line', () => {
    expect(splitFactsLine('Sure.\nFACTS: F1, F2', testBrief)).toEqual({
      answer: 'Sure.',
      facts: ['F1', 'F2'],
    });
  });

  it.each(['A task due today is not overdue.', 'Answer.\nFACTS: F99', 'Answer.\nFACTS: F1\nFACTS: F2', 'Answer.\nFACTS: none,F1', 'Answer.\nFACTS: F1\nExtra text.', 'FACTS: F1'])('refuses missing, invented or malformed evidence: %s', value => {
    expect(() => splitFactsLine(value, testBrief)).toThrow();
  });

  it('reads "FACTS: none" as nothing settled', () => {
    expect(splitFactsLine('I have not decided.\nFACTS: none', testBrief).facts).toEqual([]);
  });

  it('does not double-count an id the model repeated', () => {
    expect(() => splitFactsLine('x\nFACTS: F1 F1 F2', testBrief)).toThrow();
  });
});
