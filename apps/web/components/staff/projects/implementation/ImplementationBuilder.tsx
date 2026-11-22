'use client';

/**
 * The Implementation phase, built in three steps from the teacher's editor:
 * the brief, the code and the runs that grade it, and the grader's four
 * fixed criteria in the teacher's words. The layout, the queue and
 * the doors are `ExecutableBuilder`'s, shared with Testing.
 */
import type { ComponentProps } from 'react';
import { ExecutableBuilder, type ExecutableBuilderKind } from '../ExecutableBuilder';
import { IMPLEMENTATION_STEP_LABELS, LOCKED_IMPLEMENTATION_KEYS, implementationStepsDone } from './implementation-builder-model';

export { implementationBuilderTask } from './implementation-builder-model';

const IMPLEMENTATION: ExecutableBuilderKind = {
  name: 'Implementation',
  work: { subject: 'The code', verb: 'passes' },
  labels: IMPLEMENTATION_STEP_LABELS,
  prefix: 'tdi',
  testId: 'implementation-builder',
  art: '/artwork/dashboard-implementation-3d.webp',
  runsPurpose: 'What learners start from and what grades it: the starter, the visible tests, the hidden suite and the reference solution.',
  editLabel: 'Edit the code and runs',
  fixed: LOCKED_IMPLEMENTATION_KEYS,
  stepsDone: implementationStepsDone,
  heroLine: 'Three steps, top to bottom: the brief, the code and its runs, and the criteria. The starter files come with the project. The sealed suites come with the upload, or you seal them here at step 2.',
};

export function ImplementationBuilder(props: Omit<ComponentProps<typeof ExecutableBuilder>, 'kind'>) {
  return <ExecutableBuilder kind={IMPLEMENTATION} {...props} />;
}
