// @vitest-environment jsdom
/**
 * "Later" on the optional quick check holds for the
 * visit to the phase, and a reload of the page is the same visit.
 *
 * The offer is held by the phase layout (`QuickCheckProvider`, keyed by the
 * phase). Held in its state alone, "Later" would let a reload bring the
 * offer back in the same sitting, so the choice is written to this tab's
 * sessionStorage and read back only by the first layout a reloaded document
 * mounts. Every other entry to the phase (a link inside the app, a typed
 * address, a second layout in the same document) offers the check again, by
 * the quick check's "nudged, not blocked" rule.
 *
 * A document is drawn here as a fresh copy of the module (its "has a layout
 * mounted here" mark starts clear) with the browser's navigation entry stood
 * in: "reload" or "navigate". A reload runs no unmount, so the first
 * document's layout is left mounted, as the browser leaves its storage.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const rig = vi.hoisted(() => ({ request: vi.fn(), pathname: '/workspace/phase-1' }));
vi.mock('next/link', () => ({ default: ({ href, children, prefetch: _p, ...rest }: ComponentProps<'a'> & { prefetch?: unknown }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => rig.pathname,
  useParams: () => ({ phaseId: 'phase-1' }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), request: rig.request }));

type Provider = (props: { phaseId: string; phaseStatus?: string; children: ReactNode }) => ReactNode;
let Layout: Provider;
/** A new document, loaded the way the browser's navigation entry says. */
async function newDocument(type: 'navigate' | 'reload') {
  vi.spyOn(window.performance, 'getEntriesByType').mockImplementation(((kind: string) => (kind === 'navigation' ? [{ type }] : [])) as unknown as typeof window.performance.getEntriesByType);
  vi.resetModules();
  await import('@/lib/api');
  Layout = (await import('@/components/workspace/QuickCheck')).QuickCheckProvider as Provider;
}

type Slot = { host: HTMLDivElement; root: Root };
let slots: Slot[] = [];
const quizzes = (before: string, after: string) => ({
  phaseKey: 'testing',
  before: { taskKey: 'concept-before', status: before, scorePct: null, questionCount: 6 },
  after: { taskKey: 'concept-after', status: after, scorePct: null, questionCount: 6 },
});
let answer: unknown = quizzes('open', 'locked');
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0))); };
/** The phase layout, mounted for one phase. */
async function enter(phaseId = 'phase-1', status = 'in_progress'): Promise<Slot> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Layout key={`concept-prompt:${phaseId}`} phaseId={phaseId} phaseStatus={status}><main /></Layout>));
  await settle();
  const slot = { host, root };
  slots.push(slot);
  return slot;
}
function leave(slot: Slot) {
  act(() => slot.root.unmount());
  slot.host.remove();
  slots = slots.filter((one) => one !== slot);
}
const offer = (slot: Slot) => slot.host.querySelector('[data-testid="concept-prompt"]');
const later = (slot: Slot) => act(() => slot.host.querySelector<HTMLButtonElement>('[data-testid="concept-prompt-skip"]')!.click());

beforeEach(async () => {
  rig.request.mockReset();
  rig.request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && /^\/phases\/[^/]+\/concept-quizzes$/.test(path)) return answer;
    throw new Error(`nothing answers ${method} ${path}`);
  });
  answer = quizzes('open', 'locked');
  window.sessionStorage.clear();
  await newDocument('navigate');
});
afterEach(() => {
  [...slots].forEach(leave);
  vi.restoreAllMocks();
});

describe('Later on the quick check holds for the visit, and a reload is the same visit', () => {
  it('a reload of the page does not bring the offer back', async () => {
    const first = await enter();
    expect(offer(first)).not.toBeNull();
    later(first);
    expect(offer(first)).toBeNull();
    await newDocument('reload');
    const reloaded = await enter();
    expect(rig.request).toHaveBeenCalledTimes(2);
    expect(offer(reloaded)).toBeNull();
    // Put away again on the reloaded page, it stays put there too.
    expect(reloaded.host.querySelector('[data-testid="concept-prompt-skip"]')).toBeNull();
  });

  it('a typed address (a new document, not a reload) is a new entry: the offer is back', async () => {
    const first = await enter();
    later(first);
    await newDocument('navigate');
    const typed = await enter();
    expect(offer(typed)).not.toBeNull();
  });

  it('leaving the phase inside the app and coming back is a new entry: the offer is back', async () => {
    const first = await enter();
    later(first);
    leave(first);
    const next = await enter();
    expect(offer(next)).not.toBeNull();
  });

  it('only the first layout of a reloaded document reads the choice back; a later entry in it offers the check', async () => {
    const first = await enter();
    later(first);
    await newDocument('reload');
    const reloaded = await enter();
    expect(offer(reloaded)).toBeNull();
    leave(reloaded);
    const again = await enter();
    expect(offer(again)).not.toBeNull();
  });

  it('a reloaded document reads back only for the page it reloaded: another phase entered after it offers its check', async () => {
    // Later on phase 2, then the tab left for another address without the app unmounting anything.
    const two = await enter('phase-2');
    later(two);
    await newDocument('reload');
    const one = await enter('phase-1');
    expect(offer(one)).not.toBeNull();
    const twoAgain = await enter('phase-2');
    expect(offer(twoAgain)).not.toBeNull();
  });

  it('is kept per phase: Later on one phase leaves another phase\'s offer alone after a reload', async () => {
    const one = await enter('phase-1');
    later(one);
    await newDocument('reload');
    const other = await enter('phase-2');
    expect(offer(other)).not.toBeNull();
  });

  it('is kept per check: the before check put away does not hide the after check once the phase passes', async () => {
    const first = await enter('phase-1', 'in_progress');
    later(first);
    answer = quizzes('taken', 'open');
    await newDocument('reload');
    const passed = await enter('phase-1', 'passed');
    expect(passed.host.querySelector('[data-testid="concept-prompt-title"]')?.textContent).toBe('What did you learn?');
  });

  it('a storage that throws: Later still puts the offer away on this page, and nothing else changes', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    const first = await enter();
    expect(offer(first)).not.toBeNull();
    later(first);
    expect(offer(first)).toBeNull();
    await newDocument('reload');
    const reloaded = await enter();
    expect(offer(reloaded)).not.toBeNull();
  });
});
