import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { InterviewFactView, InterviewState } from '@learnsdlc/shared';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/scenario', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useScenarioReference: () => false,
}));

import { Room } from '@/components/workspace/interview/Room';
import { Checklist } from '@/components/workspace/interview/Checklist';
import { InterviewPanel } from '@/components/workspace/requirements/InterviewPanel';

/**
 * The interview's two counts. A teacher who saves "2 facts, 1 worth settling"
 * (PhaseScenario's summary: the fact count, then `factsExpected`) must not see
 * the learner's room give 2 as the number that is enough. The room
 * says both of the pack's numbers in one sentence that is true for any pack,
 * "Two things can be settled; one is enough to write your story.", and the
 * checklist says the same two numbers ("0 of 2 settled, 1 is enough").
 */
const WALK_FACTS = [
  { id: 'free', topic: 'What free to borrow means', uncovered: false },
  { id: 'loan', topic: 'What a member sees for a book on loan', uncovered: false },
] as InterviewFactView[];

const room = (facts: InterviewFactView[], factsExpected?: number) =>
  renderToStaticMarkup(
    <Room
      persona={{ name: 'The head librarian', role: 'Library' }}
      opening="Members keep asking for books that are out."
      turns={[]}
      facts={facts}
      factsExpected={factsExpected}
      outgoing={[]}
      onRetry={() => undefined}
      canRetry
      busy={false}
      scrollRef={createRef<HTMLDivElement>()}
    />,
  );

const checklist = (facts: InterviewFactView[], factsExpected: number) =>
  renderToStaticMarkup(<Checklist facts={facts} factsExpected={factsExpected} issueHref="/workspace/p1/issue" />);

const textOf = (html: string, testId: string) => {
  const match = new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</p>`).exec(html);
  return match ? match[1].replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '') : null;
};

describe('the learner room says the teacher’s numbers', () => {
  it('says two can be settled and one is enough when the teacher saved 2 facts, 1 worth settling', () => {
    const html = room(WALK_FACTS, 1);
    expect(html).toContain('Two things can be settled; one is enough to write your story.');
    expect(html).not.toMatch(/two are enough|worth settling/);
  });

  it('counts the checklist against the same numbers: 2 topics, 1 enough', () => {
    const none = checklist(WALK_FACTS, 1);
    expect(textOf(none, 'interview-checklist-count')).toBe('0 of 2 settled, 1 is enough');
    const one = checklist([{ ...WALK_FACTS[0], uncovered: true }, WALK_FACTS[1]], 1);
    expect(textOf(one, 'interview-checklist-count')).toBe('1 of 2 settled, 1 is enough');
    // The topic count keeps its own element (e2e/interview.spec.ts reads it).
    expect(one).toMatch(/data-testid="interview-settled"[^>]*>1(<!-- -->)? of (<!-- -->)?2(<!-- -->)? settled</);
    expect(one).toContain('data-testid="interview-enough"');
  });

  it('puts a plural back for more than one, and spells the number the teacher saved', () => {
    const three = [...WALK_FACTS, { id: 'renew', topic: 'Who can renew', uncovered: false }] as InterviewFactView[];
    expect(room(three, 2)).toContain('Three things can be settled; two are enough to write your story.');
    expect(room(three, 3)).toContain('Three things can be settled, and all three are needed to write your story.');
    expect(room(three.slice(0, 1), 1)).toContain('One thing can be settled, and it is needed to write your story.');
    expect(textOf(checklist(three, 2), 'interview-checklist-count')).toBe('0 of 3 settled, 2 are enough');
  });

  it('says only the topic count when the room is not told the number, and no count without a topic', () => {
    const html = room(WALK_FACTS);
    expect(html).toContain('Ask what you need to know before you write your user story. Two things can be settled.');
    expect(html).not.toMatch(/enough|needed/);
    expect(room([], 3)).not.toMatch(/can be settled|enough/);
  });

  it('TaskTrackr: the room says its own factsExpected, not its topic count', () => {
    const pack = JSON.parse(readFileSync(
      repoPath('content/tasktrackr/phases/01-requirements/interview.json'), 'utf8',
    )) as { facts: { id: string; topic: string }[]; factsExpected: number };
    const facts = pack.facts.map((fact) => ({ id: fact.id, topic: fact.topic, uncovered: false })) as InterviewFactView[];
    expect([facts.length, pack.factsExpected]).toEqual([10, 6]);
    expect(room(facts, pack.factsExpected)).toContain('Ten things can be settled; six are enough to write your story.');
    expect(textOf(checklist(facts, pack.factsExpected), 'interview-checklist-count')).toBe('0 of 10 settled, 6 are enough');
  });

  it('the requirements interview panel hands the room the state’s factsExpected', () => {
    const state = {
      persona: { name: 'The head librarian', role: 'Library' },
      opening: 'Members keep asking for books that are out.',
      startedAt: null,
      turns: [],
      facts: WALK_FACTS,
      factsExpected: 1,
      turnsLeft: 10,
      closedAt: null,
    } satisfies InterviewState;
    const interview = {
      state, draft: '', setDraft: () => undefined, outgoing: [], retry: async () => undefined, busy: false,
      error: '', absent: false, loading: false, scrollRef: { current: null }, send: async () => undefined,
      reopen: () => undefined,
    } as unknown as Parameters<typeof InterviewPanel>[0]['interview'];
    const html = renderToStaticMarkup(<InterviewPanel interview={interview} backlogHref="/workspace/p1/issue" />);
    expect(html).toContain('Two things can be settled; one is enough to write your story.');
  });
});
