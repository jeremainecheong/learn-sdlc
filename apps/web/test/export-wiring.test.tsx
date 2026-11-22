// @vitest-environment jsdom
/**
 * The mounted Export button against what the API answered
 * in `apps/api/test/export-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/export.json`).
 *
 * The real `ExportButton` and the real `projectsApi.exportVersion` (its own
 * `fetch`, headers and refusal rules); `fetch` itself is mocked to answer each
 * request with the recorded exchange for its method and path, so no port is
 * bound. Only the browser's save (`saveBlob`) is stood in for, because jsdom
 * has no download.
 *
 * - The archive is saved, and nothing of it is drawn. The page names the file
 *   itself, from its props (`exportFilename(slug, version)`); it does not read
 *   `Content-Disposition`. What is proved is that the page's rule and the API's
 *   `Content-Disposition` name agree for the recorded export, and (a case of
 *   its own) that a different header does not change the page's name.
 * - A copy's export says how many inherited sealed files the API left out:
 *   the count from `x-export-withheld`.
 * - A 409 export refusal (the read-back's `taskDrift`) and a stranger's 404 show the API's sentence verbatim.
 *
 * Vacuity: the same copy answer with its `x-export-withheld` header taken away
 * draws neither the count nor the "holds your sealed tests" claim, so the
 * count on the page is the header's and nothing else's. A missing header is
 * an unread count, said by a fixed sentence, and the file is still saved.
 */
import { act, type ReactElement } from 'react';
import { waitUntil } from './support/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';

const saveBlob = vi.fn();
vi.mock('@/lib/download', () => ({ saveBlob: (...args: unknown[]) => saveBlob(...args) }));

const recording = readExchangeRecording('export');
const facts = recording.facts as Record<string, string>;
const exchange = (name: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name}`);
  return found;
};

/** The recorded answers by method and path; `override` swaps one exchange's answer for a test. */
let answers = new Map<string, Exchange>();
const seen: { method: string; path: string; authorization: string | null }[] = [];
const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
  const url = new URL(String(input));
  const path = decodeURIComponent(url.pathname).replace(/^\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  seen.push({ method, path, authorization: init?.headers?.authorization ?? null });
  const found = answers.get(`${method} ${path}`);
  if (!found) return new Response(JSON.stringify({ statusCode: 404, message: 'Not recorded.' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const body = found.body as { contentType?: string; text?: string };
  const text = typeof body?.contentType === 'string' && typeof body.text === 'string' ? body.text : JSON.stringify(found.body);
  return new Response(text, { status: found.status, headers: { ...(found.headers ?? {}) } });
});

let ExportButton: (props: { projectId: string; versionId: string; slug: string; version: string }) => ReactElement;
let exportFilename: (slug: string, version: string) => string;
let host: HTMLDivElement;
let root: Root;

const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const until = (what: () => unknown, label: string, tries = 150) =>
  waitUntil(what, label, { tries: tries, tick: 10 });
const filenameOf = (one: Exchange) => /filename="([^"]+)"/.exec(one.headers?.['content-disposition'] ?? '')?.[1] ?? null;

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  const mod = await import('@/components/staff/projects/ExportButton');
  ExportButton = mod.ExportButton as never;
  exportFilename = mod.exportFilename;
});

beforeEach(() => {
  answers = new Map(recording.exchanges.filter((one) => one.name !== 'refusedNotOwner' && one.name !== 'refusedLearner').map((one) => [`${one.method} ${one.path}`, one]));
  seen.length = 0;
  saveBlob.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const press = async (props: { projectId: string; versionId: string; slug: string; version: string }) => {
  await act(async () => {
    root.render(<ExportButton {...props} />);
  });
  await act(async () => {
    byId('project-export')?.click();
  });
};

describe('Export, wired to the recorded API', () => {
  it("saves the archive under the page's name, which is the name the API's Content-Disposition gives it, and draws none of it", async () => {
    const exported = exchange('exported');
    await press({ projectId: facts.projectId, versionId: facts.versionId, slug: facts.slug, version: facts.version });
    await until(() => byId('project-export-done'), 'the saved sentence');
    expect(seen).toEqual([{ method: 'GET', path: exported.path, authorization: 'Bearer replay-session' }]);
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0] as [Blob, string];
    // the page's own name for the file (from its props) agrees with the API's Content-Disposition name
    expect(name).toBe(filenameOf(exported));
    expect(exportFilename(facts.slug, facts.version)).toBe(filenameOf(exported));
    // the bytes handed to the save are the answer's (jsdom's Blob reads no text: its size says it)
    expect(blob.size).toBe('<archive>'.length);
    expect(byId('project-export-done')?.textContent).toContain('It holds your sealed tests and solution');
    expect(host.innerHTML).not.toContain('<archive>');
    expect(host.innerHTML).not.toContain('&lt;archive&gt;');
    expect(byId('project-export-error')).toBeNull();
  });

  it("a copy's export says how many inherited sealed files the API left out (x-export-withheld)", async () => {
    const copy = exchange('exportedCopy');
    const withheld = Number(copy.headers?.['x-export-withheld']);
    expect(withheld).toBeGreaterThan(0);
    await press({ projectId: facts.copyProjectId, versionId: facts.copyVersionId, slug: facts.copySlug, version: facts.version });
    await until(() => byId('project-export-done'), 'the saved sentence');
    expect(saveBlob.mock.calls[0]?.[1]).toBe(filenameOf(copy));
    expect(byId('project-export-done')?.textContent).toContain(`${withheld} sealed files you did not write`);
    expect(byId('project-export-done')?.textContent).not.toContain('It holds your sealed tests and solution');
  });

  it("a 409 export refusal (the read-back's taskDrift) shows the API's sentence verbatim, and nothing is saved", async () => {
    const refused = exchange('refusedTaskEdited');
    expect(refused.status).toBe(409);
    await press({ projectId: facts.editedProjectId, versionId: facts.editedVersionId, slug: facts.editedSlug, version: facts.version });
    await until(() => byId('project-export-error'), 'the refusal');
    expect(byId('project-export-error')?.textContent).toBe((refused.body as { message: string }).message);
    expect(saveBlob).not.toHaveBeenCalled();
    expect(byId('project-export-done')).toBeNull();
  });

  it("another teacher's 404 shows the API's sentence verbatim", async () => {
    const theirs = exchange('refusedNotOwner');
    answers.set(`${theirs.method} ${theirs.path}`, theirs);
    await press({ projectId: facts.projectId, versionId: facts.versionId, slug: facts.slug, version: facts.version });
    await until(() => byId('project-export-error'), 'the refusal');
    expect(byId('project-export-error')?.textContent).toBe((theirs.body as { message: string }).message);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("the page names the file by its own rule, not by the header: a different Content-Disposition leaves the name as it was", async () => {
    const exported = exchange('exported');
    answers.set(`${exported.method} ${exported.path}`, { ...exported, headers: { ...(exported.headers ?? {}), 'content-disposition': 'attachment; filename="not-the-page-name.zip"' } });
    await press({ projectId: facts.projectId, versionId: facts.versionId, slug: facts.slug, version: facts.version });
    await until(() => byId('project-export-done'), 'the saved sentence');
    expect(saveBlob.mock.calls[0]?.[1]).toBe(exportFilename(facts.slug, facts.version));
    expect(saveBlob.mock.calls[0]?.[1]).not.toBe('not-the-page-name.zip');
  });

  // A missing header is never read as 0, so the page must not claim 'It holds
  // your sealed tests and solution': the file is saved and a fixed sentence
  // says to open it.
  it('vacuity: the copy answer without its x-export-withheld header draws neither the count nor the claim that the archive holds every sealed file', async () => {
    const copy = exchange('exportedCopy');
    const { 'x-export-withheld': _dropped, ...headers } = copy.headers ?? {};
    answers.set(`${copy.method} ${copy.path}`, { ...copy, headers });
    await press({ projectId: facts.copyProjectId, versionId: facts.copyVersionId, slug: facts.copySlug, version: facts.version });
    await until(() => byId('project-export-done'), 'the saved sentence');
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(byId('project-export-done')?.textContent).toBe(
      `Saved ${filenameOf(copy)}. The page could not read how many sealed files were left out, so open the archive before you share it.`,
    );
    expect(byId('project-export-done')?.textContent).not.toContain('It holds your sealed tests and solution');
    expect(byId('project-export-done')?.textContent).not.toContain('sealed files you did not write');
  });
});
