// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFocusPanels } from '@/components/workspace/useFocusPanels';
import type { WorkspacePanelsState } from '@/components/workspace/WorkspacePanels';

/**
 * The focused mode (a pane area under 520 px) collapses the brief and the
 * mentor, and their switches open them for the visit only. Entering the mode
 * keeps a side holding an open native modal. Leaving it must not hand the
 * sides straight back to the stored preference: a mentor opened just for the
 * visit, with a proposal's dialog open in it and the stored preference closed,
 * would be hidden with the modal still open. The side stays until its modal
 * closes; the modal is never closed for the learner.
 */

let host: HTMLDivElement;
let root: Root;
let panels: WorkspacePanelsState;
let setFocused: (focused: boolean) => void;
let setStoredMentor: (open: boolean) => void;

function Room({ initialFocused, storedMentor = false }: { initialFocused: boolean; storedMentor?: boolean }) {
  const [focused, setF] = useState(initialFocused);
  const [mentor, setMentor] = useState(storedMentor);
  const [brief, setBrief] = useState(false);
  setFocused = setF;
  setStoredMentor = setMentor;
  const stored: WorkspacePanelsState = { briefOpen: brief, mentorOpen: mentor, setBriefOpen: setBrief, setMentorOpen: setMentor, briefId: 'b', mentorId: 'm' };
  panels = useFocusPanels(focused, stored);
  return <>
    <aside data-workspace-panel="brief" hidden={!panels.briefOpen} />
    <aside data-workspace-panel="mentor" hidden={!panels.mentorOpen}><dialog data-testid="proposal"><textarea aria-label="Explanation" defaultValue="my explanation" /></dialog></aside>
  </>;
}

const dialog = () => host.querySelector('dialog')!;
const mentorHidden = () => host.querySelector<HTMLElement>('[data-workspace-panel="mentor"]')!.hidden;
/** jsdom has no top layer: open and close the dialog as the browser would, with its close event. */
const openModal = () => act(() => { dialog().setAttribute('open', ''); dialog().setAttribute('data-modal', ''); });
const closeModal = () => act(() => { dialog().removeAttribute('open'); dialog().removeAttribute('data-modal'); dialog().dispatchEvent(new Event('close')); });

// jsdom has no top layer and reads no dialog as :modal. Play the browser's
// part: a dialog opened by openModal (data-modal) matches :modal; a plain
// <dialog open> (ChatSurface's compact panel) does not.
const nativeMatches = Element.prototype.matches;
beforeEach(() => {
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    if (selector === ':modal') return this.hasAttribute('open') && this.hasAttribute('data-modal');
    return nativeMatches.call(this, selector);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('leaving the focused mode with a modal open in a side opened for the visit', () => {
  it('keeps the side open until the modal closes, then follows the stored preference', () => {
    act(() => root.render(<Room initialFocused />));
    expect(mentorHidden()).toBe(true);
    // The learner opens the mentor for this visit and a proposal's dialog in it.
    act(() => panels.setMentorOpen(true));
    expect(mentorHidden()).toBe(false);
    openModal();
    // The pane area grows past 520 px: the mode ends while the modal is open.
    act(() => setFocused(false));
    expect(mentorHidden(), 'the side holding the open modal stays').toBe(false);
    expect(dialog().hasAttribute('open'), 'the modal is not closed for the learner').toBe(true);
    expect(host.querySelector('textarea')!.value).toBe('my explanation');
    // The learner closes the dialog: the side follows the stored preference (closed).
    closeModal();
    expect(mentorHidden()).toBe(true);
  });

  it('a side with no open modal follows the stored preference at once', () => {
    act(() => root.render(<Room initialFocused />));
    act(() => panels.setMentorOpen(true));
    act(() => setFocused(false));
    expect(mentorHidden()).toBe(true);
  });

  it('a stored preference that is open is simply kept', () => {
    act(() => root.render(<Room initialFocused storedMentor />));
    act(() => panels.setMentorOpen(true));
    openModal();
    act(() => setFocused(false));
    expect(mentorHidden()).toBe(false);
    closeModal();
    expect(mentorHidden()).toBe(false);
  });

  it('the side\'s own switch ends the hold: the learner\'s choice wins', () => {
    act(() => root.render(<Room initialFocused />));
    act(() => panels.setMentorOpen(true));
    openModal();
    act(() => setFocused(false));
    expect(panels.mentorOpen).toBe(true);
    // Pressing Hide mentor while held closes it and writes the preference as asked.
    act(() => panels.setMentorOpen(false));
    expect(mentorHidden()).toBe(true);
    act(() => setStoredMentor(true));
    expect(mentorHidden()).toBe(false);
  });

  it('entering the focused mode still keeps a side holding an open modal', () => {
    act(() => root.render(<Room initialFocused={false} storedMentor />));
    openModal();
    act(() => setFocused(true));
    expect(mentorHidden()).toBe(false);
    closeModal();
    // In the mode, the visit's choice stands until the learner changes it.
    expect(mentorHidden()).toBe(false);
    act(() => panels.setMentorOpen(false));
    expect(mentorHidden()).toBe(true);
  });

  it('a non-modal open dialog (the chat panel) never holds a side on the way out', () => {
    // ChatSurface's compact panel is a <dialog open> without showModal. On a
    // phone the room can leave the mode on its first measurement; reading the
    // panel as a modal kept the mentor open there and the pane switcher drew
    // four tabs in a 104 px row (the a11y reflow case at 360 px, sidebar pinned).
    act(() => root.render(<Room initialFocused />));
    act(() => panels.setMentorOpen(true));
    act(() => { dialog().setAttribute('open', ''); });
    act(() => setFocused(false));
    expect(mentorHidden()).toBe(true);
  });

  it('a side the learner did not open in the mode is never held, even with a modal in it', () => {
    act(() => root.render(<Room initialFocused />));
    openModal();
    // Entering kept nothing open (the modal came after); the learner never opened the mentor.
    act(() => panels.setMentorOpen(false));
    act(() => setFocused(false));
    expect(mentorHidden()).toBe(true);
  });

  it('entering the focused mode with no modal collapses both sides', () => {
    act(() => root.render(<Room initialFocused={false} storedMentor />));
    act(() => setFocused(true));
    expect(mentorHidden()).toBe(true);
    expect(panels.briefOpen).toBe(false);
  });
});
