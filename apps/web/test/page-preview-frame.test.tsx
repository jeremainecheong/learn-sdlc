// @vitest-environment jsdom
/**
 * The page preview's frame.
 *
 * The frame runs the learner's code with scripts and nothing else: no
 * same-origin, no forms, no popups, and a CSP with no network. It says what it
 * is, it shows errors as text, and a page that has not drawn in five seconds
 * says so and offers Reload.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'fs';
import * as path from 'path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { transform } from 'sucrase';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientPagePreview } from '@/components/workspace/preview/client/ClientPagePreview';
import { transformOptionsFor } from '@/components/workspace/preview/client/bundle';
import { PAGE_PREVIEW_LABEL, PAGE_PREVIEW_LABEL_NO_DATA, PAGE_PREVIEW_TIMEOUT, PAGE_PREVIEW_NO_PAGE } from '@/components/workspace/preview/copy';
import { settle } from './support/dom';

// the starter's finished page: Implementation's read-only main.ts and ShelfPage.ts, and Maintenance's reference
// lib/shelf.ts (the starter holds no canonical/ in the folder layout, spec 7.3)
const STARTER = repoPath('apps/api/test/fixtures/upload-packs/starter/phases');
const FILES = {
  'api/shelf.py': 'def books(): ...',
  'web/src/main.ts': readFileSync(path.join(STARTER, '03-implementation/readonly/web/src/main.ts'), 'utf8'),
  'web/src/ShelfPage.ts': readFileSync(path.join(STARTER, '03-implementation/readonly/web/src/ShelfPage.ts'), 'utf8'),
  'web/src/lib/shelf.ts': readFileSync(path.join(STARTER, '06-maintenance/solution/web/src/lib/shelf.ts'), 'utf8'),
};
const loadTransform = () => Promise.resolve((code: string, file: string) => transform(code, transformOptionsFor(file)).code);
const RUNTIME_STUB = 'window.__learnsdlcPreviewRuntime = { stub: true };';
const loadRuntime = () => Promise.resolve(RUNTIME_STUB);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const frame = () => host.querySelector('iframe[data-testid="page-preview-frame"]') as HTMLIFrameElement | null;

describe('the page preview frame', () => {
  it('sandboxes the frame with scripts only, and puts a no-network CSP inside', async () => {
    await act(async () => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const el = frame();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(el!.getAttribute('sandbox')).not.toMatch(/allow-same-origin/);
    expect(el!.getAttribute('src')).toBeNull();
    const srcdoc = el!.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain("default-src 'none'");
    // The parent fetched the runtime (same origin, with its cookie) and inlined it:
    // the opaque-origin frame loads nothing by URL.
    expect(srcdoc).toContain(RUNTIME_STUB);
    expect(srcdoc).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(srcdoc).not.toContain('/preview-runtime/');
    expect(srcdoc).not.toMatch(/script-src[^;]*https?:/);
    expect(srcdoc).not.toContain('def books');
    // The starter's shelf page asks the API for its books and the project ships no sample data, so the
    // line says the page gets no data from it; a page that holds its own data keeps the sentence below.
    expect(host.textContent).toContain(PAGE_PREVIEW_LABEL_NO_DATA);
    expect(PAGE_PREVIEW_LABEL).toBe('Page preview: your code running in the browser with sample data. Your API is not running here.');
  });

  it('says the page did not draw in 5 seconds, and Reload builds a fresh frame', async () => {
    await act(async () => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const first = frame();
    expect(host.textContent).not.toContain(PAGE_PREVIEW_TIMEOUT);
    await act(async () => { vi.advanceTimersByTime(4900); });
    expect(host.textContent).not.toContain(PAGE_PREVIEW_TIMEOUT);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(PAGE_PREVIEW_TIMEOUT).toBe('This page did not draw in 5 seconds.');
    expect(host.textContent).toContain(PAGE_PREVIEW_TIMEOUT);
    const reload = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Reload'));
    expect(reload).toBeDefined();
    await act(async () => reload!.click());
    await settle(5);
    expect(host.textContent).not.toContain(PAGE_PREVIEW_TIMEOUT);
    expect(frame()).not.toBe(first);
  });

  it('shows an error from the frame as text, and a painted page clears the clock', async () => {
    await act(async () => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    const win = frame()!.contentWindow;
    const nonce = frame()!.getAttribute('data-nonce');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'learnsdlc-page-preview', nonce, type: 'error', message: 'shelfLabel is not implemented yet' }, source: win }));
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'learnsdlc-page-preview', nonce, type: 'painted' }, source: win }));
    });
    expect(host.textContent).toContain('shelfLabel is not implemented yet');
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(host.textContent).not.toContain(PAGE_PREVIEW_TIMEOUT);
  });

  it('ignores messages that are not from its own frame', async () => {
    await act(async () => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'learnsdlc-page-preview', nonce: frame()!.getAttribute('data-nonce'), type: 'error', message: 'forged' }, source: window }));
    });
    expect(host.textContent).not.toContain('forged');
  });

  it('says so as text when the runtime cannot be fetched', async () => {
    const failing = () => Promise.reject(new Error('The page preview runtime did not load.'));
    await act(async () => root.render(<ClientPagePreview files={FILES} loadTransform={loadTransform} loadRuntime={failing} />));
    await settle(5);
    expect(frame()).toBeNull();
    expect(host.querySelector('[data-testid="page-preview-error"]')?.textContent).toBe('The page preview runtime did not load.');
  });

  it('says so when the files hold no page', async () => {
    await act(async () => root.render(<ClientPagePreview files={{ 'web/src/lib/shelf.ts': '' }} loadTransform={loadTransform} loadRuntime={loadRuntime} />));
    await settle(5);
    expect(frame()).toBeNull();
    expect(host.textContent).toContain(PAGE_PREVIEW_NO_PAGE);
  });
});
