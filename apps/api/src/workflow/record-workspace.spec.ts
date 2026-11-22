import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import {
  CHANGE_REQUEST_JSON, DRILL_TIMELINE_EVENTS, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, RUNBOOK_JSON, RUNBOOK_RESOLVE_CONFLICT, RUNBOOK_RESOLVE_INVALID,
  evaluateRunbookFloor, runbookSaveRefusal, serialiseChangeRequest, serialiseRunbook, validateRunbookRecord, type ChangeRequest, type DrillState,
  type Runbook,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, ReleaseRecordEntity } from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { RECORD_CHANGE_FLOOR, RECORD_RUNBOOK_FLOOR, RECORD_TICKET, recordPack, useRecordPack } from '../../test/record-pack';
import { refuseInvalidRecord } from './record-guard';
import { WorkflowService } from './workflow.service';

// `drillWithIncident`'s own rows (the record, the blank record, no record, no
// runbook graded, a null drill, an invalid record) are in drill-incident.spec.ts.

const runbook: Runbook = { ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }] };
const withIncident = (r: Runbook, rootCause: string): Runbook => ({ ...r, incident: { rootCause, fix: 'f', actionItem: 'a' } });
const change: ChangeRequest = { ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 'tests/test_comments.py', covers: ['AC-1'], result: 'not-run' }] };
const smoke = (ok: boolean) => ({ ok, stdout: '', stderr: ok ? '' : 'boom', argv: ['python3', 'api/main.py'], durationMs: 1 });

describe('refuseInvalidRecord', () => {
  const content = new ContentService();
  const project = useRecordPack(content);
  const deployment = project.phases.find((p) => p.key === 'deployment')!.checks;
  const maintenance = project.phases.find((p) => p.key === 'maintenance')!.checks;
  it('stores the runbook as validated and drops unknown keys', () => {
    expect(refuseInvalidRecord(RUNBOOK_JSON, JSON.stringify({ ...runbook, padding: 'x' }), deployment, undefined)).toBe(serialiseRunbook(runbook));
  });
  it('refuses a malformed runbook with the fixed sentence', () => {
    expect(() => refuseInvalidRecord(RUNBOOK_JSON, '{', deployment, undefined)).toThrow(new BadRequestException('The runbook was not saved: The runbook record is not valid JSON.'));
  });
  it('keeps the stored incident in a drill phase whatever the save sends', () => {
    const stored = serialiseRunbook(withIncident(runbook, 'API_URL named localhost'));
    const sent = JSON.stringify(withIncident(runbook, 'something else'));
    expect(validateRunbookRecord(refuseInvalidRecord(RUNBOOK_JSON, sent, deployment, stored)).runbook!.incident.rootCause).toBe('API_URL named localhost');
    expect(validateRunbookRecord(refuseInvalidRecord(RUNBOOK_JSON, sent, deployment, undefined)).runbook!.incident).toEqual(EMPTY_RUNBOOK.incident);
  });
  it('refuses a covers id outside the ticket, quoting at most 16 characters of it', () => {
    const stray = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 's', covers: ['AC-404'], result: 'not-run' }] });
    expect(() => refuseInvalidRecord(CHANGE_REQUEST_JSON, stray, maintenance, undefined)).toThrow('The change request was not saved: test T1 covers AC-404, which is not an acceptance item of the ticket.');
    expect(() => refuseInvalidRecord(CHANGE_REQUEST_JSON, stray.replace('AC-404', 'A'.repeat(40)), maintenance, undefined)).toThrow('covers item 1 is not text of at most 16 characters');
  });
  it('stores the change request as validated, in its canonical bytes, and drops unknown keys', () => {
    expect(refuseInvalidRecord(CHANGE_REQUEST_JSON, JSON.stringify({ ...change, padding: 'x' }), maintenance, undefined)).toBe(serialiseChangeRequest(change));
    expect(refuseInvalidRecord(CHANGE_REQUEST_JSON, JSON.stringify(change), maintenance, undefined)).toBe(serialiseChangeRequest(change));
  });
  it('passes every other path through', () => {
    expect(refuseInvalidRecord('api/Dockerfile', '{', deployment, undefined)).toBe('{');
  });
  it('keeps the incident a save sends in a phase without a drill', () => {
    const noDrill = new ContentService().loadProject(recordPack({ deployment: (s) => { delete s.checks.drill; }, drop: (name) => name.startsWith('phases/05-deployment/drill/') })).phases.find((p) => p.key === 'deployment')!.checks;
    const sent = serialiseRunbook(withIncident(runbook, 'written in the tab'));
    expect(validateRunbookRecord(refuseInvalidRecord(RUNBOOK_JSON, sent, noDrill, serialiseRunbook(runbook))).runbook!.incident.rootCause).toBe('written in the tab');
  });
});

describe('a learner on Deployment and Maintenance with records', () => {
  let dataSource: DataSource;
  let phaseStates: Repository<PhaseStateEntity>;
  let content: ContentService;
  let service: WorkflowService;
  let runSmokeCheck: jest.Mock;
  let ids: Record<string, string>;
  const learner = 'learner-1';
  const INCIDENT = { rootCause: 'API_URL named localhost inside the network.', fix: 'API_URL is now http://api:8000 in compose.', actionItem: 'Lint the compose file in CI before a release.' };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    useRecordPack(content);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
  });
  afterAll(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    runSmokeCheck = jest.fn(async () => smoke(true));
    const feedback = { latestFor: async () => null, runSmokeCheck } as unknown as FeedbackService;
    service = new WorkflowService(dataSource.getRepository(EnrollmentEntity), phaseStates, dataSource.getRepository(ReleaseRecordEntity), content, feedback, dataSource);
    const view = await service.enroll(learner, 'tasktrackr');
    ids = Object.fromEntries(view.phases.map((p) => [p.key, p.id]));
    for (const key of ['deployment', 'maintenance']) await phaseStates.update({ id: ids[key] }, { status: 'in_progress' });
  });
  /** Paged (red), then a green health check: the state a resolve needs. */
  const ready = async () => {
    runSmokeCheck.mockResolvedValueOnce(smoke(false));
    await service.drillStart(learner, ids.deployment);
    await service.drillHealth(learner, ids.deployment);
  };

  it('hands the rooms the runbook floor and the ticket', async () => {
    expect((await service.phaseDetail(learner, ids.deployment)).runbook).toEqual({ floor: { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true }, drill: true });
    expect((await service.phaseDetail(learner, ids.maintenance)).change).toEqual({ ticket: RECORD_TICKET, contract: true, floor: RECORD_CHANGE_FLOOR });
  });
  it('stores a Maintenance save of the change request as validated, and refuses one that covers no ticket item', async () => {
    await service.saveWorkspace(learner, ids.maintenance, { [CHANGE_REQUEST_JSON]: JSON.stringify({ ...change, padding: 'x' }) });
    const saved = await phaseStates.findOneByOrFail({ id: ids.maintenance });
    expect(saved.workspace![CHANGE_REQUEST_JSON]).toBe(serialiseChangeRequest(change));
    const stray = JSON.stringify({ ...change, tests: [{ ...change.tests[0], covers: ['AC-404'] }] });
    await expect(service.saveWorkspace(learner, ids.maintenance, { [CHANGE_REQUEST_JSON]: stray })).rejects.toThrow(
      new BadRequestException('The change request was not saved: test T1 covers AC-404, which is not an acceptance item of the ticket.'),
    );
    const after = await phaseStates.findOneByOrFail({ id: ids.maintenance });
    expect(after.workspace![CHANGE_REQUEST_JSON]).toBe(serialiseChangeRequest(change));
    expect(after.workspaceUpdatedAt).toBe(saved.workspaceUpdatedAt);
  });
  it('keeps the stored incident when a save in a drill phase sends another', async () => {
    await ready();
    await service.drillResolve(learner, ids.deployment, INCIDENT);
    await service.saveWorkspace(learner, ids.deployment, { [RUNBOOK_JSON]: JSON.stringify(withIncident(runbook, 'rewritten by hand')) });
    const detail = await service.phaseDetail(learner, ids.deployment);
    expect(detail.drill?.incident?.rootCause).toBe(INCIDENT.rootCause);
  });
  it('pages with no runbook text kept', async () => {
    runSmokeCheck.mockResolvedValueOnce(smoke(false));
    expect((await service.drillStart(learner, ids.deployment)).runbookBefore).toBeNull();
  });
  it('closes the incident into the record with the three timeline lines, and answers the new save stamp', async () => {
    await ready();
    const closed = await service.drillResolve(learner, ids.deployment, INCIDENT);
    const state = await phaseStates.findOneByOrFail({ id: ids.deployment });
    const record = validateRunbookRecord(state.workspace![RUNBOOK_JSON]).runbook!;
    expect(record.incident).toMatchObject(INCIDENT);
    expect(record.incident.timeline!.map((t) => t.event)).toEqual([DRILL_TIMELINE_EVENTS.paged, DRILL_TIMELINE_EVENTS.fixed, DRILL_TIMELINE_EVENTS.closed]);
    const drill = state.drill as DrillState;
    expect(record.incident.timeline!.map((t) => t.at)).toEqual([drill.pagedAt, drill.fixAppliedAt, drill.resolvedAt]);
    expect(closed.workspaceUpdatedAt).toBe(state.workspaceUpdatedAt);
    expect(closed.incident).toEqual({ rootCause: INCIDENT.rootCause, fix: INCIDENT.fix, actionItem: INCIDENT.actionItem });
    expect((state.drill as { incident: unknown }).incident).toBeNull();
  });
  it('writes the incident into the record of a learner who never saved the runbook, so the floor and the diagnosis read one incident', async () => {
    await ready();
    expect((await phaseStates.findOneByOrFail({ id: ids.deployment })).workspace?.[RUNBOOK_JSON]).toBeUndefined();
    await service.drillResolve(learner, ids.deployment, INCIDENT);
    const text = (await phaseStates.findOneByOrFail({ id: ids.deployment })).workspace![RUNBOOK_JSON];
    expect(validateRunbookRecord(text).runbook!.incident).toMatchObject(INCIDENT);
    expect(evaluateRunbookFloor(text, RECORD_RUNBOOK_FLOOR).find((one) => one.id === 'runbook.incident')!.passed).toBe(true);
    expect((await service.phaseDetail(learner, ids.deployment)).drill?.incident).toEqual(INCIDENT);
  });
  it('a second resolve replaces the incident and its timeline', async () => {
    await ready();
    await service.drillResolve(learner, ids.deployment, INCIDENT);
    const again = { ...INCIDENT, rootCause: 'API_URL pointed at localhost, not at the api service.' };
    await service.drillResolve(learner, ids.deployment, again);
    const state = await phaseStates.findOneByOrFail({ id: ids.deployment });
    const record = validateRunbookRecord(state.workspace![RUNBOOK_JSON]).runbook!;
    expect(record.incident.rootCause).toBe(again.rootCause);
    expect(record.incident.timeline!.map((t) => t.event)).toEqual([DRILL_TIMELINE_EVENTS.paged, DRILL_TIMELINE_EVENTS.fixed, DRILL_TIMELINE_EVENTS.closed]);
    const drill = state.drill as DrillState;
    expect(record.incident.timeline!.map((t) => t.at)).toEqual([drill.pagedAt, drill.fixAppliedAt, drill.resolvedAt]);
  });
  it('loses the compare-and-swap to a save that landed in between, and writes nothing', async () => {
    await ready();
    runSmokeCheck.mockImplementationOnce(async () => {
      await service.saveWorkspace(learner, ids.deployment, { [RUNBOOK_JSON]: serialiseRunbook(runbook) });
      return smoke(true);
    });
    await expect(service.drillResolve(learner, ids.deployment, INCIDENT)).rejects.toThrow(new ConflictException(RUNBOOK_RESOLVE_CONFLICT));
    const state = await phaseStates.findOneByOrFail({ id: ids.deployment });
    expect((state.drill as { resolvedAt: string | null }).resolvedAt).toBeNull();
    expect(validateRunbookRecord(state.workspace![RUNBOOK_JSON]).runbook!.incident).toEqual(EMPTY_RUNBOOK.incident);
  });
  it('refuses a save with the stamp from before the resolve', async () => {
    await ready();
    const before = (await phaseStates.findOneByOrFail({ id: ids.deployment })).workspaceUpdatedAt ?? null;
    await service.drillResolve(learner, ids.deployment, INCIDENT);
    const refused = await service.saveWorkspace(learner, ids.deployment, { [RUNBOOK_JSON]: serialiseRunbook(runbook) }, before).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as HttpException).getResponse()).toMatchObject({ error: 'workspace_changed' });
  });
  it('refuses to close the incident over a stored runbook that does not validate', async () => {
    await ready();
    await phaseStates.update({ id: ids.deployment }, { workspace: { [RUNBOOK_JSON]: '{ torn' } });
    const before = await phaseStates.findOneByOrFail({ id: ids.deployment });
    const runs = runSmokeCheck.mock.calls.length;
    await expect(service.drillResolve(learner, ids.deployment, INCIDENT)).rejects.toThrow(new BadRequestException(RUNBOOK_RESOLVE_INVALID));
    // Refused before the sandbox: an invalid stored record costs no smoke run.
    expect(runSmokeCheck.mock.calls.length).toBe(runs);
    const after = await phaseStates.findOneByOrFail({ id: ids.deployment });
    expect(after.workspace).toEqual({ [RUNBOOK_JSON]: '{ torn' });
    expect(after.workspaceUpdatedAt).toBe(before.workspaceUpdatedAt);
    expect((after.drill as DrillState).resolvedAt).toBeNull();
  });
  it('refuses a write-up the record could not hold (2001 UTF-16 code units in 1999 characters), and writes nothing', async () => {
    await ready();
    const before = await phaseStates.findOneByOrFail({ id: ids.deployment });
    const rootCause = `${'a'.repeat(1997)}\u{1F525}\u{1F525}`;
    expect([...rootCause]).toHaveLength(1999);
    await expect(service.drillResolve(learner, ids.deployment, { ...INCIDENT, rootCause })).rejects.toThrow(
      new BadRequestException(runbookSaveRefusal('incident rootCause is longer than 2000 characters')),
    );
    const after = await phaseStates.findOneByOrFail({ id: ids.deployment });
    expect(after.workspace?.[RUNBOOK_JSON]).toBeUndefined();
    expect(after.workspaceUpdatedAt).toBe(before.workspaceUpdatedAt);
    expect((after.drill as DrillState).resolvedAt).toBeNull();
  });
});
