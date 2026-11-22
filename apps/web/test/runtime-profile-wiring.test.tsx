// @vitest-environment jsdom
/**
 * The runtime profile line on the upload door, drawn from what the API
 * answered in `apps/api/test/runtime-profile-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-exchanges/runtime-profile.json`).
 *
 * The real `UploadProject` (which reads the profile through the real
 * `projectsApi.runtimeProfile`) and the real `fetch`, pointed at a tiny HTTP
 * server on `127.0.0.1:0` that replays the recording
 * (`contract-exchanges/replay.ts`). Only the router is stood in for.
 *
 * A regression guard: the replay passes against the current line and route.
 * The vacuity proof is the last case: a profile whose list the API did not
 * answer draws a line that is not the recorded one.
 *
 * - The line names the API's three lists and the profile's name, before
 *   anything is uploaded, and shows the manifest digest only as a short
 *   prefix, never in full: the full digest is in the markup only as the
 *   prefix span's `title` (by design), and the check scans the markup, so a
 *   64-hex in any other attribute is red (with its own vacuity
 *   case). The replay serves the recording's `<sha256:N>`
 *   placeholder as a real-looking 64-hex digest (`withSyntheticDigests`), so
 *   a prefix and a full digest can be told apart.
 * - A refused read (a learner's 403) falls back to the contract's sentence.
 */
import { act, type ReactElement } from 'react';
import { waitUntil } from './support/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeProfileView } from '@learnsdlc/shared';
import { RUNTIME_PROFILES } from '@learnsdlc/shared';
import { readExchangeRecording, type Exchange } from './support/contract-fixtures';
import { startReplay, withSyntheticDigests, type Replay } from './support/contract-fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));

// Digests served as real-looking 64-hex (the recording holds `<sha256:N>`), so a prefix and a full digest differ.
const recording = withSyntheticDigests(readExchangeRecording('runtime-profile'));
const exchange = (name: string): Exchange => {
  const found = recording.exchanges.find((one) => one.name === name);
  if (!found) throw new Error(`no exchange ${name} in runtime-profile.json`);
  return found;
};
const PROFILE = exchange('profile');
const VIEW = PROFILE.body as RuntimeProfileView;

let replay: Replay;
let UploadProject: (props: { onClose: () => void }) => ReactElement;
let sentenceOf: (lists: Pick<RuntimeProfileView, 'python' | 'node' | 'tools'>) => string;
let host: HTMLDivElement;
let root: Root;

const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const until = (what: () => unknown, label: string) =>
  waitUntil(what, label, { tries: 80, tick: 10, detail: () => `misses: ${replay.misses.join(', ') || 'none'}` });
const reads = () => replay.seen.filter((one) => one.method === 'GET' && one.path === PROFILE.path);

beforeAll(async () => {
  replay = await startReplay(recording.exchanges);
  process.env.NEXT_PUBLIC_API_URL = replay.url;
  const session = await import('@/lib/session');
  session.setAuthSession('replay-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  UploadProject = (await import('@/components/staff/projects/UploadProject')).UploadProject as never;
  sentenceOf = (await import('@/components/staff/projects/RuntimeProfileLine')).runtimeProfileSentence;
});
afterAll(async () => {
  await replay?.close();
  delete process.env.NEXT_PUBLIC_API_URL;
});

beforeEach(() => {
  replay.seen.length = 0;
  replay.misses.length = 0;
  replay.answer('GET', PROFILE.path, [PROFILE]);
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
  await until(() => reads().length > 0, 'the profile read');
};

/**
 * The full digest is drawn nowhere on the page but in the prefix span's
 * `title` (by design: the hover shows it whole). The markup is scanned, not
 * only the text, so a 64-hex in any other attribute is caught.
 */
function expectDigestOnlyAsPrefix() {
  const allowed = `title="${VIEW.manifestSha256}"`;
  const page = document.body.innerHTML;
  // Exactly the one allowed attribute, on the prefix span ...
  expect(page.split(allowed)).toHaveLength(2);
  const prefix = byId('projects-upload-profile')!.querySelector(`[title="${VIEW.manifestSha256}"]`);
  expect(prefix?.textContent).toBe(VIEW.manifestSha256.slice(0, 12));
  // ... and no 64-hex anywhere else in the markup, text or attribute.
  expect(page.replace(allowed, '')).not.toMatch(/[0-9a-f]{64}/i);
}

describe('the runtime profile line, from the API recording', () => {
  it('names the API’s three lists and the profile, and the digest only as a prefix', async () => {
    await open();
    await until(() => byId('projects-upload-profile')?.textContent?.startsWith(sentenceOf(VIEW)), 'the line from the API’s lists');
    const line = byId('projects-upload-profile')!.textContent!;
    expect(reads()[0].authorization).toBe('Bearer replay-session');
    expect(line.startsWith(sentenceOf(VIEW))).toBe(true);
    for (const one of [...VIEW.python, ...VIEW.node, ...VIEW.tools]) expect(line).toContain(one);
    expect(line).toContain(`The profile is the ${VIEW.name}`);
    expect(VIEW.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(line).toContain(VIEW.manifestSha256.slice(0, 12));
    expect(line).not.toContain(VIEW.manifestSha256);
    expect(line).not.toMatch(/[0-9a-f]{64}/i);
    expectDigestOnlyAsPrefix();
    expect(replay.misses).toEqual([]);
  });

  it('a refused read falls back to the contract’s own sentence', async () => {
    replay.answer('GET', PROFILE.path, [exchange('profileLearner')]);
    await open();
    await until(() => byId('projects-upload-profile')?.textContent?.includes(RUNTIME_PROFILES[0].sentence), 'the fallback sentence');
    expect(byId('projects-upload-profile')!.textContent).toContain(RUNTIME_PROFILES[0].sentence);
  });

  it('vacuity: a list the API did not answer draws a line that is not the recorded one', async () => {
    const broken = { ...PROFILE, body: { ...VIEW, python: [...VIEW.python, 'not-baked'] } };
    replay.answer('GET', PROFILE.path, [broken]);
    await open();
    await until(() => byId('projects-upload-profile')?.textContent?.includes('not-baked'), 'the broken line');
    expect(byId('projects-upload-profile')!.textContent!.startsWith(sentenceOf(VIEW))).toBe(false);
  });

  it('vacuity: the full digest in any attribute but the prefix’s title turns the digest check red', async () => {
    await open();
    await until(() => byId('projects-upload-profile')?.textContent?.startsWith(sentenceOf(VIEW)), 'the line from the API’s lists');
    expectDigestOnlyAsPrefix();
    const line = byId('projects-upload-profile')!;
    line.setAttribute('aria-label', VIEW.manifestSha256);
    expect(() => expectDigestOnlyAsPrefix()).toThrow();
    line.removeAttribute('aria-label');
    expectDigestOnlyAsPrefix();
    // Another 64-hex, not the digest, in an attribute is caught as well.
    line.setAttribute('data-digest', 'e'.repeat(64));
    expect(() => expectDigestOnlyAsPrefix()).toThrow();
  });
});
