// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrollmentView, LearnerDossier, PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import { creditedWithoutReview, holdsReviewedPass, reviewedPasses } from '@/components/dossier/completion';
import type { PassKind } from '@/lib/pass-kind';
import type { PhaseRecords } from '@/lib/records';

/*
 * Outside the learner's room, a phase a teacher marked as
 * passed with no reviewed pass behind it was drawn as an ordinary pass ("Pass",
 * "Passed", "Passed with 70", the pass square on the printed record). The
 * board now says which kind of pass each phase holds (`passKind`, the gate's
 * own predicate), and each reader says a credit in the rooms' words. A
 * reviewed pass, and a payload from an older API with no `passKind`, read as
 * they always did.
 */

const CREDIT = 'Credit awarded, review still needed';

describe('the printable record', () => {
  const phase = { id: 'phase-req', key: 'requirements', order: 1, title: 'Requirements', status: 'passed', attempts: 1, bestScore: 100, passedAt: '2026-11-08T00:00:00Z' };
  const details = { 'phase-req': { ...phase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null } } as unknown as Record<string, PhaseDetail>;
  const verdictReport = (pass: boolean) => ({
    passed: pass, assessmentMode: 'strict_binary', overall: pass ? 100 : 40, passThreshold: 70, checks: [],
    tests: { total: 0, passed: 0, failed: 0, errored: 0, cases: [] },
    aiReview: { provider: 'mock-ai', verdict: pass ? 'pass' : 'revise', criteriaEvidence: [] },
  });
  const passed = { id: 'review', status: 'completed', passed: true, verifiedPass: true, score: 100, report: verdictReport(true), createdAt: '2026-10-11T00:00:00Z' } as unknown as SubmissionView;
  const failed = { ...passed, id: 'returned', passed: false, verifiedPass: false, report: verdictReport(false) } as unknown as SubmissionView;
  const record = (passKind: PassKind | undefined, revisions: SubmissionView[]): LearnerDossier => {
    const enrollment = {
      phases: [{ ...phase, ...(passKind ? { passKind } : {}) }],
      projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
    } as unknown as EnrollmentView;
    const records: Record<string, PhaseRecords> = { 'phase-req': { submissions: revisions, runs: [], chat: [] } };
    return { ...buildDossier(enrollment, details, records, {}, null), totalPhases: 1, phasesPassed: 1 };
  };

  let root: Root; let host: HTMLDivElement;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const draw = async (dossier: LearnerDossier) => { await act(async () => root.render(<Dossier dossier={dossier} />)); };
  const row = () => host.querySelector('[data-testid="dossier-score-1"]')?.closest('[role="row"]');

  it('carries the board’s passKind onto the learner’s copy', () => {
    expect((record('credit', [failed]).phases[0] as { passKind?: PassKind }).passKind).toBe('credit');
    expect('passKind' in record(undefined, [failed]).phases[0]).toBe(false);
  });

  it('prints a credit as credit: no pass square, word, date or Pass chip, and the cover agrees', async () => {
    const d = record('credit', [failed]);
    await draw(d);
    expect(host.querySelector('[data-testid="dossier-status-1"]')?.textContent).toBe(CREDIT);
    const cells = [...(row()?.querySelectorAll('[role="cell"]') ?? [])].map((cell) => cell.textContent);
    expect(cells).not.toContain('Passed');
    expect(cells[4]).toBe('—');
    expect(cells[5]).toBe('Needs revision');
    expect(row()?.querySelector('[data-state="pass"]')).toBeNull();
    expect(host.querySelector('[data-testid="dossier-credited"]')?.textContent).toContain(`${CREDIT} on 1 phase`);
  });

  // A reviewed pass the learner left behind, reset and passed again by
  // a teacher with no new revision. The old revision passed its review, but
  // the board says credit; the record believes the board.
  it('believes the board over an old passing revision, and never prints a bare "Pass" on a credit', async () => {
    const d = record('credit', [passed]);
    expect(holdsReviewedPass(d.phases[0])).toBe(false);
    expect(creditedWithoutReview(d.phases[0])).toBe(true);
    expect(reviewedPasses(d.phases)).toBe(0);
    await draw(d);
    expect(host.querySelector('[data-testid="dossier-status-1"]')?.textContent).toBe(CREDIT);
    const cells = [...(row()?.querySelectorAll('[role="cell"]') ?? [])].map((cell) => cell.textContent);
    expect(cells[5]).toBe('Earlier Pass / review required');
  });

  it('prints a reviewed pass, and an older payload with no passKind, as Passed with no credit line', async () => {
    for (const d of [record('reviewed', [passed]), record(undefined, [passed])]) {
      expect(reviewedPasses(d.phases)).toBe(1);
      await draw(d);
      expect(host.querySelector('[data-testid="dossier-status-1"]')?.textContent).toBe('Passed');
      const cells = [...(row()?.querySelectorAll('[role="cell"]') ?? [])].map((cell) => cell.textContent);
      expect(cells[4]).not.toBe('—');
      expect(cells[5]).toBe('Pass');
      expect(host.querySelector('[data-testid="dossier-credited"]')).toBeNull();
    }
  });

  it('where the board says nothing, no passing revision is a credit', () => {
    const d = record(undefined, [failed]);
    expect(creditedWithoutReview(d.phases[0])).toBe(true);
    expect(reviewedPasses(d.phases)).toBe(0);
  });
});
