// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuditEventView } from '@learnsdlc/shared';
import { AUTHORING_AUDIT_EVENTS } from '@learnsdlc/shared';
import { AuditList, describeAudit } from '@/components/staff/AuditList';

/**
 * The labels the record of changes gives a teacher's authoring audit events.
 *
 * A teacher's authoring writes leave audit rows under the names in
 * `AUTHORING_AUDIT_EVENTS`: the project's life (create, update, tasks,
 * validate, publish, archive, draft), the class's assignment, the quiz key and
 * interview reads, and the four element edits (phase intro, interview, file,
 * interview read). A `project.phase` row is also what the Phases card's
 * three doors write, told apart by `detail.change`. A name with no sentence
 * falls to "A recorded change" with the machine key on the detail line.
 * Every name reads as a sentence, and the four that name a thing say which.
 *
 * The last block draws the record of changes a teacher sees, one row per
 * authoring name, and reads the rows.
 */

const row = (event: AuditEventView['event'], over: Partial<AuditEventView> = {}): AuditEventView => ({
  id: `audit-${event.replace(/\W+/g, '-')}`,
  event,
  actorUserId: 'teacher-a',
  actorName: 'Teacher A',
  subjectUserId: 'teacher-a',
  subjectName: 'Teacher A',
  targetId: 'project-one',
  action: null,
  reason: null,
  detail: null,
  createdAt: '2026-09-30T01:00:00.000Z',
  ...over,
});

describe('the authoring rows in the record of changes', () => {
  it.each([...AUTHORING_AUDIT_EVENTS])('%s reads as a sentence, not a recorded change', (event) => {
    const said = describeAudit(row(event));
    expect(said.unnamed).toBeUndefined();
    expect(said.title).not.toBe('A recorded change');
    expect(said.title).not.toContain(event);
  });

  it('names the phase whose introduction was rewritten', () => {
    expect(describeAudit(row('project.phase', { action: 'design', detail: { phaseKey: 'design', length: 120 } })).title).toBe(
      'Rewrote the introduction to Design',
    );
  });

  it('says a Phases card Remove removed the phase, not that its introduction was rewritten', () => {
    const detail = { versionId: 'version-one', phaseKey: 'testing', change: 'removed' };
    expect(describeAudit(row('project.phase', { detail })).title).toBe('Removed Testing from the draft');
    expect(describeAudit(row('project.phase', { detail })).state).toBe('now');
    expect(describeAudit(row('project.phase', { detail: { ...detail, phaseKey: 'unknown' } })).title).toBe('Removed a phase from the draft');
  });

  it('says a Phases card Put back put the phase back in the draft', () => {
    const detail = { versionId: 'version-one', phaseKey: 'design', change: 'restored' };
    expect(describeAudit(row('project.phase', { detail })).title).toBe('Put Design back in the draft');
    expect(describeAudit(row('project.phase', { detail })).state).toBe('now');
    expect(describeAudit(row('project.phase', { detail: { ...detail, phaseKey: null } })).title).toBe('Put a phase back in the draft');
  });

  it('says a Phases card Add added the phase to the draft', () => {
    const detail = { versionId: 'version-one', phaseKey: 'requirements', change: 'added' };
    expect(describeAudit(row('project.phase', { detail })).title).toBe('Added Requirements to the draft');
    expect(describeAudit(row('project.phase', { detail })).state).toBe('now');
    expect(describeAudit(row('project.phase', { detail: { ...detail, phaseKey: 7 } })).title).toBe('Added a phase to the draft');
  });

  it('names the file whose bytes were replaced, and never the bytes', () => {
    const said = describeAudit(
      row('project.files', { action: 'design:docs/notes.md', detail: { phaseKey: 'design', path: 'docs/notes.md', bytes: 512 } }),
    );
    expect(said.title).toBe('Replaced docs/notes.md in Design');
  });

  it('says the stakeholder interview was changed, and that it was read', () => {
    expect(describeAudit(row('project.interview', { detail: { phaseKey: 'requirements' } })).title).toBe(
      'Changed the stakeholder interview',
    );
    const read = describeAudit(row('project.interview-read', { detail: { phaseKey: 'requirements', facts: 6 } }));
    expect(read.title).toBe('Read the stakeholder interview’s answers');
    // A teacher's row about themselves, drawn like the quiz key's.
    expect(read.state).toBe('warn');
  });

  it('names the version published and the project a class was set to', () => {
    expect(describeAudit(row('project.publish', { action: '1.2.0', detail: { version: '1.2.0' } })).title).toBe(
      'Published version 1.2.0',
    );
    expect(describeAudit(row('cohort.project', { detail: { projectTitle: 'Room Desk', version: '1.2.0' } })).title).toBe(
      'Set the class project to Room Desk, version 1.2.0',
    );
  });

  it('says which version the boot moved a learner to, for the story model', () => {
    const said = describeAudit(row('enrolment.repin', { action: 'tasktrackr', detail: { from: '2.0.1', to: '3.0.0', reason: 'requirements story model' } }));
    expect(said.unnamed).toBeUndefined();
    expect(said.title).toBe('Moved from version 2.0.1 to 3.0.0, where the story is written in the story builder');
    expect(describeAudit(row('enrolment.repin')).title).toBe('Moved to the version where the story is written in the story builder');
  });

  it('says the boot left a learner on their version, with the sentence on the detail line', () => {
    const sentence =
      "This learner's version holds Maintenance and the new one does not, so the learner stays on their version, with their work. Learners who start now get the new one.";
    const said = describeAudit(row('enrolment.repin.stranded', { action: 'strand-pack', reason: sentence, detail: { from: '1.0.0', to: '1.1.0', differs: 'maintenance' } }));
    expect(said.unnamed).toBeUndefined();
    expect(said.title).toBe('Left on their version');
  });

  it('says a move off a retired written phase that failed did not move the learner', () => {
    const why = 'the move off the retired written phase failed, so nothing moved';
    const said = describeAudit(row('enrolment.repin', { reason: why, detail: { from: '1.0.0', to: '1.1.0', refused: true, reason: why } }));
    expect(said.title).toBe('Not moved from version 1.0.0 to 1.1.0');
    expect(said.state).toBe('warn');
  });

  it('says which version the boot moved a class to, for the story model', () => {
    const said = describeAudit(row('cohort.project.repin', { action: 'tasktrackr', detail: { from: '2.0.1', to: '3.0.0', reason: 'requirements story model' } }));
    expect(said.unnamed).toBeUndefined();
    expect(said.title).toBe('Moved the class from version 2.0.1 to 3.0.0, where the story is written in the story builder');
    expect(describeAudit(row('cohort.project.repin')).title).toBe('Moved the class to the version where the story is written in the story builder');
  });

  it('keeps the rows it already named as they were', () => {
    expect(describeAudit(row('project.quiz-key', { detail: { taskTitle: 'Concept check' } })).title).toBe(
      'Read the answer key for Concept check',
    );
    expect(describeAudit(row('solution.read')).title).toBe('Read the reference solution');
  });
});

describe('the record of changes, drawn with the authoring rows', () => {
  it('draws every authoring name as its own sentence, never the fallback or the machine key', () => {
    const events = [...AUTHORING_AUDIT_EVENTS].map((event) => row(event));
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<AuditList events={events} title="Record of changes" />);
    const rows = [...host.querySelectorAll('[data-testid="audit-list"] > li')];
    expect(rows).toHaveLength(events.length);
    const unread = rows
      .map((li, n) => [events[n].event, li.textContent ?? ''] as const)
      .filter(([event, text]) => text.includes('A recorded change') || text.includes(event))
      .map(([event]) => event);
    expect(unread).toEqual([]);
  });
});
