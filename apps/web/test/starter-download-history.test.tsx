// @vitest-environment jsdom
/**
 * The Projects page's Start here says which starter archives the teacher has
 * downloaded, from their own audit rows.
 *
 * The rows are read with the existing client (`instructorApi.audit()`, no
 * learner: GET /instructor/audit, which for a teacher answers their own rows
 * and their class's). A row counts only when it is the starter download's own
 * shape (event 'project.sealed-read', no detail.path, targetId null, action
 * starter|shelf) AND it is provably the
 * caller's own (actor and subject are the signed-in account), which is what
 * makes the same rule safe for an admin, whose listing is the whole trail. A
 * failed read, or no row, draws nothing; a learner never sees the line and
 * never asks for the rows.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventView } from '@learnsdlc/shared';
import { whenDate } from '@/components/staff/primitives';
import { loadAxe } from './support/axe-bridge';

const m = vi.hoisted(() => ({
  audit: vi.fn(),
  list: vi.fn(),
  user: { id: 'teacher-1', displayName: 'A Teacher', role: 'INSTRUCTOR' } as { id: string; displayName: string; role: string } | null,
}));

vi.mock('@/lib/api-instructor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api-instructor')>();
  return { ...real, instructorApi: { ...real.instructorApi, audit: (...a: unknown[]) => m.audit(...a) } };
});
vi.mock('@/lib/api-projects', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api-projects')>();
  return { ...real, projectsApi: { ...real.projectsApi, list: (...a: unknown[]) => m.list(...a) } };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
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
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => m.user,
  useRole: () => m.user?.role,
}));

import { DownloadHistory, downloadHistoryLines } from '@/components/staff/guide/DownloadHistory';
import { ProjectsLibrary } from '@/components/staff/projects/ProjectsLibrary';
import { settle } from './support/dom';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  m.audit.mockReset();
  m.list.mockReset();
  m.user = { id: 'teacher-1', displayName: 'A Teacher', role: 'INSTRUCTOR' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const STARTER_AT = '2026-10-02T03:00:00.000Z';
const STARTER_EARLIER = '2026-09-20T03:00:00.000Z';
const SHELF_AT = '2026-10-01T05:00:00.000Z';

function row(over: Partial<AuditEventView>): AuditEventView {
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    event: 'project.sealed-read',
    actorUserId: 'teacher-1',
    actorName: 'A Teacher',
    subjectUserId: 'teacher-1',
    subjectName: 'A Teacher',
    targetId: null,
    action: 'starter',
    reason: null,
    detail: { name: 'starter', filename: 'learnsdlc-starter.zip', size: 1024, sha256: 'a'.repeat(64) },
    createdAt: STARTER_AT,
    ...over,
  } as AuditEventView;
}
const starterLine = (at: string) => `You downloaded the starter archive on ${whenDate(at)}.`;
const shelfLine = (at: string) => `You downloaded the shelf example on ${whenDate(at)}.`;

/** The listing newest first, as the route answers it, with every row that must not count. */
function listing(): AuditEventView[] {
  return [
    // Someone else's download in the same listing (a class's trail): never the caller's.
    row({ actorUserId: 'teacher-2', subjectUserId: 'teacher-2', createdAt: '2026-10-03T00:00:00.000Z' }),
    // A sealed file read on a project, with a path: not a starter download.
    row({ targetId: 'p-1', action: 'implementation', detail: { path: 'tests/test_shelf.py' }, createdAt: '2026-10-02T09:00:00.000Z' }),
    // A pathless read on a project whose action says starter: on a project, so not a download.
    row({ targetId: 'p-1', action: 'starter', createdAt: '2026-10-02T08:00:00.000Z' }),
    // A row that names a path even without a project.
    row({ detail: { path: 'tests/x.py' }, createdAt: '2026-10-02T07:00:00.000Z' }),
    // Another event entirely.
    row({ event: 'project.exported', action: '0.1.0', createdAt: '2026-10-02T06:00:00.000Z' }),
    // An unknown archive name.
    row({ action: 'other', detail: { name: 'other' }, createdAt: '2026-10-02T05:00:00.000Z' }),
    // The caller's own downloads: the newest starter, the shelf, an older starter.
    row({ action: 'starter', createdAt: STARTER_AT }),
    row({ action: 'shelf', detail: { name: 'shelf' }, createdAt: SHELF_AT }),
    row({ action: 'starter', createdAt: STARTER_EARLIER }),
  ];
}

describe('downloadHistoryLines: the rule', () => {
  it('keeps only the caller\'s own starter and shelf downloads, newest of each', () => {
    expect(downloadHistoryLines(listing(), 'teacher-1')).toEqual([
      { name: 'starter', at: STARTER_AT, sentence: starterLine(STARTER_AT) },
      { name: 'shelf', at: SHELF_AT, sentence: shelfLine(SHELF_AT) },
    ]);
  });

  it('a row the caller acted on for someone else (subject not the caller) does not count', () => {
    expect(downloadHistoryLines([row({ subjectUserId: 'learner-1' })], 'teacher-1')).toEqual([]);
  });

  it('nothing for no rows, and nothing without a caller id', () => {
    expect(downloadHistoryLines([], 'teacher-1')).toEqual([]);
    expect(downloadHistoryLines(listing(), '')).toEqual([]);
  });
});

describe('DownloadHistory', () => {
  it('a teacher sees the starter and shelf lines read from their own rows', async () => {
    m.audit.mockResolvedValue(listing());
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(m.audit).toHaveBeenCalledTimes(1);
    // No learner: the caller's own listing.
    expect(m.audit.mock.calls[0][0]).toBeUndefined();
    const line = byId('guide-download-history');
    expect(line).not.toBeNull();
    expect(byId('guide-download-history-starter')?.textContent).toBe(starterLine(STARTER_AT));
    expect(byId('guide-download-history-shelf')?.textContent).toBe(shelfLine(SHELF_AT));
    // Another teacher's newer download, in the same listing, is not dated here.
    expect(line!.textContent).not.toContain(whenDate('2026-10-03T00:00:00.000Z'));
  });

  it('only the starter line when only the starter was downloaded', async () => {
    m.audit.mockResolvedValue([row({ action: 'starter', createdAt: STARTER_AT })]);
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(byId('guide-download-history-starter')?.textContent).toBe(starterLine(STARTER_AT));
    expect(byId('guide-download-history-shelf')).toBeNull();
  });

  it('a failed read draws nothing: no line and no error', async () => {
    m.audit.mockRejectedValue(new Error('down'));
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(byId('guide-download-history')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('no download rows draws nothing', async () => {
    m.audit.mockResolvedValue(listing().slice(0, 6));
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(byId('guide-download-history')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('a learner never sees the line and the rows are never asked for', async () => {
    m.user = { id: 'teacher-1', displayName: 'A Learner', role: 'LEARNER' };
    m.audit.mockResolvedValue(listing());
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(m.audit).not.toHaveBeenCalled();
    expect(byId('guide-download-history')).toBeNull();
  });

  it('no session: nothing is asked for and nothing drawn', async () => {
    m.user = null;
    m.audit.mockResolvedValue(listing());
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(m.audit).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });

  it('an admin sees only the rows provably their own (actor and subject are the admin)', async () => {
    m.user = { id: 'admin-1', displayName: 'An Admin', role: 'ADMIN' };
    m.audit.mockResolvedValue([
      row({ actorUserId: 'teacher-1', subjectUserId: 'teacher-1', action: 'starter', createdAt: STARTER_AT }),
      row({ actorUserId: 'admin-1', subjectUserId: 'admin-1', action: 'shelf', detail: { name: 'shelf' }, createdAt: SHELF_AT }),
    ]);
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(byId('guide-download-history-starter')).toBeNull();
    expect(byId('guide-download-history-shelf')?.textContent).toBe(shelfLine(SHELF_AT));
  });

  it('an audit client that throws at once still draws nothing', async () => {
    m.audit.mockImplementation(() => {
      throw new TypeError('no client');
    });
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(host.textContent).toBe('');
  });

  it('axe: the line has no WCAG 2.0/2.1 A or AA violation (colour contrast excepted: jsdom has no layout)', async () => {
    m.audit.mockResolvedValue(listing());
    await act(async () => root.render(<DownloadHistory />));
    await settle();
    expect(byId('guide-download-history')).not.toBeNull();
    const axe = await loadAxe();
    const result = await axe.run(host, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(result.violations.map((one) => `${one.id}: ${one.nodes.length}`)).toEqual([]);
  });
});

describe('the Projects page mounts it on Start here', () => {
  const emptyLibrary = { mine: [], library: [] };

  it('the line is drawn with the Start here card, after it and before Your projects', async () => {
    m.list.mockResolvedValue(emptyLibrary);
    m.audit.mockResolvedValue(listing());
    await act(async () => root.render(<ProjectsLibrary />));
    await settle();
    const start = byId('guide-start-here');
    const line = byId('guide-download-history');
    const projects = byId('projects-list');
    expect(start).not.toBeNull();
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain(starterLine(STARTER_AT));
    expect(start!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line!.compareDocumentPosition(projects!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a failed read leaves the library as it was: no line and no error banner', async () => {
    m.list.mockResolvedValue(emptyLibrary);
    m.audit.mockRejectedValue(new Error('down'));
    await act(async () => root.render(<ProjectsLibrary />));
    await settle();
    expect(byId('guide-start-here')).not.toBeNull();
    expect(byId('guide-download-history')).toBeNull();
    expect(byId('projects-error')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
