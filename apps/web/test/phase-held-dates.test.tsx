// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';

/**
 * A date-held phase says its dates (browser proof:
 * e2e/instructor-tools.spec.ts).
 *
 * A class can hold a phase back until a release date (`opensAt`) and give it a
 * due date (`dueAt`). The lock the workspace layout answers a locked phase
 * with (`phase-locked`) must say them; otherwise a learner reads only "Pass
 * your current phase before opening Deployment.", never the date it opens.
 * The lock says the phase's dates (`phase-opens-<key>`, `phase-due-<key>`),
 * and says the gate only while the phase before is not passed.
 */

const rig = vi.hoisted(() => ({
  project: null as unknown,
  params: { phaseId: 'phase-6' },
  path: '/workspace/phase-6',
}));
vi.mock('next/navigation', () => ({
  useParams: () => rig.params,
  usePathname: () => rig.path,
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => rig.project }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ id: 'learner', role: 'LEARNER' }) }));
vi.mock('@/components/shell', () => ({
  WorkPage: ({ heading, testId, children }: { heading: string; testId: string; children: ReactNode }) => (
    <main data-testid={testId}>
      <h1>{heading}</h1>
      {children}
    </main>
  ),
  doorWithTasks: (phase: unknown) => phase,
  phaseDoorHref: () => '/workspace/phase-1',
}));
vi.mock('@/components/workspace/requirements/RequirementsWorkspace', () => ({ RequirementsWorkspace: () => null }));
vi.mock('@/components/shell/PhaseTutorial', () => ({ PhaseTutorialProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

import PhaseWorkspaceLayout from '@/app/(app)/workspace/[phaseId]/layout';

const NOW = Date.parse('2026-10-01T02:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

const phase = (order: number, key: PhaseSummary['key'], title: string, over: Partial<PhaseSummary> = {}): PhaseSummary =>
  ({
    id: `phase-${order}`,
    key,
    order,
    title,
    status: 'locked',
    opensAt: null,
    dueAt: null,
    ...over,
  }) as PhaseSummary;

const projectWith = (phases: PhaseSummary[]) => ({
  details: {},
  enrollment: { phases },
  currentPhase: phases.find((one) => one.status === 'in_progress'),
  loading: false,
  error: '',
  reload: vi.fn(),
});

let host: HTMLDivElement;
let root: Root;
const open = async (phases: PhaseSummary[]) => {
  rig.project = projectWith(phases);
  await act(async () => root.render(<PhaseWorkspaceLayout>room</PhaseWorkspaceLayout>));
};
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('a phase the class holds back, opened by its own route', () => {
  const five = (status: PhaseSummary['status']) => [
    phase(1, 'requirements', 'Requirements', { status: 'in_progress', dueAt: at(14) }),
    phase(2, 'design', 'Design'),
    phase(3, 'implementation', 'Implementation'),
    phase(4, 'testing', 'Testing'),
    phase(5, 'maintenance', 'Maintenance', { status }),
  ];

  it('stays shut and says the date it opens and the date it is due', async () => {
    await open([...five('locked'), phase(6, 'deployment', 'Deployment', { opensAt: at(30), dueAt: at(37) })]);
    expect(host.querySelector('[data-testid="phase-locked"]')).not.toBeNull();
    expect(text('phase-opens-deployment')).toMatch(/^Opens on \d{1,2} \w+ at \d{2}:\d{2}$/);
    expect(text('phase-due-deployment')).toMatch(/^Due \d{1,2} \w+ at \d{2}:\d{2}$/);
    // The phase before is not passed, so the gate is still true, and said.
    expect(host.textContent).toContain('Pass your current phase before opening Deployment.');
  });

  it('does not tell a learner whose phase before is passed to pass it', async () => {
    await open([...five('passed'), phase(6, 'deployment', 'Deployment', { opensAt: at(30) })]);
    expect(text('phase-opens-deployment')).toMatch(/^Opens on /);
    expect(host.textContent).not.toContain('Pass your current phase');
    expect(host.textContent).toContain('Deployment opens on its release date.');
    expect(text('phase-due-deployment')).toBeNull();
  });

  it('draws no date line for a phase held by its gate alone', async () => {
    await open([...five('locked'), phase(6, 'deployment', 'Deployment')]);
    expect(host.querySelector('[data-testid="phase-locked"]')).not.toBeNull();
    expect(text('phase-opens-deployment')).toBeNull();
    expect(text('phase-due-deployment')).toBeNull();
    expect(host.textContent).toContain('Pass your current phase before opening Deployment.');
  });

  it('draws no "Opens on" once the release date has passed', async () => {
    await open([...five('locked'), phase(6, 'deployment', 'Deployment', { opensAt: at(-1) })]);
    expect(text('phase-opens-deployment')).toBeNull();
  });
});
