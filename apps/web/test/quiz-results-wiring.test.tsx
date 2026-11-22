// @vitest-environment jsdom
/**
 * The teacher's quiz-results export form, against what the API answered in
 * `apps/api/test/quiz-results-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/quiz-results.json`).
 *
 * The real `TeacherPortal`, the real `instructorApi` and the real `fetch`,
 * pointed at a tiny HTTP server on `127.0.0.1:0` that replays the recording
 * (`contract-exchanges/replay.ts`). The browser's "save a file" is the one thing
 * stood in for: `URL.createObjectURL` is jsdom's missing piece, so it is
 * stubbed to keep the blob it is handed.
 *
 * A regression guard: the form and its client pass against the recording.
 * The vacuity proof is the last case: the same comparison, handed a CSV the
 * API did not answer, is red.
 *
 * - Each of the four kinds asks the API's own path for it and saves exactly
 *   the bytes the API answered, under the file name the form gives it.
 * - Nothing of a file is drawn on the page: no header row, no data row.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizResultsExportKind } from '@learnsdlc/shared';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';
import { startReplay, type Replay } from './support/contract-fixtures';
import { stubMatchMedia, typeInto, waitUntil } from './support/dom';

// One router object for the whole file, as Next hands out: the
// portal's load effect lists `router` among its dependencies.
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
    useRouter: () => router,
    usePathname: () => '/teacher',
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const recording = readExchangeRecording('quiz-results');
const KINDS = recording.facts.kinds as QuizResultsExportKind[];
const fileOf = (kind: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === `file:${kind}`);
  if (!found) throw new Error(`no file:${kind} in quiz-results.json`);
  return found;
};
const csvOf = (kind: string) => (fileOf(kind).body as { text: string }).text;

let replay: Replay;
let TeacherPortal: (props: { classView?: boolean }) => ReactNode;
let host: HTMLDivElement;
let root: Root;
let saved: Array<{ blob: Blob; name: string }> = [];
let pending: Blob | null = null;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
};
const until = (what: () => unknown, label: string) =>
  waitUntil(what, label, { tries: 80, tick: 5, detail: () => `misses: ${replay.misses.join(', ') || 'none'}` });

beforeAll(async () => {
  replay = await startReplay(recording.exchanges);
  process.env.NEXT_PUBLIC_API_URL = replay.url;
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  ({ TeacherPortal } = (await import('@/components/staff/console/TeacherPortal')) as never);
});
afterAll(async () => {
  await replay?.close();
  delete process.env.NEXT_PUBLIC_API_URL;
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  saved = [];
  pending = null;
  // jsdom has no object URLs. The blob is kept here; the anchor's download
  // name is read when `saveBlob` clicks it.
  (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (blob: Blob) => {
    pending = blob;
    return 'blob:replay';
  };
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download && pending) saved.push({ blob: pending, name: this.download });
  });
  replay.seen.length = 0;
  replay.misses.length = 0;
  for (const kind of KINDS) replay.answer('GET', fileOf(kind).path, [fileOf(kind)]);
  window.history.replaceState(null, '', '/teacher');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** The saved blob's text, whichever Blob the runtime's fetch made it with. */
async function readBlob(blob: Blob): Promise<string> {
  const withText = blob as Blob & { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof withText.text === 'function') return withText.text();
  if (typeof withText.arrayBuffer === 'function') return new TextDecoder().decode(await withText.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function exportKind(kind: QuizResultsExportKind): Promise<{ text: string; name: string }> {
  const select = byId<HTMLSelectElement>('export-quiz-kind')!;
  await act(async () => {
    typeInto(select, kind, 'change');
  });
  const before = saved.length;
  await act(async () => byId<HTMLButtonElement>('export-quiz-results')!.click());
  await until(() => saved.length > before, `the ${kind} file to be saved`);
  const one = saved[saved.length - 1];
  return { text: await readBlob(one.blob), name: one.name };
}

const open = async () => {
  await act(async () => root.render(<TeacherPortal />));
  await until(() => byId('export-quiz-form'), 'the quiz-results form');
  await until(() => replay.seen.some((one) => one.path === '/instructor/learners'), 'the learners read');
  await settle();
};

describe('the quiz-results export, from the API recording', () => {
  it('asks the API’s path for each kind and saves exactly the file the API answered', async () => {
    await open();
    for (const kind of KINDS) {
      const { text, name } = await exportKind(kind);
      const asked = replay.seen.filter((one) => one.method === 'GET' && one.path === fileOf(kind).path);
      expect(asked).toHaveLength(1);
      expect(asked[0].query).toEqual(fileOf(kind).query);
      expect(asked[0].authorization).toBe('Bearer replay-session');
      expect(text).toBe(csvOf(kind));
      expect(name).toBe(`quiz-${kind}.csv`);
    }
    expect(replay.misses).toEqual([]);
  });

  it('draws nothing of any file on the page', async () => {
    await open();
    for (const kind of KINDS) await exportKind(kind);
    const page = host.innerHTML;
    for (const kind of KINDS) {
      const [header, ...rows] = csvOf(kind).trim().split(/\r?\n/);
      expect(page).not.toContain(header);
      for (const row of rows) expect(page).not.toContain(row);
    }
    expect(host.querySelector('table[data-testid*="quiz"]')).toBeNull();
  });

  it('vacuity: a file the API did not answer is not what the page saves', async () => {
    const kind = KINDS[0];
    const broken = { ...fileOf(kind), body: { contentType: 'text/csv', text: `${csvOf(kind)}not,the,api\r\n` } };
    replay.answer('GET', fileOf(kind).path, [broken]);
    await open();
    const { text } = await exportKind(kind);
    expect(text).not.toBe(csvOf(kind));
  });

  // The portal's load effect depends on `router`, and a mock that hands out a
  // new router per render would re-run it on every render. As in Next, the
  // router is one object, so a mount loads once.
  it('harness: one router object, so the portal loads once per mount', async () => {
    await open();
    await settle(20);
    // The overview is read by the portal's own load and nothing else on the page.
    expect(replay.seen.filter((one) => one.method === 'GET' && one.path === '/instructor/overview')).toHaveLength(1);
  });
});
