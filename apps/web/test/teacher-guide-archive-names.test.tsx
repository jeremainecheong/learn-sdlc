// @vitest-environment jsdom
/**
 * Smaller teacher-guide rules.
 *
 * - (a) Start here saves each archive under the API's Content-Disposition
 *   name: learnsdlc-starter.zip and learnsdlc-shelf.zip.
 * - (b) The starter or shelf download's audit row (a `project.sealed-read`
 *   with no project and no path, `action` the archive's name) says what was
 *   downloaded; every other sealed read keeps its sentence and state.
 * - (c) The editor's rail reads this browser's Preview and Export from a
 *   per-version localStorage marker (the Preview one is written by the
 *   preview page once it has loaded). A missing or unreadable marker is
 *   'Not yet'.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventView } from '@learnsdlc/shared';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';
import { draftView } from './support/guide-draft';

const m = vi.hoisted(() => ({
  save: vi.fn(),
  draft: vi.fn(),
  get: vi.fn(),
  files: vi.fn(),
  deepValidation: vi.fn(),
  exportVersion: vi.fn(),
  starterArchive: vi.fn(),
  learnerPreview: vi.fn(),
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
      starterArchive: (...a: unknown[]) => m.starterArchive(...a),
      learnerPreview: (...a: unknown[]) => m.learnerPreview(...a),
    },
  };
});
vi.mock('@/lib/download', () => ({ saveBlob: (...a: unknown[]) => m.save(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p-gm', versionId: 'v-gm' }),
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

import { StartHere, STARTER_DOWNLOADS } from '@/components/staff/guide/StartHere';
import { describeAudit } from '@/components/staff/AuditList';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { guideMarkKey } from '@/components/staff/guide/guide-marks';
import { settle } from './support/dom';

let root: Root;
let host: HTMLDivElement;
// jsdom does not navigate; a click on the Preview link must still reach the editor's handler.
const stopNavigation = (event: Event) => {
  if ((event.target as Element | null)?.closest?.('a')) event.preventDefault();
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(m)) fn.mockReset();
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

describe('(a) Start here saves under the API names', () => {
  it('the table names learnsdlc-starter.zip and learnsdlc-shelf.zip', () => {
    expect(STARTER_DOWNLOADS.starter.file).toBe('learnsdlc-starter.zip');
    expect(STARTER_DOWNLOADS.shelf.file).toBe('learnsdlc-shelf.zip');
  });

  it.each([
    ['starter', 'learnsdlc-starter.zip'],
    ['shelf', 'learnsdlc-shelf.zip'],
  ] as const)('a %s download is saved as %s', async (name, file) => {
    const blob = new Blob(['zip']);
    m.starterArchive.mockResolvedValue({ blob, withheld: null });
    await act(async () => root.render(<StartHere />));
    await act(async () => byId(`guide-starter-${name}`)!.click());
    await settle();
    expect(m.starterArchive).toHaveBeenCalledWith(name);
    expect(m.save).toHaveBeenCalledWith(blob, file);
  });
});

function sealedRead(over: Partial<AuditEventView>): AuditEventView {
  return {
    id: 'a1',
    event: 'project.sealed-read',
    actorUserId: 'teacher-1',
    actorName: 'A Teacher',
    subjectUserId: 'teacher-1',
    subjectName: 'A Teacher',
    targetId: null,
    action: null,
    reason: null,
    detail: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    ...over,
  };
}

describe('(b) the starter and shelf rows in the record', () => {
  it.each([
    ['starter', 'Downloaded the starter archive'],
    ['shelf', 'Downloaded the shelf example'],
  ] as const)('the %s download reads "%s"', (name, title) => {
    const row = sealedRead({
      action: name,
      detail: { name, filename: `learnsdlc-${name}.zip`, size: 1024, sha256: 'a'.repeat(64) },
    });
    expect(describeAudit(row).title).toBe(title);
    expect(describeAudit(row).state).toBe('warn');
  });

  it('control: a sealed read with a path keeps "Read the sealed file <path>"', () => {
    const row = sealedRead({ targetId: 'p-gm', action: 'implementation', detail: { path: 'tests/test_shelf.py' } });
    expect(describeAudit(row)).toMatchObject({ title: 'Read the sealed file tests/test_shelf.py', state: 'warn' });
  });

  it('control: a pathless sealed read on a project, or an unknown name, keeps "Read a sealed file"', () => {
    expect(describeAudit(sealedRead({ targetId: 'p-gm', action: 'implementation' }))).toMatchObject({
      title: 'Read a sealed file',
      state: 'warn',
    });
    expect(describeAudit(sealedRead({ action: 'other', detail: { name: 'other' } }))).toMatchObject({
      title: 'Read a sealed file',
      state: 'warn',
    });
    // A row on a project never reads as a starter download, whatever its action says.
    expect(describeAudit(sealedRead({ targetId: 'p-gm', action: 'starter', detail: { name: 'starter' } })).title).toBe(
      'Read a sealed file',
    );
  });
});

async function mountEditor(versionId = 'v-gm') {
  m.draft.mockResolvedValue(draftView(versionId));
  await act(async () => root.render(<ProjectEditor projectId="p-gm" versionId={versionId} />));
  await settle();
}
const stepState = (key: string) => byId(`guide-step-${key}`)?.getAttribute('data-state');
const stepWord = (key: string) => byId(`guide-step-${key}`)?.querySelector('summary')?.textContent ?? '';
function refuseStorage() {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage refused');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage refused');
  });
}

describe('(c) the rail reads this session\'s Preview', () => {
  // The click does not mark Preview; the preview page does once it has
  // loaded (guide-marks-storage.test.tsx).
  it('is Not yet before the Preview button is used, and still Not yet after the click alone', async () => {
    await mountEditor();
    expect(stepState('preview')).toBe('todo');
    expect(stepWord('preview')).toContain('Not yet');
    await act(async () => byId('project-preview-open')!.click());
    await settle();
    expect(stepState('preview')).toBe('todo');
    expect(stepWord('preview')).toContain('Not yet');
    expect(window.localStorage.getItem(guideMarkKey('previewed', 'v-gm'))).toBeNull();
  });

  // The wrapper stretches across the header; a click beside the link opens nothing.
  it('a click beside the Preview link, on its wrapper, leaves the step Not yet', async () => {
    await mountEditor();
    const link = byId('project-preview-open')!;
    const wrapper = link.parentElement!;
    expect(wrapper.id).toBe('guide-preview');
    await act(async () => wrapper.click());
    await settle();
    expect(stepState('preview')).toBe('todo');
    expect(window.localStorage.getItem(guideMarkKey('previewed', 'v-gm'))).toBeNull();
  });

  it('a marker already in this browser reads as Done on mount; another version\'s does not', async () => {
    window.localStorage.setItem(guideMarkKey('previewed', 'v-other'), '1');
    await mountEditor();
    expect(stepState('preview')).toBe('todo');
    act(() => root.unmount());
    root = createRoot(host);
    window.localStorage.setItem(guideMarkKey('previewed', 'v-gm'), '1');
    await mountEditor();
    expect(stepState('preview')).toBe('done');
    expect(stepState('export')).toBe('todo');
  });

  it('with storage throwing, the Preview button still works and the step stays Not yet', async () => {
    refuseStorage();
    await mountEditor();
    expect(stepState('preview')).toBe('todo');
    await act(async () => byId('project-preview-open')!.click());
    await settle();
    expect(byId('project-editor')).not.toBeNull();
    expect(stepState('preview')).toBe('todo');
    expect(stepWord('preview')).toContain('Not yet');
  });
});

describe('(c) the rail reads this session\'s Export', () => {
  it('is Not yet before an export, and Done once the archive is saved', async () => {
    m.exportVersion.mockResolvedValue({ blob: new Blob(['zip']), withheld: 0 });
    await mountEditor();
    expect(stepState('export')).toBe('todo');
    await act(async () => byId('project-export')!.click());
    await settle();
    expect(byId('project-export-done')).not.toBeNull();
    expect(stepState('export')).toBe('done');
    expect(stepWord('export')).toContain('Done');
    expect(window.localStorage.getItem(guideMarkKey('exported', 'v-gm'))).toBe('1');
  });

  it('a marker already in this browser reads as Done on mount', async () => {
    window.localStorage.setItem(guideMarkKey('exported', 'v-gm'), '1');
    await mountEditor();
    expect(stepState('export')).toBe('done');
    expect(stepState('preview')).toBe('todo');
  });

  it('an export that fails leaves the step Not yet', async () => {
    m.exportVersion.mockRejectedValue(new Error('down'));
    await mountEditor();
    await act(async () => byId('project-export')!.click());
    await settle();
    expect(byId('project-export-error')).not.toBeNull();
    expect(stepState('export')).toBe('todo');
    expect(window.localStorage.getItem(guideMarkKey('exported', 'v-gm'))).toBeNull();
  });

  it('a browser that refuses the file leaves the step Not yet', async () => {
    m.exportVersion.mockResolvedValue({ blob: new Blob(['zip']), withheld: 0 });
    m.save.mockImplementation(() => {
      throw new Error('refused');
    });
    await mountEditor();
    await act(async () => byId('project-export')!.click());
    await settle();
    expect(byId('project-export-error')).not.toBeNull();
    expect(stepState('export')).toBe('todo');
  });

  it('with storage throwing, the export is still saved and the step stays Not yet', async () => {
    refuseStorage();
    m.exportVersion.mockResolvedValue({ blob: new Blob(['zip']), withheld: 0 });
    await mountEditor();
    await act(async () => byId('project-export')!.click());
    await settle();
    expect(byId('project-export-done')).not.toBeNull();
    expect(stepState('export')).toBe('todo');
    expect(stepWord('export')).toContain('Not yet');
  });
});
