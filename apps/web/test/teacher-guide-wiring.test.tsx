// @vitest-environment jsdom
/**
 * The teacher guide's pieces, mounted where they belong.
 *
 * - The starter downloads call GET /instructor/starter/:name; the "Teacher
 *   guide" row is drawn for staff and not for a learner.
 * - The upload success panel lists what the upload changed only when
 *   `result.warnings` holds a line; otherwise the draft opens with no panel.
 * - The refusal explainer sits under the fixed sentence, never inside it.
 * - The editor mounts the rail and the Preview button.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, moduleText } from './support/source-text';
import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_HELP, UPLOAD_WARNINGS_SENTENCE } from '@learnsdlc/shared';

const m = vi.hoisted(() => ({
  role: 'INSTRUCTOR' as 'INSTRUCTOR' | 'LEARNER',
  push: vi.fn(),
  save: vi.fn(),
  close: vi.fn(),
  uploaded: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: m.push, replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/projects',
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
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'u1', role: m.role, displayName: 'Someone' }),
  useRole: () => m.role,
}));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => null,
}));
vi.mock('@/lib/view-as', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useViewAs: () => null }));
vi.mock('@/lib/download', () => ({ saveBlob: m.save }));

import { ApiError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { StartHere } from '@/components/staff/guide/StartHere';
import { UploadProject } from '@/components/staff/projects/UploadProject';
import { Sidebar } from '@/components/shell/Sidebar';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { typeInto, waitUntil } from './support/dom';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  m.role = 'INSTRUCTOR';
  m.push.mockReset();
  m.save.mockReset();
  m.close.mockReset();
  m.uploaded.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the starter downloads and the staff-only link', () => {
  it('projectsApi.starterArchive reads GET /instructor/starter/:name', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { 'content-type': 'application/zip' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const got = await projectsApi.starterArchive('shelf');
    expect(got.blob.size).toBe(4);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect([new URL(url, 'http://x').pathname.replace(/^.*\/api\/v1/, ''), init.method]).toEqual(['/instructor/starter/shelf', 'GET']);
  });

  it('Start here downloads each archive through that call and saves it', async () => {
    const blob = new Blob(['zip']);
    const spy = vi.spyOn(projectsApi, 'starterArchive').mockResolvedValue({ blob, withheld: null });
    await act(async () => root.render(<StartHere />));
    await act(async () => byId('guide-starter-starter')!.click());
    await waitUntil(() => m.save.mock.calls.length > 0, 'the archive saved');
    expect(spy).toHaveBeenCalledWith('starter');
    // Saved under the API's Content-Disposition name.
    expect(m.save).toHaveBeenCalledWith(blob, 'learnsdlc-starter.zip');
    expect(byId('guide-starter-warning')?.textContent).toContain('hidden tests');
  });

  it('the sidebar draws "Teacher guide" for staff and not for a learner', async () => {
    await act(async () => root.render(<ShellProvider><Sidebar /></ShellProvider>));
    expect(byId('nav-guide')?.getAttribute('href')).toBe('/teacher/guide');
    m.role = 'LEARNER';
    await act(async () => root.render(<ShellProvider><Sidebar key="learner" /></ShellProvider>));
    expect(byId('nav-guide')).toBeNull();
  });
});

async function uploadWith(answer: () => Promise<unknown>) {
  vi.spyOn(projectsApi, 'runtimeProfile').mockResolvedValue(null as never);
  vi.spyOn(projectsApi, 'upload').mockImplementation(answer as never);
  await act(async () => root.render(<UploadProject onClose={m.close} onUploaded={m.uploaded} />));
  const title = byId('projects-upload-title') as HTMLInputElement;
  await act(async () => {
    typeInto(title, 'Books on a shelf');
  });
  const file = byId('projects-upload-file') as HTMLInputElement;
  await act(async () => {
    Object.defineProperty(file, 'files', { configurable: true, value: [new File([new Uint8Array([80, 75, 5, 6])], 'p.zip')] });
    file.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => byId('projects-upload-submit')!.click());
  // The form answers by opening the draft, listing the changes it made, or showing the refusal.
  await waitUntil(
    () => m.push.mock.calls.length > 0 || byId('projects-upload-warnings') || byId('projects-upload-refusal'),
    'the upload answer',
  );
}

const ACCEPTED = { projectId: 'p1', versionId: 'v1', slug: 'books', version: '0.1.0', compile: { phases: 6, tasks: 6, files: 9, sandboxBudget: 4 }, validation: {} };

describe("what the upload changed, on the upload success panel", () => {
  const CONVERTED = 'Requirements converted from markdown: 3 provided stories, learner story US-4, default floor; 1 rule targets dropped';

  it('lists each warning under the fixed sentence, and opens the draft on request', async () => {
    await uploadWith(async () => ({ ...ACCEPTED, warnings: [CONVERTED, 'A second change.'] }));
    expect(byId('projects-upload-warnings')?.textContent).toContain(UPLOAD_WARNINGS_SENTENCE);
    expect(byId('projects-upload-warning-0')?.textContent).toBe(CONVERTED);
    expect(byId('projects-upload-warning-1')?.textContent).toBe('A second change.');
    expect(byId('projects-upload-open-draft')?.getAttribute('href')).toBe('/teacher/projects/p1/versions/v1');
    expect(m.push).not.toHaveBeenCalled();
  });

  it('the accepted upload closes the form, so a second click cannot make a second project', async () => {
    await uploadWith(async () => ({ ...ACCEPTED, warnings: [CONVERTED] }));
    expect(byId('projects-upload-submit')).toBeNull();
    expect(byId('projects-upload-title')).toBeNull();
    expect(byId('projects-upload-file')).toBeNull();
    // The library is told once, so "Your projects" shows the new draft without a reload.
    expect(m.uploaded).toHaveBeenCalledTimes(1);
    await act(async () => byId('projects-upload-done')!.click());
    expect(m.close).toHaveBeenCalledTimes(1);
  });

  it('says nothing and opens the draft when the upload changed nothing', async () => {
    await uploadWith(async () => ACCEPTED);
    expect(byId('projects-upload-warnings')).toBeNull();
    expect(m.push).toHaveBeenCalledWith('/teacher/projects/p1/versions/v1');
  });

  it('an empty warnings list is nothing to say either', async () => {
    await uploadWith(async () => ({ ...ACCEPTED, warnings: [] }));
    expect(byId('projects-upload-warnings')).toBeNull();
    expect(m.push).toHaveBeenCalledWith('/teacher/projects/p1/versions/v1');
  });
});

describe('the explainer under a refusal', () => {
  it('a coded refusal: the fixed sentence alone in its block, the help beneath it', async () => {
    await uploadWith(async () => {
      throw new ApiError(422, 'x', undefined, { code: 'SECRET_FILE', sentence: UPLOAD_REFUSALS.SECRET_FILE, findings: [] });
    });
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.SECRET_FILE);
    expect(byId('upload-refusal-help-title')?.textContent).toBe(UPLOAD_REFUSAL_HELP.SECRET_FILE.title);
  });

  it('a 429 keeps its pace sentence and gets the fallback, which never blames the archive', async () => {
    await uploadWith(async () => {
      throw new ApiError(429, 'slow down');
    });
    expect(byId('upload-refusal-help-title')?.textContent).toBe('What to try next');
    expect(byId('upload-refusal-help-fix')?.textContent).not.toMatch(/archive (is|was) (wrong|invalid|not)/i);
  });
});

describe('the rail follows the deep-validation panel it sits above', () => {
  it('DeepValidationPanel hands every view it reads to onView, including a run polled to its end', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const base = { versionId: 'v1', current: true, contentDigest: 'd', checks: [], costWarning: { microVMs: 2, sentence: '2 microVMs' }, startedAt: null, finishedAt: null };
      const running = { ...base, status: 'running' } as never;
      const passed = { ...base, status: 'passed' } as never;
      const read = vi.spyOn(projectsApi, 'deepValidation').mockResolvedValueOnce(running).mockResolvedValue(passed);
      const seen = vi.fn();
      const { DeepValidationPanel, DEEP_VALIDATION_POLL_MS } = await import('@/components/staff/projects/DeepValidationPanel');
      await act(async () => root.render(<DeepValidationPanel projectId="p1" versionId="v1" editable={false} onView={seen} />));
      await waitUntil(() => seen.mock.lastCall?.[0] === running, 'the first view');
      expect(seen).toHaveBeenLastCalledWith(running);
      await act(async () => {
        vi.advanceTimersByTime(DEEP_VALIDATION_POLL_MS + 10);
      });
      await waitUntil(() => seen.mock.lastCall?.[0] === passed, 'the polled view');
      expect(seen).toHaveBeenLastCalledWith(passed);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the editor reads deep validation through the panel only, and gives Publish a box to scroll to', async () => {
    // The editor's own text, and the text of everything it draws, wherever it is split to.
    const own = moduleText('ProjectEditor');
    const drawn = closureText('ProjectEditor');
    expect(own.match(/projectsApi\.deepValidation\(/g) ?? []).toHaveLength(0);
    expect(drawn).toContain('onView={setGuideDeep}');
    expect(own).not.toMatch(/id="guide-publish" className="contents"/);
    // The rail is the project owner's: not drawn on a platform-owned or library version.
    expect(drawn).toMatch(/\{ownsDeep && <GuideRail /);
  });
});
