import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import type { InterviewFactView } from '@learnsdlc/shared';
import { Room } from '@/components/workspace/interview/Room';

/**
 * The interview's empty state is the web's own copy, so it must not name
 * TaskTrackr's story on every project ("Ask what you need to know before you
 * write US-4."). On a teacher's project US-4 is at most an inherited
 * optional task, and the story the class writes is the teacher's. The persona
 * and the opening are the project's own content and are not asserted here.
 */
const facts = [
  { id: 'who', topic: 'Who books a room' },
  { id: 'clash', topic: 'What happens on a clash' },
  { id: 'cancel', topic: 'Who can cancel' },
] as unknown as InterviewFactView[];

const room = () =>
  renderToStaticMarkup(
    <Room
      persona={{ name: 'Mira Okafor', role: 'Facilities lead' }}
      opening="Staff keep double-booking the big room."
      turns={[]}
      facts={facts}
      factsExpected={2}
      outgoing={[]}
      onRetry={() => undefined}
      canRetry={false}
      busy={false}
      scrollRef={createRef<HTMLDivElement>()}
    />,
  );

describe('the interview before the first question', () => {
  it('names no project’s story, and still says how many things can be settled and how many are enough', () => {
    const html = room();
    expect(html).toContain('data-testid="interview-empty"');
    expect(html).not.toContain('US-4');
    expect(html).toContain('Ask what you need to know before you write your user story.');
    // Both of the pack's numbers: the topic count, and the saved factsExpected as the number that is enough.
    expect(html).toContain('Three things can be settled; two are enough to write your story.');
  });
});

/**
 * The same room's "enough" notice must not say "You have enough to write
 * US-4." on every project. Deciding by the project's slug would put a quoted
 * slug in a learner module, which the codebase guard in useProject.test.ts
 * refuses. The name comes from the version's own content: the id the room's
 * own story file carries, which
 * is the id the backlog row beside it shows. A file with no usable id gets the
 * neutral sentence, never a default borrowed from TaskTrackr.
 */
import { Checklist, interviewStoryName } from '@/components/workspace/interview/Checklist';

const settled = [
  { id: 'who', topic: 'Who books a room', uncovered: true },
  { id: 'clash', topic: 'What happens on a clash', uncovered: true },
] as unknown as InterviewFactView[];

const checklist = (story?: string) =>
  renderToStaticMarkup(<Checklist facts={settled} factsExpected={2} issueHref="/workspace/p1/issue" story={story} />);

describe('the interview’s "enough" notice', () => {
  it('names the story by the id its own story file carries', () => {
    expect(interviewStoryName('{"id":"US-4","title":""}')).toBe('US-4');
    expect(checklist(interviewStoryName('{"id":"US-4"}'))).toContain('You have enough to write US-4.');
    const html = checklist(interviewStoryName('{ "id": " BK-1 ", "title": "Book a room" }'));
    expect(html).toContain('You have enough to write BK-1.');
    expect(html).not.toContain('US-4');
  });

  it('says the neutral sentence when the file carries no usable id', () => {
    for (const text of [undefined, null, '', '   ', 'not json', '[]', 'null', '{}', '{"id":""}', '{"id":42}',
      '{"id":"<b>US-4</b>"}', '{"id":"a story id with spaces"}', `{"id":"${'X'.repeat(40)}"}`]) {
      expect(interviewStoryName(text)).toBe('your user story');
    }
    const html = checklist(interviewStoryName(undefined));
    expect(html).toContain('data-testid="interview-enough"');
    expect(html).not.toContain('US-4');
    expect(html).toContain('You have enough to write your user story.');
    expect(checklist()).toContain('You have enough to write your user story.');
  });

  // That the Requirements room feeds the notice its own story file, and not the
  // project's slug, is asserted on the rendered room in `requirements-design-rooms.test.tsx`.
});
