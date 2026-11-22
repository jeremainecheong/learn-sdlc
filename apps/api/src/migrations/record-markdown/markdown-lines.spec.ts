import { markdownLines } from './markdown-lines';

describe('markdownLines', () => {
  it('reads a comment on lines of its own as one comment line, its text collapsed', () => {
    expect(markdownLines('- one\n<!-- ask Sam\n     about it -->\n- two', false)).toEqual([
      { kind: 'line', raw: '- one' }, { kind: 'comment', text: 'ask Sam about it' }, { kind: 'line', raw: '- two' },
    ]);
  });
  it('takes an inline comment out of the line it sat in, never splitting the line, and keeps its text after it', () => {
    expect(markdownLines('- API_URL <!-- default --> where web sends /api\n- PORT <!-- 8000 -->', false)).toEqual([
      { kind: 'line', raw: '- API_URL where web sends /api' }, { kind: 'comment', text: 'default' },
      { kind: 'line', raw: '- PORT' }, { kind: 'comment', text: '8000' },
    ]);
  });
  it('leaves out an empty inline comment and, with dropTodo, a TODO(learner) one', () => {
    expect(markdownLines('- PORT <!-- --> and HOST <!-- TODO(learner) name them -->', true)).toEqual([{ kind: 'line', raw: '- PORT and HOST' }]);
  });
});
