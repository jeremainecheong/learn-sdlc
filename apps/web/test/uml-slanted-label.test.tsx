// @vitest-environment jsdom
/**
 * On the finished TaskTrackr's UML model at 1440 px, "is tagged through" sat 8 px over the middle of the slanted Task to TaskTag line,
 * and its tail crossed the line beside the arrowhead (the line passes y 234.6 at the label's end; the label's box ran
 * y 225 to 238). A label beside a line that runs across is now placed by where the line is under each end of it.
 *
 * jsdom lays nothing out: these are the layout's own numbers; the drawn look is for a browser to show.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_DESIGN, type Design } from '@learnsdlc/shared';
import { LABEL_CLEAR, UmlDiagram, edgeTexts, relationLabelLines } from '@/components/workspace/panels/design/UmlDiagram';
import { UML, layoutUml } from '@/components/workspace/panels/design/uml-layout';

/** The TaskTrackr model: Task is taller than TaskTag, so the line between them slants. */
const attrs = (...names: string[]) => names.map((name) => ({ name, type: name.endsWith('_at') ? 'timestamp' : name === 'due_date' ? 'date' : name.endsWith('id') ? 'integer' : 'string' }));
const LOCAL: Design = {
  ...EMPTY_DESIGN,
  entities: [
    { id: 'E1', name: 'List', kind: 'class', attributes: attrs('id', 'name', 'created_at'), responsibilities: [], satisfies: [] },
    { id: 'E2', name: 'Tag', kind: 'class', attributes: attrs('id', 'name'), responsibilities: [], satisfies: [] },
    { id: 'E3', name: 'Task', kind: 'class', attributes: attrs('id', 'list_id', 'title', 'priority', 'due_date', 'status', 'created_at', 'completed_at'), responsibilities: [], satisfies: [] },
    { id: 'E4', name: 'TaskTag', kind: 'class', attributes: attrs('task_id', 'tag_id'), responsibilities: [], satisfies: [] },
  ],
  relations: [
    { id: 'R1', from: 'E1', to: 'E3', kind: 'composition', fromCard: '1', toCard: '*', label: 'holds' },
    { id: 'R2', from: 'E2', to: 'E4', kind: 'association', fromCard: '1', toCard: '*', label: 'tags through' },
    { id: 'R3', from: 'E3', to: 'E4', kind: 'association', fromCard: '1', toCard: '*', label: 'is tagged through' },
  ],
} as Design;

/** The line's height under each end of the label, against the label's baseline (and a descender's 3 px under it). */
function clearance(edge: ReturnType<typeof layoutUml>['edges'][number]) {
  const at = edgeTexts(edge).label;
  const half = (Math.max(...relationLabelLines(edge).map((l) => l.length)) * UML.LABEL_CHAR_W) / 2;
  const lineAt = (x: number) => edge.y1 + ((x - edge.x1) * (edge.y2 - edge.y1)) / (edge.x2 - edge.x1);
  return Math.min(lineAt(at.x - half), lineAt(at.x + half)) - (at.y + 3);
}

describe('a label above a slanted line keeps clear of it along its whole width', () => {
  const layout = layoutUml(LOCAL);
  const slanted = layout.edges.find((e) => e.id === 'R3')!;

  it('the Task to TaskTag line slants, and the label is one line beside it', () => {
    expect(slanted.y1).not.toBe(slanted.y2);
    expect(Math.abs(slanted.x2 - slanted.x1)).toBeGreaterThan(Math.abs(slanted.y2 - slanted.y1));
    expect(relationLabelLines(slanted)).toEqual(['is tagged through']);
  });

  it('no letter of "is tagged through" (descenders included) meets the line under it', () => {
    // Before: the label sat 8 px over the line's middle, and the line climbed past its descenders at its right end.
    expect(clearance(slanted)).toBeGreaterThanOrEqual(LABEL_CLEAR - 3 - 1);
  });

  it('a level line keeps its label where it was, 8 px over its middle', () => {
    const level = { ...slanted, y1: 200, y2: 200 };
    const at = edgeTexts(level).label;
    expect(at.y).toBe(192);
    expect(at.anchor).toBe('middle');
    // and a label beside a line that runs down is not moved
    const down = layout.edges.find((e) => e.id === 'R1')!;
    expect(edgeTexts(down).label.anchor).toBe('start');
  });

  it('a line running right to left carries its label under it, its capitals clear of the line', () => {
    const back = { ...slanted, x1: slanted.x2, y1: slanted.y2, x2: slanted.x1, y2: slanted.y1 };
    const at = edgeTexts(back).label;
    const half = ('is tagged through'.length * UML.LABEL_CHAR_W) / 2;
    const lineAt = (x: number) => back.y1 + ((x - back.x1) * (back.y2 - back.y1)) / (back.x2 - back.x1);
    // the capitals stand about 9 px over the baseline: their top is still 8 px under the line at both ends
    expect(at.y - 9 - Math.max(lineAt(at.x - half), lineAt(at.x + half))).toBeGreaterThanOrEqual(LABEL_CLEAR - 1);
  });

  it('draws the label where edgeTexts places it', () => {
    const div = document.createElement('div');
    div.innerHTML = renderToStaticMarkup(<UmlDiagram doc={LOCAL} />);
    const text = div.querySelector('[data-testid="design-uml-edge-R3"] text[font-style="italic"]')!;
    expect(Number(text.getAttribute('y'))).toBe(edgeTexts(slanted).label.y);
  });
});
