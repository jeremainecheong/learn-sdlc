// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackReport, SubmissionView } from '@learnsdlc/shared';
import { SubmissionEvidence } from '@/components/experience/SubmissionEvidence';

/**
 * The learner sees their teacher's sign-off.
 *
 * When the teacher signs a phase off with a reason, the learner's feedback
 * page must not still read "No teacher feedback on this submission yet."
 * just because a sign-off is not a note. The learner view asks
 * `GET /submissions/:id/sign-off` and shows the sign-off and its reason in
 * that sentence's place. The staff view never asks.
 */

const mocks = vi.hoisted(() => ({ evidence: vi.fn(), notes: vi.fn(), signOff: vi.fn(), teacherEvidence: vi.fn() }));
vi.mock('@/lib/api-experience', () => ({
  experienceApi: {
    teacherFeedback: mocks.notes,
    teacherEvidence: mocks.teacherEvidence,
    submissionSignOff: mocks.signOff,
  },
}));
vi.mock('@/lib/api', () => ({
  api: { getSubmissionWithFiles: mocks.evidence },
  describeError: (error: Error) => error.message,
  onSessionLeaving: () => () => {},
  onSignOut: () => () => {},
}));

const REASON = 'Heard the demo in class; the lend refusals are right.';
const EMPTY = 'No teacher feedback on this submission yet.';
const SIGNED = 'Signed off by your teacher.';

const report = (): FeedbackReport =>
  ({
    assessmentMode: 'strict_binary', overall: 100, passed: true, criteria: [],
    checks: [{ id: 'tests', label: 'Hidden tests', status: 'passed', detail: 'All hidden tests pass.' }],
    aiReview: { verdict: 'pass', summary: 'Pass.', strengths: [], improvements: [], processNote: '', provider: 'fixture' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
  }) as unknown as FeedbackReport;
const submission = (): SubmissionView => ({
  id: 'rev-2', status: 'completed', score: 100, passed: true, verifiedPass: true, report: report(),
  createdAt: '2026-10-06T10:05:00Z', workspaceSnapshot: { 'api/shelf.py': 'def add(): ...' },
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.evidence.mockResolvedValue(submission());
  mocks.teacherEvidence.mockResolvedValue(submission());
  mocks.notes.mockResolvedValue([]);
  mocks.signOff.mockResolvedValue({ signedOff: false, reason: null, signedOffAt: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const section = () =>
  [...host.querySelectorAll('section')].find((one) => one.querySelector('h2')?.textContent === 'Teacher feedback')!;
async function render(teacher = false) {
  await act(async () => root.render(<SubmissionEvidence submissionId="rev-2" teacher={teacher} />));
}

describe('the learner sees the teacher s sign-off', () => {
  it('shows the sign-off and its reason in place of the empty sentence', async () => {
    mocks.signOff.mockResolvedValue({ signedOff: true, reason: REASON, signedOffAt: '2026-10-06T11:00:00.000Z' });
    await render();
    expect(mocks.signOff).toHaveBeenCalledWith('rev-2');
    const text = section().textContent ?? '';
    expect(text).toContain(SIGNED);
    expect(text).not.toContain(EMPTY);
    const quotes = [...section().querySelectorAll('blockquote')].map((one) => one.textContent);
    expect(quotes).toContain(REASON);
  });

  it('still lists the teacher s notes below the sign-off', async () => {
    mocks.signOff.mockResolvedValue({ signedOff: true, reason: REASON, signedOffAt: '2026-10-06T11:00:00.000Z' });
    mocks.notes.mockResolvedValue([
      {
        id: 'note-1', submissionId: 'rev-2', phaseStateId: 'p', userId: 'u', cohortId: 'c', authorUserId: 't',
        authorName: 'Ms Tan', action: 'comment', text: 'Nice refusals.', createdAt: '2026-10-06T11:05:00.000Z',
      },
    ]);
    await render();
    const text = section().textContent ?? '';
    expect(text.indexOf(SIGNED)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Nice refusals.')).toBeGreaterThan(text.indexOf(SIGNED));
    expect(text).not.toContain(EMPTY);
  });

  it('shows the sign-off without a quote when the reason is empty', async () => {
    mocks.signOff.mockResolvedValue({ signedOff: true, reason: null, signedOffAt: '2026-10-06T11:00:00.000Z' });
    await render();
    expect(section().textContent).toContain(SIGNED);
    expect(section().querySelectorAll('blockquote')).toHaveLength(0);
  });

  it('keeps the empty sentence when the revision is not signed off', async () => {
    await render();
    expect(mocks.signOff).toHaveBeenCalledWith('rev-2');
    expect(section().textContent).toContain(EMPTY);
    expect(section().textContent).not.toContain(SIGNED);
  });

  it('keeps the empty sentence, and no alert, when the sign-off cannot be read', async () => {
    mocks.signOff.mockRejectedValue(new Error('offline'));
    await render();
    expect(section().textContent).toContain(EMPTY);
    expect(section().textContent).not.toContain('offline');
  });

  it('never asks in the staff view, which is unchanged', async () => {
    await render(true);
    expect(mocks.signOff).not.toHaveBeenCalled();
    expect(section().textContent).toContain(EMPTY);
    expect(section().textContent).not.toContain(SIGNED);
  });
});
