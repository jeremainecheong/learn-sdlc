// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { PhaseKey, PhaseProvenanceView, PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';
import { doorWithTasks, phaseDocHref, phaseDoorHref, phaseWorkHref, roomHref } from '@/components/shell/routes';

/**
 * The maintenance door on a teacher's own application.
 *
 * Maintenance's room is the change request (`/change`) for every code
 * Maintenance whose detail carries the teacher's change request
 * (`PhaseDetail.change`), a teacher's own application included (spec 5.3). A
 * code Maintenance without one, in the older format, keeps the door it had
 * before: a teacher's own application has no change request, and the change
 * page sends such a phase on to its workspace, one hop through a page that
 * draws only a loading line. Where the door is built with the held detail in
 * hand (provenance, `artifactKind` and `change`), it opens the workspace
 * directly, by `opensChangeRoom`. A Maintenance of another kind than code
 * opens the workspace. A caller holding a bare `PhaseSummary` has none of
 * them, and keeps `/change` and its redirect.
 *
 * TaskTrackr's maintenance link stays `/change`, and every other
 * phase's door stays the same, for every provenance a reference phase
 * carries.
 */

type Application = Pick<PhaseProvenanceView, 'application'> | null | undefined;
const ORDER: Record<PhaseKey, number> = { requirements: 1, design: 2, implementation: 3, testing: 4, deployment: 5, maintenance: 6 };
const summary = (key: PhaseKey, extra: Partial<PhaseSummary> = {}): PhaseSummary =>
  ({ id: `p${ORDER[key]}`, key, title: key, status: 'active', attempts: 1, opensAt: null, dueAt: null, ...extra }) as PhaseSummary;
const withProvenance = <T extends object>(phase: T, application: Application) =>
  (application === undefined ? phase : { ...phase, provenance: application }) as T;
const task = (key: string, extra: Partial<PhaseTaskView> = {}) =>
  ({ key, title: key, artefactType: 'code', status: 'not-started', required: true, ...extra }) as PhaseTaskView;

/** The hrefs a reference phase's doors answer. */
const TODAY_ROOM: Record<PhaseKey, string> = {
  requirements: '/workspace/p1/interview',
  design: '/workspace/p2/design',
  implementation: '/workspace/p3',
  testing: '/workspace/p4',
  deployment: '/workspace/p5',
  maintenance: '/workspace/p6/change',
};
const TODAY_DOC: Record<PhaseKey, string> = {
  requirements: '/workspace/p1/issue',
  design: '/workspace/p2/design',
  implementation: '/workspace/p3/pr',
  testing: '/workspace/p4/matrix',
  deployment: '/workspace/p5/drill',
  maintenance: '/workspace/p6/change',
};
const KEYS = Object.keys(ORDER) as PhaseKey[];
/** The teacher's change request a detail carries (`PhaseDetail.change`). */
const CHANGE = {
  ticket: { id: 'CHG-1', title: 'Shelve by surname', summary: 'Shelve by surname.', acceptance: [{ id: 'AC-1', line: 'Order by surname' }] },
  contract: false,
  floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true },
};
const REFERENCE: Application[] = [undefined, null, { application: 'TaskTrackr' }, {}];

describe('the maintenance door on a teacher\'s own application', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('TaskTrackr\'s maintenance link is unchanged', () => {
    for (const application of REFERENCE) {
      const label = JSON.stringify(application);
      for (const key of KEYS) {
        const phase = withProvenance(summary(key), application);
        expect(roomHref(phase), `${key} ${label}`).toBe(TODAY_ROOM[key]);
        expect(phaseDocHref(phase), `${key} ${label}`).toBe(TODAY_DOC[key]);
        expect(roomHref({ ...phase, status: 'locked' }), `${key} ${label}`).toBe('/phases');
      }
      // The door every board builds: the summary joined with the held detail.
      const held = withProvenance({ tasks: [task('t1')] }, application);
      const door = doorWithTasks(summary('maintenance'), { p6: held });
      expect(phaseDoorHref(door), label).toBe('/workspace/p6/change');
      expect(phaseWorkHref(door), label).toBe('/workspace/p6/change');
      expect(phaseDoorHref(doorWithTasks(summary('maintenance', { attempts: 0 }), { p6: held })), label).toBe('/workspace/p6/change');
    }
    // A bare summary (no held detail) gets the `/change` door, whatever its roll-up says.
    for (const scenario of ['reference', 'mixed', 'authored'] as const) {
      expect(phaseDoorHref(summary('maintenance', { scenario } as Partial<PhaseSummary>))).toBe('/workspace/p6/change');
    }
  });

  it('an own application\'s Maintenance opens the workspace directly until it carries a change request, then the change room; a Maintenance of another kind the workspace', () => {
    const own = { application: null };
    // A held detail in hand, in the older format (no change request): the door it had before.
    expect(roomHref(withProvenance(summary('maintenance'), own))).toBe('/workspace/p6');
    expect(phaseDocHref(withProvenance(summary('maintenance'), own))).toBe('/workspace/p6');
    // The summary joined with the held detail: the sidebar, Home, the journal, the boards.
    const door = doorWithTasks(summary('maintenance'), { p6: { tasks: [task('t1')], provenance: own } as never });
    expect(phaseDoorHref(door)).toBe('/workspace/p6');
    expect(phaseWorkHref(door)).toBe('/workspace/p6');
    // With the teacher's change request, an own application's code Maintenance has its change room (spec 5.3).
    const withChange = { ...withProvenance(summary('maintenance'), own), artifactKind: 'code' as const, change: CHANGE };
    expect(roomHref(withChange)).toBe('/workspace/p6/change');
    expect(phaseDocHref(withChange)).toBe('/workspace/p6/change');
    // The change request rides along from the held detail.
    const code = doorWithTasks(summary('maintenance'), { p6: { tasks: [task('t1')], provenance: own, artifactKind: 'code', change: CHANGE } as never });
    expect(phaseDoorHref(code)).toBe('/workspace/p6/change');
    expect(phaseWorkHref(code)).toBe('/workspace/p6/change');
    // A Maintenance of another kind has no change room, whatever it carries.
    const other = { ...withChange, artifactKind: 'tests' as const };
    expect(roomHref(other)).toBe('/workspace/p6');
    expect(phaseDocHref(other)).toBe('/workspace/p6');
    expect(phaseDoorHref(doorWithTasks(summary('maintenance'), { p6: { tasks: [task('t1')], provenance: own, artifactKind: 'tests', change: CHANGE } as never }))).toBe('/workspace/p6');
    // Not begun: the room too, with nothing in front of it.
    expect(phaseDoorHref(doorWithTasks(summary('maintenance', { attempts: 0 }), { p6: { tasks: [], provenance: own } as never }))).toBe('/workspace/p6');
    // A quiz that is all that is left still opens the paper.
    const quizOnly = doorWithTasks(summary('maintenance'), {
      p6: { tasks: [task('t1', { status: 'passed' }), task('q1', { artefactType: 'quiz' })], provenance: own } as never,
    });
    expect(phaseDoorHref(quizOnly)).toBe('/workspace/p6/quiz?task=q1');
    // A phase that already carries its own provenance, or its own kind, keeps it.
    expect(roomHref(doorWithTasks(withProvenance(summary('maintenance'), own), { p6: { provenance: { application: 'TaskTrackr' } } as never }))).toBe('/workspace/p6');
    expect(roomHref(doorWithTasks(other, { p6: { artifactKind: 'code' } as never }))).toBe('/workspace/p6');
    // Every other phase of an own application keeps its door.
    for (const key of KEYS.filter((k) => k !== 'maintenance')) {
      expect(roomHref(withProvenance(summary(key), own)), key).toBe(TODAY_ROOM[key]);
      expect(phaseDocHref(withProvenance(summary(key), own)), key).toBe(TODAY_DOC[key]);
    }
    expect(roomHref({ ...withProvenance(summary('maintenance'), own), status: 'locked' })).toBe('/phases');
  });

  it('a Requirements phase that holds no interview opens its room, not /interview', () => {
    const none = { application: undefined, interview: null } as Pick<PhaseProvenanceView, 'application' | 'interview'>;
    expect(roomHref({ ...summary('requirements'), provenance: none })).toBe('/workspace/p1');
    const door = doorWithTasks(summary('requirements', { attempts: 0 }), { p1: { tasks: [task('t1')], provenance: none } as never });
    expect(phaseWorkHref(door)).toBe('/workspace/p1');
    expect(phaseDoorHref(door)).toBe('/workspace/p1');
    expect(roomHref({ ...summary('requirements'), provenance: none, status: 'locked' })).toBe('/phases');
    // The backlog document link is the room's backlog, as for any phase.
    expect(phaseDocHref({ ...summary('requirements'), provenance: none })).toBe(TODAY_DOC.requirements);
    // An interview in the phase, whoever wrote it, keeps the interview door; so does every other phase.
    for (const interview of ['reference', 'own'] as const) {
      expect(roomHref({ ...summary('requirements'), provenance: { interview } as never }), interview).toBe(TODAY_ROOM.requirements);
    }
    for (const key of KEYS.filter((k) => k !== 'requirements')) {
      expect(roomHref({ ...summary(key), provenance: { application: 'TaskTrackr', interview: null } as never }), key).toBe(TODAY_ROOM[key]);
    }
  });
});
