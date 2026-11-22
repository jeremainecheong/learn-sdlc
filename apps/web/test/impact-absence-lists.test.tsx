/**
 * The empty Change impact
 * card and the release record's "What changed" line say why there is no impact
 * reading from the same data the API decides it on.
 *
 * The API writes no impact report when the current or the earlier reading's
 * function LIST is empty (apps/api/src/feedback/impact.ts, buildImpactReport:
 * `current?.functions ?? []`, `baseline?.functions ?? []`). The card decided
 * "no earlier reading to compare with" from `metrics.functions` as well, a
 * different number: for JavaScript it counts every `function` and `=>` in the
 * source (apps/api/runner/analyzer.py), anonymous callbacks included, while the
 * list holds named declarations, class methods and named arrows only. So on a
 * JavaScript project whose files hold only anonymous handlers the card and the
 * record said there was no earlier reading, when the review had listed no
 * function of the learner's own. Now "no earlier reading" is said only when
 * the current list holds a function (so the earlier side is what was empty);
 * a list that is there and empty while functions were counted says no named
 * function was found; a report that carries no list at all says so; a reading
 * that counted no function says that none was found.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_CHANGE_REQUEST, type AnalyzerReport, type ChangeRequest, type FeedbackReport } from '@learnsdlc/shared';
import { emptyImpact, impactAbsence } from '@/components/workspace/panels/maintenance/impact';
import { buildRelease, type ReleaseInput } from '@/components/workspace/panels/maintenance/release';
import { ChangeImpactCard } from '@/components/workspace/panels/maintenance/ChangeCards';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';

type Fn = NonNullable<AnalyzerReport['functions']>[number];
const metrics = (files: number, functions: number) => ({ files, functions, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 });
const fn = (name: string, path: string) => ({ name, qualname: name, path, line: 1, endLine: 3, complexity: 1, calls: [], bodyHash: 'h' }) as unknown as Fn;

/** A JavaScript file of anonymous route handlers, `app.get('/x', (req, res) => ...)`: three `=>` counted, no named function listed. */
const anonymousHandlers: AnalyzerReport = { issues: [], metrics: metrics(1, 3), functions: [] };
/** A report from before the analyzer listed functions: functions counted, no list carried. */
const noList: AnalyzerReport = { issues: [], metrics: metrics(2, 3) };
/** No list carried and nothing counted: a reading with no function in it. */
const noListNoFns: AnalyzerReport = { issues: [], metrics: metrics(2, 0) };
/** A JavaScript class whose methods have no `function` or `=>`: nothing counted, one method listed. */
const methodsOnly: AnalyzerReport = { issues: [], metrics: metrics(1, 0), functions: [fn('render', 'web/src/view.js')] };
/** Functions read and listed (the normal reading; the API's missing impact is then the earlier side's). */
const listed: AnalyzerReport = { issues: [], metrics: metrics(2, 1), functions: [fn('is_overdue', 'api/overdue.py')] };

const NO_BASELINE_CARD = 'The review of PR-6 had no earlier reading of these functions to compare with, so there is no call graph to draw.';
const NO_FUNCTION_CARD = 'The review of PR-6 read no function in your files, so there is no call graph to draw.';
const TAIL = " The pull request's Files changed tab shows what changed.";

describe('the absence is decided on the function list, as the API decides it', () => {
  it('names each state', () => {
    expect(impactAbsence(anonymousHandlers)).toBe('no-named-function');
    expect(impactAbsence(noList)).toBe('no-list');
    expect(impactAbsence(noListNoFns)).toBe('no-function');
    expect(impactAbsence(methodsOnly)).toBe('no-baseline');
    expect(impactAbsence(listed)).toBe('no-baseline');
  });
});

describe('the empty Change impact card', () => {
  it('JavaScript whose functions the analyzer counts but cannot name: said so, not "no earlier reading"', () => {
    const card = emptyImpact('PR-6', true, false, anonymousHandlers);
    expect(card).toEqual({ title: 'No call graph', body: 'The review of PR-6 counted functions in your files but could not name any of them, so there is no call graph to draw.' });
    expect(card.body).not.toContain('earlier reading');
  });
  it('a report that carries no function list says so', () => {
    expect(emptyImpact('PR-6', true, false, noList)).toEqual({ title: 'No call graph', body: 'The review of PR-6 kept no list of the functions in your files, so there is no call graph to draw.' });
  });
  it('a listed function with nothing counted (class methods) is a reading with no earlier one', () => {
    expect(emptyImpact('PR-6', true, false, methodsOnly).body).toBe(NO_BASELINE_CARD);
  });
  it('a listed reading reads the no-baseline card and a reading with no function the no-function card', () => {
    expect(emptyImpact('PR-6', true, false, listed).body).toBe(NO_BASELINE_CARD);
    expect(emptyImpact('PR-6', true, false, noListNoFns).body).toBe(NO_FUNCTION_CARD);
  });
  it('the change request page\'s card draws it', () => {
    const html = renderToStaticMarkup(
      <ChangeImpactCard m={{ impactCount: 0, awaitingVerdict: false, reviewRunning: false, analysis: anonymousHandlers } as unknown as MaintenanceModel} impact={undefined} functions={[]} onOpen={() => {}} pr="PR-6" />,
    );
    expect(html).toContain('The review of PR-6 counted functions in your files but could not name any of them, so there is no call graph to draw.');
    expect(html).not.toContain('earlier reading');
  });
});

const releaseOf = (staticAnalysis: AnalyzerReport) => {
  const report = { passed: true, tests: { passed: 1, failed: 0, errored: 0, total: 1, cases: [] }, staticAnalysis } as unknown as FeedbackReport;
  const input: ReleaseInput = {
    projectTitle: 'Deadline badge', ticket: { id: 'CR-1', title: 'T', summary: '' }, change: null, signature: 'isOverdue(task)', contractTab: false,
    report, impactRead: false, marks: [], added: [], record: EMPTY_CHANGE_REQUEST as ChangeRequest, enrollment: null, phaseOrder: 6,
  };
  return buildRelease(input).lines.find((l) => l.label === 'What changed')!;
};

describe("the release record's What changed line", () => {
  it('JavaScript of anonymous handlers', () => {
    const line = releaseOf(anonymousHandlers);
    expect(line.text).toBe(`The analyzer read your files and counted functions in them but could not name any of them, so this line names no function.${TAIL}`);
    expect(line.state).toBe('done');
  });
  it('a report that carries no function list', () => {
    expect(releaseOf(noList).text).toBe(`The review kept no list of the functions in your files, so this line names no function.${TAIL}`);
  });
  it('the listed and the class-methods readings name no baseline, and the no-function reading says it found no function', () => {
    const NO_BASELINE = `The review read the functions in your files but had no earlier reading of them to compare with, so this line names no function.${TAIL}`;
    expect(releaseOf(listed).text).toBe(NO_BASELINE);
    expect(releaseOf(methodsOnly).text).toBe(NO_BASELINE);
    expect(releaseOf(noListNoFns).text).toBe(`The analyzer read your files and found no function in them, so this line names no function.${TAIL}`);
  });
});
