/**
 * An analysis that read no file is not a clean one.
 *
 * The analyzer (apps/api/runner/analyzer.py, `analyzer_for`) reads Python
 * (.py) and JavaScript (.js, .jsx) and skips every other file on purpose,
 * TypeScript included. A phase whose files are all ones it skips comes back
 * with `metrics.files === 0`, no issues and a docstring coverage of 1.0 (the
 * analyzer's answer for "no functions"). Drawn as a measurement, that read
 * "0 functions across 0 files, docstrings on 100%" under a "Clean" chip. The
 * review surfaces ask this one question instead and say it was not measured.
 * The score, the criterion's level and the check's status are the API's and
 * are drawn as they came.
 */
import type { AnalyzerReport } from '@learnsdlc/shared';

/** The analysis ran and read no file, so it found nothing because it looked at nothing. */
export function analysisNotMeasured(analysis: AnalyzerReport | null | undefined): boolean {
  return analysis != null && analysis.metrics.files === 0 && analysis.issues.length === 0;
}

/** The chip's word for that case, drawn in the neutral tone. */
export const NOT_MEASURED_WORD = 'Not measured';

/** Why nothing was measured, as one clause the surfaces share. */
export const NOT_MEASURED_REASON = "The analyzer reads Python and JavaScript, and none of this phase's files is one it reads.";

/** The section's purpose line. */
export const NOT_MEASURED_PURPOSE = "Not measured: the analyzer reads Python and JavaScript, and none of this phase's files is one it reads.";

/** The note under the Code quality criterion, whose level stays as the API sent it. */
export const NOT_MEASURED_CRITERION_NOTE =
  'No file in this phase is one the analyzer reads, so nothing was measured for this criterion.';

/**
 * Under that note, where the reviewer marked the criterion met: what the Met
 * rests on. The chip is the reviewer's `criteriaEvidence` entry for this key
 * (its `met`), which the review prompt asks to cite the submitted source, and
 * not the analyzer's reading, which read no file.
 */
export const MET_BY_REVIEWER_NOTE = "Met is the reviewer's reading of the submitted code, not a measurement.";

/** The rubric key the analyzer's reading scores (feedback.service.ts, `scores.set('code_quality', …)`). */
export const CODE_QUALITY_KEY = 'code_quality';
