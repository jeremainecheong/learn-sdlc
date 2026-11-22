// @vitest-environment jsdom
/**
 * A learner on a teacher's project reads that project, not the reference
 * project's story.
 *
 * TaskTrackr's story words are absent from the kickers, the "Meet Dana" door,
 * the tours and the dashboard for everyone (`teacher-project-dashboard-copy` pins
 * that). This file covers the scaffolding that is only true of the reference
 * story (the story desk's words and placeholders, the Requirements headline,
 * the interview hint, the client-side draft checks, the Design board's
 * reference story rules) and the lessons. Those follow the phase's
 * provenance:
 *
 * - a RoomDesk learner (a teacher's copy, `scenario` not `reference`) reads no
 *   /tasktrackr|overdue|dana|osei/i on those surfaces, gets no client check,
 *   no lessons link, and on the last four phases the bridge notice naming the
 *   application the payload names;
 * - a TaskTrackr learner (`scenario: 'reference'`) reads the reference copy unchanged;
 * - a payload with no provenance is the reference only on the default project.
 *
 * The shell's project state is the seam: `useProjectMaybe` answers the
 * enrolment and the phase details a real shell would hold.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary } from '@learnsdlc/shared';

const shell = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => shell.state,
  useProject: () => {
    if (!shell.state) throw new Error('no provider');
    return shell.state;
  },
}));
const routed = vi.hoisted(() => ({ phaseKey: 'requirements' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workspace/phase-requirements',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ phaseKey: routed.phaseKey, phaseId: 'phase-requirements' }),
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
  WorkPage: ({ children, strip }: { children: ReactNode; strip?: ReactNode }) => (
    <main>
      {strip}
      {children}
    </main>
  ),
  PhaseStrip: () => null,
}));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/workspace/PhaseGateBanner', async (original) => ({
  ...(await original<typeof import('@/components/workspace/PhaseGateBanner')>()),
  ShellPhaseGateBanner: () => null,
}));
// The contradiction engine answers one stub warning whenever it is asked, so
// the test sees whether the Design room asked it at all.
vi.mock('@/components/workspace/panels/design/contradictions', async (original) => ({
  ...(await original<typeof import('@/components/workspace/panels/design/contradictions')>()),
  contractWarnings: () => [{ rule: 'ordering', operation: 'listRooms', criterionId: 'US-1/AC-1', text: 'A stub contradiction.' }],
}));
vi.mock('@/components/learn/LessonReader', () => ({
  LessonReader: ({ phaseKey }: { phaseKey: string }) => <article data-testid="lesson-reader">{phaseKey}</article>,
}));

import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { CriterionCard } from '@/components/workspace/panels/requirements/Criteria';
import { EMPTY_STORY } from '@/components/workspace/panels/requirements/story';
import { storyView, useStoryFrom } from '@/components/workspace/panels/requirements/useStory';
import { DEFAULT_DESIGN_FLOOR, DEFAULT_STORY_FLOOR } from '@learnsdlc/shared';

/** The phase's story spec: the floor every project's story is checked against. */
const SPEC = { id: 'US-4', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [{ id: 'US-1', title: 'Find a free room', persona: 'member', capability: 'to find a free room', benefit: 'I can meet' }] };
import { InterviewPanel } from '@/components/workspace/requirements/InterviewPanel';
import { requirementsHeadline } from '@/components/workspace/requirements/RequirementsWorkspace';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { Brief } from '@/components/phases/Brief';
import { ApiWorkbench } from '@/components/workspace/panels/design/ApiWorkbench';
import LessonPage from '@/app/(app)/learn/[phaseKey]/page';
import { lessonsVisibleFor, scenarioIsReference } from '@/lib/scenario';
import { renderToStaticMarkup } from 'react-dom/server';
import { useDesign, type DesignState } from '@/components/workspace/panels/design/useDesign';

/** The Design room's derived state, under whatever shell is set. */
function designState(): DesignState {
  let captured: DesignState | null = null;
  const files = { 'design/design.json': JSON.stringify({ entities: [], relations: [], operations: [], decisions: [] }) };
  function Probe() {
    captured = useDesign({
      serverFiles: Object.entries(files).map(([path, content]) => ({ path, content })),
      files,
      setFile: () => undefined,
      spec: { contracts: { api: true, screens: false }, sequence: false, stories: [{ id: 'US-1', title: 'Find a free room', line: 'As a member I want to find a free room' }], floor: DEFAULT_DESIGN_FLOOR },
      flushSave: async () => undefined,
      setNotice: () => undefined,
      setError: () => undefined,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error('the hook did not run');
  return captured;
}

const STORY_WORDS = /tasktrackr|overdue|dana|osei/i;
const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

function summary(key: PhaseKey, scenario?: PhaseSummary['scenario']): PhaseSummary {
  return {
    id: `phase-${key}`,
    key,
    order: KEYS.indexOf(key) + 1,
    title: key.charAt(0).toUpperCase() + key.slice(1),
    status: 'in_progress',
    ...(scenario ? { scenario } : {}),
  } as PhaseSummary;
}

function enrollment(
  title: string,
  scenario: PhaseSummary['scenario'] | undefined,
  projectIsDefault: boolean | undefined,
): EnrollmentView {
  return {
    id: 'enrol-1',
    projectSlug: title === 'TaskTrackr' ? 'reference-slug' : 'room-desk',
    projectTitle: `${title} — a project`,
    currentPhaseOrder: 1,
    completed: false,
    startedAt: '2026-09-30T00:00:00Z',
    completedAt: null,
    phases: KEYS.map((key) =>
      summary(key, key === 'requirements' || key === 'design' ? scenario : scenario === undefined ? undefined : 'reference'),
    ),
    ...(projectIsDefault === undefined ? {} : { projectIsDefault }),
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

function detail(key: PhaseKey, over: Partial<PhaseDetail> = {}): PhaseDetail {
  return {
    id: `phase-${key}`,
    key,
    title: key.charAt(0).toUpperCase() + key.slice(1),
    intro: 'This phase is about the room booking desk.',
    objectives: ['Build the desk.'],
    files: [],
    rubric: { passThreshold: 70, criteria: [] },
    ...over,
  } as unknown as PhaseDetail;
}

/** The shell's project state: an enrolment and the details it holds, by phase id. */
function useShell(enrol: EnrollmentView | null, details: PhaseDetail[] = []) {
  shell.state = {
    enrollment: enrol,
    details: Object.fromEntries(details.map((one) => [one.id, one])),
    loading: false,
  };
}

const ROOMDESK = () => enrollment('RoomDesk', 'own', false);
const TASKTRACKR = () => enrollment('TaskTrackr', 'reference', true);

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  shell.state = null;
  routed.phaseKey = 'requirements';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The story desk in both of its views, with the editor dialog open. */
function Desk({ review }: { review: boolean }) {
  const view = useStoryFrom(JSON.stringify({ ...EMPTY_STORY }), SPEC);
  return (
    <IssueDesk
      view={view}
      spec={SPEC}
      providedStories={SPEC.providedStories}
      projectTitle="RoomDesk"
      statusLabel="In progress"
      statusTone="accent"
      storyState="now"
      assignedTo="Learner"
      canRecord
      setStory={() => undefined}
      phaseId="phase-requirements"
      reviewOpen={review}
    />
  );
}

const interview = {
  state: null,
  draft: '',
  setDraft: () => undefined,
  outgoing: null,
  retry: async () => undefined,
  busy: false,
  error: '',
  absent: true,
  loading: false,
  scrollRef: { current: null },
  send: async () => undefined,
  reopen: () => undefined,
} as unknown as Parameters<typeof InterviewPanel>[0]['interview'];

function openStoryEditor() {
  const create = Array.from(host.querySelectorAll('button')).find((one) => /Create (US-4|your) story/.test(one.textContent ?? ''));
  expect(create).toBeDefined();
  act(() => create!.click());
}

describe('the predicate', () => {
  it('reads the roll-up, and an absent one as the reference only on the default project', () => {
    expect(scenarioIsReference({ scenario: 'reference' }, { projectIsDefault: false })).toBe(true);
    expect(scenarioIsReference({ scenario: 'mixed' }, { projectIsDefault: true })).toBe(false);
    expect(scenarioIsReference({ scenario: 'own' }, null)).toBe(false);
    expect(scenarioIsReference({}, { projectIsDefault: true })).toBe(true);
    expect(scenarioIsReference({}, { projectIsDefault: false })).toBe(false);
    expect(scenarioIsReference({}, {})).toBe(false);
    expect(lessonsVisibleFor(undefined, undefined)).toBe(false);
  });
});

describe('a RoomDesk learner', () => {
  it('reads no reference story word on the story desk, the editor or its placeholders, and its checks are the floor’s', () => {
    useShell(ROOMDESK());
    render(<Desk review={false} />);
    openStoryEditor();
    expect(text()).not.toMatch(STORY_WORDS);
    const placeholders = Array.from(host.querySelectorAll('[placeholder]')).map((one) => one.getAttribute('placeholder')).join(' ');
    expect(placeholders).not.toMatch(STORY_WORDS);
    render(<Desk review />);
    // The floor is the phase's own, not the reference story's rules, so every
    // project's learner sees it, under the one heading "Story checks".
    expect(text()).toContain('Story checks');
    expect(text()).not.toContain('Draft structure checks');
    expect(text()).not.toMatch(STORY_WORDS);
  });

  it('computes the client checks from the phase’s floor, and none without a story spec', () => {
    expect(storyView(JSON.stringify(EMPTY_STORY), undefined).results).toEqual([]);
    expect(storyView(JSON.stringify(EMPTY_STORY), SPEC).results.map((r) => r.id)).toEqual(['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']);
  });

  it('writes a neutral example into a criterion', () => {
    useShell(ROOMDESK());
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
    const placeholders = Array.from(host.querySelectorAll('[placeholder]')).map((one) => one.getAttribute('placeholder')).join(' ');
    expect(placeholders).not.toMatch(STORY_WORDS);
  });

  it('is told what to ask without the reference story, and the room is headed neutrally', () => {
    useShell(ROOMDESK());
    render(<InterviewPanel interview={interview} backlogHref="/workspace/phase-requirements/issue" />);
    act(() => byId('chat-details-toggle')!.click());
    expect(text()).not.toMatch(STORY_WORDS);
    expect(text()).toContain('Ask what the stakeholder needs and why');
    expect(requirementsHeadline(false)).not.toMatch(STORY_WORDS);
  });

  it('keeps the "Stakeholder interview" door, and loses it only when the phase holds no interview', () => {
    useShell(ROOMDESK(), [detail('requirements', { stakeholder: { name: 'Priya Nair', role: 'Facilities manager' } } as Partial<PhaseDetail>)]);
    render(<PhaseDocumentFrame phase={{ id: 'phase-requirements', key: 'requirements', title: 'Requirements' }} view="brief" title="Case file" />);
    expect(Array.from(host.querySelectorAll('nav a')).map((a) => a.textContent)).toContain('Stakeholder interview');
    useShell(ROOMDESK(), [detail('requirements', { stakeholder: null } as Partial<PhaseDetail>)]);
    render(<PhaseDocumentFrame phase={{ id: 'phase-requirements', key: 'requirements', title: 'Requirements' }} view="brief" title="Case file" />);
    expect(Array.from(host.querySelectorAll('nav a')).map((a) => a.textContent)).not.toContain('Stakeholder interview');
  });

  it('is told on the last four phases that the application is the reference project’s, by the payload’s name', () => {
    // True of a different story (RoomDesk) and of a TaskTrackr copy alike: it names the application and
    // says nothing about what the teacher's project lacks, which would read as a fault on a finished copy.
    const notice = "This phase uses TaskTrackr, LearnSDLC's reference application: its code, tests and deployment are TaskTrackr's.";
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as PhaseKey[]) {
      useShell(ROOMDESK(), [detail(key, { provenance: provenance(key, { application: 'TaskTrackr' }) } as Partial<PhaseDetail>)]);
      render(<PhaseBriefIntro phaseKey={key} />);
      expect(byId('phase-bridge-notice')?.textContent).toBe(notice);
    }
    // And on the case file.
    const implementation = detail('implementation', { provenance: provenance('implementation', { application: 'TaskTrackr' }) } as Partial<PhaseDetail>);
    render(<Brief phase={summary('implementation', 'reference')} detail={implementation} onBegin={() => undefined} />);
    expect(byId('brief-bridge-notice')?.textContent).toBe(notice);
    // Never on a written phase.
    useShell(ROOMDESK(), [detail('requirements', { provenance: provenance('requirements', { rollup: 'own' }) } as Partial<PhaseDetail>)]);
    render(<PhaseBriefIntro phaseKey="requirements" />);
    expect(byId('phase-bridge-notice')).toBeNull();
  });

  it('reads its teacher’s Design from the phase alone: the same stories and checks under any project', () => {
    useShell(ROOMDESK());
    const state = designState();
    expect(state.stories.map((one) => one.id)).toEqual(['US-1']);
    useShell(TASKTRACKR());
    const reference = designState();
    expect(reference.stories).toEqual(state.stories);
    expect(reference.results).toEqual(state.results);
  });

  it('has no link to a lesson of its teacher’s own phase, and cannot open one directly', () => {
    useShell(enrollment('RoomDesk', 'mixed', false));
    render(<ApiWorkbench files={{ 'shared/contract/api.json': JSON.stringify({ operations: [{ id: 'bookRoom', method: 'POST', path: '/rooms', success: {}, errors: [] }] }) }} setFile={() => undefined} />);
    expect(host.querySelector('a[href="/learn/design"]')).toBeNull();
    routed.phaseKey = 'requirements';
    render(<LessonPage />);
    expect(byId('lesson-reader')).toBeNull();
    expect(byId('lesson-hidden')).not.toBeNull();
    expect(text()).not.toMatch(STORY_WORDS);
  });
});

describe('a TaskTrackr learner', () => {
  it('reads the reference story\'s own words on the story desk', () => {
    useShell(TASKTRACKR());
    render(<Desk review={false} />);
    expect(text()).toContain('Create US-4 story');
    expect(text()).toContain('US-4 is your story to define. The supplied stories remain part of the project contract.');
    expect(text()).toContain('Keep US-4 connected to the customer’s evidence.');
    openStoryEditor();
    const placeholders = Array.from(host.querySelectorAll('[placeholder]')).map((one) => one.getAttribute('placeholder'));
    expect(placeholders).toEqual(
      expect.arrayContaining([
        'Overdue report',
        'person who runs tasktrackr every morning',
        'a report of the tasks that are overdue',
        'I catch what I missed before the day starts',
      ]),
    );
    render(<Desk review />);
    expect(text()).toContain('Story checks');
    expect(text()).toContain('Refine US-4');
  });

  it('keeps the interview hint and the headline', () => {
    useShell(TASKTRACKR());
    render(<InterviewPanel interview={interview} backlogHref="/workspace/phase-requirements/issue" />);
    act(() => byId('chat-details-toggle')!.click());
    expect(text()).toContain('Ask about the missing overdue report, collect examples, then turn the answers into US-4 and its acceptance criteria.');
    expect(requirementsHeadline(true)).toBe('Write US-4, the overdue report, with criteria a test can check');
  });

  it('still reads "Stakeholder interview" on the door with Dana Osei as the stakeholder', () => {
    useShell(TASKTRACKR(), [detail('requirements', { stakeholder: { name: 'Dana Osei', role: 'Operations lead' } } as Partial<PhaseDetail>)]);
    render(<PhaseDocumentFrame phase={{ id: 'phase-requirements', key: 'requirements', title: 'Requirements' }} view="brief" title="Case file" />);
    const door = Array.from(host.querySelectorAll('nav a')).find((a) => a.getAttribute('href') === '/workspace/phase-requirements/interview');
    expect(door?.textContent).toBe('Stakeholder interview');
  });

  it('gets no bridge notice on its own application, and keeps its lessons', () => {
    useShell(TASKTRACKR(), [detail('implementation', { provenance: provenance('implementation', { application: 'TaskTrackr' }) } as Partial<PhaseDetail>)]);
    render(<PhaseBriefIntro phaseKey="implementation" />);
    expect(byId('phase-bridge-notice')).toBeNull();
    render(<ApiWorkbench files={{ 'shared/contract/api.json': JSON.stringify({ operations: [{ id: 'completeTask', method: 'POST', path: '/tasks', success: {}, errors: [] }] }) }} setFile={() => undefined} />);
    expect(host.querySelector('a[href="/learn/design"]')).not.toBeNull();
    routed.phaseKey = 'design';
    render(<LessonPage />);
    expect(byId('lesson-reader')).not.toBeNull();
  });

  it('is the reference on an older API only because the project is the default', () => {
    useShell(enrollment('TaskTrackr', undefined, true));
    render(<Desk review={false} />);
    expect(text()).toContain('Create US-4 story');
    useShell(enrollment('RoomDesk', undefined, undefined));
    render(<Desk review={false} />);
    expect(text()).toContain('Create your story');
  });
});
