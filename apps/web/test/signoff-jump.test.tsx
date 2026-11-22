// @vitest-environment jsdom
/**
 * The row of steps above every
 * builder's cards gains one entry after the steps, "Sign-off", where the
 * tab's task card draws its "Needs your sign-off" box. One press brings the
 * box into view, below the sticky bar, with the focus on it, and never ticks
 * it: one rule (`revealSignOff`) for every builder, whose own tests press
 * their entry (`test/support/signoff-jump.ts`). Without a box there is no
 * entry, and the row of steps is drawn as recorded.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StepBar, revealSignOff } from '@/components/staff/projects/requirements/StepBar';
import { SignOffToggle, signOffBoxId } from '@/components/staff/projects/TaskEditor';
import { markupLines } from './support/markup-snapshot';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** A `scrollIntoView` that records its calls, on `HTMLElement.prototype` for `run` only (jsdom has none). */
async function recordingScrolls(run: () => Promise<void> | void): Promise<{ el: Element; options: unknown }[]> {
  const calls: { el: Element; options: unknown }[] = [];
  const proto = HTMLElement.prototype as { scrollIntoView?: (options?: unknown) => void };
  const had = Object.prototype.hasOwnProperty.call(proto, 'scrollIntoView');
  const before = proto.scrollIntoView;
  proto.scrollIntoView = function record(this: Element, options?: unknown) {
    calls.push({ el: this, options });
  };
  try {
    await run();
  } finally {
    if (had) proto.scrollIntoView = before;
    else delete proto.scrollIntoView;
  }
  return calls;
}

const STEPS = [
  { n: 1, label: 'Background', done: true },
  { n: 2, label: 'Stakeholder', done: false },
  { n: 3, label: "The learner's story", done: false },
];

/** The file snapshot of the row for STEPS, step 2 current, with no sign-off box. */
const ROW_SNAPSHOT = '__snapshots__/step-row-without-sign-off.html';

describe('the step row without a sign-off box matches its snapshot', () => {
  it('draws exactly the recorded markup, and nothing after the list', async () => {
    const plain = renderToStaticMarkup(<StepBar steps={STEPS} current={2} label="The three steps" />);
    expect(renderToStaticMarkup(<StepBar steps={STEPS} current={2} label="The three steps" signOff={null} />)).toBe(plain);
    await expect(markupLines(plain)).toMatchFileSnapshot(ROW_SNAPSHOT);
  });

  it('with a box, the list is the same and the entry follows it, outside the list', () => {
    const plain = renderToStaticMarkup(<StepBar steps={STEPS} current={2} label="The three steps" />);
    const withBox = renderToStaticMarkup(<StepBar steps={STEPS} current={2} label="The three steps" signOff="main" />);
    expect(withBox.startsWith(plain)).toBe(true);
    const after = withBox.slice(plain.length);
    expect(after.startsWith('<p class="tre-step-jump" data-testid="tre-signoff-jump-row"><a class="tre-step-jump-link" href="#task-signoff-main" data-testid="tre-signoff-jump">')).toBe(true);
    expect(after.endsWith('Sign-off</a></p>')).toBe(true);
    // Its icon is decoration: the entry's name is "Sign-off" alone.
    expect(after).toContain('aria-hidden="true"');
  });
});

/** A step row with a sign-off box far below it, as a builder draws the two. */
function RowAndBox({ taskKey = 'main', signOff = false }: { taskKey?: string; signOff?: boolean }) {
  return (
    <div>
      <StepBar steps={STEPS} current={null} signOff={taskKey} />
      <section data-testid="card">
        <SignOffToggle task={{ taskKey, title: 'T', signOff }} off={false} describedBy="help" busy={false} onChange={() => {}} />
      </section>
    </div>
  );
}

describe('the Sign-off entry, one rule for every builder', () => {
  it('a press scrolls the box row to the middle of the view at once and focuses the box, leaving it as it was', async () => {
    await act(async () => root.render(<RowAndBox />));
    const box = document.getElementById(signOffBoxId('main')) as HTMLInputElement;
    let taken = false;
    const scrolls = await recordingScrolls(async () => {
      await act(async () => {
        taken = !fireEvent.click(byId('tre-signoff-jump')!);
      });
    });
    expect(taken).toBe(true);
    expect(scrolls).toEqual([{ el: byId('task-signoff-box-main'), options: { block: 'center', inline: 'nearest', behavior: 'instant' } }]);
    expect(document.activeElement).toBe(box);
    expect(box.checked).toBe(false);
  });

  it('a ticked box stays ticked; a second press does the same again', async () => {
    await act(async () => root.render(<RowAndBox signOff />));
    const box = document.getElementById(signOffBoxId('main')) as HTMLInputElement;
    for (let press = 0; press < 2; press += 1) {
      const scrolls = await recordingScrolls(async () => {
        await act(async () => {
          fireEvent.click(byId('tre-signoff-jump')!);
        });
      });
      expect(scrolls).toHaveLength(1);
      expect(document.activeElement).toBe(box);
      expect(box.checked).toBe(true);
    }
  });

  it('a press that opens a new tab or window is left to the browser', async () => {
    await act(async () => root.render(<RowAndBox />));
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      let taken = true;
      const scrolls = await recordingScrolls(async () => {
        await act(async () => {
          taken = !fireEvent.click(byId('tre-signoff-jump')!, { [modifier]: true });
        });
      });
      expect(taken, modifier).toBe(false);
      expect(scrolls, modifier).toEqual([]);
    }
  });

  it('with no box on the page the rule answers false and moves nothing', async () => {
    await act(async () => root.render(<StepBar steps={STEPS} current={null} signOff="gone" />));
    const before = document.activeElement;
    let answer = true;
    const scrolls = await recordingScrolls(() => {
      answer = revealSignOff('gone');
    });
    expect(answer).toBe(false);
    expect(scrolls).toEqual([]);
    expect(document.activeElement).toBe(before);
  });

  it('a task with the empty key is reached by its own id', async () => {
    await act(async () => root.render(<RowAndBox taskKey="" />));
    expect(byId('tre-signoff-jump')!.getAttribute('href')).toBe('#task-signoff-');
    await recordingScrolls(async () => {
      await act(async () => {
        fireEvent.click(byId('tre-signoff-jump')!);
      });
    });
    expect(document.activeElement).toBe(document.getElementById('task-signoff-'));
  });

  // Each builder draws the entry from this one row only where its card draws the box, and the
  // press runs this one rule: every builder's own test renders it and presses its entry
  // through `support/signoff-jump.ts`, with the task editable and read-only.
});
