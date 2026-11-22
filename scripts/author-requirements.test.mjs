import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTHORED_PROVIDED_IDS, AUTHORED_WEIGHTS, assignBody, copyBody, publishBody, storyTaskBody } from './author-requirements.mjs';

test('the story task body carries a floor, provided stories and weights summing to 1', () => {
  const b = storyTaskBody('Library Shelf');
  assert.equal(b.story.floor.minCriteria, 2);
  assert.ok(b.story.providedStories.length >= 1);
  assert.equal(Math.round(b.rubric.criteria.reduce((n, c) => n + c.weight, 0) * 1000) / 1000, 1);
});

test('the story body is what the door reads: no record path, US-4 for the learner, the tags the stub proposes', () => {
  const { story } = storyTaskBody('Library Shelf');
  assert.deepEqual(Object.keys(story).sort(), ['floor', 'learnerStory', 'providedStories']);
  assert.equal(story.learnerStory.id, 'US-4');
  assert.ok(!story.providedStories.some((s) => s.id === story.learnerStory.id), 'the learner story is not a provided one');
  assert.deepEqual(story.floor.requiredTags, ['happy', 'boundary']);
  assert.equal(story.floor.minExclusions, 1);
  assert.equal(story.floor.requireSentence, true);
});

test('every provided criterion has a Given, a When and a Then, so the door does not refuse it', () => {
  const { story } = storyTaskBody('Library Shelf');
  for (const provided of story.providedStories) {
    for (const c of provided.criteria ?? []) {
      assert.ok(c.given.trim() && c.when.trim() && c.then.trim(), `${provided.id}/${c.id}`);
      assert.ok(['happy', 'boundary', 'error'].includes(c.tag), `${provided.id}/${c.id} tag`);
    }
  }
});

test('the rubric keys are unique and the pass threshold is a percentage', () => {
  const { rubric } = storyTaskBody('Library Shelf');
  assert.equal(new Set(rubric.criteria.map((c) => c.key)).size, rubric.criteria.length);
  assert.ok(rubric.passThreshold >= 1 && rubric.passThreshold <= 100);
});

test('the task title names the project, inside the door cap', () => {
  const b = storyTaskBody('Library Shelf');
  assert.match(b.title, /Library Shelf/);
  assert.ok(b.title.length <= 160);
  assert.ok(storyTaskBody('x'.repeat(400)).title.length <= 160);
});

test('the copy, publish and assign bodies', () => {
  const copy = copyBody('Proof 1760400000000', 'version-1');
  assert.equal(copy.fromVersionId, 'version-1');
  assert.match(copy.slug, /^[a-z][a-z0-9-]{1,47}$/);
  assert.equal(copy.title, 'Proof 1760400000000');
  assert.notEqual(copyBody('Proof', 'v').slug, copyBody('Proof', 'v').slug, 'two copies never share a slug');
  assert.equal(publishBody().version, '1.0.0');
  assert.deepEqual(Object.keys(assignBody('v2')).sort(), ['projectVersionId', 'reason']);
  assert.equal(assignBody('v2').projectVersionId, 'v2');
});

test('the values the proof looks for in the learner\'s phase are this authoring\'s own, never TaskTrackr\'s', () => {
  const body = storyTaskBody('Library Shelf');
  assert.deepEqual(body.story.providedStories.map((one) => one.id), AUTHORED_PROVIDED_IDS);
  assert.deepEqual(body.rubric.criteria.map((one) => one.weight), AUTHORED_WEIGHTS);
  const pack = JSON.parse(readFileSync(new URL('../content/tasktrackr/phases/01-requirements/phase.json', import.meta.url), 'utf8'));
  assert.notDeepEqual(pack.checks.providedStories.map((one) => one.id), AUTHORED_PROVIDED_IDS);
  assert.notDeepEqual(pack.rubric.criteria.map((one) => one.weight), AUTHORED_WEIGHTS);
});
