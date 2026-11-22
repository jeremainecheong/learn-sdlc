import { describe, expect, it } from 'vitest';
import { feedbackFileReferences, feedbackRevisionHref } from '@/components/experience/feedback-targets';

describe('feedback destinations', () => {
  it('links only complete retained file names mentioned in recorded evidence', () => {
    expect(feedbackFileReferences('Check `api/tasks.py:12`, then tests/tasks.test.ts. Missing: not-retained.py.', ['api/tasks.py', 'tests/tasks.test.ts', 'not-mentioned.py'])).toEqual(['api/tasks.py', 'tests/tasks.test.ts']);
    expect(feedbackFileReferences('otherapi/tasks.py ../api/tasks.py api/tasks.py.bak', ['api/tasks.py'])).toEqual([]);
  });
  it('rejects traversal, external URLs and control characters even if recorded as a file name', () => {
    const paths = ['../private.py', '/private.py', 'https://example.test', 'javascript:alert(1)', 'folder\\private.py', 'bad\nfile.py'];
    expect(feedbackFileReferences(paths.join(' '), paths)).toEqual([]);
  });
  it.each([
    ['requirements', '/workspace/phase/issue'], ['design', '/workspace/phase/design'],
    ['implementation', '/workspace/phase'], ['testing', '/workspace/phase'],
    ['deployment', '/workspace/phase'], ['maintenance', '/workspace/phase/change'],
  ] as const)('opens the editable %s work area for a criterion without a file citation', (key, href) => {
    expect(feedbackRevisionHref({ id: 'phase', key, status: 'in_progress' })).toBe(href);
  });
  it('encodes file query values without changing phase gates', () => {
    expect(feedbackRevisionHref({ id: 'phase', key: 'testing', status: 'in_progress' }, 'tests/my test.py')).toBe('/workspace/phase?file=tests%2Fmy+test.py');
    expect(feedbackRevisionHref({ id: 'phase', key: 'requirements', status: 'in_progress' }, 'story.md')).toBe('/workspace/phase/issue?file=story.md');
    expect(feedbackRevisionHref({ id: 'phase', key: 'design', status: 'locked' }, 'design.json')).toBe('/phases');
  });
});
