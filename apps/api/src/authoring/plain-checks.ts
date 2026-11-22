import type { PlainTextMember } from '@learnsdlc/shared';
import type { ProjectTaskEntity } from '../content/project.entities';

/**
 * A task's checks with the teacher's lines in them stored plain: a quiz's
 * questions (concept labels too), a ticket's lines, a story's provided
 * stories and hints, a Design's stories. `plain(member)` converts one text of
 * that member (`quiz text`, `ticket lines`, `story lines`); the caller says
 * how, and what it records. The draft conversion (`AuthoringService`'s first
 * save and boot pass) and the upload door's plain-text pass (`plainSource`)
 * walk a task's checks through this one walker. A copy; any other kind comes
 * back as it is.
 */
export function plainChecks(
  checks: ProjectTaskEntity['checks'],
  plain: (member: PlainTextMember) => <T>(text: T) => T,
): ProjectTaskEntity['checks'] {
  if (!checks || typeof checks !== 'object') return checks;
  if (checks.kind === 'quiz') {
    const quizText = plain('quiz text');
    const questions = Array.isArray(checks.questions)
      ? checks.questions.map((question) => ({
          ...question,
          stem: quizText(question.stem),
          options: Array.isArray(question.options) ? question.options.map((option) => ({ ...option, text: quizText(option.text) })) : question.options,
          explanation: quizText(question.explanation),
          ...(typeof question.concept === 'string' ? { concept: quizText(question.concept) } : {}),
        }))
      : checks.questions;
    return { ...checks, questions };
  }
  if (checks.kind === 'design') {
    const line = plain('story lines');
    const stories = Array.isArray(checks.stories)
      ? checks.stories.map((story) => ({ ...story, title: line(story.title), line: line(story.line) }))
      : checks.stories;
    return { ...checks, stories };
  }
  if (checks.kind === 'code' && checks.ticket) {
    const line = plain('ticket lines');
    const ticket = checks.ticket;
    return {
      ...checks,
      ticket: {
        ...ticket,
        title: line(ticket.title),
        summary: line(ticket.summary),
        acceptance: Array.isArray(ticket.acceptance) ? ticket.acceptance.map((one) => ({ ...one, line: line(one.line) })) : ticket.acceptance,
      },
    };
  }
  if (checks.kind === 'story') {
    const line = plain('story lines');
    const providedStories = Array.isArray(checks.providedStories)
      ? checks.providedStories.map((story) => ({
          ...story,
          title: line(story.title),
          persona: line(story.persona),
          capability: line(story.capability),
          benefit: line(story.benefit),
          ...(Array.isArray(story.criteria)
            ? { criteria: story.criteria.map((one) => ({ ...one, given: line(one.given), when: line(one.when), then: line(one.then) })) }
            : {}),
        }))
      : checks.providedStories;
    const hints = checks.learnerStory?.hints && typeof checks.learnerStory.hints === 'object'
      ? Object.fromEntries(Object.entries(checks.learnerStory.hints).map(([key, hint]) => [key, line(hint)]))
      : checks.learnerStory?.hints;
    return { ...checks, providedStories, ...(checks.learnerStory ? { learnerStory: { ...checks.learnerStory, hints } } : {}) };
  }
  return checks;
}
