// @vitest-environment jsdom
/**
 * The story form never builds a record the workspace save refuses: every list
 * stops at `STORY_CAPS.listItems` and every typed field at
 * `STORY_CAPS.fieldChars`, the caps `validateStoryRecord` enforces. The real
 * desk and the real validator; nothing is mocked.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, LEARNER_PICKS, STORY_CAPS, serialiseStory, validateStoryRecord, type Story } from '@learnsdlc/shared';
import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { storyView } from '@/components/workspace/panels/requirements/useStory';

const SPEC = {
  id: 'US-4', hints: {}, floor: DEFAULT_STORY_FLOOR,
  providedStories: [{ id: 'US-1', title: 'Add a task', persona: 'member', capability: 'to add a task', benefit: 'nothing is forgotten' }],
};
const N = STORY_CAPS.listItems;
const full: Story = {
  ...EMPTY_STORY,
  title: 'Full',
  criteria: Array.from({ length: N }, (_, i) => ({ id: `AC-${i + 1}`, given: 'g', when: 'w', then: 't', tag: 'happy' as const })),
  scopeExclusions: Array.from({ length: N }, (_, i) => `out ${i + 1}`),
  epics: Array.from({ length: N }, (_, i) => ({ id: `EP-${i + 1}`, title: `Epic ${i + 1}`, outcome: 'o' })),
};

let host: HTMLDivElement;
let root: Root;
let saved: Story[] = [];
const render = (story: Story, spec: typeof SPEC = SPEC) =>
  act(() => root.render(
    <IssueDesk view={storyView(serialiseStory(story), spec)} spec={spec} providedStories={spec.providedStories} projectTitle="TaskTrackr"
      statusLabel="In progress" statusTone="accent" storyState="now" assignedTo="Ada" canRecord setStory={(next) => { saved.push(next); }} />,
  ));
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (pattern: RegExp) => Array.from(host.querySelectorAll('button')).find((one) => pattern.test(one.textContent ?? '') || pattern.test(one.getAttribute('aria-label') ?? ''));

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  saved = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the story form stays inside the record caps', () => {
  it('disables Add a criterion, Add an exclusion and Create epic once each list is full, and says why', () => {
    render(full);
    const createEpic = host.querySelector<HTMLButtonElement>('[aria-label="Create epic"]')!;
    expect(createEpic.disabled).toBe(true);
    expect(createEpic.title).toMatch(/full/i);
    act(() => button(/^Edit your story$/)!.click());
    const addCriterion = byTestId('phase-requirements-criterion-add') as HTMLButtonElement;
    const addExclusion = byTestId('phase-requirements-scope-add') as HTMLButtonElement;
    for (const control of [addCriterion, addExclusion]) {
      expect(control.disabled).toBe(true);
      expect(control.title).toMatch(/full/i);
    }
    act(() => addCriterion.click());
    act(() => addExclusion.click());
    expect(host.querySelectorAll('[data-testid^="phase-requirements-criterion-"][data-testid$="-given"]')).toHaveLength(N);
  });

  it('keeps the add controls open one short of the cap', () => {
    render({ ...full, criteria: full.criteria.slice(1), scopeExclusions: full.scopeExclusions.slice(1), epics: full.epics!.slice(1) });
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Create epic"]')!.disabled).toBe(false);
    act(() => button(/^Edit your story$/)!.click());
    expect((byTestId('phase-requirements-criterion-add') as HTMLButtonElement).disabled).toBe(false);
    expect((byTestId('phase-requirements-scope-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('cuts a pasted over-cap field to the cap, so the saved record validates', () => {
    render({ ...EMPTY_STORY, title: 'T', criteria: [{ id: 'AC-1', given: '', when: '', then: '', tag: 'happy' }], scopeExclusions: [''] });
    act(() => button(/^Edit your story$/)!.click());
    const long = 'x'.repeat(STORY_CAPS.fieldChars + 50);
    for (const id of ['phase-requirements-title', 'phase-requirements-persona', 'phase-requirements-notes', 'phase-requirements-criterion-1-given', 'phase-requirements-scope-1']) {
      const field = byTestId(id) as HTMLTextAreaElement;
      expect(field.maxLength).toBe(STORY_CAPS.fieldChars);
      act(() => { fireEvent.change(field, { target: { value: long } }); });
      expect(field.value).toHaveLength(STORY_CAPS.fieldChars);
    }
    act(() => button(/^Save story$/)!.click());
    const record = serialiseStory(saved.at(-1)!);
    expect(validateStoryRecord(record, 'US-4').error).toBeNull();
  });

  it('cuts the epic form fields to the cap too', () => {
    render({ ...EMPTY_STORY, title: 'T' });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Create epic"]')!.click());
    const fields = host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.jira-epic-form input, .jira-epic-form textarea');
    const long = 'y'.repeat(STORY_CAPS.fieldChars + 1);
    for (const field of Array.from(fields)) {
      expect(field.maxLength).toBe(STORY_CAPS.fieldChars);
      act(() => { fireEvent.change(field, { target: { value: long } }); });
      expect(field.value).toHaveLength(STORY_CAPS.fieldChars);
    }
  });
});

describe('a learner-picked id', () => {
  const picks = { ...SPEC, id: LEARNER_PICKS };
  it('asks for an id when it is empty, and names a clash with a provided story without hiding that story', () => {
    render({ ...EMPTY_STORY, id: '', title: 'T' }, picks);
    act(() => button(/^Edit your story$/)!.click());
    expect(byTestId('phase-requirements-story-id-note')?.textContent).toBe('Give your story an id.');
    act(() => button(/^Cancel$/)!.click());
    render({ ...EMPTY_STORY, id: 'US-1', title: 'T' }, picks);
    // The provided US-1 is still listed beside the learner's own story.
    expect(Array.from(host.querySelectorAll('.jira-issue-row code')).map((one) => one.textContent)).toEqual(['US-1', 'US-1']);
    act(() => button(/^Edit your story$/)!.click());
    expect(byTestId('phase-requirements-story-id-note')?.textContent).toBe('US-1 is a provided story; pick another id.');
  });

  it('says nothing under an id of its own', () => {
    render({ ...EMPTY_STORY, id: 'US-9', title: 'T' }, picks);
    act(() => button(/^Edit your story$/)!.click());
    expect(byTestId('phase-requirements-story-id-note')).toBeNull();
  });
});
