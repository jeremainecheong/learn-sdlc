import { citeChecks } from '@/components/pr/checkCitations';

/** Said before the reviewer's own sentence when it asks for revision under a Pass. */
export const ADVICE_LEAD = "Reviewer's advice on this passed work:";

/** The report fields `revisionLead` reads. */
type LeadReport = {
  passed?: boolean;
  overall?: number;
  checks?: ReadonlyArray<{ id: string; status: string; label?: string }>;
  aiReview?: { verdict?: string; assessmentError?: string; criteriaEvidence?: ReadonlyArray<{ met: boolean }> };
};

/**
 * Said before the reviewer's own sentence when a completed review needs
 * revision although every rule check passed at a rule-based 100: the
 * reviewer found most criteria unmet, which still gates. Without it the panel
 * would draw Needs revision beside a column of passed checks and say nothing of
 * why. Null for every other report:
 * a Pass (whose lead is `ADVICE_LEAD`), an unavailable review, or a report
 * where a rule check itself failed and says so in its own row.
 */
export function revisionLead(report: LeadReport | null | undefined): string | null {
  if (!report || report.passed !== false || report.overall !== 100) return null;
  const review = report.aiReview;
  if (!review || review.assessmentError || review.verdict !== 'needs_revision') return null;
  const rules = (report.checks ?? []).filter((check) => check.id !== 'process');
  if (!rules.length || !rules.every((check) => check.status === 'passed' || check.status === 'info')) return null;
  const evidence = review.criteriaEvidence ?? [];
  const unmet = evidence.filter((item) => item.met !== true).length;
  if (!unmet) return null;
  return `Every rule check passed; the reviewer found ${unmet} of ${evidence.length} criteria unmet, so this work needs revision:`;
}

/**
 * The review's one-line summary, in the voice of whoever is reading.
 *
 * A quiz's summary is written for the learner ("Scored against the key your
 * teacher sealed…") and the API stores it on the report. A teacher reading the
 * same paper would be addressed as the learner, about themselves in the third
 * person, so their view says it in their own terms. Everything else is the
 * stored sentence, unchanged.
 */
export function reviewSummary(
  report: ({ quiz?: unknown; aiReview?: { summary?: string; verdict?: string } } & LeadReport) | null | undefined,
  teacher: boolean,
  passed: boolean | null | undefined,
): string {
  // The reviewer's [check:<id>] marks, drawn as the report's own check names.
  const stored = citeChecks(report?.aiReview?.summary ?? '', report?.checks);
  // A report the gate passed at a rule-based 100 keeps the reviewer's own
  // sentence, which may still ask for revision; said under a Pass it is advice,
  // and the sentence says so rather than contradicting the verdict above it.
  if (report?.passed === true && report.aiReview?.verdict === 'needs_revision') {
    return `${ADVICE_LEAD} ${stored}`.trim();
  }
  // The other side of the same rule: every rule check passed and the review still needs revision.
  const lead = revisionLead(report);
  if (lead) return `${lead} ${stored}`.trim();
  if (!teacher || !report?.quiz) return stored;
  return passed
    ? 'Scored against the key sealed with this quiz. No model was asked: a multiple-choice answer is right or wrong by the key.'
    : 'Scored against the key sealed with this quiz. This paper is below the pass mark. No model was asked: a multiple-choice answer is right or wrong by the key.';
}
