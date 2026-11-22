// @vitest-environment jsdom
/**
 * The project editor, and the two things it must never get wrong.
 *
 * **It says why publish would refuse, in the words publish uses.** A draft may
 * hold as many tasks in a phase as a teacher likes and a publish may not, so
 * the phase that would refuse says so beside itself, in
 * `multiTaskPublishRefusal`'s own sentence rather than a paraphrase, and the
 * Publish control is off with that reason attached rather than live and then
 * sorry.
 *
 * **A control a teacher may not use is not drawn as a control.** An inherited
 * task is read-only here, so it carries `INHERITED_TASK_NOTICE` and no edit,
 * no remove and no required toggle, not disabled ones. A disabled control is
 * a promise that one day it will work if you try harder; a Notice is the
 * truth.
 *
 * **The gate is drawn for the phases that still have one.** A phase holds one
 * task of its own work beside any number of concept quizzes, so the phase
 * that draws `multiTaskPublishRefusal` is one holding two tasks of its own
 * work, and its sentence carries `EXECUTABLE_SPLIT_NOT_READY` verbatim.
 *
 * **The next draft is a door, not a promise.** `versions.createDraft` exists,
 * so a published version offers it, says what stays frozen, and reads every
 * refusal back in the contract's own words.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthoredProjectSummary,
  DraftPhaseView,
  DraftTaskView,
  DraftVersionView,
  ValidationCheck,
} from '@learnsdlc/shared';
import {
  ARTEFACT_PATH_CHECK_ID,
  DEFAULT_PASS_THRESHOLD,
  EXECUTABLE_SPLIT_NOT_READY,
  INHERITED_TASK_NOTICE,
  MULTI_TASK_CHECK_ID,
  QUIZ_ONLY_ADD_REFUSAL,
  REQUIRED_TASK_CHECK_ID,
  SUPPORTED_STACKS_SENTENCE,
  draftAlreadyOpenRefusal,
  draftFromStaleHeadRefusal,
  draftOnlyRefusal,
  multiTaskPublishRefusal,
  nextDraftVersion,
  noRequiredTaskRefusal,
  notApplicableLine,
  nothingPublishedRefusal,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
  refusesMultiTaskPublish,
  summariseValidation,
} from '@learnsdlc/shared';

const draft = vi.fn();
const validate = vi.fn();
const publish = vi.fn();
const addTask = vi.fn();
const updateTask = vi.fn();
const setTaskRequired = vi.fn();
const reorderTasks = vi.fn();
const removeTask = vi.fn();
const files = vi.fn();
const get = vi.fn();
const createDraft = vi.fn();
const readQuizKey = vi.fn();
const push = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    validate: (...a: unknown[]) => validate(...a),
    publish: (...a: unknown[]) => publish(...a),
    addTask: (...a: unknown[]) => addTask(...a),
    updateTask: (...a: unknown[]) => updateTask(...a),
    setTaskRequired: (...a: unknown[]) => setTaskRequired(...a),
    reorderTasks: (...a: unknown[]) => reorderTasks(...a),
    removeTask: (...a: unknown[]) => removeTask(...a),
    files: (...a: unknown[]) => files(...a),
    get: (...a: unknown[]) => get(...a),
    createDraft: (...a: unknown[]) => createDraft(...a),
    readQuizKey: (...a: unknown[]) => readQuizKey(...a),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p-mine', versionId: 'v-mine' }),
  usePathname: () => '/teacher/projects/p-mine/versions/v-mine',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'a@b.c', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError } from '@/lib/api';
import { REQUIREMENTS_OLDER_FORMAT_REFUSAL } from '@learnsdlc/shared';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { phaseSetFor } from './support/phase-set';

function task(over: Partial<DraftTaskView> = {}): DraftTaskView {
  return {
    taskKey: 'main',
    order: 1,
    required: true,
    title: 'The backlog',
    brief: 'Write the stories.',
    artefactType: 'user-story',
    artefactPath: null,
    checkKind: 'story',
    rubric: { passThreshold: DEFAULT_PASS_THRESHOLD, criteria: [{ key: 'actor', title: 'Actor', weight: 1, description: 'The story names its actor.' }] },
    objectives: [],
    owns: ['requirements/story.json'],
    authorable: true,
    notice: null,
    ...over,
  };
}

/**
 * The concept quiz a teacher added beside the story: the one task the editor
 * adds. It is optional, so the phase still passes on the story alone.
 */
const SECOND = task({
  taskKey: 'late-marker',
  order: 2,
  required: false,
  title: 'The late marker',
  artefactType: 'quiz',
  artefactPath: null,
  checkKind: 'quiz',
  owns: [],
  rubric: {
    passThreshold: DEFAULT_PASS_THRESHOLD,
    criteria: [{ key: 'late', title: 'Late', weight: 1, description: 'What it scores.' }],
  },
  quiz: {
    questions: [{ id: 'late-1', stem: 'When is a task late?', options: [{ id: 'a', text: 'After its due date.' }, { id: 'b', text: 'Never.' }], answerCount: 1 }],
    shuffleOptions: false,
    passMark: 60,
    attempts: { max: null, cooldownSeconds: null },
    criterion: 'late',
  },
});

const INHERITED = task({
  taskKey: 'main',
  title: 'Close the five gaps',
  artefactType: 'code',
  artefactPath: null,
  checkKind: 'code',
  owns: ['api/routes/tasks.py'],
  authorable: false,
  notice: INHERITED_TASK_NOTICE,
});

/**
 * `blocksPublish` is derived here rather than typed, because the API derives it
 * the same way: `refusesMultiTaskPublish` is the one rule, and a fixture that
 * hand-set it would let this suite pin a payload the server cannot send.
 *
 * It is asked the **non-quiz** count, which is what `draftPhaseView` asks it
 * (the all-six-phases rule). A quiz runs no sandbox job, so the wall it would
 * otherwise trip is refusing a count where its reason is about a partition,
 * and counting it here would have this suite pin the editor telling a
 * teacher their version cannot ship while the door let it through. For a
 * phase with no quiz this is `tasks.length`.
 */
function phase(over: Partial<DraftPhaseView> = {}): DraftPhaseView {
  const tasks = over.tasks ?? [task()];
  const checkKind = over.checkKind ?? over.artifactKind ?? 'story';
  return {
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    intro: 'Say what the product must do.',
    artifactKind: 'story',
    checkKind,
    ...over,
    tasks,
    blocksPublish:
      over.blocksPublish ??
      refusesMultiTaskPublish(tasks.filter((one) => one.checkKind !== 'quiz').length, checkKind),
  };
}

/** The story and an optional concept quiz beside it, which publish accepts. */
const REQUIREMENTS = phase({ tasks: [task(), SECOND] });
const IMPLEMENTATION = phase({
  key: 'implementation',
  order: 3,
  title: 'Implementation',
  intro: 'Close the gaps.',
  artifactKind: 'code',
  checkKind: 'code',
  tasks: [INHERITED],
});

/**
 * The quiz a teacher adds beside the work, on a phase the code grader scores.
 *
 * `checkKind: 'quiz'`, `artefactPath: null` and `owns: []` are the contract's,
 * not this fixture's taste: a quiz writes no workspace file, which is what
 * `quiz-owns-no-file` refuses a version for, and its `rules` are empty because
 * it is scored by its key. `quiz` is `AuthoredQuizView`: counts, never ids.
 */
const QUIZ = task({
  taskKey: 'concepts',
  order: 2,
  required: false,
  title: 'The concept check',
  brief: 'Answer the questions.',
  artefactType: 'quiz',
  artefactPath: null,
  checkKind: 'quiz',
  owns: [],
  rubric: {
    passThreshold: DEFAULT_PASS_THRESHOLD,
    criteria: [{ key: 'concepts', title: 'Concepts', weight: 1, description: 'What it scores.' }],
  },
  quiz: {
    questions: [
      {
        id: 'concepts-1',
        stem: 'The first question, as a fixture writes it.',
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
});

/** One inherited `code` task and a quiz beside it: the all-six-phases shape. */
const IMPLEMENTATION_WITH_QUIZ = phase({
  key: 'implementation',
  order: 3,
  title: 'Implementation',
  intro: 'Close the gaps.',
  artifactKind: 'code',
  checkKind: 'code',
  tasks: [INHERITED, QUIZ],
});

/** Two tasks graded by the code grader, which is what publish still refuses. */
const SPLIT_IMPLEMENTATION = phase({
  key: 'implementation',
  order: 3,
  title: 'Implementation',
  intro: 'Close the gaps.',
  artifactKind: 'code',
  checkKind: 'code',
  tasks: [INHERITED, { ...INHERITED, taskKey: 'second-pass', order: 2, title: 'The second pass' }],
});

function summary(over: Partial<AuthoredProjectSummary> = {}): AuthoredProjectSummary {
  return {
    id: 'p-mine',
    slug: 'my-course',
    title: 'My course',
    platformOwned: false,
    mine: true,
    isDefault: false,
    origin: 'fork',
    publishedVersion: '1.0.0',
    publishedVersionId: 'v-mine',
    draftVersion: null,
    draftVersionId: null,
    cohortsUsing: 2,
    lastValidatedAt: '2026-09-19T00:00:00.000Z',
    createdAt: '2026-09-18T00:00:00.000Z',
    ...over,
  };
}

/**
 * What `GET /instructor/projects/:projectId` actually answers.
 *
 * It is an envelope (`{ project, versions }`, `AuthoredProjectDetail` in
 * `apps/api/src/authoring/authoring.service.ts`) and every case here resolves
 * that shape rather than a flat summary. A fixture that hands the client a body
 * the route never sends is a suite that cannot see the field the product reads
 * off the wrong level: a door reading `platformOwned`, `mine` and
 * `publishedVersion` straight off the envelope finds `undefined` in all
 * three, and tells a teacher their own published project is not theirs.
 */
function detail(over: Partial<AuthoredProjectSummary> = {}) {
  return { project: summary(over), versions: [] };
}

function version(over: Partial<DraftVersionView> = {}): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'my-course',
    title: 'My course',
    tagline: 'A course of my own',
    description: 'Copied from TaskTrackr.',
    platformOwned: false,
    editable: true,
    phases: [REQUIREMENTS, IMPLEMENTATION],
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-09-18T00:00:00.000Z',
    phaseSet: phaseSetFor(['requirements', 'implementation'], true),
    ...over,
  };
}

function check(over: Partial<ValidationCheck> = {}): ValidationCheck {
  return {
    id: MULTI_TASK_CHECK_ID,
    label: 'One task per phase',
    status: 'failed',
    sentence: multiTaskPublishRefusal('Requirements', 2),
    phaseKey: 'requirements',
    taskKey: null,
    files: [],
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  get.mockResolvedValue(detail());
});

afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => host?.textContent ?? '';

async function mount(view: DraftVersionView) {
  draft.mockResolvedValue(view);
  await act(async () => {
    root?.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />);
  });
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
}

function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('the project editor', () => {
  it('draws the phases it was given and the selected phase in order, saying what is required', async () => {
    await mount(version());
    expect(byId('project-phase-tab-requirements')).not.toBeNull();
    expect(byId('project-phase-tab-implementation')).not.toBeNull();

    const rows = host?.querySelectorAll('[data-testid^="task-row-"]') ?? [];
    expect([...rows].map((r) => r.getAttribute('data-testid'))).toEqual([
      'task-row-main',
      'task-row-late-marker',
    ]);
    expect(byId('task-required-main')?.textContent).toContain('Required');
    expect(byId('task-required-late-marker')?.textContent).toContain('Optional');
    // A row is the task, not its file: no row names an artefact path.
    expect(host?.querySelector('[data-testid^="task-path-"]')).toBeNull();
  });

  it('says once, up front, what this deployment can run', async () => {
    await mount(version());
    expect(byId('project-stacks')?.textContent).toContain(SUPPORTED_STACKS_SENTENCE);
  });

  // The runtime profile line, on the plain version fixture.
  it('names the runtime profile on the version, in the profile line', async () => {
    await mount(version());
    expect(byId('project-runtime-profile')?.textContent).toContain('This deployment runs: ');
    expect(byId('project-runtime-profile')?.textContent).toContain('flask');
    expect(byId('project-runtime-profile')?.textContent).toContain('esbuild');
  });

  it("names the phase that would refuse the publish, in publish's own sentence", async () => {
    // A story beside a quiz publishes, so the phase that refuses is the one
    // holding two tasks of its own work, and the sentence it refuses with is
    // the one carrying `EXECUTABLE_SPLIT_NOT_READY`.
    await mount(version({ phases: [REQUIREMENTS, SPLIT_IMPLEMENTATION] }));
    await click('project-phase-tab-implementation');
    expect(byId('project-phase-gate-implementation')?.textContent).toBe(
      multiTaskPublishRefusal('Implementation', 2, 'code'),
    );
    expect(byId('project-phase-gate-implementation')?.textContent).toContain(
      EXECUTABLE_SPLIT_NOT_READY,
    );
  });

  it('draws no gate beside a quiz on an executable phase, and still draws one beside a second executable task', async () => {
    // The wall counts the tasks that could divide executable work, and a
    // quiz divides none: it runs no sandbox job, owns no unit and writes no
    // file. Drawing the banner beside it would be the editor telling a teacher
    // their version cannot ship while the compiler and the runtime both let it
    // through: the one property this box exists to keep.
    const MAINTENANCE_SPLIT = phase({
      key: 'maintenance',
      order: 6,
      title: 'Maintenance',
      intro: 'Keep it running.',
      artifactKind: 'code',
      checkKind: 'code',
      tasks: [INHERITED, { ...INHERITED, taskKey: 'second-pass', order: 2, title: 'The second pass' }],
    });
    expect(IMPLEMENTATION_WITH_QUIZ.blocksPublish).toBe(false);
    expect(MAINTENANCE_SPLIT.blocksPublish).toBe(true);

    await mount(version({ phases: [IMPLEMENTATION_WITH_QUIZ, MAINTENANCE_SPLIT] }));
    await click('project-phase-tab-implementation');
    expect(byId('project-phase-gate-implementation')).toBeNull();
    expect(byId('project-phase-gate-box-implementation')).toBeNull();
    // The quiz is still a row, and it names its own type.
    expect(byId('task-row-concepts')).not.toBeNull();
    expect(byId('task-type-concepts')?.textContent).toContain('quiz');
    expect(byId('task-required-concepts')?.textContent).toContain('Optional');

    await click('project-phase-tab-maintenance');
    expect(byId('project-phase-gate-maintenance')?.textContent).toContain(
      EXECUTABLE_SPLIT_NOT_READY,
    );

    // AND THE BANNER'S OWN COUNT IS THE NON-QUIZ ONE. `blocksPublish` is
    // derived from it and the compiler's wall counts the same tasks, so a
    // phase of two executable tasks and a quiz has to say "2 tasks" about a
    // wall that refused two. Saying three would be the editor describing a
    // shape the door never saw.
    const walledWithQuiz = phase({
      ...MAINTENANCE_SPLIT,
      tasks: [...MAINTENANCE_SPLIT.tasks, { ...QUIZ, order: 3 }],
    });
    await mount(version({ phases: [REQUIREMENTS, walledWithQuiz] }));
    await click('project-phase-tab-maintenance');
    const said = byId('project-phase-gate-maintenance')?.textContent ?? '';
    expect(said).toBe(multiTaskPublishRefusal('Maintenance', 2, 'code'));
    expect(said).not.toContain('3 tasks');
  });

  it('adds a quiz through the contract body, questions and all, with no rules in it', async () => {
    // What this asserts is that the body the page sends is the quiz body,
    // with no rules in it at all.
    await mount(version({ phases: [REQUIREMENTS, IMPLEMENTATION_WITH_QUIZ] }));
    addTask.mockResolvedValue({
      phase: IMPLEMENTATION_WITH_QUIZ,
      validation: summariseValidation('fast', '2026-09-19T00:00:00.000Z', []),
    });
    await click('project-add-task');

    // No type to pick: a concept quiz is the one task the editor adds.
    expect(byId('task-form-type')).toBeNull();
    type(byId('task-form-key'), 'concepts');
    type(byId('task-form-title'), 'The concept check');
    type(byId('task-form-brief'), 'Answer the questions.');
    await click('task-form-required');
    type(byId('quiz-question-stem-0'), 'The first question, as a fixture writes it.');
    type(byId('quiz-option-0-0'), 'The first option.');
    type(byId('quiz-option-0-1'), 'The second option.');
    type(byId('quiz-question-explanation-0'), 'Why that is the answer.');
    await click('quiz-option-correct-0-0');
    await click('task-form-submit');

    expect(addTask).toHaveBeenCalledTimes(1);
    const [, , phaseKey, body] = addTask.mock.calls[0];
    expect(phaseKey).toBe('requirements');
    expect(body.artefactType).toBe('quiz');
    expect(body.required).toBe(false);
    expect(body.rules).toBeUndefined();
    expect(body.quiz.questions).toHaveLength(1);
    expect(body.quiz.questions[0].correct).toEqual(['a']);
    expect(body.quiz.criterion).toBe('concepts');
  });

  it('reads a refused add back in the API’s own words, in the add form', async () => {
    // The door refuses any add that is not a concept quiz with this sentence;
    // whatever it answers, the form shows it word for word beside the button.
    await mount(version());
    addTask.mockRejectedValue(new ApiError(409, QUIZ_ONLY_ADD_REFUSAL));
    await click('project-add-task');

    type(byId('task-form-key'), 'concepts');
    type(byId('task-form-title'), 'The concept check');
    type(byId('task-form-brief'), 'Answer the questions.');
    await click('task-form-required');
    type(byId('quiz-question-stem-0'), 'The first question, as a fixture writes it.');
    type(byId('quiz-option-0-0'), 'The first option.');
    type(byId('quiz-option-0-1'), 'The second option.');
    type(byId('quiz-question-explanation-0'), 'Why that is the answer.');
    await click('quiz-option-correct-0-0');
    await click('task-form-submit');

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(byId('task-form-error')?.textContent).toContain(QUIZ_ONLY_ADD_REFUSAL);
  });

  it('reads a quiz key back through the audited route, and never off the draft it already holds', async () => {
    // THE WIRING, and it is the reason the panel is behind an explicit action.
    // `DraftTaskView.quiz` is `AuthoredQuizView` (counts, never ids) because
    // `readDraft` is guarded by `requireVisibleProject`, which admits every
    // instructor on the deployment to every platform-owned project. So the key
    // comes from `GET …/tasks/:taskKey/quiz/key`, which is guarded by
    // `requireOwnedProject` and leaves an audit row on every read.
    //
    // Cut `onReadQuizKey` at the `<TaskEditor>` mount and this case goes red:
    // the panel draws no control at all, and a teacher can open an existing
    // quiz but never change a question.
    await mount(version({ phases: [REQUIREMENTS, IMPLEMENTATION_WITH_QUIZ] }));
    await click('project-phase-tab-implementation');
    await click('task-edit-concepts');

    readQuizKey.mockResolvedValue({
      questions: [
        {
          id: 'q1',
          stem: 'The first question, as a fixture writes it.',
          options: [
            { id: 'a', text: 'The first option.' },
            { id: 'b', text: 'The second option.' },
          ],
          correct: ['a'],
          explanation: 'Why that is the answer.',
        },
      ],
      shuffleOptions: true,
      passMark: 60,
      attempts: { max: 3, cooldownSeconds: null },
      criterion: 'concepts',
    });
    // Sealed until the teacher asks, which is what the Notice above the
    // control says.
    expect(byId('quiz-answers-sealed')).not.toBeNull();
    await click('quiz-answers-show');

    expect(readQuizKey).toHaveBeenCalledTimes(1);
    expect(readQuizKey.mock.calls[0]).toEqual([
      'p-mine',
      'v-mine',
      'implementation',
      'concepts',
    ]);
    expect(byId('quiz-answers-open')).not.toBeNull();
  });

  it('reads the executable gate off what grades the phase, never off a missing field', async () => {
    // `checkKind` is optional on the payload so that an older body still
    // parses, and the two-argument refusal says "a learner can work one task
    // per phase in this release", which is not true of a written phase. The
    // phase's own kind is the honest fallback.
    await mount(
      version({
        phases: [
          REQUIREMENTS,
          { ...SPLIT_IMPLEMENTATION, checkKind: undefined, blocksPublish: true },
        ],
      }),
    );
    await click('project-phase-tab-implementation');
    const said = byId('project-phase-gate-implementation')?.textContent ?? '';
    expect(said).toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(said).not.toContain('one task per phase in this release');
  });

  it('gives an inherited task a Notice and no controls at all', async () => {
    // Implementation's one code task is the three-step builder's (spec 5.3), so the
    // task list's row is read where the list still draws it: a phase holding two.
    await mount(version({ phases: [REQUIREMENTS, SPLIT_IMPLEMENTATION] }));
    await click('project-phase-tab-implementation');

    expect(byId('task-notice-main')?.textContent).toContain(INHERITED_TASK_NOTICE);
    expect(byId('task-edit-main')).toBeNull();
    expect(byId('task-remove-main')).toBeNull();
    expect(byId('task-required-toggle-main')).toBeNull();
  });

  it('reorders by sending the whole ordering, from a control a keyboard can reach', async () => {
    await mount(version());
    reorderTasks.mockResolvedValue({
      phase: phase({ tasks: [{ ...SECOND, order: 1 }, { ...task(), order: 2 }] }),
      validation: summariseValidation('fast', '2026-09-19T00:00:00.000Z', []),
    });

    const up = byId('task-up-late-marker') as HTMLButtonElement;
    expect(up.tagName).toBe('BUTTON');
    expect(up.disabled).toBe(false);
    await click('task-up-late-marker');

    expect(reorderTasks).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', [
      'late-marker',
      'main',
    ]);
    expect(byId('project-live')?.textContent).toContain('The late marker');
    // The first row cannot move up and the last cannot move down.
    expect((byId('task-up-late-marker') as HTMLButtonElement).disabled).toBe(true);
    expect((byId('task-down-main') as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds publish shut until validation has run, and says so rather than failing later', async () => {
    await mount(version());
    const button = byId('project-publish') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(byId('project-publish-reason')?.textContent).toContain('Validate');
    expect(publish).not.toHaveBeenCalled();
  });

  it('holds publish shut while a check fails, and reads the failure back verbatim', async () => {
    const failing = summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
      check(),
      check({
        id: REQUIRED_TASK_CHECK_ID,
        label: 'A required task per phase',
        status: 'passed',
        sentence: 'Every phase has a required task.',
      }),
      check({
        id: ARTEFACT_PATH_CHECK_ID,
        label: 'Artefact paths are unique',
        status: 'not-applicable',
        sentence: 'This project declares no artefact paths to compare.',
      }),
    ]);
    await mount(version({ validation: failing }));

    expect((byId('project-publish') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('project-publish-blocking')?.textContent).toContain(
      multiTaskPublishRefusal('Requirements', 2),
    );
    // A check id repeats once per phase, so a row is addressed by the id and
    // the phase it is about (`project-check-<id>` alone would name six rows).
    expect(byId(`project-check-${MULTI_TASK_CHECK_ID}-requirements`)?.textContent).toContain(
      multiTaskPublishRefusal('Requirements', 2),
    );
    // The neutral rows collapse behind one line rather than reading as near-misses.
    expect(byId(`project-check-${ARTEFACT_PATH_CHECK_ID}-requirements`)).toBeNull();
    expect(byId('project-validation-skipped')?.textContent).toContain(notApplicableLine(1) ?? '');
  });

  it('holds publish shut on a copy whose Design phase does not own the screen contract', async () => {
    // Removing the inherited Design task takes
    // `shared/contract/screens.json` with it, and every learner of that copy
    // would then be refused the advance out of Design. The API refuses it at
    // the fast tier and at publish in one sentence
    // (`apps/api/src/authoring/validation.ts` `screenContractOwnerRefusal`,
    // row id `screen-contract-has-an-owner`), and this panel draws rows
    // generically, so what is pinned here is that the teacher reads that
    // sentence, word for word, on the Design row and at the publish door.
    // The words are the server's, copied.
    const sentence =
      'Keep the Design task you copied beside your own: Implementation reads the screen copy a passing Design submission leaves in shared/contract/screens.json, so with no task owning that file no learner could ever leave Design.';
    const refused = summariseValidation('fast', '2026-09-28T00:00:00.000Z', [
      check({
        id: 'screen-contract-has-an-owner',
        label: 'The screen contract later phases read has an owner',
        status: 'failed',
        sentence,
        phaseKey: 'design',
        files: ['shared/contract/screens.json'],
      }),
    ]);
    await mount(version({ validation: refused }));

    expect((byId('project-publish') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('project-publish-blocking')?.textContent).toContain(sentence);
    const row = byId('project-check-screen-contract-has-an-owner-design');
    expect(row?.textContent).toContain('The screen contract later phases read has an owner');
    expect(row?.textContent).toContain(sentence);
    expect(row?.textContent).toContain('shared/contract/screens.json');
  });

  it('lets publish through only once nothing fails, and freezes the version it names', async () => {
    const clean = summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
      check({ status: 'passed', sentence: 'Every phase holds one task.' }),
    ]);
    await mount(version({ phases: [phase(), IMPLEMENTATION], validation: clean }));
    publish.mockResolvedValue({
      versionId: 'v-mine',
      version: '1.0.0',
      publishedAt: '2026-09-19T01:00:00.000Z',
      sandboxBudget: 12,
      validation: clean,
    });

    expect((byId('project-publish') as HTMLButtonElement).disabled).toBe(false);
    type(byId('project-publish-version'), '1.0.0');
    await click('project-publish');
    // Publishing is a one-way door, so it asks before it goes through it.
    expect(byId('project-publish-confirm')?.textContent).toContain('never changes');
    expect(publish).not.toHaveBeenCalled();
    await click('project-publish-confirm-yes');
    expect(publish).toHaveBeenCalledWith('p-mine', 'v-mine', { version: '1.0.0', notes: undefined });
  });

  it('prints the older-format publish refusal where publish errors show', async () => {
    const clean = summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
      check({ status: 'passed', sentence: 'Every phase holds one task.' }),
    ]);
    await mount(version({ phases: [phase(), IMPLEMENTATION], validation: clean }));
    publish.mockRejectedValue(new ApiError(400, REQUIREMENTS_OLDER_FORMAT_REFUSAL));
    type(byId('project-publish-version'), '1.0.0');
    await click('project-publish');
    await click('project-publish-confirm-yes');
    expect(byId('project-publish-error')?.textContent).toContain(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
  });

  it('offers only a quiz when Add a task is pressed in a phase graded by running the work (F-d)', async () => {
    // The editor, mounted: the add button reads "Add a concept quiz", the
    // form offers no type to pick, and the sentence beside it is the one the
    // door refuses any other body with.
    await mount(version());
    await click('project-phase-tab-implementation');
    expect(byId('project-add-task')?.textContent).toBe('Add a concept quiz');
    await click('project-add-task');

    expect(byId('task-form-type')).toBeNull();
    expect(byId('task-form-quiz-only')?.textContent).toBe(QUIZ_ONLY_ADD_REFUSAL);
  });

  it('offers only a concept quiz in Requirements too, in the same sentence', async () => {
    await mount(version());
    await click('project-phase-tab-requirements');
    expect(byId('project-add-task')?.textContent).toBe('Add a concept quiz');
    await click('project-add-task');

    expect(byId('task-form-type')).toBeNull();
    expect(byId('task-form-quiz-only')?.textContent).toBe(QUIZ_ONLY_ADD_REFUSAL);
  });

  it('summarises a copied brief by its first line, which a plain brief holds as its summary', async () => {
    await mount(
      version({
        phases: [
          phase({ tasks: [task({ brief: '\nWrite US-4, the overdue report story.\n\nSay what overdue means.' }), SECOND] }),
          IMPLEMENTATION,
        ],
      }),
    );

    expect(byId('task-summary-main')?.textContent).toBe('Write US-4, the overdue report story.');
    expect(byId('task-summary-main')?.textContent).not.toContain('Say what overdue means');
  });

  it('draws a published version read-only, with no way to pretend otherwise', async () => {
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    expect(byId('project-add-task')).toBeNull();
    expect(byId('task-edit-main')).toBeNull();
    expect(byId('project-frozen')?.textContent).toContain('1.0.0');
  });

  /*
   * `versions.createDraft` is a route, so the honest surface is the door
   * itself, and the cases below are what the contract's own order of checks
   * says a teacher can meet at it.
   */
  it('offers the next draft from the published head, and says what stays frozen', async () => {
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    expect(get).toHaveBeenCalledWith('p-mine');

    const note = byId('project-next-draft-note')?.textContent ?? '';
    expect(note).toContain('stays frozen');
    expect(note).toContain('keeps the version it was assigned');
    // The number the draft opens at is the contract's own, so the sentence and
    // the row the API writes cannot disagree.
    expect(note).toContain(nextDraftVersion('1.0.0'));
    expect(byId('project-new-draft')?.textContent).toContain('New draft from 1.0.0');
  });

  it('opens the draft against the head it read, and routes into it', async () => {
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    createDraft.mockResolvedValue(
      version({ projectId: 'p-mine', versionId: 'v-next', version: '1.0.1' }),
    );

    await click('project-new-draft');
    expect(createDraft).toHaveBeenCalledWith('p-mine', { fromVersionId: 'v-mine' });
    expect(push).toHaveBeenCalledWith('/teacher/projects/p-mine/versions/v-next');
  });

  it('reads a refusal at that door back word for word', async () => {
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    const refusal = draftFromStaleHeadRefusal('1.1.0');
    createDraft.mockRejectedValue(new ApiError(409, refusal));

    await click('project-new-draft');
    expect(byId('project-new-draft-error')?.textContent).toBe(refusal);
    expect(push).not.toHaveBeenCalled();
  });

  it('sends a teacher to the draft already open rather than to a control that would be refused', async () => {
    get.mockResolvedValue(detail({ draftVersion: '1.0.1', draftVersionId: 'v-open' }));
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));

    expect(byId('project-new-draft')).toBeNull();
    expect(byId('project-next-draft-open')?.getAttribute('href')).toBe(
      '/teacher/projects/p-mine/versions/v-open',
    );
    expect(text()).toContain(draftAlreadyOpenRefusal('1.0.1'));
  });

  it('offers no draft on a project that is not the teacher’s to edit, and says which fact it is', async () => {
    get.mockResolvedValue(detail({ mine: false }));
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    expect(byId('project-new-draft')).toBeNull();
    expect(byId('project-next-draft-not-yours')?.textContent).toBe(projectNotYoursRefusal());

    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    get.mockResolvedValue(detail({ platformOwned: true, mine: false }));
    await mount(
      version({
        status: 'published',
        version: '2.0.1',
        editable: false,
        platformOwned: true,
        phases: [phase()],
      }),
    );
    expect(byId('project-new-draft')).toBeNull();
    expect(byId('project-next-draft-platform')?.textContent).toBe(
      platformProjectCopyOnlyRefusal('My course'),
    );
  });

  it('asks nothing about the next draft while the version on screen is the draft', async () => {
    await mount(version());
    expect(get).not.toHaveBeenCalled();
    expect(byId('project-new-draft')).toBeNull();
    expect(byId('project-next-draft')).toBeNull();
  });

  it('reads the project off the envelope the route answers with, not off a flat body', async () => {
    // `projects.get` answers `{ project, versions }`. Read one level too high
    // and every field the door branches on is `undefined` (`platformOwned`,
    // `mine` and `publishedVersion` alike) so the first branch that a missing
    // field satisfies wins, and the owner of a published project is told it
    // is not theirs.
    get.mockResolvedValue({
      project: summary({ title: 'My course', publishedVersion: '2.3.0', publishedVersionId: 'v-head' }),
      versions: [{ id: 'v-head', version: '2.3.0', status: 'published' }],
    });
    await mount(version({ status: 'published', version: '2.3.0', editable: false, phases: [phase()] }));

    expect(byId('project-next-draft-not-yours')).toBeNull();
    expect(byId('project-next-draft-platform')).toBeNull();
    expect(byId('project-next-draft-nothing')).toBeNull();
    expect(byId('project-new-draft')?.textContent).toContain('New draft from 2.3.0');
  });

  it('speaks the next-draft door through the page’s own live region', async () => {
    // Every other write on this page announces itself through `project-live`.
    // The door arriving, and the click that opens a draft, were the two state
    // changes a screen reader was never told about.
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    const said = byId('project-live')?.textContent ?? '';
    expect(said).toContain('1.0.0');
    expect(said).toContain(nextDraftVersion('1.0.0'));

    createDraft.mockResolvedValue(version({ projectId: 'p-mine', versionId: 'v-next', version: '1.0.1' }));
    await click('project-new-draft');
    expect(byId('project-live')?.textContent).toContain('Opening a draft from 1.0.0.');
  });

  it('marks the door’s own waiting line as a status, the way its siblings do', async () => {
    get.mockReturnValue(new Promise(() => {}));
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    expect(byId('project-next-draft-loading')?.getAttribute('role')).toBe('status');
  });

  it('says why a project with nothing published has no door, through the same region', async () => {
    get.mockResolvedValue(detail({ publishedVersion: null, publishedVersionId: null }));
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    expect(byId('project-new-draft')).toBeNull();
    expect(byId('project-next-draft-nothing')?.textContent).toBe(nothingPublishedRefusal('My course'));
    expect(byId('project-live')?.textContent).toBe(nothingPublishedRefusal('My course'));
  });

  it('tells a withdrawn project neither of the two false things about its draft', async () => {
    // Withdrawing archives every row, the draft included, so a withdrawn
    // project reports a null `publishedVersion` and a null `draftVersion`
    // exactly as a project that has never published does. Branching on those
    // two alone would print `nothingPublishedRefusal`, and both of its clauses are
    // false here: this project published, and the draft it is told to publish
    // was archived with everything else.
    //
    // The sentence for this state is `withdrawnProjectRefusal`, which lives in
    // `apps/api/src/authoring/authoring.service.ts` and not in the contract this
    // page imports, so the door asks rather than guessing, and prints what it
    // is answered instead of writing a second wording of its own.
    get.mockResolvedValue({
      project: summary({ publishedVersion: null, publishedVersionId: null }),
      versions: [
        { id: 'v-mine', version: '1.0.0', status: 'archived' },
        { id: 'v-old', version: '0.9.0', status: 'archived' },
      ],
    });
    await mount(version({ status: 'archived', version: '1.0.0', editable: false, phases: [phase()] }));

    expect(byId('project-next-draft-nothing')).toBeNull();
    expect(text()).not.toContain(nothingPublishedRefusal('My course'));
    expect(byId('project-next-draft-withdrawn')?.textContent).toContain(
      'Every version of this project is archived',
    );
    expect(byId('project-live')?.textContent).toContain(
      'Every version of this project is archived',
    );

    // The words are the API's and this suite cannot import them; what it holds
    // the door to is that whatever it is answered reaches the teacher unchanged.
    const refusal = 'What this project says about a draft while every version of it is archived.';
    createDraft.mockRejectedValue(new ApiError(409, refusal));
    await click('project-new-draft-archived');

    expect(createDraft).toHaveBeenCalledWith('p-mine', { fromVersionId: 'v-mine' });
    expect(byId('project-new-draft-error')?.textContent).toBe(refusal);
    expect(push).not.toHaveBeenCalled();
  });

  it('tells a published version why it cannot publish, rather than asking it to validate', async () => {
    // Three different facts refuse a write here (published, the platform's,
    // not yours) and only one of them is true at a time. A published version
    // being told to "validate first" would be the wrong one.
    await mount(version({ status: 'published', version: '1.0.0', editable: false, phases: [phase()] }));
    expect((byId('project-publish') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('project-publish-reason')?.textContent).toBe(draftOnlyRefusal('1.0.0', 'published'));
    expect(byId('project-publish-reason')?.textContent).not.toContain('Validate');
  });

  it('asks before it removes a task, and names what goes with it', async () => {
    await mount(version());
    removeTask.mockResolvedValue({
      phase: phase({ tasks: [task()] }),
      validation: summariseValidation('fast', '2026-09-19T00:00:00.000Z', []),
    });

    await click('task-remove-late-marker');
    expect(byId('task-remove-confirm')?.textContent).toContain('The late marker');
    expect(removeTask).not.toHaveBeenCalled();

    await click('task-remove-yes');
    expect(removeTask).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', 'late-marker');
    expect(byId('task-row-late-marker')).toBeNull();
    expect(byId('task-remove-confirm')).toBeNull();
  });

  it('runs the fast tier on demand and says what tier it ran', async () => {
    await mount(version());
    validate.mockResolvedValue(
      summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
        check({ status: 'failed', sentence: noRequiredTaskRefusal('Requirements') }),
      ]),
    );
    await click('project-validate');
    expect(validate).toHaveBeenCalledWith('p-mine', 'v-mine');
    expect(text()).toContain(noRequiredTaskRefusal('Requirements'));
    expect(byId('project-validation-tier')?.textContent).toContain('no sandbox');
  });

  it('draws one row per phase for a check the run repeats, not one row named six times', async () => {
    // `fastValidation` pushes one `phase-holds-one-task` row and one gating row
    // PER PHASE, so a copied six-phase project carries six rows under each of
    // two ids. Keying the list by the id alone gave React duplicate keys on a
    // list it rebuilds after every save, and gave the DOM six elements sharing
    // one test id, which a `querySelector` reads as one, silently.
    const warnings: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    try {
      const repeated = summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
        check({ sentence: multiTaskPublishRefusal('Requirements', 2), phaseKey: 'requirements' }),
        check({ sentence: multiTaskPublishRefusal('Implementation', 3), phaseKey: 'implementation' }),
        check({
          id: REQUIRED_TASK_CHECK_ID,
          label: 'A phase has a task that gates it',
          status: 'failed',
          sentence: noRequiredTaskRefusal('Requirements'),
          phaseKey: 'requirements',
        }),
        check({
          id: REQUIRED_TASK_CHECK_ID,
          label: 'A phase has a task that gates it',
          status: 'failed',
          sentence: noRequiredTaskRefusal('Implementation'),
          phaseKey: 'implementation',
        }),
      ]);
      await mount(version({ validation: repeated }));

      const rows = [...(host?.querySelectorAll('[data-testid^="project-check-"]') ?? [])].map((row) =>
        row.getAttribute('data-testid'),
      );
      expect(rows).toHaveLength(4);
      expect(new Set(rows).size).toBe(4);
      expect(byId(`project-check-${MULTI_TASK_CHECK_ID}-requirements`)?.textContent).toContain(
        multiTaskPublishRefusal('Requirements', 2),
      );
      expect(byId(`project-check-${MULTI_TASK_CHECK_ID}-implementation`)?.textContent).toContain(
        multiTaskPublishRefusal('Implementation', 3),
      );
      expect(byId(`project-check-${REQUIRED_TASK_CHECK_ID}-implementation`)?.textContent).toContain(
        noRequiredTaskRefusal('Implementation'),
      );
      const keyed = warnings.filter((args) => {
        const said = String(args[0] ?? '');
        return said.includes('unique "key"') || said.includes('same key');
      });
      expect(keyed).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a keyboard on the row it just moved, rather than dropping focus to the page', async () => {
    // Move up and Move down are real disabled buttons, so the move that makes
    // a task first turns off the button that made it, and the browser drops
    // focus to <body>. The live control on the same row is where the teacher
    // still is.
    await mount(version());
    reorderTasks.mockResolvedValue({
      phase: phase({ tasks: [{ ...SECOND, order: 1 }, { ...task(), order: 2 }] }),
      validation: summariseValidation('fast', '2026-09-19T00:00:00.000Z', []),
    });

    await click('task-up-late-marker');
    expect((byId('task-up-late-marker') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(byId('task-down-late-marker'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('never tells an inherited task it has 0 rules you wrote', async () => {
    // `rules` is empty by contract on an inherited task and its rubric is the
    // platform's, so an authored line would contradict the Notice two lines below.
    // The row is read where the task list still draws one (Implementation's sole code task is the builder's).
    await mount(version({ phases: [REQUIREMENTS, SPLIT_IMPLEMENTATION] }));
    await click('project-phase-tab-implementation');

    const line = byId('task-scoring-main')?.textContent ?? '';
    expect(line).not.toContain('you wrote');
    expect(line).toContain('it came with');
    expect(byId('task-notice-main')?.textContent).toContain(INHERITED_TASK_NOTICE);

    await click('project-phase-tab-requirements');
    // No task here is scored by rules, so the line counts none.
    expect(byId('task-scoring-main')?.textContent).toBe('Scored on 1 criterion.');
  });
});

describe('the editor lands a failed validation row on its phase', () => {
  const settleFrames = async () => {
    for (let i = 0; i < 4; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const failing = () =>
    summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
      check({ phaseKey: 'implementation', taskKey: null, sentence: multiTaskPublishRefusal('Implementation', 2) }),
      check({
        id: REQUIRED_TASK_CHECK_ID,
        label: 'A phase has a task that gates it',
        sentence: noRequiredTaskRefusal('Requirements'),
        phaseKey: 'requirements',
        taskKey: 'late-marker',
      }),
    ]);
  const hadCss = 'CSS' in globalThis;
  const css = (globalThis as { CSS?: unknown }).CSS;
  let scrolled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The browser's own frame and escape; jsdom has no CSS.escape.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    if (!(css as { escape?: unknown } | undefined)?.escape)
      (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };
    scrolled = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrolled });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (hadCss) (globalThis as { CSS?: unknown }).CSS = css;
    else delete (globalThis as { CSS?: unknown }).CSS;
  });

  it('Go to opens the phase tab and focuses its first field', async () => {
    await mount(version({ validation: failing() }));
    // The editor opens on the Overview; the failed row is on Validate, and its link opens the phase's tab.
    expect(byId('project-section-overview')?.getAttribute('aria-selected')).toBe('true');
    await click('project-section-validate');
    await click('project-goto-phase-holds-one-task-implementation');
    await settleFrames();
    expect(byId('project-section-implementation')?.getAttribute('aria-selected')).toBe('true');
    expect(byId('project-phase-tab-implementation')?.closest('[role="tab"]')).toBe(byId('project-section-implementation'));
    expect(document.getElementById('project-phase-panel')?.hidden).toBe(false);
    expect(window.location.search).toBe('?section=implementation');
    const first = byId('tdi-brief-background');
    expect(first).not.toBeNull();
    expect(document.getElementById('project-phase-panel')?.contains(first)).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(scrolled).toHaveBeenCalled();
  });

  /** A press a teacher can make: the control is not inside a hidden section (jsdom would press it anyway). */
  const clickShown = async (id: string) => {
    const control = byId(id);
    expect(control, `no control ${id}`).not.toBeNull();
    expect(control!.closest('[hidden]'), `${id} is inside a hidden section`).toBeNull();
    await click(id);
  };

  it('clears nothing: typed in the phase, Validate opened, Go to lands back on the field with the text still there', async () => {
    await mount(version({ validation: failing() }));
    await clickShown('project-phase-tab-implementation');
    const background = byId('tdi-brief-background') as HTMLTextAreaElement;
    const title = byId('tdi-brief-title') as HTMLInputElement;
    // The builder sits at the reading measure inside the wide page.
    expect(background.closest('[data-testid="project-phase-measure"]')?.className).toContain('max-w-[852px]');
    await act(async () => {
      type(background, 'Typed by the teacher, not yet saved.');
      type(title, 'A title still being written');
    });
    // The teacher opens Validate: the phase is hidden, its builder still mounted.
    await clickShown('project-section-validate');
    expect(byId('tdi-brief-background')?.closest('[hidden]')).toBe(document.getElementById('project-phase-panel'));
    expect(byId('tdi-brief-background')).toBe(background);
    await clickShown('project-goto-phase-holds-one-task-implementation');
    await settleFrames();
    expect(byId('project-section-implementation')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('project-phase-panel')?.hidden).toBe(false);
    // The same field, not a remounted one, with the words typed before.
    expect(byId('tdi-brief-background')).toBe(background);
    expect(document.activeElement).toBe(byId('tdi-brief-background'));
    expect((byId('tdi-brief-background') as HTMLTextAreaElement).value).toBe('Typed by the teacher, not yet saved.');
    expect((byId('tdi-brief-title') as HTMLInputElement).value).toBe('A title still being written');
  });

  it("a row naming a task opens that task's phase and lands inside it", async () => {
    await mount(version({ validation: failing() }));
    await clickShown('project-phase-tab-implementation');
    // The failed row is on Validate: the teacher opens it, then presses Go to.
    await clickShown('project-section-validate');
    await clickShown('project-goto-required-task-per-phase-requirements-late-marker');
    await settleFrames();
    expect(byId('project-section-requirements')?.getAttribute('aria-selected')).toBe('true');
    const panel = document.getElementById('project-phase-panel')!;
    expect(panel.contains(byId('task-row-late-marker'))).toBe(true);
    // The task's row holds no field of its own, so the phase's panel takes the focus.
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('keeps the runtime banner under Advanced information, closed until asked', async () => {
    await mount(version());
    const advanced = byId('project-advanced') as HTMLDetailsElement;
    expect(advanced.tagName).toBe('DETAILS');
    expect(advanced.open).toBe(false);
    expect(byId('project-advanced-toggle')?.textContent).toBe('Advanced information');
    expect(advanced.contains(byId('project-stacks-box'))).toBe(true);
    expect(advanced.contains(byId('project-runtime-profile'))).toBe(true);
  });
});
