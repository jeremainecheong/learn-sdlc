// @vitest-environment jsdom
/**
 * An analysis that read no file (analysisNotMeasured:
 * metrics.files 0, no issue) reads "Not measured" in the IDE Review tab and on
 * the pull request page, but the learner's feedback page and the teacher's
 * evidence view (SubmissionEvidence) drew its Static analysis check as
 * "No findings." under "Criterion met" with a check icon, and the printed
 * record (Dossier) drew a "Passed" chip with "No findings.". Both now draw the
 * shared words of components/pr/analysisReach.ts for that one row, and the
 * feedback page adds the note under the Code quality criterion as the IDE
 * does. Display only: the check's status, the criterion's level and the score
 * are drawn as the API sent them, and a measured analysis renders its measured values.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzerReport, EnrollmentView, FeedbackReport, PhaseDetail, SubmissionView } from '@learnsdlc/shared';
import { NOT_MEASURED_CRITERION_NOTE, NOT_MEASURED_REASON } from '@/components/pr/analysisReach';

const mocks = vi.hoisted(() => ({ getSubmissionWithFiles: vi.fn(), teacherEvidence: vi.fn(), teacherFeedback: vi.fn(), submissionSignOff: vi.fn() }));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, getSubmissionWithFiles: mocks.getSubmissionWithFiles } };
});
vi.mock('@/lib/api-experience', async (original) => {
  const actual = await original<typeof import('@/lib/api-experience')>();
  return { ...actual, experienceApi: { ...actual.experienceApi, teacherEvidence: mocks.teacherEvidence, teacherFeedback: mocks.teacherFeedback, submissionSignOff: mocks.submissionSignOff } };
});
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { SubmissionEvidence } from '@/components/experience/SubmissionEvidence';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import type { PhaseRecords } from '@/lib/records';

const NOTHING: AnalyzerReport = { issues: [], metrics: { files: 0, functions: 0, todosRemaining: 0, maxComplexity: 0, docstringCoverage: 1 }, functions: [] };
const READ: AnalyzerReport = { issues: [], metrics: { files: 2, functions: 5, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 0.6 } };
const reportOf = (staticAnalysis: AnalyzerReport): FeedbackReport => ({
  passed: true, score: 100, passThreshold: 70, assessmentMode: 'strict_binary',
  checks: [
    { id: 'tests', label: 'Tests', status: 'passed', detail: '8 of 8 tests pass.' },
    { id: 'static-analysis', label: 'Static analysis', status: 'passed', detail: 'No findings.' },
  ],
  criteria: [{ key: 'code_quality', title: 'Code quality', level: 'met', evidence: ['Static analysis recorded.'] }],
  staticAnalysis,
  aiReview: { summary: 'The change meets the request.', improvements: [], criteriaEvidence: [] },
  tests: { passed: 8, failed: 0, errored: 0, total: 8, cases: [] },
}) as unknown as FeedbackReport;
const submissionOf = (staticAnalysis: AnalyzerReport): SubmissionView => ({
  id: 'sub-1', phaseStateId: 'phase-impl', attempt: 1, status: 'completed', passed: true, score: 100, createdAt: '2026-11-17T00:00:00Z',
  report: reportOf(staticAnalysis), workspaceSnapshot: {},
}) as unknown as SubmissionView;

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacherFeedback.mockResolvedValue([]); mocks.submissionSignOff.mockResolvedValue(null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const rowOf = (label: string) => [...host.querySelectorAll('.exp-evidence-row')].find((row) => row.querySelector('strong')?.textContent === label) as HTMLElement;
const evidence = async (analysis: AnalyzerReport, teacher = false) => {
  mocks.getSubmissionWithFiles.mockResolvedValue(submissionOf(analysis));
  mocks.teacherEvidence.mockResolvedValue(submissionOf(analysis));
  await act(async () => root.render(<SubmissionEvidence submissionId="sub-1" teacher={teacher} />));
  await act(async () => { await Promise.resolve(); });
};

describe('the feedback page and the teacher evidence view', () => {
  for (const teacher of [false, true]) {
    it(`${teacher ? 'teacher' : 'learner'}: an analysis that read no file reads Not measured, with the reason and no check icon`, async () => {
      await evidence(NOTHING, teacher);
      const row = rowOf('Static analysis');
      expect(row.querySelector('p')?.textContent).toBe(NOT_MEASURED_REASON);
      expect(row.querySelector('.exp-caption')?.textContent).toBe('Not measured');
      expect(row.textContent).not.toContain('Criterion met');
      expect(row.querySelector('.lucide-circle-check-big, .lucide-check-circle-2, .lucide-circle-check')).toBeNull();
      expect(row.querySelector('[data-testid="evidence-not-measured-icon"]')).not.toBeNull();
      const criterion = rowOf('Code quality');
      expect(criterion.querySelector('[data-testid="criterion-not-measured"]')?.textContent).toBe(NOT_MEASURED_CRITERION_NOTE);
      // Every other check row is drawn from the API.
      expect(rowOf('Tests').querySelector('.exp-caption')?.textContent).toBe('Criterion met');
    });
  }
  it('a measured analysis renders its own line and Criterion met, with no Not measured mark', async () => {
    await evidence(READ);
    const row = rowOf('Static analysis');
    expect(row.querySelector('p')?.textContent).toBe('No findings.');
    expect(row.querySelector('.exp-caption')?.textContent).toBe('Criterion met');
    expect(row.querySelector('[data-testid="evidence-not-measured-icon"]')).toBeNull();
    expect(row.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('[data-testid="criterion-not-measured"]')).toBeNull();
  });
});

describe("the printed record's Checks table", () => {
  const phase = { id: 'phase-impl', key: 'implementation', order: 3, title: 'Implementation', status: 'passed', attempts: 1, bestScore: 100, passedAt: '2026-11-17T00:00:00Z' };
  const draw = async (analysis: AnalyzerReport) => {
    const enrollment = { phases: [phase], projectSlug: 'deadline-badge', projectTitle: 'Deadline badge', releases: [], startedAt: '2026-11-01T00:00:00Z', completedAt: null } as unknown as EnrollmentView;
    const details = { 'phase-impl': { ...phase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] } } } as unknown as Record<string, PhaseDetail>;
    const records: Record<string, PhaseRecords> = { 'phase-impl': { submissions: [submissionOf(analysis)], runs: [], chat: [] } };
    await act(async () => root.render(<Dossier dossier={buildDossier(enrollment, details, records, { 'sub-1': {} }, null)} />));
    const table = host.querySelector('[data-testid="dossier-checks-3"]') as HTMLElement;
    return (label: string) => [...table.querySelectorAll('[role="row"], tr')].find((row) => row.textContent?.startsWith(label))?.textContent ?? '';
  };
  it('an analysis that read no file reads Not measured, with the reason', async () => {
    const row = await draw(NOTHING);
    expect(row('Static analysis')).toBe(`Static analysis${NOT_MEASURED_REASON}Not measured`);
    expect(row('Tests')).toBe('Tests8 of 8 tests pass.Passed');
  });
  it('a measured analysis reads Passed', async () => {
    const row = await draw(READ);
    expect(row('Static analysis')).toBe('Static analysisNo findings.Passed');
  });
});
