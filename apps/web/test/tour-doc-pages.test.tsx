// @vitest-environment jsdom
/**
 * The phase tours on the document pages drawn in the workspace's
 * frame, walked by the real CoachMarks over the real strip (laid out as the
 * workspace's header) and the real working-area row.
 *
 * - No document page draws Run (`header-run`), and the planted bugs and the
 *   incident drill draw no `header-submit`; the fallback, `.phase-room-nav`,
 *   is on these pages the left column's "Your task | Files". The run step lands on the row's edit entry, the review step on the
 *   page's own Submit where it has one and on the row's review page otherwise.
 * - Replay tutorial and the phase guide are inside the
 *   strip's closed Details and the page has no More toggle, so the last step
 *   lands on that Details' summary, with or without the guide.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';

const lessons = vi.hoisted(() => ({ on: true }));
vi.mock('next/link', () => ({ default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/schedule', () => ({ useNow: () => null, isPast: () => false, dueLine: () => '' }));
vi.mock('@/lib/useProject', () => ({ useProjectMaybe: () => null }));
vi.mock('@/lib/scenario', () => ({ lessonsOfferedOn: () => lessons.on }));
vi.mock('@/components/shell/ShellProvider', () => ({ useShellConfig: () => undefined }));
vi.mock('@/components/shell/PhaseTutorial', () => ({ PhaseTutorialReplay: () => <button type="button" data-testid="phase-tutorial-replay">Replay tutorial</button> }));

import { PhaseStrip } from '@/components/shell/WorkPage';
import { CoachMarks } from '@/components/shell/CoachMarks';
import { PhaseAreaNav, type AreaPage } from '@/components/workspace/AreaNav';
import { phaseTutorialMarks } from '@/components/shell/tours';

const realRect = Element.prototype.getBoundingClientRect;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;
const realScroll = Element.prototype.scrollIntoView;
let root: Root, host: HTMLDivElement;
/** Every element has its own box (its place in the document), so the highlight says which one a step landed on. */
let order: Element[] = [];
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const left = 10 * (order.indexOf(this) + 1);
    return { top: 20, left, right: left + 8, bottom: 40, width: 8, height: 20, x: left, y: 20, toJSON() {} } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); localStorage.clear();
  Element.prototype.getBoundingClientRect = realRect; Element.prototype.scrollIntoView = realScroll;
  HTMLDialogElement.prototype.showModal = realShow; HTMLDialogElement.prototype.close = realClose;
});

const TITLE: Record<string, string> = { implementation: 'Implementation', testing: 'Testing', deployment: 'Deployment', maintenance: 'Maintenance' };
/** A document page in the workspace's frame: the strip as the workspace's header, the left column's tabs, the row. */
function Page({ phaseKey, page, actions }: { phaseKey: PhaseKey; page: AreaPage; actions: ReactNode }) {
  return (
    <>
      <PhaseStrip phase={{ key: phaseKey, title: TITLE[phaseKey], place: 4, count: 6 }} titleLevel={1} right={actions} workHeader />
      {/* Every code phase's page draws the left column's two tabs, Implementation's included. */}
      {<nav className="phase-room-nav" aria-label="Phase context"><a href={`/workspace/p/${page}`} aria-current="page">Your task</a><a href="/workspace/p?panel=files">Files</a></nav>}
      <PhaseAreaNav phase={{ id: 'p', key: phaseKey }} current={page} />
    </>
  );
}

/** Walk every step and say what each landed on: the highlighted element's words, or null where nothing is lit. */
function walk(phaseKey: PhaseKey, page: AreaPage, actions: ReactNode, content: ReactNode = <Page phaseKey={phaseKey} page={page} actions={actions} />) {
  act(() => root.render(<>{content}<CoachMarks marks={phaseTutorialMarks(phaseKey, lessons.on)} force /></>));
  order = [...host.querySelectorAll('*')];
  act(() => root.render(<>{content}<CoachMarks marks={phaseTutorialMarks(phaseKey, lessons.on)} force /></>));
  const landed: Record<string, string | null> = {};
  for (let guard = 0; guard < 20; guard += 1) {
    const card = host.querySelector<HTMLElement>('[data-testid="coach-card"]')!;
    const light = host.querySelector<HTMLElement>('[data-testid="coach-highlight"]');
    const element = light ? order[(Number.parseFloat(light.style.left) + 4) / 10 - 1] : null;
    landed[card.getAttribute('data-target')!] = element ? (element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '') : null;
    const [at, of] = (host.querySelector('[data-testid="coach-count"]')?.textContent ?? '').split(' of ');
    if (at === of) break;
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="coach-next"]')!.click());
  }
  act(() => root.unmount()); root = createRoot(host);
  return landed;
}

const SOLUTION = <button type="button" data-testid="solution-open">Read the reference solution</button>;
describe('the tour on the document pages in the workspace\'s frame', () => {
  for (const on of [true, false]) {
    it(`Testing's planted bugs (guide ${on ? 'offered' : 'not offered'}): run on Write tests, review on the page's Submit, the last step on Details`, () => {
      lessons.on = on;
      const landed = walk('testing', 'matrix', <>{SOLUTION}<button type="button">Run the bugs again</button><button type="button" data-testid="phase-testing-submit">Submit PR-4</button></>);
      expect(landed['testing-tutorial-run']).toBe('Write tests');
      expect(landed['testing-tutorial-review']).toBe('Submit PR-4');
      expect(landed['testing-tutorial-help']).toBe('Details');
    });
  }
  it('Testing\'s reviews: the review step on the page\'s own Submit', () => {
    const landed = walk('testing', 'pr', <><button type="button" data-testid="header-submit">Submit again</button></>);
    expect(landed['testing-tutorial-run']).toBe('Write tests');
    expect(landed['testing-tutorial-review']).toBe('Submit again');
    expect(landed['testing-tutorial-help']).toBe('Details');
  });
  // The row's entry is "Pull request" (was "Reviews"); the step lands on it by its address.
  it('Deployment\'s incident drill: run on Configuration, review on Pull request (no Submit on the page), the last step on Details', () => {
    const landed = walk('deployment', 'drill', <></>);
    expect(landed['deployment-tutorial-selfcheck']).toBe('Configuration');
    expect(landed['deployment-tutorial-review']).toBe('Pull request');
    expect(landed['deployment-tutorial-help']).toBe('Details');
  });
  it('Implementation\'s pull request, merged (no Submit): run on Code, review on Pull request, the last step on Details', () => {
    const landed = walk('implementation', 'pr', SOLUTION);
    expect(landed['implementation-tutorial-run']).toBe('Code');
    expect(landed['implementation-tutorial-review']).toBe('Pull request');
    expect(landed['implementation-tutorial-help']).toBe('Details');
  });
  it('Maintenance\'s change request: the last step on Details', () => {
    const landed = walk('maintenance', 'change', <button type="button" data-testid="phase-maintenance-submit">Submit PR-6</button>);
    expect(landed['maintenance-tutorial-help']).toBe('Details');
  });
  it('on the workspace, where Run and More are drawn, the steps land where they did', () => {
    lessons.on = true;
    const landed = walk('testing', 'matrix', null, <>
      <button type="button" data-testid="header-run">Run tests</button>
      <button type="button" data-testid="phase-more-toggle">More</button>
      <nav aria-label="Phase working area"><button type="button" data-view="code">Write tests</button><a href="/workspace/p/pr">Pull request</a></nav>
    </>);
    expect(landed['testing-tutorial-run']).toBe('Run tests');
    expect(landed['testing-tutorial-review']).toBe('More');
    expect(landed['testing-tutorial-help']).toBe('More');
  });
});
