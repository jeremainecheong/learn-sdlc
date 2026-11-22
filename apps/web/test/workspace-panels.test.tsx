// @vitest-environment jsdom
import { act, useContext, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSession } from '@/lib/session';
import { useWorkspacePanels, WorkspacePanelControls, WorkspaceMentorBoundary, type WorkspacePanelsState } from '@/components/workspace/WorkspacePanels';
import { ChatExpansionContext, ChatSurface } from '@/components/chat/ChatSurface';

let host: HTMLDivElement; let root: Root; let current: WorkspacePanelsState; let userNumber = 0;
const reveal = vi.fn();
let retainedExpansion: (() => void) | null;
function ExpansionProbe() { retainedExpansion = useContext(ChatExpansionContext); return null; }
function ModalRoom() {
  current = useWorkspacePanels();
  const [pane, setPane] = useState('code');
  return <aside data-workspace-panel="mentor" data-pane={pane} hidden={!current.mentorOpen}>
    <WorkspaceMentorBoundary panels={current} onExpand={() => { setPane('panel'); reveal(); }}>
      <ExpansionProbe /><ChatSurface name="Nova" identity="Nova"><textarea aria-label="Unsent modal question" defaultValue="Unsent draft" /></ChatSurface>
    </WorkspaceMentorBoundary>
  </aside>;
}
const user = (id: string) => ({ id, email: `${id}@example.test`, displayName: id, role: 'LEARNER' as const, cohort: 'default', createdAt: '2026-09-11T00:00:00Z' });
const resize = (width: number) => act(() => { Object.defineProperty(window, 'innerWidth', { value: width, configurable: true }); window.dispatchEvent(new Event('resize')); });
function Room() {
  current = useWorkspacePanels();
  return <><WorkspacePanelControls panels={current} onReveal={reveal} /><aside id={current.briefId} data-workspace-panel="brief" hidden={!current.briefOpen}><input aria-label="Unsaved brief note" defaultValue="draft retained" /></aside><aside id={current.mentorId} data-workspace-panel="mentor" hidden={!current.mentorOpen}><textarea aria-label="Unsent question" defaultValue="question retained" /></aside></>;
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); reveal.mockClear(); setSession(user(`panels-${++userNumber}`)); resize(1440); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); setSession(null); });

describe('learner-controlled workspace panels', () => {
  it('retains an explicitly expanded conversation across the default desktop-to-narrow breakpoint', () => {
    // jsdom has no native top layer; compiled browser coverage separately
    // verifies actual :modal, focus and geometry during browser200% zoom.
    for (const method of ['show', 'showModal', 'close'] as const) {
      Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: function (this: HTMLDialogElement) { this.open = method !== 'close'; } });
    }
    act(() => root.render(<ModalRoom />));
    const dialog = host.querySelector('dialog')!, draft = host.querySelector('textarea')!;
    draft.value = 'My question has not been sent';
    expect(host.querySelector('aside')!.dataset.pane).toBe('code');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="chat-expand"]')!.click());
    expect(reveal).toHaveBeenCalledOnce();
    expect(host.querySelector('aside')!.dataset.pane).toBe('panel');
    resize(720);
    expect(current.mentorOpen).toBe(true);
    expect(host.querySelector('aside')!.hidden).toBe(false);
    expect(host.querySelector('dialog')).toBe(dialog);
    expect(host.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('My question has not been sent');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="chat-expand"]')!.click());
    expect(reveal).toHaveBeenCalledOnce();
    expect(host.querySelector('aside')!.hidden).toBe(false);
    expect(document.activeElement).toBe(host.querySelector('[data-testid="chat-expand"]'));
  });
  it('does not let an expansion callback from another account select a pane or pin its preferences', () => {
    act(() => root.render(<ModalRoom />)); const staleExpansion = retainedExpansion!;
    resize(390); expect(current.mentorOpen).toBe(false);
    act(() => setSession(user('different-expansion-owner')));
    act(() => staleExpansion());
    expect(current.mentorOpen).toBe(false);
    expect(host.querySelector('aside')!.dataset.pane).toBe('code');
    expect(reveal).not.toHaveBeenCalled();
    expect(localStorage.getItem('lsdlc_workspace_panels:different-expansion-owner')).toBeNull();
  });
  it.each([[1440, true, true], [1024, false, true], [390, false, false]])('starts at %ipx with enough room for the workspace', (width, brief, mentor) => {
    resize(width as number); act(() => root.render(<Room />));
    expect(current.briefOpen).toBe(brief); expect(current.mentorOpen).toBe(mentor);
    for (const control of host.querySelectorAll('button')) {
      const panel = host.querySelector<HTMLElement>(`[id="${control.getAttribute('aria-controls')}"]`)!;
      expect(panel.hidden).toBe(control.getAttribute('aria-expanded') === 'false');
    }
  });
  it('hides each panel independently without remounting its unsaved draft, then remembers the choice on another route', () => {
    act(() => root.render(<Room />));
    const note = host.querySelector<HTMLInputElement>('input')!; note.value = 'Local unsaved edit';
    const question = host.querySelector<HTMLTextAreaElement>('textarea')!; question.value = 'A question I have not sent';
    const hideBrief = button('Hide brief'); hideBrief.focus(); act(() => hideBrief.click());
    expect(document.activeElement).toBe(hideBrief); expect(current.briefOpen).toBe(false); expect(current.mentorOpen).toBe(true);
    act(() => button('Hide mentor').click());
    expect(host.querySelector('input')).toBe(note); expect(host.querySelector('textarea')).toBe(question);
    expect(note.value).toBe('Local unsaved edit'); expect(question.value).toBe('A question I have not sent');
    act(() => button('Show brief').click()); expect(reveal).toHaveBeenCalledWith('brief'); expect(current.mentorOpen).toBe(false);
    resize(390); expect(current.briefOpen).toBe(true); expect(current.mentorOpen).toBe(false);
    act(() => root.render(<Room key="next-phase-route" />));
    expect(current.briefOpen).toBe(true); expect(current.mentorOpen).toBe(false);
  });
  it('isolates preferences between learners and rejects a callback retained from the previous session', () => {
    act(() => root.render(<Room />)); const firstOwner = user(`panels-${userNumber}`);
    act(() => current.setBriefOpen(false)); const staleSetter = current.setMentorOpen;
    act(() => setSession(user('different-panel-owner')));
    expect(current.briefOpen).toBe(true); expect(current.mentorOpen).toBe(true);
    act(() => staleSetter(false)); expect(current.mentorOpen).toBe(true);
    act(() => setSession(firstOwner)); expect(current.briefOpen).toBe(false); expect(current.mentorOpen).toBe(true);
  });
  it('keeps explicit choices in memory when browser storage denies access', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage refused'); });
    act(() => root.render(<Room />)); act(() => button('Hide mentor').click());
    resize(1024); expect(current.mentorOpen).toBe(false);
    act(() => root.render(<Room key="return-visit" />)); expect(current.mentorOpen).toBe(false);
  });
  it('accepts only boolean preferences and follows valid changes from another tab', () => {
    const key = `lsdlc_workspace_panels:panels-${userNumber}`;
    localStorage.setItem(key, JSON.stringify({ version: 1, briefOpen: 'false', mentorOpen: 0 }));
    act(() => root.render(<Room />)); expect(current.briefOpen).toBe(true); expect(current.mentorOpen).toBe(true);
    act(() => { localStorage.setItem(key, JSON.stringify({ version: 1, briefOpen: false, mentorOpen: true })); window.dispatchEvent(new StorageEvent('storage', { key })); });
    expect(current.briefOpen).toBe(false); expect(current.mentorOpen).toBe(true);
  });
});
