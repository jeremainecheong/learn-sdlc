#!/usr/bin/env node
// A teacher authors a Maintenance phase through the API, as the builder does:
// copy TaskTrackr, give its Maintenance task a CR-2 ticket with one acceptance
// line reworded and a stricter change floor (saved as `{ ticket, change }`
// through the executable arm), publish the copy, open a class and give the
// class that copy.
//
//   node scripts/author-maintenance.mjs [--api http://localhost:4080/api/v1] [--title "My class project"]
//
// Signs in as the demo instructor (SEED_PASSWORD overrides the password) and
// prints the title it published and the join code of the class it made.
// scripts/prove-local.mjs imports `authorMaintenance` for the proof's "Teacher
// authors Maintenance and a learner passes it" step, with the instructor token
// it already holds. What it writes is a teacher's copy for the proof, not a
// learner's work.
//
// The starting change request stays the copy's own: it covers no acceptance
// id, so the reworded ticket keeps it valid and nothing needs replacing.
import { TITLE_MAX, authorCopy, call, proofSlug, runWhenMain } from './author-common.mjs';

/**
 * TaskTrackr 5.0.0's ticket (spec 7.1) with one line reworded, AC-6, so the
 * proof can tell the authored ticket from the copy's. Every other line is
 * TaskTrackr's word for word, so the worked change request
 * (CHANGE_REQUEST_RECORD, covering AC-1 to AC-7) still traces every item.
 */
export const AUTHORED_TICKET = Object.freeze({
  id: 'CR-2',
  title: 'Comments on a task',
  summary: "A task says what to do and never says what happened. Let people leave a comment on a task, read a task's comments newest first, and see on the task row how many a task carries.",
  acceptance: [
    { id: 'AC-1', line: 'add_comment stores one comment and returns it with id, task_id, author, body and created_at.' },
    { id: 'AC-2', line: 'An unknown task answers 404 task_not_found, when adding a comment and when listing them.' },
    { id: 'AC-3', line: 'An empty or whitespace-only author or body answers 400 invalid_comment.' },
    { id: 'AC-4', line: "list_comments returns a task's comments newest first." },
    { id: 'AC-5', line: 'Every task the API returns carries comment_count, and the task query returns the same rows as before.' },
    { id: 'AC-6', line: 'Each task row names how many comments the task carries ("1 comment", "4 comments"), and a task with none shows nothing.' },
    { id: 'AC-7', line: 'listComments and addComment are published in the API contract, with the error code addComment answers with.' },
  ],
});

/** The floor, every count inside `CHANGE_CAPS`; its impact and test counts are above TaskTrackr's own (1 and 1). */
export const AUTHORED_CHANGE_FLOOR = Object.freeze({ minImpact: 2, minContract: 1, minTests: 2, requireRelease: true, traceEveryAcceptance: true });

/** The Maintenance task as this teacher writes it: `UpdateTaskBody` with the ticket and the change request switch and floor. */
export function changeTaskBody(title) {
  return {
    title: `${title}: comments on a task`.slice(0, TITLE_MAX),
    ticket: { ...AUTHORED_TICKET, acceptance: AUTHORED_TICKET.acceptance.map((one) => ({ ...one })) },
    change: { contract: true, floor: { ...AUTHORED_CHANGE_FLOOR } },
  };
}

/** `POST /instructor/projects`: a copy of the platform's published TaskTrackr, under a slug no other copy has. */
export function copyBody(title, fromVersionId) {
  return { title, slug: proofSlug('maintenance-proof'), fromVersionId };
}

/** `POST .../publish`: the copy's first version. */
export function publishBody() {
  return { version: '1.0.0', notes: 'Maintenance authored as a change request: its ticket and its floor.' };
}

/** `PUT /instructor/cohorts/:id/project`: the class's project, with the reason the history keeps. */
export function assignBody(projectVersionId) {
  return { projectVersionId, reason: 'This class ships CR-2 against the ticket the teacher authored.' };
}

/**
 * Copy TaskTrackr, author its Maintenance ticket and change floor, publish,
 * open a class and assign the copy. Returns what a learner needs to reach it.
 * @returns {Promise<{ projectId: string, versionId: string, joinCode: string }>}
 */
export async function authorMaintenance({ api, token, title }) {
  return authorCopy({
    api, token, title, copyBody, publishBody, assignBody,
    edit: async (at) => {
      // the same PATCH as any task: the service hands Maintenance's code task to its executable arm, which takes the ticket and the change request
      const edited = await call(api, token, 'PATCH', `${at}/phases/maintenance/tasks/main`, changeTaskBody(title));
      const task = (edited.phase?.tasks ?? []).find((one) => one.taskKey === 'main');
      if (task?.change?.ticket?.acceptance?.[5]?.line !== AUTHORED_TICKET.acceptance[5].line) throw new Error('the Maintenance task did not come back with the authored ticket');
    },
  });
}

runWhenMain(import.meta.url, authorMaintenance, 'Maintenance');
