// @vitest-environment jsdom
/**
 * The quiz page draws the trail every page of a phase draws,
 * "<project> › <Phase> › Quiz", the phase linked to its place on the phases page and the leaf capitalised (the
 * reference solution page's trail is mounted in solution-room.test.tsx). The page's frame is replaced by a stand-in
 * that keeps the breadcrumbs it is handed and draws nothing of the room.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ crumbs: [] as { label: string; href?: string }[], held: true }));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'p4' }), useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    details: rig.held ? { p4: { id: 'p4', key: 'testing', title: 'Testing', status: 'in_progress', tasks: [] } } : {},
    enrollment: { projectTitle: 'Overdue Report — TaskTrackr', phases: [] },
    analytics: null,
    currentPhase: null,
  }),
}));
vi.mock('@/components/shell', async (original) => ({
  ...(await original<typeof import('@/components/shell')>()),
  DocPage: ({ crumbs }: { crumbs: { label: string; href?: string }[] }) => { rig.crumbs = crumbs; return null; },
}));

const { default: QuizPage } = await import('@/app/(app)/workspace/[phaseId]/quiz/page');
let host: HTMLDivElement, root: Root;
beforeEach(() => { rig.crumbs = []; rig.held = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const trail = () => rig.crumbs.map((one) => [one.label, one.href ?? null]);

it('"Overdue Report › Testing › Quiz", the phase a link to its place on the phases page', async () => {
  await act(async () => root.render(<QuizPage />));
  expect(trail()).toEqual([['Overdue Report', '/dashboard'], ['Testing', '/phases?phase=testing'], ['Quiz', null]]);
});

it('a cold tab that holds no phase yet keeps its way into the room, and the leaf still reads "Quiz"', async () => {
  rig.held = false;
  await act(async () => root.render(<QuizPage />));
  expect(trail()).toEqual([['Overdue Report', '/dashboard'], ['Phase', '/workspace/p4'], ['Quiz', null]]);
});
