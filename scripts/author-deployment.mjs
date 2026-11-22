#!/usr/bin/env node
// A teacher authors a Deployment phase through the API, as the builder does:
// copy TaskTrackr, give its Deployment task a title and a stricter runbook
// floor (the Brief step's title and the Runbook step's floor, saved in one
// PATCH as `{ title, runbook: { floor } }`) and a starting runbook with two
// settings named, publish the copy, open a class and give the class that copy.
//
//   node scripts/author-deployment.mjs [--api http://localhost:4080/api/v1] [--title "My class project"]
//
// Signs in as the demo instructor (SEED_PASSWORD overrides the password) and
// prints the title it published and the join code of the class it made.
// scripts/prove-local.mjs imports `authorDeployment` for the proof's "Teacher
// authors Deployment and a learner passes it" step, with the instructor token
// it already holds. What it writes is a teacher's copy for the proof, not a
// learner's work.
import { TITLE_MAX, authorCopy, call, proofSlug, runWhenMain } from './author-common.mjs';

/**
 * The floor, every count inside `RUNBOOK_CAPS`. Its environment and health
 * counts are above TaskTrackr's own (2 and 1), so the floor the proof reads
 * back in the learner's phase can only be this authoring's.
 */
export const AUTHORED_RUNBOOK_FLOOR = Object.freeze({ minEnvironment: 3, minHealth: 2, minRollback: 2, minData: 1, requireIncident: true });

/**
 * The Deployment task as this teacher writes it: `UpdateTaskBody` with a title
 * and the runbook arm (`RunbookChecksBody`) only. The brief, the objectives and
 * the rubric stay the copy's own: a new brief or new objectives move the phase
 * off the reference application, and publish would then ask for a deep run
 * first. The title is outside that check.
 */
export function runbookTaskBody(title) {
  return {
    title: `${title}: ship TaskTrackr and keep it running`.slice(0, TITLE_MAX),
    runbook: { floor: { ...AUTHORED_RUNBOOK_FLOOR } },
  };
}

/**
 * `PUT .../phases/deployment/files`: the starting runbook, two settings named
 * and the rest the learner's. The incident is empty, as a starting runbook in
 * a phase with a drill must be: the drill writes it.
 */
export function startingRunbookBody() {
  const record = {
    environment: [
      { id: 'E1', name: 'TASKTRACKR_DB', purpose: '', kind: 'config' },
      { id: 'E2', name: 'API_URL', purpose: '', kind: 'config' },
    ],
    health: [],
    rollback: [],
    data: [],
    incident: { rootCause: '', fix: '', actionItem: '' },
  };
  return { path: 'deployment/runbook.json', content: `${JSON.stringify(record, null, 2)}\n` };
}

/** `POST /instructor/projects`: a copy of the platform's published TaskTrackr, under a slug no other copy has. */
export function copyBody(title, fromVersionId) {
  return { title, slug: proofSlug('deployment-proof'), fromVersionId };
}

/** `POST .../publish`: the copy's first version. */
export function publishBody() {
  return { version: '1.0.0', notes: 'Deployment authored as a runbook task: its floor and its starting runbook.' };
}

/** `PUT /instructor/cohorts/:id/project`: the class's project, with the reason the history keeps. */
export function assignBody(projectVersionId) {
  return { projectVersionId, reason: 'This class ships TaskTrackr with the runbook the teacher authored.' };
}

/**
 * Copy TaskTrackr, author its Deployment task's floor and its starting
 * runbook, publish, open a class and assign the copy. Returns what a learner
 * needs to reach it.
 * @returns {Promise<{ projectId: string, versionId: string, joinCode: string }>}
 */
export async function authorDeployment({ api, token, title }) {
  return authorCopy({
    api, token, title, copyBody, publishBody, assignBody,
    edit: async (at) => {
      const edited = await call(api, token, 'PATCH', `${at}/phases/deployment/tasks/main`, runbookTaskBody(title));
      const task = (edited.phase?.tasks ?? []).find((one) => one.taskKey === 'main');
      if (task?.runbook?.floor?.minEnvironment !== AUTHORED_RUNBOOK_FLOOR.minEnvironment) throw new Error('the Deployment task did not come back with the authored floor');
      await call(api, token, 'PUT', `${at}/phases/deployment/files`, startingRunbookBody());
    },
  });
}

runWhenMain(import.meta.url, authorDeployment, 'Deployment');
