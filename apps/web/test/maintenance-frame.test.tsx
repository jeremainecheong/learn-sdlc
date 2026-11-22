// @vitest-environment jsdom
/**
 * One frame for Maintenance. The change request and the pull request of
 * a Maintenance whose door is the change room are drawn in the workspace's
 * frame, so going between them and Edit files changes the centre of the page
 * and nothing around it:
 *
 * - the working-area row is the workspace's own, entry for entry (words,
 *   order, icons, classes, label), with the page it is on marked current and
 *   the views of the workspace reached by address (`?panel=`);
 * - from 1024 px the brief and mentor switches sit at the right end of that
 *   row, as the workspace's do, not on a row of their own; below it the row of
 *   their own stays;
 * - from 1024 px the left column holds the workspace's two tabs over the
 *   brief; below it the left column is a plain brief box;
 * - the mentor has both of its modes (not guided only);
 * - the optional quick check is taken for the header and placed by the
 *   workspace header's own rule (on the row, or in the menu), so no row is
 *   drawn above the header for it.
 *
 * Every other document page, and a Maintenance whose door is not the change
 * room, keeps the document frame. The workspace's side is read in work-room-header.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, moduleText, webSource } from './support/source-text';

const seen = vi.hoisted(() => ({ mentor: [] as { guidedOnly?: boolean }[], claims: 0, inMore: false, listeners: [] as (() => void)[], wide: true }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/components/Icon', () => ({ Icon: ({ name }: { name: string }) => <i data-icon={name} /> }));
vi.mock('@/components/shell', () => ({
  DocPage: () => null,
  PhaseStrip: ({ rowLine, menuLine, workHeader }: { rowLine?: ReactNode; menuLine?: ReactNode; workHeader?: boolean }) =>
    <div data-testid="phase-strip" data-work-header={String(Boolean(workHeader))}><span data-slot="row">{rowLine}</span><details><div data-slot="menu">{menuLine}</div></details></div>,
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ PersonaPanel: (props: { guidedOnly?: boolean }) => { seen.mentor.push(props); return <div data-testid="persona-panel" data-guided-only={String(Boolean(props.guidedOnly))} />; } }));
vi.mock('@/lib/scenario', () => ({ useInterviewAbsent: () => false }));
vi.mock('@/components/workspace/QuickCheck', () => ({
  QuickCheckLine: ({ inline, menu }: { inline?: boolean; menu?: boolean }) => <span data-testid="quick-check-line" data-place={inline ? 'row' : menu ? 'menu' : 'band'} />,
  useClaimedQuickCheck: () => { seen.claims += 1; return null; },
}));
// The workspace header's own rule for where the line sits, answered by the test.
vi.mock('@/components/workspace/PhaseHeader', () => ({ useQuickCheckInMore: () => seen.inMore }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => <p data-testid="brief-intro">intro</p> }));
vi.mock('@/components/workspace/PhaseGateBanner', () => ({ ShellPhaseGateBanner: () => null }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' }),
  WorkspacePanelControls: ({ placement = 'row' }: { placement?: string }) => <div data-testid="panel-controls" data-placement={placement} />,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { appPreviewPaneOf, previewViewLabel } from '@/components/workspace/preview/rooms';

let root: Root, host: HTMLDivElement;
/** The width the room reads: from 1024 px it is three columns. */
const width = (wide: boolean) => {
  seen.wide = wide;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(min-width: 1024px)' ? seen.wide : false; }, media: query,
    addEventListener(_: string, listener: () => void) { seen.listeners.push(listener); },
    removeEventListener(_: string, listener: () => void) { seen.listeners = seen.listeners.filter((one) => one !== listener); },
  }));
};
/** The window crosses 1024 px while the page is open. */
const resizeTo = (wide: boolean) => act(() => { seen.wide = wide; seen.listeners.forEach((listener) => listener()); });
beforeEach(() => { seen.mentor.length = 0; seen.claims = 0; seen.inMore = false; seen.listeners = []; width(true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

type View = 'change' | 'pr' | 'matrix' | 'drill' | 'brief' | 'solution';
const draw = (phase: Record<string, unknown>, view: View, extra: { mentor?: ReactNode; mission?: ReactNode } = {}) =>
  act(() => root.render(<PhaseDocumentFrame phase={{ id: 'p-6', key: 'maintenance', title: 'Maintenance', ...phase } as any} view={view} title="Heading" {...extra}><p>body</p></PhaseDocumentFrame>));
const area = () => host.querySelector<HTMLElement>('nav[aria-label="Phase working area"]');
const entries = () => [...area()!.querySelectorAll(':scope > a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current'), a.querySelector('[data-icon]')?.getAttribute('data-icon')]);
const views = () => [...area()!.querySelectorAll(':scope > a')].map((a) => a.getAttribute('data-view'));
const controls = () => [...host.querySelectorAll<HTMLElement>('[data-testid="panel-controls"]')];

describe('the working-area row of a Maintenance document page is the workspace\'s own', () => {
  it('the change request: five addresses in the workspace\'s order, words and icons, Change request current', () => {
    draw({ canPreview: true }, 'change');
    expect([...area()!.classList]).toEqual(['implementation-view-tabs', 'runtime-view-tabs']);
    expect(entries()).toEqual([
      ['Change request', '/workspace/p-6/change', 'page', 'pr'],
      // Every view link names its view, Edit files too
      ['Edit files', '/workspace/p-6?panel=code', null, 'code'],
      ['Execution evidence', '/workspace/p-6?panel=evidence', null, 'testing'],
      ['App preview', '/workspace/p-6?panel=preview', null, 'run'],
      ['Pull request', '/workspace/p-6/pr', null, 'pr'],
    ]);
    // the three the workspace draws as buttons say which view they open; the two pages do not
    expect(views()).toEqual([null, 'code', 'evidence', 'preview', null]);
    // one working-area row, and it is not the older text row
    expect(host.querySelectorAll('nav[aria-label$="working area"]')).toHaveLength(1);
    expect(host.querySelector('.phase-document-center > nav.phase-room-nav')).toBeNull();
  });
  it('the pull request: the same row with Pull request current', () => {
    draw({ canPreview: true }, 'pr');
    expect(entries().map(([label, , current]) => [label, current])).toEqual([
      ['Change request', null], ['Edit files', null], ['Execution evidence', null], ['App preview', null], ['Pull request', 'page'],
    ]);
  });
  it('a room with no preview draws no preview entry, and a page preview is named Page preview', () => {
    draw({}, 'change');
    expect(entries().map(([label]) => label)).toEqual(['Change request', 'Edit files', 'Execution evidence', 'Pull request']);
    act(() => root.unmount()); root = createRoot(host);
    // an uploaded application with a page to draw: the page preview, with no App preview pane
    draw({ provenance: { application: null }, change: {}, files: [{ path: 'web/index.html' }] }, 'change');
    const preview = entries().find(([, href]) => href === '/workspace/p-6?panel=preview');
    expect(preview).toBeDefined();
    expect(preview![0]).toBe('Page preview');
    expect(previewViewLabel({ key: 'maintenance', canPreview: true })).toBe('App preview');
    expect(appPreviewPaneOf({ key: 'maintenance' })).toBe(false);
  });
});

describe('the frame around it is the workspace\'s', () => {
  it('from 1024 px the brief and mentor switches are the right end of the row, not a row of their own', () => {
    draw({}, 'change');
    expect(controls()).toHaveLength(1);
    expect(controls()[0].getAttribute('data-placement')).toBe('strip');
    expect(area()!.lastElementChild).toBe(controls()[0]);
  });
  it('below 1024 px the switches keep the row of their own, above the room', () => {
    width(false);
    draw({}, 'change');
    expect(controls()).toHaveLength(1);
    expect(controls()[0].getAttribute('data-placement')).toBe('row');
    expect(area()!.contains(controls()[0])).toBe(false);
    expect(controls()[0].nextElementSibling?.matches('.phase-document-room')).toBe(true);
    // and the left column is the plain brief box every document page has: no tabs, no inner scroller
    expect(host.querySelector('nav[aria-label="Phase context"]')).toBeNull();
    const brief = host.querySelector<HTMLElement>('[data-workspace-panel="brief"]')!;
    expect([...brief.classList]).toEqual(['phase-document-brief']);
    expect(brief.querySelector('.phase-workspace-context')).toBeNull();
    expect(brief.firstElementChild?.matches('[data-testid="brief-intro"]')).toBe(true);
    // the row's entries are the same at every width
    expect(entries().map(([label]) => label)).toEqual(['Change request', 'Edit files', 'Execution evidence', 'Pull request']);
  });
  it('a window that crosses 1024 px while the page is open moves the switches and the left column with it', () => {
    draw({}, 'change');
    expect(controls()[0].getAttribute('data-placement')).toBe('strip');
    resizeTo(false);
    expect(controls()).toHaveLength(1);
    expect(controls()[0].getAttribute('data-placement')).toBe('row');
    expect([...host.querySelector('[data-workspace-panel="brief"]')!.classList]).toEqual(['phase-document-brief']);
    resizeTo(true);
    expect(controls()[0].getAttribute('data-placement')).toBe('strip');
    expect(host.querySelector('nav[aria-label="Phase context"]')).not.toBeNull();
  });
  it('the left column holds the workspace\'s two tabs over the brief, which scrolls under them', () => {
    draw({}, 'change', { mission: <p data-testid="mission">mission</p> });
    const brief = host.querySelector<HTMLElement>('[data-workspace-panel="brief"]')!;
    expect([...brief.classList]).toEqual(['phase-document-brief', 'phase-document-brief--work']);
    const tabs = brief.querySelector('nav[aria-label="Phase context"]')!;
    expect([...tabs.classList]).toEqual(['phase-room-nav']);
    expect(tabs).toBe(brief.firstElementChild);
    // both are links: this page is the task's (current), and Files opens the file tree in the editor. No toggle
    // that is always pressed and does nothing.
    expect([...tabs.children].map((c) => [c.tagName, c.textContent, c.getAttribute('aria-current'), c.getAttribute('href')])).toEqual([
      ['A', 'Your task', 'page', '/workspace/p-6/change'],
      ['A', 'Files', null, '/workspace/p-6?panel=files'],
    ]);
    expect(tabs.querySelector('[aria-pressed]')).toBeNull();
    const content = brief.querySelector('.phase-workspace-context > .phase-task-content')!;
    expect(content.querySelector('[data-testid="brief-intro"]')).not.toBeNull();
    expect(content.querySelector('[data-testid="mission"]')).not.toBeNull();
  });
  it('the optional quick check is claimed for the header and sits on its row where the workspace header keeps it on its row', () => {
    seen.inMore = false;
    draw({}, 'change');
    expect(seen.claims).toBeGreaterThan(0);
    const strip = host.querySelector('[data-testid="phase-strip"]')!;
    expect(strip.getAttribute('data-work-header')).toBe('true');
    const lines = [...strip.querySelectorAll('[data-testid="quick-check-line"]')];
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('data-place')).toBe('row');
    // on the row, so in view and in the accessibility tree: not inside the closed Details
    expect(lines[0].closest('details')).toBeNull();
    expect(lines[0].closest('[data-slot="row"]')).not.toBeNull();
  });
  it('and inside the strip\'s Details where that header keeps it in More', () => {
    seen.inMore = true;
    draw({}, 'pr');
    const lines = [...host.querySelectorAll('[data-testid="phase-strip"] [data-testid="quick-check-line"]')];
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('data-place')).toBe('menu');
    expect(lines[0].closest('details')).not.toBeNull();
  });
  it('the pull request page\'s left tab names that page as the current one', () => {
    draw({}, 'pr');
    expect(host.querySelector('nav[aria-label="Phase context"] [aria-current="page"]')!.getAttribute('href')).toBe('/workspace/p-6/pr');
  });
  it('the mentor has both of its modes: the frame\'s own is not guided only', () => {
    draw({}, 'change');
    expect(seen.mentor.at(-1)?.guidedOnly).toBe(false);
    expect(host.querySelector('.phase-document-room')!.classList.contains('phase-document-room--work')).toBe(true);
  });
});

describe('every other document page keeps its frame', () => {
  it('a Maintenance whose door is not the change room (another kind than code) keeps the text row, the row of switches and the guided mentor', () => {
    draw({ artifactKind: 'document' }, 'pr');
    expect(area()).toBeNull();
    expect([...host.querySelectorAll('.phase-document-center > nav.phase-room-nav > a')].map((a) => a.textContent)).toEqual(['Change request', 'Edit files', 'Pull request']);
    expect(controls()[0].getAttribute('data-placement')).toBe('row');
    expect([...host.querySelector('[data-workspace-panel="brief"]')!.classList]).toEqual(['phase-document-brief']);
    expect(seen.mentor.at(-1)?.guidedOnly).toBe(true);
    expect(host.querySelector('.phase-document-room')!.classList.contains('phase-document-room--work')).toBe(false);
  });
  it('the brief and the solution of a Maintenance are not working-area pages: they keep the frame too', () => {
    for (const view of ['brief', 'solution'] as const) {
      draw({}, view);
      expect(area()).toBeNull();
      expect(controls()[0].getAttribute('data-placement')).toBe('row');
      act(() => root.unmount()); root = createRoot(host);
    }
  });
  // Implementation's pull request, Testing's planted bugs and Deployment's incident drill are drawn in the
  // workspace's frame too (read in work-frame); their briefs and solutions, and Requirements and Design, are not.
  it('the other phases: text row, row of switches, plain brief, guided mentor', () => {
    for (const [key, view] of [['requirements', 'brief'], ['design', 'brief'], ['implementation', 'brief'], ['testing', 'solution'], ['deployment', 'brief']] as const) {
      draw({ key, title: key }, view);
      expect(area()).toBeNull();
      expect(host.querySelector('.phase-document-center > nav.phase-room-nav')).not.toBeNull();
      expect(controls()).toHaveLength(1);
      expect(controls()[0].getAttribute('data-placement')).toBe('row');
      expect([...host.querySelector('[data-workspace-panel="brief"]')!.classList]).toEqual(['phase-document-brief']);
      expect(host.querySelector('nav[aria-label="Phase context"]')).toBeNull();
      expect(seen.mentor.at(-1)?.guidedOnly).toBe(true);
      // the offer is not claimed: the phase layout keeps its row for these pages, and the strip is not the work header
      expect(seen.claims).toBe(0);
      expect(host.querySelector('[data-testid="quick-check-line"]')).toBeNull();
      expect(host.querySelector('[data-testid="phase-strip"]')!.getAttribute('data-work-header')).toBe('false');
      act(() => root.unmount()); root = createRoot(host);
    }
  });
});

describe('the document header\'s row has room for the quick check', () => {
  it('from 1280 to 1365 px the count steps out of the line on these pages, as it does under 1280 px on every header', () => {
    const css = webSource('components/workspace/phase-experience.css');
    expect(css).toContain('@media(min-width:1280px) and (max-width:1365px){.phase-header--doc>.quick-check-line-inline [data-testid=concept-prompt-body]{display:none}}');
    expect(css).toMatch(/@media\(max-width:1279px\)\{[^}]*\.quick-check-line-inline \[data-testid=concept-prompt-body\]\{display:none\}/);
  });
});

describe('the preview view has one name on every page', () => {
  it('the workspace names its preview view by the row\'s own helpers', () => {
    const page = closureText('app/(app)/workspace/[phaseId]/page.tsx');
    expect(page).toContain('const appPreviewPane = appPreviewPaneOf(detail);');
    expect(page).toContain('const previewLabel = previewViewLabel(detail);');
    const rooms = moduleText('appPreviewPaneOf');
    expect(rooms).toContain("return kind === 'server' || (kind === 'client' && previewOffered(phase));");
    expect(rooms).toContain("return appPreviewPaneOf(phase) ? 'App preview' : 'Page preview';");
    // the reference application with its sandbox, the same where the sandbox cannot run, an uploaded page, and no preview
    expect(previewViewLabel({ key: 'maintenance', canPreview: true })).toBe('App preview');
    expect(previewViewLabel({ key: 'maintenance', canPreview: true, previewUnsupported: 'lambda' as never, files: [{ path: 'web/index.html' }] })).toBe('App preview');
    expect(appPreviewPaneOf({ key: 'maintenance', canPreview: false })).toBe(false);
  });
});

describe('the styles that make the two frames one', () => {
  const css = webSource('components/workspace/phase-experience.css');
  it('the current page of the row reads as the workspace\'s pressed view', () => {
    const pressed = css.match(/\.implementation-view-tabs>button\[aria-pressed=true\]\{([^}]*)\}/g)!.at(-1)!.replace(/^[^{]*\{/, '{');
    const current = css.match(/\.runtime-view-tabs>a\[aria-current=page\]\{[^}]*\}/)![0].replace(/^[^{]*\{/, '{');
    expect(current).toBe(pressed);
  });
  it('the left column scrolls under its tabs from 1024 px, and a link to a workspace view takes the view button\'s padding', () => {
    // both rules of the work column live inside the 1024 px query: under it the brief box keeps its own padding
    expect(css).toMatch(/@media\(min-width:1024px\)\{\s*\.phase-document-brief\.phase-document-brief--work\{padding:0\}\s*\.phase-document-brief\.phase-document-brief--work:not\(\[hidden\]\)\{display:flex;flex-direction:column;overflow:hidden;min-width:0;min-height:0\}\s*\}/);
    expect(css.match(/\.phase-document-brief\.phase-document-brief--work\{padding:0\}/g)).toHaveLength(1);
    const button = css.match(/\.implementation-view-tabs>button\{[^}]*padding:6px (\d+px)[^}]*\}/)![1];
    expect(css).toContain(`:where(.runtime-view-tabs)>a[data-view]{padding-inline:${button}}`);
    // the mentor column is the document room's own 340 px, the workspace's from 1280 px; under it the workspace's 320 px
    expect(css).toContain('@media(min-width:1024px) and (max-width:1279px){.phase-document-room--work>.phase-document-mentor{width:320px;flex-basis:320px}}');
    expect(css.match(/phase-document-room--work>\.phase-document-mentor/g)).toHaveLength(1);
  });
});
