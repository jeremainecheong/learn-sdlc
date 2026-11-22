// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DrillState, EnrollmentView, LearnerDossier, PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier, printedScope } from '@/components/dossier/Dossier';
import { completionState, dossierCompletion } from '@/components/dossier/completion';
import type { PhaseRecords } from '@/lib/records';

/*
 * The printable record. After the countersign a record could read "6 of 6
 * phases passed" beside "In progress" and "Finished: Not yet", because a
 * project is sealed only by the learner's last Continue; the cover says so.
 * The colophon says whether the incident is included by what the page
 * printed.
 */

const deploymentPhase = { id: 'phase-deploy', key: 'deployment', order: 5, title: 'Deployment', status: 'passed', attempts: 1, bestScore: 100, passedAt: '2026-11-08T00:00:00Z' };
const enrollment = {
  phases: [deploymentPhase], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
} as unknown as EnrollmentView;
const details = { 'phase-deploy': { ...deploymentPhase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null } } as unknown as Record<string, PhaseDetail>;
const revision = { id: 'review', status: 'completed', passed: true, verifiedPass: true, score: 100, report: null, createdAt: '2026-10-11T00:00:00Z' } as SubmissionView;
const records: Record<string, PhaseRecords> = { 'phase-deploy': { submissions: [revision], runs: [], chat: [] } };
const drill = (incident: boolean): DrillState => ({
  fault: 'web-points-at-localhost', pagedAt: '2026-11-08T00:00:00Z', runbookBefore: null, healthRanAt: '2026-11-08T00:05:00Z', healthExit: 0,
  fixAppliedAt: '2026-11-08T00:05:00Z', resolvedAt: '2026-11-08T00:10:00Z',
  incident: incident ? { rootCause: 'API_URL named localhost.', fix: 'Named the api service.', actionItem: 'Run the selfcheck in CI.' } : null,
});

const base = (): LearnerDossier => buildDossier(enrollment, details, records, { review: { 'Dockerfile': 'FROM python' } }, null);
const withDrill = (d: LearnerDossier, state: DrillState | null): LearnerDossier => ({ ...d, phases: d.phases.map((p) => ({ ...p, drill: state })) });
/**
 * A dossier of `total` phases: `reviewed` of them hold a reviewed pass, `credited` more are passed on the
 * board without one (a teacher's sign-off or Mark as passed), the rest are open. `phasesPassed` is
 * the board's count, as the API reports it.
 */
const phased = (d: LearnerDossier, reviewed: number, total: number, credited = 0): LearnerDossier => {
  const [one] = d.phases;
  const unreviewed = { ...revision, id: 'credited', verifiedPass: false } as SubmissionView;
  const phases = Array.from({ length: total }, (_, i) => ({
    ...one,
    phaseStateId: `phase-${i + 1}`,
    order: i + 1,
    status: i < reviewed + credited ? 'passed' : 'in_progress',
    revisions: i < reviewed ? [revision] : i < reviewed + credited ? [unreviewed] : [],
  })) as LearnerDossier['phases'];
  return { ...d, phases, phasesPassed: reviewed + credited, totalPhases: total };
};

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const draw = async (dossier: LearnerDossier) => { await act(async () => root.render(<Dossier dossier={dossier} />)); };
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

describe('the completion state', () => {
  it('is sealed only by the completed flag, all passed when every phase holds a reviewed pass, else in progress', () => {
    expect(completionState({ completed: true, passed: 6, total: 6 })).toBe('sealed');
    expect(completionState({ completed: false, passed: 6, total: 6 })).toBe('all-passed');
    expect(completionState({ completed: false, passed: 5, total: 6 })).toBe('in-progress');
    expect(completionState({ completed: false, passed: 0, total: 0 })).toBe('in-progress');
  });

  // The board's count includes a teacher's credit with no
  // reviewed pass behind it, which the completion page does not count.
  it('counts only a reviewed pass: a phase credited by the teacher without one leaves the project in progress', async () => {
    const d = phased({ ...base(), completedAt: null }, 0, 1, 1);
    expect(d.phasesPassed).toBe(1);
    expect(dossierCompletion(d)).toBe('in-progress');
    await draw(d);
    expect(text('dossier-completion')).toBe('In progress');
    expect(text('dossier-standing')).toContain('0 of 1 phases passed so far.');
    expect(text('dossier-credited')).toContain('Credit awarded, review still needed on 1 phase');
  });
});

describe("the dossier's cover", () => {
  it('says all phases passed and what closes the project, not a bare In progress and Not yet (teacher copy)', async () => {
    const d: LearnerDossier = phased({ ...base(), audience: 'instructor', completedAt: null }, 6, 6);
    expect(dossierCompletion(d)).toBe('all-passed');
    await draw(d);
    expect(text('dossier-completion')).toBe('All phases passed');
    expect(text('dossier-standing')).toBe('All phases passed. The project is complete once the learner presses Complete the project on the last phase.');
    const cover = text('dossier-section-1');
    expect(cover).toContain('FinishedWhen the learner presses Complete the project on the last phase');
    expect(cover).not.toContain('In progress');
    expect(cover).not.toContain('Not yet');
  });

  it("speaks to the learner on the learner's own copy", async () => {
    await draw(phased({ ...base(), audience: 'learner', completedAt: null }, 6, 6));
    expect(text('dossier-standing')).toBe('All phases passed. The project is complete once you press Complete the project on the last phase.');
    expect(text('dossier-section-1')).toContain('FinishedWhen you press Complete the project on the last phase');
  });

  it('says Complete with the date once the project is sealed', async () => {
    await draw(phased({ ...base(), completedAt: '2026-11-08T10:00:00Z' }, 6, 6));
    expect(text('dossier-completion')).toBe('Complete');
    expect(text('dossier-standing')).toBe('All 6 phases passed. The project is complete.');
    expect(text('dossier-section-1')).toContain('8 November 2026');
  });

  it('keeps In progress and Not yet while a phase is still open', async () => {
    await draw(phased({ ...base(), completedAt: null }, 4, 6));
    expect(text('dossier-completion')).toBe('In progress');
    expect(text('dossier-standing')).toBe('4 of 6 phases passed so far.');
    expect(text('dossier-section-1')).toContain('FinishedNot yet');
  });
});

describe("the dossier's colophon", () => {
  it('says the incident is included when the drill section printed it', async () => {
    const d = withDrill(base(), drill(true));
    await draw(d);
    expect(text('dossier-section-8')).toContain('API_URL named localhost.');
    expect(text('dossier-colophon')).toContain('Deployment incident state is included as printed above.');
    expect(text('dossier-colophon')).not.toContain('incident state is not included');
    expect(text('dossier-colophon')).toContain('Manually linked coverage is not included in this printable view.');
  });

  it('says the drill printed without an incident when none is written up', () => {
    expect(printedScope(withDrill(base(), drill(false)))).toBe(
      'The drill is included as printed above; its incident has not been written up yet. Manually linked coverage is not included in this printable view.',
    );
  });

  it('says the incident is not included when no drill printed (a learner copy carries none)', () => {
    expect(printedScope(withDrill(base(), null))).toBe(
      'Deployment incident state is not included in this printable view. Manually linked coverage is not included in this printable view.',
    );
  });

  it('says nothing of an incident when the project holds no Deployment', () => {
    const d = base();
    expect(printedScope({ ...d, phases: [] })).toBe('Manually linked coverage is not included in this printable view.');
  });
});
