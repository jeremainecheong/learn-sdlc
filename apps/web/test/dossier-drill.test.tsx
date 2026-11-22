// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook,
  type DrillState, type EnrollmentView, type LearnerDossier, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import type { PhaseRecords } from '@/lib/records';

/*
 * Section 8 of the dossier, "The drill": the drill as it was, the incident
 * read from the record (the API hands the drill out filled), and the
 * runbook's four list counts from the snapshot's record. An older snapshot
 * holds no record: its runbook as it stood when the page came is shown
 * through the older reader, and no counts are drawn.
 */

const deploymentPhase = { id: 'phase-deploy', key: 'deployment', order: 5, title: 'Deployment', status: 'in_progress', attempts: 1, bestScore: null, passedAt: null };
const enrollment = {
  phases: [deploymentPhase], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
} as unknown as EnrollmentView;
const details = { 'phase-deploy': { ...deploymentPhase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null } } as unknown as Record<string, PhaseDetail>;
const revision = { id: 'review', status: 'completed', passed: false, score: 0, report: null, createdAt: '2026-10-11T00:00:00Z' } as SubmissionView;
const records: Record<string, PhaseRecords> = { 'phase-deploy': { submissions: [revision], runs: [], chat: [] } };
const drill = (runbookBefore: string | null): DrillState => ({
  fault: 'TASKTRACKR_DB', pagedAt: '2026-10-11T00:00:00Z', runbookBefore, healthRanAt: '2026-10-11T00:05:00Z', healthExit: 0,
  fixAppliedAt: '2026-10-11T00:05:00Z', resolvedAt: '2026-10-11T00:10:00Z', incident: { rootCause: 'The database path pointed nowhere.', fix: 'f', actionItem: 'a' },
});
const runbook = serialiseRunbook({
  ...EMPTY_RUNBOOK,
  environment: [{ id: 'E1', name: 'API_URL', purpose: 'where /api goes', kind: 'config' }, { id: 'E2', name: 'PORT', purpose: '', kind: 'config' }],
  health: [{ id: 'H1', name: 'Selfcheck', how: 'python3 api/main.py --selfcheck', expected: 'ok' }],
});

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const section = async (snapshot: Record<string, string>, state: DrillState) => {
  const built = buildDossier(enrollment, details, records, { review: snapshot }, null);
  const dossier: LearnerDossier = { ...built, phases: built.phases.map((phase) => ({ ...phase, drill: state })) };
  await act(async () => root.render(<Dossier dossier={dossier} />));
  return host.querySelector('[data-testid="dossier-section-8"]')!;
};

describe("the dossier's drill section", () => {
  it('reads the incident and the runbook counts from the record', async () => {
    const drawn = await section({ [RUNBOOK_JSON]: runbook, Dockerfile: 'FROM python' }, drill(null));
    expect(drawn.querySelector('[data-testid="dossier-runbook-counts"]')?.textContent)
      .toBe('The runbook: 1 environment entry, 1 health check, 0 rollback steps, 0 data entries');
    expect(drawn.textContent).toContain('The database path pointed nowhere.');
    expect(drawn.querySelector('[data-testid="dossier-runbook-before"]')).toBeNull();
  });

  it('shows an older snapshot through the older reader, with no counts', async () => {
    const drawn = await section({ 'RUNBOOK.md': '# Runbook\n' }, drill('# Runbook\n## Health check\n'));
    expect(drawn.querySelector('[data-testid="dossier-runbook-counts"]')).toBeNull();
    expect(drawn.querySelector('[data-testid="dossier-runbook-before"]')).not.toBeNull();
  });
});
