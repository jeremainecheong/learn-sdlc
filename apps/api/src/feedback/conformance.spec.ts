import type {
  AnalyzerFunction,
  AnalyzerReport,
  ContractClaim,
  FeedbackReport,
  TestCaseResult,
} from '@learnsdlc/shared';
import { buildContractLedger } from './conformance';

/* -------------------------------- fixtures ------------------------------- */

const scaffoldDesign = `# TaskTrackr — Design (your sections)

## 2 — API contract *(complete this)*

<!-- For each operation: inputs, outputs, error behaviour, and the story it
     satisfies. Errors: raises KeyError — this comment must never count. -->

### \`complete_task(task_id)\` — US-?

- Inputs:
- Returns:
- Errors:

### \`filter_tasks(status="all", keyword=None)\` — US-?

- Inputs:
- Returns (including ordering):
- Errors:

### \`overdue_tasks(today)\` — US-?

- Inputs:
- Returns (state the boundary rule):
- Errors:

## 3 — Decision log

| # | Decision | Trade-off weighed |
|---|----------|-------------------|
| D1 | JSON file | because it is inspectable |
`;

const goodDesign = `## 2 — API contract

### \`complete_task(task_id)\` — US-2

- Inputs: the integer id of the task to close, as assigned by the manager.
- Returns: the updated Task with completed set to True.
- Errors: raises KeyError when no task carries that id.

### \`filter_tasks(status="all", keyword=None)\` — US-3

- Inputs: status is one of all, open or done; keyword is an optional substring
  matched case-insensitively against the title.
- Returns (including ordering): the matching tasks, ordered by priority then id.
- Errors: raises ValueError for a status outside the three names.

### \`overdue_tasks(today)\` — US-4

- Inputs: today as a date, supplied by the caller so tests can pin it.
- Returns (state the boundary rule): the open tasks whose due date is strictly before today.
- Errors: none; tasks with no due date are simply excluded.
`;

const hidden = (name: string, status: TestCaseResult['status'] = 'passed'): TestCaseResult => ({
  name,
  status,
  hidden: true,
});

const hiddenSuite: TestCaseResult[] = [
  hidden('HiddenCompleteTests.test_complete_returns_the_task'),
  hidden('HiddenCompleteTests.test_complete_unknown_id_raises_keyerror'),
  hidden('HiddenCompleteTests.test_complete_is_idempotent'),
  hidden('HiddenFilterTests.test_filter_done_returns_only_completed'),
  hidden('HiddenFilterTests.test_filter_keyword_is_case_insensitive'),
  hidden('HiddenFilterTests.test_filter_invalid_status_raises_valueerror'),
  hidden('HiddenFilterTests.test_filter_orders_by_priority_then_id'),
  hidden('HiddenFilterTests.test_filter_combines_status_and_keyword'),
  hidden('HiddenOverdueTests.test_overdue_excludes_completed_and_no_due_date'),
  hidden('HiddenOverdueTests.test_task_due_today_is_not_overdue'),
];

const jsSuite: TestCaseResult[] = [
  hidden('complete returns the task and marks stored state'),
  hidden('complete unknown id throws'),
  hidden('filter orders by priority then id'),
  hidden('filter invalid status throws'),
  hidden('task due today is not overdue'),
];

const reportWith = (cases: TestCaseResult[], checks: FeedbackReport['checks'] = []): FeedbackReport =>
  ({
    overall: 0,
    passed: false,
    passThreshold: 70,
    criteria: [],
    checks,
    tests: {
      total: cases.length,
      passed: cases.filter((c) => c.status === 'passed').length,
      failed: cases.filter((c) => c.status === 'failed').length,
      errored: cases.filter((c) => c.status === 'errored').length,
      cases,
    },
    aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'none' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: {
      relianceFlag: false,
      relianceIndex: 0,
      mentorPasteFlag: false,
      noEffortFlag: false,
      note: '',
    },
  }) as FeedbackReport;

const analyzerWith = (functions: Partial<AnalyzerFunction>[]): AnalyzerReport => ({
  issues: [],
  metrics: {
    files: 1,
    functions: functions.length,
    todosRemaining: 0,
    maxComplexity: 3,
    docstringCoverage: 1,
  },
  functions: functions.map((fn) => ({
    name: 'f',
    path: 'tasktrackr/manager.py',
    line: 10,
    endLine: 20,
    complexity: 2,
    calls: [],
    bodyHash: 'h',
    ...fn,
  })) as AnalyzerFunction[],
});

const find = (ledger: ContractClaim[], name: string, claim: ContractClaim['claim']) =>
  ledger.find((row) => row.name === name && row.claim === claim);

const verdictsFor = (ledger: ContractClaim[], name: string) =>
  ledger.filter((row) => row.name === name).map((row) => [row.claim, row.verdict]);

/* --------------------------------- tests --------------------------------- */

describe('buildContractLedger', () => {
  // The design phase grades shared/contract/api.json, and that file names its
  // operations with `id` and states them with `summary`, `success` and
  // `failures`. A parser that looked only for `name` and flat
  // `inputs`/`returns`/`errors` strings would skip every row, and a learner
  // who wrote the whole contract would be told by their own pull request that
  // all three operations were unclaimed.
  it('reads the HTTP contract shape of shared/contract/api.json', () => {
    const api = JSON.stringify({
      version: '2.0.0',
      operations: [
        {
          id: 'completeTask',
          method: 'PATCH',
          path: '/api/tasks/{id}',
          summary: 'Close a task. Completing twice changes nothing.',
          satisfies: ['US-2'],
          parameters: [{ name: 'id', type: 'integer', description: 'the task to close' }],
          success: { status: 200, body: 'Task' },
          failures: [{ status: 404, code: 'task_not_found', when: 'no task carries that id' }],
        },
      ],
    });
    const ledger = buildContractLedger(
      { 'shared/contract/api.json': api },
      reportWith(hiddenSuite),
      undefined,
    );

    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((row) => row.name === 'completeTask')).toBe(true);
    expect(ledger.some((row) => row.verdict === 'unclaimed')).toBe(false);

    const inputs = find(ledger, 'completeTask', 'inputs');
    expect(inputs?.text).toContain('id');
    const returns = find(ledger, 'completeTask', 'returns');
    expect(returns?.text).toContain('Task');
    const errors = find(ledger, 'completeTask', 'errors');
    expect(errors?.text).toContain('task_not_found');
    expect(inputs?.story).toBe('US-2');
  });

  it('reads a design record whose inputs and errors are lists as the joined text', () => {
    const design = JSON.stringify({ operations: [{ id: 'O1', name: 'completeTask(id)', inputs: ['id', 'listId'], returns: 'Task', errors: ['task_not_found'], satisfies: ['US-2'] }] });
    const ledger = buildContractLedger({ 'design/design.json': design }, reportWith(hiddenSuite), undefined);
    expect(find(ledger, 'completeTask', 'inputs')?.text).toContain('id, listId');
    expect(find(ledger, 'completeTask', 'errors')?.text).toContain('task_not_found');
  });

  it('reads the same design record written as text the same way', () => {
    const design = JSON.stringify({ operations: [{ id: 'O1', name: 'completeTask(id)', inputs: 'id, listId', returns: 'Task', errors: 'task_not_found', satisfies: ['US-2'] }] });
    const ledger = buildContractLedger({ 'design/design.json': design }, reportWith(hiddenSuite), undefined);
    expect(find(ledger, 'completeTask', 'inputs')?.text).toContain('id, listId');
    expect(find(ledger, 'completeTask', 'errors')?.text).toContain('task_not_found');
  });

  it('reads Maintenance\'s list-shaped design/contracts.json, so an amended errors list wins over the record', () => {
    const design = JSON.stringify({ operations: [{ id: 'O1', name: 'completeTask(id)', inputs: 'id', returns: 'Task', errors: 'task_not_found', satisfies: ['US-2'] }] });
    const contracts = JSON.stringify({ operations: [{ id: 'O1', name: 'completeTask(id)', inputs: ['id'], returns: 'Task', errors: ['task_not_found', 'task_locked'], satisfies: ['US-2'] }] });
    const ledger = buildContractLedger({ 'design/design.json': design, 'design/contracts.json': contracts }, reportWith(hiddenSuite), undefined);
    const errors = find(ledger, 'completeTask', 'errors');
    expect(errors?.text).toContain('task_not_found, task_locked');
    expect(errors?.evidence).toContain('From design/contracts.json.');
  });

  it('keeps reading the HTTP contract\'s errors through its failures, never its list of codes', () => {
    const api = JSON.stringify({ operations: [{ id: 'getTask', method: 'GET', path: '/api/tasks/{id}', success: { status: 200, body: 'Task' }, errors: ['task_not_found'] }] });
    const ledger = buildContractLedger({ 'shared/contract/api.json': api }, reportWith(hiddenSuite), undefined);
    expect(find(ledger, 'getTask', 'errors')?.text ?? '').not.toContain('task_not_found');
  });

  it('lets the HTTP contract answer an operation design.json left blank', () => {
    const design = JSON.stringify({
      operations: [
        { name: 'completeTask(id)', satisfies: '', inputs: '', returns: '', errors: '' },
      ],
    });
    const api = JSON.stringify({
      operations: [
        {
          id: 'completeTask',
          method: 'PATCH',
          path: '/api/tasks/{id}',
          summary: 'Close a task.',
          satisfies: ['US-2'],
          parameters: [{ name: 'id', type: 'integer' }],
          success: { status: 200, body: 'Task' },
          failures: [{ status: 404, code: 'task_not_found', when: 'no task carries that id' }],
        },
      ],
    });
    const ledger = buildContractLedger(
      { 'design/design.json': design, 'shared/contract/api.json': api },
      reportWith(hiddenSuite),
      undefined,
    );
    expect(find(ledger, 'completeTask', 'returns')?.text).toContain('Task');
    expect(ledger.some((row) => row.verdict === 'unclaimed')).toBe(false);
  });

  it('returns an empty ledger when there is no design to read', () => {
    const report = reportWith(hiddenSuite);
    expect(buildContractLedger({}, report, undefined)).toEqual([]);
    expect(buildContractLedger({ 'design/my-design.md': '' }, report, undefined)).toEqual([]);
    expect(
      buildContractLedger({ 'design/my-design.md': '# Design\n\nNo contracts yet.\n' }, report, undefined),
    ).toEqual([]);
    expect(
      buildContractLedger(undefined as unknown as Record<string, string>, report, undefined),
    ).toEqual([]);
  });

  it('reads one row per contract line, in operation then line order', () => {
    const ledger = buildContractLedger(
      { 'design/my-design.md': goodDesign },
      reportWith(hiddenSuite),
      undefined,
    );
    expect(ledger.map((row) => `${row.name}.${row.claim}`)).toEqual([
      'complete_task.inputs',
      'complete_task.returns',
      'complete_task.errors',
      'filter_tasks.inputs',
      'filter_tasks.returns',
      'filter_tasks.errors',
      'filter_tasks.ordering',
      'overdue_tasks.inputs',
      'overdue_tasks.returns',
      'overdue_tasks.errors',
      'overdue_tasks.boundary',
    ]);
  });

  it('carries the story id and the claim text through', () => {
    const ledger = buildContractLedger(
      { 'design/my-design.md': goodDesign },
      reportWith(hiddenSuite),
      undefined,
    );
    expect(find(ledger, 'complete_task', 'errors')).toMatchObject({
      story: 'US-2',
      text: 'raises KeyError when no task carries that id.',
    });
    expect(find(ledger, 'filter_tasks', 'ordering')?.story).toBe('US-3');
    expect(find(ledger, 'overdue_tasks', 'boundary')?.story).toBe('US-4');
  });

  it('folds a wrapped claim line into one text', () => {
    const inputs = find(
      buildContractLedger({ 'design/my-design.md': goodDesign }, reportWith(hiddenSuite), undefined),
      'filter_tasks',
      'inputs',
    );
    expect(inputs?.text).toBe(
      'status is one of all, open or done; keyword is an optional substring matched case-insensitively against the title.',
    );
  });

  it('keeps every claim of a green submission, with the hidden test as evidence', () => {
    const ledger = buildContractLedger(
      { 'design/my-design.md': goodDesign },
      reportWith(hiddenSuite),
      undefined,
    );
    expect(verdictsFor(ledger, 'complete_task')).toEqual([
      ['inputs', 'kept'],
      ['returns', 'kept'],
      ['errors', 'kept'],
    ]);
    expect(verdictsFor(ledger, 'filter_tasks')).toEqual([
      ['inputs', 'kept'],
      ['returns', 'kept'],
      ['errors', 'kept'],
      ['ordering', 'kept'],
    ]);
    expect(find(ledger, 'complete_task', 'errors')?.evidence[0]).toBe(
      'hidden test HiddenCompleteTests.test_complete_unknown_id_raises_keyerror passed.',
    );
    expect(find(ledger, 'filter_tasks', 'ordering')?.evidence).toEqual([
      'hidden test HiddenFilterTests.test_filter_orders_by_priority_then_id passed.',
      'Read from the Returns line, which is where the design states it.',
    ]);
  });

  it('breaks a claim when a bearing hidden test fails, and says which', () => {
    const failing = hiddenSuite.map((c) =>
      c.name.endsWith('raises_keyerror') ? { ...c, status: 'failed' as const } : c,
    );
    const ledger = buildContractLedger(
      { 'design/my-design.md': goodDesign },
      reportWith(failing),
      undefined,
    );
    const errors = find(ledger, 'complete_task', 'errors');
    expect(errors?.verdict).toBe('broken');
    expect(errors?.evidence[0]).toBe(
      'hidden test HiddenCompleteTests.test_complete_unknown_id_raises_keyerror failed.',
    );
    // The other claims for the same operation are untouched.
    expect(find(ledger, 'complete_task', 'returns')?.verdict).toBe('kept');
  });

  it('counts an errored case as broken and reports how many more', () => {
    const broken = hiddenSuite.map((c) =>
      c.name.includes('.test_filter_') ? { ...c, status: 'errored' as const } : c,
    );
    const inputs = find(
      buildContractLedger({ 'design/my-design.md': goodDesign }, reportWith(broken), undefined),
      'filter_tasks',
      'inputs',
    );
    expect(inputs?.verdict).toBe('broken');
    expect(inputs?.evidence[0]).toBe(
      'hidden test HiddenFilterTests.test_filter_done_returns_only_completed errored, and 4 more.',
    );
  });

  describe('the scaffold, left as it shipped', () => {
    it('marks every line unclaimed and never reads the instructions in comments', () => {
      const ledger = buildContractLedger(
        { 'design/my-design.md': scaffoldDesign },
        reportWith(hiddenSuite),
        undefined,
      );
      expect(ledger).toHaveLength(11);
      expect(ledger.every((row) => row.verdict === 'unclaimed')).toBe(true);
      expect(ledger.every((row) => row.text === '')).toBe(true);
      expect(ledger.every((row) => row.story === undefined)).toBe(true);
      expect(find(ledger, 'complete_task', 'errors')?.evidence[0]).toBe(
        'The errors line is present but empty, so there is no contract to check.',
      );
      expect(find(ledger, 'complete_task', 'errors')?.evidence[1]).toBe(
        'hidden test HiddenCompleteTests.test_complete_unknown_id_raises_keyerror checks this anyway.',
      );
    });

    it('says the line is absent when the design never wrote one', () => {
      const design = '### `complete_task(task_id)` — US-2\n\n- Inputs: the id of the task.\n';
      const ledger = buildContractLedger(
        { 'design/my-design.md': design },
        reportWith(hiddenSuite),
        undefined,
      );
      expect(find(ledger, 'complete_task', 'errors')?.evidence[0]).toBe(
        'The design states no errors for complete_task.',
      );
    });
  });

  describe('contradictions', () => {
    const withLine = (from: string, to: string) => goodDesign.replace(from, to);

    it('catches "Errors: none" against a hidden test that expects a raise', () => {
      const design = withLine(
        '- Errors: raises KeyError when no task carries that id.',
        '- Errors: none.',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
        'complete_task',
        'errors',
      );
      expect(row?.verdict).toBe('contradicted');
      expect(row?.evidence[0]).toBe(
        'hidden test HiddenCompleteTests.test_complete_unknown_id_raises_keyerror expects an error from complete_task, but the design says there is none.',
      );
    });

    it('leaves "Errors: none" alone when nothing expects an error', () => {
      // overdue_tasks genuinely raises nothing, and the pack's own wording says so.
      const row = find(
        buildContractLedger(
          { 'design/my-design.md': goodDesign },
          reportWith(hiddenSuite),
          analyzerWith([{ name: 'overdue_tasks', line: 86 }]),
        ),
        'overdue_tasks',
        'errors',
      );
      expect(row?.verdict).toBe('unclaimed');
      expect(row?.evidence[0]).toBe(
        'Nothing in this run bears on the errors of overdue_tasks, so it stands unverified.',
      );
    });

    it('catches "Errors: none" against a raise the analyzer saw', () => {
      const design = withLine(
        '- Errors: raises KeyError when no task carries that id.',
        '- Errors: none.',
      );
      const analysis = analyzerWith([
        { name: 'complete_task', line: 63, calls: ['get_task', 'KeyError'] },
      ]);
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith([]), analysis),
        'complete_task',
        'errors',
      );
      expect(row?.verdict).toBe('contradicted');
      expect(row?.evidence[0]).toBe(
        'tasktrackr/manager.py:63 raises KeyError, but the design says complete_task raises nothing.',
      );
    });

    it('catches "Inputs: none" against the signature in the same block', () => {
      const design = withLine(
        '- Inputs: status is one of all, open or done; keyword is an optional substring',
        '- Inputs: none',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
        'filter_tasks',
        'inputs',
      );
      expect(row?.verdict).toBe('contradicted');
      expect(row?.evidence[0]).toBe(
        'The design says filter_tasks takes no arguments, but the same block declares filter_tasks(status="all", keyword=None).',
      );
    });

    it('does not read a default of None in an inputs line as "no inputs"', () => {
      const design = withLine(
        '- Inputs: status is one of all, open or done; keyword is an optional substring',
        '- Inputs: status defaults to "all" and keyword defaults to None, so both are optional',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
        'filter_tasks',
        'inputs',
      );
      expect(row?.verdict).toBe('kept');
    });

    it('catches a returns line that promises nothing back', () => {
      const design = withLine(
        '- Returns: the updated Task with completed set to True.',
        '- Returns: None',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
        'complete_task',
        'returns',
      );
      expect(row?.verdict).toBe('contradicted');
      expect(row?.evidence[0]).toContain('expects a value back');
    });

    it('does not read "or None if unknown" as returning nothing', () => {
      const design = withLine(
        '- Returns: the updated Task with completed set to True.',
        '- Returns: the updated Task, and never None, because an unknown id raises instead.',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
        'complete_task',
        'returns',
      );
      expect(row?.verdict).toBe('kept');
    });

    it('catches a boundary rule that makes a task due today overdue', () => {
      for (const wrong of [
        '- Returns (state the boundary rule): every open task with due_date <= today.',
        '- Returns (state the boundary rule): a task due today is overdue, as are older ones.',
        '- Returns (state the boundary rule): tasks due on or before today.',
      ]) {
        const design = withLine(
          '- Returns (state the boundary rule): the open tasks whose due date is strictly before today.',
          wrong,
        );
        const row = find(
          buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
          'overdue_tasks',
          'boundary',
        );
        expect([wrong, row?.verdict]).toEqual([wrong, 'contradicted']);
        expect(row?.evidence[0]).toBe(
          'hidden test HiddenOverdueTests.test_task_due_today_is_not_overdue expects a task due today to be open, but the design puts it in the overdue set.',
        );
      }
    });

    it('leaves a correct boundary rule alone, however it is worded', () => {
      for (const right of [
        '- Returns (state the boundary rule): the open tasks whose due date is strictly before today.',
        '- Returns (state the boundary rule): tasks due before today are overdue; a task due today is still open.',
        '- Returns (state the boundary rule): overdue means the due date has passed, so not today.',
      ]) {
        const design = withLine(
          '- Returns (state the boundary rule): the open tasks whose due date is strictly before today.',
          right,
        );
        const row = find(
          buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
          'overdue_tasks',
          'boundary',
        );
        expect([right, row?.verdict]).toEqual([right, 'kept']);
      }
    });

    it('catches an ordering claim that runs the wrong way, or claims no order', () => {
      for (const wrong of [
        '- Returns (including ordering): the matching tasks, lowest priority first.',
        '- Returns (including ordering): the matching tasks in ascending priority.',
        '- Returns (including ordering): the matching tasks in any order.',
        '- Returns (including ordering): the matching tasks in insertion order.',
      ]) {
        const design = withLine(
          '- Returns (including ordering): the matching tasks, ordered by priority then id.',
          wrong,
        );
        const row = find(
          buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
          'filter_tasks',
          'ordering',
        );
        expect([wrong, row?.verdict]).toEqual([wrong, 'contradicted']);
      }
    });

    it('leaves an ordering claim alone when it matches the suite', () => {
      const design = withLine(
        '- Returns (including ordering): the matching tasks, ordered by priority then id.',
        '- Returns (including ordering): highest priority first, then by id, so low priority is last.',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), undefined),
        'filter_tasks',
        'ordering',
      );
      expect(row?.verdict).toBe('kept');
    });

    it('never contradicts a claim when no test and no analyzer fact bears on it', () => {
      const design = `### \`complete_task(task_id)\` — US-2

- Inputs: none
- Returns: None
- Errors: none
`;
      const ledger = buildContractLedger(
        { 'design/my-design.md': design },
        reportWith([]),
        undefined,
      );
      // Only the inputs line contradicts, because the signature is a fact the
      // design itself declares; the rest have nothing to check them against.
      expect(verdictsFor(ledger, 'complete_task')).toEqual([
        ['inputs', 'contradicted'],
        ['returns', 'unclaimed'],
        ['errors', 'unclaimed'],
      ]);
    });
  });

  describe('javascript projects', () => {
    const jsDesign = `## 2 — API contract

### \`completeTask(id)\` — US-2

- Inputs: the numeric id of the task to close.
- Returns: the stored Task with completed set to true.
- Errors: throws an Error when no task carries that id.

### \`filterTasks(status, keyword)\` — US-3

- Inputs: status is one of all, open or done; keyword is optional.
- Returns (including ordering): the matches, ordered by priority then id.
- Errors: throws an Error for an unknown status.

### \`overdueTasks(today)\` — US-4

- Inputs: today as a Date.
- Returns (state the boundary rule): open tasks whose dueDate is before today.
- Errors: none; tasks without a due date are excluded.
`;

    it('matches camelCase operations to the bare test strings', () => {
      const ledger = buildContractLedger(
        { 'design/my-design.md': jsDesign },
        reportWith(jsSuite),
        undefined,
      );
      expect(find(ledger, 'completeTask', 'errors')?.verdict).toBe('kept');
      expect(find(ledger, 'completeTask', 'errors')?.evidence[0]).toBe(
        'hidden test complete unknown id throws passed.',
      );
      expect(find(ledger, 'filterTasks', 'ordering')?.verdict).toBe('kept');
      expect(find(ledger, 'overdueTasks', 'boundary')?.verdict).toBe('kept');
    });

    it('catches the same contradictions through camelCase names', () => {
      const design = jsDesign.replace(
        '- Returns (state the boundary rule): open tasks whose dueDate is before today.',
        '- Returns (state the boundary rule): open tasks with dueDate <= today.',
      );
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(jsSuite), undefined),
        'overdueTasks',
        'boundary',
      );
      expect(row?.verdict).toBe('contradicted');
    });
  });

  describe('structured sources', () => {
    const designJson = JSON.stringify({
      operations: [
        {
          name: 'complete_task(task_id)',
          satisfies: 'US-2',
          inputs: 'the integer id of the task to close.',
          returns: 'the updated Task.',
          errors: 'raises KeyError for an unknown id.',
        },
      ],
    });

    it('reads operations from design.json when there is no markdown', () => {
      const ledger = buildContractLedger(
        { 'design/design.json': designJson },
        reportWith(hiddenSuite),
        undefined,
      );
      expect(verdictsFor(ledger, 'complete_task')).toEqual([
        ['inputs', 'kept'],
        ['returns', 'kept'],
        ['errors', 'kept'],
      ]);
      expect(find(ledger, 'complete_task', 'errors')?.story).toBe('US-2');
      expect(find(ledger, 'complete_task', 'errors')?.evidence).toContain(
        'From design/design.json.',
      );
    });

    it('lets the rendered markdown win, and fills only the lines it never rendered', () => {
      const markdown = `### \`complete_task(task_id)\` — US-2

- Inputs: the id, as an int.
- Returns:
`;
      const ledger = buildContractLedger(
        { 'design/my-design.md': markdown, 'design/design.json': designJson },
        reportWith(hiddenSuite),
        undefined,
      );
      expect(find(ledger, 'complete_task', 'inputs')?.text).toBe('the id, as an int.');
      // The blank markdown line and the missing one both fall back to the record.
      expect(find(ledger, 'complete_task', 'returns')?.text).toBe('the updated Task.');
      expect(find(ledger, 'complete_task', 'errors')?.text).toBe('raises KeyError for an unknown id.');
    });

    it('accepts a bare array of contracts, as contracts.json holds them', () => {
      const contracts = JSON.stringify([
        { name: 'reopen_task', story: 'US-5', errors: 'raises KeyError for an unknown id.' },
      ]);
      const ledger = buildContractLedger(
        { 'maintenance/contracts.json': contracts },
        reportWith([hidden('ReopenChange.test_reopen_unknown_id_raises')]),
        undefined,
      );
      expect(find(ledger, 'reopen_task', 'errors')?.verdict).toBe('kept');
      expect(find(ledger, 'reopen_task', 'errors')?.story).toBe('US-5');
    });

    it('ignores json that does not parse or does not hold operations', () => {
      expect(
        buildContractLedger({ 'design/design.json': '{oops' }, reportWith([]), undefined),
      ).toEqual([]);
      expect(
        buildContractLedger({ 'design/design.json': '{"fields": []}' }, reportWith([]), undefined),
      ).toEqual([]);
    });
  });

  describe('analyzer facts', () => {
    const design = '### `get_task(task_id)` — US-1\n\n- Errors: raises KeyError for an unknown id.\n';

    it('keeps an errors claim the analyzer can confirm when no test bears on it', () => {
      const analysis = analyzerWith([{ name: 'get_task', line: 40, calls: ['KeyError'] }]);
      const row = find(
        buildContractLedger({ 'design/my-design.md': design }, reportWith(hiddenSuite), analysis),
        'get_task',
        'errors',
      );
      expect(row?.verdict).toBe('kept');
      expect(row?.evidence[0]).toBe('tasktrackr/manager.py:40 raises KeyError.');
    });

    it('says the function is missing when neither a test nor the analyzer finds it', () => {
      const row = find(
        buildContractLedger(
          { 'design/my-design.md': design },
          reportWith(hiddenSuite),
          analyzerWith([{ name: 'add_task' }]),
        ),
        'get_task',
        'errors',
      );
      expect(row?.verdict).toBe('unclaimed');
      expect(row?.evidence[0]).toBe(
        'No function named get_task was found in your files, and no test bears on this line.',
      );
    });
  });

  describe('failed content checks', () => {
    it('adds the operation rule that failed as evidence', () => {
      const checks: FeedbackReport['checks'] = [
        {
          id: 'api-complete',
          label: 'complete_task has a contract',
          status: 'failed',
          detail: 'an empty "Returns:" label is not a contract.',
        },
        {
          id: 'model-id-title',
          label: 'id before title',
          status: 'failed',
          detail: 'id must come first.',
        },
      ];
      const ledger = buildContractLedger(
        { 'design/my-design.md': goodDesign },
        reportWith(hiddenSuite, checks),
        undefined,
      );
      expect(find(ledger, 'complete_task', 'returns')?.evidence).toContain(
        'Check api-complete failed: an empty "Returns:" label is not a contract.',
      );
      expect(
        find(ledger, 'filter_tasks', 'returns')?.evidence.some((line) => line.includes('api-complete')),
      ).toBe(false);
      expect(
        ledger.some((row) => row.evidence.some((line) => line.includes('model-id-title'))),
      ).toBe(false);
    });

    it('puts the document-wide errors rule on the errors rows only', () => {
      const checks: FeedbackReport['checks'] = [
        {
          id: 'api-errors',
          label: 'error behaviour is stated',
          status: 'failed',
          detail: 'name the exception, or say there is none and why.',
        },
      ];
      const ledger = buildContractLedger(
        { 'design/my-design.md': goodDesign },
        reportWith(hiddenSuite, checks),
        undefined,
      );
      const carrying = ledger.filter((row) =>
        row.evidence.some((line) => line.includes('api-errors')),
      );
      expect(carrying.every((row) => row.claim === 'errors')).toBe(true);
      expect(carrying).toHaveLength(3);
    });
  });

  it('caps the ledger', () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `### \`op_${i}(arg)\` — US-1\n\n- Inputs: an arg.\n- Returns: a value.\n- Errors: none.\n`,
    ).join('\n');
    expect(
      buildContractLedger({ 'design/my-design.md': many }, reportWith([]), undefined),
    ).toHaveLength(60);
  });

  it('is pure: the same input yields the same ledger', () => {
    const sources = { 'design/my-design.md': goodDesign };
    const report = reportWith(hiddenSuite);
    expect(buildContractLedger(sources, report, undefined)).toEqual(
      buildContractLedger(sources, report, undefined),
    );
  });
});
