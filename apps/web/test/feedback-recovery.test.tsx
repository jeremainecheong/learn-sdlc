// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_REVIEW_BUSY_MESSAGE, type FeedbackReport, type SubmissionView } from '@learnsdlc/shared';
import { gateReason } from '@/components/pr/ChecksCard';
import FeedbackPage from '@/app/(app)/feedback/page';
import ProgressPage from '@/app/(app)/progress/page';
import { isPass, isReviewUnavailable, verdict } from '@/components/experience/shared';
import { SubmissionEvidence } from '@/components/experience/SubmissionEvidence';
import { FeedbackPanel } from '@/components/workspace/FeedbackPanel';
import { submittedFileAnchor } from '@/components/experience/feedback-targets';

const mocks = vi.hoisted(() => ({ history: vi.fn(), evidence: vi.fn(), notes: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('phase=phase&submission=review'), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ loading: false, enrollment: { id: 'enrollment', phases: [{ id: 'phase', key: 'design', title: 'Design', order: 2, status: 'in_progress', attempts: 1 }] } }) }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { history: mocks.history, teacherFeedback: mocks.notes, teacherEvidence: mocks.evidence } }));
// lib/commit.ts registers its leaving and sign-out hooks at import time, and
// this whole mock replaces lib/api, so those two have to exist here or the
// file cannot be imported at all. They hand back the no-op unsubscribe the
// real ones do; nothing in this suite ends or leaves a session.
vi.mock('@/lib/api', () => ({ api: { getSubmissionWithFiles: mocks.evidence }, describeError: (error: Error) => error.message, onSessionLeaving: () => () => {}, onSignOut: () => () => {} }));
let root: Root, host: HTMLDivElement;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const report = (): FeedbackReport => ({
  assessmentMode: 'strict_binary', overall: 0, passed: false, criteria: [],
  checks: [{ id: 'contract', label: 'Saved contract check', status: 'passed', detail: 'The declared contract is present.' }],
  aiReview: { verdict: 'needs_revision', assessmentError: 'invalid_assessment', summary: 'Original provider report: assessment could not be completed.', strengths: [], improvements: ['Request another review.'], processNote: '', provider: 'fixture' },
  aiReliance: { hintsThisPhase: 0, index: 0 }, integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
});
const submission = (): SubmissionView => ({ id: 'review', status: 'completed', score: null, passed: false, verifiedPass: false, report: report(), createdAt: '2026-09-12T00:00:00Z', workspaceSnapshot: { 'design.json': 'Exact submitted contract.' } });
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', window.location.pathname);
  mocks.notes.mockResolvedValue([]);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(row: SubmissionView, unavailable = isReviewUnavailable(row)) {
  mocks.history.mockResolvedValue([{ id: row.id, phaseStateId: 'phase', status: row.status, passed: row.passed, verifiedPass: row.verifiedPass, createdAt: row.createdAt, reviewUnavailable: unavailable }]);
  mocks.evidence.mockResolvedValue(row);
  await act(async () => root.render(<FeedbackPage />));
}
describe('unavailable assessment recovery', () => {
  it('reopens the same linked file after a failed polling read and an explicit retry recreate its snapshot', async () => {
    vi.useFakeTimers();
    try {
      const row = submission();
      const anchor = submittedFileAnchor(row.id, 'design.json');
      window.history.replaceState(null, '', `#${encodeURIComponent(anchor)}`);
      mocks.evidence.mockResolvedValueOnce({ ...row, status: 'queued' })
        .mockRejectedValueOnce(new Error('Evidence is temporarily offline.')).mockResolvedValueOnce(row);
      await act(async () => root.render(<SubmissionEvidence submissionId={row.id} />));
      const first = document.getElementById(anchor) as HTMLDetailsElement;
      expect(first.open).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Evidence is temporarily offline.');
      expect(document.getElementById(anchor)).toBeNull();
      await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry submission')!.click(); });
      const retried = document.getElementById(anchor) as HTMLDetailsElement;
      expect(retried).not.toBe(first); expect(retried.open).toBe(true);
      expect(document.activeElement).toBe(retried.querySelector('summary'));
      expect(mocks.evidence).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('opens a directly linked file after asynchronous evidence arrives without reopening a manually closed file', async () => {
    const row = submission();
    const anchor = submittedFileAnchor(row.id, 'design.json');
    window.history.replaceState(null, '', `#${encodeURIComponent(anchor)}`);
    const pending = deferred<SubmissionView>(); mocks.evidence.mockReturnValue(pending.promise);
    await act(async () => root.render(<SubmissionEvidence submissionId={row.id} />));
    expect(document.getElementById(anchor)).toBeNull();
    await act(async () => { pending.resolve(row); });
    const details = document.getElementById(anchor) as HTMLDetailsElement;
    expect(details.open).toBe(true); expect(document.activeElement).toBe(details.querySelector('summary'));
    details.open = false;
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(details.open).toBe(false);
    await act(async () => { window.history.replaceState(null, '', '#unrelated'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await act(async () => { window.history.replaceState(null, '', `#${encodeURIComponent(anchor)}`); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(details.open).toBe(true);
  });
  it('keeps unavailable reviews out of revision totals and chart segments, with their exact history link intact', async () => {
    mocks.history.mockResolvedValue([
      { id: 'unavailable', phaseStateId: 'phase', status: 'completed', passed: false, verifiedPass: false, createdAt: '2026-09-12T00:00:00Z', reviewUnavailable: true },
      { id: 'revision', phaseStateId: 'phase', status: 'completed', passed: false, verifiedPass: false, createdAt: '2026-09-12T00:01:00Z', reviewUnavailable: false },
    ]);
    await act(async () => root.render(<ProgressPage />));
    const total = [...host.querySelectorAll('.exp-stats > div')].find(node => node.textContent?.includes('Needs revision reviews'));
    expect(total?.querySelector('strong')?.textContent).toBe('1');
    const dot = host.querySelector('a[aria-label^="Review 1, Design, Review unavailable"]');
    expect(dot?.getAttribute('href')).toBe('/feedback?phase=phase&submission=unavailable');
    expect(dot?.classList.contains('is-pending')).toBe(true);
    expect(host.querySelector('[role="img"][aria-label="Design: 0 passes, 1 needs revision, 1 pending or unavailable"]')).not.toBeNull();
  });
  it('distinguishes malformed provider output from work needing revision without replacing recorded evidence', async () => {
    const row = submission(), original = structuredClone(row);
    await render(row);
    expect(host.textContent).toContain('Your review is unavailable.');
    expect(host.textContent).not.toContain('Use the feedback. Strengthen your work.');
    expect(host.textContent).toContain('Original provider report: assessment could not be completed.');
    expect(host.textContent).toContain('The declared contract is present.');
    expect(host.textContent).toContain('Exact submitted contract.');
    const action = [...host.querySelectorAll('a')].find(a => a.textContent?.includes('Return to phase project'));
    expect(action?.getAttribute('href')).toBe('/workspace/phase/design');
    expect(host.querySelectorAll('.exp-status.is-revision')).toHaveLength(0);
    expect(isPass(row)).toBe(false); expect(row).toEqual(original);
  });
  it('keeps a substantive Needs revision verdict and revision action', async () => {
    const row = submission(); delete row.report!.aiReview.assessmentError;
    row.report!.aiReview.summary = 'The not-found response contradicts the agreed contract.';
    await render(row);
    expect(host.textContent).toContain('Use the feedback. Strengthen your work.');
    expect(host.textContent).toContain('The not-found response contradicts the agreed contract.');
    expect(host.textContent).not.toContain('Your review is unavailable.');
    expect([...host.querySelectorAll('a')].some(a => a.textContent?.includes('Revise your work'))).toBe(true);
    expect(verdict(row)).toBe('Needs revision'); expect(isPass(row)).toBe(false);
  });
  it('keeps the authoritative verified Pass presentation', async () => {
    const row = submission(); row.passed = true; row.verifiedPass = true;
    row.report!.passed = true; row.report!.aiReview.verdict = 'pass'; delete row.report!.aiReview.assessmentError;
    await render(row);
    expect(host.textContent).toContain('Design is ready to build on.');
    expect(host.textContent).not.toContain('Your review is unavailable.');
    expect(verdict(row)).toBe('Pass');
  });
  it('shows a report the gate passed at a rule-based 100 as a Pass with the reviewer’s verdict as advice', async () => {
    // At exactly 100 with every required check passed, the reviewer's
    // needs_revision and its unmet criteria do not refuse the pass, as long as
    // the reviewer found most criteria met. The API wrote `passed: true`; the
    // web's own copy of the gate must agree, and the panel must not say two
    // things at once.
    const row = submission(); row.passed = true; row.verifiedPass = true;
    row.report!.passed = true; row.report!.overall = 100; delete row.report!.aiReview.assessmentError;
    row.report!.aiReview.verdict = 'needs_revision';
    row.report!.criteria = [
      { key: 'routes', title: 'Every route named', evidence: ['design.json names every route.'], score: 100, weight: 0.4 },
      { key: 'models', title: 'Every model named', evidence: ['design.json names every model.'], score: 100, weight: 0.3 },
      { key: 'contract', title: 'Consistent contract', evidence: ['design.json names its error shape.'], score: 100, weight: 0.3 },
    ];
    row.report!.aiReview.criteriaEvidence = [
      { key: 'routes', met: true, evidence: 'design.json lines 2-9', issue: '', nextStep: '' },
      { key: 'models', met: true, evidence: 'design.json lines 10-14', issue: '', nextStep: '' },
      { key: 'contract', met: false, evidence: '', issue: 'The error shape is not named for every route.', nextStep: 'Name it.' },
    ];
    const unverified: SubmissionView = { ...row, verifiedPass: undefined as unknown as boolean };
    delete (unverified as { verifiedPass?: boolean }).verifiedPass;
    expect(isPass(unverified)).toBe(true); expect(verdict(unverified)).toBe('Pass');
    await act(async () => root.render(<FeedbackPanel submission={row}/>));
    expect(host.querySelector('[data-testid="feedback-verdict"]')?.textContent).toContain('Pass');
    // Two criteria met and the third the reviewer's advice: 2 Met + 1 Advice.
    const chips = [...host.querySelectorAll('tbody tr td:last-child')].map(cell => cell.textContent ?? '');
    expect(chips.filter(text => text.startsWith('Met'))).toHaveLength(2);
    expect(chips.filter(text => text.startsWith('Advice'))).toHaveLength(1);
    expect(host.textContent).toContain('Advice');
    expect(host.textContent).toContain('The error shape is not named for every route.');
    expect(host.textContent).not.toContain('Needs revision');
    expect(host.textContent).toContain("Reviewer's advice on this passed work:");
    // One point short, the reviewer's verdict gates.
    const below: SubmissionView = { ...unverified, passed: false, report: { ...row.report!, passed: false, overall: 99 } };
    expect(isPass(below)).toBe(false); expect(verdict(below)).toBe('Needs revision');
    // The web's own copy of the rule, exercised on its own: a report that
    // claims a Pass at 99 with the reviewer's verdict against it is refused by
    // the web too, so the condition is read as exactly 100 and not as a flag.
    const claimed: SubmissionView = { ...unverified, report: { ...row.report!, overall: 99 } };
    expect(isPass(claimed)).toBe(false);
    // At 100 with every criterion unmet (a thin story), or with only one of
    // three met, the reviewer is refusing the work:
    // the web's copy refuses a report that claims a Pass there. The panels
    // themselves read `report.passed` from the API, whose own gate refuses
    // the same report, so the web's rule is pinned on `isPass` alone.
    const allUnmet: SubmissionView = { ...unverified, report: { ...row.report!, aiReview: { ...row.report!.aiReview, criteriaEvidence: row.report!.aiReview.criteriaEvidence!.map(item => ({ ...item, met: false, evidence: '', issue: 'Not shown.' })) } } };
    expect(isPass(allUnmet)).toBe(false); expect(verdict(allUnmet)).not.toBe('Pass');
    const oneOfThree: SubmissionView = { ...unverified, report: { ...row.report!, aiReview: { ...row.report!.aiReview, criteriaEvidence: row.report!.aiReview.criteriaEvidence!.map((item, at) => (at === 0 ? item : { ...item, met: false, evidence: '', issue: 'Not shown.' })) } } };
    expect(isPass(oneOfThree)).toBe(false);
    mocks.evidence.mockResolvedValue({ ...row, report: { ...row.report!, overall: 100 } });
    await act(async () => root.render(<SubmissionEvidence submissionId={row.id} />));
    expect(host.textContent).toContain('Reviewer advice');
    expect(host.textContent).toContain("Reviewer's advice on this passed work:");
    expect(host.textContent).not.toContain('Needs attention');
  });
  it('says in one line why a review at a rule-based 100 needs revision: every rule check passed and the reviewer found most criteria unmet', async () => {
    // A rule-based 100 where the reviewer found most criteria unmet still gates: the panel
    // draws Needs revision beside every rule check passed, and must say why.
    const row = submission(); delete row.report!.aiReview.assessmentError;
    row.report!.overall = 100; row.report!.aiReview.summary = 'The story names no acceptance criteria.';
    row.report!.criteria = [
      { key: 'story_structure', title: 'Story structure', evidence: [], score: 100, weight: 0.4 },
      { key: 'acceptance_criteria', title: 'Acceptance criteria', evidence: [], score: 100, weight: 0.3 },
      { key: 'scope_clarity', title: 'Scope clarity', evidence: [], score: 100, weight: 0.3 },
    ];
    row.report!.aiReview.criteriaEvidence = [
      { key: 'story_structure', met: true, evidence: 'story.json role and goal', issue: '', nextStep: '' },
      { key: 'acceptance_criteria', met: false, evidence: '', issue: 'No acceptance criteria.', nextStep: 'Add them.' },
      { key: 'scope_clarity', met: false, evidence: '', issue: 'The scope is not bounded.', nextStep: 'Bound it.' },
    ];
    const line = 'Every rule check passed; the reviewer found 2 of 3 criteria unmet, so this work needs revision:';
    expect(verdict(row)).toBe('Needs revision');
    await act(async () => root.render(<FeedbackPanel submission={row}/>));
    expect(host.querySelector('[data-testid="feedback-verdict"]')?.textContent).toContain('Needs revision');
    expect(host.querySelector('[data-testid="ai-review"]')?.textContent).toContain(`${line} The story names no acceptance criteria.`);
    expect(host.textContent!.split(line)).toHaveLength(2);
    expect(host.textContent).not.toContain("Reviewer's advice on this passed work:");
    await render(row);
    expect(host.textContent).toContain(`${line} The story names no acceptance criteria.`);
    expect(host.textContent!.split(line)).toHaveLength(2);
    // Every criterion unmet reads as such.
    const allUnmet: SubmissionView = { ...row, report: { ...row.report!, aiReview: { ...row.report!.aiReview, criteriaEvidence: row.report!.aiReview.criteriaEvidence!.map(item => ({ ...item, met: false })) } } };
    await act(async () => root.render(<FeedbackPanel submission={allUnmet}/>));
    expect(host.textContent).toContain('Every rule check passed; the reviewer found 3 of 3 criteria unmet, so this work needs revision:');
    // Below 100 a rule check failed and says so itself; an unavailable review and a Pass draw no such line.
    for (const other of [
      { ...row, report: { ...row.report!, overall: 99 } },
      { ...row, report: { ...row.report!, aiReview: { ...row.report!.aiReview, assessmentError: 'invalid_assessment' } } },
      { ...row, passed: true, verifiedPass: true, report: { ...row.report!, passed: true, aiReview: { ...row.report!.aiReview, criteriaEvidence: row.report!.aiReview.criteriaEvidence!.map((item, at) => (at === 2 ? item : { ...item, met: true })) } } },
    ] as SubmissionView[]) {
      await act(async () => root.render(<FeedbackPanel submission={other}/>));
      expect(host.textContent).not.toContain('Every rule check passed;');
    }
  });
  it.each(['failed', 'completed'] as const)('treats a %s record without a report as unavailable while retaining its snapshot', async status => {
    const row = submission(); row.status = status; row.report = null;
    await render(row);
    expect(host.textContent).toContain('Your review is unavailable.');
    expect(host.textContent).toContain('Exact submitted contract.');
    expect(isPass(row)).toBe(false);
  });
  it('does not call an in-flight review unavailable', async () => {
    const row = submission(); row.status = 'queued'; row.report = null;
    await render(row);
    expect(host.textContent).toContain('Your design work is in review.');
    expect(host.textContent).not.toContain('Your review is unavailable.');
    expect([...host.querySelectorAll('a')].some(a => a.textContent?.includes('Revise your work'))).toBe(false);
    expect(host.textContent).toContain('a revision verdict is recorded only when the review finishes');
  });
  it('shows criterion issues and actionable next steps even without the older criterion evidence array', async () => {
    const row = submission(); delete row.report!.aiReview.assessmentError;
    row.report!.criteria = [{ key: 'contract', title: 'Consistent contract', evidence: [], score: 0, weight: 1 }];
    row.report!.aiReview.criteriaEvidence = [{ key: 'contract', met: false, evidence: 'design.json records a success response.', issue: 'The missing-record response in design.json is not explained.', nextStep: 'Describe its missing-record behavior in design.json.' }];
    const original = structuredClone(row);
    await render(row);
    expect(host.textContent).toContain('The missing-record response in design.json is not explained.');
    expect(host.textContent).toContain('Describe its missing-record behavior in design.json.');
    const inspect = [...host.querySelectorAll('a')].find(a => a.textContent === 'Inspect submitted design.json')!;
    const id = decodeURIComponent(inspect.hash.slice(1));
    const details = document.getElementById(id) as HTMLDetailsElement;
    const scroll = vi.fn(); details.scrollIntoView = scroll;
    expect(details.open).toBe(false);
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    await act(async () => { inspect.dispatchEvent(modified); });
    expect(modified.defaultPrevented).toBe(false); expect(details.open).toBe(false); expect(scroll).not.toHaveBeenCalled();
    const historyState = { retainedRouterState: true };
    window.history.replaceState(historyState, '', window.location.pathname);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { inspect.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe(inspect.hash); expect(window.history.state).toEqual(historyState);
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(details.open).toBe(true); expect(document.activeElement).toBe(details.querySelector('summary'));
    window.history.replaceState(null, '', window.location.pathname);
    expect([...host.querySelectorAll('a')].find(a => a.textContent === 'Open current design.json')?.getAttribute('href')).toBe('/workspace/phase?file=design.json');
    expect([...host.querySelectorAll('a')].find(a => a.textContent === 'Revise this criterion in your project')?.getAttribute('href')).toBe('/workspace/phase/design');
    expect(row).toEqual(original);
  });
  it('keeps submitted-file inspection available to teachers without offering learner edit links', async () => {
    const row = submission(); delete row.report!.aiReview.assessmentError;
    row.report!.checks[0].detail = 'Inspect design.json.';
    mocks.evidence.mockResolvedValue(row);
    await act(async () => root.render(<SubmissionEvidence submissionId="review" teacher phase={{ id: 'phase', key: 'design', status: 'in_progress' }} />));
    expect([...host.querySelectorAll('a')].some(a => a.textContent === 'Inspect submitted design.json')).toBe(true);
    expect([...host.querySelectorAll('a')].some(a => a.textContent?.startsWith('Open current'))).toBe(false);
  });
  it('does not label unavailable provider criteria as revision work in the workspace panel', async () => {
    const row = submission();
    row.report!.criteria = [{ key: 'contract', title: 'Consistent contract', evidence: [], score: 0, weight: 1 }];
    row.report!.aiReview.criteriaEvidence = [{ key: 'contract', met: false, evidence: 'No assessment was retained.', issue: '', nextStep: '' }];
    await act(async () => root.render(<FeedbackPanel submission={row}/>));
    expect(host.querySelector('[data-testid="feedback-verdict"]')?.textContent).toContain('Review unavailable');
    expect(host.textContent).not.toContain('Needs revision');
  });
  // A review the AI gate refused after its queue wait says the class is busy, not that the provider failed.
  it('says the reviewer was busy with the class when the review was refused for load, and still no Pass', async () => {
    const row = submission();
    row.report!.aiReview.assessmentError = AI_REVIEW_BUSY_MESSAGE;
    await act(async () => root.render(<FeedbackPanel submission={row}/>));
    const verdictBox = host.querySelector('[data-testid="feedback-verdict"]')!;
    expect(verdictBox.textContent).toContain('Review unavailable');
    expect(verdictBox.textContent).toContain('The AI reviewer is busy with the rest of the class. No Pass was awarded. Resubmit in a minute.');
    expect(verdictBox.textContent).not.toContain('Retry when the provider is available');
    expect(gateReason(row.report)).toBe('The AI reviewer was busy with the rest of the class. Resubmit in a minute; no Pass was recorded.');
  });
  it('keeps the provider sentence for a review the provider could not complete', async () => {
    const row = submission();
    await act(async () => root.render(<FeedbackPanel submission={row}/>));
    expect(host.querySelector('[data-testid="feedback-verdict"]')?.textContent).toContain('The AI review could not complete. No Pass was awarded. Retry when the provider is available.');
    expect(gateReason(row.report)).toBe('The assessment could not be completed. Retry the review; no Pass was recorded.');
  });
  it('does not leave a completed workspace review with missing evidence in a perpetual reviewing state', async () => {
    const row = submission(); row.report = null;
    await act(async () => root.render(<FeedbackPanel submission={row}/>));
    expect(host.textContent).toContain('Review unavailable.');
    expect(host.textContent).not.toContain('Reviewing your');
  });
  it('refreshes the summary once when the exact pending review settles and keeps the evidence mounted', async () => {
    const row = submission(); delete row.report!.aiReview.assessmentError;
    const history = { id: row.id, phaseStateId: 'phase', status: row.status, passed: false, verifiedPass: false, createdAt: row.createdAt, reviewUnavailable: false };
    mocks.history.mockResolvedValueOnce([{ ...history, status: 'queued' }]).mockResolvedValue([history]);
    mocks.evidence.mockResolvedValue(row);
    await act(async () => root.render(<FeedbackPage />));
    expect(host.textContent).toContain('Use the feedback. Strengthen your work.');
    expect(mocks.history).toHaveBeenCalledTimes(2); expect(mocks.evidence).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<FeedbackPage />));
    expect(mocks.history).toHaveBeenCalledTimes(2); expect(mocks.evidence).toHaveBeenCalledTimes(1);
  });
  it('keeps loaded evidence and keyboard focus when a delayed summary refresh fails and retries', async () => {
    const row = submission(); delete row.report!.aiReview.assessmentError;
    const history = { id: row.id, phaseStateId: 'phase', status: row.status, passed: false, verifiedPass: false, createdAt: row.createdAt, reviewUnavailable: false };
    const refresh = deferred<typeof history[]>(), retry = deferred<typeof history[]>();
    mocks.history.mockResolvedValueOnce([{ ...history, status: 'queued' }]).mockReturnValueOnce(refresh.promise).mockReturnValueOnce(retry.promise);
    mocks.evidence.mockResolvedValue(row);
    await act(async () => root.render(<FeedbackPage />));
    const evidence = host.querySelector('.exp-files')!;
    const file = evidence.querySelector('details')!; file.open = true;
    const summary = file.querySelector('summary')!; summary.focus();
    await act(async () => refresh.reject(new Error('Latest history is offline.')));
    expect(host.textContent).toContain('Your last loaded review history is still shown.');
    expect(host.querySelector('.exp-files')).toBe(evidence); expect(file.open).toBe(true); expect(document.activeElement).toBe(summary);
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Retry reviews')!;
    await act(async () => button.click());
    expect(host.querySelector('.exp-files')).toBe(evidence); expect(host.textContent).toContain('Checking for newer reviews.');
    expect([...host.querySelectorAll('button')].find(item => item.textContent === 'Refreshing reviews…')?.disabled).toBe(true);
    await act(async () => retry.resolve([history]));
    expect(host.querySelector('.exp-files')).toBe(evidence); expect(file.open).toBe(true); expect(host.textContent).not.toContain('Latest history is offline.');
    expect(host.textContent).toContain('Use the feedback. Strengthen your work.');
    expect(mocks.history).toHaveBeenCalledTimes(3); expect(mocks.evidence).toHaveBeenCalledTimes(1);
  });
});

/**
 * A quiz's report, in the panel that draws every other report.
 *
 * Scoring a multiple-choice paper is set equality, so no model is asked and
 * `aiReview.provider` is `'not-applicable'`: a value that means *no provider
 * was needed*, deliberately not the `'unavailable'` stub that means one was
 * asked and did not answer. Drawn straight into a chip, that token would show
 * a learner reading their marked paper a raw enum member as copy. It gets
 * words here, and the Review block's own purpose line names no mentor, since
 * no mentor read the paper.
 */
describe("a quiz's report in the phase feedback panel", () => {
  const quizReport = (): FeedbackReport => ({
    assessmentMode: 'strict_binary', overall: 80, passed: true,
    criteria: [{ key: 'quiz', title: 'Quiz', evidence: [], score: 80, weight: 1 }],
    checks: [{ id: 'quiz', label: 'Quiz', status: 'passed', detail: '4 of 5 correct.' }],
    aiReview: {
      verdict: 'pass', summary: 'Scored against the key your teacher sealed with this quiz. No model was asked — a multiple-choice answer is right or wrong by the key.',
      strengths: [], improvements: [], processNote: '', provider: 'not-applicable',
      criteriaEvidence: [{ key: 'quiz', met: true, evidence: '80% on this paper, against a pass mark of 60%.', issue: '', nextStep: '' }],
    },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
  });
  const quizRow = (): SubmissionView => ({ ...submission(), score: 80, passed: true, report: quizReport() });

  it('never shows the learner a raw provider token where a name belongs', async () => {
    await act(async () => root.render(<FeedbackPanel submission={quizRow()} />));

    expect(host.querySelector('[data-testid="ai-review"]')).not.toBeNull();
    expect(host.textContent).not.toContain('not-applicable');
    expect(host.querySelector('[data-testid="ai-review"]')?.textContent).toContain('Marked by the key');
  });

  it('does not credit a mentor with a paper no mentor read', async () => {
    await act(async () => root.render(<FeedbackPanel submission={quizRow()} />));

    const review = host.querySelector('[data-testid="ai-review"]')!;
    expect(review.textContent).toContain('Your answers, marked against the key your teacher set. No model was asked.');
    expect(review.textContent).not.toContain('Written by the phase mentor');
    // And none of this is the degraded-grading banner: a paper that scored 80
    // is a pass, and `'not-applicable'` is not `'unavailable'`.
    expect(host.querySelector('[data-testid="feedback-verdict"]')?.textContent).toContain('Pass');
    expect(host.textContent).not.toContain('The AI review could not complete');
  });

  // Every other provider's chip is a labelled fact in the mentor's provider name, never the bare id.
  it('says every other provider as "Reviewed by" and its name', async () => {
    const row = submission();
    delete row.report!.aiReview.assessmentError;
    await act(async () => root.render(<FeedbackPanel submission={row} />));

    const review = host.querySelector('[data-testid="ai-review"]')!;
    expect(review.textContent).toContain('Reviewed by Fixture');
    expect(review.textContent).toContain('Written by the phase mentor from your artefact and the checks above.');
  });
});
