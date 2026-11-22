/**
 * What a phase's Pass leads to, in the words every learner surface shares.
 *
 * On a phase with one after it, a Pass (once every required task has passed)
 * opens the next phase. On the project's last phase (`isLastPhase` over the
 * enrolment's own phase list, so a subset project's last phase counts) no
 * phase follows: the learner's "Complete the project" runs `advance()`, which
 * marks the enrolment complete (workflow.service.ts). The words for a phase
 * with one after it are the ones every surface said before; only the last
 * phase reads differently.
 */

/** The clause before "once …": what the remaining work opens. */
export function onwardOpens(isLast: boolean): string {
  return isLast ? 'The project can be completed' : 'The next phase opens';
}

/**
 * The phase brief's closing line. On the last phase it is the phase passing,
 * not its work passing review, that lets the learner complete the project: a
 * task that needs the teacher's sign-off passes on the countersignature, and a
 * split phase passes once every required task has passed.
 */
export function briefClosingLine(isLast: boolean): string {
  return isLast
    ? "This is your project's last phase: once it passes, you can complete the project."
    : 'Your saved work and real review evidence carry forward to the next phase.';
}

/** The IDE room's grading note, under "How this phase (or task) is graded". */
export function gradingPassLine(passIsTheTasks: boolean, isLast: boolean): string {
  if (passIsTheTasks) {
    return isLast
      ? 'A Pass records this task. The project can be completed once every required task has passed.'
      : 'A Pass records this task. The phase opens the next one when every required task has passed.';
  }
  return isLast
    ? 'A Pass lets you complete the project. You may save an optional reflection before completing it.'
    : 'A Pass opens the next phase. You may save an optional reflection before continuing.';
}
