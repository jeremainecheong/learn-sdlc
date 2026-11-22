// @vitest-environment jsdom
/**
 * At 200 per cent zoom on a
 * 1920 by 1080 window (960 by 470 to 540 CSS px) the Deployment room stacked
 * the top bar, a two-line header (the quick check on a row of its own), a
 * two-line "Ready to continue" band, a row holding only Show brief and Show
 * mentor, the pane switcher, the view tabs, the file tabs and the file's path
 * above the editor, which kept about three lines.
 *
 * What answers it, held here (jsdom lays nothing out; the browser e2e in
 * workspace-viewport.spec.ts measures the boxes):
 * - the quick check is one item inside More from 701 to 1023 px wide and at
 *   660 px tall or less, never on a phone, never on a tall wide window;
 * - at 660 px tall or less (from 701 px wide) the file's path row goes and the
 *   ready band is one line, its sentence cut by CSS with the whole sentence in
 *   its title and its text;
 * - in the code pane the panel switches' own row is drawn only while the pane
 *   switcher is not (the switcher's Brief and Mentor say the same); on the
 *   Brief, Files or Mentor pane under 1024 px the row is drawn, so Hide brief
 *   and Hide mentor stay reachable.
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closureText, webSource } from './support/source-text';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/workspace/p1', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/shell/PhaseTutorial', () => ({ PhaseTutorialReplay: () => <button type="button" data-testid="phase-tutorial-replay">Replay tutorial</button> }));

import { PhaseHeader, QUICK_CHECK_IN_MORE } from '@/components/workspace/PhaseHeader';
import { phaseTutorialMarks } from '@/components/shell/tours';
import { WorkspacePanelControls } from '@/components/workspace/WorkspacePanels';
import type { QuickCheckOffer } from '@/components/workspace/QuickCheck';

const css = webSource('components/workspace/phase-experience.css');
// The work room's conditions and the band's sentence are read from the modules that hold them, wherever the room
// and the band are split to (see support/source-text.ts).
const page = closureText('app/(app)/workspace/[phaseId]/page.tsx');
const banner = closureText('PhaseGateBanner');
const SHORT = '@media(min-width:701px) and (max-height:660px)';
/**
 * The short-window rules run from the quick check's place inside More to the end of the stylesheet. They are found
 * by their first selector, never by the comment above them, so rewording that comment cannot move what is read.
 */
const shortWindowRules = (): string => {
  const at = css.indexOf('.quick-check-line.quick-check-line-menu{');
  expect(at, 'the first short-window rule').toBeGreaterThan(-1);
  return css.slice(at);
};

/** Whether a window of this CSS size matches a media list of `(min|max-width|height:Npx)` terms joined by `and`, alternatives by commas. */
function matches(query: string, width: number, height: number): boolean {
  return query.split(',').some((alternative) => [...alternative.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)].every(([, side, axis, n]) => {
    const value = axis === 'width' ? width : height;
    return side === 'min' ? value >= Number(n) : value <= Number(n);
  }));
}

describe('where the quick check sits', () => {
  it('in More from 701 to 1023 px wide, and from 1024 to 1279 px wide at 660 px tall or less', () => {
    for (const [w, h] of [[960, 540], [960, 470], [960, 1080], [701, 900], [1023, 900], [1152, 648], [1093, 614], [1152, 660], [1279, 660]]) {
      expect(matches(QUICK_CHECK_IN_MORE, w, h), `${w} by ${h}`).toBe(true);
    }
  });
  it('on the row on every phone, on every window at least 1024 px wide and over 660 px tall (the stage look, the e2e default 1280 by 720), and from 1280 px wide at any height (one header line holds it there)', () => {
    for (const [w, h] of [[360, 640], [390, 844], [700, 400], [1024, 661], [1280, 661], [1280, 660], [1280, 700], [1366, 650], [1366, 660], [1440, 690], [1440, 660], [1920, 527], [1280, 720], [1280, 800], [1366, 768], [1440, 900], [1440, 790], [1440, 725], [1440, 700], [1440, 691], [1440, 661], [1800, 1000], [1920, 1080]]) {
      expect(matches(QUICK_CHECK_IN_MORE, w, h), `${w} by ${h}`).toBe(false);
    }
  });
  it('the two ranges meet the row\'s own at 1024 px wide and 660 px tall, with no gap and no overlap', () => {
    for (const h of [500, 660, 661, 1000]) {
      expect(matches(QUICK_CHECK_IN_MORE, 1023, h)).toBe(true);
      expect(matches(QUICK_CHECK_IN_MORE, 1024, h)).toBe(h <= 660);
    }
    // 660 applies, 661 does not; 1279 applies, 1280 does not.
    expect(matches(QUICK_CHECK_IN_MORE, 1152, 660)).toBe(true);
    expect(matches(QUICK_CHECK_IN_MORE, 1152, 661)).toBe(false);
    expect(matches(QUICK_CHECK_IN_MORE, 1279, 500)).toBe(true);
    expect(matches(QUICK_CHECK_IN_MORE, 1280, 500)).toBe(false);
    expect(matches(QUICK_CHECK_IN_MORE, 700, 500)).toBe(false);
    expect(matches(QUICK_CHECK_IN_MORE, 701, 500)).toBe(true);
  });
  it('the short-window CSS rules use the same height and width bounds: 660 applies, 661 does not', () => {
    expect(matches(SHORT, 960, 660)).toBe(true);
    expect(matches(SHORT, 960, 661)).toBe(false);
    expect(matches(SHORT, 1440, 660)).toBe(true);
    expect(matches(SHORT, 1440, 661)).toBe(false);
    expect(matches(SHORT, 700, 500)).toBe(false);
    // Every height bound in the short-window block, and the quick check's, is 660: no rule
    // starts at another height, so the short layout and the tall one meet at 660 / 661.
    const s13 = shortWindowRules();
    const cssHeights = [...s13.matchAll(/max-height:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(cssHeights).toEqual([660, 660, 660]);
    expect(s13).not.toMatch(/min-height:\s*\d+px\)/);
    expect([...QUICK_CHECK_IN_MORE.matchAll(/max-height:\s*(\d+)px/g)].map((m) => Number(m[1]))).toEqual([660]);
  });
});

describe('PhaseHeader draws the quick check in one place at a time', () => {
  let host: HTMLDivElement;
  let root: Root;
  let match = false;
  const putAway = vi.fn();
  const offer: QuickCheckOffer = { phaseId: 'p1', kind: 'after', questions: 6, putAway };
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query === QUICK_CHECK_IN_MORE && match, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    putAway.mockReset();
  });
  const draw = () => act(() => root.render(
    <PhaseHeader phase={{ key: 'deployment', title: 'Deployment' }} place="Phase 5 of 6" state="reviewPassed" quickCheck={offer} primary={<button type="button" data-testid="header-submit">Submit PR-5</button>} />,
  ));

  it('on the row where the window is tall and wide: not in More', () => {
    match = false;
    draw();
    expect(host.querySelectorAll('[data-testid="concept-prompt"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="phase-strip"] > [data-testid="concept-prompt"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="phase-more"] [data-testid="concept-prompt"]')).toBeNull();
  });

  it('inside More where the window is short or narrow: one item, the same words and buttons, and Later puts it away', () => {
    match = true;
    draw();
    expect(host.querySelectorAll('[data-testid="concept-prompt"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="phase-strip"] > [data-testid="concept-prompt"]')).toBeNull();
    const item = host.querySelector('[data-testid="phase-more"] .phase-strip-detail-panel [data-testid="concept-prompt"]')!;
    expect(item).not.toBeNull();
    expect(item.className).toContain('quick-check-line-menu');
    expect(item.className).not.toContain('quick-check-line-inline');
    expect(item.querySelector('[data-testid="concept-prompt-optional"]')!.textContent).toBe('Optional');
    expect(item.querySelector('[data-testid="concept-prompt-title"]')!.textContent).toBe('What did you learn?');
    expect(item.querySelector('[data-testid="concept-prompt-start"]')!.textContent).toBe('Take the quick check');
    expect(item.querySelector('[data-testid="concept-prompt-start"]')!.getAttribute('href')).toMatch(/\/workspace\/p1\/concept\?kind=after$/);
    act(() => (item.querySelector('[data-testid="concept-prompt-skip"]') as HTMLButtonElement).click());
    expect(putAway).toHaveBeenCalledTimes(1);
    // Later closes More and gives keyboard focus back to its toggle.
    expect(document.activeElement).toBe(host.querySelector('[data-testid="phase-more-toggle"]'));
    // The place, the chip and the primary stay on the row.
    expect(host.querySelector('[data-testid="phase-strip"] > [data-testid="phase-place"]')!.textContent).toBe('Phase 5 of 6');
    expect(host.querySelector('[data-testid="phase-strip"] > [data-testid="phase-state"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="phase-strip"] .phase-strip-primary [data-testid="header-submit"]')).not.toBeNull();
  });

  it('a document with no matchMedia keeps the line on the row', () => {
    const saved = window.matchMedia;
    // @ts-expect-error a host without matchMedia
    delete window.matchMedia;
    try {
      draw();
      expect(host.querySelector('[data-testid="phase-strip"] > [data-testid="concept-prompt"]')).not.toBeNull();
    } finally {
      window.matchMedia = saved;
    }
  });
});

/** The body of the one media block that opens with `head` and holds `inside`. */
function block(head: string, inside: string): string {
  let from = 0;
  for (;;) {
    const at = css.indexOf(head, from);
    expect(at, `${head} holding ${inside}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}' && --depth === 0) {
        const body = css.slice(at, i + 1);
        if (body.includes(inside)) return body;
        from = i;
        break;
      }
    }
  }
}

describe('at 660 px tall or less, from 701 px wide', () => {
  it('the file\'s path row under the file tabs goes (the tab names the file, its title the path)', () => {
    expect(block(SHORT, '.phase-code-surface>.mono')).toMatch(/\.phase-code-surface>\.mono\{display:none\}/);
    expect(page).toMatch(/title=\{f\.editable \? f\.path : `\$\{f\.path\} \(read only\)`\}/);
  });
  it('the ready band is one line: the sentence is cut by CSS, View review and Continue keep their size on the line', () => {
    const rule = block(SHORT, '.phase-gate-sentence');
    expect(rule).toMatch(/\.phase-gate-banner:has\(>\.phase-gate-sentence\)\{flex-wrap:nowrap\}/);
    expect(rule).toMatch(/\.phase-gate-banner>\.phase-gate-sentence\{[^}]*white-space:nowrap[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
    expect(rule).toMatch(/\.phase-gate-banner:has\(>\.phase-gate-sentence\)>span\{flex:none;flex-wrap:nowrap\}/);
    // No font size, line height or display:none on the band anywhere in the rule.
    expect(rule).not.toMatch(/font-size|line-height|display:none/);
  });
  it('no short-window rule makes text smaller or hides anything but the path row', () => {
    const s13 = shortWindowRules();
    expect(s13).not.toMatch(/font-size|font:|line-height/);
    expect(s13.match(/display:none/g)).toHaveLength(1);
  });
  it('the band keeps its whole sentence in the title and in its text (assistive technology reads it all)', () => {
    expect(banner).toMatch(/className="phase-gate-sentence[^"]*" title=\{readySentence\}/);
    expect(banner).toMatch(/const readySentence = `\$\{STATE_LABEL\.ready\}\. \$\{readyRest\}`/);
    // The first sentence is "Phase evidence accepted." or, after a sign-off, "Your teacher signed off <task>.".
    expect(banner).toMatch(/const accepted = signed\.length \? `Your teacher signed off \$\{andList\(signed\)\}\.` : 'Phase evidence accepted\.';/);
    expect(banner).toMatch(/const readyRest = `\$\{accepted\} \$\{phase\.reflection \? 'Merge message recorded\.' : isLast \? 'Complete the project when ready; a reflection is optional\.' : 'Continue when ready; a reflection is optional\.'\}`/);
  });
});

describe('the panel switches and the pane switcher', () => {
  it('the switches: the view tabs\' right end from 701 px and their own row on a phone while the pane switcher is not up, and their own row on a side pane under 1024 px (Hide brief, Hide mentor)', () => {
    expect(page).toMatch(/const paneSwitcherShown = !\(pane === 'code' && !panels\.briefOpen && !panels\.mentorOpen\);/);
    expect(page).toMatch(/const phoneWorkspaceSnapshot = \(\) => window\.matchMedia\('\(max-width: 700px\)'\)\.matches;/);
    expect(page).toMatch(/\{narrowWorkspace && \(pane !== 'code' \|\| \(phoneWorkspace && !paneSwitcherShown\)\) && <WorkspacePanelControls panels=\{rowPanels\} onReveal=\{revealPanel\} \/>\}/);
    expect(page).toMatch(/refocusAfterHide\('Show brief'\)/); expect(page).toMatch(/refocusAfterHide\('Show mentor'\)/);
    expect(page).toMatch(/\{\(!narrowWorkspace \|\| \(!phoneWorkspace && !paneSwitcherShown\)\) && <WorkspacePanelControls panels=\{visiblePanels\} onReveal=\{revealPanel\} placement="strip" \/>\}/);
    // The switcher is hidden by exactly the strip's condition; on a side pane the row is drawn, so Hide is reachable.
    expect(page).toMatch(/workspace-pane-switcher shrink-0[^`]*\$\{\s*!paneSwitcherShown\s*\?\s*'hidden'/);
  });
  it('the three ranges meet, read from the page\'s own conditions: from 1024 px the strip; 701 to 1023 px the strip while the switcher is down; a phone the row while the switcher is down; under 1024 px on a side pane the row', () => {
    const strip = page.match(/\{(\(!narrowWorkspace[^}]*?\))\s*&&\s*<WorkspacePanelControls[^>]*placement="strip"/)![1];
    const row = page.match(/\{(narrowWorkspace && \([^}]*?\)|phoneWorkspace[^}]*?)\s*&&\s*<WorkspacePanelControls panels=\{rowPanels\} onReveal=\{revealPanel\} \/>\}/)![1];
    const f = (src: string) => new Function('narrowWorkspace', 'phoneWorkspace', 'paneSwitcherShown', 'pane', `return (${src});`) as (n: boolean, p: boolean, s: boolean, pane: string) => boolean;
    const drawn = (width: number, switcher: boolean, pane: string) => {
      const args = [width <= 1023, width <= 700, switcher, pane] as const;
      return { strip: Boolean(f(strip)(...args)), row: Boolean(f(row)(...args)) };
    };
    for (const w of [701, 960, 1023]) {
      expect(drawn(w, false, 'code'), `${w}, switcher down`).toEqual({ strip: true, row: false });
      // In the code pane with the switcher up, its Brief and Mentor stand in for the switches.
      expect(drawn(w, true, 'code'), `${w}, switcher up, code pane`).toEqual({ strip: false, row: false });
      for (const pane of ['task', 'files', 'panel', 'preview']) expect(drawn(w, true, pane), `${w}, ${pane} pane`).toEqual({ strip: false, row: true });
    }
    for (const w of [360, 390, 700]) {
      expect(drawn(w, false, 'code'), `${w}, switcher down`).toEqual({ strip: false, row: true });
      expect(drawn(w, true, 'code'), `${w}, switcher up, code pane`).toEqual({ strip: false, row: false });
      for (const pane of ['task', 'panel']) expect(drawn(w, true, pane), `${w}, ${pane} pane`).toEqual({ strip: false, row: true });
    }
    for (const w of [1024, 1440]) {
      for (const switcher of [false, true]) expect(drawn(w, switcher, 'code'), `${w}`).toEqual({ strip: true, row: false });
    }
  });
  it('from 701 to 1023 px the switches take the right end of the view tabs, as from 1024 px', () => {
    expect(css).toContain('@media(min-width:701px) and (max-width:1023px){.implementation-view-tabs>span:not(.focus-switch)+.workspace-panel-controls-strip{margin-left:auto}}');
    // ...after the rule it overrides, so it wins the cascade.
    expect(css.indexOf('@media(min-width:701px) and (max-width:1023px){.implementation-view-tabs>span:not(.focus-switch)+.workspace-panel-controls-strip{margin-left:auto}}')).toBeGreaterThan(css.indexOf('.implementation-view-tabs>span:not(.focus-switch)+.workspace-panel-controls-strip{margin-left:8px}'));
  });
  it('from 701 to 767 px the switches in the view tabs keep a 44 px touch target, as on their own row, after the strip\'s 32 px rule', () => {
    const rule = '@media(min-width:701px) and (max-width:767px){.workspace-panel-controls.workspace-panel-controls-strip button{min-height:44px}}';
    expect(css).toContain(rule);
    expect(css.indexOf(rule)).toBeGreaterThan(css.indexOf('.workspace-panel-controls.workspace-panel-controls-strip button{min-height:32px;font-size:12px}'));
    const panelsCss = webSource('components/workspace/WorkspacePanels.css');
    expect(panelsCss).toMatch(/@media\(max-width:767px\)\{[^}]*\}\.workspace-panel-controls button\{min-height:44px/);
  });
  it('at 660 px tall or less the pane switcher keeps 4 px above and below its tabs (the tabs keep their size)', () => {
    expect(block(SHORT, '.workspace-pane-switcher')).toMatch(/\.workspace-pane-switcher\{padding-block:4px\}/);
  });
});

describe('the tutorial still finds the panels step under 1024 px with the pane switcher up', () => {
  const SWITCHER = '[role="tablist"][aria-label="Workspace pane"]';
  it('the code rooms\' "Keep the brief close" step falls back to the pane switcher', () => {
    for (const key of ['implementation', 'testing'] as const) {
      const step = phaseTutorialMarks(key).find((mark) => mark.target === `${key}-tutorial-panels`)!;
      expect(step.selector).toBe('.workspace-panel-controls[aria-label="Workspace panels"]');
      expect(step.fallbackSelector).toBe(SWITCHER);
    }
    // An own application's first Maintenance step aims at the change request where the page draws one,
    // and only where the room draws none at the panel switches, then at the pane switcher.
    const own = phaseTutorialMarks('maintenance', true, { application: null } as never).find((mark) => mark.target === 'maintenance-tutorial-change')!;
    expect(own.selector).toBe('[data-testid="change-title"]');
    expect([own.fallbackSelector].flat().slice(-2)).toEqual(['.workspace-panel-controls[aria-label="Workspace panels"]', SWITCHER]);
  });
  it('the fallback matches the switcher the room draws (useTabs\' tablist, labelled "Workspace pane")', () => {
    expect(page).toMatch(/const paneTabs = useTabs\(\{[\s\S]*?label: 'Workspace pane',/);
    expect(page).toMatch(/<div \{\.\.\.paneTabs\.tablistProps\}/);
  });
});

describe('keyboard focus after Hide brief or Hide mentor under 1024 px (the row goes with the side pane)', () => {
  // The room under test is a small stand-in for the work room's chrome: the
  // real WorkspacePanelControls, drawn where the page's own conditions say
  // (read from page.tsx), the row given whatever page.tsx passes it (and, when
  // that is rowPanels, page.tsx's own definition of it), the pane switcher's
  // Code tab, and the strip inside the code surface (hidden on a side pane).
  const condition = (re: RegExp) => new Function('narrowWorkspace', 'phoneWorkspace', 'paneSwitcherShown', 'pane', `return (${page.match(re)![1]});`) as (n: boolean, p: boolean, s: boolean, pane: string) => boolean;
  const strip = condition(/\{(\(!narrowWorkspace[^}]*?\))\s*&&\s*<WorkspacePanelControls[^>]*placement="strip"/);
  const row = condition(/\{(narrowWorkspace && \([^}]*?\))\s*&&\s*<WorkspacePanelControls panels=\{\w+\} onReveal=\{revealPanel\} \/>\}/);
  const rowProp = page.match(/&&\s*<WorkspacePanelControls panels=\{(\w+)\} onReveal=\{revealPanel\} \/>\}/)![1];
  const rowSource = page.match(/\n  const refocusAfterHide = [\s\S]*?\n  const rowPanels = [\s\S]*?\n  \};\n/)?.[0] ?? '';
  const makeRow = new Function('panels', 'visiblePanels', `${ts.transpileModule(rowSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn ${rowProp};`) as (panels: object, visible: object) => Parameters<typeof WorkspacePanelControls>[0]['panels'];

  function Room({ width, start }: { width: number; start: 'task' | 'panel' }) {
    const [briefOpen, setBriefOpen] = useState(true);
    const [mentorOpen, setMentorOpen] = useState(true);
    const [requested, setRequested] = useState<string>(start);
    const narrow = width <= 1023;
    const phone = width <= 700;
    const pane = ((requested === 'task' || requested === 'files') && !briefOpen) || ((requested === 'panel' || requested === 'preview') && !mentorOpen) ? 'code' : requested;
    const panels = { briefOpen, mentorOpen, setBriefOpen, setMentorOpen, briefId: 'b', mentorId: 'm' };
    const visiblePanels = { ...panels, briefOpen: briefOpen && (!narrow || pane === 'task' || pane === 'files'), mentorOpen: mentorOpen && (!narrow || pane === 'panel' || pane === 'preview') };
    const switcher = !(pane === 'code' && !briefOpen && !mentorOpen);
    const reveal = (panel: 'brief' | 'mentor') => setRequested(panel === 'brief' ? 'task' : 'panel');
    return <>
      {row(narrow, phone, switcher, pane) && <WorkspacePanelControls panels={makeRow(panels, visiblePanels)} onReveal={reveal} />}
      <div className={switcher ? '' : 'hidden'}>
        <button type="button" data-testid="pane-task" onClick={() => { setBriefOpen(true); setRequested('task'); }}>Brief</button>
        <button type="button" data-testid="pane-code" onClick={() => setRequested('code')}>Code</button>
        <button type="button" data-testid="pane-panel" onClick={() => { setMentorOpen(true); setRequested('panel'); }}>Mentor</button>
      </div>
      <div className={pane === 'code' ? '' : 'hidden'} data-testid="code-surface">
        {strip(narrow, phone, switcher, pane) && <WorkspacePanelControls panels={visiblePanels} onReveal={reveal} placement="strip" />}
      </div>
    </>;
  }

  let host: HTMLDivElement;
  let root: Root;
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  beforeEach(() => {
    // jsdom lays nothing out: an element is laid out unless it sits in a `hidden` box.
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get(this: HTMLElement) { return this.closest('.hidden') ? null : document.body; } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
    else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
  });
  const button = (name: string, within: ParentNode = host) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === name && el.offsetParent !== null)!;
  const press = async (el: HTMLElement) => {
    expect(el).toBeTruthy();
    await act(async () => { el.focus(); el.click(); });
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  };
  const focused = () => document.activeElement as HTMLElement;
  const describeFocus = () => `${focused().tagName} ${focused().dataset.testid ?? ''} ${focused().textContent?.trim() ?? ''}`;

  it.each([960, 701, 1023])('at %i px: Hide brief puts focus on Code (the mentor still open), then Hide mentor on the strip\'s Show mentor', async (width) => {
    act(() => root.render(<Room width={width} start="task" />));
    await press(button('Hide brief'));
    expect(focused().dataset.testid, describeFocus()).toBe('pane-code');
    await press(host.querySelector<HTMLElement>('[data-testid="pane-panel"]')!);
    await press(button('Hide mentor'));
    const strip = host.querySelector('.workspace-panel-controls-strip')!;
    expect(strip, 'both closed, the strip is in the view tabs').toBeTruthy();
    expect(focused(), describeFocus()).toBe(button('Show mentor', strip));
    expect(focused().offsetParent).not.toBeNull();
  });

  it.each([390, 700])('at %i px (phone): Hide brief or Hide mentor with the other side open puts focus on Code; the last Hide keeps it on the same switch', async (width) => {
    act(() => root.render(<Room width={width} start="panel" />));
    await press(button('Hide mentor'));
    expect(focused().dataset.testid, describeFocus()).toBe('pane-code');
    await press(host.querySelector<HTMLElement>('[data-testid="pane-task"]')!);
    await press(button('Hide brief'));
    // Both closed: on a phone the row stays (the switcher is down), its switch now reads Show brief.
    expect(focused(), describeFocus()).toBe(button('Show brief'));
    expect(focused().closest('.workspace-panel-controls-strip')).toBeNull();
  });

  it('at 390 px from the Brief pane: Hide brief with the mentor open puts focus on Code', async () => {
    act(() => root.render(<Room width={390} start="task" />));
    await press(button('Hide brief'));
    expect(focused().dataset.testid, describeFocus()).toBe('pane-code');
  });
});
