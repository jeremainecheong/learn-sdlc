import 'reflect-metadata';
import { DESIGN_JSON, EMPTY_DESIGN, INHERITED_TASK_KEY, serialiseDesign, type PhaseKey, type PhaseProvenanceView } from '@learnsdlc/shared';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { soleTaskFor } from '../content/pack-compiler';
import { SCREEN_COPY_PATH, withScreenCopy } from '../content/screen-copy';
import { phaseProvenance, referenceNameFrom, versionProvenance } from './provenance';
import {
  S1_TEACHER,
  copyTaskTrackr,
  draftSnapshot,
  openForkWorld,
  phaseOf,
  tasktrackrContent,
  tasktrackrPhase,
  type Fork,
  type ForkWorld,
} from '../../test/tasktrackr-phase';
import {
  ROOMDESK_INTERVIEW,
  ROOMDESK_REQUIREMENTS_INTRO,
  ROOMDESK_STORY,
} from '../../test/reference-scenario-roomdesk';

/**
 * One provenance resolver.
 *
 * What in a phase is still the reference project's and what is the teacher's,
 * per element: every intro, interview and read-only file by its recorded
 * digest, every task by its recorded anchor, every application phase by its one
 * application digest. The vocabulary is `reference | own | edited`, never a
 * project slug; the name a person reads is the registry title's.
 */

const PHASES: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const WRITTEN: PhaseKey[] = ['requirements', 'design'];
/** Design's starting record: an editable document its one task owns (Design mounts nothing read-only since 4.0.0). */
const RECORD = DESIGN_JSON;
/** A Background the teacher wrote for Design, standing in for the architecture document 4.0.0 folded into the intro. */
const ROOMDESK_DESIGN_INTRO = 'RoomDesk is one API over SQLite behind a small proxy, and the booking rules live in its repository layer.';

const NAME = 'TaskTrackr';

function everyPhase(snapshot: Awaited<ReturnType<typeof draftSnapshot>>): PhaseProvenanceView[] {
  return PHASES.map((key) => {
    const { phase, tasks } = phaseOf(snapshot, key);
    return phaseProvenance(phase, tasks, NAME);
  });
}

const byKey = (views: PhaseProvenanceView[], key: PhaseKey) => views.find((one) => one.phaseKey === key)!;

function expectAllReference(views: PhaseProvenanceView[]): void {
  for (const view of views) {
    expect([view.phaseKey, view.rollup]).toEqual([view.phaseKey, 'reference']);
    expect([view.phaseKey, view.intro]).toEqual([view.phaseKey, 'reference']);
    for (const task of view.tasks) expect([view.phaseKey, task.taskKey, task.provenance, task.titleEdited]).toEqual([view.phaseKey, task.taskKey, 'reference', false]);
    for (const file of view.files) expect([view.phaseKey, file.path, file.provenance]).toEqual([view.phaseKey, file.path, 'reference']);
    if (WRITTEN.includes(view.phaseKey)) {
      expect(view.application).toBeUndefined();
    } else {
      expect([view.phaseKey, view.application]).toEqual([view.phaseKey, NAME]);
      expect(view.files).toEqual([]);
    }
  }
  expect(byKey(views, 'requirements').interview).toBe('reference');
  expect(byKey(views, 'design').interview).toBeNull();
  expect(byKey(views, 'requirements').roomTask).toBe('reference');
  // a story phase mounts its record alone, and the record is the room's, not a document
  expect(byKey(views, 'requirements').files.map((one) => one.path)).toEqual([]);
  // and Design its three editable records, none of them a document
  expect(byKey(views, 'design').files.map((one) => one.path)).toEqual([]);
}

describe('the provenance resolver', () => {
  describe('on the reference project itself', () => {
    const content = tasktrackrContent();
    const project = content.getProject('tasktrackr');
    const views = project.phases.map((phase) => phaseProvenance(phase, [soleTaskFor(phase)], referenceNameFrom(content)));

    it('names the reference project from its registry title, never a slug', () => {
      expect(referenceNameFrom(content)).toBe(NAME);
    });

    it('marks every element of every phase the reference\'s, and the last four phases its application', () => {
      expectAllReference(views);
    });

    it('sums the version: both written phases the reference\'s, the application the reference\'s', () => {
      expect(versionProvenance(views)).toEqual({ ownPhases: 0, mixedPhases: 0, referencePhases: 2, applicationFrom: NAME });
    });

    it('carries no digest, no bytes and no editable path', () => {
      const text = JSON.stringify(views);
      expect(text).not.toMatch(/[0-9a-f]{64}/);
      for (const view of views) {
        const phase = project.phases.find((one) => one.key === view.phaseKey)!;
        const editable = new Set(phase.files.filter((file) => file.editable).map((file) => file.path));
        for (const file of view.files) expect(editable.has(file.path)).toBe(false);
        for (const file of phase.files) if (file.content.length > 40) expect(text).not.toContain(file.content);
      }
    });

    it('is memoised by the phase object and its tasks: the same inputs answer the same view', () => {
      const phase = project.phases[0];
      const tasks = [soleTaskFor(phase)];
      expect(phaseProvenance(phase, tasks, NAME)).toBe(phaseProvenance(phase, tasks, NAME));
    });

    it('reads a learner\'s accepted screen copy laid over an application phase as the reference\'s application still', () => {
      const implementation = project.phases.find((one) => one.key === 'implementation')!;
      expect(implementation.files.some((file) => file.path === SCREEN_COPY_PATH)).toBe(true);
      const overlaid = withScreenCopy(implementation, {
        version: 1,
        sourceSubmissionId: 'a-submission',
        sourcePhaseStateId: 'a-phase-state',
        title: 'Rooms free now',
        empty: 'No room is free right now.',
      });
      expect(overlaid).not.toBe(implementation);
      expect(phaseProvenance(overlaid, [soleTaskFor(overlaid)], NAME).application).toBe(NAME);
      expect(phaseProvenance(implementation, [soleTaskFor(implementation)], NAME).application).toBe(NAME);
    });

    it('reads an application phase whose files are not the reference\'s as nobody\'s application', () => {
      const testing = project.phases.find((one) => one.key === 'testing')!;
      const changed = { ...testing, files: testing.files.map((file, at) => (at === 0 ? { ...file, content: `${file.content}\n# changed\n` } : file)) };
      const view = phaseProvenance(changed, [soleTaskFor(changed)], NAME);
      expect(view.application).toBeNull();
      expect(view.rollup).not.toBe('reference');
    });
  });

  describe('on a teacher\'s copy', () => {
    let world: ForkWorld;
    let n = 0;
    const fresh = () => copyTaskTrackr(world, `prov-${++n}`);

    beforeAll(async () => {
      world = await openForkWorld();
    });
    afterAll(async () => {
      await world.close();
    });

    const viewsOf = async (fork: Fork) => everyPhase(await draftSnapshot(world, fork));

    it('marks an untouched copy exactly as the reference itself', async () => {
      const fork = await fresh();
      const views = await viewsOf(fork);
      expectAllReference(views);
      expect(byKey(views, 'requirements').tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
      expect(versionProvenance(views)).toEqual({ ownPhases: 0, mixedPhases: 0, referencePhases: 2, applicationFrom: NAME });
    });

    it('rides the draft: every DraftPhaseView carries the resolver\'s view of the compiled draft', async () => {
      const fork = await fresh();
      await world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', { intro: ROOMDESK_REQUIREMENTS_INTRO });
      const draft = await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId);
      const views = await viewsOf(fork);
      for (const phase of draft.phases) expect([phase.key, phase.provenance]).toEqual([phase.key, byKey(views, phase.key)]);
    });

    it('marks the intro the teacher wrote as theirs, and the phase mixed', async () => {
      const fork = await fresh();
      const result = await world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', { intro: ROOMDESK_REQUIREMENTS_INTRO });
      expect(result.phase.provenance?.intro).toBe('own');
      expect(result.phase.provenance?.rollup).toBe('mixed');
      const views = await viewsOf(fork);
      expect(byKey(views, 'requirements').intro).toBe('own');
      expect(byKey(views, 'requirements').tasks[0].provenance).toBe('reference');
      expect(byKey(views, 'design').rollup).toBe('reference');
    });

    it('marks the interview the teacher wrote as theirs', async () => {
      const fork = await fresh();
      await world.service.putInterview(S1_TEACHER, fork.projectId, fork.versionId, ROOMDESK_INTERVIEW);
      const requirements = byKey(await viewsOf(fork), 'requirements');
      expect(requirements.interview).toBe('own');
      expect(requirements.rollup).toBe('mixed');
    });

    it('marks a replaced starting record as the teacher\'s edit, and the original bytes back as the reference\'s again', async () => {
      const fork = await fresh();
      const original = phaseOf(await draftSnapshot(world, fork), 'design').phase.files.find((file) => file.path === RECORD)!.content;
      await world.service.replaceFile(S1_TEACHER, fork.projectId, fork.versionId, 'design', { path: RECORD, content: serialiseDesign(EMPTY_DESIGN) });
      let views = await viewsOf(fork);
      expect(byKey(views, 'design').tasks[0].provenance).toBe('edited');
      expect(byKey(views, 'design').rollup).not.toBe('reference');
      expect(byKey(views, 'requirements').rollup).toBe('reference');
      await world.service.replaceFile(S1_TEACHER, fork.projectId, fork.versionId, 'design', { path: RECORD, content: original });
      views = await viewsOf(fork);
      expectAllReference(views);
    });

    it('marks an inherited task with a rewritten brief as edited, and its room task as another\'s', async () => {
      const fork = await fresh();
      await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', INHERITED_TASK_KEY, {
        brief: 'Write the story Priya Nair asked for: a member of staff booking a slot that is already taken.',
      });
      const requirements = byKey(await viewsOf(fork), 'requirements');
      expect(requirements.tasks).toEqual([{ taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: false }]);
      expect(requirements.roomTask).toBe('other');
      expect(requirements.rollup).toBe('mixed');
    });

    it('marks a retitled inherited task, and keeps it the reference\'s', async () => {
      const fork = await fresh();
      await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, { title: 'The booking design' });
      const design = byKey(await viewsOf(fork), 'design');
      expect(design.tasks).toEqual([{ taskKey: INHERITED_TASK_KEY, provenance: 'reference', titleEdited: true }]);
      expect(design.rollup).toBe('reference');
    });

    it('marks a Requirements phase the teacher rewrote whole as their own, and sums the version', async () => {
      const fork = await fresh();
      await world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', { intro: ROOMDESK_REQUIREMENTS_INTRO });
      await world.service.putInterview(S1_TEACHER, fork.projectId, fork.versionId, ROOMDESK_INTERVIEW);
      // the story task kept, its brief and story block the teacher's own (a story phase's task is not replaced by a written one)
      await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', INHERITED_TASK_KEY, {
        brief: 'Write the story Priya Nair asked for: a member of staff booking a slot that is already taken.',
        story: ROOMDESK_STORY,
      } as never);
      const views = await viewsOf(fork);
      const requirements = byKey(views, 'requirements');
      expect(requirements.rollup).toBe('own');
      expect(requirements.tasks).toEqual([{ taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: false }]);
      // The kept story task still owns the room's record, but no longer the reference's.
      expect(requirements.roomTask).toBe('other');
      // Design, which the teacher left as it was.
      expect(byKey(views, 'design').rollup).toBe('reference');
      expect(versionProvenance(views)).toEqual({ ownPhases: 1, mixedPhases: 0, referencePhases: 1, applicationFrom: NAME });
    });

    it('marks a rewritten Background (the architecture, since 4.0.0) as the teacher\'s', async () => {
      const fork = await fresh();
      await world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'design', { intro: ROOMDESK_DESIGN_INTRO });
      const design = byKey(await viewsOf(fork), 'design');
      expect(design.intro).toBe('own');
      expect(design.tasks[0].provenance).toBe('reference');
      expect(design.rollup).toBe('mixed');
    });
  });
});

/* ======================================================================== *
 * An application phase is the reference project's only                     *
 * while its workspace AND its executable checks are. Uploaded = own; an     *
 * edited executable element on a copy makes the phase mixed, and the bridge *
 * notice never names the reference project for it.                         *
 * ======================================================================== */
describe('provenance of an executable phase', () => {
  const edited = (key: PhaseKey) => {
    const phase = tasktrackrPhase(key);
    const checks = JSON.parse(JSON.stringify(phase.checks));
    if (checks.kind === 'code') {
      const [at] = Object.keys(checks.runs[0].hiddenTestFiles);
      checks.runs[0].hiddenTestFiles[at] += '\n# edited\n';
      checks.hiddenTestFiles[at] = checks.runs[0].hiddenTestFiles[at];
    } else if (checks.kind === 'tests') {
      checks.minTests += 1;
    }
    return { ...phase, checks };
  };

  it("an edited hidden suite on a copy reads mixed, and its application is not the reference project's", () => {
    const phase = edited('implementation');
    const view = phaseProvenance(phase, [{ ...soleTaskFor(phase), taskKey: INHERITED_TASK_KEY }], 'TaskTrackr');
    expect(view.application).toBeNull();
    expect(view.rollup).toBe('mixed');
    expect(view.tasks[0].provenance).toBe('edited');
  });

  it("an edited tests task reads mixed too (the sealed side, not only the workspace)", () => {
    const phase = edited('testing');
    const view = phaseProvenance(phase, [{ ...soleTaskFor(phase), taskKey: INHERITED_TASK_KEY }], 'TaskTrackr');
    expect(view.application).toBeNull();
    expect(view.rollup).not.toBe('reference');
  });

  // The words a learner reads (the compiled taskPanel and
  // objectives the sole work task lands on) are part of the application.
  it("a copy's executable task whose brief a teacher rewrote reads mixed, and its application is not the reference project's", () => {
    const phase = { ...tasktrackrPhase('implementation'), taskPanel: 'Write a poem in api/app.py.' };
    const view = phaseProvenance(phase, [{ ...soleTaskFor(phase), taskKey: INHERITED_TASK_KEY }], 'TaskTrackr');
    expect(view.application).toBeNull();
    expect(view.rollup).toBe('mixed');
    expect(view.tasks[0].provenance).toBe('edited');
  });

  it("a copy's executable task whose objectives a teacher rewrote reads mixed too", () => {
    const base = tasktrackrPhase('testing');
    const phase = { ...base, objectives: [...base.objectives, 'Write a sonnet about the suite.'] };
    const view = phaseProvenance(phase, [{ ...soleTaskFor(phase), taskKey: INHERITED_TASK_KEY }], 'TaskTrackr');
    expect(view.application).toBeNull();
    expect(view.rollup).toBe('mixed');
  });

  it("GUARD › a retitled executable task is marked and stays the reference's (the reviewer scope's executable anchor leaves the title out too)", () => {
    const phase = tasktrackrPhase('implementation');
    const view = phaseProvenance(phase, [{ ...soleTaskFor(phase), taskKey: INHERITED_TASK_KEY, title: 'Build it' }], 'TaskTrackr');
    expect(view.application).toBe('TaskTrackr');
    expect(view.tasks[0]).toEqual({ taskKey: INHERITED_TASK_KEY, provenance: 'reference', titleEdited: true });
  });

  it("GUARD › the reference project's own executable phases still read reference, by name", () => {
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as PhaseKey[]) {
      const phase = tasktrackrPhase(key);
      const view = phaseProvenance(phase, [soleTaskFor(phase)], 'TaskTrackr');
      expect(view.application).toBe('TaskTrackr');
      expect(view.rollup).toBe('reference');
    }
  });
});

/* ======================================================================== *
 * The reference                                                            *
 * project's name rides a phase only while something in it is still the     *
 * reference's. On an `own` phase (every phase of an uploaded project) it *
 * is null, so no learner body names the platform's project. Every phase    *
 * whose rollup is reference or mixed keeps it: the provenance chip         *
 * "{referenceName}'s" reads it (the rollup reading, not the literal        *
 * "application === referenceName" one, which would null a copy's written   *
 * phases and change the pinned provenance recording).                      *
 * ======================================================================== */
describe('referenceName rides only a phase that is still the reference\'s', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SHELF_DIR } = require('../../test/fixtures/upload-packs/markers') as typeof import('../../test/fixtures/upload-packs/markers');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ContentService } = require('../content/content.service') as typeof import('../content/content.service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DirectoryPackSource } = require('../content/pack-source') as typeof import('../content/pack-source');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { compilePack } = require('../content/pack-compiler') as typeof import('../content/pack-compiler');

  it('an own phase carries referenceName null (the Shelf pack, every phase)', () => {
    const shelf = compilePack(new ContentService().loadProject(new DirectoryPackSource(SHELF_DIR)));
    const views = shelf.content.phases.map((phase) => phaseProvenance(phase, shelf.phases.find((one) => one.key === phase.key)!.tasks, NAME));
    expect(views.map((view) => [view.phaseKey, view.rollup, view.referenceName])).toEqual(
      PHASES.map((key) => [key, 'own', null]),
    );
    expect(JSON.stringify(views)).not.toContain(NAME);
    // the version line is unchanged: no application is the reference's
    expect(versionProvenance(views).applicationFrom).toBeNull();
  });

  it('a constructed own written phase carries referenceName null, and its mixed twin keeps the name', () => {
    const base = tasktrackrPhase('design');
    const own = {
      ...base,
      intro: 'Design the shelf: the endpoints a librarian calls and what each answers.',
      files: base.files.map((file) => (file.editable ? file : { ...file, content: `# Shelf\n\n${file.path} written for the shelf.\n` })),
    };
    const task = { ...soleTaskFor(own), taskKey: 'shelf-design', title: 'The shelf design', brief: 'Design the shelf, endpoint by endpoint.' };
    const ownView = phaseProvenance(own, [task], NAME);
    expect(ownView).toMatchObject({ rollup: 'own', referenceName: null });
    const mixed = { ...own, intro: base.intro };
    expect(phaseProvenance(mixed, [task], NAME)).toMatchObject({ rollup: 'mixed', referenceName: NAME });
  });

  it("GUARD › TaskTrackr keeps referenceName on every phase", () => {
    const content = tasktrackrContent();
    for (const phase of content.getProject('tasktrackr').phases) {
      expect([phase.key, phaseProvenance(phase, [soleTaskFor(phase)], NAME).referenceName]).toEqual([phase.key, NAME]);
    }
  });

  describe('GUARD › each shape of a teacher\'s copy keeps referenceName on every reference or mixed phase', () => {
    let world: ForkWorld;
    let n = 0;
    beforeAll(async () => {
      world = await openForkWorld();
    });
    afterAll(async () => {
      await world.close();
    });
    const shapes: [string, (fork: Fork) => Promise<unknown>][] = [
      ['untouched', async () => undefined],
      ['intro', (fork) => world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', { intro: ROOMDESK_REQUIREMENTS_INTRO })],
      ['interview', (fork) => world.service.putInterview(S1_TEACHER, fork.projectId, fork.versionId, ROOMDESK_INTERVIEW)],
      ['record', (fork) => world.service.replaceFile(S1_TEACHER, fork.projectId, fork.versionId, 'design', { path: RECORD, content: serialiseDesign(EMPTY_DESIGN) })],
      ['brief', (fork) => world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', INHERITED_TASK_KEY, { brief: 'Write the story Priya Nair asked for.' })],
      ['retitle', (fork) => world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, { title: 'The booking design' })],
      // a Design phase holds one design task since 4.0.0: the task a teacher can add beside it is a concept quiz
      ['added task', (fork) => world.service.addTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', {
        taskKey: 'concepts', title: 'Design concepts', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false,
        quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
      } as never)],
    ];
    for (const [name, edit] of shapes) {
      it(`${name}: every phase keeps the name`, async () => {
        const fork = await copyTaskTrackr(world, `s21-${++n}`);
        await edit(fork);
        const views = everyPhase(await draftSnapshot(world, fork));
        for (const view of views) {
          expect([name, view.phaseKey, view.rollup === 'own', view.referenceName]).toEqual([name, view.phaseKey, false, NAME]);
        }
      });
    }

    it('a copy phase the teacher rewrote whole reads own and drops the name; its mixed neighbour keeps it', async () => {
      const fork = await copyTaskTrackr(world, `s21-${++n}`);
      await world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', { intro: ROOMDESK_REQUIREMENTS_INTRO });
      await world.service.putInterview(S1_TEACHER, fork.projectId, fork.versionId, ROOMDESK_INTERVIEW);
      await world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', INHERITED_TASK_KEY, {
        brief: 'Write the story Priya Nair asked for.',
        story: ROOMDESK_STORY,
      } as never);
      // and Design mixed: its Background the teacher's, its task the reference's
      await world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'design', { intro: ROOMDESK_DESIGN_INTRO });
      const views = everyPhase(await draftSnapshot(world, fork));
      expect(byKey(views, 'requirements')).toMatchObject({ rollup: 'own', referenceName: null });
      expect(byKey(views, 'design')).toMatchObject({ rollup: 'mixed', referenceName: NAME });
      for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as PhaseKey[]) {
        expect([key, byKey(views, key).referenceName]).toEqual([key, NAME]);
      }
    });
  });
});
