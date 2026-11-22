// @vitest-environment jsdom
/**
 * The Brief box in the teacher's editor shows its text.
 *
 * On 18 Nov the teacher pass found the learner's story Brief drawn as a
 * two-row box (55 px) over the Deadline badge brief, seven paragraphs on nine
 * lines (192 px): a click landed mid-text and the end was out of view. The
 * long fields of the builders' cards are now a `GrowBox`: as tall as the text,
 * growing as the teacher types, capped at GROW_BOX_MAX_ROWS rows (then it
 * scrolls inside), never shorter than the rows it was, and never
 * shorter than a height the teacher dragged it to.
 *
 * jsdom lays nothing out, so a textarea's `scrollHeight` is mocked here as a
 * browser would report it with `height: auto` (the larger of its rows and its
 * lines, times the line height, plus padding), and its computed style is the
 * editor's `.field.tre-ta` (13.5 px text on a 1.45 line height, 8 px padding,
 * 1.5 px border).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPhaseView, DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR } from '@learnsdlc/shared';

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    updateTask: vi.fn(),
    updatePhase: vi.fn(),
    putInterview: vi.fn(),
    readInterview: vi.fn(),
  },
}));

import { GROW_BOX_MAX_ROWS, GrowBox, fitGrowBox, growBoxHeight } from '@/components/staff/projects/GrowBox';
import { RequirementsBuilder, forgetTaskSaves } from '@/components/staff/projects/requirements/RequirementsBuilder';

/** The Deadline badge pack's Requirements brief, as the teacher pass found it in the box (373 characters, 9 lines). */
const DEADLINE_BADGE_BRIEF =
  'Write the story for the overdue badge, US-1, in the story form.\n\nAsk the Team Lead first: who sees the badge, when a task is overdue, and what is left out.\n\nWhat good looks like\n\n- One sentence: As a ..., I want ..., so that ....\n- Two acceptance criteria: a task due yesterday is overdue (happy), and a task due today is not (boundary).\n- One line on what is out of scope.';

const LINE = 13.5 * 1.45; // 19.575
const PAD = 16;
const BORDER = 3;
/** What a browser reports as `scrollHeight` at `height: auto` for `lines` lines in a box of `rows` rows. */
const autoHeight = (rows: number, lines: number) => Math.max(rows, lines) * LINE + PAD;
const CAP = Math.ceil(LINE * GROW_BOX_MAX_ROWS + PAD + BORDER); // 333

let host: HTMLDivElement;
let root: Root;
/** Off: every textarea reports 0, as jsdom does. */
let laidOut = true;
/** A scroller the measuring would clamp to the top (a browser does when the page gets shorter for a moment). */
let clampOnMeasure: HTMLElement | null = null;
/** Each border's width as the computed style gives it; a zoom level can snap it to a fraction. */
let border = '1.5px';
/** Lines a font swapped in after the first fit wraps the same text onto. */
let extraLines = 0;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  laidOut = true;
  clampOnMeasure = null;
  border = '1.5px';
  extraLines = 0;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      if (!laidOut) return 0;
      if (clampOnMeasure) clampOnMeasure.scrollTop = 0;
      return autoHeight(Number(this.getAttribute('rows')) || 2, this.value.split('\n').length + extraLines);
    },
  });
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    if (el instanceof HTMLTextAreaElement) {
      return {
        fontSize: '13.5px',
        lineHeight: `${LINE}px`,
        paddingTop: '8px',
        paddingBottom: '8px',
        borderTopWidth: border,
        borderBottomWidth: border,
        overflowY: el.style.overflowY || 'visible',
      } as CSSStyleDeclaration;
    }
    if (el instanceof HTMLElement && el.dataset.scroller === 'yes') return { overflowY: 'auto' } as CSSStyleDeclaration;
    return real(el, pseudo);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetTaskSaves();
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  // jsdom has no document.fonts; a test that gives it one takes it away here.
  delete (document as { fonts?: unknown }).fonts;
  vi.restoreAllMocks();
});

const type = (el: Element, value: string) => act(() => fireEvent.change(el, { target: { value } }));

describe('the rule', () => {
  const measure = (rows: number, lines: number, dragged?: number) =>
    growBoxHeight({ scrollHeight: autoHeight(rows, lines), lineHeight: LINE, paddingBlock: PAD, borderBlock: BORDER, maxRows: GROW_BOX_MAX_ROWS, dragged });

  it('one line keeps the box it was (its rows), with nothing to scroll', () => {
    expect(measure(2, 1)).toEqual({ height: 2 * LINE + PAD + BORDER, scrolls: false });
  });

  it('seven paragraphs on nine lines are shown whole', () => {
    expect(measure(2, 9)).toEqual({ height: 9 * LINE + PAD + BORDER, scrolls: false });
    expect(measure(2, 9).height).toBeCloseTo(195.175, 3);
  });

  it(`sixteen lines fit; past ${GROW_BOX_MAX_ROWS} lines the box stops at the cap and scrolls inside`, () => {
    expect(measure(2, 16)).toEqual({ height: 16 * LINE + PAD + BORDER, scrolls: false });
    expect(measure(2, 17)).toEqual({ height: CAP, scrolls: true });
    expect(measure(2, 30)).toEqual({ height: CAP, scrolls: true });
    expect(GROW_BOX_MAX_ROWS).toBe(16);
  });

  it('a height the teacher dragged to is the least the box keeps; text taller than it still grows the box', () => {
    expect(measure(2, 1, 300)).toEqual({ height: 300, scrolls: false });
    expect(measure(2, 30, 400)).toEqual({ height: 400, scrolls: true });
    expect(measure(2, 9, 100)).toEqual({ height: 9 * LINE + PAD + BORDER, scrolls: false });
  });
});

const baseTask = {
  taskKey: 'main',
  order: 1,
  title: 'Requirements',
  brief: DEADLINE_BADGE_BRIEF,
  objectives: ['one'],
  artefactType: 'user-story',
  artefactPath: null,
  checkKind: 'story',
  required: true,
  owns: [],
  authorable: true,
  notice: null,
  story: {
    kind: 'story',
    record: 'requirements/story.json',
    providedStories: [],
    learnerStory: { id: 'US-1', hints: {} },
    floor: DEFAULT_STORY_FLOOR,
  },
  rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'Story', description: 'Who wants the badge, what it shows and why.', weight: 1 }] },
} as unknown as DraftTaskView;

const basePhase = {
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  intro: 'Write one story for the overdue badge.',
  artifactKind: 'story',
  blocksPublish: false,
  tasks: [baseTask],
  interview: null,
} as unknown as DraftPhaseView;

function mountBuilder() {
  act(() =>
    root.render(
      <RequirementsBuilder
        projectId="p"
        versionId="v"
        phase={basePhase}
        task={baseTask}
        editable
        onSaved={vi.fn<(result: TaskMutationResult) => void>()}
      />,
    ),
  );
}

describe("the learner's story Brief in the Requirements builder", () => {
  it('opens showing the whole Deadline badge brief, grows as the teacher types, stops at the cap, and shrinks back', () => {
    mountBuilder();
    const brief = screen.getByTestId('tre-learner-brief') as HTMLTextAreaElement;
    // The box itself: a textarea, two rows, its class, label and test id.
    expect(brief.tagName).toBe('TEXTAREA');
    expect(brief.getAttribute('rows')).toBe('2');
    expect(brief.className).toBe('field tre-ta');
    expect(brief.getAttribute('aria-label')).toBe('Brief');
    expect(brief.style.height).toBe(`${9 * LINE + PAD + BORDER}px`);
    expect(brief.style.overflowY).toBe('hidden');

    type(brief, `${DEADLINE_BADGE_BRIEF}\nA tenth line.`);
    expect(brief.style.height).toBe(`${10 * LINE + PAD + BORDER}px`);

    type(brief, Array.from({ length: 30 }, (_, at) => `Line ${at + 1}`).join('\n'));
    expect(brief.style.height).toBe(`${CAP}px`);
    expect(brief.style.overflowY).toBe('auto');

    type(brief, 'One line.');
    expect(brief.style.height).toBe(`${2 * LINE + PAD + BORDER}px`);
    expect(brief.style.overflowY).toBe('hidden');
  });

  it('a box dragged taller with the resize handle stays that tall as the teacher types', () => {
    mountBuilder();
    const brief = screen.getByTestId('tre-learner-brief') as HTMLTextAreaElement;
    brief.style.height = '400px'; // what the handle writes
    type(brief, 'Short now.');
    expect(brief.style.height).toBe('400px');
    type(brief, 'Short again.');
    expect(brief.style.height).toBe('400px');
  });

  it('the Background and the criterion description follow the same rule in the same builder', () => {
    mountBuilder();
    const background = screen.getByTestId('tre-background-field') as HTMLTextAreaElement;
    expect(background.style.height).toBe(`${3 * LINE + PAD + BORDER}px`);
    type(background, Array.from({ length: 20 }, () => 'A line of background.').join('\n'));
    expect(background.style.height).toBe(`${CAP}px`);
    const description = screen.getByLabelText('Criterion 1 description') as HTMLTextAreaElement;
    expect(description.style.height).toBe(`${3 * LINE + PAD + BORDER}px`);
  });
});

describe('GrowBox itself', () => {
  function Box({ start }: { start: string }) {
    const [value, setValue] = useState(start);
    return <GrowBox rows={2} aria-label="Box" data-testid="box" value={value} onChange={(e) => setValue(e.target.value)} />;
  }

  it('where nothing is laid out (jsdom, a hidden tab) the box is left exactly as React drew it', () => {
    laidOut = false;
    act(() => root.render(<Box start={DEADLINE_BADGE_BRIEF} />));
    const box = screen.getByTestId('box');
    expect(box.getAttribute('style')).toBeNull();
    expect(box.outerHTML).toBe(`<textarea rows="2" aria-label="Box" data-testid="box">${DEADLINE_BADGE_BRIEF.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>`);
  });

  it('measuring never moves the page: a scroller the measure clamped is put back where it was', () => {
    const scroller = document.createElement('div');
    scroller.dataset.scroller = 'yes';
    const box = document.createElement('textarea');
    box.rows = 2;
    box.value = DEADLINE_BADGE_BRIEF;
    scroller.append(box);
    document.body.append(scroller);
    scroller.scrollTop = 500;
    clampOnMeasure = scroller;
    fitGrowBox(box);
    expect(scroller.scrollTop).toBe(500);
    expect(box.style.height).toBe(`${9 * LINE + PAD + BORDER}px`);
    scroller.remove();
  });

  it('a fractional height the browser writes back with fewer digits is still the box\'s own, not a drag', () => {
    // A border snapped to a fraction at some zoom level: the height is not a round number.
    border = '1.3333333px';
    const edges = 2 * 1.3333333;
    act(() => root.render(<Box start={DEADLINE_BADGE_BRIEF} />));
    const box = screen.getByTestId('box') as HTMLTextAreaElement;
    const nine = 9 * LINE + PAD + edges;
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(nine, 6);
    // Chrome serialises a length to six significant digits: the string read back differs from the one set.
    const written = `${Number(nine.toPrecision(6))}px`;
    expect(written).not.toBe(box.style.height);
    box.style.height = written;
    type(box, 'One line.');
    // Not taken as a drag: the box shrinks back to its two rows.
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(2 * LINE + PAD + edges, 6);
    expect(box.style.overflowY).toBe('hidden');
  });
});

describe('GrowBox refits when the fonts have loaded', () => {
  function Box({ start }: { start: string }) {
    const [value, setValue] = useState(start);
    return <GrowBox rows={2} aria-label="Box" data-testid="box" value={value} onChange={(e) => setValue(e.target.value)} />;
  }

  /** A stand-in for `document.fonts`: its `ready` resolves when `loaded()` is called, and it fires `loadingdone`. */
  function fakeFonts() {
    let loaded: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const fonts = Object.assign(new EventTarget(), { ready });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    return {
      fonts,
      loaded: () =>
        act(async () => {
          loaded();
          await ready;
          await Promise.resolve();
        }),
    };
  }

  const nineLines = `${9 * LINE + PAD + BORDER}px`;

  it('a font that swaps in after the first fit and wraps the text onto more lines grows the box, scroll, focus and caret kept', async () => {
    const fonts = fakeFonts();
    const scroller = document.createElement('div');
    scroller.dataset.scroller = 'yes';
    document.body.append(scroller);
    scroller.append(host);
    act(() => root.render(<Box start={DEADLINE_BADGE_BRIEF} />));
    const box = screen.getByTestId('box') as HTMLTextAreaElement;
    expect(box.style.height).toBe(nineLines);
    box.focus();
    box.setSelectionRange(40, 40);
    scroller.scrollTop = 300;
    clampOnMeasure = scroller;
    // The web font arrives and the same text now takes two more lines.
    extraLines = 2;
    expect(box.style.height).toBe(nineLines);
    await fonts.loaded();
    expect(box.style.height).toBe(`${11 * LINE + PAD + BORDER}px`);
    expect(box.style.overflowY).toBe('hidden');
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(40);
    expect(scroller.scrollTop).toBe(300);
    // A font that finishes loading later (a weight first used further on) refits it again.
    extraLines = 3;
    act(() => {
      fonts.fonts.dispatchEvent(new Event('loadingdone'));
    });
    expect(box.style.height).toBe(`${12 * LINE + PAD + BORDER}px`);
    expect(scroller.scrollTop).toBe(300);
    document.body.append(host);
    scroller.remove();
  });

  it('a box gone before the fonts load is left alone', async () => {
    const fonts = fakeFonts();
    act(() => root.render(<Box start={DEADLINE_BADGE_BRIEF} />));
    const box = screen.getByTestId('box') as HTMLTextAreaElement;
    const removed = vi.spyOn(fonts.fonts, 'removeEventListener');
    act(() => root.unmount());
    root = createRoot(host);
    expect(removed).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    extraLines = 2;
    await fonts.loaded();
    fonts.fonts.dispatchEvent(new Event('loadingdone'));
    expect(box.style.height).toBe(nineLines);
  });

  it('an engine with no document.fonts still fits the box', () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
    expect(() => act(() => root.render(<Box start={DEADLINE_BADGE_BRIEF} />))).not.toThrow();
    expect((screen.getByTestId('box') as HTMLTextAreaElement).style.height).toBe(nineLines);
  });
});

describe('one rule wherever the long fields are drawn', () => {
  const dir = join(__dirname, '../components/staff/projects');
  const files = (at: string): string[] =>
    readdirSync(at).flatMap((name) => {
      const full = join(at, name);
      return statSync(full).isDirectory() ? files(full) : /\.tsx$/.test(name) ? [full] : [];
    });

  /** Every multi-line box under components/staff/projects: its element and its label, from the source. */
  const boxes = files(dir).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/<(textarea|GrowBox)\b([\s\S]*?)\/?>/g)].map((hit) => ({
      file: relative(dir, file),
      element: hit[1],
      label: /aria-label=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(hit[2])?.slice(1).find(Boolean) ?? /data-testid=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(hit[2])?.slice(1).find(Boolean) ?? '?',
    }));
  });

  it('the Brief, the Background, the objectives and the criterion descriptions are GrowBoxes in every card', () => {
    const grown = boxes.filter((one) => one.element === 'GrowBox').map((one) => `${one.file} ${one.label}`).sort();
    expect(grown).toEqual([
      'BriefCard.tsx Brief',
      'BriefCard.tsx Objectives, one per line',
      'BriefCard.tsx What learners read first',
      'design/LearnerDesignCard.tsx Brief',
      'design/LearnerDesignCard.tsx Objectives, one per line',
      'requirements/BackgroundCard.tsx What learners read first',
      'requirements/CriteriaCard.tsx Criterion ${n} description',
      'requirements/LearnerStoryCard.tsx Brief',
    ]);
    // No plain textarea carries one of those labels anywhere under the editor.
    const long = new Set(['Brief', 'What learners read first', 'Objectives, one per line', 'Criterion ${n} description']);
    expect(boxes.filter((one) => one.element === 'textarea' && long.has(one.label))).toEqual([]);
  });
});
