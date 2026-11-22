import { CHANGE_REQUEST_JSON, RUNBOOK_JSON } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { soleTaskFor } from '../content/pack-compiler';
import { recordPack } from '../../test/record-pack';
import { TEACHER_BRIEF_OPEN, citableSourcePaths, composeReviewMessages } from './openai.provider';
import { authoredInterfaceLines } from './project-scope';
import { CHANGE_ROOM_TEXT, RUNBOOK_ROOM_TEXT, recordReviewScope } from './record-review-scope';

const project = new ContentService().loadProject(recordPack());
const deployment = project.phases.find((p) => p.key === 'deployment')!;
const maintenance = project.phases.find((p) => p.key === 'maintenance')!;
const input = (phase: typeof deployment, workspace: Record<string, string>) => {
  const task = soleTaskFor(phase);
  return { workspace, criteria: [], checks: [], overall: 0, hints: 0, ranBeforeSubmit: false, task, phaseTasks: [task] } as never;
};

describe('the review of a runbook', () => {
  it('cites the editable files and the record fields, never the record file', () => {
    const workspace = { 'api/Dockerfile': 'FROM python', [RUNBOOK_JSON]: '{}', 'runbook/env-1/name': 'E1: TASKTRACKR_DB', 'runbook/notes': '' };
    expect(citableSourcePaths(input(deployment, workspace), deployment)).toEqual(['api/Dockerfile', 'runbook/env-1/name']);
  });
  it('tells the reviewer the Runbook tab and fences the floor', () => {
    const system = composeReviewMessages(deployment, input(deployment, {}))[0].content;
    expect(system).toContain(RUNBOOK_ROOM_TEXT(true));
    expect(recordReviewScope(deployment)).toContain(TEACHER_BRIEF_OPEN);
    expect(system).toContain(`${RUNBOOK_ROOM_TEXT(true)}\n${recordReviewScope(deployment)}`);
    expect(system).toContain('[check:runbook.incident]');
  });
});

describe('the review of a change request', () => {
  it('cites the change paths and fences the ticket', () => {
    const workspace = { 'api/repository/comments.py': 'def x(): pass', [CHANGE_REQUEST_JSON]: '{}', 'change/impact/operations': 'listComments' };
    expect(citableSourcePaths(input(maintenance, workspace), maintenance)).toEqual(['api/repository/comments.py', 'change/impact/operations']);
    const scope = recordReviewScope(maintenance);
    expect(scope).toContain('CR-2');
    expect(scope.indexOf('CR-2')).toBeGreaterThan(scope.indexOf(TEACHER_BRIEF_OPEN));
    expect(composeReviewMessages(maintenance, input(maintenance, {}))[0].content).toContain(`${CHANGE_ROOM_TEXT(true)}\n${scope}`);
  });
  it('names every change floor rule as a structural check fact', () => {
    const system = composeReviewMessages(maintenance, input(maintenance, {}))[0].content;
    expect(system).toContain('[check:change.trace]');
    expect(system).toContain('[check:change.contract.min]');
  });
  it('supplies a read-only file the ticket names, though the brief does not', () => {
    const named = new ContentService().loadProject(recordPack({ maintenance: (s) => {
      s.taskPanel = 'Record the change in the change request.';
      s.checks.ticket = { ...s.checks.ticket, acceptance: [...s.checks.ticket.acceptance, { id: 'AC-9', line: 'The schema in api/schema.sql gains no column.' }] };
    } })).phases.find((p) => p.key === 'maintenance')!;
    const system = composeReviewMessages(named, input(named, {}))[0].content;
    expect(system).toContain('SERVER-SUPPLIED MAINTENANCE BASELINE');
    expect(system).toContain('"path":"api/schema.sql"');
  });
});

describe('the room lines of an authored record phase', () => {
  it('tells an authored Deployment and Maintenance reviewer both places the task is worked', () => {
    expect(authoredInterfaceLines('deployment', [soleTaskFor(deployment)], deployment.checks)[0]).toContain("its runbook in the Runbook tab's forms");
    expect(authoredInterfaceLines('maintenance', [soleTaskFor(maintenance)], maintenance.checks)[0]).toContain("its change request in the change room's tabs");
  });
});
