// @vitest-environment jsdom
/**
 * One Maintenance navigation order. The real document frame draws one
 * working-area row with the current page marked, and a room's own sections
 * (the change page's Request, Contract, Checks, Release) as a second, labelled
 * row under the heading. That row is the workspace's own, entry for
 * entry (Change request, Edit files, Execution evidence, the preview where the
 * phase has one, Pull request): it is read in full in maintenance-frame.
 * Requirements' and Design's frame rows keep their words and order; the
 * other code phases' pages draw their workspace's row too. The
 * workspace's row is read in work-room-header.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/components/shell', () => ({
  DocPage: () => null,
  PhaseStrip: () => <div data-testid="phase-strip" />,
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ PersonaPanel: () => null }));
vi.mock('@/lib/scenario', () => ({ useInterviewAbsent: () => false }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/PhaseGateBanner', () => ({ ShellPhaseGateBanner: () => null }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' }),
  WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Key = 'requirements' | 'design' | 'implementation' | 'testing' | 'deployment' | 'maintenance';
const draw = (key: Key, view: 'change' | 'pr' | 'matrix' | 'drill' | 'brief', extra: { toolNav?: ReactNode; subNav?: ReactNode } = {}) =>
  act(() => root.render(<PhaseDocumentFrame phase={{ id: 'p-6', key, title: 'Maintenance' }} view={view} title="Heading" {...extra}><p>body</p></PhaseDocumentFrame>));
const working = () => host.querySelectorAll('nav[aria-label$="working area"]');
const row = () => [...working()[0].children].map((c) => [c.textContent, c.getAttribute('aria-current')]);

describe('the document frame\'s Maintenance row', () => {
  it('the review page: Change request, Edit files, Execution evidence, Pull request, with Pull request current', () => {
    draw('maintenance', 'pr');
    expect(working()).toHaveLength(1);
    expect(row()).toEqual([['Change request', null], ['Edit files', null], ['Execution evidence', null], ['Pull request', 'page']]);
    expect([...working()[0].querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/workspace/p-6/change', '/workspace/p-6?panel=code', '/workspace/p-6?panel=evidence', '/workspace/p-6/pr']);
  });

  it('a room\'s sections are a second, labelled row under the heading, outside the working-area row', () => {
    draw('maintenance', 'change', {
      subNav: <nav className="phase-room-nav" aria-label="Change request sections"><button type="button" aria-pressed>Request</button></nav>,
    });
    expect(working()).toHaveLength(1);
    expect(row()).toEqual([['Change request', 'page'], ['Edit files', null], ['Execution evidence', null], ['Pull request', null]]);
    const sections = host.querySelector('nav[aria-label="Change request sections"]')!;
    expect(working()[0].contains(sections)).toBe(false);
    expect(sections.previousElementSibling?.matches('header.phase-document-heading')).toBe(true);
    expect(sections.nextElementSibling?.matches('.phase-document-content')).toBe(true);
  });

  it('Requirements\' and Design\'s frame rows keep their words and order', () => {
    const rows: Record<string, (string | null)[]> = {};
    for (const [key, view] of [['requirements', 'brief'], ['design', 'brief']] as const) {
      draw(key, view);
      rows[key] = [...working()[0].children].map((c) => c.textContent);
    }
    expect(rows).toEqual({
      requirements: ['Stakeholder interview', 'Case file', 'My backlog'],
      design: ['Design workspace', 'Case file'],
    });
  });

  // The other code phases' document pages draw their workspace's row too (read in full in work-frame),
  // where they drew three text links of their own ("Code and preview, Pull request"; "Write tests, Planted bugs,
  // Reviews"; "Pipeline, Incident drill, Reviews").
  it('Implementation, Testing and Deployment draw their workspace\'s row, with the page marked current', () => {
    const rows: Record<string, (string | null)[][]> = {};
    for (const [key, view] of [['implementation', 'pr'], ['testing', 'matrix'], ['deployment', 'drill']] as const) {
      draw(key, view);
      expect(working()).toHaveLength(1);
      rows[key] = [...working()[0].children].map((c) => [c.textContent, c.getAttribute('aria-current')]);
    }
    expect(rows).toEqual({
      // Implementation's file tree is the left column's Files tab, not a row entry, on the workspace and here.
      implementation: [['Code', null], ['Split', null], ['Pull request', 'page'], ['Saved workspace', null]],
      // "Pull request" in every code phase's row (Testing and Deployment said "Reviews").
      testing: [['Write tests', null], ['Execution evidence', null], ['Planted bugs', 'page'], ['Pull request', null]],
      deployment: [['Configuration', null], ['Pipeline', null], ['Incident drill', 'page'], ['Pull request', null]],
    });
  });
});

describe('the sections row reads as the page\'s own, under the room\'s row', () => {
  const css = readFileSync(path.join(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
  it('the modifier is shorter than the 46 px row, flat (no tint, border or shadow), and outranks the shared toolbar rule', () => {
    const rule = css.match(/\.phase-room-nav\.phase-room-nav--sections\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/min-height:34px/);
    expect(rule).toMatch(/background:none/);
    expect(rule).toMatch(/border-bottom:0/);
    expect(rule).toMatch(/box-shadow:none/);
    expect(css).toMatch(/\.phase-room-nav\{display:flex;gap:18px;padding:0 17px;min-height:46px/);
    // Two classes (0,2,0) beat the shared toolbar's :is(..., .phase-case-file>nav) (0,1,1), and it comes later.
    expect(css.lastIndexOf('.phase-room-nav.phase-room-nav--sections{')).toBeGreaterThan(css.lastIndexOf(':is(.implementation-view-tabs,.design-tool-tabs,.phase-room-nav,.phase-case-file>nav){'));
  });
});
