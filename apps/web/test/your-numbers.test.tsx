import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearnerAnalytics, PhaseAnalytics } from '@learnsdlc/shared';
import { YourNumbers } from '@/components/home/YourNumbers';

/**
 * The panel of counts on the learner's own page, and the two numbers quizzes
 * add to it.
 *
 * The sponsor asked for *"an overview of the checklist as one intuitive
 * percentage"*. Two fields answer it (`checklistPercent`, how much of the
 * checklist is done, and `masteryPercent`, how well the concepts are
 * understood) and both arrive **optional** on `LearnerAnalytics`, with
 * mastery nullable on top of that. So there are three absences to tell apart
 * and only two of them are the same fact:
 *
 * - the field is missing, because the payload comes from an older API;
 * - the field is `null`, because the project declares no quiz or the learner
 *   has not taken one;
 * - the field is `0`, because they took one and answered nothing right.
 *
 * The first two are blanks and draw a dash. The third is a score and draws
 * `0%`. That is the gradebook's own stated rule (a blank and a zero are
 * different facts) and it is the assertion this file exists for, because a
 * `??  0` anywhere in the tile would make a learner who has never seen a quiz
 * read *0% mastery* and a `||` would do it to the learner who scored zero.
 *
 * The other standing rule here is a word one: `masteryPercent` is a reading of
 * **concepts**, never a grade. A required quiz already moves the phase's score
 * once through the roll-up; this tile is a second reading of the same rows for
 * a different question, and the moment its copy says *grade* it has become the
 * first reading twice.
 *
 * The four other tiles are asserted here too: they are what the two quiz
 * tiles must not disturb.
 */

const phase = (key: PhaseAnalytics['key'], status: PhaseAnalytics['status'], bestScore: number | null): PhaseAnalytics => ({
  key,
  order: 1,
  title: key,
  status,
  bestScore,
  attempts: 1,
  hints: 0,
  relianceIndex: 0,
});

const analytics = (over: Partial<LearnerAnalytics> = {}): LearnerAnalytics => ({
  projectSlug: 'tasktrackr',
  progressPercent: 33,
  phasesPassed: 2,
  totalPhases: 6,
  averageScore: 74,
  totalHints: 5,
  tokensToday: 1200,
  difficultyTier: 'standard',
  relianceIndex: 12,
  phases: [],
  ...over,
});

/**
 * One tile's markup, sliced out by its handle.
 *
 * `StatTile` writes `data-testid` last on its frame, so everything from that
 * attribute to the next `data-testid` is this tile and nothing else. Scoping
 * matters here: `'—'` and `'0%'` are short enough to appear in a sibling by
 * accident, and an assertion over the whole panel would pass for the wrong
 * reason.
 */
const tile = (html: string, testId: string): string => {
  const after = html.split(`data-testid="${testId}"`)[1];
  expect(after, `no tile handled ${testId}`).toBeTypeOf('string');
  return after.split('data-testid=')[0];
};

describe('the learner numbers panel', () => {
  it('draws the checklist and the quiz mastery beside the four counts it already had', () => {
    // The best average is taken over the passed phases, so the fixture
    // carries the one passed phase its 74 is.
    const html = renderToStaticMarkup(
      <YourNumbers
        analytics={analytics({ checklistPercent: 62, masteryPercent: 84, phases: [phase('requirements', 'passed', 74)] })}
      />,
    );

    expect(tile(html, 'tile-checklist')).toContain('62%');
    expect(tile(html, 'tile-mastery')).toContain('84%');

    // The four other tiles, with their values.
    expect(tile(html, 'tile-progress')).toContain('2/6');
    expect(tile(html, 'tile-score')).toContain('74');
    expect(tile(html, 'tile-hints')).toContain('5');
    expect(tile(html, 'tile-tokens')).toContain('1,200');
  });

  it('draws a dash and not a zero when the project has no quiz', () => {
    const html = renderToStaticMarkup(
      <YourNumbers analytics={analytics({ checklistPercent: 45, masteryPercent: null })} />,
    );

    const mastery = tile(html, 'tile-mastery');
    expect(mastery).toContain('—');
    expect(mastery).not.toContain('0%');
    // The checklist is a separate fact and is unaffected by the blank beside it.
    expect(tile(html, 'tile-checklist')).toContain('45%');
  });

  it('draws a zero when the learner took a quiz and answered nothing right', () => {
    const html = renderToStaticMarkup(
      <YourNumbers analytics={analytics({ checklistPercent: 0, masteryPercent: 0 })} />,
    );

    // The inverse of the test above, and the reason it cannot be written with
    // a falsy test: 0 is a score the learner earned and has to be shown.
    expect(tile(html, 'tile-mastery')).toContain('0%');
    expect(tile(html, 'tile-mastery')).not.toContain('—');
    expect(tile(html, 'tile-checklist')).toContain('0%');
  });

  it('draws a dash on a payload written before the two fields existed', () => {
    // Both fields are optional on the contract, so this is the shape an API
    // without quiz analytics returns.
    const html = renderToStaticMarkup(<YourNumbers analytics={analytics()} />);

    expect(tile(html, 'tile-checklist')).toContain('—');
    expect(tile(html, 'tile-mastery')).toContain('—');
    expect(tile(html, 'tile-checklist')).not.toContain('0%');
    expect(tile(html, 'tile-mastery')).not.toContain('0%');
  });

  it('says concepts and never says grade', () => {
    const html = renderToStaticMarkup(
      <YourNumbers analytics={analytics({ checklistPercent: 62, masteryPercent: 84 })} />,
    );

    expect(tile(html, 'tile-mastery')).toMatch(/concepts/i);
    // A mastery percentage read as a grade would be the phase score counted
    // twice, which is exactly what this number is not.
    expect(html).not.toMatch(/grade/i);
  });
});

/**
 * The "Best average" tile must not read `averageScore`, the mean of every
 * phase's best score: a failing strict verdict raises a phase's best score,
 * so the dashboard could draw "Best average 100" beside "Gates passed 0/6".
 * The tile averages the phases whose gate is passed, and draws a dash until
 * one is.
 */
describe('the best average, over passed phases only', () => {
  it('draws a dash, not 100, when a high score has passed no gate', () => {
    const html = renderToStaticMarkup(
      <YourNumbers
        analytics={analytics({
          phasesPassed: 0,
          progressPercent: 0,
          averageScore: 100,
          phases: [phase('requirements', 'submitted', 100), phase('design', 'in_progress', null)],
        })}
      />,
    );

    const score = tile(html, 'tile-score');
    expect(score).not.toContain('100');
    expect(score).toContain('—');
    expect(score).toMatch(/passed phases/i);
  });

  it('averages the passed phases and leaves the unpassed high score out', () => {
    const html = renderToStaticMarkup(
      <YourNumbers
        analytics={analytics({
          averageScore: 83,
          phases: [
            phase('requirements', 'passed', 80),
            phase('design', 'passed', 71),
            phase('implementation', 'submitted', 100),
          ],
        })}
      />,
    );

    // (80 + 71) / 2 = 75.5, rounded the way the API rounds.
    expect(tile(html, 'tile-score')).toContain('76');
    expect(tile(html, 'tile-score')).not.toContain('83');
  });

  it('draws a dash when the payload has no phases to average', () => {
    const html = renderToStaticMarkup(
      <YourNumbers analytics={analytics({ phases: null as unknown as PhaseAnalytics[] })} />,
    );

    expect(tile(html, 'tile-score')).toContain('—');
  });
});
