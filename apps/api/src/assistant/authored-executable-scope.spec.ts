import 'reflect-metadata';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import type { PhaseKey } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import { DirectoryPackSource } from '../content/pack-source';
import { soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import { ProjectVersionEntity } from '../content/project.entities';
import { withScreenCopy } from '../content/screen-copy';
import { LocalMentorProvider, offlineLadderFor } from './local.provider';
import type { MentorContext } from './provider.types';
import { REFERENCE_SCOPE, authoredPhaseScope, phaseScopeOf, taskScopeOf } from './project-scope';
import { SHELF_DIR, TASKTRACKR_SENTINELS } from '../../test/fixtures/upload-packs/markers';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { REFERENCE_TERMS } from '../../test/reference-terms';
import {
  S1_TEACHER,
  copyTaskTrackr,
  draftSnapshot,
  openForkWorld,
  phaseOf,
  tasktrackrPhase,
  tasktrackrTask,
  type Fork,
  type ForkWorld,
} from '../../test/tasktrackr-phase';

/**
 * Whose content an executable phase is.
 *
 * An executable phase, `code`, `tests`, `config`, cannot simply be treated
 * as TaskTrackr's: an upload is a whole application of the teacher's own, and
 * TaskTrackr's reviewer, mentor and Agentic prompts would grade it against
 * TaskTrackr's due dates, its maintenance change request and its deployment
 * bundle. The rule: an executable phase is the reference's only
 * when its workspace is the reference application's (`isReferenceApplication`)
 * **and** it has one work task **and** that task's `exec` anchor, the brief,
 * objectives, rubric, owned baselines, every sealed byte the grader runs and
 * the mentor block, is recorded. Everything else is authored, and the
 * resolver still never throws.
 */

const EXECUTABLE: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];

let shelfProject: ProjectContent | null = null;
/** The `shelf` fixture: a teacher's own application, loaded the way the importer reads a pack. */
function shelf(): ProjectContent {
  if (!shelfProject) shelfProject = new ContentService().loadProject(new DirectoryPackSource(SHELF_DIR));
  return shelfProject;
}
function shelfPhase(key: PhaseKey): PhaseContent {
  const phase = shelf().phases.find((one) => one.key === key);
  if (!phase) throw new Error(`shelf has no ${key} phase`);
  return phase;
}

describe('an uploaded executable phase', () => {
  it('is a real executable phase of the Shelf pack in each of the four application phases', () => {
    expect(EXECUTABLE.map((key) => [key, shelfPhase(key).checks.kind])).toEqual([
      ['implementation', 'code'],
      ['testing', 'tests'],
      ['deployment', 'config'],
      ['maintenance', 'code'],
    ]);
  });

  it.each(EXECUTABLE)('resolves authored in taskScopeOf and phaseScopeOf: %s', (key) => {
    const phase = shelfPhase(key);
    const task = soleTaskFor(phase);
    const byTask = taskScopeOf(phase, task, [task]);
    expect([key, byTask.kind]).toEqual([key, 'authored']);
    expect(byTask.kind === 'authored' && byTask.grain === 'task' && byTask.task?.taskKey).toBe(task.taskKey);
    expect([key, taskScopeOf(phase).kind]).toEqual([key, 'authored']);
    const byPhase = phaseScopeOf(phase, [task]);
    expect([key, byPhase.kind]).toEqual([key, 'authored']);
    expect(byPhase.kind === 'authored' && byPhase.grain === 'phase' && byPhase.tasks.map((one) => one.taskKey)).toEqual([task.taskKey]);
    expect([key, phaseScopeOf(phase).kind]).toEqual([key, 'authored']);
    expect([key, phaseScopeOf(phase, [task], { lesson: true }).kind]).toEqual([key, 'authored']);
  });

  it('carries no TaskTrackr sentinel of its own, so any found in a request came from TaskTrackr', () => {
    const text = JSON.stringify(shelf()).toLowerCase();
    expect(TASKTRACKR_SENTINELS.filter((term) => text.includes(term.toLowerCase()))).toEqual([]);
  });
});

describe('GUARD: TaskTrackr and an unedited 3a copy resolve reference on every executable phase', () => {
  it.each(EXECUTABLE)('TaskTrackr %s is the one reference scope at task and phase grain', (key) => {
    const phase = tasktrackrPhase(key);
    const task = soleTaskFor(phase);
    expect(taskScopeOf(phase, task, [task])).toBe(REFERENCE_SCOPE);
    expect(taskScopeOf(phase)).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase, [task])).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase)).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase, [task], { lesson: true })).toBe(REFERENCE_SCOPE);
  });

  it.each(['implementation', 'testing'] as PhaseKey[])(
    "keeps TaskTrackr %s reference under a learner's accepted Design screen copy",
    (key) => {
      const phase = withScreenCopy(tasktrackrPhase(key), {
        version: 1,
        sourceSubmissionId: 'submission-n5',
        sourcePhaseStateId: 'state-n5',
        title: 'Late work',
        empty: 'Nothing is late.',
      });
      expect(phase).not.toBe(tasktrackrPhase(key));
      const task = soleTaskFor(phase);
      expect(taskScopeOf(phase, task, [task])).toBe(REFERENCE_SCOPE);
      expect(phaseScopeOf(phase, [task])).toBe(REFERENCE_SCOPE);
    },
  );

  it('is a function of the bytes, not of the object: a structural copy of each phase is reference too', () => {
    for (const key of EXECUTABLE) {
      const clone = JSON.parse(JSON.stringify(tasktrackrPhase(key))) as PhaseContent;
      expect([key, taskScopeOf(clone)]).toEqual([key, REFERENCE_SCOPE]);
      expect([key, phaseScopeOf(clone)]).toEqual([key, REFERENCE_SCOPE]);
    }
  });

  describe('on real forks made by the authoring service', () => {
    let world: ForkWorld;
    beforeAll(async () => {
      world = await openForkWorld();
    });
    afterAll(async () => {
      await world?.close();
    });

    it('keeps the seeded TaskTrackr version the registry serves reference on every executable phase', async () => {
      const pin = { projectSlug: 'tasktrackr', projectVersionId: world.seedVersionId };
      for (const key of EXECUTABLE) {
        const phase = world.content.getPhaseForEnrollment(pin, key);
        const tasks = world.content.getTasksForEnrollment(pin, key);
        expect([key, tasks.length]).toEqual([key, 1]);
        expect([key, taskScopeOf(phase, tasks[0], tasks)]).toEqual([key, REFERENCE_SCOPE]);
        expect([key, phaseScopeOf(phase, tasks)]).toEqual([key, REFERENCE_SCOPE]);
        expect([key, phaseScopeOf(phase)]).toEqual([key, REFERENCE_SCOPE]);
      }
    });

    it('keeps an untouched copy reference on every executable phase', async () => {
      const fork = await copyTaskTrackr(world, 'n5-untouched');
      const snapshot = await draftSnapshot(world, fork);
      for (const key of EXECUTABLE) {
        const { phase, tasks } = phaseOf(snapshot, key);
        expect([key, tasks.map((one) => one.taskKey)]).toEqual([key, [INHERITED_TASK_KEY]]);
        expect([key, taskScopeOf(phase, tasks[0], tasks)]).toEqual([key, REFERENCE_SCOPE]);
        expect([key, phaseScopeOf(phase, tasks)]).toEqual([key, REFERENCE_SCOPE]);
      }
    });

    it('keeps the copy reference when the only addition to an executable phase is a quiz', async () => {
      const fork = await copyTaskTrackr(world, 'n5-quiz');
      await world.service.addTask(S1_TEACHER, fork.projectId, fork.versionId, 'implementation', {
        taskKey: 'concepts',
        title: 'Implementation concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
      });
      const { phase, tasks } = phaseOf(await draftSnapshot(world, fork), 'implementation');
      expect(tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, 'concepts']);
      expect(taskScopeOf(phase, tasks[0], tasks)).toBe(REFERENCE_SCOPE);
      expect(phaseScopeOf(phase, tasks)).toBe(REFERENCE_SCOPE);
    });

    /**
     * The compiled snapshot a version serves, its executable bytes changed in
     * the stored row and read back: the shape an older stored version would
     * hold if any door had let a teacher change those bytes. The
     * authoring compile takes an application phase from its source version, so
     * a phase-row edit beneath the service does not reach it; the stored
     * snapshot is what the registry serves a learner.
     */
    const servedWith = async (fork: Fork, key: PhaseKey, edit: (phase: PhaseContent) => PhaseContent) => {
      const snapshot = await draftSnapshot(world, fork);
      const changed = { ...snapshot, content: { ...snapshot.content, phases: snapshot.content.phases.map((one) => (one.key === key ? edit(one) : one)) } };
      await world.dataSource.getRepository(ProjectVersionEntity).update({ id: fork.versionId }, { compiled: changed as never });
      const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
      return row.compiled as typeof snapshot;
    };

    it("a copy whose served executable bytes differ from TaskTrackr's resolves authored, its other phases untouched", async () => {
      const fork = await copyTaskTrackr(world, 'n5-m3-starter');
      const served = await servedWith(fork, 'implementation', (phase) => ({
        ...phase,
        files: phase.files.map((file) => (file.editable && file === phase.files.find((one) => one.editable) ? { ...file, content: `${file.content}\n# our class keeps one more note here\n` } : file)),
      }));
      const edited = phaseOf(served, 'implementation');
      expect(taskScopeOf(edited.phase, edited.tasks[0], edited.tasks).kind).toBe('authored');
      expect(phaseScopeOf(edited.phase, edited.tasks).kind).toBe('authored');
      for (const key of EXECUTABLE.filter((one) => one !== 'implementation')) {
        const { phase, tasks } = phaseOf(served, key);
        expect([key, taskScopeOf(phase, tasks[0], tasks)]).toEqual([key, REFERENCE_SCOPE]);
        expect([key, phaseScopeOf(phase, tasks)]).toEqual([key, REFERENCE_SCOPE]);
      }
    });

    it("a copy whose served hidden suite or read-only file differs resolves authored", async () => {
      const fork = await copyTaskTrackr(world, 'n5-m3-sealed');
      const served = await servedWith(fork, 'maintenance', (phase) => (phase.checks.kind === 'code'
        ? { ...phase, checks: { ...phase.checks, hiddenTestFiles: Object.fromEntries(Object.entries(phase.checks.hiddenTestFiles).map(([path, text], at) => [path, at === 0 ? `${text}\n# ours\n` : text])) } }
        : phase));
      const { phase, tasks } = phaseOf(served, 'maintenance');
      expect(taskScopeOf(phase, tasks[0], tasks).kind).toBe('authored');
      expect(phaseScopeOf(phase, tasks).kind).toBe('authored');

      const other = await copyTaskTrackr(world, 'n5-m3-readonly');
      const locked = await servedWith(other, 'deployment', (one) => ({
        ...one,
        files: one.files.map((file) => (!file.editable && file === one.files.find((f) => !f.editable) ? { ...file, content: `${file.content}\n` } : file)),
      }));
      const deployment = phaseOf(locked, 'deployment');
      expect(taskScopeOf(deployment.phase, deployment.tasks[0], deployment.tasks).kind).toBe('authored');
      expect(phaseScopeOf(deployment.phase, deployment.tasks).kind).toBe('authored');
    });
  });
});

describe('an executable phase whose graded bytes differ from TaskTrackr\'s resolves authored', () => {
  type Variant = [string, PhaseKey, (phase: PhaseContent) => PhaseContent];
  const editFile = (map: Record<string, string>): Record<string, string> => {
    const [first] = Object.keys(map).sort();
    return { ...map, [first]: `${map[first]}\n# n5 edit\n` };
  };
  const variants: Variant[] = [
    ['an editable starter file', 'implementation', (p) => ({ ...p, files: p.files.map((f, i) => (i === p.files.findIndex((one) => one.editable) ? { ...f, content: `${f.content}\n` } : f)) })],
    ['a hidden test', 'implementation', (p) => (p.checks.kind === 'code' ? { ...p, checks: { ...p.checks, hiddenTestFiles: editFile(p.checks.hiddenTestFiles), runs: p.checks.runs.map((run) => (Object.keys(run.hiddenTestFiles).length ? { ...run, hiddenTestFiles: editFile(run.hiddenTestFiles) } : run)) } } : p)],
    ['a solution file', 'implementation', (p) => (p.checks.kind === 'code' ? { ...p, checks: { ...p.checks, solutionFiles: editFile(p.checks.solutionFiles) } } : p)],
    ['a solution source', 'maintenance', (p) => (p.checks.kind === 'code' ? { ...p, checks: { ...p.checks, solutionSources: [...p.checks.solutionSources, 'def ours(): return 1'] } } : p)],
    ['a run', 'maintenance', (p) => (p.checks.kind === 'code' ? { ...p, checks: { ...p.checks, runs: p.checks.runs.map((run, i) => (i === 0 ? { ...run, label: `${run.label} (ours)` } : run)) } } : p)],
    ['a reference test', 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, referenceTestFiles: editFile(p.checks.referenceTestFiles), runs: p.checks.runs.map((run) => (Object.keys(run.referenceTestFiles).length ? { ...run, referenceTestFiles: editFile(run.referenceTestFiles) } : run)) } } : p)],
    ['an implementation file graded against', 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, implFiles: editFile(p.checks.implFiles) } } : p)],
    ['a mutant', 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, mutants: p.checks.mutants.map((m, i) => (i === 0 ? { ...m, files: editFile(m.files) } : m)) } } : p)],
    ['one mutant fewer', 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, mutants: p.checks.mutants.slice(1) } } : p)],
    ['a smoke implementation file', 'deployment', (p) => (p.checks.kind === 'config' ? { ...p, checks: { ...p.checks, smokeImplFiles: editFile(p.checks.smokeImplFiles) } } : p)],
    ['the drill\'s faulted file', 'deployment', (p) => (p.checks.kind === 'config' && p.checks.drill ? { ...p, checks: { ...p.checks, drill: { ...p.checks.drill, faultedFiles: editFile(p.checks.drill.faultedFiles) } } } : p)],
    ['a smoke command', 'deployment', (p) => (p.checks.kind === 'config' ? { ...p, checks: { ...p.checks, smokeCommands: [...p.checks.smokeCommands, ['python3', 'api/main.py', '--selfcheck']] } } : p)],
    ['the mentor prompt', 'testing', (p) => ({ ...p, assistant: { ...p.assistant, systemPrompt: `${p.assistant.systemPrompt} Ours.` } })],
    ['the brief', 'deployment', (p) => ({ ...p, taskPanel: `${p.taskPanel}\n\nOur class adds a rule.` })],
    ['an objective', 'maintenance', (p) => ({ ...p, objectives: [...p.objectives, 'One more of ours.'] })],
    ['the rubric', 'implementation', (p) => ({ ...p, rubric: { ...p.rubric, criteria: p.rubric.criteria.slice(1) } })],
  ];

  it.each(variants)('%s (%s)', (_what, key, edit) => {
    const base = tasktrackrPhase(key);
    const phase = edit(base);
    expect(phase).not.toEqual(base);
    expect(taskScopeOf(phase).kind).toBe('authored');
    expect(taskScopeOf(phase, soleTaskFor(phase), [soleTaskFor(phase)]).kind).toBe('authored');
    expect(phaseScopeOf(phase).kind).toBe('authored');
  });

  it("answers authored for a rewritten task on TaskTrackr's own phase: the brief, not the phase, is what is reviewed", () => {
    for (const key of EXECUTABLE) {
      const phase = tasktrackrPhase(key);
      const rewritten = { ...soleTaskFor(phase), brief: 'A teacher rewrote this brief.', objectives: ['Mine.'] };
      expect([key, taskScopeOf(phase, rewritten, [rewritten]).kind]).toEqual([key, 'authored']);
      expect([key, phaseScopeOf(phase, [rewritten]).kind]).toEqual([key, 'authored']);
    }
  });

  it('answers authored for a second work task beside the inherited one, at both grains', () => {
    for (const key of EXECUTABLE) {
      const phase = tasktrackrPhase(key);
      const inherited = tasktrackrTask(key);
      const second: CompiledTask = { ...inherited, taskKey: 'second', order: 2, title: 'A second task' };
      expect([key, phaseScopeOf(phase, [inherited, second]).kind]).toEqual([key, 'authored']);
      expect([key, taskScopeOf(phase, inherited, [inherited, second]).kind]).toEqual([key, 'authored']);
    }
  });
});

describe('a resolver that is total and fails safe on executable phases', () => {
  const partials: Array<[string, unknown]> = [
    ['code checks and nothing else', { key: 'implementation', checks: { kind: 'code' } }],
    ['tests checks with no runs', { key: 'testing', checks: { kind: 'tests', mutants: null } }],
    ['config checks with no files', { key: 'deployment', checks: { kind: 'config' } }],
    ['a maintenance phase with null files', { key: 'maintenance', files: null, checks: { kind: 'code', runs: [] } }],
  ];
  it.each(partials)('never throws and answers authored for %s', (_what, phase) => {
    expect(() => taskScopeOf(phase as PhaseContent)).not.toThrow();
    expect(() => phaseScopeOf(phase as PhaseContent)).not.toThrow();
    expect(taskScopeOf(phase as PhaseContent).kind).toBe('authored');
    expect(phaseScopeOf(phase as PhaseContent).kind).toBe('authored');
  });
});

describe('the offline mentor on an authored executable phase (neutralLadderFor covers the executable keys)', () => {
  it.each(EXECUTABLE)('climbs a neutral ladder of its own on %s, never the Requirements one and never the pack\'s', (key) => {
    const phase = shelfPhase(key);
    const scope = authoredPhaseScope(phase, [soleTaskFor(phase)]);
    const ladder = offlineLadderFor({ phase, scope });
    const requirements = offlineLadderFor({ phase: tasktrackrPhase('requirements'), scope: authoredPhaseScope(tasktrackrPhase('requirements'), [tasktrackrTask('requirements')]) });
    expect(ladder).not.toBe(requirements);
    expect(ladder).not.toBe(phase.assistant);
    expect(ladder.progressive.length).toBeGreaterThan(1);
    expect(ladder.topics.length).toBeGreaterThan(0);
    const text = JSON.stringify(ladder).toLowerCase();
    expect(REFERENCE_TERMS.filter((term) => text.includes(term.toLowerCase()))).toEqual([]);
  });
});

/*
 * The exec anchor leaves the screen-copy paths out only
 * where `withScreenCopy` lays the learner's copy over them, the read-only
 * application maps (`supportFiles`, `implFiles`, `smokeImplFiles`, flat and per
 * run) of a phase that declares the copy read-only. A sealed map the overlay
 * never touches (a mutant, a reference suite, the drill) keeps those paths in
 * the anchor, so a teacher's edit there is a task of their own.
 */
describe('the exec anchor hides only what the screen copy overlays', () => {
  const COPY = 'shared/contract/accepted-screen-copy.json';
  const CONTRACT = 'shared/contract/screens.json';
  const ours = '{"ours": true}\n';
  const blind: Array<[string, PhaseKey, (phase: PhaseContent) => PhaseContent]> = [
    ["a mutant's file at the screen-copy path", 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, mutants: p.checks.mutants.map((m, i) => (i === 0 ? { ...m, files: { ...m.files, [COPY]: ours } } : m)) } } : p)],
    ['a reference test at the screen-contract path', 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, referenceTestFiles: { ...p.checks.referenceTestFiles, [CONTRACT]: ours } } } : p)],
    ["the drill's faulted copy at the screen-copy path", 'deployment', (p) => (p.checks.kind === 'config' && p.checks.drill ? { ...p, checks: { ...p.checks, drill: { ...p.checks.drill, faultedFiles: { ...p.checks.drill.faultedFiles, [COPY]: ours } } } } : p)],
    ['an implementation file at a contract path the phase does not serve locked', 'testing', (p) => (p.checks.kind === 'tests' ? { ...p, checks: { ...p.checks, implFiles: { ...p.checks.implFiles, [CONTRACT]: ours } } } : p)],
  ];
  it.each(blind)('answers authored for %s (%s)', (_what, key, edit) => {
    const base = tasktrackrPhase(key);
    const phase = edit(base);
    expect(phase).not.toEqual(base);
    expect(taskScopeOf(phase, soleTaskFor(phase), [soleTaskFor(phase)]).kind).toBe('authored');
    expect(phaseScopeOf(phase).kind).toBe('authored');
  });

  // GUARD: every executable phase that declares the copy stays reference under a learner's accepted copy.
  it.each(EXECUTABLE)("keeps TaskTrackr %s reference under a learner's accepted Design screen copy", (key) => {
    const phase = withScreenCopy(tasktrackrPhase(key), { version: 1, sourceSubmissionId: 'submission-n5', sourcePhaseStateId: 'state-n5', title: 'Late work', empty: 'Nothing is late.' });
    const task = soleTaskFor(phase);
    expect(taskScopeOf(phase, task, [task])).toBe(REFERENCE_SCOPE);
    expect(phaseScopeOf(phase, [task])).toBe(REFERENCE_SCOPE);
  });
});

/* A neutral topic keyword is matched inside other words, so it must not be one that hides in common ones. */
describe('the neutral executable ladder picks the topic the learner asked about', () => {
  const local = new LocalMentorProvider();
  const topicOf = (key: PhaseKey, message: string) => {
    const phase = shelfPhase(key);
    return local.matchTopic({ phase, scope: authoredPhaseScope(phase, [soleTaskFor(phase)]), message } as unknown as MentorContext);
  };
  it("answers 'ordered' with the ordering topic, not the failing-test one", () => {
    const ordering = offlineLadderFor({ phase: shelfPhase('implementation'), scope: authoredPhaseScope(shelfPhase('implementation'), [soleTaskFor(shelfPhase('implementation'))]) })
      .topics.findIndex((topic) => topic.keywords.includes('order'));
    expect(topicOf('implementation', 'How should the results be ordered?')).toBe(ordering);
    expect(topicOf('implementation', 'Is a stored value required here?')).toBeNull();
  });
  it("does not read 'report' or 'support' as a port question", () => {
    expect(topicOf('deployment', 'What should my summary report?')).toBeNull();
    expect(topicOf('deployment', 'Which versions do we support?')).toBeNull();
  });
});
