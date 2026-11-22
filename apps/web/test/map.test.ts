import { describe, expect, it } from 'vitest';
import {
  buildProjectMap,
  fileReference,
  stateLabel,
  type MapNode,
  type ProjectMapData,
} from '@/lib/map';
import { detail, file, phase, sample } from './fixtures';
import { API_CONTRACT_JSON, DESIGN_JSON, SCREEN_CONTRACT_JSON, serialiseDesign, validateDesignRecord, type PhaseDetail } from '@learnsdlc/shared';
import { EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook } from '@learnsdlc/shared';

/**
 * The project map. Sixteen hundred lines that parse a learner's half-finished
 * markdown, Python and reports into the one picture the project is about, run
 * here outside a browser.
 */

const ids = (nodes: MapNode[]): string[] => nodes.map((n) => n.id);
const byId = (data: ProjectMapData, id: string): MapNode =>
  data.nodes.find((n) => n.id === id) as MapNode;

describe('buildProjectMap', () => {
  it('has nothing to draw before there is an enrolment', () => {
    expect(buildProjectMap(null, {})).toEqual({ nodes: [], edges: [] });
    expect(buildProjectMap(undefined, {})).toEqual({ nodes: [], edges: [] });
  });

  it('reads the stories and their criteria out of the story phase', () => {
    const { enrollment, details } = sample();
    const data = buildProjectMap(enrollment, details);

    const story = byId(data, 'story:US-3');
    expect(story.label).toBe('Filter tasks');
    expect(story.kind).toBe('story');
    // Given by the project rather than written by the learner, and the map says so.
    expect(story.given).toBe(true);
    expect(story.sub).toContain('given');
    // A provided story lives in the phase's story spec, not in a file.
    expect(story.file).toBe('');

    expect(ids(data.nodes.filter((n) => n.kind === 'criterion'))).toEqual([
      'crit:US-3.1',
      'crit:US-3.2',
    ]);
    expect(byId(data, 'crit:US-3.2').label).toContain('matching tasks are listed');
  });

  it('traces story to criterion to contract to function to test to planted bug', () => {
    const { enrollment, details } = sample();
    const { edges } = buildProjectMap(enrollment, details);
    const trace = edges.filter((e) => e.kind === 'trace').map((e) => `${e.from} -> ${e.to}`);

    expect(trace).toContain('story:US-3 -> crit:US-3.1');
    expect(trace).toContain('crit:US-3.2 -> contract:filter_tasks');
    expect(trace).toContain('contract:filter_tasks -> fn:implementation:filter_tasks');
    expect(trace).toContain(
      'fn:implementation:filter_tasks -> test:test_manager:test_filter_keyword_is_case_insensitive',
    );
    // The test that catches a mutant is a different kind of line from the one
    // that traces to it, because they mean different things on the page.
    expect(edges).toContainEqual({
      from: 'test:test_manager:test_filter_keyword_is_case_insensitive',
      to: 'bug:filter_ignores_keyword',
      kind: 'kills',
    });
    // And the one the learner drew themselves.
    expect(edges).toContainEqual({
      from: 'test:test_manager:test_filter_keyword_is_case_insensitive',
      to: 'crit:US-3.2',
      kind: 'link',
    });
  });

  it('draws no line to a node that is not on the map', () => {
    const { enrollment, details } = sample();
    const data = buildProjectMap(enrollment, details);
    const known = new Set(ids(data.nodes));
    const dangling = data.edges.filter((e) => !known.has(e.from) || !known.has(e.to));
    expect(dangling).toEqual([]);
  });

  it('gives every node one id', () => {
    const { enrollment, details } = sample();
    const all = ids(buildProjectMap(enrollment, details).nodes);
    expect(new Set(all).size).toBe(all.length);
  });

  it('colours a node from the verdict that touches it', () => {
    const { enrollment, details } = sample();
    const data = buildProjectMap(enrollment, details);

    // The hidden case that failed names a frame in filter_tasks, so the
    // function it blames is failing and the one nothing blames is passing.
    expect(byId(data, 'fn:implementation:filter_tasks').state).toBe('fail');
    expect(byId(data, 'fn:implementation:complete_task').state).toBe('pass');
    expect(byId(data, 'test:test_manager:test_filter_keyword_is_case_insensitive').state).toBe('fail');
    expect(byId(data, 'test:test_manager:test_complete_marks_task_done').state).toBe('pass');
    // A mutant the suite caught is good news; one that survived is not.
    expect(byId(data, 'bug:filter_ignores_keyword').state).toBe('pass');
    expect(byId(data, 'bug:filter_ignores_keyword').sub).toBe('Caught by your tests');
    expect(byId(data, 'bug:priority_order_reversed').state).toBe('fail');
    expect(byId(data, 'bug:priority_order_reversed').sub).toBe('Survived your tests');
  });

  it('carries the proof each node was judged on into the drawer', () => {
    const { enrollment, details } = sample();
    const data = buildProjectMap(enrollment, details);

    const failing = byId(data, 'test:test_manager:test_filter_keyword_is_case_insensitive');
    const frames = failing.evidence?.find((e) => e.kind === 'frames');
    expect(frames).toBeTruthy();
    // The file references read the way they read everywhere else in the app.
    expect(frames?.rows.map((r) => r.label)).toContain('manager.py, line 16');

    const contract = byId(data, 'contract:filter_tasks');
    const claims = contract.evidence?.find((e) => e.kind === 'claims');
    expect(claims?.rows.some((r) => r.label.includes('Errors: none expected'))).toBe(true);
  });

  it('stands a locked phase in as one placeholder, and drops it when asked', () => {
    const { enrollment, details } = sample();
    const locked = byId(buildProjectMap(enrollment, details), 'ph:maintenance');
    expect(locked.kind).toBe('placeholder');
    expect(locked.sub).toBe('Opens in phase 6');

    const without = buildProjectMap(enrollment, details, { showLocked: false });
    expect(without.nodes.some((n) => n.kind === 'placeholder')).toBe(false);
  });

  it('folds criteria under their story and tests under their function in compact mode', () => {
    const { enrollment, details } = sample();
    const full = buildProjectMap(enrollment, details, { showLocked: false });
    const compact = buildProjectMap(enrollment, details, { showLocked: false, compact: true });

    expect(compact.nodes.length).toBeLessThan(full.nodes.length);
    const folded = compact.nodes.filter((n) => n.folded && n.folded.length > 0);
    expect(folded.length).toBeGreaterThan(0);
    // Nothing is lost: every folded node names the ids it stands in for.
    const stoodInFor = new Set(folded.flatMap((n) => n.folded ?? []));
    expect(stoodInFor.has('crit:US-3.1')).toBe(true);
    expect(stoodInFor.has('crit:US-3.2')).toBe(true);
  });

  it('orders the nodes by phase, so the map reads left to right', () => {
    const { enrollment, details } = sample();
    const order = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
    const seen = buildProjectMap(enrollment, details).nodes.map((n) => order.indexOf(n.phase));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('never throws on a workspace that is half written', () => {
    const { enrollment } = sample();
    const junk: Record<string, PhaseDetail> = {
      p1: detail(enrollment.phases[0], [
        file('requirements/draft.md', '### \n\n- \n\n#US-\nnot markdown at all', true, 'markdown'),
      ]),
      p3: detail(enrollment.phases[2], [file('tasktrackr/manager.py', 'def (:\n    ')]),
    };
    expect(() => buildProjectMap(enrollment, junk)).not.toThrow();
    expect(() => buildProjectMap(enrollment, {})).not.toThrow();
    // An enrolment whose phases are all still locked is an empty map, not a crash.
    const fresh = { ...enrollment, currentPhaseOrder: 1, phases: enrollment.phases.map((p) => ({ ...p, status: 'locked' as const })) };
    expect(() => buildProjectMap(fresh, {})).not.toThrow();
  });

  it('draws a Deployment with the runbook record as one record node with the floor\'s state, and no runbook.json file node', () => {
    const { enrollment, details } = sample();
    const checks = [
      { id: 'runbook.record', label: 'The runbook record', status: 'passed', detail: 'The record is well formed' },
      { id: 'runbook.health.min', label: 'At least 1 health check', status: 'failed', detail: 'Fewer than 1 health check' },
    ];
    const withRecord: Record<string, PhaseDetail> = {
      ...details,
      p5: {
        ...details.p5,
        files: [file('Dockerfile', 'FROM python:3.11\n', true, 'docker'), file(RUNBOOK_JSON, serialiseRunbook(EMPTY_RUNBOOK), true, 'json')],
        runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: false }, drill: true },
        drill: null,
        lastSubmission: { id: 's5', status: 'completed', passed: false, score: 40, report: { checks }, createdAt: '2026-09-03T10:00:00.000Z' },
      } as unknown as PhaseDetail,
    };
    const data = buildProjectMap(enrollment, withRecord);
    const node = byId(data, 'record:deployment:runbook');
    expect(node).toMatchObject({ label: 'Runbook', state: 'fail', sub: '1 of 2 checks passed', phase: 'deployment' });
    expect(node.href).toBe('/workspace/p5?panel=runbook');
    expect(data.nodes.filter((n) => n.phase === 'deployment').map((n) => n.label)).not.toContain('runbook.json');
    expect(ids(data.nodes)).toContain('file:deployment:Dockerfile');
  });

  it('names the change node by the ticket and links a function an acceptance line names', () => {
    const { enrollment, details } = sample();
    const maintenance = enrollment.phases.find((p) => p.key === 'maintenance')!;
    const CHG = { id: 'CHG-1', title: 'Shelve by surname', summary: 'The library has asked for surname order.', acceptance: [{ id: 'AC-1', line: 'shelf_order sorts the books by surname.' }] };
    details[maintenance.id] = detail({ ...maintenance, status: 'in_progress' }, [file('api/shelf.py', 'def shelf_order(books):\n    return sorted(books)\n')], {
      taskPanel: 'Shelve the books by surname.', change: { ticket: CHG, contract: false, floor: { minImpact: 1, minContract: 0, minTests: 1, requireRelease: true, traceEveryAcceptance: true } },
    });
    const data = buildProjectMap(enrollment, details);
    expect(byId(data, 'change:CHG-1')).toMatchObject({ label: 'Shelve by surname', kind: 'change' });
    expect(data.edges.some((e) => e.from === 'change:CHG-1' && e.to === 'fn:maintenance:shelf_order')).toBe(true);
  });
});

describe('the words on a node', () => {
  it('says what a state means, in terms of the kind it is on', () => {
    expect(stateLabel('pass', 'test')).toBe('Passing');
    expect(stateLabel('pass', 'story')).toBe('Done');
    expect(stateLabel('fail', 'function')).toBe('Failing');
    expect(stateLabel('warn', 'decision')).toBe('Needs a decision');
    expect(stateLabel('now', 'file')).toBe('In progress');
    expect(stateLabel('todo', 'change')).toBe('Not started');
  });

  it('writes a file reference the way the rest of the product does', () => {
    expect(fileReference('tasktrackr/manager.py', 56)).toBe('manager.py, line 56');
    expect(fileReference('tasktrackr/manager.py')).toBe('manager.py');
    expect(fileReference(undefined, 12)).toBe('');
  });
});

describe('the design phase on the map', () => {
  const api = JSON.stringify({ operations: [{ id: 'getOverdue', method: 'GET', path: '/api/tasks/overdue', summary: 'tasks past their due date', satisfies: 'US-3', success: { status: 200 } }], errors: {} }, null, 2);
  const screens = JSON.stringify({ screens: [{ route: '#/overdue', component: 'OverduePage', satisfies: ['US-3'], empty: 'Nothing is overdue. You are all caught up.' }] }, null, 2);
  const withContracts = (on: { api: boolean; screens: boolean }, files = [file(API_CONTRACT_JSON, api, true, 'json'), file(SCREEN_CONTRACT_JSON, screens, true, 'json')]) => {
    const { enrollment, details } = sample();
    const p2 = details.p2;
    return buildProjectMap(enrollment, { ...details, p2: { ...p2, files: [...p2.files, ...files], design: { ...p2.design!, contracts: on } } });
  };

  it('reads the record: an operation is a contract at its line of the record, and a decision is a decision', () => {
    const data = buildProjectMap(sample().enrollment, sample().details);
    const contract = byId(data, 'contract:filter_tasks');
    expect(contract.label).toBe('filter_tasks(status, keyword)');
    expect(contract.sub).toBe('Contract for US-3');
    expect(contract.file).toBe(DESIGN_JSON);
    expect(contract.line).toBeGreaterThan(1);
    // and a decision in the record is a decision node at its own line
    const { enrollment, details } = sample();
    const record = validateDesignRecord(details.p2.files.find((f) => f.path === DESIGN_JSON)!.content).design!;
    const withDecision = serialiseDesign({ ...record, decisions: [{ id: 'D1', title: 'Clock', choice: 'a parameter', alternative: 'the server clock', rationale: 'replayable', tradeOff: 'callers send it', status: 'accepted', satisfies: ['US-3'] }] });
    const decided = buildProjectMap(enrollment, { ...details, p2: { ...details.p2, files: details.p2.files.map((f) => (f.path === DESIGN_JSON ? { ...f, content: withDecision } : f)) } });
    const decision = byId(decided, 'decision:D1');
    expect(decision.kind).toBe('decision');
    expect(decision.sub).toBe('Decision D1');
    expect(decision.file).toBe(DESIGN_JSON);
  });

  it('reads the contracts the switches leave on, and never one that is off', () => {
    const on = withContracts({ api: true, screens: true });
    expect(byId(on, 'contract:getOverdue')).toMatchObject({ label: 'getOverdue: GET /api/tasks/overdue', sub: 'Contract for US-3', file: API_CONTRACT_JSON });
    expect(byId(on, 'contract:screen #/overdue')).toMatchObject({ label: '#/overdue OverduePage', name: 'OverduePage', file: SCREEN_CONTRACT_JSON });
    const off = withContracts({ api: false, screens: false });
    expect(off.nodes.some((n) => n.file === API_CONTRACT_JSON || n.file === SCREEN_CONTRACT_JSON)).toBe(false);
  });

  it('reads no markdown: a design phase in the older format, or a markdown file beside the record, adds nothing', () => {
    const { enrollment, details } = sample();
    const markdown = file('design/my-design.md', '## Contracts\n\n### list_overdue(today) -> list[Task]\n\n- Inputs: today\n', true, 'markdown');
    const beside = buildProjectMap(enrollment, { ...details, p2: { ...details.p2, files: [...details.p2.files, markdown] } });
    expect(beside.nodes.some((n) => n.id === 'contract:list_overdue')).toBe(false);
    const older = buildProjectMap(enrollment, { ...details, p2: { ...details.p2, design: undefined, files: [markdown] } });
    expect(older.nodes.some((n) => n.phase === 'design' && n.kind === 'contract')).toBe(false);
  });
});
