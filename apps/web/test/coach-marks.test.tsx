// @vitest-environment jsdom
/**
 * The tours, one per page, and the one flag that remembers them.
 *
 * Two things are worth pinning without a browser. The flag: `done` means every
 * tour has been seen (twenty-five specs pre-set that word and expect silence),
 * anything else is the set of pages seen, and marking one page never touches
 * another. The component is replay-only and must remain available on every
 * page regardless of the older seen flag.
 *
 * jsdom lays nothing out, so every target measures 0x0 and the tour would skip
 * all of them; the rectangle is stubbed to something with a size.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoachMarks, closedDetailsAround } from '@/components/shell/CoachMarks';
import {
  COACH_KEY,
  TOUR_PAGES,
  TOUR_EVENT,
  markTourSeen,
  marksFor,
  phaseTutorialMarks,
  readSeenTours,
  replayTour,
  tourPageFromPath,
  tourSeen,
} from '@/components/shell/tours';

class QuietResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let targets: HTMLElement | null = null;

const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
};

/** Draws one element per target so the tour has something to point at. */
const drawTargets = (ids: string[]) => {
  const main = document.createElement('main');
  for (const id of ids) {
    const el = document.createElement('div');
    el.dataset.testid = id;
    main.appendChild(el);
  }
  document.body.appendChild(main);
  targets = main;
};

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const realRect = Element.prototype.getBoundingClientRect;
const realScroll = Element.prototype.scrollIntoView;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = function () {};
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = QuietResizeObserver;
  // Every element is 200x40 at (100, 100): enough for the tour to place it.
  Element.prototype.getBoundingClientRect = function rect() {
    return { top: 100, left: 100, right: 300, bottom: 140, width: 200, height: 40, x: 100, y: 100, toJSON() {} } as DOMRect;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  targets?.remove();
  root = null;
  host = null;
  targets = null;
  Element.prototype.getBoundingClientRect = realRect;
  Element.prototype.scrollIntoView = realScroll;
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
});

describe('the flag', () => {
  it('reads nothing seen from an empty key, and every page seen from the word done', () => {
    expect(readSeenTours()).toEqual({});
    expect(tourSeen('home')).toBe(false);
    window.localStorage.setItem(COACH_KEY, 'done');
    expect(readSeenTours()).toBe('done');
    for (const page of ['home', 'brief', 'issue', 'design', 'ide'] as const) {
      expect(tourSeen(page), `${page} is seen under done`).toBe(true);
    }
  });

  it('marks one page and leaves the others for when the learner gets there', () => {
    markTourSeen('issue');
    expect(JSON.parse(window.localStorage.getItem(COACH_KEY)!)).toEqual({ issue: true });
    expect(tourSeen('issue')).toBe(true);
    expect(tourSeen('home')).toBe(false);
    expect(tourSeen('ide')).toBe(false);
    markTourSeen('home');
    expect(readSeenTours()).toEqual({ issue: true, home: true });
  });

  it('keeps done as done: there is nothing left to mark', () => {
    window.localStorage.setItem(COACH_KEY, 'done');
    markTourSeen('brief');
    expect(window.localStorage.getItem(COACH_KEY)).toBe('done');
  });

  it('treats a value it does not understand as nothing seen', () => {
    window.localStorage.setItem(COACH_KEY, 'seen');
    expect(readSeenTours()).toEqual({});
    window.localStorage.setItem(COACH_KEY, '[1,2]');
    expect(readSeenTours()).toEqual({});
    window.localStorage.setItem(COACH_KEY, '{"issue":"yes","design":true,"other":true}');
    // Only a literal true counts, and only for a page that has a tour.
    expect(readSeenTours()).toEqual({ design: true });
  });
});

describe('current route coverage', () => {
  it('offers a page tour for Progress, library, profile and every gated workspace route', () => {
    const routes = { '/dashboard': 'home', '/progress': 'progress', '/profile': 'profile', '/learn': 'learn',
      '/learn/requirements?chapter=3': 'lesson', '/workspace/abc/brief': 'brief', '/workspace/abc/issue': 'issue',
      '/workspace/abc/design': 'design', '/workspace/abc/interview': 'issue', '/workspace/abc': 'ide',
      '/workspace/abc/pr': 'ide', '/workspace/abc/change': 'ide', '/workspace/abc/matrix': 'ide',
      '/teacher?class=abc': 'page', '/phases': 'page' };
    for (const [path, page] of Object.entries(routes)) expect(tourPageFromPath(path), path).toBe(page);
    expect(tourPageFromPath(null)).toBeUndefined();
  });
  it('explains controls without obsolete scoring or automatic work promises', () => {
    for (const page of TOUR_PAGES) {
      expect(marksFor(page).length).toBeGreaterThan(1);
      for (const mark of marksFor(page)) {
        expect(mark.title).toBeTruthy(); expect(mark.body).toBeTruthy();
        expect(mark.body).not.toMatch(/70%|asking.*score|automatically pass|Docker build succeeded/i);
      }
    }
  });
});

const sampleMarks = [
  { target: 'first', title: 'First control', body: 'This existing control opens a page.' },
  { target: 'second', title: 'Second control', body: 'This existing control saves only when you choose it.' },
];

describe('replayable CoachMarks', () => {
  it('opens before measuring and updates distant step geometry without waiting for resize frames', () => {
    drawTargets(['first', 'second']);
    const closedCardMeasurements: boolean[] = [];
    Element.prototype.getBoundingClientRect = function () {
      const isCard = this.getAttribute('data-testid') === 'coach-card';
      if (isCard) closedCardMeasurements.push(!this.closest('dialog')?.open);
      const left = this.getAttribute('data-testid') === 'second' ? 650 : 100;
      const width = isCard ? 300 : 100, height = isCard ? 180 : 40;
      return { top: 100, left, right: left + width, bottom: 100 + height, width, height, x: left, y: 100, toJSON() {} } as DOMRect;
    };
    mount(<CoachMarks force marks={sampleMarks} />);
    expect(q('coach')?.hasAttribute('open')).toBe(true);
    expect(q('coach-highlight')?.style.left).toBe('96px');
    expect(q('coach-card')?.style.left).toBe('96px');
    act(() => q('coach-next')!.click());
    expect(q('coach-count')?.textContent).toBe('2 of 2');
    expect(q('coach-highlight')?.style.left).toBe('646px');
    expect(q('coach-card')?.style.left).toBe('646px');
    expect(closedCardMeasurements.length).toBeGreaterThan(1);
    expect(closedCardMeasurements).not.toContain(true);
    // The real RAF probe also verifies the first painted new-step frame;
    // jsdom can assert native-open ordering and committed geometry, not paint.
  });
  it('stays quiet until requested and replays even under the legacy done flag', () => {
    drawTargets(['first', 'second']);
    mount(<CoachMarks page="progress" marks={sampleMarks} />);
    expect(q('coach')).toBeNull();
    window.localStorage.setItem(COACH_KEY, 'done');
    act(() => replayTour());
    expect(q('coach')?.tagName).toBe('DIALOG');
    expect(q('coach')?.getAttribute('open')).toBe('');
    expect(q('coach-count')?.textContent).toBe('1 of 2');
    expect(document.activeElement).toBe(q('coach-next'));
  });
  it('supports Next, Back, Done and a fresh replay without changing the address', () => {
    drawTargets(['first', 'second']); mount(<CoachMarks page="progress" marks={sampleMarks} />);
    const address = location.href;
    act(() => replayTour());
    expect((q('coach-back') as HTMLButtonElement).disabled).toBe(true);
    act(() => q('coach-next')!.click());
    expect(q('coach-count')?.textContent).toBe('2 of 2');
    expect(q('coach-next')?.textContent).toBe('Done');
    act(() => q('coach-back')!.click());
    expect(q('coach-count')?.textContent).toBe('1 of 2');
    act(() => q('coach-next')!.click()); act(() => q('coach-next')!.click());
    expect(q('coach')).toBeNull(); expect(readSeenTours()).toEqual({ progress: true });
    act(() => replayTour()); expect(q('coach-count')?.textContent).toBe('1 of 2');
    expect(location.href).toBe(address);
  });
  it('moves focus to Next when Back reaches the first step and becomes disabled', () => {
    drawTargets(['first', 'second']); mount(<CoachMarks marks={sampleMarks} force />);
    act(() => q('coach-next')!.click());
    q('coach-back')!.focus(); expect(document.activeElement).toBe(q('coach-back'));
    act(() => q('coach-back')!.click());
    expect((q('coach-back') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(q('coach-next'));
  });
  it('skips and closes with Escape, restoring focus to the opener', () => {
    drawTargets(['first']);
    const opener = document.createElement('button'); targets!.appendChild(opener); opener.focus();
    mount(<CoachMarks page="progress" marks={sampleMarks} />);
    act(() => replayTour());
    act(() => q('coach-next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(q('coach')).toBeNull(); expect(document.activeElement).toBe(opener);
    act(() => replayTour()); act(() => q('coach-skip')!.click());
    expect(q('coach')).toBeNull(); expect(document.activeElement).toBe(opener);
  });
  it('holds Tab and Shift Tab among the available controls', () => {
    drawTargets(['first', 'second']); mount(<CoachMarks marks={sampleMarks} force />);
    act(() => q('coach-next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(q('coach-skip'));
    act(() => q('coach-skip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(q('coach-next'));
  });
  it('ignores retained hidden panes and selects the visible matching control', () => {
    drawTargets(['first', 'second']); q('first')!.hidden = true;
    mount(<CoachMarks marks={sampleMarks} force />);
    expect(q('coach-card')?.dataset.target).toBe('second');
    expect(q('coach-count')?.textContent).toBe('1 of 1');
  });
  it('gives a visible fallback rather than silently doing nothing while content is unavailable', () => {
    mount(<CoachMarks page="progress" marks={sampleMarks} />); act(() => replayTour());
    expect(q('coach')?.textContent).toContain('no visible tour targets yet');
    expect(q('coach-next')?.textContent).toBe('Done');
    act(() => q('coach-next')!.click()); expect(q('coach')).toBeNull();
  });
  it('does not show generic editor instructions in the persistent Requirements workspace', () => {
    drawTargets(['requirements-workspace', 'interview-composer', 'editor-host']);
    mount(<CoachMarks page="ide" force />);
    expect(q('coach-card')?.dataset.target).toBe('interview-page');
    expect(q('coach-count')?.textContent).toBe('1 of 1');
    expect(q('coach')?.textContent).not.toContain('supplied files');
  });
  it('uses navigation guidance instead of working tools on a locked phase', () => {
    drawTargets(['phase-locked', 'editor-host', 'jump-to']); mount(<CoachMarks page="ide" force />);
    expect(q('coach-card')?.dataset.target).toBe('jump-to');
    expect(q('coach')?.textContent).not.toContain('Run before');
  });
  it('closes when the owning route changes and a new page starts quietly', () => {
    drawTargets(['first', 'second']); mount(<CoachMarks key="progress" page="progress" marks={sampleMarks} />);
    act(() => replayTour()); expect(q('coach')).not.toBeNull();
    act(() => root!.render(<CoachMarks key="profile" page="profile" marks={sampleMarks} />));
    expect(q('coach')).toBeNull();
    act(() => replayTour()); expect(q('coach-count')?.textContent).toBe('1 of 2');
  });
  it('returns to search when its transient palette row has been removed', () => {
    drawTargets(['first']);
    const search = document.createElement('button'); search.dataset.testid = 'jump-to'; targets!.appendChild(search);
    const menu = document.createElement('div'); menu.dataset.testid = 'palette';
    const row = document.createElement('button'); menu.appendChild(row); targets!.appendChild(menu); row.focus();
    mount(<CoachMarks marks={sampleMarks} />); act(() => replayTour()); menu.remove();
    act(() => q('coach-skip')!.click()); expect(document.activeElement).toBe(search);
  });
  it('restores the original opener even when an already-open tour is replayed', () => {
    drawTargets(['first', 'second']);
    const opener = document.createElement('button'); targets!.appendChild(opener); opener.focus();
    mount(<CoachMarks marks={sampleMarks} />); act(() => replayTour()); act(() => replayTour());
    act(() => q('coach-skip')!.click()); expect(document.activeElement).toBe(opener);
  });
  it('places the card above a target near the bottom instead of covering it', () => {
    drawTargets(['first']);
    q('first')!.getBoundingClientRect = () => ({ top: 720, bottom: 760, left: 500, right: 700, width: 200, height: 40, x: 500, y: 720, toJSON() {} }) as DOMRect;
    mount(<CoachMarks marks={sampleMarks} force />);
    expect(parseFloat(q('coach-card')!.style.top) + 40).toBeLessThan(716);
  });
  it('resets an active replay to the first card', () => {
    drawTargets(['first', 'second']); mount(<CoachMarks marks={sampleMarks} force />);
    act(() => q('coach-next')!.click());
    act(() => window.dispatchEvent(new CustomEvent(TOUR_EVENT)));
    expect(q('coach-count')?.textContent).toBe('1 of 2');
  });
});

/**
 * In a real browser an element inside a closed
 * `<details>` still has a size (Chromium lays it out), so the size test alone
 * spotlit the work room's Replay tutorial, inside the closed More menu, as
 * empty space. jsdom lays nothing out (every rectangle is stubbed here), so
 * these cases pin the rule; the real-browser spotlight is for the e2e
 * (`e2e/page-tours.spec.ts`, the help step "Return whenever you need help").
 */
describe('a target inside a closed menu', () => {
  /** The work room's header as PhaseHeader draws it: title, then More with Replay tutorial inside. */
  const drawHeader = () => {
    const main = document.createElement('main');
    main.innerHTML = '<h1 data-testid="phase-title">Implementation</h1>'
      + '<details data-testid="phase-more"><summary data-testid="phase-more-toggle">More</summary>'
      + '<div><button type="button" data-testid="phase-tutorial-replay">Replay tutorial</button></div></details>';
    document.body.appendChild(main);
    targets = main;
    const at: Record<string, number> = { 'phase-title': 20, 'phase-more-toggle': 500, 'phase-tutorial-replay': 700 };
    Element.prototype.getBoundingClientRect = function () {
      const left = at[this.getAttribute('data-testid') ?? ''] ?? 100;
      return { top: 100, left, right: left + 100, bottom: 140, width: 100, height: 40, x: left, y: 100, toJSON() {} } as DOMRect;
    };
  };
  const helpStep = () => phaseTutorialMarks('implementation', false).at(-1)!;

  it('closedDetailsAround: inside a closed menu yes; its own toggle, an open menu or the menu itself no', () => {
    drawHeader();
    const details = q('phase-more') as HTMLDetailsElement;
    expect(closedDetailsAround(q('phase-tutorial-replay')!)).toBe(details);
    expect(closedDetailsAround(q('phase-more-toggle')!)).toBeNull();
    expect(closedDetailsAround(details)).toBeNull();
    expect(closedDetailsAround(q('phase-title')!)).toBeNull();
    details.open = true;
    expect(closedDetailsAround(q('phase-tutorial-replay')!)).toBeNull();
    // A toggle of an inner menu inside a closed outer one is hidden by the outer one.
    details.open = false;
    const inner = document.createElement('details');
    inner.innerHTML = '<summary data-testid="inner-toggle">Inner</summary>';
    details.querySelector('div')!.appendChild(inner);
    expect(closedDetailsAround(q('inner-toggle')!)).toBe(details);
  });

  it('the help step spotlights the More toggle while More is closed, and Replay tutorial once it is open', () => {
    drawHeader();
    expect(helpStep().body).toContain('Replay tutorial brings these steps back.');
    mount(<CoachMarks marks={[helpStep()]} force />);
    expect(q('coach-highlight')?.style.left).toBe('496px');
    expect(q('coach')?.textContent).not.toContain('This control is in another view or a closed panel');
    act(() => root!.unmount()); host!.remove(); root = null;
    (q('phase-more') as HTMLDetailsElement).open = true;
    mount(<CoachMarks marks={[helpStep()]} force />);
    expect(q('coach-highlight')?.style.left).toBe('696px');
  });

  it('where Submit sits in a closed More, each code room\'s review step spotlights the More toggle', () => {
    drawHeader();
    // A ready, review passed or awaiting room: Submit inside More, the tabs on the row.
    const submit = document.createElement('button');
    submit.dataset.testid = 'header-submit';
    submit.textContent = 'Submit';
    q('phase-more')!.querySelector('div')!.appendChild(submit);
    const nav = document.createElement('nav');
    nav.className = 'phase-room-nav';
    targets!.appendChild(nav);
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as const) {
      const review = phaseTutorialMarks(key, true).find((mark) => mark.target === `${key}-tutorial-review`)!;
      // Between More and the old text row's class, the document pages' own landings (the
      // planted bugs page's Submit, the row's review page); More still comes first, so this room lands on it.
      const between: Record<string, string[]> = {
        implementation: ['[aria-label="Implementation working area"] > a[href$="/pr"]'],
        testing: ['[data-testid="phase-testing-submit"]', '[aria-label="Phase working area"] > a[href$="/pr"]'],
        deployment: ['[aria-label="Phase working area"] > a[href$="/pr"]'],
        maintenance: [],
      };
      expect(review.fallbackSelector, key).toEqual(['[data-testid="phase-more-toggle"]', ...between[key], '.phase-room-nav']);
      mount(<CoachMarks marks={[review]} force />);
      expect(q('coach-highlight')?.style.left, key).toBe('496px');
      act(() => root!.unmount()); host!.remove(); root = null;
    }
    // Once More is open, the step lands on Submit itself (left 100 in the stub, so 96).
    (q('phase-more') as HTMLDetailsElement).open = true;
    mount(<CoachMarks marks={[phaseTutorialMarks('implementation', true).find((mark) => mark.target === 'implementation-tutorial-review')!]} force />);
    expect(q('coach-highlight')?.style.left).toBe('96px');
  });

  it('the help step names no menu, so it is true where Replay tutorial is on the row', () => {
    // The drill, change and matrix pages keep Replay tutorial on the visible row and call their menu "Details".
    for (const key of ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const) {
      for (const lessons of [true, false]) {
        const body = phaseTutorialMarks(key, lessons).at(-1)!.body;
        expect(body.startsWith('Replay tutorial brings these steps back. '), `${key} ${lessons}`).toBe(true);
        expect(body, `${key} ${lessons}`).not.toMatch(/\bin More\b|\bunder More\b|\bDetails\b/);
      }
    }
  });

  it('focus returns to the More toggle when the tutorial opened from More closes', () => {
    drawHeader();
    const details = q('phase-more') as HTMLDetailsElement;
    details.open = true;
    q('phase-tutorial-replay')!.focus();
    mount(<CoachMarks marks={sampleMarks.slice(0, 1).map((mark) => ({ ...mark, target: 'phase-title' }))} />);
    // The header closes More after a door inside it is used.
    act(() => replayTour());
    details.open = false;
    act(() => q('coach-next')!.click());
    expect(q('coach')).toBeNull();
    expect(document.activeElement).toBe(q('phase-more-toggle'));
  });

  it('an opener outside any closed menu still gets focus back', () => {
    drawHeader();
    (q('phase-more') as HTMLDetailsElement).open = true;
    q('phase-tutorial-replay')!.focus();
    mount(<CoachMarks marks={sampleMarks.slice(0, 1).map((mark) => ({ ...mark, target: 'phase-title' }))} />);
    act(() => replayTour());
    act(() => q('coach-skip')!.click());
    expect(document.activeElement).toBe(q('phase-tutorial-replay'));
  });
});
