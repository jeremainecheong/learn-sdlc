import type { PhaseKey } from '@learnsdlc/shared';
import type { PhaseStudy } from './study/types';
import { REQUIREMENTS_STUDY } from './study/requirements';
import { DESIGN_STUDY } from './study/design';
import { IMPLEMENTATION_STUDY } from './study/implementation';
import { TESTING_STUDY } from './study/testing';
import { DEPLOYMENT_STUDY } from './study/deployment';
import { MAINTENANCE_STUDY } from './study/maintenance';

export type { ChapterStudy, PhaseStudy } from './study/types';

/** Authored teaching from the supplied, completed TaskTrackr baseline. These
 * examples explain the existing system; they are not execution transcripts or
 * replacement submissions for the learner's assigned gaps.
 * The six phases live one module per phase under study/; this index
 * keeps the export every reader already imports. */
export const PHASE_STUDY: Record<PhaseKey, PhaseStudy> = {
  requirements: REQUIREMENTS_STUDY,
  design: DESIGN_STUDY,
  implementation: IMPLEMENTATION_STUDY,
  testing: TESTING_STUDY,
  deployment: DEPLOYMENT_STUDY,
  maintenance: MAINTENANCE_STUDY,
};
