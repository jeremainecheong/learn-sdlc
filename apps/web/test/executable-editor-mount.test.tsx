// @vitest-environment jsdom
/**
 * The executable surfaces, mounted in the project editor (fetch mocked at the
 * client; the wiring against the real API is in the *-wiring tests).
 *
 * - A draft whose work task carries an executable view draws its summary
 *   (digests only), the per-phase ceiling and deep validation; a draft
 *   without one draws none of them (every existing editor case).
 * - The editor's save goes through the task's own door; a sealed write goes
 *   through `sealed.write` and makes deep validation read again.
 * - The deployment phase says its smoke and drill are read-only.
 * - Export is offered to the owner of the draft.
 * - A draft whose texts were converted to plain text draws each note on the
 *   phase it names.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPhaseView, DraftTaskView, DraftVersionView, ExecutableTaskView } from '@learnsdlc/shared';
import {
  BUDGET_CEILING,
  CHANGE_REQUEST_JSON,
  EMPTY_RUNBOOK,
  RUNBOOK_JSON,
  serialiseRunbook,
  DEEP_VALIDATION_CHECK_IDS,
  EMPTY_CHANGE_REQUEST,
  DEFAULT_PASS_THRESHOLD,
  SUPPORTED_STACKS_SENTENCE,
  budgetCeilingRefusal,
  deepValidationCostWarning,
  htmlCommentWarning,
  markdownKeptWarning,
  markupOnlyWarning,
  serialiseChangeRequest,
} from '@learnsdlc/shared';

const draft = vi.fn();
const get = vi.fn();
const files = vi.fn();
const updateTask = vi.fn();
const writeSealed = vi.fn();
const deepValidation = vi.fn();
const startDeepValidation = vi.fn();
const validate = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    get: (...a: unknown[]) => get(...a),
    files: (...a: unknown[]) => files(...a),
    updateTask: (...a: unknown[]) => updateTask(...a),
    writeSealed: (...a: unknown[]) => writeSealed(...a),
    deepValidation: (...a: unknown[]) => deepValidation(...a),
    startDeepValidation: (...a: unknown[]) => startDeepValidation(...a),
    validate: (...a: unknown[]) => validate(...a),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ projectId: 'p-up', versionId: 'v-up' }),
  usePathname: () => '/teacher/projects/p-up/versions/v-up',
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
import { SMOKE_DRILL_READ_ONLY } from '@/components/staff/projects/ExecutableTask';
import { STARTING_CHANGE_MEETS_FLOOR } from '@/components/staff/projects/maintenance/maintenance-builder-model';
import { STARTING_RUNBOOK_MEETS_FLOOR } from '@/components/staff/projects/deployment/deployment-builder-model';
// The Files tab's sentence when the App preview is not offered.
import { APP_PREVIEW_NOT_OFFERED_SENTENCE } from '@/components/staff/projects/ProjectFiles';
import { settle, typeInto } from './support/dom';
import { phaseSetFor } from './support/phase-set';

const MARKER = 'SEALED-MOUNT-MARKER-0b7d';

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

function task(over: Partial<DraftTaskView> & { executable?: ExecutableTaskView } = {}): DraftTaskView {
  return {
    taskKey: 'main',
    order: 1,
    required: true,
    title: 'Build the shelf API',
    brief: 'Make the shelf lend books.',
    artefactType: 'code',
    artefactPath: null,
    checkKind: 'code',
    rubric: { passThreshold: DEFAULT_PASS_THRESHOLD, criteria: [] },
    objectives: [],
    owns: ['api/app.py'],
    authorable: true,
    notice: null,
    ...over,
  } as DraftTaskView;
}

function phase(over: Partial<DraftPhaseView>): DraftPhaseView {
  return {
    key: 'implementation',
    order: 3,
    title: 'Implementation',
    intro: 'Build it.',
    artifactKind: 'code',
    checkKind: 'code',
    tasks: [task()],
    blocksPublish: false,
    ...over,
  };
}

function version(withExecutable: boolean): DraftVersionView {
  return {
    projectId: 'p-up',
    versionId: 'v-up',
    version: '0.1.0',
    status: 'draft',
    slug: 'books-on-a-shelf',
    title: 'Books on a shelf',
    tagline: '',
    description: '',
    platformOwned: false,
    editable: true,
    phases: [
      phase({ tasks: [task(withExecutable ? { executable: EXEC } : {})] }),
      phase({
        key: 'deployment',
        order: 5,
        title: 'Deployment',
        artifactKind: 'config',
        checkKind: 'config',
        tasks: [task({ title: 'Ship it', artefactType: 'runbook', checkKind: 'config' })],
      }),
    ],
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-01T00:00:00.000Z',
    phaseSet: phaseSetFor(['implementation', 'deployment'], true),
  } as DraftVersionView;
}

const DEEP = {
  versionId: 'v-up',
  status: 'not-run' as const,
  current: false,
  contentDigest: null,
  checks: DEEP_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pending' as const, sentence: 'Not run.', phaseKey: null, taskKey: null })),
  costWarning: { microVMs: 13, sentence: deepValidationCostWarning(13) },
  startedAt: null,
  finishedAt: null,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  deepValidation.mockResolvedValue(DEEP);
});

afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;


async function mount(withExecutable: boolean) {
  draft.mockResolvedValue(version(withExecutable));
  await act(async () => {
    root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
  });
  await settle(6);
}

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/* ============ the executable editor's refusals and re-reads ============ */

describe('the executable editor says a refusal once and keeps the newest draft', () => {
  const alerts = (sentence: string) =>
    [...document.querySelectorAll('[role="alert"]')].filter((one) => one.textContent?.includes(sentence)).length;

  async function sealHidden(name: string) {
    const input = byId('sealed-hidden-api-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([MARKER], name)] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const path = byId('sealed-hidden-api-path') as HTMLInputElement;
    await act(async () => {
      typeInto(path, name);
    });
    await click('sealed-hidden-api-upload');
  }

  // The editor's own notice carries the refusal.
  it('a seal whose draft re-read fails says so once', async () => {
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 });
    await mount(true);
    const { ApiError } = await import('@/lib/api');
    draft.mockRejectedValue(new ApiError(503, 'The draft could not be read.'));
    await click('exec-edit-open');
    await sealHidden('test_more.py');
    await settle(6);
    // Implementation is the three-step builder's (spec 5.3): the re-read is the editor's own, so the page says it, once.
    expect(byId('project-task-error')?.textContent).toContain('The draft could not be read');
    expect(alerts('The draft could not be read')).toBe(1);
    expect(byId('exec-error')).toBeNull();
  });

  it('a refused save says so once', async () => {
    const { ApiError } = await import('@/lib/api');
    updateTask.mockRejectedValue(new ApiError(400, 'That brief is refused.'));
    await mount(true);
    await click('exec-edit-open');
    await click('exec-save');
    await settle(6);
    expect(byId('exec-error')?.textContent).toContain('That brief is refused.');
    expect(alerts('That brief is refused.')).toBe(1);
    expect(byId('project-task-error')).toBeNull();
  });

  it('a refusal said in the editor is not lost when the editor is closed', async () => {
    const { ApiError } = await import('@/lib/api');
    updateTask.mockRejectedValue(new ApiError(400, 'That brief is refused.'));
    await mount(true);
    await click('exec-edit-open');
    await click('exec-save');
    await settle(6);
    await click('exec-cancel');
    expect(alerts('That brief is refused.')).toBe(1);
    // The builder's step 2 keeps the refusal on its card once the editor is closed.
    expect(byId('tdi-code-error')?.textContent).toContain('That brief is refused.');
    expect(byId('project-task-error')).toBeNull();
  });

  // The add-task form beside the open executable editor.
  it('a refused save says so once while the add-task form is open beside the editor', async () => {
    const { ApiError } = await import('@/lib/api');
    updateTask.mockRejectedValue(new ApiError(400, 'That brief is refused.'));
    await mount(true);
    await click('exec-edit-open');
    await click('project-add-task');
    await click('exec-save');
    await settle(6);
    expect(byId('exec-error')?.textContent).toContain('That brief is refused.');
    expect(alerts('That brief is refused.')).toBe(1);
    expect(byId('task-form-error')).toBeNull();
  });

  // A refusal that is not the executable editor's is said on the page, not in its box.
  it('a failed check run while the executable editor is open is said on the page, not as the editor’s', async () => {
    const { ApiError } = await import('@/lib/api');
    validate.mockRejectedValue(new ApiError(503, 'The checks are away.'));
    await mount(true);
    await click('exec-edit-open');
    await click('project-validate');
    await settle(6);
    expect(alerts('The checks are away.')).toBe(1);
    expect(byId('project-task-error')?.textContent).toContain('The checks are away.');
    expect(byId('exec-error')).toBeNull();
  });

  // Two seals back to back; the first re-read lands last and must not win.
  it('two seals in quick succession: only the latest draft re-read applies', async () => {
    const withHidden = (extra: string, budget: number): DraftVersionView => {
      const shaped = version(true);
      shaped.phases[0] = phase({
        tasks: [
          task({
            executable: {
              ...EXEC,
              sandboxBudget: budget,
              runs: [{ ...EXEC.runs[0], hidden: [...EXEC.runs[0].hidden, { path: 'test_more.py', sha256: extra.repeat(64), bytes: 9 }] }],
            },
          }),
        ],
      });
      return shaped;
    };
    let first!: (view: DraftVersionView) => void;
    let second!: (view: DraftVersionView) => void;
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'e'.repeat(64), bytes: 9 });
    await mount(true);
    draft
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }));
    await click('exec-edit-open');
    await sealHidden('test_more.py');
    await settle(6);
    await sealHidden('test_more.py');
    await settle(6);
    expect(draft).toHaveBeenCalledTimes(3);

    // The newer read answers first, then the older one.
    await act(async () => second(withHidden('e', 9)));
    await settle(6);
    await act(async () => first(withHidden('a', 11)));
    await settle(6);

    await click('exec-cancel');
    expect(byId('exec-summary')?.textContent).toContain('e'.repeat(64));
    expect(byId('exec-summary')?.textContent).not.toContain('a'.repeat(64));
    // The newer draft's count (9) fits the per-phase ceiling; the older one's (11) would not.
    expect(byId('project-budget-refusal-0')).toBeNull();
    expect(document.body.innerHTML).not.toContain(MARKER);
  });

  // A re-read that finds the phase not editable any more closes the
  // editor's draw; its refusal must then be said on the page, not lost, and the summary returns.
  it('a refusal is still said once when a re-read makes the draft read-only under the open editor', async () => {
    const { ApiError } = await import('@/lib/api');
    updateTask.mockRejectedValue(new ApiError(400, 'That brief is refused.'));
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 });
    await mount(true);
    await click('exec-edit-open');
    await click('exec-save');
    await settle(6);
    expect(alerts('That brief is refused.')).toBe(1);
    draft.mockResolvedValue({ ...version(true), editable: false });
    await sealHidden('test_more.py');
    await settle(6);
    expect(byId('exec-editor')).toBeNull();
    expect(alerts('That brief is refused.')).toBe(1);
    // The builder's step 2, read-only now, keeps the refusal on its card beside the summary.
    expect(byId('tdi-code-error')?.textContent).toContain('That brief is refused.');
    expect(byId('exec-summary')).not.toBeNull();
  });
});

/* ============ the version-level ceiling ============ */

describe('the version-level ceiling in the editor', () => {
  // The version's total against BUDGET_CEILING.perVersion.
  it('a version over 24 microVMs shows the version-level ceiling sentence', async () => {
    const big = version(true);
    big.phases = [
      phase({ tasks: [task({ executable: { ...EXEC, sandboxBudget: 10 } })] }),
      phase({
        key: 'testing',
        order: 4,
        title: 'Testing',
        artifactKind: 'tests',
        checkKind: 'tests',
        tasks: [task({ artefactType: 'tests', checkKind: 'tests', executable: { ...EXEC, checkKind: 'tests', artefactType: 'tests', sandboxBudget: 10 } })],
      }),
      phase({
        key: 'maintenance',
        order: 6,
        title: 'Maintenance',
        tasks: [task({ executable: { ...EXEC, sandboxBudget: 5 } })],
      }),
    ];
    draft.mockResolvedValue(big);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    const said = [...document.querySelectorAll('[data-testid^="project-budget-refusal-"]')].map((one) => one.textContent);
    expect(said).toEqual([budgetCeilingRefusal(25, null)]);
    expect(byId('project-budget-line')?.textContent).toContain(`of at most ${BUDGET_CEILING.perVersion} for a version`);
    // Every phase is priced on the view, so the count is exact and needs no qualifier.
    expect(byId('project-budget-note')).toBeNull();
  });

  it('a version within the ceiling names its total and draws no refusal', async () => {
    const fits = version(true);
    fits.phases[0] = phase({ tasks: [task({ executable: { ...EXEC, sandboxBudget: 4 } })] });
    draft.mockResolvedValue(fits);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    expect(document.querySelectorAll('[data-testid^="project-budget-refusal-"]').length).toBe(0);
    // The total is named (here beside a deployment phase, as the phases shown).
    expect(byId('project-budget-note')?.textContent).toContain('boot 4 microVMs in all');
  });

  /* A deployment phase carries no microVM count on the
   * draft view, so beside one the editor never claims a full pass or a version refusal. */
  const withDeployment = (impl: number, testing: number, maintenance: number): DraftVersionView => {
    const shaped = version(true);
    shaped.phases = [
      phase({ tasks: [task({ executable: { ...EXEC, sandboxBudget: impl } })] }),
      phase({
        key: 'testing',
        order: 4,
        title: 'Testing',
        artifactKind: 'tests',
        checkKind: 'tests',
        tasks: [task({ artefactType: 'tests', checkKind: 'tests', executable: { ...EXEC, checkKind: 'tests', artefactType: 'tests', sandboxBudget: testing } })],
      }),
      shaped.phases[1],
      phase({ key: 'maintenance', order: 6, title: 'Maintenance', tasks: [task({ executable: { ...EXEC, sandboxBudget: maintenance } })] }),
    ];
    return shaped;
  };

  async function mountDraft(view: DraftVersionView) {
    draft.mockResolvedValue(view);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
  }

  it('a TaskTrackr-shaped draft (4/10/4 beside deployment) never says one full pass boots 18', async () => {
    await mountDraft(withDeployment(4, 10, 4));
    expect(byId('project-budget')).not.toBeNull();
    expect(document.body.textContent).not.toContain('One full pass boots 18');
    expect(byId('project-budget-line')?.textContent).not.toContain('for a version');
    expect(byId('project-budget-note')?.textContent).toContain('The coding and testing phases shown here boot 18 microVMs in all.');
    expect(document.querySelectorAll('[data-testid^="project-budget-refusal-"]').length).toBe(0);
  });

  it('code and tests at 23 beside deployment draw no version refusal at a partial count', async () => {
    await mountDraft(withDeployment(10, 10, 3));
    expect(document.body.textContent).not.toContain(budgetCeilingRefusal(23, null));
    expect(document.querySelectorAll('[data-testid^="project-budget-refusal-"]').length).toBe(0);
    expect(byId('project-budget-over')).toBeNull();
    expect(byId('project-budget-note')?.textContent).toContain('boot 23 microVMs in all');
  });

  it('phases shown already over 24 beside deployment say so without a count publish would not name', async () => {
    await mountDraft(withDeployment(10, 10, 5));
    expect(document.body.textContent).not.toContain(budgetCeilingRefusal(25, null));
    expect(byId('project-budget-over')?.textContent).toContain(
      `already boot 25 microVMs, and a version may boot at most ${BUDGET_CEILING.perVersion}`,
    );
  });

  // The editor can remove neither a run
  // (draft.ts refuses it) nor a mutant (no sealed delete door; MutantsEditor only adds or
  // replaces), so the over notice names the one remedy there is: upload again.
  it('the over notice names the remedy there is: upload the project again with fewer runs or mutants', async () => {
    await mountDraft(withDeployment(10, 10, 5));
    const over = byId('project-budget-over')?.textContent ?? '';
    expect(over).toContain('Upload the project again with fewer runs or mutants.');
    expect(over).not.toContain('Remove mutants here');
    expect(over).not.toContain('Remove runs or mutants');
  });

  // The note names the smoke check only beside a config (deployment) phase,
  // and never claims a drill the draft view cannot see.
  it('beside an unpriced code phase and no config phase, the note names no smoke check or drill', async () => {
    const shaped = version(true);
    shaped.phases = [
      phase({ tasks: [task({ executable: { ...EXEC, sandboxBudget: 4 } })] }),
      // A code phase whose executable view was refused: publish prices it, the view cannot.
      phase({ key: 'maintenance', order: 6, title: 'Maintenance', tasks: [task()] }),
    ];
    await mountDraft(shaped);
    const note = byId('project-budget-note')?.textContent ?? '';
    expect(note).toContain('boot 4 microVMs in all');
    expect(note).toContain('Publish counts every phase again');
    expect(note).not.toMatch(/smoke|drill/i);
  });

  it('beside a config deployment phase the note names its smoke check, and a drill only as possible', async () => {
    await mountDraft(withDeployment(4, 10, 4));
    const note = byId('project-budget-note')?.textContent ?? '';
    expect(note).toContain('the deployment smoke check');
    expect(note).not.toContain('smoke check and drill included');
  });

  /* A deployment phase with a runbook says whether it drills, so
   * it is priced as publish prices it (`sandboxBudgetFor`: the smoke check, and
   * the drill when there is one), and Validate leads with the full pass that
   * publish's receipt repeats, in the same unit. */
  const withRunbook = (drill: boolean): DraftVersionView => {
    const shaped = withDeployment(2, 2, 2);
    const deployment = shaped.phases.find((one) => one.key === 'deployment')!;
    deployment.tasks = deployment.tasks.map((one) => ({ ...one, runbook: { drill } as never }));
    return shaped;
  };

  it('a deployment phase with a runbook and a drill is priced at 2, and the full pass leads the line', async () => {
    await mountDraft(withRunbook(true));
    const line = byId('project-budget-line')?.textContent ?? '';
    expect(line.startsWith(`One full pass boots 8 microVMs of at most ${BUDGET_CEILING.perVersion} for a version.`)).toBe(true);
    expect(line).toContain('Deployment boots 2 microVMs of at most');
    expect(byId('project-budget-note')).toBeNull();
  });

  it('without a drill the deployment phase is priced at 1', async () => {
    await mountDraft(withRunbook(false));
    expect(byId('project-budget-line')?.textContent).toContain('One full pass boots 7 microVMs');
    expect(byId('project-budget-line')?.textContent).toContain('Deployment boots 1 microVM of at most');
  });

  it('the page has one trail, the top bar\'s; no in-page "Your classes" crumb', async () => {
    await mountDraft(withRunbook(true));
    expect(document.body.textContent).not.toContain('Your classes');
  });
});

/* ============ the Files tab on an own application ============ */

describe('the Files tab and the App preview', () => {
  const ROWS = [{ id: 'f-1', path: 'api/app.py', role: 'workspace', size: 10, content: 'x = 1', phaseKey: null }];

  /** An application phase's provenance: the reference's application, or (null) not. */
  const provenanceOf = (key: string, application: string | null): DraftPhaseView['provenance'] => ({
    phaseKey: key as DraftPhaseView['key'],
    referenceName: 'TaskTrackr',
    rollup: application === null ? 'own' : 'reference',
    intro: application === null ? 'own' : 'reference',
    interview: null,
    files: [],
    tasks: [],
    roomTask: 'none',
    application,
  });

  async function openFiles(view: DraftVersionView) {
    draft.mockResolvedValue(view);
    files.mockResolvedValue(ROWS);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    await click('project-files-open');
    await settle(6);
    expect(byId('project-files')).not.toBeNull();
  }

  it('the Files tab of an own project says the preview is not offered', async () => {
    const own = version(true);
    own.phases = own.phases.map((one) => ({ ...one, provenance: provenanceOf(one.key, null) }));
    await openFiles(own);
    expect(byId('project-files-preview-not-offered'), 'no preview sentence on the Files tab').not.toBeNull();
    expect(byId('project-files-preview-not-offered')?.textContent).toBe(APP_PREVIEW_NOT_OFFERED_SENTENCE);
    expect(APP_PREVIEW_NOT_OFFERED_SENTENCE).toMatch(/App preview/);
    expect(APP_PREVIEW_NOT_OFFERED_SENTENCE).toMatch(/this release/);
  });

  it('a TaskTrackr copy’s Files tab is unchanged', async () => {
    const copy = { ...version(false), platformOwned: false };
    copy.phases = copy.phases.map((one) => ({ ...one, provenance: provenanceOf(one.key, 'TaskTrackr') }));
    await openFiles(copy);
    expect(byId('project-files-preview-not-offered')).toBeNull();
    expect(byId('project-files')?.textContent).not.toMatch(/App preview/);
    // A payload with no provenance at all reads as the reference, too.
    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    await openFiles(version(false));
    expect(byId('project-files-preview-not-offered')).toBeNull();
  });
});

describe('the executable surfaces in the editor', () => {
  it('draw nothing executable on a draft without an executable view, and read no deep validation', async () => {
    await mount(false);
    expect(byId('exec-summary')).toBeNull();
    expect(byId('deep-validation')).toBeNull();
    expect(byId('project-budget')).toBeNull();
    expect(deepValidation).not.toHaveBeenCalled();
  });

  it('draw the summary with digests only, the ceiling naming the phase and the count, and deep validation', async () => {
    await mount(true);
    expect(byId('exec-summary')?.textContent).toContain('b'.repeat(64));
    expect(byId('project-budget-refusal-0')?.textContent).toBe(budgetCeilingRefusal(11, 'Implementation'));
    expect(byId('deep-validation')).not.toBeNull();
    expect(deepValidation).toHaveBeenCalledWith('p-up', 'v-up');
  });

  it('saves the executable task through the task door and seals through sealed.write', async () => {
    updateTask.mockResolvedValue({ phase: version(true).phases[0], validation: null });
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 });
    await mount(true);
    await click('exec-edit-open');
    expect(byId('exec-editor')).not.toBeNull();

    const input = byId('sealed-hidden-api-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([MARKER], 'test_more.py')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('sealed-hidden-api-upload');
    await settle(6);
    expect(writeSealed).toHaveBeenCalledWith('p-up', 'v-up', 'implementation', 'main', {
      role: 'hidden',
      runId: 'api',
      // A hidden test chosen by its bare name is offered tests/<name>.
      path: 'tests/test_more.py',
      contentBase64: btoa(MARKER),
    });
    expect(document.body.innerHTML).not.toContain(MARKER);
    // The sealed write voids the stored run, so it is read again.
    expect(deepValidation).toHaveBeenCalledTimes(2);

    await click('exec-save');
    await settle(6);
    expect(updateTask).toHaveBeenCalledTimes(1);
    const [, , phaseKey, taskKey, body] = updateTask.mock.calls[0] as [string, string, string, string, Record<string, unknown>];
    expect(phaseKey).toBe('implementation');
    expect(taskKey).toBe('main');
    // `owns` is the upload's and is not sent; the brief is the builder's Brief step's (spec 5.3).
    expect(body).toHaveProperty('runs');
    expect(body).not.toHaveProperty('brief');
    expect(body).not.toHaveProperty('owns');
  });

  // A sealed write changes the draft (its files,
  // its microVM count, its fast report) so the draft is read again, and what
  // the editor draws after it is closed is the server's, not the old view.
  it('reads the draft again after a seal, so the closed editor shows the new digest and the new ceiling', async () => {
    const before = version(true);
    before.phases[0] = phase({ tasks: [task({ executable: { ...EXEC, sandboxBudget: 10 } })] });
    const after = version(true);
    after.phases[0] = phase({
      tasks: [
        task({
          executable: {
            ...EXEC,
            sandboxBudget: 11,
            runs: [
              {
                ...EXEC.runs[0],
                hidden: [...EXEC.runs[0].hidden, { path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 }],
              },
            ],
          },
        }),
      ],
    });
    draft.mockResolvedValueOnce(before).mockResolvedValue(after);
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 });
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    expect(byId('project-budget-refusal-0')).toBeNull();

    await click('exec-edit-open');
    const input = byId('sealed-hidden-api-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([MARKER], 'test_more.py')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('sealed-hidden-api-upload');
    await settle(6);
    expect(draft).toHaveBeenCalledTimes(2);

    await click('exec-cancel');
    expect(byId('exec-summary')?.textContent).toContain('d'.repeat(64));
    expect(byId('project-budget-refusal-0')?.textContent).toBe(budgetCeilingRefusal(11, 'Implementation'));
    expect(document.body.innerHTML).not.toContain(MARKER);
  });

  it('says the deployment smoke and drill are read-only', async () => {
    await mount(true);
    await click('project-phase-tab-deployment');
    expect(byId('smoke-drill-read-only')?.textContent).toBe(SMOKE_DRILL_READ_ONLY);
    // The sentence also shows on TaskTrackr and on a
    // copy of it, which were never uploaded, so it claims no upload.
    expect(SMOKE_DRILL_READ_ONLY).not.toMatch(/was uploaded from/);
  });

  // Deep validation answers its owner only, so the
  // panel is drawn only where Export is, never on TaskTrackr's read-only page,
  // nor on a draft the caller may only look at.
  it('draws no deep validation on a platform-owned version, nor on a draft the caller may not change', async () => {
    const platform = { ...version(true), platformOwned: true, editable: false };
    draft.mockResolvedValue(platform);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    expect(byId('exec-summary')).not.toBeNull();
    expect(byId('deep-validation')).toBeNull();

    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    draft.mockResolvedValue({ ...version(true), editable: false });
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    expect(byId('exec-summary')).not.toBeNull();
    expect(byId('deep-validation')).toBeNull();
    expect(deepValidation).not.toHaveBeenCalled();
  });

  it('offers Export to the owner of the draft', async () => {
    await mount(false);
    expect(byId('project-export')).not.toBeNull();
  });
});

/* ============ Maintenance built in steps, and a refused conversion ============ */

describe('the Maintenance builder in the editor', () => {
  const TICKET = { id: 'CHG-1', title: 'Shelve by surname', summary: 's', acceptance: [{ id: 'AC-1', line: 'a' }] };
  const NO_FLOOR = { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false };

  /** The draft with a Maintenance phase whose code task is `over`. */
  function withMaintenance(over: Partial<DraftTaskView>): DraftVersionView {
    const shaped = version(false);
    shaped.phases.push(
      phase({
        key: 'maintenance',
        order: 6,
        title: 'Maintenance',
        tasks: [task({ title: 'Shelve by surname', executable: EXEC, ...over })],
      }),
    );
    return shaped;
  }

  async function open(shaped: DraftVersionView, tab: string) {
    draft.mockResolvedValue(shaped);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    await click(`project-phase-tab-${tab}`);
    await settle(6);
  }

  it('mounts the builder once, and the generic executable summary and editor are not drawn beside it', async () => {
    await open(withMaintenance({ change: { ticket: TICKET, contract: false, floor: NO_FLOOR } }), 'maintenance');
    expect(document.querySelectorAll('[data-testid="maintenance-builder"]')).toHaveLength(1);
    const summaries = [...document.querySelectorAll('[data-testid="exec-summary"]')];
    expect(summaries).toHaveLength(1);
    expect(byId('tdm-code')?.contains(summaries[0])).toBe(true);
    expect(byId('exec-edit-open')).toBeNull();
  });

  it("a seal from step 3 goes through sealed.write and the editor reads the draft again", async () => {
    writeSealed.mockResolvedValue({ path: 'test_more.py', sha256: 'd'.repeat(64), bytes: 9 });
    await open(withMaintenance({ change: { ticket: TICKET, contract: false, floor: NO_FLOOR } }), 'maintenance');
    expect(draft).toHaveBeenCalledTimes(1);
    await click('tdm-code-edit');
    const input = byId('sealed-hidden-api-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([MARKER], 'test_more.py')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('sealed-hidden-api-upload');
    await settle(6);
    expect(writeSealed).toHaveBeenCalledWith('p-up', 'v-up', 'maintenance', 'main', expect.objectContaining({ role: 'hidden', runId: 'api' }));
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it('reads the starting change request with the file rows and says its warning above Publish, which stays a warning', async () => {
    files.mockResolvedValue([
      { path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(EMPTY_CHANGE_REQUEST), editable: true, ownerKind: 'phase', phaseKey: 'maintenance' },
    ]);
    // Opened on another phase's tab: the editor reads the record itself, not only through the builder.
    draft.mockResolvedValue(withMaintenance({ change: { ticket: TICKET, contract: false, floor: NO_FLOOR } }));
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    expect(byId('maintenance-builder')).toBeNull();
    expect(byId('project-publish-warnings')?.textContent).toContain(STARTING_CHANGE_MEETS_FLOOR);
  });

  it('a Maintenance conversion that would refuse is said above the generic panels, in the API sentence', async () => {
    const reason = 'The CHANGELOG.md of this phase does not read as a change request, so it cannot be converted.';
    await open(withMaintenance({ recordOlderFormat: true, recordConversionRefused: reason }), 'maintenance');
    expect(byId('maintenance-builder')).toBeNull();
    expect(byId('tdm-conversion-refused')?.textContent).toBe(reason);
    expect(byId('tdm-conversion-refused')?.getAttribute('role')).toBe('note');
  });

  it('reads the starting runbook with the file rows and hands its warning to Publish, which stays a warning', async () => {
    files.mockResolvedValue([
      { path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK), editable: true, ownerKind: 'phase', phaseKey: 'deployment' },
    ]);
    const shaped = version(false);
    const floor = { minEnvironment: 0, minHealth: 0, minRollback: 0, minData: 0, requireIncident: false };
    shaped.phases[1] = { ...shaped.phases[1], tasks: [task({ title: 'Ship it', artefactType: 'runbook', checkKind: 'config', runbook: { record: RUNBOOK_JSON, floor, drill: false } })] };
    // Opened on another phase's tab: the editor reads the record itself, not only through the builder.
    draft.mockResolvedValue(shaped);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    expect(byId('project-publish-warnings')?.textContent).toContain(STARTING_RUNBOOK_MEETS_FLOOR);
  });

  it('a Deployment conversion that would refuse is said above the generic panels, in the API sentence', async () => {
    const reason = 'The RUNBOOK.md of this phase does not read as a runbook, so it cannot be converted.';
    const shaped = version(false);
    shaped.phases[1] = { ...shaped.phases[1], tasks: [task({ title: 'Ship it', artefactType: 'runbook', checkKind: 'config', recordOlderFormat: true, recordConversionRefused: reason })] };
    await open(shaped, 'deployment');
    expect(byId('deployment-builder')).toBeNull();
    expect(byId('tdp-conversion-refused')?.textContent).toBe(reason);
    // A phase that converts, or has nothing to convert, says nothing.
    await click('project-phase-tab-implementation');
    expect(byId('tdp-conversion-refused')).toBeNull();
    expect(byId('tdm-conversion-refused')).toBeNull();
  });
});

/* ======================== the plain-text notes ======================== */

describe("a draft's plain-text notes in the editor", () => {
  it('the editor draws a draft\'s plain-text notes on the phase each names', async () => {
    const shaped = version(false);
    const notes = [
      markdownKeptWarning('Implementation', ['brief', 'objectives']),
      markupOnlyWarning('Implementation', ['brief']),
      htmlCommentWarning('Implementation', ['brief']),
      markdownKeptWarning('Deployment', ['task title']),
    ];
    shaped.plainTextConversion = { notes };
    draft.mockResolvedValue(shaped);
    await act(async () => {
      root?.render(<ProjectEditor projectId="p-up" versionId="v-up" />);
    });
    await settle(6);
    const drawn = () => [...document.querySelectorAll('[data-testid="project-plain-text-note"]')].map((one) => [one.textContent, one.getAttribute('role')]);
    // a text that held only markup is drawn on its phase too, after the phase's markdown note
    expect(drawn()).toEqual([
      [notes[0], 'note'],
      [notes[1], 'note'],
      [notes[2], 'note'],
    ]);
    await click('project-phase-tab-deployment');
    expect(drawn()).toEqual([[notes[3], 'note']]);
  });

  it('a draft never converted draws no note', async () => {
    await mount(false);
    expect(byId('project-plain-text-notes')).toBeNull();
    await click('project-phase-tab-deployment');
    expect(byId('project-plain-text-notes')).toBeNull();
  });
});
