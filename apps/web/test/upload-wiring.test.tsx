// @vitest-environment jsdom
/**
 * The upload door against what the API answered in
 * `apps/api/test/upload-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/upload.json`), and the configured cap
 * from `runtime-profile.json`.
 *
 * The real `UploadProject`, the real `projectsApi` and the real `fetch`,
 * pointed at a tiny HTTP server on `127.0.0.1:0` that replays the recording
 * (`contract-exchanges/replay.ts`). Only the router is stood in for. The archive the
 * page is handed is the one the API was sent, rebuilt from the same fixture
 * pack (`contract-exchanges/archives.ts`), so the body the page sends can be
 * compared byte for byte with the one the API answered.
 *
 * - The cap the page states is the API's (`RuntimeProfileView.uploadMaxBytes`),
 *   not its own default.
 * - An invalid fixture archive is refused by the contract's sentence, each
 *   finding by its own.
 * - `NOT_A_PACK` shows the fixed sentence and the API's `detail` beneath it,
 *   as plain text.
 * - The Shelf fixture is accepted and the draft opens at the editor's address.
 * - The page sends `{ title, archiveBase64 }` with exactly the archive's bytes;
 *   nothing of the archive and nothing sealed is drawn.
 *
 * The last case is the vacuity proof: the API's default cap, and a
 * NOT_A_PACK answer without its `detail`, draw neither.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectUploadRefusal, ProjectUploadRequest, ProjectUploadResult, RuntimeProfileView } from '@learnsdlc/shared';
import { RUN_SHAPE_REFUSALS, UPLOAD_REFUSALS } from '@learnsdlc/shared';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';
import { startReplay, type Replay } from './support/contract-fixtures';
import { loadUploadArchives } from './support/contract-fixtures';
import { loadShelfMarkers } from './support/contract-fixtures';
import { typeInto, waitUntil } from './support/dom';

// The API's fixtures, loaded at run time (test/support/api-fixtures.ts says why).
const CONTRACT_UPLOAD_ARCHIVES = await loadUploadArchives();
const ALL_SHELF_MARKERS = await loadShelfMarkers();

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));

const recording = readExchangeRecording('upload');
const profiles = readExchangeRecording('runtime-profile');
const exchange = (name: string, from = recording): Exchange => {
  const found = from.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name}`);
  return found;
};
const PROFILE = exchange('profile');
const SMALL = exchange('profileSmallCap', profiles);
const UPLOAD_PATH = exchange('accepted').path;

let replay: Replay;
let UploadProject: (props: { onClose: () => void }) => ReactElement;
let formatBytes: (n: number) => string;
let host: HTMLDivElement;
let root: Root;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const until = (what: () => unknown, label: string, tries = 150) =>
  waitUntil(what, label, { tries: tries, tick: 10, detail: () => `misses: ${replay.misses.join(', ') || 'none'}` });
const uploads = () => replay.seen.filter((one) => one.method === 'POST' && one.path === UPLOAD_PATH);
const archiveNameOf = (one: Exchange) => String((one.requestBody as { archiveBase64: string }).archiveBase64).replace(/^<archive:(.*)>$/, '$1');

beforeAll(async () => {
  replay = await startReplay(recording.exchanges);
  process.env.NEXT_PUBLIC_API_URL = replay.url;
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  UploadProject = (await import('@/components/staff/projects/UploadProject')).UploadProject as never;
  formatBytes = (await import('@/components/staff/projects/upload-bytes')).formatBytes;
});
afterAll(async () => {
  await replay?.close();
  delete process.env.NEXT_PUBLIC_API_URL;
});

beforeEach(() => {
  router.push.mockClear();
  replay.seen.length = 0;
  replay.misses.length = 0;
  replay.answer('GET', PROFILE.path, [PROFILE]);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const open = async () => {
  await act(async () => root.render(<UploadProject onClose={() => undefined} />));
  const reading = byId('projects-upload-profile')?.textContent;
  await until(() => replay.seen.some((one) => one.path === PROFILE.path), 'the profile read');
  // The line says it is reading until the answer lands, then draws the profile.
  await until(() => byId('projects-upload-profile')?.textContent !== reading, 'the profile line');
};

/** Type the title and choose the archive the recorded exchange was made with, then send. */
async function send(recorded: Exchange): Promise<{ sent: ProjectUploadRequest; bytes: Buffer }> {
  const body = recorded.requestBody as ProjectUploadRequest;
  const bytes = CONTRACT_UPLOAD_ARCHIVES[archiveNameOf(recorded)]();
  replay.answer('POST', UPLOAD_PATH, [{ status: recorded.status, body: recorded.body }]);
  const title = byId<HTMLInputElement>('projects-upload-title')!;
  await act(async () => {
    typeInto(title, body.title);
  });
  const picker = byId<HTMLInputElement>('projects-upload-file')!;
  const file = new File([new Uint8Array(bytes)], 'archive.zip', { type: 'application/zip' });
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const before = uploads().length;
  await act(async () => byId<HTMLButtonElement>('projects-upload-submit')!.click());
  await until(() => uploads().length > before, 'the upload request');
  return { sent: uploads()[uploads().length - 1].body as ProjectUploadRequest, bytes };
}

/** The page sent the API's accepted shape, the recorded title, and exactly the archive's bytes. */
function expectSentAsRecorded(sent: ProjectUploadRequest, recorded: Exchange, bytes: Buffer) {
  const body = recorded.requestBody as ProjectUploadRequest;
  expect(Object.keys(sent).sort()).toEqual(Object.keys(body).sort());
  expect(sent.title).toBe(body.title);
  expect(Buffer.from(sent.archiveBase64, 'base64').equals(bytes)).toBe(true);
  expect((recording.facts.archiveBytes as Record<string, number>)[archiveNameOf(recorded)]).toBe(bytes.length);
}

/** Nothing of the archive and nothing sealed on the page. */
function expectNothingDrawn(bytes: Buffer) {
  const page = host.innerHTML;
  expect(ALL_SHELF_MARKERS.filter((marker) => page.includes(marker))).toEqual([]);
  expect(page).not.toContain(bytes.toString('base64').slice(0, 64));
}

describe('the upload door, from the API recording', () => {
  it('states the API’s archive cap, not its own default', async () => {
    replay.answer('GET', PROFILE.path, [SMALL]);
    await open();
    const cap = (SMALL.body as RuntimeProfileView).uploadMaxBytes!;
    await until(() => byId('projects-upload-size')?.textContent?.includes(formatBytes(cap)), `the size line to state ${formatBytes(cap)}`);
    expect(byId('projects-upload-size')!.textContent).not.toContain(formatBytes((PROFILE.body as RuntimeProfileView).uploadMaxBytes!));
  });

  it('a FIX-2 run-shape archive is refused by the contract’s sentence, each finding by its own', async () => {
    const recorded = exchange('refusedRunShape');
    await open();
    const { sent, bytes } = await send(recorded);
    expectSentAsRecorded(sent, recorded, bytes);
    await until(() => byId('projects-upload-refusal-sentence'), 'the refusal');
    const refusal = recorded.body as ProjectUploadRefusal;
    expect(byId('projects-upload-refusal-sentence')!.textContent).toBe(UPLOAD_REFUSALS[refusal.code]);
    expect(refusal.findings.length).toBeGreaterThan(0);
    refusal.findings.forEach((finding, at) => {
      expect(byId(`projects-upload-finding-${at}`)!.textContent).toContain(RUN_SHAPE_REFUSALS[finding.code]);
    });
    expect(router.push).not.toHaveBeenCalled();
    expectNothingDrawn(bytes);
  });

  it('a FIX-2 hostile archive is refused by its code’s sentence', async () => {
    const recorded = exchange('refusedPathClimb');
    await open();
    const { sent, bytes } = await send(recorded);
    expectSentAsRecorded(sent, recorded, bytes);
    await until(() => byId('projects-upload-refusal-sentence'), 'the refusal');
    expect(byId('projects-upload-refusal-sentence')!.textContent).toBe(UPLOAD_REFUSALS.PATH_CLIMB);
    expectNothingDrawn(bytes);
  });

  it('a FIX-2 archive asking for a library the deployment does not bake is refused by the contract’s sentence', async () => {
    const recorded = exchange('refusedRuntime');
    const refusal = recorded.body as ProjectUploadRefusal;
    expect(refusal.code).toBe('RUNTIME_OUTSIDE_PROFILE');
    await open();
    const { sent, bytes } = await send(recorded);
    expectSentAsRecorded(sent, recorded, bytes);
    await until(() => byId('projects-upload-refusal-sentence'), 'the refusal');
    expect(byId('projects-upload-refusal-sentence')!.textContent).toBe(UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE);
    expect(router.push).not.toHaveBeenCalled();
    expectNothingDrawn(bytes);
  });

  it('NOT_A_PACK shows the fixed sentence and the API’s detail beneath it, as plain text', async () => {
    const recorded = exchange('refusedNotAPack');
    const refusal = recorded.body as ProjectUploadRefusal;
    expect(refusal.code).toBe('NOT_A_PACK');
    expect(typeof refusal.detail).toBe('string');
    await open();
    const { sent, bytes } = await send(recorded);
    expectSentAsRecorded(sent, recorded, bytes);
    await until(() => byId('projects-upload-refusal-sentence'), 'the refusal');
    expect(byId('projects-upload-refusal-sentence')!.textContent).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
    const box = byId('projects-upload-refusal')!;
    await until(() => box.textContent?.includes(refusal.detail!), 'the detail under the sentence');
    // Plain text: one text node carries it, and nothing in the box was made from it.
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let carrier: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).data.includes(refusal.detail!)) carrier = node as Text;
    }
    expect(carrier).not.toBeNull();
    expect(box.querySelectorAll('a, script, img, iframe')).toHaveLength(0);
    expectNothingDrawn(bytes);
  });

  it('FIX-1 is accepted, and the draft opens at the editor’s address', async () => {
    const recorded = exchange('accepted');
    expect(recorded.status).toBe(201);
    await open();
    const { sent, bytes } = await send(recorded);
    expectSentAsRecorded(sent, recorded, bytes);
    const made = recorded.body as ProjectUploadResult & { warnings?: string[] };
    const href = `/teacher/projects/${encodeURIComponent(made.projectId)}/versions/${encodeURIComponent(made.versionId)}`;
    // FIX-1 is in the folder layout with every brief plain (TaskTrackr 6.0.0's move): the door changes nothing and
    // says nothing, so the recording holds no warnings and the editor opens at once
    expect(made.warnings).toBeUndefined();
    await until(() => router.push.mock.calls.length > 0, 'the editor to open');
    expect(router.push).toHaveBeenCalledWith(href);
    expect(byId('projects-upload-warnings')).toBeNull();
    expect(byId('projects-upload-refusal')).toBeNull();
    expect(uploads()[0].authorization).toBe('Bearer replay-session');
    expectNothingDrawn(bytes);
    expect(replay.misses).toEqual([]);
  });
  it('vacuity: the API’s default cap and a NOT_A_PACK answer without its detail draw neither the small cap nor a detail', async () => {
    // The default-cap profile: the size line cannot hold the small cap.
    await open();
    const small = (SMALL.body as RuntimeProfileView).uploadMaxBytes!;
    await until(() => byId('projects-upload-size')?.textContent?.includes(formatBytes((PROFILE.body as RuntimeProfileView).uploadMaxBytes!)), 'the default cap');
    expect(byId('projects-upload-size')!.textContent).not.toContain(formatBytes(small));
    // The refusal without `detail`: the box has the sentence and nothing under it.
    const recorded = exchange('refusedNotAPack');
    const { detail: _dropped, ...rest } = recorded.body as ProjectUploadRefusal;
    const broken = { ...recorded, body: rest };
    replay.answer('POST', UPLOAD_PATH, [broken]);
    await send(broken);
    await until(() => byId('projects-upload-refusal-sentence'), 'the refusal');
    expect(byId('projects-upload-refusal')!.textContent).not.toContain((recorded.body as ProjectUploadRefusal).detail!);
  });
});
