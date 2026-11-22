// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import AppLayout from '@/app/(app)/layout';

const project = vi.hoisted(() => ({ loading: false }));
const session = vi.hoisted(() => ({ current: { id: 'learner-a', displayName: 'A' } as { id: string; displayName: string } | null }));
vi.mock('@/lib/session', () => ({ useSession: () => session.current }));
vi.mock('@/components/shell/AppFrame', () => ({ SessionGate: ({ children }: { children: ReactNode }) => children, AppFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/shell/ShellProvider', () => ({ ShellProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/useProject', () => ({ useProject: () => project, ProjectProvider: ({ children }: { children: ReactNode }) => children }));

function PrivateRoom() {
  const [draft, setDraft] = useState('');
  return <button onClick={() => setDraft('Private draft for learner A')}>{draft || 'Empty workspace'}</button>;
}

it('keeps the workspace on normal profile/navigation updates and discards its private state when the account changes', () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    const button = host.querySelector('button')!;
    act(() => button.click());
    session.current = { id: 'learner-a', displayName: 'Updated name' };
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    expect(host.querySelector('button')).toBe(button);
    expect(host.textContent).toBe('Private draft for learner A');
    session.current = { id: 'learner-b', displayName: 'B' };
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    expect(host.querySelector('button')).not.toBe(button);
    expect(host.textContent).toBe('Empty workspace');
    session.current = null;
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    expect(host.textContent).toBe('Empty workspace');
  } finally { act(() => root.unmount()); host.remove(); }
});

it('holds the initial shell until project data arrives, then preserves the room during background refresh', () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  session.current = { id: 'learner-a', displayName: 'A' }; project.loading = true;
  try {
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    expect(host.querySelector('[data-testid="project-entry"]')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();
    project.loading = false;
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    const room = host.querySelector('button')!;
    act(() => room.click());
    project.loading = true;
    act(() => root.render(<AppLayout><PrivateRoom /></AppLayout>));
    expect(host.querySelector('button')).toBe(room);
    expect(host.textContent).toBe('Private draft for learner A');
    expect(host.querySelector('[data-testid="project-entry"]')).toBeNull();
  } finally { project.loading = false; act(() => root.unmount()); host.remove(); }
});
