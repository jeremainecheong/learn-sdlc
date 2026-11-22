// @vitest-environment jsdom
/**
 * The maintenance doors that hold the phase's detail.
 *
 * `roomHref` / `phaseDocHref` open the room `opensChangeRoom` names: the
 * change room for a code Maintenance that carries the teacher's change
 * request, a teacher's own application included (spec 5.3); the workspace
 * directly for an own application's Maintenance in the older format (no
 * change request) and for a Maintenance of another kind, when the caller
 * passes the held detail. Three doors hold that detail and must pass it:
 * built from the bare summary, the href goes through `/change` and its
 * redirect (one hop through a page that draws only a loading line):
 *
 * - the case file page's Go to the workspace (`brief/page.tsx`, `detail` in scope);
 * - the feedback page's "Revise your work" (`feedback/page.tsx`, `details` in scope);
 * - the evidence's "Revise this criterion in your project" (`SubmissionEvidence.tsx`,
 *   given the feedback page's phase).
 *
 * On TaskTrackr's application each of these doors answers exactly
 * `/workspace/<id>/change`.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackReport, PhaseDetail, PhaseProvenanceView, SubmissionView } from '@learnsdlc/shared';

type Application = Pick<PhaseProvenanceView, 'application'> | undefined;
const PHASE = 'p6';
const rig = vi.hoisted(() => ({
  push: vi.fn(),
  history: vi.fn(),
  evidence: vi.fn(),
  notes: vi.fn(),
  query: '',
  project: null as unknown,
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({ PhaseDocumentFrame: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: PHASE }),
  usePathname: () => `/workspace/${PHASE}/brief`,
  useSearchParams: () => new URLSearchParams(rig.query),
  useRouter: () => ({ push: rig.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => rig.project, useProjectMaybe: () => rig.project }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { history: rig.history, teacherFeedback: rig.notes, teacherEvidence: rig.evidence } }));
vi.mock('@/lib/api', () => ({
  api: { getSubmissionWithFiles: rig.evidence, phaseSummary: vi.fn() },
  describeError: (error: Error) => error.message,
  onSessionLeaving: () => () => {},
  onSignOut: () => () => {},
}));

import BriefPage from '@/app/(app)/workspace/[phaseId]/brief/page';
import FeedbackPage from '@/app/(app)/feedback/page';
import { settle } from './support/dom';

const summary = () => ({ id: PHASE, key: 'maintenance' as const, order: 6, title: 'Maintenance', status: 'in_progress' as const, attempts: 1, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null });
/** The teacher's change request a detail carries (`PhaseDetail.change`). */
const CHANGE: PhaseDetail['change'] = {
  ticket: { id: 'CHG-1', title: 'Shelve by surname', summary: 'Shelve by surname.', acceptance: [{ id: 'AC-1', line: 'Order by surname' }] },
  contract: false,
  floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true },
};
const detail = (application: Application, artifactKind?: PhaseDetail['artifactKind'], change?: PhaseDetail['change']) =>
  ({
    ...summary(),
    ...(artifactKind ? { artifactKind } : {}),
    ...(change ? { change } : {}),
    intro: 'Change the application.',
    objectives: ['Make the change.'],
    files: [{ path: 'api/app.py', content: '', editable: true, language: 'python' }],
    tasks: [],
    rubric: { passThreshold: 70, criteria: [{ key: 'change', title: 'The change is made', weight: 1, description: 'It works.' }] },
    ...(application === undefined ? {} : { provenance: { phaseKey: 'maintenance', rollup: application.application === null ? 'own' : 'reference', ...application } }),
  }) as unknown as PhaseDetail;

let serial = 0;
const useScenario = (application: Application, artifactKind?: PhaseDetail['artifactKind'], change?: PhaseDetail['change']) => {
  serial += 1;
  rig.project = {
    enrollment: { id: `enrolment-${serial}`, projectTitle: 'Shelf', projectSlug: `shelf-${serial}`, projectIsDefault: false, currentPhaseOrder: 6, completed: false, phases: [summary()], releases: [] },
    currentPhase: summary(),
    details: { [PHASE]: detail(application, artifactKind, change) },
    analytics: null,
    loading: false,
    revalidating: false,
    error: '',
    reload: () => Promise.resolve(),
  };
};

const report = (): FeedbackReport => ({
  assessmentMode: 'strict_binary', overall: 40, passed: false,
  criteria: [{ key: 'change', title: 'The change is made', weight: 1, score: 40, evidence: ['The change is partly made.'] }],
  checks: [],
  aiReview: { verdict: 'needs_revision', criteriaEvidence: [{ key: 'change', met: false, evidence: 'The handler is unchanged.', issue: 'The change is missing.', nextStep: 'Make the change.' }], summary: 'Revise the change.', strengths: [], improvements: [], processNote: '', provider: 'fixture' },
  aiReliance: { hintsThisPhase: 0, index: 0 }, integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
}) as unknown as FeedbackReport;
const submission = (): SubmissionView => ({ id: 'review', status: 'completed', score: 40, passed: false, verifiedPass: false, report: report(), createdAt: '2026-10-01T00:00:00Z', workspaceSnapshot: {} }) as unknown as SubmissionView;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  rig.query = `phase=${PHASE}&submission=review`;
  rig.notes.mockResolvedValue([]);
  rig.evidence.mockResolvedValue(submission());
  rig.history.mockResolvedValue([{ id: 'review', phaseStateId: PHASE, status: 'completed', passed: false, verifiedPass: false, createdAt: '2026-10-01T00:00:00Z', reviewUnavailable: false }]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const begin = async () => {
  await act(async () => root.render(<BriefPage />));
  await settle(10);
  const button = host.querySelector<HTMLButtonElement>('[data-testid="go-to-workspace"]');
  expect(button, 'the case file draws Go to the workspace').not.toBeNull();
  act(() => button!.click());
  return rig.push.mock.calls.at(-1)?.[0];
};
const feedbackDoors = async () => {
  await act(async () => root.render(<FeedbackPage />));
  await settle(10);
  const link = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent?.includes(text))?.getAttribute('href');
  return { revise: link('Revise your work'), criterion: link('Revise this criterion in your project') };
};

describe('the maintenance doors that hold the phase\'s detail', () => {
  it('on TaskTrackr\'s application each held-detail door answers today\'s /change', async () => {
    for (const application of [undefined, { application: 'TaskTrackr' }] as Application[]) {
      const label = JSON.stringify(application);
      useScenario(application);
      expect(await begin(), `Go to the workspace ${label}`).toBe(`/workspace/${PHASE}/change`);
      act(() => root.render(null));
      useScenario(application);
      const doors = await feedbackDoors();
      expect(doors.revise, `Revise your work ${label}`).toBe(`/workspace/${PHASE}/change`);
      expect(doors.criterion, `Revise this criterion ${label}`).toBe(`/workspace/${PHASE}/change`);
      act(() => root.render(null));
    }
  });

  it('an own application\'s code Maintenance without a change request: Go to the workspace and the feedback doors open the maintenance room directly', async () => {
    useScenario({ application: null }, 'code');
    expect(await begin()).toBe(`/workspace/${PHASE}`);
    act(() => root.render(null));
    useScenario({ application: null }, 'code');
    const doors = await feedbackDoors();
    expect(doors.revise).toBe(`/workspace/${PHASE}`);
    expect(doors.criterion).toBe(`/workspace/${PHASE}`);
  });

  it('an own application\'s code Maintenance with a change request: Go to the workspace and the feedback doors open the change room', async () => {
    useScenario({ application: null }, 'code', CHANGE);
    expect(await begin()).toBe(`/workspace/${PHASE}/change`);
    act(() => root.render(null));
    useScenario({ application: null }, 'code', CHANGE);
    const doors = await feedbackDoors();
    expect(doors.revise).toBe(`/workspace/${PHASE}/change`);
    expect(doors.criterion).toBe(`/workspace/${PHASE}/change`);
  });

  it('a Maintenance of another kind: Go to the workspace and the feedback doors open the workspace directly', async () => {
    useScenario({ application: null }, 'tests', CHANGE);
    expect(await begin()).toBe(`/workspace/${PHASE}`);
    act(() => root.render(null));
    useScenario({ application: null }, 'tests', CHANGE);
    const doors = await feedbackDoors();
    expect(doors.revise).toBe(`/workspace/${PHASE}`);
    expect(doors.criterion).toBe(`/workspace/${PHASE}`);
  });
});
