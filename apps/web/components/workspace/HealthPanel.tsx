'use client';

import { useMemo } from 'react';
import type { AnalyzerReport, SubmissionView } from '@learnsdlc/shared';
import { HealthTrend } from '@/components/charts/HealthTrend';
import { CellTitle, Chip, EmptyState, Notice, Readout, Table } from '@/components/ui';
import {
  analyzerUnavailable,
  deltaWord,
  healthFindings,
  healthMetrics,
  healthTrend,
  trendWaitLine,
  trendSentence,
  HEALTH_WORD,
} from './ide/health';
// An analysis that read no file, said as not measured rather than as clean.
import { NOT_MEASURED_REASON, NOT_MEASURED_WORD, analysisNotMeasured } from '@/components/pr/analysisReach';

/**
 * Code health under the code: what the analyzer found in the
 * revision that was graded, the four numbers the rubric reads, how each moved
 * since the revision before, and every finding as a place you can press.
 *
 * Everything here is a fact about one revision, not about the buffer. When the
 * learner has saved since that verdict the findings still list, they happened,
 * but the notice at the top says they describe older code, and the underlines
 * in the editor are down.
 */
export function HealthPanel({
  analysis,
  submissions,
  attempt,
  stale,
  onOpen,
}: {
  /** The newest verdict's analyzer report, or undefined. */
  analysis?: AnalyzerReport;
  /** Every revision, for the trend. */
  submissions: SubmissionView[];
  /** Which revision `analysis` came from. */
  attempt?: number;
  /** The workspace has been saved since that verdict. */
  stale: boolean;
  onOpen: (path: string, line: number) => void;
}) {
  const findings = useMemo(() => healthFindings(analysis), [analysis]);
  const metrics = useMemo(() => healthMetrics(analysis), [analysis]);
  const points = useMemo(() => healthTrend(submissions), [submissions]);
  const down = analyzerUnavailable(analysis);
  // A report that read no file (TypeScript-only phases) found nothing because it looked at nothing.
  const notMeasured = analysisNotMeasured(analysis);

  // The revision before this one that the analyzer did run on, which is what a
  // delta is against. Not "the previous revision": a gap in the analysis is not
  // a change in the code.
  const before = points.length > 1 ? points[points.length - 2] : undefined;

  if (!analysis) {
    return (
      <div className="px-3.5 py-2.5" data-testid="health-panel">
        <EmptyState
          testId="health-empty"
          title={attempt ? 'No health on this revision' : 'No health yet'}
          body={
            attempt
              ? `Submission ${attempt} was graded before the analyzer ran. Submit again and the health arrives with the verdict.`
              : 'The analyzer runs with the verdict. Submit, or press ⌘↵, to see what it found in your files.'
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5 px-3.5 py-3" data-testid="health-panel">
      <p className="purpose" data-testid="health-source">
        {/* analyzer.py reads .py, .js and .jsx; every other file is skipped. */}
        {attempt ? `From submission ${attempt}.` : 'From your last submission.'} The analyzer reads
        the Python and JavaScript files you can edit.
      </p>

      {stale && (
        <Notice tone="info" testId="health-stale">
          Edited since {attempt ? `submission ${attempt}` : 'that submission'}. Submit again to
          refresh the health of these files.
        </Notice>
      )}

      {down ? (
        <Notice tone="warn" testId="health-unavailable">
          Static analysis could not run for this revision. Submit again.
        </Notice>
      ) : notMeasured ? (
        /* The analysis read no file, so a score of 100, docstrings
           on 100% and "Nothing to fix" would be measurements of nothing. The
           readout says so, with the reason, and draws no figure. */
        <div className="flex min-w-0 flex-col gap-1" data-testid="health-not-measured">
          <Readout testId="health-quality" value={NOT_MEASURED_WORD} label="Code quality" size={30} />
          <p className="purpose">{NOT_MEASURED_REASON}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Readout
                testId="health-quality"
                value={metrics?.quality ?? 0}
                unit="of 100"
                label="Code quality"
                size={30}
                tone={
                  (metrics?.quality ?? 0) >= 70 ? 'pass' : (metrics?.quality ?? 0) >= 40 ? 'warn' : 'fail'
                }
              />
              <p className="purpose">Each error costs 25, each warning 10, each note 2.</p>
            </div>
            <Metric
              testId="health-complexity"
              value={metrics?.complexity ?? 0}
              label="Highest complexity"
              delta={deltaWord(metrics?.complexity ?? 0, before?.complexity)}
            />
            <Metric
              testId="health-docstrings"
              value={`${metrics?.docstrings ?? 0}%`}
              label="Docstrings"
              delta={deltaWord(metrics?.docstrings ?? 0, before?.docstrings, '%')}
            />
            <Metric
              testId="health-todos"
              value={metrics?.todos ?? 0}
              label="TODOs left"
              delta={deltaWord(metrics?.todos ?? 0, before?.todos)}
            />
          </div>

          <div className="flex flex-col gap-2" data-testid="health-findings">
            {findings.length === 0 ? (
              <p className="label">Nothing to fix. The analyzer found no findings in your files.</p>
            ) : (
              <Table
                cols={[
                  { label: 'Finding', width: '1fr' },
                  { label: 'Rule', width: 'auto', align: 'right' },
                ]}
                minWidth={340}
                rows={findings.map((f) => [
                  <button
                    key={`${f.rule}-${f.path}-${f.line}`}
                    type="button"
                    onClick={() => onOpen(f.path, f.line)}
                    className="min-w-0 flex-1 text-left hover:underline"
                    data-testid={`health-finding-${f.rule}-${f.line}`}
                  >
                    <CellTitle
                      state={f.state}
                      title={f.message}
                      detail={<span className="mono">{f.where}</span>}
                    />
                  </button>,
                  <Chip key={`${f.rule}-${f.line}-c`} tone={f.severity === 'error' ? 'fail' : f.severity === 'warning' ? 'warn' : 'neutral'}>
                    {HEALTH_WORD[f.severity]}
                  </Chip>,
                ])}
              />
            )}
          </div>

          {points.length < 2 ? (
            <p className="purpose" data-testid="health-trend-sentence">
              {trendWaitLine(submissions.filter((s) => s.report).length)}
            </p>
          ) : (
            <HealthTrend points={points} sentence={trendSentence(points)} />
          )}
        </>
      )}
    </div>
  );
}

/** A readout with the word for how it moved since the revision before. */
function Metric({
  value,
  label,
  delta,
  testId,
}: {
  value: React.ReactNode;
  label: string;
  delta: string | null;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Readout testId={testId} value={value} label={label} size={30} />
      {/* Words, not arrows with a colour: "down 2" is good news under
          complexity and bad news under docstrings, and one glyph cannot say
          both. The direction is stated and the tone is left alone. */}
      {delta && <span className="purpose">{delta} since the revision before</span>}
    </div>
  );
}
