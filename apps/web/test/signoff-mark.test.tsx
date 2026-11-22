// @vitest-environment jsdom
/**
 * The sign-off mark on a draft's task.
 *
 * A teacher marks a task as needing their sign-off from the project editor.
 * The mark is one labelled checkbox on the task's row, described by a help
 * sentence that says exactly what the product does with it and nothing it
 * does not (no notification, no email, no deadline):
 *
 * - **It saves the mark and nothing else.** A change sends `updateTask(…,
 *   { signOff })` with no other member, so no title, brief or rule rides along.
 * - **The draft decides what is drawn.** `DraftTaskView.signOff` drives the
 *   checked state, an absent member reads unchecked, and the phase the save
 *   answers with is what the row shows next.
 * - **A version that cannot change says why.** On a published version or the
 *   platform's project the mark is drawn off, described by the editor's own
 *   read-only reason.
 * - **Accessibility**: a native checkbox with a label and `aria-describedby`, reached
 *   and operated from the keyboard, and focus stays on it through the save.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPhaseView, DraftTaskView, DraftVersionView } from '@learnsdlc/shared';
import {
  DEFAULT_PASS_THRESHOLD,
  SUPPORTED_STACKS_SENTENCE,
  draftOnlyRefusal,
  platformProjectCopyOnlyRefusal,
  refusesMultiTaskPublish,
  summariseValidation,
} from '@learnsdlc/shared';

const draft = vi.fn();
const updateTask = vi.fn();
const get = vi.fn();
const files = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    draft: (...a: unknown[]) => draft(...a),
    updateTask: (...a: unknown[]) => updateTask(...a),
    get: (...a: unknown[]) => get(...a),
    files: (...a: unknown[]) => files(...a),
    validate: vi.fn(),
    publish: vi.fn(),
    addTask: vi.fn(),
    setTaskRequired: vi.fn(),
    reorderTasks: vi.fn(),
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

import { ApiError } from '@/lib/api';
import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { SIGN_OFF_HELP, SIGN_OFF_LABEL } from '@/components/staff/projects/TaskEditor';
import { settle } from './support/dom';
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
    rubric: {
      passThreshold: DEFAULT_PASS_THRESHOLD,
      criteria: [{ key: 'actor', title: 'Actor', weight: 1, description: 'The story names its actor.' }],
    },
    objectives: [],
    owns: ['requirements/story.json'],
    authorable: true,
    notice: null,
    ...over,
  };
}

function phase(tasks: DraftTaskView[]): DraftPhaseView {
  return {
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    intro: 'Say what the product must do.',
    artifactKind: 'story',
    checkKind: 'story',
    tasks,
    blocksPublish: refusesMultiTaskPublish(tasks.length, 'story'),
  };
}

function version(over: Partial<DraftVersionView> = {}, tasks: DraftTaskView[] = [task()]): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'my-course',
    title: 'My course',
    tagline: 'A course of my own',
    description: 'Uploaded.',
    platformOwned: false,
    editable: true,
    phases: [phase(tasks)],
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-10-01T00:00:00.000Z',
    phaseSet: phaseSetFor([phase(tasks).key], true),
    ...over,
  };
}

const REPORT = summariseValidation('fast', '2026-10-02T00:00:00.000Z', []);

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
      id: 'p-mine',
      slug: 'my-course',
      title: 'My course',
      platformOwned: false,
      mine: true,
      isDefault: false,
      origin: 'upload',
      publishedVersion: '1.0.0',
      publishedVersionId: 'v-mine',
      draftVersion: null,
      draftVersionId: null,
      cohortsUsing: 1,
      lastValidatedAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    versions: [],
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
const mark = (key = 'main') => byId(`task-signoff-${key}`) as HTMLInputElement | null;


async function mount(view: DraftVersionView) {
  draft.mockResolvedValue(view);
  await act(async () => {
    root?.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />);
  });
  await settle(6);
}

function describedText(el: HTMLElement): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`).join(' ');
}

describe('the sign-off mark on a draft task', () => {
  it('is a labelled checkbox described by its help', async () => {
    await mount(version());
    const box = mark();
    expect(box, 'no sign-off mark on the task row').not.toBeNull();
    expect(box!.tagName).toBe('INPUT');
    expect(box!.type).toBe('checkbox');
    const label = host?.querySelector(`label[for="${box!.id}"]`);
    expect(box!.id).toBeTruthy();
    expect(label?.textContent).toContain(SIGN_OFF_LABEL);
    expect(describedText(box!)).toContain(SIGN_OFF_HELP);
  });

  it('says what the product does, and promises nothing it does not', () => {
    expect(SIGN_OFF_LABEL).toBe('Needs your sign-off');
    expect(SIGN_OFF_HELP).toMatch(/sign-off queue/);
    expect(SIGN_OFF_HELP).toMatch(/publish/);
    expect(SIGN_OFF_HELP).toMatch(/published version never changes/);
    expect(SIGN_OFF_HELP).toMatch(/export/i);
    expect(SIGN_OFF_HELP).not.toMatch(/notif|e-?mail|deadline|remind/i);
  });

  it('sends updateTask with { signOff: true } and no other member', async () => {
    updateTask.mockResolvedValue({ phase: phase([task({ signOff: true })]), validation: REPORT });
    await mount(version());
    await act(async () => {
      mark()!.click();
    });
    await settle(6);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', 'main', { signOff: true });
    const body = updateTask.mock.calls[0][4] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['signOff']);
    expect(mark()!.checked).toBe(true);
  });

  it('unmarks with { signOff: false } alone', async () => {
    updateTask.mockResolvedValue({ phase: phase([task({ signOff: false })]), validation: REPORT });
    await mount(version({}, [task({ signOff: true })]));
    await act(async () => {
      mark()!.click();
    });
    await settle(6);
    expect(updateTask).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', 'main', { signOff: false });
    expect(mark()!.checked).toBe(false);
  });

  it("the view's signOff drives the checked state", async () => {
    await mount(version({}, [task({ signOff: true }), task({ taskKey: 'late-marker', order: 2, title: 'Late', artefactPath: 'requirements/late.md', signOff: false })]));
    expect(mark('main')!.checked).toBe(true);
    expect(mark('late-marker')!.checked).toBe(false);
  });

  it('an absent signOff reads unchecked', async () => {
    const bare = task();
    delete (bare as { signOff?: boolean }).signOff;
    await mount(version({}, [bare]));
    expect(mark()!.checked).toBe(false);
  });

  it('a refused save leaves the mark as the draft holds it and says the refusal', async () => {
    updateTask.mockRejectedValue(new ApiError(403, 'That task cannot take a sign-off mark.'));
    await mount(version());
    await act(async () => {
      mark()!.click();
    });
    await settle(6);
    expect(mark()!.checked).toBe(false);
    expect(byId('project-task-error')?.textContent).toContain('That task cannot take a sign-off mark.');
  });

  it('a published version draws the mark off, with its read-only reason', async () => {
    await mount(version({ status: 'published', version: '1.0.0', editable: false }, [task({ signOff: true })]));
    const box = mark();
    expect(box).not.toBeNull();
    expect(box!.disabled).toBe(true);
    expect(box!.checked).toBe(true);
    expect(describedText(box!)).toContain(draftOnlyRefusal('1.0.0', 'published'));
    await act(async () => {
      box!.click();
    });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("the platform's project draws the mark off, with its read-only reason", async () => {
    await mount(version({ platformOwned: true, editable: false, title: 'TaskTrackr' }));
    const box = mark();
    expect(box!.disabled).toBe(true);
    expect(describedText(box!)).toContain(platformProjectCopyOnlyRefusal('TaskTrackr'));
  });

  // Rule (1): a quiz is refused the mark (signOffQuizRefusal), so its row draws none.
  it('a quiz row draws no mark at all, rather than a dead one', async () => {
    const quiz = task({
      taskKey: 'concepts',
      order: 2,
      title: 'The concept check',
      artefactType: 'quiz',
      artefactPath: null,
      checkKind: 'quiz',
      owns: [],
    });
    await mount(version({}, [task(), quiz]));
    expect(mark('main')).not.toBeNull();
    expect(mark('concepts')).toBeNull();
    expect(byId('task-signoff-box-concepts')).toBeNull();
  });

  // Rule (2): a task neither editor arm edits (an inherited or an
  // uploaded config sole task) takes a body carrying only signOff.
  it('a task the editor cannot otherwise edit still takes the mark, alone', async () => {
    const config = task({
      taskKey: 'main',
      title: 'Ship the shelf',
      artefactType: 'runbook',
      artefactPath: null,
      checkKind: 'config',
      owns: ['deploy/runbook.md'],
      authorable: false,
      notice: 'Inherited from the project you copied. It is graded as it came, and it cannot be edited or removed here.',
    });
    updateTask.mockResolvedValue({ phase: phase([{ ...config, signOff: true }]), validation: REPORT });
    await mount(version({}, [config]));
    expect(byId('task-edit-main')).toBeNull();
    await act(async () => {
      mark()!.click();
    });
    await settle(6);
    expect(updateTask).toHaveBeenCalledWith('p-mine', 'v-mine', 'requirements', 'main', { signOff: true });
    expect(mark()!.checked).toBe(true);
  });

  it('is reached and operated from the keyboard, and keeps focus through the save', async () => {
    updateTask.mockResolvedValue({ phase: phase([task({ signOff: true })]), validation: REPORT });
    await mount(version());
    const box = mark()!;
    expect(box.tabIndex).toBe(0);
    box.focus();
    expect(document.activeElement).toBe(box);
    // Space on a focused native checkbox is a click; jsdom does not synthesise it.
    await act(async () => {
      box.click();
    });
    await settle(6);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(mark()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(byId('project-live')?.textContent).toBe('The backlog now needs your sign-off.');
  });
});
