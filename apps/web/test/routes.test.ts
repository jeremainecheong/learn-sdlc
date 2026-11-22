// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';
import {
  briefHref,
  doorWithTasks,
  phaseDoorHref,
  phaseHref,
  phaseDocHref,
  phaseDocLabel,
  phaseWorkHref,
  quizHref,
  roomHref,
} from '@/components/shell/routes';
import { taskView } from './fixtures';

/**
 * The one door.
 *
 * Every phase opens its room in one step: Requirements the interview,
 * the others their room, first visit or return, in any tab. The room is fixed
 * per phase. The case file page is a link from the rooms, never a door.
 */
const phase = (order: number, key: PhaseSummary['key'], extra: Partial<PhaseSummary> = {}): PhaseSummary => ({
  id: `p${order}`,
  key,
  order,
  title: key,
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
  ...extra,
});

const SIX: PhaseSummary[] = [
  phase(1, 'requirements'),
  phase(2, 'design'),
  phase(3, 'implementation'),
  phase(4, 'testing'),
  phase(5, 'deployment'),
  phase(6, 'maintenance'),
];

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('roomHref', () => {
  it('names one room per phase: interview, design, the IDE three times, change', () => {
    expect(SIX.map(roomHref)).toEqual([
      '/workspace/p1/interview',
      '/workspace/p2/design',
      '/workspace/p3',
      '/workspace/p4',
      '/workspace/p5',
      '/workspace/p6/change',
    ]);
  });

  it('sends a locked phase to the list, where the reason is written', () => {
    expect(roomHref(phase(3, 'implementation', { status: 'locked' }))).toBe('/phases');
  });

  it('a reference Maintenance still routes to the change room', () => {
    expect(roomHref({ id: 'p6', key: 'maintenance', status: 'in_progress', artifactKind: 'code', provenance: { application: 'tasktrackr' } } as never)).toBe('/workspace/p6/change');
  });
});

describe('phaseDoorHref', () => {
  const ROOMS = ['/workspace/p1/interview', '/workspace/p2/design', '/workspace/p3', '/workspace/p4', '/workspace/p5', '/workspace/p6/change'];

  it('opens every phase\'s room on the first visit, with nothing in front of it', () => {
    expect(SIX.map((p) => phaseDoorHref(p))).toEqual(ROOMS);
    for (const p of SIX) expect(phaseDoorHref(p)).not.toMatch(/\/brief$/);
    // The case file page is still where its links point.
    expect(briefHref(SIX[0])).toBe('/workspace/p1/brief');
  });

  it('opens the same room on a return visit, after a submission and after a pass', () => {
    expect(phaseDoorHref(phase(1, 'requirements', { attempts: 1 }))).toBe('/workspace/p1/interview');
    expect(phaseDoorHref(phase(3, 'implementation', { attempts: 2, status: 'passed' }))).toBe('/workspace/p3');
    expect(phaseDoorHref(phase(2, 'design', { attempts: 0, status: 'passed' }))).toBe('/workspace/p2/design');
  });

  it('reads nothing from the tab: a new tab and an old Begin flag answer the same', () => {
    const p = phase(2, 'design');
    const before = phaseDoorHref(p);
    // A flag a case file page's Begin could have written (lsdlc_brief:<id>).
    window.sessionStorage.setItem('lsdlc_brief:p2', '1');
    expect(phaseDoorHref(p)).toBe(before);
    window.sessionStorage.clear();
    expect(phaseDoorHref(p)).toBe('/workspace/p2/design');
    // And asking the door writes nothing either.
    expect(window.sessionStorage.length).toBe(0);
  });

  it('treats a phase with no attempts count as any other', () => {
    const { attempts: _drop, ...bare } = phase(2, 'design');
    expect(phaseDoorHref(bare)).toBe('/workspace/p2/design');
  });

  it('opens Requirements at the interview regardless of attempts or missing counts', () => {
    for (const attempts of [undefined, 0, 1, 5]) {
      for (const status of ['in_progress', 'submitted', 'passed'] as const) {
        expect(phaseDoorHref(phase(1, 'requirements', { attempts, status }))).toBe('/workspace/p1/interview');
      }
    }
  });

  it('never opens a locked phase', () => {
    for (const p of SIX) {
      const locked = { ...p, status: 'locked' as const, attempts: 3 };
      expect(roomHref(locked)).toBe('/phases');
      expect(phaseDoorHref(locked)).toBe('/phases');
      expect(phaseHref(locked)).toBe('/phases');
    }
  });

  it('is what phaseHref means now, so the sidebar and the strip follow the same rule', () => {
    for (const p of SIX) expect(phaseHref(p)).toBe(phaseDoorHref(p));
    expect(phaseHref(phase(1, 'requirements', { attempts: 1 }))).toBe('/workspace/p1/interview');
  });
});

/**
 * The door a quiz reaches.
 *
 * Every other room is chosen by phase key and by nothing else (`roomHref`
 * is a switch on `PHASE_META[key].order` and `phaseDocHref` is another) and
 * nothing under `app/` or `components/workspace/` reads a task's
 * `artefactType`. A quiz is a task with a room of its own, so the door has
 * to know the phase's task list.
 *
 * The rule is narrow on purpose and the first test is what pins it: a phase
 * holding a quiz still holds a required task of another kind, and that task's
 * room is where the learner writes, runs and submits. Only when the quiz is the
 * **only** thing in the phase still to pass does the door go there instead. A
 * caller with no task list, and a phase whose list holds no quiz, get the
 * phase-key href, for all six keys.
 */
const task = taskView;

const quiz = (over: Partial<PhaseTaskView> & { key: string; order: number }) =>
  task({ artefactType: 'quiz', evidence: 'automated', required: false, ...over });

describe('the quiz door', () => {
  it('names a quiz room by task, and a bare room without one', () => {
    expect(quizHref({ id: 'p3' }, 'concepts')).toBe('/workspace/p3/quiz?task=concepts');
    expect(quizHref({ id: 'p3' })).toBe('/workspace/p3/quiz');
    // A key is a URL component, not a fragment of one.
    expect(quizHref({ id: 'p3' }, 'a b/c')).toBe('/workspace/p3/quiz?task=a%20b%2Fc');
  });

  it('produces the identical href for all six keys when the phase has no quiz', () => {
    const before = SIX.map((p) => phaseDoorHref(p));
    const withTasks = SIX.map((p) =>
      phaseDoorHref(
        { ...p, tasks: [task({ key: 'main', order: 1 }), task({ key: 'scope', order: 2, required: false })] },
      ),
    );
    expect(withTasks).toEqual(before);
    // And an empty list is the same question as no list at all.
    expect(SIX.map((p) => phaseDoorHref({ ...p, tasks: [] }))).toEqual(before);
  });

  it('leaves the phase in its own room while its own work is still open', () => {
    const p = {
      ...phase(3, 'implementation', { attempts: 2 }),
      tasks: [task({ key: 'main', order: 1 }), quiz({ key: 'concepts', order: 2 })],
    };
    expect(phaseDoorHref(p)).toBe('/workspace/p3');
    expect(phaseWorkHref(p)).toBe('/workspace/p3');
  });

  it('offers the quiz as its own destination once it is the only thing left', () => {
    const p = {
      ...phase(3, 'implementation', { attempts: 2 }),
      tasks: [task({ key: 'main', order: 1, status: 'passed' }), quiz({ key: 'concepts', order: 2 })],
    };
    expect(phaseWorkHref(p)).toBe('/workspace/p3/quiz?task=concepts');
    expect(phaseDoorHref(p)).toBe('/workspace/p3/quiz?task=concepts');
    // The phase's own room is untouched by any of it.
    expect(roomHref(p)).toBe('/workspace/p3');
  });

  it('holds the door where two things are still open, quiz or not', () => {
    const two = {
      ...phase(2, 'design', { attempts: 1 }),
      tasks: [task({ key: 'main', order: 1 }), quiz({ key: 'concepts', order: 2 })],
    };
    expect(phaseDoorHref(two)).toBe('/workspace/p2/design');
    const twoQuizzes = {
      ...phase(2, 'design', { attempts: 1 }),
      tasks: [
        task({ key: 'main', order: 1, status: 'passed' }),
        quiz({ key: 'one', order: 2 }),
        quiz({ key: 'two', order: 3 }),
      ],
    };
    expect(phaseDoorHref(twoQuizzes)).toBe('/workspace/p2/design');
  });

  it('does not reach past a lock', () => {
    const tasks = [task({ key: 'main', order: 1, status: 'passed' }), quiz({ key: 'concepts', order: 2 })];
    // Nothing submitted, the quiz all that is left: the quiz, as on any visit.
    expect(phaseDoorHref({ ...phase(2, 'design'), tasks })).toBe('/workspace/p2/quiz?task=concepts');
    const locked = { ...phase(3, 'implementation', { status: 'locked', attempts: 3 }), tasks };
    expect(phaseWorkHref(locked)).toBe('/phases');
    expect(phaseDoorHref(locked)).toBe('/phases');
  });

  it('opens the room whether or not a quiz has been handed in', () => {
    // `phase_states.attempts` counts a quiz hand-in like any other; the door
    // does not read it, so a paper changes nothing about where it opens.
    const tasks = [task({ key: 'main', order: 1 }), quiz({ key: 'concepts', order: 2 })];
    const untouched = { ...phase(2, 'design', { attempts: 0 }), tasks };
    expect(phaseDoorHref(untouched)).toBe('/workspace/p2/design');
    const afterAPaper = { ...phase(2, 'design', { attempts: 1 }), tasks };
    expect(phaseDoorHref(afterAPaper)).toBe('/workspace/p2/design');
    expect(briefHref(afterAPaper)).toBe('/workspace/p2/brief');
  });

  it('sends Requirements to its quiz too, because the rule is one rule', () => {
    const p = {
      ...phase(1, 'requirements', { attempts: 3 }),
      tasks: [task({ key: 'main', order: 1, status: 'passed' }), quiz({ key: 'concepts', order: 2 })],
    };
    expect(phaseDoorHref(p)).toBe('/workspace/p1/quiz?task=concepts');
  });
});

/**
 * The join between a bare summary and the task list its caller already holds.
 *
 * Six call sites read it, so the rule is written once: take the phase's own
 * tasks where it has them, otherwise the ones `useProject` already fetched for
 * that phase id, otherwise none, and *none* gives the phase-key door.
 */
describe('a door given the task list its caller holds', () => {
  const quizTasks = [task({ key: 'main', order: 1, status: 'passed' }), quiz({ key: 'concepts', order: 2 })];

  it('reads the phase’s tasks out of the details map', () => {
    const summary = phase(2, 'design', { attempts: 2 });
    const door = doorWithTasks(summary, { p2: { tasks: quizTasks } });
    expect(door.tasks).toBe(quizTasks);
    expect(phaseDoorHref(door)).toBe('/workspace/p2/quiz?task=concepts');
  });

  it('keeps a list the phase already carries, and never goes looking for a second', () => {
    const detail = { ...phase(2, 'design', { attempts: 2 }), tasks: quizTasks };
    expect(doorWithTasks(detail, { p2: { tasks: [] } }).tasks).toBe(quizTasks);
  });

  it('answers as it always did with no map, an empty map or an unknown phase', () => {
    const summary = phase(2, 'design', { attempts: 2 });
    for (const details of [undefined, {}, { other: { tasks: quizTasks } }]) {
      const door = doorWithTasks(summary, details);
      expect(door.tasks).toBeUndefined();
      expect(phaseDoorHref(door)).toBe('/workspace/p2/design');
    }
  });
});

describe('Requirements backlog link', () => {
  it('keeps the explicit backlog destination distinct from the interview entry', () => {
    expect(phaseDocHref(SIX[0])).toBe('/workspace/p1/issue');
    expect(phaseDocLabel(SIX[0])).toBe('Open the backlog');
  });
});

describe('Testing\'s document link', () => {
  it('names the page the row calls "Planted bugs", never the kill matrix', () => {
    expect(phaseDocLabel({ key: 'testing' })).toBe('Open Planted bugs');
  });
});
