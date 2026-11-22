// @vitest-environment jsdom
/**
 * The action a session ended under, and the words that went with it.
 *
 * A one-hour session can end at a Submit click, and the click would be lost
 * silently. Two things stand in the way: the 401 takes the
 * browser to the sign-in page, so no `catch` in the room draws anything; and
 * the commit message, held in lib/commit.ts's module-level Map, is cleared by
 * the session's own enders before the navigation. This record is what survives
 * that gap, bound by exactly the rules lib/api-workspace.ts already applies to
 * an unsaved file: one key per phase, stamped with the account that wrote it,
 * dropped when read by another account, expired after a day, swept from a
 * shared browser.
 *
 * Two rules it does *not* share, both deliberate and both pinned here: a read
 * while nobody is signed in leaves the record alone, because the signed-out gap
 * is the only reason it exists; and a stashed draft is never recorded as a
 * submission, because telling a learner a submission was lost when they had
 * merely typed a sentence would be the product saying something untrue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';

type Pending = typeof import('@/lib/pending-action');
type Session = typeof import('@/lib/session');

let pending: Pending;
let session: Session;

const learner = (id: string, email: string): UserProfile => ({
  id,
  email,
  displayName: 'Pending Learner',
  role: 'LEARNER',
  cohort: 'default',
  createdAt: '2026-09-17T00:00:00Z',
  onboardingCompleted: true,
});
const ME = learner('pending-owner-a', 'a@example.test');
const SOMEBODY_ELSE = learner('pending-owner-b', 'b@example.test');
const KEY = 'lsdlc_pending_p1';

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
  session = await import('@/lib/session');
  pending = await import('@/lib/pending-action');
  session.setAuthSession('token-fake-a', ME);
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.clearSession();
  window.localStorage.clear();
});

const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null');

describe('a pending action', () => {
  it('keeps what was typed when the session ends under a submission', () => {
    pending.rememberPendingAction({
      kind: 'submit',
      phaseId: 'p1',
      label: 'your submission',
      text: 'Fix the overdue boundary',
    });
    const record = pending.readPendingAction('p1');
    expect(record).toMatchObject({ kind: 'submit', phaseId: 'p1', text: 'Fix the overdue boundary' });
    expect(record?.by).toBe(ME.id);
    expect(typeof record?.at).toBe('number');
  });

  it('tells a stashed draft apart from a submission that was attempted', () => {
    pending.rememberPendingText('p1', 'Half a sentence');
    expect(pending.readPendingAction('p1')?.kind).toBe('draft');

    // An attempt that is already recorded keeps its kind: this only fills in
    // the sentence that went with it.
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p2', label: 'your submission' });
    pending.rememberPendingText('p2', 'The message that went with it');
    const attempted = pending.readPendingAction('p2');
    expect(attempted?.kind).toBe('submit');
    expect(attempted?.text).toBe('The message that went with it');
  });

  it('offers the attempted submission before a mere draft, and the newest of either', () => {
    pending.rememberPendingText('p1', 'only typed');
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p2', label: 'your submission', text: 'sent' });
    expect(pending.readAnyPendingAction()).toMatchObject({ phaseId: 'p2', kind: 'submit' });
    expect(pending.readPendingActions().map(r => r.phaseId)).toEqual(['p2', 'p1']);
  });

  it('never hands one learner another learner’s words', () => {
    // Written straight into storage, so what is asserted is this module's own
    // owner check rather than the sweep that runs when an account changes.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ at: Date.now(), by: SOMEBODY_ELSE.id, kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'theirs' }),
    );
    expect(pending.readPendingAction('p1')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(pending.readAnyPendingAction()).toBeNull();
  });

  it('leaves the record alone while nobody is signed in', () => {
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'kept' });
    session.clearSession();
    expect(pending.readPendingAction('p1')).toBeNull();
    expect(stored()?.text).toBe('kept');

    session.setAuthSession('token-fake-a-again', ME);
    expect(pending.readPendingAction('p1')?.text).toBe('kept');
  });

  it('forgets a record older than a day', () => {
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'stale' });
    window.localStorage.setItem(KEY, JSON.stringify({ ...stored(), at: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(pending.readPendingAction('p1')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('writes nothing when nobody is signed in', () => {
    session.clearSession();
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'nobody owns this' });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('forgets one phase, or every phase', () => {
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission' });
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p2', label: 'your submission' });
    pending.forgetPendingAction('p1');
    expect(pending.readPendingAction('p1')).toBeNull();
    expect(pending.readPendingAction('p2')).not.toBeNull();
    pending.forgetAllPendingActions();
    expect(pending.readAnyPendingAction()).toBeNull();
    // The token and the profile, and nothing of this module's.
    expect(window.localStorage.length).toBe(2);
  });

  it('survives a browser that refuses storage', () => {
    // Safari's private window and a locked-down lab profile: every accessor
    // throws. The profile is already in memory, so the owner is known and the
    // write is genuinely attempted rather than skipped.
    const refuse = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', {
      length: 0,
      key: refuse,
      getItem: refuse,
      setItem: refuse,
      removeItem: refuse,
      clear: () => undefined,
    });
    expect(session.getSession()?.id).toBe(ME.id);
    expect(() => pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'lost' })).not.toThrow();
    expect(pending.readPendingAction('p1')).toBeNull();
    expect(pending.readAnyPendingAction()).toBeNull();
    expect(() => pending.forgetAllPendingActions()).not.toThrow();
  });

  it('reads nothing out of a record that is the wrong shape', () => {
    window.localStorage.setItem(KEY, 'not json');
    expect(pending.readPendingAction('p1')).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ by: ME.id, kind: 'submit' }));
    expect(pending.readPendingAction('p1')).toBeNull();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ at: Date.now(), by: ME.id, kind: 'invented', phaseId: 'p1', label: 'x' }),
    );
    expect(pending.readPendingAction('p1')).toBeNull();
  });
});

describe('saying when a record appears or goes', () => {
  it('tells whoever is drawing a sentence about it', () => {
    const heard: string[] = [];
    const stop = pending.onPendingActionsChanged(() => heard.push('changed'));
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission' });
    pending.forgetPendingAction('p1');
    expect(heard).toEqual(['changed', 'changed']);
    stop();
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission' });
    expect(heard).toEqual(['changed', 'changed']);
  });

  it('says a message was kept only when it can be read back', () => {
    // A locked-down browser answers `setItem` with a throw *or* a silent
    // no-op, and the sign-in page goes on to tell the learner their message is
    // waiting. It may only do that when it really is.
    expect(pending.rememberPendingText('p1', 'Fix the overdue boundary')).toBe(true);
    expect(pending.readPendingAction('p1')?.text).toBe('Fix the overdue boundary');

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(pending.rememberPendingText('p2', 'Never written down')).toBe(false);
    setItem.mockRestore();
    expect(pending.rememberPendingText('p3', '')).toBe(false);
  });
});

describe('the sweeps that already clear a learner’s things', () => {
  it('takes the pending record with them, so nothing outlives a shared browser', async () => {
    const workspace = await import('@/lib/api-workspace');
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p1', label: 'your submission', text: 'mine' });
    window.localStorage.setItem(
      'lsdlc_pending_p9',
      JSON.stringify({ at: Date.now(), by: SOMEBODY_ELSE.id, kind: 'submit', phaseId: 'p9', label: 'your submission' }),
    );

    workspace.forgetOtherLearnersWorkspaceStorage(ME.id, true);
    expect(window.localStorage.getItem('lsdlc_pending_p9')).toBeNull();
    expect(pending.readPendingAction('p1')?.text).toBe('mine');

    workspace.forgetWorkspaceStorage();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
