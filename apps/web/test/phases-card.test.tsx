// @vitest-environment jsdom
/**
 * The Phases card, and the class card's list of assignable versions.
 *
 * The card is drawn from the draft view's `phaseSet` (spec 5.1) with the
 * projects client mocked, so every assertion reads what the teacher sees and
 * what a door sends. The editor is rendered once, to show the card sits above
 * the phase tabs and that the answered view replaces the editor's. The class
 * card is rendered with `@/lib/api` mocked one layer down, as its own test
 * does, so the assignable list is read through the real client.
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_VALIDATION_CHECK_IDS,
  NO_PHASE_TO_PUBLISH,
  SUPPORTED_STACKS_SENTENCE,
  addByUploadRefusal,
  deepValidationCostWarning,
  keepOnePhaseRefusal,
  removeConfirm,
  type AssignableVersionView,
  type CohortProjectView,
  type DraftPhaseSetView,
  type DraftPhaseView,
  type DraftVersionView,
  type ExecutableTaskView,
  type PhaseKey,
} from '@learnsdlc/shared';

const removePhase = vi.fn();
const restorePhase = vi.fn();
const addPhase = vi.fn();
const draft = vi.fn();
const files = vi.fn();
const deepValidation = vi.fn();
const writeSealed = vi.fn();
// The real module beside the mocked client: the class card's client builds its paths with `authoringPath`.
vi.mock('@/lib/api-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-projects')>()),
  projectsApi: {
    removePhase: (...a: unknown[]) => removePhase(...a),
    restorePhase: (...a: unknown[]) => restorePhase(...a),
    addPhase: (...a: unknown[]) => addPhase(...a),
    draft: (...a: unknown[]) => draft(...a),
    files: (...a: unknown[]) => files(...a),
    deepValidation: (...a: unknown[]) => deepValidation(...a),
    writeSealed: (...a: unknown[]) => writeSealed(...a),
    get: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
  },
}));

const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  request: calls.request,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p-mine', versionId: 'v-mine' }),
  usePathname: () => '/teacher/projects/p-mine/versions/v-mine',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'a@b.c', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { ApiError } from '@/lib/api';
import { PhasesCard, phasesReadiness } from '@/components/staff/projects/PhasesCard';
import { phaseSetFor } from './support/phase-set';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { ClassProjectCard } from '@/components/staff/ClassProjectCard';
import { settle, typeInto } from './support/dom';

const held = (key: PhaseKey, removeSource: DraftPhaseSetView['removeSource'] = 'held', canRemove = true): DraftPhaseSetView => ({
  key, state: 'held', removeSource, canRemove, canPutBack: false, canAdd: false, why: null,
});
const removed = (key: PhaseKey): DraftPhaseSetView => ({ key, state: 'removed', canRemove: false, canPutBack: true, canAdd: false, why: null });
const absent = (key: PhaseKey): DraftPhaseSetView => {
  const addable = key === 'requirements' || key === 'design';
  return { key, state: 'absent', canRemove: false, canPutBack: false, canAdd: addable, why: addable ? null : addByUploadRefusal(key) };
};

/** Requirements and Implementation held, Design addable, Testing removed, the last two never held. */
const MIXED: DraftPhaseSetView[] = [
  held('requirements'),
  absent('design'),
  held('implementation'),
  removed('testing'),
  absent('deployment'),
  absent('maintenance'),
];

const phase = (key: PhaseKey, order: number, title: string): DraftPhaseView =>
  ({ key, order, title, intro: '', artifactKind: 'quiz', checkKind: 'quiz', tasks: [], blocksPublish: false } as unknown as DraftPhaseView);

function version(over: Partial<DraftVersionView> = {}): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'room-desk',
    title: 'RoomDesk',
    tagline: '',
    description: '',
    platformOwned: false,
    editable: true,
    phases: [phase('requirements', 1, 'Requirements'), phase('implementation', 2, 'Implementation')],
    validation: null,
    supportedStacks: { python: [], node: [], tools: [], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-17T00:00:00.000Z',
    forkedFromVersionId: 'v-head',
    phaseSet: MIXED,
    ...over,
  };
}

const DEEP = {
  versionId: 'v-mine',
  status: 'not-run' as const,
  current: false,
  contentDigest: null,
  checks: DEEP_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pending' as const, sentence: 'Not run.', phaseKey: null, taskKey: null })),
  costWarning: { microVMs: 13, sentence: deepValidationCostWarning(13) },
  startedAt: null,
  finishedAt: null,
};

const EXEC: ExecutableTaskView = {
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
  sandboxBudget: 11,
};

/** A phase whose one task carries an executable view, so the executable editor and deep validation are drawn. */
const executablePhase = (key: PhaseKey, order: number, title: string): DraftPhaseView =>
  ({
    key, order, title, intro: '', artifactKind: 'code', checkKind: 'code', blocksPublish: false,
    tasks: [{
      taskKey: 'main', order: 1, required: true, title: `Build ${title}`, brief: 'Build it.', artefactType: 'code',
      artefactPath: null, checkKind: 'code', rubric: { passThreshold: 70, criteria: [] }, objectives: [],
      owns: ['api/app.py'], authorable: true, notice: null, executable: { ...EXEC },
    }],
  } as unknown as DraftPhaseView);

/** Requirements, and two executable phases: removing one leaves deep validation drawn. */
function executableVersion(over: Partial<DraftVersionView> = {}): DraftVersionView {
  return version({
    phases: [phase('requirements', 1, 'Requirements'), executablePhase('implementation', 2, 'Implementation'), executablePhase('testing', 3, 'Testing')],
    phaseSet: [held('requirements'), absent('design'), held('implementation'), held('testing'), absent('deployment'), absent('maintenance')],
    ...over,
  });
}
/**
 * That draft with a concept quiz beside Implementation's one code task. The
 * three-step builder claims the code task, so the task list still draws, now
 * holding only the quiz and its Remove button.
 */
const withImplementationQuiz = () => {
  const start = executableVersion();
  const concepts = {
    taskKey: 'concepts', order: 2, required: false, title: 'Implementation concepts', brief: 'Answer the questions.', artefactType: 'quiz',
    artefactPath: null, checkKind: 'quiz', rubric: null, objectives: [], owns: [], authorable: true, notice: null, executable: null,
    quiz: { questions: [], shuffleOptions: false, passMark: 70, attempts: { max: null, cooldownSeconds: null }, criterion: 'concepts' },
  } as unknown as DraftPhaseView['tasks'][number];
  return {
    ...start,
    phases: start.phases.map((one) => (one.key === 'implementation' ? { ...one, tasks: [...one.tasks, concepts] } : one)),
  };
};
/** That draft once Implementation is removed. */
const withoutImplementation = () =>
  executableVersion({
    phases: [phase('requirements', 1, 'Requirements'), executablePhase('testing', 2, 'Testing')],
    phaseSet: [held('requirements'), absent('design'), removed('implementation'), held('testing'), absent('deployment'), absent('maintenance')],
  });

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const click = async (id: string) =>
  act(async () => {
    fireEvent.click(q(id)!);
  });
/** Let the frame the card moves focus in run. */
const nextFrame = async () =>
  act(async () => {
    await new Promise((done) => requestAnimationFrame(() => done(null)));
  });
const focused = () => document.activeElement?.getAttribute('data-testid') ?? null;
/** A promise the test settles by hand, for an answer that lands later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The card as the editor holds it: the answered view replaces the one drawn. */
function Harness({ start, editable = true, onChanged }: { start: DraftVersionView; editable?: boolean; onChanged?: (view: DraftVersionView) => void }) {
  const [view, setView] = useState(start);
  return (
    <PhasesCard
      projectId={view.projectId}
      versionId={view.versionId}
      phaseSet={view.phaseSet}
      editable={editable}
      onChanged={(next) => {
        onChanged?.(next);
        setView(next);
      }}
    />
  );
}
const renderCard = async (start: DraftVersionView, editable = true, onChanged?: (view: DraftVersionView) => void) => {
  await act(async () => root.render(<Harness start={start} editable={editable} onChanged={onChanged} />));
};

beforeEach(() => {
  vi.clearAllMocks();
  removePhase.mockReset();
  restorePhase.mockReset();
  addPhase.mockReset();
  draft.mockReset();
  files.mockReset();
  files.mockResolvedValue([]);
  deepValidation.mockReset();
  deepValidation.mockResolvedValue(DEEP);
  writeSealed.mockReset();
  calls.request.mockReset();
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

describe('the Phases card', () => {
  it('draws the six phases with their states and only the doors each offers', async () => {
    await renderCard(version());
    const card = q('phases-card')!;
    expect(card.querySelector('h3')!.textContent).toBe('Phases');
    expect(card.textContent).toContain("A project holds the phases it needs, in LearnSDLC's order.");
    expect(q('phases-card-readiness')!.textContent).toBe("This draft holds 2 of LearnSDLC's six phases: Requirements and Implementation.");
    const rows = [...card.querySelectorAll('[data-testid^="phases-row-"]')].map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual([
      'phases-row-requirements', 'phases-row-design', 'phases-row-implementation',
      'phases-row-testing', 'phases-row-deployment', 'phases-row-maintenance',
    ]);
    const state = (key: PhaseKey) => q(`phases-state-${key}`)!.textContent;
    expect(state('requirements')).toBe('In this project');
    expect(state('design')).toBe('Not in this project');
    expect(state('implementation')).toBe('In this project');
    expect(state('testing')).toBe('Removed');
    expect(state('deployment')).toBe('Not in this project');
    expect(state('maintenance')).toBe('Not in this project');
    // Each door only where the row offers it.
    const doors = [...card.querySelectorAll('button')].map((one) => one.getAttribute('data-testid'));
    expect(doors).toEqual(['phases-remove-requirements', 'phases-add-design', 'phases-remove-implementation', 'phases-putback-testing']);
    expect(q('phases-remove-requirements')!.textContent).toBe('Remove');
    expect(q('phases-add-design')!.textContent).toBe('Add');
    expect(q('phases-putback-testing')!.textContent).toBe('Put back');

    // A held phase the API says may not go (the last one) draws no Remove.
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderCard(version({ phaseSet: [held('requirements', 'held', false), absent('design'), ...MIXED.slice(2).map((one) => (one.state === 'held' ? absent(one.key) : one))] }));
    expect(q('phases-remove-requirements')).toBeNull();
    expect(q('phases-card-readiness')!.textContent).toBe("This draft holds 1 of LearnSDLC's six phases: Requirements.");

    // Not editable: the states, no doors.
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderCard(version({ status: 'published', editable: false }), false);
    expect(q('phases-card')!.querySelectorAll('button')).toHaveLength(0);
    expect(q('phases-state-testing')!.textContent).toBe('Removed');
    expect(q('phases-card-readiness')!.textContent).toBe("This version holds 2 of LearnSDLC's six phases: Requirements and Implementation.");
  });

  it('asks before a Remove, in the confirm words of the phase\'s source, and sends nothing on Cancel', async () => {
    const sources: DraftPhaseSetView['removeSource'][] = ['held', 'no-source', 'not-held'];
    for (const source of sources) {
      await act(async () => root.unmount());
      root = createRoot(host);
      await renderCard(version({ phaseSet: [held('requirements'), held('design', source), absent('implementation'), absent('testing'), absent('deployment'), absent('maintenance')] }));
      await click('phases-remove-design');
      expect(q('phases-confirm-line')!.textContent).toBe(removeConfirm('design', source!));
      await click('phases-confirm-no');
      expect(q('phases-confirm-line')).toBeNull();
    }
    expect(removeConfirm('design', 'no-source')).toContain('so Design comes back only as an empty phase, through Add.');
    expect(removeConfirm('design', 'held')).toContain('Published versions keep it.');
    expect(removePhase).not.toHaveBeenCalled();

    // Confirmed, the door is sent once with the phase's key.
    const answer = version({ phaseSet: [held('requirements', 'held', false), absent('design'), absent('implementation'), absent('testing'), absent('deployment'), absent('maintenance')] });
    removePhase.mockResolvedValue(answer);
    await click('phases-remove-design');
    await click('phases-confirm-yes');
    expect(removePhase).toHaveBeenCalledTimes(1);
    expect(removePhase).toHaveBeenCalledWith('p-mine', 'v-mine', 'design');
    expect(q('phases-state-design')!.textContent).toBe('Not in this project');
  });

  it('puts a removed phase back and redraws from the answer', async () => {
    const answer = version({ phaseSet: MIXED.map((one) => (one.key === 'testing' ? held('testing') : one)) });
    restorePhase.mockResolvedValue(answer);
    const changed = vi.fn();
    await renderCard(version(), true, changed);
    await click('phases-putback-testing');
    expect(restorePhase).toHaveBeenCalledWith('p-mine', 'v-mine', 'testing');
    expect(changed).toHaveBeenCalledWith(answer);
    expect(q('phases-state-testing')!.textContent).toBe('In this project');
    expect(q('phases-putback-testing')).toBeNull();
    expect(q('phases-remove-testing')).not.toBeNull();
    expect(q('phases-card-readiness')!.textContent).toBe("This draft holds 3 of LearnSDLC's six phases: Requirements, Implementation and Testing.");

    // Add answers the same way.
    const added = version({ phaseSet: answer.phaseSet!.map((one) => (one.key === 'design' ? held('design', 'not-held') : one)) });
    addPhase.mockResolvedValue(added);
    await click('phases-add-design');
    expect(addPhase).toHaveBeenCalledWith('p-mine', 'v-mine', 'design');
    expect(q('phases-state-design')!.textContent).toBe('In this project');
  });

  it('shows the API\'s refusal in its own words', async () => {
    removePhase.mockRejectedValue(new ApiError(409, keepOnePhaseRefusal('design')));
    const changed = vi.fn();
    await renderCard(version({ phaseSet: [absent('requirements'), held('design'), absent('implementation'), absent('testing'), absent('deployment'), absent('maintenance')] }), true, changed);
    await click('phases-remove-design');
    await click('phases-confirm-yes');
    const error = q('phases-error')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe('A project keeps at least one phase. Put another phase back before you remove Design.');
    expect(changed).not.toHaveBeenCalled();
    expect(q('phases-state-design')!.textContent).toBe('In this project');
  });

  it('says why an application phase is added by upload', async () => {
    await renderCard(version());
    const line = 'Added by upload: its files, tests and solution cannot be made in the browser.';
    // Beside every application phase the draft does not hold, removed or never there.
    for (const key of ['testing', 'deployment', 'maintenance'] as const) {
      expect(q(`phases-upload-${key}`)!.textContent).toBe(line);
    }
    // Not beside a held one, nor beside Requirements or Design, which Add makes.
    expect(q('phases-upload-implementation')).toBeNull();
    expect(q('phases-upload-requirements')).toBeNull();
    expect(q('phases-upload-design')).toBeNull();
  });

  it("is drawn inside the builders' panel, so their edges and colours resolve, with every state in the neutral chip", async () => {
    await renderCard(version());
    const card = q('phases-card')!;
    // The builders' variables live on `.tre-panel`; without it the card has no edge.
    expect(card.classList.contains('tre-panel')).toBe(true);
    expect(card.classList.contains('tre-card')).toBe(true);
    // Colour only as meaning: being in the project is not a pass, so no state is green.
    for (const key of ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const) {
      expect(q(`phases-state-${key}`)!.className).toBe('chip');
    }
  });

  it('says a draft that holds no phase holds none, in the publish refusal\'s words', async () => {
    const none = (['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const).map((key) =>
      key === 'testing' ? removed(key) : absent(key),
    );
    await renderCard(version({ phaseSet: none }));
    expect(q('phases-card-readiness')!.textContent).toBe(NO_PHASE_TO_PUBLISH);
    expect(q('phases-card-readiness')!.textContent).toBe('This draft holds no phase. Put a phase back or add one before you publish.');
  });

  it('names Put back by its visible label first (WCAG 2.5.3)', async () => {
    await renderCard(version());
    expect(q('phases-putback-testing')!.getAttribute('aria-label')).toBe('Put back Testing');
  });

  it('shows the Remove as working while it is out', async () => {
    const answer = deferred<DraftVersionView>();
    removePhase.mockReturnValue(answer.promise);
    await renderCard(version());
    await click('phases-remove-implementation');
    await click('phases-confirm-yes');
    const trigger = q('phases-remove-implementation')!;
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger.textContent).toBe('Removing…');
    expect(q('phases-confirm-yes')).toBeNull();
    await act(async () => answer.resolve(version({ phaseSet: MIXED.map((one) => (one.key === 'implementation' ? removed('implementation') : one)) })));
  });

  describe('keeps the keyboard in the card', () => {
    it('Keep it hands focus back to the Remove that opened it', async () => {
      await renderCard(version());
      await click('phases-remove-implementation');
      q<HTMLButtonElement>('phases-confirm-no')!.focus();
      await click('phases-confirm-no');
      expect(focused()).toBe('phases-remove-implementation');
    });

    it('a Remove lands on the row\'s Put back', async () => {
      removePhase.mockResolvedValue(version({ phaseSet: MIXED.map((one) => (one.key === 'implementation' ? removed('implementation') : one)) }));
      await renderCard(version());
      await click('phases-remove-implementation');
      q<HTMLButtonElement>('phases-confirm-yes')!.focus();
      await click('phases-confirm-yes');
      await nextFrame();
      expect(focused()).toBe('phases-putback-implementation');
    });

    it('a Remove whose row offers no Put back lands on the line that says it was done', async () => {
      // Design from a version that did not hold it: it comes back only through Add.
      const start = version({ phaseSet: [held('requirements'), held('design', 'not-held'), absent('implementation'), absent('testing'), absent('deployment'), absent('maintenance')] });
      removePhase.mockResolvedValue(version({ phaseSet: [held('requirements', 'held', false), absent('design'), absent('implementation'), absent('testing'), absent('deployment'), absent('maintenance')] }));
      await renderCard(start);
      await click('phases-remove-design');
      await click('phases-confirm-yes');
      await nextFrame();
      expect(focused()).toBe('phases-status');
      expect(q('phases-status')!.textContent).toBe('Design was removed from this draft.');
    });

    it('a Put back and an Add land on the row\'s Remove', async () => {
      const answer = version({ phaseSet: MIXED.map((one) => (one.key === 'testing' ? held('testing') : one)) });
      restorePhase.mockResolvedValue(answer);
      await renderCard(version());
      q<HTMLButtonElement>('phases-putback-testing')!.focus();
      await click('phases-putback-testing');
      await nextFrame();
      expect(focused()).toBe('phases-remove-testing');

      addPhase.mockResolvedValue(version({ phaseSet: answer.phaseSet!.map((one) => (one.key === 'design' ? held('design', 'not-held') : one)) }));
      q<HTMLButtonElement>('phases-add-design')!.focus();
      await click('phases-add-design');
      await nextFrame();
      expect(focused()).toBe('phases-remove-design');
    });

    it('a refusal lands on the line that says it', async () => {
      restorePhase.mockRejectedValue(new ApiError(409, 'Testing cannot be put back.'));
      await renderCard(version());
      q<HTMLButtonElement>('phases-putback-testing')!.focus();
      await click('phases-putback-testing');
      await nextFrame();
      expect(focused()).toBe('phases-error');
      expect(q('phases-error')!.textContent).toBe('Testing cannot be put back.');
    });
  });
});

describe('the Phases card in the editor', () => {
  it('sits on the Overview, under the section tabs, and takes the answered view in place of the editor\'s', async () => {
    draft.mockResolvedValue(version());
    const answer = version({
      phases: [phase('requirements', 1, 'Requirements')],
      phaseSet: [held('requirements', 'held', false), absent('design'), removed('implementation'), removed('testing'), absent('deployment'), absent('maintenance')],
    });
    removePhase.mockResolvedValue(answer);
    await act(async () => root.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />));
    // The card is about every phase, so it is on the Overview, not inside one phase's tab;
    // the one row of tabs, phases included, is above it.
    const card = q('phases-card')!;
    const tabs = q('project-phase-tab-requirements')!;
    expect(card.closest('[data-project-section]')?.getAttribute('data-project-section')).toBe('overview');
    expect(card.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(q('project-phase-tab-implementation')).not.toBeNull();
    await click('phases-remove-implementation');
    await click('phases-confirm-yes');
    expect(removePhase).toHaveBeenCalledWith('p-mine', 'v-mine', 'implementation');
    expect(q('project-phase-tab-implementation')).toBeNull();
    expect(q('phases-state-implementation')!.textContent).toBe('Removed');
  });

  // The phase's label is inside its tab in the one row of section tabs.
  const tabSelected = (key: PhaseKey) => q(`project-phase-tab-${key}`)?.closest('[role="tab"]')?.getAttribute('aria-selected') === 'true';
  const mountEditor = async (start: DraftVersionView) => {
    draft.mockResolvedValue(start);
    await act(async () => root.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />));
    await settle(6);
  };

  it('removing the open phase closes its forms, opens the first phase and reads the files and deep validation again', async () => {
    removePhase.mockResolvedValue(withoutImplementation());
    await mountEditor(executableVersion());
    await click('project-phase-tab-implementation');
    expect(tabSelected('implementation')).toBe(true);
    await click('exec-edit-open');
    await click('project-add-task');
    expect(q('task-form')).not.toBeNull();
    expect(q('exec-edit-open')).toBeNull();
    await click('project-files-open');
    await settle(6);
    expect(files).toHaveBeenCalledTimes(1);
    const deepReads = deepValidation.mock.calls.length;
    expect(deepReads).toBeGreaterThan(0);

    await click('phases-remove-implementation');
    await click('phases-confirm-yes');
    await settle(6);

    expect(q('project-phase-tab-implementation')).toBeNull();
    expect(tabSelected('requirements')).toBe(true);
    // The forms of the phase that went are closed.
    expect(q('task-form')).toBeNull();
    expect(q('exec-cancel')).toBeNull();
    // The file rows are read again on the next ask, not drawn from the cache.
    expect(q('project-files-open')).not.toBeNull();
    await click('project-files-open');
    await settle(6);
    expect(files).toHaveBeenCalledTimes(2);
    // Deep validation reads again: its receipt names the phases it validated.
    expect(deepValidation.mock.calls.length).toBeGreaterThan(deepReads);
  });

  it('removing the open phase closes its task-remove confirm, and a later Put back leaves the first phase open', async () => {
    removePhase.mockResolvedValue(withoutImplementation());
    restorePhase.mockResolvedValue(withImplementationQuiz());
    await mountEditor(withImplementationQuiz());
    await click('project-phase-tab-implementation');
    await click('task-remove-concepts');
    expect(q('task-remove-confirm')).not.toBeNull();

    await click('phases-remove-implementation');
    await click('phases-confirm-yes');
    await settle(6);
    expect(q('task-remove-confirm')).toBeNull();

    await click('phases-putback-implementation');
    await settle(6);
    expect(q('project-phase-tab-implementation')).not.toBeNull();
    expect(tabSelected('requirements')).toBe(true);
    expect(tabSelected('implementation')).toBe(false);
  });

  it('a phase opened while a door is out is closed when the answer no longer holds it', async () => {
    const answer = deferred<DraftVersionView>();
    removePhase.mockReturnValue(answer.promise);
    await mountEditor(executableVersion());
    // The editor opens on the Overview, where the card is; the teacher has opened Requirements.
    await click('project-phase-tab-requirements');
    expect(tabSelected('requirements')).toBe(true);
    await click('phases-remove-implementation');
    await click('phases-confirm-yes');
    // The teacher moves to Implementation and opens a form there before the answer lands.
    await click('project-phase-tab-implementation');
    await click('project-add-task');
    expect(q('task-form')).not.toBeNull();

    await act(async () => answer.resolve(withoutImplementation()));
    await settle(6);
    expect(q('project-phase-tab-implementation')).toBeNull();
    expect(tabSelected('requirements')).toBe(true);
    expect(q('task-form')).toBeNull();
  });

  it("an older seal's re-read that lands after a door does not put the old phases back", async () => {
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 });
    await mountEditor(executableVersion());
    await click('project-phase-tab-implementation');
    await click('exec-edit-open');
    // The seal's re-read is held until after the door's answer.
    const reread = deferred<DraftVersionView>();
    draft.mockReturnValue(reread.promise);
    const input = q<HTMLInputElement>('sealed-hidden-api-file')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['more'], 'test_more.py')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const path = q<HTMLInputElement>('sealed-hidden-api-path')!;
    await act(async () => {
      typeInto(path, 'test_more.py');
    });
    await click('sealed-hidden-api-upload');
    await settle(6);
    expect(writeSealed).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledTimes(2);

    removePhase.mockResolvedValue(
      executableVersion({
        phases: [phase('requirements', 1, 'Requirements'), executablePhase('implementation', 2, 'Implementation')],
        phaseSet: [held('requirements'), absent('design'), held('implementation'), removed('testing'), absent('deployment'), absent('maintenance')],
      }),
    );
    await click('phases-remove-testing');
    await click('phases-confirm-yes');
    await settle(6);
    expect(q('project-phase-tab-testing')).toBeNull();

    // The seal's read was answered before the door's write: it still holds Testing.
    await act(async () => reread.resolve(executableVersion()));
    await settle(6);
    expect(q('project-phase-tab-testing')).toBeNull();
    expect(q('phases-state-testing')!.textContent).toBe('Removed');
  });

  it('draws the card with no door for a reader who may not change the draft, whatever its rows offer', async () => {
    // An admin reading another teacher's draft: the rows may still offer doors.
    await mountEditor(version({ editable: false }));
    expect(q('phases-card')).not.toBeNull();
    expect(q('phases-card')!.querySelectorAll('button')).toHaveLength(0);
    expect(q('phases-state-testing')!.textContent).toBe('Removed');
  });

  it('draws the card from the phase set every draft view carries, as the API builds it, beside the path', async () => {
    const { phaseSet: _rows, ...withoutRows } = version();
    // @ts-expect-error The contract requires the phase set on every draft view.
    const notAView: DraftVersionView = withoutRows;
    void notAView;
    await mountEditor(version({ phaseSet: phaseSetFor(['requirements', 'implementation'], true) }));
    expect(q('phases-card')).not.toBeNull();
    expect(q('phases-card-readiness')!.textContent).toBe(phasesReadiness(phaseSetFor(['requirements', 'implementation'], true), true));
    expect(q('phases-state-requirements')!.textContent).toBe('In this project');
    expect(q('phases-card')!.closest('.lg\\:grid-cols-2')).not.toBeNull();
  });
});

describe('the assignable list', () => {
  const READ = '/instructor/cohorts/class-one/project';
  const ASSIGNABLE = '/instructor/cohorts/class-one/project/assignable';
  const row = (over: Partial<AssignableVersionView>): AssignableVersionView => ({
    projectId: 'project-mine',
    projectSlug: 'room-desk',
    projectTitle: 'RoomDesk',
    platformOwned: false,
    mine: true,
    versionId: 'version-three',
    version: '0.2.0',
    publishedAt: '2026-10-17T08:00:00Z',
    current: false,
    ...over,
  });
  const view: CohortProjectView = { cohortId: 'class-one', active: null, history: [] };

  it("names an assignable version's phases", async () => {
    const three = row({ phases: ['requirements', 'design', 'implementation'] });
    const older = row({ versionId: 'version-older', version: '0.1.0' });
    calls.request.mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === READ) return Promise.resolve(view);
      if (method === 'GET' && path === ASSIGNABLE) return Promise.resolve([three, older]);
      return Promise.reject(new Error(`no route for ${method} ${path}`));
    });
    await act(async () => root.render(<ClassProjectCard cohortId="class-one" />));
    const options = [...host.querySelectorAll<HTMLOptionElement>('[data-testid="class-project-pick"] option')];
    const label = (id: string) => options.find((one) => one.value === id)!.textContent;
    expect(label('version-three')).toBe('RoomDesk 0.2.0: Requirements, Design and Implementation (yours)');
    // A version whose phases the payload does not name reads as it did.
    expect(label('version-older')).toBe('RoomDesk 0.1.0, yours');
  });
});
