// @vitest-environment jsdom
/**
 * The lesson doors (`EnrollmentView.projectIsDefault` and provenance, read by
 * `lessonsVisibleFor`), drawn from the enrolments the API answered in
 * `apps/api/test/enrollment-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/enrollment.json`) and the phase details
 * of `copy-provenance.json`.
 *
 * `project-copy-sweep.test.tsx` walks every door on hand-built
 * enrolments; this file walks the phase strip, the case file and the
 * sidebar's "Learn" on the recorded ones:
 *
 * - the platform default (`projectIsDefault: true`, every summary
 *   `reference`): every door open;
 * - a teacher's copy whose Requirements is `mixed` (`projectIsDefault:
 *   false`): no guide on Requirements, the guide on the phases still the
 *   reference's, "Learn" drawn because some phase offers one;
 * - the same copy with its summaries' `scenario` dropped (an older API):
 *   every door shut, because `projectIsDefault` is false (fail closed).
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey } from '@learnsdlc/shared';

const shell = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => shell.state,
  useProject: () => {
    if (!shell.state) throw new Error('no provider');
    return shell.state;
  },
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Lee Learner' }),
  useRole: () => 'LEARNER',
}));
vi.mock('@/lib/view-as', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useViewAs: () => null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The search's rows as the bar hands them over (the pattern of
// project-copy-sweep.test.tsx), so the palette's "Learn" can be read from the
// mounted TopBar.
vi.mock('@/components/shell/Palette', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Palette: ({ groups }: { groups: { label: string; items: { label: string }[] }[] }) => (
    <ul data-testid="palette-rows">
      {groups.flatMap((group) => group.items.map((item) => <li key={`${group.label}:${item.label}`}>{item.label}</li>))}
    </ul>
  ),
}));

import { Brief } from '@/components/phases/Brief';
import { PhaseStrip } from '@/components/shell/WorkPage';
import { Sidebar } from '@/components/shell/Sidebar';
import { TopBar } from '@/components/shell/TopBar';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { anyLessonsOffered, lessonsOfferedOn, lessonsVisibleFor } from '@/lib/scenario';
import { stubMatchMedia } from './support/dom';

const read = (name: string) =>
  JSON.parse(readFileSync(repoPath(`apps/api/test/fixtures/contract-bodies/${name}.json`), 'utf-8')).bodies;
const enrolment = read('enrollment') as { copyEnrollment: EnrollmentView; defaultEnrollment: EnrollmentView };
const b0 = read('copy-provenance') as {
  copyEnrollment: EnrollmentView;
  copyPhases: Record<string, PhaseDetail>;
  defaultEnrollment: EnrollmentView;
  defaultPhases: Record<string, PhaseDetail>;
};

const COPY = enrolment.copyEnrollment;
const DEFAULT = enrolment.defaultEnrollment;
/** The copy as an API from before the provenance summary would send it. */
const OLDER: EnrollmentView = { ...COPY, phases: COPY.phases.map(({ scenario: _s, ...rest }) => rest) };

function useShell(enrol: EnrollmentView) {
  shell.state = {
    enrollment: enrol,
    currentPhase: enrol.phases.find((one) => one.order === enrol.currentPhaseOrder),
    details: {},
    projects: [{ slug: enrol.projectSlug, hasWarmup: true }],
    slug: enrol.projectSlug,
    loading: false,
    error: null,
    refresh: () => undefined,
  };
}

let host: HTMLDivElement;
let root: Root;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lessonLinks = () =>
  Array.from(host.querySelectorAll('a'))
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => href === '/learn' || href.startsWith('/learn/'));
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  window.localStorage.clear();
  shell.state = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the lesson doors, from the API recording (WIRE)', () => {
  it('reads the recorded enrolments as the predicate expects: default open, the copy per phase, an older copy shut', () => {
    expect(DEFAULT.projectIsDefault).toBe(true);
    expect(COPY.projectIsDefault).toBe(false);
    for (const summary of DEFAULT.phases) expect([summary.key, lessonsVisibleFor(summary, DEFAULT)]).toEqual([summary.key, true]);
    const perPhase = Object.fromEntries(COPY.phases.map((summary) => [summary.key, lessonsOfferedOn(COPY, summary.key)]));
    expect(perPhase).toEqual({ requirements: false, design: true, implementation: true, testing: true, deployment: true, maintenance: true });
    for (const key of Object.keys(perPhase) as PhaseKey[]) expect([key, lessonsOfferedOn(OLDER, key)]).toEqual([key, false]);
    expect([anyLessonsOffered(DEFAULT), anyLessonsOffered(COPY), anyLessonsOffered(OLDER)]).toEqual([true, true, false]);
    // The provenance recording agrees about both boards.
    expect(b0.defaultEnrollment.projectIsDefault).toBe(true);
    expect(lessonsOfferedOn(b0.copyEnrollment, 'requirements')).toBe(false);
  });

  it("draws the phase strip's guide by the recorded summary", () => {
    useShell(COPY);
    render(<PhaseStrip phase={{ key: 'requirements', title: 'Requirements' }} />);
    expect(host.querySelector('.phase-strip-guide')).toBeNull();
    render(<PhaseStrip phase={{ key: 'design', title: 'Design' }} />);
    expect(host.querySelector('.phase-strip-guide')?.getAttribute('href')).toBe('/learn/design');
    useShell(OLDER);
    render(<PhaseStrip phase={{ key: 'design', title: 'Design' }} />);
    expect(host.querySelector('.phase-strip-guide')).toBeNull();
    useShell(DEFAULT);
    render(<PhaseStrip phase={{ key: 'requirements', title: 'Requirements' }} />);
    expect(host.querySelector('.phase-strip-guide')?.textContent).toBe('Optional phase guide');
  });

  it("offers the case file's guide on the recorded details per phase", () => {
    const copyBoard = b0.copyEnrollment;
    useShell(copyBoard);
    const summaryOf = (board: EnrollmentView, key: string) => board.phases.find((one) => one.key === key)!;
    render(<Brief phase={summaryOf(copyBoard, 'requirements')} detail={b0.copyPhases.requirements} onBegin={() => undefined} />);
    expect(byId('brief-about')).toBeNull();
    expect(lessonLinks()).toEqual([]);
    render(<Brief phase={summaryOf(copyBoard, 'design')} detail={b0.copyPhases.design} onBegin={() => undefined} />);
    expect(byId('brief-about')?.querySelector('a')?.getAttribute('href')).toBe('/learn/design');
    useShell(b0.defaultEnrollment);
    render(<Brief phase={summaryOf(b0.defaultEnrollment, 'requirements')} detail={b0.defaultPhases.requirements} onBegin={() => undefined} />);
    expect(byId('brief-about')?.querySelector('a')?.getAttribute('href')).toBe('/learn/requirements');
  });

  it('draws the sidebar\'s "Learn" on the recorded copy and default, and not on an older copy', () => {
    for (const [enrol, drawn] of [
      [COPY, true],
      [DEFAULT, true],
      [OLDER, false],
    ] as const) {
      useShell(enrol);
      render(
        <ShellProvider>
          <Sidebar />
        </ShellProvider>,
      );
      expect([enrol === OLDER ? 'older' : enrol.projectIsDefault ? 'default' : 'copy', byId('nav-learn')?.getAttribute('href') ?? null]).toEqual([
        enrol === OLDER ? 'older' : enrol.projectIsDefault ? 'default' : 'copy',
        drawn ? '/learn' : null,
      ]);
    }
  });

  it('lists "Learn" in the mounted TopBar search on the recorded copy and default, and not on an older copy', () => {
    const rows = () => Array.from(host.querySelectorAll('[data-testid="palette-rows"] li')).map((li) => li.textContent);
    for (const [enrol, listed] of [
      [COPY, true],
      [DEFAULT, true],
      [OLDER, false],
    ] as const) {
      useShell(enrol);
      render(
        <ShellProvider>
          <TopBar />
        </ShellProvider>,
      );
      const which = enrol === OLDER ? 'older' : enrol.projectIsDefault ? 'default' : 'copy';
      expect(rows(), which).toContain('Progress');
      expect([which, rows().includes('Learn')]).toEqual([which, listed]);
    }
  });
});
