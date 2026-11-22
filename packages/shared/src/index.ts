/**
 * Shared domain contract between the LearnSDLC API and web client.
 *
 * Every module in this folder and in `./contract` is re-exported below, and
 * both apps import every shared type and constant from `@learnsdlc/shared`
 * alone, never from a module path. The modules take values only from one
 * another and import this file with `import type` at most, so the order of
 * the lines below does not matter at run time.
 */

export * from './phases';
export * from './phase-subset';
export * from './status';

export * from './contract/accounts';
export * from './contract/phase-detail';
export * from './contract/runs';
export * from './contract/quizzes';
export * from './contract/feedback';
export * from './contract/class-map';
export * from './contract/analysis';
export * from './contract/mentor';
export * from './contract/analytics';
export * from './contract/instructor';
export * from './contract/workspace';
export * from './contract/reflection';
export * from './contract/cohort-export';
export * from './contract/classroom';
export * from './contract/dossier';
export * from './contract/notifications';
export * from './contract/preview';
export * from './contract/solution';
export * from './contract/repository';
export * from './contract/agentic';
export * from './contract/task-reset';
export * from './contract/http';

/*
 * The project map is a pure function of an enrolment and its phase details.
 * The API builds it too, so the shell does not have to download every phase's
 * files for the browser to build it. `apps/web/lib/map.ts` re-exports its
 * names for web imports.
 */
export * from './map';

export * from './requirements-story';
export * from './design-record';
export * from './design-floor';
export * from './projection-diff';
export * from './record-read';
export * from './runbook-record';
export * from './change-record';
export * from './pack-layout';
export * from './plain-text';
export * from './projects';
export * from './authoring';
export * from './percentages';
export * from './limits';
export * from './words';
export * from './design-claims';
export * from './upload-contract';
export * from './teacher-path';
export * from './quiz-results-summary';
