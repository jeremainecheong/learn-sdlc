/**
 * The AI reviewer cites recorded checks as `[check:<id>]` and the web printed
 * them raw: "[check:visible-tests] passed with 1/1 tests, and
 * [check:hidden-tests] passed with 4/4 cases." citeChecks draws each mark the
 * same report holds as that check's label, verbatim (labels are names starting
 * with a capital, so no casing changes at a sentence start or inside one); an
 * id the report does not hold stays as written; other brackets and text with
 * no mark come back unchanged. Wired into the IDE Review tab (summary,
 * strengths, improvements, process note, criterion issue and next step), the
 * feedback page, the teacher's evidence view (SubmissionEvidence and
 * reviewSummary) and the home page's next step (home/derive.ts).
 */
import { describe, expect, it } from 'vitest';
import { moduleText } from './support/source-text';
import { citeChecks } from '@/components/pr/checkCitations';
import { reviewSummary } from '@/components/experience/review-summary';

const CHECKS = [
  { id: 'visible-tests', label: 'Visible test suite', status: 'passed' },
  { id: 'hidden-tests', label: 'Hidden test suite (edge cases)', status: 'passed' },
];

describe('citeChecks', () => {
  it('draws a known id as the check label', () => {
    expect(citeChecks('So [check:visible-tests] passed.', CHECKS)).toBe('So Visible test suite passed.');
  });
  it('leaves an unknown id exactly as written', () => {
    expect(citeChecks('See [check:static-analysis] here.', CHECKS)).toBe('See [check:static-analysis] here.');
  });
  it('draws several marks in one sentence, and a mark at the start reads as a capitalised sentence', () => {
    expect(citeChecks('[check:visible-tests] passed with 1/1 tests, and [check:hidden-tests] passed with 4/4 cases.', CHECKS)).toBe(
      'Visible test suite passed with 1/1 tests, and Hidden test suite (edge cases) passed with 4/4 cases.',
    );
  });
  it('returns text with no mark, and other bracketed text, unchanged', () => {
    const plain = 'Nothing cited here [see notes] and [check: spaced].';
    expect(citeChecks(plain, CHECKS)).toBe(plain);
    expect(citeChecks('', CHECKS)).toBe('');
    expect(citeChecks('[check:visible-tests]', undefined)).toBe('[check:visible-tests]');
  });
});

describe('the surfaces that print the reviewer prose', () => {
  it('reviewSummary draws the marks from the same report', () => {
    const report = { passed: true, overall: 100, checks: CHECKS, aiReview: { verdict: 'pass', summary: '[check:hidden-tests] passed.' } };
    expect(reviewSummary(report, false, true)).toBe('Hidden test suite (edge cases) passed.');
  });
  it('every surface reads the prose through citeChecks', () => {
    // Each surface's own module, found by what it exports, so a moved file is still read.
    const panel = moduleText('FeedbackPanel');
    for (const field of ['review.summary', 'review.processNote', 'finding.issue', 'finding.nextStep']) {
      expect(panel).toContain(`citeChecks(${field}, report.checks)`);
    }
    expect(panel.match(/citeChecks\(s, report\.checks\)/g)?.length).toBe(2);
    const evidence = moduleText('SubmissionEvidence');
    for (const field of ['finding.evidence', 'finding.issue', 'finding.nextStep', 'step']) {
      expect(evidence).toContain(`citeChecks(${field}, report.checks)`);
    }
    expect(moduleText('buildNextSteps')).toContain('citeChecks(report.aiReview?.improvements?.[0]');
  });
});
