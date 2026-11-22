// @vitest-environment jsdom
/**
 * The teacher's project library, and the one door into it.
 *
 * A teacher arrives here owning nothing. The only way to a project of their
 * own is to copy one that is already published, which is why the empty state
 * is a door rather than an apology, why the platform's project is drawn as
 * assignable-and-copyable rather than as a row with a greyed Edit on it, and
 * why the sentence a refused copy produces is the API's own, word for word,
 * rather than a friendlier one this page invented.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredProjectSummary, AuthoringLibraryView } from '@learnsdlc/shared';
import { platformProjectCopyOnlyRefusal } from '@learnsdlc/shared';

const list = vi.fn();
const create = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'a@b.c', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError } from '@/lib/api';
import { ProjectsLibrary } from '@/components/staff/projects/ProjectsLibrary';

function project(over: Partial<AuthoredProjectSummary> = {}): AuthoredProjectSummary {
  return {
    id: 'p-default',
    slug: 'tasktrackr',
    title: 'TaskTrackr',
    platformOwned: true,
    mine: false,
    isDefault: true,
    origin: 'seed',
    publishedVersion: '1.0.0',
    publishedVersionId: 'v-default',
    draftVersion: null,
    draftVersionId: null,
    cohortsUsing: 3,
    lastValidatedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const LIBRARY_ONLY: AuthoringLibraryView = { mine: [], library: [project()] };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
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

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => host?.textContent ?? '';

async function mount(view: AuthoringLibraryView) {
  list.mockResolvedValue(view);
  await act(async () => {
    root?.render(<ProjectsLibrary />);
  });
}

function type(el: HTMLElement | null, value: string) {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the teacher project library', () => {
  it('draws a door rather than an apology when the teacher owns nothing', async () => {
    await mount(LIBRARY_ONLY);
    expect(byId('projects-empty')).not.toBeNull();
    // The library is still listed: the empty half is "yours", not "all".
    expect(byId('projects-row-tasktrackr')).not.toBeNull();
    expect(byId('projects-new')).not.toBeNull();
  });

  it('reads each row’s facts as sentences, on the row a teacher sees (F-c)', async () => {
    await mount({
      mine: [],
      library: [
        project(),
        project({ id: 'p-desk', slug: 'library-desk', title: 'Library Desk', platformOwned: false, isDefault: false, cohortsUsing: 0, lastValidatedAt: null }),
      ],
    });
    expect(byId('projects-facts-tasktrackr')?.textContent).toBe('Slug tasktrackr. 3 classes are on it. Not validated yet.');
    expect(byId('projects-facts-library-desk')?.textContent).toBe('Slug library-desk. No class is on it yet. Not validated yet.');
    expect(text()).not.toContain('0 classes are');
    expect(text()).not.toContain('Last validated —');
  });

  it("marks the default, says the platform's project is copy-only, and offers no edit on it", async () => {
    await mount(LIBRARY_ONLY);
    expect(byId('projects-default-tasktrackr')?.textContent).toContain('Default');
    expect(text()).toContain(platformProjectCopyOnlyRefusal('TaskTrackr'));
    // Copying is the only write a teacher has on it.
    expect(byId('projects-copy-tasktrackr')).not.toBeNull();
    expect(byId('projects-open-tasktrackr')).toBeNull();
  });

  it('opens the draft of a project the teacher owns, and never one they do not', async () => {
    await mount({
      mine: [
        project({
          id: 'p-mine',
          slug: 'my-course',
          title: 'My course',
          platformOwned: false,
          mine: true,
          isDefault: false,
          origin: 'fork',
          publishedVersion: null,
          publishedVersionId: null,
          draftVersion: '0.1.0',
          draftVersionId: 'v-mine',
          cohortsUsing: 0,
        }),
      ],
      library: [project()],
    });
    const open = byId('projects-open-my-course') as HTMLAnchorElement | null;
    expect(open?.getAttribute('href')).toBe('/teacher/projects/p-mine/versions/v-mine');
    expect(byId('projects-empty')).toBeNull();
  });

  it('opens the published version of a project with no draft, which is where the next draft is opened', async () => {
    // A project whose draft has been published carries no `draftVersionId`, so
    // "Open the draft" is not drawn, and without a second link the editor,
    // which is where `versions.createDraft` is offered, could not be reached
    // from the product at all.
    await mount({
      mine: [
        project({
          id: 'p-mine',
          slug: 'my-course',
          title: 'My course',
          platformOwned: false,
          mine: true,
          isDefault: false,
          origin: 'fork',
          publishedVersion: '1.0.0',
          publishedVersionId: 'v-head',
          draftVersion: null,
          draftVersionId: null,
          cohortsUsing: 1,
        }),
      ],
      library: [project()],
    });

    const open = byId('projects-published-my-course') as HTMLAnchorElement | null;
    expect(open?.getAttribute('href')).toBe('/teacher/projects/p-mine/versions/v-head');
    expect(open?.textContent).toContain('1.0.0');
    // The platform's project is copy-only, so there is no version of it to open.
    expect(byId('projects-published-tasktrackr')).toBeNull();
  });

  it('copies the version a teacher chose, and carries them into the new draft', async () => {
    await mount(LIBRARY_ONLY);
    create.mockResolvedValue({
      project: project({ id: 'p-new', slug: 'my-course', title: 'My course', mine: true, platformOwned: false, isDefault: false }),
      draftVersionId: 'v-new',
      draftVersion: '0.1.0',
    });

    await act(async () => {
      (byId('projects-copy-tasktrackr') as HTMLButtonElement).click();
    });
    type(byId('projects-new-title'), 'My course');
    type(byId('projects-new-slug'), 'my-course');
    await act(async () => {
      (byId('projects-new-submit') as HTMLButtonElement).click();
    });

    expect(create).toHaveBeenCalledWith({
      title: 'My course',
      slug: 'my-course',
      fromVersionId: 'v-default',
    });
    expect(push).toHaveBeenCalledWith('/teacher/projects/p-new/versions/v-new');
  });

  it("reads back the API's own refusal, word for word", async () => {
    await mount(LIBRARY_ONLY);
    const refusal = platformProjectCopyOnlyRefusal('TaskTrackr');
    create.mockRejectedValue(new ApiError(403, refusal));

    await act(async () => {
      (byId('projects-copy-tasktrackr') as HTMLButtonElement).click();
    });
    type(byId('projects-new-title'), 'My course');
    type(byId('projects-new-slug'), 'my-course');
    await act(async () => {
      (byId('projects-new-submit') as HTMLButtonElement).click();
    });

    expect(byId('projects-new-error')?.textContent).toContain(refusal);
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining('/versions/'));
  });

  it('refuses a slug the contract refuses, before the network is asked', async () => {
    await mount(LIBRARY_ONLY);
    await act(async () => {
      (byId('projects-copy-tasktrackr') as HTMLButtonElement).click();
    });
    type(byId('projects-new-title'), 'My course');
    type(byId('projects-new-slug'), 'My Course');
    await act(async () => {
      (byId('projects-new-submit') as HTMLButtonElement).click();
    });
    expect(create).not.toHaveBeenCalled();
    expect(byId('projects-new-error')).not.toBeNull();
  });
});
