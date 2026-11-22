// @vitest-environment jsdom
/**
 * "Read the mutation evidence" is the last line in view on the planted bugs page at
 * 1440 by 900, so opening it would draw its first sentence under the window's foot with nothing new shown. When the person
 * opens it by pressing its summary, it is brought into view in the page's column by the least scroll, instantly and
 * only when it is out of view: the whole fold when it fits the column (a short fold), its summary and first lines when
 * it is taller (never the summary to the column's top). Closing it moves nothing, and neither does a fold opened any
 * other way or a fold inside it. The fold's markup is unchanged by the reveal: its class, its summary and what it
 * holds, read off the rendered page.
 *
 * The rig is pr-matrix-apply-notices': the REAL planted bugs page, its cards drawn as nothing, and one planted bug run.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIX = vi.hoisted(() => ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
const mocks = vi.hoisted(() => ({ load: vi.fn(), phase: {} as Record<string, unknown> }));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: mocks.phase.id }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => ({ api: { chat: vi.fn(), submissions: vi.fn(async () => []), submit: vi.fn(), getSubmission: vi.fn() }, describeError: (_e: unknown, fallback: string) => fallback }));
vi.mock('@/lib/api-workspace', () => ({ workspaceApi: { phase: mocks.load } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(() => new Promise(() => {})), useRecoverWhenBack: () => {} }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()], commitDraft: () => '', clearCommitDraft: vi.fn() }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: { [mocks.phase.id as string]: mocks.phase }, enrollment: { projectTitle: 'Deadline badge', phases: SIX.map((key, i) => ({ key, order: i + 1 })), releases: [], currentPhaseOrder: 4 }, analytics: null, currentPhase: null, reload: vi.fn() }),
  fullDetail: () => mocks.phase, invalidateProject: vi.fn(),
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
// The page's column, as `.phase-document-content` draws it: the box that scrolls.
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({ PhaseDocumentFrame: ({ children }: { children: ReactNode }) => <div data-testid="column" style={{ overflowY: 'auto' }}>{children}</div> }));
vi.mock('@/components/shell', () => ({ DocPage: () => null, briefHref: () => '/brief', solutionHref: () => '/solution', usePersona: () => null, PERSONA_NAME: {} }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/panels/testing/MatrixDoc', () => ({
  MatrixCard: () => null, WhatToDo: () => null, PlantedBugs: () => <p>The one planted bug</p>, MutantDiff: () => null,
  MatrixRead: () => <p>No planted bug makes a task due yesterday is overdue fail.</p>, matrixPurpose: () => '',
}));
vi.mock('@/components/workspace/panels/testing/lib', async (original) => ({ ...await original<object>(), matrixView: () => ({ total: 1, unrun: false }) }));
vi.mock('@/components/workspace/ExplainTest', () => ({ ExplainTestButton: () => null }));

const { default: MatrixPage } = await import('@/app/(app)/workspace/[phaseId]/matrix/page');

const phase = {
  id: 'phase-testing', key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status: 'passed', projectSlug: 'deadline',
  rubric: { criteria: [], passThreshold: 70 }, attempts: 1, reflection: null, files: [], lastSubmission: null,
  tasks: [{ key: 'main', order: 1, required: true, title: 'The work', artefactType: 'code', evidence: 'reviewed', sealed: true, status: 'passed', awaitingSignOff: false,
    attempts: 1, bestScore: 100, passedAt: null, lastSubmissionId: null, resetAt: null, solution: { available: false, files: 0, readAt: null } }],
  taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
};

/**
 * Where things are drawn at 1440 by 900, as measured in a browser: the column from y 312 (under the page's
 * heading) to the window's foot at 900; the closed fold's summary is the last line in view (844 to 868), and the
 * fold's first block, its two-line sentence, starts at 880 under the summary's 12 px margin.
 */
let geometry = { summary: [844, 868], first: [880, 921], fold: [828, 1290] };
const scrollTo = vi.fn();
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); geometry = { summary: [844, 868], first: [880, 921], fold: [828, 1290] };
  mocks.phase = phase; mocks.load.mockResolvedValue(phase);
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const at = (r: number[]) => r as [number, number];
    const [top, bottom] = this.getAttribute('data-testid') === 'column' ? [312, 900]
      : this.tagName === 'DETAILS' ? at(geometry.fold)
      : this.tagName === 'SUMMARY' ? at(geometry.summary)
      : this.textContent?.startsWith('No planted bug') ? at(geometry.first)
      : [0, 0];
    return { top, bottom, height: bottom - top, left: 0, right: 700, width: 700, x: 0, y: top, toJSON() {} } as DOMRect;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const open = async () => {
  await act(async () => root.render(<MatrixPage />));
  await act(async () => { await Promise.resolve(); });
};
const fold = () => host.querySelector<HTMLDetailsElement>('details.phase-evidence-detail')!;
const column = () => host.querySelector<HTMLElement>('[data-testid="column"]')!;
/** A press on `target`: the fold opens or closes (its default action) and fires "toggle" a moment later, as a browser does. */
const press = async (target: HTMLElement = fold().querySelector('summary')!) => {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('opening "Read the mutation evidence" brings its first lines into view', () => {
  it('the fold: its summary, then the reading, the bug and the diff inside it, closed', async () => {
    await open();
    expect(fold()).not.toBeNull();
    expect(fold().open).toBe(false);
    expect(fold().querySelector('summary')!.textContent).toBe('Read the mutation evidence');
    expect(fold().textContent).toBe('Read the mutation evidenceNo planted bug makes a task due yesterday is overdue fail.The one planted bug');
  });

  it('the live fold, pressed open at the foot of the view: it fits the column, so the column moves by the least that shows ALL of it (402 px)', async () => {
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 300 });
    await press();
    expect(fold().open).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.instances[0]).toBe(column());
    // The fold's foot (1290) to 12 px above the view's foot (900), so "The one planted bug", "Caught by 1" and "What
    // B1 changes" show without a scroll; its top (828) lands at 426, under the column's top (312). Moving only by the
    // sentence's 33 px would not show them.
    expect(scrollTo).toHaveBeenCalledWith({ top: 300 + (1290 - 900 + 12), behavior: 'instant' });
  });

  it('a short fold wholly below the view, pressed open: all of it comes into view by the least scroll, its summary under the column\'s top', async () => {
    // The fold's top (920) is under the view's foot; a reveal of its head only would stop at its first sentence.
    geometry = { summary: [936, 960], first: [972, 1013], fold: [920, 1380] };
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 0 });
    await press();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1380 - 900 + 12, behavior: 'instant' });
    // After the move the summary is at 936 - 492 = 444, below the column's top (312).
    expect(936 - (1380 - 900 + 12)).toBeGreaterThan(312);
  });

  it('a short fold already wholly in view when pressed open moves nothing', async () => {
    geometry = { summary: [416, 440], first: [452, 493], fold: [400, 862] };
    await open();
    await press();
    expect(fold().open).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a fold just too tall for the column (its height and the two 12 px margins one px over the view) keeps the head-only move', async () => {
    // The column is 588 px high: a fold of 565 px does not fit with its margins, so only its summary and sentence come in.
    geometry = { summary: [844, 868], first: [880, 921], fold: [828, 828 + 565] };
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 300 });
    await press();
    expect(scrollTo).toHaveBeenCalledWith({ top: 300 + (921 - 900 + 12), behavior: 'instant' });
  });

  it('the showcase\'s tall fold: the summary is not taken to the top of the column; the column moves only as far as its first lines need', async () => {
    // Eight planted bugs and five tests: the fold runs far below the view, and its first block (three lines and "The 5 tests") is taller.
    geometry = { summary: [844, 868], first: [880, 966], fold: [828, 2400] };
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 1500 });
    await press();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1500 + (966 - 900 + 12), behavior: 'instant' });
  });

  it('a first block longer than the first lines: only its first lines are brought in', async () => {
    geometry = { summary: [844, 868], first: [880, 1400], fold: [828, 2400] };
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 0 });
    await press();
    expect(scrollTo).toHaveBeenCalledWith({ top: 868 + 120 - 900 + 12, behavior: 'instant' });
  });

  it('the summary pressed with its first lines already in view stays where it was, however far the fold runs below', async () => {
    geometry = { summary: [500, 524], first: [536, 577], fold: [484, 1900] };
    await open();
    await press();
    expect(fold().open).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('closing it by its summary moves nothing', async () => {
    await open();
    await press();
    scrollTo.mockClear();
    await press();
    expect(fold().open).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a fold opened without a press (not by the person) moves nothing', async () => {
    await open();
    await act(async () => { fold().open = true; fold().dispatchEvent(new Event('toggle')); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a fold inside it ("The 5 tests"), pressed open, moves nothing', async () => {
    await open();
    await press();
    scrollTo.mockClear();
    const inner = document.createElement('details');
    const innerSummary = document.createElement('summary');
    innerSummary.textContent = 'The 5 tests';
    inner.append(innerSummary);
    fold().append(inner);
    // Its summary at the view's foot, where a reveal would move the column if it counted.
    geometry = { ...geometry, summary: [890, 914] };
    await press(innerSummary);
    expect(inner.open).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
    inner.remove();
  });
});
