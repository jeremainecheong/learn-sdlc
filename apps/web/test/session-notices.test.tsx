// @vitest-environment jsdom
/**
 * What the shell says about the hour a session has, and about the click the end
 * of the last one ate.
 *
 * Two sentences. A managed
 * deployment signs a session that lives one hour and there is no refresh
 * endpoint to extend it, so the product's only honest move is to say the hour
 * is nearly up while there is still time to act; and once the learner is back,
 * to name the submission that was not recorded and put their words back in the
 * field.
 *
 * Neither line may overstate what happened. A sentence a learner typed and
 * never sent is *not* a lost submission, and only the record `api.submit`
 * writes may say one was not recorded. Neither line is an `alert`, neither
 * takes focus, and every token here is an obvious fake with no signature.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';

const path = vi.hoisted(() => ({ value: '/workspace/p1', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => path.value,
  useSearchParams: () => new URLSearchParams(path.search),
}));

type Commit = typeof import('@/lib/commit');
type Pending = typeof import('@/lib/pending-action');
type Session = typeof import('@/lib/session');

let commit: Commit;
let pending: Pending;
let session: Session;
let SessionNotices: typeof import('@/components/shell/SessionNotices').SessionNotices;

const ME: UserProfile = {
  id: 'notice-learner-a',
  email: 'a@example.test',
  displayName: 'Notice Learner',
  role: 'LEARNER',
  cohort: 'default',
  createdAt: '2026-09-17T00:00:00Z',
  onboardingCompleted: true,
};
const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);
/** The shell's recheck interval, as SessionNotices sets it. */
const RECHECK = 30_000;

/** A JWT-shaped string with the given seconds of life and no real signature. */
function tokenLasting(seconds: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ sub: ME.id, exp: Math.floor(NOW / 1000) + seconds })}.not-a-signature`;
}

let host: HTMLDivElement;
let root: Root;
/** jsdom will not navigate, and a refused anchor click is not what is asserted. */
const swallowNavigation = (event: Event) => event.preventDefault();

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/workspace/p1');
  path.value = '/workspace/p1';
  path.search = '';
  vi.resetModules();
  session = await import('@/lib/session');
  pending = await import('@/lib/pending-action');
  commit = await import('@/lib/commit');
  ({ SessionNotices } = await import('@/components/shell/SessionNotices'));
  document.addEventListener('click', swallowNavigation);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll('#main').forEach((node) => node.remove());
  document.removeEventListener('click', swallowNavigation);
  session.clearSession();
  window.localStorage.clear();
  vi.useRealTimers();
});

const mount = () => act(() => { root.render(<SessionNotices />); });
const find = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/**
 * The words a screen reader is handed for a region: everything in it but the
 * parts marked `aria-hidden`, which are drawn for the eye alone.
 */
const announced = (el: HTMLElement): string => {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};
/** The page's own landmark, which every room draws and focus belongs back on. */
const givePageALandmark = (): HTMLElement => {
  const main = document.createElement('main');
  main.id = 'main';
  main.tabIndex = -1;
  document.body.append(main);
  return main;
};
const remount = () => {
  act(() => root.unmount());
  root = createRoot(host);
  mount();
};

describe('the line that says the hour is nearly up', () => {
  it('warns politely in the last five minutes and not before', () => {
    session.setAuthSession(tokenLasting(10 * 60), ME);
    mount();
    expect(find('session-ending')).toBeNull();

    session.setAuthSession(tokenLasting(4 * 60), ME);
    remount();
    const line = find('session-ending')!;
    expect(line).not.toBeNull();
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('aria-live')).toBe('polite');
    expect(line.textContent).toContain('about 4 minutes');
    // Only the files are saved as they are typed. The mentor composer and the
    // explanation draft are not, so the line may not say "your work".
    expect(line.textContent).toContain('Your files are saved as you type.');
    // Never an alert: an alert interrupts whatever a screen reader is saying.
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('is read out once rather than again on every minute that passes', () => {
    // role="status" is atomic: any change to the region is the whole sentence
    // read again, and the minutes change five times inside the warning window.
    // So the number is drawn for the eye and the announced words never move.
    session.setAuthSession(tokenLasting(4 * 60 + 30), ME);
    mount();
    const line = find('session-ending')!;
    const first = announced(line);
    expect(first).toContain('Your sign-in ends soon');
    expect(first).not.toContain('about');
    expect(line.textContent).toContain('about 5 minutes');

    act(() => { vi.advanceTimersByTime(90_000); });
    const after = find('session-ending')!;
    expect(after.textContent).toContain('about 3 minutes');
    expect(announced(after)).toBe(first);
  });

  it('says nothing about a session whose end it cannot read', () => {
    // A local deployment signs a seven-day token, and some carry no `exp` this
    // can read at all. Silence, not a warning at the wrong moment.
    session.setAuthSession('not.a.readable.jwt', ME);
    mount();
    expect(find('session-ending')).toBeNull();
  });

  it('says nothing once the hour is already up', () => {
    session.setAuthSession(tokenLasting(-30), ME);
    mount();
    expect(find('session-ending')).toBeNull();
  });

  it('starts saying it as the last five minutes arrive, without a reload', () => {
    session.setAuthSession(tokenLasting(6 * 60), ME);
    mount();
    expect(find('session-ending')).toBeNull();
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(find('session-ending')?.textContent).toContain('minute');
  });

  it('points the warning at a sign-in that returns to this page', () => {
    session.setAuthSession(tokenLasting(4 * 60), ME);
    mount();
    const link = find('session-ending-signin') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/login?next=%2Fworkspace%2Fp1');
    // Nothing has ended yet, so the sign-in page must not claim it has.
    expect(link.getAttribute('href')).not.toContain('reason=expired');
  });

  it('keeps the half-written message when the learner signs in early', () => {
    session.setAuthSession(tokenLasting(4 * 60), ME);
    commit.setCommitDraft('p1', 'Half a sentence about the boundary');
    mount();
    act(() => { find('session-ending-signin')!.click(); });
    expect(pending.readPendingAction('p1')).toMatchObject({
      kind: 'draft',
      text: 'Half a sentence about the boundary',
    });
  });

  it('never moves focus to the warning', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    session.setAuthSession(tokenLasting(4 * 60), ME);
    mount();
    expect(find('session-ending')).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('stops saying it for the rest of the document when the learner hides it', () => {
    session.setAuthSession(tokenLasting(4 * 60), ME);
    mount();
    act(() => { find('session-ending-hide')!.click(); });
    expect(find('session-ending')).toBeNull();
    // And a navigation does not bring it back: the frame is mounted once.
    act(() => { path.value = '/progress'; root.render(<SessionNotices />); });
    expect(find('session-ending')).toBeNull();
  });

  it('puts the keyboard back on the page when the line it was in goes away', () => {
    // The button is inside the line it removes, so without this the caret is
    // dropped on the document and the next Tab restarts from the sidebar.
    const main = givePageALandmark();
    session.setAuthSession(tokenLasting(4 * 60), ME);
    mount();
    const hide = find('session-ending-hide')!;
    hide.focus();
    act(() => { hide.click(); });
    expect(find('session-ending')).toBeNull();
    expect(document.activeElement).toBe(main);
  });

  it('holds one repeat for the whole shell and gives it up on unmount', () => {
    const started = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    session.setAuthSession(tokenLasting(4 * 60), ME);
    mount();
    expect(started.mock.calls.map(([, delay]) => delay)).toEqual([RECHECK]);
    const handle = started.mock.results[0].value;
    act(() => root.unmount());
    root = createRoot(host);
    expect(cleared.mock.calls.map(([given]) => given)).toContain(handle);
  });

  it('gives up the repeat once the hour is up rather than ticking for ever', () => {
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    session.setAuthSession(tokenLasting(60), ME);
    mount();
    expect(find('session-ending')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(RECHECK * 3); });
    expect(find('session-ending')).toBeNull();
    expect(cleared).toHaveBeenCalled();
  });
});

describe('the line that says a submission was not recorded', () => {
  it('names the submission that was not recorded, and puts the words back', () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'Fix the overdue boundary' });
    mount();
    const line = find('session-interrupted')!;
    expect(line).not.toBeNull();
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('aria-live')).toBe('polite');
    expect(line.textContent).toContain('You were signed out before your submission was recorded.');
    expect(line.textContent?.toLowerCase()).toContain('your files are kept');
    expect(line.textContent).toContain('what you typed is back in the field');
    expect(commit.commitDraft('p1')).toBe('Fix the overdue boundary');
  });

  it('never calls a message that was only typed a lost submission', () => {
    // The stash on the way out records a draft, not an attempt. Telling a
    // learner their submission was lost when they never pressed Submit is the
    // product saying something untrue.
    session.setAuthSession(tokenLasting(3_600), ME);
    commit.setCommitDraft('p1', 'Only ever typed');
    commit.stashCommitDrafts();
    commit.resetCommitDrafts();
    mount();
    expect(find('session-interrupted')).toBeNull();
    // The words still come back; they are simply not announced as a loss.
    expect(commit.commitDraft('p1')).toBe('Only ever typed');
  });

  it('claims nothing about words when the submission carried none', () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission' });
    mount();
    expect(find('session-interrupted')!.textContent).not.toContain('what you typed');
  });

  it('says nothing to a learner with nothing pending', () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    mount();
    expect(find('session-interrupted')).toBeNull();
  });

  it('says nothing about another learner’s interrupted submission', () => {
    window.localStorage.setItem(
      'lsdlc_pending_p1',
      JSON.stringify({ at: NOW, by: 'somebody-else', kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'theirs' }),
    );
    session.setAuthSession(tokenLasting(3_600), ME);
    mount();
    expect(find('session-interrupted')).toBeNull();
    expect(commit.commitDraft('p1')).toBe('');
  });

  it('stops saying it once the learner dismisses it', () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'Fix the overdue boundary' });
    mount();
    act(() => { find('session-interrupted-dismiss')!.click(); });
    expect(find('session-interrupted')).toBeNull();
    expect(pending.readPendingAction('p1')).toBeNull();
    // Dismissing the sentence does not throw away the sentence they wrote.
    expect(commit.commitDraft('p1')).toBe('Fix the overdue boundary');
  });

  it('stops saying it the moment the submission is recorded', () => {
    // The shell is mounted once for the whole tab, so a line that reads itself
    // only on mount goes on telling a learner their submission was not
    // recorded after they have submitted it again: above the very room they
    // submitted it from, with "Submit again" under it.
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'Fix the overdue boundary' });
    mount();
    expect(find('session-interrupted')).not.toBeNull();
    // Exactly what `api.submit` does the moment the API has the submission.
    act(() => { pending.forgetPendingAction('p1'); });
    expect(find('session-interrupted')).toBeNull();
  });

  it('goes on saying it while the resubmission is still in flight', () => {
    // `api.submit` writes the record again as it sends. That is the attempt
    // being made, not one that was lost, and it must not make the line flicker.
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'Fix the overdue boundary' });
    mount();
    act(() => {
      pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'Fix the overdue boundary' });
    });
    expect(find('session-interrupted')).not.toBeNull();
  });

  it('puts the keyboard back on the page when the learner dismisses it', () => {
    const main = givePageALandmark();
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission' });
    mount();
    const dismiss = find('session-interrupted-dismiss')!;
    dismiss.focus();
    act(() => { dismiss.click(); });
    expect(find('session-interrupted')).toBeNull();
    expect(document.activeElement).toBe(main);
  });

  it('does not overwrite what the learner has started typing again', () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'the older words' });
    commit.setCommitDraft('p1', 'what I am writing now');
    mount();
    expect(commit.commitDraft('p1')).toBe('what I am writing now');
  });
});

describe('what the sign-in page says about the session that ended', () => {
  const showNotice = async () => {
    const { SessionEndedNotice } = await import('@/app/login/SessionEndedNotice');
    path.search = 'reason=expired';
    act(() => { root.render(<SessionEndedNotice />); });
    return find('session-ended')!;
  };

  it('says what happened, and claims nothing about words nobody kept', async () => {
    const line = await showNotice();
    expect(line.textContent).toContain('Your session ended');
    expect(line.textContent).toContain('carry on where you left off');
    // The half that tells a learner who lost a Submit what became of their
    // work.
    expect(line.textContent).toContain('Your files are kept');
    // What is not kept: the mentor composer and the explanation draft are
    // plain component state and die with the navigation to this page, so the
    // page may promise neither them nor "anything you had typed".
    expect(line.textContent).not.toContain('typed but not sent');
    expect(line.textContent).not.toContain('commit message');
  });

  it('names the commit message only once one has really been written out', async () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    commit.setCommitDraft('p1', 'Fix the overdue boundary');
    // The leaving hook, which runs while the session is still whole.
    commit.stashCommitDrafts();
    session.clearSession();
    const line = await showNotice();
    expect(line.textContent).toContain('the commit message you had not sent');
  });

  it('says nothing about a message in a browser that kept nothing', async () => {
    session.setAuthSession(tokenLasting(3_600), ME);
    commit.setCommitDraft('p1', 'Fix the overdue boundary');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    commit.stashCommitDrafts();
    setItem.mockRestore();
    session.clearSession();
    const line = await showNotice();
    expect(line.textContent).not.toContain('commit message');
  });

  it('says nothing at all to a visitor who had no session', async () => {
    const { SessionEndedNotice } = await import('@/app/login/SessionEndedNotice');
    path.search = '';
    act(() => { root.render(<SessionEndedNotice />); });
    expect(find('session-ended')).toBeNull();
  });
});
