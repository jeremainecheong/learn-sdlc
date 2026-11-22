// @vitest-environment jsdom
/**
 * A teacher's copy of the reference project, on the learner's and the
 * editor's surfaces.
 *
 * - A phase that runs the reference application, whose main task is the
 *   reference's and whose roll-up is `mixed` only because the teacher added
 *   an optional quiz, keeps its lessons (lessons are shown where the phase is
 *   TaskTrackr's, phases 3-6 included), and `/learn/<phase>` never tells a
 *   learner the teacher wrote a phase the teacher did not write.
 * - The Requirements room and the brief draw the teacher's own phase intro
 *   (PhaseBriefIntro takes `detail.intro` for own/mixed).
 * - The story desk's criterion and exclusion examples are neutral on a phase
 *   whose room task is not the reference's.
 * - The editor offers Replace on a design task's starting documents (the
 *   door accepts them, validated: `design/design.json` here) in the Design
 *   builder's Starting point, and the row then says "Yours".
 * - The task form can reword a criterion the task holds.
 * - The inherited-task notice promises no roadmap.
 * - A busy replace dialog that the browser closes natively (a third Escape
 *   with focus on BODY) opens again rather than hiding its outcome.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DraftPhaseView,
  DraftTaskView,
  DraftVersionView,
  EnrollmentView,
  PhaseDetail,
  PhaseKey,
  PhaseProvenanceView,
  PhaseSummary,
  TaskMutationResult,
  ValidationReport,
} from '@learnsdlc/shared';
import { DEFAULT_DESIGN_FLOOR, DEFAULT_PASS_THRESHOLD, INHERITED_TASK_KEY, INHERITED_TASK_NOTICE, SUPPORTED_STACKS_SENTENCE } from '@learnsdlc/shared';

const shell = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => shell.state,
  useProject: () => {
    if (!shell.state) throw new Error('no provider');
    return shell.state;
  },
}));
const routed = vi.hoisted(() => ({ phaseKey: 'implementation' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workspace/phase-implementation',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ phaseKey: routed.phaseKey, phaseId: `phase-${routed.phaseKey}`, projectId: 'p-mine', versionId: 'v-mine' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/shell', async (original) => ({
  ...(await original<typeof import('@/components/shell')>()),
  DocPage: ({ children, title }: { children: ReactNode; title?: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
vi.mock('@/components/learn/LessonReader', () => ({
  LessonReader: ({ phaseKey }: { phaseKey: string }) => <article data-testid="lesson-reader">{phaseKey}</article>,
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', role: 'INSTRUCTOR', displayName: 'A Teacher' }),
  useRole: () => 'INSTRUCTOR',
}));

const draft = vi.fn();
const files = vi.fn();
const get = vi.fn();
const replaceFile = vi.fn();
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
    removeTask: vi.fn(),
    createDraft: vi.fn(),
    readQuizKey: vi.fn(),
    updatePhase: vi.fn(),
    putInterview: vi.fn(),
    removeInterview: vi.fn(),
    readInterview: vi.fn(),
    replaceFile: (...a: unknown[]) => replaceFile(...a),
  },
}));

import LessonPage from '@/app/(app)/learn/[phaseKey]/page';
import { PhaseStrip } from '@/components/shell/WorkPage';
import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { Brief } from '@/components/phases/Brief';
import { CriterionCard } from '@/components/workspace/panels/requirements/Criteria';
import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { EMPTY_STORY } from '@/components/workspace/panels/requirements/story';
import { useStoryFrom } from '@/components/workspace/panels/requirements/useStory';
import { DEFAULT_STORY_FLOOR, QUIZ_ONLY_ADD_REFUSAL } from '@learnsdlc/shared';
/** The phase's story spec, as the API sends it on a story-kind Requirements phase. */
const SPEC = { id: 'RD-1', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] };

import { ProjectEditor } from '@/components/staff/projects/ProjectEditor';
import { anyLessonsOffered, lessonsOfferedOn, lessonsVisibleFor } from '@/lib/scenario';
import { stubMatchMedia } from './support/dom';
import { phaseSetFor } from './support/phase-set';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TEACHER_WROTE = /your teacher wrote this phase/i;

function summary(key: PhaseKey, scenario?: PhaseSummary['scenario'], intro?: string): PhaseSummary {
  return {
    id: `phase-${key}`,
    key,
    order: KEYS.indexOf(key) + 1,
    title: key.charAt(0).toUpperCase() + key.slice(1),
    status: 'in_progress',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...(scenario ? { scenario } : {}),
    ...(intro ? { intro } : {}),
  } as PhaseSummary;
}

/** RoomDesk: Requirements own, Design own, Implementation mixed (an optional quiz), the rest reference. */
function roomDesk(over: Partial<Record<PhaseKey, PhaseSummary['scenario']>> = {}): EnrollmentView {
  const scenario: Record<PhaseKey, PhaseSummary['scenario']> = {
    requirements: 'own',
    design: 'own',
    implementation: 'mixed',
    testing: 'reference',
    deployment: 'reference',
    maintenance: 'reference',
    ...over,
  };
  return {
    id: 'enrol-1',
    projectSlug: 'room-desk',
    projectTitle: 'RoomDesk — book a room',
    currentPhaseOrder: 3,
    completed: false,
    startedAt: '2026-09-30T00:00:00Z',
    completedAt: null,
    phases: KEYS.map((key) => summary(key, scenario[key])),
    projectIsDefault: false,
  } as EnrollmentView;
}

function provenance(key: PhaseKey, over: Partial<PhaseProvenanceView> = {}): PhaseProvenanceView {
  return {
    phaseKey: key,
    referenceName: 'TaskTrackr',
    rollup: 'reference',
    intro: 'reference',
    interview: null,
    files: [],
    tasks: [],
    roomTask: 'none',
    ...over,
  };
}

/** RoomDesk's Implementation provenance: reference main, the teacher's optional quiz, TaskTrackr's application. */
const IMPLEMENTATION_MIXED = provenance('implementation', {
  rollup: 'mixed',
  tasks: [
    { taskKey: 'main', provenance: 'reference', titleEdited: false },
    { taskKey: 'build-check', provenance: 'own', titleEdited: false },
  ],
  application: 'TaskTrackr',
});

function detail(key: PhaseKey, over: Partial<PhaseDetail> = {}): PhaseDetail {
  return {
    ...summary(key, 'mixed'),
    intro: 'This phase is about the room booking desk.',
    objectives: ['Build the desk.'],
    files: [],
    rubric: { passThreshold: 70, criteria: [] },
    ...over,
  } as unknown as PhaseDetail;
}

function useShell(enrol: EnrollmentView | null, details: PhaseDetail[] = []) {
  shell.state = {
    enrollment: enrol,
    details: Object.fromEntries(details.map((one) => [one.id, one])),
    loading: false,
  };
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, writable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, writable: true, value() { this.removeAttribute('open'); } });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  try {
    window.sessionStorage.clear();
  } catch {
    /* no storage */
  }
  shell.state = null;
  routed.phaseKey = 'implementation';
  vi.clearAllMocks();
  files.mockResolvedValue([]);
  get.mockResolvedValue({
    project: { title: 'RoomDesk', platformOwned: false, mine: true, publishedVersion: null, publishedVersionId: null, draftVersion: '0.1.0', draftVersionId: 'v-mine' },
    versions: [{ status: 'draft' }],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  // The editor writes its open section into the address, which outlives a test; each test opens on Overview.
  window.history.replaceState(null, '', '/');
  act(() => root.unmount());
  host.remove();
});

/* ---------------------------- the lessons of a reference application phase */

describe('the lessons of a phase that runs the reference application', () => {
  it('shows them on a mixed application phase whose main task is the reference, and only there', () => {
    const enrol = roomDesk();
    const implementation = enrol.phases.find((one) => one.key === 'implementation')!;
    // The summary alone: `mixed` on an application phase.
    expect(lessonsVisibleFor(implementation, enrol)).toBe(true);
    expect(lessonsOfferedOn(enrol, 'implementation')).toBe(true);
    // With the detail's provenance in hand, the rule is the main task's provenance.
    expect(lessonsVisibleFor(implementation, enrol, IMPLEMENTATION_MIXED)).toBe(true);
    const notTheReferenceApplication = { ...IMPLEMENTATION_MIXED, application: null, tasks: [{ taskKey: 'main', provenance: 'edited' as const, titleEdited: false }] };
    expect(lessonsVisibleFor(implementation, enrol, notTheReferenceApplication)).toBe(false);
    expect(lessonsOfferedOn(enrol, 'implementation', { 'phase-implementation': detail('implementation', { provenance: notTheReferenceApplication } as Partial<PhaseDetail>) })).toBe(false);
    // A written phase is unchanged: mixed or own hides them.
    expect(lessonsOfferedOn(roomDesk({ requirements: 'mixed' }), 'requirements')).toBe(false);
    expect(lessonsOfferedOn(enrol, 'design')).toBe(false);
    // An application phase that is entirely the teacher's is not the reference's.
    expect(lessonsOfferedOn(roomDesk({ implementation: 'own' }), 'implementation')).toBe(false);
    // The reference roll-up and the default project show the lessons.
    expect(lessonsOfferedOn(enrol, 'testing')).toBe(true);
    expect(anyLessonsOffered(roomDesk({ testing: 'own', deployment: 'own', maintenance: 'own' }))).toBe(true);
  });

  it("draws the phase strip's guide on the mixed Implementation", () => {
    useShell(roomDesk(), [detail('implementation', { provenance: IMPLEMENTATION_MIXED } as Partial<PhaseDetail>)]);
    render(<PhaseStrip phase={{ key: 'implementation', title: 'Implementation' }} />);
    expect(host.querySelector('.phase-strip-guide')?.getAttribute('href')).toBe('/learn/implementation');
  });

  it('opens /learn/implementation directly on that phase', () => {
    useShell(roomDesk(), [detail('implementation', { provenance: IMPLEMENTATION_MIXED } as Partial<PhaseDetail>)]);
    routed.phaseKey = 'implementation';
    render(<LessonPage />);
    expect(byId('lesson-reader')?.textContent).toBe('implementation');
    expect(byId('lesson-hidden')).toBeNull();
  });

  it('never says the teacher wrote a phase that is only partly theirs, or a phase it cannot see', () => {
    routed.phaseKey = 'requirements';
    useShell(roomDesk({ requirements: 'mixed' }));
    render(<LessonPage />);
    expect(byId('lesson-hidden')).not.toBeNull();
    expect(text()).not.toMatch(TEACHER_WROTE);
    // An older API, on a project that is not the default: nothing is known about the phase.
    const older = roomDesk();
    useShell({ ...older, phases: older.phases.map(({ scenario: _s, ...rest }) => rest as PhaseSummary) });
    render(<LessonPage />);
    expect(byId('lesson-hidden')).not.toBeNull();
    expect(text()).not.toMatch(TEACHER_WROTE);
    // A phase that is entirely the teacher's still says so.
    useShell(roomDesk());
    render(<LessonPage />);
    expect(byId('lesson-hidden')).not.toBeNull();
    expect(text()).toMatch(TEACHER_WROTE);
  });
});

/* --------------------------------------------- the teacher's phase intro */

describe("the teacher's phase intro in the room and on the brief", () => {
  const OWN_INTRO = 'Facilities cannot see which desks are free. Find out what the team needs before you write the story.';

  it("draws the teacher's intro in the room's brief aside on an own Requirements", () => {
    useShell(
      { ...roomDesk(), phases: roomDesk().phases.map((one) => (one.key === 'requirements' ? summary('requirements', 'own', OWN_INTRO.slice(0, 60)) : one)) },
      [detail('requirements', { intro: OWN_INTRO, provenance: provenance('requirements', { rollup: 'own', intro: 'own' }) } as Partial<PhaseDetail>)],
    );
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).toContain(OWN_INTRO);
    expect(text()).not.toContain('Discover what the stakeholder needs and why.');
  });

  it('falls back to the summary intro when the shell holds no detail', () => {
    useShell({ ...roomDesk(), phases: roomDesk().phases.map((one) => (one.key === 'requirements' ? summary('requirements', 'own', 'Desks first.') : one)) });
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).toContain('Desks first.');
  });

  it("keeps the standing words where the intro is still the reference project's", () => {
    // A mixed Requirements whose intro the teacher kept: its words are the reference story's.
    useShell(roomDesk({ requirements: 'mixed' }), [
      detail('requirements', { intro: 'The reference intro.', provenance: provenance('requirements', { rollup: 'mixed', intro: 'reference', interview: 'own' }) } as Partial<PhaseDetail>),
    ]);
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).toContain('Discover what the stakeholder needs and why.');
    expect(text()).not.toContain('The reference intro.');
    // And a mixed summary with no detail says nothing about the intro.
    useShell({ ...roomDesk({ requirements: 'mixed' }), phases: roomDesk({ requirements: 'mixed' }).phases.map((one) => (one.key === 'requirements' ? summary('requirements', 'mixed', 'The reference intro.') : one)) });
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).not.toContain('The reference intro.');
    // A mixed phase whose intro the teacher wrote draws it.
    useShell(roomDesk({ requirements: 'mixed' }), [
      detail('requirements', { intro: 'Desks, not rooms.', provenance: provenance('requirements', { rollup: 'mixed', intro: 'own' }) } as Partial<PhaseDetail>),
    ]);
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).toContain('Desks, not rooms.');
  });

  it('keeps the standing words on a reference phase and outside the shell', () => {
    const reference = roomDesk({ requirements: 'reference' });
    useShell(reference, [detail('requirements', { intro: 'The reference intro.', provenance: provenance('requirements') } as Partial<PhaseDetail>)]);
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).toContain('Discover what the stakeholder needs and why.');
    expect(text()).not.toContain('The reference intro.');
    shell.state = null;
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(text()).toContain('Discover what the stakeholder needs and why.');
  });

  it("draws the teacher's intro on the case file", () => {
    useShell(roomDesk());
    const requirements = detail('requirements', { intro: OWN_INTRO, objectives: [], provenance: provenance('requirements', { rollup: 'own', intro: 'own' }) } as Partial<PhaseDetail>);
    render(<Brief phase={summary('requirements', 'own')} detail={requirements} onBegin={() => undefined} />);
    expect(text()).toContain(OWN_INTRO);
  });
});

/* ---------------------------------------------- the story desk examples */

const REFERENCE_EXAMPLES = /due yesterday|the task is listed|reminders and notifications/i;

function Desk() {
  const view = useStoryFrom(JSON.stringify({ ...EMPTY_STORY, criteria: [{ id: 'AC-1', given: '', when: '', then: '', tag: 'happy' }], scopeExclusions: [''] }), SPEC);
  return (
    <IssueDesk
      view={view}
      spec={SPEC}
      providedStories={[{ id: 'US-1', title: 'Find a free desk', persona: 'member', capability: 'to find a free desk', benefit: 'I can work' }]}
      projectTitle="RoomDesk"
      statusLabel="In progress"
      statusTone="accent"
      storyState="now"
      assignedTo="Learner"
      canRecord
      setStory={() => undefined}
      phaseId="phase-requirements"
      reviewOpen={false}
    />
  );
}

const placeholders = () => Array.from(host.querySelectorAll('[placeholder]')).map((one) => one.getAttribute('placeholder') ?? '');

describe('the story desk examples on a phase that is not the reference', () => {
  it('writes neutral criterion examples', () => {
    useShell(roomDesk());
    render(
      <ol>
        <CriterionCard
          criterion={{ id: 'AC-1', given: '', when: '', then: '' } as never}
          index={0}
          count={1}
          actions={{ set: () => undefined, move: () => undefined, remove: () => undefined } as never}
        />
      </ol>,
    );
    expect(placeholders().join(' | ')).not.toMatch(REFERENCE_EXAMPLES);
  });

  it('writes a neutral exclusion example', () => {
    useShell(roomDesk());
    render(<Desk />);
    const create = Array.from(host.querySelectorAll('button')).find((one) => /(Create (US-4|your)|Edit your) story/.test(one.textContent ?? ''));
    expect(create).toBeDefined();
    act(() => create!.click());
    expect(host.querySelector('[data-testid$="scope-1"]')).not.toBeNull();
    expect(placeholders().join(' | ')).not.toMatch(REFERENCE_EXAMPLES);
  });

  it('keeps the reference examples byte for byte on the reference project', () => {
    useShell(roomDesk({ requirements: 'reference' }));
    render(<Desk />);
    const create = Array.from(host.querySelectorAll('button')).find((one) => /(Create (US-4|your)|Edit your) story/.test(one.textContent ?? ''));
    expect(create).toBeDefined();
    act(() => create!.click());
    expect(placeholders()).toEqual(expect.arrayContaining(['a task due yesterday', 'the task is listed', 'reminders and notifications']));
  });
});

/* ------------------------------- the editor: Replace and its dialog */

function task(over: Partial<DraftTaskView> = {}): DraftTaskView {
  return {
    taskKey: INHERITED_TASK_KEY,
    order: 1,
    required: true,
    title: 'Requirements',
    brief: 'Write the story.',
    artefactType: 'user-story',
    artefactPath: null,
    checkKind: 'story',
    rubric: {
      passThreshold: DEFAULT_PASS_THRESHOLD,
      criteria: [
        { key: 'story_structure', title: 'Story structure', weight: 0.6, description: 'The story names a persona, a capability and a benefit.' },
        { key: 'scope_clarity', title: 'Scope', weight: 0.4, description: 'The story says what is out of scope.' },
      ],
    },
    objectives: [],
    owns: ['requirements/story.json'],
    authorable: true,
    notice: null,
    ...over,
  };
}

const REQUIREMENTS: DraftPhaseView = {
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  intro: 'Staff cannot find a free desk.',
  artifactKind: 'story',
  checkKind: 'story',
  tasks: [task()],
  blocksPublish: false,
  provenance: provenance('requirements', {
    rollup: 'reference',
    files: [{ path: 'requirements/backlog.md', provenance: 'reference' }],
    tasks: [{ taskKey: INHERITED_TASK_KEY, provenance: 'reference', titleEdited: false }],
    roomTask: 'reference',
  }),
};

/**
 * The written phase the replace door is read on. Requirements is drawn by the
 * five-step builder, which has no documents and no starter files; Design keeps
 * both, with a structured record beside its starter that the door refuses.
 */
const DESIGN: DraftPhaseView = {
  ...REQUIREMENTS,
  key: 'design',
  order: 2,
  title: 'Design',
  intro: 'Sketch the desk.',
  artifactKind: 'design',
  checkKind: 'design',
  tasks: [
    task({
      title: 'Design',
      brief: 'Design the desk.',
      artefactType: 'design-doc',
      artefactPath: null,
      checkKind: 'design',
      owns: ['docs/notes.md', 'design/board.json'],
    }),
  ],
  provenance: provenance('design', {
    rollup: 'reference',
    files: [{ path: 'docs/backlog.md', provenance: 'reference' }],
    tasks: [{ taskKey: INHERITED_TASK_KEY, provenance: 'reference', titleEdited: false }],
    roomTask: 'reference',
  }),
};

function version(phases: DraftPhaseView[] = [DESIGN]): DraftVersionView {
  return {
    projectId: 'p-mine',
    versionId: 'v-mine',
    version: '0.1.0',
    status: 'draft',
    slug: 'room-desk',
    title: 'RoomDesk',
    tagline: 'Book a desk',
    description: 'A copy made my own.',
    platformOwned: false,
    editable: true,
    phases,
    validation: null,
    supportedStacks: { python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE },
    createdAt: '2026-09-30T00:00:00.000Z',
    phaseSet: phaseSetFor(phases.map((one) => one.key), true),
  };
}

const REPORT = { tier: 'fast', ranAt: '2026-09-30T00:00:00.000Z', checks: [], passed: 0, failed: 0, notApplicable: 0, publishable: true, blocking: [], neutralSummary: null } as unknown as ValidationReport;
const result = (phase: DraftPhaseView): TaskMutationResult => ({ phase, validation: REPORT });

async function mount(view: DraftVersionView = version()) {
  draft.mockResolvedValue(view);
  await act(async () => {
    root.render(<ProjectEditor projectId="p-mine" versionId="v-mine" />);
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

/**
 * The same Design phase as the API sends it now: its one task is a design
 * task (the read-time view, here already converted), which the editor draws
 * in the six-step builder, its starting documents in the Starting point.
 */
const RECORD = 'design/design.json';
const DESIGN_RECORD: DraftPhaseView = {
  ...DESIGN,
  checkKind: 'design',
  tasks: [
    task({
      title: 'Design',
      brief: 'Design the desk.',
      artefactType: 'design-doc',
      artefactPath: RECORD,
      checkKind: 'design',
      owns: [RECORD, 'shared/contract/api.json'],
      design: { kind: 'design', record: RECORD, contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR },
    }),
  ],
};
const EMPTY_RECORD = '{\n  "entities": [],\n  "relations": [],\n  "operations": [],\n  "decisions": []\n}\n';
const recordRow = (content: string) => ({
  id: 'f-2', ownerKind: 'phase', phaseKey: 'design', path: RECORD, role: 'workspace', editable: true, language: 'json', size: content.length, sealed: false, content, notice: null,
});

describe("Replace on a design task's starting documents", () => {
  it('offers Replace for each document the design task mounts, and for no other', async () => {
    await mount(version([DESIGN_RECORD]));
    expect(byId('design-builder')).not.toBeNull();
    expect(byId(`phase-starter-replace-${RECORD}`)?.textContent).toContain('Replace');
    expect(byId('phase-starter-replace-shared/contract/api.json')?.textContent).toContain('Replace');
    expect(byId('phase-starter-replace-shared/contract/screens.json')).toBeNull();
    expect(byId('phase-starter-replace-docs/backlog.md')).toBeNull();
    expect(byId(`phase-starter-provenance-${RECORD}`)?.textContent).toBe("TaskTrackr's");
    // Beside the builder's one design, Add offers a concept quiz, in the door's own words.
    await click('project-add-task');
    expect(host.textContent).toContain(QUIZ_ONLY_ADD_REFUSAL);
  });

  it('sends the path and the bytes through files.replace, and the row then reads "Yours"', async () => {
    files.mockResolvedValue([recordRow(EMPTY_RECORD)]);
    const edited: DraftPhaseView = {
      ...DESIGN_RECORD,
      provenance: { ...DESIGN_RECORD.provenance!, rollup: 'mixed', tasks: [{ taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: false }], roomTask: 'other' },
    };
    replaceFile.mockResolvedValue({ ...result(edited), alsoReplacedIn: [] });
    await mount(version([DESIGN_RECORD]));
    await click(`phase-starter-replace-${RECORD}`);
    expect((byId('file-replace-content') as HTMLTextAreaElement).value).toBe(EMPTY_RECORD);
    const desk = EMPTY_RECORD.replace('"entities": []', '"entities": [{ "id": "E1", "name": "Desk", "kind": "class", "attributes": [], "responsibilities": [], "satisfies": [] }]');
    type(byId('file-replace-content'), desk);
    await click('file-replace-save');
    expect(replaceFile).toHaveBeenCalledWith('p-mine', 'v-mine', 'design', { path: RECORD, content: desk });
    expect(byId('file-replace-dialog')).toBeNull();
    expect(byId(`phase-starter-provenance-${RECORD}`)?.textContent).toBe('Yours');
  });
});

describe('a busy replace dialog the browser closes natively', () => {
  it('opens again, so a refusal is never printed into a closed dialog', async () => {
    let refuse: (err: unknown) => void = () => undefined;
    replaceFile.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)));
    await mount();
    await click('phase-file-replace-docs/backlog.md');
    type(byId('file-replace-content'), '# Architecture, revised\n');
    await click('file-replace-save');
    const dialog = byId('file-replace-dialog') as HTMLDialogElement;
    // The third Escape with focus on BODY: cancel is not cancelable, and the
    // browser closes the modal itself, firing `close`.
    await act(async () => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    });
    expect(byId('file-replace-dialog')?.hasAttribute('open')).toBe(true);
    await act(async () => {
      refuse(new Error('offline'));
    });
    expect(byId('file-replace-dialog')?.hasAttribute('open')).toBe(true);
    expect(byId('file-replace-error')).not.toBeNull();
  });

  it('keeps focus inside the dialog while the save is in flight', async () => {
    replaceFile.mockReturnValue(new Promise(() => undefined));
    await mount();
    await click('phase-file-replace-docs/backlog.md');
    type(byId('file-replace-content'), '# Architecture, revised\n');
    await click('file-replace-save');
    const dialog = byId('file-replace-dialog') as HTMLDialogElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes in step with React when it is not busy', async () => {
    await mount();
    await click('phase-file-replace-docs/backlog.md');
    const dialog = byId('file-replace-dialog') as HTMLDialogElement;
    await act(async () => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    });
    expect(byId('file-replace-dialog')).toBeNull();
    // And the same file's Replace opens it again.
    await click('phase-file-replace-docs/backlog.md');
    expect(byId('file-replace-dialog')?.hasAttribute('open')).toBe(true);
  });
});

/* -------------------------------------------- the inherited-task notice */

describe('the inherited-task notice', () => {
  it('says what is true now and promises no release', () => {
    expect(INHERITED_TASK_NOTICE).toMatch(/^Inherited from the project you copied\./);
    expect(INHERITED_TASK_NOTICE).not.toMatch(/arrives|next|soon|later|coming|future/i);
  });
});
