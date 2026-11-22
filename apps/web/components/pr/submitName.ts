/**
 * The name of the control that hands a code phase's work in:
 * "Submit PR-<n>" before the pull request has a revision, "Submit PR-<n>
 * again" once it has one. The same words wherever the control is drawn: the
 * workspace header, the pull request page, the planted bugs page.
 */
export function prSubmitLabel(place: number, submitted: boolean): string {
  return `Submit PR-${place}${submitted ? ' again' : ''}`;
}

/**
 * Whether handing the work in is the page's next step, so its control is the
 * primary one. The workspace's rule (`submitLeads` in the workspace page):
 * while the work is in progress, after a review that asked for more, and on a
 * phase passed on the board by the teacher's credit that still wants a
 * reviewed Pass. Once the review passed (Continue is then the way on), while
 * the countersignature is awaited, and after the merge, there is nothing to
 * hand in and the control is never the primary one.
 */
export function prSubmitLeads({ merged, reviewPassed, credited }: { merged: boolean; reviewPassed: boolean; credited: boolean }): boolean {
  if (merged) return false;
  return credited || !reviewPassed;
}
