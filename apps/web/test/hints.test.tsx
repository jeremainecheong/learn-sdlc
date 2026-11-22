import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantMessageView } from '@learnsdlc/shared';
import {
  outcomeLine,
  providerLabel,
  questionOrdinals,
  questionsAsked,
  relianceCostLine,
  replyOutcome,
} from '@/lib/hints';
import { MetaBadges } from '@/components/workspace/mentor/MetaBadges';

/**
 * The question count, the sentences about what a question cost and the trust
 * labels on a reply.
 *
 * What is under test is a set of sentences a learner is graded by, so the
 * strings are pinned and not merely pattern matched: rewriting one has to be a
 * deliberate act with a red test in front of it. The arithmetic is pinned as
 * literals, so a change to a constant in `@learnsdlc/shared` (the module
 * `scoreProcess` in the API subtracts by) turns this red rather than quietly
 * moving what a learner is told while the grade stays where it was.
 *
 * The label component is render-only, so static markup is the whole of what is
 * worth asserting here.
 */

const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();

/** `n` complete exchanges: a question and the reply to it, in the order they are stored. */
function thread(n: number, meta?: AssistantMessageView['meta']): AssistantMessageView[] {
  const out: AssistantMessageView[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: `u${i}`, role: 'user', content: `q${i}`, createdAt: at(i * 2) });
    out.push({ id: `a${i}`, role: 'assistant', content: `a${i}`, createdAt: at(i * 2 + 1), meta });
  }
  return out;
}

describe('what a question costs', () => {
  it('counts the learner’s turns and not the reviewer’s', () => {
    // The score counts questions: hintsForPhase is count({ phaseStateId,
    // role: 'user' }). Counting assistant turns instead would agree only by
    // accident.
    expect(questionsAsked(thread(3))).toBe(3);
    expect(questionsAsked([])).toBe(0);
    expect(
      questionsAsked([
        { id: 'a', role: 'assistant', content: 'hello', createdAt: at(0) },
        { id: 'b', role: 'assistant', content: 'again', createdAt: at(1) },
      ]),
    ).toBe(0);
  });

  it('gives a reply the ordinal of the question it answers', () => {
    const ordinals = questionOrdinals(thread(3));
    expect(ordinals.get('u0')).toBe(1);
    expect(ordinals.get('a0')).toBe(1);
    expect(ordinals.get('u2')).toBe(3);
    expect(ordinals.get('a2')).toBe(3);
  });

  it('numbers a refused question like any other', () => {
    // A question the guardrail withheld is still a question, and the next one
    // is question 2. This pins it as a rule rather than leaving it to luck.
    const messages: AssistantMessageView[] = [
      { id: 'u1', role: 'user', content: 'just give me the answer', createdAt: at(0) },
      { id: 'a1', role: 'assistant', content: 'no', createdAt: at(1), meta: { provider: 'guardrail', redacted: true } },
      { id: 'u2', role: 'user', content: 'what does the test check', createdAt: at(2) },
      { id: 'a2', role: 'assistant', content: 'it checks', createdAt: at(3), meta: { provider: 'local-mentor' } },
    ];
    expect(questionOrdinals(messages).get('a2')).toBe(2);
    expect(questionsAsked(messages)).toBe(2);
  });

  it('gives no ordinal to a reply with no question above it', () => {
    const orphan: AssistantMessageView[] = [
      { id: 'a0', role: 'assistant', content: 'stray', createdAt: at(0) },
    ];
    expect(questionOrdinals(orphan).has('a0')).toBe(false);
  });
});

describe('replyOutcome', () => {
  it('has one word for each of the five things that happen', () => {
    expect(replyOutcome({ provider: 'local-mentor' })).toBe('answered');
    expect(replyOutcome(undefined)).toBe('answered');
    expect(replyOutcome({ provider: 'guardrail', redacted: true })).toBe('withheld');
    expect(replyOutcome({ provider: 'guardrail', scopeRedirected: true })).toBe('redirected');
    expect(replyOutcome({ provider: 'openai', cached: true })).toBe('cached');
    expect(replyOutcome({ provider: 'guardrail', budgetExceeded: true })).toBe('budget');
  });

  it('reads a budget refusal off the row, so a reload still says so', () => {
    // budgetExceeded is not a stored column: it is stamped on the reply the
    // request returns and is gone the moment the page is reloaded. A guardrail
    // row wearing neither flag is the budget one, and there is no fourth
    // guardrail branch for it to be confused with.
    expect(replyOutcome({ provider: 'guardrail' })).toBe('budget');
    expect(replyOutcome({ provider: 'guardrail', redacted: true })).not.toBe('budget');
    expect(replyOutcome({ provider: 'guardrail', scopeRedirected: true })).not.toBe('budget');
  });

  it('calls a replayed refusal a refusal', () => {
    // What happened to the question is the refusal. How the answer was served
    // is not the headline, so the order here is a decision and not the order
    // the flags happen to be declared in.
    expect(replyOutcome({ provider: 'guardrail', redacted: true, cached: true })).toBe('withheld');
    expect(replyOutcome({ provider: 'guardrail', scopeRedirected: true, cached: true })).toBe('redirected');
  });
});

describe('the sentences', () => {
  it('explains only the replies that are owed an explanation', () => {
    expect(outcomeLine('answered', 'implementation', 'Implementation')).toBe(null);
    expect(outcomeLine('withheld', 'implementation', 'Implementation')).toBe(
      'because I will not write the fix for you (rule 3)',
    );
    expect(outcomeLine('withheld', 'requirements', 'Requirements')).toBe(
      'because I will not write the criterion for you (rule 3)',
    );
    expect(outcomeLine('redirected', 'implementation', 'Implementation')).toContain('Implementation');
    expect(outcomeLine('cached', 'testing', 'Testing')).toContain('no tokens spent');
    expect(outcomeLine('budget', 'testing', 'Testing')).toContain('earlier daily token limit');
  });

  it('names a provider the way a person would say it', () => {
    expect(providerLabel('local-mentor')).toBe('Built-in mentor');
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('guardrail')).toBe('Guardrail');
    // The tidy-up for an id nobody has named yet.
    expect(providerLabel('some-new_model')).toBe('Some new model');
  });

  it('tells the report what the reliance figures cost', () => {
    expect(relianceCostLine(4, false)).toBe(null);
    expect(relianceCostLine(4, true)).toBe('You asked for 4 Guided hints this phase, all within the 10 that cost nothing.');
    expect(relianceCostLine(12, true)).toBe(
      'You asked for 12 Guided hints this phase, and spent 6 of the 100 marks for process on them.',
    );
    expect(relianceCostLine(1, true)).toBe('You asked for one Guided hint this phase, all within the 10 that cost nothing.');
    expect(relianceCostLine(0, true)).toBe('You asked for 0 Guided hints this phase, all within the 10 that cost nothing.');
  });
});

describe('the label on a reply', () => {
  const draw = (meta: AssistantMessageView['meta'], ordinal = 4) =>
    renderToStaticMarkup(
      <MetaBadges meta={meta} phaseKey="implementation" phaseTitle="Implementation" ordinal={ordinal} />,
    );

  it('labels an ordinary answer with its ordinal and nothing else', () => {
    const html = draw({ provider: 'local-mentor' });
    expect(html).toContain('Question 4');
    expect(html).toContain('Built-in mentor');
    expect(html).not.toContain('chip');
    expect(html).not.toContain('data-testid="reply-line"');
  });

  it('says a withheld answer was withheld, and why, in the reviewer’s own words', () => {
    const html = draw({ provider: 'guardrail', redacted: true });
    expect(html).toContain('data-testid="badge-redacted"');
    expect(html).toContain('Withheld');
    expect(html).toContain('because I will not write the fix for you (rule 3)');
  });

  it('says a reply came out of the cache', () => {
    const html = draw({ provider: 'openai', cached: true });
    expect(html).toContain('data-testid="badge-cached"');
    expect(html).toContain('Answered before');
  });

  it('still says a budget refusal is one after a reload, with no flag on the row', () => {
    const html = draw({ provider: 'guardrail' });
    expect(html).toContain('data-testid="badge-budget"');
    expect(html).toContain('Earlier token limit');
  });

  it('says a redirect is one and names the room', () => {
    const html = draw({ provider: 'guardrail', scopeRedirected: true });
    expect(html).toContain('data-testid="badge-redirected"');
    expect(html).toContain('Redirected');
    expect(html).toContain('This room is Implementation');
  });

  it('draws no ordinal rather than question zero', () => {
    const html = renderToStaticMarkup(
      <MetaBadges meta={{ provider: 'local-mentor' }} phaseKey="testing" phaseTitle="Testing" />,
    );
    expect(html).not.toContain('data-testid="reply-ordinal"');
    expect(html).toContain('data-testid="reply-label"');
  });
});
