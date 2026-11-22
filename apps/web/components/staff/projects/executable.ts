/**
 * Where the editor finds a phase's executable task.
 *
 * A module of its own, with no import of the client, so that every page and
 * test that mocks `@/lib/api-projects` still reads a draft without one.
 */
import type { DraftTaskView, ExecutableTaskView } from '@learnsdlc/shared';

/**
 * A row's executable view (`DraftTaskView.executable`, as the contract names
 * it) or null. Never throws on a row without one (a task that runs nothing,
 * such as a quiz or a story): the editor then draws nothing executable.
 */
export function executableOf(task: DraftTaskView | null | undefined): ExecutableTaskView | null {
  const view = task?.executable;
  return view && typeof view === 'object' && Array.isArray(view.runs) ? view : null;
}
