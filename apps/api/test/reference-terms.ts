/**
 * Words that only TaskTrackr's own content can make true, for the reviewer
 * scoping checks.
 *
 * Each one names a TaskTrackr fact: its project name, its four stories, its
 * stakeholder, its record files, its design contract's operations and errors,
 * its implementation's field and query names, its maintenance change request
 * and its deployment bundle. A request about a teacher's own task that carries
 * one of them was built from TaskTrackr's rules rather than from the task.
 *
 * **A hit counts only when the task did not say it itself**. A
 * teacher's own brief may legitimately say "overdue" or name a file, and the
 * reviewer quoting the teacher back is not a leak. `referenceTermsIn` takes
 * the text the task itself supplied (its brief, its rules, the submitted work)
 * and ignores any term found there. The fixtures in this suite use a
 * room-booking domain, which shares no word with the list, so for them the
 * allowance is empty and every hit is a leak.
 */
export const REFERENCE_TERMS: readonly string[] = [
  'TaskTrackr',
  'US-1',
  'US-2',
  'US-3',
  'US-4',
  'Dana',
  'Osei',
  'story.json',
  'my-story',
  'provided-stories',
  'completeTask',
  'task_not_found',
  'listTasks',
  'getOverdue',
  'overdue',
  'due_date',
  'due-today',
  'TASK_SELECT',
  'LIST_SELECT',
  'comment_count',
  'CR-2',
  'api/schema.sql',
  'web/dist',
  'Flask',
  'list_id',
];

/**
 * The reference terms in `text` that `allowed` (the task's own words) does not
 * already contain. `ownPaths` are the task's own files: a teacher's minted
 * `requirements/my-story-<key>.md` is the task's submission, not TaskTrackr's
 * story, and are cut out of `text` exactly before it is read, so the term
 * they happen to contain still counts everywhere else.
 */
export function referenceTermsIn(text: string, allowed = '', ownPaths: readonly string[] = []): string[] {
  const haystack = ownPaths.filter(Boolean).reduce((rest, path) => rest.split(path).join(' '), text).toLowerCase();
  const own = allowed.toLowerCase();
  return REFERENCE_TERMS.filter((term) => {
    const needle = term.toLowerCase();
    return haystack.includes(needle) && !own.includes(needle);
  });
}
