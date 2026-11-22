// apps/api/src/assistant/story-grounding.spec.ts
import { citableSourcePaths } from './openai.provider';
describe('citableSourcePaths for a story task', () => {
  it('cites every projected field path and never the record file', () => {
    const input = { workspace: { 'story/title': 'Overdue', 'story/so-that': 'I chase it', 'story/notes': '' }, criteria: [], checks: [], overall: 0, hints: 0, ranBeforeSubmit: false,
      task: { checkKind: 'story', owns: ['requirements/story.json'] } } as never;
    expect(citableSourcePaths(input)).toEqual(['story/title', 'story/so-that']);
  });
});
