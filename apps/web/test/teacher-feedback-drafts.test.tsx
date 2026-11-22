// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubmissionEvidence } from '@/components/experience/SubmissionEvidence';
import { createTeacherDraftStore, type TeacherDraftStore } from '@/components/staff/console/teacher-feedback-drafts';
const mocks = vi.hoisted(() => ({ owner: 'teacher-session', enders: new Set<() => void>(), write: vi.fn(), notes: vi.fn(), saved: vi.fn() }));
vi.mock('@/lib/session', () => ({ getToken: () => mocks.owner, onSessionEnd: (fn: () => void) => { mocks.enders.add(fn); return () => mocks.enders.delete(fn); } }));
vi.mock('@/lib/api', () => ({ api: {}, describeError: (error: Error) => error.message }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherEvidence: async (id: string) => ({ id, status: 'completed', passed: false, verifiedPass: false, report: null, createdAt: '2026-09-13T00:00:00Z' }), teacherFeedback: mocks.notes, writeFeedback: mocks.write } }));
vi.mock('@/components/experience/shared', () => ({ LoadingState: () => <p>Loading</p>, StatusBadge: () => <span>Original verdict</span>, formatDate: (date: string) => date, isReviewUnavailable: () => true }));
let host: HTMLDivElement, root: Root, store: TeacherDraftStore;
const scopes = { A: { learnerId: 'learner-a', phaseId: 'phase-a', submissionId: 'submission-a' }, B: { learnerId: 'learner-b', phaseId: 'phase-b', submissionId: 'submission-b' } };
const render = async (record: 'A' | 'B') => act(async () => root.render(<SubmissionEvidence key={record} teacher submissionId={scopes[record].submissionId} draftScope={scopes[record]} drafts={store} onFeedback={mocks.saved} />));
const input = () => host.querySelector('textarea')!;
const select = () => host.querySelector('select')!;
const text = (value: string) => act(() => { fireEvent.change(input(), { target: { value: value } }); });
const action = (value: string) => act(() => { fireEvent.change(select(), { target: { value: value } }); });
const submit = () => act(async () => fireEvent.submit(host.querySelector('form')!));
const deferred = () => { let resolve!: (value: unknown) => void, reject!: (error: Error) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => { vi.clearAllMocks(); mocks.owner = 'teacher-session'; mocks.enders.clear(); mocks.notes.mockResolvedValue([]); store = createTeacherDraftStore(() => mocks.owner); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('keeps independent notes and actions when inspecting A, B and A again', async () => {
  await render('A'); text('Explain the boundary in learner A’s evidence.'); action('request_revision');
  await render('B'); expect(input().value).toBe(''); expect(select().value).toBe('comment');
  text('The evidence for learner B is clear.'); action('acknowledge');
  await render('A'); expect(input().value).toBe('Explain the boundary in learner A’s evidence.'); expect(select().value).toBe('request_revision');
  await render('B'); expect(input().value).toBe('The evidence for learner B is clear.'); expect(select().value).toBe('acknowledge');
  expect(mocks.write).not.toHaveBeenCalled();
});
it('keeps a pending A send locked across remounts and clears only A after confirmed success', async () => {
  const pending = deferred(); mocks.write.mockReturnValue(pending.promise);
  await render('A'); text('A confirmed note.'); await submit(); expect(input().disabled).toBe(true);
  await render('B'); text('B remains unsent.');
  await render('A'); expect(input().disabled).toBe(true); await submit(); expect(mocks.write).toHaveBeenCalledTimes(1);
  await render('B');
  await act(async () => pending.resolve({ id: 'note-a', action: 'comment', text: 'A confirmed note.', createdAt: '2026-09-13T00:00:00Z', authorName: 'Teacher' }));
  expect(input().value).toBe('B remains unsent.');
  await render('A'); expect(input().value).toBe(''); expect(host.textContent).toContain('Feedback saved on this submission'); expect(host.textContent).toContain('A confirmed note.');
  await render('B'); expect(input().value).toBe('B remains unsent.'); expect(mocks.saved).toHaveBeenCalledTimes(1);
});
it('retains failed A text and its idempotency key after inspecting B and retrying A', async () => {
  mocks.write.mockRejectedValueOnce(new Error('Connection lost'));
  await render('A'); text('Please clarify A.'); await submit();
  const request = mocks.write.mock.calls[0]; expect(request[0]).toBe('submission-a');
  await render('B'); text('Separate B note.'); await render('A');
  expect(input().value).toBe('Please clarify A.'); expect(host.textContent).toContain('Connection lost');
  mocks.write.mockResolvedValue({ id: 'note-a', action: 'comment', text: 'Please clarify A.', createdAt: '2026-09-13T00:00:00Z', authorName: 'Teacher' });
  await submit(); expect(mocks.write.mock.calls[1][1].requestId).toBe(request[1].requestId);
  await render('B'); expect(input().value).toBe('Separate B note.');
});
it('clears on logout and ignores the previous owner’s late successful send', async () => {
  const pending = deferred(); mocks.write.mockReturnValue(pending.promise);
  await render('A'); text('Old owner private note.'); await submit();
  act(() => { mocks.owner = 'another-teacher-session'; mocks.enders.forEach(fn => fn()); });
  expect(input().value).toBe(''); expect(input().disabled).toBe(false);
  text('New owner note.');
  await act(async () => pending.resolve({ id: 'old-note', action: 'comment', text: 'Old owner private note.' }));
  expect(input().value).toBe('New owner note.'); expect(mocks.saved).not.toHaveBeenCalled();
  await render('B'); expect(input().value).toBe('');
});
it('also rejects cached text when the token changes without an end event', async () => {
  await render('A'); text('Previous token note.');
  mocks.owner = 'new-token'; await render('B'); await render('A');
  expect(input().value).toBe(''); expect(mocks.write).not.toHaveBeenCalled();
});

it('does not let a delayed pre-save comments read erase a newly confirmed note', async () => {
  const pendingRead = deferred(); mocks.notes.mockReturnValueOnce(pendingRead.promise);
  mocks.write.mockResolvedValue({ id: 'confirmed', action: 'comment', text: 'Newly confirmed feedback.', createdAt: '2026-09-13T00:00:00Z', authorName: 'Teacher' });
  await render('A'); text('Newly confirmed feedback.'); await submit();
  await act(async () => pendingRead.resolve([]));
  expect(host.textContent).toContain('Newly confirmed feedback.');
  expect(host.textContent).not.toContain('No teacher feedback on this submission yet.');
  expect(input().value).toBe(''); expect(mocks.write).toHaveBeenCalledTimes(1);
});
