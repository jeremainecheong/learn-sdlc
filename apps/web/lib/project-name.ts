/**
 * A project's name as the product writes it: the part of its title before the
 * dash ("TaskTrackr — a task manager you can run" is "TaskTrackr"), or `''`.
 */
export function projectName(title: string | null | undefined): string {
  return (title ?? '').split('—')[0].trim();
}
