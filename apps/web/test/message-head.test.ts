/**
 * `messageHead` is the one first-line rule the pull request's threads (at
 * most 200 characters) and the run panel's folded message (at most 240) both
 * draw. The two reference forms below state each surface's rule on its own;
 * the helper must give the same text as each for every message, compared over
 * messages with blank lines, surrounding spaces, carriage returns, and lengths
 * either side of each limit.
 */
import { describe, expect, it } from 'vitest';
import { messageHead } from '@/components/workspace/message-head';

/** The pull request's threads. */
function threadForm(text: string | undefined, max = 200): string {
  const line = (text ?? '').trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

/** The run panel's folded message. */
function runPanelForm(message: string): string {
  const first = message.trim().split('\n')[0];
  return first.length > 240 ? `${first.slice(0, 240).trimEnd()}…` : first;
}

const long = (n: number, tail = '') => `${'a'.repeat(n)}${tail}`;
const MESSAGES: string[] = [
  '',
  ' ',
  '\n\n',
  'assert 1 == 2',
  '  assert 1 == 2  ',
  '\n\n  AssertionError: expected 3\n  where 3 = f()\n',
  'first line  \r\nsecond line',
  '\tTabbed first line\nrest',
  long(199), long(200), long(201), long(239), long(240), long(241),
  long(198, '   b'), long(196, '    tail'), long(236, '    tail'), long(250, '\nnext'),
  `${long(199)} ${long(60)}`,
  `${long(239)} ${long(60)}`,
];

describe('messageHead gives the text each surface\'s own rule gives', () => {
  it.each(MESSAGES.map((m) => [JSON.stringify(m.length > 40 ? `${m.slice(0, 20)}…(${m.length})` : m), m]))(
    'the same for %s',
    (_label, message) => {
      expect(messageHead(message, 200)).toBe(threadForm(message));
      expect(messageHead(message, 240)).toBe(runPanelForm(message));
    },
  );

  it('an absent message is empty, as the threads drew it', () => {
    expect(messageHead(undefined, 200)).toBe(threadForm(undefined));
    expect(messageHead(undefined, 200)).toBe('');
  });
});
