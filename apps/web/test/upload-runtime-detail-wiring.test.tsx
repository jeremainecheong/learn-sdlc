// @vitest-environment jsdom
/**
 * A runtime outside the baked profile names the package on the upload page.
 *
 * The API answers `RUNTIME_OUTSIDE_PROFILE` with `detail`, the sentence
 * that names the first package the profile does not bake
 * (apps/api/src/authoring/upload.service.ts `uploadRefused`). The page draws it
 * under the fixed sentence exactly as it draws `NOT_A_PACK`'s detail: plain
 * text, one text node, cut to `UPLOAD_REFUSAL_DETAIL_MAX`. Every other code's
 * detail is dropped.
 *
 * The second describe replays the recorded answer
 * (apps/api/test/fixtures/contract-exchanges/upload.json `refusedRuntime`, recorded
 * by its recorder) from a real HTTP server, through the real
 * `projectsApi` and `fetch`, as upload-wiring.test.tsx does.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectUploadRefusal, ProjectUploadRequest } from '@learnsdlc/shared';
import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_DETAIL_MAX } from '@learnsdlc/shared';
import { readExchangeRecording, startReplay, loadUploadArchives, loadShelfMarkers, type Exchange, type Replay } from './support/contract-fixtures';
import { typeInto, waitUntil } from './support/dom';

const CONTRACT_UPLOAD_ARCHIVES = await loadUploadArchives();
const ALL_SHELF_MARKERS = await loadShelfMarkers();

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));

const recording = readExchangeRecording('upload');
const exchange = (name: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name}`);
  return found;
};
const PROFILE = exchange('profile');
const UPLOAD_PATH = exchange('accepted').path;
const RUNTIME_DETAIL =
  'project.runtime asks for requests, which is outside the runtime this deployment bakes. Use only the packages the runtime profile lists, and upload again.';

let replay: Replay;
let UploadProject: (props: { onClose: () => void }) => ReactElement;
let uploadRefusalDetail: (code: unknown, detail: unknown) => string | undefined;
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
  const page = await import('@/components/staff/projects/UploadProject');
  UploadProject = page.UploadProject as never;
  uploadRefusalDetail = page.uploadRefusalDetail;
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

/** Type the recorded title, choose the recorded archive and send; the replay answers `answer`. */
async function send(recorded: Exchange, answer: { status: number; body: unknown }): Promise<Buffer> {
  const body = recorded.requestBody as ProjectUploadRequest;
  const bytes = CONTRACT_UPLOAD_ARCHIVES[archiveNameOf(recorded)]();
  replay.answer('POST', UPLOAD_PATH, [answer]);
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
  await until(() => byId('projects-upload-refusal-sentence'), 'the refusal');
  return bytes;
}

describe('uploadRefusalDetail keeps RUNTIME_OUTSIDE_PROFILE’s detail, as NOT_A_PACK’s', () => {
  it('returns the detail for RUNTIME_OUTSIDE_PROFILE, cut to UPLOAD_REFUSAL_DETAIL_MAX', () => {
    expect(uploadRefusalDetail('RUNTIME_OUTSIDE_PROFILE', RUNTIME_DETAIL)).toBe(RUNTIME_DETAIL);
    expect(uploadRefusalDetail('RUNTIME_OUTSIDE_PROFILE', 'r'.repeat(UPLOAD_REFUSAL_DETAIL_MAX * 2))).toBe('r'.repeat(UPLOAD_REFUSAL_DETAIL_MAX));
    expect(uploadRefusalDetail('RUNTIME_OUTSIDE_PROFILE', '   ')).toBeUndefined();
    expect(uploadRefusalDetail('RUNTIME_OUTSIDE_PROFILE', { text: RUNTIME_DETAIL })).toBeUndefined();
  });

  it('still drops a detail beside every other code', () => {
    expect(uploadRefusalDetail('NOT_A_PACK', 'phase.json is not valid JSON.')).toBe('phase.json is not valid JSON.');
    for (const code of Object.keys(UPLOAD_REFUSALS).filter((one) => one !== 'NOT_A_PACK' && one !== 'RUNTIME_OUTSIDE_PROFILE')) {
      expect([code, uploadRefusalDetail(code, 'something')]).toEqual([code, undefined]);
    }
    expect(uploadRefusalDetail('toString', 'something')).toBeUndefined();
  });
});

describe('from the API recording: the page names the package under the fixed sentence', () => {
  it('the recorded refusedRuntime answer carries the package sentence in detail', () => {
    const refusal = exchange('refusedRuntime').body as ProjectUploadRefusal;
    expect(refusal.code).toBe('RUNTIME_OUTSIDE_PROFILE');
    expect(refusal.sentence).toBe(UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE);
    expect(refusal.detail).toBe(RUNTIME_DETAIL);
  });

  it('draws the sentence, then the detail as one plain text node in the same alert', async () => {
    const recorded = exchange('refusedRuntime');
    await open();
    const bytes = await send(recorded, { status: recorded.status, body: recorded.body });
    expect(byId('projects-upload-refusal-sentence')!.textContent).toBe(UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE);
    const shown = byId('projects-upload-refusal-detail');
    expect(shown?.textContent).toBe(RUNTIME_DETAIL);
    expect(shown?.childNodes.length).toBe(1);
    expect(shown?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    const box = byId('projects-upload-refusal')!;
    expect(box.contains(shown as Node)).toBe(true);
    expect(box.textContent).toBe(`${UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE}${RUNTIME_DETAIL}`);
    expect(box.querySelectorAll('a, script, img, iframe')).toHaveLength(0);
    // Nothing of the archive and nothing sealed is drawn.
    expect(ALL_SHELF_MARKERS.filter((marker) => host.innerHTML.includes(marker))).toEqual([]);
    expect(host.innerHTML).not.toContain(bytes.toString('base64').slice(0, 64));
    expect(router.push).not.toHaveBeenCalled();
  });

  it('vacuity: the same answer without detail draws the sentence alone', async () => {
    const recorded = exchange('refusedRuntime');
    const { detail: _dropped, ...rest } = recorded.body as ProjectUploadRefusal;
    await open();
    await send(recorded, { status: recorded.status, body: rest });
    expect(byId('projects-upload-refusal')!.textContent).toBe(UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE);
    expect(byId('projects-upload-refusal-detail')).toBeNull();
  });
});
