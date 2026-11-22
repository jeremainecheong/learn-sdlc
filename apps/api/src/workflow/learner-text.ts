import { plainTextOf, withoutHtmlComments, type FeedbackReport, type PhaseRubric, type QuizQuestionResult } from '@learnsdlc/shared';
import type { PhaseChecks } from '../content/content.types';

/**
 * What a learner reads of a teacher's text: plain, its HTML comments not shown; the stored bytes
 * untouched. One `plainTextOf` pass: a text already plain comes back as it is, so no `isPlainText` pre-check (which is
 * itself a full pass) is asked first.
 */
export function learnerText(text: string): string {
  return withoutHtmlComments(plainTextOf(text));
}

/** A rubric as a learner reads it: each criterion's title and description through `learnerText`, a copy. */
export function learnerRubric(rubric: PhaseRubric): PhaseRubric {
  return { ...rubric, criteria: rubric.criteria.map((one) => ({ ...one, title: learnerText(one.title), description: learnerText(one.description) })) };
}

/**
 * A quiz result's questions as a learner reads them: each stem, each option's text, and the
 * explanation and concept label where they are released, through `learnerText`; a sealed (null) one stays null. A
 * copy. Marking stores the pinned version's texts as they are, so a report reads the same whenever it was stored,
 * converted once, here, by whichever view serves the report.
 */
export function learnerQuizQuestions(questions: readonly QuizQuestionResult[]): QuizQuestionResult[] {
  return questions.map((question) => ({
    ...question,
    stem: learnerText(question.stem),
    options: question.options.map((option) => ({ ...option, text: learnerText(option.text) })),
    explanation: typeof question.explanation === 'string' ? learnerText(question.explanation) : question.explanation,
    concept: typeof question.concept === 'string' ? learnerText(question.concept) : question.concept,
  }));
}

/** A stored report as a reader is served it: its quiz section's questions through `learnerQuizQuestions`, a copy; a report with no quiz section comes back as it is. */
export function learnerReport<R extends FeedbackReport | null | undefined>(report: R): R {
  if (!report?.quiz?.questions?.length) return report;
  return { ...report, quiz: { ...report.quiz, questions: learnerQuizQuestions(report.quiz.questions) } };
}

/**
 * The checks a learner's story, design and ticket lines are read from: a story phase's provided stories (title,
 * the sentence's three parts, each criterion's clauses) and the learner story's hints, a design phase's stories (title
 * and line), and a Maintenance ticket's title, summary and acceptance lines, each through `learnerText`. The checks are
 * copied, never written; any other kind comes back as it is. A view converts once and hands the one result to every
 * phase-detail builder that reads it.
 */
export function learnerChecksText(checks: PhaseChecks): PhaseChecks {
  if (checks.kind === 'story') {
    const hints = Object.fromEntries(Object.entries(checks.learnerStory.hints).map(([key, hint]) => [key, typeof hint === 'string' ? learnerText(hint) : hint]));
    return {
      ...checks,
      learnerStory: { ...checks.learnerStory, hints },
      providedStories: checks.providedStories.map((story) => ({
        ...story,
        title: learnerText(story.title),
        persona: learnerText(story.persona),
        capability: learnerText(story.capability),
        benefit: learnerText(story.benefit),
        ...(story.criteria
          ? { criteria: story.criteria.map((one) => ({ ...one, given: learnerText(one.given), when: learnerText(one.when), then: learnerText(one.then) })) }
          : {}),
      })),
    };
  }
  if (checks.kind === 'design') {
    return { ...checks, stories: checks.stories.map((story) => ({ ...story, title: learnerText(story.title), line: learnerText(story.line) })) };
  }
  if (checks.kind === 'code' && checks.ticket) {
    const ticket = checks.ticket;
    return {
      ...checks,
      ticket: {
        ...ticket,
        title: learnerText(ticket.title),
        summary: learnerText(ticket.summary),
        acceptance: ticket.acceptance.map((one) => ({ ...one, line: learnerText(one.line) })),
      },
    };
  }
  return checks;
}
