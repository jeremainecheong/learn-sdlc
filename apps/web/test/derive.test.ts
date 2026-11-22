import { describe, expect, it } from 'vitest';
import { baseName, buildNextSteps, shortTitle } from '@/components/home/derive';
import {
  buildProblems,
  buildTree,
  defaultCollapsed,
  functionChips,
  functionsIn,
  headlineFor,
} from '@/components/workspace/ide/derive';
import { groupCases } from '@/components/workspace/RunPanel';
import { file, report, sample, submission } from './fixtures';
import type { RunResult, RunStep } from '@learnsdlc/shared';

/**
 * The pure derivations behind the learner's next steps and the IDE: words,
 * the "Do next" list, the file tree, the headline and the run's groups.
 */

describe('words', () => {
  it('cuts a project title down to the part a crumb shows', () => {
    expect(shortTitle('TaskTrackr — a command-line task manager')).toBe('TaskTrackr');
    expect(shortTitle('TaskFlow')).toBe('TaskFlow');
    // An em dash with nothing before it leaves the title alone rather than blank.
    expect(shortTitle('— nothing before it')).toBe('— nothing before it');
  });

  it('names a file by its last segment', () => {
    expect(baseName('requirements/story.json')).toBe('story.json');
    expect(baseName('Dockerfile')).toBe('Dockerfile');
    expect(baseName('')).toBe('');
  });
});

describe('buildNextSteps', () => {
  it('works the list out from what the last submission was marked down on', () => {
    const { enrollment, details } = sample();
    const current = enrollment.phases[3];
    const marked = {
      ...details,
      p4: {
        ...details.p4,
        lastSubmission: submission({
          status: 'completed',
          passed: false,
          report: report({
            overall: 62,
            passThreshold: 70,
            criteria: [
              { key: 'a', title: 'Kill the mutants', score: 40, weight: 0.5, evidence: ['One survived.'] },
              { key: 'b', title: 'Name the cases', score: 90, weight: 0.5, evidence: [] },
            ],
            checks: [{ id: 'lint', label: 'Style', status: 'failed', detail: 'Two long lines.' }],
            aiReview: { summary: '', points: [], improvements: ['Cover the empty keyword.'] },
          } as never),
        }),
      },
    };

    const plan = buildNextSteps(enrollment, marked, current);

    expect(plan.purpose).toContain('submission 1 of Testing');
    expect(plan.steps[0].key).toBe('gate');
    expect(plan.steps[0].detail).toContain('Scored 62, pass mark 70');
    expect(plan.steps[0].detail).toContain('Cover the empty keyword.');
    // Only the criteria under the gate, weakest first, and never more than two.
    expect(plan.steps[1].title).toBe('Kill the mutants');
    expect(plan.steps.some((s) => s.title === 'Name the cases')).toBe(false);
    // The failed check and the way back in.
    expect(plan.steps.map((s) => s.key)).toContain('check:lint');
    expect(plan.steps.length).toBeLessThanOrEqual(5);
    // Every step links into the phase in hand.
    expect(new Set(plan.steps.map((s) => s.href))).toEqual(new Set(['/workspace/p4']));
  });

  it('asks for the reflection when the gate is passed and nothing else is in the way', () => {
    const { enrollment, details } = sample();
    const passed = { ...enrollment.phases[3], status: 'passed' as const, bestScore: 88 };
    const plan = buildNextSteps(
      { ...enrollment, phases: [...enrollment.phases.slice(0, 3), passed, ...enrollment.phases.slice(4)] },
      details,
      passed,
    );

    expect(plan.steps[0].key).toBe('passed');
    expect(plan.steps[1].key).toBe('reflect');
    expect(plan.steps[1].detail).toContain('Deployment');
  });

  it('moves on once the reflection is written', () => {
    const { enrollment, details } = sample();
    const passed = {
      ...enrollment.phases[3],
      status: 'passed' as const,
      bestScore: 88,
      reflection: 'Mutants first.',
    };
    const plan = buildNextSteps(enrollment, details, passed);
    expect(plan.steps[1].key).toBe('advance');
    expect(plan.steps[1].title).toBe('Move on to Deployment');
  });

  it('waits, rather than advising, while a submission is being graded', () => {
    const { enrollment, details } = sample();
    const pending = {
      ...details,
      p4: { ...details.p4, lastSubmission: submission({ status: 'queued' }) },
    };
    const plan = buildNextSteps(enrollment, pending, enrollment.phases[3]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].key).toBe('pending');
  });

  it('offers another go, with the reason, when grading itself broke', () => {
    const { enrollment, details } = sample();
    const broke = {
      ...details,
      p4: {
        ...details.p4,
        lastSubmission: submission({ status: 'failed', error: 'The sandbox was unreachable.' }),
      },
    };
    const plan = buildNextSteps(enrollment, broke, enrollment.phases[3]);
    expect(plan.steps[0].key).toBe('retry');
    expect(plan.steps[0].detail).toBe('The sandbox was unreachable.');
  });

  it('falls back to the brief when nothing has been submitted', () => {
    const { enrollment, details } = sample();
    const fresh = { ...details, p4: { ...details.p4, lastSubmission: null } };
    const plan = buildNextSteps(enrollment, fresh, enrollment.phases[3]);

    expect(plan.purpose).toContain('Nothing has been submitted yet');
    expect(plan.steps[plan.steps.length - 1].key).toBe('submit');
  });

  it('has one thing to say when every gate has passed', () => {
    const { enrollment, details } = sample();
    const plan = buildNextSteps({ ...enrollment, completed: true }, details, undefined);
    expect(plan.steps.map((s) => s.key)).toEqual(['done', 'summary']);
    expect(plan.steps[0].href).toBe('/complete');
  });

  it('says nothing at all when there is no current phase to say it about', () => {
    const { enrollment, details } = sample();
    expect(buildNextSteps(enrollment, details, undefined)).toEqual({ purpose: '', steps: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* The workspace's own derivations.                                            */
/* -------------------------------------------------------------------------- */

/**
 * The explorer tree over a two-directory, twenty-six-file application.
 *
 * Everything below is about one behaviour: folders open and close. A tree
 * with every folder fixed open and no toggle handler is fine for a six-file
 * CLI and a wall for a full-stack repository.
 */
describe('buildTree, folded', () => {
  const APP = [
    file('api/main.py', '', false),
    file('api/repository/lists.py', '', false),
    file('api/repository/tasks.py', '', true),
    file('shared/contract/api.json', '', false),
    file('web/src/hooks/useTasks.ts', '', true),
    file('web/src/pages/ListsPage.tsx', '', false),
    file('README.md', '', false),
  ];
  const opts = { activePath: '', modified: () => false, onOpen: () => {} };
  const names = (nodes: ReturnType<typeof buildTree>) => nodes.map((n) => n.name);

  it('opens every folder when it is given no collapsed set at all', () => {
    const rows = buildTree(APP, opts);
    expect(rows.filter((n) => n.kind === 'folder').every((n) => n.open)).toBe(true);
    expect(names(rows)).toContain('tasks.py');
  });

  /** A folder holding an editable file anywhere below it is open by default. */
  it('starts a folder that holds a gap open, and one that holds none closed', () => {
    const closed = defaultCollapsed(APP);
    expect(closed.has('api/repository')).toBe(false);
    expect(closed.has('web/src/hooks')).toBe(false);
    expect(closed.has('shared/contract')).toBe(true);
    expect(closed.has('web/src/pages')).toBe(true);
  });

  it('draws a collapsed folder as its own row and none of its children', () => {
    const rows = buildTree(APP, { ...opts, collapsed: new Set(['api/repository']) });
    expect(names(rows)).toContain('repository');
    expect(names(rows)).not.toContain('tasks.py');
    expect(names(rows)).not.toContain('lists.py');
    // Its siblings are untouched.
    expect(names(rows)).toContain('main.py');
  });

  it('says which way the chevron points', () => {
    const rows = buildTree(APP, { ...opts, collapsed: new Set(['api/repository']) });
    const folder = rows.find((n) => n.name === 'repository');
    expect(folder?.open).toBe(false);
    expect(rows.find((n) => n.name === 'api')?.open).toBe(true);
  });

  /**
   * The fold: `shared/contract` is one row, not two, and it is toggled and
   * remembered under the path of the folder it actually opens.
   */
  it('keeps folding a chain of single sub-folders into one row', () => {
    const rows = buildTree(APP, opts);
    expect(names(rows)).toContain('shared/contract');
    expect(names(rows)).not.toContain('shared');
    const folded = rows.find((n) => n.name === 'shared/contract');
    expect(folded?.testId).toBe('explorer-folder-shared-contract');
  });

  it('closes a folded chain by the folder it opens, not by its first segment', () => {
    const byLeaf = buildTree(APP, { ...opts, collapsed: new Set(['shared/contract']) });
    expect(names(byLeaf)).not.toContain('api.json');
    const byRoot = buildTree(APP, { ...opts, collapsed: new Set(['shared']) });
    expect(names(byRoot)).toContain('api.json');
  });

  it('hands the toggle the folder it drew, so the click closes what it names', () => {
    const toggled: string[] = [];
    const rows = buildTree(APP, { ...opts, onToggle: (p) => toggled.push(p) });
    rows.find((n) => n.name === 'shared/contract')?.onToggle?.();
    rows.find((n) => n.name === 'repository')?.onToggle?.();
    expect(toggled).toEqual(['shared/contract', 'api/repository']);
  });

  it('leaves files as they were: active, modified, and one testid apiece', () => {
    const rows = buildTree(APP, {
      ...opts,
      activePath: 'api/main.py',
      modified: (p) => p === 'api/main.py',
    });
    const f = rows.find((n) => n.name === 'main.py');
    expect(f?.active).toBe(true);
    expect(f?.modified).toBe(true);
    expect(f?.testId).toBe('explorer-file-api-main-py');
  });
});

describe('headlineFor', () => {
  /**
   * The sentence is not overridden with the basename of the first editable
   * file, which would name one gap out of five once the phase spans two
   * layers, and could name a file the pack does not contain.
   */
  it('names the work rather than one of five files', () => {
    const files = [
      file('api/repository/tasks.py', '', true),
      file('web/src/hooks/useTasks.ts', '', true),
    ];
    expect(headlineFor('implementation', files)).toBe(
      'Fill the marked gaps, across the API and the front end',
    );
    expect(headlineFor('implementation', [])).toBe(
      'Fill the marked gaps, across the API and the front end',
    );
  });

  it('names operations and screens on the design phase, not functions', () => {
    expect(headlineFor('design', [])).toBe(
      'Name every operation and every screen, and say what each promises',
    );
  });

  it('leaves the other four phases as they were', () => {
    expect(headlineFor('requirements', [])).toContain('US-4');
    expect(headlineFor('testing', [])).toContain('fail first');
    expect(headlineFor('deployment', [])).toContain('incident');
    expect(headlineFor('maintenance', [])).toContain('Change the contract');
  });
});

/**
 * The Tests pane over a phase graded by two runs.
 *
 * A merged result carries a `steps[]` and a `step` on each case, and one flat
 * list of thirty cases across two languages hides which half is red. A
 * single-run result carries no `steps` and must render as one flat table.
 */
describe('groupCases', () => {
  const step = (id: string, label: string, ok: boolean): RunStep => ({
    id,
    label,
    ok,
    exitKind: 'ok',
    durationMs: 10,
    total: 1,
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    errored: 0,
  });
  const result = (over: Partial<RunResult>): RunResult => ({
    ok: true,
    exitKind: 'ok',
    durationMs: 20,
    stdout: '',
    stderr: '',
    ...over,
  });

  it('groups nothing when the run had one layer', () => {
    const r = result({
      tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [{ name: 'a', status: 'passed' }] },
    });
    expect(groupCases(r)).toEqual([]);
  });

  it('draws one group per run, each with its own cases', () => {
    const r = result({
      steps: [step('api', 'API tests', true), step('web', 'Front-end tests', false)],
      tests: {
        total: 3,
        passed: 2,
        failed: 1,
        errored: 0,
        cases: [
          { name: 'test_lists', status: 'passed', step: 'api' },
          { name: 'test_tasks', status: 'passed', step: 'api' },
          { name: 'renders a row', status: 'failed', step: 'web' },
        ],
      },
    });
    const groups = groupCases(r);
    expect(groups.map((g) => g.step.label)).toEqual(['API tests', 'Front-end tests']);
    expect(groups[0].cases.map((c) => c.name)).toEqual(['test_lists', 'test_tasks']);
    expect(groups[1].cases.map((c) => c.name)).toEqual(['renders a row']);
  });

  /**
   * Nothing may disappear from a verdict. A case naming a step the result does
   * not carry would fall between the groups and never be drawn, so an orphan
   * sends the whole thing back to the flat table.
   */
  it('falls back to one table rather than losing a case that names no step', () => {
    const r = result({
      steps: [step('api', 'API tests', true)],
      tests: {
        total: 2,
        passed: 2,
        failed: 0,
        errored: 0,
        cases: [
          { name: 'test_lists', status: 'passed', step: 'api' },
          { name: 'orphan', status: 'passed' },
        ],
      },
    });
    expect(groupCases(r)).toEqual([]);
  });

  it('groups nothing on a build check, which has no cases at all', () => {
    expect(groupCases(result({ steps: [step('api', 'API tests', true)] }))).toEqual([]);
  });
});

/**
 * A problem drawn from a failing case knows which case it came from
 * (`note.test` carries it into the editor's inline note) and the row must
 * keep it too, because the row is where the reviewer is asked about it.
 */
describe('a problem carries the test that produced it', () => {
  const failing = report({
    tests: {
      total: 1,
      passed: 0,
      failed: 1,
      errored: 0,
      cases: [
        {
          name: 'test_overdue_excludes_today',
          status: 'failed',
          message: 'AssertionError: assert 2 == 1',
          frames: [{ path: 'api/repository/tasks.py', line: 56 }],
        },
      ],
    },
  });

  it('names the case a failing line came from', () => {
    const problems = buildProblems(failing, [], (path) => path === 'api/repository/tasks.py');
    expect(problems).toHaveLength(1);
    expect(problems[0].test).toBe('test_overdue_excludes_today');
    expect(problems[0].note.test).toBe('test_overdue_excludes_today');
    expect(problems[0].line).toBe(56);
  });

  it('names no case on a contract claim, because none does', () => {
    const claimed = report({
      contract: [
        {
          name: 'overdue_tasks',
          claim: 'boundary',
          expected: 'strictly before today',
          actual: 'on or before today',
          verdict: 'broken',
          evidence: [],
        },
      ],
    } as never);
    const problems = buildProblems(
      claimed,
      [{ name: 'overdue_tasks', path: 'api/repository/tasks.py', line: 40, endLine: 60 }] as never,
      () => true,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].test).toBeUndefined();
  });
});

/**
 * The phase strip's chips.
 *
 * Three of a file's functions are drawn and the rest are dropped, so which
 * three, and what is said about the ones that are not, is the whole design.
 */
describe('functionChips', () => {
  const PY = [
    'def _to_task(record):', '    return record', '',
    'def list_tasks(conn):', '    return []', '',
    'def create_task(conn, title):', '    return None', '',
    'def complete_task(conn, task_id):', '    return None', '',
    'def get_overdue(conn):', '    return []', '',
  ].join('\n');
  const spans = functionsIn('api/repository/tasks.py', PY, []);

  it('leaves the private helper to last: the lab is not about _to_task', () => {
    expect(spans[0].name, 'the file still starts with the helper').toBe('_to_task');
    expect(functionChips(spans, PY, null).map((c) => c.text)).not.toContain('_to_task passes');
  });

  it('does not infer a passing function from the absence of TODOs or failures', () => {
    const chips = functionChips(spans, PY, null);
    expect(chips.every((chip) => chip.tone === 'neutral')).toBe(true);
    expect(chips.some((chip) => chip.text.includes('not reviewed'))).toBe(true);
    expect(chips.some((chip) => chip.text.includes('passes'))).toBe(false);
  });

  it('says how many functions it did not draw, rather than ending at the edge', () => {
    const chips = functionChips(spans, PY, null);
    expect(chips).toHaveLength(4);
    expect(chips[chips.length - 1].text).toBe('+2 more');
  });

  it('draws every function when they all fit, with no count', () => {
    const chips = functionChips(spans.slice(0, 2), PY, null);
    expect(chips).toHaveLength(2);
    expect(chips.some((c) => c.text.endsWith('more'))).toBe(false);
  });
});
