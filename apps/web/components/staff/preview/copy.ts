import type { LearnerPreviewTask } from '@learnsdlc/shared';

/** The one sentence every frame of the preview carries. */
export const PREVIEW_BANNER = 'Preview: nothing here is saved, graded or seen by learners';

export const PREVIEW_LOADING = 'Loading what learners will see.';

export const PREVIEW_REFUSED = 'The preview could not be loaded. Try again in a moment.';

/** How each task is settled, in the words the learner's task list uses for the same evidence. */
export const PREVIEW_EVIDENCE_WORD: Record<LearnerPreviewTask['evidence'], string> = {
  automated: 'Checked automatically',
  reviewed: 'Reviewed',
  assisted: 'Assisted',
  'signed-off': 'Signed off by a teacher',
};
