// @vitest-environment jsdom
/**
 * On the first Upload a project after a page load, the runtime profile line
 * arrives a second or two after the form opens, above Title, and would push
 * Title and the buttons 63 px down under the caret. The line's place is held
 * from the first frame: an invisible copy of a whole line (today's baked
 * lists) under it, in the same grid cell, and while the read is going the line
 * says so. The line that arrives (or, after a failed read, the contract's own
 * sentence) is drawn in that place.
 *
 * jsdom has no layout: a window size is `innerHeight`, a place is a mocked
 * rectangle, and a scroll is the `scrollIntoView` call the page makes.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredProjectSummary, AuthoringLibraryView, RuntimeProfileView } from '@learnsdlc/shared';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  upload: vi.fn(),
  runtimeProfile: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    list: (...args: unknown[]) => m.list(...args),
    create: (...args: unknown[]) => m.create(...args),
    upload: (...args: unknown[]) => m.upload(...args),
    runtimeProfile: (...args: unknown[]) => m.runtimeProfile(...args),
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: m.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/staff/guide/StartHere', () => ({ StartHere: () => null }));
vi.mock('@/components/staff/guide/DownloadHistory', () => ({ DownloadHistory: () => null }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'teacher-one', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));

import { RUNTIME_PROFILES, SUPPORTED_STACKS_SENTENCE } from '@learnsdlc/shared';
import { ProjectsLibrary } from '@/components/staff/projects/ProjectsLibrary';
import { RUNTIME_PROFILE_READING, runtimeProfileSentence } from '@/components/staff/projects/RuntimeProfileLine';
import { settle, typeInto } from './support/dom';

/** The profile this deployment answers today (twelve Python packages, six Node, esbuild). */
const TODAY: RuntimeProfileView = {
  id: 'baked',
  name: 'Baked runtime',
  manifestSha256: '91448f65fabb'.padEnd(64, '0'),
  python: ['blinker', 'click', 'flask', 'iniconfig', 'itsdangerous', 'jinja2', 'markupsafe', 'packaging', 'pluggy', 'pygments', 'pytest', 'werkzeug'],
  node: ['@testing-library/dom', '@testing-library/react', 'jsdom', 'react', 'react-dom', 'react-router-dom'],
  tools: ['esbuild'],
  sentence: SUPPORTED_STACKS_SENTENCE,
};

function project(over: Partial<AuthoredProjectSummary> = {}): AuthoredProjectSummary {
  return {
    id: 'p-default',
    slug: 'tasktrackr',
    title: 'TaskTrackr',
    platformOwned: true,
    mine: false,
    isDefault: true,
    origin: 'seed',
    publishedVersion: '6.0.0',
    publishedVersionId: 'v-default',
    draftVersion: null,
    draftVersionId: null,
    cohortsUsing: 3,
    lastValidatedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}
const VIEW: AuthoringLibraryView = {
  mine: [project({ id: 'p-mine', slug: 'mine-0', title: 'Mine 0', platformOwned: false, mine: true, isDefault: false, origin: 'fork', publishedVersion: '1.0.0', publishedVersionId: 'v-mine-0' })],
  library: [project()],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrolls: { on: string; options: unknown }[] = [];
const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');

const label = (el: Element) =>
  el.getAttribute('data-testid') ?? el.querySelector('[data-testid]')?.getAttribute('data-testid') ?? el.tagName.toLowerCase();

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  scrolls = [];
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = function (this: Element, options?: unknown) {
    scrolls.push({ on: label(this), options });
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  if (innerHeight) Object.defineProperty(window, 'innerHeight', innerHeight);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? document.activeElement?.tagName.toLowerCase();


async function mount() {
  m.list.mockResolvedValue(VIEW);
  await act(async () => {
    root?.render(<ProjectsLibrary />);
  });
  await settle(5);
}

async function press(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

/** A read the test answers when it chooses. */
function deferred() {
  let answer: (value: RuntimeProfileView | null) => void = () => undefined;
  let refuse: (reason: unknown) => void = () => undefined;
  const promise = new Promise<RuntimeProfileView | null>((yes, no) => {
    answer = yes;
    refuse = no;
  });
  return { promise, answer, refuse };
}

/**
 * The form's shape with the profile line's own words left out: every element
 * in order (tag, test id, and the place-holding classes), so a field, a row or
 * a line that came or went, or a cell that moved, changes it.
 */
function shape(form: HTMLElement): string[] {
  const line = form.querySelector('[data-testid="projects-upload-profile"]');
  return Array.from(form.querySelectorAll('*'))
    .filter((el) => !line?.contains(el) || el === line)
    .map((el) => `${el.tagName.toLowerCase()}#${el.getAttribute('data-testid') ?? ''}${el.className && typeof el.className === 'string' && /row-start-1/.test(el.className) ? `.${el.className}` : ''}`);
}

/** The fields and controls a person uses, in order. */
const FIELDS = ['projects-upload-title', 'projects-upload-file', 'projects-upload-size', 'projects-upload-submit', 'projects-upload-cancel'];
const fieldsInOrder = (form: HTMLElement) =>
  Array.from(form.querySelectorAll('[data-testid]'))
    .map((el) => el.getAttribute('data-testid')!)
    .filter((id) => FIELDS.includes(id));

describe('the profile line holds its place from the first frame', () => {
  async function openWithRead() {
    const read = deferred();
    m.runtimeProfile.mockReturnValue(read.promise);
    await mount();
    await press('projects-upload-open');
    const form = byId('projects-upload')!;
    expect(form).not.toBeNull();
    return { read, form };
  }

  function expectPlaceHeld(form: HTMLElement) {
    const place = byId('projects-upload-profile-place')!;
    expect(place, 'the place is drawn').not.toBeNull();
    expect(byId('projects-upload-profile-box')!.contains(place)).toBe(true);
    // One grid cell: the invisible whole line and the drawn line stacked in it, the taller one setting its height.
    expect(place.className.split(' ')).toEqual(expect.arrayContaining(['grid', 'grid-cols-[minmax(0,1fr)]']));
    expect(place.children).toHaveLength(2);
    const [held, shown] = Array.from(place.children) as HTMLElement[];
    expect(held.getAttribute('aria-hidden')).toBe('true');
    expect(held.className.split(' ')).toEqual(expect.arrayContaining(['invisible', 'col-start-1', 'row-start-1', 'wrap', 'text-[12.5px]']));
    expect(shown.className.split(' ')).toEqual(expect.arrayContaining(['col-start-1', 'row-start-1']));
    expect(shown.contains(byId('projects-upload-profile'))).toBe(true);
    // The held line is a whole line of today's lists, character for character as long as the one that arrives.
    expect(held.textContent).toBe(
      `${runtimeProfileSentence(TODAY)} The profile is the Baked runtime, sha256 of the baked allow-lists (python, node, tools) 000000000000.`,
    );
    expect(form.contains(place)).toBe(true);
    return held;
  }

  it('a fast read: the line says it is reading, then the profile arrives in the same place; nothing else changes', async () => {
    const { read, form } = await openWithRead();
    expect(focused()).toBe('projects-upload-title');
    const held = expectPlaceHeld(form);
    expect(byId('projects-upload-profile')!.textContent).toBe(RUNTIME_PROFILE_READING);
    const before = shape(form);
    const order = fieldsInOrder(form);
    expect(order).toEqual(FIELDS);
    await act(async () => read.answer(TODAY));
    await settle(5);
    const line = byId('projects-upload-profile')!.textContent!;
    expect(line.startsWith(runtimeProfileSentence(TODAY))).toBe(true);
    expect(line).toHaveLength(held.textContent!.length);
    expect(shape(form)).toEqual(before);
    expect(fieldsInOrder(form)).toEqual(order);
    expectPlaceHeld(form);
    expect(focused()).toBe('projects-upload-title');
    expect(scrolls).toEqual([]);
  });

  it('a slow read: typing in Title before it arrives keeps the caret and the words, and the form keeps its shape', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { read, form } = await openWithRead();
    const title = byId('projects-upload-title') as HTMLInputElement;
    await act(async () => {
      typeInto(title, 'Deadline badge');
    });
    const before = shape(form);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(byId('projects-upload-profile')!.textContent).toBe(RUNTIME_PROFILE_READING);
    await act(async () => read.answer(TODAY));
    await settle(5);
    expect(byId('projects-upload-profile')!.textContent!.startsWith(runtimeProfileSentence(TODAY))).toBe(true);
    expect(shape(form)).toEqual(before);
    expect(focused()).toBe('projects-upload-title');
    expect((byId('projects-upload-title') as HTMLInputElement).value).toBe('Deadline badge');
    expect(scrolls).toEqual([]);
  });

  it("a failed read: the contract's own sentence, in the same place", async () => {
    const { read, form } = await openWithRead();
    const before = shape(form);
    await act(async () => read.refuse(new Error('no answer')));
    await settle(5);
    // What a failed read draws, word for word.
    expect(byId('projects-upload-profile')!.textContent).toBe(`${RUNTIME_PROFILES[0].sentence} The profile is the Baked runtime.`);
    expect(RUNTIME_PROFILES[0].sentence).toBe(SUPPORTED_STACKS_SENTENCE);
    expectPlaceHeld(form);
    expect(shape(form)).toEqual(before);
    expect(fieldsInOrder(form)).toEqual(FIELDS);
    expect(focused()).toBe('projects-upload-title');
  });

  it('an empty answer reads as a failed one', async () => {
    const { read } = await openWithRead();
    await act(async () => read.answer(null));
    await settle(5);
    expect(byId('projects-upload-profile')!.textContent).toBe(`${SUPPORTED_STACKS_SENTENCE} The profile is the Baked runtime.`);
  });
});
