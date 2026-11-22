/**
 * What the Phases card's Add writes for a Requirements or Design phase, and
 * the rubric a new story or design task starts with.
 *
 * An added phase is a base `PhaseContent` the draft's snapshot did not hold:
 * the builder's empty checks, the seeded empty record, a rubric of one
 * criterion the Criteria step can save, and a neutral assistant block. The
 * loader requires an assistant block on every phase; a teacher's version frames
 * its mentor from its own briefs, so this block reaches no AI request.
 */
import { EMPTY_STORY, PHASE_TITLES, STORY_JSON, designDocumentPaths, serialiseStory, type PhaseKey, type RubricCriterion } from '@learnsdlc/shared';
import { seededDesignDocument, validateDesignChecks, validateStoryChecks } from '../content/content.service';
import type { ContentFileSpec, PhaseContent } from '../content/content.types';

/** The two phases Add writes; the other four come only by upload or by Put back. */
export type AddedPhaseKey = 'requirements' | 'design';

/** The rubric a new story task starts with: one criterion, until the teacher writes their own. */
export const DEFAULT_STORY_CRITERION: RubricCriterion = { key: 'story', title: 'The story', description: 'The story says who wants what and why, and each acceptance criterion can be checked.', weight: 1 };

/** The rubric a new design task starts with: one criterion, until the teacher writes their own. */
export const DEFAULT_DESIGN_CRITERION: RubricCriterion = {
  key: 'design',
  title: 'The design',
  description: 'The design serves every story it lists, and every decision says why.',
  weight: 1,
};

export const ADDED_PHASE_ASSISTANT: Readonly<Record<AddedPhaseKey, PhaseContent['assistant']>> = Object.freeze({
  requirements: { systemPrompt: "Help the learner write this project's user story and acceptance criteria they can check. Never write the story for them.", topics: [], progressive: [] },
  design: { systemPrompt: "Help the learner design this project's data, operations and screens, and say why each decision was taken. Never make the decision for them.", topics: [], progressive: [] },
});

/** The title the added phase's one task starts with. */
export const ADDED_PHASE_TASK_TITLE: Readonly<Record<AddedPhaseKey, string>> = Object.freeze({ requirements: 'The story', design: 'The design' });

/** Add of a Requirements or Design the draft's source holds: the card offers Put back there, so a hand-built request meets this. */
export function addFromSourceRefusal(key: AddedPhaseKey): string {
  const brings = key === 'requirements' ? 'its stories and its task' : 'its design and its task';
  return `${PHASE_TITLES[key]} is in the version this draft was opened from. Put it back to bring ${brings}.`;
}

/** The seeded record files an added phase mounts: `requirements/story.json`, or the design and its contracts on by default. */
export function addedPhaseFiles(key: AddedPhaseKey): ContentFileSpec[] {
  if (key === 'requirements') return [{ path: STORY_JSON, content: serialiseStory(EMPTY_STORY), editable: true, language: 'json' }];
  const checks = validateDesignChecks({ kind: 'design' }, 'design');
  return designDocumentPaths(checks.contracts).map((at) => ({ path: at, content: seededDesignDocument(at), editable: true, language: 'json' }));
}

/**
 * The base `PhaseContent` Add writes into the draft's snapshot. `order` is 0
 * because the door renumbers; `language` is the project's, as every phase of a
 * pack carries one.
 */
export function addedPhaseContent(key: AddedPhaseKey, language: string): PhaseContent {
  const story = key === 'requirements';
  return {
    key,
    order: 0,
    title: PHASE_TITLES[key],
    intro: '',
    artifactKind: story ? 'story' : 'design',
    language,
    canRun: false,
    canPreview: false,
    runLabel: 'Run',
    taskPanel: '',
    objectives: [],
    files: addedPhaseFiles(key),
    rubric: { passThreshold: 70, criteria: [{ ...(story ? DEFAULT_STORY_CRITERION : DEFAULT_DESIGN_CRITERION) }] },
    checks: story ? validateStoryChecks({ kind: 'story' }, 'requirements') : validateDesignChecks({ kind: 'design' }, 'design'),
    assistant: { ...ADDED_PHASE_ASSISTANT[key], topics: [], progressive: [] },
  };
}

/** Whether a key is one Add can write. */
export const isAddedPhaseKey = (key: PhaseKey): key is AddedPhaseKey => key === 'requirements' || key === 'design';
