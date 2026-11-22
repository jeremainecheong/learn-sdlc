import * as fs from 'fs';
import * as path from 'path';
import { LEARNER_PICKS, STORY_CAPS, STORY_JSON, validateStoryRecord } from '@learnsdlc/shared';
import { EDITED_MARKDOWN_HEADER, convertWorkspace, hashText, parseStoryMarkdown } from './story-records';

const OWN = 'requirements/my-story.md';
const md = '## US-4 Overdue report\n\n**As a** lead\n**I want** a report\n**So that** I chase it\n\n### Acceptance criteria\n- AC-1 Given a task due yesterday, when I open the report, then it is listed\n\n### Out of scope\n- reminders\n';
const record = (text: string) => JSON.parse(text) as Record<string, unknown>;

/**
 * TaskTrackr 2.0.1's `my-story.md`, byte for byte as the pack shipped it: the
 * frozen copy the legacy adapter's specs also read.
 */
const TEMPLATE_2X = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'legacy-requirements', 'my-story.md'), 'utf8');

/** What the 2.x room rendered from the record (`renderStory`), the shape most stored markdown has. */
const RENDERED_2X = [
  '# US-4 \u00b7 Overdue report',
  '',
  'As a team lead, I want to see every overdue task in one report, so that I can chase them up.',
  '',
  '**Acceptance criteria**',
  '',
  '- **US-4/AC-1** — Given a task due yesterday, when I open the report, then it is listed.',
  '- **US-4/AC-2** — Given a task due today, when I open the report, then it is not listed.',
  '',
  '**Scope note**',
  '',
  'Out of scope for this release: reminders; email.',
  '',
  '**Open questions**',
  '',
  'Does a task with no due date ever appear?',
  '',
].join('\n');

describe('convertWorkspace: the brief', () => {
  test('keeps a valid record and drops the markdown', () => {
    const out = convertWorkspace({ 'requirements/story.json': JSON.stringify({ id: 'US-4', title: 't', persona: 'p', capability: 'c', benefit: 'b', criteria: [], scopeExclusions: [], notes: '', renderHash: 'x' }), 'requirements/my-story.md': md });
    expect(out.outcome).toBe('kept-record');
    expect(out.workspace['requirements/my-story.md']).toBeUndefined();
    expect(JSON.parse(out.workspace['requirements/story.json']).renderHash).toBeUndefined();
  });
  test('parses markdown when there is no record', () => {
    const out = convertWorkspace({ 'requirements/my-story.md': md });
    expect(out.outcome).toBe('parsed-markdown');
    expect(JSON.parse(out.workspace['requirements/story.json']).title).toBe('Overdue report');
  });
  test('an untouched template becomes the empty record, not a fallback', () => {
    const template = '<!-- Write your story below -->\n## US-4 \n\n**As a** \n**I want** \n**So that** \n';
    const out = convertWorkspace({ 'requirements/my-story.md': template });
    expect(out.outcome).toBe('empty-template');
    expect(JSON.parse(out.workspace['requirements/story.json']).notes).toBe('');
  });
  test('garbage falls back with the text in notes', () => {
    const out = convertWorkspace({ 'requirements/my-story.md': 'hello there' });
    expect(out.outcome).toBe('fallback');
    expect(JSON.parse(out.workspace['requirements/story.json']).notes).toContain('hello there');
  });
  test('a workspace without markdown is untouched', () => {
    expect(convertWorkspace({ 'design/x.md': 'x' }).outcome).toBe('untouched');
  });
});

describe('convertWorkspace: what the stored 2.x workspaces hold', () => {
  test('every record it writes passes the validator the grader uses, with the fixed id', () => {
    for (const ws of [{ [OWN]: md }, { [OWN]: TEMPLATE_2X }, { [OWN]: RENDERED_2X }, { [OWN]: 'hello there' }]) {
      const out = convertWorkspace(ws);
      expect(validateStoryRecord(out.workspace[STORY_JSON], 'US-4').error).toBeNull();
      expect(out.workspace[OWN]).toBeUndefined();
    }
  });

  test('the brief\'s bold-label layout fills the sentence, the criterion and the exclusion', () => {
    const story = record(convertWorkspace({ [OWN]: md }).workspace[STORY_JSON]);
    expect(story).toMatchObject({ id: 'US-4', persona: 'lead', capability: 'a report', benefit: 'I chase it', scopeExclusions: ['reminders'], notes: '' });
    expect(story.criteria).toEqual([{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' }]);
  });

  test('TaskTrackr 2.0.1\'s untouched template is the empty record', () => {
    const out = convertWorkspace({ [OWN]: TEMPLATE_2X, [STORY_JSON]: '{\n  "id": "US-4",\n  "title": "",\n  "persona": "",\n  "capability": "",\n  "benefit": "",\n  "criteria": [],\n  "scopeExclusions": [],\n  "notes": ""\n}\n' });
    expect(out.outcome).toBe('empty-template');
    expect(record(out.workspace[STORY_JSON])).toMatchObject({ id: 'US-4', title: '', criteria: [], notes: '' });
  });

  test('the markdown the 2.x room rendered reads back whole', () => {
    const out = convertWorkspace({ [OWN]: RENDERED_2X });
    expect(out.outcome).toBe('parsed-markdown');
    const story = record(out.workspace[STORY_JSON]);
    expect(story).toMatchObject({
      id: 'US-4',
      title: 'Overdue report',
      persona: 'team lead',
      capability: 'to see every overdue task in one report',
      benefit: 'I can chase them up',
      scopeExclusions: ['reminders', 'email'],
      notes: 'Does a task with no due date ever appear?',
    });
    expect((story.criteria as { given: string }[]).map((c) => c.given)).toEqual(['a task due yesterday', 'a task due today']);
  });

  test('a seed record beside a markdown story the learner wrote in the editor is not "kept": the markdown is the work', () => {
    const seed = JSON.stringify({ id: 'US-4', title: '', persona: '', capability: '', benefit: '', criteria: [], scopeExclusions: [], notes: '' });
    const out = convertWorkspace({ [STORY_JSON]: seed, [OWN]: RENDERED_2X });
    expect(out.outcome).toBe('parsed-markdown');
    expect(record(out.workspace[STORY_JSON]).title).toBe('Overdue report');
  });

  test('prose the parser does not place is kept in notes rather than dropped', () => {
    const out = convertWorkspace({ [OWN]: `${RENDERED_2X}\nThe report is its own page, reached from the header.\n` });
    expect(record(out.workspace[STORY_JSON]).notes).toBe('Does a task with no due date ever appear? The report is its own page, reached from the header.');
  });

  test('criteria written as `- AC-1: Given`, `- **AC-1:** Given` and table rows are all read', () => {
    const text = [
      '# US-4 Overdue report',
      '- AC-1: Given a task due yesterday, when I open the report, then it is listed',
      '- **AC-2:** Given a task due today, when I open the report, then it is not listed',
      '| AC-3 | Given a completed task, when I open the report, then it is not listed |',
    ].join('\n');
    const story = record(convertWorkspace({ [OWN]: text }).workspace[STORY_JSON]);
    expect((story.criteria as { id: string; given: string }[]).map((c) => `${c.id} ${c.given}`)).toEqual([
      'AC-1 a task due yesterday',
      'AC-2 a task due today',
      'AC-3 a completed task',
    ]);
  });

  test('a record that only needs normalising is kept, renumbered and without renderHash', () => {
    const loose = JSON.stringify({ id: 'US-4', title: 'Overdue', persona: 'lead', capability: 'c', benefit: 'b', criteria: [{ id: 'US-4/AC-7', given: 'g', when: 'w', then: 't', tag: 'happy' }], scopeExclusions: [], renderHash: hashText(RENDERED_2X) });
    const out = convertWorkspace({ [STORY_JSON]: loose, [OWN]: RENDERED_2X });
    expect(out.outcome).toBe('kept-record');
    const story = record(out.workspace[STORY_JSON]);
    expect(story.notes).toBe('');
    expect((story.criteria as { id: string }[])[0].id).toBe('AC-1');
    expect(story).not.toHaveProperty('renderHash');
  });

  test('a record that is not JSON is refused, and neither file is touched', () => {
    const ws = { [STORY_JSON]: '{ broken', [OWN]: RENDERED_2X };
    const out = convertWorkspace(ws);
    expect(out.outcome).toBe('refused');
    expect(out.reason).toBe('the story record is not valid JSON, so neither file was changed');
    expect(out.workspace).toBe(ws);
  });

  test('a story that cannot fit the record is refused with the validator\'s sentence, never truncated', () => {
    const ws = { [OWN]: `# US-4 Overdue\n\n${'word '.repeat(1000)}` };
    const out = convertWorkspace(ws);
    expect(out.outcome).toBe('refused');
    expect(out.reason).toBe('notes is longer than 4000 characters');
    expect(out.workspace).toBe(ws);
  });

  test('a valid record with no markdown beside it and nothing to drop is untouched', () => {
    const ws = { [STORY_JSON]: JSON.stringify({ id: 'US-4', title: 't', persona: 'p', capability: 'c', benefit: 'b', criteria: [], scopeExclusions: [], notes: '' }) };
    expect(convertWorkspace(ws)).toEqual({ workspace: ws, outcome: 'untouched' });
  });

  test('a valid record beside markdown hand-edited after the room rendered it says so', () => {
    const story = { id: 'US-4', title: 't', persona: 'p', capability: 'c', benefit: 'b', criteria: [], scopeExclusions: [], notes: '' };
    const rendered = '# US-4 \u00b7 t\n';
    expect(convertWorkspace({ [STORY_JSON]: JSON.stringify({ ...story, renderHash: hashText(rendered) }), [OWN]: rendered }).editedMarkdown).toBe(false);
    expect(convertWorkspace({ [STORY_JSON]: JSON.stringify({ ...story, renderHash: hashText(rendered) }), [OWN]: `${rendered}more\n` }).editedMarkdown).toBe(true);
  });

  test('the other files in the workspace are carried unchanged', () => {
    const out = convertWorkspace({ [OWN]: md, 'requirements/notes.txt': 'kept' });
    expect(out.workspace['requirements/notes.txt']).toBe('kept');
  });
});

describe('convertWorkspace: markdown edited beside a kept record is kept in notes', () => {
  const story = { id: 'US-4', title: 'Kept', persona: 'p', capability: 'c', benefit: 'b', criteria: [], scopeExclusions: [], notes: '' };
  const rendered = '# US-4 \u00b7 Kept\n';
  const edited = `${rendered}\n<!-- a comment the room never wrote -->\nA line the learner added by hand.\n`;

  test('the edited text goes into notes, after the notes already there, under one line saying where it came from', () => {
    const out = convertWorkspace({ [STORY_JSON]: JSON.stringify({ ...story, notes: 'Ask Dana.', renderHash: hashText(rendered) }), [OWN]: edited });
    expect(out).toMatchObject({ outcome: 'kept-record', editedMarkdown: true });
    expect(out.workspace[OWN]).toBeUndefined();
    expect(record(out.workspace[STORY_JSON]).notes).toBe(`Ask Dana.\n\n${EDITED_MARKDOWN_HEADER}\n# US-4 \u00b7 Kept\n\n\nA line the learner added by hand.`);
  });

  test('markdown that is still exactly what the room rendered is dropped, and notes do not move', () => {
    const out = convertWorkspace({ [STORY_JSON]: JSON.stringify({ ...story, renderHash: hashText(rendered) }), [OWN]: rendered });
    expect(out).toMatchObject({ outcome: 'kept-record', editedMarkdown: false });
    expect(record(out.workspace[STORY_JSON]).notes).toBe('');
  });

  test('with no renderHash, markdown other than the pack\'s seed or the record\'s render is edited, and the seed itself is not', () => {
    const seeded = convertWorkspace({ [STORY_JSON]: JSON.stringify(story), [OWN]: TEMPLATE_2X });
    expect(seeded).toMatchObject({ outcome: 'kept-record', editedMarkdown: false });
    expect(record(seeded.workspace[STORY_JSON]).notes).toBe('');
    const written = convertWorkspace({ [STORY_JSON]: JSON.stringify(story), [OWN]: 'My own words about the report.\n' });
    expect(written).toMatchObject({ outcome: 'kept-record', editedMarkdown: true });
    expect(record(written.workspace[STORY_JSON]).notes).toBe(`${EDITED_MARKDOWN_HEADER}\nMy own words about the report.`);
  });

  test('with no renderHash, markdown that is exactly the 2.x room\'s render of the record is not an edit, and is dropped', () => {
    const full = {
      ...story,
      persona: 'team lead',
      capability: 'to see every overdue task in one report',
      benefit: 'I can chase them up',
      criteria: [
        { id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' },
        { id: 'AC-2', given: 'a task due today', when: 'I open the report', then: 'it is not listed', tag: 'boundary' },
      ],
      scopeExclusions: ['reminders', 'email'],
      notes: 'Does a task with no due date ever appear?',
    };
    const render = RENDERED_2X.replace('Overdue report', 'Kept');
    const out = convertWorkspace({ [STORY_JSON]: JSON.stringify(full), [OWN]: render });
    expect(out).toMatchObject({ outcome: 'kept-record', editedMarkdown: false });
    expect(record(out.workspace[STORY_JSON]).notes).toBe('Does a task with no due date ever appear?');
    // one word changed by hand after that render is an edit
    const touched = convertWorkspace({ [STORY_JSON]: JSON.stringify(full), [OWN]: render.replace('reminders', 'push reminders') });
    expect(touched).toMatchObject({ outcome: 'kept-record', editedMarkdown: true });
  });

  test('edited markdown that would not fit in notes refuses the row, and neither file is touched', () => {
    const ws = { [STORY_JSON]: JSON.stringify({ ...story, notes: 'n'.repeat(STORY_CAPS.fieldChars - 50) }), [OWN]: `${'word '.repeat(40)}\n` };
    const out = convertWorkspace(ws);
    expect(out.outcome).toBe('refused');
    expect(out.reason).toBe('Edited markdown beside the record would not fit in notes');
    expect(out.workspace).toBe(ws);
  });
});

describe('convertWorkspace: whose id the converted story carries', () => {
  const headed = '# US-5 Overdue report\n\nAs a lead, I want a report, so that I chase it.\n';

  test('a fixed-id phase keeps its own id over the heading\'s', () => {
    expect(record(convertWorkspace({ [OWN]: headed }).workspace[STORY_JSON]).id).toBe('US-4');
    expect(record(convertWorkspace({ [OWN]: headed }, { storyId: 'US-4' }).workspace[STORY_JSON]).id).toBe('US-4');
    const seed = JSON.stringify({ id: 'SH-5', title: '', persona: '', capability: '', benefit: '', criteria: [], scopeExclusions: [], notes: '' });
    expect(record(convertWorkspace({ [STORY_JSON]: seed, [OWN]: headed }).workspace[STORY_JSON]).id).toBe('SH-5');
    expect(record(convertWorkspace({ [OWN]: 'hello there' }, { storyId: 'SH-5' }).workspace[STORY_JSON]).id).toBe('SH-5');
  });

  test('the record it writes passes the fixed-id validator the room uses', () => {
    const out = convertWorkspace({ [OWN]: headed }, { storyId: 'US-4' });
    expect(validateStoryRecord(out.workspace[STORY_JSON], 'US-4').error).toBeNull();
  });

  test('under learner-picks the heading\'s id is the learner\'s choice and is kept', () => {
    expect(record(convertWorkspace({ [OWN]: headed }, { storyId: LEARNER_PICKS }).workspace[STORY_JSON]).id).toBe('US-5');
    // no heading id and no seed record: the empty id the pack seeds for learner-picks
    expect(record(convertWorkspace({ [OWN]: 'As a lead, I want a report, so that I chase it.\n' }, { storyId: LEARNER_PICKS }).workspace[STORY_JSON]).id).toBe('');
  });
});

describe('parseStoryMarkdown', () => {
  test('reads nothing out of the placeholder row', () => {
    expect(parseStoryMarkdown('- Given ..., when ..., then ...\n').story.criteria).toEqual([]);
  });
});
