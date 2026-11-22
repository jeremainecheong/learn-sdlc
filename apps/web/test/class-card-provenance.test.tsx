// @vitest-environment jsdom
/**
 * The class card says what a version holds.
 *
 * Before assigning, a teacher reads how much of the version is its author's
 * own and whose application its last four phases run, from the version's
 * provenance (`AssignableVersionView.provenance`, and the same summary on the
 * assignment in force). The name is the payload's `applicationFrom`, never a
 * literal in the card. A payload from an older build carries no provenance,
 * and the card then says nothing about it rather than guess.
 *
 * The real card, with `request` the only seam (`class-project-card.test.tsx`).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssignableVersionView,
  CohortProjectAssignmentView,
  CohortProjectView,
  VersionProvenanceView,
} from '@learnsdlc/shared';
import { ClassProjectCard, versionProvenanceSentence } from '@/components/staff/ClassProjectCard';

const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  request: calls.request,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const READ = '/instructor/cohorts/class-one/project';
const ASSIGNABLE = '/instructor/cohorts/class-one/project/assignable';

const MIXED: VersionProvenanceView = { ownPhases: 1, mixedPhases: 0, referencePhases: 1, applicationFrom: 'TaskTrackr' };
const ALL_OWN: VersionProvenanceView = { ownPhases: 2, mixedPhases: 0, referencePhases: 0, applicationFrom: 'TaskTrackr' };
const UNTOUCHED: VersionProvenanceView = { ownPhases: 0, mixedPhases: 0, referencePhases: 2, applicationFrom: 'TaskTrackr' };

const assignment = (over: Partial<CohortProjectAssignmentView> = {}): CohortProjectAssignmentView => ({
  id: 'assign-one',
  cohortId: 'class-one',
  projectVersionId: 'version-room',
  projectSlug: 'room-desk',
  projectTitle: 'RoomDesk',
  version: '1.0.0',
  assignedByUserId: 'teacher-a',
  assignedByName: 'Teacher A',
  reason: 'The class works the room booking desk.',
  active: true,
  createdAt: '2026-09-30T09:00:00Z',
  ...over,
});

const version = (over: Partial<AssignableVersionView> = {}): AssignableVersionView => ({
  projectId: 'project-room',
  projectSlug: 'room-desk',
  projectTitle: 'RoomDesk',
  platformOwned: false,
  mine: true,
  versionId: 'version-room-2',
  version: '1.1.0',
  publishedAt: '2026-09-30T08:00:00Z',
  current: false,
  ...over,
});

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = async () => {
  await act(async () => root.render(<ClassProjectCard cohortId="class-one" />));
};
const choose = async (value: string) =>
  act(async () => {
    fireEvent.change(q('class-project-pick') as HTMLSelectElement, { target: { value } });
  });

const serve = (view: CohortProjectView, versions: AssignableVersionView[]) => {
  calls.request.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === READ) return Promise.resolve(view);
    if (method === 'GET' && path === ASSIGNABLE) return Promise.resolve(versions);
    return Promise.reject(new Error(`no route for ${method} ${path}`));
  });
};

beforeEach(() => {
  calls.request.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the provenance sentence', () => {
  it('counts the written phases and names whose application the last four run', () => {
    expect(versionProvenanceSentence('RoomDesk', MIXED)).toBe(
      "Of the 2 written phases in RoomDesk, 1 is the teacher's own and 1 is still TaskTrackr's. Implementation, Testing, Deployment and Maintenance run TaskTrackr's application: its code, hidden tests, deployment and maintenance.",
    );
    expect(versionProvenanceSentence('RoomDesk', ALL_OWN)).toContain("Every written phase of RoomDesk is the teacher's own.");
    expect(versionProvenanceSentence('RoomDesk', UNTOUCHED)).toContain("Every written phase of RoomDesk is still TaskTrackr's.");
  });

  it('says nothing for a payload from an older build', () => {
    expect(versionProvenanceSentence('RoomDesk', undefined)).toBeNull();
  });
});

describe('the class card', () => {
  it('says what the chosen version holds before it is assigned', async () => {
    serve({ cohortId: 'class-one', active: null, history: [] }, [version({ provenance: MIXED })]);
    await render();
    expect(q('class-project-provenance')).toBeNull();
    await choose('version-room-2');
    // Said to the teacher, a version of theirs is "yours".
    expect(q('class-project-provenance')?.textContent).toBe(versionProvenanceSentence('RoomDesk', MIXED, true));
    expect(q('class-project-provenance')?.textContent).toContain('1 is yours and 1 is still');
  });

  it('says what the version in force holds', async () => {
    serve(
      { cohortId: 'class-one', active: assignment({ provenance: ALL_OWN }), history: [assignment({ provenance: ALL_OWN })] },
      [],
    );
    await render();
    expect(q('class-project-active-provenance')?.textContent).toBe(versionProvenanceSentence('RoomDesk', ALL_OWN));
  });

  it('draws no sentence for versions whose payload carries no provenance', async () => {
    serve({ cohortId: 'class-one', active: assignment(), history: [assignment()] }, [version()]);
    await render();
    await choose('version-room-2');
    expect(q('class-project-provenance')).toBeNull();
    expect(q('class-project-active-provenance')).toBeNull();
  });
});
