import { buildProjectMap } from './map';
import { serialiseStory, EMPTY_STORY, LEARNER_PICKS, STORY_JSON } from './requirements-story';
import type { EnrollmentView, PhaseDetail } from './index';

/*
 * The project map on a story phase: no markdown to read, so its stories are the
 * phase's provided stories and the learner's own record.
 */
const enrollment = {
  currentPhaseOrder: 1,
  phases: [{ id: 'p1', key: 'requirements', order: 1, status: 'in_progress' }],
} as unknown as EnrollmentView;

const detail = (record: string, storyId = 'US-4', files?: { path: string; content: string; editable: boolean; language: string }[]) =>
  ({
    id: 'p1',
    key: 'requirements',
    files: files ?? [{ path: STORY_JSON, content: record, editable: true, language: 'json' }],
    story: {
      id: storyId,
      hints: {},
      floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true },
      providedStories: [
        {
          id: 'US-1',
          title: 'Add a task',
          persona: 'busy learner',
          capability: 'to add a task',
          benefit: 'I capture work',
          criteria: [{ id: 'AC-1', given: 'an empty list', when: 'I add a task', then: 'it is stored', tag: 'happy' }],
        },
      ],
    },
  }) as unknown as PhaseDetail;

describe('the project map on a story phase', () => {
  it('draws the provided stories as given and the untouched record as the story yours to write', () => {
    const map = buildProjectMap(enrollment, { p1: detail(serialiseStory(EMPTY_STORY)) });
    const ids = map.nodes.map((node) => node.id);
    expect(ids).toEqual(['story:US-1', 'crit:US-1.1', 'story:US-4']);
    expect(map.nodes.find((node) => node.id === 'story:US-1')?.given).toBe(true);
    expect(map.nodes.find((node) => node.id === 'story:US-4')?.state).toBe('todo');
  });

  it("draws the learner's record, its sentence and its complete criteria, from story.json", () => {
    const record = serialiseStory({
      ...EMPTY_STORY,
      title: 'Overdue report',
      persona: 'busy learner',
      capability: 'an overdue report',
      benefit: 'I see what I missed',
      criteria: [
        { id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' },
        { id: 'AC-2', given: 'a task due today', when: '', then: 'it is not listed', tag: 'boundary' },
      ],
    });
    const map = buildProjectMap(enrollment, { p1: detail(record) });
    const own = map.nodes.find((node) => node.id === 'story:US-4')!;
    expect(own.label).toBe('Overdue report');
    expect(own.detail).toBe('As a busy learner, I want an overdue report, so that I see what I missed');
    expect(own.file).toBe(STORY_JSON);
    // the half-written AC-2 is not drawn
    expect(map.nodes.filter((node) => node.kind === 'criterion').map((node) => node.id)).toEqual(['crit:US-1.1', 'crit:US-4.1']);
    expect(map.edges).toEqual(expect.arrayContaining([{ from: 'story:US-4', to: 'crit:US-4.1', kind: 'trace' }]));
  });

  it("never doubles the sentence's lead words in the story's detail, and a clean part reads as before", () => {
    const sentence = (persona: string, capability: string, benefit: string) =>
      buildProjectMap(enrollment, { p1: detail(serialiseStory({ ...EMPTY_STORY, title: 'Overdue task badge', persona, capability, benefit })) })
        .nodes.find((node) => node.id === 'story:US-4')!.detail;
    const run6 = 'As a team member, I want tasks due before today to show an overdue badge, so that I can quickly identify overdue tasks';
    expect(sentence('a team member', 'I want tasks due before today to show an overdue badge', 'so that I can quickly identify overdue tasks')).toBe(run6);
    expect(sentence('team member', 'tasks due before today to show an overdue badge', 'I can quickly identify overdue tasks')).toBe(run6);
    expect(sentence('As a team member', 'I want tasks due before today to show an overdue badge', 'so that I can quickly identify overdue tasks')).toBe(run6);
    expect(sentence('the team lead', 'to see overdue tasks', '')).toBe('As the team lead, I want to see overdue tasks');
    expect(sentence('administrator', 'to see overdue tasks', 'I chase them')).toBe('As an administrator, I want to see overdue tasks, so that I chase them');
    expect(sentence('user', 'to see overdue tasks', 'I chase them')).toBe('As a user, I want to see overdue tasks, so that I chase them');
    expect(sentence('an MBA student', 'to see overdue tasks', '')).toBe('As an MBA student, I want to see overdue tasks');
    // the provided story, clean, reads exactly as it did
    const provided = buildProjectMap(enrollment, { p1: detail(serialiseStory(EMPTY_STORY)) }).nodes.find((node) => node.id === 'story:US-1')!;
    expect(provided.detail).toBe('As a busy learner, I want to add a task, so that I capture work');
  });

  it('reads "I want to" before a bare verb from the composer\'s closed lists, the same table as apps/web/test/story-sentence.test.tsx', () => {
    const want = (capability: string) =>
      (buildProjectMap(enrollment, { p1: detail(serialiseStory({ ...EMPTY_STORY, title: 'Overdue task badge', persona: 'a team member', capability, benefit: '' })) })
        .nodes.find((node) => node.id === 'story:US-4')!.detail ?? '').replace(/^As a team member, I want /, '');
    const table: [string, string][] = [
      ['see an overdue badge on tasks due before today', 'to see an overdue badge on tasks due before today'],
      ['tasks due before today to show an overdue badge', 'tasks due before today to show an overdue badge'],
      ['a badge on a task that is past its due date', 'a badge on a task that is past its due date'],
      ['a page listing every task whose due date has already passed', 'a page listing every task whose due date has already passed'],
      ['to see an overdue badge', 'to see an overdue badge'],
      ['I want to see an overdue badge', 'to see an overdue badge'],
      ['I want see an overdue badge', 'to see an overdue badge'],
      ['See an overdue badge', 'to See an overdue badge'],
      ['be told which tasks are late', 'to be told which tasks are late'],
      ['receive a reminder', 'to receive a reminder'],
      ['view my overdue tasks', 'to view my overdue tasks'],
      ['filter the list by status', 'to filter the list by status'],
      ['mark a task as done', 'to mark a task as done'],
      ['list the tasks that are overdue', 'to list the tasks that are overdue'],
      ['view counts to stay visible', 'view counts to stay visible'],
      ['filter options to appear above the list', 'filter options to appear above the list'],
      ['list of overdue tasks', 'list of overdue tasks'],
      ['open tasks to appear first', 'open tasks to appear first'],
      ['report of the tasks that are overdue', 'report of the tasks that are overdue'],
      ['filter tasks by status', 'filter tasks by status'],
      ['undo button to appear after a delete', 'undo button to appear after a delete'],
      ['undo the last change', 'to undo the last change'],
      ['overdue tasks highlighted', 'overdue tasks highlighted'],
      ['seeing overdue tasks', 'seeing overdue tasks'],
    ];
    for (const [capability, afterIWant] of table) expect(want(capability)).toBe(afterIWant);
    expect(buildProjectMap(enrollment, { p1: detail(serialiseStory({ ...EMPTY_STORY, persona: 'team member', capability: 'see an overdue badge on tasks due before today', benefit: 'I can quickly identify tasks that need attention' })) })
      .nodes.find((node) => node.id === 'story:US-4')!.detail).toBe('As a team member, I want to see an overdue badge on tasks due before today, so that I can quickly identify tasks that need attention');
  });

  it('names a story whose id the learner has not picked yet story:learner, labelled Your story', () => {
    const map = buildProjectMap(enrollment, { p1: detail(serialiseStory({ ...EMPTY_STORY, id: '' }), LEARNER_PICKS) });
    const own = map.nodes.find((node) => node.kind === 'story' && !node.given)!;
    expect(own.id).toBe('story:learner');
    expect(own.label).toBe('Your story');
    expect(map.nodes.map((node) => node.id).join(' ')).not.toContain(LEARNER_PICKS);
  });

  it('reads the record at story.json only, never another editable JSON file', () => {
    const other = serialiseStory({ ...EMPTY_STORY, id: 'US-9', title: 'Not the record', persona: 'someone', capability: 'something', benefit: 'why' });
    const map = buildProjectMap(enrollment, {
      p1: detail('', 'US-4', [{ path: 'requirements/notes.json', content: other, editable: true, language: 'json' }]),
    });
    expect(map.nodes.map((node) => node.id)).toEqual(['story:US-1', 'crit:US-1.1', 'story:US-4']);
    const own = map.nodes.find((node) => node.id === 'story:US-4')!;
    expect(own.label).toBe('US-4');
    expect(own.file).toBe(STORY_JSON);
  });
});
