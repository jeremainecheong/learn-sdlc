// @vitest-environment jsdom
/**
 * The teacher's project page shows one section at a time, and the
 * Projects pages take the class pages' width.
 *
 * - The row "Sections of this draft" is real tabs: Overview (the default),
 *   each phase the draft holds, Validate and Publish, in that order. The open
 *   one is in the address as `?section=`, read when the page opens, pushed by
 *   a press (or Enter or Space), and followed by Back. The arrow keys, Home
 *   and End move focus only (manual activation): they open nothing.
 * - Overview, Validate, Publish and the open phase stay mounted while another
 *   tab is open, so a form typed in, a run of the checks and its result
 *   outlive a visit elsewhere, and the Validate tab says when a run is in
 *   progress or has failures. Only the open phase's builder is mounted:
 *   opening another phase closes the open phase's forms.
 * - The phase's builder, task list and help sit at a reading measure
 *   (MEASURE) inside the wide page, and every scrolled-to place keeps a
 *   margin of the sticky bar's measured height.
 * - The phase tabs are the one control for the phase: there is no second row,
 *   and the phase panel always shows the tab that is selected.
 * - Every other way in opens its section first: the steps of the path, a
 *   validation row's link, an address with a fragment.
 * - Every recorded `data-testid` of these components is still drawn.
 */
import { repoFile } from './support/paths';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { closureText, moduleText, webSource } from './support/source-text';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_VALIDATION_CHECK_IDS,
  SUPPORTED_STACKS_SENTENCE,
  deepValidationCostWarning,
  summariseValidation,
  type DraftPhaseSetView,
  type DraftPhaseView,
  type DraftVersionView,
  type ExecutableTaskView,
  type PhaseKey,
  type ValidationReport,
} from '@learnsdlc/shared';

const draft = vi.fn();
const files = vi.fn();
const validate = vi.fn();
const deepValidation = vi.fn();
const get = vi.fn();
vi.mock('@/lib/api-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-projects')>()),
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    files: (...a: unknown[]) => files(...a),
    validate: (...a: unknown[]) => validate(...a),
    deepValidation: (...a: unknown[]) => deepValidation(...a),
    get: (...a: unknown[]) => get(...a),
    publish: vi.fn(),
    writeSealed: vi.fn(),
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
  useSession: () => ({ id: 'teacher-1', email: 'a@b.c', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));
// The real Link takes a hash-only click for the router; the editor's capture runs first and stops it.
const linkClicks = vi.fn();
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        linkClicks(href);
      }}
    >
      {children}
    </a>
  ),
}));

import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { DEEP_RECEIPT_CHECK_ID } from '@/components/staff/projects/ValidationReportPanel';
import { EDITOR_SECTION_KEYS, sectionFromSearch, sectionHref } from '@/components/staff/projects/editor-sections';
import { BAR_HEIGHT_VAR, BELOW_BAR, MEASURE, WIDE_PAGE } from '@/components/staff/projects/page-frame';
import { settle, typeInto } from './support/dom';

const held = (key: PhaseKey): DraftPhaseSetView => ({ key, state: 'held', removeSource: 'held', canRemove: true, canPutBack: false, canAdd: false, why: null });
const absent = (key: PhaseKey): DraftPhaseSetView => ({ key, state: 'absent', canRemove: false, canPutBack: false, canAdd: false, why: null });

const phase = (key: PhaseKey, order: number, title: string): DraftPhaseView =>
  ({ key, order, title, intro: '', artifactKind: 'quiz', checkKind: 'quiz', tasks: [], blocksPublish: false }) as unknown as DraftPhaseView;

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
const executablePhase = (key: PhaseKey, order: number, title: string): DraftPhaseView =>
  ({
    key, order, title, intro: '', artifactKind: 'code', checkKind: 'code', blocksPublish: false,
    tasks: [{
      taskKey: 'main', order: 1, required: true, title: `Build ${title}`, brief: 'Build it.', artefactType: 'code',
      artefactPath: null, checkKind: 'code', rubric: { passThreshold: 70, criteria: [] }, objectives: [],
      owns: ['api/app.py'], authorable: true, notice: null, executable: { ...EXEC },
    }],
  }) as unknown as DraftPhaseView;

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
    phases: [phase('requirements', 1, 'Requirements'), phase('design', 2, 'Design'), executablePhase('implementation', 3, 'Implementation')],
    validation: null,
    supportedStacks: { python: [], node: [], tools: [], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-17T00:00:00.000Z',
    phaseSet: [held('requirements'), held('design'), held('implementation'), absent('testing'), absent('deployment'), absent('maintenance')],
    ...over,
  };
}

const DEEP = {
  versionId: 'v-mine',
  status: 'not-run' as const,
  current: false,
  contentDigest: null,
  checks: DEEP_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pending' as const, sentence: 'Not run.', phaseKey: null, taskKey: null })),
  costWarning: { microVMs: 11, sentence: deepValidationCostWarning(11) },
  startedAt: null,
  finishedAt: null,
};

/** One failed row about Design, as the fast checks would answer. */
const FAILING: ValidationReport = summariseValidation('fast', '2026-11-17T00:00:00.000Z', [
  { id: 'phase-holds-one-task', label: 'One task per phase', status: 'failed', sentence: 'Design holds no task.', phaseKey: 'design', taskKey: null, files: [] },
  { id: 'title-present', label: 'A title', status: 'passed', sentence: 'The project has a title.', phaseKey: null, taskKey: null, files: [] },
]);

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const panel = (key: string) => host.querySelector<HTMLElement>(`[data-project-section="${key}"]`);
/** The double frame the editor waits for before it moves focus. */
const frames = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 5));
  });
};
const press = async (id: string) => {
  const el = q(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
};
const mount = async (view: DraftVersionView = version()) => {
  draft.mockResolvedValue(view);
  await act(async () => root.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />));
  await settle(6);
};
const selected = () => [...host.querySelectorAll('[role="tab"][aria-selected="true"]')].map((one) => one.getAttribute('data-testid'));
const openPanels = () => [...host.querySelectorAll<HTMLElement>('[data-project-section]')].filter((one) => !one.hidden).map((one) => one.getAttribute('data-project-section'));
function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLInputElement;
  typeInto(node, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  draft.mockReset();
  files.mockReset();
  files.mockResolvedValue([]);
  validate.mockReset();
  deepValidation.mockReset();
  deepValidation.mockResolvedValue(DEEP);
  get.mockReset();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('the section tabs', () => {
  it('are Overview, each phase of the draft, Validate and Publish, in that order, with Overview open', async () => {
    await mount();
    const list = q('editor-nav')!.querySelector('[role="tablist"]')!;
    expect(list.getAttribute('aria-label')).toBe('Sections of this draft');
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    expect(tabs.map((one) => one.getAttribute('data-testid'))).toEqual([
      'project-section-overview',
      'project-section-requirements',
      'project-section-design',
      'project-section-implementation',
      'project-section-validate',
      'project-section-publish',
    ]);
    // A phase's tab says its title and its task count, as the phase row did.
    expect(tabs.map((one) => one.textContent)).toEqual(['Overview', 'Requirements0', 'Design0', 'Implementation1', 'Validate', 'Publish']);
    expect(selected()).toEqual(['project-section-overview']);
    expect(openPanels()).toEqual(['overview']);
    // One tab stop for the row.
    expect(tabs.map((one) => one.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1']);
  });

  it('point at their panels, and each panel names its tab back', async () => {
    await mount();
    for (const tab of host.querySelectorAll('[role="tab"]')) {
      const target = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(target, `${tab.getAttribute('data-testid')} controls nothing`).not.toBeNull();
      expect(target!.getAttribute('role')).toBe('tabpanel');
      expect(target!.hasAttribute('data-project-section')).toBe(true);
    }
    for (const key of ['overview', 'validate', 'publish']) {
      expect(document.getElementById(panel(key)!.getAttribute('aria-labelledby')!)).toBe(q(`project-section-${key}`));
    }
    // The phase panel is the scripts' `[role="tabpanel"]#project-phase-panel`, labelled by the phase it shows.
    const phasePanel = host.querySelector('[role="tabpanel"]#project-phase-panel')!;
    expect(phasePanel.getAttribute('data-project-section')).toBe('requirements');
    await press('project-section-design');
    expect(phasePanel.getAttribute('data-project-section')).toBe('design');
    expect(document.getElementById(phasePanel.getAttribute('aria-labelledby')!)).toBe(q('project-section-design'));
  });

  it('put each part under its own tab, every one mounted while hidden', async () => {
    get.mockResolvedValue({
      project: {
        id: 'p-mine', slug: 'room-desk', title: 'RoomDesk', platformOwned: false, mine: true, isDefault: false, origin: 'fork',
        publishedVersion: '1.0.0', publishedVersionId: 'v-mine', draftVersion: null, draftVersionId: null, cohortsUsing: 0,
        lastValidatedAt: null, createdAt: '2026-10-17T00:00:00.000Z',
      },
      versions: [],
    });
    await mount(version({ status: 'published', editable: false, version: '1.0.0' }));
    const where = (id: string) => q(id)?.closest('[data-project-section]')?.getAttribute('data-project-section') ?? 'header';
    expect(where('guide-rail')).toBe('overview');
    expect(where('project-next-draft')).toBe('overview');
    expect(where('project-advanced')).toBe('overview');
    expect(where('phases-card')).toBe('overview');
    expect(where('phases-card-readiness')).toBe('overview');
    expect(where('project-files-panel')).toBe('overview');
    expect(where('project-phases')).toBe('requirements');
    expect(where('deep-validation')).toBe('validate');
    expect(where('project-budget')).toBe('validate');
    expect(where('project-validation')).toBe('validate');
    expect(where('project-publish-panel')).toBe('publish');
    // What a teacher must see from every section is outside the sections.
    for (const id of ['project-status', 'project-preview-open', 'project-export', 'project-frozen', 'editor-save-status', 'project-live']) {
      expect(where(id), id).toBe('header');
    }
    expect(q('project-status')!.compareDocumentPosition(q('editor-nav')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Why the version is read-only is a notice, and the page's notices sit
    // under the tabs, so one appearing never moves the row.
    expect(q('editor-nav')!.compareDocumentPosition(q('project-frozen')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Mounted, and hidden.
    expect(panel('validate')!.hidden).toBe(true);
    expect(panel('publish')!.hidden).toBe(true);
    expect(panel('requirements')!.hidden).toBe(true);
    expect(panel('overview')!.hidden).toBe(false);
  });
});

describe('the address', () => {
  it('opens the section ?section= names, a phase among them, and Overview for a name it does not know', async () => {
    window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine?section=validate');
    await mount();
    expect(selected()).toEqual(['project-section-validate']);
    expect(openPanels()).toEqual(['validate']);
    act(() => root.unmount());

    root = createRoot(host);
    window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine?section=design');
    await mount();
    expect(selected()).toEqual(['project-section-design']);
    expect(panel('design')!.hidden).toBe(false);
    act(() => root.unmount());

    root = createRoot(host);
    window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine?section=somewhere');
    await mount();
    expect(selected()).toEqual(['project-section-overview']);
  });

  it('a phase the draft does not hold opens its first phase, and the address is put right without a history entry', async () => {
    window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine?section=testing');
    const before = window.history.length;
    await mount();
    expect(selected()).toEqual(['project-section-requirements']);
    expect(window.location.search).toBe('?section=requirements');
    expect(window.history.length).toBe(before);
  });

  it('a press pushes the section, the arrow keys move focus and write nothing, Overview leaves the address clean, and Back follows', async () => {
    await mount();
    const start = window.history.length;
    await press('project-section-publish');
    expect(window.location.search).toBe('?section=publish');
    expect(window.history.length).toBe(start + 1);
    // Manual activation: the arrow key moves focus to Validate and opens nothing.
    q('project-section-publish')!.focus();
    await act(async () => {
      fireEvent.keyDown(q('project-section-publish')!, { key: 'ArrowLeft' });
    });
    expect(document.activeElement).toBe(q('project-section-validate'));
    expect(selected()).toEqual(['project-section-publish']);
    expect(openPanels()).toEqual(['publish']);
    expect(window.location.search).toBe('?section=publish');
    expect(window.history.length).toBe(start + 1);
    await press('project-section-overview');
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(start + 2);
    // Back: the address names Validate again, and the tab follows it.
    await act(async () => {
      window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine?section=validate');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(selected()).toEqual(['project-section-validate']);
    expect(openPanels()).toEqual(['validate']);
  });

  it('reads and writes only `section`, keeping the rest of the address', () => {
    expect(sectionFromSearch('?section=publish&x=1')).toBe('publish');
    expect(sectionFromSearch('?section=maintenance')).toBe('maintenance');
    expect(sectionFromSearch('')).toBe('overview');
    expect(sectionHref('/teacher/projects/p/versions/v?x=1', 'design')).toBe('/teacher/projects/p/versions/v?x=1&section=design');
    expect(sectionHref('/teacher/projects/p/versions/v?section=design&x=1', 'overview')).toBe('/teacher/projects/p/versions/v?x=1');
    expect(EDITOR_SECTION_KEYS).toEqual(['overview', 'requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance', 'validate', 'publish']);
  });
});

describe('every old way in opens its section first', () => {
  it('"Take me there" on a step of the path opens Publish, Validate or the phase, and puts focus on the place', async () => {
    await mount();
    await press('guide-step-go-publish');
    await frames();
    expect(linkClicks).not.toHaveBeenCalled();
    expect(selected()).toEqual(['project-section-publish']);
    expect(document.activeElement).toBe(document.getElementById('guide-publish'));
    expect(window.location.search).toBe('?section=publish');

    await press('project-section-overview');
    await press('guide-step-go-deep-validate');
    await frames();
    expect(selected()).toEqual(['project-section-validate']);
    expect(document.activeElement).toBe(document.getElementById('guide-deep'));

    await press('project-section-overview');
    await press('guide-step-go-refine');
    await frames();
    // The phase last opened, the first one on a fresh page.
    expect(selected()).toEqual(['project-section-requirements']);
    expect(document.activeElement).toBe(document.getElementById('guide-refine'));
  });

  it('a step whose place is above the tabs is left to its link: nothing is switched', async () => {
    await mount();
    await press('guide-step-go-export');
    expect(linkClicks).toHaveBeenCalledWith('#guide-export');
    expect(selected()).toEqual(['project-section-overview']);
  });

  it("a validation row's link opens its phase's tab and lands in it", async () => {
    await mount(version({ validation: FAILING }));
    await press('project-section-validate');
    await press('project-goto-phase-holds-one-task-design');
    await frames();
    expect(selected()).toEqual(['project-section-design']);
    expect(openPanels()).toEqual(['design']);
    expect(document.getElementById('project-phase-panel')!.contains(document.activeElement)).toBe(true);
    expect(window.location.search).toBe('?section=design');
  });

  it('an address that arrives with a fragment opens the section holding it', async () => {
    window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-mine#guide-publish');
    await mount();
    await frames();
    expect(selected()).toEqual(['project-section-publish']);
    expect(window.location.search).toBe('?section=publish');
    expect(window.location.hash).toBe('');
  });
});

describe('what is in a section outlives a visit to another', () => {
  it('a form typed into in a phase is still open, with its words, after Validate and Overview', async () => {
    await mount();
    await press('project-section-design');
    await press('project-add-task');
    type(q('task-form-title'), 'A title not yet saved');
    await press('project-section-validate');
    expect(panel('design')!.hidden).toBe(true);
    expect(q<HTMLInputElement>('task-form-title')!.value).toBe('A title not yet saved');
    await press('project-section-overview');
    await press('project-section-design');
    expect(q<HTMLInputElement>('task-form-title')!.value).toBe('A title not yet saved');
    expect(panel('design')!.contains(q('task-form'))).toBe(true);
  });

  it('moving to another phase still closes the form, as the phase tabs always have', async () => {
    await mount();
    await press('project-section-design');
    await press('project-add-task');
    expect(q('task-form')).not.toBeNull();
    await press('project-section-requirements');
    expect(q('task-form')).toBeNull();
  });

  it('walking the tab row with the arrow keys leaves the open section and an open form alone; Enter opens the focused tab', async () => {
    await mount();
    await press('project-section-requirements');
    await press('project-add-task');
    type(q('task-form-title'), 'A quiz title not yet saved');
    await press('project-section-validate');
    const start = window.history.length;
    const search = window.location.search;
    // From Validate back to Requirements: Implementation, Design, Requirements on the way.
    q('project-section-validate')!.focus();
    for (const reached of ['implementation', 'design', 'requirements']) {
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
      });
      expect(document.activeElement).toBe(q(`project-section-${reached}`));
      // Nothing opened: Validate is still the open section, and the address and history are untouched.
      expect(selected()).toEqual(['project-section-validate']);
      expect(openPanels()).toEqual(['validate']);
      expect(window.location.search).toBe(search);
      expect(window.history.length).toBe(start);
      // The form typed into is still there, with its words.
      expect(q<HTMLInputElement>('task-form-title')?.value).toBe('A quiz title not yet saved');
    }
    // Home and End move focus to the ends, and open nothing either.
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'End' });
    });
    expect(document.activeElement).toBe(q('project-section-publish'));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    });
    expect(document.activeElement).toBe(q('project-section-overview'));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(q('project-section-requirements'));
    expect(selected()).toEqual(['project-section-validate']);
    // Enter is left to the button (not cancelled), whose own click opens the focused tab.
    let notCancelled = false;
    await act(async () => {
      notCancelled = fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    });
    expect(notCancelled).toBe(true);
    await act(async () => {
      fireEvent.click(document.activeElement!);
    });
    expect(selected()).toEqual(['project-section-requirements']);
    expect(window.location.search).toBe('?section=requirements');
    expect(window.history.length).toBe(start + 1);
    expect(q<HTMLInputElement>('task-form-title')?.value).toBe('A quiz title not yet saved');
  });

  it('a run of the checks started in Validate goes on while the teacher is elsewhere, and its tab says so', async () => {
    let answer: (report: ValidationReport) => void = () => undefined;
    validate.mockReturnValue(new Promise<ValidationReport>((done) => (answer = done)));
    await mount();
    await press('project-section-validate');
    await press('project-validate');
    await press('project-section-design');
    const mark = () => q('project-section-validate-mark');
    expect(mark()?.getAttribute('data-state')).toBe('running');
    // Read with the tab's name.
    expect(q('project-section-validate')!.textContent).toBe('Validate, Running');
    expect(validate).toHaveBeenCalledTimes(1);

    await act(async () => answer(FAILING));
    await settle(6);
    expect(mark()?.getAttribute('data-state')).toBe('failed');
    expect(q('project-section-validate')!.textContent).toBe('Validate, 1 failed');
    // The result is there when the teacher comes back, and the run was not asked again.
    await press('project-section-validate');
    expect(q('project-validation-counts')!.textContent).toContain('1 failed');
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('a deep validation in flight marks the tab as running, and a clean report leaves it unmarked', async () => {
    deepValidation.mockResolvedValue({ ...DEEP, status: 'running' });
    await mount();
    expect(q('project-section-validate-mark')?.getAttribute('data-state')).toBe('running');
    act(() => root.unmount());

    root = createRoot(host);
    deepValidation.mockResolvedValue(DEEP);
    await mount();
    expect(q('project-section-validate-mark')).toBeNull();
    expect(q('project-section-validate')!.textContent).toBe('Validate');
  });

  it('the Validate list reads the deep view the editor holds: a deep run that failed on these bytes reads Failed on its receipt row', async () => {
    // The API sends the receipt as an advisory on a draft; only the deep view
    // the editor read can say the run on these bytes failed.
    const receipt = { id: DEEP_RECEIPT_CHECK_ID, label: 'Deep validation is current for this phase', status: 'passed' as const,
      sentence: 'Testing has no current deep validation.', phaseKey: 'testing' as const, taskKey: null, files: [], advisory: 'warning' as const };
    validate.mockResolvedValue(summariseValidation('fast', '2026-11-17T00:00:00.000Z', [receipt]));
    deepValidation.mockResolvedValue({ ...DEEP, status: 'failed', current: true, contentDigest: 'now' });
    await mount();
    await press('project-section-validate');
    // The deep view is only handed over: reading it sends no run of the checks.
    expect(validate).not.toHaveBeenCalled();
    await press('project-validate');
    await settle(6);
    expect(validate).toHaveBeenCalledTimes(1);
    const row = q(`project-check-${DEEP_RECEIPT_CHECK_ID}-testing`);
    expect(row?.dataset.state).toBe('failed');
    expect(q(`project-state-word-${DEEP_RECEIPT_CHECK_ID}-testing`)?.textContent).toBe('Failed');
  });
});

describe('one control for the phase', () => {
  it('there is no second row of phase tabs, and the panel always shows the selected tab', async () => {
    await mount();
    expect(host.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(host.querySelector('[role="tablist"][aria-label="Phases"]')).toBeNull();
    for (const key of ['requirements', 'design', 'implementation'] as const) {
      expect(host.querySelectorAll(`[data-testid="project-phase-tab-${key}"]`)).toHaveLength(1);
      // The tab's test id presses the tab it sits in.
      await press(`project-phase-tab-${key}`);
      expect(selected()).toEqual([`project-section-${key}`]);
      const phasePanel = document.getElementById('project-phase-panel')!;
      expect(phasePanel.getAttribute('data-project-section')).toBe(key);
      expect(phasePanel.getAttribute('aria-labelledby')).toBe(q(`project-section-${key}`)!.id);
      expect(phasePanel.hidden).toBe(false);
    }
  });
});

const CSS_ESCAPE = (cls: string) => cls.replace(/[^\w-]/g, (c) => `\\${c}`);

describe('the phase tabs keep a reading measure inside the wide page', () => {
  const measured = (el: Element | null) => el?.closest(`[data-testid="project-phase-measure"]`) ?? null;

  it('every phase builder, the scenario editor, the task list and the executable task are drawn inside the measure', () => {
    // The phases a fixture here does not open (Testing, Deployment, Maintenance, an executable task) are read from
    // the editor's text, wherever the editor is split to.
    const source = closureText('ProjectEditor');
    const from = source.indexOf('data-testid="project-phase-measure"');
    const to = source.indexOf('{removing && phase && (');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    // The element carrying the test id is the one with the measure.
    expect(source.slice(source.lastIndexOf('<div', from), from)).toContain('${MEASURE}');
    const inside = source.slice(from, to);
    for (const part of [
      '<RequirementsBuilder', '<DesignBuilder', '<ImplementationBuilder', '<TestingBuilder', '<DeploymentBuilder',
      '<MaintenanceBuilder', '<PhaseScenario', '<PhaseTasks', '<ExecutableEditor', '<ExecutableSummary', '<SmokeDrillReadOnly',
    ]) {
      expect(inside, part).toContain(part);
    }
  });

  it("each phase's fields and task rows, as drawn, are inside it, and so is the quiz form", async () => {
    await mount();
    for (const key of ['requirements', 'design', 'implementation'] as const) {
      await press(`project-section-${key}`);
      const box = q('project-phase-measure')!;
      expect(box.className.split(' ')).toContain(MEASURE);
      expect(panel(key)!.contains(box)).toBe(true);
      // Everything the phase's section draws is inside the measure, but its one "Add a concept quiz" button.
      const all = [...q('project-phases')!.querySelectorAll('[data-testid]')];
      expect(all.filter((one) => !measured(one)).map((one) => one.getAttribute('data-testid')), key).toEqual(['project-add-task']);
      // ...and that is the phase's own editor: its scenario editor or its builder, and its task rows.
      expect(box.querySelectorAll(`[data-testid="phase-scenario-${key}"], [data-testid$="-builder"]`).length, key).toBeGreaterThan(0);
      for (const row of q('project-phases')!.querySelectorAll('[data-testid^="task-row-"], [data-testid="exec-summary"], textarea, input, select')) {
        expect(measured(row), `${key}: ${row.getAttribute('data-testid') ?? row.tagName}`).toBe(box);
      }
    }
    await press('project-section-design');
    await press('project-add-task');
    expect(q('task-form')!.closest(`.${CSS_ESCAPE(MEASURE)}`)).not.toBeNull();
  });
});

describe('the axe spec scans Validate and Publish by their address', () => {
  it('has a screen for each, on the draft and on the published version', () => {
    const spec = repoFile('e2e/a11y-axe.spec.ts');
    expect(spec).toContain("versions/${fx.publishedVersionId}?section=validate`, { ready: '[data-testid=\"project-validation\"]' })");
    expect(spec).toContain("versions/${fx.publishedVersionId}?section=publish`, { ready: '[data-testid=\"project-publish-panel\"]' })");
    expect(spec).toContain("`${editor(fx)}?section=validate`, { ready: '[data-testid=\"project-validation\"]' })");
    expect(spec).toContain("`${editor(fx)}?section=publish`, { ready: '[data-testid=\"project-publish-panel\"]' })");
  });
});

describe('a scrolled-to place lands below the sticky tab bar', () => {
  const PLACES = ['guide-export', 'guide-preview', 'guide-refine', 'guide-deep', 'editor-validate', 'guide-publish'];
  let barHeight = 57;
  let observed: Array<() => void> = [];
  // jsdom's own `offsetHeight`, put back after each test so later mounts in this file read what they always read.
  const ownOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  beforeEach(() => {
    barHeight = 57;
    observed = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          observed.push(this.callback);
        }
        disconnect() {
          observed = observed.filter((one) => one !== this.callback);
        }
        unobserve() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'editor-nav' ? barHeight : 0;
      },
    });
  });
  afterEach(() => {
    if (ownOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', ownOffsetHeight);
    else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    vi.unstubAllGlobals();
  });

  it("every place's margin is the bar's measured height plus a gap, and follows the bar when it wraps", async () => {
    expect(BELOW_BAR).toBe('scroll-mt-[calc(var(--editor-bar-h,0px)_+_16px)]');
    expect(BAR_HEIGHT_VAR).toBe('--editor-bar-h');
    await mount();
    const main = q('project-editor')!;
    expect(main.style.getPropertyValue(BAR_HEIGHT_VAR)).toBe('57px');
    // On a phone the nine tabs wrap to several lines: the bar grows, and the margin with it.
    barHeight = 190;
    await act(async () => {
      for (const callback of observed) callback();
    });
    expect(main.style.getPropertyValue(BAR_HEIGHT_VAR)).toBe('190px');
    for (const id of PLACES) {
      const place = document.getElementById(id);
      expect(place, id).not.toBeNull();
      expect(place!.className.split(' '), id).toContain(BELOW_BAR);
      // No fixed margin left beside it.
      expect(place!.className, id).not.toMatch(/scroll-mt-\d/);
    }
  });
});

describe('the width of the Projects pages', () => {
  it("is the class pages': 1440 px at most, with their side padding at each width", () => {
    const css = webSource('components/experience/experience.css');
    const block = (from: number) => css.slice(css.indexOf('.exp-page {', from), css.indexOf('}', css.indexOf('.exp-page {', from)));
    expect(block(0)).toMatch(/max-width: 1440px;/);
    expect(block(0)).toMatch(/padding: 30px 30px 55px;/);
    expect(css).toMatch(/@media \(max-width: 1050px\) \{\s*\.exp-page \{\s*padding: 27px 24px 45px;/);
    expect(css).toMatch(/@media \(max-width: 520px\) \{\s*\.exp-page \{\s*padding: 25px 16px 40px;/);
    expect(WIDE_PAGE.split(' ')).toEqual(expect.arrayContaining(['mx-auto', 'w-full', 'max-w-[1440px]', 'px-4', 'min-[521px]:px-6', 'min-[1051px]:px-[30px]']));
    expect(MEASURE).toBe('max-w-[852px]');
  });

  it('the list and the editor ask for it; the Teacher guide keeps its 900 px column', async () => {
    expect(closureText('ProjectsLibrary')).toMatch(/<main id="main" tabIndex=\{-1\} className=\{WIDE_PAGE\}/);
    expect(moduleText('ProjectsLibrary')).not.toMatch(/max-w-\[900px\]/);
    expect(closureText('TeacherGuide')).toMatch(/<main id="main" tabIndex=\{-1\} className="mx-auto flex min-w-0 max-w-\[900px\] flex-col gap-4 p-4 sm:p-6"/);
    await mount();
    expect(q('project-editor')!.className).toBe(WIDE_PAGE);
  });

  it("DocPage's frame is unchanged", () => {
    expect(closureText('DocPage')).toContain('<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3.5 p-4 sm:p-6">');
  });
});

/**
 * Every `data-testid` the teacher's Projects components draw, recorded from
 * their source (the `data-testid` and `testId` attributes and props of every file under `components/staff/projects/` and
 * `app/(app)/teacher/projects/`, string literals inside their expressions
 * included, single words dropped). A template keeps its `${…}` parts, which
 * match any expression now.
 */
const TEST_IDS_AT_F41A33A4 = [
  'budget-ceiling', 'deep-validation', 'deep-validation-cancel', 'deep-validation-check-${check.id}',
  'deep-validation-dialog', 'deep-validation-error', 'deep-validation-error-box', 'deep-validation-load-error',
  'deep-validation-open', 'deep-validation-reading', 'deep-validation-stale', 'deep-validation-start',
  'deep-validation-status', 'deep-validation-warning', 'deployment-builder', 'design-builder', 'editor-nav',
  'editor-nav-overview', 'editor-nav-phase-${one.key}', 'editor-nav-publish', 'editor-nav-validate',
  'editor-save-status', 'exec-budget-${phaseKey}', 'exec-cancel', 'exec-coverage', 'exec-edit-open', 'exec-editor',
  'exec-error', 'exec-error-box', 'exec-min-tests', 'exec-own-error', 'exec-owns', 'exec-run-${run.id}',
  'exec-run-${run.id}-label', 'exec-run-${run.id}-learner', 'exec-run-${run.id}-paths', 'exec-run-${run.id}-shape',
  'exec-run-${run.id}-visible', 'exec-save', 'exec-summary', 'exec-summary-run-${run.id}', 'file-replace-cancel',
  'file-replace-content', 'file-replace-dialog', 'file-replace-error', 'file-replace-note', 'file-replace-save',
  'file-replace-unread', 'implementation-builder', 'interview-cancel', 'interview-editor', 'interview-editor-error',
  'interview-fact-${index}', 'interview-fact-${index}-answer', 'interview-fact-${index}-id',
  'interview-fact-${index}-keywords', 'interview-fact-${index}-remove', 'interview-fact-${index}-topic',
  'interview-fact-add', 'interview-facts', 'interview-facts-expected', 'interview-max-turns', 'interview-opening',
  'interview-persona-name', 'interview-persona-role', 'interview-refusal', 'interview-save',
  'interview-unknown-reply', 'maintenance-builder', 'phase-application-${phase.key}',
  'phase-application-notice-${phase.key}', 'phase-file-${file.path}', 'phase-file-note-${file.path}',
  'phase-file-provenance-${file.path}', 'phase-file-replace-${file.path}', 'phase-files-${phase.key}',
  'phase-interview', 'phase-interview-edit', 'phase-interview-error', 'phase-interview-none',
  'phase-interview-persona', 'phase-interview-provenance', 'phase-interview-remove',
  'phase-interview-remove-confirm', 'phase-interview-remove-no', 'phase-interview-remove-yes',
  'phase-interview-topics', 'phase-interview-write', 'phase-intro-${phase.key}', 'phase-intro-cancel-${phase.key}',
  'phase-intro-edit-${phase.key}', 'phase-intro-error-${phase.key}', 'phase-intro-field-${phase.key}',
  'phase-intro-provenance-${phase.key}', 'phase-intro-save-${phase.key}', 'phase-provenance-${phase.key}',
  'phase-scenario-${phase.key}', 'phase-starter-${path}', 'phase-starter-provenance-${path}',
  'phase-starter-replace-${path}', 'phase-starters-${phase.key}', 'phases-add-${row.key}', 'phases-card',
  'phases-card-readiness', 'phases-confirm-line', 'phases-confirm-no', 'phases-confirm-yes', 'phases-error',
  'phases-putback-${row.key}', 'phases-remove-${row.key}', 'phases-row-${row.key}', 'phases-state-${row.key}',
  'phases-status', 'phases-upload-${row.key}', 'project-add-task', 'project-advanced', 'project-advanced-toggle',
  'project-budget', 'project-check-${rowId}', 'project-editor', 'project-error', 'project-export',
  'project-export-done', 'project-export-error', 'project-export-error-box', 'project-export-help',
  'project-file-${row.id}', 'project-file-content-${row.id}', 'project-file-notice-${row.id}',
  'project-file-open-${row.id}', 'project-files', 'project-files-empty', 'project-files-error',
  'project-files-loading', 'project-files-open', 'project-files-panel', 'project-files-preview-not-offered',
  'project-files-solution-mount', 'project-frozen', 'project-frozen-box', 'project-goto-${rowId}', 'project-live',
  'project-loading', 'project-new-draft', 'project-new-draft-archived', 'project-new-draft-error',
  'project-next-draft', 'project-next-draft-loading', 'project-next-draft-not-yours',
  'project-next-draft-not-yours-box', 'project-next-draft-note', 'project-next-draft-nothing',
  'project-next-draft-nothing-box', 'project-next-draft-open', 'project-next-draft-platform',
  'project-next-draft-platform-box', 'project-next-draft-withdrawn', 'project-phase-${phase.key}',
  'project-phase-empty-${phase.key}', 'project-phase-gate-${phase.key}', 'project-phase-gate-box-${phase.key}',
  'project-phase-gating-${phase.key}', 'project-phase-tab-${one.key}', 'project-phases', 'project-plain-text-note',
  'project-plain-text-notes', 'project-preview-open', 'project-publish', 'project-publish-blocking',
  'project-publish-confirm', 'project-publish-confirm-no', 'project-publish-confirm-yes', 'project-publish-error',
  'project-publish-notes', 'project-publish-panel', 'project-publish-reason', 'project-publish-version',
  'project-publish-warnings', 'project-published', 'project-rule-${rowId}', 'project-runtime-profile',
  'project-stacks', 'project-stacks-box', 'project-state-word-${rowId}', 'project-status', 'project-task-error',
  'project-validate', 'project-validation', 'project-validation-bar', 'project-validation-counts',
  'project-validation-empty', 'project-validation-skipped', 'project-validation-skipped-toggle',
  'project-validation-tier', 'projects-copy-${row.slug}', 'projects-default-${row.slug}', 'projects-empty',
  'projects-error', 'projects-facts-${row.slug}', 'projects-library', 'projects-library-empty', 'projects-list',
  'projects-loading', 'projects-new', 'projects-new-cancel', 'projects-new-error', 'projects-new-form',
  'projects-new-slug', 'projects-new-source', 'projects-new-submit', 'projects-new-title',
  'projects-open-${row.slug}', 'projects-platform-${row.slug}', 'projects-published-${row.slug}',
  'projects-row-${row.slug}', 'projects-upload', 'projects-upload-cancel', 'projects-upload-done',
  'projects-upload-error', 'projects-upload-file', 'projects-upload-finding-${at}', 'projects-upload-open',
  'projects-upload-open-draft', 'projects-upload-profile', 'projects-upload-profile-box', 'projects-upload-refusal',
  'projects-upload-refusal-detail', 'projects-upload-refusal-sentence', 'projects-upload-size',
  'projects-upload-submit', 'projects-upload-title', 'projects-upload-warning-${at}', 'projects-upload-warnings',
  'quiz-answer-count-${at}', 'quiz-answers-error', 'quiz-answers-open', 'quiz-answers-sealed', 'quiz-answers-show',
  'quiz-attempts', 'quiz-attempts-readout', 'quiz-concept-${at}', 'quiz-criterion', 'quiz-criterion-readout',
  'quiz-drawn', 'quiz-drawn-readout', 'quiz-editor', 'quiz-explanation-note-${at}', 'quiz-live',
  'quiz-option-${at}-${of}', 'quiz-option-add-${at}', 'quiz-option-correct-${at}-${of}',
  'quiz-option-remove-${at}-${of}', 'quiz-pass-mark', 'quiz-pass-mark-note', 'quiz-pass-mark-readout',
  'quiz-question-${at}', 'quiz-question-add', 'quiz-question-concept-${at}', 'quiz-question-down-${at}',
  'quiz-question-explanation-${at}', 'quiz-question-remove-${at}', 'quiz-question-stem-${at}',
  'quiz-question-up-${at}', 'quiz-reveal', 'quiz-reveal-${rule}', 'quiz-reveal-note', 'quiz-reveal-readout',
  'quiz-rubric-note', 'quiz-settings', 'quiz-shuffle', 'quiz-stem-${at}', 'quiz-summary', 'requirements-builder',
  'runbook-${list}-${at}', 'runbook-${list}-${at}-${key}', 'runbook-${list}-${at}-kind',
  'runbook-${list}-${at}-remove', 'runbook-${list}-${at}-summary', 'runbook-add-${list}', 'runbook-add-timeline',
  'runbook-check', 'runbook-check-${r.id}', 'runbook-checks', 'runbook-full-${list}', 'runbook-incident-${key}',
  'runbook-incident-from-drill', 'runbook-incident-timeline-${at}', 'runbook-incident-timeline-${at}-remove',
  'runbook-notes', 'runbook-rollback-${at}-down', 'runbook-rollback-${at}-up', 'runbook-section-${list}',
  'runbook-section-incident', 'runbook-section-notes', 'runbook-start-empty', 'runbook-start-empty-confirm',
  'runbook-start-empty-keep', 'runbook-start-empty-line', 'runbook-tab', 'runbook-unreadable', 'sealed-${group}',
  'sealed-${group}-done', 'sealed-${group}-empty', 'sealed-${group}-error', 'sealed-${group}-error-box',
  'sealed-${group}-file', 'sealed-${group}-path', 'sealed-${group}-row-${at}', 'sealed-${group}-upload',
  'smoke-drill-read-only', 'smoke-drill-read-only-box', 'task-down-${task.taskKey}', 'task-edit-${task.taskKey}',
  'task-form', 'task-form-brief', 'task-form-cancel', 'task-form-error', 'task-form-key', 'task-form-no-path',
  'task-form-objectives', 'task-form-quiz-only', 'task-form-quiz-required-note', 'task-form-required',
  'task-form-submit', 'task-form-title', 'task-notice-${task.taskKey}', 'task-notice-box-${task.taskKey}',
  'task-provenance-${task.taskKey}', 'task-remove-${task.taskKey}', 'task-remove-confirm', 'task-remove-no',
  'task-remove-yes', 'task-required-${task.taskKey}', 'task-required-toggle-${task.taskKey}',
  'task-row-${task.taskKey}', 'task-scoring-${task.taskKey}', 'task-signoff-box-${task.taskKey}',
  'task-summary-${task.taskKey}', 'task-title-${task.taskKey}', 'task-type-${task.taskKey}',
  'task-up-${task.taskKey}', 'tde-background', 'tde-contract-api', 'tde-contract-screens', 'tde-converted',
  'tde-copy-confirm', 'tde-copy-confirm-line', 'tde-copy-keep', 'tde-copy-requirements', 'tde-criteria', 'tde-floor',
  'tde-floor-${row.field}', 'tde-floor-save', 'tde-floor-sentence', 'tde-floor-sequence', 'tde-floor-status',
  'tde-learner-brief', 'tde-learner-brief-text', 'tde-learner-design', 'tde-learner-objectives',
  'tde-learner-objectives-text', 'tde-learner-save', 'tde-learner-status', 'tde-learner-title', 'tde-older-format',
  'tde-readiness', 'tde-sequence-diagram', 'tde-signoff-error', 'tde-signoff-read', 'tde-start-broken',
  'tde-start-cards', 'tde-start-confirm', 'tde-start-confirm-line', 'tde-start-empty', 'tde-start-error',
  'tde-start-keep', 'tde-start-load-error', 'tde-start-older', 'tde-start-reset', 'tde-start-status',
  'tde-start-words', 'tde-starting-point', 'tde-stories', 'tde-stories-none', 'tde-stories-save',
  'tde-stories-status', 'tde-story-${at}', 'tde-story-${at}-id', 'tde-story-${at}-line', 'tde-story-${at}-remove',
  'tde-story-${at}-title', 'tde-story-add', 'tde-switch-confirm', 'tde-switch-confirm-line', 'tde-switch-keep',
  'tdm-brief', 'tdm-change', 'tdm-change-error', 'tdm-change-forms', 'tdm-change-older', 'tdm-change-reading',
  'tdm-change-status', 'tdm-change-unreadable', 'tdm-code', 'tdm-code-edit', 'tdm-contract', 'tdm-contract-confirm',
  'tdm-contract-confirm-yes', 'tdm-contract-keep', 'tdm-conversion-refused', 'tdm-criteria', 'tdm-files-error',
  'tdm-floor-${field}', 'tdm-floor-sentence', 'tdm-floor-status', 'tdm-older-format', 'tdm-readiness',
  'tdm-reset-source', 'tdm-signoff', 'tdm-signoff-error', 'tdm-signoff-read', 'tdm-start-confirm',
  'tdm-start-confirm-line', 'tdm-start-empty', 'tdm-start-keep', 'tdm-ticket', 'tdm-ticket-add-line',
  'tdm-ticket-heading', 'tdm-ticket-id', 'tdm-ticket-line-${at}', 'tdm-ticket-line-${at}-remove',
  'tdm-ticket-line-${at}-text', 'tdm-ticket-save', 'tdm-ticket-status', 'tdm-ticket-summary', 'tdm-ticket-title',
  'tdp-brief', 'tdp-conversion-refused', 'tdp-criteria', 'tdp-drill', 'tdp-file-rules', 'tdp-files',
  'tdp-files-error', 'tdp-files-list', 'tdp-floor-${field}', 'tdp-floor-requireIncident', 'tdp-floor-sentence',
  'tdp-floor-status', 'tdp-older-format', 'tdp-readiness', 'tdp-reset-source', 'tdp-runbook', 'tdp-runbook-error',
  'tdp-runbook-older', 'tdp-runbook-status', 'tdp-signoff', 'tdp-signoff-error', 'tdp-signoff-read', 'tdp-smoke',
  'tdp-start-confirm', 'tdp-start-confirm-line', 'tdp-start-empty', 'tdp-start-keep', 'testing-builder',
  'tre-background', 'tre-background-field', 'tre-background-save', 'tre-background-status', 'tre-background-text',
  'tre-criteria', 'tre-criteria-add', 'tre-criteria-save', 'tre-criteria-status', 'tre-criterion-${n}',
  'tre-criterion-${n}-locked', 'tre-floor', 'tre-floor-sentence', 'tre-learner-brief', 'tre-learner-brief-text',
  'tre-learner-id', 'tre-learner-picks', 'tre-learner-save', 'tre-learner-status', 'tre-learner-story',
  'tre-learner-title', 'tre-legacy', 'tre-provided', 'tre-provided-blank', 'tre-provided-card-${story.id}',
  'tre-provided-editor-${story.id}', 'tre-provided-save', 'tre-provided-status', 'tre-signoff-error',
  'tre-signoff-read', 'tre-stakeholder', 'tre-stakeholder-opening', 'tre-step-${step.n}', 'tre-steps',
  'tre-weights-sum',
];

function sources(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? readFileSync(path, 'utf8') : ''))
    .join('\n');
}

describe('every data-testid of f41a33a4 is still drawn', () => {
  it('appears in the source of these components', () => {
    const now = sources(resolve(__dirname, '../components/staff/projects')) + sources(resolve(__dirname, '../app/(app)/teacher/projects'));
    expect(TEST_IDS_AT_F41A33A4.length).toBeGreaterThan(400);
    const missing = TEST_IDS_AT_F41A33A4.filter((id) => {
      const pattern = id
        .split(/\$\{[^}]*\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\$\\{[^}]*\\}');
      return !new RegExp(pattern).test(now);
    });
    expect(missing).toEqual([]);
  });

  it('the ones browser scripts press are on the page, under the tab it must open', async () => {
    await mount(version({ validation: FAILING }));
    const where = (id: string) => q(id)?.closest('[data-project-section]')?.getAttribute('data-project-section') ?? (q(id) ? 'header' : 'absent');
    expect(where('project-status')).toBe('header');
    expect(where('project-preview-open')).toBe('header');
    expect(where('project-phase-tab-requirements')).toBe('header');
    expect(where('phases-card-readiness')).toBe('overview');
    expect(where('project-validate')).toBe('validate');
    expect(where('project-validation-tier')).toBe('validate');
    expect(where('deep-validation-status')).toBe('validate');
    expect(where('project-publish-version')).toBe('publish');
    expect(where('project-publish-blocking')).toBe('publish');
  });
});

describe('the remove confirm keeps the reading measure too', () => {
  it('the notice that asks before a task is removed carries the measure the builders carry', () => {
    expect(closureText('ProjectEditor')).toContain('testId="task-remove-confirm" className={MEASURE}');
  });
});
