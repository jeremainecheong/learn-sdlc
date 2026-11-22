import type { PhaseKey } from '@learnsdlc/shared';
import type { Lesson } from './content/types';
import { REQUIREMENTS_LESSON } from './content/requirements';
import { DESIGN_LESSON } from './content/design';
import { IMPLEMENTATION_LESSON } from './content/implementation';
import { TESTING_LESSON } from './content/testing';
import { DEPLOYMENT_LESSON } from './content/deployment';
import { MAINTENANCE_LESSON } from './content/maintenance';

/* The six guides' words live one module per phase under content/, so
 * each phase can be edited without touching another's file. This index keeps
 * the exports every reader already imports. */
export type { Lesson, LessonChapter } from './content/types';
export const LESSONS: Record<PhaseKey, Lesson> = {
  requirements: REQUIREMENTS_LESSON,
  design: DESIGN_LESSON,
  implementation: IMPLEMENTATION_LESSON,
  testing: TESTING_LESSON,
  deployment: DEPLOYMENT_LESSON,
  maintenance: MAINTENANCE_LESSON,
};
