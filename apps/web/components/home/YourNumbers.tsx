'use client';

import type { LearnerAnalytics } from '@learnsdlc/shared';
import { Section } from '@/components/ui';
import { StatTile } from '@/components/charts/StatTile';

/**
 * A percentage the API has already rounded, or a dash when it sent none.
 *
 * Two absences reach here and a learner should not have to tell them apart:
 * the field is missing, because the payload predates it, or it is `null`,
 * because the project declares no quiz and none was taken. Both are blanks.
 * `0` is neither: it is a score somebody earned, so this is a test for the
 * two absences and never a falsy test.
 */
function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}%`;
}

/**
 * The mean best score of the phases whose gate is
 * passed, rounded the way the API rounds, or null until one is.
 *
 * `averageScore` is the mean of every phase's best score, and a failing strict
 * verdict raises a phase's best score, so it could read 100 beside "Gates
 * passed 0/6", a number that says the learner is done beside one that says
 * they have not begun. Only a passed phase's score is a result.
 */
function passedAverage(phases: LearnerAnalytics['phases'] | null | undefined): number | null {
  const scores = (Array.isArray(phases) ? phases : [])
    .filter((phase) => phase.status === 'passed' && typeof phase.bestScore === 'number')
    .map((phase) => phase.bestScore as number);
  return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
}

/**
 * The counts that describe the whole project rather than the phase in hand.
 * They sit with the charts, below the fold, because none of them is what a
 * learner opens the page to find out.
 *
 * Six tiles, in three pairs: where the gates stand and how much of the
 * checklist is done, what the work scored and how well the concepts are
 * understood, and the two AI counters. Each row is one question asked twice.
 *
 * **The checklist and the mastery are different readings, not two grades.**
 * `checklistPercent` counts required tasks passed over required tasks
 * declared, over the pinned version and weighted by task. `masteryPercent` is
 * the mean best score over quiz tasks that have one. A required quiz already
 * moves the phase's score once through the roll-up, so the mastery tile is a
 * second reading of the same rows for a different question, which is why its
 * words are *concepts* and never *grade*.
 *
 * Both numbers arrive rounded from `@learnsdlc/shared`'s percentages module,
 * which is the one definition the learner page and the class table share. This
 * panel formats and never computes.
 */
export function YourNumbers({ analytics }: { analytics: LearnerAnalytics }) {
  const best = passedAverage(analytics.phases);
  return (
    <Section
      title="Your numbers"
      purpose="Across every phase of this project."
      icon="gauge"
      testId="home-numbers"
    >
      {/* Two by two, not four across: the panel is a third of the row, and
          four tiles in it break every label onto a second line. Quizzes make
          it three rows of two, which is the same rhythm and the same width. */}
      <div className="grid grid-cols-2 gap-2">
        <StatTile
          variant="flat"
          label="Gates passed"
          value={`${analytics.phasesPassed}/${analytics.totalPhases}`}
          hint={`${analytics.progressPercent}% of the ${analytics.totalPhases} gates`}
          tone={analytics.phasesPassed > 0 ? 'good' : 'muted'}
          testId="tile-progress"
        />
        <StatTile
          variant="flat"
          label="Checklist"
          value={percent(analytics.checklistPercent)}
          hint="Required tasks passed, across every phase"
          tone="muted"
          testId="tile-checklist"
        />
        <StatTile
          variant="flat"
          label="Best average"
          value={best === null ? '—' : String(best)}
          hint="Across passed phases"
          tone="muted"
          testId="tile-score"
        />
        <StatTile
          variant="flat"
          label="Quiz mastery"
          value={percent(analytics.masteryPercent)}
          hint={
            analytics.masteryPercent === null || analytics.masteryPercent === undefined
              ? 'Nothing to show until you take a quiz'
              : 'Concepts answered right, across your quizzes'
          }
          tone="muted"
          testId="tile-mastery"
        />
        <StatTile
          variant="flat"
          label="Mentor hints asked"
          value={String(analytics.totalHints)}
          hint="All phases"
          tone="muted"
          testId="tile-hints"
        />
        <StatTile
          variant="flat"
          label="AI tokens used today"
          value={analytics.tokensToday.toLocaleString()}
          hint="Recorded provider usage"
          tone="muted"
          testId="tile-tokens"
        />
      </div>
    </Section>
  );
}
