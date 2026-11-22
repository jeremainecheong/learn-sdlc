// @vitest-environment jsdom
/**
 * The rail's Preview mark is written by the preview page once the learner
 * preview has loaded without a refusal, never on the click on the editor's
 * Preview link. A refused preview, or one still loading, writes nothing.
 * (The marks' storage is guide-marks-storage.test.tsx.)
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearnerPreviewView } from '@learnsdlc/shared';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';
import { draftView } from './support/guide-draft';

const m = vi.hoisted(() => ({
  draft: vi.fn(),
  get: vi.fn(),
  files: vi.fn(),
  deepValidation: vi.fn(),
  exportVersion: vi.fn(),
  learnerPreview: vi.fn(),
  save: vi.fn(),
  params: { projectId: 'p-gm', versionId: 'v-gm' } as { projectId?: string; versionId?: string },
}));

vi.mock('@/lib/api-projects', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api-projects')>();
  return {
    ...real,
    projectsApi: {
      ...real.projectsApi,
      draft: (...a: unknown[]) => m.draft(...a),
      get: (...a: unknown[]) => m.get(...a),
      files: (...a: unknown[]) => m.files(...a),
      deepValidation: (...a: unknown[]) => m.deepValidation(...a),
      exportVersion: (...a: unknown[]) => m.exportVersion(...a),
      learnerPreview: (...a: unknown[]) => m.learnerPreview(...a),
    },
  };
});
vi.mock('@/lib/download', () => ({ saveBlob: (...a: unknown[]) => m.save(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useParams: () => m.params,
  usePathname: () => '/teacher/projects/p-gm/versions/v-gm',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', displayName: 'A Teacher', role: 'INSTRUCTOR' }),
  useRole: () => 'INSTRUCTOR',
}));

import * as marks from '@/components/staff/guide/guide-marks';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import TeacherLearnerPreviewPage from '@/app/(app)/teacher/projects/[projectId]/versions/[versionId]/preview/page';
import { settle } from './support/dom';

let root: Root;
let host: HTMLDivElement;
// jsdom does not navigate; a click on the Preview link must still reach the editor.
const stopNavigation = (event: Event) => {
  if ((event.target as Element | null)?.closest?.('a')) event.preventDefault();
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [m.draft, m.get, m.files, m.deepValidation, m.exportVersion, m.learnerPreview, m.save]) fn.mockReset();
  m.params = { projectId: 'p-gm', versionId: 'v-gm' };
  window.sessionStorage.clear();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  document.addEventListener('click', stopNavigation);
  m.files.mockResolvedValue([]);
  m.deepValidation.mockResolvedValue({
    versionId: 'v-gm',
    status: 'not-run',
    current: false,
    contentDigest: null,
    checks: DEEP_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pending', sentence: 'Not run.', phaseKey: null, taskKey: null })),
    costWarning: { microVMs: 13, sentence: deepValidationCostWarning(13) },
    startedAt: null,
    finishedAt: null,
  });
});
afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root.unmount());
  host.remove();
  document.removeEventListener('click', stopNavigation);
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function previewView(): LearnerPreviewView {
  return {
    title: 'Books on a shelf',
    version: '0.1.0',
    phases: [
      {
        key: 'requirements',
        order: 1,
        title: 'Requirements',
        intro: 'Ask.',
        objectives: [],
        brief: null,
        files: [],
        tasks: [{ key: 'main', order: 1, required: true, title: 'Write the stories', artefactType: 'user-stories', evidence: 'reviewed', needsSignOff: false }],
        quizzes: [],
        interview: null,
        canRun: false,
        runLabel: '',
        checkLabels: ['Story'],
        gate: 'Learners open this first.',
      },
    ],
  } as unknown as LearnerPreviewView;
}

async function mountEditor(versionId = 'v-gm') {
  m.draft.mockResolvedValue(draftView(versionId));
  await act(async () => root.render(<ProjectEditor projectId="p-gm" versionId={versionId} />));
  await settle();
}
async function mountPreviewPage() {
  await act(async () => root.render(<TeacherLearnerPreviewPage />));
  await settle();
}
const stepState = (key: string) => byId(`guide-step-${key}`)?.getAttribute('data-state');
const stepWord = (key: string) => byId(`guide-step-${key}`)?.querySelector('summary')?.textContent ?? '';
const KEY_PREVIEWED = 'lsdlc_guide_previewed:v-gm';
const KEY_EXPORTED = 'lsdlc_guide_exported:v-gm';
function refuseStorage() {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage refused');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage refused');
  });
}

describe('Preview is marked when the preview has loaded, not on the click', () => {
  it('clicking the Preview link writes nothing and the step stays Not yet', async () => {
    await mountEditor();
    await act(async () => byId('project-preview-open')!.click());
    await settle();
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBeNull();
    expect(window.sessionStorage.getItem(KEY_PREVIEWED)).toBeNull();
    expect(stepState('preview')).toBe('todo');
    expect(stepWord('preview')).toContain('Not yet');
  });

  it('the preview page writes the previewed mark once the preview has loaded', async () => {
    m.learnerPreview.mockResolvedValue(previewView());
    await mountPreviewPage();
    expect(m.learnerPreview).toHaveBeenCalledWith('p-gm', 'v-gm');
    expect(byId('preview-stepper')).not.toBeNull();
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBe('1');
    expect(window.localStorage.getItem(KEY_EXPORTED)).toBeNull();
  });

  it('back on the editor after a loaded preview, the step reads Done', async () => {
    m.learnerPreview.mockResolvedValue(previewView());
    await mountPreviewPage();
    act(() => root.unmount());
    root = createRoot(host);
    await mountEditor();
    expect(stepState('preview')).toBe('done');
  });

  it('a refused preview writes nothing', async () => {
    m.learnerPreview.mockRejectedValue(new Error('refused'));
    await mountPreviewPage();
    expect(byId('preview-error')).not.toBeNull();
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBeNull();
    expect(window.sessionStorage.getItem(KEY_PREVIEWED)).toBeNull();
  });

  it('a preview still loading writes nothing', async () => {
    m.learnerPreview.mockReturnValue(new Promise(() => undefined));
    await mountPreviewPage();
    expect(byId('preview-loading')).not.toBeNull();
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBeNull();
  });

  it("the mark is the previewed version's own", async () => {
    m.params = { projectId: 'p-gm', versionId: 'v-two' };
    m.learnerPreview.mockResolvedValue(previewView());
    await mountPreviewPage();
    expect(window.localStorage.getItem('lsdlc_guide_previewed:v-two')).toBe('1');
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBeNull();
  });

  it('with storage throwing, the preview still draws and nothing is marked', async () => {
    refuseStorage();
    m.learnerPreview.mockResolvedValue(previewView());
    await mountPreviewPage();
    expect(byId('preview-stepper')).not.toBeNull();
    expect(marks.readGuideMark('previewed', 'v-gm')).toBe(false);
  });
});
