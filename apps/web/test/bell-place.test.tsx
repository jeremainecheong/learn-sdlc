// @vitest-environment jsdom
/**
 * The bell's "waiting on you" rows wear the current phase's mark, numbered by
 * the phase's place in the learner's own project (spec 4.2, 4.5): Testing in
 * a project of Implementation and Testing is phase 2, not LearnSDLC's 4. The
 * panel holds the phase but not the project's list, so its caller passes the
 * place in.
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';

// jsdom has no modal dialog; the panel's dialog opens as an attribute here.
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });

vi.mock('next/navigation', () => ({ usePathname: () => '/home' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-1', role: 'LEARNER', displayName: 'Amir' }),
}));
const bell = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/lib/notifications', async (original) => ({
  ...(await original<typeof import('@/lib/notifications')>()),
  loadNotifications: async () => undefined,
  useNotifications: () => ({ items: bell.items, unread: bell.items.length, error: '', reload: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() }),
}));

import { BellPanel } from '@/components/shell/BellPanel';

const testing = { id: 'state-testing', key: 'testing', order: 2, title: 'Testing', status: 'in_progress' } as unknown as PhaseSummary;
const step = { key: 'submit-testing', title: 'Submit Testing for the gate', meta: 'Testing', href: '/workspace/state-testing', state: 'now' } as never;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  bell.items = [];
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const markOf = (place?: number): string => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<BellPanel steps={[step]} phase={testing} place={place} />));
  act(() => {
    fireEvent.click(document.querySelector('[data-testid="bell"]')!);
  });
  const item = document.querySelector('[data-testid="bell-item"]');
  expect(item).not.toBeNull();
  return item!.querySelector('span')!.textContent ?? '';
};

describe("the bell's waiting rows", () => {
  it("number the current phase by its place in the learner's project", () => {
    expect(markOf(2)).toBe('2');
  });

  it("keep LearnSDLC's own number only when no place is passed", () => {
    expect(markOf()).toBe('4');
  });
});

/*
 * The notification rows ("What happened") name a phase but no project. The
 * row's link names the phase state it is about (`/workspace/<id>...`,
 * `/feedback?phase=<id>...`), so a row about a phase of the learner's current
 * enrolment, whose list the shell already holds, is numbered by its place
 * there, with no read. A row about a phase the list does not hold keeps
 * LearnSDLC's own number.
 */
describe("the bell's notification rows", () => {
  const implementation = { id: 'state-implementation', key: 'implementation', order: 1, title: 'Implementation', status: 'passed' } as unknown as PhaseSummary;
  const note = (id: string, phaseKey: string, href: string) =>
    ({ id, kind: 'gate.passed', audience: 'learner', title: `${phaseKey} passed`, detail: null, href, phaseKey, actorName: null, readAt: null, createdAt: '2026-10-23T00:00:00.000Z' });
  const marksOf = (phases?: PhaseSummary[]): string[] => {
    act(() => root?.unmount());
    host?.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<BellPanel steps={[]} phase={testing} place={2} phases={phases} />));
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="bell"]')!);
    });
    return [...document.querySelectorAll('[data-testid="bell-note"]')].map((row) => row.querySelector('span')!.textContent ?? '');
  };

  it("number a row about a phase of the learner's project by its place there", () => {
    bell.items = [
      note('n1', 'testing', '/workspace/state-testing/pr'),
      note('n2', 'implementation', '/feedback?phase=state-implementation&submission=s1'),
    ];
    expect(marksOf([implementation, testing])).toEqual(['2', '1']);
  });

  it("keep LearnSDLC's own number for a row about a phase the project's list does not hold", () => {
    bell.items = [note('n1', 'testing', '/workspace/another-state'), note('n2', 'implementation', '/dashboard')];
    expect(marksOf([implementation, testing])).toEqual(['4', '3']);
    expect(marksOf()).toEqual(['4', '3']);
  });
});
