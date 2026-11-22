import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { RUN_CLOCK_MESSAGE } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from './workflow.service';

/**
 * The run clock.
 *
 * The clock is the learner's own parameter on their own phase, so there is very
 * little to it, which is why the three things that can go wrong are worth
 * pinning: it belongs to the testing phase and nowhere else, it accepts a date
 * and nothing else, and it is a narrow write. That last one is the one that
 * costs a learner their work if it regresses: `save(state)` here would post the
 * copy of `workspace` read at the top of the request over whatever the autosave
 * landed while the learner was reaching for the control.
 */
describe('WorkflowService.setRunClock', () => {
  let dataSource: DataSource;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let releases: Repository<ReleaseRecordEntity>;
  let content: ContentService;
  let service: WorkflowService;

  const learner = 'learner-1';

  const enrol = async (): Promise<Record<string, string>> => {
    const view = await service.enroll(learner, 'tasktrackr');
    for (const phase of view.phases) {
      await phaseStates.update(phase.id, { status: 'in_progress' });
    }
    return Object.fromEntries(view.phases.map((p) => [p.key, p.id]));
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    releases = dataSource.getRepository(ReleaseRecordEntity);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    service = new WorkflowService(
      enrollments,
      phaseStates,
      releases,
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
  });

  it('pins the day, and hands it back on the phase', async () => {
    const ids = await enrol();

    const saved = await service.setRunClock(learner, ids.testing, '2026-03-01');

    expect(saved).toEqual({ saved: true, runClock: '2026-03-01' });
    expect((await phaseStates.findOneByOrFail({ id: ids.testing })).runClock).toBe('2026-03-01');
    // The panel reads it off the phase it is a property of, so the control can
    // be drawn without a second request.
    expect((await service.phaseDetail(learner, ids.testing)).runClock).toBe('2026-03-01');
  });

  it('clears back to the machine’s clock', async () => {
    const ids = await enrol();
    await service.setRunClock(learner, ids.testing, '2026-03-01');

    for (const empty of [null, undefined, '']) {
      await service.setRunClock(learner, ids.testing, '2026-03-01');
      const saved = await service.setRunClock(learner, ids.testing, empty);
      expect(saved).toEqual({ saved: true, runClock: null });
      expect((await phaseStates.findOneByOrFail({ id: ids.testing })).runClock).toBeNull();
    }
  });

  it('refuses a phase whose check is not a suite, and says which phase it belongs to', async () => {
    const ids = await enrol();

    await expect(service.setRunClock(learner, ids.requirements, '2026-03-01')).rejects.toThrow(
      'the run clock belongs to the testing phase',
    );
    await expect(service.setRunClock(learner, ids.implementation, '2026-03-01')).rejects.toThrow(
      BadRequestException,
    );
    expect((await phaseStates.findOneByOrFail({ id: ids.requirements })).runClock).toBeNull();
  });

  it('refuses anything that is not a date, with one sentence', async () => {
    const ids = await enrol();

    for (const bad of ['1 March 2026', '2026-3-1', '2026-13-01', '2026-02-31', '1969-12-31', '2101-01-01']) {
      await expect(service.setRunClock(learner, ids.testing, bad)).rejects.toThrow(RUN_CLOCK_MESSAGE);
    }
    expect((await phaseStates.findOneByOrFail({ id: ids.testing })).runClock).toBeNull();
  });

  it('writes the one column, and never the row', async () => {
    const ids = await enrol();
    await phaseStates.update(ids.testing, {
      workspace: { 'tests/test_acceptance.py': '# the learner is typing' },
    });
    const update = jest.spyOn(phaseStates, 'update');
    const save = jest.spyOn(phaseStates, 'save');

    await service.setRunClock(learner, ids.testing, '2026-03-01');

    // The entity was read before this request did its work, and the
    // autosave fires every 700 ms while the learner types.
    expect(save).not.toHaveBeenCalled();
    const patches = update.mock.calls.map((call) => call[1]);
    expect(patches).toEqual([{ runClock: '2026-03-01' }]);
    expect((await phaseStates.findOneByOrFail({ id: ids.testing })).workspace).toEqual({
      'tests/test_acceptance.py': '# the learner is typing',
    });
    update.mockRestore();
    save.mockRestore();
  });

  it('is not somebody else’s to set', async () => {
    const ids = await enrol();

    await expect(service.setRunClock('learner-2', ids.testing, '2026-03-01')).rejects.toThrow(
      'not your phase',
    );
    expect((await phaseStates.findOneByOrFail({ id: ids.testing })).runClock).toBeNull();
  });
});
