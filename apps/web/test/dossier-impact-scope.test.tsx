// @vitest-environment jsdom
/**
 * The dossier's change impact table, by the same rule as the change request's graph. The API marks "removed" every
 * earlier function the Maintenance review did not find again, and that review reads only the files the learner edits in
 * the phase, so the finished TaskTrackr learner's dossier would list the 14 functions of api/routes/tasks.py (read-only
 * in Maintenance) as "Removed". The table reads the impact through
 * the same `readScope`: a function is listed removed only where this review read its file, and one line under the
 * table names the files it did not read. Where the merged revision's snapshot was pruned, which files the learner
 * edits is not known, and the line says only that this review did not read those functions again.
 * The fixture is test/fixtures/tasktrackr-impact.ts.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrollmentView, ImpactReport, LearnerDossier, PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import type { PhaseRecords } from '@/lib/records';
import { EDITABLE, IMPACT, ROUTES_TASKS, current } from './fixtures/tasktrackr-impact';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const maintenance = { id: 'phase-maint', key: 'maintenance', order: 6, title: 'Maintenance', status: 'passed', attempts: 1, bestScore: 100, passedAt: '2026-11-11T05:00:00Z' };
const enrollment = { phases: [maintenance], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-11-01T00:00:00Z', completedAt: null } as unknown as EnrollmentView;
const details = {
  'phase-maint': { ...maintenance, artifactKind: 'code', files: EDITABLE.map((path) => ({ path, content: '', editable: true, language: 'text' })), links: [], rubric: { passThreshold: 70, criteria: [] }, drill: null },
} as unknown as Record<string, PhaseDetail>;
const revision = (impact: ImpactReport) => ({
  id: 'rev', status: 'completed', passed: true, verifiedPass: true, score: 100, attempt: 1, createdAt: '2026-11-11T04:50:00Z',
  report: { passed: true, overall: 100, checks: [], contract: [], impact, staticAnalysis: { functions: current, issues: [] }, tests: { passed: 8, total: 8, cases: [] }, aiReview: { assessmentError: false } },
}) as unknown as SubmissionView;
/** The merged revision keeps the editable files only (the API's `editableSnapshot`), as the dossier reads them. */
const snapshot = Object.fromEntries(EDITABLE.map((path) => [path, '# kept']));
const dossierOf = (impact: ImpactReport, audience: LearnerDossier['audience'] = 'instructor', pruned = false) => {
  const records: Record<string, PhaseRecords> = { 'phase-maint': { submissions: [revision(impact)], runs: [], chat: [] } };
  return { ...buildDossier(enrollment, details, records, pruned ? {} : { rev: snapshot }, null), audience } as LearnerDossier;
};
const draw = async (dossier: LearnerDossier) => {
  await act(async () => root.render(<Dossier dossier={dossier} />));
  const table = host.querySelector<HTMLElement>('[data-testid="dossier-impact"]')!;
  expect(table, 'the impact table is drawn').not.toBeNull();
  return { table, unread: host.querySelector<HTMLElement>('[data-testid="dossier-impact-unread"]') };
};

describe('the dossier\'s impact table lists "Removed" only in files the review read', () => {
  it('the finished TaskTrackr learner (teacher\'s copy): no api/routes/tasks.py row, no "Removed", and the line under the table', async () => {
    const { table, unread } = await draw(dossierOf(IMPACT));
    expect(table.textContent).not.toContain('api/routes/tasks.py');
    expect(table.textContent).not.toContain('Removed');
    // every function this review read is still listed, and nothing else: 16 rows, not 30
    for (const fn of current) expect(table.textContent).toContain(`${fn.path}, line ${fn.line}`);
    expect(table.textContent!.split(', line ').length - 1).toBe(current.length);
    expect(current.length + ROUTES_TASKS.length).toBe(IMPACT.functions.length);
    expect(unread!.textContent).toBe('api/routes/tasks.py (14 functions) is not a file the learner edits in this phase, so this review did not read it again: it is left out of the table, not removed.');
  });

  it('the learner\'s own copy says "you edit"', async () => {
    const { unread } = await draw(dossierOf(IMPACT, 'learner'));
    expect(unread!.textContent).toBe('api/routes/tasks.py (14 functions) is not a file you edit in this phase, so this review did not read it again: it is left out of the table, not removed.');
  });

  it('a function removed from a file the review read is still listed "Removed", and no line is added', async () => {
    const gone = { name: 'old_helper', path: 'api/repository/tasks.py', line: 200, endLine: 210, complexity: 1, change: 'removed' as const, reachedBy: [] };
    const read: ImpactReport = { ...IMPACT, functions: [...IMPACT.functions.filter((f) => f.path !== 'api/routes/tasks.py'), gone] };
    const { table, unread } = await draw(dossierOf(read));
    expect(table.textContent).toContain('old_helper');
    expect(table.textContent).toContain('Removed');
    expect(unread).toBeNull();
  });

  it('the graph\'s own line is ground B\'s, word for word', async () => {
    const { unreadLine } = await import('@/components/workspace/panels/maintenance/impact');
    expect(unreadLine([{ path: 'api/routes/tasks.py', count: 14 }])).toBe('api/routes/tasks.py (14 functions) is not a file you edit in this phase, so this review did not read it again: it is left out of the graph after the change, not removed.');
  });

  it('a merged revision whose snapshot was pruned (no files, so which files the learner edits is not known): the line says only what is known', async () => {
    const dossier = dossierOf(IMPACT, 'instructor', true);
    expect(dossier.phases.find((p) => p.key === 'maintenance')!.files).toEqual([]);
    const { table, unread } = await draw(dossier);
    expect(table.textContent).not.toContain('Removed');
    expect(unread!.textContent).toBe('api/routes/tasks.py (14 functions): this review read none of these functions again, so they are left out of the table.');
    const learner = await draw(dossierOf(IMPACT, 'learner', true));
    expect(learner.unread!.textContent).toBe('api/routes/tasks.py (14 functions): this review read none of these functions again, so they are left out of the table.');
  });

  it('one function in one file, and several files, in the same plain words', async () => {
    const { unreadLine } = await import('@/components/workspace/panels/maintenance/impact');
    expect(unreadLine([{ path: 'a.py', count: 1 }], 'instructor', 'the table', false)).toBe('a.py (1 function): this review did not read that function again, so it is left out of the table.');
    expect(unreadLine([{ path: 'a.py', count: 1 }, { path: 'b.py', count: 3 }], 'instructor', 'the table', false)).toBe('a.py (1 function) and b.py (3 functions): this review read none of these functions again, so they are left out of the table.');
  });
});
