/**
 * Length limits that a web form and an API DTO both enforce.
 *
 * Each value is the one the API's validator refuses past, so the form's
 * `minLength`, `maxLength` and character count can never accept text the API
 * then rejects, nor stop a learner or teacher short of what the API allows.
 * Caps that belong to one record (`RUNBOOK_CAPS`, `TASK_TITLE_MAX`, the
 * interview caps, the assignment reason's `ASSIGNMENT_REASON_MIN` and
 * `ASSIGNMENT_REASON_MAX`) live beside that record instead.
 * Limits only the API enforces stay in the API.
 */

import { RUNBOOK_CAPS } from './runbook-record';

/* ------------------------------- accounts -------------------------------- */

/** A password: at least this many characters (registration, change and reset). */
export const PASSWORD_MIN_LENGTH = 8;
/** A password: at most this many characters. */
export const PASSWORD_MAX_LENGTH = 100;

/** A display name: at least this many characters (registration, onboarding and profile). */
export const DISPLAY_NAME_MIN = 2;
/** A display name: at most this many characters. */
export const DISPLAY_NAME_MAX = 60;

/** The profile's "about you" text: at most this many characters. */
export const PROFILE_BIO_MAX = 1000;
/** The profile's learning goals, one per line: at most this many characters in all. */
export const PROFILE_GOALS_MAX = 1000;

/* ------------------------------- the mentor ------------------------------ */

/** What a learner says they are stuck on: at least this many characters. */
export const STUCK_QUESTION_MIN = 10;
/** What a learner says they are stuck on: at most this many characters. */
export const STUCK_QUESTION_MAX = 400;
/** What they have already tried (blank is allowed): at most this many characters. */
export const STUCK_TRIED_MAX = 400;

/** A teacher's answer to a stuck flag: at least this many characters. */
export const STUCK_ANSWER_MIN = 10;
/** A teacher's answer to a stuck flag: at most this many characters. */
export const STUCK_ANSWER_MAX = 1000;

/* -------------------------------- the drill ------------------------------ */

/** Each of the incident drill's three answers: at least this many characters. */
export const DRILL_ANSWER_MIN = 20;
/** Each of the incident drill's three answers: at most this many UTF-16 code units, the runbook record's field cap. */
export const DRILL_ANSWER_MAX = RUNBOOK_CAPS.fieldChars;

/* ------------------------------- the teacher ----------------------------- */

/** A class's name: at least this many characters. */
export const CLASS_NAME_MIN = 2;
/** A class's name: at most this many characters. */
export const CLASS_NAME_MAX = 80;

/** A note an instructor pins for the class: at least this many characters. */
export const INSTRUCTOR_NOTE_MIN = 10;
/** A note an instructor pins for the class: at most this many characters. */
export const INSTRUCTOR_NOTE_MAX = 500;

/** A teacher's written feedback on a submission: at least this many characters. */
export const TEACHER_FEEDBACK_MIN = 2;
/** A teacher's written feedback on a submission: at most this many characters. */
export const TEACHER_FEEDBACK_MAX = 4000;

/**
 * The reason a teacher gives for a phase or task override or a regrade: at
 * least this many characters, the shortest that can say something a colleague
 * could act on later. Every such reason lands in the audit log.
 */
export const OVERRIDE_REASON_MIN = 10;

/** A project's title: at most this many characters. */
export const PROJECT_TITLE_MAX = 120;

/** A tests task's smallest suite a learner may hand in: at most this many tests. */
export const MIN_TESTS_MAX = 500;
