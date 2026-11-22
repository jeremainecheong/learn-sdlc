// @vitest-environment jsdom
/**
 * An upload answer that carries no contract code never says the archive is
 * wrong.
 *
 * The guide (docs/teacher-project-upload.md section 2) promises that when the
 * answer carries no reason the page "never says your archive is wrong, because
 * nothing in such an answer says so". So a no-code 4xx/5xx (a 500, a 400 or
 * 404 without a code) must not say "Check that the archive is a project in
 * the authoring layout and upload it again.", sending the teacher to the
 * archive for a server fault. It says only that the upload did not finish
 * and nothing was imported, with the neutral `UPLOAD_REFUSAL_FALLBACK` under
 * it.
 *
 * For each no-code status (0, 401, 403, 429, 500) the sentence the page shows
 * holds the guide's claim. The 0 (no answer in
 * time) and 429 (pace) sentences may still tell the teacher to upload the
 * archive again, which is advice, not blame; the no-code 4xx/5xx sentence does
 * not mention the archive at all.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeProfileView } from '@learnsdlc/shared';
import { SUPPORTED_STACKS_SENTENCE, UPLOAD_REFUSAL_FALLBACK, UPLOAD_REFUSALS } from '@learnsdlc/shared';

const upload = vi.fn();
const runtimeProfile = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    upload: (...args: unknown[]) => upload(...args),
    runtimeProfile: (...args: unknown[]) => runtimeProfile(...args),
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError } from '@/lib/api';
import { UploadProject, uploadFailureSentence } from '@/components/staff/projects/UploadProject';
import { typeInto, waitUntil } from './support/dom';

const PROFILE: RuntimeProfileView = {
  id: 'baked',
  name: 'Baked runtime',
  manifestSha256: 'a'.repeat(64),
  python: ['flask', 'pytest'],
  node: ['react'],
  tools: ['esbuild'],
  sentence: SUPPORTED_STACKS_SENTENCE,
};

/** What a server-side answer might carry; it must never reach the page. */
const MARKER = 'SERVER-MARKER-51c9';
/** Words that say the archive is at fault. */
const BLAMES_ARCHIVE = /check that the archive|authoring (layout|format)|not a project|archive is (wrong|not|damaged|broken)/i;
const NO_CODE_SENTENCE = 'The upload did not finish, and nothing was imported.';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const saidAboutAnswer = () => `${byId('projects-upload-refusal')?.textContent ?? ''} ${byId('upload-refusal-help')?.textContent ?? ''}`;

beforeEach(() => {
  vi.clearAllMocks();
  runtimeProfile.mockResolvedValue(PROFILE);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function refusedWith(error: unknown) {
  upload.mockRejectedValue(error);
  await act(async () => root?.render(<UploadProject onClose={() => undefined} />));
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  const title = byId('projects-upload-title') as HTMLInputElement;
  await act(async () => {
    typeInto(title, 'Books on a shelf');
  });
  const picker = byId('projects-upload-file') as HTMLInputElement;
  Object.defineProperty(picker, 'files', {
    configurable: true,
    value: [new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'books.zip', { type: 'application/zip' })],
  });
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => (byId('projects-upload-submit') as HTMLButtonElement).click());
  await waitUntil(() => byId('projects-upload-refusal'), 'the refusal', { tries: 50, tick: 5 });
}

describe('a no-code answer never says the archive is wrong', () => {
  it.each([0, 401, 403, 429, 500])('status %i: the sentence holds the guide’s claim', (status) => {
    const message = status === 401 ? 'Your session ended. Sign in again.' : status === 403 ? 'Only a teacher can upload a project.' : `server says ${MARKER}`;
    const said = uploadFailureSentence(new ApiError(status, message));
    expect(said).not.toMatch(BLAMES_ARCHIVE);
    expect(said).not.toContain(MARKER);
  });

  it('a no-code 4xx or 5xx says the upload did not finish, and says nothing about the archive', () => {
    for (const status of [400, 404, 409, 422, 428, 430, 500, 502, 503]) {
      const said = uploadFailureSentence(new ApiError(status, `server says ${MARKER}`));
      expect([status, said]).toEqual([status, NO_CODE_SENTENCE]);
      expect([status, /archive/i.test(said)]).toEqual([status, false]);
    }
  });

  it.each([
    ['a 500 with no code', new ApiError(500, `server says ${MARKER}`, undefined, { statusCode: 500, message: `boom ${MARKER}` })],
    ['a 400 with no code', new ApiError(400, `server says ${MARKER}`, undefined, { statusCode: 400, message: `bad ${MARKER}` })],
  ])('%s: the page shows the sentence and the neutral fallback, and blames nothing', async (_label, error) => {
    await refusedWith(error);
    expect(byId('projects-upload-refusal-sentence')?.textContent).toBe(NO_CODE_SENTENCE);
    expect(byId('projects-upload-refusal-detail')).toBeNull();
    expect(byId('upload-refusal-help-title')?.textContent).toBe(UPLOAD_REFUSAL_FALLBACK.title);
    expect(byId('upload-refusal-help-fix')?.textContent).toBe(UPLOAD_REFUSAL_FALLBACK.fix);
    // What the page says about this answer: the alert and the help under it
    // (the door's own purpose line describes the layout, and is not about this answer).
    expect(saidAboutAnswer()).not.toMatch(BLAMES_ARCHIVE);
    expect(host!.innerHTML).not.toContain(MARKER);
  });

  it('vacuity: an answer that carries a code still shows that code’s sentence, which may name the archive', async () => {
    await refusedWith(new ApiError(400, 'x', undefined, { code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, findings: [] }));
    expect(byId('projects-upload-refusal-sentence')?.textContent).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
    expect(saidAboutAnswer()).toMatch(BLAMES_ARCHIVE);
  });
});
