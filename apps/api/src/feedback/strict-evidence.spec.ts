import {
  reviewerVerdictIsAdvice,
  type AiRubricReview,
  type FeedbackCheck,
  type FeedbackReport,
  type PhaseRubric,
  type QuizChecks,
} from '@learnsdlc/shared';
import { canonicalJson } from '../content/blob.store';
import type { PhaseContent } from '../content/content.types';
import { quizPassed, strictEvidencePassed, strictTaskEvidencePassed, type GateReport } from './strict-evidence';

/**
 * The binary gate, and the sibling the task grain reads it through.
 *
 * `strict-evidence.ts` has a parameterised task-level sibling and makes the
 * phase-level function delegate to it, clause for clause. This file is the
 * proof of both halves, that the delegation
 * moves no decision, and that the two clauses which refuse a red, empty or
 * absent suite still refuse it.
 */

const rubric: PhaseRubric = {
  passThreshold: 70,
  criteria: [
    { key: 'clarity', title: 'Clarity', weight: 0.5, description: '' },
    { key: 'completeness', title: 'Completeness', weight: 0.5, description: '' },
  ],
};

/** A phase carrying only what the gate reads: its rubric and its check kind. */
function phaseOf(kind: PhaseContent['checks']['kind'], over: Partial<PhaseRubric> = {}): PhaseContent {
  return {
    rubric: { ...rubric, ...over },
    checks: { kind },
  } as unknown as PhaseContent;
}

function reviewOf(over: Partial<AiRubricReview> = {}): AiRubricReview {
  return {
    provider: 'openai',
    verdict: 'pass',
    summary: 'ok',
    strengths: [],
    improvements: [],
    processNote: '',
    criteriaEvidence: rubric.criteria.map((criterion) => ({
      key: criterion.key,
      met: true,
      evidence: 'requirements/draft.md line 4',
      issue: '',
      nextStep: '',
    })),
    ...over,
  };
}

function checksOf(...statuses: FeedbackCheck['status'][]): FeedbackCheck[] {
  return statuses.map((status, at) => ({ id: `c${at + 1}`, label: `c${at + 1}`, status, detail: '' }));
}

/**
 * `overall` defaults to 0 so that every row below the policy's own block is
 * judged with the reviewer's verdict gating, as it does at any score below 100.
 */
function reportOf(
  checks: FeedbackCheck[],
  tests?: FeedbackReport['tests'],
  overall = 0,
): GateReport {
  return { checks, tests, overall };
}

const suite = (over: Partial<NonNullable<FeedbackReport['tests']>> = {}) =>
  ({ total: 4, passed: 4, failed: 0, errored: 0, cases: [], ...over }) as NonNullable<
    FeedbackReport['tests']
  >;

const rubric3: PhaseRubric = {
  passThreshold: 70,
  criteria: [
    { key: 'clarity', title: 'Clarity', weight: 0.4, description: '' },
    { key: 'completeness', title: 'Completeness', weight: 0.3, description: '' },
    { key: 'testability', title: 'Testability', weight: 0.3, description: '' },
  ],
};
const rubric1: PhaseRubric = {
  passThreshold: 70,
  criteria: [{ key: 'clarity', title: 'Clarity', weight: 1, description: '' }],
};
/** A written task on the given rubric. */
const on = (of: PhaseRubric) => ({ rubric: of, checkKind: 'story' as const });
/**
 * The reviewer says needs_revision over every key of `of`, the first `count`
 * of them met with evidence and the rest unmet with an issue.
 */
function saysNo(of: PhaseRubric, count: number): AiRubricReview {
  return reviewOf({
    verdict: 'needs_revision',
    criteriaEvidence: of.criteria.map((criterion, at) =>
      at < count
        ? { key: criterion.key, met: true, evidence: 'requirements/draft.md line 4', issue: '', nextStep: '' }
        : { key: criterion.key, met: false, evidence: '', issue: 'The story names no benefit.', nextStep: 'Add one.' },
    ),
  });
}

describe('strictTaskEvidencePassed', () => {
  it('strictEvidencePassed delegates and does not move', () => {
    // A matrix over all six clauses. Every row is asserted twice: once through
    // the phase-level function every existing caller uses, and once through the
    // task-level sibling with the phase's own rubric and kind, which is what
    // a sole task is. If the delegation ever stopped being a
    // delegation, half of these rows would disagree.
    const rows: [string, PhaseContent, GateReport, AiRubricReview, boolean][] = [
      ['a written (story) pass', phaseOf('story'), reportOf(checksOf('passed', 'info')), reviewOf(), true],
      [
        'clause 1: the provider was unavailable',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({ provider: 'unavailable' }),
        false,
      ],
      [
        'clause 1: the assessment errored',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({ assessmentError: 'timed out' }),
        false,
      ],
      [
        'clause 1: the verdict is needs_revision',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({ verdict: 'needs_revision' }),
        false,
      ],
      [
        'clause 2: one criterion short',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({ criteriaEvidence: [{ key: 'clarity', met: true, evidence: 'x', issue: '', nextStep: '' }] }),
        false,
      ],
      [
        'clause 2: no evidence at all',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({ criteriaEvidence: [] }),
        false,
      ],
      [
        'clause 3: the same key twice, and a criterion unanswered',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({
          criteriaEvidence: [
            { key: 'clarity', met: true, evidence: 'x', issue: '', nextStep: '' },
            { key: 'clarity', met: true, evidence: 'x', issue: '', nextStep: '' },
          ],
        }),
        false,
      ],
      [
        'clause 4: a criterion not met',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({
          criteriaEvidence: [
            { key: 'clarity', met: false, evidence: 'x', issue: '', nextStep: '' },
            { key: 'completeness', met: true, evidence: 'x', issue: '', nextStep: '' },
          ],
        }),
        false,
      ],
      [
        'clause 4: evidence that is whitespace',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({
          criteriaEvidence: [
            { key: 'clarity', met: true, evidence: '   ', issue: '', nextStep: '' },
            { key: 'completeness', met: true, evidence: 'x', issue: '', nextStep: '' },
          ],
        }),
        false,
      ],
      [
        'clause 4: an issue raised beside a met criterion',
        phaseOf('story'),
        reportOf(checksOf('passed')),
        reviewOf({
          criteriaEvidence: [
            { key: 'clarity', met: true, evidence: 'x', issue: 'but the ordering is wrong', nextStep: '' },
            { key: 'completeness', met: true, evidence: 'x', issue: '', nextStep: '' },
          ],
        }),
        false,
      ],
      [
        'clause 5: a failed check',
        phaseOf('story'),
        reportOf(checksOf('passed', 'failed')),
        reviewOf(),
        false,
      ],
      [
        'clause 5: a warning is not a pass',
        phaseOf('story'),
        reportOf(checksOf('passed', 'warning')),
        reviewOf(),
        false,
      ],
      [
        'clause 5: no required check at all',
        phaseOf('story'),
        reportOf([{ id: 'process', label: 'process', status: 'passed', detail: '' }]),
        reviewOf(),
        false,
      ],
      [
        'clause 6: a code phase with a green suite',
        phaseOf('code'),
        reportOf(checksOf('passed'), suite()),
        reviewOf(),
        true,
      ],
      [
        'clause 6: a code phase with a red suite',
        phaseOf('code'),
        reportOf(checksOf('passed'), suite({ passed: 3, failed: 1 })),
        reviewOf(),
        false,
      ],
      [
        'clause 6: a tests phase whose suite errored',
        phaseOf('tests'),
        reportOf(checksOf('passed'), suite({ errored: 1 })),
        reviewOf(),
        false,
      ],
      [
        'clause 6 does not fire on a config phase',
        phaseOf('config'),
        reportOf(checksOf('passed')),
        reviewOf(),
        true,
      ],
    ];

    for (const [name, phase, report, review, expected] of rows) {
      expect([name, strictEvidencePassed(phase, report, review)]).toEqual([name, expected]);
      expect([
        name,
        strictTaskEvidencePassed(
          { rubric: phase.rubric, checkKind: phase.checks.kind },
          report,
          review,
        ),
      ]).toEqual([name, expected]);
    }
  });

  it('clause 6 still refuses an absent or empty suite', () => {
    // A suite that collects nothing can exit zero, so `run.ok` is true and the
    // check reads `passed`. Only `total > 0` catches that, which is exactly why
    // it stays unconditional, for the phase and for the task alike.
    const task = { rubric, checkKind: 'code' as const };
    const green = reportOf(checksOf('passed'));

    expect(strictTaskEvidencePassed(task, reportOf(checksOf('passed'), suite({ total: 0, passed: 0 })), reviewOf())).toBe(false);
    expect(strictTaskEvidencePassed(task, green, reviewOf())).toBe(false);
    expect(strictEvidencePassed(phaseOf('code'), green, reviewOf())).toBe(false);

    // And the task's own kind decides, not the phase's: a written task on a
    // phase that runs code is judged by the written clauses.
    expect(strictTaskEvidencePassed({ rubric, checkKind: 'story' }, green, reviewOf())).toBe(true);
  });

  it('at a score of 100 with every rule met and most criteria met, the reviewer’s verdict is advice; anywhere else it gates', () => {
    // At a rule-based 100, with every check passed and every test green, the
    // reviewer's needs_revision and its unmet criteria are shown as advice, but
    // only while the reviewer found strictly more than half of the criteria
    // met. A reviewer that finds most criteria unmet is refusing the work, not
    // varying on a detail. Every other refusal stands, and so does the
    // verdict's gate at any score below 100.
    const task = { rubric, checkKind: 'story' as const };
    const code = { rubric, checkKind: 'code' as const };
    // Most criteria met (both of two), and still needs_revision: the case the
    // advice rule exists for, so every "never advice" row below is refused by
    // its own rule clause and not by the count.
    const reviewerSaysNo = reviewOf({
      verdict: 'needs_revision',
      criteriaEvidence: [
        { key: 'clarity', met: true, evidence: 'x', issue: 'The second story could name its benefit.', nextStep: 'Add one.' },
        { key: 'completeness', met: true, evidence: 'x', issue: '', nextStep: '' },
      ],
    });
    const rows: [string, { rubric: PhaseRubric; checkKind: PhaseContent['checks']['kind'] }, GateReport, AiRubricReview, boolean][] = [
      ['100, every check passed, the reviewer says no: advice, so a pass', task, reportOf(checksOf('passed', 'info'), undefined, 100), reviewerSaysNo, true],
      ['100, a code task with a green suite, the reviewer says no: a pass', code, reportOf(checksOf('passed'), suite(), 100), reviewerSaysNo, true],
      ['100 and the reviewer says pass: a pass', task, reportOf(checksOf('passed'), undefined, 100), reviewOf(), true],
      ['99 and the reviewer says no: the verdict gates', task, reportOf(checksOf('passed'), undefined, 99), reviewerSaysNo, false],
      ['0 and the reviewer says no: the verdict gates', task, reportOf(checksOf('passed'), undefined, 0), reviewerSaysNo, false],
      ['100 beside a failed check: never advice', task, reportOf(checksOf('passed', 'failed'), undefined, 100), reviewerSaysNo, false],
      ['100 beside a warning: never advice', task, reportOf(checksOf('passed', 'warning'), undefined, 100), reviewerSaysNo, false],
      ['100 with no required check at all: never advice', task, reportOf([{ id: 'process', label: 'process', status: 'passed', detail: '' }], undefined, 100), reviewerSaysNo, false],
      ['100, a code task with a red suite: never advice', code, reportOf(checksOf('passed'), suite({ passed: 3, failed: 1 }), 100), reviewerSaysNo, false],
      ['100, a code task with an empty suite: never advice', code, reportOf(checksOf('passed'), suite({ total: 0, passed: 0 }), 100), reviewerSaysNo, false],
      ['100 but the provider was unavailable: refused', task, reportOf(checksOf('passed'), undefined, 100), reviewOf({ provider: 'unavailable', verdict: 'needs_revision' }), false],
      ['100 but the assessment errored: refused', task, reportOf(checksOf('passed'), undefined, 100), reviewOf({ assessmentError: 'timed out', verdict: 'needs_revision' }), false],
      ['100 but the evidence does not cover the rubric: refused', task, reportOf(checksOf('passed'), undefined, 100), reviewOf({ verdict: 'needs_revision', criteriaEvidence: [{ key: 'clarity', met: true, evidence: 'x', issue: 'x', nextStep: '' }] }), false],
      ['100 but no evidence at all: refused', task, reportOf(checksOf('passed'), undefined, 100), reviewOf({ verdict: 'needs_revision', criteriaEvidence: [] }), false],
      ['100 but the same key twice: refused', task, reportOf(checksOf('passed'), undefined, 100), reviewOf({ verdict: 'needs_revision', criteriaEvidence: [{ key: 'clarity', met: true, evidence: 'x', issue: 'x', nextStep: '' }, { key: 'clarity', met: true, evidence: 'x', issue: '', nextStep: '' }] }), false],
      ['100 but the right count with a key the rubric lacks: refused', task, reportOf(checksOf('passed'), undefined, 100), reviewOf({ verdict: 'needs_revision', criteriaEvidence: [{ key: 'clarity', met: true, evidence: 'x', issue: 'x', nextStep: '' }, { key: 'brevity', met: true, evidence: 'x', issue: '', nextStep: '' }] }), false],
      ['no score at all and the reviewer says no: the verdict gates', task, { checks: checksOf('passed'), tests: undefined }, reviewerSaysNo, false],
      ['100, a code task whose suite errored: never advice', code, reportOf(checksOf('passed'), suite({ errored: 1 }), 100), reviewerSaysNo, false],
      ['100, a code task with no suite: never advice', code, reportOf(checksOf('passed'), undefined, 100), reviewerSaysNo, false],
      // The count, on rubrics of three, two and one criteria. Each list is
      // every key of its rubric with the first `met` of them met, and the
      // reviewer says needs_revision throughout.
      ['100, 3 of 3 met: advice, so a pass', on(rubric3), reportOf(checksOf('passed'), undefined, 100), saysNo(rubric3, 3), true],
      ['100, 2 of 3 met: advice, so a pass', on(rubric3), reportOf(checksOf('passed'), undefined, 100), saysNo(rubric3, 2), true],
      ['100, 1 of 3 met: most unmet, refused', on(rubric3), reportOf(checksOf('passed'), undefined, 100), saysNo(rubric3, 1), false],
      ['100, 0 of 3 met: a thin story with every criterion unmet, refused', on(rubric3), reportOf(checksOf('passed'), undefined, 100), saysNo(rubric3, 0), false],
      ['100, 1 of 1 met: advice, so a pass', on(rubric1), reportOf(checksOf('passed'), undefined, 100), saysNo(rubric1, 1), true],
      ['100, 0 of 1 met: refused', on(rubric1), reportOf(checksOf('passed'), undefined, 100), saysNo(rubric1, 0), false],
      ['100, 1 of 2 met: half is not most, refused', task, reportOf(checksOf('passed'), undefined, 100), saysNo(rubric, 1), false],
      ['100, 2 of 2 met: advice, so a pass', task, reportOf(checksOf('passed'), undefined, 100), saysNo(rubric, 2), true],
      ['99, 3 of 3 met: below 100 the verdict gates', on(rubric3), reportOf(checksOf('passed'), undefined, 99), saysNo(rubric3, 3), false],
    ];
    for (const [name, which, report, review, expected] of rows) {
      expect([name, strictTaskEvidencePassed(which, report, review)]).toEqual([name, expected]);
      expect([name, strictEvidencePassed(phaseOf(which.checkKind, which.rubric), report, review)]).toEqual([name, expected]);
    }
    // The shared predicate itself, which the web also reads, so the pages
    // cannot drift from the rule the gate uses.
    const met = (of: PhaseRubric, count: number) => saysNo(of, count).criteriaEvidence!;
    expect(reviewerVerdictIsAdvice(100, met(rubric3, 3))).toBe(true);
    expect(reviewerVerdictIsAdvice(100, met(rubric3, 2))).toBe(true);
    expect(reviewerVerdictIsAdvice(100, met(rubric3, 1))).toBe(false);
    expect(reviewerVerdictIsAdvice(100, met(rubric3, 0))).toBe(false);
    expect(reviewerVerdictIsAdvice(99, met(rubric3, 3))).toBe(false);
    expect(reviewerVerdictIsAdvice(100.4, met(rubric3, 3))).toBe(false);
    expect(reviewerVerdictIsAdvice(100, met(rubric1, 1))).toBe(true);
    expect(reviewerVerdictIsAdvice(100, met(rubric, 1))).toBe(false);
  });

  it('the task’s rubric is what its evidence is counted against', () => {
    // The gate compares the review's evidence with `task.rubric`, and a
    // teacher-created task's rubric is derived from its own rules, so it can
    // already differ from its phase's on a single-task phase. A review
    // assembled from the phase's rubric against a gate reading the task's would
    // make the arithmetic never close, and no such task could ever pass.
    const narrow: PhaseRubric = {
      passThreshold: 70,
      criteria: [{ key: 'clarity', title: 'Clarity', weight: 1, description: '' }],
    };
    const review = reviewOf({
      criteriaEvidence: [{ key: 'clarity', met: true, evidence: 'x', issue: '', nextStep: '' }],
    });
    expect(strictTaskEvidencePassed({ rubric: narrow, checkKind: 'story' }, reportOf(checksOf('passed')), review)).toBe(true);
    // The phase's two-criterion rubric refuses the same review at clause 2.
    expect(strictEvidencePassed(phaseOf('story'), reportOf(checksOf('passed')), review)).toBe(false);
  });
});

/* --------------------------- quizzes -------------------------------------- */

/**
 * The equivalence the whole quiz design rests on.
 *
 * `quizPassed` decides a quiz's `passed` at exactly one site, the last line of
 * `buildReport`. Four more evaluate the gate again and independently, over the
 * **stored** report and long after `buildReport` has gone: `advance`, project
 * completion and three instructor readers all ask
 * `strictTaskEvidencePassed(task, report, report.aiReview)`. Forking there
 * would be five places that can disagree about one gate.
 *
 * So the agreement is built into the **report shape**, and this is that shape
 * written down as a test, independent of the service that produces it:
 *
 * - exactly one `FeedbackCheck`, id `quiz`, whose status is `quizPassed`'s
 *   answer. Not one per question: a wrong answer written as a `failed` check
 *   would be refused by clause 5, which would silently replace the teacher's
 *   pass mark with *no wrong answers* and make a required quiz passed at 80%
 *   unable to advance, for ever;
 * - one `criteriaEvidence` row for the quiz's one derived criterion, `met`
 *   carrying the same answer, so clause 4 agrees with clause 5;
 * - `provider: 'not-applicable'`, which is not `'unavailable'` and therefore
 *   survives clause 1, no model was asked, rather than asked and silent.
 *
 * `buildQuizReport` builds the report. If it drifts from this shape, this spec goes red before
 * a learner meets a phase they passed and cannot leave.
 */
describe('a quiz report answers the same thing to both evaluators', () => {
  const quizRubric: PhaseRubric = {
    passThreshold: 60,
    criteria: [
      { key: 'concepts', title: 'Concepts', weight: 1, description: 'Scored by the quiz your teacher set.' },
    ],
  };

  const quizTask = { rubric: quizRubric, checkKind: 'quiz' as const };

  /**
   * The report `buildQuizReport` must produce, hand-written here so that this
   * spec is a statement about the shape and not a restatement of the builder.
   */
  function quizReportOf(
    overall: number,
    passMark: number,
  ): GateReport & { aiReview: AiRubricReview } {
    const passed = quizPassed(overall, passMark);
    return {
      overall,
      checks: [
        {
          id: 'quiz',
          label: 'Quiz',
          status: passed ? 'passed' : 'failed',
          detail: `${overall}% against a pass mark of ${passMark}%`,
        },
      ],
      tests: undefined,
      aiReview: {
        // No model was asked. `'unavailable'` would mean one was asked and did
        // not answer, and clause 1 refuses that: a perfect paper would never
        // pass, and a deployment with no provider could not pass one at all.
        provider: 'not-applicable',
        verdict: 'pass',
        // `assessmentError` is `string | undefined`, so "no error" is the field
        // being absent. Writing `null` here would not compile.
        summary: 'Scored against the key your teacher sealed with this task.',
        strengths: [],
        improvements: [],
        processNote: '',
        criteriaEvidence: [
          {
            key: 'concepts',
            met: passed,
            evidence: `${overall}% on this paper`,
            issue: passed ? '' : 'Below the pass mark.',
            nextStep: passed ? '' : 'Read the explanations and take it again.',
          },
        ],
      },
    };
  }

  it('is quizPassed at the mark, above it and at 100, and below it', () => {
    const passMark = 80;
    // Four of five is 80: at the mark, and a pass. This is the case the whole
    // design turns on, because it is the one a per-question `failed` check
    // would have refused while the roll-up opened the phase.
    for (const overall of [80, 100, 60, 0]) {
      const report = quizReportOf(overall, passMark);
      expect([overall, strictTaskEvidencePassed(quizTask, report, report.aiReview)]).toEqual([
        overall,
        quizPassed(overall, passMark),
      ]);
    }
  });

  it('carries exactly one check, and a per-question check would break the equivalence', () => {
    const report = quizReportOf(80, 80);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].id).toBe('quiz');
    expect(strictTaskEvidencePassed(quizTask, report, report.aiReview)).toBe(true);

    // The counter-example, so the reason is asserted rather than described: add
    // the four-of-five paper's one wrong answer as its own `failed` check and
    // clause 5 refuses a paper that cleared its teacher's mark.
    const perQuestion = {
      ...report,
      checks: [
        ...report.checks,
        { id: 'q5', label: 'Question 5', status: 'failed' as const, detail: '' },
      ],
    };
    expect(strictTaskEvidencePassed(quizTask, perQuestion, perQuestion.aiReview)).toBe(false);
    expect(quizPassed(80, 80)).toBe(true);
  });

  it('a pass mark is a mark a learner can reach', () => {
    expect(quizPassed(80, 80)).toBe(true);
    expect(quizPassed(100, 80)).toBe(true);
    expect(quizPassed(79, 80)).toBe(false);
    expect(quizPassed(0, 0)).toBe(true);
  });

  it('“not-applicable” is not “unavailable”, and clause 1 tells them apart', () => {
    const report = quizReportOf(100, 80);
    expect(strictTaskEvidencePassed(quizTask, report, report.aiReview)).toBe(true);
    // The same perfect paper, with a provider that was asked and did not
    // answer: refused, which is right. The words are different facts and the
    // learner's report draws the degraded-grading banner on one of them only.
    const degraded = { ...report.aiReview, provider: 'unavailable' };
    expect(strictTaskEvidencePassed(quizTask, report, degraded)).toBe(false);
  });

  it('clause 6 does not fire on a quiz: there is no suite to be green', () => {
    // A quiz runs nothing. `report.tests` is absent, and the clause that
    // refuses an absent suite is scoped to `code` and `tests` and stays that
    // way: it is not widened, and it is not made conditional on sealedness.
    const report = quizReportOf(100, 60);
    expect(report.tests).toBeUndefined();
    expect(strictTaskEvidencePassed(quizTask, report, report.aiReview)).toBe(true);
    expect(strictTaskEvidencePassed({ rubric: quizRubric, checkKind: 'code' }, report, report.aiReview)).toBe(false);
  });

  it('the checks slice survives the canonicaliser the compiled snapshot is written through', () => {
    // `project_versions.compiled` is stored as canonical JSON, and
    // `authoredTasksFor` decides whether a task carries its own slice by
    // comparing `canonicalJson(row.checks)` with the phase's. A `QuizChecks`
    // holding anything JSON cannot round-trip (a Date, a Map, a key whose only
    // value is `undefined`) would make that comparison answer differently on
    // two loads of the same content.
    const checks: QuizChecks = {
      kind: 'quiz',
      questions: [
        {
          id: 'story-grammar',
          stem: 'Which line is a user story?',
          options: [
            { id: 'a', text: 'As a marker, I want …, so that …' },
            { id: 'b', text: 'Add a button to the marking screen.' },
          ],
          correct: ['a'],
          explanation: 'A story names the role, the goal and the benefit.',
          concept: 'role/goal/benefit',
        },
      ],
      drawn: 1,
      shuffleOptions: true,
      passMark: 60,
      attempts: { max: 3, cooldownSeconds: null },
      criterion: 'concepts',
    };

    const once = canonicalJson(checks);
    expect(canonicalJson(JSON.parse(once) as QuizChecks)).toBe(once);
    expect(JSON.parse(once)).toEqual(checks);

    // Key order does not move the string, which is what makes the comparison a
    // comparison of content; array order does, which is what keeps a reordered
    // option list a different paper.
    const reordered: QuizChecks = {
      criterion: 'concepts',
      attempts: { cooldownSeconds: null, max: 3 },
      passMark: 60,
      shuffleOptions: true,
      drawn: 1,
      questions: checks.questions,
      kind: 'quiz',
    };
    expect(canonicalJson(reordered)).toBe(once);
    const swapped: QuizChecks = {
      ...checks,
      questions: [
        { ...checks.questions[0], options: [...checks.questions[0].options].reverse() },
      ],
    };
    expect(canonicalJson(swapped)).not.toBe(once);
  });
});
