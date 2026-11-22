'use client';

/**
 * The Testing phase, built in three steps from the teacher's editor: the
 * brief, the tests and the runs that grade them, and the grader's three
 * fixed criteria in the teacher's words. The layout, the queue and
 * the doors are `ExecutableBuilder`'s, shared with Implementation.
 */
import type { ComponentProps } from 'react';
import { ExecutableBuilder, type ExecutableBuilderKind } from '../ExecutableBuilder';
import { LOCKED_TESTING_KEYS, TESTING_STEP_LABELS, testingStepsDone } from './testing-builder-model';

export { testingBuilderTask } from './testing-builder-model';

const TESTING: ExecutableBuilderKind = {
  name: 'Testing',
  work: { subject: 'The tests', verb: 'pass' },
  labels: TESTING_STEP_LABELS,
  prefix: 'tdt',
  testId: 'testing-builder',
  art: '/artwork/dashboard-testing-3d.webp',
  runsPurpose: 'What learners test and what grades their tests: the runs, the reference suite, the reference implementation and the mutants.',
  editLabel: 'Edit the tests and runs',
  fixed: LOCKED_TESTING_KEYS,
  stepsDone: testingStepsDone,
  heroLine: 'Three steps, top to bottom: the brief, the tests and their runs, and the criteria. The starter files come with the project. The sealed suites come with the upload, or you seal them here at step 2.',
};

export function TestingBuilder(props: Omit<ComponentProps<typeof ExecutableBuilder>, 'kind'>) {
  return <ExecutableBuilder kind={TESTING} {...props} />;
}
