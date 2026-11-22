// @vitest-environment jsdom
/**
 * The pull request page of a Maintenance whose door is the change room
 * holds the mentor in both of its modes, as the phase's other two pages do.
 * So the page takes part in the assistant's signals: while a proposal
 * operation runs nothing is handed in from it (the header's Submit, the merge
 * card's, and the key), and after an Apply, which changes the saved workspace
 * and no submitted revision, the page says so and reads its data again.
 * Every other phase's review keeps the guided mentor.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(), reload: vi.fn(async () => undefined), reloadProject: vi.fn(async () => undefined),
  mentor: [] as { guidedOnly?: boolean }[], card: [] as { submitReason?: string }[],
  phase: { id: 'phase-pr-s19', key: 'maintenance', title: 'Maintenance', order: 6, place: 6, status: 'in_progress', projectSlug: 'tasktrackr', rubric: {}, attempts: 1, reflection: null } as Record<string, unknown>,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: mocks.phase.id }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => ({ api: { chat: vi.fn() } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: { [mocks.phase.id as string]: mocks.phase }, enrollment: { projectTitle: 'TaskTrackr', phases: [], releases: [], currentPhaseOrder: 6 }, analytics: null, currentPhase: null, reload: mocks.reloadProject }), invalidateProject: vi.fn() }));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({ PhaseDocumentFrame: ({ children, right, mentor }: { children: ReactNode; right: ReactNode; mentor: ReactNode }) => <div><header>{right}</header><aside>{mentor}</aside>{children}</div> }));
vi.mock('@/components/shell', () => ({ DocPage: () => null, briefHref: () => '/brief', doorWithTasks: (phase: unknown) => phase, phaseDoorHref: () => '/workspace/next', solutionHref: () => '/solution', usePersona: () => null, PERSONA_NAME: { maintenance: 'Sage', implementation: 'Devon' } }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: (props: { guidedOnly?: boolean }) => { mocks.mentor.push(props); return <div data-testid="mentor" data-guided-only={String(Boolean(props.guidedOnly))} />; } }));
vi.mock('@/components/pr', () => {
  const head = { id: 'head-submission', attempt: 1, score: null, report: { passed: false, aiReview: { assessmentError: false } } };
  return {
    Conversation: () => null, DiffView: () => null, ChecksCard: () => null, SubmissionsCard: () => null, ChecksTab: () => null, HistoryCard: () => null,
    MergeCard: (props: { submitReason?: string }) => { mocks.card.push(props); return null; },
    gateReason: () => '', prHeadline: () => 'the change',
    usePullRequest: () => ({ detail: mocks.phase, head, threads: [], diffs: [], revisions: [head], gate: 0, fileRevision: head, fileBase: null, threadsFor: () => [], selectRevision: vi.fn(), submit: mocks.submit, reload: mocks.reload, busy: false, filesKept: () => true }),
  };
});

const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');
const { AGENT_BUSY, refreshAgentWorkspace } = await import('@/components/workspace/mentor/useAgentWorkspace');
const { PROPOSAL_HOLD_REASON } = await import('@/components/workspace/signoff-status');

let host: HTMLDivElement, root: Root;
const draw = async (over: Record<string, unknown> = {}) => {
  mocks.phase = { id: 'phase-pr-s19', key: 'maintenance', title: 'Maintenance', order: 6, place: 6, status: 'in_progress', projectSlug: 'tasktrackr', rubric: {}, attempts: 1, reflection: null, ...over };
  await act(async () => root.render(<PullRequestPage />));
};
const busy = (on: boolean, phaseId = mocks.phase.id as string) => act(() => { window.dispatchEvent(new CustomEvent(AGENT_BUSY, { detail: { phaseId, busy: on } })); });
const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="header-submit"]')!;
beforeEach(() => { vi.clearAllMocks(); mocks.mentor.length = 0; mocks.card.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the review of a Maintenance holds the mentor the phase\'s other pages hold', () => {
  it('a Maintenance whose door is the change room: both modes', async () => {
    await draw();
    expect(mocks.mentor.at(-1)?.guidedOnly).toBe(false);
  });
  // Implementation's, Testing's and Deployment's reviews hold both modes too (read in matrix-pr-mentor).
  it('a Maintenance of another kind, and Requirements\' and Design\'s reviews, keep the guided mentor', async () => {
    await draw({ artifactKind: 'document' });
    expect(mocks.mentor.at(-1)?.guidedOnly).toBe(true);
    await draw({ key: 'requirements', title: 'Requirements' });
    expect(mocks.mentor.at(-1)?.guidedOnly).toBe(true);
    await draw({ key: 'design', title: 'Design' });
    expect(mocks.mentor.at(-1)?.guidedOnly).toBe(true);
  });
});

describe('the page beside an assistant that can change the saved workspace', () => {
  it('while a proposal operation runs nothing is handed in: the header\'s Submit, the merge card\'s and the key', async () => {
    await draw();
    expect(submit().disabled).toBe(false);
    expect(mocks.card.at(-1)?.submitReason).toBeUndefined();
    busy(true);
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute('title')).toContain(PROPOSAL_HOLD_REASON);
    expect(mocks.card.at(-1)?.submitReason).toBe(PROPOSAL_HOLD_REASON);
    act(() => { fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
    expect(mocks.submit).not.toHaveBeenCalled();
    busy(false);
    expect(submit().disabled).toBe(false);
    expect(mocks.card.at(-1)?.submitReason).toBeUndefined();
    // an operation on another phase is not this page's
    busy(true, 'another-phase');
    expect(submit().disabled).toBe(false);
  });
  it('after an Apply the page says where the change went and what has it reviewed, and reads its data again', async () => {
    await draw();
    expect(host.querySelector('[data-testid="pr-applied-note"]')).toBeNull();
    await act(async () => { await refreshAgentWorkspace(mocks.phase.id as string); });
    const note = host.querySelector('[data-testid="pr-applied-note"]')!;
    // The notice every room shows after an Apply, then the sentence for a pull request with a revision.
    expect(note.textContent).toContain('The reviewed proposal is saved in this workspace.');
    expect(note.textContent).toContain('This page shows what you last submitted: Submit PR-6 again to have the change reviewed');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('/workspace/phase-pr-s19?panel=code');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.reloadProject).toHaveBeenCalledTimes(1);
    // the page is live again
    expect(submit().disabled).toBe(false);
  });
});
