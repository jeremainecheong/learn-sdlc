// @vitest-environment jsdom
/**
 * The workspace layout's half: which phases count as passed and moved on from, the state in which the
 * first-visit tutorial does not open by itself (tutorial-moved-on.test.tsx has the tutorial's half). The rule is
 * the gate band's own (`movedOnFrom`: the project completed, or the learner standing on a later phase), on a phase
 * that passed. The harness is workspace-route-boundary.test.tsx's, with the tutorial provider replaced by a probe
 * that records what the layout hands it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  phaseId: 'p-design', path: '/workspace/p-design/design', search: '',
  project: { currentPhase: null, details: {} as Record<string, unknown>, enrollment: null as unknown, loading: false, error: '', reload: () => {} },
  movedOn: [] as (boolean | undefined)[],
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: state.phaseId }), usePathname: () => state.path, useSearchParams: () => new URLSearchParams(state.search), useRouter: () => ({ replace: () => {} }) }));
vi.mock('@/lib/useProject', () => ({ useProject: () => state.project }));
vi.mock('@/lib/session', async (real) => ({ ...(await real<object>()), useSession: () => ({ id: 'learner-1', role: 'LEARNER' }) }));
vi.mock('@/components/shell/PhaseTutorial', () => ({
  PhaseTutorialProvider: ({ movedOn, children }: { movedOn?: boolean; children: React.ReactNode }) => {
    state.movedOn.push(movedOn);
    return <>{children}</>;
  },
}));
vi.mock('@/components/workspace/requirements/RequirementsWorkspace', () => ({ RequirementsWorkspace: () => <div /> }));
const { default: Layout } = await import('@/app/(app)/workspace/[phaseId]/layout');
let root: Root, host: HTMLDivElement;
beforeEach(() => { state.movedOn = []; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
/** An enrolment standing on phase `current` (1 to 6), `designStatus` for Design, the rest passed before it. */
function enrol(current: number, designStatus: string, completed = false) {
  state.project.enrollment = {
    completed,
    currentPhaseOrder: current,
    phases: PHASES.map((key, i) => ({ id: `p-${key}`, key, title: key, order: i + 1, attempts: 1, status: key === 'design' ? designStatus : i + 1 < current ? 'passed' : i + 1 === current ? 'in_progress' : 'locked' })),
  };
}
const movedOnFor = () => { act(() => root.render(<Layout><div /></Layout>)); return state.movedOn.at(-1); };

describe('the layout tells the tutorial a phase is passed and moved on from', () => {
  it('Design passed, the learner on Implementation or later: moved on', () => {
    enrol(3, 'passed');
    expect(movedOnFor()).toBe(true);
    enrol(6, 'passed');
    expect(movedOnFor()).toBe(true);
  });

  it('Design passed on a completed project: moved on', () => {
    enrol(6, 'passed', true);
    expect(movedOnFor()).toBe(true);
  });

  it('Design in progress or awaiting a review, the learner on it: not moved on, the tutorial drawn', () => {
    enrol(2, 'in_progress');
    expect(movedOnFor()).toBe(false);
    enrol(2, 'submitted');
    expect(movedOnFor()).toBe(false);
  });

  it('Design passed while the learner still stands on it (ready to continue, or awaiting a sign-off elsewhere): not moved on', () => {
    enrol(2, 'passed');
    expect(movedOnFor()).toBe(false);
  });

  it('a later phase reopened by a retry is not moved on from, though the learner stands past it', () => {
    enrol(4, 'in_progress');
    expect(movedOnFor()).toBe(false);
  });
});
