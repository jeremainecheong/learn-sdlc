import { EMPTY_DESIGN, serialiseDesign, validateDesignRecord } from '@learnsdlc/shared';
import { FOLDED_WHOLE, NOTES_HEADER, convertDesignWorkspace, legacyDesignSourcesOf } from './design-records';
import { TASKTRACKR_DESIGN_TEMPLATE } from './tasktrackr-design-template';

const R = 'design/design.json', MD = 'design/my-design.md';
const legacy = JSON.stringify({ fields: [{ name: 'id', type: 'integer', required: true, note: 'db' }], operations: [{ name: 'getOverdue(today)', satisfies: 'US-4', inputs: 'today', returns: 'Task[]', boundary: 'due today is not overdue', errors: '' }], decisions: [] });
const region = (body: string) => `<!-- learnsdlc:design-board:start -->\n${body}\n<!-- learnsdlc:design-board:end -->`;

test('keeps a valid record and removes the markdown and the mounted documents', () => {
  const out = convertDesignWorkspace({ [R]: serialiseDesign(EMPTY_DESIGN), [MD]: region('board'), 'design/architecture.md': 'x', 'shared/contract/api.json': '{}' });
  expect(out.outcome).toBe('kept-record');
  expect(Object.keys(out.workspace).sort()).toEqual([R, 'shared/contract/api.json']);
});
test('folds the board record, the boundary into the operation\'s note, and says what it folded', () => {
  const out = convertDesignWorkspace({ [R]: legacy, [MD]: region('board') });
  expect(out.outcome).toBe('folded');
  const record = validateDesignRecord(out.workspace[R]).design!;
  expect(record.entities[0]).toMatchObject({ name: 'Model', kind: 'class' });
  expect(record.operations[0]).toMatchObject({ id: 'O1', inputs: ['today'], satisfies: ['US-4'], note: 'boundary: due today is not overdue' });
  expect(record.notes ?? '').toBe('');
  expect(out.reason).toBe('1 field became the attributes of the entity Model; the boundary of O1 kept in its note');
});
test('a folded record whose fold moved nothing still says so, and keeps its consequences list and superseded-by link', () => {
  const board = JSON.stringify({ entities: [], relations: [], operations: [], decisions: [{ id: 'D1', choice: 'c', alternative: 'a', rationale: 'r', tradeoff: 't', consequences: ['one', 'two'], status: 'superseded', supersededBy: 'D2', stories: [] }] });
  const out = convertDesignWorkspace({ [R]: board, [MD]: region('board') });
  expect(out.outcome).toBe('folded');
  expect(out.reason).toBe(FOLDED_WHOLE);
  expect(validateDesignRecord(out.workspace[R]).design!.decisions[0]).toMatchObject({ consequences: ['one', 'two'], supersededBy: 'D2' });
});
test('keeps the words outside the board in notes, comments stripped', () => {
  const md = `# My design\n\n<!-- write below -->\nTasks belong to one list because the report groups by list.\n\n${region('board')}`;
  const out = convertDesignWorkspace({ [R]: serialiseDesign({ ...EMPTY_DESIGN, notes: 'mine' }), [MD]: md });
  const notes = validateDesignRecord(out.workspace[R]).design!.notes!;
  // the comment's line goes, its line break stays: two blank lines under the heading
  expect(notes).toBe(`mine\n\n${NOTES_HEADER}\n# My design\n\n\nTasks belong to one list because the report groups by list.`);
  expect(out.notesKept).toBe(true);
});
test('an untouched template keeps nothing', () => {
  const out = convertDesignWorkspace({ [MD]: TASKTRACKR_DESIGN_TEMPLATE });
  expect(out.outcome).toBe('seeded');
  expect(validateDesignRecord(out.workspace[R]).design!.notes ?? '').toBe('');
});
test('over the notes cap is refused, unchanged', () => {
  const workspace = { [R]: legacy, [MD]: 'x '.repeat(2100) };
  const out = convertDesignWorkspace(workspace);
  expect(out.outcome).toBe('refused');
  expect(out.reason).toBe('the text outside the board in the design page would not fit in notes, so it was not changed');
  expect(out.workspace).toBe(workspace);
});
test('an unreadable record is refused, unchanged', () => {
  expect(convertDesignWorkspace({ [R]: '{', [MD]: 'x' }).outcome).toBe('refused');
});
test('a workspace already in the schema with nothing older is untouched', () => {
  expect(convertDesignWorkspace({ [R]: serialiseDesign(EMPTY_DESIGN) }).outcome).toBe('untouched');
  expect(convertDesignWorkspace({ 'notes.txt': 'x' }).outcome).toBe('untouched');
});
test('a record the validator accepts that still carries the board\'s older keys is folded, as the shared reader folds it, never kept as it is', () => {
  const both = JSON.stringify({ ...EMPTY_DESIGN, fields: [{ name: 'id', type: 'integer' }] });
  const out = convertDesignWorkspace({ [R]: both });
  expect(out.outcome).toBe('folded');
  expect(out.reason).toBe('1 field became the attributes of the entity Model');
  expect(JSON.parse(out.workspace[R])).not.toHaveProperty('fields');
  // converted once, it is in the schema: a second pass leaves it alone
  expect(convertDesignWorkspace(out.workspace).outcome).toBe('untouched');
});
test('a fold that would cut lines at the notes cap is refused unchanged, with the fold\'s own cut named', () => {
  const endpoints = Array.from({ length: 30 }, (_, i) => ({ method: 'GET', path: `/api/e${i + 1}`, purpose: 'p'.repeat(160) }));
  const workspace = { [R]: JSON.stringify({ entities: [{ id: 'E1', name: 'Task' }], endpoints }), [MD]: region('board') };
  const out = convertDesignWorkspace(workspace);
  expect(out.outcome).toBe('refused');
  expect(out.workspace).toBe(workspace);
  expect(out.reason).toMatch(/^the board's older record would lose words in the fold \(\d+ endpoint lines left out of the notes: over the 4000-character cap\), so it was not changed$/);
});
test('a fold that would cut past a board limit is refused unchanged', () => {
  const entities = Array.from({ length: 21 }, (_, i) => ({ id: `E${i + 1}`, name: `N${i + 1}` }));
  const workspace = { [R]: JSON.stringify({ fields: [], entities }) };
  const out = convertDesignWorkspace(workspace);
  expect(out.outcome).toBe('refused');
  expect(out.workspace).toBe(workspace);
  expect(out.reason).toBe("the board's older record would lose words in the fold (1 entity left out: over the board's limit of 20), so it was not changed");
});
test('a record that parses but whose fold fails validation is refused in the validator\'s own words', () => {
  const operations = Array.from({ length: 31 }, (_, i) => ({ name: `op${i + 1}`, inputs: 'x', returns: 'y' }));
  const workspace = { [R]: JSON.stringify({ fields: [], operations }) };
  const out = convertDesignWorkspace(workspace);
  expect(out.outcome).toBe('refused');
  expect(out.workspace).toBe(workspace);
  expect(out.reason).toBe('the design record could not be converted (more than 30 operations), so it was not changed');
});
test('a design page that is not text is refused with a sentence, never thrown', () => {
  const workspace = { [R]: serialiseDesign(EMPTY_DESIGN), [MD]: 42 as unknown as string };
  const out = convertDesignWorkspace(workspace);
  expect(out).toEqual({ workspace, outcome: 'refused', reason: 'the design page is not text, so it was not changed' });
  expect(out.workspace).toBe(workspace);
});
test('with no record, the board region is the only copy of the board: its text is kept in notes too', () => {
  const out = convertDesignWorkspace({ [MD]: `# Mine\n${region('| Field | id |')}` });
  expect(out.outcome).toBe('seeded');
  expect(validateDesignRecord(out.workspace[R]).design!.notes).toBe(`${NOTES_HEADER}\n# Mine\n\n| Field | id |`);
  expect(out.notesKept).toBe(true);
});

describe('the learner-written files come from the pinned version', () => {
  // A teacher's version: its written Design task targets design/my-design-t2.md and it mounts
  // design/architecture.md editable and requirements/provided-stories.md read-only.
  const pinned = {
    content: {
      phases: [
        {
          key: 'design',
          files: [
            { path: 'design/architecture.md', content: '# Architecture\n', editable: true },
            { path: 'requirements/provided-stories.md', content: '# Stories\n', editable: false },
          ],
        },
      ],
    },
    phases: [{ key: 'design', tasks: [{ taskKey: 't2', artefactPath: 'design/my-design-t2.md', owns: ['design/my-design-t2.md'] }] }],
  };
  const sources = legacyDesignSourcesOf(pinned);

  test('reads the task targets and the editable mounts as written, the read-only mounts as removable', () => {
    expect(sources).toEqual({
      written: [{ path: 'design/my-design-t2.md' }, { path: 'design/architecture.md', template: '# Architecture\n' }],
      readOnly: ['requirements/provided-stories.md'],
    });
    expect(legacyDesignSourcesOf(null)).toBeNull();
    expect(legacyDesignSourcesOf({ content: { phases: [{ key: 'design', files: [{ path: R, content: '{}', editable: true }] }] }, phases: [] })).toBeNull();
  });

  test('keeps the words of the task target and of the editable mount in notes, each under a header naming its file', () => {
    const out = convertDesignWorkspace(
      { 'design/my-design-t2.md': 'Tasks group by list.', 'design/architecture.md': '# Architecture\nOne Flask app.', 'requirements/provided-stories.md': '# Stories\n' },
      sources!,
    );
    expect(out.outcome).toBe('seeded');
    expect(Object.keys(out.workspace)).toEqual([R]);
    expect(validateDesignRecord(out.workspace[R]).design!.notes).toBe(
      'Kept from design/my-design-t2.md:\nTasks group by list.\n\nKept from design/architecture.md:\n# Architecture\nOne Flask app.',
    );
    expect(out.notesKept).toBe(true);
  });

  test('an editable mount the learner never changed keeps nothing; the read-only mount is removed', () => {
    const out = convertDesignWorkspace({ [R]: serialiseDesign(EMPTY_DESIGN), 'design/architecture.md': '# Architecture\n', 'requirements/provided-stories.md': '# Stories\n' }, sources!);
    expect(out.outcome).toBe('kept-record');
    expect(Object.keys(out.workspace)).toEqual([R]);
    expect(validateDesignRecord(out.workspace[R]).design!.notes ?? '').toBe('');
  });

  test('a learner-written file over the notes cap refuses the row, unchanged', () => {
    const workspace = { 'design/my-design-t2.md': 'x '.repeat(2100) };
    const out = convertDesignWorkspace(workspace, sources!);
    expect(out.outcome).toBe('refused');
    expect(out.workspace).toBe(workspace);
  });

  test('a learner-written file that is not text refuses the row with a sentence naming it', () => {
    const workspace = { 'design/my-design-t2.md': 7 as unknown as string };
    expect(convertDesignWorkspace(workspace, sources!)).toEqual({ workspace, outcome: 'refused', reason: 'design/my-design-t2.md is not text, so it was not changed' });
  });

  test('with no version to read, a written task\'s own path is still the learner\'s, never left hidden', () => {
    const out = convertDesignWorkspace({ 'design/my-design-t2.md': 'Mine.', 'docs/design/t3.md': 'Also mine.' });
    expect(out.outcome).toBe('seeded');
    expect(Object.keys(out.workspace)).toEqual([R]);
    expect(validateDesignRecord(out.workspace[R]).design!.notes).toBe('Kept from design/my-design-t2.md:\nMine.\n\nKept from docs/design/t3.md:\nAlso mine.');
  });
});
