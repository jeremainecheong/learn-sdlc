// @vitest-environment jsdom
/**
 * Notes for this class, as the teacher portal mounts them.
 *
 * The API is `GET/POST/PATCH/DELETE
 * /instructor/notes`, narrowed to the caller's own classes, with the mentor
 * quoting at most two of them into one reply. Nothing here may invent a route.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstructorNoteView } from '@learnsdlc/shared';
import { NotesCard } from '@/components/staff/NotesCard';

const calls = vi.hoisted(() => ({
  notes: vi.fn(),
  writeNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: calls }));

const note = (over: Partial<InstructorNoteView> = {}): InstructorNoteView => ({
  id: 'note-one',
  kind: 'mentor',
  cohortId: 'class-one',
  cohortName: 'Example class',
  phaseKey: 'requirements',
  projectSlug: null,
  text: 'Quote the acceptance criteria back before you write the story.',
  authorUserId: 'teacher-a',
  authorName: 'Teacher A',
  sourceId: null,
  doneAt: null,
  createdAt: '2026-09-18T09:00:00Z',
  updatedAt: '2026-09-18T09:00:00Z',
  ...over,
});

const WRITTEN = 'Compare due dates with datetime.date.today rather than a string.';

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const render = async () => {
  await act(async () => root.render(<NotesCard cohortId="class-one" />));
};
const click = async (id: string) => act(async () => q<HTMLButtonElement>(id).click());
const type = async (value: string) =>
  act(async () => {
    fireEvent.change(q<HTMLTextAreaElement>('note-text'), { target: { value: value } });
  });
const pick = async (id: string, value: string) =>
  act(async () => {
    fireEvent.change(q<HTMLSelectElement>(id), { target: { value: value } });
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.notes.mockReset().mockResolvedValue([note()]);
  calls.writeNote.mockReset().mockResolvedValue(note({ id: 'note-two' }));
  calls.updateNote.mockReset().mockResolvedValue(note());
  calls.deleteNote.mockReset().mockResolvedValue({ deleted: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('notes for this class', () => {
  it('reads only this class and says plainly what the mentor does with a note', async () => {
    await render();
    expect(calls.notes).toHaveBeenCalledExactlyOnceWith({ cohortId: 'class-one' });
    expect(q('notes-mentor-rule').textContent).toContain('The AI mentor reads these notes');
    expect(q('notes-mentor-rule').textContent).toContain('at most two');
    expect(q('note-row-note-one').textContent).toContain('Quote the acceptance criteria back');
    expect(q('note-row-note-one').textContent).toContain('Requirements');
    expect(q('note-row-note-one').textContent).toContain('Teacher A');
  });

  it('writes a note against the class it was given and re-reads the list', async () => {
    await render();
    await click('note-write');
    await pick('note-phase', 'design');
    await type(WRITTEN);
    await click('note-save');
    expect(calls.writeNote).toHaveBeenCalledExactlyOnceWith({
      kind: 'mentor',
      cohortId: 'class-one',
      phaseKey: 'design',
      projectSlug: null,
      text: WRITTEN,
    });
    expect(calls.notes).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="note-text"]')).toBeNull();
  });

  it('writes a lecture point that says it never reaches the mentor', async () => {
    await render();
    await click('note-write');
    await pick('note-kind', 'lecture');
    expect(q('note-kind-rule').textContent).toContain('never reaches the mentor');
    await type(WRITTEN);
    await click('note-save');
    expect(calls.writeNote).toHaveBeenCalledExactlyOnceWith({
      kind: 'lecture',
      cohortId: 'class-one',
      phaseKey: null,
      projectSlug: null,
      text: WRITTEN,
    });
  });

  it('refuses a note the class could not act on and says how short it is', async () => {
    await render();
    await click('note-write');
    await type('too short');
    expect(q<HTMLButtonElement>('note-save').disabled).toBe(true);
    expect(host.textContent).toContain('at least 10 characters');
    await click('note-save');
    expect(calls.writeNote).not.toHaveBeenCalled();
  });

  it('keeps an unsaved note and says so when the save fails', async () => {
    calls.writeNote.mockRejectedValueOnce(new Error('Disconnected'));
    await render();
    await click('note-write');
    await type(WRITTEN);
    await click('note-save');
    expect(q('notes-error')).not.toBeNull();
    expect(q<HTMLTextAreaElement>('note-text').value).toBe(WRITTEN);
    expect(calls.notes).toHaveBeenCalledTimes(1);
  });

  // Nothing is sent when the confirm is refused, and exactly one delete when
  // it is taken; what the teacher is actually asked is asserted rather than
  // stubbed away with `window.confirm`.
  it('asks in the page before deleting, names the note and what goes with it, and sends nothing when it is kept', async () => {
    await render();
    await click('note-delete-note-one');
    expect(calls.deleteNote).not.toHaveBeenCalled();
    const asked = q('note-delete-confirm-note-one');
    expect(asked.textContent).toContain('Quote the acceptance criteria back');
    expect(asked.textContent).toContain('stop hearing it from the mentor');
    expect(asked.textContent).toContain('cannot be brought back');
    await click('note-delete-no-note-one');
    expect(host.querySelector('[data-testid="note-delete-confirm-note-one"]')).toBeNull();
    expect(calls.deleteNote).not.toHaveBeenCalled();
    expect(q('note-row-note-one')).not.toBeNull();
  });

  it('deletes once the confirm in the page is taken, and opens no browser dialog', async () => {
    const native = vi.spyOn(window, 'confirm');
    await render();
    await click('note-delete-note-one');
    calls.notes.mockResolvedValue([]);
    await click('note-delete-yes-note-one');
    expect(native).not.toHaveBeenCalled();
    expect(calls.deleteNote).toHaveBeenCalledExactlyOnceWith('note-one');
    expect(q('notes-empty')).not.toBeNull();
  });

  it('does not tell a teacher the class hears a lecture point, because it never did', async () => {
    calls.notes.mockReset().mockResolvedValue([note({ kind: 'lecture', phaseKey: null })]);
    await render();
    await click('note-delete-note-one');
    const asked = q('note-delete-confirm-note-one');
    expect(asked.textContent).toContain('held for the next session');
    expect(asked.textContent).not.toContain('stop hearing it from the mentor');
  });

  it('edits an existing note in place rather than writing a second one', async () => {
    await render();
    await click('note-edit-note-one');
    expect(q<HTMLTextAreaElement>('note-text').value).toBe(
      'Quote the acceptance criteria back before you write the story.',
    );
    await type(WRITTEN);
    await click('note-save');
    expect(calls.updateNote).toHaveBeenCalledExactlyOnceWith('note-one', {
      kind: 'mentor',
      phaseKey: 'requirements',
      text: WRITTEN,
    });
    expect(calls.writeNote).not.toHaveBeenCalled();
  });

  it('shows a read failure as a failure rather than as a class with nothing to say', async () => {
    calls.notes.mockReset().mockRejectedValue(new Error('Offline'));
    await render();
    expect(q('notes-error')).not.toBeNull();
    expect(host.querySelector('[data-testid="notes-empty"]')).toBeNull();
  });
});

describe("the note's phase select over the class's own phases", () => {
  it("offers only the phases the class's version holds, and every phase", async () => {
    await act(async () => root.render(<NotesCard cohortId="class-one" phases={['requirements', 'design', 'implementation']} />));
    await click('note-write');
    const options = [...q<HTMLSelectElement>('note-phase').options].map((one) => one.textContent);
    expect(options).toEqual(['Every phase', 'Requirements', 'Design', 'Implementation']);
  });
  it("keeps an edited note's own phase in the select when the class's version no longer holds it", async () => {
    calls.notes.mockResolvedValue([note({ phaseKey: 'testing' })]);
    await act(async () => root.render(<NotesCard cohortId="class-one" phases={['requirements', 'design']} />));
    await click('note-edit-note-one');
    expect(q<HTMLSelectElement>('note-phase').value).toBe('testing');
    expect([...q<HTMLSelectElement>('note-phase').options].map((one) => one.value)).toEqual(['', 'requirements', 'design', 'testing']);
  });
});
