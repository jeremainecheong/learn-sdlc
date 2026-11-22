'use client';

import { AI_REVIEW_BUSY_MESSAGE, andList, type AnalyzerIssue, type ArtifactKind, type FeedbackCheck, type FeedbackReport, type PhaseTaskView, type SubmissionView } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Chip, EmptyState, Notice, Stat, StatusSquare } from '@/components/ui';
// One test row, drawn the same way whether it comes back from a run or from a
// submission's report.
import { CaseRow } from './RunPanel';
// What the hints in the reliance figures actually cost, from
// the same module the mentor column reads and the same constants scoreProcess
// subtracts by.
import { PROCESS_CRITERION, relianceCostLine } from '@/lib/hints';
// The words and the test for a task awaiting sign-off.
import { awaitingSignOff, signOffPassLine, type HeldRevision } from './signoff-status';
// What the remaining work opens: the next phase, or on the last phase the way to complete the project.
import { onwardOpens } from './onward-copy';
// What the review runs, beside the time since the server recorded it.
import { ReviewSteps } from './ReviewSteps';
import { ADVICE_LEAD, revisionLead } from '@/components/experience/review-summary';
// Visible, hidden and total, counted and worded once for every card that counts a run's cases.
import { SuiteCountsLine, TEST_CASES_TITLE, suiteCounts } from '@/components/pr/suiteCounts';
// An analysis that read no file, said as not measured rather than as clean.
import {
  CODE_QUALITY_KEY,
  MET_BY_REVIEWER_NOTE,
  NOT_MEASURED_CRITERION_NOTE,
  NOT_MEASURED_PURPOSE,
  NOT_MEASURED_WORD,
  analysisNotMeasured,
} from '@/components/pr/analysisReach';
// The reviewer's [check:<id>] marks, drawn as the report's own check names.
import { citeChecks } from '@/components/pr/checkCitations';
import { providerLabel } from '@/lib/hints';
// A code span drawn as code, a floor of 0 drawn as not required, one list for the checks every criterion shares.
import { withInlineCode } from '@/components/pr/inlineCode';
import { NOT_REQUIRED_WORD, withoutZeroFloor, zeroFloorChecks, type FloorSource } from '@/components/pr/floorZero';
import { SHARED_EVIDENCE_LEAD, sharedEvidence } from '@/components/pr/criteriaEvidence';

type Tone = 'neutral' | 'pass' | 'fail' | 'warn' | 'accent';
type Square = 'pass' | 'fail' | 'warn' | 'now' | 'todo';

const TH = 'label-sm border-b-1.5 border-edge2 pb-1.5 text-left font-medium';
const TD = 'border-b-1.5 border-edge py-2.5 align-top';

function checkSquare(status: FeedbackCheck['status']): Square {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'warning':
      return 'warn';
    default:
      return 'now';
  }
}
function checkTone(status: FeedbackCheck['status']): Tone {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'warning':
      return 'warn';
    default:
      return 'accent';
  }
}
function checkLabel(status: FeedbackCheck['status']): string {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'warning':
      return 'Warning';
    default:
      return 'Note';
  }
}

const severitySquare = (s: AnalyzerIssue['severity']): Square =>
  s === 'error' ? 'fail' : s === 'warning' ? 'warn' : 'now';
const severityTone = (s: AnalyzerIssue['severity']): Tone =>
  s === 'error' ? 'fail' : s === 'warning' ? 'warn' : 'accent';
const severityLabel = (s: AnalyzerIssue['severity']) =>
  s === 'error' ? 'Error' : s === 'warning' ? 'Warning' : 'Info';

function Head({
  title,
  purpose,
  right,
}: {
  title: string;
  purpose?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="h3">{title}</h3>
        {purpose && <p className="purpose">{purpose}</p>}
      </div>
      {right && <span className="shrink-0">{right}</span>}
    </div>
  );
}

/**
 * What a Pass says comes next.
 *
 * "Continue to the next phase" is true of a phase with one task, where the Pass
 * is the phase's. On a phase a teacher has split, a Pass is one task's, and a
 * required sibling still open means there is no Continue at all: so the line
 * says which required tasks are left. The task this verdict is about is taken
 * as passed whatever the held list says, because the list can be a moment
 * behind the verdict that just landed.
 *
 * A task the teacher must countersign is not passed by
 * its Pass: it waits, `submitted` with `awaitingSignOff`, and the next phase
 * stays shut. On that task (the verdict's, or the phase's one task) the line
 * says the work passed and that the countersignature opens the next phase,
 * never "Continue". Every other phase reads as described above.
 *
 * A sibling that passed its review and waits on the countersignature is not
 * "still open": naming it as open invites a resubmit that costs a review, and a
 * failed one takes the learner out of the teacher's sign-off queue. With every
 * required sibling passed or waiting and one waiting, the countersignature is
 * what opens the next phase. `latest` is the revision this verdict is, for the
 * moment it lands before the task list has caught up (see `awaitingSignOff`).
 * On the project's last phase (`isLast`) there is no next phase: the sign-off
 * words say the countersignature passes it and the project can then be
 * completed, and every other line says the project can be completed
 * where it said the next phase opens (`onwardOpens`).
 *
 * The plain Pass (one task, nothing waiting) says only that the evidence is
 * accepted: the gate band above the review already says how to
 * continue ("Ready to continue … Continue when ready"), on the last phase too.
 */
export function passedLine(
  tasks: readonly PhaseTaskView[] | undefined,
  taskKey: string | undefined,
  latest?: HeldRevision | null,
  isLast = false,
): string {
  const all = 'All required evidence accepted.';
  const onward = onwardOpens(isLast);
  const signing = awaitingSignOff({ tasks }, taskKey, latest);
  const signOff = signOffPassLine(isLast);
  if (!tasks || tasks.length < 2) return signing ? signOff : all;
  const siblings = tasks.filter((task) => task.required && task.key !== taskKey && task.status !== 'passed');
  const waiting = siblings.filter((task) => awaitingSignOff({ tasks }, task.key));
  const open = siblings.filter((task) => !waiting.includes(task)).sort((a, b) => a.order - b.order);
  if (open.length === 0) return signing || waiting.length > 0 ? signOff : all;
  const names = open.map((task) => task.title);
  const list = andList(names);
  if (signing) {
    return open.length === 1
      ? `This task passed review and waits for your teacher's countersignature. One required task in this phase is still open: ${list}. ${onward} once it passes and your teacher has countersigned.`
      : `This task passed review and waits for your teacher's countersignature. ${open.length} required tasks in this phase are still open: ${list}. ${onward} once they pass and your teacher has countersigned.`;
  }
  return open.length === 1
    ? `This task's evidence is accepted. One required task in this phase is still open: ${list}. ${onward} once it passes.`
    : `This task's evidence is accepted. ${open.length} required tasks in this phase are still open: ${list}. ${onward} once they pass.`;
}

/**
 * What the check table is about.
 *
 * A written phase's checks are rules read against the document, nothing is
 * run, and no sandbox is involved, so the heading only names the sandbox
 * where the report carries something that ran in one.
 */
export function checksPurpose(report: FeedbackReport): string {
  const ran = Boolean(
    report.tests || report.mutation || report.staticAnalysis || report.ci || report.drill || report.contract || report.impact,
  );
  return ran ? 'What ran on this submission, in the sandbox.' : 'What was checked on this submission.';
}

/**
 * The unavailable verdict's one line. A review the AI's queue turned away (the
 * API's exact AI_REVIEW_BUSY_MESSAGE) was the class's load, so it says the
 * reviewer was busy rather than blaming the provider; every other assessment
 * error keeps the provider sentence. No Pass either way.
 */
function unavailableLine(assessmentError: string): string {
  return assessmentError === AI_REVIEW_BUSY_MESSAGE
    ? 'The AI reviewer is busy with the rest of the class. No Pass was awarded. Resubmit in a minute.'
    : 'The AI review could not complete. No Pass was awarded. Retry when the provider is available.';
}

function Verdict({
  report,
  tasks,
  taskKey,
  latest,
  isLast,
}: {
  report: FeedbackReport;
  tasks?: readonly PhaseTaskView[];
  taskKey?: string;
  latest?: HeldRevision;
  isLast?: boolean;
}) {
  const unavailable = Boolean(report.aiReview.assessmentError);
  const passed = report.passed && !report.aiReview.assessmentError;
  return (
    <section
      className={`rounded-panel border-1.5 border-edge px-4 py-3.5 ${
        unavailable ? 'bg-surface2' : passed ? 'bg-passtint' : 'bg-failtint'
      }`}
      data-testid="feedback-verdict"
    >
      <div className="flex items-start gap-3">
        <span className="pt-[5px]">
          <StatusSquare state={unavailable ? 'warn' : passed ? 'pass' : 'fail'} size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            {unavailable ? 'Review unavailable' : passed ? 'Pass' : 'Needs revision'}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink2">
            {report.aiReview.assessmentError ? unavailableLine(report.aiReview.assessmentError) : passed ? passedLine(tasks, taskKey, latest, isLast) : 'Address the specific evidence gaps below, revise, and resubmit. Earlier reviews stay in your history.'}
          </p>
        </div>
      </div>
    </section>
  );
}

/** A criterion's or the shared list's evidence lines. */
function EvidenceList({ lines, testId }: { lines: readonly string[]; testId?: string }) {
  return (
    <ul className="mt-1 space-y-1" data-testid={testId}>
      {lines.map((line, i) => (
        <li key={i} className="text-[12px] leading-relaxed text-muted">
          {withInlineCode(line)}
        </li>
      ))}
    </ul>
  );
}

function Criteria({ report, zero }: { report: FeedbackReport; zero: ReadonlySet<string> }) {
  // The same reading `Verdict` makes: a criterion the reviewer left unmet on a
  // report the gate passed at a rule-based 100 is advice, not revision work.
  const passed = report.passed && !report.aiReview.assessmentError;
  // The Code quality row says when the analyzer read no file; its level chip is the API's.
  const unmeasured = analysisNotMeasured(report.staticAnalysis);
  // A rule the teacher set to 0 is not listed as done, and checks every criterion shares are listed once.
  const lists = report.criteria.map((c) => withoutZeroFloor(c.evidence, report.checks, zero));
  const shared = sharedEvidence(lists);
  return (
    <section>
      <Head
        title="Criteria"
        purpose={passed && report.aiReview.criteriaEvidence?.some((item) => !item.met)
          ? 'Every required check passed, so this work passed. A criterion the reviewer left unmet is advice for your next revision, not a condition of this Pass.'
          : 'Every required criterion must be supported by correct evidence. There is no numerical pass threshold.'}
      />
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Criterion
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Evidence
            </th>
          </tr>
        </thead>
        <tbody>
          {report.criteria.map((c, index) => {
            const finding = report.aiReview.criteriaEvidence?.find(item => item.key === c.key);
            const ok = finding?.met === true && !report.aiReview.assessmentError;
            const lines = shared ? [] : lists[index];
            return (
              <tr key={c.key}>
                <td className={`${TD} pr-3`}>
                  <div className="flex items-start gap-2">
                    <span className="pt-[3px]">
                      <StatusSquare state={ok ? 'pass' : 'warn'} size={11} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold leading-snug text-ink">{c.title}</p>
                      {lines.length > 0 && <EvidenceList lines={lines} />}
                      {unmeasured && c.key === CODE_QUALITY_KEY && (
                        <p className="mt-1 text-[12px] leading-relaxed text-muted" data-testid="criterion-not-measured">
                          {NOT_MEASURED_CRITERION_NOTE}
                        </p>
                      )}
                      {/* Beside "Not measured", what a Met rests on, with the reviewer's own evidence for it. */}
                      {unmeasured && c.key === CODE_QUALITY_KEY && ok && (
                        <p className="mt-1 text-[12px] leading-relaxed text-muted" data-testid="criterion-met-by-reviewer">
                          {MET_BY_REVIEWER_NOTE}
                          {finding?.evidence ? <> The reviewer wrote: {citeChecks(finding.evidence, report.checks)}</> : null}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className={`${TD} text-right`}>
                  <Chip tone={ok ? 'pass' : 'warn'}>{ok ? 'Met' : finding && !report.aiReview.assessmentError ? (passed ? 'Advice' : 'Needs revision') : 'Review evidence'}</Chip>{finding?.issue && <p className="purpose mt-2">{citeChecks(finding.issue, report.checks)}</p>}{finding?.nextStep && <p className="purpose mt-1">Next: {citeChecks(finding.nextStep, report.checks)}</p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shared && (
        <div className="mt-2.5">
          <p className="text-[12.5px] font-semibold text-ink">{SHARED_EVIDENCE_LEAD}</p>
          <EvidenceList lines={shared} testId="criteria-shared-evidence" />
        </div>
      )}
    </section>
  );
}

function Checks({ report, zero }: { report: FeedbackReport; zero: ReadonlySet<string> }) {
  // An analysis that read no file found nothing because it looked at nothing:
  // its row reads Not measured in the neutral tone, as the Static analysis
  // section below it does. The check's status is the API's and is not changed.
  const unmeasured = analysisNotMeasured(report.staticAnalysis);
  return (
    <section>
      <Head title="Checks" purpose={checksPurpose(report)} />
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Check
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((check) => {
            const notMeasured = unmeasured && check.id === 'static-analysis';
            // A rule whose floor is 0 passes whatever the record holds; it is not drawn as done.
            const notRequired = zero.has(check.id) && check.status === 'passed';
            return (
            <tr key={check.id}>
              <td className={`${TD} pr-3`}>
                <div className="flex items-start gap-2">
                  <span className="pt-[3px]">
                    <StatusSquare state={notMeasured || notRequired ? 'todo' : checkSquare(check.status)} size={11} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold leading-snug text-ink">{check.label}</p>
                    {check.status !== 'passed' && check.detail && (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{withInlineCode(check.detail)}</p>
                    )}
                  </div>
                </div>
              </td>
              <td className={`${TD} text-right`}>
                {notMeasured ? <Chip>{NOT_MEASURED_WORD}</Chip> : notRequired ? <Chip testId="check-not-required">{NOT_REQUIRED_WORD}</Chip> : <Chip tone={checkTone(check.status)}>{checkLabel(check.status)}</Chip>}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function HiddenSuite({ tests }: { tests: NonNullable<FeedbackReport['tests']> }) {
  // A count of hidden failures tells the learner nothing about what to fix;
  // the case names and assertion messages do. The run holds both suites, so
  // the card is titled for both and says visible, hidden and total apart,
  // in the words the review's Checks tab uses.
  const failed = tests.cases.filter((tc) => tc.status !== 'passed');
  const counts = suiteCounts(tests);
  return (
    <section data-testid="hidden-suite">
      <Head
        title={TEST_CASES_TITLE}
        purpose={
          failed.length > 0
            ? 'The cases that did not pass, by name. Fix these before you resubmit.'
            : `All ${counts.total.total} cases pass.`
        }
        right={
          <Chip tone={failed.length > 0 ? 'fail' : 'pass'}>
            {counts.total.passed} of {counts.total.total}
          </Chip>
        }
      />
      <SuiteCountsLine counts={counts} className="-mt-1 mb-2.5" />
      {failed.length > 0 && (
        <table className="w-full border-collapse" data-testid="failed-cases">
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Test
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {failed.map((tc) => (
              <CaseRow key={`${tc.name}:${String(tc.hidden)}`} {...tc} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Mutation({ mutation }: { mutation: NonNullable<FeedbackReport['mutation']> }) {
  const all = mutation.killed === mutation.total;
  return (
    <section data-testid="mutation-report">
      <Head
        title="Planted bugs"
        purpose="Bugs were planted in the code and your suite was run against each. A suite that catches them would catch a real regression."
        right={
          <Chip tone={all ? 'pass' : 'warn'}>
            {mutation.killed}/{mutation.total} killed
          </Chip>
        }
      />
      <p className="text-[13px] leading-relaxed text-ink2">
        <span className="font-semibold text-ink">
          {mutation.killed}/{mutation.total}
        </span>{' '}
        planted bug{mutation.total === 1 ? '' : 's'} killed by your tests.
      </p>
      {mutation.survivors.length > 0 && (
        <ul className="mt-2.5 space-y-2">
          {mutation.survivors.map((s) => (
            <li key={s.name} className="flex items-start gap-2">
              <span className="pt-[3px]">
                <StatusSquare state="warn" size={11} />
              </span>
              <span className="text-[13px] leading-relaxed text-ink2">Survived: {s.description}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StaticAnalysis({ analysis }: { analysis: NonNullable<FeedbackReport['staticAnalysis']> }) {
  const { issues, metrics } = analysis;
  // No file read is not a clean reading; see analysisReach.ts.
  if (analysisNotMeasured(analysis)) {
    return (
      <section data-testid="static-analysis">
        <Head title="Static analysis" purpose={NOT_MEASURED_PURPOSE} right={<Chip>{NOT_MEASURED_WORD}</Chip>} />
      </section>
    );
  }
  return (
    <section data-testid="static-analysis">
      <Head
        title="Static analysis"
        purpose={`${metrics.functions} functions across ${metrics.files} files, ${metrics.todosRemaining} to do, complexity up to ${metrics.maxComplexity}, docstrings on ${Math.round(metrics.docstringCoverage * 100)}%.`}
        right={
          <Chip tone={issues.some((i) => i.severity === 'error') ? 'fail' : issues.length ? 'warn' : 'pass'}>
            {issues.length === 0 ? 'Clean' : issues.length === 1 ? '1 finding' : `${issues.length} findings`}
          </Chip>
        }
      />
      {issues.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Finding
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Severity
              </th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, i) => (
              <tr key={`${issue.path}:${issue.line}:${issue.rule}:${i}`}>
                <td className={`${TD} pr-3`}>
                  <div className="flex items-start gap-2">
                    <span className="pt-[3px]">
                      <StatusSquare state={severitySquare(issue.severity)} size={11} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] leading-snug text-ink">{issue.message}</p>
                      <p className="mt-0.5 break-all font-mono text-[11.5px] text-muted">
                        {issue.path}, line {issue.line}
                        {issue.rule ? ` (${issue.rule})` : ''}
                      </p>
                    </div>
                  </div>
                </td>
                <td className={`${TD} text-right`}>
                  <Chip tone={severityTone(issue.severity)}>{severityLabel(issue.severity)}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Who wrote this review, in words rather than in the enum member.
 *
 * `provider` is a machine value everywhere else, and drawn straight onto the
 * screen it would mislead, because quizzes use `'not-applicable'`: a value
 * that does not mean a provider at all, but *no model was needed*: a
 * multiple-choice paper is marked by set equality against the key the teacher
 * sealed, with no token spent and no guardrail consulted. It is deliberately
 * not `'unavailable'`, which means a model was asked and did not answer and
 * which draws the degraded-grading banner; the two are different facts and
 * this is the half of that difference a learner reads.
 *
 * Every other value is said as "Reviewed by" and the provider's name;
 * a report with no provider draws an empty chip.
 */
function reviewProviderWords(provider: string | undefined): string {
  // A report that names no provider (one stored before it was recorded) names none here either.
  if (!provider?.trim()) return '';
  if (provider === 'not-applicable') return 'Marked by the key';
  // A bare provider id ("openai") would read as a machine value. It is said as a labelled fact, in the name the
  // mentor's reply label already gives it (`providerLabel`: "OpenAI"); a review no model answered says that instead.
  if (provider === 'unavailable' || provider === 'none') return 'No model answered';
  return `Reviewed by ${providerLabel(provider)}`;
}

/** What produced this review, said under the heading. */
function reviewPurpose(provider: string): string {
  return provider === 'not-applicable'
    ? 'Your answers, marked against the key your teacher set. No model was asked.'
    : 'Written by the phase mentor from your artefact and the checks above.';
}

function Review({ review, passed, report }: { review: FeedbackReport['aiReview']; passed: boolean; report: FeedbackReport }) {
  // Why a review at a rule-based 100 still needs revision, in one line before the reviewer's own.
  const lead = passed && review.verdict === 'needs_revision' ? ADVICE_LEAD : revisionLead(report);
  return (
    <section data-testid="ai-review">
      <div className="mb-2.5 flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl border-1.5 border-edge bg-raised text-accent">
          <Icon name="hint" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <Head
            title="Review"
            purpose={reviewPurpose(review.provider)}
            right={<Chip>{reviewProviderWords(review.provider)}</Chip>}
          />
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-ink2">{lead ? `${lead} ${citeChecks(review.summary, report.checks)}` : citeChecks(review.summary, report.checks)}</p>
      {review.strengths.length > 0 && (
        <div className="mt-4">
          <p className="text-[12.5px] font-semibold text-ink">Strengths</p>
          <ul className="mt-1.5 space-y-1.5">
            {review.strengths.map((s) => (
              <li key={s} className="flex items-start gap-2">
                <span className="pt-[3px]">
                  <StatusSquare state="pass" size={10} />
                </span>
                <span className="text-[13px] leading-relaxed text-ink2">{citeChecks(s, report.checks)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.improvements.length > 0 && (
        <div className="mt-4">
          <p className="text-[12.5px] font-semibold text-ink">Improvements</p>
          <ul className="mt-1.5 space-y-1.5">
            {review.improvements.map((s) => (
              <li key={s} className="flex items-start gap-2">
                <span className="pt-[3px]">
                  <StatusSquare state="warn" size={10} />
                </span>
                <span className="text-[13px] leading-relaxed text-ink2">{citeChecks(s, report.checks)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.processNote && (
        <div className="mt-4 border-t-1.5 border-edge pt-3">
          <p className="text-[12.5px] font-semibold text-ink">Process note</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink2">{citeChecks(review.processNote, report.checks)}</p>
        </div>
      )}
    </section>
  );
}

/**
 * The mentor tile. `aiReliance.hintsThisPhase` is the grader's `hintsForPhase`: the learner's
 * Guided messages in the phase, never an Agentic proposal, so the tile names it in the words the
 * process criterion's evidence uses ("Guided hints this phase"). That evidence carries the Agentic
 * sentence (`mentorUseSentences` in the API) only on the phases whose grader writes a `process`
 * criterion (the code grader, where the phase's rubric names `process`); there it is shown here too. Elsewhere the report holds
 * no Agentic count, so the tile says it does not count them rather than imply there were none.
 */
function Reliance({ report }: { report: FeedbackReport }) {
  const count = report.aiReliance.hintsThisPhase;
  const agentic = report.criteria
    .find((c) => c.key === PROCESS_CRITERION)
    ?.evidence.find((line) => /\bAgentic proposals?\b/.test(line));
  return (
    <section data-testid="reliance-note">
      <Head title="Mentor activity" purpose="Guided hints are learning activity. They do not change the evidence needed for a Pass." />
      <Stat value={String(count)} label={count === 1 ? 'Guided hint this phase' : 'Guided hints this phase'} />
      {agentic ? (
        <p className="mt-2 text-[13px] leading-relaxed text-ink2" data-testid="reliance-agentic">{agentic}</p>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-muted" data-testid="reliance-agentic">Agentic proposals are not counted here.</p>
      )}
    </section>
  );
}

export function FeedbackPanel({
  submission,
  tasks,
  kind,
  isLast = false,
  floors,
}: {
  submission: SubmissionView | null;
  /** The phase's checks kind, so the wait can name what the review runs. Left out, only the time is drawn. */
  kind?: ArtifactKind;
  /**
   * The phase's tasks, where the room holds them, so a Pass on one task of a
   * split phase can say what is left rather than promise a Continue.
   */
  tasks?: readonly PhaseTaskView[];
  /** The phase is the project's last (`isLastPhase`), so no next phase follows its Pass. */
  isLast?: boolean;
  /**
   * The phase's floors (`PhaseDetail.story`, `.design`, `.runbook`, `.change`), so a rule the teacher set to 0 is
   * drawn as not required rather than as done (`zeroFloorChecks`). Left out, every rule is drawn as the report has it.
   */
  floors?: FloorSource;
}) {
  if (!submission) {
    return (
      <div className="px-4 py-4" data-testid="feedback-empty">
        <EmptyState
          icon="pr"
          title="No pull request yet"
          body="Opening a pull request runs static analysis, the test suites and the mentor's rubric review, and reports on both your work and your process."
        />
      </div>
    );
  }
  if (submission.status !== 'completed' || !submission.report) {
    return (
      <div className="px-4 py-4" data-testid="feedback-pending">
        {submission.status === 'failed' ? (
          <Notice tone="fail">{submission.error || 'The review failed to run. Submit again.'}</Notice>
        ) : submission.status === 'completed' ? (
          <Notice tone="warn">Review unavailable. The completed submission has no retained evidence report. Return to the project to request another review.</Notice>
        ) : (
          <>
            <p className="flex items-center gap-2 text-[13.5px] text-muted">
              <Icon name="clock" size={15} className="text-accent" />
              {/* Every phase has a submission; only the code phases have a pull
                  request. */}
              Reviewing your submission…
            </p>
            <ReviewSteps kind={kind} status={submission.status} since={submission.createdAt} />
            {/* The report's shape, drawn while it is written: the verdict, then two sections. */}
            <div className="feedback-skeleton mt-5 space-y-3" aria-hidden="true">
              <div className="skeleton h-[60px] w-full" />
              <div className="skeleton h-3 w-2/5" />
              <div className="skeleton h-3 w-4/5" />
              <div className="skeleton h-3 w-3/5" />
            </div>
          </>
        )}
      </div>
    );
  }

  const report = submission.report;
  const zero = zeroFloorChecks(floors);
  const integrity = report.integrity;
  const flagged =
    integrity && (integrity.relianceFlag || integrity.mentorPasteFlag || integrity.noEffortFlag);

  return (
    <div className="space-y-7 px-4 py-4 pb-10" aria-live="polite" data-testid="feedback-report">
      <Verdict report={report} tasks={tasks} taskKey={submission.taskKey} latest={submission} isLast={isLast} />
      <Criteria report={report} zero={zero} />
      <Checks report={report} zero={zero} />
      {report.tests && <HiddenSuite tests={report.tests} />}
      {report.mutation && <Mutation mutation={report.mutation} />}
      {report.staticAnalysis && <StaticAnalysis analysis={report.staticAnalysis} />}
      <Review review={report.aiReview} passed={report.passed && !report.aiReview.assessmentError} report={report} />
      <Reliance report={report} />
      {flagged && (
        <Notice tone="warn" testId="integrity-note">
          <span className="font-semibold">Integrity signals.</span> {integrity.note}
        </Notice>
      )}
    </div>
  );
}
