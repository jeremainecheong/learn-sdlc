// @vitest-environment jsdom
/**
 * First-visit tutorials on phases the learner has already passed and moved on from.
 *
 * In a fresh browser profile every room opened its first-visit tutorial once, the five rooms a finished learner had
 * long left included. A phase the learner has passed and moved on from
 * (`PhaseTutorialScope.movedOn`, set by the workspace layout from the gate band's own rule) does not open its tutorial
 * by itself, and Replay tutorial still opens it. A phase in progress, not started or awaiting a sign-off opens it on
 * first entry, and a key a script pre-marks still keeps it shut. It never shows and vanishes while
 * the phase's state loads: the provider knows `movedOn` from the same enrolment the layout found the phase in, before
 * the room's GET makes the tutorial ready.
 *
 * The harness is phase-tutorial.test.tsx's.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';
import { PhaseTutorialProvider, PhaseTutorialReplay, usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { phaseTutorialKey, phaseTutorialSeen, type PhaseTutorialScope } from '@/components/shell/tours';
const identity = vi.hoisted(() => ({ user: { id: 'tutorial-owner', role: 'LEARNER' }, viewing: null as null | { userId: string } }));
vi.mock('@/lib/session', () => ({ useSession: () => identity.user }));
vi.mock('@/lib/view-as', () => ({ useViewAs: () => identity.viewing }));
let host: HTMLDivElement, root: Root, serial = 0, scope: PhaseTutorialScope;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (node: React.ReactNode) => act(() => root.render(node));
const realRect = Element.prototype.getBoundingClientRect, realScroll = Element.prototype.scrollIntoView;
const realShow = HTMLDialogElement.prototype.showModal, realClose = HTMLDialogElement.prototype.close;
/** Every time the tutorial's dialog was shown, so a show that vanished again is still counted. */
let shown = 0;
beforeEach(() => {
  scope = { ownerId: `owner-${++serial}`, phaseId: `phase-${serial}`, phaseKey: 'requirements', ready: true };
  identity.user = { id: scope.ownerId, role: 'LEARNER' }; identity.viewing = null; localStorage.clear(); shown = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Element.prototype.getBoundingClientRect = () => ({ top: 20, left: 20, right: 220, bottom: 60, width: 200, height: 40, x: 20, y: 20, toJSON() {} }) as DOMRect;
  Element.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.showModal = function () { shown += 1; this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  Element.prototype.getBoundingClientRect = realRect; Element.prototype.scrollIntoView = realScroll;
  HTMLDialogElement.prototype.showModal = realShow; HTMLDialogElement.prototype.close = realClose;
});
function LoadedTool({ phase }: { phase: PhaseDetail | null }) {
  usePhaseTutorialReady(phase);
  return <><button id="requirements-interview-tab">Stakeholder interview</button><PhaseTutorialReplay /></>;
}
function phase(status: PhaseDetail['status'] = 'in_progress'): PhaseDetail { return { id: scope.phaseId, key: scope.phaseKey, status, files: [] } as unknown as PhaseDetail; }
function tree(detail: PhaseDetail | null, movedOn?: boolean) {
  return <PhaseTutorialProvider key={`${identity.user.id}:${scope.phaseId}`} phaseId={scope.phaseId} phaseKey={scope.phaseKey} movedOn={movedOn}><LoadedTool phase={detail} /></PhaseTutorialProvider>;
}

describe('a phase the learner has passed and moved on from', () => {
  it('does not open its tutorial by itself, records nothing, and never shows it while the room loads', () => {
    render(tree(null, true));
    render(tree(phase('passed'), true));
    expect(q('coach')).toBeNull();
    expect(shown).toBe(0);
    expect(phaseTutorialSeen(scope)).toBe(false);
    expect(localStorage.getItem(phaseTutorialKey(scope))).toBeNull();
  });

  it('Replay tutorial still opens it, from the first step', () => {
    render(tree(phase('passed'), true));
    expect(q('coach')).toBeNull();
    act(() => q('phase-tutorial-replay')!.click());
    expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
    expect(q('coach-count')?.textContent).toBe('1 of 6');
  });
});

describe('every other state opens the tutorial once on first entry', () => {
  for (const status of ['in_progress', 'submitted', 'passed'] as const) {
    it(`a phase ${status}, not moved on from (movedOn false or absent): the tutorial opens, 1 of 6, and is remembered`, () => {
      render(tree(phase(status)));
      expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
      expect(q('coach-count')?.textContent).toBe('1 of 6');
      expect(phaseTutorialSeen(scope)).toBe(true);
      act(() => root.unmount()); root = createRoot(host);
      scope = { ...scope, ownerId: `owner-${++serial}`, phaseId: `phase-${serial}` };
      identity.user = { id: scope.ownerId, role: 'LEARNER' };
      render(tree(phase(status), false));
      expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
    });
  }

  it("a pre-marked key keeps it shut, moved on or not, and Skip still writes only the browser's key", () => {
    localStorage.setItem(phaseTutorialKey(scope), 'seen');
    render(tree(phase('in_progress')));
    expect(q('coach')).toBeNull();
    render(tree(phase('passed'), true));
    expect(q('coach')).toBeNull();
    localStorage.clear();
    act(() => root.unmount()); root = createRoot(host);
    scope = { ...scope, ownerId: `owner-${++serial}`, phaseId: `phase-${serial}` };
    identity.user = { id: scope.ownerId, role: 'LEARNER' };
    render(tree(phase('in_progress')));
    act(() => q('coach-skip')!.click());
    expect(q('coach')).toBeNull();
    expect(localStorage.getItem(phaseTutorialKey(scope))).toBe('seen');
  });
});

describe('the moved-on reading changing after the room is ready', () => {
  it('false to true while the tutorial is open (the learner presses Continue past it): it stays open, shown once', () => {
    render(tree(phase('passed'), false));
    expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
    expect(shown).toBe(1);
    render(tree(phase('passed'), true));
    expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
    expect(q('coach-count')?.textContent).toBe('1 of 6');
    expect(shown).toBe(1);
    act(() => q('coach-skip')!.click());
    expect(q('coach')).toBeNull();
    expect(localStorage.getItem(phaseTutorialKey(scope))).toBe('seen');
  });

  it('true to false (a fresh reading: the phase was reopened after a cached "moved on"): the tutorial opens then, once', () => {
    render(tree(phase('passed'), true));
    expect(q('coach')).toBeNull();
    expect(shown).toBe(0);
    render(tree(phase('passed'), false));
    expect(q('coach')?.getAttribute('aria-label')).toBe('Requirements tutorial');
    expect(q('coach-count')?.textContent).toBe('1 of 6');
    expect(shown).toBe(1);
    expect(phaseTutorialSeen(scope)).toBe(true);
    act(() => q('coach-skip')!.click());
    // the reading flipping again never brings it back: it was seen
    render(tree(phase('passed'), true));
    render(tree(phase('passed'), false));
    expect(q('coach')).toBeNull();
    expect(shown).toBe(1);
  });
});
