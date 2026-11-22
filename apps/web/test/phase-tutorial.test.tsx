// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';
import { CoachMarks } from '@/components/shell/CoachMarks';
import { PhaseTutorialProvider, PhaseTutorialReplay, usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { COACH_KEY, phaseTutorialKey, phaseTutorialMarks, phaseTutorialSeen, replayTour, type PhaseTutorialScope } from '@/components/shell/tours';
const identity = vi.hoisted(() => ({ user: { id: 'tutorial-owner', role: 'LEARNER' }, viewing: null as null | { userId: string } }));
vi.mock('@/lib/session', () => ({ useSession: () => identity.user }));
vi.mock('@/lib/view-as', () => ({ useViewAs: () => identity.viewing }));
let host: HTMLDivElement, root: Root, serial = 0, scope: PhaseTutorialScope;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (node: React.ReactNode) => act(() => root.render(node));
const realRect = Element.prototype.getBoundingClientRect, realScroll = Element.prototype.scrollIntoView;
const realShow = HTMLDialogElement.prototype.showModal, realClose = HTMLDialogElement.prototype.close;
beforeEach(() => {
  scope = { ownerId: `owner-${++serial}`, phaseId: `phase-${serial}`, phaseKey: 'requirements', ready: true };
  identity.user = { id: scope.ownerId, role: 'LEARNER' }; identity.viewing = null; localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Element.prototype.getBoundingClientRect = () => ({ top: 20, left: 20, right: 220, bottom: 60, width: 200, height: 40, x: 20, y: 20, toJSON() {} }) as DOMRect;
  Element.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); document.querySelectorAll('[data-extra-test]').forEach(node => node.remove());
  Element.prototype.getBoundingClientRect = realRect; Element.prototype.scrollIntoView = realScroll;
  HTMLDialogElement.prototype.showModal = realShow; HTMLDialogElement.prototype.close = realClose;
});
// The row's entries as the workspace draws them: each view button says which view it is (`data-view`), and
// the planted bugs' entry is a link to its page; the tutorial aims at those, not at positions.
function LoadedTool({ phase }: { phase: PhaseDetail | null }) {
  usePhaseTutorialReady(phase);
  return <><input aria-label="Retained unsaved draft" defaultValue="my draft" /><button id="requirements-interview-tab">Stakeholder interview</button><nav aria-label="Phase working area"><button data-view="code">Write tests</button><button data-view="evidence">Evidence</button><a href="/workspace/phase/matrix">Coverage</a></nav><PhaseTutorialReplay /></>;
}
function phase(overrides: Partial<PhaseDetail> = {}): PhaseDetail { return { id: scope.phaseId, key: scope.phaseKey, status: 'in_progress', files: [], ...overrides } as PhaseDetail; }
function tree(detail: PhaseDetail | null, extra?: React.ReactNode) { return <PhaseTutorialProvider key={`${identity.user.id}:${scope.phaseId}`} phaseId={scope.phaseId} phaseKey={scope.phaseKey}><LoadedTool phase={detail} />{extra}</PhaseTutorialProvider>; }
function direct() { return <><button id="requirements-interview-tab">Interview</button><CoachMarks phaseTutorial={scope} /></>; }

describe('first phase entry', () => {
  it('restores Replay after a pointer click even when the browser does not focus buttons', () => {
    render(tree(phase())); act(() => q('coach-skip')!.click());
    const input = host.querySelector('input')!; input.focus(); expect(document.activeElement).toBe(input);
    // HTMLElement.click() does not focus a button, matching Safari pointer behavior.
    act(() => q('phase-tutorial-replay')!.click());
    expect(q('coach')).not.toBeNull();
    act(() => q('coach-next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(q('coach')).toBeNull(); expect(document.activeElement).toBe(q('phase-tutorial-replay'));
  });
  it('waits for an exact unlocked full phase GET and leaves summaries and legacy flags alone', () => {
    localStorage.setItem(COACH_KEY, 'done');
    for (const data of [null, { ...phase(), view: 'summary' } as PhaseDetail, phase({ id: 'foreign' }), phase({ key: 'testing' }), phase({ status: 'locked' })]) { render(tree(data)); expect(q('coach')).toBeNull(); }
    render(tree(phase())); expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
    expect(q('coach-count')?.textContent).toBe('1 of 6'); expect(q('phase-tutorial-replay')).not.toBeNull();
    expect(localStorage.getItem(COACH_KEY)).toBe('done'); expect(phaseTutorialSeen(scope)).toBe(true);
  });
  it('remembers Skip across child routes and refresh, preserving the draft and explicit Replay', () => {
    render(tree(phase())); const input = host.querySelector('input')!; input.value = 'still unsaved';
    act(() => q('coach-next')!.click()); expect(q('coach-count')?.textContent).toBe('2 of 6');
    act(() => q('coach-back')!.click()); expect(q('coach-count')?.textContent).toBe('1 of 6');
    act(() => q('coach-skip')!.click()); expect(q('coach')).toBeNull(); expect(input.value).toBe('still unsaved');
    render(tree(phase(), <div>Another child route</div>)); expect(q('coach')).toBeNull();
    render(null); render(tree(phase())); expect(q('coach')).toBeNull();
    q('phase-tutorial-replay')!.focus(); act(() => q('phase-tutorial-replay')!.click()); expect(q('coach-count')?.textContent).toBe('1 of 6');
    act(() => q('coach-next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(q('coach')).toBeNull(); expect(document.activeElement).toBe(q('phase-tutorial-replay'));
  });
  it('separates learner, phase and enrollment identities', () => {
    render(tree(phase())); act(() => q('coach-skip')!.click());
    identity.user = { id: 'another-learner', role: 'LEARNER' }; render(tree(phase())); expect(q('coach')).not.toBeNull();
    act(() => q('coach-skip')!.click()); scope = { ...scope, phaseId: 'another-enrollment-phase', phaseKey: 'testing' };
    render(tree(phase())); expect(q('coach')?.getAttribute('aria-label')).toBe('Testing tutorial');
  });
  it('suppresses teacher and view-as mode without recording the learner seen flag', () => {
    identity.user.role = 'INSTRUCTOR'; render(tree(phase())); expect(q('coach')).toBeNull();
    identity.user = { id: scope.ownerId, role: 'LEARNER' }; identity.viewing = { userId: 'foreign' };
    render(tree(phase())); expect(q('coach')).toBeNull(); expect(phaseTutorialSeen(scope)).toBe(false);
  });
  it('keeps an incoming child ready when the outgoing mount cleans up', () => {
    const a = phase();
    render(<PhaseTutorialProvider phaseId={scope.phaseId} phaseKey={scope.phaseKey}><LoadedTool key="a" phase={a} /><LoadedTool key="b" phase={a} /></PhaseTutorialProvider>);
    act(() => q('coach-skip')!.click());
    render(<PhaseTutorialProvider phaseId={scope.phaseId} phaseKey={scope.phaseKey}><LoadedTool key="b" phase={a} /></PhaseTutorialProvider>);
    expect(q('phase-tutorial-replay')).not.toBeNull(); act(() => replayTour()); expect(q('coach')).not.toBeNull();
  });
});
describe('safe modal entry', () => {
  it('points to the actual Maintenance Change request button before a generic route fallback', () => {
    const maintenance = { ...scope, phaseKey: 'maintenance' as const };
    const nav = <><nav className="phase-room-nav"><a href="/workspace/phase/change">Generic change link</a></nav><div className="phase-document-view-change"><nav className="phase-room-nav"><button className="actual-change">Change request</button><a href="/workspace/phase">Edit files</a></nav></div></>;
    const baseline = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { return this.matches('.actual-change') ? ({ top: 20, left: 300, right: 400, bottom: 60, width: 100, height: 40, x: 300, y: 20, toJSON() {} }) as DOMRect : baseline.call(this); };
    render(<>{nav}<CoachMarks phaseTutorial={maintenance} /></>);
    expect(q('coach-highlight')?.style.left).toBe('296px'); expect(q('coach')?.textContent).not.toContain('another view');
  });
  it('replays after the account menu closes during the same click', () => {
    function MenuReplay() {
      const [open, setOpen] = useState(true);
      return <><button data-testid="nav-user">Account</button>{open && <dialog open aria-label="Your account"><nav onClick={() => setOpen(false)}><button data-testid="menu-replay" onClick={replayTour}>Show me around</button></nav></dialog>}<CoachMarks marks={[{ target: 'nav-user', title: 'Your account', body: 'Return here for help.' }]} /></>;
    }
    render(<MenuReplay />); act(() => q('menu-replay')!.click());
    expect(q('coach')?.getAttribute('aria-label')).toBe('Show me around'); expect(q('coach')?.hasAttribute('open')).toBe(true);
  });
  it('opens over compact chat panels but waits for an expanded conversation to return', async () => {
    const chat = document.createElement('dialog'); chat.dataset.extraTest = ''; chat.open = true; chat.className = 'chat-surface'; chat.setAttribute('aria-modal', 'true'); document.body.append(chat);
    render(direct()); expect(q('coach')).toBeNull(); expect(phaseTutorialSeen(scope)).toBe(false);
    await act(async () => { chat.removeAttribute('aria-modal'); await Promise.resolve(); });
    expect(q('coach')).not.toBeNull(); expect(phaseTutorialSeen(scope)).toBe(true); expect(chat.open).toBe(true);
  });
  it('waits for a visible actual tool and observes no further DOM changes after display', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    render(<CoachMarks phaseTutorial={scope} />); expect(q('coach')).toBeNull(); expect(phaseTutorialSeen(scope)).toBe(false);
    render(direct()); await act(async () => { await Promise.resolve(); });
    expect(q('coach')).not.toBeNull(); expect(disconnect).toHaveBeenCalled();
    act(() => q('coach-skip')!.click());
    const read = vi.spyOn(Storage.prototype, 'getItem'); read.mockClear();
    await act(async () => { host.append(document.createElement('span')); await Promise.resolve(); });
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps generic replay available until a ready phase owns the single replay recipient', () => {
    const shell = <CoachMarks marks={[{ target: 'generic', title: 'Page guidance', body: 'Available here.' }]} />;
    render(<><button data-testid="generic">Page</button>{shell}<CoachMarks phaseTutorial={{ ...scope, ready: false }} /></>);
    act(() => replayTour()); expect(q('coach')?.getAttribute('aria-label')).toBe('Show me around');
    act(() => q('coach-skip')!.click());
    render(<><button data-testid="generic">Page</button>{shell}{direct()}</>);
    act(() => q('coach-skip')!.click()); act(() => replayTour());
    expect(host.querySelectorAll('dialog[open]')).toHaveLength(1); expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
  });
  it('prefers a visible primary control even when its fallback occurs earlier in the DOM', () => {
    const marks = [{ target: 'exact', selector: '.primary', fallbackSelector: '.fallback', title: 'Exact action', body: 'Inspect this action.' }];
    render(<><button className="fallback">Earlier navigation</button><button className="primary">Exact action</button></>);
    host.querySelector('.primary')!.getBoundingClientRect = () => ({ top: 20, left: 300, right: 400, bottom: 60, width: 100, height: 40, x: 300, y: 20, toJSON() {} }) as DOMRect;
    render(<><button className="fallback">Earlier navigation</button><button className="primary">Exact action</button><CoachMarks marks={marks} force /></>);
    expect(q('coach-highlight')?.style.left).toBe('296px');
  });
  it('waits behind an existing dialog and claims only after successful display', async () => {
    const existing = document.createElement('dialog'); existing.dataset.extraTest = ''; existing.open = true; document.body.append(existing);
    render(direct()); expect(q('coach')).toBeNull(); expect(phaseTutorialSeen(scope)).toBe(false);
    await act(async () => { existing.open = false; await Promise.resolve(); });
    expect(q('coach')?.hasAttribute('open')).toBe(true); expect(phaseTutorialSeen(scope)).toBe(true);
  });
  it('keeps active text drafts focused until the learner leaves the field', async () => {
    const input = document.createElement('textarea'); input.dataset.extraTest = ''; input.value = 'unsaved draft'; document.body.append(input); input.focus();
    render(direct()); expect(q('coach')).toBeNull(); expect(input.value).toBe('unsaved draft');
    input.blur(); await act(async () => { window.dispatchEvent(new FocusEvent('focusin')); await Promise.resolve(); });
    expect(q('coach')).not.toBeNull(); expect(input.value).toBe('unsaved draft');
  });
  it('does not claim or loop when showModal fails; explicit replay can retry', async () => {
    HTMLDialogElement.prototype.showModal = () => { throw new Error('temporarily unavailable'); };
    render(direct()); await act(async () => { await Promise.resolve(); }); expect(q('coach')).toBeNull(); expect(phaseTutorialSeen(scope)).toBe(false);
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    act(() => replayTour()); expect(q('coach')).not.toBeNull(); expect(phaseTutorialSeen(scope)).toBe(true);
  });
  it('remembers a shown tutorial in memory when storage refuses access', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    render(direct()); act(() => q('coach-skip')!.click()); render(null); render(direct());
    expect(q('coach')).toBeNull(); expect(phaseTutorialSeen(scope)).toBe(true); get.mockRestore(); set.mockRestore();
  });
  it('keeps six steps readable when panels are closed and never opens a panel', () => {
    render(<><section hidden data-testid="interview-page" /><button id="requirements-interview-tab">Interview</button><CoachMarks phaseTutorial={scope} /></>);
    for (let i = 0; i < 6; i++) { expect(q('coach-count')?.textContent).toBe(`${i + 1} of 6`); act(() => q('coach-next')!.click()); }
    expect(q('coach')).toBeNull(); expect(host.querySelector('section')?.hidden).toBe(true); expect(localStorage.getItem(phaseTutorialKey(scope))).toBe('seen');
  });
  it('has distinct targets and truthful explanation and Apply gates for every phase', () => {
    for (const key of ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const) {
      const marks = phaseTutorialMarks(key); expect(marks).toHaveLength(6); expect(new Set(marks.map(mark => mark.target)).size).toBe(6);
      expect(marks.every(mark => mark.target.startsWith(key))).toBe(true);
      const copy = marks.map(mark => mark.body).join(' '); expect(copy).toContain('explain this exact version'); expect(copy).toContain('Apply only if your explanation is accepted'); expect(copy).not.toMatch(/automatically pass|guaranteed/i);
    }
    expect(phaseTutorialMarks('requirements').map(mark => mark.body).join(' ')).not.toMatch(/editor|Run tests|preview/i);
    expect(phaseTutorialMarks('deployment')[1].body).toContain('does not demonstrate Docker builds');
  });
});
