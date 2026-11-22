// @vitest-environment jsdom
/**
 * Publishing moves nothing above the project page's section tabs.
 *
 * The read-only notice and an export's outcome sit under the tabs, the Publish
 * section's receipt says what was published, and the header's Export and
 * Preview stay while the project summary is read after a publish.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPORTED_STACKS_SENTENCE,
  summariseValidation,
  type DraftPhaseSetView,
  type DraftPhaseView,
  type DraftVersionView,
  type PhaseKey,
} from '@learnsdlc/shared';

const draft = vi.fn();
const files = vi.fn();
const validate = vi.fn();
const deepValidation = vi.fn();
const get = vi.fn();
const publish = vi.fn();
const exportVersion = vi.fn();
vi.mock('@/lib/api-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-projects')>()),
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    files: (...a: unknown[]) => files(...a),
    validate: (...a: unknown[]) => validate(...a),
    deepValidation: (...a: unknown[]) => deepValidation(...a),
    get: (...a: unknown[]) => get(...a),
    publish: (...a: unknown[]) => publish(...a),
    exportVersion: (...a: unknown[]) => exportVersion(...a),
    writeSealed: vi.fn(),
  },
}));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p-mine', versionId: 'v-mine' }),
  usePathname: () => '/teacher/projects/p-mine/versions/v-mine',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'a@b.c', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { settle } from './support/dom';

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const press = async (id: string) => {
  const el = q(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
  await settle(6);
};

beforeEach(() => {
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  deepValidation.mockResolvedValue(null);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const held = (key: PhaseKey): DraftPhaseSetView => ({ key, state: 'held', removeSource: 'held', canRemove: true, canPutBack: false, canAdd: false, why: null });
const phase = (key: PhaseKey, order: number, title: string): DraftPhaseView =>
  ({ key, order, title, intro: '', artifactKind: 'quiz', checkKind: 'quiz', tasks: [], blocksPublish: false }) as unknown as DraftPhaseView;
const PASSING = summariseValidation('fast', '2026-11-17T00:00:00.000Z', [
  { id: 'title-present', label: 'A title', status: 'passed', sentence: 'The project has a title.', phaseKey: null, taskKey: null, files: [] },
]);
function version(over: Partial<DraftVersionView> = {}): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'room-desk',
    title: 'RoomDesk',
    tagline: '',
    description: '',
    platformOwned: false,
    editable: true,
    phases: [phase('requirements', 1, 'Requirements')],
    validation: PASSING,
    supportedStacks: { python: [], node: [], tools: [], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-17T00:00:00.000Z',
    phaseSet: [held('requirements')],
    ...over,
  };
}
const mountEditor = async (view: DraftVersionView) => {
  draft.mockResolvedValue(view);
  await act(async () => root.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />));
  await settle(6);
};
/** The test ids drawn before the section tabs, in order: what a notice there would push. */
const aboveTabs = () => {
  const nav = q('editor-nav')!;
  return [...host.querySelectorAll<HTMLElement>('[data-testid]')]
    .filter((el) => el.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(nav))
    .map((el) => el.dataset.testid);
};
const after = (a: HTMLElement | null, b: HTMLElement | null) =>
  Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('publishing moves nothing above the section tabs', () => {
  it('draws the same header before and after Publish, with the receipt inside the Publish section', async () => {
    // The project summary is still being read when the receipt lands.
    get.mockReturnValue(new Promise(() => undefined));
    publish.mockResolvedValue({ version: '1.0.0', publishedAt: '2026-11-17T02:54:00.000Z', sandboxBudget: 8, validation: PASSING });
    await mountEditor(version());
    await press('project-section-publish');
    const before = aboveTabs();
    expect(before).toContain('project-export');
    expect(before).toContain('project-preview-open');

    await press('project-publish');
    await press('project-publish-confirm-yes');

    expect(q('project-status')!.textContent).toBe('Published 1.0.0');
    // Nothing came or went above the tabs: Export and Preview stayed while the summary is read.
    expect(aboveTabs()).toEqual(before);
    // The receipt is inside the Publish section, announced as a status.
    const receipt = q('project-published')!;
    expect(receipt.closest('[data-project-section="publish"]')).not.toBeNull();
    expect(receipt.getAttribute('role')).toBe('status');
    // On Publish the read-only reason is the receipt's to say: no second notice.
    expect(q('project-frozen-box')).toBeNull();
  });

  it('says why a version is read-only under the tabs in every other section', async () => {
    get.mockReturnValue(new Promise(() => undefined));
    await mountEditor(version({ status: 'published', editable: false, version: '1.0.0' }));
    const box = q('project-frozen-box');
    expect(box).not.toBeNull();
    expect(after(q('editor-nav'), box)).toBe(true);
    expect(box!.closest('[data-project-section]')).toBeNull();
    expect(q('project-frozen')!.textContent).toContain('1.0.0');
    await press('project-section-requirements');
    expect(after(q('editor-nav'), q('project-frozen-box'))).toBe(true);
    // On Publish the reason beside the button says it.
    await press('project-section-publish');
    expect(q('project-frozen-box')).toBeNull();
    expect(q('project-publish-reason')!.textContent).toContain('1.0.0');
  });

  it("draws an export's outcome under the tabs, never above them", async () => {
    exportVersion.mockResolvedValueOnce({ blob: new Blob(['zip']), withheld: 0 });
    await mountEditor(version());
    const before = aboveTabs();
    await press('project-export');
    const done = q('project-export-done');
    expect(done?.textContent).toContain('Saved room-desk-0.1.0.zip.');
    expect(after(q('editor-nav'), done)).toBe(true);
    expect(q('project-export-done-box')!.getAttribute('role')).toBe('status');
    expect(aboveTabs()).toEqual(before);

    exportVersion.mockRejectedValueOnce(new Error('The server did not answer.'));
    await press('project-export');
    expect(q('project-export-done')).toBeNull();
    const refusal = q('project-export-error-box');
    expect(refusal?.getAttribute('role')).toBe('alert');
    expect(after(q('editor-nav'), refusal)).toBe(true);
    expect(aboveTabs()).toEqual(before);
  });
});

