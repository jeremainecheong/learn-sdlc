import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_DESIGN_FLOOR, DESIGN_CAPS, EMPTY_DESIGN, serialiseDesign, validateDesignRecord, type Design } from '@learnsdlc/shared';
import type { ContentFileSpec } from './content.types';
import { designChecksFromLegacyMarkdown } from './design-legacy';
import { FIXTURES_DIR } from '../../test/fixtures/paths';

/** TaskTrackr 3.0.0's markdown Design phase, kept as the adapter's input after the design kind retired it. */
const FIXTURES = join(FIXTURES_DIR, 'legacy-design');
const file = (path: string, source: string, editable: boolean): ContentFileSpec => ({
  path,
  content: readFileSync(join(FIXTURES, source), 'utf8'),
  editable,
  language: path.endsWith('.json') ? 'json' : 'markdown',
});
const files = [
  file('requirements/provided-stories.md', 'provided-stories.md', false),
  file('design/architecture.md', 'architecture.md', false),
  file('design/my-design.md', 'my-design.md', true),
  file('design/design.json', 'design.json', true),
  file('shared/contract/api.json', 'api.json', true),
  file('shared/contract/screens.json', 'screens.json', true),
];
const phaseJson = JSON.parse(readFileSync(join(FIXTURES, 'phase.json'), 'utf8'));

describe('designChecksFromLegacyMarkdown', () => {
  const out = designChecksFromLegacyMarkdown(files, phaseJson.checks, phaseJson.rubric);

  it('drops every markdown file and folds the board record', () => {
    expect(out.files.map((f) => f.path)).toEqual(['design/design.json', 'shared/contract/api.json', 'shared/contract/screens.json']);
    const record = validateDesignRecord(out.files[0].content);
    expect(record.error).toBeNull();
    expect(record.design!.entities[0]).toMatchObject({ name: 'Model', kind: 'class', responsibilities: [] });
    expect(record.design!.operations.map((o) => o.id)).toEqual(['O1', 'O2', 'O3']);
    // the 3.0.0 record's ordering and boundary are blank, so no operation gains a note and nothing reaches notes
    expect(record.design!.operations.some((o) => 'note' in o)).toBe(false);
    expect(record.design!.notes).toBeUndefined();
    expect(out.note).toContain("the board's record was folded (1 field became the attributes of the entity Model)");
    expect(out.note).toContain('3 markdown files dropped');
  });

  it('switches on the contracts the phase mounts, leaves the sequence diagram off and takes the default floor with no stories', () => {
    expect(out.checks).toEqual({ kind: 'design', record: 'design/design.json', contracts: { api: true, screens: true }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR });
    expect(out.note).toContain('the sequence diagram off');
  });

  it('turns each rule into a sentence of its criterion and keeps keys, titles and weights', () => {
    const traceability = out.rubric!.criteria.find((c) => c.key === 'traceability')!;
    expect(traceability.weight).toBe(0.25);
    expect(traceability.title).toBe('Traceability to the backlog');
    expect(traceability.description).toBe('US-2 lands somewhere in the design. US-3 lands somewhere in the design. US-4 lands somewhere in the design.');
    expect(out.rubric!.criteria.map((c) => c.key)).toEqual(['traceability', 'data_model', 'api_contract', 'screen_contract', 'decision_justification']);
    expect(out.rubric!.criteria.map((c) => c.weight)).toEqual([0.25, 0.25, 0.25, 0.15, 0.1]);
    expect(out.rubric!.passThreshold).toBe(70);
    expect(out.note).toMatch(/^Design converted from markdown: 12 rules became criterion sentences/);
  });

  it('turns off a contract the phase does not mount', () => {
    const noScreens = designChecksFromLegacyMarkdown(files.filter((f) => !f.path.endsWith('screens.json')), phaseJson.checks, phaseJson.rubric);
    expect(noScreens.checks.contracts).toEqual({ api: true, screens: false });
    expect(noScreens.note).toContain('the screen contract off');
  });

  it('makes each kept contract editable JSON, as the record is, so a read-only contract never becomes a graded document the learner cannot write', () => {
    const readOnly = files.map((f) => (f.path.startsWith('shared/contract/') ? { ...f, editable: false, language: 'text' } : f));
    const out4 = designChecksFromLegacyMarkdown(readOnly, phaseJson.checks, phaseJson.rubric);
    expect(out4.files.map((f) => [f.path, f.editable, f.language])).toEqual([
      ['design/design.json', true, 'json'],
      ['shared/contract/api.json', true, 'json'],
      ['shared/contract/screens.json', true, 'json'],
    ]);
  });

  it('keeps a record already in the new shape as it was, and replaces one it cannot read with the empty record', () => {
    const design: Design = { entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }], relations: [], operations: [], decisions: [] };
    const swap = (content: string) => files.map((f) => (f.path === 'design/design.json' ? { ...f, content } : f));
    const kept = designChecksFromLegacyMarkdown(swap(serialiseDesign(design)), phaseJson.checks, phaseJson.rubric);
    expect(validateDesignRecord(kept.files[0].content).design).toEqual(design);
    expect(kept.note).not.toContain('folded');
    const broken = designChecksFromLegacyMarkdown(swap('not json'), phaseJson.checks, phaseJson.rubric);
    expect(broken.files[0].content).toBe(serialiseDesign(EMPTY_DESIGN));
    expect(broken.note).toContain('the starting record could not be read (The design record is not valid JSON), so it starts empty');
  });

  it('folds a valid record that still carries an older key, so the key is not dropped unread', () => {
    // valid as it stands (the validator drops `fields`), and older in shape: the fold keeps the field
    const older = JSON.stringify({ entities: [], relations: [], operations: [], decisions: [], fields: [{ name: 'due_date', type: 'date' }] });
    expect(validateDesignRecord(older).error).toBeNull();
    const out2 = designChecksFromLegacyMarkdown(files.map((f) => (f.path === 'design/design.json' ? { ...f, content: older } : f)), phaseJson.checks, phaseJson.rubric);
    expect(validateDesignRecord(out2.files[0].content).design!.entities[0].attributes[0].name).toBe('due_date');
  });

  it('folds a valid record that carries an older key even when its note is full: the part that does not fit is cut and named, never the record emptied', () => {
    // valid as it stands (the validator drops `ordering`), older in shape, and the fold's ordering does not fit beside the note
    const operation = { id: 'O1', name: 'listTasks', inputs: [], returns: 'the tasks', errors: [], satisfies: [], note: 'n'.repeat(DESIGN_CAPS.fieldChars - 5), ordering: 'by due date' };
    const older = JSON.stringify({ entities: [], relations: [], operations: [operation], decisions: [] });
    expect(validateDesignRecord(older).error).toBeNull();
    const out3 = designChecksFromLegacyMarkdown(files.map((f) => (f.path === 'design/design.json' ? { ...f, content: older } : f)), phaseJson.checks, phaseJson.rubric);
    const { ordering: _ordering, ...kept } = operation;
    expect(validateDesignRecord(out3.files[0].content).design!.operations).toEqual([kept]);
    expect(out3.note).toContain('1 part of the note of O1 left out: over the 4000-character cap');
    expect(out3.note).not.toContain('starts empty');
  });

  it('keeps whole sentences up to the 400-character cap and names the ones left out', () => {
    const long = 'x'.repeat(250);
    const rules = [
      { id: 'a', label: `${long} one`, criterion: 'traceability', pattern: 'a', required: true, failDetail: 'f' },
      { id: 'b', label: `${long} two.`, criterion: 'traceability', pattern: 'b', required: true, failDetail: 'f' },
    ];
    const capped = designChecksFromLegacyMarkdown(files, { ...phaseJson.checks, rules }, phaseJson.rubric);
    const traceability = capped.rubric!.criteria.find((c) => c.key === 'traceability')!;
    expect(traceability.description).toBe(`${long} one.`);
    // a criterion no rule scored keeps its own description
    expect(capped.rubric!.criteria.find((c) => c.key === 'data_model')!.description).toBe(phaseJson.rubric.criteria[1].description);
    expect(capped.note).toContain(`1 rule sentence did not fit its criterion and was left out: ${long} two.`);
  });

  it("keeps a teacher's own criterion wording in front of its rule sentences, and names it in the note", () => {
    const rubric = { ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string }) => (c.key === 'traceability' ? { ...c, title: 'Every story lands', description: 'Each story is named where it is served' } : c)) };
    const kept = designChecksFromLegacyMarkdown(files, phaseJson.checks, rubric, new Set(['traceability']));
    const traceability = kept.rubric!.criteria.find((c) => c.key === 'traceability')!;
    expect(traceability.title).toBe('Every story lands');
    expect(traceability.description).toBe('Each story is named where it is served. US-2 lands somewhere in the design. US-3 lands somewhere in the design. US-4 lands somewhere in the design.');
    expect(kept.note).toContain('the teacher\'s own wording of "Every story lands" kept in front of its rule sentences');
    // a criterion not named keeps the plain conversion
    expect(kept.rubric!.criteria.find((c) => c.key === 'screen_contract')!.description).toBe('The overdue screen names its component, its operation and its empty state.');
  });

  it("cuts whole rule sentences after a teacher's wording at the cap, and names the cut", () => {
    const wording = `${'w'.repeat(329)}.`;
    const rubric = { ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string }) => (c.key === 'traceability' ? { ...c, description: wording } : c)) };
    const cut = designChecksFromLegacyMarkdown(files, phaseJson.checks, rubric, new Set(['traceability']));
    expect(cut.rubric!.criteria.find((c) => c.key === 'traceability')!.description).toBe(`${wording} US-2 lands somewhere in the design.`);
    expect(cut.note).toContain('2 rule sentences did not fit their criteria and were left out: US-3 lands somewhere in the design. US-4 lands somewhere in the design.');
  });

  it("cuts a teacher's wording longer than the cap at its last sentence end, moves the rule sentences to the left-out list, and names both", () => {
    const withWording = (key: string, description: string) => ({ ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string }) => (c.key === key ? { ...c, description } : c)) });
    const first = `${'a'.repeat(300)}.`;
    const long = `${first} ${'b'.repeat(149)}.`;
    const over = designChecksFromLegacyMarkdown(files, phaseJson.checks, withWording('traceability', long), new Set(['traceability']));
    const description = over.rubric!.criteria.find((c) => c.key === 'traceability')!.description;
    expect(description.length).toBeLessThanOrEqual(400);
    expect(description).toBe(first);
    expect(over.note).toContain('the teacher\'s own wording of "Traceability to the backlog" cut to 400 characters');
    expect(over.note).toContain('3 rule sentences did not fit their criteria and were left out: US-2 lands somewhere in the design. US-3 lands somewhere in the design. US-4 lands somewhere in the design.');
    expect(over.note).not.toContain('kept in front');
    // no sentence ends within the cap: cut at the last word boundary, then a full stop
    const words = Array.from({ length: 90 }, () => 'word').join(' ');
    const byWord = designChecksFromLegacyMarkdown(files, phaseJson.checks, withWording('traceability', words), new Set(['traceability']));
    const cutWords = byWord.rubric!.criteria.find((c) => c.key === 'traceability')!.description;
    expect(cutWords.length).toBeLessThanOrEqual(400);
    expect(cutWords).toMatch(/^(word )+word\.$/);
    // 80 whole words (399 characters) and the full stop
    expect(cutWords).toBe(`${Array.from({ length: 80 }, () => 'word').join(' ')}.`);
    // a teacher's wording on a criterion no rule scored is held to the same cap
    const unscored = { ...phaseJson.checks, rules: phaseJson.checks.rules.filter((r: { criterion: string }) => r.criterion !== 'decision_justification') };
    const noRules = designChecksFromLegacyMarkdown(files, unscored, withWording('decision_justification', long), new Set(['decision_justification']));
    expect(noRules.rubric!.criteria.find((c) => c.key === 'decision_justification')!.description).toBe(first);
    expect(noRules.note).toContain('the teacher\'s own wording of "Justified decisions" cut to 400 characters');
  });

  it("keeps a teacher's wording of exactly the cap whole, with no cut named", () => {
    const exact = `${'e'.repeat(399)}.`;
    const rubric = { ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string }) => (c.key === 'traceability' ? { ...c, description: exact } : c)) };
    const whole = designChecksFromLegacyMarkdown(files, phaseJson.checks, rubric, new Set(['traceability']));
    expect(whole.rubric!.criteria.find((c) => c.key === 'traceability')!.description).toBe(exact);
    expect(whole.note).not.toContain('cut to 400 characters');
    // no rule sentence follows a wording that fills the cap, and the note says so rather than "in front of"
    expect(whole.note).toContain('the teacher\'s own wording of "Traceability to the backlog" kept whole; its rule sentences left out');
    expect(whole.note).not.toContain('kept in front');
    // the left-out list closes with its own stop: the note does not end in two
    expect(whole.note.endsWith('..')).toBe(false);
    // exactly the cap with no closing stop: kept whole, no stop appended past the cap, and no cut named
    const open = `Sentence one is here. ${'v'.repeat(378)}`;
    expect(open.length).toBe(400);
    const unclosed = designChecksFromLegacyMarkdown(files, phaseJson.checks, { ...rubric, criteria: rubric.criteria.map((c: { key: string }) => (c.key === 'traceability' ? { ...c, description: open } : c)) }, new Set(['traceability']));
    expect(unclosed.rubric!.criteria.find((c) => c.key === 'traceability')!.description).toBe(open);
    expect(unclosed.note).not.toContain('cut to 400 characters');
  });

  it("never ends a cut at an abbreviation's stop, and never splits a character in two", () => {
    const withWording = (description: string) => ({ ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string }) => (c.key === 'traceability' ? { ...c, description } : c)) });
    const cutOf = (description: string) => designChecksFromLegacyMarkdown(files, phaseJson.checks, withWording(description), new Set(['traceability'])).rubric!.criteria.find((c) => c.key === 'traceability')!.description;
    const abbreviated = cutOf(`See Fig. 3 for ${Array.from({ length: 90 }, () => 'word').join(' ')}`);
    expect(abbreviated).not.toBe('See Fig.');
    expect(abbreviated.startsWith('See Fig. 3 for word')).toBe(true);
    expect(abbreviated.length).toBeLessThanOrEqual(400);
    const emoji = cutOf(`${'a'.repeat(398)}\u{1F600}${'b'.repeat(10)}`);
    expect(emoji).toBe(`${'a'.repeat(398)}.`);
  });

  it('cuts mid-word at the last space before the cap, with a full stop, and names a long description no rule scored', () => {
    const withWording = (key: string, description: string) => ({ ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string }) => (c.key === key ? { ...c, description } : c)) });
    // nine-character periods: index 399 falls inside a word, the last space before it is at 395
    const words = Array.from({ length: 50 }, () => 'abcdefgh').join(' ');
    expect(words[399]).toBe('d');
    const midWord = designChecksFromLegacyMarkdown(files, phaseJson.checks, withWording('traceability', words), new Set(['traceability']));
    expect(midWord.rubric!.criteria.find((c) => c.key === 'traceability')!.description).toBe(`${Array.from({ length: 44 }, () => 'abcdefgh').join(' ')}.`);
    // not the teacher's wording, and no rule scored it: still held to the cap, and named as the description
    const first = `${'a'.repeat(300)}.`;
    const unscored = { ...phaseJson.checks, rules: phaseJson.checks.rules.filter((r: { criterion: string }) => r.criterion !== 'decision_justification') };
    const longPack = designChecksFromLegacyMarkdown(files, unscored, withWording('decision_justification', `${first} ${'b'.repeat(149)}.`));
    expect(longPack.rubric!.criteria.find((c) => c.key === 'decision_justification')!.description).toBe(first);
    expect(longPack.note).toContain('the description of "Justified decisions" cut to 400 characters');
  });

  it('keeps a criterion with no description without one', () => {
    const bare = { ...phaseJson.rubric, criteria: phaseJson.rubric.criteria.map((c: { key: string; description?: string }) => (c.key === 'traceability' ? { key: c.key, title: 'T', weight: 0.25 } : c)) };
    const long = { ...phaseJson.checks, rules: phaseJson.checks.rules.map((r: { criterion: string; label: string }) => (r.criterion === 'traceability' ? { ...r, label: 'x'.repeat(420) } : r)) };
    const none = designChecksFromLegacyMarkdown(files, long, bare);
    expect(none.rubric!.criteria.find((c) => c.key === 'traceability')).toEqual({ key: 'traceability', title: 'T', weight: 0.25 });
  });

  it('keeps the description of a criterion only the word floor scored, since a design has no word floor, and says so', () => {
    const checks = { ...phaseJson.checks, rules: phaseJson.checks.rules.filter((r: { criterion: string }) => r.criterion !== 'decision_justification') };
    const floorOnly = designChecksFromLegacyMarkdown(files, checks, phaseJson.rubric);
    expect(floorOnly.rubric!.criteria.find((c) => c.key === 'decision_justification')!.description).toBe(phaseJson.rubric.criteria[4].description);
    expect(floorOnly.note).toContain('the 900-word floor dropped (a design has no word floor), so "Justified decisions", which only it scored, keeps its own description');
    // with a rule beside the floor, the criterion takes its rule sentences and the floor is dropped all the same
    expect(out.rubric!.criteria.find((c) => c.key === 'decision_justification')!.description).toBe('A decision records its trade-off.');
    expect(out.note).toContain('the 900-word floor dropped (a design has no word floor)');
    expect(out.note).not.toContain('which only it scored');
  });
});
