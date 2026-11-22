// @vitest-environment jsdom
/**
 * The profile's blank-name draft (browser proof: e2e/account.spec.ts).
 *
 * A display name that is blank after trimming cannot be saved (Save is
 * disabled), so a draft that restores it paints an unsavable, empty required
 * field over the saved name. Not writing the draft at all is also wrong: the
 * draft from one keystroke earlier ("A") would survive in memory and in
 * sessionStorage and come back on reload. The draft is kept without its name:
 * the other fields survive, and the name is the saved profile's.
 */
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
beforeEach(() => {
  clearProfileDraft(); sessionStorage.clear(); mocks.user = original(); mocks.token = 'session-a'; mocks.saveProfile.mockReset(); mocks.me.mockReset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearProfileDraft(); vi.restoreAllMocks(); });


it('clearing the name one key at a time and reloading brings back the saved name and keeps the bio edit', async () => {
  await render();
  type('Display name', 'Ada');
  type('About you', 'A bio edit to keep');
  type('Display name', 'Ad');
  type('Display name', 'A');
  type('Display name', '');
  // The one-keystroke-earlier draft ("A") must not be what survives.
  const stored = JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY)!);
  expect(stored.fields.displayName).toBeUndefined();
  expect(stored.fields.bio).toBe('A bio edit to keep');
  expect(host.textContent).not.toContain('Browser storage is unavailable');

  act(() => root.render(<p>Another page</p>));
  await render();
  expect(field('Display name').value).toBe('A learner');
  expect(field('About you').value).toBe('A bio edit to keep');
});

it('a blank-after-trimming name is written without a name, and reported as kept', () => {
  const kept = writeProfileDraft({ owner: 'learner-a', baseVersion: 1, fields: { displayName: '   ', avatar: 2, bio: 'Bio', goals: 'Goal' } });
  expect(kept).toBe(true);
  const read = readProfileDraft('learner-a');
  expect(read?.fields).toEqual({ avatar: 2, bio: 'Bio', goals: 'Goal' });
  expect('displayName' in (read?.fields ?? {})).toBe(false);
});

it('a valid name is kept as it always was', () => {
  writeProfileDraft({ owner: 'learner-a', baseVersion: 1, fields: { displayName: ' Ada ', avatar: 0, bio: '', goals: '' } });
  expect(readProfileDraft('learner-a')?.fields.displayName).toBe(' Ada ');
});

it('a stored draft whose name is blank restores the other fields and never the blank', async () => {
  sessionStorage.setItem(PROFILE_DRAFT_KEY, JSON.stringify({ owner: 'learner-a', baseVersion: 1, fields: { displayName: '', avatar: 0, bio: 'Stored bio', goals: '' } }));
  await render();
  expect(field('Display name').value).toBe('A learner');
  expect(field('About you').value).toBe('Stored bio');
});

it('reads a draft stored under the dotted key learnsdlc.profile-draft.v1 once, and moves it to lsdlc_profile_draft', () => {
  const draft = { owner: 'learner-a', baseVersion: 1, fields: { displayName: 'Ada', avatar: 2, bio: 'Kept bio', goals: '' } };
  sessionStorage.setItem('learnsdlc.profile-draft.v1', JSON.stringify(draft));
  expect(PROFILE_DRAFT_KEY).toBe('lsdlc_profile_draft');
  expect(readProfileDraft('learner-a')).toEqual(draft);
  expect(JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY)!)).toEqual(draft);
  expect(sessionStorage.getItem('learnsdlc.profile-draft.v1')).toBeNull();
  // Cleared after the move, it stays cleared.
  clearProfileDraft();
  expect(readProfileDraft('learner-a')).toBeNull();
});

it('a draft under the dotted key is still restored while a full storage refuses the move, and clearing it removes it there too', () => {
  const draft = { owner: 'learner-a', baseVersion: 1, fields: { displayName: 'Ada', avatar: 0, bio: 'Held bio', goals: '' } };
  sessionStorage.setItem('learnsdlc.profile-draft.v1', JSON.stringify(draft));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); });
  expect(readProfileDraft('learner-a')?.fields.bio).toBe('Held bio');
  expect(sessionStorage.getItem('learnsdlc.profile-draft.v1')).not.toBeNull();
  clearProfileDraft('learner-a');
  expect(sessionStorage.getItem('learnsdlc.profile-draft.v1')).toBeNull();
  expect(readProfileDraft('learner-a')).toBeNull();
});
