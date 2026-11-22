// @vitest-environment jsdom
/**
 * The mentor keeps its mode across the pages of a phase.
 *
 * Every page of a code phase mounts its own `MentorSession`, so a page change
 * is a remount. The mode the learner pressed last, on any page of the phase,
 * is the mode the next mentor of that phase opens in; a mentor that knows an
 * open proposal for the phase opens on Agentic whatever was pressed; another
 * phase is not touched; and a storage that throws keeps the mode for the
 * page's life and changes nothing else. The switch keeps its markup, and a
 * press on the mode already selected does nothing more.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({ panels: [] as { phaseId?: string; onProposalOpen?: (open: boolean) => void }[], mounts: 0 }));
vi.mock('@/lib/useProject', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useProjectMaybe: () => null }));
vi.mock('@/components/chat/ChatSurface', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ChatSurface: ({ children }: { children?: ReactNode }) => <div data-testid="surface">{children}</div>,
}));
vi.mock('@/components/workspace/mentor/StuckFlag', () => ({ StuckFlag: () => null }));
// The Agentic panel stands in as a marker that records what the column hands it, and how often it is mounted.
vi.mock('@/components/workspace/mentor/AgenticPanel', async () => {
  const { useEffect } = await import('react');
  return {
    AgenticPanel: (props: { phaseId?: string; onProposalOpen?: (open: boolean) => void }) => {
      rig.panels.push(props);
      useEffect(() => { rig.mounts += 1; }, []);
      return <div data-testid="agentic-stub" data-phase={props.phaseId} />;
    },
  };
});

import { MentorSession, type PersonaThread } from '@/components/shell/PersonaPanel';
import { MENTOR_MODE_KEY } from '@/components/workspace/mentor/mentorMode';
import { PHASE_EXPERIENCE } from '@/components/phases/experience';
import { PHASE_REVIEWER } from '@/lib/phase';

function thread(phaseStateId: string, key: PhaseKey = 'testing'): PersonaThread {
  return {
    phaseKey: key, phaseStateId, lesson: false, reviewer: PHASE_REVIEWER[key], name: PHASE_EXPERIENCE[key].name, ask: 'Ask',
    messages: [], ordinals: new Map(), asked: 0, busy: false, usage: null, failure: null,
    send: async () => null, explain: async () => null, clearFailure: () => undefined, scrollRef: { current: null },
  } as PersonaThread;
}

let host: HTMLDivElement;
let root: Root;
/** One page of the phase: a fresh mount, as a page change is. */
function page(phaseStateId: string, extra: { guidedOnly?: boolean } = {}) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<MentorSession thread={thread(phaseStateId)} {...extra} />));
}
const button = (name: 'Guided' | 'Agentic') => host.querySelector<HTMLButtonElement>(`.mentor-mode-switch > button[aria-label="${name}"]`)!;
const pressed = () => (['Guided', 'Agentic'] as const).filter((name) => button(name).getAttribute('aria-pressed') === 'true');
const press = (name: 'Guided' | 'Agentic') => act(() => button(name).click());
/** Which body is in view: the Guided feed's or the Agentic panel's (each lives in a `.chat-mode-body`). */
const shown = () => [...host.querySelectorAll<HTMLElement>('.chat-mode-body')].filter((body) => !body.hidden).map((body) => (body.querySelector('[data-testid="agentic-stub"]') ? 'agentic' : 'guided'));
const lastPanel = () => rig.panels[rig.panels.length - 1];

beforeEach(() => {
  rig.panels = [];
  rig.mounts = 0;
  window.sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('the mentor keeps its mode across a phase\'s pages', () => {
  it('a new phase opens in Guided, with no Agentic panel mounted', () => {
    page('phase-a');
    expect(pressed()).toEqual(['Guided']);
    expect(shown()).toEqual(['guided']);
    expect(host.querySelector('[data-testid="agentic-stub"]')).toBeNull();
  });

  it('Agentic pressed on one page is the mode the next page of the same phase opens in, its panel in view', () => {
    page('phase-a');
    press('Agentic');
    expect(pressed()).toEqual(['Agentic']);
    page('phase-a');
    expect(pressed()).toEqual(['Agentic']);
    expect(shown()).toEqual(['agentic']);
    expect(lastPanel().phaseId).toBe('phase-a');
    // And back: Guided pressed is kept the same way.
    press('Guided');
    page('phase-a');
    expect(pressed()).toEqual(['Guided']);
    expect(shown()).toEqual(['guided']);
  });

  it('does not leak to another phase', () => {
    page('phase-a');
    press('Agentic');
    page('phase-b');
    expect(pressed()).toEqual(['Guided']);
    expect(host.querySelector('[data-testid="agentic-stub"]')).toBeNull();
    page('phase-a');
    expect(pressed()).toEqual(['Agentic']);
  });

  it('an open proposal wins over a kept Guided, and a closed one gives the kept mode back', () => {
    page('phase-a');
    press('Agentic');
    act(() => lastPanel().onProposalOpen?.(true));
    press('Guided');
    expect(pressed()).toEqual(['Guided']);
    // The next page of the phase: Guided was pressed last, but a proposal is open.
    page('phase-a');
    expect(pressed()).toEqual(['Agentic']);
    expect(shown()).toEqual(['agentic']);
    // Applied (or set aside) here: this column stays where it is, under the learner's hands...
    act(() => lastPanel().onProposalOpen?.(false));
    expect(pressed()).toEqual(['Agentic']);
    expect(shown()).toEqual(['agentic']);
    // ...and the next page opens in the mode pressed last.
    page('phase-a');
    expect(pressed()).toEqual(['Guided']);
  });

  it('a second press on the selected mode changes nothing: the same panel, the same mode, the same record', () => {
    page('phase-a');
    press('Agentic');
    const kept = window.sessionStorage.getItem(`${MENTOR_MODE_KEY}phase-a`);
    const mounts = rig.mounts;
    press('Agentic');
    press('Agentic');
    expect(pressed()).toEqual(['Agentic']);
    expect(rig.mounts).toBe(mounts);
    expect(window.sessionStorage.getItem(`${MENTOR_MODE_KEY}phase-a`)).toBe(kept);
  });

  it('Guided pressed after Agentic keeps the Agentic panel mounted (hidden), so its drafts are not lost', () => {
    page('phase-a');
    press('Agentic');
    const mounts = rig.mounts;
    press('Guided');
    expect(shown()).toEqual(['guided']);
    expect(host.querySelector('[data-testid="agentic-stub"]')).not.toBeNull();
    expect(rig.mounts).toBe(mounts);
  });

  it('a storage that throws: the mode still carries to the next page, and the column draws as it always did', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    page('phase-c');
    expect(pressed()).toEqual(['Guided']);
    expect(host.querySelector('[data-testid="mentor-chat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-input"]')).not.toBeNull();
    press('Agentic');
    expect(shown()).toEqual(['agentic']);
    page('phase-c');
    expect(pressed()).toEqual(['Agentic']);
    page('phase-d');
    expect(pressed()).toEqual(['Guided']);
  });

  it('a guided-only mentor (a page outside the frame) draws no switch and no Agentic panel, whatever is kept', () => {
    page('phase-a');
    press('Agentic');
    page('phase-a', { guidedOnly: true });
    expect(host.querySelector('.mentor-mode-switch')).toBeNull();
    expect(host.querySelector('[data-testid="agentic-stub"]')).toBeNull();
    expect(shown()).toEqual(['guided']);
  });

  it('the switch keeps its markup: a group named "Mentor mode", two buttons named Guided and Agentic with aria-pressed', () => {
    page('phase-a');
    const group = host.querySelector('.mentor-mode-switch')!;
    expect(group.getAttribute('aria-label')).toBe('Mentor mode');
    expect([...group.querySelectorAll('button')].map((b) => [b.getAttribute('type'), b.getAttribute('aria-label'), b.textContent])).toEqual([
      ['button', 'Guided', 'Guided'],
      ['button', 'Agentic', 'Agentic'],
    ]);
  });
});
