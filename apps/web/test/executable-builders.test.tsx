// @vitest-environment jsdom
/**
 * The three-step Implementation and Testing builders in the teacher's editor
 * (spec 5.3), the shared Brief card's flush handle (K4), and the executable
 * editor without its brief field in all three builders that draw it.
 *
 * The editor is mounted with the projects API mocked (as
 * `executable-editor-mount.test.tsx` mounts it) to see which builder it picks;
 * the builders are rendered on their own to read what each save sends.
 *
 * After a save, the Brief and Criteria cards take the server's words for every
 * field not typed in since (the server stores a markdown text plain),
 * and a save that converted the draft draws its notes and reads the draft again.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_PASS_THRESHOLD,
  FIXED_SCORER_KEYS,
  SUPPORTED_STACKS_SENTENCE,
  fixedCriteriaRefusal,
  markdownKeptWarning,
  type DraftPhaseSetView,
  type DraftPhaseView,
  type DraftTaskView,
  type DraftVersionView,
  type ExecutableTaskView,
} from '@learnsdlc/shared';

const draft = vi.fn();
const get = vi.fn();
const files = vi.fn();
const updateTask = vi.fn();
const updatePhase = vi.fn();
const replaceFile = vi.fn();
const writeSealed = vi.fn();
const deepValidation = vi.fn();
const startDeepValidation = vi.fn();
const validate = vi.fn();
const restorePhase = vi.fn();
vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    get: (...a: unknown[]) => get(...a),
    files: (...a: unknown[]) => files(...a),
    updateTask: (...a: unknown[]) => updateTask(...a),
    updatePhase: (...a: unknown[]) => updatePhase(...a),
    replaceFile: (...a: unknown[]) => replaceFile(...a),
    writeSealed: (...a: unknown[]) => writeSealed(...a),
    deepValidation: (...a: unknown[]) => deepValidation(...a),
    startDeepValidation: (...a: unknown[]) => startDeepValidation(...a),
    validate: (...a: unknown[]) => validate(...a),
    restorePhase: (...a: unknown[]) => restorePhase(...a),
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p', versionId: 'v' }),
  usePathname: () => '/teacher/projects/p/versions/v',
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
import { ImplementationBuilder } from '@/components/staff/projects/implementation/ImplementationBuilder';
import { IMPLEMENTATION_STEP_LABELS, implementationBuilderTask } from '@/components/staff/projects/implementation/implementation-builder-model';
import { TestingBuilder } from '@/components/staff/projects/testing/TestingBuilder';
import { TESTING_STEP_LABELS, testingBuilderTask } from '@/components/staff/projects/testing/testing-builder-model';
import { MaintenanceBuilder } from '@/components/staff/projects/maintenance/MaintenanceBuilder';
import { forgetTaskSaves } from '@/components/staff/projects/requirements/builder-model';
import { ApiError } from '@/lib/api';
import { expectSignOffJumpLands } from './support/signoff-jump';
import { expectStepLinksLand } from './support/step-links';
import { settle } from './support/dom';
import { phaseSetFor } from './support/phase-set';

const CODE: ExecutableTaskView = {
  taskKey: 'main',
  checkKind: 'code',
  artefactType: 'code',
  owns: ['api/app.py'],
  profile: 'baked',
  runs: [
    {
      id: 'api',
      shape: 'run-python-hidden',
      label: 'API tests',
      testPaths: ['tests/'],
      visibleTests: ['tests/test_api.py'],
      learnerTestFiles: [],
      hidden: [{ path: 'test_hidden_api.py', sha256: 'b'.repeat(64), bytes: 120 }],
    },
  ],
  minTests: null,
  coverageKeywords: [],
  solution: [{ path: 'api/app.py', sha256: 'c'.repeat(64), bytes: 300 }],
  mutants: [],
  sandboxBudget: 4,
};
const TESTS: ExecutableTaskView = {
  ...CODE,
  checkKind: 'tests',
  artefactType: 'tests',
  runs: [{ ...CODE.runs[0], id: 'suite', label: 'Your suite', visibleTests: [], learnerTestFiles: ['tests/test_mine.py'] }],
  minTests: 4,
  coverageKeywords: ['overdue'],
};

const rubricOf = (keys: readonly string[]) => ({
  passThreshold: DEFAULT_PASS_THRESHOLD,
  criteria: keys.map((key, at) => ({ key, title: `Title ${at}`, description: `Sentence ${at}`, weight: at === 0 ? 1 - 0.1 * (keys.length - 1) : 0.1 })),
});

function task(over: Partial<DraftTaskView> = {}): DraftTaskView {
  return {
    taskKey: 'main',
    order: 1,
    required: true,
    title: 'Build the shelf API',
    brief: 'Make the shelf lend books.',
    artefactType: 'code',
    artefactPath: null,
    checkKind: 'code',
    rubric: rubricOf(FIXED_SCORER_KEYS.code),
    objectives: [],
    owns: ['api/app.py'],
    authorable: false,
    notice: null,
    executable: CODE,
    ...over,
  } as DraftTaskView;
}
const implementation = (over: Partial<DraftPhaseView> = {}): DraftPhaseView =>
  ({
    key: 'implementation',
    order: 3,
    title: 'Implementation',
    intro: 'Build it.',
    artifactKind: 'code',
    checkKind: 'code',
    tasks: [task()],
    blocksPublish: false,
    ...over,
  }) as DraftPhaseView;
const testingTask = task({ title: 'Test the shelf', artefactType: 'tests', checkKind: 'tests', executable: TESTS, rubric: rubricOf(FIXED_SCORER_KEYS.tests) });
const testing = (over: Partial<DraftPhaseView> = {}): DraftPhaseView =>
  implementation({ key: 'testing', order: 4, title: 'Testing', artifactKind: 'tests', checkKind: 'tests', tasks: [testingTask], ...over });

function version(phases: DraftPhaseView[]): DraftVersionView {
  return {
    projectId: 'p',
    versionId: 'v',
    version: '0.1.0',
    status: 'draft',
    slug: 'books-on-a-shelf',
    title: 'Books on a shelf',
    tagline: '',
    description: '',
    platformOwned: false,
    editable: true,
    phases,
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-01T00:00:00.000Z',
    phaseSet: phaseSetFor(phases.map((one) => one.key), true),
  } as DraftVersionView;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetTaskSaves();
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  deepValidation.mockResolvedValue({ versionId: 'v', status: 'not-run', current: false, contentDigest: null, checks: [], costWarning: { microVMs: 0, sentence: '' }, startedAt: null, finishedAt: null });
  updateTask.mockImplementation(() => new Promise(() => undefined));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root.unmount());
  host.remove();
});

const byTestId = (id: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element ${id}`);
  return el;
};
const queryTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => {
    fireEvent.click(byTestId(id));
  });
};
async function mountEditor(phases: DraftPhaseView[], tab: string) {
  draft.mockResolvedValue(version(phases));
  await act(async () => root.render(<ProjectEditor projectId="p" versionId="v" />));
  await settle(6);
  await click(`project-phase-tab-${tab}`);
  await settle(6);
}
const stepLabels = () => [...host.querySelectorAll('[data-testid="tre-steps"] .tre-step-l')].map((one) => one.textContent);
const sent = (at: number) => updateTask.mock.calls[at][4] as Record<string, unknown>;
const props = (phase: DraftPhaseView) => ({ projectId: 'p', versionId: 'v', phase, task: phase.tasks[0], editable: true, onSaved: () => {}, onSignOff: () => {} });

describe('the Implementation and Testing builders', () => {
  test('the editor builds an Implementation code task in three steps: Brief, Code and runs, Criteria', async () => {
    expect(IMPLEMENTATION_STEP_LABELS).toEqual(['Brief', 'Code and runs', 'Criteria']);
    expect(implementationBuilderTask(implementation(), true)).not.toBeNull();
    expect(implementationBuilderTask(testing(), true)).toBeNull();
    await mountEditor([implementation(), testing()], 'implementation');
    expect(queryTestId('implementation-builder')).not.toBeNull();
    expect(stepLabels()).toEqual(['Brief', 'Code and runs', 'Criteria']);
    for (const id of ['tdi-brief', 'tdi-code', 'tdi-criteria']) expect(queryTestId(id), id).not.toBeNull();
    expect(byTestId('tdi-readiness').textContent).toBe('3 of 3 steps done');
    // the executable summary is the builder's step 2, drawn once; no scenario panel or task list beside it
    expect(host.querySelectorAll('[data-testid="exec-summary"]')).toHaveLength(1);
    expect(byTestId('tdi-code').querySelector('[data-testid="exec-summary"]')).not.toBeNull();
    expect(queryTestId('phase-scenario-implementation')).toBeNull();
    // Executable phases: what the pass needs, every check and more than half of the criteria met, so "only when".
    expect(byTestId('tdi-criteria-passmark').textContent).toContain(
      'The code passes only when every check passes and the review finds more than half of the criteria met; the pass mark does not decide that.',
    );
  });

  test('the editor builds a Testing tests task in three steps: Brief, Tests and runs, Criteria', async () => {
    expect(TESTING_STEP_LABELS).toEqual(['Brief', 'Tests and runs', 'Criteria']);
    expect(testingBuilderTask(testing(), true)).not.toBeNull();
    expect(testingBuilderTask(implementation(), true)).toBeNull();
    await mountEditor([implementation(), testing()], 'testing');
    expect(queryTestId('testing-builder')).not.toBeNull();
    expect(queryTestId('implementation-builder')).toBeNull();
    expect(stepLabels()).toEqual(['Brief', 'Tests and runs', 'Criteria']);
    for (const id of ['tdt-brief', 'tdt-code', 'tdt-criteria']) expect(queryTestId(id), id).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="exec-summary"]')).toHaveLength(1);
    expect(byTestId('tdt-code').textContent).toContain('Your suite');
    expect(byTestId('tdt-criteria-passmark').textContent).toContain(
      'The tests pass only when every check passes and the review finds more than half of the criteria met; the pass mark does not decide that.',
    );
  });

  test('the Criteria step locks the fixed keys and offers no Add', async () => {
    await act(async () => root.render(<ImplementationBuilder {...props(implementation())} />));
    const card = byTestId('tdi-criteria');
    const removes = [...card.querySelectorAll('button')].filter((b) => /Remove/.test(`${b.textContent} ${b.getAttribute('aria-label') ?? ''}`)) as HTMLButtonElement[];
    expect(removes.map((b) => b.disabled)).toEqual([true, true, true, true]);
    expect(card.querySelector('[data-testid="tre-criteria-add"]')).toBeNull();
    expect(byTestId('tdi-criteria-fixed').textContent).toBe('These criteria are fixed: the grader scores each one. Change their sentences and weights.');
    // the titles, sentences and weights stay the teacher's
    expect((card.querySelector('input[aria-label="Criterion 4 title"]') as HTMLInputElement).disabled).toBe(false);
    await act(async () => root.render(<TestingBuilder {...props(testing())} />));
    const tests = byTestId('tdt-criteria');
    expect(tests.querySelectorAll('li.tre-crit')).toHaveLength(3);
    expect(tests.querySelector('[data-testid="tre-criteria-add"]')).toBeNull();
  });

  test("a Criteria save sends the rubric alone and shows the API's refusal in its words", async () => {
    updateTask.mockRejectedValueOnce(new ApiError(400, fixedCriteriaRefusal('Implementation')));
    await act(async () => root.render(<ImplementationBuilder {...props(implementation())} />));
    const card = byTestId('tdi-criteria');
    await act(async () => {
      fireEvent.change(card.querySelector('input[aria-label="Criterion 4 title"]')!, { target: { value: 'How you worked' } });
    });
    await click('tre-criteria-save');
    await settle(6);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(Object.keys(sent(0))).toEqual(['rubric']);
    const rubric = sent(0).rubric as { criteria: { key: string; title: string }[] };
    expect(rubric.criteria.map((c) => c.key)).toEqual([...FIXED_SCORER_KEYS.code]);
    expect(rubric.criteria[3].title).toBe('How you worked');
    expect(byTestId('tre-criteria-status').textContent).toBe(fixedCriteriaRefusal('Implementation'));
  });

  test('the executable editor has no brief field, in Implementation, Testing and Maintenance', async () => {
    const maintenanceTask = task({ change: { ticket: { id: 'CHG-1', title: 't', summary: 's', acceptance: [{ id: 'AC-1', line: 'a' }] }, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } } } as Partial<DraftTaskView>);
    const maintenance = implementation({ key: 'maintenance', order: 6, title: 'Maintenance', tasks: [maintenanceTask] });
    const cases: [string, React.ReactNode, string][] = [
      ['implementation', <ImplementationBuilder key="i" {...props(implementation())} />, 'exec-edit-open'],
      ['testing', <TestingBuilder key="t" {...props(testing())} />, 'exec-edit-open'],
      ['maintenance', <MaintenanceBuilder key="m" {...props(maintenance)} draft={{ phases: [maintenance] }} />, 'tdm-code-edit'],
    ];
    for (const [name, node, edit] of cases) {
      await act(async () => root.render(node));
      await settle(6);
      await click(edit);
      expect(queryTestId('exec-editor'), name).not.toBeNull();
      expect(queryTestId('exec-brief'), name).toBeNull();
      expect(byTestId('exec-editor').querySelector('legend')?.textContent, name).toBe('The starter files');
    }
  });

  test("BriefCard's flush sends a waiting edit before a step's own save goes out", async () => {
    updateTask.mockResolvedValue({ phase: implementation(), validation: {} });
    await act(async () => root.render(<ImplementationBuilder {...props(implementation())} />));
    await act(async () => {
      fireEvent.change(byTestId('tdi-brief-title'), { target: { value: 'Build the lending API' } });
    });
    await click('exec-edit-open');
    await click('exec-save');
    await settle(6);
    // the step's own save waits for the words, sent first and once; nothing more after the card's delay
    await act(async () => {
      await new Promise((done) => setTimeout(done, 700));
    });
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(sent(0)).toEqual({ title: 'Build the lending API' });
    expect(sent(1)).toHaveProperty('runs');
    expect(sent(1)).not.toHaveProperty('brief');
    expect(sent(1)).not.toHaveProperty('title');
  });

  test('step 2 draws the task\'s sign-off mark, and a change saves { signOff } alone', async () => {
    const onSignOff = vi.fn();
    await act(async () => root.render(<ImplementationBuilder {...props(implementation())} onSignOff={onSignOff} />));
    const mark = byTestId('tdi-code').querySelector<HTMLInputElement>('[data-testid="task-signoff-main"]');
    expect(mark).not.toBeNull();
    await act(async () => {
      fireEvent.click(mark!);
    });
    await settle(6);
    expect(onSignOff).toHaveBeenCalledWith(true);
    expect(updateTask).not.toHaveBeenCalled();
    // without the editor's own save, the card sends the mark itself, and the mark alone
    await act(async () => root.render(<TestingBuilder key="t" {...props(testing())} onSignOff={undefined} />));
    await settle(6);
    await act(async () => {
      fireEvent.click(byTestId('tdt-code').querySelector<HTMLInputElement>('[data-testid="task-signoff-main"]')!);
    });
    await settle(6);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ signOff: true });
  });

  test('the hero says the sealed suites come with the upload or are sealed here at step 2', async () => {
    for (const node of [<ImplementationBuilder key="i" {...props(implementation())} />, <TestingBuilder key="t" {...props(testing())} />]) {
      await act(async () => root.render(node));
      const line = host.querySelector('.tre-hero .purpose')!.textContent ?? '';
      expect(line).toContain('The sealed suites come with the upload, or you seal them here at step 2.');
      expect(line).not.toContain('come with the project;');
      expect(line).not.toContain('\u00b7');
    }
  });

  test("Maintenance's step 3 saves runs without a brief", async () => {
    const maintenanceTask = task({ change: { ticket: { id: 'CHG-1', title: 't', summary: 's', acceptance: [{ id: 'AC-1', line: 'a' }] }, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } } } as Partial<DraftTaskView>);
    const maintenance = implementation({ key: 'maintenance', order: 6, title: 'Maintenance', tasks: [maintenanceTask] });
    updateTask.mockResolvedValue({ phase: maintenance, validation: {} });
    await act(async () => root.render(<MaintenanceBuilder {...props(maintenance)} draft={{ phases: [maintenance] }} />));
    await settle(6);
    await click('tdm-code-edit');
    await click('exec-save');
    await settle(6);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(sent(0)).toHaveProperty('runs');
    expect(sent(0)).not.toHaveProperty('brief');
  });

  describe("the server's words after a save (Task 12)", () => {
    /** A save answer held open until the case answers it. */
    const held = () => {
      let answer: (value: unknown) => void = () => undefined;
      const promise = new Promise((done) => (answer = done));
      return { promise, answer: (value: unknown) => answer(value) };
    };
    const field = (id: string) => byTestId(id) as HTMLInputElement | HTMLTextAreaElement;
    const type = async (el: Element, value: string) => {
      await act(async () => {
        fireEvent.change(el, { target: { value } });
      });
    };

    test('the Brief card\'s brief field says it is plain text, in the editor\'s own sentence, by aria-describedby', async () => {
      await mountEditor([implementation(), testing()], 'implementation');
      expect((((field('tdi-brief-text')).getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))).toBe("Plain text. Lists, indented lines and code in backticks are kept as you type them; a heading's # and the stars or underscores around words are removed when you save.");
    });

    test("the Brief card takes the server's plain brief from the save's answer, and keeps a field typed in since", async () => {
      await mountEditor([implementation(), testing()], 'implementation');
      const save = held();
      updateTask.mockImplementationOnce(() => save.promise);
      // Save the brief sends the background too; its answer lands first, from before the words were saved
      updatePhase.mockResolvedValueOnce({ phase: implementation(), validation: null });
      await type(field('tdi-brief-text'), 'Make the shelf **lend** books.');
      await click('tdi-brief-save');
      expect(sent(0)).toEqual({ brief: 'Make the shelf **lend** books.' });
      // typed while the save is out: the answer does not draw over it
      await type(field('tdi-brief-title'), 'Build the lending API');
      await act(async () => {
        save.answer({ phase: implementation({ tasks: [task({ brief: 'Make the shelf lend books.' })] }), validation: null });
      });
      await settle(6);
      expect(field('tdi-brief-text').value).toBe('Make the shelf lend books.');
      expect(field('tdi-brief-title').value).toBe('Build the lending API');
    });

    test("the Criteria card takes the server's plain sentences from the save's answer", async () => {
      await mountEditor([implementation(), testing()], 'implementation');
      const card = () => byTestId('tdi-criteria');
      const title4 = () => card().querySelector('input[aria-label="Criterion 4 title"]') as HTMLInputElement;
      await type(title4(), '**How** you worked');
      const rubric = rubricOf(FIXED_SCORER_KEYS.code);
      rubric.criteria[3] = { ...rubric.criteria[3], title: 'How you worked' };
      updateTask.mockResolvedValueOnce({ phase: implementation({ tasks: [task({ rubric })] }), validation: null });
      await click('tre-criteria-save');
      await settle(6);
      expect((sent(0).rubric as { criteria: { title: string }[] }).criteria[3].title).toBe('**How** you worked');
      expect(title4().value).toBe('How you worked');
    });

    test("the Criteria card keeps a sentence typed while its save is out", async () => {
      await mountEditor([implementation(), testing()], 'implementation');
      const card = () => byTestId('tdi-criteria');
      const titleOf = (n: number) => card().querySelector(`input[aria-label="Criterion ${n} title"]`) as HTMLInputElement;
      const save = held();
      updateTask.mockImplementationOnce(() => save.promise);
      await type(titleOf(4), '**How** you worked');
      await click('tre-criteria-save');
      expect((sent(0).rubric as { criteria: { title: string }[] }).criteria[3].title).toBe('**How** you worked');
      // typed while the save is out: the answer does not draw over it
      await type(titleOf(3), 'Typed while the save was out');
      const rubric = rubricOf(FIXED_SCORER_KEYS.code);
      rubric.criteria[3] = { ...rubric.criteria[3], title: 'How you worked' };
      await act(async () => {
        save.answer({ phase: implementation({ tasks: [task({ rubric })] }), validation: null });
      });
      await settle(6);
      expect(titleOf(3).value).toBe('Typed while the save was out');
    });

    /** The converting save of the Brief card, answered, with the draft's re-read held open until the case answers it. */
    const convertingSave = async (phaseSet?: DraftPhaseSetView[]) => {
      const start = version([implementation(), testing({ tasks: [{ ...testingTask, brief: '## Test it' }] })]);
      if (phaseSet) start.phaseSet = phaseSet;
      draft.mockResolvedValueOnce(start);
      await act(async () => root.render(<ProjectEditor projectId="p" versionId="v" />));
      await settle(6);
      await click('project-phase-tab-implementation');
      await settle(6);
      const notes = [markdownKeptWarning('Implementation', ['brief']), markdownKeptWarning('Testing', ['brief'])];
      const read = held();
      draft.mockImplementationOnce(() => read.promise);
      // each answer is a new object, as each reply of the API is
      const lent = () => implementation({ tasks: [task({ brief: 'Lend books.' })] });
      updateTask.mockResolvedValueOnce({ phase: lent(), validation: null, plainTextConversion: { notes } });
      updatePhase.mockResolvedValueOnce({ phase: lent(), validation: null });
      await type(field('tdi-brief-text'), '**Lend** books.');
      await click('tdi-brief-save');
      await settle(6);
      expect(draft).toHaveBeenCalledTimes(2);
      const converted = version([lent(), testing({ tasks: [{ ...testingTask, brief: 'Test it' }] })]);
      converted.plainTextConversion = { notes };
      if (phaseSet) converted.phaseSet = phaseSet;
      return { notes, answerRead: async () => {
        await act(async () => read.answer(converted));
        await settle(6);
      } };
    };

    test("a phase saved while the converting save's re-read is out keeps its own answer", async () => {
      const { notes, answerRead } = await convertingSave();
      await click('project-phase-tab-testing');
      await settle(6);
      const checked = () => testing({ tasks: [{ ...testingTask, brief: 'Check it.' }] });
      updateTask.mockResolvedValueOnce({ phase: checked(), validation: null });
      updatePhase.mockResolvedValueOnce({ phase: checked(), validation: null });
      await type(field('tdt-brief-text'), '**Check** it.');
      await click('tdt-brief-save');
      await settle(6);
      expect(field('tdt-brief-text').value).toBe('Check it.');
      // the re-read was asked before that save, so its Testing is older than the answer on screen
      await answerRead();
      expect(field('tdt-brief-text').value).toBe('Check it.');
      expect([...host.querySelectorAll('[data-testid="project-plain-text-note"]')].map((one) => one.textContent)).toEqual([notes[1]]);
    });

    test("a Phases card door answered while the converting save's re-read is out drops that read", async () => {
      const row = (key: DraftPhaseSetView['key'], state: 'held' | 'removed'): DraftPhaseSetView =>
        state === 'held'
          ? { key, state, removeSource: 'held', canRemove: true, canPutBack: false, canAdd: false, why: null }
          : { key, state, canRemove: false, canPutBack: true, canAdd: false, why: null };
      const { answerRead } = await convertingSave([row('requirements', 'removed'), row('implementation', 'held'), row('testing', 'held')]);
      const door = version([implementation({ tasks: [task({ brief: 'Lend books.' })] }), testing({ tasks: [{ ...testingTask, brief: 'From the door.' }] })]);
      door.phaseSet = [row('requirements', 'removed'), row('implementation', 'held'), row('testing', 'held')];
      restorePhase.mockResolvedValueOnce(door);
      await click('phases-putback-requirements');
      await settle(6);
      expect(restorePhase).toHaveBeenCalledTimes(1);
      // the door's whole view stands: the re-read, asked before it, is not drawn over it
      await answerRead();
      await click('project-phase-tab-testing');
      await settle(6);
      expect(field('tdt-brief-text').value).toBe('From the door.');
    });

    test('a save that converted the draft draws its notes and reads the draft again for the other phases', async () => {
      await mountEditor([implementation(), testing({ tasks: [{ ...testingTask, brief: '## Test it' }] })], 'implementation');
      expect(draft).toHaveBeenCalledTimes(1);
      const notes = [markdownKeptWarning('Implementation', ['brief']), markdownKeptWarning('Testing', ['brief'])];
      const converted = version([implementation({ tasks: [task({ brief: 'Lend books.' })] }), testing({ tasks: [{ ...testingTask, brief: 'Test it' }] })]);
      converted.plainTextConversion = { notes };
      draft.mockResolvedValueOnce(converted);
      updateTask.mockResolvedValueOnce({ phase: implementation({ tasks: [task({ brief: 'Lend books.' })] }), validation: null, plainTextConversion: { notes } });
      updatePhase.mockResolvedValueOnce({ phase: implementation({ tasks: [task({ brief: 'Lend books.' })] }), validation: null });
      await type(field('tdi-brief-text'), '**Lend** books.');
      await click('tdi-brief-save');
      await settle(6);
      expect(draft).toHaveBeenCalledTimes(2);
      expect([...host.querySelectorAll('[data-testid="project-plain-text-note"]')].map((one) => one.textContent)).toEqual([notes[0]]);
      expect(field('tdi-brief-text').value).toBe('Lend books.');
      await click('project-phase-tab-testing');
      await settle(6);
      expect(field('tdt-brief-text').value).toBe('Test it');
      expect([...host.querySelectorAll('[data-testid="project-plain-text-note"]')].map((one) => one.textContent)).toEqual([notes[1]]);
    });
  });
});

// Each link of the row of steps goes to its own card, in both code tabs of the editor.
describe('the row of steps of the Implementation and Testing tabs', () => {
  test('each step link names its own card, in the order of the cards', async () => {
    await mountEditor([implementation(), testing()], 'implementation');
    expect(expectStepLinksLand(host)).toEqual(['Brief', 'Code and runs', 'Criteria']);
    await click('project-phase-tab-testing');
    await settle(6);
    expect(expectStepLinksLand(host)).toEqual(['Brief', 'Tests and runs', 'Criteria']);
  });
});

// In Implementation and Testing the box sits at the end of step 2, Code and runs, in Maintenance at the end of
// step 4, Change request; the row's Sign-off entry goes to it.
describe('the Sign-off entry of the Implementation, Testing and Maintenance tabs', () => {
  test('in the editor, each tab\'s entry after the three steps brings its Code and runs box into view and focuses it, never ticking it', async () => {
    await mountEditor([implementation(), testing()], 'implementation');
    await expectSignOffJumpLands(host, 'main', 'tdi-code');
    await click('project-phase-tab-testing');
    await settle(6);
    await expectSignOffJumpLands(host, 'main', 'tdt-code');
    expect(updateTask).not.toHaveBeenCalled();
    // The editor's own link handling leaves the address alone: the entry wrote no fragment.
    expect(window.location.hash).toBe('');
  });
  // The press on a step's link itself, through the mounted editor. Its
  // link capture runs before the entry's own handler and must leave a place in
  // the open section to it: no second scroll a frame later, no fragment.
  test('in the editor, the Maintenance tab\'s entry brings the Change request box into view and focuses it, never ticking it', async () => {
    const maintenanceTask = task({ change: { ticket: { id: 'CHG-1', title: 't', summary: 's', acceptance: [{ id: 'AC-1', line: 'a' }] }, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } } } as Partial<DraftTaskView>);
    const maintenance = implementation({ key: 'maintenance', order: 6, title: 'Maintenance', tasks: [maintenanceTask] });
    await mountEditor([implementation(), testing(), maintenance], 'maintenance');
    expect(queryTestId('tdm-change')).not.toBeNull();
    // Any scroll after the press (the editor's own goes a frame later) is recorded here.
    const later: unknown[] = [];
    const proto = HTMLElement.prototype as { scrollIntoView?: (options?: unknown) => void };
    proto.scrollIntoView = (options?: unknown) => {
      later.push(options);
    };
    try {
      await expectSignOffJumpLands(host, 'main', 'tdm-change');
      await act(async () => {
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
      await settle(6);
    } finally {
      delete proto.scrollIntoView;
    }
    expect(later).toEqual([]);
    const box = document.getElementById('task-signoff-main') as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    expect(box.checked).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
  test('a version that cannot change draws no box, so no Sign-off entry', async () => {
    await act(async () => root.render(<ImplementationBuilder {...props(implementation())} editable={false} />));
    expect(queryTestId('tre-steps')).not.toBeNull();
    expect(queryTestId('tre-signoff-jump')).toBeNull();
    expect(document.getElementById('task-signoff-main')).toBeNull();
  });
});
