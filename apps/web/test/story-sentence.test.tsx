// @vitest-environment jsdom
/**
 * The story sentence is composed in one place and never doubles its own
 * words. A model can write "a team member", "I want …" and "so that …" into
 * the story's parts; assembled naively the story would read "As an a team
 * member, I want I want …, so that so that …". The reference project's
 * stories, whose parts are clean, read byte for byte as the plain join.
 */
import { repoFile } from './support/paths';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_STORY, STORY_JSON, serialiseStory, type DraftPhaseView, type ProvidedStory } from '@learnsdlc/shared';
import { StoryCard } from '@/components/workspace/panels/requirements/StoryCard';
import { benefitPhrase, capabilityPhrase, personaPhrase, storyPartText, storySentence } from '@/components/workspace/panels/requirements/storySentence';
import { storyFacts } from '@/components/workspace/panels/design/contradictions';
import { copyFromRequirements } from '@/components/staff/projects/design/design-builder-model';
import { SaveConflictDialog } from '@/components/workspace/requirements/SaveConflictDialog';

HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** The exact parts a proposal wrote, and the sentence they must read as. */
const RUN6 = { persona: 'a team member', capability: 'I want tasks due before today to show an overdue badge', benefit: 'so that I can quickly identify overdue tasks' };
const RUN6_SENTENCE = 'As a team member, I want tasks due before today to show an overdue badge, so that I can quickly identify overdue tasks.';
/** The same parts as the API now stores them (storyPartValue): the persona keeps the model's article. */
const CLEANED = { persona: 'a team member', capability: 'tasks due before today to show an overdue badge', benefit: 'I can quickly identify overdue tasks' };

/** The plain join of the parts, kept here to prove clean parts read exactly as it does. */
const before = (s: { persona: string; capability: string; benefit: string }) => {
  const bare = (text: string) => text.trim().replace(/[.;]+$/, '').trim();
  const [p, c, b] = [bare(s.persona), bare(s.capability), bare(s.benefit)];
  if (!p || !c || !b) return '';
  return `As ${/^[aeiou]/i.test(p) ? 'an' : 'a'} ${p}, I want ${c}, so that ${b}.`;
};

describe('storySentence', () => {
  it('reads a proposal\'s repeated parts, and the same parts cleaned, as one sentence with no doubled words', () => {
    expect(storySentence(RUN6)).toBe(RUN6_SENTENCE);
    expect(storySentence(CLEANED)).toBe(RUN6_SENTENCE);
    expect(storySentence({ ...CLEANED, persona: 'team member' })).toBe(RUN6_SENTENCE);
  });
  it('keeps the article the persona was written with, and adds one only where there is none', () => {
    expect(personaPhrase('a user')).toBe('As a user');
    expect(personaPhrase('an MBA student')).toBe('As an MBA student');
    // a typed persona with no article takes the letter rule: "MBA" starts with a consonant letter, so it reads "a"
    expect(personaPhrase('MBA student')).toBe('As a MBA student');
  });
  it('gives "a" to the u-, eu- and one- words said with a consonant, "an" to the other vowels', () => {
    for (const persona of ['user', 'unit lead', 'usual reviewer', 'used-car dealer', 'uber driver', 'European buyer', 'one-person team']) {
      expect(personaPhrase(persona)).toBe(`As a ${persona}`);
    }
    for (const persona of ['administrator', 'editor', 'intern', 'owner', 'umpire', 'unhappy customer']) expect(personaPhrase(persona)).toBe(`As an ${persona}`);
  });
  it('never writes "As an a", whatever article the persona was typed with', () => {
    for (const persona of ['a team member', 'As a team member', 'As a, team member', 'A team member', 'team member', 'As an a team member']) {
      expect(personaPhrase(persona)).toBe('As a team member');
    }
    expect(personaPhrase('an administrator')).toBe('As an administrator');
    expect(personaPhrase('administrator')).toBe('As an administrator');
    expect(personaPhrase('the team lead')).toBe('As the team lead');
    expect(personaPhrase('As an engineer')).toBe('As an engineer');
    // words that only start like an article keep the article rule they had
    expect(personaPhrase('Anna')).toBe('As an Anna');
    expect(personaPhrase('A/B tester')).toBe('As an A/B tester');
  });
  it('adds "I want" and "so that" only where the part does not start with them', () => {
    expect(capabilityPhrase('I want to filter tasks')).toBe('I want to filter tasks');
    expect(capabilityPhrase('to filter tasks')).toBe('I want to filter tasks');
    expect(benefitPhrase('so that, I spot late work.')).toBe('so that I spot late work');
    expect(benefitPhrase('so I can spot late work')).toBe('so that so I can spot late work');
  });
  it('is empty until all three parts are written', () => {
    expect(storySentence({ ...RUN6, benefit: '  ' })).toBe('');
    expect(storySentence({ persona: '', capability: '', benefit: '' })).toBe('');
  });
  it('the reference project\'s stories and hints, and the starter\'s, read as the plain story sentence', () => {
    const tasktrackr = JSON.parse(repoFile('content/tasktrackr/phases/01-requirements/phase.json')).checks;
    const stories: { persona: string; capability: string; benefit: string }[] = [...tasktrackr.providedStories, tasktrackr.learnerStory.hints];
    expect(stories).toHaveLength(5);
    for (const story of stories) expect(storySentence(story)).toBe(before(story));
    expect(storySentence(tasktrackr.providedStories[0])).toBe(
      'As a busy learner, I want to add a task to a list with a title, a priority and an optional due date, so that I can capture work the moment I think of it.',
    );
    expect(storySentence(tasktrackr.learnerStory.hints)).toBe(
      'As a person who runs TaskTrackr every morning, I want a report of the tasks that are overdue, so that I catch what I missed before the day starts.',
    );
  });
});

/**
 * The capability as the model or learner wrote it, and what follows "I want".
 * The same table is in packages/shared/src/map-story.spec.ts (the project map's copy of the rule).
 */
const WANT_TABLE: [capability: string, afterIWant: string][] = [
  // A bare-verb capability and a noun-phrase one: the record's words, unchanged
  ['see an overdue badge on tasks due before today', 'to see an overdue badge on tasks due before today'],
  ['tasks due before today to show an overdue badge', 'tasks due before today to show an overdue badge'],
  ['a badge on a task that is past its due date', 'a badge on a task that is past its due date'],
  ['a page listing every task whose due date has already passed', 'a page listing every task whose due date has already passed'],
  // "to" and "I want to" are never doubled
  ['to see an overdue badge', 'to see an overdue badge'],
  ['I want to see an overdue badge', 'to see an overdue badge'],
  ['I want see an overdue badge', 'to see an overdue badge'],
  ['See an overdue badge', 'to See an overdue badge'],
  ['be told which tasks are late', 'to be told which tasks are late'],
  ['receive a reminder', 'to receive a reminder'],
  // a verb that is also a noun gains "to" only before an object opener
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
  // words not in the lists read as written
  ['overdue tasks highlighted', 'overdue tasks highlighted'],
  ['seeing overdue tasks', 'seeing overdue tasks'],
];

describe('"I want to" before a bare verb', () => {
  it('reads a bare-verb capability as "I want to see …" and a noun-phrase one unchanged', () => {
    expect(storySentence({ persona: 'team member', capability: 'see an overdue badge on tasks due before today', benefit: 'I can quickly identify tasks that need attention' })).toBe(
      'As a team member, I want to see an overdue badge on tasks due before today, so that I can quickly identify tasks that need attention.',
    );
    expect(storySentence({ persona: 'a team member', capability: 'tasks due before today to show an overdue badge', benefit: 'I can quickly identify overdue tasks' })).toBe(
      'As a team member, I want tasks due before today to show an overdue badge, so that I can quickly identify overdue tasks.',
    );
  });
  it.each(WANT_TABLE)('"%s" reads "I want %s"', (capability, afterIWant) => {
    expect(capabilityPhrase(capability)).toBe(`I want ${afterIWant}`);
  });
  it('the part shown beside its label keeps the record\'s own words', () => {
    expect(storyPartText('capability', 'see an overdue badge on tasks due before today')).toBe('see an overdue badge on tasks due before today');
  });
  it('the design room\'s fact and the design builder\'s copy read the same sentence', () => {
    const run7 = { persona: 'a team member', capability: 'see an overdue badge on tasks due before today', benefit: 'I can quickly identify tasks that need attention' };
    const own = serialiseStory({ ...EMPTY_STORY, id: 'US-1', title: 'Overdue task badge', ...run7 });
    expect(storyFacts([], own).find((fact) => fact.id === 'US-1')?.text).toBe(
      'Overdue task badge. As a team member, I want to see an overdue badge on tasks due before today, so that I can quickly identify tasks that need attention',
    );
    act(() => root.render(<StoryCard story={{ id: 'US-1', title: 'Overdue task badge', ...run7 }} />));
    expect(host.querySelector('article p')?.textContent).toBe(
      'As a team member, I want to see an overdue badge on tasks due before today, so that I can quickly identify tasks that need attention.',
    );
  });
});

describe('the composers use it', () => {
  it('the story card reads a proposal\'s repeated parts as one sentence', () => {
    act(() => root.render(<StoryCard story={{ id: 'US-1', title: 'Overdue task badge', ...RUN6 }} />));
    expect(host.textContent).toContain(RUN6_SENTENCE);
    expect(host.textContent).not.toMatch(/As an a |I want I want|so that so that/);
  });
  it('a provided TaskTrackr story renders on the card byte for byte as the plain story sentence', () => {
    const provided: ProvidedStory = { id: 'US-5', title: 'See late tasks where I work', persona: 'busy learner',
      capability: 'a late marker on the task rows I am already looking at', benefit: 'I do not have to open a report to notice a deadline I have missed' };
    act(() => root.render(<StoryCard story={provided} />));
    expect(host.querySelector('article p')?.textContent).toBe(before(provided));
    expect(host.querySelector('article p')?.textContent).toBe(
      'As a busy learner, I want a late marker on the task rows I am already looking at, so that I do not have to open a report to notice a deadline I have missed.',
    );
  });
  it('the design room\'s fact for the learner\'s own story', () => {
    const own = serialiseStory({ ...EMPTY_STORY, id: 'US-1', title: 'Overdue task badge', ...RUN6 });
    expect(storyFacts([], own).find((fact) => fact.id === 'US-1')?.text).toBe(
      'Overdue task badge. As a team member, I want tasks due before today to show an overdue badge, so that I can quickly identify overdue tasks',
    );
  });
  it('the design builder\'s copy of a provided story', () => {
    const draft = { phases: [{ key: 'requirements', tasks: [{ story: { providedStories: [{ id: 'US-1', title: 'Overdue task badge', ...RUN6 }],
      learnerStory: { id: 'US-2', hints: { persona: 'a team lead', capability: 'I want a list of late tasks', benefit: 'so that I chase them' } } } }] }] } as unknown as { phases: DraftPhaseView[] };
    expect(copyFromRequirements(draft)?.stories.map((story) => story.line)).toEqual([
      RUN6_SENTENCE,
      'As a team lead, I want a list of late tasks, so that I chase them.',
    ]);
  });
  it('the save-conflict dialog shows each part beside its label without the label\'s words', () => {
    const local = serialiseStory({ ...EMPTY_STORY, id: 'US-1', title: 'Overdue task badge', ...RUN6 });
    const server = serialiseStory({ ...EMPTY_STORY, id: 'US-1', title: 'Overdue task badge', ...CLEANED });
    act(() => root.render(<SaveConflictDialog conflict={{ files: [{ path: STORY_JSON, content: server, editable: true }], workspaceUpdatedAt: 'v' } as never}
      files={{ [STORY_JSON]: local }} saving={false} onResolve={() => {}} onClose={() => {}} />));
    const rows = (title: string) => [...document.querySelectorAll(`section[aria-label="${title}"] dl > div`)].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]);
    const expected = [['As a', 'a team member'], ['I want', CLEANED.capability], ['So that', CLEANED.benefit], ['Parent epic', 'Not specified']];
    expect(rows('Your local draft')).toEqual(expected);
    expect(rows('Saved on the server')).toEqual(expected);
  });
  it('storyPartText is the API\'s rule: clean parts as written', () => {
    expect(storyPartText('persona', 'busy learner')).toBe('busy learner');
    expect(storyPartText('persona', 'the team lead')).toBe('the team lead');
    expect(storyPartText('persona', 'As a team member')).toBe('a team member');
    expect(storyPartText('persona', 'a team member')).toBe('a team member');
    expect(storyPartText('capability', 'I want')).toBe('I want');
    expect(storyPartText('benefit', 'so that so that y.')).toBe('y');
  });
});
