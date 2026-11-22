import { API_CONTRACT_JSON, SCREEN_CONTRACT_JSON } from '@learnsdlc/shared';
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {
  SOLE_TASK_KEY,
  type ArtefactType,
  type RunHarness,
  type RunLanguage,
} from '@learnsdlc/shared';
import { digestOf } from './blob.store';
import { ContentService } from './content.service';
import type { CodeChecks, PhaseContent, PhaseRun, TestsChecks } from './content.types';
import { checksOf, compilePack, type CompiledTask } from './pack-compiler';

/**
 * Backward compatibility, phase by phase.
 *
 * The task grain is safe only if a phase declaring no tasks compiles to
 * exactly the phase it is without one: one task, keyed the empty string, carrying
 * the phase's own rubric, checks, brief and objectives, owning every editable
 * path and every graded unit. Every assertion here is about the imported
 * default project, because it is the one project in the repository and the
 * claim being tested is *"TaskTrackr imports and grades byte-identically"*.
 */
describe('a phase with no tasks compiles to the phase it already was', () => {
  let content: ContentService;
  let phases: PhaseContent[];
  let compiled: Map<string, CompiledTask[]>;

  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
    const project = content.getProject('tasktrackr');
    phases = project.phases;
    const snapshot = compilePack(project);
    compiled = new Map(snapshot.phases.map((p) => [p.key, p.tasks]));
  });

  const sole = (key: string): CompiledTask => {
    const tasks = compiled.get(key);
    if (!tasks || tasks.length !== 1) throw new Error(`${key} did not compile to one task`);
    return tasks[0];
  };

  it('a phase declaring no tasks compiles to exactly one, keyed the empty string', () => {
    expect([...compiled.keys()]).toEqual(phases.map((p) => p.key));
    for (const phase of phases) {
      const tasks = compiled.get(phase.key) as CompiledTask[];
      expect({ key: phase.key, tasks: tasks.length }).toEqual({ key: phase.key, tasks: 1 });
      const task = tasks[0];
      expect({
        taskKey: task.taskKey,
        order: task.order,
        required: task.required,
        signOff: task.signOff,
        checkKind: task.checkKind,
      }).toEqual({
        taskKey: SOLE_TASK_KEY,
        order: 1,
        required: true,
        signOff: false,
        checkKind: phase.checks.kind,
      });
      expect(task.taskKey).toBe('');

      // the phase's own words and its own grading, unchanged
      expect(task.title).toBe(phase.title);
      expect(task.brief).toBe(phase.taskPanel);
      expect(task.objectives).toEqual(phase.objectives);
      expect(digestOf(task.rubric)).toBe(digestOf(phase.rubric));
      // the phase's own checks, and *not a copy of them*: the sole task's
      // checks are the phase's, so the snapshot carries them once. A copy would
      // put every hidden test, every solution file and every mutant in the
      // `compiled` column twice: 373 KB of the shipped pack's 1194 KB,
      // measured: for a version whose phases each hold exactly one task.
      expect(task.checks).toBeUndefined();
      expect(checksOf(phase, task)).toBe(phase.checks);
      expect(digestOf(checksOf(phase, task))).toBe(digestOf(phase.checks));

      // every editable path, and nothing that is not one
      expect(task.owns.slice().sort()).toEqual(
        phase.files.filter((f) => f.editable).map((f) => f.path).sort(),
      );

      // every run id, rule id and mutant name the phase declares
      const checks = phase.checks;
      const runs = checks.kind === 'code' || checks.kind === 'tests' ? checks.runs.map((r) => r.id) : [];
      const rules = checks.kind === 'config' ? checks.rules.map((r) => r.id) : [];
      const mutants = checks.kind === 'tests' ? checks.mutants.map((m) => m.name) : [];
      // a story phase grades one unit: its record; a design phase its record and each contract switched on;
      // a Deployment with a runbook and a Maintenance with a change request their record too (TaskTrackr 5.0.0)
      const records = checks.kind === 'story'
        ? [checks.record]
        : checks.kind === 'design'
          ? [checks.record, ...(checks.contracts.api ? [API_CONTRACT_JSON] : []), ...(checks.contracts.screens ? [SCREEN_CONTRACT_JSON] : [])]
          : checks.kind === 'config' && checks.runbook
            ? [checks.runbook.record]
            : checks.kind === 'code' && checks.change
              ? [checks.change.record]
              : [];
      expect(task.gradedUnits).toEqual([
        ...runs.map((id) => ({ kind: 'run', id })),
        ...rules.map((id) => ({ kind: 'rule', id })),
        ...mutants.map((id) => ({ kind: 'mutant', id })),
        ...records.map((id) => ({ kind: 'record', id })),
      ]);
      expect(task.gradedUnits.length).toBeGreaterThan(0);
    }
  });

  it('artefactType is derived from checks.kind first', () => {
    const byPhase: Record<string, ArtefactType> = {};
    for (const phase of phases) byPhase[phase.key] = sole(phase.key).artefactType;
    expect(byPhase).toEqual({
      requirements: 'user-story',
      design: 'design-doc',
      implementation: 'code',
      testing: 'tests',
      deployment: 'runbook',
      // the maintenance phase's `checks.kind` is `code`, and the kind is the
      // fact: deriving from the phase key would synthesise a `change-request`
      // task over four editable code targets, two graded runs and the fixed
      // code rubric
      maintenance: 'code',
    });
  });

  it("artefactPath is the phase's own editable markdown or null", () => {
    const byPhase: Record<string, string | null> = {};
    for (const phase of phases) byPhase[phase.key] = sole(phase.key).artefactPath;
    expect(byPhase).toEqual({
      // a story phase's record is JSON, not prose, so its room reads no file path
      requirements: null,
      // and a design phase's records are JSON too
      design: null,
      implementation: null,
      testing: null,
      // the runbook is a record (TaskTrackr 5.0.0), JSON worked in the Runbook tab, so no prose file either
      deployment: null,
      // the maintenance task is pathless: its artefact type is `code`, so the
      // room is the IDE and the path it reads is the task's `primaryPath`
      maintenance: null,
    });
  });

  it('runsFor over the compiled snapshot produces byte-identical jobs', () => {
    for (const phase of phases) {
      const checks = phase.checks;
      if (checks.kind !== 'code' && checks.kind !== 'tests') continue;
      const task = sole(phase.key);
      const taskChecks = checksOf(phase, task) as CodeChecks | TestsChecks;
      expect(digestOf(runsFor(phase, taskChecks))).toBe(digestOf(runsFor(phase, checks)));
      expect(runsFor(phase, taskChecks).map((r) => r.id)).toEqual(checks.runs.map((r) => r.id));
    }

    const implementation = phases.find((p) => p.key === 'implementation') as PhaseContent;
    if (implementation.checks.kind !== 'code') throw new Error('implementation is a code phase');

    // The flat shape `runsFor`'s fallback exists for: it synthesises one run
    // with `id: ''` and `label: ''`, which is the convention the sole task's
    // own key follows. It is unreachable for a *loaded* pack: the loader gives
    // a pack declaring no `checks.runs` one run keyed `main`, and the
    // assertion is here so that the convention is written down where the task
    // key is, rather than inferred.
    const flat: CodeChecks = { ...implementation.checks, runs: [] };
    const synthesised = runsFor({ ...implementation, checks: flat }, flat);
    expect(synthesised).toHaveLength(1);
    expect({ id: synthesised[0].id, label: synthesised[0].label }).toEqual({ id: '', label: '' });

    // and the loader's own single-run shape: one run, one task, the same jobs
    const oneRun: CodeChecks = { ...implementation.checks, runs: [implementation.checks.runs[0]] };
    const onePhase: PhaseContent = { ...implementation, checks: oneRun };
    const compiledOne = compilePack({
      ...content.getProject('tasktrackr'),
      phases: phases.map((p) => (p.key === 'implementation' ? onePhase : p)),
    });
    const oneTask = (
      compiledOne.phases.find((p) => p.key === 'implementation') as { tasks: CompiledTask[] }
    ).tasks[0];
    expect(oneTask.gradedUnits).toEqual([{ kind: 'run', id: oneRun.runs[0].id }]);
    expect(digestOf(runsFor(onePhase, checksOf(onePhase, oneTask) as CodeChecks))).toBe(
      digestOf(runsFor(onePhase, oneRun)),
    );
  });
});

/**
 * `runsFor`, transcribed from `feedback/feedback.service.ts`.
 *
 * The real function is module-private in the feedback service, so the
 * assertions above run against a copy of it. That is sound for what they
 * assert (the compiled task's checks *are* the phase's checks, so any function
 * of `checks` returns the same answer for both), but on its own a copy can say
 * nothing about the grader, because both sides of every comparison go through
 * the copy. The test below is what closes that: the original's own source,
 * normalised, is pinned here, so the day the grader's `runsFor` changes this
 * spec fails and names the copy that has to change with it.
 *
 * The pin is a stopgap and it says so. Exporting `runsFor` from
 * `feedback/feedback.service.ts` would let the copy below be deleted and the
 * assertions be about the grader rather than about a transcription of it.
 */
const RUNS_FOR_AS_SHIPPED = [
  'function runsFor(phase: PhaseContent, checks: CodeChecks | TestsChecks): PhaseRun[] {',
  'if (checks.runs?.length) return checks.runs;',
  "const language = (phase.language || 'python') as RunLanguage;",
  'const harness = defaultHarness(language);',
  "const code = checks.kind === 'code';",
  'const hiddenTestFiles = code ? checks.hiddenTestFiles ?? {} : {};',
  'const learnerTestFiles = code ? [] : checks.learnerTestFiles ?? [];',
  'return [',
  '{',
  "id: '',",
  "label: '',",
  'language,',
  'harness,',
  'hiddenHarness: harness,',
  'transform: false,',
  'testPaths: code ? Object.keys(hiddenTestFiles) : learnerTestFiles,',
  'visibleTests: code ? checks.visibleTests ?? [] : [],',
  'hiddenTestFiles,',
  'learnerTestFiles,',
  'referenceTestFiles: code ? {} : checks.referenceTestFiles ?? {},',
  'implFiles: code ? {} : checks.implFiles ?? {},',
  'supportFiles: code ? {} : checks.supportFiles ?? {},',
  '},',
  '];',
  '}',
].join('\n');

/**
 * The grader's own `runsFor`, as source, with comments and indentation taken
 * out: what is pinned is the code and not the prose around it, so a reworded
 * comment in the grader does not fail this spec and a changed expression does.
 */
function shippedRunsForSource(): string {
  const at = path.join(__dirname, '..', 'feedback', 'feedback.service.ts');
  const text = fs.readFileSync(at, 'utf-8');
  const open = text.indexOf('\nfunction runsFor(');
  if (open < 0) throw new Error('feedback.service.ts declares no module-level runsFor');
  const close = text.indexOf('\n}\n', open);
  return text
    .slice(open + 1, close + 2)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .join('\n');
}

describe('the transcription of the grader is still the grader', () => {
  it("runsFor in feedback.service.ts is the function this spec's copy was taken from", () => {
    // If this fails, the grader's `runsFor` changed. Do not re-record it:
    // export the real function and delete the copy below, which is the one-word
    // change this pin exists to make unnecessary.
    expect(shippedRunsForSource()).toBe(RUNS_FOR_AS_SHIPPED);
  });
});

function runsFor(phase: PhaseContent, checks: CodeChecks | TestsChecks): PhaseRun[] {
  if (checks.runs?.length) return checks.runs;
  const language = (phase.language || 'python') as RunLanguage;
  const harness: RunHarness = language === 'python' ? 'unittest' : 'js';
  const code = checks.kind === 'code';
  const hiddenTestFiles = code ? checks.hiddenTestFiles ?? {} : {};
  const learnerTestFiles = code ? [] : checks.learnerTestFiles ?? [];
  return [
    {
      id: '',
      label: '',
      language,
      harness,
      hiddenHarness: harness,
      transform: false,
      testPaths: code ? Object.keys(hiddenTestFiles) : learnerTestFiles,
      visibleTests: code ? checks.visibleTests ?? [] : [],
      hiddenTestFiles,
      learnerTestFiles,
      referenceTestFiles: code ? {} : checks.referenceTestFiles ?? {},
      implFiles: code ? {} : checks.implFiles ?? {},
      supportFiles: code ? {} : checks.supportFiles ?? {},
    },
  ];
}
