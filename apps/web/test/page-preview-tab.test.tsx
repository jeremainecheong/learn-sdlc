// @vitest-environment jsdom
/**
 * The page preview in a tab of its own.
 *
 * The workspace's link writes the code in the editor at that moment (not the
 * debounced page) to localStorage and opens /page-preview#<id>; the tab reads
 * it once, keeps its own copy in sessionStorage, and draws it in the same
 * scripts-only frame. A tab with nothing to show says so; storage that refuses
 * the write breaks nothing.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'fs';
import * as path from 'path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { transform } from 'sucrase';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientPagePreview } from '@/components/workspace/preview/client/ClientPagePreview';
import { PagePreviewTab } from '@/components/workspace/preview/client/PagePreviewTab';
import { transformOptionsFor } from '@/components/workspace/preview/client/bundle';
import {
  PAGE_HANDOVER_PREFIX,
  handoverKey,
  pruneHandovers,
  stashHandover,
  takeHandover,
} from '@/components/workspace/preview/client/handover';
import {
  PAGE_PREVIEW_LABEL_NO_DATA as PAGE_PREVIEW_LABEL, // the starter's page asks the API and ships no sample data
  PAGE_PREVIEW_TAB_EMPTY,
  PAGE_PREVIEW_TAB_TITLE,
  pagePreviewClock,
  pagePreviewTabSnapshot,
} from '@/components/workspace/preview/copy';
import PagePreviewPage from '@/app/page-preview/page';
import { metadata } from '@/app/page-preview/layout';
import { settle } from './support/dom';

const STARTER = repoPath('apps/api/test/fixtures/upload-packs/starter/phases');
const FILES = {
  'web/src/main.ts': readFileSync(path.join(STARTER, '03-implementation/readonly/web/src/main.ts'), 'utf8'),
  'web/src/ShelfPage.ts': readFileSync(path.join(STARTER, '03-implementation/readonly/web/src/ShelfPage.ts'), 'utf8'),
  'web/src/lib/shelf.ts': readFileSync(path.join(STARTER, '06-maintenance/solution/web/src/lib/shelf.ts'), 'utf8'),
};
const loadTransform = () => Promise.resolve((code: string, file: string) => transform(code, transformOptionsFor(file)).code);
const loadRuntime = () => Promise.resolve('window.__learnsdlcPreviewRuntime = { stub: true };');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = '';
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const link = () => q('page-preview-open') as HTMLAnchorElement;
const idOf = (a: HTMLAnchorElement) => a.getAttribute('href')!.replace('/page-preview#', '');
const stored = (id: string) => JSON.parse(localStorage.getItem(handoverKey(id))!);

describe('s15: the workspace link', () => {
  it('reads Open in a new tab beside Reload, a plain anchor to /page-preview#<random id> that opens a fresh tab', async () => {
    act(() => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const a = link();
    expect(a.tagName).toBe('A');
    expect(a.textContent).toBe('Open in a new tab');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(a.className).toBe('btn-ghost btn-sm shrink-0');
    expect(a.getAttribute('href')).toMatch(/^\/page-preview#[a-zA-Z0-9]{16,}$/);
    expect(a.previousElementSibling?.getAttribute('data-testid')).toBe('page-preview-reload');
    // opening it writes nothing until it is used, and changes nothing in the panel
    expect(localStorage.length).toBe(0);
    expect(q('page-preview-label')!.textContent).toBe(PAGE_PREVIEW_LABEL);
  });

  it('is not drawn when the room has no page', async () => {
    act(() => root.render(<ClientPagePreview files={{ 'api/x.py': 'x = 1' }} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    expect(q('page-preview-open')).toBeNull();
  });

  it('stashes the CURRENT files on every way of opening, before the 0.7 s rebuild', async () => {
    act(() => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const nonceBefore = q('page-preview-frame')!.getAttribute('data-nonce');
    const edited = { ...FILES, 'web/src/lib/shelf.ts': FILES['web/src/lib/shelf.ts'] + '\n// just typed\n' };
    act(() => root.render(<ClientPagePreview files={edited} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    // the inline page has not rebuilt yet (debounce)
    expect(q('page-preview-frame')!.getAttribute('data-nonce')).toBe(nonceBefore);
    const a = link();
    for (const type of ['pointerdown', 'contextmenu', 'auxclick', 'click']) {
      localStorage.clear();
      act(() => { a.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); });
      const record = stored(idOf(a));
      expect(record.version).toBe(1);
      expect(record.files['web/src/lib/shelf.ts']).toContain('// just typed');
      expect(Number.isNaN(Date.parse(record.takenAt))).toBe(false);
    }
    localStorage.clear();
    act(() => { a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(stored(idOf(a)).files['web/src/lib/shelf.ts']).toContain('// just typed');
  });

  it('stashes what the editor shows (liveFiles) when the caller gives it, though files still waits for the autosave', async () => {
    const typed = { ...FILES, 'web/src/lib/shelf.ts': FILES['web/src/lib/shelf.ts'] + '\n// typed, not yet saved\n' };
    act(() => root.render(<ClientPagePreview files={FILES} liveFiles={() => typed} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const a = link();
    act(() => { a.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true })); });
    expect(stored(idOf(a)).files['web/src/lib/shelf.ts']).toContain('// typed, not yet saved');
    expect(stored(idOf(a)).files).toEqual(typed);
  });

  it('draws the same link in the notice form (the reference project\'s fallback), the notice unchanged', async () => {
    act(() => root.render(<ClientPagePreview files={FILES} notice="x" loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    expect(link().textContent).toBe('Open in a new tab');
    const label = q('page-preview-label')!;
    expect(label.firstElementChild!.tagName).toBe('SPAN');
    expect(label.firstElementChild!.className).toBe('block text-muted');
    expect(label.firstElementChild!.textContent).toBe('x');
    expect(label.textContent).toBe(`x${PAGE_PREVIEW_LABEL}`);
  });

  it('removes records older than 24 hours (and broken ones) when it stashes, and keeps fresh ones and other keys', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    localStorage.setItem(`${PAGE_HANDOVER_PREFIX}old`, JSON.stringify({ files: {}, takenAt: '2026-11-09T11:59:00Z', version: 1 }));
    localStorage.setItem(`${PAGE_HANDOVER_PREFIX}fresh`, JSON.stringify({ files: {}, takenAt: '2026-11-09T12:30:00Z', version: 1 }));
    localStorage.setItem(`${PAGE_HANDOVER_PREFIX}broken`, '{');
    localStorage.setItem('learnsdlc.theme', 'paper');
    expect(stashHandover('abc', { 'a.ts': '1' }, now)).toBe(true);
    expect(localStorage.getItem(`${PAGE_HANDOVER_PREFIX}old`)).toBeNull();
    expect(localStorage.getItem(`${PAGE_HANDOVER_PREFIX}broken`)).toBeNull();
    expect(localStorage.getItem(`${PAGE_HANDOVER_PREFIX}fresh`)).not.toBeNull();
    expect(localStorage.getItem('learnsdlc.theme')).toBe('paper');
    expect(stored('abc')).toEqual({ files: { 'a.ts': '1' }, takenAt: '2026-11-10T12:00:00.000Z', version: 1 });
    expect(() => pruneHandovers({ get length() { throw new Error('blocked'); } } as unknown as Storage, now)).not.toThrow();
  });

  it('a write that throws (quota, blocked storage) leaves the link working and the tab says it has nothing to show', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(stashHandover('abc', FILES)).toBe(false);
    act(() => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const a = link();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(() => act(() => { a.dispatchEvent(click); })).not.toThrow();
    expect(click.defaultPrevented).toBe(false);
    expect(q('client-page-preview')).not.toBeNull();
    expect(takeHandover(idOf(a))).toBeNull();
  });
});

describe('s15: the tab', () => {
  const RECORD = { files: FILES, takenAt: '2026-11-10T13:04:05.000Z', version: 1 };

  it('reads its record by hash, copies it into sessionStorage, and a reload keeps the SAME snapshot and time', async () => {
    localStorage.setItem(handoverKey('tok1'), JSON.stringify(RECORD));
    window.location.hash = '#tok1';
    act(() => root.render(<PagePreviewPage />));
    await settle(5);
    expect(q('page-preview-tab')).not.toBeNull();
    expect(q('page-preview-tab-label')!.textContent).toBe(PAGE_PREVIEW_LABEL);
    const line = q('page-preview-tab-snapshot')!;
    expect(line.getAttribute('data-taken-at')).toBe(RECORD.takenAt);
    expect(line.textContent).toBe(
      `Snapshot of the code in your editor at ${pagePreviewClock(RECORD.takenAt)}. This tab does not update: to see later changes, go back to your workspace and press Open in a new tab again.`,
    );
    expect(pagePreviewClock(RECORD.takenAt)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(JSON.parse(sessionStorage.getItem(handoverKey('tok1'))!)).toEqual(RECORD);
    // the workspace stashes again; a refresh of this tab still shows the first snapshot
    localStorage.setItem(handoverKey('tok1'), JSON.stringify({ ...RECORD, takenAt: '2026-11-10T13:09:00.000Z', files: { 'x.html': '<p>new</p>' } }));
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<PagePreviewPage />));
    await settle(5);
    expect(q('page-preview-tab-snapshot')!.getAttribute('data-taken-at')).toBe(RECORD.takenAt);
  });

  it('after "Skip to main content" rewrites the hash to #main, a refresh still shows the same snapshot', async () => {
    localStorage.setItem(handoverKey('tok2'), JSON.stringify(RECORD));
    window.location.hash = '#tok2';
    act(() => root.render(<PagePreviewPage />));
    await settle(5);
    const main = q('page-preview-tab')!;
    expect(main.tagName).toBe('MAIN');
    expect(main.id).toBe('main');
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(sessionStorage.getItem('learnsdlc.pagePreview.tab')).toBe('tok2');
    window.location.hash = '#main';
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<PagePreviewPage />));
    await settle(5);
    expect(q('page-preview-tab-empty')).toBeNull();
    expect(q('page-preview-tab-snapshot')!.getAttribute('data-taken-at')).toBe(RECORD.takenAt);
  });

  it('draws the record in a frame sandboxed with scripts only, and Reload re-runs the same snapshot', async () => {
    act(() => root.render(<PagePreviewTab record={RECORD as never} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const frame = q('page-preview-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain('ShelfPage');
    const before = frame.getAttribute('data-nonce');
    act(() => q('page-preview-reload')!.click());
    const after = q('page-preview-frame')!;
    expect(after.getAttribute('data-nonce')).not.toBe(before);
    expect(after.getAttribute('srcdoc')!.replace(after.getAttribute('data-nonce')!, '')).toBe(frame.getAttribute('srcdoc')!.replace(before!, ''));
    expect(pagePreviewTabSnapshot(RECORD.takenAt)).toContain('Open in a new tab again.');
  });

  it.each([
    ['no hash', '', null],
    ['an unknown id', '#nobody', null],
    ['malformed JSON', '#bad', '{"files":'],
    ['a wrong version', '#old', JSON.stringify({ ...RECORD, version: 2 })],
    ['files that are not text', '#odd', JSON.stringify({ ...RECORD, files: { 'a.ts': 3 } })],
  ])('says it has nothing to show for %s', async (_name, hash, stored) => {
    if (stored) localStorage.setItem(handoverKey(hash.slice(1)), stored);
    window.location.hash = hash;
    act(() => root.render(<PagePreviewPage />));
    await settle(5);
    expect(q('page-preview-tab-empty')!.textContent).toBe(PAGE_PREVIEW_TAB_EMPTY);
    expect(PAGE_PREVIEW_TAB_EMPTY).toBe('Nothing to show here. Open the page preview in your workspace and press Open in a new tab.');
    expect(q('page-preview-frame')).toBeNull();
    expect(q('page-preview-tab-snapshot')).toBeNull();
  });

  it('is titled Page preview and never indexed', () => {
    expect(PAGE_PREVIEW_TAB_TITLE).toBe('Page preview');
    expect(metadata.title).toBe(PAGE_PREVIEW_TAB_TITLE);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
