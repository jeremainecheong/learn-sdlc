// @vitest-environment jsdom
/**
 * The Deadline badge pack draws a page in its uploaded rooms.
 *
 * The pack supplies a page, web/index.html and web/src/main.ts, as locked
 * files in Implementation, Testing and Maintenance. This file checks, against
 * the tracked pack's own files (support/deadline-badge-pack.ts):
 *
 *  - the page preview starts from web/index.html and runs web/src/main.ts in
 *    those three rooms, Deployment draws nothing (rooms.ts, entry.ts), and no
 *    sealed or run-only folder of the pack carries the page;
 *  - the real bundle (sucrase, the real React runtime asset, the frame's own
 *    loader) draws the three sample tasks, with the Overdue badge exactly
 *    where the helper in the room says, before and after each learner change;
 *  - a change to the open files rebuilds the page by itself.
 *
 * The finished helper in each room is the learner work
 * `fixtures/deadline-badge-web.json` holds, which is the pack's reference
 * answer.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientPagePreview } from '@/components/workspace/preview/client/ClientPagePreview';
import { buildPageBundle, PAGE_PREVIEW_MESSAGE_SOURCE } from '@/components/workspace/preview/client/bundle';
import { hasPagePreview, PAGE_PREVIEW_LIMITS, resolvePageEntry } from '@/components/workspace/preview/client/entry';
import { previewMode, previewSurface } from '@/components/workspace/preview/rooms';
import { PREVIEW_RUNTIME, runFrame, sucrase } from './support/preview-frame';
import { settle } from './support/dom';
import { deadlineBadgeFolder, deadlineBadgeLearnerWork, deadlineBadgeRoom } from './support/deadline-badge-pack';

const HELPER = 'web/src/lib/overdue.ts';

const ROOMS = {
  implementation: '03-implementation',
  testing: '04-testing',
  deployment: '05-deployment',
  maintenance: '06-maintenance',
} as const;

/** What a room shows: its editable files and its locked files, as the phase detail lists them. */
const room = (phase: string): Record<string, string> => deadlineBadgeRoom(phase);

/** The room with the finished helper in place of the starter one. */
const solved = (phase: string): Record<string, string> => ({ ...room(phase), [HELPER]: deadlineBadgeLearnerWork(phase)[HELPER] });

/** An uploaded phase: no sandbox preview, no reference application. */
const uploaded = (key: keyof typeof ROOMS | 'requirements' | 'design', files: Record<string, string>) => ({
  key,
  canPreview: false,
  provenance: { application: null },
  files: Object.keys(files).map((p) => ({ path: p })),
});

type Row = { title: string; due: string; badge: boolean; done: boolean };

/** Builds the frame's document from the room's files and runs it, as the frame would. */
async function runPage(files: Record<string, string>) {
  const built = buildPageBundle(files, { transform: sucrase, runtime: PREVIEW_RUNTIME, nonce: 'n-1' });
  if (!built.ok) throw new Error(built.error);
  const frame = await runFrame(built.srcdoc);
  const messages = frame.messages.filter((m) => m.source === PAGE_PREVIEW_MESSAGE_SOURCE && m.nonce === 'n-1');
  const { problems } = frame;
  const doc = frame.document;
  const rows = (): Row[] =>
    [...doc.querySelectorAll('[data-testid="preview-task-row"]')].map((li) => ({
      title: li.getAttribute('data-title') ?? '',
      due: li.querySelector('.due')?.textContent ?? '',
      badge: li.querySelector('[data-testid="preview-overdue-badge"]') !== null,
      done: (li.querySelector('[data-testid="preview-done"]') as HTMLInputElement | null)?.checked ?? false,
    }));
  const badged = () => rows().filter((r) => r.badge).map((r) => r.title);
  const toggle = (title: string) => {
    const box = doc.querySelector(`[data-testid="preview-task-row"][data-title="${title}"] [data-testid="preview-done"]`) as HTMLInputElement;
    box.click();
  };
  return { built, doc, rows, badged, toggle, messages, problems, close: frame.close };
}

describe('the Deadline badge pack draws its page', () => {
  describe('(a) where the page preview starts, room by room', () => {
    it.each(['implementation', 'testing', 'maintenance'] as const)('%s starts from web/index.html and runs web/src/main.ts', (key) => {
      const files = room(ROOMS[key]);
      expect(resolvePageEntry(files)).toEqual({ html: 'web/index.html', module: 'web/src/main.ts', component: null });
      expect(hasPagePreview(Object.keys(files))).toBe(true);
      expect(previewMode(uploaded(key, files))).toBe('client');
      expect(previewSurface(uploaded(key, files))).toBe(key === 'implementation' ? 'section' : 'view');
    });

    it('Deployment, Requirements and Design draw no page', () => {
      const deploy = room(ROOMS.deployment);
      expect(Object.keys(deploy).length).toBeGreaterThan(0);
      expect(resolvePageEntry(deploy)).toBeNull();
      expect(previewMode(uploaded('deployment', deploy))).toBe('none');
      expect(previewMode(uploaded('requirements', {}))).toBe('none');
      expect(previewMode(uploaded('design', {}))).toBe('none');
    });

    it('no sealed or run-only folder of the pack carries the page', () => {
      for (const phase of Object.values(ROOMS)) {
        for (const sub of ['solution', 'impl', 'reference', 'hidden_tests', 'mutants', 'smoke', 'drill']) {
          const paths = Object.keys(deadlineBadgeFolder(phase, sub));
          expect(paths.filter((p) => /index\.html$|(^|\/)main\.ts$/.test(p)), `${phase}/${sub}`).toEqual([]);
        }
      }
    });

    it('the bundle holds the page code and never a test file, well inside the limits', () => {
      const files = room(ROOMS.implementation);
      const built = buildPageBundle(files, { transform: sucrase, runtime: '', nonce: 'x' });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.srcdoc).toContain('__defs["web/src/main.ts"]');
      expect(built.srcdoc).toContain('__defs["web/src/lib/overdue.ts"]');
      expect(built.srcdoc).not.toContain('__defs["web/src/lib/overdue.test.ts"]');
      expect(Object.keys(files).length).toBeLessThan(PAGE_PREVIEW_LIMITS.files);
      expect(built.srcdoc.length).toBeLessThan(PAGE_PREVIEW_LIMITS.bytes);
      expect(built.srcdoc).toContain('<title>Deadline badge</title>');
      expect(built.srcdoc).toContain('Demo date: 13 November 2026 (fixed, the same day the tests use)');
    });
  });

  describe('(b) the page runs with the helper the room holds', () => {
    const DUE = ['Due 12 November 2026', 'Due 13 November 2026', 'No due date'];

    it('Implementation starter: three rows, no badge (the helper still returns false)', async () => {
      const page = await runPage(room(ROOMS.implementation));
      expect(page.rows().map((r) => r.title)).toEqual(['Yesterday', 'Today', 'No due date']);
      expect(page.rows().map((r) => r.due)).toEqual(DUE);
      expect(page.badged()).toEqual([]);
      expect(page.doc.querySelector('[data-testid="preview-demo-date"]')?.textContent).toBe(
        'Demo date: 13 November 2026 (fixed, the same day the tests use)',
      );
      expect(page.messages.map((m) => m.type)).toEqual(['painted']);
      expect(page.problems).toEqual([]);
      page.close();
    });

    it('Implementation solution: the badge on Yesterday only, and Done changes nothing yet', async () => {
      const page = await runPage(solved(ROOMS.implementation));
      expect(page.badged()).toEqual(['Yesterday']);
      page.toggle('Yesterday');
      expect(page.rows()[0]).toMatchObject({ title: 'Yesterday', done: true, badge: true });
      expect(page.messages.filter((m) => m.type === 'error')).toEqual([]);
      expect(page.problems).toEqual([]);
      page.close();
    });

    it('Testing: the working helper it shows draws the badge on Yesterday only', async () => {
      const page = await runPage(room(ROOMS.testing));
      expect(page.badged()).toEqual(['Yesterday']);
      expect(page.problems).toEqual([]);
      page.close();
    });

    it('Maintenance starter: the badge on Yesterday stays when Done is ticked (CR-1 not made yet)', async () => {
      const page = await runPage(room(ROOMS.maintenance));
      expect(page.badged()).toEqual(['Yesterday']);
      page.toggle('Yesterday');
      expect(page.badged()).toEqual(['Yesterday']);
      expect(page.problems).toEqual([]);
      page.close();
    });

    it('Maintenance solution: ticking Done on Yesterday takes its badge away, clearing it brings it back', async () => {
      const page = await runPage(solved(ROOMS.maintenance));
      expect(page.badged()).toEqual(['Yesterday']);
      page.toggle('Yesterday');
      expect(page.rows()[0]).toMatchObject({ title: 'Yesterday', done: true, badge: false });
      expect(page.badged()).toEqual([]);
      page.toggle('Yesterday');
      expect(page.rows()[0]).toMatchObject({ title: 'Yesterday', done: false, badge: true });
      page.toggle('Today');
      page.toggle('No due date');
      expect(page.badged()).toEqual(['Yesterday']);
      expect(page.messages.filter((m) => m.type === 'error')).toEqual([]);
      expect(page.problems).toEqual([]);
      page.close();
    });
  });

  describe('a change to the open files rebuilds the page by itself', () => {
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

    it('the Maintenance helper changed in the editor is in a new frame 700 ms later, with no Run or Rebuild press', async () => {
      const loadTransform = () => Promise.resolve(sucrase);
      const loadRuntime = () => Promise.resolve('window.__learnsdlcPreviewRuntime = { stub: true };');
      const before = room(ROOMS.maintenance);
      const after = solved(ROOMS.maintenance);
      const frame = () => host.querySelector('iframe[data-testid="page-preview-frame"]') as HTMLIFrameElement;

      await act(async () => root.render(createElement(ClientPagePreview, { files: before, loadTransform, loadRuntime })));
      await settle(5);
      const first = frame().getAttribute('data-nonce');
      expect(frame().getAttribute('srcdoc')).not.toContain('task.done ||');

      await act(async () => root.render(createElement(ClientPagePreview, { files: after, loadTransform, loadRuntime })));
      await act(async () => { vi.advanceTimersByTime(650); });
      expect(frame().getAttribute('data-nonce')).toBe(first);
      await act(async () => { vi.advanceTimersByTime(100); });
      await settle(5);
      expect(frame().getAttribute('data-nonce')).not.toBe(first);
      expect(frame().getAttribute('srcdoc')).toContain('task.done ||');
      expect(host.querySelectorAll('button')).toHaveLength(1);
      expect(host.querySelector('button')?.textContent).toBe('Reload');
    });
  });
});
