// @vitest-environment jsdom
/**
 * A starter download that fails says its own sentence. `archiveBlob` is the
 * export's fetch, reused by the starter downloads, so a refusal with no
 * message must not read "The export could not be made (<status>)." on the
 * Projects page, where no export was asked for.
 *
 * The export's own sentences stay byte-identical (export-button pins the
 * not-an-archive and stopped sentences; this file pins the failed one too).
 */
import { act, type ReactNode } from 'react';
import { waitUntil } from './support/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const saveBlob = vi.fn();
vi.mock('@/lib/download', () => ({ saveBlob: (...args: unknown[]) => saveBlob(...args) }));

type ProjectsModule = typeof import('@/lib/api-projects');

/** What `fetch` gives back, without a real Response. */
const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError('not JSON')) : Promise.resolve(body)),
    blob: () => Promise.resolve(new Blob([typeof body === 'string' ? body : JSON.stringify(body)])),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  }) as unknown as Response;

/** A 200 application/zip whose body is empty. */
const emptyZip = (): Response =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError('not JSON')),
    blob: () => Promise.resolve(new Blob([])),
    headers: { get: (name: string) => ({ 'content-type': 'application/zip' } as Record<string, string>)[name.toLowerCase()] ?? null },
  }) as unknown as Response;

const fetchMock = vi.fn();
let projects: ProjectsModule['projectsApi'];

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock.mockReset();
  saveBlob.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  projects = (await vi.importActual<ProjectsModule>('@/lib/api-projects')).projectsApi;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const said = (work: Promise<unknown>) => work.then(() => 'saved', (err: Error) => err.message);

describe('a failed starter download says its own sentence', () => {
  it.each([404, 500, 503])('the starter: a %i with no message names the starter archive, never the export', async (status) => {
    fetchMock.mockResolvedValueOnce(answer(status, {}));
    const message = await said(projects.starterArchive('starter'));
    expect(message).toBe(`The starter archive could not be downloaded (${status}).`);
    expect(message).not.toMatch(/export/i);
  });

  it('the shelf example: a 404 with no message names the shelf example', async () => {
    fetchMock.mockResolvedValueOnce(answer(404, 'not json'));
    expect(await said(projects.starterArchive('shelf'))).toBe('The shelf example could not be downloaded (404).');
  });

  it('a 200 that is not a zip is a download that saved nothing, not an export', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { message: 'ok' }, { 'content-type': 'application/json' }));
    const message = await said(projects.starterArchive('starter'));
    expect(message).toBe('The download came back as something other than an archive, so nothing was saved. Try again in a moment.');
  });

  // An empty 200 zip is a download that saved nothing too,
  // never the export's sentence (the empty-body branch of archiveBlob).
  it.each(['starter', 'shelf'] as const)('the %s: a 200 zip with an empty body is a download that saved nothing, not an export', async (name) => {
    fetchMock.mockResolvedValueOnce(emptyZip());
    const message = await said(projects.starterArchive(name));
    expect(message).toBe('The download came back as something other than an archive, so nothing was saved. Try again in a moment.');
    expect(message).not.toMatch(/export/i);
  });

  it("the API's own refusal is still said in its words", async () => {
    fetchMock.mockResolvedValueOnce(answer(403, { statusCode: 403, message: 'Only staff can download the starter.' }));
    expect(await said(projects.starterArchive('starter'))).toBe('Only staff can download the starter.');
  });
});

describe("the export's sentences are unchanged", () => {
  it('a failed export with no message still reads "The export could not be made (<status>)."', async () => {
    fetchMock.mockResolvedValueOnce(answer(500, {}));
    expect(await said(projects.exportVersion('p-1', 'v-1'))).toBe('The export could not be made (500).');
  });

  it('a 200 export that is not a zip still reads the export\'s sentence', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { message: 'ok' }, { 'content-type': 'application/json' }));
    expect(await said(projects.exportVersion('p-1', 'v-1'))).toBe(
      'The export came back as something other than an archive, so nothing was saved. Try again in a moment.',
    );
  });

  it("a 200 export zip with an empty body still reads the export's sentence", async () => {
    fetchMock.mockResolvedValueOnce(emptyZip());
    expect(await said(projects.exportVersion('p-1', 'v-1'))).toBe(
      'The export came back as something other than an archive, so nothing was saved. Try again in a moment.',
    );
  });
});

describe('Start here shows the starter sentence', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('a failed download of the starter shows its own sentence and saves nothing', async () => {
    fetchMock.mockResolvedValue(answer(404, {}));
    const { StartHere } = await import('@/components/staff/guide/StartHere');
    await act(async () => root.render(<StartHere />));
    await act(async () => (host.querySelector('[data-testid="guide-starter-starter"]') as HTMLElement).click());
    await waitUntil(() => host.querySelector('[data-testid="guide-starter-error"]'), 'the download error');
    expect(host.querySelector('[data-testid="guide-starter-error"]')?.textContent).toBe('The starter archive could not be downloaded (404).');
    expect(saveBlob).not.toHaveBeenCalled();
  });
});
