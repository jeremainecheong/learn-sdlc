import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_STORY_FLOOR, STORY_CAPS, STORY_JSON } from '@learnsdlc/shared';
import type { ContentFileSpec } from './content.types';
import { storyChecksFromLegacyMarkdown } from './story-legacy';
import { FIXTURES_DIR } from '../../test/fixtures/paths';

/** TaskTrackr 2.x's markdown backlog and story scaffold, kept as the adapter's input after 3.0.0 retired them. */
const FILES = join(FIXTURES_DIR, 'legacy-requirements');
const md = (path: string, content: string, editable = false): ContentFileSpec => ({ path, content, editable, language: 'markdown' });
const shipped = (path: string, source: string, editable: boolean) => md(path, readFileSync(join(FILES, source), 'utf8'), editable);
const PROVIDED = shipped('requirements/provided-stories.md', 'provided-stories.md', false);
const OWN = shipped('requirements/my-story.md', 'my-story.md', true);
const RAW = { kind: 'markdown', targets: ['requirements/my-story.md'], rules: [] };

describe('storyChecksFromLegacyMarkdown, on the shipped TaskTrackr backlog', () => {
  const files = [PROVIDED, OWN, md('requirements/notes.md', 'kept', true)];
  const out = storyChecksFromLegacyMarkdown(files, RAW);

  it('reads the provided stories, skipping the placeholder for the learner story', () => {
    expect(out.checks.kind).toBe('story');
    expect(out.checks.record).toBe(STORY_JSON);
    expect(out.checks.providedStories.map((s) => s.id)).toEqual(['US-1', 'US-2', 'US-3', 'US-5']);
  });

  it('cleans the italic status note off every title', () => {
    expect(out.checks.providedStories.map((s) => s.title)).toEqual([
      'Add a task',
      'Complete a task',
      'Filter, search and order a list',
      'See at a glance which tasks are late',
    ]);
  });

  it('parses persona, capability and benefit out of the prose sentence', () => {
    for (const story of out.checks.providedStories) {
      expect(story.persona).toBe('busy learner');
      expect(story.capability.length).toBeGreaterThan(0);
      expect(story.benefit.length).toBeGreaterThan(0);
    }
    expect(out.checks.providedStories[0]).toMatchObject({
      capability: 'to add a task to a list with a title, a priority and an optional due date',
      benefit: 'I can capture work the moment I think of it',
    });
    expect(out.note).not.toContain('default persona');
  });

  it('reads the learner story id from the "# US-4" heading of my-story.md', () => {
    expect(out.checks.learnerStory).toEqual({ id: 'US-4', hints: {} });
    const seven = storyChecksFromLegacyMarkdown([PROVIDED, md('requirements/my-story.md', '# US-7\n\nTBD\n')], RAW);
    expect(seven.checks.learnerStory.id).toBe('US-7');
    // the US-4 placeholder is a provided story now that the learner writes US-7
    expect(seven.checks.providedStories.map((s) => s.id)).toContain('US-4');
  });

  it('applies the default floor as a copy', () => {
    expect(out.checks.floor).toEqual(DEFAULT_STORY_FLOOR);
    expect(out.checks.floor).not.toBe(DEFAULT_STORY_FLOOR);
  });

  it('drops both markdown files and keeps every other file', () => {
    expect(out.files.map((f) => f.path)).toEqual(['requirements/notes.md']);
    expect(out.note).toBe(
      'Requirements converted from markdown: 4 provided stories, learner story US-4, default floor; 1 rule targets dropped. ' +
        'The acceptance criteria written under US-1, US-2, US-3, US-5 were not converted; add them to those provided stories in the story builder.',
    );
  });

  it('carries no criteria over, which is what the note says', () => {
    expect(out.checks.providedStories.every((story) => story.criteria === undefined)).toBe(true);
  });
});

describe('storyChecksFromLegacyMarkdown, on backlogs the shipped one does not exercise', () => {
  it('fills defaults where the sentence is missing and names those stories', () => {
    const backlog = '## US-1 — Export a list *(approved)*\n\nThe list downloads as CSV. More text.\n';
    const out = storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW);
    expect(out.checks.providedStories[0]).toEqual({
      id: 'US-1', title: 'Export a list', persona: 'user', capability: 'Export a list', benefit: 'The list downloads as CSV.',
    });
    expect(out.note).toContain('default persona, capability or benefit filled for US-1');
    // a backlog with no criteria says nothing about criteria
    expect(out.note).not.toContain('acceptance criteria');
  });

  it('names only the stories whose markdown wrote criteria, in either form', () => {
    const backlog = [
      '## US-1 — Labelled\n\nAs a user, I want a, so that b.\n\n- **AC-1** Given x, when y, then z.\n',
      '## US-2 — Bare\n\nAs a user, I want c, so that d.\n',
      '## US-3 — Prose\n\nAs a user, I want e, so that f.\n\nGiven a list, when I open it, then it loads.\n',
    ].join('\n');
    const out = storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW);
    expect(out.note).toMatch(/\. The acceptance criteria written under US-1, US-3 were not converted; add them to those provided stories in the story builder\.$/);
  });

  it('does not take a story sentence that merely contains given, when and then for written criteria', () => {
    const backlog = [
      '## US-1 — Sentence\n\nAs a planner, I want the tasks I am given to show when they fall due, so that I can plan then.\n',
      '## US-2 — Gherkin\n\nAs a user, I want c, so that d.\n\nGiven a list\nWhen I open it\nThen it loads\n',
      '## US-3 — Bulleted\n\nAs a user, I want e, so that f.\n\n1. **Given** a list, **when** I open it, **then** it loads.\n',
    ].join('\n');
    const out = storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW);
    expect(out.note).toMatch(/\. The acceptance criteria written under US-2, US-3 were not converted; add them to those provided stories in the story builder\.$/);
  });

  it('also names criteria written as `- AC-1: Given`, `- **AC-1:** Given` or a table row', () => {
    const backlog = [
      '## US-1 — Colon\n\nAs a user, I want a, so that b.\n\n- AC-1: Given x, when y, then z.\n',
      '## US-2 — Bold colon\n\nAs a user, I want c, so that d.\n\n- **AC-1:** Given x, when y, then z.\n',
      '## US-3 — Table\n\nAs a user, I want e, so that f.\n\n| Id | Criterion |\n| --- | --- |\n| AC-1 | Given x, when y, then z |\n',
      '## US-5 — Sentence\n\nAs a planner, I want the tasks I am given to show when they fall due, so that I can plan then.\n',
    ].join('\n');
    const out = storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW);
    expect(out.note).toMatch(/\. The acceptance criteria written under US-1, US-2, US-3 were not converted; add them to those provided stories in the story builder\.$/);
  });

  it('reads the bold-label layout when there is no prose sentence', () => {
    const backlog = '## US-2: Archive\n\n**As a** team lead\n**I want** to archive a list\n**So that** the board stays short\n';
    const out = storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW);
    expect(out.checks.providedStories[0]).toMatchObject({ persona: 'team lead', capability: 'to archive a list', benefit: 'the board stays short' });
  });

  it(`keeps at most ${STORY_CAPS.providedStories} provided stories and says how many it dropped`, () => {
    const backlog = Array.from({ length: STORY_CAPS.providedStories + 2 }, (_, i) =>
      `## US-${i + 10} — Story ${i}\n\nAs a user, I want thing ${i}, so that it works.\n`).join('\n');
    const out = storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW);
    expect(out.checks.providedStories).toHaveLength(STORY_CAPS.providedStories);
    expect(out.note).toContain(`2 provided stories beyond the cap of ${STORY_CAPS.providedStories} dropped`);
  });

  it('throws when the converted checks would be refused by the loader', () => {
    const backlog = '## US-1 — One\n\nAs a user, I want a, so that b.\n\n## US-1 — Again\n\nAs a user, I want c, so that d.\n';
    expect(() => storyChecksFromLegacyMarkdown([md('requirements/provided-stories.md', backlog)], RAW)).toThrow(
      'legacy requirements could not be converted: providedStories ids must be unique',
    );
  });
});
