// @vitest-environment jsdom
/**
 * Export, a version back to the on-disk layout.
 *
 * The archive carries the sealed files for the owner, so the page hands the
 * bytes straight to the browser's save and draws none of them. A refusal is
 * the API's sentence.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exportVersion = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  projectsApi: { exportVersion: (...args: unknown[]) => exportVersion(...args) },
}));

const saveBlob = vi.fn();
vi.mock('@/lib/download', () => ({ saveBlob: (...args: unknown[]) => saveBlob(...args) }));

import { ExportButton, exportFilename } from '@/components/staff/projects/ExportButton';
import { ApiError } from '@/lib/api';
import { settle } from './support/dom';

const MARKER = 'EXPORT-BYTES-MARKER-55e1';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;


describe('Export', () => {
  it('saves the archive under the slug and version, and draws none of it', async () => {
    const blob = new Blob([MARKER], { type: 'application/zip' });
    // The caller answers the archive and the withheld count.
    exportVersion.mockResolvedValue({ blob, withheld: 0 });
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="books-on-a-shelf" version="0.1.0" />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
    expect(exportVersion).toHaveBeenCalledWith('p-1', 'v-1');
    expect(saveBlob).toHaveBeenCalledWith(blob, 'books-on-a-shelf-0.1.0.zip');
    expect(host?.innerHTML).not.toContain(MARKER);
    expect(byId('project-export-done')?.textContent).toMatch(/^[A-Z]/);
    expect(byId('project-export-done')?.textContent).toContain('It holds your sealed tests and solution');
  });

  it('says how many inherited sealed files were left out, and does not claim the archive holds them', async () => {
    exportVersion.mockResolvedValue({ blob: new Blob(['PK']), withheld: 3 });
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="copy-of-a-project" version="0.1.0" />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'copy-of-a-project-0.1.0.zip');
    const said = byId('project-export-done')?.textContent ?? '';
    expect(said).toMatch(/^Saved copy-of-a-project-0\.1\.0\.zip\./);
    expect(said).toMatch(/\b3 sealed files\b/);
    expect(said).toMatch(/project you copied/);
    expect(said).not.toContain('It holds your sealed tests and solution');
  });

  it('a copy\'s sentence says what is true of the saved file — export again after writing, no claim it holds files the teacher wrote', async () => {
    exportVersion.mockResolvedValue({ blob: new Blob(['PK']), withheld: 44 });
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="fresh-copy" version="0.1.0" />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
    const said = byId('project-export-done')?.textContent ?? '';
    expect(said).toContain('44 sealed files you did not write');
    // the saved .zip never gains files written after it: the teacher exports again
    expect(said).toMatch(/export again/);
    expect(said).not.toMatch(/before you upload it again/);
    // a fresh copy holds no sealed file the teacher wrote
    expect(said).not.toContain('It holds the sealed files you wrote');
    expect(said).toMatch(/only you can read it\.$/);
  });

  it('one withheld file is said in the singular', async () => {
    exportVersion.mockResolvedValue({ blob: new Blob(['PK']), withheld: 1 });
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="s" version="1.0.0" />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
    expect(byId('project-export-done')?.textContent).toMatch(/\b1 sealed file\b(?! s)/);
  });

  it('a 409 sentence is shown verbatim, and nothing is saved', async () => {
    const sentence =
      "Design's task has been edited in the editor (its title), and the archive layout writes a phase's one task as the phase itself, so the archive would lose that edit. Export keeps every edit or exports nothing: undo the edit in the editor to export this version, or keep working on it in the editor.";
    exportVersion.mockRejectedValue(new ApiError(409, sentence));
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="s" version="1.0.0" />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
    expect(byId('project-export-error')?.textContent).toBe(sentence);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('prints a refusal in the API words', async () => {
    exportVersion.mockRejectedValue(new Error('That project does not exist.'));
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="s" version="1.0.0" />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
    expect(byId('project-export-error')?.textContent).toBe('That project does not exist.');
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('keeps a file name to the characters a file name can carry', () => {
    expect(exportFilename('../My Course!', '1.0.0')).toBe('my-course-1.0.0.zip');
  });

  /* ---- the page says "Saved" only for an archive handed to the browser ---- */

  const pressFor = async (props = { projectId: 'p-1', versionId: 'v-1', slug: 'unread-count', version: '0.1.0' }) => {
    await act(async () => {
      root?.render(<ExportButton {...props} />);
    });
    await act(async () => {
      byId('project-export')?.click();
    });
    await settle(6);
  };

  it('a count the page could not read is never read as 0 — the file is saved, the completeness claim is not made, and a fixed sentence says to open the archive first', async () => {
    const blob = new Blob(['PK']);
    exportVersion.mockResolvedValue({ blob, withheld: null });
    await pressFor();
    expect(saveBlob).toHaveBeenCalledWith(blob, 'unread-count-0.1.0.zip');
    const said = byId('project-export-done')?.textContent ?? '';
    expect(said).toBe(
      'Saved unread-count-0.1.0.zip. The page could not read how many sealed files were left out, so open the archive before you share it.',
    );
    expect(said).not.toContain('It holds your sealed tests and solution');
    expect(byId('project-export-error')).toBeNull();
  });

  it('a hand-off the browser refuses is the refusal sentence, never "Saved", and never the raw error', async () => {
    exportVersion.mockResolvedValue({ blob: new Blob(['PK']), withheld: 0 });
    saveBlob.mockImplementationOnce(() => {
      throw new Error('URL.createObjectURL is not a function');
    });
    await pressFor();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(byId('project-export-done')).toBeNull();
    expect(byId('project-export-error')?.textContent).toBe(
      'The archive could not be handed to your browser to save, so nothing was saved. Try again in a moment.',
    );
  });

  it('a refused export says nothing was saved and shows no saved sentence', async () => {
    exportVersion.mockRejectedValue(new ApiError(0, 'The server did not answer. Try again in a moment.'));
    await pressFor();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(byId('project-export-done')).toBeNull();
    expect(byId('project-export-error')?.textContent).toBe('The server did not answer. Try again in a moment.');
  });

  it('the help text says once that an export never carries a warm-up', async () => {
    await act(async () => {
      root?.render(<ExportButton projectId="p-1" versionId="v-1" slug="s" version="1.0.0" />);
    });
    const help = byId('project-export-help')?.textContent ?? '';
    expect(help).toBe('An export never carries a warm-up, because the upload would refuse one.');
    expect(host?.textContent?.split('warm-up').length).toBe(2);
  });
});

/* ------------- the export caller over the real lib/api ------------- */

describe('the export caller (lib/api-projects)', () => {
  type ProjectsModule = typeof import('@/lib/api-projects');
  type ApiModule = typeof import('@/lib/api');
  let projects: ProjectsModule['projectsApi'];
  let api: ApiModule;
  const fetchMock = vi.fn();
  const realLocation = window.location;

  /** What `fetch` gives back, without a real Response. */
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError('not JSON')) : Promise.resolve(body)),
      blob: () => Promise.resolve(new Blob([typeof body === 'string' ? body : JSON.stringify(body)])),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    }) as unknown as Response;

  beforeEach(async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    api = await vi.importActual<ApiModule>('@/lib/api');
    const session = await vi.importActual<typeof import('@/lib/session')>('@/lib/session');
    projects = (await vi.importActual<ProjectsModule>('@/lib/api-projects')).projectsApi;
    window.localStorage.setItem(session.TOKEN_KEY, 'jwt-export');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  });

  it('answers the archive and the withheld count from x-export-withheld, under the request deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(answer(200, 'PK-zip-bytes', { 'content-type': 'application/zip', 'x-export-withheld': '4' }));
    const out = await projects.exportVersion('p-1', 'v-1');
    expect(out.withheld).toBe(4);
    expect(out.blob).toBeInstanceOf(Blob);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${api.API_URL}/api/v1/instructor/projects/p-1/versions/v-1/export`);
    expect(init.headers.authorization).toBe('Bearer jwt-export');
    expect(timeout).toHaveBeenCalledWith(api.REQUEST_TIMEOUT_MS);
    expect(init.signal).toBeDefined();
  });

  it('(b) a stalled export is given up on with the request timeout sentence, not left spinning', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ status: 0, message: 'The server did not answer. Try again in a moment.' });
  });

  // After a 200 the server HAS answered, so a body read cut off is its own
  // sentence, never "the server did not answer"; and any failure of the body
  // read is that sentence, never a raw error message.
  const STOPPED = 'The archive stopped downloading before it finished, so nothing was saved. Try again on a steadier connection.';
  it('a deadline that lands while the archive is still downloading says the download stopped, not that the server did not answer, and no raw DOMException', async () => {
    const stalled = answer(200, 'PK-zip-bytes', { 'content-type': 'application/zip', 'x-export-withheld': '0' });
    (stalled as unknown as { blob: () => Promise<Blob> }).blob = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    fetchMock.mockResolvedValueOnce(stalled);
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ status: 0, message: STOPPED });
  });

  it.each([
    ['an abort', new DOMException('The user aborted a request.', 'AbortError')],
    ['a network TypeError', new TypeError('network error while reading the body')],
    ['any other error', new Error('RAW-BODY-DETAIL-9f2 stream broke')],
  ])('EXP-3 closer (RR3-WEB-2, RR-EXP3-m4): %s while the archive downloads is the stopped sentence, never the raw message', async (_name, failure) => {
    const broken = answer(200, 'PK-zip-bytes', { 'content-type': 'application/zip', 'x-export-withheld': '0' });
    (broken as unknown as { blob: () => Promise<Blob> }).blob = () => Promise.reject(failure);
    fetchMock.mockResolvedValueOnce(broken);
    const said = await projects.exportVersion('p-1', 'v-1').then(() => 'saved', (err: Error) => err.message);
    expect(said).toBe(STOPPED);
  });

  it('a 200 zip with an empty body is not an archive, and nothing is saved', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, '', { 'content-type': 'application/zip', 'x-export-withheld': '0' }));
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ message: expect.stringMatching(/^The export came back as something other than an archive/) });
  });

  it("(b) a 401 goes through lib/api's own handling: the session is cleared and the browser goes to sign-in", async () => {
    const fake = { pathname: '/teacher/projects/p-1', search: '', href: '' };
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: fake });
    fetchMock.mockResolvedValue(answer(401, { message: 'invalid or expired token' }));
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ status: 401 });
    expect(api.getToken()).toBeNull();
    expect(fake.href).toBe('/login?next=%2Fteacher%2Fprojects%2Fp-1&reason=expired');
  });

  it('(c) a 200 that is not a zip is a refusal, never a saved .zip', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { message: 'ok' }, { 'content-type': 'application/json; charset=utf-8' }));
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ message: expect.stringMatching(/^The export came back as something other than an archive/) });
  });

  it('a missing x-export-withheld is unread (null), never 0', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, 'PK-zip-bytes', { 'content-type': 'application/zip' }));
    const out = await projects.exportVersion('p-1', 'v-1');
    expect(out.blob).toBeInstanceOf(Blob);
    expect(out.withheld).toBeNull();
  });

  it.each(['', 'abc', '-1', '1.5', '1e3', '4 files', '0x4'])('a malformed x-export-withheld (%j) is unread (null), never a number', async (header) => {
    fetchMock.mockResolvedValueOnce(answer(200, 'PK-zip-bytes', { 'content-type': 'application/zip', 'x-export-withheld': header }));
    expect((await projects.exportVersion('p-1', 'v-1')).withheld).toBeNull();
  });

  it("'0' is a count the API sent, and reads as 0", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, 'PK-zip-bytes', { 'content-type': 'application/zip', 'x-export-withheld': '0' }));
    expect((await projects.exportVersion('p-1', 'v-1')).withheld).toBe(0);
  });

  it('a success that is not a 200 (a 206 zip) is a refusal, never a saved .zip', async () => {
    fetchMock.mockResolvedValueOnce(answer(206, 'PK-part', { 'content-type': 'application/zip', 'x-export-withheld': '0' }));
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ message: expect.stringMatching(/^The export came back as something other than an archive/) });
  });

  it('(d) a 409 sentence comes back verbatim', async () => {
    const sentence = "Design's task has been edited in the editor (its title), so the archive would lose that edit.";
    fetchMock.mockResolvedValueOnce(answer(409, { statusCode: 409, message: sentence, error: 'Conflict' }, { 'content-type': 'application/json; charset=utf-8' }));
    await expect(projects.exportVersion('p-1', 'v-1')).rejects.toMatchObject({ status: 409, message: sentence });
  });
});
