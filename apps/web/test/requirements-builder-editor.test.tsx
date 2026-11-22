// @vitest-environment jsdom
/**
 * The Requirements builder inside the real project editor.
 *
 * The builder owns the phase's one story task. A concept quiz beside it is a
 * supported layout and stays on the editor's own task list under the builder,
 * editable as on any phase. "Add a concept quiz" is the editor's one add
 * button, so a second written task is never one click away. The story
 * task's required mark goes through the editor's own `tasks.setRequired`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPhaseView, DraftTaskView, DraftVersionView, TaskMutationResult } from '@learnsdlc/shared';
import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_STORY_FLOOR,
  QUIZ_ONLY_ADD_REFUSAL,
  SUPPORTED_STACKS_SENTENCE,
  summariseValidation,
} from '@learnsdlc/shared';

const draft = vi.fn();
const get = vi.fn();
const files = vi.fn();
const setTaskRequired = vi.fn();
const reorderTasks = vi.fn();
const updateTask = vi.fn();
const updatePhase = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    get: (...a: unknown[]) => get(...a),
    files: (...a: unknown[]) => files(...a),
    setTaskRequired: (...a: unknown[]) => setTaskRequired(...a),
    updateTask: (...a: unknown[]) => updateTask(...a),
    updatePhase: (...a: unknown[]) => updatePhase(...a),
    putInterview: vi.fn(),
    readInterview: vi.fn(),
    removeInterview: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    addTask: vi.fn(),
    reorderTasks: (...a: unknown[]) => reorderTasks(...a),
    removeTask: vi.fn(),
    createDraft: vi.fn(),
    readQuizKey: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p-mine', versionId: 'v-mine' }),
  usePathname: () => '/teacher/projects/p-mine/versions/v-mine',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'teacher-one', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { forgetTaskSaves } from '@/components/staff/projects/requirements/RequirementsBuilder';
import { phaseSetFor } from './support/phase-set';

const STORY_TASK = {
  taskKey: 'main',
  order: 1,
  required: true,
  title: 'Write SH-4',
  brief: 'Interview, then write.',
  artefactType: 'user-story',
  artefactPath: null,
  checkKind: 'story',
  rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'A', description: 'd', weight: 1 }] },
  objectives: [],
  owns: ['requirements/story.json'],
  authorable: true,
  notice: null,
  story: {
    kind: 'story',
    record: 'requirements/story.json',
    providedStories: [{ id: 'SH-1', title: 'Add a book', persona: 'librarian', capability: 'add', benefit: 'find' }],
    learnerStory: { id: 'SH-4', hints: {} },
    floor: DEFAULT_STORY_FLOOR,
  },
} as unknown as DraftTaskView;

const QUIZ = {
  taskKey: 'concepts',
  order: 2,
  required: false,
  title: 'The concept check',
  brief: 'Answer the questions.',
  artefactType: 'quiz',
  artefactPath: null,
  checkKind: 'quiz',
  owns: [],
  authorable: true,
  notice: null,
  objectives: [],
  rubric: {
    passThreshold: DEFAULT_PASS_THRESHOLD,
    criteria: [{ key: 'concepts', title: 'Concepts', weight: 1, description: 'What it scores.' }],
  },
  quiz: {
    questions: [
      {
        id: 'concepts-1',
        stem: 'The first question.',
        options: [
          { id: 'a', text: 'The first option.' },
          { id: 'b', text: 'The second option.' },
        ],
        answerCount: 1,
      },
    ],
    shuffleOptions: true,
    passMark: 60,
    attempts: { max: null, cooldownSeconds: null },
    criterion: 'concepts',
  },
} as unknown as DraftTaskView;

function phase(tasks: DraftTaskView[]): DraftPhaseView {
  return {
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    intro: 'A library.',
    artifactKind: 'story',
    checkKind: 'story',
    tasks,
    blocksPublish: false,
  } as DraftPhaseView;
}

/** A second phase to switch to, which unmounts the builder. */
const DESIGN = {
  key: 'design',
  order: 2,
  title: 'Design',
  intro: 'Sketch it.',
  artifactKind: 'design',
  checkKind: 'design',
  blocksPublish: false,
  tasks: [
    {
      ...STORY_TASK,
      story: undefined,
      checkKind: 'design',
      artefactType: 'design-doc',
      title: 'Design it',
      artefactPath: null,
      owns: ['design/design.json'],
    },
  ],
} as unknown as DraftPhaseView;

function version(tasks: DraftTaskView[], withDesign = false): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'shelf',
    title: 'Shelf',
    tagline: 'A shelf',
    description: 'Uploaded.',
    platformOwned: false,
    editable: true,
    phases: withDesign ? [phase(tasks), DESIGN] : [phase(tasks)],
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-14T00:00:00.000Z',
    phaseSet: phaseSetFor(withDesign ? ['requirements', 'design'] : ['requirements'], true),
  };
}

let root: Root;
let host: HTMLDivElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount(view: DraftVersionView) {
  draft.mockResolvedValue(view);
  await act(async () => {
    root.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />);
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  get.mockResolvedValue({ project: { mine: true }, versions: [] });
});

afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root.unmount());
  host.remove();
  forgetTaskSaves();
});

describe('Requirements in the project editor', () => {
  it('draws the builder for the story and keeps the quiz beside it on the task list', async () => {
    await mount(version([STORY_TASK, QUIZ]));
    expect(byId('requirements-builder')).not.toBeNull();
    expect(byId('phase-scenario-requirements')).toBeNull();
    // The quiz keeps its row and its own controls; the story task has no row.
    expect(byId('task-row-concepts')).not.toBeNull();
    expect(byId('task-edit-concepts')).not.toBeNull();
    expect(byId('task-row-main')).toBeNull();
  });

  it('moves the quiz past the story task, over the whole order of the phase', async () => {
    reorderTasks.mockResolvedValue({
      phase: phase([{ ...QUIZ, order: 1 } as DraftTaskView, { ...STORY_TASK, order: 2 } as DraftTaskView]),
      validation: summariseValidation('fast', '2026-10-14T00:00:00.000Z', []),
    });
    await mount(version([STORY_TASK, QUIZ]));
    expect((byId('task-up-concepts') as HTMLButtonElement).disabled).toBe(false);
    expect((byId('task-down-concepts') as HTMLButtonElement).disabled).toBe(true);
    await click('task-up-concepts');
    expect(reorderTasks).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', ['concepts', 'main']);
    // Now first, it can move back down past the story, and no further up.
    expect((byId('task-up-concepts') as HTMLButtonElement).disabled).toBe(true);
    expect((byId('task-down-concepts') as HTMLButtonElement).disabled).toBe(false);
    // The gate still counts the story task the builder draws.
    expect(byId('project-phase-gating-requirements')?.textContent).toBe(
      'This phase passes when its 1 required task passes. 1 optional task is extra credit and never blocks.',
    );
  });

  it('offers a concept quiz, and only a quiz, from "Add a concept quiz"', async () => {
    await mount(version([STORY_TASK]));
    expect(byId('project-add-task')?.textContent).toContain('Add a concept quiz');
    await click('project-add-task');
    expect(byId('task-form-type')).toBeNull();
    expect(byId('quiz-editor')).not.toBeNull();
    expect(host.textContent).toContain(QUIZ_ONLY_ADD_REFUSAL);
  });

  it("toggles the story task's required mark through tasks.setRequired", async () => {
    setTaskRequired.mockResolvedValue({
      phase: phase([{ ...STORY_TASK, required: false } as DraftTaskView]),
      validation: summariseValidation('fast', '2026-10-14T00:00:00.000Z', []),
    });
    await mount(version([STORY_TASK]));
    expect(byId('task-required-toggle-main')?.textContent).toBe('Make optional');
    await click('task-required-toggle-main');
    expect(setTaskRequired).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', 'main', false);
    expect(byId('task-required-toggle-main')?.textContent).toBe('Make required');
  });

  it('draws the sign-off help once, in the builder, beside a quiz', async () => {
    await mount(version([STORY_TASK, QUIZ]));
    expect(host.querySelectorAll('#task-signoff-help-requirements')).toHaveLength(1);
    expect(byId('requirements-builder')!.querySelector('#task-signoff-help-requirements')).not.toBeNull();
  });
});

describe('switching tabs while the story is saving', () => {
  const REPORT = summariseValidation('fast', '2026-10-14T00:00:00.000Z', []);
  /** A reply the test hands back when it chooses. */
  function deferred() {
    let resolve!: (value: TaskMutationResult) => void;
    const promise = new Promise<TaskMutationResult>((done) => (resolve = done));
    return { promise, resolve };
  }
  const field = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const type = (label: string, value: string) => act(() => fireEvent.change(field(label), { target: { value } }));
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  /** Step 3: add SH-2 in full and ask for its save. */
  async function addStory() {
    const step = byId('tre-provided')!;
    await act(async () => {
      Array.from(step.querySelectorAll('button')).find((one) => one.textContent?.includes('Add a provided story'))!.click();
    });
    type('SH-2 title', 'Lend a book');
    type('SH-2 As a', 'member');
    type('SH-2 I want', 'to borrow');
    type('SH-2 So that', 'I can read');
    await click('tre-provided-save');
  }
  const withStories = (body: { story: { providedStories: unknown[] } }) =>
    phase([{ ...STORY_TASK, story: { ...STORY_TASK.story!, providedStories: body.story.providedStories } } as DraftTaskView]);

  it('keeps step 3 when its reply lands while another tab is open', async () => {
    const first = deferred();
    updateTask.mockReturnValueOnce(first.promise);
    await mount(version([STORY_TASK], true));
    await addStory();
    expect(updateTask).toHaveBeenCalledTimes(1);
    const sent = updateTask.mock.calls[0][4];
    await click('project-phase-tab-design');
    expect(byId('requirements-builder')).toBeNull();
    await act(async () => {
      first.resolve({ phase: withStories(sent), validation: REPORT });
    });
    await settle();
    await click('project-phase-tab-requirements');
    updateTask.mockResolvedValue({ phase: withStories(sent), validation: REPORT });
    type('As a hint', 'librarian');
    await click('tre-learner-save');
    await settle();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask.mock.calls[1][4].story.providedStories).toEqual(sent.story.providedStories);
  });

  it('keeps step 3 when its reply lands after the tab is opened again', async () => {
    const first = deferred();
    updateTask.mockReturnValueOnce(first.promise);
    await mount(version([STORY_TASK], true));
    await addStory();
    const sent = updateTask.mock.calls[0][4];
    await click('project-phase-tab-design');
    await click('project-phase-tab-requirements');
    updateTask.mockResolvedValue({ phase: withStories(sent), validation: REPORT });
    type('As a hint', 'librarian');
    await click('tre-learner-save');
    await settle();
    // Still waiting for step 3's reply.
    expect(updateTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ phase: withStories(sent), validation: REPORT });
    });
    await settle();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask.mock.calls[1][4].story.providedStories).toEqual(sent.story.providedStories);
    expect(updateTask.mock.calls[1][4].story.learnerStory.hints).toEqual({ persona: 'librarian' });
  });

  it('saves at once an edit whose blur save was still waiting when the tab changed', async () => {
    updateTask.mockResolvedValue({ phase: phase([STORY_TASK]), validation: REPORT });
    await mount(version([STORY_TASK], true));
    type('As a hint', 'librarian');
    act(() => fireEvent.focusOut(field('As a hint')));
    expect(updateTask).not.toHaveBeenCalled();
    await click('project-phase-tab-design');
    await settle();
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][4].story.learnerStory.hints).toEqual({ persona: 'librarian' });
  });
});

describe("the cards take the server's words from a save's answer (Task 12)", () => {
  // The server stores a teacher's markdown as plain text (spec 6.2), so a card
  // shows what is stored once a save answers, unless something was typed since.
  const field = (id: string) => byId(id) as HTMLInputElement | HTMLTextAreaElement;
  const labelled = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  const type = async (el: Element | null, value: string) => {
    expect(el).not.toBeNull();
    await act(async () => {
      fireEvent.change(el!, { target: { value } });
    });
  };
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  const story = STORY_TASK as unknown as { story: { providedStories: Record<string, unknown>[]; learnerStory: { id: string; hints: Record<string, string> } } };
  const answered = (over: Record<string, unknown>, intro?: string): TaskMutationResult => ({
    phase: { ...phase([{ ...STORY_TASK, ...over } as DraftTaskView]), ...(intro ? { intro } : {}) },
    validation: null,
  } as unknown as TaskMutationResult);

  it("the Background card takes the server's plain intro, and keeps what is typed while its save is out", async () => {
    await mount(version([STORY_TASK]));
    updatePhase.mockResolvedValueOnce(answered({}, 'A library of books.'));
    await type(field('tre-background-field'), 'A **library** of books.');
    await click('tre-background-save');
    await settle();
    expect(updatePhase).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', { intro: 'A **library** of books.' });
    expect(field('tre-background-field').value).toBe('A library of books.');

    let answer: (value: unknown) => void = () => undefined;
    updatePhase.mockImplementationOnce(() => new Promise((done) => (answer = done)));
    await type(field('tre-background-field'), 'Two **shelves**.');
    await click('tre-background-save');
    await type(field('tre-background-field'), 'Typed while it was out.');
    await act(async () => {
      answer(answered({}, 'Two shelves.'));
    });
    await settle();
    expect(field('tre-background-field').value).toBe('Typed while it was out.');
  });

  it("the Provided stories card takes the server's plain story from the save's answer", async () => {
    await mount(version([STORY_TASK]));
    const plain = { ...story.story.providedStories[0], title: 'Add a book' };
    updateTask.mockResolvedValueOnce(answered({ story: { ...story.story, providedStories: [plain] } }));
    await act(async () => {
      labelled('Edit SH-1').click();
    });
    await type(labelled('SH-1 title'), '**Add** a book');
    await click('tre-provided-save');
    await settle();
    expect((updateTask.mock.calls[0][4] as { story: { providedStories: { title: string }[] } }).story.providedStories[0].title).toBe('**Add** a book');
    expect(labelled('SH-1 title').value).toBe('Add a book');
  });

  it('the Learner story card\'s brief field says it is plain text, in the editor\'s own sentence, by aria-describedby', async () => {
    await mount(version([STORY_TASK]));
    expect((((field('tre-learner-brief')).getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))).toBe("Plain text. Lists, indented lines and code in backticks are kept as you type them; a heading's # and the stars or underscores around words are removed when you save.");
  });

  it("the Learner story card takes the server's plain title and hints from the save's answer, and step 3's row follows", async () => {
    await mount(version([STORY_TASK]));
    updateTask.mockResolvedValueOnce(
      answered({ title: 'Write SH-4', story: { ...story.story, learnerStory: { id: 'SH-4', hints: { persona: 'a busy librarian' } } } }),
    );
    await type(field('tre-learner-title'), '**Write** SH-4');
    await type(labelled('As a hint'), 'a _busy_ librarian');
    await click('tre-learner-save');
    await settle();
    expect(updateTask.mock.calls[0][4]).toMatchObject({ title: '**Write** SH-4', story: { learnerStory: { hints: { persona: 'a _busy_ librarian' } } } });
    expect(field('tre-learner-title').value).toBe('Write SH-4');
    expect(labelled('As a hint').value).toBe('a busy librarian');
    expect(byId('tre-provided')?.textContent).toContain('Write SH-4');
    expect(byId('tre-provided')?.textContent).not.toContain('**');
  });
});
