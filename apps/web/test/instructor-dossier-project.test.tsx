// @vitest-environment jsdom
/**
 * Which project the console's dossier prints.
 *
 * The console draws a learner on the project they are working. With no project
 * named, the dossier route answers the learner's OLDEST enrolment (for a
 * learner whose class works another project, the one set aside for it) so an
 * unnamed "Print submitted evidence" would print a different project from the
 * evidence on the screen. The link names the project on screen, and the page
 * asks for that one; without a name it asks with no project.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dossier: vi.fn(),
  console: vi.fn(),
  search: '',
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ userId: 'ada' }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/experience/shared', () => ({
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  LoadingState: () => <p role="status">Loading</p>,
}));
vi.mock('@/components/shell/AppFrame', () => ({ RetryNotice: ({ message }: { message: string }) => <p role="alert">{message}</p> }));
vi.mock('@/components/dossier/Dossier', () => ({ Dossier: () => <section data-testid="dossier" /> }));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: { learnerDossier: mocks.dossier },
  getConsoleProject: mocks.console,
  ALL_PROJECTS: 'all',
}));

let host: HTMLDivElement;
let root: Root;

const render = async () => {
  const { default: Page } = await import('@/app/(app)/instructor/learners/[userId]/dossier/page');
  await act(async () => root.render(<Page />));
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = '';
  mocks.console.mockReturnValue('');
  mocks.dossier.mockResolvedValue({ displayName: 'Ada Example' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('asks for the project the console link names', async () => {
  mocks.search = 'project=library-desk&returnTo=%2Fteacher%2Fclass';
  await render();

  expect(mocks.dossier).toHaveBeenCalledExactlyOnceWith('ada', 'library-desk');
});

it('names the link’s project over the console’s remembered one', async () => {
  mocks.search = 'project=library-desk';
  mocks.console.mockReturnValue('tasktrackr');
  await render();

  expect(mocks.dossier).toHaveBeenCalledExactlyOnceWith('ada', 'library-desk');
});

it('asks with no project when the link names none', async () => {
  await render();
  expect(mocks.dossier).toHaveBeenCalledExactlyOnceWith('ada', undefined);

  mocks.dossier.mockClear();
  act(() => root.unmount());
  root = createRoot(host);
  mocks.console.mockReturnValue('tasktrackr');
  await render();
  expect(mocks.dossier).toHaveBeenCalledExactlyOnceWith('ada', 'tasktrackr');
});
