// @vitest-environment jsdom
/**
 * The editor's deep-validation panel against what the API answered in
 * `apps/api/test/deep-validation-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/deep-validation.json`).
 *
 * The real `DeepValidationPanel`, the real `projectsApi` and the real
 * `fetch`, pointed at a tiny HTTP server on `127.0.0.1:0` that replays the
 * recording (`contract-exchanges/replay.ts`). Nothing is mocked.
 *
 * A regression guard: the replay passes against the current panel and route.
 * The vacuity proof is the last case: a view whose warning names another
 * count makes the page send a body the API did not accept, and the same
 * comparison is red.
 *
 * - The cost warning, in microVMs, is drawn before Start can be pressed, and
 *   it is the API's own sentence.
 * - Start sends `acknowledgedMicroVMs` = the warned count: the body the API
 *   accepted (202).
 * - The settled view draws the four checks by the API's sentences.
 * - A stale start's refusal is the API's sentence, as plain text.
 * - No sealed byte of the fixture and no digest is drawn. The replay serves the
 *   recording's `<sha256:N>` placeholders as real-looking 64-hex digests
 *   (`withSyntheticDigests`), so a drawn digest would show. The markup is
 *   scanned as well as the text, so a digest in an attribute shows too
 *   (with an in-DOM vacuity step).
 */
import { act, type ReactElement } from 'react';
import { waitUntil } from './support/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepValidationStartBody, DeepValidationView } from '@learnsdlc/shared';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';
import { startReplay, withSyntheticDigests, type Replay } from './support/contract-fixtures';
import { loadShelfMarkers } from './support/contract-fixtures';

// The API's fixtures, loaded at run time (test/support/api-fixtures.ts says why).
const ALL_SHELF_MARKERS = await loadShelfMarkers();

// Digests served as real-looking 64-hex (the recording holds `<sha256:N>`), so a drawn digest would show.
const recording = withSyntheticDigests(readExchangeRecording('deep-validation'));
const exchange = (name: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name} in deep-validation.json`);
  return found;
};
const PROJECT = recording.facts.projectId as string;
const VERSION = recording.facts.versionId as string;
const NOT_RUN = exchange('readNotRun');
const SETTLED = exchange('readSettled');
const START = exchange('start');
const STALE = exchange('startStale');

type Panel = (props: { projectId: string; versionId: string; editable: boolean }) => ReactElement;
let replay: Replay;
let DeepValidationPanel: Panel;
let POLL_MS = 4000;
let host: HTMLDivElement;
let root: Root;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const until = (what: () => unknown, label: string, tries = 120) =>
  waitUntil(what, label, { tries: tries, tick: 50, detail: () => `misses: ${replay.misses.join(', ') || 'none'}` });
const starts = () => replay.seen.filter((one) => one.method === 'POST' && one.path === START.path);

beforeAll(async () => {
  replay = await startReplay(recording.exchanges);
  process.env.NEXT_PUBLIC_API_URL = replay.url;
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  const panel = await import('@/components/staff/projects/DeepValidationPanel');
  DeepValidationPanel = panel.DeepValidationPanel as unknown as Panel;
  POLL_MS = panel.DEEP_VALIDATION_POLL_MS;
});
afterAll(async () => {
  await replay?.close();
  delete process.env.NEXT_PUBLIC_API_URL;
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  replay.seen.length = 0;
  replay.misses.length = 0;
  replay.answer('GET', NOT_RUN.path, [NOT_RUN, NOT_RUN, SETTLED]);
  replay.answer('POST', START.path, [START]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const open = async () => {
  await act(async () => root.render(<DeepValidationPanel projectId={PROJECT} versionId={VERSION} editable />));
  await until(() => byId('deep-validation-status')?.textContent?.includes('Not run'), 'the view before a run');
  // Before the cost warning is drawn there is no Start to press.
  expect(byId('deep-validation-warning')).toBeNull();
  expect(byId('deep-validation-start')).toBeNull();
  await act(async () => byId<HTMLButtonElement>('deep-validation-open')!.click());
  await until(() => byId('deep-validation-warning'), 'the cost warning');
};

/**
 * No digest in the page's markup, attributes included:
 * the text-only check above cannot see a digest drawn in a `title` or
 * `aria-label`. The panel draws no digest at all, so nothing is allowed.
 */
function expectNoDigestInMarkup(digest: string) {
  const markup = document.body.innerHTML;
  expect(markup).not.toContain(digest);
  expect(markup).not.toMatch(/[0-9a-f]{64}/i);
}

/** What the page sent, set beside what the API accepted. */
const sentAndAccepted = () => ({
  sent: starts()[0]?.body as DeepValidationStartBody | undefined,
  accepted: START.requestBody as DeepValidationStartBody,
});

describe('deep validation, from the API recording', () => {
  it('draws the API’s cost warning before Start, sends the warned count the API accepted, and draws the settled checks', async () => {
    await open();
    const view = NOT_RUN.body as DeepValidationView;
    expect(byId('deep-validation-warning')!.textContent).toBe(view.costWarning.sentence);
    expect(byId('deep-validation-warning')!.textContent).toContain(`${view.costWarning.microVMs} microVMs`);
    expect(starts()).toHaveLength(0);
    await act(async () => byId<HTMLButtonElement>('deep-validation-start')!.click());
    await until(() => starts().length === 1, 'the start');
    const { sent, accepted } = sentAndAccepted();
    expect(sent).toEqual(accepted);
    expect(sent!.acknowledgedMicroVMs).toBe(view.costWarning.microVMs);
    expect(START.status).toBe(202);
    expect(starts()[0].authorization).toBe('Bearer replay-session');

    // A run in flight is read again on the panel's poll; the API answered it settled.
    await until(() => byId('deep-validation-status')?.textContent?.startsWith('Passed'), 'the settled view', Math.ceil((POLL_MS + 3000) / 50));
    const settled = SETTLED.body as DeepValidationView;
    for (const check of settled.checks) {
      expect(byId(`deep-validation-check-${check.id}`)!.textContent).toContain(check.sentence);
    }
    expect(replay.misses).toEqual([]);

    // Nothing sealed, and no digest, is drawn.
    const page = document.body.textContent ?? '';
    expect(ALL_SHELF_MARKERS.filter((marker) => page.includes(marker))).toEqual([]);
    expect(String(settled.contentDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(page).not.toContain(String(settled.contentDigest));
    expect(page).not.toContain(String(settled.contentDigest).slice(0, 12));
    expect(page).not.toMatch(/[0-9a-f]{64}/i);
    expectNoDigestInMarkup(String(settled.contentDigest));
    // Vacuity: the digest in an attribute, which the text never shows, turns the check red.
    const check = byId(`deep-validation-check-${settled.checks[0].id}`)!;
    check.setAttribute('aria-label', String(settled.contentDigest));
    expect(() => expectNoDigestInMarkup(String(settled.contentDigest))).toThrow();
    check.removeAttribute('aria-label');
    expectNoDigestInMarkup(String(settled.contentDigest));
  }, 20000);

  it('a stale start is refused by the API’s own sentence, drawn as plain text', async () => {
    replay.answer('POST', START.path, [STALE]);
    replay.answer('GET', NOT_RUN.path, [NOT_RUN]);
    await open();
    await act(async () => byId<HTMLButtonElement>('deep-validation-start')!.click());
    await until(() => byId('deep-validation-error'), 'the refusal');
    const sentence = (STALE.body as { message: string }).message;
    expect(byId('deep-validation-error')!.textContent).toBe(sentence);
    expect(byId('deep-validation-error')!.children).toHaveLength(0);
  });

  it('vacuity: a view warning another count makes the page send a body the API did not accept', async () => {
    const view = NOT_RUN.body as DeepValidationView;
    const other = view.costWarning.microVMs + 1;
    const broken = { ...NOT_RUN, body: { ...view, costWarning: { microVMs: other, sentence: view.costWarning.sentence.replace(String(view.costWarning.microVMs), String(other)) } } };
    replay.answer('GET', NOT_RUN.path, [broken]);
    await open();
    await act(async () => byId<HTMLButtonElement>('deep-validation-start')!.click());
    await until(() => starts().length === 1, 'the start');
    const { sent, accepted } = sentAndAccepted();
    expect(sent).not.toEqual(accepted);
  });
});
