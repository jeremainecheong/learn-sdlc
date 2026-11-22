// @vitest-environment jsdom
/**
 * That the gate band is connected to the pages that draw it.
 *
 * `PhaseDocumentFrame` renders the genuine `ShellPhaseGateBanner`, so deleting
 * that line fails the first block. That one line is what carries the pass
 * banner to the case file, the change request, the incident drill, the kill
 * matrix, the pull request and the reference solution at once. The rooms that
 * draw the band themselves are rendered with it in their own tests
 * (`design-review-uploaded-words`, `interview-required-tag`, `work-room-header`).
 *
 * The last block reads the phase room's text, because what it protects is
 * where a call sits rather than anything the room draws: the room's held
 * copies of the phase are dropped after the advance, never in the guard that
 * runs before it. A render cannot see a cache that is refilled in the window
 * between the two.
 *
 * What none of this proves: that the deployed pages draw these components for
 * a real enrolment. That is a browser fact, for a browser run against a
 * deployment.
 */
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, moduleText } from './support/source-text';
import type { EnrollmentView, PhaseSummary } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  project: null as { enrollment: EnrollmentView | null } | null,
}));

// Only the shell chrome, the router and the shell's held project are stood in
// for. The banner itself, its button and its copy are the real ones.
vi.mock('next/navigation', () => ({ useRouter: () => rig.router }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/api', () => ({ api: { reflect: vi.fn(), advance: vi.fn() } }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/useProject', () => ({
  useProjectMaybe: () => rig.project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/components/shell', () => ({
  DocPage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PhaseStrip: () => <div data-testid="phase-strip" />,
  WorkPage: ({ strip, children }: { strip: ReactNode; children: ReactNode }) => <div>{strip}{children}</div>,
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ PersonaPanel: () => <div data-testid="persona" /> }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => <div data-testid="brief-intro" /> }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({
    briefOpen: false, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(),
    briefId: 'brief', mentorId: 'mentor',
  }),
  WorkspacePanelControls: () => <div data-testid="panel-controls" />,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
function phase(order: number, over: Partial<PhaseSummary> = {}): PhaseSummary {
  return {
    id: `phase-${order}`,
    key: KEYS[order - 1],
    order,
    title: KEYS[order - 1][0].toUpperCase() + KEYS[order - 1].slice(1),
    status: 'in_progress',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...over,
  };
}
function enrolled(over: Partial<PhaseSummary> = {}): EnrollmentView {
  return {
    id: 'enrolment-1',
    projectSlug: 'a-fake-pack',
    projectTitle: 'A fake pack',
    currentPhaseOrder: 2,
    completed: false,
    startedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    phases: [1, 2, 3, 4, 5, 6].map(order => (order === 6 ? phase(6, over) : phase(order))),
  } as EnrollmentView;
}

let root: Root, host: HTMLDivElement;
const render = (element: ReactElement) => act(async () => { root.render(element); });

beforeEach(() => {
  vi.clearAllMocks();
  rig.project = { enrollment: enrolled({ status: 'passed' }) };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** The maintenance change request, one of the six routes the frame draws. */
const frame = () => (
  <PhaseDocumentFrame
    phase={{ id: 'phase-6', key: 'maintenance', title: 'Maintenance' }}
    view="change"
    crumbs={[]}
    title="Change request"
  />
);

describe('the document frame carries the pass banner to every sub-route', () => {
  it('draws the banner and the way on when the shell says the phase passed', async () => {
    await render(frame());

    // Deleting <ShellPhaseGateBanner/> from PhaseDocumentFrame fails here, and
    // with it the case file, change request, drill, matrix, pull request and
    // reference solution all at once.
    expect(host.querySelector('[data-testid="gate-banner"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="open-reflection"]')).not.toBeNull();
  });

  it('draws one banner and one way on, never two', async () => {
    await render(frame());

    expect(host.querySelectorAll('[data-testid="gate-banner"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="open-reflection"]')).toHaveLength(1);
  });

  it('says nothing about a gate on a phase that has not passed', async () => {
    rig.project = { enrollment: enrolled({ status: 'in_progress' }) };

    await render(frame());

    expect(host.querySelector('[data-testid="gate-banner"]')).toBeNull();
  });

  it('still draws the document when the shell holds no enrolment', async () => {
    rig.project = { enrollment: null };

    await render(frame());

    expect(host.querySelector('[data-testid="gate-banner"]')).toBeNull();
    expect(host.querySelector('[data-testid="phase-strip"]')).not.toBeNull();
  });
});

describe('the phase room drops its held copies after the advance', () => {
  // Read wherever the room is split to.
  const room = () => closureText('app/(app)/workspace/[phaseId]/page.tsx');

  it('hands the clear to the banner\'s after-advance callback', () => {
    // The page's own wiring, read from its own file: the body and the banner
    // also hold an onAdvanced, so a read through the import tree would find
    // one even if the page stopped passing the clear.
    const page = moduleText('app/(app)/workspace/[phaseId]/page.tsx');
    expect(page).toMatch(/onAdvanced=\{afterContinueNow\}/);
    expect(page).toMatch(/const afterContinueNow = useCallback\(\(\) => doRef\.current\.afterContinue\(\)/);
    expect(page).toMatch(/const afterContinue = \(\) => \{\s*DETAILS\.clear\(\);/);
    expect(moduleText('app/(app)/workspace/[phaseId]/WorkspaceBody.tsx')).toMatch(/<PhaseGateBanner[^>]*onAdvanced=\{onAdvanced\}/);
  });

  it('does not clear them in the guard, which runs before the advance', () => {
    const text = room();
    // The guard settles the unsaved buffer and nothing else. A cache emptied
    // there can be refilled by a read of the phase as it still was, and the
    // advance that would have justified emptying it may never happen.
    const start = text.indexOf('const beforeContinue = async');
    const guard = text.slice(start, text.indexOf('\n  };', start));
    expect(guard).toContain('flushSave()');
    expect(guard).not.toContain('DETAILS.clear()');
  });
});
