// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest,
  type EnrollmentView, type LearnerDossier, type PhaseDetail, type SubmissionView,
} from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import type { PhaseRecords } from '@/lib/records';

/*
 * Section 9, the change record, reads the snapshot's change request beside
 * the report facts: the ticket from the phase spec (the learner's copy from
 * `PhaseDetail.change`, the teacher's from `checks.ticket`), and the
 * amendments, the tests and the release from the record the revision kept.
 * An older snapshot, with no record and no ticket, shows the report facts only.
 */

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const CHG = { id: 'CHG-1', title: 'Shelve by surname', summary: 'The library has asked for surname order.', acceptance: [{ id: 'AC-1', line: 'shelf_order sorts by surname.' }] };
const recordText = serialiseChangeRequest({
  ...EMPTY_CHANGE_REQUEST,
  contract: [{ id: 'C1', method: 'GET', path: '/api/shelf', change: 'added', why: 'the page reads it' }],
  tests: [{ id: 'T1', suite: 'tests/test_shelf.py', covers: ['AC-1'], result: 'pass' }],
  release: { version: '1.1.0', summary: 'Surname order', changes: [{ id: 'L1', line: 'The shelf follows surname order.', covers: ['AC-1'] }], rollback: 'Redeploy 1.0.0' },
});
const maintenancePhase = { id: 'phase-maint', key: 'maintenance', order: 6, title: 'Maintenance', status: 'in_progress', attempts: 1, bestScore: null, passedAt: null };
const enrollment = { phases: [maintenancePhase], projectSlug: 'shelf', projectTitle: 'Shelf', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null } as unknown as EnrollmentView;
const detailWith = (change: PhaseDetail['change']) => ({
  'phase-maint': { ...maintenancePhase, artifactKind: 'code', files: [], links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null, change },
}) as unknown as Record<string, PhaseDetail>;
const revision = { id: 'rev', status: 'completed', passed: false, score: 0, report: null, createdAt: '2026-10-11T00:00:00Z' } as SubmissionView;
const records: Record<string, PhaseRecords> = { 'phase-maint': { submissions: [revision], runs: [], chat: [] } };
const section = async (dossier: LearnerDossier) => {
  await act(async () => root.render(<Dossier dossier={dossier} />));
  return host.querySelector('[data-testid="dossier-change-request"]')?.textContent ?? '';
};

describe('section 9 reads the change request', () => {
  it('a new snapshot: the ticket, the amendments, the tests and the release', async () => {
    const dossier = buildDossier(enrollment, detailWith({ ticket: CHG, contract: true, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true } }), records, { rev: { [CHANGE_REQUEST_JSON]: recordText } }, null);
    expect(dossier.phases[0].changeTicket).toEqual(CHG);
    const text = await section(dossier);
    for (const said of ['CHG-1', 'Shelve by surname', '/api/shelf', 'tests/test_shelf.py', '1.1.0', 'Surname order']) expect(text).toContain(said);
  });
  it('an older snapshot: the report facts only', async () => {
    const dossier = buildDossier(enrollment, detailWith(undefined), records, { rev: {} }, null);
    expect(dossier.phases[0].changeTicket).toBeUndefined();
    expect(await section(dossier)).toBe('');
  });
});
