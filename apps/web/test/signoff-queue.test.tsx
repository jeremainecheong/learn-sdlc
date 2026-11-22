// @vitest-environment jsdom
/**
 * The class's sign-off queue and bulk sign-off.
 *
 * One batch is one task, many learners, and **one reason**. The
 * reason is what the audit trail keeps for every learner in the batch, so the
 * bulk control is off until a reason of at least `ASSIGNMENT_REASON_MIN`
 * characters is written, and it says so. The API's answer is read back word
 * for word: who was signed off, and each refusal's own sentence.
 *
 * Accessibility: each task is a fieldset with its learners as labelled checkboxes, the
 * reason is labelled and described, and the confirm is a dialog that holds
 * focus, closes on Escape and hands focus back.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignoffQueueView } from '@learnsdlc/shared';
import { ASSIGNMENT_REASON_MIN } from '@learnsdlc/shared';

const queue = vi.fn();
const bulk = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  signoffApi: {
    queue: (...args: unknown[]) => queue(...args),
    bulk: (...args: unknown[]) => bulk(...args),
  },
}));

import { SignoffQueue } from '@/components/staff/SignoffQueue';
import { settle, typeInto } from './support/dom';

const QUEUE: SignoffQueueView = {
  cohortId: 'c-1',
  rows: [
    { userId: 'u-2', learnerName: 'Ben Tan', phaseKey: 'deployment', taskKey: 'main', taskTitle: 'Ship the shelf', awaitingSince: '2026-09-30T02:00:00.000Z' },
    { userId: 'u-1', learnerName: 'Ada Lim', phaseKey: 'deployment', taskKey: 'main', taskTitle: 'Ship the shelf', awaitingSince: '2026-09-30T01:00:00.000Z' },
    { userId: 'u-3', learnerName: 'Cai Ng', phaseKey: 'maintenance', taskKey: 'main', taskTitle: 'Fix the overdue bug', awaitingSince: '2026-09-30T03:00:00.000Z' },
  ],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  queue.mockResolvedValue(QUEUE);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;


async function mount() {
  await act(async () => {
    root?.render(<SignoffQueue cohortId="c-1" />);
  });
  await settle(6);
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLTextAreaElement;
  typeInto(node, value);
}

function key(target: Element, k: string, shift = false) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  });
}

const REASON = 'Deployment runbooks checked in the lab.';

describe('the sign-off queue', () => {
  it('reads the class queue and groups it by task', async () => {
    await mount();
    expect(queue).toHaveBeenCalledWith('c-1');
    expect(byId('signoff-task-deployment-main')).not.toBeNull();
    expect(byId('signoff-task-maintenance-main')).not.toBeNull();
    expect(byId('signoff-task-deployment-main')?.textContent).toContain('Ada Lim');
    expect(byId('signoff-task-deployment-main')?.textContent).toContain('Ben Tan');
  });

  it('an empty reason disables bulk sign-off', async () => {
    await mount();
    await click('signoff-pick-deployment-main-u-1');
    await click('signoff-pick-deployment-main-u-2');
    const go = byId('signoff-bulk-deployment-main') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(byId('signoff-bulk-deployment-main-reason')?.textContent).toMatch(/reason/i);
    type(byId('signoff-reason-deployment-main'), '   ');
    expect((byId('signoff-bulk-deployment-main') as HTMLButtonElement).disabled).toBe(true);
    type(byId('signoff-reason-deployment-main'), 'x'.repeat(ASSIGNMENT_REASON_MIN - 1));
    expect((byId('signoff-bulk-deployment-main') as HTMLButtonElement).disabled).toBe(true);
    type(byId('signoff-reason-deployment-main'), REASON);
    expect((byId('signoff-bulk-deployment-main') as HTMLButtonElement).disabled).toBe(false);
  });

  it('is off with no learner chosen, even with a reason', async () => {
    await mount();
    type(byId('signoff-reason-deployment-main'), REASON);
    expect((byId('signoff-bulk-deployment-main') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends one task, the chosen learners and one reason, then reads the answer back verbatim', async () => {
    bulk.mockResolvedValue({
      signedOff: ['u-1'],
      refused: [{ userId: 'u-2', sentence: 'Ben Tan has submitted again since this was queued, so it waits for a fresh look.' }],
    });
    await mount();
    await click('signoff-pick-deployment-main-u-1');
    await click('signoff-pick-deployment-main-u-2');
    type(byId('signoff-reason-deployment-main'), REASON);
    await click('signoff-bulk-deployment-main');
    expect(byId('signoff-confirm')).not.toBeNull();
    expect(bulk).not.toHaveBeenCalled();
    await click('signoff-confirm-yes');
    await settle(6);
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith('c-1', {
      phaseKey: 'deployment',
      taskKey: 'main',
      userIds: ['u-1', 'u-2'],
      reason: REASON,
    });
    expect(byId('signoff-result')?.textContent).toContain('1 learner');
    expect(byId('signoff-refused-u-2')?.textContent).toBe(
      'Ben Tan has submitted again since this was queued, so it waits for a fresh look.',
    );
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it('prints a refused batch in the API words', async () => {
    bulk.mockRejectedValue(new Error('This class is not yours.'));
    await mount();
    await click('signoff-pick-deployment-main-u-1');
    type(byId('signoff-reason-deployment-main'), REASON);
    await click('signoff-bulk-deployment-main');
    await click('signoff-confirm-yes');
    await settle(6);
    expect(byId('signoff-error')?.textContent).toBe('This class is not yours.');
  });

  it('says so when nothing is waiting', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    await mount();
    expect(byId('signoff-empty')).not.toBeNull();
  });
});

describe('the sign-off queue: labelled form groups', () => {
  it('draws each task as a fieldset with labelled learners and a described reason', async () => {
    await mount();
    const task = byId('signoff-task-deployment-main') as HTMLElement;
    expect(task.tagName).toBe('FIELDSET');
    expect(task.querySelector(':scope > legend')?.textContent).toContain('Ship the shelf');
    for (const control of [...task.querySelectorAll('input, textarea')]) {
      const id = control.getAttribute('id');
      expect(id).toBeTruthy();
      expect(task.querySelector(`label[for="${id}"]`), `no label for ${id}`).not.toBeNull();
    }
    const reason = byId('signoff-reason-deployment-main') as HTMLTextAreaElement;
    const ids = (reason.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it('traps focus in the confirm, closes on Escape and hands focus back', async () => {
    await mount();
    await click('signoff-pick-deployment-main-u-1');
    type(byId('signoff-reason-deployment-main'), REASON);
    (byId('signoff-bulk-deployment-main') as HTMLButtonElement).focus();
    await click('signoff-bulk-deployment-main');
    const dialog = byId('signoff-confirm') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    const buttons = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    buttons[buttons.length - 1].focus();
    key(buttons[buttons.length - 1], 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
    key(document.activeElement as Element, 'Escape');
    await settle(6);
    expect(byId('signoff-confirm')).toBeNull();
    expect(document.activeElement).toBe(byId('signoff-bulk-deployment-main'));
    expect(bulk).not.toHaveBeenCalled();
  });
});

// The empty queue tells a teacher how a task gets here.
describe('the sign-off queue: the empty state', () => {
  it('says how a task reaches the queue, and keeps its title', async () => {
    queue.mockResolvedValue({ cohortId: 'c-1', rows: [] });
    await mount();
    const empty = byId('signoff-empty') as HTMLElement;
    expect(empty.textContent).toContain('Nothing is waiting for a sign-off');
    expect(empty.textContent).toContain(
      'Mark a task as needing your sign-off in the project editor. Learners on a version published with that mark appear here once they pass it.',
    );
    expect(empty.textContent).not.toMatch(/notif|e-?mail|deadline/i);
  });
});

// The batch answer is drawn and focused only once the confirm is closed, so the dialog's inert
// fence (StaffDialog's MutationObserver) never covers it. jsdom does not
// enforce inert, so the case asserts the attribute at the moment of focus.
describe('the sign-off queue: the batch answer after the confirm', () => {
  it('draws the answer outside any inert region, focuses it, and keeps it there after the re-read', async () => {
    bulk.mockResolvedValue({ signedOff: ['u-1'], refused: [] });
    await mount();
    await click('signoff-pick-deployment-main-u-1');
    type(byId('signoff-reason-deployment-main'), REASON);
    (byId('signoff-bulk-deployment-main') as HTMLButtonElement).focus();
    await click('signoff-bulk-deployment-main');
    // The second read of the queue is held open, as a slow network would.
    let release: (view: SignoffQueueView) => void = () => undefined;
    queue.mockImplementationOnce(() => new Promise<SignoffQueueView>((done) => (release = done)));
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const realFocus = HTMLElement.prototype.focus;
    const focusedInert: boolean[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
      const inert = Boolean(this.closest('[inert]'));
      focusedInert.push(inert);
      // A browser refuses focus to an inert node; jsdom does not, so this does.
      if (!inert) realFocus.call(this);
    });
    try {
      await click('signoff-confirm-yes');
      await settle(6);
      for (const cb of frames.splice(0)) act(() => cb(0));
      const answer = byId('signoff-result') as HTMLElement;
      expect(answer).not.toBeNull();
      expect(answer.closest('[inert]'), 'the answer is drawn inside the inert page').toBeNull();
      expect(byId('signoff-confirm'), 'the confirm is still open while the answer is drawn').toBeNull();
      expect(document.activeElement?.contains(answer)).toBe(true);
      await act(async () => {
        release({ cohortId: 'c-1', rows: QUEUE.rows.filter((row) => row.userId !== 'u-1') });
      });
      await settle(6);
      for (const cb of frames.splice(0)) act(() => cb(0));
      expect(byId('signoff-result')?.textContent).toContain('Signed off 1 learner.');
      expect(document.activeElement?.contains(byId('signoff-result'))).toBe(true);
      expect(focusedInert).not.toContain(true);
    } finally {
      raf.mockRestore();
      focus.mockRestore();
    }
  });
});

describe('the sign-off queue: a refused read and its retry', () => {
  it('waits on the retry while the read is in flight, then draws the queue', async () => {
    queue.mockRejectedValueOnce(new Error('down'));
    await mount();
    expect(byId('signoff-load-error')).not.toBeNull();
    const retry = byId('signoff-retry') as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    let answer: (view: SignoffQueueView) => void = () => {};
    queue.mockReturnValueOnce(new Promise<SignoffQueueView>((resolve) => (answer = resolve)));
    await click('signoff-retry');
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.textContent).toBe('Try again');

    await act(async () => answer(QUEUE));
    await settle(6);
    expect(byId('signoff-retry')).toBeNull();
    expect(byId('signoff-load-error')).toBeNull();
    expect(byId('signoff-task-deployment-main')).not.toBeNull();
    expect(queue).toHaveBeenCalledTimes(2);
  });
});
