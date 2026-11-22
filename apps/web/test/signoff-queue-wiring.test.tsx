// @vitest-environment jsdom
/**
 * The class page's sign-off queue and bulk sign-off, drawn from what the API
 * answered in
 * `apps/api/test/signoff-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/signoff.json`).
 *
 * The page is the real `TeacherPortal` in its class view with the real
 * `lib/api-*` clients and the real `fetch`. Their base URL points at a tiny
 * HTTP server on `127.0.0.1:0` that answers each request with the recorded
 * answer for its method and path (`contract-exchanges/replay.ts`). Nothing of the
 * client is mocked; only the app shell, the router and the page's scroll
 * container are, as every portal test does.
 *
 * - The class page shows the queue the API answered: one batch per task, each
 *   learner by the name the API gave.
 * - The batch the page sends is the body the API accepted (one task, both
 *   learners, one reason), and the page reads back the API's answer.
 * - The same batch again: each refusal is the API's own sentence.
 * - The empty queue the API answered after the batch draws the empty state.
 * - A reason shorter than the API accepts (the recorded 400) holds the batch
 *   back on the page; its vacuity proof is the accepted reason in the same
 *   field, which sends it.
 *
 * The empty-queue case is a guard on the recorded empty answer.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkSignoffBody, SignoffQueueView } from '@learnsdlc/shared';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';
import { startReplay, type Replay } from './support/contract-fixtures';
import { stubMatchMedia, waitUntil } from './support/dom';

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
    usePathname: () => '/teacher/class',
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

const recording = readExchangeRecording('signoff');
const exchange = (name: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name} in signoff.json`);
  return found;
};
const COHORT = recording.facts.cohortId as string;
const REASON = recording.facts.reason as string;
const QUEUE = exchange('queue').body as SignoffQueueView;
const ACCEPTED = exchange('bulk');

let replay: Replay;
let TeacherPortal: (props: { classView?: boolean }) => ReactNode;
let host: HTMLDivElement;
let root: Root;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
};
const until = (what: () => unknown, label: string) =>
  waitUntil(what, label, { tries: 80, tick: 5, detail: () => `misses: ${replay.misses.join(', ') || 'none'}` });
async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}
async function type(id: string, value: string) {
  const node = byId<HTMLTextAreaElement>(id);
  expect(node, `no field ${id}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
    node!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const queueReads = () => replay.seen.filter((one) => one.method === 'GET' && one.path === exchange('queue').path);
const batches = () => replay.seen.filter((one) => one.method === 'POST' && one.path === ACCEPTED.path);

/**
 * Requests the page has sent and not yet had answered. `fetch` itself is the
 * real one; this only counts around it.
 *
 * A case that sends a batch ends while the page is still at work: the batch's
 * own queue read, then the class page's refresh (overview, classes, learners,
 * help requests) and the queue read its new round starts. Unmounted mid-way,
 * those requests reached the replay server after the next case's `beforeEach`
 * had set its answers, so the stale queue read took the next case's first
 * answer (the full queue) and the next page was served the empty one
 * (`queueAfter`): "no control signoff-all-…". Each case therefore waits, before
 * it unmounts, until its page has nothing in flight and has sent nothing new
 * for a few rounds.
 */
let inFlight = 0;
let realFetch: typeof fetch;
const quiet = async () => {
  let calm = 0;
  for (let i = 0; i < 200 && calm < 3; i++) {
    const sent = replay.seen.length;
    await settle(1);
    calm = inFlight === 0 && replay.seen.length === sent ? calm + 1 : 0;
  }
  if (calm < 3) throw new Error(`the page never went quiet: ${inFlight} request(s) still in flight`);
};

beforeAll(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    inFlight += 1;
    try {
      return await realFetch(...args);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  replay = await startReplay(recording.exchanges);
  process.env.NEXT_PUBLIC_API_URL = replay.url;
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  ({ TeacherPortal } = (await import('@/components/staff/console/TeacherPortal')) as never);
});
afterAll(async () => {
  await replay?.close();
  globalThis.fetch = realFetch;
  delete process.env.NEXT_PUBLIC_API_URL;
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  replay.seen.length = 0;
  replay.misses.length = 0;
  replay.answer('GET', exchange('queue').path, [exchange('queue'), exchange('queueAfter')]);
  replay.answer('POST', ACCEPTED.path, [exchange('bulk')]);
  window.history.replaceState(null, '', `/teacher/class?class=${encodeURIComponent(COHORT)}`);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  // This case's requests are answered inside this case, never the next.
  await quiet();
  act(() => root.unmount());
  host.remove();
});

const open = async () => {
  await act(async () => root.render(<TeacherPortal classView />));
  await until(() => byId('signoff-queue'), 'the sign-off queue on the class page');
  await until(() => !byId('signoff-loading'), 'the queue to load');
};

describe('the class page’s sign-off queue, from the API recording', () => {
  it('the class page shows the sign-off queue the API answered', async () => {
    await open();
    expect(queueReads().length).toBeGreaterThanOrEqual(1);
    expect(queueReads()[0].authorization).toBe('Bearer replay-session');
    const queue = byId('signoff-queue')!;
    const groupKey = `${QUEUE.rows[0].phaseKey}-${QUEUE.rows[0].taskKey}`;
    const group = byId(`signoff-task-${groupKey}`);
    expect(group).not.toBeNull();
    expect(group!.querySelector('legend')?.textContent).toContain(QUEUE.rows[0].taskTitle);
    for (const row of QUEUE.rows) {
      expect(byId(`signoff-pick-${groupKey}-${row.userId}`)).not.toBeNull();
      expect(queue.textContent).toContain(row.learnerName);
    }
    expect(queue.textContent).toContain(`${QUEUE.rows.length} waiting`);
  });

  it('each reason field on the class page names which reason it is, visibly and by its accessible name', async () => {
    await open();
    const groupKey = `${QUEUE.rows[0].phaseKey}-${QUEUE.rows[0].taskKey}`;
    const signoff = byId(`signoff-reason-${groupKey}`) as HTMLTextAreaElement;
    expect([...signoff.labels].map((l) => l.textContent?.trim())).toEqual(['Reason for the sign-off']);
    const labels = [...document.querySelectorAll('textarea')].flatMap((t) => [...t.labels].map((l) => l.textContent?.trim()));
    expect(labels).not.toContain('Reason');
  });

  it('sends the batch the API accepted, and reads the API’s answer back', async () => {
    await open();
    const groupKey = `${QUEUE.rows[0].phaseKey}-${QUEUE.rows[0].taskKey}`;
    await click(`signoff-all-${groupKey}`);
    await type(`signoff-reason-${groupKey}`, REASON);
    await click(`signoff-bulk-${groupKey}`);
    await click('signoff-confirm-yes');
    await until(() => byId('signoff-result'), 'the batch answer');

    expect(batches()).toHaveLength(1);
    const sent = batches()[0].body as BulkSignoffBody;
    const accepted = ACCEPTED.requestBody as BulkSignoffBody;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(accepted).sort());
    expect({ ...sent, userIds: [...sent.userIds].sort() }).toEqual({ ...accepted, userIds: [...accepted.userIds].sort() });
    expect(ACCEPTED.status).toBe(200);
    const answered = ACCEPTED.body as { signedOff: string[] };
    expect(byId('signoff-result')!.textContent).toContain(`Signed off ${answered.signedOff.length} learners.`);
    // The page reads the queue again, and the API answered it empty.
    await until(() => byId('signoff-empty'), 'the empty queue after the batch');
    expect(queueReads().length).toBeGreaterThanOrEqual(2);
  });

  it('draws each refusal by the API’s own sentence', async () => {
    replay.answer('POST', ACCEPTED.path, [exchange('bulkAgain')]);
    replay.answer('GET', exchange('queue').path, [exchange('queue')]);
    await open();
    const groupKey = `${QUEUE.rows[0].phaseKey}-${QUEUE.rows[0].taskKey}`;
    await click(`signoff-all-${groupKey}`);
    await type(`signoff-reason-${groupKey}`, REASON);
    await click(`signoff-bulk-${groupKey}`);
    await click('signoff-confirm-yes');
    await until(() => byId('signoff-result'), 'the batch answer');
    const again = exchange('bulkAgain').body as { refused: { userId: string; sentence: string }[] };
    for (const one of again.refused) expect(byId(`signoff-refused-${one.userId}`)?.textContent).toBe(one.sentence);
  });

  it('a reason shorter than the API accepts keeps the batch from being sent: the API refused that very batch', async () => {
    const short = exchange('bulkShortReason');
    expect(short.status).toBe(400);
    const refused = short.requestBody as BulkSignoffBody;
    await open();
    const groupKey = `${refused.phaseKey}-${refused.taskKey}`;
    expect(groupKey).toBe(`${QUEUE.rows[0].phaseKey}-${QUEUE.rows[0].taskKey}`);
    await click(`signoff-all-${groupKey}`);
    await type(`signoff-reason-${groupKey}`, refused.reason);
    const go = byId<HTMLButtonElement>(`signoff-bulk-${groupKey}`)!;
    expect(go.disabled || go.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(byId(`signoff-bulk-${groupKey}-reason`)?.textContent ?? '').toMatch(/at least \d+ characters/);
    await act(async () => go.click());
    await settle(4);
    expect(byId('signoff-confirm-yes')).toBeNull();
    expect(batches()).toHaveLength(0);
    // The same task, learners and reason the page holds back are the batch the API refused.
    expect([...refused.userIds].sort()).toEqual(QUEUE.rows.map((row) => row.userId).sort());
  });

  it('vacuity: the accepted reason, in the same field, does send the batch', async () => {
    const refused = exchange('bulkShortReason').requestBody as BulkSignoffBody;
    await open();
    const groupKey = `${refused.phaseKey}-${refused.taskKey}`;
    await click(`signoff-all-${groupKey}`);
    await type(`signoff-reason-${groupKey}`, REASON);
    const go = byId<HTMLButtonElement>(`signoff-bulk-${groupKey}`)!;
    expect(go.disabled || go.getAttribute('aria-disabled') === 'true').toBe(false);
    await click(`signoff-bulk-${groupKey}`);
    await click('signoff-confirm-yes');
    await until(() => batches().length === 1, 'the batch');
  });

  it('an empty queue, as the API answers it after the batch, draws the empty state and no batch', async () => {
    replay.answer('GET', exchange('queue').path, [exchange('queueAfter')]);
    await act(async () => root.render(<TeacherPortal classView />));
    await until(() => byId('signoff-empty'), 'the empty queue');
    expect(host.querySelector('[data-testid^="signoff-task-"]')).toBeNull();
    expect(byId('signoff-queue')!.textContent).toContain('0 waiting');
  });

  // The portal's load effect depends on `router`, and a mock that hands out a
  // new router per render would re-run it on every render. As in Next, the
  // router is one object, so a mount loads once.
  it('harness: one router object, so the class page loads once per mount', async () => {
    await open();
    await settle(20);
    // The overview is read by the portal's own load and nothing else on the page.
    expect(replay.seen.filter((one) => one.method === 'GET' && one.path === '/instructor/overview')).toHaveLength(1);
  });
});
