// @vitest-environment jsdom
/**
 * A document page drawn in the workspace's frame offers what
 * the phase's workspace offers, and shows where the phase stands.
 *
 * - Details holds Replay tutorial on every such page once the page holds the
 *   phase's whole detail (Implementation's and Testing's pull request pages
 *   had only the phase and Brief): the frame registers the phase's tutorial as
 *   the workspace does. The phase guide's link is beside it where the phase
 *   offers its lesson, and the reference solution's door where the gate is in.
 * - The header shows the workspace header's state chip ("In progress",
 *   "Review passed", ...) from the same reading of the same detail, after the
 *   phase's place; the stylesheet gives it way to the optional quick check
 *   while the check is on the row.
 * - The left column ends with the workspace's two folds, "Mission and review
 *   criteria" and "Phase requirements and review" (the brief text and the
 *   grading guide), and the change request keeps its own mission fold.
 *
 * Real: the frame, the strip (`PhaseStrip`), the tutorial provider and its
 * replay button, the folds. Stood in: the shell's bar, the mentor, the panels.
 */
import { webPath } from './support/paths';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail, PhaseKey } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({ held: null as unknown }));
vi.mock('next/link', () => ({ default: ({ href, children, prefetch: _p, ...rest }: ComponentProps<'a'> & { prefetch?: unknown }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/workspace/p-4/pr', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/shell/ShellProvider', () => ({ useShellConfig: () => undefined }));
vi.mock('@/components/shell', async () => {
  const work = await import('@/components/shell/WorkPage');
  return { DocPage: () => null, PhaseStrip: work.PhaseStrip, WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main> };
});
vi.mock('@/components/shell/PersonaPanel', () => ({ PersonaPanel: () => <div data-testid="persona-panel" /> }));
vi.mock('@/lib/useProject', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useProjectMaybe: () => rig.held }));
vi.mock('@/lib/session', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useSession: () => ({ id: 'learner-1', role: 'LEARNER' }) }));
vi.mock('@/lib/view-as', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useViewAs: () => null }));
vi.mock('@/components/workspace/PhaseGateBanner', () => ({ ShellPhaseGateBanner: () => null }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' }),
  WorkspacePanelControls: () => <div data-testid="panel-controls" />,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { PhaseTutorialProvider } from '@/components/shell/PhaseTutorial';
import { phaseTutorialKey } from '@/components/shell/tours';

const TITLE: Record<string, string> = { implementation: 'Implementation', testing: 'Testing', deployment: 'Deployment', maintenance: 'Maintenance' };
function detail(key: PhaseKey, patch: Partial<PhaseDetail> = {}): PhaseDetail {
  return {
    id: 'p-4', key, title: TITLE[key], status: 'in_progress', place: 4, count: 6, order: 4,
    files: [{ path: 'web/src/lib/overdue.test.ts', editable: true, content: '' }],
    objectives: ['Add a test: a task due today is not overdue'], intro: 'Add one test that catches a wrong boundary.',
    taskPanel: 'Write one test for the boundary.',
    rubric: { passThreshold: 70, criteria: [{ key: 'boundary', title: 'Boundary covered', description: 'A test fails on the wrong boundary.' }] },
    tasks: [{ key: 'testing', title: 'Testing', status: 'in_progress', required: true }],
    lastSubmission: null,
    ...patch,
  } as unknown as PhaseDetail;
}
const enrollment = { phases: ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'].map((key, i) => ({ key, title: TITLE[key] ?? key, order: i + 1, status: 'in_progress' })), currentPhaseOrder: 4 };

let host: HTMLDivElement;
let root: Root;
function draw(phase: PhaseDetail, view: 'pr' | 'matrix' | 'drill' | 'change' | 'brief', extra: { right?: ReactNode; mission?: ReactNode } = {}) {
  act(() => root.render(
    <PhaseTutorialProvider phaseId="p-4" phaseKey={phase.key as PhaseKey} lessons={false}>
      <PhaseDocumentFrame phase={phase} view={view} title="Heading" {...extra}><p>body</p></PhaseDocumentFrame>
    </PhaseTutorialProvider>,
  ));
}
const strip = () => host.querySelector<HTMLElement>('[data-testid="phase-strip"]')!;
const details = () => strip().querySelector<HTMLElement>('details.phase-strip-details')!;
const chip = () => strip().querySelector('[data-testid="phase-state"]');
const folds = () => [...host.querySelectorAll('aside[data-workspace-panel="brief"] details.phase-contract-detail > summary')].map((s) => s.textContent);

beforeEach(() => {
  rig.held = null;
  // The phase's first-visit tutorial has been seen, so readiness offers the replay and opens nothing.
  window.localStorage.setItem(phaseTutorialKey({ ownerId: 'learner-1', phaseId: 'p-4' }), 'seen');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

describe('Details offers the workspace\'s doors on every page of the frame', () => {
  for (const [key, view] of [['implementation', 'pr'], ['testing', 'pr'], ['testing', 'matrix'], ['deployment', 'drill'], ['deployment', 'pr']] as const) {
    it(`${key}'s ${view} page: Replay tutorial is inside Details once the page holds the whole detail`, () => {
      draw(detail(key), view);
      const replay = strip().querySelector('[data-testid="phase-tutorial-replay"]');
      expect(replay?.textContent).toBe('Replay tutorial');
      expect(details().contains(replay)).toBe(true);
    });
  }

  it('a page still holding the shell\'s summary offers no replay yet (the workspace waits for its own read too)', () => {
    draw({ ...detail('testing'), view: 'summary' } as PhaseDetail, 'pr');
    expect(strip().querySelector('[data-testid="phase-tutorial-replay"]')).toBeNull();
  });

  it('a page outside the frame (the brief) registers nothing: its strip keeps the replay on the row only where its own room is ready', () => {
    draw(detail('testing'), 'brief');
    expect(host.querySelector('[data-testid="phase-tutorial-replay"]')).toBeNull();
  });

  it('the phase guide\'s link sits beside it where the phase offers its lesson (the workspace\'s rule, `lessonsOfferedOn`)', () => {
    // No enrolment held: the lesson is offered, as the workspace's More offers it then.
    draw(detail('testing'), 'pr');
    const guide = details().querySelector('a.phase-strip-guide');
    expect(guide?.textContent).toBe('Optional phase guide');
    expect(guide?.getAttribute('href')).toBe('/learn/testing');
    expect(strip().querySelectorAll('a.phase-strip-guide').length).toBe(1);
  });

  it('the reference solution\'s door, handed over by the page, is read inside Details', () => {
    draw(detail('deployment'), 'drill', { right: <button type="button" data-testid="solution-open">Read the reference solution</button> });
    expect(details().contains(strip().querySelector('[data-testid="solution-open"]'))).toBe(true);
  });
});

describe('the header\'s state chip', () => {
  it('reads "In progress" after the place, in the workspace\'s words, tone and test id', () => {
    draw(detail('testing'), 'pr');
    expect(chip()?.textContent).toBe('In progress');
    expect(chip()?.className).toContain('chip-outline');
    const place = strip().querySelector('[data-testid="phase-place"]')!;
    expect(place.textContent).toBe('Phase 4 of 6');
    expect(place.nextElementSibling).toBe(chip());
    expect(details().contains(chip())).toBe(false);
  });

  it('reads "Needs revision" after a review that asked for more, and "Review passed" once the phase has passed', () => {
    draw(detail('testing', { lastSubmission: { id: 's-1', status: 'completed', passed: false, createdAt: '2026-11-17T00:00:00Z' } } as Partial<PhaseDetail>), 'pr');
    expect(chip()?.textContent).toBe('Needs revision');
    draw(detail('testing', { status: 'passed', tasks: [{ key: 'testing', title: 'Testing', status: 'passed', required: true }] } as Partial<PhaseDetail>), 'pr');
    expect(chip()?.textContent).toBe('Review passed');
  });

  it('is not drawn where the page holds no status, nor on a page outside the frame', () => {
    draw({ id: 'p-4', key: 'testing', title: 'Testing' } as PhaseDetail, 'pr');
    expect(chip()).toBeNull();
    draw(detail('testing'), 'brief');
    expect(host.querySelector('[data-testid="phase-state"]')).toBeNull();
  });

  it('the stylesheet gives the chip way to the quick check on a document header, beside the rules that already do, before the short-window block', () => {
    const css = readFileSync(webPath('components/workspace/phase-experience.css'), 'utf8');
    const rule = '.phase-header--doc:has(>.quick-check-line-inline)>[data-testid=phase-state]{display:none}';
    expect(css).toContain(rule);
    expect(css.indexOf(rule)).toBeGreaterThan(css.indexOf('.phase-header--doc>.quick-check-line-inline [data-testid=concept-prompt-body]{display:none}'));
    // The short-window rules begin with the quick check's place inside More; found by that selector, not by a comment.
    const shortWindow = css.indexOf('.quick-check-line.quick-check-line-menu{');
    expect(shortWindow).toBeGreaterThan(-1);
    expect(css.indexOf(rule)).toBeLessThan(shortWindow);
  });
});

describe('the left column ends with the workspace\'s folds', () => {
  it('"Mission and review criteria", then "Phase requirements and review" with the brief and the grading guide', () => {
    draw(detail('testing'), 'pr');
    expect(folds()).toEqual(['Mission and review criteria', 'Phase requirements and review']);
    const requirements = [...host.querySelectorAll('aside details.phase-contract-detail')][1];
    expect(requirements.querySelector('[data-testid="phase-brief"]')?.textContent).toContain('Write one test for the boundary.');
    expect(requirements.querySelector('[data-testid="grading-guide"] summary')?.textContent).toBe('How this phase is graded');
    expect(requirements.querySelector('[data-testid="grading-guide"]')?.textContent).toContain('Boundary covered');
  });

  it('the change request keeps its own mission fold and gains the requirements fold after it', () => {
    draw(detail('maintenance', { change: { ticket: {} } } as Partial<PhaseDetail>), 'change', { mission: <details className="phase-contract-detail" data-testid="page-mission"><summary>Mission and review criteria</summary></details> });
    expect(folds()).toEqual(['Mission and review criteria', 'Phase requirements and review']);
    expect(host.querySelector('[data-testid="page-mission"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="phase-mission"]').length).toBe(0);
  });

  it('on a teacher\'s authored task (a split phase), the task\'s words as the workspace says them, and a page\'s own mission fold is kept', () => {
    const split = { tasks: [
      { key: 'task-a', title: 'Task A', status: 'in_progress', required: true, rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'Task criterion', description: 'Only this task.' }] } },
      { key: 'task-b', title: 'Task B', status: 'in_progress', required: true },
    ] } as Partial<PhaseDetail>;
    draw(detail('testing', split), 'pr');
    expect(folds()).toEqual(['Task requirements and review']);
    expect(host.querySelector('[data-testid="grading-guide"] summary')?.textContent).toBe('How this task is graded');
    expect(host.querySelector('[data-testid="grading-guide"]')?.textContent).toContain('Task criterion');
    expect(host.querySelector('[data-testid="phase-brief"]')).toBeNull();
    draw(detail('testing', split), 'pr', { mission: <details className="phase-contract-detail" data-testid="page-mission"><summary>Mission and review criteria</summary></details> });
    expect(folds()).toEqual(['Mission and review criteria', 'Task requirements and review']);
  });

  it('a page holding no whole detail draws only what it was handed', () => {
    draw({ id: 'p-4', key: 'testing', title: 'Testing', status: 'in_progress' } as PhaseDetail, 'pr');
    expect(folds()).toEqual([]);
  });

  it('the grading pass line names the project\'s completion on its last phase, as the workspace\'s does', () => {
    rig.held = { enrollment, details: {} };
    draw(detail('maintenance', { change: { ticket: {} } } as Partial<PhaseDetail>), 'pr');
    expect(host.querySelector('[data-testid="grading-guide"]')?.textContent).toContain('A Pass lets you complete the project.');
    draw(detail('testing'), 'pr');
    expect(host.querySelector('[data-testid="grading-guide"]')?.textContent).toContain('A Pass opens the next phase.');
  });
});
