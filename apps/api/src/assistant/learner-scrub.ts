import { CONTROL_CHARS, scrubFenceMarkers } from './fence-markers';
import type { PhaseScope } from './project-scope';

/**
 * The fence around everything the learner had a hand in. Nothing inside it is
 * ever an instruction: function names are scraped out of the learner's own
 * files and check details carry their stderr, so both are a channel from the
 * learner straight into the prompt. Naming the fence in the
 * system message is what makes the model's job unambiguous, and the scrub
 * below is what stops the learner from writing the closing marker themselves.
 */
export const LEARNER_DATA_OPEN = '<<<LEARNER_DATA';
export const LEARNER_DATA_CLOSE = 'LEARNER_DATA>>>';
/** Either fence marker, however spaced or cased; `[marker]` replaces it in learner text. */
export const DELIMITER_PATTERN = /<<<\s*LEARNER_DATA|LEARNER_DATA\s*>>>/gi;

/** One line of learner-derived data: no control characters, no line breaks, capped. */
export function scrubValue(value: string, maxChars: number): string {
  return String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(DELIMITER_PATTERN, '[marker]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** The learner's own question: line breaks survive, control characters do not. */
export function scrubBody(value: string, maxChars: number): string {
  return String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(DELIMITER_PATTERN, '[marker]')
    .trim()
    .slice(0, maxChars);
}

/**
 * The authored arm's two learner scrubs: the reference
 * pair above, with every fence marker, the teacher's and the instructor's as
 * well as the learner's, look-alikes included, neutralised. An authored phase
 * names the teacher's fence as trusted, so learner text must not be able to
 * write it. TaskTrackr's prompts keep the pair above, byte for byte.
 */
export function scrubAuthoredValue(value: string, maxChars: number): string {
  return scrubFenceMarkers(String(value ?? '').replace(CONTROL_CHARS, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function scrubAuthoredBody(value: string, maxChars: number): string {
  return scrubFenceMarkers(String(value ?? '').replace(CONTROL_CHARS, ' '))
    .trim()
    .slice(0, maxChars);
}

export interface LearnerScrub {
  value: (value: string, maxChars: number) => string;
  body: (value: string, maxChars: number) => string;
  memoryLine: (line: string) => string;
}
/** The memory lines were scrubbed when stored; the reference arm sends them as stored. */
const REFERENCE_SCRUB: LearnerScrub = { value: scrubValue, body: scrubBody, memoryLine: (line) => line };
const AUTHORED_SCRUB: LearnerScrub = { value: scrubAuthoredValue, body: scrubAuthoredBody, memoryLine: scrubFenceMarkers };
export const learnerScrubFor = (scope: PhaseScope): LearnerScrub => (scope.kind === 'reference' ? REFERENCE_SCRUB : AUTHORED_SCRUB);

export function learnerDataBlock(label: string, lines: string[]): string {
  return [`${LEARNER_DATA_OPEN} ${label}`, ...lines, LEARNER_DATA_CLOSE].join('\n');
}
