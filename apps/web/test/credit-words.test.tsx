// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrollmentView, LearnerDossier, PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import { creditLabel, creditState, revisionPassIsCurrent, type CreditTask, type WithPassKind } from '@/lib/pass-kind';
import type { PhaseRecords } from '@/lib/records';

/*
 * Two words on a credit.
 * - Where the only thing the gate still wants is the teacher's
 *   countersignature (a phase-wide Mark as passed over a sign-off task whose
 *   review passed), the state is the vocabulary's "Awaiting your teacher's
 *   sign-off", not "Credit awarded, review still needed". The board names the
 *   tasks a credit still wants (`creditTasks`) and which of them wait only on
 *   the countersignature.
 * - "Earlier Pass / review required" is for a pass a reset withdrew. On a
 *   split phase where one task is reviewed and another only credited, the
 *   reviewed task's pass is current and keeps its own word, "Pass".
 */

const CREDIT = 'Credit awarded, review still needed';
const AWAITING = "Awaiting your teacher's sign-off";
const SIGNOFF: CreditTask[] = [{ key: 'scope', awaitsSignOff: true }];
const UNREVIEWED: CreditTask[] = [{ key: 'scope' }];

describe('the state a credit is said in', () => {
  const credit = (creditTasks?: CreditTask[]): WithPassKind => ({ status: 'passed', passKind: 'credit', ...(creditTasks ? { creditTasks } : {}) });

  it('is awaiting only where every task still wanted waits on the countersignature', () => {
    expect(creditState(credit(SIGNOFF))).toBe('awaiting');
    expect(creditLabel(credit(SIGNOFF))).toBe(AWAITING);
    expect(creditState(credit([...SIGNOFF, { key: 'story' }]))).toBe('credited');
    expect(creditLabel(credit(UNREVIEWED))).toBe(CREDIT);
    expect(creditLabel(credit([]))).toBe(CREDIT);
    expect(creditLabel(credit())).toBe(CREDIT);
  });

  it('calls a revision current where its task is not still wanted, or waits only on the countersignature', () => {
    expect(revisionPassIsCurrent(credit(UNREVIEWED), 'story')).toBe(true);
    expect(revisionPassIsCurrent(credit(SIGNOFF), 'scope')).toBe(true);
    expect(revisionPassIsCurrent(credit(UNREVIEWED), 'scope')).toBe(false);
    expect(revisionPassIsCurrent(credit([{ key: '' }]), '')).toBe(false);
    expect(revisionPassIsCurrent(credit([{ key: '' }]), undefined)).toBe(false);
    expect(revisionPassIsCurrent(credit(), 'story')).toBe(false);
  });
});

describe('the printable record', () => {
  const phase = { id: 'phase-req', key: 'requirements', order: 1, title: 'Requirements', status: 'passed', attempts: 1, bestScore: 100, passedAt: '2026-11-08T00:00:00Z' };
  const details = { 'phase-req': { ...phase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null } } as unknown as Record<string, PhaseDetail>;
  const report = {
    passed: true, assessmentMode: 'strict_binary', overall: 100, passThreshold: 70, checks: [],
    tests: { total: 0, passed: 0, failed: 0, errored: 0, cases: [] },
    aiReview: { provider: 'mock-ai', verdict: 'pass', criteriaEvidence: [] },
  };
  const passOf = (taskKey: string) =>
    ({ id: `review-${taskKey}`, taskKey, status: 'completed', passed: true, verifiedPass: true, score: 100, report, createdAt: '2026-10-11T00:00:00Z' }) as unknown as SubmissionView;
  const record = (creditTasks: CreditTask[], revisions: SubmissionView[]): LearnerDossier => {
    const enrollment = {
      phases: [{ ...phase, passKind: 'credit', creditTasks }],
      projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
    } as unknown as EnrollmentView;
    const records: Record<string, PhaseRecords> = { 'phase-req': { submissions: revisions, runs: [], chat: [] } };
    return { ...buildDossier(enrollment, details, records, {}, null), totalPhases: 1 };
  };

  let root: Root; let host: HTMLDivElement;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const draw = async (dossier: LearnerDossier) => { await act(async () => root.render(<Dossier dossier={dossier} />)); };
  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  const cells = () => [...(host.querySelector('[data-testid="dossier-score-1"]')?.closest('[role="row"]')?.querySelectorAll('[role="cell"]') ?? [])].map((cell) => cell.textContent);

  it('says "Awaiting your teacher\'s sign-off" on a credit waiting only on the countersignature, with its current Pass', async () => {
    const d = record(SIGNOFF, [passOf('scope')]);
    expect((d.phases[0] as { creditTasks?: CreditTask[] }).creditTasks).toEqual(SIGNOFF);
    await draw(d);
    expect(text('dossier-status-1')).toBe(AWAITING);
    expect(cells()[5]).toBe('Pass');
    // The record's one phase is the project's last, so nothing follows it: the
    // countersignature lets the project be completed.
    expect(text('dossier-awaiting')).toContain(`${AWAITING} on 1 phase: the work passed review; the project can be completed on the countersignature.`);
    expect(text('dossier-credited')).toBeNull();
    expect(host.textContent).toContain(`${AWAITING}: 1 phase`);
    expect(host.textContent).not.toContain(CREDIT);
  });

  it('keeps "Pass" on a split partial credit, where the reviewed task’s pass is current', async () => {
    await draw(record(UNREVIEWED, [passOf('story')]));
    expect(text('dossier-status-1')).toBe(CREDIT);
    expect(cells()[5]).toBe('Pass');
    expect(host.textContent).not.toContain('Earlier Pass / review required');
    expect(text('dossier-credited')).toContain(`${CREDIT} on 1 phase`);
    expect(text('dossier-awaiting')).toBeNull();
  });

  it('keeps "Earlier Pass / review required" where the pass shown is of a task still wanted (a reset withdrew it)', async () => {
    await draw(record(UNREVIEWED, [passOf('scope')]));
    expect(text('dossier-status-1')).toBe(CREDIT);
    expect(cells()[5]).toBe('Earlier Pass / review required');
  });
});
