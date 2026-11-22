// @vitest-environment jsdom
/**
 * The rail's Preview and Export marks are
 * kept in the browser's localStorage under the same per-version key
 * (`lsdlc_guide_<previewed|exported>:<versionId>`), so a new tab or a
 * restart of the same browser still reads Done; another version's mark still
 * does not count, and a storage that throws or refuses still reads 'Not yet'.
 * (The preview page writing the Preview mark is guide-preview-mark-timing.test.tsx.)
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function mountEditor(versionId = 'v-gm') {
  m.draft.mockResolvedValue(draftView(versionId));
  await act(async () => root.render(<ProjectEditor projectId="p-gm" versionId={versionId} />));
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

describe('the guide-mark helpers', () => {
  it('guide-marks keys each mark by its version', () => {
    expect(marks.guideMarkKey('previewed', 'v-gm')).toBe(KEY_PREVIEWED);
    expect(marks.guideMarkKey('exported', 'v-gm')).toBe(KEY_EXPORTED);
  });

  it('writeGuideMark writes to localStorage, never to sessionStorage', () => {
    marks.writeGuideMark('previewed', 'v-gm');
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBe('1');
    expect(window.sessionStorage.getItem(KEY_PREVIEWED)).toBeNull();
    expect(marks.readGuideMark('previewed', 'v-gm')).toBe(true);
    expect(marks.readGuideMark('exported', 'v-gm')).toBe(false);
    expect(marks.readGuideMark('previewed', 'v-other')).toBe(false);
  });

  it('a mark stored under the dotted key learnsdlc.guide.<mark>.<version> reads as Done once, and moves to the lsdlc_ key', () => {
    window.localStorage.setItem('learnsdlc.guide.previewed.v-gm', '1');
    expect(marks.readGuideMark('previewed', 'v-gm')).toBe(true);
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBe('1');
    expect(window.localStorage.getItem('learnsdlc.guide.previewed.v-gm')).toBeNull();
    expect(marks.readGuideMark('previewed', 'v-gm')).toBe(true);
    expect(marks.readGuideMark('exported', 'v-gm')).toBe(false);
  });

  it('a mark under the dotted key still reads as Done while a full storage refuses the move, and stays where it is', () => {
    window.localStorage.setItem('learnsdlc.guide.previewed.v-gm', '1');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); });
    expect(marks.readGuideMark('previewed', 'v-gm')).toBe(true);
    expect(window.localStorage.getItem('learnsdlc.guide.previewed.v-gm')).toBe('1');
    expect(window.localStorage.getItem(KEY_PREVIEWED)).toBeNull();
  });

  it('control: a mark left only in sessionStorage does not read as Done', () => {
    window.sessionStorage.setItem(KEY_PREVIEWED, '1');
    expect(marks.readGuideMark('previewed', 'v-gm')).toBe(false);
  });

  it('a storage that throws reads as not written, and writing does not throw', () => {
    refuseStorage();
    expect(() => marks.writeGuideMark('exported', 'v-gm')).not.toThrow();
    expect(marks.readGuideMark('exported', 'v-gm')).toBe(false);
  });

  it('a mark survives a fresh render with a new sessionStorage (a new tab): both steps read Done', async () => {
    window.localStorage.setItem(KEY_PREVIEWED, '1');
    window.localStorage.setItem(KEY_EXPORTED, '1');
    window.sessionStorage.clear();
    await mountEditor();
    expect(stepState('preview')).toBe('done');
    expect(stepWord('preview')).toContain('Done');
    expect(stepState('export')).toBe('done');
  });

  it("another version's mark does not count", async () => {
    window.localStorage.setItem('lsdlc_guide_previewed:v-other', '1');
    window.localStorage.setItem('lsdlc_guide_exported:v-other', '1');
    await mountEditor();
    expect(stepState('preview')).toBe('todo');
    expect(stepState('export')).toBe('todo');
  });

  it('an export saved by the browser writes the exported mark to localStorage', async () => {
    m.exportVersion.mockResolvedValue({ blob: new Blob(['zip']), withheld: 0 });
    await mountEditor();
    await act(async () => byId('project-export')!.click());
    await settle();
    expect(stepState('export')).toBe('done');
    expect(window.localStorage.getItem(KEY_EXPORTED)).toBe('1');
    expect(window.sessionStorage.getItem(KEY_EXPORTED)).toBeNull();
  });

  it('a mark written in another tab of the same browser (a storage event) turns the open rail Done', async () => {
    await mountEditor();
    expect(stepState('preview')).toBe('todo');
    window.localStorage.setItem(KEY_PREVIEWED, '1');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_PREVIEWED, newValue: '1', storageArea: window.localStorage }));
    });
    await settle();
    expect(stepState('preview')).toBe('done');
  });
});
