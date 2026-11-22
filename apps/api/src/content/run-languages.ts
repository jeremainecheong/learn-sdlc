import type { RunHarness, RunLanguage } from '@learnsdlc/shared';

/*
 * What the runner can execute, in one place for every pack reader: the
 * loader, the warm-up loader and the content check. A language added to the
 * runner is added here.
 */

/** Languages the runner can execute. */
export const RUN_LANGUAGES: readonly RunLanguage[] = ['python', 'javascript', 'typescript'];

/** Harnesses the runner can drive. */
export const RUN_HARNESSES: readonly RunHarness[] = ['unittest', 'pytest', 'js'];

/** Which harnesses each language can be driven by. */
export const HARNESSES_FOR: Readonly<Record<RunLanguage, readonly RunHarness[]>> = {
  python: ['unittest', 'pytest'],
  javascript: ['js'],
  typescript: ['js'],
};
