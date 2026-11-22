// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review } from '@/components/experience/shared';
import type { PhaseSummary } from '@learnsdlc/shared';
import CompletionPage from '@/app/(app)/completion/page';

/*
 * The completion page: from the seal a learner reaches the
 * printable record, the journal, the artefacts, and per phase what it saved
 * and the review that accepted it; and the seal says the same thing the
 * printable record's cover says about whether the project is closed.
 */
const state = vi.hoisted(() => ({ phases: [] as PhaseSummary[], reviews: [] as Review[], completed: true }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    loading: false,
    enrollment: { id: 'enrollment', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', completed: state.completed, completedAt: state.completed ? '2026-11-08T10:00:00Z' : null, phases: state.phases },
  }),
}));
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => ({ displayName: 'Recorded learner' }) }));
vi.mock('@/components/experience/shared', async original => ({
  ...await original<typeof import('@/components/experience/shared')>(),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useReviews: () => ({ reviews: state.reviews, loading: false, error: '', refresh: vi.fn() }),
}));

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.completed = true;
  state.phases = KEYS.map((key, index) => ({ id: key, key, title: key, order: index + 1, status: 'passed', attempts: 2, bestScore: 90, reflection: null, opensAt: null, dueAt: null, passedAt: '2026-11-08T01:00:00Z' }));
  state.reviews = state.phases.flatMap(phase => [false, true].map((passed, index) => ({ phase, submission: {
    id: `${phase.id}-${index}`, phaseStateId: phase.id, status: 'completed', passed, verifiedPass: passed,
    reviewUnavailable: false, attempt: index + 1, createdAt: `2026-11-08T0${index}:00:00Z`,
  } })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('your evidence, from the completion page', () => {
  it('links the printable record, the journal and the artefacts by their own routes', async () => {
    await act(async () => root.render(<CompletionPage />));
    const links = [...q('completion-records')!.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['Printable record', '/dossier'], ['Journal', '/journal'], ['Artefacts', '/artefacts']]);
    expect(q('completion-evidence')?.textContent).toContain('Your evidence');
  });

  it('lists per phase what it saved and the review that accepted it, linked to that review', async () => {
    await act(async () => root.render(<CompletionPage />));
    expect(q('completion-deliverable-requirements')?.textContent).toBe('Your user story and its acceptance criteria');
    expect(q('completion-deliverable-design')?.textContent).toBe('Your design record and its contracts');
    expect(q('completion-deliverable-testing')?.textContent).toBe('Your tests and their planted-bug evidence');
    expect(q('completion-deliverable-deployment')?.textContent).toBe('Your deployment record: runbook, drill and incident');
    expect(q('completion-deliverable-maintenance')?.textContent).toBe('Your change record and the release it shipped in');
    for (const key of KEYS) {
      expect(q(`completion-accepted-${key}`)?.textContent).toMatch(/^Accepted by review 2, /);
      expect(q(`completion-accepted-${key}`)?.closest('a')?.getAttribute('href')).toBe(`/feedback?phase=${key}&submission=${key}-1`);
    }
  });

  it('says Recorded with its date once sealed, and no closing line', async () => {
    await act(async () => root.render(<CompletionPage />));
    expect(host.querySelector('.exp-certificate-footer')?.textContent).toContain('Recorded');
    expect(q('completion-closing')).toBeNull();
  });

  it('says what closes the project when every phase passed but the learner has not continued from the last one', async () => {
    state.completed = false;
    await act(async () => root.render(<CompletionPage />));
    expect(host.textContent).toContain('PROJECT COMPLETION RECORD');
    // The line names the real control and the link the last phase.
    expect(q('completion-closing')?.textContent).toContain('All 6 phases passed. The project is complete once you press Complete the project in maintenance.');
    expect(q('completion-closing')?.querySelector('a')?.textContent).toBe('Open maintenance');
    expect(host.querySelector('.exp-certificate-footer')?.textContent).not.toContain('Recorded');
  });
});
