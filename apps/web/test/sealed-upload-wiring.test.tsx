// @vitest-environment jsdom
/**
 * The executable editor's seal (sealed files are write-only), against what
 * the API answered in
 * `apps/api/test/sealed-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/sealed.json`).
 *
 * The real `ProjectEditor` (which mounts `ExecutableEditor` and its
 * `SealedUpload`s), the real `projectsApi` and the real `fetch`, pointed at a
 * tiny HTTP server on `127.0.0.1:0` that replays the recording
 * (`contract-exchanges/replay.ts`). Only the router is stood in for. The file the
 * page is handed is the one the API was sent (`contract-exchanges/sealed-files.ts`).
 *
 * The recording's digests are `<sha256:N>` placeholders, which hold no hex,
 * so on them a full digest, a prefix and no digest at all look alike. The
 * replay serves each one as a real-looking 64-hex digest instead
 * (`withSyntheticDigests`), so what the page does with a digest is observable.
 *
 * - The editor opens on the API's draft: each sealed file is drawn as a row of
 *   exactly its path, its size and its full digest (the product's rule,
 *   `SealedFileRows`), and nothing else of the view.
 * - Sealing sends `{ role, runId, path, contentBase64 }` with exactly the
 *   file's bytes: the body the API accepted. The answer is drawn as a path, a
 *   digest and a size, and the draft is read again.
 * - A refused seal is the API's sentence, as plain text.
 * - Nothing sealed is drawn: no fixture marker, none of the bytes just sealed,
 *   and no 64-hex string the API did not answer as a digest.
 * - Editability: the starter files and each run's shape are drawn
 *   with no control, the code task draws no learner suite, and the save echoes
 *   shape and learner files as the draft answered them. The API refused a save
 *   that changed either (recorded), and one naming `owns`.
 *
 * A regression guard for the seal itself. Vacuity proofs: a draft answering
 * the run without its sealed files; a draft answering another digest and a
 * member beyond the three; a draft answering a 64-hex the recording never
 * answered, which makes the nothing-sealed check throw; the second run's
 * answer sealed from the first run's control, which
 * is sent with the first run's id and drawn there; and, for
 * the save, a draft answering another run shape, which the page echoes into a
 * body the API did not accept.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftVersionView, ExecutableTaskView, SealedFileView, SealedFileWriteBody } from '@learnsdlc/shared';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';
import { startReplay, withSyntheticDigests, type Replay } from './support/contract-fixtures';
import { loadSealedFiles } from './support/contract-fixtures';
import { loadShelfMarkers } from './support/contract-fixtures';
import { formatBytes } from '@/components/staff/projects/upload-bytes';
import { stubMatchMedia, waitUntil } from './support/dom';

// The API's fixtures, loaded at run time (test/support/api-fixtures.ts says why).
const { CONTRACT_SEALED_FILES, CONTRACT_SEALED_MARKER } = await loadSealedFiles();
const ALL_SHELF_MARKERS = await loadShelfMarkers();

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const recording = withSyntheticDigests(readExchangeRecording('sealed'));
const exchange = (name: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name} in sealed.json`);
  return found;
};
const PROJECT = recording.facts.projectId as string;
const VERSION = recording.facts.versionId as string;
const RUN = recording.facts.runId as string;
const RUN_TWO = recording.facts.secondRunId as string;
const DRAFT = exchange('draft');
const AFTER = exchange('draftAfterSeal');
const SEAL = exchange('sealHidden');
const REFUSED = exchange('sealRefused');
const execOf = (view: DraftVersionView): ExecutableTaskView =>
  view.phases.find((one) => one.key === 'implementation')!.tasks.find((one) => one.executable)!.executable!;

let replay: Replay;
let ProjectEditor: (props: { projectId: string; versionId: string }) => ReactElement;
let host: HTMLDivElement;
let root: Root;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const until = (what: () => unknown, label: string, tries = 150) =>
  waitUntil(what, label, { tries: tries, tick: 10, detail: () => `misses: ${replay.misses.join(', ') || 'none'}` });
const seals = () => replay.seen.filter((one) => one.method === 'PUT' && one.path === SEAL.path);
const draftReads = () => replay.seen.filter((one) => one.method === 'GET' && one.path === DRAFT.path);
async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => el!.click());
}
async function type(id: string, value: string) {
  const el = byId<HTMLInputElement>(id);
  expect(el, `no field ${id}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeAll(async () => {
  replay = await startReplay(recording.exchanges);
  process.env.NEXT_PUBLIC_API_URL = replay.url;
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  ProjectEditor = (await import('@/components/staff/projects/ProjectEditor')).ProjectEditor as never;
});
afterAll(async () => {
  await replay?.close();
  delete process.env.NEXT_PUBLIC_API_URL;
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  replay.seen.length = 0;
  replay.misses.length = 0;
  replay.answer('GET', DRAFT.path, [DRAFT, AFTER]);
  replay.answer('PUT', SEAL.path, [SEAL]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root.unmount());
  host.remove();
});

/** Open the editor on the recorded draft, at the implementation task's executable editor. */
const openEditor = async () => {
  await act(async () => root.render(<ProjectEditor projectId={PROJECT} versionId={VERSION} />));
  await until(() => byId('project-phase-tab-implementation'), 'the phase tabs');
  await click('project-phase-tab-implementation');
  await until(() => byId('exec-edit-open'), 'the executable editor door');
  await click('exec-edit-open');
  await until(() => byId('exec-editor'), 'the executable editor');
};

/** Choose the recorded file for the first run's hidden suite, name its path, and seal it. */
async function seal(recorded: Exchange, runId = RUN): Promise<SealedFileWriteBody> {
  const body = recorded.requestBody as SealedFileWriteBody;
  const name = String(body.contentBase64).replace(/^<sealed:(.*)>$/, '$1') as keyof typeof CONTRACT_SEALED_FILES;
  const bytes = CONTRACT_SEALED_FILES[name]();
  const group = `hidden-${runId}`;
  const picker = byId<HTMLInputElement>(`sealed-${group}-file`)!;
  expect(picker).not.toBeNull();
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File([new Uint8Array(bytes)], 'chosen.py')] });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await type(`sealed-${group}-path`, body.path);
  const before = seals().length;
  await click(`sealed-${group}-upload`);
  await until(() => seals().length > before, 'the seal request');
  const sent = seals()[seals().length - 1].body as SealedFileWriteBody;
  // The body the API accepted (or refused), field for field, and exactly the file's bytes.
  expect(Object.keys(sent).sort()).toEqual(Object.keys(body).sort());
  expect({ ...sent, contentBase64: '' }).toEqual({ ...body, contentBase64: '' });
  expect(Buffer.from(sent.contentBase64, 'base64').equals(bytes)).toBe(true);
  return sent;
}

/** Every digest the API answered, as the replay serves it (64-hex). */
const ANSWERED_DIGESTS = new Set(JSON.stringify(recording).match(/[0-9a-f]{64}/g) ?? []);

/** A sealed row: its path, the Sealed chip, its size and its full digest. Nothing else of the view. */
const rowText = (view: SealedFileView) => `${view.path}Sealed${formatBytes(view.bytes)}sha256 ${view.sha256}`;
const rowsMatch = (group: string, views: readonly SealedFileView[]) =>
  views.every((view, at) => byId(`sealed-${group}-row-${at}`)?.textContent === rowText(view)) &&
  byId(`sealed-${group}-row-${views.length}`) === null;
function expectRows(group: string, views: readonly SealedFileView[]) {
  views.forEach((view, at) => expect(byId(`sealed-${group}-row-${at}`)?.textContent).toBe(rowText(view)));
  expect(byId(`sealed-${group}-row-${views.length}`)).toBeNull();
}
const runsOf = (recorded: Exchange) => execOf(recorded.body as DraftVersionView).runs;

/** Nothing sealed is drawn. */
function expectNothingSealedDrawn() {
  const page = document.body.innerHTML;
  expect(ALL_SHELF_MARKERS.filter((marker) => page.includes(marker))).toEqual([]);
  expect(page).not.toContain(CONTRACT_SEALED_MARKER); // also covers the second run's `-WEB` marker
  expect(page).not.toContain(CONTRACT_SEALED_FILES['hidden-extra']().toString('base64').slice(0, 40));
  // A full digest is drawn (the product's rule), but only one the API answered as a digest.
  expect((page.match(/[0-9a-f]{64}/gi) ?? []).filter((one) => !ANSWERED_DIGESTS.has(one))).toEqual([]);
}

/** A member the API refuses to change, drawn with no control at all. */
function expectNoControl(id: string) {
  const el = byId(id);
  expect(el, `no ${id}`).not.toBeNull();
  expect(el!.querySelectorAll('input, textarea, select, button, [contenteditable]')).toHaveLength(0);
}

describe('the executable editor’s seal, from the API recording', () => {
  it('opens on the API’s draft and draws each sealed file by path, digest and size only', async () => {
    await openEditor();
    expect(draftReads()[0].authorization).toBe('Bearer replay-session');
    const exec = execOf(DRAFT.body as DraftVersionView);
    expect(exec.runs.find((one) => one.id === RUN)!.hidden.length).toBeGreaterThan(0);
    for (const run of exec.runs) expectRows(`hidden-${run.id}`, run.hidden);
    expectRows('solution', exec.solution);
    // The digests drawn are the API's, in full: the replay served real-looking ones.
    expect(document.body.textContent).toContain(exec.runs[0].hidden[0].sha256);
    expect(exec.runs[0].hidden[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expectNothingSealedDrawn();
    expect(replay.misses).toEqual([]);
  });

  it('vacuity: a draft answering another digest draws a row that is not the recorded one, and a member beyond the three is not drawn', async () => {
    const view = JSON.parse(JSON.stringify(DRAFT.body)) as DraftVersionView;
    const first = execOf(view).runs.find((one) => one.id === RUN)!.hidden[0];
    const recorded = { ...first };
    first.sha256 = 'f'.repeat(64);
    (first as SealedFileView & { content?: string }).content = CONTRACT_SEALED_MARKER;
    replay.answer('GET', DRAFT.path, [{ ...DRAFT, body: view }]);
    await openEditor();
    const row = byId(`sealed-hidden-${RUN}-row-0`)!.textContent;
    expect(row).not.toBe(rowText(recorded));
    expect(row).toBe(rowText(first));
    expect(document.body.innerHTML).not.toContain(CONTRACT_SEALED_MARKER);
  });

  // The in-file proof that the "no 64-hex the API did not answer as a
  // digest" negative can go red.
  it('vacuity: a draft answering a 64-hex digest the recording never answered makes the nothing-sealed check throw', async () => {
    const view = JSON.parse(JSON.stringify(DRAFT.body)) as DraftVersionView;
    const first = execOf(view).runs.find((one) => one.id === RUN)!.hidden[0];
    const unanswered = '0123456789abcdef'.repeat(4);
    expect(ANSWERED_DIGESTS.has(unanswered)).toBe(false);
    first.sha256 = unanswered;
    replay.answer('GET', DRAFT.path, [{ ...DRAFT, body: view }]);
    await openEditor();
    expect(byId(`sealed-hidden-${RUN}-row-0`)!.textContent).toBe(rowText(first));
    expect(() => expectNothingSealedDrawn()).toThrow();
  });

  it('vacuity: a draft whose run the API answered without its sealed files draws none of them', async () => {
    const view = JSON.parse(JSON.stringify(DRAFT.body)) as DraftVersionView;
    const hidden = execOf(view).runs.find((one) => one.id === RUN)!;
    const paths = hidden.hidden.map((one) => one.path);
    hidden.hidden = [];
    replay.answer('GET', DRAFT.path, [{ ...DRAFT, body: view }]);
    await openEditor();
    const rows = byId(`sealed-hidden-${RUN}`)?.textContent ?? '';
    for (const at of paths) expect(rows).not.toContain(at);
  });

  it('sends the seal the API accepted, draws its answer as a digest and a size, and reads the draft again', async () => {
    await openEditor();
    await seal(SEAL);
    await until(() => byId(`sealed-hidden-${RUN}-done`), 'the seal’s answer');
    const answer = SEAL.body as SealedFileView;
    expect(byId(`sealed-hidden-${RUN}-done`)!.textContent).toContain(answer.path);
    await until(() => byId(`sealed-hidden-${RUN}`)?.textContent?.includes(answer.path), 'the sealed row');
    await until(() => draftReads().length >= 2, 'the draft read after the seal');
    // The open editor keeps the rows it opened on and adds the API's answer:
    // the new file by path, size and digest. They are the files the draft
    // the API answered after the seal holds (it sorts them by path).
    const opened = runsOf(DRAFT).find((one) => one.id === RUN)!.hidden;
    expect(opened.some((one) => one.path === answer.path)).toBe(false);
    const drawn = [...opened, answer];
    await until(() => rowsMatch(`hidden-${RUN}`, drawn), 'the rows with the API’s answer');
    expectRows(`hidden-${RUN}`, drawn);
    const byPath = (list: readonly SealedFileView[]) => [...list].sort((a, b) => a.path.localeCompare(b.path));
    expect(byPath(drawn)).toEqual(byPath(runsOf(AFTER).find((one) => one.id === RUN)!.hidden));
    expectNothingSealedDrawn();
  });

  it('a file sealed into the second run is sent with that run’s id, as the API accepted it, and lands in that run', async () => {
    const recorded = exchange('sealHiddenRun2');
    replay.answer('PUT', SEAL.path, [recorded]);
    replay.answer('GET', DRAFT.path, [DRAFT, exchange('draftAfterSealRun2')]);
    await openEditor();
    const sent = await seal(recorded, RUN_TWO);
    expect(sent.runId).toBe(RUN_TWO);
    expect(sent.runId).not.toBe(RUN);
    const answer = recorded.body as SealedFileView;
    await until(() => byId(`sealed-hidden-${RUN_TWO}`)?.textContent?.includes(answer.path), 'the second run’s sealed row');
    expect(byId(`sealed-hidden-${RUN}`)?.textContent ?? '').not.toContain(answer.path);
    // The second run draws the rows it opened on and the API's answer; the first run's are untouched.
    const opened = runsOf(DRAFT);
    const drawnTwo = [...opened.find((one) => one.id === RUN_TWO)!.hidden, answer];
    await until(() => rowsMatch(`hidden-${RUN_TWO}`, drawnTwo), 'the second run’s rows with the API’s answer');
    expectRows(`hidden-${RUN_TWO}`, drawnTwo);
    expectRows(`hidden-${RUN}`, opened.find((one) => one.id === RUN)!.hidden);
    const after = runsOf(exchange('draftAfterSealRun2')).find((one) => one.id === RUN_TWO)!.hidden;
    expect(after.some((one) => one.path === answer.path && one.sha256 === answer.sha256)).toBe(true);
    expect(byId(`sealed-hidden-${RUN}`)?.textContent ?? '').not.toContain(answer.path);
    expect(document.body.innerHTML).not.toContain(CONTRACT_SEALED_FILES['hidden-extra-web']().toString('base64').slice(0, 40));
    expectNothingSealedDrawn();
  });

  it('vacuity: the same answer, sealed from the first run’s control, is sent with that run’s id and drawn in the first run', async () => {
    const recorded = exchange('sealHiddenRun2');
    const answer = recorded.body as SealedFileView;
    const wrongRun = { ...recorded, requestBody: { ...(recorded.requestBody as SealedFileWriteBody), runId: RUN } };
    replay.answer('PUT', SEAL.path, [wrongRun]);
    await openEditor();
    const sent = await seal(wrongRun, RUN);
    expect(sent.runId).not.toBe(RUN_TWO);
    expect(sent).not.toEqual({ ...(recorded.requestBody as SealedFileWriteBody), contentBase64: sent.contentBase64 });
    await until(() => byId(`sealed-hidden-${RUN}`)?.textContent?.includes(answer.path), 'the file in the first run');
    expect(byId(`sealed-hidden-${RUN_TWO}`)?.textContent ?? '').not.toContain(answer.path);
  });

  it('the save sends only what the API accepts ({ runs }, shapes and learner files echoed, never owns or the brief): the body the API accepted', async () => {
    const recorded = exchange('saveExecutable');
    expect(recorded.status).toBe(200);
    // The teacher saves after both seals: the editor opens on the draft the API answered then.
    replay.answer('GET', DRAFT.path, [exchange('draftAfterSealRun2'), exchange('draftAfterSave')]);
    replay.answer('PATCH', recorded.path, [recorded]);
    await openEditor();
    // What the API refuses to change is drawn with no control: the starter
    // files, and each run's shape; a code task draws no learner suite at all.
    const opened = execOf(exchange('draftAfterSealRun2').body as DraftVersionView);
    expect(opened.checkKind).toBe('code');
    expectNoControl('exec-owns');
    for (const one of opened.owns) expect(byId('exec-owns')!.textContent).toContain(one);
    for (const run of opened.runs) {
      expectNoControl(`exec-run-${run.id}-shape`);
      expect(byId(`exec-run-${run.id}-shape`)!.textContent).toContain(run.shape);
      expect(byId(`exec-run-${run.id}-learner`)).toBeNull();
    }
    await type(`exec-run-${RUN}-label`, recording.facts.savedLabel as string);
    await click('exec-save');
    const saves = () => replay.seen.filter((one) => one.method === 'PATCH' && one.path === recorded.path);
    await until(() => saves().length === 1, 'the save');
    const sent = saves()[0].body as { runs: Array<{ id: string; shape: string; learnerTestFiles: string[] }> };
    expect(Object.keys(sent).sort()).toEqual(['runs']);
    expect(sent).toEqual(recorded.requestBody);
    expect(sent).not.toHaveProperty('owns');
    expect(sent).not.toHaveProperty('coverageKeywords');
    // Shape and learner files go back exactly as the draft answered them ...
    for (const run of opened.runs) {
      const echoed = sent.runs.find((one) => one.id === run.id)!;
      expect(echoed.shape).toBe(run.shape);
      expect(echoed.learnerTestFiles).toEqual(run.learnerTestFiles);
    }
    // ... because the API refuses a save that changes either, and one naming `owns`.
    for (const name of ['saveShapeRefused', 'saveLearnerFilesRefused', 'saveOwnsRefused']) {
      const refused = exchange(name);
      expect(refused.status).toBe(400);
      expect(typeof (refused.body as { message?: unknown }).message).toBe('string');
      expect(sent).not.toEqual(refused.requestBody);
    }
    await until(() => !byId('exec-editor'), 'the editor to close on the API’s answer');
    expect(byId('project-task-error')).toBeNull();
    expectNothingSealedDrawn();
  });

  it('vacuity: a draft answering another run shape makes the page send a body the API did not accept', async () => {
    const recorded = exchange('saveExecutable');
    const view = JSON.parse(JSON.stringify(exchange('draftAfterSealRun2').body)) as DraftVersionView;
    const first = execOf(view).runs.find((one) => one.id === RUN)!;
    first.shape = (first.shape === 'run-python-hidden' ? 'run-python' : 'run-python-hidden') as typeof first.shape;
    replay.answer('GET', DRAFT.path, [{ ...DRAFT, body: view }]);
    replay.answer('PATCH', recorded.path, [recorded]);
    await openEditor();
    await type(`exec-run-${RUN}-label`, recording.facts.savedLabel as string);
    await click('exec-save');
    const saves = () => replay.seen.filter((one) => one.method === 'PATCH' && one.path === recorded.path);
    await until(() => saves().length === 1, 'the save');
    expect(saves()[0].body).not.toEqual(recorded.requestBody);
  });

  it('a refused seal is the API’s sentence, as plain text', async () => {
    replay.answer('PUT', SEAL.path, [REFUSED]);
    await openEditor();
    await seal(REFUSED);
    await until(() => byId(`sealed-hidden-${RUN}-error`), 'the refusal');
    expect(byId(`sealed-hidden-${RUN}-error`)!.textContent).toBe((REFUSED.body as { message: string }).message);
    expect(byId(`sealed-hidden-${RUN}-error`)!.children).toHaveLength(0);
    expectNothingSealedDrawn();
  });
});
