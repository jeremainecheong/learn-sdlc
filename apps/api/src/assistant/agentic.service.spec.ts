import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AgentProposalEntity } from './agent-proposal.entity';
import { AgentTurnEntity } from './agent-turn.entity';
import { AI_BUSY_MESSAGE, AiBusyError } from '../execution/run-gate';
import { AgenticService, AgenticUnavailableException, workspaceHash, AGENTIC_REQUEST_TIMEOUT_MS, AGENT_TURN_STALE_MS, AGENT_PROPOSING_STAGE_MAX, composeAgenticIntentAssessment, composeAgentChatAssessment, composeAgentChatGeneration, composeAgenticProposeGeneration, incompleteRegenerationSentence, INCOMPLETE_REASK_FIRST_MAX_MS, INCOMPLETE_REASK_SECOND_MAX_MS, readOnlyTargets, regenerationFits, regenerationSentence, REGENERATION_MIN_LEFT_MS, REGENERATION_REPLY_MS } from './agentic.service';
import { Logger } from '@nestjs/common';
import { config } from '../config';
import { AGENT_EDIT_LIST_SCHEMA_NAME } from './proposal-edits';
import { TRIM_NAMED_SENTENCE, TRIM_READ_ONLY_SENTENCE, TRIM_SAVED_SENTENCE } from './agentic-payload';
import { mentorInstructionIdentity } from './openai.provider';
import { ALL_ENTITIES, AssistantMessageEntity, ExecutionRunEntity, PhaseStateEntity, SettingEntity, UserEntity } from '../db/entities';
import { ProviderUsageError } from './openai.provider';
import { KeyedLock } from './assistant.service';
import { AI_CALL_LABELS } from './model-call-timing';
import { EXPLANATION_ASSESSMENT_PROMPT, STRUCTURED_EVIDENCE_RULE, STRUCTURED_MIXED_EVIDENCE_RULE, explanationAssessmentResponseSchema, explanationEvidence, learnerExplanationAssessment, UNDERSTANDING_DIMENSIONS } from './explanation-assessment';
import { EVIDENCE_MAX_RUNS, learnerRecordedEvidence } from './explanation-evidence';
import { EXPLANATION_REASK_FLOOR_MS, explanationReaskNote } from './explanation-reask';
import { CLASSIFY_REASK_FLOOR_MS, classifyReaskNote } from './classify-reask';
import type { DrillState, RunResult } from '@learnsdlc/shared';
import {
  API_CONTRACT_JSON, CHANGE_PROPOSAL_REFUSED, CHANGE_REQUEST_JSON, DEFAULT_DESIGN_FLOOR, DEFAULT_STORY_FLOOR, DESIGN_JSON, DESIGN_PROPOSAL_REFUSED, DESIGN_PROPOSAL_UNCHANGED,
  EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, EMPTY_STORY, RUNBOOK_JSON, RUNBOOK_PROPOSAL_REFUSED, STORY_JSON, floorSentence, serialiseChangeRequest, serialiseDesign,
  serialiseRunbook, serialiseStory, validateRunbookRecord, validateStoryRecord, type ChangeRequest, type Design, type Runbook,
} from '@learnsdlc/shared';
import { designBriefing } from './design-proposal';
import * as designGuard from '../workflow/design-record-guard';
import * as recordGuard from '../workflow/record-guard';
import { STORY_PROPOSAL_REFUSED } from './story-proposal';
import { FILES_PROPOSAL_REFUSED, RefusedProposalException } from './proposal-refusal';
import { ContentService } from '../content/content.service';
import { recordPack } from '../../test/record-pack';

/** What the assessment payload carries when this learner's work wrote no record at all. */
const NO_RECORDED_EVIDENCE = { recordedDrill: null, recordedRuns: [], recordedEdit: null };

/** The pending-turn progress hint, read the way the web reads it: strictly, or absent. */
const stageOf = (turn: unknown) => (turn as { stage?: unknown }).stage;
/** A door's refusal: its exact message (the fixed sentence, then the rule's reason), and the refusal lines it logged. */
const refusedAtDoor = async (run: () => Promise<unknown>, message: string) => {
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    await expect(run()).rejects.toMatchObject({ message });
    return log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('agentic_proposal_refused '));
  } finally { log.mockRestore(); }
};

/** A refusal built from the message a learner reads (sentence and reason), for the regeneration sentence's pins. */
class RefusedProbe extends RefusedProposalException {
  constructor(message: string, code: ConstructorParameters<typeof RefusedProposalException>[0] = 'files_proposal_refused', clause: ConstructorParameters<typeof RefusedProposalException>[1] = 'edit_list') {
    super(code, clause, message.startsWith(FILES_PROPOSAL_REFUSED) ? message.slice(FILES_PROPOSAL_REFUSED.length + 1) : null);
  }
}

/** Mocked-provider, real-SQLite tests of authority and persisted optimistic concurrency. */
describe('AgenticService authority and persistence', () => {
  let db: DataSource;
  let service: AgenticService;
  let provider: { available: boolean; name: string; structured: jest.Mock };
  const phase = { key: 'implementation', title: 'Implementation', taskPanel: 'TaskTrackr excludes today from overdue.', objectives: ['Implement overdue filtering'], files: [{ path: 'tasks.py', content: '# TODO', editable: true }] } as any;
  const good = { adequate: true, feedback: 'Explains strict date comparison and excludes completed work.', questions: [] };
  const bad = { adequate: false, feedback: 'No bounded intent or constraints.', questions: ['Which behavior and boundary should change?'] };
  const explanation = 'The strict date comparison excludes today; filtering completed work satisfies the overdue contract. Verify yesterday, today, future and completed tasks; the code alone does not prove execution passed.';
  const understanding = (met = true) => ({ dimensions: UNDERSTANDING_DIMENSIONS.map(key => ({ key, met: met || key === 'consistency', finding: met || key === 'consistency' ? 'supported' : 'missing', learnerEvidenceIds: met ? explanationEvidence(explanation).map(unit => unit.id) : key === 'consistency' ? ['E1'] : [] })) });
  const files = { 'tasks.py': 'return due < today and not completed' };
  const respond = (value: unknown) => ({ value, tokensIn: 10, tokensOut: 20 });
  const lock = new KeyedLock();
  const txnLock = new KeyedLock();
  let phaseId: string;

  beforeEach(async () => {
    phase.files = [{ path: 'tasks.py', content: '# TODO', editable: true }];
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [...ALL_ENTITIES.filter(e => e.name !== AgentProposalEntity.name), AgentProposalEntity], synchronize: true });
    await db.initialize();
    const row = await db.getRepository(PhaseStateEntity).save({ userId: 'agent-test-owner', enrollmentId: 'agent-test-enrollment', phaseKey: 'implementation', phaseOrder: 3, status: 'in_progress', workspace: { 'tasks.py': '# TODO' } });
    phaseId = row.id;
    const workflow = {
      loadOwnedState: async (userId: string, id: string) => {
        const state = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id });
        if (state.userId !== userId || state.status === 'locked') throw new Error('not your unlocked phase');
        return { state, phase };
      },
      transaction: (fn: any) => txnLock.run('db', () => db.transaction(fn)),
    };
    const assistant = { serialise: (id: string, fn: any) => lock.run(id, fn), recordReviewUsage: jest.fn() };
    provider = { available: true, name: 'local-ai:test-double', structured: jest.fn() };
    // The pinned-task reader is the last argument. This spec's workflow double names no enrolment, so
    // the service resolves the scope from the phase alone, exactly as the composers it compares against do.
    service = new AgenticService(db.getRepository(AgentProposalEntity), workflow as any, assistant as any, provider as any, db, db.getRepository(ExecutionRunEntity), {} as any);
  });
  afterEach(async () => { await db.destroy(); });
  const propose = async () => {
    provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files }));
    return service.propose('agent-test-owner', phaseId, 'Implement strict overdue comparison and exclude completed tasks without changing the contract.');
  };
  const approve = async () => {
    const proposal = await propose();
    provider.structured.mockResolvedValueOnce(respond(understanding()));
    return service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
  };

  it('records reported usage for a malformed agentic response without creating a proposal or approval', async () => {
    provider.structured.mockRejectedValue(new ProviderUsageError('AI structured response was not JSON', 45, 11));
    await expect(service.propose('agent-test-owner', phaseId, 'A bounded change')).rejects.toThrow('Nothing was approved');
    expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(1);
    expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledWith(expect.objectContaining({ id: phaseId }), provider.name, 45, 11);
    expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
  });

  /*
   * agentic.classify can answer the propose route with an adequate verdict
   * and an empty feedback string. The route accepts that shape, as chat does
   * an adequate reply, with the server's own sentence for the feedback;
   * it makes no new model call, and anything less than adequate still needs
   * its question.
   */
  describe('the propose route reading an adequate verdict with empty feedback', () => {
    const recorded = { adequate: true, feedback: '', questions: [] };

    it('proposes on the recorded shape with the same two calls', async () => {
      provider.structured.mockResolvedValueOnce(respond(recorded)).mockResolvedValueOnce(respond({ files }));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Implement strict overdue comparison and exclude completed tasks.');
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect(proposal.files).toEqual(files);
      expect(proposal.assessment).toEqual({ adequate: true, feedback: 'The request is specific enough to propose a change.', questions: [] });
      expect(proposal.approvedAt).toBeNull();
    });

    it.each([
      ['an inadequate verdict with no question', { adequate: false, feedback: '', questions: [] }],
      ['an adequate verdict that still asks a question', { adequate: true, feedback: '', questions: ['Which boundary?'] }],
      ['an adequate verdict with whitespace questions', { adequate: true, feedback: '', questions: [' '] }],
      ['an adequate verdict without a feedback field', { adequate: true, questions: [] }],
    ])('still refuses %s, asked once more and refused again, with no generation call', async (_label, value) => {
      provider.structured.mockResolvedValueOnce(respond(value)).mockResolvedValueOnce(respond(value));
      await expect(service.propose('agent-test-owner', phaseId, 'A bounded change')).rejects.toThrow('incomplete prompt assessment');
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect(provider.structured.mock.calls.map(call => call[5])).toEqual(['agentic.classify', 'agentic.classify']);
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });
  });

  it.each(['intent', 'generation', 'explanation'] as const)('cancels expired %s work and refuses late persistence while retaining reported usage', async stage => {
    const existing = stage === 'explanation' ? await approve() : null;
    provider.structured.mockClear();
    (service as any).assistant.recordReviewUsage.mockClear();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let resolveLate!: (value: unknown) => void;
      const pending = new Promise(resolve => { resolveLate = resolve; });
      if (stage === 'generation') provider.structured.mockResolvedValueOnce(respond(good));
      provider.structured.mockReturnValueOnce(pending);
      const failed = (existing
        ? service.explain('agent-test-owner', phaseId, existing.id, existing.proposalHash, explanation)
        : service.propose('agent-test-owner', phaseId, 'Implement strict overdue comparison.')).catch(error => error);
      const expectedCalls = stage === 'generation' ? 2 : 1;
      while (provider.structured.mock.calls.length < expectedCalls) await new Promise(resolve => setImmediate(resolve));
      const signal = provider.structured.mock.calls.at(-1)![3] as AbortSignal;
      await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
      expect((await failed).getStatus()).toBe(503);
      expect(signal.aborted).toBe(true);
      resolveLate(respond(stage === 'intent' ? good : stage === 'generation' ? { files } : understanding()));
      await lock.run('agent-test-owner', async () => undefined);
      expect(provider.structured).toHaveBeenCalledTimes(expectedCalls);
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(expectedCalls);
      if (existing) {
        const persisted = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: existing.id });
        expect(persisted.approvedAt).toBeNull();
        expect(persisted.explanationAssessment).toBeNull();
        await expect(service.apply('agent-test-owner', phaseId, existing.id, existing.proposalHash)).rejects.toThrow('Explain');
      } else expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
    } finally { jest.useRealTimers(); }
  });

  // A turn the AI gate refused, or whose 55 s budget ran out while it still waited at that gate,
  // is the class's load: provider_busy, never a model that did not answer.
  describe('a request the AI gate refused (provider_busy)', () => {
    it('fails a chat turn the gate refused as provider_busy and records nothing', async () => {
      provider.structured.mockRejectedValueOnce(new AiBusyError('queue-full', 0));
      const failed = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'What does this change mean?' });
      expect([failed.status, failed.errorCode]).toEqual(['failed', 'provider_busy']);
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });

    it('answers the propose route the gate refused with the busy sentence', async () => {
      provider.structured.mockRejectedValueOnce(new AiBusyError('queue-full', 0));
      const refused = await service.propose('agent-test-owner', phaseId, 'Implement strict overdue comparison.').catch(error => error);
      expect(refused).toBeInstanceOf(AiBusyError);
      expect([refused.getStatus(), refused.message]).toEqual([503, AI_BUSY_MESSAGE]);
    });

    it.each([[true, 'provider_busy'], [false, 'assessment_unavailable'], ['throws', 'assessment_unavailable']] as const)('reads a budget that ran out while waiting at the gate (%s) as %s', async (waiting, code) => {
      (provider as any).waitingAtGate = jest.fn(() => { if (waiting === 'throws') throw new Error('unreadable'); return waiting; });
      let late!: (value: unknown) => void;
      provider.structured.mockReturnValueOnce(new Promise(resolve => { late = resolve; }));
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const pending = service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'What does this change mean?' });
        while (!provider.structured.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
        const signal = provider.structured.mock.calls[0][3] as AbortSignal;
        await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
        const failed = await pending;
        expect([failed.status, failed.errorCode]).toEqual(['failed', code]);
        expect((provider as any).waitingAtGate).toHaveBeenCalledWith(signal);
        expect(signal.aborted).toBe(true);
      } finally {
        late?.(respond({ kind: 'discussion', reply: 'The saved request is understood.', questions: [] })); await lock.run('agent-test-owner', async () => undefined);
        jest.useRealTimers(); delete (provider as any).waitingAtGate;
      }
    });

    it('reads the propose route\'s budget spent waiting at the gate as busy', async () => {
      (provider as any).waitingAtGate = jest.fn(() => true);
      let late!: (value: unknown) => void;
      provider.structured.mockReturnValueOnce(new Promise(resolve => { late = resolve; }));
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const failed = service.propose('agent-test-owner', phaseId, 'Implement strict overdue comparison.').catch(error => error);
        while (!provider.structured.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
        await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
        const refused = await failed;
        expect(refused).toBeInstanceOf(AiBusyError);
        expect([refused.getStatus(), refused.reason]).toEqual([503, 'deadline']);
      } finally {
        late?.(respond(good)); await lock.run('agent-test-owner', async () => undefined);
        jest.useRealTimers(); delete (provider as any).waitingAtGate;
      }
    });
  });

  it('includes the per-learner queue in the deadline and never starts an expired proposal', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let release!: () => void;
    const predecessor = lock.run('agent-test-owner', () => new Promise<void>(resolve => { release = resolve; }));
    try {
      while (!release) await new Promise(resolve => setImmediate(resolve));
      const failed = service.propose('agent-test-owner', phaseId, 'Implement strict overdue comparison.').catch(error => error);
      await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
      expect((await failed).getStatus()).toBe(503);
      expect(provider.structured).not.toHaveBeenCalled();
      release(); await predecessor; await lock.run('agent-test-owner', async () => undefined);
      expect(provider.structured).not.toHaveBeenCalled();
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    } finally { release?.(); jest.useRealTimers(); }
  });

  it('permits reviewed agentic work despite zero legacy quotas and a large persisted usage ledger', async () => {
    await db.getRepository(UserEntity).save({ id: 'agent-test-owner', email: 'agent-zero-quota@example.test', passwordHash: 'unused-test-hash', displayName: 'Legacy zero quota', dailyTokenBudget: 0 });
    await db.getRepository(SettingEntity).save({ key: 'aiDailyTokenBudget', value: '0' });
    await db.getRepository(AssistantMessageEntity).save({ userId: 'agent-test-owner', enrollmentId: 'agent-test-enrollment', phaseStateId: phaseId, phaseKey: 'implementation', role: 'assistant', provider: 'rubric-review', content: 'Historical actual usage fixture.', tokensIn: 1000000, tokensOut: 100000 });
    const approved = await approve();
    expect(approved.explanationAssessment?.adequate).toBe(true);
    expect(provider.structured).toHaveBeenCalledTimes(3);
    expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(3);
    const applied = await service.apply('agent-test-owner', phaseId, approved.id, approved.proposalHash);
    expect(applied.workspace).toEqual(files);
  });

  it('names every agentic model call from the fixed set without altering the request it sends', async () => {
    const prompt = 'Implement strict overdue comparison and exclude completed tasks without changing the contract.';
    const workspace = { 'tasks.py': '# TODO' };
    const proposal = await propose();
    provider.structured.mockResolvedValueOnce(respond(understanding()));
    await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
    const [intent, generate, assess] = provider.structured.mock.calls;
    expect(intent).toEqual([composeAgenticIntentAssessment(phase), { prompt, workspace }, 3000, intent[3], undefined, 'agentic.classify']);
    expect(generate).toEqual([expect.stringContaining("The learner's intent was assessed as adequate."), { prompt, workspace }, 9000, generate[3], undefined, 'agentic.generate']);
    expect(assess).toEqual([expect.stringContaining(EXPLANATION_ASSESSMENT_PROMPT),
      { reference: { originalRequest: prompt, before: workspace, proposedFiles: files, proposalHash: proposal.proposalHash, latestEdit: null },
        evidence: NO_RECORDED_EVIDENCE, learnerAnswer: explanation, answerEvidence: explanationEvidence(explanation) },
      4500, assess[3], explanationAssessmentResponseSchema(explanation), 'agentic.explanation']);
    for (const call of [intent, generate, assess]) {
      expect(call[3]).toBeInstanceOf(AbortSignal);
      expect(AI_CALL_LABELS).toContain(call[5]);
    }
    // One reviewed operation, one deadline: the label is not a new abort scope.
    expect(intent[3]).toBe(generate[3]);
  });

  it('evaluates intent semantically before generating any files', async () => {
    provider.structured.mockResolvedValueOnce(respond(bad));
    const proposal = await service.propose('agent-test-owner', phaseId, 'make it pass');
    expect(proposal.assessment.adequate).toBe(false);
    expect(proposal.files).toEqual({});
    expect(provider.structured).toHaveBeenCalledTimes(1);
    expect(await db.getRepository(AgentProposalEntity).count()).toBe(1);
  });
  it('asks one focused intent question without discarding known context or approving a change', async () => {
    const clarification = { adequate: false, feedback: 'I need the specific change you want.', questions: ['Which existing behavior or wording would you like to change?'] };
    provider.structured.mockResolvedValueOnce(respond(clarification));
    const proposal = await service.propose('agent-test-owner', phaseId, 'Do it.');
    const [system, data] = provider.structured.mock.calls[0];
    expect(system).toBe(composeAgenticIntentAssessment(phase));
    expect(system).toContain('exactly ONE highest-value question');
    expect(system).toContain('do not ask the learner to restate known product requirements');
    expect(system).toContain('Do not imply that the learner has never interviewed');
    expect(system).toContain('Do not offer submission as-is, grading, Apply or advancement');
    expect(system).toContain('TaskTrackr excludes today from overdue.');
    expect(data).toEqual({ prompt: 'Do it.', workspace: { 'tasks.py': '# TODO' } });
    expect(proposal.assessment).toEqual(clarification);
    expect(proposal.files).toEqual({});
    expect(proposal.approvedAt).toBeNull();
    expect(proposal.appliedAt).toBeNull();
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    expect(provider.structured).toHaveBeenCalledTimes(1);
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
  });
  it.each([
    { adequate: false, feedback: 'More context needed.', questions: ['Which behavior?', 'Which persona?', 'Which page?'] },
    { adequate: true, feedback: 'Ready.', questions: ['What change?'] },
  ])('fails closed on an unfocused or contradictory intent response, given twice (one re-ask), without generating files', async response => {
    provider.structured.mockResolvedValueOnce(respond(response)).mockResolvedValueOnce(respond(response));
    await expect(service.propose('agent-test-owner', phaseId, 'Do it.')).rejects.toThrow('incomplete prompt assessment');
    expect(provider.structured).toHaveBeenCalledTimes(2);
    expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
  });
  it('cannot apply a proposed answer without an assessed explanation', async () => {
    const proposal = await propose();
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
  });
  it('rejects incorrect reasoning regardless of how confidently it agrees', async () => {
    const proposal = await propose();
    provider.structured.mockResolvedValueOnce(respond(understanding(false)));
    const assessed = await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Yes, absolutely, this is correct and I agree with all the requirements.');
    expect(assessed.approvedAt).toBeNull();
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
  });
  it('refuses provider-authored replacement reasoning before it can be stored or authorize Apply', async () => {
    const proposal = await propose();
    const recipe = { ...understanding(false), feedback: 'REFERENCE RECIPE: explain the strict comparison, completed filter and boundary tests.' };
    // Refused, asked once more (the explanation re-ask), refused again: never a third ask.
    provider.structured.mockResolvedValueOnce(respond(recipe)).mockResolvedValueOnce(respond(recipe));
    await expect(service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Looks correct.')).rejects.toThrow('invalid explanation assessment');
    expect(provider.structured.mock.calls.filter(call => call[5] === 'agentic.explanation')).toHaveLength(2);
    for (const call of provider.structured.mock.calls) expect(JSON.stringify(call)).not.toContain('REFERENCE RECIPE');
    const stored = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
    expect(stored.explanationAssessment).toBeNull();
    expect(stored.approvedAt).toBeNull();
    for (const result of [await service.proposal('agent-test-owner', phaseId, proposal.id), await service.list('agent-test-owner', phaseId)]) expect(JSON.stringify(result)).not.toContain('REFERENCE RECIPE');
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
  });
  it('applies exact approved bytes once, keeps assessment persisted, and preserves later learner edits on retry', async () => {
    const proposal = await approve();
    const applied = await service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash);
    expect(applied.workspace).toEqual(files);
    const stored = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
    expect(stored.appliedAt).toBeTruthy();
    expect(stored.explanationAssessment?.adequate).toBe(true);
    await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': 'my later edit' } });
    expect((await service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).workspace).toEqual({ 'tasks.py': 'my later edit' });
  });
  it('a successful understanding review records approval without itself applying or advancing the phase', async () => {
    const proposal = await approve();
    const state = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId });
    expect(proposal.approvedAt).toBeTruthy();
    expect(proposal.appliedAt).toBeNull();
    expect(state.workspace).toEqual({ 'tasks.py': '# TODO' });
    expect(state.status).toBe('in_progress');
    expect(state.attempts).toBe(0);
    expect(state.passedAt).toBeNull();
  });
  it('editing a reviewed proposal invalidates the previous approval and hash', async () => {
    const proposal = await approve();
    const edited = await service.edit('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, { 'tasks.py': 'return due <= today' });
    expect(edited.proposalHash).not.toBe(proposal.proposalHash);
    expect(edited.approvedAt).toBeNull();
    expect(edited.explanationAssessment).toBeNull();
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('changed');
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, edited.proposalHash)).rejects.toThrow('Explain');
    const persisted = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
    expect(persisted.lastEdit).toMatchObject({ previousFiles: proposal.files, previousHash: proposal.proposalHash, currentHash: edited.proposalHash });
    expect(edited).not.toHaveProperty('lastEdit');
  });

  it('reviews later formatting edits against the actual prior proposal, separately from the original workspace', async () => {
    const proposal = await approve();
    const revisedFiles = { 'tasks.py': proposal.files['tasks.py'] + '\n' };
    const edited = await service.edit('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, revisedFiles);
    provider.structured.mockResolvedValueOnce(respond(understanding()));
    const approved = await service.explain('agent-test-owner', phaseId, edited.id, edited.proposalHash, explanation);
    const [prompt, data] = provider.structured.mock.calls.at(-1)!;
    expect(prompt).toContain('distinct from a JSON artifact\'s optional renderHash');
    expect(data.reference.before).toEqual({ 'tasks.py': '# TODO' });
    expect(data.reference.proposedFiles).toEqual(revisedFiles);
    expect(data.reference.latestEdit.previousFiles).toEqual(proposal.files);
    expect(data.reference.latestEdit.previousHash).toBe(proposal.proposalHash);
    expect(data.reference.latestEdit.currentHash).toBe(edited.proposalHash);
    expect(approved.approvedAt).not.toBeNull();
    await service.apply('agent-test-owner', phaseId, approved.id, approved.proposalHash);
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual(revisedFiles);
  });

  it('requires renewed understanding for an unapplied legacy approval without rewriting that historical assessment', async () => {
    const proposal = await approve();
    const legacy = { ...proposal.explanationAssessment!, version: 'learner-understanding-v4' };
    await db.getRepository(AgentProposalEntity).update(proposal.id, { explanationAssessment: legacy });
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    const visible = await service.proposal('agent-test-owner', phaseId, proposal.id);
    expect(visible.approvedAt).toBeNull();
    expect(visible.explanationAssessment).toEqual(legacy);
    expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id })).explanationAssessment).toEqual(legacy);
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
  });

  it('keeps already-applied legacy records historical and idempotent after a protocol upgrade', async () => {
    const proposal = await approve();
    await service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash);
    const legacy = { ...proposal.explanationAssessment!, version: 'learner-understanding-v4' };
    await db.getRepository(AgentProposalEntity).update(proposal.id, { explanationAssessment: legacy });
    await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': 'newer learner revision' } });
    const retry = await service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash);
    expect(retry.workspace).toEqual({ 'tasks.py': 'newer learner revision' });
    expect(retry.proposal.explanationAssessment).toEqual(legacy);
    expect(retry.proposal.approvedAt).toBe(proposal.approvedAt);
  });

  it('refuses an appended claim even when every previously approved citation is still present', async () => {
    const proposal = await approve();
    await db.getRepository(AgentProposalEntity).update(proposal.id, { explanation: `${proposal.explanation} Therefore this proves every test passed.` });
    const visible = await service.proposal('agent-test-owner', phaseId, proposal.id);
    expect(visible.approvedAt).toBeNull();
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
  });

  it('does not supply invented or mismatched edit provenance for a legacy proposal', async () => {
    const proposal = await propose();
    provider.structured.mockResolvedValueOnce(respond(understanding()));
    await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
    expect(provider.structured.mock.calls.at(-1)![1].reference.latestEdit).toBeNull();
    await db.getRepository(AgentProposalEntity).update(proposal.id, { lastEdit: { previousFiles: { 'tasks.py': 'invented' }, previousHash: 'wrong', currentHash: proposal.proposalHash, editedAt: new Date().toISOString() } });
    provider.structured.mockResolvedValueOnce(respond(understanding()));
    await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
    expect(provider.structured.mock.calls.at(-1)![1].reference.latestEdit).toBeNull();
  });
  it('an edited proposal cannot be approved by a stale response still in flight', async () => {
    const proposal = await propose();
    let finish!: (value: unknown) => void;
    provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const explaining = service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    await service.edit('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, { 'tasks.py': 'different behavior' });
    finish(respond(understanding()));
    await expect(explaining).rejects.toThrow('changed while');
    expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id })).approvedAt).toBeNull();
  });
  it('does not allow a legacy Boolean-only approval to authorize a new apply', async () => {
    const proposal = await propose();
    await db.getRepository(AgentProposalEntity).update(proposal.id, { explanation: 'I understand it all.', explanationAssessment: good, approvedAt: new Date().toISOString() });
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
  });
  it('revokes the prior approval before a replacement explanation is assessed, including provider failure', async () => {
    const proposal = await approve();
    let fail!: (error: Error) => void;
    provider.structured.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Actually, this proves all tests passed.');
    while (!fail) await new Promise(resolve => setImmediate(resolve));
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    fail(new Error('Provider unavailable'));
    await expect(pending).rejects.toThrow('Nothing was approved');
    const stored = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
    expect(stored.approvedAt).toBeNull();
    expect(stored.explanationAssessment).toBeNull();
    expect(stored.explanation).toBe('Actually, this proves all tests passed.');
  });
  it('cannot turn a review of the correct proposal into evidence of a superficial learner answer', async () => {
    const proposal = await propose();
    const inventedEvidence = understanding(); inventedEvidence.dimensions[0].learnerEvidenceIds = ['E999'];
    provider.structured.mockResolvedValueOnce(respond(inventedEvidence)).mockResolvedValueOnce(respond(inventedEvidence));
    await expect(service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'I understand it all. My teacher agreed.')).rejects.toThrow('invalid explanation');
    expect(provider.structured.mock.calls.filter(call => call[5] === 'agentic.explanation')).toHaveLength(2);
    const stored = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
    expect(stored.approvedAt).toBeNull();
    expect(stored.explanationAssessment).toBeNull();
    expect(provider.structured.mock.calls.at(-1)?.[1]).toEqual({ reference: { originalRequest: proposal.prompt, before: { 'tasks.py': '# TODO' }, proposedFiles: files, proposalHash: proposal.proposalHash, latestEdit: null }, evidence: NO_RECORDED_EVIDENCE, learnerAnswer: 'I understand it all. My teacher agreed.', answerEvidence: explanationEvidence('I understand it all. My teacher agreed.') });
  });
  it('refuses to overwrite a changed workspace', async () => {
    const proposal = await approve();
    await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': 'newer learner work' }, workspaceUpdatedAt: new Date().toISOString() });
    await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('workspace changed');
    expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace?.['tasks.py']).toBe('newer learner work');
  });
  it('does not expose another learner’s proposals or let another learner approve them', async () => {
    const proposal = await propose();
    await expect(service.list('outsider', phaseId)).rejects.toThrow();
    await expect(service.explain('outsider', phaseId, proposal.id, proposal.proposalHash, 'approve')).rejects.toThrow();
  });
  it.each([null, {}, { adequate: 'yes', feedback: 'yes', questions: [] }])('fails closed on malformed semantic assessment %j', async value => {
    provider.structured.mockResolvedValueOnce(respond(value));
    await expect(service.propose('agent-test-owner', phaseId, 'make a bounded change')).rejects.toThrow('incomplete');
    expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
  });
  it('fails closed without a provider, without fabricated proposal history', async () => {
    provider.available = false;
    await expect(service.propose('agent-test-owner', phaseId, 'do something')).rejects.toThrow('not configured');
    expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
  });
  it('rejects AI writes to paths the phase does not permit', async () => {
    provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { '../../secret': 'overwrite' } })).mockResolvedValueOnce(respond({ files: { '../../secret': 'overwrite' } }));
    await expect(service.propose('agent-test-owner', phaseId, 'change something')).rejects.toThrow(`${FILES_PROPOSAL_REFUSED} The proposal contains invalid or non-editable files.`);
    expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
  });
  it('legacy overlapping assessments cannot overwrite the newer explanation or approval', async () => {
    const proposal = await propose();
    (service as any).assistant.serialise = (_userId: string, work: () => Promise<unknown>) => work();
    provider.structured.mockClear();
    let finishFirst!: (value: unknown) => void;
    provider.structured.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    provider.structured.mockResolvedValueOnce(respond(understanding()));
    const earlier = service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
    const earlierResult = earlier.then(value => ({ value }), error => ({ error }));
    while (!finishFirst) await new Promise(resolve => setImmediate(resolve));
    const laterText = `${explanation} I will inspect the result of those checks before relying on them.`;
    const later = await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, laterText);
    expect(later.approvedAt).not.toBeNull();
    finishFirst(respond(understanding()));
    expect(await earlierResult).toEqual({ error: expect.objectContaining({ message: expect.stringContaining('proposal changed') }) });
    const saved = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
    expect(saved.explanation).toBe(laterText);
    expect(saved.approvedAt).toBe(later.approvedAt);
  });

  it('hashes content deterministically regardless of object property order', () => {
    expect(workspaceHash({ b: '2', a: '1' })).toBe(workspaceHash({ a: '1', b: '2' }));
    expect(workspaceHash({ a: '1' })).not.toBe(workspaceHash({ a: '2' }));
  });

  /**
   * The explanation re-ask: an assessment the gate's
   * parser refuses is asked about once more inside the same explanation call,
   * under the same lock and the same 55 s route budget, and judged by the same
   * parser. An approval is never invented: a second refusal, or a second call
   * that fails, fails the explanation as a first refusal would.
   */
  describe('the explanation re-ask', () => {
    /** An inconsistent assessment: verification marked met with the finding unsupported. */
    const inconsistent = () => { const value = understanding(); Object.assign(value.dimensions[2], { met: true, finding: 'unsupported' }); return value; };
    const note = () => explanationReaskNote({ code: 'inconsistent_finding', keys: ['verification'] });
    const explanationCalls = () => provider.structured.mock.calls.filter(call => call[5] === 'agentic.explanation');
    const warnings = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const lines = (spy: jest.SpyInstance) => spy.mock.calls.map(call => String(call[0]));

    it('asks once more with the first request unchanged plus one note, and approves only on a valid second answer', async () => {
      const proposal = await propose();
      const warn = warnings();
      try {
        provider.structured.mockResolvedValueOnce(respond(inconsistent())).mockResolvedValueOnce(respond(understanding()));
        const assessed = await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
        expect(assessed.approvedAt).toBeTruthy();
        expect(assessed.explanationAssessment?.adequate).toBe(true);
        const [first, second] = explanationCalls();
        expect(explanationCalls()).toHaveLength(2);
        expect(first).toHaveLength(6);
        expect(second).toEqual([...first, note()]);
        expect(second[3]).toBe(first[3]); // one route signal: the budget is not a new scope
        for (const word of explanation.split(/[ ;,.]+/).filter(word => word.length > 6)) expect(second[6]).not.toContain(word);
        expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(4); // classify, generate, two explanation asks
        expect(lines(warn)).toContain(`AI explanation assessment rejected: proposal=${proposal.id} code=inconsistent_finding`);
        const reasked = lines(warn).filter(line => line.startsWith('agentic_explanation_reasked'));
        expect(reasked).toEqual(['agentic_explanation_reasked phase=implementation cause=inconsistent_finding outcome=ok']);
      } finally { warn.mockRestore(); }
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).resolves.toMatchObject({ workspace: files });
    });

    it('stores a valid but inadequate second answer as a refusal: the second answer is judged by the same rules', async () => {
      const proposal = await propose();
      provider.structured.mockResolvedValueOnce(respond(inconsistent())).mockResolvedValueOnce(respond(understanding(false)));
      const warn = warnings();
      let logged: string[] = [];
      const assessed = await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation).finally(() => { logged = lines(warn); warn.mockRestore(); });
      // A valid assessment is an ok second ask whichever way it decided.
      expect(logged.filter(line => line.startsWith('agentic_explanation_reasked'))).toEqual(['agentic_explanation_reasked phase=implementation cause=inconsistent_finding outcome=ok']);
      expect(explanationCalls()).toHaveLength(2);
      expect(assessed.approvedAt).toBeNull();
      expect(assessed.explanationAssessment?.adequate).toBe(false);
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    });

    it.each([
      ['a second refusal', (mock: jest.Mock) => mock.mockResolvedValueOnce(respond(inconsistent()))],
      ['a second call that fails', (mock: jest.Mock) => mock.mockRejectedValueOnce(new Error('Provider unavailable'))],
    ])('fails as a first refusal would on %s, never asking a third time and never approving', async (_name, second) => {
      const proposal = await propose();
      const warn = warnings();
      try {
        second(provider.structured.mockResolvedValueOnce(respond(inconsistent())));
        provider.structured.mockResolvedValueOnce(respond(understanding()));
        await expect(service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation)).rejects.toThrow('The AI returned an invalid explanation assessment. Approval remains closed.');
        expect(explanationCalls()).toHaveLength(2);
        expect(lines(warn).filter(line => line.startsWith('AI explanation assessment rejected:')).length).toBeGreaterThanOrEqual(1);
        expect(lines(warn).filter(line => line.startsWith('agentic_explanation_'))).toEqual(['agentic_explanation_reasked phase=implementation cause=inconsistent_finding outcome=still_invalid']);
      } finally { warn.mockRestore(); }
      const stored = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id });
      expect(stored.explanationAssessment).toBeNull();
      expect(stored.approvedAt).toBeNull();
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    });

    it('never re-asks a call that failed before any answer came back', async () => {
      const proposal = await propose();
      provider.structured.mockRejectedValueOnce(new ProviderUsageError('AI structured response was not JSON', 5, 1)).mockResolvedValueOnce(respond(understanding()));
      await expect(service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation)).rejects.toThrow('Nothing was approved');
      expect(explanationCalls()).toHaveLength(1);
    });

    it.each([
      ['a met dimension citing nothing', () => { const v = understanding(); v.dimensions[1].learnerEvidenceIds = []; return v; }, 'missing_positive_evidence', ['constraints']],
      ['an evidence id the answer does not have', () => { const v = understanding(); v.dimensions[0].learnerEvidenceIds = ['E999']; return v; }, 'unknown_learner_evidence_reference', ['effects']],
      ['a field the schema does not allow', () => ({ ...understanding(), feedback: 'REFERENCE RECIPE' }), 'unexpected_output_field', []],
    ] as const)('re-asks any refusal of the parser: %s', async (_name, make, code, keys) => {
      const proposal = await propose();
      provider.structured.mockResolvedValueOnce(respond(make())).mockResolvedValueOnce(respond(understanding()));
      const assessed = await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
      expect(assessed.approvedAt).toBeTruthy();
      const [, second] = explanationCalls();
      expect(second[6]).toBe(explanationReaskNote({ code, keys: [...keys] }));
      expect(second[6]).not.toContain('E999');
      expect(second[6]).not.toContain('REFERENCE RECIPE');
    });

    it('holds the learner\'s one place in the queue across both asks', async () => {
      const proposal = await propose();
      let answer!: (value: unknown) => void;
      provider.structured.mockResolvedValueOnce(respond(inconsistent())).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
      const pending = service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
      while (!answer) await new Promise(resolve => setImmediate(resolve));
      const order: string[] = [];
      const sameLearner = (service as any).assistant.serialise('agent-test-owner', async () => { order.push('same learner'); });
      const otherLearner = (service as any).assistant.serialise('another-learner', async () => { order.push('another learner'); });
      await otherLearner;
      expect(order).toEqual(['another learner']);
      answer(respond(understanding()));
      expect((await pending).approvedAt).toBeTruthy();
      await sameLearner;
      expect(order).toEqual(['another learner', 'same learner']);
    });

    describe('inside the 55 s route budget', () => {
      const base = 1_900_000_000_000;
      let clock = 0;
      const frozen = () => jest.spyOn(Date, 'now').mockImplementation(() => base + clock);
      afterEach(() => { clock = 0; });

      /**
       * `queued` is the route time spent before the first ask is sent (the
       * clock moves when the service loads the phase, before the call), and
       * `firstMs` how long the first ask itself took (the clock moves inside
       * the mocked call). The second ask is sent only with at least
       * max(EXPLANATION_REASK_FLOOR_MS, firstMs + 10 s) of the 55 s left.
       */
      const run = async (queued: number, firstMs: number, calls: number) => {
        const proposal = await propose();
        const workflow = (service as any).workflow;
        const load = workflow.loadOwnedState;
        let moved = false;
        workflow.loadOwnedState = async (...args: unknown[]) => { const loaded = await load(...args); if (!moved) { moved = true; clock += queued; } return loaded; };
        const now = frozen();
        const warn = warnings();
        try {
          provider.structured.mockImplementationOnce(async () => { clock += firstMs; return respond(inconsistent()); }).mockResolvedValueOnce(respond(understanding()));
          const explained = service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
          const left = AGENTIC_REQUEST_TIMEOUT_MS - queued - firstMs;
          if (calls === 1) {
            await expect(explained).rejects.toThrow('The AI returned an invalid explanation assessment. Approval remains closed.');
            expect(lines(warn).filter(line => line.startsWith('agentic_explanation_'))).toEqual([`agentic_explanation_reask_skipped cause=inconsistent_finding remaining_ms=${left}`]);
          } else {
            expect((await explained).approvedAt).toBeTruthy();
            expect(lines(warn).filter(line => line.startsWith('agentic_explanation_'))).toEqual(['agentic_explanation_reasked phase=implementation cause=inconsistent_finding outcome=ok']);
          }
          expect(explanationCalls()).toHaveLength(calls);
        } finally { warn.mockRestore(); now.mockRestore(); workflow.loadOwnedState = load; }
      };

      it.each([[13_999, 1], [14_000, 2]])('a fast first ask with %i ms left makes %i explanation call(s): the 14 s floor', async (left, calls) => {
        expect(EXPLANATION_REASK_FLOOR_MS).toBe(14_000);
        await run(AGENTIC_REQUEST_TIMEOUT_MS - left, 0, calls);
      });

      it.each([[5_000, 14_999, 1], [5_000, 15_000, 2], [35_000, 20_000, 1], [3_000, 15_000, 2]])(
        'a first ask of %i ms with %i ms left makes %i explanation call(s): its own duration plus 10 s', async (firstMs, left, calls) => {
          await run(AGENTIC_REQUEST_TIMEOUT_MS - firstMs - left, firstMs, calls);
        });
    });

    it('re-asks inside a journalled explanation turn and fails the turn when the second answer is refused too', async () => {
      const proposal = await propose();
      provider.structured.mockResolvedValueOnce(respond(inconsistent())).mockResolvedValueOnce(respond(understanding()));
      const completed = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, randomUUID());
      expect(completed.status).toBe('completed');
      expect((completed.response as any).proposal.approvedAt).toBeTruthy();
      const again = await propose();
      provider.structured.mockResolvedValueOnce(respond(inconsistent())).mockResolvedValueOnce(respond(inconsistent()));
      const failed = await service.explainTurn('agent-test-owner', phaseId, again.id, again.proposalHash, explanation, randomUUID());
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('assessment_unavailable');
      expect(explanationCalls()).toHaveLength(4);
      expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: again.id })).approvedAt).toBeNull();
    });
  });

  /*
   * A prompt assessment the propose route cannot use (not a readable
   * assessment, or outside the one-question rule) is asked once more inside the same call, as the explanation
   * re-ask is: the same request plus one trailing note of fixed copy, under the learner's one lock and the route's
   * one 55 s budget; only a second failure returns the 503, with the sentence and site a first failure would have.
   */
  describe('the prompt assessment re-ask', () => {
    const PROMPT = 'Implement strict overdue comparison and exclude completed tasks without changing the contract.';
    /** A refused assessment: a questionnaire where the rule allows one question. */
    const questionnaire = { adequate: false, feedback: 'PLANTED two things are unclear.', questions: ['PLANTED which page?', 'PLANTED which field?'] };
    const classifyCalls = () => provider.structured.mock.calls.filter(call => call[5] === 'agentic.classify');
    const infos = () => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const reasks = (spy: jest.SpyInstance) => spy.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('agentic_regeneration site=classify'));

    it('asks once more with the first request unchanged plus one note, and proposes on a usable second answer', async () => {
      const log = infos();
      try {
        provider.structured.mockResolvedValueOnce(respond(questionnaire)).mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files }));
        const proposal = await service.propose('agent-test-owner', phaseId, PROMPT);
        expect(proposal.files).toEqual(files);
        expect(proposal.assessment).toEqual(good);
        expect(proposal.approvedAt).toBeNull();
        const [first, second] = classifyCalls();
        expect(classifyCalls()).toHaveLength(2);
        expect(first).toHaveLength(6);
        expect(first[0]).toBe(composeAgenticIntentAssessment(phase));
        expect(second).toEqual([...first, classifyReaskNote('one_question')]);
        expect(second[3]).toBe(first[3]); // one route signal: the budget is not a new scope
        expect(second[6]).not.toContain('PLANTED');
        expect(provider.structured.mock.calls.map(call => call[5])).toEqual(['agentic.classify', 'agentic.classify', 'agentic.generate']);
        expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(3); // two classify asks, one generation
        expect(reasks(log)).toEqual(['agentic_regeneration site=classify code=intent_assessment clause=one_question outcome=ok']);
      } finally { log.mockRestore(); }
    });

    it('stores a usable inadequate second answer as the one question, with no generation', async () => {
      const log = infos();
      let proposal!: Awaited<ReturnType<AgenticService['propose']>>;
      try {
        provider.structured.mockResolvedValueOnce(respond({ adequate: 'yes' })).mockResolvedValueOnce(respond(bad));
        proposal = await service.propose('agent-test-owner', phaseId, 'Do it.');
        expect(proposal.assessment).toEqual(bad);
        expect(proposal.files).toEqual({});
        expect(classifyCalls()[1][6]).toBe(classifyReaskNote('assessment'));
        expect(provider.structured).toHaveBeenCalledTimes(2);
        expect(reasks(log)).toEqual(['agentic_regeneration site=classify code=intent_assessment clause=assessment outcome=ok']);
      } finally { log.mockRestore(); }
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    });

    it.each([
      ['a second refusal', (mock: jest.Mock) => mock.mockResolvedValueOnce(respond(questionnaire)), 2],
      ['a second call that fails', (mock: jest.Mock) => mock.mockRejectedValueOnce(new Error('Provider unavailable')), 1],
      ['a second call refused by the AI gate', (mock: jest.Mock) => mock.mockRejectedValueOnce(new AiBusyError('queue-full', 1)), 1],
    ])('fails as a first failure would on %s: the same 503 and site, never a third ask, nothing stored', async (_name, second, usage) => {
      const log = infos();
      try {
        second(provider.structured.mockResolvedValueOnce(respond(questionnaire)));
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files }));
        const refused = await service.propose('agent-test-owner', phaseId, PROMPT).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(AgenticUnavailableException);
        expect(refused).toMatchObject({ message: 'The AI returned an incomplete prompt assessment. No proposal was approved.', site: 'intent_assessment', call: 'none' });
        expect((refused as AgenticUnavailableException).getStatus()).toBe(503);
        expect(provider.structured).toHaveBeenCalledTimes(2);
        expect(classifyCalls()).toHaveLength(2);
        expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(usage);
        expect(reasks(log)).toEqual(['agentic_regeneration site=classify code=intent_assessment clause=one_question outcome=failed']);
      } finally { log.mockRestore(); }
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });

    it('never re-asks a call that failed before any answer came back, nor a busy gate on the first ask', async () => {
      provider.structured.mockRejectedValueOnce(new ProviderUsageError('AI structured response was not JSON', 5, 1)).mockResolvedValueOnce(respond(good));
      await expect(service.propose('agent-test-owner', phaseId, PROMPT)).rejects.toThrow('Nothing was approved');
      expect(provider.structured).toHaveBeenCalledTimes(1);
      provider.structured.mockReset();
      provider.structured.mockRejectedValueOnce(new AiBusyError('queue-full', 1)).mockResolvedValueOnce(respond(good));
      await expect(service.propose('agent-test-owner', phaseId, PROMPT)).rejects.toBeInstanceOf(AiBusyError);
      expect(provider.structured).toHaveBeenCalledTimes(1);
    });

    it('never asks again after a usable first answer', async () => {
      const log = infos();
      try {
        await propose();
        expect(provider.structured.mock.calls.map(call => call[5])).toEqual(['agentic.classify', 'agentic.generate']);
        expect(classifyCalls()[0]).toHaveLength(6);
        expect(reasks(log)).toEqual([]);
      } finally { log.mockRestore(); }
    });

    it('leaves the chat route\'s own classify reading as it was: one refused reply, one call', async () => {
      provider.structured.mockResolvedValueOnce(respond({ kind: 'clarification', reply: 'Which?', questions: [] })).mockResolvedValueOnce(respond({ kind: 'discussion', reply: 'Fine.', questions: [] }));
      const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'What should change?' });
      expect(turn.status).toBe('failed');
      expect(provider.structured).toHaveBeenCalledTimes(1);
    });

    it('holds the learner\'s one place in the queue across both asks', async () => {
      let answer!: (value: unknown) => void;
      provider.structured.mockResolvedValueOnce(respond(questionnaire)).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockResolvedValueOnce(respond({ files }));
      const pending = service.propose('agent-test-owner', phaseId, PROMPT);
      pending.catch(() => undefined);
      for (let turn = 0; !answer && turn < 1_000; turn += 1) await new Promise(resolve => setImmediate(resolve));
      expect(answer).toBeDefined(); // the second ask is in flight
      const order: string[] = [];
      const sameLearner = (service as any).assistant.serialise('agent-test-owner', async () => { order.push('same learner'); });
      const otherLearner = (service as any).assistant.serialise('another-learner', async () => { order.push('another learner'); });
      await otherLearner;
      expect(order).toEqual(['another learner']);
      answer(respond(good));
      expect((await pending).files).toEqual(files);
      await sameLearner;
      expect(order).toEqual(['another learner', 'same learner']);
    });

    describe('inside the 55 s route budget', () => {
      const base = 1_900_000_000_000;
      let clock = 0;
      afterEach(() => { clock = 0; });

      /**
       * `queued` is the route time spent before the first ask is sent (the
       * clock moves when the route loads the phase), `firstMs` how long the
       * first ask itself took (the clock moves inside the mocked call). The
       * second ask is sent only with at least max(14 s, firstMs + 10 s) left.
       */
      const run = async (queued: number, firstMs: number, calls: number) => {
        const workflow = (service as any).workflow;
        const load = workflow.loadOwnedState;
        let moved = false;
        workflow.loadOwnedState = async (...args: unknown[]) => { const loaded = await load(...args); if (!moved) { moved = true; clock += queued; } return loaded; };
        const now = jest.spyOn(Date, 'now').mockImplementation(() => base + clock);
        const log = infos();
        try {
          provider.structured.mockImplementationOnce(async () => { clock += firstMs; return respond(questionnaire); }).mockResolvedValueOnce(respond(bad));
          const proposed = service.propose('agent-test-owner', phaseId, PROMPT);
          if (calls === 1) {
            await expect(proposed).rejects.toMatchObject({ message: 'The AI returned an incomplete prompt assessment. No proposal was approved.', site: 'intent_assessment' });
            expect(reasks(log)).toEqual(['agentic_regeneration site=classify code=intent_assessment clause=one_question outcome=skipped']);
          } else {
            expect((await proposed).assessment).toEqual(bad);
            expect(reasks(log)).toEqual(['agentic_regeneration site=classify code=intent_assessment clause=one_question outcome=ok']);
          }
          expect(classifyCalls()).toHaveLength(calls);
        } finally { log.mockRestore(); now.mockRestore(); workflow.loadOwnedState = load; }
      };

      it.each([[13_999, 1], [14_000, 2]])('a fast first ask with %i ms left makes %i classify call(s): the 14 s floor', async (left, calls) => {
        expect(CLASSIFY_REASK_FLOOR_MS).toBe(14_000);
        await run(AGENTIC_REQUEST_TIMEOUT_MS - left, 0, calls);
      });

      it.each([[5_000, 14_999, 1], [5_000, 15_000, 2], [35_000, 19_000, 1], [3_000, 14_000, 2]])(
        'a first ask of %i ms with %i ms left makes %i classify call(s): its own duration plus 10 s', async (firstMs, left, calls) => {
          await run(AGENTIC_REQUEST_TIMEOUT_MS - firstMs - left, firstMs, calls);
        });
    });
  });

  /**
   * The records this learner's own work wrote, reaching the assessor
   * so that a statement about them is checkable instead of invisible. The
   * gathering is scoped here; what may be shown is decided by the shared
   * builder, and these tests hold both ends of that.
   */
  describe('recorded learner evidence for the explanation review', () => {
    const marker = 'FOREIGN-RECORD-MUST-NEVER-REACH-THE-PROMPT';
    const runRepo = () => db.getRepository(ExecutionRunEntity);
    const runResult = (over: Partial<RunResult> = {}): RunResult => ({
      ok: true, exitKind: 'ok', stdout: 'PRIVATE STDOUT BYTES', stderr: 'PRIVATE STDERR BYTES', durationMs: 42,
      tests: { total: 5, passed: 4, failed: 1, errored: 0, cases: [{ name: 'PRIVATE CASE NAME', status: 'failed' }] },
      ...over,
    });
    const saveRun = (over: Partial<ExecutionRunEntity> = {}) => runRepo().save(runRepo().create({
      userId: 'agent-test-owner', phaseStateId: phaseId, kind: 'run', status: 'completed', result: runResult(), ...over,
    }));
    const storedAt = async (id: string) => (await runRepo().findOneByOrFail({ id })).createdAt.toISOString();
    const drill: DrillState = {
      fault: 'health endpoint returns 500', pagedAt: '2026-09-17T09:00:00.000Z', runbookBefore: 'PRIVATE RUNBOOK BYTES',
      pagedExit: 1, healthRanAt: '2026-09-17T09:10:00.000Z', healthExit: 0,
      fixAppliedAt: '2026-09-17T09:20:00.000Z', resolvedAt: '2026-09-17T09:30:00.000Z',
      incident: { rootCause: 'PRIVATE ROOT CAUSE', fix: 'PRIVATE FIX', actionItem: 'PRIVATE ACTION ITEM' },
    };
    const lastCall = () => provider.structured.mock.calls.at(-1)![1];
    const evidenceOf = () => lastCall().evidence;
    const explainOnce = (proposal: { id: string; proposalHash: string }, answer = explanation, adequate = true) => {
      provider.structured.mockResolvedValueOnce(respond(understanding(adequate)));
      return service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, answer);
    };

    it('supplies only this learner’s own completed runs for this phase state, newest first and bounded', async () => {
      const proposal = await propose();
      const base = proposal.createdAt.getTime();
      const otherPhase = await db.getRepository(PhaseStateEntity).save({ userId: 'agent-test-owner', enrollmentId: 'agent-test-enrollment', phaseKey: 'deployment', phaseOrder: 6, status: 'in_progress', workspace: {} });
      const newest = await saveRun({ createdAt: new Date(base + 30_000) });
      const middle = await saveRun({ createdAt: new Date(base - 30_000), result: runResult({ ok: false, exitKind: 'error', tests: undefined }) });
      const oldest = await saveRun({ createdAt: new Date(base - 60_000) });
      await saveRun({ createdAt: new Date(base - 90_000) });                                     // past EVIDENCE_MAX_RUNS
      await saveRun({ kind: 'submit', result: runResult({ stdout: `graded submission ${marker}` }) });
      await saveRun({ status: 'queued', result: null });                                          // no outcome recorded yet
      await saveRun({ phaseStateId: otherPhase.id, result: runResult({ stdout: `another phase ${marker}` }) });
      await saveRun({ userId: 'outsider', result: runResult({ stdout: `another learner ${marker}` }) });
      await explainOnce(proposal);
      const counted = { total: 5, passed: 4, failed: 1, errored: 0 };
      expect(evidenceOf().recordedRuns).toEqual([
        { at: await storedAt(newest.id), exitKind: 'ok', ok: true, tests: counted, predatesProposal: false },
        { at: await storedAt(middle.id), exitKind: 'error', ok: false, tests: null, predatesProposal: true },
        { at: await storedAt(oldest.id), exitKind: 'ok', ok: true, tests: counted, predatesProposal: true },
      ]);
      expect(evidenceOf().recordedRuns).toHaveLength(EVIDENCE_MAX_RUNS);
      const payload = JSON.stringify(lastCall());
      for (const withheld of [marker, 'PRIVATE STDOUT', 'PRIVATE STDERR', 'PRIVATE CASE NAME']) expect(payload).not.toContain(withheld);
    });

    /**
     * The `where` on the run query is the only place ownership is enforced for
     * this evidence. `RecordedRunRow` carries neither a userId nor a
     * phaseStateId, so the shared builder cannot re-apply either key and takes
     * whatever rows it is handed. The foreign rows here are the NEWEST of all,
     * so relaxing either key puts them at the front of the learner's own.
     */
    it('scopes recorded runs to the owner and phase state in the query, which nothing downstream can restore', async () => {
      const proposal = await propose();
      const base = proposal.createdAt.getTime();
      const otherPhase = await db.getRepository(PhaseStateEntity).save({ userId: 'agent-test-owner', enrollmentId: 'agent-test-enrollment', phaseKey: 'deployment', phaseOrder: 6, status: 'in_progress', workspace: {} });
      const mine = await saveRun({ createdAt: new Date(base - 60_000) });
      await saveRun({ phaseStateId: otherPhase.id, createdAt: new Date(base + 60_000), result: runResult({ ok: false, exitKind: 'error', stdout: `another phase ${marker}` }) });
      await saveRun({ userId: 'outsider', createdAt: new Date(base + 120_000), result: runResult({ ok: false, exitKind: 'timeout', stdout: `another learner ${marker}` }) });
      await explainOnce(proposal);
      expect(evidenceOf().recordedRuns).toEqual([
        { at: await storedAt(mine.id), exitKind: 'ok', ok: true, tests: { total: 5, passed: 4, failed: 1, errored: 0 }, predatesProposal: true },
      ]);
      // Handed every row, the builder keeps all three: it re-applies kind,
      // status and the order, and has no notion of an owner or a phase state.
      const unscoped = learnerRecordedEvidence({ runs: await runRepo().find({ order: { createdAt: 'DESC', id: 'DESC' } }), proposalAt: proposal.createdAt });
      expect(unscoped.recordedRuns).toHaveLength(EVIDENCE_MAX_RUNS);
      expect(unscoped.recordedRuns.map(run => run.exitKind)).toEqual(['timeout', 'error', 'ok']);
    });

    it('adds exactly one key to the explanation request and leaves the rest of the payload identical', async () => {
      const proposal = await propose();
      await explainOnce(proposal);
      expect(Object.keys(lastCall())).toEqual(['reference', 'evidence', 'learnerAnswer', 'answerEvidence']);
      expect(lastCall()).toEqual({
        reference: { originalRequest: proposal.prompt, before: { 'tasks.py': '# TODO' }, proposedFiles: files, proposalHash: proposal.proposalHash, latestEdit: null },
        evidence: NO_RECORDED_EVIDENCE,
        learnerAnswer: explanation,
        answerEvidence: explanationEvidence(explanation),
      });
    });

    it('hands the owned records to the shared builder rather than shaping them at the call site', async () => {
      await db.getRepository(PhaseStateEntity).update(phaseId, { drill });
      const approved = await approve();
      const edited = await service.edit('agent-test-owner', phaseId, approved.id, approved.proposalHash, { 'tasks.py': 'return due < today and not completed and not archived' });
      const run = await saveRun({ createdAt: new Date(Date.now() - 5_000) });
      await explainOnce(edited);
      const row = await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: edited.id });
      expect(evidenceOf()).toEqual(learnerRecordedEvidence({
        drill, runs: [await runRepo().findOneByOrFail({ id: run.id })],
        latestEdit: row.lastEdit, proposedFiles: row.files, proposalAt: row.createdAt,
      }));
      expect(evidenceOf().recordedEdit).toMatchObject({ previousHash: approved.proposalHash, currentHash: edited.proposalHash, changedPaths: ['tasks.py'], addedPaths: [], removedPaths: [] });
      expect(evidenceOf().recordedDrill).toEqual({ fault: drill.fault, pagedAt: drill.pagedAt, pagedExit: 1, healthRanAt: drill.healthRanAt,
        healthExit: 0, fixAppliedAt: drill.fixAppliedAt, resolvedAt: drill.resolvedAt, incidentRecorded: true });
      const payload = JSON.stringify(lastCall());
      for (const withheld of ['PRIVATE RUNBOOK', 'PRIVATE ROOT CAUSE', 'PRIVATE FIX', 'PRIVATE ACTION ITEM']) expect(payload).not.toContain(withheld);
    });

    it('never builds recorded edit evidence from provenance the server could not validate', async () => {
      const proposal = await propose();
      await db.getRepository(AgentProposalEntity).update(proposal.id, { lastEdit: { previousFiles: { 'tasks.py': 'invented' }, previousHash: 'wrong', currentHash: proposal.proposalHash, editedAt: new Date().toISOString() } });
      await explainOnce(proposal);
      expect(lastCall().reference.latestEdit).toBeNull();
      expect(evidenceOf().recordedEdit).toBeNull();
    });

    /**
     * What this holds is the SERVER's half of "records cannot move the gate":
     * approval is derived from the assessment's dimension findings and from
     * nothing the server gathered, so the same assessment decides identically
     * with a green drill and a 5/5 run present and with no record at all.
     *
     * The provider is a double, so the verdict is fixed by the fixture before
     * the evidence block is built. The model-facing half, that a live
     * assessor reading these records in its prompt is not swayed by them,
     * cannot be shown here: it needs a fixed-input run against a live
     * provider. Do not read this test as proving that half.
     */
    it.each([true, false])('derives approval from the assessment alone: an adequate=%s assessment decides identically with records present and with none', async adequate => {
      const bare = await propose();
      const withoutRecords = await explainOnce(bare, explanation, adequate);
      expect(evidenceOf()).toEqual(NO_RECORDED_EVIDENCE);
      await db.getRepository(PhaseStateEntity).update(phaseId, { drill });
      const proposal = await propose();
      await saveRun({ createdAt: new Date(proposal.createdAt.getTime() + 1_000), result: runResult({ ok: true, exitKind: 'ok', tests: { total: 5, passed: 5, failed: 0, errored: 0, cases: [] } }) });
      const assessed = await explainOnce(proposal, explanation, adequate);
      expect(evidenceOf().recordedRuns).toHaveLength(1);
      expect(evidenceOf().recordedDrill).not.toBeNull();
      expect(assessed.explanationAssessment?.adequate).toBe(adequate);
      expect(Boolean(assessed.approvedAt)).toBe(adequate);
      // Identical record, not merely an identical verdict: the gathered
      // evidence changed nothing the server stored about the decision.
      expect(assessed.explanationAssessment).toEqual(withoutRecords.explanationAssessment);
      expect(Boolean(withoutRecords.approvedAt)).toBe(Boolean(assessed.approvedAt));
      expect(Boolean((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposal.id })).approvedAt)).toBe(adequate);
      if (adequate) expect((await service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).workspace).toEqual(files);
      else {
        await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
        expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
      }
    });
  });

  describe('private conversational request journal', () => {
    const message = 'Adjust the strict overdue comparison; preserve completed-task exclusion.';
    const conversationReply = (kind: 'clarification' | 'discussion' | 'proposal', reply = 'The saved request and constraints are understood.') => ({ kind, reply, questions: kind === 'clarification' ? ['Which date boundary should change?'] : [] });
    const chat = (text = message, context: Record<string, string> = {}) => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: text, ...context });
    const chatProposal = async () => {
      provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files }));
      return chat();
    };
    const responseOf = (turn: { response: unknown }) => turn.response as any;

    it('persists a clarification and resolves a short follow-up from server-owned conversation', async () => {
      provider.structured.mockResolvedValueOnce(respond(conversationReply('clarification', 'One detail is missing.')));
      const first = await chat('Change the boundary while preserving completed-task exclusion.');
      expect(first.status).toBe('completed');
      expect(responseOf(first).kind).toBe('clarification');
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
      provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files }));
      const second = await chat('Exclude today.', { parentTurnId: first.id });
      const proposal = responseOf(second).proposal;
      expect(proposal.prompt).toContain('preserving completed-task exclusion');
      expect(proposal.prompt).toContain('Exclude today.');
      expect(proposal.prompt).toContain('Which date boundary should change?');
      expect(provider.structured.mock.calls[1][1].precedingConversation).toEqual([{ learner: first.message, mentor: 'One detail is missing.', questions: ['Which date boundary should change?'], kind: 'clarification' }]);
      expect(proposal.approvedAt).toBeNull();
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
    });

    it('answers proposal discussion without generation or an explanation assessment', async () => {
      const proposalTurn = await chatProposal(); const proposal = responseOf(proposalTurn).proposal;
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion', 'A strict comparison keeps tasks due today out of this result.')));
      const discussion = await chat('Why does this use a strict comparison?', { parentTurnId: proposalTurn.id });
      expect(responseOf(discussion).kind).toBe('discussion');
      expect(provider.structured).toHaveBeenCalledTimes(1);
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(1);
      expect(responseOf(discussion).proposal.id).toBe(proposal.id);
      expect(responseOf(discussion).proposal.approvedAt).toBeNull();
      expect(composeAgentChatAssessment(phase)).toContain('without writing an explanation for the learner to submit');
    });

    /*
     * A request to edit a file the phase mounts read-only is refused before
     * any model call, rather than spending both paid calls and then failing
     * request_failed with a generic sentence: one sentence to the learner, one
     * log line with the cause, no turn row.
     */
    describe('a request whose only named file is read-only', () => {
      const readOnlyPhase = () => { phase.files = [{ path: 'tasks.py', content: '# TODO', editable: true }, { path: 'api/errors.py', content: 'ERRORS = {}', editable: false }]; };
      let logs: jest.SpyInstance;
      beforeEach(() => { readOnlyPhase(); logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
      afterEach(() => { logs.mockRestore(); });
      const refusalLines = () => logs.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('agentic_refused'));

      it('refuses a chat edit of a read-only file before any model call, with one sentence and one log line', async () => {
        const refused = await chat('Add a one-line docstring to api/errors.py.').catch((error) => error);
        expect(refused.getStatus?.()).toBe(400);
        expect(refused.message).toBe('api/errors.py is read-only in this phase, so the mentor cannot propose a change to it; ask for a change to one of your editable files instead.');
        expect(provider.structured).not.toHaveBeenCalled();
        expect(await db.getRepository(AgentTurnEntity).count()).toBe(0);
        expect(refusalLines()).toEqual(['agentic_refused site=chat cause=read_only_target files=["api/errors.py"]']);
      });

      it('refuses the same request on the propose route before any model call', async () => {
        const refused = await service.propose('agent-test-owner', phaseId, 'Rewrite errors.py so every code has a docstring.').catch((error) => error);
        expect(refused.getStatus?.()).toBe(400);
        expect(refused.message).toContain('api/errors.py is read-only in this phase');
        expect(provider.structured).not.toHaveBeenCalled();
        expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
        expect(refusalLines()).toEqual(['agentic_refused site=propose cause=read_only_target files=["api/errors.py"]']);
      });

      it('still asks the model about a read-only file, and still edits an editable file that uses one', async () => {
        provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion', 'It maps each error code to its status.')));
        expect(responseOf(await chat('What does api/errors.py do?')).kind).toBe('discussion');
        provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files }));
        expect(responseOf(await chat('Change tasks.py to use the codes in api/errors.py.')).kind).toBe('proposal');
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(refusalLines()).toEqual([]);
      });

      /*
       * A request that names a read-only file only as context for a change to
       * an editable file it does not name is not refused. Only the clear case
       * is: the read-only file is the direct object of an edit verb and no
       * editable file is named.
       */
      const skepticPhase = () => { phase.files = [{ path: 'api/errors.py', content: 'ERRORS = {}', editable: false }, { path: 'api/tasks.py', content: '# TODO', editable: true },
        { path: 'tests/test_api.py', content: 'def test_list(): pass', editable: false }, { path: 'tests/test_overdue.py', content: '# TODO', editable: true }]; };
      const contextOnly = [
        'Fix the overdue filter so it raises the not-found error defined in api/errors.py',
        'Write a test for the overdue filter like the one in tests/test_api.py',
        'Update the list endpoint to use the helper from errors.py',
      ];

      it.each(contextOnly)('sends a change that only uses a read-only file as context to the model, both calls unchanged: %s', async (text) => {
        skepticPhase();
        provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files: { 'api/tasks.py': 'raise NotFound()' } }));
        const turn = await chat(text);
        expect([turn.status, responseOf(turn).kind]).toEqual(['completed', 'proposal']);
        expect(provider.structured.mock.calls.map((call) => call[5])).toEqual(['agentic.classify', 'agentic.generate']);
        expect(provider.structured.mock.calls[0][1].currentMessage).toBe(text);
        expect(refusalLines()).toEqual([]);
      });

      it('sends the same context-only request through the propose route with its two calls', async () => {
        skepticPhase();
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tests/test_overdue.py': 'def test_overdue(): pass' } }));
        const proposal = await service.propose('agent-test-owner', phaseId, contextOnly[1]);
        expect(proposal.files).toEqual({ 'tests/test_overdue.py': 'def test_overdue(): pass' });
        expect(provider.structured.mock.calls.map((call) => call[5])).toEqual(['agentic.classify', 'agentic.generate']);
        expect(refusalLines()).toEqual([]);
      });

      it('names only a read-only file that is the direct object of an edit verb, and only when no editable file is named', () => {
        skepticPhase();
        const refused = (text: string) => readOnlyTargets(phase, text);
        // The clear case, refused before any model call.
        expect(refused('Add a one-line docstring at the top of api/errors.py')).toEqual(['api/errors.py']);
        expect(refused('Add a one-line docstring to api/errors.py.')).toEqual(['api/errors.py']);
        expect(refused('Rewrite errors.py so every code has a docstring.')).toEqual(['api/errors.py']);
        expect(refused('Please edit the file api/errors.py to add a 410 code.')).toEqual(['api/errors.py']);
        expect(refused('Change api/errors.py and tests/test_api.py to use 404.')).toEqual(['api/errors.py', 'tests/test_api.py']);
        expect(refused('fix test_api.py')).toEqual(['tests/test_api.py']);
        expect(refused('Make a change to api/errors.py so the codes are sorted.')).toEqual(['api/errors.py']);
        // Context, questions and named editable files go to the model.
        for (const text of [...contextOnly, 'What does api/errors.py do?', 'Fix api/tasks.py so it raises the error from api/errors.py',
          'Update test_overdue.py to edit nothing in api/errors.py', 'Add a check to the list endpoint that matches api/errors.py',
          'Explain why updating api/errors.py is not allowed', 'Using the codes in api/errors.py, fix the overdue filter']) {
          expect([text, refused(text)]).toEqual([text, []]);
        }
      });

      it('marks the pre-call refusal as not retryable in its 400 body, keeping its one sentence (W-7 residual)', async () => {
        const refused = await chat('Add a one-line docstring to api/errors.py.').catch((error) => error);
        expect(refused.getResponse()).toEqual({ statusCode: 400, error: 'Bad Request', retryable: false,
          message: 'api/errors.py is read-only in this phase, so the mentor cannot propose a change to it; ask for a change to one of your editable files instead.' });
      });

      it('refuses with its reason, and logs the clause, when a generated proposal names a non-editable file', async () => {
        provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files: { 'api/errors.py': 'ERRORS = {"x": 1}' } })).mockResolvedValueOnce(respond({ files: { 'api/errors.py': 'ERRORS = {"x": 1}' } }));
        const turn = await chat('Make the change we discussed.');
        expect([turn.status, turn.errorCode, turn.errorMessage]).toEqual(['failed', 'files_proposal_refused', `${FILES_PROPOSAL_REFUSED} The proposal contains invalid or non-editable files.`]);
        // The classification, the generation and its one regeneration.
        expect(provider.structured).toHaveBeenCalledTimes(3);
        const lines = logs.mock.calls.map((call) => String(call[0]));
        expect(lines.filter((line) => line.startsWith('agentic_turn_failed'))).toEqual([]);
        expect(lines.filter((line) => line.startsWith('agentic_proposal_refused'))).toEqual(['agentic_proposal_refused kind=chat code=files_proposal_refused clause=invalid_files']);
      });
    });

    it('names the chat classification and generation calls without altering either request', async () => {
      const turn = await chatProposal();
      expect(responseOf(turn).kind).toBe('proposal');
      const savedWorkspace = { 'tasks.py': '# TODO' };
      const [classify, generate] = provider.structured.mock.calls;
      expect(classify).toEqual([composeAgentChatAssessment(phase),
        { currentMessage: message, precedingConversation: [], originalRequest: null, savedWorkspace, selectedProposal: null },
        3000, classify[3], undefined, 'agentic.classify']);
      expect(generate).toEqual([expect.stringContaining('The preceding semantic intent assessment identified an adequate request'),
        { originalAndContinuedRequest: JSON.stringify({ selectedProposalOriginalRequest: null, precedingConversation: [], currentLearnerMessage: message }),
          precedingConversation: [], savedWorkspace, proposedWorkspace: savedWorkspace },
        9000, generate[3], undefined, 'agentic.generate']);
      expect(classify[3]).toBe(generate[3]);
      expect(AI_CALL_LABELS).toEqual(expect.arrayContaining([classify[5], generate[5]]));
    });

    /** The per-learner queue is shared by the whole file: an in-flight call must be released
     *  even when an expectation fails, or every later test waits behind it. */
    const spinUntil = async (ready: () => boolean) => { for (let spin = 0; !ready() && spin < 5000; spin++) await new Promise(resolve => setImmediate(resolve)); };

    it('reports a proposing stage on the pending turn only while whole-file generation runs', async () => {
      let finish: ((value: unknown) => void) | undefined;
      provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal')))
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const requestId = randomUUID();
      const pending = service.chat('agent-test-owner', phaseId, { requestId, message });
      const drain = pending.catch(() => null);
      try {
        await spinUntil(() => Boolean(finish));
        const midTurn = await service.turn('agent-test-owner', phaseId, requestId);
        expect(midTurn.status).toBe('pending');
        expect(stageOf(midTurn)).toBe('proposing');
        const listed = (await service.turns('agent-test-owner', phaseId)).items.find(item => item.requestId === requestId);
        expect(stageOf(listed)).toBe('proposing');
        await expect(service.turn('outsider', phaseId, requestId)).rejects.toThrow();
        expect(await db.getRepository(AgentTurnEntity).findOneByOrFail({ requestId })).not.toHaveProperty('stage');
      } finally { finish?.(respond({ files })); await drain; }
      const settled = await pending;
      expect(settled.status).toBe('completed');
      expect(settled).not.toHaveProperty('stage');
      expect(responseOf(settled).proposal.files).toEqual(files);
      expect(await service.turn('agent-test-owner', phaseId, requestId)).not.toHaveProperty('stage');
    });

    it('announces no stage while classification or an explanation review is still running', async () => {
      let classify: ((value: unknown) => void) | undefined;
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { classify = resolve; }));
      const requestId = randomUUID();
      const pending = service.chat('agent-test-owner', phaseId, { requestId, message });
      const drainChat = pending.catch(() => null);
      try {
        await spinUntil(() => Boolean(classify));
        expect(await service.turn('agent-test-owner', phaseId, requestId)).not.toHaveProperty('stage');
      } finally { classify?.(respond(conversationReply('discussion'))); await drainChat; }
      expect((await pending).status).toBe('completed');
      expect(await service.turn('agent-test-owner', phaseId, requestId)).not.toHaveProperty('stage');
      const proposalTurn = await chatProposal(); const proposal = responseOf(proposalTurn).proposal;
      let review: ((value: unknown) => void) | undefined;
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { review = resolve; }));
      const explainId = randomUUID();
      const explaining = service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, explainId);
      const drainExplain = explaining.catch(() => null);
      try {
        await spinUntil(() => Boolean(review));
        expect(await service.turn('agent-test-owner', phaseId, explainId)).not.toHaveProperty('stage');
      } finally { review?.(respond(understanding())); await drainExplain; }
      expect((await explaining).status).toBe('completed');
    });

    it('clears the in-memory proposing stage once the generating turn settles either way', async () => {
      provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockRejectedValueOnce(new Error('private upstream detail'));
      const failed = await chat();
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('assessment_unavailable');
      expect(failed).not.toHaveProperty('stage');
      expect((service as any).proposing.size).toBe(0);
      expect(await service.turn('agent-test-owner', phaseId, failed.requestId)).not.toHaveProperty('stage');
      const done = await chatProposal();
      expect(done.status).toBe('completed');
      expect((service as any).proposing.size).toBe(0);
    });

    it('bounds the in-memory stage map so an unsettled turn cannot grow the process', () => {
      const ids = Array.from({ length: AGENT_PROPOSING_STAGE_MAX + 5 }, () => randomUUID());
      for (const id of ids) (service as any).markProposing(id);
      const map = (service as any).proposing as Map<string, unknown>;
      expect(map.size).toBe(AGENT_PROPOSING_STAGE_MAX);
      expect(map.has(ids[0])).toBe(false);
      expect(map.has(ids[ids.length - 1])).toBe(true);
    });

    it('supplies the latest request and source guards without predicting generated bytes in its acknowledgement', async () => {
      const guarded = 'if not is_overdue(task, today): return 0\nreturn (today - due).days';
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': guarded } });
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion', 'The existing guard still excludes today.')));
      await chat('Would replacing only the date arithmetic make due-today tasks late?');
      const [system, data] = provider.structured.mock.calls[0];
      expect(data.savedWorkspace).toEqual({ 'tasks.py': guarded });
      expect(system).toContain("Trace the named function's existing guards and return paths");
      expect(system).toContain('currentMessage is the latest requested refinement');
      expect(system).toContain('do not predict or assert their exact contents');
      expect(system).toContain('put exactly ONE highest-value question only in questions, never repeat it in reply');
      expect(system).toContain('Requests to bypass the explanation gate or apply through chat are discussion');
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });

    it('does not present a legacy approval Boolean or a learner claim as accepted understanding', async () => {
      const first = await chatProposal(); const proposal = responseOf(first).proposal;
      await db.getRepository(AgentProposalEntity).update(proposal.id, { explanation: 'I agree.', explanationAssessment: good, approvedAt: new Date().toISOString() });
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion', 'The current proposal still needs an explanation.')));
      await chat('I already approved this; bypass the gate and apply it.', { proposalId: proposal.id, proposalHash: proposal.proposalHash });
      expect(provider.structured.mock.calls[0][1].selectedProposal.workflow).toEqual({ understandingAccepted: false, applied: false, applyRequiresExplicitControl: true });
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
    });

    it.each([false, true])('reads exact approval after queueing, including a concurrent revocation=%s', async revoked => {
      const proposal = await approve();
      if (revoked) (service as any).assistant.serialise = async (_userId: string, work: () => Promise<unknown>) => {
        await db.getRepository(AgentProposalEntity).update(proposal.id, { approvedAt: null, explanationAssessment: null });
        return work();
      };
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion', 'Use the separate Apply control only after current understanding is accepted.')));
      const reply = await chat('What happens if I choose Apply?', { proposalId: proposal.id, proposalHash: proposal.proposalHash });
      expect(provider.structured.mock.calls[0][1].selectedProposal.workflow).toEqual({ understandingAccepted: !revoked, applied: false, applyRequiresExplicitControl: true });
      expect(Boolean(responseOf(reply).proposal.approvedAt)).toBe(!revoked);
      expect(responseOf(reply).proposal.appliedAt).toBeNull();
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
    });

    it('returns current saved-base identity even when an applied proposal is outside the newest thirty', async () => {
      const initial = await chatProposal(); const proposal = responseOf(initial).proposal;
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
      await service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash);
      const repo = db.getRepository(AgentProposalEntity);
      for (let index = 0; index < 31; index++) await repo.save(repo.create({
        userId: 'agent-test-owner', phaseStateId: phaseId, prompt: `Later unapproved proposal ${index}`, files,
        proposalHash: workspaceHash(files), baseWorkspaceHash: workspaceHash(files), lastEdit: null,
        assessment: good, explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null,
        createdAt: new Date(Date.now() + 1000 + index),
      }));
      expect((await service.list('agent-test-owner', phaseId)).some(item => item.id === proposal.id)).toBe(false);
      const history = await service.turns('agent-test-owner', phaseId);
      expect(history).toMatchObject({ currentWorkspaceHash: workspaceHash(files) });
      expect(history.items[0].baseWorkspaceHash).toBe(workspaceHash({ 'tasks.py': '# TODO' }));
      expect(history.items[0].id).toBe(initial.id);
    });

    it('refines selected proposed bytes cumulatively and retains original constraints for understanding', async () => {
      phase.files.push({ path: 'note.md', content: 'Original note', editable: true });
      const original = await chatProposal(); const first = responseOf(original).proposal;
      provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files: { 'note.md': 'The overdue boundary excludes today.' } }));
      const next = await chat('Also document that boundary in note.md.', { parentTurnId: original.id, proposalId: first.id, proposalHash: first.proposalHash });
      const refined = responseOf(next).proposal;
      expect(provider.structured.mock.calls[3][1].proposedWorkspace['tasks.py']).toBe(files['tasks.py']);
      expect(refined.files).toEqual({ ...files, 'note.md': 'The overdue boundary excludes today.' });
      expect(refined.prompt).toContain(message);
      expect(refined.prompt).toContain('Also document');
      expect(refined.baseWorkspaceHash).toBe(first.baseWorkspaceHash);
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explainTurn('agent-test-owner', phaseId, refined.id, refined.proposalHash, explanation, randomUUID());
      const reference = provider.structured.mock.calls.at(-1)![1].reference;
      expect(reference.originalRequest).toContain(message);
      expect(reference.before['tasks.py']).toBe('# TODO');
      expect(reference.proposedFiles).toEqual(refined.files);
    });

    it('keeps an intervening clarification constraint in the refined proposal request', async () => {
      const first = await chatProposal();
      provider.structured.mockResolvedValueOnce(respond(conversationReply('clarification')));
      const clarify = await chat('Keep the output order unchanged; document the boundary somewhere.', { parentTurnId: first.id });
      provider.structured.mockResolvedValueOnce(respond(conversationReply('proposal'))).mockResolvedValueOnce(respond({ files: { 'tasks.py': `${files['tasks.py']} # strict boundary` } }));
      const refined = await chat('Use a comment in tasks.py.', { parentTurnId: clarify.id });
      expect(responseOf(refined).proposal.prompt).toContain('Keep the output order unchanged');
      expect(responseOf(refined).proposal.prompt).toContain(message);
    });

    it('rejects foreign conversation parents and selected proposal hashes before inference', async () => {
      const first = await chatProposal(); const proposal = responseOf(first).proposal;
      provider.structured.mockClear();
      await db.getRepository(AgentTurnEntity).update(first.id, { userId: 'someone-else' });
      await expect(chat('Exclude today.', { parentTurnId: first.id })).rejects.toThrow('not found');
      await expect(chat('Refine it.', { proposalId: proposal.id, proposalHash: '0'.repeat(64) })).rejects.toThrow('proposal changed');
      await expect(chat('Refine it.', { proposalId: proposal.id })).rejects.toThrow('required together');
      expect(provider.structured).not.toHaveBeenCalled();
    });

    it('rejects another phase parent and a changed saved base without losing the earlier turn', async () => {
      const first = await chatProposal(); provider.structured.mockClear();
      await db.getRepository(AgentTurnEntity).update(first.id, { phaseStateId: randomUUID() });
      await expect(chat('Why?', { parentTurnId: first.id })).rejects.toThrow('not found');
      await db.getRepository(AgentTurnEntity).update(first.id, { phaseStateId: phaseId });
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': 'A later saved change' } });
      await expect(chat('Why?', { parentTurnId: first.id })).rejects.toThrow('workspace changed');
      expect((await service.turn('agent-test-owner', phaseId, first.requestId)).status).toBe('completed');
      expect(provider.structured).not.toHaveBeenCalled();
    });

    it('shares one pending/completed request and refuses a changed payload under its request ID', async () => {
      let finish!: (value: unknown) => void;
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const input = { requestId: randomUUID(), message: 'What does strict comparison mean?' };
      const first = service.chat('agent-test-owner', phaseId, input);
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      const pending = await service.chat('agent-test-owner', phaseId, input);
      expect(pending.status).toBe('pending');
      await expect(service.chat('agent-test-owner', phaseId, { ...input, message: 'Different request' })).rejects.toThrow('different message');
      finish(respond(conversationReply('discussion')));
      const completed = await first;
      const duplicate = await service.chat('agent-test-owner', phaseId, input);
      expect(duplicate.id).toBe(completed.id);
      expect(duplicate.response).toEqual(completed.response);
      expect(provider.structured).toHaveBeenCalledTimes(1);
      expect(await db.getRepository(AgentTurnEntity).count()).toBe(1);
    });

    it('retains failed requests and permits only an explicit fresh request to call the provider again', async () => {
      const input = { requestId: randomUUID(), message: 'What does this change mean?' };
      provider.structured.mockRejectedValueOnce(new Error('private upstream detail'));
      const failed = await service.chat('agent-test-owner', phaseId, input);
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('assessment_unavailable');
      expect(JSON.stringify(failed)).not.toContain('private upstream');
      expect((await service.chat('agent-test-owner', phaseId, input)).id).toBe(failed.id);
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion')));
      expect((await service.chat('agent-test-owner', phaseId, { ...input, requestId: randomUUID() })).status).toBe('completed');
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect(await db.getRepository(AgentTurnEntity).count()).toBe(2);
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });

    it('marks an abandoned expired pending request failed without replaying model work', async () => {
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion')));
      const first = await chat();
      const abandoned = await db.getRepository(AgentTurnEntity).findOneByOrFail({ id: first.id });
      await db.getRepository(AgentTurnEntity).save({ ...abandoned, status: 'pending', response: null, createdAt: new Date(Date.now() - AGENT_TURN_STALE_MS - 1) });
      provider.structured.mockClear();
      const reconciled = await service.turn('agent-test-owner', phaseId, first.requestId);
      expect(reconciled.status).toBe('failed');
      expect(reconciled.errorCode).toBe('request_expired');
      expect((await service.chat('agent-test-owner', phaseId, { requestId: first.requestId, message })).status).toBe('failed');
      expect(provider.structured).not.toHaveBeenCalled();
    });

    it('times out a chat request without late proposal persistence or a second provider call', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        let finish!: (value: unknown) => void;
        provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const input = { requestId: randomUUID(), message };
        const pending = service.chat('agent-test-owner', phaseId, input);
        while (!finish) await new Promise(resolve => setImmediate(resolve));
        await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
        const failed = await pending;
        expect(failed.status).toBe('failed');
        finish(respond(conversationReply('proposal')));
        await lock.run('agent-test-owner', async () => undefined);
        expect((await service.turn('agent-test-owner', phaseId, input.requestId)).status).toBe('failed');
        expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
        expect(provider.structured).toHaveBeenCalledTimes(1);
      } finally { jest.useRealTimers(); }
    });

    it('fences an expired pending chat even before the timeout callback is delivered', async () => {
      let finish!: (value: unknown) => void;
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const requestId = randomUUID();
      const pending = service.chat('agent-test-owner', phaseId, { requestId, message: 'Explain the boundary.' });
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      await db.getRepository(AgentTurnEntity).update({ requestId }, { createdAt: new Date(Date.now() - AGENT_TURN_STALE_MS - 1) });
      finish(respond(conversationReply('discussion')));
      expect((await pending).status).toBe('failed');
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });

    it('returns bounded chronological pages and keeps request identity private to its owner', async () => {
      const repo = db.getRepository(AgentTurnEntity); const at = new Date('2026-09-15T00:00:00Z');
      for (let index = 0; index < 32; index++) await repo.save(repo.create({ userId: 'agent-test-owner', phaseStateId: phaseId, requestId: randomUUID(), requestHash: 'a'.repeat(64), kind: 'chat', status: 'completed', message: `Message ${index}`, baseWorkspaceHash: 'b'.repeat(64), createdAt: at, response: { kind: 'discussion', reply: 'Saved reply', questions: [], proposal: null } }));
      const first = await service.turns('agent-test-owner', phaseId);
      const second = await service.turns('agent-test-owner', phaseId, first.nextCursor!);
      expect(first.items).toHaveLength(30); expect(second.items).toHaveLength(2);
      expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(32);
      expect(second.nextCursor).toBeNull();
      expect(first.items[0]).not.toHaveProperty('userId'); expect(first.items[0]).not.toHaveProperty('requestHash');
      await expect(service.turn('outsider', phaseId, first.items[0].requestId)).rejects.toThrow();
      await expect(service.turns('agent-test-owner', phaseId, randomUUID())).rejects.toThrow('cursor not found');
    });

    it.each(['turn-count', 'character-count'])('refuses %s context overflow rather than silently dropping constraints', async mode => {
      const repo = db.getRepository(AgentTurnEntity); let parent: string | null = null;
      const count = mode === 'turn-count' ? 13 : 2;
      for (let index = 0; index < count; index++) {
        const row: AgentTurnEntity = await repo.save(repo.create({ userId: 'agent-test-owner', phaseStateId: phaseId, requestId: randomUUID(), requestHash: 'a'.repeat(64), kind: 'chat', status: 'completed', message: mode === 'character-count' ? 'x'.repeat(32_000) : 'Preserve all original constraints.', parentTurnId: parent, baseWorkspaceHash: workspaceHash({ 'tasks.py': '# TODO' }), response: { kind: 'clarification', reply: 'Clarify the intended change.', questions: ['Which boundary?'], proposal: null } }));
        parent = row.id;
      }
      await expect(chat('Continue.', { parentTurnId: parent! })).rejects.toThrow('Start a new conversation');
      expect(provider.structured).not.toHaveBeenCalled();
    });

    it('preserves both explanation attempts and idempotently replays the stored assessment', async () => {
      const original = await chatProposal(); const proposal = responseOf(original).proposal;
      provider.structured.mockResolvedValueOnce(respond(understanding(false)));
      const rejected = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Looks right.', randomUUID());
      expect(responseOf(rejected).proposal.explanationAssessment.adequate).toBe(false);
      const id = randomUUID(); provider.structured.mockResolvedValueOnce(respond(understanding()));
      const accepted = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, id);
      const duplicate = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, id);
      expect(duplicate.id).toBe(accepted.id); expect(duplicate.response).toEqual(accepted.response);
      expect(responseOf(await service.turn('agent-test-owner', phaseId, rejected.requestId)).proposal.explanationAssessment.adequate).toBe(false);
      expect(responseOf(accepted).proposal.explanationAssessment.adequate).toBe(true);
      expect(provider.structured).toHaveBeenCalledTimes(4);
      await expect(service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Different explanation', id)).rejects.toThrow('different message');
    });

    it('projects old and new rejected journal text on every read and excludes it from later model context', async () => {
      const original = await chatProposal(); const proposal = responseOf(original).proposal;
      provider.structured.mockResolvedValueOnce(respond(understanding(false)));
      const requestId = randomUUID();
      const rejected = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Looks correct.', requestId);
      const stored = await db.getRepository(AgentTurnEntity).findOneByOrFail({ id: rejected.id });
      // Historical private records are retained; fresh v6 provider output may not
      // contain teaching prose. Seed a legacy snapshot to exercise every read.
      const historical = responseOf(stored);
      historical.reply = 'PRIVATE RECIPE: explain the strict comparison, completed filter and each boundary test.';
      historical.questions = ['Can you repeat the private recipe?'];
      historical.proposal.explanationAssessment.version = 'learner-understanding-v5';
      historical.proposal.explanationAssessment.feedback = historical.reply;
      historical.proposal.explanationAssessment.questions = historical.questions;
      historical.proposal.explanationAssessment.dimensions.forEach((d: any) => { delete d.finding; d.reasoning = historical.reply; });
      await db.getRepository(AgentTurnEntity).save(stored);
      const snapshot = JSON.stringify(stored.response);
      provider.structured.mockClear();
      const replay = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, 'Looks correct.', requestId);
      for (const result of [rejected, replay, await service.turn('agent-test-owner', phaseId, requestId), await service.turns('agent-test-owner', phaseId)]) {
        expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPE');
        expect(JSON.stringify(result)).not.toContain('repeat the private recipe');
      }
      expect(responseOf(replay).reply).toContain('does not yet establish');
      expect(responseOf(replay).questions).toEqual(['What do the changed lines actually establish?']);
      expect(responseOf(replay).proposal.approvedAt).toBeNull();
      expect(provider.structured).not.toHaveBeenCalled();
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion')));
      await chat('Where should I inspect the change?', { parentTurnId: rejected.id });
      expect(JSON.stringify(provider.structured.mock.calls[0][1])).not.toContain('PRIVATE RECIPE');
      expect(JSON.stringify((await db.getRepository(AgentTurnEntity).findOneByOrFail({ id: rejected.id })).response)).toBe(snapshot);
    });

    it('exposes current proposal authorization separately from immutable historical snapshots', async () => {
      const first = await chatProposal(); const proposal = responseOf(first).proposal;
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      const reviewed = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, randomUUID());
      const approved = responseOf(reviewed).proposal;
      await service.edit('agent-test-owner', phaseId, approved.id, approved.proposalHash, { 'tasks.py': 'A different proposal version' });
      const current = await service.proposal('agent-test-owner', phaseId, approved.id);
      expect(current.proposalHash).not.toBe(approved.proposalHash);
      expect(current.approvedAt).toBeNull();
      expect(responseOf(await service.turn('agent-test-owner', phaseId, reviewed.requestId)).proposal.approvedAt).toBeTruthy();
      await expect(service.proposal('outsider', phaseId, approved.id)).rejects.toThrow();
    });

    it('keeps failure immutable and allows a fresh explicit explanation retry without applying it', async () => {
      const approved = await approve(); provider.structured.mockRejectedValueOnce(new Error('unavailable'));
      const requestId = randomUUID();
      const failed = await service.explainTurn('agent-test-owner', phaseId, approved.id, approved.proposalHash, 'The code proves tests passed.', requestId);
      expect(failed.status).toBe('failed'); expect(failed.message).toBe('The code proves tests passed.');
      expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: approved.id })).approvedAt).toBeNull();
      await expect(service.apply('agent-test-owner', phaseId, approved.id, approved.proposalHash)).rejects.toThrow('Explain');
      const calls = provider.structured.mock.calls.length;
      expect((await service.explainTurn('agent-test-owner', phaseId, approved.id, approved.proposalHash, 'The code proves tests passed.', requestId)).status).toBe('failed');
      expect(provider.structured).toHaveBeenCalledTimes(calls);
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      const retry = await service.explainTurn('agent-test-owner', phaseId, approved.id, approved.proposalHash, explanation, randomUUID());
      expect(retry.status).toBe('completed');
      expect(responseOf(retry).proposal.approvedAt).toBeTruthy();
      expect(responseOf(retry).proposal.appliedAt).toBeNull();
      expect((await service.turn('agent-test-owner', phaseId, requestId)).status).toBe('failed');
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ 'tasks.py': '# TODO' });
    });

    it('rolls back approval if the journal completion write fails', async () => {
      const proposal = await approve();
      const workflow = (service as any).workflow;
      const originalTransaction = workflow.transaction.bind(workflow);
      const transaction = jest.spyOn(workflow, 'transaction').mockImplementation((work: any) => originalTransaction(async (manager: any) => {
        const repo = manager.getRepository(AgentTurnEntity);
        const update = repo.update.bind(repo);
        const write = jest.spyOn(repo, 'update').mockImplementation((criteria: any, patch: any) => {
          if (patch.status === 'completed') throw new Error('Injected journal write failure');
          return update(criteria, patch);
        });
        try { return await work(manager); } finally { write.mockRestore(); }
      }));
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      try {
        const failed = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, randomUUID());
        expect(failed.status).toBe('failed'); expect(failed.response).toBeNull();
        const current = await service.proposal('agent-test-owner', phaseId, proposal.id);
        expect(current.approvedAt).toBeNull(); expect(current.explanationAssessment).toBeNull();
        await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
      } finally { transaction.mockRestore(); }
    });

    it.each(['failed', 'expired'] as const)('never authorizes an explanation whose turn became %s during inference', async state => {
      const proposal = await propose(); let finish!: (value: unknown) => void;
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const requestId = randomUUID();
      const pending = service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, requestId);
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      const repo = db.getRepository(AgentTurnEntity); const turn = await repo.findOneByOrFail({ requestId });
      if (state === 'failed') await repo.update(turn.id, { status: 'failed', errorCode: 'request_expired' });
      else await repo.update(turn.id, { createdAt: new Date(Date.now() - AGENT_TURN_STALE_MS - 1) });
      finish(respond(understanding()));
      expect((await pending).status).toBe('failed');
      expect((await service.proposal('agent-test-owner', phaseId, proposal.id)).approvedAt).toBeNull();
      await expect(service.apply('agent-test-owner', phaseId, proposal.id, proposal.proposalHash)).rejects.toThrow('Explain');
    });

    it('preserves discussion lineage through an explanation without using it as learner understanding', async () => {
      const first = await chatProposal(); const proposal = responseOf(first).proposal;
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion', 'The earlier discussion describes the comparison.')));
      const discussion = await chat('Why is this comparison strict?', { parentTurnId: first.id });
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      const requestId = randomUUID();
      const explained = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, requestId, discussion.id);
      expect(explained.parentTurnId).toBe(discussion.id);
      expect(provider.structured.mock.calls.at(-1)![1].learnerAnswer).toBe(explanation);
      expect(provider.structured.mock.calls.at(-1)![1]).not.toHaveProperty('precedingConversation');
      provider.structured.mockResolvedValueOnce(respond(conversationReply('discussion')));
      await chat('Could you revisit the earlier comparison question?', { parentTurnId: explained.id });
      expect(provider.structured.mock.calls.at(-1)![1].precedingConversation.map((turn: any) => turn.learner)).toContain('Why is this comparison strict?');
      await expect(service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, requestId, first.id)).rejects.toThrow('different message');
    });

    it.each(['workspace', 'proposal'])('does not persist a stale reply after an in-flight %s change', async change => {
      const first = await chatProposal(); const proposal = responseOf(first).proposal;
      let finish!: (value: unknown) => void;
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = chat('Why this comparison?', { parentTurnId: first.id });
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      if (change === 'workspace') await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': 'New saved bytes' } });
      else await service.edit('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, { 'tasks.py': 'Edited proposed bytes' });
      finish(respond(conversationReply('discussion')));
      const stale = await pending;
      expect(stale.status).toBe('failed'); expect(stale.errorCode).toBe('proposal_changed');
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(1);
    });

    it.each([null, { kind: 'proposal', reply: 'Approved', questions: ['Explain it?'] }, { kind: 'explanation', reply: 'You understand it', questions: [] }, { kind: 'discussion', reply: 'Approved', questions: [], approvedAt: 'now' }])('refuses malformed or implicit-approval conversational output %j', async value => {
      provider.structured.mockResolvedValueOnce(respond(value));
      const result = await chat();
      expect(result.status).toBe('failed'); expect(result.response).toBeNull();
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
      expect(provider.structured).toHaveBeenCalledTimes(1);
    });
  });
  /**
   * The bounded edit list behind AI_AGENTIC_EDIT_LIST, default off. The
   * learner's summary beside an edit list is tested in the proposal summary
   * block below, not here.
   * Modes `on` and `strict` behave alike: a list that does not apply fails
   * the turn, and no whole-file request is made in its place.
   */
  describe('the step-4 edit-list flag', () => {
    const message = 'Adjust the strict overdue comparison; preserve completed-task exclusion.';
    const proposalReply = { kind: 'proposal', reply: 'Understood: one bounded change.', questions: [] };
    const say = (text = message, context: Record<string, string> = {}) => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: text, ...context });
    const held = { mode: config.agenticEditList };
    const saved = { 'tasks.py': 'def overdue(due, today):\n    return due <= today\n' };
    const target = 'def overdue(due, today):\n    return due < today\n';
    const edit = (oldString: string, newString: string, path = 'tasks.py') => ({ files: [], edits: [{ path, oldString, newString }] });
    const count = () => db.getRepository(AgentProposalEntity).count();
    const savedWorkspace = async () => (await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace;
    const usageRows = () => (service as any).assistant.recordReviewUsage.mock.calls.length;
    const OLD_CHAT_SENTENCE = 'Return {"files":{"editable/path":"complete revised file contents"},"summary":"..."} with only changed editable files relative to proposedWorkspace. Also return "summary": at most three short present-tense statements for the learner ("Changes ...", "Adds ..."), naming by its path every file this proposal changes (each one when it changes several) and which record sections change, what to read before explaining it and, only if this phase has something to run, what to run after Apply; never why it is right or what it means for the system.';
    const OLD_PROPOSE_SENTENCE = 'Return {"files":{"editable/path":"complete revised file contents"},"summary":"..."}. Only include changed editable files. Also return "summary": at most three short present-tense statements for the learner ("Changes ...", "Adds ..."), naming by its path every file this proposal changes (each one when it changes several) and which record sections change, what to read before explaining it and, only if this phase has something to run, what to run after Apply; never why it is right or what it means for the system.';

    beforeEach(async () => {
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: saved });
    });
    afterEach(() => {
      config.agenticEditList = held.mode;
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('sends the whole-file generation request byte for byte when the flag is off', async () => {
      config.agenticEditList = 'off';
      const context = composeAgenticIntentAssessment(phase).slice(0, composeAgenticIntentAssessment(phase).indexOf(' Assess whether the learner'));
      expect(composeAgentChatGeneration(phase, 'files')).toBe(`${context} The preceding semantic intent assessment identified an adequate request to propose or refine a bounded change. Preserve all original constraints and unchanged existing proposed edits. ${OLD_CHAT_SENTENCE} This is a proposal, never Apply or an assessment of learner understanding.`);
      expect(composeAgenticProposeGeneration(phase, 'files')).toBe(`${context} The learner's intent was assessed as adequate. Propose the smallest change that satisfies their request and constraints. ${OLD_PROPOSE_SENTENCE} This is a proposal for learner review, never an authorized apply.`);
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      expect((await say()).status).toBe('completed');
      const [system, data, tokens, , schema, call] = provider.structured.mock.calls[1];
      expect(system).toBe(composeAgentChatGeneration(phase, 'files'));
      expect(system).toContain(OLD_CHAT_SENTENCE);
      expect(Object.keys(data).sort()).toEqual(['originalAndContinuedRequest', 'precedingConversation', 'proposedWorkspace', 'savedWorkspace']);
      expect([tokens, schema, call]).toEqual([9000, undefined, 'agentic.generate']);
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      await service.propose('agent-test-owner', phaseId, 'Make the comparison strict.');
      const [psystem, pdata, ptokens, , pschema, pcall] = provider.structured.mock.calls[1];
      expect(psystem).toBe(composeAgenticProposeGeneration(phase, 'files'));
      expect(pdata).toEqual({ prompt: 'Make the comparison strict.', workspace: saved });
      expect([ptokens, pschema, pcall]).toEqual([9000, undefined, 'agentic.generate']);
    });

    it('asks for an edit list against the selected proposal\'s bytes, and refuses an anchor only the saved file holds', async () => {
      phase.files.push({ path: 'note.md', content: 'Original note', editable: true });
      config.agenticEditList = 'on';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('due <= today', 'due < today')));
      const first = await say();
      expect(first.status).toBe('completed');
      const selected = (first.response as any).proposal;
      expect(selected.files).toEqual({ 'tasks.py': target });
      const [, , , , schema, call] = provider.structured.mock.calls[1];
      expect(schema.name).toBe(AGENT_EDIT_LIST_SCHEMA_NAME);
      expect(schema.schema.properties.edits.items.properties.path.enum).toEqual(['note.md', 'tasks.py']);
      expect(call).toBe('agentic.generate.edits');
      // An anchor present only in the selected proposal's bytes expands.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('return due < today', 'return due < today  # strict')));
      const refined = await say('Comment the boundary.', { parentTurnId: first.id, proposalId: selected.id, proposalHash: selected.proposalHash });
      expect(provider.structured.mock.calls[3][1].proposedWorkspace['tasks.py']).toBe(target);
      expect(refined.status).toBe('completed');
      expect((refined.response as any).proposal.files).toEqual({ 'tasks.py': 'def overdue(due, today):\n    return due < today  # strict\n' });
      // An anchor present only in the saved file (already replaced by the selection) is refused.
      const before = await count();
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('due <= today', 'due >= today'))).mockResolvedValueOnce(respond(edit('due <= today', 'due >= today')));
      const stale = await say('Again.', { parentTurnId: first.id, proposalId: selected.id, proposalHash: selected.proposalHash });
      expect([stale.status, stale.errorCode, stale.errorMessage]).toEqual(['failed', 'files_proposal_refused', `${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that is not in that file.`]);
      expect(await count()).toBe(before);
      expect(await savedWorkspace()).toEqual(saved);
    });

    it('produces byte-identical files and hash from an edit list and from whole-file output, and applies them', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      const whole = (await say()).response as any;
      config.agenticEditList = 'on';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('due <= today', 'due < today')));
      const edited = (await say()).response as any;
      expect(edited.proposal.files).toEqual(whole.proposal.files);
      expect(edited.proposal.proposalHash).toBe(whole.proposal.proposalHash);
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      const explained = await service.explain('agent-test-owner', phaseId, edited.proposal.id, edited.proposal.proposalHash, explanation);
      expect(explained.explanationAssessment?.adequate).toBe(true);
      expect((await service.apply('agent-test-owner', phaseId, edited.proposal.id, edited.proposal.proposalHash)).workspace).toEqual({ 'tasks.py': target });
    });

    it.each(['on', 'strict'] as const)('in mode %s fails the turn loudly after its one regeneration, applies nothing, and never re-asks for whole files', async (mode) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('not in the file', 'x'))).mockResolvedValueOnce(respond(edit('not in the file', 'x')));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['failed', 'files_proposal_refused']);
      expect(await count()).toBe(0);
      expect(await savedWorkspace()).toEqual(saved);
      // The regeneration is the same edit-list call, never the whole-file re-ask.
      expect(provider.structured).toHaveBeenCalledTimes(3);
      expect(provider.structured.mock.calls[2][4].name).toBe(AGENT_EDIT_LIST_SCHEMA_NAME);
      expect(provider.structured.mock.calls[2][5]).toBe('agentic.generate.edits');
      // One usage row a model call.
      expect(usageRows()).toBe(3);
    });

    it('records two usage rows for a flag-off proposal turn', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      await say();
      expect(usageRows()).toBe(2);
    });

    it('applies the flag to the legacy propose endpoint with the saved workspace as the base', async () => {
      config.agenticEditList = 'on';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(edit('due <= today', 'due < today')));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Make the comparison strict.');
      expect(proposal.files).toEqual({ 'tasks.py': target });
      const [system, data, , , schema] = provider.structured.mock.calls[1];
      expect(system).toBe(composeAgenticProposeGeneration(phase, 'edits'));
      expect(system).toContain('out of workspace');
      expect(data).toEqual({ prompt: 'Make the comparison strict.', workspace: saved });
      expect(schema.name).toBe(AGENT_EDIT_LIST_SCHEMA_NAME);
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(edit('not there', 'x'))).mockResolvedValueOnce(respond(edit('not there', 'x')));
      await expect(service.propose('agent-test-owner', phaseId, 'Again.')).rejects.toThrow(`${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that is not in that file.`);
      expect(await count()).toBe(1);
    });

    it('keeps the match sentence for match failures only; a malformed edit list gets its own reason', async () => {
      config.agenticEditList = 'strict';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: 'x', edits: [] })).mockResolvedValueOnce(respond({ files: 'x', edits: [] }));
      await expect(service.propose('agent-test-owner', phaseId, 'Make it strict.')).rejects.toThrow(`${FILES_PROPOSAL_REFUSED} The proposal is not in the edit-list shape.`);
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'tasks.py', oldString: 'due', newString: 'x' }] })).mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'tasks.py', oldString: 'due', newString: 'x' }] }));
      await expect(service.propose('agent-test-owner', phaseId, 'Make it strict.')).rejects.toThrow(`${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that appears more than once in that file.`);
      expect(await count()).toBe(0);
    });

    it('changes neither classification prompt nor the mentor\'s instruction identity (guard)', () => {
      const withMentor = { ...phase, assistant: { systemPrompt: 'Mentor.' } };
      const take = () => [composeAgentChatAssessment(phase), composeAgenticIntentAssessment(phase), mentorInstructionIdentity(withMentor)];
      config.agenticEditList = 'off';
      const off = take();
      for (const mode of ['on', 'strict'] as const) {
        config.agenticEditList = mode;
        expect(take()).toEqual(off);
      }
    });

    it('keeps an empty edit list failing exactly as an empty file map does', async () => {
      const outcome = async (mode: 'off' | 'on', value: unknown, context: Record<string, string> = {}) => {
        config.agenticEditList = mode;
        provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(value)).mockResolvedValueOnce(respond(value));
        const turn = await say(message, context);
        return [turn.status, turn.errorCode, await count()];
      };
      expect(await outcome('off', { files: {} })).toEqual(['failed', 'files_proposal_refused', 0]);
      expect(await outcome('on', { files: [], edits: [] })).toEqual(['failed', 'files_proposal_refused', 0]);
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      const first = await say();
      const selected = (first.response as any).proposal;
      const refine = { parentTurnId: first.id, proposalId: selected.id, proposalHash: selected.proposalHash };
      expect(await outcome('off', { files: {} }, refine)).toEqual(['failed', 'files_proposal_refused', 1]);
      expect(await outcome('on', { files: [], edits: [] }, refine)).toEqual(['failed', 'files_proposal_refused', 1]);
    });

    it('never leaks model or learner text into the edit-list diagnostic', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      config.agenticEditList = 'strict';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('SENTINEL-OLD-STRING', 'SENTINEL-NEW')));
      await say('SENTINEL-LEARNER please change it');
      config.agenticEditList = 'on';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(edit('due <= today', 'due < today')));
      await service.propose('agent-test-owner', phaseId, 'SENTINEL-LEARNER strict');
      const lines = [...log.mock.calls, ...warn.mock.calls].map(call => String(call[0])).filter(line => line.startsWith('agentic_edit_list '));
      expect(lines).toEqual([
        'agentic_edit_list mode=strict site=chat outcome=rejected edits=1 files=0 paths=1 code=no_match',
        'agentic_edit_list mode=on site=propose outcome=expanded edits=1 files=0 paths=1 code=none',
      ]);
      for (const line of lines) expect(line).toMatch(/^agentic_edit_list mode=(on|strict) site=(chat|propose) outcome=(expanded|rejected) edits=\d+ files=\d+ paths=\d+ code=[a-z_]+$/);
      expect(lines.join('\n')).not.toMatch(/SENTINEL|due <= today|def overdue/);
    });

    it('refuses to boot with an invalid AI_AGENTIC_EDIT_LIST, and boots when it is unset', () => {
      const heldEnv = process.env.AI_AGENTIC_EDIT_LIST;
      const build = () => new AgenticService(db.getRepository(AgentProposalEntity), {} as any, {} as any, provider as any, db, db.getRepository(ExecutionRunEntity), {} as any);
      try {
        process.env.AI_AGENTIC_EDIT_LIST = 'yes';
        expect(build).toThrow('AI_AGENTIC_EDIT_LIST must be off, on or strict');
        delete process.env.AI_AGENTIC_EDIT_LIST;
        expect(build).not.toThrow();
      } finally {
        if (heldEnv === undefined) delete process.env.AI_AGENTIC_EDIT_LIST;
        else process.env.AI_AGENTIC_EDIT_LIST = heldEnv;
      }
    });
  });

  /*
   * A generated answer the server cannot read: an edit list the expander refuses (`"purpose": ""` quoted where the
   * record holds it four times; an anchor with a line dropped) or a generated file map the server cannot take. It is
   * a refusal like any structured proposal's: the code files_proposal_refused, its fixed sentence and the rule's
   * reason on the turn, one line of fixed tokens in the log, never the bare provider failure. Every turn that fails
   * as assessment_unavailable logs which throw site it came from.
   */
  describe('a generated proposal the server cannot read', () => {
    const held = config.agenticEditList;
    const proposalReply = { kind: 'proposal', reply: 'Understood: one bounded change.', questions: [] };
    const saved = { 'tasks.py': 'def overdue(due, today):\n    return due <= today\n' };
    const say = (text = 'Adjust the strict overdue comparison; preserve completed-task exclusion.') => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: text });
    const edit = (oldString: string, newString: string, path = 'tasks.py') => ({ files: [], edits: [{ path, oldString, newString }] });
    const lines = (log: jest.SpyInstance, prefix: string) => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(prefix));
    beforeEach(async () => {
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: saved });
      config.agenticEditList = 'strict';
    });
    afterEach(() => { config.agenticEditList = held; jest.restoreAllMocks(); });

    it('fails a chat turn whose edit list is refused with the refusal\'s sentence and reason, and one refusal line', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('due', 'SENTINEL-NEW'))).mockResolvedValueOnce(respond(edit('due', 'SENTINEL-NEW')));
      const turn = await say();
      expect([turn.status, turn.errorCode, turn.errorMessage]).toEqual(['failed', 'files_proposal_refused', `${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that appears more than once in that file.`]);
      expect(turn).not.toHaveProperty('errorDetail');
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual(saved);
      expect(lines(log, 'agentic_proposal_refused ')).toEqual(['agentic_proposal_refused kind=chat code=files_proposal_refused clause=edit_list']);
      expect(lines(log, 'agentic_turn_unavailable ')).toEqual([]);
      expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/SENTINEL/);
    });

    it('fails a chat turn whose generated files the server cannot take with the validator\'s reason, in either mode', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [] })).mockResolvedValueOnce(respond({ files: [], edits: [] }));
      const empty = await say();
      expect([empty.status, empty.errorCode, empty.errorMessage]).toEqual(['failed', 'files_proposal_refused', `${FILES_PROPOSAL_REFUSED} The proposal changes no file.`]);
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'SENTINEL/not-editable.py': 'x' } })).mockResolvedValueOnce(respond({ files: { 'SENTINEL/not-editable.py': 'x' } }));
      const foreign = await say();
      expect([foreign.status, foreign.errorCode, foreign.errorMessage]).toEqual(['failed', 'files_proposal_refused', `${FILES_PROPOSAL_REFUSED} The proposal contains invalid or non-editable files.`]);
      expect(lines(log, 'agentic_proposal_refused ')).toEqual([
        'agentic_proposal_refused kind=chat code=files_proposal_refused clause=invalid_files',
        'agentic_proposal_refused kind=chat code=files_proposal_refused clause=invalid_files',
      ]);
      expect(lines(log, 'agentic_turn_failed ')).toEqual([]);
    });

    it('refuses the same at the propose door: a 400 with the sentence and reason, logged once, nothing stored', async () => {
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(edit('due <= today;', 'x'))).mockResolvedValueOnce(respond(edit('due <= today;', 'x')));
      expect(await refusedAtDoor(() => service.propose('agent-test-owner', phaseId, 'Make it strict.'), `${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that is not in that file.`))
        .toEqual(['agentic_proposal_refused kind=propose code=files_proposal_refused clause=edit_list']);
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'SENTINEL/not-editable.py': 'x' } })).mockResolvedValueOnce(respond({ files: { 'SENTINEL/not-editable.py': 'x' } }));
      await expect(service.propose('agent-test-owner', phaseId, 'Make it strict.')).rejects.toMatchObject({ status: 400, message: `${FILES_PROPOSAL_REFUSED} The proposal contains invalid or non-editable files.` });
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
    });

    it('logs the throw site of every assessment_unavailable turn in fixed tokens, never model or learner text', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      // The generation call itself fails.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockRejectedValueOnce(new ProviderUsageError('SENTINEL provider body', 3, 4));
      const failedCall = await say('SENTINEL-LEARNER change it');
      // The mentor's reply is not a conversational answer.
      provider.structured.mockResolvedValueOnce(respond({ kind: 'SENTINEL', reply: 'x', questions: [] }));
      const badReply = await say();
      // The explanation's assessment is unreadable.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('due <= today', 'due < today')));
      const proposed = await say();
      const proposal = (proposed.response as any).proposal;
      // Refused twice: an assessment the parser refuses is asked about once more (the explanation re-ask), so the
      // second answer is fed too and refused, and the line below is the re-asked explanation's, not an unmocked call's.
      provider.structured.mockResolvedValueOnce(respond({ SENTINEL: true })).mockResolvedValueOnce(respond({ SENTINEL: true }));
      const explained = await service.explainTurn('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation, randomUUID());
      expect(provider.structured.mock.calls.filter(call => call[5] === 'agentic.explanation')).toHaveLength(2);
      expect([failedCall.errorCode, badReply.errorCode, explained.errorCode]).toEqual(['assessment_unavailable', 'assessment_unavailable', 'assessment_unavailable']);
      expect(lines(log, 'agentic_turn_unavailable ')).toEqual([
        'agentic_turn_unavailable kind=chat site=model_call call=agentic.generate.edits',
        'agentic_turn_unavailable kind=chat site=chat_reply call=none',
        'agentic_turn_unavailable kind=explain site=explanation_assessment call=none',
      ]);
      expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/SENTINEL/);
    });

    it('names the route deadline as the site when the 55 s budget runs out', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        let finish!: (value: unknown) => void;
        provider.structured.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = say();
        while (!finish) await new Promise(resolve => setImmediate(resolve));
        await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
        expect((await pending).errorCode).toBe('assessment_unavailable');
        finish(respond(proposalReply));
        await lock.run('agent-test-owner', async () => undefined);
      } finally { jest.useRealTimers(); }
      expect(lines(log, 'agentic_turn_unavailable ')).toEqual(['agentic_turn_unavailable kind=chat site=deadline call=none']);
    });

    /*
     * One regeneration inside the same call: a generated answer the server refuses is asked for once more,
     * with the refusal's own words in the briefing, when the route's one 55 s budget leaves room for it. The budget,
     * the timeout, the gate and the explanation are untouched; a second refusal fails the turn with its own reason.
     */
    describe('the one regeneration', () => {
      const target = 'def overdue(due, today):\n    return due < today\n';
      const MULTIPLE = `${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that appears more than once in that file.`;
      const NOT_THERE = `${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that is not in that file.`;

      it('asks once more with the refusal\'s reason in the briefing, and completes with the second answer', async () => {
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        provider.structured.mockResolvedValueOnce(respond(proposalReply))
          .mockResolvedValueOnce(respond(edit('due', 'x')))
          .mockResolvedValueOnce(respond({ ...edit('due <= today', 'due < today'), summary: 'Changes tasks.py to a strict comparison.' }));
        const turn = await say();
        expect(turn.status).toBe('completed');
        const proposal = (turn.response as any).proposal;
        expect(proposal.files).toEqual({ 'tasks.py': target });
        expect(proposal.summary).toBe('Changes tasks.py to a strict comparison.');
        expect(provider.structured).toHaveBeenCalledTimes(3);
        const [first, second] = [provider.structured.mock.calls[1], provider.structured.mock.calls[2]];
        // The same call, the same data, the same schema and label: only the briefing's last sentence is new.
        expect(second[0]).toBe(`${first[0]}${regenerationSentence(new RefusedProbe(MULTIPLE), 'edits')}`);
        expect(second[0]).toContain(MULTIPLE);
        expect([second[1], second[2], second[4], second[5]]).toEqual([first[1], first[2], first[4], 'agentic.generate.edits']);
        expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(3);
        expect(lines(log, 'agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=files_proposal_refused clause=edit_list outcome=started']);
        expect(lines(log, 'agentic_proposal_refused ')).toEqual([]);
      });

      it('fails with the second refusal\'s reason when the second answer is refused too, and never asks a third time', async () => {
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(edit('due', 'x'))).mockResolvedValueOnce(respond(edit('not there', 'x')));
        const turn = await say();
        expect([turn.status, turn.errorCode, turn.errorMessage]).toEqual(['failed', 'files_proposal_refused', NOT_THERE]);
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(await db.getRepository(AgentProposalEntity).count()).toBe(0);
        expect(lines(log, 'agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=files_proposal_refused clause=edit_list outcome=started']);
        expect(lines(log, 'agentic_proposal_refused ')).toEqual(['agentic_proposal_refused kind=chat code=files_proposal_refused clause=edit_list']);
      });

      it('regenerates at the propose door too, and logs only the refusal the learner reads', async () => {
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: [], edits: [] })).mockResolvedValueOnce(respond(edit('due <= today', 'due < today')));
        expect((await service.propose('agent-test-owner', phaseId, 'Make it strict.')).files).toEqual({ 'tasks.py': target });
        expect(provider.structured.mock.calls[2][0]).toContain(`${FILES_PROPOSAL_REFUSED} The proposal changes no file.`);
        expect(lines(log, 'agentic_regeneration ')).toEqual(['agentic_regeneration site=propose code=files_proposal_refused clause=invalid_files outcome=started']);
        expect(lines(log, 'agentic_proposal_refused ')).toEqual([]);
      });

      it('does not regenerate when the budget left is not more than twice the first generation plus the reply\'s 5 s', async () => {
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
          let finish!: (value: unknown) => void;
          provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
          const pending = say();
          while (!finish) await new Promise(resolve => setImmediate(resolve));
          // 17 s spent: 38 s left, not more than 2 x 17 + 5 = 39 s.
          await jest.advanceTimersByTimeAsync(17_000);
          finish(respond(edit('due', 'x')));
          const turn = await pending;
          expect([turn.status, turn.errorCode, turn.errorMessage]).toEqual(['failed', 'files_proposal_refused', MULTIPLE]);
        } finally { jest.useRealTimers(); }
        expect(provider.structured).toHaveBeenCalledTimes(2);
        expect(lines(log, 'agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=files_proposal_refused clause=edit_list outcome=skipped']);
      });

      it('reads the budget rule: more than twice the first generation plus 5 s, and at least 15 s', () => {
        expect(REGENERATION_MIN_LEFT_MS).toBe(15_000);
        expect([regenerationFits(46_000, 8_000), regenerationFits(21_001, 8_000), regenerationFits(21_000, 8_000)]).toEqual([true, true, false]);
        expect([regenerationFits(15_001, 1_000), regenerationFits(15_000, 1_000)]).toEqual([true, false]);
        // A Design-length first generation (30 s) never leaves room inside 55 s.
        expect(regenerationFits(AGENTIC_REQUEST_TIMEOUT_MS - 32_000, 30_000)).toBe(false);
      });

      it('never regenerates a proposal that changed nothing, and words the ask for the whole-file contract without edits', async () => {
        const unchanged = new RefusedProbe(DESIGN_PROPOSAL_UNCHANGED, 'design_proposal_unchanged', 'unchanged');
        expect(regenerationSentence(unchanged, 'files')).not.toMatch(/edits/);
        expect(regenerationSentence(new RefusedProbe(MULTIPLE), 'files')).not.toMatch(/\bedits\b/);
        expect(regenerationSentence(new RefusedProbe(MULTIPLE), 'edits')).toMatch(/whole in files/);
      });
    });
  });

  /*
   * The generation payload (AI_AGENTIC_PAYLOAD). `full`, the default, sends
   * the whole generation request, byte for byte as the golden records it; `trim` changes only the generation
   * call's payload and appends one sentence to its system text. classify, the
   * explanation, apply and validateFiles are untouched in either mode.
   */
  /*
   * The learner's proposal summary: written inside the one generation
   * call in either mode, read through readProposalSummary, stored on the
   * proposal and returned on its view. A missing one is null and never
   * refuses the proposal, and it is never part of the explanation assessment.
   */
  describe('the learner\'s proposal summary', () => {
    const held = config.agenticEditList;
    const SUMMARY = 'Changes the overdue comparison in tasks.py to strict. Check that a task due today is no longer overdue.';
    const saved = { 'tasks.py': 'def overdue(due, today):\n    return due <= today\n' };
    const target = 'def overdue(due, today):\n    return due < today\n';
    const proposalReply = { kind: 'proposal', reply: 'Understood: one bounded change.', questions: [] };
    const generation = (mode: 'off' | 'on', ...summary: unknown[]) => ({
      ...(mode === 'off' ? { files: { 'tasks.py': target } } : { files: [], edits: [{ path: 'tasks.py', oldString: 'due <= today', newString: 'due < today' }] }),
      ...(summary.length ? { summary: summary[0] } : {}),
    });
    const stored = async (id: string) => (await db.getRepository(AgentProposalEntity).findOneByOrFail({ id })).summary;
    const say = () => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Make the overdue comparison strict; keep completed tasks excluded.' });
    beforeEach(async () => { await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: saved }); });
    afterEach(() => { config.agenticEditList = held; });

    it.each(['off', 'on'] as const)('a chat proposal with the edit list %s stores and returns the summary, read as one line', async (mode) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation(mode, `  ${SUMMARY.replace('. ', '.\n\n  ')} `)));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const proposal = (turn.response as any).proposal;
      expect(proposal.files).toEqual({ 'tasks.py': target });
      expect(proposal.summary).toBe(SUMMARY);
      expect(await stored(proposal.id)).toBe(SUMMARY);
      // Inside the one generation call: no third call.
      expect(provider.structured).toHaveBeenCalledTimes(2);
    });

    it.each(['off', 'on'] as const)('a propose-door proposal with the edit list %s stores and returns the summary', async (mode) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation(mode, SUMMARY)));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Make the overdue comparison strict.');
      expect(proposal.files).toEqual({ 'tasks.py': target });
      expect((proposal as any).summary).toBe(SUMMARY);
      expect(await stored(proposal.id)).toBe(SUMMARY);
      expect(provider.structured).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['off', 'absent', []], ['on', 'absent', []], ['off', 'a number', [7]], ['on', 'blank', ['  ']],
    ] as const)('with the edit list %s, a summary that is %s stores null and the proposal still completes', async (mode, _label, summary) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation(mode, ...summary)));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const proposal = (turn.response as any).proposal;
      expect(proposal.files).toEqual({ 'tasks.py': target });
      expect(proposal.summary).toBeNull();
      expect(await stored(proposal.id)).toBeNull();
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation(mode, ...summary)));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Make the overdue comparison strict.');
      expect((proposed as any).summary).toBeNull();
      expect(await stored(proposed.id)).toBeNull();
    });

    it('a learner\'s edit clears the summary, which described the proposal before the edit', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off', SUMMARY)));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Make the overdue comparison strict.');
      expect(await stored(proposal.id)).toBe(SUMMARY);
      const edited = await service.edit('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, { 'tasks.py': 'def overdue(due, today):\n    return due < today and due is not None\n' });
      expect((edited as any).summary).toBeNull();
      expect(await stored(proposal.id)).toBeNull();
      expect(provider.structured).toHaveBeenCalledTimes(2);
    });

    it.each(['off', 'on'] as const)('with the edit list %s, both doors ask the one generation call to name every changed file by its path', async (mode) => {
      config.agenticEditList = mode;
      const asks = 'naming by its path every file this proposal changes (each one when it changes several)';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation(mode, SUMMARY)));
      expect((await say()).status).toBe('completed');
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation(mode, SUMMARY)));
      await service.propose('agent-test-owner', phaseId, 'Make the overdue comparison strict.');
      // The second call of each door is its one generation call (the first assesses the request).
      expect(provider.structured).toHaveBeenCalledTimes(4);
      const generations = [provider.structured.mock.calls[1], provider.structured.mock.calls[3]];
      for (const [system] of generations) expect((system as string).split(asks)).toHaveLength(2);
    });

    it('an inadequate prompt makes no generation call and stores no summary', async () => {
      provider.structured.mockResolvedValueOnce(respond(bad));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Do it.');
      expect(provider.structured).toHaveBeenCalledTimes(1);
      expect(await stored(proposal.id)).toBeNull();
    });

    it('never sends the summary to the explanation assessment', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off', SUMMARY)));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Make the overdue comparison strict.');
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
      const [, data] = provider.structured.mock.calls.at(-1)!;
      expect(Object.keys((data as { reference: object }).reference).sort()).toEqual(['before', 'latestEdit', 'originalRequest', 'proposalHash', 'proposedFiles']);
      expect(JSON.stringify(data)).not.toContain('no longer overdue');
    });
  });

  /*
   * The summary's paths against the proposal's files. On Design
   * request 2 of three takes the model's summary named shared/contract/api.json as
   * changed while the proposal held design/design.json and shared/contract/screens.json
   * only. After the one generation call, both doors read which of the phase's paths the
   * summary names; when one is not a file the proposal holds, the stored summary is one
   * sentence alone, "Files in this proposal: <held paths>.", in the proposal's order, and
   * the model's words are not shown. One
   * line of integers per summary checked; no model call, no request byte and no usage row
   * changes.
   */
  describe('the summary\'s paths against the proposal\'s files', () => {
    const heldMode = config.agenticEditList;
    const DESIGN = 'design/design.json';
    const API = 'shared/contract/api.json';
    const SCREENS = 'shared/contract/screens.json';
    const saved = { [DESIGN]: '{"decisions":[]}\n', [API]: '{"operations":[]}\n', [SCREENS]: '{"screens":[]}\n' };
    const changed = { [DESIGN]: '{"decisions":["D1","D2"]}\n', [SCREENS]: '{"screens":["overdue empty state"]}\n' };
    // A Design summary naming a contract the proposal does not hold.
    const TT5 = 'Changed design/design.json decisions, shared/contract/api.json contracts, and shared/contract/screens.json screen empty state. Check the exact decision wording and contract entries before accepting.';
    const FILES_ONLY = 'Files in this proposal: design/design.json, shared/contract/screens.json.';
    // api.json is editable in this phase, so the server's sentence names it after the file sentence.
    const API_NAMED = "The mentor's answer also named shared/contract/api.json; this proposal does not change it. If you wanted it changed, ask again for it.";
    const FILES_NAMED = `${FILES_ONLY} ${API_NAMED}`;
    const proposalReply = { kind: 'proposal', reply: 'Understood: the two decisions and the empty state.', questions: [] };
    const generation = (mode: 'off' | 'on', summary?: string, files: Record<string, string> = changed) => ({
      ...(mode === 'off' ? { files } : { files: Object.entries(files).map(([path, contents]) => ({ path, contents })), edits: [] }),
      ...(summary === undefined ? {} : { summary }),
    });
    const stored = async (id: string) => (await db.getRepository(AgentProposalEntity).findOneByOrFail({ id })).summary;
    const say = (message = 'Record decisions D1 and D2 and the overdue empty state.', extra: { parentTurnId?: string; proposalId?: string; proposalHash?: string } = {}) => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message, ...extra });
    const ask = () => service.propose('agent-test-owner', phaseId, 'Record decisions D1 and D2 and the overdue empty state.');
    let logs: jest.SpyInstance;
    const lines = () => logs.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('agentic_summary_paths'));
    beforeEach(async () => {
      phase.files = [
        { path: DESIGN, content: saved[DESIGN], editable: true }, { path: API, content: saved[API], editable: true },
        { path: SCREENS, content: saved[SCREENS], editable: true }, { path: 'README.md', content: '# TaskTrackr\n', editable: false },
      ];
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: saved });
      logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => { config.agenticEditList = heldMode; logs.mockRestore(); });

    it.each(['off', 'on'] as const)('with the edit list %s, a propose-door summary naming a contract the proposal does not hold is replaced by the file sentence and the server\'s sentence naming the contract, stored, returned and read back', async (mode) => {
      config.agenticEditList = mode;
      // api.json is editable here, so the stored summary names it; the request does not write it out,
      // so the answer is not asked for again.
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation(mode, TT5)));
      const proposal = await ask();
      expect(Object.keys(proposal.files)).toEqual([DESIGN, SCREENS]);
      expect((proposal as any).summary).toBe(FILES_NAMED);
      expect(await stored(proposal.id)).toBe(FILES_NAMED);
      expect((await service.proposal('agent-test-owner', phaseId, proposal.id) as any).summary).toBe(FILES_NAMED);
      expect((await service.list('agent-test-owner', phaseId)).map(item => (item as any).summary)).toEqual([FILES_NAMED]);
      expect(lines()).toEqual(['agentic_summary_paths names=3 held=2 extra=1 unnamed=0']);
      // No model call of its own, and the usage rows are the two calls' own.
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(2);
    });

    it.each(['off', 'on'] as const)('with the edit list %s, a chat proposal\'s summary is replaced by the same sentences on its turn and its row', async (mode) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation(mode, TT5)));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const proposal = (turn.response as any).proposal;
      expect(Object.keys(proposal.files)).toEqual([DESIGN, SCREENS]);
      expect(proposal.summary).toBe(FILES_NAMED);
      expect(await stored(proposal.id)).toBe(FILES_NAMED);
      expect(lines()).toEqual(['agentic_summary_paths names=3 held=2 extra=1 unnamed=0']);
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(2);
    });

    it('lists the held paths in the proposal\'s own order, and every one of them', async () => {
      config.agenticEditList = 'off';
      const reversed = { [SCREENS]: changed[SCREENS], [DESIGN]: changed[DESIGN] };
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off', `Changed ${API}.`, reversed)));
      const proposal = await ask();
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect(Object.keys(proposal.files)).toEqual([SCREENS, DESIGN]);
      expect(await stored(proposal.id)).toBe(`Files in this proposal: shared/contract/screens.json, design/design.json. ${API_NAMED}`);
      expect(lines()).toEqual(['agentic_summary_paths names=1 held=2 extra=1 unnamed=2']);
    });

    it('counts a read-only file of the phase the summary names as a path the proposal does not hold, and keeps the summary', async () => {
      config.agenticEditList = 'off';
      const said = `Changed ${DESIGN} decisions; README.md stays as it is.`;
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off', said, { [DESIGN]: changed[DESIGN] })));
      const proposal = await ask();
      // README.md is read-only here, so it is no change the proposal claims: the words stay (the count still says extra=1).
      expect(await stored(proposal.id)).toBe(said);
      expect(lines()).toEqual(['agentic_summary_paths names=2 held=1 extra=1 unnamed=0']);
    });

    it.each([
      ['names only held files', `Changed ${DESIGN} decisions and \`${SCREENS}\` screen empty state. Check the decision wording before accepting.`, 'agentic_summary_paths names=2 held=2 extra=0 unnamed=0'],
      ['names no path', 'Changed the decisions and the screen empty state. Check the decision wording before accepting.', 'agentic_summary_paths names=0 held=2 extra=0 unnamed=2'],
    ])('a summary that %s is stored unchanged, and its line says extra=0 with the held files it leaves out', async (_label, said, line) => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off', said)));
      const proposal = await ask();
      expect((proposal as any).summary).toBe(said);
      expect(await stored(proposal.id)).toBe(said);
      expect(lines()).toEqual([line]);
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation('off', said)));
      const turn = await say();
      expect((turn.response as any).proposal.summary).toBe(said);
      expect(lines()).toEqual([line, line]);
    });

    /*
     * The under-claim: a merged Design summary, "Changes only
     * shared/contract/api.json: ...", on a proposal that also held design/design.json. The
     * summary names a held file and leaves the other out, so its words are kept and the
     * same one sentence follows; the line ends unnamed=1.
     */
    const ST5_MERGED = 'Changes only shared/contract/api.json: adds the Book entity, four endpoint records, and the error catalogue. Check the endpoint fields, refusal statuses and codes before accepting it.';
    const merged = { [DESIGN]: changed[DESIGN], [API]: '{"operations":["list","lend","return","get"]}\n' };
    const UNDER = `${ST5_MERGED} Files in this proposal: design/design.json, shared/contract/api.json.`;

    it.each(['off', 'on'] as const)('with the edit list %s, a propose-door summary that names the contract and leaves design.json out keeps its words and gains one sentence', async (mode) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation(mode, ST5_MERGED, merged)));
      const proposal = await ask();
      expect(Object.keys(proposal.files)).toEqual([DESIGN, API]);
      expect((proposal as any).summary).toBe(UNDER);
      expect(await stored(proposal.id)).toBe(UNDER);
      expect((await service.proposal('agent-test-owner', phaseId, proposal.id) as any).summary).toBe(UNDER);
      expect((await service.list('agent-test-owner', phaseId)).map(item => (item as any).summary)).toEqual([UNDER]);
      expect(lines()).toEqual(['agentic_summary_paths names=1 held=2 extra=0 unnamed=1']);
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(2);
    });

    it.each(['off', 'on'] as const)('with the edit list %s, a chat proposal\'s summary that leaves a held file out gets the same sentence on its turn and its row', async (mode) => {
      config.agenticEditList = mode;
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation(mode, ST5_MERGED, merged)));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const proposal = (turn.response as any).proposal;
      expect(Object.keys(proposal.files)).toEqual([DESIGN, API]);
      expect(proposal.summary).toBe(UNDER);
      expect(await stored(proposal.id)).toBe(UNDER);
      expect(lines()).toEqual(['agentic_summary_paths names=1 held=2 extra=0 unnamed=1']);
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(2);
    });

    it('a summary naming both held files of the merged proposal is stored as it is, on both doors, its line unnamed=0', async () => {
      config.agenticEditList = 'off';
      const said = `Changes ${API} with the Book entity and ${DESIGN} with decision D1. Check the endpoint fields before accepting it.`;
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off', said, merged)));
      expect(await stored((await ask()).id)).toBe(said);
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation('off', said, merged)));
      expect(((await say()).response as any).proposal.summary).toBe(said);
      expect(lines()).toEqual(['agentic_summary_paths names=2 held=2 extra=0 unnamed=0', 'agentic_summary_paths names=2 held=2 extra=0 unnamed=0']);
    });

    it('a missing summary stays null and writes no line; an inadequate prompt checks nothing', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond(generation('off')));
      expect(await stored((await ask()).id)).toBeNull();
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation('off')));
      expect(((await say()).response as any).proposal.summary).toBeNull();
      provider.structured.mockResolvedValueOnce(respond(bad));
      expect(await stored((await ask()).id)).toBeNull();
      expect(lines()).toEqual([]);
    });

    it('the stored sentence reaches no later request: the next chat turn and the explanation assessment send neither the summary nor the sentence', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(generation('off', TT5)));
      const turn = await say();
      const proposal = (turn.response as any).proposal;
      expect(proposal.summary).toBe(FILES_NAMED);
      provider.structured.mockResolvedValueOnce(respond({ kind: 'discussion', reply: 'The proposal holds two documents.', questions: [] }));
      const next = await say('Which documents does it hold?', { parentTurnId: turn.id, proposalId: proposal.id, proposalHash: proposal.proposalHash });
      expect([next.status, next.errorCode]).toEqual(['completed', null]);
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explain('agent-test-owner', phaseId, proposal.id, proposal.proposalHash, explanation);
      expect(provider.structured).toHaveBeenCalledTimes(4);
      for (const [system, data] of provider.structured.mock.calls) {
        expect(`${String(system)}${JSON.stringify(data)}`).not.toContain('Files in this proposal');
        expect(`${String(system)}${JSON.stringify(data)}`).not.toContain("The mentor's answer also named");
        expect(JSON.stringify(data)).not.toContain('screen empty state');
      }
    });
  });

  describe('the generation payload trim flag', () => {
    const proposalReply = { kind: 'proposal', reply: 'Understood: one bounded change.', questions: [] };
    const held = { payload: config.agenticPayload, editList: config.agenticEditList };
    const helpers = { path: 'helpers.py', content: 'def due_today(due, today):\n    return due == today\n', editable: false };
    const tasks = 'from helpers import due_today\n\ndef overdue(due, today):\n    return due <= today\n';
    const note = 'Original note';
    const target = 'from helpers import due_today\n\ndef overdue(due, today):\n    return due < today\n';
    const named = 'In tasks.py make the overdue comparison strict; keep completed-task exclusion.';
    const unnamed = 'Make the overdue comparison strict; keep completed-task exclusion.';
    const say = (message: string, id = phaseId) => service.chat('agent-test-owner', id, { requestId: randomUUID(), message });
    const workspaceOf = async (id = phaseId) => (await db.getRepository(PhaseStateEntity).findOneByOrFail({ id })).workspace;

    beforeEach(async () => {
      phase.files = [{ path: 'tasks.py', content: '# TODO', editable: true }, { path: 'note.md', content: note, editable: true }, helpers];
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'tasks.py': tasks, 'note.md': note } });
    });
    afterEach(() => {
      config.agenticPayload = held.payload;
      config.agenticEditList = held.editList;
    });

    it('ships full, and full sends the untrimmed generation request at both sites', async () => {
      expect(config.agenticPayload).toBe('full');
      config.agenticPayload = 'full';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      expect((await say(named)).status).toBe('completed');
      const [system, data] = provider.structured.mock.calls[1];
      expect(system).toBe(composeAgentChatGeneration(phase, 'files'));
      expect(Object.keys(data)).toEqual(['originalAndContinuedRequest', 'precedingConversation', 'savedWorkspace', 'proposedWorkspace']);
      expect(data.savedWorkspace).toEqual({ 'tasks.py': tasks, 'note.md': note });
      expect(data.proposedWorkspace).toEqual(data.savedWorkspace);
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      await service.propose('agent-test-owner', phaseId, named);
      const [psystem, pdata] = provider.structured.mock.calls[1];
      expect(psystem).toBe(composeAgenticProposeGeneration(phase, 'files'));
      expect(JSON.stringify(pdata)).toBe(JSON.stringify({ prompt: named, workspace: { 'tasks.py': tasks, 'note.md': note } }));
    });

    it('trim sends no file twice, the named file with its imports, read-only only under readOnlyContext, and one added sentence', async () => {
      config.agenticPayload = 'trim';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      expect((await say(named)).status).toBe('completed');
      const [system, data, tokens, , schema, call] = provider.structured.mock.calls[1];
      expect(system).toBe(`${composeAgentChatGeneration(phase, 'files')} ${TRIM_SAVED_SENTENCE} ${TRIM_NAMED_SENTENCE('proposedWorkspace')} ${TRIM_READ_ONLY_SENTENCE}`);
      expect(data.savedWorkspace).toEqual({});
      expect(data.proposedWorkspace).toEqual({ 'tasks.py': tasks });
      expect(data.otherEditablePaths).toEqual(['note.md']);
      expect(data.readOnlyContext).toEqual({ 'helpers.py': helpers.content });
      expect([tokens, schema, call]).toEqual([9000, undefined, 'agentic.generate']);
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      await service.propose('agent-test-owner', phaseId, named);
      const [psystem, pdata] = provider.structured.mock.calls[1];
      expect(psystem).toBe(`${composeAgenticProposeGeneration(phase, 'files')} ${TRIM_NAMED_SENTENCE('workspace')} ${TRIM_READ_ONLY_SENTENCE}`);
      expect(pdata).toEqual({ prompt: named, workspace: { 'tasks.py': tasks }, otherEditablePaths: ['note.md'], readOnlyContext: { 'helpers.py': helpers.content } });
      // A request that names no file: the propose request is the full payload's, byte for byte.
      provider.structured.mockClear();
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      await service.propose('agent-test-owner', phaseId, unnamed);
      expect(provider.structured.mock.calls[1][0]).toBe(composeAgenticProposeGeneration(phase, 'files'));
      expect(JSON.stringify(provider.structured.mock.calls[1][1])).toBe(JSON.stringify({ prompt: unnamed, workspace: { 'tasks.py': tasks, 'note.md': note } }));
    });

    it('classify, explanation and apply requests are byte-identical in trim mode', async () => {
      const other = await db.getRepository(PhaseStateEntity).save({ userId: 'agent-test-owner', enrollmentId: 'agent-test-enrollment-2', phaseKey: 'implementation', phaseOrder: 3, status: 'in_progress', workspace: { 'tasks.py': tasks, 'note.md': note } });
      const stamp = (value: unknown) => String(JSON.stringify(value)).replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '<time>');
      const flow = async (id: string) => {
        provider.structured.mockClear();
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } })).mockResolvedValueOnce(respond(understanding()));
        const proposal = await service.propose('agent-test-owner', id, named);
        await service.explain('agent-test-owner', id, proposal.id, proposal.proposalHash, explanation);
        const applied = await service.apply('agent-test-owner', id, proposal.id, proposal.proposalHash);
        provider.structured.mockResolvedValueOnce(respond(proposalReply));
        provider.structured.mockResolvedValueOnce(respond({ files: { 'note.md': 'Changed note' } }));
        await say(named, id);
        const calls = provider.structured.mock.calls.map(([system, data, tokens, , schema, label]) => ({ system, data: stamp(data), tokens, schema: stamp(schema), label }));
        return { calls, workspace: await workspaceOf(id), applied: Boolean(applied.proposal.appliedAt) };
      };
      config.agenticPayload = 'full';
      const full = await flow(phaseId);
      config.agenticPayload = 'trim';
      const trim = await flow(other.id);
      expect(full.calls.map(call => call.label)).toEqual(['agentic.classify', 'agentic.generate', 'agentic.explanation', 'agentic.classify', 'agentic.generate']);
      for (const index of [0, 2, 3]) expect(trim.calls[index]).toEqual(full.calls[index]);
      expect(trim.calls[1]).not.toEqual(full.calls[1]);
      expect(trim.calls[4]).not.toEqual(full.calls[4]);
      expect([trim.workspace, trim.applied]).toEqual([full.workspace, true]);
    });

    it('validateFiles still checks against every editable path', async () => {
      config.agenticPayload = 'trim';
      // An editable file the trimmed payload named but did not show is still a valid answer.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'note.md': 'Changed note' } }));
      const accepted = await say(named);
      expect(accepted.status).toBe('completed');
      expect(accepted.response?.proposal?.files).toEqual({ 'note.md': 'Changed note' });
      // A read-only file the payload showed under readOnlyContext is refused by the read-only rule, with its reason.
      const before = await db.getRepository(AgentProposalEntity).count();
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'helpers.py': 'changed' } })).mockResolvedValueOnce(respond({ files: { 'helpers.py': 'changed' } }));
      const refused = await say(named);
      expect([refused.status, refused.errorCode, refused.errorMessage]).toEqual(['failed', 'files_proposal_refused', `${FILES_PROPOSAL_REFUSED} The proposal contains invalid or non-editable files.`]);
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'helpers.py': 'changed' } })).mockResolvedValueOnce(respond({ files: { 'helpers.py': 'changed' } }));
      await expect(service.propose('agent-test-owner', phaseId, named)).rejects.toThrow(`${FILES_PROPOSAL_REFUSED} The proposal contains invalid or non-editable files.`);
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(before);
      expect(await workspaceOf()).toEqual({ 'tasks.py': tasks, 'note.md': note });
    });

    it('the edit-list mode in trim: the edits expand against the full workspace and its output passes the same validateFiles rule', async () => {
      config.agenticPayload = 'trim';
      config.agenticEditList = 'strict';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'tasks.py', oldString: 'due <= today', newString: 'due < today' }] }));
      const turn = await say(named);
      expect(turn.status).toBe('completed');
      expect(turn.response?.proposal?.files).toEqual({ "tasks.py": target });
      const [system, data, , , schema, call] = provider.structured.mock.calls[1];
      expect(call).toBe('agentic.generate.edits');
      expect(system).toBe(`${composeAgentChatGeneration(phase, 'edits')} ${TRIM_SAVED_SENTENCE} ${TRIM_NAMED_SENTENCE('proposedWorkspace')} ${TRIM_READ_ONLY_SENTENCE}`);
      expect(data.readOnlyContext).toEqual({ 'helpers.py': helpers.content });
      // The schema still lists every editable path and no read-only one.
      expect(JSON.stringify(schema)).toContain('note.md');
      expect(JSON.stringify(schema)).not.toContain('helpers.py');
      // A whole file for the read-only path is refused before anything is proposed.
      const before = await db.getRepository(AgentProposalEntity).count();
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [{ path: 'helpers.py', contents: 'changed' }], edits: [] }));
      expect((await say(named)).status).toBe('failed');
      expect(await db.getRepository(AgentProposalEntity).count()).toBe(before);
    });

    it('refuses to boot with an invalid AI_AGENTIC_PAYLOAD, and boots when it is unset', () => {
      const heldEnv = process.env.AI_AGENTIC_PAYLOAD;
      const build = () => new AgenticService(db.getRepository(AgentProposalEntity), {} as any, {} as any, provider as any, db, db.getRepository(ExecutionRunEntity), {} as any);
      try {
        process.env.AI_AGENTIC_PAYLOAD = 'yes';
        expect(build).toThrow('AI_AGENTIC_PAYLOAD must be full or trim');
        delete process.env.AI_AGENTIC_PAYLOAD;
        expect(build).not.toThrow();
      } finally {
        if (heldEnv === undefined) delete process.env.AI_AGENTIC_PAYLOAD;
        else process.env.AI_AGENTIC_PAYLOAD = heldEnv;
      }
    });
  });

  it('a story phase: briefs generation without teacher or learner text, measures changes, and refuses an invalid record at edit and apply', async () => {
    const SENTINEL = 'INJECT-SENTINEL-9f3';
    const saved = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', persona: 'a team lead', capability: 'see overdue tasks', benefit: 'see what slipped', notes: SENTINEL });
    const next = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', persona: 'a team lead', capability: 'see overdue tasks', benefit: 'chase it first', notes: SENTINEL,
      criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the list', then: 'it shows as overdue', tag: 'happy' }] });
    const original = { files: phase.files, checks: phase.checks };
    phase.files = [{ path: STORY_JSON, content: serialiseStory(EMPTY_STORY), editable: true }];
    phase.checks = { kind: 'story', record: STORY_JSON, floor: DEFAULT_STORY_FLOOR,
      providedStories: [{ id: 'US-1', title: `Provided ${SENTINEL}`, persona: 'a member', capability: 'add a task', benefit: 'track it' }],
      learnerStory: { id: 'US-4', hints: { persona: `Hint ${SENTINEL}` } } };
    try {
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace: { [STORY_JSON]: saved }, workspaceUpdatedAt: '2026-10-14T00:00:00.000Z' });
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [STORY_JSON]: next } }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Sharpen the benefit and add a happy-path criterion for a task due yesterday.');

      // The generation prompt carries the fixed briefing and the floor sentence, and none of the
      // teacher's or learner's text: that reaches the model only in the data payload.
      const system = provider.structured.mock.calls[1][0] as string;
      expect(system).toContain('numbered AC-1, AC-2, … in order, each tag one of happy, boundary or error');
      // The room labels notes "Open questions", so the model is told that is all it holds.
      expect(system).toContain('benefit (So that) and notes (only open questions still to settle with the customer, empty when there are none, never the story sentence); criteria,');
      expect(system).toContain(`The teacher's floor asks for ${floorSentence(DEFAULT_STORY_FLOOR)}.`);
      expect(system).toContain(`Return the complete story record as the new content of \`${STORY_JSON}\`; keep the story id; never change the learner's wording unless the request asks.`);
      expect(system).not.toContain(SENTINEL);
      // A record without epics or a parent epic is briefed without the carried-fields sentence.
      expect(system).not.toContain('parentEpicId');
      expect(JSON.stringify(provider.structured.mock.calls[1][1])).toContain(SENTINEL);

      // The read-back view measures the record against the saved one: one changed field, one added criterion.
      expect((await service.proposal('agent-test-owner', phaseId, proposed.id)).changes).toEqual([
        { path: 'story/so-that', before: 'see what slipped', after: 'chase it first' },
        { path: 'story/ac-1/given', after: 'a task due yesterday' },
        { path: 'story/ac-1/when', after: 'I open the list' },
        { path: 'story/ac-1/then', after: 'it shows as overdue' },
        { path: 'story/ac-1/tag', after: 'happy' },
      ]);

      await expect(service.edit('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, { [STORY_JSON]: next.replace('"US-4"', '"US-9"') }))
        .rejects.toThrow(STORY_PROPOSAL_REFUSED);

      provider.structured.mockResolvedValueOnce(respond(understanding()));
      const approved = await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation);
      expect(approved.approvedAt).toBeTruthy();
      // The story kind's explanation evidence is the change set, as the design kind's is: no whole files.
      const [explainSystem, explainData] = provider.structured.mock.calls.at(-1)!;
      expect(explainSystem).toContain(` ${EXPLANATION_ASSESSMENT_PROMPT} ${STRUCTURED_EVIDENCE_RULE}`);
      expect(Object.keys((explainData as { reference: object }).reference)).toEqual(['originalRequest', 'changes', 'carried', 'proposalHash', 'latestEdit']);
      // A stored record that is no longer a valid story is refused at Apply, and nothing is written.
      await db.getRepository(AgentProposalEntity).update({ id: proposed.id }, { files: { [STORY_JSON]: '{"id":"US-4"' } });
      const before = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId });
      await expect(service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash)).rejects.toThrow(STORY_PROPOSAL_REFUSED);
      const after = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId });
      expect(after.workspace).toEqual({ [STORY_JSON]: saved });
      expect(after.workspaceUpdatedAt).toBe(before.workspaceUpdatedAt);
      expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposed.id })).appliedAt).toBeNull();
    } finally {
      phase.files = original.files;
      phase.checks = original.checks;
    }
  });
  it('a runbook proposal that also changes a file: the explanation carries the mixed rule in place of the structured one', async () => {
    const deployment = new ContentService().loadProject(recordPack()).phases.find((p) => p.key === 'deployment')!;
    const saved = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'p', kind: 'config' }] });
    const next = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }] });
    const original = { key: phase.key, files: phase.files, checks: phase.checks };
    phase.key = 'deployment';
    phase.files = [{ path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK), editable: true }, { path: 'docker-compose.yml', content: 'services: {}\n', editable: true }];
    // no drill, so no incident is carried and the record half is the environment entry alone
    phase.checks = { ...deployment.checks, drill: undefined };
    try {
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace: { [RUNBOOK_JSON]: saved, 'docker-compose.yml': 'services: {}\n' }, workspaceUpdatedAt: '2026-10-15T00:00:00.000Z' });
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [RUNBOOK_JSON]: next, 'docker-compose.yml': 'services:\n  api: {}\n' } }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Say what API_URL controls and add the api service to compose.');
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation);
      const [explainSystem, explainData] = provider.structured.mock.calls.at(-1)!;
      expect(explainSystem).toContain(` ${EXPLANATION_ASSESSMENT_PROMPT} ${STRUCTURED_MIXED_EVIDENCE_RULE}`);
      expect(explainSystem).not.toContain('There is no reference.before');
      expect(Object.keys((explainData as { reference: object }).reference)).toEqual(['originalRequest', 'changes', 'carried', 'before', 'proposedFiles', 'proposalHash', 'latestEdit']);
    } finally {
      phase.key = original.key;
      phase.files = original.files;
      phase.checks = original.checks;
    }
  });
  it('a chat whose generated story is refused fails the turn with the fixed sentence, not the generic one', async () => {
    const original = { files: phase.files, checks: phase.checks };
    phase.files = [{ path: STORY_JSON, content: serialiseStory(EMPTY_STORY), editable: true }];
    phase.checks = { kind: 'story', record: STORY_JSON, floor: DEFAULT_STORY_FLOOR, providedStories: [], learnerStory: { id: 'US-4', hints: {} } };
    try {
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace: { [STORY_JSON]: serialiseStory(EMPTY_STORY) }, workspaceUpdatedAt: '2026-10-14T00:00:00.000Z' });
      provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'I will write the story.', questions: [] }))
        .mockResolvedValueOnce(respond({ files: { [STORY_JSON]: 'not a story' } })).mockResolvedValueOnce(respond({ files: { [STORY_JSON]: 'not a story' } }));
      const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Write the story.' });
      expect([turn.status, turn.errorCode]).toEqual(['failed', 'story_proposal_refused']);
      // The validator's reason after the fixed sentence
      expect(turn.errorMessage).toBe(`${STORY_PROPOSAL_REFUSED} The story record is not valid: The story record is not valid JSON.`);
    } finally {
      phase.files = original.files;
      phase.checks = original.checks;
    }
  });
  it('a generated story is stored without the sentence\'s own words in its parts, by propose and by chat, so the Compare reads "a team member"', async () => {
    const original = { files: phase.files, checks: phase.checks };
    const scaffold = serialiseStory({ ...EMPTY_STORY, id: 'US-4' });
    const run6 = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue task badge', persona: 'As a team member',
      capability: 'I want tasks due before today to show an overdue badge', benefit: 'so that I can quickly identify overdue tasks',
      criteria: [{ id: 'AC-1', given: 'a task is due yesterday', when: 'the task is displayed', then: 'the task shows the overdue badge', tag: 'happy' },
        { id: 'AC-2', given: 'a task is due today', when: 'the task is displayed', then: 'the task does not show the overdue badge', tag: 'boundary' }],
      scopeExclusions: ['Reminders and notifications are out of scope.'] });
    const parts = (changes: { path: string }[]) => changes.filter((change) => ['story/as-a', 'story/i-want', 'story/so-that'].includes(change.path));
    const cleaned = [
      { path: 'story/as-a', after: 'a team member' },
      { path: 'story/i-want', after: 'tasks due before today to show an overdue badge' },
      { path: 'story/so-that', after: 'I can quickly identify overdue tasks' },
    ];
    phase.files = [{ path: STORY_JSON, content: scaffold, editable: true }];
    phase.checks = { kind: 'story', record: STORY_JSON, floor: DEFAULT_STORY_FLOOR, providedStories: [], learnerStory: { id: 'US-4', hints: {} } };
    try {
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace: { [STORY_JSON]: scaffold }, workspaceUpdatedAt: '2026-10-14T00:00:00.000Z' });
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [STORY_JSON]: run6 } }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Write the overdue badge story with a happy path and a due-today boundary.');
      expect(parts(proposed.changes ?? [])).toEqual(cleaned);
      const stored = validateStoryRecord((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposed.id })).files[STORY_JSON]).story!;
      expect([stored.persona, stored.capability, stored.benefit]).toEqual(['a team member', 'tasks due before today to show an overdue badge', 'I can quickly identify overdue tasks']);

      provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'I will write the story.', questions: [] }))
        .mockResolvedValueOnce(respond({ files: { [STORY_JSON]: run6 } }));
      const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Write the overdue badge story with a happy path and a due-today boundary.' });
      expect(turn.status).toBe('completed');
      expect(parts(turn.response!.proposal!.changes ?? [])).toEqual(cleaned);
    } finally {
      phase.files = original.files;
      phase.checks = original.checks;
    }
  });
  it('a story proposal never changes the id, the epics or the parent epic: a dropped epic is refused, and apply keeps them as saved', async () => {
    const epics = [{ id: 'EP-1', title: 'Overdue work', outcome: 'Leads see slipped work' }];
    const saved = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', persona: 'a team lead', capability: 'see overdue tasks', benefit: 'see what slipped', epics, parentEpicId: 'EP-1' });
    const kept = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', persona: 'a team lead', capability: 'see overdue tasks', benefit: 'chase it first', epics, parentEpicId: 'EP-1' });
    const dropped = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', persona: 'a team lead', capability: 'see overdue tasks', benefit: 'chase it first' });
    const original = { files: phase.files, checks: phase.checks };
    phase.files = [{ path: STORY_JSON, content: serialiseStory(EMPTY_STORY), editable: true }];
    phase.checks = { kind: 'story', record: STORY_JSON, floor: DEFAULT_STORY_FLOOR, providedStories: [], learnerStory: { id: 'US-4', hints: {} } };
    try {
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace: { [STORY_JSON]: saved }, workspaceUpdatedAt: '2026-10-14T00:00:00.000Z' });
      const rows = await db.getRepository(AgentProposalEntity).countBy({ phaseStateId: phaseId });
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [STORY_JSON]: dropped } }));
      expect(await refusedAtDoor(() => service.propose('agent-test-owner', phaseId, 'Sharpen the benefit.'), `${STORY_PROPOSAL_REFUSED} The proposal changes the story id, its epics or its parent epic, which a proposal keeps as saved.`))
        .toEqual(['agentic_proposal_refused kind=propose code=story_proposal_refused clause=carried_changed']);
      expect(await db.getRepository(AgentProposalEntity).countBy({ phaseStateId: phaseId })).toBe(rows);
      // The saved record holds epics, so the generation call is told to keep them.
      expect(provider.structured.mock.calls.at(-1)![0]).toContain('return both exactly as they are saved; a proposal never changes the story id, the epics or the parent epic.');

      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [STORY_JSON]: kept } }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Sharpen the benefit.');
      // The change set names the one changed field; the carried fields are listed apart, never as changes.
      expect(proposed.changes).toEqual([{ path: 'story/so-that', before: 'see what slipped', after: 'chase it first' }]);
      expect(proposed.carried).toEqual(['id', 'epics', 'parentEpicId']);

      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation);
      await service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash);
      const written = JSON.parse((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace![STORY_JSON]);
      expect(written).toMatchObject({ id: 'US-4', epics, parentEpicId: 'EP-1', benefit: 'chase it first' });
    } finally {
      phase.files = original.files;
      phase.checks = original.checks;
    }
  });

  describe('a design phase', () => {
    const SENTINEL = 'INJECT-SENTINEL-d51';
    const stories = [{ id: 'US-4', title: `Overdue ${SENTINEL}`, line: 'see what slipped' }];
    const designChecks = { kind: 'design', record: DESIGN_JSON, contracts: { api: true, screens: false }, sequence: false, stories, floor: DEFAULT_DESIGN_FLOOR };
    const saved: Design = {
      entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: ['US-4'] }, { id: 'E2', name: 'List', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }],
      relations: [{ id: 'R1', from: 'E2', to: 'E1', kind: 'composition' }],
      operations: [{ id: 'O1', name: 'getOverdue', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: ['US-4'] }],
      decisions: [{ id: 'D1', title: 'Clock', choice: 'a parameter', alternative: 'the server clock', rationale: 'replayable', tradeOff: 'callers send it', status: 'accepted', satisfies: [], decidedAt: '2026-10-14T00:00:00Z' }],
      sequence: 'Browser -> Api: getOverdue',
    };
    const api = '{ "operations": [], "errors": {} }';
    const workspace = { [DESIGN_JSON]: serialiseDesign(saved), [API_CONTRACT_JSON]: api };
    // The model renames E1, reopens D1, rewrites the switched-off sequence and adds a note: only the note is a proposal.
    const generatedRecord = serialiseDesign({
      ...saved, entities: [{ ...saved.entities[0], id: 'E7' }, saved.entities[1]], relations: [{ ...saved.relations[0], to: 'E7' }],
      decisions: [{ ...saved.decisions[0], status: 'proposed', decidedAt: undefined }], sequence: 'Browser -> Api: somethingElse', notes: 'Overdue excludes today.',
    });
    const expected = serialiseDesign({ ...saved, notes: 'Overdue excludes today.' });
    const DESIGN_SUMMARY = 'Changes the design notes. Check the note against the overdue story.';
    let original: { files: unknown; checks: unknown };
    beforeEach(async () => {
      original = { files: phase.files, checks: phase.checks };
      phase.files = [{ path: DESIGN_JSON, content: serialiseDesign(saved), editable: true }, { path: API_CONTRACT_JSON, content: api, editable: true }];
      phase.checks = designChecks;
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace, workspaceUpdatedAt: '2026-10-14T00:00:00.000Z' });
    });
    afterEach(() => { phase.files = original.files; phase.checks = original.checks; });

    it('carries the ids, the statuses and the switched-off sequence, briefs the schema, sends the stories as data, and gates the explanation on the change set', async () => {
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: generatedRecord }, summary: DESIGN_SUMMARY }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Add a note that overdue excludes today.');
      expect(proposed.files).toEqual({ [DESIGN_JSON]: expected });
      expect((proposed as any).summary).toBe(DESIGN_SUMMARY);
      const [system, data] = provider.structured.mock.calls[1];
      expect(system).toContain(designBriefing(phase));
      expect(system).not.toContain(SENTINEL);
      expect((data as { designStories: unknown }).designStories).toEqual(stories);
      expect(proposed.changes).toEqual([{ path: 'design/notes', after: 'Overdue excludes today.' }]);
      expect(proposed.carried).toEqual(['entity E1', 'entity E2', 'operation O1', 'decision D1', 'the status of D1']);

      provider.structured.mockResolvedValueOnce(respond(understanding()));
      const approved = await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation);
      expect(approved.approvedAt).toBeTruthy();
      const [explainSystem, explainData] = provider.structured.mock.calls.at(-1)!;
      expect(explainSystem).toContain(` ${EXPLANATION_ASSESSMENT_PROMPT} ${STRUCTURED_EVIDENCE_RULE}`);
      expect((explainData as { reference: unknown }).reference).toEqual({ originalRequest: proposed.prompt, changes: proposed.changes, carried: proposed.carried, proposalHash: proposed.proposalHash, latestEdit: null });
      // The learner's summary is shown above the diff, never assessed with the explanation.
      expect((explainData as { reference: object }).reference).not.toHaveProperty('summary');
      expect(JSON.stringify(explainData)).not.toContain(DESIGN_SUMMARY);

      await service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash);
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual({ [DESIGN_JSON]: expected, [API_CONTRACT_JSON]: api });
    });

    it('a generated decision status read as proposed is counted on one log line of fixed tokens, at both doors, and a record of the schema\'s own statuses logs none', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const statusLines = () => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('design_status_read_as_proposed'));
      const unknown = serialiseDesign({ ...saved, notes: 'Overdue excludes today.', decisions: [{ ...saved.decisions[0], status: 'decided' as unknown as 'proposed' }, { ...saved.decisions[0], id: 'D2', title: 'Store', status: 'final' as unknown as 'proposed' }] });
      try {
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: unknown } }));
        const proposed = await service.propose('agent-test-owner', phaseId, 'Add a note that overdue excludes today.');
        expect(JSON.parse(proposed.files[DESIGN_JSON]).decisions.map((d: { status: string }) => d.status)).toEqual(['accepted', 'proposed']);
        expect(statusLines()).toEqual(['design_status_read_as_proposed count=2']);
        provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'I will add the note.', questions: [] }))
          .mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: unknown } }));
        const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Add a note that overdue excludes today.' });
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect(statusLines()).toEqual(['design_status_read_as_proposed count=2', 'design_status_read_as_proposed count=2']);
        // the record's own statuses: nothing read, nothing logged
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: generatedRecord } }));
        await service.propose('agent-test-owner', phaseId, 'Add a note that overdue excludes today.');
        expect(statusLines()).toHaveLength(2);
        expect(statusLines().join(' ')).not.toMatch(/decided|final|D1|D2/);
      } finally {
        log.mockRestore();
      }
    });

    it('a chat whose generated design is refused fails the turn with the fixed sentence, not the generic one, the reason after it on the turn and the row, and the clause on one log line', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'I will add the screen.', questions: [] }))
          .mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: 'not a design' } })).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: 'not a design' } }));
        const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Add a screen.' });
        const detail = 'The design record is not valid: The design record is not valid JSON.';
        expect([turn.status, turn.errorCode, turn.errorMessage]).toEqual(['failed', 'design_proposal_refused', `${DESIGN_PROPOSAL_REFUSED} ${detail}`]);
        expect((await db.getRepository(AgentTurnEntity).findOneByOrFail({ id: turn.id })).errorDetail).toBe(detail);
        // the reason rides the view inside errorMessage only, never as the raw column
        expect(turn).not.toHaveProperty('errorDetail');
        // read back from the row, the view says the same
        expect((await service.turn('agent-test-owner', phaseId, turn.requestId)).errorMessage).toBe(`${DESIGN_PROPOSAL_REFUSED} ${detail}`);
        const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('agentic_proposal_refused '));
        expect(lines).toEqual(['agentic_proposal_refused kind=chat code=design_proposal_refused clause=invalid_document']);
        expect(lines.join(' ')).not.toContain('not valid');
      } finally {
        log.mockRestore();
      }
    });

    it('a generated design whose decision satisfies is written as a text proposes the one-item list it means', async () => {
      const asText = serialiseDesign({ ...saved, notes: 'Overdue excludes today.', decisions: [{ ...saved.decisions[0], satisfies: 'US-4' as unknown as string[] }] });
      provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'I will add the note.', questions: [] }))
        .mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: asText } }));
      const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Add a note that overdue excludes today.' });
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const files = turn.response?.proposal?.files ?? {};
      expect(JSON.parse(files[DESIGN_JSON]).decisions[0].satisfies).toEqual(['US-4']);
      expect(JSON.parse(files[DESIGN_JSON]).decisions[0].status).toBe('accepted');
    });

    it('a generated design that changes nothing fails the chat turn and the propose door with its own sentence, not the refusal', async () => {
      // a renamed id is carried back, so the record normalises to the saved one and nothing is left to propose
      const asSaved = serialiseDesign({ ...saved, entities: [{ ...saved.entities[0], id: 'E7' }, saved.entities[1]], relations: [{ ...saved.relations[0], to: 'E7' }] });
      const rows = await db.getRepository(AgentProposalEntity).countBy({ phaseStateId: phaseId });
      provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'I will tidy the ids.', questions: [] }))
        .mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: asSaved } }));
      const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Tidy the ids.' });
      expect([turn.status, turn.errorCode, turn.errorMessage]).toEqual(['failed', 'design_proposal_unchanged', DESIGN_PROPOSAL_UNCHANGED]);
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: asSaved } }));
      await expect(service.propose('agent-test-owner', phaseId, 'Tidy the ids.')).rejects.toThrow(DESIGN_PROPOSAL_UNCHANGED);
      expect(await db.getRepository(AgentProposalEntity).countBy({ phaseStateId: phaseId })).toBe(rows);
    });

    it('refuses a generated switched-off contract before any row is written, and an edit that changes an id or a decision status', async () => {
      const rows = await db.getRepository(AgentProposalEntity).countBy({ phaseStateId: phaseId });
      phase.files = [...phase.files, { path: 'shared/contract/screens.json', content: '{"screens":[]}', editable: true }];
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'shared/contract/screens.json': '{"screens":[]}' } })).mockResolvedValueOnce(respond({ files: { 'shared/contract/screens.json': '{"screens":[]}' } }));
      await expect(service.propose('agent-test-owner', phaseId, 'Add a screen.')).rejects.toThrow(DESIGN_PROPOSAL_REFUSED);
      expect(await db.getRepository(AgentProposalEntity).countBy({ phaseStateId: phaseId })).toBe(rows);
      phase.files = phase.files.slice(0, 2);

      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: expected } }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Add a note that overdue excludes today.');
      // the learner's own edit is refused, as a story edit is, rather than quietly put back
      const renamed = serialiseDesign({ ...saved, entities: [{ ...saved.entities[0], id: 'E7' }, saved.entities[1]], relations: [{ ...saved.relations[0], to: 'E7' }], notes: 'Overdue excludes today.' });
      expect(await refusedAtDoor(() => service.edit('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, { [DESIGN_JSON]: renamed }), `${DESIGN_PROPOSAL_REFUSED} The edit changes an id, a decision status or the saved sequence, which a proposal keeps as saved.`))
        .toEqual(['agentic_proposal_refused kind=edit code=design_proposal_refused clause=carried_changed']);
      const reopened = serialiseDesign({ ...saved, decisions: [{ ...saved.decisions[0], status: 'proposed' }], notes: 'Overdue excludes today.' });
      await expect(service.edit('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, { [DESIGN_JSON]: reopened })).rejects.toThrow(DESIGN_PROPOSAL_REFUSED);
      expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposed.id })).files).toEqual({ [DESIGN_JSON]: expected });
      // an edit that keeps them is stored as validated, whatever its spacing
      const edited = await service.edit('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, { [DESIGN_JSON]: JSON.stringify({ ...saved, notes: 'Overdue excludes today, always.' }) });
      expect(edited.files).toEqual({ [DESIGN_JSON]: serialiseDesign({ ...saved, notes: 'Overdue excludes today, always.' }) });
    });

    it('carries the ids in a chat proposal too', async () => {
      provider.structured.mockResolvedValueOnce(respond({ kind: 'proposal', reply: 'Understood: one note.', questions: [] }))
        .mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: generatedRecord } }));
      const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Add a note that overdue excludes today.' }) as { response: { proposal: { files: unknown } } };
      expect(turn.response.proposal.files).toEqual({ [DESIGN_JSON]: expected });
      expect((provider.structured.mock.calls[1][1] as { designStories: unknown }).designStories).toEqual(stories);
    });

    it('writes every document at Apply through the workspace guard the learner\'s own save uses', async () => {
      const guard = jest.spyOn(designGuard, 'refuseInvalidDesignDocument');
      try {
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: expected, [API_CONTRACT_JSON]: '{"operations":[]}' } }));
        const proposed = await service.propose('agent-test-owner', phaseId, 'Add a note that overdue excludes today.');
        provider.structured.mockResolvedValueOnce(respond(understanding()));
        await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation);
        await service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash);
        expect(guard.mock.calls.map(([path]) => path).sort()).toEqual([DESIGN_JSON, API_CONTRACT_JSON].sort());
        expect(guard.mock.calls.every(([, , checks]) => checks === phase.checks)).toBe(true);
      } finally { guard.mockRestore(); }
    });

    it('refuses at Apply a stored proposal that changes an id, and writes nothing', async () => {
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: expected } }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Add a note that overdue excludes today.');
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation);
      await db.getRepository(AgentProposalEntity).update({ id: proposed.id }, { files: { [DESIGN_JSON]: generatedRecord } });
      expect(await refusedAtDoor(() => service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash), `${DESIGN_PROPOSAL_REFUSED} The stored proposal would change an id, a decision status or the saved sequence, which a proposal keeps as saved.`))
        .toEqual(['agentic_proposal_refused kind=apply code=design_proposal_refused clause=carried_changed']);
      expect((await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace).toEqual(workspace);
    });
  });
  describe('a runbook and a change request at Apply', () => {
    const pack = new ContentService().loadProject(recordPack());
    const deployment = pack.phases.find((p) => p.key === 'deployment')!;
    const maintenance = pack.phases.find((p) => p.key === 'maintenance')!;
    const savedRunbook: Runbook = { ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'p', kind: 'config' }], incident: { rootCause: 'API_URL pointed at localhost', fix: 'f', actionItem: 'a' } };
    const nextRunbook: Runbook = { ...savedRunbook, environment: [{ ...savedRunbook.environment[0], purpose: 'Where web sends /api.' }] };
    const compose = { before: 'services: {}\n', after: 'services:\n  api: {}\n' };
    const savedChange: ChangeRequest = { ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 'comments', covers: ['AC-1'], result: 'not-run' }] };
    const nextChange: ChangeRequest = { ...savedChange, tests: [{ ...savedChange.tests[0], result: 'pass' }] };
    let original: { key: unknown; files: unknown; checks: unknown };
    beforeEach(() => { original = { key: phase.key, files: phase.files, checks: phase.checks }; });
    afterEach(() => { phase.key = original.key; phase.files = original.files; phase.checks = original.checks; });

    /** Deployment with its drill, the runbook and compose saved. */
    const onDeployment = async () => {
      phase.key = 'deployment';
      phase.files = [{ path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK), editable: true }, { path: 'docker-compose.yml', content: compose.before, editable: true }];
      phase.checks = deployment.checks;
      const workspace: Record<string, string> = { [RUNBOOK_JSON]: serialiseRunbook(savedRunbook), 'docker-compose.yml': compose.before };
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace, workspaceUpdatedAt: '2026-10-15T00:00:00.000Z' });
      return workspace;
    };
    /** Maintenance with the contract switch as given, the change request and a code file saved. */
    const onMaintenance = async (contract: boolean) => {
      phase.key = 'maintenance';
      phase.files = [{ path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(EMPTY_CHANGE_REQUEST), editable: true }, { path: 'api/main.py', content: '# api\n', editable: true }];
      const checks = maintenance.checks as { change: object };
      phase.checks = { ...checks, change: { ...checks.change, contract } };
      const workspace = { [CHANGE_REQUEST_JSON]: serialiseChangeRequest(savedChange), 'api/main.py': '# api\n' };
      await db.getRepository(PhaseStateEntity).update({ id: phaseId }, { workspace, workspaceUpdatedAt: '2026-10-15T00:00:00.000Z' });
      return workspace;
    };
    it('asks for the runbook and the change request whole in files under the edit-list contract, and reads that answer', async () => {
      const held = config.agenticEditList;
      try {
        config.agenticEditList = 'strict';
        await onDeployment();
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: [{ path: RUNBOOK_JSON, contents: serialiseRunbook(nextRunbook) }], edits: [] }));
        const runbook = await service.propose('agent-test-owner', phaseId, 'Say what API_URL controls.');
        expect(runbook.files[RUNBOOK_JSON]).toBe(serialiseRunbook(nextRunbook));
        expect(provider.structured.mock.calls[1][0]).toContain(`Under the edit-list contract the runbook record \`${RUNBOOK_JSON}\` is one files entry holding the complete record, never edits`);
        await onMaintenance(true);
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: [{ path: CHANGE_REQUEST_JSON, contents: serialiseChangeRequest(nextChange) }], edits: [] }));
        await service.propose('agent-test-owner', phaseId, 'Record the test result.');
        expect(provider.structured.mock.calls[3][0]).toContain(`Under the edit-list contract the change request record \`${CHANGE_REQUEST_JSON}\` is one files entry holding the complete record, never edits`);
        // The whole-file contract's request is unchanged.
        config.agenticEditList = 'off';
        await onDeployment();
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { [RUNBOOK_JSON]: serialiseRunbook(nextRunbook) } }));
        await service.propose('agent-test-owner', phaseId, 'Say what API_URL controls.');
        expect(provider.structured.mock.calls[5][0]).not.toMatch(/edit-list contract/);
      } finally { config.agenticEditList = held; }
    });

    /** A generated proposal whose explanation was accepted, ready for Apply. */
    const approved = async (files: Record<string, string>) => {
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files }));
      const proposed = await service.propose('agent-test-owner', phaseId, 'Say what API_URL controls and record the test result.');
      provider.structured.mockResolvedValueOnce(respond(understanding()));
      expect((await service.explain('agent-test-owner', phaseId, proposed.id, proposed.proposalHash, explanation)).approvedAt).toBeTruthy();
      return proposed;
    };
    /** Apply refused with `sentence`, and nothing written: the workspace, its stamp and the proposal's appliedAt as they were. */
    const refusedAtApply = async (proposed: { id: string; proposalHash: string }, workspace: Record<string, string>, sentence: string) => {
      await expect(service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash)).rejects.toThrow(sentence);
      const state = await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId });
      expect(state.workspace).toEqual(workspace);
      expect(state.workspaceUpdatedAt).toBe('2026-10-15T00:00:00.000Z');
      expect((await db.getRepository(AgentProposalEntity).findOneByOrFail({ id: proposed.id })).appliedAt).toBeNull();
    };

    it('refuses at Apply a stored runbook proposal that changes the drill\'s incident, and writes nothing', async () => {
      const workspace = await onDeployment();
      const proposed = await approved({ [RUNBOOK_JSON]: serialiseRunbook(nextRunbook) });
      await db.getRepository(AgentProposalEntity).update({ id: proposed.id }, { files: { [RUNBOOK_JSON]: serialiseRunbook({ ...nextRunbook, incident: { rootCause: 'rewritten', fix: 'f', actionItem: 'a' } }) } });
      await refusedAtApply(proposed, workspace, RUNBOOK_PROPOSAL_REFUSED);
    });

    it('refuses at Apply a stored change request proposal that changes an id, and writes nothing', async () => {
      const workspace = await onMaintenance(true);
      const proposed = await approved({ [CHANGE_REQUEST_JSON]: serialiseChangeRequest(nextChange) });
      await db.getRepository(AgentProposalEntity).update({ id: proposed.id }, { files: { [CHANGE_REQUEST_JSON]: serialiseChangeRequest({ ...nextChange, tests: [{ ...nextChange.tests[0], id: 'T9' }] }) } });
      await refusedAtApply(proposed, workspace, CHANGE_PROPOSAL_REFUSED);
    });

    it('refuses at Apply a stored change request proposal that touches a switched-off contract, and writes nothing', async () => {
      const workspace = await onMaintenance(false);
      const proposed = await approved({ [CHANGE_REQUEST_JSON]: serialiseChangeRequest(nextChange) });
      const amended = serialiseChangeRequest({ ...nextChange, contract: [{ id: 'C1', method: 'GET', path: '/tasks/{id}/comments', change: 'added', why: 'list them' }] });
      await db.getRepository(AgentProposalEntity).update({ id: proposed.id }, { files: { [CHANGE_REQUEST_JSON]: amended } });
      await refusedAtApply(proposed, workspace, CHANGE_PROPOSAL_REFUSED);
    });

    it('writes a runbook proposal at Apply through the workspace guard the learner\'s own save uses: canonical bytes, the saved incident', async () => {
      const workspace = await onDeployment();
      const guard = jest.spyOn(recordGuard, 'refuseInvalidRecord');
      try {
        const proposed = await approved({ [RUNBOOK_JSON]: JSON.stringify(nextRunbook, null, 2), 'docker-compose.yml': compose.after });
        await service.apply('agent-test-owner', phaseId, proposed.id, proposed.proposalHash);
        expect(guard.mock.calls.map(([path]) => path).sort()).toEqual([RUNBOOK_JSON, 'docker-compose.yml'].sort());
        // each document is guarded against the stored one, the same checks the learner's own save reads
        expect(guard.mock.calls.every(([path, , checks, stored]) => checks === phase.checks && stored === workspace[path])).toBe(true);
        const written = (await db.getRepository(PhaseStateEntity).findOneByOrFail({ id: phaseId })).workspace!;
        expect(written).toEqual({ [RUNBOOK_JSON]: serialiseRunbook(nextRunbook), 'docker-compose.yml': compose.after });
        expect(validateRunbookRecord(written[RUNBOOK_JSON]).runbook!.incident).toEqual(savedRunbook.incident);
      } finally { guard.mockRestore(); }
    });
  });

  /*
   * A generated answer may hold fewer documents than were asked for, either because the model wrote no entry for a
   * file or because it wrote one that changed nothing, which the route's checks then leave out. So that the log can
   * tell the two apart, each answer the checks keep writes one line of fixed tokens counting the entries left out as
   * equal to the saved files, and the
   * edit-list line counts the distinct paths the answer's entries named. Never a path, never model or learner text.
   */
  describe('the paths a generated answer held that were dropped as unchanged', () => {
    const heldMode = config.agenticEditList;
    const saved = { 'tasks.py': 'def overdue(due, today):\n    return due <= today\n', 'note.md': 'SENTINEL note\n' };
    const target = 'def overdue(due, today):\n    return due < today\n';
    const proposalReply = { kind: 'proposal', reply: 'Understood: one bounded change.', questions: [] };
    const strict = { path: 'tasks.py', oldString: 'due <= today', newString: 'due < today' };
    const say = () => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Make the comparison strict.' });
    let logs: jest.SpyInstance;
    const lines = (prefix: string) => logs.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(prefix));
    beforeEach(async () => {
      phase.files = [{ path: 'tasks.py', content: '# TODO', editable: true }, { path: 'note.md', content: 'SENTINEL note\n', editable: true }];
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: saved });
      logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => { config.agenticEditList = heldMode; logs.mockRestore(); });

    it('counts an edit that changes nothing: the edit-list line names three entries over two paths, and one path is dropped', async () => {
      config.agenticEditList = 'strict';
      const noop = { path: 'note.md', oldString: 'SENTINEL note', newString: 'SENTINEL note' };
      // A dropped code file makes the first answer incomplete: the same answer comes back once more, final.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict, noop] })).mockResolvedValueOnce(respond({ files: [], edits: [strict, noop] }));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      expect((turn.response as any).proposal.files).toEqual({ 'tasks.py': target });
      expect(lines('agentic_edit_list ')).toEqual(Array(2).fill('agentic_edit_list mode=strict site=chat outcome=expanded edits=2 files=0 paths=2 code=none'));
      expect(lines('agentic_proposal_unchanged_dropped ')).toEqual(Array(2).fill('agentic_proposal_unchanged_dropped site=chat count=1'));
      expect(lines('agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=started']);
    });

    it('counts a file given whole as it is saved, in either contract', async () => {
      config.agenticEditList = 'strict';
      // Each turn's second answer completes the change, so the regeneration is counted once a turn.
      const strictWhole = { files: [{ path: 'note.md', contents: saved['note.md'] }], edits: [strict] };
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(strictWhole)).mockResolvedValueOnce(respond({ files: [], edits: [strict] }));
      expect(Object.keys(((await say()).response as any).proposal.files)).toEqual(['tasks.py']);
      expect(lines('agentic_edit_list ')).toEqual([
        'agentic_edit_list mode=strict site=chat outcome=expanded edits=1 files=1 paths=2 code=none',
        'agentic_edit_list mode=strict site=chat outcome=expanded edits=1 files=0 paths=1 code=none',
      ]);
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target, 'note.md': saved['note.md'] } })).mockResolvedValueOnce(respond({ files: { 'tasks.py': target } }));
      expect(Object.keys(((await say()).response as any).proposal.files)).toEqual(['tasks.py']);
      expect(lines('agentic_proposal_unchanged_dropped ')).toEqual([
        'agentic_proposal_unchanged_dropped site=chat count=1',
        'agentic_proposal_unchanged_dropped site=chat count=1',
      ]);
      expect(lines('agentic_regeneration ')).toEqual(Array(2).fill('agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=started'));
    });

    it('keeps the propose door as it was: a phase without a record keeps a file given as it is saved, so nothing is counted', async () => {
      config.agenticEditList = 'off';
      provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: { 'tasks.py': target, 'note.md': saved['note.md'] } }));
      expect(Object.keys((await service.propose('agent-test-owner', phaseId, 'Make the comparison strict.')).files)).toEqual(['tasks.py', 'note.md']);
      expect(lines('agentic_proposal_unchanged_dropped ')).toEqual([]);
    });

    it('names a code file dropped as unchanged after the file sentence, even when the summary does not name it', async () => {
      config.agenticEditList = 'strict';
      const noop = { path: 'note.md', oldString: 'SENTINEL note', newString: 'SENTINEL note' };
      const answer = { files: [], edits: [strict, noop], summary: 'Changes tasks.py to a strict comparison.' };
      // The regenerated answer drops it again and is final: its summary names the file.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(answer)).mockResolvedValueOnce(respond(answer));
      const proposal = ((await say()).response as any).proposal;
      expect(proposal.files).toEqual({ 'tasks.py': target });
      expect(proposal.summary).toBe("Files in this proposal: tasks.py. The mentor's answer also named note.md; this proposal does not change it. If you wanted it changed, ask again for it.");
      expect(lines('agentic_summary_paths ')).toEqual(['agentic_summary_paths names=1 held=1 extra=0 unnamed=0']);
    });

    it('writes no line when nothing was dropped, and never a path, a word of the answer or of the request', async () => {
      config.agenticEditList = 'strict';
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict] }));
      expect((await say()).status).toBe('completed');
      expect(lines('agentic_proposal_unchanged_dropped ')).toEqual([]);
      expect(lines('agentic_edit_list ')).toEqual(['agentic_edit_list mode=strict site=chat outcome=expanded edits=1 files=0 paths=1 code=none']);
      const all = logs.mock.calls.map(call => String(call[0])).join('\n');
      expect(all).not.toMatch(/SENTINEL|note\.md|tasks\.py|comparison/);
    });

    it('counts a change request returned whole and unchanged, which the record\'s own check leaves out', async () => {
      config.agenticEditList = 'strict';
      const maintenance = new ContentService().loadProject(recordPack()).phases.find((p) => p.key === 'maintenance')!;
      const original = { key: phase.key, files: phase.files, checks: phase.checks };
      try {
        const savedChange = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 'comments', covers: ['AC-1'], result: 'not-run' }] });
        phase.key = 'maintenance';
        phase.files = [{ path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(EMPTY_CHANGE_REQUEST), editable: true }, { path: 'api/main.py', content: '# api\n', editable: true }];
        phase.checks = maintenance.checks;
        await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { [CHANGE_REQUEST_JSON]: savedChange, 'api/main.py': '# api\n' } });
        const compact = JSON.stringify(JSON.parse(savedChange));
        provider.structured.mockResolvedValueOnce(respond(good)).mockResolvedValueOnce(respond({ files: [{ path: CHANGE_REQUEST_JSON, contents: compact }], edits: [{ path: 'api/main.py', oldString: '# api', newString: '# api: comments' }], summary: 'Changes api/main.py.' }));
        const proposal = await service.propose('agent-test-owner', phaseId, 'Name the comments route.');
        expect(proposal.files).toEqual({ 'api/main.py': '# api: comments\n' });
        // A record returned whole as saved is the edit-list contract's own shape: counted, never named.
        expect((proposal as any).summary).toBe('Changes api/main.py.');
        expect(lines('agentic_edit_list ')).toEqual(['agentic_edit_list mode=strict site=propose outcome=expanded edits=1 files=1 paths=2 code=none']);
        expect(lines('agentic_proposal_unchanged_dropped ')).toEqual(['agentic_proposal_unchanged_dropped site=propose count=1']);
        // ... and is no reason to ask again: the strict golden's Maintenance and Deployment answers have this shape.
        expect(provider.structured).toHaveBeenCalledTimes(2);
        expect(lines('agentic_regeneration ')).toEqual([]);
      } finally { phase.key = original.key; phase.files = original.files; phase.checks = original.checks; }
    });
  });

  /*
   * One bounded completeness regeneration through the regeneration path. A FIRST answer the route's
   * checks keep, but that named a file the learner may edit and does not change it, is asked for once more with the
   * same call, data, schema, label and token cap, the incomplete clause's sentence at the end of the briefing, and
   * only when the 55 s budget leaves room (regenerationFits). The second answer is final and never refused for
   * being incomplete; a second answer that cannot be used leaves the first standing. No turn regenerates twice, and
   * the first request carries no regeneration sentence.
   */
  describe('the one completeness regeneration', () => {
    const heldMode = config.agenticEditList;
    const saved = { 'tasks.py': 'def overdue(due, today):\n    return due <= today\n', 'note.md': 'Old note\n' };
    const target = 'def overdue(due, today):\n    return due < today\n';
    const proposalReply = { kind: 'proposal', reply: 'Understood: one bounded change.', questions: [] };
    const strict = { path: 'tasks.py', oldString: 'due <= today', newString: 'due < today' };
    const note = { path: 'note.md', oldString: 'Old note', newString: 'Strict comparison: due today is not overdue.' };
    const BOTH = 'Changes tasks.py and note.md. Check that a task due today is not overdue.';
    const NAMED = "Files in this proposal: tasks.py. The mentor's answer also named note.md; this proposal does not change it. If you wanted it changed, ask again for it.";
    const STARTED = 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=started';
    const say = (message = 'Make the comparison in tasks.py strict and note it in note.md.') => service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message });
    const generations = () => provider.structured.mock.calls.filter(call => call[5] === 'agentic.generate.edits' || call[5] === 'agentic.generate');
    let logs: jest.SpyInstance;
    const lines = (prefix: string) => logs.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(prefix));
    beforeEach(async () => {
      phase.files = [{ path: 'tasks.py', content: '# TODO', editable: true }, { path: 'note.md', content: 'Old note\n', editable: true }, { path: 'README.md', content: '# TaskTrackr\n', editable: false }];
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: saved });
      config.agenticEditList = 'strict';
      logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => { config.agenticEditList = heldMode; jest.useRealTimers(); jest.restoreAllMocks(); });

    it('asks once more when the first answer\'s summary names an editable file it does not change, and returns the second answer', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict, note], summary: BOTH }));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const proposal = (turn.response as any).proposal;
      expect(proposal.files).toEqual({ 'tasks.py': target, 'note.md': 'Strict comparison: due today is not overdue.\n' });
      expect(proposal.summary).toBe(BOTH);
      expect(provider.structured).toHaveBeenCalledTimes(3);
      const [first, second] = generations();
      // The first request carries no regeneration sentence; the second is the same call with only the clause's sentence added at the end.
      expect(first[0]).toBe(composeAgentChatGeneration(phase, 'edits'));
      expect(second[0]).toBe(`${first[0]}${incompleteRegenerationSentence(['note.md'], 'edits')}`);
      expect([second[1], second[2], second[4], second[5]]).toEqual([first[1], first[2], first[4], 'agentic.generate.edits']);
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(3);
      expect(lines('agentic_regeneration ')).toEqual([STARTED]);
      expect(lines('agentic_summary_paths ')).toEqual(['agentic_summary_paths names=2 held=2 extra=0 unnamed=0']);
    });

    /*
     * The re-ask reads only what is certain, the request's own paths and the answer's own entries. A summary
     * naming a file the request did not write out (to say it stays as it is, or that it is the one to run after Apply)
     * asks for nothing, and neither does a chat refinement of an open proposal; the stored summary still names the file.
     */
    it.each([
      ['names it only to say it stays as it is', 'Changes tasks.py; note.md stays as it is.'],
      ['names it as the file to run after Apply', 'Changes tasks.py. After Apply, run note.md.'],
    ])('does not ask again when the summary %s and the request does not name it', async (_case, summary) => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict], summary }));
      const turn = await say('Make the comparison strict.');
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      expect((turn.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect(lines('agentic_regeneration ')).toEqual([]);
    });

    it('asks again when the request writes out a file the summary names and the answer does not change', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: 'Changes tasks.py. After Apply, run note.md.' }))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict, note], summary: BOTH }));
      const turn = await say('Make the comparison in tasks.py strict and add the case to note.md.');
      expect(Object.keys((turn.response as any).proposal.files)).toEqual(['tasks.py', 'note.md']);
      expect(generations()).toHaveLength(2);
      expect(generations()[1][0]).toBe(`${generations()[0][0]}${incompleteRegenerationSentence(['note.md'], 'edits')}`);
      expect(lines('agentic_regeneration ')).toEqual([STARTED]);
    });

    /*
     * A Maintenance request that names its files by bare file name, on the
     * phase's real nested paths. The request is read as the web card reads it, and only the learner's own message is read.
     */
    describe('on nested Maintenance paths named by bare file name', () => {
      const CHANGE = 'maintenance/change-request.json';
      const HELPER = 'web/src/lib/overdue.ts';
      const TEST = 'web/src/lib/overdue.test.ts';
      const V6 = 'Update overdue.ts so completed tasks return false; keep the date rule. Add one regression test in overdue.test.ts for a completed task due yesterday. Draft the change request with both files in impact and tests not run. Include all three documents.';
      const SHORT = 'Make completed tasks return false in isOverdue, add a regression test, and draft the change request. Keep the date rule.';
      const SEEN = 'Changes web/src/lib/overdue.ts and web/src/lib/overdue.test.ts and records the change in maintenance/change-request.json. The test file adds the completed-yesterday regression case. Check that a completed task is never overdue.';
      const ALL = 'Changes web/src/lib/overdue.ts and web/src/lib/overdue.test.ts and records the change in maintenance/change-request.json.';
      const MISSING = "Files in this proposal: web/src/lib/overdue.ts, maintenance/change-request.json. The mentor's answer also named web/src/lib/overdue.test.ts; this proposal does not change it. If you wanted it changed, ask again for it.";
      const nested = {
        [HELPER]: 'export const isOverdue = (due: string, today: string) => due < today;\n',
        [TEST]: "it('is overdue before today', () => {});\n",
        [CHANGE]: '{"summary": ""}\n',
      };
      const code = { path: HELPER, oldString: 'due < today;', newString: 'due < today && !done;' };
      const record = { path: CHANGE, oldString: '"summary": ""', newString: '"summary": "Completed tasks are never overdue."' };
      const test = { path: TEST, oldString: "it('is overdue before today', () => {});", newString: "it('is overdue before today', () => {});\nit('a completed task due yesterday is not overdue', () => {});" };
      beforeEach(async () => {
        phase.files = [...Object.entries(nested).map(([path, content]) => ({ path, content, editable: true })), { path: 'README.md', content: '# Deadline badge\n', editable: false }];
        await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: nested });
      });

      it('asks once more for the answer to that request that leaves out overdue.test.ts, and returns the second answer', async () => {
        provider.structured.mockResolvedValueOnce(respond(proposalReply))
          .mockResolvedValueOnce(respond({ files: [], edits: [code, record], summary: SEEN }))
          .mockResolvedValueOnce(respond({ files: [], edits: [code, test, record], summary: ALL }));
        const turn = await say(V6);
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect(Object.keys((turn.response as any).proposal.files)).toEqual([HELPER, TEST, CHANGE]);
        expect(generations()).toHaveLength(2);
        expect(generations()[1][0]).toBe(`${generations()[0][0]}${incompleteRegenerationSentence([TEST], 'edits')}`);
        expect(lines('agentic_regeneration ')).toEqual([STARTED]);
      });

      /*
       * The measured shape: every incomplete answer to that request held one edit and one whole
       * file, and every answer of whole files only held all three documents, so the re-ask asks for whole files only.
       * Such a second answer is expanded by the same contract and kept.
       */
      it('asks for whole files only after the one-edit-one-file answer, and expands and keeps a second answer of three whole files', async () => {
        const RECORDED = '{"summary": "Completed tasks are never overdue."}\n';
        const FIXED = 'export const isOverdue = (due: string, today: string) => due < today && !done;\n';
        const TESTED = "it('is overdue before today', () => {});\nit('a completed task due yesterday is not overdue', () => {});\n";
        provider.structured.mockResolvedValueOnce(respond(proposalReply))
          .mockResolvedValueOnce(respond({ files: [{ path: CHANGE, contents: RECORDED }], edits: [code], summary: SEEN }))
          .mockResolvedValueOnce(respond({ files: [{ path: HELPER, contents: FIXED }, { path: TEST, contents: TESTED }, { path: CHANGE, contents: RECORDED }], edits: [], summary: ALL }));
        const turn = await say(V6);
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect((turn.response as any).proposal).toMatchObject({ files: { [HELPER]: FIXED, [TEST]: TESTED, [CHANGE]: RECORDED }, summary: ALL });
        const [first, second] = generations();
        expect(generations()).toHaveLength(2);
        expect(second[0]).toBe(`${first[0]} Your previous answer to this request named ${TEST} and did not change it. Answer the same request again under the same contract, this time with edits as []: give every file the request changes its complete revised contents as its own entry in files, and name in the summary only the files your answer changes.`);
        expect([second[1], second[2], second[4], second[5]]).toEqual([first[1], first[2], first[4], 'agentic.generate.edits']);
        expect(lines('agentic_edit_list ')).toEqual([
          'agentic_edit_list mode=strict site=chat outcome=expanded edits=1 files=1 paths=2 code=none',
          'agentic_edit_list mode=strict site=chat outcome=expanded edits=0 files=3 paths=3 code=none',
        ]);
        expect(lines('agentic_regeneration ')).toEqual([STARTED]);
      });

      it('does not ask again when the request names no file, and the stored summary still names the missing test', async () => {
        provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [code, record], summary: SEEN }));
        const turn = await say(SHORT);
        expect((turn.response as any).proposal).toMatchObject({ summary: MISSING });
        expect(Object.keys((turn.response as any).proposal.files)).toEqual([HELPER, CHANGE]);
        expect(provider.structured).toHaveBeenCalledTimes(2);
        expect(lines('agentic_regeneration ')).toEqual([]);
      });

      it('keeps the first answer that held only the code fix when the second holds the record and the test but drops the fix', async () => {
        provider.structured.mockResolvedValueOnce(respond(proposalReply))
          .mockResolvedValueOnce(respond({ files: [], edits: [code], summary: SEEN }))
          .mockResolvedValueOnce(respond({ files: [], edits: [test, record], summary: 'Adds the regression case to web/src/lib/overdue.test.ts and records the change in maintenance/change-request.json.' }));
        const turn = await say(V6);
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect((turn.response as any).proposal).toMatchObject({ files: { [HELPER]: 'export const isOverdue = (due: string, today: string) => due < today && !done;\n' },
          summary: "Files in this proposal: web/src/lib/overdue.ts. The mentor's answer also named web/src/lib/overdue.test.ts, maintenance/change-request.json; this proposal does not change them. If you wanted them changed, ask again for them." });
        expect(generations()).toHaveLength(2);
        expect(lines('agentic_regeneration ')).toEqual([STARTED, 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=first_kept']);
      });

      it('reads only the learner\'s own message: a path the mentor wrote in an earlier reply asks for nothing', async () => {
        const clarify = { kind: 'clarification', reply: `Should the regression case go in ${TEST}?`, questions: [`Should the regression case go in ${TEST}?`] };
        provider.structured.mockResolvedValueOnce(respond(clarify));
        const asked = await say(SHORT);
        expect((asked.response as any).kind).toBe('clarification');
        provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [code, record], summary: SEEN }));
        const turn = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Yes, keep the date rule.', parentTurnId: asked.id });
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect((turn.response as any).proposal).toMatchObject({ summary: MISSING });
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(lines('agentic_regeneration ')).toEqual([]);
      });
    });

    it('keeps the summary that names the read-only selfcheck to run after Apply in a Deployment-shaped phase', async () => {
      const services = '{"web": {"env": {"API_URL": "http://127.0.0.1:8000"}}}\n';
      phase.files = [{ path: 'deploy/services.json', content: services, editable: true }, { path: 'deployment/runbook.json', content: '{}\n', editable: true },
        { path: 'ops/selfcheck.py', content: 'print("selfcheck")\n', editable: false }, { path: 'ops/Dockerfile', content: 'FROM python:3.12\n', editable: false }];
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { 'deploy/services.json': services, 'deployment/runbook.json': '{}\n' } });
      const run = 'Changes deploy/services.json: web.env.API_URL becomes http://api:8000. Read the API_URL line in the comparison before explaining it. After Apply, run python3 ops/selfcheck.py --selfcheck.';
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'deploy/services.json', oldString: 'http://127.0.0.1:8000', newString: 'http://api:8000' }], summary: run }));
      const turn = await say("Fix the web service's API address.");
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      expect((turn.response as any).proposal).toMatchObject({ files: { 'deploy/services.json': services.replace('http://127.0.0.1:8000', 'http://api:8000') }, summary: run });
      expect(lines('agentic_summary_paths ')).toEqual(['agentic_summary_paths names=2 held=1 extra=1 unnamed=0']);
      expect(lines('agentic_regeneration ')).toEqual([]);
    });

    it('does not ask again on a chat refinement of an open proposal that puts a file back as it is saved', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict, note], summary: BOTH }));
      const opened = await say();
      const selected = (opened.response as any).proposal;
      expect(Object.keys(selected.files)).toEqual(['tasks.py', 'note.md']);
      // The refinement reverts note.md to its saved bytes; the request and the summary both name it.
      const revert = { path: 'note.md', oldString: 'Strict comparison: due today is not overdue.', newString: 'Old note' };
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [revert], summary: 'Restores note.md as it is saved.' }));
      const refined = await service.chat('agent-test-owner', phaseId, { requestId: randomUUID(), message: 'Leave note.md as it is saved.', parentTurnId: opened.id, proposalId: selected.id, proposalHash: selected.proposalHash });
      expect([refined.status, refined.errorCode]).toEqual(['completed', null]);
      expect((refined.response as any).proposal.files).toEqual({ 'tasks.py': target });
      expect(provider.structured).toHaveBeenCalledTimes(4);
      expect(lines('agentic_proposal_unchanged_dropped ')).toEqual(['agentic_proposal_unchanged_dropped site=chat count=1']);
      expect(lines('agentic_regeneration ')).toEqual([]);
    });

    /*
     * The second answer replaces the first only when it holds every file the first held and at
     * least as many of what was named (the files the first holds, the paths the request names and the first summary
     * names); otherwise the first stands.
     */
    it('keeps the first answer when the second holds fewer of the named files, or as many but not the same ones', async () => {
      phase.files = [...phase.files, { path: 'log.md', content: 'Old log\n', editable: true }];
      await db.getRepository(PhaseStateEntity).update(phaseId, { workspace: { ...saved, 'log.md': 'Old log\n' } });
      const log = { path: 'log.md', oldString: 'Old log', newString: 'Comparison made strict.' };
      // Fewer: the first holds tasks.py and log.md, the second only note.md.
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict, log], summary: 'Changes tasks.py, log.md and note.md.' }))
        .mockResolvedValueOnce(respond({ files: [], edits: [note], summary: 'Changes note.md.' }));
      const fewer = await say('Make tasks.py strict, log it in log.md and note it in note.md.');
      expect(Object.keys((fewer.response as any).proposal.files)).toEqual(['tasks.py', 'log.md']);
      expect((fewer.response as any).proposal.summary).toBe("Files in this proposal: tasks.py, log.md. The mentor's answer also named note.md; this proposal does not change it. If you wanted it changed, ask again for it.");
      // As many, not the same: the first holds tasks.py, the second only note.md (the tasks.py edit forgotten).
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [note], summary: BOTH }));
      const tie = await say();
      expect((tie.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
      expect(provider.structured).toHaveBeenCalledTimes(6);
      const kept = 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=first_kept';
      expect(lines('agentic_regeneration ')).toEqual([STARTED, kept, STARTED, kept]);
    });

    it('takes the second answer when it holds more of the named files, or the same ones', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict, note], summary: BOTH }));
      expect(Object.keys(((await say()).response as any).proposal.files)).toEqual(['tasks.py', 'note.md']);
      const same = { path: 'tasks.py', oldString: 'due <= today', newString: 'due < today  # strict' };
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [same], summary: BOTH }));
      expect(((await say()).response as any).proposal.files).toEqual({ 'tasks.py': 'def overdue(due, today):\n    return due < today  # strict\n' });
      expect(lines('agentic_regeneration ')).toEqual([STARTED, STARTED]);
    });

    it('says why in platform words and editable paths only, in the contract\'s own terms: whole files only under the edit list', () => {
      const LEAD = ' Your previous answer to this request named';
      const EDITS = ' Answer the same request again under the same contract, this time with edits as []: give every file the request changes its complete revised contents as its own entry in files, and name in the summary only the files your answer changes.';
      const FILES = ' Answer the same request again under the same contract: give every file the request changes its complete revised contents in files, and name in the summary only the files your answer changes.';
      expect(incompleteRegenerationSentence(['note.md'], 'edits')).toBe(`${LEAD} note.md and did not change it.${EDITS}`);
      expect(incompleteRegenerationSentence(['a.md', 'b.md'], 'edits')).toBe(`${LEAD} a.md, b.md and did not change them.${EDITS}`);
      expect(incompleteRegenerationSentence(['notes/my file.md'], 'edits')).toBe(`${LEAD} a file and did not change it.${EDITS}`);
      expect(incompleteRegenerationSentence(['a.md', 'notes/my file.md'], 'edits')).toBe(`${LEAD} files and did not change them.${EDITS}`);
      expect(incompleteRegenerationSentence(['note.md'], 'files')).toBe(`${LEAD} note.md and did not change it.${FILES}`);
      expect(incompleteRegenerationSentence(['a.md', 'b.md'], 'files')).toBe(`${LEAD} a.md, b.md and did not change them.${FILES}`);
      expect(incompleteRegenerationSentence(['notes/my file.md'], 'files')).toBe(`${LEAD} a file and did not change it.${FILES}`);
      expect(incompleteRegenerationSentence(['a.md', 'notes/my file.md'], 'files')).toBe(`${LEAD} files and did not change them.${FILES}`);
    });

    it('returns an incomplete second answer as it is, never refused and never asked for a third time', async () => {
      const incomplete = { files: [], edits: [strict], summary: BOTH };
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(incomplete)).mockResolvedValueOnce(respond(incomplete));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      const proposal = (turn.response as any).proposal;
      expect(proposal.files).toEqual({ 'tasks.py': target });
      expect(proposal.summary).toBe(NAMED);
      expect(provider.structured).toHaveBeenCalledTimes(3);
      expect(lines('agentic_regeneration ')).toEqual([STARTED]);
      expect(lines('agentic_proposal_refused ')).toEqual([]);
    });

    it('does not ask again for a complete first answer, nor for one whose summary names only a read-only file', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: 'Changes tasks.py.' }));
      expect(((await say()).response as any).proposal.summary).toBe('Changes tasks.py.');
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: 'Changes tasks.py; README.md stays as it is.' }));
      // README.md is read-only: no claimed change, so the summary keeps its words.
      expect(((await say()).response as any).proposal.summary).toBe('Changes tasks.py; README.md stays as it is.');
      // And none for an answer without a summary that dropped nothing.
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond({ files: [], edits: [strict] }));
      expect(((await say()).response as any).proposal.summary).toBeNull();
      expect(provider.structured).toHaveBeenCalledTimes(6);
      expect(lines('agentic_regeneration ')).toEqual([]);
    });

    it.each(['strict', 'off'] as const)('with the edit list %s, sends the first request byte for byte as it would for a complete answer', async (mode) => {
      config.agenticEditList = mode;
      const answer = (summary: string) => mode === 'off' ? { files: { 'tasks.py': target }, summary } : { files: [], edits: [strict], summary };
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(answer('Changes tasks.py.')));
      await say();
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockResolvedValueOnce(respond(answer(BOTH))).mockResolvedValueOnce(respond(answer(BOTH)));
      await say();
      const [complete, first, second] = generations();
      expect(generations()).toHaveLength(3);
      expect(first).toEqual(complete);
      expect(first[0]).toBe(composeAgentChatGeneration(phase, mode === 'off' ? 'files' : 'edits'));
      expect(second[0]).toBe(`${first[0]}${incompleteRegenerationSentence(['note.md'], mode === 'off' ? 'files' : 'edits')}`);
    });

    it('does not ask again when the budget left is not more than twice the first generation plus 5 s: the first answer stands, its summary naming the file', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      let finish!: (value: unknown) => void;
      provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = say();
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      // 17 s spent: 38 s left, not more than 2 x 17 + 5 = 39 s.
      await jest.advanceTimersByTimeAsync(17_000);
      finish(respond({ files: [], edits: [strict], summary: BOTH }));
      const turn = await pending;
      jest.useRealTimers();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      expect((turn.response as any).proposal.summary).toBe(NAMED);
      expect(provider.structured).toHaveBeenCalledTimes(2);
      expect(lines('agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=skipped']);
    });

    it('keeps the first answer when the second call is still running 5 s before the route\'s deadline', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      let second: AbortSignal | undefined;
      let classified!: (value: unknown) => void;
      let generated!: (value: unknown) => void;
      // A 34 s classify and a 5 s first generation leave 16 s: the re-ask fits (more than 15 s and 2 x 5 + 5 s), and the
      // deadline's cut-off, 11 s after the second call starts, comes before its own 12 s bound.
      provider.structured.mockImplementationOnce(() => new Promise(resolve => { classified = resolve; }))
        .mockImplementationOnce(() => new Promise(resolve => { generated = resolve; }))
        // The second call answers only when its signal aborts, as the provider does.
        .mockImplementationOnce((_system: string, _data: unknown, _tokens: number, signal: AbortSignal) => {
          second = signal;
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        });
      let settled = false;
      const pending = say().finally(() => { settled = true; });
      while (!classified) await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(34_000);
      classified(respond(proposalReply));
      while (!generated) await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(5_000);
      generated(respond({ files: [], edits: [strict], summary: BOTH }));
      while (!second) await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS - 39_000 - REGENERATION_REPLY_MS - 100);
      expect([settled, second.aborted]).toEqual([false, false]);
      // Past the cut-off and, if the cut-off were missing, past the route's deadline too.
      await jest.advanceTimersByTimeAsync(REGENERATION_REPLY_MS + 1_000);
      const turn = await pending;
      jest.useRealTimers();
      expect(second.aborted).toBe(true);
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      expect((turn.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
      expect(provider.structured).toHaveBeenCalledTimes(3);
      expect(lines('agentic_regeneration ')).toEqual([STARTED, 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=first_kept']);
    });

    /*
     * The completeness re-ask's own two bounds, measured on TaskTrackr's four-file Maintenance request. It
     * starts only after a first generation of at most 10 s, and its call is stopped 12 s after it starts; neither
     * touches the route's budget or the regeneration of a refused answer.
     */
    describe('bounded by the learner\'s wait', () => {
      const SKIPPED_SLOW = 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=skipped reason=first_slow';
      const KEPT_SLOW = 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=first_kept reason=second_slow';
      const tick = () => new Promise(resolve => setImmediate(resolve));
      /** Waits a bounded number of turns of the event loop, so a broken bound fails here instead of hanging the file. */
      const until = async (ready: () => boolean) => { for (let i = 0; i < 5_000 && !ready(); i++) await tick(); expect(ready()).toBe(true); };
      /** The first generation answers `answer` after `ms` of fake time; the classify call answers at once. */
      const firstAfter = async (ms: number, answer: unknown, then?: (mock: jest.Mock) => void) => {
        let finish!: (value: unknown) => void;
        provider.structured.mockResolvedValueOnce(respond(proposalReply)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        then?.(provider.structured);
        const pending = say();
        await until(() => !!finish);
        await jest.advanceTimersByTimeAsync(ms);
        finish(respond(answer));
        return pending;
      };
      beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); });

      it('pins the two bounds', () => {
        expect([INCOMPLETE_REASK_FIRST_MAX_MS, INCOMPLETE_REASK_SECOND_MAX_MS]).toEqual([10_000, 12_000]);
      });

      it.each([9_000, INCOMPLETE_REASK_FIRST_MAX_MS])('asks once more after an incomplete first generation of %i ms', async (ms) => {
        const turn = await firstAfter(ms, { files: [], edits: [strict], summary: BOTH }, mock => mock.mockResolvedValueOnce(respond({ files: [], edits: [strict, note], summary: BOTH })));
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect(Object.keys((turn.response as any).proposal.files)).toEqual(['tasks.py', 'note.md']);
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(lines('agentic_regeneration ')).toEqual([STARTED]);
      });

      it('does not ask again after an incomplete first generation of 11 s: the first answer stands, its summary naming the file', async () => {
        const turn = await firstAfter(11_000, { files: [], edits: [strict], summary: BOTH });
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect((turn.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
        expect(provider.structured).toHaveBeenCalledTimes(2);
        expect(lines('agentic_regeneration ')).toEqual([SKIPPED_SLOW]);
      });

      it('stops a second call still running 12 s after it starts and keeps the first answer', async () => {
        let second: AbortSignal | undefined;
        let settled = false;
        const pending = firstAfter(2_000, { files: [], edits: [strict], summary: BOTH }, mock => mock.mockImplementationOnce((_system: string, _data: unknown, _tokens: number, signal: AbortSignal) => {
          second = signal;
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        })).finally(() => { settled = true; });
        await until(() => !!second);
        await jest.advanceTimersByTimeAsync(INCOMPLETE_REASK_SECOND_MAX_MS - 100);
        expect([settled, second!.aborted]).toEqual([false, false]);
        await jest.advanceTimersByTimeAsync(200);
        await until(() => settled);
        const turn = await pending;
        expect(second!.aborted).toBe(true);
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect((turn.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(lines('agentic_regeneration ')).toEqual([STARTED, KEPT_SLOW]);
        expect(lines('agentic_proposal_refused ')).toEqual([]);
      });

      it('takes a second answer that comes back within 12 s', async () => {
        let finish!: (value: unknown) => void;
        const pending = firstAfter(2_000, { files: [], edits: [strict], summary: BOTH }, mock => mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
        await until(() => !!finish);
        await jest.advanceTimersByTimeAsync(INCOMPLETE_REASK_SECOND_MAX_MS - 500);
        finish(respond({ files: [], edits: [strict, note], summary: BOTH }));
        const turn = await pending;
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect((turn.response as any).proposal).toMatchObject({ files: { 'tasks.py': target, 'note.md': 'Strict comparison: due today is not overdue.\n' }, summary: BOTH });
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(lines('agentic_regeneration ')).toEqual([STARTED]);
        // Its timers are cleared: nothing fires later and no line follows.
        await jest.advanceTimersByTimeAsync(AGENTIC_REQUEST_TIMEOUT_MS);
        expect(lines('agentic_regeneration ')).toEqual([STARTED]);
      });

      it('leaves the regeneration of a refused answer unbound: after an 11 s first answer, and running past 12 s', async () => {
        let second: AbortSignal | undefined;
        let finish!: (value: unknown) => void;
        const pending = firstAfter(11_000, { files: [], edits: [{ path: 'tasks.py', oldString: 'due', newString: 'x' }], summary: BOTH }, mock => mock.mockImplementationOnce((_system: string, _data: unknown, _tokens: number, signal: AbortSignal) => {
          second = signal;
          return new Promise(resolve => { finish = resolve; });
        }));
        await until(() => !!second);
        await jest.advanceTimersByTimeAsync(20_000);
        expect(second!.aborted).toBe(false);
        finish(respond({ files: [], edits: [strict, note], summary: BOTH }));
        const turn = await pending;
        expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
        expect(Object.keys((turn.response as any).proposal.files)).toEqual(['tasks.py', 'note.md']);
        expect(provider.structured).toHaveBeenCalledTimes(3);
        expect(lines('agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=files_proposal_refused clause=edit_list outcome=started']);
      });
    });

    it('never regenerates twice: a refused first answer gets its one regeneration, and its incomplete second answer is final', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'tasks.py', oldString: 'due', newString: 'x' }], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }));
      const turn = await say();
      expect([turn.status, turn.errorCode]).toEqual(['completed', null]);
      expect((turn.response as any).proposal.summary).toBe(NAMED);
      expect(provider.structured).toHaveBeenCalledTimes(3);
      expect(lines('agentic_regeneration ')).toEqual(['agentic_regeneration site=chat code=files_proposal_refused clause=edit_list outcome=started']);
      // The refusal's briefing is the regeneration's own.
      const [first, second] = generations();
      expect(second[0]).toBe(`${first[0]}${regenerationSentence(new RefusedProbe(`${FILES_PROPOSAL_REFUSED} An edit to tasks.py quotes text that appears more than once in that file.`), 'edits')}`);
    });

    it('keeps the first answer when the second is refused or its call fails, and says so in one line', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'tasks.py', oldString: 'not there', newString: 'x' }], summary: BOTH }));
      const refused = await say();
      expect([refused.status, refused.errorCode]).toEqual(['completed', null]);
      expect((refused.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockRejectedValueOnce(new ProviderUsageError('AI structured response was not JSON', 5, 6));
      const failed = await say();
      expect([failed.status, failed.errorCode]).toEqual(['completed', null]);
      expect((failed.response as any).proposal).toMatchObject({ files: { 'tasks.py': target }, summary: NAMED });
      expect(provider.structured).toHaveBeenCalledTimes(6);
      expect(lines('agentic_regeneration ')).toEqual([STARTED, 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=first_kept', STARTED, 'agentic_regeneration site=chat code=proposal_incomplete clause=incomplete outcome=first_kept']);
      expect(lines('agentic_proposal_refused ')).toEqual([]);
      // Every model call bills its spend, the failed one too.
      expect((service as any).assistant.recordReviewUsage).toHaveBeenCalledTimes(6);
    });

    it('regenerates at the propose door too, but not on a turn whose prompt assessment was already asked again', async () => {
      provider.structured.mockResolvedValueOnce(respond(good))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict, note], summary: BOTH }));
      expect(Object.keys((await service.propose('agent-test-owner', phaseId, 'Make tasks.py strict and note it in note.md.')).files)).toEqual(['tasks.py', 'note.md']);
      expect(lines('agentic_regeneration ')).toEqual(['agentic_regeneration site=propose code=proposal_incomplete clause=incomplete outcome=started']);
      provider.structured.mockClear();
      logs.mockClear();
      provider.structured.mockResolvedValueOnce(respond({ adequate: true, feedback: 'Clear.', questions: ['One?'] }))
        .mockResolvedValueOnce(respond(good))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: BOTH }));
      const proposal = await service.propose('agent-test-owner', phaseId, 'Make tasks.py strict and note it in note.md.');
      expect((proposal as any).summary).toBe(NAMED);
      expect(provider.structured).toHaveBeenCalledTimes(3);
      expect(lines('agentic_regeneration ')).toEqual(['agentic_regeneration site=classify code=intent_assessment clause=one_question outcome=ok']);
    });

    it('writes no path, model word or learner word in any line', async () => {
      provider.structured.mockResolvedValueOnce(respond(proposalReply))
        .mockResolvedValueOnce(respond({ files: [], edits: [strict], summary: `SENTINEL ${BOTH}` }))
        .mockResolvedValueOnce(respond({ files: [], edits: [{ path: 'tasks.py', oldString: 'SENTINEL', newString: 'x' }], summary: 'SENTINEL' }));
      await say('SENTINEL-LEARNER make tasks.py strict and note it in note.md');
      const all = logs.mock.calls.map(call => String(call[0])).join('\n');
      expect(all).toContain('outcome=first_kept');
      expect(all).not.toMatch(/SENTINEL|note\.md|tasks\.py/);
    });
  });
});
