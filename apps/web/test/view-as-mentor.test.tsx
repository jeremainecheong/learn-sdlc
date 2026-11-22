// @vitest-environment jsdom
/**
 * The mentor column while a teacher views a learner's work.
 *
 * Under "You are viewing Learner One's work. Nothing here can be changed." a
 * room that left the mentor box, the send button and "I'm stuck" live would
 * fire two reads the API refuses by design: the learner's own help flag
 * (`GET /phases/:id/stuck`, a learner route) and their mentor transcript
 * (`GET /instructor/learners/:id/assistant/:phase`, which always answers 403
 * because a mentor conversation is private to its learner). Nothing could be
 * written (`request` refuses every write while a session is held, and the API
 * refuses it again) but a control that is live and then refused is a
 * control that lies.
 *
 * So, while viewing: the box and both buttons are disabled, one plain
 * sentence says why, and neither read is asked.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ stuck: vi.fn(), raiseStuck: vi.fn(), clearStuck: vi.fn() }));
vi.mock('@/lib/api-mentor', () => ({
  mentorApi: { ...calls, lessonChat: vi.fn(), lessonHistory: async () => [] },
  agentApi: { list: async () => [], turns: async () => ({ items: [], nextCursor: null }), chat: vi.fn() },
}));

const { startViewAs, stopViewAs, viewAsMentorSentence } = await import('@/lib/view-as');
const { StuckFlag } = await import('@/components/workspace/mentor/StuckFlag');
const { PersonaComposer } = await import('@/components/shell/PersonaPanel');
const { api } = await import('@/lib/api');
const { loadRecords, resetRecords } = await import('@/lib/records');

const ADA = { userId: 'learner-ada', displayName: 'Ada Lovelace' };

let root: Root;
let host: HTMLDivElement;
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);

/** Just enough of a `PersonaThread` for the composer. */
const thread = (over: Record<string, unknown> = {}) =>
  ({
    phaseStateId: 'phase-ada-design',
    phaseKey: 'design',
    ask: 'Ask the design reviewer',
    busy: false,
    failure: null,
    lesson: false,
    send: vi.fn(async () => null),
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  calls.stuck.mockResolvedValue(null);
  // jsdom has no modal dialog; the help dialog only needs the two calls.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  stopViewAs();
  vi.restoreAllMocks();
});

describe('I’m stuck while viewing a learner', () => {
  it('asks nothing and offers nothing: the button is disabled and says why', async () => {
    startViewAs(ADA as never);
    await act(async () => root.render(<StuckFlag phaseStateId="phase-ada-design" />));

    expect(calls.stuck).not.toHaveBeenCalled();
    const open = q<HTMLButtonElement>('stuck-open')!;
    expect(open.disabled).toBe(true);
    expect(open.title).toBe(viewAsMentorSentence(ADA as never));
  });

  it('is the learner’s own door again once the session ends', async () => {
    await act(async () => root.render(<StuckFlag phaseStateId="phase-own-design" />));
    expect(calls.stuck).toHaveBeenCalledWith('phase-own-design');
    expect(q<HTMLButtonElement>('stuck-open')!.disabled).toBe(false);
  });
});

describe('the mentor box while viewing a learner', () => {
  it('is disabled, with one plain sentence under it', async () => {
    startViewAs(ADA as never);
    await act(async () => root.render(<PersonaComposer thread={thread()} />));

    expect(q<HTMLTextAreaElement>('chat-input')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('chat-send')!.disabled).toBe(true);
    const said = q('mentor-view-as')!;
    expect(said.textContent).toBe(viewAsMentorSentence(ADA as never));
    expect(said.textContent).toBe(
      "You are viewing Ada's work, so the mentor and I'm stuck are closed here. Mentor conversations stay private to Ada.",
    );
    // And I'm stuck beneath it is closed too.
    expect(q<HTMLButtonElement>('stuck-open')!.disabled).toBe(true);
    expect(calls.stuck).not.toHaveBeenCalled();
  });

  it('is the learner’s own box when nobody is viewing', async () => {
    await act(async () => root.render(<PersonaComposer thread={thread()} />));
    expect(q<HTMLTextAreaElement>('chat-input')!.disabled).toBe(false);
    expect(q('mentor-view-as')).toBeNull();
  });
});

describe('the records a viewed room reads', () => {
  it('never asks for the learner’s private mentor transcript', async () => {
    resetRecords();
    const history = vi.spyOn(api, 'chatHistory').mockResolvedValue([]);
    vi.spyOn(api, 'runs').mockResolvedValue([]);
    vi.spyOn(api, 'submissions').mockResolvedValue([]);
    startViewAs(ADA as never);

    const { records, partial } = await loadRecords('phase-ada-requirements');

    expect(history).not.toHaveBeenCalled();
    expect(records.chat).toEqual([]);
    // Not a failed read: the transcript is withheld on purpose, so the
    // record is whole and is kept like any other.
    expect(partial).toBe(false);
  });

  it('still reads the transcript for the learner themselves', async () => {
    resetRecords();
    const history = vi.spyOn(api, 'chatHistory').mockResolvedValue([]);
    vi.spyOn(api, 'runs').mockResolvedValue([]);
    vi.spyOn(api, 'submissions').mockResolvedValue([]);

    await loadRecords('phase-own-requirements');

    expect(history).toHaveBeenCalledWith('phase-own-requirements');
  });
});
