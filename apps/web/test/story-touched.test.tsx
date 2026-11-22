// @vitest-environment jsdom
/**
 * After an Agentic proposal is applied, the story form marks the fields the
 * assistant wrote ("Changed by the assistant") while each still holds the text
 * the assistant wrote there. The marks are recorded as the panel records them
 * on Apply (`recordTouched`); the real desk reads them.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, serialiseStory, type Story } from '@learnsdlc/shared';
import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { storyView } from '@/components/workspace/panels/requirements/useStory';
import { clearTouched, readTouched, recordTouched, touchedKey } from '@/components/workspace/panels/requirements/touched';

const SPEC = { id: 'US-4', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] };
const story: Story = {
  ...EMPTY_STORY, title: 'Overdue report', persona: 'planner', capability: 'an overdue report', benefit: 'I catch what slipped',
  criteria: [
    { id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' },
    { id: 'AC-2', given: 'a task due today', when: 'I open the report', then: 'it is not listed', tag: 'boundary' },
  ],
  scopeExclusions: ['reminders'],
};

let host: HTMLDivElement;
let root: Root;
const render = (phaseId?: string, shown: Story = story) =>
  act(() => root.render(
    <IssueDesk phaseId={phaseId} view={storyView(serialiseStory(shown), SPEC)} spec={SPEC} providedStories={[]} projectTitle="TaskTrackr"
      statusLabel="In progress" statusTone="accent" storyState="now" assignedTo="Ada" canRecord setStory={() => {}} />,
  ));
const marks = () => Array.from(host.querySelectorAll('[data-testid="story-touched"]'));
const openEditor = () => act(() => Array.from(host.querySelectorAll('button')).find(one => one.textContent === 'Edit your story')!.click());

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('fields the assistant changed', () => {
  /** An apply whose proposal wrote `story` and changed these paths. */
  const applied = (paths: string[], after: Story = story) => recordTouched('phase-a', paths, after);

  it('marks each changed field, criterion and out-of-scope line in the story form', () => {
    applied(['story/title', 'story/so-that', 'story/ac-2/given', 'story/ac-2/tag', 'story/scope/1']);
    render('phase-a');
    openEditor();
    expect(marks()).toHaveLength(4);
    expect(marks().every(mark => mark.textContent === 'Changed by the assistant')).toBe(true);
    expect(host.querySelector('[data-testid="phase-requirements-criterion-2"] [data-testid="story-touched"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="phase-requirements-criterion-1"] [data-testid="story-touched"]')).toBeNull();
  });

  it('drops the mark of a field the learner rewrites, and keeps it when the edit is cancelled', () => {
    applied(['story/so-that', 'story/ac-2/given']);
    render('phase-a');
    openEditor();
    expect(marks()).toHaveLength(2);
    act(() => { fireEvent.change(host.querySelector('[data-testid="phase-requirements-benefit"]')!, { target: { value: 'I chase it first' } }); });
    expect(marks()).toHaveLength(1);
    // A criterion is the assistant's only as a whole: rewriting any clause drops its mark.
    act(() => { fireEvent.change(host.querySelector('[data-testid="phase-requirements-criterion-2-then"]')!, { target: { value: 'it waits until tomorrow' } }); });
    expect(marks()).toHaveLength(0);
    // Cancel: the saved story still holds the assistant's text, so both marks return.
    act(() => Array.from(host.querySelectorAll('button')).find(one => one.textContent === 'Cancel')!.click());
    openEditor();
    expect(marks()).toHaveLength(2);
  });

  it('does not mark the learner\'s criterion moved into the assistant\'s position, though a clause matches', () => {
    // The assistant added AC-2, which shares AC-1's "when".
    applied(['story/ac-2/given', 'story/ac-2/when', 'story/ac-2/then', 'story/ac-2/tag']);
    render('phase-a');
    openEditor();
    expect(host.querySelector('[data-testid="phase-requirements-criterion-2"] [data-testid="story-touched"]')).not.toBeNull();
    act(() => (host.querySelector('[aria-label="Move AC-2 up"]') as HTMLButtonElement).click());
    expect(host.querySelector<HTMLTextAreaElement>('[data-testid="phase-requirements-criterion-2-given"]')!.value).toBe('a task due yesterday');
    expect(marks()).toHaveLength(0);
  });

  it('does not mark a criterion the learner wrote where they deleted the assistant\'s, though a clause matches', () => {
    applied(['story/ac-2/given', 'story/ac-2/when', 'story/ac-2/then', 'story/ac-2/tag']);
    render('phase-a', { ...story, criteria: [story.criteria[0], { id: 'AC-2', given: 'a task with no due date', when: 'I open the report', then: 'it is not listed', tag: 'boundary' }] });
    openEditor();
    expect(marks()).toHaveLength(0);
  });

  it('does not mark a saved field the learner rewrote after the apply', () => {
    applied(['story/so-that']);
    render('phase-a', { ...story, benefit: 'I chase it first' });
    openEditor();
    expect(marks()).toHaveLength(0);
  });

  it('never marks a row the learner added where the assistant removed one', () => {
    // The assistant removed AC-3 and the second out-of-scope line.
    const before: Story = { ...story, criteria: [...story.criteria, { id: 'AC-3', given: 'g', when: 'w', then: 't', tag: 'error' }], scopeExclusions: ['reminders', 'sorting'] };
    applied(['story/ac-3/given', 'story/ac-3/when', 'story/ac-3/then', 'story/ac-3/tag', 'story/scope/2']);
    expect(readTouched('phase-a')).toEqual({});
    // A later apply that wrote the same row is merged, and one that removes it again forgets it.
    applied(['story/scope/2'], before);
    expect(Object.keys(readTouched('phase-a'))).toEqual(['story/scope/2']);
    applied(['story/scope/2']);
    expect(readTouched('phase-a')).toEqual({});
    render('phase-a', { ...story, criteria: [...story.criteria, { id: 'AC-3', given: 'a deleted task', when: 'I open the report', then: 'it is not listed', tag: 'error' }], scopeExclusions: ['reminders', 'exports'] });
    openEditor();
    expect(marks()).toHaveLength(0);
  });

  it('marks nothing without a record of changes, or once it is cleared on submit or reset', () => {
    render('phase-a');
    openEditor();
    expect(marks()).toHaveLength(0);
    applied(['story/so-that']);
    expect(sessionStorage.getItem(touchedKey('phase-a'))).not.toBeNull();
    clearTouched('phase-a');
    expect(readTouched('phase-a')).toEqual({});
    expect(sessionStorage.getItem(touchedKey('phase-a'))).toBeNull();
  });
});
