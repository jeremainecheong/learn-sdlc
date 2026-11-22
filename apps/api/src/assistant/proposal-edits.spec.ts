import {
  AGENT_EDIT_LIST_SCHEMA_NAME,
  EDIT_EXPANSION_CODES,
  EDIT_LIST_LIMITS,
  EditExpansionError,
  agentEditListSchema,
  editListContract,
  editListRefusalReason,
  expandEditList,
  isEditMatchFailure,
  PROPOSAL_SUMMARY_SENTENCE,
  readProposalSummary,
} from './proposal-edits';

/**
 * The pure expansion of a bounded edit list against the bytes the model was
 * shown.
 * Nothing here reads a repository, the clock or the content pack.
 */
const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof EditExpansionError) return error.code;
    throw error;
  }
  throw new Error('expected an EditExpansionError');
};

describe('expandEditList', () => {
  const base = { 'a.py': 'x = 1\ny = 2\n', 'b.md': '# Notes\n' };

  it('expands one edit that matches the base exactly once', () => {
    const out = expandEditList(base, { files: [], edits: [{ path: 'a.py', oldString: 'x = 1', newString: 'x = 0' }] });
    expect(out).toEqual({ files: { 'a.py': 'x = 0\ny = 2\n' }, editCount: 1, wholeFileCount: 0, summary: null });
  });

  it('rejects an edit whose oldString is absent, with no partial patch and no model text in the error', () => {
    const secret = 'SENTINEL-MODEL-TEXT';
    let thrown: unknown;
    try {
      expandEditList(base, { files: [], edits: [{ path: 'a.py', oldString: 'x = 1', newString: 'x = 0' }, { path: 'b.md', oldString: secret, newString: 'z' }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EditExpansionError);
    expect((thrown as EditExpansionError).code).toBe('no_match');
    expect(String(thrown)).not.toContain(secret);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(base['a.py']).toBe('x = 1\ny = 2\n');
  });

  it('rejects an oldString that appears twice rather than guessing which one', () => {
    expect(codeOf(() => expandEditList({ 'a.py': 'due <= ?\ndue <= ?\n' }, { files: [], edits: [{ path: 'a.py', oldString: 'due <= ?', newString: 'due < ?' }] }))).toBe('multiple_matches');
  });

  it('rejects overlapping edits, including one repeated twice', () => {
    const edits = [{ path: 'a.py', oldString: 'x = 1\ny', newString: 'X' }, { path: 'a.py', oldString: '1\ny = 2', newString: 'Y' }];
    expect(codeOf(() => expandEditList(base, { files: [], edits }))).toBe('overlapping_edits');
    const once = { path: 'a.py', oldString: 'x = 1', newString: 'x = 0' };
    expect(codeOf(() => expandEditList(base, { files: [], edits: [once, once] }))).toBe('overlapping_edits');
  });

  it('matches every edit against the unmodified base, never against another edit\'s output', () => {
    const reversed = expandEditList(base, { files: [], edits: [{ path: 'a.py', oldString: 'y = 2', newString: 'y = 3' }, { path: 'a.py', oldString: 'x = 1', newString: 'x = 0' }] });
    expect(reversed.files['a.py']).toBe('x = 0\ny = 3\n');
    expect(codeOf(() => expandEditList(base, { files: [], edits: [{ path: 'a.py', oldString: 'x = 1', newString: 'x = 9' }, { path: 'a.py', oldString: 'x = 9', newString: 'x = 8' }] }))).toBe('no_match');
  });

  it('preserves CRLF line endings byte for byte', () => {
    expect(expandEditList({ 'a.py': 'a\r\nb\r\n' }, { files: [], edits: [{ path: 'a.py', oldString: 'a\r\nb', newString: 'A\r\nB' }] }).files['a.py']).toBe('A\r\nB\r\n');
    expect(expandEditList({ 'a.py': 'a\r\nb\r\n' }, { files: [], edits: [{ path: 'a.py', oldString: 'a\r\n', newString: 'a\n' }] }).files['a.py']).toBe('a\nb\r\n');
  });

  it('preserves the presence or absence of a final newline', () => {
    expect(expandEditList({ 'a.py': 'last' }, { files: [], edits: [{ path: 'a.py', oldString: 'last', newString: 'final' }] }).files['a.py']).toBe('final');
    expect(expandEditList({ 'a.py': 'last' }, { files: [], edits: [{ path: 'a.py', oldString: 'last', newString: 'last\n' }] }).files['a.py']).toBe('last\n');
  });

  it('applies an edit whose text is non-ASCII', () => {
    expect(expandEditList({ 'a.md': '任务 🗓️ 到期\n' }, { files: [], edits: [{ path: 'a.md', oldString: '🗓️ 到期', newString: '🗓️ 逾期' }] }).files['a.md']).toBe('任务 🗓️ 逾期\n');
  });

  it('refuses an edit or a file for a path outside the expansion base', () => {
    // Every editable path is always present in the base, so this is the
    // hallucinated or non-editable path, in either array.
    expect(codeOf(() => expandEditList(base, { files: [], edits: [{ path: 'secret.py', oldString: 'x', newString: 'y' }] }))).toBe('unknown_path');
    expect(codeOf(() => expandEditList(base, { files: [{ path: 'secret.py', contents: 'x' }], edits: [] }))).toBe('unknown_path');
  });

  it('passes whole file contents through unchanged', () => {
    expect(expandEditList(base, { files: [{ path: 'b.md', contents: '# Rewritten\r\n' }], edits: [] })).toEqual({ files: { 'b.md': '# Rewritten\r\n' }, editCount: 0, wholeFileCount: 1, summary: null });
  });

  it('expands a mixed response: one file rewritten, another edited', () => {
    expect(expandEditList(base, { files: [{ path: 'b.md', contents: '# New\n' }], edits: [{ path: 'a.py', oldString: 'y = 2', newString: 'y = 5' }] }).files)
      .toEqual({ 'a.py': 'x = 1\ny = 5\n', 'b.md': '# New\n' });
  });

  it.each([
    ['empty_old_string', { files: [], edits: [{ path: 'a.py', oldString: '', newString: 'z' }] }],
    ['path_in_both', { files: [{ path: 'a.py', contents: 'z' }], edits: [{ path: 'a.py', oldString: 'x', newString: 'z' }] }],
    ['duplicate_path', { files: [{ path: 'a.py', contents: 'z' }, { path: 'a.py', contents: 'w' }], edits: [] }],
    ['too_many_edits', { files: [], edits: Array.from({ length: EDIT_LIST_LIMITS.maxEdits + 1 }, (_, at) => ({ path: 'a.py', oldString: `n${at}`, newString: 'z' })) }],
    ['edit_too_large', { files: [], edits: [{ path: 'a.py', oldString: 'x = 1', newString: 'z'.repeat(EDIT_LIST_LIMITS.maxEditChars) }] }],
    ['payload_too_large', { files: [{ path: 'b.md', contents: 'z'.repeat(EDIT_LIST_LIMITS.maxPayloadChars) }], edits: [] }],
  ])('refuses %s', (code, value) => {
    expect(codeOf(() => expandEditList(base, value))).toBe(code);
  });

  it('returns an empty patch for two empty arrays rather than failing (guard)', () => {
    expect(expandEditList(base, { files: [], edits: [] })).toEqual({ files: {}, editCount: 0, wholeFileCount: 0, summary: null });
  });

  it.each([
    [null, 'not_object'],
    [[], 'not_object'],
    [{}, 'unexpected_field'],
    [{ files: [] }, 'unexpected_field'],
    [{ files: [], edits: [], extra: 1 }, 'unexpected_field'],
    [{ files: [], edits: [], summary: 'Changes a.py.', extra: 1 }, 'unexpected_field'],
    [{ summary: 'Changes a.py.', edits: [] }, 'unexpected_field'],
    [{ files: 'x', edits: [] }, 'bad_files_entry'],
    [{ files: [], edits: [{ path: 'a.py', oldString: 'x' }] }, 'bad_edits_entry'],
    [{ files: [{ path: 'a.py', contents: 1 }], edits: [] }, 'bad_files_entry'],
  ])('refuses a malformed envelope %j as %s', (value, code) => {
    expect(codeOf(() => expandEditList(base, value))).toBe(code);
  });

  it('returns the summary the model wrote beside its edits', () => {
    const out = expandEditList(base, { files: [], edits: [{ path: 'a.py', oldString: 'x = 1', newString: 'x = 0' }], summary: 'Changes x in a.py. Check the new value.' });
    expect(out).toEqual({ files: { 'a.py': 'x = 0\ny = 2\n' }, editCount: 1, wholeFileCount: 0, summary: 'Changes x in a.py. Check the new value.' });
  });

  it.each([
    ['absent', { files: [], edits: [] }],
    ['a number', { files: [], edits: [], summary: 7 }],
    ['null', { files: [], edits: [], summary: null }],
    ['a list', { files: [], edits: [], summary: ['Changes a.py.'] }],
    ['blank', { files: [], edits: [], summary: '   ' }],
  ])('reads a summary that is %s as null, and still expands the edits', (_label, value) => {
    expect(expandEditList(base, value)).toEqual({ files: {}, editCount: 0, wholeFileCount: 0, summary: null });
  });

  // A pure deletion is a bounded edit, and the server accepts it.
  it('expands an empty newString: a deletion stays expressible', () => {
    expect(expandEditList({ 'a.py': 'return True or ok\n' }, { files: [], edits: [{ path: 'a.py', oldString: 'True or ', newString: '' }] }).files['a.py']).toBe('return ok\n');
  });

  it('draws every refusal from the closed set, and names the three that mean the text did not match', () => {
    expect(EDIT_EXPANSION_CODES).toEqual(['not_object', 'unexpected_field', 'bad_files_entry', 'bad_edits_entry', 'too_many_edits', 'edit_too_large', 'payload_too_large', 'unknown_path', 'path_in_both', 'duplicate_path', 'empty_old_string', 'no_match', 'multiple_matches', 'overlapping_edits']);
    expect(EDIT_EXPANSION_CODES.filter(isEditMatchFailure)).toEqual(['no_match', 'multiple_matches', 'overlapping_edits']);
  });
});

describe('the edit-list contract the model is given', () => {
  it('builds a strict schema that constrains paths and counts without an unsupported keyword', () => {
    const schema = agentEditListSchema(['b.md', 'a.py']);
    expect(schema.name).toBe(AGENT_EDIT_LIST_SCHEMA_NAME);
    expect(AGENT_EDIT_LIST_SCHEMA_NAME).toBe('agent_proposal_edits_v1');
    const root = schema.schema as any;
    const objects = [root, root.properties.files.items, root.properties.edits.items];
    expect(root.required).toContain('summary');
    expect(root.properties.summary).toEqual({ type: 'string' });
    for (const object of objects) {
      expect(object.type).toBe('object');
      expect(object.additionalProperties).toBe(false);
      expect([...object.required].sort()).toEqual(Object.keys(object.properties).sort());
    }
    expect(root.properties.files.items.properties.path.enum).toEqual(['a.py', 'b.md']);
    expect(root.properties.edits.items.properties.path.enum).toEqual(['a.py', 'b.md']);
    expect(root.properties.edits.maxItems).toBe(24);
    expect(root.properties.files.maxItems).toBe(2);
    const text = JSON.stringify(schema);
    for (const keyword of ['anyOf', 'oneOf', 'allOf', '"not"', 'maxLength', 'pattern', 'patternProperties', '$ref', 'description', 'format', 'default']) {
      expect(text).not.toContain(keyword);
    }
    expect(() => agentEditListSchema([])).toThrow();
  });

  it('words the contract the server actually enforces', () => {
    const text = editListContract('proposedWorkspace');
    for (const phrase of ['EXACTLY ONCE', 'byte for byte', 'proposedWorkspace', '24']) expect(text).toContain(phrase);
    expect(text).not.toContain('savedWorkspace');
    // Only oldString must be non-empty; a deletion is allowed.
    expect(text).toContain('oldString must be non-empty');
    expect(text).not.toContain('newString must');
    expect(editListContract('workspace')).toContain('out of workspace');
  });

  it('asks for the learner\'s summary: what the proposal changes, what to read and what to run after Apply, never why, every changed file by its path', () => {
    const sentence = 'Also return "summary": at most three short present-tense statements for the learner ("Changes ...", "Adds ..."), naming by its path every file this proposal changes (each one when it changes several) and which record sections change, what to read before explaining it and, only if this phase has something to run, what to run after Apply; never why it is right or what it means for the system.';
    expect(PROPOSAL_SUMMARY_SENTENCE).toBe(sentence);
    // A summary that names its files in words ("the two requested Python files") leaves a learner unable to tell
    // which file to open, so the sentence asks for each path.
    expect(PROPOSAL_SUMMARY_SENTENCE).toContain('naming by its path every file this proposal changes (each one when it changes several)');
    // The summary is read before Apply, so it is a proposal in the present tense, and
    // nothing that needs saved files (tests, the selfcheck, the drill) is asked for before accepting.
    expect(PROPOSAL_SUMMARY_SENTENCE).toContain('present-tense');
    // Statements that describe the proposal, not instructions to the learner, and a run step only
    // where the phase has something to run (not "run nothing after Apply" in Requirements or Design).
    expect(PROPOSAL_SUMMARY_SENTENCE).toContain('present-tense statements for the learner ("Changes ...", "Adds ...")');
    expect(PROPOSAL_SUMMARY_SENTENCE).toContain('what to read before explaining it and, only if this phase has something to run, what to run after Apply');
    expect(PROPOSAL_SUMMARY_SENTENCE).not.toMatch(/before accepting|what changed/);
    for (const key of ['proposedWorkspace', 'workspace'] as const) {
      const text = editListContract(key);
      expect(text).toContain(`Use files only for a deliberate full rewrite of one file. ${sentence} At most`);
      expect(text.split(sentence)).toHaveLength(2);
    }
  });
});

describe('readProposalSummary', () => {
  it('keeps a short summary, trimmed and with its whitespace collapsed to single spaces', () => {
    expect(readProposalSummary('  Changes tasks.py.\n\n  Check   the\tboundary.  ')).toBe('Changes tasks.py. Check the boundary.');
  });

  it('cuts a long summary at the last sentence end before 600 characters', () => {
    const first = `${'a'.repeat(400)}.`;
    const second = ` ${'b'.repeat(300)}.`;
    expect(readProposalSummary(first + second)).toBe(first);
    const question = `${'c'.repeat(500)}?`;
    expect(readProposalSummary(`${question} ${'d'.repeat(200)}`)).toBe(question);
  });

  it('keeps a summary of exactly 600 characters whole, sentence end or not', () => {
    const exact = 'e'.repeat(600);
    expect(readProposalSummary(exact)).toBe(exact);
  });

  it('cuts at 600 characters when no sentence ends before the cap', () => {
    expect(readProposalSummary('f'.repeat(900))).toBe('f'.repeat(600));
    // A full stop inside a word (a path) is not a sentence end.
    const pathy = `Changes tasks.py ${'g'.repeat(700)}`;
    expect(readProposalSummary(pathy)).toBe(pathy.slice(0, 600));
  });

  it.each([
    ['empty', ''],
    ['blank', ' \n\t '],
    ['a number', 3],
    ['null', null],
    ['undefined', undefined],
    ['an object', { text: 'Changes a.py.' }],
    ['a list', ['Changes a.py.']],
  ])('reads %s as null, and never throws', (_label, value) => {
    expect(readProposalSummary(value)).toBeNull();
  });
});

/**
 * A refused edit list reaches the learner with its reason, in platform words: a runbook request answered as
 * field-by-field edits of the JSON record may quote `"purpose": ""`, which the record holds four times, and the
 * learner must read why, not that the AI did not answer.
 */
describe('editListRefusalReason', () => {
  const runbook = '{\n  "environment": [\n    { "id": "E1", "purpose": "" },\n    { "id": "E2", "purpose": "" }\n  ]\n}\n';
  const base = { 'deployment/runbook.json': runbook, 'a.py': 'x = 1\n' };
  const reasonOf = (value: unknown): string => {
    try { expandEditList(base, value); } catch (error) {
      if (error instanceof EditExpansionError) return editListRefusalReason(error);
      throw error;
    }
    throw new Error('expected an EditExpansionError');
  };
  const edit = (path: string, oldString: string, newString = 'x') => ({ files: [], edits: [{ path, oldString, newString }] });

  it('names the file and says the quoted text is not unique, or not there', () => {
    expect(reasonOf(edit('deployment/runbook.json', '"purpose": ""'))).toBe('An edit to deployment/runbook.json quotes text that appears more than once in that file.');
    expect(reasonOf(edit('deployment/runbook.json', '"purpose": "",\n "kind"'))).toBe('An edit to deployment/runbook.json quotes text that is not in that file.');
    expect(reasonOf({ files: [], edits: [{ path: 'a.py', oldString: 'x = 1', newString: 'x = 2' }, { path: 'a.py', oldString: '= 1', newString: '= 3' }] })).toBe('Two edits to a.py overlap.');
    expect(reasonOf(edit('a.py', ''))).toBe('An edit to a.py quotes no text.');
    expect(reasonOf({ files: [{ path: 'a.py', contents: 'y' }], edits: [{ path: 'a.py', oldString: 'x', newString: 'y' }] })).toBe('The proposal gives a.py both whole and as edits.');
    expect(reasonOf({ files: [{ path: 'a.py', contents: 'y' }, { path: 'a.py', contents: 'z' }], edits: [] })).toBe('The proposal gives a.py whole twice.');
    expect(reasonOf(edit('a.py', 'x'.repeat(EDIT_LIST_LIMITS.maxEditChars)))).toBe(`An edit to a.py is longer than ${EDIT_LIST_LIMITS.maxEditChars} characters.`);
  });

  it('never repeats a path the model invented, nor any text it wrote', () => {
    expect(reasonOf(edit('SENTINEL/not-a-file.py', 'x'))).toBe('An edit names a file this phase does not have.');
    expect(reasonOf(edit('SENTINEL/not-a-file.py', 'x'.repeat(EDIT_LIST_LIMITS.maxEditChars)))).toBe(`An edit is longer than ${EDIT_LIST_LIMITS.maxEditChars} characters.`);
    expect(reasonOf({ files: [], edits: Array.from({ length: EDIT_LIST_LIMITS.maxEdits + 1 }, () => ({ path: 'a.py', oldString: 'SENTINEL', newString: 'y' })) })).toBe(`The proposal has more than ${EDIT_LIST_LIMITS.maxEdits} edits.`);
    for (const value of [null, { files: [], edits: [], extra: 1 }, { files: 'SENTINEL', edits: [] }, { files: [], edits: [{ path: 'a.py' }] }]) {
      expect(reasonOf(value)).toBe('The proposal is not in the edit-list shape.');
    }
    expect(reasonOf({ files: [{ path: 'a.py', contents: 'SENTINEL'.repeat(EDIT_LIST_LIMITS.maxPayloadChars / 8) }], edits: [] })).toBe('The proposal is larger than an edit list may be.');
  });

  it('has a sentence for every code in the closed set, none naming a path it was not given', () => {
    for (const code of EDIT_EXPANSION_CODES) {
      const said = editListRefusalReason(new EditExpansionError(code));
      expect(said).toMatch(/^[A-Z].*\.$/);
      expect(said).not.toMatch(/undefined|null/);
    }
  });
});
