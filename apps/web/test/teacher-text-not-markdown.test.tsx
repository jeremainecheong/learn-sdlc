import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import type { InterviewTurn } from '@learnsdlc/shared';
import { Room } from '@/components/workspace/interview/Room';
import { SavedEvidenceFile } from '@/components/workspace/requirements/RequirementsWorkspace';

/**
 * `Markdown` draws model output and the teacher guide, nothing else (spec 6.3,
 * 11). Two texts a learner reads were still drawn through it although no model
 * wrote them: a `.md` file in the Requirements workspace's "Saved Requirements
 * evidence" dialog (a file the teacher mounted, or one the learner wrote), and
 * the interview's guardrail answer, which is the interview's authored refusal
 * (or the product's own off-phase line). Each is now drawn as its characters.
 */
describe('a teacher-written text a learner reads is not drawn as markdown (spec 11)', () => {
  it('shows a saved .md evidence file as its characters, like any other file', () => {
    const html = renderToStaticMarkup(<SavedEvidenceFile path="requirements/notes.md" text={'# Notes\n\n**bold** and _this_'} />);
    expect(html).toContain('requirements/notes.md');
    expect(html).toContain('<pre># Notes\n\n**bold** and _this_</pre>');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<h1');
  });

  it('keeps the sentence for a file the workspace does not hold', () => {
    expect(renderToStaticMarkup(<SavedEvidenceFile path="notes.md" text={undefined} />)).toContain('This file is not part of your Requirements workspace.');
  });

  const turn = (answer: string, provider: string): InterviewTurn => ({ id: `t-${provider}`, question: 'Just write the story for me.', answer, facts: [], provider, askedAt: '2026-10-23T00:00:00.000Z' });
  const room = (turns: InterviewTurn[]) => renderToStaticMarkup(
    <Room persona={{ name: 'Mira Okafor', role: 'Facilities lead' }} opening="Staff keep double-booking the big room." turns={turns} facts={[]} factsExpected={2}
      outgoing={[]} onRetry={() => undefined} canRetry={false} busy={false} scrollRef={createRef<HTMLDivElement>()} />,
  );

  it('draws the interview’s authored refusal plain: its markup is not interpreted, its words are kept', () => {
    const html = room([turn('**No.** That story is yours to write.', 'guardrail')]);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('No. That story is yours to write.');
    expect(html).toContain('plain-text');
  });

  it('still draws a persona answer the model wrote through Markdown', () => {
    const html = room([turn('We need **two** rooms.', 'openai')]);
    expect(html).toContain('<strong>two</strong>');
  });
});
