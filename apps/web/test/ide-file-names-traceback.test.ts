import { describe, expect, it } from 'vitest';
import { shortNames } from '@/components/workspace/ide/derive';
import { learnerFrames } from '@/components/workspace/ide/derive';
import { splitTrace } from '@/components/workspace/trace';

/**
 * The pure halves of two behaviours, driven directly.
 */

describe('shortNames (finding 27)', () => {
  it('keeps a basename that stands on its own', () => {
    const names = shortNames(['api/routes/lists.py', 'web/src/lib/overdue.ts']);
    expect(names.get('api/routes/lists.py')).toBe('lists.py');
    expect(names.get('web/src/lib/overdue.ts')).toBe('overdue.ts');
  });

  it('separates the two files this pack calls tasks.py', () => {
    const names = shortNames(['api/repository/tasks.py', 'api/routes/tasks.py']);
    expect(names.get('api/repository/tasks.py')).toBe('repository/tasks.py');
    expect(names.get('api/routes/tasks.py')).toBe('routes/tasks.py');
  });

  it('walks further up until the whole group is distinct, and no further', () => {
    // One folder is not enough here (two of the three are `x/t.py`) so the
    // group takes two, together, rather than each row picking its own depth
    // and the strip drawing three labels of three different shapes.
    const names = shortNames(['a/x/t.py', 'b/x/t.py', 'c/y/t.py']);
    expect([...names.values()]).toEqual(['a/x/t.py', 'b/x/t.py', 'c/y/t.py']);
    expect(new Set(names.values()).size).toBe(3);
  });
});

describe('the traceback (finding 19)', () => {
  const SHORT = [
    'FFFF                                                                     [100%]',
    'sandbox/python/werkzeug/test.py:1167: in post',
    '    return self.open(*args, **kwargs)',
    'sandbox/python/flask/testing.py:235: in open',
    '    return super().open(...)',
    'tests/test_tasks_api.py:17: in test_overdue_excludes_today',
    '    assert len(body) == 1',
    'E   AssertionError: assert 0 == 1',
  ].join('\n');

  it('reads pytest\'s short frames, not only a raised traceback', () => {
    const trace = splitTrace(SHORT);
    expect(trace).not.toBeNull();
    expect(trace!.own).toEqual([
      'test_tasks_api.py, line 17, in test_overdue_excludes_today — assert len(body) == 1',
    ]);
    expect(trace!.library).toHaveLength(4);
    expect(trace!.headline).toBe('E   AssertionError: assert 0 == 1');
  });

  it('takes the platform out of the terminal and writes the rest as a reference', () => {
    const lines = learnerFrames(SHORT.split('\n'));
    expect(lines.some((l) => l.includes('sandbox/python'))).toBe(false);
    expect(lines).toContain('test_tasks_api.py, line 17, in test_overdue_excludes_today');
  });

  it('leaves a message that is not a traceback alone', () => {
    expect(splitTrace('AssertionError: 3 != 4')).toBeNull();
    expect(learnerFrames(['nothing to see here'])).toEqual(['nothing to see here']);
  });
});
