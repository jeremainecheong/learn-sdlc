import { ContentService } from './content.service';
import type { ConfigChecks, PhaseContent } from './content.types';
import { gradedUnitsOf, soleTaskFor, type CompiledTask } from './pack-compiler';
import { requiredKeysOf, ownsUnit, soleTaskList, unitsOf } from './task-units';
import { fixtureQuizChecks } from '../../test/quiz-fixture';

/**
 * The reader's seam, on its own.
 *
 * Every per-task derivation is written
 * `soleTaskList(tasks) ? <the phase-wide expression, unchanged> : <the per-task
 * expression>`, and this file is where that predicate and its four companions
 * are held to the lemmas the task grain rests on. A phase whose compiled list
 * is one synthesised task must answer exactly what the phase-wide code
 * answers, that is the TaskTrackr proof, and a phase
 * whose list is one *authored* task must not, because that is every phase of
 * every teacher-authored project.
 */

const content = new ContentService();
content.loadAll();

const PHASE_KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

/** Every TaskTrackr phase, as the loader produces it. */
function phases(): PhaseContent[] {
  return PHASE_KEYS.map((key) => content.getPhase('tasktrackr', key));
}

/** A task keyed by an author, carrying only what the assertion is about. */
function authored(over: Partial<CompiledTask> & { taskKey: string }): CompiledTask {
  return {
    order: 1,
    required: true,
    signOff: false,
    checkKind: 'story',
    artefactType: 'user-story',
    artefactPath: null,
    title: over.taskKey,
    brief: '',
    objectives: [],
    owns: [],
    gradedUnits: [],
    rubric: { passThreshold: 70, criteria: [] },
    ...over,
  };
}

/** TaskTrackr's Deployment checks with a file rule for each id it is handed, in order. */
function slice(ids: string[]): ConfigChecks {
  return {
    ...(content.getPhase('tasktrackr', 'deployment').checks as ConfigChecks),
    rules: ids.map((id) => ({
      id,
      label: id,
      criterion: 'clarity',
      pattern: id,
      required: true,
      failDetail: `${id} is missing.`,
      target: 'Dockerfile',
    })),
  };
}

describe('the sole-task predicate', () => {
  it('soleTaskList needs both conjuncts', () => {
    for (const phase of phases()) {
      expect(soleTaskList([soleTaskFor(phase)])).toBe(true);
    }

    // a one-element list keyed `main` is EVERY phase of EVERY
    // teacher-authored project, of every check kind. A length test alone would
    // send all of them down the phase-wide arm, where they would get no
    // task_states row while their required set is {'main'}: a key with no row
    // is a failing key, and the phase could never pass.
    expect(soleTaskList([authored({ taskKey: 'main' })])).toBe(false);

    // And the other direction: `checkPhase` accepts the empty key inside an
    // authored list, so a phase authored as ['' required, 'web' optional] would
    // take the sole-task arm on a key test alone, where the verdict is
    // whichever task's submission landed, and passing the OPTIONAL task would
    // open the phase and serve the answer key.
    expect(
      soleTaskList([
        authored({ taskKey: '', order: 1 }),
        authored({ taskKey: 'web', order: 2, required: false }),
      ]),
    ).toBe(false);

    expect(soleTaskList([])).toBe(false);
  });

  it('requiredKeysOf takes the required tasks and nothing else', () => {
    const tasks = [
      authored({ taskKey: 'story', order: 1 }),
      authored({ taskKey: 'scope', order: 2, required: false }),
      authored({ taskKey: 'criteria', order: 3 }),
    ];
    const keys = requiredKeysOf(tasks);
    expect(keys.size).toBe(2);
    expect([...keys].sort()).toEqual(['criteria', 'story']);
    expect(keys.has('scope')).toBe(false);

    // A sole task is required by construction, so the set is the one key.
    for (const phase of phases()) {
      expect([...requiredKeysOf([soleTaskFor(phase)])]).toEqual(['']);
    }
  });
});

describe('the units a task is scored by', () => {
  it('unitsOf returns the phase’s own units for a sole task', () => {
    // the sole task IS the phase, as a test, for all six phases: its units are
    // `gradedUnitsOf(phase)` and the first arm never reads `task.gradedUnits`
    // at all, which keeps the per-task readers correct against a snapshot
    // compiled before tasks were stored.
    for (const phase of phases()) {
      const sole = soleTaskFor(phase);
      expect(unitsOf(phase, [sole], sole)).toEqual(gradedUnitsOf(phase));
    }
  });

  it('unitsOf returns an authored task’s own units', () => {
    const phase = content.getPhase('tasktrackr', 'requirements');
    const mine = authored({ taskKey: 'story', gradedUnits: [{ kind: 'rule', id: 'r1' }] });
    const sibling = authored({ taskKey: 'scope', order: 2, gradedUnits: [{ kind: 'rule', id: 'r2' }] });
    expect(unitsOf(phase, [mine, sibling], mine)).toEqual([{ kind: 'rule', id: 'r1' }]);
    // A one-element AUTHORED list is not the sole-task arm.
    expect(unitsOf(phase, [mine], mine)).toEqual([{ kind: 'rule', id: 'r1' }]);
  });

  it('ownsUnit asks about a pair, never about a string', () => {
    const phase = content.getPhase('tasktrackr', 'requirements');
    const mine = authored({
      taskKey: 'story',
      gradedUnits: [{ kind: 'rule', id: 'shared-name' }],
    });
    const sibling = authored({ taskKey: 'scope', order: 2, gradedUnits: [] });
    const tasks = [mine, sibling];
    expect(ownsUnit(phase, tasks, mine, 'rule', 'shared-name')).toBe(true);
    // The three namespaces are separate: a run and a rule may share a name.
    expect(ownsUnit(phase, tasks, mine, 'run', 'shared-name')).toBe(false);
    expect(ownsUnit(phase, tasks, sibling, 'rule', 'shared-name')).toBe(false);
  });
});

describe('the reader’s seam answers for a quiz task', () => {
  const quizTask = (): CompiledTask =>
    authored({
      taskKey: 'check',
      order: 2,
      required: false,
      checkKind: 'quiz',
      artefactType: 'quiz',
      checks: fixtureQuizChecks(),
      gradedUnits: fixtureQuizChecks().questions.map((one) => ({ kind: 'question', id: one.id })),
    });

  it('unitsOf answers a quiz task’s own questions, and ownsUnit asks about the pair', () => {
    // A phase holding a quiz holds two tasks, so `soleTaskList` is false and
    // every derivation takes the per-task arm, which for a quiz is its own
    // pool and never the phase's rules.
    const phase = content.getPhase('tasktrackr', 'design');
    const graded = authored({ taskKey: 'main', gradedUnits: gradedUnitsOf(phase) });
    const quiz = quizTask();
    const tasks = [graded, quiz];

    expect(unitsOf(phase, tasks, quiz).map((one) => one.id)).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
      'q5',
    ]);
    expect(ownsUnit(phase, tasks, quiz, 'question', 'q1')).toBe(true);
    expect(ownsUnit(phase, tasks, quiz, 'rule', 'q1')).toBe(false);
    expect(ownsUnit(phase, tasks, graded, 'question', 'q1')).toBe(false);

    // the phase's own units are unchanged by the quiz beside them, which is
    // half of the all-six-phases rule
    expect(unitsOf(phase, tasks, graded)).toEqual(gradedUnitsOf(phase));
  });
});
