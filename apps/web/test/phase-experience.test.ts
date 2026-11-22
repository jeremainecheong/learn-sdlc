import { readPipeline } from '@/components/workspace/panels/deployment/ci';
import { describe, expect, it } from 'vitest';
import { parseSequence } from '../components/workspace/panels/design/diagram';
import { EMPTY_DESIGN, serialiseDesign, validateDesignRecord } from '@learnsdlc/shared';
import { EMPTY_STORY, parseStoryJson, serialiseStory } from '../components/workspace/panels/requirements/story';

describe('authored phase evidence survives serialization', () => {
 it('keeps epic relationships with the assigned story through the record', () => {
  const source = { ...EMPTY_STORY, title: 'Late loans', epics: [{ id: 'EP-3', title: 'Keep borrowing current', outcome: 'Readers can identify overdue loans.' }], parentEpicId: 'EP-3' };
  const reopened = parseStoryJson(serialiseStory(source));
  expect(reopened.epics).toEqual(source.epics);
  expect(reopened.parentEpicId).toBe('EP-3');
 });
 it('preserves a sequence beside model edits through the design record', () => {
  const raw = serialiseDesign({ ...EMPTY_DESIGN, sequence: 'Browser -> Route: request\nRoute --> Browser: result' });
  const reopened = validateDesignRecord(raw);
  expect(reopened.error).toBeNull();
  if (!reopened.design) throw new Error('Design did not validate');
  expect(reopened.design.sequence).toContain('Route --> Browser: result');
  const edited = validateDesignRecord(serialiseDesign({
   ...reopened.design,
   entities: [{ id: 'E1', name: 'Item', kind: 'class', attributes: [{ name: 'id', type: 'integer' }], responsibilities: [], satisfies: [] }],
  }));
  expect(edited.design?.sequence).toBe('Browser -> Route: request\nRoute --> Browser: result');
  expect(edited.design?.entities[0].attributes).toEqual([{ name: 'id', type: 'integer' }]);
 });
});
describe('sequence authoring grammar', () => {
 it('distinguishes calls from replies and preserves participant order and full labels', () => {
  expect(parseSequence('# Plan\nBrowser -> Route: GET /api/items\nRoute -> Store: read\nStore --> Route: rows\nRoute --> Browser: 200 + JSON')).toEqual({ participants: ['Browser', 'Route', 'Store'], messages: [{ from: 'Browser', to: 'Route', label: 'GET /api/items', reply: false }, { from: 'Route', to: 'Store', label: 'read', reply: false }, { from: 'Store', to: 'Route', label: 'rows', reply: true }, { from: 'Route', to: 'Browser', label: '200 + JSON', reply: true }], errors: [] });
 });
 it('reports malformed lines and unsupported self calls instead of displaying a successful diagram', () => {
  const result = parseSequence('Route -> Route: self\nThis is not a message\nBrowser -> Route: valid');
  expect(result.errors).toHaveLength(2);
  expect(result.errors[0]).toContain('Line 1');
  expect(result.errors[1]).toContain('Line 2');
  expect(result.messages).toHaveLength(1);
 });
 it('bounds a large diagram and reports that it was rejected', () => {
  const result = parseSequence(Array.from({ length: 40 }, (_, i) => `Actor${i} -> Actor${i + 1}: message`).join('\n'));
  expect(result.errors).toEqual(['Use at most eight participants in one diagram.', 'Use at most thirty messages in one diagram.']);
  expect(result.participants.length).toBe(8);
 });
});

describe('workflow execution evidence', () => {
 it.each([true, false])('rejects legacy selfcheck inference as a workflow result (%s)', (ok) => {
  const pipe = readPipeline('jobs:\n  build:\n    steps:\n      - name: Build image\n        run: docker build .\n', [{job:'build',step:'Build image',ok,detail:`The smoke run of your build ${ok ? 'passed' : 'failed'} here, so this step would go ${ok ? 'green' : 'red'}.`}]);
  expect(pipe.jobs[0].steps[0].state).toBe('skip');
  expect(pipe.jobs[0].steps[0].note).toContain('was not executed');
  expect(pipe.jobs[0].state).toBe('todo');
 });
});
