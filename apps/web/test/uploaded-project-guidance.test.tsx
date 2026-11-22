// @vitest-environment jsdom
/**
 * In a room that is not the reference project's (an uploaded
 * project), every line of guidance comes from the pack or is neutral.
 *
 * The tiny uploaded project "Deadline badge" is the example. Its Design room's
 * brief panel says the pack's own words ("one entity and one operation", "no
 * API contract, no screens and no sequence diagram"), so standing steps that
 * name TaskTrackr's deliverables (HTTP contract, Screen states), a mentor line
 * about "the contract and the request path", or an Implementation room's More
 * saying "Fill the marked gaps, across the API and the front end" for a
 * one-line helper fix would contradict it.
 *
 * The phase data below is the pack's own (pack v4, `deadline-badge/phases/
 * 02-design/phase.json` and `03-implementation/phase.json`): its intro and
 * objectives as uploaded, and the Implementation room's two files. Each case
 * also pins the reference project's words.
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
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The mentor's column: only its "details" (the purpose line) is read here.
vi.mock('@/components/chat/ChatSurface', () => ({
  ChatSurface: ({ identity, details }: { identity?: ReactNode; details?: ReactNode }) => (
    <div>
      {identity}
      <div data-testid="mentor-details">{details}</div>
    </div>
  ),
}));
vi.mock('@/components/workspace/mentor/AgenticPanel', () => ({ AgenticPanel: () => null }));

import { PhaseBriefIntro } from '@/components/workspace/PhaseBriefIntro';
import { Brief, MissionDetails } from '@/components/phases/Brief';
import { MergeCard } from '@/components/pr/MergeCard';
import { MentorSession, type PersonaThread } from '@/components/shell/PersonaPanel';
import { headlineFor, ownRoomHeadline } from '@/components/workspace/ide/derive';
import { prHeadline } from '@/components/pr/headline';
import { ownMentorPurpose, PHASE_EXPERIENCE } from '@/components/phases/experience';
import { PHASE_REVIEWER } from '@/lib/phase';

/* ------------------------------------------- the pack's own words (v4) */

const DESIGN_INTRO = 'Design the overdue rule before anyone codes it: one entity and one operation.';
const DESIGN_OBJECTIVES = ['Model one entity, Task', 'Define isOverdue(task, today) with its inputs and return', 'Trace the operation to US-1'];
const IMPLEMENTATION_INTRO = 'Fill one TODO in the overdue helper so the failing test passes.';
const IMPLEMENTATION_OBJECTIVES = ['Fill the TODO in isOverdue (US-1)', 'Make the visible test pass', 'Keep the no-due-date check as it is'];
const IMPLEMENTATION_FILES = [
  { path: 'web/src/lib/overdue.ts', editable: true, content: '' },
  { path: 'web/src/lib/overdue.test.ts', editable: false, content: '' },
  { path: 'web/src/lib/types.ts', editable: false, content: '' },
];
const TESTING_INTRO = 'Add one test that catches a wrong boundary.';
const DEPLOYMENT_INTRO = 'Fix one deployment setting, run the selfcheck, then run the drill and close the incident.';
const MAINTENANCE_INTRO = 'Change request CR-1: a completed task is never overdue. Change the helper and keep the rest.';

/** The reference project's words. */
const TASKTRACKR_DESIGN_STEPS = ['Story and boundary', 'Data model', 'HTTP contract', 'Screen states'];
const TASKTRACKR_DESIGN_PURPOSE = 'Make the contract and the request path agree.';
const TASKTRACKR_IMPLEMENTATION_LINE = 'Fill the marked gaps, across the API and the front end';
const TASKTRACKR_DESIGN_MISSION =
  'Decide the model, the contracts and one trade-off, and say what each decision gave up. The architect reads them; the contracts are what phase 3 checks the code against.';
/** Nothing an uploaded room reads may name these (unless its pack does). */
const TASKTRACKR_SHAPE = /HTTP contract|Screen states|API contract|sequence diagram|the API and the front end|contract and the request path|Models & sequences|TaskTrackr/;

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

function summary(key: PhaseKey, scenario: PhaseSummary['scenario'], intro?: string): PhaseSummary {
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
    scenario,
    ...(intro ? { intro } : {}),
  } as PhaseSummary;
}

/** An uploaded phase's provenance: every element the teacher's own, its room task not the reference's. */
function uploaded(key: PhaseKey): PhaseProvenanceView {
  return {
    phaseKey: key,
    referenceName: null,
    rollup: 'own',
    intro: 'own',
    interview: null,
    files: [],
    tasks: [{ taskKey: 'main', provenance: 'edited', titleEdited: false }],
    roomTask: 'other',
    ...(['implementation', 'testing', 'deployment', 'maintenance'].includes(key) ? { application: null } : {}),
  } as PhaseProvenanceView;
}

/** The reference project's provenance. */
function reference(key: PhaseKey): PhaseProvenanceView {
  return {
    phaseKey: key,
    referenceName: 'TaskTrackr',
    rollup: 'reference',
    intro: 'reference',
    interview: null,
    files: [],
    tasks: [{ taskKey: 'main', provenance: 'reference', titleEdited: false }],
    roomTask: 'reference',
    ...(['implementation', 'testing', 'deployment', 'maintenance'].includes(key) ? { application: 'TaskTrackr' } : {}),
  } as PhaseProvenanceView;
}

function detail(key: PhaseKey, over: Partial<PhaseDetail>): PhaseDetail {
  return {
    ...summary(key, over.provenance?.rollup ?? 'own'),
    intro: '',
    taskPanel: '',
    objectives: [],
    files: [],
    rubric: { passThreshold: 70, criteria: [{ key: 'model', title: 'Model', weight: 0.4, description: 'Task holds what the overdue rule needs.' }] },
    ...over,
  } as unknown as PhaseDetail;
}

const DESIGN_UPLOADED = detail('design', {
  intro: DESIGN_INTRO,
  objectives: DESIGN_OBJECTIVES,
  files: [{ path: 'design/design.json', editable: true, content: '' }] as PhaseDetail['files'],
  provenance: uploaded('design'),
});
const IMPLEMENTATION_UPLOADED = detail('implementation', {
  intro: IMPLEMENTATION_INTRO,
  objectives: IMPLEMENTATION_OBJECTIVES,
  files: IMPLEMENTATION_FILES as PhaseDetail['files'],
  provenance: uploaded('implementation'),
});

/** The learner's enrolment on the uploaded project, holding the given details. */
function onDeadlineBadge(details: PhaseDetail[]) {
  shell.state = {
    enrollment: {
      id: 'enrol-1',
      projectSlug: 'deadline-badge',
      projectTitle: 'Deadline badge — a tiny task tracker',
      currentPhaseOrder: 2,
      completed: false,
      startedAt: '2026-11-10T00:00:00Z',
      completedAt: null,
      phases: KEYS.map((key) => summary(key, 'own', details.find((one) => one.key === key)?.intro)),
      projectIsDefault: false,
    } as EnrollmentView,
    details: Object.fromEntries(details.map((one) => [one.id, one])),
    loading: false,
  };
}

/** The learner's enrolment on TaskTrackr, the platform's default project. */
function onTaskTrackr(details: PhaseDetail[]) {
  shell.state = {
    enrollment: {
      id: 'enrol-2',
      projectSlug: 'tasktrackr',
      projectTitle: 'TaskTrackr — a task manager you can run',
      currentPhaseOrder: 2,
      completed: false,
      startedAt: '2026-11-10T00:00:00Z',
      completedAt: null,
      phases: KEYS.map((key) => summary(key, 'reference')),
      projectIsDefault: true,
    } as EnrollmentView,
    details: Object.fromEntries(details.map((one) => [one.id, one])),
    loading: false,
  };
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));
const steps = () => Array.from(host.querySelectorAll('.phase-brief-intro ol li p')).map((one) => one.textContent);

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

/* ------------------------------------------------- the brief's intro aside */

describe('PhaseBriefIntro in the Design room', () => {
  it("draws the uploaded pack's objectives as the steps, its intro once, and no reference deliverable", () => {
    onDeadlineBadge([DESIGN_UPLOADED]);
    render(<PhaseBriefIntro phaseKey="design" />);
    expect(steps()).toEqual(DESIGN_OBJECTIVES);
    expect(text().split(DESIGN_INTRO).length - 1).toBe(1);
    expect(text()).not.toMatch(TASKTRACKR_SHAPE);
    expect(text()).not.toContain(TASKTRACKR_DESIGN_PURPOSE);
    expect(text()).not.toContain('screen contract');
    // The kicker names the learner's project; the closing line stays.
    expect(text()).toContain('DESIGN / DEADLINE BADGE');
    expect(text()).toContain('Your saved work and real review evidence carry forward to the next phase.');
  });

  it('draws no steps heading and no empty list where the pack gives no objectives', () => {
    onDeadlineBadge([{ ...DESIGN_UPLOADED, objectives: [] }]);
    render(<PhaseBriefIntro phaseKey="design" />);
    expect(host.querySelector('.phase-brief-intro ol')).toBeNull();
    expect(text()).not.toContain('From a need to a promise');
  });

  it("leaves the phase's objectives out while the room works a teacher's authored task", () => {
    onDeadlineBadge([IMPLEMENTATION_UPLOADED]);
    render(<PhaseBriefIntro phaseKey="implementation" phaseSteps={false} />);
    expect(host.querySelector('.phase-brief-intro ol')).toBeNull();
    render(<PhaseBriefIntro phaseKey="implementation" />);
    expect(steps()).toEqual(IMPLEMENTATION_OBJECTIVES);
    expect(text()).toContain('Make the code work.');
    expect(text()).not.toContain('Make the contract work.');
  });

  it("keeps the reference project's words exactly", () => {
    onTaskTrackr([detail('design', { intro: 'The reference intro.', objectives: ['A reference objective'], provenance: reference('design') })]);
    render(<PhaseBriefIntro phaseKey="design" />);
    expect(steps()).toEqual(TASKTRACKR_DESIGN_STEPS);
    expect(text()).toContain('Make the pieces agree.');
    expect(text()).toContain('Turn the approved stories into data, operations, and a screen contract.');
    expect(text()).toContain(TASKTRACKR_DESIGN_PURPOSE);
    expect(text()).not.toContain('A reference objective');
    // And on authored-task rooms of the reference project (its steps are not the phase's objectives).
    render(<PhaseBriefIntro phaseKey="design" phaseSteps={false} />);
    expect(steps()).toEqual(TASKTRACKR_DESIGN_STEPS);
    // Outside the shell (a teacher's preview, a component mount).
    shell.state = null;
    render(<PhaseBriefIntro phaseKey="design" />);
    expect(steps()).toEqual(TASKTRACKR_DESIGN_STEPS);
    expect(text()).toContain(TASKTRACKR_DESIGN_PURPOSE);
  });
});

/* ------------------------------------------------------ the strip's line */

describe("the room's one line (More, the strip) and the pull request's title", () => {
  it('names the one editable file on an uploaded Implementation room strip, and its pull request reads the intro first sentence', () => {
    expect(headlineFor('implementation', IMPLEMENTATION_FILES as PhaseDetail['files'], false, { intro: IMPLEMENTATION_INTRO })).toBe(
      'Work in web/src/lib/overdue.ts',
    );
    // The pull request is titled by the intro's first sentence, without its full stop, as every phase is.
    expect(prHeadline(IMPLEMENTATION_UPLOADED, false)).toBe('Fill one TODO in the overdue helper so the failing test passes');
  });

  it('counts the files where there are several, and reads the intro where there are none', () => {
    const two = [
      { path: 'a/one.ts', editable: true, content: '' },
      { path: 'a/two.ts', editable: true, content: '' },
    ] as PhaseDetail['files'];
    expect(ownRoomHeadline('implementation', two, IMPLEMENTATION_INTRO)).toBe('Work in the 2 editable files');
    expect(ownRoomHeadline('implementation', [], IMPLEMENTATION_INTRO)).toBe(IMPLEMENTATION_INTRO);
  });

  it("reads every other uploaded phase's own intro, on one line", () => {
    const none = [] as PhaseDetail['files'];
    expect(headlineFor('design', none, false, { intro: DESIGN_INTRO })).toBe(DESIGN_INTRO);
    expect(headlineFor('testing', none, false, { intro: TESTING_INTRO })).toBe(TESTING_INTRO);
    expect(headlineFor('deployment', none, false, { intro: DEPLOYMENT_INTRO })).toBe(DEPLOYMENT_INTRO);
    expect(headlineFor('maintenance', none, false, { intro: MAINTENANCE_INTRO })).toBe(MAINTENANCE_INTRO);
    expect(headlineFor('testing', none, false, { intro: 'First line\nof one paragraph.\n\nA second paragraph.' })).toBe('First line of one paragraph.');
    // An empty intro reads a neutral line, never the reference's.
    for (const key of KEYS) expect(headlineFor(key, none, false, { intro: '' })).not.toMatch(TASKTRACKR_SHAPE);
    // Requirements keeps its neutral line, which fits any project.
    expect(headlineFor('requirements', none, false, { intro: 'Anything' })).toBe('Write your story, with criteria a test can check');
  });

  it("keeps the reference project's lines exactly", () => {
    expect(headlineFor('implementation', IMPLEMENTATION_FILES as PhaseDetail['files'])).toBe(TASKTRACKR_IMPLEMENTATION_LINE);
    expect(headlineFor('implementation', IMPLEMENTATION_FILES as PhaseDetail['files'], true, null)).toBe(TASKTRACKR_IMPLEMENTATION_LINE);
    expect(headlineFor('design', [], true)).toBe('Name every operation and every screen, and say what each promises');
    expect(headlineFor('maintenance', [], true)).toBe('Change the contract without breaking what depends on it');
    // An authored task in a reference room (reference false, no own words) keeps the reference line too.
    expect(headlineFor('implementation', [], false)).toBe(TASKTRACKR_IMPLEMENTATION_LINE);
    expect(prHeadline({ ...IMPLEMENTATION_UPLOADED, provenance: reference('implementation') }, true)).toBe('Make overdue.ts true to the contracts');
  });
});

/* ------------------------------------------------------------ the mentor */

function thread(key: PhaseKey, lesson = false): PersonaThread {
  return {
    phaseKey: key,
    phaseStateId: `phase-${key}`,
    lesson,
    reviewer: PHASE_REVIEWER[key],
    name: PHASE_EXPERIENCE[key].name,
    ask: 'Ask',
    messages: [],
    busy: false,
    asked: 0,
  } as unknown as PersonaThread;
}

describe("the mentor's purpose line", () => {
  it("is the uploaded phase's intro; the mentor's name stays", () => {
    onDeadlineBadge([DESIGN_UPLOADED]);
    render(<MentorSession thread={thread('design')} header={false} />);
    const details = host.querySelector('[data-testid="mentor-details"]')?.textContent ?? '';
    expect(details).toContain(`${DESIGN_INTRO} Guided conversations offer hints and questions.`);
    expect(details).not.toContain(TASKTRACKR_DESIGN_PURPOSE);
    expect(text()).toContain('Arlo');
  });

  it("keeps the reference project's line, and a lesson's", () => {
    onTaskTrackr([detail('design', { intro: 'The reference intro.', provenance: reference('design') })]);
    render(<MentorSession thread={thread('design')} header={false} />);
    expect(host.querySelector('[data-testid="mentor-details"]')?.textContent).toContain(
      `${TASKTRACKR_DESIGN_PURPOSE} Guided conversations offer hints and questions.`,
    );
    onDeadlineBadge([DESIGN_UPLOADED]);
    render(<MentorSession thread={thread('design', true)} header={false} />);
    expect(host.querySelector('[data-testid="mentor-details"]')?.textContent).toContain(TASKTRACKR_DESIGN_PURPOSE);
  });

  it('ends as a sentence, and is empty without an intro', () => {
    expect(ownMentorPurpose('Fix the setting')).toBe('Fix the setting.');
    expect(ownMentorPurpose('Fix the setting…')).toBe('Fix the setting…');
    expect(ownMentorPurpose('One.\n\nTwo.')).toBe('One.');
    expect(ownMentorPurpose('')).toBe('');
    expect(ownMentorPurpose(null)).toBe('');
  });
});

/* ----------------------------------- the fold "Mission and review criteria" */

describe('the fold "Mission and review criteria"', () => {
  it('reads no reference mission line in an uploaded room; its objectives stay', () => {
    render(<MissionDetails phase={{ key: 'design' }} detail={DESIGN_UPLOADED} lessons={false} />);
    expect(text()).not.toContain(TASKTRACKR_DESIGN_MISSION);
    expect(text()).not.toMatch(TASKTRACKR_SHAPE);
    expect(text()).toContain('Your mission');
    for (const objective of DESIGN_OBJECTIVES) expect(text()).toContain(objective);
    expect(text()).toContain('What you will produce');
    expect(text()).toContain('Review criteria');
  });

  it('leaves the mission section out when it would have nothing to say', () => {
    render(<MissionDetails phase={{ key: 'design' }} detail={{ ...DESIGN_UPLOADED, objectives: [] }} lessons={false} />);
    expect(host.querySelector('[data-testid="phase-mission-mission"]')).toBeNull();
    expect(host.querySelector('[data-testid="phase-mission-review"]')).not.toBeNull();
  });

  it("keeps the reference project's mission line", () => {
    render(<MissionDetails phase={{ key: 'design' }} detail={detail('design', { intro: 'The reference intro.', provenance: reference('design') })} lessons={false} />);
    expect(text()).toContain(TASKTRACKR_DESIGN_MISSION);
    // And a detail with no provenance (an older API).
    render(<MissionDetails phase={{ key: 'design' }} detail={detail('design', { intro: 'Older.' })} lessons={false} />);
    expect(text()).toContain(TASKTRACKR_DESIGN_MISSION);
  });
});

/* ------------------------------------------------- the merged card's next */

describe("the merged pull request's next phase", () => {
  const card = (next: PhaseSummary) => (
    <MergeCard
      pr="PR-3"
      merged
      gateMet
      score={null}
      gate={70}
      attempt={1}
      reason=""
      reflection={null}
      next={next}
      nextHref="/workspace/phase-testing"
      busy={false}
      submitLabel="Submit again"
      onMerge={async () => undefined}
      onSubmitAgain={() => undefined}
      commitMessage=""
      setCommitMessage={() => undefined}
    />
  );

  it("says what an uploaded next phase's own intro says", () => {
    render(card(summary('testing', 'own', TESTING_INTRO)));
    expect(text()).toContain(TESTING_INTRO);
    expect(text()).not.toContain('Write one test per criterion and see it fail before it passes.');
  });

  it("keeps the reference project's purpose", () => {
    render(card(summary('testing', 'reference', 'The reference intro.')));
    expect(text()).toContain('Write one test per criterion and see it fail before it passes.');
  });
});

/* ------------------------------------------------------- the case file page */

describe('the case file page (/brief)', () => {
  it("reads no reference mission line and no reference drawings for an uploaded phase", () => {
    onDeadlineBadge([DESIGN_UPLOADED]);
    render(<Brief phase={summary('design', 'own')} detail={DESIGN_UPLOADED} onBegin={() => undefined} />);
    expect(text()).not.toContain(TASKTRACKR_DESIGN_MISSION);
    expect(text()).not.toContain('What it becomes');
    expect(text()).toContain(DESIGN_INTRO);
    for (const objective of DESIGN_OBJECTIVES) expect(text()).toContain(objective);
  });

  it("keeps the reference project's mission line and drawings", () => {
    const tasktrackr = detail('design', { intro: 'The reference intro.', provenance: reference('design') });
    onTaskTrackr([tasktrackr]);
    render(<Brief phase={summary('design', 'reference')} detail={tasktrackr} onBegin={() => undefined} />);
    expect(text()).toContain(TASKTRACKR_DESIGN_MISSION);
    expect(text()).toContain('What it becomes');
    expect(text()).toContain('Class and component diagrams');
  });
});
