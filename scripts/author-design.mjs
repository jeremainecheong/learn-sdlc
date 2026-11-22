#!/usr/bin/env node
// A teacher authors a Design phase through the API, as the builder does:
// copy TaskTrackr, replace its Design task's switches, stories, floor and
// rubric, give it a starting point, publish the copy, open a class and give
// the class that copy.
//
//   node scripts/author-design.mjs [--api http://localhost:4080/api/v1] [--title "My class project"]
//
// Signs in as the demo instructor (SEED_PASSWORD overrides the password) and
// prints the title it published and the join code of the class it made.
// scripts/prove-local.mjs imports `authorDesign` for the proof's "Teacher
// authors Design and a learner passes it" step, with the instructor token it
// already holds.
//
// The learner's design stays TaskTrackr's overdue report: the passing work the
// scripts share (scripts/passing-work.mjs, `designWork()`) traces US-2, US-3
// and US-4 and its sequence diagram names getOverdue, and the test mentor's
// proposal (e2e/ai-stub.cjs) adds an operation traced to the first listed
// story. What the teacher changes is what a teacher's builder changes: the
// stories to design for, the three switches, the floor, the starting point and
// the weighted rubric.
import { TITLE_MAX, authorCopy, call, proofSlug, runWhenMain } from './author-common.mjs';

/**
 * What only this authoring sets, so the proof can see it reached the learner:
 * the stories to design for (TaskTrackr's own are US-2, US-3 and US-4; these
 * leave out US-3) and the rubric's weights, in order.
 */
export const AUTHORED_DESIGN_STORIES = ['US-2', 'US-4'];
export const AUTHORED_DESIGN_WEIGHTS = [0.4, 0.4, 0.2];

/**
 * The floor, every count inside `DESIGN_CAPS`. Its entity, relation, operation
 * and endpoint counts are below TaskTrackr's own (3, 2, 3 and 3), so the floor
 * the proof reads back in the learner's phase can only be this authoring's.
 */
export const AUTHORED_DESIGN_FLOOR = Object.freeze({
  minEntities: 2, minRelations: 1, minOperations: 2, operationShape: true, minDecisions: 1, decisionShape: true,
  traceEveryStory: true, minEndpoints: 2, requireErrorCatalogue: true, minScreens: 1, screenShape: true,
});

/**
 * The Design task as this teacher writes it: `UpdateTaskBody` with a design
 * block (`DesignChecksBody`: both contracts and the sequence diagram on, two
 * stories, a floor inside `DESIGN_CAPS`) and a rubric replaced whole, its
 * weights summing to 1.
 */
export function designTaskBody(title) {
  const named = `${title}: design the overdue report`;
  return {
    title: named.length > TITLE_MAX ? `${named.slice(0, TITLE_MAX - 3)}...` : named,
    brief: 'Model the tasks and their lists, publish the operations the report needs with their refusals, specify the overdue screen, and record one decision with its trade-off.',
    objectives: ['Model what the overdue report needs', 'Publish the operations and their refusals', 'Specify the overdue screen'],
    artefactType: 'design-doc',
    design: {
      contracts: { api: true, screens: true },
      // on, so the proof grades the sequence rule end to end: designWork()'s diagram names getOverdue
      sequence: true,
      stories: [
        { id: 'US-2', title: 'Complete a task', line: 'As a busy learner, I want to mark a task as completed by its id, so that my lists reflect what is actually left to do.' },
        { id: 'US-4', title: 'Overdue report', line: 'As a person who runs TaskTrackr every morning, I want a report of the tasks that are overdue, so that I catch what I missed before the day starts.' },
      ],
      floor: { ...AUTHORED_DESIGN_FLOOR },
    },
    rubric: {
      passThreshold: 70,
      criteria: [
        { key: 'model', title: 'The model', description: 'The tasks carry a due date and a status and belong to one list.', weight: AUTHORED_DESIGN_WEIGHTS[0] },
        { key: 'contract', title: 'The contract', description: 'Each operation the stories need says what it answers and what it refuses.', weight: AUTHORED_DESIGN_WEIGHTS[1] },
        { key: 'decision', title: 'The decision', description: 'One decision says why, against the alternative.', weight: AUTHORED_DESIGN_WEIGHTS[2] },
      ],
    },
  };
}

/**
 * The starting point the learner opens on: one `Task` entity with its due
 * date and status, the two operations the stories need named and empty, and
 * one empty decision for the room's Decisions tab. Below the floor on purpose:
 * an untouched starting point never passes.
 */
export const AUTHORED_DESIGN_START = {
  entities: [
    {
      id: 'E1', name: 'Task', kind: 'class',
      attributes: [
        { name: 'id', type: 'integer', note: 'required, assigned by the database' },
        { name: 'due_date', type: 'date' },
        { name: 'status', type: 'string' },
      ],
      responsibilities: [], satisfies: [],
    },
  ],
  relations: [],
  operations: [
    { id: 'O1', name: 'completeTask(id)', inputs: [], returns: '', errors: [], satisfies: [] },
    { id: 'O2', name: 'getOverdue(today)', inputs: [], returns: '', errors: [], satisfies: [] },
  ],
  decisions: [{ id: 'D1', title: '', choice: '', alternative: '', rationale: '', tradeOff: '', status: 'proposed', satisfies: [] }],
};

/** `PUT .../phases/design/files`: the starting record, through the door that validates it with the room's own validator. */
export function startingPointBody() {
  return { path: 'design/design.json', content: `${JSON.stringify(AUTHORED_DESIGN_START, null, 2)}\n` };
}

/** `POST /instructor/projects`: a copy of the platform's published TaskTrackr, under a slug no other copy has. */
export function copyBody(title, fromVersionId) {
  return { title, slug: proofSlug('design-proof'), fromVersionId };
}

/** `POST .../publish`: the copy's first version. */
export function publishBody() {
  return { version: '1.0.0', notes: 'Design authored as a design task: its stories, contracts, floor and rubric.' };
}

/** `PUT /instructor/cohorts/:id/project`: the class's project, with the reason the history keeps. */
export function assignBody(projectVersionId) {
  return { projectVersionId, reason: 'This class designs the overdue report the teacher authored.' };
}

/**
 * Copy TaskTrackr, author its Design task and its starting point, publish,
 * open a class and assign the copy. Returns what a learner needs to reach it.
 * @returns {Promise<{ projectId: string, versionId: string, joinCode: string }>}
 */
export async function authorDesign({ api, token, title }) {
  return authorCopy({
    api, token, title, copyBody, publishBody, assignBody,
    edit: async (at) => {
      const edited = await call(api, token, 'PATCH', `${at}/phases/design/tasks/main`, designTaskBody(title));
      const task = (edited.phase?.tasks ?? []).find((one) => one.taskKey === 'main');
      if (task?.checkKind !== 'design' || task.design?.stories?.length !== AUTHORED_DESIGN_STORIES.length || task.design?.sequence !== true) {
        throw new Error('the Design task did not come back as the authored design task');
      }
      await call(api, token, 'PUT', `${at}/phases/design/files`, startingPointBody());
    },
  });
}

runWhenMain(import.meta.url, authorDesign, 'Design');
