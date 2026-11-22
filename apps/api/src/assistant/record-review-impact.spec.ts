import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CHANGE_REQUEST_JSON } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import { DirectoryPackSource } from '../content/pack-source';
import { soleTaskFor } from '../content/pack-compiler';
import { changeFloorOf, recordWorkspaceForReview } from '../feedback/record-report';
import { CHANGE_REQUEST_RECORD } from '../../test/fixtures/records-worked';
import { uploadPack } from '../../test/fixtures/paths';
import { AUTHORED_REVIEW_SYSTEM_PROMPT, composeReviewMessages } from './openai.provider';
import { TEACHER_BRIEF_CLOSE, TEACHER_BRIEF_OPEN } from './fence-markers';
import { authoredTaskScope } from './project-scope';
import { changeImpactFact } from './record-review-scope';

/*
 * What the Maintenance reviewer is handed about a change request's impact. A
 * record with two files in its impact and no operation or screen meets the
 * floor (at least 1 operation, screen or file), yet the platform's own words
 * name the three lists with "and" and leave the OR to the teacher's fenced
 * floor, so a reviewer may advise that no impact entry was populated. These pin
 * the evidence block and the one trusted line that states the floor as
 * counted, and that TaskTrackr's worked change request (all three lists
 * filled) is composed byte for byte without that line.
 *
 * Pure: no database, no AI, no server. The Deadline badge pack is the
 * uploaded-project fixture under test/fixtures/upload-packs/deadline-badge.
 */

const REPO = path.join(__dirname, '..', '..', '..', '..');
const TASKTRACKR = path.join(REPO, 'content', 'tasktrackr');
const DEADLINE_PACK = uploadPack('deadline-badge');
const DUMP = process.env.IMPACT_SPEC_DUMP;

const FILES_ONLY_RECORD = JSON.stringify({
  impact: { operations: [], screens: [], files: ['web/src/lib/overdue.ts', 'web/src/lib/overdue.test.ts'] },
  contract: [],
  tests: [{ id: 'T1', suite: 'overdue regression tests', covers: ['AC-1', 'AC-2'], result: 'pass' }],
  release: {
    version: '1.1.0',
    summary: 'Completed tasks no longer show overdue status.',
    changes: [{ id: 'L1', line: 'isOverdue returns false for a completed task; open tasks keep the date rule.', covers: ['AC-1', 'AC-2'] }],
    rollback: 'Revert the overdue logic and regression test changes.',
    risks: [],
  },
  notes: '',
}, null, 2);

/** The reviewer's two messages for `record`, built as the grader builds them: the editable files, the record as fields, the floor's checks. */
function compose(phase: PhaseContent, code: Record<string, string>, record: string, options: { authored?: boolean } = {}) {
  const files = { ...code, [CHANGE_REQUEST_JSON]: record };
  const workspace = recordWorkspaceForReview(phase.checks, files, files)!;
  const checks = changeFloorOf(phase.checks as never, files, phase.rubric)!.checks;
  const task = soleTaskFor(phase);
  const scope = options.authored ? { scope: authoredTaskScope(phase, task, [task]) } : {};
  const [system, user] = composeReviewMessages(phase, { workspace, criteria: [], checks, overall: 0, hints: 0, ranBeforeSubmit: true, task, phaseTasks: [task], ...scope } as never);
  return { workspace, checks, system: system.content, user: user.content };
}

function dump(name: string, text: string): void {
  if (DUMP) fs.writeFileSync(path.join(DUMP, name), text);
}

const maintenanceOf = (root: string): PhaseContent => new ContentService().loadProject(new DirectoryPackSource(root)).phases.find((p) => p.key === 'maintenance')!;
const EMPTY_LINE = "Its operations and screens lists are empty and its files list is not (change/impact/files); an empty list is not by itself a fault when the floor is met.";
const CLOSING = 'Whether the impact truthfully describes the submitted change still requires your review against the rubric, the brief and the ticket.';
const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

describe('the Maintenance reviewer reads a files-only impact (Deadline badge)', () => {
  const code = (phase: PhaseContent) => Object.fromEntries(phase.files.filter((f) => f.path.startsWith('web/src/lib/overdue')).map((f) => [f.path, f.content]));

  it('hands over both files under change/impact/files and the empty lists as empty fields', () => {
    const phase = maintenanceOf(DEADLINE_PACK);
    const { workspace, checks, user } = compose(phase, code(phase), FILES_ONLY_RECORD);
    dump('files-only-user.txt', user);
    expect(workspace['change/impact/files']).toBe('web/src/lib/overdue.ts\nweb/src/lib/overdue.test.ts');
    expect(workspace['change/impact/operations']).toBe('');
    expect(workspace['change/impact/screens']).toBe('');
    expect(user).toContain('"change/impact/operations":"","change/impact/screens":"","change/impact/files":"web/src/lib/overdue.ts\\nweb/src/lib/overdue.test.ts"');
    expect(checks.find((c) => c.id === 'change.impact.min')).toMatchObject({ status: 'passed', detail: '2 entries named in the impact' });
  });

  it('states the floor as the server counts it, in the platform words, once', () => {
    const phase = maintenanceOf(DEADLINE_PACK);
    const { system } = compose(phase, code(phase), FILES_ONLY_RECORD);
    dump('files-only-system.txt', system);
    expect(system).toContain('"floor":"at least 1 operation, screen or file in the impact;');
    expect(system.split('Trusted Maintenance impact fact:').length).toBe(2);
    expect(system).toContain(EMPTY_LINE);
    // The fact names lists and the check, never a learner's words.
    const fact = system.slice(system.indexOf('Trusted Maintenance impact fact:')).split('\n')[0];
    expect(fact).not.toContain('overdue');
  });
});

describe("TaskTrackr's reviewer text", () => {
  const phase = maintenanceOf(TASKTRACKR);
  const code = { 'api/repository/comments.py': 'def list_comments(task_id):\n    return []\n' };

  it('carries no impact fact for the worked change request (all three lists filled)', () => {
    const { workspace, system, user } = compose(phase, code, CHANGE_REQUEST_RECORD);
    dump('tasktrackr-system.txt', system);
    dump('tasktrackr-user.txt', user);
    expect(workspace['change/impact/operations']).toBe('listComments\naddComment');
    expect(workspace['change/impact/screens']).toBe('#/lists/{id}');
    expect(system).not.toContain('impact fact');
    // The recorded bytes for the worked record (whole messages, content from content/tasktrackr).
    expect(sha12(system)).toBe('8497c648f9f2');
    expect(sha12(user)).toBe('c764efdd6c04');
  });

  it('carries the fact when a TaskTrackr learner meets the floor with files only', () => {
    const record = JSON.parse(CHANGE_REQUEST_RECORD);
    record.impact.operations = [];
    record.impact.screens = [];
    expect(compose(phase, code, JSON.stringify(record)).system).toContain(EMPTY_LINE);
  });

  it('carries the fact once, after the teacher brief, through the uploaded-project composer', () => {
    const record = JSON.parse(CHANGE_REQUEST_RECORD);
    record.impact.operations = [];
    record.impact.screens = [];
    const { system } = compose(phase, code, JSON.stringify(record), { authored: true });
    expect(system.startsWith(AUTHORED_REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(system.split('Trusted Maintenance impact fact:').length).toBe(2);
    expect(system).toContain(`${EMPTY_LINE} ${CLOSING}`);
    // After the scope's fenced ticket and floor closes, and outside every fence.
    const at = system.indexOf('Trusted Maintenance impact fact:');
    const before = system.slice(0, at);
    expect(before.indexOf(TEACHER_BRIEF_CLOSE)).toBeGreaterThan(-1);
    expect(before.split(TEACHER_BRIEF_OPEN).length).toBe(before.split(TEACHER_BRIEF_CLOSE).length);
  });
});

describe('changeImpactFact', () => {
  const phase = maintenanceOf(TASKTRACKR);
  const passed = [{ id: 'change.impact.min', status: 'passed' }];
  const ws = (operations: string, screens: string, files: string) => ({ 'change/impact/operations': operations, 'change/impact/screens': screens, 'change/impact/files': files });

  it('is silent when the floor check did not pass, when every list is filled, and when every list is empty', () => {
    expect(changeImpactFact(phase, ws('', '', 'a.py'), [{ id: 'change.impact.min', status: 'failed' }])).toBe('');
    expect(changeImpactFact(phase, ws('', '', 'a.py'), [])).toBe('');
    expect(changeImpactFact(phase, ws('op', '#/s', 'a.py'), passed)).toBe('');
    expect(changeImpactFact(phase, ws('', '', ''), passed)).toBe('');
    expect(changeImpactFact(phase, undefined, passed)).toBe('');
    const change = (phase.checks as any).change;
    const noFloor = { ...phase, checks: { ...phase.checks, change: { ...change, floor: { ...change.floor, minImpact: 0 } } } } as PhaseContent;
    expect(changeImpactFact(noFloor, ws('', '', 'a.py'), passed)).toBe('');
  });

  it('names one empty list in the singular and treats a blank entry as empty', () => {
    expect(changeImpactFact(phase, ws('op', ' \n', 'a.py'), passed)).toContain(`Its screens list is empty and its operations and files lists are not (change/impact/operations, change/impact/files); an empty list is not by itself a fault when the floor is met. ${CLOSING}`);
  });

  it('is silent outside a change phase', () => {
    const deployment = new ContentService().loadProject(new DirectoryPackSource(TASKTRACKR)).phases.find((p) => p.key === 'deployment')!;
    expect(changeImpactFact(deployment, ws('', '', 'a.py'), passed)).toBe('');
  });
});
