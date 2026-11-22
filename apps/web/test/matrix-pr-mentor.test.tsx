// @vitest-environment jsdom
/**
 * The planted bugs page and the review pages of Implementation, Testing
 * and Deployment hold the workspace's mentor with both of its modes, as
 * Maintenance's pages do. So they take part in the assistant's
 * signals. Neither page writes a file, so nothing is saved before a proposal
 * operation; while one runs nothing is handed in from them (each Submit, the
 * planted bugs' "Run the bugs again", the merge card's and the key, with the
 * sentence); and after an Apply, which changes the saved workspace and no
 * submitted revision, the page reads its data again and says, in one
 * sentence, that what it shows was not changed, with a link to the
 * workspace's edit view by the row's own address and word.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(), reload: vi.fn(async () => undefined), reloadProject: vi.fn(async () => undefined),
  apiSubmit: vi.fn(), load: vi.fn(), invalidate: vi.fn(),
  mentor: [] as { guidedOnly?: boolean }[], card: [] as { submitReason?: string }[],
  phase: {} as Record<string, unknown>,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: mocks.phase.id }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => ({
  api: { chat: vi.fn(), submissions: vi.fn(async () => []), submit: mocks.apiSubmit, getSubmission: vi.fn() },
  describeError: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/api-workspace', () => ({ workspaceApi: { phase: mocks.load } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(() => new Promise(() => {})), useRecoverWhenBack: () => {} }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()], commitDraft: () => '', clearCommitDraft: vi.fn() }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: { [mocks.phase.id as string]: mocks.phase }, enrollment: { projectTitle: 'TaskTrackr', phases: [], releases: [], currentPhaseOrder: 1 }, analytics: null, currentPhase: null, reload: mocks.reloadProject }),
  fullDetail: () => mocks.phase, invalidateProject: mocks.invalidate,
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({ PhaseDocumentFrame: ({ children, right, mentor }: { children: ReactNode; right: ReactNode; mentor: ReactNode }) => <div><header>{right}</header><aside>{mentor}</aside>{children}</div> }));
vi.mock('@/components/shell', () => ({ DocPage: () => null, briefHref: () => '/brief', doorWithTasks: (phase: unknown) => phase, phaseDoorHref: () => '/workspace/next', solutionHref: () => '/solution', usePersona: () => null, PERSONA_NAME: {} }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: (props: { guidedOnly?: boolean }) => { mocks.mentor.push(props); return <div data-testid="mentor" />; } }));
vi.mock('@/components/workspace/panels/testing/MatrixDoc', () => ({ MatrixCard: () => null, MatrixRead: () => null, MutantDiff: () => null, PlantedBugs: () => null, WhatToDo: () => null, matrixPurpose: () => '' }));
vi.mock('@/components/workspace/panels/testing/Matrix', () => ({ PLANTED_BUGS_EMPTY: 'No planted bugs have run yet.' }));
vi.mock('@/components/workspace/ExplainTest', () => ({ ExplainTestButton: () => null }));
vi.mock('@/components/pr', () => {
  const head = { id: 'head-submission', attempt: 1, score: null, report: { passed: false, aiReview: { assessmentError: false } } };
  return {
    Conversation: () => null, DiffView: () => null, ChecksCard: () => null, SubmissionsCard: () => null, ChecksTab: () => null, HistoryCard: () => null,
    MergeCard: (props: { submitReason?: string }) => { mocks.card.push(props); return null; },
    gateReason: () => '', prHeadline: () => 'the work',
    usePullRequest: () => ({ detail: mocks.phase, head, threads: [], diffs: [], revisions: [head], gate: 0, fileRevision: head, fileBase: null, threadsFor: () => [], selectRevision: vi.fn(), submit: mocks.submit, reload: mocks.reload, busy: false, filesKept: () => true }),
  };
});

const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');
const { default: MatrixPage } = await import('@/app/(app)/workspace/[phaseId]/matrix/page');
const { AGENT_BUSY, prepareAgentOperation, refreshAgentWorkspace } = await import('@/components/workspace/mentor/useAgentWorkspace');
const { PROPOSAL_HOLD_REASON, READ_BACK_HOLD_REASON, READ_BACK_NOTICE } = await import('@/components/workspace/signoff-status');

const PLACE: Record<string, number> = { implementation: 3, testing: 4, deployment: 5 };
const TITLE: Record<string, string> = { implementation: 'Implementation', testing: 'Testing', deployment: 'Deployment' };
let host: HTMLDivElement, root: Root;
const draw = async (page: 'pr' | 'matrix', key: string) => {
  mocks.phase = { id: `phase-${key}-s20`, key, title: TITLE[key], order: PLACE[key], place: PLACE[key], status: 'in_progress', projectSlug: 'tasktrackr',
    rubric: { criteria: [], passThreshold: 70 }, attempts: 1, reflection: null, files: [], tasks: undefined, lastSubmission: null };
  mocks.load.mockResolvedValue(mocks.phase);
  await act(async () => root.render(page === 'pr' ? <PullRequestPage /> : <MatrixPage />));
};
const busy = (on: boolean, phaseId = mocks.phase.id as string) => act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId, busy: on } })); });
const byTestId = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const byText = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.includes(text));
beforeEach(() => { vi.clearAllMocks(); mocks.mentor.length = 0; mocks.card.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the review pages of Implementation, Testing and Deployment', () => {
  const EDIT: Record<string, [string, string]> = {
    implementation: ['?panel=code', 'open Code'], testing: ['?panel=code', 'open Write tests'], deployment: ['?panel=code', 'open Configuration'],
  };
  for (const key of ['implementation', 'testing', 'deployment']) {
    it(`${key}: the mentor has both modes; Submit, the merge card's and the key are held while an operation runs`, async () => {
      await draw('pr', key);
      expect(mocks.mentor.at(-1)?.guidedOnly).toBe(false);
      expect(byTestId('header-submit').disabled).toBe(false);
      busy(true);
      expect(byTestId('header-submit').disabled).toBe(true);
      expect(byTestId('header-submit').getAttribute('title')).toContain(PROPOSAL_HOLD_REASON);
      expect(mocks.card.at(-1)?.submitReason).toBe(PROPOSAL_HOLD_REASON);
      act(() => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
      expect(mocks.submit).not.toHaveBeenCalled();
      busy(false);
      expect(byTestId('header-submit').disabled).toBe(false);
      expect(mocks.card.at(-1)?.submitReason).toBeUndefined();
      busy(true, 'another-phase');
      expect(byTestId('header-submit').disabled).toBe(false);
    });
    it(`${key}: after an Apply the page reads its data again and says so, with the workspace's edit view by its address`, async () => {
      await draw('pr', key);
      // nothing to save first: the operation is not held up by this page
      await act(async () => { await prepareAgentOperation(mocks.phase.id as string); });
      expect(host.querySelector('[data-testid="pr-applied-note"]')).toBeNull();
      await act(async () => { await refreshAgentWorkspace(mocks.phase.id as string); });
      const note = host.querySelector('[data-testid="pr-applied-note"]')!;
      // The notice every room shows after an Apply, then the sentence for a pull request with a
      // revision, naming the control as the header does.
      expect(note.textContent).toContain('The reviewed proposal is saved in this workspace.');
      expect(note.textContent).toContain(`This page shows what you last submitted: Submit PR-${PLACE[key]} again to have the change reviewed`);
      const [query, words] = EDIT[key];
      expect(note.querySelector('a')!.getAttribute('href')).toBe(`/workspace/${mocks.phase.id}${query}`);
      expect(note.querySelector('a')!.textContent).toBe(words);
      expect(mocks.reload).toHaveBeenCalledTimes(1);
      expect(mocks.reloadProject).toHaveBeenCalledTimes(1);
    });
  }
});

describe('the planted bugs page', () => {
  it('the mentor has both modes', async () => {
    await draw('matrix', 'testing');
    expect(mocks.mentor.at(-1)?.guidedOnly).toBe(false);
  });
  // The empty grid draws no second Submit; the header's two controls are the page's hand-ins.
  it('while an operation runs, Submit and "Run the bugs again" are held with the sentence, and the empty grid draws no Submit', async () => {
    await draw('matrix', 'testing');
    const submits = () => [byTestId('phase-testing-submit'), ...byText('Submit PR-4').filter((b) => b.getAttribute('data-testid') !== 'phase-testing-submit')];
    expect(submits()).toHaveLength(1);
    expect(submits().map((b) => b.disabled)).toEqual([false]);
    busy(true);
    for (const button of [...submits(), ...byText('Run the bugs again')]) {
      expect(button.disabled, button.textContent ?? '').toBe(true);
      expect(button.getAttribute('title'), button.textContent ?? '').toContain(PROPOSAL_HOLD_REASON);
    }
    await act(async () => { fireEvent.click(byTestId('phase-testing-submit')); });
    expect(mocks.apiSubmit).not.toHaveBeenCalled();
    busy(false);
    expect(submits().map((b) => b.disabled)).toEqual([false]);
    busy(true, 'another-phase');
    expect(byTestId('phase-testing-submit').disabled).toBe(false);
  });
  it('after an Apply the page reads the phase again and says the planted bugs ran on the last submission', async () => {
    await draw('matrix', 'testing');
    const reads = mocks.load.mock.calls.length;
    expect(host.querySelector('[data-testid="matrix-applied-note"]')).toBeNull();
    await act(async () => { await refreshAgentWorkspace(mocks.phase.id as string); });
    expect(mocks.load.mock.calls.length).toBe(reads + 1);
    expect(mocks.invalidate).toHaveBeenCalled();
    const note = host.querySelector('[data-testid="matrix-applied-note"]')!;
    // The notice every room shows, then the sentence for a phase with a submission (attempts 1).
    expect(note.textContent).toContain('The reviewed proposal is saved in this workspace.');
    expect(note.textContent).toContain('ran on what you last submitted: Submit PR-4 again to run them on the change');
    expect(note.querySelector('a')!.getAttribute('href')).toBe(`/workspace/${mocks.phase.id}?panel=code`);
    expect(note.querySelector('a')!.textContent).toBe('open Write tests');
    // the page is live again
    expect(byTestId('phase-testing-submit').disabled).toBe(false);
  });
});

/*
 * The proposal has finished, but the page's read of it failed. The page
 * does not say the assistant is working: it says, in its own words and on each held control, to retry the read in
 * the mentor; a retry that reads releases it.
 */
describe('a read after an Apply that fails', () => {
  const failOnce = async (page: 'pr' | 'matrix') => {
    if (page === 'pr') mocks.reload.mockRejectedValueOnce(new Error('A network blip.'));
    else mocks.load.mockRejectedValueOnce(new Error('A network blip.'));
    await act(async () => { await expect(refreshAgentWorkspace(mocks.phase.id as string)).rejects.toThrow('A network blip.'); });
  };
  for (const key of ['implementation', 'testing', 'deployment']) {
    it(`${key} review page: Submit, the card's and the key stay held with the sentence that says to retry, and the page says so`, async () => {
      await draw('pr', key);
      await failOnce('pr');
      expect(host.querySelector('[data-testid="applied-read-back"]')!.textContent).toBe(READ_BACK_NOTICE);
      expect(byTestId('header-submit').disabled).toBe(true);
      expect(byTestId('header-submit').getAttribute('title')).toContain(READ_BACK_HOLD_REASON);
      expect(byTestId('header-submit').getAttribute('title')).not.toContain(PROPOSAL_HOLD_REASON);
      expect(mocks.card.at(-1)?.submitReason).toBe(READ_BACK_HOLD_REASON);
      act(() => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
      expect(mocks.submit).not.toHaveBeenCalled();
      await act(async () => { await refreshAgentWorkspace(mocks.phase.id as string); });
      expect(host.querySelector('[data-testid="applied-read-back"]')).toBeNull();
      expect(byTestId('header-submit').disabled).toBe(false);
    });
  }
  it('planted bugs page: its submit controls stay held with the sentence that says to retry, and the page says so', async () => {
    await draw('matrix', 'testing');
    await failOnce('matrix');
    expect(host.querySelector('[data-testid="applied-read-back"]')!.textContent).toBe(READ_BACK_NOTICE);
    for (const button of [byTestId('phase-testing-submit'), ...byText('Run the bugs again')]) {
      expect(button.disabled, button.textContent ?? '').toBe(true);
      expect(button.getAttribute('title'), button.textContent ?? '').toContain(READ_BACK_HOLD_REASON);
    }
    await act(async () => { await refreshAgentWorkspace(mocks.phase.id as string); });
    expect(host.querySelector('[data-testid="applied-read-back"]')).toBeNull();
    expect(byTestId('phase-testing-submit').disabled).toBe(false);
  });
});
