// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';
import ProfilePage from '@/app/(app)/profile/page';
import { clearProfileDraft, PROFILE_DRAFT_KEY, readProfileDraft, writeProfileDraft } from '@/components/experience/profile-draft';

const mocks = vi.hoisted(() => ({ user: null as UserProfile | null, token: 'session-a', saveProfile: vi.fn(), me: vi.fn(), changed: new Set<() => void>(), ended: new Set<() => void>() }));
vi.mock('@/lib/session', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSession: () => useSyncExternalStore((fn: () => void) => { mocks.changed.add(fn); return () => { mocks.changed.delete(fn); }; }, () => mocks.user, () => null),
    getSession: () => mocks.user, getToken: () => mocks.token,
    setSession: (user: UserProfile) => { mocks.user = user; mocks.changed.forEach(fn => fn()); },
    onSessionEnd: (fn: () => void) => { mocks.ended.add(fn); return () => { mocks.ended.delete(fn); }; },
  };
});
vi.mock('@/lib/api-experience', () => ({ experienceApi: { saveProfile: mocks.saveProfile } }));
vi.mock('@/lib/api', () => ({ api: { me: mocks.me }, describeError: (err: Error) => err.message }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: null, loading: false }) }));
vi.mock('@/components/experience/shared', () => ({
  ExperiencePage: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <main>{actions}{children}</main>,
  LoadingState: () => <p>Loading</p>, ReviewLoadError: () => null, CompactPhasePath: () => null,
  phaseArt: () => '', useReviews: () => ({ reviews: [], loading: false, refreshing: false, error: null, refresh: vi.fn() }), isPass: () => false,
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));
let host: HTMLDivElement, root: Root;
const original = (): UserProfile => ({ id: 'learner-a', displayName: 'A learner', email: 'a@example.test', role: 'LEARNER', cohort: 'default', createdAt: '2026-09-12T00:00:00Z', avatar: 0, bio: 'Saved bio', goals: '', onboardingCompleted: true, profileVersion: 1 });
const render = async () => { await act(async () => root.render(<ProfilePage />)); };
const field = (label: string) => [...host.querySelectorAll('label')].find(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim() === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;
const type = (label: string, value: string) => { act(() => { const node = field(label); fireEvent.change(node, { target: { value: value } }); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };
const submit = async () => { await act(async () => fireEvent.submit(host.querySelector('form')!)); };
beforeEach(() => {
  clearProfileDraft(); sessionStorage.clear(); mocks.user = original(); mocks.token = 'session-a'; mocks.saveProfile.mockReset(); mocks.me.mockReset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearProfileDraft(); vi.restoreAllMocks(); });

it('restores unsaved fields after remount while retaining their original CAS version', async () => {
  await render(); type('About you', 'My unsaved account draft');
  expect(JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY)!).baseVersion).toBe(1);
  act(() => root.render(<p>Another page</p>));
  mocks.user = { ...original(), bio: 'Saved in another tab', profileVersion: 2 };
  await render();
  expect(field('About you').value).toBe('My unsaved account draft');
  expect(host.textContent).toContain('Your unsaved draft is restored');
  expect(host.textContent).toContain('saved profile changed');
  mocks.saveProfile.mockRejectedValueOnce(new Error('Conflict: reload the saved version'));
  await submit();
  expect(mocks.saveProfile.mock.calls[0][0].baseVersion).toBe(1);
  expect(field('About you').value).toBe('My unsaved account draft');
});

it('requires an explicit comparison choice before rebasing a draft onto the latest profile', async () => {
  await render(); type('About you', 'My chosen changes');
  const latest = { ...original(), bio: 'Other tab changes', profileVersion: 2 };
  mocks.me.mockResolvedValue(latest);
  await click('Review saved profile');
  expect(host.textContent).toContain('Other tab changes');
  expect(JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY)!).baseVersion).toBe(1);
  await click('Keep my changes');
  expect(field('About you').value).toBe('My chosen changes');
  expect(JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY)!).baseVersion).toBe(2);
  mocks.saveProfile.mockResolvedValue({ ...latest, bio: 'My chosen changes', profileVersion: 3 });
  await submit();
  expect(mocks.saveProfile.mock.calls[0][0]).toMatchObject({ bio: 'My chosen changes', baseVersion: 2 });
  expect(sessionStorage.getItem(PROFILE_DRAFT_KEY)).toBeNull();
  expect(host.textContent).toContain('Your profile is saved.');
});

it('lets the learner explicitly discard the draft in favor of the fetched saved fields', async () => {
  await render(); type('About you', 'Discard this');
  mocks.me.mockResolvedValue({ ...original(), bio: 'Latest saved bio', profileVersion: 4 });
  await click('Review saved profile'); await click('Use saved profile');
  expect(field('About you').value).toBe('Latest saved bio');
  expect(sessionStorage.getItem(PROFILE_DRAFT_KEY)).toBeNull();
  expect(mocks.saveProfile).not.toHaveBeenCalled();
});

it('keeps a failed save recoverable and never adopts a late response from another session', async () => {
  await render(); type('About you', 'Preserve this on error');
  mocks.saveProfile.mockRejectedValueOnce(new Error('Offline'));
  await submit(); expect(host.textContent).toContain('Offline');
  expect(readProfileDraft('learner-a')?.fields.bio).toBe('Preserve this on error');
  let resolve!: (user: UserProfile) => void;
  mocks.saveProfile.mockImplementationOnce(() => new Promise<UserProfile>(yes => { resolve = yes; }));
  act(() => fireEvent.submit(host.querySelector('form')!));
  mocks.token = 'session-b'; mocks.user = { ...original(), id: 'learner-b', displayName: 'B learner' };
  await act(async () => resolve({ ...original(), bio: 'Preserve this on error', profileVersion: 2 }));
  expect(mocks.user.id).toBe('learner-b');
});

it('does not restore another account draft and clears the active draft on session end', () => {
  writeProfileDraft({ owner: 'learner-a', baseVersion: 1, fields: { displayName: 'A', avatar: 0, bio: 'Private', goals: '' } });
  expect(readProfileDraft('learner-b')).toBeNull();
  expect(sessionStorage.getItem(PROFILE_DRAFT_KEY)).toBeNull();
  writeProfileDraft({ owner: 'learner-a', baseVersion: 1, fields: { displayName: 'A', avatar: 0, bio: 'Private', goals: '' } });
  mocks.ended.forEach(fn => fn());
  expect(readProfileDraft('learner-a')).toBeNull();
});

it('rejects malformed stored draft values', () => {
  sessionStorage.setItem(PROFILE_DRAFT_KEY, JSON.stringify({ owner: 'learner-a', baseVersion: -1, fields: { displayName: 'A', avatar: 999, bio: 'Invalid', goals: '' } }));
  expect(readProfileDraft('learner-a')).toBeNull();
});

it('warns when browser storage cannot retain a draft across refresh', async () => {
  await render(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  type('About you', 'Only in memory');
  expect(host.textContent).toContain('Browser storage is unavailable; save before leaving.');
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

it('gives teachers teaching identity and class destinations without learner-only links', async () => {
  mocks.user = { ...original(), role: 'INSTRUCTOR' }; await render();
  expect(host.textContent).toContain('Teaching profile');
  expect(host.textContent).not.toContain('Your learning so far');
  expect(host.querySelectorAll('a[href="/classroom"],a[href="/progress"],a[href="/dashboard"]')).toHaveLength(0);
  expect(host.querySelector('a[href="/teacher"]')).not.toBeNull();
});
