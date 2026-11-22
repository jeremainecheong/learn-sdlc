import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { filesFor } from './artefacts.mjs';
const require = createRequire(import.meta.url);
const { evaluateDesignFloor } = require('../../packages/shared/dist/index.js');
// TaskTrackr 4.0.0's Design (spec section 7): both contracts and the sequence diagram, US-2 to US-4, and its floor.
const spec = { contracts: { api: true, screens: true }, sequence: true, stories: ['US-2', 'US-3', 'US-4'].map((id) => ({ id, title: id, line: id })),
  floor: { minEntities: 3, minRelations: 2, minOperations: 3, operationShape: true, minDecisions: 1, decisionShape: true, traceEveryStory: true, minEndpoints: 3, requireErrorCatalogue: true, minScreens: 1, screenShape: true } };
const failing = (variant) => evaluateDesignFloor(filesFor(variant), spec).filter((r) => !r.passed).map((r) => r.id);
test('design-strong and design-no-overdue-contract pass the floor; design-thin does not', () => {
  assert.deepEqual(failing('design-strong'), []);
  assert.deepEqual(failing('design-no-overdue-contract'), []);
  assert.ok(failing('design-thin').length >= 5);
  assert.ok(failing('design-thin').includes('design.sequence'));
});
