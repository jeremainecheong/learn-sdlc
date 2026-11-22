/**
 * A second project in the catalogue, for the suites that prove the API is
 * keyed on (userId, projectSlug).
 *
 * The repository ships one pack and no chooser, but the data model is still
 * per project: an enrolment, a phase state, a CSV row and an overview row are
 * all per project, and analytics answering with whichever enrolment the
 * database yields first is one query away. So those suites get a fixture: the
 * shipped pack under another slug, added to one ContentService instance, which
 * is all they need from it.
 *
 * `getPhase` and the rest go through `getProject`, so two
 * methods are the whole catalogue. They are assigned rather than spied on:
 * `jest.restoreAllMocks()` in a `beforeEach` would take a spy away again, and
 * this fixture belongs to the instance for as long as the instance lives.
 */
import { ContentService } from '../src/content/content.service';
import type { ProjectContent } from '../src/content/content.types';

/** A slug that is not the shipped pack. Deliberately not a pack anyone ships. */
export const SECOND_PROJECT = 'other-pack';

/** `content` with a second project beside the shipped one. Returns the fixture. */
export function addSecondProject(
  content: ContentService,
  slug: string = SECOND_PROJECT,
): ProjectContent {
  const shipped = content.listProjects()[0];
  const second: ProjectContent = { ...shipped, slug, title: `${shipped.title} (a second pack)` };
  const projects = [...content.listProjects(), second];
  const getProject = content.getProject.bind(content);
  content.listProjects = () => projects;
  content.getProject = (asked: string) => (asked === slug ? second : getProject(asked));
  return second;
}
