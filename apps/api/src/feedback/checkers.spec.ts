import type { AnalyzerReport, PhaseRubric, PhaseStatus } from '@learnsdlc/shared';
// Teacher-authored projects: the roll-up takes the pinned version's
// compiled tasks, so the spec builds them as the compiler does.
import type { CompiledTask } from '../content/pack-compiler';
// The editor and the grader must agree on one number, so the spec
// imports both ends of it.
import { ANALYZER_UNAVAILABLE_RULE, codeQualityScore } from '@learnsdlc/shared';
// The hint rule the learner is shown, imported from the one
// place it is written, so the spec proves the score and the sentence agree.
import { HINT_FREE_ALLOWANCE, hintMarksLost } from '@learnsdlc/shared';
import {
  assembleCriteria,
  countTestMethods,
  detectMentorPaste,
  difficultyTier,
  dockerEntrypoint,
  evaluateRules,
  nextPhaseStatus,
  overallScore,
  phaseRollup,
  relianceIndex,
  scoreCodeQuality,
  scoreFromRules,
  scoreProcess,
  scoreTests,
  smokeArgvFor,
  stripCodeComments,
  taskRollup,
  tierHintOffset,
} from './checkers';

const rubric: PhaseRubric = {
  passThreshold: 70,
  criteria: [
    { key: 'a', title: 'A', weight: 0.6, description: '' },
    { key: 'b', title: 'B', weight: 0.4, description: '' },
  ],
};

describe('checkers', () => {
  describe('evaluateRules', () => {
    it('passes required patterns and fails missing ones with the authored detail', () => {
      const outcomes = evaluateRules(
        [
          { id: 'has-overdue', label: 'l', criterion: 'a', pattern: 'overdue', flags: 'i', required: true, failDetail: 'add it', target: 'docker-compose.yml' },
          { id: 'no-vague', label: 'l2', criterion: 'a', forbidden: '\\bfast\\b', flags: 'i', required: false, failDetail: 'vague', target: 'docker-compose.yml' },
        ],
        () => 'The Overdue report is fast',
      );
      expect(outcomes[0].passed).toBe(true);
      expect(outcomes[1].passed).toBe(false);
      expect(outcomes[1].check.status).toBe('warning');
      expect(outcomes[1].check.detail).toBe('vague');
    });
  });

  describe('scoreFromRules', () => {
    it('averages required rules per criterion and applies optional penalties', () => {
      const outcomes = evaluateRules(
        [
          { id: '1', label: '', criterion: 'a', pattern: 'x', required: true, failDetail: '', target: 'f' },
          { id: '2', label: '', criterion: 'a', pattern: 'zzz', required: true, failDetail: '', target: 'f' },
          { id: '3', label: '', criterion: 'b', pattern: 'x', required: true, failDetail: '', target: 'f' },
          { id: '4', label: '', criterion: 'b', forbidden: 'x', required: false, failDetail: '', target: 'f' },
        ],
        () => 'x',
      );
      const scores = scoreFromRules(rubric, outcomes);
      expect(scores.get('a')).toBe(50); // 1 of 2 required
      expect(scores.get('b')).toBe(85); // 100 - 15 optional penalty
    });
  });

  describe('relianceIndex', () => {
    it('is zero with no hints and grows with hint dominance', () => {
      expect(relianceIndex(0, 3)).toBe(0);
      expect(relianceIndex(2, 1)).toBeLessThan(relianceIndex(10, 1));
      expect(relianceIndex(10, 0)).toBeLessThanOrEqual(100);
    });
  });

  describe('scoreProcess', () => {
    it('rewards running before submitting and moderate hint use', () => {
      expect(scoreProcess(true, 2)).toBe(100);
      expect(scoreProcess(false, 2)).toBe(60);
      expect(scoreProcess(true, 25)).toBe(70); // hint penalty capped at 30
    });

    // The mentor column reads this rule out to the learner
    // ("the first ten cost nothing, then three each, down to a floor of thirty")
    // from the same three constants this function subtracts by. The boundary is
    // pinned here so that moving the arithmetic into `hintMarksLost` cannot have
    // shifted it by one, and so that changing a constant turns this red rather
    // than quietly regrading everybody.
    it('costs nothing for ten questions and three marks for the eleventh', () => {
      expect(HINT_FREE_ALLOWANCE).toBe(10);
      expect(scoreProcess(true, 10)).toBe(100);
      expect(scoreProcess(true, 11)).toBe(97);
      expect(scoreProcess(true, 12)).toBe(94);
      // The floor, and everything past it.
      expect(scoreProcess(true, 20)).toBe(70);
      expect(scoreProcess(true, 400)).toBe(70);
      // The same arithmetic the column shows, from the same place.
      expect(100 - hintMarksLost(12)).toBe(scoreProcess(true, 12));
    });
  });

  describe('scoreTests', () => {
    it('is the pass rate, and zero when nothing ran', () => {
      expect(scoreTests(null)).toBe(0);
      expect(
        scoreTests({ ok: false, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: 4, passed: 3, failed: 1, errored: 0, cases: [] } }),
      ).toBe(75);
    });
  });

  describe('overallScore', () => {
    it('weights criteria', () => {
      const criteria = assembleCriteria(
        rubric,
        new Map([
          ['a', 100],
          ['b', 50],
        ]),
        new Map(),
      );
      expect(overallScore(criteria)).toBe(80); // 0.6*100 + 0.4*50
    });
  });

  describe('countTestMethods', () => {
    it('counts def test_ methods only', () => {
      const source = 'def test_one(self):\n    pass\ndef helper():\n    pass\n    def test_two(self):\n        pass\n';
      expect(countTestMethods(source)).toBe(2);
    });

    it('counts JavaScript test()/it() calls', () => {
      const js = "test('adds', () => {});\nit('subtracts', () => {});\nfunction helper(){}\n";
      expect(countTestMethods(js, 'javascript')).toBe(2);
    });

    // A testing phase spans two layers and `minTests` is one
    // number over the whole suite. Read with the Python
    // rule a `.tsx` suite counts zero, and a learner who wrote six tests is
    // told to write some.
    it('counts a TypeScript suite the way it counts a JavaScript one', () => {
      const tsx = [
        "import { render, screen } from '@testing-library/react';",
        "import { TaskRow } from './components/TaskRow';",
        '',
        "test('shows the overdue badge on a late task', () => {",
        '  render(<TaskRow task={late} />);',
        "  expect(screen.getByTestId('overdue-badge')).toBeTruthy();",
        '});',
        '',
        "it('leaves a task due today alone', () => {",
        '  render(<TaskRow task={today} />);',
        '});',
        '',
        'function helper() { return 1; }',
      ].join('\n');
      expect(countTestMethods(tsx, 'typescript')).toBe(2);
      // And the Python rule still reads Python, so nothing moved under the
      // API half of the same phase.
      expect(countTestMethods('def test_overdue():\n    pass\n', 'python')).toBe(1);
    });
  });

  describe('stripCodeComments (multi-language)', () => {
    it('strips Python # lines and JS // and /* */', () => {
      expect(stripCodeComments('# c\ncode\n', 'python')).not.toContain('# c');
      const js = '// line\ncode\n/* block\nmore */\nkeep';
      const out = stripCodeComments(js, 'javascript');
      expect(out).not.toContain('// line');
      expect(out).not.toContain('block');
      expect(out).toContain('keep');
    });

    it('strips Python docstrings so template prose cannot satisfy coverage keywords', () => {
      const py = [
        '"""Acceptance tests.',
        '',
        'Cover complete, filter and overdue.',
        '"""',
        "'''single-quoted overdue docstring'''",
        'import unittest',
        'def test_add(self):',
        '    """complete this"""',
        '    self.assertEqual(1, 1)',
      ].join('\n');
      const out = stripCodeComments(py, 'python');
      expect(out).not.toMatch(/complete|filter|overdue/i);
      expect(out).toContain('import unittest');
      expect(out).toContain('def test_add(self):');
      expect(out).toContain('self.assertEqual(1, 1)');
    });

    // The front-end scaffold names the behaviours to cover
    // in its own header comment, exactly as the Python template names them in
    // a docstring. Read with the Python rule none of it is stripped and the
    // coverage keywords are satisfied by the words the pack wrote.
    it('strips a TypeScript scaffold so template prose cannot satisfy coverage keywords', () => {
      const tsx = [
        '/**',
        ' * Acceptance tests for the overdue report.',
        ' *',
        ' * Cover complete, filter and overdue.',
        ' */',
        "// Start with the overdue badge, then filter, then complete.",
        "import { render } from '@testing-library/react';",
        '',
        "test('a late task is listed', () => {",
        "  render(<OverduePage today='2026-03-04' />);",
        '});',
      ].join('\n');
      const out = stripCodeComments(tsx, 'typescript');
      expect(out).not.toMatch(/complete|filter|overdue report/i);
      expect(out).toContain("import { render } from '@testing-library/react';");
      expect(out).toContain("test('a late task is listed', () => {");
    });
  });

  describe('nextPhaseStatus', () => {
    it('moves an unlocked phase to submitted or passed', () => {
      expect(nextPhaseStatus('in_progress', false)).toBe('submitted');
      expect(nextPhaseStatus('in_progress', true)).toBe('passed');
      expect(nextPhaseStatus('submitted', false)).toBe('submitted');
      expect(nextPhaseStatus('submitted', true)).toBe('passed');
    });
    it('never unlocks a locked phase and never un-passes a passed one', () => {
      expect(nextPhaseStatus('locked', false)).toBe('locked');
      expect(nextPhaseStatus('locked', true)).toBe('locked');
      expect(nextPhaseStatus('passed', false)).toBe('passed');
    });
  });

  describe('dockerEntrypoint', () => {
    it('reads an exec-form ENTRYPOINT and makes WORKDIR paths relative', () => {
      const df = 'FROM python:3.11-slim\nWORKDIR /app\nCOPY . .\nENTRYPOINT ["python", "/app/cli.py"]\n';
      expect(dockerEntrypoint(df)).toEqual({ argv: ['python', 'cli.py'] });
    });
    it('combines ENTRYPOINT with CMD defaults and accepts shell form', () => {
      const df = 'FROM node:22-slim\nENTRYPOINT node cli.js\nCMD ["--version"]\n';
      expect(dockerEntrypoint(df)).toEqual({ argv: ['node', 'cli.js', '--version'] });
      expect(dockerEntrypoint('CMD ["node", "cli.js"]')).toEqual({ argv: ['node', 'cli.js'] });
    });
    it('reports an unfinished Dockerfile instead of inventing a command', () => {
      const scaffold = 'FROM python:3.11-slim\n# TODO(learner): define the container entrypoint\n';
      const out = dockerEntrypoint(scaffold);
      expect(out.argv).toEqual([]);
      expect(out.problem).toMatch(/no ENTRYPOINT or CMD/);
    });
    it('refuses launchers other than python or node', () => {
      const out = dockerEntrypoint('ENTRYPOINT ["sh", "-c", "python cli.py"]');
      expect(out.argv).toEqual([]);
      expect(out.problem).toMatch(/python or node/);
    });
    it('refuses an argv that runs anything but a workspace script', () => {
      // The runner executes this argv verbatim, so an interpreter flag is a
      // shell on the machine hosting the class, and its stdout is handed back
      // to the learner. Validating the launcher alone is not enough.
      const forged = [
        'ENTRYPOINT ["python", "-c", "print(1)"]',
        'ENTRYPOINT ["python", "-m", "http.server"]',
        'ENTRYPOINT ["node", "-e", "console.log(1)"]',
        'ENTRYPOINT ["node", "--eval", "console.log(1)"]',
        'ENTRYPOINT ["python", "-"]',
        'ENTRYPOINT ["/usr/bin/python", "/etc/passwd"]',
        'ENTRYPOINT ["python", "/etc/passwd"]',
        'ENTRYPOINT ["python", "../../etc/evil.py"]',
        'CMD python ../../../etc/passwd',
        'ENTRYPOINT ["python"]',
      ];
      for (const dockerfile of forged) {
        const out = dockerEntrypoint(dockerfile);
        expect([dockerfile, out.argv]).toEqual([dockerfile, []]);
        expect(out.problem).toBeTruthy();
      }
    });
    it('refuses a script the phase does not ship, and names it', () => {
      const df = 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT ["python", "/app/tools/dump.py"]\n';
      const missing = dockerEntrypoint(df, { 'cli.py': '' });
      expect(missing.argv).toEqual([]);
      expect(missing.problem).toContain('tools/dump.py');
      expect(dockerEntrypoint(df, { 'tools/dump.py': '' }).argv).toEqual(['python', 'tools/dump.py']);
    });
    // Why `dockerEntrypoint` takes no path argument. The pack's api/Dockerfile is
    // built from the project root (`build: { context: ., dockerfile:
    // api/Dockerfile }`), so WORKDIR plus the entrypoint already relativise to
    // the workspace path, and a Dockerfile that drops the api/ prefix is a
    // Dockerfile that does not start, refusing it is the right answer, and a
    // path argument would accept it.
    it('reads the api/Dockerfile of a two-service pack without being told where it lives', () => {
      const files = { 'api/main.py': '', 'api/Dockerfile': '', 'docker-compose.yml': '' };
      const written = 'FROM python:3.11-slim\nWORKDIR /app\nCOPY api/ ./api/\nENTRYPOINT ["python3", "api/main.py"]\n';
      expect(dockerEntrypoint(written, files)).toEqual({ argv: ['python3', 'api/main.py'] });

      const absolute = 'FROM python:3.11-slim\nWORKDIR /app\nENTRYPOINT ["python3", "/app/api/main.py"]\n';
      expect(dockerEntrypoint(absolute, files)).toEqual({ argv: ['python3', 'api/main.py'] });

      // The image copies api/ to /app/api/, so this one starts nothing.
      const dropped = 'FROM python:3.11-slim\nWORKDIR /app\nCOPY api/ ./api/\nENTRYPOINT ["python3", "main.py"]\n';
      const out = dockerEntrypoint(dropped, files);
      expect(out.argv).toEqual([]);
      expect(out.problem).toContain('main.py');
    });
    it('refuses an argument that points outside the workspace', () => {
      const out = dockerEntrypoint('ENTRYPOINT ["python", "cli.py", "--data", "/etc/shadow"]');
      expect(out.argv).toEqual([]);
      expect(out.problem).toContain('/etc/shadow');
    });
  });

  describe('smokeArgvFor', () => {
    it('keeps the authored CLI arguments and starts them via the learner argv', () => {
      const authored = [
        ['python3', 'cli.py', 'add', 'Ship the release', '--priority', 'high'],
        ['python3', 'cli.py', 'list'],
      ];
      expect(smokeArgvFor(['python', 'app/cli.py'], authored)).toEqual([
        ['python', 'app/cli.py', 'add', 'Ship the release', '--priority', 'high'],
        ['python', 'app/cli.py', 'list'],
      ]);
    });
    it('drops the container default arguments that docker run would replace', () => {
      // CMD beside an ENTRYPOINT is a default argv, replaced the moment
      // `docker run <image> add ...` passes its own. Keeping it appended
      // failed a learner whose Dockerfile was right.
      expect(smokeArgvFor(['node', 'cli.js', '--help'], [['node', 'cli.js', 'add', 'Ship it']])).toEqual([
        ['node', 'cli.js', 'add', 'Ship it'],
      ]);
    });
  });

  describe('difficultyTier (adaptive difficulty)', () => {
    it('is standard before any phase is passed', () => {
      expect(difficultyTier(null, 0, 0)).toBe('standard');
      expect(difficultyTier(90, 0, 0)).toBe('standard');
    });
    it('is challenge for high scores with low reliance', () => {
      expect(difficultyTier(90, 20, 2)).toBe('challenge');
    });
    it('is guided when struggling or over-reliant', () => {
      expect(difficultyTier(60, 10, 2)).toBe('guided');
      expect(difficultyTier(90, 70, 2)).toBe('guided');
    });
    it('is standard in the middle', () => {
      expect(difficultyTier(75, 40, 2)).toBe('standard');
    });
    it('fades one scaffolding step only at challenge tier', () => {
      expect(tierHintOffset('challenge')).toBe(1);
      expect(tierHintOffset('standard')).toBe(0);
      expect(tierHintOffset('guided')).toBe(0);
    });
  });

  describe('detectMentorPaste (integrity)', () => {
    const mentor = [
      'A user story has three parts: a persona, a capability and a benefit that you decide.',
    ];
    it('flags a verbatim run of mentor words in the artefact', () => {
      const artifact = 'My notes: a persona, a capability and a benefit that you decide, then criteria.';
      expect(detectMentorPaste(artifact, mentor)).toBe(true);
    });
    it('does not flag independent, paraphrased writing', () => {
      const artifact = 'As a learner I want an overdue report so that I catch missed deadlines early.';
      expect(detectMentorPaste(artifact, mentor)).toBe(false);
    });
    it('does not flag a short shared phrase', () => {
      expect(detectMentorPaste('the overdue report', mentor)).toBe(false);
    });

    /*
     * The mentor quotes the pack's own vocabulary on purpose, and the learner is
     * asked to restate the customer's acceptance criteria. Without the fourth
     * argument the detector accused 16 of 25 learners of the seeded class, on
     * phrases like the one below: the ordering rule the customer gave them.
     */
    const ORDERING = 'most overdue first, then higher priority, then id';
    const hint = [`For the report: ${ORDERING}. Look at what your design already says.`];

    it('does not flag words the pack itself put in front of the learner', () => {
      const artifact = `Then the report is ordered: ${ORDERING}.`;
      expect(detectMentorPaste(artifact, hint)).toBe(true);
      const given = [`AC-4. The report is ${ORDERING}.`];
      expect(detectMentorPaste(artifact, hint, 8, given)).toBe(false);
    });

    it('still flags a mentor run that is nowhere in what the learner was given', () => {
      const artifact = 'My notes: a persona, a capability and a benefit that you decide, then criteria.';
      const given = ['The backlog says nothing of the kind, in any of its own words.'];
      expect(detectMentorPaste(artifact, mentor, 8, given)).toBe(true);
    });
  });
});

/* --------------------- the code-quality score ------------------------------ */

describe('scoreCodeQuality', () => {
  const report = (issues: AnalyzerReport['issues']): AnalyzerReport => ({
    issues,
    metrics: { files: 1, functions: 4, todosRemaining: 0, maxComplexity: 3, docstringCoverage: 1 },
  });

  it('an analyzer that could not run costs the learner nothing', () => {
    const analysis = report([
      {
        path: 'api/repository/tasks.py',
        line: 1,
        severity: 'error',
        rule: ANALYZER_UNAVAILABLE_RULE,
        message: 'Static analysis could not run for this submission.',
      },
    ]);
    expect(scoreCodeQuality(analysis)).toBe(100);
  });

  it('is the same score the editor shows', () => {
    const analysis = report([
      { path: 'api/repository/tasks.py', line: 74, severity: 'error', rule: 'not-implemented', message: 'still raises' },
      { path: 'api/repository/tasks.py', line: 71, severity: 'warning', rule: 'todo-remaining', message: 'a TODO' },
      { path: 'api/routes/tasks.py', line: 12, severity: 'info', rule: 'missing-docstring', message: 'no docstring' },
    ]);
    expect(scoreCodeQuality(analysis)).toBe(63);
    expect(codeQualityScore(analysis)).toBe(scoreCodeQuality(analysis));
  });
});

/* --------------------------- the phase roll-up ---------------------------- */

/**
 * Teacher-authored projects: where a graded task's verdict moves its phase.
 *
 * `nextPhaseStatus` is what the sole-task arm calls, so a phase of the
 * shipped project decides exactly what `nextPhaseStatus` decides; and a phase
 * with authored tasks is quantified over the
 * **pinned version's required keys**, never over the rows handed in, because a
 * key with no row is a key that has not passed.
 */
function compiled(over: Partial<CompiledTask> & { taskKey: string }): CompiledTask {
  return {
    order: 1,
    required: true,
    signOff: false,
    checkKind: 'story',
    artefactType: 'user-story',
    artefactPath: null,
    title: over.taskKey || 'The phase',
    brief: '',
    objectives: [],
    owns: [],
    gradedUnits: [],
    rubric,
    ...over,
  };
}

const NOW = '2026-09-19T10:00:00.000Z';
const EARLIER = '2026-09-18T09:00:00.000Z';

describe('phaseRollup', () => {
  const sole = [compiled({ taskKey: '' })];

  it('phaseRollup is nextPhaseStatus for a sole task', () => {
    // The six status transitions, driven through `phaseRollup` instead.
    const rows: [PhaseStatus, boolean, PhaseStatus, string | null][] = [
      ['locked', true, 'locked', null],
      ['passed', false, 'passed', EARLIER],
      ['in_progress', true, 'passed', NOW],
      ['in_progress', false, 'submitted', null],
      ['submitted', true, 'passed', NOW],
      ['submitted', false, 'submitted', null],
    ];
    for (const [status, passed, expected, passedAt] of rows) {
      const held = {
        status,
        passedAt: status === 'passed' ? EARLIER : null,
        bestScore: 40,
      };
      const roll = phaseRollup(held, sole, [], { passed, overall: 72 }, NOW);
      expect(roll.status).toBe(nextPhaseStatus(status, passed));
      expect(roll.status).toBe(expected);
      expect(roll.passedAt).toBe(passedAt);
      // The same expression as the phase-level writer, at the same call
      // site: the maximum of what the phase held and what the verdict
      // scored, whatever the status did.
      expect(roll.bestScore).toBe(Math.max(held.bestScore ?? 0, 72));
    }
    // And no task row is ever consulted on that arm, so a board that has none
    // (which for a project of sole-task phases is every board) reads the
    // same as `nextPhaseStatus` alone would read it.
    expect(
      phaseRollup({ status: 'in_progress', passedAt: null, bestScore: null }, sole, [], { passed: true, overall: 0 }, NOW),
    ).toEqual({ status: 'passed', passedAt: NOW, bestScore: 0 });
  });

  it('a missing row is a failing row', () => {
    // The case that matters most. Two required keys, one row,
    // and that row passed: the naive `req.every(...)` over the rows handed in
    // is true (`req.length === 1 > 0`) and the phase opens on one of two.
    const tasks = [
      compiled({ taskKey: 'story', order: 1 }),
      compiled({ taskKey: 'criteria', order: 2 }),
    ];
    const roll = phaseRollup(
      { status: 'in_progress', passedAt: null, bestScore: null },
      tasks,
      [{ taskKey: 'story', status: 'passed', passedAt: NOW, bestScore: 90 }],
      { passed: true, overall: 90 },
      NOW,
    );
    expect(roll.status).toBe('submitted');
    expect(roll.passedAt).toBeNull();

    // With the second row in, and passed, it opens: once, at the newest of
    // the required tasks' stamps.
    const opened = phaseRollup(
      { status: 'submitted', passedAt: null, bestScore: 45 },
      tasks,
      [
        { taskKey: 'story', status: 'passed', passedAt: EARLIER, bestScore: 90 },
        { taskKey: 'criteria', status: 'passed', passedAt: NOW, bestScore: 70 },
      ],
      { passed: true, overall: 70 },
      NOW,
    );
    expect(opened.status).toBe('passed');
    expect(opened.passedAt).toBe(NOW);
    expect(opened.bestScore).toBe(80);
  });

  it('an empty required set reads shut', () => {
    // The compiler refuses a phase with no required task, so this is belt and
    // braces, and the braces fall shut, which is the direction a doubt falls.
    const roll = phaseRollup(
      { status: 'in_progress', passedAt: null, bestScore: null },
      [compiled({ taskKey: 'extra', required: false })],
      [{ taskKey: 'extra', status: 'passed', passedAt: NOW, bestScore: 100 }],
      { passed: true, overall: 100 },
      NOW,
    );
    expect(roll.status).toBe('submitted');
    expect(roll.status).not.toBe('passed');
    expect(roll.passedAt).toBeNull();
  });

  it('an optional task moves no phase score', () => {
    const tasks = [
      compiled({ taskKey: 'story', order: 1 }),
      compiled({ taskKey: 'criteria', order: 2 }),
      compiled({ taskKey: 'scope', order: 3, required: false }),
    ];
    const roll = phaseRollup(
      { status: 'submitted', passedAt: null, bestScore: null },
      tasks,
      [
        { taskKey: 'story', status: 'passed', passedAt: EARLIER, bestScore: 50 },
        { taskKey: 'criteria', status: 'passed', passedAt: NOW, bestScore: 50 },
        { taskKey: 'scope', status: 'passed', passedAt: NOW, bestScore: 100 },
      ],
      { passed: true, overall: 100 },
      NOW,
    );
    // 50, not 66: averaging optional work into the phase's number would make a
    // learner's score depend on whether they attempted something that was
    // never required, in both directions.
    expect(roll.bestScore).toBe(50);
    expect(roll.status).toBe('passed');
  });

  it('a locked phase stays locked and a passed phase stays passed', () => {
    const tasks = [compiled({ taskKey: 'story' }), compiled({ taskKey: 'criteria', order: 2 })];
    const locked = phaseRollup(
      { status: 'locked', passedAt: null, bestScore: 30 },
      tasks,
      [{ taskKey: 'story', status: 'passed', passedAt: NOW, bestScore: 100 }],
      { passed: true, overall: 100 },
      NOW,
    );
    expect(locked).toEqual({ status: 'locked', passedAt: null, bestScore: 30 });

    // Sticky: nothing here may un-pass a phase, so a task reopened by a verdict
    // does not take the phase's own stamp away. A teacher's lever does that,
    // and a lever is not a verdict.
    const sticky = phaseRollup(
      { status: 'passed', passedAt: EARLIER, bestScore: 88 },
      tasks,
      [{ taskKey: 'story', status: 'in_progress', passedAt: null, bestScore: 10 }],
      { passed: false, overall: 10 },
      NOW,
    );
    expect(sticky.status).toBe('passed');
    expect(sticky.passedAt).toBe(EARLIER);
    expect(sticky.bestScore).toBe(88);
  });

  it('a row naming a key the pinned version does not declare is never required', () => {
    const tasks = [compiled({ taskKey: 'story' })];
    const roll = phaseRollup(
      { status: 'submitted', passedAt: null, bestScore: null },
      tasks,
      [
        { taskKey: 'story', status: 'passed', passedAt: NOW, bestScore: 80 },
        // A key from another version: the learner did that work and the row
        // keeps it; the gate quantifies over the pinned list and nothing else.
        { taskKey: 'from-another-version', status: 'in_progress', passedAt: null, bestScore: 0 },
      ],
      { passed: true, overall: 80 },
      NOW,
    );
    expect(roll.status).toBe('passed');
    expect(roll.bestScore).toBe(80);
  });
});

describe('taskRollup', () => {
  it('taskRollup does not pass a signOff task on a verdict', () => {
    const held = { status: 'in_progress' as PhaseStatus, passedAt: null, bestScore: 40 };
    const roll = taskRollup(held, { signOff: true }, { passed: true, overall: 95 }, NOW);
    expect(roll.status).not.toBe('passed');
    expect(roll.status).toBe('submitted');
    expect(roll.awaitingSignOff).toBe(true);
    expect(roll.passedAt).toBeNull();
    expect(roll.bestScore).toBe(95);
  });

  it('is nextPhaseStatus plus the one thing a task has that a phase does not', () => {
    const held = { status: 'in_progress' as PhaseStatus, passedAt: null, bestScore: null };
    const sealed = taskRollup(held, { signOff: false }, { passed: true, overall: 81 }, NOW);
    expect(sealed).toEqual({ status: 'passed', passedAt: NOW, bestScore: 81, awaitingSignOff: false });

    const failed = taskRollup(held, { signOff: false }, { passed: false, overall: 12 }, NOW);
    expect(failed).toEqual({ status: 'submitted', passedAt: null, bestScore: 12, awaitingSignOff: false });

    // A failed verdict on a sign-off task is not waiting for anybody.
    const notReady = taskRollup(held, { signOff: true }, { passed: false, overall: 12 }, NOW);
    expect(notReady.awaitingSignOff).toBe(false);

    // And an already-passed task is not asked for a countersignature twice.
    const already = taskRollup(
      { status: 'passed', passedAt: EARLIER, bestScore: 90 },
      { signOff: true },
      { passed: true, overall: 95 },
      NOW,
    );
    expect(already.status).toBe('passed');
    expect(already.passedAt).toBe(EARLIER);
    expect(already.awaitingSignOff).toBe(false);
  });
});
