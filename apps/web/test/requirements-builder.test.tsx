// @vitest-environment jsdom
/**
 * The five-step Requirements builder in the teacher's editor.
 *
 * The builder is mounted alone, with the authoring client as the only seam.
 * It draws the phase the way a learner meets it: the background, the
 * stakeholder, the provided stories, the learner's story with its floor, and
 * the weighted criteria. Every save goes through the doors that already exist
 * (`updatePhase`, `putInterview`, `updateTask`), and every refusal the server
 * answers with is printed word for word.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent, screen, within } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPhaseView, DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, LEARNER_PICKS } from '@learnsdlc/shared';

const updateTask = vi.fn();
const updatePhase = vi.fn();
const putInterview = vi.fn();
const readInterview = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    updateTask: (...a: unknown[]) => updateTask(...a),
    updatePhase: (...a: unknown[]) => updatePhase(...a),
    putInterview: (...a: unknown[]) => putInterview(...a),
    readInterview: (...a: unknown[]) => readInterview(...a),
  },
}));

import {
  RequirementsBuilder,
  criterionKey,
  forgetTaskSaves,
  requirementsBuilderTask,
} from '@/components/staff/projects/requirements/RequirementsBuilder';
import { ApiError } from '@/lib/api';
import { expectSignOffJumpLands } from './support/signoff-jump';
import { expectStepLinksLand } from './support/step-links';

const baseTask = {
  taskKey: 'main',
  order: 1,
  title: 'Write SH-4',
  brief: 'Interview, then write.',
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
    providedStories: [{ id: 'SH-1', title: 'Add a book', persona: 'librarian', capability: 'add', benefit: 'find' }],
    learnerStory: { id: 'SH-4', hints: {} },
    floor: DEFAULT_STORY_FLOOR,
  },
  rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'A', description: 'd', weight: 1 }] },
} as unknown as DraftTaskView;

const basePhase = {
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  intro: 'A library.',
  artifactKind: 'story',
  blocksPublish: false,
  tasks: [baseTask],
  interview: {
    persona: { name: 'Priya', role: 'librarian' },
    opening: 'Hello.',
    maxTurns: 10,
    factsExpected: 1,
    facts: [{ id: 'f1', topic: 'who reads the list' }],
  },
} as unknown as DraftPhaseView;

const result = (phase: DraftPhaseView = basePhase): TaskMutationResult =>
  ({ phase, validation: { ok: true, checks: [] } }) as unknown as TaskMutationResult;

let host: HTMLDivElement;
let root: Root;
let onSaved: ReturnType<typeof vi.fn<(result: TaskMutationResult) => void>>;

function mount({
  task = baseTask,
  phase = basePhase,
  editable = true,
}: { task?: DraftTaskView; phase?: DraftPhaseView; editable?: boolean } = {}) {
  act(() =>
    root.render(
      <RequirementsBuilder
        projectId="p"
        versionId="v"
        phase={phase}
        task={task}
        editable={editable}
        onSaved={onSaved}
      />,
    ),
  );
}

const card = (step: string) => screen.getByTestId(`tre-${step}`);
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const type = (el: Element, value: string) => act(() => fireEvent.change(el, { target: { value } }));
const click = (el: Element) => act(() => fireEvent.click(el));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onSaved = vi.fn<(result: TaskMutationResult) => void>();
  updateTask.mockResolvedValue(result());
  updatePhase.mockResolvedValue(result());
  putInterview.mockResolvedValue(result());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetTaskSaves();
  vi.useRealTimers();
});

describe('the step bar and the floor', () => {
  it('renders five steps, marks each by its rule, and states the floor in one sentence', () => {
    mount();
    const steps = screen.getAllByRole('listitem', { name: /step/i });
    expect(steps).toHaveLength(5);
    expect(steps.map((one) => one.getAttribute('aria-label'))).toEqual([
      'Step 1, Background, done',
      'Step 2, Stakeholder, done',
      'Step 3, Provided stories, done',
      "Step 4, The learner's story, done",
      'Step 5, Criteria, done',
    ]);
    expect(screen.getByText(/at least 2 criteria including a happy path and a boundary case/)).toBeTruthy();
    expect(screen.getByText('SH-1')).toBeTruthy();
  });

  it('the floor sentence follows the controls', () => {
    mount();
    click(screen.getByRole('button', { name: 'Error' }));
    expect(screen.getByText(/a happy path, a boundary case and an error case/)).toBeTruthy();
    click(screen.getByRole('button', { name: 'More acceptance criteria' }));
    expect(screen.getByText(/at least 3 criteria/)).toBeTruthy();
    click(screen.getByRole('button', { name: 'Fewer out-of-scope lines' }));
    expect(screen.getByText(/at least 0 out-of-scope lines/)).toBeTruthy();
    click(screen.getByRole('button', { name: 'As a, I want, So that all filled' }));
    expect(screen.queryByText(/a full story sentence/)).toBeNull();
  });

  it('keeps the floor inside its caps', () => {
    mount();
    const fewer = screen.getByRole('button', { name: 'Fewer acceptance criteria' });
    click(fewer);
    expect((screen.getByLabelText('Minimum acceptance criteria') as HTMLInputElement).value).toBe('1');
    expect((fewer as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows no grade: no score, no pill, no count of steps done', () => {
    mount();
    expect(host.textContent).not.toMatch(/\d+ of 5/);
    // The criteria card's pass-mark line does not use the word, so nothing on the
    // builder may: no score of the build, no weight's share of one, no pill, no count.
    // A whole word: the plain-text hint under the brief says "underscores".
    expect(host.textContent ?? '').not.toMatch(/\bscores?\b/i);
  });

  it('marks a step not yet done from what is saved', () => {
    const phase = { ...basePhase, intro: '', interview: undefined } as unknown as DraftPhaseView;
    const task = {
      ...baseTask,
      story: { ...baseTask.story!, providedStories: [] },
      rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'A', description: 'd', weight: 0.5 }] },
    } as DraftTaskView;
    mount({ phase, task });
    const labels = screen.getAllByRole('listitem', { name: /step/i }).map((one) => one.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Step 1, Background, not yet',
      'Step 2, Stakeholder, not yet',
      'Step 3, Provided stories, not yet',
      "Step 4, The learner's story, done",
      'Step 5, Criteria, not yet',
    ]);
  });
});

describe('the learner story step', () => {
  it('saves the title, brief and the whole story body', async () => {
    mount();
    click(screen.getByRole('button', { name: 'Error' }));
    type(screen.getByLabelText('As a hint'), 'librarian');
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'requirements', 'main', {
      title: 'Write SH-4',
      brief: 'Interview, then write.',
      objectives: ['one'],
      artefactType: 'user-story',
      story: {
        providedStories: baseTask.story!.providedStories,
        learnerStory: { id: 'SH-4', hints: { persona: 'librarian' } },
        floor: { ...DEFAULT_STORY_FLOOR, requiredTags: ['happy', 'boundary', 'error'] },
      },
    });
    expect(onSaved).toHaveBeenCalled();
    expect(within(card('learner-story')).getByText('Saved')).toBeTruthy();
  });

  it('refuses a learner id that is a provided story, before the save, in teacher words', async () => {
    mount();
    type(screen.getByLabelText('Story id'), 'SH-1');
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    expect(
      within(card('learner-story')).getByText("SH-1 is already a provided story. Give the learner's story its own id."),
    ).toBeTruthy();
  });

  it('sends a whole number for a floor typed as a fraction', async () => {
    mount();
    type(screen.getByLabelText('Minimum acceptance criteria'), '2.5');
    expect((screen.getByLabelText('Minimum acceptance criteria') as HTMLInputElement).value).toBe('3');
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    expect(updateTask.mock.calls[0][4].story.floor.minCriteria).toBe(3);
  });

  it('saves 600 ms after focus leaves the card', async () => {
    vi.useFakeTimers();
    mount();
    const field = screen.getByLabelText('Title');
    type(field, 'Overdue loans list');
    act(() => fireEvent.focusOut(field));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await flush();
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][4].title).toBe('Overdue loans list');
  });

  it('lets the learner pick the id', async () => {
    mount();
    click(screen.getByLabelText('The learner picks the id'));
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    const body = updateTask.mock.calls[0][4];
    expect(body.story.learnerStory.id).toBe(LEARNER_PICKS);
  });

  it('prints the server refusal word for word', async () => {
    updateTask.mockRejectedValueOnce(new ApiError(400, 'A story task belongs to the Requirements phase.'));
    mount();
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    expect(within(card('learner-story')).getByText('A story task belongs to the Requirements phase.')).toBeTruthy();
  });

  it('opens a task in the older format on defaults and converts it on the first save', async () => {
    const legacy = { ...baseTask, story: undefined, checkKind: 'markdown' } as unknown as DraftTaskView;
    mount({ task: legacy });
    expect(screen.getByText('This task is in the older format. Saving any story step converts it.')).toBeTruthy();
    expect(
      screen.getAllByRole('listitem', { name: /step/i })[3].getAttribute('aria-label'),
    ).toBe("Step 4, The learner's story, not yet");
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    const body = updateTask.mock.calls[0][4];
    expect(body.story).toEqual({
      providedStories: [],
      learnerStory: { id: LEARNER_PICKS, hints: {} },
      floor: DEFAULT_STORY_FLOOR,
    });
  });
});

describe('a task in the older format', () => {
  const legacy = { ...baseTask, story: undefined, checkKind: 'markdown' } as unknown as DraftTaskView;

  it('converts it with the provided stories step', async () => {
    mount({ task: legacy });
    const step = card('provided');
    click(within(step).getByRole('button', { name: 'Add a provided story' }));
    type(within(step).getByLabelText('US-1 title'), 'Lend a book');
    type(within(step).getByLabelText('US-1 As a'), 'member');
    type(within(step).getByLabelText('US-1 I want'), 'to borrow');
    type(within(step).getByLabelText('US-1 So that'), 'I can read');
    click(within(step).getByRole('button', { name: 'Save the provided stories' }));
    await flush();
    expect(updateTask.mock.calls[0][4]).toEqual({
      story: {
        providedStories: [{ id: 'US-1', title: 'Lend a book', persona: 'member', capability: 'to borrow', benefit: 'I can read' }],
        learnerStory: { id: LEARNER_PICKS, hints: {} },
        floor: DEFAULT_STORY_FLOOR,
      },
    });
  });

  it('converts it with the criteria step, sending the story with the rubric', async () => {
    mount({ task: legacy });
    click(within(card('criteria')).getByRole('button', { name: 'Save the criteria' }));
    await flush();
    expect(updateTask.mock.calls[0][4]).toEqual({
      rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'A', description: 'd', weight: 1 }] },
      story: { providedStories: [], learnerStory: { id: LEARNER_PICKS, hints: {} }, floor: DEFAULT_STORY_FLOOR },
    });
  });
});

describe('saves that overlap', () => {
  /** A reply the test hands back when it chooses. */
  function deferred() {
    let resolve!: (value: TaskMutationResult) => void;
    const promise = new Promise<TaskMutationResult>((done) => (resolve = done));
    return { promise, resolve };
  }

  it('keeps both parts when step 3 and step 4 save one after the other', async () => {
    const first = deferred();
    updateTask.mockReturnValueOnce(first.promise);
    mount();
    const provided = card('provided');
    click(within(provided).getByRole('button', { name: 'Add a provided story' }));
    type(within(provided).getByLabelText('SH-2 title'), 'Lend a book');
    type(within(provided).getByLabelText('SH-2 As a'), 'member');
    type(within(provided).getByLabelText('SH-2 I want'), 'to borrow');
    type(within(provided).getByLabelText('SH-2 So that'), 'I can read');
    click(within(provided).getByRole('button', { name: 'Save the provided stories' }));
    type(screen.getByLabelText('As a hint'), 'librarian');
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    // The second save waits for the first reply.
    expect(updateTask).toHaveBeenCalledTimes(1);
    const sent = updateTask.mock.calls[0][4].story.providedStories;
    expect(sent).toHaveLength(2);
    const held = { ...baseTask, story: { ...baseTask.story!, providedStories: sent } } as DraftTaskView;
    await act(async () => {
      first.resolve(result({ ...basePhase, tasks: [held] } as DraftPhaseView));
    });
    await flush();
    expect(updateTask).toHaveBeenCalledTimes(2);
    const second = updateTask.mock.calls[1][4].story;
    expect(second.providedStories).toEqual(sent);
    expect(second.learnerStory).toEqual({ id: 'SH-4', hints: { persona: 'librarian' } });
    expect(within(provided).getByText('Saved')).toBeTruthy();
  });

  it('runs a blur save asked for during a save once more after it, with what the card holds then', async () => {
    vi.useFakeTimers();
    const first = deferred();
    updateTask.mockReturnValueOnce(first.promise);
    mount();
    click(screen.getByRole('button', { name: "Save the learner's story" }));
    await flush();
    expect(updateTask).toHaveBeenCalledTimes(1);
    const field = screen.getByLabelText('Title');
    type(field, 'Overdue loans list');
    act(() => fireEvent.focusOut(field));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await flush();
    expect(updateTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(result());
    });
    await flush();
    await flush();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask.mock.calls[1][4].title).toBe('Overdue loans list');
  });

  it('locks a new criterion to the key it was sent with, whatever its title becomes', async () => {
    const first = deferred();
    updateTask.mockReturnValueOnce(first.promise);
    mount();
    const step = card('criteria');
    click(within(step).getByRole('button', { name: 'Add a criterion' }));
    type(within(step).getByLabelText('Criterion 2 title'), 'Alpha');
    type(within(step).getByLabelText('Criterion 1 weight'), '0.5');
    type(within(step).getByLabelText('Criterion 2 weight'), '0.5');
    click(within(step).getByRole('button', { name: 'Save the criteria' }));
    await flush();
    type(within(step).getByLabelText('Criterion 2 title'), 'Beta');
    await act(async () => {
      first.resolve(result());
    });
    await flush();
    // The key is not drawn under the title: the lock shows in what the next
    // save sends, the renamed criterion under the key its first save gave it.
    click(within(step).getByRole('button', { name: 'Save the criteria' }));
    await flush();
    await flush();
    const sent = updateTask.mock.calls[updateTask.mock.calls.length - 1][4].rubric.criteria[1];
    expect(sent.key).toBe('alpha');
    expect(sent.title).toBe('Beta');
    expect(within(step).queryByText('alpha')).toBeNull();
    expect(within(step).queryByText('beta')).toBeNull();
  });

  it('sends a criterion renamed during a save under the key that save locked, when the save runs again', async () => {
    vi.useFakeTimers();
    const first = deferred();
    updateTask.mockReturnValueOnce(first.promise);
    mount();
    const step = card('criteria');
    click(within(step).getByRole('button', { name: 'Add a criterion' }));
    type(within(step).getByLabelText('Criterion 2 title'), 'Alpha');
    type(within(step).getByLabelText('Criterion 1 weight'), '0.5');
    type(within(step).getByLabelText('Criterion 2 weight'), '0.5');
    click(within(step).getByRole('button', { name: 'Save the criteria' }));
    await flush();
    const renamed = within(step).getByLabelText('Criterion 2 title');
    type(renamed, 'Beta');
    // Asked for on blur while the first save is out: it runs once more after it.
    act(() => fireEvent.focusOut(renamed));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(updateTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(result());
    });
    await flush();
    await flush();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask.mock.calls[1][4].rubric.criteria[1]).toEqual({
      key: 'alpha',
      title: 'Beta',
      description: '',
      weight: 0.5,
    });
    // The key is not drawn; the field keeps the new title.
    expect(within(step).queryByText('alpha')).toBeNull();
    expect((within(step).getByLabelText('Criterion 2 title') as HTMLInputElement).value).toBe('Beta');
  });
});

describe('the background step', () => {
  it('saves the intro 600 ms after the field is left', async () => {
    vi.useFakeTimers();
    mount();
    const field = screen.getByLabelText('What learners read first');
    type(field, 'A library with one shelf.');
    act(() => fireEvent.focusOut(field));
    act(() => vi.advanceTimersByTime(599));
    expect(updatePhase).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(updatePhase).toHaveBeenCalledWith('p', 'v', 'requirements', { intro: 'A library with one shelf.' });
  });

  it('refuses an empty intro inline', async () => {
    mount();
    type(screen.getByLabelText('What learners read first'), '   ');
    click(screen.getByRole('button', { name: 'Save the background' }));
    await flush();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(within(card('background')).getByText(/Write the intro before you save it/)).toBeTruthy();
  });
});

describe('the stakeholder step', () => {
  it('reads the answers only when asked, and saves the interview whole', async () => {
    readInterview.mockResolvedValue({
      persona: { name: 'Priya', role: 'librarian' },
      opening: 'Hello.',
      unknownReply: 'I do not know.',
      refusal: 'That is your job.',
      maxTurns: 10,
      factsExpected: 1,
      facts: [{ id: 'f1', topic: 'who reads the list', keywords: ['who'], answer: 'Me.' }],
    });
    mount();
    expect(readInterview).not.toHaveBeenCalled();
    expect(within(card('stakeholder')).getByText('who reads the list')).toBeTruthy();
    click(screen.getByRole('button', { name: 'Edit the stakeholder' }));
    await flush();
    expect(readInterview).toHaveBeenCalledWith('p', 'v');
    click(screen.getByTestId('interview-save'));
    await flush();
    expect(putInterview).toHaveBeenCalledWith('p', 'v', expect.objectContaining({ opening: 'Hello.' }));
  });
});

describe('the provided stories step', () => {
  it('draws the backlog as the learner sees it and adds a story in place', async () => {
    mount();
    const step = card('provided');
    expect(step.querySelectorAll('.jira-issue-row').length).toBe(2);
    expect(within(step).getByText('The learner writes this')).toBeTruthy();
    click(within(step).getByRole('button', { name: 'Add a provided story' }));
    type(within(step).getByLabelText('SH-2 title'), 'Lend a book');
    type(within(step).getByLabelText('SH-2 As a'), 'member');
    type(within(step).getByLabelText('SH-2 I want'), 'to borrow a book');
    type(within(step).getByLabelText('SH-2 So that'), 'I can read it');
    click(within(step).getByRole('button', { name: 'Add a criterion to SH-2' }));
    type(within(step).getByLabelText('SH-2 AC-1 Given'), 'a book on the shelf');
    type(within(step).getByLabelText('SH-2 AC-1 When'), 'I borrow it');
    type(within(step).getByLabelText('SH-2 AC-1 Then'), 'it is on loan');
    click(within(step).getByRole('button', { name: 'Save the provided stories' }));
    await flush();
    const body = updateTask.mock.calls[0][4];
    expect(Object.keys(body)).toEqual(['story']);
    expect(body.story.providedStories[1]).toEqual({
      id: 'SH-2',
      title: 'Lend a book',
      persona: 'member',
      capability: 'to borrow a book',
      benefit: 'I can read it',
      criteria: [{ id: 'AC-1', given: 'a book on the shelf', when: 'I borrow it', then: 'it is on loan', tag: 'happy' }],
    });
    expect(body.story.learnerStory).toEqual(baseTask.story!.learnerStory);
  });

  it('refuses a provided story with an empty part before the save', async () => {
    mount();
    const step = card('provided');
    click(within(step).getByRole('button', { name: 'Add a provided story' }));
    click(within(step).getByRole('button', { name: 'Save the provided stories' }));
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    expect(within(step).getByRole('alert').textContent).toMatch(/SH-2/);
  });

  it('refuses a blank Given, When or Then on a provided story, and holds the save while it stands', async () => {
    vi.useFakeTimers();
    mount();
    const step = card('provided');
    click(within(step).getByRole('button', { name: 'Edit SH-1' }));
    click(within(step).getByRole('button', { name: 'Add a criterion to SH-1' }));
    type(within(step).getByLabelText('SH-1 AC-1 Given'), 'a book');
    const save = within(step).getByRole('button', { name: 'Save the provided stories' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(step).getByTestId('tre-provided-blank').textContent).toBe(
      'SH-1 AC-1 needs a Given, a When and a Then. Fill in all three, or remove it.',
    );
    // Nor does leaving the card save it, once its 600 ms are up.
    act(() => fireEvent.focusOut(within(step).getByLabelText('SH-1 AC-1 Given')));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    click(save);
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    type(within(step).getByLabelText('SH-1 AC-1 When'), 'I add it');
    type(within(step).getByLabelText('SH-1 AC-1 Then'), 'it is on the shelf');
    expect(save.disabled).toBe(false);
  });

  it("refuses a provided id that is the learner's, in teacher words", async () => {
    mount();
    const step = card('provided');
    click(within(step).getByRole('button', { name: 'Edit SH-1' }));
    type(within(step).getByLabelText('SH-1 id'), 'SH-4');
    click(within(step).getByRole('button', { name: 'Save the provided stories' }));
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    expect(within(step).getByRole('alert').textContent).toBe(
      "SH-4 is already a provided story. Give the learner's story its own id.",
    );
  });

  it('refuses two provided stories with one id', async () => {
    mount();
    const step = card('provided');
    click(within(step).getByRole('button', { name: 'Add a provided story' }));
    type(within(step).getByLabelText('SH-2 id'), 'SH-1');
    type(within(step).getByLabelText('SH-1 title'), 'Lend a book');
    type(within(step).getByLabelText('SH-1 As a'), 'member');
    type(within(step).getByLabelText('SH-1 I want'), 'to borrow');
    type(within(step).getByLabelText('SH-1 So that'), 'I can read');
    click(within(step).getByRole('button', { name: 'Save the provided stories' }));
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    expect(within(step).getByRole('alert').textContent).toBe('Two provided stories use the id SH-1. Give each its own.');
  });

  it('caps the backlog at twelve provided stories', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `SH-${i + 10}`,
      title: `Story ${i}`,
      persona: 'p',
      capability: 'c',
      benefit: 'b',
    }));
    mount({ task: { ...baseTask, story: { ...baseTask.story!, providedStories: many } } as DraftTaskView });
    expect((within(card('provided')).getByRole('button', { name: 'Add a provided story' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the criteria step', () => {
  it('blocks the save until the weights sum to 1, and sends decimals', async () => {
    mount();
    const step = card('criteria');
    click(within(step).getByRole('button', { name: 'Add a criterion' }));
    type(within(step).getByLabelText('Criterion 2 title'), 'Testable acceptance criteria');
    type(within(step).getByLabelText('Criterion 2 description'), 'Given, when, then.');
    type(within(step).getByLabelText('Criterion 2 weight'), '40%');
    click(within(step).getByRole('button', { name: 'Save the criteria' }));
    await flush();
    expect(updateTask).not.toHaveBeenCalled();
    expect(within(step).getByText('Weights must sum to 1.')).toBeTruthy();

    type(within(step).getByLabelText('Criterion 1 weight'), '0.6');
    expect(within(step).getByText('Weights sum to 1.0')).toBeTruthy();
    click(within(step).getByRole('button', { name: 'Save the criteria' }));
    await flush();
    expect(updateTask).toHaveBeenCalledWith('p', 'v', 'requirements', 'main', {
      rubric: {
        passThreshold: 70,
        criteria: [
          { key: 'a', title: 'A', description: 'd', weight: 0.6 },
          { key: 'testable-acceptance-criteria', title: 'Testable acceptance criteria', description: 'Given, when, then.', weight: 0.4 },
        ],
      },
    });
  });

  it('steps a weight by 0.1 and the pass mark by 5', () => {
    mount();
    const step = card('criteria');
    click(within(step).getByRole('button', { name: 'Less weight for criterion 1' }));
    expect((within(step).getByLabelText('Criterion 1 weight') as HTMLInputElement).value).toBe('0.9');
    click(within(step).getByRole('button', { name: 'Higher pass mark' }));
    expect((within(step).getByLabelText('Pass mark') as HTMLInputElement).value).toBe('75');
  });

  it('keeps generated keys unique', () => {
    expect(criterionKey('Scope and precision', ['scope-and-precision'])).toBe('scope-and-precision-2');
    expect(criterionKey('  A complete story sentence! ', [])).toBe('a-complete-story-sentence');
    expect(criterionKey('', [])).toBe('criterion');
  });
});

describe('read-only', () => {
  it('draws every step without inputs and without save controls', () => {
    mount({ editable: false });
    expect(screen.getAllByRole('listitem', { name: /step/i })).toHaveLength(5);
    expect(host.querySelectorAll('input, textarea, select').length).toBe(0);
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
    expect(screen.getByText(/at least 2 criteria including a happy path and a boundary case/)).toBeTruthy();
    expect(screen.getByText('A library.')).toBeTruthy();
  });
});

describe('the required mark', () => {
  it("draws the editor's own toggle in the hero and hands the click to it", () => {
    const toggle = vi.fn();
    act(() =>
      root.render(
        <RequirementsBuilder projectId="p" versionId="v" phase={basePhase} task={baseTask} editable onSaved={onSaved} onToggleRequired={toggle} />,
      ),
    );
    const button = screen.getByTestId('task-required-toggle-main');
    expect(button.textContent).toBe('Make optional');
    click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(
        <RequirementsBuilder
          projectId="p"
          versionId="v"
          phase={basePhase}
          task={{ ...baseTask, required: false } as DraftTaskView}
          editable
          onSaved={onSaved}
          onToggleRequired={toggle}
        />,
      ),
    );
    expect(screen.getByTestId('task-required-toggle-main').textContent).toBe('Make required');
  });

  it('draws no toggle where the version cannot change', () => {
    act(() =>
      root.render(
        <RequirementsBuilder projectId="p" versionId="v" phase={basePhase} task={baseTask} editable={false} onSaved={onSaved} onToggleRequired={vi.fn()} />,
      ),
    );
    expect(screen.queryByTestId('task-required-toggle-main')).toBeNull();
  });
});

describe('where the editor mounts the builder', () => {
  const legacy = { ...baseTask, story: undefined, checkKind: 'markdown' } as unknown as DraftTaskView;
  const quiz = { ...baseTask, taskKey: 'concepts', checkKind: 'quiz', story: undefined, quiz: {} } as unknown as DraftTaskView;
  const withTasks = (tasks: DraftTaskView[], key = 'requirements') => ({ ...basePhase, key, tasks }) as DraftPhaseView;

  it('takes the lone story task on Requirements, editable or not', () => {
    expect(requirementsBuilderTask(basePhase, true)).toBe(baseTask);
    expect(requirementsBuilderTask(basePhase, false)).toBe(baseTask);
  });

  it('leaves a concept quiz beside it to the task list', () => {
    expect(requirementsBuilderTask(withTasks([baseTask, quiz]), true)).toBe(baseTask);
  });

  it('takes a task in the older format only where it can be converted', () => {
    expect(requirementsBuilderTask(withTasks([legacy]), true)).toBe(legacy);
    expect(requirementsBuilderTask(withTasks([legacy]), false)).toBeNull();
    expect(requirementsBuilderTask(withTasks([{ ...legacy, authorable: false } as DraftTaskView]), true)).toBeNull();
  });

  it('keeps the generic panels for two written tasks and for every other phase', () => {
    expect(requirementsBuilderTask(withTasks([baseTask, { ...baseTask, taskKey: 'second' } as DraftTaskView]), true)).toBeNull();
    expect(requirementsBuilderTask(withTasks([baseTask], 'design'), true)).toBeNull();
  });
});

// Each link of the row of steps goes to its own card ("The learner's story" is the fourth).
describe('the row of steps', () => {
  it('each step link names its own card, in the order of the cards', () => {
    mount();
    expect(expectStepLinksLand(host)).toEqual(['Background', 'Stakeholder', 'Provided stories', "The learner's story", 'Criteria']);
  });
});

// The learner's story card's box sits above its save button; the row's Sign-off entry goes to it.
describe('the Sign-off entry', () => {
  it('follows the five steps and brings the learner story box into view, focused, never ticking it', async () => {
    mount();
    await expectSignOffJumpLands(host, 'main', 'tre-learner-story');
    expect(updateTask).not.toHaveBeenCalled();
  });
  it('is not drawn where the version cannot change, as the box is not', () => {
    mount({ editable: false });
    expect(screen.queryByTestId('tre-signoff-jump')).toBeNull();
    expect(document.getElementById('task-signoff-main')).toBeNull();
  });
});
