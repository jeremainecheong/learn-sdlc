import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import {
  DISPLAY_NAME_MAX,
  PHASE_ORDER,
  SOLE_TASK_KEY,
  TASK_KEY_MAX_LENGTH,
  isAuthoredTaskKey,
  type CohortExportEnrollment,
  type CohortExportLearner,
  type CohortExportMessage,
  type CohortExportPhase,
  type CohortExportRelease,
  type CohortExportSubmission,
  type CohortExportTask,
} from '@learnsdlc/shared';
import { DISPLAY_LOCALE } from '../config/locale';
import { normaliseEmail } from '../auth/email';
import { SLUG_MAX_LENGTH } from './instructor.dto';

/**
 * What a class import file may say: the shape and range of every field an
 * import writes, checked before anything is planned. Every refusal is one
 * sentence naming the learner and the field, so the file can be fixed by hand.
 */

/**
 * The most learners one file may name. A class is thirty; five hundred is
 * every section of a large module at once. Above it the file is not a class,
 * and one request that hashes and inserts without a ceiling is a way to pin
 * this process's CPU for as long as the file is long.
 */
export const IMPORT_MAX_LEARNERS = 500;

/**
 * The longest release version label a class file may carry: a bound on what
 * the import stores, not the pack format's rule. A pack declares its version
 * in at most 32 characters (the content service's limit), and this looser
 * bound accepts every such label while still refusing an unbounded string.
 */
const IMPORT_VERSION_MAX_LENGTH = 80;
const EMAIL_MAX = 254;
/** The largest daily token budget a file may carry. */
const BUDGET_MAX = 10_000_000;
const SCORE_MAX = 100;
const PHASE_STATUSES: readonly string[] = [
  'locked',
  'in_progress',
  'submitted',
  'passed',
];
const SUBMISSION_STATUSES: readonly string[] = [
  'queued',
  'running',
  'completed',
  'failed',
];
const MESSAGE_ROLES: readonly string[] = ['user', 'assistant'];

/**
 * The one sentence for an account the caller may not pull in: a member of
 * staff, or a learner sitting in a class the caller does not own. Said the
 * same way for both on purpose, so the dry run does not tell an instructor
 * which addresses on this machine are staff and which are somebody else's
 * students.
 */
export const NOT_YOURS_TO_IMPORT =
  'This account cannot be brought into a class from a file. If they belong in yours, ask them to type your join code.';

/** Forty characters of whatever it was, for a sentence about it. */
function clip(value: unknown): string {
  const text = String(value ?? '');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** The refusal, always naming the learner and the field, so the file can be fixed by hand. */
function refuse(ref: string, field: string, problem: string): never {
  throw new BadRequestException(
    `That file was not imported. ${ref}, ${field}: ${problem}`,
  );
}

const isInt = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
const isScore = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === 'number' && value >= 0 && value <= SCORE_MAX);
export const present = (value: unknown): boolean =>
  value !== undefined && value !== null;
/**
 * A key a task row or a submission may carry (teacher-authored projects): the
 * sole task's empty string, or a key in the one shape the authoring
 * register mints; `TASK_KEY_PATTERN`, which also bounds its length.
 *
 * Held here for the same reason every other string on this file is held: the
 * import is a closed refusal register, and an unchecked key is either a driver
 * type error deep inside the write transaction (reported as whatever sentence
 * that seam happens to say) or a row this machine stores, exports again and
 * renders to a teacher as a task title.
 */
const isTaskKey = (value: unknown): boolean =>
  typeof value === 'string' &&
  (value === SOLE_TASK_KEY || isAuthoredTaskKey(value));
/** The sentence both key checks say, so a file is fixed by hand from either. */
const NOT_A_TASK_KEY =
  `is not a task key: a key is up to ${TASK_KEY_MAX_LENGTH} characters of lower-case letters, digits and hyphens, starting with a letter, or empty for a phase with one task.`;
const listOf = (value: unknown, ref: string, field: string): unknown[] => {
  if (!present(value)) return [];
  if (!Array.isArray(value)) refuse(ref, field, 'is not a list.');
  return value as unknown[];
};

/**
 * Every field an import writes, held to the rules the rest of the API holds
 * the same field to. Without this the import was the one route that wrote a
 * budget above the console's ceiling, a phase the map has no key for, a score
 * of 999 and a name a hundred thousand characters long; rows the console then
 * could not read back.
 */
export function checkLearners(learners: unknown[]): void {
  learners.forEach((entry, index) => {
    const learner = entry as Partial<CohortExportLearner> | null;
    const ref =
      learner && typeof learner.ref === 'string' && learner.ref.trim()
        ? `learner ${learner.ref.trim().slice(0, 40)}`
        : `entry ${index + 1}`;
    if (!learner || typeof learner !== 'object')
      refuse(ref, 'entry', 'is not a learner record.');

    const email = normaliseEmail(learner.email as string);
    if (email && !(email.length <= EMAIL_MAX && isEmail(email))) {
      refuse(ref, 'email', `"${clip(email)}" is not an email address.`);
    }
    if (present(learner.displayName)) {
      if (typeof learner.displayName !== 'string')
        refuse(ref, 'displayName', 'is not text.');
      const length = learner.displayName.trim().length;
      // The cap registration and the account page hold a display name to.
      if (length > DISPLAY_NAME_MAX) {
        refuse(
          ref,
          'displayName',
          `is ${length} characters; a name is at most ${DISPLAY_NAME_MAX}.`,
        );
      }
    }
    if (
      present(learner.dailyTokenBudget) &&
      !isInt(learner.dailyTokenBudget, 0, BUDGET_MAX)
    ) {
      refuse(
        ref,
        'dailyTokenBudget',
        `is ${clip(learner.dailyTokenBudget)}; a budget is a whole number from 0 to ${BUDGET_MAX.toLocaleString(DISPLAY_LOCALE)}, or null.`,
      );
    }

    listOf(learner.enrollments, ref, 'enrollments').forEach(
      (row, enrollmentIndex) => {
        const enrollment = row as Partial<CohortExportEnrollment> | null;
        const eref = `${ref}, enrolment ${enrollmentIndex + 1}`;
        if (!enrollment || typeof enrollment !== 'object')
          refuse(eref, 'entry', 'is not an enrolment.');
        if (
          typeof enrollment.projectSlug !== 'string' ||
          !enrollment.projectSlug.trim() ||
          enrollment.projectSlug.length > SLUG_MAX_LENGTH
        ) {
          refuse(eref, 'projectSlug', 'is missing or is not a project name.');
        }
        // LearnSDLC's bound, not the version's: no version is resolved
        // yet. `plan` then holds every order of the enrolment, this one and
        // each phase's and release's below, to the version it is pinned to,
        // and refuses one above that version's phase count by name.
        if (
          present(enrollment.currentPhaseOrder) &&
          !isInt(enrollment.currentPhaseOrder, 1, PHASE_ORDER.length)
        ) {
          refuse(
            eref,
            'currentPhaseOrder',
            `is ${clip(enrollment.currentPhaseOrder)}; phases are numbered 1 to ${PHASE_ORDER.length}.`,
          );
        }

        listOf(enrollment.phases, eref, 'phases').forEach(
          (item, phaseIndex) => {
            const phase = item as Partial<CohortExportPhase> | null;
            const pref = `${eref}, phase ${phaseIndex + 1}`;
            if (!phase || typeof phase !== 'object')
              refuse(pref, 'entry', 'is not a phase.');
            if (!PHASE_ORDER.includes(phase.phaseKey as never)) {
              refuse(
                pref,
                'phaseKey',
                `"${clip(phase.phaseKey)}" is not one of ${PHASE_ORDER.join(', ')}.`,
              );
            }
            // LearnSDLC's bound; the version's own order is held in `plan`.
            if (!isInt(phase.phaseOrder, 1, PHASE_ORDER.length)) {
              refuse(
                pref,
                'phaseOrder',
                `is ${clip(phase.phaseOrder)}; phases are numbered 1 to ${PHASE_ORDER.length}.`,
              );
            }
            if (!PHASE_STATUSES.includes(phase.status as string)) {
              refuse(
                pref,
                'status',
                `"${clip(phase.status)}" is not one of ${PHASE_STATUSES.join(', ')}.`,
              );
            }
            if (!isScore(phase.bestScore)) {
              refuse(
                pref,
                'bestScore',
                `is ${clip(phase.bestScore)}; a score is 0 to ${SCORE_MAX}, or null.`,
              );
            }
            if (
              present(phase.attempts) &&
              !isInt(phase.attempts, 0, Number.MAX_SAFE_INTEGER)
            ) {
              refuse(pref, 'attempts', 'is not a whole number.');
            }
            checkTasks(phase, pref);
            listOf(phase.submissions, pref, 'submissions').forEach(
              (sub, submissionIndex) => {
                const submission =
                  sub as Partial<CohortExportSubmission> | null;
                const sref = `${pref}, submission ${submissionIndex + 1}`;
                if (!submission || typeof submission !== 'object')
                  refuse(sref, 'entry', 'is not a submission.');
                if (
                  !SUBMISSION_STATUSES.includes(submission.status as string)
                ) {
                  refuse(
                    sref,
                    'status',
                    `"${clip(submission.status)}" is not one of ${SUBMISSION_STATUSES.join(', ')}.`,
                  );
                }
                if (!isScore(submission.score)) {
                  refuse(
                    sref,
                    'score',
                    `is ${clip(submission.score)}; a score is 0 to ${SCORE_MAX}, or null.`,
                  );
                }
                // The one string on a submission the register never read. It
                // reaches `submissions.taskKey` verbatim, so a file carrying
                // something that is not a key is refused here by name rather
                // than by the driver.
                if (
                  present(submission.taskKey) &&
                  !isTaskKey(submission.taskKey)
                ) {
                  refuse(
                    sref,
                    'taskKey',
                    `"${clip(submission.taskKey)}" ${NOT_A_TASK_KEY}`,
                  );
                }
                // The run a revision belongs to. Absent or null reads as the
                // current run, as a row written before the column existed is
                // read; any other value that is not a count an `integer`
                // column holds is refused by name, as `resetCount` is, never
                // quietly read as the current run, the permissive direction.
                if (
                  present(submission.resetEpoch) &&
                  !isInt(submission.resetEpoch, 0, 2_147_483_647)
                ) {
                  refuse(sref, 'resetEpoch', 'is not a whole number.');
                }
              },
            );
            listOf(phase.messages, pref, 'messages').forEach(
              (msg, messageIndex) => {
                const message = msg as Partial<CohortExportMessage> | null;
                const mref = `${pref}, message ${messageIndex + 1}`;
                if (!message || typeof message !== 'object')
                  refuse(mref, 'entry', 'is not a message.');
                if (!MESSAGE_ROLES.includes(message.role as string)) {
                  refuse(
                    mref,
                    'role',
                    `"${clip(message.role)}" is not one of ${MESSAGE_ROLES.join(', ')}.`,
                  );
                }
                if (
                  present(message.phaseKey) &&
                  !PHASE_ORDER.includes(message.phaseKey as never)
                ) {
                  refuse(
                    mref,
                    'phaseKey',
                    `"${clip(message.phaseKey)}" is not a phase.`,
                  );
                }
                if (
                  present(message.content) &&
                  typeof message.content !== 'string'
                ) {
                  refuse(mref, 'content', 'is not text.');
                }
              },
            );
          },
        );

        listOf(enrollment.releases, eref, 'releases').forEach(
          (rel, releaseIndex) => {
            const release = rel as Partial<CohortExportRelease> | null;
            const rref = `${eref}, release ${releaseIndex + 1}`;
            if (!release || typeof release !== 'object')
              refuse(rref, 'entry', 'is not a release.');
            if (!PHASE_ORDER.includes(release.phaseKey as never)) {
              refuse(
                rref,
                'phaseKey',
                `"${clip(release.phaseKey)}" is not a phase.`,
              );
            }
            // LearnSDLC's bound; the version's own order is held in `plan`.
            if (!isInt(release.phaseOrder, 1, PHASE_ORDER.length)) {
              refuse(
                rref,
                'phaseOrder',
                `is ${clip(release.phaseOrder)}; phases are numbered 1 to ${PHASE_ORDER.length}.`,
              );
            }
            if (
              typeof release.version !== 'string' ||
              release.version.length > IMPORT_VERSION_MAX_LENGTH
            ) {
              refuse(rref, 'version', 'is missing or is not a short label.');
            }
            if (!isScore(release.score)) {
              refuse(
                rref,
                'score',
                `is ${clip(release.score)}; a score is 0 to ${SCORE_MAX}, or null.`,
              );
            }
          },
        );
      },
    );
  });
}

/**
 * One phase's task rows, held to the same rules as the phase above them
 * (teacher-authored projects).
 *
 * Two of these are not tidiness. A key named twice on one phase is a row the
 * database refuses under `UQ_task_states_key`, deep inside the write, where the
 * only sentence left to say is the unique-violation one about somebody
 * registering an address; a true failure reported as the wrong fact. And
 * `countersigned` with no `signedOffAt` is a countersignature with no moment:
 * the import writes its **own** operator's id against that moment, so a file
 * that does not carry one is asking this machine to invent half of a record a
 * gate reads.
 */
function checkTasks(phase: Partial<CohortExportPhase>, pref: string): void {
  const seen = new Set<string>();
  listOf(phase.tasks, pref, 'tasks').forEach((item, index) => {
    const task = item as Partial<CohortExportTask> | null;
    const tref = `${pref}, task ${index + 1}`;
    if (!task || typeof task !== 'object')
      refuse(tref, 'entry', 'is not a task.');
    const key = task.taskKey;
    if (typeof key !== 'string') {
      refuse(tref, 'taskKey', 'is missing or is not a task key.');
    }
    // And it is a key in the shape the authoring register mints, not merely
    // text: an out-of-shape key is stored, exported again on the next v3
    // export, and shown to a teacher as a task's own title.
    if (!isTaskKey(key)) {
      refuse(tref, 'taskKey', `"${clip(key)}" ${NOT_A_TASK_KEY}`);
    }
    if (seen.has(key)) {
      refuse(
        tref,
        'taskKey',
        `"${clip(key)}" is named twice on one phase; a task has one row.`,
      );
    }
    seen.add(key);
    if (!PHASE_STATUSES.includes(task.status as string)) {
      refuse(
        tref,
        'status',
        `"${clip(task.status)}" is not one of ${PHASE_STATUSES.join(', ')}.`,
      );
    }
    if (!isScore(task.bestScore)) {
      refuse(
        tref,
        'bestScore',
        `is ${clip(task.bestScore)}; a score is 0 to ${SCORE_MAX}, or null.`,
      );
    }
    if (
      present(task.attempts) &&
      !isInt(task.attempts, 0, Number.MAX_SAFE_INTEGER)
    ) {
      refuse(tref, 'attempts', 'is not a whole number.');
    }
    if (
      present(task.resetCount) &&
      !isInt(task.resetCount, 0, Number.MAX_SAFE_INTEGER)
    ) {
      refuse(tref, 'resetCount', 'is not a whole number.');
    }
    if (task.countersigned && !task.signedOffAt) {
      refuse(
        tref,
        'countersigned',
        'is true with no signedOffAt; a countersignature carries the moment it was given.',
      );
    }
  });
}
