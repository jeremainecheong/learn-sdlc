import { describe, expect, it } from 'vitest';
import { repoFile } from './support/paths';
import { moduleText } from './support/source-text';
import { foldLegacyDesign, type Design, type DesignOperation, type DesignStory } from '@learnsdlc/shared';
import {
  contractWarnings,
  storyFacts,
  storyIdsOf,
  type StoryFact,
} from '../components/workspace/panels/design/contradictions';
import { ownStoryRecordOf } from '../components/workspace/panels/design/useStories';

/*
 * The contradiction engine.
 *
 * A warning that fires on a correct contract is worse than no warning at all
 * (a learner learns to ignore the box) so half of these cases are about
 * staying quiet: the hedge, the correct ordering, the honest "errors: none",
 * the token that is a parameter rather than a field.
 *
 * The facts are the stories the Design phase lists (`PhaseDetail.design.stories`)
 * and the learner's own story record from the Requirements phase. The list
 * below is TaskTrackr's approved backlog as a teacher lists it on the Design
 * phase: one line per story, the line carrying what the board is checked against.
 */
const packFile = (rel: string): string => repoFile(`content/tasktrackr/${rel}`);

const STORIES: DesignStory[] = [
  { id: 'US-1', title: 'Add a task', line: 'As a busy learner, I want to add a task to a list with a title, a priority and an optional due date, so that I can capture work the moment I think of it.' },
  { id: 'US-2', title: 'Complete a task', line: 'As a busy learner, I want to mark a task as completed by its id, and an id no task has answers 404 with the code task_not_found, so that my lists reflect what is left to do.' },
  { id: 'US-3', title: 'Filter, search and order a list', line: 'As a busy learner, I want to narrow a list by status, tag and keyword and read it with high priority tasks before medium, so that I can see the right work first.' },
  { id: 'US-5', title: 'See late tasks where I work', line: 'As a busy learner, I want a late marker on the rows I am already looking at, so that I notice what slipped without opening a report.' },
];

const facts = storyFacts(STORIES, undefined);

const op = (over: Partial<DesignOperation> = {}): DesignOperation => ({
  id: 'O1',
  name: 'listTasks(listId, filters)',
  inputs: [],
  returns: '',
  errors: [],
  satisfies: [],
  ...over,
});

/** The overdue report: its name owes the boundary clause, so an unlabelled note is that clause. */
const overdue = (over: Partial<DesignOperation>): DesignOperation => op({ name: 'getOverdue(today)', ...over });

/** A record holding these operations, and one entity whose attributes are the model's fields. */
const record = (operations: DesignOperation[], fields: string[] = []): Design => ({
  entities: fields.length
    ? [{ id: 'E1', name: 'Task', kind: 'class', attributes: fields.map((name) => ({ name, type: 'string' })), responsibilities: [], satisfies: [] }]
    : [],
  relations: [],
  operations: operations.map((o, i) => ({ ...o, id: `O${i + 1}` })),
  decisions: [],
});

/** A criterion of the learner's own story, the way `story.json` renders one. */
const own = (id: string, text: string): StoryFact => ({
  id,
  storyId: id.split('/')[0],
  text,
  own: true,
});

const run = (
  operations: DesignOperation[],
  extra: { fields?: string[]; facts?: StoryFact[] } = {},
) => contractWarnings({ design: record(operations, extra.fields), facts: extra.facts ?? facts });

describe('the facts the Design phase lists', () => {
  it("a story line from the Design phase's own list is a fact; nothing is read from a backlog file", () => {
    expect(facts.map((f) => f.id)).toEqual(['US-1', 'US-2', 'US-3', 'US-5']);
    expect(facts[2]).toEqual({
      id: 'US-3',
      storyId: 'US-3',
      text: 'Filter, search and order a list. As a busy learner, I want to narrow a list by status, tag and keyword and read it with high priority tasks before medium, so that I can see the right work first.',
      own: false,
    });
    expect(facts.every((f) => f.own === false)).toBe(true);
    // the engine takes the list, never a file map: no backlog path is named anywhere in it
    const source = moduleText('storyFacts');
    expect(source).not.toContain('provided-stories');
    expect(source).not.toMatch(/\.md['"]/);
  });

  it('reads the learner own story out of story.json', () => {
    const mine = storyFacts([], JSON.stringify({
      id: 'US-4',
      criteria: [
        { id: 'AC-1', given: 'tasks with a due date in the past', when: 'I open the report', then: 'they are listed' },
        { id: 'AC-2', given: 'a task due today', when: 'I run the report', then: 'it is not overdue' },
      ],
    }));
    expect(mine).toHaveLength(2);
    expect(mine[1].id).toBe('US-4/AC-2');
    expect(mine[1].own).toBe(true);
    expect(mine[1].text).toBe('Given a task due today, when I run the report, then it is not overdue');
  });

  it("reads the learner's whole record: the story's own line, then each criterion, never a scope line", () => {
    const own = JSON.stringify({
      id: 'US-4',
      title: 'Overdue report',
      persona: 'team lead',
      capability: 'a list of the tasks that are past their due date',
      benefit: 'I can chase them before the review',
      criteria: [
        { id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' },
        { id: 'AC-2', given: 'a task due today', when: 'I open the report', then: 'it is not overdue', tag: 'boundary' },
      ],
      scopeExclusions: ['A task due today counts as overdue on the wall board'],
      notes: '',
    });
    const mine = storyFacts([], own);
    expect(mine.map((f) => f.id)).toEqual(['US-4', 'US-4/AC-1', 'US-4/AC-2']);
    expect(mine[0]).toEqual({
      id: 'US-4',
      storyId: 'US-4',
      text: 'Overdue report. As a team lead, I want a list of the tasks that are past their due date, so that I can chase them before the review',
      own: true,
    });
    expect(mine.every((f) => f.own)).toBe(true);
    // the out-of-scope line says the opposite of AC-2 on purpose: it is what
    // the story does not promise, so it is never a fact a warning quotes
    expect(mine.some((f) => /wall board/.test(f.text))).toBe(false);
    expect(storyIdsOf(mine)).toEqual(['US-4']);

    // a contract that puts a task due today in the overdue set is warned
    // against the learner's own criterion, not quietly agreed with by the
    // scope line that says the same words
    const [w, ...rest] = run([overdue({ note: 'a task due today is overdue' })], { facts: mine });
    expect(rest).toEqual([]);
    expect(w.criterionId).toBe('US-4/AC-2');
    expect(w.text).toContain('your US-4/AC-2');

    // after the phase's stories, the record's story joins the ids the pickers offer
    const both = storyFacts(STORIES, own);
    expect(storyIdsOf(both)).toEqual(['US-1', 'US-2', 'US-3', 'US-5', 'US-4']);
    // a story the phase already lists keeps the phase's line; the learner's criteria still join it
    const listed = storyFacts([...STORIES, { id: 'US-4', title: 'Overdue report', line: 'As a team lead, I want the overdue tasks.' }], own);
    expect(listed.filter((f) => f.id === 'US-4')).toEqual([{ id: 'US-4', storyId: 'US-4', text: 'Overdue report. As a team lead, I want the overdue tasks.', own: false }]);
    expect(listed.map((f) => f.id).slice(-2)).toEqual(['US-4/AC-1', 'US-4/AC-2']);
  });

  it('reads no fact from a record that names no story, or from an empty one', () => {
    expect(storyFacts([], '')).toEqual([]);
    expect(storyFacts([], JSON.stringify({ title: 'No id', criteria: [] }))).toEqual([]);
  });

  it('reads no own-story fact from a workspace that holds only the retired my-story.md', () => {
    // A 2.x room wrote the learner's story as markdown. The check reads the
    // record only, so that file alone gives no fact of the learner's own,
    // and beside the phase's stories it adds nothing to what they give.
    const markdown = '# US-4: Overdue report\n\nAs a team lead, I want the overdue tasks, so that I can chase them.\n\n- AC-1: Given a task due today, when I run the report, then it is overdue\n';
    const ownRecord = ownStoryRecordOf([{ path: 'requirements/my-story.md', content: markdown }]);
    expect(ownRecord).toBeUndefined();
    expect(storyFacts([], ownRecord)).toEqual([]);
    const both = storyFacts(STORIES, ownRecord);
    expect(both.some((f) => f.own)).toBe(false);
    expect(both).toEqual(facts);
  });

  it("reads the learner's record and nothing else out of the Requirements phase", () => {
    const json = JSON.stringify({ id: 'US-4', criteria: [] });
    expect(ownStoryRecordOf([
      { path: 'requirements/provided-stories.md', content: '## US-1 Add a task' },
      { path: 'requirements/story.json', content: json },
    ])).toBe(json);
    expect(ownStoryRecordOf([])).toBeUndefined();
  });

  it('offers the story ids the stories actually name', () => {
    expect(storyIdsOf(facts)).toEqual(['US-1', 'US-2', 'US-3', 'US-5']);
  });

  it('says nothing when it has nothing', () => {
    expect(storyFacts([], undefined)).toEqual([]);
    expect(contractWarnings({ design: record([]), facts: [] })).toEqual([]);
  });
});

describe('the ordering against an approved story', () => {
  it('fires when the contract orders the other way', () => {
    const [w, ...rest] = run([op({ note: 'ordering: tasks in ascending priority, lowest first.' })]);
    expect(rest).toEqual([]);
    expect(w.rule).toBe('ordering');
    expect(w.operation).toBe('listTasks');
    expect(w.criterionId).toBe('US-3');
    expect(w.text).toContain('listTasks orders low priority first');
    expect(w.text).toContain('US-3');
  });

  it('fires when the contract says the order does not matter', () => {
    const [w] = run([op({ note: 'ordering: any order is fine.' })]);
    expect(w.text).toContain('the order does not matter');
    expect(w.criterionId).toBe('US-3');
  });

  it('does not fire on a correct contract', () => {
    expect(run([op({ note: 'ordering: high priority first, ties by ascending id.' })])).toEqual([]);
  });

  it('does not fire on a hedged sentence', () => {
    expect(run([op({ note: 'ordering: never lowest first; high priority comes first.' })])).toEqual([]);
  });

  it('does not fire when no story pins an order', () => {
    expect(run([op({ note: 'ordering: lowest first.' })], { facts: [] })).toEqual([]);
  });
});

describe('the boundary against the learner own story', () => {
  const notOverdue = own('US-4/AC-2', 'Given a task due today, when I run the report, then it is not overdue');
  const isOverdue = own('US-4/AC-2', 'Given a task due today, when I run the report, then it is overdue');

  it('fires when the boundary contradicts the criterion', () => {
    const [w] = run([overdue({ note: 'a task due today counts as overdue.' })], {
      facts: [notOverdue],
    });
    expect(w.rule).toBe('boundary');
    expect(w.criterionId).toBe('US-4/AC-2');
    expect(w.text).toBe(
      'getOverdue puts a task due today in the overdue set, but your US-4/AC-2 says a task due today is not overdue.',
    );
  });

  it('fires in the other direction too', () => {
    const [w] = run([overdue({ note: 'tasks due strictly before today.' })], {
      facts: [isOverdue],
    });
    expect(w.text).toContain('leaves a task due today out of the overdue set');
  });

  it('does not fire without a criterion to check against', () => {
    expect(run([overdue({ note: 'a task due today counts as overdue.' })], { facts: [] })).toEqual(
      [],
    );
  });

  it('fires against the operation own returns line, with no story at all', () => {
    const [w] = run(
      [
        overdue({
          returns: 'tasks due strictly before today and not completed.',
          note: 'a task due today is overdue.',
        }),
      ],
      { facts: [] },
    );
    expect(w.criterionId).toBeNull();
    expect(w.id).toBe('boundary-returns:getOverdue');
    expect(w.text).toContain('but its boundary rule puts a task due today in the overdue set');
  });
});

describe('errors none against a story that expects one', () => {
  it('fires when the operation claims the story that expects a failure', () => {
    const [w] = run([op({ name: 'completeTask(id)', satisfies: ['US-2'], errors: ['none'] })]);
    expect(w.rule).toBe('errors');
    expect(w.criterionId).toBe('US-2');
    expect(w.text).toContain('completeTask says it raises nothing');
  });

  it('does not fire on an honest "none" with an explanation', () => {
    expect(
      run([
        op({
          name: 'getOverdue(today)',
          satisfies: ['US-5'],
          errors: ['none', 'a task with no due date is simply excluded'],
        }),
      ]),
    ).toEqual([]);
  });

  it('does not fire when the operation claims no story', () => {
    expect(run([op({ name: 'completeTask(id)', errors: ['none'] })])).toEqual([]);
  });
});

describe('a field the model does not have', () => {
  const model = ['id', 'title', 'status'];

  it('fires on a token no field carries', () => {
    const [w] = run([overdue({ returns: 'tasks whose due_date has passed' })], { fields: model });
    expect(w.rule).toBe('model');
    expect(w.text).toBe('getOverdue reads due_date, but the task model has no due_date field.');
  });

  it('does not fire once the model has the field, however it is spelled', () => {
    expect(
      run([overdue({ returns: 'tasks whose due_date has passed' })], {
        fields: [...model, 'dueDate'],
      }),
    ).toEqual([]);
  });

  it('does not fire on a parameter, another operation or a declared code', () => {
    expect(
      run(
        [
          op({
            name: 'completeTask(task_id)',
            inputs: ['task_id', 'the id of the task'],
            returns: 'what listTasks would return for it',
            errors: ['task_not_found'],
          }),
          op({ name: 'listTasks(listId)' }),
        ],
        { fields: model },
      ),
    ).toEqual([]);
  });

  it('stays quiet until the model has been started', () => {
    expect(run([overdue({ returns: 'tasks whose due_date has passed' })], { fields: ['id'] })).toEqual(
      [],
    );
  });

  // The Review tab read the error codes an operation answers with as
  // fields the task model lacked. A code is never a field.
  it('never reads an error line: list_not_found and invalid_date raise no model warning', () => {
    expect(
      run(
        [
          op({ name: 'listTasks(listId, filters)', errors: ['list_not_found', 'invalid_status'] }),
          overdue({ returns: 'open tasks due strictly before today', errors: ['invalid_date'] }),
        ],
        { fields: [...model, 'due_date', 'priority'] },
      ),
    ).toEqual([]);
  });

  it('skips a code quoted in another clause, by the design own codes, the shapes or the catalogue', () => {
    const fields = [...model, 'due_date'];
    // Named in another operation's error line.
    expect(
      run(
        [
          op({ name: 'listTasks(listId)', returns: 'the tasks, or list_not_found' }),
          overdue({ errors: ['list_not_found'] }),
        ],
        { fields },
      ),
    ).toEqual([]);
    // Written in an error code's shape, snake or camel.
    for (const code of ['invalid_date', 'duplicate_title', 'version_conflict', 'forbidden', 'unauthorized', 'listNotFound', 'invalidDate']) {
      expect(run([op({ name: 'listTasks(listId)', returns: `the tasks, or ${code}` })], { fields })).toEqual([]);
    }
    // Declared only by the contract's catalogue.
    expect(
      contractWarnings({
        design: record([op({ name: 'listTasks(listId)', returns: 'the tasks, or quota_exceeded' })], fields),
        facts,
        errorCodes: ['quota_exceeded'],
      }),
    ).toEqual([]);
    expect(
      contractWarnings({
        design: record([op({ name: 'listTasks(listId)', returns: 'the tasks, or quota_exceeded' })], fields),
        facts,
      }).map((w) => w.text),
    ).toEqual(['listTasks reads quota_exceeded, but the task model has no quota_exceeded field.']);
  });

  it('still fires on an input token the model lacks, beside an error line of codes', () => {
    const [w] = run(
      [op({ name: 'listTasks(listId)', inputs: ['owner_email'], errors: ['list_not_found', 'invalid_date'] })],
      { fields: model },
    );
    expect(w.rule).toBe('model');
    expect(w.text).toBe('listTasks reads owner_email, but the task model has no owner_email field.');
  });

  // An error entry's code is its first word; a field the entry
  // goes on to mention is not a code, so the model check still sees it.
  it('reads only the code from an error entry: a field the entry mentions still warns when the model lacks it', () => {
    const [w] = run(
      [overdue({ inputs: ['due_date'], errors: ['invalid_date when due_date is not a date'] })],
      { fields: model },
    );
    expect(w.rule).toBe('model');
    expect(w.text).toBe('getOverdue reads due_date, but the task model has no due_date field.');
    // With the field in the model the same operation is quiet: the entry's own
    // code, a code after "or", and a code quoted in the returns clause are all codes.
    expect(
      run(
        [overdue({ inputs: ['due_date'], returns: 'the late tasks, or invalid_date', errors: ['invalid_date when due_date is not a date or list_not_found; forbidden'] })],
        { fields: [...model, 'due_date'] },
      ),
    ).toEqual([]);
  });
});

describe('the block against its own signature', () => {
  it('fires with the API own sentence, word for word', () => {
    const [w] = run([overdue({ inputs: ['none'] })]);
    expect(w.rule).toBe('signature');
    expect(w.text).toBe(
      'The design says getOverdue takes no arguments, but the same block declares getOverdue(today).',
    );
  });

  it('does not fire when the signature declares nothing', () => {
    expect(run([op({ name: 'listAll()', inputs: ['none'] })])).toEqual([]);
  });
});

describe('the whole list', () => {
  it('is deterministic, in operation order then rule order', () => {
    const operations = [
      op({ note: 'ordering: lowest first.' }),
      overdue({ inputs: ['none'], note: 'a task due today counts as overdue.' }),
    ];
    const extra = { facts: [...facts, own('US-4/AC-2', 'Given a task due today, then it is not overdue')] };
    const first = run(operations, extra);
    expect(run(operations, extra)).toEqual(first);
    expect(first.map((w) => w.id)).toEqual([
      'ordering:listTasks',
      'boundary:getOverdue',
      'signature:getOverdue',
    ]);
  });

  it('says nothing about the scaffold as it ships', () => {
    // The pack still ships the board's older record; the room reads it folded, as the dossier does.
    const scaffold = foldLegacyDesign(JSON.parse(packFile('phases/02-design/files/design/design.json')));
    expect(scaffold).not.toBeNull();
    expect(contractWarnings({ design: scaffold!.design, facts })).toEqual([]);
  });

  it('reads the unlabelled text before the first label as the clause, and a label in any case', () => {
    const [ordering, ...none] = run([op({ note: 'low priority first; example: listTasks(L1) gives T3 then T1.' })]);
    expect(none).toEqual([]);
    expect(ordering.id).toBe('ordering:listTasks');
    expect(ordering.said).toBe('low priority first');
    expect(run([op({ note: 'Ordering: lowest first.' })]).map((w) => w.id)).toEqual(['ordering:listTasks']);
    // the overdue report owes its boundary, so its leading text is that clause
    const notOverdue = own('US-4/AC-2', 'Given a task due today, when I run the report, then it is not overdue');
    expect(run([overdue({ note: 'a task due today counts as overdue; Example: getOverdue("2026-10-15")' })], { facts: [notOverdue] }).map((w) => w.id))
      .toEqual(['boundary:getOverdue']);
    expect(run([overdue({ note: 'BOUNDARY: a task due today counts as overdue.' })], { facts: [notOverdue] }).map((w) => w.id)).toEqual(['boundary:getOverdue']);
    // a labelled clause wins over the leading text
    expect(run([op({ note: 'kept short; ordering: high priority first.' })])).toEqual([]);
  });

  it("reads an older board's ordering and boundary out of the note the fold wrote", () => {
    const folded = foldLegacyDesign({
      operations: [
        { name: 'listTasks(listId, filters)', inputs: '', returns: '', errors: '', satisfies: 'US-3', ordering: 'lowest first.' },
        { name: 'getOverdue(today)', inputs: '', returns: '', errors: '', boundary: 'a task due today counts as overdue.', example: 'getOverdue("2026-10-15")' },
      ],
    })!;
    expect(folded.design.operations[1].note).toBe('boundary: a task due today counts as overdue.; example: getOverdue("2026-10-15")');
    const warnings = contractWarnings({ design: folded.design, facts: [...facts, own('US-4/AC-2', 'Given a task due today, then it is not overdue')] });
    expect(warnings.map((w) => w.id)).toEqual(['ordering:listTasks', 'boundary:getOverdue']);
    expect(warnings[1].said).toBe('a task due today counts as overdue.');
  });

  it('reads the lists of an operation as one line joined with commas', () => {
    const [w] = run([overdue({ returns: 'the tasks', inputs: ['today', 'due_date'] })], { fields: ['id', 'title'] });
    expect(w.text).toBe('getOverdue reads due_date, but the task model has no due_date field.');
    const [signature] = run([overdue({ inputs: ['none', 'the report reads the clock'] })]);
    expect(signature.said).toBe('none, the report reads the clock');
  });
});
