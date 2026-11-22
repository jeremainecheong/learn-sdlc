// The per-rule predicate every older-format door reads: which phase a version still holds in an
// older form, which phase is a retired written one, and the room's sentence the API answers with.
import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { CHANGE_OLDER_FORMAT_ROOM, REQUIREMENTS_OLDER_FORMAT_ROOM, RETIRED_WRITTEN_PHASE_ROOM, RUNBOOK_OLDER_FORMAT_ROOM } from '@learnsdlc/shared';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { PhasesController } from '../workflow/phases.controller';
import { WorkflowService } from '../workflow/workflow.service';
import { ContentService } from './content.service';
import { layoutFromManifest } from './legacy-layout';
import { isOlderFormat, isStructured, olderFormatPhase, olderFormatRoomSentence, retiredWrittenPhase } from './phase-grading';

/** TaskTrackr 5.0.0, an older (pointer) pack, converted once as the door converts one: the loader reads only the folder layout. */
const olderTaskTrackr = () => layoutFromManifest(olderTaskTrackrPack()).source;

const snapshot = (phases: { key: string; checks: object }[]) => ({ content: { phases: phases.map((phase, at) => ({ ...phase, order: at + 1 })) } }) as never;
describe('the per-rule predicate', () => {
  it.each([
    ['requirements', { kind: 'markdown' }, true], ['requirements', { kind: 'story' }, false],
    ['design', { kind: 'markdown' }, true], ['design', { kind: 'design' }, false],
    ['deployment', { kind: 'config' }, true], ['deployment', { kind: 'config', runbook: {} }, false], ['deployment', { kind: 'tests' }, false],
    ['maintenance', { kind: 'code' }, true], ['maintenance', { kind: 'code', change: {} }, false], ['maintenance', { kind: 'config' }, false],
  ])('reads %s %j as older: %s', (key, checks, older) => {
    expect(isOlderFormat(key as never, checks)).toBe(older);
  });
  it('reads the structured forms', () => {
    expect(isStructured('deployment', { kind: 'config', runbook: {} })).toBe(true);
    expect(isStructured('maintenance', { kind: 'code' })).toBe(false);
    expect(isStructured('requirements', { kind: 'story' })).toBe(true);
    expect(isStructured('design', { kind: 'markdown' })).toBe(false);
  });
  it('names the first older phase in order, and the first retired written phase', () => {
    const v400 = snapshot([{ key: 'requirements', checks: { kind: 'story' } }, { key: 'deployment', checks: { kind: 'config' } }, { key: 'maintenance', checks: { kind: 'code' } }]);
    expect(olderFormatPhase(v400)).toBe('deployment');
    expect(retiredWrittenPhase(snapshot([{ key: 'requirements', checks: { kind: 'markdown' } }, { key: 'testing', checks: { kind: 'markdown' } }]))).toBe('testing');
    expect(retiredWrittenPhase(v400)).toBeNull();
    expect(olderFormatPhase(null)).toBeNull();
  });
  it('answers the room\'s sentence for an older or retired phase, and null otherwise', () => {
    expect(olderFormatRoomSentence({ key: 'deployment', checks: { kind: 'config' } } as never)).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
    expect(olderFormatRoomSentence({ key: 'maintenance', checks: { kind: 'code' } } as never)).toBe(CHANGE_OLDER_FORMAT_ROOM);
    expect(olderFormatRoomSentence({ key: 'testing', checks: { kind: 'markdown' } } as never)).toBe(RETIRED_WRITTEN_PHASE_ROOM);
    expect(olderFormatRoomSentence({ key: 'requirements', checks: { kind: 'markdown' } } as never)).toBe(REQUIREMENTS_OLDER_FORMAT_ROOM);
    expect(olderFormatRoomSentence({ key: 'deployment', checks: { kind: 'config', runbook: {} } } as never)).toBeNull();
    expect(olderFormatRoomSentence({ key: 'implementation', checks: { kind: 'code' } } as never)).toBeNull();
  });
});

describe('the run door', () => {
  it('answers 409 with the room\'s sentence for a run of a phase its pinned version holds in the older format, and runs nothing', async () => {
    const phase = new ContentService().loadProject(olderTaskTrackr()).phases.find((one) => one.key === 'deployment')!;
    const workflow = { loadOwnedState: jest.fn(async () => ({ state: { id: 'ps-1' }, phase })) };
    const execution = { runPhase: jest.fn() };
    const controller = new PhasesController(workflow as never, execution as never, {} as never, {} as never, {} as never);
    await expect(controller.run({ id: 'u-1' } as never, 'ps-1')).rejects.toThrow(new ConflictException(RUNBOOK_OLDER_FORMAT_ROOM));
    expect(execution.runPhase).not.toHaveBeenCalled();
  });
});

describe('the drill\'s resolve door', () => {
  it('answers 409 with the room\'s sentence for a resolve in an older-format Deployment, before the smoke run or any write', async () => {
    const content = new ContentService();
    const phase = content.loadProject(olderTaskTrackr()).phases.find((one) => one.key === 'deployment')!;
    expect(content.drillSpec(phase)).not.toBeNull();
    const phaseStates = { update: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn() };
    const feedback = { runSmokeCheck: jest.fn() };
    const service = new WorkflowService({} as never, phaseStates as never, {} as never, content, feedback as never, {} as never);
    const drill = { pagedAt: '2026-10-01T00:00:00.000Z', fixAppliedAt: '2026-10-01T00:05:00.000Z', resolvedAt: null };
    jest.spyOn(service, 'loadOwnedState').mockResolvedValue({ state: { id: 'ps-1', drill, workspace: null }, phase } as never);
    const incident = { rootCause: 'API_URL named localhost.', fix: 'API_URL names the api service.', actionItem: 'Lint compose in CI.' };
    await expect(service.drillResolve('u-1', 'ps-1', incident)).rejects.toThrow(new ConflictException(RUNBOOK_OLDER_FORMAT_ROOM));
    expect(feedback.runSmokeCheck).not.toHaveBeenCalled();
    expect(phaseStates.update).not.toHaveBeenCalled();
    expect(phaseStates.createQueryBuilder).not.toHaveBeenCalled();
  });
});
