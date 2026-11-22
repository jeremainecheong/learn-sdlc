import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { DatabaseModule } from '../db/database.module';
import { ExecutionRunEntity } from '../db/entities';
import { repoToken } from '../db/inject';
import { AgentProposalEntity } from './agent-proposal.entity';
import { AgenticController } from './agentic.controller';
import { AgenticService, workspaceHash } from './agentic.service';
import { AssistantService } from './assistant.service';
import { ContentService } from '../content/content.service';
import { EVIDENCE_MAX_RUNS } from './explanation-evidence';
import { UNDERSTANDING_DIMENSIONS, explanationEvidence } from './explanation-assessment';
import { AI_CALL_LABELS, AI_CALL_OUTCOMES, structuredCallLabel } from './model-call-timing';
import { OpenAiProvider } from './openai.provider';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { WorkflowService } from '../workflow/workflow.service';

/**
 * One trace, held by tests: the door a learner knocks on, the route behind it,
 * the service that answers, the records it is allowed to gather, and the
 * fixed label that call is measured under.
 *
 * Each piece of that line has its own suite, and none of those suites owns
 * the joins. A piece's own suite stays green when a join is cut, the evidence
 * builder still reduces records correctly with nothing calling it, the label
 * set still holds a name nothing passes, the runbook still describes a series
 * no call site reaches. These are the assertions that go red instead.
 */
describe('the assistant wiring: the API half of the explanation review is connected end to end', () => {
  const RUNBOOK = path.resolve(__dirname, '../../../../docs/production-runbook.md');

  describe('entry point', () => {
    it('mounts the agentic route and its service on the application module', () => {
      expect(Reflect.getMetadata('controllers', AppModule)).toContain(AgenticController);
      expect(Reflect.getMetadata('providers', AppModule)).toContain(AgenticService);
    });

    it('keeps the explanation review reachable at the route the learner’s browser posts to', () => {
      expect(Reflect.getMetadata('path', AgenticController)).toBe('phases/:id/agent');
      expect(Reflect.getMetadata('path', AgenticController.prototype.explain)).toBe('proposals/:proposalId/explain');
    });
  });

  describe('the recorded-evidence builder is reachable from the container', () => {
    it('asks the container for the execution-run repository, which the database module provides', () => {
      const declared = (Reflect.getMetadata('self:paramtypes', AgenticService) ?? []) as Array<{ index: number; param: unknown }>;
      expect(declared.map(entry => entry.param)).toContain(repoToken(ExecutionRunEntity));
      const provided = (Reflect.getMetadata('providers', DatabaseModule) ?? []) as Array<{ provide?: unknown }>;
      expect(provided.map(entry => entry?.provide)).toContain(repoToken(ExecutionRunEntity));
    });
  });

  describe('every agentic call carries a name from the fixed set', () => {
    it('keeps the three agentic labels, and the schema-name fallback that guarded the explanation call', () => {
      for (const label of ['agentic.classify', 'agentic.generate', 'agentic.explanation']) expect(AI_CALL_LABELS).toContain(label);
      expect(structuredCallLabel('learner_understanding_v6')).toBe('agentic.explanation');
      expect(structuredCallLabel('a name no call site uses')).toBe('structured.other');
    });
  });

  describe('the operator documentation describes the series the code actually emits', () => {
    const runbook = () => fs.readFileSync(RUNBOOK, 'utf8');

    it('names every model-call label and outcome the code can put on a series', () => {
      const text = runbook();
      for (const label of AI_CALL_LABELS) expect(text).toContain(`\`${label}\``);
      for (const outcome of AI_CALL_OUTCOMES) expect(text).toContain(`\`${outcome}\``);
    });

    it('documents every AI metric family the process registers at load', () => {
      const registered = fs.readFileSync(path.resolve(__dirname, '../observability/metrics.ts'), 'utf8')
        .match(/name: '(ai_[a-z_]+)'/g)!.map(line => line.replace(/^name: '|'$/g, ''));
      expect(registered.length).toBeGreaterThan(0);
      for (const family of registered) expect(runbook()).toContain(`\`${family}\``);
    });
  });

  /**
   * The whole line at once, over real HTTP: DTO, guard metadata, controller
   * dispatch, the service's own owner-scoped gathering, the builder's
   * reduction, and the label the provider is handed. Everything below the
   * service is a fixture; ownership, persistence and provider failure are
   * proved against real SQLite in agentic.service.spec.ts.
   */
  describe('the learner’s explanation request reaches the assessor with their own records', () => {
    let app: INestApplication;
    const userId = 'resolved-owner';
    const phaseStateId = randomUUID();
    const proposalId = randomUUID();
    const files = { 'tasks.py': 'return due < today and not completed' };
    const explanation = 'The strict comparison excludes tasks due today, and the completed filter preserves the requested boundary. Comparing the two files is the check; nothing here shows a run passed.';
    const proposal = {
      id: proposalId, userId, phaseStateId, prompt: 'Exclude today from overdue without changing the contract.',
      files, proposalHash: workspaceHash(files), baseWorkspaceHash: workspaceHash({ 'tasks.py': '# TODO' }), lastEdit: null,
      assessment: { adequate: true, feedback: 'Bounded.', questions: [] },
      explanation: null, explanationAssessment: null, approvedAt: null, appliedAt: null,
      createdAt: new Date('2026-09-18T00:00:00.000Z'), updatedAt: new Date('2026-09-18T00:00:00.000Z'),
    } as unknown as AgentProposalEntity;
    const phase = { key: 'implementation', title: 'Implementation', taskPanel: 'TaskTrackr excludes today from overdue.',
      objectives: ['Implement overdue filtering'], files: [{ path: 'tasks.py', content: '# TODO', editable: true }] };
    const state = { id: phaseStateId, userId, workspace: { 'tasks.py': '# TODO' }, workspaceUpdatedAt: null,
      drill: { fault: 'health endpoint returns 500', pagedAt: '2026-09-17T09:00:00.000Z', runbookBefore: 'PRIVATE RUNBOOK BYTES',
        pagedExit: 1, healthRanAt: '2026-09-17T09:10:00.000Z', healthExit: 0, fixAppliedAt: '2026-09-17T09:20:00.000Z',
        resolvedAt: '2026-09-17T09:30:00.000Z', incident: { rootCause: 'PRIVATE ROOT CAUSE', fix: 'PRIVATE FIX', actionItem: 'PRIVATE ACTION' } } };
    const runRow = {
      id: randomUUID(), userId, phaseStateId, kind: 'run', status: 'completed',
      result: { ok: true, exitKind: 'ok', stdout: 'PRIVATE STDOUT', stderr: 'PRIVATE STDERR', durationMs: 9,
        tests: { total: 4, passed: 4, failed: 0, errored: 0, cases: [{ name: 'PRIVATE CASE', status: 'passed' }] } },
      createdAt: new Date('2026-09-18T01:00:00.000Z'),
    };
    const runs = { find: jest.fn() };
    const proposals = { findOneBy: jest.fn(), update: jest.fn() };
    const provider = { available: true, name: 'local-ai:test-double', structured: jest.fn() };

    beforeEach(async () => {
      runs.find.mockReset().mockResolvedValue([runRow]);
      proposals.findOneBy.mockReset().mockResolvedValue(proposal);
      proposals.update.mockReset().mockResolvedValue({ affected: 1 });
      provider.structured.mockReset().mockResolvedValue({ tokensIn: 10, tokensOut: 20, value: {
        dimensions: UNDERSTANDING_DIMENSIONS.map(key => ({ key, met: true, finding: 'supported',
          learnerEvidenceIds: explanationEvidence(explanation).map(unit => unit.id) })),
      } });
      const module = await Test.createTestingModule({
        controllers: [AgenticController],
        providers: [
          AgenticService,
          { provide: repoToken(AgentProposalEntity), useValue: proposals },
          { provide: repoToken(ExecutionRunEntity), useValue: runs },
          { provide: WorkflowService, useValue: { loadOwnedState: jest.fn(async () => ({ state, phase })), transaction: jest.fn() } },
          { provide: AssistantService, useValue: { serialise: (_id: string, work: () => Promise<unknown>) => work(), recordReviewUsage: jest.fn() } },
          { provide: OpenAiProvider, useValue: provider },
          { provide: DataSource, useValue: {} },
          // The pinned-task reader, the service's last argument. This double pins no version, so the
          // scope resolves from the phase alone.
          { provide: ContentService, useValue: {} },
        ],
      }).overrideGuard(RateLimitGuard).useValue({ canActivate: () => true }).compile();
      app = module.createNestApplication();
      app.setGlobalPrefix('api/v1');
      app.use((req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: userId }; next(); });
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.listen(0, '127.0.0.1');
    });
    afterEach(async () => { await app.close(); });

    it('gathers only this learner’s own runs for this phase state and hands the assessor the reduced record', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/phases/${phaseStateId}/agent/proposals/${proposalId}/explain`)
        .send({ proposalHash: proposal.proposalHash, explanation }).expect(200);
      expect(response.body.approvedAt).toBeTruthy();

      // The gathering is scoped to the caller, not merely to the phase state.
      expect(runs.find).toHaveBeenCalledWith({
        where: { userId, phaseStateId, kind: 'run', status: 'completed' },
        order: { createdAt: 'DESC', id: 'DESC' }, take: EVIDENCE_MAX_RUNS,
      });

      const [, data, , , schema, label] = provider.structured.mock.calls.at(-1)!;
      expect(label).toBe('agentic.explanation');
      expect(AI_CALL_LABELS).toContain(label);
      expect(schema.name).toBe('learner_understanding_v6');
      expect(Object.keys(data)).toEqual(['reference', 'evidence', 'learnerAnswer', 'answerEvidence']);
      expect(data.evidence.recordedRuns).toEqual([{ at: runRow.createdAt.toISOString(), exitKind: 'ok', ok: true,
        tests: { total: 4, passed: 4, failed: 0, errored: 0 }, predatesProposal: false }]);
      expect(data.evidence.recordedDrill).toMatchObject({ fault: state.drill.fault, pagedExit: 1, healthExit: 0, incidentRecorded: true });
      expect(data.evidence.recordedEdit).toBeNull();

      // Nothing the builder withholds may ride along on the same request.
      const payload = JSON.stringify(data);
      for (const withheld of ['PRIVATE STDOUT', 'PRIVATE STDERR', 'PRIVATE CASE', 'PRIVATE RUNBOOK', 'PRIVATE ROOT CAUSE', 'PRIVATE FIX', 'PRIVATE ACTION']) {
        expect(payload).not.toContain(withheld);
      }
    });
  });
});
