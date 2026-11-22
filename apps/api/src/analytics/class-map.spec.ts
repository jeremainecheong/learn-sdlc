import 'reflect-metadata';
import { RUNBOOK_FLOOR_IDS, changeFloorIds, type FeedbackReport } from '@learnsdlc/shared';
import { ContentService, validateDesignChecks } from '../content/content.service';
import { soleTaskFor } from '../content/pack-compiler';
import {
  NodeSpec,
  buildNodeSpecs,
  casesForFunction,
  definitionNames,
  nodeStatus,
  ownedRuleReport,
  ruleOwners,
} from './class-map';
import { recordPack } from '../../test/record-pack';

const report = (parts: Partial<FeedbackReport>): FeedbackReport => ({
  overall: 70,
  passed: true,
  passThreshold: 70,
  criteria: [],
  checks: [],
  aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'local' },
  aiReliance: { hintsThisPhase: 0, index: 0 },
  integrity: {
    relianceFlag: false,
    relianceIndex: 0,
    mentorPasteFlag: false,
    noEffortFlag: false,
    note: '',
  },
  ...parts,
});

const spec = (probe: NodeSpec['probe']): NodeSpec => ({
  id: 'x',
  label: 'x',
  kind: 'test',
  phase: 'implementation',
  probe,
});

describe('definitionNames', () => {
  it('takes the public defs out of a Python reference and leaves the dunders', () => {
    const source = [
      'class TaskManager:',
      '    def __init__(self):',
      '        pass',
      '    def complete_task(self, task_id):',
      '        return task_id',
      '',
      'def helper(value):',
      '    return value',
    ].join('\n');
    expect(definitionNames([source], 'python')).toEqual(['complete_task', 'helper']);
  });

  it('takes JavaScript class methods and leaves control flow behind', () => {
    const source = [
      'class TaskManager {',
      '  constructor() {',
      '    this._tasks = new Map();',
      '  }',
      '  completeTask(id) {',
      '    if (!id) {',
      '      return null;',
      '    }',
      '    for (const task of this._tasks) {',
      '      task.seen = true;',
      '    }',
      '    return this._find(id);',
      '  }',
      '  _find(id) {',
      '    return id;',
      '  }',
      '}',
      'function topLevel(a) {',
      '  return a;',
      '}',
    ].join('\n');
    expect(definitionNames([source], 'javascript')).toEqual(['completeTask', 'topLevel']);
  });
});

describe('casesForFunction', () => {
  const cases = [
    { name: 'test_complete_returns_the_task', status: 'passed' as const },
    { name: 'test_filter_done_returns_only_completed', status: 'failed' as const },
    { name: 'test_add_task_assigns_an_id', status: 'passed' as const },
  ];

  it('matches a test by the function it is named after, not by any shared word', () => {
    expect(casesForFunction('complete_task', cases).map((c) => c.name)).toEqual([
      'test_complete_returns_the_task',
    ]);
    expect(casesForFunction('filter_tasks', cases).map((c) => c.name)).toEqual([
      'test_filter_done_returns_only_completed',
    ]);
    expect(casesForFunction('overdue_tasks', cases)).toEqual([]);
  });
});

describe('buildNodeSpecs', () => {
  let content: ContentService;

  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
  });

  const specsFor = (slug: string): NodeSpec[] => buildNodeSpecs(content.getProject(slug));
  const project = (slug: string) => content.getProject(slug);

  it('draws one node per gate the pack sets, in every phase', () => {
    for (const project of content.listProjects()) {
      const specs = buildNodeSpecs(project);
      const phases = new Set(specs.map((s) => s.phase));
      expect(phases.size).toBe(project.phases.length);
      expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    }
  });

  it('reads the requirements stories and the design contracts off the rule ids', () => {
    const specs = specsFor('tasktrackr');
    expect(specs.filter((s) => s.phase === 'requirements').every((s) => s.kind === 'story')).toBe(true);
    // a story phase's gates are the record check and its floor lines, one node each
    expect(specs.filter((s) => s.phase === 'requirements').map((s) => s.id)).toEqual([
      'requirements:story:story.record',
      'requirements:story:story.sentence',
      'requirements:story:story.criteria.min',
      'requirements:story:story.criteria.tags',
      'requirements:story:story.scope.min',
    ]);
    // TaskTrackr 4.0.0's Design is a design phase: its nodes are its floor's
    // lines, in the floor's order, the model and contract lines as contracts,
    // so a line the floor renames moves the node with it.
    expect(specs.filter((s) => s.phase === 'design').map((s) => s.id)).toEqual([
      'design:story:design.record',
      'design:contract:design.entities.min',
      'design:contract:design.relations.min',
      'design:contract:design.operations.min',
      'design:contract:design.operations.shape',
      'design:story:design.decisions.min',
      'design:story:design.decisions.shape',
      'design:story:design.trace',
      'design:contract:design.api.min',
      'design:contract:design.api.errors',
      'design:contract:design.screens.min',
      'design:contract:design.screens.shape',
      // the thirteenth line: a design phase's floor is never cut to the map's twelve nodes a phase
      'design:story:design.sequence',
    ]);
    expect(specs.filter((s) => s.kind === 'contract').length).toBeGreaterThan(4);
  });

  it('names the implementation functions the pack itself calls out, and no plumbing', () => {
    const labels = specsFor('tasktrackr')
      .filter((s) => s.phase === 'implementation' && s.kind === 'function')
      .map((s) => s.label);
    // The three the coverage keywords name, and nothing the learner never
    // opens: `get_task`, `set_tags`, `create_task` and the rest of the
    // repository are plumbing and a map of plumbing tells an instructor
    // nothing about who is stuck.
    expect(labels).toContain('complete_task');
    expect(labels).toContain('overdue_tasks');
    expect(labels).not.toContain('get_task');
    expect(labels).not.toContain('set_tags');
    expect(labels).not.toContain('create_task');
  });

  it('reads the change request as the function the maintenance reference grows', () => {
    const changes = specsFor('tasktrackr').filter((s) => s.kind === 'change').map((s) => s.id);
    expect(changes[0]).toBe('deployment:change:drill');
    // CR-2 adds comments, so the functions the maintenance reference grows are
    // the comment ones. The testing phase mounts the whole application as its
    // implementation, and that must NOT count as "already written" or the one
    // node a maintenance class turns on disappears.
    expect(changes).toContain('maintenance:change:add_comment');
    expect(changes).toContain('maintenance:change:list_comments');
    expect(changes.every((id) => !id.startsWith('testing:change:'))).toBe(true);
  });

  it('carries every mutant and groups the deployment rules by the file they judge', () => {
    const specs = specsFor('tasktrackr');
    // Every mutant the testing phase ships, over both layers.
    const testing = project('tasktrackr').phases.find((p) => p.key === 'testing')!.checks;
    const mutants = testing.kind === 'tests' ? testing.mutants : [];
    expect(mutants.length).toBeGreaterThan(6);
    expect(specs.filter((s) => s.kind === 'mutant')).toHaveLength(mutants.length);
    const files = specs.filter((s) => s.kind === 'file');
    // The files the deployment rules judge, in the order the phase lists them, then the two record nodes (5.0.0).
    expect(files.map((s) => s.label)).toEqual([
      'api/Dockerfile',
      'docker-compose.yml',
      '.github/workflows/ci.yml',
      'Runbook',
      'Change request',
    ]);
    // Every config rule ends up under exactly one file node.
    const grouped = files.flatMap((s) => (s.probe.kind === 'rules' ? s.probe.ids : []));
    expect(grouped).toContain('docker-entrypoint');
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

describe('nodeStatus', () => {
  it('is missing until the learner has a report that says something about the node', () => {
    const rules = spec({ kind: 'rules', ids: ['story-format'] });
    expect(nodeStatus(rules, null)).toBe('missing');
    expect(nodeStatus(rules, report({ checks: [] }))).toBe('missing');
  });

  it('holds a rule to passing, so a soft warning is red rather than a pass', () => {
    const rules = spec({ kind: 'rules', ids: ['story-format', 'no-vague-terms'] });
    expect(
      nodeStatus(
        rules,
        report({
          checks: [
            { id: 'story-format', label: '', status: 'passed', detail: '' },
            { id: 'no-vague-terms', label: '', status: 'passed', detail: '' },
          ],
        }),
      ),
    ).toBe('green');
    expect(
      nodeStatus(
        rules,
        report({
          checks: [
            { id: 'story-format', label: '', status: 'passed', detail: '' },
            { id: 'no-vague-terms', label: '', status: 'warning', detail: '' },
          ],
        }),
      ),
    ).toBe('red');
  });

  it('is green on a function only when every test that names it passed', () => {
    const fn = spec({ kind: 'function', name: 'complete_task' });
    const tests = (cases: { name: string; status: 'passed' | 'failed' }[]) => ({
      total: cases.length,
      passed: cases.filter((c) => c.status === 'passed').length,
      failed: cases.filter((c) => c.status === 'failed').length,
      errored: 0,
      cases,
    });
    expect(nodeStatus(fn, report({ tests: tests([{ name: 'test_complete_marks_done', status: 'passed' }]) }))).toBe('green');
    expect(
      nodeStatus(
        fn,
        report({
          tests: tests([
            { name: 'test_complete_marks_done', status: 'passed' },
            { name: 'test_complete_unknown_id_raises', status: 'failed' },
          ]),
        }),
      ),
    ).toBe('red');
    // A suite that never reaches the function has not judged it.
    expect(nodeStatus(fn, report({ tests: tests([{ name: 'test_filter_by_status', status: 'passed' }]) }))).toBe('missing');
  });

  it('reads a mutant from the kill matrix, and from the survivor list when there is none', () => {
    const mutant = spec({ kind: 'mutant', name: 'overdue_boundary' });
    expect(
      nodeStatus(
        mutant,
        report({
          mutation: {
            total: 1,
            killed: 1,
            survivors: [],
            matrix: [{ mutant: 'overdue_boundary', description: '', killed: true, cases: [] }],
          },
        }),
      ),
    ).toBe('green');
    expect(
      nodeStatus(
        mutant,
        report({
          mutation: {
            total: 1,
            killed: 0,
            survivors: [{ name: 'overdue_boundary', description: '' }],
          },
        }),
      ),
    ).toBe('red');
    expect(nodeStatus(mutant, report({}))).toBe('missing');
  });

  it('wants the drill both fixed and diagnosed before it goes green', () => {
    const drill = spec({ kind: 'drill' });
    const outcome = (passedAfterFix: boolean, diagnosisNamesFault: boolean) =>
      report({
        drill: {
          fault: 'workdir-entrypoint-mismatch',
          faultDescription: '',
          failedBeforeFix: true,
          passedAfterFix,
          diagnosisNamesFault,
          beforeStderr: '',
          afterStdout: '',
        },
      });
    expect(nodeStatus(drill, outcome(true, true))).toBe('green');
    expect(nodeStatus(drill, outcome(true, false))).toBe('red');
    expect(nodeStatus(drill, outcome(false, true))).toBe('red');
    expect(nodeStatus(drill, report({}))).toBe('missing');
  });
});

/**
 * Which task a rule node's tally asks; the task
 * that owns the rule or the record, read from that task's report rather than
 * from whichever task submitted last, because `lecturePoints` is computed from
 * that tally.
 */
describe('ruleOwners and ownedRuleReport', () => {
  const content = new ContentService();
  content.loadAll();

  it('gives every rule of a sole task to that one key', () => {
    // a config phase's file rules, the one kind left whose units are rules
    const deployment = content.getProject('tasktrackr').phases.find((one) => one.key === 'deployment')!;
    const owners = ruleOwners(deployment, [soleTaskFor(deployment)]);
    expect([...new Set(owners.values())]).toEqual(['']);
    // the file rules and, since 5.0.0, the runbook floor's rules
    expect(owners.size).toBe(deployment.checks.kind === 'config' ? deployment.checks.rules.length + RUNBOOK_FLOOR_IDS.length : -1);
  });

  it('reads each rule from its owner, not from whichever task submitted last', () => {
    const passed = (id: string) => ({ id, label: id, status: 'passed' as const, detail: '' });
    const failed = (id: string) => ({ id, label: id, status: 'failed' as const, detail: '' });
    // two owners by hand: the merge reads each rule from the report of the task the map names
    const owners = new Map([['trace-us2', 'story'], ['decision-tradeoff', 'scope']]);
    const byTask = new Map([
      ['story', { checks: [passed('trace-us2'), failed('decision-tradeoff')] }],
      ['scope', { checks: [failed('decision-tradeoff')] }],
    ]);
    const merged = ownedRuleReport(owners, byTask);
    expect(nodeStatus(spec({ kind: 'rules', ids: ['trace-us2'] }), merged)).toBe('green');
    expect(nodeStatus(spec({ kind: 'rules', ids: ['decision-tradeoff'] }), merged)).toBe('red');
    // A task that has never submitted contributes nothing, and the node is
    // missing rather than red.
    const half = ownedRuleReport(owners, new Map([['story', { checks: [passed('trace-us2')] }]]));
    expect(nodeStatus(spec({ kind: 'rules', ids: ['decision-tradeoff'] }), half)).toBe('missing');
  });

  it('gives every floor line of a story phase to the task that owns its record', () => {
    const requirements = content.getProject('tasktrackr').phases.find((one) => one.key === 'requirements')!;
    const owners = ruleOwners(requirements, [soleTaskFor(requirements)]);
    expect([...owners.keys()]).toEqual(['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']);
    expect([...new Set(owners.values())]).toEqual(['']);
  });

  it('draws five green nodes for a story whose record and floor all pass, and a red record node for a record that is not valid', () => {
    const specs = buildNodeSpecs(content.getProject('tasktrackr')).filter((one) => one.phase === 'requirements');
    const ids = ['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min'];
    const passed = { checks: ids.map((id) => ({ id, label: '', status: 'passed', detail: '' })) } as unknown as FeedbackReport;
    expect(specs.map((one) => nodeStatus(one, passed))).toEqual(['green', 'green', 'green', 'green', 'green']);
    const broken = { checks: [{ id: 'story.record', label: '', status: 'failed', detail: '' }, ...passed.checks.slice(1)] } as unknown as FeedbackReport;
    expect(nodeStatus(specs[0], broken)).toBe('red');
  });

  /** TaskTrackr's Design phase as a design-kind phase: the record and the contracts, graded by the floor. */
  const designKind = (checks: Record<string, unknown>) => {
    const markdown = content.getProject('tasktrackr').phases.find((one) => one.key === 'design')!;
    return { ...markdown, checks: validateDesignChecks(checks, 'design') };
  };

  it('draws one node per design floor rule the switches leave on, the shape rules as contracts', () => {
    const design = designKind({ kind: 'design' });
    const project = { ...content.getProject('tasktrackr'), phases: [design] };
    expect(buildNodeSpecs(project).map((one) => one.id)).toEqual([
      'design:story:design.record',
      'design:contract:design.entities.min',
      'design:contract:design.relations.min',
      'design:contract:design.operations.min',
      'design:contract:design.operations.shape',
      'design:story:design.decisions.min',
      'design:story:design.decisions.shape',
      'design:story:design.trace',
      'design:contract:design.api.min',
      'design:contract:design.api.errors',
    ]);
    const on = { ...project, phases: [designKind({ kind: 'design', contracts: { api: false, screens: true }, sequence: true })] };
    expect(buildNodeSpecs(on).map((one) => one.id).slice(-3)).toEqual([
      'design:contract:design.screens.min',
      'design:contract:design.screens.shape',
      'design:story:design.sequence',
    ]);
  });

  it('gives every design floor rule to the task that owns the record, and draws a passed floor green', () => {
    const design = designKind({ kind: 'design' });
    const owners = ruleOwners(design, [soleTaskFor(design)]);
    expect([...owners.keys()]).toEqual([
      'design.record', 'design.entities.min', 'design.relations.min', 'design.operations.min', 'design.operations.shape',
      'design.decisions.min', 'design.decisions.shape', 'design.trace', 'design.api.min', 'design.api.errors',
    ]);
    expect([...new Set(owners.values())]).toEqual(['']);
    const specs = buildNodeSpecs({ ...content.getProject('tasktrackr'), phases: [design] });
    const passed = { checks: [...owners.keys()].map((id) => ({ id, label: '', status: 'passed', detail: '' })) } as unknown as FeedbackReport;
    expect(specs.every((one) => nodeStatus(one, passed) === 'green')).toBe(true);
    const broken = { checks: [{ id: 'design.record', label: '', status: 'failed', detail: '' }, ...passed.checks.slice(1)] } as unknown as FeedbackReport;
    expect(nodeStatus(specs[0], broken)).toBe('red');
  });
});

describe('the record nodes', () => {
  const project = new ContentService().loadProject(recordPack());
  const deployment = project.phases.find((p) => p.key === 'deployment')!;
  const maintenance = project.phases.find((p) => p.key === 'maintenance')!;

  it('draws one node per record, probing its floor rule ids', () => {
    const specs = buildNodeSpecs(project);
    expect(specs.find((s) => s.id === 'deployment:file:runbook')).toMatchObject({ label: 'Runbook', kind: 'file', phase: 'deployment', probe: { kind: 'rules', ids: [...RUNBOOK_FLOOR_IDS] } });
    expect(specs.find((s) => s.id === 'maintenance:file:change-request')).toMatchObject({ label: 'Change request', kind: 'file', phase: 'maintenance', probe: { kind: 'rules', ids: changeFloorIds(true) } });
  });
  it('gives the floor rules to the task that owns the record unit', () => {
    expect(ruleOwners(deployment, [soleTaskFor(deployment)]).get('runbook.named')).toBe('');
    expect(ruleOwners(maintenance, [soleTaskFor(maintenance)]).get('change.trace')).toBe('');
  });
});
