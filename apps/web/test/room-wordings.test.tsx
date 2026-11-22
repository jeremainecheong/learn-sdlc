/**
 * Two wordings in the rooms.
 *
 * - Requirements' story checks read "At least 1 out-of-scope lines". A count of one is singular where the list is
 *   shown (the shared `storyFloorShown`, which the review's evidence lines already use), and the list's other counted
 *   line, the criteria, follows the same rule ("1 complete criterion"). The floor's own label and detail, which reach
 *   the reviewer's request, are not changed: only what the room draws.
 * - Design's drawn class diagram labelled the operations box "Operations / API contract" on the Deadline badge project, whose API
 *   contract switch is off. With no API contract and no file to name, the box carries no note.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STORY_FLOOR, EMPTY_DESIGN, EMPTY_STORY, evaluateStoryFloor, type Design, type Story } from '@learnsdlc/shared';
import { StoryChecks, storyCheckShown } from '@/components/workspace/panels/requirements/Checks';
import { ClassDiagram } from '@/components/workspace/panels/design/ClassDiagram';
import { DrawnSection } from '@/components/workspace/panels/design/DesignBoard';
import type { DesignState } from '@/components/workspace/panels/design/useDesign';

/** The Deadline badge story after an Apply: two criteria, one out-of-scope line, against a floor of two criteria and one line. */
const STORY: Story = {
  ...EMPTY_STORY, persona: 'a team member', capability: 'see a badge on tasks due before today', benefit: 'I can quickly identify overdue tasks',
  criteria: [
    { id: 'AC-1', tag: 'happy', given: 'a task is due yesterday', when: 'I view the task list', then: 'the task shows the overdue badge' },
    { id: 'AC-2', tag: 'boundary', given: 'a task is due today', when: 'I view the task list', then: 'the overdue badge is not shown' },
  ],
  scopeExclusions: ['Reminders and notifications'],
};
const FLOOR = { ...DEFAULT_STORY_FLOOR, minCriteria: 2, minExclusions: 1 };

describe('the story checks say a count of one in the singular', () => {
  it('the demo\'s list: "At least 1 out-of-scope line", "1 out-of-scope line"', () => {
    const html = renderToStaticMarkup(<StoryChecks results={evaluateStoryFloor(STORY, FLOOR)} />);
    expect(html).toContain('At least 1 out-of-scope line<');
    expect(html).toContain('>1 out-of-scope line<');
    expect(html).not.toContain('1 out-of-scope lines');
    // the criteria, at two, as they were
    expect(html).toContain('At least 2 acceptance criteria');
    expect(html).toContain('2 complete criteria');
  });

  it('the criteria line at one, passed and not yet', () => {
    expect(storyCheckShown('1 complete criteria')).toBe('1 complete criterion');
    expect(storyCheckShown('Story has fewer than 1 acceptance criteria')).toBe('Story has fewer than 1 acceptance criterion');
    expect(storyCheckShown('Fewer than 1 out-of-scope lines')).toBe('Fewer than 1 out-of-scope line');
  });

  it('counts other than one, and every other check, read as written', () => {
    for (const text of ['At least 2 out-of-scope lines', 'Fewer than 2 out-of-scope lines', '11 out-of-scope lines', '0 complete criteria',
      '12 complete criteria', 'Story has fewer than 2 acceptance criteria', 'At least 1 acceptance criterion', 'A full story sentence',
      'No boundary case among the criteria', 'Every required case is covered']) {
      expect(storyCheckShown(text)).toBe(text);
    }
  });

  it('the floor\'s own words, which reach the reviewer, are not changed', () => {
    const scope = evaluateStoryFloor(STORY, FLOOR).find((r) => r.id === 'story.scope.min')!;
    expect(scope.label).toBe('At least 1 out-of-scope lines');
    expect(scope.detail).toBe('1 out-of-scope lines');
  });
});

const DOC: Design = { ...EMPTY_DESIGN, operations: [{ id: 'O1', name: 'isOverdue', inputs: ['task: Task'], returns: 'boolean', errors: [], satisfies: ['US-1'] }] };
describe('the drawn class diagram says only what the project has', () => {
  it('no API contract and no file: "Operations" with no note', () => {
    const html = renderToStaticMarkup(<ClassDiagram doc={DOC} codePath={null} apiContract={false} />);
    expect(html).toContain('>Operations<');
    expect(html).not.toContain('API contract');
  });
  it('with an API contract, or left unsaid, "Operations / API contract"; a file names the file', () => {
    expect(renderToStaticMarkup(<ClassDiagram doc={DOC} codePath={null} apiContract />)).toContain('>API contract<');
    expect(renderToStaticMarkup(<ClassDiagram doc={DOC} codePath={null} />)).toBe(renderToStaticMarkup(<ClassDiagram doc={DOC} codePath={null} apiContract />));
    expect(renderToStaticMarkup(<ClassDiagram doc={DOC} codePath="api/services/tasks.py" apiContract={false} />)).toContain('>tasks.py<');
  });
  it('the Review tab\'s drawn section passes the project\'s switch: the demo (off) draws no "API contract"; a project with one does', () => {
    const drawn = (api: boolean) => renderToStaticMarkup(<DrawnSection design={{ doc: DOC, contracts: { api, screens: false } } as unknown as DesignState} files={{}} />);
    expect(drawn(false)).not.toContain('API contract');
    expect(drawn(true)).toContain('>API contract<');
  });
});
