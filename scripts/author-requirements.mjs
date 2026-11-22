#!/usr/bin/env node
// A teacher authors a Requirements phase through the API, as the builder does:
// copy TaskTrackr, replace its Requirements task's story block and rubric,
// publish the copy, open a class and give the class that copy.
//
//   node scripts/author-requirements.mjs [--api http://localhost:4080/api/v1] [--title "My class project"]
//
// Signs in as the demo instructor (SEED_PASSWORD overrides the password) and
// prints the title it published and the join code of the class it made. scripts/prove-local.mjs
// imports `authorRequirements` for the proof's "Teacher authors Requirements
// and a learner passes it" step, with the instructor token it already holds.
//
// The learner's story stays US-4, the overdue report: the passing work the
// scripts share (scripts/passing-work.mjs) and the test mentor's proposal
// (e2e/ai-stub.cjs) are both written for it. What the teacher changes is what
// a teacher's builder changes: the brief, the stories provided beside it, the
// floor and the weighted rubric.
import { TITLE_MAX, authorCopy, call, proofSlug, runWhenMain } from './author-common.mjs';

/** The stories the class reads beside US-4, read-only. Every criterion is complete: the door refuses a blank one. */
const PROVIDED_STORIES = [
  {
    id: 'US-1',
    title: 'Add a task',
    persona: 'busy learner',
    capability: 'to add a task to a list with a title, a priority and an optional due date',
    benefit: 'I can capture work the moment I think of it',
    criteria: [
      { id: 'AC-1', given: 'a list with no tasks', when: 'I add a task titled "Write report"', then: 'the task is stored in that list with priority medium and status open', tag: 'happy' },
      { id: 'AC-2', given: 'any list', when: 'I add a task with an empty title', then: 'the API answers 400 with the code invalid_title and stores nothing', tag: 'error' },
    ],
  },
  {
    id: 'US-2',
    title: 'Complete a task',
    persona: 'busy learner',
    capability: 'to mark a task as completed by its id',
    benefit: 'my lists reflect what is actually left to do',
    criteria: [
      { id: 'AC-1', given: 'an open task', when: 'I complete it', then: 'it is stored as done with the time it was completed', tag: 'happy' },
    ],
  },
  {
    id: 'US-5',
    title: 'See at a glance which tasks are late',
    persona: 'busy learner',
    capability: 'a late marker on the task rows I am already looking at',
    benefit: 'I do not have to open a report to notice a deadline I have missed',
    criteria: [
      { id: 'AC-1', given: 'a task whose due date has passed', when: 'I look at its row', then: 'the row says how many whole days late the task is', tag: 'happy' },
      { id: 'AC-2', given: 'a task I have completed', when: 'I look at its row', then: 'it carries no late marker, however long ago its due date was', tag: 'boundary' },
    ],
  },
];

/**
 * What only this authoring sets, so the proof can see it reached the learner:
 * the provided stories (TaskTrackr's own are US-1, US-2, US-3 and US-5; these
 * leave out US-3) and the rubric's weights, in order (TaskTrackr's are 0.3,
 * 0.4 and 0.3).
 */
export const AUTHORED_PROVIDED_IDS = PROVIDED_STORIES.map((story) => story.id);
export const AUTHORED_WEIGHTS = [0.25, 0.5, 0.25];

/**
 * The Requirements task as this teacher writes it: `UpdateTaskBody` with a
 * story block (`StoryChecksBody`: the record path stays the task's own) and a
 * rubric replaced whole, its weights summing to 1.
 */
export function storyTaskBody(title) {
  const named = `${title}: the overdue report story`;
  return {
    title: named.length > TITLE_MAX ? `${named.slice(0, TITLE_MAX - 3)}...` : named,
    brief: [
      '## Your task',
      '',
      'Write user story US-4 for the overdue report: who reads it, what it lists and why.',
      '',
      '1. Fill As a, I want and So that.',
      '2. Add at least two Given / When / Then acceptance criteria: tag one happy path and one boundary (a task due today is not overdue).',
      '3. Add at least one out-of-scope line for this release.',
      '',
      'US-1, US-2 and US-5 are signed off and shown beside your story. Your story has to agree with them.',
    ].join('\n'),
    artefactType: 'user-story',
    objectives: [
      'Write US-4 for the overdue report as As a / I want / So that',
      'Give US-4 a happy path and a boundary criterion a test could check',
      'Say what the overdue report will not do in this release',
    ],
    story: {
      providedStories: PROVIDED_STORIES,
      learnerStory: {
        id: 'US-4',
        hints: {
          persona: 'person who runs TaskTrackr every morning',
          capability: 'a report of the tasks that are overdue',
          benefit: 'I catch what I missed before the day starts',
        },
      },
      floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true },
    },
    rubric: {
      passThreshold: 70,
      criteria: [
        { key: 'story_structure', title: 'User story structure', description: 'US-4 follows As a / I want / So that and names the overdue report.', weight: AUTHORED_WEIGHTS[0] },
        { key: 'acceptance_criteria', title: 'Testable acceptance criteria', description: 'Given / When / Then criteria a test could verify, including that a task due today is not overdue.', weight: AUTHORED_WEIGHTS[1] },
        { key: 'scope_clarity', title: 'Scope and precision', description: 'A scope note says what is excluded, and the wording is precise enough to test.', weight: AUTHORED_WEIGHTS[2] },
      ],
    },
  };
}

/** `POST /instructor/projects`: a copy of the platform's published TaskTrackr, under a slug no other copy has. */
export function copyBody(title, fromVersionId) {
  return { title, slug: proofSlug('req-proof'), fromVersionId };
}

/** `POST .../publish`: the copy's first version. */
export function publishBody() {
  return { version: '1.0.0', notes: 'Requirements authored as a story task: US-4, its floor and its rubric.' };
}

/** `PUT /instructor/cohorts/:id/project`: the class's project, with the reason the history keeps. */
export function assignBody(projectVersionId) {
  return { projectVersionId, reason: 'This class writes the overdue report story the teacher authored.' };
}

/**
 * Copy TaskTrackr, author its Requirements task, publish, open a class and
 * assign the copy. Returns what a learner needs to reach it.
 * @returns {Promise<{ projectId: string, versionId: string, joinCode: string }>}
 */
export async function authorRequirements({ api, token, title }) {
  return authorCopy({
    api, token, title, copyBody, publishBody, assignBody,
    edit: async (at) => {
      const edited = await call(api, token, 'PATCH', `${at}/phases/requirements/tasks/main`, storyTaskBody(title));
      const task = (edited.phase?.tasks ?? []).find((one) => one.taskKey === 'main');
      if (task?.checkKind !== 'story' || task.story?.floor?.minCriteria !== 2) {
        throw new Error('the Requirements task did not come back as the authored story task');
      }
    },
  });
}

runWhenMain(import.meta.url, authorRequirements, 'Requirements');
