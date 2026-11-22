// @vitest-environment jsdom
/**
 * The copy becomes the teacher's own, in the editor.
 *
 * The real `ProjectEditor`, with the authoring client the only seam (the
 * `teacher-projects-editor.test.tsx` pattern). A draft copied from the
 * reference project, whose phases carry the provenance the API computes:
 * the chips say whose each element is, the last four phases say
 * whose application they run, the intro, the interview and a read-only
 * document can each be made the teacher's own through its door, and the
 * remove confirm is honest about a task that came with the copy.
 *
 * The reference project's name is the payload's (`referenceName`,
 * `application`); nothing under `lib|components|app` spells it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DraftPhaseView,
  DraftTaskView,
  DraftVersionView,
  InterviewBody,
  PhaseProvenanceView,
  TaskMutationResult,
  ValidationReport,
} from '@learnsdlc/shared';
import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_STORY_FLOOR,
  INHERITED_TASK_KEY,
  LEARNER_PICKS,
  STORY_JSON,
  SUPPORTED_STACKS_SENTENCE,
  applicationPhasesSentence,
  referenceFileBriefNote,
} from '@learnsdlc/shared';

const draft = vi.fn();
const files = vi.fn();
const get = vi.fn();
const updatePhase = vi.fn();
const putInterview = vi.fn();
const removeInterview = vi.fn();
const readInterview = vi.fn();
const replaceFile = vi.fn();
const removeTask = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    files: (...a: unknown[]) => files(...a),
    get: (...a: unknown[]) => get(...a),
    validate: vi.fn(),
    publish: vi.fn(),
    addTask: vi.fn(),
    updateTask: vi.fn(),
    setTaskRequired: vi.fn(),
    reorderTasks: vi.fn(),
    removeTask: (...a: unknown[]) => removeTask(...a),
    createDraft: vi.fn(),
    readQuizKey: vi.fn(),
    updatePhase: (...a: unknown[]) => updatePhase(...a),
    putInterview: (...a: unknown[]) => putInterview(...a),
    removeInterview: (...a: unknown[]) => removeInterview(...a),
    readInterview: (...a: unknown[]) => readInterview(...a),
    replaceFile: (...a: unknown[]) => replaceFile(...a),
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

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError } from '@/lib/api';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { phaseSetFor } from './support/phase-set';

const NAME = 'TaskTrackr';

function task(over: Partial<DraftTaskView> = {}): DraftTaskView {
  return {
    taskKey: INHERITED_TASK_KEY,
    order: 1,
    required: true,
    title: 'Write the missing story',
    brief: 'Write the story.',
    artefactType: 'user-story',
    artefactPath: null,
    checkKind: 'story',
    rubric: {
      passThreshold: DEFAULT_PASS_THRESHOLD,
      criteria: [{ key: 'story_structure', title: 'Story', weight: 1, description: 'The story.' }],
    },
    objectives: [],
    owns: [STORY_JSON],
    authorable: true,
    notice: null,
    story: {
      kind: 'story',
      record: STORY_JSON,
      providedStories: [],
      learnerStory: { id: LEARNER_PICKS, hints: {} },
      floor: DEFAULT_STORY_FLOOR,
    },
    ...over,
  };
}

function provenance(over: Partial<PhaseProvenanceView> = {}): PhaseProvenanceView {
  return {
    phaseKey: 'requirements',
    referenceName: NAME,
    rollup: 'mixed',
    intro: 'own',
    interview: 'reference',
    files: [{ path: 'requirements/backlog.md', provenance: 'reference' }],
    tasks: [{ taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: false }],
    roomTask: 'reference',
    ...over,
  };
}

const REQUIREMENTS: DraftPhaseView = {
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  intro: 'Staff cannot find a free meeting room.',
  artifactKind: 'story',
  checkKind: 'story',
  tasks: [task()],
  blocksPublish: false,
  interview: {
    persona: { name: 'Priya Nair', role: 'Facilities manager' },
    opening: 'Ask me about the rooms.',
    maxTurns: 10,
    factsExpected: 1,
    facts: [{ id: 'f1', topic: 'Who books rooms' }],
  },
  provenance: provenance(),
};

const DESIGN: DraftPhaseView = {
  ...REQUIREMENTS,
  key: 'design',
  order: 2,
  title: 'Design',
  intro: 'Design the booking desk.',
  interview: undefined,
  tasks: [task({ taskKey: 'desk-design', title: 'Design the desk', artefactType: 'design-doc', artefactPath: 'docs/notes.md' })],
  provenance: provenance({
    phaseKey: 'design',
    rollup: 'reference',
    intro: 'reference',
    interview: null,
    files: [{ path: 'docs/backlog.md', provenance: 'reference' }],
    tasks: [{ taskKey: 'desk-design', provenance: 'reference', titleEdited: false }],
  }),
};

const IMPLEMENTATION: DraftPhaseView = {
  key: 'implementation',
  order: 3,
  title: 'Implementation',
  intro: 'Close the gaps.',
  artifactKind: 'code',
  checkKind: 'code',
  tasks: [task({ title: 'Close the five gaps', artefactType: 'code', checkKind: 'code', artefactPath: null, authorable: false })],
  blocksPublish: false,
  provenance: provenance({
    phaseKey: 'implementation',
    rollup: 'reference',
    intro: 'reference',
    interview: null,
    files: [],
    tasks: [],
    roomTask: 'none',
    application: NAME,
  }),
};

function version(over: Partial<DraftVersionView> = {}): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'room-desk',
    title: 'RoomDesk',
    tagline: 'Book a room',
    description: 'A copy made my own.',
    platformOwned: false,
    editable: true,
    phases: [REQUIREMENTS, DESIGN, IMPLEMENTATION],
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-09-30T00:00:00.000Z',
    phaseSet: phaseSetFor(['requirements', 'design', 'implementation'], true),
    ...over,
  };
}

const REPORT: ValidationReport = {
  tier: 'fast',
  ranAt: '2026-09-30T00:00:00.000Z',
  checks: [],
  passed: 0,
  failed: 0,
  notApplicable: 0,
  publishable: true,
  blocking: [],
  neutralSummary: null,
} as unknown as ValidationReport;

const result = (phase: DraftPhaseView): TaskMutationResult => ({ phase, validation: REPORT });

const BRIEF: InterviewBody = {
  persona: { name: 'Priya Nair', role: 'Facilities manager' },
  opening: 'Ask me about the rooms.',
  unknownReply: 'I do not know that one.',
  refusal: 'That is yours to write.',
  maxTurns: 10,
  factsExpected: 1,
  facts: [{ id: 'f1', topic: 'Who books rooms', keywords: ['book', 'who'], answer: 'Staff book rooms.' }],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  get.mockResolvedValue({
    project: {
      title: 'RoomDesk',
      platformOwned: false,
      mine: true,
      publishedVersion: '0.1.0',
      publishedVersionId: 'v-mine',
      draftVersion: null,
      draftVersionId: null,
    },
    versions: [{ status: 'published' }],
  });
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

async function mount(view: DraftVersionView = version()) {
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
  const node = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Every id an element is described by resolves, and one of them says `words`. */
function describedAs(el: HTMLElement | null, words: RegExp) {
  expect(el).not.toBeNull();
  const ids = (el!.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  const said = ids.map((one) => document.getElementById(one)?.textContent ?? '').join(' ');
  expect(said).toMatch(words);
}

describe('the scenario, whose it is', () => {
  it("chips each element with whose it is, in the payload's own name", async () => {
    await mount();
    expect(byId('phase-provenance-requirements')?.textContent).toBe('Partly yours');
    expect(byId('phase-intro-provenance-requirements')?.textContent).toBe('Yours');
    expect(byId('phase-interview-provenance')?.textContent).toBe("TaskTrackr's");
    expect(byId(`task-provenance-${INHERITED_TASK_KEY}`)?.textContent).toBe('Edited');
    // One intro, drawn once, with its door.
    expect(text().split('Staff cannot find a free meeting room.').length - 1).toBe(1);
    // Requirements is drawn by the five-step builder, which holds no
    // documents; a document is chipped on the phase that mounts it.
    await click('project-phase-tab-design');
    expect(byId('phase-file-provenance-docs/backlog.md')?.textContent).toBe("TaskTrackr's");
  });

  it("says plainly that the last four phases run the reference project's application", async () => {
    await mount();
    await click('project-phase-tab-implementation');
    expect(byId('phase-application-implementation')?.textContent).toBe(applicationPhasesSentence(NAME));
    // The intro door is open on the last four phases too: on Implementation it is the three-step builder's Background.
    expect(byId('tdi-brief-background')).not.toBeNull();
    // No interview and no document door on an application phase.
    expect(byId('phase-interview')).toBeNull();
    expect(byId('phase-files-implementation')).toBeNull();
  });

  it('draws a payload from an older build without a chip, and keeps the intro door', async () => {
    const { provenance: _p, ...bare } = REQUIREMENTS;
    await mount(version({ phases: [bare as DraftPhaseView] }));
    expect(byId('phase-provenance-requirements')).toBeNull();
    // The builder's background is the Requirements intro door.
    expect(byId('tre-background-field')).not.toBeNull();
    // It cannot tell an interview from none, so it claims neither.
    const { interview: _i, provenance: _q, ...older } = REQUIREMENTS;
    act(() => root?.unmount());
    root = createRoot(host!);
    await mount(version({ phases: [older as DraftPhaseView] }));
    expect(byId('phase-interview')).toBeNull();
    expect(byId('phase-interview-none')).toBeNull();
  });

  it('shows no door at all on a version that is not editable', async () => {
    await mount(version({ editable: false, status: 'published' }));
    expect(byId('phase-intro-edit-requirements')).toBeNull();
    expect(byId('phase-interview-edit')).toBeNull();
    expect(byId('phase-file-replace-requirements/backlog.md')).toBeNull();
  });
});

describe('the intro door', () => {
  // Requirements writes its intro in the five-step builder's background step
  // (requirements-builder.test.tsx); the door every other phase keeps is read
  // on Design.
  it('saves the intro through phases.update and applies the phase it answers with', async () => {
    const saved = { ...DESIGN, intro: 'Our rooms are always double booked.', provenance: { ...DESIGN.provenance!, intro: 'own' as const } };
    updatePhase.mockResolvedValue(result(saved));
    await mount();
    await click('project-phase-tab-design');
    await click('phase-intro-edit-design');
    type(byId('phase-intro-field-design'), 'Our rooms are always double booked.');
    await click('phase-intro-save-design');
    expect(updatePhase).toHaveBeenCalledWith('p-mine', 'v-mine', 'design', {
      intro: 'Our rooms are always double booked.',
    });
    expect(byId('phase-intro-field-design')).toBeNull();
    expect(text()).toContain('Our rooms are always double booked.');
    expect(byId('project-live')?.textContent).toBe('The intro to Design was saved.');
  });

  it("an open, untouched intro form takes the server's plain intro from another door's answer (Task 12)", async () => {
    // the server stores the phase's markdown intro plain at the draft's first save (spec 6.2)
    removeTask.mockResolvedValue(result({ ...DESIGN, intro: 'Design the booking desk, plainly.', tasks: [] }));
    await mount(version({ phases: [REQUIREMENTS, { ...DESIGN, intro: 'Design the **booking** desk, plainly.' }, IMPLEMENTATION] }));
    await click('project-phase-tab-design');
    await click('phase-intro-edit-design');
    expect((byId('phase-intro-field-design') as HTMLTextAreaElement).value).toBe('Design the **booking** desk, plainly.');
    await click('task-remove-desk-design');
    await click('task-remove-yes');
    expect(removeTask).toHaveBeenCalled();
    expect((byId('phase-intro-field-design') as HTMLTextAreaElement).value).toBe('Design the booking desk, plainly.');
  });

  it('refuses a blank intro in the form, tied to its field', async () => {
    await mount();
    await click('project-phase-tab-design');
    await click('phase-intro-edit-design');
    type(byId('phase-intro-field-design'), '   ');
    await click('phase-intro-save-design');
    expect(updatePhase).not.toHaveBeenCalled();
    const field = byId('phase-intro-field-design');
    expect(field?.getAttribute('aria-invalid')).toBe('true');
    describedAs(field, /Write the intro before you save it/);
  });

  it("prints the door's refusal word for word", async () => {
    updatePhase.mockRejectedValue(new ApiError(400, 'The intro is too long for this door.'));
    await mount();
    await click('project-phase-tab-design');
    await click('phase-intro-edit-design');
    type(byId('phase-intro-field-design'), 'Something.');
    await click('phase-intro-save-design');
    expect(byId('phase-intro-error-design')?.textContent).toBe('The intro is too long for this door.');
    describedAs(byId('phase-intro-field-design'), /too long for this door/);
  });
});

describe('the interview door', () => {
  it('summarises the interview without its answers, and reads them only when asked', async () => {
    await mount();
    expect(byId('phase-interview-persona')?.textContent).toContain('Priya Nair, Facilities manager.');
    expect(byId('phase-interview-topics')?.textContent).toBe('Who books rooms');
    expect(readInterview).not.toHaveBeenCalled();
    readInterview.mockResolvedValue(BRIEF);
    await click('phase-interview-edit');
    expect(readInterview).toHaveBeenCalledWith('p-mine', 'v-mine');
    expect((byId('interview-persona-name') as HTMLInputElement).value).toBe('Priya Nair');
    expect((byId('interview-fact-0-answer') as HTMLTextAreaElement).value).toBe('Staff book rooms.');
  });

  it('draws each fact as a fieldset with its legend, and adds and removes facts', async () => {
    readInterview.mockResolvedValue(BRIEF);
    await mount();
    await click('phase-interview-edit');
    const fact = byId('interview-fact-0');
    expect(fact?.tagName).toBe('FIELDSET');
    expect(fact?.querySelector('legend')?.textContent).toBe('Fact 1');
    await click('interview-fact-add');
    expect(byId('interview-fact-1')?.querySelector('legend')?.textContent).toBe('Fact 2');
    expect((byId('interview-fact-1-id') as HTMLInputElement).value).toBe('f2');
    await click('interview-fact-1-remove');
    expect(byId('interview-fact-1')).toBeNull();
    // Every input the form draws has a label.
    for (const input of Array.from(byId('interview-editor')!.querySelectorAll('input, textarea'))) {
      const labelled = input.id && byId('interview-editor')!.querySelector(`label[for="${input.id}"]`);
      expect(labelled, `no label for ${input.getAttribute('data-testid')}`).toBeTruthy();
    }
  });

  it('ties every error to its field, and sends nothing until the brief is whole', async () => {
    readInterview.mockResolvedValue(BRIEF);
    await mount();
    await click('phase-interview-edit');
    type(byId('interview-persona-name'), '');
    type(byId('interview-fact-0-keywords'), '');
    type(byId('interview-fact-0-answer'), '');
    await click('interview-save');
    expect(putInterview).not.toHaveBeenCalled();
    const name = byId('interview-persona-name');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    describedAs(name, /stakeholder's name/);
    describedAs(byId('interview-fact-0-keywords'), /at least one word/);
    describedAs(byId('interview-fact-0-answer'), /what the stakeholder answers/);
  });

  it('writes the whole brief through interview.replace, keywords parsed', async () => {
    readInterview.mockResolvedValue(BRIEF);
    putInterview.mockResolvedValue(result({ ...REQUIREMENTS, provenance: provenance({ interview: 'own' }) }));
    await mount();
    await click('phase-interview-edit');
    type(byId('interview-fact-0-keywords'), 'book,  who , when');
    await click('interview-save');
    expect(putInterview).toHaveBeenCalledWith('p-mine', 'v-mine', {
      ...BRIEF,
      facts: [{ ...BRIEF.facts[0], keywords: ['book', 'who', 'when'] }],
    });
    expect(byId('interview-editor')).toBeNull();
    expect(byId('phase-interview-provenance')?.textContent).toBe('Yours');
  });

  it("prints the door's refusal inside the form, as the form's description", async () => {
    readInterview.mockResolvedValue(BRIEF);
    putInterview.mockRejectedValue(new ApiError(400, 'The loader refuses this brief.'));
    await mount();
    await click('phase-interview-edit');
    await click('interview-save');
    expect(byId('interview-editor-error')?.textContent).toBe('The loader refuses this brief.');
    describedAs(byId('interview-editor'), /loader refuses this brief/);
  });

  it('removes the interview through interview.remove after saying what it does', async () => {
    removeInterview.mockResolvedValue(
      result({ ...REQUIREMENTS, interview: undefined, provenance: provenance({ interview: null }) }),
    );
    await mount();
    await click('phase-interview-remove');
    expect(byId('phase-interview-remove-confirm')?.textContent).toContain('meet no stakeholder in Requirements');
    await click('phase-interview-remove-yes');
    expect(removeInterview).toHaveBeenCalledWith('p-mine', 'v-mine');
    expect(byId('phase-interview-none')).not.toBeNull();
  });

  it('writes a new interview on a phase with none, without reading any answers', async () => {
    await mount(version({ phases: [{ ...REQUIREMENTS, interview: undefined, provenance: provenance({ interview: null }) }] }));
    await click('phase-interview-write');
    expect(readInterview).not.toHaveBeenCalled();
    expect((byId('interview-persona-name') as HTMLInputElement).value).toBe('');
  });
});

describe('the document door', () => {
  // Requirements holds no documents in the five-step builder; the door is
  // read on Design, which mounts the reference document.
  it('replaces a document in a dialog that holds focus, closes with Escape and gives focus back', async () => {
    files.mockResolvedValue([
      {
        id: 'f-1',
        ownerKind: 'phase',
        phaseKey: 'design',
        path: 'docs/backlog.md',
        role: 'workspace',
        editable: false,
        language: 'markdown',
        size: 20,
        sealed: false,
        content: '# Architecture\n',
        notice: null,
      },
    ]);
    await mount();
    await click('project-phase-tab-design');
    const opener = byId('phase-file-replace-docs/backlog.md');
    await act(async () => {
      opener?.focus();
      opener?.click();
    });
    const dialog = byId('file-replace-dialog');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const field = byId('file-replace-content') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('# Architecture\n');
    // Tab from the last control wraps to the first rather than leaving. jsdom
    // moves no focus on a synthetic Tab, so only the trap can move it here.
    const focusable = Array.from(
      dialog!.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled])'),
    );
    const last = focusable[focusable.length - 1];
    expect(last).toBe(byId('file-replace-cancel'));
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => {
      last.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(byId('file-replace-dialog')).toBeNull();
    expect(document.activeElement).toBe(byId('phase-file-replace-docs/backlog.md'));
  });

  // `aria-modal` tells a screen reader the page behind is gone, but on its
  // own a pointer could still change that page. The dialog is a native
  // <dialog> opened with showModal(), which makes the rest of the document
  // inert, as TaskResetControl's does; closing it closes the modal first so
  // focus can go back to the opener.
  it('makes the page behind the dialog inert: a native <dialog>, opened modally, closed before focus returns', async () => {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
    const had = { showModal: proto.showModal, close: proto.close };
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    const close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    Object.defineProperty(proto, 'showModal', { value: showModal, configurable: true, writable: true });
    Object.defineProperty(proto, 'close', { value: close, configurable: true, writable: true });
    try {
      files.mockResolvedValue([
        {
          id: 'f-1',
          ownerKind: 'phase',
          phaseKey: 'design',
          path: 'docs/backlog.md',
          role: 'workspace',
          editable: false,
          language: 'markdown',
          size: 20,
          sealed: false,
          content: '# Architecture\n',
          notice: null,
        },
      ]);
      await mount();
      await click('project-phase-tab-design');
      const opener = byId('phase-file-replace-docs/backlog.md');
      await act(async () => {
        opener?.focus();
        opener?.click();
      });
      const dialog = byId('file-replace-dialog');
      expect(dialog?.tagName).toBe('DIALOG');
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(showModal.mock.contexts[0]).toBe(dialog);
      expect(dialog?.hasAttribute('open')).toBe(true);
      expect(document.activeElement).toBe(byId('file-replace-content'));
      await click('file-replace-cancel');
      expect(close).toHaveBeenCalledTimes(1);
      expect(byId('file-replace-dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
    } finally {
      for (const [name, fn] of Object.entries(had)) {
        if (fn) Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true });
        else delete (proto as unknown as Record<string, unknown>)[name];
      }
    }
  });

  it('says so when the current contents could not be read, rather than opening on nothing', async () => {
    files.mockRejectedValue(new Error('offline'));
    await mount();
    await click('project-phase-tab-design');
    await click('phase-file-replace-docs/backlog.md');
    const unread = byId('file-replace-unread');
    expect(unread?.textContent).toMatch(/could not be read/);
    describedAs(byId('file-replace-content'), /could not be read/);
  });

  it('sends the path and the bytes through files.replace and says where else it was replaced', async () => {
    replaceFile.mockResolvedValue({
      ...result({ ...DESIGN, provenance: { ...DESIGN.provenance!, files: [{ path: 'docs/backlog.md', provenance: 'own' as const }] } }),
      alsoReplacedIn: ['requirements'],
    });
    await mount();
    await click('project-phase-tab-design');
    await click('phase-file-replace-docs/backlog.md');
    type(byId('file-replace-content'), '# Architecture, revised\n');
    await click('file-replace-save');
    expect(replaceFile).toHaveBeenCalledWith('p-mine', 'v-mine', 'design', {
      path: 'docs/backlog.md',
      content: '# Architecture, revised\n',
    });
    expect(byId('file-replace-dialog')).toBeNull();
    expect(byId('phase-file-provenance-docs/backlog.md')?.textContent).toBe('Yours');
    expect(byId('project-live')?.textContent).toContain('and in one other phase that read it');
  });

  it("prints the door's refusal in the dialog, tied to the field", async () => {
    replaceFile.mockRejectedValue(new ApiError(400, 'That file is withheld from this editor.'));
    await mount();
    await click('project-phase-tab-design');
    await click('phase-file-replace-docs/backlog.md');
    type(byId('file-replace-content'), 'Anything.');
    await click('file-replace-save');
    expect(byId('file-replace-error')?.textContent).toBe('That file is withheld from this editor.');
    describedAs(byId('file-replace-content'), /withheld from this editor/);
  });

  it("puts K6's note beside Design's reference document", async () => {
    await mount();
    await click('project-phase-tab-design');
    expect(byId('phase-file-note-docs/backlog.md')?.textContent).toBe(
      referenceFileBriefNote('docs/backlog.md'),
    );
  });
});

describe('removing a task that came with the copy', () => {
  it('says the task came with the copy, and what the phase becomes', async () => {
    // Requirements' lone task is edited in the five-step builder, which has no
    // remove; the confirm is read on Design's task, which came with the copy.
    await mount();
    await click('project-phase-tab-design');
    await click('task-remove-desk-design');
    const said = byId('task-remove-confirm')?.textContent ?? '';
    expect(said).toContain('It came with the copy of TaskTrackr.');
    expect(said).toContain("Design is then no longer TaskTrackr's scenario");
  });

  it("keeps the editor's own sentence for a task the teacher added", async () => {
    // A task a teacher adds is a concept quiz, the one task the editor adds.
    const own = task({
      taskKey: 'late-marker',
      title: 'The late marker',
      artefactType: 'quiz',
      checkKind: 'quiz',
      owns: [],
      story: undefined,
      quiz: { questions: [], shuffleOptions: false, passMark: 70, attempts: { max: null, cooldownSeconds: null }, criterion: 'concepts' },
    });
    await mount(
      version({
        phases: [
          {
            ...REQUIREMENTS,
            tasks: [task(), own],
            provenance: provenance({
              tasks: [
                { taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: false },
                { taskKey: 'late-marker', provenance: 'own', titleEdited: false },
              ],
            }),
          },
        ],
      }),
    );
    await click('task-remove-late-marker');
    expect(byId('task-remove-confirm')?.textContent).toContain('Its brief and what scores it are removed with it.');
  });
});
