// @vitest-environment jsdom
/**
 * One frame for every code phase. As for Maintenance, the
 * document pages of Implementation (its pull request), Testing (its planted
 * bugs and its reviews) and Deployment (its incident drill and its reviews)
 * are drawn in the workspace's frame:
 *
 * - the working-area row is the workspace's own, entry for entry (words,
 *   order, icons, classes, label; read against the real workspace in
 *   work-room-header), with the page it is on marked current, the workspace's
 *   views reached by address, and the review page as its last entry;
 * - from 1024 px the brief and mentor switches are the right end of that row;
 *   below it they keep their row of their own and the brief is its plain box;
 * - the workspace's "Your task" and "Files" tabs head the left column where
 *   that phase's workspace draws them (Testing, Deployment), not on
 *   Implementation, whose workspace has none;
 * - the mentor has both of its modes;
 * - the optional quick check is claimed for the header and placed by the
 *   workspace header's rule.
 *
 * Requirements' and Design's pages, and every phase's brief and solution,
 * keep their frame (maintenance-frame).
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ mentor: [] as { guidedOnly?: boolean }[], claims: 0, inMore: false, listeners: [] as (() => void)[], wide: true }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/components/Icon', () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));
vi.mock('@/components/shell', () => ({
  DocPage: () => null,
  PhaseStrip: ({ rowLine, menuLine, workHeader }: { rowLine?: ReactNode; menuLine?: ReactNode; workHeader?: boolean }) =>
    <div data-testid="phase-strip" data-work-header={String(Boolean(workHeader))}><span data-slot="row">{rowLine}</span><details><div data-slot="menu">{menuLine}</div></details></div>,
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ PersonaPanel: (props: { guidedOnly?: boolean }) => { seen.mentor.push(props); return <div data-testid="persona-panel" />; } }));
vi.mock('@/lib/scenario', () => ({ useInterviewAbsent: () => false }));
// Which box the brief's keyboard tab stop watches: the real watcher gives a box a tab stop only while it scrolls,
// which jsdom never lays out, so the stand-in marks the box it is attached to.
vi.mock('@/lib/scroll-focus', () => ({ scrollFocusRef: (el: HTMLElement | null) => { el?.setAttribute('data-tab-stop', 'watched'); }, useScrollFocusRef: () => () => undefined }));
vi.mock('@/components/workspace/QuickCheck', () => ({
  QuickCheckLine: ({ inline, menu }: { inline?: boolean; menu?: boolean }) => <span data-testid="quick-check-line" data-place={inline ? 'row' : menu ? 'menu' : 'band'} />,
  useClaimedQuickCheck: () => { seen.claims += 1; return null; },
}));
vi.mock('@/components/workspace/PhaseHeader', () => ({ useQuickCheckInMore: () => seen.inMore }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => <p data-testid="brief-intro">intro</p> }));
vi.mock('@/components/workspace/PhaseGateBanner', () => ({ ShellPhaseGateBanner: () => null }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' }),
  WorkspacePanelControls: ({ placement = 'row' }: { placement?: string }) => <div data-testid="panel-controls" data-placement={placement} />,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';

let root: Root, host: HTMLDivElement;
const width = (wide: boolean) => {
  seen.wide = wide;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(min-width: 1024px)' ? seen.wide : false; }, media: query,
    addEventListener(_: string, listener: () => void) { seen.listeners.push(listener); },
    removeEventListener(_: string, listener: () => void) { seen.listeners = seen.listeners.filter((one) => one !== listener); },
  }));
};
const resizeTo = (wide: boolean) => act(() => { seen.wide = wide; seen.listeners.forEach((listener) => listener()); });
beforeEach(() => { seen.mentor.length = 0; seen.claims = 0; seen.inMore = false; seen.listeners = []; width(true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

type Key = 'implementation' | 'testing' | 'deployment';
type View = 'pr' | 'matrix' | 'drill';
const TITLE: Record<Key, string> = { implementation: 'Implementation', testing: 'Testing', deployment: 'Deployment' };
const draw = (key: Key, view: View, phase: Record<string, unknown> = {}, extra: { subNav?: ReactNode } = {}) =>
  act(() => root.render(<PhaseDocumentFrame phase={{ id: 'p-4', key, title: TITLE[key], ...phase } as any} view={view} title="Heading" {...extra}><p>body</p></PhaseDocumentFrame>));
const LABEL: Record<Key, string> = { implementation: 'Implementation working area', testing: 'Phase working area', deployment: 'Phase working area' };
const area = (key: Key) => host.querySelector<HTMLElement>(`nav[aria-label="${LABEL[key]}"]`);
/** Each child of the row: its tag, words, address, current mark, icon and the workspace view it opens. */
const entries = (key: Key) => [...area(key)!.children].filter((c) => !c.matches('[data-testid="panel-controls"]')).map((c) =>
  [c.tagName, c.textContent, c.getAttribute('href'), c.getAttribute('aria-current'), c.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null, c.getAttribute('data-view')]);
const controls = () => [...host.querySelectorAll<HTMLElement>('[data-testid="panel-controls"]')];

describe('each page\'s working-area row', () => {
  // Files is the left column's tab, not a row entry, and Split draws the stacked icon, as on the workspace.
  it('Implementation\'s pull request: Code, Split and the preview by address, Pull request current, "Saved workspace"', () => {
    draw('implementation', 'pr', { canPreview: true });
    expect([...area('implementation')!.classList]).toEqual(['implementation-view-tabs']);
    expect(area('implementation')!.getAttribute('data-testid')).toBe('implementation-area-nav');
    expect(entries('implementation')).toEqual([
      ['A', 'Code', '/workspace/p-4?panel=code', null, 'code', 'code'],
      ['A', 'Split', '/workspace/p-4?panel=split', null, 'panel-bottom', 'split'],
      ['A', 'App preview', '/workspace/p-4?panel=preview', null, 'run', 'preview'],
      ['A', 'Pull request', '/workspace/p-4/pr', 'page', 'pr', null],
      ['SPAN', 'Saved workspace', null, null, null, null],
    ]);
    // one working-area row, not the older text row ("Code and preview, Pull request")
    expect(host.querySelectorAll('nav[aria-label$=" working area"]')).toHaveLength(1);
    expect(host.querySelector('.phase-document-center > nav.phase-room-nav')).toBeNull();
    expect(host.textContent).not.toContain('Code and preview');
  });
  it('Testing\'s planted bugs and reviews: the same row, the page it is on current', () => {
    for (const [view, current] of [['matrix', '/workspace/p-4/matrix'], ['pr', '/workspace/p-4/pr']] as const) {
      draw('testing', view, { canPreview: true });
      expect([...area('testing')!.classList]).toEqual(['implementation-view-tabs', 'runtime-view-tabs']);
      expect(entries('testing')).toEqual([
        // Every view link names its view, the edit view and Deployment's Pipeline too
        ['A', 'Write tests', '/workspace/p-4?panel=code', null, 'code', 'code'],
        ['A', 'Execution evidence', '/workspace/p-4?panel=evidence', null, 'testing', 'evidence'],
        ['A', 'App preview', '/workspace/p-4?panel=preview', null, 'run', 'preview'],
        ['A', 'Planted bugs', '/workspace/p-4/matrix', current.endsWith('matrix') ? 'page' : null, 'doc', null],
        // "Pull request", as in every code phase (was "Reviews").
        ['A', 'Pull request', '/workspace/p-4/pr', current.endsWith('/pr') ? 'page' : null, 'pr', null],
      ]);
      act(() => root.unmount()); root = createRoot(host);
    }
  });
  it('Deployment\'s incident drill and reviews: Configuration by address (its workspace opens on Pipeline)', () => {
    for (const view of ['drill', 'pr'] as const) {
      draw('deployment', view);
      expect(entries('deployment')).toEqual([
        ['A', 'Configuration', '/workspace/p-4?panel=code', null, 'code', 'code'],
        ['A', 'Pipeline', '/workspace/p-4?panel=evidence', null, 'deployment', 'evidence'],
        ['A', 'Incident drill', '/workspace/p-4/drill', view === 'drill' ? 'page' : null, 'doc', null],
        ['A', 'Pull request', '/workspace/p-4/pr', view === 'pr' ? 'page' : null, 'pr', null],
      ]);
      act(() => root.unmount()); root = createRoot(host);
    }
  });
  it('the drill\'s own sections are a second row under the heading, outside the working-area row', () => {
    draw('deployment', 'drill', {}, { subNav: <nav className="phase-room-nav phase-room-nav--sections" aria-label="Incident drill working area"><button type="button" aria-pressed>Diagnosis</button></nav> });
    const sections = host.querySelector('nav[aria-label="Incident drill working area"]')!;
    expect(area('deployment')!.contains(sections)).toBe(false);
    expect(sections.previousElementSibling?.matches('header.phase-document-heading')).toBe(true);
    expect(sections.nextElementSibling?.matches('.phase-document-content')).toBe(true);
  });
});

describe('the frame around the row is the workspace\'s', () => {
  const cases: [Key, View][] = [['implementation', 'pr'], ['testing', 'matrix'], ['testing', 'pr'], ['deployment', 'drill'], ['deployment', 'pr']];
  it('from 1024 px the switches are the right end of the row; below it they keep their row of their own and the brief its plain box', () => {
    for (const [key, view] of cases) {
      width(true);
      draw(key, view);
      expect(controls(), `${key} ${view}`).toHaveLength(1);
      expect(controls()[0].getAttribute('data-placement')).toBe('strip');
      expect(area(key)!.lastElementChild).toBe(controls()[0]);
      expect(host.querySelector('[data-workspace-panel="brief"]')!.classList.contains('phase-document-brief--work')).toBe(true);
      const wideEntries = [...area(key)!.querySelectorAll(':scope > a')].map((a) => a.textContent);
      resizeTo(false);
      expect(controls()).toHaveLength(1);
      expect(controls()[0].getAttribute('data-placement')).toBe('row');
      expect(area(key)!.contains(controls()[0])).toBe(false);
      expect([...host.querySelector('[data-workspace-panel="brief"]')!.classList]).toEqual(['phase-document-brief']);
      expect(host.querySelector('nav[aria-label="Phase context"]')).toBeNull();
      // the row's entries are the same at every width (Implementation's are three: Files is not on its row)
      expect(area(key)!.querySelectorAll(':scope > a').length).toBeGreaterThanOrEqual(3);
      expect([...area(key)!.querySelectorAll(':scope > a')].map((a) => a.textContent), `${key} ${view}`).toEqual(wideEntries);
      act(() => root.unmount()); root = createRoot(host);
    }
  });
  it('the workspace\'s "Your task" and "Files" tabs head the left column on every code phase, this page current', () => {
    for (const [key, view] of cases) {
      draw(key, view);
      const tabs = host.querySelector('[data-workspace-panel="brief"] nav[aria-label="Phase context"]')!;
      expect([...tabs.children].map((c) => [c.tagName, c.textContent, c.getAttribute('aria-current'), c.getAttribute('href')]), `${key} ${view}`).toEqual([
        ['A', 'Your task', 'page', `/workspace/p-4/${view}`],
        ['A', 'Files', null, '/workspace/p-4?panel=files'],
      ]);
      expect(tabs.querySelector('[aria-pressed]')).toBeNull();
      act(() => root.unmount()); root = createRoot(host);
    }
  });
  // Implementation's workspace draws "Your task | Files" over its left column now, so its page does.
  it('and on Implementation, whose workspace draws them too: the two tabs over the brief, in the work column', () => {
    draw('implementation', 'pr');
    const brief = host.querySelector<HTMLElement>('[data-workspace-panel="brief"]')!;
    const tabs = brief.querySelector('nav[aria-label="Phase context"]')!;
    expect([...tabs.children].map((c) => [c.tagName, c.textContent, c.getAttribute('aria-current'), c.getAttribute('href')])).toEqual([
      ['A', 'Your task', 'page', '/workspace/p-4/pr'],
      ['A', 'Files', null, '/workspace/p-4?panel=files'],
    ]);
    expect(brief.querySelectorAll('nav')).toHaveLength(1);
    expect([...brief.classList]).toEqual(['phase-document-brief', 'phase-document-brief--work']);
    expect(brief.querySelector('.phase-workspace-context > .phase-task-content [data-testid="brief-intro"]')).not.toBeNull();
  });
  // The box that scrolls is the one the keyboard reaches, at each width.
  it('the brief\'s keyboard tab stop is on the box that scrolls: the inner box under the tabs from 1024 px, the plain box below', () => {
    for (const [key, view] of cases) {
      draw(key, view);
      const brief = host.querySelector<HTMLElement>('[data-workspace-panel="brief"]')!;
      expect([...host.querySelectorAll('[data-tab-stop]')], `${key} ${view}`).toEqual([brief.querySelector('.phase-workspace-context > .phase-task-content')]);
      resizeTo(false);
      expect([...host.querySelectorAll('[data-tab-stop]')], `${key} ${view} narrow`).toEqual([host.querySelector('[data-workspace-panel="brief"]')]);
      act(() => root.unmount()); root = createRoot(host); width(true);
    }
  });
  it('the mentor has both of its modes on every page', () => {
    for (const [key, view] of cases) {
      draw(key, view);
      expect(seen.mentor.at(-1)?.guidedOnly, `${key} ${view}`).toBe(false);
      expect(host.querySelector('.phase-document-room')!.classList.contains('phase-document-room--work')).toBe(true);
      act(() => root.unmount()); root = createRoot(host);
    }
  });
  it('the optional quick check is claimed for the header: on its row where the workspace header keeps it there, in Details where it keeps it in More', () => {
    for (const [key, view] of cases) {
      seen.claims = 0; seen.inMore = false;
      draw(key, view);
      expect(seen.claims, `${key} ${view}`).toBeGreaterThan(0);
      expect(host.querySelector('[data-testid="phase-strip"]')!.getAttribute('data-work-header')).toBe('true');
      let lines = [...host.querySelectorAll('[data-testid="quick-check-line"]')];
      expect(lines.map((line) => line.getAttribute('data-place'))).toEqual(['row']);
      expect(lines[0].closest('details')).toBeNull();
      act(() => root.unmount()); root = createRoot(host);
      seen.inMore = true;
      draw(key, view);
      lines = [...host.querySelectorAll('[data-testid="quick-check-line"]')];
      expect(lines.map((line) => line.getAttribute('data-place'))).toEqual(['menu']);
      expect(lines[0].closest('details')).not.toBeNull();
      act(() => root.unmount()); root = createRoot(host);
    }
  });
});
