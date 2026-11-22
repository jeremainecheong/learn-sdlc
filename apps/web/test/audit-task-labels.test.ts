/**
 * The three per-task levers, read back off the trail.
 *
 * The per-task levers write `task.signoff`, `task.reset` and
 * `task.reopen` (`packages/shared/src/contract/feedback.ts`, the tail of
 * `AuditEventView['event']`). Each moves a gate, so each has to read as a
 * sentence in the teacher's record of changes rather than as the machine name
 * `describeAudit` falls back to, and the copy lint cannot catch that, because
 * the fallback string comes from the row rather than from a literal.
 *
 * Two writers reach these rows and they do not agree on `detail`:
 *
 *  - the lever itself (`instructor.service.ts`'s `recordAudit`) writes
 *    `phaseKey`, `taskKey` and `taskTitle`;
 *  - a cohort import that restores a countersignature
 *    (`portability.service.ts`) writes one `task.signoff` per learner with
 *    `detail.tasks` and no phase and no task key at all.
 *
 * Both have to render, so both are asserted here.
 */
import { describe, expect, it } from 'vitest';
import type { AuditEventView } from '@learnsdlc/shared';
import { describeAudit } from '@/components/staff/AuditList';

const row = (over: Partial<AuditEventView> = {}): AuditEventView => ({
  id: 'audit-one',
  event: 'task.signoff',
  actorUserId: 'teacher-a',
  actorName: 'Teacher A',
  subjectUserId: 'learner-a',
  subjectName: 'Learner A',
  targetId: 'phase-state-one',
  action: 'task-signoff',
  reason: 'Countersigned after reading the interview transcript with them.',
  detail: {
    projectSlug: 'payroll',
    phaseKey: 'requirements',
    taskKey: 'story',
    taskTitle: 'Write the user story',
  },
  createdAt: '2026-09-18T09:00:00.000Z',
  ...over,
});

describe('the three per-task levers on the record of changes', () => {
  it('names the task and the phase a countersignature passed', () => {
    expect(describeAudit(row())).toEqual({
      title: 'Signed off Write the user story in Requirements',
      state: 'pass',
    });
  });

  // The three rows name the phase the same way, so a
  // trail reads "Signed off X in Design", "Reopened X in Design", "Reset X in
  // Design" rather than naming the phase on one lever in three.
  it('names the task a reopen took the pass back off, and its phase', () => {
    const event = row({ event: 'task.reopen', action: 'task-reopen' });
    expect(describeAudit(event)).toEqual({
      title: 'Reopened Write the user story in Requirements',
      state: 'warn',
    });
  });

  it('draws a reset as loudly as a reset phase, and names the task and its phase', () => {
    const event = row({ event: 'task.reset', action: 'task-reset' });
    expect(describeAudit(event)).toEqual({
      title: 'Reset Write the user story in Requirements',
      state: 'fail',
    });
  });

  it('falls back to the task key when the pack gave the task no title', () => {
    const event = row({ detail: { phaseKey: 'design', taskKey: 'contracts' } });
    expect(describeAudit(event).title).toBe('Signed off contracts in Design');
  });

  it('counts the tasks when an import restored the countersignatures', () => {
    // What `portability.service.ts` writes: one row per learner, the tasks in
    // `detail.tasks`, and no phase to name.
    const event = row({
      actorName: 'Operator',
      action: '2 tasks',
      reason: 'The countersignature was restored from a class export.',
      detail: {
        tasks: [
          { ref: 'requirements', taskKey: 'story' },
          { ref: 'design', taskKey: 'contracts' },
        ],
      },
    });
    expect(describeAudit(event)).toEqual({ title: 'Signed off 2 tasks', state: 'pass' });
  });

  it('says a task rather than nothing when the detail is gone', () => {
    const one = describeAudit(row({ detail: null }));
    expect(one.title).toBe('Signed off a task');
    expect(describeAudit(row({ event: 'task.reset', detail: null })).title).toBe('Reset a task');
    expect(describeAudit(row({ event: 'task.reopen', detail: null })).title).toBe('Reopened a task');
  });

  it('never leaves the machine name as the sentence a teacher reads', () => {
    for (const event of ['task.signoff', 'task.reset', 'task.reopen'] as const) {
      expect(describeAudit(row({ event })).title).not.toBe(event);
    }
  });
});

/**
 * The rest of a learner's own trail.
 *
 * `instructorApi.audit(learnerId)` is scoped to `a.subjectUserId = learner.id`
 * (`instructor.service.ts`'s `auditLog`), so the rows a teacher reads
 * beside the evidence are every row *about that learner*, not only the ones
 * a member of staff wrote. Several of them are written by the learner's own
 * requests, and `preview.start` / `preview.stop` are written twice a session,
 * so on an active learner they are most of the newest twenty-five.
 */
describe('a learner’s own rows, on the trail a teacher now reads', () => {
  const mine = (over: Partial<AuditEventView>): AuditEventView =>
    row({
      actorUserId: 'learner-a',
      actorName: 'Learner A',
      action: null,
      reason: null,
      detail: null,
      ...over,
    });

  it('says what a live preview did, rather than preview.start', () => {
    // preview.service.ts writes both with subjectUserId = the learner.
    expect(describeAudit(mine({ event: 'preview.start' }))).toEqual({
      title: 'Started the live preview',
      state: 'now',
    });
    expect(describeAudit(mine({ event: 'preview.stop' }))).toEqual({
      title: 'Stopped the live preview',
      state: 'now',
    });
  });

  it('names the class a learner joined or left', () => {
    // cohorts.service.ts puts the class name in `action` on a join, and 'leave'
    // on a leave, so only one of the two has a name to give.
    expect(describeAudit(mine({ event: 'cohort.join', action: 'Example class' }))).toEqual({
      title: 'Joined Example class',
      state: 'now',
    });
    expect(describeAudit(mine({ event: 'cohort.join' })).title).toBe('Joined a class');
    expect(describeAudit(mine({ event: 'cohort.leave', action: 'leave' }))).toEqual({
      title: 'Left their class',
      state: 'now',
    });
  });

  it('draws a credential change as a change, because that is what it is', () => {
    expect(describeAudit(mine({ event: 'password.change' }))).toEqual({
      title: 'Changed their password',
      state: 'warn',
    });
    expect(describeAudit(mine({ event: 'password.reset' }))).toEqual({
      title: 'Reset their password',
      state: 'warn',
    });
  });

  it('says where an imported account came from', () => {
    expect(describeAudit(mine({ event: 'account.import', actorName: 'Operator' }))).toEqual({
      title: 'Account created by a class import',
      state: 'now',
    });
  });

  it('never prints a machine key as the sentence, whatever the row turns out to be', () => {
    // The default arm. A row this build has no sentence for still has to read
    // as a recorded change, with the key kept where the key belongs.
    const unknown = describeAudit(mine({ event: 'something.new' as AuditEventView['event'] }));
    expect(unknown.title).toBe('A recorded change');
    expect(unknown.state).toBe('warn');
    expect(unknown.unnamed).toBe(true);
  });

  it('leaves no event of the contract without a sentence', () => {
    // The whole union, as `AuditEventView['event']` declares it. Append a
    // member without a case and this is the case that says so.
    const every: AuditEventView['event'][] = [
      'phase.override', 'budget.override', 'budget.default', 'admin.user.update',
      'admin.password.set', 'admin.cohort.owner', 'cohort.create', 'cohort.join',
      'cohort.leave', 'password.change', 'password.reset', 'account.delete',
      'account.claimed', 'regrade.start', 'phase.regrade', 'instructor.view-as',
      'cohort.schedule', 'stuck.answer', 'note.write', 'note.delete', 'cohort.export',
      'cohort.import', 'account.import', 'instructor.note', 'dossier.read',
      'preview.start', 'preview.stop', 'repo.export', 'solution.read',
      'task.signoff', 'task.reset', 'task.reopen',
    ];
    for (const event of every) {
      const said = describeAudit(mine({ event }));
      expect(said.title).not.toBe(event);
      expect(said.unnamed).toBeUndefined();
    }
  });
});
