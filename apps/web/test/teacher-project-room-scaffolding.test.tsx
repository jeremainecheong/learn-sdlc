// @vitest-environment jsdom
/**
 * Which reference-only scaffolding a teacher's project keeps, and why.
 *
 * - The Design room's checks are the phase's own floor, and its forms offer
 *   the phase's own stories, so a teacher's Design draws no reference word.
 * - The room's own scaffolding (story desk, headline, client checks) is keyed
 *   on the room task (`PhaseProvenanceView.roomTask`), not the phase roll-up:
 *   a teacher who only rewrote the intro keeps the reference story desk.
 * - The IDE page's Requirements headline follows the same rule.
 * - A Requirements room with no interview draws no interview tab and opens on
 *   the backlog.
 * - A focus refresh keeps the teacher's whole intro (the summary carries at
 *   most 400 characters of it).
 * - The bridge notice reads the enrolment's default flag, not the title.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workspace/phase-requirements',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ phaseId: 'phase-requirements' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/workspace/panels/design/contradictions', async (original) => ({
  ...(await original<typeof import('@/components/workspace/panels/design/contradictions')>()),
  contractWarnings: () => [{ rule: 'ordering', operation: 'listRooms', criterionId: 'US-1/AC-1', text: 'A stub contradiction.' }],
}));

import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { EMPTY_STORY } from '@/components/workspace/panels/requirements/story';
import { useStoryFrom } from '@/components/workspace/panels/requirements/useStory';
import { DEFAULT_STORY_FLOOR } from '@learnsdlc/shared';
/** The phase's story spec, as the API sends it on a story-kind Requirements phase. */
const SPEC = { id: 'RD-1', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] };

import { InterviewPanel } from '@/components/workspace/requirements/InterviewPanel';
import { RequirementsTabs, requirementsPane } from '@/components/workspace/requirements/RequirementsWorkspace';
import { ChecksPanel } from '@/components/workspace/panels/design/ChecksPanel';
import { OperationsCard } from '@/components/workspace/panels/design/OperationsCard';
import { useDesign, type DesignState } from '@/components/workspace/panels/design/useDesign';
import { DEFAULT_DESIGN_FLOOR, designFloorIds, type DesignOperation } from '@learnsdlc/shared';
import { headlineFor } from '@/components/workspace/ide/derive';
import { PHASE_SPEC } from '@/components/phases/spec';
import { bridgeApplication } from '@/lib/scenario';
import { keepHeldDetail } from '@/lib/useProject';

const STORY_WORDS = /tasktrackr|overdue|dana|osei/i;
const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

function enrollment(title: string, scenario: PhaseSummary['scenario'], projectIsDefault: boolean): EnrollmentView {
  return {
    id: 'enrol-1',
    projectSlug: 'some-project',
    projectTitle: `${title} — a project`,
    currentPhaseOrder: 1,
    completed: false,
    startedAt: '2026-09-30T00:00:00Z',
    completedAt: null,
    phases: KEYS.map((key, at) => ({ id: `phase-${key}`, key, order: at + 1, title: key, status: 'in_progress', scenario })),
    projectIsDefault,
  } as unknown as EnrollmentView;
}

function provenance(key: PhaseKey, over: Partial<PhaseProvenanceView> = {}): PhaseProvenanceView {
  return {
    phaseKey: key,
    referenceName: 'TaskTrackr',
    rollup: 'mixed',
    intro: 'own',
    interview: 'reference',
    files: [],
    tasks: [],
    roomTask: 'reference',
    ...over,
  };
}

function detail(key: PhaseKey, over: Partial<PhaseDetail> = {}): PhaseDetail {
  return { id: `phase-${key}`, key, title: key, intro: 'Intro.', files: [], ...over } as unknown as PhaseDetail;
}

function useShell(enrol: EnrollmentView | null, details: PhaseDetail[] = []) {
  shell.state = { enrollment: enrol, details: Object.fromEntries(details.map((one) => [one.id, one])), loading: false };
}

const ROOMDESK = () => enrollment('RoomDesk', 'own', false);
const TASKTRACKR = () => enrollment('TaskTrackr', 'reference', true);

/** A teacher's Design phase: its own story and the default floor. */
const DESIGN_SPEC = { contracts: { api: true, screens: true }, sequence: true, stories: [{ id: 'RD-1', title: 'Find a free room', line: 'As a member I want to find a free room' }], floor: DEFAULT_DESIGN_FLOOR };

function designState(operations: DesignOperation[] = []): DesignState {
  let captured: DesignState | null = null;
  const files = { 'design/design.json': JSON.stringify({ entities: [], relations: [], operations, decisions: [] }) };
  function Probe() {
    captured = useDesign({
      serverFiles: Object.entries(files).map(([path, content]) => ({ path, content })),
      files,
      setFile: () => undefined,
      spec: DESIGN_SPEC,
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

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));

beforeEach(() => {
  shell.state = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Desk() {
  const view = useStoryFrom(JSON.stringify({ ...EMPTY_STORY }), SPEC);
  return (
    <IssueDesk
      view={view}
      spec={SPEC}
      providedStories={[{ id: 'US-1', title: 'Find a free room', persona: 'member', capability: 'to find a free room', benefit: 'I can meet' }]}
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

const interview = {
  state: null, draft: '', setDraft: () => undefined, outgoing: null, retry: async () => undefined, busy: false,
  error: '', absent: true, loading: false, scrollRef: { current: null }, send: async () => undefined, reopen: () => undefined,
} as unknown as Parameters<typeof InterviewPanel>[0]['interview'];

describe('the Design room’s checks (blocker)', () => {
  it('are the phase’s own floor, and draw no reference word on a teacher’s Design', () => {
    useShell(ROOMDESK());
    const own = designState();
    expect(own.results.map((r) => r.id)).toEqual(designFloorIds(DESIGN_SPEC));
    render(<ChecksPanel results={own.results} floor={DESIGN_SPEC.floor} contracts={DESIGN_SPEC.contracts} sequence={DESIGN_SPEC.sequence} />);
    expect(text()).not.toMatch(STORY_WORDS);
    expect(text()).not.toMatch(/US-\d|lists\.id|due date/);
    expect(text()).toContain('Story not traced by any operation or entity: RD-1');
  });

  it('are the same whatever the shell says the Design room task is', () => {
    useShell(TASKTRACKR(), [detail('design', { provenance: provenance('design', { rollup: 'reference', roomTask: 'other' }) } as Partial<PhaseDetail>)]);
    const keyed = designState().results;
    useShell(ROOMDESK());
    expect(designState().results).toEqual(keyed);
  });
});

describe('the room task is the key for the room’s scaffolding (major)', () => {
  it('keeps the reference story desk when only the intro is the teacher’s', () => {
    useShell(enrollment('RoomDesk', 'mixed', false), [detail('requirements', { provenance: provenance('requirements') } as Partial<PhaseDetail>)]);
    render(<Desk />);
    expect(text()).toContain('Create US-4 story');
  });

  it('drops it when the room task is the teacher’s, even with a reference roll-up', () => {
    useShell(TASKTRACKR(), [detail('requirements', { provenance: provenance('requirements', { rollup: 'reference', roomTask: 'other' }) } as Partial<PhaseDetail>)]);
    render(<Desk />);
    expect(text()).toContain('Create your story');
  });

  it('keeps the interview hint on the roll-up', () => {
    useShell(enrollment('RoomDesk', 'mixed', false), [detail('requirements', { provenance: provenance('requirements') } as Partial<PhaseDetail>)]);
    render(<InterviewPanel interview={interview} backlogHref="/workspace/phase-requirements/issue" />);
    act(() => host.querySelector<HTMLElement>('[data-testid="chat-details-toggle"]')!.click());
    expect(text()).not.toMatch(STORY_WORDS);
  });
});

describe('the IDE page’s Requirements headline (major)', () => {
  it('is neutral off the reference room task, and the reference’s otherwise', () => {
    expect(headlineFor('requirements', [], false)).not.toMatch(STORY_WORDS);
    expect(headlineFor('requirements', [], false)).not.toMatch(/US-\d/);
    expect(headlineFor('requirements', [])).toBe('Write US-4, the overdue report, with criteria a test can check');
    expect(headlineFor('design', [], false)).toBe(headlineFor('design', []));
  });
});

describe('a Requirements room with no interview (major)', () => {
  it('draws no interview tab and opens on the backlog', () => {
    expect(requirementsPane('/workspace/p/interview', null, true)).toBe('backlog');
    expect(requirementsPane('/workspace/p', null, true)).toBe('backlog');
    expect(requirementsPane('/workspace/p', null, false)).toBe('interview');
    expect(requirementsPane('/workspace/p/issue', null, false)).toBe('backlog');
    render(<RequirementsTabs base="/workspace/p" active="backlog" noInterview onKeyDown={() => undefined} onSelect={() => undefined} />);
    expect(text()).not.toContain('Stakeholder interview');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
    render(<RequirementsTabs base="/workspace/p" active="interview" noInterview={false} onKeyDown={() => undefined} onSelect={() => undefined} />);
    expect(text()).toContain('Stakeholder interview');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
});

describe('a focus refresh (major)', () => {
  it('keeps the teacher’s whole intro rather than the summary’s opening', () => {
    const whole = 'x'.repeat(900);
    const held = detail('requirements', { intro: whole, status: 'in_progress' } as Partial<PhaseDetail>);
    const merged = keepHeldDetail(held, { id: 'phase-requirements', key: 'requirements', order: 1, title: 'Requirements', status: 'submitted', intro: `${'x'.repeat(399)}…` } as unknown as PhaseSummary);
    expect(merged.intro).toHaveLength(900);
    expect(merged.status).toBe('submitted');
  });
});

describe('the bridge notice (minor)', () => {
  it('reads the default flag, so a copy titled after the reference still gets it', () => {
    expect(bridgeApplication({ application: 'TaskTrackr' }, { projectIsDefault: false, projectTitle: 'TaskTrackr — Section 2' })).toBe('TaskTrackr');
    expect(bridgeApplication({ application: 'TaskTrackr' }, { projectIsDefault: true, projectTitle: 'Anything' })).toBeNull();
  });
});

describe('the Requirements evidence line (minor)', () => {
  it('names no reference story id', () => {
    expect(PHASE_SPEC.requirements.drawn.map((one) => one.detail).join(' ')).not.toMatch(/US-\d/);
  });
});

describe('the Design forms’ other reference switches (minor)', () => {
  const overdue: DesignOperation[] = [{ id: 'O1', name: 'list_overdue(today)', inputs: [], returns: '', errors: [], satisfies: [] }];
  it('offer only the phase’s own stories and no reference hint, on any project', () => {
    for (const enrol of [ROOMDESK(), TASKTRACKR()]) {
      useShell(enrol);
      render(<OperationsCard design={designState(overdue)} />);
      expect(text()).not.toMatch(/US-\d/);
      expect(text()).toContain('RD-1');
      expect(text()).not.toMatch(/due == today|task due today/);
      const placeholders = Array.from(host.querySelectorAll('[placeholder]')).map((one) => one.getAttribute('placeholder')).join(' ');
      expect(placeholders).not.toMatch(STORY_WORDS);
    }
  });
});

describe('the story desk’s interview door (minor)', () => {
  it('is drawn only while the phase holds an interview', () => {
    useShell(ROOMDESK(), [detail('requirements', { stakeholder: null } as Partial<PhaseDetail>)]);
    render(<Desk />);
    expect(host.querySelector('a[href="/workspace/phase-requirements/interview"]')).toBeNull();
    useShell(ROOMDESK(), [detail('requirements', { stakeholder: { name: 'Priya Nair', role: 'Facilities manager' } } as Partial<PhaseDetail>)]);
    render(<Desk />);
    expect(host.querySelector('a[href="/workspace/phase-requirements/interview"]')?.textContent).toBe('Stakeholder interview');
  });
});
