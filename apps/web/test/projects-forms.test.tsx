// @vitest-environment jsdom
/**
 * The forms of the Projects page open where the person can see them.
 *
 * On 18 Nov the teacher pass pressed Upload a project on an account with 148
 * projects of its own and saw nothing: the form was drawn under the whole list,
 * about 17,800 px down, and a second press did nothing more. Now each of the
 * three doors (Upload a project, New project, a row's Copy into a new project)
 * draws its form at the head of "Your projects", under the doors, brings it
 * into view when its first field is out of sight, and puts the focus in that
 * field in the same tick. Closing gives the focus back to the control that
 * opened the form. A person who opens no form sees exactly the page they saw
 * before (held by a file snapshot of the column's markup for each account).
 *
 * jsdom has no layout: "out of view" is a mocked rectangle, and the scroll is
 * the `scrollIntoView` call the page makes (recorded with the element it was
 * made on and its options).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredProjectSummary, AuthoringLibraryView } from '@learnsdlc/shared';

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
// The left column reads the guide's own APIs; it is not what these tests are about.
vi.mock('@/components/staff/guide/StartHere', () => ({ StartHere: () => null }));
vi.mock('@/components/staff/guide/DownloadHistory', () => ({ DownloadHistory: () => null }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'teacher-one', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));

import { UPLOAD_REFUSALS } from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import { ProjectsLibrary } from '@/components/staff/projects/ProjectsLibrary';
import { returnFocus, revealForm, whollyInView } from '@/components/staff/projects/reveal-form';
import { namedMarkup } from './support/markup-snapshot';
import { settle, typeInto } from './support/dom';

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

/** `n` projects of the teacher's own, each published (so each row has a Copy door). */
function mine(n: number): AuthoredProjectSummary[] {
  return Array.from({ length: n }, (_, at) =>
    project({
      id: `p-mine-${at}`,
      slug: `mine-${at}`,
      title: `Mine ${at}`,
      platformOwned: false,
      mine: true,
      isDefault: false,
      origin: 'fork',
      publishedVersion: '1.0.0',
      publishedVersionId: `v-mine-${at}`,
      cohortsUsing: 1,
    }),
  );
}

const LIBRARY = [project(), project({ id: 'p-desk', slug: 'library-desk', title: 'Library Desk', platformOwned: false, isDefault: false, publishedVersion: '1.0.0', publishedVersionId: 'v-desk', cohortsUsing: 0 })];
const view = (n: number): AuthoringLibraryView => ({ mine: mine(n), library: LIBRARY });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every `scrollIntoView` the page made: the element's test id (or the test id inside it) and the options. */
let scrolls: { on: string; options: unknown }[] = [];
/** Test ids whose rectangle sits far below the window (5,000 px down). */
let far = new Set<string>();

const label = (el: Element) =>
  el.getAttribute('data-testid') ?? el.querySelector('[data-testid]')?.getAttribute('data-testid') ?? el.tagName.toLowerCase();

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  m.runtimeProfile.mockResolvedValue(null);
  scrolls = [];
  far = new Set();
  // jsdom has no scrollIntoView; the page must call it only where a browser has one.
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = function (this: Element, options?: unknown) {
    scrolls.push({ on: label(this), options });
  };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = far.has(this.getAttribute('data-testid') ?? '') ? 5000 : 100;
    return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? document.activeElement?.tagName.toLowerCase();


async function mount(next: AuthoringLibraryView) {
  m.list.mockResolvedValue(next);
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

/** What the right-hand column draws: "Your projects" and "The library", as markup. */
const column = () => `${byId('projects-list')?.outerHTML ?? ''}\n${byId('projects-library')?.outerHTML ?? ''}`;

/** Whether `id` comes before `other` in document order (both must be drawn). */
function before(id: string, other: string): boolean {
  const a = byId(id);
  const b = byId(other);
  expect(a, `${id} drawn`).not.toBeNull();
  expect(b, `${other} drawn`).not.toBeNull();
  return Boolean(a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** The file snapshot of the right column with no form open, for an account with `n` projects of its own. */
const noFormSnapshot = (n: number) => `__snapshots__/projects-column-${n}-projects.html`;

describe('a person who opens no form sees the page its snapshot holds', () => {
  for (const n of [0, 3, 150]) {
    it(`${n} projects of their own: the same markup, nothing focused, nothing scrolled`, async () => {
      await mount(view(n));
      const parts = { 'Your projects': byId('projects-list')?.outerHTML ?? '', 'The library': byId('projects-library')?.outerHTML ?? '' };
      await expect(namedMarkup(parts)).toMatchFileSnapshot(noFormSnapshot(n));
      expect(byId('projects-upload')).toBeNull();
      expect(byId('projects-new-form')).toBeNull();
      expect(scrolls).toEqual([]);
      expect(document.activeElement).toBe(document.body);
    });
  }

  it('opening and closing each form leaves the markup as it was before the press', async () => {
    await mount(view(3));
    const was = column();
    await press('projects-upload-open');
    await press('projects-upload-cancel');
    expect(column()).toBe(was);
    await press('projects-new');
    await press('projects-new-cancel');
    expect(column()).toBe(was);
  });
});

describe('Upload a project', () => {
  for (const n of [0, 3, 150]) {
    it(`${n} projects: the form opens under the doors, before the list, with the focus in Title`, async () => {
      await mount(view(n));
      await press('projects-upload-open');
      const form = byId('projects-upload');
      expect(form).not.toBeNull();
      // Inside "Your projects", under its head and its doors, above every row.
      expect(byId('projects-list')!.contains(form)).toBe(true);
      expect(before('projects-upload-open', 'projects-upload')).toBe(true);
      expect(before('projects-upload', n === 0 ? 'projects-empty' : 'projects-row-mine-0')).toBe(true);
      expect(before('projects-upload', 'projects-library')).toBe(true);
      expect(focused()).toBe('projects-upload-title');
      // Title already in view: nothing scrolls.
      expect(scrolls).toEqual([]);
    });
  }

  it('Title out of view: the form is scrolled to, instantly, and Title takes the focus', async () => {
    await mount(view(150));
    far.add('projects-upload-title');
    await press('projects-upload-open');
    expect(scrolls).toEqual([{ on: 'projects-upload', options: { block: 'start', inline: 'nearest', behavior: 'instant' } }]);
    expect(focused()).toBe('projects-upload-title');
  });

  it('a second press while it is open brings it into view again and puts the focus back in Title', async () => {
    await mount(view(150));
    await press('projects-upload-open');
    (byId('projects-upload-file') as HTMLInputElement).focus();
    far.add('projects-upload-title');
    await press('projects-upload-open');
    expect(byId('projects-upload')).not.toBeNull();
    expect(focused()).toBe('projects-upload-title');
    expect(scrolls).toEqual([{ on: 'projects-upload', options: { block: 'start', inline: 'nearest', behavior: 'instant' } }]);
  });

  it('Cancel closes it and gives the focus back to Upload a project', async () => {
    await mount(view(3));
    await press('projects-upload-open');
    await press('projects-upload-cancel');
    expect(byId('projects-upload')).toBeNull();
    expect(focused()).toBe('projects-upload-open');
  });

  it('a finished upload that stays on the page gives the focus back to its door, and so does its Close', async () => {
    m.upload.mockResolvedValue({ projectId: 'p1', versionId: 'v1', slug: 'books', version: '0.1.0', warnings: ['A change.'] });
    await mount(view(3));
    await press('projects-upload-open');
    const title = byId('projects-upload-title') as HTMLInputElement;
    await act(async () => {
      typeInto(title, 'Books on a shelf');
    });
    const file = byId('projects-upload-file') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(file, 'files', { configurable: true, value: [new File([new Uint8Array([80, 75, 5, 6])], 'p.zip')] });
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-warnings')).not.toBeNull();
    expect(m.push).not.toHaveBeenCalled();
    expect(focused()).toBe('projects-upload-open');
    (byId('projects-upload-done') as HTMLButtonElement).focus();
    await press('projects-upload-done');
    expect(byId('projects-upload')).toBeNull();
    expect(focused()).toBe('projects-upload-open');
  });

  /*
   * The upload's answer comes from the network, a moment the person did not
   * cause. The focus goes back to the door only from the upload form or from
   * nowhere; a teacher typing in the copy form by then keeps the caret.
   */
  async function sendUploadWithWarnings(): Promise<() => Promise<void>> {
    let answer: (value: unknown) => void = () => undefined;
    m.upload.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await press('projects-upload-open');
    const title = byId('projects-upload-title') as HTMLInputElement;
    await act(async () => {
      typeInto(title, 'Books on a shelf');
    });
    const file = byId('projects-upload-file') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(file, 'files', { configurable: true, value: [new File([new Uint8Array([80, 75, 5, 6])], 'p.zip')] });
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press('projects-upload-submit');
    await settle(5);
    expect(m.upload).toHaveBeenCalledTimes(1);
    return async () => {
      await act(async () => {
        answer({ projectId: 'p1', versionId: 'v1', slug: 'books', version: '0.1.0', warnings: ['A change.'] });
      });
      await settle(5);
      expect(byId('projects-upload-warnings')).not.toBeNull();
    };
  }

  it('an upload with warnings that answers while the teacher types in the copy form leaves the caret in its Title', async () => {
    await mount(view(3));
    const answer = await sendUploadWithWarnings();
    await press('projects-new');
    const copyTitle = byId('projects-new-title') as HTMLInputElement;
    expect(focused()).toBe('projects-new-title');
    await act(async () => {
      typeInto(copyTitle, 'My cou');
    });
    await answer();
    expect(focused()).toBe('projects-new-title');
    expect((byId('projects-new-title') as HTMLInputElement).value).toBe('My cou');
    expect(scrolls).toEqual([]);
  });

  it('an upload with warnings that answers with the focus nowhere gives it to the door', async () => {
    await mount(view(3));
    const answer = await sendUploadWithWarnings();
    // The focused control went away (a browser blurs a button the busy upload disables): the focus is on the body.
    const gone = document.createElement('button');
    document.body.append(gone);
    gone.focus();
    gone.remove();
    expect(document.activeElement).toBe(document.body);
    await answer();
    expect(focused()).toBe('projects-upload-open');
  });

  /*
   * A refused upload is a network answer too. The refusal takes the focus only
   * from the upload form or from nowhere, decided in the frame the focus would
   * move in; it is drawn (and, as role="alert", announced) either way.
   */
  async function sendUploadRefused(): Promise<() => Promise<void>> {
    let refuse: (reason: unknown) => void = () => undefined;
    m.upload.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    await press('projects-upload-open');
    const title = byId('projects-upload-title') as HTMLInputElement;
    await act(async () => {
      typeInto(title, 'Books on a shelf');
    });
    const file = byId('projects-upload-file') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(file, 'files', { configurable: true, value: [new File([new Uint8Array([80, 75, 5, 6])], 'p.zip')] });
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // The teacher presses Upload as a draft: the focus is on it.
    (byId('projects-upload-submit') as HTMLButtonElement).focus();
    await press('projects-upload-submit');
    await settle(5);
    expect(m.upload).toHaveBeenCalledTimes(1);
    return async () => {
      await act(async () => {
        refuse(new ApiError(422, 'x', undefined, { code: 'NOT_A_ZIP', sentence: UPLOAD_REFUSALS.NOT_A_ZIP, findings: [] }));
      });
      await settle(5);
      // Past the animation frame the focus would move in.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 40));
      });
      expect(byId('projects-upload-refusal-sentence')?.textContent).toBe(UPLOAD_REFUSALS.NOT_A_ZIP);
      expect(byId('projects-upload-refusal')?.getAttribute('role')).toBe('alert');
    };
  }

  it('a refused upload with only the upload form open gives the focus to the refusal', async () => {
    await mount(view(3));
    const answer = await sendUploadRefused();
    expect(byId('projects-new-form')).toBeNull();
    await answer();
    expect(focused()).toBe('projects-upload-refusal');
  });

  it('a refused upload that answers while the teacher types in the copy form leaves the caret in its Title', async () => {
    await mount(view(3));
    const answer = await sendUploadRefused();
    await press('projects-new');
    const copyTitle = byId('projects-new-title') as HTMLInputElement;
    expect(focused()).toBe('projects-new-title');
    await act(async () => {
      typeInto(copyTitle, 'My cou');
    });
    await answer();
    expect(focused()).toBe('projects-new-title');
    expect((byId('projects-new-title') as HTMLInputElement).value).toBe('My cou');
    expect(scrolls).toEqual([]);
  });

  it('a refused upload that answers with the focus nowhere gives it to the refusal', async () => {
    await mount(view(3));
    const answer = await sendUploadRefused();
    const gone = document.createElement('button');
    document.body.append(gone);
    gone.focus();
    gone.remove();
    expect(document.activeElement).toBe(document.body);
    await answer();
    expect(focused()).toBe('projects-upload-refusal');
  });
});

describe('New project and Copy into a new project', () => {
  for (const n of [0, 3, 150]) {
    it(`${n} projects: New project opens the copy form under the doors with the focus in Title; Cancel gives it back`, async () => {
      await mount(view(n));
      await press('projects-new');
      const form = byId('projects-new-form');
      expect(byId('projects-list')!.contains(form)).toBe(true);
      expect(before('projects-new', 'projects-new-form')).toBe(true);
      expect(before('projects-new-form', n === 0 ? 'projects-empty' : 'projects-row-mine-0')).toBe(true);
      expect(focused()).toBe('projects-new-title');
      await press('projects-new-cancel');
      expect(byId('projects-new-form')).toBeNull();
      expect(focused()).toBe('projects-new');
    });
  }

  it('a Copy far down "The library" scrolls to the form, focuses Title, copies that row, and Cancel goes back to that Copy', async () => {
    await mount(view(150));
    far.add('projects-new-title');
    await press('projects-copy-library-desk');
    expect(scrolls).toEqual([{ on: 'projects-new-form', options: { block: 'start', inline: 'nearest', behavior: 'instant' } }]);
    expect(focused()).toBe('projects-new-title');
    expect((byId('projects-new-source') as HTMLSelectElement).value).toBe('v-desk');
    // The Copy button is now out of sight: going back to it brings it into view.
    far.clear();
    far.add('projects-copy-library-desk');
    await press('projects-new-cancel');
    expect(focused()).toBe('projects-copy-library-desk');
    expect(scrolls.at(-1)).toEqual({ on: 'projects-copy-library-desk', options: { block: 'center', inline: 'nearest', behavior: 'instant' } });
  });

  it('a Copy on the 150th row of "Your projects" does the same', async () => {
    await mount(view(150));
    far.add('projects-new-title');
    await press('projects-copy-mine-149');
    expect(scrolls).toHaveLength(1);
    expect(focused()).toBe('projects-new-title');
    expect((byId('projects-new-source') as HTMLSelectElement).value).toBe('v-mine-149');
    await press('projects-new-cancel');
    expect(focused()).toBe('projects-copy-mine-149');
  });

  it('a second door pressed while the copy form is open finds it again: the focus back in Title, the new row copied', async () => {
    await mount(view(3));
    await press('projects-new');
    (byId('projects-new-slug') as HTMLInputElement).focus();
    far.add('projects-new-title');
    await press('projects-copy-tasktrackr');
    expect(focused()).toBe('projects-new-title');
    expect((byId('projects-new-source') as HTMLSelectElement).value).toBe('v-default');
    expect(scrolls).toHaveLength(1);
    (byId('projects-new-slug') as HTMLInputElement).focus();
    await press('projects-new');
    expect(focused()).toBe('projects-new-title');
    expect(scrolls).toHaveLength(2);
  });

  it('both forms open: the upload form first, then the copy form, then the list', async () => {
    await mount(view(3));
    await press('projects-upload-open');
    await press('projects-new');
    expect(before('projects-upload', 'projects-new-form')).toBe(true);
    expect(before('projects-new-form', 'projects-row-mine-0')).toBe(true);
    expect(focused()).toBe('projects-new-title');
  });
});

describe('reveal-form, the rule', () => {
  const place = (el: HTMLElement, top: number, height = 40) =>
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top, bottom: top + height, left: 0, right: 10, width: 10, height, x: 0, y: top, toJSON: () => ({}) }),
    });

  it('wholly in view means inside the window and inside every clipping box around it', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const field = document.createElement('input');
    scroller.appendChild(field);
    document.body.appendChild(scroller);
    place(scroller, 64, 700);
    place(field, 100);
    expect(whollyInView(field)).toBe(true);
    // Under the bar the scroller starts below.
    place(field, 40);
    expect(whollyInView(field)).toBe(false);
    // Half past the scroller's foot.
    place(field, 750);
    expect(whollyInView(field)).toBe(false);
    scroller.remove();
  });

  it('revealForm scrolls only when the field is not wholly in view, and focuses it either way', () => {
    const form = document.createElement('div');
    form.setAttribute('data-testid', 'the-form');
    const field = document.createElement('input');
    field.setAttribute('data-testid', 'the-field');
    form.appendChild(field);
    document.body.appendChild(form);
    revealForm(form, field);
    expect(scrolls).toEqual([]);
    expect(document.activeElement).toBe(field);
    field.blur();
    far.add('the-field');
    revealForm(form, field);
    expect(scrolls).toEqual([{ on: 'the-form', options: { block: 'start', inline: 'nearest', behavior: 'instant' } }]);
    expect(document.activeElement).toBe(field);
    form.remove();
  });

  it('returnFocus falls back to the door when the opener has left the page', () => {
    const opener = document.createElement('button');
    const fallback = document.createElement('button');
    document.body.append(opener, fallback);
    opener.remove();
    returnFocus(opener, fallback);
    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });

  it('with no scrollIntoView (an old engine, jsdom) the focus still moves', () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    const form = document.createElement('div');
    const field = document.createElement('input');
    field.setAttribute('data-testid', 'the-field');
    form.appendChild(field);
    document.body.appendChild(form);
    far.add('the-field');
    expect(() => revealForm(form, field)).not.toThrow();
    expect(document.activeElement).toBe(field);
    form.remove();
  });
});
