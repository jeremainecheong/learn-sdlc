// @vitest-environment jsdom
/**
 * At 1280 by 800 the upload form would open with its buttons 60 to 100 px
 * below the window. A door brings its form in by the least scroll that
 * shows all of it (its foot a margin above the window's bottom), never above
 * its head; a form already in view (1440 by 900) moves nothing.
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

import { SUPPORTED_STACKS_SENTENCE } from '@learnsdlc/shared';
import { ProjectsLibrary } from '@/components/staff/projects/ProjectsLibrary';
import { revealBlock, revealForm } from '@/components/staff/projects/reveal-form';
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

/** Put the window at `height` and the upload or copy form's box (its wrapper) and Title where a browser draws them. */
function layout(height: number, boxes: Record<'wrapper' | 'title', { top: number; bottom: number }>, form: 'projects-upload' | 'projects-new-form') {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  const field = form === 'projects-upload' ? 'projects-upload-title' : 'projects-new-title';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const at =
      this.firstElementChild?.getAttribute('data-testid') === form
        ? boxes.wrapper
        : this.getAttribute('data-testid') === field
          ? boxes.title
          : { top: 100, bottom: 140 };
    return { ...at, left: 0, right: 100, width: 100, height: at.bottom - at.top, x: 0, y: at.top, toJSON: () => ({}) } as DOMRect;
  });
}

describe('the whole form is brought into view by the least scroll', () => {
  beforeEach(() => {
    m.runtimeProfile.mockResolvedValue(TODAY);
  });

  it('1280 by 800: the upload form whose foot is below the window has its foot brought up, at once, and Title takes the focus', async () => {
    await mount();
    // At 1280 by 800: the form's box from y 260 to its foot at 946, Title at 600.
    layout(800, { wrapper: { top: 260, bottom: 946 }, title: { top: 600, bottom: 640 } }, 'projects-upload');
    await press('projects-upload-open');
    expect(scrolls).toEqual([{ on: 'projects-upload', options: { block: 'end', inline: 'nearest', behavior: 'instant' } }]);
    expect(focused()).toBe('projects-upload-title');
    // The profile arriving afterwards scrolls nothing more.
    await settle(5);
    expect(scrolls).toHaveLength(1);
  });

  it('1440 by 900: the whole form is already in view, so nothing scrolls', async () => {
    await mount();
    layout(900, { wrapper: { top: 260, bottom: 870 }, title: { top: 440, bottom: 480 } }, 'projects-upload');
    await press('projects-upload-open');
    expect(scrolls).toEqual([]);
    expect(focused()).toBe('projects-upload-title');
    await settle(5);
    expect(scrolls).toEqual([]);
  });

  it('the second press at 1280 by 800 does the same least scroll and keeps the words typed', async () => {
    await mount();
    layout(800, { wrapper: { top: 260, bottom: 946 }, title: { top: 600, bottom: 640 } }, 'projects-upload');
    await press('projects-upload-open');
    const title = byId('projects-upload-title') as HTMLInputElement;
    await act(async () => {
      typeInto(title, 'Deadline');
    });
    (byId('projects-upload-file') as HTMLInputElement).focus();
    await press('projects-upload-open');
    expect(scrolls.map((one) => (one.options as { block: string }).block)).toEqual(['end', 'end']);
    expect(focused()).toBe('projects-upload-title');
    expect((byId('projects-upload-title') as HTMLInputElement).value).toBe('Deadline');
  });

  it('the copy form from New project and from a row near the top: foot brought up at 1280, nothing at 1440', async () => {
    await mount();
    layout(800, { wrapper: { top: 260, bottom: 880 }, title: { top: 340, bottom: 380 } }, 'projects-new-form');
    await press('projects-new');
    expect(scrolls).toEqual([{ on: 'projects-new-form', options: { block: 'end', inline: 'nearest', behavior: 'instant' } }]);
    await press('projects-new-cancel');
    scrolls = [];
    await press('projects-copy-mine-0');
    expect(scrolls).toEqual([{ on: 'projects-new-form', options: { block: 'end', inline: 'nearest', behavior: 'instant' } }]);
    expect(focused()).toBe('projects-new-title');
    await press('projects-new-cancel');
    scrolls = [];
    layout(900, { wrapper: { top: 260, bottom: 880 }, title: { top: 340, bottom: 380 } }, 'projects-new-form');
    await press('projects-new');
    expect(scrolls).toEqual([]);
  });

  it("a Copy far down, the form above the window: its head goes to the top", async () => {
    await mount();
    layout(800, { wrapper: { top: -2400, bottom: -1800 }, title: { top: -2320, bottom: -2280 } }, 'projects-new-form');
    await press('projects-copy-tasktrackr');
    expect(scrolls).toEqual([{ on: 'projects-new-form', options: { block: 'start', inline: 'nearest', behavior: 'instant' } }]);
    expect(focused()).toBe('projects-new-title');
  });

  it('the wrappers keep a margin above the top and below the foot, so the foot stops short of the window edge', async () => {
    await mount();
    await press('projects-upload-open');
    await press('projects-new');
    for (const id of ['projects-upload', 'projects-new-form']) {
      const wrapper = byId(id)!.parentElement!;
      expect(wrapper.className.split(' '), id).toEqual(expect.arrayContaining(['scroll-mt-4', 'scroll-mb-4']));
    }
  });
});

describe('revealBlock, the rule', () => {
  const place = (el: HTMLElement, top: number, bottom: number) =>
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top, bottom, left: 0, right: 10, width: 10, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }),
    });

  function frame() {
    // The signed-in pages' inner panel: it scrolls, and starts under the 52 px bar.
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    const form = document.createElement('div');
    form.style.scrollMarginTop = '16px';
    form.style.scrollMarginBottom = '16px';
    const field = document.createElement('input');
    form.appendChild(field);
    panel.appendChild(form);
    document.body.appendChild(panel);
    place(panel, 52, 800);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    return { panel, form, field };
  }

  it('in view: none; foot below and it fits: end; above: start; taller than the panel: start', () => {
    const { panel, form, field } = frame();
    place(field, 400, 440);
    place(form, 100, 780);
    expect(revealBlock(form, field)).toBeNull();
    place(form, 260, 946);
    expect(revealBlock(form, field)).toBe('end');
    // A form whose head is below the window too, and that fits: its foot comes up, its head with it.
    place(form, 820, 1300);
    place(field, 900, 940);
    expect(revealBlock(form, field)).toBe('end');
    place(form, -900, -300);
    place(field, -800, -760);
    expect(revealBlock(form, field)).toBe('start');
    // 748 px of panel: a 720 px form with its two 16 px margins does not fit, so its head goes to the top.
    place(form, 260, 980);
    place(field, 400, 440);
    expect(revealBlock(form, field)).toBe('start');
    place(form, 260, 960);
    expect(revealBlock(form, field)).toBe('end');
    panel.remove();
  });

  it('the panel cuts the view: a form under the bar is not in view', () => {
    const { panel, form, field } = frame();
    place(form, 30, 600);
    place(field, 60, 100);
    expect(revealBlock(form, field)).toBe('start');
    panel.remove();
  });

  it('revealForm makes the one call the rule names, and focuses the field without a scroll of its own', () => {
    const { panel, form, field } = frame();
    form.setAttribute('data-testid', 'the-form');
    place(field, 600, 640);
    place(form, 260, 946);
    const focus = vi.spyOn(field, 'focus');
    revealForm(form, field);
    expect(scrolls).toEqual([{ on: 'the-form', options: { block: 'end', inline: 'nearest', behavior: 'instant' } }]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(field);
    panel.remove();
  });
});
