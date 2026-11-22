// @vitest-environment jsdom
/**
 * The teacher's editor, the class card and the learner's case file, drawn
 * from what the API answered in
 * `apps/api/test/copy-provenance-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/copy-provenance.json`).
 *
 * The `b0-*.test.tsx` files prove the surfaces on hand-built payloads; this file
 * proves the payloads are the API's. The recording is a copy of the reference
 * project whose teacher rewrote only the Requirements intro, so it holds a
 * `mixed` phase, a `reference` phase and the application phases. Every name
 * a chip or notice says comes from the recorded payload (`referenceName`,
 * `application`, `applicationFrom`), never from a literal here.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignableVersionView, DraftVersionView, EnrollmentView, PhaseDetail } from '@learnsdlc/shared';
import { applicationPhasesSentence } from '@learnsdlc/shared';

const RECORDING = repoPath('apps/api/test/fixtures/contract-bodies/copy-provenance.json');
const bodies = JSON.parse(readFileSync(RECORDING, 'utf-8')).bodies as {
  teacherDraftEdited: DraftVersionView;
  assignableCard: AssignableVersionView;
  copyEnrollment: EnrollmentView;
  copyPhases: Record<'requirements' | 'design' | 'implementation', PhaseDetail>;
  defaultEnrollment: EnrollmentView;
  defaultPhases: Record<'requirements' | 'design' | 'implementation', PhaseDetail>;
};

const api = vi.hoisted(() => ({ draft: vi.fn(), get: vi.fn(), files: vi.fn(), request: vi.fn() }));
const shell = vi.hoisted(() => ({ state: null as unknown }));

vi.mock('@/lib/api-projects', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  projectsApi: {
    draft: (...a: unknown[]) => api.draft(...a),
    files: (...a: unknown[]) => api.files(...a),
    get: (...a: unknown[]) => api.get(...a),
    validate: vi.fn(),
    publish: vi.fn(),
    addTask: vi.fn(),
    updateTask: vi.fn(),
    setTaskRequired: vi.fn(),
    reorderTasks: vi.fn(),
    removeTask: vi.fn(),
    createDraft: vi.fn(),
    readQuizKey: vi.fn(),
    updatePhase: vi.fn(),
    putInterview: vi.fn(),
    removeInterview: vi.fn(),
    readInterview: vi.fn(),
    replaceFile: vi.fn(),
  },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  request: (...a: unknown[]) => api.request(...a),
}));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => shell.state,
  useProject: () => shell.state,
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', role: 'INSTRUCTOR', displayName: 'A Teacher' }),
  useRole: () => 'LEARNER',
}));
vi.mock('@/lib/view-as', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useViewAs: () => null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { ClassProjectCard, versionProvenanceSentence } from '@/components/staff/ClassProjectCard';
import { Brief } from '@/components/phases/Brief';
import { bridgeApplication, roomIsReference } from '@/lib/scenario';

let host: HTMLDivElement;
let root: Root;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  const node = byId(id);
  expect(node, `no control ${id}`).not.toBeNull();
  await act(async () => {
    node!.click();
  });
};

const draftPhase = (key: string) => bodies.teacherDraftEdited.phases.find((one) => one.key === key)!;
const referenceName = () => draftPhase('requirements').provenance!.referenceName;

beforeEach(() => {
  vi.clearAllMocks();
  shell.state = null;
  api.files.mockResolvedValue([]);
  api.get.mockResolvedValue({
    project: {
      title: bodies.teacherDraftEdited.title,
      platformOwned: false,
      mine: true,
      publishedVersion: null,
      publishedVersionId: null,
      draftVersion: bodies.teacherDraftEdited.version,
      draftVersionId: bodies.teacherDraftEdited.versionId,
    },
    versions: [{ status: 'draft' }],
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root.unmount());
  host.remove();
});

describe('the BX seam, from the API recording (WIRE)', () => {
  it("chips the recorded draft: Requirements partly the teacher's, its intro theirs, the rest the reference's by the payload's name", async () => {
    api.draft.mockResolvedValue(bodies.teacherDraftEdited);
    await act(async () => {
      root.render(<ProjectEditor projectId={bodies.teacherDraftEdited.projectId} versionId={bodies.teacherDraftEdited.versionId} />);
    });
    // referenceName is string | null (null on an own phase); this mixed phase keeps the name.
    const name = referenceName() ?? '';
    expect(name.length).toBeGreaterThan(0);
    expect(byId('phase-provenance-requirements')?.textContent).toBe('Partly yours');
    expect(byId('phase-intro-provenance-requirements')?.textContent).toBe('Yours');
    expect(byId('phase-interview-provenance')?.textContent).toBe(`${name}'s`);
    // Requirements is drawn by the five-step builder, which holds no documents;
    // the documents the recording mounts are chipped on Design, which reads them.
    expect(byId('requirements-builder')).not.toBeNull();
    await click('project-phase-tab-design');
    for (const file of draftPhase('design').provenance!.files) {
      expect(byId(`phase-file-provenance-${file.path}`)?.textContent).toBe(`${name}'s`);
    }
    await click('project-phase-tab-implementation');
    expect(byId('phase-application-implementation')?.textContent).toBe(applicationPhasesSentence(draftPhase('implementation').provenance!.application!));
  });

  it('says on the class card what the recorded assignable version holds', async () => {
    const card = bodies.assignableCard;
    // Said to the teacher, with the payload's own `mine`.
    const sentence = versionProvenanceSentence(card.projectTitle, card.provenance, card.mine);
    expect(sentence).not.toBeNull();
    expect(sentence).toContain(`${card.provenance!.applicationFrom}'s application`);
    expect(sentence).toContain("1 is still");
    api.request.mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.endsWith('/project/assignable')) return Promise.resolve([card]);
      if (method === 'GET' && path.endsWith('/project')) return Promise.resolve({ cohortId: 'class-one', active: null, history: [] });
      return Promise.reject(new Error(`no route for ${method} ${path}`));
    });
    await act(async () => {
      root.render(<ClassProjectCard cohortId="class-one" />);
    });
    await act(async () => {
      fireEvent.change(byId('class-project-pick') as HTMLSelectElement, { target: { value: card.versionId } });
    });
    expect(byId('class-project-provenance')?.textContent).toBe(sentence);
  });

  it("keeps the reference room's scaffolding where roomTask is the reference's, on the copy and on the default", () => {
    for (const [board, phases] of [
      [bodies.copyEnrollment, bodies.copyPhases],
      [bodies.defaultEnrollment, bodies.defaultPhases],
    ] as const) {
      for (const key of ['requirements', 'design'] as const) {
        const summary = board.phases.find((one) => one.key === key)!;
        expect([key, phases[key].provenance?.roomTask]).toEqual([key, 'reference']);
        expect(roomIsReference(phases[key].provenance, summary, board)).toBe(true);
      }
    }
  });

  it("draws the bridge notice on the copy's application phase only: projectIsDefault false, never on the default", async () => {
    const copy = bodies.copyPhases.implementation;
    const plain = bodies.defaultPhases.implementation;
    const application = copy.provenance!.application!;
    expect(plain.provenance!.application).toBe(application);
    expect(bridgeApplication(copy.provenance, bodies.copyEnrollment)).toBe(application);
    expect(bridgeApplication(plain.provenance, bodies.defaultEnrollment)).toBeNull();

    shell.state = { enrollment: bodies.copyEnrollment, details: {}, loading: false, error: null };
    const copySummary = bodies.copyEnrollment.phases.find((one) => one.key === 'implementation')!;
    await act(async () => {
      root.render(<Brief phase={copySummary} detail={copy} onBegin={() => undefined} />);
    });
    const notice = byId('brief-bridge-notice');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(application);

    shell.state = { enrollment: bodies.defaultEnrollment, details: {}, loading: false, error: null };
    const plainSummary = bodies.defaultEnrollment.phases.find((one) => one.key === 'implementation')!;
    await act(async () => {
      root.render(<Brief phase={plainSummary} detail={plain} onBegin={() => undefined} />);
    });
    expect(byId('brief-bridge-notice')).toBeNull();
  });
});
