import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AnalyticsService } from '../analytics/analytics.service';
import type { AssistantService } from '../assistant/assistant.service';
import type { AuthUser } from '../auth/auth.decorators';
import type { ContentService } from '../content/content.service';
import type { ExecutionService } from '../execution/execution.service';
import type { FeedbackService } from '../feedback/feedback.service';
import { ViewAsService } from '../instructor/view-as.service';
import { PhasesController } from './phases.controller';
import type { WorkflowService } from './workflow.service';

/**
 * A board that draws every phase at once must survive one phase it cannot
 * read. The learner's records batch answers an unreadable list as an empty
 * one, and a teacher viewing as the learner sees the board without the phase
 * that could not be read. Neither turns into a 500, and neither writes a log
 * line.
 */
describe('a phase that cannot be read on a whole-board route', () => {
  const learner: AuthUser = { id: 'learner-1', role: 'LEARNER', cohort: 'class-1' } as AuthUser;
  const unreadable = () => Promise.reject(new Error('the read failed'));

  afterEach(() => jest.restoreAllMocks());

  it('answers its submissions, runs and chat on the records route as empty lists', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = jest.spyOn(Logger.prototype, 'error');
    const workflow = {
      phaseSummariesForLearner: jest.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]),
    } as unknown as WorkflowService;
    const submission = { id: 's1' };
    const feedback = {
      listFor: jest.fn((phaseId: string) => (phaseId === 'p1' ? Promise.resolve([submission]) : unreadable())),
    } as unknown as FeedbackService;
    const execution = { listFor: jest.fn(unreadable) } as unknown as ExecutionService;
    const assistant = { history: jest.fn(unreadable) } as unknown as AssistantService;
    const controller = new PhasesController(workflow, execution, feedback, assistant, {} as ContentService);

    await expect(controller.records(learner)).resolves.toEqual({
      p1: { submissions: [submission], runs: [], chat: [] },
      p2: { submissions: [], runs: [], chat: [] },
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('leaves the phase off the board a teacher sees when viewing as the learner', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = jest.spyOn(Logger.prototype, 'error');
    const learnerRow = { id: '7c1d2e3f-0000-4a5b-8c9d-0e1f2a3b4c5d', role: 'LEARNER', cohort: 'class-1' };
    const dataSource = {
      manager: { findOne: jest.fn().mockResolvedValue(learnerRow), find: jest.fn().mockResolvedValue([]) },
    } as unknown as DataSource;
    const workflow = {
      myEnrollment: jest.fn().mockResolvedValue({
        phases: [
          { id: 'p1', status: 'active' },
          { id: 'p2', status: 'active' },
          { id: 'p3', status: 'locked' },
        ],
      }),
    } as unknown as WorkflowService;
    const service = new ViewAsService(
      dataSource,
      workflow,
      {} as FeedbackService,
      {} as ExecutionService,
      {} as AssistantService,
      {} as AnalyticsService,
    );
    const learnerPhase = jest
      .spyOn(ViewAsService.prototype as unknown as { learnerPhase: (id: string, phase: string) => Promise<unknown> }, 'learnerPhase')
      .mockImplementation((_id: string, phase: string) => (phase === 'p1' ? Promise.resolve({ id: 'p1' }) : unreadable()));

    const board = await service.summaries({ id: 'admin-1', role: 'ADMIN', cohort: 'default' }, learnerRow.id, 'tasktrackr');

    expect(board).toEqual([{ id: 'p1' }]);
    expect(learnerPhase).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
