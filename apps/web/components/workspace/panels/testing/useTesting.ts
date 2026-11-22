'use client';

import { useMemo } from 'react';
import type { MutantRow, SubmissionView } from '@learnsdlc/shared';
import type { PhasePanelProps } from '../types';
import { runsReferenceApplication } from '@/components/workspace/application';
import {
  collectCriteria,
  failingFirst,
  linkMap,
  matrixView,
  parseTests,
  testFiles,
  type Criterion,
  type FirstRecord,
  type MatrixView,
  type TestFn,
} from './lib';

export interface TestingView {
  /** The editable test files this phase declares, in phase order. */
  files: { path: string; language: string }[];
  tests: TestFn[];
  criteria: Criterion[];
  /** test name → criterion id, from the links saved on the phase. */
  linked: Record<string, string>;
  matrix: MutantRow[];
  view: MatrixView;
  first: FirstRecord[];
  /**
   * The clock the submission that produced this matrix was graded at: an ISO
   * date, null for the machine's clock, and `undefined` when the report
   * predates the clock or there is no matrix at all. Every mutant
   * in one report saw this same day, which is what makes two reports
   * comparable or not.
   */
  matrixClock: string | null | undefined;
}

/** The newest verdict that carries a kill matrix, wherever it came from. */
export function latestMatrixSubmission(
  submission: SubmissionView | null,
  submissions: SubmissionView[],
  last: SubmissionView | null,
): SubmissionView | null {
  const holds = (s: SubmissionView | null) => (s?.report?.mutation?.matrix?.length ? s : null);
  for (let i = submissions.length - 1; i >= 0; i -= 1) {
    const m = holds(submissions[i]);
    if (m) return m;
  }
  return holds(submission) ?? holds(last) ?? null;
}

/**
 * Everything the testing panel draws, derived from props alone. Recomputed as
 * the learner types, which is what keeps the picker in step with the file.
 */
export function useTesting({ detail, files, links, runs, submission, submissions }: PhasePanelProps): TestingView {
  return useMemo(() => {
    const read = (path: string) => files[path] ?? detail.files.find((f) => f.path === path)?.content ?? '';
    const declared = testFiles(detail);
    const tests = declared
      .flatMap((f) => parseTests(f.path, read(f.path)))
      .filter((t, i, all) => all.findIndex((o) => o.name === t.name) === i);
    const graded = latestMatrixSubmission(submission, submissions, detail.lastSubmission);
    const matrix = graded?.report?.mutation?.matrix ?? [];
    const stories = detail.files
      .filter((f) => /\.mdx?$/i.test(f.path) && /stor(y|ies)/i.test(f.path))
      .map((f) => ({ path: f.path, text: read(f.path) }));
    // What the learner reads of the phase, as the API serves it: plain text,
    // so `collectCriteria` reads its story lines in their plain form.
    const brief = [
      detail.intro,
      detail.taskPanel,
      ...detail.objectives,
      ...detail.rubric.criteria.map((c) => `${c.title} ${c.description}`),
    ].join('\n');
    return {
      files: declared,
      tests,
      criteria: collectCriteria(stories, matrix, links, brief, { reference: runsReferenceApplication(detail.provenance), prefixes: detail.storyPrefixes }),
      linked: linkMap(links),
      matrix,
      view: matrixView(matrix, tests),
      first: failingFirst(runs, tests),
      matrixClock: graded?.report?.runClock,
    };
  }, [detail, files, links, runs, submission, submissions]);
}
